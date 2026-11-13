// PeoplePicker.tsx — the one add-people picker (2026-11-12): room Invite, New DM and space Invite (the desktop's
// PeoplePicker.qml). As you type: People you know (your DMs and rooms, instant, every server), On <your server> (the
// user directory, 250 ms debounced, stale answers dropped), and for a typed username/address nobody listed, one row
// that YOUR server looks up first (name, picture, server) and explains in plain words when it can't. Anyone not on
// your server shows their server next to their name. Members are dimmed. Arrows + Enter pick, Esc closes (the
// dialog's), the field is a combobox over a listbox for screen readers. The rules are people.ts (shared vectors).
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useId, type KeyboardEvent, type Ref } from "react";
import { Avatar, Button, Icon, ScrollArea, TextField, cx } from "@/ui";
import { toast } from "@/core/bus";
import { getSession } from "@/core/matrix";
import { copyText } from "@/features/nav/actions";
import { serverOf } from "@/features/nav/dmTarget";
import { MiddleElide } from "@/features/spaces/MiddleElide";
import { atrim, lookupOutcome, rankPeople, sectionTitle, type KnownPerson, type DirectoryHit, type LookupKind, type PersonRow, pickerPicture } from "./people";
import { knownPeople, lookupProfile, memberIds, searchDirectory, type ProfileAnswer } from "./source";
import s from "./PeoplePicker.module.css";

type Looked = { state: "looking" } | ({ state: "done"; kind: LookupKind; pickable: boolean; text: string; at: number } & ProfileAnswer);
/** look-ups worth another try (after RETRY_MS, when the row shows again) */
const RETRY = new Set<LookupKind>(["unreachable", "ratelimited"]);
const RETRY_MS = 5000;

export interface PeoplePickerProps {
  /** the action word: "Invite" (room/space) or "Message" (New DM) */
  verb: "Invite" | "Message";
  /** the room/space whose members are dimmed (null = none, New DM) */
  roomId: string | null;
  /** a person was picked; return true to clear the field and keep picking (space/room invites) */
  onPick: (mxid: string) => boolean | void;
  placeholder?: string;
  /** the text the field starts with (New DM from someone's profile) */
  initial?: string;
  /** the row Enter would pick now (a pickable person) or null: the dialog's own button acts on it */
  onSelection?: (mxid: string | null) => void;
  /** the dialog's own button: pick what Enter would pick */
  handle?: Ref<{ pickSelected: () => void }>;
  /** test hook: stand-in sources (the screenshot rig) */
  sources?: {
    known?: () => KnownPerson[];
    search?: (t: string) => Promise<DirectoryHit[]>;
    lookup?: (id: string) => Promise<ProfileAnswer>;
    members?: () => string[];
    me?: string;
  };
}

export function PeoplePicker({ verb, roomId, onPick, placeholder, initial, onSelection, handle, sources }: PeoplePickerProps) {
  const me = sources?.me ?? getSession().userId ?? "";
  const own = serverOf(me);
  const [text, setText] = useState(initial ?? "");
  const [known] = useState<KnownPerson[]>(() => (sources?.known ?? knownPeople)());
  const [members, setMembers] = useState<string[]>(() => (sources?.members ?? (() => memberIds(roomId)))());
  const [dir, setDir] = useState<{ term: string; hits: DirectoryHit[] }>({ term: "", hits: [] });
  const [looked, setLooked] = useState<Record<string, Looked>>({});
  // the selection is a PERSON (and the text it was made for), never a row index: async rows (the directory, a look-up, a
  // picture) must not move Enter onto someone else
  const [chosen, setChosen] = useState<{ mxid: string; text: string } | null>(null);
  const seq = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();

  const ranked = useMemo(() => {
    const t = atrim(text);
    // a directory answer for an older text is dropped (it would flash the wrong people)
    const hits = dir.term === t ? dir.hits : [];
    return rankPeople({ input: text, own, me, known, directory: hits, members });
  }, [text, own, me, known, dir, members]);
  const rows = ranked.rows;

  // the directory: 250 ms after the last key
  useEffect(() => {
    const t = atrim(text);
    const mine = ++seq.current;
    if (!t) return;
    const h = window.setTimeout(() => {
      void (sources?.search ?? searchDirectory)(t).then((hits) => {
        if (seq.current === mine) setDir({ term: t, hits });
      });
    }, 250);
    return () => window.clearTimeout(h);
  }, [text, sources]);

  // the look-up row: your server asks for their profile (once per address per picker)
  const lookupId = rows.find((r) => r.lookup)?.mxid ?? "";
  useEffect(() => {
    if (!lookupId) return;
    const prev = looked[lookupId];
    if (prev && !(prev.state === "done" && RETRY.has(prev.kind) && Date.now() - prev.at > RETRY_MS)) return;
    const h = window.setTimeout(() => {
      // a retry keeps the earlier failure (and its block) until the new answer is in
      setLooked((m) => ({ ...m, [lookupId]: prev && prev.state === "done" ? { ...prev, at: Date.now() } : { state: "looking" } }));
      void (sources?.lookup ?? lookupProfile)(lookupId).then((a) => {
        const o = lookupOutcome(a.status, a.errcode, a.message, lookupId, own);
        setLooked((m) => ({ ...m, [lookupId]: { state: "done", at: Date.now(), ...a, ...o } }));
      });
    }, 300);
    return () => window.clearTimeout(h);
  }, [lookupId, looked, own, sources]);

  const pickable = (r: PersonRow): boolean => {
    if (r.member) return false;
    const l = looked[r.mxid];
    // a failed look-up blocks that person in every row (a directory or room row can't re-enable them)
    if (l?.state === "done" && !l.pickable) return false;
    if (!r.lookup) return true;
    return l?.state === "done" && l.pickable;
  };

  // Enter's default (people.ts): the typed person; once their look-up has failed, the fallback (your server only)
  const pickRow = rows[ranked.pick];
  const pickLook = pickRow ? looked[pickRow.mxid] : undefined;
  const defaultSel = pickRow && pickRow.lookup && pickLook?.state === "done" && !pickLook.pickable ? ranked.fallback : ranked.pick;
  const chosenIdx = chosen && chosen.text === text ? rows.findIndex((r) => r.mxid === chosen.mxid && !r.member) : -1;
  const sel = chosenIdx >= 0 ? chosenIdx : defaultSel;
  const setSel = (i: number) => setChosen(i >= 0 && rows[i] ? { mxid: rows[i].mxid, text } : null);

  const pick = (r: PersonRow | undefined) => {
    if (!r || !pickable(r)) return;
    const keep = onPick(r.mxid);
    if (keep) {
      setMembers((m) => [...m, r.mxid]);
      setChosen(null);
      setText("");
      field.current?.focus();
    }
  };

  const selected = sel >= 0 && sel < rows.length && pickable(rows[sel]) ? rows[sel].mxid : null;
  useEffect(() => onSelection?.(selected), [selected, onSelection]);

  useImperativeHandle(handle, () => ({ pickSelected: () => pick(rows[sel]) }));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      let i = sel;
      for (let n = 0; n < rows.length; n++) {
        i = (i + step + rows.length) % rows.length;
        if (!rows[i].member) break;
      }
      setSel(i);
      document.getElementById(`${listId}-${i}`)?.scrollIntoView({ block: "nearest" });
    }
  };

  const view = (r: PersonRow): { name: string; avatar: string; note: string; tag: string; anyway: boolean } => {
    if (r.member) return { name: r.name, avatar: r.avatar, note: "", tag: "already a member", anyway: false };
    const l = looked[r.mxid];
    if (!r.lookup) return { name: r.name, avatar: r.avatar, note: l?.state === "done" && !l.pickable ? l.text : "", tag: "", anyway: false };
    if (!l || l.state === "looking") return { name: r.name, avatar: "", note: "Looking them up…", tag: "", anyway: false };
    return { name: l.name || r.name, avatar: l.avatar, note: l.text, tag: "", anyway: l.kind === "refused" };
  };

  // the list is as tall as its rows (measured: a row with a wrapped note is taller), up to 300 px, then it scrolls
  const [contentH, setContentH] = useState(0);
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    const el = hasRows ? document.getElementById(listId) : null;
    if (!el) return;
    const fit = () => setContentH(el.offsetHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRows, listId]);
  const listH = Math.min(300, Math.max(72, contentH + 4));
  const active = sel >= 0 && sel < rows.length ? `${listId}-${sel}` : undefined;
  let lastSection = "";
  return (
    <div className={s.col} data-people-picker="">
      <TextField
        ref={field}
        autoFocus
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls={listId}
        aria-activedescendant={active}
        aria-autocomplete="list"
        aria-label="Name, username or address"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder ?? "Name, username or @name:their.server"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onAccepted={() => pick(rows[sel])}
      />
      <div className={s.list} style={{ height: rows.length ? listH : undefined }}>
        {rows.length === 0 ? (
          <div className={s.empty} role="status">
            {ranked.query.kind === "empty"
              ? "Type a name, a username, or someone's full address."
              : "No one by that name. Someone on another server: type their full address, like @name:their.server."}
          </div>
        ) : (
          <ScrollArea className={s.list} style={{ height: listH }} contentClassName={s.rows}>
            <div id={listId} role="listbox" aria-label="People">
              {rows.map((r, i) => {
                const v = view(r);
                const head = r.section !== lastSection ? sectionTitle(r.section, own) : "";
                lastSection = r.section;
                const ok = pickable(r);
                return (
                  <div key={r.mxid} role="presentation">
                    {head && (
                      <div className={s.section} role="presentation" data-people-section={r.section}>
                        {head}
                      </div>
                    )}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === sel}
                      aria-disabled={!ok}
                      aria-label={`${v.name}${r.server ? ` · ${r.server}` : ""}, ${r.mxid}${v.tag ? `, ${v.tag}` : ""}${v.note ? `. ${v.note}` : ""}${v.anyway ? ` ${verb} anyway.` : ""}`}
                      data-people-row={r.mxid}
                      className={cx(s.row, i === sel && ok && s.sel, !ok && s.off)}
                      onMouseEnter={() => ok && setSel(i)}
                      onClick={() => pick(r)}
                    >
                      <div className={cx(s.inner, v.note && s.withNote)} style={{ opacity: r.member ? 0.55 : 1 }}>
                        <Avatar size={28} name={v.name || r.mxid} seed={r.mxid} imageSource={pickerPicture(v.avatar) || null} />
                        <div className={s.text}>
                          <div className={s.nameLine}>
                            <span className={s.name}>{v.name}</span>
                            {r.server && <span className={s.server}>&nbsp;· {r.server}</span>}
                          </div>
                          <MiddleElide className={s.sub} text={r.mxid} />
                          {v.note && <div className={s.note}>{v.note}</div>}
                        </div>
                        {v.tag ? (
                          <span className={s.tag}>{v.tag}</span>
                        ) : v.anyway ? (
                          // not a button: an option holds no controls (the row itself picks; its label says so)
                          <span className={s.anyway} aria-hidden="true">
                            {verb} anyway
                          </span>
                        ) : ok ? (
                          <Icon name={verb === "Message" ? "document-edit-symbolic" : "list-add-user"} size={16} color="var(--th-invite-result-icon)" />
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
      {me && (
        <div className={s.footer}>
          <span className={s.mineLabel}>Your address:</span>
          <MiddleElide className={s.mine} text={me} />
          <Button
            flat
            icon="edit-copy-symbolic"
            text="Copy my address"
            onClick={() => void copyText(me).then((ok) => toast(ok ? "Copied your address" : "Couldn't copy"))}
          />
        </div>
      )}
    </div>
  );
}
