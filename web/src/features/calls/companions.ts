// companions.ts — screen-share companions folded into their person (screen share P3, receivers' half; share
// claude/tinhat-android/SCREEN-SHARE.md §4). The Android app shares the screen from its NATIVE device, which joins the
// call as a second participant of the same person with `dev.tinhat.client` `{…, "role": "share", "companion_of":
// "<the person's main call device>"}`. Receivers show that share as the person's own (no second avatar tile, no second
// name). Pure (no imports beyond types): unit-tested under Node (companions.test.ts), mirrored by the desktop's
// crates/app/src/companions.rs and the mobile core's rtc::companions (the same rule and the same vectors).
//
// The rule (mobile core rtc.rs `companions`, NATIVE.md "Screen-share companion"): a membership event whose content has
// `dev.tinhat.client.role == "share"` and a string `companion_of` that isn't its own `device_id`, where BOTH the
// companion and the named main are LIVE sessions of the SAME sender. An orphan (main gone) or a claim on someone else's
// device is left out: it shows as an ordinary participant, so it stays visible and can be dealt with. Plus the three
// hardenings of companions() below (also in the vectors; the mobile core doesn't have them yet).
import type { LiveSession, RawMemberEvent } from "./callrules";
import type { Tile } from "./contract";

type Content = Record<string, unknown>;

/** `[companion identity, main identity]` ("@user:server:DEVICE"), sorted, without duplicates. On top of the mobile
 *  core's rule (review hardenings, in the shared vectors): the marker must come from the companion's live session's
 *  OWN event (its state key), a companion naming two mains is none, and a main that is itself a companion folds
 *  nothing (no chains, no cycles: a member can't make all their tiles disappear). */
export function companions(events: readonly RawMemberEvent[], live: readonly Pick<LiveSession, "sender" | "deviceId" | "stateKey">[]): Array<[string, string]> {
  const session = (user: string, device: string) => live.find((s) => s.sender === user && s.deviceId === device);
  const mains = new Map<string, Set<string>>(); // companion identity → the mains it names
  for (const ev of events) {
    const sender = typeof ev?.sender === "string" ? ev.sender : "";
    const c = (ev?.content ?? null) as Content | null;
    if (!sender || !c || typeof c !== "object") continue;
    const device = c.device_id;
    const client = c["dev.tinhat.client"] as Content | undefined;
    if (typeof device !== "string" || !client || typeof client !== "object") continue;
    if (client.role !== "share") continue;
    const main = client.companion_of;
    if (typeof main !== "string" || main === device) continue;
    const own = session(sender, device);
    if (!own || own.stateKey !== ev.state_key || !session(sender, main)) continue;
    const id = `${sender}:${device}`;
    if (!mains.has(id)) mains.set(id, new Set());
    mains.get(id)!.add(`${sender}:${main}`);
  }
  const out: Array<[string, string]> = [];
  for (const [comp, set] of mains) {
    if (set.size !== 1) continue; // ambiguous
    const main = [...set][0];
    if (mains.has(main)) continue; // the main is itself a companion: a chain or a cycle
    out.push([comp, main]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** The self tile's participant ("You"): a companion of OUR OWN device folds into it. */
export const SELF_PARTICIPANT = "You";

/** Fold companions into their person on the call stage. `tiles` as the engine builds them (self first, then video
 *  tiles, then avatar tiles of people without a camera); `pairs` from companions(); `ownIdentity` = "@me:server:DEV".
 *  - a companion's avatar tile goes (it publishes only the screen; the person already has a tile);
 *  - its screen tile keeps its participant (the track lives there) and gains `companionOf` = the main participant
 *    ("You" for our own device) + the main's name, and moves right after the main's last tile;
 *  - anything else (no companion, an orphan, a companion whose main has no tile yet) is left as it was. */
export function foldCompanions(tiles: readonly Tile[], pairs: ReadonlyArray<readonly [string, string]>, ownIdentity: string): Tile[] {
  if (!pairs.length) return [...tiles];
  const mainOf = new Map<string, string>();
  for (const [comp, main] of pairs) mainOf.set(comp, main === ownIdentity ? SELF_PARTICIPANT : main);
  const nameOf = (main: string): string | null => {
    const t = tiles.find((x) => x.participant === main && !x.companionOf);
    return t ? t.name : null;
  };
  const kept: Tile[] = [];
  const moved: Tile[] = [];
  for (const t of tiles) {
    const main = mainOf.get(t.participant);
    const name = main ? nameOf(main) : null;
    if (!main || name === null) {
      kept.push(t);
      continue;
    }
    if (t.kind === "avatar") continue; // the person is on the stage already
    moved.push(t.kind === "screenshare" || t.screenshare ? { ...t, companionOf: main, name } : t);
  }
  for (const t of moved) {
    if (!t.companionOf) {
      kept.push(t);
      continue;
    }
    let at = -1;
    for (let i = 0; i < kept.length; i++) if (kept[i].participant === t.companionOf || kept[i].companionOf === t.companionOf) at = i;
    kept.splice(at + 1, 0, t);
  }
  return kept;
}

/** A stats row after the fold (foldPeers): a person may carry their companion's share as `share`; a companion of OUR
 *  OWN device stays its own row, marked `ownShare` ("Your screen"). */
export type FoldedPeer<T extends object> = T & { share?: T; ownShare?: boolean };

/** Call stats (screen share P3 follow-up, the Android interop's b1 note): fold a companion's row into its person's row,
 *  one row per person with the share's numbers as a sub-line. One share per main device (the apps start one per page):
 *  a second companion of the same main stays a row of its own. `peers` keyed by LiveKit identity (`idOf`), in the order
 *  they come; `pairs` from companions(); `ownIdentity` = "@me:server:DEV". A companion whose main has no row stays a
 *  row of its own (an ordinary participant, as on the stage); a companion of our own device stays a row, `ownShare`.
 *  The desktop's companions.rs `fold_peers` is the same rule with the same cases. */
export function foldPeers<T extends object>(peers: readonly T[], idOf: (p: T) => string, pairs: ReadonlyArray<readonly [string, string]>, ownIdentity: string): Array<FoldedPeer<T>> {
  if (!pairs.length) return peers.map((p) => ({ ...p }));
  const mainOf = new Map(pairs.map(([c, m]) => [c, m] as const));
  const ids = new Set(peers.map(idOf));
  const shareOf = new Map<string, T>();
  for (const p of peers) {
    const main = mainOf.get(idOf(p));
    if (main && main !== ownIdentity && ids.has(main) && !shareOf.has(main)) shareOf.set(main, p);
  }
  const folded = new Set([...shareOf.values()].map(idOf));
  const out: Array<FoldedPeer<T>> = [];
  for (const p of peers) {
    const id = idOf(p);
    if (folded.has(id)) continue;
    const row: FoldedPeer<T> = { ...p };
    const sh = shareOf.get(id);
    if (sh) row.share = sh;
    if (mainOf.get(id) === ownIdentity) row.ownShare = true;
    out.push(row);
  }
  return out;
}
