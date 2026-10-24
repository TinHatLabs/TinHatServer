// watchparty/index.tsx — Watch party entry points: room menu "Call features › Media Party",
// the "A Media Party is on in this room" banner, the window registration.
import { useEffect, useState } from "react";
import { openWindow } from "@/core/bus";
import { peekClient, useRoomStateEvents } from "@/core/matrix";
import type { Registries } from "@/core/registry";
import { Button, Icon } from "@/ui";
import { installUnloadLeave, joinParty, useWatchParty, VIEWER_EVENT, VIEWER_TTL_MS } from "./engine";
import { WatchPartyWindow } from "./WatchPartyWindow";
import { MediaPartyButton, MediaPartyPhoneStrip } from "./CallBarPieces";
import s from "./Banner.module.css";

export { useWatchParty } from "./engine";

/** Join the room's party if not already in one (joinParty is destructive), then open/raise the window. */
export function openWatchParty(roomId: string): void {
  if (!roomId) return;
  if (!useWatchParty.getState().inParty) joinParty(roomId);
  openWindow("watchparty", { roomId: useWatchParty.getState().roomId || roomId });
}

/** Any live viewer in `roomId` (heartbeat within the 20 s TTL). */
export function watchPartyOn(roomId: string): boolean {
  const room = peekClient()?.getRoom(roomId);
  if (!room) return false;
  const now = Date.now();
  return room.currentState.getStateEvents(VIEWER_EVENT).some((ev) => {
    const last = Number(ev.getContent()?.lastSeen ?? 0);
    return last > 0 && now - last <= VIEWER_TTL_MS;
  });
}

export function useWatchPartyOn(roomId: string): boolean {
  const evs = useRoomStateEvents(roomId, VIEWER_EVENT);
  const [now, setNow] = useState(() => Date.now());
  const live = evs.filter((e) => {
    const last = Number((e.content as { lastSeen?: unknown }).lastSeen ?? 0);
    return last > 0 && now - last <= VIEWER_TTL_MS;
  });
  const soonest = live.reduce((m, e) => Math.min(m, Number((e.content as { lastSeen?: unknown }).lastSeen) + VIEWER_TTL_MS), Infinity);
  useEffect(() => {
    setNow(Date.now());
  }, [evs]);
  useEffect(() => {
    // recompute at the next expiry (and at least every 20 s while anything is live)
    if (!Number.isFinite(soonest)) return;
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(500, Math.min(20_000, soonest - Date.now() + 50)));
    return () => window.clearTimeout(t);
  }, [soonest, now]);
  return live.length > 0;
}

/** "A Media Party is on in this room" + Join (room page banner; hidden while I'm in a party). */
export function WatchPartyBanner({ roomId }: { roomId: string }) {
  const on = useWatchPartyOn(roomId);
  const inParty = useWatchParty((st) => st.inParty);
  if (!on || inParty) return null;
  return (
    <div className={s.banner}>
      <Icon name="video-television-symbolic" size={16} color="var(--th-banner-watch-party-icon)" />
      <span className={s.text}>A Media Party is on in this room</span>
      <Button text="Join" className={s.join} onClick={() => openWatchParty(roomId)} />
    </div>
  );
}

export function registerWatchParty(r: Registries, offs: Array<() => void>): void {
  offs.push(
    r.windows.add({
      id: "watchparty",
      order: 0,
      title: "Media Party — Tin Hat",
      icon: "video-television-symbolic",
      component: WatchPartyWindow,
      // native sizes are the CLIENT area; AppWindow sizes include its 30 px title bar
      defaultSize: { width: 576, height: 720 + 30 },
      minSize: { width: 360, height: 400 + 30 },
      // 11.4 (DESIGN §2.3): the first open sits beside the call pane (the native snaps beside the main window)
      defaultPlacement: "right",
    }),
  );
  offs.push(
    r.roomMenu.add({
      id: "media-watchparty",
      order: 600,
      section: "Call features",
      label: "Media Party",
      icon: "video-television-symbolic",
      enabled: (ctx) => !!ctx.roomId,
      run: (ctx) => openWatchParty(ctx.roomId),
    }),
  );
  offs.push(r.roomBanners.add({ id: "media-watchparty", order: 20, component: WatchPartyBanner }));
  // 11.4 (Media Party, DESIGN §2.2): the call bar's bespoke `watchParty.open` button + now-playing strip (callui's
  // CALLBAR_HOSTS maps the action to this item; order 86 = right after the soundboard pair, like the default row), and
  // the strip above the phone call's tiles (slot "phoneStrip", callui Mobile.tsx)
  offs.push(r.callBarItems.add({ id: "media-watchparty", order: 86, side: "center", component: MediaPartyButton }));
  offs.push(r.callBarItems.add({ id: "media-watchparty-phonestrip", order: 0, slot: "phoneStrip", component: MediaPartyPhoneStrip }));
  offs.push(installUnloadLeave());
}
