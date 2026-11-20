// gallery.tsx — #/__gallery/games (DEV builds only, no Matrix account): the real games UI against the play contract's
// MOCK (the frozen contract's fixtures, played step by step), reached through the dev server's /api proxy
// (`TH_DEV_SERVER=http://127.0.0.1:<mock port>`). A stand-in me in a stand-in call room; the room's space comes from
// the mock's own GET /rooms/{room}/space, so the space-error rooms (!nospace…, !remote…, !unavail…) show their states.
// For the real-pointer gate (tools/play-e2e.mjs) and the review screenshots.
//   #/__gallery/games?theme=oled|goose&ff=mobile&room=<room id>&me=<mxid>
import { useEffect, useState } from "react";
import { applyTheme } from "@/ui/themes";
import { useCallStore } from "@/features/calls";
import { useIsMobile } from "@/ui";
import { usePref } from "@/core/prefs";
import { GamesWindow } from "./GamesWindow";
import { OptInHost } from "./OptIn";
import { PlayHttpError } from "./net";
import { setDevRoomGame, type RoomGameWhy } from "./space";
import { conn, openGameWindow, setPlayDevIdentity, usePlay } from "./store";
import { GamePanelHost } from "./GamePanel";
import { PadGames } from "./PadGames";
import { GamesPane } from "./GamesPane";
import { RigTable } from "./RigTable";
import { artVars } from "./art";
import type { OpenView } from "./store";
import type { RigView } from "./wire";

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

export function GamesGallery() {
  const mobile = useIsMobile();
  const [room, setRoom] = useState("");
  const [table, setTable] = useState("");
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const p = params();
    applyTheme(p.get("theme") ?? "oled");
    const me = p.get("me") ?? "@you:mock.test";
    const r = p.get("room") ?? "!gamenight:mock.test";
    const owner = r.slice(r.indexOf(":") + 1);
    setPlayDevIdentity(me);
    useCallStore.setState({ inCall: true, callRoomId: r } as never);
    void (async () => {
      const c = await conn(owner);
      try {
        const a = (await c?.get(`/rooms/${encodeURIComponent(r)}/space`)) as { space?: string; server?: string } | undefined;
        setDevRoomGame({ why: "", space: a?.space ?? null, owner: a?.server ?? owner }, "Game Night");
      } catch (e) {
        const code = e instanceof PlayHttpError ? e.code : "unavailable";
        // wrong-server: the app's own rule found this owner; the owner's answer (the store's confirmation) refuses it
        if (code === "wrong-server") setDevRoomGame({ why: "", space: `!sp-hint:${owner}`, owner }, "Game Night");
        else setDevRoomGame({ why: code as RoomGameWhy, space: null, owner: null });
      }
      setRoom(r);
    })();
  }, []);
  // the stand-in call honours the app's collapse preference (the game panel collapses the call while it's open)
  const callCollapsed = usePref("ui-call-collapsed", "0") === "1";
  // the page follows the panel's own navigation (openGameWindow)
  const panelTable = usePlay((x) => x.panel?.table);
  useEffect(() => {
    if (panelTable !== undefined) setTable(panelTable);
  }, [panelTable]);
  if (!import.meta.env.DEV) return <div>The games gallery is in development builds only.</div>;
  if (!room) return null;
  // ?fixture=rig04&as=cy[&alone=1]: one frozen-contract view drawn as that person (alone=1: every other House member
  // disconnected: the Whisper warning's case; without it, the control)
  if (params().get("fixture") === "rig04") return <FixtureRig as={params().get("as") ?? "cy"} alone={params().get("alone") === "1"} />;
  // ?settings=1: Settings → Games (the spaces where I have chips, Delete my chips)
  if (params().get("settings") === "1")
    return (
      <div style={{ position: "fixed", inset: 0, overflow: "auto", padding: 24, background: "var(--th-surface-window)" }} data-gallery-ready="">
        <div style={{ maxWidth: 720 }}>
          <GamesPane />
        </div>
      </div>
    );
  // ?pad=1: the Pad's Games section as the phone shows it (the call room's tables; a table opens inside the Pad)
  if (params().get("pad") === "1")
    return (
      <div style={{ position: "fixed", inset: 0, overflow: "auto", padding: 12, background: "var(--th-pad-panel-bg)" }} data-gallery-ready="">
        <PadGames room={room} />
        <OptInHost />
      </div>
    );
  // ?panel=1: a stand-in shell (the room list; the call above the timeline above the composer) with the real game
  // panel covering the room's column
  if (params().get("panel") === "1")
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", gap: 8, padding: 8, background: "var(--th-surface-sunken)" }} data-gallery-ready="">
        <div style={{ flex: "0 0 300px", borderRadius: 12, background: "var(--th-island-bg-rooms)" }} data-island="rooms" />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ flex: callCollapsed ? "0 0 120px" : "0 0 55%", borderRadius: 12, background: "var(--th-island-bg-call)" }} data-island="call" data-collapsed={callCollapsed ? "1" : "0"} />
          <div style={{ flex: 1, borderRadius: 12, background: "var(--th-island-bg-timeline)" }} data-island="timeline" />
          <div style={{ flex: "0 0 64px", borderRadius: 12, background: "var(--th-island-bg-composer)" }} data-island="composer" />
        </div>
        <button type="button" data-testid="gallery-open-panel" onClick={() => openGameWindow(room, null)} style={{ position: "absolute", left: 24, bottom: 24 }}>
          Games
        </button>
        <GamePanelHost />
        <OptInHost />
      </div>
    );
  return (
    <div style={mobile ? { position: "fixed", inset: 0 } : { position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--th-surface-sunken)" }} data-gallery-ready="">
      <div style={mobile ? { position: "absolute", inset: 0 } : { position: "relative", width: 900, height: 700, borderRadius: 12, overflow: "hidden", border: "1px solid var(--th-border-subtle)", boxShadow: "0 20px 60px var(--th-island-shadow)" }}>
        <GamesWindow roomId={room} table={table} />
      </div>
      <OptInHost />
    </div>
  );
}

function FixtureRig({ as, alone }: { as: string; alone: boolean }) {
  const [ov, setOv] = useState<OpenView | null>(null);
  useEffect(() => {
    void import("../../../testvectors/games/views/rig/04-turn-full.json").then((m) => {
      const step = (m as { default: { people: Record<string, string>; views: Record<string, unknown> } }).default;
      const view = JSON.parse(JSON.stringify(step.views[as])) as RigView;
      const meId = step.people[as] ?? "";
      if (alone) for (const p of view.players) if (p.u !== meId && p.role !== "spinner") p.connected = false;
      setPlayDevIdentity(meId);
      setOv({ view, seenAt: Date.now(), owner: view.owner, space: view.space, room: view.room });
    });
  }, [as, alone]);
  if (!ov) return null;
  return (
    <div style={{ position: "fixed", inset: 0, ...artVars() }} data-gallery-ready="">
      <RigTable ov={ov as OpenView & { view: RigView }} roomId={ov.room} />
    </div>
  );
}
