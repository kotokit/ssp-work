// Score the detector against the synthetic fixtures and show (a) how a
// publisher-id-rotation attack tanks recall in the publisher dimension but is
// recovered in the bundle dimension, and (b) the nightShare threshold sweep.
//
//   node src/metrics-report.mjs
//
// The point is the harness: aim the same code at replayed production events,
// labeled by past analyst actions, and these numbers become a real measurement.

import { analyze, DIMENSIONS } from './detector.mjs';
import { buildFixtures } from './fixtures.mjs';
import { groundTruthByKey, confusion, sweep } from './metrics.mjs';

const { events, ranges } = buildFixtures({ n: 120 });

const ctx = {
  residentialRanges: ranges.residential,
  datacenterRanges: ranges.datacenter,
  authorized: {
    publishers: new Set([
      'TEST-FRAUD-SELLER', 'TEST-HONEST-SELLER', 'TEST-DC-SELLER',
      'TEST-MISMATCH-SELLER', 'TEST-ZEROIFA-SELLER', 'TEST-REUSE-SELLER',
      'TEST-SCHAIN-SELLER', 'TEST-BUNDLE-SELLER', 'TEST-IPV6-DC-SELLER',
      ...Array.from({ length: 60 }, (_, k) => `ROTATE-${k}`),
    ]),
    asi: new Set(['test-ssp.example']),
  },
};

// Everything except the honest baseline is a group we expect to catch.
const POSITIVE = new Set([
  'fraud_residential', 'datacenter', 'mismatch', 'zeroed_ifa', 'ifa_reuse',
  'schain_mismatch', 'bundle_spoof', 'rotation', 'bogon',
]);

console.log('=== confusion by dimension ===');
console.log('(publisher-id rotation evades the publisher dimension; the shared bundle is caught in the bundle dimension)\n');
for (const dim of ['publisher', 'bundle']) {
  const report = analyze(events, ctx, { dimension: dim });
  const truth = groundTruthByKey(events, POSITIVE, DIMENSIONS[dim]);
  console.log(`  ${dim.padEnd(10)}`, confusion(report, truth));
}

console.log('\n=== nightShare threshold sweep (publisher dimension) ===');
console.log('(honest baseline sits at nightShare 0.5 — loosen below that and it becomes a false positive)');
const truthPub = groundTruthByKey(events, POSITIVE, DIMENSIONS.publisher);
for (const row of sweep(events, ctx, { key: 'nightShare', values: [0.9, 0.7, 0.6, 0.5, 0.4] }, truthPub)) {
  console.log(' ', JSON.stringify(row));
}
