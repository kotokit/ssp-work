"""Read a pcap stream on stdin, rebuild each TLS ClientHello, print JA3/JA4 as CSV.

Usage: tcpdump -U -w - '<filter>' | python3 ja.py MAX_HELLOS MAX_SECONDS
Source IPs are written in full by default; --anonymise masks the host part.
"""
import csv
import hashlib
import struct
import sys
import time

MAX_HELLOS = int(sys.argv[1])
MAX_SECONDS = float(sys.argv[2])
# --anonymise masks the host part of the source address before output.
ANONYMISE = '--anonymise' in sys.argv
GREASE = {0x0A0A + 0x1010 * i for i in range(16)}

src = sys.stdin.buffer
_any_output = False


def read(n, what='data'):
    global _any_output
    data = b''
    while len(data) < n:
        chunk = src.read(n - len(data))
        if not chunk:
            if not _any_output:
                sys.stderr.write(
                    'ja3-capture: no data on stdin.\n'
                    '  The producer (tcpdump) wrote nothing, so the problem is upstream:\n'
                    '    - wrong interface name?  check: ip -br link\n'
                    '    - tcpdump missing?       check: command -v tcpdump\n'
                    '    - filter matched none?   check: tcpdump -i IFACE -nn -c 5 \'tcp dst port 443\'\n'
                )
            else:
                sys.stderr.write(f'ja3-capture: truncated capture while reading {what}.\n')
            raise EOFError
        _any_output = True
        data += chunk
    return data


header = read(24, 'pcap header')
endian = '<' if header[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
linktype = struct.unpack(endian + 'I', header[20:24])[0]


def ip_payload(frame):
    if linktype == 1:
        eth = struct.unpack('>H', frame[12:14])[0]
        off = 14
        if eth == 0x8100:
            eth = struct.unpack('>H', frame[16:18])[0]
            off = 18
    elif linktype == 113:
        eth, off = struct.unpack('>H', frame[14:16])[0], 16
    elif linktype == 276:
        eth, off = struct.unpack('>H', frame[0:2])[0], 20
    elif linktype in (12, 101):
        eth, off = (0x0800 if frame[0] >> 4 == 4 else 0x86DD), 0
    else:
        return None
    return eth, frame[off:]


def parse_tcp(frame):
    got = ip_payload(frame)
    if not got:
        return None
    eth, ip = got
    if eth == 0x0800:
        ihl = (ip[0] & 0x0F) * 4
        if ip[9] != 6:
            return None
        total = struct.unpack('>H', ip[2:4])[0]
        srcip = '.'.join(str(b) for b in ip[12:16])
        if ANONYMISE:
            srcip = '.'.join(srcip.split('.')[:3]) + '.0/24'
        tcp = ip[ihl:total]
    elif eth == 0x86DD:
        if ip[6] != 6:
            return None
        srcip = ':'.join(ip[8:24].hex()[i:i+4] for i in range(0, 32, 4))
        if ANONYMISE:
            srcip = ip[8:14].hex() + '::/48'
        tcp = ip[40:40 + struct.unpack('>H', ip[4:6])[0]]
    else:
        return None
    sport = struct.unpack('>H', tcp[0:2])[0]
    seq = struct.unpack('>I', tcp[4:8])[0]
    doff = (tcp[12] >> 4) * 4
    return (ip[12:16] if eth == 0x0800 else ip[8:24], sport), srcip, seq, tcp[doff:]


def u16list(raw):
    return [struct.unpack('>H', raw[i:i + 2])[0] for i in range(0, len(raw) - 1, 2)]


def fingerprint(hs):
    # hs = handshake message body (after type+len)
    legacy = struct.unpack('>H', hs[0:2])[0]
    pos = 2 + 32
    pos += 1 + hs[pos]
    clen = struct.unpack('>H', hs[pos:pos + 2])[0]
    ciphers = u16list(hs[pos + 2:pos + 2 + clen])
    pos += 2 + clen
    pos += 1 + hs[pos]
    exts = []
    if pos + 2 <= len(hs):
        end = pos + 2 + struct.unpack('>H', hs[pos:pos + 2])[0]
        pos += 2
        while pos + 4 <= end:
            t, ln = struct.unpack('>HH', hs[pos:pos + 4])
            exts.append((t, hs[pos + 4:pos + 4 + ln]))
            pos += 4 + ln
    ext = dict(exts)
    groups = u16list(ext[10][2:]) if 10 in ext else []
    points = list(ext[11][1:]) if 11 in ext else []
    sigs = u16list(ext[13][2:]) if 13 in ext else []
    alpn = []
    if 16 in ext:
        raw, i = ext[16][2:], 0
        while i < len(raw):
            alpn.append(raw[i + 1:i + 1 + raw[i]].decode('latin-1'))
            i += 1 + raw[i]
    sni = ''
    if 0 in ext and len(ext[0]) > 5:
        sni = ext[0][5:5 + struct.unpack('>H', ext[0][3:5])[0]].decode('latin-1')
    versions = u16list(ext[43][1:]) if 43 in ext else []
    nc = [c for c in ciphers if c not in GREASE]
    ne = [t for t, _ in exts if t not in GREASE]
    ng = [g for g in groups if g not in GREASE]
    ja3 = ','.join([
        str(legacy), '-'.join(map(str, nc)), '-'.join(map(str, ne)),
        '-'.join(map(str, ng)), '-'.join(map(str, points)),
    ])
    best = max([v for v in versions if v not in GREASE] or [legacy])
    ver = {0x0304: '13', 0x0303: '12', 0x0302: '11', 0x0301: '10', 0x0300: 's3'}.get(best, '00')
    a = alpn[0] if alpn else ''
    a2 = (a[0] + a[-1]) if a else '00'
    if a and not (a[0].isalnum() and a[-1].isalnum()):
        a2 = a.encode('latin-1').hex()[0] + a.encode('latin-1').hex()[-1]
    ja4_a = f"t{ver}{'d' if sni else 'i'}{min(len(nc), 99):02d}{min(len(ne), 99):02d}{a2}"
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()[:12] if s else '000000000000'
    ja4_b = h(','.join(f'{c:04x}' for c in sorted(nc)))
    ext_part = ','.join(f'{t:04x}' for t in sorted(t for t in ne if t not in (0, 16)))
    sig_part = ','.join(f'{s:04x}' for s in sigs)
    ja4_c = h(ext_part + ('_' + sig_part if sig_part else '')) if ext_part else '000000000000'
    return {
        'ja3': ja3, 'ja3_md5': hashlib.md5(ja3.encode()).hexdigest(),
        'ja4': f'{ja4_a}_{ja4_b}_{ja4_c}', 'sni': sni, 'alpn': '/'.join(alpn),
        'grease': 'yes' if any(c in GREASE for c in ciphers) else 'no',
    }


pending = {}  # flow -> [first_seq, {seq: payload}]
rows = []
seen_flows = set()
start = time.time()
try:
    while len(rows) < MAX_HELLOS and time.time() - start < MAX_SECONDS:
        rec = read(16)
        ts_sec, _, incl, _ = struct.unpack(endian + 'IIII', rec)
        frame = read(incl)
        got = parse_tcp(frame)
        if not got:
            continue
        flow, srcip, seq, payload = got
        if not payload or flow in seen_flows:
            continue
        if flow not in pending:
            if payload[0] != 0x16 or len(payload) < 6 or payload[5] != 0x01:
                continue
            pending[flow] = [seq, {}]
        first, parts = pending[flow]
        parts[seq] = payload
        data, cur = b'', first
        while cur in parts:
            data += parts[cur]
            cur = (cur + len(parts[cur])) & 0xFFFFFFFF
        if len(data) < 9:
            continue
        hs_len = int.from_bytes(data[6:9], 'big')
        # Rebuild the handshake across TLS records too.
        body, p = b'', 0
        while p + 5 <= len(data) and len(body) < 4 + hs_len:
            rlen = struct.unpack('>H', data[p + 3:p + 5])[0]
            body += data[p + 5:p + 5 + rlen]
            if p + 5 + rlen > len(data):
                break
            p += 5 + rlen
        if len(body) < 4 + hs_len:
            if len(pending) > 50000:
                pending.clear()
            continue
        del pending[flow]
        seen_flows.add(flow)
        try:
            fp = fingerprint(body[4:4 + hs_len])
        except Exception:
            continue
        rows.append({'time_utc': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(ts_sec)), 'src': srcip, **fp})
except EOFError:
    pass

w = csv.DictWriter(sys.stdout, fieldnames=['time_utc', 'src', 'sni', 'alpn', 'grease', 'ja4', 'ja3_md5', 'ja3'])
w.writeheader()
w.writerows(rows)
