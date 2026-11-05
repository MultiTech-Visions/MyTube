'use strict';

/**
 * YouTube Lounge API ("connect to TV" / MDx remote protocol) — server side.
 *
 * This is the same private API the official YouTube phone app uses when it
 * drives the YouTube app on a TV / Xbox. Everything goes through
 * www.youtube.com, so the phone does NOT need to be on the same LAN as the
 * screen once it is paired with the 12-digit "Link with TV code".
 *
 * Wire details follow pyytlounge 3.6 (Oct 2026), cross-checked with
 * @iobroker/youtube-lounge and desvaters/ytlounge (both verified on the wire
 * in autumn 2026).
 *
 * Flow:
 *   1. pairWithCode(code)        -> { screenId, loungeToken, name, expiration }
 *   2. refreshToken(screenId)    -> { loungeToken, expiration }       (tokens last ~13 days)
 *   3. connect(session)          -> opens a channel: { sid, gsessionid, aid, events[] }
 *   4. openEvents/pumpEvents    -> long-poll GET, yields events until YouTube closes it
 *   5. sendCommands(session)     -> POST one or more commands on the channel
 *   6. disconnect(session)       -> tells the TV this remote left
 *
 * The browser keeps the channel bookkeeping (sid, gsessionid, aid, rid, ofs);
 * this server is a stateless translator so it can run on Cloud Run.
 *
 * Wire format of bind responses ("browserchannel"): a sequence of
 *   <length>\n<json>
 * where <json> is normally [[eventId, [eventName, payload?]], ...]. A command
 * acknowledgement is the bare array [0,-1,0] in the same framing.
 */

const { HttpError, randomId } = require('./util');

const LOUNGE = 'https://www.youtube.com/api/lounge';
const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': UA,
  Origin: 'https://www.youtube.com',
};

function toMillis(v) {
  // get_screen used to return expiration as a number and now returns a string.
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

async function pairWithCode(code) {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 12) {
    throw new HttpError(400, 'BAD_CODE', `The TV code must have 12 digits, got ${digits.length}`);
  }
  const res = await fetch(`${LOUNGE}/pairing/get_screen`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({ pairing_code: digits }).toString(),
  });
  if (res.status === 404) {
    throw new HttpError(
      404,
      'CODE_NOT_FOUND',
      'YouTube does not recognise that TV code. On the Xbox open YouTube → Settings → "Link with TV code" and copy the code shown right now.'
    );
  }
  if (!res.ok) throw new HttpError(502, 'PAIR_FAILED', `get_screen returned HTTP ${res.status}`, await res.text());
  const json = await res.json();
  const screen = json.screen;
  if (!screen || typeof screen.screenId !== 'string' || typeof screen.loungeToken !== 'string') {
    throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'get_screen response had no screen.screenId/loungeToken', json);
  }
  return {
    screenId: screen.screenId,
    loungeToken: screen.loungeToken,
    name: typeof screen.name === 'string' && screen.name ? screen.name : 'YouTube on TV',
    expiration: toMillis(screen.expiration),
  };
}

async function refreshToken(screenId) {
  const res = await fetch(`${LOUNGE}/pairing/get_lounge_token_batch`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({ screen_ids: screenId }).toString(),
  });
  if (!res.ok) throw new HttpError(502, 'REFRESH_FAILED', `get_lounge_token_batch returned HTTP ${res.status}`, await res.text());
  const json = await res.json();
  const screen = Array.isArray(json.screens) ? json.screens.find((s) => s.screenId === screenId) : undefined;
  if (!screen || typeof screen.loungeToken !== 'string') {
    throw new HttpError(
      502,
      'SCREEN_GONE',
      'YouTube returned no lounge token for this screen. Pair the TV again with a fresh code.',
      json
    );
  }
  return { loungeToken: screen.loungeToken, expiration: toMillis(screen.expiration) };
}

/** Is the paired screen currently reachable by YouTube? */
async function availability(loungeToken) {
  const res = await fetch(`${LOUNGE}/pairing/get_screen_availability`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({ lounge_token: loungeToken }).toString(),
  });
  if (res.status === 401) throw new HttpError(401, 'TOKEN_EXPIRED', 'Lounge token rejected while checking availability');
  if (!res.ok) throw new HttpError(502, 'LOUNGE_HTTP', `get_screen_availability returned HTTP ${res.status}`, await res.text());
  const json = await res.json();
  const status = Array.isArray(json.screens) && json.screens[0] ? json.screens[0].status : undefined;
  if (typeof status !== 'string') throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'get_screen_availability had no screens[0].status', json);
  return { online: status === 'online', status };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Finds the end (exclusive) of the JSON array that starts at buf[start].
 * Returns -1 when the array is not complete yet. Respects strings/escapes.
 */
function jsonArrayEnd(buf, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Incremental parser for the "<length>\n<json>" framing. Feed it decoded text;
 * it returns the complete events found so far. The declared length is treated
 * as a hint only: the JSON array is delimited by bracket matching, which makes
 * the parser indifferent to whether YouTube counts bytes or characters.
 */
class ChunkParser {
  constructor() {
    this.buf = '';
  }
  /** @returns {Array<{id:number,name:string,payload:any}>} */
  push(text) {
    this.buf += text;
    const out = [];
    for (;;) {
      const trimmed = this.buf.replace(/^\s+/, '');
      if (trimmed !== this.buf) this.buf = trimmed;
      const nl = this.buf.indexOf('\n');
      if (nl === -1) break;
      const header = this.buf.slice(0, nl).trim();
      if (!/^\d+$/.test(header)) {
        throw new HttpError(502, 'LOUNGE_FRAMING', `Unexpected lounge chunk header: ${JSON.stringify(header.slice(0, 80))}`);
      }
      const end = jsonArrayEnd(this.buf, nl + 1);
      if (end === -1) break; // wait for more data
      const body = this.buf.slice(nl + 1, end);
      this.buf = this.buf.slice(end);
      let arr;
      try {
        arr = JSON.parse(body);
      } catch (e) {
        throw new HttpError(502, 'LOUNGE_FRAMING', `Lounge chunk was not valid JSON: ${e.message}`, body.slice(0, 200));
      }
      if (!Array.isArray(arr)) throw new HttpError(502, 'LOUNGE_FRAMING', 'Lounge chunk JSON was not an array', body.slice(0, 200));
      if (arr.every((x) => typeof x === 'number')) continue; // command acknowledgement, e.g. [0,-1,0]
      for (const entry of arr) {
        if (!Array.isArray(entry) || entry.length < 2 || !Array.isArray(entry[1])) {
          throw new HttpError(502, 'LOUNGE_FRAMING', 'Lounge event entry had an unexpected shape', entry);
        }
        out.push({ id: entry[0], name: entry[1][0], payload: entry[1].length > 1 ? entry[1][1] : null });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Channel (bind)
// ---------------------------------------------------------------------------

/** Query parameters shared by the long-poll, command and disconnect requests. */
function channelParams(session) {
  return {
    name: session.name,
    loungeIdToken: session.loungeToken,
    id: session.deviceId,
    SID: session.sid,
    gsessionid: session.gsessionid,
    AID: String(session.aid),
    device: 'REMOTE_CONTROL',
    app: 'youtube-desktop',
    VER: '8',
    v: '2',
    zx: randomId(12),
  };
}

function bindUrl(params) {
  return `${LOUNGE}/bc/bind?${new URLSearchParams(params).toString()}`;
}

/**
 * Maps upstream HTTP failures to codes the client acts on:
 *   401       -> TOKEN_EXPIRED  (refresh the lounge token, then reconnect)
 *   400 / 410 -> SESSION_LOST   (SID/gsessionid no longer valid, reconnect)
 *   404       -> SCREEN_GONE    (pair again)
 */
async function throwForStatus(res, what) {
  const text = await res.text();
  const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (res.status === 401) throw new HttpError(401, 'TOKEN_EXPIRED', `${what}: lounge token rejected (${snippet})`);
  if (res.status === 400 || res.status === 410) throw new HttpError(409, 'SESSION_LOST', `${what}: remote session no longer valid (${snippet})`);
  if (res.status === 404) throw new HttpError(404, 'SCREEN_GONE', `${what}: YouTube no longer knows this screen; pair again (${snippet})`);
  throw new HttpError(502, 'LOUNGE_HTTP', `${what}: YouTube returned HTTP ${res.status} (${snippet})`);
}

/**
 * Opens a new channel. Returns the session identifiers plus the initial burst
 * of events (loungeStatus, nowPlaying, playlistModified, ...). The browser
 * must reset rid to 1 and ofs to 0 after a successful connect.
 */
async function connect(session) {
  const query = { RID: '1', VER: '8', CVER: '1', auth_failure_option: 'send_error', zx: randomId(12) };
  const body = new URLSearchParams({
    app: 'web',
    'mdx-version': '3',
    name: session.name,
    id: session.deviceId,
    device: 'REMOTE_CONTROL',
    capabilities: 'que,dsdtr,atp,vsp',
    magnaKey: 'cloudPairedDevice',
    ui: 'false',
    deviceContext: 'user_agent=dunno&window_width_points=&window_height_points=&os_name=android&ms=',
    theme: 'cl',
    loungeIdToken: session.loungeToken,
  });
  const res = await fetch(bindUrl(query), { method: 'POST', headers: FORM_HEADERS, body: body.toString() });
  if (!res.ok) await throwForStatus(res, 'connect');
  const events = new ChunkParser().push(await res.text());
  let sid = null;
  let gsessionid = null;
  let aid = -1;
  for (const ev of events) {
    if (ev.name === 'c' && typeof ev.payload === 'string') sid = ev.payload;
    if (ev.name === 'S' && typeof ev.payload === 'string') gsessionid = ev.payload;
    if (typeof ev.id === 'number' && ev.id > aid) aid = ev.id;
  }
  if (!sid || !gsessionid) {
    throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'Lounge bind did not return a session id ("c") and gsessionid ("S")', events);
  }
  return { sid, gsessionid, aid, events: events.filter((e) => e.name !== 'c' && e.name !== 'S') };
}

/**
 * Long-poll GET, step 1: open the upstream request and validate its status so
 * that failures can still be reported with a real HTTP status. Returns the
 * fetch Response to hand to pumpEvents().
 */
async function openEvents(session, signal) {
  const params = { ...channelParams(session), RID: 'rpc', CI: '0', TYPE: 'xmlhttp' };
  const res = await fetch(bindUrl(params), { method: 'GET', headers: { 'User-Agent': UA, Origin: 'https://www.youtube.com' }, signal });
  if (!res.ok) await throwForStatus(res, 'events');
  return res;
}

/**
 * Long-poll GET, step 2: calls onEvent for each event as it arrives and
 * resolves when YouTube closes the response.
 */
async function pumpEvents(res, onEvent) {
  const parser = new ChunkParser();
  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
  }
  for (const ev of parser.push(decoder.decode())) onEvent(ev);
}

/**
 * Sends one or more commands. `commands` is [{ name, params }] where params is
 * a flat object of strings/numbers (empty strings are allowed and meaningful:
 * the Xbox needs listId=, params=, playerParams= present on setPlaylist).
 */
async function sendCommands(session, commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'commands must be a non-empty array');
  }
  const form = new URLSearchParams();
  form.set('count', String(commands.length));
  form.set('ofs', String(session.ofs));
  commands.forEach((cmd, i) => {
    if (typeof cmd.name !== 'string' || !cmd.name) throw new HttpError(400, 'BAD_REQUEST', `commands[${i}].name is required`);
    form.set(`req${i}__sc`, cmd.name);
    const params = cmd.params === undefined ? {} : cmd.params;
    if (params === null || typeof params !== 'object') throw new HttpError(400, 'BAD_REQUEST', `commands[${i}].params must be an object`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) throw new HttpError(400, 'BAD_REQUEST', `commands[${i}].params.${k} is ${v}`);
      form.set(`req${i}_${k}`, String(v));
    }
  });
  const params = { ...channelParams(session), RID: String(session.rid), CVER: '1' };
  const res = await fetch(bindUrl(params), { method: 'POST', headers: FORM_HEADERS, body: form.toString() });
  if (!res.ok) await throwForStatus(res, `command ${commands.map((c) => c.name).join(',')}`);
  const text = await res.text();
  const events = text.trim().length === 0 ? [] : new ChunkParser().push(text);
  return { ok: true, events };
}

/** Tells the TV this remote is leaving so it stops listing it. */
async function disconnect(session) {
  const params = { ...channelParams(session), RID: String(session.rid), CVER: '1' };
  const body = new URLSearchParams({
    ui: '',
    TYPE: 'terminate',
    clientDisconnectReason: 'MDX_SESSION_DISCONNECT_REASON_DISCONNECTED_BY_USER',
  });
  const res = await fetch(bindUrl(params), { method: 'POST', headers: FORM_HEADERS, body: body.toString() });
  if (!res.ok) await throwForStatus(res, 'disconnect');
  return { ok: true };
}

module.exports = { pairWithCode, refreshToken, availability, connect, openEvents, pumpEvents, sendCommands, disconnect, ChunkParser };
