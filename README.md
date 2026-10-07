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
node src/ssp-server.mjs                 # runs with config/config.json
#   live:  GET http://127.0.0.1:8200/status   POST http://127.0.0.1:8200/stop   (or Ctrl+C)
```

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
| `--verbose` / `--quiet` / `--port P` | logging / control port |

## Time to target

`impressions / (avg win rate × qps)`. e.g. 1000 impressions at qps 10, win rate
1–10% (avg ~5.5%) → ~18k requests → **~30 min**. Raise `qps` or `winRate`, or
lower the target, to go faster.

## Files

- `config/config.json` — the one file you manage.
- `data/user_agents.csv` — device profiles (UAs).
- `data/isp_ranges.json` — US residential ISP ranges used to generate the pool.
- `data/ip_pool.json` — generated pool (git-ignored).
- `src/ippool.mjs` / `src/ssp-server.mjs` — pool generator / the server (entry point).
- `src/request.mjs` / `src/uas.mjs` — helpers.

## Pointing at production

Change `endpoint.auctionUrl` + the key. **Non-negotiable:** on prod the demand
side must be sealed first (no real DSP called, no real advertiser billed, fully
reversible + audited). See PLAN.md safety invariants. Also note the local
`data/ip_pool.json` is generated and not guaranteed clean — verify residential
IPs against real reputation before relying on them.
