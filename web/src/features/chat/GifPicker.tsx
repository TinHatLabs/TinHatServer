// GifPicker.tsx — the composer's GIF popup (CV:1599-1721; gif.rs): 430×430, "Search GIFs…" focused,
// trending on open, 450 ms debounced search (previous request aborted), 3 columns × 100 px tiles,
// "Loading…" / "Couldn't load GIFs" / "No GIFs", "Powered by GIPHY". Picking sends the GIF URL as plain
// text (no markdown, no echo, no send sound) and closes.
import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/core/api";
import { AnimatedImage, Icon, Popover, ScrollArea } from "@/ui";
import s from "./Composer.module.css";

interface Gif {
  id: string;
  title: string;
  url: string;
  width: number;
  height: number;
  preview: string;
}

export function GifPicker({ open, onClose, anchor, onPick }: { open: boolean; onClose: () => void; anchor: HTMLElement | null; onPick: (url: string) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Gif[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "empty" | "ok">("loading");
  const input = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);

  const loadedQ = useRef<string | null>(null);
  const load = (query: string) => {
    loadedQ.current = query.trim();
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setStatus("loading");
    setItems([]);
    const path = query.trim() ? `/gifs/search?q=${encodeURIComponent(query.trim())}` : "/gifs/trending";
    apiJson<Gif[]>(path, { signal: c.signal })
      .then((r) => {
        if (c.signal.aborted) return;
        const list = Array.isArray(r) ? r : [];
        setItems(list);
        setStatus(list.length ? "ok" : "empty");
      })
      .catch(() => {
        if (!c.signal.aborted) setStatus("error");
      });
  };

  useEffect(() => {
    if (!open) {
      ctl.current?.abort();
      return;
    }
    setQ("");
    load("");
    const t = window.setTimeout(() => (document.documentElement.dataset.ff !== "mobile" ? input.current?.focus() : undefined), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || loadedQ.current === q.trim()) return;
    // trending immediately (cleared search), searches debounced 450 ms
    const t = window.setTimeout(() => load(q), q.trim() ? 450 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);
  useEffect(() => () => ctl.current?.abort(), []);

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="above" align="end" gap={6} margins={8} plain padding={0} title="GIFs" className={s.gifPop}>
      <div className={s.gifInner}>
        <div className={s.search}>
          <Icon name="search" size={16} color="var(--th-gif-search-icon)" staticOnly />
          <input ref={input} value={q} placeholder="Search GIFs…" onChange={(e) => setQ(e.target.value)} />
        </div>
        <ScrollArea className={s.gridScroll} contentClassName={s.gifGrid}>
          {items.map((g) => (
            <button
              key={g.id}
              type="button"
              className={s.gifTile}
              aria-label={g.title || "GIF"}
              data-gif-tile=""
              data-gif-url={g.url}
              onClick={() => {
                onPick(g.url);
                onClose();
              }}
            >
              {/* GPU.md §2.6: previews play ≤ 3 loops / 15 s while focused, then their first frame; hover replays */}
              <AnimatedImage src={g.preview || g.url} mime="image/gif" alt={g.title} loading="lazy" referrerPolicy="no-referrer" draggable={false} clickPlays={false} />
            </button>
          ))}
        </ScrollArea>
        {status !== "ok" && (
          <div className={s.gifStatus}>{status === "loading" ? "Loading…" : status === "error" ? "Couldn't load GIFs" : "No GIFs"}</div>
        )}
        <div className={s.giphy}>Powered by GIPHY</div>
      </div>
    </Popover>
  );
}
