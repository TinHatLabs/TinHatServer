// panelState.ts — the RightPanel's open state (Main.qml rightPanel.shown / open() / close()) and tab.
// The room header's info button calls toggleRightPanel() (or emits bus openRightPanel /
// closeRightPanel); useRightPanelOpen() drives its accent + tooltip ("Close room info" /
// "Room info & members"). Tab 1 (Members) is the default.
import { create } from "zustand";

export interface RightPanelState {
  open: boolean;
  /** 0 = Info, 1 = Members, or a contributed tab's id (r.rightPanelTabs, e.g. chat's "threads") */
  tab: 0 | 1 | string;
  /** the panel overlays the conversation (a narrow page) rather than docking beside it — phones' Back closes it */
  overlay: boolean;
}

export const useRightPanelStore = create<RightPanelState>()(() => ({ open: false, tab: 1, overlay: false }));

export const openRightPanel = (tab?: "info" | "members" | 0 | 1 | string) =>
  useRightPanelStore.setState((s) => ({ open: true, tab: tab === "info" || tab === 0 ? 0 : tab === "members" || tab === 1 ? 1 : typeof tab === "string" && tab ? tab : s.tab }));
export const closeRightPanel = () => useRightPanelStore.setState({ open: false });
export const toggleRightPanel = () => useRightPanelStore.setState((s) => ({ open: !s.open }));
export const setRightPanelTab = (tab: 0 | 1 | string) => useRightPanelStore.setState({ tab });

/** Is the room info / members panel open (the header info button's accent). */
export function useRightPanelOpen(): boolean {
  return useRightPanelStore((s) => s.open);
}
