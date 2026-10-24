// ActionsGallery.tsx — #/__gallery/actions: the buttons of step 3 without a session (the review captures, desktop
// counterpart ButtonsTest.qml): today's rows from the default rows (idle / in a call), a button island of your own in
// every look and scale (toggles on and off, unavailable, a newer Tin Hat's button, a destructive one, buttons with a
// target), and the Ctrl+K palette over a sample world (?q=<query> opens it; ?stage=<action id> at stage 2).
// OLED | Goose side by side like the rest of the gallery.
import { useEffect, type CSSProperties, type ReactNode } from "react";
import type { JObj, Json } from "../../layout/json";
import { themeVars, type ThemeName } from "@/ui";
import { ButtonRow } from "./ButtonRow";
import { defaultRowValue } from "../rows";
import { registerSnapshotProvider } from "../snapshot";
import { QuickSwitcherHost, openQuickSwitcher, useNavStore } from "@/features/nav";

const ROOM = "!gallery:example.com";
const OTHER = "!valheim:example.com";
const baseValues = {
  "ui.roomOpen": true, "presence.known": true, "gif.available": true, "platform.screenCapture": true,
  "prefs.callLayout": "auto", "prefs.nsMode": "standard", "prefs.echoCancel": true, "update.state": "none",
  "prefs.theme": "goose", "calendar.hasContainer": true,
};
function world(inCall: boolean): JObj {
  const values: Record<string, unknown> = { ...baseValues };
  if (inCall) {
    Object.assign(values, {
      "call.in": true, "ui.callShown": true, "call.micMuted": true, "call.cameraOn": true, "call.sharing": false,
      "call.recActive": true, "call.soundPlaying": true, "call.soundName": "Bruh", "call.hasSavedAudioSource": true,
    });
  }
  return {
    values,
    current: { room: ROOM, activeSpace: "!space:example.com" },
    subjects: {
      room: {
        [ROOM]: { name: "Gaming Central", values: { "room.joined": true, "room.current": true, "room.inSpace": true, "room.hasPinned": true, "room.pinnedCount": "3", "room.callLive": inCall, "room.inCall": inCall, "room.recordOn": inCall } },
        [OTHER]: { name: "Valheim", values: { "room.joined": true, "room.callLive": true } },
      },
      space: { "!space:example.com": { name: "Example", values: { "space.joined": true, "space.canManage": true } } },
      theme: { oled: { name: "OLED", values: {} }, goose: { name: "Goose", values: {} } },
      sound: { "mxc://example.com/bruh": { name: "Bruh", values: {} } },
    },
  } as unknown as JObj;
}
const ISLAND: { items: Json[] } = {
  items: [
    { a: "call.mic.toggle" }, { a: "call.deafen.toggle" }, { a: "call.camera.toggle" }, { a: "call.leave" },
    { a: "call.join", target: { room: OTHER } }, { a: "sound.play", target: { sound: "mxc://example.com/bruh" } },
    { a: "status.set", target: { status: "lfg" } }, { a: "app.theme.set", target: { theme: "goose" } },
    { a: "app.reduceMotion.toggle" }, { a: "call.teleport" }, { a: "calendar.open" },
  ],
};
const ROWS: [string, string, string][] = [
  ["header", "main", "header.main"],
  ["account", "main", "account.main"],
  ["rooms", "header", "rooms.header"],
  ["composer", "start", "composer.start"],
  ["composer", "end", "composer.end"],
  ["call", "status", "call.status"],
  ["call", "bar", "call.bar"],
];

function Themed({ theme, children }: { theme: ThemeName; children: ReactNode }) {
  const vars = themeVars(theme) as CSSProperties;
  return (
    <div data-theme={theme} style={{ ...vars, background: "var(--th-surface-window)", color: "var(--th-text-primary)", padding: 16, display: "flex", flexDirection: "column", gap: 10, flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 700 }}>{theme}</div>
      {children}
    </div>
  );
}
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 44 }}>
      <div style={{ width: 150, flex: "none", fontSize: 12, color: "var(--th-text-secondary)" }}>{label}</div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function ActionsGallery() {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const q = params.get("q");
  const stage = params.get("stage");
  useEffect(() => {
    // the palette's world: the in-call snapshot + a room list
    const off = registerSnapshotProvider("gallery", () => world(true) as never);
    useNavStore.setState({
      globalRooms: [
        // two pending invites (Ctrl+K lists them first, newest first — ACTIONS.md §10.1; the room list puts them on top)
        { id: "!invsam:example.com", name: "Sam", unread: 0, dm: true, membership: "invite", alias: "", peer: "@sam:example.com", invitedAt: 2000 },
        { id: "!invmovie:example.com", name: "Movie night 2", unread: 0, dm: false, membership: "invite", alias: "", invitedAt: 1000 },
        { id: ROOM, name: "Gaming Central", unread: 2, dm: false, membership: "join", alias: "#gaming:example.com" },
        { id: OTHER, name: "Valheim", unread: 0, dm: false, membership: "join", alias: "" },
        { id: "!jordan:example.com", name: "Jordan", unread: 1, dm: true, membership: "join", alias: "", peer: "@jordan:example.com" },
        { id: "!movie:example.com", name: "Movie night", unread: 0, dm: false, membership: "join", alias: "" },
      ].map((r) => ({ avatar: "", highlight: false, rawUnread: 0, favourite: false, call: false, notifyMode: "all", muted: false, participants: [], activity: null, statuses: [], publicJoin: false, isSpace: false, recency: null, peer: "", ...r })) as never,
    });
    if (q !== null || stage !== null) {
      const t = window.setTimeout(() => {
        openQuickSwitcher(stage ?? undefined);
        if (q) {
          const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
          if (input) {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            set?.call(input, q);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }, 300);
      return () => (window.clearTimeout(t), off());
    }
    return off;
  }, [q, stage]);
  const idle = world(false);
  const call = world(true);
  const ctx = { room: ROOM };
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {(["oled", "goose"] as ThemeName[]).map((theme) => (
        <Themed key={theme} theme={theme}>
          {ROWS.map(([isl, rn, rk]) => (
            <div key={rk}>
              <Line label={`${rk} — idle`}>
                <ButtonRow row={rk} value={defaultRowValue(isl, rn) ?? undefined} snapshot={idle} context={rk.startsWith("composer") || rk.startsWith("call") ? ctx : undefined} onRun={() => {}} />
              </Line>
              <Line label={`${rk} — in a call`}>
                <ButtonRow row={rk} value={defaultRowValue(isl, rn) ?? undefined} snapshot={call} context={rk.startsWith("composer") || rk.startsWith("call") ? ctx : undefined} onRun={() => {}} />
              </Line>
            </div>
          ))}
          {(["icon", "iconLabel", "label"] as const).map((look) =>
            (["S", "M"] as const).map((scale) => (
              <Line key={look + scale} label={`buttons island — ${look} ${scale}`}>
                <ButtonRow row="buttons.main" value={{ ...ISLAND, look, scale } as unknown as Json} snapshot={call} wrap onRun={() => {}} />
              </Line>
            )),
          )}
          <Line label="buttons island — idle">
            <ButtonRow row="buttons.main" value={{ ...ISLAND, look: "iconLabel", scale: "S" } as unknown as Json} snapshot={idle} wrap onRun={() => {}} />
          </Line>
          <Line label="edit mode (hidden items faint)">
            <ButtonRow row="buttons.main" value={{ items: [{ a: "call.leave", hideWhenOff: true }, { a: "call.teleport", hideWhenOff: true }, { a: "soundboard.open" }] } as unknown as Json} snapshot={idle} editing onRun={() => {}} />
          </Line>
        </Themed>
      ))}
      <QuickSwitcherHost />
    </div>
  );
}
