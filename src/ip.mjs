// IP primitives for IPv4 and IPv6. The detector groups and matches addresses
// through these, so a v6 address is a first-class citizen — not silently
// dropped the way an IPv4-only parser drops it.
//
// Addresses are carried as a BigInt plus a version (4 or 6); CIDR masks are
// BigInt masks of the right width (32 or 128). networkKey() reduces an address
// to its grouping unit — /24 for v4, /64 for v6 (the usual subscriber prefix) —
// which is the "same line" unit the impression binding checks against.

/** Parse a dotted-quad IPv4 string -> { version: 4, value: BigInt } | null. */
function parseIpv4(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let v = 0n;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o)) return null;
    const b = Number(o);
    if (b > 255) return null;
    v = (v << 8n) | BigInt(b);
  }
  return { version: 4, value: v };
}

/** Expand one side of an IPv6 string into 16-bit groups (handles a trailing embedded IPv4). */
function toHextets(str) {
  if (str === '') return [];
  const parts = str.split(':');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const g = parts[i];
    if (g.includes('.')) {
      if (i !== parts.length - 1) return null; // embedded IPv4 only allowed last
      const v4 = parseIpv4(g);
      if (!v4) return null;
      out.push(Number((v4.value >> 16n) & 0xffffn));
      out.push(Number(v4.value & 0xffffn));
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
  }
  return out;
}

/** Parse an IPv6 string (incl. :: compression and ::ffff:1.2.3.4) -> { version: 6, value } | null. */
function parseIpv6(raw) {
  const s = raw.split('%')[0]; // drop any zone id
  if (s.indexOf('::') !== s.lastIndexOf('::')) return null; // at most one '::'
  let groups;
  if (s.includes('::')) {
    const [headStr, tailStr] = s.split('::');
    const head = toHextets(headStr);
    const tail = toHextets(tailStr);
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // '::' must stand for >= 1 group
    groups = [...head, ...Array(missing).fill(0), ...tail];
  } else {
    groups = toHextets(s);
    if (groups === null) return null;
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (g < 0 || g > 0xffff) return null;
    v = (v << 16n) | BigInt(g);
  }
  return { version: 6, value: v };
}

/** Parse any IP string -> { version, value: BigInt } | null. */
export function parseIp(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  return s.includes(':') ? parseIpv6(s) : parseIpv4(s);
}

const maskFor = (width, bits) => (bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits));

/** Parse "addr/bits" (bits optional) -> { version, base, mask, width } | null. */
export function parseCidr(str) {
  const [addr, bitsRaw] = String(str).split('/');
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const mask = maskFor(width, bits);
  return { version: ip.version, base: ip.value & mask, mask, width };
}

/** True if `ip` falls inside `cidr` (string or parsed). Mismatched families never match. */
export function inCidr(ip, cidr) {
  const a = typeof ip === 'string' ? parseIp(ip) : ip;
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!a || !c || a.version !== c.version) return false;
  return (a.value & c.mask) === c.base;
}

export function inCidrList(ip, cidrs = []) {
  const a = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!a) return false;
  for (const c of cidrs) if (inCidr(a, c)) return true;
  return false;
}

/**
 * The grouping key for an address: v4 -> /24, v6 -> /64 by default. Returns a
 * stable string like "v4:a000500/24" (version-tagged, so v4 and v6 nets never
 * collide and a cross-family request/impression pair reads as a mismatch).
 */
export function networkKey(ip, { v4Bits = 24, v6Bits = 64 } = {}) {
  const a = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!a) return null;
  const width = a.version === 4 ? 32 : 128;
  const bits = a.version === 4 ? v4Bits : v6Bits;
  const net = a.value & maskFor(width, bits);
  return `v${a.version}:${net.toString(16)}/${bits}`;
}

// IANA special-use / reserved / non-routable ranges — "bogons". A device.ip in
// one of these can't belong to a real user on the public internet, so it's a
// strong invalid-traffic signal. (Full "unallocated / not in any BGP route"
// detection additionally needs a routing/RIR-allocation feed; this is the part
// that's knowable offline.)
const BOGON_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', '::1/128', '64:ff9b::/96', '100::/64', '2001:db8::/32',
  'fc00::/7', 'fe80::/10', 'ff00::/8',
].map(parseCidr).filter(Boolean);

/** True if the address is a reserved / non-routable "bogon" — not a real user IP. */
export function isBogon(ip) {
  return inCidrList(ip, BOGON_CIDRS);
}
