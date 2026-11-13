// lazy.tsx — a component that lives in its own chunk (web-perf 2026-11-07). The shell, the registries and every feature's
// setup() stay exactly as they are; only the component's code (a settings pane, a window, a dev page) is fetched when it
// first renders — or earlier, at the first idle moment after the session is ready (core/afterstart), so in practice it
// is already there when someone opens it and nothing waits.
//
//   const AudioPane = lazyPart("AudioPane", () => import("./panes/AudioPane").then((m) => m.AudioPane));
//
// While the chunk is on its way the part renders nothing (Suspense fallback null): a window opened in that moment shows
// its frame and fills in. A chunk that can't be FETCHED (offline before the prefetch ran, a network blip) stays this
// part's own business: it shows "Couldn't load this part" with a Reload button in its own place (the rest of the app keeps
// working; a reload keeps the session). No automatic retry: browsers remember a failed module fetch for the page's
// lifetime (Chromium measured: a re-import of the same chunk fails without asking the network again), so only a reload
// can fetch it. Everything else — an error the module throws while it is evaluated, an error the component throws while
// rendering — goes up to the shell's boundaries at once, exactly as before.
import { Component, lazy, Suspense, useRef, type ComponentType, type ReactElement, type ReactNode } from "react";
import { InlineMessage } from "./InlineMessage";
import { afterStart } from "@/core/afterstart";
import { createLogger } from "@/core/log";

const log = createLogger("lazy");

/** The browsers' words for "the module script could not be fetched" (Chromium, Firefox, WebKit) — a heuristic: browsers
 *  give no typed signal for it. An error the module throws while it is evaluated doesn't read like this and is never
 *  caught here. */
const FETCH_FAILED = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** A failed chunk fetch, as opposed to an error of the module or the component. */
class ChunkLoadFailed extends Error {
  readonly part: string;
  constructor(part: string, cause: unknown) {
    super(`couldn't load ${part}: ${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.part = part;
  }
}

type Caught = { kind: "none" } | { kind: "fetch"; error: ChunkLoadFailed } | { kind: "other"; error: unknown };

class LoadBoundary extends Component<{ children: ReactNode }, { caught: Caught }> {
  state: { caught: Caught } = { caught: { kind: "none" } };

  static getDerivedStateFromError(e: unknown): { caught: Caught } {
    return { caught: e instanceof ChunkLoadFailed ? { kind: "fetch", error: e } : { kind: "other", error: e } };
  }

  componentDidCatch(e: unknown) {
    if (e instanceof ChunkLoadFailed) log.warn(e.message);
  }

  render() {
    const c = this.state.caught;
    if (c.kind === "other") throw c.error; // not ours: the nearest outer boundary handles it as before
    if (c.kind === "fetch")
      return (
        <InlineMessage
          type="error"
          text="Couldn't load this part of Tin Hat — are you offline? Reload when you're back (you stay signed in)."
          actions={[{ text: "Reload", onTriggered: () => location.reload() }]}
        />
      );
    return this.props.children;
  }
}

/** `prefetch: false` = fetched only when it first renders (dev / QA pages nobody opens in normal use). */
export function lazyPart<P extends object>(name: string, load: () => Promise<ComponentType<P>>, { prefetch = true } = {}): ComponentType<P> {
  // one fetch shared by every instance and by the prefetch; a failed one is forgotten (a new instance asks again)
  let loading: Promise<{ default: ComponentType<P> }> | null = null;
  /** once loaded, every later instance renders it directly (a fresh React.lazy would suspend for a tick first) */
  let resolved: ComponentType<P> | null = null;
  const get = () =>
    (loading ??= load().then(
      (c) => ((resolved = c), { default: c }),
      (e: unknown) => {
        loading = null;
        throw FETCH_FAILED.test(String((e as Error)?.message ?? e)) ? new ChunkLoadFailed(name, e) : e;
      },
    ));
  function Part(props: P): ReactElement {
    // chosen once per instance (switching an instance from one to the other would remount what it shows)
    const ready = useRef(resolved);
    return ready.current ? <PartResolved C={ready.current} props={props} /> : <PartLoading props={props} />;
  }
  function PartLoading({ props }: { props: P }): ReactElement {
    const inner = useRef<ComponentType<P> | null>(null);
    inner.current ??= lazy(get);
    const Inner = inner.current;
    return (
      <LoadBoundary>
        <Suspense fallback={null}>
          <Inner {...props} />
        </Suspense>
      </LoadBoundary>
    );
  }
  Part.displayName = `lazy(${name})`;
  PartLoading.displayName = `lazy(${name}).loading`;
  if (prefetch) afterStart(() => void get().catch(() => undefined));
  return Part;
}

/** The already-loaded component: nothing to wait for or retry, so no boundary of its own (its render errors reach the
 *  outer boundaries, as they do through LoadBoundary). */
function PartResolved<P extends object>({ C, props }: { C: ComponentType<P>; props: P }): ReactElement {
  return <C {...props} />;
}
