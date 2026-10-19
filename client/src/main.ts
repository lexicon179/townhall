import './polyfill';
import '@fontsource-variable/schibsted-grotesk';
import './style.css';
import {
  info, castsByFid, castsByParent, following, profile, fidByName, appOfCast, isFollowing, liked,
  signerActive, toDate, type CastMsg,
} from './hub';
import { loadKey, forgetKey, inspectSeed, addAppKey, type Stored } from './keys';
import { cast, react, follow, deleteCast } from './msg';

const $view = document.getElementById('view')!;
const $node = document.getElementById('node')!;
const $me = document.getElementById('me')!;

let key: Stored | null = loadKey();
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

// ---------- node status ----------

async function nodeStatus() {
  try {
    const i = await info();
    const delays: number[] = (i.shardInfos ?? []).filter((s: any) => s.shardId !== 0).map((s: any) => Number(s.blockDelay ?? 0));
    const worst = delays.length ? Math.max(...delays) : 0;
    const height = Math.max(0, ...(i.shardInfos ?? []).map((s: any) => Number(s.maxHeight ?? 0)));
    $node.className = 'node ' + (worst < 10 ? 'ok' : 'warn');
    $node.innerHTML = worst < 10
      ? `<b>Your node</b> in sync${height ? `, block ${height.toLocaleString('en-US')}` : ''}`
      : `<b>Your node</b> catching up, ${worst.toLocaleString('en-US')} blocks behind`;
  } catch {
    $node.className = 'node bad';
    $node.innerHTML = '<b>Your node</b> is not answering yet';
  }
}

async function renderMe() {
  const f = myFid();
  if (!f) { $me.innerHTML = ''; return; }
  const p = await profile(f);
  $me.innerHTML = `<a href="#/u/${f}">@${esc(p.username || String(f))}</a>${key ? '' : '<span class="muted">reading only</span>'}<a href="#/settings">Settings</a>`;
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

  const el = h(`
    <article class="cast" data-app="${app ?? ''}">
      <a href="#/u/${p.fid}">${avatar(p)}</a>
      <div>
        <div class="head">
          <a class="name" href="#/u/${p.fid}">${esc(p.display || p.username || `fid ${p.fid}`)}</a>
          <span class="handle">@${esc(p.username || String(p.fid))}</span>
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
  if (!fid) return viewSetup();
  $view.innerHTML = '';
  if (key) $view.append(composer());
  const filter = h('<div class="sources"><span class="sources-label">Apps in your feed</span><div class="chips"></div></div>');
  const list = h('<section></section>');
  $view.append(filter, list);
  list.innerHTML = '<div class="center">Reading your feed from your node…</div>';

  const fids = [fid, ...(await following(fid, 150))];
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
    el.style.display = hiddenApps.has(Number(el.dataset.app || 0)) ? 'none' : '';
  });
  const chips = filter.querySelector('.chips')!;
  for (const [app, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const name = app === fid ? 'own keys' : (await profile(app)).username || `app ${app}`;
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

  // Write: seed phrase -> app key via one Optimism transaction
  const w = h(`
    <section class="option">
      <h2>Read and post</h2>
      <p class="muted">This client posts with its own app key. Your recovery phrase signs one transaction on Optimism that adds the key to your account, then it is cleared from the page.</p>
      <p class="warnbox">Only paste a recovery phrase into a client you run yourself, like this one on your server. Never into a site someone else hosts.</p>
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
      kv.innerHTML = `<b>Custody</b><span>${r.custody}</span><b>FID</b><span>${r.fid || 'none'}${p?.username ? ` (@${esc(p.username)})` : ''}</span><b>ETH on Optimism</b><span>${Number(r.eth).toFixed(5)}</span>`;
      if (!r.fid) err.textContent = 'No Farcaster account belongs to this phrase.';
      else if (r.balance === 0n) err.textContent = 'Send a little ETH on Optimism (about $1) to the custody address above to pay for the transaction.';
      else addBtn.disabled = false;
    } catch (e) {
      err.textContent = (e as Error).message.includes('mnemonic') ? 'That does not look like a valid recovery phrase.' : (e as Error).message;
    }
  });
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true; err.textContent = '';
    try {
      const { stored, tx } = await addAppKey(ta.value, (s) => (status.textContent = s + '…'));
      ta.value = '';
      status.innerHTML = `Transaction confirmed: <a href="https://optimistic.etherscan.io/tx/${tx}" target="_blank" rel="noreferrer">${tx.slice(0, 12)}…</a>. Waiting for your node to see the new key…`;
      for (let i = 0; i < 60 && !(await signerActive(stored.fid, stored.pub)); i++) await new Promise((r) => setTimeout(r, 5000));
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

  $view.append(h('<div class="hero"><h1>Farcaster, read from your own node.</h1><p>Every cast here comes from the copy of the network on your server. Posts are signed in this browser with a key that belongs to you.</p></div>'), ro, w);
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
        ${key ? '<button class="btn" data-a="forget">Remove app key from this browser</button>' : '<button class="btn primary" data-a="connect">Connect account</button>'}
        <button class="btn" data-a="reset">Sign out</button>
      </div>
      <p class="muted">Removing the key here only deletes it from this browser. To revoke it on the network, remove it in any client that manages your keys, or call KeyRegistry.remove from your custody address.</p>
    </div>`);
  s.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).dataset.a;
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
    if (parts[0] === 'setup') return viewSetup();
    return await viewFeed();
  } catch (e) {
    $view.innerHTML = `<div class="card err">${esc((e as Error).message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
nodeStatus();
setInterval(nodeStatus, 15000);
renderMe();
route();
