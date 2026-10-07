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
    // Every test seller is onboarded, so unauthorized_seller should NOT fire —
    // isolating the IP/schedule signals as the thing being measured.
    publishers: new Set(['TEST-FRAUD-SELLER', 'TEST-HONEST-SELLER', 'TEST-DC-SELLER', 'TEST-MISMATCH-SELLER']),
    asi: new Set(['test-ssp.example']),
  },
};

const report = analyze(events, ctx);
const codesFor = (seller) =>
  (report.bySeller.find((s) => s.seller === seller)?.signals ?? []).map((s) => `${s.code}:${s.level}`);

// Expected outcome per seller. Note the headline finding: the residential
// fraud pattern produces ONLY flags (schedule_seller), never a block — exactly
// the "servable-but-flagged" gap PLAN.md predicts.
const expect = [
  { seller: 'TEST-FRAUD-SELLER', has: ['schedule_seller:flag'], hasNot: ['datacenter_seller:block', 'mismatch_seller:block'] },
  { seller: 'TEST-HONEST-SELLER', has: [], hasNot: ['datacenter_seller:block', 'mismatch_seller:block', 'schedule_seller:flag'] },
  { seller: 'TEST-DC-SELLER', has: ['datacenter_seller:block'], hasNot: [] },
  { seller: 'TEST-MISMATCH-SELLER', has: ['mismatch_seller:block'], hasNot: [] },
];

let failures = 0;
console.log('=== detector report ===');
for (const s of report.bySeller) {
  console.log(`\n${s.seller}  [${s.verdict}]  n=${s.volume}`);
  console.log('  stats:', JSON.stringify(s.stats));
  console.log('  signals:', s.signals.length ? s.signals.map((x) => `${x.code}(${x.level}) ${x.detail}`).join(' | ') : '(none)');
}

console.log('\n=== assertions ===');
for (const e of expect) {
  const got = codesFor(e.seller);
  for (const code of e.has) {
    const ok = got.includes(code);
    if (!ok) failures += 1;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${e.seller} should flag ${code}`);
  }
  for (const code of e.hasNot) {
    const ok = !got.includes(code);
    if (!ok) failures += 1;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${e.seller} should NOT flag ${code}`);
  }
}

console.log(`\nsummary: ${JSON.stringify(report.summary)}`);
console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nall assertions passed');
process.exit(failures ? 1 : 0);
