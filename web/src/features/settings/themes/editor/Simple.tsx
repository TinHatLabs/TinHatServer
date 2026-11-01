// Simple.tsx — THEMES-UI.md §13.7: Name + Author, Colours (the palette groups of palette.ts — THEME-SIMPLE design
// 2026-10-31 — the accent quick picks, "set by hand", the adjusted note, readability),
// Text (three fonts, the size), Density, Islands (radius, gap, margin, border, shadow, transparency).
import { useMemo, useRef, useState } from "react";
import { PALETTE_GROUPS, paletteView, type Swatch } from "@/theme/palette";
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

const groupLabel = (id: string): string => PALETTE_GROUPS.find((g) => g.id === id)?.label ?? id;

/** How many OTHER colours follow a swatch (its own roles left out: the same count as Advanced's "used by"). */
export const usedCount = (sw: Swatch): number => sw.usedBy.length - sw.sources.filter((x) => x.includes(".")).length;

/** A Simple swatch's tooltip: its label (+ the other sources merged into it), the colour, what it reaches. */
export function swatchTip(sw: Swatch, lead: boolean, members: number): string {
  const more = sw.sources.length > 1 ? ` +${sw.sources.length - 1} more` : "";
  const n = usedCount(sw);
  const used = n === 1 ? "used by 1 colour" : `used by ${n} colours`;
  const also = sw.alsoIn.length ? ` · also changes ${sw.alsoIn.map(groupLabel).join(", ")}` : "";
  const group = lead ? ` · moves the ${members} colours of its group` : "";
  return `${sw.label}${more} · ${sw.colour.slice(0, 7)} · ${used}${also}${group}`;
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
  const [more, setMore] = useState(false);
  const doc0 = session?.doc;
  const view = useMemo(() => (doc0 ? paletteView(doc0, APP_SPEC) : { groups: [], handSet: [] }), [doc0]);
  if (!session || !colours || !st.resolved) return null;
  const doc = session.doc;
  const shape = readShape(doc);
  const look = readLook(doc);
  const opacity = islandOpacity(doc, APP_SPEC);
  const issues = shownIssues(st);
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
        <HintLabel>Change a colour and everything made from it follows. The large swatch moves its whole group.</HintLabel>
        {view.groups.map((g) => {
          if (g.swatches.length === 0 || (g.id === "people" && !more)) return null;
          return (
            <div key={g.id} className={s.palGroup} role="group" aria-label={g.label}>
              <span className={s.rowLabel}>{g.label}</span>
              <div className={s.palSwatches}>
                {g.swatches.map((sw, i) => {
                  const lead = i === 0 && g.swatches.length > 1;
                  const tip = swatchTip(sw, lead, g.swatches.length);
                  return (
                    <button
                      key={sw.id}
                      type="button"
                      className={`${s.swatch} ${lead ? s.palLead : s.palSwatch}`}
                      style={{ ["--sw" as string]: cssOf(sw.colour) }}
                      title={tip}
                      aria-label={tip}
                      data-selected={pop?.target.kind === "swatch" && pop.target.id === sw.id ? "" : undefined}
                      onClick={(e) => setPop({ target: { kind: "swatch", id: sw.id, group: g.id, whole: lead, label: sw.label }, anchor: e.currentTarget })}
                    >
                      {lead && (
                        <span className={s.palLink}>
                          <Icon name="link-symbolic" size={12} color="var(--th-settings-fg)" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <Row label="Quick picks">
          <div className={s.chips} role="radiogroup" aria-label="Accent quick picks">
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
          </div>
        </Row>
        {view.groups.some((g) => g.id === "people" && g.swatches.length > 0) && (
          <div>
            <Button flat text={more ? "Fewer colours" : "More colours (people)"} onClick={() => setMore(!more)} />
          </div>
        )}
        {view.handSet.length > 0 && (
          <div className={s.note}>
            <Icon name="help-about-symbolic" size={16} color="var(--th-settings-theme-note-icon)" />
            <span>{view.handSet.length === 1 ? "1 colour is set by hand and doesn't follow these." : `${view.handSet.length} colours are set by hand and don't follow these.`}</span>
            <Button flat text="Show in Advanced" onClick={() => useEditor.setState({ mode: "advanced", onlyIds: view.handSet, query: "", changedOnly: false })} />
          </div>
        )}
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
