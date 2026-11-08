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
// Step B (12.1.10 / server 0.3.14): the phone's Mic and Camera modes — `tinhat.mode=mic` with `~pad-mic-<16 hex>`,
// `tinhat.mode=camera` with `~pad-cam-<16 hex>` (the server's identity.mjs PAD_SUFFIX_RE); a person's chips aggregate
// ("mic+camera"); a Camera-mode phone publishes no mic (like a watcher); a Pad camera is the person's shown camera unless
// the viewer picked another; my own other devices' microphones are never played here (playMicOf); and the call chimes
// are about PEOPLE, not devices (PersonChimes: a Pad connection of someone already in the call never chimes).
import type { Tile } from "./contract";

export type Attrs = Readonly<Record<string, string>> | undefined;
/** One device's Pad mode ("" = not a Pad connection). */
export type PadChip = "" | "watch" | "mic" | "camera";
/** A person's Pad modes, aggregated in this order and joined by "+" ("" = none): "watch", "mic+camera", … */
export type PadModes = string;
const PAD_ORDER: readonly PadChip[] = ["watch", "mic", "camera"];

// The server's identity.mjs MXID_RE, exactly (JavaScript's own \s, lengths in UTF-16 code units; the desktop spells the
// same set out: persontiles.rs). The device: identity.mjs DEVICE_RE ('+' and '/' for rust-sdk QR-login devices).
const MXID_RE = /^@[^:\s]{1,255}:(?:[A-Za-z0-9.-]{1,255}(?::\d{1,5})?|\[[0-9A-Fa-f:.]{2,45}\](?::\d{1,5})?)$/;
const DEVICE_PART_RE = /^[A-Za-z0-9_+/-]{1,64}(~watch-[0-9a-f]{16}|~pad-(?:mic|cam)-[0-9a-f]{16})?$/;
/** A Pad connection's suffix (Watch, Mic, Camera), by the identity alone. */
const PAD_SUFFIX_RE = /~(?:watch|pad-(?:mic|cam))-[0-9a-f]{16}$/;

/** The person the server vouches for (its mxid), or "" (nobody's). */
export function personOf(identity: string, attrs: Attrs): string {
  const p = attrs?.["tinhat.person"];
  if (typeof p !== "string" || !MXID_RE.test(p)) return "";
  if (!identity.startsWith(`${p}:`)) return "";
  return DEVICE_PART_RE.test(identity.slice(p.length + 1)) ? p : "";
}

/** The Pad chip of one participant ("" = none): the server's `tinhat.pad=phone` + a `tinhat.mode` whose identity suffix
 *  matches (watch ↔ `~watch-`, mic ↔ `~pad-mic-`, camera ↔ `~pad-cam-`); anything else, or an unknown mode, = none. */
export function chipOf(identity: string, attrs: Attrs): PadChip {
  if (!personOf(identity, attrs)) return "";
  if (attrs?.["tinhat.pad"] !== "phone") return "";
  const mode = attrs?.["tinhat.mode"];
  if (mode === "watch") return /~watch-[0-9a-f]{16}$/.test(identity) ? "watch" : "";
  if (mode === "mic") return /~pad-mic-[0-9a-f]{16}$/.test(identity) ? "mic" : "";
  if (mode === "camera") return /~pad-cam-[0-9a-f]{16}$/.test(identity) ? "camera" : "";
  return "";
}

/** A person's chips, aggregated: each mode once, in the order watch, mic, camera, joined by "+". */
export function padModesOf(chips: Iterable<PadChip>): PadModes {
  const set = new Set(chips);
  return PAD_ORDER.filter((c) => set.has(c)).join("+");
}

/** A device that publishes no microphone by its mode (a watcher, a Camera-mode phone): it never makes a live mic, never
 *  makes a person "not muted", and has nothing a moderator could mute. */
const noMic = (c: PadChip) => c === "watch" || c === "camera";

export type PersonTile = Tile & {
  members: string[];
  pad: PadModes;
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
  const chips = new Map<string, Set<PadChip>>();
  const camChip = new Map<string, PadChip>(); // camera tile id -> its device's chip
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
    const c = chipOf(t.participant, attrsOf(t.participant));
    if (c) chips.set(k, (chips.get(k) ?? new Set<PadChip>()).add(c));
    const watcher = noMic(c); // a watcher / a Camera-mode phone: no microphone
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
    if (t.kind === "video") {
      cams.set(k, [...(cams.get(k) ?? []), t.id]);
      camChip.set(t.id, c);
    }
  }
  const chip = new Map<string, PadModes>([...chips].map(([k, v]) => [k, padModesOf(v)]));
  // Step B: a Pad Camera-mode camera is the person's camera (an explicit choice), the lowest such tile id first
  const padCam = (ids: string[]) => ids.filter((x) => camChip.get(x) === "camera").sort()[0];
  const selfCam = own && hasSelf ? tiles.find((t) => t.participant === "You" && t.kind === "video")?.id ?? "" : "";
  const shownCam = new Map<string, string>();
  for (const [k, ids] of cams) {
    const sorted = [...ids].sort();
    const p = pick.get(k);
    if (k === own && selfCam) shownCam.set(k, p && (p === selfCam || sorted.includes(p)) ? p : padCam(sorted) ?? selfCam);
    else shownCam.set(k, p && sorted.includes(p) ? p : padCam(sorted) ?? sorted[0]!);
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

// ---- Step B: what is played, and the call chimes ---------------------------------------------------------------------

/** Is a remote MICROPHONE track of this participant played on this device? Not when it is one of MY other devices (the
 *  server vouches: tinhat.person = my mxid and the exact identity form) — my phone's mic in Mic mode must never come out
 *  of my own computer's speakers (a feedback loop). Everyone else's: yes. */
export function playMicOf(identity: string, attrs: Attrs, ownIdentity: string): boolean {
  const own = ownMxid(ownIdentity);
  return !(own && identity !== ownIdentity && personOf(identity, attrs) === own);
}

/** Whether this identity is a Pad connection (Watch, Mic, Camera), by the identity alone. */
export function isPadIdentity(identity: string): boolean {
  return PAD_SUFFIX_RE.test(identity);
}

/** The person a call chime is about: the server-vouched person (personOf); without it the identity's own mxid (a Pad
 *  suffix dropped, everything before the LAST ':' while that still holds a ':' — identity.ts mxidOf); else the identity. */
export function chimePerson(identity: string, attrs: Attrs): string {
  const p = personOf(identity, attrs);
  if (p) return p;
  const base = identity.replace(PAD_SUFFIX_RE, "");
  const i = base.lastIndexOf(":");
  if (i <= 0) return identity;
  const head = base.slice(0, i);
  return head.includes(":") ? head : identity;
}

/** How long a Pad connection's leave waits for the same person's next connection (a mode switch = leave + rejoin). */
export const PAD_LEAVE_GRACE_MS = 5_000;

/**
 * (2026-11-06: no join sound when someone already in the call joins on Pad.) The call chimes
 * follow PEOPLE: a join chimes only when that person had no connection in the call (me included: my own phone joining my
 * call never chimes), a leave only when their LAST connection goes. A Pad connection that was their last waits
 * PAD_LEAVE_GRACE_MS: their next connection in that time (the phone switching Watch → Mic, or Talk here) cancels both the
 * leave and the join chime. Pure: the engine passes the identities present (`present`, without the one that changed) and
 * the clock; `tick` returns how many leave chimes are due.
 */
export class PersonChimes {
  /** person -> when their held-back leave chime is due */
  pending = new Map<string, number>();
  /** leave chimes owed by people who came back only AFTER their grace (a late timer): tick plays them */
  owed = 0;

  join(identity: string, attrsOf: (id: string) => Attrs, present: readonly string[], now: number): "join" | "" {
    const p = chimePerson(identity, attrsOf(identity));
    const due = this.pending.get(p);
    if (due !== undefined) {
      this.pending.delete(p);
      if (now < due) return ""; // back within the grace: a switch, not a new arrival
      this.owed += 1; // back after it: their leave was real (owed to tick) and so is this arrival
      return "join";
    }
    return present.some((o) => o !== identity && chimePerson(o, attrsOf(o)) === p) ? "" : "join";
  }

  leave(identity: string, attrsOf: (id: string) => Attrs, present: readonly string[], now: number): "leave" | "" {
    const p = chimePerson(identity, attrsOf(identity));
    if (present.some((o) => o !== identity && chimePerson(o, attrsOf(o)) === p)) return "";
    if (isPadIdentity(identity)) {
      this.pending.set(p, now + PAD_LEAVE_GRACE_MS);
      return "";
    }
    return "leave";
  }

  /** The held-back leaves that are due: each person still away = one leave chime. */
  tick(attrsOf: (id: string) => Attrs, present: readonly string[], now: number): number {
    let n = this.owed;
    this.owed = 0;
    for (const [p, due] of [...this.pending]) {
      if (due > now) continue;
      this.pending.delete(p);
      if (!present.some((o) => chimePerson(o, attrsOf(o)) === p)) n++;
    }
    return n;
  }

  clear(): void {
    this.pending.clear();
    this.owed = 0;
  }
}

/**
 * Step B: the E2EE key identity a Pad Mic / Camera connection decrypts under. The phone announces its media key as its
 * DEVICE (Olm-verified, to-device: receivers install it under `<mxid>:<device>`), but its call connection is
 * `<mxid>:<device>~pad-<mic|cam>-<16 hex>`. A receiver also installs that device's keys under the Pad identity — only when
 * the server vouches for it (chipOf "mic" / "camera": tinhat.person = the mxid, the exact suffix), so nobody can borrow
 * another device's key. -> the base `<mxid>:<device>` whose keys apply, or "" (none: a normal / Watch / unvouched one).
 */
export function keyAliasBase(identity: string, attrs: Attrs): string {
  const c = chipOf(identity, attrs);
  if (c !== "mic" && c !== "camera") return "";
  return identity.replace(PAD_SUFFIX_RE, "");
}
