// GamesPane.tsx — Settings → Games (GAMES-V1-SPEC rev 2 §2.2–§2.4): my chips in each space I've played in (the spaces
// each owner I'm signed in to lists for me: our own server first, then any other owner this session talked to), how
// earning works, and "Delete my chips in <space>" (refused while anything of mine is in play there; the confirmation
// says what stays: unnamed book entries, chat cards; coming back within 30 days starts at 0).
import { useEffect, useState } from "react";
import { useSpaceName } from "./space";
import { Avatar, Button, ConfirmDialog } from "@/ui";
import { useRoomAvatar } from "@/core/matrix";
import { Card, Hint, Row, Section } from "@/features/settings/rows";
import { Chips } from "./bits";
import { artVars } from "./art";
import { codeWords } from "./wire";
import { w } from "./rules";
import { conn, deleteChips, ownServer, playFeatures, refreshMe, usePlay, wkey } from "./store";

export function GamesPane() {
  const own = ownServer();
  const owners = usePlay((x) => x.owners);
  const [ownPlays, setOwnPlays] = useState<boolean | null>(null);
  useEffect(() => {
    if (!own) return;
    void playFeatures(own).then((f) => {
      setOwnPlays(f.play);
      // signing in to our own server lists the spaces where I have chips
      if (f.play) void conn(own).then((c) => c?.ensureSession());
    });
  }, [own]);
  const rows: { owner: string; space: string }[] = [];
  for (const [owner, o] of Object.entries(owners).sort(([a], [b]) => (a === own ? -1 : b === own ? 1 : a < b ? -1 : 1))) for (const space of o.wallets ?? []) rows.push({ owner, space });
  return (
    <div style={artVars()} data-testid="settings-games">
      <Section title={w("chip.new")} hint="Texas Hold'em and The Rig, played in calls. Play chips are play money only: they can't be bought, sold, cashed out or sent anywhere. Each space has its own chips, kept by the server the space was made on.">
        {rows.length === 0 && <Hint>{ownPlays === false ? `${own} doesn't run games.` : w("settings.none")}</Hint>}
        {rows.map((r) => (
          <SpaceChips key={wkey(r.owner, r.space)} owner={r.owner} space={r.space} />
        ))}
      </Section>
      <Section title={w("settings.how_title")}>
        <Card>
          <Row label={w("settings.how_earning_label")} description={w("settings.how_earning")} />
          <Row label={w("settings.how_broke_label")} description={w("settings.how_broke")} />
          <Row label={w("settings.how_cap_label")} description={w("settings.how_cap")} />
        </Card>
      </Section>
    </div>
  );
}

function SpaceChips({ owner, space }: { owner: string; space: string }) {
  const known = useSpaceName(space);
  const avatar = useRoomAvatar(space);
  // never a raw id: a space this device doesn't hold is "a space on <owner>"
  const name = known && known !== space ? known : w("settings.a_space_on", { owner });
  const wal = usePlay((x) => x.wallets[wkey(owner, space)]?.wallet ?? null);
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    void refreshMe(owner, space);
  }, [owner, space]);
  return (
    <Card>
      <Row
        id={`games.chips.${space}`}
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Avatar name={name} seed={space} size={22} imageSource={avatar} />
            {w("settings.chips_in_name", { space: name })}
          </span>
        }
        description={wal ? w("settings.space_line", { owner, rank: wal.rank, cap: wal.cap, n: wal.earned_today, max: wal.day_max }) : w("settings.asking", { owner })}
        control={wal ? <Chips n={wal.balance} big /> : null}
      />
      <Row
        id={`games.delete.${space}`}
        label={w("settings.delete", { space: name })}
        labelTone="danger"
        description={w("settings.delete_desc")}
        control={<Button text={w("settings.delete_button")} onClick={() => (setErr(""), setAsk(true))} data-testid="games-delete" />}
      />
      {err && <Hint tone="danger">{err}</Hint>}
      <ConfirmDialog
        open={ask}
        onClose={() => setAsk(false)}
        dialogTitle={w("settings.delete_title")}
        message={w("settings.delete_body", { space: name })}
        confirmText={w("settings.delete_confirm")}
        cancelText="Cancel"
        destructive
        onConfirmed={() =>
          void deleteChips(owner, space).then((code) => {
            setAsk(false);
            if (code) setErr(codeWords(code));
          })
        }
      />
    </Card>
  );
}
