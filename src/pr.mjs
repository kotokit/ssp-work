/**
 * Residential proxy configuration and preflight.
 *
 * IMPORTANT — two traps this module exists to prevent:
 *
 * 1. Node's built-in `fetch` does NOT read HTTP_PROXY/HTTPS_PROXY by default.
 *    Node 24 supports it, but only when the process opts in with
 *    `--use-env-proxy` (or NODE_USE_ENV_PROXY=1). Without that, every request
 *    silently goes DIRECT and the proxy appears to work while doing nothing.
 *    Start the server via `npm run server` / `./run.sh`, which set the flag.
 *
 * 2. Proxy-Cheap authenticates the username EXACTLY as issued. Suffixes such
 *    as `_country-US` are rejected by the gateway with
 *    `401 Invalid credentials`, not silently ignored. Country targeting and
 *    sticky sessions therefore must be configured in the Proxy-Cheap
 *    dashboard's credentials generator, which returns a username that
 *    already encodes them. Do not append suffixes by hand.
 */

import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));

/**
 * Suffixes that look plausible but are rejected by Proxy-Cheap's gateway.
 * Detected only to produce a clear error instead of a confusing 401.
 */
const REJECTED_SUFFIXES = /_(country|cc|geo|region|state|city|session|sess|sessid|sessionid|sticky|sesstime)[-_]/i;

export function getProxyCredentials() {
  const {
    PROXY_HOST,
    PROXY_PORT,
    PROXY_USER,
    PROXY_PASS,
    PROXY_COUNTRY,
  } = process.env;

  if (!PROXY_HOST || !PROXY_PORT || !PROXY_USER || !PROXY_PASS) {
    return null;
  }

  return {
    host: PROXY_HOST,
    port: PROXY_PORT,
    user: PROXY_USER,
    pass: PROXY_PASS,
    country: PROXY_COUNTRY ?? null,
  };
}

export function getProxyString() {
  const credentials = getProxyCredentials();

  if (!credentials) return null;

  return `http://${credentials.user}:${credentials.pass}@${credentials.host}:${credentials.port}`;
}

/**
 * Environment variables that put the proxy in effect for a CHILD process,
 * with localhost excluded so the local mock exchange stays reachable.
 *
 * These must be present in the environment at process START, not assigned
 * from inside a running process: `--use-env-proxy` reads them once during
 * startup and ignores later assignment. Use `proxyEnvFromDotenv()` to build
 * them in a shell wrapper before launching node.
 */
export function getProxyEnv() {
  const proxy = getProxyString();

  if (!proxy) return {};

  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
}

/**
 * Read the handful of variables needed to put the proxy in effect, parsed
 * straight from .env. Intended for shell wrappers:
 *
 *   eval "$(node src/pr.mjs --export)"
 *   node --use-env-proxy src/ssp-server.mjs
 *
 * Deliberately does NOT depend on --use-env-proxy, because it is the thing
 * that tells node to use the proxy in the first place.
 */
export function proxyEnvFromDotenv() {
  const credentials = getProxyCredentials();

  if (!credentials) return {};

  return getProxyEnv();
}

/**
 * Whether this process was started able to honor the proxy at all.
 *
 * Note: `--use-env-proxy` is necessary but not sufficient — the process must
 * ALSO have had HTTP_PROXY/HTTPS_PROXY set at launch. When it did not, the
 * proxy credentials are valid but every request goes direct, which is the
 * failure mode worth shouting about.
 */
export function proxyIsActive() {
  const flagged =
      process.execArgv.includes('--use-env-proxy') ||
      process.env.NODE_USE_ENV_PROXY === '1' ||
      process.env.NODE_USE_ENV_PROXY === 'true';

  if (!flagged) return false;

  return Boolean(
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy,
  );
}

/**
 * Explain precisely why the proxy is not in effect, or null when it is.
 */
export function proxyProblem() {
  const credentials = getProxyCredentials();

  if (!credentials) {
    return 'No proxy configured (PROXY_HOST/PORT/USER/PASS missing in .env).';
  }

  if (REJECTED_SUFFIXES.test(credentials.user)) {
    return (
      `PROXY_USER contains a suffix Proxy-Cheap rejects ("${credentials.user}"). ` +
      'The gateway answers 401 Invalid credentials. Generate credentials with the ' +
      'country/session options you need in the Proxy-Cheap dashboard instead of ' +
      'appending suffixes by hand.'
    );
  }

  const flagged =
      process.execArgv.includes('--use-env-proxy') ||
      process.env.NODE_USE_ENV_PROXY === '1' ||
      process.env.NODE_USE_ENV_PROXY === 'true';

  const hasEnv = Boolean(
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy,
  );

  if (!flagged && !hasEnv) {
    return (
      'Proxy configured but NOT in effect: the process was started without ' +
      '--use-env-proxy and without HTTP_PROXY/HTTPS_PROXY. Use ./run.sh or ' +
      '`npm run server`, which set both.'
    );
  }

  if (!flagged) {
    return (
      'Proxy configured but NOT in effect: HTTP_PROXY is set but the process ' +
      'lacks --use-env-proxy (or NODE_USE_ENV_PROXY=1), so fetch() goes direct.'
    );
  }

  if (!hasEnv) {
    return (
      'Proxy configured but NOT in effect: --use-env-proxy is present but ' +
      'HTTP_PROXY/HTTPS_PROXY were not set at process START. Node reads them ' +
      'once during startup and ignores later assignment from inside the process ' +
      '(including process.loadEnvFile). Export them in the shell first:\n' +
      '    eval "$(node src/pr.mjs --export)"\n' +
      '    node --use-env-proxy src/ssp-server.mjs'
    );
  }

  return null;
}

/**
 * One-shot preflight: prove the proxy is actually in the request path.
 *
 * A proxy that is configured but bypassed is worse than no proxy, because
 * the traffic still leaves from the operator's own IP while appearing
 * proxied. This performs a real request and reports the exit IP/geo, and
 * fails loudly when credentials are rejected.
 *
 * Transient failures are retried: proxy gateways routinely time out on the
 * first attempt, and a flaky preflight is worse than none because it trains
 * the operator to ignore it.
 *
 * @returns {Promise<{ok: boolean, ip?: string, country?: string, city?: string, org?: string, error?: string, active: boolean}>}
 */
export async function verifyProxy({ timeoutMs = 20_000, attempts = 3 } = {}) {
  const active = proxyIsActive();
  const problem = proxyProblem();

  if (problem) {
    return { ok: false, active, error: problem };
  }

  let lastError = 'no attempt made';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await verifyProxyOnce({ timeoutMs });

    if (result.ok) {
      return { ...result, attempts: attempt };
    }

    lastError = result.error;

    /*
     * A rejected credential is not transient; do not hammer the gateway.
     * An overloaded exit node is, so those keep retrying.
     */
    if (result.fatal) {
      break;
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }

  return { ok: false, active, error: lastError };
}

async function verifyProxyOnce({ timeoutMs = 20_000 } = {}) {
  try {
    const response = await fetch('https://ipinfo.io/json', {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 407) {
      return {
        ok: false,
        fatal: true,
        error: 'Proxy rejected the credentials (HTTP 407). Check PROXY_USER/PROXY_PASS.',
      };
    }

    if (!response.ok) {
      /*
       * 503 "Exit node overloaded" is normal and transient on this gateway;
       * the caller retries it, so do not treat it as fatal here.
       */
      const message = response.headers.get('proxy-message') ?? `HTTP ${response.status}`;

      return {
        ok: false,
        transient: response.status === 503,
        error: `Proxy preflight returned ${response.status}: ${message}`,
      };
    }

    const json = await response.json();

    return {
      ok: true,
      active: true,
      ip: json.ip,
      country: json.country,
      city: json.city ?? null,
      org: json.org,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Proxy preflight failed: ${String(error?.message ?? error).slice(0, 160)}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* CLI: emit shell exports                                                    */
/* -------------------------------------------------------------------------- */

/*
 * When run directly, print `export KEY='value'` lines so a shell wrapper can
 * put the proxy in effect BEFORE node starts. This is the only reliable way:
 * --use-env-proxy reads the environment once at startup.
 *
 *   eval "$(node src/pr.mjs --export)"
 */
if (process.argv[1] && process.argv[1].endsWith('pr.mjs') && process.argv.includes('--export')) {
  const env = proxyEnvFromDotenv();

  for (const [key, value] of Object.entries(env)) {
    process.stdout.write(`export ${key}='${value}'\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Proxy agent with browser-like ALPN                                         */
/* -------------------------------------------------------------------------- */

/**
 * TLS options that make the ALPN offer match Chrome's.
 *
 * undici's connector defaults to `ALPNProtocols: ['http/1.1', 'h2']` — it
 * offers HTTP/1.1 FIRST, so a server that supports both picks HTTP/1.1. A
 * real Android WebView offers `h2` first and negotiates HTTP/2.
 *
 * Setting `preferH2` flips that to `['h2', 'http/1.1']`. `allowH2` is
 * already true by default and is stated explicitly so a future default
 * change cannot silently downgrade this to HTTP/1.1.
 */
export const BROWSER_TLS = Object.freeze({
  allowH2: true,
  preferH2: true,
});

/**
 * Build a ProxyAgent whose tunnelled connections negotiate HTTP/2 the way a
 * browser does.
 *
 * Note: this affects the protocol of the tunnelled request. The TLS
 * ClientHello is still Node's, not Chrome's, so JA3/JA4 do not match a real
 * device — only a real browser can fix that.
 *
 * @param {object} [options]
 * @param {number} [options.connections] pinned connections; 1 keeps one exit IP
 * @param {string} [options.uri] proxy URL; defaults to the .env credentials
 */
export async function createProxyAgent({ connections = 1, uri } = {}) {
  const { ProxyAgent } = await import('undici');

  const proxyUri = uri ?? getProxyString();

  if (!proxyUri) {
    throw new Error('No proxy configured (PROXY_HOST/PORT/USER/PASS missing in .env).');
  }

  return new ProxyAgent({
    uri: proxyUri,
    connections,
    pipelining: 1,
    requestTls: { ...BROWSER_TLS },
  });
}
