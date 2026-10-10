/**
 * Local authenticating forward proxy for Chromium.
 *
 * WHY THIS EXISTS
 *
 * Chromium's handling of an authenticating upstream proxy is unreliable: with
 * credentials configured it can stall waiting on a proxy auth challenge, which
 * Playwright surfaces as a hang rather than an error.
 *
 * So instead of pointing Chromium at the residential proxy directly, we point
 * it at a local proxy on 127.0.0.1 that needs NO authentication, and this
 * process relays every request and tunnel to the real upstream proxy with the
 * credentials attached. Chromium never sees an auth challenge, so it never
 * stalls.
 *
 * It also means the credentials stay in one place (this process) rather than
 * being handed to a browser.
 *
 * Two paths:
 *
 *   HTTP    absolute-form request-target is forwarded with Proxy-Authorization
 *   CONNECT a tunnel is opened upstream and the two sockets are piped together
 */

import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

/**
 * Start the bridge.
 *
 * @param {object} options
 * @param {string} options.upstream   upstream proxy URL, e.g. http://user:pass@host:port
 * @param {number} [options.port]     0 picks a free port
 * @param {string} [options.host]     bind address, default 127.0.0.1
 * @param {(msg: string) => void} [options.onLog]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, stats: object}>}
 */
export async function startProxyBridge({
  upstream,
  port = 0,
  host = '127.0.0.1',
  onLog = () => {},
} = {}) {
  if (!upstream) throw new Error('proxy bridge requires an upstream URL');

  const upstreamUrl = new URL(upstream);

  if (!upstreamUrl.hostname || !upstreamUrl.port) {
    throw new Error(`upstream must include host and port: ${upstream}`);
  }

  const authHeader =
      upstreamUrl.username || upstreamUrl.password
          ? `Basic ${Buffer.from(
              `${decodeURIComponent(upstreamUrl.username)}:${decodeURIComponent(upstreamUrl.password)}`,
          ).toString('base64')}`
          : null;

  const stats = { http: 0, connect: 0, tunnels: 0, retries: 0, errors: 0, bypassed: 0 };

  /*
   * Loopback must NOT go upstream.
   *
   * A residential proxy cannot reach 127.0.0.1, so tunnelling local testing
   * traffic through it fails. Chromium also ignores NO_PROXY in some proxy
   * configurations, so the bypass is enforced here instead.
   */
  const isLoopback = (target) => {
    const host = String(target).split(':')[0].replace(/^\[|\]$/g, '');

    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('127.')
    );
  };

  /** Open a raw TCP connection to the upstream proxy. */
  const dialUpstream = () =>
      net.connect(Number(upstreamUrl.port), upstreamUrl.hostname);

  const server = http.createServer((req, res) => {
    /*
     * Plain HTTP: req.url is absolute-form (http://host/path). Forward it
     * upstream with credentials.
     */
    stats.http += 1;

    let targetHost;

    try {
      targetHost = new URL(req.url).host;
    } catch {
      targetHost = req.headers.host ?? '';
    }

    if (isLoopback(targetHost)) {
      stats.bypassed += 1;

      const direct = http.request(
          { host: targetHost.split(':')[0], port: Number(targetHost.split(':')[1] ?? 80), method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, headers: req.headers },
          (directRes) => {
            res.writeHead(directRes.statusCode ?? 502, directRes.headers);
            directRes.pipe(res);
          },
      );

      direct.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('bridge bypass error');
      });

      req.pipe(direct);
      return;
    }

    const headers = { ...req.headers };

    if (authHeader) headers['proxy-authorization'] = authHeader;

    const upstreamReq = http.request(
        {
          host: upstreamUrl.hostname,
          port: Number(upstreamUrl.port),
          method: req.method,
          path: req.url,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
    );

    upstreamReq.on('error', (error) => {
      stats.errors += 1;
      onLog(`bridge http error: ${String(error?.message ?? error)}`);

      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }

      res.end('bridge error');
    });

    req.pipe(upstreamReq);
  });

  /*
   * HTTPS: Chromium issues CONNECT target:443. We open the same CONNECT to
   * the upstream proxy and then pipe bytes both ways.
   */
  /**
   * Attempt one CONNECT to the upstream.
   *
   * Resolves with { ok, socket, statusLine } — never throws for a refused
   * tunnel, because a refusal is a normal outcome that the caller retries.
   */
  const attemptConnect = (target, timeoutMs = 20_000) =>
    new Promise((resolve) => {
      const upstreamSocket = dialUpstream();
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        upstreamSocket.off('data', onData);
        resolve(result);
      };

      const timer = setTimeout(() => {
        upstreamSocket.destroy();
        finish({ ok: false, statusLine: 'timeout' });
      }, timeoutMs);

      upstreamSocket.once('error', (error) => {
        finish({ ok: false, statusLine: String(error?.message ?? error) });
      });

      upstreamSocket.once('connect', () => {
        const lines = [
          `CONNECT ${target} HTTP/1.1`,
          `Host: ${target}`,
          'Proxy-Connection: Keep-Alive',
        ];

        if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`);

        upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });

      let responseBuffer = Buffer.alloc(0);

      const onData = (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);

        const end = responseBuffer.indexOf('\r\n\r\n');

        if (end === -1) {
          if (responseBuffer.length > 64 * 1024) {
            upstreamSocket.destroy();
            finish({ ok: false, statusLine: 'response too large' });
          }

          return;
        }

        const statusLine = responseBuffer.subarray(0, end).toString('latin1').split('\r\n')[0];
        const ok = /^HTTP\/1\.[01] 2\d\d/.test(statusLine);
        const rest = responseBuffer.subarray(end + 4);

        finish({ ok, socket: upstreamSocket, statusLine, rest });
      };

      upstreamSocket.on('data', onData);
    });

  server.on('connect', async (req, clientSocket, head) => {
    stats.connect += 1;

    if (isLoopback(req.url)) {
      stats.bypassed += 1;

      const [host, port] = String(req.url).split(':');
      const direct = net.connect(Number(port), host.replace(/^\[|\]$/g, ''));

      direct.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) direct.write(head);
        direct.pipe(clientSocket);
        clientSocket.pipe(direct);
      });

      direct.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      clientSocket.on('error', () => direct.destroy());

      return;
    }

    /*
     * Retry transient upstream failures.
     *
     * "503 Exit node overloaded" is a routine response from this gateway and
     * says nothing about the request, so a single attempt would fail a large
     * share of requests. Credential rejections (407) are NOT retried.
     */
    let attempt = await attemptConnect(req.url);
    let tries = 1;

    while (!attempt.ok && tries < 4 && !/\b407\b/.test(attempt.statusLine)) {
      stats.retries += 1;
      await new Promise((r) => setTimeout(r, 250 * tries));
      attempt = await attemptConnect(req.url);
      tries += 1;
    }

    if (!attempt.ok) {
      stats.errors += 1;
      onLog(`bridge CONNECT refused after ${tries} attempt(s): ${attempt.statusLine}`);
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      attempt.socket?.destroy();
      return;
    }

    const upstreamSocket = attempt.socket;

    stats.tunnels += 1;

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    if (attempt.rest?.length) clientSocket.write(attempt.rest);
    if (head?.length) upstreamSocket.write(head);

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    const cleanup = () => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };

    upstreamSocket.on('error', () => { stats.errors += 1; cleanup(); });
    clientSocket.on('error', cleanup);
    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());
  });

  server.on('error', (error) => {
    stats.errors += 1;
    onLog(`bridge server error: ${String(error?.message ?? error)}`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    stats,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
