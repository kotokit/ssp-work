#!/usr/bin/env node
/**
 * Harvest a pool of distinct US residential IPs from Proxy-Cheap.
 *
 * HOW THIS WORKS (verified empirically, not assumed):
 *
 *   - Routing lives in the PASSWORD, not the username:
 *       <base>_country-US_session-<id>_ttl-<minutes>
 *   - The session id is NOT validated against a pre-issued list — invented
 *     ids are accepted — so sessions can be minted locally.
 *   - A session id maps DETERMINISTICALLY to one exit IP, and stays on it
 *     (re-checked minutes apart, unchanged).
 *   - Because the mapping is deterministic, holding an IP does not require
 *     holding a connection: re-using the same session id returns the same
 *     address. That is what makes a pool larger than the connection limit
 *     possible.
 *
 * CONNECTION LIMIT: Rotating Residential allows 100 concurrent connections
 * (fixed for this product). Harvesting therefore runs in bounded waves; it
 * never opens more than `--concurrency` at once.
 *
 * Run:
 *   node src/ip-harvest.mjs --target 1000
 *   node src/ip-harvest.mjs --target 100 --concurrency 50
 *   node src/ip-harvest.mjs --verify-only     # re-check the existing pool
 *
 * Output: data/us_ip_pool.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ProxyAgent, request } from 'undici';

import { getProxyCredentials } from './pr.mjs';
import { initGeoIP, getGeoDetail } from './geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POOL_PATH = join(ROOT, 'data/us_ip_pool.json');

const HELP = `
Harvest distinct US residential exit IPs.

Options:
  --target N        How many US IPs to collect. Default: 1000
  --concurrency N   Parallel connections per wave (max 100 on this plan). Default: 24
  --ttl N           Session TTL in minutes. Default: 10
  --country CC      Target country. Default: US
  --verify-only     Re-verify the existing pool instead of harvesting.
  --help

Notes:
  - Sessions are minted locally; the id is not pre-issued by the dashboard.
  - Rotating Residential is capped at 100 concurrent connections.
  - Each verified IP costs one tiny request to the IP echo endpoint.
`;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valued = new Set(['--target', '--concurrency', '--ttl', '--country']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--verify-only' || token === '--help') {
      flags.add(token);
      continue;
    }

    if (!valued.has(token)) throw new Error(`Unknown option: ${token}`);

    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${token}`);

    values.set(token, value);
    i += 1;
  }

  return { values, flags };
}

const num = (v, d) => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
  return n;
};

const dim = (t) => `\u001b[2m${t}\u001b[0m`;
const green = (t) => `\u001b[32m${t}\u001b[0m`;
const red = (t) => `\u001b[31m${t}\u001b[0m`;
const yellow = (t) => `\u001b[33m${t}\u001b[0m`;

/**
 * Endpoint that echoes the caller's address as plain text.
 *
 * Not a JSON geo API: those rate-limit quickly over a harvest of thousands of
 * requests, and this project already resolves geo locally from GeoLite2.
 */
const IP_ECHO = 'https://ipv4.icanhazip.com';

const randomSessionId = () =>
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6);

/**
 * Build the routing password for one session.
 */
function passwordFor(base, { country, sessionId, ttl }) {
  return `${base}_country-${country}_session-${sessionId}_ttl-${ttl}`;
}

/**
 * Resolve one session to its exit IP.
 *
 * Retries transient gateway failures: `503 Exit node overloaded` and
 * `Upstream connection failed` are routine and say nothing about the session.
 */
async function resolveSession(session, { attempts = 4, timeoutMs = 20_000 } = {}) {
  let lastError = 'no attempt';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const agent = new ProxyAgent({
      uri: `http://${session.user}:${session.password}@${session.host}:${session.port}`,
      connections: 1,
      pipelining: 1,
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
          continue;
        }

        const detail = getGeoDetail(ip);

        return {
          ok: true,
          ip,
          country: detail?.country ?? null,
          city: detail?.city ?? null,
          org: null,
          region: detail?.region ?? null,
          metro: detail?.metro ?? null,
          zip: detail?.zip ?? null,
        };
      }

      const message = response.headers['proxy-message'] ?? `HTTP ${response.statusCode}`;

      await response.body.dump().catch(() => {});

      lastError = String(message);

      if (response.statusCode === 407) {
        return { ok: false, fatal: true, error: `rejected: ${message}` };
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
    } finally {
      await agent.close().catch(() => {});
    }

    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, 350 * attempt));
    }
  }

  return { ok: false, error: lastError };
}

function loadPool() {
  if (!existsSync(POOL_PATH)) {
    return { country: 'US', ttlMinutes: 10, createdAt: null, ips: [] };
  }

  try {
    return JSON.parse(readFileSync(POOL_PATH, 'utf8'));
  } catch {
    return { country: 'US', ttlMinutes: 10, createdAt: null, ips: [] };
  }
}

function savePool(pool) {
  mkdirSync(dirname(POOL_PATH), { recursive: true });
  writeFileSync(POOL_PATH, `${JSON.stringify(pool, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('--help')) {
    console.log(HELP);
    return 0;
  }

  const credentials = getProxyCredentials();

  if (!credentials) {
    console.error(red('No proxy configured in .env'));
    return 1;
  }

  /*
   * Derive the BASE password, i.e. the account password without any routing
   * suffix. Whatever is in .env is stripped back to its base so we can mint
   * our own sessions from it.
   */
  const base = String(credentials.pass).split('_country-')[0];

  const country = args.values.get('--country') ?? 'US';
  const ttl = num(args.values.get('--ttl'), 10);
  const concurrency = Math.min(num(args.values.get('--concurrency'), 24), 100);

  await initGeoIP();

  const existing = loadPool();
  const byIp = new Map(existing.ips.map((entry) => [entry.ip, entry]));

  /* ---------------------------------------------------------------------- */
  /* Verify-only mode                                                       */
  /* ---------------------------------------------------------------------- */

  if (args.flags.has('--verify-only')) {
    if (existing.ips.length === 0) {
      console.error('Pool is empty; nothing to verify. Run a harvest first.');
      return 1;
    }

    console.log(`verifying ${existing.ips.length} pooled sessions...`);

    let alive = 0;
    let moved = 0;
    let dead = 0;

    for (let i = 0; i < existing.ips.length; i += concurrency) {
      const wave = existing.ips.slice(i, i + concurrency);

      const results = await Promise.all(wave.map((entry) =>
        resolveSession({
          user: credentials.user,
          password: passwordFor(base, { country, sessionId: entry.sessionId, ttl }),
          host: credentials.host,
          port: credentials.port,
        })));

      results.forEach((result, index) => {
        const entry = wave[index];

        if (!result.ok) {
          dead += 1;
          entry.status = 'dead';
        } else if (result.ip !== entry.ip) {
          moved += 1;
          entry.status = 'moved';
          entry.previousIp = entry.ip;
          entry.ip = result.ip;
        } else {
          alive += 1;
          entry.status = 'alive';
        }
      });

      process.stdout.write(
          `\r  ${Math.min(i + concurrency, existing.ips.length)}/${existing.ips.length}  ` +
          green(`alive ${alive}`) + '  ' + yellow(`moved ${moved}`) + '  ' + red(`dead ${dead}`) + '   ',
      );
    }

    console.log('');
    existing.verifiedAt = new Date().toISOString();
    savePool(existing);

    return 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Harvest                                                                */
  /* ---------------------------------------------------------------------- */

  const target = num(args.values.get('--target'), 1000);

  console.log(`harvesting ${target} distinct ${country} IPs`);
  console.log(dim(
      `  base credential : ${credentials.user}:***  @${credentials.host}:${credentials.port}\n` +
      `  session pattern : <base>_country-${country}_session-<id>_ttl-${ttl}\n` +
      `  concurrency     : ${concurrency} (plan limit is 100)`,
  ));

  if (byIp.size > 0) {
    console.log(dim(`  resuming: ${byIp.size} IP(s) already in the pool`));
  }

  console.log('');

  const started = Date.now();
  let attempted = 0;
  const collisions = new Map();

  const stats = {
    nonUs: 0,
    duplicate: 0,
    failed: 0,
    waves: 0,
  };

  while (byIp.size < target) {
    const remaining = target - byIp.size;
    const waveSize = Math.min(concurrency, Math.max(remaining, 8));

    stats.waves += 1;

    const sessions = Array.from({ length: waveSize }, () => {
      const sessionId = randomSessionId();

      return {
        sessionId,
        user: credentials.user,
        password: passwordFor(base, { country, sessionId, ttl }),
        host: credentials.host,
        port: credentials.port,
      };
    });

    attempted += sessions.length;

    const results = await Promise.all(sessions.map((session) => resolveSession(session)));

    results.forEach((result, index) => {
      const session = sessions[index];

      if (!result.ok) {
        stats.failed += 1;
        return;
      }

      if (result.country !== country) {
        stats.nonUs += 1;
        collisions.set(result.country, (collisions.get(result.country) ?? 0) + 1);
        return;
      }

      if (byIp.has(result.ip)) {
        stats.duplicate += 1;
        return;
      }

      const detail = getGeoDetail(result.ip);

      byIp.set(result.ip, {
        ip: result.ip,
        sessionId: session.sessionId,
        country: result.country,
        city: result.city ?? detail?.city ?? null,
        region: detail?.region ?? null,
        org: result.org ?? null,
        asn: result.org ?? null,
        metro: detail?.metro ?? null,
        zip: detail?.zip ?? null,
        status: 'alive',
        verifiedAt: new Date().toISOString(),
      });
    });

    const pct = ((byIp.size / target) * 100).toFixed(0);
    const rate = attempted / Math.max((Date.now() - started) / 1000, 0.001);

    process.stdout.write(
        `\r  ${green(String(byIp.size).padStart(5))}/${target} (${pct}%)  ` +
        `attempted ${String(attempted).padStart(5)}  ` +
        dim(`non-${country} ${stats.nonUs}  dup ${stats.duplicate}  fail ${stats.failed}  `) +
        dim(`${rate.toFixed(1)}/s`) + '   ',
    );

    /* Persist as we go so an interrupted harvest is not lost. */
    if (stats.waves % 5 === 0) {
      savePool({
        country,
        ttlMinutes: ttl,
        createdAt: existing.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ips: [...byIp.values()],
      });
    }

    if (attempted > target * 12) {
      console.log('');
      console.log(yellow(
          `stopping: ${attempted} attempts produced only ${byIp.size} distinct ${country} IPs. ` +
          'The pool may be smaller than the target right now.',
      ));
      break;
    }
  }

  console.log('');

  const ips = [...byIp.values()];
  const pool = {
    country,
    ttlMinutes: ttl,
    createdAt: existing.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    count: ips.length,
    attempts: attempted,
    stats: {
      nonTargetCountry: stats.nonUs,
      duplicates: stats.duplicate,
      failed: stats.failed,
    },
    ips,
  };

  savePool(pool);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`harvested ${green(String(ips.length))} ${country} IPs in ${elapsed}s`);
  console.log(dim(`  attempts ${attempted}  non-${country} ${stats.nonUs}  duplicates ${stats.duplicate}  failed ${stats.failed}`));
  console.log(dim(`  saved to data/us_ip_pool.json`));

  const cities = new Map();
  const orgs = new Map();

  for (const entry of ips) {
    if (entry.city) cities.set(entry.city, (cities.get(entry.city) ?? 0) + 1);
    if (entry.org) orgs.set(entry.org, (orgs.get(entry.org) ?? 0) + 1);
  }

  console.log('');
  console.log('  top cities:');
  [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .forEach(([city, n]) => console.log(`    ${String(n).padStart(4)}  ${city}`));

  console.log('  top networks:');
  [...orgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .forEach(([org, n]) => console.log(`    ${String(n).padStart(4)}  ${org}`));

  return 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    });
