// hostsheet.ts — M1's "Join a call hosted elsewhere?" sheet (DESIGN §2.4), engine side: the engine asks through
// askCallHost() and waits; ui/CallHostSheet.tsx (an always-mounted overlay) answers. With no sheet mounted the answer
// is "cancel" — a join never goes to a foreign host without the user's say. "Always trust" goes to the synced account
// data dev.tinhat.call_hosts (read by web, desktop and the phones); Settings → Calls lists it with Remove.
import { peekClient } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { CALL_HOSTS_TYPE, withCallHost, withoutCallHost } from "./callrules";
import { errText } from "./util";

const log = createLogger("call-hosts");

export type HostAnswer = "join" | "always" | "cancel";

export interface HostQuestion {
  roomId: string;
  host: string;
  serviceUrl: string;
  /** our own mxid (the sign-in proof says this) */
  me: string;
  advertiser: string;
  advertiserName: string;
}

type Asker = (q: HostQuestion) => Promise<HostAnswer>;
let asker: Asker | null = null;
let dismiss: (() => void) | null = null;

/** The sheet registers itself here (null on unmount). */
export function setHostAsker(f: Asker | null, onDismiss: (() => void) | null = null): void {
  asker = f;
  dismiss = onDismiss;
}

export function askCallHost(q: HostQuestion): Promise<HostAnswer> {
  if (!asker) {
    log.warn(`no call-host sheet mounted — not joining the call on ${q.host}`);
    return Promise.resolve("cancel");
  }
  return asker(q);
}

/** Close an open sheet as "cancel" (the join it belongs to was left / superseded). */
export function dismissHostAsk(): void {
  dismiss?.();
}

/** "Always trust {host}": add it to dev.tinhat.call_hosts (synced to the user's other devices). */
export async function trustCallHost(host: string): Promise<boolean> {
  const c = peekClient();
  if (!c || !host) return false;
  try {
    await c.setAccountData(CALL_HOSTS_TYPE as never, withCallHost(c.getAccountData(CALL_HOSTS_TYPE as never)?.getContent(), host) as never);
    log.info(`call host ${host} is now trusted`);
    return true;
  } catch (e) {
    log.warn(`trusting ${host}: ${errText(e)}`);
    return false;
  }
}

/** Settings → Calls → "Call hosts you trust" → Remove. */
export async function untrustCallHost(host: string): Promise<boolean> {
  const c = peekClient();
  if (!c || !host) return false;
  try {
    await c.setAccountData(CALL_HOSTS_TYPE as never, withoutCallHost(c.getAccountData(CALL_HOSTS_TYPE as never)?.getContent(), host) as never);
    log.info(`call host ${host} removed from the trusted list`);
    return true;
  } catch (e) {
    log.warn(`removing ${host}: ${errText(e)}`);
    return false;
  }
}
