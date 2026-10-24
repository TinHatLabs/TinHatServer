// JoinSoundSection.tsx — Settings → Profile "Join sound" block (Main.qml:3063-3257). The settings
// feature hosts it (import { JoinSoundSection } from "@/features/media"); data + preview live here.
import { useEffect, useMemo, useRef, useState } from "react";
import { peekClient } from "@/core/matrix";
import { BasicButton, BasicToolButton, ComboBox, Icon, SearchField, SectionLabel, cx } from "@/ui";
import { addPersonalSound, fetchJoinSound, saveJoinSound, searchSounds, usePersonalSounds, type Sound } from "./data";
import { useSoundPreview } from "./joinsound";
import s from "./JoinSoundSection.module.css";

/** React: my join sound url + a setter that saves it (PUT profile field). */
export function useJoinSound(): { url: string; loaded: boolean; save: (url: string) => Promise<void> } {
  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!peekClient()) return;
    void fetchJoinSound().then((u) => {
      if (!alive) return;
      setUrl(u);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return {
    url,
    loaded,
    save: async (u: string) => {
      setUrl(u);
      await saveJoinSound(u);
    },
  };
}

export function JoinSoundSection({ busy = false }: { busy?: boolean }) {
  const personal = usePersonalSounds();
  const { url: joinUrl, save } = useJoinSound();
  const preview = useSoundPreview();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Sound[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => preview.stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (text: string) => {
    setQ(text);
    window.clearTimeout(timer.current);
    abort.current?.abort();
    const t = text.trim();
    if (t.length < 2) {
      setSearching(false);
      setResults([]);
      return;
    }
    setSearching(true);
    const ctl = new AbortController();
    abort.current = ctl;
    timer.current = window.setTimeout(async () => {
      try {
        const r = await searchSounds(t, ctl.signal);
        if (!ctl.signal.aborted) setResults(r);
      } catch {
        if (!ctl.signal.aborted) setResults([]);
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 450);
  };

  const model = useMemo(() => {
    const out: Array<{ name: string; url: string }> = [{ name: "No join sound", url: "" }];
    let found = false;
    personal.forEach((p, i) => {
      out.push({ name: p.name || `Sound ${i + 1}`, url: p.sourceUrl });
      if (p.sourceUrl === joinUrl) found = true;
    });
    if (!found && joinUrl) out.push({ name: "Current join sound", url: joinUrl });
    return out;
  }, [personal, joinUrl]);
  const current = Math.max(0, model.findIndex((m) => m.url === joinUrl));
  const previewing = !!joinUrl && preview.playingUrl === joinUrl;

  return (
    <div className={s.root}>
      <SectionLabel>Join sound</SectionLabel>
      <div className={s.explain}>
        Played for everyone already in a call when you join. Trimmed to 3 seconds, and it uses your soundboard volume, so people can turn it down.
      </div>
      <div className={s.row}>
        <ComboBox
          className={s.combo}
          variant="basic"
          model={model}
          textRole="name"
          currentIndex={current}
          disabled={busy}
          onActivated={(_i, item) => {
            preview.stop();
            void save(item.url);
          }}
        />
        <BasicButton
          text={previewing ? "Stop" : "Preview"}
          icon={previewing ? "media-playback-stop" : "media-playback-start"}
          disabled={!joinUrl}
          onClick={() => preview.toggle(joinUrl)}
        />
      </div>
      <SearchField value={q} onValueChange={onSearch} placeholder="Search sound effects…" disabled={busy} />
      {(searching || (q.length > 0 && results.length === 0)) && <div className={s.status}>{searching ? "Searching…" : "No results"}</div>}
      {q.length > 0 && results.length > 0 && (
        <div className={s.results} style={{ maxHeight: Math.min(results.length, 5) * 43.2 }}>
          {results.map((r) => {
            const playing = preview.playingUrl === r.sourceUrl;
            const chosen = !!r.sourceUrl && r.sourceUrl === joinUrl;
            return (
              <div key={r.sourceUrl} className={cx(s.resRow, playing && s.resPlaying)} onClick={() => preview.toggle(r.sourceUrl)}>
                <Icon name={playing ? "media-playback-stop" : "media-playback-start"} size={16} color={playing ? "var(--th-settings-sound-row-icon-active)" : "var(--th-settings-sound-row-icon)"} />
                <span className={s.resName}>{r.name || r.sourceUrl}</span>
                <BasicToolButton
                  iconName={chosen ? "checkmark-symbolic" : undefined}
                  text={chosen ? "Join sound" : "Use"}
                  disabled={chosen || !r.sourceUrl}
                  tip="Play this when you join a call"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!personal.some((p) => p.sourceUrl === r.sourceUrl)) void addPersonalSound(r.name || "Sound", r.sourceUrl, r.emoji || "", Math.floor(r.duration || 0));
                    void save(r.sourceUrl);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      {personal.length === 0 && q.length === 0 && <div className={s.explain}>Search above to find a sound, or add some to your soundboard first.</div>}
    </div>
  );
}

/** Dev/QA host (window "media-joinsound-dev", `?joinsound=1`) — settings owns the real placement. */
export function JoinSoundDev() {
  return (
    <div style={{ padding: 16, overflowY: "auto", position: "absolute", inset: 0, background: "var(--th-surface-window)" }}>
      <JoinSoundSection />
    </div>
  );
}
