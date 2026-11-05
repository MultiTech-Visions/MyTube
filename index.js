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
const path = require('path');
const innertube = require('./lib/innertube');
const sponsorblock = require('./lib/sponsorblock');
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
  // index.html and the service worker must never be served stale after a redeploy.
  res.set('Cache-Control', ext === '.html' || target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600');
  res.end(fs.readFileSync(target));
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
    case 'GET /api/sponsorblock': {
      return sendJson(res, 200, await sponsorblock.segments(requireString(req.query, 'id', 'query')));
    }
    case 'GET /api/comments': {
      return sendJson(res, 200, await innertube.comments(cookiesFor(req), requireString(req.query, 'continuation', 'query')));
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
      return sendJson(res, 200, await lounge.sendCommands(session, body.commands));
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
    if (req.path.startsWith('/api/')) await api(req, res);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res);
    else throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed`);
  } catch (err) {
    sendError(res, err);
  }
});
