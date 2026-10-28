// guestcalls.mjs — a guest's call memberships are withdrawn AS the guest before its account goes (guest-leave, 0.3.7).
//
// A call membership (MatrixRTC `org.matrix.msc3401.call.member`, state key `_@guest-…_DEVICE_m.call`) is owned by
// its user: only that user can write it. Once the guest is kicked or deactivated nobody can, so a guest removed in
// the middle of a call stayed "in the call" in every app until the membership expired (up to 4 h; seen on a live server 2026-10-27).
// So before the kick / deactivation: read the room's state as the system account, and for each live membership the
// guest sent, PUT `{}` with a short-lived token for the guest (Synapse's admin "log in as user"), logged out after.
// Best effort: whatever fails is logged and the removal goes on (a membership left behind expires by itself, and the
// apps from 12.1 never show a call member who isn't joined to the room).
//
//   clearGuestCalls({ call, adminToken, user, room, log }) → how many memberships were withdrawn
//     call(method, path, token, body) → { ok, status, body }   (the homeserver, internal address)
export const CALL_MEMBER_TYPES = ["org.matrix.msc3401.call.member", "m.call.member", "m.rtc.member"];

const enc = encodeURIComponent;
/** How long the short-lived token used to act as the guest lives at most. */
export const LOGIN_TTL_MS = 120_000;
const live = (c) => !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length > 0;

export async function clearGuestCalls({ call, adminToken, user, room, log = () => {} }) {
    if (!user || !room) return 0;
    const st = await call("GET", `/_matrix/client/v3/rooms/${enc(room)}/state`, adminToken).catch((e) => ({ ok: false, status: e.message }));
    if (!st.ok || !Array.isArray(st.body)) {
        log(`[guests] reading ${room}'s state to end ${user}'s call said ${st.status}; its call membership expires by itself`);
        return 0;
    }
    const mine = st.body.filter((e) => CALL_MEMBER_TYPES.includes(e?.type) && e.sender === user && typeof e.state_key === "string" && live(e.content));
    if (!mine.length) return 0;
    // the token expires by itself (2 min) even when the logout below fails: Synapse's "login as user" token is the admin's,
    // so the guest's deactivation wouldn't remove it (assembly-037 review)
    const lg = await call("POST", `/_synapse/admin/v1/users/${enc(user)}/login`, adminToken, { valid_until_ms: Date.now() + LOGIN_TTL_MS })
        .catch((e) => ({ ok: false, status: e.message }));
    const token = lg.ok && typeof lg.body?.access_token === "string" ? lg.body.access_token : "";
    if (!token) {
        log(`[guests] couldn't act as ${user} to end its call (${lg.status}); its call membership expires by itself`);
        return 0;
    }
    let n = 0;
    try {
        for (const e of mine) {
            const r = await call("PUT", `/_matrix/client/v3/rooms/${enc(room)}/state/${enc(e.type)}/${enc(e.state_key)}`, token, {})
                .catch((err) => ({ ok: false, status: err.message }));
            if (r.ok) n++;
            else log(`[guests] ending ${user}'s call membership ${e.state_key} said ${r.status}; it expires by itself`);
        }
    } finally {
        const out = await call("POST", "/_matrix/client/v3/logout", token, {}).catch((e) => ({ ok: false, status: e.message }));
        if (!out?.ok) log(`[guests] logging out the token used to end ${user}'s call said ${out?.status}; it expires within ${LOGIN_TTL_MS / 60_000} min`);
    }
    return n;
}
