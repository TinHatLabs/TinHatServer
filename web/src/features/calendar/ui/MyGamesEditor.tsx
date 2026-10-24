// MyGamesEditor.tsx — MyGamesEditor.qml (CAL-86..92): my would-play / favorite / definitely-not
// lists, the catalog search (220 ms field debounce → the store's 300 ms debounce, cancels the
// previous request), Enter adds a custom entry when nothing matched, Flexible, the Steam import
// (tick chips, "Tick all" = first 60) and the privacy note. Local copy of my prefs, reloaded when
// my stored prefs change and nothing is dirty. Save → normalized + `{}` when empty (store).
import { useEffect, useRef, useState } from "react";
import { useServerFeature } from "@/core/server";
import { cx } from "@/ui";
import { useGames, savePrefs, searchCatalog, addCustomGame, importSteamLibrary } from "../gamesStore";
import { ReelButton, Art, art } from "./ReelParts";
import s from "./Reel.module.css";

type Json = Record<string, unknown>;
interface LocalPrefs {
  wouldPlay: string[];
  favorites: string[];
  definitelyNot: string[];
  flexible: boolean;
}
type ListKey = "wouldPlay" | "favorites" | "definitelyNot";

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function fromStored(p: Json): { prefs: LocalPrefs; names: Record<string, string> } {
  const names: Record<string, string> = {};
  const n = p.names;
  if (n && typeof n === "object")
    for (const [k, v] of Object.entries(n as Json)) {
      const nm = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as Json).name === "string" ? ((v as Json).name as string) : "";
      if (nm) names[k] = nm;
    }
  return { prefs: { wouldPlay: strs(p.wouldPlay), favorites: strs(p.favorites), definitelyNot: strs(p.definitelyNot), flexible: p.flexible === true }, names };
}

const COLS: Array<{ key: ListKey; title: string; hint: string }> = [
  { key: "wouldPlay", title: "Would play", hint: "Games you own and would play." },
  { key: "favorites", title: "Favorite", hint: "One game that gets the bigger share of your vote." },
  { key: "definitelyNot", title: "Definitely not", hint: "A hard veto while you’re here." },
];

export function MyGamesEditor() {
  const stored = useGames((x) => x.myPrefs);
  const results = useGames((x) => x.search);
  const imp = useGames((x) => x.importState);
  const busy = useGames((x) => x.busy);
  const [prefs, setPrefs] = useState<LocalPrefs>(() => fromStored(stored).prefs);
  const [nameCache, setNameCache] = useState<Record<string, string>>(() => fromStored(stored).names);
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState("");
  const [qFocus, setQFocus] = useState(false);
  const [steam, setSteam] = useState("");
  const [steamFocus, setSteamFocus] = useState(false);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (dirty) return;
    const f = fromStored(stored);
    setPrefs(f.prefs);
    setNameCache((c) => ({ ...c, ...f.names }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  useEffect(() => () => void (deb.current && clearTimeout(deb.current)), []);

  const nameOf = (id: string) => {
    const n = nameCache[id];
    if (n) return n;
    return id.startsWith("steam:") ? "Steam app " + id.slice(6) : id.replace(/^[a-z]+:/, "");
  };
  const addTo = (key: "wouldPlay" | "definitelyNot", g: Json) => {
    const id = String(g.id ?? "");
    if (!id) return;
    if (typeof g.name === "string") setNameCache((c) => ({ ...c, [id]: g.name as string }));
    setPrefs((p0) => {
      const p = { ...p0 };
      const other: ListKey = key === "wouldPlay" ? "definitelyNot" : "wouldPlay";
      p[other] = p[other].filter((x) => x !== id);
      if (!p[key].includes(id)) p[key] = [...p[key], id];
      if (key === "definitelyNot") p.favorites = p.favorites.filter((x) => x !== id);
      return p;
    });
    setDirty(true);
  };
  const remove = (id: string) => {
    setPrefs((p) => ({ ...p, wouldPlay: p.wouldPlay.filter((x) => x !== id), favorites: p.favorites.filter((x) => x !== id), definitelyNot: p.definitelyNot.filter((x) => x !== id) }));
    setDirty(true);
  };
  const toggleFavorite = (id: string) => {
    setPrefs((p) => ({ ...p, favorites: p.favorites.includes(id) ? [] : [id] }));
    setDirty(true);
  };
  const save = () => {
    void savePrefs({ wouldPlay: prefs.wouldPlay, favorites: prefs.favorites, definitelyNot: prefs.definitelyNot, flexible: prefs.flexible, names: nameCache });
    setDirty(false);
  };
  const qt = q.trim();
  const items = (Array.isArray(imp.items) ? (imp.items as Json[]) : []).slice(0, 60);
  const impErr = typeof imp.error === "string" ? imp.error : "";
  const impVisible = imp.error !== undefined || imp.items !== undefined;
  // docs/SELFHOST.md: a server without the games catalogue has no search (and nothing to add by name); without a Steam
  // key no import — the lists themselves stay (removing, favourites, Flexible)
  const gamesOn = useServerFeature("games");
  const steamOn = useServerFeature("steam");
  const multiplayer = (g: Json) => {
    const f = g.flags as Json | null | undefined;
    if (f === null) return "checking…";
    return f && (f.multiplayer || f.coop || f.onlinePvp || f.onlineCoop) ? "multiplayer" : "single-player";
  };

  return (
    <div className={s.editor} data-testid="reel-mygames">
      <div className={s.edHead}>
        <span className={s.edTitle}>My games</span>
        {dirty && <span className={s.unsaved}>unsaved</span>}
        <ReelButton text="Save" primary disabled={!dirty || busy} onClick={save} />
      </div>
      {gamesOn && (
      <>
      <label className={cx(s.field36, qFocus && s.fieldFocus)}>
        <input
          value={q}
          onFocus={() => setQFocus(true)}
          onBlur={() => setQFocus(false)}
          onChange={(e) => {
            setQ(e.target.value);
            if (deb.current) clearTimeout(deb.current);
            const v = e.target.value.trim();
            deb.current = setTimeout(() => {
              if (v.length >= 2) searchCatalog(v);
            }, 220);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && qt.length >= 2 && results.length === 0) void addCustomGame(qt);
          }}
          aria-label="Add a game — type its name"
        />
        {!q && !qFocus && <span className={s.placeholder}>Add a game — type its name</span>}
      </label>
      {qt.length >= 2 && results.length > 0 && (
        <div className={s.results}>
          {results.slice(0, 10).map((g) => (
            <div key={String(g.id)} className={s.resultTile}>
              <Art src={art(String(g.id))} className={s.art28} />
              <div className={s.rtCol}>
                <span className={s.rtName}>{String(g.name ?? g.id)}</span>
                <span className={s.rtMeta}>{(g.year ? g.year + " · " : "") + multiplayer(g)}</span>
              </div>
              <ReelButton text="+" width={30} height={26} radius={5} hint="Add to would-play" onClick={() => addTo("wouldPlay", g)} aria-label="Add to would-play" />
              <ReelButton text="✕" quiet width={30} height={26} radius={5} hint="Definitely not" onClick={() => addTo("definitelyNot", g)} aria-label="Definitely not" />
            </div>
          ))}
        </div>
      )}
      {qt.length >= 2 && results.length === 0 && <div className={s.dim11}>Nothing yet — Steam takes a moment. Not on Steam? Press Enter to add it by name.</div>}
      </>
      )}
      <div className={s.cols3}>
        {COLS.map((c) => (
          <div key={c.key} className={s.listCol}>
            <div className={s.caps11}>{c.title}</div>
            <div className={s.dim10}>{c.hint}</div>
            {prefs[c.key].map((id) => (
              <div key={id} className={cx(s.listRow, prefs.favorites.includes(id) && s.listRowFav)}>
                <Art src={art(id)} className={s.art18} />
                <span className={s.rowName}>{nameOf(id)}</span>
                {c.key === "wouldPlay" && <ReelButton text={prefs.favorites.includes(id) ? "★" : "☆"} quiet width={26} height={24} radius={5} hint="Favorite" onClick={() => toggleFavorite(id)} aria-label="Favorite" />}
                <ReelButton text="–" quiet width={26} height={24} radius={5} hint="Remove" onClick={() => remove(id)} aria-label="Remove" />
              </div>
            ))}
            {prefs[c.key].length === 0 && <div className={s.dim12}>—</div>}
          </div>
        ))}
      </div>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={prefs.flexible}
          onChange={(e) => {
            setPrefs((p) => ({ ...p, flexible: e.target.checked }));
            setDirty(true);
          }}
        />
        <span className={cx(s.checkBox, prefs.flexible && s.checkOn)}>{prefs.flexible ? "✓" : ""}</span>
        <span className={s.checkText}>I’ll play whatever wins. Your games still count toward what everyone owns.</span>
      </label>
      {steamOn && (
      <>
      <div className={s.steamRow}>
        <label className={cx(s.field34, steamFocus && s.fieldFocus)}>
          <input value={steam} onChange={(e) => setSteam(e.target.value)} onFocus={() => setSteamFocus(true)} onBlur={() => setSteamFocus(false)} aria-label="Steam profile link" />
          {!steam && !steamFocus && <span className={cx(s.placeholder, s.placeholder12)}>Steam profile link (optional) — imports your multiplayer games</span>}
        </label>
        <ReelButton text="Import" disabled={steam.trim().length <= 2 || busy} onClick={() => void importSteamLibrary(steam.trim(), true)} />
      </div>
      {imp.loading === true && <div className={s.dim11}>Importing…</div>}
      {impVisible && (
        <div className={s.impRow}>
          <span className={impErr ? s.err11 : s.dim11}>
            {impErr ? impErr : `${items.length} games found` + (imp.pending ? ` (${imp.pending} still being checked)` : "") + " — tick the ones you’d play:"}
          </span>
          {!impErr && items.length > 0 && (
            <ReelButton
              text="Tick all"
              height={24}
              radius={5}
              onClick={() => {
                for (const g of items) addTo("wouldPlay", g);
              }}
            />
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className={s.impFlow}>
          {items.map((g) => {
            const id = String(g.id);
            const on = prefs.wouldPlay.includes(id);
            return <ReelButton key={id} text={String(g.name ?? id)} checked={on} height={26} radius={5} onClick={() => (on ? remove(id) : addTo("wouldPlay", g))} />;
          })}
        </div>
      )}
      </>
      )}
      <div className={s.dim10}>
        The group sees your lists, favorite, vetoes and the Flexible flag. It never sees your Steam ID, playtime or full library; the import is forgotten the moment it is shown.
      </div>
    </div>
  );
}
