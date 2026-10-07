// Offline test runner: feed synthetic fixtures to the detector and assert it
// flags the fraud cohorts and leaves the honest baseline alone. No network.
//
//   node src/detect-test.mjs
//
// This is your repeatable baseline (PLAN.md P5): re-run it after any rule change
// to see what the detector catches and to confirm the true-negative holds.

import { analyze } from './detector.mjs';
import { buildFixtures } from './fixtures.mjs';

const { events, ranges } = buildFixtures({ n: 120 });

const ctx = {
  residentialRanges: ranges.residential,
  datacenterRanges: ranges.datacenter,
  authorized: {
    // Every test seller is onboarded (including the rotated sub-ids), so
    // unauthorized_seller should NOT fire — isolating the other signals.
    publishers: new Set([
      'TEST-FRAUD-SELLER', 'TEST-HONEST-SELLER', 'TEST-DC-SELLER',
      'TEST-MISMATCH-SELLER', 'TEST-ZEROIFA-SELLER', 'TEST-REUSE-SELLER',
      'TEST-SCHAIN-SELLER', 'TEST-BUNDLE-SELLER', 'TEST-IPV6-DC-SELLER', 'TEST-BOGON-SELLER',
      ...Array.from({ length: 60 }, (_, k) => `ROTATE-${k}`),
    ]),
    asi: new Set(['test-ssp.example']),
  },
};

const byPublisher = analyze(events, ctx); // dimension: publisher (default)
const byBundle = analyze(events, ctx, { dimension: 'bundle' });

const codesIn = (report, key) =>
  (report.groups.find((g) => g.key === key)?.signals ?? []).map((s) => `${s.code}:${s.level}`);

// { report, rlabel, key, has, hasNot }. Note the headline findings:
//  - TEST-FRAUD-SELLER surfaces ONLY as a flag (servable-but-flagged).
//  - TEST-IPV6-DC-SELLER blocks -> the IPv6 path is exercised, not skipped.
//  - ROTATE-* is invisible in the publisher dimension but the shared bundle
//    (com.example.rotatedapp) is caught in the bundle dimension.
const expect = [
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-FRAUD-SELLER', has: ['schedule_seller:flag'], hasNot: ['datacenter_seller:block', 'mismatch_seller:block', 'invalid_ifa_seller:flag', 'ifa_reuse_seller:flag'] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-HONEST-SELLER', has: [], hasNot: ['datacenter_seller:block', 'mismatch_seller:block', 'schedule_seller:flag', 'invalid_ifa_seller:flag', 'ifa_reuse_seller:flag'] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-DC-SELLER', has: ['datacenter_seller:block'], hasNot: [] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-MISMATCH-SELLER', has: ['mismatch_seller:block'], hasNot: [] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-ZEROIFA-SELLER', has: ['invalid_ifa_seller:flag', 'ifa_lmt_mismatch:flag'], hasNot: ['ifa_reuse_seller:flag'] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-REUSE-SELLER', has: ['ifa_reuse_seller:flag'], hasNot: ['invalid_ifa_seller:flag'] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-SCHAIN-SELLER', has: ['schain_inconsistent:flag'], hasNot: ['bundle_incoherent:flag', 'unauthorized_seller:flag'] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-BUNDLE-SELLER', has: ['bundle_incoherent:flag'], hasNot: ['schain_inconsistent:flag'] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-IPV6-DC-SELLER', has: ['datacenter_seller:block'], hasNot: [] },
  { report: byPublisher, rlabel: 'publisher', key: 'TEST-BOGON-SELLER', has: ['bogon_seller:block'], hasNot: ['datacenter_seller:block'] },
  { report: byPublisher, rlabel: 'publisher', key: 'ROTATE-0', has: [], hasNot: ['schedule_seller:flag'] },
  { report: byBundle, rlabel: 'bundle', key: 'com.example.rotatedapp', has: ['schedule_seller:flag'], hasNot: [] },
];

let failures = 0;
console.log('=== detector report (publisher dimension) ===');
for (const g of byPublisher.groups.filter((x) => !x.key.startsWith('ROTATE-'))) {
  console.log(`\n${g.key}  [${g.verdict}]  n=${g.volume}`);
  console.log('  signals:', g.signals.length ? g.signals.map((x) => `${x.code}(${x.level})`).join(' | ') : '(none)');
}
console.log(`\n(+ 60 ROTATE-* publisher groups, each n=2 -> all clean: rotation is invisible here)`);

console.log('\n=== assertions ===');
for (const e of expect) {
  const got = codesIn(e.report, e.key);
  for (const code of e.has) {
    const ok = got.includes(code);
    if (!ok) failures += 1;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] (${e.rlabel}) ${e.key} should flag ${code}`);
  }
  for (const code of e.hasNot) {
    const ok = !got.includes(code);
    if (!ok) failures += 1;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] (${e.rlabel}) ${e.key} should NOT flag ${code}`);
  }
}

console.log(`\npublisher summary: ${JSON.stringify(byPublisher.summary)}`);
console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
