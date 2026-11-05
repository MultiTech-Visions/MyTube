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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Pulls SAPISID (or __Secure-3PAPISID) out of a raw Cookie header string. */
function sapisidFrom(cookieHeader) {
  const m = /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/.exec(cookieHeader);
  return m ? m[1] : null;
}

function authHeaders(cookieHeader) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: ORIGIN,
    'X-Origin': ORIGIN,
    'X-Youtube-Client-Name': '1',
    'X-Youtube-Client-Version': CLIENT_VERSION,
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
// Transport
// ---------------------------------------------------------------------------

async function call(endpoint, cookieHeader, body) {
  const payload = {
    context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' } },
    ...body,
  };
  const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: authHeaders(cookieHeader),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(401, 'COOKIES_REJECTED', `YouTube rejected the cookies for ${endpoint} (HTTP ${res.status}). Export a fresh set.`, text.slice(0, 300));
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
  return {
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
  if (textRows.length > 0) {
    channel = textRows[0][0];
    const last = textRows.length >= 2 ? textRows[textRows.length - 1] : textRows[0].slice(1);
    views = last[0] || '';
    published = last.length > 1 ? last[last.length - 1] : '';
  }
  return {
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
 * Walks an array of InnerTube "items" (any nesting) in document order and
 * returns the videos it finds plus the continuation token, if any.
 * Ads, Shorts, playlists and channels do not match and are skipped.
 */
function extractListing(items, label) {
  if (!Array.isArray(items)) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: expected an array of items`);
  const videos = [];
  let continuation = null;
  const seen = new Set();
  const push = (v) => {
    if (v && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      videos.push(v);
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
    if (node.lockupViewModel) return push(fromLockup(node.lockupViewModel));
    if (node.continuationItemRenderer || node.continuationItemViewModel) {
      const token = continuationToken(node);
      if (!token) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: continuation item had no continuationCommand.token`);
      continuation = token;
      return;
    }
    // Shelves / sections that wrap more items (richItemRenderer, richSectionRenderer,
    // itemSectionRenderer, shelfRenderer ...) — descend into their contents only.
    for (const key of ['content', 'contents', 'items', 'richItemRenderer', 'itemSectionRenderer', 'shelfRenderer', 'richShelfRenderer', 'horizontalListRenderer', 'expandedShelfContentsRenderer']) {
      if (key in node) visit(node[key]);
    }
  };
  visit(items);
  return { items: videos, continuation };
}

/** Items appended by a continuation request live in one of these two places. */
function continuationItems(json, label) {
  const actions = json.onResponseReceivedActions || json.onResponseReceivedEndpoints || json.onResponseReceivedCommands;
  if (!Array.isArray(actions)) {
    throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', `${label}: continuation response had no onResponseReceivedActions/Endpoints`);
  }
  for (const a of actions) {
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
  return { ...extractListing(grid, 'home'), signedIn };
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
  return {
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

module.exports = { home, search, watch, comments, normaliseCookies, sapisidFrom };
