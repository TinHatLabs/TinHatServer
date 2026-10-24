// palette.ts — the Ctrl+K command palette over rooms, pending invites, people and actions (ACTIONS.md §10). Pure: the
// snapshot and the query in, the ranked entries out; the Rust port (crates/actions/src/palette.rs) reproduces every
// result byte for byte (the shared vectors palette/*.json).
//
// Portability rules (as in evaluate.ts): own keys only, strings compared by code point, case folded with the
// Unicode default lower-casing (String.prototype.toLowerCase / str::to_lowercase), word separators from the table,
// no locale functions, no regular expressions, stable sorts with explicit tie-breaks.
import type { JObj, Json } from "../layout/json";
import { get, has, isArr, isObj, isStr, obj } from "../layout/json";
import { cmpCodePoint } from "../theme/canon";
import type { Action, App, TargetKind } from "./table";
import { TABLE, actionById, reg } from "./table";
import type { Snapshot } from "./evaluate";
import { defaultKeys, present, subjectEntry } from "./evaluate";

// ---- folding and scoring --------------------------------------------------------------------------------------------

/** A word separator (the table's inclusive code-point ranges). */
export function isSep(cp: number): boolean {
  for (const [lo, hi] of TABLE.palette.separators) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** Lower-case, every separator run → one space, trimmed (ACTIONS.md §10.3). */
export function fold(s: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of s.toLowerCase()) {
    if (isSep(ch.codePointAt(0) as number)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function subsequence(q: string, t: string): boolean {
  const qs: string[] = [];
  for (const ch of q) if (ch !== " ") qs.push(ch);
  if (qs.length === 0) return false;
  let i = 0;
  for (const ch of t) {
    if (ch === " ") continue;
    if (ch === qs[i]) {
      i++;
      if (i === qs.length) return true;
    }
  }
  return false;
}

/** How well a folded text matches a folded, non-empty query as a NAME (ACTIONS.md §10.4): prefix > word start >
 *  every query word starts a word (two or more words) > substring > subsequence (only when `subseq`: room, invite,
 *  person and choice names — never an action's longer labels) > 0. */
export function nameTier(t: string, q: string, subseq = true): number {
  const T = TABLE.palette.tiers;
  if (t.length === 0 || q.length === 0) return 0;
  if (t.startsWith(q)) return T.prefix;
  if (t.includes(" " + q)) return T.wordStart;
  const qw = q.split(" ");
  if (qw.length > 1) {
    const tw = t.split(" ");
    if (qw.every((w) => tw.some((x) => x.startsWith(w)))) return T.words;
  }
  if (t.includes(q)) return T.substring;
  if (subseq && subsequence(q, t)) return T.subsequence;
  return 0;
}

/** How well a folded text matches as a KEYWORD (an action's keywords): prefix > word start > substring. */
export function keywordTier(t: string, q: string): number {
  const T = TABLE.palette.tiers;
  if (t.length === 0 || q.length === 0) return 0;
  if (t.startsWith(q)) return T.keywordPrefix;
  if (t.includes(" " + q)) return T.keywordWordStart;
  if (t.includes(q)) return T.keywordSubstring;
  return 0;
}

/** An ALIAS (a room's or an invite's address, a person's user id) contains the query → the alias tier. */
export function aliasTier(t: string, q: string): number {
  return t.length > 0 && q.length > 0 && t.includes(q) ? TABLE.palette.tiers.alias : 0;
}

// ---- entries --------------------------------------------------------------------------------------------------------

/** `invite` = a pending invite to a room or a DM (2026-09-28: Ctrl+K lists them again, ACTIONS.md §10.1). */
export type EntryKind = "invite" | "room" | "person" | "action" | "choice";

/** One candidate of the palette before ranking. */
export interface Entry {
  kind: EntryKind;
  /** room id (a room or an invite), user id, action id, or the chosen value */
  id: string;
  label: string;
  icon: string | null;
  /** the first default key of an action ("Ctrl+Shift+M"), null otherwise */
  hint: string | null;
  enabled: boolean;
  /** an action that opens its target picker (stage 2) */
  pick: boolean;
  /** an action's / a choice's toggle state (the theme in use, the layout in use …), null for invites, rooms and people */
  active: boolean | null;
  /** an emoji drawn as the glyph (a status preset), null otherwise */
  emoji: string | null;
  /** the action an action / choice entry runs (null for invites, rooms and people) */
  a: string | null;
  /** the target a choice runs its action with (null otherwise) */
  target: JObj | null;
  /** sorts after every entry without it: the room you are in, an unavailable action or choice */
  last: boolean;
  // ranking inputs (not part of the output)
  names: string[];
  /** names may match as a subsequence (rooms, invites, people, choices; not actions) */
  subseq: boolean;
  keywords: string[];
  aliases: string[];
  boost: number;
  index: number;
}

const strAt = (o: Json | undefined, k: string): string | undefined => {
  if (!isObj(o)) return undefined;
  const v = get(o, k);
  return isStr(v) ? v : undefined;
};
const valueOf = (e: JObj | undefined, n: string): Json | undefined => {
  const vals = e ? get(e, "values") : undefined;
  return isObj(vals) ? get(vals, n) : undefined;
};

/** The ids of one subject kind in the snapshot's list order (snapshot.lists.<list>, `list` defaulting to the kind;
 *  ids without a subject entry dropped, repeats dropped), else the subjects' ids in code-point order — in both cases
 *  only ids whose subject entry is an object. */
export function listOf(snap: Snapshot, kind: string, list: string = kind): string[] {
  const subj = isObj(get(snap, "subjects")) ? (get(snap, "subjects") as JObj) : undefined;
  const byKind = subj && isObj(get(subj, kind)) ? (get(subj, kind) as JObj) : undefined;
  const lists = get(snap, "lists");
  const l = isObj(lists) ? get(lists, list) : undefined;
  const out: string[] = [];
  if (isArr(l)) {
    for (const x of l) if (isStr(x) && byKind && isObj(get(byKind, x)) && !out.includes(x)) out.push(x);
    return out;
  }
  return byKind ? Object.keys(byKind).filter((k) => isObj(get(byKind, k))).sort(cmpCodePoint) : [];
}

/** Room subjects as palette entries: the JOINED rooms (`kind: "room"`, in `lists.room` order) or the pending INVITES
 *  (`kind: "invite"`: `room.invited` and not `room.joined`, in `lists.invite` order — the apps list them newest first).
 *  An invite is matched and ranked like a room: its name (the room list's), its address, the unread / DM boosts, and
 *  the room you are in sorts last (ACTIONS.md §10.4–§10.5). */
function roomLikeEntries(snap: Snapshot, kind: "room" | "invite"): Entry[] {
  const cur = strAt(get(snap, "current"), "room");
  const B = TABLE.palette.boosts;
  const out: Entry[] = [];
  for (const id of listOf(snap, "room", kind)) {
    const e = subjectEntry(snap, "room", id);
    if (kind === "room" ? valueOf(e, "room.joined") !== true : valueOf(e, "room.invited") !== true || valueOf(e, "room.joined") === true) continue;
    const name = strAt(e, "name") ?? id;
    const alias = strAt(e, "alias");
    const boost = (valueOf(e, "room.hasUnread") === true ? B.unread : 0) + (valueOf(e, "room.isDm") === true ? B.dm : 0);
    out.push({
      kind, id, label: name, icon: null, hint: null, enabled: true, pick: false, active: null, emoji: null,
      a: null, target: null, last: id === cur, names: [fold(name)], subseq: true, keywords: [], aliases: alias !== undefined ? [fold(alias)] : [],
      boost, index: out.length,
    });
  }
  return out;
}

function personEntries(snap: Snapshot): Entry[] {
  const out: Entry[] = [];
  for (const id of listOf(snap, "person")) {
    const e = subjectEntry(snap, "person", id);
    if (valueOf(e, "person.me") === true) continue;
    const name = strAt(e, "name") ?? id;
    out.push({
      kind: "person", id, label: name, icon: null, hint: null, enabled: true, pick: false, active: null, emoji: null,
      a: null, target: null, last: false, names: [fold(name)], subseq: true, keywords: [], aliases: [fold(id)], boost: 0, index: out.length,
    });
  }
  return out;
}

/** May this action be listed in the palette at all (ACTIONS.md §10.2)? */
export function inPalette(a: Action, app: App): boolean {
  return a.apps.includes(app) && !a.contexts && a.palette !== false && a.hold !== true && a.pending === undefined;
}

function actionEntries(app: App, snap: Snapshot): Entry[] {
  const groupRank = new Map(TABLE.groups.map((g, i) => [g.id, i]));
  const cands: { a: Action; k: string }[] = [];
  for (const a of TABLE.actions) if (inPalette(a, app)) cands.push({ a, k: fold(a.label) });
  // the catalogue order: group, then folded base label, then id
  cands.sort(
    (x, y) =>
      (groupRank.get(x.a.group) ?? 99) - (groupRank.get(y.a.group) ?? 99) || cmpCodePoint(x.k, y.k) || cmpCodePoint(x.a.id, y.a.id),
  );
  const out: Entry[] = [];
  for (const { a } of cands) {
    const p = present({ app, action: a.id, snapshot: snap });
    if (!p.visible) continue;
    const names = [fold(p.label)];
    if (p.shortLabel !== null) names.push(fold(p.shortLabel));
    if (p.label !== a.label) names.push(fold(a.label));
    const keywords = (a.keywords ?? []).map(fold);
    const keys = defaultKeys(a, app);
    out.push({
      kind: "action", id: a.id, label: p.label, icon: p.icon, hint: keys.length > 0 ? keys[0] : null,
      enabled: p.enabled, pick: p.pick, active: p.active, emoji: p.emoji, a: a.id, target: null, last: !p.enabled,
      names, subseq: false, keywords,
      aliases: [], boost: 0, index: out.length,
    });
  }
  return out;
}

/** The choices of stage 2 for an action whose target is picked (ACTIONS.md §10.6), or null when the action has
 *  nothing to pick here. */
export function choiceEntries(app: App, snap: Snapshot, id: string): Entry[] | null {
  const a = actionById(id);
  if (!a || !inPalette(a, app) || !a.target) return null;
  const spec = a.target;
  const kind = reg(TABLE.targetKinds, spec.kind) as TargetKind | undefined;
  if (!kind) return null;
  const values: { v: string; label: string; icon: string | null; key: string }[] = [];
  if (kind.stored && kind.key !== undefined && !kind.portable && spec.absent === "pick" && spec.pickable !== false) {
    // a device-local kind: this device's own subjects of the kind, in the picker's list (snapshot.lists.inputs /
    // outputs / cameras / audioSources — the target's picker, else the kind's)
    const subjectKind = kind.subject as string;
    for (const sid of listOf(snap, subjectKind, spec.picker ?? kind.picker ?? subjectKind)) {
      const e = subjectEntry(snap, subjectKind, sid);
      values.push({ v: sid, label: strAt(e, "name") ?? sid, icon: null, key: kind.key });
    }
  } else if (kind.stored && kind.key !== undefined && spec.absent === "pick" && spec.pickable !== false) {
    const key = kind.key;
    const vt = kind.value !== undefined ? reg(TABLE.valueTypes, kind.value) : undefined;
    const listed = spec.values ?? (vt && vt.values ? vt.values : undefined);
    const lab = (v: string) => {
      const l = spec.labels ? reg(spec.labels, v) : undefined;
      return isStr(l) ? l : undefined;
    };
    const ico = (v: string) => {
      const i = spec.icons ? reg(spec.icons, v) : undefined;
      return isStr(i) ? i : null;
    };
    if (listed) for (const v of listed) values.push({ v, label: lab(v) ?? v, icon: ico(v), key });
    if (kind.subject !== undefined && (!vt || !vt.values || vt.or !== undefined)) {
      const subjectKind = kind.subject;
      for (const sid of listOf(snap, subjectKind)) {
        const e = subjectEntry(snap, subjectKind, sid);
        if (subjectKind === "room" && valueOf(e, "room.joined") !== true) continue;
        if (subjectKind === "space" && valueOf(e, "space.joined") !== true) continue;
        if (subjectKind === "person" && valueOf(e, "person.me") === true) continue;
        values.push({ v: sid, label: strAt(e, "name") ?? sid, icon: null, key });
      }
    }
  } else if (spec.params) {
    // the first required enum param the action still needs (code-point order)
    for (const pk of Object.keys(spec.params).sort(cmpCodePoint)) {
      const ps = reg(spec.params, pk);
      if (!ps || ps.required !== true || ps.type !== "enum" || !ps.values) continue;
      for (const v of ps.values) {
        const l = ps.labels ? reg(ps.labels, v) : undefined;
        const i = ps.icons ? reg(ps.icons, v) : undefined;
        values.push({ v, label: isStr(l) ? l : v, icon: isStr(i) ? i : null, key: pk });
      }
      break;
    }
  }
  if (values.length === 0) return null;
  const out: Entry[] = [];
  for (const x of values) {
    const target = obj();
    target[x.key] = x.v;
    const p = present({ app, action: a.id, snapshot: snap, target, transient: true });
    if (!p.visible) continue;
    out.push({
      kind: "choice", id: x.v, label: x.label, icon: x.icon, hint: null, enabled: p.enabled, pick: false,
      active: p.active, emoji: p.emoji, a: a.id, target, last: !p.enabled, names: [fold(x.label)], subseq: true, keywords: [],
      aliases: x.label !== x.v ? [fold(x.v)] : [], boost: 0, index: out.length,
    });
  }
  return out;
}

// ---- ranking --------------------------------------------------------------------------------------------------------

/** An entry's score for a folded, non-empty query (0 = no match): the best of its name, keyword and alias tiers,
 *  plus its boost when it matched at all. */
export function scoreEntry(e: Entry, q: string): number {
  let best = 0;
  for (const n of e.names) best = Math.max(best, nameTier(n, q, e.subseq));
  for (const k of e.keywords) best = Math.max(best, keywordTier(k, q));
  for (const al of e.aliases) best = Math.max(best, aliasTier(al, q));
  return best > 0 ? best + e.boost : 0;
}

export interface PaletteItem {
  kind: EntryKind;
  id: string;
  label: string;
  icon: string | null;
  hint: string | null;
  enabled: boolean;
  pick: boolean;
  active: boolean | null;
  emoji: string | null;
  a: string | null;
  target: JObj | null;
  score: number;
}
export interface PaletteOut {
  /** all | room | person | action | stage */
  mode: string;
  /** the folded query the ranking used */
  query: string;
  /** the action being picked for (stage 2), else null */
  stage: string | null;
  /** matches before the maxResults cap */
  total: number;
  items: PaletteItem[];
}

/** Rank entries for a folded query (ACTIONS.md §10.5). Empty query: every entry, `last` ones after the rest, else in
 *  entry order. Else the entries with a score, by (last, score descending, kind order, entry order). */
export function rank(entries: Entry[], q: string): { total: number; items: PaletteItem[] } {
  const kindRank = (k: string) => {
    const i = TABLE.palette.kindOrder.indexOf(k);
    return i < 0 ? 99 : i;
  };
  const scored = entries.map((e) => ({ e, s: q.length === 0 ? 0 : scoreEntry(e, q) })).filter((x) => q.length === 0 || x.s > 0);
  scored.sort(
    (x, y) =>
      (x.e.last ? 1 : 0) - (y.e.last ? 1 : 0) ||
      y.s - x.s ||
      kindRank(x.e.kind) - kindRank(y.e.kind) ||
      x.e.index - y.e.index,
  );
  const max = TABLE.palette.maxResults;
  return {
    total: scored.length,
    items: scored.slice(0, max).map(({ e, s }) => ({
      kind: e.kind, id: e.id, label: e.label, icon: e.icon, hint: e.hint, enabled: e.enabled, pick: e.pick,
      active: e.active, emoji: e.emoji, a: e.a, target: e.target, score: s,
    })),
  };
}

/**
 * The palette (ACTIONS.md §10): `query` as typed; `stage` = the action id whose target is being picked (stage 2), or
 * absent. A leading prefix character (the table's `prefixes`: `>` actions, `@` people, `#` rooms and invites) limits
 * the kind. An empty query lists the pending invites, then the rooms (all / room mode, the room you are in last), the
 * people (person mode), every action (action mode: available ones first) or every choice (stage).
 */
export function palette(app: App, snap: Snapshot, query: string, stage?: string): PaletteOut {
  if (stage !== undefined) {
    const ch = choiceEntries(app, snap, stage) ?? [];
    const q = fold(query);
    const r = rank(ch, q);
    return { mode: "stage", query: q, stage, total: r.total, items: r.items };
  }
  let mode = "all";
  let rest = query;
  // leading spaces do not hide a prefix
  let i = 0;
  while (i < rest.length && rest[i] === " ") i++;
  const first = rest.slice(i, i + 1);
  const pm = first.length === 1 ? reg(TABLE.palette.prefixes, first) : undefined;
  if (pm !== undefined) {
    mode = pm;
    rest = rest.slice(i + 1);
  }
  const q = fold(rest);
  let entries: Entry[];
  if (mode === "room" || (mode === "all" && q.length === 0)) entries = [...roomLikeEntries(snap, "invite"), ...roomLikeEntries(snap, "room")];
  else if (mode === "person") entries = personEntries(snap);
  else if (mode === "action") entries = actionEntries(app, snap);
  else {
    // all kinds; every kind's own entry order, the kinds in kindOrder
    const all = [...roomLikeEntries(snap, "invite"), ...roomLikeEntries(snap, "room"), ...actionEntries(app, snap), ...personEntries(snap)];
    entries = all;
  }
  const r = rank(entries, q);
  return { mode, query: q, stage: null, total: r.total, items: r.items };
}

/** A plain JSON copy of an entry list without the ranking inputs (for the vectors of the entry builders). */
export function entriesOut(es: Entry[]): JObj[] {
  return es.map((e) => {
    const o = obj();
    o.kind = e.kind;
    o.id = e.id;
    o.label = e.label;
    o.icon = e.icon;
    o.hint = e.hint;
    o.enabled = e.enabled;
    o.pick = e.pick;
    o.active = e.active;
    o.emoji = e.emoji;
    o.a = e.a;
    o.target = e.target;
    o.last = e.last;
    return o;
  });
}

export { has };
