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
is playing, full description with every link resolved (YouTube hides real URLs
behind redirects and truncates them), comments with replies, like / dislike,
Save to Watch Later or any playlist (or a new one), a Library tab with Watch
Later, watch history and your playlists (Play all / Queue all), mini player,
installable to the Android home screen, and a built-in debug log.

Also: a **Subs** tab (your subscriptions feed with a horizontal strip of
channel avatars to filter by channel), **remove from recommendations** in the
video sheet on Home (YouTube's own "Not interested" / "Don't recommend
channel" when YouTube provides them, plus a local "Hide from my feed" that
always works and is remembered), and **notification / lock-screen controls**:
while the TV plays, the phone shows a media notification with play/pause,
next, previous and seek. Android only shows that for a page playing audio, so
the app plays silence; it starts on your first tap after the TV starts
playing.

**Home is a mix.** Next to YouTube's recommendations, Home blends in MyTube's
own picks, built without your account (`lib/mix.js`, `POST /api/mix`): videos
related to what you played or queued here, the latest uploads of the channels
you watch most and of your subscriptions (remembered on the phone while the
login worked), and a few "explore" picks one step further out. Cards say
which kind they are. TV tab → Home feed sets the share (default 30 %). When
the YouTube login fails, Home switches to 100 % own picks by itself and says
so; it goes back on the next refresh that finds the login working.

**Channel pages:** every video card shows the channel's avatar left of the
title; tap it for the channel page (banner, avatar, handle, subscribers,
video count, description), with **Videos** (Latest / Popular / Oldest),
**Playlists** (open one, Play all / Queue all) and **Search** within the
channel. The phone's Back button closes it.

**Swipe on any video card** (Home, Subs, Search, Related, Watch later):
swipe right to add it to the queue, swipe left to get rid of it (hidden for
good on Home/Subs, plus YouTube's "Not interested" when offered; removed from
Watch later in that list). Leave it alone to keep it for later. A short swipe
springs back; tapping still opens the Play now / Play next / Add to queue sheet.

Everything under Library and Subs, plus rating, saving and "Not interested", needs your cookies: YouTube
only answers those calls for a signed-in account.

## Ads: what can be done over this protocol, and what MyTube does

Research summary (Nov 2026; sources in the Prior art section):

* **Only skippable ads can be skipped.** The Lounge `skipAd` command works
  exactly when the TV shows the skip button (`onAdStateChange` /
  `adPlaying` with `isSkipEnabled: "true"`). In an ad pod it skips one ad;
  the next one is announced as its own `adPlaying`. MyTube's **Skip ads
  automatically** (on by default) sends `skipAd` the instant the TV reports
  the button, so you never hunt for it.
* **Unskippable ads can be dodged by reloading.** An experimental
  iSponsorBlockTV branch (`close-ads-5s`, Sept–Oct 2026) implements the
  same trick you found by hand: once the ad has played 5 seconds (their
  testers saw earlier reloads ignored), load the video again at the saved
  position. On your Xbox the hand-done combo works about 1.5 s into the
  ad, so MyTube's wait is a setting, **Dodge after** (TV tab → Ads),
  default **right away**; raise it if the ad comes straight back. Two details matter: YouTube ignores the position in the reload
  and restores its own stale saved time (10–20 s old), so a `seekTo` must
  follow once the video reports playing; and testers see the occasional
  second ad after a reload, so there is a per-video cap. MyTube's **Dodge
  unskippable ads** does this, with your "press B first" step as the
  default (`stopVideo` before the reload, switchable off), a cap of 2
  reloads per video, and a 2 s offset past the point where the ad hit so a
  mid-roll cue is not crossed again. Also available as a **Dodge** button
  on the ad overlay. Untested on the Xbox itself; the log records every
  step.
* **Fake "ad ended" events.** Since spring 2025 YouTube sends
  `onAdStateChange adState=0, currentTime=0` right before an ad starts.
  MyTube ignores that one (as iSponsorBlockTV does), otherwise auto-skip
  and mute would misfire.
* **Mute during ads** sends `setVolume {volume, muted:true}` on ad start
  and unmutes when the ad ends (iSponsorBlockTV's approach; whether the
  Xbox app honours app-level mute is unknown, the log will show).
* **SponsorBlock** (off by default): community-marked sponsor / self-promo /
  interaction segments are seeked over, using the privacy-preserving
  hashed-prefix lookup. Segments show as purple marks on the progress bar.
  Categories are selectable in the TV tab.
* **Not possible from here:** choosing shorter ads. 30-second unskippable
  ads are a connected-TV-only format, and nothing in the Lounge protocol
  influences which ads the TV client is served (`params` / `playerParams`
  are undocumented and there is no evidence they matter). The phone app
  gets shorter ads because it is a different client, not because of
  anything the remote sends.
* **Possible follow-up:** iSponsorBlockTV has an open PR that sends
  `stopVideo` 0.1 s before the natural end of a video to avoid post-roll
  ads; with our own queue that could become "jump to the next queued video
  just before the end". Not implemented.

## Debugging: where the Xbox's "logs" actually are

Nothing of ours runs on the Xbox and Google's YouTube app exposes no logs, so
there is nothing to pull off the console. There is also no need to: every
change on the Xbox (play/pause, position, ad started, skip available, queue
changed, disconnect reason) is relayed by YouTube to the phone as a Lounge
event. The phone therefore holds the complete record. **TV tab → Debug log**
keeps the last 800 entries, persisted across restarts and crashes:

* every event from the TV with its payload (`event nowPlaying #42 {...}`)
* every command sent, how long it took, and the channel counters (`cmd addVideo ok (210 ms, rid 7, ofs 5)`)
* every API/server error with the server's code and detail
* what the app decided and why (`app taking over the TV queue …`, `app TV reports an empty queue …`)
* app foreground/background transitions, connection status changes

**Copy log** puts the whole thing (plus a snapshot of player state, local queue,
TV queue, token expiry) on the clipboard for pasting into the chat; **Share /
save** hands it to any app as a text file. Lounge tokens, session ids and
cookies are redacted before storage. Server-side failures are also in Cloud Run
→ Logs (anything the server could not map to a known error code is logged
with its stack).

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
   public/debug.js
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

### Required Cloud Run settings (the server holds the TV connection)

The connection to the Xbox and the whole ad engine (auto-skip, dodge, mute,
SponsorBlock) run **on the server**, not the phone, because Android freezes a
web app's timers when the screen is off or another app is in front. The
phone just attaches to the server's TV session to show state and send
buttons. That needs:

* **Maximum number of instances = 1.** The TV session lives in that
  instance's memory; a second instance would not know about it.
* **Request timeout = 600 s or more.** While you watch, the server keeps one
  request open to itself (`/api/remote/hold`, renewed every 9 minutes) so
  Cloud Run keeps its CPU running with ordinary request-based billing.
* **Minimum instances = 0 is fine.** Press **Done — shut down** (Now
  Playing screen, or the TV tab) when you finish: the session closes at once,
  the keep-alive stops, and Cloud Run scales to zero. If you forget, the
  session closes itself 15 minutes after the TV goes idle with no phone
  contact. Play now reconnects automatically next time.

Cloud Run → Logs shows every `[session …]` line (ad start, dodge armed,
dodge, return seek, keep-alive), and the same lines appear in the phone's
debug log as `server` entries.

How to tell the settings are right, from the phone's debug log:

* `attached to the server's TV session on server instance abc123 (up N s)`:
  the instance id should stay the same for a whole evening. A line
  `server instance changed … the TV session was lost with it` means Cloud
  Run restarted the service or ran more than one instance (max instances
  must be 1).
* `keep-alive cut off after ~300 s`: the request timeout is still the
  default; set it to 600. (The keep-alive is 240 s long so it works either
  way, but a cut keep-alive is a sign the setting was missed.)
* `https://<your-service>/api/ping` shows the instance id, how long it has
  been up, and how many TV sessions it holds.

If Home answers "Google is rate-limiting this account/server (HTTP 403
Sorry…)", wait 15–30 minutes; the server also pauses its own cookie refresh
for 30 minutes after YouTube answers 429 to it.

### Where the cookies live: on the phone

The phone keeps the cookies (browser storage) and sends them with each
request; every response hands back the latest rotated copy, which the phone
saves. So the server holds nothing between requests and **minimum instances
can be 0** (it shuts down when idle; the first press after a pause takes a
cold start of a second or two). `YT_COOKIES` on the server is only a seed: a
phone with no cookies adopts it on its first request and keeps it from then
on. Security note: while `YT_COOKIES` is set, anyone who opens your URL is
handed that cookie, so remove the variable once the phone has adopted it.

### Cookies stay alive by themselves

The server records when it last refreshed the session in a marker it hands
back to the phone, so a Cloud Run cold start does not refresh again on its
first request. Needless refreshes were what tripped Google's rate limiter;
with this the session should last like a normal browser login and a cookie
re-export becomes rare.

YouTube rotates part of the login every few minutes. The server keeps a
browser-like cookie jar: it saves every cookie YouTube sends back and calls
the same rotation endpoint an open YouTube tab does (every 9 minutes, and
once more before giving up on a 401). The phone stores every
refreshed copy, so nothing is lost when the instance shuts down. `GET /api/cookies/status` shows the jar's state; Cloud Run logs show
every `[cookies]` update and rotation.

### Speed

Every button press is phone → Cloud Run → YouTube → Xbox. YouTube's part is
about 150 ms. A cold Cloud Run instance adds seconds, so set **Minimum number
of instances = 1** on the service (Edit & deploy new revision → Revision
scaling), and pick the region closest to you. Billing stays request-based, so
an idle instance costs very little. The debug log prints each command's round
trip (`cmd seekTo ok (180 ms …)`); a number in the seconds there means the
instance, not the app.

## First use on the phone

1. **TV tab** → on the Xbox open YouTube → Settings → *Link with TV code* →
   type the 12 digits → **Link TV**. The code is only needed once; the token
   refreshes itself (YouTube issues ~13-day tokens).
2. **TV tab → Your YouTube account**. From the phone alone: install Firefox
   for Android, add the Cookie-Editor extension, sign in on youtube.com in
   Firefox, Cookie-Editor → Export (copies to the clipboard), then in MyTube
   **Paste from clipboard** → **Save & test**, and close the YouTube tab in
   Firefox. JSON, cookies.txt and header formats are all accepted.
   Desktop alternative:
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
| `GET /api/watch?id=` / `?continuation=` | Title, channel, full description + resolved links, chapters, related list, comments continuation |
| `GET /api/comments?continuation=` | One page of comments, or of a thread's replies (`repliesContinuation`) |
| `GET /api/library/history[?continuation=]` | Watch history (cookies) |
| `GET /api/library/playlists[?continuation=]` | Your playlists (cookies) |
| `GET /api/playlist?id=WL\|LL\|PL…` / `?continuation=` | A playlist's videos; `WL` = Watch Later, `LL` = Liked videos |
| `POST /api/rate {videoId, rating: like\|dislike\|none}` | Like / dislike / clear (TV client, as youtubei.js does) |
| `GET /api/save-options?videoId=` | Your playlists with "already contains this video" flags |
| `POST /api/playlist/edit {playlistId, videoId, action: add\|remove}` | Add to / remove from a playlist |
| `POST /api/playlist/create {title, videoId?}` | New private playlist |
| `GET /api/channel?id=&tab=videos\|playlists\|search[&q=]` / `?continuation=` | Channel header, videos with sort options, playlists, search |
| `GET /api/sponsorblock?id=` | SponsorBlock segments for a video (hashed-prefix lookup) |
| `POST /api/lounge/pair {code}` | TV code → `screenId` + `loungeToken` |
| `POST /api/lounge/refresh {screenId}` | New lounge token |
| `POST /api/lounge/availability {loungeToken}` | Is the TV online |
| `POST /api/lounge/connect {loungeToken,deviceId,name,rid}` | Open channel → `sid`, `gsessionid`, `aid`, initial events |
| `GET /api/lounge/events?…` | NDJSON stream of TV events (long-poll) |
| `POST /api/lounge/command {session, commands:[{name,params}]}` | Send commands |
| `POST /api/lounge/disconnect {…session}` | Leave |

Errors are always `{"error":{"code","message","detail"}}` with a real HTTP
status. Codes the app reacts to: `TOKEN_EXPIRED` (refresh + reconnect),
`SESSION_LOST` (reconnect), `SCREEN_GONE` (pair again), `SIGN_IN_REQUIRED`
(no cookies), `COOKIES_INVALID` / `COOKIES_REJECTED`, `PLAYLIST_EDIT_FAILED`,
`UPSTREAM_SHAPE_CHANGED` (YouTube changed a JSON layout; the message names the
path that went missing).

Untested against a signed-in account at the time of writing (no cookies were
available in the build environment): history, your playlists page, Watch
Later, rating, the Save dialog, playlist edit/create. Public playlists, like
status/count parsing and everything else were verified live. If one of these
fails, the debug log carries the server's error code and the JSON path.

## Prior art

Nobody ships a maintained phone app for this. The protocol knowledge comes from
[pyytlounge](https://github.com/FabioGNR/pyytlounge) (Python, Oct 2026),
[@iobroker/youtube-lounge](https://github.com/ioBroker/youtube-lounge) (Node,
Oct 2026), [ytlounge](https://github.com/desvaters/ytlounge) and
[ytcast](https://github.com/MarcoLucidi01/ytcast); the Xbox quirks from the
Home Assistant integration
[ha-youtube-on-tv](https://github.com/jorgediez/ha-youtube-on-tv). InnerTube
parsing follows what yt-dlp, NewPipe Extractor and youtubei.js do today
(including the 2025–2026 `lockupViewModel` migration). Ad handling follows
[iSponsorBlockTV](https://github.com/dmunozv04/iSponsorBlockTV) (its
`ytlounge.py`, issues #276, #295, #365, #411, #458, #489 and the
`close-ads-5s` branch) and the Samsung observations in ha-youtube-on-tv.

## Caveats

* Both APIs are private. Google changes them; when a JSON shape moves the
  server fails loudly with `UPSTREAM_SHAPE_CHANGED` and the path, so it is a
  quick fix in `lib/innertube.js`.
* Cookie use is against YouTube's ToS in spirit; yt-dlp's wiki suggests a
  throwaway account if you are worried.
* The event stream keeps a Cloud Run instance busy while the app is in the
  foreground. For one person this is well inside the free tier.
