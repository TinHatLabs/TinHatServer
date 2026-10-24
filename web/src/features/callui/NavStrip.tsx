// NavStrip.tsx — the nav room row's call strip (ThRoomList.qml:243-244, 470-600; CUI-152), exported for
// features/nav to place under a room row:
//   useRoomCallLive(roomId)        true while the room has a live MatrixRTC call (nav: accentBright dot)
//   useLiveCallParts(roomId)       the rows: our call room → the live SFU roster (self first, one per remote
//                                  mxid from the tiles, recorder excluded); any other room → the call.member roster
//   NavCallStrip({roomId, selected})  the participant rows (max 6 unless the row is selected): 20 px avatar,
//                                  name (small, dim, elide), muted-by-me / server-muted / game-chat / aside glyphs;
//                                  right-click or long-press → the shared per-person menu.
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Icon, useTip } from "@/ui";
import { peekClient, useMxcUrl } from "@/core/matrix";
import { act, isRecorderTile, localpartOf, SELF_ID, tileMxid, useC } from "./store";
import { useCallParticipants } from "./Incoming";
import { ParticipantVolumeMenu } from "./menus";
import s from "./NavStrip.module.css";

export interface CallPart {
  mxid: string;
  name: string;
  avatar: string; // mxc or object URL ("" = generated)
}

export function useRoomCallLive(roomId: string | null | undefined): boolean {
  return useCallParticipants(roomId).length > 0;
}

export function useLiveCallParts(roomId: string): CallPart[] {
  const inCall = useC("inCall");
  const callRoom = useC("callRoomId");
  const tiles = useC("tiles");
  const members = useCallParticipants(roomId);
  return useMemo(() => {
    const c = peekClient();
    const room = c?.getRoom(roomId);
    const person = (mxid: string): CallPart => {
      const m = room?.getMember(mxid);
      return { mxid, name: m?.name || localpartOf(mxid), avatar: m?.getMxcAvatarUrl() ?? "" };
    };
    if (inCall && callRoom === roomId && tiles.length > 0) {
      const me = c?.getUserId() ?? "";
      const out: CallPart[] = [];
      if (me && tiles.some((t) => t.id === SELF_ID)) out.push(person(me));
      for (const t of tiles) {
        if (t.id === SELF_ID || isRecorderTile(t)) continue;
        const mx = tileMxid(t.participant);
        if (!mx || out.some((p) => p.mxid === mx)) continue;
        out.push({ ...person(mx), name: t.name || person(mx).name, avatar: t.avatar || person(mx).avatar });
      }
      return out;
    }
    return members.map(person);
  }, [inCall, callRoom, roomId, tiles, members]);
}

export function NavCallStrip({ roomId, selected }: { roomId: string; selected?: boolean }) {
  const parts = useLiveCallParts(roomId);
  const [menu, setMenu] = useState<{ mxid: string; name: string; anchor: { x: number; y: number; width: number; height: number } } | null>(null);
  const [rev, setRev] = useState(0);
  if (!parts.length) return null;
  const shown = selected ? parts : parts.slice(0, 6);
  return (
    <div className={s.col} data-testid="nav-call-strip">
      {shown.map((p) => (
        <PartRow key={p.mxid} p={p} rev={rev} onMenu={(anchor) => setMenu({ mxid: p.mxid, name: p.name, anchor })} />
      ))}
      {menu && (
        <ParticipantVolumeMenu
          mxid={menu.mxid}
          name={menu.name}
          roomId={roomId}
          anchor={menu.anchor}
          onClose={() => {
            setMenu(null);
            setRev((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function PartRow({ p, rev, onMenu }: { p: CallPart; rev: number; onMenu: (a: { x: number; y: number; width: number; height: number }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const lp = useRef(0);
  const lpFired = useRef(false);
  useEffect(() => () => window.clearTimeout(lp.current), []);
  const tiles = useC("tiles");
  const gc = useC("gameChatPeers");
  const gameChat = useC("gameChat");
  const corner = useC("corner");
  const img = useMxcUrl(p.avatar.startsWith("mxc://") ? p.avatar : null, { width: 40, height: 40, method: "crop" });
  void rev;
  const muted = (["mic", "screenshare", "music"] as const).some((c) => act("mutedFor")(p.mxid, c));
  const srvBy = tiles.find((t) => tileMxid(t.participant) === p.mxid && t.serverMuted)?.serverMutedBy ?? "";
  const inGc = gc.peers.some((x) => tileMxid(x) === p.mxid);
  const cornerOf = Object.entries(corner.corners).find(([, ms]) => ms.some((m) => tileMxid(m) === p.mxid))?.[0] ?? "";
  const open = (x: number, y: number) => {
    const r = ref.current?.getBoundingClientRect();
    onMenu(r ? { x: r.left, y: r.bottom, width: 0, height: 0 } : { x, y, width: 0, height: 0 });
  };
  return (
    <div
      ref={ref}
      className={s.row}
      onContextMenu={(e) => {
        e.preventDefault();
        open(e.clientX, e.clientY);
      }}
      onTouchStart={(e) => {
        window.clearTimeout(lp.current);
        lpFired.current = false;
        const t = e.touches[0];
        lp.current = window.setTimeout(() => {
          lpFired.current = true;
          open(t.clientX, t.clientY);
        }, 500);
      }}
      onTouchEnd={(e) => {
        window.clearTimeout(lp.current);
        // keep the release from clicking the sheet row that opened under the finger
        if (lpFired.current) e.preventDefault();
        lpFired.current = false;
      }}
      onTouchMove={() => window.clearTimeout(lp.current)}
      onTouchCancel={() => window.clearTimeout(lp.current)}
      data-mxid={p.mxid}
    >
      <Avatar name={p.name} seed={p.mxid || p.name} imageSource={img || (p.avatar.startsWith("mxc://") ? null : p.avatar || null)} size={20} />
      <span className={s.name}>{p.name}</span>
      {muted && <Icon name="audio-volume-muted-symbolic" size={14} color="var(--th-rooms-caller-muted-icon)" />}
      {srvBy && <SrvGlyph by={srvBy} />}
      {inGc && <TipIcon name="audio-input-microphone-symbolic" color="var(--th-rooms-caller-game-chat-icon)" tip={gameChat ? "In game chat with you — you hear each other in-game, so their mic is muted here" : "In the game's voice chat"} />}
      {cornerOf && (
        <TipIcon
          name="audio-input-microphone-symbolic"
          color="var(--th-rooms-caller-aside-icon)"
          tip={corner.active && cornerOf === corner.mine ? "Aside with you" : "Pulled aside — you don't hear their mic. Right-click to join them"}
        />
      )}
    </div>
  );
}

function SrvGlyph({ by }: { by: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, `Muted by ${by}`, { delay: 300 });
  return (
    <span ref={ref} className={s.srv}>
      <Icon name="microphone-sensitivity-muted-symbolic" size={14} color="var(--th-rooms-caller-server-muted-icon)" />
      <span className={s.shield}>
        <Icon name="security-high-symbolic" size={8} color="var(--th-rooms-caller-server-muted-icon)" />
      </span>
    </span>
  );
}

function TipIcon({ name, color, tip }: { name: string; color: string; tip: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, tip, { delay: 300 });
  return (
    <span ref={ref} className={s.glyph}>
      <Icon name={name} size={14} color={color} />
    </span>
  );
}
