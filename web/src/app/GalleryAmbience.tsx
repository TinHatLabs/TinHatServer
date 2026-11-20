// GalleryAmbience.tsx — #/__gallery/ambience: a stand-in conversation (the real bubble styles, no server) under a
// shared chat background with its effect — for the readability screenshots and the performance runs.
//   #/__gallery/ambience?preset=rain|hearth|snow|summer|dusk|deep|none&effect=<effect>&theme=<theme id>&seed=N&ff=mobile
//     [&menu=mod|readonly|home][&kbd=1]   round 4 (kbd=1: a real "Menu" button opens it, for the a11y keyboard gate): the ☰ menu (the real Menu + RegistryMenuItems) with the real Particles ▸ rows
//                                  (particlesSubmenu over a stand-in room: a moderator / someone who can't change it / no room)
//   &soak=1 rotates the rows every 2 s (a new message in, the oldest out: colliders and pools churn — the soak runs)
//   &run=1 keeps the effect running when the window isn't focused (sets Pause effects… off in this browser profile)
//   &title=1 writes the effect state and the WebGL renderer into the window title (the real-GPU measurements read it)
//   run / title / force are LAB switches, compiled into lab builds only (galleryLab.ts; `vite dev` or
//   `TW_LAB_BUILD=1 vite build`); a production bundle has none of them (tools/release-hooks-check.mjs)
//   &force=1 runs the particles on a software rasteriser too (the worst-case measurements; never in the app)
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/ui";
import { BUILTINS, type Theme } from "@/theme/engine";
import { loadLibrary } from "@/ui/themeLibrary";
import { setThemePreview } from "@/ui/themeStore";
import { senderColor } from "@/ui/themes";
import b from "@/features/chat/Bubble.module.css";
import c from "@/features/chat/Conversation.module.css";
import { AmbienceLayer } from "@/features/chat/ambience/layer";
import { EFFECTS, parseBackground, type Effect } from "@/features/chat/ambience/core";

import * as galleryLab from "./galleryLab";
import { Menu } from "@/ui";
import type { AppMenuCtx, MenuContribution } from "@/core/registry";
import { RegistryMenuItems } from "@/features/nav/menus";
import { particlesSubmenu } from "@/features/chat/ambience/particlesMenu";
import { AMBIENCE_WORDS } from "@/features/chat/ambience/words";

// The lab switches (force=1, run=1, title=1) live in galleryLab.ts and are reached only through the BUILD-TIME constant
// __TW_LAB__: a production build folds every use below to the no-op side and drops that module (R3-5).
const noTitle = (_q: URLSearchParams): void => undefined;
const useLabTitle = __TW_LAB__ ? galleryLab.useLabTitle : noTitle;

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}
async function docOf(id: string): Promise<Theme> {
  if (Object.prototype.hasOwnProperty.call(BUILTINS, id)) return BUILTINS[id];
  const lib = await loadLibrary();
  return lib.byId.get(id)?.doc ?? BUILTINS.oled;
}

interface Msg {
  who: string;
  name: string;
  text: string;
  time: string;
  day?: string;
}
const ME = "@me:example.org";
const MSGS: Msg[] = [
  { who: "@ava:example.org", name: "Ava", text: "Anyone up for a round tonight?", time: "18:02", day: "Today" },
  { who: "@ava:example.org", name: "Ava", text: "I was thinking the new co-op map, it looked great in the trailer", time: "18:02" },
  { who: ME, name: "Me", text: "I'm in after dinner. 9 pm?", time: "18:05" },
  { who: "@kai:example.org", name: "Kai", text: "9 works. I'll bring the snacks and the bad jokes", time: "18:07" },
  { who: "@noor:example.org", name: "Noor", text: "Count me in! Still downloading the patch though, it's huge", time: "18:11" },
  { who: ME, name: "Me", text: "No rush, we'll wait in the lobby", time: "18:12" },
  { who: "@ava:example.org", name: "Ava", text: "Perfect. Let's meet in the voice room at 8:55 🎮", time: "18:15" },
  { who: "@kai:example.org", name: "Kai", text: "See you there", time: "18:16" },
];

export function AmbienceGallery() {
  const q = params();
  const mobile = q.get("ff") === "mobile";
  const preset = q.get("preset") ?? "rain";
  const eff = q.get("effect");
  const bg = parseBackground(preset === "none" ? {} : { v: 1, preset, ...(eff && (EFFECTS as readonly string[]).includes(eff) ? { effect: eff as Effect } : {}) });
  const [ready, setReady] = useState(false);
  if (__TW_LAB__) galleryLab.labRun(q);
  useLabTitle(q);
  const force = __TW_LAB__ ? galleryLab.labForce(q) : false;
  useEffect(() => {
    void docOf(q.get("theme") ?? "oled").then((doc) => {
      setThemePreview("try", doc);
      setReady(true);
    });
  }, []);
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const getContent = useCallback(() => content.current, []);
  const getScroller = useCallback(() => scroller.current, []);
  const maxBubble = mobile ? 280 : 520;
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (q.get("soak") !== "1") return;
    const t = window.setInterval(() => setTurn((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, []);
  const rows = MSGS.map((_, i) => ({ ...MSGS[(i + turn) % MSGS.length], key: `${turn + i}` }));
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", background: "var(--th-window-bg)" }} data-gallery-ready={ready ? "" : undefined}>
      <div className={c.conv} style={{ flex: 1 }}>
        <div className={c.tlWrap} style={{ isolation: "isolate" }}>
          {ready && <AmbienceLayer background={bg} content={getContent} scroller={getScroller} mobile={mobile} seed={Number(q.get("seed") ?? 1)} force={force} />}
          <div ref={scroller} className={c.scroller}>
            <div ref={content} className={c.content}>
              {rows.map((m, i) => {
                const prev = i > 0 ? rows[i - 1] : null;
                const grouped = !!prev && prev.who === m.who && !m.day;
                const mine = m.who === ME;
                return (
                  <div key={m.key} className={`${b.row} ${grouped ? b.grouped : ""}`}>
                    {m.day && (
                      <div className={b.day}>
                        <span className={b.dayPill} data-amb="day">
                          {m.day}
                        </span>
                      </div>
                    )}
                    <div className={`${b.line} ${mine ? b.mine : ""}`}>
                      {!mine && <div className={b.gutter}>{!grouped && <Avatar className={b.avatar} size={34} name={m.name} seed={m.who} imageSource={null} />}</div>}
                      <div className={b.col} style={{ maxWidth: maxBubble + 42 }}>
                        {!mine && !grouped && (
                          <div className={b.nameRow}>
                            <span className={b.name} style={{ color: senderColor(m.who), maxWidth: maxBubble }} data-amb="name">
                              {m.name}
                            </span>
                          </div>
                        )}
                        <div className={b.bubbleWrap}>
                          <div data-bubble="" className={`${b.bubble} ${mine ? b.bubbleMine : b.bubbleIn} ${!grouped ? (mine ? b.tuckR : b.tuckL) : ""}`} style={{ maxWidth: maxBubble }}>
                            <div>{m.text}</div>
                            <div className={b.stamp}>
                              <span>{m.time}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {ready && q.get("menu") && (q.get("kbd") === "1" ? <GalleryMenuButton kind={q.get("menu") ?? "mod"} /> : <GalleryAppMenu kind={q.get("menu") ?? "mod"} />)}
    </div>
  );
}

/** Round 5 (the a11y keyboard gate, tools/a11y-keyboard-e2e.mjs --gallery): a real "Menu" button that opens the ☰ menu
 *  anchored to it, as the account island's does; the Menu itself takes the focus and gives it back. */
function GalleryMenuButton({ kind }: { kind: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div style={{ position: "fixed", left: 24, top: 24 }}>
      <button type="button" aria-label="Menu" onClick={(e) => setAnchor(e.currentTarget)}>
        ☰
      </button>
      {anchor && <GalleryAppMenu kind={kind} anchor={anchor} onClose={() => setAnchor(null)} />}
    </div>
  );
}

/** Round 4 (review captures): the ☰ app menu as the app draws it, with the REAL Particles ▸ rows over a stand-in room. */
function GalleryAppMenu({ kind, anchor, onClose }: { kind: string; anchor?: HTMLElement; onClose?: () => void }) {
  const input = {
    room: kind !== "home",
    bg: parseBackground({ v: 1, kind: "preset", preset: "rain" }, "@mod:gallery"),
    canChange: kind !== "readonly",
    me: "@me:gallery",
    backgrounds: true,
    effects: true,
    pauseUnfocused: true,
    saver: false,
  };
  const noop = () => {};
  const items: MenuContribution<AppMenuCtx>[] = [
    { id: "settings", order: 50, label: "Settings…", icon: "settings-configure", run: noop },
    { id: "layout", order: 55, label: "Edit layout…", icon: "window-symbolic", run: noop },
    { id: "nav.theme", order: 60, label: "Theme", icon: "preferences-desktop-color", submenu: () => [{ id: "oled", label: "OLED", checked: true, run: noop }], run: noop },
    { id: "chat.particles", order: 65, label: AMBIENCE_WORDS.particles, icon: "video-display-brightness-symbolic", submenu: () => particlesSubmenu(input), run: noop },
    { id: "about", order: 140, separatorBefore: true, label: "About Tin Hat", icon: "help-about-symbolic", run: noop },
    { id: "signOut", order: 150, label: "Sign out", icon: "system-log-out-symbolic", run: noop },
  ];
  return (
    <Menu open onClose={onClose ?? noop} anchor={anchor ?? { x: 24, y: 64 }} title="Menu">
      <RegistryMenuItems items={items} ctx={{} as AppMenuCtx} />
    </Menu>
  );
}
