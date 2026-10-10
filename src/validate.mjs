/**
 * OpenRTB 2.6 bid request validator.
 *
 * Purpose: catch the mistakes that actually get a request rejected or
 * silently filtered by an exchange, before it is ever sent.
 *
 * Two severities:
 *
 *   error   - the request is structurally invalid or self-contradictory.
 *             An exchange will reject it or discard the impression later.
 *   warning - legal, but a known risk or a likely-unintended value.
 *
 * Checks are grouped so a failure tells you which object to fix.
 *
 * Note on scope: this validates the REQUEST we send. It deliberately does
 * not enforce exchange-specific policy (their own required fields, allowed
 * battr sets, etc.) because that differs per endpoint.
 */

import {
  getGeoDetail,
} from './geo.mjs';

const IPV4 =
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const IPV6 =
    /^(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}$|^::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}$|^[0-9a-f]{1,4}::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}$/i;

const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MCCMNC = /^\d{3}-\d{2,3}$/;

const SHA1_HEX = /^[0-9a-f]{40}$/i;
const MD5_HEX = /^[0-9a-f]{32}$/i;

/* OpenRTB 2.6 connectiontype (Device) */
const CONNECTION_TYPES = new Set([0, 1, 2, 3, 4, 5, 6]);

/* OpenRTB 2.6 devicetype: 1..8 defined */
const DEVICE_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

/* Auction types: 1 = First Price, 2 = Second Price Plus, 3 = value passed in bidfloor */
const AUCTION_TYPES = new Set([1, 2, 3]);

/* Banner api frameworks: 1..7 */
const API_FRAMEWORKS = new Set([1, 2, 3, 4, 5, 6, 7]);

/* Creative attributes: 1..17 */
const CREATIVE_ATTRIBUTES = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
]);

/* battr values that reliably suppress demand. */
const AGGRESSIVE_BATTR = new Map([
    [13, 'Stripes/Scrolling: very aggressive, most exchanges reject or ignore it'],
    [16, 'User-generated content: aggressive, blocks a large share of demand'],
]);

const isPlainObject = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);

const isNonEmptyString = (value) =>
    typeof value === 'string' && value.trim() !== '';

const isPositiveInt = (value) =>
    Number.isInteger(value) && value > 0;

/**
 * Validate an OpenRTB 2.6 bid request.
 *
 * @param {object} request
 * @returns {{
 *   valid: boolean,
 *   errors: {path: string, message: string}[],
 *   warnings: {path: string, message: string}[],
 *   stats: object
 * }}
 */
export function validateBidRequest(request) {
  const errors = [];
  const warnings = [];

  const error = (path, message) =>
      errors.push({ path, message });

  const warn = (path, message) =>
      warnings.push({ path, message });

  if (!isPlainObject(request)) {
    return {
      valid: false,
      errors: [{
        path: '',
        message: `Request must be a JSON object, got ${Array.isArray(request) ? 'array' : typeof request}`,
      }],
      warnings: [],
      stats: {},
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Top level                                                              */
  /* ---------------------------------------------------------------------- */

  if (!isNonEmptyString(request.id)) {
    error('id', 'Required: unique auction ID (string).');
  }

  if (request.id && String(request.id).length > 128) {
    warn('id', 'Longer than 128 chars; some exchanges truncate or reject.');
  }

  if (request.test !== undefined && request.test !== 0 && request.test !== 1) {
    error('test', 'Must be 0 or 1 when present.');
  }

  if (request.at !== undefined && !AUCTION_TYPES.has(request.at)) {
    error(
        'at',
        `Must be 1 (first price), 2 (second price plus) or 3, got ${JSON.stringify(request.at)}.`,
    );
  }

  if (request.tmax !== undefined) {
    if (!isPositiveInt(request.tmax)) {
      error('tmax', 'Must be a positive integer (milliseconds).');
    } else if (request.tmax > 10000) {
      warn('tmax', `Unusually high (${request.tmax}ms); most exchanges cap at 1000-2000ms.`);
    }
  }

  if (!Array.isArray(request.cur) || request.cur.length === 0) {
    warn('cur', 'Missing/empty: exchanges default to USD, but being explicit avoids ambiguity.');
  } else if (!request.cur.every(isNonEmptyString)) {
    error('cur', 'Every currency must be a non-empty string.');
  }

  /* ---------------------------------------------------------------------- */
  /* imp                                                                    */
  /* ---------------------------------------------------------------------- */

  if (!Array.isArray(request.imp) || request.imp.length === 0) {
    error('imp', 'Required: at least one impression object.');
  } else {
    const seenIds = new Set();

    request.imp.forEach((imp, index) => {
      const path = `imp[${index}]`;

      if (!isPlainObject(imp)) {
        error(path, 'Must be an object.');
        return;
      }

      if (!isNonEmptyString(imp.id)) {
        error(`${path}.id`, 'Required: impression ID (string).');
      } else if (seenIds.has(imp.id)) {
        error(`${path}.id`, `Duplicate impression id "${imp.id}".`);
      } else {
        seenIds.add(imp.id);
      }

      const media = ['banner', 'video', 'audio', 'native']
          .filter((key) => imp[key] !== undefined);

      if (media.length === 0) {
        error(
            path,
            'No media object: exactly one of banner/video/audio/native is required.',
        );
      } else if (media.length > 1) {
        error(
            path,
            `Multiple media objects (${media.join(', ')}); the exchange cannot tell which to bid on.`,
        );
      }

      if (imp.bidfloor !== undefined) {
        if (typeof imp.bidfloor !== 'number' || !Number.isFinite(imp.bidfloor)) {
          error(`${path}.bidfloor`, 'Must be a finite number.');
        } else if (imp.bidfloor < 0) {
          error(`${path}.bidfloor`, 'Must not be negative.');
        } else if (imp.bidfloor > 50) {
          warn(`${path}.bidfloor`, `Very high floor (${imp.bidfloor}); expect no bids.`);
        }
      }

      if (imp.bidfloorcur !== undefined && !isNonEmptyString(imp.bidfloorcur)) {
        error(`${path}.bidfloorcur`, 'Must be a non-empty ISO-4217 string.');
      }

      if (imp.bidfloorcur && !imp.bidfloor && imp.bidfloor !== 0) {
        warn(`${path}.bidfloorcur`, 'Present without bidfloor.');
      }

      if (imp.secure === 1 && imp.banner === undefined && imp.video === undefined) {
        /* fine, just informational */
      }

      if (imp.banner !== undefined) {
        validateBanner(imp.banner, `${path}.banner`, error, warn);
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* app / site                                                             */
  /* ---------------------------------------------------------------------- */

  const hasApp = request.app !== undefined;
  const hasSite = request.site !== undefined;

  if (!hasApp && !hasSite) {
    error('app', 'Required: one of app or site must be present.');
  }

  if (hasApp && hasSite) {
    error('app', 'Both app and site present; exactly one is required.');
  }

  if (hasApp) {
    if (!isPlainObject(request.app)) {
      error('app', 'Must be an object.');
    } else {
      const app = request.app;

      if (!isNonEmptyString(app.id) && !isNonEmptyString(app.bundle)) {
        error('app', 'At least one of app.id or app.bundle is recommended; without both, the exchange cannot resolve the app.');
      }

      if (!isNonEmptyString(app.name)) {
        warn('app.name', 'Missing; helpful for exchange-side app resolution.');
      }

      if (app.bundle !== undefined && !isNonEmptyString(app.bundle)) {
        error('app.bundle', 'Must be a non-empty reverse-domain string.');
      }

      if (app.bundle && typeof app.bundle === 'string' && !/^[a-z0-9]+(\.[a-z0-9_-]+)+$/i.test(app.bundle)) {
        warn('app.bundle', `"${app.bundle}" does not look like a reverse-domain bundle ID.`);
      }

      if (app.storeurl !== undefined && !/^https?:\/\//i.test(String(app.storeurl))) {
        error('app.storeurl', 'Must be an absolute http(s) URL.');
      }

      if (app.cat !== undefined) {
        if (!Array.isArray(app.cat) || app.cat.length === 0) {
          error('app.cat', 'Must be a non-empty array when present.');
        } else if (!app.cat.every(isNonEmptyString)) {
          error('app.cat', 'Every category must be a non-empty string.');
        } else {
          const bad = app.cat.filter((c) => !/^IAB\d+(-\d+)?$/i.test(String(c)));

          if (bad.length > 0) {
            warn(
                'app.cat',
                `Not IAB-content-taxonomy shaped: ${bad.join(', ')}. Exchanges may ignore them.`,
            );
          }
        }
      }

      if (app.publisher !== undefined && !isPlainObject(app.publisher)) {
        error('app.publisher', 'Must be an object.');
      } else if (isPlainObject(app.publisher) && !isNonEmptyString(app.publisher.id)) {
        warn('app.publisher.id', 'Missing; many exchanges require it for supply verification.');
      }

      /*
       * app.id shape is NOT checked here.
       *
       * A 12-char hex id is exactly what real apps use (see the reference
       * traffic), so flagging it would be a false positive. The property
       * that actually matters is stability ACROSS requests, which a single
       * request cannot show — use the batch check instead.
       */
    }
  }

  /* ---------------------------------------------------------------------- */
  /* device                                                                 */
  /* ---------------------------------------------------------------------- */

  if (!isPlainObject(request.device)) {
    error('device', 'Required: device object must be present.');
  } else {
    validateDevice(request.device, error, warn);
  }

  /* ---------------------------------------------------------------------- */
  /* source                                                                 */
  /* ---------------------------------------------------------------------- */

  if (request.source !== undefined) {
    if (!isPlainObject(request.source)) {
      error('source', 'Must be an object.');
    } else {
      const source = request.source;

      if (source.fd !== undefined && source.fd !== 0 && source.fd !== 1) {
        error('source.fd', 'Must be 0 (exchange pays) or 1 (SSP pays) when present.');
      }

      if (source.tid !== undefined && !isNonEmptyString(source.tid)) {
        error('source.tid', 'Must be a non-empty string.');
      }

      if (
          isNonEmptyString(source.tid) &&
          isNonEmptyString(request.id) &&
          source.tid !== request.id
      ) {
        warn(
            'source.tid',
            'Differs from request.id. If tid is meant to identify this auction, it should match id.',
        );
      }

      /*
       * SupplyChain lives at source.ext.schain. The top-level source.schain
       * location is not where OpenRTB defines it, so flag it if present.
       */
      const schain =
          isPlainObject(source.ext) ? source.ext.schain : undefined;

      if (source.schain !== undefined && schain === undefined) {
        error(
            'source.schain',
            'Not a valid OpenRTB location. SupplyChain belongs at source.ext.schain.',
        );
        validateSchain(source.schain, error, warn, 'source.schain');
      }

      if (schain !== undefined) {
        validateSchain(schain, error, warn, 'source.ext.schain');
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* regs                                                                   */
  /* ---------------------------------------------------------------------- */

  if (request.regs !== undefined) {
    if (!isPlainObject(request.regs)) {
      error('regs', 'Must be an object.');
    } else {
      if (request.regs.coppa !== undefined && request.regs.coppa !== 0 && request.regs.coppa !== 1) {
        error('regs.coppa', 'Must be 0 or 1 when present.');
      }

      if (request.regs.gpp_sid !== undefined) {
        if (!Array.isArray(request.regs.gpp_sid)) {
          error('regs.gpp_sid', 'Must be an array of integers.');
        } else if (!request.regs.gpp_sid.every((v) => Number.isInteger(v))) {
          error('regs.gpp_sid', 'Every entry must be an integer.');
        }
      }

      if (request.regs.gpp !== undefined && !isNonEmptyString(request.regs.gpp)) {
        error('regs.gpp', 'Must be a non-empty GPP string when present.');
      }

      /* gdpr is a non-standard ext in OpenRTB 2.6; it lives under regs.ext. */
      if (request.regs.gdpr !== undefined) {
        warn(
            'regs.gdpr',
            'Not an OpenRTB 2.6 field; the standard location is regs.ext.gdpr.',
        );
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Restrictions                                                           */
  /* ---------------------------------------------------------------------- */

  for (const field of ['badv', 'bcat', 'bapp']) {
    const value = request[field];

    if (value === undefined) continue;

    if (!Array.isArray(value)) {
      error(field, 'Must be an array when present.');
      continue;
    }

    if (value.length === 0) {
      warn(field, 'Empty array carries no information; omit it instead.');
    }

    if (!value.every(isNonEmptyString)) {
      error(field, 'Every entry must be a non-empty string.');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Test markers                                                           */
  /* ---------------------------------------------------------------------- */

  /*
   * These identify traffic as synthetic. They are useful when you WANT that,
   * but on a live endpoint they are what an IVT filter keys on.
   */
  if (request.test === 1) {
    warn(
        'test',
        'test=1 marks the auction non-billable; many exchanges ignore or filter it.',
    );
  }

  if (isPlainObject(request.ext) && request.ext.qa !== undefined) {
    warn('ext.qa', 'Marks the request as synthetic QA traffic.');
  }

  if (isPlainObject(request.device) && isPlainObject(request.device.ext) && request.device.ext.qa !== undefined) {
    warn('device.ext.qa', 'Marks the device as synthetic QA traffic.');
  }

  const stats = {
    impressions: Array.isArray(request.imp) ? request.imp.length : 0,
    mediaTypes: Array.isArray(request.imp)
        ? request.imp
            .filter(isPlainObject)
            .flatMap((imp) => ['banner', 'video', 'audio', 'native'].filter((k) => imp[k] !== undefined))
        : [],
    hasApp: hasApp,
    hasSite: hasSite,
    hasSchain: isPlainObject(request.source) &&
        isPlainObject(request.source.ext) &&
        request.source.ext.schain !== undefined,
    isTest: request.test === 1,
    deviceModel: isPlainObject(request.device) ? request.device.model : undefined,
    geoLevel: isPlainObject(request.device) && isPlainObject(request.device.geo)
        ? (
            request.device.geo.city
                ? 'city'
                : (request.device.geo.region ? 'region' : 'country')
        )
        : 'none',
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

/* -------------------------------------------------------------------------- */
/* Banner                                                                     */
/* -------------------------------------------------------------------------- */

function validateBanner(banner, path, error, warn) {
  if (!isPlainObject(banner)) {
    error(path, 'Must be an object.');
    return;
  }

  if (banner.w !== undefined && !isPositiveInt(banner.w)) {
    error(`${path}.w`, 'Must be a positive integer.');
  }

  if (banner.h !== undefined && !isPositiveInt(banner.h)) {
    error(`${path}.h`, 'Must be a positive integer.');
  }

  if (!Array.isArray(banner.mimes) || banner.mimes.length === 0) {
    warn(`${path}.mimes`, 'Missing/empty; most exchanges require at least one mime type.');
  } else if (!banner.mimes.every(isNonEmptyString)) {
    error(`${path}.mimes`, 'Every mime must be a non-empty string.');
  }

  if (banner.format !== undefined) {
    if (!Array.isArray(banner.format) || banner.format.length === 0) {
      error(`${path}.format`, 'Must be a non-empty array when present.');
    } else {
      banner.format.forEach((f, i) => {
        if (!isPlainObject(f) || !isPositiveInt(f.w) || !isPositiveInt(f.h)) {
          error(`${path}.format[${i}]`, 'Must be an object with positive integer w and h.');
        }
      });

      /*
       * A single-entry format[] duplicating w/h adds nothing and can
       * confuse responders.
       */
      if (
          banner.format.length === 1 &&
          banner.format[0]?.w === banner.w &&
          banner.format[0]?.h === banner.h
      ) {
        warn(
            `${path}.format`,
            'Single entry duplicating w/h; redundant. Omit format[] unless offering several sizes.',
        );
      }
    }
  }

  if (banner.api !== undefined) {
    if (!Array.isArray(banner.api) || banner.api.length === 0) {
      error(`${path}.api`, 'Must be a non-empty array when present.');
    } else {
      const bad = banner.api.filter((v) => !API_FRAMEWORKS.has(v));

      if (bad.length > 0) {
        error(`${path}.api`, `Unknown framework value(s): ${bad.join(', ')} (valid 1-7).`);
      }
    }
  }

  validateBattr(banner.battr, `${path}.battr`, error, warn);
  validateBattr(banner.btype, `${path}.btype`, error, warn);

  if (banner.btype !== undefined && banner.btype.length === 0) {
    warn(`${path}.btype`, 'Empty array carries no information; omit it instead.');
  }
}

function validateBattr(list, path, error, warn) {
  if (list === undefined) return;

  if (!Array.isArray(list) || list.length === 0) {
    error(path, 'Must be a non-empty array when present.');
    return;
  }

  const bad = list.filter((v) => !CREATIVE_ATTRIBUTES.has(v));

  if (bad.length > 0) {
    error(path, `Unknown attribute value(s): ${bad.join(', ')} (valid 1-17).`);
    return;
  }

  for (const value of list) {
    const reason = AGGRESSIVE_BATTR.get(value);

    if (reason) {
      warn(path, `battr ${value}: ${reason}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Device                                                                     */
/* -------------------------------------------------------------------------- */

function validateDevice(device, error, warn) {
  const hasIp = isNonEmptyString(device.ip);
  const hasIpv6 = isNonEmptyString(device.ipv6);

  if (!hasIp && !hasIpv6) {
    warn(
        'device.ip',
        'Neither ip nor ipv6 present. Most exchanges geolocate from device.ip; without it geo must be supplied and trust is lower.',
    );
  }

  if (hasIp && !IPV4.test(device.ip)) {
    error('device.ip', `Not a valid IPv4 address: "${device.ip}".`);
  }

  if (hasIpv6 && !IPV6.test(device.ipv6)) {
    warn('device.ipv6', `Does not look like a valid IPv6 address: "${device.ipv6}".`);
  }

  if (!isNonEmptyString(device.ua)) {
    warn('device.ua', 'Missing user agent; browsers/apps normally send one.');
  }

  if (device.osv !== undefined && !isNonEmptyString(String(device.osv))) {
    error('device.osv', 'Must be a non-empty string.');
  }

  if (device.os !== undefined && !isNonEmptyString(device.os)) {
    error('device.os', 'Must be a non-empty string.');
  }

  /*
   * device.os casing is NOT enforced.
   *
   * OpenRTB documents "Android", but every request in this exchange's real
   * traffic sends lowercase "android". Matching the inventory beats matching
   * the document here, so no warning either way.
   */

  if (device.devicetype !== undefined && !DEVICE_TYPES.has(device.devicetype)) {
    error('device.devicetype', `Unknown device type ${device.devicetype} (valid 1-8; 4 = phone).`);
  }

  if (device.connectiontype !== undefined && !CONNECTION_TYPES.has(device.connectiontype)) {
    error('device.connectiontype', `Unknown connection type ${device.connectiontype} (valid 0-6).`);
  }

  /* ---------------------------------------------------------------------- */
  /* mccmnc / carrier coherence                                             */
  /* ---------------------------------------------------------------------- */

  if (device.mccmnc !== undefined) {
    if (!MCCMNC.test(String(device.mccmnc))) {
      error(
          'device.mccmnc',
          `Must be "MCC-MNC" with a dash (e.g. 310-260), got "${device.mccmnc}".`,
      );
    }

    if (!isNonEmptyString(device.carrier)) {
      warn('device.carrier', 'mccmnc present without carrier; the two normally travel together.');
    }
  }

  if (
      isNonEmptyString(device.carrier) &&
      /comcast|xfinity|charter|spectrum|cox|frontier|centurylink|lumen|optimum|altice|fios|u-?verse/i
          .test(device.carrier)
  ) {
    /*
     * Naming a fixed-line ISP as the carrier is correct for a residential
     * IP. It only becomes a contradiction when mobile-only signals are
     * attached to it.
     */
    if (device.mccmnc !== undefined) {
      error(
          'device.mccmnc',
          `mccmnc on a fixed-line ISP carrier "${device.carrier}". There is no truthful mobile network code for residential broadband.`,
      );
    }

    if (device.connectiontype !== undefined && device.connectiontype >= 3) {
      error(
          'device.connectiontype',
          `Cellular connectiontype (${device.connectiontype}) on a fixed-line ISP carrier "${device.carrier}".`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Identifiers                                                            */
  /* ---------------------------------------------------------------------- */

  if (device.ifa !== undefined) {
    if (!isNonEmptyString(device.ifa)) {
      error('device.ifa', 'Must be a non-empty string (clear text, not hashed).');
    } else if (!UUID.test(device.ifa)) {
      warn(
          'device.ifa',
          `Not a valid UUID (v1-v5): "${device.ifa}". Android AAID is a lowercase UUID; synthetic IFAs should use UUIDv4/v5.`,
      );
    } else if (/[A-F]/.test(device.ifa) && /android/i.test(String(device.os))) {
      warn('device.ifa', 'Uppercase letters in an Android AAID; Android advertising IDs are lowercase.');
    }
  }

  if (device.dpidsha1 !== undefined && !SHA1_HEX.test(String(device.dpidsha1))) {
    error('device.dpidsha1', 'Must be a 40-char hex SHA-1 hash.');
  }

  if (device.dpidmd5 !== undefined && !MD5_HEX.test(String(device.dpidmd5))) {
    error('device.dpidmd5', 'Must be a 32-char hex MD5 hash.');
  }

  if (
      device.dpidsha1 !== undefined &&
      device.ifa !== undefined &&
      device.dpidsha1 !== undefined
  ) {
    /*
     * dpid* are hashes of the platform device ID, NOT of the IFA. Hashing
     * the IFA into them is a common and detectable mistake.
     */
    warn(
        'device.dpidsha1',
        'Ensure dpidsha1/dpidmd5 hash the platform device ID (Android ID), not the IFA.',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Geo coherence                                                          */
  /* ---------------------------------------------------------------------- */

  if (device.geo !== undefined) {
    validateGeo(device.geo, 'device.geo', error, warn, device);
  }

  if (
      device.w !== undefined &&
      (!isPositiveInt(device.w))
  ) {
    error('device.w', 'Must be a positive integer.');
  }

  if (
      device.h !== undefined &&
      (!isPositiveInt(device.h))
  ) {
    error('device.h', 'Must be a positive integer.');
  }
}

function validateGeo(geo, path, error, warn, device) {
  if (!isPlainObject(geo)) {
    error(path, 'Must be an object.');
    return;
  }

  /*
   * Cross-check the claimed geo against the IP it is attached to.
   *
   * This is the single most valuable geo check available: the exchange
   * geolocates device.ip independently, so a city/region that the IP does
   * not resolve to is an immediate mismatch signal. Only runs when the
   * GeoLite2 database is loaded.
   */
  if (isPlainObject(device) && typeof device.ip === 'string') {
    const truth = getGeoDetail(device.ip);

    if (truth) {
      if (
          isNonEmptyString(geo.country) &&
          truth.countryAlpha3 &&
          geo.country !== truth.countryAlpha3
      ) {
        error(
            `${path}.country`,
            `Claims ${geo.country} but ${device.ip} geolocates to ${truth.countryAlpha3}` +
            `${truth.city ? ` (${truth.city})` : ''}. The exchange sees the IP.`,
        );
      }

      if (
          isNonEmptyString(geo.city) &&
          truth.city &&
          geo.city.toLowerCase() !== truth.city.toLowerCase()
      ) {
        error(
            `${path}.city`,
            `Claims "${geo.city}" but ${device.ip} geolocates to "${truth.city}"` +
            `${truth.region ? `, ${truth.region}` : ''}.`,
        );
      }

      if (
          isNonEmptyString(geo.region) &&
          truth.region &&
          geo.region.toUpperCase() !== truth.region.toUpperCase()
      ) {
        error(
            `${path}.region`,
            `Claims "${geo.region}" but ${device.ip} geolocates to "${truth.region}".`,
        );
      }

      if (
          typeof geo.lat === 'number' &&
          typeof geo.lon === 'number' &&
          typeof truth.lat === 'number' &&
          typeof truth.lon === 'number'
      ) {
        /*
         * ~1 degree is roughly 111km. GeoLite2's own accuracy radius is
         * often 20-100km, so allow a generous 1.5 degrees before calling a
         * coordinate disagreeing rather than merely imprecise.
         */
        const distance = Math.max(
            Math.abs(geo.lat - truth.lat),
            Math.abs(geo.lon - truth.lon),
        );

        if (distance > 1.5) {
          warn(
              `${path}.lat`,
              `Coordinates are ~${Math.round(distance * 111)}km from where ${device.ip} ` +
              `geolocates (${truth.lat}, ${truth.lon}).`,
          );
        }
      }
    }
  }

  if (geo.lat !== undefined) {
    if (typeof geo.lat !== 'number' || !Number.isFinite(geo.lat) || geo.lat < -90 || geo.lat > 90) {
      error(`${path}.lat`, `Must be a number in [-90, 90], got ${JSON.stringify(geo.lat)}.`);
    }
  }

  if (geo.lon !== undefined) {
    if (typeof geo.lon !== 'number' || !Number.isFinite(geo.lon) || geo.lon < -180 || geo.lon > 180) {
      error(`${path}.lon`, `Must be a number in [-180, 180], got ${JSON.stringify(geo.lon)}.`);
    }
  }

  if ((geo.lat === undefined) !== (geo.lon === undefined)) {
    error(path, 'lat and lon must be supplied together.');
  }

  /*
   * Coordinates without a city, or coordinates in a country the city is not
   * in, are the classic "geo says one thing, IP says another" mismatch.
   */
  if (geo.lat !== undefined && !isNonEmptyString(geo.city)) {
    warn(
        `${path}.lat`,
        'Precise coordinates without a city; a lat/lon that disagrees with the IP-derived geo is a strong mismatch signal.',
    );
  }

  if (geo.country !== undefined && !isNonEmptyString(geo.country)) {
    error(`${path}.country`, 'Must be a non-empty string.');
  }

  if (
      isNonEmptyString(geo.country) &&
      geo.country.length === 2
  ) {
    warn(
        `${path}.country`,
        `"${geo.country}" is ISO-3166 alpha-2. OpenRTB specifies alpha-3 (e.g. "USA"). Some exchanges accept both.`,
    );
  }

  if (geo.type !== undefined && ![1, 2, 3].includes(geo.type)) {
    error(`${path}.type`, 'Must be 1 (GPS), 2 (IP) or 3 (user-provided).');
  }

  if (geo.metro !== undefined && !isNonEmptyString(String(geo.metro))) {
    error(`${path}.metro`, 'Must be a non-empty string (Nielsen DMA).');
  }

  if (geo.zip !== undefined && !/^\d{5}(-\d{4})?$/.test(String(geo.zip))) {
    warn(`${path}.zip`, `"${geo.zip}" does not look like a US ZIP code.`);
  }
}

/* -------------------------------------------------------------------------- */
/* SupplyChain                                                               */
/* -------------------------------------------------------------------------- */

function validateSchain(schain, error, warn, base = 'source.ext.schain') {
  if (!isPlainObject(schain)) {
    error(base, 'Must be an object.');
    return;
  }

  if (!isNonEmptyString(schain.ver)) {
    error(`${base}.ver`, 'Required: supply chain version ("1.0").');
  }

  if (schain.complete !== undefined && schain.complete !== 0 && schain.complete !== 1) {
    error(`${base}.complete`, 'Must be 0 or 1.');
  }

  if (!Array.isArray(schain.nodes) || schain.nodes.length === 0) {
    error(`${base}.nodes`, 'Required: non-empty array of nodes.');
    return;
  }

  schain.nodes.forEach((node, index) => {
    const path = `${base}.nodes[${index}]`;

    if (!isPlainObject(node)) {
      error(path, 'Must be an object.');
      return;
    }

    if (!isNonEmptyString(node.asi)) {
      error(`${path}.asi`, 'Required: canonical domain of the advertising system.');
    }

    if (!isNonEmptyString(node.sid)) {
      error(`${path}.sid`, 'Required: seller/publisher account ID.');
    }

    if (node.hp !== undefined && node.hp !== 0 && node.hp !== 1) {
      error(`${path}.hp`, 'Must be 0 or 1 when present.');
    }

    if (node.asi && /^https?:\/\//i.test(String(node.asi))) {
      warn(`${path}.asi`, 'Should be a bare domain (e.g. "ssp.example"), not a full URL.');
    }
  });

  /* The first node is the direct seller and should be the payment entity. */
  if (schain.nodes.length > 1 && schain.nodes[0]?.hp !== 1) {
    warn(
        `${base}.nodes[0].hp`,
        'The first node usually has hp=1 (it is the direct seller / payment entity).',
    );
  }
}

/**
 * Format a validation result for a terminal.
 */
export function formatValidation(result, { color = false } = {}) {
  const lines = [];

  const paint = (code, text) =>
      color ? `\u001b[${code}m${text}\u001b[0m` : text;

  const red = (t) => paint('31', t);
  const yellow = (t) => paint('33', t);
  const green = (t) => paint('32', t);
  const dim = (t) => paint('2', t);

  if (result.errors.length > 0) {
    lines.push(red(`ERRORS (${result.errors.length})`));

    for (const { path, message } of result.errors) {
      lines.push(red(`  ✗ ${path || '<root>'}`) + `  ${message}`);
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('');

    lines.push(yellow(`WARNINGS (${result.warnings.length})`));

    for (const { path, message } of result.warnings) {
      lines.push(yellow(`  ! ${path || '<root>'}`) + `  ${message}`);
    }
  }

  if (lines.length > 0) lines.push('');

  lines.push(
      result.valid
          ? green(`VALID OpenRTB 2.6 request${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}`)
          : red('INVALID request — fix the errors above'),
  );

  if (result.stats && Object.keys(result.stats).length > 0) {
    lines.push(dim(
        `  media=${JSON.stringify(result.stats.mediaTypes)} ` +
        `geo=${result.stats.geoLevel} ` +
        `model=${result.stats.deviceModel ?? '-'} ` +
        `schain=${result.stats.hasSchain ? 'yes' : 'no'} ` +
        `test=${result.stats.isTest ? '1' : '0'}`,
    ));
  }

  return lines.join('\n');
}
