// CallBarPieces.tsx — the soundboard's entry points outside the popover:
//   SoundboardButton         call-bar CallButton `emblem-music-symbolic` (Main.qml:7697)
//   SoundboardNowPlayingPill blinking ▶ + name + stop "Stop the sound (for everyone)" (Main.qml:7706)
//   SoundboardComposerButton composer ThToolButton `audio-speakers-symbolic` (ConversationView.qml:1724)
// selfhost/firstrun item 1: each piece draws nothing while the server says it has no soundboard (core/server).
import { useEffect, useState } from "react";
import { useServerFeature } from "@/core/server";
import { BasicToolButton, Icon, ToolButton, useIsMobile } from "@/ui";
import { CallRoundButton } from "../shared/CallRoundButton";
import { openSoundboard, stopCurrent, useSoundboard } from "./store";
import s from "./CallBarPieces.module.css";

export function SoundboardButton(_: { roomId?: string }) {
  const open = useSoundboard((st) => st.open);
  const playingUrl = useSoundboard((st) => st.playingUrl);
  const playingName = useSoundboard((st) => st.playingName);
  if (!useServerFeature("soundboard")) return null;
  return (
    <CallRoundButton
      data-sb-keep=""
      iconName="emblem-music-symbolic"
      active={open || !!playingUrl}
      tip={playingUrl ? `Soundboard — playing ${playingName}` : "Soundboard"}
      onClick={() => openSoundboard()}
    />
  );
}

export function SoundboardNowPlayingPill(_: { roomId?: string }) {
  const playingUrl = useSoundboard((st) => st.playingUrl);
  const playingName = useSoundboard((st) => st.playingName);
  const on = useServerFeature("soundboard");
  // GPU.md §2.2: the soundboard's ▶ is static (it blinked every 700 ms while a clip played)
  if (!playingUrl || !on) return null;
  return (
    <div className={s.pill} data-sb-keep="">
      <Icon name="media-playback-start" size={16} color="var(--th-callbar-now-playing-icon)" className={s.blink} />
      <span className={s.name}>{playingName || "Sound"}</span>
      <BasicToolButton iconName="media-playback-stop" display="iconOnly" className={s.stop} tip="Stop the sound (for everyone)" onClick={() => stopCurrent()} />
    </div>
  );
}

export function SoundboardComposerButton({ roomId }: { roomId?: string }) {
  const mobile = useIsMobile();
  if (!useServerFeature("soundboard")) return null;
  // phones: chat wraps every composer action in a labelled 48 px row of its "Add to your message"
  // sheet (SheetAction: 44 px button + the aria-label's text before " — "), so the plain button is
  // what it needs — a MenuItem here nested a second row inside chat's row (double indent, two
  // "Soundboard" menuitems)
  return (
    <ToolButton
      data-sb-keep=""
      iconName="audio-speakers-symbolic"
      tip={mobile ? "Soundboard" : "Soundboard — Ctrl+Shift+S"}
      disabled={!roomId}
      onClick={() => openSoundboard()}
    />
  );
}
