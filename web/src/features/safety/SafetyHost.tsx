// SafetyHost.tsx — the account-safety dialogs (r.overlays): "Ignore {name}?" and "Report {name}" / "Report this message".
// Opened from every person / message menu through useSafetyUi (store.ts); the desktop's IgnoreDialog.qml +
// ReportDialog.qml are the same dialogs with the same words (core/safety.ts WORDS) in the same order:
//   Ignore   title · ignoreText · [Ignore] (destructive) [Cancel]
//   Report   title · reportIntro · "What's wrong?" + the five categories (radio) · details (≤ 1000) · "Also ignore them"
//            (a person / someone else's message) · [Send report] [Cancel]
// Phones: bottom sheets, 44 px targets.
import { useEffect, useRef, useState } from "react";
import { toast } from "@/core/bus";
import { CheckBox, ConfirmDialog, PromptDialog, RadioButton, TextArea, cx, useIsMobile } from "@/ui";
import { DETAILS_MAX, REPORT_CATEGORIES, WORDS, fill, ignoreRefusal, reportReady } from "@/core/safety";
import dlg from "@/features/settings/dialogs.module.css";
import { bind, isIgnored, me, sendReport, serverName, setIgnored, stillMe, useSafetyUi } from "./store";
import s from "./safety.module.css";

/** Ignore / stop ignoring with the toasts (the menus' run path; also Settings → Privacy). */
export async function applyIgnore(userId: string, name: string, ignore: boolean): Promise<boolean> {
  const why = ignore ? ignoreRefusal(me(), userId) : "";
  if (why) {
    toast(why, { kind: "error", timeoutMs: 4000 });
    return false;
  }
  const err = await setIgnored(userId, ignore);
  if (err) {
    toast(err, { kind: "error", timeoutMs: 5000 });
    return false;
  }
  toast(fill(ignore ? WORDS.ignoredToast : WORDS.unignoredToast, { name }), { timeoutMs: 4000 });
  return true;
}

export function SafetyHost() {
  const ui = useSafetyUi();
  const phone = useIsMobile();
  return (
    <>
      <ConfirmDialog
        open={!!ui.ignore}
        onClose={ui.close}
        className={phone ? cx(dlg.bottomSheet, s.phone) : undefined}
        dialogTitle={ui.ignore ? fill(WORDS.ignoreTitle, { name: ui.ignore.name }) : ""}
        message={WORDS.ignoreText}
        confirmText={WORDS.ignoreConfirm}
        destructive
        onConfirmed={() => {
          const t = ui.ignore;
          if (t) void applyIgnore(t.userId, t.name, true);
        }}
      />
      <ReportHost />
    </>
  );
}

/** The report dialog closes with open=false (unmounting an open dialog left the overlay's dimmer behind); each opening
 *  starts fresh (key = the opening's number). */
function ReportHost() {
  const report = useSafetyUi((u) => u.report);
  const last = useRef(report);
  const n = useRef(0);
  const prev = useRef(report);
  if (report && report !== prev.current) n.current++;
  prev.current = report;
  if (report) last.current = report;
  if (!last.current) return null;
  return <ReportDialog key={n.current} open={!!report} r={last.current} />;
}

function ReportDialog({ open, r }: { open: boolean; r: NonNullable<ReturnType<typeof useSafetyUi.getState>["report"]> }) {
  const ui = useSafetyUi();
  const phone = useIsMobile();
  const [category, setCategory] = useState("");
  const [details, setDetails] = useState("");
  const [alsoIgnore, setAlsoIgnore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const other = r.target.user !== me();
  const canIgnore = other && !isIgnored(r.target.user);
  useEffect(() => setErr(""), [category, details]);
  const ready = reportReady(category, details) && !busy;
  const send = () => {
    if (!ready) return;
    setBusy(true);
    const b = bind();
    void sendReport(r.target, category, details, b)
      .then(async (ok) => {
        if (!stillMe(b)) return; // signed out meanwhile: nothing of it acts for the next account
        if (!ok) {
          setErr(WORDS.reportFailed);
          return;
        }
        ui.close();
        toast(WORDS.reportSent, { timeoutMs: 4000 });
        if (alsoIgnore && canIgnore) await applyIgnore(r.target.user, r.name, true);
      })
      .finally(() => setBusy(false));
  };
  const title = r.target.event ? WORDS.reportMessageTitle : fill(WORDS.reportPersonTitle, { name: r.name });
  return (
    <PromptDialog
      open={open}
      onClose={ui.close}
      className={phone ? cx(dlg.bottomSheet, s.phone) : undefined}
      title={title}
      subtitle={fill(WORDS.reportIntro, { server: serverName() })}
      preferredWidth={440}
      actions={[
        { text: WORDS.reportSend, role: "accept", disabled: !ready, onClick: send },
        { text: "Cancel", role: "reject", onClick: ui.close },
      ]}
    >
      <div className={cx(s.col, phone && s.phone)} data-safety="report">
        <span className={s.what} id="th-report-what">
          {WORDS.reportWhat}
        </span>
        <div className={s.radios} role="radiogroup" aria-labelledby="th-report-what">
          {REPORT_CATEGORIES.map((c) => (
            <RadioButton key={c.id} name="th-report-category" text={c.label} checked={category === c.id} onToggled={(on) => on && setCategory(c.id)} data-category={c.id} />
          ))}
        </div>
        <TextArea
          aria-label={WORDS.reportDetails}
          placeholder={WORDS.reportDetails}
          value={details}
          maxLength={DETAILS_MAX}
          onChange={(e) => setDetails(e.target.value)}
        />
        {canIgnore && <CheckBox text={WORDS.reportAlsoIgnore} checked={alsoIgnore} onToggled={setAlsoIgnore} data-safety="also-ignore" />}
        {err && (
          <span className={cx(s.dim, s.neg)} role="alert">
            {err}
          </span>
        )}
      </div>
    </PromptDialog>
  );
}
