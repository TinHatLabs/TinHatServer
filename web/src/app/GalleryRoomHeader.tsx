// GalleryRoomHeader.tsx — #/__gallery/room-header: the phone room header (chat's RoomHeaderBar, `mobile`) over a
// stand-in room, with the header buttons the features registered (r.roomHeaderActions) and the stored/default
// header.phoneEnd row, so the "More" sheet can be opened, measured and screenshotted without a homeserver.
//   ?theme=<theme id> (a builtin or a library theme, e.g. oled | adwaita)  ?ff=mobile  ?open=1 (opens ⋯ More)
//   ?look=iconLabel|label  the header.phoneEnd row in that look (a layout held in memory for this page, never stored)
// The room is not on any server: the room name falls back to "Room" and the buttons draw their no-session states.
import { useEffect, useState } from "react";
import { BUILTINS, type Theme } from "@/theme/engine";
import { loadLibrary } from "@/ui/themeLibrary";
import { setThemePreview } from "@/ui/themeStore";
import { RoomHeaderBar } from "@/features/chat/RoomPage";
import { getDeviceForm, getFormSource, setFormSource, type FormKind, type FormSource } from "@/actions/layoutStore";
import type { JObj } from "@/layout/json";
import { defaultRowValue } from "@/actions/rows";

const ROOM = "!gallery-room:example.org";

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}
async function docOf(id: string): Promise<Theme> {
  if (Object.prototype.hasOwnProperty.call(BUILTINS, id)) return BUILTINS[id];
  const lib = await loadLibrary();
  return lib.byId.get(id)?.doc ?? BUILTINS.oled;
}

/** The phone form in effect with header.phoneEnd = its default items in `look`. Read-only: set() swallows every write
 *  (answers true, so nothing reaches the device prefs either); the desktop form is the previous source's. */
function lookSource(look: string, prev: FormSource | null): FormSource {
  const form = JSON.parse(JSON.stringify(prev?.get("phone") ?? getDeviceForm("phone"))) as JObj;
  const row = JSON.parse(JSON.stringify(defaultRowValue("header", "phoneEnd", "phone"))) as JObj;
  row.look = look;
  const opts = (form.opts ?? (form.opts = {})) as JObj;
  const header = (opts.header ?? (opts.header = {})) as JObj;
  const rows = (header.rows ?? (header.rows = {})) as JObj;
  rows.phoneEnd = row;
  return {
    get: (kind: FormKind) => (kind === "phone" ? form : (prev?.get(kind) ?? null)),
    set: () => true,
    subscribe: () => () => {},
  };
}

export function RoomHeaderGallery() {
  const q = params();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // (the source in effect — edit mode's synced layout — is put back when the page goes)
    const look = q.get("look");
    const prev = getFormSource();
    if (look) setFormSource(lookSource(look, prev));
    void docOf(q.get("theme") ?? "oled").then((doc) => {
      setThemePreview("try", doc);
      setReady(true);
    });
    return () => {
      if (look) setFormSource(prev);
    };
  }, []);
  useEffect(() => {
    if (!ready || q.get("open") !== "1") return;
    const t = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(`[data-room-header="${ROOM}"] button[aria-label="More"]`)?.click();
    }, 50);
    return () => window.clearTimeout(t);
  }, [ready]);
  return (
    <div
      style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--th-timeline-bg)" }}
      data-gallery-ready={ready ? "" : undefined}
    >
      {ready && <RoomHeaderBar roomId={ROOM} mobile onBack={() => {}} />}
    </div>
  );
}
