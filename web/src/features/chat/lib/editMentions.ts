// editMentions.ts — L1 A09.3: the @-mentions of an edit (an edit used to drop every mention link of the message, and
// mentions picked while editing were ignored). The same rule as the desktop's room.rs edit_mentions, through the shared
// vectors testvectors/edit-mentions/vectors.json (byte-identical in both repos).
import type { PickedMention } from "./markdown";

const UNESC: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The people a message's formatted body links (matrix.to/#/@user anchors): name without its "@", HTML-unescaped. */
export function linkedMentions(formatted: string): PickedMention[] {
  const out: PickedMention[] = [];
  const re = /<a href="https:\/\/matrix\.to\/#\/([^"]+)">@([^<]*)<\/a>/g;
  for (let m = re.exec(formatted); m; m = re.exec(formatted)) {
    const userId = decode(m[1]);
    if (!userId.startsWith("@")) continue;
    out.push({ name: m[2].replace(/&(amp|lt|gt|quot|#39|#x27);/g, (e) => UNESC[e] ?? e), userId });
  }
  return out;
}

/** The edit's mentions: the picks made while editing, then the people the original linked, each only while its
 *  "@name" is in the new text; one per user id, first wins. */
export function editMentions(formatted: string, text: string, picks: PickedMention[]): PickedMention[] {
  const out: PickedMention[] = [];
  const seen = new Set<string>();
  for (const m of [...picks, ...linkedMentions(formatted)]) {
    if (seen.has(m.userId) || !text.includes("@" + m.name)) continue;
    seen.add(m.userId);
    out.push({ name: m.name, userId: m.userId });
  }
  return out;
}

/** The edit's top-level m.mentions: the sorted user ids among `mentions` the original did not link (the Matrix spec: an
 *  edit pings only the newly mentioned; m.new_content carries them all). */
export function editNotifyIds(formatted: string, mentions: PickedMention[]): string[] {
  const had = new Set(linkedMentions(formatted).map((m) => m.userId));
  return [...new Set(mentions.map((m) => m.userId).filter((u) => !had.has(u)))].sort();
}
