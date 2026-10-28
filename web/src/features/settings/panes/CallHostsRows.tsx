// CallHostsRows.tsx — Settings › Calls › "Call hosts you trust" (calls round M1, DESIGN §2.4): the hosts the user chose
// "Always trust" for on the "Join a call hosted elsewhere?" sheet. Account data dev.tinhat.call_hosts, synced to the
// user's other devices and read by web, desktop and the phones; Remove means the sheet asks again next time.
import { Button } from "@/ui";
import { useAccountData } from "@/core/matrix";
import { CALL_HOSTS_TYPE, callHostsOf, untrustCallHost } from "@/features/calls";
import { Hint, Row } from "../rows";
import s from "./SameRoomRows.module.css";

export function CallHostsRows() {
  const hosts = callHostsOf(useAccountData(CALL_HOSTS_TYPE));
  return (
    <Row id="calls.call-hosts" label="Call hosts you trust" description={hosts.length ? "Calls on these servers join without asking. Remove one and Tin Hat asks again next time." : undefined}>
      {hosts.length === 0 ? (
        <Hint>None. When a call runs on another server, Tin Hat asks before joining; "Always trust" adds that server here.</Hint>
      ) : (
        <div className={s.stack}>
          {hosts.map((h) => (
            <div key={h} className={s.inlineRow} data-call-host={h}>
              <span className={s.inlineText}>{h}</span>
              <Button text="Remove" onClick={() => void untrustCallHost(h)} />
            </div>
          ))}
        </div>
      )}
    </Row>
  );
}
