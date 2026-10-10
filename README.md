# ssp-work

A standalone **SSP load / red-team tool** for stress-testing the ADX exchange's
IVT (invalid-traffic) detection. It acts as an onboarded supply partner: relays
OpenRTB auction requests (varied UA + US residential IPs) to a configurable
endpoint and fires the sealed impression pixel on each win — so we can measure
how much of a residential-device-farm pattern our own IVT catches, and harden it.

See **[PLAN.md](PLAN.md)** for purpose, safety invariants and architecture.

## Everything lives in one config file: `config/config.json`

```jsonc
{
  "url": "http://localhost:8080/openrtb2/auction?key=<x-adx-key>", // one variable: full URL incl. the account key
  "load": {
    "qps": 10,                                              // requests per second
    "winRate": { "min": 0.01, "max": 0.10 },               // random win rate per request inside [min,max]
    "stopAfter": { "impressions": 1000, "requests": null, "seconds": null }, // first target hit stops the run
    "maxInFlight": 50
  },
  "traffic": {
    "formats": ["banner"],
    "bundle": "ai.socialapps.speakmaster",                 // the premium app under test
    "appName": "SpeakMaster",
    "fireImpressions": true,
    "sellers": [ { "publisherId": "nb-seller-farm", "weight": 1 } ] // the IVT "seller" (app.publisher.id)
  },
  "inputs": { "ipPoolFile": "data/ip_pool.json", "uaFile": "data/user_agents.csv" },
  "control": { "port": 8200 }
}
```

Win rate is enforced on the supply side via the bid floor: a non-winnable request
carries a high floor, so the bid lands below it and the auction returns 204 (no
win, no impression). Realized win rate = wins / requests, and converges to the
range over a large run.

## Run

```bash
node src/ippool.mjs                     # once — build data/ip_pool.json (2000 US residential /24s)
export SSP_SUPPLY_KEY=<account x-adx-key>
./run.sh                                # runs with config/config.json, proxy enabled
#   live:  GET http://127.0.0.1:8200/status   POST http://127.0.0.1:8200/stop   (or Ctrl+C)
```

Always launch through `./run.sh` (or `npm run server`), never `node src/ssp-server.mjs`
directly — see the proxy section below for why.

## Request body logging

```bash
./run.sh --log-body                      # JSONL to logs/bodies.jsonl (default)
./run.sh --log-body -                    # JSONL to stdout
./run.sh --log-body out/bodies.jsonl --log-body-limit 500
./run.sh --log-body - --quiet | jq -c '.body'      # just the requests
```

One compact JSON object per line, so the stream stays greppable and pipeable:

```jsonc
{"t":"...","seq":1,"seller":"500301","winnable":true,
 "ip":"99.95.16.14","isp":"AT&T Internet","metro":"US/national",
 "body":{ /* the exact OpenRTB request sent */ }}
```

`--log-body-limit` (default 100) caps how many bodies are written, so a long
run cannot fill the disk.

## Proxy (Proxy-Cheap residential)

**Two traps here. Both were live bugs.**

1. **Node's `fetch` ignores `HTTP_PROXY` unless the process is started with
   `--use-env-proxy`.** Without it every request goes direct — the proxy
   looks configured while your own IP is exposed. Verified: with bad
   credentials and a dead port the request still succeeded, proving the
   proxy was being bypassed entirely.

2. **Node reads `HTTP_PROXY` once at startup.** Exporting it afterwards —
   including via `process.loadEnvFile` or `process.env.X = ...` — has *no
   effect*. This is why the original `spawnSync` approach set the variables
   on the child process: that was the only place it worked.

`run.sh` handles both by exporting the variables in the shell *before*
`exec node --use-env-proxy`. Check it any time with:

```bash
npm run proxy          # preflight + rotation test
```

A proxy that is configured but bypassed is worse than none, so the server
runs this check at startup and shouts if the proxy is not in effect.

### Country targeting is NOT working

`PROXY_COUNTRY=US` has no effect. Appending `_country-US` (or any other
suffix) to the username makes the gateway answer
**`401 Unauthorized — Invalid credentials`**; the username must match
exactly what was issued. Observed exits are a random global mix:

```
RU/91.240.113.167/Lys'va   IN/223.191.38.112/Kolkata   BR/201.81.2.129/São Paulo
```

Fix it in the **Proxy-Cheap dashboard → Setup Credentials**: pick the country
(and session type) there, then copy the generated username into `.env` as
`PROXY_USER`. Do not append suffixes by hand.

### Rotation is per-process, not per-request

Within one process the exit IP is sticky; a fresh process gets a fresh IP.
That is actually convenient for an auction + impression pair — both come
from the same IP, which is what the exchange expects. `NO_PROXY` is set to
`127.0.0.1,localhost,::1` so the local mock exchange stays reachable while
the proxy is active.

## CLI overrides (optional — config is the source of truth)

| Flag | Overrides |
|---|---|
| `--url U` | `endpoint.auctionUrl` |
| `--qps N` | `load.qps` |
| `--win-min P` `--win-max P` | `load.winRate` |
| `--imp N` | stop after N impressions |
| `--requests N` | stop after N requests |
| `--duration S` | stop after S seconds |
| `--format banner\|video` | impression format |
| `--no-imp` | don't fire impressions (auction only) |
| `--seller ID` | `app.publisher.id` |
| `--log-body [FILE]` | write request bodies as JSONL (`-` = stdout) |
| `--log-body-limit N` | max bodies to write (default 100) |
| `--verbose` / `--quiet` / `--port P` | logging / control port |

## Time to target

`impressions / (avg win rate × qps)`. e.g. 1000 impressions at qps 10, win rate
1–10% (avg ~5.5%) → ~18k requests → **~30 min**. Raise `qps` or `winRate`, or
lower the target, to go faster.

## Local internal testing (no exchange needed)

Two tools let you build and exercise requests entirely on localhost.

**1. Generate a bid request**

```bash
node src/generate.mjs                                   # random fixture, full report
node src/generate.mjs --json > /tmp/req.json            # raw JSON only, pipeable
node src/generate.mjs --ua SM-S938U --ip 73.253.207.155 # reproducible fixture
node src/generate.mjs --count 50 --quiet --strict       # fail if any is invalid
```

Every request is self-consistent by construction and validated against OpenRTB
2.6 rules before it is printed. `--strict` exits non-zero on any error, which
makes it usable as a pre-flight check in a script or CI step.

**2. Run the mock exchange**

```bash
node src/mock-exchange.mjs                # http://127.0.0.1:8080
```

It validates every incoming request with the *same* validator, rejects invalid
ones with `400` + reasons, returns `204` for a no-bid, and returns a real bid
with a sealed `/t/imp?e=` pixel on a win. Open
[http://127.0.0.1:8080/](http://127.0.0.1:8080/) for a live dashboard showing
accepted/rejected requests, device models, IPs, geo and fired impressions.

**3. Exercise the whole funnel**

```bash
# config/config.json already points at 127.0.0.1:8080
node src/mock-exchange.mjs &
node src/ssp-server.mjs --qps 10 --imp 50

# or a single request straight through
node src/generate.mjs --send http://127.0.0.1:8080/openrtb2/auction
```

Inspect what actually arrived:

```bash
curl -s http://127.0.0.1:8080/stats     | jq
curl -s http://127.0.0.1:8080/requests  | jq '.[-1].request'
curl -s http://127.0.0.1:8080/events    | jq '[.[] | select(.type=="impression")]'
```

## GeoIP (MaxMind GeoLite2)

`device.geo` is looked up from a real **GeoLite2-City** database at
`data/GeoLite2-City.mmdb` (override with `GEOIP_DB`). The database is not
committed — drop your own copy in `data/`.

This matters because the exchange geolocates `device.ip` itself. If the geo
in the body disagrees with the address it came from, that is the mismatch IVT
detection looks for. So the lookup is the **only** source of `device.geo`;
the pool's metro token is used solely as a coarse fallback (country + region,
no coordinates) when the database has no record for an address.

Validate the pool against the database and see where its CIDR-level guesses
are wrong:

```bash
npm run geo            # sample 100 pool IPs
npm run geo-all        # every IP in the pool
node src/geo-check.mjs --samples 200 --proxy
```

Findings on the current pool:

| Check | Result |
|---|---|
| Resolves to a non-US country | **~3%** (CA, IE, SG — e.g. `99.80.113.11` is Dublin) |
| City claims confirmed | **~5%** — e.g. `76.243.42.105` claims Dallas, resolves to Dayton, OH |

The validator cross-checks `device.geo` against `device.ip` for every request,
so a wrong city/region/country is now a hard **error**, and coordinates more
than ~165km off are a warning. That check is what would have caught the pool's
bad city claims before they were sent.

Note: GeoLite2-**City** contains no ISP field, so the pool's ISP labels cannot
be verified with it. Add a GeoLite2-ASN database if you want that check.

## What the builder guarantees

These invariants are enforced in code, not by convention:

| Invariant | Why it matters |
|---|---|
| `device.geo` comes from the GeoLite2 lookup of `device.ip` | The exchange geolocates the same address; a disagreement is a mismatch signal |
| IP, ISP and metro come from the **same** pool entry | Keeps the request internally consistent |
| `carrier` / `mccmnc` / `connectiontype` agree with the ISP | Comcast is fixed-line (wifi, no mccmnc); only a real mobile ISP gets a mobile network code |
| Coordinates are omitted when the database has no city | A precise lat/lon the IP does not resolve to is worse than none |
| `ifa` is stable per (publisher, device) fixture | A fresh advertising ID per request is a primary fraud signal |
| `user.id` is stable per device fixture | Same reason |
| `app.id` is stable | Same reason |
| No test markers on the wire | `test`, `ext.qa`, `device.ext.qa` are off by default |

## Matching real traffic

Requests are shaped to blend with genuine traffic from this exchange rather
than stand out as synthetic. The reference set is
`afront-banner-android-clean-requests.json` (10 captured production requests).

**Test markers removed** — the detection system flags and ignores these:

| Marker | Before | Now |
|---|---|---|
| `test` | always `1` | absent |
| `ext.qa` | always present | absent |
| `device.ext.qa` | always present | absent |
| `x-qa-test` header | sent on auction + pixel | not sent |

Set `traffic.qaExt: true` to put them back when you deliberately want
identifiable traffic. The validator warns if any reappear.

**Values aligned to the reference:**

| Field | Before | Now |
|---|---|---|
| `id` | UUID | 21–22 char hex (ObjectId shaped) |
| `at` | 1 | 2 (second price plus) |
| `source.fd` | 0 | 1 |
| `device.os` | `Android` | `android` |
| `source.ext.schain` | *(was at `source.schain` — wrong location)* | correct, 1–2 nodes |
| `user.id` | absent | stable per device |
| `device.geofetch` | absent | `0` |
| `regs.ext.gdpr` | absent | `0` |
| `app` | one fixed app | 10-app portfolio, weighted |

**App portfolio** lives in `src/traffic.mjs`, weighted by observed share:
publisher `500174` serves 9 apps over a 1-node `afront.io` chain; publisher
`500243` serves one app behind a 2-node `bidmachine.io → afront.io` chain.

> **Replace the fixtures with your own inventory before pointing at a live
> endpoint.** These are real third-party apps; attributing traffic to an app
> you do not own is what makes it fraudulent rather than a test.

**Two deliberate deviations from the reference**, both spec-correctness:

- `device.geo.country` is `USA` (alpha-3) where the reference used `US`
  (alpha-2). OpenRTB specifies alpha-3.
- `device.mccmnc` is `310-260` where one reference request carried the literal
  string `T-Mobile`. The field is defined as `MCC-MNC`.

## Files

- `config/config.json` — the one file you manage.
- `data/user_agents.csv` — device profiles (UAs).
- `data/isp_ranges.json` — US residential ISP ranges used to generate the pool.
- `data/ip_pool.json` — generated pool (git-ignored).
- `data/GeoLite2-City.mmdb` — GeoIP database (git-ignored; supply your own).
- `src/ippool.mjs` — pool generator.
- `src/ssp-server.mjs` — the load-testing server (entry point).
- `src/req.mjs` — OpenRTB 2.6 request builder + transport.
- `src/geo.mjs` — MaxMind GeoLite2 lookup (the source of `device.geo`).
- `src/metros.mjs` — metro token → geo fallback mapping.
- `src/validate.mjs` — OpenRTB 2.6 validator, incl. geo↔IP coherence.
- `src/generate.mjs` — request generator CLI.
- `src/geo-check.mjs` — pool validation against the GeoIP database.
- `src/proxy-check.mjs` — proxy preflight and rotation test.
- `src/mock-exchange.mjs` — local mock exchange.
- `src/traffic.mjs` — real app/schain fixtures (replace with your inventory).
- `src/uas.mjs` — UA corpus loader.

## Pointing at production

Change `endpoint.auctionUrl` + the key. **Non-negotiable:** on prod the demand
side must be sealed first (no real DSP called, no real advertiser billed, fully
reversible + audited). See PLAN.md safety invariants. Also note the local
`data/ip_pool.json` is generated and not guaranteed clean — verify residential
IPs against real reputation before relying on them.
