// restoreProblem.ts — why a saved session didn't start, and what the sign-in card offers instead (desktop-gates-night,
// 2026-10-28). The desktop's crates/app/src/restore_err.rs; the same rule, the same words where both apps have the case.
//
// Until 12.1.1 every restore failure forgot the session, ended it on the server and wiped this browser's stores: a
// browser whose data was written by a newer Tin Hat Web (a server that went back a version) or a passing IndexedDB
// failure cost the device and its keys. Now nothing is forgotten on a failed restore; the card says which case it is
// and only the person's own "Start fresh" does what the old path did.
//
//   newer       IndexedDB refused to open a database at a lower version than the one stored (VersionError): this
//               browser's data was written by a newer Tin Hat. Try again (reload: the server may be updated) / Start fresh.
//   unreadable  anything else. Try again / Start fresh.
// The desktop's third case, "keyring" (M10, the OS keyring didn't answer), has no web counterpart: the web keeps no
// key in an OS keyring (docs/WEB-EXCEPTIONS.md). The desktop's Quit is the web's Try again (a page can't quit).

export type RestoreKind = "newer" | "unreadable";

export interface RestoreProblem {
  kind: RestoreKind;
  /** the newest Tin Hat that opened this browser's stores, when it is newer than this one */
  version?: string;
}

/** localStorage: the newest Tin Hat Web that opened this browser's stores (12.1.1 and later write it). */
export const WRITER_KEY = "tinhat.cache.store-writer";

/** "12.10.0" > "12.9.3" (numeric parts; a missing part = 0; anything after '-' or '+' ignored; unparsable = 0). */
export function versionNewer(a: string, b: string): boolean {
  const parts = (v: string) =>
    v.trim().split(/[-+]/)[0].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** A version string worth recording ("12.1.1", not "dev"). */
export function isRealVersion(v: string | undefined): v is string {
  return !!v && /^\d+(\.\d+)+/.test(v.trim());
}

/**
 * Was this browser's data written by a newer Tin Hat? IndexedDB refused a database at a lower version than the stored
 * one (DOMException VersionError, wrapped or not), or the Rust crypto store's own check said its schema is too new
 * (SchemaTooNewError, surfaced by matrix-sdk-crypto-wasm as a plain Error: "The schema version of the crypto store is
 * too new" — Astra 2026-10-28).
 */
export function isNewerStoreError(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 5; depth++) {
    const o = x as { name?: unknown; message?: unknown; cause?: unknown };
    if (o.name === "VersionError") return true;
    const m = typeof x === "string" ? x : String(o.message ?? "");
    if (/VersionError|less than the existing version|schema version of the crypto store is too new|SchemaTooNew/i.test(m)) return true;
    x = o.cause;
  }
  return false;
}

/** The decision (pure): a newer store wins; everything else is unreadable. */
export function classifyRestore(e: unknown, writer: string | null | undefined, me: string | undefined): RestoreProblem {
  if (isNewerStoreError(e)) {
    const version = writer && (!isRealVersion(me) || versionNewer(writer, me)) && isRealVersion(writer) ? writer : undefined;
    return version ? { kind: "newer", version } : { kind: "newer" };
  }
  return { kind: "unreadable" };
}

/** The sign-in card's line. */
export function restoreText(p: RestoreProblem): string {
  if (p.kind === "newer") {
    return p.version
      ? `Your data was saved by a newer Tin Hat. Use Tin Hat ${p.version} or newer to keep this sign-in (this server's Tin Hat Web is older).`
      : "Your data was saved by a newer Tin Hat. Use the newest Tin Hat to keep this sign-in (this server's Tin Hat Web is older).";
  }
  return "Your saved session couldn't be opened. Nothing was deleted: try again, or start fresh on this computer (you sign in again; your encrypted messages come back with your Security Key or another signed-in device).";
}

/** The newest version recorded, or null. */
export function readWriter(store: Pick<Storage, "getItem">): string | null {
  const v = store.getItem(WRITER_KEY);
  return isRealVersion(v ?? undefined) ? (v as string) : null;
}

/** After a start that opened the stores: record `me` unless a newer Tin Hat already did. */
export function noteWriter(store: Pick<Storage, "getItem" | "setItem">, me: string | undefined): void {
  if (!isRealVersion(me)) return;
  const cur = readWriter(store);
  if (cur && !versionNewer(me, cur)) return;
  store.setItem(WRITER_KEY, me);
}
