// RowEditor.tsx — edit one button row (11.0 buttons; DESIGN.md "Buttons": hide / reorder / add today's buttons, your
// own button islands, per-row look, per-button "hide instead of dimming"; the desktop's RowEditor.qml draws the same).
// A simple per-row editor until edit mode (step 4) hosts it: a live preview of the row as it will look, its look
// (icons / icons and labels / labels) and size (small / medium), the buttons in order (up / down / remove, "Hide when it
// doesn't apply"), and the drawer of every action that may go into this row (ACTIONS.md §9.6) — an action that needs a
// target asks for it (a room, a sound, a status …, the palette's choices, §10.6) or can pick it each time. Nothing is
// saved until Done; Reset to default puts the preset's row back. Always mounted (RowEditorHost), opened through
// editorStore.
import { useMemo, useState } from "react";
import type { JObj, Json } from "../../layout/json";
import { clone, get, isArr, isObj, isStr, obj } from "../../layout/json";
import { Button, Dialog, HintLabel, Icon, RadioButton, CheckBox, SearchField, SectionLabel, ToolButton, cx, useIsMobile } from "@/ui";
import { TABLE, reg, type Look, type RowKind, type Scale } from "../table";
import { drawer, evalRow, type ItemOut } from "../evaluate";
import { choiceEntries, fold } from "../palette";
import { defaultRowValue, rowKindOf } from "../rows";
import { useActionsSnapshot } from "../snapshot";
import { setRow, storedRow, useForm } from "../layoutStore";
import { closeRowEditor, useRowEditor, type RowEditorReq } from "./editorStore";
import { ButtonRow } from "./ButtonRow";
import s from "./RowEditor.module.css";

type Item = JObj; // {a, target?, hideWhenOff?, sepBefore?}
interface Work {
  look: Look;
  scale: Scale;
  items: Item[];
}

const LOOK_LABEL: Record<Look, string> = { icon: "Icons", iconLabel: "Icons and labels", label: "Labels" };
const SCALE_LABEL: Record<Scale, string> = { S: "Small", M: "Medium" };

/** A row value → the editor's working copy (the row kind's defaults filled in). */
function workOf(v: Json | null, rk: RowKind): Work {
  const o = isObj(v) ? v : obj();
  const look = get(o, "look");
  const scale = get(o, "scale");
  const items = isArr(get(o, "items")) ? (get(o, "items") as Json[]).filter(isObj).map((x) => clone(x) as Item) : [];
  return {
    look: look === "icon" || look === "iconLabel" || look === "label" ? look : rk.look,
    scale: scale === "S" || scale === "M" ? scale : rk.scale,
    items,
  };
}
/** The working copy → a row value (look / scale only when they differ from the row kind's). */
function valueOf(w: Work, rk: RowKind): JObj {
  const v = obj();
  if (w.look !== rk.look) v["look"] = w.look;
  if (w.scale !== rk.scale) v["scale"] = w.scale;
  v["items"] = w.items.map((x) => clone(x) as Item);
  return v;
}
const same = (a: Json | null | undefined, b: Json | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function RowEditorHost() {
  const { req, n } = useRowEditor();
  if (!req) return null;
  return <RowEditor key={n} req={req} />;
}

function RowEditor({ req }: { req: RowEditorReq }) {
  const mobile = useIsMobile();
  const snap = useActionsSnapshot();
  const form = useForm(req.form);
  const kind = rowKindOf(req.island, req.row);
  const rk = reg(TABLE.rows, kind) as RowKind;
  const stored = storedRow(form, req.island, req.row);
  const def = defaultRowValue(req.island, req.row, req.form);
  const [work, setWork] = useState<Work>(() => workOf(stored !== undefined ? stored : def, rk));
  const [picking, setPicking] = useState<{ a: string; label: string } | null>(null);
  const [query, setQuery] = useState("");
  const value = useMemo(() => valueOf(work, rk), [work, rk]);
  // every item's face now (labels / icons / targets), hidden ones included
  const faces = useMemo(() => evalRow("web", snap, kind, value, undefined).items, [snap, kind, value]);
  const groups = useMemo(() => drawer("web", snap, kind, fold), [snap, kind]);
  const q = fold(query);
  const full = work.items.length >= (TABLE.limits.rowItems ?? 24);

  const edit = (fn: (items: Item[]) => Item[]) => setWork((w) => ({ ...w, items: fn(w.items.slice()) }));
  const move = (i: number, d: number) =>
    edit((it) => {
      const j = i + d;
      if (j < 0 || j >= it.length) return it;
      [it[i], it[j]] = [it[j], it[i]];
      return it;
    });
  const remove = (i: number) => edit((it) => (it.splice(i, 1), it));
  const setFlag = (i: number, k: "hideWhenOff" | "sepBefore", on: boolean) =>
    edit((it) => {
      const x = clone(it[i]) as Item;
      if (on) x[k] = true;
      else delete x[k];
      it[i] = x;
      return it;
    });
  const add = (a: string, target?: JObj) =>
    edit((it) => {
      const x = obj();
      x["a"] = a;
      if (target && Object.keys(target).length > 0) x["target"] = clone(target) as JObj;
      it.push(x);
      return it;
    });
  const done = () => {
    // the default row itself is not stored (the preset keeps it, and a later default change reaches it)
    setRow(req.form, req.island, req.row, def !== null && same(value, valueOf(workOf(def, rk), rk)) ? null : value);
    closeRowEditor();
  };
  const choices = picking ? (choiceEntries("web", snap, picking.a) ?? []) : [];
  const shownChoices = q ? choices.filter((c) => c.names.some((n) => n.includes(q))) : choices;

  return (
    <Dialog
      open
      onClose={closeRowEditor}
      title={`Edit buttons — ${req.title}`}
      width={mobile ? undefined : 720}
      bodyClassName={s.body}
      closeOnOutside={false}
      buttons={[
        { text: "Reset to default", role: "action", disabled: def === null ? work.items.length === 0 : same(value, valueOf(workOf(def, rk), rk)), onClick: () => setWork(workOf(def, rk)) },
        { text: "Cancel", role: "reject", onClick: closeRowEditor },
        { text: "Done", role: "accept", onClick: done },
      ]}
    >
      <div className={s.preview} data-row-preview={kind}>
        {work.items.length > 0 ? <ButtonRow row={kind} value={value} wrap snapshot={snap} onRun={() => undefined} /> : <span className={s.previewEmpty}>No buttons in this row</span>}
      </div>
      <div className={s.looks}>
        <div className={s.lookRow} role="radiogroup" aria-label="Look">
          <span className={s.lookName}>Look</span>
          {(["icon", "iconLabel", "label"] as Look[]).map((l) => (
            <RadioButton key={l} name="row-look" text={LOOK_LABEL[l]} checked={work.look === l} onToggled={(on) => on && setWork((w) => ({ ...w, look: l }))} />
          ))}
        </div>
        <div className={s.lookRow} role="radiogroup" aria-label="Size">
          <span className={s.lookName}>Size</span>
          {(["S", "M"] as Scale[]).map((z) => (
            <RadioButton key={z} name="row-size" text={SCALE_LABEL[z]} checked={work.scale === z} onToggled={(on) => on && setWork((w) => ({ ...w, scale: z }))} />
          ))}
        </div>
      </div>
      <div className={cx(s.columns, mobile && s.stacked)}>
        <section className={s.col} aria-label="In this row">
          <SectionLabel>In this row</SectionLabel>
          {work.items.length === 0 && <HintLabel>Nothing yet — add buttons from the list.</HintLabel>}
          <ol className={s.items}>
            {work.items.map((x, i) => {
              const f = faces[i];
              return (
                <li key={`${i}:${isStr(get(x, "a")) ? (get(x, "a") as string) : "?"}`} className={s.item} data-item={get(x, "a") as string}>
                  <ItemGlyph item={f} />
                  <div className={s.itemText}>
                    <span className={s.itemLabel}>{itemTitle(f)}</span>
                    {f && f.known && (
                      <CheckBox className={s.itemFlag} text="Hide when it doesn't apply" checked={get(x, "hideWhenOff") === true} onToggled={(on) => setFlag(i, "hideWhenOff", on)} />
                    )}
                    {f && !f.known && <span className={s.itemNote}>Made by a newer Tin Hat — kept as it is</span>}
                  </div>
                  <div className={s.itemTools}>
                    <ToolButton iconName="go-up-symbolic" tip="Move left / up" disabled={i === 0} onClick={() => move(i, -1)} />
                    <ToolButton iconName="go-down-symbolic" tip="Move right / down" disabled={i === work.items.length - 1} onClick={() => move(i, 1)} />
                    <ToolButton iconName="list-remove-symbolic" tip="Take it out of the row" onClick={() => remove(i)} />
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
        <section className={s.col} aria-label="Add a button">
          {picking ? (
            <>
              <div className={s.pickHead}>
                <ToolButton iconName="go-previous-symbolic" tip="Back to every action" onClick={() => (setPicking(null), setQuery(""))} />
                <SectionLabel>{picking.label} — pick one</SectionLabel>
              </div>
              <SearchField value={query} onValueChange={setQuery} placeholder="Search…" />
              <div className={s.drawer}>
                <button type="button" className={s.drawerRow} disabled={full} onClick={() => (add(picking.a), setPicking(null), setQuery(""))}>
                  <Icon name="view-more-symbolic" size={16} color="var(--th-action-palette-icon)" staticOnly />
                  <span className={s.drawerLabel}>Ask every time</span>
                </button>
                {shownChoices.map((c) => (
                  <button key={`${c.id}`} type="button" className={s.drawerRow} disabled={full || !c.enabled} onClick={() => (add(picking.a, c.target ?? undefined), setPicking(null), setQuery(""))}>
                    {c.emoji ? <span className={s.emoji}>{c.emoji}</span> : <Icon name={c.icon ?? "list-add-symbolic"} size={16} color="var(--th-action-palette-icon)" staticOnly />}
                    <span className={s.drawerLabel}>{c.label}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <SectionLabel>Add a button</SectionLabel>
              <SearchField value={query} onValueChange={setQuery} placeholder="Search actions…" />
              {full && <HintLabel>This row is full ({TABLE.limits.rowItems ?? 24} buttons).</HintLabel>}
              <div className={s.drawer}>
                {groups.map((g) => {
                  const items = q ? g.items.filter((it) => fold(it.label).includes(q)) : g.items;
                  if (items.length === 0) return null;
                  return (
                    <div key={g.group} className={s.group}>
                      <div className={s.groupName}>{g.label}</div>
                      {items.map((it) => (
                        <button
                          key={it.a}
                          type="button"
                          className={s.drawerRow}
                          disabled={full}
                          onClick={() => (it.pick && choiceEntries("web", snap, it.a) !== null ? (setPicking({ a: it.a, label: it.label }), setQuery("")) : add(it.a))}
                        >
                          <Icon name={it.icon ?? "list-add-symbolic"} size={16} color="var(--th-action-palette-icon)" staticOnly />
                          <span className={s.drawerLabel}>{it.label}</span>
                          {it.pick && <span className={s.drawerMore}>…</span>}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}

function itemTitle(f: ItemOut | undefined): string {
  if (!f) return "";
  if (!f.known) return f.label || "Needs a newer Tin Hat";
  return f.label;
}

function ItemGlyph({ item }: { item: ItemOut | undefined }) {
  if (!item) return <span className={s.glyph} />;
  if (item.emoji)
    return (
      <span className={s.glyph} aria-hidden="true">
        <span className={s.emoji}>{item.emoji}</span>
      </span>
    );
  const g = item.icon ?? item.targetIcon;
  return <span className={s.glyph}>{g ? <Icon name={g} size={20} color={item.known ? "var(--th-button-tool-fg)" : "var(--th-action-placeholder-fg)"} staticOnly /> : null}</span>;
}

/** The rows the settings list offers, in this order (the editable rows of today's surfaces). */
export const EDITABLE_ROWS: readonly { island: string; row: string; title: string; hint: string }[] = [
  { island: "header", row: "main", title: "Room header", hint: "Game reel, calendar, Memories, the call, call settings, room info" },
  { island: "composer", row: "start", title: "Message box — left", hint: "Attach" },
  { island: "composer", row: "end", title: "Message box — right", hint: "Emoji, GIF, soundboard, pinned messages, Send" },
  { island: "account", row: "main", title: "Your account card", hint: "Report a problem, tuck the nav away, the menu" },
  { island: "call", row: "bar", title: "Call controls", hint: "Mute, deafen, camera, share, soundboard … Leave" },
];
