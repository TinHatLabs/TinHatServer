// polls.ts — the Polls widget's and the poll card's shared logic (contract WIDGETS.md §17, vectors
// testvectors/widgets/polls/*): MSC3381 polls as Element sends and reads them — `m.poll.start` / `m.poll.response` /
// `m.poll.end` and their `org.matrix.msc3381.*` names — read from every shape in use (the unstable v1 blocks Element
// sends, the spec's `m.poll` / `m.selections` / `m.text` arrays), written in the shape Element sends; the tally (the
// latest valid response per person on or before the first permitted end), the disclosure rule, the lines the card and
// the widget show, and the end message. Pure; the desktop's Rust port (crates/widgets/src/polls.rs) runs the same
// vectors (strings compared and cut in code points, whitespace ASCII only, numbers as doubles).

/** A poll offers at most this many answers (the first 20 are read; the dialog offers 20). */
export const ANSWERS_MAX = 20;
/** The New poll dialog's limits (code points): the question and each answer. */
export const QUESTION_MAX = 340;
export const ANSWER_MAX = 340;

export const START_TYPES = ["m.poll.start", "org.matrix.msc3381.poll.start"] as const;
export const RESPONSE_TYPES = ["m.poll.response", "org.matrix.msc3381.poll.response"] as const;
export const END_TYPES = ["m.poll.end", "org.matrix.msc3381.poll.end"] as const;
/** What we send (Element's names: it reads these, and the stable names too). */
export const START_TYPE = "org.matrix.msc3381.poll.start";
export const RESPONSE_TYPE = "org.matrix.msc3381.poll.response";
export const END_TYPE = "org.matrix.msc3381.poll.end";
const TEXT = "org.matrix.msc1767.text";
const DISCLOSED = ["m.disclosed", "m.poll.disclosed", "org.matrix.msc3381.poll.disclosed"];
const REFERENCE = ["m.reference", "org.matrix.msc3267.reference"];

export type PollKind = "disclosed" | "undisclosed";
export interface PollAnswer {
  id: string;
  text: string;
}
export interface Poll {
  question: string;
  kind: PollKind;
  /** how many answers one person may pick (1 = a single choice) */
  max: number;
  answers: PollAnswer[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isWs = (c: string) => c === " " || (c >= "\t" && c <= "\r");

/** Trim ASCII whitespace (U+0009–U+000D, U+0020) at both ends. */
export function trimAscii(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s[a]!)) a++;
  while (b > a && isWs(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** Code-point order (= UTF-8 byte order), not UTF-16 units. */
export function cmpStr(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i]!.codePointAt(0)!;
    const q = y[i]!.codePointAt(0)!;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

function plainOf(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const r of list) {
    if (!isObj(r) || typeof r.body !== "string") continue;
    if (r.mimetype === undefined || r.mimetype === "text/plain") return r.body;
  }
  return null;
}

/**
 * The plain text of a content block, the first of: `m.text` (a string, or the spec's array of {body, mimetype?} — the
 * first plain one), `org.matrix.msc1767.text` (a string), `m.message` / `org.matrix.msc1767.message` (arrays as above),
 * `body` (a string). ASCII-trimmed; "" or none → null.
 */
export function textOf(block: unknown): string | null {
  if (!isObj(block)) return null;
  const pick = (): string | null => {
    const mt = block["m.text"];
    if (typeof mt === "string") return mt;
    const a = plainOf(mt);
    if (a !== null) return a;
    if (typeof block[TEXT] === "string") return block[TEXT] as string;
    const b = plainOf(block["m.message"]) ?? plainOf(block["org.matrix.msc1767.message"]);
    if (b !== null) return b;
    return typeof block.body === "string" ? block.body : null;
  };
  const t = pick();
  if (t === null) return null;
  const s = trimAscii(t);
  return s ? s : null;
}

/**
 * A poll start → the poll, or null (not a poll start, or one this app refuses; the card then isn't shown).
 * The poll block: `m.poll` (spec), else `m.poll.start`, else `org.matrix.msc3381.poll.start` — the first that is an
 * object. The question: textOf(block.question), required. The kind: disclosed for `m.disclosed`, `m.poll.disclosed`,
 * `org.matrix.msc3381.poll.disclosed`, anything else undisclosed. The answers: an array; its first 20 items must each be
 * an object with an id (`m.id`, else `id`: a string of 1–100 code points) and a text (textOf), ids all different, at
 * least one — else null. max: `max_selections` a finite number ≥ 1 → floored and at most the answer count, else 1.
 */
export function readStart(type: unknown, content: unknown): Poll | null {
  if (typeof type !== "string" || !(START_TYPES as readonly string[]).includes(type) || !isObj(content)) return null;
  const block = [content["m.poll"], content["m.poll.start"], content["org.matrix.msc3381.poll.start"]].find(isObj);
  if (!block) return null;
  const question = textOf(block.question);
  if (question === null) return null;
  const kind: PollKind = typeof block.kind === "string" && DISCLOSED.includes(block.kind) ? "disclosed" : "undisclosed";
  if (!Array.isArray(block.answers)) return null;
  const answers: PollAnswer[] = [];
  const ids = new Set<string>();
  for (const a of block.answers.slice(0, ANSWERS_MAX)) {
    if (!isObj(a)) return null;
    const id = typeof a["m.id"] === "string" ? a["m.id"] : a.id;
    if (typeof id !== "string") return null;
    const n = [...id].length;
    if (n < 1 || n > 100 || ids.has(id)) return null;
    const text = textOf(a);
    if (text === null) return null;
    ids.add(id);
    answers.push({ id, text });
  }
  if (answers.length === 0) return null;
  const m = block.max_selections;
  const max = typeof m === "number" && Number.isFinite(m) && m >= 1 ? Math.min(Math.floor(m), answers.length) : 1;
  return { question, kind, max, answers };
}

function refOf(content: Record<string, unknown>): string | null {
  const rel = content["m.relates_to"];
  if (!isObj(rel) || typeof rel.rel_type !== "string" || !REFERENCE.includes(rel.rel_type)) return null;
  const e = rel.event_id;
  return typeof e === "string" && e.startsWith("$") ? e : null;
}

/**
 * A poll response → {start, answers}, or null (not a response: another type, no reference to a "$…" event). `answers`
 * = the selections — `m.selections` (spec), else `m.poll.response`.answers, else `org.matrix.msc3381.poll.response`
 * .answers — when that is an array of strings; anything else → null (a spoiled response: it still replaces the
 * person's earlier one and counts as no vote).
 */
export function readResponse(type: unknown, content: unknown): { start: string; answers: string[] | null } | null {
  if (typeof type !== "string" || !(RESPONSE_TYPES as readonly string[]).includes(type) || !isObj(content)) return null;
  const start = refOf(content);
  if (start === null) return null;
  const blockOf = (k: string) => (isObj(content[k]) ? (content[k] as Record<string, unknown>).answers : undefined);
  const sel = "m.selections" in content ? content["m.selections"] : isObj(content["m.poll.response"]) ? blockOf("m.poll.response") : blockOf("org.matrix.msc3381.poll.response");
  const answers = Array.isArray(sel) && sel.every((x) => typeof x === "string") ? (sel as string[]) : null;
  return { start, answers };
}

/** A poll end → {start}, or null (another type, no reference to a "$…" event). */
export function readEnd(type: unknown, content: unknown): { start: string } | null {
  if (typeof type !== "string" || !(END_TYPES as readonly string[]).includes(type) || !isObj(content)) return null;
  const start = refOf(content);
  return start === null ? null : { start };
}

export interface PollEvent {
  id: string;
  type: string;
  sender: string;
  ts: number;
  content: unknown;
}

export interface Tally {
  /** a permitted end arrived */
  ended: boolean;
  /** the earliest permitted end's ts (null while open) */
  endTs: number | null;
  /** every answer's count, in answer order */
  counts: { id: string; n: number }[];
  /** people with a valid vote */
  votes: number;
  /** my valid selection (answer ids in the order I picked them; [] = none) */
  mine: string[];
  /** the answers with the most votes (answer order), none when nobody voted */
  winners: string[];
}

/**
 * The tally of `poll` (started by `creator`) from `events` (any events: the responses and ends that reference `start`
 * are used; others are ignored; each event id once — the first wins):
 * 1. The end: the earliest end (ts, then id) whose sender is the creator or in `enders` (the people the app says may
 *    redact the start event — Element's rule); none → open.
 * 2. Responses on or before that end's ts (all while open); per sender the latest (ts, then the greater id wins).
 * 3. That response counts when its answers are a non-empty list of the poll's ids: repeats dropped (the first stays),
 *    cut to `max`; otherwise it is spoiled (that person has no vote — an earlier valid one doesn't come back).
 */
export function tally(poll: Poll, start: string, creator: string, events: readonly unknown[], enders: readonly string[], me: string): Tally {
  const seen = new Set<string>();
  let end: { ts: number; id: string } | null = null;
  const latest = new Map<string, { ts: number; id: string; answers: string[] | null }>();
  const rs: { sender: string; ts: number; id: string; answers: string[] | null }[] = [];
  for (const e of events) {
    if (!isObj(e)) continue;
    const { id, type, sender, ts } = e;
    if (typeof id !== "string" || !id || seen.has(id) || typeof sender !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) continue;
    seen.add(id);
    const en = readEnd(type, e.content);
    if (en) {
      if (en.start === start && (sender === creator || enders.includes(sender)) && (!end || ts < end.ts || (ts === end.ts && cmpStr(id, end.id) < 0))) end = { ts, id };
      continue;
    }
    const r = readResponse(type, e.content);
    if (r && r.start === start) rs.push({ sender, ts, id, answers: r.answers });
  }
  for (const r of rs) {
    if (end && r.ts > end.ts) continue;
    const cur = latest.get(r.sender);
    if (!cur || r.ts > cur.ts || (r.ts === cur.ts && cmpStr(r.id, cur.id) > 0)) latest.set(r.sender, r);
  }
  const valid = new Set(poll.answers.map((a) => a.id));
  const counts = new Map<string, number>(poll.answers.map((a) => [a.id, 0]));
  let votes = 0;
  let mine: string[] = [];
  for (const [sender, r] of latest) {
    const pick = choiceOf(poll, r.answers, valid);
    if (!pick) continue;
    votes++;
    for (const a of pick) counts.set(a, counts.get(a)! + 1);
    if (sender === me) mine = pick;
  }
  const list = poll.answers.map((a) => ({ id: a.id, n: counts.get(a.id)! }));
  const top = Math.max(0, ...list.map((c) => c.n));
  return { ended: end !== null, endTs: end ? end.ts : null, counts: list, votes, mine, winners: top > 0 ? list.filter((c) => c.n === top).map((c) => c.id) : [] };
}

function choiceOf(poll: Poll, answers: string[] | null, valid: Set<string>): string[] | null {
  if (!answers || answers.length === 0) return null;
  const out: string[] = [];
  for (const a of answers) {
    if (!valid.has(a)) return null;
    if (!out.includes(a)) out.push(a);
  }
  return out.slice(0, poll.max);
}

/** The disclosure rule: results (counts, bars, winners) show once the poll has ended, or — disclosed polls — once I voted. */
export function showResults(poll: Poll, t: Tally): boolean {
  return t.ended || (poll.kind === "disclosed" && t.mine.length > 0);
}

/** "1 vote" / "<n> votes" (an answer's votes on the card; the status line's count). */
export const votesText = (n: number): string => (n === 1 ? "1 vote" : `${n} votes`);

/**
 * The card's status line: ended → "No votes were cast" / "Final result based on <n votes>"; open + disclosed → I voted:
 * "Based on <n votes>", else "No votes yet" / "<n votes> cast · vote to see the results"; open + undisclosed →
 * "Results will be visible when the poll ends" (+ " · you voted" once I did).
 */
export function statusLine(poll: Poll, t: Tally): string {
  if (t.ended) return t.votes === 0 ? "No votes were cast" : `Final result based on ${votesText(t.votes)}`;
  if (poll.kind === "disclosed") {
    if (t.mine.length > 0) return `Based on ${votesText(t.votes)}`;
    return t.votes === 0 ? "No votes yet" : `${votesText(t.votes)} cast · vote to see the results`;
  }
  return `Results will be visible when the poll ends${t.mine.length > 0 ? " · you voted" : ""}`;
}

/** An answer's share for its bar, in whole per mille of the votes (0 when nobody voted): r(n × 1000 / votes). */
export function sharePm(n: number, votes: number): number {
  if (!(votes > 0) || !(n > 0)) return 0;
  return Math.floor((n * 1000) / votes + 0.5);
}

/** The card's head after "POLL": "Ended"; an open undisclosed poll "Results hidden until it ends"; an open poll that
 *  allows several answers "Pick up to <max>"; else "". */
export function stateLine(poll: Poll, t: Tally): string {
  if (t.ended) return "Ended";
  if (poll.kind === "undisclosed") return "Results hidden until it ends";
  return poll.max > 1 ? `Pick up to ${poll.max}` : "";
}

/** The widget row's second line: "Ended" is never shown (open polls only); "<n votes> · you voted" / "<n votes> · vote" for
 *  disclosed polls; "Results hidden until it ends · you voted" / "… · vote" for undisclosed ones. */
export function rowLine(poll: Poll, t: Tally): string {
  const you = t.mine.length > 0 ? "you voted" : "vote";
  return poll.kind === "disclosed" ? `${votesText(t.votes)} · ${you}` : `Results hidden until it ends · ${you}`;
}

/** The Small / collapsed line: "No open polls"; "1 open poll · <question>"; "<n> open polls · latest: <question>". */
export function pollsSummary(open: number, latest: string): string {
  if (open <= 0) return "No open polls";
  if (open === 1) return latest ? `1 open poll · ${latest}` : "1 open poll";
  return latest ? `${open} open polls · latest: ${latest}` : `${open} open polls`;
}

/** Names joined for the end message: "A"; "A and B"; "A, B and C"; "A, B, C and <n> others". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - 3;
  return `${names.slice(0, 3).join(", ")} and ${rest === 1 ? "1 other" : `${rest} others`}`;
}

/** The end message (the end event's text, what Element writes): "The poll has ended. Top answer: <winners>" /
 *  "The poll has ended. No votes were cast." */
export function endText(poll: Poll, t: Tally): string {
  if (t.winners.length === 0) return "The poll has ended. No votes were cast.";
  const text = (id: string) => poll.answers.find((a) => a.id === id)?.text ?? "";
  return `The poll has ended. Top answer: ${joinNames(t.winners.map(text))}`;
}

// ---- writing (the shapes Element sends) -------------------------------------------------------------------------------

/**
 * The New poll dialog's input → the start event's content, or an error: the question and answers ASCII-trimmed, empty
 * answers dropped; question 1–340 code points (E_QUESTION), 2–20 answers (E_ANSWERS) of at most 340 (E_ANSWER_LONG);
 * `ids` = one fresh id per kept answer (the app draws them from its CSPRNG); max 1 (a single choice).
 * Content: `org.matrix.msc3381.poll.start` {question {org.matrix.msc1767.text, body, msgtype m.text}, kind, max_selections,
 * answers [{id, org.matrix.msc1767.text}]} + `org.matrix.msc1767.text` "<question>\n1. <a>\n2. <b>…" (the fallback).
 */
export function startContent(
  question: string,
  answers: readonly string[],
  kind: PollKind,
  ids: readonly string[],
): { ok: true; content: Record<string, unknown> } | { ok: false; code: "E_QUESTION" | "E_ANSWERS" | "E_ANSWER_LONG"; message: string } {
  const q = trimAscii(question);
  const qn = [...q].length;
  if (qn < 1 || qn > QUESTION_MAX) return { ok: false, code: "E_QUESTION", message: qn < 1 ? "Ask a question" : "The question is too long — 340 characters at most" };
  const as = answers.map(trimAscii).filter((a) => a.length > 0);
  if (as.length < 2 || as.length > ANSWERS_MAX) return { ok: false, code: "E_ANSWERS", message: as.length < 2 ? "Add at least 2 answers" : "20 answers at most" };
  if (as.some((a) => [...a].length > ANSWER_MAX)) return { ok: false, code: "E_ANSWER_LONG", message: "An answer is too long — 340 characters at most" };
  if (ids.length < as.length) return { ok: false, code: "E_ANSWERS", message: "Add at least 2 answers" };
  return {
    ok: true,
    content: {
      [START_TYPE]: {
        question: { [TEXT]: q, body: q, msgtype: "m.text" },
        kind: kind === "disclosed" ? "org.matrix.msc3381.poll.disclosed" : "org.matrix.msc3381.poll.undisclosed",
        max_selections: 1,
        answers: as.map((a, i) => ({ id: ids[i]!, [TEXT]: a })),
      },
      [TEXT]: `${q}\n${as.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
    },
  };
}

/** A vote: `org.matrix.msc3381.poll.response` {answers} referencing the start. */
export function responseContent(start: string, answers: readonly string[]): Record<string, unknown> {
  return { "m.relates_to": { rel_type: "m.reference", event_id: start }, [RESPONSE_TYPE]: { answers: [...answers] } };
}

/** Ending: `org.matrix.msc3381.poll.end` {} referencing the start + the end message as text (body, msgtype m.text). */
export function endContent(start: string, text: string): Record<string, unknown> {
  return { "m.relates_to": { rel_type: "m.reference", event_id: start }, [END_TYPE]: {}, [TEXT]: text, body: text, msgtype: "m.text" };
}

/** What a click on an answer sends: single choice → [that answer] (null when it is already my vote); multiple → my
 *  selection with it toggled, in answer order — null when that would be empty or over `max` (nothing is sent). */
export function nextChoice(poll: Poll, mine: readonly string[], clicked: string): string[] | null {
  if (!poll.answers.some((a) => a.id === clicked)) return null;
  if (poll.max <= 1) return mine.length === 1 && mine[0] === clicked ? null : [clicked];
  const sel = mine.includes(clicked) ? mine.filter((a) => a !== clicked) : [...mine, clicked];
  if (sel.length === 0 || sel.length > poll.max) return null;
  return poll.answers.map((a) => a.id).filter((id) => sel.includes(id));
}

// ---- the chat samples (the gates' poll cards; both apps build the same events) ------------------------------------------

export interface PollSample {
  id: string;
  /** the creator ("" when `mine`: the viewer) */
  sender: string;
  mine: boolean;
  /** today's local time [h, m] of the start */
  at: [number, number];
  question: string;
  kind: PollKind;
  /** [id, text] */
  answers: [string, string][];
  /** [who, answer id] in order, one a minute after the start ("me" = the viewer) */
  votes: [string, string][];
  ended: boolean;
}

/** Sample polls a gate / review build appends to the open conversation (web `?chatsamples=polls` with the debug flag,
 *  desktop `TINHAT_CHAT_SAMPLES=polls`): local events only, never sent. */
export const POLL_CHAT_SAMPLES: readonly PollSample[] = [
  {
    id: "$w3-sample-poll-1",
    sender: "@Ana:sample.invalid",
    mine: false,
    at: [20, 30],
    question: "What are we playing tonight?",
    kind: "disclosed",
    answers: [["valheim", "Valheim"], ["zomboid", "Project Zomboid"], ["league", "League of Legends"], ["finals", "The Finals"]],
    votes: [["@Ana:sample.invalid", "valheim"], ["@Bo:sample.invalid", "valheim"], ["@Cy:sample.invalid", "zomboid"], ["me", "valheim"]],
    ended: false,
  },
  {
    id: "$w3-sample-poll-2",
    sender: "",
    mine: true,
    at: [20, 36],
    question: "Start time for raid night?",
    kind: "undisclosed",
    answers: [["8pm", "8 PM"], ["9pm", "9 PM"], ["10pm", "10 PM"]],
    votes: [["@Bo:sample.invalid", "9pm"], ["@Dee:sample.invalid", "8pm"]],
    ended: false,
  },
  {
    id: "$w3-sample-poll-3",
    sender: "@Bo:sample.invalid",
    mine: false,
    at: [20, 42],
    question: "Best boss so far?",
    kind: "disclosed",
    answers: [["elder", "The Elder"], ["moder", "Moder"], ["yagluth", "Yagluth"]],
    votes: [["@Ana:sample.invalid", "moder"], ["@Bo:sample.invalid", "yagluth"], ["@Cy:sample.invalid", "moder"], ["me", "elder"]],
    ended: true,
  },
];

/**
 * A sample poll's events for the viewer `me` whose local day starts at `day0` (ms): the start at h:m (the dialog's
 * content, the sample's answer ids), one response per vote a minute apart, and — ended — the creator's end a minute
 * after the last vote with the end message of the votes so far.
 */
export function sampleEvents(s: PollSample, me: string, day0: number): PollEvent[] {
  const creator = s.mine ? me : s.sender;
  const t0 = day0 + (s.at[0] * 60 + s.at[1]) * 60000;
  const c = startContent(s.question, s.answers.map((a) => a[1]), s.kind, s.answers.map((a) => a[0]));
  const out: PollEvent[] = [{ id: s.id, type: START_TYPE, sender: creator, ts: t0, content: c.ok ? c.content : {} }];
  s.votes.forEach(([who, a], i) => out.push({ id: `${s.id}-r${i}`, type: RESPONSE_TYPE, sender: who === "me" ? me : who, ts: t0 + (i + 1) * 60000, content: responseContent(s.id, [a]) }));
  if (s.ended) {
    const poll = readStart(START_TYPE, out[0]!.content);
    const text = poll ? endText(poll, tally(poll, s.id, creator, out, [], me)) : "";
    out.push({ id: `${s.id}-end`, type: END_TYPE, sender: creator, ts: t0 + (s.votes.length + 1) * 60000, content: endContent(s.id, text) });
  }
  return out;
}

/** More sample polls for the widget's states (never in the chat samples): with the chat samples' open ones they make
 *  the widget's data (4 open) and many (6 open) states. */
export const POLL_WIDGET_SAMPLES: readonly PollSample[] = [
  {
    id: "$w3-sample-poll-4",
    sender: "@Cy:sample.invalid",
    mine: false,
    at: [19, 50],
    question: "Which biome for Friday?",
    kind: "disclosed",
    answers: [["meadows", "Meadows"], ["swamp", "Swamp"], ["mountains", "Mountains"]],
    votes: [["@Cy:sample.invalid", "swamp"], ["@Dee:sample.invalid", "meadows"]],
    ended: false,
  },
  {
    id: "$w3-sample-poll-5",
    sender: "@Dee:sample.invalid",
    mine: false,
    at: [19, 20],
    question: "Pizza or tacos for game night?",
    kind: "disclosed",
    answers: [["pizza", "Pizza"], ["tacos", "Tacos"]],
    votes: [["me", "tacos"], ["@Ana:sample.invalid", "pizza"], ["@Eli:sample.invalid", "tacos"]],
    ended: false,
  },
  {
    id: "$w3-sample-poll-6",
    sender: "@Eli:sample.invalid",
    mine: false,
    at: [18, 5],
    question: "Should we restart the Valheim world after the next patch?",
    kind: "undisclosed",
    answers: [["yes", "Yes, a fresh start"], ["no", "No, keep it"]],
    votes: [["@Fay:sample.invalid", "no"]],
    ended: false,
  },
  {
    id: "$w3-sample-poll-7",
    sender: "",
    mine: true,
    at: [17, 40],
    question: "Keep the voice bitrate at 96 kbps?",
    kind: "disclosed",
    answers: [["keep", "Keep it"], ["raise", "Raise it"]],
    votes: [],
    ended: false,
  },
];
