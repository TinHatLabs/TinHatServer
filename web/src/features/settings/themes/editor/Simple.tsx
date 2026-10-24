// Simple.tsx — THEMES-UI.md §13.7: Name + Author, Colours (background, accent chips, the adjusted note, readability),
// Text (three fonts, the size), Density, Islands (radius, gap, margin, border, shadow, transparency).
import { useRef, useState } from "react";
import { ACCENT_PRESETS, fixesFor, islandOpacity } from "@/theme/editor";
import { FONTS_MONO, FONTS_SANS, FONTS_SERIF, readLook, type Density } from "@/theme/look";
import { paletteLabel } from "@/theme/labels";
import { readShape } from "@/theme/shape";
import type { JObj } from "@/theme/sync";
import { BasicRadioButton, Button, ComboBox, HintLabel, Icon, InlineMessage, SectionLabel, Slider, TextField } from "@/ui";
import { adjustedText } from "../text";
import { APP_SPEC, edit, newGesture, shownIssues, useEditor } from "./editorStore";
import { ColourPopover } from "./ColourPopover";
import { cssOf } from "./colour";
import { issueLine } from "./issues";
import { hasPalette, storedValue, type ColourTarget } from "./targets";
import s from "./editor.module.css";

const UI_FONTS = ["Default", ...FONTS_SANS, ...FONTS_SERIF];
const CODE_FONTS = ["Default", ...FONTS_MONO];

/** The accent chips (§13.7): palette themes — cursor (when it is not the text colour), c1–c6, c9–c14, repeats left
 *  out; roles-only themes — ACCENT_PRESETS. */
export function accentChips(doc: JObj): { value: string; colour: string; label: string }[] {
  if (!hasPalette(doc)) return ACCENT_PRESETS.map((c) => ({ value: c, colour: c, label: c }));
  const p = doc.palette as JObj;
  const ansi = (p.ansi as string[]) ?? [];
  const out: { value: string; colour: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (value: string, colour: string | undefined, label: string) => {
    if (!colour || seen.has(colour.toLowerCase())) return;
    seen.add(colour.toLowerCase());
    out.push({ value, colour, label });
  };
  if (typeof p.cursor === "string" && p.cursor.toLowerCase() !== String(p.fg).toLowerCase()) add("cursor", p.cursor, "Cursor");
  for (const n of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) add(`c${n}`, ansi[n], paletteLabel(`c${n}`));
  return out;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={s.row}>
      <span className={s.rowLabel}>{label}</span>
      <div className={s.rowControl}>{children}</div>
    </div>
  );
}

function SliderRow({ label, value, from, to, step = 1, text, onMove }: { label: string; value: number; from: number; to: number; step?: number; text: string; onMove: (v: number, g: number) => void }) {
  const g = useRef<number | null>(null);
  return (
    <Row label={label}>
      <Slider
        className={s.slider}
        value={value}
        from={from}
        to={to}
        stepSize={step}
        aria-label={label}
        onMoved={(v) => {
          g.current ??= newGesture();
          onMove(Math.round(v), g.current);
        }}
        onRelease={() => {
          g.current = null;
        }}
      />
      <span className={s.value}>{text}</span>
    </Row>
  );
}

/** A text field that edits while you type (one gesture per focus): what it shows is yours until it leaves the field,
 *  an unusable value (an empty name) is simply not applied. */
function TextEditField({ value, label, placeholder, apply }: { value: string; label: string; placeholder?: string; apply: (v: string, g: number) => string | null }) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const g = useRef(0);
  const shown = focused ? text : value;
  return (
    <TextField
      className={s.field}
      value={shown}
      maxLength={80}
      placeholder={placeholder}
      aria-label={label}
      onFocus={() => {
        g.current = newGesture();
        setText(value);
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        apply(e.target.value, g.current);
      }}
    />
  );
}

export function SimpleMode() {
  const session = useEditor((st) => st.session);
  const colours = useEditor((st) => st.colours);
  const st = useEditor();
  const [pop, setPop] = useState<{ target: ColourTarget; anchor: HTMLElement } | null>(null);
  if (!session || !colours || !st.resolved) return null;
  const doc = session.doc;
  const shape = readShape(doc);
  const look = readLook(doc);
  const opacity = islandOpacity(doc, APP_SPEC);
  const issues = shownIssues(st);
  const bg = st.resolved.roles["surface.island"];
  const accentNow = hasPalette(doc) ? (typeof doc.accent === "string" ? doc.accent : null) : storedValue(doc, { kind: "role", id: "accent.base" });
  const accentColour = st.resolved.roles["accent.base"];
  const chips = accentChips(doc);
  const chipOn = (c: { value: string; colour: string }) => (accentNow !== null ? accentNow === c.value : false) || (accentNow === null && c.colour.toLowerCase() === accentColour);
  const fontIndex = (list: string[], v: string | null) => Math.max(0, v ? list.indexOf(v) : 0);
  // the roles first (a role is usually the cause: fixing Text fixes the tokens made from it), then the tokens
  const fixes = fixesFor(issues, st.resolved).sort((a, b) => Number(a.op !== "role") - Number(b.op !== "role"));
  return (
    <>
      <div className={s.section}>
        <Row label="Name">
          <TextEditField value={String(doc.name ?? "")} label="Theme name" apply={(v, g) => edit({ op: "name", value: v }, g)} />
        </Row>
        <Row label="Author">
          <TextEditField value={typeof doc.author === "string" ? doc.author : ""} label="Author" placeholder="Optional" apply={(v, g) => edit({ op: "author", value: v }, g)} />
        </Row>
      </div>

      <div className={s.section}>
        <SectionLabel>Colours</SectionLabel>
        <Row label="Background">
          <button
            type="button"
            className={`${s.swatch} ${s.swatchBtn}`}
            style={{ ["--sw" as string]: cssOf(bg) }}
            aria-label="Background colour"
            onClick={(e) => setPop({ target: { kind: "background" }, anchor: e.currentTarget })}
          />
          <span className={s.hex}>{bg}</span>
        </Row>
        <Row label="Accent">
          <div className={s.chips} role="radiogroup" aria-label="Accent">
            {chips.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={chipOn(c)}
                aria-label={c.label}
                title={c.label}
                className={`${s.swatch} ${s.chip}`}
                style={{ ["--sw" as string]: cssOf(c.colour) }}
                onClick={() => edit({ op: "accent", value: c.value })}
              >
                {chipOn(c) && (
                  <span className={s.chipCheck}>
                    <Icon name="checkmark-symbolic" size={12} color="var(--th-settings-fg)" />
                  </span>
                )}
              </button>
            ))}
            <button type="button" className={s.chipCustom} aria-label="Custom accent colour" title="Custom…" onClick={(e) => setPop({ target: { kind: "accent" }, anchor: e.currentTarget })}>
              <Icon name="color-picker" size={14} color="var(--th-settings-fg)" />
            </button>
          </div>
        </Row>
        {colours.adjusted.length > 0 && (
          <div className={s.note}>
            <Icon name="help-about-symbolic" size={16} color="var(--th-settings-theme-note-icon)" />
            <span>{adjustedText(colours.adjusted.length)}</span>
          </div>
        )}
        {fixes.length > 0 && (
          <InlineMessage
            type="warning"
            text={
              <div className={s.issues}>
                <span>{fixes.length === 1 ? "1 colour is hard to read" : `${fixes.length} colours are hard to read`}</span>
                {fixes.slice(0, 4).map((f) => {
                  const first = issues.find((i) => "id" in f && i.fg === f.id);
                  return first ? (
                    <div key={first.fg} className={s.issue}>
                      <span>{issueLine(first)}</span>
                      <Button flat text="Fix" onClick={() => edit(f)} />
                    </div>
                  ) : null;
                })}
                {fixes.length > 4 && <div className={s.issue}>and {fixes.length - 4} more — see Advanced</div>}
              </div>
            }
          />
        )}
      </div>

      <div className={s.section}>
        <SectionLabel>Text</SectionLabel>
        <Row label="Interface font">
          <ComboBox model={UI_FONTS} currentIndex={fontIndex(UI_FONTS, look.fonts.ui)} style={{ width: 220 }} aria-label="Interface font" onActivated={(i) => edit({ op: "font", slot: "ui", value: i === 0 ? null : UI_FONTS[i] })} />
        </Row>
        <Row label="Chat font">
          <ComboBox model={UI_FONTS} currentIndex={fontIndex(UI_FONTS, look.fonts.chat)} style={{ width: 220 }} aria-label="Chat font" onActivated={(i) => edit({ op: "font", slot: "chat", value: i === 0 ? null : UI_FONTS[i] })} />
        </Row>
        <Row label="Code font">
          <ComboBox model={CODE_FONTS} currentIndex={fontIndex(CODE_FONTS, look.fonts.code)} style={{ width: 220 }} aria-label="Code font" onActivated={(i) => edit({ op: "font", slot: "code", value: i === 0 ? null : CODE_FONTS[i] })} />
        </Row>
        <SliderRow label="Text size" value={look.size} from={80} to={150} step={5} text={`${look.size} %`} onMove={(v, g) => edit({ op: "size", value: v === 100 ? null : v }, g)} />
      </div>

      <div className={s.section}>
        <SectionLabel>Density</SectionLabel>
        <div className={s.radios} role="radiogroup" aria-label="Density">
          {(["compact", "normal", "touch"] as Density[]).map((d) => (
            <BasicRadioButton
              key={d}
              name="theme-density"
              text={d === "compact" ? "Compact" : d === "normal" ? "Normal" : "Touch"}
              checked={look.density === d}
              onToggled={(on) => on && edit({ op: "density", value: d === "normal" ? null : d })}
            />
          ))}
        </div>
      </div>

      <div className={s.section}>
        <SectionLabel>Islands</SectionLabel>
        <SliderRow label="Corner radius" value={shape.radius} from={0} to={24} text={`${shape.radius} px`} onMove={(v, g) => edit({ op: "shape", key: "radius", value: v }, g)} />
        <SliderRow label="Gap" value={shape.gap} from={0} to={24} text={`${shape.gap} px`} onMove={(v, g) => edit({ op: "shape", key: "gap", value: v }, g)} />
        <SliderRow label="Margin" value={shape.margin} from={0} to={24} text={`${shape.margin} px`} onMove={(v, g) => edit({ op: "shape", key: "margin", value: v }, g)} />
        <SliderRow label="Border" value={shape.border} from={0} to={2} text={`${shape.border} px`} onMove={(v, g) => edit({ op: "shape", key: "border", value: v }, g)} />
        <SliderRow label="Shadow" value={look.shadow} from={0} to={24} text={look.shadow === 0 ? "Off" : `${look.shadow} px`} onMove={(v, g) => edit({ op: "shape", key: "shadow", value: v === 0 ? null : v }, g)} />
        <SliderRow
          label="Transparency"
          value={opacity === null ? 0 : 100 - opacity}
          from={0}
          to={60}
          step={5}
          text={opacity === null ? "Mixed" : `${100 - opacity} %`}
          onMove={(v, g) => edit({ op: "opacity", value: 100 - v }, g)}
        />
        <HintLabel>Transparency lets the window background show through the islands.</HintLabel>
      </div>

      {pop && <ColourPopover open anchor={pop.anchor} target={pop.target} onClose={() => setPop(null)} />}
    </>
  );
}
