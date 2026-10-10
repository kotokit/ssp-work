#!/usr/bin/env bash
# One-command launcher. Endpoint URL + QPS + win-rate + targets come from
# config/config.json. The supply key comes from $SSP_SUPPLY_KEY, or from
# config/supply-key.txt (git-ignored) if that env var is not set.
#
#   ./run.sh                      # run with config/config.json
#   ./run.sh --imp 1000 --qps 10  # override any config field
#
# PROXY — read this before changing anything here.
#
# Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY unless the process is
# started with --use-env-proxy. Worse, node reads those variables ONCE at
# startup: exporting them from inside the script (via process.loadEnvFile or
# process.env assignment) has no effect at all. The proxy then looks
# configured while every request silently goes out from your own IP.
#
# So the variables must be present in the environment before `exec node`.
# The two lines below do exactly that. Do not move them into the JS.
set -euo pipefail
cd "$(dirname "$0")"

# The key normally lives in the URL in config/config.json (?key=...).
# Optional override: $SSP_SUPPLY_KEY, or config/supply-key.txt.
if [ -z "${SSP_SUPPLY_KEY:-}" ] && [ -f config/supply-key.txt ]; then
  export SSP_SUPPLY_KEY="$(tr -d '[:space:]' < config/supply-key.txt)"
fi

# Put the residential proxy in effect before node starts.
# --no-proxy keeps 127.0.0.1 (the local mock exchange) direct.
if [ "${USE_PROXY:-1}" = "1" ] && [ -f .env ]; then
  eval "$(node src/pr.mjs --export)"
fi

exec node --use-env-proxy src/ssp-server.mjs "$@"
