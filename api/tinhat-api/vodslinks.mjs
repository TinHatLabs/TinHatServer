// vodslinks.mjs — the signed links /vods/sessions hands out for one recording's files (Memories), and the check the
// file and thumbnail routes make (round 3 security review, RECORDER-8).
//
// A link is `…/<room dir>/<session>/<file>?exp=<ms>&u=<user id>&sig=<hmac>`: the signature covers the path, the expiry
// AND the person it was issued to, and every request re-checks that this person is still joined to the session's room
// (read from its session.json; the member list cached for a minute). So a link stops working within a minute of its
// holder being kicked, banned or leaving, and a forwarded link works only while the person it was made for is in the
// room. Links from before this change (no `u`) keep working until they expire (at most 24 h).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

/** The signature of a link: 128 bits, hex. Without `user`: the older form (path + expiry only). */
export function vodsSig(secret, p, exp, user = undefined) {
    const msg = user === undefined ? `${p}\0${exp}` : `${p}\0${exp}\0${user}`;
    return createHmac("sha256", secret).update(msg).digest("hex").slice(0, 32);
}

/** The query string of a link to `p` for `user`. */
export function vodsQuery(secret, p, exp, user) {
    return `exp=${exp}&u=${encodeURIComponent(user)}&sig=${vodsSig(secret, p, exp, user)}`;
}

/**
 * The check: `deps` = { secret, sameHex, vodsDir, joined(room, user) -> Promise<boolean>, now() }.
 * -> {ok: true} or {status} (400 bad path, 403 refused, 502 the room couldn't be checked).
 */
export async function vodsAllowed(deps, p, query) {
    if (typeof p !== "string" || p.includes("..") || p.includes("//")) return { status: 400 };
    // every field a plain string (Express's query parser makes objects and arrays of `exp[x]=` / `exp=1&exp=2`)
    for (const k of ["exp", "sig", "u"]) if (query[k] !== undefined && typeof query[k] !== "string") return { status: 400 };
    if (!/^[0-9]{1,16}$/.test(query.exp || "")) return { status: 403 };
    const exp = Number(query.exp);
    const sig = query.sig || "";
    if (!exp || exp < deps.now()) return { status: 403 };
    if (query.u === undefined) return deps.sameHex(sig, vodsSig(deps.secret, p, exp)) ? { ok: true } : { status: 403 };
    const user = String(query.u);
    if (!deps.sameHex(sig, vodsSig(deps.secret, p, exp, user))) return { status: 403 };
    const [dir, session] = p.split("/");
    let room;
    try { room = JSON.parse(readFileSync(`${deps.vodsDir}/${dir}/${session}/session.json`, "utf8")).room; } catch { return { status: 403 }; }
    if (typeof room !== "string") return { status: 403 };
    let ok;
    try { ok = await deps.joined(room, user); } catch { return { status: 502 }; }
    return ok ? { ok: true } : { status: 403 };
}

/** Who is joined to a room, through `fetchMembers(room)` -> Set | null, each room's answer kept `ttlMs`. */
export function memberCache(fetchMembers, { ttlMs = 60_000, failMs = 5_000, max = 500, now = Date.now } = {}) {
    const m = new Map();
    const pending = new Map();  // room -> the one read in flight (a burst of requests shares it)
    return async function joined(room, user) {
        let e = m.get(room);
        if (!e || now() - e.at > (e.failed ? failMs : ttlMs)) {
            let read = pending.get(room);
            if (!read) {
                read = (async () => {
                    try {
                        const set = await fetchMembers(room);
                        const v = { at: now(), set };
                        m.delete(room); m.set(room, v);
                        if (m.size > max) m.delete(m.keys().next().value);
                        return v;
                    } catch (err) {
                        // a failed read is remembered briefly (refused meanwhile: never a request per hit to a server in trouble)
                        const v = { at: now(), set: null, failed: true };
                        m.delete(room); m.set(room, v);
                        if (m.size > max) m.delete(m.keys().next().value);
                        throw err;
                    } finally { pending.delete(room); }
                })();
                pending.set(room, read);
            }
            e = await read;  // throws: unknown (the route answers 502)
        } else if (e.failed) {
            throw new Error("the member list couldn't be read just now");
        }
        return !!e.set && e.set.has(user);
    };
}
