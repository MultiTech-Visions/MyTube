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

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { ...cookieHeader() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (e) {
    log('error', `${method} ${path.split('?')[0]} network failure: ${e.message}`);
    throw e;
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
    log('api', `${method} ${path.split('?')[0]} → ${res.status} ${json.error.code}: ${json.error.message}`, json.error.detail);
    throw new ApiError(res.status, json.error.code, json.error.message, json.error.detail);
  }
  return json;
}

export const feed = (continuation) => api(`/api/feed${continuation ? `?continuation=${encodeURIComponent(continuation)}` : ''}`);
export const search = (q, continuation) =>
  api(continuation ? `/api/search?continuation=${encodeURIComponent(continuation)}` : `/api/search?q=${encodeURIComponent(q)}`);
export const watch = (videoId, continuation) =>
  api(continuation ? `/api/watch?continuation=${encodeURIComponent(continuation)}` : `/api/watch?id=${encodeURIComponent(videoId)}`);
export const comments = (continuation) => api(`/api/comments?continuation=${encodeURIComponent(continuation)}`);
