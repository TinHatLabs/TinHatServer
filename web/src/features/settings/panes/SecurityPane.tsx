// Devices & security pane — SETTINGS-WINDOW.md §5 (was the Sessions and Security panes; old key `sessions` opens it).
// Card "This device": Verification (status icon + text; "Verify…" while unverified) and Key backup (on, or "Set up…"
// → the existing password flow). Card "Where you're signed in": the device list, this device first with a "This
// device" chip; each row's ⋯ (or a right-click / long-press) offers Rename…, Verify this session, Sign out…; "Sign out
// all others…" on the card's first row. verified = the three private cross-signing keys on this device (native
// meaning); backup = key backup active here. Child dialogs (verify, rename, sign out) open over the window.
import { useEffect, useRef, useState } from "react";
import { startDeviceVerificationWith, useCryptoStatus } from "@/core/matrix";
import { bus, toast } from "@/core/bus";
import { Button, Icon, Menu, MenuItem, PromptDialog, TextField, ToolButton, cx, useIsMobile } from "@/ui";
import { changePassword, changePasswordError, deleteDevice, deleteOtherDevices, refreshDevices, renameDevice, useProfile, type DeviceRow } from "../profile";
import { guestNow } from "@/core/server/store";
import { runSetUpBackup } from "../VerifyDeviceDialog";
import { Chip, Hint, NoteRow, Row, Section } from "../rows";
import p from "./panes.module.css";
import dlg from "../dialogs.module.css";

export function agoText(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 120) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const PHONE = /phone|android|ios|iphone|ipad|element x|mobile/i;

export function SecurityPane() {
  return (
    <>
      <ThisDevice />
      <Devices />
      {!guestNow() && <YourAccount />}
    </>
  );
}

/** Your account → Password: "Change…" opens the dialog (current, new, new again; at least 8 characters). The way back
 *  for someone whose owner set a new password for them (a Tin Hat server sends no email). Other devices stay signed in. */
function YourAccount() {
  const phone = useIsMobile();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const clear = () => (setCur(""), setPw1(""), setPw2(""), setErr(""));
  const close = () => (setOpen(false), clear());
  const mismatch = pw2.length > 0 && pw2 !== pw1;
  const ready = cur.length > 0 && pw1.length >= 8 && pw1 === pw2 && !busy;
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    changePassword(cur, pw1)
      .then(() => {
        close();
        toast("Password changed. Your other devices stay signed in.");
      })
      .catch((e) => {
        const r = changePasswordError(e);
        setErr(r.text);
        if (r.wrongCurrent) setCur("");
      })
      .finally(() => setBusy(false));
  };
  return (
    <Section title="Your account">
      <Row
        id="security.password"
        icon={<Icon name="lock-symbolic" size={22} staticOnly />}
        label="Password"
        description="Change the password you sign in with"
        control={<Button text="Change…" onClick={() => (clear(), setOpen(true))} />}
      />
      <PromptDialog
        open={open}
        className={phone ? dlg.bottomSheet : undefined}
        onClose={close}
        title="Change password"
        subtitle={err || "Your other devices stay signed in."}
        preferredWidth={420}
        actions={[
          { text: "Change password", role: "accept", disabled: !ready, onClick: submit },
          { text: "Cancel", role: "reject", onClick: close },
        ]}
      >
        <TextField type="password" aria-label="Current password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        <TextField type="password" aria-label="New password" placeholder="New password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
        <TextField type="password" aria-label="New password again" placeholder="New password again" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} onAccepted={submit} />
        <Hint tone={mismatch ? "danger" : undefined}>{mismatch ? "Those two don't match." : "At least 8 characters"}</Hint>
      </PromptDialog>
    </Section>
  );
}

function ThisDevice() {
  const st = useCryptoStatus();
  const [setting, setSetting] = useState(false);
  const [pw, setPw] = useState("");
  const verified = st.thisDeviceVerified;
  const backup = st.backupEnabled;
  useEffect(() => {
    if (backup) setSetting(false);
  }, [backup]);
  const setUp = () => {
    if (!pw) return;
    const v = pw;
    setPw("");
    setSetting(false);
    runSetUpBackup(v);
  };
  return (
    <Section title="This device">
      <Row
        id="security.verification"
        icon={<Icon name={verified ? "security-high-symbolic" : "security-low-symbolic"} size={22} color={verified ? "var(--th-settings-success-fg)" : "var(--th-settings-error-fg)"} staticOnly />}
        label="Verification"
        description={verified ? "This device is verified (cross-signed) — it can read your encrypted messages." : "Not verified yet — encrypted messages can't be read on this device."}
        control={verified ? <span className={p.okText}>Verified</span> : <Button highlighted text="Verify…" onClick={() => bus.emit("openVerifyDialog", {})} />}
      />
      <Row
        id="security.key-backup"
        icon={<Icon name={backup ? "backup-symbolic" : "dialog-warning"} size={22} color={backup ? "var(--th-settings-success-fg)" : "var(--th-settings-fg)"} staticOnly={backup} isMask={backup} />}
        label="Key backup"
        description={
          backup
            ? "On — your encrypted history is backed up on the server."
            : verified
              ? "Off — signing out or losing this device makes your encrypted history unreadable."
              : "Off. Verify this device first, then set it up here."
        }
        control={backup ? <span className={p.okText}>On</span> : !setting ? <Button text="Set up…" disabled={!verified} onClick={() => setSetting(true)} /> : undefined}
      >
        {!backup && setting && (
          <>
            <Hint>Setting it up asks for your account password and gives you a recovery key to write down.</Hint>
            <div className={p.fieldRow}>
              <TextField
                className={p.fill}
                type="password"
                aria-label="Account password"
                placeholder="Account password"
                value={pw}
                autoFocus
                onChange={(e) => setPw(e.target.value)}
                onAccepted={setUp}
              />
              <Button flat text="Cancel" onClick={() => (setSetting(false), setPw(""))} />
              <Button highlighted text="Set up key backup" disabled={!pw} onClick={setUp} />
            </div>
          </>
        )}
      </Row>
    </Section>
  );
}

function DeviceItem({ d, onRename, onSignOut }: { d: DeviceRow; onRename: () => void; onSignOut: () => void }) {
  const mobile = useIsMobile();
  const more = useRef<HTMLButtonElement>(null);
  // the ⋯ button's menu, or a right-click at the pointer (the old list's context menu)
  const [menu, setMenu] = useState<null | HTMLElement | { x: number; y: number }>(null);
  const second = [d.lastSeenTs > 0 ? `Last active ${agoText(d.lastSeenTs)}` : "", d.lastSeenIp].filter(Boolean).join("  ·  ");
  const close = () => setMenu(null);
  return (
    <Row
      className={p.deviceRow}
      attrs={{ "data-device-id": d.id, title: `Session ${d.id}` }}
      rowProps={{
        onContextMenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        },
      }}
      icon={<Icon name={PHONE.test(d.name) ? "smartphone-symbolic" : "computer-symbolic"} size={22} color="var(--th-settings-fg)" staticOnly />}
      label={
        <>
          <span className={cx(d.isCurrent && p.sessCurrent)}>{d.name || d.id}</span>
          {d.isCurrent && <Chip>This device</Chip>}
        </>
      }
      description={second || (d.isCurrent ? "Active now" : undefined)}
      inline
      control={
        <>
          <ToolButton ref={more} iconName="view-more-symbolic" tip="Rename, verify or sign out" aria-haspopup="menu" onClick={() => setMenu((m) => (m ? null : more.current))} />
          {menu && (
            <Menu open onClose={close} anchor={menu} title={mobile ? d.name || d.id : undefined}>
              <MenuItem text="Rename…" icon="edit-rename" onTriggered={() => (close(), onRename())} />
              {!d.isCurrent && (
                <MenuItem
                  text="Verify this session"
                  icon="security-high-symbolic"
                  onTriggered={() => {
                    close();
                    bus.emit("openVerifyDialog", { mode: "sas" });
                    void startDeviceVerificationWith(d.id);
                  }}
                />
              )}
              {!d.isCurrent && <MenuItem text="Sign out…" icon="system-log-out-symbolic" danger onTriggered={() => (close(), onSignOut())} />}
            </Menu>
          )}
        </>
      }
    />
  );
}

function Devices() {
  const prof = useProfile();
  useCryptoStatus();
  const [rename, setRename] = useState<DeviceRow | null>(null);
  const [newName, setNewName] = useState("");
  const [signOut, setSignOut] = useState<DeviceRow | null>(null);
  const [signOutAll, setSignOutAll] = useState(false);
  const phone = useIsMobile();
  const others = prof.devices.filter((d) => !d.isCurrent).length;
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (prof.devicesState === "idle") void refreshDevices();
  }, [prof.devicesState]);
  // this device first, then the most recently active
  const devices = [...prof.devices].sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : b.lastSeenTs - a.lastSeenTs));
  const n = prof.devices.length;

  return (
    <Section title="Where you're signed in" hint="Right-click a device (long-press on phones) or use its ⋯ to rename it, verify it or sign it out.">
      <Row
        id="security.devices"
        label="Signed-in devices"
        description={n === 0 ? undefined : `${n} device${n === 1 ? "" : "s"} and browser${n === 1 ? "" : "s"} use your account.`}
        control={
          others > 0 ? (
            <Button
              text="Sign out all others…"
              icon="system-log-out-symbolic"
              onClick={() => {
                setPw("");
                setErr("");
                setSignOutAll(true);
              }}
            />
          ) : undefined
        }
      />
      {prof.devices.length === 0 && (
        <NoteRow>
          {prof.devicesState === "loading" || prof.devicesState === "idle" ? "Loading your devices…" : "Couldn't load your devices — close and reopen Settings to try again."}
        </NoteRow>
      )}
      {devices.map((d) => (
        <DeviceItem
          key={d.id}
          d={d}
          onRename={() => {
            setNewName(d.name);
            setErr("");
            setRename(d);
          }}
          onSignOut={() => {
            setPw("");
            setErr("");
            setSignOut(d);
          }}
        />
      ))}

      <PromptDialog
        open={!!rename}
        className={phone ? dlg.bottomSheet : undefined}
        onClose={() => setRename(null)}
        title="Rename session"
        subtitle={err || undefined}
        preferredWidth={420}
        actions={[
          {
            text: "Rename",
            role: "accept",
            disabled: !newName.trim(),
            onClick: () => {
              const d = rename!;
              renameDevice(d.id, newName)
                .then(() => setRename(null))
                .catch((e) => setErr(`Couldn't rename: ${(e as Error).message}`));
            },
          },
          { text: "Cancel", role: "reject", onClick: () => setRename(null) },
        ]}
      >
        <TextField aria-label="Session name" value={newName} onChange={(e) => setNewName(e.target.value)} />
      </PromptDialog>

      <PromptDialog
        open={!!signOut}
        className={phone ? dlg.bottomSheet : undefined}
        onClose={() => setSignOut(null)}
        title="Sign out this session?"
        subtitle={err || `${signOut?.name || signOut?.id || ""} will be signed out. Enter your account password to confirm.`}
        preferredWidth={420}
        actions={[
          {
            text: "Sign out",
            role: "destructive",
            disabled: !pw,
            onClick: () => {
              const d = signOut!;
              deleteDevice(d.id, pw)
                .then(() => {
                  setSignOut(null);
                  toast(`Signed out ${d.name || d.id}`);
                })
                .catch((e) => setErr(`Couldn't sign it out: ${(e as Error).message}`));
            },
          },
          { text: "Cancel", role: "reject", onClick: () => setSignOut(null) },
        ]}
      >
        <TextField type="password" autoComplete="current-password" aria-label="Account password" placeholder="Account password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </PromptDialog>
      <PromptDialog
        open={signOutAll}
        className={phone ? dlg.bottomSheet : undefined}
        onClose={() => setSignOutAll(false)}
        title="Sign out all other sessions?"
        subtitle={
          err ||
          `${others} other session${others === 1 ? "" : "s"} will be signed out — every device and browser except this one. Enter your account password to confirm.`
        }
        preferredWidth={420}
        actions={[
          {
            text: `Sign out ${others} session${others === 1 ? "" : "s"}`,
            role: "destructive",
            disabled: !pw,
            onClick: () => {
              deleteOtherDevices(pw)
                .then((k) => {
                  setSignOutAll(false);
                  toast(`Signed out ${k} session${k === 1 ? "" : "s"}`);
                })
                .catch((e) => setErr(`Couldn't sign them out: ${(e as Error).message}`));
            },
          },
          { text: "Cancel", role: "reject", onClick: () => setSignOutAll(false) },
        ]}
      >
        <TextField type="password" autoComplete="current-password" aria-label="Account password" placeholder="Account password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </PromptDialog>
    </Section>
  );
}

