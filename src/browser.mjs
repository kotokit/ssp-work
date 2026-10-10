/**
 * Headless-browser pixel firing.
 *
 * WHY: an impression pixel is a subresource request made by the ad rendering
 * inside a WebView. Its TLS ClientHello and HTTP/2 fingerprint come from the
 * browser engine, not from the headers we set — a Node HTTP client cannot
 * imitate that. Node's handshake is Node's, no matter how coherent the
 * headers are. Driving a real Chromium closes that gap for real.
 *
 * HOW IT WORKS
 *
 *   1. One long-lived Chromium is started with `--remote-debugging-port`.
 *      Launching a browser per request is far too slow, so it is reused.
 *   2. Each run gets a browser CONTEXT configured with the residential proxy,
 *      so Chromium dials the proxy itself and the pixel leaves from the
 *      pinned session IP — same IP as the auction.
 *   3. The creative markup (adm) is rendered in the page. Chromium then
 *      fetches the pixel as a real image subresource, producing genuine
 *      TLS + HTTP/2 + `sec-fetch-dest: image` + a real Referer.
 *   4. We capture the request/response over CDP to confirm it fired and to
 *      record exactly what Chromium sent — which is the ground truth we
 *      cannot obtain from Node.
 *
 * LIMITATIONS, STATED PLAINLY
 *
 *   - JA3/JA4 will be **Chromium-on-this-OS**, not Android WebView. Chromium
 *     on Linux differs from Chrome on Android. This is a real browser rather
 *     than an HTTP library, which is a large improvement, but it is not a
 *     byte-identical Android handshake.
 *   - Chromium runs only in headless mode here. Headless Chromium's TLS stack
 *     is the same as headed (TLS is not affected by headless), but rendering
 *     differs.
 *   - The pixel fires when the image loads. If the creative is JS that builds
 *     the pixel dynamically, we run the JS too — but a creative that requires
 *     viewability or user interaction will not fire on its own.
 */

import { existsSync, readdirSync } from 'node:fs';

import {
  buildBrandList,
  parseChromeMajor,
} from './android-headers.mjs';

/** Locations to look for a Chromium/Chrome binary, in order of preference. */
const CANDIDATE_BINARIES = [
  process.env.CHROME_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  /* Playwright's own download cache */
  process.env.HOME && `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell`,
  process.env.HOME && `${process.env.HOME}/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  /* System installs */
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

/**
 * Find a usable browser binary.
 *
 * @returns {string|null}
 */
export function findBrowserBinary() {
  for (const candidate of CANDIDATE_BINARIES) {
    if (!candidate.includes('*') && existsSync(candidate)) {
      return candidate;
    }
  }

  /*
   * Glob-expand the Playwright cache paths by hand (no shell available).
   */
  const home = process.env.HOME;

  if (home) {
    const globs = [
      [`${home}/Library/Caches/ms-playwright`, 'headless_shell'],
      [`${home}/.cache/ms-playwright`, 'headless_shell'],
      [`${home}/Library/Caches/ms-playwright`, 'Chromium.app/Contents/MacOS/Chromium'],
      [`${home}/.cache/ms-playwright`, 'chrome-linux/chrome'],
    ];

    for (const [base, suffix] of globs) {
      const found = searchFor(base, suffix, 3);

      if (found) return found;
    }
  }

  return null;
}

/** Shallow directory search for a relative executable path. */
function searchFor(base, suffix, depth) {
  if (depth < 0 || !existsSync(base)) return null;

  let entries;

  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const full = `${base}/${entry.name}`;
    const candidate = `${full}/${suffix}`;

    if (existsSync(candidate)) return candidate;

    const deeper = searchFor(full, suffix, depth - 1);

    if (deeper) return deeper;
  }

  return null;
}

/**
 * A reusable headless browser that fires pixels through a proxy.
 */
export class PixelShooter {
  constructor({ executablePath, headless = true, verbose = false } = {}) {
    this.executablePath = executablePath ?? findBrowserBinary();
    this.headless = headless;
    this.verbose = verbose;
    this.browser = null;
  }

  /**
   * Launch the browser once. Safe to call repeatedly.
   */
  async start() {
    if (this.browser) return;

    if (!this.executablePath) {
      throw new Error(
        'No Chromium/Chrome binary found. Install one, or set CHROME_PATH. ' +
        'Playwright users: npx playwright install chromium-headless-shell',
      );
    }

    const { chromium } = await import('playwright-core');

    this.browser = await chromium.launch({
      executablePath: this.executablePath,
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        /* Keep memory down on a server. */
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
      ],
    });

    if (this.verbose) {
      console.error(`browser: ${this.executablePath}`);
    }
  }

  /**
   * Fire the pixel(s) in a creative through a proxied context.
   *
   * @param {object} options
   * @param {string} options.adm          creative markup from bid.adm
   * @param {string} options.ua           device user agent to present
   * @param {string} [options.pixelUrl]   fallback if adm has no markup
   * @param {object} options.proxy        Proxy config. Prefer a LOCAL BRIDGE
   *                                       url (see proxy-bridge.mjs): Chromium
   *                                       is unreliable with an authenticating
   *                                       upstream proxy and can hang rather
   *                                       than report the failure.
   * @param {object} [options.device]     { width, height, pixelRatio, mobile }
   * @param {string} [options.language]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ok: boolean, status?: number, requests: object[], error?: string}>}
   */
  async firePixel({
    adm,
    ua,
    pixelUrl,
    proxy,
    device = { width: 360, height: 640, pixelRatio: 3, mobile: true },
    language = 'en-US',
    timeoutMs = 20_000,
  }) {
    if (!this.browser) await this.start();

    const context = await this.browser.newContext({
      userAgent: ua,
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: device.pixelRatio ?? 3,
      isMobile: device.mobile !== false,
      hasTouch: device.mobile !== false,
      locale: language,
      ...(proxy ? { proxy } : {}),
    });

    const captured = [];

    try {
      const page = await context.newPage();

      /*
       * CDP interception.
       *
       * Two problems this solves:
       *
       *  1. Playwright's request.headers() returns a REDUCED set — the real
       *     wire headers (sec-fetch-*, accept-encoding) are absent from it.
       *     Network.requestWillBeSentExtraInfo carries what actually went out.
       *
       *  2. Setting a custom UA via Playwright changes the UA but NOT the
       *     client hints: Chrome still advertises its own platform and a
       *     "Google Chrome" brand. That produces a wv UA sitting next to a
       *     Google Chrome brand — precisely the contradiction to avoid.
       *
       * So we intercept the pixel request and rewrite ONLY the sec-ch-ua*
       * hints so they agree with the device UA. The TLS handshake is
       * untouched and remains genuinely Chromium's, as does HTTP/2 and the
       * sec-fetch-* headers Chrome computed itself.
       */
      const cdp = await context.newCDPSession(page);

      await cdp.send('Network.enable');
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });

      const wireHeaders = new Map();

      cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
        wireHeaders.set(event.requestId, event.headers);
      });

      cdp.on('Fetch.requestPaused', (event) => {
        const req = event.request;

        const recorded = {
          url: req.url,
          method: req.method,
          resourceType: event.resourceType,
          headers: wireHeaders.get(event.requestId) ?? req.headers,
        };

        captured.push(recorded);

        const isPixel = /\/t\/imp|pixel|impression|\/imp\?/i.test(req.url);

        if (isPixel) {
          const major = parseChromeMajor(ua);
          const isWv = /;\s*wv\)/.test(String(ua));

          if (major) {
            const overrides = [
              { name: 'sec-ch-ua', value: buildBrandList(major, { webview: isWv }) },
              { name: 'sec-ch-ua-mobile', value: '?1' },
              { name: 'sec-ch-ua-platform', value: '"Android"' },
            ];

            /*
             * continueRequest replaces by name, case-insensitively, so the
             * hint set ends up coherent with the UA.
             */
            cdp.send('Fetch.continueRequest', {
              requestId: event.requestId,
              headers: [
                ...Object.entries(req.headers).map(([name, value]) => ({ name, value: String(value) })),
                ...overrides,
              ],
            }).catch(() => {
              cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
            });

            recorded.hintsRewritten = overrides.map((o) => `${o.name}=${o.value}`);
            return;
          }
        }

        cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      });

      cdp.on('Network.responseReceived', (event) => {
        const entry = captured.find((c) => c.url === event.response.url && c.status === undefined);

        if (entry) entry.status = event.response.status;
      });

      page.on('response', (res) => {
        const entry = captured.find((c) => c.url === res.url() && c.status === undefined);

        if (entry) entry.status = res.status();
      });

      page.on('requestfailed', (req) => {
        const entry = captured.find((c) => c.url === req.url() && c.status === undefined && !c.failure);

        if (entry) entry.failure = req.failure()?.errorText ?? 'failed';
      });

      if (adm && /<(img|iframe|script|div|ins)\b/i.test(adm)) {
        /*
         * Render the creative. The pixel is fetched by the engine as a real
         * subresource, so TLS, HTTP/2 and sec-fetch-* are all genuine.
         */
        await page.setContent(
            `<!doctype html><html><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
            `<body style="margin:0">${adm}</body></html>`,
            { waitUntil: 'load', timeout: timeoutMs },
        );
      } else if (pixelUrl) {
        /*
         * No renderable markup: navigate to the pixel directly. Weaker
         * (sec-fetch-dest becomes document rather than image) but still a
         * real browser request.
         */
        await page.goto(pixelUrl, { waitUntil: 'load', timeout: timeoutMs }).catch(() => {});
      } else {
        return { ok: false, error: 'No adm markup and no pixelUrl' };
      }

      /*
       * Give late-arriving beacons a moment to fire.
       */
      await page.waitForTimeout(750);

      const pixelHits = captured.filter((c) => /\/t\/imp|pixel|impression|\/imp\?/i.test(c.url));

      return {
        ok: pixelHits.length > 0 && pixelHits.some((h) => (h.status ?? 0) >= 200 && (h.status ?? 0) < 400),
        status: pixelHits.find((h) => h.status)?.status,
        requests: captured,
        pixelHits,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), requests: captured };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
