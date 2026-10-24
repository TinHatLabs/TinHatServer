// text.ts — THEMES-UI.md §6.1 / §7: every refusal and notice of the theme screens in plain words (the desktop shows
// the same sentences). Pure.
import type { ImportFormat } from "@/theme/import";

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** A palette slot as people say it (bg → background, c9 → bright red). */
export function slotName(slot: string): string {
  if (slot === "bg") return "background";
  if (slot === "fg") return "text";
  if (slot === "cursor") return "cursor";
  if (slot === "selectionBg" || slot === "selectionFg") return "selection";
  const m = /^c(\d{1,2})$/.exec(slot);
  if (m) {
    const n = Number(m[1]);
    if (n < 8) return ANSI[n];
    if (n < 16) return `bright ${ANSI[n - 8]}`;
  }
  return slot;
}

export const FORMAT_NAMES: Record<ImportFormat, string> = {
  tinhat: "Tin Hat",
  iterm2: "iTerm2",
  kitty: "kitty",
  "alacritty-toml": "Alacritty",
  "alacritty-yaml": "Alacritty",
  ghostty: "Ghostty",
  wezterm: "WezTerm",
  "windows-terminal": "Windows Terminal",
  xresources: "Xresources",
  base16: "base16",
  base24: "base24",
};

export const READS =
  "Tin Hat reads kitty, Alacritty, Ghostty, iTerm2, WezTerm, Windows Terminal, Xresources and base16 / base24 themes, and Tin Hat theme files.";

/** An importer / engine / sync refusal ("<code>: <detail>" or a bare code) in plain words (THEMES-UI §6.1). */
export function refusalText(error: string): string {
  const i = error.indexOf(":");
  const code = i < 0 ? error : error.slice(0, i);
  const detail = i < 0 ? "" : error.slice(i + 1).trim();
  switch (code) {
    case "import-empty":
      return "Paste a theme or choose a file first.";
    case "import-too-large":
      return "That file is too big to be a theme (the limit is 256 KB).";
    case "unknown-format":
      return "Tin Hat doesn't recognise this format. It reads kitty, Alacritty, Ghostty, iTerm2, WezTerm, Windows Terminal, Xresources and base16 / base24 themes.";
    case "import-incomplete": {
      const slot = detail.replace(/^missing\s+/, "");
      return `This theme has no ${slotName(slot)} colour, so Tin Hat can't use it.`;
    }
    case "import-bad-colour": {
      const m = /^(\S+)\s+'(.*)'$/.exec(detail);
      return m ? `The ${slotName(m[1])} colour (“${m[2]}”) isn't a colour Tin Hat can read.` : "One of this theme's colours isn't a colour Tin Hat can read.";
    }
    case "bad-json":
      return "This isn't valid JSON.";
    case "bad-toml":
    case "bad-yaml": {
      const m = /line (\d+)/.exec(detail);
      const kind = code === "bad-toml" ? "TOML" : "YAML";
      return m ? `There's a mistake on line ${m[1]} of this ${kind} file.` : `There's a mistake in this ${kind} file.`;
    }
    case "bad-plist":
      return "This isn't a valid iTerm2 colours file.";
    case "too-large":
      // the engine says "too-large: <n> bytes (max 8192)"; the sync's bare "too-large" = My themes is full (64 KB)
      return detail ? "This theme is larger than 8 KB." : "Your saved themes are full. Remove a theme to make room.";
    case "url":
      return "Themes can't contain web links.";
    case "too-many-overrides":
      return "This theme changes more than 400 colours.";
    case "too-many":
      return "You already have 50 themes. Remove one to make room.";
    case "theme-too-large":
      return "This theme is larger than 8 KB.";
    case "newer-format":
      return "A newer Tin Hat manages your themes. Update Tin Hat to save new ones here.";
    default:
      return `This Tin Hat theme can't be used (${code}).`;
  }
}

/** "3 colours adjusted for readability" (THEMES-UI §3.2). */
export function adjustedText(n: number): string {
  return n === 1 ? "1 colour adjusted for readability" : `${n} colours adjusted for readability`;
}

export const packName = (p: string): string => (p === "goose" ? "Goose" : "Tin Hat");
