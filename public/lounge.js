/**
 * Browser-side Lounge remote session.
 *
 * Owns the channel bookkeeping (sid / gsessionid / aid / rid / ofs), keeps the
 * event stream open, recovers from the usual failures (expired lounge token,
 * dead session id, closed long-poll) and exposes the TV's player state.
 *
 * Events dispatched (CustomEvent, see `detail`):
 *   'status'   connection status changed       { status, detail }
 *   'player'   player state changed            (read remote.player / remote.ad)
 *   'tvqueue'  the TV reported its playlist    (read remote.tvQueue)
 *   'devices'  loungeStatus arrived            (read remote.screenName)
 *   'ad'       ad phase changed                { phase: 'start' | 'skippable' | 'end' }
 *   'error'    a recoverable error happened    { error }
 */
import { api, ApiError } from './api.js';
import { log } from './debug.js';

export const PLAYER_STATE = { STOPPED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5, AD: 1081, AD_SKIPPED: 1082 };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class Remote extends EventTarget {
  /**
   * @param {object} o
   * @param {string} o.deviceId            stable id for this phone
   * @param {() => string} o.getDeviceName  name shown on the TV
   * @param {() => object|null} o.getScreen { screenId, loungeToken, name, expiration } or null
   * @param {(screen: object) => void} o.setScreen persist a refreshed token
   */
  constructor({ deviceId, getDeviceName, getScreen, setScreen }) {
    super();
    this.deviceId = deviceId;
    this.getDeviceName = getDeviceName;
    this.getScreen = getScreen;
    this.setScreen = setScreen;

    this.status = 'disconnected';
    this.statusDetail = '';
    this.session = null;
    this.screenName = '';
    this.player = this._emptyPlayer();
    this.ad = { active: false, skipEnabled: false, title: '' };
    this.tvQueue = { listId: null, videoIds: [], currentIndex: -1 };

    this._generation = 0;
    this._loopId = 0;
    this._streamAbort = null;
    this._chain = Promise.resolve();
  }

  _emptyPlayer() {
    return {
      videoId: null,
      currentTime: 0,
      duration: 0,
      state: PLAYER_STATE.STOPPED,
      listId: null,
      currentIndex: -1,
      updatedAt: Date.now(),
      hasPrevious: false,
      hasNext: false,
      autoplayMode: null,
      volume: null,
      muted: null,
      upNextVideoId: null,
    };
  }

  get connected() {
    return this.status === 'connected';
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
    log('status', `${status}${detail ? ` — ${detail}` : ''}`);
    this._emit('status', { status, detail });
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /** Pairs with a 12-digit code and stores the screen. Does not connect. */
  async pair(code) {
    const screen = await api('/api/lounge/pair', { method: 'POST', body: { code } });
    this.setScreen(screen);
    return screen;
  }

  async _refreshToken() {
    const screen = this.getScreen();
    if (!screen) throw new Error('No TV is paired');
    const fresh = await api('/api/lounge/refresh', { method: 'POST', body: { screenId: screen.screenId } });
    this.setScreen({ ...screen, loungeToken: fresh.loungeToken, expiration: fresh.expiration });
  }

  /** Opens the channel to the paired TV and starts listening for events. */
  async connect() {
    const screen = this.getScreen();
    if (!screen) throw new Error('No TV is paired yet. Enter the TV code first.');
    this._generation += 1;
    const gen = this._generation;
    this._abortStream();
    this._setStatus('connecting');
    try {
      await this._bind(gen, /* allowRefresh */ true);
    } catch (e) {
      if (gen === this._generation) this._setStatus('disconnected', e.message);
      throw e;
    }
  }

  async _bind(gen, allowRefresh) {
    const screen = this.getScreen();
    const session = { loungeToken: screen.loungeToken, deviceId: this.deviceId, name: this.getDeviceName(), rid: 1, ofs: 0 };
    let result;
    try {
      result = await api('/api/lounge/connect', { method: 'POST', body: session });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TOKEN_EXPIRED' && allowRefresh) {
        log('app', 'lounge token expired during bind; refreshing and retrying');
        await this._refreshToken();
        return this._bind(gen, false);
      }
      throw e;
    }
    if (gen !== this._generation) return; // superseded by a newer connect/disconnect
    log('app', `bound to TV (aid ${result.aid}, ${result.events.length} initial events)`);
    this.session = { ...session, sid: result.sid, gsessionid: result.gsessionid, aid: result.aid, rid: 2, ofs: 0 };
    this.player = this._emptyPlayer();
    this.ad = { active: false, skipEnabled: false, title: '' };
    this.tvQueue = { listId: null, videoIds: [], currentIndex: -1 };
    for (const ev of result.events) this._handleEvent(ev);
    this._setStatus('connected');
    this._emit('player');
    this._loopId += 1;
    this._streamLoop(gen, this._loopId);
  }

  /** Re-opens the channel after SESSION_LOST without touching the UI status. */
  async _rebind() {
    const gen = this._generation;
    await this._bind(gen, true);
  }

  async disconnect() {
    this._generation += 1;
    this._abortStream();
    const session = this.session;
    this.session = null;
    this._setStatus('disconnected');
    if (session) {
      try {
        await api('/api/lounge/disconnect', { method: 'POST', body: session });
      } catch (e) {
        this._emit('error', { error: e });
      }
    }
  }

  _abortStream() {
    if (this._streamAbort) {
      this._streamAbort.abort();
      this._streamAbort = null;
    }
  }

  /** Call when the app returns to the foreground: restart the stream and ask for fresh state. */
  async resume() {
    if (!this.connected) return;
    this._abortStream();
    await this.getNowPlaying();
  }

  // ---------------------------------------------------------------------------
  // Event stream
  // ---------------------------------------------------------------------------

  async _streamLoop(gen, loopId) {
    let backoff = 1000;
    const alive = () => gen === this._generation && loopId === this._loopId && this.connected && this.session;
    while (alive()) {
      const abort = new AbortController();
      this._streamAbort = abort;
      try {
        await this._streamOnce(abort.signal);
        backoff = 1000;
        await new Promise((r) => setTimeout(r, 300)); // YouTube closes each long-poll; never spin
      } catch (e) {
        if (abort.signal.aborted) {
          // Aborted on purpose (resume / disconnect). Loop condition decides what happens next.
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        if (!alive()) return;
        const code = e instanceof ApiError ? e.code : null;
        log('error', `event stream failed: ${e.message}`, { code });
        try {
          if (code === 'SESSION_LOST') {
            await this._rebind();
            return; // _bind started a new loop
          }
          if (code === 'TOKEN_EXPIRED') {
            await this._refreshToken();
            await this._rebind();
            return;
          }
          if (code === 'SCREEN_GONE') {
            this._setStatus('disconnected', e.message);
            this._emit('error', { error: e });
            return;
          }
        } catch (inner) {
          this._emit('error', { error: inner });
          this._setStatus('disconnected', inner.message);
          return;
        }
        this._emit('error', { error: e });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      } finally {
        if (this._streamAbort === abort) this._streamAbort = null;
      }
    }
  }

  async _streamOnce(signal) {
    const s = this.session;
    const q = new URLSearchParams({
      loungeToken: s.loungeToken,
      deviceId: s.deviceId,
      name: s.name,
      sid: s.sid,
      gsessionid: s.gsessionid,
      aid: String(s.aid),
      rid: String(s.rid),
      ofs: String(s.ofs),
    });
    const res = await fetch(`/api/lounge/events?${q}`, { signal });
    if (!res.ok) {
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new ApiError(res.status, 'BAD_JSON', `Event stream failed with HTTP ${res.status}: ${text.slice(0, 160)}`);
      }
      throw new ApiError(res.status, json.error.code, json.error.message, json.error.detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new ApiError(502, msg.error.code, msg.error.message, msg.error.detail);
        this._handleEvent(msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** Sends one command; commands are serialised so the TV sees them in order. */
  send(name, params = {}) {
    const run = () => this._send(name, params, true);
    const p = this._chain.then(run, run);
    const spacing = name === 'addVideo' || name === 'insertVideo' || name === 'removeVideo' || name === 'setPlaylist' ? 1200 : 0;
    this._chain = p.then(() => new Promise((r) => setTimeout(r, spacing)), () => {});
    return p;
  }

  async _send(name, params, allowRecover) {
    if (!this.connected || !this.session) {
      log('error', `command ${name} while not connected`, params);
      throw new Error(`Not connected to the TV (tried to send ${name})`);
    }
    const s = this.session;
    const payload = { session: { ...s }, commands: [{ name, params }] };
    s.rid += 1;
    s.ofs += 1;
    const started = Date.now();
    try {
      const result = await api('/api/lounge/command', { method: 'POST', body: payload });
      log('cmd', `${name} ok (${Date.now() - started} ms, rid ${s.rid}, ofs ${s.ofs})`, params);
      for (const ev of result.events) this._handleEvent(ev);
      return result;
    } catch (e) {
      log('error', `${name} failed: ${e.message}`, { params, code: e.code });
      if (e instanceof ApiError && allowRecover && (e.code === 'SESSION_LOST' || e.code === 'TOKEN_EXPIRED')) {
        log('app', `recovering from ${e.code}: rebinding and retrying ${name}`);
        if (e.code === 'TOKEN_EXPIRED') await this._refreshToken();
        this._abortStream();
        await this._rebind();
        return this._send(name, params, false);
      }
      throw e;
    }
  }

  /**
   * Replaces the TV's playlist with `videoIds`, starting at `index` and
   * `seconds`. The Xbox ignores a setPlaylist that is missing any of these
   * fields, so always send the full set.
   */
  setPlaylist(videoIds, index, seconds) {
    if (!Array.isArray(videoIds) || videoIds.length === 0) throw new Error('setPlaylist needs at least one video');
    if (!(index >= 0 && index < videoIds.length)) throw new Error(`setPlaylist index ${index} out of range`);
    return this.send('setPlaylist', {
      videoId: videoIds[index],
      videoIds: videoIds.join(','),
      currentIndex: index,
      currentTime: Math.max(0, Math.floor(seconds)),
      listId: '',
      params: '',
      playerParams: '',
      audioOnly: 'false',
      prioritizeMobileSenderPlaybackStateOnConnection: 'true',
    });
  }
  addVideo(videoId) {
    return this.send('addVideo', { videoId });
  }
  insertVideo(videoId) {
    return this.send('insertVideo', { videoId });
  }
  removeVideo(videoId) {
    return this.send('removeVideo', { videoId });
  }
  play() {
    return this.send('play');
  }
  pause() {
    return this.send('pause');
  }
  next() {
    return this.send('next');
  }
  previous() {
    return this.send('previous');
  }
  seekTo(seconds) {
    return this.send('seekTo', { newTime: Math.max(0, Math.floor(seconds)) });
  }
  skipAd() {
    return this.send('skipAd');
  }
  stopVideo() {
    return this.send('stopVideo');
  }
  mute() {
    return this.send('mute');
  }
  unMute() {
    return this.send('unMute');
  }
  setAutoplay(enabled) {
    return this.send('setAutoplayMode', { autoplayMode: enabled ? 'ENABLED' : 'DISABLED' });
  }
  setVolume(volume) {
    return this.send('setVolume', { volume: Math.max(0, Math.min(100, Math.round(volume))) });
  }
  getNowPlaying() {
    return this.send('getNowPlaying');
  }

  // ---------------------------------------------------------------------------
  // Events from the TV
  // ---------------------------------------------------------------------------

  _handleEvent(ev) {
    if (this.session && typeof ev.id === 'number' && ev.id > this.session.aid) this.session.aid = ev.id;
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (ev.name !== 'noop') log('event', `${ev.name} #${ev.id}`, ev.payload);
    const pl = this.player;
    switch (ev.name) {
      case 'noop':
        return;
      case 'nowPlaying': {
        if (typeof p.videoId === 'string' && p.videoId) {
          pl.videoId = p.videoId;
          pl.currentTime = num(p.currentTime);
          pl.duration = num(p.duration);
          pl.state = p.state === undefined ? pl.state : num(p.state);
          pl.listId = typeof p.listId === 'string' ? p.listId : pl.listId;
          pl.currentIndex = p.currentIndex === undefined ? pl.currentIndex : num(p.currentIndex);
          if (typeof p.mdxExpandedReceiverVideoIdList === 'string') {
            this.tvQueue = { listId: pl.listId, videoIds: p.mdxExpandedReceiverVideoIdList.split(',').filter(Boolean), currentIndex: pl.currentIndex };
            this._emit('tvqueue');
          }
        } else {
          // Empty nowPlaying: the TV is idle (home screen / nothing loaded).
          const keep = { autoplayMode: pl.autoplayMode, volume: pl.volume, muted: pl.muted };
          this.player = { ...this._emptyPlayer(), ...keep };
        }
        this.player.updatedAt = Date.now();
        this._adFromState(this.player.state);
        this._emit('player');
        return;
      }
      case 'onStateChange': {
        pl.currentTime = num(p.currentTime);
        pl.duration = num(p.duration);
        pl.state = num(p.state);
        pl.updatedAt = Date.now();
        this._adFromState(pl.state);
        this._emit('player');
        return;
      }
      case 'playlistModified': {
        this.tvQueue = {
          listId: typeof p.listId === 'string' ? p.listId : null,
          videoIds: typeof p.videoIds === 'string' ? p.videoIds.split(',').filter(Boolean) : [],
          currentIndex: p.currentIndex === undefined ? -1 : num(p.currentIndex),
        };
        if (typeof p.listId === 'string') pl.listId = p.listId;
        this._emit('tvqueue');
        return;
      }
      case 'adPlaying': {
        this._setAd({ active: true, skipEnabled: p.isSkipEnabled === 'true', title: typeof p.adTitle === 'string' ? p.adTitle : this.ad.title });
        this._emit('player');
        return;
      }
      case 'onAdStateChange': {
        // adState "0" is YouTube telling us the ad finished; anything else means an ad is up.
        const over = p.adState === '0' || p.adState === 'AD_STATE_NONE';
        this._setAd({ active: !over, skipEnabled: !over && p.isSkipEnabled === 'true', title: this.ad.title });
        if (p.currentTime !== undefined) pl.updatedAt = Date.now();
        this._emit('player');
        return;
      }
      case 'loungeStatus': {
        let devices = [];
        if (typeof p.devices === 'string' && p.devices) devices = JSON.parse(p.devices);
        const screen = devices.find((d) => d.type === 'LOUNGE_SCREEN');
        if (screen && typeof screen.name === 'string') this.screenName = screen.name;
        this.devices = devices;
        this._emit('devices');
        return;
      }
      case 'loungeScreenDisconnected': {
        this._abortStream();
        this.session = null;
        this._setStatus('disconnected', `The TV disconnected (${typeof p.reason === 'string' ? p.reason : 'no reason given'})`);
        return;
      }
      case 'onVolumeChanged':
        pl.volume = num(p.volume);
        pl.muted = p.muted === 'true';
        this._emit('player');
        return;
      case 'onAutoplayModeChanged':
        pl.autoplayMode = typeof p.autoplayMode === 'string' ? p.autoplayMode : null;
        this._emit('player');
        return;
      case 'onHasPreviousNextChanged':
        pl.hasPrevious = p.hasPrevious === 'true';
        pl.hasNext = p.hasNext === 'true';
        this._emit('player');
        return;
      case 'autoplayUpNext':
        pl.upNextVideoId = typeof p.videoId === 'string' ? p.videoId : null;
        this._emit('player');
        return;
      default:
        // onSubtitlesTrackChanged, onPlaylistModeChanged, onVideoQualityChanged, remoteConnected, ...
        return;
    }
  }

  _adFromState(state) {
    if (state === PLAYER_STATE.AD) {
      if (!this.ad.active) this._setAd({ active: true, skipEnabled: false, title: '' });
    } else if (state === PLAYER_STATE.AD_SKIPPED || state === PLAYER_STATE.PLAYING || state === PLAYER_STATE.PAUSED || state === PLAYER_STATE.ENDED || state === PLAYER_STATE.STOPPED) {
      if (this.ad.active) this._setAd({ active: false, skipEnabled: false, title: '' });
    }
  }

  /** Single place where ad state changes, so phase transitions are announced exactly once. */
  _setAd(next) {
    const prev = this.ad;
    this.ad = next;
    if (!prev.active && next.active) this._emit('ad', { phase: 'start' });
    if (next.active && !prev.skipEnabled && next.skipEnabled) this._emit('ad', { phase: 'skippable' });
    if (prev.active && !next.active) this._emit('ad', { phase: 'end' });
  }

  /** Estimated playhead now, interpolated while playing. */
  estimatedTime() {
    const pl = this.player;
    if (!pl.videoId) return 0;
    let t = pl.currentTime;
    if (pl.state === PLAYER_STATE.PLAYING && !this.ad.active) t += (Date.now() - pl.updatedAt) / 1000;
    if (pl.duration > 0) t = Math.min(t, pl.duration);
    return Math.max(0, t);
  }
}
