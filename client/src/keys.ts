/**
 * App key setup. Runs entirely in the browser.
 *
 * 1. Your recovery (seed) phrase derives your custody address: the Ethereum
 *    account that owns your FID.
 * 2. We generate a fresh Ed25519 keypair: the app key this client will sign with.
 * 3. The custody account signs a SignedKeyRequest ("I, fid X, allow this key")
 *    and sends one transaction to the KeyGateway contract on Optimism.
 * 4. Your node sees the onchain event, the key becomes active, and the seed
 *    phrase is dropped from memory. Only the app key is kept (in this browser).
 */
import {
  KEY_GATEWAY_ADDRESS, keyGatewayABI, ID_REGISTRY_ADDRESS, idRegistryABI,
  NobleEd25519Signer, ViemLocalEip712Signer, bytesToHexString, hexStringToBytes,
} from '@farcaster/core';
import { createPublicClient, createWalletClient, http, formatEther, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { optimism } from 'viem/chains';

export const OP_RPC = localStorage.getItem('opRpc') || 'https://mainnet.optimism.io';
const op = () => createPublicClient({ chain: optimism, transport: http(OP_RPC) });

export type Stored = { fid: number; key: Hex; pub: Hex; app: 'townhall' };

export function loadKey(): Stored | null {
  try { return JSON.parse(localStorage.getItem('appKey') || 'null'); } catch { return null; }
}
export function saveKey(s: Stored) { localStorage.setItem('appKey', JSON.stringify(s)); }
export function forgetKey() { localStorage.removeItem('appKey'); }

export function signerOf(s: Stored) {
  const r = hexStringToBytes(s.key);
  if (r.isErr()) throw r.error;
  return new NobleEd25519Signer(r.value);
}

/** Step 1: seed phrase -> custody address, FID, ETH balance on Optimism. */
export async function inspectSeed(seed: string) {
  const account = mnemonicToAccount(seed.trim().toLowerCase().replace(/\s+/g, ' '));
  const client = op();
  const [fid, balance] = await Promise.all([
    client.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: 'idOf', args: [account.address] }),
    client.getBalance({ address: account.address }),
  ]);
  return { account, custody: account.address, fid: Number(fid), balance, eth: formatEther(balance) };
}

/** Step 2: new app key + one KeyGateway.add transaction signed by the custody account. */
export async function addAppKey(seed: string, onStatus: (s: string) => void): Promise<{ stored: Stored; tx: Hex }> {
  const { account, fid, balance } = await inspectSeed(seed);
  if (!fid) throw new Error('This recovery phrase does not own a Farcaster account (no FID at its custody address).');
  if (balance === 0n) throw new Error('The custody address has no ETH on Optimism to pay for the transaction.');

  onStatus('Generating a new app key');
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const signer = new NobleEd25519Signer(priv);
  const pub = (await signer.getSignerKey())._unsafeUnwrap();

  onStatus('Signing the key request with your custody account');
  const eip712 = new ViemLocalEip712Signer(account as any);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const metadata = (await eip712.getSignedKeyRequestMetadata({ requestFid: BigInt(fid), key: pub, deadline }))._unsafeUnwrap();

  onStatus('Sending the transaction to Optimism');
  const wallet = createWalletClient({ account, chain: optimism, transport: http(OP_RPC) });
  const tx = await wallet.writeContract({
    address: KEY_GATEWAY_ADDRESS,
    abi: keyGatewayABI,
    functionName: 'add',
    args: [1, bytesToHexString(pub)._unsafeUnwrap(), 1, bytesToHexString(metadata)._unsafeUnwrap()],
  });

  onStatus('Waiting for the transaction to confirm');
  const receipt = await op().waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') throw new Error(`Transaction failed: ${tx}`);

  const stored: Stored = {
    fid,
    key: bytesToHexString(priv)._unsafeUnwrap(),
    pub: bytesToHexString(pub)._unsafeUnwrap(),
    app: 'townhall',
  };
  saveKey(stored);
  return { stored, tx };
}
