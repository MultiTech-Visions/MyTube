/**
 * Thin fetch wrapper for the MyTube backend. Every non-2xx response is thrown
 * as an ApiError carrying the server's own code/message, so the UI can show
 * exactly what went wrong instead of guessing.
 */
import { store } from './store.js';
import { log } from './debug.js';

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function cookieHeader() {
  const cookies = store.settings.cookies;
  return cookies ? { 'X-YT-Cookies': encodeURIComponent(cookies) } : {};
}

export async function api(path, { method = 'GET', body, signal, keepalive = false } = {}) {
  const headers = { ...cookieHeader() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    // keepalive lets a request finish even if the page is being closed (used for held actions)
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, keepalive });
  } catch (e) {
    log('error', `${method} ${path.split('?')[0]} network failure: ${e.message}`);
    throw e;
  }
  const updated = res.headers.get('X-YT-Cookies-Updated');
  if (updated) {
    const first = !store.settings.cookies;
    store.settings.cookies = decodeURIComponent(updated);
    store.saveSettings();
    log('app', first ? 'adopted YouTube cookies from the server; this phone keeps them from now on' : 'stored refreshed YouTube cookies from the server');
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ApiError(res.status, 'BAD_JSON', `Server returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    if (!json.error || typeof json.error.message !== 'string') {
      log('error', `${method} ${path.split('?')[0]} → HTTP ${res.status} without an error body`);
      throw new ApiError(res.status, 'UNKNOWN', `HTTP ${res.status} without an error body`, json);
    }
    const detail = typeof json.error.detail === 'string' ? json.error.detail.replace(/\s+/g, ' ').slice(0, 200) : json.error.detail;
    log('api', `${method} ${path.split('?')[0]} → ${res.status} ${json.error.code}: ${json.error.message}`, detail);
    const err = new ApiError(res.status, json.error.code, json.error.message, json.error.detail);
    err.logged = true; // showError() does not log it a second time
    throw err;
  }
  return json;
}

export const feed = (continuation) => api(`/api/feed${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ''}`);
export const search = (q, continuation) =>
  api(continuation ? `/api/search?continuation=${encodeURIComponent(continuation)}` : `/api/search?q=${encodeURIComponent(q)}`);
export const watch = (videoId, continuation) =>
  api(continuation ? `/api/watch?continuation=${encodeURIComponent(continuation)}` : `/api/watch?id=${encodeURIComponent(videoId)}`);
export const comments = (continuation) => api(`/api/comments?continuation=${encodeURIComponent(continuation)}`);
export const history = (continuation) => api(`/api/library/history${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ''}`);
export const playlists = (continuation) => api(`/api/library/playlists${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ''}`);
export const playlist = (id, continuation) =>
  api(continuation ? `/api/playlist?continuation=${encodeURIComponent(continuation)}` : `/api/playlist?id=${encodeURIComponent(id)}`);
export const rate = (videoId, rating) => api('/api/rate', { method: 'POST', body: { videoId, rating } });
export const saveOptions = (videoId) => api(`/api/save-options?videoId=${encodeURIComponent(videoId)}`);
export const editPlaylist = (playlistId, videoId, action, opts = {}) => api('/api/playlist/edit', { method: 'POST', body: { playlistId, videoId, action }, ...opts });
export const createPlaylist = (title, videoId) => api('/api/playlist/create', { method: 'POST', body: { title, videoId } });
export const subscriptions = (continuation) => api(`/api/subscriptions${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ''}`);
export const channelVideos = (id, continuation) =>
  api(continuation ? `/api/channel?continuation=${encodeURIComponent(continuation)}` : `/api/channel?id=${encodeURIComponent(id)}`);
export const channelPage = (id, tab, q, continuation) =>
  api(continuation ? `/api/channel?continuation=${encodeURIComponent(continuation)}` : `/api/channel?id=${encodeURIComponent(id)}&tab=${tab}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
export const sendFeedback = (token, opts = {}) => api('/api/feedback', { method: 'POST', body: { token }, ...opts });
export const sponsorSegments = (videoId) => api(`/api/sponsorblock?id=${encodeURIComponent(videoId)}`);
