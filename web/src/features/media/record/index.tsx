// record/index.tsx — Memories recording marker (Rec), clip bookmarks (Clip), the 🔴 REC cue and "music into the
// call" menu items.
//
// Wire (tw-spec/media.md §4.1):
//   dev.tinhat.record    ""        {active:true, by:"@me"} on / {} off (anything but active:true = off)
//   dev.tinhat.clip      "<ms>"    {at: ms}
import { useState } from "react";
import { create } from "zustand";
import { toast } from "@/core/bus";
import { usePref } from "@/core/prefs";
import { recorderMxid, serverFeatureOn, useServerFeature } from "@/core/server";
import { canSendState, CLIP_TYPE, ensureWritable, getClient, inviteWithoutHistory, peekClient, RECORD_TYPE, sendState, useRoomState } from "@/core/matrix";
import type { Registries } from "@/core/registry";
import { ConfirmDialog, PromptDialog, BasicTextField, Icon, ToolButton, useIsMobile } from "@/ui";
import { getCall, isInCall, useCallAny, type AnyCall } from "../shared/call";
import { withRetry } from "../shared/retry";
import s from "./Record.module.css";

const RECORD_CONFIRM_MESSAGE =
  'Calls in this room get recorded for the Memories tab — every stream and voice separately, so replays can switch points of view.\n\nNo extra participant appears: everyone in the call sees a 🔴 REC cue in their call header instead (and anyone who turned on "Never record me" in Settings → Calls is left out of the recording entirely — their cue says so). Stop any time with the ⏹ Rec button.';

// ---- record ------------------------------------------------------------------------------------

export function recordOn(content: Record<string, unknown> | undefined): boolean {
  return !!content && content.active === true;
}

function errText(e: unknown): string {
  const any = e as { errcode?: string; data?: { errcode?: string; error?: string }; message?: string };
  return String(any?.data?.error ?? any?.message ?? e);
}

export async function setRecordCall(roomId: string, on: boolean): Promise<void> {
  const c = getClient();
  toast(on ? "Starting call recording…" : "Stopping call recording…");
  try {
    if (!on) {
      await withRetry(() => sendState(roomId, RECORD_TYPE, "", {}));
      toast("Recording stopped");
      return;
    }
    // the recorder's account is the server's announcement (core/server); without one there is nothing to invite
    const recorder = recorderMxid();
    if (!recorder) throw new Error("this server has no call recorder");
    // skip the invite when the recorder is already joined/invited (Synapse answers 403 "already in
    // the room", which is harmless but shows as a failed request in the console)
    const vodMembership = c.getRoom(roomId)?.getMember(recorder)?.membership;
    try {
      if (vodMembership !== "join" && vodMembership !== "invite") await withRetry(() => inviteWithoutHistory(roomId, recorder));
    } catch (e) {
      const t = errText(e);
      if (!/already in the room|already invited|is already/i.test(t)) throw new Error(`couldn't invite the recorder: ${t}`);
    }
    // best-effort: roles-derived power levels may need the managed type provisioned first (native ensure_writable)
    await ensureWritable(roomId, [RECORD_TYPE]).catch(() => undefined);
    try {
      await withRetry(() => sendState(roomId, RECORD_TYPE, "", { active: true, by: c.getUserId() ?? "" }));
    } catch (e) {
      const any = e as { errcode?: string; data?: { errcode?: string } };
      const t = errText(e);
      if (any?.errcode === "M_FORBIDDEN" || any?.data?.errcode === "M_FORBIDDEN" || /user_level|M_FORBIDDEN/.test(t)) {
        throw new Error("this room isn't unlocked for member recording yet — a room admin just needs to open the room once on the latest Tin Hat, then try again");
      }
      throw e;
    }
    toast("Recording on — the recorder joins the call when it starts");
  } catch (e) {
    toast(`Couldn't change recording: ${(e as Error)?.message ?? e}`, { kind: "error" });
  }
}

export async function clipMoment(roomId: string): Promise<void> {
  const at = Date.now();
  try {
    await withRetry(() => sendState(roomId, CLIP_TYPE, String(at), { at }));
    toast("Clipped — bookmarked on the Memories timeline");
  } catch (e) {
    toast(`Couldn't clip: ${errText(e)}`, { kind: "error" });
  }
}

// ---- dialogs host ---------------------------------------------------------------------------------

type DialogKind = "record" | "musicUrl";
const useDialogs = create<{ kind: DialogKind | null; roomId: string }>()(() => ({ kind: null, roomId: "" }));
export const openRecordConfirm = (roomId: string) => {
  if (serverFeatureOn("memories")) useDialogs.setState({ kind: "record", roomId });
};
export const openMusicUrlPrompt = () => useDialogs.setState({ kind: "musicUrl", roomId: "" });
const closeDialogs = () => useDialogs.setState({ kind: null });

export function RecordDialogsHost() {
  const { kind, roomId } = useDialogs();
  const [url, setUrl] = useState("");
  const startUrl = () => {
    const u = url.trim();
    if (!u) return;
    startMusic(u);
    closeDialogs();
  };
  return (
    <>
      <ConfirmDialog
        open={kind === "record"}
        onClose={closeDialogs}
        dialogTitle="Record calls in this room?"
        confirmText="Start recording"
        destructive
        message={RECORD_CONFIRM_MESSAGE}
        onConfirmed={() => void setRecordCall(roomId, true)}
      />
      <PromptDialog
        open={kind === "musicUrl"}
        onClose={() => {
          closeDialogs();
          setUrl("");
        }}
        title="Play music from URL"
        standardButtons={[]}
        actions={[{ text: "Play", icon: "media-playback-start-symbolic", role: "accept", disabled: !url.trim(), onClick: startUrl }]}
      >
        <BasicTextField
          className={s.urlField}
          autoFocus
          value={url}
          placeholder="https://…  (stream or audio file URL)"
          onChange={(e) => setUrl(e.target.value)}
          onAccepted={() => startUrl()}
        />
      </PromptDialog>
    </>
  );
}

// ---- music into the call (engine startMusic / stopMusic) -------------------------------------------

export function startMusic(fileOrUrl: File | string): void {
  const c = getCall();
  if (!isInCall(c) || typeof c.startMusic !== "function") {
    toast("Join a call to play music");
    return;
  }
  c.startMusic(fileOrUrl);
}

export function pickMusicFile(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".mp3,.flac,.ogg,.opus,.wav,.m4a,.aac,audio/*";
  input.title = "Play music in call";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) startMusic(f);
  };
  input.click();
}

// ---- call-header pieces ------------------------------------------------------------------------------

/** "Rec" ThToolButton (call status line, before Layout). */
export function RecButton({ roomId }: { roomId: string }) {
  const on = recordOn(useRoomState(roomId, RECORD_TYPE, ""));
  if (!useServerFeature("memories")) return null;
  return (
    <ToolButton
      iconName={on ? "media-playback-stop-symbolic" : "media-record-symbolic"}
      iconColor={on ? "var(--th-call-rec-button-icon-active)" : "var(--th-call-rec-button-icon)"}
      label="Rec"
      active={on}
      tip={on ? "Stop recording this room's calls" : "Record this room's calls — REC shows for everyone"}
      onClick={() => (on ? void setRecordCall(roomId, false) : openRecordConfirm(roomId))}
    />
  );
}

/** "Clip" — only while the recorder is really in the call. */
export function ClipButton({ roomId }: { roomId: string }) {
  const rec = useCallAny((c) => !!c.recActive);
  if (!rec) return null;
  return (
    <ToolButton
      iconName="bookmark-new-symbolic"
      label="Clip"
      tip="Bookmark this moment on the recording's timeline"
      onClick={() => void clipMoment(roomId)}
    />
  );
}

/** "· 🔴 REC" / "· 🔴 REC (not recording you)" — driven by the recorder's real presence. */
export function RecCue(_: { roomId?: string }) {
  const rec = useCallAny((c) => !!c.recActive);
  const optout = usePref("record-optout", false);
  if (!rec) return null;
  return <span className={s.cue}>{optout ? "· 🔴 REC (not recording you)" : "· 🔴 REC"}</span>;
}

/** Phones: round 44 px Rec / Clip buttons for the phone call's top bar (callui Mobile.tsx hosts the
 *  "statusRight" items there) — tooltips are dropped on touch, so the aria-label says it all. */
function PhoneRecGroup({ roomId }: { roomId: string }) {
  const on = recordOn(useRoomState(roomId, RECORD_TYPE, ""));
  const rec = useCallAny((c) => !!c.recActive);
  return (
    <span className={s.group}>
      <button
        type="button"
        className={`${s.mBtn} ${on ? s.mBtnOn : ""}`}
        aria-label={on ? "Stop recording this room's calls" : "Record this room's calls"}
        onClick={() => (on ? void setRecordCall(roomId, false) : openRecordConfirm(roomId))}
      >
        <Icon name={on ? "media-playback-stop-symbolic" : "media-record-symbolic"} size={22} color={on ? "var(--th-call-rec-button-icon-active)" : "var(--th-call-rec-button-icon)"} />
      </button>
      {rec && (
        <button type="button" className={s.mBtn} aria-label="Bookmark this moment on the recording's timeline" onClick={() => void clipMoment(roomId)}>
          <Icon name="bookmark-new-symbolic" size={22} color="var(--th-stage-top-button-icon)" />
        </button>
      )}
    </span>
  );
}

function RecGroup({ roomId }: { roomId: string }) {
  const mobile = useIsMobile();
  // selfhost/firstrun item 1: no recorder on this server → no Rec / Clip. The item stays registered (an empty
  // "statusRight" slot would bring back callui's fallback Rec, CallStage.tsx) and draws nothing.
  if (!useServerFeature("memories")) return null;
  if (mobile) return <PhoneRecGroup roomId={roomId} />;
  return (
    <span className={s.group}>
      <RecButton roomId={roomId} />
      <ClipButton roomId={roomId} />
    </span>
  );
}

// ---- registration ---------------------------------------------------------------------------------------

export function registerRecord(r: Registries, offs: Array<() => void>): void {
  offs.push(r.overlays.add({ id: "media-record-dialogs", order: 60, component: RecordDialogsHost }));
  // call status line: Rec + Clip (callui "statusRight" slot, before Layout = 30). callui draws the
  // 🔴 REC cue itself from recActive (RecCue is exported for other hosts). The room context-menu
  // record items live in features/nav and the music items in callui's call & device
  // menu (both call the same wire writes); media exports setRecordCall / startMusic.
  offs.push(r.callBarItems.add({ id: "media-rec-clip", order: 10, side: "right", component: RecGroup }));
}
