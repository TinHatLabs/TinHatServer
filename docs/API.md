# The Tin Hat API on every server

Tin Hat's extras beyond chat and calls (the soundboard and myinstants, GIFs, YouTube search, guest links, Memories,
call moderation, Reach presence, web push, the game-servers widget, the games catalogue) run on every Tin Hat Server
itself (since 0.2.21), with the owner's own keys. Nothing in the apps or the server points at anyone else's machine:
the only outside party a server talks to is the names service, for `<name>.tinhat.me`.

## What runs
`api/` in this repository is the code (every address and key comes from the environment). One image,
`tinhat/api:<version>` (`api/Dockerfile`: Node 22, python3 for myinstants, ffmpeg for Memories thumbnails), built into
the appliance image by `provision.sh` and shipped with every release like our Caddy image. Two compose services on the
host's network, like the call server:

| service | listens | does |
|---|---|---|
| `api` | 127.0.0.1:3001 | soundboard (search/clip/uploads/guest), GIFs, YouTube (`/youtube/*`), Memories files (`/vods/*`), moderation, presence, push (`/push/*`), game servers, call sign-ins (`/calltoken/*`, in front of lk-jwt), the box's extras (`/health`, `/speedtest/up`, `/reports`, `/logs/upload`) |
| `api` (push gateway) | `<backend gateway>`:3091 | `POST /_matrix/push/v1/notify` for Synapse only (its `ip_range_whitelist` names that one address) |
| `games` | 127.0.0.1:3003 | the games catalogue (search, cover art, custom entries, Steam library import) |

Caddy maps `/api/*` to them in every mode (`templates.CADDY_API`): `/api/games/*` → :3003; `/api/soundboard/*` →
the root; `/api/guest/*` → `/guest/*`; `/api/gifs/*` → `/gif/*`; `/api/watch/*` → `/youtube/*`; everything else under
`/api/*` as is. `/api/admin/*` (invite codes) stays with the manager. Call sign-ins: `/livekit/jwt` and everything
under it go to the API's `/calltoken/…` (only `/livekit/jwt/healthz` goes straight to lk-jwt); see "Call sign-ins".
The guest room's door page is served at `/call/` (`api/guest/index.html`, copied into the web folder by `build.sh`).

## Where its things live: `/var/lib/tinhat/api` (`manager/tinhat/apiconf.py`)
The manager writes everything the services need, from state and secrets, at setup, after every update
(`install.refresh_configs`) and when the owner changes something in the dashboard:

| file | what |
|---|---|
| `env` | the environment (addresses, public bases, folders); `PORT` differs per service |
| `synapse-admin.token`, `synapse.secret`, `livekit.secret` | the box's system account (a Synapse admin), the registration secret (guest accounts), the call server's secret |
| `giphy.key`, `youtube.key`, `steam.key`, `steamgriddb.key` | the owner's own keys from the dashboard (secrets.json is the source of truth; cleared = removed) |
| `gameservers.json`, `pelican.key` | the game-servers widget's panel and servers (below) |
| `cache/`, `uploads/`, `games/`, `watch/`, `reports/`, `logs/` | the clip cache, people's uploaded sounds, the catalogue + art, the YouTube cache, problem reports and shared logs |
| `vapid.json`, `push-owners.json`, `guests.json`, `guest-accounts.json`, `vods.secret` | state the services keep themselves |

Backups carry the API's data (not the caches). Memories recordings are read from `/var/lib/tinhat/vods` (mounted
read-only as `/vods`): a folder the owner's recorder writes to — Tin Hat Server doesn't run a recorder.

## What the apps are told: the well-known
`/.well-known/matrix/client` → `dev.tinhat.server` (its presence also marks a Tin Hat server):
```json
{"server": "0.2.21", "api": "https://<name>/api", "web": "https://<name>",
 "features": {"calls": true, "soundboard": true, "gifs": false, "watch": true, "games": true, "steam": false,
              "gameservers": false, "presence": true, "push": true, "memories": false, "reports": true},
 "recorder": "@recorder:example.org",
 "account": {"password_reset": "owner", "owner": "@owner:example.org"}}
```
`gifs` = a Giphy key is set; `watch` = a YouTube key (YouTube search in Watch/Media Party; pasted links need no key);
`steam` = a Steam key (importing someone's library; the catalogue's search is keyless); `gameservers` = the panel is
configured; `memories` = the owner switched it on and named the recorder's account (`recorder`, only then). The apps
hide a feature only on an explicit `false`; no document = everything on, as before.
`web` (0.3.5) = where this server's web app is: `https://<name>` unless the owner set Features → "Web app address"
(a server on its own domain whose front page is another site, like example.com → chat.example.com). The phone apps
open that when someone types the bare domain (docs/DEEPLINKS.md); older servers leave it out.

`account.owner` (0.3.5) = the server owner's Matrix id, so the apps refuse "Delete my account" for it (the owner
deletes nothing from an app; docs/ACCOUNT-SAFETY.md); left out while no owner is known. Older apps ignore it.

The phone apps' link files, `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`, are served
next to it in every mode (docs/DEEPLINKS.md).

## Who may use the extras (0.3.4, security review 2026-10-26)
The GIF picker (`/api/gifs/*`), Media Party (`/api/watch/*`) and the soundboard's search and clip cache
(`/api/soundboard/search|clip|fetch`) spend the owner's Giphy/YouTube quota and fetch from myinstants and other Tin Hat
servers. They used to need no sign-in at all; now (`api/tinhat-api/access.mjs`):

| caller | gets |
|---|---|
| `Authorization: Bearer <Matrix access token>`, valid | everything; upstream calls count against that person's own budget (below); over it: `429` (Media Party: `503 {"error":"budget","scope":"you"}`) |
| a bearer Synapse rejects | `401 {"error":"bad token"}` — never the token-less lane |
| no bearer (apps released before 0.3.4: desktop 12.0.x, the web app of servers up to 0.3.3) | cached answers as before; every upstream call (a Giphy request, a myinstants search, a new sound, YouTube units) comes out of that caller's own allowance (per address: an IPv4 address or an IPv6 /64) under a larger ceiling for every token-less caller together, so one caller can't drain anyone else's; spent, or `API_LEGACY_ANON=off`: `401 {"error":"Sign in to use this. If you are signed in, update Tin Hat.","signin":true}` |

Clips are played by `<audio>` and GStreamer, which can't send a header. `GET /api/soundboard/clip?url=…` therefore:
- serves a clip already cached to anyone (public bytes, no spend), typed from its bytes (audio only);
- fetches a new one only for a member's bearer, a **signed link** (`GET /api/soundboard/clip/sign?url=…` with the
  bearer → `{"url": "<base>/clip?url=…&p=<payer>&exp=<ms>&sig=…", "exp": <ms>}`, valid an hour; play that URL as is),
  a myinstants clip one of this server's own search answers handed out in the last day, or the token-less allowance;
- charges every real download to someone: the member (a bearer, or the signer of a signed link: `p` is an opaque id
  of theirs inside the signature), the address that played a search result (and everybody's budget for those), or the
  caller's token-less allowance; a request turned away (busy, too many from that address) spends nothing, and two
  requests for the same clip make one download;
- keys the cache on the normalised URL, keeps a clip of at most `SOUNDBOARD_CLIP_MAX_MB` and `SOUNDBOARD_CACHE_MAX_MB`
  in all, least recently played out first.
`/api/gifs/fetch` takes Giphy media hosts only and answers only bytes that are an image or an mp4.

### Sounds from another Tin Hat server
A sound someone uploaded on another Tin Hat server (a friend's) is fetched **through this server**, never by the apps.
The apps send its link like a myinstants one (`/soundboard/clip?url=<link>` with the bearer, or `/soundboard/clip/sign`
for header-less players); the same budgets and charging apply (`api/tinhat-api/foreign.mjs`), but **members only**: a
bearer or a member-signed link, never the token-less lane (no app that sends no token sends such a link). That is
decided before anything else happens, so a request without one never makes this server look a name up.
- Links taken: `https://<name>[:443]/api/soundboard/clip?id=<id>` (that one parameter; id `[A-Za-z0-9_-]`) and
  `https://<name>[:443]/api/soundboard/file/<file>` (file `[A-Za-z0-9._-]`, no query). Refused: http, another port,
  userinfo, a fragment, `%2e` / `%2f` / `%5c` anywhere (any case), backslashes, an address instead of a name, and this
  server's own names (the apps play those directly).
- The fetch: only once the request is admitted, de-duplicated and charged, the name is resolved (A and AAAA, by the
  API's own resolver: 3 s per try, 2 tries, cancelled at the deadline) and EVERY address it has must be public (IPv4:
  no loopback, private, link-local, CGNAT, multicast, unspecified, documentation, benchmark or reserved ranges; IPv6:
  only blocks IANA has allocated in its Global Unicast Address Assignments table, last updated 2025-10-10, minus
  documentation space, so no 6to4, Teredo, ULA, link-local, IPv4-mapped/compatible or reserved space; NAT64 only of a
  public IPv4 address; never an address with a zone). The connection goes to exactly the address that was checked, with
  SNI and Host = the name (no DNS rebinding); no redirects at all; lookup and transfer share one 20 s deadline; an
  answer refused for its status, size or time is torn down at once (never read to its end); the same cap, audio sniff
  and helper slots as myinstants.
- What an app gets back:

| answer | when |
|---|---|
| `200` audio (`Content-Type` from its bytes) | cached, or fetched now |
| `401 {"error":"bad token"}` / `401 {"error":"Sign in to use this…","signin":true}` | a token Synapse rejects / no token and no valid member-signed link |
| `403 {"error":"…","reason":"not-allowed"}` | not a myinstants or Tin Hat sound link (any refused shape above) |
| `403 {"error":"That's this server's own sound: play it directly","reason":"own-server"}` | a link on this server's own name |
| `403 {"error":"<name> isn't a public server","reason":"not-public"}` | the name resolves to a non-public address |
| `413 {"error":"That sound is bigger than this server keeps (5 MB)."}` | over `SOUNDBOARD_CLIP_MAX_MB` |
| `415 {"error":"not audio (the other server said …)"}` | the bytes aren't audio |
| `502 {"error":"…"}` | the name doesn't resolve in time, the other server can't be reached or answer in time, redirects, or answers another status (a 404 is remembered for an hour: then `404`) |
| `429` / `503` (with `Retry-After`) | too many from this address / every helper busy |

A server before 0.3.4 answers such a link `403 {"error":"Only myinstants.com URLs allowed"}`: the apps show that the
sound couldn't be loaded.

What the apps do from 12.0.3: send the bearer on `/gifs/`, `/watch/` and `/soundboard/search` (as they already do for
`/soundboard/upload*`, `/vods/`, `/games/`, `/moderation/`); before playing a myinstants or foreign sound through a
player that can't send a header, ask `/soundboard/clip/sign` (or fetch the clip with the bearer and play the bytes).

The numbers: whole numbers (digits only: no sign, decimals or exponent) inside the range below, so the API only ever
sees a bounded safe integer; anything else is refused by the console, and an API that finds one in its environment
keeps its default. **0 means none:** nobody in that group gets any of it (token-less callers the `401` sign-in answer,
members the `429` "a lot for one hour" answer, `503 {"error":"budget"}` for YouTube units; uploads refused); the
token-less lane itself is switched off with `API_LEGACY_ANON=off`. Set them with **`tinhat api-limits NAME=VALUE …`** on the server's console
(`tinhat api-limits` lists them and what is set; `--reset NAME …` / `--reset-all` go back to these defaults): they are
kept in the server's state and written into the `api` service's environment, which the server regenerates itself, so
an edit of `/var/lib/tinhat/api/env` doesn't last.

| variable | default | what |
|---|---|---|
| `API_LEGACY_ANON` | `on` | `off` = no token-less lane at all (once every member runs 12.0.3 or later) |
| `CALL_TOKEN_ROOM_CHECK` | `on` | `off` = call tokens without the room check, as before 0.3.7 ("Call sign-ins" below) |
| (every count below, from `API_ANON_…` to `SOUNDBOARD_USER_UPLOADS_MAX`) | | 0 to 999 999 999; 0 = none |
| `API_ANON_GIF_PER_HOUR` / `API_ANON_GIF_ALL_PER_HOUR` | 60 / 300 | Giphy calls for token-less callers: per address / all together |
| `API_ANON_SOUNDSEARCH_PER_HOUR` / `API_ANON_SOUNDSEARCH_ALL_PER_HOUR` | 60 / 600 | myinstants searches, the same |
| `API_ANON_CLIPFETCH_PER_HOUR` / `API_ANON_CLIPFETCH_ALL_PER_HOUR` | 120 / 1200 | new myinstants sounds, the same (another Tin Hat server's: members only) |
| `API_USER_GIF_PER_HOUR` / `API_USER_SOUNDSEARCH_PER_HOUR` / `API_USER_CLIPFETCH_PER_HOUR` / `API_USER_CLIPSIGN_PER_HOUR` | 240 / 240 / 240 / 1200 | per person (new sounds: whether fetched with the bearer or through their signed links) |
| `API_SEARCHED_CLIPFETCH_PER_IP_HOUR` / `API_SEARCHED_CLIPFETCH_PER_HOUR` | 60 / 600 | new clips a search answer handed out, played without a token: per address / everybody together |
| `WATCH_USER_UNITS_PER_DAY` | 9000 | YouTube Data API units per Pacific day per person (Google's daily quota is 10 000; a search is 100) |
| `WATCH_ANON_UNITS_PER_DAY` / `WATCH_ANON_ALL_UNITS_PER_DAY` | 1000 / 4000 | the same for token-less callers: per address / all together |
| `SOUNDBOARD_CLIP_MAX_MB` / `SOUNDBOARD_CACHE_MAX_MB` / `SOUNDBOARD_CLIP_LINK_MIN` | 5 / 512 / 60 | one clip (1–100) / the whole cache (1–1 048 576) / how long a signed link works (1–10 080 minutes, a week) |
| `SOUNDBOARD_USER_UPLOADS_MAX` / `SOUNDBOARD_USER_UPLOADS_MB` / `SOUNDBOARD_UPLOADS_TOTAL_MB` | 200 / 100 / 2048 | people's own sounds: per person (count, size), everybody together (sizes 0–1 048 576; 0 = no uploads) |
| `GIF_FETCH_MAX_MB` | 8 | `/api/gifs/fetch` (1–100) |

Per-address limits (every route) count an IPv4 address or an IPv6 /64.

## Call sign-ins: a token only for a room you are in (0.3.7, security review 2026-10-26, calls round M1b)

A call's membership event names the call server (`livekit_service_url`) and the LiveKit room (`livekit_alias`), and
every app joins the room the membership names. lk-jwt-service (0.4.0) checks *who* asks for a token (the Matrix OpenID
token) but not that they are in the Matrix room the LiveKit room belongs to, while Tin Hat's call moderation takes the
LiveKit room to be the Matrix room id. So a room member could post a membership whose alias is another room's id or any
string, and joiners landed in a LiveKit room the call's own room doesn't govern. The server now checks it, which
protects every app version (12.0.x included) without a change to them.

**Route.** Caddy sends `/livekit/jwt` (older Element Call posts there), `/livekit/jwt/sfu/get` and everything else under
`/livekit/jwt/` to the API (`api/tinhat-api/calltoken.mjs`, `/calltoken/sfu/get` and `/calltoken/get_token`; other
paths 404); only `/livekit/jwt/healthz` ("Is it just me?") goes to lk-jwt directly. Every mode, a former name's site
included. Behind your own reverse proxy nothing changes for you: keep forwarding `/livekit/jwt` to the box.

**The check** (lk-jwt's `/sfu/get` request `{room, openid_token, device_id}`, the one every Tin Hat app sends):
1. The body is read the way lk-jwt reads it (exact field names, no unknown ones; ≤ 16 KB) and lk-jwt receives our own
   re-encoding of exactly what was checked, never the caller's bytes. Malformed, or a `device_id` containing `:` (the
   LiveKit identity `<mxid>:<device_id>` would be ambiguous): `400 {"errcode":"M_BAD_JSON",…}`.
2. MSC4195 requests (`{room_id, slot_id, openid_token, member}`, lk-jwt's `/get_token` and also accepted by its
   `/sfu/get`) are refused: `403 {"error":"this server's calls use /sfu/get","reason":"unsupported"}`. lk-jwt mints
   those for a hashed room name that call moderation can't govern, with a participant id the client chooses. No Tin Hat
   app sends them.
3. Who asks: a sign-in from this server is resolved by Synapse itself (its OpenID userinfo on the internal address),
   cached ≤ 60 s; a refused one is `401`. A sign-in from another server is never looked up by the API (no request to a
   member-named host): the room must already have a joined member from that server before lk-jwt is asked, and the
   token lk-jwt then mints is handed out only when its identity (`<mxid>:<device>`) is a joined member; otherwise it is
   thrown away and the answer is `403`.
4. The room: a Matrix room id (`!…:server`, room v12 ids too) in which the caller is **joined** as this server sees it
   (Synapse's admin member list; a federated member counts when this server sees their join). Otherwise
   `403 {"errcode":"M_FORBIDDEN","error":"not in that room","reason":"not-member"}`, and lk-jwt is not asked at all.
   The member list is read fresh for every token that is handed out (someone who left or was removed is refused at
   once), and someone who has just joined gets in at once (no list is cached; concurrent reads share one request).
5. One exception: the apps' connection test (Settings → Calls) uses a scratch room `tinhat-conntest-<own localpart>-<n>`
   that isn't a Matrix room; a caller from this server gets that one for their own name as the apps write it (letters,
   digits, `_` and `-` of the localpart, so `@a.b` and `@ab` share one scratch name: a speed-test room, nothing private).
6. Fails closed: when Synapse can't be asked, `502 {"reason":"check-failed"}`, never a pass-through. When lk-jwt
   doesn't answer, `502`.
7. Limits: 120 token requests a minute per caller address (an IPv4 address or an IPv6 /64); 120 sign-in lookups a minute
   per address and 600 for everyone together, counting new sign-ins from this server and every sign-in from another
   server (lk-jwt looks those up) (`429`, `Retry-After`). CORS answers as lk-jwt's do. On a warm cache the check adds a
   few milliseconds (lab: 8.4 ms vs 3.7 ms median through the proxy, mostly the fresh member-list read).

What it doesn't change (lk-jwt's own behaviour, as before): lk-jwt still looks up another server's sign-in at the
server it names (now only for servers that have a joined member in the room asked for), and its error log can carry
that lookup's URL, which includes the caller's OpenID token in its query. That token is short-lived (up to an hour) and
only answers "which account is this" (OpenID userinfo); lk-jwt's log is readable by the box's root only. The Tin Hat
API's own log never carries a token.

**The owner's switch:** `tinhat api-limits CALL_TOKEN_ROOM_CHECK=off` hands every request to lk-jwt unchanged, as
before 0.3.7 (the route still goes through the API); `tinhat api-limits --reset CALL_TOKEN_ROOM_CHECK` turns the check
back on (the default).

**Compatibility.** Apps need no change: a normal call (alias = the room's id, the caller joined) and a guest in the
Guests room get their token exactly as before, and so does a second device of the same person (a share companion, the
phone). What changes: a membership that points joiners at a room they aren't in, or at a name that isn't a room, no
longer gets them a token; neither does an MSC4195 request (other Matrix apps' newer Element Call); both show the
app's usual "couldn't join the call" error. Developer tools that mint tokens for made-up room names (the desktop's `TINHAT_E2EE_LOOPBACK` / `TINHAT_AUDPUB` style tests) need the switch off on a test
server. A hostile alias naming another room the joiner *is* in still lands them in that room's call, which that room's
own moderation governs; the 12.1.0 apps refuse an alias that isn't the call's own room (calls round DESIGN §2.3).

## Forgotten passwords (0.3.0)
A Tin Hat server sends no email, so `account.password_reset` is `"owner"`: the apps' "Forgot your password?" doesn't
offer the email form there, it says to ask the person who runs the server (any other value, or none, keeps the email
form for other Matrix servers). The owner: **Dashboard → People → New password** next to the person
(`POST /admin/api/people/password {"mxid", "signOutEverywhere"}`): the server makes a password (4 × 4 letters and
digits without look-alikes, about 79 bits), shows it once, never logs or keeps it; the person's devices stay signed in
unless the owner ticks "Also sign them out on every device" (a signed-out device that held the only copy of their
message keys can't read old messages without their Security Key). Not for the owner's own account (the app is the place
for that), the server's own account, removed accounts or another server's. Then the person signs in with it and picks
their own in **Settings → Devices & security → Change password** (both apps; the standard `/account/password` with the
current password, other devices stay signed in).

## The dashboard: Features → "Extras and keys"
Paste the keys (all free: Giphy at developers.giphy.com, a YouTube Data API v3 key in Google Cloud, a Steam Web API key
at steamcommunity.com/dev/apikey, SteamGridDB at steamgriddb.com/profile/preferences/api), switch Memories on with the
recorder's account, name a TURN server for callers whose network blocks UDP (host, port, udp/tcp/tls, user, credential
→ LiveKit's `turn_servers`). Saving rewrites the files and restarts `api` + `games` (TURN: the call server), and the
well-known. The Reports card lists what people sent with "Report a problem" / "Share logs" (downloads)
and, labelled "Abuse report", what they sent with "Report…" on a person or a message (`kind: "abuse"`, its own 50 a
day, outside the 200 MB cap, all of them together at most 20 MB) plus the reports Synapse holds (guests and other Matrix apps; docs/ACCOUNT-SAFETY.md).

## The game-servers widget
For a Pelican or Pterodactyl panel the owner runs: **Dashboard → Overview → Game servers → Set up**. The card asks for
the panel's address (as this server reaches it) and a client API key, asks the panel which servers that key sees
(`/api/client`, and a websocket ticket for where Wings is), and the owner ticks the servers to show, picks each one's
game (Valheim, Project Zomboid, Minecraft, Palworld, Abiotic Factor, Satisfactory — the join password and the player
list come from the panel for those that have them — or "Another game"), the address players type and the space whose
members see the widget. It writes `/var/lib/tinhat/api/gameservers.json` + `pelican.key` (0600; the api re-reads
them within 5 s) and the well-known's `features.gameservers`; Remove deletes both. Settings the card doesn't show
(`cap`, `memoryBudgetMB`, `hostCores`, `test`, a server's `steamAppId`/`emoji`/`label`/`calendar`) stay as a
hand-written file had them. The key: best a panel user of its own with access to just those servers (Control:
console, start, stop, restart; Startup: read) and a key allowed only from this server's address. Who may start and
stop them is the space's "Manage game servers" role permission (no roles: power level 100). The file format is
`docs/GAMESERVERS.md` in both app repositories; `tinhat logs api` shows what the module says.

## For developers
- `cd api/tinhat-api && npm ci && node --test test/*.test.mjs watch.test.mjs`. The service refuses to start without
  its environment (`required()` in `server.mjs`).
