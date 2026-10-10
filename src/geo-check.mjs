#!/usr/bin/env node
/**
 * Validate the IP pool (and, optionally, the proxy) against the real
 * GeoLite2 database.
 *
 * The pool assigns an ISP and a metro to each address from the CIDR block it
 * was drawn from. That is a guess about a whole block, not a fact about the
 * host, so it is sometimes wrong — and a request whose device.geo disagrees
 * with its own device.ip is exactly the kind of mismatch IVT detection looks
 * for.
 *
 * This reports where the pool's claims do not survive a real lookup, so the
 * bad entries can be fixed at the source (data/isp_ranges.json) rather than
 * silently shipping.
 *
 * Run:
 *   node src/geo-check.mjs                 # sample the pool
 *   node src/geo-check.mjs --all           # every IP in the pool
 *   node src/geo-check.mjs --samples 200
 *   node src/geo-check.mjs --proxy         # also geolocate the proxy egress
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  initGeoIP,
  getGeoDetail,
  geoPath,
} from './geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
Validate the IP pool against the GeoLite2 database.

Options:
  --samples N   Number of random pool IPs to check. Default: 100
  --all         Check every IP in the pool (slow, but exhaustive)
  --proxy       Also look up the proxy's current egress IP
  --help
`;

function parseArgs(argv) {
  const flags = new Set();
  let samples = 100;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help') return { help: true };
    if (token === '--all') { flags.add('all'); continue; }
    if (token === '--proxy') { flags.add('proxy'); continue; }

    if (token === '--samples') {
      samples = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  if (!Number.isSafeInteger(samples) || samples <= 0) {
    throw new Error('--samples must be a positive integer.');
  }

  return { flags, samples };
}

/**
 * Extract the city a metro token claims, or null for region-level tokens.
 */
function claimedCity(metro) {
  if (typeof metro !== 'string') return null;

  const value = metro.replace(/^US\//i, '').trim();

  if (/^(national|northeast|mobile)$/i.test(value)) return null;

  /* "IN West Lafayette" -> "West Lafayette" */
  const parts = value.split(/\s+/);

  return parts.length > 1 && parts[0].length === 2
      ? parts.slice(1).join(' ')
      : value;
}

const normalize = (value) =>
    String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const geo = await initGeoIP();

  if (!geo.ok) {
    console.error(`GeoIP unavailable: ${geo.error}`);
    return 1;
  }

  console.log(`database: ${geoPath()}`);

  const pool = JSON.parse(
      readFileSync(join(ROOT, 'data/ip_pool.json'), 'utf8'),
  );

  /* ---------------------------------------------------------------------- */
  /* Sample selection                                                       */
  /* ---------------------------------------------------------------------- */

  let indices;

  if (args.flags.has('all')) {
    indices = pool.ips.map((_, i) => i);
  } else {
    const n = Math.min(args.samples, pool.ips.length);
    const picked = new Set();

    while (picked.size < n) {
      picked.add(Math.floor(Math.random() * pool.ips.length));
    }

    indices = [...picked];
  }

  console.log(`checking ${indices.length} of ${pool.ips.length} pool IPs\n`);

  /* ---------------------------------------------------------------------- */
  /* Checks                                                                 */
  /* ---------------------------------------------------------------------- */

  const stats = {
    noRecord: [],
    notUS: [],
    ispMismatch: [],
    ispUnverifiable: 0,
    cityMismatch: [],
    cityConfirmed: 0,
    cityClaimed: 0,
    countryCounts: new Map(),
  };

  for (const index of indices) {
    const ip = pool.ips[index];
    const meta = pool.meta[index] ?? {};
    const detail = getGeoDetail(ip);

    if (!detail) {
      stats.noRecord.push(ip);
      continue;
    }

    const code = detail.country ?? '??';
    stats.countryCounts.set(code, (stats.countryCounts.get(code) ?? 0) + 1);

    if (code !== 'US') {
      stats.notUS.push({
        ip,
        claimed: meta.isp,
        actual: `${code} ${detail.city ?? ''} ${detail.isp ?? ''}`.trim(),
      });
      continue;
    }

    /*
     * ISP check.
     *
     * NOTE: GeoLite2-City has no ISP field. Only run this comparison when a
     * record actually carries one (e.g. if you also drop in GeoLite2-ASN or
     * an ISP-enriched database); otherwise report it as unverifiable rather
     * than as a mismatch, which would be a false alarm.
     */
    const claimedIsp = meta.isp ?? '';
    const firstToken = claimedIsp.split(/[\s/]+/)[0];
    const actualIsp = detail.isp ?? detail.org ?? detail.autonomousSystem ?? null;

    if (!actualIsp) {
      stats.ispUnverifiable += 1;
    } else if (
        firstToken &&
        !/proxy anchor/i.test(claimedIsp) &&
        !normalize(actualIsp).includes(normalize(firstToken))
    ) {
      stats.ispMismatch.push({
        ip,
        claimed: claimedIsp,
        actual: actualIsp,
      });
    }

    /*
     * City check, only where the pool actually names a city.
     */
    const claimed = claimedCity(meta.metro);

    if (claimed) {
      stats.cityClaimed += 1;

      const ok = detail.city
          ? normalize(detail.city).includes(normalize(claimed)) ||
            normalize(claimed).includes(normalize(detail.city))
          : false;

      if (ok) {
        stats.cityConfirmed += 1;
      } else {
        stats.cityMismatch.push({
          ip,
          claimed,
          actual: detail.city
              ? `${detail.city}, ${detail.region ?? '?'}`
              : `(no city; ${detail.region ?? detail.country ?? '?'} only)`,
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Report                                                                 */
  /* ---------------------------------------------------------------------- */

  const red = (t) => `\u001b[31m${t}\u001b[0m`;
  const yellow = (t) => `\u001b[33m${t}\u001b[0m`;
  const green = (t) => `\u001b[32m${t}\u001b[0m`;
  const dim = (t) => `\u001b[2m${t}\u001b[0m`;

  console.log('country mix (from the database):');
  for (const [code, count] of [...stats.countryCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / indices.length) * 100).toFixed(1);
    console.log(`  ${code}  ${String(count).padStart(5)}  ${pct}%${code === 'US' ? '' : red('   <-- not US')}`);
  }

  console.log('');

  if (stats.noRecord.length > 0) {
    console.log(yellow(`no database record (${stats.noRecord.length}):`));
    console.log(`  ${stats.noRecord.slice(0, 8).join(', ')}${stats.noRecord.length > 8 ? ', ...' : ''}`);
    console.log('');
  }

  if (stats.notUS.length > 0) {
    console.log(red(`NOT US (${stats.notUS.length}):`));
    for (const row of stats.notUS.slice(0, 10)) {
      console.log(`  ${row.ip.padEnd(17)} pool claims ${String(row.claimed).padEnd(20)} actual: ${row.actual}`);
    }
    console.log('');
  }

  if (stats.ispMismatch.length > 0) {
    console.log(yellow(`ISP mismatch (${stats.ispMismatch.length}):`));
    for (const row of stats.ispMismatch.slice(0, 10)) {
      console.log(`  ${row.ip.padEnd(17)} claims ${String(row.claimed).padEnd(20)} actual: ${row.actual}`);
    }
    console.log('');
  }

  if (stats.ispUnverifiable > 0) {
    console.log(dim(
        `ISP: not verifiable for ${stats.ispUnverifiable} IPs — GeoLite2-City has no ISP ` +
        'field. Add a GeoLite2-ASN database to check the ISP claims too.',
    ));
    console.log('');
  }

  if (stats.cityClaimed > 0) {
    const pct = ((stats.cityConfirmed / stats.cityClaimed) * 100).toFixed(0);

    console.log(
        `${stats.cityMismatch.length > 0 ? yellow('city claims') : green('city claims')}: ` +
        `${stats.cityConfirmed}/${stats.cityClaimed} confirmed (${pct}%)`,
    );

    for (const row of stats.cityMismatch.slice(0, 12)) {
      console.log(`  ${row.ip.padEnd(17)} claims ${String(row.claimed).padEnd(18)} actual: ${row.actual}`);
    }

    if (stats.cityMismatch.length > 12) {
      console.log(dim(`  ... and ${stats.cityMismatch.length - 12} more`));
    }

    console.log('');
  }

  console.log(dim(
      'device.geo is now taken from this database, so a wrong pool metro no longer ' +
      'reaches the request. Fixing data/isp_ranges.json still improves the pool.',
  ));

  /* ---------------------------------------------------------------------- */
  /* Optional: where does the proxy actually exit?                          */
  /* ---------------------------------------------------------------------- */

  if (args.flags.has('proxy')) {
    console.log('\nproxy egress:');

    const { verifyProxy } = await import('./pr.mjs');
    const result = await verifyProxy();

    if (!result.ok) {
      console.log(red(`  failed: ${result.error}`));
    } else {
      const detail = getGeoDetail(result.ip);

      console.log(`  exit ip : ${result.ip}`);
      console.log(`  ipinfo  : ${result.country} ${result.city ?? '-'} ${result.org ?? ''}`);
      console.log(
          `  geoip   : ${detail ? `${detail.countryAlpha3} ${detail.region ?? '-'} ${detail.city ?? '-'}` : '(no record)'}`,
      );

      if (detail && detail.country !== 'US') {
        console.log(red(
            `  the proxy exits in ${detail.country}, but every request claims a US ` +
            'device. Fix country targeting before using this against a real endpoint.',
        ));
      }
    }
  }

  return 0;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    });
