/**
 * US-pinned residential proxy session.
 *
 * WHY THIS EXISTS
 *
 * Proxy-Cheap's rotating residential product has NO username syntax for
 * country or session. The gateway rejects anything but the exact generated
 * username with `401 Invalid credentials`, and all routing (country, session
 * type, session id) is baked in by the dashboard credentials generator.
 *
 * What we CAN control, verified empirically:
 *
 *   1. A distinct ProxyAgent connection gets a distinct exit IP. Several
 *      concurrent connections from one process produced several countries.
 *   2. Once established, a connection is PINNED to that exit IP for its
 *      whole life. Six sequential requests on one pinned connection all
 *      returned the identical IP.
 *
 * So a US exit is obtainable by opening several pinned connections and
 * keeping the first whose exit IP geolocates to the US. That connection then
 * carries the entire funnel — auction and every impression URL — so the bid
 * and its impressions originate from ONE US residential IP, which is exactly
 * what an exchange cross-checks.
 *
 * Usage:
 *
 *   const session = await openUsSession();
 *   if (session.ok) {
 *     // route the auction and the pixels through session.dispatch
 *     await sendAuction(body, { dispatcher: session.dispatcher });
 *     await fireImpression(pixel, { dispatcher: session.dispatcher });
 *     await session.close();
 *   }
 */

import { ProxyAgent, request } from 'undici';

import { getProxyCredentials } from './pr.mjs';
import { getGeoDetail } from './geo.mjs';

/**
 * Endpoint used to discover the exit IP of a candidate connection.
 *
 * Deliberately a plain-text echo, not a JSON geo service. Geo comes from the
 * local GeoLite2 database, so the only thing needed here is the address — and
 * JSON geo APIs rate-limit hard once a harvest has made thousands of calls.
 */
const IP_ECHO = 'https://ipv4.icanhazip.com';

/**
 * Build the ProxyAgent URL. Only the exact issued credentials work; we never
 * append country or session suffixes (the gateway 401s on those).
 */
function proxyUrlFromEnv() {
  const credentials = getProxyCredentials();

  if (!credentials) return null;

  return `http://${credentials.user}:${credentials.pass}@${credentials.host}:${credentials.port}`;
}

/**
 * Discover the exit IP of one pinned connection.
 *
 * Retries transient proxy failures. `503 Exit node overloaded` is a normal,
 * frequent response from this gateway and says nothing about the credential,
 * so treating it as a hard failure would discard good sessions.
 */
async function probe(agent, timeoutMs, attempts = 4) {
  let lastError = 'no attempt';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(IP_ECHO, {
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      if (response.statusCode === 200) {
        const ip = (await response.body.text()).trim();

        if (!/^[0-9a-f.:]+$/i.test(ip)) {
          lastError = `unexpected echo response: ${ip.slice(0, 40)}`;
          continue;
        }

        /*
         * Country and city come from the local database rather than the
         * echo service, so probing stays free of third-party rate limits.
         */
        const detail = getGeoDetail(ip);

        return {
          ip,
          country: detail?.country ?? null,
          city: detail?.city ?? null,
          org: null,
        };
      }

      const message = response.headers['proxy-message'] ?? `HTTP ${response.statusCode}`;

      await response.body.dump().catch(() => {});

      lastError = String(message);

      /*
       * 407 means the credential is wrong; retrying cannot help.
       */
      if (response.statusCode === 407) {
        const error = new Error(`Proxy rejected credentials: ${message}`);
        error.fatal = true;
        throw error;
      }
    } catch (error) {
      if (error?.fatal) throw error;

      lastError = String(error?.message ?? error);
    }

    /* Backoff before retrying an overloaded exit node. */
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }

  throw new Error(lastError);
}

/**
 * Open pinned connections in parallel until one exits from `wantCountry`.
 *
 * Probing in parallel matters: a single random connection lands in the US
 * roughly one time in eight, so serial attempts are slow. Parallel batches
 * cut the expected time sharply.
 *
 * @param {object} options
 * @param {string} options.wantCountry  ISO-3166 alpha-2 target. Default 'US'.
 * @param {number} options.maxAttempts  Hard cap on connections opened.
 * @param {number} options.concurrency  Connections opened per batch.
 * @param {number} options.timeoutMs    Per-probe timeout.
 * @param {(msg: string) => void} options.onProgress
 */
export async function openUsSession({
  wantCountry = 'US',
  maxAttempts = 40,
  concurrency = 8,
  timeoutMs = 20_000,
  onProgress = () => {},
} = {}) {
  const proxyUrl = proxyUrlFromEnv();

  if (!proxyUrl) {
    return {
      ok: false,
      error: 'No proxy configured (PROXY_HOST/PORT/USER/PASS missing in .env).',
    };
  }

  const started = Date.now();

  /*
   * Preferred path: the credential itself is already country-pinned.
   *
   * Proxy-Cheap puts routing in the PASSWORD, e.g.
   *   ..._country-US_session-42545257_ttl-10
   * which pins every connection of this session to one US exit, across
   * every target host. When that is configured, a single connection is
   * enough and there is nothing to search for.
   */
  const pinned = /country-[A-Za-z]{2}/.test(getProxyCredentials()?.pass ?? '');

  if (pinned) {
    onProgress('credential is country-pinned — opening one connection');

    const agent = new ProxyAgent({
      uri: proxyUrl,
      connections: 1,
      pipelining: 1,
    });

    try {
      const info = await probe(agent, timeoutMs);

      if (info.country === wantCountry) {
        const detail = getGeoDetail(info.ip);

        onProgress(`exit ${info.ip} (${info.country} ${info.city ?? '-'})`);

        return {
          ok: true,
          dispatcher: agent,
          ip: info.ip,
          country: info.country,
          city: info.city ?? detail?.city ?? null,
          org: info.org ?? null,
          geo: detail,
          pinned: true,
          attempts: 1,
          elapsedMs: Date.now() - started,
          rejected: [],
          close: async () => {
            await agent.close().catch(() => {});
          },
        };
      }

      /*
       * The credential claims a country but the exit is elsewhere. Report it
       * rather than silently continuing — this is exactly the geo-mismatch
       * condition the whole exercise is trying to avoid.
       */
      await agent.close().catch(() => {});

      return {
        ok: false,
        pinned: true,
        error:
          `Credential is pinned to ${wantCountry} but the exit IP ` +
          `${info.ip} is in ${info.country}. The session may have moved; ` +
          'check the session id and TTL in .env.',
        attempts: 1,
        elapsedMs: Date.now() - started,
        rejected: [{ ip: info.ip, country: info.country }],
      };
    } catch (error) {
      await agent.close().catch(() => {});

      return {
        ok: false,
        pinned: true,
        error: `Pinned session failed: ${String(error?.message ?? error)}`,
        attempts: 1,
        elapsedMs: Date.now() - started,
        rejected: [],
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Fallback: random-IP credential. Search for a US exit.                  */
  /* ---------------------------------------------------------------------- */

  onProgress(
      'credential is NOT country-pinned (random IP) — searching connections ' +
      'for a US exit. Configure Country/Session in the Proxy-Cheap dashboard ' +
      'to avoid this.',
  );

  let attempted = 0;
  const rejected = [];
  const live = new Set();

  const openOne = async () => {
    attempted += 1;

    const agent = new ProxyAgent({
      uri: proxyUrl,

      /*
       * connections:1 is the whole trick — one tunnel, reused, therefore one
       * stable exit IP for every request routed through it.
       */
      connections: 1,
      pipelining: 1,
    });

    live.add(agent);

    try {
      const info = await probe(agent, timeoutMs);

      return { agent, info };
    } catch (error) {
      live.delete(agent);
      await agent.close().catch(() => {});

      return { agent: null, info: null, error: String(error?.message ?? error) };
    }
  };

  try {
    while (attempted < maxAttempts) {
      const batchSize = Math.min(concurrency, maxAttempts - attempted);

      const results = await Promise.all(
          Array.from({ length: batchSize }, () => openOne()),
      );

      for (const result of results) {
        if (!result.agent) {
          rejected.push({ ip: null, country: null, error: result.error });
          continue;
        }

        const { agent, info } = result;

        if (info.country === wantCountry) {
          /*
           * Winner. Close every other connection so the account's concurrent
           * connection limit is not held by rejects.
           */
          for (const other of live) {
            if (other !== agent) {
              live.delete(other);
              other.close().catch(() => {});
            }
          }

          live.clear();

          const detail = getGeoDetail(info.ip);

          onProgress(
              `US exit found after ${attempted} attempt(s): ${info.ip} ` +
              `(${info.city ?? detail?.city ?? '-'})`,
          );

          return {
            ok: true,
            dispatcher: agent,
            ip: info.ip,
            country: info.country,
            city: info.city ?? detail?.city ?? null,
            org: info.org ?? null,
            geo: detail,
            attempts: attempted,
            elapsedMs: Date.now() - started,
            rejected,
            close: async () => {
              await agent.close().catch(() => {});
            },
          };
        }

        /* Not the country we want. Drop it. */
        rejected.push({ ip: info.ip, country: info.country });

        live.delete(agent);
        await agent.close().catch(() => {});
      }

      onProgress(
          `no ${wantCountry} exit yet after ${attempted} connection(s) ` +
          `(saw: ${[...new Set(rejected.map((r) => r.country).filter(Boolean))].slice(0, 8).join(', ') || '-'})`,
      );
    }

    return {
      ok: false,
      error:
        `No ${wantCountry} exit IP after ${attempted} connections. ` +
        'Country targeting must be set in the Proxy-Cheap dashboard ' +
        '(Setup Credentials); it cannot be requested at the gateway.',
      attempts: attempted,
      elapsedMs: Date.now() - started,
      rejected,
    };
  } catch (error) {
    for (const agent of live) {
      await agent.close().catch(() => {});
    }

    return {
      ok: false,
      error: String(error?.message ?? error),
      attempts: attempted,
      elapsedMs: Date.now() - started,
      rejected,
    };
  }
}

/**
 * Verify a session still exits from the expected IP.
 *
 * Sessions can change if the upstream exit node drops, so this is worth
 * re-checking periodically during a long run.
 */
export async function verifySession(session) {
  if (!session?.ok) return { ok: false, error: 'No session.' };

  try {
    const info = await probe(session.dispatcher, 20_000);

    return {
      ok: info.ip === session.ip,
      ip: info.ip,
      country: info.country,
      city: info.city,
      changed: info.ip !== session.ip,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Pool-backed sessions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Open one pinned session from a harvested pool entry.
 *
 * The pool stores a session id, and the id maps deterministically to an exit
 * IP, so re-opening it returns the same address. That is what allows a pool
 * larger than the 100-connection plan limit: we only hold a connection while
 * actually using that IP.
 */
export async function openPooledSession(entry, {
  country = 'US',
  ttl = 10,
  timeoutMs = 20_000,
} = {}) {
  const credentials = getProxyCredentials();

  if (!credentials) {
    return { ok: false, error: 'No proxy configured.' };
  }

  const base = String(credentials.pass).split('_country-')[0];
  const password = `${base}_country-${country}_session-${entry.sessionId}_ttl-${ttl}`;

  const agent = new ProxyAgent({
    uri: `http://${credentials.user}:${password}@${credentials.host}:${credentials.port}`,
    connections: 1,
    pipelining: 1,
  });

  try {
    const info = await probe(agent, timeoutMs);

    if (country && info.country !== country) {
      await agent.close().catch(() => {});

      return {
        ok: false,
        error: `expected ${country}, session exits ${info.country}`,
      };
    }

    return {
      ok: true,
      dispatcher: agent,
      ip: info.ip,
      country: info.country,
      city: info.city ?? entry.city ?? null,
      org: info.org ?? entry.org ?? null,
      sessionId: entry.sessionId,
      matchesPool: info.ip === entry.ip,
      close: async () => {
        await agent.close().catch(() => {});
      },
    };
  } catch (error) {
    await agent.close().catch(() => {});

    return { ok: false, error: String(error?.message ?? error) };
  }
}
