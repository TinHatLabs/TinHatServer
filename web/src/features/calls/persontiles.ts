// persontiles.ts — Pad on the phone, Step A (share claude/tinhat-pad/PAD-PHONE/DESIGN.md): ONE call tile per PERSON, and
// the phone/Pad chip. Pure (types only): unit-tested under Node with the vectors shared byte-for-byte with the desktop
// (persontiles.vectors.json = crates/app/src/testvectors/persontiles.json; desktop crates/app/src/persontiles.rs).
//
// The trust rule: a participant belongs to person P ONLY when the SERVER says so — the attribute `tinhat.person` = P, which
// a 0.3.13+ Tin Hat Server mints into every call token (canUpdateOwnMetadata false: no participant can set or change its
// own attributes; a client data packet, its metadata or its name never count) — AND its identity is exactly
// `P:<device>` (device [A-Za-z0-9_+/-]{1,64}: the server's identity.mjs DEVICE_RE, 0.3.12) with an optional exact `~watch-<16 lowercase hex>`. No attribute (an older
// server, a session or token from before the server's 0.3.13 key rotation) or anything else = nobody's: its own tile,
// exactly as before. The chip: the same, plus `tinhat.pad=phone`, `tinhat.mode=watch` and the `~watch-` suffix.
import type { Tile } from "./contract";

export type Attrs = Readonly<Record<string, string>> | undefined;
export type PadChip = "" | "watch";

// The server's identity.mjs MXID_RE, exactly (JavaScript's own \s, lengths in UTF-16 code units; the desktop spells the
// same set out: persontiles.rs). The device: identity.mjs DEVICE_RE ('+' and '/' for rust-sdk QR-login devices).
const MXID_RE = /^@[^:\s]{1,255}:(?:[A-Za-z0-9.-]{1,255}(?::\d{1,5})?|\[[0-9A-Fa-f:.]{2,45}\](?::\d{1,5})?)$/;
const DEVICE_PART_RE = /^[A-Za-z0-9_+/-]{1,64}(~watch-[0-9a-f]{16})?$/;

/** The person the server vouches for (its mxid), or "" (nobody's). */
export function personOf(identity: string, attrs: Attrs): string {
  const p = attrs?.["tinhat.person"];
  if (typeof p !== "string" || !MXID_RE.test(p)) return "";
  if (!identity.startsWith(`${p}:`)) return "";
  return DEVICE_PART_RE.test(identity.slice(p.length + 1)) ? p : "";
}

/** The Pad chip of one participant ("" = none). */
export function chipOf(identity: string, attrs: Attrs): PadChip {
  if (!personOf(identity, attrs)) return "";
  if (attrs?.["tinhat.pad"] !== "phone" || attrs?.["tinhat.mode"] !== "watch") return "";
  return /~watch-[0-9a-f]{16}$/.test(identity) ? "watch" : "";
}

export type PersonTile = Tile & {
  members: string[];
  pad: PadChip;
  othersLive: boolean;
  alts: string[];
  altOf: string;
  partlyMuted: boolean;
};

const isShare = (t: Tile) => t.kind === "screenshare" || t.screenshare;

/**
 * Fold the call's tiles into one per person (after the screen-share companions fold). `ownIdentity` = this device's
 * call identity (its mxid is "me"); `attrsOf` = the participant's attributes; `pick` = the viewer's camera choice per
 * person (tile id). Rules (shared vectors):
 * - a screen share stays its own tile;
 * - my other devices fold into MY tile: it lists them (members), says when one of their mics is live (othersLive) and
 *   carries the chip;
 * - a WATCHER (the chip: subscribe-only, the server's token grants it no publishing) never has a live mic: it never
 *   makes othersLive and never makes a person "not muted" (review r2: no mic publication reads as "not muted");
 * - a person's cameras: ONE is shown (the viewer's pick, else the lowest tile id: the same on every screen); the others
 *   stay in the list with altOf = the shown one (the UI hides them, nothing is torn down), the shown one lists them in
 *   alts. No camera: their first avatar tile. Their other avatars go.
 * - MY cameras (review r2): my self-view ("You") and my other devices' cameras are one person's cameras too: the
 *   self-view is shown unless I picked another; the shown one carries my tile's members / chip / othersLive;
 * - the shown tile: the members (sorted; [] for one device), the chip, muted = every member muted, serverMuted = every
 *   member muted by a moderator, partlyMuted = some.
 */
export function foldPersons(tiles: readonly Tile[], ownIdentity: string, attrsOf: (identity: string) => Attrs, pick: ReadonlyMap<string, string> = new Map()): PersonTile[] {
  const own = ownMxid(ownIdentity);
  const keyOf = (t: Tile): string => (t.participant === "You" ? "" : personOf(t.participant, attrsOf(t.participant)));
  const hasSelf = tiles.some((t) => t.participant === "You");
  const members = new Map<string, Set<string>>();
  const chip = new Map<string, PadChip>();
  const allMuted = new Map<string, boolean>();
  const anyLive = new Map<string, boolean>();
  const smAll = new Map<string, boolean>();
  const smAny = new Map<string, string | null>();
  const cams = new Map<string, string[]>();
  const anchorAv = new Map<string, string>();
  const anchorAvWatch = new Map<string, boolean>();
  for (const t of tiles) {
    const k = keyOf(t);
    if (!k || isShare(t)) continue;
    if (!members.has(k)) members.set(k, new Set());
    members.get(k)!.add(t.participant);
    const watcher = chipOf(t.participant, attrsOf(t.participant)) === "watch";
    if (watcher) chip.set(k, "watch");
    const mic = !t.muted && !watcher; // a watcher publishes nothing: never a live mic
    allMuted.set(k, (allMuted.get(k) ?? true) && !mic);
    anyLive.set(k, (anyLive.get(k) ?? false) || mic);
    // a watcher can't be muted by a moderator (nothing to mute; the server answers 409): it never decides "moderated"
    // (assembly-045 review: a muted computer + a watching phone read as "not muted", so the menu offered Mute)
    if (!watcher) {
      smAll.set(k, (smAll.get(k) ?? true) && !!t.serverMuted);
      if (t.serverMuted && !smAny.get(k)) smAny.set(k, t.serverMutedBy || "");
    }
    // the tile a person without a camera is shown by: their first NON-watcher avatar (moderation acts on the shown
    // tile's device; a watcher can only be disconnected), else their first avatar
    if (t.kind === "avatar" && (!anchorAv.has(k) || (anchorAvWatch.get(k) && !watcher))) {
      anchorAv.set(k, t.id);
      anchorAvWatch.set(k, watcher);
    }
    if (t.kind === "video") cams.set(k, [...(cams.get(k) ?? []), t.id]);
  }
  const selfCam = own && hasSelf ? tiles.find((t) => t.participant === "You" && t.kind === "video")?.id ?? "" : "";
  const shownCam = new Map<string, string>();
  for (const [k, ids] of cams) {
    const sorted = [...ids].sort();
    const p = pick.get(k);
    if (k === own && selfCam) shownCam.set(k, p && (p === selfCam || sorted.includes(p)) ? p : selfCam);
    else shownCam.set(k, p && sorted.includes(p) ? p : sorted[0]!);
  }
  const myCams = own && selfCam ? [selfCam, ...(cams.get(own) ?? [])] : [];
  const mineOf = (shown: string) => ({ alts: myCams.filter((x) => x !== shown).sort() });
  const base = (t: Tile): PersonTile => ({ ...t, members: [], pad: "", othersLive: false, alts: [], altOf: "", partlyMuted: false });
  const anchored = new Set<string>();
  const out: PersonTile[] = [];
  for (const t of tiles) {
    const myFields = () => ({ members: own && hasSelf ? [...(members.get(own) ?? [])].sort() : [], pad: (own && chip.get(own)) || "", othersLive: !!(own && anyLive.get(own)) } as const);
    if (t.participant === "You") {
      const shown = own ? shownCam.get(own) : undefined;
      if (shown && t.id === selfCam && shown !== selfCam) out.push({ ...base(t), ...myFields(), altOf: shown });
      else out.push({ ...base(t), ...myFields(), ...(t.id === selfCam && shown ? mineOf(selfCam) : {}) });
      continue;
    }
    const k = keyOf(t);
    if (!k || isShare(t)) {
      out.push(base(t));
      continue;
    }
    if (k === own && hasSelf) {
      if (t.kind === "avatar") continue; // my other device: on my self tile
      const shown = shownCam.get(own);
      if (selfCam && shown && t.kind === "video") {
        // one of MY cameras: shown in place of my self-view only when I picked it
        out.push(t.id === shown ? { ...base(t), ...myFields(), ...mineOf(shown) } : { ...base(t), altOf: shown });
        continue;
      }
      out.push(base(t));
      continue;
    }
    const cam = shownCam.get(k);
    if (cam) {
      if (t.kind === "avatar") continue;
      if (t.id !== cam) {
        out.push({ ...base(t), altOf: cam });
        continue;
      }
    } else if (t.kind !== "avatar" || anchored.has(k) || t.id !== anchorAv.get(k)) {
      if (t.kind === "avatar") continue; // another avatar of the same person (a watcher's when they have a computer)
      out.push(base(t));
      continue;
    }
    anchored.add(k);
    const m = [...(members.get(k) ?? [])].sort();
    const all = smAll.get(k) ?? false;
    const some = smAny.has(k);
    out.push({
      ...base(t),
      members: m.length > 1 ? m : [],
      pad: chip.get(k) ?? "",
      muted: allMuted.get(k) ?? t.muted,
      serverMuted: all,
      serverMutedBy: all || !t.serverMuted ? (t.serverMutedBy || smAny.get(k) || "") : t.serverMutedBy,
      partlyMuted: some && !all,
      alts: cam ? [...(cams.get(k) ?? [])].filter((x) => x !== cam).sort() : [],
    });
  }
  return out;
}

function ownMxid(identity: string): string {
  // my own identity is my own: its mxid is everything before the last ":<device>" (my device id never has a ':')
  const i = identity.lastIndexOf(":");
  return i > 0 ? identity.slice(0, i) : "";
}
