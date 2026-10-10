// IVT detector — scores (request, impression) events for invalid-traffic
// signals. Pure and offline: it takes events in and returns a report. It never
// opens a socket, and it is the component under test in PLAN.md's table.
//
// Two levels of signal, because that is where fraud actually shows up:
//   - per-event conditions (is this IP a datacenter IP? does the impression IP
//     match the request IP? is this seller authorized?), and
//   - per-GROUP aggregates of those conditions over a window (what SHARE of a
//     group's events are datacenter / mismatched / night-concentrated?).
// A single request is rarely "fraud"; a group whose events are 90% datacenter
// is. So the *_seller signals below are aggregates.
//
// A "group" is any dimension, not just the seller. Keying only on
// app.publisher.id lets a fraudster evade detection by rotating publisher ids;
// aggregating the SAME events by bundle, by schain asi, or by /24 catches the
// pattern the rotation was hiding. analyze(..., { dimension }) picks the key,
// and analyzeWindows() runs it over rolling time windows instead of one batch.
//
// IP classification (datacenter vs residential) and IP->geo need real data in
// production — an ASN / IP-reputation feed and a geo DB. Both are injected via
// `ctx` so this file stays pure and testable.

import { inCidrList, networkKey, isBogon } from './ip.mjs';
import { auditHeaders } from './android-headers.mjs';

// ---- thresholds (override via ctx.thresholds) -----------------------------
export const DEFAULT_THRESHOLDS = {
  datacenterShare: 0.5, // >= this share of a group's events on datacenter IPs -> datacenter_seller (block)
  bogonShare: 0.1, // >= this share on reserved / non-routable IPs -> bogon_seller (block)
  mismatchShare: 0.3, // >= this share with impression net != request net -> mismatch_seller (block)
  nightShare: 0.6, // >= this share in the local-night window -> schedule_seller (flag)
  minVolume: 50, // don't judge a group on aggregates below this many events
  nightWindow: [0, 7], // [startHour, endHour) local time counted as "night"
  nightTz: 'America/New_York',
  ipConcentration: 25, // >= this many impressions on one network is suspicious
  invalidIfaShare: 0.3, // >= this share of zeroed/malformed/missing device IDs -> invalid_ifa_seller (flag)
  ifaLmtShare: 0.2, // >= this share of zeroed IFAs sent with lmt != 1 -> ifa_lmt_mismatch (flag)
  ifaMaxNets: 5, // one *valid* device ID seen on >= this many distinct networks is implausible (device farm)
  schainShare: 0.3, // >= this share with schain terminal sid != publisher.id / incomplete -> schain_inconsistent (flag)
  bundleShare: 0.3, // >= this share where storeurl doesn't match app.bundle -> bundle_incoherent (flag)
  deviceShare: 0.3, // >= this share with internally contradictory device values -> device_inconsistent (flag)
  httpShare: 0.3, // >= this share of impressions whose HTTP client fingerprint contradicts itself -> http_incoherent (flag)
};

// ---- IP classification ----------------------------------------------------
/**
 * datacenter | residential | bogon | unknown. Default classifier matches the
 * request IP against CIDR lists you supply in ctx (v4 or v6), then falls back to
 * the built-in bogon (reserved / non-routable) check; in production swap in an
 * ASN/reputation lookup via ctx.classifyIp(ip). Explicit ctx ranges win over the
 * bogon check, and "unknown" is treated conservatively (not datacenter) so an
 * incomplete feed never manufactures a block.
 */
const classifyIp = (ip, ctx) => {
  if (typeof ctx.classifyIp === 'function') return ctx.classifyIp(ip) ?? 'unknown';
  if (inCidrList(ip, ctx.datacenterRanges)) return 'datacenter';
  if (inCidrList(ip, ctx.residentialRanges)) return 'residential';
  if (isBogon(ip)) return 'bogon';
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

/** bogon_ip: the request IP is reserved / non-routable — no real user can have it. */
const isBogonIp = (ev, ctx) => classifyIp(ev.request?.device?.ip, ctx) === 'bogon';

/**
 * ip_mismatch: for in-app, the impression must come from the same network as
 * the request (/24 for v4, /64 for v6). Only evaluable on a won event that
 * produced an impression IP. A v4-vs-v6 pair reads as a mismatch, by design.
 */
const isIpMismatch = (ev) => {
  if (!ev.won || !ev.impressionIp) return null;
  const reqNet = networkKey(ev.request?.device?.ip);
  const impNet = networkKey(ev.impressionIp);
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

/**
 * schain_inconsistent: the supply chain doesn't line up with the declared
 * seller. The node closest to the publisher should carry that publisher's id as
 * its sid, the chain should be complete, and it must have at least one node.
 */
const isSchainInconsistent = (ev) => {
  const sc = ev.request?.source?.ext?.schain;
  if (!sc) return null;
  const nodes = sc.nodes ?? [];
  if (!nodes.length) return true;
  if (sc.complete !== undefined && sc.complete !== 1) return true;
  const pub = ev.request?.app?.publisher?.id;
  const termSid = nodes[nodes.length - 1]?.sid;
  return pub != null && termSid != null && String(termSid) !== String(pub);
};

/** bundle_incoherent: the store URL doesn't reference the declared bundle. */
const isBundleIncoherent = (ev) => {
  const app = ev.request?.app;
  if (!app?.bundle || !app?.storeurl) return null;
  return !String(app.storeurl).includes(String(app.bundle));
};

/**
 * device_inconsistent: the device descriptor's VALUES contradict each other — a
 * content check, not a presence check. Covers UA family vs device.os, the
 * Android version in the UA vs device.osv, and a malformed mobile carrier code
 * (mccmnc must be an MCC-MNC like "310-260", not an operator name). Returns null
 * only when nothing was evaluable.
 */
const isDeviceInconsistent = (ev) => {
  const d = ev.request?.device;
  if (!d) return null;
  let evaluated = false;
  if (d.ua && d.os) {
    evaluated = true;
    const ua = d.ua.toLowerCase();
    const os = String(d.os).toLowerCase();
    if (os === 'android' && !ua.includes('android')) return true;
    if (os === 'ios' && !/iphone|ipad|ios/.test(ua)) return true;
  }
  if (d.ua && d.osv != null) {
    const m = d.ua.match(/android\s+(\d+)/i);
    if (m) {
      evaluated = true;
      if (m[1] !== String(d.osv).split('.')[0]) return true;
    }
  }
  if (d.mccmnc != null && d.mccmnc !== '') {
    evaluated = true;
    if (!/^\d{3}-\d{2,3}$/.test(String(d.mccmnc))) return true;
  }
  return evaluated ? false : null;
};

// Device advertising ID validity. "zeroed" = the all-zeros opt-out IFA; junk or
// zeroed IDs are a quality/IVT signal, and a zeroed IFA sent while lmt != 1 is
// internally inconsistent (claims a trackable user but carries no ID).
const ZERO_IFA_HEX = '0'.repeat(32);
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const classifyIfa = (ev) => {
  const raw = ev.request?.device?.ifa;
  if (raw == null || raw === '') return 'missing';
  const v = String(raw).toLowerCase();
  if (v.replace(/-/g, '') === ZERO_IFA_HEX) return 'zeroed';
  if (!UUID_SHAPE.test(v)) return 'malformed';
  return 'valid';
};

// ---- dimensions -----------------------------------------------------------
const dimStr = (v) => (v == null ? 'unknown' : String(v));

/**
 * The key functions you can aggregate by. `publisher` is the classic seller
 * dimension; `bundle` and `schainAsi` survive publisher-id rotation; `net`
 * catches IP-level concentration.
 */
export const DIMENSIONS = {
  publisher: (ev) => dimStr(ev.request?.app?.publisher?.id),
  bundle: (ev) => dimStr(ev.request?.app?.bundle),
  net: (ev) => dimStr(networkKey(ev.request?.device?.ip)),
  schainAsi: (ev) => {
    const nodes = ev.request?.source?.ext?.schain?.nodes ?? [];
    return dimStr(nodes[nodes.length - 1]?.asi);
  },
};

// ---- per-group aggregation ------------------------------------------------
const share = (count, total) => (total > 0 ? count / total : 0);

/**
 * Roll a group's events into signals. Per-event conditions become signals when
 * their SHARE crosses a threshold — one datacenter request is noise; a group
 * that is mostly datacenter is a block.
 */
function scoreGroup(key, events, ctx) {
  const t = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const n = events.length;

  let dc = 0;
  let bogon = 0;
  let mismatch = 0;
  let mismatchEval = 0;
  let unauth = 0;
  let deviceBad = 0;
  let night = 0;
  let schainBad = 0;
  let schainEval = 0;
  let bundleBad = 0;
  let bundleEval = 0;
  let ifaZeroed = 0;
  let ifaMalformed = 0;
  let ifaMissing = 0;
  let ifaLmtBad = 0;
  let httpBad = 0;
  let httpEval = 0;
  const bundles = new Map();
  const ifas = new Set(); // distinct *valid* device IDs
  const ifaNets = new Map(); // valid ifa -> Set of request networks (reuse detection)
  const nets = new Map(); // network -> impression count

  for (const ev of events) {
    if (isDatacenterIp(ev, ctx)) dc += 1;
    if (isBogonIp(ev, ctx)) bogon += 1;

    const mm = isIpMismatch(ev);
    if (mm !== null) {
      mismatchEval += 1;
      if (mm) mismatch += 1;
    }

    if (isUnauthorizedSeller(ev, ctx) === true) unauth += 1;
    if (isDeviceInconsistent(ev) === true) deviceBad += 1;

    const sc = isSchainInconsistent(ev);
    if (sc !== null) {
      schainEval += 1;
      if (sc) schainBad += 1;
    }
    const bi = isBundleIncoherent(ev);
    if (bi !== null) {
      bundleEval += 1;
      if (bi) bundleBad += 1;
    }

    const hour = localHour(ev.ts ?? Date.now(), t.nightTz);
    if (hour >= t.nightWindow[0] && hour < t.nightWindow[1]) night += 1;

    const b = ev.request?.app?.bundle ?? '?';
    bundles.set(b, (bundles.get(b) ?? 0) + 1);

    const ifaClass = classifyIfa(ev);
    if (ifaClass === 'zeroed') {
      ifaZeroed += 1;
      if (ev.request?.device?.lmt !== 1) ifaLmtBad += 1;
    } else if (ifaClass === 'malformed') {
      ifaMalformed += 1;
    } else if (ifaClass === 'missing') {
      ifaMissing += 1;
    } else {
      const ifa = ev.request.device.ifa;
      ifas.add(ifa);
      const net = networkKey(ev.request?.device?.ip);
      if (net) {
        if (!ifaNets.has(ifa)) ifaNets.set(ifa, new Set());
        ifaNets.get(ifa).add(net);
      }
    }

    if (ev.won && ev.impressionIp) {
      const net = networkKey(ev.impressionIp);
      if (net) nets.set(net, (nets.get(net) ?? 0) + 1);
    }

    /*
     * HTTP client coherence.
     *
     * Only evaluable when the impression carried its request headers. A
     * real in-app pixel comes from a WebView, so its headers must agree
     * with each other and with the user-agent. A script that sets
     * --user-agent and nothing else fails here while looking perfect in
     * the bid request.
     */
    if (ev.impressionHeaders) {
      httpEval += 1;
      if (auditHeaders(ev.impressionHeaders, { ua: ev.request?.device?.ua }).ok === false) {
        httpBad += 1;
      }
    }
  }

  const topBundle = [...bundles.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['?', 0];
  const maxPerNet = Math.max(0, ...nets.values());
  const invalidIfa = ifaZeroed + ifaMalformed + ifaMissing;
  let reusedIfaCount = 0;
  for (const netSet of ifaNets.values()) if (netSet.size >= t.ifaMaxNets) reusedIfaCount += 1;
  const signals = [];
  const add = (code, level, detail) => signals.push({ code, level, detail });

  // IP + schain + identity checks — judged by share regardless of volume.
  if (share(dc, n) >= t.datacenterShare) {
    add('datacenter_seller', 'block', `${dc}/${n} events on datacenter IPs`);
  }
  if (share(bogon, n) >= t.bogonShare) {
    add('bogon_seller', 'block', `${bogon}/${n} events from reserved / non-routable IPs (no real user has one)`);
  }
  if (mismatchEval > 0 && share(mismatch, mismatchEval) >= t.mismatchShare) {
    add('mismatch_seller', 'block', `${mismatch}/${mismatchEval} impressions off the request network`);
  }
  if (unauth > 0) {
    add('unauthorized_seller', 'flag', `${unauth}/${n} events from an unauthorized seller/asi`);
  }
  if (schainEval > 0 && share(schainBad, schainEval) >= t.schainShare) {
    add('schain_inconsistent', 'flag', `${schainBad}/${schainEval} events: schain terminal sid != publisher.id or incomplete`);
  }
  if (bundleEval > 0 && share(bundleBad, bundleEval) >= t.bundleShare) {
    add('bundle_incoherent', 'flag', `${bundleBad}/${bundleEval} events: storeurl does not reference app.bundle`);
  }

  // Aggregates judged only with enough volume to be meaningful.
  if (n >= t.minVolume) {
    if (share(night, n) >= t.nightShare) {
      add('schedule_seller', 'flag', `${night}/${n} events in ${t.nightTz} ${t.nightWindow[0]}:00-${t.nightWindow[1]}:00`);
    }
    if (share(deviceBad, n) >= t.deviceShare) {
      add('device_inconsistent', 'flag', `${deviceBad}/${n} events: device values contradict each other (UA / os / osv / mccmnc)`);
    }
    if (maxPerNet >= t.ipConcentration) {
      add('ip_concentration', 'flag', `${maxPerNet} impressions on a single network`);
    }
    if (share(invalidIfa, n) >= t.invalidIfaShare) {
      add('invalid_ifa_seller', 'flag', `${invalidIfa}/${n} events with zeroed/malformed/missing device IDs (zeroed=${ifaZeroed} malformed=${ifaMalformed} missing=${ifaMissing})`);
    }
    if (share(ifaLmtBad, n) >= t.ifaLmtShare) {
      add('ifa_lmt_mismatch', 'flag', `${ifaLmtBad}/${n} zeroed IFAs sent with lmt != 1 (claims trackable, carries no ID)`);
    }
    if (reusedIfaCount > 0) {
      add('ifa_reuse_seller', 'flag', `${reusedIfaCount} valid device IDs each seen on >= ${t.ifaMaxNets} distinct networks`);
    }
    if (httpEval > 0 && share(httpBad, httpEval) >= t.httpShare) {
      add('http_incoherent', 'flag', `${httpBad}/${httpEval} impressions with self-contradicting HTTP fingerprints (client hints vs user-agent vs accept)`);
    }
  }

  return {
    key,
    volume: n,
    signals,
    stats: {
      datacenterShare: Number(share(dc, n).toFixed(3)),
      bogonShare: Number(share(bogon, n).toFixed(3)),
      mismatchShare: Number(share(mismatch, mismatchEval).toFixed(3)),
      nightShare: Number(share(night, n).toFixed(3)),
      invalidIfaShare: Number(share(invalidIfa, n).toFixed(3)),
      httpIncoherentShare: httpEval > 0 ? Number(share(httpBad, httpEval).toFixed(3)) : null,
      topBundle: { bundle: topBundle[0], share: Number(share(topBundle[1], n).toFixed(3)) },
      distinctIfa: ifas.size,
      reusedIfas: reusedIfaCount,
      distinctNets: nets.size,
      maxImpressionsPerNet: maxPerNet,
    },
    verdict: signals.some((s) => s.level === 'block') ? 'block' : signals.length ? 'flag' : 'clean',
  };
}

/**
 * Analyze a batch of events, grouped by one dimension.
 * @param {Array} events  normalized events: { ts, won, impressionIp, request }
 * @param {object} ctx    { authorized?, datacenterRanges?, residentialRanges?, classifyIp?, thresholds? }
 * @param {object} opts   { dimension?: keyof DIMENSIONS | (ev)=>string }  default 'publisher'
 * @returns {{ dimension, groups: object[], summary: object }}
 */
export function analyze(events, ctx = {}, { dimension = 'publisher' } = {}) {
  const keyFn = typeof dimension === 'function' ? dimension : DIMENSIONS[dimension];
  if (!keyFn) throw new Error(`unknown dimension: ${dimension}`);

  const grouped = new Map();
  for (const ev of events) {
    const k = keyFn(ev);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(ev);
  }
  const groups = [...grouped.entries()]
    .map(([k, evs]) => scoreGroup(k, evs, ctx))
    .sort((a, b) => b.volume - a.volume);

  return {
    dimension: typeof dimension === 'function' ? 'custom' : dimension,
    groups,
    summary: {
      groups: groups.length,
      events: events.length,
      blocked: groups.filter((g) => g.verdict === 'block').map((g) => g.key),
      flagged: groups.filter((g) => g.verdict === 'flag').map((g) => g.key),
    },
  };
}

/**
 * Run analyze() over rolling (tumbling) time windows instead of one batch, so a
 * group is judged on its recent behavior and ramp-ups are visible per window.
 * @returns {Array<{ windowStart, windowEnd, report }>}
 */
export function analyzeWindows(events, ctx = {}, { windowMs = 86400000, dimension = 'publisher' } = {}) {
  const buckets = new Map();
  for (const ev of events) {
    const ts = ev.ts ?? Date.now();
    const start = Math.floor(ts / windowMs) * windowMs;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(ev);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, evs]) => ({
      windowStart: start,
      windowEnd: start + windowMs,
      report: analyze(evs, ctx, { dimension }),
    }));
}
