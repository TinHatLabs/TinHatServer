// Composer.tsx — the bottom of ConversationView (CV:1136-1895): typing strip, reply/edit bar, staged
// strip, the composer box (+ attach, growing field, emoji / GIF / r.composerActions / pins, Send),
// @mention + :emoji: autocomplete, slash commands, typing notices, paste/drop staging.
// 11.0 (islands C6/C7, `portal`): the desktop dock host's composer island — the composer SECTION (the reply / edit bar,
// the staged files, the box) is rendered into that island with createPortal, so its state stays here (drafts, the reply
// target, staged files, focus); the typing strip stays under the timeline. The island draws the box (fill, the frame in
// the focus colour through [data-composer-focus], radius), so the box draws none there — except in the Flat layout style
// (`boxCard`): the island is flat and the box draws its own card again (fill, frame, radius, 4 px sides, 9 px below).
import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "@/core/bus";
import { peekClient, useMembers, useRoomName, useTyping } from "@/core/matrix";
import { useRegistry } from "@/core/registry";
import { useContainer, useRolesState } from "@/features/spaces";
import { buildMemberRows } from "@/features/spaces/RightPanel";
import { AnimatedImage, Avatar, ConfirmDialog, GlowButton, Icon, Menu, MenuItem, ToolButton, cx, useTip } from "@/ui";
import type { ItemOut } from "@/actions/evaluate";
import type { Handler } from "@/actions/run";
import { Dim, EditableRow, RowButton, bespokeOk, shownItems, useRow, type RowState } from "@/actions/ui/rowHost";
import { persistChatMemory, useChatStore, type StagedFile } from "./store";
import { completeEmoji, type EmojiItem } from "./lib/emoji";
import { expandSlash, unknownSlash, unknownSlashWords, type PickedMention } from "./lib/markdown";
import { displayName, snippetOf, type Row } from "./lib/model";
import { fmtSize, pastedName } from "./lib/format";
import { inertBlob, isScriptableType } from "@/core/mediatype";
import { draftSame, type SendSnap, draftStep, draftToKeep, failText, type DraftOp, type DraftState, type DraftStash } from "./lib/composerDraft";
import { editMessage, playSend, roomReadyToSend, sendAttachment, sendEmote, sendPlain, sendReply, sendText, sendTyping, sendWithMentions, type ThreadCtx } from "./actions";
import { EmojiPicker } from "./EmojiPicker";
import { useConvToast } from "./convToast";
import { GifPicker } from "./GifPicker";
import { PinnedButton, PinnedPopover, usePinnedIds } from "./PinnedPopover";
import { MicButton, VoicePill, VoiceRow } from "./voicenote/VoiceRecorder";
import { leaveVoiceView } from "./voicenote/store";
import { useVoiceDraft } from "./voicenote/wire";
import s from "./Composer.module.css";

export interface ComposerHandle {
  startReply: (row: Row) => void;
  startEdit: (row: Row) => void;
  focus: () => void;
  stage: (files: File[]) => void;
  insert: (text: string) => void;
  hasTarget: () => boolean;
}

export interface ComposerProps {
  roomId: string;
  primary: boolean;
  floating?: boolean;
  mobile?: boolean;
  rows: Row[];
  me: string;
  onSent: () => void;
  onEscapeEmpty: () => void;
  onPage: (dir: -1 | 1) => void;
  onJump: (eventId: string) => void;
  narrow: boolean;
  /** 11.0: the composer island's element to render the section into (undefined = in place; null = not there yet) */
  portal?: HTMLElement | null;
  /** 10.8 Flat layout: the box draws its own card in the island (as it did before islands) */
  boxCard?: boolean;
  /** threads (docs/THREADS.md): the composer of this thread's panel (its root); every send goes into the thread */
  thread?: string;
}

/** threads: the send context of a thread's composer — the newest real event shown in its panel is the spec's
 *  fallback reply target (the root when the thread has no replies yet). */
function threadCtx(root: string | undefined, rows: Row[]): ThreadCtx | null {
  if (!root) return null;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].eventId && !rows[i].echo) return { root, latest: rows[i].eventId! };
  return { root, latest: root };
}

interface Target {
  kind: "reply" | "edit";
  id: string;
  body: string;
  name: string;
}

let stageSeq = 0;
/** the field's margin-bottom inside the field wrapper (Composer.module.css .field) */
const FIELD_BOTTOM = 5;

function toStaged(f: File): StagedFile {
  // an SVG (or any type a browser runs as a page) is staged as a file: its preview blob would be octet-stream
  // (core/mediatype — no object URL of this origin carries a script-capable type), which no <img> draws
  const isImage = f.type.startsWith("image/") && !isScriptableType(f.type);
  return { id: `st${++stageSeq}`, file: f, url: isImage ? URL.createObjectURL(inertBlob(f)) : "", isImage };
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(p, ref) {
  const { roomId, primary, rows } = p;
  const roomName = useRoomName(roomId);
  // threads: a thread's composer keeps its own draft / reply target / staged files
  const memKey = p.thread ? `${roomId}#thread:${p.thread}` : roomId;
  const mem = useChatStore.getState().memory[memKey];
  const [text, setText] = useState(mem?.draft ?? "");
  const [target, setTarget] = useState<Target | null>(mem?.replyToId ? { kind: "reply", id: mem.replyToId, body: mem.replyToBody, name: mem.replyToName } : null);
  // a floating chat never picks up the main view's staged files (they would be sent twice)
  const [staged, setStaged] = useState<StagedFile[]>(p.floating ? [] : (mem?.staged ?? []));
  const [focused, setFocused] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [popup, setPopup] = useState<{ kind: "mention" | "emoji"; start: number; items: Array<{ key: string; label: string; mention?: PickedMention & { room?: boolean }; emoji?: EmojiItem; seed?: string; avatar?: string | null }>; cur: number } | null>(null);
  const picked = useRef<PickedMention[]>([]);
  // L1 (A09.1): the unsent draft set aside while an edit uses the box (lib/composerDraft.ts, shared with the desktop)
  const stash = useRef<DraftStash<PickedMention> | null>(null);
  // a refused edit answers after the send; it only goes back into a composer that is still there
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const gifBtn = useRef<HTMLButtonElement>(null);
  // 11.0 buttons: a generic button (a row drawn as icon + label, or an action moved to the other row) opens the pickers
  // at itself — null = today's buttons (emojiBtn / gifBtn)
  const [pickAnchor, setPickAnchor] = useState<HTMLElement | null>(null);
  const joined = useMembers(roomId, "join");
  // the mention list walks the room's member model in the native order (room.rs:2683: tier, power
  // desc, group, name) — spaces owns that model (RightPanel's buildMemberRows)
  const rolesSt = useRolesState(useContainer(roomId));
  const members = useMemo(() => {
    const byId = new Map(joined.map((m) => [m.userId, m]));
    return buildMemberRows(joined, rolesSt)
      .map((r) => byId.get(r.mxid))
      .filter((m): m is (typeof joined)[number] => !!m);
  }, [joined, rolesSt]);
  // phones: "+" opens an action sheet (photo/file, GIF, pins, feature actions)
  const [plusOpen, setPlusOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const pinnedIds = usePinnedIds(roomId);
  const composerActions = useRegistry("composerActions");
  const notify = useConvToast();
  // 11.0 buttons: the composer's two button rows (composer.start / composer.end; phones: composer.end), the stored rows
  // or the preset's defaults (today's buttons) — the room is the rows' context
  const rowCtx = useMemo(() => ({ room: roomId }), [roomId]);
  const startRow = useRow("composer", "start", { form: "desktop", context: rowCtx });
  const endRow = useRow("composer", "end", { form: p.mobile ? "phone" : "desktop", context: rowCtx });
  // voice notes (docs/VOICE-NOTES.md): while the room has a voice draft the recorder row replaces the box's content
  // threads: voice notes stay in the main composer for now (the recorder's draft belongs to the room)
  const voiceDraft = useVoiceDraft(roomId);
  const voice = p.thread ? undefined : voiceDraft;
  // Escape in review sets the draft aside (kept, shown as a pill above the box) and gives the text field back, focused;
  // the pill (or Ctrl/⌘+Enter on it) brings the review row back
  const [voiceAside, setVoiceAside] = useState(false);
  const reviewing = voice?.state === "review";
  useEffect(() => {
    if (!reviewing) setVoiceAside(false);
  }, [reviewing, voice?.id]);
  const showVoiceRow = !!voice && !(voiceAside && reviewing);

  // per-room memory: synced (debounced) while mounted, flushed on unmount and when the page goes away
  const live = useRef({ text, target, staged });
  live.current = { text, target, staged };
  // L1: the draft rules' state from the composer's own (the reply's name stays here, the rules don't need it)
  const draftNow = (t: string, tg: Target | null): DraftState<PickedMention> => ({
    text: t,
    marks: picked.current,
    target: tg?.kind ?? "",
    id: tg?.id ?? "",
    body: tg?.body ?? "",
    stash: stash.current,
  });
  /** One draft change through the shared rules (A09.0/A09.1/A09.4/A20.0); `name` = the reply's sender. */
  const step = (op: DraftOp<PickedMention>, name = "") => {
    const r = draftStep(draftNow(live.current.text, live.current.target), op);
    const n = r.st;
    stash.current = n.stash;
    picked.current = n.marks;
    const tg: Target | null = n.target ? { kind: n.target, id: n.id, body: n.body, name: n.target === "reply" ? name || (live.current.target?.kind === "reply" ? live.current.target.name : "") : "" } : null;
    live.current = { ...live.current, text: n.text, target: tg };
    setTarget(tg);
    setText(n.text);
    return r.fx;
  };
  const snapshot = useCallback(() => {
    const l = live.current;
    const cur = useChatStore.getState().memory[memKey];
    return {
      draft: draftToKeep(draftNow(l.text, l.target)),
      replyToId: l.target?.kind === "reply" ? l.target.id : "",
      replyToBody: l.target?.kind === "reply" ? l.target.body : "",
      replyToName: l.target?.kind === "reply" ? l.target.name : "",
      staged: p.floating ? (cur?.staged ?? []) : l.staged,
      atBottom: cur?.atBottom ?? true,
      topId: cur?.topId ?? "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);
  useEffect(() => {
    if (p.floating) return;
    const t = window.setTimeout(() => useChatStore.getState().remember(memKey, snapshot()), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, target, staged]);
  useEffect(() => {
    if (p.floating) return;
    const flush = () => {
      useChatStore.getState().remember(memKey, snapshot());
      persistChatMemory();
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);
  useEffect(
    () => () => {
      if (p.floating) live.current.staged.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      useChatStore.getState().remember(memKey, snapshot());
      stopTyping();
      if (!p.thread) leaveVoiceView(roomId); // a room switch stops a recording into review (the draft waits in this room's composer)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomId],
  );

  // ---- typing notices (primary view only; D7: refresh every 3 s while typing, timeout 4 s)
  const typing = useRef({ active: false, last: 0, timer: 0 });
  const stopTyping = useCallback(() => {
    const t = typing.current;
    window.clearTimeout(t.timer);
    if (t.active) {
      t.active = false;
      sendTyping(roomId, false);
    }
  }, [roomId]);
  const onTypingInput = (v: string, editing: boolean) => {
    if (!primary || p.floating) return;
    const t = typing.current;
    if (!v || editing) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (!t.active || now - t.last > 3000) {
      t.active = true;
      t.last = now;
      sendTyping(roomId, true);
    }
    window.clearTimeout(t.timer);
    t.timer = window.setTimeout(stopTyping, 4000);
  };

  // ---- autosize
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    const h = Math.min(144, Math.max(30, el.scrollHeight));
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > 144 ? "auto" : "hidden";
  }, [text, p.mobile]);

  const focus = useCallback(() => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true }); // the composer is always on screen; on iOS a scroll here pans the page (App)
    const n = el.value.length;
    el.setSelectionRange(n, n);
  }, []);

  const stage = useCallback((files: File[]) => {
    if (!files.length) return;
    setStaged((st) => [...st, ...files.map(toStaged)]);
    window.setTimeout(focus, 0);
  }, [focus]);

  const insert = useCallback((t: string) => {
    const el = field.current;
    if (!el) {
      setText((v) => v + t);
      return;
    }
    const a = el.selectionStart ?? el.value.length;
    const b = el.selectionEnd ?? a;
    const v = el.value.slice(0, a) + t + el.value.slice(b);
    // write the DOM at once (keys typed before React re-renders must not be clobbered)
    el.value = v;
    el.focus({ preventScroll: true });
    el.setSelectionRange(a + t.length, a + t.length);
    setText(v);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      startReply: (row) => {
        step({ op: "reply", id: row.eventId ?? row.id, body: snippetOf(row) }, displayName(peekClient()?.getRoom(roomId) ?? null, row.sender));
        window.setTimeout(focus, 0);
      },
      startEdit: (row) => {
        step({ op: "edit", id: row.eventId ?? row.id, body: row.body });
        window.setTimeout(focus, 0);
      },
      focus,
      stage,
      insert,
      hasTarget: () => !!live.current.target,
    }),
    [focus, stage, insert, roomId],
  );

  // ---- autocomplete (3.9)
  const recompute = (v: string, caret: number) => {
    const before = v.slice(0, caret);
    const mm = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (mm) {
      const q = mm[1].toLowerCase();
      const list: NonNullable<typeof popup>["items"] = [];
      if (q !== "" && "room".startsWith(q)) list.push({ key: "@room", label: "@room — everyone here", mention: { name: "room", userId: "@room", room: true }, seed: roomId });
      for (const m of members) {
        if (list.length >= 8 + (list[0]?.mention?.room ? 1 : 0)) break;
        const nm = m.rawName && m.rawName !== m.userId ? m.rawName : m.userId.replace(/^@/, "").split(":")[0];
        const lp = m.userId.replace(/^@/, "").split(":")[0].toLowerCase();
        if (nm.toLowerCase().includes(q) || lp.includes(q)) list.push({ key: m.userId, label: nm, mention: { name: nm, userId: m.userId }, seed: m.userId, avatar: m.avatarMxc });
      }
      setPopup(list.length ? { kind: "mention", start: caret - mm[1].length - 1, items: list.slice(0, 9), cur: 0 } : null);
      return;
    }
    const em = /(?:^|\s):([a-z0-9_+-]{2,})$/i.exec(before);
    if (em) {
      const hits = completeEmoji(em[1]);
      setPopup(hits.length ? { kind: "emoji", start: caret - em[1].length - 1, items: hits.map((h) => ({ key: h.e, label: `:${h.k.split(" ")[0]}:`, emoji: h })), cur: 0 } : null);
      return;
    }
    setPopup(null);
  };

  const pick = (i: number) => {
    const pp = popup;
    const el = field.current;
    if (!pp || !el) return;
    const it = pp.items[i];
    const caret = el.selectionStart ?? el.value.length;
    const ins = it.mention ? `@${it.mention.name} ` : `${it.emoji!.e} `;
    const v = el.value.slice(0, pp.start) + ins + el.value.slice(caret);
    if (it.mention && !it.mention.room) picked.current.push({ name: it.mention.name, userId: it.mention.userId });
    const pos = pp.start + ins.length;
    el.value = v;
    el.focus({ preventScroll: true });
    el.setSelectionRange(pos, pos);
    setText(v);
    setPopup(null);
  };

  // ---- send (3.7)
  // P21: "/word" that isn't a command asks first ("Unknown command — send as text?"); the text stays in the box
  const [slashAsk, setSlashAsk] = useState("");
  // 4-4: what the question is about, taken when it opens; "Send as text" sends only that (draftSame)
  const slashAsked = useRef<SendSnap<PickedMention> | null>(null);
  const sendSnap = (): SendSnap<PickedMention> =>
    JSON.parse(JSON.stringify({ room: roomId, state: draftNow(live.current.text, live.current.target), files: live.current.staged.map((f) => f.id) }));
  const send = () => sendMessage(false);
  const sendMessage = (asText: boolean) => {
    const t = text;
    const hasText = t.trim() !== "";
    // L1: what this send does comes from the shared draft rules (lib/composerDraft.ts); nothing changes until it goes
    const plan = draftStep(draftNow(t, target), { op: "send", files: staged.length }).fx;
    if (plan === "none") return;
    // P21: "Send as text" sends exactly what was typed (no face expansion: "/shrug-test" stays "/shrug-test")
    const expand = asText ? (x: string) => x.trim() : expandSlash;
    // 4-4: taken synchronously from what THIS send decides on, before the question can open (a later commit could
    // already hold a refused edit put back into the box)
    if (!asText) slashAsked.current = JSON.parse(JSON.stringify({ room: roomId, state: draftNow(t, target), files: staged.map((f) => f.id) }));
    if (hasText && !asText && target?.kind !== "edit" && unknownSlash(t)) {
      setSlashAsk(unknownSlash(t));
      return;
    }
    if (plan === "reply-needs-text") {
      notify("Type something to go with the reply, or cancel the reply first");
      return;
    }
    if (plan === "empty-edit") {
      notify("An edit can't be empty. To remove the message, use Delete in its menu.");
      return;
    }
    // 2026-10-23: a room this client hasn't synced yet would get it in the clear (actions.ts roomKnown) — keep the text
    if (!roomReadyToSend(roomId)) return;
    const th = threadCtx(p.thread, rows);
    if (hasText) {
      if (plan === "edit" && target) {
        const id = target.id;
        // A20.0: a refused edit comes back into the box (or, if the box is busy, says so); the row snaps back either way.
        // A09.3: the people picked while editing go with it.
        void editMessage(roomId, id, t, picked.current.slice()).then((cls) => {
          if (cls === null) return;
          if (!alive.current) return void toast(failText("edit", cls, false));
          notify(failText("edit", cls, step({ op: "failed", id, text: t }) === "put-back"));
          window.setTimeout(focus, 0);
        });
      } else if (plan === "unchanged") {
        // A09.4: nothing changed, nothing is sent (no "(edited)" on an identical message)
      } else if (target?.kind === "reply")
        // A5.2: the picked mentions keep their links (they used to be dropped while replying)
        sendReply(
          roomId,
          target.id,
          /^\/me\s+\S/i.test(t) ? "* " + expand(t.replace(/^\/me\s+/i, "")) : expand(t),
          picked.current.filter((m) => t.includes("@" + m.name)),
          th,
          rows.find((r) => r.eventId === target.id)?.sender,
        );
      else if (/^\/me\s+\S/i.test(t)) sendEmote(roomId, t.replace(/^\/me\s+/i, ""), th);
      else if (picked.current.length) {
        const livePicks = picked.current.filter((m) => t.includes("@" + m.name));
        if (livePicks.length) sendWithMentions(roomId, expand(t), livePicks, th);
        else sendText(roomId, expand(t), th);
      } else sendText(roomId, expand(t), th);
    }
    for (const f of staged) void sendAttachment(roomId, f.file, th);
    for (const f of staged) if (f.url) URL.revokeObjectURL(f.url); // the upload echo has its own URL
    if (plan !== "unchanged" || staged.length > 0) playSend();
    step({ op: "send", files: staged.length }); // the target is consumed; an edit gives the draft set aside back (A09.1)
    setStaged([]);
    setPopup(null);
    setEmojiOpen(false);
    stopTyping();
    p.onSent();
  };

  // A09.0: the bar's ✕ ("Cancel (Esc)") and Escape are the same: drop the reply/edit target, keep the typed text and the
  // staged files (it used to wipe both on one click). Leaving an edit gives back the draft it set aside (A09.1).
  const cancelTarget = () => {
    step({ op: "cancel" });
  };

  const editLast = (): boolean => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.mine && !r.echo && !r.redacted && !r.media && (r.msgtype === "m.text" || r.msgtype === "m.emote") && r.eventId) {
        step({ op: "edit", id: r.eventId, body: r.body });
        requestAnimationFrame(() => focus());
        return true;
      }
    }
    return false;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const pp = popup;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (pp) setPopup(null);
      else if (target) cancelTarget();
      else p.onEscapeEmpty();
      return;
    }
    if (pp && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const n = pp.items.length;
      setPopup({ ...pp, cur: (pp.cur + (e.key === "ArrowUp" ? n - 1 : 1)) % n });
      return;
    }
    if (pp && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      pick(pp.cur);
      return;
    }
    if (e.key === "ArrowUp" && !text && !target) {
      if (editLast()) e.preventDefault();
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      p.onPage(e.key === "PageUp" ? -1 : 1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (p.mobile) return; // phones: Enter = newline, the Send button sends
      e.preventDefault();
      send();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const it of Array.from(e.clipboardData.items)) {
      if (it.kind !== "file") continue;
      const f = it.getAsFile();
      if (!f) continue;
      if (f.type.startsWith("image/") && (!f.name || f.name === "image.png")) {
        const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        files.push(new File([f], pastedName(ext), { type: f.type }));
      } else files.push(f);
    }
    if (files.length) {
      e.preventDefault();
      stage(files);
    }
  };

  const canSend = text.trim() !== "" || staged.length > 0;

  // ---- the rows' elements (11.0 buttons): today's buttons for their actions (the composer's own commands), the
  // generic button for anything else — context-only composer actions run the composer's own commands through the run
  // path; everything else runs through the app's command map (features/actions/exec.ts)
  const rowHandlers: Record<string, Handler> = {
    "composer.attach": () => fileInput.current?.click(),
    "composer.emoji": (c) => (setPickAnchor(c.anchor ?? null), setEmojiOpen((o) => !o)),
    "composer.gif": (c) => (setPickAnchor(c.anchor ?? null), setGifOpen((o) => !o)),
    "room.pinned.open": (c) => (setPickAnchor(c.anchor ?? null), setPinsOpen(true)),
    "composer.send": () => send(),
  };
  const soundboardHosts = composerActions.filter((a) => !(p.floating && a.id.includes("soundboard")));
  const composerItem = (row: RowState, it: ItemOut, i: number) => {
    const key = `${it.a}:${i}`;
    if (p.floating && it.a === "soundboard.open") return null; // floating chats have no soundboard (as before)
    if (!bespokeOk(row, it)) return <RowButton key={key} row={row} item={it} handlers={rowHandlers} className={s.tb} />;
    let node: React.ReactNode;
    switch (it.a) {
      case "composer.attach":
        node = <ToolButton iconName="list-add-symbolic" tip="Attach a file or image (or drag one into the chat)" className={s.tb} onClick={() => fileInput.current?.click()} />;
        break;
      case "composer.emoji":
        node = p.mobile ? (
          <ToolButton ref={emojiBtn} iconName="face-smile-symbolic" tip="Insert emoji" className={s.tb} onMouseDown={(e) => e.preventDefault()} onClick={() => (setPickAnchor(null), setEmojiOpen((o) => !o))} />
        ) : (
          <ToolButton ref={emojiBtn} iconName="face-smile-symbolic" tip="Insert emoji (type :name: for quick search)" className={s.tb} onClick={() => (setPickAnchor(null), setEmojiOpen((o) => !o))} />
        );
        break;
      case "composer.gif":
        node = <ToolButton ref={gifBtn} iconName="image-x-generic" label="GIF" tip="Send a GIF" className={cx(s.tb, s.gifBtn)} onClick={() => (setPickAnchor(null), setGifOpen((o) => !o))} />;
        break;
      case "soundboard.open":
        // r.composerActions (media's soundboard button, and any feature's own — they keep their registry order here)
        return soundboardHosts.map((a) => <a.component key={`${key}:${a.id}`} roomId={roomId} insertText={insert} focusComposer={focus} />);
      case "room.pinned.open":
        node = <PinnedButton roomId={roomId} onJump={p.onJump} />;
        break;
      case "composer.send": {
        const sendNode = p.mobile ? (
          <GlowButton
            key={key}
            className={s.sendRound}
            icon="document-send-symbolic"
            aria-label={target?.kind === "edit" ? "Save" : "Send"}
            tip="Send"
            disabled={!canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
          />
        ) : (
          <GlowButton
            key={key}
            className={s.send}
            icon="document-send-symbolic"
            aria-label={target?.kind === "edit" ? "Save" : "Send"}
            text={p.narrow ? undefined : target?.kind === "edit" ? "Save" : "Send"}
            tip={target?.kind === "edit" ? "Save the edit" : "Send (Enter · Shift+Enter for a new line)"}
            disabled={!canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
          />
        );
        // an empty composer offers the mic instead (not while editing); where voice notes can't be recorded: Send as before
        // (a voice draft set aside: Send stays — the mic would start a second draft in this room)
        return !canSend && target?.kind !== "edit" && !voice && !p.thread ? <MicButton key={key} roomId={roomId} mobile={p.mobile} className={s.tb} fallback={sendNode} /> : sendNode;
      }
      default:
        return <RowButton key={key} row={row} item={it} handlers={rowHandlers} className={s.tb} />;
    }
    return it.state === "dimmed" ? <Dim key={key}>{node}</Dim> : <Fragment key={key}>{node}</Fragment>;
  };
  const placeholder = target?.kind === "edit" ? "Edit your message…" : target?.kind === "reply" ? "Reply…" : p.thread ? "Reply in thread…" : roomName ? `Message ${roomName}` : "Message";

  const section = (
    <>
      <div className={cx(s.bar, target && s.barOn)} aria-hidden={!target}>
        {target && (
          <div className={s.barInner}>
            <span className={s.barLine} />
            <div className={s.barCol}>
              <span className={s.barTitle}>{target.kind === "edit" ? "Editing message" : target.name ? `Replying to ${target.name}` : "Replying to a message"}</span>
              <span className={s.barText}>{target.body}</span>
            </div>
            <ToolButton iconName="window-close-symbolic" tip="Cancel (Esc)" className={s.barClose} onClick={() => { cancelTarget(); focus(); }} />
          </div>
        )}
      </div>
      {voice && !showVoiceRow && <VoicePill roomId={roomId} onOpen={() => setVoiceAside(false)} />}
      {staged.length > 0 && (
        <div className={s.staged}>
          {staged.map((f) => (
            <StagedItem
              key={f.id}
              f={f}
              onRemove={() => {
                if (f.url) URL.revokeObjectURL(f.url);
                setStaged((st) => st.filter((x) => x.id !== f.id));
              }}
            />
          ))}
        </div>
      )}
      <div className={cx(s.box, focused && s.boxFocus, (target || staged.length > 0) && s.boxTopGap)} data-composer-focus={focused ? "" : undefined} data-composer>
        {showVoiceRow ? (
          <VoiceRow
            roomId={roomId}
            mobile={p.mobile}
            narrow={p.narrow}
            onEscape={() => {
              setVoiceAside(true);
              window.setTimeout(focus, 0);
            }}
          />
        ) : (
        <>
        {p.mobile ? (
          <ToolButton ref={plusBtn} iconName="list-add-symbolic" tip="Add to your message" className={s.tb} onMouseDown={(e) => e.preventDefault()} onClick={() => setPlusOpen((o) => !o)} />
        ) : (
          <EditableRow row={startRow} title="Message box — left">
            {shownItems(startRow).map(({ item: it, i }) => composerItem(startRow, it, i))}
          </EditableRow>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            stage(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <div className={s.fieldWrap}>
          <textarea
            ref={field}
            className={s.field}
            rows={1}
            value={text}
            aria-label={placeholder}
            spellCheck
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              recompute(v, e.target.selectionStart ?? v.length);
              onTypingInput(v, target?.kind === "edit");
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onSelect={(e) => {
              if (popup) recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
            }}
          />
          {!text && (
            <span className={s.ph} aria-hidden>
              {placeholder}
            </span>
          )}
          {popup && (
            <div
              className={cx(s.popup, popup.kind === "emoji" && s.popupEmoji)}
              style={{ bottom: (field.current?.offsetHeight ?? 30) + FIELD_BOTTOM + 4 }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {popup.items.map((it, i) => (
                <div key={it.key} className={cx(s.popRow, popup.kind === "emoji" && s.popRowEmoji, i === popup.cur && s.popCur)} onMouseEnter={() => setPopup({ ...popup, cur: i })} onClick={() => pick(i)}>
                  {it.mention ? (
                    <>
                      <Avatar size={24} name={it.mention.room ? "@" : it.label} seed={it.seed} imageSource={it.avatar ?? null} />
                      <span className={s.popLabel}>{it.mention.room ? it.label : it.label}</span>
                    </>
                  ) : (
                    <>
                      <span className={s.popEmoji}>{it.emoji!.e}</span>
                      <span className={s.popKw}>{it.label}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={s.cluster}>
          <EditableRow row={endRow} title="Message box — right">
            {shownItems(endRow).map(({ item: it, i }) => composerItem(endRow, it, i))}
          </EditableRow>
        </div>
        </>
        )}
      </div>
      <EmojiPicker open={emojiOpen} onClose={() => (setEmojiOpen(false), setPickAnchor(null), focus())} anchor={pickAnchor ?? emojiBtn.current} stayOpen onPick={(e) => insert(e)} />
      {p.mobile && (
        <Menu open={plusOpen} onClose={() => setPlusOpen(false)} anchor={plusBtn.current} placement="above" title="Add to your message">
          <MenuItem text="Photo or file" icon="document-open-symbolic" onTriggered={() => fileInput.current?.click()} />
          <MenuItem text="GIF" icon="image-x-generic" onTriggered={() => setGifOpen(true)} />
          {pinnedIds.length > 0 && <MenuItem text={`Pinned messages (${pinnedIds.length})`} icon="window-pin-symbolic" onTriggered={() => setPinsOpen(true)} />}
          {composerActions.length > 0 && (
            <div className={s.sheetActions}>
              {composerActions
                .filter((a) => !(p.floating && a.id.includes("soundboard")))
                .map((a) => (
                  <SheetAction key={a.id} onDone={() => setPlusOpen(false)}>
                    <a.component roomId={roomId} insertText={insert} focusComposer={focus} />
                  </SheetAction>
                ))}
            </div>
          )}
        </Menu>
      )}
      <ConfirmDialog
        open={slashAsk !== ""}
        onClose={() => (setSlashAsk(""), focus())}
        dialogTitle={unknownSlashWords(slashAsk).title}
        message={unknownSlashWords(slashAsk).message}
        confirmText={unknownSlashWords(slashAsk).confirm}
        onConfirmed={() => {
          const asked = slashAsked.current;
          slashAsked.current = null;
          if (asked && draftSame(asked, sendSnap())) sendMessage(true);
          else notify("The message box changed, so nothing was sent. Check it and send again.");
        }}
      />
      <PinnedPopover roomId={roomId} open={pinsOpen} onClose={() => (setPinsOpen(false), setPickAnchor(null))} anchor={pickAnchor ?? plusBtn.current} onJump={p.onJump} />
      <GifPicker
        open={gifOpen}
        onClose={() => (setGifOpen(false), setPickAnchor(null))}
        anchor={pickAnchor ?? gifBtn.current ?? plusBtn.current}
        onPick={(url) => {
          sendPlain(roomId, url, threadCtx(p.thread, rows));
          focus();
        }}
      />
    </>
  );
  return (
    <div className={cx(s.bottom, p.mobile && s.mobile)}>
      <TypingStrip roomId={roomId} />
      {p.portal === undefined
        ? section
        : p.portal &&
          createPortal(
            <div className={cx(s.islandSection, !p.boxCard && s.islandBox, p.mobile && s.mobile)} data-composer-section="">
              {section}
            </div>,
            p.portal,
          )}
    </div>
  );
});

/** Phones' "+" sheet: another feature's icon-only composer action as a labelled, full-width row. The label is
 *  the button's own tooltip (aria-label) without its shortcut hint ("Soundboard — Ctrl+Shift+S" → "Soundboard");
 *  a tap anywhere on the row presses the button, then the sheet closes. */
function SheetAction({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState("");
  useLayoutEffect(() => {
    const l = ref.current?.querySelector("button")?.getAttribute("aria-label") ?? "";
    setLabel(l.split(/\s+[—–-]\s+/)[0]);
  });
  return (
    <div
      ref={ref}
      className={s.sheetAction}
      role="menuitem"
      onClick={(e) => {
        const btn = ref.current?.querySelector("button");
        if (btn && !(e.target as HTMLElement).closest("button")) btn.click();
        onDone();
      }}
    >
      {children}
      <span className={s.sheetActionLabel}>{label}</span>
    </div>
  );
}

function StagedItem({ f, onRemove }: { f: StagedFile; onRemove: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // QOL A08.7: the size too (the desktop's staged chip)
  const size = fmtSize(f.file.size);
  useTip(ref, size ? `${f.file.name} · ${size}` : f.file.name, { delay: 500 });
  return (
    <div ref={ref} className={cx(s.stItem, f.isImage ? s.stImage : s.stFile)}>
      {f.isImage ? (
        <AnimatedImage src={f.url} mime={f.file.type} alt={f.file.name} />
      ) : (
        <div className={s.stFileRow}>
          <Icon name="document-send-symbolic" size={18} color="var(--th-composer-staged-icon)" />
          <span>{f.file.name}</span>
          {size && <span className={s.stSize}>{size}</span>}
        </div>
      )}
      <button type="button" className={s.stX} aria-label="Remove" onClick={onRemove}>
        <Icon name="window-close-symbolic" size={12} color="var(--th-composer-staged-remove-icon)" />
      </button>
    </div>
  );
}

/** CHAT-113 — fixed-height strip; 3 dots + "X is typing…" (fades with the `slow` step).
 *  GPU.md §2.2: the dots are static — the lit dot moves one step only when the typing state changes (someone starts
 *  or stops typing), as a transition while the motion switch is on, never on a timer (it stepped every 400 ms). */
function TypingStrip({ roomId }: { roomId: string }) {
  const ids = useTyping(roomId);
  const room = peekClient()?.getRoom(roomId) ?? null;
  const names = ids.map((u) => displayName(room, u));
  const [dot, setDot] = useState(0);
  const on = names.length > 0;
  const who = ids.join("\n");
  const prevWho = useRef(who);
  useEffect(() => {
    if (prevWho.current === who) return;
    const was = prevWho.current;
    prevWho.current = who;
    if (!who) return; // stopped: the strip fades out as it is
    setDot((d) => (was ? (d + 1) % 3 : 0)); // appeared: first dot; someone else started / stopped: one step
  }, [who]);
  const label =
    names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : names.length > 2
          ? `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? "" : "s"} are typing…`
          : "";
  const last = useRef(label);
  if (label) last.current = label;
  return (
    <div className={s.typing} style={{ opacity: on ? 1 : 0 }} aria-live="polite">
      <span className={s.dots}>
        {[0, 1, 2].map((i) => (
          <span key={i} className={s.dot} style={{ opacity: i === dot ? 1 : 0.35 }} />
        ))}
      </span>
      <span className={s.typingLabel}>{last.current}</span>
    </div>
  );
}

