#!/usr/bin/env node
/**
 * Local mock ad exchange for internal testing.
 *
 * This is NOT an ad server. It is a spec-strict stand-in for your exchange
 * so the whole funnel (request -> auction -> win -> impression) can be
 * exercised on 127.0.0.1 with no external traffic.
 *
 * It behaves like a real exchange in the ways that matter for testing:
 *
 *   - validates every incoming bid request against OpenRTB 2.6 rules
 *     (same validator the generator uses) and REJECTS invalid ones with
 *     400 + a machine-readable reason
 *   - returns 204 No Content for a no-bid, exactly like a real exchange
 *   - returns 200 + seatbid with a creatives adm containing a sealed
 *     `/t/imp?e=...` pixel on a win
 *   - records the impression pixel fire so you can confirm the funnel
 *     closed, and reports whether the pixel IP matched the auction IP
 *
 * Endpoints:
 *
 *   POST /openrtb2/auction    auction endpoint
 *   GET  /t/imp?e=TOKEN       impression pixel
 *   GET  /                    dashboard (HTML)
 *   GET  /stats               machine-readable counters
 *   GET  /requests            captured bid requests (JSON)
 *   GET  /events              auction + impression event log (JSON)
 *   POST /reset               clear captured state
 *
 * Run:
 *   node src/mock-exchange.mjs
 *   node src/mock-exchange.mjs --port 8080 --win-rate 1.0
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { validateBidRequest, formatValidation } from './validate.mjs';
import { initGeoIP } from './geo.mjs';

const HELP = `
Local mock ad exchange.

Options:
  --port N            Listen port. Default: 8080
  --win-rate P        Probability of returning a bid, 0..1. Default: 1.0
  --bid-price N       CPM in the bid response. Default: 1.25
  --max-keep N        Captured requests/events to retain. Default: 200
  --quiet             Suppress per-request logging.
  --help              Show this help.

Endpoints:
  POST /openrtb2/auction   auction
  GET  /t/imp?e=TOKEN      impression pixel
  GET  /                   dashboard
  GET  /stats              counters
  GET  /requests           captured bid requests
  GET  /events             event log
  POST /reset              clear state
`;

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();

  const valued = new Set(['--port', '--win-rate', '--bid-price', '--max-keep']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--quiet' || token === '--help') {
      flags.add(token);
      continue;
    }

    if (!valued.has(token)) {
      throw new Error(`Unknown option: ${token}`);
    }

    const value = argv[i + 1];

    if (value === undefined) {
      throw new Error(`Missing value for ${token}`);
    }

    values.set(token, value);
    i += 1;
  }

  return { values, flags };
}

const num = (value, fallback) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Not a number: ${value}`);
  return parsed;
};

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
  auctions: 0,
  bids: 0,
  nobids: 0,
  rejected: 0,
  impressions: 0,
  impressionMismatch: 0,
  startedAt: new Date().toISOString(),
  lastRequestAt: null,
  lastRejection: null,
};

let requests = [];
let events = [];

/*
 * token -> the IP the winning auction used, so an impression can be checked
 * against the bid it claims to belong to. A pixel fired from a different IP
 * than the auction is exactly the inconsistency this harness exists to catch.
 */
const auctionByToken = new Map();

const record = (list, entry, limit) => {
  list.push(entry);

  while (list.length > limit) {
    list.shift();
  }

  return list;
};

const log = (entry) => record(events, entry, 500);

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('--help')) {
    console.log(HELP);
    return;
  }

  const port = num(args.values.get('--port'), 8080);
  const winRate = num(args.values.get('--win-rate'), 1.0);
  const bidPrice = num(args.values.get('--bid-price'), 1.25);
  const maxKeep = num(args.values.get('--max-keep'), 200);
  const quiet = args.flags.has('--quiet');

  if (port <= 0 || port > 65535) {
    throw new Error('--port must be between 1 and 65535');
  }

  if (winRate < 0 || winRate > 1) {
    throw new Error('--win-rate must be between 0 and 1');
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

    /* -------------------------------------------------------------------- */
    /* Auction                                                              */
    /* -------------------------------------------------------------------- */

    if (req.method === 'POST' && url.pathname === '/openrtb2/auction') {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk;

        /* Refuse absurd payloads rather than buffering forever. */
        if (body.length > 2_000_000) {
          req.destroy();
        }
      });

      req.on('end', () => {
        handleAuction(req, res, body);
      });

      return;
    }

    /* -------------------------------------------------------------------- */
    /* Impression pixel                                                     */
    /* -------------------------------------------------------------------- */

    if (req.method === 'GET' && url.pathname === '/t/imp') {
      const token = url.searchParams.get('e');
      const forwardedFor =
          req.headers['x-forwarded-for'] ??
          req.headers['x-real-ip'] ??
          null;

      const ip = forwardedFor
          ? String(forwardedFor).split(',')[0].trim()
          : null;

      state.impressions += 1;

      /*
       * Did this pixel come from the same IP as the auction it claims?
       */
      const expected = token ? auctionByToken.get(token) : undefined;
      const matched = expected === undefined
          ? null
          : (expected === null || expected === ip);

      if (matched === false) {
        state.impressionMismatch += 1;
      }

      const fired = {
        at: new Date().toISOString(),
        token,
        ip,
        expectedIp: expected ?? null,
        ipMatched: matched,
        socketIp: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'] ?? null,
      };

      log({ type: 'impression', ...fired });

      if (!quiet) {
        console.log(
            `impression  token=${token ?? '-'} xff=${ip ?? '-'} ` +
            `match=${matched === null ? 'n/a' : matched ? 'yes' : 'NO'} ` +
            `ua=${(fired.userAgent ?? '').slice(0, 34)}`,
        );
      }

      /*
       * A 1x1 transparent GIF. This is what a real pixel returns, and it
       * also proves the caller is not relying on a JSON body.
       */
      const pixel = Buffer.from(
          'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          'base64',
      );

      res.writeHead(200, {
        'content-type': 'image/gif',
        'content-length': pixel.length,
        'cache-control': 'no-store, no-cache, must-revalidate',
        'access-control-allow-origin': '*',
      });

      res.end(pixel);
      return;
    }

    /* -------------------------------------------------------------------- */
    /* Inspection                                                           */
    /* -------------------------------------------------------------------- */

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/stats')) {
      const payload = {
        ...state,
        impressions: state.impressions,
        winRate,
        bidPrice,
        capturedRequests: requests.length,
        capturedEvents: events.length,
        uptimeSec: Number(
            ((Date.now() - Date.parse(state.startedAt)) / 1000).toFixed(1),
        ),
      };

      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(dashboard(payload));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests, null, 2));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(events, null, 2));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reset') {
      requests = [];
      events = [];
      auctionByToken.clear();

      Object.assign(state, {
        auctions: 0,
        bids: 0,
        nobids: 0,
        rejected: 0,
        impressions: 0,
        impressionMismatch: 0,
        lastRequestAt: null,
        lastRejection: null,
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
  });

  /* ---------------------------------------------------------------------- */
  /* Auction handling                                                       */
  /* ---------------------------------------------------------------------- */

  function handleAuction(req, res, rawBody) {
    state.auctions += 1;
    state.lastRequestAt = new Date().toISOString();

    const received = {
      at: state.lastRequestAt,

      /*
       * The actual TCP source address. Unlike x-forwarded-for (which the
       * caller sets), this is what the server really saw, so it is the only
       * trustworthy way to confirm a bid and its impression arrived from the
       * same IP.
       */
      socketIp: req.socket.remoteAddress,

      headers: {
        'content-type': req.headers['content-type'] ?? null,
        'user-agent': req.headers['user-agent'] ?? null,
        'x-forwarded-for': req.headers['x-forwarded-for'] ?? null,
        'x-real-ip': req.headers['x-real-ip'] ?? null,
        'x-openrtb-version': req.headers['x-openrtb-version'] ?? null,
      },
      bytes: Buffer.byteLength(rawBody),
    };

    /* -- Parse ---------------------------------------------------------- */

    let request;

    try {
      request = JSON.parse(rawBody);
    } catch (error) {
      state.rejected += 1;

      const reason = `Malformed JSON: ${String(error?.message ?? error)}`;
      state.lastRejection = reason;

      record(requests, { ...received, rejected: reason }, maxKeep);
      log({ type: 'rejected', reason });

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'invalid_request',
        reason,
      }));

      if (!quiet) console.log(`rejected    ${reason}`);
      return;
    }

    /* -- Validate ------------------------------------------------------- */

    const validation = validateBidRequest(request);

    if (!validation.valid) {
      state.rejected += 1;

      const reason = validation.errors
          .map((e) => `${e.path}: ${e.message}`)
          .join('; ');

      state.lastRejection = reason;

      record(requests, {
        ...received,
        request,
        rejected: reason,
        errors: validation.errors,
      }, maxKeep);

      log({ type: 'rejected', reason, errors: validation.errors });

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'invalid_request',
        reason,
        errors: validation.errors,
      }));

      if (!quiet) {
        console.log(`rejected    ${validation.errors.length} error(s)`);

        for (const e of validation.errors) {
          console.log(`  ✗ ${e.path}: ${e.message}`);
        }
      }

      return;
    }

    record(requests, {
      ...received,
      request,
      warnings: validation.warnings,
      stats: validation.stats,
    }, maxKeep);

    /* -- No-bid --------------------------------------------------------- */

    if (Math.random() > winRate) {
      state.nobids += 1;

      log({ type: 'nobid', id: request.id });

      if (!quiet) {
        console.log(`no-bid      204  id=${request.id}`);
      }

      res.writeHead(204);
      res.end();
      return;
    }

    /* -- Bid ------------------------------------------------------------ */

    state.bids += 1;

    const imp = request.imp[0];
    const token = randomUUID();
    const origin = `http://127.0.0.1:${port}`;
    const pixel = `${origin}/t/imp?e=${token}`;

    /*
     * Remember which IP won this auction so the impression can be checked
     * against it.
     */
    auctionByToken.set(token, request.device?.ip ?? null);

    /* Bound the map so a long run cannot grow without limit. */
    if (auctionByToken.size > 5000) {
      const oldest = auctionByToken.keys().next().value;
      auctionByToken.delete(oldest);
    }

    /*
     * A minimal MRAID-ish banner creative carrying the sealed impression
     * pixel, which is what the SSP harness scrapes out of bid.adm.
     */
    const adm =
        `<div style="width:${imp.banner?.w ?? 320}px;height:${imp.banner?.h ?? 50}px">` +
        `<a href="${origin}/click?e=${token}" target="_blank">` +
        `<img src="${pixel}" width="${imp.banner?.w ?? 320}" height="${imp.banner?.h ?? 50}" alt="">` +
        `</a></div>`;

    const response = {
      id: request.id,
      seatbid: [
        {
          seat: 'mock-dsp',
          bid: [
            {
              id: randomUUID(),
              impid: imp.id,
              price: bidPrice,
              adm,
              nurl: `${origin}/win?e=${token}&price=${bidPrice}`,
              crid: 'mock-creative-1',
              w: imp.banner?.w ?? 320,
              h: imp.banner?.h ?? 50,
            },
          ],
        },
      ],
      cur: 'USD',
    };

    log({ type: 'bid', id: request.id, price: bidPrice, token });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));

    if (!quiet) {
      console.log(
          `bid         ${bidPrice}  id=${request.id} ` +
          `imp=${imp.id} model=${request.device?.model ?? '-'} ` +
          `geo=${request.device?.geo?.city ?? request.device?.geo?.region ?? '-'} ` +
          `warn=${validation.warnings.length}`,
      );
    }
  }

  server.listen(port, '127.0.0.1', async () => {
    /*
     * Load the GeoIP database before serving. It enables the geo-vs-IP
     * coherence check, which is what catches a request whose device.geo
     * disagrees with its own device.ip — the mismatch a real exchange
     * detects by geolocating the address itself.
     */
    const geo = await initGeoIP();

    console.log(
        `  geoip:       ${geo.ok ? geo.path : `DISABLED (${geo.error})`}`,
    );

    console.log(
        `mock exchange listening on http://127.0.0.1:${port}\n` +
        `  auction:     POST http://127.0.0.1:${port}/openrtb2/auction\n` +
        `  impression:  GET  http://127.0.0.1:${port}/t/imp?e=TOKEN\n` +
        `  dashboard:   http://127.0.0.1:${port}/\n` +
        `  winRate=${winRate} bidPrice=${bidPrice}`,
    );
  });

  process.on('SIGINT', () => {
    console.log('\n\n=== mock exchange summary ===');
    console.log(JSON.stringify(state, null, 2));
    server.close(() => process.exit(0));
  });
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

function dashboard(stats) {
  const rows = requests
      .slice(-25)
      .reverse()
      .map((entry) => {
        const req = entry.request ?? {};
        const geo = req.device?.geo ?? {};

        return `<tr>
          <td>${escapeHtml(entry.at ?? '')}</td>
          <td>${entry.rejected
            ? `<span class="bad">REJECTED</span>`
            : `<span class="ok">accepted</span>`}</td>
          <td>${escapeHtml(req.device?.model ?? '-')}</td>
          <td>${escapeHtml(req.device?.ip ?? '-')}</td>
          <td>${escapeHtml(geo.city ?? geo.region ?? '-')}</td>
          <td>${escapeHtml(req.device?.carrier ?? '-')}</td>
          <td>${escapeHtml(String(req.imp?.[0]?.bidfloor ?? '-'))}</td>
          <td>${entry.warnings?.length ?? 0}</td>
        </tr>`;
      })
      .join('\n');

  const impressions = events
      .filter((e) => e.type === 'impression')
      .slice(-15)
      .reverse()
      .map((e) => `<tr>
          <td>${escapeHtml(e.at ?? '')}</td>
          <td>${escapeHtml((e.token ?? '-').slice(0, 8))}</td>
          <td>${escapeHtml(e.ip ?? '-')}</td>
          <td>${escapeHtml((e.userAgent ?? '-').slice(0, 48))}</td>
        </tr>`)
      .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>mock exchange</title>
<style>
  body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:24px;background:#111;color:#ddd}
  h1{font-size:16px;margin:0 0 4px} h2{font-size:14px;margin:24px 0 8px;color:#9ad}
  table{border-collapse:collapse;width:100%;margin-bottom:8px}
  th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #2a2a2a;white-space:nowrap}
  th{color:#888;font-weight:normal}
  .ok{color:#4caf50}.bad{color:#e05252}
  .cards{display:flex;gap:16px;flex-wrap:wrap;margin:12px 0}
  .card{background:#1b1b1b;border:1px solid #2a2a2a;border-radius:6px;padding:10px 14px;min-width:90px}
  .card b{display:block;font-size:20px;color:#fff}
  .muted{color:#777}
</style></head><body>
<h1>mock exchange</h1>
<div class="muted">started ${escapeHtml(stats.startedAt)} · uptime ${stats.uptimeSec}s</div>
<div class="cards">
  <div class="card"><b>${stats.auctions}</b>auctions</div>
  <div class="card"><b class="ok">${stats.bids}</b>bids</div>
  <div class="card"><b>${stats.nobids}</b>no-bids</div>
  <div class="card"><b class="${stats.rejected ? 'bad' : ''}">${stats.rejected}</b>rejected</div>
  <div class="card"><b>${stats.impressions}</b>impressions</div>
</div>
${stats.lastRejection ? `<div class="bad">last rejection: ${escapeHtml(stats.lastRejection)}</div>` : ''}
<h2>recent auctions</h2>
<table>
<tr><th>time</th><th>status</th><th>model</th><th>ip</th><th>geo</th><th>carrier</th><th>floor</th><th>warn</th></tr>
${rows || '<tr><td colspan="8" class="muted">none yet</td></tr>'}
</table>
<h2>recent impressions</h2>
<table>
<tr><th>time</th><th>token</th><th>xff ip</th><th>user-agent</th></tr>
${impressions || '<tr><td colspan="4" class="muted">none yet</td></tr>'}
</table>
</body></html>`;
}

function escapeHtml(value) {
  return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
}

try {
  main();
} catch (error) {
  console.error(`Startup failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
