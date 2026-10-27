// tlds.ts — IANA's top-level domains for core/claims.ts: core/tlds.txt, byte-identical with the desktop's
// crates/app/src/testvectors/tlds.txt (refreshed with the shared vectors, never by hand). It lives next to this file, not
// in a testvectors folder: it is app data, and the public source export leaves testvectors/ out.
import raw from "./tlds.txt?raw";
import { parseTlds } from "./claims";

export const TLDS: ReadonlySet<string> = parseTlds(raw);
