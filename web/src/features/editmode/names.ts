// names.ts — what edit mode calls each island (EDITMODE-UI §2, §7): its name, icon, the one-line description of the Add
// island drawer and the placeholder line shown while its real content is absent. Pure.
import { kindOf } from "../../layout/schema";

export interface IslandText {
  name: string;
  icon: string;
  about: string;
  /** the placeholder's line (absent content) */
  absent: string;
}

const T: Record<string, IslandText> = {
  nav: { name: "Navigation", icon: "go-home-symbolic", about: "Home, Favourites, People, Rooms", absent: "" },
  dms: { name: "DMs", icon: "mail-message-new-symbolic", about: "DM bubbles, while you have unread DMs", absent: "Shows while you have unread DMs" },
  spaces: { name: "Spaces", icon: "view-grid-symbolic", about: "Your spaces and the + button", absent: "" },
  rooms: { name: "Rooms", icon: "view-list-details-symbolic", about: "Space name, filter and the room list", absent: "" },
  widgets: { name: "Widgets", icon: "view-calendar-upcoming-events-symbolic", about: "Up next, Call stats, Who's around", absent: "Add a widget to fill it" },
  account: { name: "Account", icon: "user-symbolic", about: "You, your status and your buttons", absent: "" },
  header: { name: "Room header", icon: "documentinfo-symbolic", about: "The room's name, topic and buttons", absent: "Shows when a room is open" },
  call: { name: "Call", icon: "call-start-symbolic", about: "Call tiles, streams and controls", absent: "Shows during a call" },
  timeline: { name: "Messages", icon: "dialog-messages-symbolic", about: "The room's messages", absent: "Shows when a room is open" },
  composer: { name: "Composer", icon: "document-edit-symbolic", about: "Where you write", absent: "Shows when a room is open" },
  panel: { name: "Room info", icon: "documentinfo-symbolic", about: "Room info and members", absent: "Room info and members" },
  buttons: { name: "Button island", icon: "view-more-horizontal-symbolic", about: "A button row you made yourself", absent: "" },
};

/** The island's texts; `k` = its 1-based position among the button islands (buttons:<n>). */
export function islandText(ref: string, k?: number): IslandText {
  const t = T[kindOf(ref)];
  if (!t) return { name: "Needs a newer Tin Hat", icon: "help-about-symbolic", about: "Made by a newer Tin Hat — kept as it is", absent: "" };
  if (kindOf(ref) === "buttons") return { ...t, name: k ? `Button island ${k}` : t.name };
  return t;
}
