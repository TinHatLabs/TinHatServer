// PadExtras.tsx — the Pad's QOL parts (2026-10-31, share claude/tinhat-pad/QOL-20261031/DESIGN-ADDENDUM.md; docs/PAD.md
// "QOL"): the desktop twin is PadWindow.qml's same-named sections.
//
//   WebSearch    the soundboard's web search, run by THIS device (its own server, its own bearer); a result plays on
//                the computer (`sound.play.web`) or ☆ goes to my board (my own favourites: account data, synced)
//   Watch        "<name> is sharing · Watch": this device joins the call to WATCH (a normal, visible join: no mic
//                captured, deafened, camera off); phones show the share here with Full screen; "This phone" row:
//                Hear here · Talk here · Stop watching
//   PartyCard    the call room's Media Party on the computer: what plays, ▶/⏸, −10 s / +10 s, ⏭, Up next, Add a link
//                (`party.*`, bound to what the Pad saw playing); "Join on <device>" / "Watch on this phone"
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, SearchField, Switch, TextField, ToolButton, cx } from "@/ui";
import { toast } from "@/core/bus";
import { useMember } from "@/core/matrix";
import { SoundPadButton, SoundPadGrid } from "@/features/widgets/soundpad/SoundPad";
import { searchSounds, type Sound } from "@/features/media/soundboard/data";
import { addFavourite } from "@/features/media/soundboard/store";
import { DEFAULT_EMOJI, type PadSound } from "@/widgets/soundpad";
import { partyLinkOk, webSoundOk, whyText } from "@/features/calls/pad/rules";
import { partyPosNow, type PadView } from "@/features/calls/pad/controller";
import { WATCH_AVAILABLE } from "@/features/calls/watchAvailable";
import { useCallStore } from "@/features/calls";
import { Tile } from "@/features/callui/Tile";
import { isShareTile, ui, useC } from "@/features/callui/store";
import { mxidOf } from "@/features/calls/util";
import { fmtTime } from "@/features/media/watchparty/queue";
import { openWatchParty } from "@/features/media/watchparty";
import { padController, usePadCtrl } from "./runtime";
import { enterShareFullscreen, type FsHandle } from "@/features/callui/fullscreen";
import s from "./PadExtras.module.css";
import ps from "./PadScreen.module.css";

const PENDING_RING = "var(--th-pad-pending-ring)";

function useRev(): number {
  return usePadCtrl((x) => x.rev);
}

function Head({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className={ps.sectionHead}>
      <span className={ps.sectionTitle}>{title}</span>
      {hint && <span className={ps.sectionHint}>{hint}</span>}
    </div>
  );
}

function nameOf(m: ReturnType<typeof useMember>, u: string): string {
  return m?.rawName && m.rawName !== u ? m.rawName : m?.name || u.replace(/^@/, "").split(":")[0];
}

// ---- search (sound.play.web / ☆ my board) ---------------------------------------------------------------------------

/** The soundboard's web search inside the Pad. `favs` = my favourites' urls (☆ filled). */
export function WebSearch({ view, device, mobile, dim, favs, focusSignal }: { view: PadView; device: string; mobile: boolean; dim: boolean; favs: Set<string>; focusSignal: number }) {
  useRev();
  const c = padController();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Sound[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal > 0) field.current?.focus();
  }, [focusSignal]);
  const query = q.trim();
  useEffect(() => {
    if (query.length < 2) {
      setRes([]);
      setBusy(false);
      setErr("");
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    // the soundboard's own debounce (450 ms) and route: this device's server, this device's bearer
    const t = window.setTimeout(() => {
      searchSounds(query, ac.signal)
        .then((r) => {
          setRes(r.filter((x) => webSoundOk(x.sourceUrl)).slice(0, 24));
          setErr("");
        })
        .catch((e) => {
          if (ac.signal.aborted) return;
          setRes([]);
          setErr(`Couldn't search right now (${(e as Error)?.message ?? "error"}).`);
        })
        .finally(() => !ac.signal.aborted && setBusy(false));
    }, 450);
    return () => {
      ac.abort();
      window.clearTimeout(t);
    };
  }, [query]);
  const gate = view.me.gate;
  const canPlay = !dim && gate.allowed && !!c?.canSend("sound.play.web");
  const oldReceiver = !!c && !dim && !view.ops.includes("sound.play.web");
  const pending = !!c?.isPending("sound");
  const star = useCallback(
    (d: Sound) => {
      setStarred((x) => new Set(x).add(d.sourceUrl));
      void addFavourite(d.name || "Sound", d.sourceUrl, "", d.duration || 0)
        .then(() => toast(`Added “${d.name || "Sound"}” to your board`))
        .catch(() => {
          setStarred((x) => {
            const n = new Set(x);
            n.delete(d.sourceUrl);
            return n;
          });
          toast("Couldn't add it to your board — try again");
        });
    },
    [],
  );
  const items: PadSound[] = useMemo(() => res.map((r) => ({ name: r.name || "Sound", url: r.sourceUrl, emoji: DEFAULT_EMOJI })), [res]);
  return (
    <div className={s.search} data-testid="pad-search">
      <SearchField ref={field} className={s.searchField} value={q} onValueChange={setQ} placeholder="Search sounds on the web…" aria-label="Search sounds on the web" />
      {query.length >= 2 && (
        <>
          <Head title={`From the web${res.length ? ` · ${res.length}` : ""}`} hint={busy ? "searching…" : oldReceiver ? `☆ adds it to your board` : `tap plays on ${device} · ☆ adds to your board`} />
          {oldReceiver && <div className={ps.empty}>{whyText("old-op", device)} To play a result there now, ☆ it first.</div>}
          {err && <div className={ps.roleLine}>{err}</div>}
          {!busy && !err && res.length === 0 && <div className={ps.empty}>{`No sounds found for “${query}”.`}</div>}
          {items.length > 0 && (
            <SoundPadGrid mobile={mobile} columns={mobile ? 3 : 4}>
              {items.map((d) => {
                const playing = view.me.sound === d.url;
                const fav = favs.has(d.url) || starred.has(d.url);
                return (
                  <div key={d.url} className={s.webCell} data-web={d.url}>
                    <SoundPadButton d={d} playing={playing} pending={pending && playing} disabled={!canPlay} onPress={() => (playing ? c?.stopSound() : c?.playWebSound(d.url, d.name))} />
                    <button
                      type="button"
                      className={cx(s.star, fav && s.starOn)}
                      aria-label={fav ? `${d.name} is on your board` : `Add ${d.name} to your board`}
                      aria-pressed={fav}
                      disabled={fav}
                      onClick={() => star(res.find((r) => r.sourceUrl === d.url)!)}
                    >
                      <Icon name={fav ? "starred-symbolic" : "non-starred-symbolic"} size={16} color={fav ? "var(--th-soundboard-section-fg)" : "var(--th-soundboard-section-hint-fg)"} />
                    </button>
                  </div>
                );
              })}
            </SoundPadGrid>
          )}
          <div className={s.credit}>web results by myinstants</div>
        </>
      )}
    </div>
  );
}

// ---- watch ------------------------------------------------------------------------------------------------------------

/** "<name> is sharing · Watch", and while this device watches that call: the share (phones), full screen and the
 *  "This phone" row. */
export function Watch({ view, device, mobile }: { view: PadView; device: string; mobile: boolean }) {
  const watching = useC("watching");
  const callRoom = useC("callRoomId");
  const inCall = useC("inCall");
  const connecting = useC("connecting");
  const noCapture = useC("noCapture");
  const deaf = useC("deafened");
  const micMuted = useC("micMuted");
  const tiles = useC("tiles");
  const here = watching && callRoom === view.room && (inCall || connecting);
  const elsewhere = (inCall || connecting) && !here;
  const sharers = view.people.filter((p) => p.share);
  const first = useMember(view.room, sharers[0]?.u ?? "");
  const shares = useMemo(() => (tiles ?? []).filter((t) => isShareTile(t) && t.participant !== "You" && t.id !== "vid_selfshare"), [tiles]);
  const [pick, setPick] = useState("");
  const share = shares.find((t) => t.id === pick) ?? shares[0] ?? null;
  const shareName = useMember(view.room, share ? mxidOf(share.participant) : "");
  const box = useRef<HTMLDivElement>(null);
  // full screen belongs to ONE share (its id): that share ending (even with another one left), watching stopping or
  // the Pad closing leaves it and puts the layout back; the system's own exit clears it (review #10)
  const [fsh, setFsh] = useState<{ h: FsHandle; id: string } | null>(null);
  const fshRef = useRef<{ h: FsHandle; id: string } | null>(null);
  const alive = useRef(true);
  const fs = fsh?.h.mode ?? null;
  const endFs = useCallback(() => {
    fshRef.current?.h.exit();
    fshRef.current = null;
    setFsh(null);
  }, []);
  useEffect(() => {
    if (fsh && (!share || share.id !== fsh.id || !here)) endFs();
  }, [fsh, share, here, endFs]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      fshRef.current?.h.exit();
      fshRef.current = null;
    };
  }, []);

  if (!here) {
    // 12.1.6: Watch is off (calls/engine.ts WATCH_AVAILABLE; back in 12.1.7) — no Watch strip
    if (!sharers.length || !WATCH_AVAILABLE) return null;
    const who = sharers.length > 1 ? `${nameOf(first, sharers[0]!.u)} and ${sharers.length - 1} more are sharing` : `${nameOf(first, sharers[0]!.u)} is sharing`;
    return (
      <section className={cx(ps.section, s.watchStrip)} data-testid="pad-watch-strip">
        <div className={s.stripRow}>
          <Icon name="video-display-symbolic" size={20} color="var(--th-pad-list-bar-fg)" />
          <span className={s.stripText}>{who}</span>
          <Button
            text="Watch"
            disabled={elsewhere}
            data-testid="pad-watch"
            onClick={() => {
              // phones: the call screen stays minimised (the Pad shows the share), so one element plays it
              if (mobile) ui().set({ mobileMin: true });
              useCallStore.getState().watchCall(view.room);
            }}
          />
        </div>
        <div className={s.stripNote}>{elsewhere ? "Leave your call on this phone first." : "Joins on this phone to watch — muted, sound off. Everyone sees you joined."}</div>
      </section>
    );
  }
  const talking = !noCapture;
  const toggleFs = () => {
    if (fshRef.current) return endFs();
    const el = box.current;
    if (!el || !share) return;
    const id = share.id;
    void enterShareFullscreen(el, el.querySelector("video"), () => {
      fshRef.current = null;
      if (alive.current) setFsh(null);
    }).then((h) => {
      if (!alive.current) return h.exit(); // closed while it was entering: undo it
      fshRef.current = { h, id };
      setFsh({ h, id });
    });
  };
  return (
    <section className={ps.section} data-testid="pad-watch">
      <Head title={connecting && !inCall ? "Joining to watch…" : share ? `Watching ${nameOf(shareName, mxidOf(share.participant))}` : "Watching"} hint={share ? undefined : "nobody is sharing right now"} />
      {mobile && share && (
        <div ref={box} className={cx(s.shareBox, fs === "fill" && s.fill, fs === "element" && s.fsEl)} data-testid="pad-share" data-fs={fs ?? ""}>
          <Tile
            key={share.id}
            tile={share}
            slot={{ x: 0, y: 0, w: 0, h: 0 }}
            flow
            hidden={false}
            chrome
            watched
            pinned={false}
            animate={false}
            afkGrid={false}
            roomId={view.room}
            selfPipMode="grid"
            fake={false}
            mobile
            onFullscreen={toggleFs}
            fullscreen={!!fs}
          />
          <div className={s.fsBar}>
            {fs && talking && (
              <ToolButton iconName={micMuted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic"} tip={micMuted ? "Unmute this phone" : "Mute this phone"} onClick={() => useCallStore.getState().forceMicMuted(!micMuted)} className={s.fsBtn} />
            )}
          </div>
        </div>
      )}
      {mobile && shares.length > 1 && (
        <div className={s.pickRow}>
          {shares.map((t) => (
            <SharePick key={t.id} room={view.room} participant={t.participant} on={t.id === share?.id} onPick={() => setPick(t.id)} />
          ))}
        </div>
      )}
      {!mobile && <div className={ps.empty}>The share is on the call screen.</div>}
      <div className={s.phoneRow} data-testid="pad-phone-row">
        <span className={s.phoneHead}>This phone</span>
        <Switch text="Hear here" checked={!deaf} onToggled={(on) => useCallStore.getState().watchHear(on)} data-testid="pad-hear" />
        <Switch text={talking && !micMuted ? "Talk here · live" : "Talk here"} checked={talking && !micMuted} onToggled={(on) => useCallStore.getState().watchTalk(on)} data-testid="pad-talk" />
        <Button text="Stop watching" onClick={() => useCallStore.getState().leaveCall()} data-testid="pad-stop-watching" />
      </div>
      <div className={s.stripNote}>Mute, deafen and Leave above are {device}'s.</div>
    </section>
  );
}

function SharePick({ room, participant, on, onPick }: { room: string; participant: string; on: boolean; onPick: () => void }) {
  const u = mxidOf(participant);
  const m = useMember(room, u);
  return (
    <button type="button" className={cx(s.pick, on && s.pickOn)} onClick={onPick} aria-pressed={on}>
      {nameOf(m, u)}
    </button>
  );
}

// ---- Media Party ------------------------------------------------------------------------------------------------------

export function PartyCard({ view, device, dim }: { view: PadView; device: string; dim: boolean }) {
  useRev();
  const c = padController();
  const p = view.party;
  const [now, setNow] = useState(() => Date.now());
  const [link, setLink] = useState("");
  const [linkErr, setLinkErr] = useState("");
  useEffect(() => {
    if (!p?.playing) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [p?.playing]);
  if (!p) return null;
  const can = (op: string) => !dim && !!c?.canSend(op);
  const pend = (k: string) => (c?.isPending(k) ? PENDING_RING : undefined);
  if (!p.in) {
    return (
      <section className={cx(ps.section, s.party)} data-testid="pad-party">
        <Head title="Media Party" hint="on in this room" />
        <div className={s.partyRow}>
          <Button text={`Join on ${device}`} disabled={!can("party.join")} onClick={() => c?.partyJoin()} data-testid="pad-party-join" />
          <Button text="Watch on this phone" onClick={() => openWatchParty(view.room)} />
        </div>
      </section>
    );
  }
  const pos = partyPosNow(p, now);
  const watchHere = <Button text="Watch on this phone" onClick={() => openWatchParty(view.room)} data-testid="pad-party-watch-here" />;
  const drive = can("party.play") && p.host;
  const add = (playNow: boolean) => {
    const u = link.trim();
    if (!partyLinkOk(u)) {
      setLinkErr("Paste a YouTube, YouTube Music, Spotify or Apple Music link.");
      return;
    }
    setLinkErr("");
    if (c?.partyAdd(u, playNow)) setLink("");
  };
  return (
    <section className={cx(ps.section, s.party)} data-testid="pad-party">
      <Head title="Media Party" hint={`on ${device}`} />
      <div className={s.partyNow}>
        <span className={s.partyTitle} title={p.title || p.url}>
          {p.url ? p.title || p.url : "Nothing playing"}
        </span>
        {p.url && (
          <div className={s.partyBar} aria-label={`${fmtTime(pos)} of ${p.dur ? fmtTime(p.dur) : "unknown"}`}>
            <span className={s.partyTime}>{fmtTime(pos)}</span>
            <span className={s.partyTrack}>
              <span className={s.partyFill} style={{ width: p.dur ? `${Math.min(100, (pos / p.dur) * 100)}%` : "0%" }} />
            </span>
            <span className={s.partyTime}>{p.dur ? fmtTime(p.dur) : "--:--"}</span>
          </div>
        )}
      </div>
      <div className={s.partyControls}>
        <ToolButton label="−10 s" tip="Back 10 s" disabled={!drive || !p.url} onClick={() => c?.partySeek(Math.max(0, pos - 10))} className={s.pBtn} />
        <ToolButton
          iconName={p.playing ? "media-playback-pause" : "media-playback-start"}
          tip={p.playing ? "Pause" : "Play"}
          disabled={!drive || !p.url}
          onClick={() => c?.partyPlay(!p.playing)}
          className={s.pBtn}
          style={{ boxShadow: pend("party:play") ? `0 0 0 2px ${PENDING_RING}` : undefined }}
          data-testid="pad-party-play"
        />
        <ToolButton label="+10 s" tip="Forward 10 s" disabled={!drive || !p.url} onClick={() => c?.partySeek(p.dur ? Math.min(p.dur, pos + 10) : pos + 10)} className={s.pBtn} />
        <ToolButton iconName="media-skip-forward" tip="Play next in queue" disabled={!drive || p.next.length === 0} onClick={() => c?.partyNext()} className={s.pBtn} data-testid="pad-party-next" />
      </div>
      {!p.host && <div className={ps.empty}>{whyText("not-host", device)} You can still add links.</div>}
      {p.next.length > 0 && (
        <>
          <Head title="Up next" />
          <ol className={s.next}>
            {p.next.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </>
      )}
      {can("party.add") && (
        <div className={s.addRow}>
          <TextField value={link} onChange={(e) => setLink(e.target.value)} onAccepted={() => add(false)} placeholder="Add a link (YouTube, Spotify…)" aria-label="Add a link to the Media Party" className={s.addField} />
          <Button text="Add" onClick={() => add(false)} disabled={!link.trim()} />
          {p.host && <Button text="Play now" onClick={() => add(true)} disabled={!link.trim()} />}
        </div>
      )}
      {linkErr && <div className={ps.roleLine}>{linkErr}</div>}
      <div className={s.partyRow}>{watchHere}</div>
    </section>
  );
}
