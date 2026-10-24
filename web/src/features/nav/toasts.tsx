// toasts.tsx — invites announce themselves.
//   SpaceInviteToasts   the new space-invite toast (qml/AppCore.qml:1435-1456): "<inviter> invited you to
//                       <space>" (4 s) + the "notify" UI sound, once per NEW invite — never for invites that
//                       existed at sign-in (the seen-set stays null until the first non-empty snapshot).
//   InviteAlerts        REACH A5.1: a NEW DM invite → the OS notification "<inviter> wants to chat" (a click
//                       opens it under People) + the notify sound; a NEW room invite → the same in-app toast as
//                       a space invite + the sound + the OS notification "<inviter> invited you to <room>".
//                       New = not pending at the first LIVE sync (invitewatch.ts); each once per session.
//                       The global switches apply: desktop notifications off → no OS notification; the
//                       notify sound off → silent (playUiSound checks snd.notify).
import { useEffect, useRef } from "react";
import { toast } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { showNote } from "@/core/notes";
import { getPref } from "@/core/prefs";
import { playUiSound } from "@/core/sounds";
import { InviteWatch } from "./invitewatch";
import { selectSpace, useNavStore, type RoomRow } from "./model";

export function SpaceInviteToasts() {
  const keys = useNavStore((st) => st.invitedSpaceKeys);
  const loaded = useNavStore((st) => st.loaded);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) {
      seen.current = null;
      return;
    }
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const st = useNavStore.getState();
    for (const k of keys) {
      if (seen.current.has(k)) continue;
      const e = st.spaces.find((sp) => sp.key === k);
      const who = e?.inviter || (e?.inviterMxid ? e.inviterMxid.replace(/^@([^:]+):.*/, "$1") : "") || "Someone";
      toast(`${who} invited you to ${e?.label || "a space"}`, { timeoutMs: 4000 });
      playUiSound("notify");
    }
    seen.current = new Set(keys);
  }, [keys, loaded]);
  return null;
}

/** Bring an invite's row (Accept / Decline) into view under `key`. */
function showInvite(key: string, roomId: string): void {
  try {
    window.focus();
  } catch {
    /* ignore */
  }
  if (location.hash.startsWith("#/room/")) location.hash = "#/home";
  selectSpace(key);
  window.requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-row][data-room-id="${CSS.escape(roomId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
  });
}

function announce(rows: RoomRow[]): void {
  const desk = getPref("desktop-notifications", "1") !== "0";
  for (const r of rows) {
    const who = r.inviter || "Someone";
    if (r.dm) {
      if (desk) showNote({ title: `${who} wants to chat`, tag: `invite:${r.id}`, silent: true, pushCovered: true, onClick: () => showInvite("people", r.id) });
    } else {
      const text = `${who} invited you to ${r.name || "a room"}`;
      toast(text, { timeoutMs: 4000 });
      if (desk) showNote({ title: text, tag: `invite:${r.id}`, silent: true, pushCovered: true, onClick: () => showInvite("home", r.id) });
    }
  }
  if (rows.length) playUiSound("notify");
}

export function InviteAlerts() {
  const rev = useNavStore((st) => st.rev);
  const live = useSession().liveSyncDone;
  const watch = useRef(new InviteWatch());
  useEffect(() => {
    if (!live) {
      watch.current.reset();
      return;
    }
    const invites = useNavStore.getState().globalRooms.filter((r) => r.membership === "invite" && !r.isSpace);
    const ids = invites.map((r) => r.id);
    if (!watch.current.seeded) {
      watch.current.seed(ids);
      return;
    }
    const fresh = watch.current.observe(ids);
    if (fresh.length) announce(invites.filter((r) => fresh.includes(r.id)));
  }, [rev, live]);
  return null;
}
