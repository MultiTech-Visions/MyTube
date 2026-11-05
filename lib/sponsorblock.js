'use strict';

/**
 * SponsorBlock lookup (https://sponsor.ajay.app). Uses the hashed-prefix
 * endpoint so the service never learns the exact video id: it answers for
 * every video whose sha256 starts with the same 4 hex characters and we pick
 * ours out of the list. A 404 means "no segments for any of those videos".
 */
const crypto = require('crypto');
const { HttpError } = require('./util');

const API = 'https://sponsor.ajay.app/api/skipSegments';
const CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic'];

async function segments(videoId) {
  const prefix = crypto.createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const url = `${API}/${prefix}?categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'MyTube/0.1 (personal TV remote)' } });
  if (res.status === 404) return { segments: [] };
  if (!res.ok) throw new HttpError(502, 'SPONSORBLOCK_HTTP', `SponsorBlock returned HTTP ${res.status}`, (await res.text()).slice(0, 200));
  const list = await res.json();
  if (!Array.isArray(list)) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'SponsorBlock: expected an array');
  const mine = list.find((v) => v && v.videoID === videoId);
  if (!mine) return { segments: [] };
  if (!Array.isArray(mine.segments)) throw new HttpError(502, 'UPSTREAM_SHAPE_CHANGED', 'SponsorBlock: entry had no segments array');
  const out = mine.segments
    .filter((s) => Array.isArray(s.segment) && s.segment.length === 2 && s.actionType !== 'mute' && s.actionType !== 'full' && s.actionType !== 'poi')
    .map((s) => ({ start: Number(s.segment[0]), end: Number(s.segment[1]), category: String(s.category), uuid: String(s.UUID) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  return { segments: out };
}

module.exports = { segments, CATEGORIES };
