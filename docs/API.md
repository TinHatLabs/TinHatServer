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
| `api` (push gateway) | `<backend gateway>`:3091 | `POST /_matrix/push/v1/notify` and `POST /_tinhat/v1/call-member` (ringing, below) for Synapse only (its `ip_range_whitelist` names that one address) |
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
| `public/` | what Synapse's modules read (mounted read-only into Synapse): the guest lists, the Guests room, `call-hook.json` (where to poke the API about calls). Nothing secret |

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
2. MSC4195 requests (`{room_id, slot_id, openid_token, member: {id, claimed_user_id, claimed_device_id}}` plus
   Element Call's optional `delay_id` / `delay_timeout` / `delay_cs_api_url`, on lk-jwt's `/get_token` or its
   `/sfu/get`; **Element Call's newer method**: what it uses to subscribe to another server's call server, and what
   older Element Call / Element X use for every join) are **served since 0.3.8**, as the `/sfu/get` request for the
   same call: only the room's own slot `m.call#ROOM` (another slot: `403 {"reason":"unsupported"}`), `claimed_user_id`
   must be the verified caller (else `401`, lk-jwt's own rule), then the same room check, and lk-jwt is asked
   `{room: room_id, openid_token, device_id: claimed_device_id}` on `/sfu/get`. The token is for the LiveKit room the
   call really runs in (the room id, which call moderation governs) with the identity `<caller>:<device>`; Element Call
   reads both from the token it gets back. Not lk-jwt 0.4.0's own `/get_token`: it would mint for
   `sha256(room_id|slot_id)` (a room nobody publishing through `/sfu/get` is in) with `member.id`, a client-chosen
   identity. Delayed-leave delegation isn't supported by lk-jwt 0.4.0: those fields are read and dropped. (Element
   Call prefers a hashed identity for subscribers; here a subscriber shows as `<user>:<device>` on this call server,
   which is who it is.) 0.3.7 refused all of them (`403 unsupported`). Proven with the request exactly as Element
   Call's source of 2026-10-28 sends it and LiveKit accepting the token (lab); a real Element X / Element Call client
   end to end (media, E2EE, several devices) is still to be tried. As with `/sfu/get`, the device id isn't proven by
   the sign-in (two sessions of one account claiming one device collide), and lk-jwt's tokens let the holder publish.
3. Who asks: a sign-in from this server is resolved by Synapse itself (its OpenID userinfo on the internal address),
   cached ≤ 60 s; a refused one is `401`. **A sign-in from another server is resolved by the API too (0.3.8,
   `fedresolve.mjs`)**: the Matrix spec's server discovery (an IP literal or explicit port as is; else
   `https://<name>/.well-known/matrix/server`, up to 3 redirects, each checked; then SRV `_matrix-fed._tcp` /
   `_matrix._tcp`; else port 8448), with the soundboard's SSRF guards (`foreign.mjs`: every address public, every DNS
   answer of a name public, the address pinned, TLS checked against the spec's name, 16 KB caps, one 10 s deadline;
   discovery cached 10 min), then that server's `/_matrix/federation/v1/openid/userinfo`. The answer must be a user of
   **that** server; anything else is `401`. A server name that leads to a private address: `403 {"reason":
   "remote-refused"}`; one that can't be reached: `502 {"reason": "check-failed"}`. So lk-jwt is asked only for a
   caller already verified as a joined member and never signs a token for a non-member (0.3.7 let it sign one and
   threw it away). The token lk-jwt mints is still handed out only when its identity (`<mxid>:<device>`) is the
   caller that was checked. Residual: lk-jwt then looks the same sign-in up itself, with its own resolver and no
   address checks, so a hostile server that IS a joined member could answer lk-jwt from somewhere else (DNS
   rebinding). Closing that means minting remote callers' tokens in the API (it holds the call server's secret) instead
   of asking lk-jwt; not done in 0.3.8.
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
server it names (since 0.3.8 only after the API itself resolved that sign-in to a joined member of the room), and its error log can carry
that lookup's URL, which includes the caller's OpenID token in its query. That token is short-lived (up to an hour) and
only answers "which account is this" (OpenID userinfo); lk-jwt's log is readable by the box's root only. The Tin Hat
API's own log never carries a token.

**The owner's switch:** `tinhat api-limits CALL_TOKEN_ROOM_CHECK=off` hands every request to lk-jwt unchanged, as
before 0.3.7 (the route still goes through the API); `tinhat api-limits --reset CALL_TOKEN_ROOM_CHECK` turns the check
back on (the default).

**Compatibility.** Apps need no change: a normal call (alias = the room's id, the caller joined) and a guest in the
Guests room get their token exactly as before, and so does a second device of the same person (a share companion, the
phone). What changes: a membership that points joiners at a room they aren't in, or at a name that isn't a room, no
longer gets them a token; both show the app's usual "couldn't join the call" error. (An MSC4195 request,
Element Call's newer method, was refused in 0.3.7 and is served from 0.3.8: step 2.) Developer tools that mint tokens for made-up room names (the desktop's `TINHAT_E2EE_LOOPBACK` / `TINHAT_AUDPUB` style tests) need the switch off on a test
server. A hostile alias naming another room the joiner *is* in still lands them in that room's call, which that room's
own moderation governs; the 12.1.0 apps refuse an alias that isn't the call's own room (calls round DESIGN §2.3).

## Ringing: DM calls ring on phones and closed browsers (0.3.8, server half of RINGING.md draft 3)

Nobody sends ring events. A call membership (`org.matrix.msc3401.call.member`) is plaintext room state, so the server
sees a call start in a DM and pushes a ring to the callee's devices, encrypted per device like every push (relay for
phones). Calls from any client ring (old Tin Hat apps, Element X), because the server watches membership, not the app.

**How it sees calls.** Synapse's `tinhat_calls` module (`manager/synapse/tinhat_calls.py`, loaded next to
`tinhat_rules`) pokes `POST /_tinhat/v1/call-member {room_id, event_id}` on the push gateway's listener for every new
`org.matrix.msc3401.call.member` state event (the type the apps ring on; local or over federation), fire and forget:
one poke per room in flight (a change meanwhile = one more after it), at most 8 in flight in all. The poke carries nothing
the API trusts: it reads the room's state through the admin API (`/_synapse/admin/v1/rooms/<room>/state`) and decides
from that. Rooms with more than 500 joined members are never read. Pokes for one room are serialised (a burst = at most
two reads). The module also serves `GET /_synapse/tinhat/v1/push_muted?user_id=&room_id=[&caller=]` to server admins only (the
API's system account), outside `/_matrix` and `/_synapse/client`, so the box's web server never forwards it.

**Who may ring whom** (where the draft left room, the safer reading):
- **DMs only:** exactly 2 joined members at that moment (push.mjs's DM rule). Group calls never ring (the draft's
  optional `call` alert for groups is not built: RINGING.md §8.4, the PM's call).
- **Members only:** a membership counts only while its sender is joined, is live (`created_ts` + `expires`, 4 h by
  default) and sits under the sender's own state key (the apps' `sessionsFrom` rules). No guests on either side.
- **Local callees only**, and only to registrations whose **Synapse pusher still exists** (a signed-out device's
  registration never rings; `/_synapse/admin/v1/users/<user>/pushers`, read fresh before every ring and every stop).
- **Not muted:** the callee's own push rules, the apps' rule (an enabled override rule for the room without `notify`;
  "Mentions only" still rings). If that can't be read (module missing, Synapse busy) nobody is rung: a VoIP push can't
  be taken back.
- **Not ignored:** a caller the callee ignores (`m.ignored_user_list`) never rings them (Synapse sends no push for an
  ignored user's events either). The module answers `ignored` on `push_muted?…&caller=`; a module without that answer
  (older) counts as "not ignored".
- **The rising edge only:** the first live membership of someone else, at most **20 s** old (checked again right
  before sending, so a server restart mid-call or a slow lookup rings nobody), the callee not in the call on any
  device, no ring for that DM to that callee in the last **45 s** (the apps' DM gap), at most **6 rings a minute** per
  callee. The caller = the earliest such member. What was seen is kept only while those memberships are live, so a
  caller whose app died (membership expired without an event) rings again with their next call.
- **Busy:** the callee has a live membership in another room this server has seen → the ring says `busy: true`. For a
  VoIP ring (which can't be quiet) the server also asks Synapse when it saw nothing: the callee's joined rooms (at
  most 30 others; a bigger list, a big room or a failed read = can't tell) → busy, or can't tell = an ordinary alert
  ring (`busy: false`) instead of VoIP.
- **Not built (known limits):** a callee who leaves or is removed from the DM mid-ring gets the stop with the next
  membership change in the room or not at all (devices stop by themselves at 25 s); the Memories recorder isn't
  excluded by name (it is never one of a DM's two members in practice; a recorder in a DM would ring the other).

**Payloads** (v1, Web Push encrypted per device, `Urgency: high`, **TTL 30**; never retried):
```json
{"v": 1, "kind": "ring", "room": "!dm:server", "ring": "$memberEvent", "caller": "@sam:server", "title": "Sam",
 "body": "Incoming call", "ts": 1761400000000, "busy": false, "user": "@r:server"}
{"v": 1, "kind": "ring_stop", "room": "!dm:server", "ring": "$memberEvent", "why": "answered|ended|declined",
 "title": "Sam", "user": "@r:server"}
```
`ring` = the event id of the caller's `call.member` state event (apps can dedup in-app rings by it). `title` = the
caller's display name in the room (else the localpart). `ts` = when the server sent it (devices drop a ring older than
20 s on arrival). `ring` and `ring_stop` share the **Topic**: a keyed HMAC over (subscription, room, ring), so the
relay's collapse id is the same and the stop replaces the ring.

**When it stops:** answered (the callee's membership appears, any device), ended (nobody else is in the call any more;
also when the callee left the room), declined (`/push/ring/decline`). Each ring stops once, and only within **60 s**;
a timeout (25 s) sends nothing: devices end by themselves. Stops go only to registrations that asked for them and are
still that person's (registration unchanged, pusher still there), never over VoIP, and never before the ring's own
push went out (a stop the push service took first would be replaced by the late ring).

**Registrations.** `POST /push/register` takes an optional `rings`:
- `{"v": 1, "stop": true|false}`: this device wants rings (and `ring_stop` when `stop` is true);
- `"voip": "<PUSH_RELAY>/v/<22 chars>"` (iOS PushKit, relay registrations only, one person's): the VoIP subscription,
  **encrypted to the registration's own keys** (`p256dh`/`auth`; the draft didn't say, this is the reading built).
  Only non-busy rings go there, nothing else (no stop, no message, no busy ring); a VoIP-rung device gets no stop.
  A 404/410 from the relay forgets the VoIP half and keeps the registration.
- Another `v` registers without rings (a newer app still registers); a malformed `rings` is `400 {"error":
  "rings_refused", "reason": …}`; a VoIP endpoint another person registered is `409 {"error": "voip_owned"}`.
- The answer carries `rings` (what was taken, `null` = none) only when the request named `rings`;
  `GET /push/register` shows them. Registering again without `rings` clears them.
- **A registration without `rings`** (every app and service worker before this) gets a ring as an ordinary message
  push: `kind: "message"`, `title` the caller, `body` "Incoming call", `event` = the ring id, TTL 30, today's
  "quiet while at a computer" rule, and never a stop.

**Decline:** `POST /push/ring/decline {"room": "!…", "ring": "$…"}` (bearer; 30 a minute per user) → `200 {"ok":
true}` and `ring_stop why: declined` to the callee's other devices; `200 {"ok": true, "already": "answered|ended|
declined"}` when it had stopped already; `404 {"error": "no_ring"}` for no live ring of this user with that id (also
the caller, or after 60 s); `403 {"error": "not_member"}` when the callee left the room; `503` when the room couldn't
be read. The caller learns of a decline from the apps' own encrypted `dev.tinhat.call.decline` room event (client side).

**`GET /push/config`** says `"ring": 1` (this server rings and takes `rings`). Logs: one line per push (`[ring] ring|
ring busy|ring voip|message|ring_stop <why>`, host, status, ms, 6 chars of the pushkey), counts every 10 min; never a
name, room or endpoint. Without the system account's token (`synapse-admin.token`) nothing rings.

**Cost.** Synapse runs the module's callback for every new event (it filters on the event type before anything else;
the poke runs in the background). The API reads a room's state once per call-membership change in it.

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
