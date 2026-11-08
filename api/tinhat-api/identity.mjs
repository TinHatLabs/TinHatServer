// identity.mjs — the ONE rule for a LiveKit participant identity on this server: `<mxid>:<device>` (identity fix 12.1.8 /
// 0.3.12, share claude/tinhat-security-review/IDENTITY-PARSE-20261102.md, finding A).
//
// calltoken.mjs mints a call sign-in only for a device id that matches DEVICE_RE (with the room check on AND off), and
// moderation.mjs targets / drops participants through parseIdentity. Both import from here, so "the token route lets
// this device in" and "call moderation can mute or remove it" can't drift apart: before 0.3.12 the token route refused
// only ':' while moderation wanted [A-Za-z0-9_-]{1,64}, and a device such as `X.1` got into calls that moderators
// couldn't touch.
//
// Why the device part has no ':': the mxid may carry one or two (`@u:host`, `@u:host:8448`, `@u:[::1]:8448`), so the
// identity is split at its LAST ':' and that is unambiguous only while a device can't contain one.
// Hidden devices (Synapse's cross-signing key rows, ids such as base64 public keys) never ask for a call sign-in and are
// never listed here; nothing in this file reads the device table.

/**
 * A device id a call sign-in may carry: what Synapse (`[A-Z]{10}`), Element X / rust-sdk (password login, and QR login,
 * which takes the device's Curve25519 key in unpadded base64 as its device id: `+` and `/` possible) and the Tin Hat
 * apps make. Never a ':' (the identity must stay unambiguous) and nothing call moderation can't target (the same rule).
 */
export const DEVICE_RE = /^[A-Za-z0-9_+/-]{1,64}$/;

/** A Matrix user id: `@localpart:server`, server = a DNS name or an IPv6 literal, with an optional port. m[1] = server. */
export const MXID_RE = /^@[^:\s]{1,255}:([A-Za-z0-9.-]{1,255}(?::\d{1,5})?|\[[0-9A-Fa-f:.]{2,45}\](?::\d{1,5})?)$/;

export const deviceOk = (d) => typeof d === "string" && DEVICE_RE.test(d);

/** A Pad Watch connection's suffix (calltoken.mjs watchGrant): `<mxid>:<device>~watch-<16 lowercase hex>`. */
export const WATCH_SUFFIX_RE = /~watch-[0-9a-f]{16}$/;
/** A Pad Mic / Camera connection's suffix (calltoken.mjs padGrant, PAD-PHONE Step B, 0.3.14):
 *  `<mxid>:<device>~pad-mic-<16 lowercase hex>` / `~pad-cam-<16 lowercase hex>`. m[1] = "mic" | "cam". */
export const PAD_SUFFIX_RE = /~pad-(mic|cam)-[0-9a-f]{16}$/;

/** `<mxid>:<device>`, or a Pad connection `<mxid>:<device>~watch-<16hex>` / `~pad-mic-<16hex>` / `~pad-cam-<16hex>` ->
 *  {mxid, device} (+ watch: true for a Watch connection, pad: "mic" | "cam" for a Pad Mic / Camera one) | null (not an
 *  identity this server mints). The ONE parser of call identities: moderation targets by it, the reserved-identity sweep
 *  checks by it, and the apps' person tiles follow it. One suffix at most (the device part never holds a '~'). */
export function parseIdentity(identity) {
    if (typeof identity !== "string") return null;
    const w = WATCH_SUFFIX_RE.exec(identity);
    const pd = w ? null : PAD_SUFFIX_RE.exec(identity);
    const cut = w || pd;
    const base = cut ? identity.slice(0, cut.index) : identity;
    const i = base.lastIndexOf(":");
    if (i < 0) return null;
    const mxid = base.slice(0, i), device = base.slice(i + 1);
    if (!deviceOk(device) || !MXID_RE.test(mxid)) return null;
    if (w) return { mxid, device, watch: true };
    if (pd) return { mxid, device, pad: pd[1] };
    return { mxid, device };
}

/** The identity this server mints for (mxid, device), or null when the device id is not one it mints for. */
export const identityOf = (mxid, device) => (deviceOk(device) && MXID_RE.test(String(mxid)) ? `${mxid}:${device}` : null);

/**
 * Is this LiveKit identity one of `mxid`'s connections (the bare mxid, or `<mxid>:<device>` with a device that holds no
 * ':')? Wider than parseIdentity on the device on purpose: dropFromCall must also end connections made before 0.3.12
 * with a device such as `X.1`, and never `@g:host:8448`'s when `@g:host` is named (a plain prefix match did).
 */
export function isConnectionOf(identity, mxid) {
    if (typeof identity !== "string" || typeof mxid !== "string" || !mxid) return false;
    if (identity === mxid) return true;
    if (!identity.startsWith(`${mxid}:`)) return false;
    const device = identity.slice(mxid.length + 1);
    return device.length > 0 && !device.includes(":");
}
