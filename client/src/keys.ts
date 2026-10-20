/**
 * App key setup. Runs entirely in the browser. No transaction, no gas.
 *
 * 1. Your recovery (seed) phrase derives your custody address: the Ethereum
 *    account that owns your FID (read from the IdRegistry on Optimism).
 * 2. We generate a fresh Ed25519 keypair: the app key this client will sign with.
 * 3. The custody account signs two EIP-712 messages: a SignedKeyRequest ("fid X
 *    requests this key") and a KeyAdd ("fid X allows this key, for these message
 *    types, for this long, with this nonce").
 * 4. Both go into a KEY_ADD message, signed by the new key itself as proof that
 *    we hold it, and submitted to your node like any other message.
 * 5. Once it merges, the key is active. The seed phrase is dropped from memory;
 *    only the app key is kept (in this browser).
 */
import './polyfill';
import {
  ID_REGISTRY_ADDRESS, idRegistryABI, NobleEd25519Signer, ViemLocalEip712Signer,
  bytesToHexString, hexStringToBytes, makeKeyAddBody, makeKeyAdd, getFarcasterTime,
  FarcasterNetwork, MessageType, makeKeyRemove, makeKeyRemoveBodySelfRevoke,
} from '@farcaster/core';
import { createPublicClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { optimism } from 'viem/chains';
import { signers, signerActive, appNonce } from './hub';
import { submitRaw } from './msg';

export const OP_RPC = localStorage.getItem('opRpc') || 'https://mainnet.optimism.io';
const op = () => createPublicClient({ chain: optimism, transport: http(OP_RPC) });

import { saveKey, forgetKey, type Stored } from './store';
export { loadKey, saveKey, forgetKey, type Stored } from './store';

export function signerOf(s: Stored) {
  const r = hexStringToBytes(s.key);
  if (r.isErr()) throw r.error;
  return new NobleEd25519Signer(r.value);
}

/** What the key may sign. KEY_ADD / KEY_REMOVE are never allowed: a key can't mint or revoke keys. */
export const SCOPES = [
  MessageType.CAST_ADD, MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD, MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD, MessageType.LINK_REMOVE,
  MessageType.USER_DATA_ADD,
];
/** Sliding expiry: refreshed every time the key signs a message. 90 days is the protocol maximum. */
export const TTL = 90 * 24 * 60 * 60;

const normalize = (seed: string) => seed.trim().toLowerCase().replace(/\s+/g, ' ');

/** Step 1: seed phrase -> custody address and FID. */
export async function inspectSeed(seed: string) {
  const account = mnemonicToAccount(normalize(seed));
  const fid = await op().readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [account.address] });
  return { account, custody: account.address, fid: Number(fid) };
}

/** Step 2: new app key, authorized by the custody account in a KEY_ADD message. */
export async function addAppKey(seed: string, onStatus: (s: string) => void): Promise<{ stored: Stored; hash: string }> {
  const { account, fid } = await inspectSeed(seed);
  if (!fid) throw new Error('This recovery phrase does not own a Farcaster account (no FID at its custody address).');

  onStatus('Generating a new app key');
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const signer = new NobleEd25519Signer(priv);
  const pub = (await signer.getSignerKey())._unsafeUnwrap();

  onStatus('Reading your key nonce from the node');
  const nonce = (await signers(fid)).currentUserNonce + 1;

  onStatus('Signing the key authorization with your custody account');
  const body = await makeKeyAddBody(
    { fid: BigInt(fid), key: pub, scopes: SCOPES, ttl: TTL, nonce, deadline: getFarcasterTime()._unsafeUnwrap() + 3600 },
    new ViemLocalEip712Signer(account as any),
  );
  if (body.isErr()) throw new Error(`Could not build KEY_ADD: ${body.error.message}`);

  onStatus('Submitting KEY_ADD to your node');
  const hash = await submitRaw(await makeKeyAdd(body.value, { fid, network: FarcasterNetwork.MAINNET }, signer));

  const stored: Stored = {
    fid,
    key: bytesToHexString(priv)._unsafeUnwrap() as `0x${string}`,
    pub: bytesToHexString(pub)._unsafeUnwrap() as `0x${string}`,
    app: 'townhall',
  };
  onStatus('Waiting for the key to merge');
  for (let i = 0; i < 30 && !(await signerActive(fid, stored.pub)); i++) await new Promise((r) => setTimeout(r, 2000));
  saveKey(stored);
  return { stored, hash };
}

/**
 * Revoke this browser's key on the network. A gasless key can revoke itself: the KEY_REMOVE
 * envelope is signed by the key being removed, so no recovery phrase is needed. It uses the
 * app nonce of the fid that requested the key (here, your own fid).
 */
export async function revokeKey(k: Stored): Promise<void> {
  const mine = (await signers(k.fid)).signers.find((s) => String(s.key).toLowerCase() === k.pub.toLowerCase());
  if (!mine) throw new Error('The node does not list this key; nothing to revoke.');
  if (mine.source !== 'SIGNER_SOURCE_OFFCHAIN') throw new Error('This key was added onchain. Remove it from the app that manages your keys, or with KeyRegistry.remove from your custody address.');
  const requestFid = Number(mine.requestFid);
  const nonces = await appNonce(k.fid, requestFid);
  const body = makeKeyRemoveBodySelfRevoke({ key: hexStringToBytes(k.pub)._unsafeUnwrap(), nonce: nonces + 1, deadline: getFarcasterTime()._unsafeUnwrap() + 3600 });
  if (body.isErr()) throw new Error(body.error.message);
  await submitRaw(await makeKeyRemove(body.value, { fid: k.fid, network: FarcasterNetwork.MAINNET }, signerOf(k)));
  forgetKey();
}
