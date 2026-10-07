// IVT detector — scores (request, impression) events for invalid-traffic
// signals. Pure and offline: it takes events in and returns a report. It never
// opens a socket, and it is the component under test in PLAN.md's table.
//
// Two levels of signal, because that is where fraud actually shows up:
//   - per-event conditions (is this IP a datacenter IP? does the impression IP
//     match the request IP? is this seller authorized?), and
//   - per-seller aggregates of those conditions over a window (what SHARE of a
//     seller's events are datacenter / mismatched / night-concentrated?).
// A single request is rarely "fraud"; a seller whose events are 90% datacenter
// is. So the *_seller signals below are aggregates, matching your rule names.
//
// IP classification (datacenter vs residential) and IP->geo need real data in
// production — an ASN / IP-reputation feed and a geo DB. Both are injected via
// `ctx` so this file stays pure and testable; the defaults are CIDR lists you
// pass in. Nothing here hardcodes a real network's reputation.

// ---- thresholds (override via ctx.thresholds) -----------------------------
export const DEFAULT_THRESHOLDS = {
  datacenterShare: 0.5, // >= this share of a seller's events on datacenter IPs -> datacenter_seller (block)
  mismatchShare: 0.3, // >= this share with impression IP /24 != request IP /24 -> mismatch_seller (block)
  nightShare: 0.6, // >= this share in the local-night window -> schedule_seller (flag)
  minVolume: 50, // don't judge a seller on aggregates below this many events
  nightWindow: [0, 7], // [startHour, endHour) local time counted as "night"
  nightTz: 'America/New_York',
  ipConcentration: 25, // >= this many impressions on one /24 is suspicious
};

// ---- CIDR / IP helpers ----------------------------------------------------
const ipToInt = (ip) => {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const b = Number(o);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n * 256) + b;
  }
  return n >>> 0;
};

/** Parse "a.b.c.d/n" once into a {base, mask} matcher. */
const parseCidr = (cidr) => {
  const [addr, bitsRaw] = String(cidr).split('/');
  const base = ipToInt(addr);
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
};

const inCidrList = (ip, cidrs = []) => {
  const n = ipToInt(ip);
  if (n == null) return false;
  for (const c of cidrs) {
    const m = typeof c === 'string' ? parseCidr(c) : c;
    if (m && ((n & m.mask) >>> 0) === m.base) return true;
  }
  return false;
};

/** The /24 network as a string, e.g. "203.0.113.0". The binding unit for in-app. */
export const slash24 = (ip) => {
  const p = String(ip).split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0` : null;
};

/**
 * datacenter | residential | unknown. Default classifier matches the request IP
 * against CIDR lists you supply in ctx; in production swap in an ASN/reputation
 * lookup via ctx.classifyIp(ip). "unknown" is treated conservatively (not
 * datacenter) so an incomplete feed never manufactures a block.
 */
const classifyIp = (ip, ctx) => {
  if (typeof ctx.classifyIp === 'function') return ctx.classifyIp(ip) ?? 'unknown';
  if (inCidrList(ip, ctx.datacenterRanges)) return 'datacenter';
  if (inCidrList(ip, ctx.residentialRanges)) return 'residential';
  return 'unknown';
};

/** Local hour (0-23) in the given tz, deterministically, with no deps. */
const localHour = (ts, tz) => {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ts));
  const n = Number(h);
  return n === 24 ? 0 : n; // some ICU builds render midnight as 24
};

// ---- per-event conditions -------------------------------------------------
// Each returns a boolean (or null = "couldn't evaluate, don't count it").

/** datacenter_ip: the request IP is a hosting/datacenter IP, not a real line. */
const isDatacenterIp = (ev, ctx) => classifyIp(ev.request?.device?.ip, ctx) === 'datacenter';

/**
 * ip_mismatch: for in-app, the impression must come from the same /24 as the
 * request. (Web banners also bind the UA; in-app binds IP only — PLAN.md.)
 * Only evaluable on a won event that actually produced an impression IP.
 */
const isIpMismatch = (ev) => {
  if (!ev.won || !ev.impressionIp) return null;
  const reqNet = slash24(ev.request?.device?.ip);
  const impNet = slash24(ev.impressionIp);
  if (!reqNet || !impNet) return null;
  return reqNet !== impNet;
};

/**
 * unauthorized_seller: the declared seller isn't authorized on this account.
 * Checks app.publisher.id and every schain node's asi against the account's
 * allow-lists (ctx.authorized = { publishers:Set, asi:Set }).
 */
const isUnauthorizedSeller = (ev, ctx) => {
  const auth = ctx.authorized;
  if (!auth) return null; // not configured -> can't judge
  const pub = ev.request?.app?.publisher?.id;
  if (pub != null && auth.publishers && !auth.publishers.has(String(pub))) return true;
  const nodes = ev.request?.source?.ext?.schain?.nodes ?? [];
  for (const node of nodes) {
    if (node?.asi && auth.asi && !auth.asi.has(String(node.asi))) return true;
  }
  return false;
};

/** device_inconsistent: UA and declared device.os disagree (cheap sanity). */
const isDeviceInconsistent = (ev) => {
  const d = ev.request?.device;
  if (!d?.ua || !d?.os) return null;
  const ua = d.ua.toLowerCase();
  const os = String(d.os).toLowerCase();
  if (os === 'android' && !ua.includes('android')) return true;
  if (os === 'ios' && !/iphone|ipad|ios/.test(ua)) return true;
  return false;
};

const sellerId = (ev) => String(ev.request?.app?.publisher?.id ?? 'unknown');

// ---- per-seller aggregation ----------------------------------------------
const share = (count, total) => (total > 0 ? count / total : 0);

/**
 * Roll a seller's events into signals. Per-event conditions become *_seller
 * signals when their SHARE crosses a threshold — one datacenter request is
 * noise; a seller that is mostly datacenter is a block.
 */
function scoreSeller(seller, events, ctx) {
  const t = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const n = events.length;

  let dc = 0;
  let mismatch = 0;
  let mismatchEval = 0;
  let unauth = 0;
  let deviceBad = 0;
  let night = 0;
  const bundles = new Map();
  const ifas = new Set();
  const nets = new Map(); // /24 -> impression count

  for (const ev of events) {
    if (isDatacenterIp(ev, ctx)) dc += 1;

    const mm = isIpMismatch(ev);
    if (mm !== null) {
      mismatchEval += 1;
      if (mm) mismatch += 1;
    }

    if (isUnauthorizedSeller(ev, ctx) === true) unauth += 1;
    if (isDeviceInconsistent(ev) === true) deviceBad += 1;

    const hour = localHour(ev.ts ?? Date.now(), t.nightTz);
    if (hour >= t.nightWindow[0] && hour < t.nightWindow[1]) night += 1;

    const b = ev.request?.app?.bundle ?? '?';
    bundles.set(b, (bundles.get(b) ?? 0) + 1);
    const ifa = ev.request?.device?.ifa;
    if (ifa) ifas.add(ifa);
    if (ev.won && ev.impressionIp) {
      const net = slash24(ev.impressionIp);
      if (net) nets.set(net, (nets.get(net) ?? 0) + 1);
    }
  }

  const topBundle = [...bundles.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['?', 0];
  const maxPerNet = Math.max(0, ...nets.values());
  const signals = [];
  const add = (code, level, detail) => signals.push({ code, level, detail });

  // IP + schain checks — where the residential-IP pattern is decided.
  if (share(dc, n) >= t.datacenterShare) {
    add('datacenter_seller', 'block', `${dc}/${n} events on datacenter IPs`);
  }
  if (mismatchEval > 0 && share(mismatch, mismatchEval) >= t.mismatchShare) {
    add('mismatch_seller', 'block', `${mismatch}/${mismatchEval} impressions off the request /24`);
  }
  if (unauth > 0) {
    add('unauthorized_seller', 'flag', `${unauth}/${n} events from an unauthorized seller/asi`);
  }

  // Judge the rest only with enough volume to be meaningful.
  if (n >= t.minVolume) {
    if (share(night, n) >= t.nightShare) {
      add('schedule_seller', 'flag', `${night}/${n} events in ${t.nightTz} ${t.nightWindow[0]}:00-${t.nightWindow[1]}:00`);
    }
    if (deviceBad > 0) {
      add('device_inconsistent', 'flag', `${deviceBad}/${n} events: UA vs device.os mismatch`);
    }
    if (maxPerNet >= t.ipConcentration) {
      add('ip_concentration', 'flag', `${maxPerNet} impressions on a single /24`);
    }
  }

  return {
    seller,
    volume: n,
    signals,
    stats: {
      datacenterShare: Number(share(dc, n).toFixed(3)),
      mismatchShare: Number(share(mismatch, mismatchEval).toFixed(3)),
      nightShare: Number(share(night, n).toFixed(3)),
      topBundle: { bundle: topBundle[0], share: Number(share(topBundle[1], n).toFixed(3)) },
      distinctIfa: ifas.size,
      distinctNets: nets.size,
      maxImpressionsPerNet: maxPerNet,
    },
    verdict: signals.some((s) => s.level === 'block') ? 'block' : signals.length ? 'flag' : 'clean',
  };
}

/**
 * Analyze a batch of events, grouped by seller (app.publisher.id).
 * @param {Array} events  normalized events: { ts, won, impressionIp, request }
 * @param {object} ctx    { authorized?, datacenterRanges?, residentialRanges?,
 *                           classifyIp?, thresholds? }
 * @returns {{ bySeller: object[], summary: object }}
 */
export function analyze(events, ctx = {}) {
  const groups = new Map();
  for (const ev of events) {
    const s = sellerId(ev);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(ev);
  }
  const bySeller = [...groups.entries()]
    .map(([s, evs]) => scoreSeller(s, evs, ctx))
    .sort((a, b) => b.volume - a.volume);

  return {
    bySeller,
    summary: {
      sellers: bySeller.length,
      events: events.length,
      blocked: bySeller.filter((s) => s.verdict === 'block').map((s) => s.seller),
      flagged: bySeller.filter((s) => s.verdict === 'flag').map((s) => s.seller),
    },
  };
}
