// SettingsWindow.tsx — Settings as its own window (SETTINGS-WINDOW.md, 2026-09-29: "as user friendly as possible
// and its own window instead of a floating one"). A registered in-app window (r.windows "settings", 1000×720, min
// 760×540, singleton — a browser can't open an OS window: docs/WEB-EXCEPTIONS.md), the desktop's SettingsWindow.qml:
//
//   rail (240, settings.window.rail.bg, 1 px divider, padding 12): the search field (34, radius 8), then the groups
//     ACCOUNT / VOICE & VIDEO / APP / TIN HAT (11 px 600 uppercase, 16 above / 6 below) of 36 px items (radius 8,
//     icon 18 + 10 + label 13) — ↑/↓ cycle the panes
//   content (settings.window.bg): one scroll area, a column ≤ 720 (padding 28 / 24 top / 32 bottom): the pane's title
//     (22/600) + description (13), 24 gap, the pane's sections → cards → rows (rows.tsx)
//   search: typing replaces the content with results (44 px rows, the matched part bold, "Pane › Section"), ↑/↓ +
//     Enter; opening one switches pane, clears the search, scrolls the row to the centre and flashes it 1.2 s
//   status: the 4 s "Saved" / error line as a strip at the bottom of the content
//   keys: Ctrl+F or / → search; Esc clears a non-empty search, else closes the window (popups take it first)
//
// Phones: the window is full screen with its own header (AppWindow phoneHeader: false): the pane list (search on top,
// the groups as cards) → tap → the pane with a back chevron; Back / the chevron / a left-edge swipe step pane → list →
// closed through the shared back stack (ui/backStack: the sheet is level 0, a pushed pane 1, the theme gallery 2).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type TouchEvent as ReactTouchEvent } from "react";
import { useAppWindow } from "@/app/WindowHost";
import { useRegistry, type SettingsPaneContribution } from "@/core/registry";
import { Icon, ScrollArea, animate, cx, useIsMobile } from "@/ui";
import { useBackToClose } from "@/ui/backStack";
import { useShortcut } from "@/core/shortcuts";
import { GUEST_HIDDEN_SETTINGS, gateOfSetting, isGuestAccount, onServerOffer, serverFeatures, useOffered } from "@/core/server";
import { useSession } from "@/core/matrix";
import { StatusAskBanner } from "@/features/selfhost/asks";
import { refreshDevices, refreshEmails, refreshProfile } from "./profile";
import { useInvites } from "./invites";
import { GROUPS, PANE_META, type GroupId, type PaneMeta } from "./paneMeta";
import { highlightRuns, searchSettings, type SettingsHit, type SettingsIndex } from "./settingsSearch";
import INDEX_JSON from "./settingsIndex.json";
import { closeSettings, isErrorStatus, jumpToSetting, settingsWindowClosed, useSettingsUi, type PaneId } from "./store";
import s from "./SettingsWindow.module.css";

const INDEX = INDEX_JSON as SettingsIndex;

interface PaneEntry {
  meta: PaneMeta;
  c: SettingsPaneContribution;
}

/** The visible panes in rail order, grouped (unknown contributions → the end of APP). */
function usePanes(): { list: PaneEntry[]; groups: Array<{ id: GroupId; label: string; panes: PaneEntry[] }> } {
  const contribs = useRegistry("settingsPanes");
  const operator = useInvites((st) => st.operator);
  // a pane's visible() may read the server's offer (features/guests: the guest room) — re-evaluate when it changes
  const offer = useSyncExternalStore(onServerOffer, serverFeatures, serverFeatures);
  return useMemo(() => {
    const visible = contribs.filter((c) => !c.visible || c.visible());
    const list: PaneEntry[] = [];
    for (const m of PANE_META) {
      const c = visible.find((x) => x.id === m.key);
      if (c) list.push({ meta: m, c });
    }
    for (const c of visible) {
      if (list.some((e) => e.c === c)) continue;
      list.push({ meta: { key: c.id as PaneId, group: "app", label: c.title, icon: c.icon ?? "configure-symbolic", description: "" }, c });
    }
    const ordered = GROUPS.map((g) => ({ ...g, panes: list.filter((e) => e.meta.group === g.id) })).filter((g) => g.panes.length > 0);
    return { list: ordered.flatMap((g) => g.panes), groups: ordered };
    // operator: the Invites pane's visible() reads the invites store; offer: the Guests pane's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contribs, operator, offer]);
}

function useSearch(query: string, panes: readonly PaneEntry[]): SettingsHit[] {
  const operator = useInvites((st) => st.operator);
  // selfhost/firstrun item 1: a row whose feature the server doesn't offer is not on the page, so not in the results
  // (every gated feature — offer.ts SETTING_GATES — through one test); and only rows of the panes this window shows
  // (Settings → Guests: self-hosted builds only, never for a guest account — the same rule as the desktop's)
  const offered = useOffered(gateOfSetting);
  const guest = isGuestAccount(useSession().userId);
  return useMemo(() => {
    const shown = new Set<string>(panes.map((p) => p.meta.key));
    return searchSettings(INDEX, query, { operator, app: "web" }).filter(
      (h) => offered(h.entry.id) && shown.has(h.entry.pane) && !(guest && GUEST_HIDDEN_SETTINGS.includes(h.entry.id)),
    );
  }, [query, operator, offered, panes, guest]);
}

/** Scroll the flashed row to the centre and flash it (1.2 s fade; a static highlight for 1.2 s without motion). */
function useFlash(root: React.RefObject<HTMLElement | null>, ready: boolean, focusControl = false) {
  const flash = useSettingsUi((st) => st.flash);
  useEffect(() => {
    if (!flash || !ready) return;
    let t = 0;
    let tries = 0;
    let el: HTMLElement | null = null;
    const run = () => {
      el = root.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(flash.id)}"]`) ?? null;
      if (!el) {
        // the pane may still be loading its rows (devices, invites): look again for up to ~1 s
        if (++tries < 12) t = window.setTimeout(run, 90);
        return;
      }
      const moving = animate();
      el.scrollIntoView({ block: "center", behavior: moving ? "smooth" : "auto" });
      // desktop: the row's control takes the focus (Enter on a result, then Space flips the switch); never a text field
      // (that would pop a phone's keyboard / swallow the next keys)
      if (focusControl) {
        const c = el.querySelector<HTMLElement>('input[role="switch"], input[type="checkbox"], [role="combobox"], button:not(:disabled), [role="slider"]');
        c?.focus({ preventScroll: true });
      }
      const cls = moving ? "th-flash" : "th-flash-static";
      el.classList.remove("th-flash", "th-flash-static");
      void el.offsetWidth; // restart the animation on a repeat jump
      el.classList.add(cls);
      const node = el;
      t = window.setTimeout(() => node.classList.remove(cls), 1200);
    };
    t = window.setTimeout(run, 30);
    return () => {
      window.clearTimeout(t);
      el?.classList.remove("th-flash", "th-flash-static");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash?.seq, ready]);
}

export function SettingsWindow() {
  const win = useAppWindow();
  const mobile = useIsMobile();
  const ui = useSettingsUi();
  const { list, groups } = usePanes();
  const hits = useSearch(ui.query, list);
  const current = list.find((e) => e.meta.key === ui.pane) ?? list[0];

  // mounted = open; unmounted (✕, Esc, Back, closeSettings) = closed
  useEffect(() => {
    useSettingsUi.setState({ open: true });
    return () => settingsWindowClosed();
  }, []);
  // SET-08: refresh on open (and on every raise)
  useEffect(() => {
    void refreshProfile();
    void refreshEmails();
    void refreshDevices();
  }, [ui.openSeq]);

  const close = () => {
    closeSettings();
    win.close();
  };

  if (mobile) return <PhoneSettings list={list} groups={groups} hits={hits} current={current} close={close} />;
  return <DesktopSettings list={list} groups={groups} hits={hits} current={current} close={close} />;
}

interface ViewProps {
  list: PaneEntry[];
  groups: Array<{ id: GroupId; label: string; panes: PaneEntry[] }>;
  hits: SettingsHit[];
  current: PaneEntry | undefined;
  close: () => void;
}

// ---- desktop ---------------------------------------------------------------------------------------------------------

function DesktopSettings({ list, groups, hits, current, close }: ViewProps) {
  const ui = useSettingsUi();
  const railRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const searching = ui.query.trim().length > 0;
  useEffect(() => setSel(0), [ui.query]);
  useFlash(contentRef, !searching, true);

  // every open / raise: the rail takes the focus (↑/↓ work at once); a pane switch starts at the top
  useLayoutEffect(() => {
    railRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  }, [ui.openSeq]);
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 }); // a jump to a row scrolls on from here (useFlash)
  }, [ui.pane]);

  const pick = (key: PaneId) => useSettingsUi.setState({ pane: key, subPage: null, query: "" });
  const openHit = (h: SettingsHit) => jumpToSetting(h.entry.id, h.entry.pane as PaneId);

  const onRailKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const n = list.length;
    const i = Math.max(0, list.findIndex((p) => p.meta.key === ui.pane));
    const next = list[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n];
    pick(next.meta.key);
    requestAnimationFrame(() => railRef.current?.querySelector<HTMLElement>(`[data-pane="${next.meta.key}"]`)?.focus());
  };
  const onSearchKey = (e: KeyboardEvent) => {
    if (!searching) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!hits.length) return;
      setSel((i) => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[sel];
      if (h) openHit(h);
    }
  };
  // Esc: popups first (they preventDefault), then a non-empty search, then the window. Ctrl+F or / → search.
  const onWinKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (useSettingsUi.getState().query) useSettingsUi.setState({ query: "" });
      else close();
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
    if ((e.key === "f" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) || (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      e.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };
  useWindowKeysFallback(winRef, close, searchRef);

  const fullPage = current?.meta.key === "appearance" && ui.subPage === "themes";
  const Pane = current?.c.component;

  return (
    <div ref={winRef} className={s.win} data-settings-window="" onKeyDown={onWinKey}>
      <nav className={s.rail} aria-label="Settings">
        <SearchBox inputRef={searchRef} onKeyDown={onSearchKey} />
        <div ref={railRef} className={s.railList} role="tablist" aria-orientation="vertical" onKeyDown={onRailKey}>
          {groups.map((g) => (
            <div key={g.id} className={s.group} role="presentation">
              <div className={s.groupLabel} role="presentation">
                {g.label}
              </div>
              {g.panes.map((p) => {
                const on = !searching && p.meta.key === current?.meta.key;
                return (
                  <button
                    key={p.meta.key}
                    type="button"
                    role="tab"
                    data-pane={p.meta.key}
                    aria-selected={on}
                    tabIndex={on || (searching && p === list[0]) ? 0 : -1}
                    className={cx(s.item, on && s.itemOn)}
                    onClick={() => pick(p.meta.key)}
                  >
                    <Icon name={p.meta.icon} size={18} color={on ? "var(--th-settings-rail-item-fg-selected)" : "var(--th-settings-rail-item-fg)"} staticOnly />
                    <span className={s.itemLabel}>{p.meta.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
      <div ref={contentRef} className={s.content} role="tabpanel" data-pane-id={searching ? "search" : current?.meta.key}>
        {searching ? (
          <Results hits={hits} sel={sel} setSel={setSel} onOpen={openHit} />
        ) : fullPage && Pane ? (
          <div className={s.fullPage}>
            <Pane key={current.meta.key} />
          </div>
        ) : (
          <ScrollArea ref={scrollRef} className={s.scroll} contentClassName={s.scrollInner}>
            <div className={s.column}>
              {/* selfhost/firstrun: the calm first run asks about online status on the first visit to Settings */}
              <StatusAskBanner />
              {current && (
                <header className={s.paneHead}>
                  <h2 className={s.paneTitle}>{current.meta.label}</h2>
                  {current.meta.description && <p className={s.paneDesc}>{current.meta.description}</p>}
                </header>
              )}
              {Pane && <Pane key={current.meta.key} />}
            </div>
          </ScrollArea>
        )}
        <StatusStrip />
      </div>
    </div>
  );
}

/** Qt's window shortcuts fire wherever focus is inside the window. In a browser a clicked button that disables or
 *  unmounts drops focus to <body>; when the last pointer/focus interaction was inside the window and focus sits on
 *  <body>, Esc / Ctrl+F / "/" still reach it (the Space settings window's fallback, winGeom.ts). Ctrl+F is also the
 *  room list's filter key (a shortcut on the page's capture listener, which runs before any element's handler): a
 *  higher-priority shortcut takes it while the window has the focus and lets it fall through otherwise. */
function useWindowKeysFallback(winRef: React.RefObject<HTMLElement | null>, close: () => void, searchRef: React.RefObject<HTMLInputElement | null>) {
  const cb = useRef(close);
  cb.current = close;
  const insideRef = useRef(true); // the window opens focused
  useShortcut(
    "Ctrl+F",
    () => {
      const a = document.activeElement;
      const here = !!winRef.current && (a && a !== document.body ? winRef.current.contains(a) : insideRef.current);
      if (!here) return false;
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { whenTyping: true, priority: 50, id: "settings.window.search" },
  );
  useEffect(() => {
    const mark = (e: Event) => {
      insideRef.current = !!winRef.current && e.target instanceof Node && winRef.current.contains(e.target);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !insideRef.current) return;
      const a = document.activeElement;
      if (a && a !== document.body) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (useSettingsUi.getState().query) useSettingsUi.setState({ query: "" });
        else cb.current();
      } else if ((e.key === "f" && (e.ctrlKey || e.metaKey)) || e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("focusin", mark, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("focusin", mark, true);
      window.removeEventListener("keydown", key);
    };
  }, [winRef, searchRef]);
}

function SearchBox({ inputRef, onKeyDown, phone }: { inputRef?: React.RefObject<HTMLInputElement | null>; onKeyDown?: (e: KeyboardEvent) => void; phone?: boolean }) {
  const query = useSettingsUi((st) => st.query);
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  return (
    <div className={cx(s.search, phone && s.searchPhone)} data-settings-search="">
      <Icon name="search" size={16} color="var(--th-settings-search-icon)" staticOnly />
      <input
        ref={ref}
        type="search"
        className={s.searchInput}
        placeholder="Search settings"
        aria-label="Search settings"
        value={query}
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => useSettingsUi.setState({ query: e.target.value })}
        onKeyDown={onKeyDown}
      />
      {query && (
        <button
          type="button"
          className={s.searchClear}
          aria-label="Clear search"
          title="Clear search"
          onClick={() => {
            useSettingsUi.setState({ query: "" });
            ref.current?.focus();
          }}
        >
          <Icon name="edit-clear-locationbar-rtl" size={16} color="var(--th-settings-search-icon)" staticOnly />
        </button>
      )}
    </div>
  );
}

function Results({ hits, sel, setSel, onOpen, phone }: { hits: SettingsHit[]; sel: number; setSel: (i: number) => void; onOpen: (h: SettingsHit) => void; phone?: boolean }) {
  const query = useSettingsUi((st) => st.query);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const q = query.trim();
  return (
    <ScrollArea className={s.scroll} contentClassName={cx(s.scrollInner, phone && s.mScrollInner)}>
      <div className={cx(s.column, phone && s.mColumn)}>
        {hits.length === 0 ? (
          <p className={s.empty} role="status">
            No settings match “{q}”.
          </p>
        ) : (
          <>
            <p className={s.resultsCount} role="status">
              {hits.length === 1 ? "1 setting" : `${hits.length} settings`} match “{q}”
            </p>
            <div ref={listRef} className={s.results} role="listbox" aria-label="Search results">
              {hits.map((h, i) => (
                <div
                  key={h.entry.id}
                  role="option"
                  aria-selected={!phone && i === sel}
                  data-result={h.entry.id}
                  className={cx(s.result, !phone && i === sel && s.resultSel)}
                  onPointerEnter={() => !phone && setSel(i)}
                  onClick={() => onOpen(h)}
                >
                  <span className={s.resultLabel}>
                    {highlightRuns(h.entry.label, q).map(([t, b], k) => (b ? <b key={k}>{t}</b> : <span key={k}>{t}</span>))}
                  </span>
                  <span className={s.resultPath}>
                    {h.paneTitle} › {h.entry.section}
                  </span>
                  {phone && <Icon name="go-next-symbolic" size={16} color="var(--th-settings-list-chevron-icon)" staticOnly />}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function StatusStrip() {
  const status = useSettingsUi((st) => st.status);
  const saveBar = useSettingsUi((st) => st.saveBar);
  if (!status || saveBar) return null;
  return (
    <div className={cx(s.status, isErrorStatus(status) && s.statusErr)} role="status" data-settings-status="">
      {status}
    </div>
  );
}

// ---- phones ------------------------------------------------------------------------------------------------------------

/** Phones: once the on-screen keyboard has opened, bring the focused field into the middle of what's left of the screen. */
function keepFieldVisible(e: { target: EventTarget }) {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (el.type === "search" && el.closest("[data-settings-search]")) return;
  setTimeout(() => el.isConnected && el.scrollIntoView({ block: "center", behavior: animate() ? "smooth" : "auto" }), 350);
}

function PhoneSettings({ groups, hits, current, close }: ViewProps) {
  const ui = useSettingsUi();
  const contentRef = useRef<HTMLDivElement>(null);
  const inPane = ui.mobilePane && !!current;
  const searching = !inPane && ui.query.trim().length > 0;
  useFlash(contentRef, inPane);

  // the shared back stack: the window sheet is level 0 (closes); a pushed pane 1 (→ the list); the gallery 2 (→ the pane)
  useBackToClose(inPane, () => void useSettingsUi.setState({ mobilePane: false, subPage: null }), 1);
  useBackToClose(inPane && ui.subPage === "themes", () => void useSettingsUi.setState({ subPage: null }), 2);

  const back = () => {
    const st = useSettingsUi.getState();
    if (st.subPage) useSettingsUi.setState({ subPage: null });
    else if (st.mobilePane) useSettingsUi.setState({ mobilePane: false });
    else close();
  };
  // a left-edge swipe steps back like the browser back button (pane → list → closed)
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    swipe.current = t && t.clientX < 28 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const st = swipe.current;
    swipe.current = null;
    const t = e.changedTouches[0];
    if (st && t && t.clientX - st.x > 80 && Math.abs(t.clientY - st.y) < 60) back();
  };

  const Pane = current?.c.component;
  const title = inPane ? (ui.subPage === "themes" ? "Themes" : (current?.meta.label ?? "Settings")) : "Settings";
  const fullPage = inPane && current?.meta.key === "appearance" && ui.subPage === "themes";

  return (
    <div className={s.mWin} data-settings-window="" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className={s.mHead}>
        <button type="button" className={s.mBack} aria-label="Back" onClick={back}>
          <Icon name="go-previous-symbolic" size={24} color="var(--th-settings-back-icon)" />
        </button>
        <span className={s.mTitle}>{title}</span>
      </div>
      <div ref={contentRef} className={s.mBody} data-pane-id={inPane ? current?.meta.key : searching ? "search" : "list"} onFocusCapture={keepFieldVisible}>
        {inPane && Pane ? (
          fullPage ? (
            <div className={s.fullPage}>
              <Pane key={current.meta.key} />
            </div>
          ) : (
            <ScrollArea className={s.scroll} contentClassName={cx(s.scrollInner, s.mScrollInner)}>
              <div className={cx(s.column, s.mColumn)}>
                {/* phones: the status question sits on the Settings list and in Privacy (where the answer lives), not
                    on top of every pane (~100 pt each; iPhone/iPad sweep L1, 2026-10-25) */}
                {current.meta.key === "privacy" && <StatusAskBanner />}
                {current.meta.description && <p className={s.mPaneDesc}>{current.meta.phoneDescription ?? current.meta.description}</p>}
                <Pane key={current.meta.key} />
              </div>
            </ScrollArea>
          )
        ) : (
          <>
            <div className={s.mSearchBar}>
              <SearchBox phone />
            </div>
            {searching ? (
              <Results hits={hits} sel={-1} setSel={() => undefined} onOpen={(h) => jumpToSetting(h.entry.id, h.entry.pane as PaneId)} phone />
            ) : (
              <ScrollArea className={s.scroll} contentClassName={cx(s.scrollInner, s.mScrollInner)}>
                <div className={cx(s.column, s.mColumn)} role="list">
                  <StatusAskBanner />
                  {groups.map((g) => (
                    <section key={g.id} className={s.mGroup}>
                      <div className={s.mGroupLabel}>{g.label}</div>
                      <div className={s.mCard}>
                        {g.panes.map((p) => (
                          <button
                            key={p.meta.key}
                            type="button"
                            role="listitem"
                            data-pane={p.meta.key}
                            className={s.mItem}
                            onClick={() => useSettingsUi.setState({ pane: p.meta.key, mobilePane: true, subPage: null })}
                          >
                            <Icon name={p.meta.icon} size={22} color="var(--th-settings-list-item-fg)" staticOnly />
                            <span className={s.mItemText}>
                              <span className={s.mItemLabel}>{p.meta.label}</span>
                              {p.meta.description && <span className={s.mItemDesc}>{p.meta.phoneDescription ?? p.meta.description}</span>}
                            </span>
                            <Icon name="go-next-symbolic" size={16} color="var(--th-settings-list-chevron-icon)" staticOnly />
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </ScrollArea>
            )}
          </>
        )}
        <StatusStrip />
      </div>
    </div>
  );
}
