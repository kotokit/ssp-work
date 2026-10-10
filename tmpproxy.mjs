import { chromium } from 'playwright-core';
import { getProxyCredentials } from './src/pr.mjs';
const c = getProxyCredentials();

for (const [label, proxy] of [
  ['user/pass fields', { server: `http://${c.host}:${c.port}`, username: c.user, password: c.pass }],
  ['creds in server URL', { server: `http://${c.user}:${c.pass}@${c.host}:${c.port}` }],
]) {
  try {
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, proxy });
    const page = await browser.newPage();
    const r = await page.goto('https://ipv4.icanhazip.com', { timeout: 40000 });
    const ip = (await page.content()).replace(/<[^>]*>/g, '').trim();
    console.log(`  ${label.padEnd(22)} status=${r?.status()} ip=${ip.slice(0, 20)}`);
    await browser.close();
  } catch (e) {
    console.log(`  ${label.padEnd(22)} ERROR ${String(e.message).slice(0, 70)}`);
  }
}
