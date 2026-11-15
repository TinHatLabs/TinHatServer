// GalleryGameArt.tsx — #/__gallery/gamebg: a game's art ("Match the game", lane sun-gamebg) behind a stand-in
// conversation (the real bubble styles, no server) — for the review screenshots and the measured contrast gate.
//   ?art=<same-origin art url> (LAB builds only, src/lab/linkLab.ts)&theme=<theme id>&ff=mobile&bare=1 (bare = the background alone, for the pixel measure)
//   &backdrops=1 — the PREPARED brighter option (not the default): names and day labels on small backdrops, the veil at
//   its gentle floor (for the owner's comparison; its own contrast gate comes with the option if he picks it)
// The page exposes the veil and the timeline's text colours on [data-gallery-ready] for tools/gamebg/shots.mjs.
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/ui";
import { BUILTINS, type Theme } from "@/theme/engine";
import { loadLibrary } from "@/ui/themeLibrary";
import { setThemePreview } from "@/ui/themeStore";
import { senderColor } from "@/ui/themes";
import b from "@/features/chat/Bubble.module.css";
import c from "@/features/chat/Conversation.module.css";
import { GameArtView, readInk } from "@/features/chat/gamebg";
import * as linkLab from "@/lab/linkLab";

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
  { who: "@ava:example.org", name: "Ava", text: "Anyone on tonight?", time: "18:02", day: "Today" },
  { who: "@ava:example.org", name: "Ava", text: "We still need to finish the bridge before the next boss", time: "18:02" },
  { who: ME, name: "Me", text: "I'm in after dinner. 9 pm?", time: "18:05" },
  { who: "@kai:example.org", name: "Kai", text: "9 works. I'll bring the wood, you bring the ore", time: "18:07" },
  { who: "@noor:example.org", name: "Noor", text: "Count me in! Patch is still downloading though", time: "18:11" },
  { who: ME, name: "Me", text: "No rush, we'll wait at the base", time: "18:12" },
  { who: "@ava:example.org", name: "Ava", text: "Perfect. Voice room at 8:55 🎮", time: "18:15" },
  { who: "@kai:example.org", name: "Kai", text: "See you there", time: "18:16" },
];

export function GameArtGallery() {
  const q = params();
  const mobile = q.get("ff") === "mobile";
  const bare = q.get("bare") === "1";
  const backdrops = q.get("backdrops") === "1";
  const chip = backdrops ? { background: "color-mix(in srgb, var(--th-timeline-bg) 88%, transparent)", borderRadius: 6, padding: "1px 6px" } : undefined;
  // the art from the link (src/lab/linkLab.ts): lab builds only; a production build never fetches a URL a link names
  // (fix1216/weblinkfence)
  const art = __TW_LAB__ ? linkLab.gamebgArt(q) : null;
  const [ready, setReady] = useState(false);
  // "pending" until the art answered: the view reports the game when drawn, null when there is none to draw
  const [shown, setShown] = useState<string | null>("pending");
  const tl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void docOf(q.get("theme") ?? "oled").then((doc) => {
      setThemePreview("try", doc);
      setReady(true);
    });
  }, []);
  const ink = ready && tl.current ? readInk(tl.current) : null;
  const maxBubble = mobile ? 280 : 520;
  return (
    <div
      style={{ position: "fixed", inset: 0, display: "flex", background: "var(--th-window-bg)" }}
      data-gallery-ready={ready && (!art || (shown !== null && shown !== "pending")) ? "" : undefined}
      data-ink={ink ? JSON.stringify(ink) : ""}
    >
      <div className={c.conv} style={{ flex: 1 }}>
        <div ref={tl} className={c.tlWrap} style={{ isolation: "isolate", background: "var(--th-timeline-bg)" }}>
          {ready && <GameArtView src={art} gameId={art ? "gallery" : null} onShown={(g) => setShown(g ?? "none")} backdrops={backdrops} />}
          {!bare && (
            <div className={c.scroller}>
              <div className={c.content}>
                {MSGS.map((m, i) => {
                  const prev = i > 0 ? MSGS[i - 1] : null;
                  const grouped = !!prev && prev.who === m.who && !m.day;
                  const mine = m.who === ME;
                  return (
                    <div key={i} className={`${b.row} ${grouped ? b.grouped : ""}`}>
                      {m.day && (
                        <div className={b.day}>
                          <span className={b.dayPill}>{m.day}</span>
                        </div>
                      )}
                      <div className={`${b.line} ${mine ? b.mine : ""}`}>
                        {!mine && <div className={b.gutter}>{!grouped && <Avatar className={b.avatar} size={34} name={m.name} seed={m.who} imageSource={null} />}</div>}
                        <div className={b.col} style={{ maxWidth: maxBubble + 42 }}>
                          {!mine && !grouped && (
                            <div className={b.nameRow}>
                              <span className={b.name} style={{ color: senderColor(m.who), maxWidth: maxBubble, ...chip }}>
                                {m.name}
                              </span>
                            </div>
                          )}
                          <div className={b.bubbleWrap}>
                            <div className={`${b.bubble} ${mine ? b.bubbleMine : b.bubbleIn} ${!grouped ? (mine ? b.tuckR : b.tuckL) : ""}`} style={{ maxWidth: maxBubble }}>
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
          )}
        </div>
      </div>
    </div>
  );
}
