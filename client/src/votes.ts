/**
 * Who voted. Accounts that accepted the Network School social contract hold a
 * VOTE NFT on Base whose token id is their fid:
 * https://basescan.org/address/0x4ecfed276c566aeb49da1f3a888e8dbb7263028d
 *
 * We ask Base directly (ownerOf(fid)); no indexer, no API key. Reads are
 * batched into multicalls and cached in this browser. Declining the contract
 * mints nothing, so only "yes" is visible on-chain.
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

export const VOTE = '0x4ecfed276c566aeb49da1f3a888e8dbb7263028d' as const;
const RPC = localStorage.getItem('baseRpc') || 'https://mainnet.base.org';
const client = createPublicClient({ chain: base, transport: http(RPC), batch: { multicall: { wait: 30 } } });
const ABI = [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] }] as const;

type Entry = [voted: boolean, at: number];
const cache: Record<string, Entry> = (() => { try { return JSON.parse(localStorage.getItem('voters') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('voters', JSON.stringify(cache)); } catch { /* full or blocked */ } };
const fresh = ([v, at]: Entry) => Date.now() - at < (v ? 86_400_000 : 600_000); // yes: a day, no: 10 minutes
const inflight = new Map<number, Promise<boolean | null>>();

/** true = voted, false = no VOTE NFT, null = Base not reachable right now. */
export function voted(fid: number): Promise<boolean | null> {
  const hit = cache[fid];
  if (hit && fresh(hit)) return Promise.resolve(hit[0]);
  if (!inflight.has(fid)) {
    inflight.set(fid, client.readContract({ address: VOTE, abi: ABI, functionName: 'ownerOf', args: [BigInt(fid)] })
      .then(() => true)
      .catch((e) => (/revert|nonexistent|ERC721/i.test(String(e?.shortMessage ?? e?.message ?? e)) ? false : null))
      .then((v) => { if (v !== null) { cache[fid] = [v, Date.now()]; save(); } inflight.delete(fid); return v; }));
  }
  return inflight.get(fid)!;
}
