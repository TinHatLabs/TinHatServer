// model/reel.ts — port of games.rs roster_for / tonight / draw / game_json / compute: the snapshot
// the Game Reel UI renders (tw-spec §3.7), a pure function of the store read + presence + clock.
import {
  buildPool,
  cmpStr,
  effectiveSession,
  isAdhocSession,
  roster as rosterOf,
  creditDetail,
  deriveCredit,
  displayName,
  effectiveWinner,
  explain,
  explainSuperseded,
  explainVoided,
  respinsUsedIn,
  inPool,
  odds as oddsOf,
  recentWinners,
  resolveSession,
  round6,
  prefsFavorite,
  seedId,
  tonightCredits,
  weightsOver,
  spinnable,
  emptyPrefs,
  type Adjustment,
  type Badge,
  type CreditsMode,
  type GameWeight,
  type OddsVisibility,
  type Pool,
  type Prefs,
  type Resolved,
  type Roster,
  type Settings,
  type SpinRecord,
} from "./games";

export const WRITEBACK_FALLBACK_MS = 30_000;
export const LOG_LIMIT = 40;

export interface CatalogEntry {
  name: string;
  year: number;
  fetchedAt: number;
  ok: boolean;
}

export interface RoomData {
  me: string;
  myPl: number;
  canWrite: boolean;
  settings: Settings;
  prefs: Map<string, Prefs>;
  adjustments: Map<string, Adjustment>;
  spins: SpinRecord[];
  /** calendar events with a title, by state key */
  events: Map<string, Record<string, unknown>>;
  /** event id → [(user, status)] (non-empty status) in store order */
  rsvps: Map<string, Array<[string, string]>>;
  people: Map<string, { name: string; avatar: string }>;
  catalog: Map<string, CatalogEntry>;
  /** calendar.game contents with `slug` */
  calGames: Array<Record<string, unknown>>;
}

export interface ReelPerson {
  mxid: string;
  name: string;
  avatar: string;
  flexible: boolean;
  credit: number;
  hasPrefs: boolean;
}

export interface ReelGame {
  id: string;
  name: string;
  year: number;
  art: { portrait: string; header: string };
  tier: "main" | "stretch" | "removed";
  weight: number;
  odds: number;
  inReel: boolean;
  badges: Badge[];
  explain: string[];
  owners: string[];
  missing: string[];
  reason?: string;
  color?: unknown;
  server?: unknown;
}

export interface StripGame {
  id: string;
  name: string;
  art: { portrait: string; header: string };
  weight: number;
  odds: number;
}

export interface ReelSpin {
  id: string;
  seedEventId: string;
  winner: string | null;
  winnerName: string;
  claimedWinner: string | null;
  kind: string;
  vetoed: string[];
  vetoBy: Record<string, string>;
  by: string;
  byName: string;
  at: number;
  verified: boolean;
  superseded: false;
  voided: boolean;
  voidedBy?: string;
  voidReason?: string;
  note?: string;
  pool: StripGame[];
  roster: string[];
  late: string[];
  owners?: string[];
  respinsUsed: number;
  mySpinLost: boolean;
  settingsRev?: number;
  server?: unknown;
  color?: unknown;
  /** 10.5.2: false = this spin changes nobody's credit (free spin, or an admin's "Don't count for credit") */
  credit: boolean;
}

export interface LogLine {
  sessionId: string;
  title: string;
  date: number;
  spinId: string;
  at: number;
  winner: string | null;
  winnerName: string;
  by: string;
  byName: string;
  kind: string;
  vetoed: string[];
  present: string[];
  presentNames: string[];
  creditChanges: Array<{ mxid: string; name: string; delta: number; game: string; gameName: string }>;
  verified: boolean;
  voided: boolean;
  current: boolean;
  voidReason?: string;
  voidedBy?: string;
  note?: string;
  /** 10.5.2: the shown record counts for credit (false: a free spin / an admin's "Don't count for credit") */
  credit: boolean;
}

/** 10.5.2: one person in Tune's "Credit" list (everyone the reel knows: lists, adjustments, rosters). */
export interface CreditRow {
  mxid: string;
  name: string;
  /** banked regret credit as of now, tonight's result included (whatever credits.mode is) */
  credit: number;
  /** an admin adjustment is on top of it right now (the live set + delta) */
  offset: number;
  hasFavorite: boolean;
}

export interface Snapshot {
  /** 10.5.1: `adhoc` = tonight without a calendar event (`night-…` id; kind "adhoc", nothing to write back) */
  session: { id: string; title: string; start: number; end: number; kind: string; game: string; gameId: string; adhoc?: boolean } | null;
  /** `live` (10.5.1) = who is actually HERE (the header's "N here" + solid avatars): outside a call the
   * open roster is a preview of the RSVP'd + me, so only the viewer; `inCall` = the viewer is in a call */
  roster: { expected: ReelPerson[]; present: ReelPerson[]; flexible: string[]; maybes: string[]; here: number; expectedCount: number; presence: string; live?: string[]; inCall?: boolean };
  tiers: { main: ReelGame[]; stretch: ReelGame[]; removed: ReelGame[] };
  reel: string[];
  spin: ReelSpin | null;
  canSpin: boolean;
  canVeto: boolean;
  respinsLeft: number;
  myVetoesLeft: number;
  notice: string;
  onlyOption: string | null;
  log: LogLine[];
  names: Record<string, string>;
  me: string;
  isAdmin: boolean;
  featureEnabled: boolean;
  oddsVisibility: OddsVisibility;
  reelSettings: { durationMs: number; laps: number; minItems: number; maxItems: number; spinStretch: boolean };
  settingsRev: number;
  calendarWritten: boolean;
  computedAt: number;
  /** 10.5.2 settings credits.mode — "free": spins don't earn, spend or use credit */
  creditsMode: CreditsMode;
  /** 10.5.2: everyone's banked credit (Tune's "Credit" list), by name */
  credits: CreditRow[];
}

export interface Computed {
  snap: Snapshot;
  isAdmin: boolean;
  standing: SpinRecord | null;
  rosterActual: string[];
  writeback: [string, string] | null;
  writebackDue: number;
  canSpin: boolean;
  canVeto: boolean;
  respinsLeft: number;
  notice: string;
  /** the session this snapshot is about (the picked calendar event or tonight's ad-hoc id) */
  sessionId: string;
}

/** §2 / §6 roster.presence — the pure rule is games.ts `roster` (games_model.rs, 10.5.1 open roster). */
export function rosterFor(data: RoomData, sessionId: string, present: string[], s: Settings): Roster {
  return rosterOf(data.rsvps.get(sessionId) ?? [], present, data.me, data.prefs, s.roster_presence);
}

export interface Tonight {
  roster: Roster;
  credits: Map<string, number>;
  pool: Pool;
  names: Map<string, string>;
  resolved: Map<string, Resolved>;
  finalsAll: SpinRecord[];
  recentWinners: string[];
}

export function tonight(data: RoomData, sessionId: string, present: string[], s: Settings): Tonight {
  const roster = rosterFor(data, sessionId, present, s);
  const names = new Map<string, string>();
  for (const [k, v] of data.people) names.set(k, v.name);
  const bySession = new Map<string, SpinRecord[]>();
  for (const sp of data.spins) {
    let l = bySession.get(sp.session_id);
    if (!l) bySession.set(sp.session_id, (l = []));
    l.push(sp);
  }
  const resolved = new Map<string, Resolved>();
  const finalsAll: SpinRecord[] = [];
  for (const [sid, recs] of bySession) {
    const r = resolveSession(recs);
    if (r.final_id) {
      const f = recs.find((x) => x.id === r.final_id);
      if (f && !f.tampered) finalsAll.push(f);
    }
    resolved.set(sid, r);
  }
  finalsAll.sort((a, b) => b.ts - a.ts || cmpStr(b.id, a.id));
  const finalsPast = finalsAll.filter((x) => x.session_id !== sessionId);
  const recent = recentWinners(finalsPast, s);
  // 10.5.2 free spins: banked credit is neither earned, spent nor USED — tonight's draw weighs
  // nobody up (no "Lost last time, so it's weighted up", no +N badges)
  const credits = tonightCredits(roster.actual, data.prefs, finalsPast, data.adjustments, s);
  const pool = buildPool(roster.actual, data.prefs, s, names);
  return { roster, credits, pool, names, resolved, finalsAll, recentWinners: recent };
}

/** The weighted spinnable set minus `vetoed`, and the reel (weight desc, id asc; top max_items). */
export function draw(t: Tonight, data: RoomData, s: Settings, vetoed: string[]): [GameWeight[], Array<[string, number]>] {
  const ids = spinnable(t.pool, s).filter((g) => !vetoed.includes(g));
  const ws = weightsOver(ids, t.pool, t.roster.actual, data.prefs, t.credits, t.recentWinners, s);
  ws.sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0) || cmpStr(a.id, b.id));
  const reel: Array<[string, number]> = ws
    .filter((w) => w.weight > 0.0)
    .slice(0, Math.max(s.reel_max_items, 1))
    .map((w) => [w.id, round6(w.weight)]);
  return [ws, reel];
}

/** Percent-encode a game id for a path segment (`:` kept — games.rs enc). */
export function enc(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~:]/.test(c)) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export const artUrl = (base: string, id: string, kind: string) => `${base}/art/${encodeURIComponent(id)}/${kind}`;

export function fallbackName(id: string): string {
  if (id.startsWith("custom:")) {
    const slug = id.slice(7);
    let out = "";
    for (const word of slug.split(/[-_]/)) {
      if (!word) continue;
      const first = [...word][0];
      if (out) out += " ";
      out += first.toUpperCase() + word.slice(first.length);
    }
    if (out) return out;
  }
  if (id.startsWith("steam:")) return `Steam app ${id.slice(6)}`;
  return id;
}

export function gameName(data: RoomData, id: string): string {
  const c = data.catalog.get(id);
  return c && c.ok && c.name ? c.name : fallbackName(id);
}

function calGameFor(data: RoomData, id: string, name: string) {
  const lname = name.toLowerCase();
  return data.calGames.find((g) => g.catalogId === id) ?? data.calGames.find((g) => typeof g.name === "string" && g.name.toLowerCase() === lname);
}

export function compute(data: RoomData, base: string, pickedSession: string, present: string[], s: Settings, now: number): Computed {
  // 10.5.1: no calendar session tonight is no longer "Pick a session first." — the reel works on
  // tonight's ad-hoc session (`night-YYYY-MM-DD`), the same id on every client.
  const sessionId = effectiveSession(pickedSession, data.events.has(pickedSession), now);
  const adhoc = isAdhocSession(sessionId);
  const me = data.me;
  const isAdmin = data.myPl >= s.admin_min_pl;
  const t = tonight(data, sessionId, present, s);
  const names = t.names;
  const nameOf = (m: string) => displayName(names, m);

  const resolved = t.resolved.get(sessionId) ?? { chain: [], superseded: new Map(), final_id: null };
  const sessionRecords = data.spins.filter((x) => x.session_id === sessionId);
  const standing = resolved.final_id ? sessionRecords.find((x) => x.id === resolved.final_id) ?? null : null;
  let latestVoided: SpinRecord | null = null;
  if (!standing) for (const r of sessionRecords) if (r.voided && (!latestVoided || r.ts >= latestVoided.ts)) latestVoided = r;
  const vetoed = standing ? [...standing.vetoed] : [];
  const respinsUsed = respinsUsedIn(resolved.chain, sessionRecords);
  const respinsLeft = Math.max(s.veto_respin_limit - respinsUsed, 0);
  const myVetoes = standing ? Object.values(standing.veto_by).filter((v) => v === me).length : 0;

  const [ws, reel] = draw(t, data, s, vetoed);
  const odds = oddsOf(ws);
  const vis: OddsVisibility = isAdmin ? "full" : s.odds_visibility;
  const spinIds = ws.map((w) => w.id);
  const ctx = { pool: t.pool, present: t.roster.actual, prefs: data.prefs, credits: t.credits, names, settings: s, spinnable: spinIds };
  const entry = (id: string, tier: ReelGame["tier"], reason?: string): ReelGame => {
    const wi = ws.findIndex((w) => w.id === id);
    const w = wi >= 0 ? ws[wi] : null;
    const o = wi >= 0 ? odds[wi] : 0;
    const [ex, badges] = explain(ctx, id, w);
    const name = gameName(data, id);
    const full = vis === "full";
    const g: ReelGame = {
      id,
      name,
      year: data.catalog.get(id)?.year ?? 0,
      art: { portrait: artUrl(base, id, "portrait"), header: artUrl(base, id, "header") },
      tier,
      weight: round6(full ? w?.weight ?? 0 : 0),
      odds: round6(full ? o : 0),
      inReel: reel.some(([g2]) => g2 === id),
      badges: vis === "hidden" ? [] : badges,
      explain: ex,
      owners: t.pool.owners.get(id) ?? [],
      missing: t.pool.missing.get(id) ?? [],
    };
    if (reason !== undefined) g.reason = reason;
    const cg = calGameFor(data, id, name);
    if (cg) {
      g.color = cg.color ?? null;
      g.server = cg.server ?? null;
    }
    return g;
  };
  let main = ws.filter((w) => t.pool.main.includes(w.id)).map((w) => entry(w.id, "main"));
  let stretch = t.pool.stretch.filter((g) => !vetoed.includes(g)).map((g) => entry(g, "stretch"));
  if (s.pool_spin_stretch) stretch = ws.filter((w) => t.pool.stretch.includes(w.id)).map((w) => entry(w.id, "stretch"));
  const removed = t.pool.removed.map(([g, r]) => entry(g, "removed", r));
  for (const g of vetoed) {
    if (t.pool.main.includes(g) || t.pool.stretch.includes(g)) {
      const byM = standing?.veto_by[g];
      const reason = `${byM ? nameOf(byM) : "Someone"} vetoed it tonight.`;
      const v = entry(g, "removed", reason);
      v.explain = [reason];
      removed.push(v);
    }
  }
  main = main.filter((v) => !vetoed.includes(v.id));

  const here = t.roster.actual.length > 0;
  const imHere = t.roster.actual.includes(me);
  const sessionKnown = adhoc || data.events.has(sessionId);
  const nothingListed = t.pool.main.length === 0 && t.pool.stretch.length === 0 && t.pool.removed.length === 0;
  const onlyOption = reel.length === 1 && s.reel_min_items > 1 ? reel[0][0] : null;
  let notice = "";
  if (!s.feature_enabled) notice = "Game night is switched off.";
  else if (!sessionKnown) notice = "Pick a session first.";
  else if (!here) notice = "Nobody's here yet.";
  else if (reel.length === 0 && nothingListed) notice = "Nobody here has listed any games yet — add yours in My games.";
  else if (reel.length === 0) notice = t.pool.main.length === 0 && t.pool.stretch.length > 0 ? "No game everyone here owns — try the stretch tier." : "No game everyone here owns.";
  else if (reel.length < s.reel_min_items) notice = "Only one option tonight.";
  // unreachable with the default "open" roster (the viewer always counts); kept for the stricter modes
  else if (!imHere) notice = s.roster_presence === "call-only" || s.roster_presence === "open" ? "Join the call to spin." : "RSVP to the session to spin.";
  else if (!data.canWrite) notice = "Ask a space admin to open the flyout once — that unlocks spinning for everyone.";
  const canSpin = notice === "" && !standing;
  const canVeto = s.feature_enabled && data.canWrite && imHere && !!standing && effectiveWinner(standing) !== null && myVetoes < s.veto_post_spin_per_person && respinsLeft > 0;

  let raceNote: string | undefined;
  if (resolved.chain.length && resolved.superseded.size > 0) {
    const firstRec = sessionRecords.find((x) => x.id === resolved.chain[0]);
    if (firstRec) raceNote = explainSuperseded(nameOf(firstRec.sender));
  }
  const mySpinLost = [...resolved.superseded.keys()].some((id) => sessionRecords.some((x) => x.id === id && x.sender === me));
  const stripOf = (sp: SpinRecord): StripGame[] => {
    let total = 0;
    for (const [, w] of sp.pool) total += w;
    return sp.pool.map(([id, w]) => ({ id, name: gameName(data, id), art: { portrait: artUrl(base, id, "portrait"), header: artUrl(base, id, "header") }, weight: w, odds: total > 0 ? round6(w / total) : 0 }));
  };
  let spin: ReelSpin | null = null;
  if (standing) {
    const winner = effectiveWinner(standing);
    spin = {
      id: standing.id,
      seedEventId: seedId(standing),
      winner,
      winnerName: winner ? gameName(data, winner) : "",
      claimedWinner: standing.winner,
      kind: standing.kind,
      vetoed: standing.vetoed,
      vetoBy: standing.veto_by,
      by: standing.sender,
      byName: nameOf(standing.sender),
      at: standing.ts,
      verified: standing.verified,
      superseded: false,
      voided: false,
      pool: stripOf(standing),
      roster: standing.roster,
      late: standing.late,
      owners: winner ? t.pool.owners.get(winner) ?? [] : [],
      respinsUsed,
      mySpinLost,
      settingsRev: standing.settings_rev,
      credit: standing.credit,
    };
    if (raceNote) spin.note = raceNote;
    if (winner) {
      const cg = calGameFor(data, winner, gameName(data, winner));
      if (cg) {
        spin.server = cg.server ?? null;
        spin.color = cg.color ?? null;
      }
    }
  } else if (latestVoided) {
    const vd = latestVoided.voided ?? { by: "", reason: "", at: 0 };
    const w = effectiveWinner(latestVoided);
    spin = {
      id: latestVoided.id,
      seedEventId: seedId(latestVoided),
      winner: w,
      winnerName: w ? gameName(data, w) : "",
      claimedWinner: latestVoided.winner,
      kind: latestVoided.kind,
      vetoed: latestVoided.vetoed,
      vetoBy: latestVoided.veto_by,
      by: latestVoided.sender,
      byName: nameOf(latestVoided.sender),
      at: latestVoided.ts,
      verified: latestVoided.verified,
      superseded: false,
      voided: true,
      voidedBy: vd.by,
      voidReason: vd.reason,
      note: explainVoided(nameOf(vd.by), vd.reason),
      pool: stripOf(latestVoided),
      roster: latestVoided.roster,
      late: latestVoided.late,
      respinsUsed,
      mySpinLost,
      credit: latestVoided.credit,
    };
  }

  const sessionEv = data.events.get(sessionId);
  let writeback: [string, string] | null = null;
  let writebackDue = 0;
  if (standing && sessionEv) {
    const w = effectiveWinner(standing);
    if (w && !standing.tampered && sessionEv.gameId !== w) {
      writeback = [w, gameName(data, w)];
      writebackDue = standing.ts + WRITEBACK_FALLBACK_MS;
    }
  }

  // ---- log ----
  const latestTs = (sid: string) => data.spins.filter((x) => x.session_id === sid).reduce((m, x) => Math.max(m, x.ts), 0);
  const sessions = [...t.resolved.entries()].sort((a, b) => latestTs(b[0]) - latestTs(a[0]));
  const log: LogLine[] = [];
  for (const [sid, res] of sessions.slice(0, LOG_LIMIT)) {
    const recs = data.spins.filter((x) => x.session_id === sid);
    const fin = res.final_id ? recs.find((x) => x.id === res.final_id) ?? null : null;
    let latest: SpinRecord | null = null;
    for (const r of recs) if (!latest || r.ts >= latest.ts) latest = r;
    const shown = fin ?? latest;
    if (!shown) continue;
    const ev = data.events.get(sid);
    const title = typeof ev?.title === "string" ? ev.title : "";
    const evStart = typeof ev?.start === "number" && ev.start > 0 ? ev.start : 0;
    const winner = effectiveWinner(shown);
    const creditChanges: LogLine["creditChanges"] = [];
    if (fin) {
      const i = t.finalsAll.findIndex((x) => x.id === fin.id);
      if (i >= 0) {
        for (const p of fin.roster) {
          if (fin.flexible.includes(p)) continue;
          const fav = Object.prototype.hasOwnProperty.call(fin.favorites, p) ? fin.favorites[p] : undefined;
          if (fav === undefined || !inPool(fin, fav)) continue;
          const then: Prefs = { ...emptyPrefs(), favorites: [fav] };
          const before = deriveCredit(p, t.finalsAll.slice(i + 1), then, s, null);
          const after = deriveCredit(p, t.finalsAll.slice(i), then, s, null);
          if (after !== before) creditChanges.push({ mxid: p, name: nameOf(p), delta: after - before, game: fav, gameName: gameName(data, fav) });
        }
      }
    }
    const line: LogLine = {
      sessionId: sid,
      title,
      date: evStart || shown.ts,
      spinId: shown.id,
      at: shown.ts,
      winner,
      winnerName: winner ? gameName(data, winner) : "",
      by: shown.sender,
      byName: nameOf(shown.sender),
      kind: shown.kind,
      vetoed: shown.vetoed,
      present: shown.roster,
      presentNames: shown.roster.map(nameOf),
      creditChanges,
      verified: shown.verified,
      voided: !fin && !!shown.voided,
      current: sid === sessionId,
      credit: shown.credit,
    };
    if (shown.voided) {
      line.voidReason = shown.voided.reason;
      line.voidedBy = shown.voided.by;
      line.note = explainVoided(nameOf(shown.voided.by), shown.voided.reason);
    }
    log.push(line);
  }

  // ---- 10.5.2: everyone's banked credit (Tune's "Credit" list) — free mode doesn't change it. As of
  // NOW, tonight's result included (tonight's draw weighs with the credit from before it — `credits`),
  // so an admin sees what tonight's spin did and can undo it ----
  const known = new Set<string>([...data.prefs.keys(), ...data.adjustments.keys()]);
  for (const sp of data.spins) for (const p of sp.roster) known.add(p);
  const credits: CreditRow[] = [...known]
    .filter((m) => m.startsWith("@"))
    .map((m) => {
      const pr = data.prefs.get(m) ?? emptyPrefs();
      const adj = data.adjustments.get(m) ?? null;
      const d = creditDetail(m, t.finalsAll, pr, s, adj);
      return { mxid: m, name: nameOf(m), credit: d.credit, offset: adj && d.offsetLive ? (adj.set ?? 0) + adj.delta : 0, hasFavorite: prefsFavorite(pr) !== undefined };
    })
    .sort((a, b) => cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) || cmpStr(a.mxid, b.mxid));

  const person = (m: string): ReelPerson => ({
    mxid: m,
    name: nameOf(m),
    avatar: data.people.get(m)?.avatar ?? "",
    flexible: t.roster.flexible.includes(m),
    credit: t.credits.get(m) ?? 0,
    hasPrefs: data.prefs.has(m),
  });
  const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const num = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  const namesObj: Record<string, string> = {};
  for (const [k, v] of names) namesObj[k] = v;
  const adhocWinner = adhoc && standing ? effectiveWinner(standing) : null;
  // 10.5.1: who is actually here (games.rs compute `live`) — outside a call the open roster is a preview
  const inCall = present.some((p) => p.startsWith("@"));
  const live = s.roster_presence === "open" && !inCall ? t.roster.actual.filter((p) => p === me) : [...t.roster.actual];
  const snap: Snapshot = {
    session: adhoc
      ? { id: sessionId, title: "", start: 0, end: 0, kind: "adhoc", adhoc: true, game: adhocWinner ? gameName(data, adhocWinner) : "", gameId: adhocWinner ?? "" }
      : sessionEv
        ? { id: sessionId, title: str(sessionEv.title), start: num(sessionEv.start), end: num(sessionEv.end), kind: str(sessionEv.kind, "session"), game: str(sessionEv.game), gameId: str(sessionEv.gameId) }
        : null,
    roster: {
      expected: t.roster.expected.map(person),
      present: t.roster.actual.map(person),
      flexible: t.roster.flexible,
      maybes: t.roster.maybes,
      here: t.roster.actual.length,
      expectedCount: t.roster.expected.length,
      presence: s.roster_presence,
      live,
      inCall,
    },
    tiers: { main, stretch, removed },
    reel: reel.map(([id]) => id),
    spin,
    canSpin,
    canVeto,
    respinsLeft,
    myVetoesLeft: Math.max(s.veto_post_spin_per_person - myVetoes, 0),
    notice,
    onlyOption,
    log,
    names: namesObj,
    me,
    isAdmin,
    featureEnabled: s.feature_enabled,
    oddsVisibility: vis,
    reelSettings: { durationMs: s.reel_duration_ms, laps: s.reel_laps, minItems: s.reel_min_items, maxItems: s.reel_max_items, spinStretch: s.pool_spin_stretch },
    settingsRev: s.rev,
    calendarWritten: !writeback && !!standing,
    computedAt: now,
    creditsMode: s.credits_mode,
    credits,
  };
  return { snap, isAdmin, standing, rosterActual: t.roster.actual, writeback, writebackDue, canSpin, canVeto, respinsLeft, notice, sessionId };
}
