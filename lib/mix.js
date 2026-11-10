'use strict';

/**
 * MyTube's own recommendations, built without the account: related videos of
 * things the phone says were watched, the latest uploads of channels watched
 * most, and a few "explore" picks (related videos of a related video) for
 * breadth. All requests are anonymous, so this keeps working when the YouTube
 * login does not.
 */
const innertube = require('./innertube');
const { HttpError } = require('./util');

const MAX_SEEDS = 8;
const PER_SOURCE = { related: 12, channel: 8, explore: 10, keyword: 10 };
const EXPLORE_SOURCES = 2;

function seedList(body, key) {
  const list = body[key];
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x)) throw new HttpError(400, 'BAD_REQUEST', `body.${key} must be an array of ids`);
  if (list.length > MAX_SEEDS) throw new HttpError(400, 'BAD_REQUEST', `body.${key} has ${list.length} ids; at most ${MAX_SEEDS}`);
  return list;
}

async function runAll(jobs) {
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  return jobs.map((j, i) => (settled[i].status === 'fulfilled' ? { kind: j.kind, seed: j.seed, items: settled[i].value } : { kind: j.kind, seed: j.seed, items: [], error: settled[i].reason.message }));
}

/** @returns {{ items: object[], sources: {kind, seed, count, error?}[] }} items carry `pick`: related | channel | keyword | explore */
async function build(body) {
  const videos = seedList(body, 'videos');
  const channels = seedList(body, 'channels');
  const keywords = seedList(body, 'keywords');
  if (videos.length + channels.length + keywords.length === 0) throw new HttpError(400, 'NO_SEEDS', 'Nothing to build recommendations from yet: no watched videos, channels or keywords were sent.');
  const related = (id) => innertube.watch('', id, null).then((r) => r.related.items);
  const first = await runAll([
    ...videos.map((id) => ({ kind: 'related', seed: id, run: () => related(id) })),
    ...channels.map((id) => ({ kind: 'channel', seed: id, run: () => innertube.channelVideos('', id, null).then((r) => r.items) })),
    ...keywords.map((q) => ({ kind: 'keyword', seed: q, run: () => innertube.search('', q, null).then((r) => r.items) })),
  ]);
  // Breadth: one step further out. Take a random related video from a channel that is not
  // already a seed channel and ask what is related to that.
  const seedChannels = new Set(channels);
  const hops = [];
  for (const src of first.filter((s) => s.kind === 'related' && s.items.length)) {
    if (hops.length >= EXPLORE_SOURCES) break;
    const outside = src.items.filter((v) => v.videoId && !seedChannels.has(v.channelId) && !videos.includes(v.videoId));
    if (outside.length) hops.push(outside[Math.floor(Math.random() * outside.length)].videoId);
  }
  const second = await runAll(hops.map((id) => ({ kind: 'explore', seed: id, run: () => related(id) })));
  const sources = [...first, ...second];
  if (sources.every((s) => s.error)) throw new HttpError(502, 'MIX_FAILED', `Every recommendation source failed; first error: ${sources[0].error}`);

  // Round-robin across sources so no single seed dominates the top of the list.
  const seen = new Set(videos);
  const lists = sources.map((s) => s.items.filter((v) => v.videoId).slice(0, PER_SOURCE[s.kind]).map((v) => ({ ...v, pick: s.kind })));
  const items = [];
  for (let i = 0; lists.some((l) => i < l.length); i += 1) {
    for (const l of lists) {
      if (i >= l.length || seen.has(l[i].videoId)) continue;
      seen.add(l[i].videoId);
      items.push(l[i]);
    }
  }
  return { items, sources: sources.map((s) => ({ kind: s.kind, seed: s.seed, count: s.items.length, ...(s.error ? { error: s.error } : {}) })) };
}

/** Name and avatar for channels the phone only knows by id: [{ channelId, name, avatar } | { channelId, error }]. */
async function channelInfo(body) {
  const ids = seedList(body, 'channels');
  if (ids.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'body.channels is empty');
  const settled = await Promise.allSettled(ids.map((id) => innertube.channel('', id, 'videos', null, null)));
  return {
    channels: ids.map((channelId, i) => {
      if (settled[i].status === 'rejected') return { channelId, error: settled[i].reason.message };
      const h = settled[i].value.header;
      if (!h || !h.title) return { channelId, error: 'YouTube returned no channel header' };
      return { channelId, name: h.title, avatar: h.avatar };
    }),
  };
}

module.exports = { build, channelInfo };
