// Synthetic test inputs for the detector. These are NOT traffic — they are
// labeled event objects a test feeds straight into analyze(). There is no
// network sender in this file and nothing here is pointed at an exchange.
//
// Everything is deliberately fake and non-deployable:
//   - bundles/domains are com.example.* (RFC 2606 example space),
//   - "residential" IPs come from 10.0.0.0/8 (RFC 1918 private space) so a test
//     can mint many distinct /24s — the real pattern spreads over thousands of
//     them — and "datacenter" IPs from 192.0.2.0/24 (RFC 5737 doc space). None
//     are publicly routable.
//   - device IDs are obviously-fake counters, not real IFAs.
// The point is to carry the *pattern* the detector must catch, not to resemble
// any real app, seller, or line of traffic.

const RESIDENTIAL_CIDR = ['10.0.0.0/8']; // reserved space used as "residential" in tests
const DATACENTER_CIDR = ['192.0.2.0/24']; // reserved doc space used as "datacenter" in tests

// Distinct /24 per seed: 10.0.<seed>.x. Request and matching impression share it.
const resIp = (seed) => `10.0.${seed % 256}.${(seed % 253) + 1}`;
// A guaranteed-different /24 from resIp(seed), for the mismatch control.
const otherNetIp = (seed) => `10.9.${seed % 256}.${(seed % 253) + 1}`;
const dcIp = (seed) => `192.0.2.${(seed % 254) + 1}`;

const mkReq = ({ pub, bundle, ip, ifa, asi = 'test-ssp.example' }) => ({
  id: `test-${ifa}`,
  app: {
    bundle,
    domain: `${bundle}.example`,
    publisher: { id: pub },
  },
  device: {
    ip,
    ua: 'Mozilla/5.0 (Linux; Android 14) TEST-FIXTURE',
    os: 'Android',
    ifa,
  },
  source: { ext: { schain: { nodes: [{ asi, sid: pub }] } } },
});

// A fixed NY-night and a fixed daytime instant (UTC offsets chosen so the
// detector's America/New_York conversion lands in / out of 00:00-07:00).
const NIGHT_NY = Date.UTC(2026, 0, 15, 7, 30); // 02:30 EST
const DAY_NY = Date.UTC(2026, 0, 15, 18, 0); // 13:00 EST

/**
 * Build the test corpus: a fraud-pattern cohort and an honest baseline, plus
 * two small positive-control cohorts so the block paths are exercised too.
 * Each event carries `truth` for the runner to assert against.
 */
export function buildFixtures({ n = 120 } = {}) {
  const events = [];

  // 1) The pattern under test: residential IPs across many /24s, impression IP
  //    == request IP, ONE premium bundle, many device profiles, concentrated in
  //    NY night. Expectation (PLAN.md): datacenter/ip_mismatch do NOT fire; it
  //    surfaces only as flags (schedule_seller) -> "servable-but-flagged".
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i);
    events.push({
      ts: NIGHT_NY,
      won: true,
      impressionIp: ip, // same line -> no ip_mismatch (the evasion)
      truth: 'fraud_residential',
      request: mkReq({ pub: 'TEST-FRAUD-SELLER', bundle: 'com.example.premiumapp', ip, ifa: `fraud-ifa-${i}` }),
    });
  }

  // 2) Honest baseline: varied bundles, IPs spread over many /24s, ~half
  //    daytime, diverse devices. Must come back clean (true-negative).
  const bundles = ['com.example.news', 'com.example.weather', 'com.example.puzzle', 'com.example.radio'];
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i + 500); // a different band of /24s from the fraud cohort
    events.push({
      ts: i % 2 ? DAY_NY : NIGHT_NY, // ~half daytime -> below night threshold
      won: true,
      impressionIp: ip,
      truth: 'baseline',
      request: mkReq({ pub: 'TEST-HONEST-SELLER', bundle: bundles[i % bundles.length], ip, ifa: `honest-ifa-${i}` }),
    });
  }

  // 3) Positive control A — datacenter IPs -> datacenter_seller (block).
  for (let i = 0; i < n; i += 1) {
    const ip = dcIp(i);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'datacenter',
      request: mkReq({ pub: 'TEST-DC-SELLER', bundle: 'com.example.premiumapp', ip, ifa: `dc-ifa-${i}` }),
    });
  }

  // 4) Positive control B — impression fired from a different /24 -> mismatch_seller (block).
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: otherNetIp(i), // different /24 from the request
      truth: 'mismatch',
      request: mkReq({ pub: 'TEST-MISMATCH-SELLER', bundle: 'com.example.premiumapp', ip, ifa: `mm-ifa-${i}` }),
    });
  }

  return { events, ranges: { residential: RESIDENTIAL_CIDR, datacenter: DATACENTER_CIDR } };
}
