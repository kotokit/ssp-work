// The SSP integration primitives: build an OpenRTB request, relay it to the
// exchange with the account key, and on a win fire the sealed impression pixel
// from the same residential IP (so request IP == impression IP, in-app).
//
// buildAuctionRequest emits a full OpenRTB 2.5 in-app request (device, geo,
// regs/GPP, source/schain, badv, full imp) so the exchange's IVT job sees the
// same field surface it gets from real supply. Values that should VARY per
// request (ifa, dpid hashes, tid, geo jitter) are generated fresh each call;
// values that are an identity (schain asi/sid, app domain/cat) come from config
// so the test subject is consistent. Nothing here is copied from a captured
// request — it's generated to the shape of one.

const BANNER_SIZES = [
  [320, 50],
  [300, 250],
  [320, 480],
];
const CONNECTION_TYPES = [2, 3, 6]; // wifi, cellular unknown, cellular 4G

// Banner defaults for an in-app MRAID slot (api 3/5/6 = MRAID 1/2/3).
const BANNER_MIMES = ['text/javascript', 'text/html', 'image/jpeg', 'image/png', 'image/gif'];
const BANNER_API = [3, 5, 6];
const BANNER_BATTR = [1, 2, 5, 8, 9, 14, 17];

// Internally consistent screen buckets (w/h in px with matching ppi/pxratio).
const DEVICE_PROFILES = [
  { w: 720, h: 1600, ppi: 280, pxratio: 1.75 },
  { w: 1080, h: 2340, ppi: 395, pxratio: 2.625 },
  { w: 1080, h: 2400, ppi: 420, pxratio: 2.625 },
  { w: 1440, h: 3120, ppi: 515, pxratio: 3.5 },
];

// US metros keyed by the token the IP pool uses (metro = Nielsen DMA code).
const US_METROS = {
  Boston: { city: 'Boston', region: 'ma', lat: 42.36, lon: -71.06, metro: '506', zip: '02108' },
  NewYork: { city: 'New York', region: 'ny', lat: 40.71, lon: -74.01, metro: '501', zip: '10001' },
  NewJersey: { city: 'Newark', region: 'nj', lat: 40.74, lon: -74.17, metro: '501', zip: '07102' },
  Dallas: { city: 'Dallas', region: 'tx', lat: 32.78, lon: -96.8, metro: '623', zip: '75201' },
  Phoenix: { city: 'Phoenix', region: 'az', lat: 33.45, lon: -112.07, metro: '753', zip: '85004' },
  WestLafayette: { city: 'West Lafayette', region: 'in', lat: 40.42, lon: -86.91, metro: '582', zip: '47906' },
};
const METRO_FALLBACK = Object.values(US_METROS);

// carrier + a plausible mccmnc per residential ISP (SIM present even on wifi).
const CARRIERS = [
  [/comcast|xfinity/i, { carrier: 'Comcast', mccmnc: '311-585' }],
  [/charter|spectrum/i, { carrier: 'Charter Spectrum', mccmnc: '310-999' }],
  [/at&t|u-?verse/i, { carrier: 'AT&T', mccmnc: '310-410' }],
  [/verizon/i, { carrier: 'Verizon', mccmnc: '311-480' }],
  [/t-?mobile/i, { carrier: 'T-Mobile', mccmnc: '310-260' }],
  [/cox/i, { carrier: 'Cox', mccmnc: '311-590' }],
  [/centurylink|lumen/i, { carrier: 'CenturyLink', mccmnc: '310-030' }],
  [/frontier/i, { carrier: 'Frontier', mccmnc: '310-012' }],
  [/optimum|altice/i, { carrier: 'Optimum', mccmnc: '310-990' }],
];

// Placeholder US-national privacy signal. Swap for whatever your consent layer
// emits; the point is that the field surface exists for the IVT job to read.
const GPP_DEFAULT = { gpp: 'DBABLA~BVVqAAAA.QA', gpp_sid: [8] };

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rndId = (n = 8) => Math.random().toString(36).slice(2, 2 + n);
const rndHex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const rndUuid = () =>
  `${rndHex(8)}-${rndHex(4)}-4${rndHex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${rndHex(3)}-${rndHex(12)}`;
const jitter = (n, d = 0.05) => Number((n + (Math.random() * 2 - 1) * d).toFixed(4));
/** Drop undefined/null keys so optional fields (e.g. hwv) stay absent, not null. */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** Best-effort device identity from the UA (osv, model, make, hwv). */
function parseDevice(ua) {
  const osv = ua.match(/Android\s+([\d.]+)/i)?.[1] ?? '13';
  const model = ua.match(/;\s*([^;]+?)\s+Build\//i)?.[1]?.trim() ?? 'Android Phone';
  const hwv = ua.match(/Build\/([^;)\s]+)/i)?.[1]; // build/board token, if present
  let make = 'generic';
  if (/^SM-|galaxy/i.test(model)) make = 'samsung';
  else if (/^(moto|XT\d)/i.test(model)) make = 'motorola';
  else if (/pixel/i.test(model)) make = 'Google';
  else if (/^(RMX|realme)/i.test(model)) make = 'realme';
  else if (/^(CPH|oneplus)/i.test(model)) make = 'OnePlus';
  else if (/^(M\d|redmi|mi\s|POCO)/i.test(model)) make = 'Xiaomi';
  else if (/^(SO-|xperia)/i.test(model)) make = 'Sony';
  return { osv, model, make, hwv };
}

/** geo block consistent with the IP's metro; lat/lon jittered so hosts vary. */
function geoForMetro(metro) {
  const key = typeof metro === 'string' ? metro.replace(/^US\//, '').replace(/\s+/g, '') : '';
  const m = US_METROS[key] ?? pick(METRO_FALLBACK);
  return {
    country: 'USA',
    type: 2, // IP-derived
    lat: jitter(m.lat),
    lon: jitter(m.lon),
    region: m.region,
    city: m.city,
    metro: m.metro,
    zip: m.zip,
  };
}

function carrierForIsp(isp = '') {
  for (const [re, v] of CARRIERS) if (re.test(isp)) return v;
  return { carrier: 'Comcast', mccmnc: '311-585' };
}

/** Supply chain for the onboarded SSP. Fully overridable via traffic.schain. */
function buildSchain(reqId, publisherId, traffic) {
  const sc = traffic.schain ?? {};
  const asi = sc.asi ?? traffic.appDomain ?? 'ssp.local';
  const nodes = sc.nodes ?? [{ asi, sid: String(publisherId), rid: reqId, hp: 1 }];
  return { ver: '1.0', complete: sc.complete ?? 1, nodes };
}

/**
 * @param {{ ua: string, ip: string, bundle: string, appName: string,
 *   publisherId: string, format: 'banner'|'video', bidfloor?: number,
 *   geoMeta?: { isp?: string, metro?: string }, traffic?: object }} o
 */
export function buildAuctionRequest({
  ua,
  ip,
  bundle,
  appName,
  publisherId,
  format,
  bidfloor = 0.01,
  geoMeta = {},
  traffic = {},
}) {
  const reqId = `nb-${Date.now()}-${rndId(6)}`;

  // ---- imp ----------------------------------------------------------------
  const imp = {
    id: '1',
    secure: 1,
    instl: 0,
    exp: 1200,
    displaymanager: traffic.displayManager ?? 'BidMachine',
    displaymanagerver: traffic.displayManagerVer ?? '3.3.0',
    bidfloor,
    bidfloorcur: 'USD',
  };
  if (format === 'video') {
    imp.video = {
      mimes: ['video/mp4'],
      w: 1280,
      h: 720,
      minduration: 5,
      maxduration: 30,
      protocols: [2, 3, 5, 6, 7, 8],
      linearity: 1,
      placement: 5,
      api: [3, 5, 6],
      battr: BANNER_BATTR,
    };
  } else {
    const [w, h] = pick(BANNER_SIZES);
    imp.banner = {
      w,
      h,
      format: [{ w, h }],
      mimes: BANNER_MIMES,
      btype: [],
      api: BANNER_API,
      battr: BANNER_BATTR,
      pos: 1,
    };
  }

  // ---- device -------------------------------------------------------------
  const { osv, model, make, hwv } = parseDevice(ua);
  const prof = pick(DEVICE_PROFILES);
  const { carrier, mccmnc } = carrierForIsp(geoMeta.isp);
  const device = clean({
    ua,
    ip,
    dnt: 0,
    lmt: 0,
    devicetype: 4, // phone
    make,
    model,
    os: 'Android',
    osv,
    hwv,
    h: prof.h,
    w: prof.w,
    ppi: prof.ppi,
    pxratio: prof.pxratio,
    js: 1,
    language: 'en',
    carrier,
    mccmnc,
    connectiontype: pick(CONNECTION_TYPES),
    ifa: rndUuid(),
    dpidsha1: rndHex(40),
    dpidmd5: rndHex(32),
    geofetch: 0,
    geo: geoForMetro(geoMeta.metro),
  });

  // ---- app ----------------------------------------------------------------
  const app = clean({
    id: traffic.appId ?? `app-${bundle}`,
    bundle,
    name: appName,
    domain: traffic.appDomain ?? `${bundle.split('.')[1] ?? 'example'}.com`,
    storeurl: `https://play.google.com/store/apps/details?id=${bundle}`,
    cat: traffic.appCat ?? ['IAB1'],
    ver: traffic.appVer ?? '1.0.0',
    content: { keywords: traffic.appKeywords ?? `${appName},Gaming` },
    publisher: { id: publisherId },
  });

  // ---- envelope -----------------------------------------------------------
  const gpp = traffic.gpp ?? GPP_DEFAULT;
  return clean({
    id: reqId,
    at: 1,
    tmax: 500,
    cur: ['USD'],
    imp: [imp],
    app,
    device,
    badv: traffic.badv ?? [],
    user: { id: `u-${rndId(10)}` },
    regs: { coppa: 0, ext: { gdpr: 0 }, gpp: gpp.gpp, gpp_sid: gpp.gpp_sid },
    source: { fd: 1, tid: reqId, ext: { schain: buildSchain(reqId, publisherId, traffic) } },
  });
}

/**
 * Relay the request to the exchange. XFF carries the residential IP too, so the
 * result is identical whether or not core trusts the proxy.
 */
export async function sendAuction(body, { auctionUrl, supplyKey, timeoutMs = 4000 }) {
  try {
    const res = await fetch(auctionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openrtb-version': '2.5',
        'x-forwarded-for': body.device.ip,
        'user-agent': body.device.ua,
        // key may instead be carried in the URL as ?key=... (exchange accepts both)
        ...(supplyKey ? { 'x-adx-key': supplyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = res.status === 200 ? await res.json() : null;
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e).slice(0, 80) };
  }
}

/** Pull the exchange's sealed /t/imp URL out of the winning creative (banner img or VAST Impression). */
export function extractImpPixel(resp) {
  const bid = resp?.seatbid?.[0]?.bid?.[0];
  const adm = typeof bid?.adm === 'string' ? bid.adm : '';
  const m = adm.match(/https?:\/\/[^"'\s)<>\]]+\/t\/imp\?e=[^"'\s)<>\]]+/);
  return m ? m[0] : null;
}

/** Fire the impression pixel from the same residential IP (XFF). */
export async function fireImpression(pixelUrl, { ip, ua, timeoutMs = 4000 }) {
  try {
    const res = await fetch(pixelUrl, {
      headers: { 'x-forwarded-for': ip, 'user-agent': ua },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch (e) {
    return 0;
  }
}
