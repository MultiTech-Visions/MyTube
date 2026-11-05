/**
 * MyTube UI. Vanilla JS, no framework.
 *
 * The queue you see is YOUR queue, stored on the phone. The TV is told about
 * it (setPlaylist / addVideo / insertVideo / removeVideo) but can never erase
 * it: if the TV loses the queue, one tap pushes it back, resuming where the
 * last known position was.
 */
import { api, feed as apiFeed, search as apiSearch, watch as apiWatch, comments as apiComments, history as apiHistory, playlists as apiPlaylists, playlist as apiPlaylist, rate as apiRate, saveOptions as apiSaveOptions, editPlaylist as apiEditPlaylist, createPlaylist as apiCreatePlaylist } from './api.js';
import { store } from './store.js';
import { Remote, PLAYER_STATE } from './lounge.js';
import { icon } from './icons.js';
import * as debug from './debug.js';

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
  debug.log('error', `${e && e.message ? e.message : String(e)}`, e && e.code ? { code: e.code, detail: e.detail } : e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : undefined);
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
  feed: { items: [], continuation: null, loading: false, loaded: false, signedIn: null },
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
  if (name === 'home' && !ui.feed.loaded) loadFeed(true).catch(showError);
  if (name === 'search') setTimeout(() => $('#search-input').focus(), 50);
  if (name === 'queue') renderQueue();
  if (name === 'tv') renderTvView();
  if (name === 'library' && !ui.library.loaded) loadLibrary(true).catch(showError);
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('.navbtn')) b.addEventListener('click', () => showView(b.dataset.view));
$('#brand').addEventListener('click', () => showView('home'));
$('#tvchip').addEventListener('click', () => showView('tv'));
$('#btn-refresh').addEventListener('click', guard(() => loadFeed(true)));

// ---------------------------------------------------------------------------
// Video cards
// ---------------------------------------------------------------------------
function card(v, { compact = false } = {}) {
  const sub = joinMeta(v.channel, v.views, v.published);
  return el(
    'button',
    { class: 'card', type: 'button', onclick: () => openSheet(v) },
    el('div', { class: 'thumb' }, el('img', { src: v.thumbnail, alt: '', loading: 'lazy' }), v.duration ? el('span', { class: `dur${v.isLive ? ' live' : ''}` }, v.duration) : null),
    el('div', { class: 'card-text' }, el('div', {}, el('div', { class: 'card-title' }, v.title), el('div', { class: 'card-sub' }, sub)))
  );
}

function renderList(container, items) {
  container.replaceChildren(...items.map((v) => card(v)));
}

// ---------------------------------------------------------------------------
// Home feed
// ---------------------------------------------------------------------------
async function loadFeed(reset) {
  const f = ui.feed;
  if (f.loading) return;
  if (!reset && !f.continuation) return;
  f.loading = true;
  $('#feed-loading').hidden = false;
  try {
    const res = await apiFeed(reset ? null : f.continuation);
    f.items = reset ? res.items : f.items.concat(res.items);
    f.continuation = res.continuation;
    f.signedIn = res.signedIn;
    f.loaded = true;
    renderList($('#feed-list'), f.items);
    const notice = $('#feed-notice');
    if (!res.signedIn) {
      notice.hidden = false;
      notice.className = 'notice warn';
      notice.replaceChildren(
        el('span', {}, store.settings.cookies ? 'YouTube is treating your cookies as signed out. Export a fresh set to get your recommendations back.' : 'Add your YouTube cookies in the TV tab to see your own recommendations here. Search works without them.'),
        el('button', { class: 'btn ghost small', onclick: () => showView('tv') }, 'Open TV tab')
      );
    } else {
      notice.hidden = true;
    }
    if (f.items.length === 0 && reset) {
      $('#feed-list').replaceChildren(el('p', { class: 'empty' }, res.signedIn ? 'YouTube returned an empty feed.' : 'Nothing to show without your account. Use Search, or add cookies in the TV tab.'));
    }
  } finally {
    f.loading = false;
    $('#feed-loading').hidden = true;
  }
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
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
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
async function pushQueue(index, seconds) {
  if (Q.items.length === 0) throw new Error('The queue is empty');
  if (!remote.connected) throw new Error('Not connected to the TV. Open the TV tab to connect.');
  debug.log('app', `pushQueue: ${Q.items.length} videos, start #${index + 1} at ${Math.floor(seconds)}s`, Q.items.map((it) => it.videoId));
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
  debug.log('app', `playNow ${v.videoId}`, { title: v.title, connected: remote.connected, owned: ui.owned });
  store.rememberVideo(v);
  removeDuplicate(v.videoId);
  const at = insertAfterCurrent(queueItem(v));
  Q.currentIndex = at;
  saveQueue();
  if (!remote.connected) {
    toast('Queued. Connect to the TV to play it.');
    return;
  }
  await pushQueue(at, 0);
  toast(`Playing: ${v.title}`);
}

async function playNext(v) {
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

function clearQueue() {
  if (!confirm('Clear the whole queue? The TV keeps playing the current video.')) return;
  debug.log('app', 'queue cleared by user');
  Q.items = [];
  Q.currentIndex = -1;
  ui.owned = false;
  ui.stale = false;
  saveQueue();
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
$('#np-close').addEventListener('click', closeNowPlaying);
$('#np-play').addEventListener('click', guard(togglePlay));
$('#np-prev').addEventListener('click', guard(() => remote.previous()));
$('#np-next').addEventListener('click', guard(() => remote.next()));
$('#np-back').addEventListener('click', guard(() => remote.seekTo(remote.estimatedTime() - 10)));
$('#np-fwd').addEventListener('click', guard(() => remote.seekTo(remote.estimatedTime() + 10)));
$('#np-skip').addEventListener('click', guard(() => remote.skipAd()));
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
  if (!(d > 0) || chapters.length < 2) {
    track.replaceChildren();
    return;
  }
  track.replaceChildren(...chapters.slice(1).map((c) => el('div', { class: 'gap', style: `left:${(c.start / d) * 100}%` })));
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
// Remote wiring
// ---------------------------------------------------------------------------
function renderTvChip() {
  const chip = $('#tvchip');
  const screen = store.settings.screen;
  chip.className = `tvchip ${remote.status}${remote.status === 'disconnected' && remote.statusDetail ? ' error' : ''}`;
  $('.label', chip).textContent = remote.connected ? remote.screenName || screen.name : remote.status === 'connecting' ? 'Connecting…' : screen ? 'Tap to connect' : 'No TV';
}

remote.addEventListener('status', () => {
  if (remote.status !== 'connected') ui.owned = false;
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
    ui.comments = null;
    ui.descOpen = false;
    if (pl.videoId) {
      syncCurrentFromTv();
      loadWatch(pl.videoId).catch(showError);
    }
  }
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
  debug.log('app', `app ${document.visibilityState}`, { status: remote.status, tvVideo: remote.player.videoId, state: remote.player.state });
  if (document.visibilityState !== 'visible') return;
  if (remote.connected) remote.resume().catch(showError);
  else if (store.settings.screen && store.settings.autoConnect) remote.connect().catch(showError);
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
            ? el('button', { class: 'btn ghost', onclick: guard(() => remote.disconnect()) }, 'Disconnect')
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
      el('p', {}, 'Your Home recommendations come from your account. Paste your youtube.com cookies (exported from a desktop browser with a "cookies.txt" extension, from a fresh private window that you then close without signing out). They stay in this phone\'s browser and are only sent to your own MyTube server.'),
      el('p', { class: ui.feed.signedIn === true ? 'ok' : ui.feed.signedIn === false && s.cookies ? 'bad' : '' }, ui.feed.signedIn === true ? 'Status: personalised feed is working.' : ui.feed.signedIn === false && s.cookies ? 'Status: cookies saved but YouTube says signed out. Export a fresh set.' : s.cookies ? 'Status: cookies saved, not tested yet.' : 'Status: no cookies — anonymous mode (Search works, Home is empty).'),
      ta,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', onclick: guard(async () => { s.cookies = ta.value.trim(); store.saveSettings(); ui.feed.loaded = false; await loadFeed(true); toast(ui.feed.signedIn ? 'Signed in — feed loaded' : 'Saved, but YouTube still sees you as signed out', { error: !ui.feed.signedIn }); renderTvView(); }) }, 'Save & test'),
        el('button', { class: 'btn ghost', onclick: () => { ta.value = ''; s.cookies = ''; store.saveSettings(); ui.feed.loaded = false; renderTvView(); } }, 'Remove')
      )
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
debug.log('app', 'app start', { standalone: window.matchMedia('(display-mode: standalone)').matches, paired: Boolean(store.settings.screen), queue: Q.items.length });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(showError);
renderTvChip();
renderMini();
renderQueue();
showView('home');
if (store.settings.screen && store.settings.autoConnect) remote.connect().catch(showError);
