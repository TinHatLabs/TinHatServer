// GameReelPanel.tsx — GameReelPanel.qml (CAL-70..85): header (session, "N here · M more coming" —
// 10.5.1 open roster; the stricter presence modes keep "N of M here" — people here + RSVP'd avatars, My games / Tune), error line, My games editor, Tune panel, the reel (strip of covers,
// centre markers, eased spin with ticks + landing sound + winner pulse), controls (Spin / Re-spin
// / Veto, re-spins left, notice, race/void note, unverified), the result panel, the three tier
// lists and the Past nights log. 10.5.2: "Free spins" in the controls when settings credits.mode is
// "free"; "not counted for credit" on the result / a log line, and for admins "Don't count for
// credit" / "Count for credit" there (the record keeps its result — only credit ignores it). Phones: the same column, covers stay 132 px (the strip clips),
// header wraps, the editor/admin grids collapse to one column.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Avatar, ConfirmDialog, EmptyState, animate, cx, useAnimate, useIsMobile, localpart } from "@/ui";
import { ScrollArea } from "@/ui";
import { playUiSound } from "@/core/sounds";
import { useGames, clearError, resetSpins, respin, setSpinCredit, spin as doSpin, veto } from "../gamesStore";
import type { ReelGame, Snapshot } from "../model/reel";
import { fmtDMon, fmtReelDay, fmtTime } from "../model/calendar";
import { ReelButton, ReelCover, TierList, Art, art } from "./ReelParts";
import { MyGamesEditor } from "./MyGamesEditor";
import { GameNightAdmin } from "./GameNightAdmin";
import s from "./Reel.module.css";

const COVER_W = 132;
const COVER_GAP = 14;
const PITCH = COVER_W + COVER_GAP;
const outCubic = (t: number) => 1 - Math.pow(1 - t, 3);
/** "<spin id>|<winner>" pairs that already rolled in this app session. */
const landedKeys = new Set<string>();


function allGames(snap: Snapshot | null): ReelGame[] {
  if (!snap) return [];
  return [...snap.tiers.main, ...snap.tiers.stretch, ...snap.tiers.removed];
}

export function GameReelPanel() {
  const snap = useGames((x) => x.snap);
  const busy = useGames((x) => x.busy);
  const spinningWrite = useGames((x) => x.spinning);
  const lastError = useGames((x) => x.lastError);
  const isAdmin = useGames((x) => x.isAdmin);
  // GPU.md §1: the spin rolls only while the motion switch is on (focused, no Reduce motion); otherwise — and the
  // moment the window loses the focus mid-roll — the reel jumps to its result
  const reduced = !useAnimate();
  const mobile = useIsMobile();
  const [showEditor, setShowEditor] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  // Admin "Reset spins" (2026-09-23: an admin hit the re-spin limit while testing and had no way back).
  // Voids tonight's spins and stops their re-spins counting (gamesStore.resetSpins / model resetWrites)
  // in a form every client already reads — desktop 10.5.0 / 10.5.1 included: the result clears, Spin is
  // enabled, and the next spin starts with the full re-spin + veto allowance. (Tune's "Void tonight's spin"
  // only voids the standing record, which falls back to the previous result with the count unchanged.)
  // Shown next to the count while a result stands, and also when nothing stands but used re-spins still
  // count (Tune voids, or a reset that failed half-way) — so there is always a way back.
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const session = snap?.session ?? null;
  const roster = snap?.roster ?? { expected: [], present: [], flexible: [], maybes: [], here: 0, expectedCount: 0, presence: "" };
  const tiers = snap?.tiers ?? { main: [], stretch: [], removed: [] };
  const spin = snap?.spin ?? null;
  const names = snap?.names ?? {};
  const nameOf = (m: string) => names[m] || localpart(m);
  const mainPool = tiers.main;
  // once a spin exists the strip scrolls the IMMUTABLE pool the draw walked (TH-REEL-06)
  const stripPool = useMemo(() => (spin && spin.pool.length ? spin.pool.map((p) => ({ ...p, badges: [], explain: [] as string[] })) : mainPool), [spin, mainPool]);
  const hasResult = !!spin && !!spin.winner && !spin.voided;
  const laps = snap && snap.reelSettings.laps > 0 ? snap.reelSettings.laps : 5;
  const durationMs = snap && snap.reelSettings.durationMs > 0 ? snap.reelSettings.durationMs : 6000;

  // ---- reel animation -------------------------------------------------------------------------
  const viewportRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(0);
  const [landedOn, setLandedOn] = useState("");
  const [animating, setAnimating] = useState(false);
  const raf = useRef(0);
  const xRef = useRef(0);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    setVw(el.clientWidth);
    return () => ro.disconnect();
  }, [stripPool.length > 0]);

  const idleX = (vw - COVER_W) / 2;
  const setX = (x: number) => {
    xRef.current = x;
    if (stripRef.current) stripRef.current.style.transform = `translateX(${x}px)`;
  };
  // keep the idle position centred when not animating (and after a resize)
  useLayoutEffect(() => {
    if (animating) return;
    if (landedOn && spin && spin.winner === landedOn) {
      const idx = stripPool.findIndex((g) => g.id === landedOn);
      if (idx >= 0) return setX(-((laps * stripPool.length + idx) * PITCH) + idleX);
    }
    setX(idleX);
  }, [idleX, animating, landedOn, stripPool, laps, spin]);

  // One animation per (spin, winner): the effect owns its frame loop and cancels it on cleanup, so
  // StrictMode's effect replay / a spin that changes or vanishes mid-roll can't leave the reel stuck
  // on "Spinning…" or land a stale winner. Landed spins are remembered for the app session (native:
  // the panel outlives hide/show, so a reopen doesn't roll again).
  const hasStrip = stripPool.length > 0;
  useEffect(() => {
    if (!spin || !spin.winner) {
      setAnimating(false);
      return;
    }
    const winnerId = spin.winner;
    const key = spin.id + "|" + winnerId;
    const pool = stripPool;
    if (!pool.length) return;
    const idx = pool.findIndex((g) => g.id === winnerId);
    if (idx < 0 || landedKeys.has(key)) {
      landedKeys.add(key);
      setAnimating(false);
      setLandedOn(winnerId);
      return;
    }
    const slot = laps * pool.length + idx;
    const width = viewportRef.current?.clientWidth ?? vw;
    const from = (width - COVER_W) / 2;
    const to = -(slot * PITCH) + from;
    let done = false;
    const finish = () => {
      done = true;
      landedKeys.add(key);
      setX(to);
      setAnimating(false);
      setLandedOn(winnerId);
      playUiSound("receive");
    };
    if (reduced) {
      finish();
      return;
    }
    setLandedOn("");
    setAnimating(true);
    setX(from);
    const t0 = performance.now();
    let tick = -1;
    const step = (now: number) => {
      if (!animate()) return finish();
      const tt = Math.min(1, (now - t0) / durationMs);
      const x = from + (to - from) * outCubic(tt);
      setX(x);
      const i = Math.floor((from - x) / PITCH + 0.5);
      if (i !== tick) {
        tick = i;
        playUiSound("send");
      }
      if (tt < 1) raf.current = requestAnimationFrame(step);
      else finish();
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf.current);
      if (!done) setAnimating(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin?.id, spin?.winner, hasStrip]);

  const loading = busy && !session && !hasResult;
  const winnerName = (id: string) => allGames(snap).find((g) => g.id === id)?.name || (spin && spin.winner === id ? spin.winnerName : "") || id;
  const ownersLine = (id: string) => {
    const g = allGames(snap).find((x) => x.id === id);
    const o = (g?.owners ?? spin?.owners ?? []).map(nameOf);
    return o.length ? "Owned by " + o.join(", ") : "";
  };
  const notice = snap?.notice ?? "";
  const emptyText = notice
    ? notice
    : roster.present.length === 0
      ? "Nobody’s here yet — the reel fills in as people show up."
      : tiers.stretch.length
        ? "No game everyone here owns. The ‘most of us own’ tier below can be spun if the admin allows it."
        : "No game everyone here owns. Add games in My games.";
  const subtitle =
    (session?.adhoc ? "No calendar session" : session && session.start ? fmtReelDay(session.start) + " · " + fmtTime(session.start) : "No session picked") +
    (session && session.game ? " · " + session.game : " · Game TBD");
  const presentIds = new Set(roster.present.map((p) => p.mxid));
  // 10.5.1 open roster: everyone here (in the call, RSVP or not) solid, then RSVP'd people not here yet
  // dimmed. Who is HERE is `roster.live`: outside a call the open roster is a preview of the RSVP'd + me,
  // so only the viewer is (it said "4 here" with nobody in a call) — GameReelPanel.qml does the same.
  const liveIds = new Set(roster.live ?? roster.present.map((p) => p.mxid));
  const faces = [
    ...roster.present.filter((p) => liveIds.has(p.mxid)),
    ...roster.present.filter((p) => !liveIds.has(p.mxid)),
    ...roster.expected.filter((p) => !presentIds.has(p.mxid)),
  ];
  const coming = roster.expected.filter((p) => !liveIds.has(p.mxid)).length;
  const hereText =
    roster.presence && roster.presence !== "open"
      ? roster.present.length + " of " + roster.expected.length + " here"
      : liveIds.size + " here" + (coming > 0 ? " · " + coming + " more coming" : "");
  const log = (snap?.log ?? []).filter((e) => !e.current).slice(0, 12);
  const respinsLeft = snap?.respinsLeft ?? 0;
  const canReset = isAdmin && (hasResult || (spin?.respinsUsed ?? 0) > 0);

  return (
    <div className={s.panel}>
      {loading && (
        <div className={s.loading}>
          <EmptyState loading title="Loading tonight's reel…" />
        </div>
      )}
      <ScrollArea className={s.scroll}>
        <div className={s.body}>
          {/* ---- header ---- */}
          <div className={s.header}>
            <div className={s.headTitles}>
              <div className={s.title}>{session && session.title ? session.title : "Tonight"}</div>
              <div className={s.subtitle}>{subtitle}</div>
            </div>
            <div className={s.headRight}>
              <span className={s.here} data-testid="reel-here">{hereText}</span>
              <span className={s.avatars}>
                {faces.map((p) => (
                  <Avatar key={p.mxid} size={28} name={p.name || localpart(p.mxid)} seed={p.mxid} imageSource={p.avatar || null} style={{ opacity: liveIds.has(p.mxid) ? 1 : 0.4 }} title={p.name} />
                ))}
              </span>
              <ReelButton text="My games" checked={showEditor} onClick={() => setShowEditor(!showEditor)} />
              {isAdmin && <ReelButton text="Tune" quiet checked={showAdmin} onClick={() => setShowAdmin(!showAdmin)} />}
            </div>
          </div>
          {lastError && (
            <div className={s.errorRow} role="alert">
              <span className={s.errorText}>{lastError}</span>
              <ReelButton text="✕" quiet width={26} height={24} radius={5} hint="Dismiss" aria-label="Dismiss" onClick={clearError} />
            </div>
          )}
          {showEditor && <MyGamesEditor />}
          {showAdmin && isAdmin && <GameNightAdmin />}

          {/* ---- the reel ---- */}
          <div className={s.reelBox} data-testid="reel-box">
            {!stripPool.length && <div className={s.reelEmpty}>{emptyText}</div>}
            {stripPool.length > 0 && (
              <div ref={viewportRef} className={s.viewport}>
                <div ref={stripRef} className={cx(s.strip, animating && s.stripMoving)}>
                  {Array.from({ length: stripPool.length * (laps + 1) }, (_, i) => {
                    const g = stripPool[i % stripPool.length];
                    const win = !!landedOn && g.id === landedOn && i === laps * stripPool.length + stripPool.findIndex((x) => x.id === landedOn);
                    return <ReelCover key={i} game={g} art={art(g.id)} winner={win} height={264} />;
                  })}
                </div>
                <span className={cx(s.marker, s.markerTop)} />
                <span className={cx(s.marker, s.markerBottom)} />
              </div>
            )}
          </div>

          {/* ---- controls ---- */}
          <div className={s.controls}>
            <ReelButton
              primary
              text={animating ? "Spinning…" : hasResult ? "Re-spin" : "Spin"}
              disabled={animating || busy || spinningWrite || resetting || (hasResult ? respinsLeft <= 0 : snap?.canSpin !== true)}
              hint={hasResult ? `Spin again, keeping tonight's vetoes — ${respinsLeft} left` : ""}
              onClick={() => (hasResult ? void respin() : void doSpin())}
            />
            {hasResult && (
              <ReelButton
                text="Veto"
                disabled={snap?.canVeto !== true || animating || busy || spinningWrite || resetting}
                hint={"One per person per night; the reel re-spins without this game" + (snap ? ` — ${snap.myVetoesLeft} left` : "")}
                onClick={() => void veto()}
              />
            )}
            {hasResult && <span className={s.dim12}>{respinsLeft + " re-spin" + (respinsLeft === 1 ? "" : "s") + " left"}</span>}
            {canReset && (
              <ReelButton
                text="Reset spins"
                quiet
                disabled={animating || busy || spinningWrite || resetting}
                hint="Admin: void tonight's spins so the next spin starts fresh — everyone gets their re-spins and vetoes back"
                onClick={() => setConfirmReset(true)}
              />
            )}
            {!hasResult && notice && mainPool.length > 0 && <span className={cx(s.dim12, s.elide)} style={{ maxWidth: 360 }}>{notice}</span>}
            {snap?.creditsMode === "free" && (
              <span className={s.freeChip} data-testid="reel-free-spins" title="An admin turned credits off in Tune: spins from now on don't earn or spend credit, and credit doesn't weight the reel. Each result says whether it counts.">
                Free spins
              </span>
            )}
            <span className={s.fill} />
            {spin?.note && <span className={s.warn12} style={{ maxWidth: 420 }}>{spin.note}</span>}
            {spin && spin.verified === false && <span className={s.warn12}>Could not verify this spin’s winner on this device.</span>}
          </div>

          {/* ---- result ---- */}
          {hasResult && landedOn && spin && (
            <div className={s.result} data-testid="reel-result">
              <Art src={art(spin.winner!)} className={s.resultArt} />
              <div className={s.resultCol}>
                <div className={s.resultTitle}>{"Tonight: " + winnerName(spin.winner!)}</div>
                {ownersLine(spin.winner!) && <div className={s.dim12}>{ownersLine(spin.winner!)}</div>}
                <div className={cx(s.dim12, s.elide)}>
                  {(session?.adhoc ? "Just for tonight (no calendar session)" : session && session.gameId === spin.winner ? "✓ Set on the calendar" : "Setting on the calendar…") +
                    (spin.by ? " · spun by " + nameOf(spin.by) : "") +
                    (spin.credit === false ? " · not counted for credit" : "")}
                </div>
              </div>
              {isAdmin && (
                <ReelButton
                  text={spin.credit === false ? "Count for credit" : "Don’t count for credit"}
                  quiet
                  height={28}
                  radius={5}
                  disabled={busy || spinningWrite || resetting}
                  hint={spin.credit === false ? "Admin: this spin counts for credit again (a lost favourite earns, a winning one spends)" : "Admin: tonight's result stands, but nobody's credit changes because of it"}
                  onClick={() => void setSpinCredit(spin.id, spin.credit === false)}
                />
              )}
            </div>
          )}

          {/* ---- tiers ---- */}
          <TierList title="Everyone here owns" games={tiers.main} art={art} nameOf={nameOf} />
          {tiers.stretch.length > 0 && <TierList title="Most of us own" subtitle="Shown, not spun, unless the admin turns the stretch tier on." games={tiers.stretch} art={art} dim nameOf={nameOf} />}
          {tiers.removed.length > 0 && <TierList title="Removed tonight" games={tiers.removed} art={art} dim showReason nameOf={nameOf} />}

          {/* ---- log ---- */}
          {log.length > 0 && (
            <div className={s.log} data-testid="reel-log">
              <div className={s.caps}>Past nights</div>
              {log.map((e) => (
                <div key={e.spinId || e.sessionId} className={s.logRow} data-session={e.sessionId}>
                  <span className={s.logLine}>
                    {(e.date ? fmtDMon(e.date) : "") +
                      " · " +
                      (e.winnerName || e.winner || "") +
                      " · " +
                      e.present.map(nameOf).join(", ") +
                      (e.creditChanges.length ? " · credit " + e.creditChanges.map((c) => nameOf(c.mxid) + (c.delta > 0 ? " +" : " ") + c.delta).join(", ") : "") +
                      (!e.voided && e.credit === false ? " · not counted for credit" : "")}
                  </span>
                  {isAdmin && !e.voided && e.spinId && (
                    <ReelButton
                      text={e.credit === false ? "Count for credit" : "Don’t count for credit"}
                      quiet
                      height={22}
                      radius={5}
                      className={s.logBtn}
                      disabled={busy || spinningWrite || resetting}
                      hint={e.credit === false ? "Admin: this night counts for credit again" : "Admin: this night's result stays, but nobody's credit changes because of it"}
                      onClick={() => void setSpinCredit(e.spinId, e.credit === false)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      <ConfirmDialog
        className={mobile ? s.bottomSheet : undefined}
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        dialogTitle="Reset tonight's spins?"
        message="Tonight's spins are voided and the next spin starts fresh — everyone gets their re-spins and vetoes back."
        confirmText="Reset spins"
        destructive
        onConfirmed={() => {
          setResetting(true);
          void resetSpins().finally(() => setResetting(false));
        }}
      />
    </div>
  );
}
