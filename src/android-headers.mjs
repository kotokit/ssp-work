/**
 * Android WebView / Chrome header profiles, derived from the user agent.
 *
 * A real in-app impression comes from the ad rendering inside a WebView, so
 * the pixel request carries Chrome-engine fingerprints that must all agree
 * with each other AND with the bid request's device fields. Any disagreement
 * between two of them is the give-away.
 *
 * Everything here is derived from the UA rather than hard-coded, so a request
 * cannot claim Chrome 154 in the UA and Chrome 120 in the client hints.
 *
 * What is built and why:
 *
 *   user-agent        passed through unchanged (already the real corpus string)
 *   sec-ch-ua         brands and versions, must include "Android WebView"
 *   sec-ch-ua-mobile  ?1 for a phone
 *   sec-ch-ua-platform "Android"
 *   accept            Chrome's image list, not * / *
 *   sec-fetch-site    cross-site  (the pixel is on the exchange's domain)
 *   sec-fetch-mode    no-cors
 *   sec-fetch-dest    image
 *   accept-encoding   gzip, deflate, br, zstd (zstd only on recent Chrome)
 *   accept-language   from the device language
 *
 * Header ORDER is preserved: we return an array of [name, value] pairs and
 * callers send them in that order, because browsers emit a stable order and
 * some fingerprinting checks read it.
 *
 * Limitation worth stating plainly: this controls HTTP headers only. TLS
 * ClientHello fingerprints (JA3/JA4) come from the TLS stack, not from us, so
 * a script cannot fully match a real WebView's handshake. Tests that need that
 * property must drive a real browser instead.
 */

/**
 * Parse the Chrome major version out of a WebView UA.
 *
 * Real shapes:
 *   ... Version/4.0 Chrome/154.0.8037.98 Mobile Safari/537.36
 *   ... Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36
 */
export function parseChromeMajor(ua) {
  const match = String(ua ?? '').match(/\bChrome\/(\d+)/i);

  return match ? Number(match[1]) : null;
}

/**
 * Parse the Android version out of a UA.
 *
 * Newer Android shortens the UA to "Android 10; K", so a real model is not
 * always present — that is normal, not suspicious.
 */
export function parseAndroidVersion(ua) {
  const match = String(ua ?? '').match(/Android\s+([\d.]+)/i);

  return match ? match[1] : null;
}

/** Android version as an integer, for "is this recent" checks. */
export function androidMajor(ua) {
  const version = parseAndroidVersion(ua);

  return version ? Number.parseInt(version, 10) : null;
}

/** True when the UA advertises a WebView. */
export function isWebView(ua) {
  return /;\s*wv\)/.test(String(ua ?? '')) || /\bwv\b/.test(String(ua ?? ''));
}

/**
 * Build the sec-ch-ua brand list for a Chromium version.
 *
 * A WebView never advertises "Google Chrome". It advertises
 * "Android WebView" (from Chrome 116, when the app keeps the default UA),
 * so pairing a `wv` UA with a "Google Chrome" brand is a contradiction.
 *
 * The GREASE brand (the "Not A(Brand" entry) is intentionally irregular —
 * that is what Chromium does, and it changes per version.
 */
export function buildBrandList(major, { webview = true } = {}) {
  if (!major) return null;

  /*
   * GREASE brand text and its version follow Chromium's own rotation.
   */
  const grease =
      major >= 150
          ? '"Not A(Brand";v="99"'
          : '"Not.A/Brand";v="8"';

  const brands = [
    `"Chromium";v="${major}"`,
    webview
        ? `"Android WebView";v="${major}"`
        : `"Google Chrome";v="${major}"`,
  ];

  return [...brands, grease].join(', ');
}

/**
 * Chrome's Accept header for an image subresource.
 *
 * The exact list matters: `* / *` here is a script tell, because a real
 * image load from Chrome sends this specific list.
 */
export const IMAGE_ACCEPT =
    'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

/**
 * Accept-Encoding as Chrome sends it.
 *
 * zstd was added in Chrome 123. Sending zstd from an older UA is a mismatch,
 * and omitting it from a newer one is a weaker but real one.
 */
export function acceptEncodingFor(major) {
  if (major === null) return 'gzip, deflate, br';

  return major >= 123
      ? 'gzip, deflate, br, zstd'
      : 'gzip, deflate, br';
}

/**
 * Build the full header set for an impression (image pixel) request.
 *
 * @param {object} options
 * @param {string} options.ua            the device user agent
 * @param {string} [options.language]    device language, e.g. 'en-US'
 * @param {string} [options.referer]     the page that hosts the ad
 * @param {number} [options.major]       override Chrome major (else parsed)
 * @returns {{headers: [string, string][], profile: object}}
 */
export function buildImpressionHeaders({
  ua,
  language = 'en-US',
  referer,
  major,
} = {}) {
  const chromeMajor = major ?? parseChromeMajor(ua);
  const webview = isWebView(ua);

  /*
   * Order mirrors what Chrome emits for an image request. Pseudo-headers
   * (:method, :authority, :scheme, :path) are added by the HTTP/2 layer, not
   * here.
   */
  const headers = [];

  if (chromeMajor) {
    headers.push(['sec-ch-ua', buildBrandList(chromeMajor, { webview })]);
    headers.push(['sec-ch-ua-mobile', '?1']);
    headers.push(['sec-ch-ua-platform', '"Android"']);
  }

  headers.push(['user-agent', ua]);
  headers.push(['accept', IMAGE_ACCEPT]);

  if (referer) {
    headers.push(['referer', referer]);
  }

  headers.push(['sec-fetch-site', 'cross-site']);
  headers.push(['sec-fetch-mode', 'no-cors']);
  headers.push(['sec-fetch-dest', 'image']);
  headers.push(['accept-encoding', acceptEncodingFor(chromeMajor)]);
  headers.push(['accept-language', language]);

  return {
    headers,
    profile: {
      chromeMajor,
      android: parseAndroidVersion(ua),
      webview,
      brands: chromeMajor ? buildBrandList(chromeMajor, { webview }) : null,
    },
  };
}

/**
 * Audit a header set for internal contradictions.
 *
 * This is the same logic a detector uses, exposed here so the generator can
 * refuse to emit an incoherent request and the harness can label one.
 *
 * @returns {{ok: boolean, issues: {field: string, message: string}[]}}
 */
export function auditHeaders(headers, { ua } = {}) {
  const issues = [];

  const get = (name) => {
    if (Array.isArray(headers)) {
      const found = headers.find(([k]) => k.toLowerCase() === name);

      return found ? found[1] : undefined;
    }

    if (headers && typeof headers === 'object') {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);

      return key ? headers[key] : undefined;
    }

    return undefined;
  };

  const userAgent = ua ?? get('user-agent');
  const brands = get('sec-ch-ua');
  const platform = get('sec-ch-ua-platform');
  const mobile = get('sec-ch-ua-mobile');
  const accept = get('accept');
  const encoding = get('accept-encoding');

  const uaMajor = parseChromeMajor(userAgent);
  const uaWebView = isWebView(userAgent);
  const uaAndroid = /android/i.test(String(userAgent ?? ''));

  /* --- brand vs UA ------------------------------------------------------ */

  const brandMajor = brands
      ? Number((String(brands).match(/v="(\d+)"/) ?? [])[1])
      : null;

  if (brands && !uaMajor) {
    issues.push({
      field: 'sec-ch-ua',
      message: 'Client hints present but the user-agent carries no Chrome version.',
    });
  }

  if (brands && uaMajor && brandMajor && brandMajor !== uaMajor) {
    issues.push({
      field: 'sec-ch-ua',
      message: `Brand version ${brandMajor} disagrees with the UA's Chrome ${uaMajor}.`,
    });
  }

  if (brands && uaWebView && /"Google Chrome"/i.test(brands)) {
    issues.push({
      field: 'sec-ch-ua',
      message:
        'UA says WebView (wv) but the brand list says "Google Chrome". ' +
        'A WebView advertises "Android WebView", never "Google Chrome".',
    });
  }

  if (brands && !uaWebView && /"Android WebView"/i.test(brands)) {
    issues.push({
      field: 'sec-ch-ua',
      message: 'Brand list says Android WebView but the UA has no wv token.',
    });
  }

  /* --- platform / mobile vs UA ----------------------------------------- */

  if (platform && uaAndroid && !/"Android"/i.test(platform)) {
    issues.push({
      field: 'sec-ch-ua-platform',
      message:
        `Platform ${platform} contradicts an Android user-agent. ` +
        'This is the classic --user-agent-only spoof.',
    });
  }

  if (mobile && uaAndroid && mobile !== '?1') {
    issues.push({
      field: 'sec-ch-ua-mobile',
      message: `Mobile hint ${mobile} contradicts an Android phone user-agent.`,
    });
  }

  /* --- accept / encoding ------------------------------------------------ */

  if (accept === '*/*') {
    issues.push({
      field: 'accept',
      message:
        'accept: */* for an image pixel. A real WebView sends Chrome\'s ' +
        'image list (image/avif,image/webp,...).',
    });
  }

  if (encoding && uaMajor && uaMajor >= 123 && !/zstd/i.test(encoding)) {
    issues.push({
      field: 'accept-encoding',
      message: `Chrome ${uaMajor} sends zstd, but accept-encoding is "${encoding}".`,
    });
  }

  if (encoding && uaMajor && uaMajor < 123 && /zstd/i.test(encoding)) {
    issues.push({
      field: 'accept-encoding',
      message: `Chrome ${uaMajor} predates zstd, but accept-encoding advertises it.`,
    });
  }

  /* --- client hints absent ---------------------------------------------- */

  /*
   * WebView has sent client hints by default since Chrome 116. A modern
   * Chrome/WebView UA with NO sec-ch-ua at all is the signature of a plain
   * scripted client (fetch/curl) rather than a browser.
   *
   * Caveat: an app that sets a custom user agent string can suppress hints,
   * so this is a weaker signal than a direct contradiction. It is still
   * worth raising, because "modern Chrome UA + zero hints" is far more often
   * a script than a misconfigured app.
   */
  if (!brands && uaMajor && uaMajor >= 116) {
    issues.push({
      field: 'sec-ch-ua',
      message:
        `No client hints, but the user-agent claims Chrome ${uaMajor}. ` +
        'WebView has sent sec-ch-ua by default since Chrome 116; its absence ' +
        'is the signature of a scripted client.',
    });
  }

  /* --- fetch metadata --------------------------------------------------- */

  if (!get('sec-fetch-dest')) {
    issues.push({
      field: 'sec-fetch-dest',
      message: 'Missing. A real subresource request always carries it.',
    });
  }

  return { ok: issues.length === 0, issues };
}
