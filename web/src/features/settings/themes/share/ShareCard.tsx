// ShareCard.tsx — THEMES-UI.md §14.3: the timeline card of a theme share (an m.room.message carrying
// `dev.tinhat.theme.share`), drawn inside the message bubble in the SHARED theme's own roles: "Tin Hat theme", the
// name, "by ‹author› · Dark theme", the ten swatches, Try (30 s) and Keep. A card that can't be used (refused / newer)
// says so in the app's colours. The body text is hidden by the bubble (a renderer is present); the body carries no URL,
// so no link preview is built. Read from the ORIGINAL content (an edit cannot change a card).
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { MatrixEvent } from "matrix-js-sdk";
import type { TimelineRendererProps } from "@/core/registry";
import { peekClient } from "@/core/matrix";
import { NO_TOKENS, resolveTheme, type Theme } from "@/theme/engine";
import { readShare, SHARE_KEY, type ShareRead } from "@/theme/share";
import type { JObj } from "@/theme/sync";
import { Icon, cx, useTip } from "@/ui";
import { cssColour } from "@/ui/themeNames";
import { loadLibrary } from "@/ui/themeLibrary";
import { usePreviewOwner, useThemeState } from "@/ui/themeStore";
import { APP_SPEC } from "../editor/editorStore";
import { keepState, keepTheme, tryTheme, endTrial, useTrial } from "./shareStore";
import s from "./share.module.css";

function shareOf(ev: MatrixEvent): unknown {
  const orig = ev.getOriginalContent?.() as Record<string, unknown> | undefined;
  return orig && typeof orig === "object" && SHARE_KEY in orig ? orig : ev.getContent();
}
export const hasShareMarker = (ev: MatrixEvent): boolean => {
  if (ev.getType() !== "m.room.message") return false;
  const c = shareOf(ev) as Record<string, unknown> | null;
  const v = c?.[SHARE_KEY] as Record<string, unknown> | undefined;
  return !!v && typeof v === "object" && v.format === "tinhat-theme-share";
};

const reads = new WeakMap<MatrixEvent, ShareRead>();
function readOf(ev: MatrixEvent): ShareRead {
  let r = reads.get(ev);
  if (!r) {
    r = readShare(shareOf(ev), APP_SPEC);
    reads.set(ev, r);
  }
  return r;
}

const CARD_ROLES = [
  "surface.island", "surface.raised", "surface.hover", "border.subtle", "border.focus", "text.primary", "text.secondary",
  "text.onAccent", "accent.base", "accent.bright",
] as const;

function Btn({ text, tip, onClick, disabled, primary, label }: { text: string; tip?: string; onClick: () => void; disabled?: boolean; primary?: boolean; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, tip);
  return (
    <button ref={ref} type="button" className={cx(s.btn, primary && s.primary)} disabled={disabled} aria-label={label} onClick={onClick}>
      {text}
    </button>
  );
}

export function ThemeShareCard({ event }: TimelineRendererProps) {
  const r = useMemo(() => readOf(event), [event]);
  const me = peekClient()?.getUserId() ?? "";
  const mine = event.getSender() === me;
  const st = useThemeState();
  const owner = usePreviewOwner();
  const trial = useTrial((x) => x.trial);
  const key = event.getId() ?? "";
  useEffect(() => {
    // Keep's label needs the library (a shared library theme is "Use", not "Keep")
    if (r.kind === "ok") void loadLibrary().catch(() => undefined);
  }, [r.kind]);
  const roles = useMemo(() => {
    if (r.kind !== "ok") return null;
    const res = resolveTheme(r.theme, NO_TOKENS);
    if (!res.ok) return null;
    const out: Record<string, string> = {};
    for (const id of CARD_ROLES) out[id] = cssColour(res.roles[id]);
    return out;
  }, [r]);

  if (r.kind === "none") return null;
  if (r.kind !== "ok" || !roles) {
    const text =
      r.kind === "newer"
        ? "This theme needs a newer version of Tin Hat."
        : r.kind === "refused" && r.name
          ? `${r.name} can't be used by this version of Tin Hat (${r.error.split(":")[0]}).`
          : `This theme can't be used (${r.kind === "refused" ? r.error.split(":")[0] : "refused"}).`;
    return (
      <div className={cx(s.card, s.refused, mine && s.own)} role="group" aria-label="Tin Hat theme" data-theme-card="refused">
        <div className={s.caption}>
          <Icon name="dialog-warning" size={16} color="var(--th-bubble-theme-share-refused-icon)" />
          <span>Tin Hat theme</span>
        </div>
        <div className={s.refusedText}>{text}</div>
      </div>
    );
  }
  const style = {
    "--c-bg": roles["surface.island"],
    "--c-raised": roles["surface.raised"],
    "--c-hover": roles["surface.hover"],
    "--c-border": roles["border.subtle"],
    "--c-focus": roles["border.focus"],
    "--c-fg": roles["text.primary"],
    "--c-fg2": roles["text.secondary"],
    "--c-on": roles["text.onAccent"],
    "--c-accent": roles["accent.base"],
    "--c-bright": roles["accent.bright"],
  } as CSSProperties;
  const meta = `${r.author ? `by ${r.author} · ` : ""}${r.variant === "light" ? "Light" : "Dark"} theme`;
  const trying = trial?.key === key;
  const editorOpen = owner === "editor";
  const ks = keepState(r.theme as JObj, st.colours.theme);
  const keepText = ks === "keep" ? "Keep" : ks === "use" ? "Use" : "In use";
  return (
    <div className={cx(s.card, mine && s.own)} style={style} role="group" aria-label={`${r.name}, Tin Hat theme`} data-theme-card="ok">
      <div className={s.caption}>
        <Icon name="preferences-desktop-color" size={16} color="var(--c-bright)" />
        <span>Tin Hat theme</span>
      </div>
      <div className={s.name}>{r.name}</div>
      <div className={s.meta}>{meta}</div>
      <div className={s.swatches} aria-hidden>
        {r.swatches.map((c, i) => (
          <span key={i} className={s.swatch} style={{ background: cssColour(c) }} />
        ))}
      </div>
      <div className={s.buttons}>
        <Btn
          text={trying ? "Stop" : "Try for 30 s"}
          label={trying ? `Stop trying ${r.name}` : `Try ${r.name}`}
          tip={editorOpen ? "Close the theme editor to try another theme" : undefined}
          disabled={editorOpen}
          onClick={() => (trying ? endTrial(true) : tryTheme(key, r.theme as unknown as Theme))}
        />
        <Btn text={keepText} label={`Keep ${r.name}`} primary disabled={ks === "inUse"} onClick={() => void keepTheme(r.theme as JObj)} />
      </div>
    </div>
  );
}
