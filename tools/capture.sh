#!/usr/bin/env bash
# Capture TLS ClientHello fingerprints on the exchange host.
#
#   ./tools/capture.sh eth0 5000 120            # 5000 hellos or 120s
#   ./tools/capture.sh eth0 5000 120 --anonymise
#
# Usage: capture.sh INTERFACE MAX_HELLOS MAX_SECONDS [--anonymise]
set -euo pipefail

IFACE="${1:?interface required, e.g. eth0 (do NOT use 'any')}"
MAX="${2:-5000}"
SECS="${3:-120}"
EXTRA="${4:-}"

HERE="$(cd "$(dirname "$0")" && pwd)"

# Notes on the filter:
#   - `tcp dst port 443` also matches SYN/ACK/FIN because they carry dst port
#     443, so it captures the SERVER's outbound packets too. Requiring payload
#     bytes and only scheduling the filter on ingress avoids that.
#   - A concrete interface (-i eth0) is required: on Linux, `-i any` can
#     capture each packet twice (once via a cooked header, once via the real
#     device), which would double-count every handshake.
#   - -s 0 keeps the whole frame; a ClientHello rarely exceeds one MSS but
#     the reassembler needs the bytes regardless.
tcpdump -i "$IFACE" -nn -s 0 -U -w - \
  'tcp dst port 443 and (tcp[13] & 0x18 != 0)' \
  2>/dev/null \
| python3 "$HERE/ja3-capture.py" "$MAX" "$SECS" $EXTRA
