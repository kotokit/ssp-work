
/**
 * Standalone SSP load-testing server for an authorized Ad Exchange.
 *
 * Preserves:
 *   - config/config.json
 *   - ./uas.mjs and ./req.mjs interfaces
 *   - SSP_SUPPLY_KEY authentication
 *   - Existing CLI options
 *   - GET /status and POST /stop on localhost
 *
 * Improvements:
 *   - No catch-up request bursts when the scheduler falls behind
 *   - Bounded concurrency and explicit request lifecycle accounting
 *   - Reliable in-flight cleanup, including thrown errors
 *   - Separate auction and impression latency statistics
 *   - Bounded latency samples and p50/p95/p99 reporting
 *   - Better HTTP response classification
 *   - Configuration validation
 *   - Graceful shutdown and explicit stop reasons
 *
 * Run:
 *   SSP_SUPPLY_KEY=<key> node src/ssp-server.mjs
 *
 * Examples:
 *   node src/ssp-server.mjs --qps 100 --duration 60
 *   node src/ssp-server.mjs --qps 200 --requests 10000
 *   node src/ssp-server.mjs --imp 1000 --win-min 0.2 --win-max 0.4
 *   node src/ssp-server.mjs --no-imp
 *
 * Control:
 *   GET  http://127.0.0.1:8200/status
 *   POST http://127.0.0.1:8200/stop
 */

import { createServer } from 'node:http';
import { readFileSync, createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadUserAgents } from './uas.mjs';
import { APP_FIXTURES } from './traffic.mjs';
import {
  buildAuctionRequest,
  sendAuction,
  extractImpPixel,
  fireImpression,
  validateDevice,
  parseDevice,
} from './req.mjs';
import {
  verifyProxy,
  proxyProblem as proxyProblemForStartup,
  getProxyCredentials,
} from './pr.mjs';
import {
  initGeoIP,
  geoAvailable,
  geoPath,
} from './geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WIN_FLOOR = 0.01;
const LOSE_FLOOR = 0.1;
const DEFAULT_MAX_IN_FLIGHT = 50;
const LATENCY_SAMPLE_LIMIT = 10_000;
const LOG_INTERVAL_MS = 3_000;

const HELP = `
SSP load-testing server

Options:
  --url URL              Auction endpoint
  --qps N                Target request starts per second
  --win-min P            Minimum intended win probability (0..1)
  --win-max P            Maximum intended win probability (0..1)
  --imp N                Stop after N successful impression HTTP responses
  --requests N           Stop after N auction attempts are launched
  --duration S            Stop after S seconds
  --format FORMAT         banner or video
  --no-imp                Disable impression tracking
  --seller ID             Use a single publisher ID
  --max-in-flight N       Maximum concurrent attempts
  --log-body [FILE]       Write each request body as JSONL. Use '-' for stdout.
                          Default FILE when omitted: logs/bodies.jsonl
  --log-body-limit N      Maximum bodies to write. Default: 100
  --verbose               Log individual bid responses
  --quiet                 Disable periodic and startup logs
  --port N                Local control API port
  --help                  Show this help

Environment:
  SSP_SUPPLY_KEY           Supply authentication key (configurable env name)

The control API listens on 127.0.0.1 only.
`;

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();

  const booleanFlags = new Set([
    '--no-imp',
    '--verbose',
    '--quiet',
    '--help',
  ]);

  /*
   * Flags whose value is optional: `--log-body` on its own uses the default
   * path, `--log-body -` or `--log-body out.jsonl` uses the given one.
   */
  const optionalValueFlags = new Set([
    '--log-body',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    if (booleanFlags.has(token)) {
      flags.add(token);
      continue;
    }

    if (optionalValueFlags.has(token)) {
      const next = argv[i + 1];

      if (next !== undefined && !next.startsWith('--')) {
        if (values.has(token)) {
          throw new Error(`Duplicate argument: ${token}`);
        }

        values.set(token, next);
        i += 1;
      } else {
        flags.add(token);
      }

      continue;
    }

    const value = argv[i + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }

    if (values.has(token)) {
      throw new Error(`Duplicate argument: ${token}`);
    }

    values.set(token, value);
    i += 1;
  }

  const allowed = new Set([
    '--url',
    '--qps',
    '--win-min',
    '--win-max',
    '--imp',
    '--requests',
    '--duration',
    '--format',
    '--seller',
    '--max-in-flight',
    '--port',
    '--log-body',
    '--log-body-limit',
  ]);

  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  return { flags, values };
}

function numberOption(args, name, fallback) {
  const raw = args.values.get(name);

  if (raw === undefined) return fallback;

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
}

function positiveNumber(value, name, { integer = false } = {}) {
  if (value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(
        `${name} must be a positive${integer ? ' integer' : ' number'}`,
    );
  }

  return value;
}

function optionalTarget(value, name) {
  if (value === null || value === undefined) return null;

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function percentile(samples, p) {
  if (samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
      sorted.length - 1,
      Math.ceil(p * sorted.length) - 1,
  );

  return Number(sorted[index].toFixed(2));
}

// A bounded rolling sample avoids unbounded memory growth.
// Percentiles describe the retained sample, not every request ever sent.
function createLatencyTracker(limit = LATENCY_SAMPLE_LIMIT) {
  const values = new Array(limit);
  let count = 0;
  let next = 0;

  return {
    add(value) {
      values[next] = value;
      next = (next + 1) % limit;
      count = Math.min(count + 1, limit);
    },

    summary() {
      const samples = values.slice(0, count);

      return {
        sampleCount: count,
        sampleLimit: limit,
        p50Ms: percentile(samples, 0.50),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
        maxSampleMs:
            samples.length > 0
                ? Number(Math.max(...samples).toFixed(2))
                : null,
      };
    },
  };
}

function redactUrl(value) {
  try {
    const url = new URL(value);

    for (const key of ['key', 'token', 'api_key', 'apikey']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '***');
      }
    }

    if (url.username) url.username = '***';
    if (url.password) url.password = '***';

    return url.toString();
  } catch {
    return String(value).replace(
        /([?&](?:key|token|api_key|apikey)=)[^&]*/gi,
        '$1***',
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('--help')) {
    console.log(HELP);
    return;
  }

  const cfg = JSON.parse(
      readFileSync(join(ROOT, 'config/config.json'), 'utf8'),
  );

  const auctionUrl = args.values.get('--url') ?? cfg.url;

  if (typeof auctionUrl !== 'string' || !auctionUrl.trim()) {
    throw new Error('Auction URL is missing');
  }

  const parsedAuctionUrl = new URL(auctionUrl);

  if (!['http:', 'https:'].includes(parsedAuctionUrl.protocol)) {
    throw new Error('Auction URL must use HTTP or HTTPS');
  }

  const qps = positiveNumber(
      numberOption(args, '--qps', cfg.load.qps),
      '--qps',
  );

  const winMin = numberOption(
      args,
      '--win-min',
      cfg.load.winRate.min,
  );

  const winMax = numberOption(
      args,
      '--win-max',
      cfg.load.winRate.max,
  );

  if (winMin < 0 || winMax > 1 || winMin > winMax) {
    throw new Error('Win-rate range must satisfy 0 <= min <= max <= 1');
  }

  const maxInFlight = positiveNumber(
      numberOption(
          args,
          '--max-in-flight',
          cfg.load.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      ),
      '--max-in-flight',
      { integer: true },
  );

  const impTarget = optionalTarget(
      numberOption(
          args,
          '--imp',
          cfg.load.stopAfter.impressions ?? null,
      ),
      '--imp',
  );

  const reqTarget = optionalTarget(
      numberOption(
          args,
          '--requests',
          cfg.load.stopAfter.requests ?? null,
      ),
      '--requests',
  );

  const configuredSeconds = cfg.load.stopAfter.seconds ?? 0;
  const durationSeconds = numberOption(
      args,
      '--duration',
      configuredSeconds > 0 ? configuredSeconds : null,
  );

  if (
      durationSeconds !== null &&
      (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
  ) {
    throw new Error('--duration must be greater than zero');
  }

  const durationMs =
      durationSeconds === null ? Infinity : durationSeconds * 1000;

  if (!Number.isFinite(durationMs) && durationMs !== Infinity) {
    throw new Error('Duration is too large');
  }

  const format =
      args.values.get('--format') ??
      cfg.traffic.formats?.[0] ??
      'banner';

  if (!['banner', 'video'].includes(format)) {
    throw new Error('--format must be banner or video');
  }

  const fireImps =
      !args.flags.has('--no-imp') &&
      cfg.traffic.fireImpressions !== false;

  const verbose = args.flags.has('--verbose');
  const quiet = args.flags.has('--quiet');

  /* ------------------------------------------------------------------------ */
  /* Request body logging                                                     */
  /* ------------------------------------------------------------------------ */

  const logBodyTo = args.values.get('--log-body') ??
      (args.flags.has('--log-body') ? 'logs/bodies.jsonl' : null);

  const logBodyLimit = Math.max(
      0,
      Math.floor(
          numberOption(args, '--log-body-limit', 100),
      ),
  );

  let bodiesLogged = 0;
  let bodyLogStream = null;

  if (logBodyTo && logBodyTo !== '-' && logBodyLimit > 0) {
    const logPath = join(ROOT, logBodyTo);

    mkdirSync(dirname(logPath), { recursive: true });

    bodyLogStream = createWriteStream(logPath, { flags: 'a' });
  }

  const controlPort = positiveNumber(
      numberOption(args, '--port', cfg.control?.port ?? 8200),
      '--port',
      { integer: true },
  );

  if (controlPort > 65535) {
    throw new Error('--port must be between 1 and 65535');
  }

  /*
   * Real app portfolio. Each fixture carries its own bundle, app.id,
   * publisher, categories and supply chain, so requests look like the
   * publisher's genuine traffic spread instead of one fixed app repeated.
   */
  const traffic = {
    ...cfg.traffic,
    apps: APP_FIXTURES,
  };

  const bundle = cfg.traffic.bundle ?? APP_FIXTURES[0].bundle;
  const appName = cfg.traffic.appName ?? APP_FIXTURES[0].name;

  const sellers = args.values.has('--seller')
      ? [{ publisherId: args.values.get('--seller'), weight: 1 }]
      : cfg.traffic.sellers;

  if (!Array.isArray(sellers) || sellers.length === 0) {
    throw new Error('At least one traffic seller must be configured');
  }

  for (const seller of sellers) {
    if (
        seller.publisherId === undefined ||
        seller.publisherId === null ||
        String(seller.publisherId).trim() === ''
    ) {
      throw new Error('Each seller must have a publisherId');
    }

    const weight = seller.weight ?? 1;

    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('Seller weights must be positive finite numbers');
    }
  }

  const sellerWeight = sellers.reduce(
      (sum, seller) => sum + (seller.weight ?? 1),
      0,
  );

  function pickSeller() {
    let remaining = Math.random() * sellerWeight;

    for (const seller of sellers) {
      remaining -= seller.weight ?? 1;

      if (remaining < 0) return seller;
    }

    return sellers[sellers.length - 1];
  }

  let urlKey = parsedAuctionUrl.searchParams.get('key') ?? '';

  const envKey =
      process.env[cfg.supplyKeyEnv ?? 'SSP_SUPPLY_KEY'] ?? '';

  // Preserve the existing contract: URL key takes precedence;
  // sendAuction receives the environment key for header authentication.
  const supplyKey = urlKey ? '' : envKey;
  const effectiveKey = urlKey || envKey;

  if (!effectiveKey) {
    throw new Error(
        'No supply key. Configure ?key=... in the URL or set the supply-key environment variable.',
    );
  }

  // Don't keep an unnecessary copy of the query key in a separate variable.
  urlKey = '';

  const safeUrl = redactUrl(auctionUrl);

  const uaPath = join(ROOT, cfg.inputs.uaFile);
  const ipPoolPath = join(ROOT, cfg.inputs.ipPoolFile);

  const uas = loadUserAgents(uaPath);

  let pool;

  try {
    pool = JSON.parse(readFileSync(ipPoolPath, 'utf8'));
  } catch {
    throw new Error(
        `Unable to read IP pool at ${cfg.inputs.ipPoolFile}. Run node src/ippool.mjs first.`,
    );
  }

  if (!uas.length || !pool.ips?.length) {
    throw new Error('User-agent list or IP pool is empty');
  }

  const randUa = () => uas[Math.floor(Math.random() * uas.length)];

  const randEndpoint = () => {
    const index = Math.floor(Math.random() * pool.ips.length);
    const meta = pool.meta?.[index] ?? {};

    return {
      ip: pool.ips[index],
      isp: meta.isp,
      metro: meta.metro,
    };
  };

  const stats = {
    startedAt: new Date().toISOString(),

    launched: 0,
    completed: 0,
    sent: 0,
    winnable: 0,
    wins: 0,
    nobid: 0,

    malformed: 0,
    unexpectedStatus: 0,
    http3xx: 0,
    http4xx: 0,
    http5xx: 0,
    netErr: 0,

    impAttempts: 0,
    impFired: 0,
    impErr: 0,
    noPixel: 0,

    lastError: null,
  };

  const auctionLatency = createLatencyTracker();
  const impressionLatency = createLatencyTracker();

  let inFlight = 0;
  let stopping = false;
  let finalized = false;
  let stopReason = null;
  let schedulerTimer = null;
  let logTimer = null;

  const startWall = Date.now();
  const startMono = performance.now();

  // A direct request cap is used when --requests is specified.
  // Otherwise, derive a safety cap for an impression target.
  const reqCap =
      reqTarget ??
      (impTarget
          ? Math.ceil((impTarget / Math.max(winMin, 0.002)) * 1.5)
          : Infinity);

  function realizedWinRate() {
    return stats.completed
        ? Number(((stats.wins / stats.completed) * 100).toFixed(2))
        : 0;
  }

  function targetReached() {
    if (impTarget !== null && stats.impFired >= impTarget) {
      return 'impression target';
    }

    if (stats.launched >= reqCap) {
      return reqTarget !== null ? 'request target' : 'request safety cap';
    }

    if (performance.now() - startMono >= durationMs) {
      return 'duration';
    }

    return null;
  }

  function snapshot() {
    const elapsedSec = Math.max(
        (performance.now() - startMono) / 1000,
        0.001,
    );

    return {
      ...stats,
      inFlight,
      stopping,
      stopReason,
      realizedWinRatePct: realizedWinRate(),
      elapsedSec: Number(elapsedSec.toFixed(2)),
      actualLaunchRateQps: Number(
          (stats.launched / elapsedSec).toFixed(2),
      ),
      actualCompletionRateQps: Number(
          (stats.completed / elapsedSec).toFixed(2),
      ),
      auctionLatency: auctionLatency.summary(),
      impressionLatency: impressionLatency.summary(),
      target: {
        impTarget,
        reqTarget,
        reqCap: Number.isFinite(reqCap) ? reqCap : null,
        durationSeconds:
            Number.isFinite(durationMs) ? durationMs / 1000 : null,
      },
    };
  }

  function finalize() {
    if (finalized || inFlight !== 0) return;

    finalized = true;
    stopping = true;

    if (schedulerTimer) clearTimeout(schedulerTimer);
    if (logTimer) clearInterval(logTimer);

    if (bodyLogStream) {
      bodyLogStream.end();
    }

    const elapsedSec = Math.max(
        (performance.now() - startMono) / 1000,
        0.001,
    );

    const result = {
      ...snapshot(),
      stopReason,
      durationSec: Number(elapsedSec.toFixed(2)),
      config: {
        url: safeUrl,
        qps,
        maxInFlight,
        winRange: [winMin, winMax],
        impTarget,
        reqTarget,
        format,
        fireImps,
        sellers: sellers.map((seller) => seller.publisherId),
        bundle,
        pool: `${pool.ips.length}ips/${pool.subnets ?? 'unknown'}subnets`,
        userAgents: uas.length,
        geoip: geoAvailable() ? geoPath() : 'disabled',
      },
    };

    if (!quiet) {
      console.log('\n=== final ===');
      console.log(JSON.stringify(result, null, 2));
    }

    // Close the control listener once all outstanding attempts are drained.
    control.close(() => {
      process.exitCode = 0;
    });
  }

  function stop(reason) {
    if (stopping) return;

    stopping = true;
    stopReason = reason;

    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
    }

    if (!quiet) {
      console.log(`stopping: ${reason} (draining ${inFlight})`);
    }

    if (inFlight === 0) finalize();
  }

  function classifyAuctionResponse(status, json) {
    if (status === 0) {
      stats.netErr += 1;
      return 'network-error';
    }

    if (status === 204) {
      stats.nobid += 1;
      return 'no-bid';
    }

    if (status === 200) {
      if (
          json &&
          typeof json === 'object' &&
          Array.isArray(json.seatbid)
      ) {
        if (json.seatbid.length > 0) {
          stats.wins += 1;
          return 'bid';
        }

        // A 200 with an empty seatbid array is a valid no-bid
        // only if your exchange explicitly uses this response form.
        stats.nobid += 1;
        return 'no-bid';
      }

      stats.malformed += 1;
      return 'malformed';
    }

    if (status >= 300 && status < 400) {
      stats.http3xx += 1;
      return 'http-redirect';
    }

    if (status >= 400 && status < 500) {
      stats.http4xx += 1;
      return 'http-4xx';
    }

    if (status >= 500 && status < 600) {
      stats.http5xx += 1;
      return 'http-5xx';
    }

    stats.unexpectedStatus += 1;
    return 'unexpected-status';
  }

  async function attempt() {
    inFlight += 1;
    stats.launched += 1;

    let auctionOutcome = 'unknown';
    let sellerId = 'unknown';
    let ip = null;
    let ua = null;

    try {
      ua = randUa();

      const deviceCheck = validateDevice(ua, parseDevice(ua));

      if (!deviceCheck.valid) {
        throw new Error(
            `UA is not a supported device fixture: ${deviceCheck.errors.join('; ')}`,
        );
      }

      /*
       * One pool entry supplies the IP, the ISP and the metro.
       *
       * They must come from the SAME entry: the exchange derives geo from
       * the IP it sees, so an IP from Dallas paired with a Boston metro is
       * a mismatch. No network call is needed here, which keeps the launch
       * path free of subprocesses and per-request lookups.
       */
      const endpoint = randEndpoint();

      const ip = endpoint.ip;

      const seller = pickSeller();
      sellerId = seller.publisherId;

      const probability =
          winMin + Math.random() * (winMax - winMin);

      const winnable = Math.random() < probability;

      if (winnable) stats.winnable += 1;

      const body = buildAuctionRequest({
        ua,
        ip,
        bundle,
        appName,
        publisherId: seller.publisherId,
        format,
        bidfloor: winnable ? WIN_FLOOR : LOSE_FLOOR,
        geoMeta: {
          isp: endpoint.isp,
          metro: endpoint.metro,
        },
        traffic,
      });

      if (verbose) {
        console.log('Auction request body:', JSON.stringify(body, null, 2));
      }

      /*
       * JSONL capture of the exact request body.
       *
       * One compact JSON object per line, so the stream stays greppable and
       * pipeable (`... --log-body | jq -c .`) and survives high qps without
       * flooding the periodic status log. `--log-body N` caps how many
       * bodies are written.
       */
      if (logBodyTo && bodiesLogged < logBodyLimit) {
        bodiesLogged += 1;

        const line = JSON.stringify({
          t: new Date().toISOString(),
          seq: bodiesLogged,
          seller: sellerId,
          winnable,
          ip: endpoint.ip,
          isp: endpoint.isp,
          metro: endpoint.metro,
          body,
        });

        if (logBodyTo === '-') {
          process.stdout.write(`${line}\n`);
        } else {
          bodyLogStream.write(`${line}\n`);
        }
      }

      const auctionStarted = performance.now();

      let result;

      try {
        result = await sendAuction(body, {
          auctionUrl,
          supplyKey,
        });
      } finally {
        auctionLatency.add(
            performance.now() - auctionStarted,
        );
      }

      stats.sent += 1;
      stats.completed += 1;

      const status = result?.status;
      const json = result?.json;

      auctionOutcome = classifyAuctionResponse(status, json);

      if (auctionOutcome === 'network-error') {
        stats.lastError = result?.error ?? 'Network error';
      } else if (
          auctionOutcome === 'http-4xx' ||
          auctionOutcome === 'http-5xx'
      ) {
        stats.lastError = `HTTP ${status}`;
      } else if (auctionOutcome === 'malformed') {
        stats.lastError = 'Malformed HTTP 200 auction response';
      } else if (auctionOutcome === 'unexpected-status') {
        stats.lastError = `Unexpected HTTP status ${status}`;
      }

      if (auctionOutcome === 'bid' && fireImps) {
        let pixel = null;

        try {
          pixel = extractImpPixel(json);
        } catch (err) {
          stats.lastError = `Impression URL extraction: ${String(err)}`;
        }

        if (pixel) {
          stats.impAttempts += 1;

          const impressionStarted = performance.now();

          try {
            /*
             * Fire from the same simulated device: same IP and same UA as
             * the auction request, so the exchange can match the impression
             * back to the bid it served.
             */
            const impressionStatus = await fireImpression(pixel, {
              headers: {
                'x-forwarded-for': ip,
                'x-real-ip': ip,
                'user-agent': ua,
              },
            });

            if (
                impressionStatus >= 200 &&
                impressionStatus < 400
            ) {
              stats.impFired += 1;
            } else {
              stats.impErr += 1;
              stats.lastError =
                  `Impression HTTP ${impressionStatus}`;
            }
          } catch (err) {
            stats.impErr += 1;
            stats.lastError = `Impression request: ${String(err)}`;
          } finally {
            impressionLatency.add(
                performance.now() - impressionStarted,
            );
          }
        } else {
          stats.noPixel += 1;
        }
      }

      if (verbose) {
        console.log(
            `auction=${auctionOutcome} seller=${sellerId} ` +
            `status=${status ?? 'unknown'} ` +
            `impression=${fireImps ? 'enabled' : 'disabled'}`,
        );
      }
    } catch (err) {
      // This also catches request construction and other unexpected errors.
      // Avoid leaving inFlight permanently incremented.
      stats.netErr += 1;
      stats.lastError = String(err);

      if (verbose) {
        console.error(`attempt failed: ${String(err)}`);
      }
    } finally {
      inFlight -= 1;

      if (stopping && inFlight === 0) {
        finalize();
      }
    }
  }

  // Fixed-rate scheduler without token accumulation or catch-up bursts.
  //
  // A request is launched only when its scheduled time arrives and capacity
  // is available. If the worker is saturated, the schedule is reset instead
  // of attempting to catch up with a burst of queued requests.
  const intervalMs = 1000 / qps;
  let nextDue = performance.now();

  function scheduleNext() {
    if (stopping) return;

    const remaining = Math.max(0, nextDue - performance.now());

    schedulerTimer = setTimeout(runScheduler, remaining);
  }

  function runScheduler() {
    if (stopping) return;

    const reached = targetReached();

    if (reached) {
      stop(reached);
      return;
    }

    const now = performance.now();

    if (inFlight < maxInFlight && now >= nextDue) {
      // Do not accumulate missed ticks. Schedule the next launch relative
      // to the current time to avoid catch-up bursts after event-loop stalls.
      nextDue = now + intervalMs;
      void attempt();
    } else if (inFlight >= maxInFlight) {
      // Check capacity again soon, without creating a backlog.
      nextDue = now + Math.min(intervalMs, 10);
    }

    scheduleNext();
  }

  const control = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');

    if (req.method === 'GET' &&
        (req.url === '/status' || req.url === '/')) {
      res.writeHead(200, {
        'content-type': 'application/json',
      });

      res.end(JSON.stringify(snapshot(), null, 2));
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      res.writeHead(200, {
        'content-type': 'application/json',
      });

      res.end(JSON.stringify({
        ok: true,
        stopping: true,
      }));

      stop('control /stop');
      return;
    }

    res.writeHead(404, {
      'content-type': 'application/json',
    });

    res.end(JSON.stringify({
      error: 'Not found',
    }));
  });

  control.on('error', (err) => {
    console.error(`Control server error: ${String(err)}`);

    if (!stopping) {
      stop('control server error');
    }
  });

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  if (!quiet) {
    logTimer = setInterval(() => {
      const current = snapshot();

      console.log(
          `[${current.elapsedSec}s] ` +
          `launched=${stats.launched} completed=${stats.completed} ` +
          `wins=${stats.wins} (${current.realizedWinRatePct}%) ` +
          `nobid=${stats.nobid} ` +
          `errors=${stats.http3xx + stats.http4xx + stats.http5xx + stats.netErr + stats.malformed + stats.unexpectedStatus} ` +
          `launchQPS=${current.actualLaunchRateQps} ` +
          `completeQPS=${current.actualCompletionRateQps} ` +
          `inflight=${inFlight} ` +
          `auctionP95=${current.auctionLatency.p95Ms ?? '-'}ms ` +
          `imp=${stats.impFired}` +
          (impTarget !== null ? `/${impTarget}` : '') +
          (stats.lastError ? ` last="${stats.lastError}"` : ''),
      );
    }, LOG_INTERVAL_MS);
  }

  control.listen(controlPort, '127.0.0.1', async () => {
    /*
     * GeoIP database: device.geo is derived from the IP via MaxMind, so a
     * missing database silently downgrades every request to the pool's
     * coarse CIDR guess. Load it before any request is built.
     */
    const geo = await initGeoIP();

    if (!quiet) {
      console.log(
          geo.ok
              ? `geoip OK: ${geo.path}`
              : `!! GEOIP DISABLED: ${geo.error}`,
      );
    }

    /*
     * Proxy preflight.
     *
     * A proxy that is configured but bypassed is worse than none: traffic
     * leaves from this machine's own IP while appearing proxied. Check it
     * once up front and refuse to start quietly in that state.
     */
    const proxyProblem = proxyProblemForStartup();

    if (proxyProblem && !quiet) {
      console.error(`\n!! PROXY PROBLEM\n${proxyProblem}\n`);
    } else if (!quiet && getProxyCredentials()) {
      const preflight = await verifyProxy({ timeoutMs: 15_000 });

      if (preflight.ok) {
        console.log(
            `proxy OK: exit ${preflight.ip} (${preflight.country} ${preflight.city ?? '-'})`,
        );
      } else {
        console.error(`\n!! PROXY PREFLIGHT FAILED\n${preflight.error}\n`);
      }
    }

    if (!quiet) {
      const eta =
          impTarget !== null && qps > 0
              ? Math.round(
                  impTarget / (Math.max((winMin + winMax) / 2, 0.002) * qps),
              )
              : null;

      console.log(
          `SSP load tester ready ` +
          `url=${safeUrl} qps=${qps} maxInFlight=${maxInFlight} ` +
          `winRate=${winMin * 100}-${winMax * 100}% ` +
          `target=${impTarget !== null ? `${impTarget}imp` : reqTarget !== null ? `${reqTarget}req` : durationMs !== Infinity ? `${durationSeconds}s` : 'none'} ` +
          `fireImp=${fireImps} ` +
          `sellers=[${sellers.map((seller) => seller.publisherId).join(',')}] ` +
          `pool=${pool.ips.length}ips uas=${uas.length} ` +
          `control=127.0.0.1:${controlPort}` +
          (logBodyTo
            ? ` logBody=${logBodyTo === '-' ? 'stdout' : logBodyTo}(max ${logBodyLimit})`
            : '') +
          (eta ? ` estimatedETA=${eta}s` : ''),
      );
    }

    scheduleNext();
  });
}

try {
  main();
} catch (err) {
  console.error(`Startup failed: ${String(err)}`);
  process.exitCode = 1;
}