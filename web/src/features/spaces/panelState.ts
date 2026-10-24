// panelState.ts — the RightPanel's open state (Main.qml rightPanel.shown / open() / close()) and tab.
// The room header's info button calls toggleRightPanel() (or emits bus openRightPanel /
// closeRightPanel); useRightPanelOpen() drives its accent + tooltip ("Close room info" /
// "Room info & members"). Tab 1 (Members) is the default.
import { create } from "zustand";

export interface RightPanelState {
  open: boolean;
  /** 0 = Info, 1 = Members */
  tab: 0 | 1;
}

export const useRightPanelStore = create<RightPanelState>()(() => ({ open: false, tab: 1 }));

export const openRightPanel = (tab?: "info" | "members" | 0 | 1) =>
  useRightPanelStore.setState((s) => ({ open: true, tab: tab === "info" || tab === 0 ? 0 : tab === "members" || tab === 1 ? 1 : s.tab }));
export const closeRightPanel = () => useRightPanelStore.setState({ open: false });
export const toggleRightPanel = () => useRightPanelStore.setState((s) => ({ open: !s.open }));
export const setRightPanelTab = (tab: 0 | 1) => useRightPanelStore.setState({ tab });

/** Is the room info / members panel open (the header info button's accent). */
export function useRightPanelOpen(): boolean {
  return useRightPanelStore((s) => s.open);
}
