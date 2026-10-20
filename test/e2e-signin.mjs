// Hosted mode: signed-out feed, then "Sign in with Farcaster" (signed key request), then post.
// Needs: hardhat chain + setup-chain, server/index.mjs serve (FC_API=mock), mock-hub.mjs.
import { chromium } from 'playwright';
const S = process.argv[2];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
await ctx.addInitScript(() => { localStorage.setItem('baseRpc', 'http://127.0.0.1:8546'); });
const p = await ctx.newPage();
const logs = []; p.on('console', (m) => logs.push(m.type() + ': ' + m.text())); p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

await p.goto('http://localhost:3999/');
await p.waitForSelector('.guest', { timeout: 15000 });
await p.waitForSelector('.cast', { timeout: 15000 });
ok('signed out: town square feed opens with no login', (await p.$$eval('.cast .text', (e) => e.map((x) => x.textContent))).includes('options > perps'));
await p.screenshot({ path: `${S}/si-guest.png` });

await p.click('.guest .btn');
await p.waitForSelector('.choice .pick');
ok('sign-in offers a choice: the Farcaster app or your own keys', (await p.$$('.choice .pick')).length === 2);
ok('no recovery phrase field shown by default', !(await p.isVisible('textarea')));
await p.screenshot({ path: `${S}/si-setup.png` });
await p.click('[data-choice=keys]');
ok('own keys shows the recovery phrase form', await p.isVisible('textarea'));
await p.click('[data-choice=app]');
await p.waitForSelector('[data-a=go]');
await p.click('[data-a=go]');
await p.waitForSelector('.qrbox svg', { timeout: 10000 });
ok('desktop shows a QR code for the Farcaster app', true);
await p.screenshot({ path: `${S}/si-qr.png` });

const ap = await (await fetch('http://localhost:3999/test/approve')).json();
ok(`request signed by the app account (${ap.signer})`, ap.ok && /^0x/.test(ap.signer));
await p.waitForSelector('.compose', { timeout: 30000 });
ok('approved -> signed in, composer open', true);
ok('key stored in the browser for fid 4242', await p.evaluate(() => JSON.parse(localStorage.getItem('appKey')).fid === 4242));

await p.fill('.compose textarea', 'first cast after signing in with the Farcaster app');
await p.click('.compose .btn.primary');
await p.waitForFunction(() => document.querySelector('.compose .err')?.textContent.includes('Sent'), null, { timeout: 15000 });
ok('cast accepted by the node with the approved key', true);
await p.screenshot({ path: `${S}/si-feed.png` });

// shared cast links: /c/<fid>/<hash> with a link preview, opening the thread
const ctxShare = await b.newContext({ viewport: { width: 420, height: 900 } });
await ctxShare.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:3999' });
const sp = await ctxShare.newPage();
await sp.goto('http://localhost:3999/');
await sp.waitForSelector('.cast [data-a=share]', { timeout: 15000 });
const first = sp.locator('.cast:not(.nested)').first();
const firstText = await first.locator('.text').first().textContent();
await first.locator('[data-a=share]').click();
await sp.waitForTimeout(300);
const link = await sp.evaluate(() => navigator.clipboard.readText());
ok(`share gives a /c/ link (${link.replace('http://localhost:3999', '')})`, /\/c\/\d+\/0x[0-9a-f]{40}$/.test(link));
const html = await (await fetch(link)).text();
ok('the link has a preview: og:title and the cast text', html.includes('og:title') && html.includes(`og:description" content="${firstText.trim().slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`) && html.includes('og:url" content="https://localhost:3999/c/'));
await sp.goto(link);
await sp.waitForSelector('.cast', { timeout: 15000 });
ok('opening the link shows that cast', sp.url().includes('#/c/') && (await sp.locator('.cast').first().locator('.text').first().textContent()) === firstText);
await ctxShare.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(logs.slice(-15).join('\n'));
await b.close();
