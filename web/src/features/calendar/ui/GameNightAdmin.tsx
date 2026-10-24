// GameNightAdmin.tsx — GameNightAdmin.qml (CAL-93..97): "Tune game night" for admins (PL ≥
// admin.min_pl): 11 spin boxes with "(default)", 8 toggles, the odds simulator (300 ms debounce),
// Reset all to defaults / Save (merged over the CURRENT stored settings, rev + 1), the Credit
// section (10.5.2: the "Spins affect credits" switch = settings credits.mode, everyone's credit with
// − / + / Zero, Reset all credits — all written at "admin:<mxid>", so they land for everyone), Void
// tonight's spin. DECISIONS D8: room v10 refuses JSON floats, so a non-default
// FRACTIONAL value can't be stored — such a row is flagged and Save is disabled with the hint.
import { useEffect, useRef, useState } from "react";
import { cx } from "@/ui";
import { useGames, saveSettings, simulate, resetCredits, voidSpin, adjustCredit, zeroCredit } from "../gamesStore";
import { FLOAT_REFUSAL } from "../model/games";
import { ReelButton } from "./ReelParts";
import { useTipRef } from "./util";
import s from "./Reel.module.css";

type Json = Record<string, unknown>;

const ROWS = [
  { k: "favorite.share", t: "Favorite share of a vote", min: 0.2, max: 0.9, step: 0.05 },
  { k: "regret.step", t: "Extra favorite weight per lost night", min: 0, max: 2, step: 0.1 },
  { k: "regret.cap", t: "Max credited nights (0 = off)", min: 0, max: 10, step: 1 },
  { k: "flexible.weight", t: "Weight a Flexible person spreads", min: 0, max: 0.5, step: 0.05 },
  { k: "veto.post_spin_per_person", t: "Post-spin vetoes per person", min: 0, max: 3, step: 1 },
  { k: "veto.respin_limit", t: "Re-spins per session", min: 0, max: 5, step: 1 },
  { k: "damping.factor", t: "Recent-winner weight (when damping is on)", min: 0.1, max: 1, step: 0.05 },
  { k: "reel.max_items", t: "Reel size (top N by weight)", min: 6, max: 30, step: 1 },
  { k: "reel.duration_ms", t: "Spin length (ms)", min: 2000, max: 12000, step: 500 },
  { k: "roster.grace_min", t: "Late-arrival grace (min)", min: 0, max: 30, step: 5 },
  { k: "admin.min_pl", t: "Power level to see this panel", min: 0, max: 100, step: 5 },
];
const TOGGLES = [
  { k: "feature.enabled", t: "Game night enabled (kill switch)" },
  { k: "pool.spin_stretch", t: "Spin the ‘most of us own’ tier too" },
  { k: "pool.count_flexible_ownership", t: "Flexible people count as owners" },
  { k: "regret.count_maybe", t: "A ‘maybe’ who showed up accrues credit" },
  { k: "regret.reset_on_favorite_change", t: "Changing favorite resets the streak" },
  { k: "damping.last_winner", t: "Damp recent winners" },
  { k: "steam.import", t: "Show the Steam import" },
  { k: "catalog.custom_entries", t: "Allow typed games not in the catalog" },
];

/** A value Matrix (room v10, canonical JSON) can't store: non-integral and not the default. */
const unstorable = (v: unknown, def: unknown) => typeof v === "number" && !Number.isInteger(v) && v !== def;

function SpinBox({ row, value, def, onChange }: { row: (typeof ROWS)[number]; value: number; def: unknown; onChange: (v: number) => void }) {
  const scale = row.step < 1 ? 100 : 1;
  const iv = Math.round(value * scale);
  const from = Math.round(row.min * scale);
  const to = Math.round(row.max * scale);
  const st = Math.round(row.step * scale);
  const bad = unstorable(value, def);
  const tip = useTipRef<HTMLDivElement>(bad ? FLOAT_REFUSAL : null, { delay: 300 });
  const fmt = (v: number) => (scale === 1 ? String(v) : (v / scale).toFixed(2));
  const bump = (d: number) => {
    const nv = Math.min(to, Math.max(from, iv + d * st));
    if (nv !== iv) onChange(nv / scale);
  };
  return (
    <div ref={tip} className={cx(s.spin, bad && s.spinBad)} onWheel={(e) => bump(e.deltaY < 0 ? 1 : -1)}>
      <button type="button" className={s.spinBtn} onClick={() => bump(-1)} aria-label="Decrease" disabled={iv <= from}>
        –
      </button>
      <span className={s.spinVal}>{fmt(iv)}</span>
      <button type="button" className={s.spinBtn} onClick={() => bump(1)} aria-label="Increase" disabled={iv >= to}>
        +
      </button>
    </div>
  );
}

export function GameNightAdmin() {
  const stored = useGames((x) => x.settingsJson);
  const defaults = useGames((x) => x.settingsDefaults);
  const sim = useGames((x) => x.simulation);
  const busy = useGames((x) => x.busy);
  const spin = useGames((x) => x.snap?.spin ?? null);
  const people = useGames((x) => x.snap?.credits ?? []);
  const [settings, setSettings] = useState<Json>(stored);
  const [dirty, setDirty] = useState(false);
  const simTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty) setSettings(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  useEffect(() => () => void (simTimer.current && clearTimeout(simTimer.current)), []);
  useEffect(() => () => void useGames.setState({ simulation: null }), []);

  const kick = (next: Json) => {
    if (simTimer.current) clearTimeout(simTimer.current);
    simTimer.current = setTimeout(() => simulate(next), 300);
  };
  const set = (k: string, v: unknown) => {
    const next = { ...settings, [k]: v };
    setSettings(next);
    setDirty(true);
    kick(next);
  };
  const val = (k: string) => (settings[k] !== undefined ? settings[k] : defaults[k]);
  const badRows = ROWS.filter((r) => unstorable(Number(val(r.k)), defaults[r.k]));
  // 10.5.2 settings credits.mode: "earn" (default) | "free" — saved with the rest (Save)
  const earn = val("credits.mode") !== "free";
  const simMain = sim?.tiers.main ?? [];

  return (
    <div className={s.admin} data-testid="reel-tune">
      <div className={s.edHead}>
        <span className={s.edTitle}>Tune game night</span>
        <span className={dirty ? s.unsaved : s.dim11}>{"rev " + (Number(settings.rev) || 0) + (dirty ? " · unsaved" : "")}</span>
        <ReelButton
          text="Reset all to defaults"
          quiet
          onClick={() => {
            const next = { ...defaults, rev: settings.rev };
            setSettings(next);
            setDirty(true);
            kick(next);
          }}
        />
        <ReelButton
          text="Save"
          primary
          disabled={!dirty || busy || badRows.length > 0}
          hint={badRows.length > 0 ? FLOAT_REFUSAL : ""}
          onClick={() => {
            const patch = { ...settings };
            delete patch.rev;
            void saveSettings(patch);
            setDirty(false);
          }}
        />
      </div>
      <div className={s.dim11}>Nothing here lets anyone choose a winner. Every change is logged with who and when (it is a state event).</div>
      {badRows.length > 0 && <div className={s.warn11}>{FLOAT_REFUSAL + ": " + badRows.map((r) => r.t).join(", ") + "."}</div>}
      <div className={s.grid2}>
        {ROWS.map((r) => (
          <div key={r.k} className={s.admRow}>
            <span className={s.admLabel}>{r.t}</span>
            <SpinBox row={r} value={Number(val(r.k)) || 0} def={defaults[r.k]} onChange={(v) => set(r.k, v)} />
            <span className={s.admDef}>{"(" + (defaults[r.k] !== undefined ? String(defaults[r.k]) : "") + ")"}</span>
          </div>
        ))}
      </div>
      <div className={s.toggles}>
        {TOGGLES.map((t) => {
          const on = !!val(t.k);
          return <ReelButton key={t.k} text={(on ? "☑ " : "☐ ") + t.t} checked={on} height={28} radius={5} onClick={() => set(t.k, !on)} />;
        })}
      </div>
      <div className={s.simCol}>
        <div className={s.caps11}>Tonight under these values</div>
        {simMain.map((g) => (
          <div key={g.id} className={s.simRow}>
            <span className={s.simName}>{g.name || g.id}</span>
            <span className={s.simBar}>
              <span className={s.simFill} style={{ width: `${Math.min(1, g.odds || 0) * 100}%` }} />
            </span>
            <span className={s.simPct}>{Math.round((g.odds || 0) * 100) + "%"}</span>
          </div>
        ))}
        {simMain.length === 0 && <div className={s.dim11}>Change a value to preview the odds.</div>}
      </div>
      <div className={s.creditCol} data-testid="reel-tune-credit">
        <div className={s.creditHead}>
          <span className={cx(s.caps11, s.fill)}>Credit</span>
          <ReelButton text="Reset all credits" quiet disabled={busy} hint="Writes a logged adjustment that zeroes everyone as of now" onClick={() => void resetCredits()} />
        </div>
        <div className={s.creditMode}>
          <ReelButton
            text={(earn ? "☑ " : "☐ ") + "Spins affect credits"}
            checked={earn}
            height={28}
            radius={5}
            hint="Saved with Save. Every spin records the mode it was spun in, so switching never changes past nights."
            onClick={() => set("credits.mode", earn ? "free" : "earn")}
          />
          <span className={s.dim11}>{earn ? "A lost favourite earns credit; when it wins, the credit is spent." : "Free spins: nobody earns or spends credit, and credit doesn’t weight the reel."}</span>
        </div>
        {people.length === 0 && <div className={s.dim11}>Nobody has credit yet — it builds up as favourites lose.</div>}
        <div className={s.grid2}>
          {people.map((p) => (
            <div key={p.mxid} className={s.creditRow} data-mxid={p.mxid}>
              <span className={s.admLabel} title={p.hasFavorite ? p.mxid : p.mxid + " — no favourite, so no credit counts yet"}>
                {p.name}
              </span>
              <span className={cx(s.creditVal, !p.hasFavorite && s.creditNone)} data-testid="reel-credit-value">
                {String(p.credit)}
              </span>
              <span className={s.creditOff}>{p.offset ? (p.offset > 0 ? "+" : "") + p.offset + " adj." : ""}</span>
              <ReelButton text="–" quiet width={26} height={24} radius={5} aria-label={"Take one credit from " + p.name} hint="−1 credit (logged)" disabled={busy || p.credit <= 0} onClick={() => void adjustCredit(p.mxid, -1, "Adjusted in Tune")} />
              <ReelButton text="+" quiet width={26} height={24} radius={5} aria-label={"Give " + p.name + " one credit"} hint="+1 credit (logged) — spent when their favourite wins" disabled={busy} onClick={() => void adjustCredit(p.mxid, 1, "Adjusted in Tune")} />
              <ReelButton text="Zero" quiet height={24} radius={5} aria-label={"Reset " + p.name + "'s credit"} hint="Back to 0 as of now (logged)" disabled={busy || (p.credit === 0 && p.offset === 0)} onClick={() => void zeroCredit(p.mxid)} />
            </div>
          ))}
        </div>
      </div>
      <div className={s.admActions}>
        {spin && <ReelButton text="Void tonight’s spin" quiet onClick={() => void voidSpin(spin.id, "voided by admin")} />}
      </div>
    </div>
  );
}
