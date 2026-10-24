// ButtonRow.tsx — a row of action buttons (ACTIONS.md §9; desktop ButtonRow.qml): a layout row value (the layout's
// opts.<island>.rows.<row>, or the preset's default row) resolved against the live snapshot (evalRow) and drawn with
// ActionButton. Hidden items are left out (edit mode draws them faint); `sepBefore` draws a divider. Clicking runs the
// item through runAction (the same path as the palette and keys): its stored target, the row's context, the button
// as the anchor for menus and popovers.
//
//   <ButtonRow row="buttons.main" value={opts.rows?.main} />                       // your own button island
//   <ButtonRow row="composer.end" value={…} context={{ room: roomId }} />          // a row that supplies a context
import { useMemo, type CSSProperties } from "react";
import type { JObj, Json } from "../../layout/json";
import { cx } from "@/ui";
import { evalRow, type ItemOut } from "../evaluate";
import { useActionsSnapshot } from "../snapshot";
import { runAction, type RunSource } from "../run";
import { ActionButton } from "./ActionButton";
import s from "./ButtonRow.module.css";

export interface ButtonRowProps {
  /** the row kind ("buttons.main", "header.main", …) */
  row: string;
  /** the stored row value (any JSON; the engine normalizes it) */
  value: Json | undefined;
  /** the subjects the host supplies (a composer's room, the call's room) */
  context?: JObj;
  /** edit mode: every item is drawn (hidden ones faint) and nothing runs */
  editing?: boolean;
  /** lay the buttons out top to bottom (a vertical button island) */
  vertical?: boolean;
  /** wrap onto more lines when the island is narrow (your own button islands) */
  wrap?: boolean;
  className?: string;
  style?: CSSProperties;
  /** run an item yourself (tests, a host with its own path); default runAction */
  onRun?: (item: ItemOut, anchor: HTMLElement) => void;
  source?: RunSource;
  /** evaluate against this snapshot instead of the live one (previews, tests) */
  snapshot?: JObj;
}

export function ButtonRow({ row, value, context, editing, vertical, wrap, className, style, onRun, source = "button", snapshot }: ButtonRowProps) {
  const live = useActionsSnapshot();
  const snap = snapshot ?? live;
  const out = useMemo(() => evalRow("web", snap, row, value ?? null, context), [snap, row, value, context]);
  const toggleLook = row === "buttons.main" ? "checked" : "pose";
  const items = out.items.map((item, i) => ({ item, i })).filter(({ item }) => editing || item.state !== "hidden");
  if (items.length === 0) return null;
  const run = (item: ItemOut, anchor: HTMLElement) => {
    if (onRun) return onRun(item, anchor);
    void runAction(item.a, { source, target: item.target, context: context ?? null, anchor });
  };
  return (
    <div
      className={cx(s.row, vertical && s.vertical, wrap && s.wrap, className)}
      style={style}
      role="toolbar"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-row={row}
      data-look={out.look}
      data-scale={out.scale}
    >
      {items.map(({ item, i }) => (
        <span key={i} className={s.cell}>
          {item.sepBefore && <span className={cx(s.sep, vertical && s.sepH)} aria-hidden="true" />}
          <ActionButton
            item={item}
            rowStyle={out.style}
            scale={out.scale}
            toggleLook={toggleLook}
            editing={editing}
            onRun={(el) => run(item, el)}
            onHold={(el, down) => void runAction(item.a, { source, target: item.target, context: context ?? null, anchor: el, hold: down ? "down" : "up" })}
          />
        </span>
      ))}
    </div>
  );
}
