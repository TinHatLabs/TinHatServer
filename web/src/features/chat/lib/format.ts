// format.ts — clock, day labels, sizes and durations exactly like ChatBubble.qml / ConversationView.qml.
import { getPref } from "@/core/prefs";

/** Clock mode (native ui pref `clock`: "system" | "12" | "24"). */
export function clockMode(): string {
  return String(getPref("clock", "system"));
}

/** The message timestamp ("h:mm AP" / "HH:mm" / system short time). */
export function fmtClock(ts: number, mode = clockMode()): string {
  const d = new Date(ts);
  if (mode === "24") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (mode === "12") {
    const h = d.getHours() % 12 || 12;
    return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
  }
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Timestamp tooltip — the long local date/time (native: Qt TextDate "Wed Sep 23 06:06:30 2026"). */
export function fmtFull(ts: number): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const mode = clockMode();
  const t =
    mode === "24"
      ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      : mode === "12"
        ? `${d.getHours() % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? "AM" : "PM"}`
        : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return `${day} ${t}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day separator: "Today" / "Yesterday" / "ddd, MMM d" (CV:184-190). */
export function dayLabel(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1); // one local calendar day (DST-safe)
  if (sameDay(ts, y.getTime())) return "Yesterday";
  const d = new Date(ts);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "MMM d, <clock>" for the pinned popover rows. */
export function fmtPinnedWhen(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${fmtClock(ts)}`;
}

/** fmtSize — B / KB / MB / GB with one decimal ("27.8 KB", "512 B"). */
export function fmtSize(n: number | undefined | null): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** "m:ss" from milliseconds (or seconds with `secs`). */
export function fmtDuration(v: number | undefined | null, secs = false): string {
  if (v == null || !Number.isFinite(v) || v < 0) return "0:00";
  const s = Math.floor(secs ? v : v / 1000);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Local file name for pasted images: pasted-YYYYMMDD-HHMMSS-mmm.png */
export function pastedName(ext = "png"): string {
  const d = new Date();
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `pasted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${ms}.${ext}`;
}

/** Extension → mimetype (room.rs:3613-3640); unknown → application/octet-stream. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  opus: "audio/opus",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/plain",
  json: "application/json",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export function mimeForName(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && EXT_MIME[m[1].toLowerCase()]) || "application/octet-stream";
}

/** File-card glyph by mimetype / extension (CB:862-921). */
export function fileGlyph(mime: string, name: string): string {
  const n = name.toLowerCase();
  if (mime.startsWith("image/")) return "image-x-generic";
  if (mime.startsWith("video/")) return "video-x-generic";
  if (mime.startsWith("audio/")) return "audio-x-generic";
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "application-pdf";
  if (/\.(zip|gz|xz|zst|7z|rar|tar)$/.test(n)) return "application-x-archive";
  if (mime.startsWith("text/") || /\.(txt|md|log|csv|json|yaml|yml|toml)$/.test(n)) return "text-x-generic";
  return "application-octet-stream";
}
