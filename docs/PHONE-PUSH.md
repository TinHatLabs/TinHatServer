# Notifications on the Tin Hat phone apps (PUSH_RELAY)

**For owners, in one sentence:** phone notifications are on by default — when someone turns them on in the Tin Hat
iPhone or Android app, this server sends each notification, encrypted for that phone only, through the Tin Hat
project's relay (push.tinhat.dev, run by the Tin Hat project behind Cloudflare) to Apple or Google, and neither the relay
nor Apple or Google can read who wrote what; turn it off in the dashboard under Extras and keys → Phone notifications.

The iPhone and Android apps get their notifications the way a browser does: through this server's own push gateway
(`api/tinhat-api/push.mjs`), with the same rules (what is pushed, the words, dedup, "quiet while at a computer"). The
difference is where the encrypted push goes. A browser hands the server a push service of Apple, Google, Mozilla or
Microsoft. The phone apps hand it **one relay**, which forwards the ciphertext to Apple (APNs) or Google (FCM): those
need credentials that belong to the app, not to each server.

```
 this server's push.mjs ── Web Push (RFC 8291 body + RFC 8292 VAPID, this server's key) ──► relay /w/<id> ──► APNs / FCM ──► phone
```

What the relay sees: ciphertext, sizes, timing, the phone's device token and this server's VAPID public key. Never a
room, a user or a message: the payload is encrypted to keys made on the phone, the same as for a browser.

## The setting
`PUSH_RELAY` — the relay's origin, like `https://push.tinhat.dev`. Unset: the phone apps' pushers are refused and
nothing ever contacts a relay. A value that isn't an https origin (http only for a loopback lab relay) is logged and
treated as unset.

On a Tin Hat Server the manager writes it (`apiconf.py`): `https://push.tinhat.dev` (environment.py's `push_relay`;
the lab's environment.json swaps in its own), unless the owner switched phone notifications off (state `api.phone_push
= false`). The well-known's features say `phone_push` so the apps know. The relay is run by the Tin Hat project behind
Cloudflare; it only ever carries ciphertext (above).

With it set:
- Pushers with `app_id` **`dev.tinhat.ios`**, **`dev.tinhat.android`** or (0.3.8 onwards) **`dev.tinhat.macos`** (the
  Mac app: the same relay and payload as the iPhone app) are accepted only when their endpoint is
  exactly `<PUSH_RELAY>/w/<22-char id>`; `dev.tinhat.web` keeps the browser push-service allowlist and never takes the
  relay. Anything else is rejected before it is fetched, and Synapse drops the pusher.
- `/api/push/register` takes a relay endpoint too (a registration names no app id; the pairing is checked per push).
- `GET /api/push/config` adds `relay` (browsers ignore it; the apps subscribe there) and, 0.3.8 onwards,
  `phone_apps`: the app ids this server takes at that relay (`["dev.tinhat.ios", "dev.tinhat.android",
  "dev.tinhat.macos"]`). An app uses its own id only when it is listed. A server without `phone_apps` (0.3.7 and
  older) answers an unknown app id with `rejected` and Synapse then deletes the pusher, so the Mac app registers as
  `dev.tinhat.ios` there. Without a relay neither `relay` nor `phone_apps` is sent.
- Phone payloads are capped at 2 560 bytes (the relay takes bodies up to 2 900 so that the base64 body and the
  APNs / FCM envelope stay under 4 KB); browsers keep 3 072.
- Phone pushes carry one `Topic` per event (browsers: one per room). The relay turns it into a per-subscription
  collapse key; phones stack a room's messages the way their platform does.
- The A5.9 call-key filter applies to the phones the same way.

The relay's contract (subscriptions, answers, what it keeps): the relay's `docs/CONTRACT.md`. The apps' side: the
iOS app's `docs/research/NOTIFICATIONS.md` and the shared bridge `window.tinhatNative.notifications`.

## Ringing (0.3.8)
DM calls ring through the same path: `kind: "ring"` / `"ring_stop"` payloads, TTL 30, a Topic shared by a ring and
its stop (so the relay's `apns-collapse-id` / FCM collapse key replaces the ring with the stop). A phone asks for rings
with `rings: {"v": 1, "stop": true}` in `/push/register`; iOS's PushKit subscription rides in the same registration
as `rings.voip` (`<PUSH_RELAY>/v/<id>`, encrypted to the registration's keys) and gets non-busy rings only. The whole
contract (who may ring whom, payloads, decline, old registrations): docs/API.md "Ringing". The relay's `/v/` VoIP
output is the relay lane's (RINGING.md §3); until it exists, an iPhone registers without `voip`.
