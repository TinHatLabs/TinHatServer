// convToast.ts — where a conversation's own notices go (CHAT-120): the main window's toast, or a
// floating chat's in-bubble pill (FC:226-249) when the conversation lives in a floating chat.
import { createContext, useContext } from "react";
import { toast } from "@/core/bus";

export type Notify = (message: string) => void;
export const ConvToastCtx = createContext<Notify | null>(null);
const globalNotify: Notify = (m) => toast(m);
export function useConvToast(): Notify {
  return useContext(ConvToastCtx) ?? globalNotify;
}
