// padstate.mjs — what the call-token route (calltoken.mjs) and call moderation (moderation.mjs) share about Pad sessions
// and a moderator's person mute (PAD-PHONE Step B, 0.3.14; share claude/tinhat-pad/PAD-PHONE/DESIGN.md §8 #7, #11, #17).
// PERSISTED: a small JSON file next to the API's config, written atomically (temp file + rename) on every change, and a
// change is COMMITTED before it counts — a write that fails throws, so the token or the moderation step that made it
// fails too (code review r2 P1 #1). A file that exists but can't be read leaves the state BROKEN (fail closed: no Pad
// token is handed out, every Pad Mic / Camera session fails its generation check, the person mute falls back to the
// room's own record) until it is readable again or removed by the owner.
//
// - The Pad GENERATION per (room, user, device): advanced on every Watch / Pad token, and on a normal token for a device
//   that has one (Talk here: the phone's Pad session goes stale), all under the per-(room, user) lock. Time-based
//   decimals that only grow (never reused, also not after a restart). A generation of a device whose Pad session is in
//   the call is kept alive by the sweep (touch); others expire after GEN_TTL_MS.
// - The latest WATCH identity per (room, user, device): a Watch token has no tinhat.gen (the 12.1.9 apps check its exact
//   attributes), so a replaced Watch identity of a device is recognised by not being the latest one. Every other token
//   for the device (Mic, Camera, a normal one) leaves a tombstone ("": no Watch identity is current) — code review r3.
// - Records are reclaimed only by the sweep, after it has listed every call (reclaim): a long outage of the API can't
//   expire the record of a session that is still connected (code review r3 P2 #8).
// - A commit is crash-durable: the temp file is fsync'd, renamed, and the directory fsync'd before it counts (r3 P1 #3).
// - The PERSON MUTE per (room, mxid) {by, at} and, once lifted, its UNMUTE time — kept until changed (no expiry).
// - ISSUED Watch / Pad tokens per (room, user, device) for ISSUED_TTL_MS (the account limit counts them).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const PADSTATE = Object.freeze({
    MAX_KEYS: 50_000,
    GEN_TTL_MS: 7 * 24 * 3600_000,
    ISSUED_TTL_MS: 5 * 60_000,
});

const k3 = (room, user, device) => `${room}\n${user}\n${device}`;
const k2 = (room, user) => `${room}\n${user}`;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export const padKey = k3;

export function createPadState({ now = Date.now, file = "", log = () => undefined } = {}) {
    const gens = new Map();      // room\nuser\ndevice -> {gen, at}
    const watch = new Map();     // room\nuser\ndevice -> {id, at}   (the latest Watch identity)
    const muted = new Map();     // room\nmxid -> {by, at}
    const unmuted = new Map();   // room\nmxid -> at                 (the last explicit unmute)
    const issued = new Map();    // room\nuser\ndevice -> at
    let last = 0;                // the newest generation handed out (numeric)
    let broken = false;
    const tails = new Map();     // room\nuser -> Promise

    if (file) {
        let raw = null;
        try { raw = readFileSync(file, "utf8"); } catch (e) {
            if (e?.code !== "ENOENT") { broken = true; log(`[padstate] ALERT couldn't read ${file}: ${e?.message || e} — Pad tokens refused until it can be read`); }
        }
        if (raw !== null) {
            try {
                const j = JSON.parse(raw);
                if (!isObj(j) || j.v !== 2) throw new Error("not a v2 Pad state");
                const KEY3 = /^[^\n]+\n[^\n]+\n[^\n]+$/, KEY2 = /^[^\n]+\n[^\n]+$/;
                const load = (m, o, keyRe, ok) => {
                    if (!isObj(o)) throw new Error("a map is missing or isn't an object");
                    for (const [k, v] of Object.entries(o)) { if (!keyRe.test(k) || !ok(v)) throw new Error("bad entry"); m.set(k, v); }
                };
                const num = (v) => Number.isSafeInteger(v) && v >= 0;
                load(gens, j.gens, KEY3, (v) => isObj(v) && typeof v.gen === "string" && /^[0-9]{1,16}$/.test(v.gen) && Number.isSafeInteger(Number(v.gen)) && num(v.at));
                load(watch, j.watch, KEY3, (v) => isObj(v) && typeof v.id === "string" && num(v.at));
                load(muted, j.muted, KEY2, (v) => isObj(v) && typeof v.by === "string" && num(v.at));
                load(unmuted, j.unmuted, KEY2, num);
                load(issued, j.issued, KEY3, num);
                if (!num(j.last)) throw new Error("bad last");
                last = j.last;
                for (const g of gens.values()) last = Math.max(last, Number(g.gen));
            } catch (e) {
                broken = true;
                for (const m of [gens, watch, muted, unmuted, issued]) m.clear();
                log(`[padstate] ALERT ${file} is corrupt (${e?.message || e}) — Pad tokens refused until it is repaired or removed`);
            }
        }
    }
    /** Commit the state (throws when it can't: the change then doesn't count — the caller fails its request). */
    function save() {
        if (broken) throw new Error("the Pad state is unreadable");
        if (!file) return;
        const dir = dirname(file);
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        const o = (m) => Object.fromEntries(m);
        const buf = Buffer.from(JSON.stringify({ v: 2, last, gens: o(gens), watch: o(watch), muted: o(muted), unmuted: o(unmuted), issued: o(issued) }));
        const fd = openSync(tmp, "w", 0o600);
        try {
            // every byte, or it doesn't count (a short write is not a commit: code review r4 P1 #2)
            for (let off = 0; off < buf.length;) {
                const n = writeSync(fd, buf, off, buf.length - off);
                if (!(n > 0)) throw new Error("the state file write made no progress");
                off += n;
            }
            fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(tmp, file);
        // past the rename the new state may be on disk: a failure from here on is UNCERTAIN — the state turns broken (fail
        // closed) instead of rolling back (code review r4 P2 #5)
        try {
            const dfd = openSync(dir, "r");
            try { fsyncSync(dfd); } finally { closeSync(dfd); }
        } catch (e) {
            broken = true;
            throw Object.assign(new Error(`the state file's directory couldn't be synced (${e?.message || e}) — Pad state now unusable until checked`), { uncertain: true });
        }
    }
    /** Run a change; if it can't be committed, undo it and throw. */
    function commit(change) {
        const snap = { gens: new Map(gens), watch: new Map(watch), muted: new Map(muted), unmuted: new Map(unmuted), issued: new Map(issued), last };
        try {
            const r = change();
            save();
            return r;
        } catch (e) {
            if (e?.uncertain) { log(`[padstate] ALERT ${e.message}`); throw e; }
            for (const [m, s] of [[gens, snap.gens], [watch, snap.watch], [muted, snap.muted], [unmuted, snap.unmuted], [issued, snap.issued]]) { m.clear(); for (const [k, v] of s) m.set(k, v); }
            last = snap.last;
            log(`[padstate] ALERT couldn't commit the Pad state: ${e?.message || e}`);
            throw e;
        }
    }
    function trim() {
        const t = now();
        for (const [k, at] of issued) if (t - at > PADSTATE.ISSUED_TTL_MS) issued.delete(k);
        if (gens.size + watch.size + issued.size > PADSTATE.MAX_KEYS) log("[padstate] ALERT the Pad state is unusually large (nothing live is dropped)");
    }

    return {
        /** false: the state file exists but can't be read (fail closed). */
        ok: () => !broken,
        /** A new generation for (room, user, device): a decimal that only grows. Committed (throws when it can't be). */
        advance(room, user, device) {
            return commit(() => {
                last = Math.max(last + 1, now() * 1000);
                gens.set(k3(room, user, device), { gen: String(last), at: now() });
                // every token for the device retires its earlier Watch identity (the Watch route then records its new one)
                watch.set(k3(room, user, device), { id: "", at: now() });
                trim();
                return String(last);
            });
        },
        /** advance, but only for a device that has a generation (a normal token: Talk here makes the Pad session stale;
         *  devices that never used Pad don't fill the state). */
        advanceIfKnown(room, user, device) {
            return gens.has(k3(room, user, device)) ? this.advance(room, user, device) : null;
        },
        /** The device's current generation, or null (none on record). */
        current(room, user, device) {
            const e = gens.get(k3(room, user, device));
            return e ? e.gen : null;
        },
        /** The sweep saw this device's current Pad session in the call: its records stay alive. */
        touch(room, user, device) {
            const t = now();
            const k = k3(room, user, device);
            const g = gens.get(k), w = watch.get(k);
            if ((g && t - g.at > 3600_000) || (w && t - w.at > 3600_000)) {
                try {
                    commit(() => {
                        if (g) gens.set(k, { ...g, at: t });   // new objects: a failed commit restores the old ones (r3 P3)
                        if (w) watch.set(k, { ...w, at: t });
                    });
                } catch { /* logged */ }
            }
        },
        /** The sweep listed EVERY call successfully: records older than GEN_TTL_MS of devices with no session in any call
         *  (`live` = their keys) go. Never called after a sweep that couldn't list a call. */
        reclaim(live) {
            const t = now();
            const old = (m) => [...m].filter(([k, e]) => t - e.at > PADSTATE.GEN_TTL_MS && !live.has(k)).map(([k]) => k);
            const g = old(gens), w = old(watch);
            if (!g.length && !w.length) return;
            try { commit(() => { for (const k of g) gens.delete(k); for (const k of w) watch.delete(k); }); } catch { /* logged */ }
        },
        /** A Watch identity handed to this device (the latest one is the current one). Committed. */
        noteWatch(room, user, device, id) {
            commit(() => watch.set(k3(room, user, device), { id, at: now() }));
        },
        /** The device's latest Watch identity, or null (none on record: a Watch session from before 0.3.14). */
        latestWatch(room, user, device) {
            return watch.get(k3(room, user, device))?.id ?? null;
        },
        /** A Watch / Pad token was handed to this device (holds an account slot for ISSUED_TTL_MS). Committed. */
        noteIssued(room, user, device) {
            commit(() => { issued.set(k3(room, user, device), now()); trim(); });
        },
        /** The devices of `user` in `room` holding a recent Watch / Pad token. */
        issuedDevices(room, user) {
            const out = new Set();
            const pre = `${room}\n${user}\n`;
            const t = now();
            for (const [k, at] of issued) if (k.startsWith(pre) && t - at <= PADSTATE.ISSUED_TTL_MS) out.add(k.slice(pre.length));
            return out;
        },
        /** Run `fn` after every earlier step for the same person in the same room (issuance on all three routes,
         *  moderation of that person, the sweep's state-dependent steps for them). Never called inside another `serial`. */
        serial(room, user, fn) {
            const k = k2(room, user);
            const prev = tails.get(k) || Promise.resolve();
            const run = prev.then(fn, fn);
            const tail = run.then(() => undefined, () => undefined);
            tails.set(k, tail);
            tail.then(() => { if (tails.get(k) === tail) tails.delete(k); });
            return run;
        },
        setMuted(room, mxid, by) {
            commit(() => { muted.set(k2(room, mxid), { by: String(by || ""), at: now() }); unmuted.delete(k2(room, mxid)); });
        },
        clearMuted(room, mxid) {
            commit(() => { muted.delete(k2(room, mxid)); unmuted.set(k2(room, mxid), now()); });
        },
        isMuted(room, mxid) {
            return muted.has(k2(room, mxid));
        },
        /** When this person was last unmuted through this API (ms), or 0. */
        unmutedAt(room, mxid) {
            return unmuted.get(k2(room, mxid)) ?? 0;
        },
        /** The rooms with a person mute in force. */
        mutedRooms() {
            return new Set([...muted.keys()].map((k) => k.slice(0, k.indexOf("\n"))));
        },
        /** The muted people of a room. */
        mutedIn(room) {
            const pre = `${room}\n`;
            return [...muted.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
        },
        /** The people of a room with an explicit unmute on record. */
        unmutedIn(room) {
            const pre = `${room}\n`;
            return [...unmuted.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
        },
        _gens: gens,
        _muted: muted,
        _issued: issued,
        _watch: watch,
    };
}
