# games — the games catalogue (the Game Reel's list of games and cover art)

A small Node service (express only) on `127.0.0.1:3003`, run from the `tinhat/api` image as the `games` compose
service; the web server maps `https://<server>/api/games/*` to it. Data in `$GAMES_DATA_DIR` (`catalog.json` +
`art/`; on a Tin Hat Server `/var/lib/tinhat/api/games`).

- `seed.json` — the house catalogue of games that aren't on Steam (Riot, Blizzard, …). Loaded at start and daily.
  Entries with `steamAppId` merge with Steam imports (one row per game).
- `steamgriddb.key` (optional, in `$API_CONF_DIR`) — portraits for the non-Steam games. Until it exists they render a
  generated placeholder; art fills in on the next seed pass. Free key: https://www.steamgriddb.com/profile/preferences/api
- `steam.key` (optional, in `$API_CONF_DIR`) — a Steam Web API key, used ONLY by `POST /steam/library` (importing
  someone's owned games). Search works without it (Steam's store search needs no key).
- `art-manual/<slug>.jpg|png` (`$GAMES_MANUAL_ART`) — a hand-placed 600×900 portrait beats every source.

On a Tin Hat Server the keys come from the dashboard (Features → Extras and keys); `tinhat logs games` shows its log
and `curl -s 127.0.0.1:3003/health` its state.

## Chat backgrounds ("Match the game", 0.3.17)
- `GET /art/<id>/background` — wide art for the chat background the apps draw behind a room when it is set to "Match
  the game": the Steam library hero (`library_hero.jpg`, 1920×620) or the SteamGridDB hero the catalogue stored. The
  SERVER fetches it once (https only, hosts in `background.mjs` `ART_HOSTS`, redirects checked at every hop, ≤ 4 MB,
  JPEG/PNG/WebP bytes only) and caches it in `art/<id>.background`; a game without art is remembered for 6 h. No art
  or an unknown game → **404** (no portrait stand-in, no placeholder): the app shows the room's fallback preset.
  Operators can place `art-manual/<slug>-background.jpg|png|webp` (wins over every source).
- `POST /resolve {"names": [...]}` (signed in, ≤ 20 names, 30 a minute per person) → `{"ids": {"<name>": "<id>"|null}}`:
  the apps map the game statuses people share ("Valheim", "Playing Valheim") to catalogue ids. A LOCAL catalogue
  lookup only (exact name or alias after `gameKey`): unlike `/search` it never asks Steam, so a status text never
  leaves this server. Names are not logged. Rules shared with both apps: `test/vectors/gamebg/vectors.json`.
