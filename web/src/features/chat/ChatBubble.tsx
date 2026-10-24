// ChatBubble.tsx — one timeline row (CV:960-1094 + ChatBubble.qml): day pill, NEW divider, the wash
// (mention / flash), avatar gutter + name row + role tag, the bubble (reply quote, body / deleted /
// locked / media / embeds / link preview / calendar card, timestamp), failed row, reactions, receipts,
// and the hover action bar.
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useMemberRole, RoleBadge } from "@/features/spaces";
import { openUserProfile } from "@/core/bus";
import { useCryptoStatus, useIsFirstDevice, useMember } from "@/core/matrix";
import { findTimelineRenderer } from "@/core/registry";
import { Avatar, Icon, cx, senderColor, useTip, useContentInk } from "@/ui";
import { fmtClock, fmtFull } from "./lib/format";
import { isJumbo, renderFormatted, renderPlain } from "./lib/html";
import { utdText } from "./lib/utd";
import { isDiceRow, type Row } from "./lib/model";
import { AudioChip, AudioPlayer, BIG_AUDIO, FileCard, ImageBlock, VideoCard } from "./MediaBlocks";
import { EmbedCard } from "./EmbedCard";
import { LinkPreviewCard } from "./LinkPreviewCard";
import s from "./Bubble.module.css";

export interface ReceiptUser {
  userId: string;
  name: string;
  avatar: string | null;
}

export interface BubbleHandlers {
  onReact: (row: Row, key: string) => void;
  onReactPicker: (row: Row, anchor: HTMLElement) => void;
  onReply: (row: Row) => void;
  onEdit: (row: Row) => void;
  onMenu: (row: Row, at: { x: number; y: number } | HTMLElement) => void;
  onJump: (eventId: string) => void;
  onRetry: (row: Row) => void;
  onDeleteLocal: (row: Row) => void;
  onImage: (src: string, w: number, h: number, caption: string) => void;
  /** returns the timeline viewport's top (for the hover-bar tuck) */
  viewTop: () => number;
}

export interface BubbleProps {
  row: Row;
  roomId: string;
  me: string;
  grouped: boolean;
  dayLabel: string | null;
  isDivider: boolean;
  maxBubble: number;
  receipts: ReceiptUser[];
  flash: boolean;
  clock: string;
  touch: boolean;
  previewsOn: boolean;
  h: BubbleHandlers;
}

const QUICK = ["👍", "❤️", "😂"];

/** A message this device can't read, in plain words (selfhost/firstrun item 3, lib/utd.ts): why, and whether anything
 *  can be done. Mounted only for such rows, so the crypto hooks never run for the readable ones. */
function LockedNote({ code, maxWidth }: { code: string | null; maxWidth: number }) {
  const firstDevice = useIsFirstDevice();
  const verified = useCryptoStatus().thisDeviceVerified;
  return (
    <div className={s.locked} style={{ maxWidth }} data-utd={code ?? ""}>
      <Icon name="lock-symbolic" size={14} color="var(--th-bubble-other-meta-fg)" />
      <span>{utdText({ code, firstDevice, verified })}</span>
    </div>
  );
}

export const ChatBubble = memo(function ChatBubble(p: BubbleProps) {
  const { row, roomId, grouped, maxBubble, h } = p;
  const mine = row.mine;
  const member = useMember(roomId, row.sender);
  const role = useMemberRole(roomId, row.sender);
  const name = member?.name && member.name !== row.sender ? member.name : row.sender.replace(/^@/, "").split(":")[0];
  const ink = useContentInk();
  const nameColor = (role?.color && ink(role.color)) || senderColor(row.sender);
  const [tuck, setTuck] = useState(false);
  // the hover bar only exists while the pointer is over the row (hundreds of rows → no idle buttons)
  const [hover, setHover] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const lp = useRef<{ t: number; x: number; y: number } | null>(null);
  const emote = row.msgtype === "m.emote";
  const showName = !mine && !grouped && !emote;
  const noBar = row.pending || row.failed || row.redacted || row.undecryptable || !!row.echo;
  const renderer = row.event && !row.redacted ? findTimelineRenderer(row.event) : undefined;
  const CalendarCard = renderer?.component;
  const inner = maxBubble - 24;

  // ---- body
  let bodyNode: ReactNode = null;
  const hideBody = !!row.media || row.redacted || row.undecryptable || (row.onlyEmbed && row.embeds.length > 0) || !!CalendarCard;
  if (!hideBody) {
    const jumbo = !row.formatted && isJumbo(row.body);
    const html = row.formatted ? renderFormatted(row.formatted) : renderPlain(row.body);
    const emotePrefix = emote ? `∗ ${escapeName(mine ? name : name)} ` : "";
    bodyNode = (
      <div
        className={cx(s.body, row.formatted ? s.rich : s.plain, jumbo && s.jumbo, emote && s.emote)}
        style={{ maxWidth: inner }}
        dangerouslySetInnerHTML={{ __html: emotePrefix + html }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          const mx = a.getAttribute("data-mention");
          if (mx) {
            const r = a.getBoundingClientRect();
            openUserProfile(mx, roomId, { x: r.x, y: r.y, width: r.width, height: r.height });
          } else if (a.getAttribute("href")) window.open(a.getAttribute("href")!, "_blank", "noopener,noreferrer");
        }}
      />
    );
  }

  const clockText = row.failed ? "Not sent" : row.pending ? "Sending…" : `${row.pinned ? "📌 " : ""}${row.edited ? "(edited) " : ""}${fmtClock(row.ts, p.clock)}`;

  // phones: swipe a row left to reply (Discord-style), follows the finger up to 80 px
  const swipe = useRef<{ x0: number; y0: number; on: boolean; dx: number } | null>(null);
  const [swipeX, setSwipeX] = useState(0);
  useEffect(
    () => () => {
      if (lp.current) window.clearTimeout(lp.current.t);
    },
    [],
  );
  const canSwipe = p.touch && !noBar;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const x = e.clientX;
    const y = e.clientY;
    if (canSwipe) swipe.current = { x0: x, y0: y, on: false, dx: 0 };
    if (lp.current) window.clearTimeout(lp.current.t);
    lp.current = {
      t: window.setTimeout(() => {
        lp.current = null;
        navigator.vibrate?.(10);
        swallowReleaseClick();
        h.onMenu(row, { x, y });
      }, 500),
      x,
      y,
    };
  };
  const cancelLp = (e?: React.PointerEvent) => {
    const l = lp.current;
    if (!l) return;
    if (e && e.type === "pointermove" && Math.hypot(e.clientX - l.x, e.clientY - l.y) < 10) return;
    window.clearTimeout(l.t);
    lp.current = null;
  };
  const onSwipeMove = (e: React.PointerEvent) => {
    const sw = swipe.current;
    if (!sw) return;
    const dx = e.clientX - sw.x0;
    const dy = e.clientY - sw.y0;
    if (!sw.on) {
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) {
        swipe.current = null;
        return;
      }
      if (dx < -12 && Math.abs(dx) > 1.5 * Math.abs(dy)) sw.on = true;
      else return;
    }
    sw.dx = Math.max(-80, Math.min(0, dx));
    setSwipeX(sw.dx);
  };
  const onSwipeEnd = (fire: boolean) => {
    const sw = swipe.current;
    swipe.current = null;
    if (sw?.on) {
      if (fire && sw.dx <= -56) {
        navigator.vibrate?.(8);
        h.onReply(row);
      }
      setSwipeX(0);
    }
  };

  return (
    <div
      className={cx(s.row, grouped && s.grouped)}
      data-row-id={row.id}
      data-event-id={row.eventId ?? undefined}
      data-mine={mine ? "1" : undefined}
      data-kind={row.redacted ? "redacted" : row.undecryptable ? "locked" : row.media ? row.media.kind : row.embeds.length ? "embed" : row.msgtype.replace("m.", "")}
    >
      {p.dayLabel && (
        <div className={s.day}>
          <span className={s.dayPill}>{p.dayLabel}</span>
        </div>
      )}
      {p.isDivider && (
        <div className={s.newDiv}>
          <span className={s.newLine} />
          <span className={s.newLabel}>NEW</span>
        </div>
      )}
      <div
        className={cx(s.line, mine && s.mine, row.mentionsMe && s.mention, p.flash && s.flashing)}
        onMouseEnter={() => {
          const b = bubbleRef.current?.getBoundingClientRect();
          if (b) setTuck(b.top - h.viewTop() < 40);
          setHover(true);
        }}
        onMouseLeave={() => setHover(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (row.echo && !row.failed) return;
          h.onMenu(row, { x: e.clientX, y: e.clientY });
        }}
        onPointerDown={onPointerDown}
        onPointerUp={() => {
          cancelLp();
          onSwipeEnd(true);
        }}
        onPointerCancel={() => {
          cancelLp();
          onSwipeEnd(false);
        }}
        onPointerMove={(e) => {
          cancelLp(e);
          onSwipeMove(e);
        }}
        style={swipeX ? { transform: `translateX(${swipeX}px)`, transition: "none" } : undefined}
      >
        <span className={s.wash} />
        {swipeX !== 0 && (
          <span className={s.swipeHint} style={{ opacity: Math.min(1, -swipeX / 56), right: -40 }}>
            <Icon name="mail-reply-sender-symbolic" size={22} color="var(--th-bubble-swipe-hint-icon)" />
          </span>
        )}
        {!mine && (
          <div className={s.gutter}>
            {!grouped && (
              <Avatar
                className={s.avatar}
                size={34}
                name={name}
                seed={row.sender}
                imageSource={member?.avatarMxc ?? null}
                onClick={() => openUserProfile(row.sender, roomId)}
              />
            )}
          </div>
        )}
        <div className={s.col} style={{ maxWidth: maxBubble + 42, opacity: row.pending ? 0.55 : 1 }}>
          {showName && (
            <div className={s.nameRow}>
              <span
                className={s.name}
                style={{ color: nameColor, maxWidth: maxBubble }}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openUserProfile(row.sender, roomId, { x: r.x, y: r.y, width: r.width, height: r.height });
                }}
              >
                {name}
              </span>
              <RoleBadge roomId={roomId} userId={row.sender} compact />
            </div>
          )}
          <div className={s.bubbleWrap}>
            <div
              ref={bubbleRef}
              data-bubble=""
              className={cx(s.bubble, mine ? s.bubbleMine : s.bubbleIn, !grouped && (mine ? s.tuckR : s.tuckL), row.failed && s.bubbleFailed)}
              style={{ maxWidth: maxBubble }}
            >
              {row.replyTo && <ReplyQuote row={row} mine={mine} inner={inner} onJump={h.onJump} />}
              {row.redacted && <div className={s.redacted}>Message deleted</div>}
              {row.undecryptable && <LockedNote code={row.utdCode} maxWidth={maxBubble - 70 + 20} />}
              {bodyNode}
              {CalendarCard && row.event && <CalendarCard roomId={roomId} event={row.event} continuation={grouped} />}
              {row.media && <MediaBlock row={row} inner={inner} mine={mine} onImage={h.onImage} />}
              {!row.redacted &&
                row.embeds.map((e) => (
                  <div key={e.id} className={s.embedWrap}>
                    <EmbedCard e={e} maxW={inner} roomId={roomId} onOpenImage={(src, w, hh) => h.onImage(src, w, hh, "")} />
                  </div>
                ))}
              {row.previewUrl && !row.redacted && <LinkPreviewCard url={row.previewUrl} maxW={inner} mine={mine} enabled={p.previewsOn} />}
              <Stamp text={clockText} tip={row.pending || row.failed ? "" : fmtFull(row.ts)} failed={row.failed} mine={mine} />
            </div>
            {!noBar && !p.touch && hover && <HoverBar row={row} tuck={tuck} h={h} />}
          </div>
          {row.failed && (
            <div className={s.failedRow}>
              <span className={s.failReason}>{row.failReason || "Couldn't send"}</span>
              <span className={s.retry} onClick={() => h.onRetry(row)}>
                Retry
              </span>
              <span className={s.del} onClick={() => h.onDeleteLocal(row)}>
                Delete
              </span>
            </div>
          )}
          {row.reactions.length > 0 && (
            <div className={s.reactions} style={{ maxWidth: maxBubble }}>
              {row.reactions.map((r) => (
                <ReactionChip key={r.key} r={r} onClick={() => h.onReact(row, r.key)} />
              ))}
            </div>
          )}
          {p.receipts.length > 0 && <Receipts users={p.receipts} />}
        </div>
      </div>
    </div>
  );
});

/** The finger lifting after a long-press must not "tap" the sheet item that slid in under it. */
function swallowReleaseClick() {
  const swallow = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
    done();
  };
  const done = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", done, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", done, true);
  window.setTimeout(done, 1500);
}

function escapeName(n: string) {
  return n.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function Stamp({ text, tip, failed, mine }: { text: string; tip: string; failed: boolean; mine: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTip(ref, tip, { delay: 600 });
  return (
    <div className={cx(s.stamp, failed && s.stampFailed)} style={!failed && mine ? { color: "var(--th-bubble-own-meta-fg)" } : undefined}>
      <span ref={ref}>{text}</span>
    </div>
  );
}

function ReplyQuote({ row, mine, inner, onJump }: { row: Row; mine: boolean; inner: number; onJump: (id: string) => void }) {
  const r = row.replyTo!;
  const loaded = r.loaded;
  return (
    <div
      className={cx(s.quote, mine && s.quoteMine)}
      style={{ maxWidth: inner }}
      onClick={(e) => {
        e.stopPropagation();
        onJump(r.id);
      }}
    >
      <span className={s.quoteBar} />
      <span className={s.quoteName} style={{ color: mine ? "var(--th-bubble-own-quote-fg)" : loaded ? senderColor(r.name) : "var(--th-bubble-other-quote-fg)" }}>
        {loaded ? r.name : "Replying to an earlier message"}
      </span>
      <span className={s.quoteBody}>{loaded ? r.body : "Older than what's loaded — click to look for it"}</span>
    </div>
  );
}

function MediaBlock({ row, inner, mine, onImage }: { row: Row; inner: number; mine: boolean; onImage: BubbleHandlers["onImage"] }) {
  const m = row.media!;
  if (m.kind === "image") return <ImageBlock m={m} maxW={inner} mine={mine} onOpen={(src, w, h) => onImage(src, w, h, m.name)} />;
  if (m.kind === "video") return <VideoCard m={m} maxW={inner} />;
  if (m.kind === "audio") return m.size > BIG_AUDIO ? <AudioChip m={m} mine={mine} /> : <AudioPlayer m={m} maxW={inner} mine={mine} />;
  return <FileCard m={m} maxW={inner} mine={mine} />;
}

function ReactionChip({ r, onClick }: { r: Row["reactions"][number]; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const all = r.who.filter(Boolean);
  const shown = all.slice(0, 8).join(", ") + (all.length > 8 ? ` +${all.length - 8}` : "");
  useTip(ref, all.length ? `${shown} reacted with ${r.key}` : `${r.mine ? "You" : "Someone"} reacted with ${r.key}`, { delay: 450 });
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.chip, r.mine && s.chipMine)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className={s.chipKey}>{r.key}</span>
      {r.count > 1 && <span className={s.chipCount}>{r.count}</span>}
    </button>
  );
}

function Receipts({ users }: { users: ReceiptUser[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const names = users.map((u) => u.name);
  const tip = "Seen by " + names.slice(0, 10).join(", ") + (names.length > 10 ? ` +${names.length - 10}` : "");
  useTip(ref, tip, { delay: 450 });
  return (
    <div ref={ref} className={s.receipts}>
      {users.slice(0, 5).map((u, i) => (
        <Avatar key={u.userId} size={16} name={u.name} seed={u.userId} imageSource={u.avatar} className={s.receiptAv} style={{ marginLeft: i ? -6 : 0, zIndex: 5 - i }} />
      ))}
      {users.length > 5 && <span className={s.receiptMore}>+{users.length - 5}</span>}
    </div>
  );
}

function HoverBar({ row, tuck, h }: { row: Row; tuck: boolean; h: BubbleHandlers }) {
  const canEdit = row.mine && !row.media && (row.msgtype === "m.text" || row.msgtype === "m.emote" || row.msgtype === "m.notice") && !isDiceRow(row);
  return (
    <div className={cx(s.hoverBar, row.mine && s.hoverBarMine, tuck && s.hoverTuck)} onClick={(e) => e.stopPropagation()}>
      {QUICK.map((k) => {
        const mineR = row.reactions.find((r) => r.key === k && r.mine);
        return <BarBtn key={k} emoji={k} on={!!mineR} tip={mineR ? `Take back your ${k}` : `React ${k}`} onClick={() => h.onReact(row, k)} />;
      })}
      <BarBtn icon="face-smile-symbolic" tip="More reactions" onClick={(el) => h.onReactPicker(row, el)} />
      <BarBtn icon="mail-reply-sender-symbolic" tip="Reply" onClick={() => h.onReply(row)} />
      {canEdit && <BarBtn icon="document-edit-symbolic" tip="Edit" onClick={() => h.onEdit(row)} />}
      <BarBtn icon="overflow-menu-symbolic" tip="More" onClick={(el) => h.onMenu(row, el)} />
    </div>
  );
}

function BarBtn({ emoji, icon, tip, on, onClick }: { emoji?: string; icon?: string; tip: string; on?: boolean; onClick: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hov, setHov] = useState(false);
  useTip(ref, tip, { delay: 500 });
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.barBtn, on && s.barBtnOn)}
      aria-label={tip}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e.currentTarget);
      }}
    >
      {emoji ? <span className={s.barEmoji}>{emoji}</span> : <Icon name={icon!} size={16} color="var(--th-bubble-hover-bar-icon)" hovered={hov} />}
    </button>
  );
}
