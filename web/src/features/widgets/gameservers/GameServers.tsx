// gameservers/GameServers.tsx — the Game servers widget (docs/GAMESERVERS.md §4–§5; the desktop's GameServersWidget.qml):
// what runs on the group's game servers (Pelican, through the Tin Hat server — never the panel itself), who's on, uptime,
// CPU and RAM, the join address + password (masked until shown), a line of info, the "Ports closed — LAN only" chip and
// the next calendar event for the game; admins (`manage_game_servers`, checked by the server on every request) start,
// stop and restart servers, with the confirmations and the "Stop X and start Y" switch of §3.4–§3.5. S / collapsed = one
// line; M = the running servers as cards + "Other games (n)" (collapsed); L = every server as a card.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { Icon, Menu, MenuItem, cx } from "@/ui";
import { CATALOG_BASE, artUrl, openCalendar } from "@/features/calendar";
import { fmtClock, useClockMode } from "@/features/settings";
import {
  chipOf, cpuPm, cpuText, isUp, memPm, memText, nextEventFor, sizeText, summaryOf, uptimeText, whoLine,
  type CalItem, type GameServer, type GameStatus,
} from "@/widgets/gameservers";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import { CrossFade, useFreshIds } from "../motion";
import { dayWord } from "../upnext/UpNext";
import { useCalendarItems } from "../upnext/model";
import { refresh, setGameServersMock, useGameServers, type GsError } from "./store";
import { Bar, IconBtn, JoinRow, LanChip, StateDot, usePower } from "./parts";
import s from "./GameServers.module.css";

export interface GsModel {
  /** an answer (or a definite error) is in */
  ready: boolean;
  error: GsError;
  status: GameStatus | null;
  /** calendar events of every joined space (the "Next:" line) and the clock they are read against */
  events: CalItem[];
  now: number;
}

// ---- the model ------------------------------------------------------------------------------------------------------

function useModel(ctx: WidgetCtx): GsModel {
  void ctx;
  const gs = useGameServers(true); // the gallery's preview shows live data too
  const events = useCalendarItems();
  const now = useMemo(() => Date.now(), [gs.rev, events]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ ready: !gs.loading, error: gs.error, status: gs.status, events, now }), [gs.rev, gs.loading, gs.error, gs.status, events, now]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---- small parts ----------------------------------------------------------------------------------------------------

export const coverOf = (sv: GameServer): string => (sv.steamAppId ? artUrl(CATALOG_BASE, `steam:${sv.steamAppId}`, "portrait") : "");

function Cover({ sv, small }: { sv: GameServer; small?: boolean }) {
  const tile = <span className={s.emoji}>{sv.emoji || "🎮"}</span>;
  const url = coverOf(sv);
  return url ? <CrossFade className={cx(s.cover, small && s.coverSmall)} src={url} fallback={tile} /> : <span className={cx(s.cover, small && s.coverSmall, s.tile)}>{tile}</span>;
}

/** "Start a game…": every offline server that can start, with its memory size and the LAN chip. */
function StartPicker({ st, onPick, preview, children }: { st: GameStatus; onPick: (id: string) => void; preview: boolean; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const list = st.servers.filter((x) => x.state === "offline" && !x.pending && !x.unavailable);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.linkBtn}
        disabled={preview || list.length === 0}
        data-no-drag=""
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {children}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref.current} width={260} title="Start a game">
        {list.map((x) => (
          <MenuItem
            key={x.id}
            text={x.name}
            icon="media-playback-start-symbolic"
            trailing={
              <span className={s.pickTrail}>
                <span className={s.pickSize}>{sizeText(x.memory.limitMB)}</span>
                {!x.outside && <LanChip />}
              </span>
            }
            onTriggered={() => onPick(x.id)}
          />
        ))}
      </Menu>
    </>
  );
}

// ---- a server card --------------------------------------------------------------------------------------------------

function Card({ sv, m, ctx, power, full }: { sv: GameServer; m: GsModel; ctx: WidgetCtx; power: ReturnType<typeof usePower>; full: boolean }) {
  const st = m.status!;
  const mode = useClockMode();
  const chip = chipOf(sv);
  const who = whoLine(sv);
  const busy = !!sv.pending || sv.state === "starting" || sv.state === "stopping" || !!power.busy[sv.id];
  const next = sv.calendar ? nextEventFor(sv.id, m.events, m.now, st) : null;
  const running = sv.state === "running";
  return (
    <div className={s.card} data-server={sv.id} data-state={sv.state}>
      <Cover sv={sv} />
      <div className={s.cardText}>
        <div className={s.nameRow}>
          <span className={s.name} title={sv.game && sv.game !== sv.name ? `${sv.name} · ${sv.game}` : sv.name}>
            {sv.name}
          </span>
          {st.canManage && (
            <span className={s.controls}>
              {sv.state === "offline" && !sv.pending ? (
                <IconBtn icon="media-playback-start-symbolic" label={`Start ${sv.name}`} disabled={ctx.preview || busy || !!sv.unavailable} onClick={() => power.run("start", sv.id)} />
              ) : (
                <>
                  <IconBtn icon="view-refresh-symbolic" label={`Restart ${sv.name}`} disabled={ctx.preview || busy || !running} onClick={() => power.run("restart", sv.id)} />
                  <IconBtn icon="media-playback-stop-symbolic" label={`Stop ${sv.name}`} disabled={ctx.preview || busy} onClick={() => power.run("stop", sv.id)} />
                </>
              )}
            </span>
          )}
        </div>
        <div className={s.chipLine}>
          <StateDot sv={sv} />
          <span className={s.chipText}>{chip.text}</span>
          {running && !sv.pending && <span className={s.uptime}>· {uptimeText(sv.uptimeMs)}</span>}
        </div>
        {sv.state !== "offline" && who !== "" && (
          <div className={s.players} title={sv.players?.names.join(", ") || undefined}>
            {who}
          </div>
        )}
        {sv.state !== "offline" && (
          <div className={s.bars}>
            <Bar pm={cpuPm(sv.cpu)} label="CPU" value={cpuText(sv.cpu)} />
            <Bar pm={memPm(sv.memory)} label="RAM" value={memText(sv.memory)} />
          </div>
        )}
      </div>
      <div className={s.cardFoot}>
        <JoinRow sv={sv} preview={ctx.preview} />
        {(sv.info || !sv.outside) && (
          <div className={s.infoLine}>
            {!sv.outside && <LanChip long />}
            {sv.info && (
              <span className={cx(s.info, full && s.infoFull)} title={sv.info}>
                {sv.info}
              </span>
            )}
          </div>
        )}
        {next && (
          <button
            type="button"
            className={s.next}
            disabled={ctx.preview}
            data-no-drag=""
            onClick={(e) => {
              e.stopPropagation();
              openCalendar({ containerId: next.container, eventId: next.id });
            }}
          >
            Next: {next.title} · {dayWord(next.start, m.now)} {fmtClock(next.start, mode)}
          </button>
        )}
        {full && sv.next && (
          <div className={s.schedule}>
            {sv.next.what === "backup" ? "Backup" : "Restart"} {dayWord(sv.next.at, m.now)} {fmtClock(sv.next.at, mode)}
          </div>
        )}
      </div>
    </div>
  );
}

function OtherRow({ sv, st, ctx, power }: { sv: GameServer; st: GameStatus; ctx: WidgetCtx; power: ReturnType<typeof usePower> }) {
  const busy = !!sv.pending || !!power.busy[sv.id];
  return (
    <div className={s.other} data-server={sv.id}>
      <Cover sv={sv} small />
      <span className={s.otherName} title={sv.name}>
        {sv.name}
      </span>
      <span className={s.otherChip}>{chipOf(sv).text}</span>
      {!sv.outside && <LanChip />}
      {st.canManage && (
        <IconBtn icon="media-playback-start-symbolic" label={`Start ${sv.name}`} disabled={ctx.preview || busy || !!sv.unavailable || sv.state !== "offline"} onClick={() => power.run("start", sv.id)} />
      )}
    </div>
  );
}

// ---- the widget -----------------------------------------------------------------------------------------------------

function Body({ model: m, ctx }: PartProps<GsModel>) {
  const st = m.status;
  const power = usePower(st);
  const [openOthers, setOpenOthers] = useState(false);
  const me = useSession().userId ?? "";
  useJobToast(st, me, ctx.preview);
  const up = st ? st.servers.filter(isUp) : [];
  const fresh = useFreshIds(up.map((x) => x.id));
  if (!m.ready) return <div className={s.status}>Checking the game servers…</div>;
  if (m.error === "not-member") return <div className={s.status}>Only for the members of its space</div>;
  if (!st)
    return (
      <div className={s.status}>
        Can't reach the game servers ·{" "}
        <button type="button" className={s.retry} data-no-drag="" disabled={ctx.preview} onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  const L = ctx.size === "L";
  const cards = L ? [...up, ...st.servers.filter((x) => !isUp(x))] : up;
  const others = L ? [] : st.servers.filter((x) => !isUp(x));
  return (
    <div className={s.body} data-mobile={ctx.mobile ? "" : undefined}>
      {up.length === 0 && (
        <div className={s.empty}>
          <Icon name="network-server-symbolic" size={20} color="var(--th-widget-muted-fg)" staticOnly />
          <span className={s.emptyText}>No game running</span>
          {st.canManage && (
            <StartPicker st={st} preview={ctx.preview} onPick={(id) => power.run("start", id)}>
              Start a game…
            </StartPicker>
          )}
        </div>
      )}
      {cards.map((sv) => (
        <div key={sv.id} className={fresh.has(sv.id) ? "tw-enter-up" : undefined}>
          <Card sv={sv} m={m} ctx={ctx} power={power} full={L} />
        </div>
      ))}
      {others.length > 0 && (
        <>
          <div className={s.othersHead}>
            <button
              type="button"
              className={s.othersToggle}
              aria-expanded={openOthers}
              data-no-drag=""
              onClick={(e) => {
                e.stopPropagation();
                setOpenOthers((x) => !x);
              }}
            >
              <Icon name={openOthers ? "go-down-symbolic" : "go-next-symbolic"} size={12} color="currentColor" staticOnly />
              <span>Other games ({others.length})</span>
            </button>
            {st.canManage && up.length > 0 && (
              <StartPicker st={st} preview={ctx.preview} onPick={(id) => power.run("start", id)}>
                Start a game…
              </StartPicker>
            )}
          </div>
          {openOthers && others.map((sv) => <OtherRow key={sv.id} sv={sv} st={st} ctx={ctx} power={power} />)}
        </>
      )}
      {power.dialogs}
    </div>
  );
}

/** A failed switch of mine: its error, once. */
function useJobToast(st: GameStatus | null, me: string, preview: boolean) {
  const seen = useRef<string>("");
  useEffect(() => {
    const j = st?.job;
    if (preview || !j || j.step !== "failed" || j.by !== me || !j.error) return;
    const key = `${j.from}/${j.to}/${j.since}`;
    if (seen.current === key) return;
    seen.current = key;
    toast(j.error, { kind: "error" });
  }, [st?.job, me, preview]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Summary({ model: m }: PartProps<GsModel>) {
  const text = !m.ready ? "Checking…" : m.error === "not-member" ? "Only for the members of its space" : m.status ? summaryOf(m.status) : "Can't reach the game servers";
  return <span className={s.summary}>{text}</span>;
}

function HeaderExtra({ model: m }: PartProps<GsModel>) {
  const st = m.status;
  const n = st ? st.servers.filter(isUp).length : 0;
  if (!st || n === 0) return null;
  return (
    <span className={s.extra}>
      {n} of {st.cap} running
    </span>
  );
}

// ---- samples (the gallery preview, the review screenshots, the gates) -------------------------------------------------

const SRV = (id: string, name: string, game: string, app: number | null, emoji: string, limitMB: number, port: number, over: Partial<GameServer> = {}): GameServer => ({
  id, name, game, steamAppId: app, emoji, state: "offline", unavailable: null, uptimeMs: 0,
  cpu: { used: 0, limit: 300 }, memory: { usedMB: 0, limitMB }, players: null,
  join: { address: `play.example.com:${port}`, password: "sample-pw" }, info: "", outside: false, calendar: true, pending: null, next: null, ...over,
});
const VALHEIM_INFO = "Steam only · unlisted. Modded: install the same mods as the server (see the pinned message), or it refuses you.";
function sampleServers(): GameServer[] {
  return [
    SRV("8e6c2f05", "Valheim Vanilla", "Valheim", 892970, "🪓", 8192, 2456, { outside: true, info: VALHEIM_INFO }),
    SRV("6c3f9a02", "Project Zomboid B42 Vanilla", "Project Zomboid", 108600, "🧟", 14336, 16261, { outside: true, cpu: { used: 0, limit: 1600 }, info: "Workshop mods download automatically when you join." }),
    SRV("7d4a1b93", "Palworld", "Palworld", 1623730, "🐾", 16384, 8211, { cpu: { used: 0, limit: 1600 }, info: "Unlisted — join with the address (direct connect)." }),
    SRV("5b2d7e40", "Satisfactory", "Satisfactory", 526870, "🏭", 8192, 7777, { cpu: { used: 0, limit: 1600 }, join: { address: "play.example.com:7777", password: null }, info: "Add it in the Server Manager with the address." }),
    SRV("a1c0de77", "Abiotic Factor", "Abiotic Factor", 427410, "🧪", 6144, 7779, { cpu: { used: 0, limit: 400 } }),
    SRV("e2b4c6d8", "FTB Skies 2", "Minecraft", null, "⛏️", 10240, 25565, { cpu: { used: 0, limit: 600 }, join: { address: "play.example.com:25565", password: null }, info: "The FTB Skies 2 modpack — install the same version from the FTB or CurseForge app." }),
  ];
}
const RUNNING = (sv: GameServer, players: GameServer["players"], used: number, memMB: number): GameServer => ({
  ...sv, state: "running", uptimeMs: 2 * 86_400_000 + 21 * 3_600_000 + 17 * 60_000, cpu: { used, limit: sv.cpu.limit }, memory: { usedMB: memMB, limitMB: sv.memory.limitMB }, players,
  next: { what: "backup", at: 0 },
});
function sample(opts: { admin?: boolean; up?: "valheim" | "two" | "none"; members?: boolean; loading?: boolean; error?: boolean } = {}): GsModel {
  const now = Date.now();
  const list = sampleServers();
  if (opts.up !== "none") list[0] = RUNNING(list[0]!, { count: 3, names: ["Darrow", "Sable", "Wren"] }, 17.6, 2028);
  if (opts.up === "two") list[1] = RUNNING(list[1]!, { count: 1, names: ["Rowan"] }, 54.2, 6310);
  for (const x of list) if (x.next) x.next = { what: "backup", at: dayAt(now + 86_400_000, 4, 40) };
  const st: GameStatus = {
    at: now, space: "!sample:sample.invalid", announceRoom: null, canManage: !!opts.admin, cap: 2,
    running: list.filter(isUp).length, memoryBudgetMB: 30720, memoryUsedMB: list.filter(isUp).reduce((a, x) => a + x.memory.limitMB, 0),
    stale: false, servers: list, job: null,
  };
  const events: CalItem[] = [
    { container: "!lounge:sample.invalid", id: "ev-valheim", title: "Valheim night", kind: "session", start: dayAt(now + 2 * 86_400_000, 19, 0), end: dayAt(now + 2 * 86_400_000, 22, 0), canceled: false, game: "Valheim", gameId: "steam:892970" },
  ];
  if (opts.loading) return { ready: false, error: null, status: null, events: [], now };
  if (opts.members) return { ready: true, error: "not-member", status: null, events: [], now };
  if (opts.error) return { ready: true, error: "network", status: null, events: [], now };
  return { ready: true, error: null, status: st, events, now };
}
/** The local day of `ms` at hh:mm. */
function dayAt(ms: number, h: number, m: number): number {
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** Dev / gate hook (features/widgets/index.tsx `__twWidgets.gsStore`): the app-wide status = sample `key` (null = live). */
export function mockStoreWith(key: string | null): void {
  if (key === null) return setGameServersMock(null);
  const make = gameServers.samples[key];
  if (!make) throw new Error(`no scenario gameServers/${key}`);
  const m = make();
  setGameServersMock(m.status, m.error);
}

export const gameServers = defineWidget<GsModel>({
  id: "gameServers",
  useModel,
  live: (m) => !!m.status && m.status.servers.some(isUp),
  Summary,
  HeaderExtra,
  Body,
  hasData: (m) => m.ready && !!m.status,
  samples: {
    preview: () => sample(),
    member: () => sample(),
    admin: () => sample({ admin: true }),
    two: () => sample({ admin: true, up: "two" }),
    empty: () => sample({ admin: true, up: "none" }),
    "empty-member": () => sample({ up: "none" }),
    "members-only": () => sample({ members: true }),
    loading: () => sample({ loading: true }),
    error: () => sample({ error: true }),
  },
});
