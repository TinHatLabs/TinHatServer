// watchparty/Browse.tsx — the Browse pane (11.4, DESIGN §2.4): tabs Search · Music · Trending · Playlists · History
// under the one box. Search = type chips (Videos / Music / Playlists / Channels) + autocomplete rows; Music = song
// results (art · title · artist); Trending = category chips; Playlists = a pasted playlist / channel link's items with
// "Add all"; History = this room's last 50 plays (dev.tinhat.mediaparty.history) with Play again / Add. Rows:
// thumbnail · title · channel · duration · views · Add / Play now. The native twin is the same pane in
// WatchPartyWindow.qml (browse section).
// 11.3 QOL (QOL.md §6): a row whose url is already in the queue shows a check "In the queue" in place of Add (Add flips
// it at once — optimistic); a typed playlist / channel link waits 400 ms after the last keystroke before listing it.
import { useEffect, useMemo, useRef, useState } from "react";
import { peekClient, useRoomState } from "@/core/matrix";
import { BusyIndicator, Button, Icon, ToolButton, cx, useTip } from "@/ui";
import { shortName } from "../shared/format";
import { enqueue, enqueueItem, enqueueItems, fmtTime, playUrl, type QueueItem } from "./engine";
import { parseMediaLink } from "./links";
import { youTubeId } from "./player";
import { BUDGET_MESSAGE, SEARCH_TYPES, TRENDING_CATS, HISTORY_EVENT, clearListing, clearSuggestions, fmtViews, loadListing, loadTrending, normHistory, queueItemOf, searchYouTube, setTab, useBrowse, type BrowseItem, type BrowseTab, type SearchType } from "./browseStore";
import s from "./WatchParty.module.css";

const TABS: readonly { id: BrowseTab; label: string }[] = [
  { id: "search", label: "Search" },
  { id: "music", label: "Music" },
  { id: "trending", label: "Trending" },
  { id: "playlists", label: "Playlists" },
  { id: "history", label: "History" },
];

export interface BrowseProps {
  roomId: string;
  canControl: boolean;
  inParty: boolean;
  /** the server offers YouTube search / browsing (docs/SELFHOST.md `watch`); false = only the History tab, which
   *  comes from the room's own state — pasted links keep working through the one box */
  watch: boolean;
  /** the one box's text (words) — the Search / Music tabs run it */
  query: string;
  /** the one box holds a playlist / channel link → the Playlists tab lists it */
  link: ReturnType<typeof parseMediaLink>;
  /** the party's queue (rows already in it show "In the queue") */
  queue: QueueItem[];
  onPick: (text: string) => void;
}

/** The same video whatever link shape it came in (watch / youtu.be / music.youtube.com …). */
export function queueKey(url: string): string {
  const y = youTubeId(url);
  return y ? `yt:${y.id}` : url.trim();
}
export const LISTING_DEBOUNCE_MS = 400;

function InQueue() {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, "Already in the queue");
  return (
    <span ref={ref} className={s.inQueue} data-testid="mp-in-queue">
      <Icon name="checkmark-symbolic" size={16} color="var(--th-watchparty-meta-fg)" />
      <span>In the queue</span>
    </span>
  );
}

function Chip({ text, on, onClick }: { text: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx(s.chip, on && s.chipOn)} onClick={onClick} aria-pressed={on}>
      {text}
    </button>
  );
}

function ItemRow({ it, music, canControl, inParty, queued, onAdd, onOpenListing }: { it: BrowseItem; music: boolean; canControl: boolean; inParty: boolean; queued: boolean; onAdd: (q: QueueItem) => void; onOpenListing: (it: BrowseItem) => void }) {
  const meta = [it.channel, it.durationSec ? fmtTime(it.durationSec) : "", fmtViews(it.views), it.itemCount ? `${it.itemCount} videos` : ""].filter(Boolean).join(" · ");
  const q = queueItemOf(it, music);
  return (
    <div className={cx(s.rRow, s.bRow)} data-testid={`mp-browse-${it.kind}`}>
      {it.thumb && <img className={cx(s.thumb, music && s.thumbSq, it.kind === "channel" && s.thumbRound)} src={it.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <span className={s.bText}>
        <span className={s.rTitle}>{it.title || it.url}</span>
        {meta && <span className={s.bMeta}>{meta}</span>}
      </span>
      {it.kind === "video" ? (
        <>
          {queued ? <InQueue /> : <ToolButton iconName="list-add" tip="Add to queue" disabled={!inParty} className={s.rowBtn} onClick={() => onAdd(q)} />}
          <ToolButton iconName="media-playback-start" tip="Play now" disabled={!canControl} className={s.rowBtn} onClick={() => { if (!queued) onAdd(q); playUrl(q.url); }} />
        </>
      ) : (
        <Button text={it.kind === "playlist" ? "Open playlist" : "Open channel"} onClick={() => onOpenListing(it)} />
      )}
    </div>
  );
}

export function BrowsePane({ roomId, canControl, inParty, watch, query, link, queue, onPick }: BrowseProps) {
  const b = useBrowse();
  const myId = peekClient()?.getUserId() ?? "";
  const history = normHistory(useRoomState(roomId, HISTORY_EVENT, ""));
  const music = b.tab === "music";
  // without YouTube on this server only History is a tab (the others are the API's), and the pane sits on it
  const tabs = watch ? TABS : TABS.filter((t) => t.id === "history");
  useEffect(() => {
    if (!watch && b.tab !== "history") setTab("history");
  }, [watch, b.tab]);

  // "In the queue": what the queue holds + what I just added (optimistic until the room's queue shows it)
  const inQueue = useMemo(() => new Set(queue.map((q) => queueKey(q.url))), [queue]);
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setAdded((a) => {
      if (!a.size) return a;
      const n = new Set([...a].filter((k) => !inQueue.has(k)));
      return n.size === a.size ? a : n;
    });
  }, [inQueue]);
  const isQueued = (url: string) => inQueue.has(queueKey(url)) || added.has(queueKey(url));
  const markAdded = (urls: string[]) => setAdded((a) => new Set([...a, ...urls.map(queueKey)]));
  const add = (q: QueueItem) => {
    markAdded([q.url]);
    enqueueItem(q);
  };

  // the one box drives Search / Music; a playlist / channel link drives Playlists — 400 ms after the last keystroke
  // (typing a link char by char used to fire a listing request per character once the id looked long enough)
  useEffect(() => {
    if (!watch) return; // nothing to ask the API for
    if (link.kind === "playlist" && link.id) {
      const t = window.setTimeout(() => void loadListing("playlist", link.id!, "", link.service === "ytmusic"), LISTING_DEBOUNCE_MS);
      return () => window.clearTimeout(t);
    }
    if (link.kind === "channel" && (link.handle || link.id)) {
      const t = window.setTimeout(() => void loadListing("channel", link.handle || link.id || ""), LISTING_DEBOUNCE_MS);
      return () => window.clearTimeout(t);
    }
    if (link.kind !== "text") return;
    if (b.tab === "search" || b.tab === "music") void searchYouTube(query, b.tab === "music" ? "music" : b.type);
  }, [watch, query, link.kind, link.id, link.handle, b.tab, b.type]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickType = (t: SearchType) => {
    useBrowse.setState({ type: t });
    if (query) void searchYouTube(query, t);
  };
  const openListing = (it: BrowseItem) => {
    setTab("playlists");
    void loadListing(it.kind === "channel" ? "channel" : "playlist", it.id, "", music || (b.tab === "search" && b.type === "music"));
  };
  const addAll = () => {
    const l = b.listing;
    if (!l) return;
    const items = l.items.filter((it) => it.kind === "video").map((it) => queueItemOf(it, b.listingMusic));
    markAdded(items.map((q) => q.url));
    enqueueItems(items);
  };

  return (
    <div className={s.browse} data-testid="mp-browse">
      <div className={s.tabs} role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={b.tab === t.id} className={cx(s.tab, b.tab === t.id && s.tabOn)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {b.tab === "search" && (
        <>
          <div className={s.chips}>
            {SEARCH_TYPES.map((t) => (
              <Chip key={t.id} text={t.label} on={b.type === t.id} onClick={() => pickType(t.id)} />
            ))}
          </div>
          {b.suggestions.length > 0 && (
            <div className={s.suggest} role="listbox">
              {b.suggestions.map((sg) => (
                <button key={sg} type="button" role="option" className={s.suggestRow} onClick={() => { clearSuggestions(); onPick(sg); }}>
                  {sg}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {b.tab === "trending" && (
        <div className={s.chips}>
          {TRENDING_CATS.map((c) => (
            <Chip key={c.id} text={c.label} on={b.cat === c.id} onClick={() => void loadTrending(c.id)} />
          ))}
        </div>
      )}

      {(b.tab === "search" || b.tab === "music" || b.tab === "trending") && (
        <>
          {b.error && <div className={cx(s.dimSmall, s.addNote)}>{b.budget ? BUDGET_MESSAGE : b.error}</div>}
          {b.loading && !b.items.length && <BusyIndicator size={27} color="var(--th-watchparty-busy-fg)" className={s.busyCenter} />}
          {!b.loading && !b.error && query.length > 0 && b.tab !== "trending" && b.items.length === 0 && <div className={s.noResults}>No results</div>}
          {b.items.length > 0 && (
            <div className={s.results}>
              {b.items.map((it) => (
                <ItemRow key={`${it.kind}-${it.id}`} it={it} music={music || (b.tab === "search" && b.type === "music")} canControl={canControl} inParty={inParty} queued={it.kind === "video" && isQueued(it.url)} onAdd={add} onOpenListing={openListing} />
              ))}
              {b.nextPage && b.tab !== "trending" && <Button text={b.loading ? "Loading…" : "More"} flat disabled={b.loading} onClick={() => void searchYouTube(b.query, music ? "music" : b.type, b.nextPage)} />}
            </div>
          )}
        </>
      )}

      {b.tab === "playlists" && (
        <>
          {!b.listing && !b.listingLoading && <div className={s.dimSmall}>Paste a playlist or channel link in the box above, or open one from the search results.</div>}
          {b.listingLoading && !b.listing && <BusyIndicator size={27} color="var(--th-watchparty-busy-fg)" className={s.busyCenter} />}
          {b.listingError && <div className={cx(s.dimSmall, s.addNote)}>{b.listingError}</div>}
          {b.listing && (
            <>
              <div className={s.listingHead}>
                {b.listing.thumb && <img className={s.thumb} src={b.listing.thumb} alt="" referrerPolicy="no-referrer" />}
                <span className={s.bText}>
                  <span className={s.rTitle}>{b.listing.title}</span>
                  <span className={s.bMeta}>{[b.listing.channel, b.listing.itemCount ? `${b.listing.itemCount} videos` : ""].filter(Boolean).join(" · ")}</span>
                </span>
                <Button text="Add all" highlighted disabled={!inParty || !b.listing.items.length} onClick={addAll} />
                <ToolButton iconName="window-close-symbolic" iconSize={16} tip="Close" className={s.rowBtn} onClick={clearListing} />
              </div>
              <div className={s.results}>
                {b.listing.items.map((it) => (
                  <ItemRow key={`${it.kind}-${it.id}`} it={it} music={b.listingMusic} canControl={canControl} inParty={inParty} queued={it.kind === "video" && isQueued(it.url)} onAdd={add} onOpenListing={openListing} />
                ))}
                {b.listing.nextPage && <Button text={b.listingLoading ? "Loading…" : "More"} flat disabled={b.listingLoading} onClick={() => void loadListing(b.listing!.id.startsWith("UC") ? "channel" : "playlist", b.listing!.id, b.listing!.nextPage)} />}
              </div>
            </>
          )}
        </>
      )}

      {b.tab === "history" && (
        <>
          {!history.length && <div className={s.dimSmall}>Nothing played here yet — what the party plays shows up here (the last 50).</div>}
          {history.length > 0 && (
            <div className={s.results}>
              {history.map((h) => {
                const item: QueueItem = { ...h };
                delete (item as Partial<typeof h>).playedAt;
                delete (item as Partial<typeof h>).by;
                return (
                  <div key={`${h.playedAt}-${h.url}`} className={cx(s.rRow, s.bRow)} data-testid="mp-history-row">
                    {h.art && <img className={s.thumb} src={h.art} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                    <span className={s.bText}>
                      <span className={s.rTitle}>{h.title || h.url}</span>
                      <span className={s.bMeta}>{[h.artist, h.by ? `played by ${h.by === myId ? "you" : shortName(h.by)}` : "", h.playedAt ? new Date(h.playedAt).toLocaleDateString() : ""].filter(Boolean).join(" · ")}</span>
                    </span>
                    {isQueued(item.url) ? (
                      <InQueue />
                    ) : (
                      <ToolButton
                        iconName="list-add"
                        tip="Add to queue"
                        disabled={!inParty}
                        className={s.rowBtn}
                        onClick={() => {
                          markAdded([item.url]);
                          if (item.title) enqueueItem(item);
                          else enqueue(item.url, "");
                        }}
                      />
                    )}
                    <ToolButton iconName="media-playback-start" tip="Play again" disabled={!canControl} className={s.rowBtn} onClick={() => { if (!isQueued(item.url)) add(item); playUrl(item.url); }} />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
