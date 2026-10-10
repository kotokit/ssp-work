import { startProxyBridge } from './src/proxy-bridge.mjs';
import { getProxyString, getProxyCredentials } from './src/pr.mjs';
import { chromium } from 'playwright-core';

const c = getProxyCredentials();
const bridge = await startProxyBridge({
  upstream: getProxyString(),
  onLog: (m) => console.log('  [bridge]', m),
});
console.log('bridge listening on', bridge.url);

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  proxy: { server: bridge.url },
});
const page = await browser.newPage();
const r = await page.goto('https://ipv4.icanhazip.com', { timeout: 45000 });
const ip = (await page.content()).replace(/<[^>]*>/g, '').trim();
console.log('  Chrome via bridge -> HTTP', r?.status(), '| exit ip:', ip.slice(0, 20));
console.log('  bridge stats:', JSON.stringify(bridge.stats));
await browser.close();
await bridge.close();
