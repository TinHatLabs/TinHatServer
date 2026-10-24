// note/Note.tsx — the Sticky note widget (contract WIDGETS.md §14, WIDGETS-UI.md §14; widgets W1, 2026-09-28): one shared
// note per space — "Tonight: bring potions" — on a faint sticky-note paper: the space selected on the rail, else (Home,
// Favourites, People) the space of the open room. M the note (up to 6 lines), L the whole note, S / collapsed its first
// line; under it the author's avatar + "Ana · edited 2 h ago". With `edit_space_note` (the space's roles, else its power
// levels — useEffectivePerms, the rule every permission-gated UI uses) a click edits it inline: the house text area, a
// counter "n / 500" (amber from 450), Cancel / Save (Ctrl+Enter saves, Escape cancels; an empty note clears it). Links
// (http / https) open in a new tab. A change cross-fades (noteFade). No timer.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { peekClient, useRoomName, useRoomStateEvents } from "@/core/matrix";
import { usePref } from "@/core/prefs";
import { toast } from "@/core/bus";
import { Avatar, Button, TextArea, cx, useAnimate } from "@/ui";
import { useNav } from "@/features/nav";
import { useEffectivePerms } from "@/features/spaces";
import { NOTE_TYPE, noteCounter, noteFirstLine, noteOf, noteSegments, noteToSave } from "@/widgets/note";
import { fmtAgo } from "@/widgets/time";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { SAMPLE_SERVER, usePerson } from "../names";
import s from "./Note.module.css";

export interface NoteModel {
  /** the space whose note shows ("" = none) */
  space: string;
  spaceName: string;
  ready: boolean;
  /** the note (null = none) */
  text: string | null;
  sender: string;
  ts: number;
  canEdit: boolean;
  /** a sample: nothing is written */
  sample?: boolean;
  /** a sample that shows the editor (the gates' "edit" state) */
  editing?: boolean;
}

function useNote(_ctx: WidgetCtx): NoteModel {
  const activeKey = useNav((st) => st.activeKey);
  const lastRoom = String(usePref("last-room", ""));
  const roomSpaceKey = useNav((st) => (lastRoom ? (st.roomSpace.get(lastRoom) ?? "") : ""));
  const space = activeKey.startsWith("!") ? activeKey : roomSpaceKey.startsWith("!") ? roomSpaceKey : "";
  const spaceName = useRoomName(space || null);
  const entries = useRoomStateEvents(space || null, NOTE_TYPE);
  const perms = useEffectivePerms(space || null);
  return useMemo(() => {
    const e = entries.find((x) => x.stateKey === "");
    const text = e ? noteOf(e.content) : null;
    const known = !!space && !!peekClient()?.getRoom(space);
    return { space, spaceName, ready: !space || known, text, sender: text && e ? e.sender : "", ts: text && e ? e.ts : 0, canEdit: !!perms.perms.edit_space_note };
  }, [space, spaceName, entries, perms]);
}

// ---- the editor's state lives outside the widget's body: the stack may fold and reopen a widget whose height changes
//      (the editor is taller than the note), which remounts its body — the edit and its draft must survive that ----------
let editSpace = "";
let editDraft = "";
const editListeners = new Set<() => void>();
function setEdit(space: string, draft: string): void {
  editSpace = space;
  editDraft = draft;
  for (const l of [...editListeners]) l();
}
function subscribeEdit(cb: () => void): () => void {
  editListeners.add(cb);
  return () => void editListeners.delete(cb);
}
const editSnapshot = () => `${editSpace}\u0000${editDraft}`;
function useEdit(): { space: string; draft: string } {
  const snap = useSyncExternalStore(subscribeEdit, editSnapshot, editSnapshot);
  const i = snap.indexOf("\u0000");
  return { space: snap.slice(0, i), draft: snap.slice(i + 1) };
}

async function saveNote(space: string, input: string): Promise<boolean> {
  const r = noteToSave(input);
  if (!r.ok) {
    toast("That's over 500 characters — shorten it to save.");
    return false;
  }
  try {
    await peekClient()?.sendStateEvent(space, NOTE_TYPE as never, r.content as never, "");
    return true;
  } catch (e) {
    const st = (e as { httpStatus?: number })?.httpStatus;
    toast(st === 403 ? "You can't edit this space's note" : "Couldn't save the note — check your connection and try again", { kind: "error" });
    return false;
  }
}

/** The note as text + links (note::segments); newlines kept (pre-wrap). */
function NoteRich({ text }: { text: string }): ReactNode {
  return noteSegments(text).map((seg, i) =>
    seg.url ? (
      <a key={i} className={s.link} href={seg.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        {seg.text}
      </a>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

/** noteFade: the new text fades in over the old one fading out (`long`, OutCubic); the first fill and reduced motion snap. */
function FadingNote({ text, large }: { text: string; large: boolean }) {
  const animate = useAnimate();
  const [layers, setLayers] = useState<{ cur: string; prev: string | null; n: number }>({ cur: text, prev: null, n: 0 });
  useEffect(() => {
    setLayers((l) => (l.cur === text ? l : { cur: text, prev: animate ? l.cur : null, n: l.n + 1 }));
  }, [text, animate]);
  return (
    <div className={s.fadeBox}>
      {layers.prev !== null && (
        <div className={cx(s.noteText, s.fadeOut, !large && s.clamp)} aria-hidden="true" onAnimationEnd={() => setLayers((l) => ({ ...l, prev: null }))}>
          <NoteRich text={layers.prev} />
        </div>
      )}
      <div key={layers.n} className={cx(s.noteText, layers.prev !== null && s.fadeIn, !large && s.clamp)}>
        <NoteRich text={layers.cur} />
      </div>
    </div>
  );
}

function Editor({ m, draft, setDraft, onDone, ctx }: { m: NoteModel; draft: string; setDraft: (t: string) => void; onDone: () => void; ctx: WidgetCtx }) {
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el || m.sample) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [m.sample]);
  const c = noteCounter(draft);
  const save = async () => {
    if (busy || c.over || m.sample || ctx.preview) return;
    setBusy(true);
    const ok = await saveNote(m.space, draft);
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <div className={s.editor} data-note-editor="">
      <TextArea
        ref={area}
        className={s.area}
        value={draft}
        placeholder="Tonight: bring potions…"
        readOnly={ctx.preview}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      <div className={s.editRow}>
        <span className={s.counter} data-near={c.near ? "" : undefined}>
          {c.count} / {c.max}
        </span>
        <Button flat text="Cancel" onClick={onDone} disabled={ctx.preview} />
        <Button highlighted text="Save" onClick={() => void save()} disabled={ctx.preview || c.over || busy} />
      </div>
    </div>
  );
}

function Body({ model: m, ctx }: PartProps<NoteModel>) {
  const ed = useEdit();
  const [sampleDraft, setSampleDraft] = useState(m.text ?? "");
  const who = usePerson(m.sender, m.space || null);
  const large = ctx.size === "L" && !ctx.preview;
  if (!m.space) return <div className={s.status}>Pick a space to see its note</div>;
  if (!m.ready) return <div className={s.status}>Reading the note…</div>;
  const edit = () => !ctx.preview && !m.sample && m.canEdit && setEdit(m.space, m.text ?? "");
  const done = () => setEdit("", "");
  if (m.editing) return <Editor m={m} ctx={ctx} draft={sampleDraft} setDraft={setSampleDraft} onDone={() => {}} />;
  if (!m.sample && !ctx.preview && ed.space === m.space) return <Editor m={m} ctx={ctx} draft={ed.draft} setDraft={(t) => setEdit(m.space, t)} onDone={done} />;
  if (!m.text)
    return (
      <div className={s.empty}>
        <span>No note yet</span>
        {m.canEdit && <Button flat text="Add a note" icon="list-add-symbolic" className={s.add} onClick={edit} disabled={ctx.preview} />}
      </div>
    );
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      <div
        className={s.paper}
        data-editable={m.canEdit && !ctx.preview ? "" : undefined}
        role={m.canEdit ? "button" : undefined}
        tabIndex={m.canEdit && !ctx.preview ? 0 : undefined}
        aria-label={m.canEdit ? "Edit the note" : undefined}
        onClick={edit}
        onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), edit())}
      >
        <FadingNote text={m.text} large={large} />
      </div>
      <div className={s.meta}>
        <Avatar size={ctx.mobile ? 20 : 16} name={who.name} seed={m.sender} imageSource={who.avatar} />
        <span className={s.metaText}>
          {who.name} · edited {fmtAgo(Date.now() - m.ts)}
        </span>
        {m.canEdit && <Button flat text="Edit" className={s.editBtn} onClick={edit} disabled={ctx.preview} />}
      </div>
    </div>
  );
}

function Summary({ model: m }: PartProps<NoteModel>) {
  const t = !m.space ? "No space" : !m.ready ? "…" : m.text ? noteFirstLine(m.text) : "No note yet";
  return <span className={s.headerText}>{t}</span>;
}

/** M / L header: the space the note belongs to. */
function SpaceName({ model: m }: PartProps<NoteModel>) {
  if (!m.space || !m.spaceName) return null;
  return <span className={s.headerText}>{m.spaceName}</span>;
}

// ---- samples (the gallery's preview, the review screenshots, the gates) — the desktop's NoteWidget.qml sample --------

const SHORT = "Tonight: bring potions 🧪\nRaid at 9 PM — Dee tanks, Bo heals.\nRoute: https://example.com/raid";
const LONG = `${SHORT}\n\nAfter the raid: loot rolls in #loot, no ninja-ing.\nSaturday: Valheim night, bring your own mead.\nIf you're late, ping me and I'll hold the portal.\nLast one out turns off the lights.`;
function sample(key: "data" | "long" | "empty" | "readonly" | "emptyro" | "nospace" | "edit"): NoteModel {
  if (key === "nospace") return { space: "", spaceName: "", ready: true, text: null, sender: "", ts: 0, canEdit: false, sample: true };
  const empty = key === "empty" || key === "emptyro";
  return {
    space: `!squad:${SAMPLE_SERVER}`,
    spaceName: "Squad chat",
    ready: true,
    text: empty ? null : key === "long" ? LONG : SHORT,
    sender: empty ? "" : `@ana:${SAMPLE_SERVER}`,
    // edited 2 h ago (fmtAgo floors to the hour: the line reads the same for the hour after any capture)
    ts: empty ? 0 : Date.now() - 2 * 3_600_000 - 60_000,
    canEdit: key !== "readonly" && key !== "emptyro",
    sample: true,
    editing: key === "edit",
  };
}

export const note = defineWidget<NoteModel>({
  id: "note",
  useModel: useNote,
  live: () => false,
  Summary,
  HeaderExtra: SpaceName,
  Body,
  hasData: (m) => !!m.space && !!m.text,
  samples: {
    preview: () => sample("data"),
    data: () => sample("data"),
    long: () => sample("long"),
    empty: () => sample("empty"),
    readonly: () => sample("readonly"),
    emptyro: () => sample("emptyro"),
    nospace: () => sample("nospace"),
    edit: () => sample("edit"),
  },
});
