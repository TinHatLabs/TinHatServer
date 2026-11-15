// threads/HeaderButton.tsx — the room header's Threads button (docs/THREADS.md; the desktop's HeaderIsland Threads
// button): opens the right panel's Threads tab on the list (closes it when it shows the list already); a dot while a
// thread the room has loaded has replies I haven't read.
import { HeaderIconButton } from "@/ui";
import { bus } from "@/core/bus";
import { useRightPanelStore } from "@/features/spaces";
import { useThreadItems } from "./ThreadsPane";
import { openThreadPanel } from "./open";
import { THREADS_TAB } from "./state";
import s from "./Threads.module.css";

export function ThreadsHeaderButton({ roomId }: { roomId: string }) {
  const shown = useRightPanelStore((st) => st.open && st.tab === THREADS_TAB);
  const { items } = useThreadItems(roomId, false);
  const unread = items.some((i) => i.unread > 0);
  const mobile = document.documentElement.dataset.ff === "mobile";
  const tip = shown ? "Close threads" : unread ? "Threads (unread replies)" : "Threads";
  return (
    <span className={s.headWrap}>
      <HeaderIconButton
        iconName="dialog-messages-symbolic"
        tip={tip}
        aria-label={tip}
        accent={shown}
        size={mobile ? 44 : 36}
        onClick={() => (shown ? bus.emit("closeRightPanel", {}) : openThreadPanel(roomId, null))}
      />
      {unread && <span className={s.headDot} aria-hidden />}
    </span>
  );
}
