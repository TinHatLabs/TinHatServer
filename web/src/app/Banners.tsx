// Banners.tsx — Main.qml `header:` — ONE window-wide strip above everything (10.1 TH-SHELL-08):
//   verify   "This device isn't verified, so encrypted messages can't be read. Verify it from a
//            device you're already signed in to."  [Verify…]        (Warning)
//   offline  "Can't reach the server — reconnecting… New messages will catch up when it's back."
//            (Warning; three sync failures in a row, clears on the first success)
//   update   the web's self-update: a newer build is on the server → "Update available — reload to
//            get it." [Reload now] (Information) — the native "Update installed … restart to apply"
// Each is a Kirigami.InlineMessage with Layout.margins smallSpacing (4 px round it). 10.8: in the desktop's islands look
// (`islandMargin`) each banner takes the islands' margin on the left, right and top and none below — the dock host's
// own margin is the gap under the strip, the same as between islands — so the strip lines up with the island edges;
// the Flat style and phones keep the 4 px.
// (Safe mode has no browser equivalent: there is no GPU-driver fallback to announce.)
import { useEffect, useState, type CSSProperties } from "react";
import { useCryptoStatus, useSession } from "@/core/matrix";
import { keyFirst } from "@/core/matrix/moved";
import { isGuestAccount } from "@/core/server/offer";
import { bus } from "@/core/bus";
import { InlineMessage, showToast } from "@/ui";
// ADDITIVE (nav, see features/nav/CORE-CHANGES.md): the version.json updater state + What's new sheet
import { openWhatsNew, useUpdate } from "@/features/nav";
// 11.0: the layout notices (features/editmode/layoutDoc.ts)
import { clearOverride, keepOverride, resolveConflict, useRendered } from "@/features/editmode/layoutDoc";
import s from "./Shell.module.css";

export function BannerStrip({ islandMargin }: { islandMargin?: number } = {}) {
  const session = useSession();
  const crypto = useCryptoStatus();
  const bundleChanged = useUpdateAvailable();
  const nav = useUpdate();
  const update = bundleChanged || nav.available;
  const loggedIn = session.state === "ready" || session.state === "syncing";
  // F1: not while a brand-new account's first device is still setting its encryption up (it ends verified)
  // a temporary guest account (docs/GUESTS.md) has nothing to verify against and leaves within 12 hours: no banner
  const showVerify = loggedIn && !crypto.loading && crypto.cryptoReady && !crypto.thisDeviceVerified && !crypto.firstDevicePending && !isGuestAccount(session.userId);
  const showOffline = loggedIn && session.syncDown;
  const updateText = nav.available && nav.next ? `Update available: v${nav.current || ((import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev")} → v${nav.next}` : undefined;
  return <BannerStripView verify={showVerify} verifyKey={showVerify && keyFirst(crypto)} offline={showOffline} update={update} updateText={updateText} islandMargin={islandMargin} />;
}

/**
 * 11.0 (EDITMODE-UI §9, §13): the layout notices, in the same strip style — "Layout reset on this device." while the
 * device-local reset override is on (Keep for all devices / Restore), and the sync conflict of the active layout
 * ("Your layout change was replaced by a newer one from another device." Restore mine / Dismiss).
 */
export function ResetBanner({ islandMargin }: { islandMargin?: number } = {}) {
  const r = useRendered();
  const override = r.source === "override";
  if (!override && !r.conflict) return null;
  return (
    <div
      className={s.banners}
      role="region"
      aria-label="Layout notices"
      data-islands={islandMargin !== undefined ? "" : undefined}
      style={islandMargin !== undefined ? ({ ["--banner-margin" as string]: `${islandMargin}px` } as CSSProperties) : undefined}
    >
      {override && (
        <InlineMessage
          type="information"
          className={s.banner}
          text="Layout reset on this device."
          actions={[
            {
              text: "Keep for all devices",
              onTriggered: () => {
                if (keepOverride() === "busy") showToast("Finish editing the layout first (Done or Cancel).", 4000);
              },
            },
            { text: "Restore", onTriggered: () => clearOverride() },
          ]}
        />
      )}
      {!override && r.conflict && (
        <InlineMessage
          type="warning"
          className={s.banner}
          text="Your layout change was replaced by a newer one from another device."
          actions={[
            { text: "Restore mine", onTriggered: () => void resolveConflict(true) },
            { text: "Dismiss", onTriggered: () => void resolveConflict(false) },
          ]}
        />
      )}
    </div>
  );
}

/** The strip itself (also used by the gallery replica). */
export function BannerStripView({ verify, verifyKey, offline, update, updateText, islandMargin }: { verify?: boolean; verifyKey?: boolean; offline?: boolean; update?: boolean; updateText?: string; islandMargin?: number }) {
  if (!verify && !offline && !update) return null;
  return (
    <div
      className={s.banners}
      role="region"
      aria-label="Notices"
      data-islands={islandMargin !== undefined ? "" : undefined}
      style={islandMargin !== undefined ? ({ ["--banner-margin" as string]: `${islandMargin}px` } as CSSProperties) : undefined}
    >
      {verify && (
        <InlineMessage
          type="warning"
          className={s.banner}
          text={
            verifyKey // no identity to verify against (a moved server): the Security Key is the way in (core/matrix/moved.ts)
              ? "Encrypted messages can't be read on this device yet. Unlock them with your Security Key."
              : "This device isn't verified, so encrypted messages can't be read. Verify it from a device you're already signed in to."
          }
          actions={[{ text: verifyKey ? "Unlock…" : "Verify…", onTriggered: () => bus.emit("openVerifyDialog", {}) }]}
        />
      )}
      {offline && <InlineMessage type="warning" className={s.banner} text="Can't reach the server — reconnecting… New messages will catch up when it's back." />}
      {update && (
        <InlineMessage
          type="information"
          className={s.banner}
          text={updateText ?? "Update available — reload to get the newest Tin Hat."}
          actions={[
            ...(updateText ? [{ text: "What's new", onTriggered: () => openWhatsNew() }] : []),
            { text: "Reload now", onTriggered: () => location.reload() },
          ]}
        />
      )}
    </div>
  );
}

/** The web's updater: the served index.html points at a different bundle than the one running. */
function useUpdateAvailable(): boolean {
  const [avail, setAvail] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const mine = [...document.querySelectorAll<HTMLScriptElement>("script[type=module][src]")].map((s) => new URL(s.src, location.href).pathname);
    if (!mine.length) return;
    const check = async () => {
      try {
        const r = await fetch(location.pathname.replace(/[^/]*$/, "") + "index.html", { cache: "no-store" });
        if (!r.ok) return;
        const html = await r.text();
        const srcs = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], location.href).pathname);
        if (srcs.length && !srcs.some((x) => mine.includes(x))) setAvail(true);
      } catch {
        /* offline — the offline banner covers it */
      }
    };
    const t = window.setInterval(check, 15 * 60 * 1000);
    const onVis = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return avail;
}
