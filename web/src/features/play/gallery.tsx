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
import { conn, openGameWindow, receiveReact, setPlayDevIdentity, usePlay } from "./store";
import { GamePanelHost } from "./GamePanel";
import { CompactHost } from "./Stage";
import { PadGames } from "./PadGames";
import { GamesPane } from "./GamesPane";
import { RigTable } from "./RigTable";
import { artVars } from "./art";
import type { OpenView } from "./store";
import type { HoldemView, RigView } from "./wire";
import { HoldemTable } from "./HoldemTable";

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
    // ?sharing=1: I share my screen (the cards must stay face down, no peek)
    if (p.get("sharing") === "1") useCallStore.setState({ sharing: true } as never);
    // ?presence=1: a stand-in call presence for the seat avatars (B4): ben talking, dee muted, me talking
    if (p.get("presence") === "1")
      useCallStore.setState({
        speakers: { me: `${me}:GALLERY`, active: [`${me}:GALLERY`, "@ben:example.org:DEVB"] },
        micMuted: false,
        tiles: [
          { id: "b", participant: "@ben:example.org:DEVB", kind: "video", muted: false, name: "ben" },
          { id: "d", participant: "@dee:example.net:DEVD", kind: "avatar", muted: true, name: "dee" },
        ],
      } as never);
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
      // ?reacts=1 (F7, until the mock speaks 0.3.21): the owner says "react" in its hello, and a few reactions arrive
      // from the other seats (ben claps, dee tosses a coin to me, ben tips his hat, dee into the pot)
      if (p.get("reacts") === "1") {
        usePlay.setState((st) => ({ owners: { ...st.owners, [owner]: { ...(st.owners[owner] ?? { features: null, status: "unknown", error: "", rigHidden: false, wallets: null }), serverFeatures: ["react"] } } }));
        const seq: [string, number, string, (number | "pot")?][] = [["@ben:example.org", 4, "clap"], ["@dee:example.net", 6, "toss", 1], ["@ben:example.org", 4, "tip"], ["@dee:example.net", 6, "toss", "pot"]];
        let i = 0;
        let beat = 0;
        const tick = window.setInterval(() => {
          // the mock's hello has no feature list: keep the stand-in one over the connection's own
          if (!(usePlay.getState().owners[owner]?.serverFeatures ?? []).includes("react"))
            usePlay.setState((st) => ({ owners: { ...st.owners, [owner]: { ...st.owners[owner]!, serverFeatures: ["react"] } } }));
          const t = Object.keys(usePlay.getState().views)[0];
          if (!t || ++beat % 3) return; // one stand-in reaction every 1.5 s

          const [u, seat, rx, to] = seq[i++ % seq.length]!;
          receiveReact(owner, { t: "react", table: t, u, seat, r: rx, ...(to !== undefined ? { to } : {}), at: Date.now() });
        }, 500);
        window.addEventListener("pagehide", () => window.clearInterval(tick));
      }
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
  // ?fixture=holdem-away[&n=4]: Hold'em preflop as seat 1 with the 0.3.21 `away` object (addendum §8.1) on my seat and
  // on seat 4 (n = hands until stand-up): the B10 seat plates + I'm back, drawn from the frozen fixture + that field
  if (params().get("fixture") === "holdem-away") return <FixtureHoldemAway n={Number(params().get("n") ?? 4)} />;
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
        <CompactHost />
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
      // &away=1 (B10 on The Rig): me and one other player sitting out (the 0.3.21 `away` object)
      if (params().get("away") === "1") {
        const aw = { reason: "timeout" as const, since: Date.now() - 30_000, stand_at: Date.now() + 570_000, hands_left: 5 };
        if (view.you) view.you.away = aw;
        const other = view.players.find((p) => p.u !== meId && !p.left);
        for (const p of view.players) if (p.u === meId || p === other) p.away = aw;
      }
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

function FixtureHoldemAway({ n }: { n: number }) {
  const [ov, setOv] = useState<OpenView | null>(null);
  useEffect(() => {
    void import("../../../testvectors/games/views/holdem/04-flop.json").then((m) => {
      const step = (m as { default: { people: Record<string, string>; views: Record<string, unknown> } }).default;
      const view = JSON.parse(JSON.stringify(step.views.seat1)) as HoldemView;
      const meId = step.people.seat1 ?? "";
      const now = Date.now();
      const away = { reason: "timeout" as const, since: now - 40_000, stand_at: now + 560_000, hands_left: n };
      for (const x of view.seats) if (x.seat === 1 || x.seat === 4) x.away = away;
      if (view.you) {
        view.you.away = away;
        view.you.legal = null;
      }
      if (view.hand) view.hand.to_act = view.hand.to_act && view.hand.to_act.seat === 1 ? { ...view.hand.to_act, seat: 6 } : view.hand.to_act;
      setPlayDevIdentity(meId);
      setOv({ view, seenAt: Date.now(), owner: view.owner, space: view.space, room: view.room });
    });
  }, [n]);
  if (!ov) return null;
  return (
    <div style={{ position: "fixed", inset: 0, ...artVars() }} data-gallery-ready="">
      <HoldemTable ov={ov as OpenView & { view: HoldemView }} roomId={ov.room} />
    </div>
  );
}
