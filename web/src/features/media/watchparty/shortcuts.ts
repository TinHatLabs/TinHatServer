// watchparty/shortcuts.ts — the Media Party window's keys (11.3 QOL, the Media Party QOL spec §4), one
// table shared with the native (crates/app/src/watchparty.rs MP_SHORTCUTS + WatchPartyWindow.qml's Shortcut items;
// testvectors/mediaparty/shortcuts.json in both repos lists exactly this — 26 entries). `action` = a `window:watchParty`
// context action of the actions table where one exists (run by the window itself, ACTIONS.md §14.1), else the window's
// own op. Keys never fire while typing in the box, except Escape (WatchPartyWindow.tsx).
export type MpShortcutOp = "playPause" | "seek" | "jump" | "volume" | "mute" | "next" | "fullscreen" | "theater" | "mini" | "search" | "help" | "escape";

export interface MpShortcut {
  /** the key as the actions table spells it (§8.1): Space, K, Left, Right, J, L, 0–9, Up, Down, M, N, F, T, I, /, ?, Escape */
  key: string;
  /** what it does */
  op: MpShortcutOp;
  /** seek: seconds (negative = back) */
  secs?: number;
  /** jump: percent of the duration (host-gated like a seek) */
  pct?: number;
  /** volume: your own volume step (negative = down) */
  step?: number;
  /** the actions-table id this is (context window:watchParty) */
  action?: string;
  /** shown in the keys card */
  label: string;
}

const DIGITS: MpShortcut[] = Array.from({ length: 10 }, (_, d) => ({ key: String(d), op: "jump" as const, pct: d * 10, label: `Jump to ${d * 10} %` }));

export const MP_SHORTCUTS: readonly MpShortcut[] = [
  { key: "Space", op: "playPause", action: "watchParty.playPause", label: "Play / pause for everyone" },
  { key: "K", op: "playPause", action: "watchParty.playPause", label: "Play / pause for everyone" },
  { key: "Left", op: "seek", secs: -5, label: "Back 5 s" },
  { key: "Right", op: "seek", secs: 5, label: "Forward 5 s" },
  { key: "J", op: "seek", secs: -10, label: "Back 10 s" },
  { key: "L", op: "seek", secs: 10, label: "Forward 10 s" },
  ...DIGITS,
  { key: "Up", op: "volume", step: 5, label: "Volume up (only for you)" },
  { key: "Down", op: "volume", step: -5, label: "Volume down (only for you)" },
  { key: "M", op: "mute", action: "watchParty.mute", label: "Mute (only for you)" },
  { key: "N", op: "next", action: "watchParty.next", label: "Play next in queue" },
  { key: "F", op: "fullscreen", label: "Fullscreen" },
  { key: "T", op: "theater", label: "Theater (the video fills the window)" },
  { key: "I", op: "mini", label: "Mini player" },
  { key: "/", op: "search", label: "Search or paste a link" },
  { key: "?", op: "help", label: "Show the keys" },
  { key: "Escape", op: "escape", label: "Leave fullscreen or the mini player, else close" },
];

/** A DOM KeyboardEvent key → the table's spelling ("" when it is not one of ours; Ctrl / Alt / Meta = never ours). */
export function keyName(e: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): string {
  if (e.ctrlKey || e.altKey || e.metaKey) return "";
  switch (e.key) {
    case " ":
    case "Spacebar":
      return "Space";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "Escape":
    case "Esc":
      return "Escape";
  }
  const k = e.key.length === 1 ? e.key.toUpperCase() : "";
  return MP_SHORTCUTS.some((s) => s.key === k) ? k : "";
}

export function shortcutFor(key: string): MpShortcut | undefined {
  return MP_SHORTCUTS.find((s) => s.key === key);
}

/** The keys card (QOL §4): the table grouped Playback · Sound · View · Queue, one row per line ("Space / K"). */
export interface KeyRow {
  keys: string;
  label: string;
}
export const MP_KEY_GROUPS: readonly { title: string; rows: readonly KeyRow[] }[] = [
  {
    title: "Playback",
    rows: [
      { keys: "Space / K", label: "Play / pause for everyone" },
      { keys: "← / →", label: "Back / forward 5 s" },
      { keys: "J / L", label: "Back / forward 10 s" },
      { keys: "0 – 9", label: "Jump to 0 – 90 %" },
    ],
  },
  {
    title: "Sound",
    rows: [
      { keys: "↑ / ↓", label: "Volume up / down (only for you)" },
      { keys: "M", label: "Mute (only for you)" },
    ],
  },
  {
    title: "View",
    rows: [
      { keys: "F", label: "Fullscreen" },
      { keys: "T", label: "Theater (the video fills the window)" },
      { keys: "I", label: "Mini player" },
      { keys: "Esc", label: "Leave fullscreen or the mini player, else close" },
    ],
  },
  {
    title: "Queue",
    rows: [
      { keys: "N", label: "Play next in queue" },
      { keys: "/", label: "Search or paste a link" },
      { keys: "?", label: "Show the keys" },
    ],
  },
];
