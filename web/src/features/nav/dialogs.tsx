// dialogs.tsx — every dialog the nav launches (qml/Main.qml newDmDialog, newRoomDialog,
// inviteDialog, joinOrCreateDialog, the shortcuts PromptDialog, joinConfirm, leaveConfirm,
// leaveSpaceConfirm, logoutConfirm, recordConfirm). One host (`NavDialogs`,
// mounted through r.overlays) renders whichever is open; anything opens one with
// `openNavDialog(...)` (or the bus `openNavDialog`). Copy is verbatim from the native.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { SERVER_LABEL } from "@/core/bearer";
import { toast, useBus } from "@/core/bus";
import { canSendState, getSession, logout, peekClient, useCryptoStatus } from "@/core/matrix";
import { BasicCheckBox, BasicTextField, ConfirmDialog, PromptDialog, useIsMobile } from "@/ui";
import sheet from "@/features/settings/dialogs.module.css";
import { createDm, createRoom, copyText, inviteToRoom, joinByLink, joinRoom, leaveRoom, setActivity, setRecording } from "./actions";
import { getCurrentRoom, openRoomId } from "./open";
import { dmTarget, serverOf } from "./dmTarget";
import { newRoomHint } from "./newRoom";
import { selectSpace, useNavStore } from "./model";
import s from "./dialogs.module.css";
import { changedActions, keysOf, useShortcutsRaw } from "@/actions/shortcutsStore";

/** One-action dialogs: the native's single right-aligned button; on a phone a bottom sheet with Cancel too (there's no
 *  Esc there, and closing by a tap outside wasn't obvious: iPhone/iPad sweep, 2026-10-25). */
function useOneAction(onClose: () => void) {
  const phone = useIsMobile();
  return {
    cancel: phone ? [{ text: "Cancel", role: "reject" as const, onClick: onClose }] : [],
    className: phone ? sheet.bottomSheet : s.oneAction,
  };
}

export type NavDialog =
  | { kind: "newChat"; mxid?: string }
  | { kind: "newRoom"; space?: boolean; parent?: string | null; parentName?: string }
  | { kind: "newSpace" }
  | { kind: "invite"; roomId: string; name: string }
  | { kind: "joinSpace" }
  | { kind: "joinConfirm"; roomId: string; name: string }
  | { kind: "leaveRoom"; roomId: string; name: string; wasOpen: boolean }
  | { kind: "leaveSpace"; spaceId: string; name: string }
  | { kind: "signOut" }
  | { kind: "shortcuts" }
  | { kind: "recordConfirm"; roomId: string }
  | { kind: "nowPlaying"; roomId: string; name: string };

export const useNavDialogs = create<{ open: NavDialog | null; seq: number }>()(() => ({ open: null, seq: 0 }));

export function openNavDialog(d: NavDialog): void {
  useNavDialogs.setState((st) => ({ open: d, seq: st.seq + 1 }));
}
export function closeNavDialog(): void {
  useNavDialogs.setState({ open: null });
}

/** Where a room goes after "Leave room" on the open room: back to the sidebar-only state. */
let onLeftOpenRoom: (() => void) | null = null;
export function setOnLeftOpenRoom(fn: (() => void) | null) {
  onLeftOpenRoom = fn;
}

export function NavDialogs() {
  const { open, seq } = useNavDialogs();
  // phones: back closes the dialog — the ConfirmDialog / PromptDialog primitives register on the shared
  // back stack themselves now (fix/polish item 5), so no second registration here.
  // the ONE keyboard-shortcuts dialog (INTEGRATION #1): the ☰ row, settings and anyone else emit this
  useBus("openShortcuts", () => openNavDialog({ kind: "shortcuts" }));
  useBus("loggedOut", () => closeNavDialog()); // NAV-08: sign-out tears everything down
  useBus("openNavDialog", (p) => {
    if (p.kind === "invite" && p.roomId) openNavDialog({ kind: "invite", roomId: p.roomId, name: peekClient()?.getRoom(p.roomId)?.name ?? "" });
    else if (p.kind === "newChat") openNavDialog({ kind: "newChat", mxid: p.mxid });
    else if (p.kind === "newRoom") {
      // same capture as ☰ New room…: the parent is the rail's real space at open time
      const st = useNavStore.getState();
      openNavDialog({ kind: "newRoom", space: false, parent: st.activeKey.startsWith("!") ? st.activeKey : null, parentName: st.activeLabel });
    }
    else if (p.kind === "newSpace") openNavDialog({ kind: "newRoom", space: true });
    else if (p.kind === "joinSpace") openNavDialog({ kind: "joinSpace" });
  });
  const close = closeNavDialog;
  if (!open) return null;
  switch (open.kind) {
    case "newChat":
      return <NewChatDialog key={seq} initial={open.mxid ?? ""} onClose={close} />;
    case "newRoom":
      return <NewRoomDialog key={seq} space={!!open.space} parent={open.parent ?? null} parentName={open.parentName ?? ""} onClose={close} />;
    case "newSpace":
      return <NewRoomDialog key={seq} space parent={null} parentName="" onClose={close} />;
    case "invite":
      return <InviteDialog key={seq} roomId={open.roomId} name={open.name} onClose={close} />;
    case "joinSpace":
      return <JoinSpaceDialog key={seq} onClose={close} />;
    case "shortcuts":
      return <ShortcutsDialog key={seq} onClose={close} />;
    case "joinConfirm":
      return (
        <ConfirmDialog
          key={seq}
          open
          onClose={close}
          dialogTitle={`Join ${open.name}?`}
          message="You'll show up in the member list, and everyone already in there will see you join."
          confirmText="Join"
          onConfirmed={() => {
            void joinRoom(open.roomId);
            openRoomId(open.roomId);
          }}
        />
      );
    case "leaveRoom":
      return (
        <ConfirmDialog
          key={seq}
          open
          onClose={close}
          dialogTitle="Leave room?"
          message={`Leave "${open.name}"? You'll need a new invite to rejoin if it's private.`}
          confirmText="Leave"
          destructive
          onConfirmed={() => {
            void leaveRoom(open.roomId).then((ok) => {
              // pop back only if the leave worked and that room is still the one on screen
              if (ok && getCurrentRoom() === open.roomId) onLeftOpenRoom?.();
            });
          }}
        />
      );
    case "leaveSpace":
      return (
        <ConfirmDialog
          key={seq}
          open
          onClose={close}
          dialogTitle="Leave space?"
          message={`Leave "${open.name}"? Its rooms stay joined; you'll need a new invite to get the space (and its calendar) back.`}
          confirmText="Leave"
          destructive
          onConfirmed={() => void leaveRoom(open.spaceId)}
        />
      );
    case "signOut":
      return <SignOutConfirm key={seq} onClose={close} />;
    case "recordConfirm":
      return (
        <ConfirmDialog
          key={seq}
          open
          onClose={close}
          dialogTitle="Record calls in this room?"
          confirmText="Start recording"
          destructive
          message={
            <span className={s.pre}>
              {
                'Calls in this room get recorded for the Memories tab — every stream and voice separately, so replays can switch points of view.\n\nNo extra participant appears: everyone in the call sees a 🔴 REC cue in their call header instead (and anyone who turned on "Never record me" in Settings → Calls is left out of the recording entirely — their cue says so). Stop any time with the ⏹ Rec button.'
              }
            </span>
          }
          onConfirmed={() => void setRecording(open.roomId, true)}
        />
      );
    case "nowPlaying":
      return <NowPlayingDialog key={seq} roomId={open.roomId} name={open.name} onClose={close} />;
  }
}

// ---- New chat -------------------------------------------------------------------------------------

function NewChatDialog({ initial, onClose }: { initial: string; onClose: () => void }) {
  const one = useOneAction(onClose);
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  // 2026-09-29: a plain username is enough ("alex" → @alex:<our server>); dmTarget = the desktop's dm_target
  const target = dmTarget(v, serverOf(getSession().userId));
  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    const seq = useNavDialogs.getState().seq;
    const id = await createDm(target);
    setBusy(false);
    if (id) {
      // createdRoom: the room opens; the dialog closes only if it is still the one on screen
      if (useNavDialogs.getState().seq === seq) onClose();
      openRoomId(id);
    }
  };
  return (
    <PromptDialog
      open
      onClose={onClose}
      title="New DM"
      actions={[...one.cancel, { text: "Message", icon: "document-edit-symbolic", disabled: !target || busy, onClick: () => void submit() }]}
      className={one.className}
    >
      <div className={s.body}>
        <div className={s.label}>Who do you want to message?</div>
        <BasicTextField
          className={s.field}
          placeholder="Their username, e.g. alex"
          aria-label="Username"
          autoComplete="off"
          spellCheck={false}
          value={v}
          autoFocus
          onChange={(e) => setV(e.target.value)}
          onAccepted={() => void submit()}
        />
        <div className={s.hint} data-dm-target={target ?? ""}>
          {!v.trim()
            ? "Just their username is enough. Someone on another server: @name:their.server."
            : target
              ? `Messages ${target}`
              : "That isn't a username — letters, numbers and . _ - only."}
        </div>
        <div className={s.hint}>If you already have a DM with them, it opens that one instead of starting a second.</div>
      </div>
    </PromptDialog>
  );
}

// ---- New room / space -------------------------------------------------------------------------------

function NewRoomDialog({ space: initialSpace, parent, parentName, onClose }: { space: boolean; parent: string | null; parentName: string; onClose: () => void }) {
  const one = useOneAction(onClose);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [priv, setPriv] = useState(true);
  const [space, setSpace] = useState(initialSpace);
  const [putIn, setPutIn] = useState(true);
  const [busy, setBusy] = useState(false);
  // "Put it in <space>" only when you may add rooms there (native offered it regardless and then
  // silently created the room outside the space — docs/native-bugs/nav.md)
  const mayAttach = !!parent && canSendState(parent, "m.space.child");
  const showPutIn = mayAttach && !space;
  const title = space ? "New space" : mayAttach ? `New room in ${parentName}` : "New room";
  const target = showPutIn && putIn ? parent : null;
  // 2026-10-23 (newRoom.ts, the desktop's new_room.rs hint — shared vectors): encrypted or not, in the same words
  const hint = newRoomHint({ space, isPrivate: priv, parent: target });
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const seq = useNavDialogs.getState().seq;
    const id = await createRoom({ name, topic, isPrivate: priv, space, parent: target });
    setBusy(false);
    if (id) {
      if (useNavDialogs.getState().seq === seq) onClose();
      // a new space is selected on the rail (native opened the space's own timeline as a room
      // page and left the rail on Home — docs/native-bugs/nav.md); a room opens
      if (space) selectSpace(id);
      else openRoomId(id);
    }
  };
  return (
    <PromptDialog
      open
      onClose={onClose}
      title={title}
      actions={[...one.cancel, { text: "Create", icon: "folder-new-symbolic", disabled: !name.trim() || busy, onClick: () => void submit() }]}
      className={one.className}
    >
      <div className={s.body}>
        <BasicTextField className={s.field} placeholder={space ? "Space name" : "Room name"} value={name} autoFocus onChange={(e) => setName(e.target.value)} onAccepted={() => void submit()} />
        {!space && <BasicTextField className={s.field} placeholder="What's it about? (optional)" value={topic} onChange={(e) => setTopic(e.target.value)} onAccepted={() => void submit()} />}
        <BasicCheckBox text="Private — people need an invite" checked={priv} onToggled={setPriv} />
        {showPutIn && <BasicCheckBox text={`Put it in ${parentName}`} checked={putIn} onToggled={setPutIn} />}
        {/* only a PUBLIC room in the space is open to its members; a private one still needs an invite */}
        {showPutIn && putIn && !priv && <div className={s.hint}>Everyone in {parentName} can open this room without waiting for an invite.</div>}
        {hint && (
          <div className={s.hint} data-new-room-hint="">
            {hint}
          </div>
        )}
        <BasicCheckBox text="Make this a space (a group of rooms)" checked={space} onToggled={setSpace} />
        <div className={s.hint}>Calls, the Media Party and the soundboard are set up for everyone here automatically.</div>
      </div>
    </PromptDialog>
  );
}

// ---- Invite -----------------------------------------------------------------------------------------

function InviteDialog({ roomId, name, onClose }: { roomId: string; name: string; onClose: () => void }) {
  const one = useOneAction(onClose);
  const [v, setV] = useState("");
  const label = name || roomId;
  const submit = () => {
    const t = v.trim();
    if (!t) return;
    void inviteToRoom(roomId, t);
    onClose();
  };
  return (
    <PromptDialog open onClose={onClose} title={`Invite to ${label}`} actions={[...one.cancel, { text: "Invite", icon: "list-add-user", disabled: !v.trim(), onClick: submit }]} className={one.className}>
      <div className={s.body}>
        <BasicTextField className={s.field} placeholder={`@someone:${SERVER_LABEL}`} value={v} autoFocus onChange={(e) => setV(e.target.value)} onAccepted={submit} />
        <div className={s.hint}>They'll get an invite they can accept or decline. Remove someone again from the member list on the right.</div>
      </div>
    </PromptDialog>
  );
}

// ---- Join a space -------------------------------------------------------------------------------------

function JoinSpaceDialog({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState("");
  const submit = () => {
    if (!v.trim()) return;
    const text = v;
    onClose();
    void joinByLink(text).then((id) => {
      if (id) openRoomId(id);
    });
  };
  return (
    <PromptDialog
      open
      onClose={onClose}
      title="Join a space"
      actions={[
        {
          text: "Make a space instead",
          icon: "folder-new-symbolic",
          onClick: () => openNavDialog({ kind: "newRoom", space: true, parent: null }),
        },
        { text: "Join", icon: "go-next-symbolic", disabled: !v.trim(), onClick: submit },
      ]}
    >
      <div className={s.body}>
        <BasicTextField className={s.field} placeholder="Paste an invite link" value={v} autoFocus onChange={(e) => setV(e.target.value)} onAccepted={submit} />
        <div className={s.hint}>Anything works: an invite link, a matrix.to link, or an address like #general:{SERVER_LABEL}.</div>
        <div className={s.hint}>Haven't got a link? Make your own space and invite people to it.</div>
      </div>
    </PromptDialog>
  );
}

// ---- Now playing (phones: the desktop's inline row editor as a prompt) -----------------------------------

function NowPlayingDialog({ roomId, name, onClose }: { roomId: string; name: string; onClose: () => void }) {
  const row = useNavStore.getState().rooms.find((r) => r.id === roomId) ?? useNavStore.getState().globalRooms.find((r) => r.id === roomId);
  const prevGame = row?.activity?.game ?? "";
  const prevCode = row?.activity?.code ?? "";
  const [v, setV] = useState(prevGame);
  const set = (game: string) => {
    void setActivity(roomId, game.trim(), prevGame, prevCode);
    onClose();
  };
  return (
    <PromptDialog
      open
      onClose={onClose}
      title={`Now playing in ${name}`}
      actions={[
        { text: "Clear", icon: "edit-clear-symbolic", disabled: !prevGame, onClick: () => set("") },
        { text: "Set", icon: "applications-games-symbolic", disabled: !v.trim(), onClick: () => set(v) },
      ]}
    >
      <div className={s.body}>
        <BasicTextField className={s.field} placeholder="What are you playing?" value={v} autoFocus onChange={(e) => setV(e.target.value)} onAccepted={() => v.trim() && set(v)} />
      </div>
    </PromptDialog>
  );
}

// ---- Keyboard shortcuts -------------------------------------------------------------------------------

export const SHORTCUT_ROWS: Array<[string, string]> = [
  ["Ctrl+K", "Jump to any room"],
  ["Ctrl+,", "Settings"],
  ["Alt+↑ / Alt+↓", "Previous / next room  (+Shift: unread only)"],
  ["Ctrl+Shift+M", "Mute / unmute your mic"],
  ["Ctrl+Shift+D", "Deafen / undeafen"],
  ["Ctrl (hold)", "Push to talk, when enabled"],
  ["Esc / F11", 'Leave / toggle "fill the app" in a call'],
  ["Ctrl+Shift+S", "Soundboard"],
  ["Ctrl+Shift+E", "Calendar"],
  ["PgUp / PgDn / Home / End", "Scroll the conversation"],
  ["Esc", "Cancel a reply or edit; jump to the newest message"],
  ["Ctrl+V", "Paste an image or file into the composer"],
  ["↑ (empty composer)", "Edit your last message"],
];

export const SHORTCUTS_BROWSER_NOTE =
  "In the browser: F11 is usually taken by the browser's own full screen — use the call bar's \"Fill the app\" button (Esc leaves it). If your browser keeps another of these keys for itself, the on-screen button does the same thing.";

/** 11.0: the rows with this device's keys (Settings → Shortcuts, ACTIONS.md §8) — a row whose action got keys of its
 *  own shows them; everything else reads exactly as before. The desktop's Main.qml shortcutsDialog does the same. */
export function shortcutRows(): Array<[string, string]> {
  const ch = changedActions();
  if (ch.size === 0) return SHORTCUT_ROWS;
  const k = (id: string) => keysOf(id).join(" / ") || "no key";
  return SHORTCUT_ROWS.map(([key, d]): [string, string] => {
    switch (key) {
      case "Ctrl+K":
        return [ch.has("nav.quickSwitcher.open") ? k("nav.quickSwitcher.open") : key, d];
      case "Ctrl+,":
        return [ch.has("app.settings.open") ? k("app.settings.open") : key, d];
      case "Alt+↑ / Alt+↓":
        return [ch.has("nav.room.previous") || ch.has("nav.room.next") ? `${k("nav.room.previous")} / ${k("nav.room.next")}` : key, d];
      case "Ctrl+Shift+M":
        return [ch.has("call.mic.toggle") ? k("call.mic.toggle") : key, d];
      case "Ctrl+Shift+D":
        return [ch.has("call.deafen.toggle") ? k("call.deafen.toggle") : key, d];
      case "Ctrl (hold)":
        return [ch.has("call.pushToTalk.hold") ? `${k("call.pushToTalk.hold")} (hold)` : key, d];
      case "Esc / F11":
        return [ch.has("call.fill.toggle") ? `Esc / ${k("call.fill.toggle")}` : key, d];
      case "Ctrl+Shift+S":
        return [ch.has("soundboard.open") ? k("soundboard.open") : key, d];
      case "Ctrl+Shift+E":
        return [ch.has("calendar.open") ? k("calendar.open") : key, d];
      default:
        return [key, d];
    }
  });
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useShortcutsRaw();
  return (
    <PromptDialog open onClose={onClose} title="Keyboard shortcuts" standardButtons={["close"]} className={s.shortcuts}>
      <div className={s.shortcutsBody}>
        <div className={s.grid}>
          {shortcutRows().map(([k, d]) => (
            <div key={k} className={s.gridRow}>
              <span className={s.key}>{k}</span>
              <span className={s.desc}>{d}</span>
            </div>
          ))}
        </div>
        {/* D13: keys the browser keeps for itself get their on-screen alternative named here */}
        <div className={s.shortcutsNote}>{SHORTCUTS_BROWSER_NOTE}</div>
      </div>
    </PromptDialog>
  );
}

// ---- Sign out ----------------------------------------------------------------------------------------

function SignOutConfirm({ onClose }: { onClose: () => void }) {
  const crypto = useCryptoStatus();
  const me = getSession().userId ?? "";
  const ready = crypto.backupEnabled;
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      dialogTitle="Sign out?"
      confirmText={ready ? "Sign out" : "Sign out anyway"}
      destructive
      message={
        ready
          ? `Sign out of ${me}? Your encryption keys are backed up on the server, so your encrypted messages will still be readable when you sign back in.`
          : `Sign out of ${me}? This account has no key backup. Signing out deletes this device's encryption keys, so the encrypted messages you can read now will become unreadable — here and on any new device. To keep them, set up recovery first (Settings → Security).`
      }
      onConfirmed={() => void logout()}
    />
  );
}

/** Focus helper for fields inside dialogs rendered through portals. */
export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
