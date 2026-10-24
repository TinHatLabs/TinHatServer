// ThemeGallery.tsx — THEMES-UI.md §4: the "Themes" page (Settings → Appearance → All themes). The toolbar (back, title,
// Import; search, All / Dark / Light, the summary + Undo), then Favourites, My themes and All themes — the last one
// virtualized (only the rows in view ± 2 exist) — filtered live by the search and the variant. A dropped file opens
// the import dialog with it.
import { useMemo, useRef, useState, type DragEvent } from "react";
import { BasicToolButton, Button, EmptyState, ScrollArea, SearchField, ToolButton, useIsMobile } from "@/ui";
import { entryOf, useLibrary, type LibraryEntry } from "@/ui/themeLibrary";
import { chooseTheme, undoLast, useThemeState, type MyTheme } from "@/ui/themeStore";
import { ThemeCard } from "./ThemeCard";
import { ThemeGrid, VirtualThemeGrid, type CellRender } from "./ThemeGrid";
import { ThemeNotices, ThemeSummary, libraryThemeMenu, myThemeMenu, type MyThemeActions } from "./ThemeSection";
import { readThemeFile, type ImportSeed } from "./ImportDialog";
import t from "./themes.module.css";

type Filter = "all" | "dark" | "light";

export function ThemeGallery({ onBack, onImport, actions }: { onBack: () => void; onImport: (seed?: ImportSeed) => void; actions: MyThemeActions }) {
  const st = useThemeState();
  const lib = useLibrary();
  const mobile = useIsMobile();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [drag, setDrag] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const activeId = st.colours.theme;

  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const { favs, all, mine } = useMemo(() => {
    const match = (e: LibraryEntry) => (filter === "all" || e.variant === filter) && words.every((w) => e.search.includes(w));
    return {
      favs: lib ? lib.favourites.filter(match) : [],
      all: lib ? lib.all.filter(match) : [],
      mine: st.myThemes.map((m) => ({ m, e: entryOf(m.doc) })).filter(({ e }) => match(e)),
    };
  }, [lib, words, filter, st.myThemes]);
  const searching = words.length > 0 || filter !== "all";
  const total = lib?.all.length ?? 1190;

  const card = (e: LibraryEntry): CellRender => (p) => (
    <ThemeCard
      key={e.id}
      doc={e.doc}
      library
      active={e.id === activeId}
      onPick={() => chooseTheme(e.doc, { inSettings: true })}
      menu={libraryThemeMenu(e.doc, e.id === activeId, true, actions)}
      {...p}
    />
  );
  const mineCard = (m: MyTheme): CellRender => (p) => (
    <ThemeCard
      key={m.id}
      doc={m.doc}
      active={m.id === activeId}
      onPick={() => chooseTheme(m.doc, { inSettings: true })}
      menu={myThemeMenu(m, m.id === activeId, actions)}
      {...p}
    />
  );

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const filterButtons = (
    <div className={t.filter} role="radiogroup" aria-label="Show">
      {(["all", "dark", "light"] as Filter[]).map((f) => (
        <BasicToolButton
          key={f}
          display="textOnly"
          text={f === "all" ? "All" : f === "dark" ? "Dark" : "Light"}
          checked={filter === f}
          role="radio"
          aria-checked={filter === f}
          aria-pressed={undefined}
          onClick={() => setFilter(f)}
        />
      ))}
    </div>
  );
  const clear = () => {
    setQ("");
    setFilter("all");
  };

  return (
    <div
      className={t.page}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDrag(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void readThemeFile(f).then((seed) => onImport(seed));
      }}
    >
      <div className={t.toolbar}>
        {!mobile && (
          <div className={t.toolRow}>
            <BasicToolButton iconName="go-previous-symbolic" text="Appearance" onClick={onBack} />
            <span className={t.title}>Themes</span>
            <span className={t.spacer} />
            {!st.myThemesReadOnly && <Button text="Import a theme…" icon="document-open-symbolic" onClick={() => onImport()} />}
          </div>
        )}
        <ThemeNotices st={st} />
        <div className={t.toolRow}>
          <SearchField
            className={t.search}
            value={q}
            onValueChange={setQ}
            placeholder={`Search ${total.toLocaleString("en-US")} themes`}
            aria-label="Search themes"
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.preventDefault();
                e.stopPropagation();
                setQ("");
              }
            }}
          />
          {!mobile && filterButtons}
          {!mobile && (
            <div className={t.toolRow} style={{ flex: "1 1 auto", minWidth: 0 }}>
              <ThemeSummary st={st} compact onCustomize={actions.customize} />
            </div>
          )}
        </div>
        {mobile && (
          <div className={t.toolRow}>
            {filterButtons}
            <span className={t.spacer} />
            {st.undo && <Button flat icon="edit-undo-symbolic" text="Undo" onClick={() => undoLast()} />}
            {!st.myThemesReadOnly && <ToolButton iconName="document-open-symbolic" tip="Import a theme" onClick={() => onImport()} />}
          </div>
        )}
      </div>
      <ScrollArea ref={scroller} className={t.scroll} contentClassName={t.body} gutter={0}>
        {!lib && <EmptyState loading title="Loading the themes…" />}
        {lib && favs.length > 0 && (
          <section className={t.section}>
            <div className={t.subLabel}>
              Favourites <span>· {favs.length}</span>
            </div>
            <ThemeGrid cells={favs.map(card)} label="Favourite themes" />
          </section>
        )}
        {lib && (mine.length > 0 || (!searching && st.myThemes.length > 0)) && (
          <section className={t.section}>
            <div className={t.subLabel}>
              My themes <span>· {mine.length}</span>
            </div>
            <ThemeGrid cells={mine.map(({ m }) => mineCard(m))} label="My themes" />
          </section>
        )}
        {lib && all.length > 0 && (
          <section className={t.section}>
            <div className={t.subLabel}>
              All themes <span>· {all.length.toLocaleString("en-US")}</span>
            </div>
            <VirtualThemeGrid
              items={all}
              keyOf={(e) => e.id}
              scroller={scroller}
              label="All themes"
              render={(e, p) => card(e)(p)}
            />
          </section>
        )}
        {lib && searching && favs.length === 0 && mine.length === 0 && all.length === 0 && (
          <div className={t.empty}>
            <EmptyState iconName="search" title={words.length ? `No themes match “${q.trim()}”.` : `No ${filter} themes.`} />
            <Button text="Clear search" onClick={clear} />
          </div>
        )}
      </ScrollArea>
      {drag && (
        <div className={t.drop}>
          <span>Drop the theme file to import it</span>
        </div>
      )}
    </div>
  );
}
