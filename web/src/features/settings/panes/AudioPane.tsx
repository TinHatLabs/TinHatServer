// Audio pane — SETTINGS-WINDOW.md §5 (Main.qml Audio + §5 browser equivalents). Card Microphone: Input device, Input
// level (meter + the no-signal hint), Echo cancellation, Speaker outputs to cancel (while echo cancellation is on — the
// browser's canceller follows the speaker, so the web's button is off with a why), Auto gain control, Noise
// suppression (Off / Standard / Strong (RNNoise); Strong only where RNNoise loads), Test noise cancellation. Card
// Speaker: Output device, Output level. Card Share audio: the source. Drives the call engine only through callbridge.
// The level monitors run while this pane is shown (entering Audio starts them; leaving it or closing the window stops
// them — the pane unmounts).
import { useEffect, useState } from "react";
import { Button } from "@/ui";
import { bus } from "@/core/bus";
import type { CallStore } from "@/features/calls/contract";
import {
  act,
  applyAec,
  applyAgc,
  applyNs,
  canPickOutput,
  refreshDeviceLists,
  sameDev,
  setInput,
  setOutput,
  setShareSource,
  startMicMonitor,
  startOutputMonitor,
  stopMicMonitor,
  stopOutputMonitor,
  useDeviceLists,
  useEngine,
  useMicDsp,
  useMicRunning,
  useOutRunning,
  useShareSource,
} from "../callbridge";
import { EngineLevelMeter } from "../LevelMeter";
import { setStatus } from "../store";
import { ComboRow, Hint, Row, Section, SwitchRow } from "../rows";
import { SameRoomRows } from "./SameRoomRows";

const NS: Array<"off" | "standard" | "strong"> = ["off", "standard", "strong"];

export function AudioPane() {
  const e = useEngine();
  const dev = useDeviceLists();
  const dsp = useMicDsp();
  const micRunning = useMicRunning();
  const outRunning = useOutRunning();
  const share = useShareSource();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    refreshDeviceLists();
    act("refreshAudioSources" as keyof CallStore);
    startOutputMonitor();
    startMicMonitor();
    const t = setTimeout(() => setSettled(true), 2500);
    return () => {
      clearTimeout(t);
      stopOutputMonitor();
      stopMicMonitor();
    };
  }, []);

  const inputs = [{ id: "", name: "System default" }, ...dev.inputs];
  const outputs = [{ id: "", name: "System default" }, ...dev.outputs];
  const sources = [{ id: "", name: "None" }, ...share.sources];
  const inIdx = Math.max(0, inputs.findIndex((d) => sameDev(d, dev.inputId)));
  const outIdx = Math.max(0, outputs.findIndex((d) => sameDev(d, dev.outputId)));
  const srcIdx = Math.max(0, sources.findIndex((d) => sameDev(d, share.current)));
  const nsModel = ["Off", "Standard", dsp.ncAvailable ? "Strong (RNNoise)" : "Strong (RNNoise) — not available here"];
  const nsIdx = Math.max(0, NS.indexOf(dsp.ns === "strong" && !dsp.ncAvailable ? "standard" : dsp.ns));
  const ecNote = dsp.aec && dsp.ecNote && (e.inCall || dsp.ecNote.startsWith("not needed")) ? `Now: ${dsp.ecNote}.` : "";

  return (
    <>
      <Section title="Microphone">
        <ComboRow id="audio.input-device" label="Input device" model={inputs} textRole="name" currentIndex={inIdx} onActivated={(i) => setInput(inputs[i].id)} />
        <Row id="audio.input-level" label="Input level" description="Talk — the bars should move.">
          <EngineLevelMeter which="mic" dim={!micRunning} />
          {!micRunning && settled && <Hint tone="danger">No signal from this microphone — it may be unplugged or in use by another app. Pick another one above.</Hint>}
        </Row>
        <SwitchRow
          id="audio.echo-cancellation"
          label={dsp.ecDegraded ? "Echo cancellation — NOT ACTIVE" : "Echo cancellation"}
          labelTone={dsp.ecDegraded ? "danger" : undefined}
          description={
            dsp.ecDegraded
              ? "Switched on but not running, so others hear their own voice come back from you. Tin Hat keeps retrying it."
              : `Stops others hearing themselves through your speakers.${ecNote ? ` ${ecNote}` : ""}`
          }
          checked={dsp.aec}
          onToggled={applyAec}
        />
        {dsp.aec && (
          <Row
            id="audio.echo-outputs"
            label="Speaker outputs to cancel"
            description="Your browser cancels the echo of the speaker picked below, for the whole call on that device."
            control={<Button text="Choose…" icon="audio-speakers-symbolic" disabled tip="The browser's echo cancellation follows the Speaker picked below." />}
          />
        )}
        <SwitchRow id="audio.auto-gain" label="Auto gain control" description="Evens out your volume as you move closer or further away." checked={dsp.agc} onToggled={applyAgc} />
        <ComboRow
          id="audio.noise-suppression"
          label="Noise suppression"
          description="Standard is your browser's own; Strong is RNNoise. If people say you sound robotic, set this to Off first."
          model={nsModel}
          currentIndex={nsIdx}
          onActivated={(i) => {
            if (NS[i] === "strong" && !dsp.ncAvailable) {
              setStatus("RNNoise couldn't load in this browser, so Strong isn't available here");
              return;
            }
            applyNs(NS[i]);
          }}
        />
        <Row
          id="audio.noise-test"
          label="Test noise cancellation"
          description="Hear your mic before and after suppression."
          control={<Button text="Test…" icon="media-record-symbolic" onClick={() => bus.emit("openNoiseTest", {})} />}
        />
      </Section>

      <Section title="Speaker">
        <ComboRow
          id="audio.output-device"
          label="Output device"
          description={canPickOutput ? undefined : "Your browser always uses the system output."}
          model={canPickOutput ? outputs : [{ id: "", name: "System default" }]}
          textRole="name"
          currentIndex={canPickOutput ? outIdx : 0}
          disabled={!canPickOutput}
          onActivated={(i) => setOutput(outputs[i].id)}
        />
        <Row id="audio.output-level" label="Output level" description="Moves while Tin Hat plays sound.">
          <EngineLevelMeter which="out" dim={!outRunning} />
        </Row>
      </Section>

      <Section title="Share audio">
        <ComboRow
          id="audio.share-audio"
          label="Share audio source"
          description={e.inCall ? "Music or app sound for calls. Remembered." : "Music or app sound for calls. Remembered; sharing starts when you're in a call."}
          model={sources}
          textRole="name"
          currentIndex={srcIdx}
          onActivated={(i) => setShareSource(sources[i].id)}
        />
      </Section>

      <Section title="Same room">
        <SameRoomRows />
      </Section>
    </>
  );
}
