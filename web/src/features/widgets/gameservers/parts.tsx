// gameservers/parts.tsx — pieces of the Game servers widget that Up next and the calendar card reuse (docs/GAMESERVERS.md
// §4–§5): the state dot, the "LAN only" chip, the join row (address + masked password, copy buttons), the one-line server
// line of a linked calendar event, and the power flow (the plan → confirm / switch dialog → POST → toast).
import { useState } from "react";
import { toast } from "@/core/bus";
import { Button, ConfirmDialog, Dialog, Icon, cx } from "@/ui";
import { chipOf, confirmOf, planStart, type Confirm, type GameServer, type GameStatus, type PowerAction } from "@/widgets/gameservers";
import { powerAction } from "./store";
import s from "./GameServers.module.css";

export function StateDot({ sv, className }: { sv: GameServer; className?: string }) {
  return <span className={cx(s.dot, className)} data-tone={chipOf(sv).tone} aria-hidden="true" />;
}

export function Bar({ pm, label, value }: { pm: number; label: string; value: string }) {
  return (
    <span className={s.barBox} title={`${label} ${value}`}>
      <span className={s.barLabel}>{label}</span>
      <span className={s.bar}>
        <span className={s.barFill} data-high={pm >= 900 ? "" : undefined} style={{ width: `${pm / 10}%` }} />
      </span>
      <span className={s.barValue}>{value}</span>
    </span>
  );
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast(`Couldn't copy the ${what}`, { kind: "error" });
  }
}

export function IconBtn({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={s.iconBtn}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-no-drag=""
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} size={14} color="currentColor" staticOnly />
    </button>
  );
}

export function JoinRow({ sv, preview }: { sv: GameServer; preview: boolean }) {
  const [shown, setShown] = useState(false);
  const pw = sv.join.password;
  return (
    <div className={s.join}>
      <span className={s.address} title={sv.join.address}>
        {sv.join.address}
      </span>
      <IconBtn icon="edit-copy-symbolic" label="Copy address" disabled={preview} onClick={() => void copy(sv.join.address, "address")} />
      <span className={s.joinGap} />
      {pw === null ? (
        <span className={s.noPw}>No password</span>
      ) : (
        <>
          <span className={s.password} data-shown={shown ? "" : undefined} title={shown ? pw : "Password"}>
            {shown ? pw : "••••••"}
          </span>
          <IconBtn icon={shown ? "view-hidden-symbolic" : "view-visible-symbolic"} label={shown ? "Hide password" : "Show password"} disabled={preview} onClick={() => setShown((x) => !x)} />
          <IconBtn icon="edit-copy-symbolic" label="Copy password" disabled={preview} onClick={() => void copy(pw, "password")} />
        </>
      )}
    </div>
  );
}

export function LanChip({ long }: { long?: boolean }) {
  return (
    <span className={s.lan} title="People outside this network can't join — ask the server's owner to open the ports">
      {long ? "Ports closed — LAN only" : "LAN only"}
    </span>
  );
}

// ---- power flows ----------------------------------------------------------------------------------------------------

type Dlg = { kind: "confirm"; action: PowerAction; id: string; first: string | null; c: Confirm } | { kind: "switch"; id: string; running: string[] };

export function usePower(st: GameStatus | null) {
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [busy, setBusy] = useState<Record<string, true>>({});
  const send = async (action: PowerAction, id: string, first: string | null) => {
    setBusy((b) => ({ ...b, [id]: true, ...(first ? { [first]: true } : {}) }));
    const r = await powerAction(action, id, first);
    setBusy((b) => {
      const n = { ...b };
      delete n[id];
      if (first) delete n[first];
      return n;
    });
    if (!r.ok) toast(r.error ?? "The game server didn't answer", { kind: "error" });
  };
  const run = (action: PowerAction, id: string) => {
    if (!st) return;
    if (action === "start") {
      const p = planStart(st, id);
      if (p.kind === "unknown") return toast("No such game server", { kind: "error" });
      if (p.kind === "refused" || p.kind === "memory") return toast(p.text, { kind: "error" });
      if (p.kind === "cap") return setDlg({ kind: "switch", id, running: p.running });
    }
    const c = confirmOf(st, action, id);
    if (c) setDlg({ kind: "confirm", action, id, first: null, c });
    else void send(action, id, null);
  };
  const dialogs = (
    <>
      {dlg?.kind === "confirm" && (
        <ConfirmDialog
          open
          onClose={() => setDlg(null)}
          dialogTitle={dlg.c.title}
          message={dlg.c.body}
          confirmText={dlg.c.confirm}
          destructive={dlg.c.destructive}
          onConfirmed={() => void send(dlg.action, dlg.id, dlg.first)}
        />
      )}
      {dlg?.kind === "switch" && st && <SwitchDialog st={st} id={dlg.id} running={dlg.running} onClose={() => setDlg(null)} onPick={(first) => void send("start", dlg.id, first)} />}
    </>
  );
  return { run, busy, dialogs };
}

/** "Two games are already running": one button per running server — "Stop X and start Y". */
export function SwitchDialog({ st, id, running, onClose, onPick }: { st: GameStatus; id: string; running: string[]; onClose: () => void; onPick: (first: string) => void }) {
  const target = st.servers.find((x) => x.id === id);
  if (!target) return null;
  return (
    <Dialog open onClose={onClose} title="Two games are already running" width="min(420px, calc(100vw - 36px))" standardButtons={["cancel"]}>
      <div className={s.switchBody}>
        <div className={s.switchLead}>Stop one to start {target.name}:</div>
        {running.map((fid) => {
          const f = st.servers.find((x) => x.id === fid);
          if (!f) return null;
          const c = confirmOf(st, "start", id, fid);
          const n = f.state === "running" && f.players ? f.players.count : 0;
          return (
            <div key={fid} className={s.switchRow}>
              <Button
                className={s.switchBtn}
                text={c?.confirm ?? `Stop ${f.name} and start ${target.name}`}
                icon="media-playback-stop-symbolic"
                onClick={() => {
                  onClose();
                  onPick(fid);
                }}
              />
              {n > 0 && <div className={s.switchNote}>{n === 1 ? "1 person is" : `${n} people are`} on {f.name}</div>}
            </div>
          );
        })}
        {!target.outside && <div className={s.switchNote}>Ports closed — LAN only: people outside this network can't join (ask the server's owner to open them).</div>}
      </div>
    </Dialog>
  );
}


/** A linked server in one line (Up next's hero, the calendar card): the state dot, the chip text, the join address with
 *  a copy button and, when there is one, a copy button for the password (docs/GAMESERVERS.md §5). */
export function ServerLine({ sv, preview, className }: { sv: GameServer; preview?: boolean; className?: string }) {
  const pw = sv.join.password;
  return (
    <span className={`${s.serverLine} ${className ?? ""}`} data-no-drag="" title={`${sv.name} · ${chipOf(sv).text}`}>
      <StateDot sv={sv} />
      <span className={s.serverChip}>{chipOf(sv).text}</span>
      <span className={s.serverSep}>·</span>
      <span className={s.serverAddr}>{sv.join.address}</span>
      <IconBtn icon="edit-copy-symbolic" label="Copy address" disabled={preview} onClick={() => void copy(sv.join.address, "address")} />
      {pw !== null && <IconBtn icon="lock-symbolic" label="Copy password" disabled={preview} onClick={() => void copy(pw, "password")} />}
    </span>
  );
}
