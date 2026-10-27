// sections.tsx — account safety's Settings rows (the desktop's SettingsWindow.qml has the same rows, words and order):
//   Privacy → "Ignored people"  (row id privacy.ignored): one row per person (avatar · name · id · [Stop ignoring]), or
//                                "You aren't ignoring anyone."
//   Devices & security → Your account → "Delete my account" (row id security.delete; never for a guest, the pane
//                                hides the whole card): [Delete…] → the dialog: deleteTitle · the six lines · the
//                                password · [Delete my account] (destructive) [Cancel]; for the server's owner / system
//                                account the row says why it can't instead of a button.
import { useState } from "react";
import { useUserProfile } from "@/core/matrix";
import { Avatar, Button, Icon, PromptDialog, TextField, cx, localpart, useIsMobile } from "@/ui";
import { WORDS, deleteLines } from "@/core/safety";
import { Row, Section } from "@/features/settings/rows";
import dlg from "@/features/settings/dialogs.module.css";
import { applyIgnore } from "./SafetyHost";
import { bind, deleteMyAccount, deleteRefusalNow, finishDeleted, me, useIgnored } from "./store";
import s from "./safety.module.css";

export function IgnoredPeopleSection() {
  const list = useIgnored();
  return (
    <Section title={WORDS.ignoredSection} hint={WORDS.ignoredSectionHint} id="ignored">
      {list.length === 0 ? (
        <Row id="privacy.ignored" label={WORDS.ignoredEmpty} />
      ) : (
        list.map((mxid, i) => <IgnoredRow key={mxid} mxid={mxid} first={i === 0} />)
      )}
    </Section>
  );
}

function IgnoredRow({ mxid, first }: { mxid: string; first: boolean }) {
  const p = useUserProfile(mxid);
  const phone = useIsMobile();
  const [busy, setBusy] = useState(false);
  const name = p.displayName || localpart(mxid);
  return (
    <Row
      id={first ? "privacy.ignored" : undefined}
      attrs={{ "data-ignored": mxid }}
      icon={<Avatar size={32} name={name} seed={mxid} imageSource={p.avatarUrl ?? null} />}
      label={name}
      description={mxid}
      control={
        <Button
          className={phone ? s.tap : undefined}
          text={WORDS.unignore}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void applyIgnore(mxid, name, false).finally(() => setBusy(false));
          }}
        />
      }
    />
  );
}

export function DeleteAccountRow() {
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refusal = deleteRefusalNow();
  const close = () => (setOpen(false), setPw(""), setErr(""));
  const ready = pw.length > 0 && !busy;
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    setErr("");
    const b = bind();
    void deleteMyAccount(pw, b)
      .then((out) => {
        if (out.kind === "deleted") {
          // close first (an open dialog unmounted by the sign-out would leave the overlay's dimmer), then sign out
          close();
          window.setTimeout(() => void finishDeleted(b), 300);
          return;
        }
        setErr(out.text);
        if (out.kind === "wrong") setPw("");
      })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Row
        id="security.delete"
        icon={<Icon name="delete-symbolic" size={22} staticOnly />}
        label={WORDS.deleteRow}
        labelTone={refusal ? undefined : "danger"}
        description={refusal || WORDS.deleteRowHint}
        control={refusal ? undefined : <Button className={phone ? s.tap : undefined} danger text="Delete…" onClick={() => (close(), setOpen(true))} />}
      />
      <PromptDialog
        open={open}
        className={phone ? cx(dlg.bottomSheet, s.phone) : undefined}
        onClose={() => !busy && close()}
        title={WORDS.deleteTitle}
        preferredWidth={460}
        actions={[
          {
            text: WORDS.deleteConfirm,
            role: "destructive",
            disabled: !ready,
            onClick: submit,
            render: ({ onClick, disabled }) => (
              <button type="button" className={s.danger} disabled={disabled} onClick={onClick} data-safety="delete-confirm">
                {WORDS.deleteConfirm}
              </button>
            ),
          },
          { text: "Cancel", role: "reject", onClick: close, disabled: busy },
        ]}
      >
        <div className={cx(s.col, phone && s.phone)} data-safety="delete">
          <ul className={cx(s.lines, s.text)}>
            {deleteLines(me()).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <span className={s.dim}>{WORDS.deletePassword}</span>
          <TextField
            type="password"
            aria-label="Account password"
            placeholder="Account password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onAccepted={submit}
          />
          {err && (
            <span className={cx(s.dim, s.neg)} role="alert">
              {err}
            </span>
          )}
        </div>
      </PromptDialog>
    </>
  );
}
