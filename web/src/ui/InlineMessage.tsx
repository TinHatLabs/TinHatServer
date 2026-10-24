// InlineMessage.tsx — Kirigami.InlineMessage as the app uses it (the window banner strip: verify /
// offline / update; InlineMessages inside panes). Inline position: a radius-5 frame in the type
// colour (Warning = Kirigami neutral #f67400, Positive = pal.positive, Error = pal.dangerBright,
// Information = pal.accentBright), a 1 px inset fill of the background tinted 20 % with that
// colour; padding 5; the type emblem (22 px) 4 px in, the 12 px text 8 px after it; actions are
// Basic ToolButtons (40 px, palette.button at 0.5) on the right. The host puts Layout.margins smallSpacing (4) around it.
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import { BasicToolButton } from "./Button";
import s from "./InlineMessage.module.css";

export type MessageType = "information" | "positive" | "warning" | "error";

export interface InlineAction {
  text: string;
  icon?: string;
  onTriggered: () => void;
  visible?: boolean;
  enabled?: boolean;
}

export interface InlineMessageProps {
  type?: MessageType;
  text: ReactNode;
  actions?: InlineAction[];
  icon?: string;
  showCloseButton?: boolean;
  onClose?: () => void;
  /** Header/Footer: square edges, only a line (Kirigami position) */
  position?: "inline" | "header" | "footer";
  className?: string;
  style?: CSSProperties;
}

const EMBLEM: Record<MessageType, string> = {
  information: "emblem-information",
  positive: "emblem-success",
  warning: "emblem-warning",
  error: "emblem-error",
};

export function InlineMessage({ type = "information", text, actions = [], icon, showCloseButton, onClose, position = "inline", className, style }: InlineMessageProps) {
  const shown = actions.filter((a) => a.visible !== false);
  return (
    <div className={`${s.msg} ${s[type]} ${s[position]} ${className ?? ""}`} style={style} role="alert">
      <span className={s.fill} />
      <span className={s.icon}>
        <Icon name={icon ?? EMBLEM[type]} size={22} isMask={false} />
      </span>
      <span className={s.text}>{text}</span>
      {shown.length > 0 && (
        <span className={s.actions}>
          {shown.map((a, i) => (
            <BasicToolButton key={i} text={a.text} iconName={a.icon} disabled={a.enabled === false} onClick={a.onTriggered} className={s.action} />
          ))}
        </span>
      )}
      {showCloseButton && (
        <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
          <Icon name="dialog-close" size={22} />
        </button>
      )}
    </div>
  );
}
