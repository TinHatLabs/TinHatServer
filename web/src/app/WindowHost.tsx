// WindowHost.tsx — hosts the in-app secondary windows (the native's separate OS windows:
// Calendar, Memories, Watch Party, Space settings, Game Reel, Icon gallery …). Features register
// them in r.windows ({ id, title, icon, component, defaultSize, minSize, singleton }) and open them
// with openWindow(id, props) / closeWindow(id) from @/core/bus. Singleton windows (the default)
// are raised when opened again ("openOrRaise"). Click raises; z-order is the open order.
// Window content gets `useAppWindow()` → { id, close, raise, setFloating } and its props. `setFloating(geo)` (11.3, the
// Media Party mini player) draws the window at a content-defined geometry — kept above every other window when
// `onTop` — without touching its remembered geometry; `setFloating(null)` returns it to exactly where it was.
import { createContext, useCallback, useContext, useState } from "react";
import { useBus } from "@/core/bus";
import { useRegistry } from "@/core/registry";
import { AppWindow, type FloatingGeo } from "@/ui";

interface OpenWin {
  key: string; // id, or id#n for non-singletons
  id: string;
  props: Record<string, unknown>;
  z: number;
  floating?: FloatingGeo | null;
}

interface WinCtx {
  id: string;
  key: string;
  close: () => void;
  raise: () => void;
  /** draw the window at this outer geometry (title bar included) until null; never saved as its geometry */
  setFloating: (geo: FloatingGeo | null) => void;
}
const Ctx = createContext<WinCtx | null>(null);

/** Inside a registered window: its id and controls. */
export function useAppWindow(): WinCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAppWindow() outside a WindowHost window");
  return c;
}

let seq = 0;

export function WindowHost() {
  const defs = useRegistry("windows");
  const [open, setOpen] = useState<OpenWin[]>([]);
  const top = open.reduce((m, w) => Math.max(m, w.z), 0);

  const raise = useCallback((key: string) => {
    setOpen((ws) => {
      const max = ws.reduce((m, w) => Math.max(m, w.z), 0);
      return ws.map((w) => (w.key === key && w.z !== max ? { ...w, z: max + 1 } : w));
    });
  }, []);
  const close = useCallback((key: string) => setOpen((ws) => ws.filter((w) => w.key !== key && w.id !== key)), []);
  const setFloating = useCallback((key: string, floating: FloatingGeo | null) => setOpen((ws) => ws.map((w) => (w.key === key ? { ...w, floating } : w))), []);

  useBus("openWindow", ({ id, props }) => {
    const def = defs.find((d) => d.id === id);
    if (!def) {
      console.warn(`[windows] no window registered as "${id}"`);
      return;
    }
    setOpen((ws) => {
      const max = ws.reduce((m, w) => Math.max(m, w.z), 0);
      if (def.singleton !== false) {
        const cur = ws.find((w) => w.id === id);
        if (cur) return ws.map((w) => (w === cur ? { ...w, props: props ?? w.props, z: max + 1 } : w));
      }
      const key = def.singleton === false ? `${id}#${++seq}` : id;
      return [...ws, { key, id, props: props ?? {}, z: max + 1 }];
    });
  });
  useBus("closeWindow", ({ id }) => close(id));

  return (
    <>
      {open.map((w, i) => {
        const def = defs.find((d) => d.id === w.id);
        if (!def) return null;
        const C = def.component;
        const title = typeof def.title === "function" ? def.title(w.props) : def.title;
        return (
          <Ctx.Provider key={w.key} value={{ id: w.id, key: w.key, close: () => close(w.key), raise: () => raise(w.key), setFloating: (g) => setFloating(w.key, g) }}>
            <AppWindow
              id={w.id}
              title={title}
              icon={def.icon}
              defaultSize={def.defaultSize}
              minSize={def.minSize}
              z={w.floating?.onTop ? top + 1 : w.z}
              floating={w.floating ?? null}
              active={w.z === top}
              cascade={i}
              phoneHeader={def.phoneHeader}
              defaultPlacement={def.defaultPlacement}
              onRaise={() => raise(w.key)}
              onClose={() => close(w.key)}
            >
              <C {...w.props} />
            </AppWindow>
          </Ctx.Provider>
        );
      })}
    </>
  );
}
