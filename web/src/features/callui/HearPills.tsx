// HearPills.tsx — the 10.5 "Can they hear me?" pills in the status bar (Main.qml:977-1052, 5407-5514).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, useTip } from "@/ui";
import { toast } from "@/core/bus";
import { act, getC, ui, useC } from "./store";
import { hearName, hearNames, snap, type PillModel } from "./hear";
import s from "./HearPills.module.css";

let echoTimer = 0;

export function HearPills() {
  const inCall = useC("inCall");
  const micMuted = useC("micMuted");
  const agc = useC("micAgc");
  const tiles = useC("tiles");
  const h = snap(useC("hear"));
  const srs = useC("sameRoom");
  const [checking, setChecking] = useState(false);
  const pills: PillModel[] = [];
  if (inCall && h) {
    const st = h.mic?.check ?? "ok";
    const dev = h.mic?.dev || "your microphone";
    if ((st === "hint" && !micMuted) || st === "dead" || st === "osmuted" || st === "osvol0") {
      pills.push({
        id: "mic",
        tone: st === "hint" ? "info" : "danger",
        icon: "microphone-sensitivity-muted-symbolic",
        text: st === "hint" ? "No sound from your mic yet" : st === "dead" ? "Mic isn't picking anything up" : st === "osmuted" ? "Mic muted in system settings" : "Mic volume at 0 %",
        action: st === "osmuted" ? "Unmute" : st === "osvol0" ? "Turn up" : st === "dead" ? "Pick input" : "",
        shortText: st === "hint" ? "No mic sound yet" : st === "dead" ? "Mic silent" : st === "osmuted" ? "Mic muted (system)" : "Mic at 0 %",
        tip:
          st === "hint"
            ? `Nothing has come from ${dev} since you joined. Say something to check — this goes away at the first sound. (A mic with a noise gate stays silent until you talk.)`
            : st === "dead"
              ? `${dev} has sent a completely flat signal for a minute while you were unmuted — it may be muted with a switch on the mic or headset, unplugged, or the wrong input.`
              : st === "osmuted"
                ? `${dev} is muted in your system's sound settings, so nobody can hear you. Unmute fixes it from here.`
                : `${dev}'s input volume is 0 % in your system's sound settings. Turn up sets it to 100 %.`,
        run: () => {
          if (st === "osmuted" || st === "osvol0") act("fixSystemLevel")();
          else {
            const mic = document.querySelector<HTMLElement>('[data-id="mic"]');
            ui().set({ optsFace: "mic", optsAnchor: mic, streamPop: false });
          }
        },
      });
    }
    const ost = h.out?.check ?? "ok";
    if (ost === "osmuted" || ost === "osvol0") {
      pills.push({
        id: "out",
        tone: "danger",
        icon: "audio-volume-muted-symbolic",
        text: ost === "osmuted" ? "Speakers muted in system settings" : "Speaker volume at 0 %",
        action: ost === "osmuted" ? "Unmute" : "Turn up",
        shortText: ost === "osmuted" ? "Speakers muted (system)" : "Speakers at 0 %",
        tip: `You won't hear anyone: ${h.out.dev || "your speakers"}${ost === "osmuted" ? " is muted" : " is at 0 %"} in your system's sound settings.`,
        run: () => act("fixSystemLevel")(),
      });
    }
    const tx = h.tx?.state ?? "ok";
    if (!micMuted && (tx === "notsent" || tx === "quiet")) {
      pills.push({
        id: "tx",
        tone: tx === "notsent" ? "warn" : "info",
        icon: tx === "notsent" ? "dialog-warning" : "audio-volume-low-symbolic",
        text: tx === "notsent" ? "The call isn't getting your mic" : "Mic very quiet",
        action: tx === "notsent" ? "Reconnect" : agc ? "" : "Auto gain",
        shortText: tx === "notsent" ? "Mic not reaching the call" : "Mic quiet",
        tip:
          tx === "notsent"
            ? `Nobody can hear you: ${h.tx.why || "the call server didn't receive your voice"}. Reconnect mic publishes it again.`
            : "People may barely hear you — your voice reaches the call below the level it counts as speech. " + (agc ? "Raise the input volume in your sound settings." : "Auto gain evens it out (or raise the input volume)."),
        run: () => (tx === "notsent" ? act("reconnectMic")() : act("applyMicAgc")(true)),
      });
    }
    // Same room (11.3): the 10.5 detector's pairing (their stream carries our voice < 120 ms, or they report
    // the same about us) becomes a one-click link; linked = status + Unlink; two devices playing = guidance.
    const peersRoom = Object.entries(h.peers ?? {})
      .filter(([, pr]) => !!pr.echo && !!(pr.echo as { room?: boolean }).room)
      .map(([id]) => id);
    const suggest = [...new Set([...(h.echoMe?.room ?? []), ...peersRoom])].filter((id) => !srs.linked.includes(id) && id !== srs.pending);
    let srSpkShown = false;
    if (srs.linked.length === 0 && srs.pending) {
      pills.push({
        id: "sr-pending",
        tone: "info",
        icon: "audio-input-microphone-symbolic",
        text: `Asking ${hearName(srs.pending, tiles)} to link up…`,
        action: "Cancel",
        shortText: "Linking up…",
        shortAction: "Cancel",
        tip: "They see a card. Once they say yes, Tin Hat sends one voice from your room and stops your two devices playing each other.",
        run: () => act("sameRoomCancel")(),
      });
    } else if (srs.linked.length === 0 && suggest.length > 0) {
      const who = suggest[0];
      pills.push({
        id: "room",
        tone: "info",
        icon: "audio-input-microphone-symbolic",
        text: `Sounds like you and ${hearName(who, tiles)} are in the same room`,
        action: "Link up",
        shortText: `Same room as ${hearName(who, tiles)}?`,
        shortAction: "Link up",
        tip: `${hearName(who, tiles)} is heard through your mic as well as their own, so everyone else hears them twice. Linking up makes Tin Hat send one voice from your room (whoever's own mic hears them loudest) and stops your devices playing each other.`,
        run: () => {
          const err = act("sameRoomLink")(who);
          if (err) toast(err, { timeoutMs: 4000 });
        },
      });
    }
    if (srs.linked.length > 0) {
      const names = hearNames(srs.linked, tiles);
      const micName = srs.live ? "you" : srs.holder ? hearName(srs.holder, tiles) : "—";
      pills.push({
        id: "sr",
        tone: "info",
        icon: "audio-input-microphone-symbolic",
        text: `In a room with ${names} · room mic: ${micName}`,
        action: "Unlink",
        shortText: `Same room: ${names}`,
        shortAction: "Unlink",
        tip:
          `Only one of your mics is live at a time — whoever's own mic hears them loudest, so everyone else hears each of you once. You don't hear ${names} through Tin Hat: you hear ${srs.linked.length === 1 ? "them" : "each other"} in person.` +
          (srs.rawOk ? "" : " (This browser kept its own processing on the level meter, so a loud speaker right next to you may still leak through.)"),
        run: () => act("sameRoomUnlink")(),
      });
      const first = hearName(srs.linked[0], tiles);
      const echoNow = !!h.localEcho || (h.echoMe?.by ?? []).length > 0;
      if (srs.spk && echoNow) {
        srSpkShown = true;
        pills.push({
          id: "sr-spk",
          tone: "warn",
          icon: "audio-volume-high-symbolic",
          text: "Two devices in your room play the call — others may hear echo",
          action: `Hear it through ${first}'s speakers`,
          shortText: "Two devices playing",
          shortAction: "Use theirs",
          tip: `Each device's echo cancellation only knows its own speakers, so the far end comes back through the other device's mic. Let one device play the call (headphones also fix it). Your mic keeps working.`,
          run: () => act("sameRoomHearThrough")(false),
        });
      }
      if (!srs.spk) {
        pills.push({
          id: "sr-spk-off",
          tone: "info",
          icon: "headphones-symbolic",
          text: `The call plays on ${first}'s device`,
          action: "Play here too",
          shortText: "Playing on their device",
          shortAction: "Play here",
          tip: "Your speakers stay quiet for the call so the room hears it once; your mic still works. Remembered for next time.",
          run: () => act("sameRoomHearThrough")(true),
        });
      }
    }
    const em = h.echoMe ?? { by: [], lag: 0 };
    const le = h.localEcho as null | { src?: string };
    const fix = h.ecFix ?? { kind: "", out: "", label: "" };
    const reported = (em.by ?? []).length > 0;
    if ((reported || le) && !srSpkShown) {
      const fixText =
        fix.kind === "turn_on"
          ? "Echo cancellation removes it."
          : fix.kind === "add_output"
            ? `${fix.label || "That output"} isn't in echo cancellation's speaker list — adding it lets the echo be removed.`
            : fix.kind === "retry"
              ? "Echo cancellation is switched on but isn't running right now."
              : "Echo cancellation is on — lower your speaker volume or use headphones.";
      pills.push({
        id: "echo",
        tone: checking ? "info" : "warn",
        icon: "audio-volume-high-symbolic",
        text: checking ? "Checking the echo…" : fix.kind === "volume" || fix.kind === "" ? "Echo — lower your speakers or use headphones" : "Echo",
        action: checking ? "" : fix.kind === "turn_on" ? "Turn on echo cancellation" : fix.kind === "add_output" ? `Add ${fix.label || "this output"} to echo cancellation` : fix.kind === "retry" ? "Retry echo cancellation" : "",
        shortText: checking ? "Checking echo…" : fix.kind === "volume" || fix.kind === "" ? "Echo — lower speakers" : "Echo",
        shortAction: fix.kind === "turn_on" ? "Turn on echo cancel" : fix.kind === "add_output" ? "Add output" : fix.kind === "retry" ? "Retry" : "",
        tip: checking
          ? "Measuring again — this pill goes away once the echo is gone."
          : reported
            ? `${hearNames(em.by, tiles)}${em.by.length === 1 ? " hears" : " hear"} their own voice come back through your mic, about ${em.lag} ms later. ${fixText}`
            : `Your mic picks up what your speakers play (${le?.src === "system" ? "system audio — a game, music or a video" : "the call"}), so others can hear it back. ${fixText}`,
        run: () => {
          act("applyMicAec")(true);
          setChecking(true);
          window.clearTimeout(echoTimer);
          echoTimer = window.setTimeout(() => setChecking(false), 90000);
        },
      });
    }
  }
  const echoShown = pills.some((p) => p.id === "echo");
  const wasEcho = useRef(false);
  useEffect(() => {
    if (wasEcho.current && !echoShown && checking) {
      setChecking(false);
      window.clearTimeout(echoTimer);
      toast("Echo gone ✓", { timeoutMs: 3000 });
    }
    wasEcho.current = echoShown;
  }, [echoShown, checking]);
  void getC;
  return (
    <>
      {pills.map((p) => (
        <HearPill key={p.id} p={p} />
      ))}
    </>
  );
}

const TONE = {
  danger: { bg: "var(--th-hear-pill-danger-bg)", edge: "var(--th-hear-pill-danger-border)", fg: "var(--th-hear-pill-danger-fg)", fgHi: "var(--th-hear-pill-danger-action-fg)" },
  warn: { bg: "var(--th-hear-pill-warn-bg)", edge: "var(--th-hear-pill-warn-border)", fg: "var(--th-hear-pill-warn-fg)", fgHi: "var(--th-hear-pill-warn-action-fg)" },
  info: { bg: "var(--th-hear-pill-info-bg)", edge: "var(--th-hear-pill-info-border)", fg: "var(--th-hear-pill-info-fg)", fgHi: "var(--th-hear-pill-info-action-fg)" },
} as const;

export function HearPill({ p }: { p: PillModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLSpanElement>(null);
  const [short, setShort] = useState(false);
  const [hov, setHov] = useState(false);
  const t = TONE[p.tone];
  useLayoutEffect(() => {
    const el = ref.current,
      full = fullRef.current;
    if (!el || !full) return;
    const check = () => setShort(el.clientWidth + 1 < full.scrollWidth + 16 + (p.icon ? 18 : 0));
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [p.text, p.action, p.icon]);
  const text = short ? (p.shortText ?? p.text) : p.text;
  const action = short ? (p.shortAction ?? p.action) : p.action;
  useTip(ref, short ? `${p.text}${p.action ? " · " + p.action : ""}\n${p.tip ?? ""}` : p.tip, { delay: 300 });
  return (
    <div
      ref={ref}
      className={s.pill}
      style={{ background: t.bg, borderColor: t.edge, color: t.fg, cursor: p.run && p.action ? "pointer" : "default" }}
      onClick={() => p.action && p.run?.()}
      onPointerEnter={() => setHov(true)}
      onPointerLeave={() => setHov(false)}
      role={p.action ? "button" : "status"}
      data-pill={p.id}
    >
      {p.icon && <Icon name={p.icon} size={13} color={t.fg} />}
      <span className={s.text}>{text}</span>
      {action && (
        <span className={s.action} style={{ color: hov ? "var(--th-hear-pill-action-fg-hover)" : t.fgHi, textDecoration: hov ? "underline" : undefined }}>
          · {action}
        </span>
      )}
      <span ref={fullRef} className={s.measure} aria-hidden>
        {p.text}
        {p.action ? ` · ${p.action}` : ""}
      </span>
    </div>
  );
}
