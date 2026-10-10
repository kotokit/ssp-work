/**
 * US metro / region table.
 *
 * This is the single place that translates an IP-pool metro token into a
 * coherent OpenRTB Geo object.
 *
 * Metro tokens in data/ip_pool.json look like:
 *
 *   US/Dallas               -> city-level
 *   US/IN West Lafayette    -> "state + city" form
 *   US/NewJersey            -> city-level (Newark, NJ)
 *   US/Northeast            -> REGION level, not a city
 *   US/national             -> REGION level, not a city
 *   US/mobile               -> carrier-grade mobile pool
 *
 * Coherence rules enforced here:
 *
 *   - A city is only emitted when the token actually identifies a city.
 *     "US/national" is not a city: claiming a city for it would contradict
 *     the IP's real geo and is a classic mismatch signal.
 *   - lat/lon are only emitted alongside a city, so the coordinates can
 *     never contradict the city/region pair.
 *   - zip is only emitted where a representative ZIP is meaningful.
 *   - metro (Nielsen DMA) is emitted at region level too, because a DMA is
 *     a region concept and stays true even without a city.
 */

/**
 * City-level metros, keyed by the normalized pool token.
 *
 * normalized token = token without the "US/" prefix and without spaces,
 * lowercased. So "US/IN West Lafayette" -> "inwestlafayette".
 */
export const CITY_METROS = {
  boston: {
    city: 'Boston',
    region: 'MA',
    zip: '02108',
    dma: '506',
    lat: 42.3601,
    lon: -71.0589,
  },

  newyork: {
    city: 'New York',
    region: 'NY',
    zip: '10001',
    dma: '501',
    lat: 40.7128,
    lon: -74.006,
  },

  newjersey: {
    city: 'Newark',
    region: 'NJ',
    zip: '07102',
    dma: '501',
    lat: 40.7357,
    lon: -74.1724,
  },

  dallas: {
    city: 'Dallas',
    region: 'TX',
    zip: '75201',
    dma: '623',
    lat: 32.7767,
    lon: -96.797,
  },

  phoenix: {
    city: 'Phoenix',
    region: 'AZ',
    zip: '85004',
    dma: '753',
    lat: 33.4484,
    lon: -112.074,
  },

  inwestlafayette: {
    city: 'West Lafayette',
    region: 'IN',
    zip: '47906',
    dma: '582',
    lat: 40.4259,
    lon: -86.9081,
  },
};

/**
 * Region-level tokens: no single city is truthful for these.
 *
 * The residential pool is mostly ISPs with nationwide or multi-state
 * footprints, so this is the common case, not the exception.
 */
export const REGION_METROS = {
  northeast: {
    region: 'NY',
    dma: '501',
  },

  national: {
    region: 'US',
  },

  mobile: {
    region: 'US',
  },
};

/**
 * Normalize an IP-pool metro token into a lookup key.
 *
 *   "US/Dallas"            -> "dallas"
 *   "US/IN West Lafayette" -> "inwestlafayette"
 *   "US/NewYork"           -> "newyork"
 */
export function normalizeMetro(metro) {
  if (typeof metro !== 'string') {
    return '';
  }

  return metro
      .trim()
      .replace(/^US\//i, '')
      .replace(/[\s_-]+/g, '')
      .toLowerCase();
}

/**
 * Resolve a pool metro token to geo facts.
 *
 * Returns null for an unknown token. Callers decide the fallback; this
 * function never silently substitutes an unrelated city, because a wrong
 * city is worse than no city.
 */
export function resolveMetro(metro) {
  const key = normalizeMetro(metro);

  if (!key) {
    return null;
  }

  const city = CITY_METROS[key];

  if (city) {
    return { kind: 'city', ...city };
  }

  const region = REGION_METROS[key];

  if (region) {
    return { kind: 'region', ...region };
  }

  return null;
}
