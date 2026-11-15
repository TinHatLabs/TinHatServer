// Privacy pane — SETTINGS-WINDOW.md §5: cards Your status (switch + "Others see you as"), Time zone (switch, zone),
// Call recordings ("Never record me"), Diagnostics (switch + Create / Open report), Automatic log sharing (switch).
// The long paragraphs became row descriptions and one note per card, keeping every fact that matters (what is shared,
// that nothing is uploaded, that messages are never logged). The status / time-zone logic is presence's (REACH §2.7,
// A7) — the same store calls its own Settings sections made.
import { useState } from "react";
import { setPref, usePref } from "@/core/prefs";
import { useSession } from "@/core/matrix";
import { useServerFeature } from "@/core/server";
import { Button } from "@/ui";
import { PresenceLine, pickTz, setTzShare, turnSharingOff, turnSharingOn, useMyPresence, usePresenceStore, useTzStore } from "@/features/presence";
import { TZ_HINT, TZ_SWITCH } from "@/features/presence/controls";
import { ZONE_CHOICES, zoneChoiceText } from "@/widgets/clocks";
import { LOGSHIP_ENABLED, applyLogship, buildDiagnosticsReport } from "../logs";
import { Buttons, ComboRow, Hint, NoteRow, Row, Section, SwitchRow } from "../rows";
import { IgnoredPeopleSection } from "@/features/safety";
import { localNowMs, reportFileName } from "../reportName";

let reportUrl = "";
let diagStatus = "";

export function PrivacyPane() {
  const optout = usePref("record-optout", "0");
  const memoriesOn = useServerFeature("memories");
  const presenceOn = useServerFeature("presence");
  const reportsOn = useServerFeature("reports"); // docs/SELFHOST.md: "Your status" and the time zone are the Reach service's
  const ship = usePref("logship", "");
  const [status, setStatusText] = useState(diagStatus);
  const [url, setUrl] = useState(reportUrl);
  const say = (s: string) => setStatusText((diagStatus = s));

  // P18: no opt-in switch (it gated nothing but this button); the report is made only when the user presses it
  const create = () => {
    try {
      const text = buildDiagnosticsReport();
      if (reportUrl) URL.revokeObjectURL(reportUrl);
      reportUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      setUrl(reportUrl);
      const a = document.createElement("a");
      a.href = reportUrl;
      const name = reportFileName(localNowMs()); // A34.3: its own name, so a new report never replaces the last
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      say(`Saved to your Downloads as ${name} — open it, then send it to your server's owner in chat if you're happy with it.`);
    } catch (e) {
      say(`Couldn't write the report: ${(e as Error)?.message ?? e}`);
    }
  };

  return (
    <>
      {presenceOn && <YourStatus />}
      {presenceOn && <TimeZone />}

      {/* selfhost/firstrun item 1: only where the server records calls (Memories) */}
      {memoriesOn && (
        <Section title="Call recordings">
          <SwitchRow
            id="privacy.never-record"
            label="Never record me"
            description="When a call is recorded (🔴 REC), your camera, screen shares and voice are left out. Changes apply at once, also during a call."
            checked={optout === "1"}
            onToggled={(on) => setPref("record-optout", on ? "1" : "0")}
          />
        </Section>
      )}

      <Section title="Diagnostics">
        <Row
          id="privacy.diagnostics"
          label="Create a report"
          description="Saves a text file to your Downloads: your app log (tokens and keys stripped) and your audio/video settings. Messages are never logged."
          control={
            <Buttons>
              {url && <Button flat text="Open report" onClick={() => window.open(url, "_blank", "noopener")} />}
              <Button text="Create report" onClick={create} />
            </Buttons>
          }
        >
          {status && <Hint>{status}</Hint>}
        </Row>
      </Section>

      {/* docs/SELFHOST.md: logs go to the server's reports inbox — not on a server without one, never for a guest account */}
      {reportsOn && (
      <Section title="Automatic log sharing">
        <SwitchRow
          id="privacy.log-sharing"
          label="Send my debug logs automatically"
          description="On startup, sends the previous session's app log to your server's owner so bugs get fixed. Tokens, keys and IP addresses are stripped; messages are never logged. Takes effect at once."
          checked={LOGSHIP_ENABLED && ship === "1"}
          disabled={!LOGSHIP_ENABLED}
          onToggled={(on) => applyLogship(on)}
        />
        {!LOGSHIP_ENABLED && (
          <NoteRow>Not available in the browser yet — the log receiver isn't reachable from the web app. Report a problem and diagnostic reports still work.</NoteRow>
        )}
      </Section>
      )}

      {/* account safety (features/safety): the people I ignore, each with Stop ignoring */}
      <IgnoredPeopleSection />
    </>
  );
}

/** "Your status" (REACH §2.7, A2.1): the switch, "Others see you as" (the server's view of you), the promise. */
function YourStatus() {
  const share = usePresenceStore((st) => st.share);
  const turningOff = usePresenceStore((st) => st.turningOff);
  const busy = usePresenceStore((st) => st.busy);
  const known = usePresenceStore((st) => st.known);
  const error = usePresenceStore((st) => st.error);
  return (
    <Section title="Your status">
      <SwitchRow
        id="privacy.share-status"
        label={turningOff ? "Turning off…" : "Share my status"}
        description="Off by default. On: people who share a room with you see Online, Away or In a call — never a last-seen time, never what you're doing."
        checked={share && !turningOff}
        // "Turning off…" may wait for the server; turning it back on meanwhile cancels that (never disabled then)
        disabled={!known || busy}
        switchAttrs={{ "aria-label": "Share my status" }}
        onToggled={(on) => void (on ? turnSharingOn() : turnSharingOff())}
      />
      {share && <SeenAs />}
      <NoteRow>
        Turning it off stops the sharing at once; it leaves other people's screens within about 20 seconds and nothing is kept. Messages, typing and read receipts are separate. Other
        chat apps you use may report your status on their own.
      </NoteRow>
      {error && <NoteRow tone="danger">{error}</NoteRow>}
    </Section>
  );
}

/** A2.15: "Others see you as …" = your own row in GET /api/presence, never local state ("checking…" until listed). */
function SeenAs() {
  const me = useMyPresence();
  const myId = useSession().userId ?? "";
  return (
    <Row
      label="Others see you as"
      attrs={{ "data-seen-as": me ? me.state : "none" }}
      control={me ? <PresenceLine mxid={myId} normal /> : <Hint>checking…</Hint>}
    />
  );
}

/** "Time zone" (REACH A7): "Share my time zone" (on by default) + the zone (Automatic = this device's). */
function TimeZone() {
  const t = useTzStore();
  const share = t.pref ? t.pref.share : t.known; // absent after the first sync = the first-run write is on its way (ON)
  const auto = t.pref ? t.pref.auto : true;
  const picked = t.pref && !auto ? t.pref.tz : "";
  const choices = ["", ...ZONE_CHOICES, ...(picked && !ZONE_CHOICES.includes(picked) ? [picked] : [])];
  const text = (z: string) => (z ? zoneChoiceText(z) : t.device ? `Automatic (${zoneChoiceText(t.device)})` : "Automatic");
  return (
    <Section title="Time zone">
      <SwitchRow
        id="privacy.share-time-zone"
        label={TZ_SWITCH}
        description={TZ_HINT}
        checked={share}
        disabled={!t.known || t.busy}
        switchAttrs={{ "data-tz-switch": "" }}
        onToggled={(on) => void setTzShare(on)}
      />
      <ComboRow
        id="privacy.time-zone"
        label="Your time zone"
        description="Automatic follows this device."
        model={choices}
        textRole={text}
        currentIndex={Math.max(0, choices.indexOf(picked))}
        disabled={!t.known || t.busy}
        onActivated={(_i, z) => void pickTz(z)}
      />
      {t.error && <NoteRow tone="danger">{t.error}</NoteRow>}
    </Section>
  );
}
