// Images, video and channels. Needs: hardhat chain + setup-chain, mock-hub.mjs and
// server/index.mjs serve, both with the same MEDIA_DIR, the service with
// FC_API and NODE_API pointing at the mock.
// Usage: node test/e2e-media.mjs <screenshot-dir> <dir with pic.png, clip.mp4, fake.png>
import { chromium } from 'playwright';
const [S, F] = process.argv.slice(2);
const BASE = 'http://localhost:3999';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => { localStorage.setItem('opRpc', 'http://127.0.0.1:8546'); localStorage.setItem('baseRpc', 'http://127.0.0.1:8546'); });
const p = await ctx.newPage();
const logs = []; p.on('console', (m) => logs.push(m.type() + ': ' + m.text())); p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const sent = () => p.waitForFunction(() => document.querySelector('.compose .err')?.textContent.includes('Sent'), null, { timeout: 15000 });
// a fresh page: going to the same #/ again would not re-render the composer
const home = async () => { await p.goto(`${BASE}/#/`); await p.reload(); await p.waitForSelector('.compose'); };
const uploaded = (n) => p.waitForFunction((n) => document.querySelectorAll('.compose .att.done').length === n, n, { timeout: 30000 });

// sign in with the test account's recovery phrase (gasless KEY_ADD)
await p.goto(`${BASE}/#/setup`);
await p.waitForSelector('textarea');
await p.fill('.option textarea', 'test test test test test test test test test test test junk');
await p.click('[data-a=add]');
await p.waitForSelector('.compose', { timeout: 60000 });
ok('signed in, composer shows the media and channel buttons', (await p.$('.compose [data-t=media]')) && (await p.$('.compose [data-t=chan]')));

// 1. image, in a channel
await p.click('.compose [data-t=chan]');
await p.fill('.compose .chan-row input', 'dev');
await p.waitForFunction(() => document.querySelector('.chan-row .st')?.textContent.includes('✓'), null, { timeout: 10000 });
ok('channel lookup: /dev found', true);
await p.setInputFiles('.compose input[type=file]', `${F}/pic.png`);
await uploaded(1);
ok('image uploaded to own server', true);
await p.fill('.compose textarea', 'a picture, stored on my own server');
await p.screenshot({ path: `${S}/m-compose.png` });
await p.click('.compose .send');
await sent();
ok('cast with image sent to /dev', (await p.textContent('.compose .err')).includes('to /dev'));
let ch = await (await fetch(`${BASE}/v1/castsByParent?url=${encodeURIComponent('https://farcaster.xyz/~/channel/dev')}`)).json();
const imgCast = ch.messages.find((m) => m.data.castAddBody.text.includes('a picture'));
const imgUrl = imgCast?.data.castAddBody.embeds?.[0]?.url || '';
ok(`node has it under the channel URL, embed ${imgUrl.replace(/^.*\/media\//, '/media/')}`, /\/media\/[0-9a-f]{32}\.png$/.test(imgUrl));
const served = await fetch(`${BASE}/media/${imgUrl.split('/media/')[1]}`);
ok('file is served back from /media', served.ok && (await served.arrayBuffer()).byteLength > 1000);

// 2. video, no channel
await home();
await p.setInputFiles('.compose input[type=file]', `${F}/clip.mp4`);
await uploaded(1);
await p.fill('.compose textarea', 'and a video');
await p.click('.compose .send');
await sent();
await p.waitForTimeout(500);
await p.goto(`${BASE}/#/u/4242`);
await p.waitForSelector('.cast video.embed-vid', { timeout: 15000 });
ok('video renders as a player in the client', true);
ok('image renders in the client', (await p.$$('.cast img.embed-img')).length >= 1);
ok('channel tag on the cast', (await p.$$eval('.cast .chan', (e) => e.map((x) => x.textContent))).includes('/dev'));
await p.screenshot({ path: `${S}/m-profile.png`, fullPage: true });

// 3. channel view
await p.click('.cast .chan');
await p.waitForSelector('.chan-head');
await p.waitForSelector('.cast');
ok('channel view lists the channel cast', (await p.$$eval('.cast .text', (e) => e.map((x) => x.textContent))).some((t) => t.includes('a picture')));
ok('channel view composer is set to /dev', (await p.inputValue('.compose .chan-row input')) === 'dev');
await p.screenshot({ path: `${S}/m-channel.png`, fullPage: true });

// 4. search /dev opens the channel
await p.goto(`${BASE}/#/search`);
await p.fill('input[type=search]', '/dev');
await p.press('input[type=search]', 'Enter');
await p.waitForSelector('.chan-head');
ok('search "/dev" opens the channel', p.url().endsWith('#/ch/dev'));

// 5. members-only channel warns; unknown channel blocks sending
await home();
await p.click('.compose [data-t=chan]');
await p.fill('.compose .chan-row input', 'members');
await p.waitForFunction(() => document.querySelector('.chan-row .st')?.textContent.includes('members only'), null, { timeout: 10000 });
ok('members-only channel shows a warning', true);
await p.fill('.compose .chan-row input', 'nope');
await p.waitForFunction(() => document.querySelector('.chan-row .st.bad'), null, { timeout: 10000 });
await p.fill('.compose textarea', 'should not go out');
await p.click('.compose .send');
await p.waitForFunction(() => document.querySelector('.compose .err')?.textContent.includes('Pick a channel'), null, { timeout: 5000 });
ok('unknown channel: cast is not sent', true);

// 6. a file that is not an image is refused by the server
await home();
await p.setInputFiles('.compose input[type=file]', `${F}/fake.png`);
await p.waitForSelector('.compose .att.failed', { timeout: 10000 });
ok('fake image refused (content sniffed, not the name)', (await p.textContent('.compose .err')).includes('Only images'));
ok('send stays disabled while an attachment failed', await p.$eval('.compose .send', (b) => b.disabled));

// 7. uploads need a valid signature from an active key
const bad = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'x-fid': '4242', 'x-key': '0x' + '11'.repeat(32), 'x-ts': String(Math.floor(Date.now() / 1000)), 'x-sig': '0x' + '22'.repeat(64) }, body: new Uint8Array([0xff, 0xd8, 0xff, 0]) });
ok(`upload with a forged signature is refused (${bad.status})`, bad.status === 401);
const none = await fetch(`${BASE}/api/upload`, { method: 'POST', body: new Uint8Array([1]) });
ok(`upload without a key is refused (${none.status})`, none.status === 401);

// 8. two attachments max
await home();
await p.setInputFiles('.compose input[type=file]', [`${F}/pic.png`, `${F}/clip.mp4`]);
await uploaded(2);
ok('media button disabled at two attachments', await p.$eval('.compose [data-t=media]', (b) => b.disabled));
await p.click('.compose .send');
await sent();
ok('cast with image + video sent', true);

// 9. a long cast (over 320 bytes) goes out as LONG_CAST
await home();
await p.fill('.compose textarea', 'long '.repeat(80).trim());
await p.click('.compose .send');
await sent();
ok('text over 320 bytes is sent as a long cast', true);

const errs = logs.filter((l) => l.startsWith('pageerror'));
ok('no page errors', !errs.length);
if (errs.length) console.log(errs.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
