#!/usr/bin/env node
/**
 * Generate a proper OpenRTB 2.6 bid request for local testing.
 *
 * This does not require a running exchange. It builds a request from the
 * configured IP pool + user-agent corpus, validates it against the OpenRTB
 * 2.6 rules in src/validate.mjs, and prints the JSON.
 *
 * Examples:
 *
 *   # one request, pretty JSON + validation report
 *   node src/generate.mjs
 *
 *   # only the raw JSON body, for piping or diffing
 *   node src/generate.mjs --json
 *
 *   # pin the device fixture and the network, for a reproducible request
 *   node src/generate.mjs --ua SM-S938U --ip 73.253.207.155 --save out.json
 *
 *   # ten requests, fail the run if any of them is invalid
 *   node src/generate.mjs --count 10 --strict
 *
 *   # send it to a running endpoint (e.g. the local mock exchange)
 *   node src/generate.mjs --send http://127.0.0.1:8080/openrtb2/auction
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildAuctionRequest,
  parseDevice,
  validateDevice,
} from './req.mjs';

import {
  validateBidRequest,
  formatValidation,
} from './validate.mjs';

import {
  initGeoIP,
  geoAvailable,
  geoPath,
} from './geo.mjs';

import { loadUserAgents } from './uas.mjs';
import { APP_FIXTURES } from './traffic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
Generate a proper OpenRTB 2.6 bid request for local testing.

Usage:
  node src/generate.mjs [options]

Selection:
  --ua PATTERN        Device fixture: exact model ('SM-S938U'), substring of a
                      UA ('Pixel'), or a 0-based index into the UA corpus.
                      Default: random UA from the corpus.
  --ip ADDRESS        Use this IP instead of drawing one from the pool.
  --metro TOKEN       Override the pool metro (e.g. 'US/Dallas').
  --isp NAME          Override the pool ISP (e.g. 'T-Mobile US (LTE)').
  --floor N           Bid floor in USD. Default: 0.01.
  --format TYPE       banner (default) or video.
  --seller ID         Publisher/seller ID. Default: config sellers[0].

Output:
  --count N           Generate N requests. Default: 1.
  --json              Print only the request JSON (no report, no colour).
  --compact           Print compact single-line JSON.
  --save FILE         Write the request(s) to FILE (relative to project root).
  --send URL          POST the request to URL and print the response.

Validation:
  --no-validate       Skip validation.
  --strict            Exit non-zero if any request has validation errors.
  --quiet             Suppress the report; only JSON is printed.

Other:
  --help              Show this help.

Every generated request is self-consistent by construction:
  - the IP,metro and ISP come from the same IP-pool entry
  - carrier / mccmnc / connectiontype agree with that ISP
  - the IFA is stable per (publisher, device) fixture, not per request
  - test=1 marks the auction non-billable
`;

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

const VALUE_FLAGS = new Set([
  '--ua',
  '--ip',
  '--metro',
  '--isp',
  '--floor',
  '--format',
  '--seller',
  '--count',
  '--save',
  '--send',
]);

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--compact',
  '--no-validate',
  '--strict',
  '--quiet',
  '--help',
]);

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    if (BOOLEAN_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }

    if (!VALUE_FLAGS.has(token)) {
      throw new Error(`Unknown option: ${token}`);
    }

    const value = argv[i + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }

    if (values.has(token)) {
      throw new Error(`Duplicate argument: ${token}`);
    }

    values.set(token, value);
    i += 1;
  }

  return { flags, values };
}

/* -------------------------------------------------------------------------- */
/* Fixture selection                                                          */
/* -------------------------------------------------------------------------- */

function loadConfig() {
  return JSON.parse(
      readFileSync(join(ROOT, 'config/config.json'), 'utf8'),
  );
}

function loadPool() {
  try {
    return JSON.parse(
        readFileSync(join(ROOT, 'data/ip_pool.json'), 'utf8'),
    );
  } catch {
    throw new Error(
        'Unable to read data/ip_pool.json. Run `node src/ippool.mjs` first.',
    );
  }
}

/**
 * Resolve --ua to a concrete user agent.
 *
 * The UA must pass validateDevice(), otherwise buildAuctionRequest throws.
 * Unknown models are reported with the closest known ones.
 */
function resolveUserAgent(spec, uas, knownModels) {
  if (!spec) {
    return uas[Math.floor(Math.random() * uas.length)];
  }

  if (/^\d+$/.test(spec)) {
    const index = Number(spec);

    if (index < 0 || index >= uas.length) {
      throw new Error(`--ua index ${index} is out of range (0-${uas.length - 1}).`);
    }

    return uas[index];
  }

  const needle = spec.toLowerCase();

  const matches = uas.filter(
      (ua) => ua.toLowerCase().includes(needle),
  );

  if (matches.length === 0) {
    const modelish = knownModels
        .filter((m) => m.toLowerCase().includes(needle))
        .slice(0, 8);

    throw new Error(
        [
          `No user agent in the corpus matches "${spec}".`,
          modelish.length > 0
              ? `Known device models containing "${spec}": ${modelish.join(', ')}`
              : `Known device models: ${knownModels.slice(0, 12).join(', ')}${knownModels.length > 12 ? ', ...' : ''}`,
        ].join('\n'),
    );
  }

  return matches[Math.floor(Math.random() * matches.length)];
}

/**
 * Pick an IP-pool entry, honoring --ip / --metro / --isp overrides.
 */
function resolveEndpoint(pool, { ip, metro, isp }) {
  if (ip) {
    /*
     * An explicit IP keeps the pool's metro/ISP when the IP is in the pool,
     * so the request stays coherent. Otherwise the overrides (or the pool's
     * most common values) are used.
     */
    const index = pool.ips.indexOf(ip);

    if (index !== -1) {
      const meta = pool.meta[index] ?? {};

      return {
        ip,
        metro: metro ?? meta.metro,
        isp: isp ?? meta.isp,
      };
    }

    return {
      ip,
      metro: metro ?? 'US/national',
      isp: isp ?? 'Comcast Cable',
      synthetic: true,
    };
  }

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const index = Math.floor(Math.random() * pool.ips.length);
    const meta = pool.meta[index] ?? {};

    const candidateMetro = metro ?? meta.metro;
    const candidateIsp = isp ?? meta.isp;

    if (metro && meta.metro !== metro) continue;
    if (isp && meta.isp !== isp) continue;

    return {
      ip: pool.ips[index],
      metro: candidateMetro,
      isp: candidateIsp,
    };
  }

  throw new Error(
      `No IP-pool entry matches metro="${metro ?? '*'}" isp="${isp ?? '*'}".`,
  );
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('--help')) {
    console.log(HELP);
    return 0;
  }

  const config = loadConfig();
  const pool = loadPool();

  const quiet = args.flags.has('--quiet') || args.flags.has('--json');

  /*
   * Load the GeoIP database up front. Without it device.geo falls back to
   * the pool's coarse CIDR guess, which is a different (and weaker) request,
   * so it is worth saying which one is in effect.
   */
  const geo = await initGeoIP();

  if (!quiet) {
    console.log(
        geo.ok
            ? `GeoIP: ${geo.path}`
            : `GeoIP: DISABLED (${geo.error})`,
    );
  }

  const uas = loadUserAgents(join(ROOT, config.inputs.uaFile));

  if (uas.length === 0) {
    throw new Error('User-agent corpus is empty.');
  }

  const knownModels = Object.keys(
      (await import('./req.mjs')).DEVICE_SPECS,
  );

  const count = Number(args.values.get('--count') ?? 1);

  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('--count must be a positive integer.');
  }

  const floor = Number(args.values.get('--floor') ?? 0.01);

  if (!Number.isFinite(floor) || floor < 0) {
    throw new Error('--floor must be a non-negative number.');
  }

  const format = args.values.get('--format') ?? 'banner';

  if (!['banner', 'video'].includes(format)) {
    throw new Error('--format must be banner or video.');
  }

  const seller =
      args.values.get('--seller') ??
      config.traffic.sellers?.[0]?.publisherId;

  if (seller === undefined) {
    throw new Error('No seller configured; pass --seller.');
  }

  const traffic = {
    ...config.traffic,

    /*
     * Real app portfolio.
     *
     * Each app carries its own bundle, app.id, publisher, IAB categories and
     * supply chain, so the request stays internally consistent while looking
     * like the publisher's genuine traffic spread rather than one fixed app
     * repeated on every auction.
     */
    apps: APP_FIXTURES,

    tagid: config.traffic.tagid ?? `slot-${seller}`,
  };

  const compact = args.flags.has('--compact');
  const doValidate = !args.flags.has('--no-validate');

  const requests = [];
  let errorCount = 0;
  let warningCount = 0;

  for (let i = 0; i < count; i += 1) {
    const ua = resolveUserAgent(
        args.values.get('--ua'),
        uas,
        knownModels,
    );

    /*
     * Fail fast with a clear message instead of letting
     * buildAuctionRequest throw a wall of text.
     */
    const parsed = parseDevice(ua);
    const check = validateDevice(ua, parsed);

    if (!check.valid) {
      throw new Error(
          [
            'The selected user agent is not a supported device fixture:',
            `  ${ua}`,
            ...check.errors.map((e) => `  - ${e}`),
            '',
            `Known models: ${knownModels.slice(0, 12).join(', ')}${knownModels.length > 12 ? ', ...' : ''}`,
          ].join('\n'),
      );
    }

    const endpoint = resolveEndpoint(pool, {
      ip: args.values.get('--ip'),
      metro: args.values.get('--metro'),
      isp: args.values.get('--isp'),
    });

    const request = buildAuctionRequest({
      ua,
      ip: endpoint.ip,
      bundle: config.traffic.bundle,
      appName: config.traffic.appName,
      publisherId: seller,
      format,
      bidfloor: floor,
      geoMeta: {
        isp: endpoint.isp,
        metro: endpoint.metro,
      },
      traffic,
    });

    let result = null;

    if (doValidate) {
      result = validateBidRequest(request);
      errorCount += result.errors.length;
      warningCount += result.warnings.length;
    }

    requests.push({ request, result, endpoint, ua });
  }

  /* ------------------------------------------------------------------------ */
  /* Plain JSON output                                                        */
  /* ------------------------------------------------------------------------ */

  if (args.flags.has('--json')) {
    const payload = count === 1
        ? requests[0].request
        : requests.map((r) => r.request);

    console.log(
        compact
            ? JSON.stringify(payload)
            : JSON.stringify(payload, null, 2),
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Human report                                                             */
  /* ------------------------------------------------------------------------ */

  if (!quiet) {
    requests.forEach(({ request, result, endpoint }, index) => {
      if (count > 1) {
        console.log(`\n${'='.repeat(72)}\n# request ${index + 1} of ${count}\n${'='.repeat(72)}`);
      }

      console.log(
          compact
              ? JSON.stringify(request)
              : JSON.stringify(request, null, 2),
      );

      console.log(
          `\n${'-'.repeat(72)}\n` +
          `endpoint: ip=${endpoint.ip} metro=${endpoint.metro ?? '-'} isp=${endpoint.isp ?? '-'}\n` +
          `${'-'.repeat(72)}`,
      );

      if (result) {
        console.log(formatValidation(result, { color: process.stdout.isTTY }));
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Save / send                                                              */
  /* ------------------------------------------------------------------------ */

  const savePath = args.values.get('--save');

  if (savePath) {
    const payload = count === 1
        ? requests[0].request
        : requests.map((r) => r.request);

    const absolute = join(ROOT, savePath);

    writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`);

    if (!quiet) {
      console.log(`\nSaved ${count} request(s) to ${absolute}`);
    }
  }

  const sendUrl = args.values.get('--send');

  if (sendUrl) {
    for (const { request } of requests) {
      try {
        const response = await fetch(sendUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-openrtb-version': '2.6',
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(10_000),
        });

        const text = await response.text();

        console.log(`\nPOST ${sendUrl} -> HTTP ${response.status}`);

        if (text) {
          console.log(text.slice(0, 4000));
        }
      } catch (error) {
        console.error(`\nPOST ${sendUrl} failed: ${String(error?.message ?? error)}`);
        errorCount += 1;
      }
    }
  }

  if (!quiet) {
    console.log(
        `\n${count} request(s) generated: ` +
        `${errorCount} error(s), ${warningCount} warning(s).`,
    );
  }

  if (args.flags.has('--strict') && errorCount > 0) {
    return 1;
  }

  return 0;
}

main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`\n${String(error?.message ?? error)}`);
      process.exitCode = 1;
    });
