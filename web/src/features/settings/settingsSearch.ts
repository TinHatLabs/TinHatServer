// settingsSearch.ts — the Settings window's search (SETTINGS-WINDOW.md §4). SHARED LOGIC: the desktop's
// settings_search.rs is the same matcher over the same index (settingsIndex.json = a byte copy of the contract's
// settings-index.json) and both replay testvectors/settings-search/vectors.json (settingsSearch.test.ts here).
// Pure: no React, no app imports — the unit test runs it in plain Node.
//
//   normalize(s)  NFD, drop combining marks, lowercase, every run of non-letters/digits → one space, trim
//   query tokens  normalize(q).split(" ") — an empty query is no search
//   entry words   normalize(label + " " + section + " " + paneTitle + " " + keywords).split(" ")
//   match         EVERY token is a prefix of some word
//   score         3 = normalize(label) starts with normalize(q); 2 = every token is a prefix of a label word; else 1
//   order         score desc, then index order; at most 30

export interface SettingsIndexPane {
  key: string;
  title: string;
}

export interface SettingsIndexEntry {
  id: string;
  pane: string;
  section: string;
  label: string;
  keywords: string;
  /** operators only (the Invites pane) */
  operator?: boolean;
  /** a desktop-only row: never offered by the web */
  desktopOnly?: boolean;
  /** a row the web does not show */
  webHidden?: boolean;
}

export interface SettingsIndex {
  format: string;
  v: number;
  panes: SettingsIndexPane[];
  entries: SettingsIndexEntry[];
}

export interface SettingsSearchOptions {
  /** show operator-only entries */
  operator: boolean;
  /** which app is asking (default "web"): drops desktopOnly / webHidden entries on the web */
  app?: "web" | "desktop";
}

export interface SettingsHit {
  entry: SettingsIndexEntry;
  /** the pane's title (the result's path is "<paneTitle> › <section>") */
  paneTitle: string;
  score: 1 | 2 | 3;
}

export const MAX_RESULTS = 30;

/** NFD, combining marks dropped, lowercase, every run of non-letters/digits → one space, trimmed. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The query's tokens ([] = no search). */
export function queryTokens(q: string): string[] {
  const n = normalize(q);
  return n ? n.split(" ") : [];
}

const everyPrefix = (tokens: string[], words: string[]) => tokens.every((t) => words.some((w) => w.startsWith(t)));

export function searchSettings(index: SettingsIndex, q: string, opts: SettingsSearchOptions): SettingsHit[] {
  const nq = normalize(q);
  if (!nq) return [];
  const tokens = nq.split(" ");
  const app = opts.app ?? "web";
  const titles = new Map(index.panes.map((p) => [p.key, p.title]));
  const hits: Array<SettingsHit & { i: number }> = [];
  index.entries.forEach((e, i) => {
    if (e.operator && !opts.operator) return;
    if (app === "web" && (e.desktopOnly || e.webHidden)) return;
    const paneTitle = titles.get(e.pane) ?? e.pane;
    const words = normalize(`${e.label} ${e.section} ${paneTitle} ${e.keywords}`).split(" ");
    if (!everyPrefix(tokens, words)) return;
    const label = normalize(e.label);
    const score = label.startsWith(nq) ? 3 : everyPrefix(tokens, label.split(" ")) ? 2 : 1;
    hits.push({ entry: e, paneTitle, score, i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.slice(0, MAX_RESULTS).map(({ entry, paneTitle, score }) => ({ entry, paneTitle, score }));
}

/** The label split for display: the part that matched the query bold (the first label word a token is a prefix of,
 *  per token — so "sound vol" bolds "Sound" and "vol"). Returns [text, bold][] runs covering the whole label. */
export function highlightRuns(label: string, q: string): Array<[string, boolean]> {
  const tokens = queryTokens(q);
  if (!tokens.length) return [[label, false]];
  const bold = new Array<boolean>(label.length).fill(false);
  // walk the label's words in the original string; a word = a run of letters/digits
  const re = /[\p{L}\p{N}\p{M}]+/gu;
  for (let m = re.exec(label); m; m = re.exec(label)) {
    const word = m[0];
    const nw = normalize(word);
    const t = tokens.find((tok) => nw.startsWith(tok));
    if (!t) continue;
    // bold as many original characters as the token covers once normalized
    let n = 0;
    while (n < word.length && normalize(word.slice(0, n)).length < t.length) n++;
    for (let k = 0; k < n; k++) bold[m.index + k] = true;
  }
  const runs: Array<[string, boolean]> = [];
  for (let i = 0; i < label.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last[1] === bold[i]) last[0] += label[i];
    else runs.push([label[i], bold[i]]);
  }
  return runs;
}
