// controls.tsx — REACH §2.7 + A2.1/A2.2/A2.15 + A4.6: where a person decides. Laid out like the desktop
// (ThRoomList.qml statusPop / askCard, 10.6), so the two apps look the same.
//
//   <YourStatusSection/>     Settings → Privacy, first section "Your status": the switch, the promise, the
//                            small print and, while on, "Others see you as: …" (the server's view of you)
//   <StatusPopover/>         the footer's "Your status" popover (phones: the same body as a bottom sheet —
//                            the account sheet): switch, one line, "Set a status" (presets, Custom…),
//                            Clear status, "Profile settings…" + "Privacy settings…"
//   <TimeZoneSection/>       Settings → Privacy "Time zone" (A7): "Share my time zone" (on by default) + the zone
import { useEffect, useRef, useState } from "react";
import { openSettings } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { useServerFeature } from "@/core/server";
import { Button, ComboBox, ConfirmDialog, Heading, Popover, SectionLabel, Separator, Switch, TextField, cx, useIsMobile, useTip, type Rect, useContentInk } from "@/ui";
import { EmojiPicker } from "@/features/chat/EmojiPicker";
import { useCallStore } from "@/features/calls";
import { answerQuestion, setMyStatus, turnSharingOff, turnSharingOn, usePresenceStore } from "./runtime";
import { showQuestion } from "./model";
import { STATUS_PALETTE, STATUS_PRESETS, STATUS_TEXT_MAX, statusColor, statusText, tonightUntil, type CustomStatus, type StatusPreset } from "./status";
import { PresenceLine, StatusChip, hexA, useMyPresence, viewOf } from "./ui";
import { pickTz, setTzShare, useTzStore } from "./tz";
import { ZONE_CHOICES, zoneChoiceText } from "@/widgets/clocks";
import s from "./presence.module.css";

// ---- wording (both apps; A2.1 + A3) ---------------------------------------------------------------------

export const PROMISE = [
  "Off by default. While it's off, Tin Hat shares no status about you with anyone.",
  "On: people who share a room with you see Online, Away or In a call. Never a last-seen time, never what you're doing.",
  "Off again: the server stops sharing it at once, and it leaves friends' screens within about 20 seconds. Nothing is kept.",
] as const;
export const SMALL_PRINT = "Messages, typing and read receipts are separate and work as before. Other Matrix apps you use may report your status on their own.";
export const POPOVER_OFF = "Off — nobody sees your status.";
export const POPOVER_ON = "On — people you share a room with see Online, Away or In a call.";
export const QUESTION = "Let friends see when you're online? Only Online, Away or In a call — you can turn it off any time.";

// ---- the switch -----------------------------------------------------------------------------------------------

export function ShareSwitch({ className }: { className?: string }) {
  const share = usePresenceStore((st) => st.share);
  const turningOff = usePresenceStore((st) => st.turningOff);
  const busy = usePresenceStore((st) => st.busy);
  const known = usePresenceStore((st) => st.known);
  return (
    <Switch
      className={className}
      text={turningOff ? "Turning off…" : "Share my status"}
      checked={share && !turningOff}
      // "Turning off…" may wait for the server; turning it back on meanwhile cancels that (never disabled then)
      disabled={!known || busy}
      aria-label="Share my status"
      onToggled={(on) => void (on ? turnSharingOn() : turnSharingOff())}
    />
  );
}

/** A2.15: "Others see you as …" = your own row in GET /api/presence, never local state (the desktop: the
 *  PresenceLine at the default font in the text colour; "checking…" until the server lists you). */
export function SeenAsLine() {
  const me = useMyPresence();
  const myId = useSession().userId ?? "";
  return (
    <div className={s.seenAs} data-seen-as={me ? me.state : "none"}>
      <span className={s.seenAsLabel}>Others see you as:</span>
      {me ? <PresenceLine mxid={myId} normal /> : <span className={s.checking}>checking…</span>}
    </div>
  );
}

// ---- Settings → Privacy -----------------------------------------------------------------------------------------

export function YourStatusSection() {
  const share = usePresenceStore((st) => st.share);
  const error = usePresenceStore((st) => st.error);
  return (
    <>
      <SectionLabel>Your status</SectionLabel>
      <ShareSwitch />
      <ul className={s.promise}>
        {PROMISE.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className={s.small}>{SMALL_PRINT}</div>
      {share && <SeenAsLine />}
      {error && <div className={s.err}>{error}</div>}
      <Separator />
    </>
  );
}

// ---- Settings → Privacy "Time zone" (REACH A7) -------------------------------------------------------------------

export const TZ_SWITCH = "Share my time zone";
export const TZ_HINT = "Friends see your local time in Friends' clocks.";

export function TimeZoneSection() {
  const t = useTzStore();
  const share = t.pref ? t.pref.share : t.known; // absent after the first sync = the first-run write is on its way (ON)
  const auto = t.pref ? t.pref.auto : true;
  const picked = t.pref && !auto ? t.pref.tz : "";
  const choices = ["", ...ZONE_CHOICES, ...(picked && !ZONE_CHOICES.includes(picked) ? [picked] : [])];
  const text = (z: string) => (z ? zoneChoiceText(z) : t.device ? `Automatic (${zoneChoiceText(t.device)})` : "Automatic");
  return (
    <>
      <SectionLabel>Time zone</SectionLabel>
      <Switch text={TZ_SWITCH} checked={share} disabled={!t.known || t.busy} aria-label={TZ_SWITCH} onToggled={(on) => void setTzShare(on)} data-tz-switch="" />
      <div className={s.small}>{TZ_HINT}</div>
      <div className={s.tzRow}>
        <span className={s.seenAsLabel}>Your time zone</span>
        <ComboBox
          className={s.grow}
          aria-label="Your time zone"
          model={choices}
          textRole={text}
          currentIndex={Math.max(0, choices.indexOf(picked))}
          disabled={!t.known || t.busy}
          onActivated={(_i, z) => void pickTz(z)}
        />
      </div>
      {t.error && <div className={s.err}>{t.error}</div>}
      <Separator />
    </>
  );
}

// ---- the picker (A4.6) ---------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
/** "Clear after" — the desktop's combo items, default "4 hours". */
const CLEAR_AFTER: ReadonlyArray<{ label: string; until: (now: number) => number | null }> = [
  { label: "30 minutes", until: (n) => n + HOUR / 2 },
  { label: "1 hour", until: (n) => n + HOUR },
  { label: "4 hours", until: (n) => n + 4 * HOUR },
  { label: "Tonight (until 4 AM)", until: (n) => tonightUntil(n) },
  { label: "Don't clear", until: () => null },
];

function PresetChip({ p, current, onPick }: { p: StatusPreset; current: boolean; onPick: () => void }) {
  const ink = useContentInk();
  const hex = statusColor(p.color);
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      className={s.preset}
      data-current={current ? "" : undefined}
      aria-pressed={current}
      aria-label={p.text}
      style={{
        background: current ? hexA(hex, 0.22) : hover ? hexA(hex, 0.14) : "var(--th-status-preset-bg)",
        borderColor: current ? hex : "var(--th-status-preset-border)",
        borderWidth: current ? 1.5 : 1,
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={onPick}
    >
      <span className={s.presetEmoji}>{p.emoji}</span>
      <span className={s.presetText} style={current ? { color: ink(hex) } : undefined}>
        {p.text}
      </span>
      <span className={s.presetDot} style={{ background: hex }} />
    </button>
  );
}

export function StatusPicker() {
  const current = usePresenceStore((st) => st.status);
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState("blurple");
  const [clearIdx, setClearIdx] = useState(2);
  const [picker, setPicker] = useState(false);
  const [pending, setPending] = useState<CustomStatus | null>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const emojiTipRef = useRef<HTMLButtonElement>(null);
  useTip(emojiTipRef, emoji ? "Change the emoji (right-click: none)" : "Pick an emoji");
  useEffect(() => {
    if (custom && document.documentElement.dataset.ff !== "mobile") field.current?.focus();
  }, [custom]);

  const apply = async (st: CustomStatus) => {
    if (!usePresenceStore.getState().share) {
      setPending(st); // A4.6: a pick while sharing is off asks first
      return;
    }
    if (await setMyStatus(st)) setCustom(false);
  };
  const openCustom = () => {
    const open = !custom;
    setCustom(open);
    if (open) {
      const cur = current?.id === "custom" ? current : null;
      setText(cur?.text ?? "");
      setEmoji(cur?.emoji ?? "");
      setColor(cur?.color ?? "blurple");
      setClearIdx(2);
    }
  };
  const trimmed = text.trim();
  const save = () => {
    if (!trimmed) return;
    void apply({ id: "custom", text: trimmed, emoji, color, until: CLEAR_AFTER[clearIdx]!.until(Date.now()) });
  };
  const customCurrent = current?.id === "custom";
  return (
    <>
      <SectionLabel>Set a status</SectionLabel>
      <div className={s.presets} data-status-picker="">
        {STATUS_PRESETS.map((p) => (
          <PresetChip
            key={p.id}
            p={p}
            current={current?.id === p.id}
            // presets clear after 4 hours (A4.6)
            onPick={() => void apply({ id: p.id, text: p.text, emoji: p.emoji, color: p.color, until: Date.now() + 4 * HOUR })}
          />
        ))}
        <button
          type="button"
          className={cx(s.preset, s.customChip)}
          data-current={custom || customCurrent ? "" : undefined}
          aria-expanded={custom}
          style={{
            background: custom || customCurrent ? "var(--th-status-custom-bg-active)" : undefined,
            borderColor: custom || customCurrent ? "var(--th-status-custom-border-active)" : undefined,
          }}
          onClick={openCustom}
        >
          <span className={s.presetText}>{customCurrent ? statusText(current!) : "Custom…"}</span>
        </button>
      </div>
      {custom && (
        <div className={s.editor} data-status-editor="">
          <div className={s.editRow}>
            <Button
              ref={(el) => {
                emojiRef.current = el;
                emojiTipRef.current = el;
              }}
              className={s.emojiBtn}
              icon={emoji ? undefined : "face-smile-symbolic"}
              text={emoji || undefined}
              aria-label={emoji ? `Emoji ${emoji}` : "Pick an emoji"}
              onClick={() => setPicker(true)}
              onContextMenu={(e) => {
                e.preventDefault();
                setEmoji("");
              }}
            />
            <TextField
              ref={field}
              className={s.grow}
              value={text}
              placeholder="What are you up to?"
              aria-label="Status text"
              onChange={(e) => setText(Array.from(e.target.value).slice(0, STATUS_TEXT_MAX).join(""))}
              onAccepted={save}
            />
          </div>
          <div className={s.swatches} role="radiogroup" aria-label="Colour">
            {STATUS_PALETTE.map(([key, hex]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={color === key}
                aria-label={key}
                title={key}
                className={s.swatch}
                data-on={color === key ? "" : undefined}
                style={{ background: hex }}
                onClick={() => setColor(key)}
              />
            ))}
          </div>
          <div className={s.editRow}>
            <span className={s.clearLabel}>Clear after</span>
            <ComboBox className={s.grow} aria-label="Clear after" model={CLEAR_AFTER.map((c) => c.label)} currentIndex={clearIdx} onActivated={(i) => setClearIdx(i)} />
          </div>
          <div className={s.actions}>
            <Button highlighted text="Save" disabled={!trimmed} onClick={save} />
          </div>
          <EmojiPicker open={picker} onClose={() => setPicker(false)} anchor={emojiRef.current} onPick={(e) => setEmoji(e)} />
        </div>
      )}
      {current && (
        <Button className={s.flatStart} flat icon="edit-clear-symbolic" text="Clear status" onClick={() => void setMyStatus(null)} />
      )}
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        dialogTitle="Show your status to friends?"
        message="This turns on sharing."
        confirmText="Turn on"
        onCancelled={() => setPending(null)}
        onConfirmed={async () => {
          const st = pending;
          setPending(null);
          // an explicit user action = consent: share first, then the status
          if (st && (await turnSharingOn())) {
            if (await setMyStatus(st)) setCustom(false);
          }
        }}
      />
    </>
  );
}

// ---- the footer popover ---------------------------------------------------------------------------------------

export function StatusPopover({ anchor, onClose }: { anchor: HTMLElement | Rect | null; onClose: () => void }) {
  const share = usePresenceStore((st) => st.share);
  const error = usePresenceStore((st) => st.error);
  const mobile = useIsMobile();
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="above" align="start" gap={8} plain className={mobile ? undefined : s.pop} title="Your status" aria-label="Your status">
      <div className={s.popBody} data-status-popover="">
        {/* phones: the bottom sheet carries the title itself */}
        {!mobile && (
          <Heading level={4} className={s.popTitle}>
            Your status
          </Heading>
        )}
        <ShareSwitch />
        <div className={s.popLine}>{share ? POPOVER_ON : POPOVER_OFF}</div>
        {error && <div className={s.err}>{error}</div>}
        <Separator className={s.popSep} />
        <StatusPicker />
        <Separator />
        {/* 2026-09-29: Profile settings next to Privacy settings (desktop ThRoomList statusPop) */}
        <div className={s.popLinks}>
          <Button
            className={s.flatStart}
            flat
            icon="user-symbolic"
            text="Profile settings…"
            onClick={() => {
              onClose();
              openSettings("profile");
            }}
          />
          <Button
            className={s.flatStart}
            flat
            icon="view-private-symbolic"
            text="Privacy settings…"
            onClick={() => {
              onClose();
              openSettings("privacy");
            }}
          />
        </div>
      </div>
    </Popover>
  );
}

// ---- the one-time question ----------------------------------------------------------------------------------------

/** May the one-time question be asked now? (signed in, the sharing choice known, never answered, not sharing, not
 *  turning off, not in a call) — the calm first run's Settings banner (features/selfhost). */
export function useStatusQuestionVisible(): boolean {
  const known = usePresenceStore((st) => st.known && st.live);
  const asked = usePresenceStore((st) => st.asked);
  const share = usePresenceStore((st) => st.share);
  const turningOff = usePresenceStore((st) => st.turningOff);
  const inCall = useCallStore((st) => st.inCall || st.connecting);
  const signedIn = useSession().state === "ready";
  const offered = useServerFeature("presence"); // docs/SELFHOST.md: never asked on a server without the service
  return offered && signedIn && !turningOff && showQuestion(known, asked, share, inCall);
}


/** The footer's own status line under your name (A4.5): the server's view of you, as a chip. */
export function MyStatusLine({ className }: { className?: string }) {
  const me = useMyPresence();
  const chip = me ? viewOf(me).chip : null;
  if (!chip) return null;
  return (
    <span className={cx(s.footStatus, className)} data-my-status="">
      <StatusChip text={chip.text} color={chip.color} />
    </span>
  );
}
