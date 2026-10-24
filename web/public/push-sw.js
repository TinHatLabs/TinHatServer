// push-sw.js — Tin Hat Web's push worker (REACH §3.2 + A2.9). Push ONLY: no fetch handler, no caching.
// `sw.js` next to it stays the old Element fork's kill switch — never reuse that name.
//
//   push               the gateway's payload {v, room, event, kind, title, body, unread, user} → one visible
//                      notification (ALWAYS — iOS allows no silent push; missing fields get fallback text),
//                      tag "room:<id>" (an invite: "invite:<id>", the page's own invite tag — web review #15)
//                      + renotify, then the app badge (A5.10: pushed rooms ∪ the page's unread set — the
//                      payload's `unread` is not used; a badge failure never blocks the notification)
//   notificationclick  close it; focus a Tin Hat window inside this worker's scope and postMessage
//                      {type: "tinhat-open-room", room, user} (or "tinhat-note-click" for the page's own notes);
//                      no window → open one at <scope>#/room/<id>
// Paths come from self.registration.scope (files in public/ get no BASE_URL): / live, /next/ staging.
"use strict";

const SCOPE = self.registration.scope;
const ICON = new URL("appicon/tinhat-192.png", SCOPE).href;

const text = (v, max) =>
  (typeof v === "string" ? v : "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Every field validated; whatever is missing falls back to a generic note. */
function parsePayload(data) {
  let p = null;
  try {
    p = data ? data.json() : null;
  } catch (_) {
    p = null;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) p = {};
  const room = typeof p.room === "string" && /^![^\s/]+:[^\s/]+$/.test(p.room) ? p.room : "";
  return {
    room,
    event: typeof p.event === "string" && p.event.startsWith("$") ? p.event : "",
    kind: p.kind === "invite" ? "invite" : "message",
    title: text(p.title, 120) || "Tin Hat",
    body: text(p.body, 400) || "New activity",
    unread: Number.isInteger(p.unread) && p.unread >= 0 ? p.unread : null,
    user: typeof p.user === "string" && /^@[^\s:]+:\S+$/.test(p.user) ? p.user : "",
  };
}

/** event.waitUntil(p) — an untrusted (synthetic) event throws there; the work still runs. */
function keep(event, p) {
  try {
    event.waitUntil(p);
  } catch (_) {
    /* not a trusted event (tests) */
  }
  return p;
}

// A5.10 badge: the count of (rooms pushed since the page was last visible ∪ the page's last unread set). The page
// writes its set in Cache storage under an EPOCH that it renews at every visible moment (a cold visible start
// too); the worker counts only pushed rooms recorded under the page's current epoch, so the page never has to
// delete the pushed set under a push being handled (web review #17/#18). Updates here run one at a time (two
// pushes for two rooms = 2). A push without a room adds none.
const BADGE_CACHE = "tinhat-badge";
const badgeKey = (k) => SCOPE + "__tinhat/badge/" + k;

async function readRec(cache, k) {
  try {
    const r = await cache.match(badgeKey(k));
    const j = r ? await r.json() : null;
    return {
      rooms: Array.isArray(j && j.rooms) ? j.rooms.filter((x) => typeof x === "string") : [],
      epoch: j && typeof j.epoch === "string" ? j.epoch : "",
    };
  } catch (_) {
    return { rooms: [], epoch: "" };
  }
}

async function setBadgeNow(room) {
  try {
    const cache = await caches.open(BADGE_CACHE);
    const page = await readRec(cache, "unread");
    const prev = await readRec(cache, "pushed");
    const pushed = new Set(prev.epoch === page.epoch ? prev.rooms : []);
    if (room && !pushed.has(room)) {
      pushed.add(room);
      await cache.put(badgeKey("pushed"), new Response(JSON.stringify({ rooms: [...pushed], epoch: page.epoch }), { headers: { "Content-Type": "application/json" } }));
    }
    const n = new Set([...page.rooms, ...pushed]).size;
    const nav = self.navigator;
    if (n > 0) {
      if (nav.setAppBadge) await nav.setAppBadge(n);
    } else if (nav.clearAppBadge) await nav.clearAppBadge();
  } catch (_) {
    /* the badge never blocks the notification */
  }
}

let badgeQueue = Promise.resolve();
function setBadge(room) {
  const p = badgeQueue.then(() => setBadgeNow(room));
  badgeQueue = p.catch(() => undefined);
  return p;
}

self.addEventListener("install", (event) => {
  keep(event, self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  keep(event, Promise.resolve());
});

self.addEventListener("push", (event) => {
  keep(
    event,
    (async () => {
      const n = parsePayload(event.data);
      // an invite shares the page's own invite tag (one note per invite; the page keeps it while it is pending)
      const tag = n.room ? (n.kind === "invite" ? "invite:" : "room:") + n.room : "tinhat";
      const shown = self.registration
        .showNotification(n.title, {
          body: n.body,
          tag,
          renotify: true,
          icon: ICON,
          badge: ICON,
          data: { room: n.room, event: n.event, kind: n.kind, user: n.user, push: true },
        })
        .catch(() =>
          // an option this browser rejects must not cost the notification
          self.registration.showNotification(n.title, { body: n.body, tag: "tinhat", data: { room: n.room, kind: n.kind, user: n.user, push: true } }),
        );
      await Promise.all([shown, setBadge(n.room)]);
    })(),
  );
});

/** Our own window first: exactly the scope's page, then any focused / visible one inside the scope. */
function pickWindow(all) {
  const inScope = all.filter((c) => typeof c.url === "string" && c.url.startsWith(SCOPE));
  const bare = (u) => u.split("#")[0].split("?")[0];
  const exact = inScope.filter((c) => bare(c.url) === SCOPE || bare(c.url) === SCOPE + "index.html");
  const pool = exact.length ? exact : inScope;
  return pool.find((c) => c.focused) || pool.find((c) => c.visibilityState === "visible") || pool[0] || null;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data && typeof event.notification.data === "object" ? event.notification.data : {};
  const room = typeof d.room === "string" && d.room.startsWith("!") ? d.room : "";
  const note = typeof d.note === "string" ? d.note : "";
  const user = typeof d.user === "string" ? d.user : "";
  keep(
    event,
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = pickWindow(all);
      if (win) {
        try {
          await win.focus();
        } catch (_) {
          /* not allowed: still tell it */
        }
        if (note) win.postMessage({ type: "tinhat-note-click", note, room, user });
        else if (room) win.postMessage({ type: "tinhat-open-room", room, user });
        return;
      }
      await self.clients.openWindow(SCOPE + (room ? "#/room/" + encodeURIComponent(room) : ""));
    })(),
  );
});
