// Overlay pane — SETTINGS-WINDOW.md §5. Native = the KDE layer-shell HUD over fullscreen games; the web drives a
// Document Picture-in-Picture window (docs/WEB-EXCEPTIONS.md). Card Voice overlay: the unavailable note first when
// the browser can't, the switch, Show, Corner, Hide while screen sharing, Preview (10 s).
import { setPref, usePref } from "@/core/prefs";
import { useFormFactor } from "@/core/device";
import { Button } from "@/ui";
import { closeOverlayWindow, openOverlayWindow, overlayAvailable } from "../overlay";
import { ComboRow, NoteRow, Row, Section, SwitchRow } from "../rows";

const CORNERS = ["tl", "tr", "bl", "br"];

export function OverlayPane() {
  const enabled = usePref("overlay-enabled", "0") === "1";
  const mode = usePref("overlay-mode", "speaking");
  const corner = usePref("overlay-corner", "tl");
  const hide = usePref("overlay-hide-share", "0") === "1";
  useFormFactor(); // re-evaluate when the layout flips (phones have no always-on-top window)
  const avail = overlayAvailable();
  const rowsOn = enabled && avail;
  return (
    <Section id="voice-overlay">
      {!avail && <NoteRow tone="danger">Overlay unavailable: this browser can't open an always-on-top window.</NoteRow>}
      <SwitchRow
        id="overlay.overlay"
        label="Voice overlay"
        description="A small always-on-top window showing who's talking, over other apps and windows. Nothing is injected or scanned (no anti-cheat risk); keep games windowed or borderless to see it."
        disabled={!avail}
        checked={enabled}
        onToggled={(on) => {
          setPref("overlay-enabled", on ? "1" : "0");
          if (on) void openOverlayWindow();
          else closeOverlayWindow();
        }}
      />
      <ComboRow
        id="overlay.overlay-show"
        label="Show"
        disabled={!rowsOn}
        model={["Only while someone talks", "Always during a call"]}
        currentIndex={mode === "always" ? 1 : 0}
        onActivated={(i) => setPref("overlay-mode", i === 1 ? "always" : "speaking")}
      />
      <ComboRow
        id="overlay.overlay-corner"
        label="Corner"
        description={rowsOn ? "The browser decides where the window first appears — drag it to the corner you picked." : undefined}
        disabled={!rowsOn}
        model={["Top left", "Top right", "Bottom left", "Bottom right"]}
        currentIndex={Math.max(0, CORNERS.indexOf(corner))}
        onActivated={(i) => setPref("overlay-corner", CORNERS[i])}
      />
      <SwitchRow
        id="overlay.overlay-hide-sharing"
        label="Hide while screen sharing"
        description="Keeps the overlay out of your screen share when it's on the shared screen."
        disabled={!rowsOn}
        checked={hide}
        onToggled={(on) => setPref("overlay-hide-share", on ? "1" : "0")}
      />
      <Row
        label="Preview"
        description="Shows the overlay for 10 seconds."
        disabled={!avail}
        control={<Button text="Preview (10 s)" icon="view-preview-symbolic" disabled={!avail} onClick={() => void openOverlayWindow(10000)} />}
      />
    </Section>
  );
}
