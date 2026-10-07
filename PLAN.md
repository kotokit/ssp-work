# SSP Integration Test Harness — Plan

**Purpose.** Validate our own invalid-traffic (IVT) detection against a known
evasion pattern — residential-IP in-app traffic — on a fully local, sealed copy
of the exchange, and leave a repeatable baseline we can re-run against any new
rule we build. This is a purple-team exercise on our own system: the point is to
find where detection does and does not fire, and to fix the gaps.

**Owner-facing question it answers:** does our IVT catch an app whose requests
come from thousands of real residential IPs with request-IP == impression-IP,
one premium bundle, many device profiles — or does it pass through as
servable-but-flagged? The honest expectation today is the latter (the NY-night
case is flag-only, and `unauthorized_seller` is flag-only), and that gap is the
finding.

---

## Safety invariants (must hold at all times)

1. **Local only.** Everything runs against the local Docker stack and local Node
   services. Production is never touched.
2. **Demand side is sealed.** No real DSP is ever called and no real advertiser
   is ever billed. Locally the only demand is the mock bidder (`127.0.0.1:8090`);
   every demand endpoint in the local registry is `127.0.0.1`. The onboarded test
   SSP carries no path to any external buyer.
3. **The publisher looks real to our own systems**, so the IVT job actually
   processes it (otherwise the test is void): a normal onboarded supply partner,
   realistic seller identity, not special-cased anywhere the IVT job skips.
4. **IP pool is generated data.** We hold residential proxy access and used it to
   confirm a real US residential egress, but the volume pool is generated (real
   US residential ISP ranges) and written onto `device.ip` and the impression
   `X-Forwarded-For`. No live user traffic is proxied.
5. **Fully reversible and audited.** Everything created (the test SSP account,
   generated events) can be disabled/removed; every exchange-side block it
   produces is a normal auto-block entry that can be lifted.

---

## Architecture

```
  ssp-work/ (this project, standalone, outside the exchange repo)
    src/ssp-server.mjs   runnable SSP client: picks a UA + a US residential IP,
                         POSTs /openrtb2/auction (x-adx-key), and on a win fires
                         the sealed /t/imp pixel with the SAME IP (XFF)
        |
        v
  EXCHANGE (local, real code path)
    core :8080     auth -> validate -> geo -> IVT gate -> route -> auction
    tracker :8081  /t/imp records the impression (measurement of record)
    mock DSP :8090 the ONLY demand (sealed)
    workers :8083  auto-block job = the detection under test
        |
        v
  Mongo / ClickHouse / Redis (local docker)  -> UI :3000 + API :4000 to observe
```

**Why this is a faithful test:**

- Request-time IVT reads `device.ip` from the payload; a residential IP there
  means `datacenter_ip` does not fire — the evasion property we are testing.
- The impression token binds the request's `device.ip` /24 (and, for web banners
  only, the UA). Our traffic is **in-app**, so only the IP /24 is checked. Firing
  the pixel from the same /24 keeps `ip_mismatch` from firing falsely — which is
  exactly the real pattern (request IP == impression IP).
- The "seller" the IVT rules judge is `app.publisher.id`. One publisher id is the
  test-subject seller; others are the honest baseline on the same account.

---

## Test subject vs. baseline (what the generator produces)

- **Test-subject seller** (`app.publisher.id` = one value): one premium bundle
  (`ai.socialapps.speakmaster`), many device profiles (UAs from the 1000-row
  CSV), many US residential /24s, request IP == impression IP per event.
- **Honest baseline seller(s)** (other publisher ids, same account): normal mix of
  bundles, IPs spread, so the subject stands out against "the others" exactly as
  the rules judge it. This is the true-negative check — the baseline must not be
  touched.

---

## Work plan / status

- [x] **P0 — Pre-flight (read-only).** Confirmed how the request IP is recorded
      and compared (payload `device.ip`; tracker `request.ip`; `/24` binding),
      and that the seller dimension is `app.publisher.id`.
- [x] **P1 — Sealed lane up (local).** Docker stack + core/tracker/mock running;
      every demand endpoint is local; one request proved the round trip and
      recorded `ivt_reasons = []` on a residential IP.
- [x] **P1b — Onboard the SSP the real way.** Created supply partner
      "Northbeam Media" via the Management API (server-generated key, margin 0.15,
      formats banner+video, `ivtMode: flag`, seller identity set). Key is held in
      env `SSP_SUPPLY_KEY`, not stored in the project.
- [~] **P2 — Build the SSP integration client** (`src/ssp-server.mjs`): runnable,
      config-driven, completes the funnel (fires `/t/imp`). IN PROGRESS.
- [ ] **P2b — Generated residential IP pool** (`src/ippool.mjs` ->
      `data/ip_pool.json`): many /24s across real US residential ISP ranges,
      plus the verified proxy anchor IP.
- [ ] **P2c — Enable impression-IP fidelity.** Restart the **tracker** with
      `GATEWAY_TRUST_PROXY=true` so it reads the residential IP from XFF (core,
      mock, API, UI untouched). This is the one process restart required.
- [ ] **P3 — Prove the seal (gate).** Send a handful; confirm only the mock DSP
      was called and real DSPs received zero. No volume until this passes.
- [ ] **P4 — Generate traffic** at a controlled rate; confirm auctions +
      impressions land with residential IPs and no false `ip_mismatch`.
- [ ] **P5 — Run detection + observe.** Start the workers auto-block job over the
      window and record what fired, against this table:

| Check | Expected on today's IVT |
|---|---|
| `datacenter_seller` | no block (residential) |
| `ip_mismatch` / `mismatch_seller` | no flag (request net == impression net) |
| `schedule_seller` (NY night) | flag, not block (flag-only rule) |
| `unauthorized_seller` | flag |
| honest baseline seller | nothing (true-negative) |

**Headline finding (expected):** the pattern passes through as
servable-but-flagged. If the honest baseline seller gets touched, the night rule
is too broad.

> Note on the NY-night element: `schedule_seller` judges by event timestamp in
> ClickHouse. Live traffic lands at "now", so the night-concentration case is
> only exercised when run during 00:00–07:00 America/New_York (or via a separate
> backdated-event mode). The live harness covers everything else end to end.

---

## How to run (once P2 is complete)

```bash
cd /Users/illia/Documents/AdExchange/ssp-work
node src/ippool.mjs                      # build data/ip_pool.json
export SSP_SUPPLY_KEY=<northbeam key>    # injected, never committed
node src/ssp-server.mjs --count 1 --verbose   # one request, prove the funnel
node src/ssp-server.mjs --rate 5              # continuous; GET :8200/status, POST :8200/stop
```

---

## Cleanup / reversibility

- Disable or delete the test SSP via the Management API.
- Generated events are confined to the local ClickHouse; the demo/test data can
  be dropped without affecting anything real.
- Any auto-block the test produces is an ordinary entry liftable from Traffic
  quality, and the tracker's `GATEWAY_TRUST_PROXY` is reverted by restarting it
  without the flag.
