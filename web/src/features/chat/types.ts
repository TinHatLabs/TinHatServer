// types.ts — the shell contract of the chat feature (kept from the phase-1 stub).
import type { ReactNode } from "react";

export interface RoomPageProps {
  roomId: string;
  /** jump to this event (permalinks) */
  eventId?: string;
  callSlot?: ReactNode;
  rightPanelSlot?: ReactNode;
  leftInset?: number;
  mobile?: boolean;
  onBack?: () => void;
}
