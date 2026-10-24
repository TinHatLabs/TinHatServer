// SoundboardPopover.tsx — SoundboardPopover.qml: the non-modal soundboard board inside the main window.
//
// Desktop: 680 px wide (window − 40 max), height = content clamped to [220, window − 140], centred
// horizontally, bottom edge 120 px above the window bottom (min top 16). Esc / press outside / ✕
// close; opening focuses the search. Phones: a bottom sheet with a grid of big buttons.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { peekClient, useAccountData } from "@/core/matrix";
import { useIsMobile, useIsTouch } from "@/ui";
import { BasicToolButton, ContextMenu, Icon, MenuItem, MenuSeparator, OverlayPortal, ScrollArea, SearchField, usePopupStack, cx } from "@/ui";
import { useShallow } from "zustand/react/shallow";
import { useRoute } from "@/app/router";
import * as callui from "@/features/callui";
import { PERSONAL_TYPE, useRoomSounds, usePersonalSounds, type Sound } from "./data";
import {
  addFavourite,
  addToRoom,
  clearPersonalOverride,
  closeSoundboard,
  removeFavourite,
  removeFromRoom,
  setQuery,
  toggleSound,
  upload,
  useSoundboard,
} from "./store";
import { nameFromFile } from "./data";
import s from "./Soundboard.module.css";

const ACCEPT = ".mp3,.ogg,.opus,.wav,.m4a,.webm,audio/*";

// MED-07: callui exports `useHoldCallChrome(open)` ("e.g. media's soundboard popover") — keeps the call
// bar visible while the board is open. Looked up dynamically (the callui stub of a lone worktree lacks it);
// a module-level constant, so the hook order never changes. Esc precedence comes from the popup stack
// (callui's "leave fill-the-app" Esc only runs at popup depth 0).
const noHold = (_open: boolean) => {};
const useHoldCallChrome = (Reflect.get(callui as object, "useHoldCallChrome") as ((open: boolean) => void) | undefined) ?? noHold;

/** The room whose sounds the board shows: the open room of the main window. */
export function useOpenRoomId(): string {
  const route = useRoute();
  const t = route.name === "room" ? route.target : "";
  if (t.startsWith("!")) return t;
  if (t.startsWith("#")) {
    const r = peekClient()?.getRooms().find((x) => x.getCanonicalAlias() === t);
    return r?.roomId ?? "";
  }
  return "";
}

function matches(q: string) {
  const n = q.trim().toLowerCase();
  return (d: { name: string }) => n.length === 0 || d.name.toLowerCase().includes(n);
}

export function SoundboardHost() {
  const open = useSoundboard((st) => st.open);
  if (!open) return null;
  return <SoundboardPopover />;
}

function SoundboardPopover() {
  const mobile = useIsMobile();
  const touch = useIsTouch();
  const roomId = useOpenRoomId();
  const me = peekClient()?.getUserId() ?? "";
  // everything but the ≤ 4 Hz `progress` (the cards subscribe to that themselves)
  const st = useSoundboard(
    useShallow((x) => ({
      openSeq: x.openSeq,
      query: x.query,
      web: x.web,
      searching: x.searching,
      playingUrl: x.playingUrl,
      localNote: x.localNote,
      errorText: x.errorText,
      uploading: x.uploading,
      recent: x.recent,
      personalOverride: x.personalOverride,
      demoPersonal: x.demoPersonal,
      demoRoom: x.demoRoom,
    })),
  );
  const synced = usePersonalSounds();
  const personal = st.demoPersonal ?? st.personalOverride ?? synced;
  const liveRoomSounds = useRoomSounds(roomId);
  const roomSounds = st.demoRoom ?? liveRoomSounds;
  const personalContent = useAccountData(PERSONAL_TYPE);
  useEffect(() => clearPersonalOverride(), [personalContent]);

  const q = st.query;
  const favShown = useMemo(() => personal.filter(matches(q)), [personal, q]);
  const roomShown = useMemo(() => roomSounds.filter(matches(q)), [roomSounds, q]);
  const recentShown = useMemo(
    () => st.recent.filter(matches(q)).map((r) => ({ name: r.name, sourceUrl: r.url, emoji: r.emoji, duration: 0 }) as Sound),
    [st.recent, q],
  );
  const webSearchable = q.trim().length >= 2;

  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useHoldCallChrome(true);
  usePopupStack(true, panel, {
    onEscape: closeSoundboard,
    onOutside: closeSoundboard,
    inside: () => Array.from(document.querySelectorAll<HTMLElement>("[data-sb-keep]")),
  });

  // focus the search box on open and on every re-open request
  useEffect(() => {
    const id = window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(id);
  }, [st.openSeq]);

  // geometry (desktop)
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [contentH, setContentH] = useState(0);
  useEffect(() => {
    const on = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      const h = (head.current?.offsetHeight ?? 0) + (content.current?.offsetHeight ?? 0);
      setContentH(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (head.current) ro.observe(head.current);
    if (content.current) ro.observe(content.current);
    return () => ro.disconnect();
  }, [mobile]);
  const width = Math.min(680, win.w - 40);
  const height = Math.min(win.h - 140, Math.max(220, contentH));
  const left = Math.round((win.w - width) / 2);
  const top = Math.max(16, win.h - height - 120);

  const favIndexOf = (url: string) => personal.findIndex((p) => p.sourceUrl === url);
  const roomEntry = (url: string) => roomSounds.find((r) => r.sourceUrl === url) ?? null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.altKey && !e.metaKey && document.activeElement !== search.current) {
      const d = favShown[Number(e.key) - 1];
      if (d) toggleSound(d.sourceUrl, d.name, d.emoji);
      e.preventDefault();
    }
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (panel.current && e.relatedTarget instanceof Node && panel.current.contains(e.relatedTarget)) return;
      setDragOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void upload(f, nameFromFile(f.name));
    },
  };

  const card = (d: Sound, i: number, kind: "fav" | "room" | "recent" | "web") => {
    const removable = kind === "fav" || (kind === "room" && !!me && d.setBy === me);
    const onRemove =
      kind === "fav" ? () => void removeFavourite(favIndexOf(d.sourceUrl)) : kind === "room" ? () => void removeFromRoom(roomId, d.stateKey ?? "") : undefined;
    return (
      <SoundCard
        key={`${kind}-${d.stateKey ?? ""}-${d.sourceUrl}-${i}`}
        sound={d}
        hotkey={kind === "fav" && i < 9 && !touch ? i + 1 : 0}
        removable={removable && !touch}
        onRemove={onRemove}
        menu={(close) => {
          const playing = d.sourceUrl === st.playingUrl;
          const fav = favIndexOf(d.sourceUrl) >= 0;
          const re = roomEntry(d.sourceUrl);
          return (
            <>
              <MenuItem
                text={playing ? "Stop" : "Play"}
                icon={playing ? "media-playback-stop" : "media-playback-start"}
                onTriggered={() => {
                  close();
                  toggleSound(d.sourceUrl, d.name, d.emoji);
                }}
              />
              <MenuSeparator />
              <MenuItem
                text={fav ? "Remove from favourites" : "Add to favourites"}
                icon={fav ? "starred-symbolic" : "non-starred-symbolic"}
                onTriggered={() => {
                  close();
                  const idx = favIndexOf(d.sourceUrl);
                  if (idx >= 0) void removeFavourite(idx);
                  else void addFavourite(d.name || "Sound", d.sourceUrl, d.emoji, 0);
                }}
              />
              <MenuItem
                text={re ? "Remove from room sounds" : "Add to room sounds"}
                icon={re ? "list-remove-symbolic" : "list-add-symbolic"}
                disabled={!roomId || (!!re && !(me && re.setBy === me))}
                onTriggered={() => {
                  close();
                  if (re) void removeFromRoom(roomId, re.stateKey ?? "");
                  else void addToRoom(roomId, d.name || "Sound", d.sourceUrl, d.emoji);
                }}
              />
              <MenuSeparator />
              <MenuItem
                text="Copy link"
                icon="edit-copy-symbolic"
                onTriggered={() => {
                  close();
                  void navigator.clipboard?.writeText(d.sourceUrl).catch(() => {});
                }}
              />
            </>
          );
        }}
      />
    );
  };

  const grid = (list: Sound[], kind: "fav" | "room" | "recent" | "web") => <div className={s.grid}>{list.map((d, i) => card(d, i, kind))}</div>;

  const msg = st.errorText || st.localNote;
  const body: ReactNode = (
    <div ref={content} className={s.content}>
      <div style={{ height: 2 }} />
      <SectionHead title={`Favourites${favShown.length > 0 ? ` · ${favShown.length}` : ""}`} hint={favShown.length > 0 && !touch ? "press 1-9 to play" : ""} />
      {favShown.length > 0 ? (
        grid(favShown, "fav")
      ) : (
        <div className={s.empty}>
          {personal.length === 0
            ? `Nothing here yet — add a clip with + Add, or search below. ${touch ? "Long-press" : "Right-click"} any sound to favourite it.`
            : `No favourites match “${q.trim()}”.`}
        </div>
      )}
      <SectionHead title={`Room sounds${roomShown.length > 0 ? ` · ${roomShown.length}` : ""}`} hint="shared with everyone in this room" />
      {roomShown.length > 0 ? (
        grid(roomShown, "room")
      ) : (
        <div className={s.empty}>
          {roomSounds.length === 0 ? `Nothing shared yet — ${touch ? "long-press" : "right-click"} a sound → Add to room sounds.` : `No room sounds match “${q.trim()}”.`}
        </div>
      )}
      {recentShown.length > 0 && (
        <>
          <SectionHead title="Recent" hint="" />
          {grid(recentShown, "recent")}
        </>
      )}
      <SectionHead
        title={`From the web${st.web.length > 0 ? ` · ${st.web.length}` : ""}`}
        hint={st.searching ? "searching…" : webSearchable ? "" : "type two letters to search myinstants"}
      />
      {st.web.length > 0 && grid(st.web, "web")}
      {webSearchable && !st.searching && st.web.length === 0 && <div className={s.empty}>{`No results on the web for “${q.trim()}”.`}</div>}
      <div className={s.footer}>{touch ? "Long-press a sound for more · web results by myinstants" : "Right-click a sound for more · web results by myinstants"}</div>
    </div>
  );

  const header = (
    <div ref={head} className={s.headWrap}>
      {mobile && <div className={s.grab} />}
      <div className={s.header}>
        <Icon name="emblem-music-symbolic" size={22} color="var(--th-soundboard-title-icon)" />
        <span className={s.title}>Soundboard</span>
        <SearchField
          ref={search}
          className={s.search}
          value={q}
          onValueChange={setQuery}
          placeholder="Search your sounds and the web…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const d = favShown[0];
              if (d) toggleSound(d.sourceUrl, d.name, d.emoji);
              e.preventDefault();
            }
          }}
        />
        <BasicToolButton
          iconName="list-add-symbolic"
          text={st.uploading ? "Uploading…" : "Add"}
          disabled={st.uploading}
          className={s.addBtn}
          tip="Upload your own clip (mp3/ogg/wav, 3 MB) — or drop a file on the board"
          onClick={() => fileInput.current?.click()}
        />
        <BasicToolButton iconName="window-close-symbolic" display="iconOnly" className={s.closeBtn} tip="Close" aria-label="Close" onClick={closeSoundboard} />
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          hidden
          aria-label="Add a sound"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f, nameFromFile(f.name));
          }}
        />
      </div>
      {msg && <div className={cx(s.msg, st.errorText ? s.msgError : s.msgNote)}>{msg}</div>}
    </div>
  );

  return (
    <OverlayPortal>
      {mobile && <div className={s.sheetDim} />}
      <div
        ref={panel}
        role="dialog"
        aria-label="Soundboard"
        className={cx(s.panel, mobile && s.mobile)}
        style={mobile ? undefined : { left, top, width, height }}
        onKeyDown={onKeyDown}
        {...dropProps}
      >
        {header}
        <ScrollArea className={s.body} contentClassName={s.bodyScroll}>
          {body}
        </ScrollArea>
        {dragOver && (
          <div className={s.drop}>
            <span>Drop to add this sound</span>
          </div>
        )}
      </div>
    </OverlayPortal>
  );
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={s.sectionHead}>
      <span className={s.sectionTitle}>{title}</span>
      <span className={s.sectionHint}>{hint}</span>
    </div>
  );
}

function SoundCard({
  sound,
  hotkey,
  removable,
  onRemove,
  menu,
}: {
  sound: Sound;
  hotkey: number;
  removable: boolean;
  onRemove?: () => void;
  menu: (close: () => void) => ReactNode;
}) {
  const playing = useSoundboard((st) => !!sound.sourceUrl && st.playingUrl === sound.sourceUrl);
  const progress = useSoundboard((st) => (playing ? st.progress : 0));
  // a touch long-press opens the card menu — the click that follows the lift must not play the sound
  const press = useRef({ at: 0, touch: false });
  return (
    <ContextMenu menu={menu} width={200}>
      <div
        className={cx(s.card, playing && s.playing)}
        role="button"
        tabIndex={0}
        aria-label={sound.name}
        aria-pressed={playing}
        onPointerDown={(e) => {
          press.current = { at: performance.now(), touch: e.pointerType === "touch" };
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(`.${s.remove}`)) return;
          if (press.current.touch && performance.now() - press.current.at >= 450) return;
          toggleSound(sound.sourceUrl, sound.name, sound.emoji);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            toggleSound(sound.sourceUrl, sound.name, sound.emoji);
          }
        }}
      >
        <div className={s.emojiBox}>
          {playing ? (
            <>
              <svg width="40" height="40" viewBox="0 0 40 40" className={s.ring} aria-hidden>
                <circle cx="20" cy="20" r="18" fill="none" stroke="var(--th-soundboard-progress-track)" strokeWidth="3" />
                <circle
                  cx="20"
                  cy="20"
                  r="18"
                  fill="none"
                  stroke="var(--th-soundboard-progress-fill)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 18 * progress} ${2 * Math.PI * 18}`}
                  transform="rotate(-90 20 20)"
                  style={{ opacity: progress > 0 ? 1 : 0 }}
                />
              </svg>
              <Icon name="media-playback-stop" size={18} color="var(--th-soundboard-card-icon-active)" className={s.stopGlyph} />
            </>
          ) : (
            <span className={s.emoji}>{sound.emoji || "🔊"}</span>
          )}
        </div>
        <span className={s.name}>{sound.name}</span>
        {hotkey > 0 && <span className={s.badge}>{hotkey}</span>}
        {removable && onRemove && (
          <BasicToolButton
            iconName="edit-delete-remove"
            display="iconOnly"
            className={s.remove}
            tip="Remove"
            aria-label="Remove"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          />
        )}
      </div>
    </ContextMenu>
  );
}
