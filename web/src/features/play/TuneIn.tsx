// TuneIn.tsx — F9 "Tune In" (GAMES-V1.1-ADDENDUM §6.4): a tin hat's antenna hunts a hidden signal on a 1–100 dial;
// 7 tries, the static says higher / lower; find it in few tries and earn chips (the server decides and pays).
//   TuneInOffer   the one-line offer where it's offered: "Out of chips? Tune In to earn up to N more today" — only
//                 while /me.side.eligible (never a pop-up, a badge or a nag)
//   TuneInSheet   the game: a semicircle dial with a needle, the remaining range shaded, static that calms as the range
//                 narrows (still when unfocused / reduced motion), a number field + Tune (arrows move the needle, Enter
//                 tunes), tries left as 7 antenna pips; Signal locked: +N chips / Lost the signal. It was N.; Again
//                 (only while still eligible) / Back.
// Desktop twin: TuneIn.qml (games-desktop2).
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Popover, cx, useIsMobile } from "@/ui";
import { useWinState } from "@/core/winstate";
import { useReducedMotion } from "@/ui/motion";
import { artVars } from "./art";
import { Chips } from "./bits";
import { guessOk, parseSide, startTune, tune, type TuneAnswer, type TuneRun } from "./side";
import { SIDE_WORDS, tuneCodeWords } from "./rules";
import { usePlay, wkey } from "./store";
import { codeWords } from "./wire";
import s from "./TuneIn.module.css";

/** /me.side of this wallet, read tolerantly (null = not offered / unknown) */
export function useSide(owner: string | null, space: string | null) {
  const raw = usePlay((x) => (owner && space ? x.wallets[wkey(owner, space)]?.wallet?.side : undefined));
  return useMemo(() => parseSide(raw), [raw]);
}

export function TuneInOffer({ owner, space, compact }: { owner: string | null; space: string | null; compact?: boolean }) {
  const side = useSide(owner, space);
  const [at, setAt] = useState<HTMLElement | null>(null);
  // an open game stays open when it pays (paying ends the eligibility); only the offer line goes
  const offered = !!owner && !!space && !!side?.on && side.eligible;
  if (!offered && !at) return null;
  return (
    <>
      {offered && <span className={cx(s.offer, compact && s.offerCompact)} data-testid="tunein-offer">
        {!compact && <span>{SIDE_WORDS.offer.replace("{n}", String(side.left_today))}</span>}
        <button type="button" className={s.offerBtn} onClick={(e) => setAt(at ? null : e.currentTarget)} data-testid="tunein-open">
          {SIDE_WORDS.button}
        </button>
      </span>}
      {at && owner && space && <TuneInSheet key={`${owner}|${space}`} owner={owner} space={space} anchor={at} onClose={() => setAt(null)} />}
    </>
  );
}

type Phase = { k: "starting" } | { k: "run"; run: TuneRun; last: TuneAnswer | null } | { k: "over"; a: TuneAnswer } | { k: "refused"; code: string };

export function TuneInSheet({ owner, space, anchor, onClose }: { owner: string; space: string; anchor: HTMLElement | null; onClose: () => void }) {
  const mobile = useIsMobile();
  const side = useSide(owner, space);
  const [ph, setPh] = useState<Phase>({ k: "starting" });
  const [val, setVal] = useState(50);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const begin = async () => {
    setPh({ k: "starting" });
    const r = await startTune(owner, space);
    if (typeof r === "string") return setPh({ k: "refused", code: r });
    setVal(Math.round((r.lo + r.hi) / 2));
    setPh({ k: "run", run: r, last: null });
  };
  useEffect(() => {
    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = ph.k === "run" ? ph.run : null;
  const lo = ph.k === "run" ? (ph.last?.lo ?? ph.run.lo) : ph.k === "over" ? ph.a.lo : 1;
  const hi = ph.k === "run" ? (ph.last?.hi ?? ph.run.hi) : ph.k === "over" ? ph.a.hi : 100;
  const left = ph.k === "run" ? (ph.last?.tries_left ?? ph.run.tries_left) : ph.k === "over" ? ph.a.tries_left : 7;
  const go = async () => {
    if (!run || busy || !guessOk(val, lo, hi)) return;
    setBusy(true);
    const a = await tune(owner, space, run.run, val);
    setBusy(false);
    if (typeof a === "string") return setPh({ k: "refused", code: a });
    if (a.result === "higher" || a.result === "lower") {
      setPh({ k: "run", run, last: a });
      setVal(Math.round((a.lo + a.hi) / 2));
      field.current?.focus();
    } else setPh({ k: "over", a });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") (e.preventDefault(), setVal((v) => Math.max(lo, v - (e.shiftKey ? 10 : 1))));
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") (e.preventDefault(), setVal((v) => Math.min(hi, v + (e.shiftKey ? 10 : 1))));
    else if (e.key === "Enter") (e.preventDefault(), void go());
  };
  const width = 100 - 1;
  const calm = 1 - (hi - lo) / width; // 0 = wide static, 1 = locked
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="above" align="center" plain={!mobile} aria-label={SIDE_WORDS.title} role="dialog">
      <div className={s.sheet} style={artVars()} onKeyDown={onKey} data-testid="tunein">
        <div className={s.head}>
          <span className={s.title}>{SIDE_WORDS.title}</span>
          <span className={s.pips} aria-label={SIDE_WORDS.tries.replace("{n}", String(left))} data-testid="tunein-tries" data-left={left}>
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} className={cx(s.pip, i < left && s.pipOn)} />
            ))}
          </span>
        </div>
        <Dial lo={lo} hi={hi} value={ph.k === "over" && ph.a.secret ? ph.a.secret : val} calm={ph.k === "over" ? 1 : calm} onPick={(n) => run && guessOk(n, lo, hi) && setVal(n)} locked={ph.k === "over" && ph.a.result === "found"} />
        {ph.k === "run" && (
          <>
            <div className={s.hint} data-testid="tunein-hint" aria-live="polite">
              {ph.last ? (ph.last.result === "higher" ? SIDE_WORDS.higher : SIDE_WORDS.lower) : SIDE_WORDS.intro!.replace("{n}", String(ph.run.left_today))}
            </div>
            <div className={s.controls}>
              <input
                ref={field}
                className={s.num}
                type="number"
                inputMode="numeric"
                min={lo}
                max={hi}
                value={val}
                onChange={(e) => setVal(Math.max(lo, Math.min(hi, Math.round(Number(e.target.value) || lo))))}
                aria-label={`${SIDE_WORDS.field} · ${SIDE_WORDS.range!.replace("{lo}", String(lo)).replace("{hi}", String(hi))}`}
                data-testid="tunein-value"
              />
              <span className={s.range}>
                {lo}–{hi}
              </span>
              <Button highlighted text={SIDE_WORDS.tune} disabled={busy || !guessOk(val, lo, hi)} onClick={() => void go()} data-testid="tunein-tune" />
            </div>
          </>
        )}
        {ph.k === "over" && (
          <div className={s.result} data-testid="tunein-result" data-result={ph.a.result}>
            {ph.a.result === "found" ? (
              <>
                <span>{SIDE_WORDS.found.replace("{n}", String(ph.a.paid))}</span>
                {ph.a.paid > 0 && <Chips n={ph.a.paid} />}
              </>
            ) : ph.a.result === "lost" ? (
              SIDE_WORDS.lost.replace("{n}", String(ph.a.secret ?? "?"))
            ) : (
              SIDE_WORDS.cancelled
            )}
          </div>
        )}
        {ph.k === "refused" && <div className={s.result}>{tuneCodeWords(ph.code) ?? (ph.code === "network" ? SIDE_WORDS.error : codeWords(ph.code))}</div>}
        {ph.k === "starting" && <div className={s.hint}>{SIDE_WORDS.starting}</div>}
        {(ph.k === "over" || ph.k === "refused") && (
          <div className={s.foot}>
            {side?.eligible && <Button highlighted text={SIDE_WORDS.again} onClick={() => void begin()} data-testid="tunein-again" />}
            <Button flat text={SIDE_WORDS.back} onClick={onClose} data-testid="tunein-back" />
          </div>
        )}
      </div>
    </Popover>
  );
}

/** The dial: a semicircle 1..100, the still-possible range lit, the needle; a press on the arc picks a value. */
function Dial({ lo, hi, value, calm, onPick, locked }: { lo: number; hi: number; value: number; calm: number; onPick: (n: number) => void; locked: boolean }) {
  const win = useWinState();
  const reduced = useReducedMotion();
  const live = win === "focused" && !reduced && !locked;
  const W = 260,
    H = 150,
    cx0 = W / 2,
    cy0 = 136,
    R = 104;
  const ang = (n: number) => Math.PI * (1 - (n - 1) / 99); // 1 → left (π), 100 → right (0)
  const pt = (n: number, r = R) => [cx0 + r * Math.cos(ang(n)), cy0 - r * Math.sin(ang(n))] as const;
  const arc = (a: number, b: number, r = R) => {
    const [x1, y1] = pt(a, r);
    const [x2, y2] = pt(b, r);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const [nx, ny] = pt(value, R - 18);
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W - cx0;
    const y = cy0 - ((e.clientY - r.top) / r.height) * H;
    if (y < -10) return;
    const t = Math.atan2(Math.max(0, y), x); // 0..π
    onPick(Math.round(1 + 99 * (1 - t / Math.PI)));
  };
  return (
    <svg className={cx(s.dial, live && s.dialLive)} viewBox={`0 0 ${W} ${H}`} onPointerDown={pick} role="img" aria-label={`${value}`} data-testid="tunein-dial" style={{ ["--static" as string]: String(Math.max(0, 0.55 - calm * 0.55)) }}>
      <path d={arc(1, 100)} className={s.track} />
      {hi >= lo && <path d={arc(lo, hi)} className={s.lit} />}
      {[1, 25, 50, 75, 100].map((n) => {
        const [x, y] = pt(n, R + 12);
        return (
          <text key={n} x={x} y={y} className={s.tick} textAnchor="middle" dominantBaseline="middle">
            {n}
          </text>
        );
      })}
      <line x1={cx0} y1={cy0} x2={nx} y2={ny} className={cx(s.needle, locked && s.needleLocked)} />
      <circle cx={cx0} cy={cy0} r={6} className={s.hub} />
      <text x={cx0} y={cy0 - 34} className={s.value} textAnchor="middle" data-testid="tunein-needle">
        {value}
      </text>
    </svg>
  );
}
