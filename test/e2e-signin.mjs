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
await p.waitForSelector('[data-a=go]');
ok('no recovery phrase field shown by default', !(await p.isVisible('textarea')));
await p.screenshot({ path: `${S}/si-setup.png` });
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(logs.slice(-15).join('\n'));
await b.close();
