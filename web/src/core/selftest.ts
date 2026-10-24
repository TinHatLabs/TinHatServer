// selftest.ts — in-browser unit checks for the non-network parts of core (prefs, bus, registry,
// shortcuts, attachments crypto, invite-code normaliser, errors, device). Run from the core debug
// page or `await __tw.selfTest()`; returns [{name, ok, detail}]. Leaves no state behind.
import { bus } from "@/core/bus";
import { getFormFactor } from "@/core/device";
import { decryptAttachment, encryptAttachment, parseMxc, mxcHttpUrl } from "@/core/matrix/media";
import { friendlyLoginError } from "@/core/matrix/errors";
import { normalizeInviteCode, validateRegistration } from "@/core/matrix/session";
import { getPref, getPrefRaw, removePref, setPref } from "@/core/prefs";
import { findTimelineRenderer, registries } from "@/core/registry";
import { parseSequence, registerShortcut, installShortcuts } from "@/core/shortcuts";
import { soundUrl } from "@/core/sounds";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runCoreSelfTest(): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) =>
    out.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail) });

  // ---- invite codes (bridge.rs invite_code_tests) ----
  const n = normalizeInviteCode;
  check("invite: blip forms", n("ud4d-7g3q") === "TH-UD4D-7G3Q" && n("UD4D7G3Q") === "TH-UD4D-7G3Q" && n("  ud4d7g3q ") === "TH-UD4D-7G3Q");
  check("invite: full codes", n("TH-UD4D-7G3Q") === "TH-UD4D-7G3Q" && n("th-ud4d-7g3q") === "TH-UD4D-7G3Q" && n("thud4d7g3q") === "TH-UD4D-7G3Q");
  check(
    "invite: others pass through",
    n("sample-invite-b3a246") === "sample-invite-b3a246" && n(" some.token_value ") === "some.token_value" && n("") === "",
  );
  check("register: bad username", validateRegistration({ username: "Bad Name", password: "12345678", token: "x" })?.startsWith("Usernames are") === true);
  check("register: short password", validateRegistration({ username: "ok", password: "short", token: "x" }) === "Use a password of at least 8 characters.");
  check("register: ok", validateRegistration({ username: "ok_name", password: "longenough", token: "ud4d7g3q" }) === null);

  // ---- errors ----
  check("error: forbidden", friendlyLoginError({ errcode: "M_FORBIDDEN", message: "Invalid username or password" }) === "Wrong username or password.");
  check("error: network", friendlyLoginError(new TypeError("Failed to fetch")) === "Can't reach the server — check your connection and the address.");
  check("error: rate", friendlyLoginError({ errcode: "M_LIMIT_EXCEEDED", message: "" }) === "Too many attempts — wait a minute and try again.");

  // ---- prefs ----
  const K = "__selftest";
  setPref(K, true);
  check("pref: bool stored as 1", getPrefRaw(K) === "1" && getPref(K, false) === true);
  setPref(K, 55);
  check("pref: number", getPref(K, 0) === 55);
  setPref(K, { a: [1, 2] });
  check("pref: json", JSON.stringify(getPref(K, {})) === '{"a":[1,2]}');
  setPref(`ui-${K}`, "via-ui");
  check("pref: ui- prefix alias", getPref(K, "") === "via-ui");
  removePref(K);
  check("pref: remove → default", getPref(K, "dflt") === "dflt");

  // ---- bus ----
  let got = "";
  const off = bus.on("toast", (p) => (got = p.message));
  bus.emit("toast", { message: "hi" });
  off();
  bus.emit("toast", { message: "after" });
  check("bus: emit/on/off", got === "hi", got);

  // ---- registry ----
  const rm1 = registries.roomHeaderActions.add({ id: "__b", order: 20, component: () => null });
  const rm2 = registries.roomHeaderActions.add({ id: "__a", order: 10, component: () => null });
  const ids = registries.roomHeaderActions.list().filter((i) => i.id.startsWith("__")).map((i) => i.id);
  rm1();
  rm2();
  check("registry: sorted by order", ids.join(",") === "__a,__b", ids);
  check("registry: removed", !registries.roomHeaderActions.get("__a"));
  const rmR = registries.timelineRenderers.add({
    id: "__img",
    order: 1,
    eventTypes: ["m.room.message"],
    msgtypes: ["m.image"],
    component: () => null,
  });
  const fake = (type: string, msgtype?: string) =>
    ({ getType: () => type, getContent: () => (msgtype ? { msgtype } : {}) }) as unknown as Parameters<typeof findTimelineRenderer>[0];
  check("registry: renderer match", findTimelineRenderer(fake("m.room.message", "m.image"))?.id === "__img");
  check("registry: renderer no match", findTimelineRenderer(fake("m.room.message", "m.text"))?.id !== "__img");
  rmR();

  // ---- shortcuts ----
  const p = parseSequence("Ctrl+Shift+M");
  check("shortcut: parse", p.ctrl && p.shift && !p.alt && p.key === "m", p);
  check("shortcut: parse Alt+Up", parseSequence("Alt+Up").key === "arrowup");
  check("shortcut: parse Ctrl+,", parseSequence("Ctrl+,").key === ",");
  installShortcuts();
  let hits = 0;
  const offS = registerShortcut({ id: "__t", keys: "Ctrl+Shift+Y", run: () => void hits++ });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", code: "KeyY", ctrlKey: true, bubbles: true }));
  offS();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true, bubbles: true }));
  check("shortcut: dispatch + unregister", hits === 1, hits);

  // ---- media ----
  check("mxc: parse", parseMxc("mxc://example.com/AbC_d-1")?.mediaId === "AbC_d-1" && parseMxc("http://x/y") === null);
  const u = mxcHttpUrl("mxc://example.com/abc", { width: 32, height: 32, method: "crop" }, "https://hs.example");
  check("mxc: thumbnail url", u === "https://hs.example/_matrix/client/v1/media/thumbnail/example.com/abc?width=32&height=32&method=crop", u);
  const plain = new TextEncoder().encode("tin hat attachment ✓").buffer as ArrayBuffer;
  const enc = await encryptAttachment(plain);
  const dec = await decryptAttachment(enc.data, { ...enc.file, url: "mxc://x/y" });
  check("attachment: encrypt → decrypt", new TextDecoder().decode(dec) === "tin hat attachment ✓");
  const tampered = new Uint8Array(enc.data.slice(0));
  tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
  const bad = await decryptAttachment(tampered.buffer, { ...enc.file, url: "mxc://x/y" }).then(
    () => "decrypted",
    (e: unknown) => (e as Error).message,
  );
  check("attachment: tamper detected", bad === "attachment hash mismatch", bad);

  // ---- sounds / device ----
  check("sound: goose falls back to oled", soundUrl("send", "goose").endsWith("sounds/oled/send.mp3") && soundUrl("join", "goose").endsWith("sounds/goose/join.mp3"));
  const ff = getFormFactor();
  check("device: form factor", ff === "desktop" || ff === "mobile", ff);
  return out;
}

/**
 * Live checks that need the network but send NO room events: encrypted + plain media upload →
 * authenticated download → decrypt, and the same-origin /api service (auth + no-auth paths).
 * Uploads leave two tiny unreferenced files in the media repo.
 */
export async function runCoreLiveTest(): Promise<Check[]> {
  const out: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) =>
    out.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail) });
  const { uploadFile, fetchEncryptedMedia, fetchMedia } = await import("@/core/matrix/media");
  const { apiJson, ApiError } = await import("@/core/api");
  const text = `tin hat web core live test ${Date.now()}`;
  const file = new File([text], "core-live-test.txt", { type: "text/plain" });
  try {
    const up = await uploadFile(file, { encrypt: true });
    const ok = up.msgtype === "m.file" && !!up.file && up.content.file === up.file && up.info.size === file.size;
    check("upload encrypted", ok, { mxc: up.mxc, info: up.info });
    const back = await (await fetchEncryptedMedia(up.file!, "text/plain")).text();
    check("download + decrypt", back === text, back.slice(0, 40));
  } catch (e) {
    check("upload encrypted", false, (e as Error).message);
  }
  try {
    const up = await uploadFile(file, { encrypt: false });
    const back = await (await fetchMedia(up.mxc)).text();
    check("upload plain + download", back === text && typeof up.content.url === "string", up.mxc);
  } catch (e) {
    check("upload plain + download", false, (e as Error).message);
  }
  try {
    const t = await apiJson<unknown>("/gifs/trending");
    check("api: gifs trending (no auth)", Array.isArray(t) || (typeof t === "object" && t !== null), typeof t);
  } catch (e) {
    check("api: gifs trending (no auth)", false, (e as Error).message);
  }
  try {
    await apiJson("/admin/invites");
    check("api: admin/invites answers (operator)", true);
  } catch (e) {
    const st = e instanceof ApiError ? e.status : -1;
    // 403 = signed-in but not an operator (bearer accepted); 401 would mean the bearer was missing/bad.
    check("api: admin/invites bearer accepted", st === 403, { status: st, msg: (e as Error).message });
  }
  return out;
}
