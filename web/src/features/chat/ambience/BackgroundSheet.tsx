// BackgroundSheet.tsx — room menu → "Chat background…" (the desktop's BackgroundSheet.qml): the built-in scenes as live
// swatches, None, your own image, and the effect. One choice for everyone in the room (room state, docs/AMBIENCE.md);
// people who can't change it see it read-only.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { toast } from "@/core/bus";
import { usePref } from "@/core/prefs";
import { Button, ComboBox, Dialog, cx } from "@/ui";
import { EFFECTS, EFFECT_NAMES, PRESETS, PREF_BACKGROUNDS, applyPlan, backgroundContent, lookFor, prefOn, presetById, themeMode, type Effect } from "./core";
import { cssHex, lookCss } from "./layer";
import { peekClient } from "@/core/matrix";
import { canSetBackground, postBackgroundImage, roomEncrypted, setRoomBackground, useBackgroundImage, useRoomBackground } from "./room";
import { AMBIENCE_WORDS as AW } from "./words";
import st from "./BackgroundSheet.module.css";
import { GAMEBG_WORDS as GW, gameBackgroundContent, matchGamePlan, useGameBackdrop } from "../gamebg";


const GAME_STATE = { v: 1, kind: "game" };

export const useBackgroundSheet = create<{ roomId: string | null; seq: number }>()(() => ({ roomId: null, seq: 0 }));
export function openBackgroundSheet(roomId: string): void {
  useBackgroundSheet.setState((s) => ({ roomId, seq: s.seq + 1 }));
}

export function BackgroundSheetHost() {
  const { roomId, seq } = useBackgroundSheet();
  if (!roomId) return null;
  return <BackgroundSheet key={seq} roomId={roomId} onClose={() => useBackgroundSheet.setState({ roomId: null })} />;
}

type Choice = { kind: "none" } | { kind: "game" } | { kind: "preset"; id: string } | { kind: "image"; fallback: string; image: string | null; file: File | null };

function BackgroundSheet({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const bg = useRoomBackground(roomId);
  const shownImg = useBackgroundImage(roomId, bg);
  const img = shownImg?.src ?? null;
  const can = canSetBackground(roomId);
  const me = peekClient()?.getUserId() ?? "";
  // someone else's image can stay as it is, but never be written again under my name (imageShown would then refuse
  // it for everyone): to change anything, pick a scene or post your own image
  const showHere = prefOn(usePref(PREF_BACKGROUNDS, ""), true);
  const [mode] = useState(() => themeMode(cssHex(getComputedStyle(document.documentElement).getPropertyValue("--th-timeline-bg"))));
  // sun-gamebg: the art of the game people here play right now, for the "Match the game" swatch (none = a plain swatch)
  const gamePreview = useGameBackdrop(roomId, GAME_STATE).src;
  // an UNSET room already shows game art by itself, so the sheet opens on "Match the game" (Apply keeps what it shows)
  const initial: Choice = bg.kind === "game" || bg.kind === "unset" ? { kind: "game" } : bg.kind === "image" && bg.image ? { kind: "image", fallback: bg.preset ?? PRESETS[0].id, image: bg.image, file: null } : bg.kind === "preset" && bg.preset ? { kind: "preset", id: bg.preset } : { kind: "none" };
  const [choice, setChoice] = useState<Choice>(initial);
  const [effect, setEffect] = useState<Effect | null>(bg.kind === "preset" || bg.kind === "image" ? bg.effect : null);
  const [busy, setBusy] = useState(false);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);
  useEffect(() => () => void (pickedUrl && URL.revokeObjectURL(pickedUrl)), [pickedUrl]);

  const scenePreset = choice.kind === "preset" ? presetById(choice.id) : choice.kind === "image" ? presetById(choice.fallback) : null;
  const ownEffect = scenePreset?.effect ?? "none";
  const effModel = [{ id: "", label: `${AW.effectOwn} (${EFFECT_NAMES[ownEffect]})` }, ...EFFECTS.map((e) => ({ id: e, label: EFFECT_NAMES[e] }))];

  const pickImage = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif";
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      if (pickedUrl) URL.revokeObjectURL(pickedUrl);
      setPickedUrl(URL.createObjectURL(f));
      setChoice({ kind: "image", fallback: scenePreset?.id ?? PRESETS[0].id, image: null, file: f });
    };
    inp.click();
  };

  // sun-gamebg: "Match the game" needs no write where the room already shows game art (game, or nothing set)
  const plan = choice.kind === "game" ? matchGamePlan(bg.kind, !!gamePreview).plan : applyPlan(
    bg,
    choice.kind === "none"
      ? { kind: "none", preset: null, effect: null, newImage: false }
      : choice.kind === "preset"
        ? { kind: "preset", preset: choice.id, effect, newImage: false }
        : { kind: "image", preset: choice.fallback, effect, newImage: !!choice.file },
    me,
  );
  const blocked = plan === "blocked";
  const apply = async () => {
    if (!can || busy) return;
    if (plan === "skip") return onClose(); // nothing to write
    if (plan === "blocked") return;
    setBusy(true);
    try {
      if (choice.kind === "none") await setRoomBackground(roomId, backgroundContent("none", null, null));
      else if (choice.kind === "game") await setRoomBackground(roomId, matchGamePlan(bg.kind, !!gamePreview).content ?? gameBackgroundContent());
      else if (choice.kind === "preset") await setRoomBackground(roomId, backgroundContent("preset", choice.id, effect));
      else {
        // keeping the image: the one the room has NOW (the plan above checked exactly that one), never a stale copy
        let id = bg.image;
        if (choice.file) {
          toast(AW.customBusy, { timeoutMs: 3000 });
          id = await postBackgroundImage(roomId, choice.file);
        }
        await setRoomBackground(roomId, backgroundContent("image", choice.fallback, effect, id));
      }
      onClose();
    } catch (e) {
      toast(choice.kind === "image" && choice.file ? AW.customFailed : AW.setFailed, { kind: "error", timeoutMs: 6000 });
      setBusy(false);
      void e;
    }
  };

  const swatch = (key: string, label: string, selected: boolean, onPick: () => void, background: string | undefined) => (
    <button key={key} type="button" className={cx(st.swatch, selected && st.selected)} disabled={!can || busy} onClick={onPick} aria-pressed={selected} aria-label={label}>
      <span className={st.scene} style={{ background }} />
      <span className={st.label}>{label}</span>
    </button>
  );
  const imgPreview = pickedUrl ?? (choice.kind === "image" && !choice.file ? img : null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={AW.title}
      width={560}
      buttons={can ? [{ text: AW.apply, role: "accept", disabled: busy || blocked, onClick: () => void apply() }] : []}
      standardButtons={[can ? "cancel" : "close"]}
    >
      <div className={st.body}>
        <p className={st.note}>{can ? AW.forEveryone : AW.readOnly}</p>
        {!showHere && <p className={st.note}>{AW.offHere}</p>}
        <div className={st.grid}>
          {swatch("none", AW.none, choice.kind === "none", () => setChoice({ kind: "none" }), "var(--th-timeline-bg)")}
          {swatch("game", GW.matchGame, choice.kind === "game", () => setChoice({ kind: "game" }), gamePreview ? `center / cover no-repeat url("${gamePreview}"), var(--th-timeline-bg)` : "var(--th-timeline-bg)")}
          {PRESETS.map((p) => swatch(p.id, p.name, choice.kind === "preset" && choice.id === p.id, () => setChoice({ kind: "preset", id: p.id }), lookCss(lookFor(p, mode))))}
          {choice.kind === "image" &&
            swatch("image", AW.customLabel, true, () => {}, imgPreview ? `center / cover no-repeat url("${imgPreview}"), ${lookCss(lookFor(presetById(choice.fallback) ?? PRESETS[0], mode))}` : lookCss(lookFor(presetById(choice.fallback) ?? PRESETS[0], mode)))}
        </div>
        {can && <Button icon="insert-image-symbolic" text={AW.customImage} disabled={busy} onClick={pickImage} />}
        {choice.kind === "image" && (
          <>
            {blocked && <p className={st.note}>{AW.otherImage}</p>}
            <p className={st.note}>{AW.customPosted}</p>
            {!roomEncrypted(roomId) && <p className={cx(st.note, st.warn)}>{AW.customPlainRoom}</p>}
          </>
        )}
        {choice.kind === "game" && <p className={st.note}>{GW.matchGameHelp}</p>}
        {choice.kind !== "none" && choice.kind !== "game" && (
          <div className={st.effectRow}>
            <span>{AW.effect}</span>
            <ComboBox
              model={effModel}
              textRole="label"
              disabled={!can || busy}
              currentIndex={effect === null ? 0 : effModel.findIndex((m) => m.id === effect)}
              onActivated={(_i, it) => setEffect(it.id === "" ? null : (it.id as Effect))}
              aria-label={AW.effect}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
