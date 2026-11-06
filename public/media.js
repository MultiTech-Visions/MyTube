/**
 * Phone notification / lock-screen controls for what the TV is playing.
 *
 * Android only shows a media notification for a page that is playing audio,
 * so a looping clip of silence plays on the phone while the TV plays. The
 * Media Session API fills the notification (title, channel, artwork, progress)
 * and routes its buttons to the TV. Side benefit: Chrome keeps the page alive
 * in the background while audio plays, so the TV connection stays open.
 *
 * Chrome only allows audio to start from a tap, so start() must be called from
 * a user gesture; it is re-armed on every tap until it succeeds.
 */
let audio = null;
let handlersSet = false;

function silentWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export const media = {
  supported: 'mediaSession' in navigator,
  active: false,

  /** Call from a tap. Resolves true once the notification can show. */
  async start() {
    if (!this.supported) return false;
    if (!audio) {
      audio = new Audio(silentWav(10)); // Chrome ignores clips shorter than 5 s
      audio.loop = true;
    }
    if (!audio.paused) return true;
    await audio.play();
    this.active = true;
    return true;
  },

  stop() {
    if (audio && !audio.paused) audio.pause();
    this.active = false;
    if (this.supported) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  },

  /** handlers: { play, pause, next, previous, seekBy(delta), seekTo(seconds) } */
  setHandlers(h) {
    if (!this.supported || handlersSet) return;
    handlersSet = true;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch (e) {
        // This browser does not offer that button; the others still work.
      }
    };
    set('play', () => h.play());
    set('pause', () => h.pause());
    set('nexttrack', () => h.next());
    set('previoustrack', () => h.previous());
    set('seekforward', (d) => h.seekBy(d && d.seekOffset ? d.seekOffset : 10));
    set('seekbackward', (d) => h.seekBy(-(d && d.seekOffset ? d.seekOffset : 10)));
    set('seekto', (d) => h.seekTo(d.seekTime));
    set('stop', () => h.pause());
  },

  /** { title, artist, artwork, playing, position, duration } */
  update(info) {
    if (!this.supported || !this.active) return;
    const ms = navigator.mediaSession;
    const key = `${info.title}|${info.artist}|${info.artwork}`;
    if (this._key !== key) {
      this._key = key;
      ms.metadata = new MediaMetadata({
        title: info.title,
        artist: info.artist,
        album: 'Playing on TV',
        artwork: info.artwork ? [{ src: info.artwork, sizes: '480x360', type: 'image/jpeg' }] : [],
      });
    }
    ms.playbackState = info.playing ? 'playing' : 'paused';
    if (info.duration > 0 && ms.setPositionState) {
      ms.setPositionState({ duration: info.duration, position: Math.min(info.position, info.duration), playbackRate: info.playing ? 1 : 0.0001 });
    }
  },
};
