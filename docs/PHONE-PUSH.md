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
- Pushers with `app_id` **`dev.tinhat.ios`** or **`dev.tinhat.android`** are accepted only when their endpoint is
  exactly `<PUSH_RELAY>/w/<22-char id>`; `dev.tinhat.web` keeps the browser push-service allowlist and never takes the
  relay. Anything else is rejected before it is fetched, and Synapse drops the pusher.
- `/api/push/register` takes a relay endpoint too (a registration names no app id; the pairing is checked per push).
- `GET /api/push/config` adds `relay` (browsers ignore it; the apps subscribe there).
- Phone payloads are capped at 2 560 bytes (the relay takes bodies up to 2 900 so that the base64 body and the
  APNs / FCM envelope stay under 4 KB); browsers keep 3 072.
- Phone pushes carry one `Topic` per event (browsers: one per room). The relay turns it into a per-subscription
  collapse key; phones stack a room's messages the way their platform does.
- The A5.9 call-key filter applies to the phones the same way.

The relay's contract (subscriptions, answers, what it keeps): the relay's `docs/CONTRACT.md`. The apps' side: the
iOS app's `docs/research/NOTIFICATIONS.md` and the shared bridge `window.tinhatNative.notifications`.
