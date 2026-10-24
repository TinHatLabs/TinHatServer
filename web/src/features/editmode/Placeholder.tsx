// Placeholder.tsx — the placeholder of an island whose real content is absent while editing (EDITMODE-UI §2: no room,
// no call, the panel closed, no unread DMs, no widgets): its icon, name and line. The shell hands it to the island's
// own frame (app/dock IslandFrame), which draws it above the content and under the frame line — so a floating island
// covers it the way it covers content (§20; the desktop's Island.qml). The edit layer's veil and outline paint over it.
// Short islands (h < 72): one line, no icon.
import { Icon } from "@/ui";
import { useIsland } from "@/ui/island";
import { islandText } from "./names";
import s from "./Placeholder.module.css";

export function IslandPlaceholder({ islandRef }: { islandRef: string }) {
  const isl = useIsland();
  const t = islandText(islandRef);
  // the frame's height = the content box + the frame's inset on both sides
  const short = !!isl && isl.h + 2 * isl.inset < 72;
  return (
    <div className={s.placeholder} data-edit-placeholder={islandRef} data-short={short ? "" : undefined}>
      <Icon name={t.icon} size={24} color="var(--th-editmode-placeholder-fg)" />
      <span className={s.name}>{t.name}</span>
      {t.absent && <span className={s.line}>{t.absent}</span>}
    </div>
  );
}
