#!/usr/bin/env node
/**
 * Run the funnel across a harvester pool of US residential IPs.
 *
 * Each pool entry is a session id that maps deterministically to one US exit
 * IP. This runner walks the pool, and for each IP:
 *
 *   1. opens a pinned connection to that session,
 *   2. builds a request whose device.ip IS that IP (so geo, carrier and
 *      address all agree),
 *   3. sends the auction through that connection,
 *   4. fires every impression URL through the SAME connection.
 *
 * Step 4 is the point: the bid and its impressions leave from one IP.
 *
 * Connection discipline: the plan allows 100 concurrent connections, so
 * `--parallel` is capped there and each worker holds exactly one connection
 * at a time, closing it before moving on.
 *
 * Run:
 *   node src/run-pool.mjs --count 50 --local      # local mock exchange
 *   node src/run-pool.mjs --count 200 --parallel 8
 *   node src/run-pool.mjs --count 20 --imp 100
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildAuctionRequest,
  sendAuction,
  extractImpPixel,
  fireImpression,
} from './req.mjs';

import { openPooledSession } from './us-session.mjs';
import { initGeoIP, getGeoDetail } from './geo.mjs';
import { loadUserAgents } from './uas.mjs';
import { APP_FIXTURES } from './traffic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POOL_PATH = join(ROOT, 'data/us_ip_pool.json');
const MAX_CONCURRENCY = 100; /* hard plan limit */

const HELP = `
Run the funnel across the harvested US IP pool.

Options:
  --count N        Auctions to run (one per IP until the pool is exhausted). Default: 25
  --imp N          Stop after N impressions. Default: unlimited
  --parallel N     Concurrent IPs. Capped at 100 (plan limit). Default: 6
  --floor N        Bid floor. Default: 0.5
  --url URL        Auction endpoint. Default: config/config.json
  --local          Send directly, not through the proxy. Use with the local
                   mock exchange (a proxy cannot reach 127.0.0.1).
  --verbose        Print each request body.
  --help
`;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const valued = new Set(['--count', '--imp', '--parallel', '--floor', '--url']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--local' || token === '--verbose' || token === '--help') {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('--help')) {
    console.log(HELP);
    return 0;
  }

  if (!existsSync(POOL_PATH)) {
    console.error(red('No US IP pool. Run: node src/ip-harvest.mjs --target 1000'));
    return 1;
  }

  const pool = JSON.parse(readFileSync(POOL_PATH, 'utf8'));
  const entries = pool.ips.filter((entry) => entry.status !== 'dead');

  if (entries.length === 0) {
    console.error(red('Pool is empty.'));
    return 1;
  }

  const config = JSON.parse(readFileSync(join(ROOT, 'config/config.json'), 'utf8'));

  const auctionUrl = args.values.get('--url') ?? config.url;
  const count = Math.min(num(args.values.get('--count'), 25), entries.length);
  const impTarget = num(args.values.get('--imp'), Infinity);
  const parallel = Math.min(num(args.values.get('--parallel'), 6), MAX_CONCURRENCY);
  const floor = num(args.values.get('--floor'), 0.5);
  const local = args.flags.has('--local');
  const verbose = args.flags.has('--verbose');

  await initGeoIP();

  const uas = loadUserAgents(join(ROOT, config.inputs.uaFile));
  const traffic = { ...config.traffic, apps: APP_FIXTURES };

  console.log(`pool        : ${entries.length} US IPs  ${dim(`(ttl ${pool.ttlMinutes ?? '?'}m, verified ${pool.verifiedAt ?? pool.updatedAt ?? 'unknown'})`)}`);
  console.log(`auctions    : ${count} across ${Math.min(parallel, count)} concurrent IPs`);
  console.log(`mode        : ${local ? 'LOCAL (auction sent direct)' : 'PROXIED'}`);
  console.log('');

  /* ---------------------------------------------------------------------- */
  /* Shared state                                                           */
  /* ---------------------------------------------------------------------- */

  const stats = {
    auctions: 0,
    bids: 0,
    nobids: 0,
    errors: 0,
    impFired: 0,
    impFailed: 0,
    noPixel: 0,
    ipsUsed: new Set(),
    ipMismatch: 0,
  };

  let nextIndex = 0;
  let stop = false;

  const claimEntry = () => {
    if (stop || nextIndex >= count) return null;

    const entry = entries[nextIndex % entries.length];
    nextIndex += 1;

    return entry;
  };

  /* ---------------------------------------------------------------------- */
  /* One worker: one IP at a time                                           */
  /* ---------------------------------------------------------------------- */

  async function worker(workerId) {
    for (;;) {
      const entry = claimEntry();

      if (!entry) return;

      if (stats.impFired >= impTarget) {
        stop = true;
        return;
      }

      const session = await openPooledSession(entry, {
        country: pool.country ?? 'US',
        ttl: pool.ttlMinutes ?? 10,
      });

      if (!session.ok) {
        stats.errors += 1;
        console.log(red(`  w${workerId} session failed (${entry.ip}): ${session.error}`));
        continue;
      }

      try {
        const geo = getGeoDetail(session.ip);

        /*
         * Guard the core invariant: the request must describe the address it
         * is actually sent from.
         */
        if (geo && geo.country !== 'US') {
          stats.ipMismatch += 1;
          console.log(yellow(`  w${workerId} skipping non-US exit ${session.ip} (${geo.country})`));
          continue;
        }

        const ua = uas[Math.floor(Math.random() * uas.length)];
        const app = APP_FIXTURES[Math.floor(Math.random() * APP_FIXTURES.length)];

        const body = buildAuctionRequest({
          ua,
          ip: session.ip,
          publisherId: app.publisherId,
          bidfloor: floor,
          traffic,
        });

        if (verbose) console.log(JSON.stringify(body, null, 2));

        stats.auctions += 1;
        stats.ipsUsed.add(session.ip);

        const result = await sendAuction(body, {
          auctionUrl,
          supplyKey: '',
          dispatcher: local ? undefined : session.dispatcher,
        });

        if (result.status === 0) {
          stats.errors += 1;
          console.log(red(`  w${workerId} ${session.ip} network error`));
          continue;
        }

        if (result.status === 204) {
          stats.nobids += 1;
          continue;
        }

        if (result.status !== 200) {
          stats.errors += 1;
          console.log(red(`  w${workerId} ${session.ip} HTTP ${result.status}`));
          continue;
        }

        stats.bids += 1;

        const pixel = extractImpPixel(result);

        if (!pixel) {
          stats.noPixel += 1;
          continue;
        }

        try {
          const status = await fireImpression(pixel, {
            dispatcher: local ? undefined : session.dispatcher,
            headers: {
              'user-agent': ua,
              'x-forwarded-for': session.ip,
            },
          });

          if (status >= 200 && status < 400) {
            stats.impFired += 1;

            console.log(
                green(`  w${workerId} ${session.ip.padEnd(16)}`) +
                ` bid + imp ` +
                dim(`${session.city ?? geo?.city ?? '-'}  ${app.bundle}  ${body.device.model}`),
            );
          } else {
            stats.impFailed += 1;
          }
        } catch (error) {
          stats.impFailed += 1;
          console.log(red(`  w${workerId} impression failed: ${String(error?.message ?? error).slice(0, 80)}`));
        }
      } finally {
        /* Release the connection before taking another IP. */
        await session.close();
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Run                                                                    */
  /* ---------------------------------------------------------------------- */

  const started = Date.now();

  await Promise.all(
      Array.from({ length: Math.min(parallel, count) }, (_, i) => worker(i + 1)),
  );

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log('=== summary ===');
  console.log(`  distinct US IPs used : ${stats.ipsUsed.size}`);
  console.log(`  auctions             : ${stats.auctions}`);
  console.log(`  bids                 : ${stats.bids}   no-bids: ${stats.nobids}   errors: ${stats.errors}`);
  console.log(`  impressions          : ${stats.impFired} fired, ${stats.impFailed} failed, ${stats.noPixel} no pixel`);
  console.log(`  non-US skipped       : ${stats.ipMismatch}`);
  console.log(`  elapsed              : ${elapsed}s`);

  return stats.errors > 0 && stats.bids === 0 ? 1 : 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    });
