// OptIn.tsx — the one-time line (GAMES-V1-SPEC.md §2.2, the opt-in rule): "Tin Hat counts your time in
// calls on <server> to give you play chips. They're play money only." OK = the wallet is made (and only then is
// anything counted); Not now = nothing is made, nothing is counted. Mounted once as an overlay.
import { useSpaceName } from "./space";
import { Button, Dialog } from "@/ui";
import { optInLine, w } from "./rules";
import { answerOptIn, usePlay } from "./store";
import s from "./OptIn.module.css";

export function OptInHost() {
  const ask = usePlay((x) => x.ask);
  return ask ? <OptIn owner={ask.owner} space={ask.space} /> : null;
}

function OptIn({ owner, space }: { owner: string; space: string }) {
  const name = useSpaceName(space);
  const ask = { owner, space };
  return (
    <Dialog
      open
      title={w("optin.title")}
      onClose={() => void answerOptIn(ask.owner, ask.space, false)}
      closeOnOutside={false}
      width={420}
      buttons={[
        { text: "OK", role: "accept", onClick: () => void answerOptIn(ask.owner, ask.space, true), render: ({ onClick }) => <Button highlighted className={s.ok} text={w("optin.ok")} onClick={onClick} data-testid="play-optin-ok" /> },
        { text: w("optin.not_now"), role: "reject", onClick: () => void answerOptIn(ask.owner, ask.space, false) },
      ]}
    >
      <div className={s.body} data-testid="play-optin">
        <p className={s.line}>{optInLine(name)}</p>
        <p className={s.small}>{w("optin.small", { space: name, owner })}</p>
      </div>
    </Dialog>
  );
}
