// model.ts — the timeline model (port of room.rs:2841-3459 row derivation) over the js-sdk timeline.
//
// Rows = non-edit m.room.message + undecryptable m.room.encrypted. Edits (newest m.replace from the SAME
// sender wins, D7), redactions, reactions (counted per user id, D6/D7), replies, mentions, pins, media,
// embeds, link-preview candidates and calendar refs are folded in. Local echoes = the js-sdk pending
// events (+ the chat's own upload echoes) and always render after the server rows in send order.
import { EventStatus, type MatrixEvent, type Room } from "matrix-js-sdk";
import { bodyIsOnlyEmbed, extractEmbeds, previewCandidate, stripReplyFallback, type Embed } from "./embeds";
import { htmlToText } from "./html";
import { utdRow } from "./utd";
import { readDice } from "@/widgets/dice";
import { START_TYPES, readStart } from "@/widgets/polls";
import { currentRelation } from "@/core/matrix/moved";

export interface Reaction {
  key: string;
  count: number;
  mine: boolean;
  /** my reaction event id (or a pending local id) — "" when not mine */
  myEventId: string;
  myEvent: MatrixEvent | null;
  who: string[];
}

export interface MediaRef {
  kind: "image" | "video" | "audio" | "file";
  url?: string;
  file?: { url: string; key: { k: string }; iv: string; hashes: Record<string, string>; v: string };
  mimetype: string;
  size: number;
  w: number;
  h: number;
  duration: number;
  name: string;
  /** local object URL (upload echo) */
  localUrl?: string;
}

export interface ReplyRef {
  id: string;
  loaded: boolean;
  sender: string;
  name: string;
  body: string;
}

export interface Row {
  id: string;
  eventId: string | null;
  sender: string;
  ts: number;
  mine: boolean;
  msgtype: string;
  body: string;
  formatted: string;
  edited: boolean;
  redacted: boolean;
  undecryptable: boolean;
  /** why it can't be read: the SDK's decryption failure code (null = not known yet / readable) — lib/utd.ts */
  utdCode: string | null;
  pending: boolean;
  failed: boolean;
  failReason: string;
  echo: boolean;
  /** js-sdk local echo (text/reaction) */
  local: MatrixEvent | null;
  /** chat-owned upload echo id */
  uploadId?: string;
  replyTo: ReplyRef | null;
  reactions: Reaction[];
  mentionsMe: boolean;
  pinned: boolean;
  media: MediaRef | null;
  embeds: Embed[];
  onlyEmbed: boolean;
  previewUrl: string | null;
  calendar: { container: string; event: string } | null;
  event: MatrixEvent | null;
  /** the displayed content (edit applied) */
  content: Record<string, unknown>;
}

export interface UploadEcho {
  id: string;
  roomId: string;
  ts: number;
  file: File;
  localUrl: string;
  w: number;
  h: number;
  state: "uploading" | "failed";
  error: string;
  msgtype: "m.image" | "m.video" | "m.audio" | "m.file";
}

type C = Record<string, unknown>;

function relatesTo(c: C): C | null {
  const r = c["m.relates_to"];
  return r && typeof r === "object" ? (r as C) : null;
}

export function isEdit(ev: MatrixEvent): boolean {
  const r = relatesTo(ev.getOriginalContent() as C) ?? relatesTo(ev.getContent() as C);
  return r?.rel_type === "m.replace";
}

function isLocallyRedacted(ev: MatrixEvent): boolean {
  return ev.isRedacted() || !!ev.localRedactionEvent?.();
}

export function isUndecryptable(ev: MatrixEvent): boolean {
  if (ev.isDecryptionFailure()) return true;
  return ev.getWireType() === "m.room.encrypted" && ev.getType() === "m.room.encrypted" && !ev.isBeingDecrypted();
}

/** The cleartext relation of an event (an encrypted one keeps `m.relates_to` outside the ciphertext). */
function wireRelType(ev: MatrixEvent): string | null {
  const r = relatesTo(ev.getWireContent() as C)?.rel_type;
  return typeof r === "string" ? r : null;
}

export function isRowEvent(ev: MatrixEvent): boolean {
  // 2026-10-23 (lib/utd.ts utdRow, shared with the desktop): an edit / poll vote / reaction we can't read is no row
  if (isUndecryptable(ev)) return utdRow({ redacted: ev.isRedacted(), relType: wireRelType(ev) }) !== "hidden";
  const t = ev.getType();
  if (t === "m.room.message") return ev.isRedacted() ? true : !isEdit(ev);
  if (t === "m.room.encrypted") return isUndecryptable(ev);
  // widgets W3: a poll start is a row (the poll card, WIDGETS-UI.md §17.4) — one this app can't read shows nothing, as
  // on the desktop and in Element; its responses and ends are not rows
  if ((START_TYPES as readonly string[]).includes(t)) return ev.isRedacted() || readStart(t, ev.getOriginalContent()) !== null;
  return false;
}

/** Friendly failure reason (room.rs:2190-2204). */
export function failReason(err: unknown): string {
  const e = err as { errcode?: string; httpStatus?: number; name?: string; message?: string } | null;
  const code = e?.errcode ?? "";
  if (code === "M_FORBIDDEN" || e?.httpStatus === 403) return "You don't have permission to send here";
  if (code === "M_TOO_LARGE" || e?.httpStatus === 413) return "That file is too large for the server";
  if (code === "M_LIMIT_EXCEEDED" || e?.httpStatus === 429) return "Slow down — the server is rate-limiting sends";
  if (e?.name === "ConnectionError" || /network|fetch|connection/i.test(e?.message ?? "")) return "No connection — will not retry on its own";
  return "Couldn't send";
}

export function displayName(room: Room | null, userId: string): string {
  const m = room?.getMember(userId);
  const n = m?.rawDisplayName || m?.name;
  if (n && n !== userId) return n;
  return userId.replace(/^@/, "").split(":")[0];
}

function mediaOf(c: C, msgtype: string, localUrl?: string): MediaRef | null {
  const kind = msgtype === "m.image" ? "image" : msgtype === "m.video" ? "video" : msgtype === "m.audio" ? "audio" : msgtype === "m.file" ? "file" : null;
  if (!kind) return null;
  const info = (c.info && typeof c.info === "object" ? c.info : {}) as C;
  const file = c.file && typeof c.file === "object" ? (c.file as MediaRef["file"]) : undefined;
  const url = typeof c.url === "string" ? c.url : undefined;
  return {
    kind,
    url,
    file,
    mimetype: typeof info.mimetype === "string" ? info.mimetype : "",
    size: typeof info.size === "number" ? info.size : 0,
    w: typeof info.w === "number" ? info.w : 0,
    h: typeof info.h === "number" ? info.h : 0,
    duration: typeof info.duration === "number" ? info.duration : 0,
    name: typeof c.body === "string" && c.body ? c.body : kind,
    localUrl,
  };
}

export interface BuildOpts {
  room: Room | null;
  me: string;
  myName: string;
  events: MatrixEvent[];
  uploads: UploadEcho[];
  pinned: string[];
}

export function buildRows({ room, me, myName, events, uploads, pinned }: BuildOpts): Row[] {
  const pinnedSet = new Set(pinned);
  // ---- pass 1: relations
  const edits = new Map<string, MatrixEvent[]>(); // target → its edits (sender checked in pass 2)
  const reacts = new Map<string, Map<string, { users: Map<string, MatrixEvent>; order: number }>>();
  let order = 0;
  for (const ev of events) {
    const t = ev.getType();
    if (ev.status === EventStatus.CANCELLED) continue;
    if (t === "m.room.message" && !ev.isRedacted()) {
      const oc = ev.getOriginalContent() as C;
      // a moved server's events: the relation by today's ids (core/matrix/moved.ts)
      const rel = currentRelation(relatesTo(oc), ev.getUnsigned());
      if (rel?.rel_type === "m.replace" && typeof rel.event_id === "string") {
        if (isLocallyRedacted(ev)) continue;
        const list = edits.get(rel.event_id);
        if (list) list.push(ev);
        else edits.set(rel.event_id, [ev]);
      }
    } else if (t === "m.reaction") {
      if (isLocallyRedacted(ev) || ev.status === EventStatus.NOT_SENT) continue;
      const rel = currentRelation(relatesTo(ev.getContent() as C), ev.getUnsigned());
      if (rel?.rel_type !== "m.annotation" || typeof rel.event_id !== "string" || typeof rel.key !== "string") continue;
      let per = reacts.get(rel.event_id);
      if (!per) reacts.set(rel.event_id, (per = new Map()));
      let k = per.get(rel.key);
      if (!k) per.set(rel.key, (k = { users: new Map(), order: order++ }));
      const sender = ev.getSender() ?? "";
      if (!k.users.has(sender)) k.users.set(sender, ev);
    }
  }

  // ---- pass 2: rows
  const rows: Row[] = [];
  const byId = new Map<string, Row>();
  const lowerMe = myName.toLowerCase();
  const pendingRows: Row[] = [];
  for (const ev of events) {
    if (!isRowEvent(ev)) continue;
    if (ev.status === EventStatus.CANCELLED) continue;
    const id = ev.getId() ?? ev.getTxnId() ?? "";
    const sender = ev.getSender() ?? "";
    const mine = sender === me;
    // js-sdk turns a failed decryption into m.room.message / m.bad.encrypted — still a locked row
    const undec = !ev.isRedacted() && (ev.getType() === "m.room.encrypted" || ev.isDecryptionFailure());
    const redacted = isLocallyRedacted(ev);
    let content = (redacted ? {} : ev.getOriginalContent()) as C;
    let edited = false;
    // D7: only the original sender's edits count; the newest wins (a pending local edit beats all)
    let edit: MatrixEvent | undefined;
    if (!redacted)
      for (const e of edits.get(ev.getId() ?? "") ?? []) {
        if (e.getSender() !== sender) continue;
        if (!edit || e.status != null || (edit.status == null && e.getTs() >= edit.getTs())) edit = e;
      }
    if (edit) {
      const nc = (edit.getOriginalContent() as C)["m.new_content"];
      if (nc && typeof nc === "object") {
        const n = nc as C;
        content = {
          ...content,
          body: n.body,
          msgtype: content.msgtype === "m.emote" && n.msgtype === "m.text" ? "m.text" : (n.msgtype ?? content.msgtype),
          format: n.format,
          formatted_body: n.format === "org.matrix.custom.html" ? n.formatted_body : undefined,
        };
        if (n.format !== "org.matrix.custom.html") delete content.formatted_body;
        edited = true;
      }
    }
    // widgets W3: a poll start reads "Poll: <question>" wherever a row's text shows (replies, snippets); its own msgtype
    // keeps it out of the text features (edit, embeds, link previews)
    const pollStart = (START_TYPES as readonly string[]).includes(ev.getType());
    const msgtype = pollStart ? POLL_MSGTYPE : typeof content.msgtype === "string" ? content.msgtype : "m.text";
    const rawBody = pollStart ? `Poll: ${readStart(ev.getType(), content)?.question ?? ""}` : typeof content.body === "string" ? content.body : "";
    const rel = currentRelation(relatesTo(ev.getOriginalContent() as C), ev.getUnsigned());
    const inReply = rel && typeof rel["m.in_reply_to"] === "object" ? ((rel["m.in_reply_to"] as C).event_id as string | undefined) : undefined;
    const body = inReply ? stripReplyFallback(rawBody) : rawBody;
    const formatted = !redacted && content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" ? content.formatted_body : "";
    const status = ev.status;
    const pending = status === EventStatus.SENDING || status === EventStatus.QUEUED || status === EventStatus.ENCRYPTING;
    const failed = status === EventStatus.NOT_SENT;
    const isText = msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote";
    const mentions = content["m.mentions"] as C | undefined;
    const lb = body.toLowerCase();
    const mentionsMe =
      !mine &&
      !redacted &&
      !undec &&
      ((Array.isArray(mentions?.user_ids) && (mentions!.user_ids as string[]).includes(me)) ||
        mentions?.room === true ||
        lb.includes("@room") ||
        (lowerMe.length >= 3 && lb.includes(lowerMe)));
    const cal = !redacted ? (ev.getOriginalContent() as C)["dev.tinhat.calendar"] : undefined;
    const row: Row = {
      id,
      eventId: ev.getId() && !ev.getId()!.startsWith("~") ? ev.getId()! : null,
      sender,
      ts: ev.getTs(),
      mine,
      msgtype,
      body,
      formatted,
      edited,
      redacted,
      undecryptable: undec,
      utdCode: undec ? (ev.decryptionFailureReason ?? null) : null,
      pending,
      failed,
      failReason: failed ? failReason(ev.error) : "",
      echo: status != null,
      local: status != null ? ev : null,
      replyTo: inReply ? { id: inReply, loaded: false, sender: "", name: "", body: "" } : null,
      reactions: [],
      mentionsMe,
      pinned: !!ev.getId() && pinnedSet.has(ev.getId()!),
      media: redacted || undec ? null : mediaOf(content, msgtype),
      embeds: !redacted && !undec && isText ? extractEmbeds(body) : [],
      onlyEmbed: false,
      previewUrl: !redacted && !undec && msgtype === "m.text" ? previewCandidate(body) : null,
      calendar:
        cal && typeof cal === "object" && typeof (cal as C).container === "string" && typeof (cal as C).event === "string"
          ? { container: (cal as C).container as string, event: (cal as C).event as string }
          : null,
      event: ev,
      content,
    };
    row.onlyEmbed = row.embeds.length > 0 && bodyIsOnlyEmbed(body);
    // reactions
    const per = ev.getId() ? reacts.get(ev.getId()!) : undefined;
    if (per && !redacted) {
      row.reactions = [...per.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([key, v]) => {
          const myEv = v.users.get(me) ?? null;
          return {
            key,
            count: v.users.size,
            mine: !!myEv,
            myEventId: myEv ? (myEv.getId() ?? "") : "",
            myEvent: myEv,
            // CB:1095-1106: the reacting members' display names (mine included, by name), NEWEST first —
            // room.rs:3053-3080 aggregates while walking the window newest → oldest
            who: [...v.users.keys()].reverse().map((u) => displayName(room, u)),
          };
        });
    }
    if (row.echo) pendingRows.push(row);
    else {
      rows.push(row);
      byId.set(id, row);
    }
  }
  // pending echoes after the server rows (send order)
  for (const r of pendingRows) {
    rows.push(r);
    byId.set(r.id, r);
  }
  // upload echoes
  for (const u of uploads) {
    const kind = u.msgtype;
    const r: Row = {
      id: u.id,
      eventId: null,
      sender: me,
      ts: u.ts,
      mine: true,
      msgtype: kind,
      body: u.file.name,
      formatted: "",
      edited: false,
      redacted: false,
      undecryptable: false,
      utdCode: null,
      pending: u.state === "uploading",
      failed: u.state === "failed",
      failReason: u.error,
      echo: true,
      local: null,
      uploadId: u.id,
      replyTo: null,
      reactions: [],
      mentionsMe: false,
      pinned: false,
      media: {
        kind: kind === "m.image" ? "image" : kind === "m.video" ? "video" : kind === "m.audio" ? "audio" : "file",
        mimetype: u.file.type,
        size: u.file.size,
        w: u.w,
        h: u.h,
        duration: 0,
        name: u.file.name,
        localUrl: u.localUrl,
      },
      embeds: [],
      onlyEmbed: false,
      previewUrl: null,
      calendar: null,
      event: null,
      content: { msgtype: kind, body: u.file.name },
    };
    rows.push(r);
    byId.set(r.id, r);
  }
  // replies from loaded rows
  for (const r of rows) {
    if (!r.replyTo) continue;
    const p = byId.get(r.replyTo.id);
    if (p) {
      r.replyTo = {
        id: p.id,
        loaded: true,
        sender: p.sender,
        name: displayName(room, p.sender),
        body: snippetOf(p),
      };
    }
  }
  return rows;
}

export function snippetOf(r: Row): string {
  if (r.redacted) return "Message deleted";
  if (r.undecryptable) return "Encrypted message";
  if (r.media && !r.body) return r.media.kind;
  const t = r.formatted ? htmlToText(r.formatted) : r.body;
  return t.replace(/\s+/g, " ").trim();
}

/** widgets W3: the msgtype of a poll start row (not a real msgtype: poll starts are events of their own). */
export const POLL_MSGTYPE = "org.matrix.msc3381.poll";

/** widgets W3: the row is a dice roll (its ORIGINAL content re-adds up) — shown as the dice card, never edited. */
export function isDiceRow(r: Row): boolean {
  return !r.redacted && !!r.event && readDice(r.event.getOriginalContent()) !== null;
}

/** Can this row be reacted to / replied to (not deleted, locked or an echo). */
export function isInteractive(r: Row): boolean {
  return !r.redacted && !r.undecryptable && !r.echo && !!r.eventId;
}
