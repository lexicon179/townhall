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
//   node index.mjs serve      HTTP on 127.0.0.1:3390 (/api/*), proxied by Caddy
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createPublicClient, createWalletClient, http as vhttp, formatEther, isHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (url.pathname === '/api/config') {
      const a = load();
      return json(res, 200, { signin: !!a?.fid, appFid: a?.fid ?? null, defaultFid: DEFAULT_FID || null });
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
