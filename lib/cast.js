'use strict';

/**
 * "Send to TV screen": a tiny relay between the phone and the MyTube TV page
 * (/tv) open in Microsoft Edge on the Xbox. The TV page registers and shows a
 * 4-digit code; the phone sends items to that code; the TV page long-polls.
 * Everything is in memory (max instances = 1, like the TV session).
 */
const { HttpError } = require('./util');

const screens = new Map(); // code -> { seq, items: [], waiters: Set, seenAt }
const STALE_MS = 12 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [code, s] of screens) if (now - s.seenAt > STALE_MS) screens.delete(code);
}

/** The TV page asks for a code (or keeps the one it had, if still known). */
function register(previous) {
  sweep();
  if (previous && screens.has(previous)) {
    screens.get(previous).seenAt = Date.now();
    return { code: previous };
  }
  let code;
  do code = String(Math.floor(1000 + Math.random() * 9000));
  while (screens.has(code));
  screens.set(code, { seq: 0, items: [], waiters: new Set(), seenAt: Date.now() });
  return { code };
}

function screen(code) {
  const s = screens.get(code);
  if (!s) throw new HttpError(404, 'CAST_SCREEN_UNKNOWN', `No TV screen with code ${code}. Open /tv in Edge on the Xbox and use the code it shows.`);
  return s;
}

/** Phone -> TV: { kind: 'x' | 'video' | 'control', ... } */
function send(code, item) {
  const s = screen(code);
  s.seq += 1;
  s.items.push({ seq: s.seq, at: Date.now(), ...item });
  if (s.items.length > 50) s.items.splice(0, s.items.length - 50);
  for (const w of s.waiters) w();
  return { ok: true, seq: s.seq };
}

/** TV long-poll: items after `cursor`, waiting up to `ms`. */
async function wait(code, cursor, ms) {
  const s = screen(code);
  s.seenAt = Date.now();
  const ready = () => s.items.filter((i) => i.seq > cursor);
  if (ready().length) return ready();
  await new Promise((resolve) => {
    const w = () => {
      s.waiters.delete(w);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(w, ms);
    s.waiters.add(w);
  });
  return ready();
}

/** Turns a pasted link into something the TV page can show. */
function parseLink(raw) {
  const text = String(raw).trim();
  let url;
  try {
    url = new URL(text);
  } catch (e) {
    throw new HttpError(400, 'BAD_LINK', 'That is not a link. Paste the full address of the post or video.');
  }
  const host = url.hostname.replace(/^www\.|^mobile\./, '');
  if (['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com'].includes(host)) {
    const m = /\/status(?:es)?\/(\d+)/.exec(url.pathname);
    if (!m) throw new HttpError(400, 'BAD_LINK', 'That X link has no post id (it should look like x.com/name/status/123…).');
    return { kind: 'x', id: m[1], url: `https://x.com/i/status/${m[1]}` };
  }
  if (/\.(mp4|webm|m4v|mov)$/i.test(url.pathname) && (url.protocol === 'https:' || url.protocol === 'http:')) {
    return { kind: 'video', url: url.toString() };
  }
  throw new HttpError(400, 'UNSUPPORTED_LINK', 'Supported: X/Twitter post links and direct video files (.mp4, .webm). YouTube links: use Search instead.');
}

module.exports = { register, send, wait, parseLink };
