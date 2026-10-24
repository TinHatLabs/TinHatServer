// Profile pane — SETTINGS-WINDOW.md §5 (settings-account.md §2.4 / §3.2 for the behaviour). A header card (photo 72,
// name 17/600, your Matrix ID, Change photo… / Remove), the Profile card (Display name, About me, Your colour — drafts:
// a save bar at the bottom of the content while any differs from the server, "Reset" / "Save changes", Enter in a
// field = Save changes; no per-field Save), the Join sound card (the picker + the sound-effect search) and the Email
// address card (add → confirm with your password → remove).
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useAccountData, useMxcUrl, useSession } from "@/core/matrix";
import { useServerFeature } from "@/core/server";
import { Avatar, BasicToolButton, Button, ComboBox, ConfirmDialog, Icon, SearchField, TextField, cx, localpart, useIsMobile } from "@/ui";
import { addEmail, clearAvatar, confirmEmail, removeEmail, saveAccent, saveBio, saveDisplayName, saveJoinSound, uploadAvatar, useProfile } from "../profile";
import { PERSONAL_TYPE, addPersonalSound, stopPreview, togglePreview, usePlayingUrl, useSoundSearch, type PersonalSound } from "../joinsound";
import { isErrorStatus, useSettingsUi } from "../store";
import { Buttons, Card, Hint, Row, Section } from "../rows";
import p from "./panes.module.css";
import dlg from "../dialogs.module.css";

const SWATCHES = ["#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68", "#f7768e", "#2ac3de"];

const useDrafts = create<{ name: string | null; bio: string | null; accent: string | null }>()(() => ({ name: null, bio: null, accent: null }));
/** Sign-out: drop the unsaved Profile drafts. */
export const resetProfileDrafts = () => useDrafts.setState({ name: null, bio: null, accent: null });

export function ProfilePane() {
  const prof = useProfile();
  const { userId = "" } = useSession();
  const avatarUrl = useMxcUrl(prof.avatarMxc || null, { width: 144, height: 144, method: "crop" });
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmAvatar, setConfirmAvatar] = useState(false);
  const [confirmEmailAddr, setConfirmEmailAddr] = useState<string | null>(null);
  const phone = useIsMobile();
  const soundboardOn = useServerFeature("soundboard");
  const busy = prof.busy;

  // ---- drafts: null = follow the server (a server change never overwrites what you're typing, SET-09). They live in a
  // store, so closing the window or switching panes keeps them (the bar is back when Profile is) until Reset / Save /
  // sign-out.
  const { name: nameD, bio: bioD, accent: accentD } = useDrafts();
  const setNameD = (v: string | null) => useDrafts.setState({ name: v });
  const setBioD = (v: string | null) => useDrafts.setState({ bio: v });
  const setAccentD = (v: string | null) => useDrafts.setState({ accent: v });
  const name = nameD ?? prof.displayName;
  const bio = bioD ?? prof.bio;
  const accent = accentD ?? prof.accent;
  const nameDirty = nameD !== null && nameD.trim() !== prof.displayName;
  const bioDirty = bioD !== null && bioD.trim() !== prof.bio;
  const accentDirty = accentD !== null && accentD.toLowerCase() !== prof.accent.toLowerCase();
  const dirty = nameDirty || bioDirty || accentDirty;
  const canSave = dirty && !busy && name.trim().length > 0;

  useEffect(() => {
    useSettingsUi.setState({ saveBar: dirty });
  }, [dirty]);
  useEffect(() => () => useSettingsUi.setState({ saveBar: false }), []);

  const reset = () => {
    setNameD(null);
    setBioD(null);
    setAccentD(null);
  };
  const save = async () => {
    if (!canSave) return;
    if (nameDirty) await saveDisplayName(name);
    if (bioDirty) await saveBio(bio);
    if (accentDirty) await saveAccent(accent);
    // a field that reached the server follows it again; a failed one keeps its draft (and the bar)
    const now = useProfile.getState();
    if (nameD !== null && now.displayName === nameD.trim()) setNameD(null);
    if (bioD !== null && now.bio === bioD.trim()) setBioD(null);
    if (accentD !== null && now.accent.toLowerCase() === accentD.toLowerCase()) setAccentD(null);
  };

  // ---- join sound ------------------------------------------------------------------------------------------------------
  const personal = useAccountData<{ sounds?: PersonalSound[] }>(PERSONAL_TYPE);
  const sounds = Array.isArray(personal?.sounds) ? personal!.sounds : [];
  const [chosen, setChosen] = useState(prof.joinSound);
  useEffect(() => setChosen(prof.joinSound), [prof.joinSound]);
  const model: Array<{ name: string; url: string }> = [{ name: "No join sound", url: "" }];
  let found = false;
  sounds.forEach((s, i) => {
    const u = s.sourceUrl || s.url || "";
    model.push({ name: s.name || `Sound ${i + 1}`, url: u });
    if (u === chosen) found = true;
  });
  if (!found && chosen) model.push({ name: "Current join sound", url: chosen });
  const idx = Math.max(0, model.findIndex((m) => m.url === chosen));
  const playing = usePlayingUrl();
  const [q, setQ] = useState("");
  const search = useSoundSearch(q);
  useEffect(() => () => stopPreview(), []);
  const previewing = playing === chosen && chosen.length > 0;

  // ---- email -------------------------------------------------------------------------------------------------------
  const [email, setEmail] = useState("");
  const [emailPw, setEmailPw] = useState("");

  const status = useSettingsUi((st) => st.status);

  return (
    <>
      {/* header card: photo, name, Matrix ID, Change photo… / Remove */}
      <Card className={p.headCard}>
        <div className={p.headRow} data-setting="profile.photo">
          <Avatar size={72} name={prof.displayName || localpart(userId)} seed={userId} imageSource={avatarUrl} />
          <div className={p.headText}>
            <span className={p.headName}>{prof.displayName || localpart(userId)}</span>
            <span className={p.headSub}>{userId}</span>
          </div>
          <Buttons className={p.headButtons}>
            <Button text="Change photo…" icon="insert-image-symbolic" disabled={busy} onClick={() => fileRef.current?.click()} />
            {prof.avatarMxc && <Button flat text="Remove" disabled={busy} onClick={() => setConfirmAvatar(true)} />}
          </Buttons>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadAvatar(f);
            }}
          />
        </div>
      </Card>

      <Section title="Profile">
        <Row id="profile.display-name" label="Display name" description="How your name shows in chats and calls.">
          <TextField
            aria-label="Display name"
            value={name}
            maxLength={256}
            disabled={busy}
            onChange={(e) => setNameD(e.target.value)}
            onAccepted={() => void save()}
          />
          {nameD !== null && !name.trim() && <Hint tone="danger">Your display name can't be empty.</Hint>}
        </Row>
        <Row id="profile.about-me" label="About me" description="A short line people see on your profile.">
          <TextField aria-label="About me" placeholder="Say something about yourself" value={bio} disabled={busy} onChange={(e) => setBioD(e.target.value)} onAccepted={() => void save()} />
        </Row>
        <Row
          id="profile.colour"
          label="Your colour"
          description="Colours your name in chats."
          control={
            <div className={p.swatches} data-swatch-row="">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  aria-pressed={accent.toLowerCase() === c}
                  className={cx(p.swatch, accent.toLowerCase() === c && p.swatchOn)}
                  style={{ backgroundColor: c }}
                  disabled={busy}
                  onClick={() => setAccentD(c)}
                />
              ))}
              <Button flat text="Clear" disabled={busy || !accent} onClick={() => setAccentD("")} />
            </div>
          }
        />
      </Section>

      {/* selfhost/firstrun item 1: join sounds live in the soundboard — not on a server without one */}
      {soundboardOn && (
      <Section id="join-sound">
        <Row id="profile.join-sound" label="Join sound" description="Plays for everyone in the call when you join — up to 3 seconds, at their soundboard volume.">
          <div className={p.fieldRow}>
            <ComboBox
              className={p.fill}
              aria-label="Join sound"
              model={model}
              textRole="name"
              currentIndex={idx}
              disabled={busy}
              onActivated={(i) => {
                stopPreview();
                setChosen(model[i].url);
                void saveJoinSound(model[i].url);
              }}
            />
            <Button
              text={previewing ? "Stop" : "Preview"}
              icon={previewing ? "media-playback-stop" : "media-playback-start"}
              disabled={!chosen}
              onClick={() => togglePreview(chosen)}
            />
          </div>
          <SearchField placeholder="Search sound effects…" aria-label="Search sound effects" value={q} disabled={busy} onValueChange={setQ} />
          {(search.searching || (q.length > 0 && search.results.length === 0)) && <Hint>{search.searching ? "Searching…" : "No sounds found."}</Hint>}
          {q.length > 0 && search.results.length > 0 && (
            <div className={p.results} style={{ maxHeight: Math.min(search.results.length, 5) * 43.2 }}>
              {search.results.map((r, i) => {
                const isPlaying = !!r.url && r.url === playing;
                const isChosen = !!r.url && r.url === chosen;
                return (
                  <div key={`${r.url}-${i}`} className={cx(p.resRow, isPlaying && p.resPlaying)} onClick={() => togglePreview(r.url)}>
                    <Icon
                      name={isPlaying ? "media-playback-stop" : "media-playback-start"}
                      size={16}
                      color={isPlaying ? "var(--th-settings-sound-row-icon-active)" : "var(--th-settings-sound-row-icon)"}
                      staticOnly
                    />
                    <span className={p.resName}>{r.name || r.url}</span>
                    <BasicToolButton
                      text={isChosen ? "Join sound" : "Use"}
                      iconName={isChosen ? "checkmark-symbolic" : undefined}
                      disabled={isChosen || !r.url}
                      tip="Play this when you join a call"
                      onClick={(e) => {
                        e.stopPropagation();
                        const known = sounds.some((s) => (s.sourceUrl || s.url || "") === r.url);
                        if (!known) void addPersonalSound(r.name || "Sound", r.url, r.emoji || "", Math.floor(r.duration || 0)).catch(() => undefined);
                        setChosen(r.url);
                        void saveJoinSound(r.url);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {sounds.length === 0 && q.length === 0 && <Hint>Search above to find a sound, or add some to your soundboard first.</Hint>}
        </Row>
      </Section>
      )}

      <Section id="email">
        <Row id="profile.email" label="Email address" description="Lets you reset your password if you forget it. Only the server sees it.">
          {prof.emails.map((a) => (
            <div key={a} className={p.fieldRow}>
              <span className={cx(p.emailAddr, p.fill)}>{a}</span>
              <Button flat text="Remove" disabled={busy} onClick={() => setConfirmEmailAddr(a)} />
            </div>
          ))}
          <div className={p.fieldRow}>
            <TextField
              className={p.fill}
              type="email"
              inputMode="email"
              autoCapitalize="off"
              aria-label="Add an email address"
              placeholder="you@example.com"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
              onAccepted={(v) => void addEmail(v)}
            />
            <Button text="Add" disabled={busy || email.indexOf("@") <= 0} onClick={() => void addEmail(email)} />
          </div>
          {prof.emailPending && (
            <div className={p.fieldRow}>
              <TextField
                className={p.fill}
                type="password"
                aria-label="Your password, to confirm"
                placeholder="Your password, to confirm"
                value={emailPw}
                disabled={busy}
                onChange={(e) => setEmailPw(e.target.value)}
                onAccepted={(v) => {
                  void confirmEmail(v);
                  setEmailPw("");
                }}
              />
              <Button
                highlighted
                text="Confirm"
                disabled={busy || emailPw.length === 0}
                onClick={() => {
                  void confirmEmail(emailPw);
                  setEmailPw("");
                }}
              />
            </div>
          )}
          {prof.emailStatus && <Hint>{prof.emailStatus}</Hint>}
        </Row>
      </Section>

      {dirty && (
        <div className={p.saveBar} role="region" aria-label="Unsaved changes" data-save-bar="">
          <span className={cx(p.saveText, status && isErrorStatus(status) && p.saveTextErr)}>{status || "You have unsaved changes."}</span>
          <Button flat text="Reset" disabled={busy} onClick={reset} />
          <Button highlighted text="Save changes" disabled={!canSave} onClick={() => void save()} />
        </div>
      )}

      <ConfirmDialog
        open={confirmAvatar}
        className={phone ? dlg.bottomSheet : undefined}
        onClose={() => setConfirmAvatar(false)}
        dialogTitle="Remove your photo?"
        message="Your picture comes off your profile for everyone."
        confirmText="Remove"
        destructive
        onConfirmed={() => void clearAvatar()}
      />
      <ConfirmDialog
        open={confirmEmailAddr !== null}
        className={phone ? dlg.bottomSheet : undefined}
        onClose={() => setConfirmEmailAddr(null)}
        dialogTitle="Remove this email address?"
        message={`Remove ${confirmEmailAddr ?? ""}? It's what lets you reset your password if you ever forget it.`}
        confirmText="Remove"
        destructive
        onConfirmed={() => confirmEmailAddr && void removeEmail(confirmEmailAddr)}
      />
    </>
  );
}
