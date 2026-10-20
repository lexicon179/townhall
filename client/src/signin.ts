/**
 * Sign in with the Farcaster app, no recovery phrase.
 *
 * The browser makes a fresh app key and keeps the private half. The server (server/index.mjs)
 * signs a request for the public half as the townhall app account and gets an approval link
 * from the Farcaster client API. The person approves in the Farcaster app, which adds the key
 * to their account onchain. Then this browser can post as them.
 */
import qrcode from 'qrcode-generator';
import type { Stored } from './store';

const toHex = (b: Uint8Array) => ('0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
const fromHex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));

export type Config = { signin: boolean; appFid: number | null; defaultFid: number | null; castLinks?: boolean };

export async function loadConfig(): Promise<Config> {
  try {
    const r = await fetch('/api/config');
    if (r.ok) return await r.json();
  } catch { /* self-hosted without the service */ }
  return { signin: false, appFid: null, defaultFid: null };
}

export type Pending = { token: string; deeplinkUrl: string; priv: Uint8Array; pub: `0x${string}` };

export async function startSignin(): Promise<Pending> {
  await import('./polyfill');
  const { NobleEd25519Signer } = await import('@farcaster/core'); // loaded only when someone signs in
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const signer = new NobleEd25519Signer(priv);
  const pub = toHex((await signer.getSignerKey())._unsafeUnwrap());
  const r = await fetch('/api/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: pub }) });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || `Sign-in failed (${r.status})`);
  // keep the half-finished key so a page reload on the phone does not lose it
  sessionStorage.setItem('pendingKey', JSON.stringify({ token: b.token, deeplinkUrl: b.deeplinkUrl, priv: toHex(priv), pub }));
  return { token: b.token, deeplinkUrl: b.deeplinkUrl, priv, pub };
}

export function resumeSignin(): Pending | null {
  try {
    const s = JSON.parse(sessionStorage.getItem('pendingKey') || 'null');
    if (!s) return null;
    return { token: s.token, deeplinkUrl: s.deeplinkUrl, priv: fromHex(s.priv), pub: s.pub };
  } catch { return null; }
}
export const dropPending = () => sessionStorage.removeItem('pendingKey');

/** Resolves with the stored key once the person approved in the Farcaster app. */
export async function waitSignin(p: Pending, onState: (s: string) => void, signal: { stop: boolean }): Promise<Stored> {
  for (;;) {
    if (signal.stop) throw new Error('cancelled');
    const r = await fetch(`/api/signin?token=${encodeURIComponent(p.token)}`);
    const b = await r.json();
    if (r.ok) {
      onState(b.state);
      if (b.state === 'completed' && b.userFid) {
        sessionStorage.removeItem('pendingKey');
        return { fid: Number(b.userFid), key: toHex(p.priv), pub: p.pub, app: 'townhall' };
      }
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

export function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

export const isMobile = () => /iPhone|iPad|Android/i.test(navigator.userAgent);
