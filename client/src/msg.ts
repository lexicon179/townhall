import './polyfill';
/**
 * Writing: build a protocol message, sign it with the app key, submit the raw
 * protobuf bytes to your node. Your read node validates it and relays it to the
 * validators over gossip; a validator puts it in a block.
 */
import {
  makeCastAdd, makeCastRemove, makeReactionAdd, makeReactionRemove, makeLinkAdd, makeLinkRemove,
  Message, FarcasterNetwork, ReactionType, hexStringToBytes,
} from '@farcaster/core';
import { HUB, fidByName } from './hub';
import { signerOf, type Stored } from './keys';

const network = FarcasterNetwork.MAINNET;
const bytes = (h: string) => hexStringToBytes(h)._unsafeUnwrap();

export async function submitRaw(made: { isErr(): boolean; error?: unknown; value?: Message } | any): Promise<string> {
  if (made.isErr()) throw made.error;
  const msg: Message = made.value;
  const r = await fetch(`${HUB}/v1/submitMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Message.encode(msg).finish(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Node rejected the message: ${text.slice(0, 300)}`);
  return JSON.parse(text).hash as string;
}

/** "@name" mentions become protocol mentions: removed from text, positions in UTF-8 bytes. */
async function parseMentions(text: string) {
  const enc = new TextEncoder();
  const mentions: number[] = [];
  const mentionsPositions: number[] = [];
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/(^|\s)@([a-z0-9][a-z0-9-]{0,15}(?:\.eth)?)/gi)) {
    const at = m.index! + m[1].length;
    const fid = await fidByName(m[2].toLowerCase());
    if (!fid || mentions.length >= 10) continue;
    out += text.slice(last, at);
    mentions.push(fid);
    mentionsPositions.push(enc.encode(out).length);
    last = at + 1 + m[2].length;
  }
  out += text.slice(last);
  return { text: out, mentions, mentionsPositions };
}

/** A cast carries at most two embeds: links (images and video are links too) or a quoted cast. */
export const MAX_EMBEDS = 2;

/**
 * A quote is an ordinary cast with the quoted cast's id in its embeds.
 * Attached media go first, then the first link in the text if there is room.
 * A channel cast is an ordinary cast whose parentUrl is the channel's URL; a reply's
 * parent is the cast it answers, so a reply never sets a channel itself.
 */
export async function cast(
  k: Stored, text: string, parent?: { fid: number; hash: string }, quote?: { fid: number; hash: string },
  extra: { media?: string[]; channelUrl?: string } = {},
) {
  const parsed = await parseMentions(text);
  const embeds: any[] = [];
  for (const url of extra.media ?? []) embeds.push({ url });
  const link = text.match(/https?:\/\/\S+/)?.[0];
  const room = MAX_EMBEDS - (quote ? 1 : 0);
  if (link && embeds.length < room && !embeds.some((e) => e.url === link)) embeds.push({ url: link });
  if (embeds.length > room) throw new Error(`A cast can carry ${room === 1 ? 'one attachment next to a quote' : 'two attachments'}.`);
  if (quote) embeds.push({ castId: { fid: quote.fid, hash: bytes(quote.hash) } });
  return submitRaw(await makeCastAdd({
    ...parsed,
    embeds,
    embedsDeprecated: [],
    type: 0,
    ...(parent ? { parentCastId: { fid: parent.fid, hash: bytes(parent.hash) } } : extra.channelUrl ? { parentUrl: extra.channelUrl } : {}),
  } as any, { fid: k.fid, network }, signerOf(k)));
}

export async function deleteCast(k: Stored, hash: string) {
  return submitRaw(await makeCastRemove({ targetHash: bytes(hash) }, { fid: k.fid, network }, signerOf(k)));
}

export async function react(k: Stored, type: 'like' | 'recast', target: { fid: number; hash: string }, on = true) {
  const body = { type: type === 'like' ? ReactionType.LIKE : ReactionType.RECAST, targetCastId: { fid: target.fid, hash: bytes(target.hash) } };
  const make = on ? makeReactionAdd : makeReactionRemove;
  return submitRaw(await make(body, { fid: k.fid, network }, signerOf(k)));
}

export async function follow(k: Stored, targetFid: number, on = true) {
  const make = on ? makeLinkAdd : makeLinkRemove;
  return submitRaw(await make({ type: 'follow', targetFid } as any, { fid: k.fid, network }, signerOf(k)));
}
