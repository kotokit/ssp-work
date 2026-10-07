#!/usr/bin/env bash
# One-command launcher. Endpoint URL + QPS + win-rate + targets come from
# config/config.json. The supply key comes from $SSP_SUPPLY_KEY, or from
# config/supply-key.txt (git-ignored) if that env var is not set.
#
#   ./run.sh                      # run with config/config.json
#   ./run.sh --imp 1000 --qps 10  # override any config field
set -euo pipefail
cd "$(dirname "$0")"

# The key normally lives in the URL in config/config.json (?key=...).
# Optional override: $SSP_SUPPLY_KEY, or config/supply-key.txt.
if [ -z "${SSP_SUPPLY_KEY:-}" ] && [ -f config/supply-key.txt ]; then
  export SSP_SUPPLY_KEY="$(tr -d '[:space:]' < config/supply-key.txt)"
fi
exec node src/ssp-server.mjs "$@"
