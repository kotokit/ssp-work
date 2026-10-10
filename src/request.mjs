// The SSP integration primitives: build an OpenRTB request, relay it to the
// exchange with the account key, and on a win fire the sealed impression pixel
// from the same residential IP.
//
// buildAuctionRequest emits a full OpenRTB 2.5 in-app request.
//
// Values that vary per request:
//   - request ID
//   - IFA
//   - user ID
//   - device ID hashes
//   - screen profile
//   - connection type
//   - geo jitter
//
// Values representing the selected supply:
//   - IP
//   - geo/metro
//   - ISP/carrier
//   - publisher
//   - app
//
// The IP is supplied by ssp-server.mjs from the configured IP pool.
// The bid floor is supplied by ssp-server.mjs and is never replaced here.

import crypto from 'node:crypto';
const { initGeoIP, getGeo } = require('./geo');
await initGeoIP();

const BANNER_SIZES = [
  [320, 50],
  [300, 250],
  [320, 480],
];

const CONNECTION_TYPES = [2, 3, 6]; // wifi, cellular unknown, cellular 4G

// Banner defaults for an in-app MRAID slot.
const BANNER_MIMES = [
  'text/javascript',
  'text/html',
  'image/jpeg',
  'image/png',
  'image/gif',
];

const BANNER_API = [3, 5, 6];

const BANNER_BATTR = [
  1,
  2,
  5,
  8,
  9,
  14,
  17,
];

// Internally consistent screen buckets.
const DEVICE_PROFILES = [
  {
    w: 720,
    h: 1600,
    ppi: 280,
    pxratio: 1.75,
  },
  {
    w: 1080,
    h: 2340,
    ppi: 395,
    pxratio: 2.625,
  },
  {
    w: 1080,
    h: 2400,
    ppi: 420,
    pxratio: 2.625,
  },
  {
    w: 1440,
    h: 3120,
    ppi: 515,
    pxratio: 3.5,
  },
];

// US metros keyed by the token used by the IP pool.
//
// These values are used only to create a coherent OpenRTB geo object.
// The actual IP still comes from the IP pool.
const US_METROS = {
  Boston: {
    city: 'Boston',
    region: 'ma',
    lat: 42.36,
    lon: -71.06,
    metro: '506',
    zip: '02108',
  },

  NewYork: {
    city: 'New York',
    region: 'ny',
    lat: 40.71,
    lon: -74.01,
    metro: '501',
    zip: '10001',
  },

  NewJersey: {
    city: 'Newark',
    region: 'nj',
    lat: 40.74,
    lon: -74.17,
    metro: '501',
    zip: '07102',
  },

  Dallas: {
    city: 'Dallas',
    region: 'tx',
    lat: 32.78,
    lon: -96.8,
    metro: '623',
    zip: '75201',
  },

  Phoenix: {
    city: 'Phoenix',
    region: 'az',
    lat: 33.45,
    lon: -112.07,
    metro: '753',
    zip: '85004',
  },

  WestLafayette: {
    city: 'West Lafayette',
    region: 'in',
    lat: 40.42,
    lon: -86.91,
    metro: '582',
    zip: '47906',
  },
};

const METRO_FALLBACK = Object.values(US_METROS);

// ISP -> carrier mapping.
const CARRIERS = [
  [
    /comcast|xfinity/i,
    {
      carrier: 'Comcast',
      mccmnc: '311-585',
    },
  ],

  [
    /charter|spectrum/i,
    {
      carrier: 'Charter Spectrum',
      mccmnc: '310-999',
    },
  ],

  [
    /at&t|u-?verse/i,
    {
      carrier: 'AT&T',
      mccmnc: '310-410',
    },
  ],

  [
    /verizon/i,
    {
      carrier: 'Verizon',
      mccmnc: '311-480',
    },
  ],

  [
    /t-?mobile/i,
    {
      carrier: 'T-Mobile',
      mccmnc: '310-260',
    },
  ],

  [
    /cox/i,
    {
      carrier: 'Cox',
      mccmnc: '311-590',
    },
  ],

  [
    /centurylink|lumen/i,
    {
      carrier: 'CenturyLink',
      mccmnc: '310-030',
    },
  ],

  [
    /frontier/i,
    {
      carrier: 'Frontier',
      mccmnc: '310-012',
    },
  ],

  [
    /optimum|altice/i,
    {
      carrier: 'Optimum',
      mccmnc: '310-990',
    },
  ],
];

// Placeholder US privacy signal.
// Replace with your real consent signal if required.
const GPP_DEFAULT = {
  gpp: 'DBABLA~BVVqAAAA.QA',
  gpp_sid: [8],
};

const DEFAULT_BID_FLOOR = 0.01;
const MAX_REASONABLE_BID_FLOOR = 50;

const pick = (array) =>
    array[Math.floor(Math.random() * array.length)];

const randomId = (length = 8) =>
    crypto.randomBytes(Math.ceil(length / 2))
        .toString('hex')
        .slice(0, length);

const randomUUID = () => crypto.randomUUID();

const jitter = (value, delta = 0.05) =>
    Number(
        (
            value +
            (Math.random() * 2 - 1) * delta
        ).toFixed(4),
    );

/**
 * Remove undefined/null keys.
 */
const clean = (object) =>
    Object.fromEntries(
        Object.entries(object).filter(
            ([, value]) => value != null,
        ),
    );

/**
 * SHA-1 helper.
 */
function sha1(value) {
  return crypto
      .createHash('sha1')
      .update(value)
      .digest('hex');
}

/**
 * MD5 helper.
 */
function md5(value) {
  return crypto
      .createHash('md5')
      .update(value)
      .digest('hex');
}

/**
 * Normalize an IP-pool metro value.
 *
 * Examples:
 *   US/Dallas -> Dallas
 *   Dallas    -> Dallas
 *   New York  -> NewYork
 */
function normalizeMetro(metro) {
  if (typeof metro !== 'string') {
    return '';
  }

  return metro
      .replace(/^US\//i, '')
      .replace(/[\s_-]+/g, '');
}

/**
 * Best-effort device identity from the UA.
 */
function parseDevice(ua) {
  const safeUa =
      typeof ua === 'string'
          ? ua
          : '';

  const osv =
      safeUa.match(/Android\s+([\d.]+)/i)?.[1] ??
      '13';

  const model =
      safeUa.match(
          /;\s*([^;]+?)\s+Build\//i,
      )?.[1]?.trim() ??
      'Android Phone';

  const hwv =
      safeUa.match(
          /Build\/([^;)\s]+)/i,
      )?.[1];

  let make = 'generic';

  if (/^SM-|galaxy/i.test(model)) {
    make = 'samsung';
  } else if (/^(moto|XT\d)/i.test(model)) {
    make = 'motorola';
  } else if (/pixel/i.test(model)) {
    make = 'Google';
  } else if (/^(RMX|realme)/i.test(model)) {
    make = 'realme';
  } else if (/^(CPH|oneplus)/i.test(model)) {
    make = 'OnePlus';
  } else if (/^(M\d|redmi|mi\s|POCO)/i.test(model)) {
    make = 'Xiaomi';
  } else if (/^(SO-|xperia)/i.test(model)) {
    make = 'Sony';
  }

  return {
    osv,
    model,
    make,
    hwv,
  };
}

/**
 * Create a geo block based on the selected IP-pool metro.
 *
 * The IP itself is NOT generated here. It comes from the IP pool.
 */
function geoForMetro(metro) {
  const normalized = normalizeMetro(metro);

  const metroData =
      US_METROS[normalized] ??
      pick(METRO_FALLBACK);

  return {
    country: 'USA',

    // 2 = IP-based geo.
    type: 2,

    lat: jitter(metroData.lat),
    lon: jitter(metroData.lon),

    region: metroData.region,
    city: metroData.city,
    metro: metroData.metro,
    zip: metroData.zip,
  };
}

/**
 * Select a plausible carrier based on the ISP from the IP pool.
 */
function carrierForIsp(isp = '') {
  for (const [regex, carrier] of CARRIERS) {
    if (regex.test(isp)) {
      return carrier;
    }
  }

  return {
    carrier: 'Comcast',
    mccmnc: '311-585',
  };
}

/**
 * Build SupplyChain.
 *
 * The request ID is always used as schain.rid unless the supplied
 * custom node explicitly provides another value.
 */
function buildSchain(
    requestId,
    publisherId,
    traffic = {},
) {
  const configured = traffic.schain ?? {};

  const asi =
      configured.asi ??
      traffic.appDomain ??
      'ssp.local';

  const defaultNode = {
    asi,
    sid: String(publisherId),
    rid: requestId,
    hp: 1,
  };

  const nodes =
      Array.isArray(configured.nodes) &&
      configured.nodes.length > 0
          ? configured.nodes.map((node) => ({
            ...defaultNode,
            ...node,

            // Keep rid tied to the actual OpenRTB request
            // unless the caller explicitly wants another value.
            rid: node.rid ?? requestId,
          }))
          : [defaultNode];

  return {
    ver: '1.0',
    complete:
        configured.complete ??
        1,
    nodes,
  };
}

/**
 * Validate and normalize the supplied bid floor.
 *
 * Important:
 * We do NOT silently turn a supplied $0.01 / $0.10 value into $100.
 */
function normalizeBidFloor(value) {
  const floor =
      Number(value);

  if (!Number.isFinite(floor)) {
    return DEFAULT_BID_FLOOR;
  }

  if (floor < 0) {
    return 0;
  }

  if (floor > MAX_REASONABLE_BID_FLOOR) {
    throw new Error(
        `bidfloor ${floor} is above the configured maximum ${MAX_REASONABLE_BID_FLOOR}`,
    );
  }

  return Number(
      floor.toFixed(4),
  );
}

/**
 * Build an OpenRTB request.
 *
 * @param {{
 *   ua: string,
 *   ip: string,
 *   bundle: string,
 *   appName: string,
 *   publisherId: string,
 *   format: 'banner'|'video',
 *   bidfloor?: number,
 *   geoMeta?: {
 *     isp?: string,
 *     metro?: string
 *   },
 *   traffic?: object
 * }} options
 */
export function buildAuctionRequest({
                                      ua,
                                      ip,
                                      bundle,
                                      appName,
                                      publisherId,
                                      format,
                                      bidfloor = DEFAULT_BID_FLOOR,
                                      geoMeta = {},
                                      traffic = {},
                                    }) {
  if (
      typeof ip !== 'string' ||
      !ip.trim()
  ) {
    throw new Error(
        'buildAuctionRequest: IP is required',
    );
  }

  if (
      typeof ua !== 'string' ||
      !ua.trim()
  ) {
    throw new Error(
        'buildAuctionRequest: user-agent is required',
    );
  }

  if (
      typeof bundle !== 'string' ||
      !bundle.trim()
  ) {
    throw new Error(
        'buildAuctionRequest: bundle is required',
    );
  }

  if (
      typeof publisherId !== 'string' &&
      typeof publisherId !== 'number'
  ) {
    throw new Error(
        'buildAuctionRequest: publisherId is required',
    );
  }

  const requestId = Array.from(
      { length: 22 },
      () => Math.floor(Math.random() * 16).toString(16)
  ).join('');

  const floor =
      normalizeBidFloor(bidfloor);

  // -------------------------------------------------------------------------
  // Impression
  // -------------------------------------------------------------------------

  const imp = {
    id: '1',

    secure: 1,

    instl: 0,

    exp: 1200,

    displaymanager:
        traffic.displayManager ??
        'third_party_sdk',

    displaymanagerver:
        traffic.displayManagerVer ??
        '0',

    // IMPORTANT:
    // This is the value supplied by ssp-server.mjs.
    bidfloor: floor,

    bidfloorcur: 'USD',
  };

  if (format === 'video') {
    imp.video = {
      mimes: [
        'video/mp4',
      ],

      w: 1280,
      h: 720,

      minduration: 5,
      maxduration: 30,

      protocols: [
        2,
        3,
        5,
        6,
        7,
        8,
      ],

      linearity: 1,

      placement: 5,

      api: [
        3,
        5,
        6,
      ],

      battr: BANNER_BATTR,
    };
  } else {
    const [
      width,
      height,
    ] = pick(BANNER_SIZES);

    imp.banner = {
      w: width,
      h: height,

      format: [
        {
          w: width,
          h: height,
        },
      ],

      mimes: BANNER_MIMES,

      btype: [],

      api: BANNER_API,

      battr: BANNER_BATTR,

      pos: 1,
    };
  }

  // -------------------------------------------------------------------------
  // Device
  // -------------------------------------------------------------------------

  const {
    osv,
    model,
    make,
    hwv,
  } = parseDevice(ua);

  const profile =
      pick(DEVICE_PROFILES);

  const {
    carrier,
    mccmnc,
  } = carrierForIsp(
      geoMeta.isp,
  );

  // One fresh device ID per auction request.
  const deviceId =
      randomUUID();

  const device = clean({
    dnt: 0,
    lmt: 0,
    geo: getGeo(ip.ip),
    // Advertising ID.
    ifa: deviceId,
    connectiontype:
        pick(CONNECTION_TYPES),
    language: 'en',

    model,

    make,

    carrier,

    os: 'Android',
    osv,

    js: 1,

    ua,
    ip,

    w: profile.w,

    h: profile.h,
    // 4 = phone.
    devicetype: 4,





    //hwv,
    //ppi: profile.ppi,
    //pxratio: profile.pxratio,
    //mccmnc,


    // These are now ACTUAL hashes of the device ID
    // rather than random strings pretending to be hashes.
    dpidsha1: sha1(deviceId),

    dpidmd5: md5(deviceId),

    geofetch: 0,
  });

  // -------------------------------------------------------------------------
  // App
  // -------------------------------------------------------------------------

  const safeBundle =
      String(bundle);

  const defaultDomain =
      `${safeBundle.split('.')[1] ?? 'example'}.com`;

  const app = clean({
    id: crypto.randomBytes(6).toString('hex'),

    bundle: safeBundle,

    name: appName,

    domain: defaultDomain,

    storeurl:
        traffic.storeurl ??
        `https://play.google.com/store/apps/details?id=${encodeURIComponent(
            safeBundle,
        )}`,

    cat:
        traffic.appCat ??
        ['IAB1'],

    ver:
        traffic.appVer ??
        '2.2.82',

    /*content: {
      keywords:
          traffic.appKeywords ??
          `${appName ?? 'App'},Gaming`,
    },*/

    publisher: {
      id: String(publisherId),
    },
  });

  // -------------------------------------------------------------------------
  // Privacy
  // -------------------------------------------------------------------------

  const gpp =
      traffic.gpp ??
      GPP_DEFAULT;

  // -------------------------------------------------------------------------
  // Final OpenRTB request
  // -------------------------------------------------------------------------

  return clean({
    id: requestId,

    at: 2,

    tmax: Math.floor(Math.random() * (560 - 350 + 1)) + 350,

    cur: [
      'USD',
    ],

    device,

    imp: [
      imp,
    ],

    app,

    badv:
        traffic.badv ??
        [],

    user: {
      id: `u-${randomId(10)}`,
    },

    regs: {
      coppa: 0,

      ext: {
        gdpr: 0,
      },

      //gpp: gpp.gpp,

      //gpp_sid: gpp.gpp_sid,
    },

    source: {
      fd: 1,

      // tid must identify this auction.
      tid: requestId,

      ext: {
        /*schain:
            buildSchain(
                requestId,
                publisherId,
                traffic,
            ),*/
      },
    },
  });
}

/**
 * Relay the OpenRTB request to the exchange.
 *
 * The same residential IP is passed through:
 *   - device.ip in the OpenRTB body
 *   - X-Forwarded-For
 *   - X-Real-IP
 *
 * The same UA is also forwarded.
 */
export async function sendAuction(
    body,
    {
      auctionUrl,
      supplyKey,
      timeoutMs = 4000,
    },
) {
  try {
    const ip =
        body?.device?.ip;

    const ua =
        body?.device?.ua;

    const headers = {
      'content-type':
          'application/json',

      'accept':
          'application/json',

      'x-openrtb-version':
          '2.5',

      'user-agent':
      ua,

      // Preserve the simulated end-user IP.
      ...(ip
          ? {
            'x-forwarded-for': ip,
            'x-real-ip': ip,
          }
          : {}),

      // The exchange can authenticate through this header.
      ...(supplyKey
          ? {
            'x-adx-key': supplyKey,
          }
          : {}),
    };

    const response =
        await fetch(
            auctionUrl,
            {
              method: 'POST',

              headers,

              body:
                  JSON.stringify(body),

              signal:
                  AbortSignal.timeout(
                      timeoutMs,
                  ),
            },
        );

    let json = null;

    if (
        response.status !== 204
    ) {
      const text =
          await response.text();

      if (text) {
        try {
          json =
              JSON.parse(text);
        } catch {
          // Keep the raw response so the caller can distinguish
          // malformed JSON from a network failure.
          return {
            status: response.status,
            json: null,
            raw: text.slice(0, 2000),
            parseError: true,
          };
        }
      }
    }

    return {
      status: response.status,
      json,
    };
  } catch (error) {
    return {
      status: 0,

      error:
          String(
              error?.message ??
              error,
          ).slice(0, 200),
    };
  }
}

/**
 * Pull the exchange's sealed /t/imp URL out of the winning creative.
 *
 * Supports URLs appearing in HTML/JS creative markup.
 */
export function extractImpPixel(
    response,
) {
  const bid =
      response
          ?.seatbid?.[0]
          ?.bid?.[0];

  if (!bid) {
    return null;
  }

  const adm =
      typeof bid.adm === 'string'
          ? bid.adm
          : '';

  if (!adm) {
    return null;
  }

  const match =
      adm.match(
          /https?:\/\/[^"'\s)<>\]]+\/t\/imp\?e=[^"'\s)<>\]]+/i,
      );

  return match
      ? match[0]
      : null;
}

/**
 * Fire the impression pixel using the same residential IP and UA
 * as the original auction request.
 */
export async function fireImpression(
    pixelUrl,
    {
      ip,
      ua,
      timeoutMs = 4000,
    },
) {
  try {
    const response =
        await fetch(
            pixelUrl,
            {
              method: 'GET',

              headers: {
                ...(ip
                    ? {
                      'x-forwarded-for': ip,
                      'x-real-ip': ip,
                    }
                    : {}),

                ...(ua
                    ? {
                      'user-agent': ua,
                    }
                    : {}),
              },

              signal:
                  AbortSignal.timeout(
                      timeoutMs,
                  ),
            },
        );

    return response.status;
  } catch {
    return 0;
  }
}