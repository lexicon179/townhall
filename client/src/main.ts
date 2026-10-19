import './polyfill';
import '@fontsource-variable/schibsted-grotesk';
import './style.css';
import {
  info, castsByFid, castsByParent, following, followers, castsByMention, profile, fidByName, appOfCast,
  isFollowing, liked, signerActive, toDate, type CastMsg,
} from './hub';
import { voted } from './votes';
import { loadKey, saveKey, forgetKey, inspectSeed, addAppKey, revokeKey, type Stored } from './keys';
import { loadConfig, startSignin, resumeSignin, dropPending, waitSignin, qrSvg, isMobile, type Config, type Pending } from './signin';
import { cast, react, follow, deleteCast } from './msg';

const $view = document.getElementById('view')!;
const $node = document.getElementById('node')!;
const $me = document.getElementById('me')!;

let key: Stored | null = loadKey();
let cfg: Config = { signin: false, appFid: null, defaultFid: null };
const READ_FID = () => Number(localStorage.getItem('readFid') || 0);
const myFid = () => key?.fid || READ_FID();

// ---------- helpers ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const ago = (d: Date) => {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Put "@username" back into the text at the byte positions the protocol stores. */
async function renderText(c: CastMsg) {
  const b = c.data.castAddBody;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const bytes = enc.encode(b.text || '');
  const ms = b.mentions ?? [], ps = b.mentionsPositions ?? [];
  const names = await Promise.all(ms.map((f) => profile(f)));
  let html = '', last = 0;
  ps.forEach((p, i) => {
    html += esc(dec.decode(bytes.slice(last, p)));
    const n = names[i];
    html += `<a class="mention" href="#/u/${n.fid}">@${esc(n.username || `fid:${n.fid}`)}</a>`;
    last = p;
  });
  html += esc(dec.decode(bytes.slice(last)));
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

/** Profile picture, or the first letter when there is none (or it fails to load). */
function avatar(p: { fid: number; username?: string; display?: string; pfp?: string }) {
  const letter = esc(((p.display || p.username || '?').trim()[0] || '?').toUpperCase());
  return p.pfp
    ? `<span class="pfp" data-l="${letter}"><img src="${esc(p.pfp)}" alt="" loading="lazy"></span>`
    : `<span class="pfp" data-l="${letter}"></span>`;
}
// broken images fall back to the letter (no inline handlers: the CSP forbids them)
document.addEventListener('error', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'IMG' && t.parentElement?.classList.contains('pfp')) t.remove();
}, true);

// ---------- client filter ----------

const hiddenApps = new Set<number>(JSON.parse(localStorage.getItem('hiddenApps') || '[]'));
const saveHidden = () => localStorage.setItem('hiddenApps', JSON.stringify([...hiddenApps]));
let votersOnly = localStorage.getItem('votersOnly') === '1';

// ---------- node status ----------

async function nodeStatus() {
  try {
    const i = await info();
    const delays: number[] = (i.shardInfos ?? []).filter((s: any) => s.shardId !== 0).map((s: any) => Number(s.blockDelay ?? 0));
    const worst = delays.length ? Math.max(...delays) : 0;
    const height = Math.max(0, ...(i.shardInfos ?? []).map((s: any) => Number(s.maxHeight ?? 0)));
    $node.className = 'node ' + (worst < 10 ? 'ok' : 'warn');
    $node.innerHTML = worst < 10
      ? `<b>${cfg.signin ? 'Node' : 'Your node'}</b> in sync${height ? `, block ${height.toLocaleString('en-US')}` : ''}`
      : `<b>${cfg.signin ? 'Node' : 'Your node'}</b> catching up, ${worst.toLocaleString('en-US')} blocks behind`;
  } catch {
    $node.className = 'node bad';
    $node.innerHTML = '<b>Your node</b> is starting. On first run it downloads the network, which takes a few hours';
  }
}

async function renderMe() {
  const f = myFid();
  if (!f) { $me.innerHTML = cfg.signin || cfg.defaultFid ? '<a class="btn primary sm" href="#/setup">Sign in</a>' : ''; return; }
  const p = await profile(f);
  $me.innerHTML = `<a href="#/u/${f}">@${esc(p.username || String(f))}</a>${key ? '' : '<span class="muted">reading only</span>'}<a href="#/n">Replies</a><a href="#/settings">Settings</a>`;
}

// ---------- cast rendering ----------

const ICON = {
  reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4z"/></svg>',
  like: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  recast: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/></svg>',
};

async function castEl(c: CastMsg, opts: { showParent?: boolean } = {}) {
  const p = await profile(c.data.fid);
  const body = c.data.castAddBody;
  const app = await appOfCast(c);
  const appName = !app ? null : app === c.data.fid ? 'own key' : (await profile(app)).username || `app ${app}`;
  const parent = body.parentCastId;
  const parentName = parent && opts.showParent !== false ? (await profile(parent.fid)).username || `fid:${parent.fid}` : null;
  const images = (body.embeds ?? []).filter((e) => e.url && /\.(png|jpe?g|gif|webp)(\?|$)|imagedelivery\.net/i.test(e.url));
  const links = (body.embeds ?? []).filter((e) => e.url && !images.includes(e));
  const mine = key && c.data.fid === key.fid;
  const didVote = await Promise.race([voted(c.data.fid), new Promise<null>((r) => setTimeout(() => r(null), 2500))]);

  const el = h(`
    <article class="cast" data-app="${app ?? ''}" data-voted="${didVote ? 1 : 0}">
      <a href="#/u/${p.fid}">${avatar(p)}</a>
      <div>
        <div class="head">
          <a class="name" href="#/u/${p.fid}">${esc(p.display || p.username || `fid ${p.fid}`)}</a>
          <span class="handle">@${esc(p.username || String(p.fid))}</span>
          ${didVote ? '<span class="voted" title="Accepted the social contract in the Farcaster network vote (VOTE NFT on Base, token id = fid)">voted</span>' : ''}
          <a class="time" href="#/c/${c.data.fid}/${c.hash}">${ago(toDate(c.data.timestamp))}</a>
          ${appName ? `<span class="via" title="The app that signed this cast (app fid ${app})">via ${esc(appName)}</span>` : ''}
        </div>
        ${parentName ? `<div class="reply-to">replying to <a href="#/c/${parent!.fid}/${parent!.hash}">@${esc(parentName)}</a></div>` : ''}
        <div class="text">${await renderText(c)}</div>
        ${images.map((e) => `<img class="embed-img" src="${esc(e.url!)}" alt="" loading="lazy">`).join('')}
        ${links.map((e) => `<a class="embed" href="${esc(e.url!)}" target="_blank" rel="noreferrer">${esc(e.url!)}</a>`).join('')}
        <div class="actions">
          <button data-a="reply" aria-label="Reply" title="Reply">${ICON.reply}</button>
          <button data-a="like" aria-label="Like" title="Like">${ICON.like}</button>
          <button data-a="recast" aria-label="Recast" title="Recast">${ICON.recast}</button>
          ${mine ? `<button data-a="delete" aria-label="Delete" title="Delete">${ICON.delete}</button>` : ''}
        </div>
        <div class="slot"></div>
      </div>
    </article>`);

  const target = { fid: c.data.fid, hash: c.hash };
  const likeBtn = el.querySelector<HTMLButtonElement>('[data-a=like]')!;
  if (key) liked(key.fid, target).then((on) => on && likeBtn.classList.add('on'));

  el.querySelector('.actions')!.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    if (!key) { alert('Read-only mode. Connect your account in settings to write.'); return; }
    const a = b.dataset.a;
    try {
      if (a === 'reply') {
        const slot = el.querySelector('.slot')!;
        if (!slot.childElementCount) slot.append(composer(target, () => (slot.innerHTML = '')));
      } else if (a === 'like') {
        const on = !b.classList.contains('on');
        await react(key, 'like', target, on);
        b.classList.toggle('on', on);
      } else if (a === 'recast') {
        await react(key, 'recast', target, true);
        b.classList.add('on');
      } else if (a === 'delete' && confirm('Delete this cast?')) {
        await deleteCast(key, c.hash);
        el.remove();
      }
    } catch (e) {
      alert((e as Error).message);
    }
  });
  return el;
}

function composer(parent?: { fid: number; hash: string }, done?: () => void) {
  const el = h(`
    <div class="compose ${parent ? 'is-reply' : ''}">
      <textarea rows="${parent ? 2 : 3}" maxlength="1024" placeholder="${parent ? 'Write a reply' : 'Write a cast'}"></textarea>
      <div class="row"><span class="count"></span><button class="btn primary" disabled>${parent ? 'Reply' : 'Cast'}</button></div>
      <div class="err"></div>
    </div>`);
  const ta = el.querySelector('textarea')!, btn = el.querySelector('button')!, err = el.querySelector('.err')!, count = el.querySelector('.count')!;
  ta.addEventListener('input', () => {
    const n = new TextEncoder().encode(ta.value).length;
    count.textContent = n > 800 ? `${1024 - n} left` : '';
    btn.disabled = !ta.value.trim();
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
  });
  btn.addEventListener('click', async () => {
    if (!key || !ta.value.trim()) return;
    btn.disabled = true; err.textContent = '';
    try {
      await cast(key, ta.value, parent);
      ta.value = '';
      err.innerHTML = `<span class="muted">Sent. Your node relayed it to the network; it appears once a validator includes it, usually within seconds.</span>`;
      done?.();
    } catch (e) {
      err.textContent = (e as Error).message;
      btn.disabled = false;
    }
  });
  return el;
}

// ---------- views ----------

async function viewFeed() {
  const fid = myFid();
  const guest = !fid && !!cfg.defaultFid;
  if (!fid && !guest) return viewSetup();
  $view.innerHTML = '';
  if (guest) $view.append(h(`<div class="guest"><div><b>You are reading the town square.</b><span class="muted">Sign in to see the people you follow, and to post.</span></div><a class="btn primary" href="#/setup">Sign in</a></div>`));
  if (key) $view.append(composer());
  const filter = h(`<div class="sources"><button class="chip voters ${votersOnly ? '' : 'off'}" aria-pressed="${votersOnly}" title="Only show people who voted">Voters only</button><span class="sources-label">Apps in your feed</span><div class="chips"></div></div>`);
  const list = h('<section></section>');
  $view.append(filter, list);
  list.innerHTML = '<div class="center">Reading your feed from your node…</div>';

  const fids = guest ? await following(cfg.defaultFid!, 150) : [fid, ...(await following(fid, 150))];
  const batches = await pool(fids, 12, (f) => castsByFid(f, 4).catch(() => []));
  const casts = batches.flat().sort((a, b) => b.data.timestamp - a.data.timestamp).slice(0, 120);
  list.innerHTML = casts.length ? '' : '<div class="center">Nothing yet. Follow some people.</div>';

  const counts = new Map<number, number>();
  const els = await pool(casts, 8, (c) => castEl(c));
  for (const el of els) {
    list.append(el);
    const app = Number(el.dataset.app || 0);
    if (app) counts.set(app, (counts.get(app) || 0) + 1);
  }
  const apply = () => list.querySelectorAll<HTMLElement>('.cast').forEach((el) => {
    const hide = hiddenApps.has(Number(el.dataset.app || 0)) || (votersOnly && el.dataset.voted !== '1');
    el.style.display = hide ? 'none' : '';
  });
  const vchip = filter.querySelector<HTMLButtonElement>('.voters')!;
  vchip.addEventListener('click', () => {
    votersOnly = !votersOnly; localStorage.setItem('votersOnly', votersOnly ? '1' : '0');
    vchip.classList.toggle('off', !votersOnly); vchip.setAttribute('aria-pressed', String(votersOnly)); apply();
  });
  const chips = filter.querySelector('.chips')!;
  for (const [app, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const name = app === fid || (key && app === cfg.appFid) ? 'townhall' : (await profile(app)).username || `app ${app}`;
    const chip = h(`<button class="chip ${hiddenApps.has(app) ? 'off' : ''}" aria-pressed="${!hiddenApps.has(app)}" title="Show or hide casts signed by ${esc(name)}">${esc(name)} <span>${n}</span></button>`);
    chip.addEventListener('click', () => {
      hiddenApps.has(app) ? hiddenApps.delete(app) : hiddenApps.add(app);
      chip.classList.toggle('off'); chip.setAttribute('aria-pressed', String(!hiddenApps.has(app))); saveHidden(); apply();
    });
    chips.append(chip);
  }
  apply();
}

async function viewProfile(fid: number) {
  const p = await profile(fid);
  $view.innerHTML = '';
  const head = h(`
    <header class="profile">
      ${avatar(p)}
      <div class="who"><h1>${esc(p.display || p.username || `fid ${fid}`)}</h1><div class="muted">@${esc(p.username || '')}, fid ${fid}</div></div>
      <div class="follow"></div>
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
    </header>`);
  $view.append(head);
  if (key && fid !== key.fid) {
    let on = await isFollowing(key.fid, fid);
    const b = h(`<button class="btn ${on ? '' : 'primary'}">${on ? 'Following' : 'Follow'}</button>`) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await follow(key!, fid, !on); on = !on; b.textContent = on ? 'Following' : 'Follow'; b.classList.toggle('primary', !on); }
      catch (e) { alert((e as Error).message); }
      b.disabled = false;
    });
    head.querySelector('.follow')!.append(b);
  }
  const list = h('<section></section>');
  $view.append(list);
  for (const c of await castsByFid(fid, 30)) list.append(await castEl(c));
}

async function viewThread(fid: number, hash: string) {
  $view.innerHTML = '<div class="center">Loading…</div>';
  const r = await fetch(`/v1/castById?fid=${fid}&hash=${hash}`);
  if (!r.ok) { $view.innerHTML = '<div class="center">Cast not found on your node (yet).</div>'; return; }
  const root: CastMsg = await r.json();
  $view.innerHTML = '';
  $view.append(await castEl(root));
  const replies = (await castsByParent(fid, hash)).sort((a, b) => a.data.timestamp - b.data.timestamp);
  const wrap = h('<section class="replies"></section>');
  for (const c of replies) wrap.append(await castEl(c, { showParent: false }));
  $view.append(wrap);
}

/** Replies and mentions. By default only from mutuals: people you follow who follow you back. */
async function viewReplies() {
  const fid = myFid();
  if (!fid) return viewSetup();
  const everyone = localStorage.getItem('repliesEveryone') === '1';
  $view.innerHTML = '';
  const head = h(`<div class="sources"><span class="sources-label">Replies and mentions from</span><div class="chips seg">
    <button class="chip ${everyone ? 'off' : ''}" data-v="0">mutuals</button><button class="chip ${everyone ? '' : 'off'}" data-v="1">everyone</button></div></div>`);
  head.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (b) { localStorage.setItem('repliesEveryone', b.dataset.v!); viewReplies(); }
  });
  const list = h('<section><div class="center">Reading replies from your node…</div></section>');
  $view.append(head, list);

  const [mine, mentions, outs, ins] = await Promise.all([
    castsByFid(fid, 25), castsByMention(fid, 50).catch(() => []),
    everyone ? Promise.resolve([]) : following(fid, 3000), everyone ? Promise.resolve([]) : followers(fid, 3000),
  ]);
  const replies = (await pool(mine, 6, (c) => castsByParent(fid, c.hash).catch(() => []))).flat();
  const back = new Set(ins);
  const mutual = new Set(outs.filter((f) => back.has(f)));
  const seen = new Set<string>();
  const items = [...replies, ...mentions]
    .filter((c) => c.data.fid !== fid && (everyone || mutual.has(c.data.fid)))
    .filter((c) => !seen.has(c.hash) && seen.add(c.hash))
    .sort((a, b) => b.data.timestamp - a.data.timestamp)
    .slice(0, 60);
  list.innerHTML = items.length ? '' : `<div class="center">${everyone ? 'No replies or mentions yet.' : 'Nothing from mutuals yet. Quiet is fine.'}</div>`;
  for (const el of await pool(items, 8, (c) => castEl(c))) list.append(el);
}

let pendingStop = { stop: false };

function signinCard() {
  const si = h(`
    <section class="option main">
      <h2>Sign in with Farcaster</h2>
      <p class="muted">Approve townhall in the Farcaster app. No recovery phrase. The key townhall posts with is made in this browser and stays here.</p>
      <div class="row"><button class="btn primary" data-a="go">Sign in with Farcaster</button></div>
      <div class="qr"></div>
      <div class="status muted"></div>
      <div class="err"></div>
    </section>`);
  const go = si.querySelector<HTMLButtonElement>('[data-a=go]')!, qr = si.querySelector<HTMLElement>('.qr')!;
  const status = si.querySelector<HTMLElement>('.status')!, err = si.querySelector<HTMLElement>('.err')!;
  const run = async (p: Pending) => {
    go.hidden = true; err.textContent = '';
    if (isMobile()) {
      qr.innerHTML = `<a class="btn primary" href="${esc(p.deeplinkUrl)}">Open the Farcaster app</a>`;
      status.textContent = 'Approve townhall there, then come back to this page.';
    } else {
      qr.innerHTML = `<div class="qrbox">${qrSvg(p.deeplinkUrl)}</div><p class="muted">Scan with your phone camera and approve in the Farcaster app. <a href="${esc(p.deeplinkUrl)}" target="_blank" rel="noreferrer">Open link</a></p>`;
      status.textContent = 'Waiting for approval…';
    }
    pendingStop.stop = true; pendingStop = { stop: false };
    try {
      const stored = await waitSignin(p, (s) => {
        if (s === 'approved') { qr.innerHTML = ''; status.textContent = 'Approved. The Farcaster app is adding the key to your account…'; }
      }, pendingStop);
      qr.innerHTML = '';
      status.textContent = 'Key added. Waiting for the node to see it…';
      saveKey(stored);
      localStorage.setItem('readFid', String(stored.fid));
      key = stored;
      for (let i = 0; i < 60 && !(await signerActive(stored.fid, stored.pub).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 5000));
      renderMe();
      location.hash = '#/';
      route();
    } catch (e) {
      if ((e as Error).message === 'cancelled') return;
      err.textContent = (e as Error).message; go.hidden = false;
    }
  };
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await run(await startSignin()); } catch (e) { err.textContent = (e as Error).message; }
    go.disabled = false;
  });
  const p = resumeSignin();
  if (p) run(p);
  else dropPending();
  return si;
}

function viewSetup() {
  $view.innerHTML = '';
  // Read-only: just a username
  const ro = h(`
    <section class="option">
      <h2>Just read</h2>
      <p class="muted">See your feed as your node sees it. Nothing to sign.</p>
      <div class="field"><input type="text" placeholder="Your username" autocapitalize="off" spellcheck="false"><button class="btn">Open feed</button></div>
      <div class="err"></div>
    </section>`);
  ro.querySelector('button')!.addEventListener('click', async () => {
    const v = ro.querySelector('input')!.value.trim();
    const fid = /^\d+$/.test(v) ? Number(v) : await fidByName(v);
    if (!fid) { ro.querySelector('.err')!.textContent = 'Username not found on your node.'; return; }
    localStorage.setItem('readFid', String(fid));
    route();
  });

  // Write: seed phrase -> app key via one Optimism transaction (self-hosted only)
  const w = h(`
    <section class="option">
      <h2>${cfg.signin ? 'Use a recovery phrase' : 'Read and post'}</h2>
      <p class="muted">This client posts with its own app key. Your recovery phrase signs one KEY_ADD message that adds the key to your account, then it is cleared from the page. No transaction, no gas.</p>
      <p class="warnbox">Treat a recovery phrase like <code>rm -rf</code>: test with a test account, and only paste it into software you run yourself or from developers you trust. Prefer signing in through an app that holds your account when you can.</p>
      <textarea placeholder="Recovery phrase, 12 or 24 words" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      <div class="row"><button class="btn" data-a="check">Check phrase</button><button class="btn primary" data-a="add" disabled>Add app key</button></div>
      <div class="kv"></div>
      <div class="status muted"></div>
      <div class="err"></div>
    </section>`);
  const ta = w.querySelector('textarea')!, kv = w.querySelector('.kv')!, err = w.querySelector('.err')!, status = w.querySelector('.status')!;
  const addBtn = w.querySelector<HTMLButtonElement>('[data-a=add]')!;
  w.querySelector('[data-a=check]')!.addEventListener('click', async () => {
    err.textContent = ''; kv.innerHTML = ''; addBtn.disabled = true;
    try {
      const r = await inspectSeed(ta.value);
      const p = r.fid ? await profile(r.fid) : null;
      kv.innerHTML = `<b>Custody</b><span>${r.custody}</span><b>FID</b><span>${r.fid || 'none'}${p?.username ? ` (@${esc(p.username)})` : ''}</span>`;
      if (!r.fid) err.textContent = 'No Farcaster account belongs to this phrase.';
      else addBtn.disabled = false;
    } catch (e) {
      err.textContent = (e as Error).message.includes('mnemonic') ? 'That does not look like a valid recovery phrase.' : (e as Error).message;
    }
  });
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true; err.textContent = '';
    try {
      const { stored } = await addAppKey(ta.value, (s) => (status.textContent = s + '…'));
      ta.value = '';
      key = stored;
      localStorage.setItem('readFid', String(stored.fid));
      renderMe();
      location.hash = '#/';
      route();
    } catch (e) {
      err.textContent = (e as Error).message.split('\n')[0];
      addBtn.disabled = false;
    }
  });

  if (cfg.signin) {
    const adv = h('<details class="adv"><summary>Running your own copy of townhall? Use a recovery phrase</summary></details>');
    adv.append(w);
    $view.append(h('<div class="hero"><h1>Farcaster, only the people who showed up.</h1><p>A calm Farcaster client. Read from a real node, filter to people who voted, keep replies to mutuals.</p></div>'), signinCard(), ro, adv);
  } else {
    $view.append(h('<div class="hero"><h1>Farcaster, read from your own node.</h1><p>Every cast here comes from the copy of the network on your server. Posts are signed in this browser with a key that belongs to you.</p></div>'), ro, w);
  }
}

function viewSettings() {
  $view.innerHTML = '';
  const s = h(`
    <div class="card">
      <h2>Settings</h2>
      <div class="kv">
        <b>Account</b><span>${myFid() ? `fid ${myFid()}` : 'none'}</span>
        <b>App key</b><span>${key ? key.pub : 'none (read-only)'}</span>
        <b>Node</b><span>${location.origin}/v1 → your Snapchain read node</span>
      </div>
      <div class="row">
        ${key ? '<button class="btn" data-a="revoke">Revoke this key on the network</button><button class="btn" data-a="forget">Remove from this browser only</button>' : '<button class="btn primary" data-a="connect">Connect account</button>'}
        <button class="btn" data-a="reset">Sign out</button>
      </div>
      <p class="muted">Revoking sends a KEY_REMOVE signed by the key itself, so it stops working everywhere. Removing it from this browser only deletes the local copy; the key stays valid until its TTL runs out.</p>
      <div class="err"></div>
    </div>`);
  s.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a === 'revoke' && key) {
      revokeKey(key).then(() => { key = null; localStorage.removeItem('readFid'); location.hash = '#/'; renderMe(); route(); })
        .catch((x) => { s.querySelector('.err')!.textContent = (x as Error).message; });
      return;
    }
    if (a === 'forget' || a === 'reset') { forgetKey(); key = null; }
    if (a === 'reset') localStorage.removeItem('readFid');
    if (a === 'connect' || a === 'forget' || a === 'reset') { location.hash = a === 'connect' ? '#/setup' : '#/'; renderMe(); route(); }
  });
  $view.append(s);
}

// ---------- router ----------

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'u' && parts[1]) return await viewProfile(Number(parts[1]));
    if (parts[0] === 'c' && parts[2]) return await viewThread(Number(parts[1]), parts[2]);
    if (parts[0] === 'settings') return viewSettings();
    if (parts[0] === 'n') return await viewReplies();
    if (parts[0] === 'setup') return viewSetup();
    return await viewFeed();
  } catch (e) {
    $view.innerHTML = `<div class="card err">${esc((e as Error).message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
nodeStatus();
setInterval(nodeStatus, 15000);
loadConfig().then((c) => { cfg = c; renderMe(); route(); });
