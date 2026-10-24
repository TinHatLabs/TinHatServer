// watchparty/CallBarPieces.tsx — Media Party from the call (11.4, DESIGN §2.2), the twin of CallIsland.qml's `mpCell`:
//   MediaPartyButton      the bespoke `watchParty.open` call-bar button (video-television-symbolic): one click = join +
//                         open; a lit dot while a party is live in the call's room (ONE pulse on its rising edge —
//                         GPU.md §2.2/§2.4: nothing loops while the call sits idle), active while I'm in it; beside it
//                         the now-playing strip (art 24 px · title · "queued by X" · ▶/⏸ for me (host-gated) · ⏭ next
//                         (host-gated, shown when there is a next item — 11.3 QOL §7) · click opens; tooltip "title — artist")
//   MediaPartyPhoneStrip  the same strip above the phone call's tiles (callui Mobile.tsx, slot "phoneStrip")
// The party's state is read straight from the call room's state (viewer heartbeats, the clock, the queue) — the twin
// of Rust's `read_call_party` 3 s poll — so the cue shows whether or not I'm in the party.
import { useEffect, useRef, useState } from "react";
import { peekClient, useRoomState } from "@/core/matrix";
import { BasicToolButton, Icon, cx, useReducedMotion, useTip } from "@/ui";
import { CallRoundButton } from "../shared/CallRoundButton";
import { shortName } from "../shared/format";
import { PLAYBACK_EVENT, WP_EVENT, nextQueueUrl, normParty, normPlayback, pause, play, playUrl, useWatchParty, type QueueItem } from "./engine";
import { openWatchParty, useWatchPartyOn } from "./index";
import s from "./CallBarPieces.module.css";

const STALE_SECS = 6 * 3600;

export interface CallParty {
  live: boolean;
  url: string;
  playing: boolean;
  item: QueueItem | null;
  /** the url after the playing one in the room's queue ("" = none) */
  next: string;
}

/** The party in `roomId` as the call bar sees it (Rust read_call_party): live viewers, the clock, the playing item. */
export function useCallParty(roomId: string): CallParty {
  const live = useWatchPartyOn(roomId);
  const pbRaw = useRoomState(roomId, PLAYBACK_EVENT, "");
  const partyRaw = useRoomState(roomId, WP_EVENT, "");
  const pb = normPlayback(pbRaw);
  const url = pb?.url ?? "";
  const stale = pb ? (Date.now() - pb.updatedAt) / 1000 > STALE_SECS : true;
  const queue = normParty(partyRaw).queue;
  const item = url ? (queue.find((q) => q.url === url) ?? { url, title: "", addedBy: "" }) : null;
  return { live, url, playing: !!pb && !stale && pb.playing, item, next: url ? nextQueueUrl(queue, url) : "" };
}

/** The strip's tooltip: "title — artist" (QOL §7), else the title, else what a click does. */
export function stripTip(item: QueueItem | null): string {
  const t = [item?.title, item?.artist].filter(Boolean).join(" — ");
  return t || "Media Party — open the window";
}

function openFromCall(roomId: string) {
  openWatchParty(roomId);
}

export function MediaPartyButton({ roomId }: { roomId?: string }) {
  const room = roomId ?? "";
  const inParty = useWatchParty((st) => st.inParty);
  const party = useCallParty(room);
  const reduce = useReducedMotion();
  const [pulse, setPulse] = useState(0);
  const wasLive = useRef(false);
  // the dot pulses ONCE when the party starts (rising edge), then stays lit
  useEffect(() => {
    if (party.live && !wasLive.current && !reduce) setPulse((n) => n + 1);
    wasLive.current = party.live;
  }, [party.live, reduce]);
  const dot = party.live && !inParty;
  return (
    <span className={s.cell} data-sb-keep="">
      <span className={s.btnWrap}>
        <CallRoundButton
          data-id="action:watchParty.open"
          iconName="video-television-symbolic"
          active={inParty}
          tip={inParty ? "Media Party — you're in it (click to show the window)" : party.live ? "Media Party — a party is on in this call · click to join" : "Media Party — watch videos and listen to music together"}
          onClick={() => openFromCall(room)}
        />
        {dot && (
          <span className={s.dot} aria-hidden>
            {pulse > 0 && <span key={pulse} className={s.dotPulse} />}
          </span>
        )}
      </span>
      <NowPlayingStrip roomId={room} party={party} />
    </span>
  );
}

/** The now-playing strip (art · title · queued by · ▶/⏸ · ⏭ · click opens) — shown while a party plays in the call's room. */
function NowPlayingStrip({ roomId, party, phone }: { roomId: string; party: CallParty; phone?: boolean }) {
  if (!party.live || !party.url || party.url.startsWith("tinhat-memory://")) return null;
  return <StripBody roomId={roomId} party={party} phone={phone} />;
}

// (its own component: useTip wires the element present at mount — the strip used to mount empty and never got its tip)
function StripBody({ roomId, party, phone }: { roomId: string; party: CallParty; phone?: boolean }) {
  const inParty = useWatchParty((st) => st.inParty);
  const hostId = useWatchParty((st) => st.party.hostId);
  const myId = peekClient()?.getUserId() ?? "";
  const canControl = inParty && (!hostId || hostId === myId);
  const ref = useRef<HTMLDivElement>(null);
  useTip(ref, stripTip(party.item), { delay: 400 });
  const it = party.item;
  const title = it?.title || "Media Party";
  const by = it?.addedBy ? `queued by ${shortName(it.addedBy)}` : "";
  const tip = !inParty ? "Join the Media Party" : !canControl ? `Only the host (${shortName(hostId)}) controls playback` : party.playing ? "Pause for everyone" : "Play for everyone";
  const nextTip = !inParty ? "Join the Media Party" : !canControl ? `Only the host (${shortName(hostId)}) controls playback` : "Play next in queue";
  return (
    <div ref={ref} className={cx(s.strip, phone && s.phone)} data-testid="mp-strip" role="button" tabIndex={0} onClick={() => openFromCall(roomId)} onKeyDown={(e) => e.key === "Enter" && openFromCall(roomId)}>
      <span className={s.art}>
        {it?.art ? <img src={it.art} alt="" referrerPolicy="no-referrer" draggable={false} /> : <Icon name="video-television-symbolic" size={16} color="var(--th-callbar-now-playing-icon)" />}
      </span>
      <span className={s.text}>
        <span className={s.title}>{title}</span>
        {by && <span className={s.by}>{by}</span>}
      </span>
      <BasicToolButton
        iconName={party.playing ? "media-playback-pause" : "media-playback-start"}
        display="iconOnly"
        className={s.play}
        tip={tip}
        disabled={inParty && !canControl}
        onClick={(e) => {
          e.stopPropagation();
          if (!inParty) return openFromCall(roomId);
          if (party.playing) pause();
          else play();
        }}
      />
      {party.next && (
        <BasicToolButton
          iconName="media-skip-forward"
          display="iconOnly"
          className={s.play}
          tip={nextTip}
          disabled={inParty && !canControl}
          data-testid="mp-strip-next"
          onClick={(e) => {
            e.stopPropagation();
            if (!inParty) return openFromCall(roomId);
            playUrl(party.next);
          }}
        />
      )}
    </div>
  );
}

export function MediaPartyPhoneStrip({ roomId }: { roomId?: string }) {
  const room = roomId ?? "";
  const party = useCallParty(room);
  return <NowPlayingStrip roomId={room} party={party} phone />;
}
