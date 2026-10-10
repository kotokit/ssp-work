#!/usr/bin/env node
/**
 * Proxy preflight check.
 *
 * Answers three questions with evidence rather than assumption:
 *
 *   1. Is the proxy actually in the request path? (Not bypassed.)
 *   2. Does it exit where we think it does?
 *   3. Does it rotate, and does it hold a session?
 *
 * Run:
 *   node --use-env-proxy src/proxy-check.mjs          # required flag!
 *   node --use-env-proxy src/proxy-check.mjs --samples 5
 *
 * Exits non-zero if the proxy is configured but not in effect, which is the
 * dangerous case: traffic leaves from the operator's own IP while appearing
 * to be proxied.
 */

import {
  getProxyCredentials,
  verifyProxy,
  proxyIsActive,
  proxyProblem,
} from './pr.mjs';

const HELP = `
Proxy preflight.

Options:
  --samples N   Number of requests used for the rotation/session test. Default: 5
  --help

Node reads HTTP_PROXY/HTTPS_PROXY once at startup, so they must be exported
in the shell BEFORE node launches. Assigning them inside the process (or via
process.loadEnvFile) has no effect. Run it like this:

  eval "$(node src/pr.mjs --export)"
  node --use-env-proxy src/proxy-check.mjs --samples 5

./run.sh does both of these already.
`;

function parseArgs(argv) {
  let samples = 5;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help') return { help: true };
    if (token === '--samples') {
      samples = Number(argv[i + 1]);
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  if (!Number.isSafeInteger(samples) || samples <= 0 || samples > 50) {
    throw new Error('--samples must be an integer between 1 and 50.');
  }

  return { samples };
}

const dim = (t) => `\u001b[2m${t}\u001b[0m`;
const green = (t) => `\u001b[32m${t}\u001b[0m`;
const red = (t) => `\u001b[31m${t}\u001b[0m`;
const yellow = (t) => `\u001b[33m${t}\u001b[0m`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const credentials = getProxyCredentials();

  console.log('proxy configuration');  console.log(dim('─'.repeat(64)));

  if (!credentials) {
    console.log(red('  No proxy configured.'));
    console.log('  Set PROXY_HOST / PROXY_PORT / PROXY_USER / PROXY_PASS in .env');
    return 1;
  }

  console.log(`  gateway     ${credentials.host}:${credentials.port}`);
  console.log(`  username    ${credentials.user}`);
  console.log(`  password    ${'*'.repeat(credentials.pass.length)}`);
  console.log(
      `  in effect   ${
          proxyIsActive()
              ? green('yes (--use-env-proxy)')
              : red('NO — fetch() will go direct')
      }`,
  );

  console.log('\npreflight');
  console.log(dim('─'.repeat(64)));

  const result = await verifyProxy();

  if (!result.ok) {
    console.log(red(`  FAILED: ${result.error}`));

    if (proxyProblem()) {
      console.log(
          yellow('\n  Correct invocation:\n') +
          '    eval "$(node src/pr.mjs --export)"\n' +
          '    node --use-env-proxy src/proxy-check.mjs\n' +
          dim('\n  (./run.sh already does this for the load-testing server.)'),
      );
    }

    return 1;
  }

  console.log(green('  OK — the proxy is in the request path.'));
  console.log(`  exit ip     ${result.ip}`);
  console.log(`  country     ${result.country}`);
  console.log(`  city        ${result.city}`);
  console.log(`  org         ${result.org}`);

  /* ---------------------------------------------------------------------- */
  /* Rotation / session behaviour                                           */
  /* ---------------------------------------------------------------------- */

  console.log(`\nrotation test (${args.samples} requests)`);
  console.log(dim('─'.repeat(64)));

  const seen = [];

  for (let i = 0; i < args.samples; i += 1) {
    const sample = await verifyProxy({ timeoutMs: 25_000 });

    if (!sample.ok) {
      console.log(`  ${i + 1}. ${red('failed')} — ${sample.error}`);
      continue;
    }

    seen.push(sample);

    console.log(
        `  ${String(i + 1).padStart(2)}. ${String(sample.ip).padEnd(16)} ` +
        `${String(sample.country).padEnd(3)} ${sample.city ?? ''}`,
    );
  }

  const distinct = new Set(seen.map((s) => s.ip));
  const countries = [...new Set(seen.map((s) => s.country))];

  console.log('');
  console.log(`  distinct exit IPs : ${distinct.size}/${seen.length}`);
  console.log(`  countries seen    : ${countries.join(', ') || '-'}`);

  if (countries.length === 1 && countries[0] !== (credentials.country ?? 'US')) {
    console.log(
        yellow(
            `  NOTE: PROXY_COUNTRY=${credentials.country ?? '(unset)'} but the exit ` +
            `country is ${countries[0]}.`,
        ),
    );
  }

  if (distinct.size === 1 && seen.length > 1) {
    console.log(
        yellow(
            '  NOTE: the same exit IP for every request — this is a sticky/single ' +
            'session, not a rotating pool.',
        ),
    );
  } else if (distinct.size > 1) {
    console.log(
        yellow(
            '  NOTE: the exit IP changes per request. For an auction + impression ' +
            'pair this matters: the pixel then fires from a different IP than the bid. ' +
            'Hold one session for the pair, or route the pixel through the same session.',
        ),
    );
  }

  return 0;
}

main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exitCode = 1;
    });
