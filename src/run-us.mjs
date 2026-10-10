#!/usr/bin/env node
/**
 * Run the full funnel from ONE pinned US residential IP.
 *
 * Flow:
 *
 *   1. Open a US-pinned proxy session (see src/us-session.mjs for why this
 *      needs connection pinning rather than a username parameter).
 *   2. Build a bid request whose device.ip IS that US IP, so the geo, the
 *      carrier and the address all describe the same place.
 *   3. POST the auction through the pinned connection.
 *   4. On a win, fire EVERY impression URL from the same connection, so the
 *      bid and its impressions share one IP.
 *
 * That last point is the whole purpose: an exchange cross-checks the bid IP
 * against the impression IP, so they must not differ.
 *
 * Run:
 *   node src/run-us.mjs                       # local mock exchange, 10 auctions
 *   node src/run-us.mjs --count 25
 *   node src/run-us.mjs --url https://... --imp 50
 *   node src/run-us.mjs --dry-run             # show the request, send nothing
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildAuctionRequest,
  sendAuction,
  extractImpPixel,
  fireImpression,
} from './req.mjs';

import { openUsSession, verifySession } from './us-session.mjs';
import { initGeoIP, getGeoDetail } from './geo.mjs';
import { loadUserAgents } from './uas.mjs';
import { APP_FIXTURES, OBSERVED_BADV, DISPLAY_MANAGERS, BANNER_SIZES } from './traffic.mjs';
import { validateBidRequest, formatValidation } from './validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
Run the funnel from one pinned US residential IP.

Options:
  --url URL          Auction endpoint. Default: config/config.json
  --count N          Auctions to run. Default: 10
  --imp N            Stop after N impressions fired. Default: unlimited within count
  --floor N          Bid floor. Default: 0.5
  --max-attempts N   Proxy connections to try before giving up on a US exit. Default: 40
  --concurrency N    Parallel proxy connections per batch. Default: 8
  --dry-run          Print one request and exit; nothing is sent.
  --local            Send the AUCTION directly, not through the proxy.
                     Use with the local mock exchange: the proxy cannot
                     reach 127.0.0.1, so routing localhost through it 502s.
                     The exit IP is still established and used for device.ip.
  --verbose          Print each request body.
  --help

Nothing is sent anywhere except the configured endpoint, through the pinned
US connection.
`;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();

  const valued = new Set(['--url', '--count', '--imp', '--floor', '--max-attempts', '--concurrency']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--dry-run' || token === '--verbose' || token === '--local' || token === '--help') {
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

const num = (v, fallback) => {
  if (v === undefined) return fallback;
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

  const config = JSON.parse(readFileSync(join(ROOT, 'config/config.json'), 'utf8'));

  const auctionUrl = args.values.get('--url') ?? config.url;
  const count = num(args.values.get('--count'), 10);
  const impTarget = num(args.values.get('--imp'), Infinity);
  const floor = num(args.values.get('--floor'), 0.5);
  const maxAttempts = num(args.values.get('--max-attempts'), 40);
  const concurrency = num(args.values.get('--concurrency'), 8);
  const verbose = args.flags.has('--verbose');
  const dryRun = args.flags.has('--dry-run');
  const local = args.flags.has('--local');

  const geo = await initGeoIP();

  if (!geo.ok) {
    console.error(red(`GeoIP required: ${geo.error}`));
    return 1;
  }

  const uas = loadUserAgents(join(ROOT, config.inputs.uaFile));
  const traffic = { ...config.traffic, apps: APP_FIXTURES };

  /* ---------------------------------------------------------------------- */
  /* Dry run: build one request from a fixed US IP, send nothing            */
  /* ---------------------------------------------------------------------- */

  if (dryRun) {
    const ip = '23.139.188.14';

    const request = buildAuctionRequest({
      ua: uas[0],
      ip,
      publisherId: APP_FIXTURES[0].publisherId,
      bidfloor: floor,
      traffic,
    });

    console.log(JSON.stringify(request, null, 2));

    const result = validateBidRequest(request);

    console.log('');
    console.log(formatValidation(result, { color: process.stdout.isTTY }));
    console.log(dim(`\nGeoIP: ${geo.path}`));

    return result.valid ? 0 : 1;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. US session                                                          */
  /* ---------------------------------------------------------------------- */

  console.log('opening a US-pinned proxy session...');
  console.log(dim('  (one pinned connection = one stable exit IP for the whole funnel)'));

  const session = await openUsSession({
    wantCountry: 'US',
    maxAttempts,
    concurrency,
    onProgress: (m) => console.log(dim(`  ${m}`)),
  });

  if (!session.ok) {
    console.error(red(`\nNo US session: ${session.error}`));

    if (session.rejected?.length) {
      const seen = [...new Set(session.rejected.map((r) => r.country).filter(Boolean))];
      console.error(dim(`  countries seen: ${seen.join(', ')}`));
    }

    return 1;
  }

  console.log(
      green(`\nUS session: ${session.ip}`) +
      `  ${session.city ?? '-'} ${session.geo?.region ?? ''}  ` +
      dim(`${session.attempts} connection(s), ${(session.elapsedMs / 1000).toFixed(1)}s`),
  );

  /* ---------------------------------------------------------------------- */
  /* 2. The request describes THAT IP                                       */
  /* ---------------------------------------------------------------------- */

  const deviceGeo = getGeoDetail(session.ip);

  console.log(
      `  mode       = ${local ? 'LOCAL (auction sent direct)' : 'PROXIED (auction sent through the US connection)'}\n` +
      `  device.ip  = ${session.ip}\n` +
      `  device.geo = ${deviceGeo ? `${deviceGeo.countryAlpha3} ${deviceGeo.region ?? '-'} ${deviceGeo.city ?? '-'}` : '(no record)'}\n` +
      `  auction    = ${auctionUrl.replace(/key=[^&]+/, 'key=***')}`,
  );

  if (deviceGeo && deviceGeo.country !== 'US') {
    console.error(red(`\nRefusing to run: exit IP is ${deviceGeo.country}, not US.`));
    await session.close();
    return 1;
  }

  console.log('');

  /* ---------------------------------------------------------------------- */
  /* 3. Funnel                                                              */
  /* ---------------------------------------------------------------------- */

  const stats = {
    auctions: 0,
    bids: 0,
    nobids: 0,
    errors: 0,
    impAttempts: 0,
    impFired: 0,
    impFailed: 0,
    noPixel: 0,
  };

  const started = Date.now();

  for (let i = 0; i < count; i += 1) {
    if (stats.impFired >= impTarget) break;

    /*
     * Re-verify periodically: a session can drop or move, and a moved IP
     * would silently break the bid/impression match.
     */
    if (i > 0 && i % 10 === 0) {
      const check = await verifySession(session);

      if (!check.ok) {
        console.error(yellow(`  session changed: ${session.ip} -> ${check.ip ?? check.error}`));
        break;
      }
    }

    const ua = uas[Math.floor(Math.random() * uas.length)];
    const app = APP_FIXTURES[Math.floor(Math.random() * APP_FIXTURES.length)];

    let body;

    try {
      body = buildAuctionRequest({
        ua,
        ip: session.ip,
        publisherId: app.publisherId,
        bidfloor: floor,
        traffic,
      });
    } catch (error) {
      stats.errors += 1;
      console.error(red(`  build failed: ${String(error?.message ?? error).slice(0, 120)}`));
      continue;
    }

    if (verbose) {
      console.log(JSON.stringify(body, null, 2));
    }

    stats.auctions += 1;

    const result = await sendAuction(body, {
      auctionUrl,
      supplyKey: '',
      dispatcher: local ? undefined : session.dispatcher,
    });

    if (result.status === 0) {
      stats.errors += 1;
      console.log(red(`  ${i + 1}. network error: ${result.error ?? 'unknown'}`));
      continue;
    }

    if (result.status === 204) {
      stats.nobids += 1;
      console.log(dim(`  ${i + 1}. no bid (204)`));
      continue;
    }

    if (result.status !== 200) {
      stats.errors += 1;
      console.log(red(`  ${i + 1}. HTTP ${result.status}`));
      continue;
    }

    stats.bids += 1;

    const pixel = extractImpPixel(result);

    if (!pixel) {
      stats.noPixel += 1;
      console.log(yellow(`  ${i + 1}. bid ${result.json?.seatbid?.[0]?.bid?.[0]?.price ?? '?'} — no pixel in creative`));
      continue;
    }

    stats.impAttempts += 1;

    try {
      /*
       * THE POINT: the pixel goes out through session.dispatcher, the same
       * pinned connection that sent the bid.
       */
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
            green(`  ${i + 1}. bid + impression ${status}`) +
            dim(`  ${body.app.bundle} ${body.device.model} ${deviceGeo?.city ?? ''}`),
        );
      } else {
        stats.impFailed += 1;
        console.log(red(`  ${i + 1}. impression HTTP ${status}`));
      }
    } catch (error) {
      stats.impFailed += 1;
      console.log(red(`  ${i + 1}. impression failed: ${String(error?.message ?? error).slice(0, 100)}`));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Confirm the IP did not move                                         */
  /* ---------------------------------------------------------------------- */

  const finalCheck = await verifySession(session);

  console.log('');
  console.log('=== summary ===');
  console.log(`  exit ip        : ${session.ip}${finalCheck.ok ? green('  (unchanged)') : red(`  CHANGED -> ${finalCheck.ip ?? finalCheck.error}`)}`);
  console.log(`  elapsed        : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  auctions       : ${stats.auctions}`);
  console.log(`  bids           : ${stats.bids}`);
  console.log(`  no-bids        : ${stats.nobids}`);
  console.log(`  errors         : ${stats.errors}`);
  console.log(`  impressions    : ${stats.impFired} fired, ${stats.impFailed} failed, ${stats.noPixel} no pixel`);
  console.log(
      `  same-ip funnel : ${
          finalCheck.ok ? green('yes — every bid and impression left from ' + session.ip) : red('no')
      }`,
  );

  await session.close();

  return stats.errors > 0 && stats.bids === 0 ? 1 : 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    });
