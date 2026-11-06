'use strict';

/**
 * InnerTube (YouTube's private web API) — the calls the official clients make.
 *
 *   home(cookies, continuation)      -> personalised Home feed   (browse FEwhat_to_watch)
 *   search(cookies, query, cont)     -> search results           (search)
 *   watch(cookies, videoId, cont)    -> video info + chapters + related ("up next") (next)
 *
 * Authentication is the same mechanism yt-dlp uses with --cookies: the user's
 * exported youtube.com cookies plus an "Authorization: SAPISIDHASH ..." header
 * derived from the SAPISID cookie. Without cookies the calls still work but are
 * anonymous (generic feed, non-personalised related videos).
 *
 * Every video-shaped item is normalised to:
 *   { videoId, title, channel, duration, views, published, thumbnail, isLive }
 * YouTube is mid-migration from *Renderer objects to *ViewModel objects, so both
 * shapes are handled. Shorts, playlists, channels and ads are skipped.
 */

const crypto = require('crypto');
const { HttpError, need, opt } = require('./util');

const ORIGIN = 'https://www.youtube.com';
const CLIENT_VERSION = process.env.INNERTUBE_CLIENT_VERSION || '2.20251101.00.00';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Rating calls go through the TV client, as youtubei.js does; the WEB client wants extra params for them.
const CLIENTS = {
  WEB: { name: 'WEB', version: CLIENT_VERSION, id: '1', ua: UA },
  TV: { name: 'TVHTML5', version: process.env.INNERTUBE_TV_CLIENT_VERSION || '7.20260311.12.00', id: '7', ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version' },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Pulls SAPISID (or __Secure-3PAPISID) out of a raw Cookie header string. */
function sapisidFrom(cookieHeader) {
  const m = /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/.exec(cookieHeader);
  return m ? m[1] : null;
}

function authHeaders(cookieHeader, client) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': client.ua,
    Origin: ORIGIN,
    'X-Origin': ORIGIN,
    'X-Youtube-Client-Name': client.id,
    'X-Youtube-Client-Version': client.version,
  };
  if (!cookieHeader) return headers;
  const sapisid = sapisidFrom(cookieHeader);
  if (!sapisid) {
    throw new HttpError(
      400,
      'COOKIES_INVALID',
      'The cookie string has no SAPISID cookie, so it cannot be used to sign requests. Export cookies while signed in to youtube.com.'
    );
  }
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${ORIGIN}`).digest('hex');
  headers.Cookie = cookieHeader;
  headers.Authorization = `SAPISIDHASH ${ts}_${hash}`;
  headers['X-Goog-AuthUser'] = '0';
  headers['X-Youtube-Bootstrap-Logged-In'] = 'true';
  return headers;
}

/**
 * Accepts either a raw "a=b; c=d" Cookie header or Netscape cookies.txt text
 * (what browser extensions export) and returns a Cookie header string.
 */
function normaliseCookies(raw) {
  const text = raw.trim();
  if (!text) return '';
  // Cookie-Editor's default export: JSON array of { name, value, domain, ... }.
  if (text.startsWith('[')) {
    let list;
    try {
      list = JSON.parse(text);
    } catch (e) {
      throw new HttpError(400, 'COOKIES_INVALID', `Cookie text starts with "[" but is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(list)) throw new HttpError(400, 'COOKIES_INVALID', 'Cookie JSON must be an array');
    const pairs = list
      .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && (typeof c.domain !== 'string' || /youtube\.com$|google\.com$/.test(c.domain)))
      .map((c) => `${c.name}=${c.value}`);
    if (pairs.length === 0) throw new HttpError(400, 'COOKIES_INVALID', 'Cookie JSON contained no youtube.com / google.com cookies');
    return pairs.join('; ');
  }
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const looksLikeNetscape = lines.length > 0 && lines.every((l) => l.split('\t').length >= 7);
  if (!looksLikeNetscape) return text.replace(/\s*\n\s*/g, ' ');
  const pairs = [];
  for (const line of lines) {
    const cols = line.split('\t');
    const domain = cols[0];
    if (!/youtube\.com$|google\.com$/.test(domain)) continue;
    pairs.push(`${cols[5]}=${cols[6]}`);
  }
  if (pairs.length === 0) throw new HttpError(400, 'COOKIES_INVALID', 'cookies.txt contained no youtube.com / google.com cookies');
  return pairs.join('; ');
}

// ---------------------------------------------------------------------------
// Cookie jar: behave like a browser so the session stays alive
// ---------------------------------------------------------------------------
//
// YouTube rotates part of the login (__Secure-1PSIDTS, SIDCC, ...) every few
// minutes and sends the new values back as Set-Cookie. A browser saves them;
// a server that keeps re-sending the pasted copy gets "signed out" soon after.
// So every pasted cookie string seeds a jar that absorbs each Set-Cookie, and
// the jar is rotated through the same endpoint browsers use.
// The jar lives in this instance's memory (keep min instances = 1).

const jars = new Map(); // seed cookie string -> { cookies: Map, rotatedAt, lastRotateError }
const ROTATE_EVERY_MS = 9 * 60 * 1000;

function jarFor(seed) {
  let jar = jars.get(seed);
  if (!jar) {
    const cookies = new Map();
    for (const part of seed.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) cookies.set(part.slice(0, i).trim(), part.slice(i + 1));
    }
    jar = { cookies, rotatedAt: 0, lastRotateError: null };
    jars.set(seed, jar);
  }
  return jar;
}
function jarString(jar) {
  return [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}
/** Merges a response's Set-Cookie headers into the jar. Returns the names that changed. */
function absorb(jar, res) {
  const changed = [];
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1);
    const domain = /;\s*domain=([^;]+)/i.exec(line);
    if (domain && !/(^|\.)(youtube|google)\.com$/i.test(domain[1].trim())) continue;
    const expired = /;\s*max-age=0/i.test(line) || /expires=[^;]*1970/i.test(line) || value === '' || value === 'EXPIRED';
    if (expired) {
      if (jar.cookies.delete(name)) changed.push(`-${name}`);
    } else if (jar.cookies.get(name) !== value) {
      jar.cookies.set(name, value);
      changed.push(name);
    }
  }
  if (changed.length) console.log(`[cookies] updated from ${res.url.split('?')[0]}: ${changed.join(', ')}`);
  return changed;
}

/** What a browser's open YouTube tab does every few minutes to keep __Secure-1PSIDTS fresh. */
async function rotate(jar) {
  const res = await fetch('https://accounts.youtube.com/RotateCookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: ORIGIN, Referer: `${ORIGIN}/`, Cookie: jarString(jar) },
    body: '[000,"-0000000000000000000"]',
  });
  const changed = absorb(jar, res);
  jar.rotatedAt = Date.now();
  jar.lastRotateError = res.ok ? null : `HTTP ${res.status}`;
  console.log(`[cookies] rotate: HTTP ${res.status}, changed: ${changed.join(', ') || 'nothing'}`);
  return res.ok;
}

/** Current cookies for a seed (what the phone should store if it holds the cookies). */
function currentCookies(seed) {
  return seed ? jarString(jarFor(seed)) : '';
}
function jarStatus(seed) {
  if (!seed) return null;
  const jar = jarFor(seed);
  return { cookies: jar.cookies.size, rotatedAt: jar.rotatedAt ? new Date(jar.rotatedAt).toISOString() : null, lastRotateError: jar.lastRotateError };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function call(endpoint, cookieHeader, body, clientKey = 'WEB', retried = false) {
  const client = CLIENTS[clientKey];
  const jar = cookieHeader ? jarFor(cookieHeader) : null;
  if (jar && Date.now() - jar.rotatedAt > ROTATE_EVERY_MS) {
    // Rotation failing is not fatal by itself: the request below says whether the session still works.
    await rotate(jar).catch((e) => {
      jar.rotatedAt = Date.now();
      jar.lastRotateError = e.message;
      console.error('[cookies] rotate failed:', e.message);
    });
  }
  const payload = {
    context: { client: { clientName: client.name, clientVersion: client.version, hl: 'en', gl: 'US' } },
    ...body,
  };
  const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: authHeaders(jar ? jarString(jar) : '', client),
    body: JSON.stringify(payload),
  });
  if (jar) absorb(jar, res);
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      if (!cookieHeader) throw new HttpError(401, 'SIGN_IN_REQUIRED', `${endpoint} needs your YouTube cookies (TV tab → Your YouTube account).`);
      if (!retried) {
        // One forced rotation and retry before giving up, like a browser recovering a stale tab.
        const ok = await rotate(jar).catch(() => false);
        if (ok) return call(endpoint, cookieHeader, body, clientKey, true);
      }
      throw new HttpError(401, 'COOKIES_REJECTED', `YouTube rejected the cookies for ${endpoint} (HTTP ${res.status}; rotation ${jar.lastRotateError || 'ok'}). Copy a fresh set from the browser.`, text.slice(0, 300));
    }
    throw new HttpError(502, 'INNERTUBE_HTTP', `InnerTube ${endpoint} returned HTTP ${res.status}`, text.slice(0, 300));
  }
  const json = await res.json();
  const loggedOut = opt(json, 'responseContext.mainAppWebResponseContext.loggedOut');
  return { json, signedIn: loggedOut === false };
}

// ---------------------------------------------------------------------------
// Item normalisation
// ---------------------------------------------------------------------------

function text(node) {
  // YouTube text comes as {simpleText}, {runs:[{text}]}, or {content} (view models).
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text).join('');
  return undefined;
}

function thumb(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** Classic videoRenderer / compactVideoRenderer / gridVideoRenderer. */
function fromVideoRenderer(r) {
  if (typeof r.videoId !== 'string') return null;
  const timeOverlay = (r.thumbnailOverlays || [])
    .map((o) => o.thumbnailOverlayTimeStatusRenderer)
    .find((o) => o);
  const isLive = Boolean(
    timeOverlay && timeOverlay.style === 'LIVE'
  ) || (r.badges || []).some((b) => opt(b, 'metadataBadgeRenderer.style') === 'BADGE_STYLE_TYPE_LIVE_NOW');
  const duration = text(r.lengthText) || (timeOverlay ? text(timeOverlay.text) : undefined);
  const feedback = feedbackOptions(r.menu);
  const channelId = opt(r, 'ownerText.runs.0.navigationEndpoint.browseEndpoint.browseId') || opt(r, 'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId') || opt(r, 'longBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId');
  const channelAvatar = opt(r, 'channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer.thumbnail.thumbnails.0.url') || opt(r, 'channelThumbnail.thumbnails.0.url');
  return {
    ...(feedback.length ? { feedback } : {}),
    ...(typeof channelId === 'string' ? { channelId } : {}),
    ...(typeof channelAvatar === 'string' ? { channelAvatar } : {}),
    videoId: r.videoId,
    title: text(r.title) || '',
    channel: text(r.ownerText) || text(r.shortBylineText) || text(r.longBylineText) || '',
    duration: isLive ? 'LIVE' : duration || '',
    views: text(r.shortViewCountText) || text(r.viewCountText) || '',
    published: text(r.publishedTimeText) || '',
    thumbnail: thumb(r.videoId),
    isLive,
  };
}

/** New lockupViewModel shape (related videos, search, increasingly the Home feed). */
function fromLockup(l) {
  if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || typeof l.contentId !== 'string') return null;
  const badges = [];
  for (const overlay of opt(l, 'contentImage.thumbnailViewModel.overlays') || []) {
    for (const b of opt(overlay, 'thumbnailBottomOverlayViewModel.badges') || []) {
      const t = opt(b, 'thumbnailBadgeViewModel.text');
      if (typeof t === 'string') badges.push(t);
    }
    for (const b of opt(overlay, 'thumbnailOverlayBadgeViewModel.thumbnailBadges') || []) {
      const t = opt(b, 'thumbnailBadgeViewModel.text');
      if (typeof t === 'string') badges.push(t);
    }
  }
  const isLive = badges.some((b) => /^LIVE$/i.test(b));
  const duration = badges.find((b) => /^\d+(:\d{2})+$/.test(b));
  const rows = opt(l, 'metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows') || [];
  // Rows are unlabeled and positional (NewPipe/yt-dlp read them the same way):
  // first text row = channel name; last text row = "views" then "published".
  // A single merged row looks like ["Channel", "58K views", "1h ago"].
  const textRows = rows
    .map((row) => (row.metadataParts || []).map((p) => text(p.text)).filter((t) => typeof t === 'string' && t.length > 0))
    .filter((parts) => parts.length > 0);
  let channel = '';
  let views = '';
  let published = '';
  const looksLikeViews = (t) => /\b(views?|watching|waiting)\b/i.test(t);
  if (textRows.length === 1 && looksLikeViews(textRows[0][0])) {
    // Channel pages omit the channel row: the only row is "views", "published".
    views = textRows[0][0];
    published = textRows[0][1] || '';
  } else if (textRows.length > 0) {
    channel = textRows[0][0];
    const last = textRows.length >= 2 ? textRows[textRows.length - 1] : textRows[0].slice(1);
    views = last[0] || '';
    published = last.length > 1 ? last[last.length - 1] : '';
  }
  const feedback = feedbackOptions(opt(l, 'metadata.lockupMetadataViewModel.menuButton'));
  const avatarVm = opt(l, 'metadata.lockupMetadataViewModel.image.decoratedAvatarViewModel');
  const channelAvatar = avatarVm ? opt(avatarVm, 'avatar.avatarViewModel.image.sources.0.url') : undefined;
  const channelId = avatarVm ? opt(avatarVm, 'rendererContext.commandContext.onTap.innertubeCommand.browseEndpoint.browseId') : undefined;
  return {
    ...(feedback.length ? { feedback } : {}),
    ...(typeof channelId === 'string' ? { channelId } : {}),
    ...(typeof channelAvatar === 'string' ? { channelAvatar } : {}),
    videoId: l.contentId,
    title: text(opt(l, 'metadata.lockupMetadataViewModel.title')) || '',
    channel,
    duration: isLive ? 'LIVE' : duration || '',
    views,
    published,
    thumbnail: thumb(l.contentId),
    isLive,
  };
}

/** The continuation token carried by a continuationItemRenderer / continuationItemViewModel, whatever its current nesting. */
function continuationToken(node) {
  const paths = [
    'continuationItemRenderer.continuationEndpoint.continuationCommand.token',
    'continuationItemRenderer.continuationEndpoint.commandExecutorCommand.commands.0.continuationCommand.token',
    'continuationItemRenderer.continuationEndpoint.button.buttonRenderer.command.continuationCommand.token',
    'continuationItemRenderer.button.buttonRenderer.command.continuationCommand.token',
    'continuationItemViewModel.continuationCommand.innertubeCommand.continuationCommand.token',
  ];
  for (const path of paths) {
    const token = opt(node, path);
    if (typeof token === 'string') return token;
  }
  return null;
}

/**
 * Resolves the links hidden in YouTube "attributed" text (descriptions and
 * comments): each commandRun covers a range of the text and carries a redirect
 * URL, a video, or a channel. Returns [{ text, url }] in document order.
 */
function linksFrom(attributed) {
  if (!attributed || typeof attributed.content !== 'string' || !Array.isArray(attributed.commandRuns)) return [];
  const links = [];
  for (const run of attributed.commandRuns) {
    const cmd = opt(run, 'onTap.innertubeCommand');
    if (!cmd) continue;
    const shown = attributed.content.substr(run.startIndex, run.length);
    let url = null;
    if (cmd.urlEndpoint && typeof cmd.urlEndpoint.url === 'string') {
      url = cmd.urlEndpoint.url;
      if (url.startsWith('https://www.youtube.com/redirect')) {
        const q = new URL(url).searchParams.get('q');
        if (q) url = q;
      }
    } else if (cmd.watchEndpoint && typeof cmd.watchEndpoint.videoId === 'string') {
      // A timestamp link inside the video's own description is a chapter, not a link.
      if (typeof cmd.watchEndpoint.startTimeSeconds === 'number' && cmd.watchEndpoint.continuePlayback) continue;
      url = `https://www.youtube.com/watch?v=${cmd.watchEndpoint.videoId}`;
      if (typeof cmd.watchEndpoint.startTimeSeconds === 'number') url += `&t=${cmd.watchEndpoint.startTimeSeconds}`;
    } else if (cmd.browseEndpoint && typeof cmd.browseEndpoint.canonicalBaseUrl === 'string') {
      url = `https://www.youtube.com${cmd.browseEndpoint.canonicalBaseUrl}`;
    } else if (cmd.browseEndpoint && typeof cmd.browseEndpoint.browseId === 'string') {
      url = `https://www.youtube.com/channel/${cmd.browseEndpoint.browseId}`;
    }
    if (url) links.push({ text: shown.trim(), url });
  }
  return links;
}

/**
 * "Not interested" / "Don't recommend channel" options hidden in an item's
 * menu, as [{ label, token }]. Only present on signed-in Home feed items.
 */
function feedbackOptions(node) {
  const out = [];
  const seen = new Set();
  const findToken = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (n.feedbackEndpoint && typeof n.feedbackEndpoint.feedbackToken === 'string') return n.feedbackEndpoint.feedbackToken;
    for (const v of Object.values(n)) {
      const t = findToken(v);
      if (t) return t;
    }
    return null;
  };
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const entry = n.listItemViewModel || n.menuServiceItemRenderer || n.menuNavigationItemRenderer;
    if (entry) {
      const label = text(entry.title) || text(entry.text);
      const token = findToken(entry);
      if (label && token && !seen.has(token)) {
        seen.add(token);
        out.push({ label, token });
      }
      return;
    }
    Object.values(n).forEach(visit);
  };
  visit(node);
  return out;
}

/** playlistVideoRenderer (Watch Later and classic playlist pages). */
function fromPlaylistVideoRenderer(r) {
  if (typeof r.videoId !== 'string') return null;
  const info = Array.isArray(opt(r, 'videoInfo.runs')) ? r.videoInfo.runs.map((x) => x.text).filter((t) => t && t.trim() && !/^\s*[•·]\s*$/.test(t)) : [];
  return {
    videoId: r.videoId,
    title: text(r.title) || '',
    channel: text(r.shortBylineText) || '',
    duration: text(r.lengthText) || '',
    views: info[0] || '',
    published: info[1] || '',
    thumbnail: thumb(r.videoId),
    isLive: false,
    setVideoId: typeof r.setVideoId === 'string' ? r.setVideoId : undefined,
  };
}

/** A playlist card in any of its shapes -> { playlistId, title, byline, count, thumbnail }. */
function fromPlaylistLockup(l) {
  if (l.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST' || typeof l.contentId !== 'string') return null;
  const badges = [];
  const thumbVm = opt(l, 'contentImage.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel') || opt(l, 'contentImage.thumbnailViewModel');
  for (const overlay of (thumbVm && thumbVm.overlays) || []) {
    for (const b of opt(overlay, 'thumbnailBottomOverlayViewModel.badges') || []) {
      const t = opt(b, 'thumbnailBadgeViewModel.text');
      if (typeof t === 'string') badges.push(t);
    }
    for (const b of opt(overlay, 'thumbnailOverlayBadgeViewModel.thumbnailBadges') || []) {
      const t = opt(b, 'thumbnailBadgeViewModel.text');
      if (typeof t === 'string') badges.push(t);
    }
  }
  const rows = opt(l, 'metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows') || [];
  const textRows = rows
    .map((row) => (row.metadataParts || []).map((p) => text(p.text)).filter((t) => typeof t === 'string' && t.length > 0))
    .filter((parts) => parts.length > 0);
  const firstVideo = opt(l, 'rendererContext.commandContext.onTap.innertubeCommand.watchEndpoint.videoId');
  const src = opt(thumbVm, 'image.sources.0.url');
  return {
    playlistId: l.contentId,
    title: text(opt(l, 'metadata.lockupMetadataViewModel.title')) || '',
    byline: textRows[0] ? textRows[0][0] : '',
    count: badges.find((b) => /\d/.test(b)) || '',
    thumbnail: typeof firstVideo === 'string' ? thumb(firstVideo) : typeof src === 'string' ? src : '',
  };
}
function fromPlaylistRenderer(r) {
  if (typeof r.playlistId !== 'string') return null;
  const firstVideo = opt(r, 'navigationEndpoint.watchEndpoint.videoId');
  const src = opt(r, 'thumbnail.thumbnails.0.url') || opt(r, 'thumbnails.0.thumbnails.0.url');
  return {
    playlistId: r.playlistId,
    title: text(r.title) || '',
    byline: text(r.shortBylineText) || text(r.longBylineText) || '',
    count: text(r.videoCountText) || text(r.videoCountShortText) || (typeof r.videoCount === 'string' ? `${r.videoCount} videos` : ''),
    thumbnail: typeof firstVideo === 'string' ? thumb(firstVideo) : typeof src === 'string' ? src : '',
  };
}

// Containers whose children are never list items: skipping them keeps menus,
// end screens and page chrome out of the results.
const SKIP_KEYS = new Set(['menu', 'menuButton', 'onTap', 'rendererContext', 'navigationEndpoint', 'overlays', 'thumbnailOverlays', 'contentImage', 'thumbnail', 'playerOverlays', 'engagementPanels', 'topbar', 'frameworkUpdates', 'responseContext', 'header', 'secondaryContents', 'sidebar']);

/**
 * Walks InnerTube "items" (any nesting) in document order and returns the
 * videos and playlists it finds plus the continuation token, if any. Ads,
 * Shorts, channels and page chrome do not match and are skipped.
 */
function extractListing(items, label) {
  if (items === null || typeof items !== 'object') throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: expected an array or object of items`);
  const videos = [];
  const playlists = [];
  let continuation = null;
  const seen = new Set();
  const push = (v) => {
    if (v && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      videos.push(v);
    }
  };
  const pushPl = (p) => {
    if (p && !seen.has(p.playlistId)) {
      seen.add(p.playlistId);
      playlists.push(p);
    }
  };
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer) return push(fromVideoRenderer(node.videoRenderer));
    if (node.compactVideoRenderer) return push(fromVideoRenderer(node.compactVideoRenderer));
    if (node.gridVideoRenderer) return push(fromVideoRenderer(node.gridVideoRenderer));
    if (node.playlistVideoRenderer) return push(fromPlaylistVideoRenderer(node.playlistVideoRenderer));
    if (node.lockupViewModel) {
      push(fromLockup(node.lockupViewModel));
      pushPl(fromPlaylistLockup(node.lockupViewModel));
      return;
    }
    if (node.playlistRenderer) return pushPl(fromPlaylistRenderer(node.playlistRenderer));
    if (node.gridPlaylistRenderer) return pushPl(fromPlaylistRenderer(node.gridPlaylistRenderer));
    if (node.compactPlaylistRenderer) return pushPl(fromPlaylistRenderer(node.compactPlaylistRenderer));
    if (node.continuationItemRenderer || node.continuationItemViewModel) {
      const token = continuationToken(node);
      if (!token) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: continuation item had no continuationCommand.token`);
      continuation = token;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(items);
  return { items: videos, playlists, continuation };
}

/** Short summary of a list of InnerTube items, e.g. ["richItemRenderer>lockupViewModel x5", "richSectionRenderer>feedNudgeRenderer: Your watch history is off"]. */
function describeItems(items) {
  const out = [];
  for (const it of items) {
    const k = Object.keys(it)[0];
    const inner = it[k] && typeof it[k] === 'object' ? (it[k].content ? Object.keys(it[k].content)[0] : Object.keys(it[k]).filter((x) => !/tracking|logging/i.test(x)).slice(0, 3).join(',')) : '';
    let label = inner ? `${k}>${inner}` : k;
    const nudge = opt(it, 'richSectionRenderer.content.feedNudgeRenderer.title') || opt(it, 'richSectionRenderer.content.feedNudgeRenderer.subtitle');
    if (nudge) label += `: ${text(nudge)}`;
    if (out.length && out[out.length - 1].label === label) out[out.length - 1].n += 1;
    else out.push({ label, n: 1 });
  }
  return out.map((x) => (x.n > 1 ? `${x.label} x${x.n}` : x.label));
}

/** Items appended by a continuation request live in one of these two places. */
function continuationItems(json, label) {
  const actions = json.onResponseReceivedActions || json.onResponseReceivedEndpoints || json.onResponseReceivedCommands;
  if (!Array.isArray(actions)) {
    // A continuation that has nothing left comes back as a bare response (responseContext + trackingParams only).
    const keys = Object.keys(json).filter((k) => k !== 'responseContext' && k !== 'trackingParams');
    if (keys.length === 0) return [];
    throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: continuation response had no onResponseReceivedActions/Endpoints (keys: ${keys.join(', ')})`);
  }
  for (const a of actions) {
    if (opt(a, 'reloadContinuationItemsCommand.slot') === 'RELOAD_CONTINUATION_SLOT_HEADER') continue;
    const items = opt(a, 'appendContinuationItemsAction.continuationItems') || opt(a, 'reloadContinuationItemsCommand.continuationItems');
    if (Array.isArray(items)) return items;
  }
  throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: continuation response had no continuationItems`);
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

async function home(cookieHeader, continuation) {
  if (continuation) {
    const { json, signedIn } = await call('browse', cookieHeader, { continuation });
    return { ...extractListing(continuationItems(json, 'home continuation'), 'home continuation'), signedIn };
  }
  const { json, signedIn } = await call('browse', cookieHeader, { browseId: 'FEwhat_to_watch' });
  const tabs = need(json, 'contents.twoColumnBrowseResultsRenderer.tabs', 'home');
  const grid = opt(tabs, '0.tabRenderer.content.richGridRenderer.contents');
  if (!Array.isArray(grid)) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'home: tabs[0].tabRenderer.content.richGridRenderer.contents missing');
  const listing = extractListing(grid, 'home');
  // When the feed ends early, report what YouTube actually sent so the phone's debug log shows it.
  const shape = listing.continuation ? undefined : describeItems(grid);
  return { ...listing, signedIn, shape };
}

async function search(cookieHeader, query, continuation) {
  if (continuation) {
    const { json, signedIn } = await call('search', cookieHeader, { continuation });
    return { ...extractListing(continuationItems(json, 'search continuation'), 'search continuation'), signedIn };
  }
  const { json, signedIn } = await call('search', cookieHeader, { query });
  const sections = need(json, 'contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents', 'search');
  return { ...extractListing(sections, 'search'), signedIn };
}

/** Chapters from the "description chapters" engagement panel: [{ title, start }] with start in seconds. */
function chaptersFrom(json) {
  const panels = Array.isArray(json.engagementPanels) ? json.engagementPanels : [];
  const panel = panels
    .map((p) => p.engagementPanelSectionListRenderer)
    .find((p) => p && p.panelIdentifier === 'engagement-panel-macro-markers-description-chapters');
  if (!panel) return []; // the video simply has no chapters
  const items = need(panel, 'content.macroMarkersListRenderer.contents', 'chapters');
  const chapters = [];
  for (const it of items) {
    const r = it.macroMarkersListItemRenderer;
    if (!r) continue;
    const start = opt(r, 'onTap.watchEndpoint.startTimeSeconds');
    if (typeof start !== 'number') throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'chapters: macroMarkersListItemRenderer.onTap.watchEndpoint.startTimeSeconds missing');
    chapters.push({ title: text(r.title) || '', start });
  }
  return chapters;
}

/**
 * Everything the Now Playing screen needs for one video, in ONE request:
 * title/channel/views/date/description, chapters, and the related list.
 * With `continuation` set it returns only more related videos.
 */
async function watch(cookieHeader, videoId, continuation) {
  if (continuation) {
    const { json, signedIn } = await call('next', cookieHeader, { continuation });
    return { related: extractListing(continuationItems(json, 'related continuation'), 'related continuation'), signedIn };
  }
  const { json, signedIn } = await call('next', cookieHeader, { videoId, racyCheckOk: true, contentCheckOk: true });
  const results = need(json, 'contents.twoColumnWatchNextResults.results.results.contents', 'watch');
  const primary = results.map((r) => r.videoPrimaryInfoRenderer).find((r) => r);
  const secondary = results.map((r) => r.videoSecondaryInfoRenderer).find((r) => r);
  if (!primary) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'watch: videoPrimaryInfoRenderer missing (video unavailable or layout changed)');
  const relatedItems = opt(json, 'contents.twoColumnWatchNextResults.secondaryResults.secondaryResults.results');
  if (!Array.isArray(relatedItems)) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'watch: secondaryResults.secondaryResults.results missing');
  // The comments section is an itemSectionRenderer whose only child is a continuation.
  const commentsSection = results.map((r) => r.itemSectionRenderer).find((r) => r && r.sectionIdentifier === 'comment-item-section');
  const commentsContinuation = commentsSection && Array.isArray(commentsSection.contents) ? continuationToken(commentsSection.contents[0]) : null;
  const attributed = secondary ? secondary.attributedDescription : undefined;
  const likeVm = (opt(primary, 'videoActions.menuRenderer.topLevelButtons') || [])
    .map((btn) => opt(btn, 'segmentedLikeDislikeButtonViewModel.likeButtonViewModel.likeButtonViewModel'))
    .find((vm) => vm);
  let rating = likeVm ? opt(likeVm, 'likeStatusEntity.likeStatus') : undefined;
  if (typeof rating !== 'string' && likeVm && typeof likeVm.likeStatusEntityKey === 'string') {
    const mutation = (opt(json, 'frameworkUpdates.entityBatchUpdate.mutations') || []).find((m) => opt(m, 'payload.likeStatusEntity.key') === likeVm.likeStatusEntityKey);
    rating = mutation ? opt(mutation, 'payload.likeStatusEntity.likeStatus') : undefined;
  }
  return {
    rating: typeof rating === 'string' ? rating : null, // LIKE | DISLIKE | INDIFFERENT (yours, when signed in)
    likeCount: (likeVm && text(opt(likeVm, 'toggleButtonViewModel.toggleButtonViewModel.defaultButtonViewModel.buttonViewModel.title'))) || '',
    video: {
      videoId,
      title: text(primary.title) || '',
      views: text(opt(primary, 'viewCount.videoViewCountRenderer.viewCount')) || '',
      published: text(primary.dateText) || '',
      channel: (secondary && text(opt(secondary, 'owner.videoOwnerRenderer.title'))) || '',
      description: (secondary && (text(attributed) || text(secondary.description))) || '',
      links: linksFrom(attributed),
      thumbnail: thumb(videoId),
    },
    chapters: chaptersFrom(json),
    related: extractListing(relatedItems, 'related'),
    commentsContinuation,
    signedIn,
  };
}

/**
 * One page of comments (or of replies: pass a thread's repliesContinuation).
 * Comment bodies live in frameworkUpdates as commentEntityPayload entities;
 * the list only carries ids, so the two are joined here.
 */
async function comments(cookieHeader, continuation) {
  const { json, signedIn } = await call('next', cookieHeader, { continuation });
  const actions = json.onResponseReceivedEndpoints;
  if (!Array.isArray(actions)) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'comments: onResponseReceivedEndpoints missing');
  let items = null;
  for (const a of actions) {
    const cmd = a.appendContinuationItemsAction || a.reloadContinuationItemsCommand;
    if (!cmd || !Array.isArray(cmd.continuationItems)) continue;
    if (cmd.slot === 'RELOAD_CONTINUATION_SLOT_HEADER') continue;
    items = cmd.continuationItems;
  }
  if (!items) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'comments: no continuationItems in the response');
  const entities = new Map();
  for (const m of opt(json, 'frameworkUpdates.entityBatchUpdate.mutations') || []) {
    const e = opt(m, 'payload.commentEntityPayload');
    if (e && typeof opt(e, 'properties.commentId') === 'string') entities.set(e.properties.commentId, e);
  }
  const out = [];
  let next = null;
  for (const it of items) {
    if (it.continuationItemRenderer || it.continuationItemViewModel) {
      next = continuationToken(it);
      if (!next) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'comments: continuation item had no token');
      continue;
    }
    const thread = it.commentThreadRenderer;
    const vm = thread ? opt(thread, 'commentViewModel.commentViewModel') : it.commentViewModel;
    if (!vm || typeof vm.commentId !== 'string') continue; // not a comment (e.g. a prompt to sign in)
    const entity = entities.get(vm.commentId);
    if (!entity) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `comments: no commentEntityPayload for ${vm.commentId}`);
    const content = opt(entity, 'properties.content');
    const replies = thread ? opt(thread, 'replies.commentRepliesRenderer') : undefined;
    out.push({
      commentId: vm.commentId,
      author: opt(entity, 'author.displayName') || '',
      authorAvatar: opt(entity, 'author.avatarThumbnailUrl') || '',
      isCreator: opt(entity, 'author.isCreator') === true,
      isVerified: opt(entity, 'author.isVerified') === true,
      pinned: typeof vm.pinnedText === 'string' ? vm.pinnedText : '',
      hearted: typeof opt(entity, 'toolbar.heartActiveTooltip') === 'string',
      text: text(content) || '',
      links: linksFrom(content),
      published: opt(entity, 'properties.publishedTime') || '',
      likes: opt(entity, 'toolbar.likeCountNotliked') || '',
      replyCount: opt(entity, 'toolbar.replyCount') || '',
      repliesContinuation: replies && Array.isArray(replies.contents) ? continuationToken(replies.contents[0]) : null,
    });
  }
  return { items: out, continuation: next, signedIn };
}

// ---------------------------------------------------------------------------
// Library (needs cookies): history, Watch Later / playlists, rating, saving
// ---------------------------------------------------------------------------

function requireSignIn(cookieHeader, what) {
  if (!cookieHeader) throw new HttpError(401, 'SIGN_IN_REQUIRED', `${what} needs your YouTube cookies (TV tab → Your YouTube account).`);
}

async function history(cookieHeader, continuation) {
  requireSignIn(cookieHeader, 'Watch history');
  if (continuation) {
    const { json, signedIn } = await call('browse', cookieHeader, { continuation });
    return { ...extractListing(continuationItems(json, 'history continuation'), 'history continuation'), signedIn };
  }
  const { json, signedIn } = await call('browse', cookieHeader, { browseId: 'FEhistory' });
  if (!signedIn) throw new HttpError(401, 'COOKIES_REJECTED', 'YouTube treats these cookies as signed out, so history is empty. Export a fresh set.');
  const content = need(json, 'contents.twoColumnBrowseResultsRenderer.tabs.0.tabRenderer.content', 'history');
  return { ...extractListing(content, 'history'), signedIn };
}

/** The user's own playlists (the "Playlists" page). Watch Later is not listed there; the client adds it. */
async function playlists(cookieHeader, continuation) {
  requireSignIn(cookieHeader, 'Your playlists');
  if (continuation) {
    const { json, signedIn } = await call('browse', cookieHeader, { continuation });
    const listing = extractListing(continuationItems(json, 'playlists continuation'), 'playlists continuation');
    return { items: listing.playlists, continuation: listing.continuation, signedIn };
  }
  const { json, signedIn } = await call('browse', cookieHeader, { browseId: 'FEplaylist_aggregation' });
  const content = need(json, 'contents.twoColumnBrowseResultsRenderer.tabs.0.tabRenderer.content', 'playlists');
  const listing = extractListing(content, 'playlists');
  return { items: listing.playlists, continuation: listing.continuation, signedIn };
}

/** One page of a playlist (WL = Watch Later, LL = Liked videos, PL… = any playlist). */
async function playlist(cookieHeader, playlistId, continuation) {
  if (continuation) {
    const { json, signedIn } = await call('browse', cookieHeader, { continuation });
    const listing = extractListing(continuationItems(json, 'playlist continuation'), 'playlist continuation');
    return { items: listing.items, continuation: listing.continuation, signedIn };
  }
  if (playlistId === 'WL' || playlistId === 'LL') requireSignIn(cookieHeader, playlistId === 'WL' ? 'Watch Later' : 'Liked videos');
  const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
  const { json, signedIn } = await call('browse', cookieHeader, { browseId });
  const alert = (json.alerts || []).map((a) => a.alertRenderer || a.alertWithButtonRenderer).find((a) => a && a.type === 'ERROR');
  if (alert) {
    if ((playlistId === 'WL' || playlistId === 'LL') && !signedIn) throw new HttpError(401, 'COOKIES_REJECTED', 'YouTube treats these cookies as signed out. Export a fresh set.');
    throw new HttpError(404, 'PLAYLIST_UNAVAILABLE', text(alert.text) || 'YouTube says this playlist is unavailable');
  }
  const content = need(json, 'contents.twoColumnBrowseResultsRenderer.tabs.0.tabRenderer.content', 'playlist');
  const listing = extractListing(content, 'playlist');
  const headerRows = opt(json, 'header.pageHeaderRenderer.content.pageHeaderViewModel.metadata.contentMetadataViewModel.metadataRows') || [];
  const headerTexts = headerRows.flatMap((row) => (row.metadataParts || []).map((p) => text(p.text)).filter((t) => typeof t === 'string'));
  return {
    playlistId,
    title: opt(json, 'header.pageHeaderRenderer.pageTitle') || opt(json, 'metadata.playlistMetadataRenderer.title') || text(opt(json, 'header.playlistHeaderRenderer.title')) || playlistId,
    count: headerTexts.find((t) => /\d.*video/i.test(t)) || text(opt(json, 'header.playlistHeaderRenderer.numVideosText')) || '',
    items: listing.items,
    continuation: listing.continuation,
    signedIn,
  };
}

/** rating: 'like' | 'dislike' | 'none' */
async function rate(cookieHeader, videoId, rating) {
  requireSignIn(cookieHeader, 'Rating a video');
  const endpoint = { like: 'like/like', dislike: 'like/dislike', none: 'like/removelike' }[rating];
  if (!endpoint) throw new HttpError(400, 'BAD_REQUEST', `rating must be like, dislike or none (got ${rating})`);
  const { json } = await call(endpoint, cookieHeader, { target: { videoId } }, 'TV');
  if (json.error) throw new HttpError(502, 'RATE_FAILED', `YouTube refused the rating: ${JSON.stringify(json.error).slice(0, 200)}`);
  return { ok: true, rating: { like: 'LIKE', dislike: 'DISLIKE', none: 'INDIFFERENT' }[rating] };
}

/** The "Save to…" dialog: every playlist of the user with whether it already contains the video. */
async function saveOptions(cookieHeader, videoId) {
  requireSignIn(cookieHeader, 'Saving to a playlist');
  const { json } = await call('playlist/get_add_to_playlist', cookieHeader, { videoIds: [videoId], excludeWatchLater: false });
  const list = need(json, 'contents.0.addToPlaylistRenderer.playlists', 'save options');
  const out = [];
  for (const it of list) {
    const r = it.playlistAddToOptionRenderer;
    if (!r || typeof r.playlistId !== 'string') continue;
    out.push({
      playlistId: r.playlistId,
      title: text(r.title) || r.playlistId,
      privacy: typeof r.privacy === 'string' ? r.privacy : '',
      contains: r.containsSelectedVideos === 'ALL',
    });
  }
  return { playlists: out };
}

/** action: 'add' | 'remove' */
async function editPlaylist(cookieHeader, playlistId, videoId, action) {
  requireSignIn(cookieHeader, 'Editing a playlist');
  const actions = { add: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }], remove: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }] }[action];
  if (!actions) throw new HttpError(400, 'BAD_REQUEST', `action must be add or remove (got ${action})`);
  const { json } = await call('browse/edit_playlist', cookieHeader, { playlistId, actions });
  if (json.status !== 'STATUS_SUCCEEDED') {
    const popup = (json.actions || []).map((a) => opt(a, 'openPopupAction.popup.modalWithTitleAndButtonRenderer.content')).find((c) => c);
    throw new HttpError(502, 'PLAYLIST_EDIT_FAILED', `YouTube answered ${json.status || 'without a status'}${popup ? `: ${text(popup)}` : ''}`);
  }
  return { ok: true };
}

async function createPlaylist(cookieHeader, title, videoId) {
  requireSignIn(cookieHeader, 'Creating a playlist');
  const body = { title, privacyStatus: 'PRIVATE' };
  if (videoId) body.videoIds = [videoId];
  const { json } = await call('playlist/create', cookieHeader, body);
  return { playlistId: need(json, 'playlistId', 'create playlist') };
}

/** Sends a "Not interested" / "Don't recommend channel" token. */
async function feedback(cookieHeader, token) {
  requireSignIn(cookieHeader, 'Removing a recommendation');
  const { json } = await call('feedback', cookieHeader, { feedbackTokens: [token], isFeedbackTokenUnencrypted: false, shouldMerge: false });
  const processed = opt(json, 'feedbackResponses.0.isProcessed');
  if (processed !== true) throw new HttpError(502, 'FEEDBACK_FAILED', `YouTube did not accept the feedback (isProcessed: ${processed})`);
  return { ok: true };
}

/** Subscribed channels from the guide (sidebar): [{ channelId, title, avatar }]. */
function channelsFromGuide(json) {
  const section = [];
  const findSection = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(findSection);
    if (n.guideSubscriptionsSectionRenderer) {
      section.push(n.guideSubscriptionsSectionRenderer);
      return;
    }
    Object.values(n).forEach(findSection);
  };
  findSection(json.items);
  const channels = [];
  const seen = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (n.guideEntryRenderer) {
      const e = n.guideEntryRenderer;
      const id = opt(e, 'navigationEndpoint.browseEndpoint.browseId');
      if (typeof id === 'string' && id.startsWith('UC') && !seen.has(id)) {
        seen.add(id);
        channels.push({ channelId: id, title: text(e.formattedTitle) || text(e.title) || '', avatar: opt(e, 'thumbnail.thumbnails.0.url') || '' });
      }
    }
    Object.values(n).forEach(visit);
  };
  visit(section);
  return channels;
}

/** Subscriptions feed. The first page also returns the channel list (fetched in parallel). */
async function subscriptions(cookieHeader, continuation) {
  requireSignIn(cookieHeader, 'Subscriptions');
  if (continuation) {
    const { json, signedIn } = await call('browse', cookieHeader, { continuation });
    return { ...extractListing(continuationItems(json, 'subscriptions continuation'), 'subscriptions continuation'), signedIn };
  }
  const [feed, guide] = await Promise.all([call('browse', cookieHeader, { browseId: 'FEsubscriptions' }), call('guide', cookieHeader, {})]);
  if (!feed.signedIn) throw new HttpError(401, 'COOKIES_REJECTED', 'YouTube treats these cookies as signed out, so there are no subscriptions. Copy a fresh set.');
  const content = need(feed.json, 'contents.twoColumnBrowseResultsRenderer.tabs.0.tabRenderer.content', 'subscriptions');
  return { ...extractListing(content, 'subscriptions'), channels: channelsFromGuide(guide.json), signedIn: true };
}

const CHANNEL_TABS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
  search: 'EgZzZWFyY2jyBgQKAloA',
};

/** Channel header: name, handle, avatar, banner, subscriber/video counts, description. */
function channelHeader(json) {
  const h = opt(json, 'header.pageHeaderRenderer.content.pageHeaderViewModel');
  const meta = opt(json, 'metadata.channelMetadataRenderer') || {};
  const rows = h ? opt(h, 'metadata.contentMetadataViewModel.metadataRows') || [] : [];
  const parts = rows.flatMap((r) => (r.metadataParts || []).map((p) => text(p.text)).filter(Boolean));
  const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1].url : '');
  return {
    channelId: meta.externalId || '',
    title: (h && text(opt(h, 'title.dynamicTextViewModel.text'))) || meta.title || '',
    handle: parts.find((p) => p.startsWith('@')) || '',
    subscribers: parts.find((p) => /subscriber/i.test(p)) || '',
    videoCount: parts.find((p) => /video/i.test(p)) || '',
    avatar: (h && last(opt(h, 'image.decoratedAvatarViewModel.avatar.avatarViewModel.image.sources'))) || opt(meta, 'avatar.thumbnails.0.url') || '',
    banner: (h && last(opt(h, 'banner.imageBannerViewModel.image.sources'))) || '',
    description: meta.description || (h && text(opt(h, 'description.descriptionPreviewViewModel.description'))) || '',
  };
}

/**
 * A channel page. tab: 'videos' | 'playlists' | 'search' (with query).
 * Returns the header, the list (videos or playlists), sort options for the
 * Videos tab, and a continuation for more. With `continuation` (next page or
 * a sort option's token) only the list comes back.
 */
async function channel(cookieHeader, channelId, tab, query, continuation) {
  if (continuation) {
    const { json, signedIn } = await call('browse', cookieHeader, { continuation });
    const listing = extractListing(continuationItems(json, 'channel continuation'), 'channel continuation');
    return { items: listing.items, playlists: listing.playlists, continuation: listing.continuation, signedIn };
  }
  const params = CHANNEL_TABS[tab];
  if (!params) throw new HttpError(400, 'BAD_REQUEST', `tab must be videos, playlists or search (got ${tab})`);
  const body = { browseId: channelId, params };
  if (tab === 'search') {
    if (!query) throw new HttpError(400, 'BAD_REQUEST', 'search needs a query');
    body.query = query;
  }
  const { json, signedIn } = await call('browse', cookieHeader, body);
  const tabs = need(json, 'contents.twoColumnBrowseResultsRenderer.tabs', 'channel');
  const selected = tabs.map((t) => t.tabRenderer || t.expandableTabRenderer).find((t) => t && t.selected && t.content);
  if (!selected) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `channel: no selected ${tab} tab with content`);
  const header = channelHeader(json);
  const listing = extractListing(selected.content, 'channel');
  for (const v of listing.items) {
    if (!v.channel) v.channel = header.title;
    if (!v.channelId) v.channelId = channelId;
    if (!v.channelAvatar && header.avatar) v.channelAvatar = header.avatar;
  }
  const sorts = [];
  const chips = opt(selected, 'content.richGridRenderer.header.chipBarViewModel.chips') || [];
  for (const c of chips) {
    const vm = c.chipViewModel;
    const token = vm ? opt(vm, 'tapCommand.innertubeCommand.continuationCommand.token') : undefined;
    if (vm && typeof token === 'string') sorts.push({ label: vm.text, token, selected: vm.selected === true });
  }
  return { header, items: listing.items, playlists: listing.playlists, continuation: listing.continuation, sorts, signedIn };
}

/** A channel's Videos tab (used by the Subs channel filter). */
async function channelVideos(cookieHeader, channelId, continuation) {
  const r = await channel(cookieHeader, channelId, 'videos', null, continuation);
  return r.header ? { ...r, title: r.header.title } : r;
}

module.exports = { feedback, subscriptions, channel, channelVideos, currentCookies, jarStatus, home, search, watch, comments, history, playlists, playlist, rate, saveOptions, editPlaylist, createPlaylist, normaliseCookies, sapisidFrom };
