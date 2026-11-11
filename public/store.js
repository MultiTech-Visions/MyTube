/**
 * Persistent state, kept in the phone's browser (localStorage). The queue and
 * the last known playback position live here so that nothing the TV does can
 * erase them. Corrupt JSON throws on purpose; only a missing key gets its
 * initial value.
 */
const KEYS = { hidden: 'mytube.hidden', settings: 'mytube.settings', queue: 'mytube.queue', lastKnown: 'mytube.lastKnown', deviceId: 'mytube.deviceId', videos: 'mytube.videos', taste: 'mytube.taste', profiles: 'mytube.profiles' };

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
 * hearts: [{ videoId, channelId|null, at }] videos you hearted for this profile, the strongest
 * signal; plays: [{ videoId, channelId|null, at }] newest first; subs/pinned/blocked: channel ids;
 * names / avatars: channelId -> name / icon URL; excluded: videos you marked "don't use"
 * ([{ videoId, channelId|null, at }]): never a starting point, never shown as a pick; keywords: searched for picks; blockedWords: picks whose title or
 * channel contains one are dropped.
 */
const TASTE_DEFAULTS = { hearts: [], plays: [], subs: [], names: {}, avatars: {}, excluded: [], pinned: [], blocked: [], keywords: [], blockedWords: [] };
const FIRST_MIX = 30; // % of Home that is MyTube's own picks, for a profile that has no setting yet
const newTaste = () => ({ ...JSON.parse(JSON.stringify(TASTE_DEFAULTS)), mix: FIRST_MIX, useSubs: true });
/** The main profile keeps the original key, so existing data stays where it is. */
const tasteKey = (id) => (id === 'main' ? KEYS.taste : `${KEYS.taste}.${id}`);
/** Loads one profile's taste; lists added in later versions are added (empty) once. */
function loadTaste(id, firstMix) {
  const taste = load(tasteKey(id), newTaste());
  let changed = false;
  for (const [k, v] of Object.entries(TASTE_DEFAULTS)) {
    if (!(k in taste)) {
      taste[k] = Array.isArray(v) ? [] : {};
      changed = true;
    }
  }
  if (!('mix' in taste)) {
    taste.mix = firstMix;
    changed = true;
  }
  if (!('useSubs' in taste)) {
    taste.useSubs = true; // draw picks from subscribed channels, as before this setting existed
    changed = true;
  }
  if (changed) save(tasteKey(id), taste);
  return taste;
}

export const store = {
  /** Stable id for this phone; the TV uses it to recognise the same remote across reconnects. */
  deviceId,

  settings: load(KEYS.settings, {
    deviceName: 'MyTube Remote',
    cookies: '',
    screen: null, // { screenId, loungeToken, name, expiration }
    autoConnect: true,
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
    this.videos[v.videoId] = { videoId: v.videoId, title: v.title, channel: v.channel, duration: v.duration, thumbnail: v.thumbnail, ...(v.channelId ? { channelId: v.channelId } : {}), ...(v.channelAvatar ? { channelAvatar: v.channelAvatar } : {}) };
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
  taste: null, // the active profile's taste; loaded below, once settings exist
  /**
   * Profiles for MyTube's own picks: each has its own taste (keywords, blocks, pins, the videos
   * picks start from, the mix). Plays are recorded into the active one only.
   */
  profiles: load(KEYS.profiles, { active: 'main', list: [{ id: 'main', name: 'Main' }] }),
  saveProfiles() {
    save(KEYS.profiles, this.profiles);
  },
  profileName() {
    return this.profiles.list.find((p) => p.id === this.profiles.active).name;
  },
  switchProfile(id) {
    if (!this.profiles.list.some((p) => p.id === id)) throw new Error(`No profile ${id}`);
    this.saveTaste();
    this.profiles.active = id;
    this.saveProfiles();
    this.taste = loadTaste(id, FIRST_MIX);
  },
  /** copy: start from the active profile's lists instead of empty ones (known channels are always carried over). */
  createProfile(name, copy) {
    if (this.profiles.list.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a profile called "${name}"`);
    const id = `p${Date.now().toString(36)}`;
    const cur = this.taste;
    const taste = copy ? JSON.parse(JSON.stringify(cur)) : { ...newTaste(), subs: cur.subs.slice(), names: { ...cur.names }, avatars: { ...cur.avatars }, mix: cur.mix };
    save(tasteKey(id), taste);
    this.profiles.list.push({ id, name });
    this.switchProfile(id);
    return id;
  },
  renameProfile(id, name) {
    if (this.profiles.list.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a profile called "${name}"`);
    this.profiles.list.find((p) => p.id === id).name = name;
    this.saveProfiles();
  },
  deleteProfile(id) {
    if (this.profiles.list.length === 1) throw new Error('This is the only profile; it cannot be deleted');
    if (id === 'main') throw new Error('The Main profile cannot be deleted (reset it instead)');
    if (this.profiles.active === id) this.switchProfile('main');
    this.profiles.list = this.profiles.list.filter((p) => p.id !== id);
    this.saveProfiles();
    localStorage.removeItem(tasteKey(id));
  },
  /** A profile's taste, whether or not it is the active one. */
  tasteOf(profileId) {
    return profileId === this.profiles.active ? this.taste : loadTaste(profileId, FIRST_MIX);
  },
  /** Hearts (or un-hearts) a video for one profile. A hearted video leaves that profile's "don't use" list. */
  setHeart(profileId, video, on) {
    const taste = this.tasteOf(profileId);
    taste.hearts = taste.hearts.filter((h) => h.videoId !== video.videoId);
    if (on) {
      taste.hearts.unshift({ videoId: video.videoId, channelId: video.channelId ? video.channelId : null, at: Date.now() });
      taste.excluded = taste.excluded.filter((x) => x.videoId !== video.videoId);
      if (video.channelId && video.channel) taste.names[video.channelId] = video.channel;
      if (video.channelId && video.channelAvatar) taste.avatars[video.channelId] = video.channelAvatar;
    }
    save(tasteKey(profileId), taste);
  },
  resetTaste() {
    const keep = this.taste.mix;
    this.taste = { ...newTaste(), mix: keep, useSubs: this.taste.useSubs };
    this.saveTaste();
  },
  saveTaste() {
    save(tasteKey(this.profiles.active), this.taste);
  },
  /** channelId / channelName may be null when the TV started a video this phone knows nothing about. */
  recordPlay(videoId, channelId, channelName, channelAvatar) {
    if (this.taste.excluded.some((x) => x.videoId === videoId)) return; // marked "don't use"
    if (channelId && channelAvatar) this.taste.avatars[channelId] = channelAvatar;
    const before = this.taste.plays.find((p) => p.videoId === videoId);
    const plays = this.taste.plays.filter((p) => p.videoId !== videoId);
    // A later report without the channel must not erase a channel learned earlier.
    plays.unshift({ videoId, channelId: channelId || (before ? before.channelId : null), at: Date.now() });
    this.taste.plays = plays.slice(0, 150);
    if (channelId && channelName) this.taste.names[channelId] = channelName;
    this.saveTaste();
  },
  rememberSubs(channels) {
    // The subscription list is a fact about the account, not a preference: every profile gets it.
    this.saveTaste();
    for (const p of this.profiles.list) {
      const taste = p.id === this.profiles.active ? this.taste : loadTaste(p.id, FIRST_MIX);
      taste.subs = channels.map((c) => c.channelId);
      for (const c of channels) {
        if (c.title) taste.names[c.channelId] = c.title;
        if (c.avatar) taste.avatars[c.channelId] = c.avatar;
      }
      save(tasteKey(p.id), taste);
    }
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
    for (const k of Object.keys(localStorage)) if (k.startsWith('mytube.')) localStorage.removeItem(k);
  },
};

// The mix used to be one setting for everything; it now belongs to each profile. The first load
// hands the saved value to the profile and drops the old setting.
store.taste = loadTaste(store.profiles.active, 'feedMix' in store.settings ? store.settings.feedMix : FIRST_MIX);
if ('feedMix' in store.settings) {
  delete store.settings.feedMix;
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
