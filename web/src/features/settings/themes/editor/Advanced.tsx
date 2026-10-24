// Advanced.tsx — THEMES-UI.md §13.8: every palette slot, role and element colour, grouped (the palette, the role groups,
// every token area under its section — labels.ts / editor-labels.json), searchable, a Changed filter, the Pick tool's
// "Picked" group first. A virtualized list of fixed-height items (section 28, group 32, row 40).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { advancedGroups, roleLabel, searchGroups, tokenLabel, type EditorGroup, type EditorRow } from "@/theme/labels";
import { ROLE_IDS } from "@/theme/engine";
import type { PickKind } from "@/theme/probe";
import { BasicToolButton, Icon, SearchField, cx } from "@/ui";
import { shownIssues, useEditor } from "./editorStore";
import { ColourPopover } from "./ColourPopover";
import { cssOf } from "./colour";
import { issueLine } from "./issues";
import { loadTokenInfo, tokenDescription, useTokenInfo } from "./tokenInfo";
import { hasPalette, isChanged, resolvedValue, type ColourTarget } from "./targets";
import s from "./editor.module.css";

const ROLES = new Set(ROLE_IDS);
const H = { section: 28, group: 32, row: 40 } as const;
const BADGE: Record<PickKind, string> = { text: "Text", fill: "Fill", border: "Border", icon: "Icon", shadow: "Shadow", other: "Other" };

type Item =
  | { t: "section"; key: string; label: string; top: number }
  | { t: "group"; key: string; g: EditorGroup; open: boolean; changed: number; top: number }
  | { t: "row"; key: string; row: EditorRow; badge?: string; top: number };

const targetOf = (r: EditorRow): ColourTarget => ({ kind: r.kind, id: r.id }) as ColourTarget;

export function AdvancedMode() {
  const session = useEditor((st) => st.session);
  const resolved = useEditor((st) => st.resolved);
  const query = useEditor((st) => st.query);
  const changedOnly = useEditor((st) => st.changedOnly);
  const openGroups = useEditor((st) => st.openGroups);
  const picked = useEditor((st) => st.picked);
  const st = useEditor();
  const info = useTokenInfo();
  const [pop, setPop] = useState<{ row: EditorRow; anchor: HTMLElement } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => void loadTokenInfo(), []);

  const doc = session?.doc;
  const base = session?.base;
  const palette = doc ? hasPalette(doc) : false;
  const groups = useMemo(() => advancedGroups(palette, info ? [...info.values()] : []), [palette, info]);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const warned = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of shownIssues(st)) if (!m.has(i.fg)) m.set(i.fg, issueLine(i));
    return m;
  }, [st]);

  const items = useMemo(() => {
    if (!doc || !base) return { list: [] as Item[], height: 0 };
    let shown = searchGroups(groups, query, tokenDescription);
    if (changedOnly) shown = shown.map((g) => ({ ...g, rows: g.rows.filter((r) => isChanged(doc, base, targetOf(r))) })).filter((g) => g.rows.length > 0);
    const all: { g: EditorGroup; badges?: Map<string, string> }[] = [];
    if (picked && picked.length) {
      const rows: EditorRow[] = picked.map((h) => ({ kind: ROLES.has(h.id) ? "role" : "token", id: h.id, label: ROLES.has(h.id) ? roleLabel(h.id) : tokenLabel(h.id) }));
      all.push({ g: { id: "picked", section: "Picked", label: "Picked", rows }, badges: new Map(picked.map((h) => [h.id, BADGE[h.kind]])) });
    }
    for (const g of shown) all.push({ g });
    const forceOpen = query.trim().length > 0 || changedOnly;
    const list: Item[] = [];
    let top = 0;
    let section = "";
    for (const { g, badges } of all) {
      if (g.section !== section) {
        section = g.section;
        list.push({ t: "section", key: `s:${section}`, label: section, top });
        top += H.section;
      }
      const open = forceOpen || g.id === "picked" || !!openGroups[g.id];
      const changed = g.rows.filter((r) => isChanged(doc, base, targetOf(r))).length;
      // the Pick tool's group is always open: its section heading is its header
      if (g.id !== "picked") {
        list.push({ t: "group", key: `g:${g.id}`, g, open, changed, top });
        top += H.group;
      }
      if (!open) continue;
      for (const r of g.rows) {
        list.push({ t: "row", key: `r:${g.id}:${r.kind}:${r.id}`, row: r, badge: badges?.get(r.id), top });
        top += H.row;
      }
    }
    return { list, height: top };
  }, [doc, base, groups, query, changedOnly, openGroups, picked]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const upd = () => setView({ top: el.scrollTop, height: el.clientHeight });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // a new pick: back to the top, where "Picked" is
  useEffect(() => {
    if (picked && listRef.current) listRef.current.scrollTop = 0;
  }, [picked]);

  if (!doc || !base || !resolved) return null;
  const lo = view.top - view.height;
  const hi = view.top + 2 * view.height;
  const visible = items.list.filter((it) => {
    const h = it.t === "section" ? H.section : it.t === "group" ? H.group : H.row;
    return it.top + h >= lo && it.top <= hi;
  });
  const toggle = (id: string, open: boolean) => useEditor.setState({ openGroups: { ...openGroups, [id]: !open } });
  return (
    <>
      <div className={s.advTop}>
        <SearchField
          value={query}
          onValueChange={(v) => useEditor.setState({ query: v })}
          placeholder={`Search ${total.toLocaleString("en-US")} colours`}
          aria-label="Search colours"
        />
        <BasicToolButton display="textOnly" text="Changed" checked={changedOnly} tip="Only the colours you changed" onClick={() => useEditor.setState({ changedOnly: !changedOnly })} />
      </div>
      <div ref={listRef} className={s.list} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} role="tree" aria-label="Colours">
        <div style={{ height: items.height, position: "relative" }}>
          {visible.map((it) => {
            if (it.t === "section")
              return (
                <div key={it.key} className={cx(s.item, s.sectionHead)} style={{ top: it.top }}>
                  {it.label}
                </div>
              );
            if (it.t === "group")
              return (
                <button
                  key={it.key}
                  type="button"
                  className={cx(s.item, s.groupHead)}
                  style={{ top: it.top }}
                  aria-expanded={it.open}
                  onClick={() => toggle(it.g.id, it.open)}
                >
                  <Icon name={it.open ? "arrow-down" : "arrow-right"} size={16} color="var(--th-settings-theme-editor-group-fg)" />
                  <span>{it.g.label}</span>
                  <span className={s.groupCount}> · {it.g.rows.length}</span>
                  {it.changed > 0 && <span className={s.groupChanged}>{it.changed} changed</span>}
                </button>
              );
            const t = targetOf(it.row);
            const colour = resolvedValue(resolved, doc, t);
            const warn = warned.get(it.row.id);
            const sel = pop?.row.id === it.row.id && pop.row.kind === it.row.kind;
            return (
              <button
                key={it.key}
                type="button"
                className={cx(s.item, s.colourRow)}
                style={{ top: it.top }}
                data-selected={sel || it.badge ? "" : undefined}
                title={it.row.kind === "token" ? tokenDescription(it.row.id) || undefined : undefined}
                onClick={(e) => setPop({ row: it.row, anchor: e.currentTarget })}
              >
                <span className={cx(s.swatch, s.rowSwatch)} style={{ ["--sw" as string]: cssOf(colour) }} />
                <span className={s.rowText}>
                  <span className={s.rowName}>{it.row.label}</span>
                  <span className={s.rowId}>{it.row.id}</span>
                </span>
                {it.badge && <span className={s.badge}>{it.badge}</span>}
                {warn && (
                  <span title={warn}>
                    <Icon name="dialog-warning" size={16} color="var(--th-settings-theme-editor-warn-icon)" />
                  </span>
                )}
                {isChanged(doc, base, t) && <span className={s.dot} aria-label="Changed" />}
              </button>
            );
          })}
        </div>
        {items.list.length === 0 && <div className={s.empty}>{query.trim() ? `No colours match “${query.trim()}”.` : changedOnly ? "Nothing changed yet." : "Loading the colours…"}</div>}
      </div>
      {pop && <ColourPopover open anchor={pop.anchor} target={targetOf(pop.row)} onClose={() => setPop(null)} />}
    </>
  );
}
