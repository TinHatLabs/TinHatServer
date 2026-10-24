// GalleryThemeEditor.tsx — #/__gallery/theme-editor and #/__gallery/theme-share: the theme editor panel and the share
// cards without a session, for the review captures of THEMES-UI.md §13–§15 (tools/modular/editor-shots.mjs).
//   #/__gallery/theme-editor?theme=<id>&mode=simple|advanced&query=<text>&ops=<JSON array of edit ops>
//   #/__gallery/theme-share?theme=<id>&try=1
import { useEffect, useState } from "react";
import { MatrixEvent } from "matrix-js-sdk";
import { BUILTINS, type Theme } from "@/theme/engine";
import { shareContent } from "@/theme/share";
import { loadLibrary } from "@/ui/themeLibrary";
import { APP_SPEC, edit, openEditor, useEditor } from "@/features/settings/themes/editor/editorStore";
import { ThemeEditorHost } from "@/features/settings/themes/editor/ThemeEditor";
import { ThemeShareCard } from "@/features/settings/themes/share/ShareCard";
import { TryBar } from "@/features/settings/themes/share/TryBar";
import { useTrial } from "@/features/settings/themes/share/shareStore";

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

async function docOf(id: string): Promise<Theme> {
  if (Object.prototype.hasOwnProperty.call(BUILTINS, id)) return BUILTINS[id];
  const lib = await loadLibrary();
  return lib.byId.get(id)?.doc ?? BUILTINS.oled;
}

/** A stand-in for the app behind the panel: the window, an island, text, the accent — painted by the preview. */
function Backdrop() {
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--th-window-bg)", display: "flex", gap: 6, padding: 6, boxSizing: "border-box" }}>
      <div style={{ width: 260, borderRadius: 12, border: "1px solid var(--th-island-border)", background: "var(--th-island-bg-rooms)", padding: 12, color: "var(--th-rooms-item-fg)" }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Gaming Central</div>
        {["general", "game-night", "memes", "valheim"].map((r, i) => (
          <div key={r} style={{ padding: "6px 8px", borderRadius: 6, background: i === 1 ? "var(--th-rooms-item-bg-selected)" : "transparent" }}>
            # {r}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ height: 52, borderRadius: 12, border: "1px solid var(--th-island-border)", background: "var(--th-island-bg-header)" }} />
        <div style={{ flex: 1, borderRadius: 12, border: "1px solid var(--th-island-border)", background: "var(--th-island-bg-timeline)", padding: 16, color: "var(--th-settings-fg)" }}>
          <div style={{ display: "inline-block", padding: "8px 12px", borderRadius: 12, background: "var(--th-bubble-other-bg)", color: "var(--th-bubble-other-fg)" }}>Who's in for game night?</div>
          <div style={{ height: 8 }} />
          <div style={{ display: "inline-block", padding: "8px 12px", borderRadius: 12, background: "var(--th-bubble-own-bg)", color: "var(--th-bubble-own-fg)" }}>Me! 9 pm?</div>
        </div>
        <div style={{ height: 48, borderRadius: 12, border: "1px solid var(--th-island-border)", background: "var(--th-island-bg-composer)" }} />
      </div>
    </div>
  );
}

export function ThemeEditorPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const q = params();
    void docOf(q.get("theme") ?? "nord").then((doc) => {
      openEditor(doc, q.get("mine") ? { kind: "mine", id: doc.id } : { kind: "new" }, { force: true });
      const mode = q.get("mode") === "advanced" ? "advanced" : "simple";
      useEditor.setState({ mode, query: q.get("query") ?? "" });
      const ops = q.get("ops");
      if (ops) for (const op of JSON.parse(ops) as unknown[]) edit(op as never);
      setReady(true);
    });
  }, []);
  return (
    <>
      <Backdrop />
      {ready && <ThemeEditorHost />}
      <div data-editor-ready={ready ? "" : undefined} />
    </>
  );
}

function fakeEvent(id: string, sender: string, content: Record<string, unknown>): MatrixEvent {
  return new MatrixEvent({ type: "m.room.message", event_id: id, sender, room_id: "!gallery:example.com", origin_server_ts: 1790500000000, content });
}

export function ThemeSharePage() {
  const [events, setEvents] = useState<MatrixEvent[] | null>(null);
  useEffect(() => {
    const q = params();
    void Promise.all([docOf(q.get("theme") ?? "nord"), docOf("catppuccin-latte"), docOf("oled")]).then(([a, b, c]) => {
      const ok = (d: Theme) => {
        const r = shareContent(d, APP_SPEC);
        return r.ok ? (JSON.parse(JSON.stringify(r.content)) as Record<string, unknown>) : {};
      };
      const refused = ok({ ...a, id: "broken", name: "Broken Theme" });
      (refused["dev.tinhat.theme.share"] as Record<string, unknown>).theme = { ...a, name: "Broken Theme", roles: { "text.primary": "nope(" } };
      const newer = ok(a);
      (newer["dev.tinhat.theme.share"] as Record<string, unknown>).v = 2;
      setEvents([
        fakeEvent("$a", "@jordan:example.com", ok({ ...a, author: "Arctic Ice Studio" })),
        fakeEvent("$b", "@sam:example.com", ok(b)),
        fakeEvent("$c", "@alex:example.com", ok(c)),
        fakeEvent("$d", "@jordan:example.com", refused),
        fakeEvent("$e", "@jordan:example.com", newer),
      ]);
      if (q.get("try")) useTrial.setState({ trial: { key: "$a", doc: a, left: 27 } });
    });
  }, []);
  return (
    <div style={{ minHeight: "100vh", background: "var(--th-timeline-bg)", padding: 24, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 16 }}>
      {events?.map((ev) => (
        <div key={ev.getId()} style={{ display: "inline-block", maxWidth: 360, padding: "8px 12px", borderRadius: 12, background: "var(--th-bubble-other-bg)", color: "var(--th-bubble-other-fg)" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{ev.getSender()}</div>
          <ThemeShareCard roomId="!gallery:example.com" event={ev} />
        </div>
      ))}
      <TryBar />
      <div data-share-ready={events ? "" : undefined} />
    </div>
  );
}
