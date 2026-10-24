// memories/Memories.tsx — the Memories widget (widget `memories`, contract WIDGETS.md §21, WIDGETS-UI.md §21; the
// desktop's MemoriesWidget.qml): your latest recordings from the Memories DVR — the rooms you're in that
// record — newest first. M = the last 4, L = 8: a 64 × 36 poster (the Memories window's own frame, fetched once), the
// room's name and "2 h ago · 1 h 20 m" ("Recording now", "Processing…"); S / collapsed = "3 new memories · latest 2 h
// ago". Click → the Memories window on that memory (the window's own open path, `openMemories(room, id)`: a live or
// processing one shows the window's notice). Motion: rowSlide (a memory that newly enters). No timer of its own.
import { useEffect, useMemo, useState } from "react";
import { cx } from "@/ui";
import { openMemories } from "@/features/media";
import { MEM_ROWS, memLine, memSummary, memoriesOf, type MemItem, type MemRoom } from "@/widgets/memories";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { useFreshIds } from "../motion";
import { SAMPLE_SERVER } from "../names";
import { posterBlob, refreshMemories, useMemoriesData } from "./store";
import s from "./Memories.module.css";

export interface MemoriesModel {
  items: MemItem[];
  loading: boolean;
  error: boolean;
  /** the clock the rows read ("2 h ago") */
  now: number;
}

function useModel(ctx: WidgetCtx): MemoriesModel {
  void ctx;
  const st = useMemoriesData(true);
  return useMemo(() => {
    const items = memoriesOf(st.rooms as MemRoom[], MEM_ROWS.L);
    return { items, loading: st.loading, error: st.error, now: st.at ?? Date.now() };
  }, [st.rev]); // eslint-disable-line react-hooks/exhaustive-deps
}

const glyphOf = (m: MemItem) => (m.state === "live" ? "🔴" : m.state === "processing" ? "⏳" : "📼");

function Poster({ m, index }: { m: MemItem; index: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // sample memories (the gallery, the gates) have no frames: their posters show the glyph, as one still loading does
    if (!m.poster || m.room.endsWith(`:${SAMPLE_SERVER}`)) return;
    let alive = true;
    // staggered like the Memories window's cards (250 + 350·i ms), then one request per memory for the page's life
    const t = window.setTimeout(() => {
      void posterBlob(m.room, m.id, m.poster!.file, m.poster!.t).then((u) => alive && setSrc(u));
    }, 250 + 350 * index);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [m.room, m.id, m.poster?.file, m.poster?.t, index]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className={s.poster} data-state={m.state}>
      {src ? <img className={s.posterImg} src={src} alt="" draggable={false} /> : <span className={s.glyph}>{glyphOf(m)}</span>}
    </span>
  );
}

function Row({ m, index, model, ctx, enter }: { m: MemItem; index: number; model: MemoriesModel; ctx: WidgetCtx; enter: boolean }) {
  const open = () => !ctx.preview && !m.room.endsWith(`:${SAMPLE_SERVER}`) && openMemories(m.room, m.id);
  return (
    <div
      className={cx(s.row, enter && "tw-enter-up")}
      role="button"
      tabIndex={ctx.preview ? -1 : 0}
      data-memory={m.id}
      title={`${m.title} · ${memLine(m, model.now)}`}
      onClick={open}
      onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
    >
      <Poster m={m} index={index} />
      <span className={s.text}>
        <span className={s.title}>{m.title}</span>
        <span className={s.line} data-state={m.state}>
          {m.state === "live" && <span className={s.liveDot} aria-hidden />}
          {memLine(m, model.now)}
        </span>
      </span>
    </div>
  );
}

function Body({ model: m, ctx }: PartProps<MemoriesModel>) {
  const limit = ctx.size === "L" && !ctx.preview ? MEM_ROWS.L : MEM_ROWS.M;
  const shown = m.items.slice(0, limit);
  const fresh = useFreshIds(shown.map((x) => `${x.room}/${x.id}`));
  if (!shown.length) {
    if (m.loading) return <div className={s.status}>Looking for memories…</div>;
    if (m.error)
      return (
        <div className={s.status}>
          Can't reach the recordings server ·{" "}
          <button type="button" className={s.linkBtn} disabled={ctx.preview} data-no-drag="" onClick={(e) => (e.stopPropagation(), void refreshMemories())}>
            Retry
          </button>
        </div>
      );
    return (
      <div className={s.empty}>
        <span>No memories yet</span>
        <span className={s.emptyHint}>Press ⏺ Rec in a call to keep it for reliving later.</span>
      </div>
    );
  }
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {shown.map((x, i) => (
        <Row key={`${x.room}/${x.id}`} m={x} index={i} model={m} ctx={ctx} enter={fresh.has(`${x.room}/${x.id}`)} />
      ))}
    </div>
  );
}

function Summary({ model: m }: PartProps<MemoriesModel>) {
  return <span className={s.summary}>{m.loading && !m.items.length ? "Looking for memories…" : memSummary(m.items, m.now)}</span>;
}

// ---- samples (the gallery's preview, the review screenshots, the gates; the desktop's MemoriesWidget.qml holds the same)

/** Local time `daysAgo` days back at h:m — a sample reads the same all day. */
function localAt(daysAgo: number, h: number, m: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const LOUNGE = `!lounge:${SAMPLE_SERVER}`;
const SQUAD = `!squad:${SAMPLE_SERVER}`;
function sampleItems(now: number): MemItem[] {
  const S = (id: string, room: string, title: string, start: number, end: number | null, state: MemItem["state"] = "ready"): MemItem => ({
    room,
    id,
    title,
    start,
    end,
    state,
    durMs: end === null ? null : end - start,
    poster: { file: "cam.mkv", t: 8 },
    people: [],
  });
  void now;
  return [
    S("m1", LOUNGE, "Game lounge", localAt(0, 14, 0), localAt(0, 15, 20)),
    S("m2", SQUAD, "Squad chat", localAt(1, 21, 10), localAt(1, 22, 5)),
    S("m3", LOUNGE, "Game lounge", localAt(2, 20, 0), localAt(2, 22, 40)),
    S("m4", LOUNGE, "Game lounge", localAt(4, 19, 30), localAt(4, 20, 15)),
    S("m5", SQUAD, "Squad chat", localAt(6, 18, 0), localAt(6, 18, 45)),
    S("m6", LOUNGE, "Game lounge", localAt(9, 20, 0), localAt(9, 23, 0)),
    S("m7", SQUAD, "Squad chat", localAt(12, 21, 0), localAt(12, 21, 30)),
    S("m8", LOUNGE, "Game lounge", localAt(20, 20, 0), localAt(20, 21, 10)),
  ];
}
/** The samples' clock: today 6:00 PM (so "2 h ago" etc. read the same all day). */
const sampleNow = () => localAt(0, 18, 0);
function sample(opts: { items?: (all: MemItem[], now: number) => MemItem[]; loading?: boolean; error?: boolean } = {}): MemoriesModel {
  const now = sampleNow();
  const all = sampleItems(now);
  return { items: opts.items ? opts.items(all, now) : all, loading: !!opts.loading, error: !!opts.error, now };
}

export const memories = defineWidget<MemoriesModel>({
  id: "memories",
  useModel,
  live: () => false,
  Summary,
  Body,
  hasData: (m) => m.items.length > 0,
  samples: {
    preview: () => sample(),
    data: () => sample(),
    live: () => sample({ items: (all, now) => [{ ...all[0]!, id: "m0", start: now - 25 * 60_000, end: null, state: "live", durMs: null }, ...all.slice(0, 7)] }),
    processing: () => sample({ items: (all) => [{ ...all[0]!, state: "processing" }, ...all.slice(1)] }),
    one: () => sample({ items: (all) => all.slice(0, 1) }),
    empty: () => sample({ items: () => [] }),
    loading: () => sample({ items: () => [], loading: true }),
    error: () => sample({ items: () => [], error: true }),
  },
});
