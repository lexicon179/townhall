/**
 * Live: the whole Farcaster network as your node receives it.
 * Polls the node's event log (/v1/events) per shard and /v1/info for block heights.
 * Everything shown here already passed your node's checks (hash, signature, active key).
 */
import { info, profile, recentEvents, toDate } from './hub';

type Item = { id: number; shard: number; kind: string; label: string; fid: number; text?: string; target?: { fid: number; hash?: string }; ts: number; hash: string };

const KINDS: Record<string, string> = { cast: 'Casts', reaction: 'Likes & recasts', link: 'Follows', profile: 'Profiles', pruned: 'Pruned', other: 'Other' };

function toItem(e: any): Item | null {
  const pruned = e.type === 'HUB_EVENT_TYPE_PRUNE_MESSAGE';
  const msg = e.mergeMessageBody?.message ?? e.pruneMessageBody?.message;
  if (!msg?.data) return null;
  const d = msg.data, t: string = d.type;
  const base = { id: Number(e.id), shard: Number(e.shardIndex ?? 0), fid: Number(d.fid), ts: Number(d.timestamp), hash: msg.hash };
  if (pruned) return { ...base, kind: 'pruned', label: `storage limit: oldest ${t.replace('MESSAGE_TYPE_', '').toLowerCase().replace(/_/g, ' ')} pruned` };
  if (t === 'MESSAGE_TYPE_CAST_ADD') return { ...base, kind: 'cast', label: d.castAddBody?.parentCastId ? 'replied' : 'cast', text: d.castAddBody?.text ?? '' };
  if (t === 'MESSAGE_TYPE_CAST_REMOVE') return { ...base, kind: 'cast', label: 'deleted a cast' };
  if (t === 'MESSAGE_TYPE_REACTION_ADD' || t === 'MESSAGE_TYPE_REACTION_REMOVE') {
    const like = d.reactionBody?.type === 'REACTION_TYPE_LIKE';
    const verb = t.endsWith('ADD') ? (like ? 'liked' : 'recast') : (like ? 'unliked' : 'undid a recast of');
    return { ...base, kind: 'reaction', label: verb, target: d.reactionBody?.targetCastId };
  }
  if (t === 'MESSAGE_TYPE_LINK_ADD' || t === 'MESSAGE_TYPE_LINK_REMOVE') return { ...base, kind: 'link', label: t.endsWith('ADD') ? 'followed' : 'unfollowed', target: { fid: Number(d.linkBody?.targetFid) } };
  if (t === 'MESSAGE_TYPE_USER_DATA_ADD') return { ...base, kind: 'profile', label: `updated ${String(d.userDataBody?.type ?? '').replace('USER_DATA_TYPE_', '').toLowerCase()}` };
  if (t.startsWith('MESSAGE_TYPE_VERIFICATION')) return { ...base, kind: 'other', label: 'verified an address' };
  if (t === 'MESSAGE_TYPE_KEY_ADD') return { ...base, kind: 'other', label: 'added an app key (gasless)' };
  return { ...base, kind: 'other', label: t.replace('MESSAGE_TYPE_', '').toLowerCase().replace(/_/g, ' ') };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n = (x: number) => x.toLocaleString('en-US');

let timer: ReturnType<typeof setInterval> | null = null;
let run = 0; // bumped on every open and close, so a request still in flight when you leave does nothing
export function stopLive() { if (timer) clearInterval(timer); timer = null; run++; }

export async function viewLive($view: HTMLElement) {
  stopLive();
  const mine = run;
  const gone = () => mine !== run;
  const hidden = new Set<string>(JSON.parse(localStorage.getItem('liveHidden') || '[]'));
  $view.innerHTML = `
    <section class="live">
      <div class="live-head">
        <h1>Live</h1>
        <p class="muted">Every message the Farcaster network accepts, as your node receives it. Each one passed your node's checks (hash, signature, active key) before it shows here.</p>
      </div>
      <div class="live-stats">
        <div><b data-k="s0">…</b><span>block shard 0</span></div>
        <div><b data-k="s1">…</b><span>block shard 1</span></div>
        <div><b data-k="s2">…</b><span>block shard 2</span></div>
        <div><b data-k="rate">…</b><span>messages / min</span></div>
        <div><b data-k="msgs">…</b><span>messages stored</span></div>
        <div><b data-k="fids">…</b><span>accounts</span></div>
      </div>
      <div class="chips live-filter">${Object.entries(KINDS).map(([k, v]) => `<button class="chip ${hidden.has(k) ? 'off' : ''}" data-k="${k}">${v}</button>`).join('')}</div>
      <ol class="stream" aria-live="off"></ol>
    </section>`;
  const set = (k: string, v: string) => { const el = $view.querySelector(`[data-k=${k}]`); if (el) el.textContent = v; };
  const stream = $view.querySelector('.stream')!;
  $view.querySelector('.live-filter')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.chip'); if (!b) return;
    const k = b.dataset.k!; hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    b.classList.toggle('off'); localStorage.setItem('liveHidden', JSON.stringify([...hidden]));
    stream.querySelectorAll<HTMLElement>('li').forEach((li) => (li.hidden = hidden.has(li.dataset.kind!)));
  });

  const last: Record<number, number> = { 1: 0, 2: 0 };
  const seenAt: number[] = []; // arrival times, for the per-minute rate

  const render = async (it: Item) => {
    const li = document.createElement('li');
    li.dataset.kind = it.kind; li.className = `ev ev-${it.kind} fresh`; li.hidden = hidden.has(it.kind);
    const time = toDate(it.ts).toLocaleTimeString('en-GB', { hour12: false });
    li.innerHTML = `<span class="t">${time}</span><span class="line"><span class="who"><a href="#/u/${it.fid}">fid ${it.fid}</a></span> <span class="what">${esc(it.label)}</span><span class="obj"></span></span><span class="sh">shard ${it.shard}</span>${it.text ? `<a class="txt" href="#/c/${it.fid}/${it.hash}">${esc(it.text.slice(0, 220))}</a>` : ''}`;
    stream.prepend(li);
    setTimeout(() => li.classList.remove('fresh'), 1200);
    while (stream.children.length > 120) stream.lastElementChild!.remove();
    profile(it.fid).then((p) => { const a = li.querySelector('.who a'); if (p.username && a) a.textContent = '@' + p.username; });
    if (it.target?.fid) profile(it.target.fid).then((p) => { const o = li.querySelector('.obj'); if (o) o.innerHTML = `${it.kind === 'reaction' ? ' a cast by' : ''} <a href="#/u/${it.target!.fid}">@${esc(p.username || 'fid ' + it.target!.fid)}</a>`; });
  };

  const tick = async (first = false) => {
    try {
      const i = await info();
      if (gone()) return;
      for (const s of i.shardInfos ?? []) set(`s${s.shardId}`, n(Number(s.maxHeight ?? 0)));
      set('msgs', n(Number(i.dbStats?.numMessages ?? 0)));
      set('fids', n(Number(i.dbStats?.numFidRegistrations ?? 0)));
    } catch { /* node busy; try again next tick */ }
    const fresh: Item[] = [];
    for (const shard of [1, 2]) {
      try {
        const evs = await recentEvents(shard, first ? 400 : 200);
        for (const e of evs) {
          const id = Number(e.id);
          if (id <= last[shard]) continue;
          const it = toItem(e); if (it) fresh.push(it);
        }
        if (evs.length) last[shard] = Math.max(last[shard], ...evs.map((e) => Number(e.id)));
      } catch { /* skip this shard this tick */ }
    }
    if (gone()) return;
    fresh.sort((a, b) => a.ts - b.ts || a.id - b.id);
    const now = Date.now();
    for (const it of first ? fresh.slice(-40) : fresh) { await render(it); if (!first) seenAt.push(now); }
    while (seenAt.length && now - seenAt[0] > 60_000) seenAt.shift();
    set('rate', first ? '…' : n(seenAt.length));
  };

  await tick(true);
  timer = setInterval(() => { if (!document.hidden) tick(); }, 2500);
}
