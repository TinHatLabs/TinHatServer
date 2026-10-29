// About & help pane — SETTINGS-WINDOW.md §5 (NEW; replaces the About sheet: the ☰ "About Tin Hat" and every bus
// `openAbout` open this pane). Header card: the Tin Hat mark 56, "Tin Hat" 17/600, "Version X (build) · channel",
// "Check for updates" (web: the nav's one updater — version.json; a newer deploy → "Reload to update") and "What's
// new". Card Help: Take the tour (closes the window, starts the tour), Keyboard shortcuts (the nav's dialog), Report
// a problem (the bug-report dialog). Card Account: "Signed in as …" + Sign out (the existing confirmation). Footer:
// the one-line About blurb.
import { useState } from "react";
import { bus } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { useServerFeature } from "@/core/server";
import { Button, cx, useIsMobile } from "@/ui";
import { checkForUpdates, useUpdate } from "@/features/nav";
import { chooseServer, hasNativeCap } from "@/features/native";
import { APP_VERSION } from "../logs";
import { buildHash } from "../sheets";
import { nativeInfo } from "@/features/native/bridge";
import { closeSettings } from "../store";
import { Card, Row, Section } from "../rows";
import p from "./panes.module.css";

/** Web, or Web · staging at <host>/next/ (the build says "dev" in a dev server) */
function channel(): string {
  // inside a Tin Hat app: which app and its own version (bug reports need both)
  const app = nativeInfo();
  if (app) return `${app.platform === "ios" ? "iPhone app" : app.platform === "macos" ? "Mac app" : "Android app"}${app.app ? ` ${app.app}` : ""}`;
  return /\/next\//.test(location.pathname) ? "Web · staging" : "Web";
}

async function releaseNotes(): Promise<{ version?: string; notes?: string } | null> {
  try {
    const r = await fetch(location.pathname.replace(/[^/]*$/, "") + "version.json", { cache: "no-store" });
    return r.ok ? ((await r.json()) as { version?: string; notes?: string }) : null;
  } catch {
    return null;
  }
}

export function AboutPane() {
  const { userId = "", hsUrl = "" } = useSession();
  const upd = useUpdate();
  const phone = useIsMobile();
  const reportsOn = useServerFeature("reports"); // docs/SELFHOST.md: no reports inbox on this server → no row
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);

  const check = () => {
    const before = useUpdate.getState().checkedAt;
    setFailed(false);
    setAsked(true);
    void checkForUpdates().then(() => setFailed(useUpdate.getState().checkedAt === before));
  };
  const updateLine = upd.checking
    ? "Checking for updates…"
    : upd.available
      ? `Version ${upd.next} is ready — reload to update.`
      : failed
        ? "Couldn't check right now — this server doesn't answer with a version file."
        : asked && upd.checkedAt
          ? "You're up to date."
          : upd.checkedAt
            ? "Up to date when last checked."
            : "Updates are checked when Tin Hat starts.";
  const whatsNew = async () => {
    const v = await releaseNotes();
    // the running release's notes (or the waiting one's when an update is ready — the nav's sheet shows either)
    bus.emit("openWhatsNew", v && v.notes ? { version: v.version, notes: v.notes } : {});
  };

  return (
    <>
      <Card className={p.headCard}>
        <div className={p.headRow} data-setting="about.updates">
          <img className={p.mark} src={`${import.meta.env.BASE_URL}appicon/tinhat-256.png`} alt="" width={56} height={56} draggable={false} />
          <div className={p.headText}>
            <span className={p.headName}>Tin Hat</span>
            <span className={p.headSub}>
              Version {APP_VERSION} ({buildHash()}) · {channel()}
            </span>
            <span className={cx(p.headSub, upd.available && p.okText, failed && p.errText)} role="status" data-update-status="">
              {updateLine}
            </span>
          </div>
          <div className={p.headButtons}>
            {upd.available ? (
              <Button highlighted text="Reload to update" icon="view-refresh-symbolic" onClick={() => location.reload()} />
            ) : (
              <Button text={upd.checking ? "Checking…" : "Check for updates"} disabled={upd.checking} onClick={check} />
            )}
            <span data-setting="about.whats-new" className={p.flashWrap}>
              <Button flat text="What's new" onClick={() => void whatsNew()} />
            </span>
          </div>
        </div>
      </Card>

      <Section title="Help">
        <Row
          id="about.tour"
          label="Take the tour"
          description="A quick walk around Tin Hat — where everything is."
          control={
            <Button
              text="Start tour"
              icon="help-hint-symbolic"
              onClick={() => {
                closeSettings();
                bus.emit("openTour", {});
              }}
            />
          }
        />
        {!phone && (
          <Row
            id="about.shortcut-list"
            label="Keyboard shortcuts"
            description="Every key Tin Hat knows. Change them under Shortcuts."
            control={<Button text="Show" icon="input-keyboard-symbolic" onClick={() => bus.emit("openShortcuts", {})} />}
          />
        )}
        {reportsOn && (
          <Row
            id="about.report"
            label="Report a problem"
            description="Tell your server's owner what went wrong — it goes straight to their problem reports."
            control={<Button text="Report…" icon="tools-report-bug-symbolic" onClick={() => bus.emit("openBugReport", {})} />}
          />
        )}
      </Section>

      <Section title="Account">
        <Row
          id="about.sign-out"
          label="Signed in as"
          description={userId}
          control={<Button flat className={p.signOut} text="Sign out" onClick={() => bus.emit("requestSignOut", {})} />}
        />
        {/* a Tin Hat app (bridge "servers"): its own server chooser — features/native */}
        {hasNativeCap("servers") && (
          <Row
            label="Server"
            description={hsUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}
            control={<Button text="Switch server" icon="network-server-symbolic" onClick={chooseServer} />}
          />
        )}
      </Section>

      <p className={p.footer}>Tin Hat Web — the Tin Hat app in your browser: the same rooms, calls and people, nothing to install. It updates whenever the page reloads.</p>
    </>
  );
}
