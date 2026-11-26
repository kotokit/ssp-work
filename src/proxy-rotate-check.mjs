#!/usr/bin/env node
/**
 * Proxy rotation verification.
 *
 * Answers the question the rotation pool depends on: do distinct
 * session IDs actually yield distinct exit IPs?
 *
 * What it does:
 *   1. Tests the BASE credentials (no session suffix) with a single
 *      connection — proves the credential works at all and shows the
 *      gateway's default exit.
 *   2. Tests N sessions with the PASSWORD routing format
 *      (`_country-US_session-NNNNNN_ttl-10` appended to the password)
 *      — the format ProxyRotationPool uses — and counts distinct IPs.
 *   3. With --username-mode, tests the USERNAME routing format
 *      (`user_country-US_session-NNNNNN`) instead, in case this
 *      product embeds routing in the username rather than the password.
 *
 * Each probe is one small HTTPS request to an IP echo service through
 * the proxy. No DSP is involved, so this is safe to run any time.
 *
 * Usage:
 *   node src/proxy-rotate-check.mjs                 # 10 sessions
 *   node src/proxy-rotate-check.mjs --count 20
 *   node src/proxy-rotate-check.mjs --ttl 10
 *   node src/proxy-rotate-check.mjs --username-mode
 *   node src/proxy-rotate-check.mjs --concurrency 8
 *
 * Exit code: 0 when at least MIN_USEFUL_IPS distinct US IPs were seen,
 * 1 otherwise (the pool would be too small for the target QPS).
 */

import { ProxyAgent, request } from 'undici';

import { getProxyCredentials } from './pr.mjs';
import { initGeoIP, getGeoDetail } from './geo.mjs';
import { buildTlsConfig, buildTargetTls } from './us-session.mjs';

const IP_ECHO = 'https://ipv4.icanhazip.com';

/*
 * 5 QPS needs roughly 10-20 distinct exit IPs so no single IP sees more
 * than ~0.5 req/s — the threshold where per-IP rate patterns become a
 * bot signal.
 */
const MIN_USEFUL_IPS = 10;

const HELP = `
Proxy rotation verification

Options:
  --count N           Sessions to probe. Default: 10.
  --ttl N             Session TTL in minutes. Default: 10.
  --country CC        Target country. Default: US (or PROXY_COUNTRY).
  --username-mode     Put the routing suffix in the USERNAME instead of
                      the password (some Proxy-Cheap products do that).
  --concurrency N     Probes in parallel. Default: 8.
  --timeout N         Per-probe timeout ms. Default: 15000.
  --no-base           Skip the base-credential (no session) probe.
  --help              Show this help.
`;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help') {
      flags.add('--help');
      continue;
    }

    if (token === '--no-base') {
      flags.add('--no-base');
      continue;
    }

    if (token === '--username-mode') {
      flags.add('--username-mode');
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const value = argv[i + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }

    values.set(token, value);
    i += 1;
  }

  return { values, flags };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe one connection to its exit IP. Returns { ok, ip, ... } or
 * { ok: false, error, fatal? }.
 */
async function probeExit(proxyUrl, { timeoutMs, attempts = 3 } = {}) {
  let lastError = 'no attempt';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const agent = new ProxyAgent({
      uri: proxyUrl,
      connections: 1,
      pipelining: 1,
      tls: buildTlsConfig(),
      requestTls: buildTargetTls(),
    });

    try {
      const response = await request(IP_ECHO, {
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      if (response.statusCode === 200) {
        const ip = (await response.body.text()).trim();

        if (!/^[0-9a-f.:]+$/i.test(ip)) {
          lastError = `unexpected echo response: ${ip.slice(0, 40)}`;
          await response.body.dump().catch(() => {});
          continue;
        }

        await agent.close().catch(() => {});

        const detail = getGeoDetail(ip);

        return {
          ok: true,
          ip,
          country: detail?.country ?? null,
          city: detail?.city ?? null,
        };
      }

      const message = response.headers['proxy-message'] ?? `HTTP ${response.statusCode}`;
      await response.body.dump().catch(() => {});
      lastError = String(message);

      if (response.statusCode === 407) {
        await agent.close().catch(() => {});
        return { ok: false, fatal: true, error: `rejected: ${message}` };
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
    } finally {
      await agent.close().catch(() => {});
    }

    if (attempt < attempts) {
      await sleep(300 * attempt);
    }
  }

  return { ok: false, error: lastError };
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));

  if (flags.has('--help')) {
    console.log(HELP);
    return;
  }

  const count = Math.max(1, Number(values.get('--count') ?? 10));
  const ttl = Math.max(1, Number(values.get('--ttl') ?? 10));
  const concurrency = Math.max(1, Number(values.get('--concurrency') ?? 8));
  const timeoutMs = Math.max(2000, Number(values.get('--timeout') ?? 15_000));
  const usernameMode = flags.has('--username-mode');

  const credentials = getProxyCredentials();

  if (!credentials) {
    console.error('No proxy configured (PROXY_HOST/PORT/USER/PASS missing in .env).');
    process.exitCode = 1;
    return;
  }

  const country = values.get('--country') ?? credentials.country ?? 'US';

  /*
   * Derive the BASE password — strip any _country-XX_... suffix so we can
   * mint new sessions from it (mirrors ProxyRotationPool).
   */
  const base = String(credentials.pass).split('_country-')[0];

  const geo = await initGeoIP();

  if (!geo.ok) {
    console.warn(`!! geoip disabled (${geo.error}) — city/country will be unknown`);
  }

  console.log(
    `proxy: ${credentials.host}:${credentials.port} ` +
    `user=${credentials.user} country=${country} ` +
    `routing=${usernameMode ? 'username' : 'password'} ttl=${ttl}m`,
  );

  /* ------------------------------------------------------------------ */
  /* 1. Base credential (no session suffix)                              */
  /* ------------------------------------------------------------------ */

  if (!flags.has('--no-base')) {
    console.log('\n[1/2] base credential (no session suffix):');

    const baseUrl =
      `http://${credentials.user}:${credentials.pass}` +
      `@${credentials.host}:${credentials.port}`;

    const baseResult = await probeExit(baseUrl, { timeoutMs });

    if (baseResult.ok) {
      console.log(
        `  exit ${baseResult.ip} ` +
        `(${baseResult.city ?? 'unknown'}, ${baseResult.country ?? 'unknown'})`,
      );
    } else {
      console.log(`  !! ${baseResult.error}`);
      if (baseResult.fatal) {
        console.error('\nThe gateway rejected the base credential. Check PROXY_USER/PROXY_PASS.');
        process.exitCode = 1;
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 2. Session probing                                                  */
  /* ------------------------------------------------------------------ */

  console.log(`\n[2/2] ${count} sessions (${usernameMode ? 'username' : 'password'} routing):`);

  const buildSessionUrl = (sessionId) => {
    if (usernameMode) {
      const user = `${credentials.user}_country-${country}_session-${sessionId}`;
      return `http://${user}:${base}@${credentials.host}:${credentials.port}`;
    }

    const password = `${base}_country-${country}_session-${sessionId}_ttl-${ttl}`;
    return `http://${credentials.user}:${password}@${credentials.host}:${credentials.port}`;
  };

  const results = new Array(count);

  for (let start = 0; start < count; start += concurrency) {
    const batch = [];

    for (let i = start; i < Math.min(start + concurrency, count); i += 1) {
      const sessionId = String(i).padStart(6, '0');
      const proxyUrl = buildSessionUrl(sessionId);

      batch.push(
        probeExit(proxyUrl, { timeoutMs })
          .then((result) => {
            results[i] = { sessionId, ...result };

            if (result.ok) {
              console.log(
                `  session-${sessionId} → ${result.ip.padEnd(15)} ` +
                `(${result.city ?? 'unknown'}, ${result.country ?? 'unknown'})`,
              );
            } else {
              console.log(`  session-${sessionId} → !! ${result.error}`);
            }
          }),
      );
    }

    await Promise.all(batch);
  }

  /* ------------------------------------------------------------------ */
  /* Summary                                                              */
  /* ------------------------------------------------------------------ */

  const ok = results.filter((r) => r?.ok);
  const byIp = new Map();
  const byCountry = new Map();

  for (const r of ok) {
    byIp.set(r.ip, (byIp.get(r.ip) ?? 0) + 1);
    const c = r.country ?? 'unknown';
    byCountry.set(c, (byCountry.get(c) ?? 0) + 1);
  }

  const distinct = byIp.size;
  const wantCountry = ok.filter((r) => r.country === country).length;

  console.log('\n=== summary ===');
  console.log(`sessions resolved: ${ok.length}/${count}`);
  console.log(`distinct exit IPs: ${distinct}`);
  console.log(`exits in ${country}: ${wantCountry}/${ok.length}`);

  if (byCountry.size > 1) {
    console.log(
      `countries: ${[...byCountry.entries()]
        .map(([c, n]) => `${c}=${n}`)
        .join(' ')}`,
    );
  }

  console.log('\nIP distribution:');

  for (const [ip, n] of [...byIp.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ip.padEnd(15)} ×${n}`);
  }

  if (distinct >= MIN_USEFUL_IPS && wantCountry >= MIN_USEFUL_IPS) {
    console.log(
      `\nVERDICT: rotation works — ${distinct} distinct ${country} IPs is enough ` +
      `for ~5 QPS (≈${(5 / distinct).toFixed(2)} req/s per IP).`,
    );
  } else if (distinct >= 3) {
    console.log(
      `\nVERDICT: weak rotation — only ${distinct} distinct IPs. ` +
      `At 5 QPS each IP would see ~${(5 / Math.max(distinct, 1)).toFixed(1)} req/s, ` +
      `a visible per-IP pattern. Try a larger session ID space, a longer TTL, ` +
      `or the other routing mode (--username-mode).`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\nVERDICT: rotation barely works (${distinct} distinct IP(s)). ` +
      `The gateway is likely ignoring the session id in this position — ` +
      `try the other routing mode (--username-mode) or check the product ` +
      `settings in the Proxy-Cheap dashboard.`,
    );
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error(`proxy-rotate-check failed: ${String(err?.message ?? err)}`);
  process.exitCode = 1;
}
