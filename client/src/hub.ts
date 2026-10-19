/**
 * Reading from your own Snapchain node over its HTTP API.
 * The client is served from the same origin as the node proxy (/v1/* -> node:3381),
 * so there is no CORS and no API key anywhere.
 */
export const HUB = (localStorage.getItem('hub') || '').replace(/\/$/, ''); // '' = same origin

export type CastMsg = {
  hash: string;
  signer: string;
  data: {
    fid: number;
    timestamp: number; // Farcaster time: seconds since 2021-01-01
    castAddBody: {
      text: string;
      mentions?: number[];
      mentionsPositions?: number[];
      embeds?: { url?: string; castId?: { fid: number; hash: string } }[];
      parentCastId?: { fid: number; hash: string };
      parentUrl?: string;
    };
  };
};

async function get<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`${HUB}/v1/${path}?${q}`);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export const FARCASTER_EPOCH = 1609459200; // 2021-01-01T00:00:00Z
export const toDate = (t: number) => new Date((t + FARCASTER_EPOCH) * 1000);

export const info = () => get<any>('info', {});

export async function castsByFid(fid: number, pageSize = 5): Promise<CastMsg[]> {
  const r = await get<{ messages: CastMsg[] }>('castsByFid', { fid, pageSize, reverse: true });
  return r.messages ?? [];
}

export async function castsByParent(fid: number, hash: string): Promise<CastMsg[]> {
  const r = await get<{ messages: CastMsg[] }>('castsByParent', { fid, hash, pageSize: 50 });
  return r.messages ?? [];
}

export async function following(fid: number, max = 200): Promise<number[]> {
  const out: number[] = [];
  let pageToken: string | undefined;
  do {
    const r = await get<any>('linksByFid', { fid, link_type: 'follow', pageSize: 100, reverse: true, ...(pageToken ? { pageToken } : {}) });
    for (const m of r.messages ?? []) {
      const t = m.data?.linkBody?.targetFid;
      if (t) out.push(t);
    }
    pageToken = r.nextPageToken || undefined;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

export async function isFollowing(fid: number, target: number): Promise<boolean> {
  try {
    await get('linkById', { fid, target_fid: target, link_type: 'follow' });
    return true;
  } catch {
    return false;
  }
}

export async function liked(fid: number, target: { fid: number; hash: string }): Promise<boolean> {
  try {
    await get('reactionById', { fid, reaction_type: 'Like', target_fid: target.fid, target_hash: target.hash });
    return true;
  } catch {
    return false;
  }
}

// ---------- profiles (cached) ----------

export type Profile = { fid: number; username?: string; display?: string; pfp?: string; bio?: string };
const profiles = new Map<number, Promise<Profile>>();

export function profile(fid: number): Promise<Profile> {
  if (!profiles.has(fid)) {
    profiles.set(fid, get<any>('userDataByFid', { fid }).then((r) => {
      const p: Profile = { fid };
      for (const m of r.messages ?? []) {
        const b = m.data?.userDataBody;
        if (!b) continue;
        if (b.type === 'USER_DATA_TYPE_USERNAME') p.username = b.value;
        if (b.type === 'USER_DATA_TYPE_DISPLAY') p.display = b.value;
        if (b.type === 'USER_DATA_TYPE_PFP') p.pfp = b.value;
        if (b.type === 'USER_DATA_TYPE_BIO') p.bio = b.value;
      }
      return p;
    }).catch(() => ({ fid })));
  }
  return profiles.get(fid)!;
}

export async function fidByName(name: string): Promise<number | null> {
  try {
    const r = await get<any>('userNameProofByName', { name: name.replace(/^@/, '') });
    return r.fid ?? null;
  } catch {
    return null;
  }
}

// ---------- which app posted a cast ----------
// Every message is signed by an app key. When the key was added, the app that
// requested it (requestFid) was recorded. That is how we know the client.

const signerApps = new Map<number, Promise<Map<string, number>>>();

export function appsOf(fid: number): Promise<Map<string, number>> {
  if (!signerApps.has(fid)) {
    signerApps.set(fid, get<any>('signersByFid', { fid, pageSize: 100 }).then((r) => {
      const m = new Map<string, number>();
      for (const s of r.signers ?? []) if (s.requestFid) m.set(String(s.key).toLowerCase(), Number(s.requestFid));
      return m;
    }).catch(() => new Map()));
  }
  return signerApps.get(fid)!;
}

export async function appOfCast(c: CastMsg): Promise<number | null> {
  return (await appsOf(c.data.fid)).get(c.signer.toLowerCase()) ?? null;
}

export async function signerActive(fid: number, key: string): Promise<boolean> {
  return (await get<any>('signersByFid', { fid, pageSize: 100 }).catch(() => ({ signers: [] }))).signers
    .some((s: any) => String(s.key).toLowerCase() === key.toLowerCase());
}
