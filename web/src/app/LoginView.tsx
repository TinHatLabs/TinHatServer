// LoginView.tsx — LoginView.qml, the sign-in screen, with its three faces:
//   sign in        Server / Username / Password → "Sign in" (GlowButton), then two quiet links:
//                  "Forgot your password?" and "New here? Create an account"
//   create (10.4)  Invite code ("TH-" prefix, only the last part is typed; a pasted full code
//                  loses its prefix), Username, Display name (optional), Password ×2, the rules
//                  hint (red when the passwords differ), "Create account", status, "Back to sign in"
//   reset          "We'll email you a link…", Email → "Email me a reset link" / "Resend the email",
//                  then New password ×2 → "Set new password"; done → "Back to sign in". A server that says its owner
//                  resets passwords (dev.tinhat.server.account.password_reset = "owner": Tin Hat Server sends no email)
//                  gets "ask the person who runs it" instead (asked when the face opens: "Checking <server>…")
// Layout: the theme bg with a huge soft accentBright glow disc hanging from the top; a centred
// 25-gridUnit card (radius 16, panel, lighter(sep) frame, a white 0.06 top-edge light, three soft
// shadow rings), content inset 1.5 gridUnits, spacing 8: the Tin Hat mark (64 px over an 80 px
// accent glow; its light sweeps while busy), "Tin Hat" (Heading 1), the face's subtitle.
// Status lines: only failures are red (dangerBright); "Signed out" / "your saved session…" and
// progress are dim; after 8 s busy the line admits "Still trying to reach <server>…".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOMESERVER,
  completePasswordReset,
  loginWithPassword,
  registerAccount,
  requestPasswordReset,
  useSession,
  validateRegistration,
} from "@/core/matrix";
import { GlowButton, TinHatLoader } from "@/ui";
import { isTouch } from "@/core/device";
import { readMove } from "@/core/server/move";
import { askPasswordReset } from "@/core/server/store";
import { chooseServer, hasNativeCap } from "@/features/native";
import { LoginField } from "./LoginField";
import { inviteFieldValue } from "./invite";
import { navigate, useRoute } from "./router";
import s from "./LoginView.module.css";

type Face = "signin" | "create" | "reset";

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

export function LoginView() {
  const session = useSession();
  const route = useRoute();
  const face: Face = route.name === "register" ? "create" : route.name === "forgot" ? "reset" : "signin";
  const setFace = (f: Face) => navigate(f === "create" ? "#/register" : f === "reset" ? "#/forgot" : "#/login", { replace: true });

  const [homeserver, setHomeserver] = useState(() => hostOf(session.hsUrl || DEFAULT_HOMESERVER));
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  // sign in
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  // create — the invite link's code (#/register?token=…), on a fresh load and (selfhost/firstrun item 4) whenever the
  // link is opened in this tab while it already shows Tin Hat: only the hash changes then, so follow the route
  const linkCode = route.name === "register" ? inviteFieldValue(route.token) : "";
  const [code, setCode] = useState(linkCode);
  useEffect(() => {
    if (linkCode) setCode(linkCode);
  }, [linkCode]);
  const [newUser, setNewUser] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [registerStatus, setRegisterStatus] = useState("");
  const [registerStage, setRegisterStage] = useState<"" | "created">("");
  // reset
  const [email, setEmail] = useState("");
  const [resetPw, setResetPw] = useState("");
  const [resetPw2, setResetPw2] = useState("");
  const [resetStage, setResetStage] = useState<"" | "sent" | "done">("");
  const [resetStatus, setResetStatus] = useState("");
  const pending = useRef<{ sid: string; clientSecret: string } | null>(null);
  // how this server gives a forgotten password back: asked when the reset face opens (the typed server may be any);
  // the name as the desktop writes it (no scheme, no slash, lower case)
  const [resetMode, setResetMode] = useState<"checking" | "owner" | "email">("email");
  const resetHost = hostOf(homeserver.trim()).toLowerCase();
  useEffect(() => {
    if (face !== "reset") return;
    let live = true;
    setResetMode("checking");
    void askPasswordReset().then((m) => {
      if (!live) return;
      setResetMode(m === "owner" ? "owner" : "email");
      if (m !== "owner") window.setTimeout(() => emailRef.current?.focus(), 0);
    });
    return () => {
      live = false;
    };
  }, [face, homeserver]);

  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const newUserRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLInputElement>(null);
  const newPwRef = useRef<HTMLInputElement>(null);
  const newPw2Ref = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const resetPwRef = useRef<HTMLInputElement>(null);
  const resetPw2Ref = useRef<HTMLInputElement>(null);

  // A server that moved to its own domain (Tin Hat Server: Move to your own domain): its old name's .well-known says
  // where it went (dev.tinhat.moved_to; core/matrix/moved.ts). This page IS the old address, so the way on is the
  // new one.
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    const host = hostOf(homeserver.trim()).toLowerCase();
    if (!host || (moved && moved.to === host)) return;
    setMoved(null);
    let live = true;
    const t = window.setTimeout(() => {
      void readMove(`https://${host}`).then((m) => {
        if (!live || !m.movedTo || m.movedTo === host) return;
        setMoved({ from: host, to: m.movedTo });
      });
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [homeserver]); // eslint-disable-line react-hooks/exhaustive-deps

  // The session's own line ("Signed out", "Your saved session couldn't be restored…").
  useEffect(() => {
    if (session.status) setStatus(session.status);
  }, [session.status]);

  // (TH-FIRST-22) after 8 s the status line admits it is still trying.
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(t);
  }, [busy]);

  // (TH-FIRST-17) the caret lands where you type next.
  const focusFirst = useCallback(() => {
    if (face === "reset") emailRef.current?.focus();
    else if (face === "create") (linkCode ? newUserRef : codeRef).current?.focus(); // the link filled the code
    else if (userRef.current?.value) passRef.current?.focus();
    else userRef.current?.focus();
  }, [face, linkCode]);
  useEffect(() => {
    // not on touch: the keyboard would come up at once and cover Password and Sign in (iPhone/iPad sweep, 2026-10-25)
    if (isTouch) return;
    const t = window.setTimeout(focusFirst, 0);
    return () => window.clearTimeout(t);
  }, [focusFirst]);

  // SET-101: dev-only self-test sign-in (native TINHAT_GUI_LOGIN=user:pw) — ?autologin=user:pw, once, 800 ms.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || autoTried.current) return;
    const m = /[?&]autologin=([^&#]+)/.exec(location.search + location.hash);
    if (!m) return;
    const [u, ...rest] = decodeURIComponent(m[1]).split(":");
    if (!u || !rest.length) return;
    autoTried.current = true;
    const t = window.setTimeout(() => {
      setUsername(u);
      setPassword(rest.join(":"));
      setStatus("Connecting…");
      setBusy(true);
      loginWithPassword({ homeserver, username: u, password: rest.join(":") })
        .then(() => setPassword(""))
        .catch((e) => setStatus((e as Error)?.message || String(e)))
        .finally(() => setBusy(false));
    }, 800);
    return () => window.clearTimeout(t);
  }, [homeserver]);

  const tryLogin = async () => {
    if (!username || !password || busy) return;
    setBusy(true);
    setStatus("Connecting…");
    try {
      await loginWithPassword({ homeserver, username, password });
      setStatus("Signed in");
      setPassword("");
    } catch (e) {
      setStatus((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const createReady = !busy && code.trim().length > 0 && newUser.trim().length > 0 && newPw.length >= 8 && newPw === newPw2;
  const tryCreate = async () => {
    if (!createReady) return;
    const problem = validateRegistration({ username: newUser.trim(), password: newPw, token: code.trim() });
    if (problem) {
      setRegisterStatus(problem);
      return;
    }
    setBusy(true);
    setRegisterStage("");
    setRegisterStatus("Checking the invite code…");
    try {
      await registerAccount({
        homeserver,
        username: newUser.trim().toLowerCase(),
        password: newPw,
        token: code.trim(),
        displayName: displayName.trim(),
        onCreated: () => {
          // the account exists and the normal sign-in is running: show that on the sign-in face
          setRegisterStage("created");
          setRegisterStatus("Account created — signing you in…");
          setUsername(newUser.trim().toLowerCase());
          setStatus("Account created — signing you in…");
          setFace("signin");
        },
      });
    } catch (e) {
      setRegisterStatus((e as Error)?.message || String(e));
      if (registerStage === "created") setStatus((e as Error)?.message || String(e));
    } finally {
      setNewPw("");
      setNewPw2("");
      setBusy(false);
    }
  };
  const leaveCreate = () => {
    setNewPw("");
    setNewPw2("");
    setRegisterStage("");
    setRegisterStatus("");
    setFace("signin");
    window.setTimeout(() => userRef.current?.focus(), 0);
  };

  const tryReset = async () => {
    if (busy || email.indexOf("@") <= 0) return;
    setBusy(true);
    setResetStatus("Sending reset email…");
    try {
      const r = await requestPasswordReset({ homeserver, email });
      pending.current = { sid: r.sid, clientSecret: r.clientSecret };
      setResetStage("sent");
      setResetStatus(r.message || `Check ${email.trim()} and click the link, then set a new password below.`);
      window.setTimeout(() => resetPwRef.current?.focus(), 0);
    } catch (e) {
      setResetStatus((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  const tryResetComplete = async () => {
    if (busy || resetPw.length < 8 || resetPw !== resetPw2) return;
    if (!pending.current) {
      setResetStatus("Ask for a reset email first.");
      return;
    }
    setBusy(true);
    setResetStatus("Setting your new password…");
    try {
      await completePasswordReset({ homeserver, sid: pending.current.sid, clientSecret: pending.current.clientSecret, newPassword: resetPw });
      pending.current = null;
      setResetStage("done");
      setResetStatus("Password changed. Sign in with your new password.");
    } catch (e) {
      setResetStatus((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  const leaveReset = () => {
    setResetPw("");
    setResetPw2("");
    pending.current = null;
    setResetStage("");
    setResetStatus("");
    setFace("signin");
    window.setTimeout(() => passRef.current?.focus(), 0);
  };
  const openReset = () => {
    if (busy) return;
    // seed the email box with the username only if it already looks like an address
    if (username.indexOf("@") > 0 && !email) setEmail(username);
    setFace("reset");
  };

  const subtitle = face === "reset" ? "Reset your password" : face === "create" ? "Create your account" : "Sign in to continue";
  const pwMismatch = newPw2.length > 0 && newPw2 !== newPw;
  // a moved server: the notice above says what happened, not "you were signed out"
  const statusShown = face === "signin" && !moved && (status.length > 0 || (busy && slow));
  const statusText = busy && slow ? `Still trying to reach ${homeserver}…` : status;
  const statusDim = busy || /^(signed out|you were signed out|your saved session|account created|connecting|signed in)/i.test(status);
  const glowSize = useGlowSize();

  return (
    <div className={s.view}>
      <div className={s.glow} style={{ width: glowSize, height: glowSize, marginTop: -glowSize * 0.55, marginLeft: -glowSize / 2 }} />
      <div className={s.cardWrap}>
        <div className={s.card}>
          <div className={s.topLight} />
          <div className={s.col}>
            <div className={s.mark}>
              <div className={s.markGlow} />
              <TinHatLoader size={64} running={busy} />
            </div>
            <h1 className={s.heading}>Tin Hat</h1>
            <div className={s.subtitle}>{subtitle}</div>
            <div className={s.spacer} />
            <LoginField
              label="Server"
              icon="network-server-symbolic"
              value={homeserver}
              onChange={setHomeserver}
              onAccepted={() => (face === "signin" ? userRef.current?.focus() : face === "create" ? codeRef.current?.focus() : emailRef.current?.focus())}
              disabled={busy}
              name="homeserver"
              autoComplete="url"
            />
            {face === "signin" && moved && (
              <div className={`${s.small} ${s.center}`} role="status">
                {`This server moved to ${moved.to}. Sign in there with the same username and password.`}
              </div>
            )}
            {face === "signin" && moved && (
              <GlowButton className={s.wide} text={`Go to ${moved.to}`} onClick={() => location.assign(`https://${moved.to}/`)} />
            )}
            {face === "signin" && !moved && (
              <>
                <LoginField
                  ref={userRef}
                  label="Username"
                  icon="user-symbolic"
                  placeholder="you"
                  value={username}
                  onChange={setUsername}
                  onAccepted={() => passRef.current?.focus()}
                  disabled={busy}
                  name="username"
                  autoComplete="username"
                />
                <LoginField
                  ref={passRef}
                  label="Password"
                  icon="lock-symbolic"
                  password
                  value={password}
                  onChange={setPassword}
                  onAccepted={tryLogin}
                  disabled={busy}
                  name="password"
                  autoComplete="current-password"
                />
                <GlowButton className={s.wide} text="Sign in" busy={busy} disabled={!(username.length > 0 && password.length > 0)} onClick={tryLogin} />
                <button type="button" className={s.link} disabled={busy} onClick={openReset}>
                  Forgot your password?
                </button>
                <button type="button" className={s.link} disabled={busy} onClick={() => setFace("create")}>
                  New here? Create an account
                </button>
                {/* a Tin Hat app (bridge "servers"): its own server chooser — features/native */}
                {hasNativeCap("servers") && (
                  <button type="button" className={s.link} disabled={busy} onClick={chooseServer}>
                    Switch server
                  </button>
                )}
              </>
            )}
            {face === "create" && (
              <div className={s.group}>
                <LoginField
                  ref={codeRef}
                  label="Invite code"
                  icon="mail-message-symbolic"
                  prefix="TH-"
                  placeholder="XXXX-XXXX"
                  value={code}
                  onChange={(t) => setCode(/^\s*th-/i.test(t) ? t.replace(/^\s*th-/i, "") : t)}
                  onAccepted={() => newUserRef.current?.focus()}
                  disabled={busy}
                  name="invite"
                  autoComplete="off"
                />
                <LoginField
                  ref={newUserRef}
                  label="Username"
                  icon="user-symbolic"
                  placeholder="lowercase, no spaces"
                  value={newUser}
                  onChange={setNewUser}
                  onAccepted={() => displayRef.current?.focus()}
                  disabled={busy}
                  name="new-username"
                  autoComplete="username"
                />
                <LoginField
                  ref={displayRef}
                  label="Display name (optional)"
                  icon="contact-new-symbolic"
                  placeholder="How people see you"
                  value={displayName}
                  onChange={setDisplayName}
                  onAccepted={() => newPwRef.current?.focus()}
                  disabled={busy}
                  name="display-name"
                  autoComplete="nickname"
                />
                <LoginField
                  ref={newPwRef}
                  label="Password"
                  icon="lock-symbolic"
                  password
                  value={newPw}
                  onChange={setNewPw}
                  onAccepted={() => newPw2Ref.current?.focus()}
                  disabled={busy}
                  name="new-password"
                  autoComplete="new-password"
                />
                <LoginField
                  ref={newPw2Ref}
                  label="Password again"
                  icon="lock-symbolic"
                  password
                  value={newPw2}
                  onChange={setNewPw2}
                  onAccepted={tryCreate}
                  disabled={busy}
                  name="new-password-again"
                  autoComplete="new-password"
                />
                <div className={`${s.small} ${s.center}`} style={{ color: pwMismatch ? "var(--th-login-error-fg)" : "var(--th-login-hint-fg)" }}>
                  {pwMismatch
                    ? "The passwords don't match."
                    : "Usernames are lowercase letters, numbers, dots, dashes and underscores. Passwords are at least 8 characters."}
                </div>
                <GlowButton className={s.wide} text="Create account" busy={busy} disabled={!createReady} onClick={tryCreate} />
                {registerStatus && (
                  <div
                    className={`${s.small} ${s.center}`}
                    style={{ color: busy || registerStage === "created" ? "var(--th-login-hint-fg)" : "var(--th-login-error-fg)" }}
                  >
                    {registerStatus}
                  </div>
                )}
                <button type="button" className={s.link} disabled={busy} onClick={leaveCreate}>
                  Back to sign in
                </button>
              </div>
            )}
            {face === "reset" && resetMode !== "email" && (
              <div className={s.group}>
                {resetMode === "checking" ? (
                  <div className={`${s.small} ${s.center} ${s.dim}`} role="status">
                    Checking {resetHost}…
                  </div>
                ) : (
                  <div className={`${s.small} ${s.center}`} data-reset="owner">
                    This server doesn't send email. Ask the person who runs {resetHost} to set a new password for you: they do it on the
                    server's dashboard, under People. Sign in with the password they give you, then choose your own in Settings → Devices
                    &amp; security → Change password.
                  </div>
                )}
                <button type="button" className={s.link} onClick={leaveReset}>
                  Back to sign in
                </button>
              </div>
            )}
            {face === "reset" && resetMode === "email" && (
              <div className={s.group}>
                {resetStage !== "done" && (
                  <div className={`${s.small} ${s.center} ${s.dim}`}>We'll email you a link. Open it, then set a new password here.</div>
                )}
                {resetStage !== "done" && (
                  <LoginField
                    ref={emailRef}
                    label="Email"
                    icon="mail-message-symbolic"
                    placeholder="you@example.com"
                    value={email}
                    onChange={setEmail}
                    onAccepted={tryReset}
                    disabled={busy}
                    name="email"
                    autoComplete="email"
                    inputMode="email"
                  />
                )}
                {resetStage !== "done" && (
                  <GlowButton
                    className={s.wide}
                    text={resetStage === "sent" ? "Resend the email" : "Email me a reset link"}
                    busy={busy}
                    disabled={busy || email.indexOf("@") <= 0}
                    onClick={tryReset}
                  />
                )}
                {resetStage === "sent" && (
                  <>
                    <div className={s.spacer} />
                    <LoginField
                      ref={resetPwRef}
                      label="New password"
                      icon="lock-symbolic"
                      password
                      value={resetPw}
                      onChange={setResetPw}
                      onAccepted={tryResetComplete}
                      disabled={busy}
                      name="reset-password"
                      autoComplete="new-password"
                    />
                    <LoginField
                      ref={resetPw2Ref}
                      label="Confirm new password"
                      icon="lock-symbolic"
                      password
                      value={resetPw2}
                      onChange={setResetPw2}
                      onAccepted={tryResetComplete}
                      disabled={busy}
                      name="reset-password-again"
                      autoComplete="new-password"
                    />
                    {resetPw2.length > 0 && resetPw !== resetPw2 && (
                      <div className={`${s.small} ${s.center}`} style={{ color: "var(--th-login-error-fg)" }}>
                        Those two don't match.
                      </div>
                    )}
                    <GlowButton
                      className={s.wide}
                      text="Set new password"
                      busy={busy}
                      disabled={busy || resetPw.length < 8 || resetPw !== resetPw2}
                      onClick={tryResetComplete}
                    />
                  </>
                )}
                {resetStage === "done" && <GlowButton className={s.wide} text="Back to sign in" onClick={leaveReset} />}
                {resetStatus && (
                  <div
                    className={`${s.small} ${s.center}`}
                    style={{ color: busy || resetStage.length > 0 ? "var(--th-login-hint-fg)" : "var(--th-login-error-fg)" }}
                  >
                    {resetStatus}
                  </div>
                )}
                {resetStage !== "done" && (
                  <button type="button" className={s.link} disabled={busy} onClick={leaveReset}>
                    Back to sign in
                  </button>
                )}
              </div>
            )}
            {statusShown && (
              <div className={`${s.small} ${s.center}`} style={{ color: statusDim ? "var(--th-login-hint-fg)" : "var(--th-login-error-fg)" }} role="status">
                {statusText}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The top glow disc is max(width, height) × 0.9 of the view. */
function useGlowSize(): number {
  const get = () => Math.max(window.innerWidth, window.innerHeight) * 0.9;
  const [v, setV] = useState(get);
  useEffect(() => {
    const on = () => setV(get());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return useMemo(() => v, [v]);
}
