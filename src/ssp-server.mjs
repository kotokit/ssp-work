// Standalone SSP load/red-team server for stress-testing the exchange IVT.
//
// Config-driven (config/config.json): endpoint URL, QPS, win-rate RANGE (a
// random value per request inside [min,max]), and a stop target (impressions /
// requests / seconds). Each tick picks a UA (CSV) + US residential IP (pool),
// relays POST <auctionUrl> as the onboarded supply partner, and on a win fires
// the sealed /t/imp pixel from the same IP. Win rate is controlled on the
// supply side via the bid floor (high floor -> bid below floor -> 204, no win).
//
//   SSP_SUPPLY_KEY=<key> node src/ssp-server.mjs
//   overrides: --url U --qps N --win-min P --win-max P --imp N --requests N
//              --duration S --format banner|video --no-imp --seller ID
//              --verbose --quiet --port P
//
// Control:  GET :8200/status   POST :8200/stop
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadUserAgents } from './uas.mjs';
import { buildAuctionRequest, sendAuction, extractImpPixel, fireImpression } from './request.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN_FLOOR = 0.01; // below the mock bid -> wins
const LOSE_FLOOR = 100; // above any bid -> rejected -> 204, no win

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const a = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--no-imp' || t === '--verbose' || t === '--quiet') a.flags.add(t);
    else if (t.startsWith('--')) {
      a[t.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const num = (v, d) => (v !== undefined ? Number(v) : d);

// ---- config ---------------------------------------------------------------
const cfg = JSON.parse(readFileSync(join(ROOT, 'config/config.json'), 'utf8'));
const auctionUrl = args.url ?? cfg.url;
const qps = num(args.qps, cfg.load.qps);
const winMin = num(args['win-min'], cfg.load.winRate.min);
const winMax = num(args['win-max'], cfg.load.winRate.max);
const maxInFlight = num(cfg.load.maxInFlight, 50);
const impTarget = args.imp !== undefined ? Number(args.imp) : cfg.load.stopAfter.impressions ?? null;
const reqTarget = args.requests !== undefined ? Number(args.requests) : cfg.load.stopAfter.requests ?? null;
const durationMs = args.duration !== undefined ? Number(args.duration) * 1000 : (cfg.load.stopAfter.seconds ?? 0) * 1000 || Infinity;
const format = args.format ?? cfg.traffic.formats[0] ?? 'banner';
const fireImps = !args.flags.has('--no-imp') && cfg.traffic.fireImpressions !== false;
const verbose = args.flags.has('--verbose');
const quiet = args.flags.has('--quiet');
const controlPort = num(args.port, cfg.control?.port ?? 8200);
const bundle = cfg.traffic.bundle;
const appName = cfg.traffic.appName ?? 'App';

// safety cap so a 0% win rate can't loop forever when chasing an impression target
const reqCap = reqTarget ?? (impTarget ? Math.ceil((impTarget / Math.max(winMin, 0.002)) * 1.5) : Infinity);

const sellers = args.seller ? [{ publisherId: args.seller, weight: 1 }] : cfg.traffic.sellers;
const sellerWeight = sellers.reduce((s, x) => s + (x.weight ?? 1), 0);
const pickSeller = () => {
  let x = Math.random() * sellerWeight;
  for (const s of sellers) {
    x -= s.weight ?? 1;
    if (x <= 0) return s;
  }
  return sellers[sellers.length - 1];
};

// The account key can be embedded in the URL as ?key=... (one variable), or
// supplied via env SSP_SUPPLY_KEY. A key in the URL means no header is sent.
let urlKey = '';
try {
  urlKey = new URL(auctionUrl).searchParams.get('key') ?? '';
} catch {
  // non-absolute URL; leave urlKey empty
}
const envKey = process.env[cfg.supplyKeyEnv ?? 'SSP_SUPPLY_KEY'] ?? '';
const supplyKey = envKey; // sent as x-adx-key header only when the URL has no key
const effectiveKey = urlKey || envKey;
if (!effectiveKey) {
  console.error('No key. Put ?key=<x-adx-key> in the URL (config url), or set env SSP_SUPPLY_KEY.');
  process.exit(1);
}
const safeUrl = auctionUrl.replace(/([?&]key=)[^&]*/i, '$1***'); // never print the key

// ---- inputs ---------------------------------------------------------------
const uas = loadUserAgents(join(ROOT, cfg.inputs.uaFile));
let pool;
try {
  pool = JSON.parse(readFileSync(join(ROOT, cfg.inputs.ipPoolFile), 'utf8'));
} catch {
  console.error(`No IP pool at ${cfg.inputs.ipPoolFile}. Run: node src/ippool.mjs`);
  process.exit(1);
}
if (!uas.length || !pool.ips?.length) {
  console.error('Empty UA list or IP pool.');
  process.exit(1);
}
const randUa = () => uas[Math.floor(Math.random() * uas.length)];
// Pick an IP and the ISP/metro that came with it, so geo + carrier in the
// request stay consistent with the residential IP (pool.meta is index-aligned).
const randEndpoint = () => {
  const i = Math.floor(Math.random() * pool.ips.length);
  const m = pool.meta?.[i] ?? {};
  return { ip: pool.ips[i], isp: m.isp, metro: m.metro };
};

// ---- stats ----------------------------------------------------------------
const stats = {
  startedAt: new Date().toISOString(),
  sent: 0,
  winnable: 0,
  wins: 0,
  nobid: 0,
  http4xx: 0,
  http5xx: 0,
  netErr: 0,
  impFired: 0,
  impErr: 0,
  noPixel: 0,
  lastError: null,
};
let launched = 0;
let inFlight = 0;
let stopping = false;

// ---- one attempt ----------------------------------------------------------
async function attempt() {
  inFlight += 1;
  const ua = randUa();
  const { ip, isp, metro } = randEndpoint();
  const seller = pickSeller();
  // win rate: a random value inside [winMin, winMax] per request
  const p = winMin + Math.random() * (winMax - winMin);
  const winnable = Math.random() < p;
  if (winnable) stats.winnable += 1;
  const body = buildAuctionRequest({
    ua,
    ip,
    bundle,
    appName,
    publisherId: seller.publisherId,
    format,
    bidfloor: winnable ? WIN_FLOOR : LOSE_FLOOR,
    geoMeta: { isp, metro },
    traffic: cfg.traffic,
  });
  const { status, json, error } = await sendAuction(body, { auctionUrl, supplyKey });
  stats.sent += 1;
  if (status === 200 && json?.seatbid?.length) {
    stats.wins += 1;
    if (fireImps) {
      const pixel = extractImpPixel(json);
      if (pixel) {
        const st = await fireImpression(pixel, { ip, ua });
        if (st >= 200 && st < 400) stats.impFired += 1;
        else stats.impErr += 1;
      } else stats.noPixel += 1;
    }
    if (verbose) console.log(`win seller=${seller.publisherId} ip=${ip} imp=${fireImps ? 'fired' : 'off'}`);
  } else if (status === 204) {
    stats.nobid += 1;
  } else if (status === 0) {
    stats.netErr += 1;
    stats.lastError = error;
  } else if (status >= 400 && status < 500) {
    stats.http4xx += 1;
    stats.lastError = `HTTP ${status}`;
  } else {
    stats.http5xx += 1;
    stats.lastError = `HTTP ${status}`;
  }
  inFlight -= 1;
  if (stopping && inFlight === 0) finalize();
}

// ---- scheduler ------------------------------------------------------------
const TICK_MS = 50;
let tokens = 0;
const startWall = Date.now();
function targetReached() {
  if (impTarget && stats.impFired >= impTarget) return 'impression target';
  if (launched >= reqCap) return reqTarget ? 'request target' : 'request cap';
  if (Date.now() - startWall >= durationMs) return 'duration';
  return null;
}
const tick = setInterval(() => {
  if (stopping) return;
  const reached = targetReached();
  if (reached) return stop(reached);
  tokens += (qps * TICK_MS) / 1000;
  while (tokens >= 1 && inFlight < maxInFlight && !targetReached()) {
    tokens -= 1;
    launched += 1;
    void attempt();
  }
}, TICK_MS);

// ---- logging --------------------------------------------------------------
const logTimer = quiet
  ? null
  : setInterval(() => {
      const secs = ((Date.now() - startWall) / 1000).toFixed(0);
      const wr = stats.sent ? ((stats.wins / stats.sent) * 100).toFixed(1) : '0';
      console.log(
        `[${secs}s] sent=${stats.sent} wins=${stats.wins} (${wr}%) imp=${stats.impFired}` +
          (impTarget ? `/${impTarget}` : '') +
          ` nobid=${stats.nobid} errs=${stats.http4xx + stats.http5xx + stats.netErr} inflight=${inFlight}` +
          (stats.lastError ? ` last="${stats.lastError}"` : ''),
      );
    }, 3000);

// ---- lifecycle ------------------------------------------------------------
let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  clearInterval(tick);
  if (logTimer) clearInterval(logTimer);
  const wr = stats.sent ? ((stats.wins / stats.sent) * 100).toFixed(2) : '0';
  console.log('\n=== final ===');
  console.log(
    JSON.stringify(
      { ...stats, launched, realizedWinRatePct: Number(wr), durationSec: Number(((Date.now() - startWall) / 1000).toFixed(1)), config: { url: safeUrl, qps, winRange: [winMin, winMax], impTarget, format, fireImps, sellers: sellers.map((s) => s.publisherId), bundle, pool: `${pool.ips.length}ips/${pool.subnets}subnets`, uas: uas.length } },
      null,
      2,
    ),
  );
  control.close();
  process.exit(0);
}
function stop(reason) {
  if (stopping) return;
  stopping = true;
  if (!quiet) console.log(`stopping: ${reason} (draining ${inFlight})`);
  if (inFlight === 0) finalize();
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

// ---- control API ----------------------------------------------------------
const control = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/stop') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"stopping":true}');
    stop('control /stop');
    return;
  }
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
    const secs = (Date.now() - startWall) / 1000;
    const wr = stats.sent ? Number(((stats.wins / stats.sent) * 100).toFixed(2)) : 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...stats, launched, inFlight, realizedWinRatePct: wr, uptimeSec: Number(secs.toFixed(1)), target: { impTarget, reqTarget, reqCap } }, null, 2));
    return;
  }
  res.writeHead(404);
  res.end();
});
control.listen(controlPort, '127.0.0.1', () => {
  if (!quiet) {
    const eta = impTarget && qps ? Math.round(impTarget / ((winMin + winMax) / 2) / qps) : null;
    console.log(
      `SSP server up. key=…${effectiveKey.slice(-4)} url=${safeUrl} qps=${qps} winRate=${winMin * 100}-${winMax * 100}% ` +
        `target=${impTarget ? impTarget + 'imp' : reqTarget ? reqTarget + 'req' : 'none'} fireImp=${fireImps} ` +
        `sellers=[${sellers.map((s) => s.publisherId).join(',')}] pool=${pool.ips.length}ips/${pool.subnets}subnets uas=${uas.length} control=:${controlPort}` +
        (eta ? ` ~ETA=${eta}s` : ''),
    );
  }
});
