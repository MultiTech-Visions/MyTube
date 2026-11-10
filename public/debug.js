/**
 * On-phone debug log.
 *
 * Nothing of ours runs on the Xbox, so the only record of what it did is the
 * stream of Lounge events YouTube relays to this phone, plus the commands we
 * sent and what the server answered. This module keeps the last few hundred
 * of those (persisted, so a crash or restart does not lose them) with
 * timestamps, and can hand the whole thing over as text for pasting into a
 * bug report. Tokens and cookies are redacted before anything is stored.
 */
const KEY = 'mytube.debuglog';
const MAX = 800;

const entries = (() => {
  const raw = localStorage.getItem(KEY);
  return raw === null ? [] : JSON.parse(raw);
})();
let dirty = false;
let flushTimer = null;

function redact(value) {
  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/loungeToken|loungeIdToken|cookie|gsessionid|^sid$/i.test(k)) out[k] = v ? '[redacted]' : v;
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  localStorage.setItem(KEY, JSON.stringify(entries));
}

/**
 * @param {string} kind   short category: 'event' | 'cmd' | 'api' | 'error' | 'app' | 'status'
 * @param {string} msg    one line summary
 * @param {*} [data]      extra detail (object/array/string), redacted and size-limited
 */
export function log(kind, msg, data) {
  const entry = { t: Date.now(), k: kind, m: msg };
  if (data !== undefined) entry.d = redact(data);
  // A repeat of the previous entry (same kind, same text apart from numbers, same data) is
  // counted on that entry instead of stored again: "×6 until 13:25:02".
  const last = entries[entries.length - 1];
  if (last && last.k === kind && groupKey(last) === groupKey(entry)) {
    last.n = (last.n === undefined ? 1 : last.n) + 1;
    last.t2 = entry.t;
  } else {
    entries.push(entry);
  }
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(flush, 500);
  if (kind === 'error') console.error(`[mytube] ${msg}`, data === undefined ? '' : data);
}

function groupKey(entry) {
  return `${entry.m.replace(/\d+/g, '#')}|${entry.d === undefined ? '' : JSON.stringify(entry.d)}`;
}

/**
 * What to keep of a TV event's payload. A few events repeat a large, unchanging blob with every
 * video (the device list, every audio track, the caption style); those are cut to what matters.
 */
export function eventData(name, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (name === 'loungeStatus') {
    const devices = JSON.parse(payload.devices);
    return { queueId: payload.queueId, devices: devices.map((d) => `${d.name} (${d.clientName}, ${d.type})`) };
  }
  if (name === 'onAudioTrackListChanged') return { audioTracks: `${JSON.parse(payload.audioTracks).length} tracks` };
  if (name === 'onSubtitlesTrackChanged') {
    const { style, ...rest } = payload;
    return rest;
  }
  return payload;
}

export function count() {
  return entries.length;
}

export function clear() {
  entries.length = 0;
  dirty = true;
  flush();
}

function fmt(entry) {
  const d = new Date(entry.t);
  const time = `${d.toISOString().slice(11, 23)}`;
  const data = entry.d === undefined ? '' : ' ' + (typeof entry.d === 'string' ? entry.d : JSON.stringify(entry.d));
  const repeat = entry.n === undefined ? '' : ` ×${entry.n} until ${new Date(entry.t2).toISOString().slice(11, 23)}`;
  return `${time} ${entry.k.padEnd(6)} ${entry.m}${data}${repeat}`;
}

/** The log as text, newest last, with a header describing the device. */
export function asText(context) {
  const head = [
    `MyTube debug log — exported ${new Date().toISOString()}`,
    `userAgent: ${navigator.userAgent}`,
    `page: ${location.href}`,
    `standalone: ${window.matchMedia('(display-mode: standalone)').matches}`,
    ...Object.entries(context || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(redact(v))}`),
    `entries: ${entries.length}`,
    '',
  ];
  return head.join('\n') + entries.map(fmt).join('\n') + '\n';
}

/** Latest entries for the on-screen viewer. */
export function recent(n) {
  return entries.slice(-n).map(fmt);
}

window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
