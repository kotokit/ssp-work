# SSP Server — How to Run Tests on the Remote Server

## Prerequisites

```bash
# On the remote server (root@165.227.175.197)
cd /opt/ssp-work

# Sync latest code from git repo
cd /root/ssp-work && git pull origin master
cp -r /root/ssp-work/* /opt/ssp-work/
```

## Configuration Options

All tunable values live in `config/config.json`. CLI flags override only a subset of these.

### config.json fields

| Field | Description | Example |
|-------|-------------|---------|
| `load.qps` | Request starts per second | `10` |
| `load.winRate.min` | Minimum win probability (0–1) | `0.15` |
| `load.winRate.max` | Maximum win probability (0–1) | `0.25` |
| `load.proxyPoolSize` | Number of proxy sessions | `50` |
| `load.stopAfter.impressions` | Stop after N impression fires | `15` |
| `load.stopAfter.requests` | Stop after N auction launches | `100` |
| `load.maxInFlight` | Max concurrent requests | `50` |
| `load.cpmRange.min` | Bid floor for winnable auctions | `0.01` |
| `load.cpmRange.max` | Bid floor for non-winnable auctions | `0.10` |
| `load.clickDelay.min` | Min delay before click (ms) | `2000` |
| `load.clickDelay.max` | Max delay before click (ms) | `5000` |

### CLI flags (override config.json)

| Flag | Description |
|------|-------------|
| `--url URL` | Auction endpoint (overrides config) |
| `--qps N` | Request starts per second |
| `--win-min P` | Min win probability (0–1) |
| `--win-max P` | Max win probability (0–1) |
| `--imp N` | Stop after N impression fires |
| `--requests N` | Stop after N auction launches |
| `--duration S` | Stop after S seconds |
| `--format banner\|video` | Ad format |
| `--seller ID` | Use single publisher ID |
| `--max-in-flight N` | Max concurrent requests |
| `--port N` | Control API port |
| `--log-body [FILE]` | Log request bodies as JSONL |
| `--log-body-limit N` | Max bodies to log |
| `--verbose` | Log individual bid responses |
| `--browser` | Use headless Chromium for pixel rendering |
| `--quiet` | Disable periodic and startup logs |
| `--help` | Show help |

**Note:** `proxyPoolSize`, `clickDelay`, and `cpmRange` are **only** configurable via `config.json` — there are no CLI flags for them.

## Quick Start — Run a Test

### Step 1: Update config.json

Edit `config/config.json` on the server:

```json
{
  "load": {
    "qps": 10,
    "winRate": { "min": 0.15, "max": 0.25 },
    "stopAfter": { "impressions": 15, "requests": 100, "seconds": null },
    "maxInFlight": 50,
    "proxyPoolSize": 50
  }
}
```

### Step 2: Run via run.sh (with proxy, reads .env)

```bash
cd /opt/ssp-work
./run.sh --imp 15 --requests 100 --qps 10
```

`run.sh` handles proxy auth from `.env` and starts the server with `--use-env-proxy`.

### Step 3: Run directly (with proxy, reads .env)

```bash
cd /opt/ssp-work
node --use-env-proxy src/ssp-server.mjs --imp 15 --requests 100 --qps 10
```

### Step 4: Run without proxy (mock exchange)

```bash
cd /opt/ssp-work
USE_PROXY=0 node src/ssp-server.mjs --imp 15 --requests 100 --qps 10
```

### Step 5: Run with proxy pool size via config

Since `--proxy-pool-size` is not a CLI flag, edit `config.json` first:

```bash
# On server
cd /opt/ssp-work
# Edit config.json to set proxyPoolSize: 50
./run.sh --imp 15 --requests 100 --qps 10
```

## Understanding Results

The server prints a final JSON summary like:

```json
{
  "launched": 100,
  "completed": 100,
  "sent": 100,
  "wins": 18,
  "nobid": 82,
  "impFired": 16,
  "impAttempts": 18,
  "impErr": 0,
  "netErr": 2,
  "http4xx": 0,
  "http5xx": 0,
  "durationSec": 12.34,
  "auctionLatency": {
    "p50Ms": 45.2,
    "p95Ms": 230.5,
    "p99Ms": 890.1
  }
}
```

Key metrics:
- **launched** — auction requests sent
- **wins** — bids received (200 with seatbid)
- **nobid** — no-bid responses (204)
- **impFired** — impressions successfully tracked
- **impAttempts** — auctions that had impression pixels to fire
- **impErr** — impression fires that failed
- **netErr** — network errors (timeouts, DNS, etc.)
- **http4xx/http5xx** — HTTP error responses
- **auctionLatency.p95** — 95th percentile auction latency

## Proxy Credentials

Proxy auth is stored in `.env`:

```
PROXY_HOST=thehub.proxy-chease.com
PROXY_PORT=8080
PROXY_USER=VXDBzWryCCZaHTY
PROXY_PASS=auSr3oAQMM3B0M9_country-US_session-42545257_ttl-10
PROXY_COUNTRY=US
```

The `PROXY_PASS` contains a sticky session (`_session-42545257_`). The proxy pool generates separate session IDs (`_session-000000_` through `_session-000499_`) for rotation.

## PM2 Management

```bash
# Check status
pm2 status

# View logs
pm2 logs ssp-work --lines 100

# Restart after code changes
pm2 restart ssp-work

# Stop
pm2 stop ssp-work
```

## Control API (at runtime)

```bash
# Get live stats
curl http://127.0.0.1:8200/status

# Stop the server gracefully
curl -X POST http://127.0.0.1:8200/stop
```

## Syncing Code Changes

```bash
# On local machine
cd /Users/illia/Documents/AdExchange/ssp-work
git add .
git commit -m "description"
git push

# On remote server
cd /root/ssp-work
git pull origin master
cp -r /root/ssp-work/* /opt/ssp-work/
pm2 restart ssp-work
```

## Example: Full Production Run

```bash
# Edit config.json for production values
{
  "load": {
    "qps": 10,
    "winRate": { "min": 0.05, "max": 0.15 },
    "stopAfter": { "impressions": null, "requests": null, "seconds": 3600 },
    "maxInFlight": 50,
    "proxyPoolSize": 50,
    "cpmRange": { "min": 0.01, "max": 0.10 },
    "clickDelay": { "min": 2000, "max": 5000 }
  }
}

# Run for 1 hour
cd /opt/ssp-work
./run.sh --duration 3600 --log-body logs/bodies.jsonl --log-body-limit 1000
```
