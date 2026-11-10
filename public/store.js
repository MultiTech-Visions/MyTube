/**
 * Persistent state, kept in the phone's browser (localStorage). The queue and
 * the last known playback position live here so that nothing the TV does can
 * erase them. Corrupt JSON throws on purpose; only a missing key gets its
 * initial value.
 */
const KEYS = { hidden: 'mytube.hidden', settings: 'mytube.settings', queue: 'mytube.queue', lastKnown: 'mytube.lastKnown', deviceId: 'mytube.deviceId', videos: 'mytube.videos', taste: 'mytube.taste' };

function load(key, initial) {
  const raw = localStorage.getItem(key);
  if (raw === null) return initial;
  return JSON.parse(raw);
}
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function newDeviceId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let deviceId = localStorage.getItem(KEYS.deviceId);
if (deviceId === null) {
  deviceId = newDeviceId();
  localStorage.setItem(KEYS.deviceId, deviceId);
}

/** Ad strategies. Settings saved before this existed get the defaults once, explicitly. */
export const AD_DEFAULTS = {
  autoSkip: true, // send skipAd the moment the TV says the skip button is enabled
  dodge: false, // once an ad has played dodgeAfter s: reload the video at the saved position, then force a seek
  dodgeAfter: 0, // seconds of ad before the auto-dodge reloads (0 = right away)
  dodgeExit: true, // leave the player (stopVideo) before reloading, like pressing B on the Xbox
  dodgeMax: 2, // give up after this many reloads for one video
  dodgeOffset: 2, // seconds to land past the position where the ad hit (clears mid-roll cue points)
  muteAds: false, // mute the TV while an ad plays, unmute after
  sponsorBlock: false, // seek past community-marked sponsor segments (SponsorBlock)
  sponsorCategories: ['sponsor', 'selfpromo', 'interaction'], // which SponsorBlock categories to skip
};

/**
 * Everything MyTube's own picks are tailored by (Tune tab).
 * plays: [{ videoId, channelId|null, at }] newest first; subs/pinned/blocked: channel ids;
 * names: channelId -> name; keywords: searched for picks; blockedWords: picks whose title or
 * channel contains one are dropped.
 */
const TASTE_DEFAULTS = { plays: [], subs: [], names: {}, pinned: [], blocked: [], keywords: [], blockedWords: [] };

export const store = {
  /** Stable id for this phone; the TV uses it to recognise the same remote across reconnects. */
  deviceId,

  settings: load(KEYS.settings, {
    deviceName: 'MyTube Remote',
    cookies: '',
    screen: null, // { screenId, loungeToken, name, expiration }
    autoConnect: true,
    feedMix: 30, // % of Home that is MyTube's own picks while the YouTube login works
    ads: null, // filled in below
  }),
  saveSettings() {
    save(KEYS.settings, this.settings);
  },

  /** items: [{ videoId, title, channel, duration, thumbnail }], currentIndex: -1 when nothing is current. */
  queue: load(KEYS.queue, { items: [], currentIndex: -1 }),
  saveQueue() {
    save(KEYS.queue, this.queue);
  },

  /** Last playback position reported by the TV, so a lost queue can be restored where it was. */
  lastKnown: load(KEYS.lastKnown, { videoId: null, currentTime: 0, duration: 0, at: 0 }),
  saveLastKnown() {
    save(KEYS.lastKnown, this.lastKnown);
  },

  /** Small cache of video metadata by id (titles for queue rows the TV added, etc.). */
  videos: load(KEYS.videos, {}),
  rememberVideo(v) {
    this.videos[v.videoId] = { videoId: v.videoId, title: v.title, channel: v.channel, duration: v.duration, thumbnail: v.thumbnail, ...(v.channelId ? { channelId: v.channelId } : {}) };
    const ids = Object.keys(this.videos);
    if (ids.length > 400) for (const id of ids.slice(0, ids.length - 400)) delete this.videos[id];
    save(KEYS.videos, this.videos);
  },
  video(videoId) {
    return this.videos[videoId];
  },

  /**
   * What MyTube's own recommendations are built from: videos that played or were queued
   * (newest first) and the subscription list as last seen while the login worked.
   */
  taste: load(KEYS.taste, JSON.parse(JSON.stringify(TASTE_DEFAULTS))),
  saveTaste() {
    save(KEYS.taste, this.taste);
  },
  /** channelId / channelName may be null when the TV started a video this phone knows nothing about. */
  recordPlay(videoId, channelId, channelName) {
    const before = this.taste.plays.find((p) => p.videoId === videoId);
    const plays = this.taste.plays.filter((p) => p.videoId !== videoId);
    // A later report without the channel must not erase a channel learned earlier.
    plays.unshift({ videoId, channelId: channelId || (before ? before.channelId : null), at: Date.now() });
    this.taste.plays = plays.slice(0, 150);
    if (channelId && channelName) this.taste.names[channelId] = channelName;
    this.saveTaste();
  },
  rememberSubs(channels) {
    this.taste.subs = channels.map((c) => c.channelId);
    for (const c of channels) if (c.title) this.taste.names[c.channelId] = c.title;
    this.saveTaste();
  },

  /** Videos removed from recommendations; filtered out of Home even if YouTube sends them again. */
  hidden: load(KEYS.hidden, []),
  hide(videoId) {
    if (this.hidden.includes(videoId)) return;
    this.hidden.push(videoId);
    if (this.hidden.length > 2000) this.hidden.splice(0, this.hidden.length - 2000);
    save(KEYS.hidden, this.hidden);
  },
  unhide(videoId) {
    const i = this.hidden.indexOf(videoId);
    if (i === -1) return;
    this.hidden.splice(i, 1);
    save(KEYS.hidden, this.hidden);
  },

  clearAll() {
    for (const k of Object.values(KEYS)) localStorage.removeItem(k);
  },
};

// Taste saved before the Tune tab existed gets the new (empty) lists once.
{
  let changed = false;
  for (const [k, v] of Object.entries(TASTE_DEFAULTS)) {
    if (!(k in store.taste)) {
      store.taste[k] = Array.isArray(v) ? [] : {};
      changed = true;
    }
  }
  if (changed) store.saveTaste();
}

// Added later: existing saved settings get the default once.
if (!('feedMix' in store.settings)) {
  store.settings.feedMix = 30;
  store.saveSettings();
}

// Left behind by the removed "Send to TV screen" feature.
if ('castCode' in store.settings) {
  delete store.settings.castCode;
  store.saveSettings();
}

if (store.settings.ads === null || store.settings.ads === undefined) {
  store.settings.ads = { ...AD_DEFAULTS };
  store.saveSettings();
} else {
  // A setting added in a later version gets its default once; existing choices are kept.
  let changed = false;
  for (const [k, v] of Object.entries(AD_DEFAULTS)) {
    if (!(k in store.settings.ads)) {
      store.settings.ads[k] = Array.isArray(v) ? [...v] : v;
      changed = true;
    }
  }
  if (changed) store.saveSettings();
}
