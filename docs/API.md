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
| `api` | 127.0.0.1:3001 | soundboard (search/clip/uploads/guest), GIFs, YouTube (`/youtube/*`), Memories files (`/vods/*`), moderation, presence, push (`/push/*`), game servers, the box's extras (`/health`, `/speedtest/up`, `/reports`, `/logs/upload`) |
| `api` (push gateway) | `<backend gateway>`:3091 | `POST /_matrix/push/v1/notify` for Synapse only (its `ip_range_whitelist` names that one address) |
| `games` | 127.0.0.1:3003 | the games catalogue (search, cover art, custom entries, Steam library import) |

Caddy maps `/api/*` to them in every mode (`templates.CADDY_API`): `/api/games/*` → :3003; `/api/soundboard/*` →
the root; `/api/guest/*` → `/guest/*`; `/api/gifs/*` → `/gif/*`; `/api/watch/*` → `/youtube/*`; everything else under
`/api/*` as is. `/api/admin/*` (invite codes) stays with the manager. The guest room's door page is served at `/call/`
(`api/guest/index.html`, copied into the web folder by `build.sh`).

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
{"server": "0.2.21", "api": "https://<name>/api",
 "features": {"calls": true, "soundboard": true, "gifs": false, "watch": true, "games": true, "steam": false,
              "gameservers": false, "presence": true, "push": true, "memories": false, "reports": true},
 "recorder": "@recorder:example.org",
 "account": {"password_reset": "owner"}}
```
`gifs` = a Giphy key is set; `watch` = a YouTube key (YouTube search in Watch/Media Party; pasted links need no key);
`steam` = a Steam key (importing someone's library; the catalogue's search is keyless); `gameservers` = the panel is
configured; `memories` = the owner switched it on and named the recorder's account (`recorder`, only then). The apps
hide a feature only on an explicit `false`; no document = everything on, as before.

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
well-known. The Reports card lists what people sent with "Report a problem" / "Share logs" (downloads).

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
