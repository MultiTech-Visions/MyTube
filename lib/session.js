'use strict';

/**
 * Server-side TV session ("autopilot").
 *
 * The phone's browser gets frozen or throttled by Android when the screen is
 * off or another app is in front, so anything time-critical (skip, dodge,
 * mute, SponsorBlock) cannot live there. This module holds the Lounge
 * connection to the TV on the server, keeps the player state, runs the ad
 * engine, and fans every TV event out to the phone(s) that attach.
 *
 * One session per TV (screenId), kept in this instance's memory, so the
 * service must run with max instances = 1. While a session is alive it keeps
 * one request open to its own /api/remote/hold endpoint so Cloud Run keeps
 * CPU allocated (request-based billing); it closes itself after the TV has
 * been idle and no phone has been in contact for IDLE_CLOSE_MS.
 */

const lounge = require('./lounge');
const sponsorblock = require('./sponsorblock');
const { HttpError } = require('./util');

const STATE = { STOPPED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5, AD: 1081, AD_SKIPPED: 1082 };
const DODGE_MIN_AD_SECONDS = 5;
const IDLE_CLOSE_MS = 15 * 60 * 1000;
const HOLD_MS = Number(process.env.HOLD_SECONDS || 540) * 1000; // below the Cloud Run request timeout (set it to 600+)
const BUFFER = 600;
const QUEUE_COMMANDS = new Set(['addVideo', 'insertVideo', 'removeVideo', 'setPlaylist']);
const NOW_COMMANDS = new Set(['play', 'pause', 'skipAd', 'next', 'previous', 'seekTo', 'setVolume', 'mute', 'unMute']);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = new Map(); // screenId -> TvSession

class TvSession {
  constructor({ screen, deviceId, name, ads, selfUrl }) {
    this.screenId = screen.screenId;
    this.screen = { ...screen };
    this.deviceId = deviceId;
    this.name = name;
    this.ads = { ...ads };
    this.selfUrl = selfUrl;

    this.status = 'connecting';
    this.statusDetail = '';
    this.lounge = null; // { loungeToken, deviceId, name, rid, ofs, aid, sid, gsessionid }
    this.player = { videoId: null, currentTime: 0, duration: 0, state: STATE.STOPPED, updatedAt: Date.now(), volume: null };
    this.ad = { active: false, skipEnabled: false, adVideoId: null, adTime: 0, adAt: 0 };
    this.tvQueue = { listId: null, videoIds: [], currentIndex: -1 };
    // Last content (not ad) position the TV reported, and whether it was playing then.
    this.lastContent = { videoId: null, time: 0, at: 0, playing: false, duration: 0 };
    this.lastRaw = new Map(); // event name -> last payload, to replay state to a phone that attaches

    this.seq = 0;
    this.buffer = [];
    this.waiters = new Set();

    this.chain = Promise.resolve();
    this.closed = false;
    this.lastPhoneAt = Date.now();
    this.lastTvActiveAt = Date.now();

    this.adRun = { videoId: null, dodges: 0, muted: false, busy: false, timer: null };
    this.pendingSeek = null;
    this.sb = { videoId: null, segments: [], skipped: new Set() };
  }

  // ---------------------------------------------------------------------------
  // Fan-out to phones
  // ---------------------------------------------------------------------------

  push(item) {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, ...item });
    if (this.buffer.length > BUFFER) this.buffer.splice(0, this.buffer.length - BUFFER);
    for (const w of this.waiters) w();
  }
  log(msg, data) {
    console.log(`[session ${this.screenId.slice(0, 8)}] ${msg}`, data === undefined ? '' : JSON.stringify(data).slice(0, 400));
    this.push({ log: msg, data });
  }
  setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
    this.push({ status, detail });
  }
  /** Items after `cursor`, or waits up to `ms` for some. */
  async since(cursor, ms) {
    const ready = () => this.buffer.filter((b) => b.seq > cursor);
    let items = ready();
    if (items.length || this.closed) return items;
    await new Promise((resolve) => {
      const w = () => {
        this.waiters.delete(w);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(w, ms);
      this.waiters.add(w);
    });
    items = ready();
    return items;
  }
  /** Events that rebuild the current TV state on a freshly attached phone. */
  replay() {
    const order = ['loungeStatus', 'onAutoplayModeChanged', 'onVolumeChanged', 'onHasPreviousNextChanged', 'playlistModified', 'nowPlaying', 'onStateChange', 'adPlaying', 'onAdStateChange'];
    const out = [];
    for (const name of order) {
      if (!this.lastRaw.has(name)) continue;
      if ((name === 'adPlaying' || name === 'onAdStateChange') && !this.ad.active) continue;
      out.push({ id: 0, name, payload: this.lastRaw.get(name) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Lounge connection
  // ---------------------------------------------------------------------------

  async bind(allowRefresh = true) {
    const base = { loungeToken: this.screen.loungeToken, deviceId: this.deviceId, name: this.name, rid: 1, ofs: 0 };
    let result;
    try {
      result = await lounge.connect(base);
    } catch (e) {
      if (e.code === 'TOKEN_EXPIRED' && allowRefresh) {
        await this.refreshToken();
        return this.bind(false);
      }
      throw e;
    }
    this.lounge = { ...base, sid: result.sid, gsessionid: result.gsessionid, aid: result.aid, rid: 2, ofs: 0 };
    this.log(`bound to TV (${result.events.length} initial events)`);
    for (const ev of result.events) this.handle(ev);
    this.setStatus('connected');
  }
  async refreshToken() {
    const fresh = await lounge.refreshToken(this.screenId);
    this.screen = { ...this.screen, loungeToken: fresh.loungeToken, expiration: fresh.expiration };
    this.log('lounge token refreshed');
    this.push({ screen: this.screen });
  }

  async run() {
    this.hold();
    this.ticker = setInterval(() => this.tick(), 1000);
    let backoff = 1000;
    while (!this.closed) {
      try {
        if (!this.lounge) await this.bind();
        const res = await lounge.openEvents(this.lounge, undefined);
        await lounge.pumpEvents(res, (ev) => this.handle(ev));
        backoff = 1000;
      } catch (e) {
        if (this.closed) break;
        this.log(`TV connection: ${e.code || ''} ${e.message}`);
        if (e.code === 'SESSION_LOST') this.lounge = null;
        else if (e.code === 'TOKEN_EXPIRED') {
          this.lounge = null;
          await this.refreshToken().catch((err) => this.log(`token refresh failed: ${err.message}`));
        } else if (e.code === 'SCREEN_GONE') {
          this.setStatus('disconnected', e.message);
          this.close('screen gone');
          break;
        } else {
          this.setStatus('connecting', e.message);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
          this.lounge = null;
        }
      }
    }
  }

  /** Keeps one request open to ourselves so Cloud Run keeps CPU for this session. */
  hold() {
    if (this.closed || !this.selfUrl) return;
    const url = `${this.selfUrl}/api/remote/hold?screenId=${encodeURIComponent(this.screenId)}`;
    console.log(`[session ${this.screenId.slice(0, 8)}] keep-alive request opened (${HOLD_MS / 1000} s)`);
    fetch(url)
      .then((r) => r.text())
      .catch((e) => this.log(`hold request failed: ${e.message}`))
      .finally(() => {
        if (!this.closed) setTimeout(() => this.hold(), 200);
      });
  }
  /** Resolves when the session closes or after HOLD_MS. Used by the hold route. */
  holdOpen() {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, HOLD_MS);
      const check = setInterval(() => {
        if (this.closed) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 1000);
      setTimeout(() => clearInterval(check), HOLD_MS + 1000);
    });
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    clearTimeout(this.adRun.timer);
    this.log(`session closed: ${reason}`);
    for (const w of this.waiters) w();
    sessions.delete(this.screenId);
    if (this.lounge) lounge.disconnect(this.lounge).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Playback controls and setPlaylist go out at once. setPlaylist replaces the
   * whole TV queue, so queue edits still waiting behind the Xbox spacing are
   * stale: they are dropped instead of being replayed on top of it.
   */
  send(name, params = {}) {
    if (NOW_COMMANDS.has(name)) return this.sendRaw(name, params, true);
    if (name === 'setPlaylist') {
      this.queueEpoch = (this.queueEpoch || 0) + 1;
      const p = this.sendRaw(name, params, true);
      this.chain = p.then(() => sleep(1200), () => {});
      return p;
    }
    const epoch = this.queueEpoch || 0;
    const run = () => ((this.queueEpoch || 0) !== epoch ? { ok: true, superseded: true } : this.sendRaw(name, params, true));
    const p = this.chain.then(run, run);
    const spacing = QUEUE_COMMANDS.has(name) ? 1200 : 0;
    this.chain = p.then(() => sleep(spacing), () => {});
    return p;
  }
  async sendRaw(name, params, allowRecover) {
    if (!this.lounge) await this.bind();
    const s = this.lounge;
    const snapshot = { ...s };
    s.rid += 1;
    s.ofs += 1;
    const started = Date.now();
    try {
      const result = await lounge.sendCommands(snapshot, [{ name, params }]);
      for (const ev of result.events) this.handle(ev);
      this.push({ cmd: name, ms: Date.now() - started, params });
      return { ok: true };
    } catch (e) {
      if (allowRecover && (e.code === 'SESSION_LOST' || e.code === 'TOKEN_EXPIRED')) {
        this.log(`${name}: ${e.code}, rebinding and retrying`);
        if (e.code === 'TOKEN_EXPIRED') await this.refreshToken();
        this.lounge = null;
        await this.bind();
        return this.sendRaw(name, params, false);
      }
      this.log(`${name} failed: ${e.message}`, params);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // TV events
  // ---------------------------------------------------------------------------

  handle(ev) {
    if (this.lounge && typeof ev.id === 'number' && ev.id > this.lounge.aid) this.lounge.aid = ev.id;
    if (ev.name === 'noop') return;
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    this.lastRaw.set(ev.name, p);
    this.push({ ev });
    const pl = this.player;
    const prevVideo = pl.videoId;
    switch (ev.name) {
      case 'nowPlaying':
        if (typeof p.videoId === 'string' && p.videoId) {
          pl.videoId = p.videoId;
          pl.currentTime = num(p.currentTime);
          pl.duration = num(p.duration);
          if (p.state !== undefined) pl.state = num(p.state);
          if (typeof p.mdxExpandedReceiverVideoIdList === 'string') {
            this.tvQueue = { listId: typeof p.listId === 'string' ? p.listId : null, videoIds: p.mdxExpandedReceiverVideoIdList.split(',').filter(Boolean), currentIndex: p.currentIndex === undefined ? this.tvQueue.currentIndex : num(p.currentIndex) };
          }
          if (p.currentIndex !== undefined) this.tvQueue.currentIndex = num(p.currentIndex);
        } else {
          this.freezeContent(); // left the player (e.g. the dodge's stopVideo)
          pl.videoId = null;
          pl.state = STATE.STOPPED;
        }
        pl.updatedAt = Date.now();
        this.adFromState(pl.state);
        break;
      case 'onStateChange':
        if (num(p.state) !== STATE.PLAYING) this.freezeContent();
        pl.currentTime = num(p.currentTime);
        pl.duration = num(p.duration);
        pl.state = num(p.state);
        pl.updatedAt = Date.now();
        this.adFromState(pl.state);
        break;
      case 'playlistModified':
        this.tvQueue = {
          listId: typeof p.listId === 'string' ? p.listId : null,
          videoIds: typeof p.videoIds === 'string' ? p.videoIds.split(',').filter(Boolean) : [],
          currentIndex: p.currentIndex === undefined ? -1 : num(p.currentIndex),
        };
        break;
      case 'adPlaying':
        this.setAd({ active: true, skipEnabled: p.isSkipEnabled === 'true', adVideoId: typeof p.adVideoId === 'string' ? p.adVideoId : this.ad.adVideoId, adTime: num(p.currentTime), adAt: Date.now() });
        break;
      case 'onAdStateChange':
        if (p.adState === '0' || p.adState === 'AD_STATE_NONE') {
          if (p.currentTime !== '0') this.setAd({ active: false, skipEnabled: false, adVideoId: null, adTime: 0, adAt: 0 });
        } else {
          this.setAd({ ...this.ad, active: true, skipEnabled: p.isSkipEnabled === 'true', adTime: num(p.currentTime), adAt: Date.now() });
        }
        break;
      case 'onVolumeChanged':
        pl.volume = num(p.volume);
        break;
      case 'loungeScreenDisconnected':
        this.setStatus('disconnected', `The TV disconnected (${p.reason || 'no reason given'})`);
        this.lounge = null;
        break;
      default:
        break;
    }
    if (pl.state === STATE.PLAYING || this.ad.active) this.lastTvActiveAt = Date.now();
    if (pl.videoId && !this.ad.active && (pl.state === STATE.PLAYING || pl.state === STATE.PAUSED)) {
      this.lastContent = { videoId: pl.videoId, time: pl.currentTime, at: Date.now(), playing: pl.state === STATE.PLAYING, duration: pl.duration };
    }
    if (pl.videoId !== prevVideo) this.videoChanged();
    this.applyPendingSeek();
  }

  estimatedTime() {
    const pl = this.player;
    let t = pl.currentTime;
    if (pl.state === STATE.PLAYING && !this.ad.active) t += (Date.now() - pl.updatedAt) / 1000;
    return pl.duration > 0 ? Math.min(t, pl.duration) : t;
  }
  /**
   * Where the video really is right now (or was when an ad cut in). The TV
   * only reports on changes, so while it plays the last report ages; add the
   * time it has been playing since.
   */
  contentPosition() {
    const c = this.lastContent;
    if (!c.videoId) return 0;
    let t = c.time + (c.playing ? (Date.now() - c.at) / 1000 : 0);
    if (c.duration > 0) t = Math.min(t, c.duration - 1);
    return Math.max(0, t);
  }

  adElapsed() {
    return this.ad.active ? this.ad.adTime + (Date.now() - this.ad.adAt) / 1000 : 0;
  }

  adFromState(state) {
    if (state === STATE.AD) {
      if (!this.ad.active) this.setAd({ active: true, skipEnabled: false, adVideoId: null, adTime: 0, adAt: Date.now() });
    } else if ([STATE.AD_SKIPPED, STATE.PLAYING, STATE.PAUSED, STATE.ENDED, STATE.STOPPED].includes(state)) {
      if (this.ad.active) this.setAd({ active: false, skipEnabled: false, adVideoId: null, adTime: 0, adAt: 0 });
    }
  }
  /** Stops the content clock: from now on the last known position no longer advances. */
  freezeContent() {
    const c = this.lastContent;
    if (!c.playing) return;
    this.lastContent = { ...c, time: this.contentPosition(), at: Date.now(), playing: false };
  }

  setAd(next) {
    const prev = this.ad;
    if (next.active && !prev.active) this.freezeContent(); // the video is not playing during an ad
    this.ad = next;
    const newAd = next.active && (!prev.active || (next.adVideoId && prev.adVideoId && next.adVideoId !== prev.adVideoId));
    if (newAd) this.onAd('start');
    if (next.active && (!prev.skipEnabled || newAd) && next.skipEnabled) this.onAd('skippable');
    if (prev.active && !next.active) this.onAd('end');
  }

  // ---------------------------------------------------------------------------
  // Ad engine
  // ---------------------------------------------------------------------------

  videoChanged() {
    const vid = this.player.videoId;
    // A dodge passes through "nothing playing" and back to the same video; that must not reset the cap.
    if (vid && this.adRun.videoId !== vid) this.adRun = { ...this.adRun, videoId: vid, dodges: 0 };
    if (!vid || vid === this.sb.videoId) return;
    this.sb = { videoId: vid, segments: [], skipped: new Set() };
    if (this.ads.sponsorBlock) {
      sponsorblock
        .segments(vid)
        .then((r) => {
          if (this.sb.videoId !== vid) return;
          this.sb.segments = r.segments;
          this.log(`SponsorBlock: ${r.segments.length} segments for ${vid}`);
        })
        .catch((e) => this.log(`SponsorBlock lookup failed: ${e.message}`));
    }
  }

  onAd(phase) {
    const a = this.ads;
    this.log(`ad ${phase}`, { skipEnabled: this.ad.skipEnabled, dodges: this.adRun.dodges });
    if (phase === 'start') {
      // Freeze the content position at the moment the ad cut in; the reload goes back there.
      if (this.adRun.resumeAt === null || this.adRun.resumeAt === undefined) {
        this.adRun.resumeAt = this.contentPosition();
        this.adRun.resumeVideo = this.lastContent.videoId;
        this.log(`ad cut in at ${Math.floor(this.adRun.resumeAt)} s of the video`);
      }
      if (a.muteAds && !this.adRun.muted) {
        this.setMuted(true).then(() => (this.adRun.muted = true)).catch(() => {});
      }
      if (a.dodge && !this.ad.skipEnabled && this.adRun.dodges < a.dodgeMax && !this.adRun.busy) this.scheduleDodge();
    } else if (phase === 'skippable') {
      clearTimeout(this.adRun.timer);
      this.adRun.timer = null;
      if (a.autoSkip) this.send('skipAd').catch(() => {});
    } else if (phase === 'end') {
      clearTimeout(this.adRun.timer);
      this.adRun.timer = null;
      if (!this.adRun.busy) this.adRun.resumeAt = null; // the next ad captures a fresh position
      if (this.adRun.muted) {
        this.setMuted(false).then(() => (this.adRun.muted = false)).catch(() => {});
      }
    }
  }
  setMuted(muted) {
    if (this.player.volume !== null) return this.send('setVolume', { volume: this.player.volume, muted: muted ? 'true' : 'false' });
    return this.send(muted ? 'mute' : 'unMute');
  }
  scheduleDodge() {
    clearTimeout(this.adRun.timer);
    const wait = Math.max(0, DODGE_MIN_AD_SECONDS - this.adElapsed()) * 1000;
    this.log(`ad dodge armed: reload in ${Math.round(wait / 1000)} s`);
    this.adRun.timer = setTimeout(() => {
      this.adRun.timer = null;
      if (this.ad.active) this.dodge('auto').catch((e) => this.log(`dodge failed: ${e.message}`));
    }, wait);
  }

  /** Leave the player (optional), reload the same list at the saved position, then force the seek. */
  async dodge(trigger) {
    if (this.adRun.busy) return { ok: false, reason: 'busy' };
    const vid = this.player.videoId || this.lastContent.videoId;
    if (!vid) throw new HttpError(409, 'NOTHING_PLAYING', 'Nothing is playing on the TV');
    this.adRun.busy = true;
    this.adRun.dodges += 1;
    try {
      let ids = this.tvQueue.videoIds.length ? this.tvQueue.videoIds.slice() : [vid];
      let index = ids.indexOf(vid);
      if (index === -1) {
        ids = [vid, ...ids];
        index = 0;
      }
      const base = this.adRun.resumeVideo === vid && typeof this.adRun.resumeAt === 'number' ? this.adRun.resumeAt : this.lastContent.videoId === vid ? this.contentPosition() : 0;
      const position = base > 0 ? base + this.ads.dodgeOffset : 0;
      this.log(`ad dodge #${this.adRun.dodges} (${trigger}, ad at ${Math.floor(this.adElapsed())} s): ${this.ads.dodgeExit ? 'stopVideo, ' : ''}reload #${index + 1} at ${Math.floor(position)} s`);
      const t0 = Date.now();
      if (this.ads.dodgeExit) {
        // The reload follows the exit immediately: the TV has processed stopVideo by the time it
        // acknowledges it, so any extra pause here is just dead air on the TV.
        await this.sendRaw('stopVideo', {}, true);
      }
      if (position > 0) this.pendingSeek = { videoId: vid, seconds: position, until: Date.now() + 120000, attempts: 0, verifyAt: 0 };
      await this.sendRaw('setPlaylist', {
        videoId: ids[index],
        videoIds: ids.join(','),
        currentIndex: index,
        currentTime: Math.floor(position),
        listId: '',
        params: '',
        playerParams: '',
        audioOnly: 'false',
        prioritizeMobileSenderPlaybackStateOnConnection: 'true',
      }, true);
      this.log(`dodge: reload sent ${Date.now() - t0} ms after the exit; the rest is the TV loading the video`);
      return { ok: true };
    } finally {
      this.adRun.busy = false;
      this.adRun.resumeAt = null; // already handed to the pending seek
    }
  }
  /**
   * After a reload YouTube ignores the requested start and resumes at its own
   * saved position, and the reload often brings a new pre-roll ad first. So
   * the target is held until the video itself is playing (however long the
   * ads take, up to 2 minutes), then sought, then checked: if the TV did not
   * land within 5 s of the target, the seek is sent once more.
   */
  applyPendingSeek() {
    const ps = this.pendingSeek;
    if (!ps) return;
    if (Date.now() > ps.until) {
      this.log(`gave up returning to ${Math.floor(ps.seconds)} s: the video did not start within 2 minutes`);
      this.pendingSeek = null;
      return;
    }
    const pl = this.player;
    if (pl.videoId !== ps.videoId || pl.state !== STATE.PLAYING || this.ad.active) return; // still loading or in an ad
    if (ps.verifyAt && Date.now() < ps.verifyAt) return; // wait for the TV to report after our seek
    const here = this.estimatedTime();
    if (Math.abs(here - ps.seconds - (ps.verifyAt ? (Date.now() - ps.verifyAt + 2500) / 1000 : 0)) < 5) {
      if (ps.attempts) this.log(`back at ${Math.floor(here)} s, where the ad cut in`);
      this.pendingSeek = null;
      return;
    }
    if (ps.attempts >= 2) {
      this.log(`TV still at ${Math.floor(here)} s after ${ps.attempts} seeks to ${Math.floor(ps.seconds)} s; giving up`);
      this.pendingSeek = null;
      return;
    }
    ps.attempts += 1;
    ps.verifyAt = Date.now() + 2500;
    this.log(`forcing seek to ${Math.floor(ps.seconds)} s (TV resumed at ${Math.floor(here)} s, attempt ${ps.attempts})`);
    this.send('seekTo', { newTime: Math.floor(ps.seconds) }).catch(() => {});
  }

  tick() {
    this.applyPendingSeek();
    // SponsorBlock
    const pl = this.player;
    if (this.ads.sponsorBlock && !this.ad.active && pl.videoId && pl.videoId === this.sb.videoId && pl.state === STATE.PLAYING) {
      const t = this.estimatedTime();
      const cats = this.ads.sponsorCategories || [];
      const seg = this.sb.segments.find((x) => cats.includes(x.category) && t >= x.start && t < x.end - 1 && !this.sb.skipped.has(x.uuid));
      if (seg) {
        this.sb.skipped.add(seg.uuid);
        this.log(`SponsorBlock: skipping ${seg.category} ${Math.floor(seg.start)}→${Math.floor(seg.end)}`);
        this.push({ toast: `Skipped ${seg.category} (${Math.round(seg.end - seg.start)} s)` });
        this.send('seekTo', { newTime: Math.ceil(seg.end) }).catch(() => {});
      }
    }
    // Idle close
    const now = Date.now();
    if (now - this.lastTvActiveAt > IDLE_CLOSE_MS && now - this.lastPhoneAt > IDLE_CLOSE_MS) this.close('TV idle and no phone for 15 minutes');
  }
}

// ---------------------------------------------------------------------------
// Public API used by the routes
// ---------------------------------------------------------------------------

function get(screenId) {
  const s = sessions.get(screenId);
  if (!s) throw new HttpError(404, 'SESSION_GONE', 'No TV session on the server (it restarted or closed); reconnecting');
  s.lastPhoneAt = Date.now();
  return s;
}

/** Creates the session if needed, updates settings, and returns what a phone needs to attach. */
async function attach({ screen, deviceId, name, ads, selfUrl }) {
  let s = sessions.get(screen.screenId);
  if (s && s.screen.loungeToken !== screen.loungeToken && s.status !== 'connected') {
    s.close('replaced');
    s = null;
  }
  if (!s) {
    s = new TvSession({ screen, deviceId, name, ads, selfUrl });
    sessions.set(screen.screenId, s);
    try {
      await s.bind(); // fail fast with a real error if the TV/token is bad
    } catch (e) {
      s.closed = true;
      sessions.delete(screen.screenId);
      throw e;
    }
    s.run().catch((e) => s.log(`session loop crashed: ${e.message}`));
  } else {
    s.ads = { ...ads };
    if (selfUrl) s.selfUrl = selfUrl;
  }
  s.lastPhoneAt = Date.now();
  return { cursor: s.seq, status: s.status, events: s.replay(), screen: s.screen };
}

module.exports = { attach, get, sessions };
