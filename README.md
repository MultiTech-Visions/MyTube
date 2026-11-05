# MyTube

A phone-side replacement for the YouTube Android app's "connect to TV" remote.
It runs as a single Cloud Run function (Node.js, Functions Framework) that
serves an installable web app (PWA) and proxies two private YouTube APIs:

* **Lounge API** — the same protocol the official app uses to drive the YouTube
  app on an Xbox / TV. Pair once with the 12-digit *Link with TV code*; after
  that everything goes through `www.youtube.com`, so the phone does not need to
  be on the same Wi-Fi as the Xbox and there is no flaky discovery step.
* **InnerTube** — the private web API behind youtube.com, used for your
  personalised Home feed, search, the related ("up next") list and chapters.
  It is authenticated with your exported youtube.com cookies, exactly like
  `yt-dlp --cookies`.

No React, no Docker, no build step. Plain HTML/CSS/JS on the phone, plain Node
on the server, one dependency (`@google-cloud/functions-framework`).

## What it fixes

| Official app problem | MyTube |
| --- | --- |
| Connection to the Xbox fails half the time (LAN discovery) | Pair once with the TV code; connection is via YouTube's servers |
| Adding to the queue sometimes wipes the queue | The queue lives on the phone. The TV is told about it, but can never erase it. One tap restores it on the TV |
| Bringing the app to the front during an ad kills the player and the queue | The phone just re-opens its event stream and asks the TV for its state. Nothing on the phone is reset |
| Playback position lost | Last known position is stored every few seconds; a restored queue resumes there |
| Hunting for the ad skip button | A full-width **Skip Ad** button appears over the artwork the moment the TV says the skip is available |
| Transient recommendations | Every video you ever queued is cached on the phone; the queue survives app restarts |

Features: Home recommendations (yours, via cookies), search, tap a video →
big **Play now / Play next / Add to queue** buttons, now-playing screen with
scrubbing, chapters (tap to seek, chapter gaps drawn on the bar), ±10 s, previous
/ next, autoplay toggle, queue with reorder/remove, related videos for whatever
is playing, mini player, installable to the Android home screen.

## Deploy on Cloud Run (inline editor)

1. Cloud Run → **Write a function** (or *Create service* → *Use an inline editor*).
   Runtime **Node.js 22**, entry point **`mytube`**, allow unauthenticated
   invocations (the app has no login of its own; keep the URL to yourself, or
   put it behind Identity-Aware Proxy).
2. Recreate these files in the editor exactly as in this repo:

   ```
   package.json
   index.js
   lib/util.js
   lib/lounge.js
   lib/innertube.js
   public/index.html
   public/style.css
   public/app.js
   public/api.js
   public/store.js
   public/lounge.js
   public/icons.js
   public/manifest.webmanifest
   public/sw.js
   public/icons/icon-192.png  icon-512.png  maskable-192.png  maskable-512.png
   ```

   The PNGs cannot be typed into the editor; upload them with
   `gcloud run deploy mytube --source .` from a checkout of this repo instead, or
   deploy once from source and switch to the editor afterwards. (Deploying from
   source is also the one-command alternative to the editor.)
3. Optional environment variables (Variables & Secrets tab):
   * `YT_COOKIES` — your youtube.com cookies, if you would rather keep them on
     the server than paste them into the phone app (the app's header wins when
     both are present).
   * `INNERTUBE_CLIENT_VERSION` — override the WEB client version string if
     YouTube ever starts rejecting the default.
4. Request timeout: set it to at least **600 s**. The event stream from YouTube
   is a long-poll that stays open for a few minutes at a time.
5. Open the service URL on the phone in Chrome → menu → **Add to Home screen**.

Local run: `npm install && npm start` → http://localhost:8080.

## First use on the phone

1. **TV tab** → on the Xbox open YouTube → Settings → *Link with TV code* →
   type the 12 digits → **Link TV**. The code is only needed once; the token
   refreshes itself (YouTube issues ~13-day tokens).
2. **TV tab → Your YouTube account** → paste cookies → **Save & test**.
   Export them on a desktop browser with a "cookies.txt" extension (e.g.
   *Get cookies.txt LOCALLY*) **from a fresh private window** that you then
   close without signing out. YouTube rotates cookies in any open tab, which
   would invalidate the exported copy. Without cookies, Home is empty and
   related videos are generic; Search still works.
3. Home → tap a video → **Play now**.

## How the queue sync works

* The phone's queue is the source of truth (`localStorage`).
* **Play now** / **Start queue** / **Restore** / **Push** send one `setPlaylist`
  with the whole queue, the index to start at and the position. That makes this
  remote the owner of the TV's playlist.
* While the queue is ours and something is playing, **Play next** →
  `insertVideo`, **Add to queue** → `addVideo`, **Remove** → `removeVideo`:
  no interruption of playback.
* If the TV is playing something this remote did not start, the first queue
  action takes it over (`setPlaylist` at the current video and position; the
  video reloads where it was).
* Reordering (▲ ▼) is local until you tap **Push** (the Xbox has no reorder
  command; a push restarts the current video at the same position).
* When the TV reports an empty playlist while the phone has one, the Queue tab
  shows **Restore on TV**.

Xbox specifics learned from the field (see `lib/lounge.js`): `setPlaylist` must
carry the full field set or the Xbox ignores it; queue commands are ignored
unless this remote started the playlist; adding the currently-playing video
kicks the TV out of the player (the app refuses to do that).

## API (served by `index.js`)

| Route | Purpose |
| --- | --- |
| `GET /api/feed[?continuation=]` | Home recommendations |
| `GET /api/search?q=` / `?continuation=` | Search |
| `GET /api/watch?id=` / `?continuation=` | Title, channel, description, chapters, related list |
| `POST /api/lounge/pair {code}` | TV code → `screenId` + `loungeToken` |
| `POST /api/lounge/refresh {screenId}` | New lounge token |
| `POST /api/lounge/availability {loungeToken}` | Is the TV online |
| `POST /api/lounge/connect {loungeToken,deviceId,name,rid}` | Open channel → `sid`, `gsessionid`, `aid`, initial events |
| `GET /api/lounge/events?…` | NDJSON stream of TV events (long-poll) |
| `POST /api/lounge/command {session, commands:[{name,params}]}` | Send commands |
| `POST /api/lounge/disconnect {…session}` | Leave |

Errors are always `{"error":{"code","message","detail"}}` with a real HTTP
status. Codes the app reacts to: `TOKEN_EXPIRED` (refresh + reconnect),
`SESSION_LOST` (reconnect), `SCREEN_GONE` (pair again), `COOKIES_INVALID` /
`COOKIES_REJECTED`, `UPSTREAM_SHAPE_CHANGED` (YouTube changed a JSON layout;
the message names the path that went missing).

## Prior art

Nobody ships a maintained phone app for this. The protocol knowledge comes from
[pyytlounge](https://github.com/FabioGNR/pyytlounge) (Python, Oct 2026),
[@iobroker/youtube-lounge](https://github.com/ioBroker/youtube-lounge) (Node,
Oct 2026), [ytlounge](https://github.com/desvaters/ytlounge) and
[ytcast](https://github.com/MarcoLucidi01/ytcast); the Xbox quirks from the
Home Assistant integration
[ha-youtube-on-tv](https://github.com/jorgediez/ha-youtube-on-tv). InnerTube
parsing follows what yt-dlp, NewPipe Extractor and youtubei.js do today
(including the 2025–2026 `lockupViewModel` migration).

## Caveats

* Both APIs are private. Google changes them; when a JSON shape moves the
  server fails loudly with `UPSTREAM_SHAPE_CHANGED` and the path, so it is a
  quick fix in `lib/innertube.js`.
* Cookie use is against YouTube's ToS in spirit; yt-dlp's wiki suggests a
  throwaway account if you are worried.
* The event stream keeps a Cloud Run instance busy while the app is in the
  foreground. For one person this is well inside the free tier.
