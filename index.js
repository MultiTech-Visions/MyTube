'use strict';

/**
 * MyTube — one HTTP Cloud Run function.
 *
 *   GET  /                      the phone web app (static files in /public)
 *   GET  /api/feed              Home recommendations        ?continuation=
 *   GET  /api/search            Search                      ?q=  ?continuation=
 *   GET  /api/watch             Video info+chapters+related ?id= ?continuation=
 *   GET  /api/comments          Comments / replies          ?continuation=
 *   GET  /api/library/history   Watch history (cookies)     ?continuation=
 *   GET  /api/library/playlists Your playlists (cookies)    ?continuation=
 *   GET  /api/playlist          Playlist videos             ?id=WL|LL|PL… ?continuation=
 *   POST /api/rate              { videoId, rating: like|dislike|none }
 *   GET  /api/save-options      ?videoId=  -> playlists with "already contains" flags
 *   POST /api/playlist/edit     { playlistId, videoId, action: add|remove }
 *   POST /api/playlist/create   { title, videoId? }
 *   GET  /api/sponsorblock      SponsorBlock segments       ?id=
 *   POST /api/lounge/pair       { code }                     -> screen + lounge token
 *   POST /api/lounge/refresh    { screenId }                 -> new lounge token
 *   POST /api/lounge/availability { loungeToken }            -> { online }
 *   POST /api/lounge/disconnect { ...session }               -> tells the TV this remote left
 *   POST /api/lounge/connect    { loungeToken, deviceId, name, rid }
 *   GET  /api/lounge/events     ?loungeToken&deviceId&name&sid&gsessionid&aid   (NDJSON stream)
 *   POST /api/lounge/command    { session:{...}, commands:[{name, params}] }
 *
 * Cookies for personalised results come from the "X-YT-Cookies" request header
 * (pasted into the app's Settings and kept in the phone's browser) or, if that
 * header is absent, from the YT_COOKIES environment variable on Cloud Run.
 */

const functions = require('@google-cloud/functions-framework');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const innertube = require('./lib/innertube');
const sponsorblock = require('./lib/sponsorblock');
const tv = require('./lib/session');
const lounge = require('./lib/lounge');
const { HttpError, jsonBody, requireString, sendJson, sendError } = require('./lib/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.path === '/' ? '/index.html' : req.path);
  const target = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(404, 'NOT_FOUND', `No such file: ${urlPath}`);
    throw e;
  }
  if (!stat.isFile()) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  const ext = path.extname(target).toLowerCase();
  if (!(ext in MIME)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
  res.status(200);
  res.set('Content-Type', MIME[ext]);
  // App code must never be served stale after a redeploy: a new app.js with an old icons.js breaks
  // the page. Code revalidates every time (ETag keeps that cheap); only images may be cached.
  const isCode = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || ext === '.webmanifest';
  const body = fs.readFileSync(target);
  // Content hash, not mtime: container builds can stamp every file with the same time.
  const etag = `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', isCode ? 'no-cache' : 'public, max-age=86400');
  if (req.get('If-None-Match') === etag) {
    res.status(304);
    res.end();
    return;
  }
  res.end(body);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function cookiesFor(req) {
  const fromHeader = req.get('X-YT-Cookies');
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    // Header values arrive URI-encoded so that any byte survives the trip.
    return innertube.normaliseCookies(decodeURIComponent(fromHeader));
  }
  if (process.env.YT_COOKIES && process.env.YT_COOKIES.trim()) return innertube.normaliseCookies(process.env.YT_COOKIES);
  return '';
}

// ---------------------------------------------------------------------------
// Lounge session object shared by connect/events/command
// ---------------------------------------------------------------------------

function sessionFrom(src, { needChannel }) {
  const session = {
    loungeToken: requireString(src, 'loungeToken', 'session'),
    deviceId: requireString(src, 'deviceId', 'session'),
    name: requireString(src, 'name', 'session'),
    rid: Number(src.rid),
    ofs: Number(src.ofs),
    aid: Number(src.aid),
    sid: src.sid,
    gsessionid: src.gsessionid,
  };
  if (!Number.isInteger(session.rid)) throw new HttpError(400, 'BAD_REQUEST', 'session.rid must be an integer');
  if (needChannel) {
    if (typeof session.sid !== 'string' || typeof session.gsessionid !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'session.sid and session.gsessionid are required');
    }
    if (!Number.isInteger(session.aid)) throw new HttpError(400, 'BAD_REQUEST', 'session.aid must be an integer');
  }
  return session;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function api(req, res) {
  const route = `${req.method} ${req.path}`;
  switch (route) {
    case 'GET /api/feed': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      return sendJson(res, 200, await innertube.home(cookiesFor(req), cont));
    }
    case 'GET /api/search': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      const q = cont ? '' : requireString(req.query, 'q', 'query');
      return sendJson(res, 200, await innertube.search(cookiesFor(req), q, cont));
    }
    case 'GET /api/watch': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      const id = cont ? '' : requireString(req.query, 'id', 'query');
      return sendJson(res, 200, await innertube.watch(cookiesFor(req), id, cont));
    }
    case 'GET /api/library/history': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      return sendJson(res, 200, await innertube.history(cookiesFor(req), cont));
    }
    case 'GET /api/library/playlists': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      return sendJson(res, 200, await innertube.playlists(cookiesFor(req), cont));
    }
    case 'GET /api/playlist': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      const id = cont ? '' : requireString(req.query, 'id', 'query');
      return sendJson(res, 200, await innertube.playlist(cookiesFor(req), id, cont));
    }
    case 'POST /api/rate': {
      const body = jsonBody(req);
      return sendJson(res, 200, await innertube.rate(cookiesFor(req), requireString(body, 'videoId', 'body'), requireString(body, 'rating', 'body')));
    }
    case 'GET /api/save-options': {
      return sendJson(res, 200, await innertube.saveOptions(cookiesFor(req), requireString(req.query, 'videoId', 'query')));
    }
    case 'POST /api/playlist/edit': {
      const body = jsonBody(req);
      return sendJson(res, 200, await innertube.editPlaylist(cookiesFor(req), requireString(body, 'playlistId', 'body'), requireString(body, 'videoId', 'body'), requireString(body, 'action', 'body')));
    }
    case 'POST /api/playlist/create': {
      const body = jsonBody(req);
      return sendJson(res, 200, await innertube.createPlaylist(cookiesFor(req), requireString(body, 'title', 'body'), typeof body.videoId === 'string' ? body.videoId : null));
    }
    case 'GET /api/ping': {
      return sendJson(res, 200, { ok: true, instance: tv.INSTANCE.id, upSeconds: Math.round((Date.now() - tv.INSTANCE.startedAt) / 1000), sessions: tv.sessions.size });
    }
    case 'GET /api/cookies/status': {
      return sendJson(res, 200, { source: req.get('X-YT-Cookies') ? 'phone' : process.env.YT_COOKIES ? 'server' : 'none', jar: innertube.jarStatus(cookiesFor(req)) });
    }
    case 'GET /api/subscriptions': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      return sendJson(res, 200, await innertube.subscriptions(cookiesFor(req), cont));
    }
    case 'GET /api/channel': {
      const cont = typeof req.query.continuation === 'string' ? req.query.continuation : null;
      const id = cont ? '' : requireString(req.query, 'id', 'query');
      const tab = typeof req.query.tab === 'string' ? req.query.tab : 'videos';
      const q = typeof req.query.q === 'string' ? req.query.q : null;
      return sendJson(res, 200, await innertube.channel(cookiesFor(req), id, tab, q, cont));
    }
    case 'POST /api/feedback': {
      return sendJson(res, 200, await innertube.feedback(cookiesFor(req), requireString(jsonBody(req), 'token', 'body')));
    }
    case 'GET /api/sponsorblock': {
      return sendJson(res, 200, await sponsorblock.segments(requireString(req.query, 'id', 'query')));
    }
    case 'GET /api/comments': {
      return sendJson(res, 200, await innertube.comments(cookiesFor(req), requireString(req.query, 'continuation', 'query')));
    }
    // --- Server-side TV session (the phone attaches to it) ---
    case 'POST /api/remote/attach': {
      const body = jsonBody(req);
      if (!body.screen || typeof body.screen !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'body.screen is required');
      requireString(body.screen, 'screenId', 'screen');
      requireString(body.screen, 'loungeToken', 'screen');
      if (!body.ads || typeof body.ads !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'body.ads is required');
      const selfUrl = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
      return sendJson(res, 200, await tv.attach({ screen: body.screen, deviceId: requireString(body, 'deviceId', 'body'), name: requireString(body, 'name', 'body'), ads: body.ads, selfUrl, queue: body.queue }));
    }
    case 'GET /api/remote/events': {
      const s = tv.get(requireString(req.query, 'screenId', 'query'));
      let cursor = Number(req.query.cursor);
      if (!Number.isInteger(cursor)) throw new HttpError(400, 'BAD_REQUEST', 'cursor must be an integer');
      res.status(200);
      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.set('X-Accel-Buffering', 'no');
      res.flushHeaders();
      let gone = false;
      req.on('close', () => (gone = true));
      const until = Date.now() + 25000;
      while (!gone && !s.closed && Date.now() < until) {
        const items = await s.since(cursor, until - Date.now());
        for (const it of items) {
          res.write(JSON.stringify(it) + '\n');
          cursor = it.seq;
        }
        s.lastPhoneAt = Date.now();
      }
      if (s.closed) res.write(JSON.stringify({ closed: true }) + '\n');
      return res.end();
    }
    case 'POST /api/remote/command': {
      const body = jsonBody(req);
      const s = tv.get(requireString(body, 'screenId', 'body'));
      const params = body.params === undefined ? {} : body.params;
      return sendJson(res, 200, await s.send(requireString(body, 'name', 'body'), params));
    }
    case 'POST /api/remote/settings': {
      const body = jsonBody(req);
      const s = tv.get(requireString(body, 'screenId', 'body'));
      if (!body.ads || typeof body.ads !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'body.ads is required');
      s.ads = { ...body.ads };
      s.log('ad settings updated', s.ads);
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/remote/dodge': {
      const body = jsonBody(req);
      const s = tv.get(requireString(body, 'screenId', 'body'));
      if (Array.isArray(body.queue) && body.queue.every((id) => typeof id === 'string')) s.phoneQueue = body.queue;
      return sendJson(res, 200, await s.dodge('button'));
    }
    case 'POST /api/remote/close': {
      const s = tv.get(requireString(jsonBody(req), 'screenId', 'body'));
      s.close('closed from the phone');
      return sendJson(res, 200, { ok: true });
    }
    case 'GET /api/remote/hold': {
      // Not via tv.get(): the hold request must not count as phone activity, or the session would never idle out.
      const s = tv.sessions.get(requireString(req.query, 'screenId', 'query'));
      if (!s) throw new HttpError(404, 'SESSION_GONE', 'No session to hold');
      await s.holdOpen();
      return sendJson(res, 200, { ok: true, closed: s.closed });
    }
    case 'POST /api/lounge/pair': {
      const body = jsonBody(req);
      return sendJson(res, 200, await lounge.pairWithCode(requireString(body, 'code', 'body')));
    }
    case 'POST /api/lounge/refresh': {
      const body = jsonBody(req);
      return sendJson(res, 200, await lounge.refreshToken(requireString(body, 'screenId', 'body')));
    }
    case 'POST /api/lounge/availability': {
      const body = jsonBody(req);
      return sendJson(res, 200, await lounge.availability(requireString(body, 'loungeToken', 'body')));
    }
    case 'POST /api/lounge/disconnect': {
      return sendJson(res, 200, await lounge.disconnect(sessionFrom(jsonBody(req), { needChannel: true })));
    }
    case 'POST /api/lounge/connect': {
      const session = sessionFrom(jsonBody(req), { needChannel: false });
      return sendJson(res, 200, await lounge.connect(session));
    }
    case 'POST /api/lounge/command': {
      const body = jsonBody(req);
      if (!body.session || typeof body.session !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'body.session is required');
      const session = sessionFrom(body.session, { needChannel: true });
      if (!Number.isInteger(session.ofs)) throw new HttpError(400, 'BAD_REQUEST', 'session.ofs must be an integer');
      const started = Date.now();
      const result = await lounge.sendCommands(session, body.commands);
      res.set('Server-Timing', `youtube;dur=${Date.now() - started}`);
      return sendJson(res, 200, result);
    }
    case 'GET /api/lounge/events': {
      const session = sessionFrom(req.query, { needChannel: true });
      const abort = new AbortController();
      req.on('close', () => abort.abort());
      const upstream = await lounge.openEvents(session, abort.signal); // throws with a real status on failure
      res.status(200);
      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.set('X-Accel-Buffering', 'no');
      res.flushHeaders();
      try {
        await lounge.pumpEvents(upstream, (ev) => res.write(JSON.stringify(ev) + '\n'));
      } catch (e) {
        if (abort.signal.aborted) return res.end(); // phone went away; nothing to report to
        throw e; // sendError appends an error line and ends the stream
      }
      return res.end();
    }
    default:
      throw new HttpError(404, 'NOT_FOUND', `No route ${route}`);
  }
}

functions.http('mytube', async (req, res) => {
  try {
    // The phone is the long-term keeper of the cookies, so the server can scale to zero.
    // Every API response carries the current (possibly just-rotated) copy back whenever it
    // differs from what the phone sent. YT_COOKIES only seeds a phone that has none yet.
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/lounge/')) {
      const sent = req.get('X-YT-Cookies');
      const sentSeed = typeof sent === 'string' && sent.trim() ? innertube.normaliseCookies(decodeURIComponent(sent)) : '';
      const seed = cookiesFor(req);
      if (seed) {
        const origEnd = res.end.bind(res);
        res.end = (chunk, ...rest) => {
          const latest = innertube.currentCookies(seed);
          if (!res.headersSent && latest && latest !== sentSeed) res.set('X-YT-Cookies-Updated', encodeURIComponent(latest));
          return origEnd(chunk, ...rest);
        };
      }
    }
    if (req.path.startsWith('/api/')) await api(req, res);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res);
    else throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed`);
  } catch (err) {
    sendError(res, err);
  }
});
