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
const DATACENTER_CIDR = ['192.0.2.0/24', '2001:db8::/32']; // reserved v4/v6 doc space used as "datacenter" in tests

// Distinct /24 per seed: 10.0.<seed>.x. Request and matching impression share it.
const resIp = (seed) => `10.0.${seed % 256}.${(seed % 253) + 1}`;
// A guaranteed-different /24 from resIp(seed), for the mismatch control.
const otherNetIp = (seed) => `10.9.${seed % 256}.${(seed % 253) + 1}`;
const dcIp = (seed) => `192.0.2.${(seed % 254) + 1}`;
// Distinct IPv6 /64 per seed, inside the 2001:db8::/32 doc prefix.
const v6Ip = (seed) => `2001:db8:0:${(seed % 0x10000).toString(16)}::1`;
// Reserved / non-routable space (240.0.0.0/4) — a "bogon", no real user has one.
const bogonIp = (seed) => `240.0.${seed % 256}.${(seed % 253) + 1}`;

// Deterministic, obviously-fake but UUID-shaped device ID, so the validity
// checks don't trip on the baseline cohorts. Version/variant literals keep it
// from ever being the all-zeros opt-out value.
const nib = (seed, len) => (seed >>> 0).toString(16).padStart(8, '0').repeat(2).slice(0, len);
const fakeUuid = (seed) => `${nib(seed, 8)}-${nib(seed + 1, 4)}-4${nib(seed + 2, 3)}-8${nib(seed + 3, 3)}-${nib(seed + 4, 12)}`;

const mkReq = ({ pub, bundle, ip, ifa, asi = 'test-ssp.example', storeurl, schainSid = pub }) => ({
  id: `test-${ifa}`,
  app: {
    bundle,
    domain: `${bundle}.example`,
    storeurl, // undefined on most cohorts -> coherence check is skipped
    publisher: { id: pub },
  },
  device: {
    ip,
    ua: 'Mozilla/5.0 (Linux; Android 14) TEST-FIXTURE',
    os: 'Android',
    ifa,
  },
  source: { ext: { schain: { complete: 1, nodes: [{ asi, sid: schainSid }] } } },
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
      request: mkReq({ pub: 'TEST-FRAUD-SELLER', bundle: 'com.example.premiumapp', ip, ifa: fakeUuid(i) }),
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
      request: mkReq({ pub: 'TEST-HONEST-SELLER', bundle: bundles[i % bundles.length], ip, ifa: fakeUuid(i + 500) }),
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
      request: mkReq({ pub: 'TEST-DC-SELLER', bundle: 'com.example.premiumapp', ip, ifa: fakeUuid(i + 1000) }),
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
      request: mkReq({ pub: 'TEST-MISMATCH-SELLER', bundle: 'com.example.premiumapp', ip, ifa: fakeUuid(i + 2000) }),
    });
  }

  // 5) Zeroed / junk device IDs -> invalid_ifa_seller (and ifa_lmt_mismatch,
  //    since lmt isn't set). Valid-but-reused IDs are a separate cohort below.
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i + 2500);
    const ifa = i % 5 === 0 ? 'not-a-real-uuid' : '00000000-0000-0000-0000-000000000000';
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'zeroed_ifa',
      request: mkReq({ pub: 'TEST-ZEROIFA-SELLER', bundle: 'com.example.premiumapp', ip, ifa }),
    });
  }

  // 6) A few VALID device IDs reused across many /24s (device farm) ->
  //    ifa_reuse_seller. Shape is valid, so invalid_ifa_seller does NOT fire.
  const farmIfas = [fakeUuid(90001), fakeUuid(90002), fakeUuid(90003)];
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i + 4000);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'ifa_reuse',
      request: mkReq({ pub: 'TEST-REUSE-SELLER', bundle: 'com.example.premiumapp', ip, ifa: farmIfas[i % farmIfas.length] }),
    });
  }

  // 7) Supply chain that doesn't name the declared seller: the terminal schain
  //    sid != app.publisher.id -> schain_inconsistent.
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i + 5000);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'schain_mismatch',
      request: mkReq({ pub: 'TEST-SCHAIN-SELLER', bundle: 'com.example.premiumapp', ip, ifa: fakeUuid(i + 5000), schainSid: 'SOMEONE-ELSE' }),
    });
  }

  // 8) Store URL that references a different bundle than app.bundle
  //    (bundle spoofing) -> bundle_incoherent.
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i + 6000);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'bundle_spoof',
      request: mkReq({
        pub: 'TEST-BUNDLE-SELLER',
        bundle: 'com.example.premiumapp',
        ip,
        ifa: fakeUuid(i + 6000),
        storeurl: 'https://play.google.com/store/apps/details?id=com.example.somethingelse',
      }),
    });
  }

  // 9) Publisher-id rotation: the SAME premium bundle and the SAME
  //    night/residential pattern, but a fresh publisher id every 2 events. Per
  //    publisher it's invisible (volume 2, far below minVolume); aggregated by
  //    `bundle` it's the fraud pattern. This is the case that defeats
  //    publisher-only aggregation.
  for (let i = 0; i < n; i += 1) {
    const ip = resIp(i + 7000);
    events.push({
      ts: NIGHT_NY,
      won: true,
      impressionIp: ip,
      truth: 'rotation',
      request: mkReq({ pub: `ROTATE-${Math.floor(i / 2)}`, bundle: 'com.example.rotatedapp', ip, ifa: fakeUuid(i + 7000) }),
    });
  }

  // 10) IPv6 datacenter traffic -> datacenter_seller (block). Proves the v6 path
  //     is actually exercised: a v6-only parser would silently skip these.
  for (let i = 0; i < n; i += 1) {
    const ip = v6Ip(i);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'datacenter',
      request: mkReq({ pub: 'TEST-IPV6-DC-SELLER', bundle: 'com.example.premiumapp', ip, ifa: fakeUuid(i + 8000) }),
    });
  }

  // 11) Reserved / non-routable source IPs (240.0.0.0/4) -> bogon_seller. The
  //     request claims an address no real user can have ("doesn't exist").
  for (let i = 0; i < n; i += 1) {
    const ip = bogonIp(i);
    events.push({
      ts: DAY_NY,
      won: true,
      impressionIp: ip,
      truth: 'bogon',
      request: mkReq({ pub: 'TEST-BOGON-SELLER', bundle: 'com.example.premiumapp', ip, ifa: fakeUuid(i + 9000) }),
    });
  }

  return { events, ranges: { residential: RESIDENTIAL_CIDR, datacenter: DATACENTER_CIDR } };
}
