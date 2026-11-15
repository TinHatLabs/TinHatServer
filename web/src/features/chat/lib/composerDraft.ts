// composerDraft.ts — the composer's draft rules (L1 "don't lose what I typed"), the same as the desktop's
// crates/app/qml/ConversationView.qml (BEGIN composer-draft pure … END composer-draft pure) through the shared vectors
// testvectors/composer-draft/vectors.json (byte-identical in both repos):
// - A09.0 the reply/edit bar's ✕ and Escape both drop only the target, never the typed text or the staged files;
// - A09.1 starting an edit sets the unsent draft aside; cancelling or saving the edit gives it back;
// - A09.4 an unchanged edit is not sent, an empty one is refused;
// - A20.0 a sent edit that the server refused comes back into the box.

import { PHOTO_LOCATION_FAIL } from "../../../core/photoUpload";

export type DraftTarget = "" | "reply" | "edit";
export interface DraftStash<M> {
  text: string;
  marks: M[];
}
export interface DraftState<M = unknown> {
  text: string;
  marks: M[];
  target: DraftTarget;
  id: string;
  body: string;
  stash: DraftStash<M> | null;
}
export type DraftOp<M = unknown> =
  | { op: "type"; text: string; marks?: M[] }
  | { op: "reply"; id: string; body: string }
  | { op: "edit"; id: string; body: string }
  | { op: "cancel" }
  | { op: "send"; files?: number }
  | { op: "failed"; id: string; text: string };
export type DraftFx = "" | "none" | "send" | "reply" | "reply-needs-text" | "edit" | "unchanged" | "empty-edit" | "put-back" | "kept-out";

const rtrim = (t: string) => t.replace(/\s+$/, "");

export function draftStep<M>(st: DraftState<M>, op: DraftOp<M>): { st: DraftState<M>; fx: DraftFx } {
  const s: DraftState<M> = { ...st };
  let fx: DraftFx = "";
  const clear = () => {
    s.target = "";
    s.id = "";
    s.body = "";
  };
  const back = () => {
    const b = s.stash;
    s.stash = null;
    s.text = b ? b.text : "";
    s.marks = b ? b.marks : [];
  };
  const has = s.text.trim().length > 0;
  switch (op.op) {
    case "type":
      s.text = op.text;
      if (op.marks) s.marks = op.marks;
      break;
    case "reply":
      if (s.target === "edit") back();
      s.target = "reply";
      s.id = op.id;
      s.body = op.body;
      break;
    case "edit":
      if (s.target !== "edit") s.stash = { text: s.text, marks: s.marks };
      s.text = op.body;
      s.marks = [];
      s.target = "edit";
      s.id = op.id;
      s.body = op.body;
      break;
    case "cancel":
      if (s.target === "edit") back();
      clear();
      break;
    case "send": {
      const files = op.files ?? 0;
      if (s.target === "edit") {
        if (!has) fx = "empty-edit";
        else {
          // unchanged = the same text but trailing whitespace (a new leading indent is a code block) and nobody picked
          fx = s.body.length > 0 && rtrim(s.text) === rtrim(s.body) && s.marks.length === 0 ? "unchanged" : "edit";
          back();
          clear();
        }
      } else if (s.target === "reply") {
        if (!has) fx = files > 0 ? "reply-needs-text" : "none";
        else {
          fx = "reply";
          s.text = "";
          s.marks = [];
          clear();
        }
      } else if (!has && files === 0) fx = "none";
      else {
        fx = "send";
        s.text = "";
        s.marks = [];
      }
      break;
    }
    case "failed":
      if (s.target === "") {
        s.stash = { text: s.text, marks: s.marks };
        s.text = op.text;
        s.marks = [];
        s.target = "edit";
        s.id = op.id;
        s.body = "";
        fx = "put-back";
      } else fx = "kept-out";
      break;
  }
  return { st: s, fx };
}

/** 4-4 (L8 P21): "Send as text" sends only what the question was asked about: the room, the text, the reply/edit target,
 *  the picked people, the staged files (the set-aside draft doesn't count). The desktop's draftSame; vectors "same". */
export interface SendSnap<M = unknown> {
  room: string;
  state: DraftState<M>;
  files: string[];
}
export function draftSame<M>(a: SendSnap<M>, b: SendSnap<M>): boolean {
  const key = (x: SendSnap<M>) => JSON.stringify([x.room, x.state.text, x.state.target, x.state.id, x.state.marks ?? [], x.files ?? []]);
  return key(a) === key(b);
}

/** What the room remembers as its draft: never the text of an edit (that was the old message), the draft set aside. */
export function draftToKeep<M>(st: DraftState<M>): string {
  return st.target === "edit" ? (st.stash ? st.stash.text : "") : st.text;
}

export type FailClass = "forbidden" | "too-large" | "rate" | "network" | "other";

/** A failed request's class: the errcode / HTTP status when there is one, else the error's text (the desktop reads the
 *  SDK's error text with the same rules: room.rs fail_class). */
export function failClass(err: unknown): FailClass {
  const e = err as { errcode?: string; httpStatus?: number; name?: string; message?: string } | null;
  // a photo that couldn't be cleaned is never a network failure, whatever its message says: it never resends by itself
  // (the assembly's note; the desktop's "photo location: …" errors, the vectors' classes)
  const m0 = String(e?.message ?? (typeof err === "string" ? err : ""));
  if (e?.name === "ExifStripError" || m0.startsWith("photo location: ") || m0.includes(PHOTO_LOCATION_FAIL)) return "other";
  const code = e?.errcode ?? "";
  if (code === "M_FORBIDDEN" || e?.httpStatus === 403) return "forbidden";
  if (code === "M_TOO_LARGE" || e?.httpStatus === 413) return "too-large";
  if (code === "M_LIMIT_EXCEEDED" || e?.httpStatus === 429) return "rate";
  if (e?.name === "ConnectionError") return "network";
  const l = String(e?.message ?? (typeof err === "string" ? err : "")).toLowerCase();
  if (l.includes("m_forbidden") || l.includes("403")) return "forbidden";
  if (l.includes("m_too_large") || l.includes("413")) return "too-large";
  if (l.includes("m_limit_exceeded") || l.includes("429")) return "rate";
  if (["connect", "timed out", "timeout", "dns", "network", "fetch"].some((w) => l.includes(w))) return "network";
  return "other";
}

/** A failed edit / delete / GIF in plain words. */
export function failText(kind: "edit" | "delete" | "gif", cls: FailClass, putBack: boolean): string {
  const why =
    cls === "forbidden"
      ? "you don't have permission here"
      : cls === "too-large"
        ? "it's too large for the server"
        : cls === "rate"
          ? "the server is busy, try again in a moment"
          : cls === "network"
            ? "no connection"
            : "";
  const head = kind === "edit" ? "Your edit wasn't saved" : kind === "delete" ? "The message wasn't deleted" : "Your GIF wasn't sent";
  return head + (why ? ` (${why}).` : ".") + (putBack ? " It's back in the message box." : "");
}
