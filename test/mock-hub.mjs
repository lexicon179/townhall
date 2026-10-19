// A small stand-in for a Snapchain read node, for testing the client without a 2 TB sync.
// Implements the HTTP endpoints the client uses, validates submitted messages for real
// (hash, Ed25519 signature, active signer), and reads app keys from KeyGateway events on a
// local chainId-10 chain, verifying the SignedKeyRequest EIP-712 signature like the
// onchain validator does. Also serves the built client (../client/dist).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  Message, validations, messageTypeToJSON, reactionTypeToJSON, farcasterNetworkToJSON, MessageType,
  makeCastAdd, makeUserDataAdd, makeLinkAdd, NobleEd25519Signer, FarcasterNetwork, UserDataType, bytesToHexString,
  KEY_GATEWAY_ADDRESS, ID_REGISTRY_ADDRESS, idRegistryABI,
  SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN, SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES,
  GASLESS_KEY_ADD_EIP_712_TYPES, GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES, decodeGaslessSignedKeyRequestMetadata,
} from '@farcaster/core';
import { recoverTypedDataAddress } from 'viem';
import { createPublicClient, http as vhttp, decodeAbiParameters, verifyTypedData, parseAbiItem } from 'viem';

const PORT = Number(process.env.PORT || 3999);
const RPC = process.env.OP_RPC || 'http://127.0.0.1:8546';
const DIST = new URL('../client/dist/', import.meta.url).pathname;
const chain = { id: 10, name: 'op-local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const op = createPublicClient({ chain, transport: vhttp(RPC) });

const hex = (b) => bytesToHexString(b)._unsafeUnwrap();
const msgs = []; // all merged messages
const signers = new Map(); // fid -> Map(keyHex -> requestFid)
const names = new Map(); // fname -> fid

// ---------- JSON shape of Snapchain's HTTP API ----------
function toJson(m) {
  const d = m.data;
  const out = { type: messageTypeToJSON(d.type), fid: d.fid, timestamp: d.timestamp, network: farcasterNetworkToJSON(d.network) };
  if (d.castAddBody) {
    const b = d.castAddBody;
    out.castAddBody = {
      embedsDeprecated: [], mentions: b.mentions, mentionsPositions: b.mentionsPositions, text: b.text,
      embeds: b.embeds.map((e) => (e.url ? { url: e.url } : { castId: { fid: e.castId.fid, hash: hex(e.castId.hash) } })),
      ...(b.parentCastId ? { parentCastId: { fid: b.parentCastId.fid, hash: hex(b.parentCastId.hash) } } : {}),
      ...(b.parentUrl ? { parentUrl: b.parentUrl } : {}),
    };
  }
  if (d.reactionBody) out.reactionBody = { type: reactionTypeToJSON(d.reactionBody.type), targetCastId: { fid: d.reactionBody.targetCastId.fid, hash: hex(d.reactionBody.targetCastId.hash) } };
  if (d.linkBody) out.linkBody = { type: d.linkBody.type, targetFid: d.linkBody.targetFid };
  if (d.userDataBody) out.userDataBody = { type: { 1: 'USER_DATA_TYPE_PFP', 2: 'USER_DATA_TYPE_DISPLAY', 3: 'USER_DATA_TYPE_BIO', 6: 'USER_DATA_TYPE_USERNAME' }[d.userDataBody.type], value: d.userDataBody.value };
  return { data: out, hash: hex(m.hash), hashScheme: 'HASH_SCHEME_BLAKE3', signature: Buffer.from(m.signature).toString('base64'), signatureScheme: 'SIGNATURE_SCHEME_ED25519', signer: hex(m.signer) };
}

// ---------- signers from the chain ----------
async function syncKeys() {
  const logs = await op.getLogs({ address: KEY_GATEWAY_ADDRESS, event: parseAbiItem('event Add(address indexed custody, uint32 keyType, bytes key, uint8 metadataType, bytes metadata)'), fromBlock: 0n });
  for (const l of logs) {
    const { custody, key, metadata } = l.args;
    const fid = Number(await op.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [custody] }));
    if (!fid) continue;
    const [md] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'requestFid', type: 'uint256' }, { name: 'requestSigner', type: 'address' }, { name: 'signature', type: 'bytes' }, { name: 'deadline', type: 'uint256' }] }], metadata);
    const ok = await verifyTypedData({
      address: md.requestSigner, domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN, types: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES.types,
      primaryType: 'SignedKeyRequest', message: { requestFid: md.requestFid, key, deadline: md.deadline }, signature: md.signature,
    });
    const reqCustodyFid = Number(await op.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [md.requestSigner] }));
    if (!ok || reqCustodyFid !== Number(md.requestFid)) { console.log('rejected key add: bad SignedKeyRequest'); continue; }
    (signers.get(fid) ?? signers.set(fid, new Map()).get(fid)).set(key.toLowerCase(), Number(md.requestFid));
  }
}

// ---------- gasless keys (KEY_ADD / KEY_REMOVE), checked the way snapchain describes ----------
const gasless = new Map(); // fid -> Map(keyHex -> { requestFid, scopes, nonce })
const userNonce = new Map(); // fid -> highest user nonce
const appNonces = new Map(); // `${fid}:${requestFid}` -> highest app nonce
const fidOfAddr = async (a) => Number(await op.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [a] }));
async function mergeKeyAdd(m) {
  const fid = m.data.fid, b = m.data.keyAddBody;
  if (hex(m.signer) !== hex(b.key)) throw new Error('KEY_ADD envelope must be signed by the key being added');
  if (b.nonce <= (userNonce.get(fid) ?? 0)) throw new Error('nonce is not greater than stored nonce');
  if (!b.scopes.length || b.scopes.some((x) => x === MessageType.KEY_ADD || x === MessageType.KEY_REMOVE)) throw new Error('invalid scope');
  const custody = await recoverTypedDataAddress({ domain: GASLESS_KEY_ADD_EIP_712_TYPES.domain, types: GASLESS_KEY_ADD_EIP_712_TYPES.types, primaryType: 'KeyAdd',
    message: { fid: BigInt(fid), key: hex(b.key), keyType: b.keyType, scopes: b.scopes, ttl: b.ttl, nonce: b.nonce, deadline: BigInt(b.deadline) }, signature: hex(b.custodySignature) });
  if ((await fidOfAddr(custody)) !== fid) throw new Error('invalid signature');
  const md = decodeGaslessSignedKeyRequestMetadata(b.metadata)._unsafeUnwrap();
  const req = await recoverTypedDataAddress({ domain: GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES.domain, types: GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES.types, primaryType: 'SignedKeyRequest',
    message: { requestFid: md.requestFid, key: hex(b.key), deadline: md.deadline }, signature: hex(md.signature) });
  if (req.toLowerCase() !== md.requestSigner.toLowerCase() || (await fidOfAddr(req)) !== Number(md.requestFid)) throw new Error('invalid signed key request');
  userNonce.set(fid, b.nonce);
  (gasless.get(fid) ?? gasless.set(fid, new Map()).get(fid)).set(hex(b.key).toLowerCase(), { requestFid: Number(md.requestFid), scopes: b.scopes, nonce: b.nonce });
}
function mergeKeyRemove(m) {
  const fid = m.data.fid, b = m.data.keyRemoveBody, k = hex(b.key).toLowerCase();
  const rec = gasless.get(fid)?.get(k); if (!rec) throw new Error('unknown key');
  if (b.signatureType !== 2 || hex(m.signer).toLowerCase() !== k) throw new Error('only self-revocation is implemented in the mock');
  const nk = `${fid}:${rec.requestFid}`;
  if (b.nonce <= (appNonces.get(nk) ?? 0)) throw new Error('nonce is not greater than stored nonce');
  appNonces.set(nk, b.nonce); gasless.get(fid).delete(k);
}

async function merge(m) {
  const v = await validations.validateMessage(m);
  if (v.isErr()) throw new Error(v.error.message);
  if (m.data.type === MessageType.KEY_ADD) return mergeKeyAdd(m);
  await syncKeys();
  const k = hex(m.signer).toLowerCase();
  const g = gasless.get(m.data.fid)?.get(k);
  if (!signers.get(m.data.fid)?.has(k) && !g) throw new Error(`invalid signer: ${k} is not an active key of fid ${m.data.fid}`);
  if (m.data.type === MessageType.KEY_REMOVE) return mergeKeyRemove(m);
  if (g && !g.scopes.includes(m.data.type)) throw new Error(`key not scoped for ${messageTypeToJSON(m.data.type)}`);
  const t = m.data.type;
  // removes delete their target
  if (t === MessageType.CAST_REMOVE) { const h = hex(m.data.castRemoveBody.targetHash); drop((x) => x.data.type === MessageType.CAST_ADD && hex(x.hash) === h); }
  if (t === MessageType.REACTION_REMOVE || t === MessageType.REACTION_ADD) { const b = m.data.reactionBody; drop((x) => x.data.fid === m.data.fid && x.data.reactionBody && x.data.reactionBody.type === b.type && hex(x.data.reactionBody.targetCastId.hash) === hex(b.targetCastId.hash)); }
  if (t === MessageType.LINK_REMOVE || t === MessageType.LINK_ADD) { drop((x) => x.data.fid === m.data.fid && x.data.linkBody && x.data.linkBody.targetFid === m.data.linkBody.targetFid); }
  if ([MessageType.CAST_ADD, MessageType.REACTION_ADD, MessageType.LINK_ADD, MessageType.USER_DATA_ADD].includes(t)) msgs.push(m);
}
const drop = (f) => { for (let i = msgs.length - 1; i >= 0; i--) if (f(msgs[i])) msgs.splice(i, 1); };

// ---------- seed: two other users posting from a different app ----------
const seedSigners = new Map(); // fid -> signer, so the test can act as other users
async function seed() {
  const app = 9152; // pretend "farcaster" app fid
  const mk = async (fid, uname, display, texts) => {
    const s = new NobleEd25519Signer(crypto.getRandomValues(new Uint8Array(32)));
    const k = hex((await s.getSignerKey())._unsafeUnwrap());
    (signers.get(fid) ?? signers.set(fid, new Map()).get(fid)).set(k.toLowerCase(), app);
    names.set(uname, fid); seedSigners.set(fid, s);
    const o = { fid, network: FarcasterNetwork.MAINNET };
    msgs.push((await makeUserDataAdd({ type: UserDataType.USERNAME, value: uname }, o, s))._unsafeUnwrap());
    msgs.push((await makeUserDataAdd({ type: UserDataType.DISPLAY, value: display }, o, s))._unsafeUnwrap());
    for (const t of texts) msgs.push((await makeCastAdd({ text: t, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: 0 }, o, s))._unsafeUnwrap());
  };
  await mk(app, 'farcaster', 'Farcaster', []);
  await mk(100, 'alice', 'Alice', ['gm from the main app', 'running my own node this weekend']);
  await mk(200, 'bob', 'Bob', ['options > perps']);
  await mk(4242, 'mike', 'Mike', []); // the test user's profile (written by their old app)
  msgs.push((await makeLinkAdd({ type: 'follow', targetFid: 200 }, { fid: 100, network: FarcasterNetwork.MAINNET }, seedSigners.get(100)))._unsafeUnwrap()); // alice follows bob (the signed-out feed)
  names.set('mike', 4242);
}

// ---------- HTTP ----------
const q = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams);
const page = (arr, p) => { let a = [...arr]; if (p.reverse === 'true') a.reverse(); return a.slice(0, Number(p.pageSize || 1000)); };
const of = (type, fid) => msgs.filter((m) => m.data.type === type && (fid === undefined || m.data.fid === Number(fid)));

const routes = {
  '/v1/info': () => ({ shardInfos: [{ shardId: 0, blockDelay: 0 }, { shardId: 1, blockDelay: 0 }, { shardId: 2, blockDelay: 0 }] }),
  '/v1/castsByFid': (p) => ({ messages: page(of(MessageType.CAST_ADD, p.fid), p).map(toJson) }),
  '/v1/castById': (p) => { const m = of(MessageType.CAST_ADD, p.fid).find((x) => hex(x.hash) === p.hash); if (!m) throw 404; return toJson(m); },
  '/v1/castsByParent': (p) => ({ messages: of(MessageType.CAST_ADD).filter((m) => m.data.castAddBody.parentCastId && hex(m.data.castAddBody.parentCastId.hash) === p.hash).map(toJson) }),
  '/v1/linksByFid': (p) => ({ messages: page(of(MessageType.LINK_ADD, p.fid), p).map(toJson) }),
  '/v1/linksByTargetFid': (p) => ({ messages: page(of(MessageType.LINK_ADD).filter((m) => m.data.linkBody.targetFid === Number(p.target_fid)), p).map(toJson) }),
  '/v1/castsByMention': (p) => ({ messages: page(of(MessageType.CAST_ADD).filter((m) => (m.data.castAddBody.mentions ?? []).includes(Number(p.fid))), p).map(toJson) }),
  // test helper: alice follows mike back and replies to his latest cast; bob replies too (not a mutual)
  '/test/replies': async () => {
    const latest = of(MessageType.CAST_ADD, 4242).at(-1);
    const o = (fid) => ({ fid, network: FarcasterNetwork.MAINNET });
    msgs.push((await makeLinkAdd({ type: 'follow', targetFid: 4242 }, o(100), seedSigners.get(100)))._unsafeUnwrap());
    for (const [fid, text] of [[100, 'welcome to the townhall'], [200, 'who dis']])
      msgs.push((await makeCastAdd({ text, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: 0, parentCastId: { fid: 4242, hash: latest.hash } }, o(fid), seedSigners.get(fid)))._unsafeUnwrap());
    return { ok: true };
  },
  '/v1/linkById': (p) => { const m = of(MessageType.LINK_ADD, p.fid).find((x) => x.data.linkBody.targetFid === Number(p.target_fid)); if (!m) throw 404; return toJson(m); },
  '/v1/reactionById': (p) => { const m = of(MessageType.REACTION_ADD, p.fid).find((x) => hex(x.data.reactionBody.targetCastId.hash) === p.target_hash && reactionTypeToJSON(x.data.reactionBody.type).endsWith(p.reaction_type.toUpperCase())); if (!m) throw 404; return toJson(m); },
  '/v1/userDataByFid': (p) => ({ messages: of(MessageType.USER_DATA_ADD, p.fid).map(toJson) }),
  '/v1/userNameProofByName': (p) => { const fid = names.get(p.name); if (!fid) throw 404; return { name: p.name, fid, type: 'USERNAME_TYPE_FNAME' }; },
  '/v1/signersByFid': async (p) => {
    await syncKeys(); const fid = Number(p.fid);
    const on = [...(signers.get(fid) ?? new Map())].map(([key, requestFid]) => ({ source: 'SIGNER_SOURCE_ONCHAIN', key, keyType: 1, fid, requestFid }));
    const off = [...(gasless.get(fid) ?? new Map())].map(([key, r]) => ({ source: 'SIGNER_SOURCE_OFFCHAIN', key, keyType: 1, fid, requestFid: r.requestFid, nonce: r.nonce, scopes: r.scopes.map(messageTypeToJSON) }));
    const out = { signers: [...on, ...off], currentUserNonce: userNonce.get(fid) ?? 0 };
    if (p.requesterFids) out.requesterFidNonces = { [p.requesterFids]: appNonces.get(`${fid}:${p.requesterFids}`) ?? 0 };
    return out;
  },
};

// ---------- stand-in for the Farcaster client API (signed key requests) ----------
// The real flow: the person approves in the Farcaster app, which adds the key onchain.
// Here /test/approve plays the app: it checks the app's EIP-712 signature and activates the key.
const skr = new Map(); // token -> { key, requestFid, signature, deadline, state, userFid }
const SIGNIN = 'http://127.0.0.1:' + (process.env.SIGNIN_PORT || 3390);
async function fcApi(path, req, res) {
  const u = new URL(req.url, 'http://x');
  if (path === '/v2/signed-key-requests' && req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    const token = 'tok_' + Math.random().toString(36).slice(2);
    skr.set(token, { ...b, state: 'pending', userFid: null });
    return { result: { signedKeyRequest: { token, deeplinkUrl: `farcaster://signed-key-request?token=${token}`, state: 'pending', key: b.key } } };
  }
  if (path === '/v2/signed-key-request') {
    const r = skr.get(u.searchParams.get('token')); if (!r) throw 404;
    return { result: { signedKeyRequest: { token: u.searchParams.get('token'), state: r.state, userFid: r.userFid ?? undefined } } };
  }
}
const routesTest = {
  '/test/approve': async (p) => {
    const token = p.token || [...skr.keys()].at(-1);
    const r = skr.get(token); if (!r) throw 404;
    const { recoverTypedDataAddress } = await import('viem');
    const signer = await recoverTypedDataAddress({ domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN, types: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES.types, primaryType: 'SignedKeyRequest', message: { requestFid: BigInt(r.requestFid), key: r.key, deadline: BigInt(r.deadline) }, signature: r.signature });
    if (process.env.APP_ADDRESS && signer.toLowerCase() !== process.env.APP_ADDRESS.toLowerCase()) throw new Error('bad app signature');
    (signers.get(4242) ?? signers.set(4242, new Map()).get(4242)).set(r.key.toLowerCase(), Number(r.requestFid));
    r.state = 'completed'; r.userFid = 4242;
    return { ok: true, signer };
  },
};

http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  try {
    if (path.startsWith('/v2/')) {
      const body = await fcApi(path, req, res);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(body));
    }
    if (path.startsWith('/api/')) { // what Caddy does in production
      let raw = ''; for await (const c of req) raw += c;
      const r = await fetch(SIGNIN + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? raw : undefined });
      res.statusCode = r.status; res.setHeader('content-type', 'application/json');
      return res.end(await r.text());
    }
    if (routesTest[path]) { const body = await routesTest[path](q(req.url)); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(body)); }
    if (path === '/v1/submitMessage' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const m = Message.decode(new Uint8Array(Buffer.concat(chunks)));
      await merge(m);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(toJson(m)));
    }
    if (routes[path]) {
      const body = await routes[path](q(req.url));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(body));
    }
    // static client
    const file = join(DIST, path === '/' ? 'index.html' : path);
    if (existsSync(file) && !file.endsWith('/')) {
      res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream');
      return res.end(readFileSync(file));
    }
    res.statusCode = 404; res.end('{}');
  } catch (e) {
    res.statusCode = e === 404 ? 404 : 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ errCode: 'bad_request', message: String(e?.message ?? e) }));
  }
}).listen(PORT, async () => { await seed(); console.log(`mock node on :${PORT}`); });
