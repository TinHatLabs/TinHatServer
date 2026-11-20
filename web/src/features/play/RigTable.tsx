// RigTable.tsx — The Rig at one table (GAMES-V1-SPEC rev 2 §5, the frozen contract's rig views): the machine (three
// reels, the spin counter, the bankroll, the live dial), the Rule Board (open / dead / busted / wrongly called cards),
// the history strip with its stamps, the Spinner's controls (dial 1–3, SPIN, Call a card, Audit a spin, Walk), and the
// House secret panel (my card and its bite, Mute, Nudge, Whisper, Peek, the Market, Patch) which folds away while I
// share my screen. Only what the round's preset allows is offered (`round.features`). The reveal shows every card with
// its owner, the Whispers with authors and the seed; the table's end shows the leaderboard and the Pit Boss. Every
// number and role is the server's; people who deleted their chips show as "someone".
import { useEffect, useState } from "react";
import { useCallStore } from "@/features/calls";
import { Button, ConfirmDialog, Icon, Switch, cx, useIsMobile } from "@/ui";
import { whisperAlone } from "@/features/prestige/clientRules";
import { Chips, PlayerAvatar, PlayerName, TableNote, myId, useNow } from "./bits";
import { RigSymbolArt } from "./RigArt";
import { CLOSED_WORDS, WHISPER_ALONE, isSomeone, PAYTABLE, RIG_PHASE_WORDS, RIG_ROLE_WORDS, STAMP_WORDS, WHISPER_TEMPLATES, rigCard, secondsLeft, whisperOk, w } from "./rules";
import { actOn, createTable, openGameWindow, type OpenView } from "./store";
import type { RigBoardCard, RigRound, RigSymbol, RigView, RigWhisper } from "./wire";
import s from "./Rig.module.css";

function useFocused(): boolean {
  const [f, setF] = useState(() => (typeof document !== "undefined" ? document.hasFocus() : true));
  useEffect(() => {
    const on = () => setF(true),
      off = () => setF(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return f;
}

/** A person in a reveal / leaderboard: a name, or "someone" for a deleted wallet (`~1`). */
function Who({ u, roomId }: { u: string; roomId: string }) {
  return isSomeone(u) ? <span className={s.muted}>{w("rig.someone")}</span> : <PlayerName mxid={u} roomId={roomId} />;
}

function whisperWords(wh: RigWhisper, nameOf: (u: string) => string): string {
  if (wh.text) return wh.text;
  const t = wh.template ? WHISPER_TEMPLATES[wh.template] : "";
  return (t ?? "").replace("{person}", wh.person ? nameOf(wh.person) : w("rig.someone"));
}
const localpart = (u: string) => u.replace(/^@([^:]+):.*$/, "$1");

/** `pad` (§5.4, the Pad on a phone): only my part — the House secret panel, or for the Spinner the dial, SPIN, Calls,
 *  Audit and Walk; the computer stays the big screen with the reels. */
export function RigTable({ ov, roomId, dial, pad, titled = true }: { ov: OpenView & { view: RigView }; roomId: string; dial?: number; pad?: boolean; titled?: boolean }) {
  const v = ov.view;
  const me = myId();
  const mobile = useIsMobile();
  const now = useNow(1000);
  const r = v.round;
  const y = v.you;
  const isHost = v.host === me;
  const seated = v.players.some((p) => p.u === me && !p.left); // the roster decides (a view without `you` must not show Join beside my own seat)
  const left = r?.deadline ? secondsLeft(r.deadline, v.now, ov.seenAt, now) : 0;
  const role = y ? (y.role ?? "lobby") : "spectator";
  const [closeAsk, setCloseAsk] = useState(false);
  const sharing = useCallStore((x) => x.sharing);
  const phaseWord = r ? (r.paused ? RIG_PHASE_WORDS.paused : RIG_PHASE_WORDS[r.phase]) : "";

  return (
    <div className={cx(s.root, mobile && s.mobile)} data-testid="rig-table" data-phase={r?.phase ?? v.status} data-role={role} data-table={v.table}>
      <div className={s.bar}>
        <div className={s.title}>
          {titled && <span className={s.game}>{w("games.rig")}</span>}
          <span className={s.meta}>
            {r ? `Round ${r.r} · ${r.preset === "full" ? w("rig.full") : w("rig.lite")} · ${phaseWord}` : v.status === "end" ? w("rig.phases.end") : w("rig.phases.lobby")}
            {r && left > 0 && !r.paused ? ` · ${left}s` : ""}
          </span>
        </div>
        <div className={s.barActions}>
          {seated && v.status !== "lobby" && v.status !== "end" && <span className={cx(s.roleBadge, s[`role_${role}`])}>{RIG_ROLE_WORDS[role] ?? role}</span>}
          {!seated && v.status === "lobby" && <Button highlighted text={w("rig.join")} onClick={() => void actOn(v, { do: "join" })} data-testid="rig-join" />}
          {seated && <Button flat text={w("table.leave_table")} onClick={() => void actOn(v, { do: "leave" })} data-testid="rig-leave" />}
          {isHost && v.status !== "closed" && <Button flat text={w("table.close")} onClick={() => setCloseAsk(true)} />}
          <ConfirmDialog open={closeAsk} onClose={() => setCloseAsk(false)} dialogTitle={w("rig.close_title")} message={w("rig.close_body")} confirmText={w("table.close")} destructive onConfirmed={() => void actOn(v, { do: "close" })} />
        </div>
      </div>
      <div className={s.body}>
        <TableNote table={v.table} />
        {v.status === "closed" ? (
          <div className={s.lobby}>{CLOSED_WORDS[v.closed?.reason ?? "end"]}</div>
        ) : v.status === "end" ? (
          <Leaderboard v={v} roomId={roomId} isHost={isHost} onClose={() => setCloseAsk(true)} />
        ) : v.status === "lobby" || !r ? (
          <Lobby v={v} roomId={roomId} isHost={isHost} />
        ) : pad ? (
          <div className={s.padCol} data-testid="rig-pad">
            {y?.role === "spinner" ? <Machine v={v} r={r} roomId={roomId} dial={dial} compact /> : y?.role && r.phase !== "reveal" ? <SecretPanel v={v} r={r} roomId={roomId} pad /> : <div className={s.statusLine}>{phaseWord}</div>}
            {r.phase === "reveal" && r.reveal && <Reveal r={r} roomId={roomId} />}
          </div>
        ) : (
          <div className={s.columns}>
            <div className={s.mainCol}>
              <Machine v={v} r={r} roomId={roomId} dial={dial} />
              {r.phase === "reveal" && r.reveal ? <Reveal r={r} roomId={roomId} /> : <History r={r} />}
              <RuleBoard v={v} r={r} />
            </div>
            <div className={s.sideCol}>
              <People v={v} roomId={roomId} />
              {y && y.role && y.role !== "spinner" && y.role !== "railbird" && r.phase !== "reveal" && <SecretPanel v={v} r={r} roomId={roomId} />}
              {y?.role === "railbird" && r.phase !== "reveal" && <RailbirdPanel v={v} r={r} roomId={roomId} />}
              {y?.role === "spinner" && !sharing && (y.whispers?.length ?? 0) > 0 && (
                <div className={s.panel} data-testid="rig-whispers">
                  <div className={s.panelHead}>{w("rig.whispers_to_you")}</div>
                  {y.whispers!.map((w, i) => (
                    <div key={i} className={s.whisper}>
                      “{whisperWords(w, localpart)}” <span className={s.muted}>· spin {w.spin}</span>
                    </div>
                  ))}
                </div>
              )}
              <Paytable />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Lobby({ v, roomId, isHost }: { v: RigView; roomId: string; isHost: boolean }) {
  const [preset, setPreset] = useState<"lite" | "full">(v.opts.preset);
  const [bankroll, setBankroll] = useState(v.opts.bankroll);
  const [patch, setPatch] = useState(v.opts.patch);
  const players = v.players.filter((p) => !p.left);
  const n = players.length;
  const lite = preset === "lite" || n <= 3;
  return (
    <div className={s.lobby} data-testid="rig-lobby">
      <div className={s.lobbyHead}>
        <div className={s.lobbyTitle}>{w("rig.lobby_title")}</div>
        <div className={s.lobbySub}>{w("rig.lobby_sub")}</div>
      </div>
      <div className={s.lobbyPeople}>
        {players.map((p) => (
          <div key={p.u} className={cx(s.lobbyPerson, !p.connected && s.lobbyEmpty)}>
            {isHost && p.u !== v.host && (
              <button type="button" className={s.kick} onClick={() => void actOn(v, { do: "kick", u: p.u })} aria-label={`Remove ${p.u.replace(/^@([^:]+):.*$/, "$1")} from the table`} data-testid="rig-kick">
                <Icon name="window-close-symbolic" size={10} color="var(--th-text-secondary)" />
              </button>
            )}
            <PlayerAvatar mxid={p.u} roomId={roomId} size={40} />
            <PlayerName mxid={p.u} roomId={roomId} className={s.lobbyName} />
          </div>
        ))}
        {[...Array(Math.max(0, 3 - n))].map((_, i) => (
          <div key={`e${i}`} className={cx(s.lobbyPerson, s.lobbyEmpty)}>
            <span className={s.emptyDot} />
            <span className={s.lobbyName}>{w("rig.open_seat")}</span>
          </div>
        ))}
      </div>
      {isHost ? (
        <div className={s.startBox}>
          <div className={s.optRow}>
            <span className={s.optLabel}>{w("rig.machine")}</span>
            <div className={s.seg}>
              <button type="button" className={cx(s.segBtn, lite && s.segOn)} onClick={() => setPreset("lite")}>
                {w("rig.lite")}
              </button>
              <button type="button" className={cx(s.segBtn, !lite && s.segOn)} disabled={n <= 3} onClick={() => setPreset("full")} title={n <= 3 ? w("rig.full_needs") : ""}>
                {w("rig.full")}
              </button>
            </div>
          </div>
          <div className={s.optRow}>
            <span className={s.optLabel}>{w("rig.bankroll_label")}</span>
            <div className={s.stepper}>
              <button type="button" className={s.stepBtn} aria-label="Less" disabled={bankroll <= 3} onClick={() => setBankroll((b) => Math.max(3, b - 1))}>
                −
              </button>
              <Chips n={bankroll} big />
              <button type="button" className={s.stepBtn} aria-label="More" disabled={bankroll >= 10} onClick={() => setBankroll((b) => Math.min(10, b + 1))}>
                +
              </button>
            </div>
          </div>
          {!lite && (
            <div className={s.optRow}>
              <span className={s.optLabel}>{w("rig.patch_option")}</span>
              <Switch checked={patch} onToggled={setPatch} text={w("rig.patch_explain")} />
            </div>
          )}
          <Button highlighted className={s.startBtn} text={n < 3 ? `Needs ${3 - n} more` : w("rig.start_first")} disabled={n < 3} onClick={() => void actOn(v, { do: "start", preset: lite ? "lite" : "full", bankroll, patch })} data-testid="rig-start" />
        </div>
      ) : (
        <div className={s.lobbyWait}>{n < 3 ? `Waiting for ${3 - n} more player${3 - n === 1 ? "" : "s"}` : w("rig.wait_host")}</div>
      )}
    </div>
  );
}

function Reel({ sym, spinning, idx, nudge }: { sym: RigSymbol | null; spinning: boolean; idx: number; nudge?: (step: 1 | -1) => void }) {
  return (
    <div className={s.reelBox}>
      {nudge && (
        <button type="button" className={s.nudgeBtn} onClick={() => nudge(-1)} aria-label={`Nudge reel ${idx + 1} back`} data-testid={`rig-nudge-${idx + 1}-back`}>
          <Icon name="go-up-symbolic" size={16} color="var(--th-accent-bright)" />
        </button>
      )}
      <div className={cx(s.reel, spinning && s.reelSpin)} data-testid={`rig-reel-${idx + 1}`} data-sym={sym ?? ""}>
        <div className={s.reelGlass} />
        {sym ? <RigSymbolArt sym={sym} size={64} /> : <span className={s.reelBlank}>?</span>}
      </div>
      {nudge && (
        <button type="button" className={s.nudgeBtn} onClick={() => nudge(1)} aria-label={`Nudge reel ${idx + 1} forward`} data-testid={`rig-nudge-${idx + 1}-fwd`}>
          <Icon name="go-down-symbolic" size={16} color="var(--th-accent-bright)" />
        </button>
      )}
    </div>
  );
}

function Machine({ v, r, roomId, dial, compact }: { v: RigView; r: RigRound; roomId: string; dial?: number; compact?: boolean }) {
  // the Audit result is the Spinner's alone: hidden while sharing the screen
  const sharingNow = useCallStore((x) => x.sharing);
  const y = v.you;
  const focused = useFocused();
  const spinner = y?.role === "spinner";
  const last = r.history[r.history.length - 1];
  const reels: (RigSymbol | null)[] = r.reels ?? last?.reels ?? [null, null, null];
  const spinning = r.phase === "spin" && focused;
  const net = r.bankroll.now - r.bankroll.start;
  const bet = r.bet ?? dial ?? r.dial;
  const canNudge = r.phase === "nudge" && !!r.nudge?.open && !spinner && (y?.nudge_left ?? 0) > 0;
  const nudge = (reel: number) => (step: 1 | -1) => void actOn(v, { do: "nudge", reel, step });
  const [mode, setMode] = useState<"" | "call" | "audit">("");
  useEffect(() => {
    if (r.phase !== "turn") setMode("");
  }, [r.phase]);
  const lastPay = r.phase === "payout" && last ? last.payout - last.bet : null;
  const canCall = r.calls_left > 0 && !r.call_used_this_spin && r.bankroll.now >= 2;
  return (
    <div className={s.machine} data-testid="rig-machine">
      <div className={s.machineTop}>
        <div className={s.spinnerTag}>
          <PlayerAvatar mxid={r.spinner} roomId={roomId} size={22} />
          <PlayerName mxid={r.spinner} roomId={roomId} className={s.spinnerName} />
          <span className={s.muted}>{w("rig.spins")}</span>
        </div>
        <div className={s.counter}>
          Spin <b>{Math.max(1, r.spin)}</b> of {r.spins}
        </div>
        <div className={s.bankroll} data-testid="rig-bankroll">
          <Chips n={r.bankroll.now} big />
          {net !== 0 && <span className={cx(s.net, net > 0 ? s.up : s.down)}>{net > 0 ? `+${net}` : `−${-net}`}</span>}
        </div>
      </div>
      <div className={cx(s.reels, compact && s.reelsCompact)}>
        {[0, 1, 2].map((i) => (
          <Reel key={i} idx={i} sym={reels[i] ?? null} spinning={spinning} nudge={canNudge ? nudge(i + 1) : undefined} />
        ))}
        {lastPay !== null && <div className={cx(s.payFlash, lastPay > 0 ? s.up : lastPay < 0 ? s.down : "")}>{lastPay > 0 ? `+${lastPay}` : lastPay === 0 ? w("rig.push") : `${lastPay}`}</div>}
      </div>
      {r.seed_commit && r.phase !== "reveal" && (
        <div className={s.seed} title={r.seed_commit} data-testid="rig-seed-commit">
          {w("rig.seed_commit")} {r.seed_commit.slice(0, 16)}…
        </div>
      )}
      {r.nudge && !r.nudge.open && r.nudge.reel && <div className={s.statusLine}>Someone nudged reel {r.nudge.reel}.</div>}
      {r.paused && <div className={s.statusLine}>Paused: the Spinner dropped out ({Math.ceil(r.paused.budget_ms / 1000)} s left before they walk).</div>}
      <div className={s.controls}>
        <div className={s.dial} role="radiogroup" aria-label={w("table.actions.bet")}>
          <span className={s.dialLabel}>{w("table.actions.bet")}</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={bet === n}
              className={cx(s.dialBtn, bet === n && s.dialOn)}
              disabled={!spinner || r.phase !== "turn" || n > r.bankroll.now}
              onClick={() => void actOn(v, { do: "dial", bet: n })}
              data-testid={`rig-dial-${n}`}
            >
              {n}
            </button>
          ))}
        </div>
        {spinner && r.phase === "turn" ? (
          <div className={s.spinnerActs}>
            <Button flat text={mode === "call" ? w("rig.pick_call") : `Call a card (${r.calls_left})`} disabled={!canCall} onClick={() => setMode((m) => (m === "call" ? "" : "call"))} data-testid="rig-call" />
            <Button flat text={mode === "audit" ? w("rig.pick_audit") : w("rig.audit")} disabled={r.audit_used || r.history.length === 0} onClick={() => setMode((m) => (m === "audit" ? "" : "audit"))} data-testid="rig-audit" />
            <Button flat text={w("rig.walk")} disabled={r.spin < r.walk_from} onClick={() => void actOn(v, { do: "walk" })} tip={r.spin < r.walk_from ? `You can walk from spin ${r.walk_from}` : w("rig.walk_tip")} data-testid="rig-walk" />
            <button type="button" className={s.spinBtn} onClick={() => void actOn(v, { do: "spin" })} data-testid="rig-spin">
              {w("rig.spin")}
            </button>
          </div>
        ) : (
          <div className={s.statusLine}>{spinner ? RIG_PHASE_WORDS[r.phase] : r.phase === "turn" ? w("rig.choosing") : RIG_PHASE_WORDS[r.phase]}</div>
        )}
      </div>
      {spinner && mode === "call" && <CallPicker v={v} r={r} onDone={() => setMode("")} />}
      {spinner && mode === "audit" && (
        <div className={s.pickRow}>
          {r.history.map((h) => (
            <button key={h.spin} type="button" className={s.pickChip} onClick={() => (setMode(""), void actOn(v, { do: "audit", spin: h.spin }))} data-testid={`rig-audit-${h.spin}`}>
              Spin {h.spin}
            </button>
          ))}
        </div>
      )}
      {spinner && r.audit && !sharingNow && (
        <div className={s.audit} data-testid="rig-audit-result">
          <span className={s.auditHead}>Audit of spin {r.audit.spin}</span>
          <span className={s.auditReels}>
            honest:
            {r.audit.honest_reels.map((x, i) => (
              <RigSymbolArt key={i} sym={x} size={20} />
            ))}
            pays {r.audit.honest_payout}
          </span>
          <span className={s.muted}>{r.audit.touched === 0 ? w("rig.touched_none") : `${r.audit.touched} card${r.audit.touched === 1 ? "" : "s"} touched it`}</span>
        </div>
      )}
    </div>
  );
}

function CallPicker({ v, r, onDone }: { v: RigView; r: RigRound; onDone: () => void }) {
  const open = r.board.filter((b) => b.state === "open");
  return (
    <div className={s.pickRow}>
      <span className={s.muted}>{w("rig.call_hint")}</span>
      {open.map((b) => (
        <button key={b.card} type="button" className={s.pickChip} onClick={() => (onDone(), void actOn(v, { do: "call", card: b.card }))} data-testid={`rig-call-${b.card}`}>
          {rigCard(b.card)?.name ?? b.card}
        </button>
      ))}
    </div>
  );
}

function History({ r }: { r: RigRound }) {
  return (
    <div className={s.history} style={{ ["--spins" as string]: r.spins }} data-testid="rig-history">
      {[...Array(r.spins)].map((_, i) => {
        const h = r.history.find((x) => x.spin === i + 1);
        return (
          <div key={i} className={cx(s.hItem, h && s[`h_${h.result}`], !h && s.hEmpty)} title={h ? `Spin ${h.spin}: bet ${h.bet}, paid ${h.payout}` : `Spin ${i + 1}`}>
            <span className={s.hN}>{i + 1}</span>
            {h ? (
              <>
                <span className={s.hReels}>
                  {h.reels.map((x, k) => (
                    <RigSymbolArt key={k} sym={x} size={16} />
                  ))}
                </span>
                <span className={s.hPay}>
                  {h.bet}→{h.payout}
                </span>
                {h.stamps.length > 0 && (
                  <span className={s.hStamp}>
                    {h.stamps.map((x) => (
                      <span key={x}>{STAMP_WORDS[x] ?? x}</span>
                    ))}
                  </span>
                )}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function BoardCard({ b, mine }: { b: RigBoardCard; mine?: boolean }) {
  const c = rigCard(b.card);
  return (
    <div className={cx(s.rCard, s[`rc_${b.state}`], mine && s.rcMine)} data-testid={`rig-board-${b.card}`} data-state={b.state}>
      <div className={s.rcHead}>
        <span className={s.rcName}>{c?.name ?? b.card}</span>
        <span className={s.rcBite} title={`Bite ${c?.bite ?? "?"}`}>
          {"●".repeat(c?.bite ?? 0)}
        </span>
      </div>
      <div className={s.rcRule}>{c?.rule}</div>
      <div className={s.rcFoot}>
        <span>{c?.kind === "reel" ? w("rig.reel_card") : w("rig.payout_card")}</span>
        {c?.tax && <span className={s.rcTax}>{w("rig.tax")}</span>}
        {b.state !== "open" && <span className={s.rcState}>{b.state === "dead" ? w("rig.out") : b.state === "busted" ? `Busted${b.spin ? ` on spin ${b.spin}` : ""}` : w("rig.stamps.called-wrong")}</span>}
      </div>
    </div>
  );
}

function RuleBoard({ v, r }: { v: RigView; r: RigRound }) {
  // my card is marked on the public board only while I'm not sharing my screen
  const sharing = useCallStore((x) => x.sharing);
  const mine = sharing ? undefined : v.you?.card?.card;
  return (
    <div className={s.boardWrap}>
      <div className={s.panelHead}>
        {w("rig.rule_board")} <span className={s.muted}>· {r.mechanics} live · {r.board.filter((b) => b.state === "open").length} could be</span>
        {r.refilled.length > 0 && <span className={s.muted}> · slot refilled on spin {r.refilled.map((x) => x.spin).join(", ")}</span>}
      </div>
      <div className={s.ruleBoard}>
        {r.board.map((b) => (
          <BoardCard key={b.card} b={b} mine={b.card === mine} />
        ))}
      </div>
    </div>
  );
}

function People({ v, roomId }: { v: RigView; roomId: string }) {
  const net = v.round?.reveal?.net;
  return (
    <div className={s.panel}>
      <div className={s.panelHead}>At the table{v.spectators > 0 ? ` · ${v.spectators} watching` : ""}</div>
      {v.players
        .filter((p) => !p.left)
        .map((p) => (
          <div key={p.u} className={cx(s.person, !p.connected && s.offline)}>
            <PlayerAvatar mxid={p.u} roomId={roomId} size={24} />
            <PlayerName mxid={p.u} roomId={roomId} className={s.personName} />
            {p.role && <span className={cx(s.personRole, s[`role_${p.role}`])}>{RIG_ROLE_WORDS[p.role]}</span>}
            {net && net[p.u] !== undefined && <span className={cx(s.net, net[p.u]! > 0 ? s.up : net[p.u]! < 0 ? s.down : "")}>{net[p.u]! > 0 ? `+${net[p.u]}` : net[p.u]}</span>}
          </div>
        ))}
    </div>
  );
}

function SecretPanel({ v, r, roomId, pad }: { v: RigView; r: RigRound; roomId: string; pad?: boolean }) {
  const sharing = useCallStore((x) => x.sharing);
  const y = v.you!;
  const [text, setText] = useState("");
  const [peekTarget, setPeekTarget] = useState("");
  const [bluff, setBluff] = useState(false);
  if (sharing)
    return (
      <div className={cx(s.panel, s.secret)} data-testid="rig-secret" data-hidden="1">
        <div className={s.panelHead}>{w("rig.your_secrets")}</div>
        <div className={s.muted}>Hidden while you share your screen</div>
      </div>
    );
  const mech = y.role === "mechanic";
  const me = myId();
  const mechanics = v.players.filter((p) => p.role === "mechanic" && p.u !== me && !p.left);
  const others = v.players.filter((p) => p.u !== me && !p.left);
  const canWhisper = r.features.whisper && !y.whisper_used && r.phase === "turn";
  // the honest warning: with no OTHER connected House member, the Spinner will know it's me
  const alone = whisperAlone({ roster: v.players.map((p) => ({ u: p.u, role: p.role ?? "", connected: p.connected, left: p.left })), whisperer: me }).warn;
  const canPeek = y.role !== "railbird" && !!y.peek && !y.peek.placed && !r.peeks_locked && r.phase === "turn" && mechanics.length > 0;
  const canNudge = pad && r.phase === "nudge" && !!r.nudge?.open && (y.nudge_left ?? 0) > 0;
  return (
    <div className={cx(s.panel, s.secret, pad && s.secretPad)} data-testid="rig-secret">
      {canNudge && (
        <div className={s.padNudge} data-testid="rig-pad-nudge">
          <span className={s.panelHead}>NUDGE: the first tap wins</span>
          {[1, 2, 3].map((reel) => (
            <div key={reel} className={s.padNudgeRow}>
              <button type="button" className={s.padNudgeBtn} onClick={() => void actOn(v, { do: "nudge", reel, step: -1 })} aria-label={`Nudge reel ${reel} back`}>
                <Icon name="go-previous-symbolic" size={20} color="var(--th-accent-bright)" />
              </button>
              <span>Reel {reel}</span>
              <button type="button" className={s.padNudgeBtn} onClick={() => void actOn(v, { do: "nudge", reel, step: 1 })} aria-label={`Nudge reel ${reel} forward`}>
                <Icon name="go-next-symbolic" size={20} color="var(--th-accent-bright)" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={s.panelHead}>
        {w("rig.your_secrets")} <span className={s.muted}>· only you see this</span>
      </div>
      {mech && r.phase === "setup" && y.deal && !y.kept && (
        <div className={s.keep}>
          <span className={s.muted}>{w("rig.keep_one")}</span>
          <div className={cx(s.keepRow, s.keepStack)}>
            {y.deal.map((c) => (
              <button key={c} type="button" className={s.keepBtn} onClick={() => void actOn(v, { do: "keep", card: c })} data-testid={`rig-keep-${c}`}>
                <BoardCard b={{ card: c, state: "open" }} />
              </button>
            ))}
          </div>
        </div>
      )}
      {mech && y.card && (
        <div className={s.myCard}>
          <BoardCard b={{ card: y.card.card, state: "open" }} mine />
          <div className={s.mechRow}>
            {r.features.mutes && (
              <button type="button" className={cx(s.mute, y.armed && s.muteArmed)} disabled={r.phase !== "turn" || (!y.armed && (y.mutes_left ?? 0) <= 0)} onClick={() => void actOn(v, { do: "mute", armed: !y.armed })} data-testid="rig-mute">
                {y.armed ? "MUTE ARMED" : (y.mutes_left ?? 0) > 0 ? `MUTE (${y.mutes_left})` : w("rig.no_mutes")}
              </button>
            )}
            <span className={s.rake}>
              {w("rig.rake_label")} <Chips n={y.rake ?? 0} />
            </span>
          </div>
        </div>
      )}
      {mech && y.busted && (
        <div className={s.keep}>
          <span className={s.muted}>{w("rig.busted_note")}</span>
          {y.patch && (
            <Button highlighted text={`Patch: put ${rigCard(y.patch.card)?.name ?? y.patch.card} back (3 chips)`} disabled={!y.patch.ok} onClick={() => void actOn(v, { do: "patch" })} data-testid="rig-patch" />
          )}
        </div>
      )}
      {r.phase === "setup" && y.market !== undefined && !y.market_done && (
        <div className={s.market} data-testid="rig-market">
          <span className={s.muted}>{w("rig.market_ask")}</span>
          <div className={s.keepRow}>
            {(["up", "not-up"] as const).map((side) =>
              [1, 2].map((stake) => (
                <button key={`${side}${stake}`} type="button" className={cx(s.pickChip, y.market?.side === side && y.market.stake === stake && s.pickOn)} onClick={() => void actOn(v, { do: "market", side, stake })} data-testid={`rig-market-${side}-${stake}`}>
                  {side === "up" ? "UP" : w("rig.not_up")} · {stake}
                </button>
              )),
            )}
            <button type="button" className={s.pickChip} onClick={() => void actOn(v, { do: "market", side: "pass" })} data-testid="rig-market-pass">
              {w("rig.pass")}
            </button>
          </div>
        </div>
      )}
      {y.market && (r.phase !== "setup" || y.market_done) && (
        <div className={s.muted}>
          Market: {y.market.side === "up" ? "UP" : w("rig.not_up")} for {y.market.stake}
        </div>
      )}
      {canWhisper && (
        <div className={s.whisperBox}>
          <span className={s.muted}>{w("rig.whisper_label")}</span>
          {alone && (
            <span className={s.whisperAlone} role="note" data-testid="rig-whisper-alone">
              {WHISPER_ALONE}
            </span>
          )}
          <div className={s.keepRow}>
            {Object.entries(WHISPER_TEMPLATES).map(([id, t]) =>
              id === "bluffing" ? (
                <button key={id} type="button" className={cx(s.pickChip, bluff && s.pickOn)} onClick={() => setBluff((b) => !b)}>
                  {t.replace("{person}", w("rig.someone_cap"))}…
                </button>
              ) : (
                <button key={id} type="button" className={s.pickChip} onClick={() => void actOn(v, { do: "whisper", template: id })} data-testid={`rig-whisper-${id}`}>
                  {t}
                </button>
              ),
            )}
          </div>
          {bluff && (
            <div className={s.keepRow}>
              {others.map((p) => (
                <button key={p.u} type="button" className={s.pickChip} onClick={() => (setBluff(false), void actOn(v, { do: "whisper", template: "bluffing", person: p.u }))}>
                  <PlayerName mxid={p.u} roomId={roomId} /> is bluffing
                </button>
              ))}
            </div>
          )}
          <div className={s.whisperRow}>
            <input className={s.input} value={text} maxLength={60} placeholder={w("rig.whisper_placeholder")} onChange={(e) => setText(e.target.value)} data-testid="rig-whisper-text" />
            <Button text={w("rig.send")} disabled={!whisperOk(text)} onClick={() => (void actOn(v, { do: "whisper", text: text.trim() }), setText(""))} />
          </div>
        </div>
      )}
      {y.role !== "railbird" && y.peek && !y.peek.placed && (
        <div className={s.peekBox}>
          <span className={s.muted}>{r.peeks_locked ? w("rig.peeks_locked") : `Peek (2 chips): guess a Mechanic's card · locks after spin ${y.peek.locks_after}`}</span>
          {canPeek && (
            <div className={s.keepRow}>
              {mechanics.map((m) => (
                <button key={m.u} type="button" className={cx(s.pickChip, peekTarget === m.u && s.pickOn)} onClick={() => setPeekTarget(m.u)} data-testid="rig-peek-target">
                  <PlayerName mxid={m.u} roomId={roomId} />
                </button>
              ))}
            </div>
          )}
          {canPeek && peekTarget && (
            <div className={s.keepRow}>
              {r.board
                .filter((b) => b.state === "open")
                .map((b) => (
                  <button key={b.card} type="button" className={s.pickChip} onClick={() => (setPeekTarget(""), void actOn(v, { do: "peek", mechanic: peekTarget, card: b.card }))}>
                    {rigCard(b.card)?.name}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {y.peek?.placed && (
        <div className={s.muted}>
          Peek placed{y.peek.card ? `: ${rigCard(y.peek.card)?.name}` : ""}. It pays at the reveal.
        </div>
      )}
      {r.features.nudge && (y.nudge_left ?? 0) > 0 && <div className={s.muted}>{w("rig.nudge_note")}</div>}
    </div>
  );
}

function Reveal({ r, roomId }: { r: RigRound; roomId: string }) {
  const rv = r.reveal!;
  return (
    <div className={s.reveal} data-testid="rig-reveal">
      <div className={s.panelHead}>The reveal · the Spinner ended {rv.up ? "UP" : "not up"}</div>
      <div className={s.revealSlots}>
        {rv.slots.map((sl, i) => (
          <div key={`${sl.slot}-${i}`} className={s.revealSlot}>
            <BoardCard b={{ card: sl.card, state: "open" }} />
            <span className={s.revealOwner}>
              rigged by <Who u={sl.owner} roomId={roomId} />
              {sl.from_spin > 1 ? ` from spin ${sl.from_spin}` : ""}
            </span>
          </div>
        ))}
      </div>
      {(rv.mutes.length > 0 || rv.nudges.length > 0 || rv.calls.length > 0) && (
        <div className={s.revealList}>
          {rv.calls.map((c, i) => (
            <div key={`c${i}`} className={s.muted}>
              Spin {c.spin}: called {rigCard(c.card)?.name}: {c.right ? w("rig.right") : w("rig.wrong_word")}
            </div>
          ))}
          {rv.mutes.map((m, i) => (
            <div key={`m${i}`} className={s.muted}>
              Spin {m.spin}: <Who u={m.owner} roomId={roomId} /> muted their card
            </div>
          ))}
          {rv.nudges.map((n, i) => (
            <div key={`n${i}`} className={s.muted}>
              Spin {n.spin}: <Who u={n.by} roomId={roomId} /> nudged reel {n.reel} {n.step > 0 ? w("rig.forward") : w("rig.back")}
            </div>
          ))}
        </div>
      )}
      {rv.peeks.length > 0 && (
        <div className={s.revealList}>
          {rv.peeks.map((p, i) => (
            <div key={i} className={s.muted}>
              <Who u={p.who} roomId={roomId} /> peeked <Who u={p.target} roomId={roomId} />: {rigCard(p.card)?.name}, {p.right ? w("rig.right") : w("rig.wrong_word")} ({p.delta > 0 ? `+${p.delta}` : p.delta})
            </div>
          ))}
        </div>
      )}
      {rv.whispers.length > 0 && (
        <div className={s.revealList}>
          {rv.whispers.map((w, i) => (
            <div key={i} className={s.whisper}>
              <Who u={w.who} roomId={roomId} />: “{whisperWords(w, localpart)}”
            </div>
          ))}
        </div>
      )}
      {rv.seed && <div className={s.seed}>Seed {rv.seed}</div>}
    </div>
  );
}

function Leaderboard({ v, roomId, isHost, onClose }: { v: RigView; roomId: string; isHost: boolean; onClose: () => void }) {
  const rows = v.end?.leaderboard ?? [];
  const [busy, setBusy] = useState(false);
  // spec "Host: another table or close": a FRESH Rig table in this room with this one's options. The ended table still
  // counts as the room's Rig table (one per game per room) until it closes, so it is closed first, then the new one made.
  const newTable = async () => {
    setBusy(true);
    try {
      const ack = await actOn(v, { do: "close" });
      if (ack.ok || ack.code === "closed" || ack.code === "no-table") await createTable(roomId, "rig", { preset: v.opts.preset, bankroll: v.opts.bankroll, patch: v.opts.patch });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx(s.lobby, s.endWrap)} data-testid="rig-end">
      <div className={s.lobbyTitle}>{w("rig.everyone_spun")}</div>
      <div className={s.leaders}>
        {rows.map((row, i) => (
          <div key={row.u} className={cx(s.leader, v.end?.pit_boss === row.u && s.leaderTop)}>
            <span className={s.leaderN}>{i + 1}</span>
            {isSomeone(row.u) ? <span className={s.emptyDot} /> : <PlayerAvatar mxid={row.u} roomId={roomId} size={28} />}
            <span className={s.personName}>
              <Who u={row.u} roomId={roomId} />
            </span>
            <span className={cx(s.net, row.net > 0 ? s.up : row.net < 0 ? s.down : "")}>{row.net > 0 ? `+${row.net}` : row.net}</span>
            {v.end?.pit_boss === row.u && <span className={s.pitBoss}>{w("rig.pit_boss")}</span>}
          </div>
        ))}
      </div>
      {isHost ? (
        <div className={s.endActions}>
          <Button highlighted text={w("rig.new_table")} disabled={busy} onClick={() => void newTable()} data-testid="rig-end-new" />
          <Button flat text={w("table.close")} disabled={busy} onClick={onClose} data-testid="rig-end-close" />
        </div>
      ) : (
        <Button highlighted text={w("lobby.closed_back")} onClick={() => openGameWindow(roomId, null)} data-testid="rig-end-back" />
      )}
    </div>
  );
}

/** A Railbird: no secret card, just what's theirs this round (a Nudge, a Whisper). */
function RailbirdPanel({ v, r, roomId }: { v: RigView; r: RigRound; roomId: string }) {
  const y = v.you!;
  if (!r.features.whisper && !r.features.nudge) return null;
  if (y.whisper_used && (y.nudge_left ?? 0) === 0) return null;
  return <SecretPanel v={v} r={r} roomId={roomId} />;
}

function Paytable() {
  return (
    <div className={s.panel}>
      <div className={s.panelHead}>{w("rig.pays_head")}</div>
      {PAYTABLE.map((p) => (
        <div key={p.what} className={s.payRow}>
          <span>{p.what}</span>
          <b>{p.pays}</b>
        </div>
      ))}
    </div>
  );
}
