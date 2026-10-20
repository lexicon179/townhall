// townhall sign-in service.
//
// Lets people connect their Farcaster account by approving townhall in the Farcaster app
// (a "signed key request"), so nobody ever types a recovery phrase into a website.
//
//   1. The browser makes a fresh app key. The private half never leaves the browser.
//   2. This service signs "fid <APP_FID> requests this key" with the app account's key
//      (EIP-712, the same message the onchain SignedKeyRequestValidator checks) and asks
//      the Farcaster client API for an approval link.
//   3. The person opens the link (QR on desktop, tap on phone) and approves in the app.
//      The app adds the key to their account onchain. Their node sees it, and they can post.
//
// The app account is a separate FID that only exists to sign these requests. Its key lives
// on this server (APP_FILE, mode 600) and holds no one else's funds or accounts.
//
//   node index.mjs init       make the app key (once) and print its address
//   node index.mjs register   register an FID for it (needs a little ETH on Optimism)
//   node index.mjs import     or use an account you already have: reads its recovery
//                             phrase from stdin and keeps only the derived key
//   node index.mjs serve      HTTP on 127.0.0.1:3390 (/api/*, /c/*), proxied by Caddy
//
// /c/<fid>/<hash> serves the client with link-preview tags for that cast, so a shared
// cast shows its author and text in Farcaster, Telegram and the like.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createPublicClient, createWalletClient, http as vhttp, formatEther, isHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';
import { optimism } from 'viem/chains';
import {
  ID_GATEWAY_ADDRESS, idGatewayABI, ID_REGISTRY_ADDRESS, idRegistryABI,
  SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN, SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES,
} from '@farcaster/core';

const APP_FILE = process.env.APP_FILE || '/data/app.json';
const FC_API = (process.env.FC_API || 'https://api.farcaster.xyz').replace(/\/$/, '');
const OP_RPC = process.env.OP_RPC || 'https://mainnet.optimism.io';
const PORT = Number(process.env.PORT || 3390);
const DEFAULT_FID = Number(process.env.DEFAULT_FID || 0); // whose follows make the signed-out feed
const NODE_API = (process.env.NODE_API || 'http://127.0.0.1:3381').replace(/\/$/, '');
const WWW = process.env.WWW_DIR || '/www';

const load = () => (existsSync(APP_FILE) ? JSON.parse(readFileSync(APP_FILE, 'utf8')) : null);
const save = (o) => { writeFileSync(APP_FILE, JSON.stringify(o, null, 2)); chmodSync(APP_FILE, 0o600); };
const chain = process.env.OP_CHAIN_LOCAL ? { ...optimism, rpcUrls: { default: { http: [OP_RPC] } } } : optimism;
const op = () => createPublicClient({ chain, transport: vhttp(OP_RPC) });

async function fidOf(address) {
  return Number(await op().readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [address] }));
}

const cmd = process.argv[2] || 'serve';

if (cmd === 'init') {
  let a = load();
  if (!a) { a = { privateKey: generatePrivateKey() }; save(a); console.log('Created a new app key.'); }
  const acct = privateKeyToAccount(a.privateKey);
  const fid = a.fid || (await fidOf(acct.address));
  const bal = await op().getBalance({ address: acct.address });
  const price = await op().readContract({ address: ID_GATEWAY_ADDRESS, abi: idGatewayABI, functionName: 'price' });
  console.log(JSON.stringify({ address: acct.address, fid: fid || null, balanceEth: formatEther(bal), registerPriceEth: formatEther(price) }));
  process.exit(0);
}

if (cmd === 'import') {
  let raw = ''; for await (const c of process.stdin) raw += c;
  const phrase = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  raw = '';
  let acct;
  try { acct = mnemonicToAccount(phrase); } catch { console.error('That is not a valid recovery phrase (12 or 24 words).'); process.exit(2); }
  const fid = await fidOf(acct.address);
  if (!fid) { console.error(`No Farcaster account at ${acct.address}. Check the phrase (it must be the account's recovery phrase).`); process.exit(2); }
  const old = load();
  if (old?.fid && old.fid !== fid && process.env.FORCE !== '1') { console.error(`This server already signs as fid ${old.fid}. Set FORCE=1 to replace it.`); process.exit(2); }
  save({ privateKey: bytesToHex(acct.getHdKey().privateKey), fid });
  console.log(JSON.stringify({ address: acct.address, fid }));
  process.exit(0);
}

if (cmd === 'register') {
  const a = load();
  if (!a) throw new Error('Run init first.');
  const acct = privateKeyToAccount(a.privateKey);
  let fid = await fidOf(acct.address);
  if (!fid) {
    const price = await op().readContract({ address: ID_GATEWAY_ADDRESS, abi: idGatewayABI, functionName: 'price' });
    const bal = await op().getBalance({ address: acct.address });
    if (bal <= price) { console.error(`Need more than ${formatEther(price)} ETH on Optimism at ${acct.address} (has ${formatEther(bal)}).`); process.exit(2); }
    const w = createWalletClient({ account: acct, chain, transport: vhttp(OP_RPC) });
    const tx = await w.writeContract({ address: ID_GATEWAY_ADDRESS, abi: idGatewayABI, functionName: 'register', args: [acct.address], value: price });
    const r = await op().waitForTransactionReceipt({ hash: tx });
    if (r.status !== 'success') throw new Error(`register failed: ${tx}`);
    fid = await fidOf(acct.address);
    console.log(`Registered fid ${fid}: https://optimistic.etherscan.io/tx/${tx}`);
  }
  save({ ...a, fid });
  console.log(JSON.stringify({ address: acct.address, fid }));
  process.exit(0);
}

// ---------- serve ----------

const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
const hits = new Map(); // ip -> [count, windowStart]; a light brake on request spam
const limited = (ip) => { const n = Date.now(), h = hits.get(ip) || [0, n]; if (n - h[1] > 60_000) { h[0] = 0; h[1] = n; } h[0]++; hits.set(ip, h); return h[0] > 30; };

async function startRequest(keyHex) {
  const a = load();
  if (!a?.fid) throw Object.assign(new Error('Sign-in is not set up on this server.'), { code: 503 });
  const acct = privateKeyToAccount(a.privateKey);
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const signature = await acct.signTypedData({
    domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
    types: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES.types,
    primaryType: 'SignedKeyRequest',
    message: { requestFid: BigInt(a.fid), key: keyHex, deadline: BigInt(deadline) },
  });
  const r = await fetch(`${FC_API}/v2/signed-key-requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyHex, requestFid: a.fid, signature, deadline }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.errors?.[0]?.message || `Farcaster API ${r.status}`), { code: 502 });
  const s = body.result.signedKeyRequest;
  return { token: s.token, deeplinkUrl: s.deeplinkUrl, state: s.state };
}

async function pollRequest(token) {
  const r = await fetch(`${FC_API}/v2/signed-key-request?token=${encodeURIComponent(token)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.errors?.[0]?.message || `Farcaster API ${r.status}`), { code: 502 });
  const s = body.result.signedKeyRequest;
  return { state: s.state, userFid: s.userFid ?? null };
}

// ---------- link previews for shared casts ----------

const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function nodeGet(path) {
  const r = await fetch(`${NODE_API}/v1/${path}`, { signal: AbortSignal.timeout(4000) });
  return r.ok ? r.json() : null;
}

async function castPage(fid, hash, origin) {
  const page = readFileSync(`${WWW}/index.html`, 'utf8');
  const [c, u] = await Promise.all([nodeGet(`castById?fid=${fid}&hash=${hash}`), nodeGet(`userDataByFid?fid=${fid}`)]).catch(() => [null, null]);
  if (!c?.data?.castAddBody) return page;
  const p = {};
  for (const m of u?.messages ?? []) {
    const b = m.data?.userDataBody; if (!b) continue;
    if (b.type === 'USER_DATA_TYPE_USERNAME') p.username = b.value;
    if (b.type === 'USER_DATA_TYPE_DISPLAY') p.display = b.value;
    if (b.type === 'USER_DATA_TYPE_PFP') p.pfp = b.value;
  }
  const body = c.data.castAddBody;
  const img = (body.embeds ?? []).find((e) => e.url && /\.(png|jpe?g|gif|webp)(\?|$)|imagedelivery\.net/i.test(e.url))?.url;
  const title = `${p.display || p.username || `fid ${fid}`}${p.username ? ` (@${p.username})` : ''}`;
  const text = (body.text || '').replace(/\s+/g, ' ').trim();
  const desc = text.length > 200 ? text.slice(0, 199) + '…' : text;
  const tags = [
    ['og:type', 'article'], ['og:site_name', 'townhall'], ['og:title', title], ['og:description', desc],
    ['og:url', `${origin}/c/${fid}/${hash}`], ['og:image', img || p.pfp || `${origin}/icon-512.png`],
  ].map(([k, v]) => `<meta property="${k}" content="${escHtml(v)}">`).join('\n  ')
    + `\n  <meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">\n  <meta name="description" content="${escHtml(desc)}">`;
  return page.replace('<title>townhall</title>', `<title>${escHtml(title)} on townhall</title>\n  ${tags}`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    const cm = url.pathname.match(/^\/c\/(\d{1,10})\/(0x[0-9a-fA-F]{40})\/?$/);
    if (cm) {
      const origin = `https://${String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()}`;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=300');
      return res.end(await castPage(Number(cm[1]), cm[2].toLowerCase(), origin));
    }
    if (url.pathname === '/api/config') {
      const a = load();
      return json(res, 200, { signin: !!a?.fid, appFid: a?.fid ?? null, defaultFid: DEFAULT_FID || null, castLinks: existsSync(`${WWW}/index.html`) });
    }
    if (url.pathname === '/api/signin' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'Too many requests. Try again in a minute.' });
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1000) break; }
      const key = JSON.parse(raw || '{}').key;
      if (!isHex(key) || key.length !== 66) return json(res, 400, { error: 'key must be a 32-byte hex Ed25519 public key' });
      return json(res, 200, await startRequest(key));
    }
    if (url.pathname === '/api/signin' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (!/^[\w-]{4,200}$/.test(token)) return json(res, 400, { error: 'bad token' });
      return json(res, 200, await pollRequest(token));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.code || 500, { error: e.message });
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`townhall sign-in service on :${PORT}`));
