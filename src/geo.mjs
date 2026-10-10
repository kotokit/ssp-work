/**
 * GeoIP lookup backed by a real MaxMind GeoLite2-City database.
 *
 * This is the ONLY source of device.geo when the database is available: the
 * geo must describe the IP actually in device.ip, because that is what the
 * exchange geolocates. Deriving geo from a CIDR block guess (which is what
 * the pool's metro token does) produces cities the IP does not resolve to.
 *
 * Fixes over the previous version of this file, which never ran:
 *   - ESM instead of require() in a .mjs (was a TypeError)
 *   - the real database path instead of '/path/to/GeoLite2-City.mmdb'
 *   - lazy, cached lookups instead of an eager init that threw at import
 *   - graceful degradation: a missing database disables geo rather than
 *     breaking every request
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import maxmind from 'maxmind';
import countries from 'i18n-iso-countries';

import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

countries.registerLocale(en);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** OpenRTB spells country as ISO-3166 alpha-3 ("USA"), the DB gives alpha-2. */
function alpha3(code) {
  if (!code) return undefined;

  return countries.alpha2ToAlpha3(String(code).toUpperCase()) ?? code;
}

const reader = {
  instance: null,
  path: null,
  error: null,
  loaded: false,
};

/*
 * Lookups are pure functions of the IP, and the pool is small (thousands of
 * addresses reused across a run), so caching removes the per-request cost
 * entirely. Bounded so a long run cannot grow without limit.
 */
const cache = new Map();
const CACHE_LIMIT = 10_000;

/**
 * Resolve the database path: explicit option, then env, then data/.
 */
function resolveDbPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.GEOIP_DB,
    join(ROOT, 'data/GeoLite2-City.mmdb'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Load the database. Safe to call repeatedly; only the first call does work.
 *
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function initGeoIP({ path } = {}) {
  if (reader.loaded) {
    return reader.instance
        ? { ok: true, path: reader.path }
        : { ok: false, error: reader.error };
  }

  reader.loaded = true;

  const dbPath = resolveDbPath(path);

  if (!dbPath) {
    reader.error =
      'No GeoLite2-City.mmdb found. Put it at data/GeoLite2-City.mmdb ' +
      'or set GEOIP_DB. Geo lookups are disabled and device.geo is omitted.';

    return { ok: false, error: reader.error };
  }

  try {
    reader.instance = await maxmind.open(dbPath);
    reader.path = dbPath;

    return { ok: true, path: dbPath };
  } catch (error) {
    reader.error = `Failed to open ${dbPath}: ${String(error?.message ?? error)}`;

    return { ok: false, error: reader.error };
  }
}

/**
 * Whether a usable database is loaded.
 */
export function geoAvailable() {
  return reader.instance !== null;
}

/**
 * Path of the loaded database, if any.
 */
export function geoPath() {
  return reader.path;
}

/**
 * Look up an IP.
 *
 * Returns a geo object when the database has a record for the IP, else null.
 * Shape matches what this project already used:
 *
 *   { country, type, lat, lon, region, city, metro, zip }
 *
 * `country` is ISO-3166 alpha-3 because OpenRTB specifies alpha-3 ("USA").
 * `accuracy_radius` is deliberately NOT included: it is not an OpenRTB field,
 * so it would be a non-standard key inside device.geo. Use getGeoDetail()
 * when you want it.
 */
export function getGeo(ip) {
  if (!reader.instance || typeof ip !== 'string' || !ip.trim()) {
    return null;
  }

  const key = ip.trim();

  if (cache.has(key)) {
    return cache.get(key);
  }

  let result = null;

  try {
    const record = reader.instance.get(key);

    if (record) {
      const location = record.location ?? {};

      const geo = {
        type: 2,
        country: alpha3(record.country?.iso_code),
      };

      if (typeof location.latitude === 'number') {
        geo.lat = Number(location.latitude.toFixed(4));
      }

      if (typeof location.longitude === 'number') {
        geo.lon = Number(location.longitude.toFixed(4));
      }

      const region = record.subdivisions?.[0]?.iso_code;

      if (region) {
        geo.region = region;
      }

      const city = record.city?.names?.en;

      if (city) {
        geo.city = city;
      }

      if (location.metro_code != null) {
        geo.metro = String(location.metro_code);
      }

      if (record.postal?.code) {
        geo.zip = record.postal.code;
      }

      result = Object.fromEntries(
          Object.entries(geo).filter(([, value]) => value != null),
      );
    }
  } catch {
    /* A malformed address must not fail the request. */
    result = null;
  }

  if (cache.size >= CACHE_LIMIT) {
    cache.clear();
  }

  cache.set(key, result);

  return result;
}

/**
 * Full record, for preflight/reporting rather than the request body.
 */
export function getGeoDetail(ip) {
  if (!reader.instance || typeof ip !== 'string' || !ip.trim()) {
    return null;
  }

  try {
    const record = reader.instance.get(ip.trim());

    if (!record) return null;

    const location = record.location ?? {};

    return {
      country: record.country?.iso_code,
      countryAlpha3: alpha3(record.country?.iso_code),
      region: record.subdivisions?.[0]?.iso_code,
      city: record.city?.names?.en,
      metro: location.metro_code != null ? String(location.metro_code) : undefined,
      zip: record.postal?.code,
      lat: location.latitude,
      lon: location.longitude,
      accuracyRadiusKm: location.accuracy_radius,
      timezone: location.time_zone,
    };
  } catch {
    return null;
  }
}

/**
 * Look up many IPs and summarise coverage. Used to validate the pool.
 */
export function auditIps(ips) {
  const found = [];
  const missing = [];
  const countries = new Map();
  const cities = new Map();

  for (const ip of ips) {
    const detail = getGeoDetail(ip);

    if (detail) {
      found.push(ip);

      const code = detail.country ?? '??';
      countries.set(code, (countries.get(code) ?? 0) + 1);

      if (detail.city) {
        cities.set(detail.city, (cities.get(detail.city) ?? 0) + 1);
      }
    } else {
      missing.push(ip);
    }
  }

  return {
    total: ips.length,
    found: found.length,
    missing: missing.length,
    countries: Object.fromEntries(
        [...countries.entries()].sort((a, b) => b[1] - a[1]),
    ),
    topCities: Object.fromEntries(
        [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    ),
    missingSamples: missing.slice(0, 10),
  };
}
