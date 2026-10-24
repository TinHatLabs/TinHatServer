// Tour.tsx — Tour.qml: the first-run tour (Kirigami OverlaySheet, no close button) — 7 cards in a
// swipeable 432 × 234 pager, dots, Skip / Back / Next / Done. Opened from the calm first run's offer card or from
// Settings → About & help → "Take the tour" (card 1); any dismissal persists `tour_seen = 1`.
// selfhost/firstrun: the calm first run never opens it by itself — the footer's "Take a 1-minute tour" card offers it
// (features/selfhost); a server without Memories gets a first card without them.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useBus } from "@/core/bus";
import { onSessionEnding } from "@/core/matrix";
import { setPref } from "@/core/prefs";
import { useServerFeature } from "@/core/server";
import { Button, GlowButton, Icon, OverlaySheet } from "@/ui";
import s from "./Tour.module.css";

const CARDS: Array<[string, string, string]> = [
  [
    "video-display-brightness-symbolic",
    "Built for game nights",
    "Share your screen in high quality, hear everyone separately with your own per-person volumes, and record the call for Memories to relive later. Encrypted, self-hosted, and yours — in the browser or the Tin Hat app.",
  ],
  [
    "view-list-details-symbolic",
    "Find your way around",
    'A persistent Discord-style Spaces sidebar — or tuck it into a corner dock to spare an OLED panel (toggle in ☰ → "Tuck nav into corner"). Drag the space bubbles to reorder them however you like.',
  ],
  ["preferences-desktop-color", "Make it yours", "Two hand-tuned themes — OLED and Goose — all under ☰ → Theme. The chrome recolors to match, instantly."],
  [
    "call-start-symbolic",
    "Hop into a call",
    "Join a room's call, then toggle your mic, camera, or a screen-share. Dial in the share resolution, frame rate, and codec any time from the gear ▾ in the top-right of the room header.",
  ],
  [
    "mail-message-symbolic",
    "Chat like a pro",
    "Markdown, reactions, replies, @mentions, and GIFs — plus drag-and-drop files right into the composer. Hit Ctrl+K any time for the quick room switcher.",
  ],
  [
    "audio-input-microphone-symbolic",
    "Two people, one corner",
    "Right-click anyone in a call (or the ⋯ on their tile) → Pull aside: just the two of you, everyone else drops to 10 %. Right-click a room → Pop out chat for a floating window that stays over your game.",
  ],
  [
    "applications-games-symbolic",
    "Game on",
    // selfhost/firstrun: the ☰ menu has no "Help & tour" since 11.2 (menu clean-up) — the tour lives in Settings
    'Set what you\'re playing and a "looking to play" status so friends know you\'re up for a game. That\'s the tour — you\'re all set! Take it again any time from Settings → About & help.',
  ],
];

/** The first card on a server without Memories (selfhost/firstrun item 1): the same words minus the recording. */
const FIRST_CARD_NO_MEMORIES =
  "Share your screen in high quality and hear everyone separately with your own per-person volumes. Encrypted, self-hosted, and yours — in the browser or the Tin Hat app.";

/** The chat card on a server without the GIF picker (docs/SELFHOST.md): the same words minus the GIFs. */
const CHAT_CARD_NO_GIFS = "Markdown, reactions, replies and @mentions — plus drag-and-drop files right into the composer. Hit Ctrl+K any time for the quick room switcher.";

/** The cards for this server: without Memories, the first card doesn't promise them; without GIFs, the chat card
 *  doesn't either. */
export function tourCards(on: { memories: boolean; gifs: boolean }): Array<[string, string, string]> {
  return CARDS.map((c, i): [string, string, string] => (i === 0 && !on.memories ? [c[0], c[1], FIRST_CARD_NO_MEMORIES] : i === 4 && !on.gifs ? [c[0], c[1], CHAT_CARD_NO_GIFS] : c));
}

const useTour = create<{ open: boolean; step: number }>()(() => ({ open: false, step: 0 }));

export function startTour(fromMenu = false): void {
  void fromMenu;
  useTour.setState({ open: true, step: 0 });
}

export function TourHost() {
  const { open, step } = useTour();
  useBus("openTour", () => startTour(true));
  useBus("loggedOut", () => useTour.setState({ open: false }));
  // never left up while the account is going away (fix/polish item 2)
  useEffect(() => onSessionEnding(() => useTour.setState({ open: false })), []);

  const cards = tourCards({ memories: useServerFeature("memories"), gifs: useServerFeature("gifs") });
  const close = () => {
    setPref("tour_seen", "1");
    useTour.setState({ open: false });
  };
  // phones: the back button leaves the tour like Skip (marks it seen) — OverlaySheet's own back-stack
  // entry calls onClose = close (fix/polish item 5)
  const go = (n: number) => useTour.setState({ step: Math.max(0, Math.min(CARDS.length - 1, n)) });

  // swipe
  const drag = useRef<{ x: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);

  if (!open) return null;
  const last = step === CARDS.length - 1;
  return (
    <OverlaySheet open onClose={close} title="Welcome to Tin Hat" showCloseButton={false} preferredWidth={432} scroll={false}>
      <div className={s.col}>
        <div
          className={s.pager}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, id: e.pointerId };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => drag.current && setDx(e.clientX - drag.current.x)}
          onPointerUp={() => {
            if (dx < -60) go(step + 1);
            else if (dx > 60) go(step - 1);
            drag.current = null;
            setDx(0);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDx(0);
          }}
        >
          <div className={s.track} style={{ transform: `translateX(calc(${-step * 100}% + ${dx}px))`, transition: drag.current ? "none" : undefined }}>
            {cards.map(([icon, title, body]) => (
              <div key={title} className={s.card}>
                <div className={s.art}>
                  <span className={s.glow} />
                  <Icon name={icon} size={64} color="var(--th-tour-art-icon)" />
                </div>
                <div className={s.title}>{title}</div>
                <div className={s.body}>{body}</div>
              </div>
            ))}
          </div>
        </div>
        <div className={s.dots}>
          {cards.map((_, i) => (
            <span key={i} className={s.dot} data-on={i === step ? "" : undefined} />
          ))}
        </div>
        <div className={s.buttons}>
          <Button text="Skip" onClick={close} />
          <span className={s.spacer} />
          {step > 0 && <Button text="Back" onClick={() => go(step - 1)} />}
          <GlowButton text={last ? "Done" : "Next"} onClick={() => (last ? close() : go(step + 1))} />
        </div>
      </div>
    </OverlaySheet>
  );
}
