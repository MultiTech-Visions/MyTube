/**
 * MyTube UI. Vanilla JS, no framework.
 *
 * The queue you see is YOUR queue, stored on the phone. The TV is told about
 * it (setPlaylist / addVideo / insertVideo / removeVideo) but can never erase
 * it: if the TV loses the queue, one tap pushes it back, resuming where the
 * last known position was.
 */
import { subscriptions as apiSubscriptions, channelVideos as apiChannelVideos, channelPage as apiChannelPage, sendFeedback as apiSendFeedback, mix as apiMix, channelInfo as apiChannelInfo } from './api.js';
import { api, feed as apiFeed, search as apiSearch, watch as apiWatch, comments as apiComments, history as apiHistory, playlists as apiPlaylists, playlist as apiPlaylist, rate as apiRate, saveOptions as apiSaveOptions, editPlaylist as apiEditPlaylist, createPlaylist as apiCreatePlaylist, sponsorSegments as apiSponsorSegments } from './api.js';
import { store, AD_DEFAULTS } from './store.js';
import { Remote, PLAYER_STATE } from './lounge.js';
import { icon } from './icons.js';
import * as debug from './debug.js';
import { media } from './media.js';

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => {
  const n = root.querySelector(sel);
  if (!n) throw new Error(`Missing element ${sel}`);
  return n;
};
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const joinMeta = (...parts) => parts.filter((p) => p && String(p).trim()).join(' • ');

let toastTimer = null;
function toast(message, { error = false, ms } = {}) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms || (error ? 7000 : 3000));
}
function showError(e) {
  if (!(e && e.logged)) debug.log('error', `${e && e.message ? e.message : String(e)}`, e && e.code ? { code: e.code, detail: e.detail } : e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : undefined);
  const code = e && e.code ? ` [${e.code}]` : '';
  toast(`${e && e.message ? e.message : String(e)}${code}`, { error: true });
}
/** Runs an async UI action and reports failures as a toast. Never swallows silently. */
const guard = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch(showError);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const ui = {
  view: 'home',
  feed: { items: [], continuation: null, loading: false, loaded: false, signedIn: null, ytDown: null },
  search: { q: '', items: [], continuation: null, loading: false },
  watch: { videoId: null, data: null, loading: false, related: [], relatedContinuation: null },
  npTab: 'queue',
  npOpen: false,
  descOpen: false,
  /** comments for the current video: { videoId, items, continuation, loading, replies: Map } */
  comments: null,
  /** Library tab: which list is shown and its paging state */
  library: { tab: 'WL', items: [], continuation: null, loading: false, loaded: false, playlist: null, playlists: [] },
  /** Save sheet: { video, playlists:[...] } */
  save: null,
  sheetVideo: null,
  scrubbing: false,
  /** true once THIS remote started the TV's playlist (queue commands are ignored otherwise on Xbox). */
  owned: false,
  /** local order changed since it was last pushed to the TV */
  stale: false,
};
const watchCache = new Map();

const remote = new Remote({
  deviceId: store.deviceId,
  getDeviceName: () => store.settings.deviceName,
  getScreen: () => store.settings.screen,
  getAds: () => store.settings.ads,
  getQueue: () => store.queue.items.map((it) => it.videoId),
  setScreen: (screen) => {
    store.settings.screen = screen;
    store.saveSettings();
    renderTvView();
  },
});

// ---------------------------------------------------------------------------
// Static icons
// ---------------------------------------------------------------------------
for (const n of document.querySelectorAll('[data-icon]')) n.innerHTML = icon(n.dataset.icon);
$('#btn-refresh').innerHTML = icon('refresh');
$('#btn-more').innerHTML = icon('more');
$('#search-form button').innerHTML = icon('search');
$('#mini-next').innerHTML = icon('next');
$('#np-close').innerHTML = icon('down');
$('#np-prev').innerHTML = icon('prev');
$('#np-next').innerHTML = icon('next');
$('#np-back').innerHTML = icon('back10');
$('#np-fwd').innerHTML = icon('fwd10');
$('#debug-close').innerHTML = icon('close');
$('#library-back').innerHTML = icon('back');
$('#save-close').innerHTML = icon('close');

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showView(name) {
  ui.view = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const b of document.querySelectorAll('.navbtn')) b.classList.toggle('active', b.dataset.view === name);
  $('#btn-refresh').hidden = name !== 'home';
  $('#btn-more').hidden = name !== 'home';
  if (name === 'home' && !ui.feed.loaded) loadFeed(true).catch(showError);
  if (name === 'search') setTimeout(() => $('#search-input').focus(), 50);
  if (name === 'queue') renderQueue();
  if (name === 'tv') renderTvView();
  if (name === 'tune') renderTuneView();
  if (name === 'library' && !ui.library.loaded) loadLibrary(true).catch(showError);
  if (name === 'subs' && !SUBS.loaded) loadSubs(true).catch(showError);
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('.navbtn')) b.addEventListener('click', () => showView(b.dataset.view));
$('#brand').addEventListener('click', () => showView('home'));
$('#tvchip').addEventListener('click', () => showView('tv'));
$('#btn-refresh').addEventListener('click', guard(() => loadFeed(true)));
$('#btn-more').addEventListener('click', guard(moreFeed));

/** "Add more videos": about 20 more, from YouTube's feed and MyTube's own picks in the set mix. */
async function moreFeed() {
  const TARGET = 20; // new videos per tap
  const MAX_REQUESTS = 6;
  const f = ui.feed;
  if (f.loading) return;
  f.loading = true;
  $('#btn-more').disabled = true;
  $('#feed-loading').hidden = false;
  let added = 0;
  let requests = 0;
  try {
    while (added < TARGET && requests < MAX_REQUESTS) {
      requests += 1;
      const fresh = await feedPage({ reset: false, freshBatch: true });
      f.items = f.items.concat(fresh);
      added += fresh.length;
      renderFeedList();
      if (fresh.length === 0 && f.ytDown && MIX.dry) break;
    }
    toast(added ? `Added ${added} videos` : 'Nothing new right now. Try again in a minute.');
  } finally {
    f.loading = false;
    $('#btn-more').disabled = false;
    $('#feed-loading').hidden = true;
  }
}

/** Feed cards plus the "Add more videos" button at the bottom. */
function renderFeedList() {
  renderList($('#feed-list'), visibleFeed());
  if (store.profiles.list.length > 1) $('#feed-list').prepend(profileChips());
  if (ui.feed.items.length) $('#feed-list').append(el('button', { class: 'btn ghost', style: 'margin:8px 16px 16px', onclick: guard(moreFeed) }, 'Add more videos'));
}

// ---------------------------------------------------------------------------
// Video cards
// ---------------------------------------------------------------------------
const PICK_LABEL = { hearted: 'MyTube: like a video you hearted ♥', related: 'MyTube: like what you watched', channel: 'MyTube: channel you watch', keyword: 'MyTube: your keywords', explore: 'MyTube: explore' };
function card(v, { compact = false } = {}) {
  const sub = joinMeta(v.channel, v.views, v.published, v.pick ? PICK_LABEL[v.pick] : '');
  const node = el(
    'button',
    { class: 'card', type: 'button', onclick: () => { if (!swipe.justSwiped) openSheet(v); } },
    el('div', { class: 'thumb' }, el('img', { src: v.thumbnail, alt: '', loading: 'lazy' }), v.duration ? el('span', { class: `dur${v.isLive ? ' live' : ''}` }, v.duration) : null),
    el(
      'div',
      { class: 'card-text' },
      v.channelId
        ? el('img', {
            class: 'card-avatar',
            src: v.channelAvatar || '',
            alt: v.channel,
            loading: 'lazy',
            role: 'button',
            onclick: (e) => {
              e.stopPropagation();
              openChannel({ channelId: v.channelId, title: v.channel, avatar: v.channelAvatar || '' }).catch(showError);
            },
          })
        : null,
      el('div', {}, el('div', { class: 'card-title' }, v.title), el('div', { class: 'card-sub' }, sub))
    )
  );
  cardVideo.set(node, v);
  markCard(node, v);
  return node;
}

/** Badge on a card when its video is already in the queue (or playing now). */
function markCard(node, v) {
  const idx = Q.items.findIndex((it) => it.videoId === v.videoId);
  const playing = idx !== -1 && idx === Q.currentIndex && remote.player.videoId === v.videoId;
  const state = idx === -1 ? '' : playing ? 'playing' : 'queued';
  const key = state ? `${state}:${idx}` : '';
  if (node.dataset.q === key) return;
  node.dataset.q = key;
  node.classList.toggle('inqueue', Boolean(state));
  const thumb = node.querySelector('.thumb');
  const old = thumb.querySelector('.qbadge');
  if (old) old.remove();
  if (state) thumb.append(el('span', { class: `qbadge ${state}` }, state === 'playing' ? '▶ Playing' : `In queue · #${idx + 1}`));
}
/** Re-marks every card on screen; cheap (only touches cards whose state changed). */
function markAllCards() {
  for (const node of document.querySelectorAll('.card')) {
    const v = cardVideo.get(node);
    if (v) markCard(node, v);
  }
}
const cardVideo = new WeakMap();

/**
 * After a page loads, keep loading while the end-of-list marker is still on
 * (or near) the screen. An IntersectionObserver only fires when the marker
 * moves in or out of view, so a short page that leaves it visible would
 * otherwise never ask for more.
 */
function stillNearEnd(sentinelId) {
  const r = document.getElementById(sentinelId).getBoundingClientRect();
  return r.top < window.innerHeight + 600;
}
function fillIfShort(sentinelId, viewName, hasMore, loadMore) {
  requestAnimationFrame(() => {
    if (ui.view === viewName && hasMore() && stillNearEnd(sentinelId)) loadMore().catch(showError);
  });
}

function renderList(container, items) {
  container.replaceChildren(...items.map((v) => card(v)));
}

// ---------------------------------------------------------------------------
// Home feed
// ---------------------------------------------------------------------------
// MyTube's own picks (server: lib/mix.js), blended into Home. `pool` holds picks not shown yet.
const MIX = { pool: [], dry: false };
const YT_DOWN_CODES = new Set(['COOKIES_REJECTED', 'SIGN_IN_REQUIRED', 'RATE_LIMITED']);

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/**
 * What to ask the server about (all tailored in the Tune tab): the latest watched video plus
 * random recent ones, pinned channels, channels watched most, a subscription, and keywords.
 * Blocked channels are never seeds.
 */
function mixSeeds() {
  const T = store.taste;
  const blocked = new Set(T.blocked);
  const plays = T.plays.filter((p) => !blocked.has(p.channelId));
  // Hearted videos lead: up to three of them per rebuild, and then fewer ordinary plays.
  const hearts = shuffled(T.hearts).slice(0, 3).map((h) => h.videoId);
  let videos = plays.length ? [plays[0].videoId, ...shuffled(plays.slice(1, 15)).slice(0, 2).map((p) => p.videoId)] : [];
  videos = videos.filter((id) => !hearts.includes(id)).slice(0, hearts.length ? 1 : 3);
  const excluded = new Set(T.excluded.map((x) => x.videoId));
  if (videos.length === 0 && T.plays.length === 0 && hearts.length === 0) videos = shuffled([...Q.items.map((it) => it.videoId), ...Object.keys(store.videos)].filter((id) => !excluded.has(id))).slice(0, 3);
  const channels = shuffled(T.pinned).slice(0, 2);
  const top = channelStats().filter((c) => c.plays > 0 && !blocked.has(c.channelId) && !channels.includes(c.channelId)).slice(0, 8).map((c) => c.channelId);
  channels.push(...shuffled(top).slice(0, channels.length ? 1 : 2));
  const sub = shuffled(T.subs.filter((id) => !channels.includes(id) && !blocked.has(id)))[0];
  if (T.useSubs && sub && channels.length < 4) channels.push(sub);
  return { hearts, videos: [...new Set(videos)], channels, keywords: shuffled(T.keywords).slice(0, 2) };
}
/** Every channel this phone knows, most played first: [{ channelId, name, plays, subscribed, pinned, blocked }]. */
function channelStats() {
  const T = store.taste;
  const counts = new Map();
  for (const p of T.plays) if (p.channelId) counts.set(p.channelId, (counts.get(p.channelId) || 0) + 1);
  const ids = new Set([...counts.keys(), ...T.subs, ...T.pinned, ...T.blocked]);
  return [...ids]
    .map((channelId) => ({ channelId, name: T.names[channelId] || channelId, named: Boolean(T.names[channelId]), avatar: T.avatars[channelId] || '', plays: counts.get(channelId) || 0, subscribed: T.subs.includes(channelId), pinned: T.pinned.includes(channelId), blocked: T.blocked.includes(channelId) }))
    .sort((x, y) => y.plays - x.plays || x.name.localeCompare(y.name));
}
/** False for a pick from a blocked channel, a video marked "don't use", or with a blocked word in its title or channel name. */
function pickAllowed(v) {
  const T = store.taste;
  if (v.channelId && T.blocked.includes(v.channelId)) return false;
  if (T.excluded.some((x) => x.videoId === v.videoId)) return false;
  const text = `${v.title} ${v.channel}`.toLowerCase();
  return !T.blockedWords.some((w) => text.includes(w.toLowerCase()));
}
/** `shown`: the videos already on Home (empty on a fresh load, so a rebuild may show them again). */
async function refillMix(shown) {
  const seeds = mixSeeds();
  if (seeds.hearts.length + seeds.videos.length + seeds.channels.length + seeds.keywords.length === 0) {
    MIX.dry = true;
    debug.log('app', 'own picks: nothing watched or queued on this phone yet and no keywords, so no seeds');
    return;
  }
  const res = await apiMix(seeds);
  const known = new Set([...shown.map((v) => v.videoId), ...MIX.pool.map((v) => v.videoId), ...store.hidden, ...store.taste.plays.map((p) => p.videoId), ...store.taste.hearts.map((h) => h.videoId), ...Q.items.map((it) => it.videoId)]);
  const fresh = res.items.filter((v) => !known.has(v.videoId) && pickAllowed(v));
  MIX.pool.push(...fresh);
  if (fresh.length === 0) MIX.dry = true;
  debug.log('app', `own picks: ${res.items.length} received, ${fresh.length} new (pool ${MIX.pool.length})`, { seeds, sources: res.sources });
}
/** `yt` with `mine` spread evenly through it. */
function blend(yt, mine) {
  if (mine.length === 0) return yt;
  const out = [];
  const every = (yt.length + mine.length) / mine.length;
  let m = 0;
  let y = 0;
  for (let i = 0; i < yt.length + mine.length; i += 1) {
    if ((m < mine.length && i >= Math.floor(m * every + every / 2)) || y >= yt.length) out.push(mine[m++]);
    else out.push(yt[y++]);
  }
  return out;
}
const feedHasMore = () => Boolean(ui.feed.continuation) || ((ui.feed.ytDown || store.taste.mix > 0) && !MIX.dry);

/**
 * One page of Home: YouTube's feed blended with MyTube's own picks at the set
 * percentage; 100 % own picks while the YouTube login is not working.
 * `freshBatch` (Add more) asks YouTube for a new first page when it has no next page.
 */
async function feedPage({ reset, freshBatch }) {
  const f = ui.feed;
  const pct = store.taste.mix;
  if (reset) {
    MIX.pool = [];
    MIX.dry = false;
    f.ytDown = store.settings.cookies ? null : 'no YouTube cookies on this phone';
  }
  // A fresh load always asks YouTube once, even at 100 % own picks, so a broken login is noticed.
  const shown = reset ? [] : f.items;
  const askYoutube = !f.ytDown && (reset || (pct < 100 && (f.continuation || freshBatch)));
  const youtube = async () => {
    if (!askYoutube) return [];
    let res;
    try {
      res = await apiFeed(reset ? null : f.continuation || null);
    } catch (e) {
      if (!YT_DOWN_CODES.has(e.code)) throw e;
      f.ytDown = e.message; // already in the log (api); own picks take over
      f.continuation = null;
      return [];
    }
    f.continuation = res.continuation;
    f.signedIn = res.signedIn;
    debug.log('app', `home feed page: ${res.items.length} videos, more: ${Boolean(res.continuation)}, signedIn: ${res.signedIn}`, res.shape);
    if (!res.signedIn) {
      f.ytDown = 'YouTube is treating your cookies as signed out';
      f.continuation = null;
      return [];
    }
    if (pct === 100) return [];
    const known = new Set([...shown.map((v) => v.videoId), ...store.hidden]);
    return res.items.filter((v) => !known.has(v.videoId));
  };
  // Both at once on a fresh load; later pages only refill the pool when it runs low.
  const wantMine = () => (f.ytDown || pct === 100 ? 20 : pct === 0 ? 0 : 10);
  const refill = async () => {
    if (wantMine() === 0 || MIX.pool.length >= wantMine() || MIX.dry) return;
    await refillMix(shown);
  };
  const [yt] = await Promise.all([youtube(), reset ? refill() : null]);
  if (f.ytDown) await refill(); // YouTube failed just now: make sure there are picks to show
  else if (!reset) await refill();
  let mineCount;
  if (f.ytDown || pct === 100) mineCount = 20;
  else if (pct === 0) mineCount = 0;
  else mineCount = yt.length ? Math.round((yt.length * pct) / (100 - pct)) : 10;
  return blend(yt, MIX.pool.splice(0, mineCount));
}

async function loadFeed(reset) {
  const f = ui.feed;
  if (f.loading) return;
  if (!reset && !feedHasMore()) return;
  f.loading = true;
  $('#feed-loading').hidden = false;
  try {
    const page = await feedPage({ reset, freshBatch: false });
    f.items = reset ? page : f.items.concat(page);
    f.loaded = true;
    renderFeedList();
    const notice = $('#feed-notice');
    if (f.ytDown) {
      notice.hidden = false;
      notice.className = 'notice warn';
      notice.replaceChildren(
        el('span', {}, `Showing MyTube's own picks only: ${f.ytDown}.`),
        el('button', { class: 'btn ghost small', onclick: () => showView('tv') }, 'Open TV tab')
      );
    } else {
      notice.hidden = true;
    }
    if (f.items.length === 0 && reset) {
      $('#feed-list').replaceChildren(el('p', { class: 'empty' }, f.ytDown ? 'Nothing to recommend yet: MyTube builds its own picks from what you play and queue here. Use Search, or add keywords in the Tune tab.' : 'YouTube returned an empty feed.'));
      if (store.profiles.list.length > 1) $('#feed-list').prepend(profileChips());
    }
  } finally {
    f.loading = false;
    $('#feed-loading').hidden = true;
  }
  fillIfShort('feed-sentinel', 'home', feedHasMore, () => loadFeed(false));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  ui.search = { q, items: [], continuation: null, loading: false };
  $('#search-list').replaceChildren();
  $('#search-input').blur();
  loadSearch(true).catch(showError);
});
async function loadSearch(first) {
  const s = ui.search;
  if (s.loading || (!first && !s.continuation)) return;
  s.loading = true;
  $('#search-loading').hidden = false;
  try {
    const res = await apiSearch(s.q, first ? null : s.continuation);
    s.items = first ? res.items : s.items.concat(res.items);
    s.continuation = res.continuation;
    renderList($('#search-list'), s.items);
    if (s.items.length === 0) $('#search-list').replaceChildren(el('p', { class: 'empty' }, `No videos found for "${s.q}".`));
  } finally {
    s.loading = false;
    $('#search-loading').hidden = true;
  }
  fillIfShort('search-sentinel', 'search', () => Boolean(s.continuation), () => loadSearch(false));
}

// Infinite scroll for both lists.
new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    if (en.target.id === 'feed-sentinel' && ui.view === 'home' && ui.feed.loaded) loadFeed(false).catch(showError);
    if (en.target.id === 'search-sentinel' && ui.view === 'search' && ui.search.q) loadSearch(false).catch(showError);
  }
}, { rootMargin: '600px' }).observe($('#feed-sentinel'));
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && ui.view === 'search' && ui.search.q) loadSearch(false).catch(showError);
}, { rootMargin: '600px' }).observe($('#search-sentinel'));

// ---------------------------------------------------------------------------
// Action sheet: Play now / Play next / Add to queue
// ---------------------------------------------------------------------------
function openSheet(v) {
  ui.sheetVideo = v;
  $('#sheet-thumb').src = v.thumbnail;
  $('#sheet-title').textContent = v.title;
  $('#sheet-sub').textContent = joinMeta(v.channel, v.duration);
  // Remove-from-recommendations options: YouTube's own ("Not interested", "Don't recommend channel")
  // when the item came with them, plus a local hide that always works.
  const fromHome = ui.view === 'home';
  const opts = (v.feedback || []).map((f) => el('button', { class: 'btn action small-action', type: 'button', onclick: guard(() => removeRecommendation(v, f)) }, el('span', { class: 'ico', html: icon('hide') }), f.label));
  if (fromHome) opts.push(el('button', { class: 'btn action small-action', type: 'button', onclick: guard(() => removeRecommendation(v, null)) }, el('span', { class: 'ico', html: icon('hide') }), 'Hide from my feed'));
  for (const pr of store.profiles.list) {
    const on = isHearted(pr.id, v.videoId);
    const many = store.profiles.list.length > 1;
    opts.push(el('button', { class: `btn action small-action${on ? ' hearted' : ''}`, type: 'button', onclick: guard(() => { toggleHeart(pr.id, v); closeSheet(); }) }, el('span', { class: 'ico', html: icon('heart') }), on ? `Hearted${many ? ` for ${pr.name}` : ''} (tap to remove)` : `Heart${many ? ` for ${pr.name}` : ' for MyTube picks'}`));
  }
  if (v.channelId) {
    const blockedNow = store.taste.blocked.includes(v.channelId);
    opts.push(el('button', { class: 'btn action small-action', type: 'button', onclick: guard(() => { setChannelFlag(v.channelId, v.channel, 'blocked', !blockedNow); closeSheet(); toast(blockedNow ? `${v.channel} is allowed in MyTube picks again` : `No more MyTube picks from ${v.channel}`); }) }, el('span', { class: 'ico', html: icon('hide') }), blockedNow ? 'Unblock channel in MyTube picks' : 'Block channel in MyTube picks'));
  }
  $('#sheet-feedback').replaceChildren(...opts);
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
}

/** Hides the video locally at once (persisted), then tells YouTube when a token is available. */
async function removeRecommendation(v, option) {
  closeSheet();
  const listId = { home: 'feed-list', subs: 'subs-list', search: 'search-list' }[ui.view] || 'feed-list';
  store.hide(v.videoId);
  rerenderList(listId);
  debug.log('app', `removed recommendation ${v.videoId}${option ? ` via "${option.label}"` : ' (local hide)'}`);
  offerUndo({
    text: `${option ? option.label : 'Hidden'}: ${v.title}`,
    revert: () => {
      store.unhide(v.videoId);
      rerenderList(listId);
      debug.log('app', `undo: restored ${v.videoId}`);
    },
    commit: option ? (opts) => apiSendFeedback(option.token, opts) : null,
    commitLabel: option ? option.label : null,
  });
}

/** Re-draws the list a card came from (after a hide or an undo). */
function rerenderList(listId) {
  if (listId === 'feed-list') renderFeedList();
  else if (listId === 'subs-list') renderSubs();
  else if (listId === 'search-list') renderList($('#search-list'), ui.search.items.filter((v) => !store.hidden.includes(v.videoId)));
  else if (listId === 'np-related') renderRelated();
  else if (listId === 'chan-list') renderChannelList();
  else if (listId === 'library-list') renderLibrary();
}

// ---------------------------------------------------------------------------
// Undo banner: the removal shows at once, the real action is held for 10 s
// ---------------------------------------------------------------------------
const UNDO_MS = 10000;
let pendingUndo = null; // { revert, commit, commitLabel, timer }

/**
 * Shows "Removed … · Undo" for 10 s. Undo runs `revert` (local only, always
 * works). When the time is up, or another removal replaces this one, or the
 * app goes to the background, `commit` sends the real action to YouTube.
 */
function offerUndo({ text, revert, commit, commitLabel }) {
  if (pendingUndo) commitPending('replaced');
  pendingUndo = { revert, commit, commitLabel, timer: setTimeout(() => commitPending('timeout'), UNDO_MS) };
  const box = $('#undo');
  $('#undo-text').textContent = text;
  const fill = $('#undo-fill');
  fill.classList.remove('run');
  box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => fill.classList.add('run')));
}
function hideUndoBanner() {
  $('#undo').hidden = true;
}
/** Sends the held action (if any). `keepalive` is used when the page may be going away. */
function commitPending(reason, { keepalive = false } = {}) {
  const p = pendingUndo;
  if (!p) return;
  pendingUndo = null;
  clearTimeout(p.timer);
  hideUndoBanner();
  if (!p.commit) return;
  debug.log('app', `undo window over (${reason}); sending ${p.commitLabel} to YouTube`);
  p.commit({ keepalive }).catch(showError);
}
$('#undo-btn').addEventListener('click', () => {
  const p = pendingUndo;
  if (!p) return;
  pendingUndo = null;
  clearTimeout(p.timer);
  hideUndoBanner();
  try {
    p.revert();
    toast('Restored');
  } catch (e) {
    showError(e);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') commitPending('app hidden', { keepalive: true });
});
function visibleFeed() {
  const hidden = new Set(store.hidden);
  return ui.feed.items.filter((v) => !hidden.has(v.videoId));
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  ui.sheetVideo = null;
}
$('#sheet-backdrop').addEventListener('click', () => {
  closeSheet();
  if (ui.save) closeSaveSheet();
});
$('#sheet-cancel').addEventListener('click', closeSheet);
$('#sheet-playnow').addEventListener('click', guard(async () => { const v = ui.sheetVideo; closeSheet(); await playNow(v); }));
$('#sheet-playnext').addEventListener('click', guard(async () => { const v = ui.sheetVideo; closeSheet(); await playNext(v); }));
$('#sheet-addqueue').addEventListener('click', guard(async () => { const v = ui.sheetVideo; closeSheet(); await addToQueue(v); }));
$('#sheet-save').addEventListener('click', guard(async () => { const v = ui.sheetVideo; closeSheet(); await openSaveSheet(v); }));

// ---------------------------------------------------------------------------
// Save to Watch later / playlist
// ---------------------------------------------------------------------------
async function openSaveSheet(v) {
  ui.save = { video: v, playlists: null };
  const sheet = $('#save-sheet');
  $('#save-video').replaceChildren(el('img', { src: v.thumbnail, alt: '' }), el('div', {}, el('div', { class: 'sheet-title' }, v.title), el('div', { class: 'sheet-sub' }, v.channel)));
  $('#save-list').replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' })));
  sheet.hidden = false;
  $('#sheet-backdrop').hidden = false;
  try {
    const res = await apiSaveOptions(v.videoId);
    if (!ui.save || ui.save.video !== v) return;
    ui.save.playlists = res.playlists;
    renderSaveList();
  } catch (e) {
    closeSaveSheet();
    throw e;
  }
}
function closeSaveSheet() {
  $('#save-sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  ui.save = null;
}
function renderSaveList() {
  const list = $('#save-list');
  const rows = ui.save.playlists.map((pl) =>
    el(
      'button',
      { class: `save-row${pl.contains ? ' on' : ''}${pl.busy ? ' busy' : ''}`, type: 'button', disabled: pl.busy, onclick: guard(() => toggleSave(pl)) },
      el('span', { class: 'box', html: pl.contains ? icon('check') : '' }),
      el('span', { class: 'save-title' }, pl.title, el('div', { class: 'save-sub' }, pl.playlistId === 'WL' ? 'Watch later' : pl.privacy.toLowerCase()))
    )
  );
  list.replaceChildren(...rows);
  if (rows.length === 0) list.replaceChildren(el('p', { class: 'empty' }, 'No playlists yet.'));
}
async function toggleSave(pl) {
  const v = ui.save.video;
  pl.busy = true;
  renderSaveList();
  try {
    await apiEditPlaylist(pl.playlistId, v.videoId, pl.contains ? 'remove' : 'add');
    pl.contains = !pl.contains;
    debug.log('app', `${pl.contains ? 'added to' : 'removed from'} ${pl.title} (${pl.playlistId}): ${v.videoId}`);
    toast(`${pl.contains ? 'Added to' : 'Removed from'} ${pl.title}`);
    if (pl.playlistId === 'WL' || (ui.library.playlist && ui.library.playlist.playlistId === pl.playlistId) || ui.library.tab === 'playlists') ui.library.loaded = false;
  } finally {
    pl.busy = false;
    if (ui.save) renderSaveList();
  }
}
$('#save-close').addEventListener('click', closeSaveSheet);
$('#save-new').addEventListener('click', guard(async () => {
  const v = ui.save.video;
  const title = prompt('Name for the new playlist');
  if (!title || !title.trim()) return;
  const res = await apiCreatePlaylist(title.trim(), v.videoId);
  debug.log('app', `created playlist ${res.playlistId} "${title.trim()}" with ${v.videoId}`);
  toast(`Created "${title.trim()}" and saved the video`);
  ui.library.loaded = false;
  const opts = await apiSaveOptions(v.videoId);
  if (ui.save && ui.save.video === v) {
    ui.save.playlists = opts.playlists;
    renderSaveList();
  }
}));

// ---------------------------------------------------------------------------
// Queue model (local truth) + TV sync
// ---------------------------------------------------------------------------
const Q = store.queue;
const queueItem = (v) => ({ videoId: v.videoId, title: v.title, channel: v.channel, duration: v.duration, thumbnail: v.thumbnail });
const currentItem = () => (Q.currentIndex >= 0 && Q.currentIndex < Q.items.length ? Q.items[Q.currentIndex] : null);

function removeDuplicate(videoId) {
  const i = Q.items.findIndex((it) => it.videoId === videoId);
  if (i === -1) return;
  if (i === Q.currentIndex) throw new Error('That video is already playing');
  Q.items.splice(i, 1);
  if (i < Q.currentIndex) Q.currentIndex -= 1;
}
function insertAfterCurrent(item) {
  const at = Q.currentIndex >= 0 ? Q.currentIndex + 1 : 0;
  Q.items.splice(at, 0, item);
  return at;
}
function saveQueue() {
  store.saveQueue();
  markAllCards();
  renderQueue();
  renderMini();
  if (ui.npOpen) renderNowPlaying();
}

/** Resume position for the item at `index`: the last known position if it is the same video, else 0. */
function resumeTimeFor(index) {
  const it = Q.items[index];
  const lk = store.lastKnown;
  return it && lk.videoId === it.videoId && lk.duration - lk.currentTime > 5 ? lk.currentTime : 0;
}

/** setPlaylist with the whole local queue. The one call that makes this remote the queue's owner. */
/**
 * YouTube tends to ignore the currentTime of a reload and restore its own saved
 * position (often 10-20 s stale), so a non-zero start is enforced with a seekTo
 * once the TV reports the video playing.
 */
let pendingSeek = null;
function armSeek(videoId, seconds) {
  pendingSeek = { videoId, seconds, until: Date.now() + 25000 };
}
function applyPendingSeek() {
  if (!pendingSeek) return;
  if (Date.now() > pendingSeek.until) {
    pendingSeek = null;
    return;
  }
  const pl = remote.player;
  if (pl.videoId !== pendingSeek.videoId || pl.state !== PLAYER_STATE.PLAYING || remote.ad.active) return;
  const want = pendingSeek.seconds;
  pendingSeek = null;
  if (Math.abs(pl.currentTime - want) < 3) return; // the TV honoured it
  debug.log('app', `forcing seek to ${Math.floor(want)}s (TV resumed at ${Math.floor(pl.currentTime)}s)`);
  remote.seekTo(want).catch(showError);
}

async function pushQueue(index, seconds) {
  if (Q.items.length === 0) throw new Error('The queue is empty');
  if (!remote.connected) throw new Error('Not connected to the TV. Open the TV tab to connect.');
  debug.log('app', `pushQueue: ${Q.items.length} videos, start #${index + 1} at ${Math.floor(seconds)}s`, Q.items.map((it) => it.videoId));
  if (seconds > 0) armSeek(Q.items[index].videoId, seconds);
  else pendingSeek = null;
  await remote.setPlaylist(Q.items.map((it) => it.videoId), index, seconds);
  ui.owned = true;
  ui.stale = false;
  Q.currentIndex = index;
  Q.listId = null; // learned from the TV's next playlistModified
  saveQueue();
}

/** Is the TV currently playing from a list this remote created? */
function tvQueueIsOurs() {
  return ui.owned && remote.player.videoId !== null;
}

async function playNow(v) {
  store.recordPlay(v.videoId, v.channelId ? v.channelId : null, v.channel ? v.channel : null, v.channelAvatar ? v.channelAvatar : null); // a signal for MyTube's own picks
  const t0 = performance.now();
  debug.log('app', `playNow ${v.videoId}`, { title: v.title, connected: remote.connected, owned: ui.owned });
  store.rememberVideo(v);
  removeDuplicate(v.videoId);
  const at = insertAfterCurrent(queueItem(v));
  Q.currentIndex = at;
  saveQueue();
  toast(`Starting on TV: ${v.title}`);
  let connectMs = 0;
  if (!remote.connected && store.settings.screen) {
    // e.g. after "Done — shut down"
    await remote.connect();
    connectMs = Math.round(performance.now() - t0);
  }
  if (!remote.connected) {
    toast('Queued. Connect to the TV to play it.');
    return;
  }
  await pushQueue(at, 0);
  debug.log('app', `playNow sent in ${Math.round(performance.now() - t0)} ms${connectMs ? ` (of which reconnect ${connectMs} ms)` : ''}`);
}

/** Wakes the server while you browse, so the first button press does not pay for a cold start. */
function prewarm() {
  fetch('/api/ping', { cache: 'no-store' }).catch(() => {});
}

async function playNext(v) {
  store.recordPlay(v.videoId, v.channelId ? v.channelId : null, v.channel ? v.channel : null, v.channelAvatar ? v.channelAvatar : null); // a signal for MyTube's own picks
  debug.log('app', `playNext ${v.videoId}`, { title: v.title, connected: remote.connected, owned: ui.owned, tvVideo: remote.player.videoId });
  store.rememberVideo(v);
  if (remote.player.videoId === v.videoId) throw new Error('That video is already playing');
  removeDuplicate(v.videoId);
  const at = insertAfterCurrent(queueItem(v));
  saveQueue();
  await syncAddition(v, at, 'insertVideo');
  toast(`Up next: ${v.title}`);
}

async function addToQueue(v) {
  store.recordPlay(v.videoId, v.channelId ? v.channelId : null, v.channel ? v.channel : null, v.channelAvatar ? v.channelAvatar : null); // a signal for MyTube's own picks
  debug.log('app', `addToQueue ${v.videoId}`, { title: v.title, connected: remote.connected, owned: ui.owned, tvVideo: remote.player.videoId });
  store.rememberVideo(v);
  if (remote.player.videoId === v.videoId) throw new Error('That video is already playing');
  removeDuplicate(v.videoId);
  Q.items.push(queueItem(v));
  saveQueue();
  await syncAddition(v, Q.items.length - 1, 'addVideo');
  toast(`Added to queue: ${v.title}`);
}

/**
 * Tells the TV about a newly inserted item.
 *  - queue is ours and something is playing  -> incremental addVideo/insertVideo (no interruption)
 *  - TV is playing something we did not start -> take over: push our queue at the current video/time
 *  - TV idle                                  -> start the queue where it left off
 *  - not connected                            -> local only
 */
async function syncAddition(v, index, command) {
  if (!remote.connected) return;
  const pl = remote.player;
  if (tvQueueIsOurs()) {
    if (ui.stale) {
      await pushQueue(Q.currentIndex, remote.estimatedTime());
      return;
    }
    await remote[command === 'insertVideo' ? 'insertVideo' : 'addVideo'](v.videoId);
    return;
  }
  if (pl.videoId) {
    // The TV is playing something this remote did not start; adopt it so the queue continues after it.
    debug.log('app', `taking over the TV queue (TV is playing ${pl.videoId}, not started by us)`);
    let cur = Q.items.findIndex((it) => it.videoId === pl.videoId);
    if (cur === -1) {
      const known = store.video(pl.videoId);
      Q.items.splice(0, 0, known ? { ...known } : { videoId: pl.videoId, title: pl.videoId, channel: '', duration: '', thumbnail: `https://i.ytimg.com/vi/${pl.videoId}/mqdefault.jpg` });
      cur = 0;
    }
    await pushQueue(cur, remote.estimatedTime());
    toast('Took over the TV queue');
    return;
  }
  const start = Q.currentIndex >= 0 && Q.currentIndex < Q.items.length ? Q.currentIndex : index;
  await pushQueue(start, resumeTimeFor(start));
}

async function removeFromQueue(index) {
  const it = Q.items[index];
  if (!it) return;
  debug.log('app', `remove #${index + 1} ${it.videoId}`, { owned: ui.owned });
  if (index === Q.currentIndex && remote.player.videoId === it.videoId) throw new Error('That video is playing now. Use Next to skip it.');
  Q.items.splice(index, 1);
  if (index < Q.currentIndex) Q.currentIndex -= 1;
  if (Q.currentIndex >= Q.items.length) Q.currentIndex = Q.items.length - 1;
  saveQueue();
  if (remote.connected && tvQueueIsOurs()) await remote.removeVideo(it.videoId);
}

async function jumpTo(index) {
  debug.log('app', `jump to #${index + 1}`);
  if (!remote.connected) {
    Q.currentIndex = index;
    saveQueue();
    toast('Connect to the TV to play it.');
    return;
  }
  await pushQueue(index, 0);
}

function move(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= Q.items.length) return;
  const [it] = Q.items.splice(index, 1);
  Q.items.splice(j, 0, it);
  if (Q.currentIndex === index) Q.currentIndex = j;
  else if (Q.currentIndex === j) Q.currentIndex = index;
  ui.stale = tvQueueIsOurs();
  saveQueue();
}

/** Empties the local queue. The TV keeps playing whatever is on it now. */
function doClearQueue() {
  Q.items = [];
  Q.currentIndex = -1;
  ui.owned = false;
  ui.stale = false;
  saveQueue();
}
function clearQueue() {
  if (Q.items.length === 0) return;
  if (!confirm('Clear the whole queue? The TV keeps playing the current video.')) return;
  debug.log('app', 'queue cleared by user');
  doClearQueue();
}

/** The TV told us what it is playing: line our index up with it. */
function syncCurrentFromTv() {
  const pl = remote.player;
  if (!pl.videoId) return;
  const i = Q.items.findIndex((it) => it.videoId === pl.videoId);
  if (i !== -1) {
    if (Q.currentIndex !== i) {
      Q.currentIndex = i;
      saveQueue();
    }
    return;
  }
  // Something we did not queue is playing (autoplay or picked on the TV). Keep it in the list so the history is visible.
  debug.log('app', `TV is playing ${pl.videoId}, which is not in the local queue; inserting it`, { tvQueue: remote.tvQueue });
  const known = store.video(pl.videoId);
  const item = known ? { ...known } : { videoId: pl.videoId, title: 'Loading…', channel: '', duration: '', thumbnail: `https://i.ytimg.com/vi/${pl.videoId}/mqdefault.jpg` };
  item.fromTv = true;
  Q.currentIndex = insertAfterCurrent(item);
  saveQueue();
}

function rememberPosition() {
  const pl = remote.player;
  if (!pl.videoId || remote.ad.active) return;
  store.lastKnown = { videoId: pl.videoId, currentTime: remote.estimatedTime(), duration: pl.duration, at: Date.now() };
  store.saveLastKnown();
}

// ---------------------------------------------------------------------------
// Queue rendering
// ---------------------------------------------------------------------------
function queueRow(it, i) {
  const isCurrent = i === Q.currentIndex;
  const sub = joinMeta(it.channel, it.duration);
  return el(
    'div',
    { class: `qrow${isCurrent ? ' current' : ''}` },
    el('div', { class: 'qidx' }, isCurrent && remote.player.state === PLAYER_STATE.PLAYING ? el('span', { class: 'playing-eq' }) : String(i + 1)),
    el(
      'button',
      { class: 'qmain', type: 'button', onclick: guard(() => jumpTo(i)) },
      el('div', { class: 'thumb' }, el('img', { src: it.thumbnail, alt: '', loading: 'lazy' })),
      el('div', { class: 'card-text' }, el('div', {}, el('div', { class: 'card-title' }, it.title), el('div', { class: 'card-sub' }, sub)))
    ),
    el(
      'div',
      { class: 'qbtns' },
      el('button', { class: 'iconbtn', 'aria-label': 'Move up', html: icon('up'), disabled: i === 0, onclick: () => move(i, -1) }),
      el('button', { class: 'iconbtn', 'aria-label': 'Move down', html: icon('down'), disabled: i === Q.items.length - 1, onclick: () => move(i, 1) }),
      el('button', { class: 'iconbtn', 'aria-label': 'Remove', html: icon('close'), onclick: guard(() => removeFromQueue(i)) })
    )
  );
}

function renderQueue() {
  const rows = Q.items.map(queueRow);
  $('#queue-list').replaceChildren(...rows);
  $('#queue-empty').hidden = Q.items.length > 0;
  const badge = $('#queue-badge');
  const remaining = Q.currentIndex >= 0 ? Q.items.length - Q.currentIndex - 1 : Q.items.length;
  badge.hidden = remaining <= 0;
  badge.textContent = String(remaining);
  $('#btn-queue-clear').hidden = Q.items.length === 0;

  // Notices: lost / stale / not started.
  const notice = $('#queue-notice');
  const pushBtn = $('#btn-queue-push');
  const tvEmpty = remote.connected && ui.owned && remote.tvQueue.videoIds.length === 0 && !remote.player.videoId && Q.items.length > 0;
  const tvDiffers = remote.connected && ui.owned && remote.player.videoId && remote.tvQueue.videoIds.length > 0 && remote.tvQueue.videoIds.join() !== Q.items.map((it) => it.videoId).join();
  pushBtn.hidden = !(remote.connected && Q.items.length > 0);
  if (tvEmpty) {
    if (notice.hidden) debug.log('app', 'TV reports an empty queue while the phone has one — offering Restore', { local: Q.items.map((it) => it.videoId), tvQueue: remote.tvQueue });
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.replaceChildren(el('span', {}, 'The TV lost the queue. Your copy is safe here.'), el('button', { class: 'btn small', onclick: guard(restoreQueue) }, 'Restore on TV'));
  } else if (ui.stale || tvDiffers) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.replaceChildren(el('span', {}, 'This order is not on the TV yet. Pushing restarts the current video at the same position.'), el('button', { class: 'btn small', onclick: guard(() => pushQueue(Math.max(0, Q.currentIndex), remote.estimatedTime())) }, 'Push'));
  } else {
    notice.hidden = true;
  }
  if (ui.npOpen) renderNpQueue();
}
$('#btn-queue-clear').addEventListener('click', clearQueue);
$('#btn-queue-push').addEventListener('click', guard(() => pushQueue(Math.max(0, Q.currentIndex), remote.player.videoId ? remote.estimatedTime() : resumeTimeFor(Math.max(0, Q.currentIndex)))));

async function restoreQueue() {
  const index = Math.max(0, Math.min(Q.currentIndex, Q.items.length - 1));
  debug.log('app', `restoreQueue at #${index + 1}`, { lastKnown: store.lastKnown });
  await pushQueue(index, resumeTimeFor(index));
  toast('Queue restored on the TV');
}

// ---------------------------------------------------------------------------
// Mini player
// ---------------------------------------------------------------------------
function renderMini() {
  const pl = remote.player;
  const cur = pl.videoId ? (Q.items.find((it) => it.videoId === pl.videoId) || store.video(pl.videoId) || { title: ui.watch.data && ui.watch.videoId === pl.videoId ? ui.watch.data.video.title : 'Loading…', channel: '', thumbnail: `https://i.ytimg.com/vi/${pl.videoId}/mqdefault.jpg` }) : currentItem() || Q.items[0];
  const show = Boolean(cur);
  $('#mini').hidden = !show;
  document.body.classList.toggle('has-mini', show);
  if (!show) return;
  $('#mini-thumb').src = cur.thumbnail;
  $('#mini-title').textContent = cur.title;
  const stateText = !remote.connected ? 'Not connected' : !pl.videoId ? 'TV idle — tap to start the queue' : remote.ad.active ? 'Ad playing' : pl.state === PLAYER_STATE.PAUSED ? 'Paused' : pl.state === PLAYER_STATE.BUFFERING ? 'Buffering…' : remote.screenName || 'Playing on TV';
  $('#mini-sub').textContent = joinMeta(cur.channel, stateText);
  $('#mini-play').innerHTML = icon(pl.state === PLAYER_STATE.PLAYING || pl.state === PLAYER_STATE.AD ? 'pause' : 'play');
}
$('#mini').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  openNowPlaying();
});
$('#mini-play').addEventListener('click', guard(togglePlay));
$('#mini-next').addEventListener('click', guard(() => remote.next()));

async function togglePlay() {
  if (!remote.connected) throw new Error('Not connected to the TV. Open the TV tab to connect.');
  const pl = remote.player;
  if (!pl.videoId) {
    if (Q.items.length === 0) throw new Error('Queue is empty — add a video first');
    const start = Math.max(0, Math.min(Q.currentIndex, Q.items.length - 1));
    await pushQueue(start, resumeTimeFor(start));
    return;
  }
  if (pl.state === PLAYER_STATE.PLAYING || pl.state === PLAYER_STATE.AD) await remote.pause();
  else await remote.play();
}

// ---------------------------------------------------------------------------
// Now playing sheet
// ---------------------------------------------------------------------------
function openNowPlaying() {
  ui.npOpen = true;
  $('#np').hidden = false;
  document.body.style.overflow = 'hidden';
  renderNowPlaying();
}
$('#np-meta').addEventListener('click', () => {
  ui.descOpen = !ui.descOpen;
  renderDescription();
});

async function setRating(which) {
  const vid = remote.player.videoId;
  const data = vid && ui.watch.videoId === vid ? ui.watch.data : null;
  if (!data) throw new Error('Nothing is playing');
  const current = data.rating;
  const wanted = which === 'like' ? (current === 'LIKE' ? 'none' : 'like') : current === 'DISLIKE' ? 'none' : 'dislike';
  const res = await apiRate(vid, wanted);
  data.rating = res.rating;
  debug.log('app', `rated ${vid}: ${res.rating}`);
  renderActions();
  toast(res.rating === 'LIKE' ? 'Liked' : res.rating === 'DISLIKE' ? 'Disliked' : 'Rating removed');
}
$('#np-like').addEventListener('click', guard(() => setRating('like')));
// Heart the playing video for the active profile (other profiles: tap the video in a list).
$('#np-heart').addEventListener('click', guard(() => {
  const videoId = remote.player.videoId;
  if (!videoId) throw new Error('Nothing is playing');
  const known = store.video(videoId);
  toggleHeart(store.profiles.active, known ? known : { videoId });
}));
$('#np-dislike').addEventListener('click', guard(() => setRating('dislike')));
$('#np-save').addEventListener('click', guard(() => {
  const vid = remote.player.videoId;
  const data = vid && ui.watch.videoId === vid ? ui.watch.data : null;
  if (!data) throw new Error('Nothing is playing');
  return openSaveSheet({ ...data.video, duration: '' });
}));

function renderActions() {
  const vid = remote.player.videoId;
  const data = vid && ui.watch.videoId === vid ? ui.watch.data : null;
  const heart = $('#np-heart');
  heart.classList.toggle('on', Boolean(remote.player.videoId) && isHearted(store.profiles.active, remote.player.videoId));
  heart.disabled = !remote.player.videoId;
  $('#np-heart-label').textContent = store.profiles.list.length > 1 ? store.profileName() : '';
  const like = $('#np-like'), dislike = $('#np-dislike'), save = $('#np-save');
  like.disabled = dislike.disabled = save.disabled = !data;
  like.classList.toggle('on', Boolean(data && data.rating === 'LIKE'));
  dislike.classList.toggle('on', Boolean(data && data.rating === 'DISLIKE'));
  $('#np-like-count').textContent = data ? data.likeCount : '';
}

/** Turns plain text into text nodes with clickable http(s) links. */
function linkify(textValue) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m;
  while ((m = re.exec(textValue)) !== null) {
    if (m.index > last) frag.append(textValue.slice(last, m.index));
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    frag.append(el('a', { href: url, target: '_blank', rel: 'noopener' }, url));
    last = m.index + url.length;
  }
  if (last < textValue.length) frag.append(textValue.slice(last));
  return frag;
}

function renderDescription() {
  const vid = remote.player.videoId;
  const data = vid && ui.watch.videoId === vid ? ui.watch.data : null;
  const box = $('#np-desc');
  $('#np-more').hidden = !data;
  if (!data || !ui.descOpen) {
    box.hidden = true;
    $('#np-more').textContent = '…more';
    return;
  }
  $('#np-more').textContent = 'less';
  box.hidden = false;
  const textBox = $('#np-desc-text');
  textBox.replaceChildren(data.video.description ? linkify(data.video.description) : el('span', { class: 'empty' }, 'No description.'));
  const seen = new Set();
  const links = data.video.links.filter((l) => (seen.has(l.url) ? false : seen.add(l.url)));
  const list = $('#np-links');
  list.replaceChildren(
    ...(links.length ? [el('h4', {}, `Links (${links.length})`)] : []),
    ...links.map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.text.trim() && l.text.trim() !== l.url ? [l.text.trim(), el('span', {}, l.url)] : l.url))
  );
}
function closeNowPlaying() {
  ui.npOpen = false;
  $('#np').hidden = true;
  document.body.style.overflow = '';
}
// The whole header bar collapses the sheet, not just the arrow.
$('#np .np-head').addEventListener('click', closeNowPlaying);

// Swipe down to close: only when the sheet is scrolled to the top and the
// gesture starts outside the seek bar. The sheet follows the finger; release
// past 90 px (or a quick flick) closes, otherwise it springs back.
(() => {
  const sheet = $('#np');
  let startY = 0, startX = 0, dy = 0, t0 = 0, tracking = false, dragging = false;
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || sheet.scrollTop > 0 || e.target.closest('#scrub')) return;
    tracking = true;
    dragging = false;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    dy = 0;
    t0 = Date.now();
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (!dragging) {
      if (Math.abs(dy) < 10 && Math.abs(dx) < 10) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        tracking = false; // scrolling up or sideways: not ours
        return;
      }
      dragging = true;
      sheet.style.transition = 'none';
    }
    e.preventDefault();
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    const fast = dy > 40 && Date.now() - t0 < 250;
    sheet.style.transition = 'transform .18s ease-out';
    if (dy > 90 || fast) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => {
        closeNowPlaying();
        sheet.style.transition = '';
        sheet.style.transform = '';
      }, 180);
    } else {
      sheet.style.transform = '';
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
})();
$('#np-play').addEventListener('click', guard(togglePlay));
$('#np-prev').addEventListener('click', guard(() => remote.previous()));
$('#np-next').addEventListener('click', guard(() => remote.next()));
$('#np-back').addEventListener('click', guard(() => remote.seekBy(-10)));
$('#np-fwd').addEventListener('click', guard(() => remote.seekBy(10)));
$('#np-skip').addEventListener('click', guard(() => remote.skipAd()));
$('#np-dodge').addEventListener('click', guard(() => dodgeAd()));

/**
 * "Done": closes the server's TV session right away (its keep-alive stops, so
 * Cloud Run can scale to zero) and stops the phone notification. The app does
 * not auto-reconnect until you connect again or press Play now.
 */
async function shutDown() {
  ui.shutDown = true;
  debug.log('app', `shut down pressed (clearing ${Q.items.length} queued videos)`);
  doClearQueue();
  closeNowPlaying();
  media.stop();
  await remote.disconnect();
  toast('Shut down. Queue cleared, the server will sleep now.');
}
$('#np-done').addEventListener('click', guard(shutDown));
// Controller buttons on the TV (B, arrows, A), for pop-ups the playback commands cannot close.
for (const b of document.querySelectorAll('#np-pad [data-key]')) b.addEventListener('click', guard(() => remote.dpad(b.dataset.key)));
$('#np-closepop').addEventListener('click', guard(async () => {
  await remote.dpad('DOWN');
  await new Promise((r) => setTimeout(r, 400)); // let the TV move the highlight to the X first
  await remote.dpad('ENTER');
}));

// ---------------------------------------------------------------------------
// Ad strategies: auto-skip, dodge (exit + reload), mute, SponsorBlock
// ---------------------------------------------------------------------------
const adRun = { videoId: null, dodges: 0, muted: false, busy: false, autoSkipped: 0, waitTimer: null };
const ADS = () => store.settings.ads;

function adStatusText() {
  const s = ADS();
  const parts = [s.autoSkip ? 'auto-skip on' : 'auto-skip off'];
  if (s.dodge && !remote.ad.skipEnabled) {
    const left = Math.max(0, s.dodgeAfter - remote.adElapsed());
    parts.push(left > 0 ? `server dodges in ${Math.ceil(left)} s` : 'server dodging');
  }
  if (s.muteAds) parts.push('muted by server');
  return parts.join(' · ');
}

function resetAdRun(videoId) {
  if (adRun.videoId === videoId) return;
  adRun.videoId = videoId;
  adRun.dodges = 0;
  adRun.autoSkipped = 0;
}

// The ad engine itself runs on the server (lib/session.js), so it keeps
// working while this phone is asleep. The phone only shows what happens.
remote.addEventListener('ad', (e) => {
  resetAdRun(remote.player.videoId);
  if (e.detail.phase === 'start') adRun.startedAt = Date.now();
  if (ui.npOpen) renderNowPlaying();
});
remote.addEventListener('notice', (e) => toast(e.detail.message));

/** Manual dodge (overlay button): the server does the reload. */
async function dodgeAd() {
  if (!remote.connected) throw new Error('Not connected to the TV');
  adRun.busy = true;
  if (ui.npOpen) renderNowPlaying();
  try {
    await remote.dodge();
    toast('Reloading to dodge the ad');
  } finally {
    adRun.busy = false;
    if (ui.npOpen) renderNowPlaying();
  }
}
function pushAdSettings() {
  remote.updateSettings(store.settings.ads).catch(showError);
}

// --- SponsorBlock ---------------------------------------------------------
const sb = { videoId: null, segments: [], skipped: new Set() };
async function loadSponsorSegments(videoId) {
  sb.videoId = videoId;
  sb.segments = [];
  sb.skipped = new Set();
  const res = await apiSponsorSegments(videoId);
  if (sb.videoId !== videoId) return;
  sb.segments = res.segments;
  debug.log('app', `SponsorBlock: ${res.segments.length} segments for ${videoId}`, res.segments.map((x) => `${x.category} ${Math.floor(x.start)}-${Math.floor(x.end)}`));
  if (ui.npOpen) renderChapterSegments();
}
function activeSponsorSegments() {
  const cats = ADS().sponsorCategories;
  return sb.segments.filter((x) => cats.includes(x.category));
}
$('#np-autoplay').addEventListener('change', guard((e) => remote.setAutoplay(e.target.checked)));
$('#np-start').addEventListener('click', guard(() => { const s = Math.max(0, Math.min(Q.currentIndex, Q.items.length - 1)); return pushQueue(s, resumeTimeFor(s)); }));
for (const t of document.querySelectorAll('#np-tabs .tab')) {
  t.addEventListener('click', () => {
    ui.npTab = t.dataset.tab;
    renderNpTabs();
  });
}

const range = $('#scrub-range');
range.addEventListener('input', () => {
  ui.scrubbing = true;
  const t = (Number(range.value) / 1000) * remote.player.duration;
  paintScrub(t);
});
range.addEventListener('change', guard(async () => {
  const t = (Number(range.value) / 1000) * remote.player.duration;
  ui.scrubbing = false;
  await remote.seekTo(t);
}));

function paintScrub(t) {
  const d = remote.player.duration;
  const pct = d > 0 ? Math.min(100, (t / d) * 100) : 0;
  $('#scrub-fill').style.width = `${pct}%`;
  $('#scrub-knob').style.left = `${pct}%`;
  $('#np-cur').textContent = fmtTime(t);
  $('#np-dur').textContent = d > 0 ? fmtTime(d) : '–:––';
  const chapters = ui.watch.data && ui.watch.videoId === remote.player.videoId ? ui.watch.data.chapters : [];
  const cur = currentChapter(chapters, t);
  $('#np-chapter').textContent = cur ? cur.title : '';
  const bar = $('#mini-bar');
  bar.style.width = `${pct}%`;
  for (const c of document.querySelectorAll('#np-chapters .chapter')) c.classList.toggle('current', cur && Number(c.dataset.start) === cur.start);
}
function currentChapter(chapters, t) {
  let cur = null;
  for (const c of chapters) if (t >= c.start) cur = c;
  return cur;
}

function renderNowPlaying() {
  const pl = remote.player;
  const screen = store.settings.screen;
  $('#np-screen').textContent = remote.connected ? `Playing on ${remote.screenName || (screen && screen.name) || 'TV'}` : 'Not connected to a TV';
  const vid = pl.videoId;
  const data = vid && ui.watch.videoId === vid ? ui.watch.data : null;
  const item = vid ? Q.items.find((it) => it.videoId === vid) || store.video(vid) : currentItem() || Q.items[0];
  const title = data ? data.video.title : item ? item.title : vid ? 'Loading…' : 'Nothing playing';
  $('#np-title').textContent = title;
  $('#np-sub-text').textContent = data ? joinMeta(data.video.channel, data.video.views, data.video.published) : item ? joinMeta(item.channel, item.duration) : '';
  renderDescription();
  renderActions();
  $('#np-thumb').src = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : item ? item.thumbnail : '';
  $('#np-play').innerHTML = icon(pl.state === PLAYER_STATE.PLAYING || pl.state === PLAYER_STATE.AD ? 'pause' : 'play');
  $('#np-state').textContent = !remote.connected ? 'Not connected' : !vid ? 'TV idle' : pl.state === PLAYER_STATE.PAUSED ? 'Paused' : pl.state === PLAYER_STATE.BUFFERING ? 'Buffering' : pl.state === PLAYER_STATE.ENDED ? 'Ended' : '';
  $('#np-ad').hidden = !remote.ad.active;
  $('#np-skip').disabled = !remote.ad.skipEnabled;
  $('#np-ad-sub').textContent = remote.ad.skipEnabled ? (remote.ad.title ? remote.ad.title : 'Skip is available') : 'Skip becomes available in a few seconds';
  $('#np-dodge').disabled = adRun.busy || Q.currentIndex < 0;
  $('#np-ad-status').textContent = adStatusText();
  $('#np-autoplay').checked = pl.autoplayMode === 'ENABLED';
  $('#np-start').hidden = !(remote.connected && !vid && Q.items.length > 0);
  for (const b of ['#np-prev', '#np-next', '#np-back', '#np-fwd']) $(b).disabled = !remote.connected || !vid;
  range.disabled = !remote.connected || !vid || !(pl.duration > 0);
  renderChapterSegments();
  if (!ui.scrubbing) paintScrub(remote.estimatedTime());
  renderNpTabs();
}

function renderChapterSegments() {
  const track = $('#scrub-track');
  const d = remote.player.duration;
  const chapters = ui.watch.data && ui.watch.videoId === remote.player.videoId ? ui.watch.data.chapters : [];
  const marks = ADS().sponsorBlock && sb.videoId === remote.player.videoId && d > 0
    ? activeSponsorSegments().map((x) => el('div', { class: 'sb', title: x.category, style: `left:${(x.start / d) * 100}%;width:${Math.max(0.5, ((x.end - x.start) / d) * 100)}%` }))
    : [];
  if (!(d > 0) || chapters.length < 2) {
    track.replaceChildren(...marks);
    return;
  }
  track.replaceChildren(...marks, ...chapters.slice(1).map((c) => el('div', { class: 'gap', style: `left:${(c.start / d) * 100}%` })));
}

function renderNpTabs() {
  for (const t of document.querySelectorAll('#np-tabs .tab')) t.classList.toggle('active', t.dataset.tab === ui.npTab);
  $('#np-queue').hidden = ui.npTab !== 'queue';
  $('#np-related').hidden = ui.npTab !== 'related';
  $('#np-chapters').hidden = ui.npTab !== 'chapters';
  $('#np-comments').hidden = ui.npTab !== 'comments';
  $('#np-loading').hidden = !((ui.watch.loading && ui.npTab !== 'queue') || (ui.npTab === 'comments' && ui.comments && ui.comments.loading && ui.comments.items.length === 0));
  if (ui.npTab === 'queue') renderNpQueue();
  if (ui.npTab === 'related') renderRelated();
  if (ui.npTab === 'chapters') renderChapters();
  if (ui.npTab === 'comments') renderComments();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
function commentNode(c, isReply) {
  const head = el('div', { class: 'comment-head' }, el('b', {}, c.author), c.isCreator ? el('span', { class: 'creator' }, 'creator') : null, el('span', {}, c.published), c.hearted ? el('span', { title: 'Hearted by the creator' }, '❤') : null);
  const meta = el('div', { class: 'comment-meta' }, c.likes ? el('span', {}, `👍 ${c.likes}`) : null);
  const body = el('div', { class: 'comment-body' }, c.pinned ? el('div', { class: 'comment-pinned' }, c.pinned) : null, head, el('div', { class: 'comment-text' }, linkify(c.text)), meta);
  const node = el('div', { class: `comment${isReply ? ' reply' : ''}` }, el('img', { class: 'comment-avatar', src: c.authorAvatar, alt: '', loading: 'lazy' }), body);
  if (!isReply && c.repliesContinuation) {
    const state = ui.comments.replies.get(c.commentId);
    const btn = el('button', { type: 'button', onclick: guard(() => toggleReplies(c)) }, state && state.open ? 'Hide replies' : `${c.replyCount || ''} replies`.trim());
    meta.append(btn);
    if (state && state.open) {
      const wrap = el('div', {});
      wrap.append(...state.items.map((r) => commentNode(r, true)));
      if (state.continuation) wrap.append(el('button', { class: 'btn ghost small', style: 'margin:4px 16px 8px 56px', onclick: guard(() => loadReplies(c, true)) }, state.loading ? 'Loading…' : 'More replies'));
      return el('div', {}, node, wrap);
    }
  }
  return node;
}

function renderComments() {
  const box = $('#np-comments');
  const vid = remote.player.videoId;
  if (!vid) {
    box.replaceChildren(el('p', { class: 'empty' }, 'Comments appear once something is playing.'));
    return;
  }
  const data = ui.watch.videoId === vid ? ui.watch.data : null;
  if (!data) {
    box.replaceChildren();
    return;
  }
  if (!ui.comments || ui.comments.videoId !== vid) {
    ui.comments = { videoId: vid, items: [], continuation: data.commentsContinuation, loading: false, replies: new Map() };
    if (!data.commentsContinuation) {
      box.replaceChildren(el('p', { class: 'empty' }, 'Comments are turned off for this video.'));
      return;
    }
    loadComments().catch(showError);
    return;
  }
  const c = ui.comments;
  const nodes = c.items.map((it) => commentNode(it, false));
  if (c.continuation) nodes.push(el('button', { class: 'btn ghost', onclick: guard(loadComments) }, c.loading ? 'Loading…' : 'More comments'));
  if (c.items.length === 0 && !c.loading) nodes.push(el('p', { class: 'empty' }, 'No comments.'));
  box.replaceChildren(...nodes);
}

async function loadComments() {
  const c = ui.comments;
  if (!c || c.loading || !c.continuation) return;
  c.loading = true;
  renderNpTabs();
  try {
    const res = await apiComments(c.continuation);
    if (ui.comments !== c) return; // video changed meanwhile
    c.items = c.items.concat(res.items);
    c.continuation = res.continuation;
  } finally {
    c.loading = false;
    if (ui.comments === c && ui.npOpen && ui.npTab === 'comments') renderNpTabs();
  }
}

async function toggleReplies(comment) {
  const state = ui.comments.replies.get(comment.commentId);
  if (state && state.open) {
    state.open = false;
    renderComments();
    return;
  }
  if (state) {
    state.open = true;
    renderComments();
    return;
  }
  await loadReplies(comment, false);
}

async function loadReplies(comment, more) {
  let state = ui.comments.replies.get(comment.commentId);
  if (!state) {
    state = { open: true, items: [], continuation: comment.repliesContinuation, loading: false };
    ui.comments.replies.set(comment.commentId, state);
  }
  if (state.loading || !state.continuation) return;
  state.loading = true;
  renderComments();
  try {
    const res = await apiComments(state.continuation);
    state.items = state.items.concat(res.items);
    state.continuation = res.continuation;
  } finally {
    state.loading = false;
    renderComments();
  }
}
function renderNpQueue() {
  const list = $('#np-queue');
  list.replaceChildren(...Q.items.map(queueRow));
  if (Q.items.length === 0) list.replaceChildren(el('p', { class: 'empty' }, 'Queue is empty.'));
}
function renderRelated() {
  const list = $('#np-related');
  const data = ui.watch.data && ui.watch.videoId === remote.player.videoId ? ui.watch.data : null;
  if (!remote.player.videoId) {
    list.replaceChildren(el('p', { class: 'empty' }, 'Related videos appear once something is playing.'));
    return;
  }
  if (!data) {
    list.replaceChildren();
    return;
  }
  const items = ui.watch.related.map((v) => card(v, { compact: true }));
  if (ui.watch.relatedContinuation) items.push(el('button', { class: 'btn ghost', style: 'margin:8px 16px', onclick: guard(loadMoreRelated) }, 'Show more'));
  list.replaceChildren(...items);
}
function renderChapters() {
  const box = $('#np-chapters');
  const data = ui.watch.data && ui.watch.videoId === remote.player.videoId ? ui.watch.data : null;
  if (!data) {
    box.replaceChildren(remote.player.videoId ? el('span') : el('p', { class: 'empty' }, 'Chapters appear once something is playing.'));
    return;
  }
  if (data.chapters.length === 0) {
    box.replaceChildren(el('p', { class: 'empty' }, 'This video has no chapters.'));
    return;
  }
  const t = remote.estimatedTime();
  const cur = currentChapter(data.chapters, t);
  box.replaceChildren(
    ...data.chapters.map((c) =>
      el('button', { class: `chapter${cur && cur.start === c.start ? ' current' : ''}`, 'data-start': c.start, type: 'button', onclick: guard(() => remote.seekTo(c.start)) }, el('span', { class: 'ctime' }, fmtTime(c.start)), el('span', {}, c.title))
    )
  );
}

async function loadWatch(videoId) {
  if (watchCache.has(videoId)) {
    ui.watch = { ...watchCache.get(videoId), loading: false };
    afterWatchLoaded();
    return;
  }
  ui.watch = { videoId, data: null, loading: true, related: [], relatedContinuation: null };
  if (ui.npOpen) renderNpTabs();
  try {
    const data = await apiWatch(videoId);
    const entry = { videoId, data, related: data.related.items, relatedContinuation: data.related.continuation };
    watchCache.set(videoId, entry);
    if (remote.player.videoId !== videoId) return; // moved on already
    ui.watch = { ...entry, loading: false };
    afterWatchLoaded();
  } catch (e) {
    ui.watch.loading = false;
    if (ui.npOpen) renderNpTabs();
    throw e;
  }
}
function afterWatchLoaded() {
  const v = ui.watch.data.video;
  const dur = remote.player.duration > 0 ? fmtTime(remote.player.duration) : '';
  store.rememberVideo({ ...v, duration: dur });
  // Fill in placeholder rows the TV added.
  let changed = false;
  for (const it of Q.items) {
    if (it.videoId === v.videoId && (it.title === 'Loading…' || it.title === it.videoId)) {
      it.title = v.title;
      it.channel = v.channel;
      if (dur) it.duration = dur;
      changed = true;
    }
  }
  if (changed) saveQueue();
  renderMini();
  if (ui.npOpen) renderNowPlaying();
}
async function loadMoreRelated() {
  const w = ui.watch;
  if (!w.relatedContinuation) return;
  const res = await apiWatch(null, w.relatedContinuation);
  w.related = w.related.concat(res.related.items);
  w.relatedContinuation = res.related.continuation;
  watchCache.set(w.videoId, { ...w });
  renderRelated();
}

// ---------------------------------------------------------------------------
// Library: Watch later, History, Playlists
// ---------------------------------------------------------------------------
const L = ui.library;
for (const chip of document.querySelectorAll('#library-chips .chip')) {
  chip.addEventListener('click', () => {
    L.tab = chip.dataset.lib;
    L.playlist = null;
    loadLibrary(true).catch(showError);
  });
}
$('#library-back').addEventListener('click', () => {
  L.playlist = null;
  loadLibrary(true).catch(showError);
});

function playlistRow(pl) {
  return el(
    'button',
    { class: 'plrow', type: 'button', onclick: guard(() => openPlaylist(pl)) },
    el('div', { class: 'thumb' }, pl.thumbnail ? el('img', { src: pl.thumbnail, alt: '', loading: 'lazy' }) : null, pl.count ? el('span', { class: 'dur' }, pl.count) : null),
    el('div', { class: 'card-text' }, el('div', {}, el('div', { class: 'card-title' }, pl.title), el('div', { class: 'card-sub' }, pl.byline)))
  );
}

function renderLibrary() {
  for (const chip of document.querySelectorAll('#library-chips .chip')) chip.classList.toggle('active', chip.dataset.lib === L.tab);
  const head = $('#library-plhead');
  head.hidden = !L.playlist;
  if (L.playlist) {
    $('#library-pltitle').textContent = L.playlist.title;
    $('#library-plsub').textContent = joinMeta(L.playlist.count, `${L.items.length} loaded`);
  }
  const list = $('#library-list');
  const notice = $('#library-notice');
  notice.hidden = true;
  if (L.tab === 'playlists' && !L.playlist) {
    list.replaceChildren(...L.playlists.map(playlistRow));
    if (L.playlists.length === 0 && L.loaded) list.replaceChildren(el('p', { class: 'empty' }, 'No playlists found on your account.'));
    return;
  }
  list.replaceChildren(...L.items.map((v) => card(v)));
  if (L.items.length === 0 && L.loaded) list.replaceChildren(el('p', { class: 'empty' }, L.tab === 'history' ? 'No watch history.' : 'Nothing here yet.'));
}

function libraryError(e) {
  const notice = $('#library-notice');
  notice.hidden = false;
  notice.className = 'notice warn';
  notice.replaceChildren(
    el('span', {}, e.code === 'SIGN_IN_REQUIRED' || e.code === 'COOKIES_REJECTED' ? 'Your library needs your YouTube cookies. Add them in the TV tab.' : e.message),
    el('button', { class: 'btn ghost small', onclick: () => showView('tv') }, 'Open TV tab')
  );
}

/** Loads the current library list (first page when reset, next page otherwise). */
async function loadLibrary(reset) {
  if (L.loading) return;
  if (reset) {
    L.items = [];
    L.playlists = [];
    L.continuation = null;
    L.loaded = false;
    $('#library-list').replaceChildren();
    renderLibrary();
  } else if (!L.continuation) return;
  L.loading = true;
  $('#library-loading').hidden = false;
  try {
    if (L.playlist) {
      const res = await apiPlaylist(L.playlist.playlistId, reset ? null : L.continuation);
      if (reset) L.playlist = { ...L.playlist, title: res.title, count: res.count };
      L.items = L.items.concat(res.items);
      L.continuation = res.continuation;
    } else if (L.tab === 'WL') {
      const res = await apiPlaylist('WL', reset ? null : L.continuation);
      L.items = L.items.concat(res.items);
      L.continuation = res.continuation;
    } else if (L.tab === 'history') {
      const res = await apiHistory(reset ? null : L.continuation);
      L.items = L.items.concat(res.items);
      L.continuation = res.continuation;
    } else {
      const res = await apiPlaylists(reset ? null : L.continuation);
      L.playlists = L.playlists.concat(res.items);
      L.continuation = res.continuation;
    }
    L.loaded = true;
    renderLibrary();
  } catch (e) {
    L.loaded = true;
    renderLibrary();
    libraryError(e);
    throw e;
  } finally {
    L.loading = false;
    $('#library-loading').hidden = true;
  }
  fillIfShort('library-sentinel', 'library', () => Boolean(L.continuation), () => loadLibrary(false));
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && ui.view === 'library' && L.loaded) loadLibrary(false).catch(showError);
}, { rootMargin: '600px' }).observe($('#library-sentinel'));

async function openPlaylist(pl) {
  L.playlist = pl;
  await loadLibrary(true);
}

/** Every video of the open playlist, following continuations up to a cap the TV can take. */
async function allPlaylistItems() {
  const CAP = 200;
  let items = L.items.slice();
  let cont = L.continuation;
  while (cont && items.length < CAP) {
    const res = await apiPlaylist(L.playlist.playlistId, cont);
    items = items.concat(res.items);
    cont = res.continuation;
  }
  if (items.length > CAP) {
    toast(`Taking the first ${CAP} videos`);
    items = items.slice(0, CAP);
  }
  return items;
}

/** Appends many videos to the local queue and tells the TV once. */
async function queueMany(items, playFirst) {
  const fresh = items.filter((v) => !Q.items.some((it) => it.videoId === v.videoId) && v.videoId !== remote.player.videoId);
  if (fresh.length === 0) throw new Error('All of those are already in the queue');
  for (const v of fresh) store.rememberVideo(v);
  const start = Q.items.length;
  Q.items.push(...fresh.map(queueItem));
  debug.log('app', `queued ${fresh.length} videos from ${L.playlist ? L.playlist.title : L.tab}`, { playFirst, connected: remote.connected, owned: ui.owned });
  if (playFirst) Q.currentIndex = start;
  saveQueue();
  if (!remote.connected) {
    toast(`${fresh.length} videos queued. Connect to the TV to play.`);
    return;
  }
  if (playFirst || !remote.player.videoId) {
    await pushQueue(playFirst ? start : Math.max(0, Q.currentIndex), playFirst ? 0 : resumeTimeFor(Math.max(0, Q.currentIndex)));
  } else if (tvQueueIsOurs() && !ui.stale && fresh.length <= 5) {
    for (const v of fresh) await remote.addVideo(v.videoId);
  } else {
    // Many videos: one setPlaylist is far more reliable than a burst of addVideo on the Xbox.
    await pushQueue(Q.currentIndex, remote.estimatedTime());
  }
  toast(playFirst ? `Playing ${fresh.length} videos` : `${fresh.length} videos added to the queue`);
}
$('#library-playall').addEventListener('click', guard(async () => queueMany(await allPlaylistItems(), true)));
$('#library-queueall').addEventListener('click', guard(async () => queueMany(await allPlaylistItems(), false)));

// ---------------------------------------------------------------------------
// Phone notification controls
// ---------------------------------------------------------------------------
media.setHandlers({
  play: () => remote.play().catch(showError),
  pause: () => remote.pause().catch(showError),
  next: () => remote.next().catch(showError),
  previous: () => remote.previous().catch(showError),
  seekBy: (d) => remote.seekBy(d).catch(showError),
  seekTo: (t) => remote.seekTo(t).catch(showError),
});
function syncMedia() {
  const pl = remote.player;
  if (!remote.connected || !pl.videoId) {
    if (media.active) media.stop();
    return;
  }
  const data = ui.watch.videoId === pl.videoId ? ui.watch.data : null;
  const item = Q.items.find((it) => it.videoId === pl.videoId) || store.video(pl.videoId);
  media.update({
    title: remote.ad.active ? 'Ad playing on TV' : data ? data.video.title : item ? item.title : 'Playing on TV',
    artist: data ? data.video.channel : item ? item.channel : '',
    artwork: `https://i.ytimg.com/vi/${pl.videoId}/hqdefault.jpg`,
    playing: pl.state === PLAYER_STATE.PLAYING || pl.state === PLAYER_STATE.AD || pl.state === PLAYER_STATE.BUFFERING,
    position: remote.estimatedTime(),
    duration: pl.duration,
  });
}
/** Audio may only start from a tap: try on every tap while the TV plays and the notification is not up yet. */
document.addEventListener('pointerdown', () => {
  if (media.active || !media.supported || !remote.connected || !remote.player.videoId) return;
  media.start().then((ok) => { if (ok) { debug.log('app', 'phone notification controls started'); syncMedia(); } }).catch((e) => debug.log('error', `notification controls could not start: ${e.message}`));
}, true);

// ---------------------------------------------------------------------------
// Swipe on video cards: right = add to queue, left = get rid of it
// ---------------------------------------------------------------------------
const swipe = { justSwiped: false };

/** What a left swipe means in each list; null = no left action there. */
function leftAction(listId) {
  if (listId === 'feed-list' || listId === 'subs-list' || listId === 'search-list' || listId === 'np-related' || listId === 'chan-list') return { label: 'Remove', run: dismissVideo };
  if (listId === 'library-list' && !L.playlist && L.tab === 'WL') return { label: 'Remove from Watch later', run: removeFromWatchLater };
  return null;
}

/** Left swipe on a recommendation: hide it for good, and tell YouTube "Not interested" when it offered that. */
async function dismissVideo(v, listId) {
  store.hide(v.videoId);
  const notInterested = (v.feedback || []).find((f) => /not interested/i.test(f.label));
  debug.log('app', `swiped away ${v.videoId}${notInterested ? ' (+ Not interested, held 10 s)' : ''}`);
  offerUndo({
    text: `Removed: ${v.title}`,
    revert: () => {
      store.unhide(v.videoId);
      rerenderList(listId);
      debug.log('app', `undo: restored ${v.videoId}`);
    },
    commit: notInterested ? (opts) => apiSendFeedback(notInterested.token, opts) : null,
    commitLabel: 'Not interested',
  });
}
async function removeFromWatchLater(v, listId) {
  const index = L.items.findIndex((x) => x.videoId === v.videoId);
  const item = L.items[index];
  L.items = L.items.filter((x) => x.videoId !== v.videoId);
  debug.log('app', `swiped ${v.videoId} out of Watch later (held 10 s)`);
  offerUndo({
    text: `Removed from Watch later: ${v.title}`,
    revert: () => {
      L.items.splice(Math.min(index, L.items.length), 0, item);
      rerenderList(listId);
      debug.log('app', `undo: ${v.videoId} back in Watch later`);
    },
    commit: (opts) => apiEditPlaylist('WL', v.videoId, 'remove', opts),
    commitLabel: 'remove from Watch later',
  });
}

function attachSwipe(container) {
  let card = null, bg = null, startX = 0, startY = 0, dx = 0, horizontal = null;
  const reset = () => {
    if (bg) bg.remove();
    card = bg = null;
    horizontal = null;
    dx = 0;
  };
  container.addEventListener('touchstart', (e) => {
    const c = e.target.closest('.card');
    if (!c || e.touches.length !== 1 || !cardVideo.has(c)) return;
    card = c;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    horizontal = null;
    dx = 0;
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (!card) return;
    const x = e.touches[0].clientX - startX;
    const y = e.touches[0].clientY - startY;
    if (horizontal === null) {
      if (Math.abs(x) < 12 && Math.abs(y) < 12) return;
      horizontal = Math.abs(x) > Math.abs(y) * 1.4;
      if (!horizontal) {
        card = null; // vertical scroll: leave it alone
        return;
      }
      bg = el('div', { class: 'swipe-bg' }, el('span', { class: 'swipe-right' }, '+ Queue'), el('span', { class: 'swipe-left' }, (leftAction(container.id) || { label: '' }).label));
      bg.style.top = `${card.offsetTop}px`;
      bg.style.height = `${card.offsetHeight}px`;
      container.insertBefore(bg, card);
      card.style.transition = 'none';
    }
    e.preventDefault();
    dx = x;
    if (dx < 0 && !leftAction(container.id)) dx = Math.max(dx, -40); // no left action here: just a nudge
    card.style.transform = `translateX(${dx}px)`;
    bg.classList.toggle('go-right', dx > 0);
    bg.classList.toggle('go-left', dx < 0);
    bg.classList.toggle('armed', Math.abs(dx) > card.offsetWidth * 0.3);
  }, { passive: false });
  const end = () => {
    if (!card || !horizontal) return reset();
    const c = card;
    const v = cardVideo.get(c);
    const w = c.offsetWidth;
    const left = leftAction(container.id);
    const commit = dx > w * 0.3 ? 'right' : dx < -w * 0.3 && left ? 'left' : null;
    swipe.justSwiped = true;
    setTimeout(() => (swipe.justSwiped = false), 350);
    c.style.transition = 'transform .18s ease-out, opacity .18s';
    const bgEl = bg;
    card = bg = null;
    if (!commit) {
      c.style.transform = '';
      setTimeout(() => bgEl.remove(), 180);
      return;
    }
    if (commit === 'right') {
      c.style.transform = '';
      setTimeout(() => bgEl.remove(), 180);
      addToQueue(v).catch(showError);
      return;
    }
    // left: slide out, collapse, then do it
    c.style.transform = `translateX(${-w}px)`;
    c.style.opacity = '0';
    setTimeout(() => {
      bgEl.remove();
      c.style.transition = 'height .2s, padding .2s';
      c.style.height = `${c.offsetHeight}px`;
      requestAnimationFrame(() => { c.style.height = '0px'; c.style.paddingBottom = '0px'; c.style.overflow = 'hidden'; });
      setTimeout(() => c.remove(), 220);
    }, 180);
    left.run(v, container.id).catch(showError);
  };
  container.addEventListener('touchend', end);
  container.addEventListener('touchcancel', () => {
    if (card) card.style.transform = '';
    reset();
  });
}
for (const id of ['feed-list', 'subs-list', 'search-list', 'library-list', 'np-related', 'chan-list']) attachSwipe(document.getElementById(id));

// ---------------------------------------------------------------------------
// Channel page
// ---------------------------------------------------------------------------
const CH = { channel: null, header: null, tab: 'videos', q: '', items: [], playlists: [], continuation: null, sorts: [], loading: false, playlist: null };
$('#chan-back').innerHTML = icon('back');
$('#chan-plback').innerHTML = icon('back');
$('#chan-search button').innerHTML = icon('search');

async function openChannel(seed) {
  CH.channel = seed;
  CH.header = null;
  CH.tab = 'videos';
  CH.q = '';
  CH.playlist = null;
  $('#chan-search-input').value = '';
  $('#chan').hidden = false;
  $('#chan').scrollTop = 0;
  if (history.state !== 'channel') history.pushState('channel', ''); // phone Back closes the channel page
  debug.log('app', `open channel ${seed.channelId} (${seed.title})`);
  renderChannelHead();
  await loadChannel(true);
}
function closeChannel() {
  $('#chan').hidden = true;
  CH.channel = null;
}
$('#chan-back').addEventListener('click', () => history.back());
window.addEventListener('popstate', () => {
  if (!$('#chan').hidden) closeChannel();
});

function renderChannelHead() {
  const h = CH.header;
  const seed = CH.channel;
  const title = h ? h.title : seed.title;
  $('#chan-top-title').textContent = title;
  $('#chan-title').textContent = title;
  const avatar = h ? h.avatar : seed.avatar;
  $('#chan-avatar').hidden = !avatar;
  if (avatar) $('#chan-avatar').src = avatar;
  $('#chan-meta').textContent = h ? joinMeta(h.handle, h.subscribers, h.videoCount) : '';
  const banner = $('#chan-banner');
  banner.style.backgroundImage = h && h.banner ? `url("${h.banner}")` : '';
  banner.hidden = !(h && h.banner);
  const desc = $('#chan-desc');
  desc.hidden = !(h && h.description);
  desc.replaceChildren(h && h.description ? linkify(h.description) : '');
}
$('#chan-desc').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  $('#chan-desc').classList.toggle('open');
});

function renderChannelList() {
  for (const t of document.querySelectorAll('#chan-tabs .tab')) t.classList.toggle('active', t.dataset.tab === CH.tab);
  $('#chan-search').hidden = CH.tab !== 'search';
  const sorts = $('#chan-sorts');
  sorts.hidden = !(CH.tab === 'videos' && CH.sorts.length);
  sorts.replaceChildren(...CH.sorts.map((so) => el('button', { class: `chip${so.selected ? ' active' : ''}`, type: 'button', onclick: guard(() => sortChannel(so)) }, so.label)));
  $('#chan-plhead').hidden = !CH.playlist;
  if (CH.playlist) {
    $('#chan-pltitle').textContent = CH.playlist.title;
    $('#chan-plsub').textContent = joinMeta(CH.playlist.count, `${CH.items.length} loaded`);
  }
  const list = $('#chan-list');
  if (CH.tab === 'playlists' && !CH.playlist) {
    list.replaceChildren(...CH.playlists.map((pl) => el(
      'button',
      { class: 'plrow', type: 'button', onclick: guard(() => openChannelPlaylist(pl)) },
      el('div', { class: 'thumb' }, pl.thumbnail ? el('img', { src: pl.thumbnail, alt: '', loading: 'lazy' }) : null, pl.count ? el('span', { class: 'dur' }, pl.count) : null),
      el('div', { class: 'card-text' }, el('div', {}, el('div', { class: 'card-title' }, pl.title)))
    )));
    if (!CH.loading && CH.playlists.length === 0) list.replaceChildren(el('p', { class: 'empty' }, 'No playlists.'));
    return;
  }
  if (CH.tab === 'search' && !CH.q) {
    list.replaceChildren(el('p', { class: 'empty' }, 'Search this channel\'s videos.'));
    return;
  }
  list.replaceChildren(...CH.items.map((v) => card(v)));
  if (!CH.loading && CH.items.length === 0) list.replaceChildren(el('p', { class: 'empty' }, 'No videos.'));
}

/** Loads the current tab (first page on reset, otherwise the next page). */
async function loadChannel(reset) {
  if (CH.loading || !CH.channel) return;
  if (!reset && !CH.continuation) return;
  if (reset) {
    CH.items = [];
    CH.playlists = [];
    CH.continuation = null;
  }
  if (CH.tab === 'search' && !CH.q && !CH.playlist) {
    renderChannelList();
    return;
  }
  CH.loading = true;
  $('#chan-loading').hidden = false;
  renderChannelList();
  const id = CH.channel.channelId;
  try {
    let res;
    if (CH.playlist) res = await apiPlaylist(CH.playlist.playlistId, reset ? null : CH.continuation);
    else res = await apiChannelPage(id, CH.tab, CH.q, reset ? null : CH.continuation);
    if (!CH.channel || CH.channel.channelId !== id) return; // closed or switched meanwhile
    if (res.header) {
      CH.header = res.header;
      renderChannelHead();
    }
    if (reset && res.sorts && !CH.playlist) CH.sorts = res.sorts;
    if (reset && CH.playlist && res.count) CH.playlist = { ...CH.playlist, title: res.title || CH.playlist.title, count: res.count };
    CH.items = CH.items.concat(res.items || []);
    CH.playlists = CH.playlists.concat(res.playlists || []);
    CH.continuation = res.continuation;
  } finally {
    CH.loading = false;
    $('#chan-loading').hidden = true;
    renderChannelList();
  }
}
async function sortChannel(so) {
  if (CH.loading) return;
  CH.sorts = CH.sorts.map((x) => ({ ...x, selected: x.label === so.label }));
  CH.items = [];
  CH.loading = true;
  $('#chan-loading').hidden = false;
  renderChannelList();
  try {
    const res = await apiChannelPage(null, null, null, so.token);
    CH.items = res.items;
    CH.continuation = res.continuation;
  } finally {
    CH.loading = false;
    $('#chan-loading').hidden = true;
    renderChannelList();
  }
}
for (const t of document.querySelectorAll('#chan-tabs .tab')) {
  t.addEventListener('click', () => {
    CH.tab = t.dataset.tab;
    CH.playlist = null;
    loadChannel(true).catch(showError);
    if (CH.tab === 'search') setTimeout(() => $('#chan-search-input').focus(), 50);
  });
}
$('#chan-search').addEventListener('submit', (e) => {
  e.preventDefault();
  CH.q = $('#chan-search-input').value.trim();
  $('#chan-search-input').blur();
  loadChannel(true).catch(showError);
});
async function openChannelPlaylist(pl) {
  CH.playlist = pl;
  await loadChannel(true);
}
$('#chan-plback').addEventListener('click', () => {
  CH.playlist = null;
  loadChannel(true).catch(showError);
});
async function allChannelPlaylistItems() {
  let items = CH.items.slice();
  let cont = CH.continuation;
  while (cont && items.length < 200) {
    const res = await apiPlaylist(CH.playlist.playlistId, cont);
    items = items.concat(res.items);
    cont = res.continuation;
  }
  return items.slice(0, 200);
}
$('#chan-playall').addEventListener('click', guard(async () => queueMany(await allChannelPlaylistItems(), true)));
$('#chan-queueall').addEventListener('click', guard(async () => queueMany(await allChannelPlaylistItems(), false)));
// Infinite scroll inside the channel page (it scrolls itself, not the window)
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !$('#chan').hidden) loadChannel(false).catch(showError);
}, { root: document.getElementById('chan'), rootMargin: '600px' }).observe($('#chan-sentinel'));

// ---------------------------------------------------------------------------
// Subscriptions: feed + channel strip
// ---------------------------------------------------------------------------
const SUBS = { loaded: false, loading: false, items: [], continuation: null, channels: [], channel: null };

function renderSubs() {
  const strip = $('#subs-strip');
  const chip = (active, img, label, onclick) => el('button', { class: `subchip${active ? ' active' : ''}`, type: 'button', onclick }, img, el('span', {}, label));
  strip.replaceChildren(
    chip(!SUBS.channel, el('div', { class: 'all' }, 'All'), 'All', () => { SUBS.channel = null; loadSubs(true).catch(showError); }),
    ...SUBS.channels.map((c) => chip(SUBS.channel && SUBS.channel.channelId === c.channelId, c.avatar ? el('img', { src: c.avatar, alt: '', loading: 'lazy' }) : el('div', { class: 'all' }, (c.title || '?').slice(0, 1).toUpperCase()), c.title, () => {
      SUBS.channel = SUBS.channel && SUBS.channel.channelId === c.channelId ? null : c;
      loadSubs(true).catch(showError);
    }))
  );
  $('#subs-head').hidden = !SUBS.channel;
  if (SUBS.channel) {
    $('#subs-head-avatar').hidden = !SUBS.channel.avatar;
    if (SUBS.channel.avatar) $('#subs-head-avatar').src = SUBS.channel.avatar;
    $('#subs-head-title').textContent = SUBS.channel.title;
  }
  const hiddenSubs = new Set(store.hidden);
  renderList($('#subs-list'), SUBS.items.filter((v) => !hiddenSubs.has(v.videoId)));
  if (SUBS.loaded && SUBS.items.length === 0) $('#subs-list').replaceChildren(el('p', { class: 'empty' }, 'No videos.'));
}

async function loadSubs(reset) {
  if (SUBS.loading) return;
  if (reset) {
    SUBS.items = [];
    SUBS.continuation = null;
    SUBS.loaded = false;
    renderSubs();
    window.scrollTo(0, 0);
  } else if (!SUBS.continuation) return;
  SUBS.loading = true;
  $('#subs-loading').hidden = false;
  $('#subs-notice').hidden = true;
  try {
    let res;
    if (SUBS.channel) res = await apiChannelVideos(SUBS.channel.channelId, reset ? null : SUBS.continuation);
    else {
      res = await apiSubscriptions(reset ? null : SUBS.continuation);
      if (reset) {
        SUBS.channels = res.channels;
        store.rememberSubs(res.channels);
      }
    }
    SUBS.items = SUBS.items.concat(res.items);
    SUBS.continuation = res.continuation;
    SUBS.loaded = true;
    renderSubs();
  } catch (e) {
    SUBS.loaded = true;
    renderSubs();
    const notice = $('#subs-notice');
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.replaceChildren(el('span', {}, e.code === 'SIGN_IN_REQUIRED' || e.code === 'COOKIES_REJECTED' ? 'Subscriptions need your YouTube login (TV tab).' : e.message));
    throw e;
  } finally {
    SUBS.loading = false;
    $('#subs-loading').hidden = true;
  }
  fillIfShort('subs-sentinel', 'subs', () => Boolean(SUBS.continuation), () => loadSubs(false));
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && ui.view === 'subs' && SUBS.loaded) loadSubs(false).catch(showError);
}, { rootMargin: '600px' }).observe($('#subs-sentinel'));

// ---------------------------------------------------------------------------
// Remote wiring
// ---------------------------------------------------------------------------
function renderTvChip() {
  const chip = $('#tvchip');
  const screen = store.settings.screen;
  chip.className = `tvchip ${remote.status}${remote.status === 'disconnected' && remote.statusDetail ? ' error' : ''}`;
  $('.label', chip).textContent = remote.connected ? remote.screenName || screen.name : remote.status === 'connecting' ? 'Connecting…' : screen ? 'Tap to connect' : 'No TV';
}

remote.addEventListener('status', () => {
  if (remote.status === 'connected') ui.shutDown = false;
  if (remote.status !== 'connected') ui.owned = false;
  syncMedia();
  renderTvChip();
  renderTvView();
  renderMini();
  renderQueue();
  if (ui.npOpen) renderNowPlaying();
  if (remote.status === 'disconnected' && remote.statusDetail) toast(remote.statusDetail, { error: true });
});
remote.addEventListener('devices', () => {
  renderTvChip();
  renderTvView();
});
remote.addEventListener('error', (e) => showError(e.detail.error));
remote.addEventListener('tvqueue', () => {
  // If the TV is playing a list we created (same id) after a reconnect, we still own it.
  if (remote.tvQueue.listId && Q.listId && remote.tvQueue.listId === Q.listId) ui.owned = true;
  if (ui.owned && remote.tvQueue.listId && Q.listId !== remote.tvQueue.listId) {
    Q.listId = remote.tvQueue.listId;
    store.saveQueue();
  }
  renderQueue();
});
let lastVideoId = null;
remote.addEventListener('player', () => {
  const pl = remote.player;
  if (pl.videoId !== lastVideoId) {
    debug.log('app', `TV video changed: ${lastVideoId} → ${pl.videoId}`, { state: pl.state, currentIndex: pl.currentIndex, listId: pl.listId });
    lastVideoId = pl.videoId;
    markAllCards();
    ui.comments = null;
    ui.descOpen = false;
    resetAdRun(pl.videoId);
    if (pl.videoId) {
      const known = store.video(pl.videoId);
      store.recordPlay(pl.videoId, known && known.channelId ? known.channelId : null, known && known.channel ? known.channel : null, known && known.channelAvatar ? known.channelAvatar : null);
      syncCurrentFromTv();
      loadWatch(pl.videoId).catch(showError);
      if (ADS().sponsorBlock) loadSponsorSegments(pl.videoId).catch(showError);
    }
  }
  applyPendingSeek();
  syncMedia();
  rememberPosition();
  renderMini();
  renderQueue();
  if (ui.npOpen) renderNowPlaying();
});

// Smooth playhead while playing.
setInterval(() => {
  if (!remote.connected || !remote.player.videoId) return;
  if (ui.npOpen && !ui.scrubbing) paintScrub(remote.estimatedTime());
  else $('#mini-bar').style.width = `${remote.player.duration > 0 ? (remote.estimatedTime() / remote.player.duration) * 100 : 0}%`;
  if (Date.now() % 10000 < 1000) rememberPosition();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') prewarm();
  debug.log('app', `app ${document.visibilityState}`, { status: remote.status, tvVideo: remote.player.videoId, state: remote.player.state });
  if (document.visibilityState !== 'visible') return;
  if (remote.connected) remote.resume().catch(showError);
  else if (store.settings.screen && store.settings.autoConnect && !ui.shutDown) remote.connect().catch(showError);
});
window.addEventListener('error', (e) => debug.log('error', `uncaught: ${e.message}`, e.error && e.error.stack ? e.error.stack.split('\n').slice(0, 4).join(' | ') : undefined));
window.addEventListener('unhandledrejection', (e) => debug.log('error', `unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : String(e.reason)}`));

// ---------------------------------------------------------------------------
// Debug log viewer
// ---------------------------------------------------------------------------
function debugContext() {
  const screen = store.settings.screen;
  return {
    remoteStatus: `${remote.status}${remote.statusDetail ? ` (${remote.statusDetail})` : ''}`,
    screen: screen ? { name: screen.name, screenId: screen.screenId, tokenExpires: screen.expiration ? new Date(screen.expiration).toISOString() : null } : null,
    screenName: remote.screenName,
    deviceName: store.settings.deviceName,
    cookies: store.settings.cookies ? 'present' : 'none',
    signedIn: ui.feed.signedIn,
    player: remote.player,
    ad: remote.ad,
    tvQueue: remote.tvQueue,
    localQueue: { currentIndex: Q.currentIndex, items: Q.items.map((it) => it.videoId), listId: Q.listId || null },
    owned: ui.owned,
    stale: ui.stale,
    lastKnown: store.lastKnown,
    adSettings: store.settings.ads,
    adRun,
    sponsorSegments: sb.segments.length,
  };
}
function openDebug() {
  $('#debug').hidden = false;
  $('#debug-title').textContent = `Debug log (${debug.count()} entries)`;
  const pre = $('#debug-text');
  pre.textContent = debug.recent(400).join('\n');
  pre.scrollTop = pre.scrollHeight;
}
$('#debug-close').addEventListener('click', () => ($('#debug').hidden = true));
$('#debug-copy').addEventListener('click', guard(async () => {
  await navigator.clipboard.writeText(debug.asText(debugContext()));
  toast('Log copied. Paste it into the chat.');
}));
$('#debug-share').addEventListener('click', guard(async () => {
  const text = debug.asText(debugContext());
  const file = new File([text], `mytube-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: 'MyTube debug log' });
    return;
  }
  const a = el('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
}));
$('#debug-clear').addEventListener('click', () => {
  if (!confirm('Clear the debug log?')) return;
  debug.clear();
  openDebug();
});

// ---------------------------------------------------------------------------
// TV / settings view
// ---------------------------------------------------------------------------
function renderTvView() {
  const root = $('#view-tv');
  if (root.hidden && ui.view !== 'tv') return;
  const s = store.settings;
  const screen = s.screen;
  const panels = [];

  // --- TV panel
  if (screen) {
    const statusText = remote.connected ? 'Connected' : remote.status === 'connecting' ? 'Connecting…' : remote.statusDetail ? `Disconnected — ${remote.statusDetail}` : 'Disconnected';
    panels.push(
      el('div', { class: 'panel' },
        el('h3', {}, el('span', { class: `dot ${remote.connected ? 'connected' : ''}`, style: remote.connected ? 'background:var(--green)' : '' }), remote.screenName || screen.name),
        el('p', { class: remote.connected ? 'ok' : remote.statusDetail ? 'bad' : '' }, statusText),
        el('div', { class: 'kv' }, 'Token valid until', el('b', {}, screen.expiration ? new Date(screen.expiration).toLocaleString() : 'unknown')),
        el('div', { class: 'row' },
          remote.connected
            ? el('button', { class: 'btn ghost danger', onclick: guard(shutDown) }, 'Done — shut down')
            : el('button', { class: 'btn primary', disabled: remote.status === 'connecting', onclick: guard(() => remote.connect()) }, 'Connect'),
          el('button', { class: 'btn ghost', onclick: guard(checkAvailability) }, 'Is the TV online?'),
          el('button', { class: 'btn ghost danger', onclick: guard(forgetTv) }, 'Forget TV')
        ),
        el('label', { class: 'toggle', style: 'margin-top:12px' }, el('input', { type: 'checkbox', checked: s.autoConnect, onchange: (e) => { s.autoConnect = e.target.checked; store.saveSettings(); } }), el('span'), 'Connect automatically when the app opens')
      )
    );
  } else {
    const input = el('input', { class: 'field code-field', inputmode: 'numeric', autocomplete: 'off', placeholder: '000 000 000 000', maxlength: '15' });
    panels.push(
      el('div', { class: 'panel' },
        el('h3', {}, 'Link your Xbox'),
        el('ol', { class: 'steps' },
          el('li', {}, 'On the Xbox open YouTube → Settings (gear) → ', el('b', {}, 'Link with TV code'), '.'),
          el('li', {}, 'Type the 12-digit code below. You only do this once.')
        ),
        el('div', { style: 'margin-top:12px' }, input),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async () => { await remote.pair(input.value); toast('TV linked'); renderTvView(); await remote.connect(); }) }, 'Link TV'))
      )
    );
  }

  // --- Remote name
  const nameInput = el('input', { class: 'field', value: s.deviceName, maxlength: '40' });
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Name shown on the TV'),
      nameInput,
      el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: guard(async () => { const v = nameInput.value.trim(); if (!v) throw new Error('Name cannot be empty'); s.deviceName = v; store.saveSettings(); toast('Saved. Reconnect for the TV to see it.'); }) }, 'Save'))
    )
  );

  // --- Cookies
  const ta = el('textarea', { class: 'field', placeholder: 'Paste cookies.txt content or a Cookie header here', spellcheck: 'false' }, s.cookies);
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Your YouTube account'),
      el('p', {}, 'Your recommendations, history and playlists come from your account. Get your youtube.com cookies on this phone:'),
      el('ol', { class: 'steps' },
        el('li', {}, 'Install ', el('b', {}, 'Firefox'), ' from the Play Store, then add the ', el('b', {}, 'Cookie-Editor'), ' extension (Firefox menu → Extensions).'),
        el('li', {}, 'In Firefox open ', el('b', {}, 'youtube.com'), ' and sign in.'),
        el('li', {}, 'Open Cookie-Editor → ', el('b', {}, 'Export'), '. It copies the cookies to the clipboard.'),
        el('li', {}, 'Come back here and tap ', el('b', {}, 'Paste from clipboard'), ', then ', el('b', {}, 'Save & test'), '.'),
        el('li', {}, 'Then stop using YouTube in Firefox: close the tab. YouTube rotates cookies in any open tab, which would invalidate this copy.')
      ),
      el('p', {}, 'JSON, cookies.txt and plain "a=b; c=d" formats all work. Cookies stay in this phone\'s browser and only go to your own MyTube server.'),
      el('p', { class: ui.feed.signedIn === true ? 'ok' : ui.feed.signedIn === false && s.cookies ? 'bad' : '' }, ui.feed.signedIn === true ? 'Status: personalised feed is working.' : ui.feed.signedIn === false && s.cookies ? 'Status: cookies saved but YouTube says signed out. Export a fresh set.' : s.cookies ? 'Status: cookies saved, not tested yet.' : 'Status: no cookies — anonymous mode (Search works, Home is empty).'),
      ta,
      el('div', { class: 'row' },
        el('button', { class: 'btn ghost', onclick: guard(async () => { ta.value = await navigator.clipboard.readText(); if (!ta.value.trim()) throw new Error('The clipboard is empty'); toast(`Pasted ${ta.value.length} characters`); }) }, 'Paste from clipboard'),
        el('button', { class: 'btn primary', onclick: guard(async () => { s.cookies = ta.value.trim(); store.saveSettings(); ui.feed.loaded = false; await loadFeed(true); toast(ui.feed.signedIn ? 'Signed in — feed loaded' : 'Saved, but YouTube still sees you as signed out', { error: !ui.feed.signedIn }); renderTvView(); }) }, 'Save & test'),
        el('button', { class: 'btn ghost', onclick: () => { ta.value = ''; s.cookies = ''; store.saveSettings(); ui.feed.loaded = false; renderTvView(); } }, 'Remove')
      )
    )
  );

  // --- Ads
  const ads = s.ads;
  const row = (key, label, hint) =>
    el('div', { class: 'setting-row' },
      el('div', { class: 'setting-text' }, label, el('small', {}, hint)),
      el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: ads[key], onchange: (e) => { ads[key] = e.target.checked; store.saveSettings(); pushAdSettings(); debug.log('app', `setting ads.${key} = ${ads[key]}`); if (key === 'sponsorBlock' && ads[key] && remote.player.videoId) loadSponsorSegments(remote.player.videoId).catch(showError); } }), el('span'))
    );
  const dodgeAfter = el('select', { onchange: (e) => { ads.dodgeAfter = Number(e.target.value); store.saveSettings(); pushAdSettings(); debug.log('app', `setting ads.dodgeAfter = ${ads.dodgeAfter}`); } }, ...[0, 1, 2, 3, 5].map((n) => el('option', { value: n, selected: ads.dodgeAfter === n }, n === 0 ? 'Right away' : `${n} s`)));
  const dodgeMax = el('select', { onchange: (e) => { ads.dodgeMax = Number(e.target.value); store.saveSettings(); pushAdSettings(); } }, ...[1, 2, 3, 5].map((n) => el('option', { value: n, selected: ads.dodgeMax === n }, String(n))));
  const cats = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic'];
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Ads'),
      row('autoSkip', 'Skip ads automatically', 'Sends Skip the instant the TV reports the skip button is enabled.'),
      row('dodge', 'Dodge unskippable ads by reloading', 'Your trick: reload the video at the saved position (+2 s past a mid-roll cue) and force a seek there. An ad the TV already reports as skippable is skipped instead.'),
      el('div', { class: 'setting-row' }, el('div', { class: 'setting-text' }, 'Dodge after', el('small', {}, 'How long the ad plays before the reload. Raise it if the ad comes straight back after a reload.')), dodgeAfter),
      row('dodgeExit', 'Leave the player first', 'Send stopVideo (like pressing B) before the reload. Turn off to reload in place.'),
      el('div', { class: 'setting-row' }, el('div', { class: 'setting-text' }, 'Max reloads per video', el('small', {}, 'Then the ad just plays (or gets skipped).')), dodgeMax),
      row('keepAwake', 'Keep the TV listening (experimental)', 'Asks the TV for its state every 3 s while a video is loaded. Meant to stop play, pause and queue taps from taking many seconds to reach the Xbox. The debug log shows "TV reacted to play after N s" either way.'),
      row('muteAds', 'Mute during ads', 'Mutes the TV on ad start and unmutes when the ad ends.'),
      row('sponsorBlock', 'Skip sponsor segments (SponsorBlock)', 'Seeks past community-marked segments. Purple marks on the progress bar.'),
      el('div', { class: 'setting-row' }, el('div', { class: 'setting-text' }, 'SponsorBlock categories'),
        el('div', { class: 'row', style: 'margin:0; justify-content:flex-end' }, ...cats.map((c) => el('label', { class: 'chip', style: `height:28px;font-size:12px;${ads.sponsorCategories.includes(c) ? 'background:#fff;color:#000' : ''}` }, el('input', { type: 'checkbox', style: 'display:none', checked: ads.sponsorCategories.includes(c), onchange: (e) => { ads.sponsorCategories = e.target.checked ? [...ads.sponsorCategories, c] : ads.sponsorCategories.filter((x) => x !== c); store.saveSettings(); pushAdSettings(); renderTvView(); } }), c)))),
      el('p', {}, `Defaults: ${Object.entries(AD_DEFAULTS).filter(([k]) => typeof AD_DEFAULTS[k] === 'boolean').map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')}.`)
    )
  );

  // --- Debug log
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Debug log'),
      el('p', {}, `${debug.count()} entries on this phone: every TV event, every command and its result, errors, and what the app decided. Copy it and paste it into the chat when something misbehaves. Tokens and cookies are never included.`),
      el('div', { class: 'row' },
        el('button', { class: 'btn ghost', onclick: openDebug }, 'View'),
        el('button', { class: 'btn primary', onclick: guard(async () => { await navigator.clipboard.writeText(debug.asText(debugContext())); toast('Log copied. Paste it into the chat.'); }) }, 'Copy log')
      )
    )
  );

  // --- Danger zone
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Reset'),
      el('div', { class: 'row' },
        el('button', { class: 'btn ghost danger', onclick: () => { if (confirm('Forget everything (TV, cookies, queue)?')) { store.clearAll(); location.reload(); } } }, 'Clear all app data')
      ),
      el('p', {}, `Remote id ${store.deviceId.slice(0, 8)} · MyTube`)
    )
  );
  root.replaceChildren(el('div', { class: 'settings' }, ...panels));
}

// ---------------------------------------------------------------------------
// Tune tab: everything MyTube's own picks are built from, editable
// ---------------------------------------------------------------------------
const TUNE = { showAllChannels: false, openDays: new Set(['Today']), asked: new Set(), resolving: false };

/** flag: 'pinned' | 'blocked'. Pinning unblocks and blocking unpins; blocked picks leave the feed at once. */
function setChannelFlag(channelId, name, flag, on) {
  const T = store.taste;
  if (name) T.names[channelId] = name;
  const other = flag === 'pinned' ? 'blocked' : 'pinned';
  T[flag] = T[flag].filter((id) => id !== channelId);
  if (on) {
    T[flag].push(channelId);
    T[other] = T[other].filter((id) => id !== channelId);
  }
  store.saveTaste();
  debug.log('app', `tune: channel ${channelId} ${flag} = ${on}`);
  dropDisallowedPicks();
}
/** Removes own picks that no longer pass the block lists from Home and from the unseen pool. */
function dropDisallowedPicks() {
  MIX.pool = MIX.pool.filter(pickAllowed);
  const before = ui.feed.items.length;
  ui.feed.items = ui.feed.items.filter((v) => !v.pick || pickAllowed(v));
  if (ui.feed.items.length !== before) renderFeedList();
}
function addWord(listName, input) {
  const word = input.value.trim();
  if (!word) throw new Error('Type something first');
  const T = store.taste;
  if (T[listName].some((w) => w.toLowerCase() === word.toLowerCase())) throw new Error(`"${word}" is already in the list`);
  T[listName].push(word);
  store.saveTaste();
  debug.log('app', `tune: ${listName} + "${word}"`);
  if (listName === 'blockedWords') dropDisallowedPicks();
  renderTuneView();
}
function wordPanel(listName, title, hint, placeholder) {
  const input = el('input', { class: 'field', placeholder, autocomplete: 'off', maxlength: '60' });
  const add = guard(() => addWord(listName, input));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const words = store.taste[listName];
  return el('div', { class: 'panel' },
    el('h3', {}, title),
    el('p', {}, hint),
    el('div', { class: 'tune-add' }, input, el('button', { class: 'btn primary small', onclick: add }, 'Add')),
    words.length
      ? el('div', { class: 'tune-chips' }, ...words.map((w) => el('button', { class: 'chip tune-chip', title: 'Remove', onclick: () => { store.taste[listName] = store.taste[listName].filter((x) => x !== w); store.saveTaste(); debug.log('app', `tune: ${listName} - "${w}"`); renderTuneView(); } }, w, el('span', { class: 'x' }, '×'))))
      : el('p', {}, 'None yet.')
  );
}
const isHearted = (profileId, videoId) => store.tasteOf(profileId).hearts.some((h) => h.videoId === videoId);
/** Hearts or un-hearts a video for a profile: the strongest signal for that profile's picks. */
function toggleHeart(profileId, v) {
  const on = !isHearted(profileId, v.videoId);
  store.setHeart(profileId, v, on);
  const name = store.profiles.list.find((p) => p.id === profileId).name;
  debug.log('app', `tune: ${on ? 'hearted' : 'un-hearted'} ${v.videoId} for profile "${name}"`);
  toast(on ? `Hearted for ${name}: more like this will show up` : `Heart removed for ${name}`);
  if (ui.npOpen) renderNowPlaying();
  if (ui.view === 'tune') renderTuneView();
}
/** Switches which profile MyTube's own picks come from and rebuilds Home from it. */
function useProfile(id) {
  if (id === store.profiles.active) return;
  store.switchProfile(id);
  debug.log('app', `tune: switched to profile "${store.profileName()}"`);
  MIX.pool = [];
  MIX.dry = false;
  ui.feed.loaded = false;
  if (ui.view === 'tune') renderTuneView();
  if (ui.view === 'home') loadFeed(true).catch(showError);
  toast(`Profile: ${store.profileName()}`);
}
function profileChips() {
  return el('div', { class: 'profile-chips' }, ...store.profiles.list.map((p) => el('button', { class: `chip${p.id === store.profiles.active ? ' active' : ''}`, onclick: guard(() => useProfile(p.id)) }, p.name)));
}
function channelRow(c) {
  const sub = [c.plays ? `${c.plays} played/queued` : '', c.subscribed ? 'subscribed' : ''].filter(Boolean).join(' · ');
  return el('div', { class: 'tune-row' },
    c.avatar ? el('img', { class: 'tune-avatar', src: c.avatar, alt: '', loading: 'lazy' }) : el('div', { class: 'tune-avatar' }),
    el('button', { class: 'tune-name', onclick: guard(() => openChannel({ channelId: c.channelId, title: c.name })) }, c.named ? c.name : 'Looking up channel…', sub ? el('small', {}, sub) : null),
    el('button', { class: `chip${c.pinned ? ' active' : ''}`, onclick: () => { setChannelFlag(c.channelId, null, 'pinned', !c.pinned); renderTuneView(); } }, c.pinned ? 'Pinned' : 'Pin'),
    el('button', { class: `chip${c.blocked ? ' active danger' : ''}`, onclick: () => { setChannelFlag(c.channelId, null, 'blocked', !c.blocked); renderTuneView(); } }, c.blocked ? 'Blocked' : 'Block')
  );
}
/**
 * Fetches name and icon for the listed channels that lack either (8 per request), stores them
 * for good and redraws. Each id is asked once per app session.
 */
async function resolveChannels(channels) {
  const missing = channels.filter((c) => (!c.named || !c.avatar) && !TUNE.asked.has(c.channelId)).map((c) => c.channelId);
  if (missing.length === 0 || TUNE.resolving) return;
  TUNE.resolving = true;
  try {
    for (let i = 0; i < missing.length; i += 8) {
      const batch = missing.slice(i, i + 8);
      for (const id of batch) TUNE.asked.add(id);
      const res = await apiChannelInfo(batch);
      const failed = res.channels.filter((c) => c.error);
      for (const c of res.channels) {
        if (c.error) continue;
        store.taste.names[c.channelId] = c.name;
        if (c.avatar) store.taste.avatars[c.channelId] = c.avatar;
      }
      store.saveTaste();
      debug.log('app', `tune: looked up ${batch.length} channels, ${failed.length} failed`, failed.length ? failed : undefined);
      if (ui.view === 'tune') renderTuneView();
    }
  } finally {
    TUNE.resolving = false;
  }
}
const videoThumb = (videoId) => {
  const known = store.video(videoId);
  return known && known.thumbnail ? known.thumbnail : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
};
function dayLabel(at) {
  const d = new Date(at);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
/** One played / excluded video with its thumbnail and the given action buttons. */
function videoRow(entry, ...buttons) {
  const known = store.video(entry.videoId);
  const T = store.taste;
  return el('div', { class: 'tune-row' },
    el('img', { class: 'tune-thumb', src: videoThumb(entry.videoId), alt: '', loading: 'lazy' }),
    el('div', { class: 'tune-name wrap' }, known ? known.title : 'Started on the TV (title not known to this phone)', el('small', {}, entry.channelId ? T.names[entry.channelId] || '' : known ? known.channel : '')),
    el('div', { class: 'tune-btns' }, ...buttons)
  );
}
/** Moves a video from "picks are based on" to "don't use" (and its picks off Home), or back. */
function setExcluded(entry, on) {
  const T = store.taste;
  T.excluded = T.excluded.filter((x) => x.videoId !== entry.videoId);
  T.plays = T.plays.filter((x) => x.videoId !== entry.videoId);
  if (on) T.hearts = T.hearts.filter((x) => x.videoId !== entry.videoId); // cannot be both
  if (on) T.excluded.unshift({ videoId: entry.videoId, channelId: entry.channelId, at: Date.now() });
  else T.plays.unshift({ videoId: entry.videoId, channelId: entry.channelId, at: Date.now() });
  store.saveTaste();
  debug.log('app', `tune: video ${entry.videoId} ${on ? "moved to don't use" : 'back in use'}`);
  dropDisallowedPicks();
  renderTuneView();
}
function renderTuneView() {
  const s = store.settings;
  const T = store.taste;
  const panels = [];

  // --- Profiles
  const active = store.profiles.active;
  const askName = (title, initial) => {
    const name = prompt(title, initial);
    if (name === null) return null;
    if (!name.trim()) throw new Error('The name cannot be empty');
    return name.trim().slice(0, 30);
  };
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Profile'),
      el('p', {}, 'Each profile has its own topics, blocked words, pinned and blocked channels, videos picks are based on, don\'t-use list and mix. What you play is learned by the profile that is active at the time. With more than one profile, the same switcher appears at the top of Home.'),
      profileChips(),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary small', onclick: guard(() => { const name = askName('Name for the new profile', ''); if (name === null) return; const copy = confirm(`Start "${name}" as a copy of "${store.profileName()}"?\n\nOK: copy its lists.\nCancel: start empty.`); store.createProfile(name, copy); debug.log('app', `tune: created profile "${name}" (${copy ? 'copy' : 'empty'})`); MIX.pool = []; MIX.dry = false; ui.feed.loaded = false; renderTuneView(); }) }, 'New profile'),
        el('button', { class: 'btn ghost small', onclick: guard(() => { const name = askName('New name', store.profileName()); if (name === null) return; store.renameProfile(active, name); renderTuneView(); }) }, 'Rename'),
        el('button', { class: 'btn ghost small danger', disabled: active === 'main', onclick: guard(() => { const name = store.profileName(); if (!confirm(`Delete the profile "${name}" and everything in it?`)) return; store.deleteProfile(active); debug.log('app', `tune: deleted profile "${name}"`); MIX.pool = []; MIX.dry = false; ui.feed.loaded = false; renderTuneView(); }) }, 'Delete')
      )
    )
  );

  // --- Mix
  const feedMix = el('select', { onchange: (e) => { T.mix = Number(e.target.value); store.saveTaste(); ui.feed.loaded = false; debug.log('app', `tune: mix = ${T.mix} (${store.profileName()})`); } }, ...[0, 10, 20, 30, 50, 70, 100].map((n) => el('option', { value: n, selected: T.mix === n }, n === 0 ? 'YouTube only' : n === 100 ? 'MyTube only' : `${n} % MyTube`)));
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, `Home feed mix (${store.profileName()})`),
      el('div', { class: 'setting-row' }, el('div', { class: 'setting-text' }, 'Share of MyTube picks', el('small', {}, "Next to YouTube's recommendations while the login works. When it fails, Home is MyTube picks only.")), feedMix),
      el('div', { class: 'setting-row' }, el('div', { class: 'setting-text' }, 'Use my subscriptions', el('small', {}, 'Draw one subscribed channel into each rebuild. Turn off for a profile that should stay on its topics.')), el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: T.useSubs, onchange: (e) => { T.useSubs = e.target.checked; store.saveTaste(); debug.log('app', `tune: useSubs = ${T.useSubs} (${store.profileName()})`); } }), el('span'))),
      el('p', {}, `Picks are built from ${T.plays.length} played or queued videos, ${channelStats().filter((c) => c.plays > 0).length} channels you watched, ${T.hearts.length} hearted videos, ${T.subs.length} subscriptions, ${T.pinned.length} pinned channels and ${T.keywords.length} keywords. Everything below changes what you get.`),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async () => { showView('home'); await loadFeed(true); }) }, 'Rebuild Home now'))
    )
  );

  // --- Words
  panels.push(wordPanel('keywords', 'Topics I want', 'Each rebuild searches YouTube for two of these and mixes the results in. Use them for subjects you like that your history does not show yet.', 'e.g. rocket launches'));
  panels.push(wordPanel('blockedWords', 'Words to keep out', 'A MyTube pick is dropped when its title or channel name contains one of these. Not case-sensitive.', 'e.g. reaction'));

  // --- Channels
  const stats = channelStats();
  const pinned = stats.filter((c) => c.pinned);
  const blocked = stats.filter((c) => c.blocked);
  const rest = stats.filter((c) => !c.pinned && !c.blocked);
  const shown = TUNE.showAllChannels ? rest : rest.slice(0, 12);
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Channels'),
      el('p', {}, 'Pin: always draw new uploads from it. Block: never show its videos in MyTube picks, and never use it as a starting point. Tap a name to open the channel. To pin or block a channel that is not listed, open any of its videos and use the button in the sheet (block) or play one (it then shows up here).'),
      pinned.length ? el('div', { class: 'tune-group' }, `Pinned (${pinned.length})`) : null,
      ...pinned.map(channelRow),
      blocked.length ? el('div', { class: 'tune-group' }, `Blocked (${blocked.length})`) : null,
      ...blocked.map(channelRow),
      el('div', { class: 'tune-group' }, `Discovered from what you watch (${rest.length})`),
      ...(rest.length ? shown.map(channelRow) : [el('p', {}, 'None yet. Channels appear here as you play and queue videos, and when the Subs tab loads.')]),
      rest.length > shown.length ? el('div', { class: 'row' }, el('button', { class: 'btn ghost small', onclick: () => { TUNE.showAllChannels = true; renderTuneView(); } }, `Show all ${rest.length}`)) : null
    )
  );

  // --- Hearted videos: the strongest signal
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, `Hearted (${T.hearts.length})`),
      el('p', {}, 'The strongest influence on this profile: each rebuild starts from up to three of these (more picks per video than an ordinary play, listed first, and the explore picks branch out from them). Heart a video from its sheet (tap it in any list) or with the heart on the now-playing screen.'),
      ...(T.hearts.length
        ? T.hearts.map((h) => videoRow(h, el('button', { class: 'chip', onclick: () => { store.setHeart(store.profiles.active, h, false); debug.log('app', `tune: un-hearted ${h.videoId}`); renderTuneView(); } }, 'Remove')))
        : [el('p', {}, 'None yet.')])
    )
  );

  // --- Watched / queued videos used as starting points, grouped by day
  const days = [];
  for (const pl of T.plays) {
    const label = dayLabel(pl.at);
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, plays: [] });
    days[days.length - 1].plays.push(pl);
  }
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Videos picks are based on'),
      el('p', {}, 'What you played or queued here. "Related" picks start from the newest one and two random ones of the latest 15. Don\'t use: moves it to the list below, so it never steers your picks and never shows up as one. Forget: just removes it from here.'),
      ...(days.length
        ? days.map((day) => {
            const box = el('details', { class: 'tune-day' },
              el('summary', {}, day.label, el('span', {}, `${day.plays.length} video${day.plays.length === 1 ? '' : 's'}`)),
              ...day.plays.map((pl) => videoRow(pl,
                el('button', { class: 'chip danger-text', onclick: () => setExcluded(pl, true) }, "Don't use"),
                el('button', { class: 'chip', onclick: () => { T.plays = T.plays.filter((x) => x.videoId !== pl.videoId); store.saveTaste(); debug.log('app', `tune: forgot play ${pl.videoId}`); renderTuneView(); } }, 'Forget')
              ))
            );
            box.open = TUNE.openDays.has(day.label);
            box.addEventListener('toggle', () => { if (box.open) TUNE.openDays.add(day.label); else TUNE.openDays.delete(day.label); });
            return box;
          })
        : [el('p', {}, 'Nothing yet.')]),
      el('div', { class: 'row' },
        T.plays.length ? el('button', { class: 'btn ghost small danger', onclick: () => { if (!confirm('Forget every played and queued video? Channels you pinned or blocked, your keywords and the "don\'t use" list stay.')) return; T.plays = []; store.saveTaste(); debug.log('app', 'tune: forgot all plays'); renderTuneView(); } }, 'Forget all') : null
      )
    )
  );
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, `Don't use (${T.excluded.length})`),
      el('p', {}, 'Videos you watched but do not want more of. They are never a starting point for picks and never appear as a pick. Playing one again does not put it back.'),
      ...(T.excluded.length
        ? T.excluded.map((x) => videoRow(x, el('button', { class: 'chip', onclick: () => setExcluded(x, false) }, 'Use again'), el('button', { class: 'chip', onclick: () => { T.excluded = T.excluded.filter((y) => y.videoId !== x.videoId); store.saveTaste(); debug.log('app', `tune: removed ${x.videoId} from don't use`); renderTuneView(); } }, 'Remove')))
        : [el('p', {}, 'None yet.')])
    )
  );

  // --- Hidden videos + reset
  panels.push(
    el('div', { class: 'panel' },
      el('h3', {}, 'Hidden videos and reset'),
      el('div', { class: 'kv' }, 'Videos you swiped away or hid', el('b', {}, String(store.hidden.length))),
      el('div', { class: 'row' },
        el('button', { class: 'btn ghost small', disabled: store.hidden.length === 0, onclick: () => { if (!confirm(`Let all ${store.hidden.length} hidden videos show up again?`)) return; for (const id of store.hidden.slice()) store.unhide(id); debug.log('app', 'tune: unhid all videos'); renderTuneView(); } }, 'Unhide all'),
        el('button', { class: 'btn ghost small danger', onclick: () => { if (!confirm('Erase everything on this page: watched videos, the excluded-videos list, discovered channels, pins, blocks and keywords?')) return; store.resetTaste(); MIX.pool = []; debug.log('app', 'tune: reset everything'); renderTuneView(); } }, 'Reset everything here')
      )
    )
  );

  $('#view-tune').replaceChildren(el('div', { class: 'settings' }, ...panels));
  resolveChannels([...pinned, ...blocked, ...shown]).catch(showError);
}

async function checkAvailability() {
  const res = await api('/api/lounge/availability', { method: 'POST', body: { loungeToken: store.settings.screen.loungeToken } });
  toast(res.online ? 'The TV is online and reachable.' : `YouTube reports the TV as "${res.status}". Open the YouTube app on the Xbox.`, { error: !res.online });
}
async function forgetTv() {
  if (!confirm('Forget this TV? You will need the TV code again.')) return;
  if (remote.connected) await remote.disconnect();
  store.settings.screen = null;
  store.saveSettings();
  ui.owned = false;
  renderTvChip();
  renderTvView();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
prewarm();
debug.log('app', 'app start', { standalone: window.matchMedia('(display-mode: standalone)').matches, paired: Boolean(store.settings.screen), queue: Q.items.length });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(showError);
renderTvChip();
renderMini();
renderQueue();
showView('home');
if (store.settings.screen && store.settings.autoConnect) remote.connect().catch(showError);
