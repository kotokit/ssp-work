/**
 * Per-request proxy rotation pool.
 *
 * Proxy-Cheap routes each session ID to a deterministic exit IP. By creating
 * multiple sessions with different IDs, we get a pool of distinct residential
 * IPs. Each auction request picks one session (round-robin), uses it for both
 * the auction and the impression/click, so the impression always comes from
 * the same IP as the bid.
 *
 * Usage:
 *   const pool = await ProxyRotationPool.create({ size: 20 });
 *   // For each request:
 *   const session = pool.next();
 *   await sendAuction(body, { dispatcher: session.dispatcher });
 *   await fireImpression(pixel, { dispatcher: session.dispatcher });
 *   // At shutdown:
 *   await pool.close();
 */

import { ProxyAgent } from 'undici';
import { getProxyCredentials } from './pr.mjs';
import { buildTlsConfig } from './us-session.mjs';
import { getGeoDetail } from './geo.mjs';

const IP_ECHO = 'https://ipv4.icanhazip.com';

/**
 * Resolve one session to its exit IP by probing through the proxy.
 */
async function resolveSession(session, { attempts = 4, timeoutMs = 15_000 } = {}) {
  let lastError = 'no attempt';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const agent = new ProxyAgent({
      uri: session.proxyUrl,
      connections: 1,
      pipelining: 1,
      tls: buildTlsConfig(),
    });

    try {
      const { request } = await import('undici');
      const response = await request(IP_ECHO, {
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      if (response.statusCode === 200) {
        const ip = (await response.body.text()).trim();

        if (!/^[0-9a-f.:]+$/i.test(ip)) {
          lastError = `unexpected echo response: ${ip.slice(0, 40)}`;
          await response.body.dump().catch(() => {});
          continue;
        }

        const detail = getGeoDetail(ip);

        await agent.close().catch(() => {});

        return {
          ok: true,
          ip,
          country: detail?.country ?? null,
          city: detail?.city ?? null,
          region: detail?.region ?? null,
          metro: detail?.metro ?? null,
          zip: detail?.zip ?? null,
        };
      }

      const message = response.headers['proxy-message'] ?? `HTTP ${response.statusCode}`;
      await response.body.dump().catch(() => {});
      lastError = String(message);

      if (response.statusCode === 407) {
        await agent.close().catch(() => {});
        return { ok: false, fatal: true, error: `rejected: ${message}` };
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
    } finally {
      await agent.close().catch(() => {});
    }

    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Build the proxy URL for a session.
 */
function buildProxyUrl(credentials, session) {
  return `http://${credentials.user}:${session.password}@${credentials.host}:${credentials.port}`;
}

/**
 * Proxy rotation pool. Manages a set of proxy sessions, each mapped to a
 * unique residential exit IP. Rounds-robin assigns sessions for each
 * auction request so that every request exits from a different IP, while
 * the impression/click for that auction uses the same session (same IP).
 */
export class ProxyRotationPool {
  /**
   * @param {object} options
   * @param {number} options.size  How many sessions to create. Default: 20.
   * @param {number} options.ttl   Session TTL in minutes. Default: 10.
   * @param {string} options.country  Target country code. Default: 'US'.
   * @param {number} options.timeoutMs  Per-session resolve timeout. Default: 15000.
   */
  static async create({
    size = 20,
    ttl = 10,
    country = 'US',
    timeoutMs = 15_000,
  } = {}) {
    const credentials = getProxyCredentials();

    if (!credentials) {
      throw new Error('No proxy configured (PROXY_HOST/PORT/USER/PASS missing in .env).');
    }

    /*
     * Derive the BASE password — strip any _country-XX_ session-XX_ttl-XX
     * suffix so we can mint new sessions from it.
     */
    const base = String(credentials.pass).split('_country-')[0];

    const sessions = [];
    const resolved = [];

    /* Generate sessions with sequential numeric IDs for better IP distribution. */
    for (let i = 0; i < size; i += 1) {
      const sessionId = String(i).padStart(6, '0');
      const password = `${base}_country-${country}_session-${sessionId}_ttl-${ttl}`;
      const proxyUrl = buildProxyUrl(credentials, { password });

      sessions.push({
        id: sessionId,
        password,
        proxyUrl,
        dispatcher: null,
        ip: null,
        country: null,
        city: null,
        resolved: false,
      });
    }

    /* Resolve each session to its exit IP. */
    const resolutionBatches = [];
    for (let i = 0; i < sessions.length; i += Math.min(size, 24)) {
      resolutionBatches.push(sessions.slice(i, i + Math.min(size, 24)));
    }

    for (const batch of resolutionBatches) {
      const results = await Promise.allSettled(
        batch.map((session) => resolveSession(session, { attempts: 4, timeoutMs })),
      );

      for (let i = 0; i < batch.length; i += 1) {
        const result = results[i];
        const session = batch[i];

        if (result?.status === 'fulfilled' && result.value.ok) {
          session.ip = result.value.ip;
          session.country = result.value.country;
          session.city = result.value.city;
          session.resolved = true;
          resolved.push(session);
          console.log(
            `  session-${session.id.padEnd(8)} → ${result.value.ip.padEnd(15)} (${result.value.city ?? 'unknown'}, ${result.value.country ?? 'unknown'})`,
          );
        } else {
          console.warn(
            `  ! session-${session.id}: ${result?.value?.error ?? 'unknown error'}`,
          );
        }
      }
    }

    /*
     * Build dispatchers for resolved sessions. We create one dispatcher per
     * session so each maintains its own persistent connection to the proxy.
     */
    for (const session of resolved) {
      session.dispatcher = new ProxyAgent({
        uri: session.proxyUrl,
        connections: 1,
        pipelining: 1,
        tls: buildTlsConfig(),
      });
    }

    const pool = {
      _sessions: resolved,
      _index: 0,
      _size: resolved.length,

      /**
       * Return the next session (round-robin) for the next auction request.
       * The returned session's dispatcher should be used for both the auction
       * and its impression/click to ensure IP consistency.
       */
      next() {
        if (this._size === 0) {
          throw new Error('Proxy rotation pool is empty (no sessions resolved).');
        }

        const session = this._sessions[this._index % this._size];
        this._index += 1;
        return session;
      },

      /**
       * Return the list of resolved sessions (for diagnostics).
       */
      getSessions() {
        return this._sessions;
      },

      /**
       * Return the number of active sessions.
       */
      get size() {
        return this._size;
      },

      /**
       * Close all dispatchers and release connections.
       */
      async close() {
        const closePromises = this._sessions.map((s) =>
          s.dispatcher?.close().catch(() => {}),
        );
        await Promise.all(closePromises);
      },
    };

    console.log(`  proxy rotation pool: ${resolved.length}/${size} sessions resolved`);

    return pool;
  }
}
