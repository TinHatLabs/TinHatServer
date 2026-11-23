// AdminChips.tsx — F8 the admin money screen (GAMES-V1.1-ADDENDUM §5.5), opened by "Manage chips…" (the Games panel,
// for a space's admins / the server owner only: features.play_admin + GET /admin/spaces says you.admin). Three cards:
// Economy (each key's value, where it comes from, Reset; Save = one PUT), People (search, pick, Everyone; Give · Take ·
// Set · Reset · Prestige + amount + an optional why; Review… says exactly what will happen, Do it), Log (newest first,
// Load more). "Chips" and "play money" only. Plus the notices an admin change leaves for the person (AdminNotices).
// Desktop twin: the Manage chips sheet (games-desktop2).
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/core/bus";
import { Button, CheckBox, OverlaySheet, cx, useIsMobile } from "@/ui";
import { PersonName } from "@/features/spaces/PersonName";
import { prestigeScopeOf } from "@/features/prestige/store";
import { R2X } from "./rules";
import { Chips, usePlayerLabel } from "./bits";
import { adminEconomy, adminLog, adminSpace, adminWallets, amountOk, ECONOMY_BOUNDS, ECONOMY_KEYS, economyOk, noticesSeen, parseNotices, plan, reasonOk, targetsOk, type AdminAction, type AdminSpace, type AdminWallet, type EconomyKey, type LogEntry } from "./admin";
import { codeWords } from "./wire";
import { ownerState, playFeatures, usePlay, wkey } from "./store";
import s from "./AdminChips.module.css";

const W = (k: string, fb = k) => R2X[k] ?? fb;
const fill = (t: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.split(`{${k}}`).join(String(x)), t);
const adminCode = (code: string) => R2X[`admin_code_${code}`] ?? (code === "network" ? W("admin_error") : codeWords(code));

/** Is this person an admin of the space's chips? (asked once per owner/space while the panel shows) */
export function useChipsAdmin(owner: string | null, space: string | null): boolean {
  const [ok, setOk] = useState(false);
  const feat = usePlay((x) => (owner ? x.owners[owner]?.features?.admin === true : false));
  useEffect(() => {
    if (!owner || !space) return;
    void playFeatures(owner);
  }, [owner, space]);
  useEffect(() => {
    let live = true;
    setOk(false);
    if (!owner || !space || !feat) return;
    void adminSpace(owner, space).then((a) => live && setOk(typeof a !== "string" && a.admin));
    return () => {
      live = false;
    };
  }, [owner, space, feat]);
  return ok;
}

export function ManageChipsButton({ owner, space, spaceName }: { owner: string; space: string; spaceName: string }) {
  const admin = useChipsAdmin(owner, space);
  const [open, setOpen] = useState(false);
  if (!admin) return null;
  return (
    <>
      <button type="button" className={s.manage} onClick={() => setOpen(true)} data-testid="admin-open">
        {W("admin_open", "Manage chips…")}
      </button>
      {open && <AdminSheet owner={owner} space={space} spaceName={spaceName} onClose={() => setOpen(false)} />}
    </>
  );
}

function AdminSheet({ owner, space, spaceName, onClose }: { owner: string; space: string; spaceName: string; onClose: () => void }) {
  const mobile = useIsMobile();
  return (
    <OverlaySheet open onClose={onClose} title={fill(W("admin_title", "Manage chips · {space}"), { space: spaceName })} preferredWidth={mobile ? undefined : 760} height={mobile ? "100%" : "86vh"}>
      <AdminBody owner={owner} space={space} />
    </OverlaySheet>
  );
}

/** The three cards (the sheet's body, and the space settings' Games tab). */
export function AdminBody({ owner, space }: { owner: string; space: string }) {
  const mobile = useIsMobile();
  const [a, setA] = useState<AdminSpace | string | null>(null);
  const reload = () => void adminSpace(owner, space).then(setA);
  useEffect(reload, [owner, space]); // eslint-disable-line react-hooks/exhaustive-deps
  const [logKey, setLogKey] = useState(0);
  return (
      <div className={cx(s.sheet, mobile && s.phone)} data-testid="admin-sheet">
        {a === null ? (
          <div className={s.muted}>…</div>
        ) : typeof a === "string" || !a.admin ? (
          <div className={s.muted}>{typeof a === "string" ? adminCode(a) : W("admin_not_admin")}</div>
        ) : (
          <>
            <Economy owner={owner} space={space} economy={a.economy} onSaved={(e) => (setA({ ...a, economy: e }), setLogKey((k) => k + 1))} />
            <People owner={owner} space={space} wallets={a.wallets} onDone={() => (reload(), setLogKey((k) => k + 1))} />
            <Log key={logKey} owner={owner} space={space} />
          </>
        )}
      </div>
  );
}

/** The space settings' Games tab: shown only to the space's chip admins (the same probe as Manage chips…). */
export function useSpaceGamesTab(spaceId: string): { owner: string; space: string } | null {
  const scope = prestigeScopeOf(spaceId);
  const owner = scope?.owner ?? null;
  const ok = useChipsAdmin(owner, spaceId || null);
  return ok && owner ? { owner, space: spaceId } : null;
}

// ---- Economy ------------------------------------------------------------------------------------------------------------
function Economy({ owner, space, economy, onSaved }: { owner: string; space: string; economy: AdminSpace["economy"]; onSaved: (e: AdminSpace["economy"]) => void }) {
  const [draft, setDraft] = useState<Partial<Record<EconomyKey, number | boolean>>>({});
  const [reset, setReset] = useState<EconomyKey[]>([]);
  const [busy, setBusy] = useState(false);
  const val = (k: EconomyKey) => (k in draft ? draft[k]! : (economy[k]?.value ?? (k === "side_on" ? true : 0)));
  const bad = ECONOMY_KEYS.filter((k) => k in draft && !economyOk(k, draft[k]!));
  const dirty = Object.keys(draft).length > 0 || reset.length > 0;
  const save = async () => {
    const sent = { ...draft };
    const sentReset = [...reset];
    setBusy(true);
    const r = await adminEconomy(owner, space, sent, sentReset, "");
    setBusy(false);
    if (typeof r === "string") return toast(adminCode(r));
    // only what was sent is cleared (edits are blocked while saving, but never drop one)
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => sent[k as EconomyKey] !== v)) as typeof d);
    setReset((x) => x.filter((k) => !sentReset.includes(k)));
    toast(W("admin_saved"));
    onSaved(r);
  };
  const cm = Number(val("chip_minutes")) || 15;
  const dm = Number(val("day_max")) || 16;
  return (
    <section className={s.card} data-testid="admin-economy">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>{W("admin_economy", "Economy")}</span>
        <span className={s.muted}>{fill(W("admin_earn_line"), { m: cm, d: dm })}</span>
      </div>
      <div className={s.rows}>
        {ECONOMY_KEYS.map((k) => {
          const src = reset.includes(k) ? "default" : k in draft ? "space" : (economy[k]?.source ?? "default");
          const v = val(k);
          return (
            <div key={k} className={s.erow} data-testid={`admin-key-${k}`}>
              <span className={s.label}>{W(`admin_key_${k}`, k)}</span>
              {k === "side_on" ? (
                <CheckBox checked={v === true} disabled={busy} onToggled={(b: boolean) => (setDraft((d) => ({ ...d, side_on: b })), setReset((r) => r.filter((x) => x !== k)))} aria-label={W(`admin_key_${k}`, k)} />
              ) : (
                <input
                  className={cx(s.num, bad.includes(k) && s.bad)}
                  disabled={busy}
                  type="number"
                  inputMode="numeric"
                  min={ECONOMY_BOUNDS[k][0]}
                  max={ECONOMY_BOUNDS[k][1]}
                  value={String(v)}
                  onChange={(e) => (setDraft((d) => ({ ...d, [k]: Math.round(Number(e.target.value)) })), setReset((r) => r.filter((x) => x !== k)))}
                  aria-label={W(`admin_key_${k}`, k)}
                  title={`${ECONOMY_BOUNDS[k][0]}–${ECONOMY_BOUNDS[k][1]}`}
                />
              )}
              <span className={cx(s.src, s[`src_${src}`])}>{W(`admin_src_${src}`, src)}</span>
              <button
                type="button"
                className={s.link}
                disabled={src === "default" && !(k in draft)}
                onClick={() => (setDraft((d) => Object.fromEntries(Object.entries(d).filter(([x]) => x !== k))), setReset((r) => (r.includes(k) ? r : [...r, k])))}
              >
                {W("admin_reset_key", "Reset")}
              </button>
            </div>
          );
        })}
      </div>
      <div className={s.cardFoot}>
        <Button highlighted text={W("admin_save", "Save")} disabled={!dirty || bad.length > 0 || busy} onClick={() => void save()} data-testid="admin-save" />
      </div>
    </section>
  );
}

// ---- People -------------------------------------------------------------------------------------------------------------
const ACTIONS: AdminAction[] = ["grant", "remove", "set", "reset", "rank"];
function People({ owner, space, wallets, onDone }: { owner: string; space: string; wallets: AdminWallet[]; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [action, setAction] = useState<AdminAction>("grant");
  const [amount, setAmount] = useState<number | null>(5);
  const [reason, setReason] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => wallets.filter((w) => !q || w.u.toLowerCase().includes(q.toLowerCase())), [wallets, q]);
  const chosen = everyone ? wallets : wallets.filter((w) => picked.includes(w.u));
  const p = plan(action, chosen, everyone);
  const who: string[] | "everyone" = everyone ? "everyone" : picked;
  const ready = (everyone || targetsOk(picked)) && chosen.length > 0 && amountOk(action, action === "reset" ? null : amount) && reasonOk(reason.trim());
  // any change after Review… closes the review (what is confirmed is exactly what is sent)
  useEffect(() => setReview(false), [action, amount, reason, everyone, picked]);
  const go = async () => {
    if (!ready || p.blocked || p.apply.length === 0) return setReview(false); // re-checked at the boundary
    setBusy(true);
    const r = await adminWallets(owner, space, action, who, action === "reset" ? null : amount, reason.trim());
    setBusy(false);
    setReview(false);
    if (typeof r === "string") return toast(adminCode(r));
    toast(`${fill(W("admin_done", "Done for {n}."), { n: r.done.length })}${r.skipped.length ? ` ${fill(W("admin_skipped"), { n: r.skipped.length })}` : ""}`);
    setPicked([]);
    setEveryone(false);
    setReason("");
    onDone();
  };
  const toggle = (u: string) => setPicked((l) => (l.includes(u) ? l.filter((x) => x !== u) : [...l, u]));
  return (
    <section className={s.card} data-testid="admin-people">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>{W("admin_people", "People")}</span>
        <input className={s.search} placeholder={W("admin_search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={W("admin_search")} />
      </div>
      <div className={s.people}>
        <div className={cx(s.prow, s.everyone)}>
          <CheckBox checked={everyone} onToggled={(b: boolean) => setEveryone(b)} data-testid="admin-everyone" />
          <span>{W("admin_everyone", "Everyone")}</span>
          <span className={s.muted}>{fill(W("admin_n_people"), { n: wallets.length })}</span>
        </div>
        {shown.map((w) => (
          <div key={w.u} className={cx(s.prow, everyone && s.dim)} data-testid={`admin-person-${w.u}`}>
            <CheckBox checked={everyone || picked.includes(w.u)} disabled={everyone} onToggled={() => toggle(w.u)} />
            <WalletName u={w.u} space={space} />
            <span className={s.bal}>{w.open ? <span className={s.muted}>{W("admin_at_table", "at a table")}</span> : <Chips n={w.balance ?? 0} />}</span>
            {w.rank > 0 && <span className={s.muted}>{fill(W("admin_rank_n"), { n: w.rank })}</span>}
          </div>
        ))}
      </div>
      <div className={s.actbar}>
        <span className={s.seg} role="radiogroup">
          {ACTIONS.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={action === x} className={cx(s.segB, action === x && s.segOn)} onClick={() => setAction(x)} data-testid={`admin-act-${x}`}>
              {W(`admin_act_${x}`, x)}
            </button>
          ))}
        </span>
        {action !== "reset" && (
          <input className={cx(s.num, amount !== null && !amountOk(action, amount) && s.bad)} type="number" inputMode="numeric" value={amount ?? ""} onChange={(e) => setAmount(e.target.value === "" ? null : Math.round(Number(e.target.value)))} aria-label={W("admin_amount", "Amount")} data-testid="admin-amount" />
        )}
        <input className={cx(s.reason, !reasonOk(reason.trim()) && s.bad)} placeholder={W("admin_reason")} maxLength={140} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={W("admin_reason")} />
        <Button highlighted text={W("admin_apply", "Review…")} disabled={!ready || busy} onClick={() => setReview(true)} data-testid="admin-review" />
      </div>
      {review && (
        <div className={s.confirm} role="alertdialog" data-testid="admin-confirm">
          <Sentence action={action} n={amount ?? 0} everyone={everyone} apply={p.apply} space={space} />
          {p.atTable.length > 0 && <AtTable action={action} people={p.atTable} space={space} blocked={p.blocked} />}
          <div className={s.cardFoot}>
            <Button flat text={W("admin_cancel", "Cancel")} onClick={() => setReview(false)} />
            <Button highlighted text={W("admin_do_it", "Do it")} disabled={busy || p.blocked || p.apply.length === 0} onClick={() => void go()} data-testid="admin-do" />
          </div>
        </div>
      )}
    </section>
  );
}
/** a wallet's person: their display name in the space (the space's prestige token beside it) */
function WalletName({ u, space }: { u: string; space: string }) {
  const name = usePlayerLabel(space, u);
  return <PersonName mxid={u} roomId={space} name={name} className={s.pname} title={u} />;
}
function Names({ people, space }: { people: AdminWallet[]; space: string }) {
  return <>{people.length <= 3 ? people.map((p, i) => <PlainName key={p.u} u={p.u} space={space} sep={i > 0 ? (i === people.length - 1 ? " and " : ", ") : ""} />) : fill(W("admin_n_people"), { n: people.length })}</>;
}
function PlainName({ u, space, sep }: { u: string; space: string; sep: string }) {
  const n = usePlayerLabel(space, u);
  return (
    <>
      {sep}
      {n}
    </>
  );
}
function Sentence({ action, n, everyone, apply, space }: { action: AdminAction; n: number; everyone: boolean; apply: AdminWallet[]; space: string }) {
  const t = W(`admin_confirm_${action}`);
  const [pre, post] = t.split("{who}");
  return (
    <p className={s.sentence} data-testid="admin-sentence">
      {fill(pre ?? "", { n })}
      {everyone ? W("admin_everyone", "Everyone").toLowerCase() : <Names people={apply} space={space} />}
      {fill(post ?? "", { n })}
    </p>
  );
}
function AtTable({ action, people, space, blocked }: { action: AdminAction; people: AdminWallet[]; space: string; blocked: boolean }) {
  const t = action === "grant" ? W("admin_at_table_grant") : blocked ? W("admin_code_at-table") : W("admin_at_table_skip");
  const [pre, post] = t.split("{who}");
  return (
    <p className={cx(s.sentence, s.note)} data-testid="admin-at-table">
      {pre}
      {t.includes("{who}") && <Names people={people} space={space} />}
      {post}
    </p>
  );
}

// ---- Log ----------------------------------------------------------------------------------------------------------------
function Log({ owner, space }: { owner: string; space: string }) {
  const [items, setItems] = useState<LogEntry[] | null>(null);
  const [more, setMore] = useState(true);
  const load = async (before?: number) => {
    const r = await adminLog(owner, space, before);
    if (typeof r === "string") return setItems((x) => x ?? []);
    setItems((x) => [...(before ? (x ?? []) : []), ...r]);
    setMore(r.length >= 50);
  };
  useEffect(() => void load(), [owner, space]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className={s.card} data-testid="admin-log">
      <div className={s.cardHead}>
        <span className={s.cardTitle}>{W("admin_log", "Log")}</span>
      </div>
      {items && items.length === 0 && <div className={s.muted}>{W("admin_log_empty")}</div>}
      {items?.map((e) => (
        <LogLine key={e.id} e={e} space={space} />
      ))}
      {items && items.length > 0 && more && <Button flat text={W("admin_more", "Load more")} onClick={() => void load(items[items.length - 1]!.id)} />}
    </section>
  );
}
function LogLine({ e, space }: { e: LogEntry; space: string }) {
  const by = usePlayerLabel(space, e.by);
  const who = usePlayerLabel(space, e.who.startsWith("@") ? e.who : "");
  const whoText = e.who === "everyone" ? W("admin_everyone", "Everyone").toLowerCase() : e.who === "someone" ? "someone" : who;
  const d = new Date(e.at);
  const today = d.toDateString() === new Date().toDateString();
  const when = `${today ? W("admin_today", "Today") : d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const line = fill(W(e.who === "economy" ? "admin_log_economy" : `admin_log_${e.action}`, "{by} {action}"), { by, who: whoText, n: e.amount ?? "", action: e.action });
  return (
    <div className={s.logLine}>
      <span className={s.muted}>{when}</span> · {line}
      {e.reason ? <span className={s.muted}> · {e.reason}</span> : null}
    </div>
  );
}

// ---- notices to the person (§5.5) ---------------------------------------------------------------------------------------
/** One-time lines in the wallet card ("An admin added 5 chips to yours · birthday"); acknowledged once shown. */
export function AdminNotices({ owner, space }: { owner: string; space: string }) {
  const raw = usePlay((x) => (x.wallets[wkey(owner, space)]?.wallet as { notices?: unknown } | null | undefined)?.notices);
  const n = useMemo(() => parseNotices(raw), [raw]);
  const last = n.items.length ? n.items[n.items.length - 1]!.id : 0;
  useEffect(() => {
    if (last && ownerState(owner).features?.play) void noticesSeen(owner, space, last);
  }, [owner, space, last]);
  if (!n.items.length) return null;
  return (
    <div className={s.notices} data-testid="admin-notices">
      {n.items.map((x) => (
        <div key={x.id}>
          {fill(W(`notice_${x.action}`, x.action), { n: x.amount ?? "" })}
          {x.reason ? ` · ${x.reason}` : ""}
        </div>
      ))}
      {n.more > 0 && <div className={s.muted}>and {n.more} more changes</div>}
    </div>
  );
}
