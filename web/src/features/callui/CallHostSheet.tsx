// CallHostSheet.tsx — M1's "Join a call hosted elsewhere?" (DESIGN §2.4; the desktop's QML sheet says the same words).
// One always-mounted dialog: the call engine asks through setHostAsker (features/calls/hostsheet.ts) and waits for
// Join / Always trust {host} / Cancel. Escape, a press outside and the phone's back button are Cancel. Phones get the
// same dialog in the phone layout (Dialog's own bottom placement); the phone APP never shows it — the native side
// decides and asks there for the joins it takes over (features/native).
import { useEffect } from "react";
import { create } from "zustand";
import { Dialog } from "@/ui";
import { HOST_SHEET_CANCEL, HOST_SHEET_JOIN, HOST_SHEET_TITLE, hostSheetAlways, setHostAsker, type HostAnswer, type HostQuestion } from "@/features/calls";
import s from "./CallHostSheet.module.css";

type Pending = { q: HostQuestion; resolve: (a: HostAnswer) => void };
const useAsk = create<{ req: Pending | null; n: number }>()(() => ({ req: null, n: 0 }));

function answer(a: HostAnswer) {
  const req = useAsk.getState().req;
  useAsk.setState({ req: null });
  req?.resolve(a);
}

function ask(q: HostQuestion): Promise<HostAnswer> {
  return new Promise((resolve) => {
    useAsk.getState().req?.resolve("cancel"); // a newer join replaces an open question
    useAsk.setState((st) => ({ req: { q, resolve }, n: st.n + 1 }));
  });
}

export function CallHostSheet() {
  const { req, n } = useAsk();
  useEffect(() => {
    setHostAsker(ask, () => answer("cancel"));
    return () => {
      setHostAsker(null);
      answer("cancel");
    };
  }, []);
  const q = req?.q;
  return (
    <Dialog
      key={n}
      open={!!q}
      onClose={() => answer("cancel")}
      title={HOST_SHEET_TITLE}
      width="min(420px, calc(100vw - 36px))"
      onRejected={() => answer("cancel")}
      buttons={[
        // no default button: Enter must never send a sign-in proof to a foreign host (a stray key press while typing)
        { text: HOST_SHEET_JOIN, role: "action", onClick: () => answer("join") },
        { text: q ? hostSheetAlways(q.host) : "", role: "action", onClick: () => answer("always") },
        { text: HOST_SHEET_CANCEL, role: "reject", onClick: () => answer("cancel") },
      ]}
    >
      {q && (
        <p className={s.body} data-call-host={q.host}>
          This call runs on <b>{q.host}</b>, not on your server. Joining gives {q.host} your IP address and a sign-in proof
          that says you are {q.me} (valid for up to an hour). What you say and show stays end-to-end encrypted. Started by{" "}
          {q.advertiserName || q.advertiser} ({q.advertiser}).
        </p>
      )}
    </Dialog>
  );
}
