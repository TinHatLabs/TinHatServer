// Effects.tsx — always-mounted call-UI plumbing (r.overlays): status / error toasts (CUI-12, 13), leave
// cleanup (CUI-14), volume re-apply after join (CUI-165), push-to-talk key (CUI-155), quit confirm
// (CUI-163), "pulled you aside" toast (CUI-164), the phone's minimised call pill, and the devices
// menu opened from outside the call bar (header gear → bus "openCallDevicesMenu").
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useBus, type BusEvents } from "@/core/bus";
import { peekClient } from "@/core/matrix";
import { useIsMobile, type Rect } from "@/ui";
import { act, getC, setUiState, ui, useC, useCallUi } from "./store";
import { resetSession } from "./memory";
import { DevicesMenu, ParticipantVolumeMenu } from "./menus";
import { MobileCallPill } from "./Mobile";
import { NavCallStrip, useRoomCallLive } from "./NavStrip";
import { CallHeaderButton, CallHeaderGear } from "./HeaderButtons";
import { eventKeyName } from "@/core/shortcuts";
import { pttKeys } from "@/actions/shortcutsStore";

/** Push to talk's key (ACTIONS.md §8.4: a modifier held alone or an F-key). */
const isPtt = (e: KeyboardEvent): boolean => {
  const n = eventKeyName(e);
  return n !== null && pttKeys().includes(n);
};

// ---- devices menu from outside (room header gear) -----------------------------------------------

const useDevMenu = create<{ anchor: HTMLElement | Rect | null; roomId: string }>()(() => ({ anchor: null, roomId: "" }));

export function openCallDevicesMenu(anchor: HTMLElement | Rect | null, roomId?: string) {
  act("refreshInputs")();
  act("refreshOutputs")();
  act("refreshCameras")();
  useDevMenu.setState({ anchor: anchor ?? { x: window.innerWidth - 60, y: 60, width: 0, height: 0 }, roomId: roomId ?? getC().callRoomId ?? "" });
}


export function CallEffects() {
  const inCall = useC("inCall");
  const shown = useC("shown");
  const fake = useC("fake");
  const pushToTalk = useC("pushToTalk");
  const callRoom = useC("callRoomId");
  const mobile = useIsMobile();
  const min = useCallUi((x) => x.mobileMin);
  const dev = useDevMenu();
  const [hash, setHash] = useState(location.hash);

  useBus("openCallDevicesMenu", (p) => openCallDevicesMenu(p.anchor ?? null, p.roomId));
  // CUI-152: nav's call strip right-click / long-press → the per-person menu (INTEGRATION #9)
  const [partMenu, setPartMenu] = useState<BusEvents["openParticipantMenu"] | null>(null);
  useBus("openParticipantMenu", (p) => setPartMenu(p));

  // CUI-12 / CUI-13 status + error toasts are raised by features/calls/index.tsx (CALL-19:
  // statusRev → 3 s toast, lastError → 6 s error toast). The call UI toasting them too showed every
  // line twice in a real call ("Joining call…" ×2, "In call" ×2) — so nothing here.

  // CUI-14 leave cleanup + CUI-165 volume re-apply (join, then 4× every 1.5 s)
  const wasIn = useRef(false);
  useEffect(() => {
    if (inCall && !wasIn.current) {
      act("reapplyAll")();
      let n = 0;
      const iv = window.setInterval(() => {
        act("reapplyAll")();
        if (++n >= 4) window.clearInterval(iv);
      }, 1500);
      wasIn.current = true;
      return () => window.clearInterval(iv);
    }
    if (!inCall && wasIn.current) {
      wasIn.current = false;
      resetSession();
      if (!fake) setUiState({ maximized: false });
    }
  }, [inCall, fake]);
  useEffect(() => {
    if (!shown && !inCall) setUiState({ maximized: false });
  }, [shown, inCall]);

  // CUI-155 push-to-talk: hold its key (Ctrl unless Settings → Shortcuts moved it) while PTT is on and the window has
  // focus; auto-repeat ignored
  useEffect(() => {
    if (!inCall || !pushToTalk) return;
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (!isPtt(e) || e.repeat || held) return;
      held = true;
      act("pttHold")(true);
    };
    const up = (e: KeyboardEvent) => {
      if (!isPtt(e) || !held) return;
      held = false;
      act("pttHold")(false);
    };
    const blur = () => {
      if (held) {
        held = false;
        act("pttHold")(false);
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      blur();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, [inCall, pushToTalk]);

  // CUI-163 quit confirm (the browser's own prompt)
  useEffect(() => {
    if (!inCall) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Leave the call and quit?";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [inCall]);

  // CUI-164 "pulled you aside" toast + notify sound: raised by the engine when the pull arrives
  // (features/calls topics.ts, CALL-97) — a second copy here doubled it.

  useEffect(() => {
    const f = () => setHash(location.hash);
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);

  const callShown = shown || inCall || fake;
  // phones: the pill when the call is minimised, or when no room page is open (the list — the stage lives
  // in the room page, so without this the call would vanish from view on "back")
  const showPill = mobile && callShown && (min || !/^#\/room\//.test(hash));
  return (
    <>
      {showPill && (
        <div>
          <MobileCallPill roomId={callRoom || (fake ? decodeURIComponent(/#\/room\/([^/?]+)/.exec(hash)?.[1] ?? "") : "")} />
        </div>
      )}
      <DevicesMenu anchor={dev.anchor} roomId={dev.roomId} onClose={() => useDevMenu.setState({ anchor: null })} />
      {partMenu && (
        <ParticipantVolumeMenu
          key={partMenu.userId + partMenu.roomId}
          mxid={partMenu.userId}
          roomId={partMenu.roomId}
          anchor={partMenu.anchor}
          onClose={() => setPartMenu(null)}
        />
      )}
      {NAVSTRIP_DEMO && <NavStripDemo hash={hash} />}
    </>
  );
}

export { ui };

// QA only (`?navstripdemo=1`): the nav call strip + the header call button/gear for the open room in a 360 px
// column, since features/nav and chat are stubs in this worktree. Never shown without the flag.
const NAVSTRIP_DEMO = /[?&]navstripdemo=1/.test(location.search);
function NavStripDemo({ hash }: { hash: string }) {
  const roomId = decodeURIComponent(/#\/room\/([^/?]+)/.exec(hash)?.[1] ?? "");
  const live = useRoomCallLive(roomId);
  if (!roomId) return null;
  return (
    <div style={{ position: "fixed", left: 0, top: 170, width: 360, background: "var(--th-surface-island)", borderRight: "1px solid var(--th-border-subtle)", padding: "6px 0", zIndex: 50 }} data-testid="navstrip-demo">
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px" }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: live ? "var(--th-accent-bright)" : "transparent" }} />
        <span style={{ flex: 1 }}>{peekClient()?.getRoom(roomId)?.name ?? roomId}</span>
        <CallHeaderButton roomId={roomId} />
        <CallHeaderGear roomId={roomId} />
      </div>
      <NavCallStrip roomId={roomId} selected />
    </div>
  );
}
