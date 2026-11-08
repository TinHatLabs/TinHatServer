// callmute.mjs — what call moderation (moderation.mjs) and the call-token route's sweep (calltoken.mjs) share about a
// moderator's mute (PAD-PHONE Step B, 0.3.14): reading LiveKit's room-service output (protojson: enums as names or
// numbers, zero values — AUDIO, UNKNOWN — possibly left out) and the permissions a mute writes. One copy, so a mute
// applied by a moderator and one re-applied by the sweep on an arrival are the same.

/** A track is AUDIO: "AUDIO", 0, "0" or the type left out (protojson omits the zero value). VIDEO (1) never is. */
export const isAudioTrack = (t) => { const v = t?.type; return v === undefined || v === null || v === "AUDIO" || v === 0 || v === "0"; };
/** An enum value of LiveKit's room service is `name` / its number `n` (a left-out value is the zero one). */
export const enumIs = (v, name, n) => v === name || v === n || v === String(n) || ((v === undefined || v === null) && n === 0);
export const SOURCE = Object.freeze({ UNKNOWN: 0, CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4 });

/** Everything but the microphone (and the "unknown"-source soundboard/music tracks, deliberately not listed: a muted
 *  person is silent). The normal call mute. */
export const MUTED_PUBLISH_SOURCES = Object.freeze(["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);

/** A boolean of the participant's permission as LiveKit reports it (a field left out of a reported object = false);
 *  no permission reported at all: refuse to rebuild one. */
export function permBool(cur, snake, camel) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) throw new Error("the call server reported no permissions for them");
    return (cur[snake] ?? cur[camel]) === true;
}

/** The publish-source list of a reported permission ([] when left out = every source while can_publish is true). */
export function sourcesOf(perm) {
    const v = perm?.can_publish_sources ?? perm?.canPublishSources;
    return Array.isArray(v) ? v : [];
}

/** May this (normal) permission publish the microphone? can_publish and (every source, or MICROPHONE listed). */
export function mayPublishMic(perm) {
    if (!perm || typeof perm !== "object") return true; // unreadable: treat as able (the mute is then re-applied)
    if ((perm.can_publish ?? perm.canPublish) !== true) return false;
    const s = sourcesOf(perm);
    return s.length === 0 || s.some((x) => enumIs(x, "MICROPHONE", SOURCE.MICROPHONE));
}

/** The normal call mute's permission, the rest of `cur` kept. */
export const normalMutePermission = (cur) => ({
    can_subscribe: permBool(cur, "can_subscribe", "canSubscribe"),
    can_publish: permBool(cur, "can_publish", "canPublish"),
    can_publish_data: permBool(cur, "can_publish_data", "canPublishData"),
    can_update_metadata: permBool(cur, "can_update_metadata", "canUpdateMetadata"),
    hidden: permBool(cur, "hidden", "hidden"),
    can_publish_sources: [...MUTED_PUBLISH_SOURCES],
});

/** A Pad Mic connection's permission: exactly its token's grant (the microphone only), or publishing taken away while
 *  muted. Never more (the sweep removes a Pad connection holding anything beyond its mode's grant). */
export const padMicPermission = (cur, muted) => ({
    can_subscribe: permBool(cur, "can_subscribe", "canSubscribe"),
    can_publish: !muted, can_publish_data: false, can_update_metadata: false, hidden: false,
    can_publish_sources: muted ? [] : ["MICROPHONE"],
});

const SOURCE_NAMES = ["UNKNOWN", "CAMERA", "MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"];
/** A reported permission's publish sources as names (numbers and numeric strings mapped), sorted. */
export const sourceNames = (perm) => sourcesOf(perm).map((x) => (typeof x === "number" || /^\d+$/.test(String(x)) ? SOURCE_NAMES[Number(x)] ?? String(x) : String(x))).sort();
/** Is this exactly the normal call mute's restriction (whatever the enum spelling)? */
export const isNormalMuteRestriction = (perm) => JSON.stringify(sourceNames(perm)) === JSON.stringify([...MUTED_PUBLISH_SOURCES].sort());

