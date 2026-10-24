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
