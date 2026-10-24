// ShortcutsPane.tsx — Settings → Shortcuts (cards of the Settings window since 2026-09-29, SETTINGS-WINDOW.md §5; 11.0 buttons, ACTIONS.md §8.8; DESIGN.md "Shortcuts: any action can get a
// keyboard shortcut in Settings → Shortcuts; clashes are flagged"; the desktop's ShortcutsPane.qml — the same list,
// texts and numbers). Every action a person may give a key (shortcutsView: per group, by label), its keys now (chips),
// "Change…" (the key recorder), "↺" back to Tin Hat's key; a key two actions share is flagged on both rows and the key
// runs the one it was given to last (the dispatch order, §8.6). Keys stay on this device (pref `shortcuts`).
// Web: keys the browser also uses are marked — Tin Hat takes them while it has the focus.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from "react";
import { Button, Dialog, HintLabel, Icon, SearchField, ToolButton, cx } from "@/ui";
import { NoteRow, Row, Section } from "@/features/settings/rows";
import { eventChordText, eventKeyName, suspendShortcuts } from "@/core/shortcuts";
import { actionById } from "../table";
import { checkUserBinding, effectiveBindings, setUserBinding, type ShortcutItem } from "../bindings";
import { fold } from "../palette";
import { resetAllShortcuts, setActionKeys, shortcutsDoc, shortcutsList, useShortcutsRaw } from "../shortcutsStore";
import s from "./ShortcutsPane.module.css";

/** What a failed check means, in words (§8.4's codes). */
export const KEY_ERRORS: Record<string, string> = {
  reserved: "Tin Hat keeps this key for moving around (Escape, Tab, F6).",
  "hold-key": "Push to talk takes a modifier held on its own (Ctrl, Alt, Shift or Meta) or an F-key.",
  "hold-only": "A modifier on its own is only for push to talk — add a key to it.",
  "needs-modifier": "This key types text — add Ctrl, Alt or Meta, or use an F-key.",
  "browser-reserved": "Your browser keeps this key for itself — pick another one.",
  "fixed-taken": "Tin Hat uses this key for something that can't move (Ctrl+V pastes, Return sends).",
  "bad-sequence": "That key can't be used.",
};

const labelOf = (id: string) => actionById(id)?.label ?? id;

export function ShortcutsPane() {
  const raw = useShortcutsRaw();
  const view = useMemo(() => shortcutsList(), [raw]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ShortcutItem | null>(null);
  const q = fold(query);
  const anyChanged = view.groups.some((g) => g.items.some((it) => it.changed));
  // Settings window (SETTINGS-WINDOW.md §5 "Shortcuts: today's pane (its own search stays) in the card style"): the
  // window scrolls; a card with the intro, the search and Reset all, then one card per group (rows.tsx shapes)
  return (
    <>
      <Section>
        <Row
          id="shortcuts.shortcuts"
          label="Keyboard shortcuts"
          description="Give any action a key of your own, or change or remove Tin Hat's. Your keys stay on this device. Keys your browser also uses are marked — they work while Tin Hat has the focus."
          attrs={{ "data-shortcuts-pane": "" }}
          control={anyChanged ? <Button flat text="Reset all" icon="edit-undo-symbolic" onClick={() => resetAllShortcuts()} /> : undefined}
        >
          <SearchField className={s.search} value={query} onValueChange={setQuery} placeholder="Search actions…" />
        </Row>
        {view.conflicts > 0 && (
          <NoteRow tone="warning">
            {view.conflicts === 1 ? "One key is on two actions" : `${view.conflicts} keys are on two actions`} — it runs the one you gave it to; the other one has no key there.
          </NoteRow>
        )}
      </Section>
      {view.groups.map((g) => {
        const items = q ? g.items.filter((it) => fold(it.label).includes(q)) : g.items;
        if (items.length === 0) return null;
        return (
          <Section key={g.group} title={g.label} id={`shortcuts-${g.group}`}>
            {items.map((it) => (
              <Row
                key={it.a}
                className={s.item}
                attrs={{ "data-action": it.a, "data-group": g.group }}
                icon={<Icon name={it.icon ?? "input-keyboard-symbolic"} size={16} color="var(--th-action-palette-icon)" staticOnly />}
                label={it.label}
                description={
                  it.clashes.length > 0 ? (
                    <>
                      {it.clashes.map((c) => (
                        <span key={c.key} className={s.clash}>
                          {c.key} is also on {c.with.map(labelOf).join(", ")}
                        </span>
                      ))}
                    </>
                  ) : undefined
                }
                inline
                control={
                  <>
                    <div className={s.keys}>
                      {it.keys.length === 0 ? (
                        <span className={s.none}>No key</span>
                      ) : (
                        it.keys.map((k) => (
                          <span key={k} className={cx(s.chip, it.clashes.some((c) => c.key === k) && s.chipClash)} title={it.browser.includes(k) ? "Your browser uses this key too — Tin Hat takes it while it has the focus" : undefined}>
                            {k}
                            {it.hold ? " (hold)" : ""}
                            {it.browser.includes(k) && <span className={s.browserMark} aria-label="(the browser's key too)"> ·</span>}
                          </span>
                        ))
                      )}
                    </div>
                    {it.changed ? <ToolButton className={s.undo} iconName="edit-undo-symbolic" iconSize={16} tip="Back to Tin Hat's key" onClick={() => setActionKeys(it.a, null)} /> : <span className={s.undoGap} />}
                    <Button flat text="Change…" onClick={() => setEditing(it)} />
                  </>
                }
              />
            ))}
          </Section>
        );
      })}
      {editing && <KeyRecorder item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** The key recorder: press the keys (a modifier held alone for push to talk), see what it means, Save. */
function KeyRecorder({ item, onClose }: { item: ShortcutItem; onClose: () => void }) {
  const [key, setKey] = useState<string | null>(null);
  const pendingMod = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => suspendShortcuts(), []);
  useEffect(() => box.current?.focus(), []);
  const check = key ? checkUserBinding("web", item.a, key) : null;
  const error = check && !check.ok ? (KEY_ERRORS[check.error] ?? KEY_ERRORS["bad-sequence"]) : "";
  // the actions this key would take it from (a clash after Save)
  const takes = useMemo(() => {
    if (!check || !check.ok) return [];
    const doc = setUserBinding("web", shortcutsDoc(), item.a, [check.key]);
    const eff = effectiveBindings("web", doc ?? undefined);
    const out: string[] = [];
    for (const c of eff.conflicts) {
      if (c.key !== check.key) continue;
      const other = c.actions[0] === item.a ? c.actions[1] : c.actions[1] === item.a ? c.actions[0] : null;
      if (other && !out.includes(other)) out.push(other);
    }
    return out;
  }, [check, item.a]);
  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") return; // the dialog's own (and reserved anyway)
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const name = eventKeyName(e.nativeEvent);
    if (name === "Ctrl" || name === "Alt" || name === "Shift" || name === "Meta") {
      pendingMod.current = name;
      return;
    }
    pendingMod.current = null;
    const t = eventChordText(e.nativeEvent);
    if (t) setKey(t);
  };
  const onKeyUp = (e: RKeyboardEvent<HTMLDivElement>) => {
    const name = eventKeyName(e.nativeEvent);
    if (name && name === pendingMod.current) {
      // a modifier pressed and released on its own: a bare modifier (push to talk)
      setKey(name);
      pendingMod.current = null;
    }
  };
  const save = () => {
    if (check && check.ok) setActionKeys(item.a, [check.key]);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Key for “${item.label}”`}
      width={440}
      closeOnOutside={false}
      buttons={[
        { text: "No key", role: "action", onClick: () => (setActionKeys(item.a, []), onClose()) },
        { text: "Cancel", role: "reject", onClick: onClose },
        { text: "Save", role: "accept", disabled: !check || !check.ok, onClick: save },
      ]}
    >
      <div className={s.recBody}>
        <HintLabel>{item.hold ? "Hold a modifier (Ctrl, Alt, Shift or Meta) and let go, or press an F-key." : "Press the keys you want — Ctrl, Alt or Meta with a key, or an F-key."}</HintLabel>
        <div ref={box} className={s.recBox} tabIndex={0} role="textbox" aria-label="Press the keys" onKeyDown={onKeyDown} onKeyUp={onKeyUp} data-recorder="">
          {key ? <span className={cx(s.recKey, error && s.recKeyBad)}>{key}</span> : <span className={s.recHint}>Press the keys…</span>}
        </div>
        {error && <div className={s.recError}>{error}</div>}
        {!error && takes.length > 0 && <div className={s.recClash}>{`${key} is on ${takes.map(labelOf).join(", ")} now — it will run “${item.label}” instead.`}</div>}
        {item.defaults.length > 0 && <div className={s.recDefault}>Tin Hat's key: {item.defaults.join(", ")}</div>}
      </div>
    </Dialog>
  );
}
