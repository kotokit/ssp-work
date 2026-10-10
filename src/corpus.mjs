#!/usr/bin/env node
/**
 * Labelled corpus + precision/recall harness for the detector.
 *
 * Purpose: measure what the detector actually catches, and — more
 * importantly — what it wrongly accuses. A false positive on a real partner
 * costs money, so that number matters as much as recall.
 *
 * The corpus is built from REAL UAs in data/user_agents.csv and the real
 * GeoLite2 database, so the clean cohort is genuinely coherent. Each
 * deliberately-broken cohort then has exactly ONE defect applied, which is
 * what makes the result interpretable: if a cohort is caught, the reason is
 * the defect and nothing else.
 *
 * Cohorts:
 *
 *   clean            fully coherent request + impression headers
 *   hint-platform    scripted client: UA says Android, hints say macOS
 *   hint-brands      UA says WebView, brands say "Google Chrome"
 *   hint-version     hints advertise a different Chrome major than the UA
 *   hint-missing     no client hints at all (plain fetch())
 *   accept-star      accept: * / * on an image pixel
 *   encoding-stale   new Chrome but no zstd in accept-encoding
 *   fetch-metadata   sec-fetch-* absent
 *   geo-mismatch     device.geo contradicts device.ip
 *   impression-ip    impression fires from a different network than the bid
 *
 * Run:
 *   node src/corpus.mjs                 # full table
 *   node src/corpus.mjs --json          # machine-readable
 *   node src/corpus.mjs --size 200      # events per cohort
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze } from './detector.mjs';
import { buildImpressionHeaders } from './android-headers.mjs';
import { initGeoIP, getGeoDetail } from './geo.mjs';
import { loadUserAgents } from './uas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
Labelled corpus + precision/recall harness.

Options:
  --size N    Events per cohort. Default: 60
  --json      Machine-readable output.
  --verbose   List every signal per group.
  --help
`;

function parseArgs(argv) {
  let size = 60;
  const flags = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--json' || token === '--verbose' || token === '--help') {
      flags.add(token);
      continue;
    }

    if (token === '--size') {
      size = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('--size must be a positive integer.');
  }

  return { size, flags };
}

/* -------------------------------------------------------------------------- */
/* Deterministic pseudo-randomness                                            */
/* -------------------------------------------------------------------------- */

/** Small LCG so a corpus run is reproducible without a seed argument. */
function makeRandom(seed = 0x2f6e2b1) {
  let state = seed;

  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;

    return state / 0x7fffffff;
  };
}

const uuidFrom = (random) => {
  const hex = (n) =>
      Math.floor(random() * 16 ** n).toString(16).padStart(n, '0');

  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
};

/* -------------------------------------------------------------------------- */
/* Cohort definitions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Each cohort declares the defect it introduces. `expectSignal` is the signal
 * code the detector should raise, or null for the clean baseline.
 */
export const COHORTS = [
  { id: 'clean', defect: null, expectSignal: null, expectVerdict: 'clean' },
  { id: 'hint-platform', defect: 'sec-ch-ua-platform=macOS on an Android UA', expectSignal: 'http_incoherent' },
  { id: 'hint-brands', defect: 'brands say "Google Chrome" for a wv UA', expectSignal: 'http_incoherent' },
  { id: 'hint-version', defect: 'hints advertise a different Chrome major', expectSignal: 'http_incoherent' },
  { id: 'hint-missing', defect: 'no client hints at all', expectSignal: 'http_incoherent' },
  { id: 'accept-star', defect: 'accept: */* on an image pixel', expectSignal: 'http_incoherent' },
  { id: 'encoding-stale', defect: 'no zstd on a zstd-capable Chrome', expectSignal: 'http_incoherent' },
  { id: 'fetch-metadata', defect: 'sec-fetch-* absent', expectSignal: 'http_incoherent' },
  { id: 'geo-mismatch', defect: 'device.geo contradicts device.ip', expectSignal: null },
  { id: 'impression-ip', defect: 'impression from a different network', expectSignal: 'mismatch_seller' },
];

/**
 * Apply a defect to an otherwise-coherent header set.
 * Returns the mutated headers plus the list of fields changed.
 */
function breakHeaders(headers, defect, profile) {
  const out = { ...headers };

  switch (defect) {
    case 'sec-ch-ua-platform=macOS on an Android UA':
      out['sec-ch-ua-platform'] = '"macOS"';
      break;

    case 'brands say "Google Chrome" for a wv UA':
      out['sec-ch-ua'] = `"Chromium";v="${profile.chromeMajor}", "Google Chrome";v="${profile.chromeMajor}", "Not A(Brand";v="99"`;
      break;

    case 'hints advertise a different Chrome major':
      out['sec-ch-ua'] = `"Chromium";v="120", "Android WebView";v="120", "Not A(Brand";v="99"`;
      break;

    case 'no client hints at all':
      delete out['sec-ch-ua'];
      delete out['sec-ch-ua-mobile'];
      delete out['sec-ch-ua-platform'];
      break;

    case 'accept: */* on an image pixel':
      out.accept = '*/*';
      break;

    case 'no zstd on a zstd-capable Chrome':
      out['accept-encoding'] = 'gzip, deflate, br';
      break;

    case 'sec-fetch-* absent':
      delete out['sec-fetch-site'];
      delete out['sec-fetch-mode'];
      delete out['sec-fetch-dest'];
      break;

    default:
      break;
  }

  return out;
}

/**
 * Build the corpus.
 *
 * @returns {{events: Array, labels: Map<string, {defect, expectSignal, expectVerdict}>}}
 */
export function buildCorpus({ size = 60 } = {}) {
  const random = makeRandom();
  const uas = loadUserAgents(join(ROOT, 'data/user_agents.csv'));

  /* Prefer WebView UAs with a high Chrome version: the modern case. */
  const webviews = uas.filter((u) => /;\s*wv\)/.test(u) && /Chrome\/1[2-9]\d/.test(u));
  const pool = webviews.length > 20 ? webviews : uas;

  const events = [];
  const labels = new Map();

  const now = Date.UTC(2026, 0, 15, 18, 0); // daytime in America/New_York

  for (const cohort of COHORTS) {
    const publisherId = `CORPUS-${cohort.id.toUpperCase()}`;

    labels.set(publisherId, {
      cohort: cohort.id,
      defect: cohort.defect,
      expectSignal: cohort.expectSignal,
      expectVerdict: cohort.expectVerdict ?? 'flagged',
    });

    for (let i = 0; i < size; i += 1) {
      const ua = pool[Math.floor(random() * pool.length)];

      /*
       * A US IP that really exists in the database, so device.geo can be
       * genuinely coherent rather than invented.
       */
      const ip = `73.${Math.floor(random() * 250) + 1}.${Math.floor(random() * 250) + 1}.${Math.floor(random() * 250) + 1}`;

      const detail = getGeoDetail(ip);

      const baseHeaders = buildImpressionHeaders({
        ua,
        referer: `https://${cohort.id}.example/`,
      });

      const headers = Object.fromEntries(
          baseHeaders.headers.map(([k, v]) => [k, String(v)]),
      );

      const impressionHeaders =
          cohort.defect && cohort.expectSignal === 'http_incoherent'
              ? breakHeaders(headers, cohort.defect, baseHeaders.profile)
              : headers;

      /*
       * Geo defect: claim a city/region the IP does not resolve to.
       */
      let geo = detail
          ? {
            type: 2,
            country: detail.countryAlpha3,
            region: detail.region,
            city: detail.city,
          }
          : { type: 2, country: 'USA' };

      if (cohort.defect === 'device.geo contradicts device.ip') {
        geo = { type: 2, country: 'USA', region: 'TX', city: 'Dallas' };
      }

      /*
       * Impression-IP defect: the pixel fires from an unrelated network.
       */
      const impressionIp =
          cohort.defect === 'impression from a different network'
              ? `8.${Math.floor(random() * 250) + 1}.${Math.floor(random() * 250) + 1}.${Math.floor(random() * 250) + 1}`
              : ip;

      events.push({
        ts: now + i * 15_000, // 15s apart, well inside the daytime window
        won: true,
        impressionIp,
        impressionHeaders,
        request: {
          id: `corpus-${cohort.id}-${i}`,
          app: {
            bundle: 'com.corpus.app',
            domain: 'corpus.example',
            storeurl: 'https://play.google.com/store/apps/details?id=com.corpus.app',
            publisher: { id: publisherId },
          },
          device: {
            ip,
            ua,
            os: 'android',
            osv: (ua.match(/Android\s+([\d.]+)/) ?? [])[1] ?? '14',
            ifa: uuidFrom(random),
            geo,
          },
          source: {
            ext: {
              schain: {
                complete: 1,
                nodes: [{ asi: 'corpus.example', sid: publisherId, hp: 1 }],
              },
            },
          },
        },
      });
    }
  }

  return { events, labels };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Score detector output against the corpus labels.
 *
 * A cohort is "caught" when the detector raises the signal its defect should
 * produce. For the clean cohort, any raised signal is a false positive.
 */
export function score(report, labels) {
  const rows = [];

  for (const group of report.groups) {
    const label = labels.get(group.key);
    const codes = group.signals.map((s) => s.code);

    const caught = label.expectSignal
        ? codes.includes(label.expectSignal)
        : codes.length === 0;

    rows.push({
      cohort: label.cohort,
      publisher: group.key,
      defect: label.defect,
      expected: label.expectSignal ?? '(clean)',
      raised: codes,
      verdict: group.verdict,
      caught,
      volume: group.volume,
      stats: group.stats,
    });
  }

  const positives = rows.filter((r) => r.defect !== null);
  const negatives = rows.filter((r) => r.defect === null);

  const truePositives = positives.filter((r) => r.caught).length;
  const falseNegatives = positives.length - truePositives;
  const falsePositives = negatives.filter((r) => !r.caught).length;
  const trueNegatives = negatives.length - falsePositives;

  const precision = truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : null;

  const recall = positives.length > 0
      ? truePositives / positives.length
      : null;

  return {
    rows,
    confusion: {
      truePositives,
      falseNegatives,
      falsePositives,
      trueNegatives,
    },
    precision,
    recall,
  };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const green = (t) => `\u001b[32m${t}\u001b[0m`;
const red = (t) => `\u001b[31m${t}\u001b[0m`;
const dim = (t) => `\u001b[2m${t}\u001b[0m`;

async function main() {
  const { size, flags } = parseArgs(process.argv.slice(2));

  if (flags.has('--help')) {
    console.log(HELP);
    return 0;
  }

  const geo = await initGeoIP();

  if (!geo.ok) {
    console.error(red(`GeoIP required for a coherent baseline: ${geo.error}`));
    return 1;
  }

  const { events, labels } = buildCorpus({ size });

  const report = analyze(events, { authorized: {} });
  const result = score(report, labels);

  if (flags.has('--json')) {
    console.log(JSON.stringify({
      size,
      events: events.length,
      confusion: result.confusion,
      precision: result.precision,
      recall: result.recall,
      rows: result.rows,
    }, null, 2));

    return 0;
  }

  console.log(`corpus: ${events.length} events, ${result.rows.length} cohorts, ${size} each`);
  console.log('');

  const pad = (s, n) => String(s).padEnd(n);

  console.log(
      dim(pad('cohort', 18)) + dim(pad('defect', 44)) +
      dim(pad('expected', 18)) + dim('result'),
  );

  for (const row of result.rows) {
    const mark = row.caught ? green('caught') : red('MISSED');

    console.log(
        pad(row.cohort, 18) +
        pad(String(row.defect ?? '(none — baseline)').slice(0, 42), 44) +
        pad(row.expected, 18) +
        `${mark}  ${dim(row.raised.join(',') || '-')}`,
    );
  }

  console.log('');
  console.log('confusion matrix');
  console.log(`  true positives  : ${result.confusion.truePositives}`);
  console.log(`  false negatives : ${result.confusion.falseNegatives}`);
  console.log(`  false positives : ${result.confusion.falsePositives}   <- clean traffic wrongly accused`);
  console.log(`  true negatives  : ${result.confusion.trueNegatives}`);
  console.log('');
  console.log(
      `  precision : ${result.precision === null ? '-' : result.precision.toFixed(3)}` +
      `   (of everything accused, how much was really broken)`,
  );
  console.log(
      `  recall    : ${result.recall === null ? '-' : result.recall.toFixed(3)}` +
      `   (of everything broken, how much was caught)`,
  );

  if (flags.has('--verbose')) {
    console.log('');
    console.log('per-cohort signals');
    for (const row of result.rows) {
      console.log(`  ${row.cohort} (${row.volume} events, verdict ${row.verdict})`);
      if (row.raised.length === 0) console.log('    (none)');
      for (const code of row.raised) console.log(`    ${code}`);
      if (row.stats.httpIncoherentShare !== null) {
        console.log(`    httpIncoherentShare=${row.stats.httpIncoherentShare}`);
      }
    }
  }

  return result.confusion.falsePositives > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith('corpus.mjs')) {
  main()
      .then((code) => { process.exitCode = code; })
      .catch((error) => {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
      });
}
