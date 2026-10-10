#!/usr/bin/env bash
# Diagnose why a capture produced no data. Read-only; changes nothing.
echo "=== host ==="
uname -a
echo
echo "=== tcpdump present? ==="
command -v tcpdump || echo "MISSING: tcpdump is not installed (apt install tcpdump)"
echo
echo "=== interfaces (pick the real one, not lo/docker) ==="
if command -v ip >/dev/null; then ip -br link; else ifconfig -a | grep -E '^[a-z]'; fi
echo
echo "=== default route interface (usually the right one) ==="
ip route get 1.1.1.1 2>/dev/null | head -2
echo
echo "=== 5 packets on any interface, dst port 443 (no filter beyond that) ==="
timeout 12 tcpdump -i any -nn -c 5 'tcp dst port 443' 2>&1 | tail -8 || echo "(tcpdump returned non-zero)"
echo
echo "=== does OUR filter match? try 5 with the payload guard ==="
timeout 12 tcpdump -i any -nn -c 5 'tcp dst port 443 and (tcp[13] & 0x18 != 0)' 2>&1 | tail -8 || echo "(no match)"
