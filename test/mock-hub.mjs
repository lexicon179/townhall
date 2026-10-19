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
  makeCastAdd, makeUserDataAdd, NobleEd25519Signer, FarcasterNetwork, UserDataType, bytesToHexString,
  KEY_GATEWAY_ADDRESS, ID_REGISTRY_ADDRESS, idRegistryABI,
  SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN, SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES,
} from '@farcaster/core';
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

async function merge(m) {
  const v = await validations.validateMessage(m);
  if (v.isErr()) throw new Error(v.error.message);
  await syncKeys();
  const k = hex(m.signer).toLowerCase();
  if (!signers.get(m.data.fid)?.has(k)) throw new Error(`invalid signer: ${k} is not an active key of fid ${m.data.fid}`);
  const t = m.data.type;
  // removes delete their target
  if (t === MessageType.CAST_REMOVE) { const h = hex(m.data.castRemoveBody.targetHash); drop((x) => x.data.type === MessageType.CAST_ADD && hex(x.hash) === h); }
  if (t === MessageType.REACTION_REMOVE || t === MessageType.REACTION_ADD) { const b = m.data.reactionBody; drop((x) => x.data.fid === m.data.fid && x.data.reactionBody && x.data.reactionBody.type === b.type && hex(x.data.reactionBody.targetCastId.hash) === hex(b.targetCastId.hash)); }
  if (t === MessageType.LINK_REMOVE || t === MessageType.LINK_ADD) { drop((x) => x.data.fid === m.data.fid && x.data.linkBody && x.data.linkBody.targetFid === m.data.linkBody.targetFid); }
  if ([MessageType.CAST_ADD, MessageType.REACTION_ADD, MessageType.LINK_ADD, MessageType.USER_DATA_ADD].includes(t)) msgs.push(m);
}
const drop = (f) => { for (let i = msgs.length - 1; i >= 0; i--) if (f(msgs[i])) msgs.splice(i, 1); };

// ---------- seed: two other users posting from a different app ----------
async function seed() {
  const app = 9152; // pretend "farcaster" app fid
  const mk = async (fid, uname, display, texts) => {
    const s = new NobleEd25519Signer(crypto.getRandomValues(new Uint8Array(32)));
    const k = hex((await s.getSignerKey())._unsafeUnwrap());
    (signers.get(fid) ?? signers.set(fid, new Map()).get(fid)).set(k.toLowerCase(), app);
    names.set(uname, fid);
    const o = { fid, network: FarcasterNetwork.MAINNET };
    msgs.push((await makeUserDataAdd({ type: UserDataType.USERNAME, value: uname }, o, s))._unsafeUnwrap());
    msgs.push((await makeUserDataAdd({ type: UserDataType.DISPLAY, value: display }, o, s))._unsafeUnwrap());
    for (const t of texts) msgs.push((await makeCastAdd({ text: t, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: 0 }, o, s))._unsafeUnwrap());
  };
  await mk(app, 'farcaster', 'Farcaster', []);
  await mk(100, 'alice', 'Alice', ['gm from the main app', 'running my own node this weekend']);
  await mk(200, 'bob', 'Bob', ['options > perps']);
  await mk(4242, 'mike', 'Mike', []); // the test user's profile (written by their old app)
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
  '/v1/linkById': (p) => { const m = of(MessageType.LINK_ADD, p.fid).find((x) => x.data.linkBody.targetFid === Number(p.target_fid)); if (!m) throw 404; return toJson(m); },
  '/v1/reactionById': (p) => { const m = of(MessageType.REACTION_ADD, p.fid).find((x) => hex(x.data.reactionBody.targetCastId.hash) === p.target_hash && reactionTypeToJSON(x.data.reactionBody.type).endsWith(p.reaction_type.toUpperCase())); if (!m) throw 404; return toJson(m); },
  '/v1/userDataByFid': (p) => ({ messages: of(MessageType.USER_DATA_ADD, p.fid).map(toJson) }),
  '/v1/userNameProofByName': (p) => { const fid = names.get(p.name); if (!fid) throw 404; return { name: p.name, fid, type: 'USERNAME_TYPE_FNAME' }; },
  '/v1/signersByFid': async (p) => { await syncKeys(); return { signers: [...(signers.get(Number(p.fid)) ?? new Map())].map(([key, requestFid]) => ({ source: 'SIGNER_SOURCE_ONCHAIN', key, keyType: 1, fid: Number(p.fid), requestFid })) }; },
};

http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  try {
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
