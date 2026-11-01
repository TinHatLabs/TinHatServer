// ColourPopover.tsx — THEMES-UI.md §13.9: the colour field (saturation × value at a hue), the hue and alpha bars, the
// hex / alpha fields, the theme-colour chips (a role REFERENCE), the expression line, the readability line + Fix, and
// Reset / Use default. A drag is one gesture (one undo step). Everything goes through the editor store's edit().
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { fixContrast } from "@/theme/editor";
import { BasicRadioButton, Button, Icon, Popover, TextField } from "@/ui";
import { roleLabel } from "@/theme/labels";
import { PALETTE_GROUPS, paletteView, swatchInfo } from "@/theme/palette";
import { APP_SPEC, edit, newGesture, shownIssues, useEditor } from "./editorStore";
import { colourText, cssOf, hsvToRgb, literalOf, rgbToHsv, type Hsv } from "./colour";
import { alphaAllowed, canUseDefault, isChanged, opFor, resetOp, resolvedValue, storedValue, targetId, targetLabel, type ColourTarget } from "./targets";
import { issueLine } from "./issues";
import { BLACK, formatColour } from "@/theme/literal";

const BLACK_TEXT = formatColour(BLACK);
import s from "./editor.module.css";

/** The theme colours offered as references (§13.9). */
export const THEME_CHIPS = [
  "accent.base", "accent.bright", "text.primary", "text.secondary", "surface.window", "surface.island", "surface.raised",
  "state.danger", "state.warning", "state.success",
];

/** Simple swatches: is it its group's lead, how many swatches the group has, what it reaches. */
export type SwatchInfo = { lead: boolean; members: number; usedBy: number; alsoIn: string[]; colour: string };

export function ColourPopover({ open, anchor, target: target0, onClose }: { open: boolean; anchor: HTMLElement | null; target: ColourTarget; onClose: () => void }) {
  // a lead swatch moves its whole group unless "Just this colour" is picked (THEME-SIMPLE §7; kept for the session)
  const whole = useEditor((st) => st.swatchWhole);
  const setWhole = (v: boolean) => useEditor.setState({ swatchWhole: v });
  const docNow = useEditor((st) => st.session?.doc);
  const view = useMemo(() => (docNow && target0.kind === "swatch" ? paletteView(docNow, APP_SPEC) : null), [docNow, target0.kind]);
  // live: membership, counts and the groups it reaches follow every edit
  const swatch: SwatchInfo | null = view && target0.kind === "swatch" ? (() => {
    const i = swatchInfo(view, target0.group, target0.id, whole);
    return i ? { ...i, alsoIn: i.alsoIn.map((g) => PALETTE_GROUPS.find((x) => x.id === g)?.label ?? g) } : null;
  })() : null;
  const target: ColourTarget = target0.kind === "swatch" ? { ...target0, whole: !!swatch?.lead && whole } : target0;
  const session = useEditor((st) => st.session);
  const resolved = useEditor((st) => st.resolved);
  const st = useEditor();
  const doc = session?.doc;
  const base = session?.base;
  const current = doc && resolved ? resolvedValue(resolved, doc, target) : BLACK_TEXT;
  const stored = doc ? storedValue(doc, target) : null;
  const withAlpha = alphaAllowed(target);
  const [hsv, setHsv] = useState<Hsv>({ h: 0, s: 0, v: 0 });
  const [alpha, setAlpha] = useState(1);
  const [hexText, setHexText] = useState("");
  const [alphaText, setAlphaText] = useState("100");
  const [hexBad, setHexBad] = useState(false);
  const [exprOpen, setExprOpen] = useState(false);
  const [exprText, setExprText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dragging = useRef<number | null>(null);
  const lastSet = useRef<string | null>(null);

  // follow the working document (open, undo / redo, a chip) — never while a drag is setting it
  useEffect(() => {
    if (!open || dragging.current !== null || current === lastSet.current) return;
    const c = literalOf(current);
    if (!c) return;
    setHsv((prev) => {
      const n = rgbToHsv(c.r, c.g, c.b);
      // keep the hue (and saturation) through greys and black, where HSV forgets them
      return { h: n.s === 0 || n.v === 0 ? prev.h : n.h, s: n.v === 0 ? prev.s : n.s, v: n.v };
    });
    setAlpha(c.a);
    setHexText(current.slice(0, 7));
    setAlphaText(String(Math.round(c.a * 100)));
    setHexBad(false);
    lastSet.current = current;
  }, [open, current]);
  useEffect(() => {
    if (!open) {
      setExprOpen(false);
      setError(null);
    }
  }, [open]);

  const apply = (next: Hsv, a: number, gesture: number | null) => {
    const text = colourText(hsvToRgb(next.h, next.s, next.v), withAlpha ? a : 1);
    lastSet.current = text;
    setHexText(text.slice(0, 7));
    const err = edit(opFor(target, text), gesture);
    setError(err ? err : null);
  };

  const pending = useRef<{ hsv: Hsv; a: number } | null>(null);
  const raf = useRef(0);
  const schedule = (next: Hsv, a: number) => {
    pending.current = { hsv: next, a };
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p) apply(p.hsv, p.a, dragging.current);
    });
  };
  const drag = (el: HTMLElement, e: RPointerEvent, pick: (x: number, y: number) => void) => {
    const r = el.getBoundingClientRect();
    pick(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  const handlers = (pick: (x: number, y: number) => void) => ({
    onPointerDown: (e: RPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = newGesture();
      drag(e.currentTarget, e, pick);
    },
    onPointerMove: (e: RPointerEvent<HTMLDivElement>) => {
      if (dragging.current !== null && e.currentTarget.hasPointerCapture(e.pointerId)) drag(e.currentTarget, e, pick);
    },
    onPointerUp: (e: RPointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      const p = pending.current;
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      pending.current = null;
      if (p) apply(p.hsv, p.a, dragging.current);
      dragging.current = null;
    },
  });
  const field = handlers((x, y) => {
    const next = { h: hsv.h, s: x, v: 1 - y };
    setHsv(next);
    schedule(next, alpha);
  });
  const hueBar = handlers((x) => {
    const next = { ...hsv, h: Math.min(359.999, x * 360) };
    setHsv(next);
    schedule(next, alpha);
  });
  const alphaBar = handlers((x) => {
    const a = Math.round(x * 100) / 100;
    setAlpha(a);
    setAlphaText(String(Math.round(a * 100)));
    schedule(hsv, a);
  });

  const hueCss = cssOf(colourText(hsvToRgb(hsv.h, 1, 1)));
  const solidCss = cssOf(colourText(hsvToRgb(hsv.h, hsv.s, hsv.v)));
  const commitHex = () => {
    const t = hexText.trim();
    const c = literalOf(t.startsWith("#") ? t : `#${t}`);
    if (!c) {
      setHexBad(true);
      return;
    }
    setHexBad(false);
    const n = rgbToHsv(c.r, c.g, c.b);
    const next = { h: n.s === 0 ? hsv.h : n.h, s: n.s, v: n.v };
    setHsv(next);
    const a = withAlpha ? (c.a < 1 ? c.a : alpha) : 1;
    setAlpha(a);
    apply(next, a, null);
  };
  const commitAlpha = () => {
    const n = Number(alphaText);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setAlphaText(String(Math.round(alpha * 100)));
      return;
    }
    const a = Math.round(n) / 100;
    setAlpha(a);
    apply(hsv, a, null);
  };

  const issues = useMemo(() => shownIssues(st).filter((i) => (target.kind === "role" || target.kind === "token") && i.fg === target.id), [st, target]);
  if (!doc || !base || !resolved) return null;
  const changed = isChanged(doc, base, target);
  const isExpr = stored !== null && literalOf(stored) === null;
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="left" align="start" gap={8} title={targetLabel(target)} aria-label={`${targetLabel(target)} colour`}>
      <div className={s.pop}>
        <div className={s.popTitle}>{targetLabel(target)}</div>
        <div className={s.popId}>{targetId(target)}</div>
        {swatch?.lead && (
          <div className={s.popChoice} role="radiogroup" aria-label="What to change">
            <BasicRadioButton name="swatch-scope" text={`Whole group (moves ${swatch.members} colours)`} checked={whole} onToggled={(on) => on && setWhole(true)} />
            <BasicRadioButton name="swatch-scope" text="Just this colour" checked={!whole} onToggled={(on) => on && setWhole(false)} />
          </div>
        )}
        {swatch && (
          <div className={s.popHint}>
            {swatch.usedBy === 1 ? "Used by 1 colour" : `Used by ${swatch.usedBy} colours`}
            {swatch.alsoIn.length > 0 && ` · also changes ${swatch.alsoIn.join(", ")}`}
          </div>
        )}
        <div
          className={s.svField}
          style={{
            // the colour field: content colours (what you pick), not theme tokens
            backgroundImage: `linear-gradient(to top, #000000, transparent), linear-gradient(to right, #ffffff, ${hueCss})`,
          }}
          role="slider"
          aria-label="Saturation and brightness"
          aria-valuetext={`${Math.round(hsv.s * 100)} % saturation, ${Math.round(hsv.v * 100)} % brightness`}
          {...field}
        >
          <span className={s.handle} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solidCss }} />
        </div>
        <div
          className={s.bar}
          style={{ backgroundImage: "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)" }}
          role="slider"
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          {...hueBar}
        >
          <span className={`${s.handle} ${s.barHandle}`} style={{ left: `${(hsv.h / 360) * 100}%`, background: hueCss }} />
        </div>
        {withAlpha && (
          <div className={`${s.bar} ${s.barChecker}`} role="slider" aria-label="Opacity" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(alpha * 100)} {...alphaBar}>
            <span className={s.barFill} style={{ backgroundImage: `linear-gradient(to right, transparent, ${solidCss})` }} />
            <span className={`${s.handle} ${s.barHandle}`} style={{ left: `${alpha * 100}%` }} />
          </div>
        )}
        <div className={s.popRow}>
          <span className={s.popLabel}>Hex</span>
          <TextField
            className={s.hexField}
            value={hexText}
            maxLength={9}
            aria-label="Hex colour"
            aria-invalid={hexBad || undefined}
            onChange={(e) => setHexText(e.target.value)}
            onAccepted={commitHex}
            onBlur={commitHex}
          />
          {withAlpha && (
            <>
              <span className={s.popLabel}>Alpha</span>
              <TextField className={s.alphaField} value={alphaText} maxLength={3} aria-label="Alpha in per cent" onChange={(e) => setAlphaText(e.target.value)} onAccepted={commitAlpha} onBlur={commitAlpha} />
            </>
          )}
        </div>
        {withAlpha && (
          <>
            <div className={s.popLabel}>Theme colours</div>
            <div className={s.chips}>
              {THEME_CHIPS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`${s.swatch} ${s.chip}`}
                  style={{ ["--sw" as string]: cssOf(resolved.roles[id]), width: 20, height: 20 }}
                  title={roleLabel(id)}
                  aria-label={roleLabel(id)}
                  aria-checked={stored === id}
                  role="radio"
                  onClick={() => setError(edit(opFor(target, id)))}
                />
              ))}
            </div>
            <div className={s.expr}>{stored ?? (target.kind === "token" ? `default: ${tokenDefault(target.id)}` : "made from the palette")}</div>
            {!exprOpen ? (
              <div>
                <Button
                  flat
                  text="Edit expression…"
                  onClick={() => {
                    setExprText(stored ?? "");
                    setExprOpen(true);
                  }}
                />
              </div>
            ) : (
              <TextField
                value={exprText}
                autoFocus
                aria-label="Expression"
                placeholder="mixok(surface.island, text.primary, 0.1)"
                onChange={(e) => setExprText(e.target.value)}
                onAccepted={() => {
                  const err = edit(opFor(target, exprText));
                  setError(err);
                  if (!err) setExprOpen(false);
                }}
              />
            )}
          </>
        )}
        {error && <div className={s.error}>{errorText(error)}</div>}
        {isExpr && !exprOpen && <div className={s.expr}>This colour follows an expression; picking a colour replaces it.</div>}
        {issues.map((i) => (
          <div key={i.bg} className={s.issue}>
            <Icon name="dialog-warning" size={16} color="var(--th-settings-theme-editor-warn-icon)" />
            <span>{issueLine(i)}</span>
            <Button flat text="Fix" onClick={() => setError(edit(fixContrast(i, resolved)))} />
          </div>
        ))}
        <div className={s.popFooter}>
          {canUseDefault(doc, target) && <Button flat text="Use default" onClick={() => setError(edit(opFor(target, null)))} />}
          <Button flat text="Reset" disabled={!changed} onClick={() => setError(edit(resetOp(base, target)))} />
        </div>
      </div>
    </Popover>
  );
}

const tokenDefault = (id: string): string => APP_SPEC.tokens.find((t) => t.id === id)?.default ?? "";

/** Refusals of the editor's ops in plain words (§13.2). */
export function errorText(code: string): string {
  const i = code.indexOf(":");
  const head = i < 0 ? code : code.slice(0, i);
  switch (head) {
    case "bad-colour":
      return "That isn't a colour Tin Hat can use here.";
    case "bad-expr":
      return `That expression doesn't read: ${code.slice(i + 1).trim()}.`;
    case "refused": {
      const rest = code.slice(i + 1).trim();
      if (rest.startsWith("cycle")) return "That would make the colour depend on itself.";
      if (rest.startsWith("undefined-ref")) return "That expression names a colour this theme doesn't have.";
      if (rest.startsWith("too-large")) return "The theme would be larger than 8 KB.";
      if (rest.startsWith("too-many-overrides")) return "The theme would change more than 400 colours.";
      if (rest.startsWith("url")) return "Themes can't contain web links.";
      return `Tin Hat can't use that (${rest}).`;
    }
    case "no-palette":
      return "This theme has no terminal palette.";
    default:
      return `Tin Hat can't use that (${code}).`;
  }
}
