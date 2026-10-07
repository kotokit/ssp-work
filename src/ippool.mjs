// Generate a US residential IP pool as data: each IP in a distinct random /24,
// drawn from real residential ISP ranges (data/isp_ranges.json), plus the
// verified proxy anchor IP. Many /24s with ~one host each mirrors a device farm
// (many IPs, few devices). Writes data/ip_pool.json.
//
//   node src/ippool.mjs [count=2000] [anchorIp=128.211.249.142]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ipToInt = (ip) => {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
};
const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const subnet24 = (ip) => ip.split('.').slice(0, 3).join('.');
function parseCidr(cidr) {
  const [ip, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  return { base: ipToInt(ip), bits, size: 2 ** (32 - bits) };
}

const count = Number(process.argv[2] ?? 2000);
const anchor = process.argv[3] ?? '128.211.249.142';

const ranges = JSON.parse(readFileSync(join(ROOT, 'data/isp_ranges.json'), 'utf8'));
// Weight each block by how many /24s it holds, so larger allocations contribute
// proportionally more subnets.
const weighted = ranges.map((r) => {
  const c = parseCidr(r.cidr);
  return { ...r, ...c, slots: Math.max(1, Math.floor(c.size / 256)) };
});
const totalSlots = weighted.reduce((s, r) => s + r.slots, 0);
const pickRange = () => {
  let x = Math.floor(Math.random() * totalSlots);
  for (const r of weighted) {
    if (x < r.slots) return r;
    x -= r.slots;
  }
  return weighted[weighted.length - 1];
};

const used = new Set();
const ips = [];
const meta = [];

// Anchor first: a real US residential egress we verified through the proxy.
used.add(subnet24(anchor));
ips.push(anchor);
meta.push({ ip: anchor, isp: 'Proxy anchor (verified residential)', metro: 'US/IN West Lafayette' });

let guard = 0;
while (ips.length < count && guard < count * 25) {
  guard += 1;
  const r = pickRange();
  const slot = Math.floor(Math.random() * r.slots); // which /24 inside the block
  const subnetBase = (r.base + slot * 256) >>> 0;
  const sub = subnet24(intToIp(subnetBase));
  if (used.has(sub)) continue;
  used.add(sub);
  const ip = intToIp((subnetBase + 1 + Math.floor(Math.random() * 254)) >>> 0);
  ips.push(ip);
  meta.push({ ip, isp: r.isp, metro: r.metro });
}

writeFileSync(
  join(ROOT, 'data/ip_pool.json'),
  JSON.stringify({ count: ips.length, subnets: used.size, generatedAt: new Date().toISOString(), ips, meta }, null, 2),
);
console.log(`generated ${ips.length} IPs across ${used.size} distinct /24s -> data/ip_pool.json`);
console.log('sample:', ips.slice(0, 6).join(', '));
