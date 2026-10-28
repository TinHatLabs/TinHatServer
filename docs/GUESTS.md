# The guest room — contract (server + both apps)

**One optional Guests room per server**. A manager turns it on (and off) in one click; it has **one link** that can be renewed at any time (the old
one stops at once); someone with the link opens it in a browser, types a name and **waits at the door** until a
member lets them in — from the web app or the desktop app. Then they are in the Guests room (and its call) for about
12 hours (the API's reaper checks every 10 minutes), with a temporary account that is deactivated afterwards (what they
wrote stays in the room). Turning the room off closes the door, turns away whoever waits and removes the guests who are
in — from the room and from its call (the call server is told, so an open call connection ends too). Turning it on
again makes a new link (an old link never comes back).

**Enforced by Synapse itself** (`manager/synapse/tinhat_rules.py`): every `@guest-…` account is a guest (only the API
can register those names); a guest may join, or be invited to, only the room the API made its account for (the API
publishes `[{user, room}]` in `public/guest-accounts.json`), and only when that room is the Guests room
(`public/guests-room.json`); a guest creates no rooms (no DMs) and invites nobody. With either list missing or unreadable
a guest can join nothing (fail closed). Guests can't upload soundboard sounds (they would outlive the account), send
reports or share logs.

The guest room is the only way a guest gets an account: there are no per-room guest links.

## Words (the apps use exactly these)
- **Guest room** (the feature), **Guests** (the room's name), **guest link**, **waiting at the door** / "is waiting".
- Buttons: **Turn on the guest room** · **Turn off** · **Copy guest link** · **New link** · **Let in** · **Turn away**.

## Who may do what
| | who |
|---|---|
| see the guest room's state, copy the link, let in / turn away | any member of the Guests room who isn't a guest |
| turn on / off, new link | a server admin (Synapse admin) or power level ≥ 50 in the Guests room |
| be let in | someone with the current link, while the room is on |

Guests can't let other guests in, can't see the link through the API, and can't manage the room.

## The room
Made by the server's system account on the first "Turn on" (alias `#guests:<server>`, name "Guests", topic "Guests
someone let in join here; they're gone after 12 hours."), **not end-to-end encrypted** (a guest's brand-new device could
read nothing said before its keys reached people; the apps encrypt every other new room except a public channel inside a
space, and the server makes #general unencrypted too: both stay readable for people who join later; the server never
makes Synapse encrypt new rooms itself), history visible to members from when they joined (guests never read what was
said before they came in), join rule public (any account on the server can join it from the apps; guests are joined by
the server). Power levels: the system account 100, whoever turned it on 50, `dev.tinhat.guests` /
`dev.tinhat.guests.waiting` / `m.room.encryption` 100 (only the server writes them), kick 50, invite 0, and
`org.matrix.msc3401.call.member` 0: everyone in the room, guests too, may join its call (joining a call is a room state
event, and state_default is 50; same reason as General since 0.2.9). Rooms made before 0.3.6 had no level for it, so a
guest who was let in landed in the room but got "You don't have permission to join calls in this room": the API lowers
exactly that one level to 0 in the Guests room (and no other level, in no other room) when it starts and on every Turn
on: the one deliberate exception to "the server only ever raises levels there". A Guests room
made by an earlier version (0.2.21–0.3.0) stays encrypted (encryption can't be turned off); guests still work there.

State the server keeps there (so every app sees changes at once through sync, no polling):
- `dev.tinhat.guests` (state key `""`): `{"v": 1, "on": true|false, "since": <ms>}` — never the link.
- `dev.tinhat.guests.waiting` (state key `""`): `{"v": 1, "waiting": [{"id": "<8 chars>", "name": "Ana", "at": <ms>}]}`
  (at most 20; empty when nobody waits).

## The server's API (bearer = the caller's Matrix access token)
| | |
|---|---|
| `GET /api/guests` | `{available, room, alias, on, since, link, waiting, canManage, canAdmit, member}` — `room` null before the first "Turn on"; `link` only for members who aren't guests (and managers) |
| `POST /api/guests/on` | manage: makes the room if needed (and joins the caller), new link, on → the doc |
| `POST /api/guests/off` | manage: off, link dead, waiting turned away, guests in the room removed (kicked, accounts deactivated) → the doc |
| `POST /api/guests/link` | manage, while on: a new link; the old one is dead; whoever waited with it is turned away → the doc |
| `POST /api/guests/admit {id}` | admit: a temporary account (12 h) for that guest, joined to the room → `{ok}` |
| `POST /api/guests/turn-away {id}` | admit → `{ok}` |

The guest page (no account; `https://<server>/call/?g=<key>`):
| | |
|---|---|
| `GET /api/guest/door?g=<key>` | `{server, room: "Guests", open, web}` (404 for a link that isn't the current one); `web` = the web app's address (api.web, else the server's own): a door page opened anywhere else moves to `<web>/call/?g=<key>` first |
| `POST /api/guest/knock {g, name}` | `{ticket, every: 2}`; 410 when the link is dead or the room off; 429 when 20 already wait or this address knocked 5 times in 10 minutes |
| `GET /api/guest/ticket?t=<ticket>` | `{state: "waiting" | "in" | "turned-away" | "closed" | "expired"}`; `"in"` carries `session: {hs, user, token, device, room, web}` once (the page then opens `web`) |

**The hand-off happens on the web app's own origin** (0.3.6). `web` is `<web>/#/guest-session?hs=<web>&…`: the web
app (12.0.3+) takes a session only with its own origin as the homeserver (it serves `/_matrix` on its address too),
and the door page opens `web` only on its own origin. With a web app address of its own (api.web, e.g. a server
`example.com` whose web app is `chat.example.com`) 0.3.5 and earlier sent `hs=<server name>`: the guest was let in
and then saw the sign-in screen (or, at the door on the server's name, "The knock ran out").

A wait ends after 10 minutes ("expired": knock again). A session not collected within 2 minutes is withdrawn (the
account is deactivated). Waiting is kept in memory: a restart of the API turns everyone away (the page says to knock
again). The link key is 24 random characters (base64url), stored only in `/var/lib/tinhat/api/guests.json`.

**A guest leaving the call when it goes (0.3.7).** A call membership is owned by its user: once a guest is kicked or
its account deactivated, nobody can withdraw it any more, and until 0.3.6 a guest removed mid-call stayed "in the call"
in every app until the membership expired (up to 4 hours; turning the guest room off while a guest was in its call).
So before every removal (Turn off: before the kick; the 12-hour reaper, a session never picked up and every other
deactivation: before the deactivation) the server reads the room's call memberships and writes `{}` over each live one
the guest sent, **as the guest** (a short-lived token from Synapse's admin "log in as user", logged out after). Best
effort: whatever fails is logged and the removal goes on. A membership left behind (a failure here, or one stuck before
0.3.7, which can't be cleared any more because the account is gone) expires by itself within 4 hours, and the apps
(12.1+) never show a call member who isn't joined to the room; a stuck one needs nothing done about it.

## The apps
- **Where:** (1) Settings → **Guests** (server level): what the guest room is (two sentences), its state, and for
  managers **Turn on the guest room** / **Turn off** · **Copy guest link** · **New link** · **Open the Guests room**.
  (2) In the Guests room, under the header: one bar — on: "Guest room is on · [Copy guest link] [New link] [Turn
  off]" (New link / Turn off for managers only); off: "Guest room is off · [Turn on]" (managers) or "The guest room is
  off" (others). Below it, one row per waiting guest: "**Ana** is waiting · [Let in] [Turn away]".
- **Noticing:** when a new `id` appears in `dev.tinhat.guests.waiting` and this user is a member who isn't a guest, a
  notification "Ana is waiting to come in as a guest" (click → the Guests room). Not for the person's own other
  devices twice: dedupe by id.
- **Gating:** the server's offer (`dev.tinhat.server.features.guests`) — only an explicit false hides all of it. In
  self-hosted builds the old per-room "Create guest link…" / "Copy guest link" items are gone.
- Guests themselves (temporary accounts, `@guest-…`) see neither the bar's buttons nor the waiting list.

## What the guest sees (the page at /call/?g=…)
"<server> — Guests" → "Your name" + **Knock** → "Waiting for someone to let you in… (they've been told)" → either
"You're in" (opens Tin Hat in the browser, straight into the Guests room) or "Nobody let you in this time" / "This
guest link isn't open any more — ask for a new one".

## Home-network servers (`<name>.local`)
A home-network server makes its own certificate, so a guest's device has to trust it once, like any new device
(open `http://<name>.local`, follow the two steps). The apps say so next to the guest link on such a server ("Guests on
your Wi-Fi: they open http://<name>.local first, once"). Guests from outside can't reach a home-network server at all.
