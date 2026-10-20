/** The app key this browser posts with. Kept apart from keys.ts so reading never loads the signing code. */
export type Stored = { fid: number; key: `0x${string}`; pub: `0x${string}`; app: 'townhall' };

export function loadKey(): Stored | null {
  try { return JSON.parse(localStorage.getItem('appKey') || 'null'); } catch { return null; }
}
export function saveKey(s: Stored) { localStorage.setItem('appKey', JSON.stringify(s)); }
export function forgetKey() { localStorage.removeItem('appKey'); }
