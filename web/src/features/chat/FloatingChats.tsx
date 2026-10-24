// FloatingChats.tsx — FloatingChats.qml as in-app panels (web exception: a page can't make always-on-top
// OS windows): 380×520 default (last resized size remembered in bubble-w/h, ≥ 280×240), own title bar
// (avatar, name, minimise "Minimize to chat-head", close "Close chat"), drag the bar, ◢ resize grip,
// full conversation + composer (no soundboard); minimised = a 64 px draggable chat-head with the unread
// badge and a ✕. Max 6. Phones: none (open the room instead).
import { useEffect, useRef, useState } from "react";
import { useDmFace, useRoomAvatar, useRoomName, useUnread } from "@/core/matrix";
import { setPref } from "@/core/prefs";
import { useFormFactor } from "@/core/device";
import { Avatar, HeaderIconButton, Icon, UnreadBadge, avatarSeed } from "@/ui";
import { ConversationView } from "./ConversationView";
import { ConvToastCtx } from "./convToast";
import { closeFloatingChat, getView, patchFloating, raiseFloating, useChatStore, type FloatingChat } from "./store";
import s from "./FloatingChats.module.css";

export function FloatingChatsLayer() {
  const chats = useChatStore((st) => st.floating);
  const mobile = useFormFactor() === "mobile";
  if (mobile || !chats.length) return null;
  return (
    <>
      {chats.map((c) => (
        <FloatingChatWindow key={c.roomId} chat={c} />
      ))}
    </>
  );
}

let sizeTimer = 0;
function persistSize(w: number, h: number) {
  window.clearTimeout(sizeTimer);
  sizeTimer = window.setTimeout(() => {
    setPref("bubble-w", Math.round(w));
    setPref("bubble-h", Math.round(h));
  }, 900);
}

function FloatingChatWindow({ chat }: { chat: FloatingChat }) {
  const name = useRoomName(chat.roomId);
  const avatar = useRoomAvatar(chat.roomId);
  const dm = useDmFace(chat.roomId); // selfhost/firstrun item 6: a DM looks like its person, as in the room list
  const unread = useUnread(chat.roomId);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [dropOn, setDropOn] = useState(false);
  const fullSize = useRef({ w: chat.w, h: chat.h });
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  // in-bubble toast pill (FC:226-249): bottom-centre 64 px up, 2.6 s, 160 ms fade
  const [pill, setPill] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const pillT = useRef(0);
  const notify = useRef((m: string) => {
    window.clearTimeout(pillT.current);
    setPill({ text: m, on: true });
    pillT.current = window.setTimeout(() => setPill((p) => ({ ...p, on: false })), 2600);
  }).current;

  const clamp = (x: number, y: number, w: number, h: number) => ({
    x: Math.max(0, Math.min(window.innerWidth - Math.min(w, 64), x)),
    y: Math.max(0, Math.min(window.innerHeight - Math.min(h, 40), y)),
  });

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: chat.x, oy: chat.y, moved: false };
    raiseFloating(chat.roomId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > 3) d.moved = true;
    patchFloating(chat.roomId, clamp(d.ox + dx, d.oy + dy, chat.minimized ? 64 : chat.w, chat.minimized ? 64 : chat.h));
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    return d?.moved ?? false;
  };

  useEffect(() => {
    const onResize = () => patchFloating(chat.roomId, clamp(chat.x, chat.y, chat.w, chat.h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  // minimised = the chat-head; the conversation stays mounted (hidden) so drafts/staged files survive
  const head = chat.minimized ? (
      <div
        className={s.head}
        style={{ left: chat.x, top: chat.y, zIndex: 100 + chat.z }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(e) => {
          const moved = endDrag();
          if (!moved && e.button === 0 && !(e.target as HTMLElement).closest("button")) patchFloating(chat.roomId, { minimized: false, w: fullSize.current.w, h: fullSize.current.h });
        }}
        onAuxClick={(e) => {
          if (e.button === 1) closeFloatingChat(chat.roomId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          closeFloatingChat(chat.roomId);
        }}
        title={name}
      >
        <Avatar size={50} name={name || "Room"} seed={avatarSeed(chat.roomId, dm.peer)} imageSource={avatar || dm.avatar} />
        {unread.count > 0 && (
          <span className={s.badge}>
            <UnreadBadge count={unread.count} highlight={unread.highlight > 0} />
          </span>
        )}
        <button type="button" className={s.headX} aria-label="Close chat" onClick={() => closeFloatingChat(chat.roomId)}>
          <Icon name="window-close-symbolic" size={12} color="var(--th-chat-head-close-fg)" />
        </button>
      </div>
  ) : null;

  return (
    <>
    {head}
    <div
      className={s.win}
      data-floating-chat={chat.roomId}
      style={{ left: chat.x, top: chat.y, width: chat.w, height: chat.h, zIndex: 100 + chat.z, display: chat.minimized ? "none" : undefined }}
      onPointerDownCapture={() => raiseFloating(chat.roomId)}
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) setDropOn(true);
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn(false);
      }}
      onDrop={(e) => {
        setDropOn(false);
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        getView(`float:${chat.roomId}`)?.stageFiles(files);
      }}
    >
      <div className={s.title} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => endDrag()}>
        <Avatar size={25} name={name || "Room"} seed={avatarSeed(chat.roomId, dm.peer)} imageSource={avatar || dm.avatar} />
        <span className={s.name}>{name || "Room"}</span>
        <HeaderIconButton
          iconName="window-minimize-symbolic"
          tip="Minimize to chat-head"
          onClick={() => {
            fullSize.current = { w: chat.w, h: chat.h };
            patchFloating(chat.roomId, { minimized: true });
          }}
        />
        <HeaderIconButton iconName="window-close-symbolic" tip="Close chat" onClick={() => closeFloatingChat(chat.roomId)} />
      </div>
      <div className={s.sep} />
      <ConvToastCtx.Provider value={notify}>
        <ConversationView roomId={chat.roomId} primary={false} floating hidden={chat.minimized} viewKey={`float:${chat.roomId}`} />
      </ConvToastCtx.Provider>
      <span className={s.pill} style={{ opacity: pill.on ? 1 : 0 }} aria-live="polite">
        {pill.text}
      </span>
      {dropOn && (
        <div className={s.drop}>
          <span>Drop to attach — you can add a message before it goes</span>
        </div>
      )}
      <span
        className={s.grip}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          const sx = e.clientX;
          const sy = e.clientY;
          const w0 = chat.w;
          const h0 = chat.h;
          const pid = e.pointerId;
          const move = (ev: PointerEvent) => {
            if (ev.pointerId !== pid) return;
            const w = Math.max(280, Math.min(7999, w0 + ev.clientX - sx));
            const h = Math.max(240, Math.min(7999, h0 + ev.clientY - sy));
            patchFloating(chat.roomId, { w, h });
            persistSize(w, h);
          };
          const up = (ev?: PointerEvent) => {
            if (ev && ev.pointerId !== pid) return;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            resizeCleanup.current = null;
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
          resizeCleanup.current = () => up();
        }}
      >
        ◢
      </span>
    </div>
    </>
  );
}
