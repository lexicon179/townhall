// End-to-end browser test against test/mock-hub.mjs. Usage: node test/e2e.mjs <screenshot-dir>  (needs playwright)
import { chromium } from 'playwright';
const S = process.argv[2];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:3999' });
await ctx.addInitScript(() => { localStorage.setItem('opRpc', 'http://127.0.0.1:8546'); localStorage.setItem('baseRpc', 'http://127.0.0.1:8546'); });
const p = await ctx.newPage();
const logs = []; p.on('console', (m) => logs.push(m.type() + ': ' + m.text())); p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
p.on('dialog', async (d) => { console.log('DIALOG:', d.message()); await d.dismiss(); });
const step = (s) => console.log('·', s);
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

await p.goto('http://localhost:3999/#/setup');
await p.waitForSelector('textarea');
await p.screenshot({ path: `${S}/sc-setup.png`, fullPage: true });
await p.fill('.option textarea', 'test test test test test test test test test test test junk');
await p.click('[data-a=check]');
await p.waitForFunction(() => document.querySelector('.kv')?.textContent.includes('4242'), null, { timeout: 15000 });
ok('seed phrase -> custody + FID 4242 (@mike)', (await p.textContent('.kv')).includes('@mike'));
await p.click('[data-a=add]');
step('adding app key with a gasless KEY_ADD message');
await p.waitForSelector('.compose', { timeout: 60000 });
ok('app key added, node sees it, feed opens', true);
{ const sg = await (await fetch('http://localhost:3999/v1/signersByFid?fid=4242')).json();
  const pub = await p.evaluate(() => JSON.parse(localStorage.getItem('appKey')).pub);
  const mine = sg.signers.find((x) => x.key === pub);
  ok(`key is gasless (KEY_ADD, no transaction), nonce ${sg.currentUserNonce}, scopes ${mine?.scopes?.length}`, mine?.source === 'SIGNER_SOURCE_OFFCHAIN' && sg.currentUserNonce === 1); }
ok('seed phrase cleared from the page', !(await p.evaluate(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('junk')))));
ok('only the app key is stored', await p.evaluate(() => { const k = JSON.parse(localStorage.getItem('appKey')); return k.fid === 4242 && k.key.length === 66 && !JSON.stringify(localStorage).includes('junk'); }));

await p.fill('.compose textarea', 'hello from my own node, cc @alice https://example.com');
await p.click('.compose .btn.primary');
await p.waitForFunction(() => document.querySelector('.compose .err')?.textContent.includes('Sent. Your node relayed it'), null, { timeout: 15000 });
ok('cast accepted by the node (real signature + active signer checks)', true);

await p.goto('http://localhost:3999/#/u/100');
await p.waitForSelector('.follow .btn');
await p.click('.follow .btn');
await p.waitForFunction(() => document.querySelector('.follow .btn')?.textContent === 'Following');
ok('follow @alice (LINK_ADD)', true);

await p.goto('http://localhost:3999/#/');
await p.waitForSelector('.cast', { timeout: 20000 });
await p.waitForTimeout(800);
const texts = await p.$$eval('.cast .text', (els) => els.map((e) => e.textContent));
ok('feed shows own cast with mention rendered back', texts.some((t) => t.includes('cc @alice')));
ok('feed shows followed user casts', texts.some((t) => t.includes('gm from the main app')));
const vias = await p.$$eval('.via', (els) => els.map((e) => e.textContent));
ok(`client attribution per cast (${[...new Set(vias)].join(', ')})`, vias.includes('via farcaster') && vias.includes('via own key'));

// like alice's cast
const aliceCast = p.locator('.cast', { hasText: 'gm from the main app' });
await aliceCast.locator('[data-a=like]').click();
await p.waitForTimeout(600);
ok('like (REACTION_ADD)', await aliceCast.locator('[data-a=like].on').count() === 1);
// reply
await aliceCast.locator('[data-a=reply]').click();
await aliceCast.locator('textarea').fill('replying from townhall');
await aliceCast.locator('.btn.primary').click();
await p.waitForTimeout(800);
const href = await aliceCast.locator('a.time').getAttribute('href');
await p.goto('http://localhost:3999/' + href);
await p.waitForSelector('.cast');
await p.waitForTimeout(600);
ok('thread view shows the reply', (await p.$$eval('.cast .text', (e) => e.map((x) => x.textContent))).includes('replying from townhall'));

// share and quote, from the thread view
const root = p.locator('.cast').first();
await root.locator('[data-a=share]').click();
await p.waitForTimeout(300);
const copied = await p.evaluate(() => navigator.clipboard.readText());
ok(`share copies a link to the cast on this client (${copied.replace('http://localhost:3999', '')})`, copied === 'http://localhost:3999/' + href);
await root.locator('[data-a=quote]').click();
await root.locator('textarea').fill('quoting this from townhall');
await root.locator('.btn.primary', { hasText: 'Quote' }).click();
await p.waitForTimeout(800);
await p.goto('http://localhost:3999/#/');
await p.waitForSelector('.quoted', { timeout: 20000 });
const q = p.locator('.cast:not(.nested)', { hasText: 'quoting this from townhall' });
ok('quote cast shows the quoted cast inside it', (await q.locator('.quoted').textContent()).includes('gm from the main app'));
await p.screenshot({ path: `${S}/sc-quote.png`, fullPage: true });

// filter by client
await p.goto('http://localhost:3999/#/');
await p.waitForSelector('.chips .chip', { timeout: 20000 });
await p.screenshot({ path: `${S}/sc-feed.png`, fullPage: true });
await p.locator('.chip', { hasText: 'farcaster' }).click();
const visible = await p.$$eval('.cast:not(.nested)', (els) => els.filter((e) => e.style.display !== 'none').map((e) => e.querySelector('.via')?.textContent));
ok(`hiding a client removes its casts (${visible.join(', ')})`, visible.length > 0 && visible.every((v) => v !== 'via farcaster'));
await p.screenshot({ path: `${S}/sc-filtered.png`, fullPage: true });

// voters filter: nobody holds a VOTE NFT on the test chain, so "Voters only" hides everything
await p.locator('.chip', { hasText: 'farcaster' }).click(); // show the app again
await p.locator('.chip.voters').click();
ok('voters-only hides non-voters', await p.$$eval('.cast:not(.nested)', (els) => els.every((e) => e.style.display === 'none')));
await p.locator('.chip.voters').click();

// replies: mutuals only by default
await fetch('http://localhost:3999/test/replies');
await p.goto('http://localhost:3999/#/n');
await p.waitForFunction(() => !document.querySelector('.center') || document.querySelectorAll('.cast').length, null, { timeout: 20000 });
await p.waitForTimeout(600);
let rt = await p.$$eval('.cast .text', (e) => e.map((x) => x.textContent));
ok(`replies from mutuals only (${rt.join(' | ')})`, rt.includes('welcome to the townhall') && !rt.includes('who dis'));
await p.screenshot({ path: `${S}/sc-replies.png`, fullPage: true });
await p.locator('[data-v="1"]').click();
await p.waitForFunction(() => document.querySelectorAll('.cast').length >= 2, null, { timeout: 20000 });
rt = await p.$$eval('.cast .text', (e) => e.map((x) => x.textContent));
ok('replies from everyone', rt.includes('who dis'));

// search by username, and by a #/u/<name> link
await p.goto('http://localhost:3999/#/search');
await p.fill('input[type=search]', '@Alice');
await p.press('input[type=search]', 'Enter');
await p.waitForFunction(() => location.hash === '#/u/100', null, { timeout: 10000 });
ok('search by username opens the profile', true);
await p.goto('http://localhost:3999/#/u/bob');
await p.waitForSelector('.profile', { timeout: 10000 });
ok('#/u/<username> link opens the profile', (await p.textContent('.profile')).includes('bob'));
await p.goto('http://localhost:3999/#/u/100');
await p.waitForFunction(() => /\d+ follower/.test(document.querySelector('.profile .stats')?.textContent || ''), null, { timeout: 10000 });
{ const st = await p.textContent('.profile .stats'); ok(`profile counts from the node (${st.replace(/\s+/g, ' ').trim()})`, /1 follower(?!s)/.test(st) && /Follows you/.test(st)); }
await p.locator('.cast [data-a=inspect]').first().click();
await p.waitForSelector('.inspect-panel');
ok('inspect shows hash, signer and signing app', /BLAKE3/.test(await p.textContent('.inspect-panel')) && /Signed by app/.test(await p.textContent('.inspect-panel')));
await p.goto('http://localhost:3999/#/search/nobody-here');
await p.waitForFunction(() => document.querySelector('.err')?.textContent.includes('No account'), null, { timeout: 10000 });
ok('unknown username says so', true);

// live view: the network's event log, as the node receives it
await p.goto('http://localhost:3999/#/live');
await p.waitForSelector('.stream .ev', { timeout: 15000 });
ok(`live view lists network messages (${await p.locator('.stream .ev').count()})`, await p.locator('.stream .ev').count() > 3);
ok('live view shows block heights and stored messages', /\d/.test(await p.textContent('[data-k=s1]')) && /\d/.test(await p.textContent('[data-k=msgs]')));
await fetch('http://localhost:3999/test/live-cast');
await p.waitForFunction(() => [...document.querySelectorAll('.stream .txt')].some((e) => e.textContent.includes('hello from the live network')), null, { timeout: 15000 });
ok('a new cast appears live without reloading', true);
await p.screenshot({ path: `${S}/sc-live.png`, fullPage: true });

// revoke the key on the network (self-signed KEY_REMOVE)
await p.goto('http://localhost:3999/#/settings');
const pubBefore = await p.evaluate(() => JSON.parse(localStorage.getItem('appKey')).pub);
await p.click('[data-a=revoke]');
await p.waitForFunction(() => !localStorage.getItem('appKey'), null, { timeout: 15000 });
{ const sg = await (await fetch('http://localhost:3999/v1/signersByFid?fid=4242')).json();
  ok('revoke: KEY_REMOVE signed by the key itself, node drops it', !sg.signers.some((x) => x.key === pubBefore)); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(logs.slice(-15).join('\n'));
await b.close();
