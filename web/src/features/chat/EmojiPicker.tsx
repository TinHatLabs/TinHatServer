// EmojiPicker.tsx — EmojiPicker.qml: 340×400 popup, "Search emoji…" (focused on open), 40 px grid of
// the curated set, Enter picks the first match, "No emoji found — try another word". The composer
// variant stays open across picks (inserts at the caret); the reaction variant closes after one pick.
import { useEffect, useRef, useState } from "react";
import { Icon, Popover, ScrollArea, type Rect } from "@/ui";
import { filterEmoji } from "./lib/emoji";
import s from "./Composer.module.css";

export interface EmojiPickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  anchor?: HTMLElement | Rect | null;
  /** centred in this rect (reaction variant) */
  center?: Rect | null;
  stayOpen?: boolean;
}

export function EmojiPicker({ open, onClose, onPick, anchor, center, stayOpen }: EmojiPickerProps) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      const t = window.setTimeout(() => (document.documentElement.dataset.ff !== "mobile" ? input.current?.focus() : undefined), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);
  const list = filterEmoji(q);
  const pick = (e: string) => {
    onPick(e);
    if (!stayOpen) onClose();
  };
  const anchorRect: Rect | HTMLElement | null | undefined = center
    ? { x: center.x + center.width / 2 - 170, y: center.y + center.height / 2 - 200, width: 340, height: 400 }
    : anchor;
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchorRect}
      placement={center ? "at" : "above"}
      align={center ? "start" : "end"}
      gap={6}
      margins={8}
      plain
      padding={0}
      title="Emoji"
      className={s.emojiPop}
    >
      <div className={s.emojiInner}>
        <div className={s.search}>
          <Icon name="search" size={16} color="var(--th-emoji-search-icon)" staticOnly />
          <input
            ref={input}
            value={q}
            placeholder="Search emoji…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && list.length) {
                e.preventDefault();
                pick(list[0].e);
              }
            }}
          />
        </div>
        <ScrollArea className={s.gridScroll} contentClassName={s.emojiGrid}>
          {list.map((x) => (
            <button key={x.e} type="button" className={s.emojiCell} aria-label={x.k.split(" ")[0]} onClick={() => pick(x.e)}>
              <span>{x.e}</span>
            </button>
          ))}
          {list.length === 0 && <div className={s.emojiEmpty}>No emoji found — try another word</div>}
        </ScrollArea>
      </div>
    </Popover>
  );
}
