// identity.ts — which user a LiveKit participant identity belongs to (identity fix 12.1.8, share
// claude/tinhat-security-review/IDENTITY-PARSE-20261102.md, finding B). MIRROR: desktop crates/streamer/src/identity.rs
// (same rules, same test vectors: identity.test.ts ↔ identity.rs tests).
//
// A Tin Hat call server mints `<mxid>:<device_id>`. The mxid itself may hold one or two ':' (`@u:host`,
// `@u:host:8448`), so splitting the string at a FIXED place loses a server's port (the nav roster used the first two
// parts, so `@u:h:8448:DEV` showed as `@u:h`; the desktop recorder did the same and missed that user's "never record
// me"). The room's live call memberships say who is behind an identity: the session whose `<sender>:<device_id>` is
// exactly the identity. Only when no live membership matches (or two do, which only a ':' in a device id can cause)
// does the string decide: everything before the LAST ':' (mxidOf, a port kept). The recorder's consent rule is
// stricter (recordExcluded: any possible owner's "no" counts).
// No imports: the unit test (identity.test.ts) runs it under plain Node, and util.ts re-exports mxidOf from here.

/** `@u:server:DEVICE` → `@u:server` (everything before the LAST ":", keeps a host:port). Desktop: identity.rs mxid_of. */
export function mxidOf(identity: string): string {
  const i = identity.lastIndexOf(":");
  if (i <= 0) return identity;
  const head = identity.slice(0, i);
  // A bare mxid has exactly one ":" after the localpart (or two with a port) — only strip when
  // what remains still looks like an mxid.
  return head.includes(":") ? head : identity;
}

/** 12.1.9 (assembly-044 area 3 P2): is this call participant (a LiveKit identity, or the bare mxid a fake call's tile
 *  carries) the user `mxid`'s, by the string alone (the call menus have no memberships at hand)? `@a:h:8448:DEV` is
 *  `@a:h:8448`'s, never `@a:h`'s (the old `startsWith(mxid + ":")` and the first-two-parts split both said `@a:h`).
 *  Desktop: identity.rs is_participant_of + AppCore.qml tileMxid. */
export function isParticipantOf(participant: string, mxid: string): boolean {
  return !!mxid && (participant === mxid || mxidOf(participant) === mxid);
}

/** What these rules read from a live call membership (callrules LiveSession has both). */
export interface IdentitySession {
  sender: string;
  deviceId: string;
}

/** Users whose live call membership mints exactly this identity (`<sender>:<device_id>`), deduped, in order. */
export function usersOfIdentity(identity: string, sessions: readonly IdentitySession[]): string[] {
  const out: string[] = [];
  for (const s of sessions) {
    if (!s.sender || !s.deviceId) continue;
    if (`${s.sender}:${s.deviceId}` === identity && !out.includes(s.sender)) out.push(s.sender);
  }
  return out;
}

/** The user behind a LiveKit identity: its one live membership; otherwise everything before the last ':'. */
export function userOfIdentity(identity: string, sessions: readonly IdentitySession[]): string {
  const users = usersOfIdentity(identity, sessions);
  return users.length === 1 ? users[0]! : mxidOf(identity);
}

/** Is this LiveKit identity (always an identity, never a bare mxid: `@u:h:8448` reads as `@u:h`'s device `8448`) the
 *  user `mxid`'s? */
export function identityIsUser(identity: string, mxid: string, sessions: readonly IdentitySession[]): boolean {
  return !!mxid && userOfIdentity(identity, sessions) === mxid;
}

/**
 * "Never record me" for an identity (the desktop recorder's rule, crates/app/src/identity.rs record_excluded; kept
 * here so both copies run against the same vectors): excluded when ANY user who could own it opted out, i.e. any
 * opted-out user whose `<mxid>:` starts the identity (or who is the identity). The true owner always does, whatever
 * the device id, so a port server's user is matched with their port. Deliberately not decided by the memberships: a
 * membership claiming the identity (`@a:h` with device `8448:PHONE` for `@a:h:8448:PHONE`) must not be able to switch
 * off someone else's "no"; the price is that `@a:h` saying no also keeps `@a:h:8448` (same DNS owner) out.
 */
export function recordExcluded(identity: string, optouts: readonly string[]): boolean {
  return optouts.some((u) => !!u && (identity === u || identity.startsWith(`${u}:`)));
}
