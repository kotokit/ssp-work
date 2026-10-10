#!/usr/bin/env python3
"""Self-test for ja3-capture.py: build a synthetic pcap holding one known
TLS ClientHello and assert the emitted JA3 matches the expected hash.

No root, no tcpdump, no network. Run:  python3 tools/test-capture.py
"""
import hashlib
import struct
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))

GREASE = 0x0a0a


def u16(*vals):
    return b''.join(struct.pack('>H', v) for v in vals)


def build_client_hello(sni='rtb.example.com', alpn=(b'h2', b'http/1.1')):
    """A minimal but structurally valid TLS 1.2/1.3 ClientHello."""
    ciphers = u16(0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, GREASE)
    groups = u16(0x001d, 0x0017, 0x0018)
    sigs = u16(0x0403, 0x0804)
    points = bytes([0])            # single point format: uncompressed

    # SNI extension
    name = sni.encode()
    server_name = b'\x00' + struct.pack('>H', len(name)) + name
    sni_ext = struct.pack('>H', len(server_name) + 3) + server_name

    # ALPN extension
    alpn_list = b''.join(bytes([len(a)]) + a for a in alpn)
    alpn_ext = struct.pack('>H', len(alpn_list) + 2) + struct.pack('>H', len(alpn_list)) + alpn_list

    exts = b''.join([
        struct.pack('>HH', 0x0000, len(sni_ext)) + sni_ext,
        struct.pack('>HH', 0x000a, len(groups) + 2) + struct.pack('>H', len(groups)) + groups,
        struct.pack('>HH', 0x000b, len(points) + 1) + bytes([len(points)]) + points,
        struct.pack('>HH', 0x0010, len(alpn_ext)) + alpn_ext,
        struct.pack('>HH', 0x000d, len(sigs) + 2) + struct.pack('>H', len(sigs)) + sigs,
        struct.pack('>HH', 0x002b, 5) + b'\x04\x03\x04\x03\x03',  # list len 4 + two versions
        struct.pack('>HH', 0x000a + 0x1000, 0),  # unknown ext, exercise the parser
    ])

    body = (
        struct.pack('>H', 0x0303)            # legacy version
        + b'\x11' * 32                        # random
        + b'\x00'                             # session id len
        + struct.pack('>H', len(ciphers)) + ciphers
        + b'\x01\x00'                         # compression: null
        + struct.pack('>H', len(exts)) + exts
    )
    hs = b'\x01' + struct.pack('>I', len(body))[1:] + body
    return b'\x16\x03\x01' + struct.pack('>H', len(hs)) + hs


def expected_ja3():
    """JA3 computed independently of the parser under test."""
    ciphers = [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, GREASE]
    groups = [0x001d, 0x0017, 0x0018]
    exts = [0x0000, 0x000a, 0x000b, 0x0010, 0x000d, 0x002b, 0x100a]
    nc = [c for c in ciphers if c not in (0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a,
                                          0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a,
                                          0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa)]
    ng = [g for g in groups if g < 0x0a0a or g > 0xfafa]
    ja3 = ','.join(['771',
                    '-'.join(map(str, nc)),
                    '-'.join(map(str, exts)),
                    '-'.join(map(str, ng)),
                    '0'])  # ec_point_formats: one point (0); the length byte is not part of JA3
    return ja3, hashlib.md5(ja3.encode()).hexdigest()


def eth_ip_tcp(payload, src='203.0.113.77', sport=40000, dport=443, seq=1):
    tcp = struct.pack('>HHII', sport, dport, seq, 0) + b'\x50\x18' + struct.pack('>HH', 65535, 0) + b'\x00\x00'
    tcp += payload
    total = 20 + len(tcp)
    ip = struct.pack('>BBHHHBBH', 0x45, 0, total, 0, 0x4000, 64, 6, 0) + \
        bytes(map(int, src.split('.'))) + b'\x0a\x00\x00\x01'
    eth = b'\xaa' * 6 + b'\xbb' * 6 + struct.pack('>H', 0x0800)
    return eth + ip + tcp


def pcap(frames):
    out = struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)  # linktype 1 = EN10MB
    ts = 1_760_000_000
    for f in frames:
        out += struct.pack('<IIII', ts, 0, len(f), len(f)) + f
    return out


def main():
    hello = build_client_hello()
    ja3, md5 = expected_ja3()

    frames = [eth_ip_tcp(hello)]

    # Also a SYN with no payload and a non-TLS packet: both must be ignored.
    syn = struct.pack('>HHII', 40001, 443, 1, 0) + b'\x50\x02' + struct.pack('>HH', 65535, 0) + b'\x00\x00'
    ip = struct.pack('>BBHHHBBH', 0x45, 0, 20 + len(syn), 0, 0x4000, 64, 6, 0) + \
        bytes([203, 0, 113, 78]) + b'\x0a\x00\x00\x01'
    frames.append(b'\xaa' * 6 + b'\xbb' * 6 + struct.pack('>H', 0x0800) + ip + syn)

    junk = b'GET / HTTP/1.1\r\n\r\n'
    frames.append(eth_ip_tcp(junk, src='203.0.113.79', sport=40002))

    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, 'ja3-capture.py'), '10', '5'],
        input=pcap(frames), capture_output=True,
    )

    if proc.returncode != 0:
        print('script exited', proc.returncode)
        print(proc.stderr.decode()[:800])
        return 1

    lines = proc.stdout.decode().strip().split('\n')
    print('rows emitted:', len(lines) - 1, '(expected 1: SYN and non-TLS ignored)')

    if len(lines) != 2:
        print('FAIL: expected exactly one data row')
        for l in lines:
            print(' ', l[:120])
        return 1

    hdr = lines[0].split(',')
    row = lines[1]
    print('header:', lines[0])
    print('row   :', row[:140], '...')

    checks = []
    checks.append(('source IP is full, not /24', ',203.0.113.77,' in ',' + row + ','))
    checks.append(('ja3_md5 matches independent hash', md5 in row))
    checks.append(('sni parsed', 'rtb.example.com' in row))
    checks.append(('alpn parsed as h2/http1.1', 'h2/http/1.1' in row or 'h2' in row))
    checks.append(('grease detected', 'yes' in row.split(',')[4]))

    ok = True
    print('')
    for name, passed in checks:
        print(f'  [{"PASS" if passed else "FAIL"}] {name}')
        ok = ok and passed

    print('')
    print('expected ja3_md5:', md5)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
