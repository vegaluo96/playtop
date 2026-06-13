import { chromium } from 'playwright-core';
import chromiumPkg from '@sparticuz/chromium';
const exe = await chromiumPkg.executablePath();
const browser = await chromium.launch({ executablePath: exe, args: chromiumPkg.args, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
await ctx.addCookies([{ name: 'pt_sess', value: 'qatok901', domain: 'localhost', path: '/' }]);
const B = 'http://localhost:9710';
const page = await ctx.newPage();
// dismiss cookie banner once
await page.goto(B + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.getByText('同意', { exact: true }).first().click({ timeout: 3000 }).catch(()=>{});
await page.waitForTimeout(300);
async function shot(name, path, prep) {
  await page.goto(B + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (prep) await prep(page).catch(()=>{});
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/vp-${name}.png` }); // viewport only
  console.log('shot', name);
}
const tap = (t) => async (p) => { await p.getByText(t, { exact: true }).first().click({ timeout: 3500 }); await p.waitForTimeout(600); };
await shot('home', '/');
await shot('moves', '/moves');
await shot('predictions', '/predictions');
await shot('data', '/data');
await shot('me', '/me');
await shot('detail-top', '/match/9504');
await shot('report', '/report/9504');
await shot('login', '/login');
await browser.close();
console.log('DONE');
