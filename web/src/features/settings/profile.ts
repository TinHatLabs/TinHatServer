// profile.ts — SettingsController (settings.rs) for the web: display name, avatar, extended
// profile fields (bio / accent / join sound, MSC4133 on /v3), email 3PIDs and the devices list.
// Also `fetchProfileCard(mxid)` for the right-panel profile flyout (spaces feature).
import { create } from "zustand";
import { getClient, peekClient, primeUserProfile, refreshUserProfile, uploadFile } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { mx, MxError, enc, myUserId } from "./mx";
import { setStatus } from "./store";

const log = createLogger("settings");

export const EXT_BIO = "dev.tinhat.bio";
export const EXT_ACCENT = "dev.tinhat.accent";
export const EXT_JOINSOUND = "dev.tinhat.joinsound";

export interface DeviceRow {
  id: string;
  name: string;
  lastSeenTs: number;
  lastSeenIp: string;
  isCurrent: boolean;
}

export interface ProfileState {
  loaded: boolean;
  displayName: string;
  avatarMxc: string;
  bio: string;
  accent: string;
  joinSound: string;
  emails: string[];
  emailPending: boolean;
  emailStatus: string;
  devices: DeviceRow[];
  devicesState: "idle" | "loading" | "ok" | "error";
  busy: boolean;
}

const INITIAL: ProfileState = {
  loaded: false,
  displayName: "",
  avatarMxc: "",
  bio: "",
  accent: "",
  joinSound: "",
  emails: [],
  emailPending: false,
  emailStatus: "",
  devices: [],
  devicesState: "idle",
  busy: false,
};

export const useProfile = create<ProfileState>()(() => INITIAL);
const set = (p: Partial<ProfileState>) => useProfile.setState(p);

export function resetProfile(): void {
  useProfile.setState(INITIAL, true);
  pendingEmail = null;
}

// ---- extended profile fields -----------------------------------------------------------------

/** GET /profile/{user}/{key} → the string value, "" when unset (any non-2xx = unset). */
export async function getExtField(userId: string, key: string): Promise<string> {
  try {
    const r = await mx<Record<string, unknown>>("GET", `/profile/${enc(userId)}/${enc(key)}`, undefined, { timeoutMs: 10000 });
    const v = r[key];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

async function putExtField(key: string, value: string): Promise<void> {
  await mx("PUT", `/profile/${enc(myUserId())}/${enc(key)}`, { [key]: value });
}

// ---- refresh (SET-08) ------------------------------------------------------------------------

export async function refreshProfile(): Promise<void> {
  const uid = myUserId();
  if (!uid) return;
  try {
    const p = await mx<{ displayname?: string; avatar_url?: string }>("GET", `/profile/${enc(uid)}`);
    set({ displayName: p.displayname ?? "", avatarMxc: p.avatar_url ?? "" });
  } catch (e) {
    log.warn("profile fetch failed", e);
  }
  const [bio, accent, joinSound] = await Promise.all([getExtField(uid, EXT_BIO), getExtField(uid, EXT_ACCENT), getExtField(uid, EXT_JOINSOUND)]);
  set({ bio, accent, joinSound, loaded: true });
}

export async function refreshEmails(): Promise<void> {
  try {
    const r = await mx<{ threepids?: Array<{ medium: string; address: string }> }>("GET", "/account/3pid");
    set({ emails: (r.threepids ?? []).filter((t) => t.medium === "email").map((t) => t.address) });
  } catch (e) {
    log.warn("3pid list failed", e);
  }
}

export async function refreshDevices(): Promise<void> {
  set({ devicesState: "loading" });
  try {
    const r = await mx<{ devices?: Array<{ device_id: string; display_name?: string; last_seen_ip?: string; last_seen_ts?: number }> }>(
      "GET",
      "/devices",
    );
    const me = peekClient()?.getDeviceId() ?? "";
    set({
      devicesState: "ok",
      devices: (r.devices ?? []).map((d) => ({
        id: d.device_id,
        name: d.display_name ?? "",
        lastSeenIp: d.last_seen_ip ?? "",
        lastSeenTs: d.last_seen_ts ?? 0,
        isCurrent: d.device_id === me,
      })),
    });
  } catch (e) {
    log.warn("devices failed", e);
    set({ devicesState: "error" });
  }
}

// ---- writes ----------------------------------------------------------------------------------

async function busy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  set({ busy: true });
  try {
    return await fn();
  } finally {
    set({ busy: false });
  }
}

const errText = (e: unknown) => (e instanceof MxError ? e.message : String((e as Error)?.message ?? e));

export async function saveDisplayName(name: string): Promise<void> {
  const n = name.trim();
  if (!n) return;
  setStatus("Saving…");
  await busy(async () => {
    try {
      await getClient().setDisplayName(n);
      set({ displayName: n });
      primeUserProfile(myUserId(), { displayName: n });
      setStatus("Saved");
    } catch (e) {
      setStatus(`Couldn't save: ${errText(e)}`);
    }
  });
}

const AVATAR_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export async function uploadAvatar(file: File): Promise<void> {
  setStatus("Uploading avatar…");
  await busy(async () => {
    try {
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      const type = AVATAR_TYPES[ext] ?? (file.type || "image/png");
      const blob = file.type === type ? file : new File([file], file.name, { type });
      const up = await uploadFile(blob, { encrypt: false });
      await getClient().setAvatarUrl(up.mxc);
      set({ avatarMxc: up.mxc });
      primeUserProfile(myUserId(), { avatarUrl: up.mxc });
      setStatus("Avatar updated");
    } catch (e) {
      setStatus(`Couldn't upload: ${errText(e)}`);
    }
  });
}

export async function clearAvatar(): Promise<void> {
  await busy(async () => {
    try {
      await getClient().setAvatarUrl("");
      set({ avatarMxc: "" });
      primeUserProfile(myUserId(), { avatarUrl: undefined });
      refreshUserProfile(myUserId());
      setStatus("Avatar removed");
    } catch (e) {
      log.warn("clear avatar failed", e);
    }
  });
}

async function saveExt(key: string, value: string, patch: Partial<ProfileState>): Promise<void> {
  setStatus("Saving…");
  await busy(async () => {
    try {
      await putExtField(key, value);
      set(patch);
      bumpCard(myUserId());
      setStatus("Saved");
    } catch (e) {
      setStatus(`Couldn't save: server said HTTP ${e instanceof MxError ? e.status : errText(e)}`);
    }
  });
}

export const saveBio = (bio: string) => saveExt(EXT_BIO, bio.trim(), { bio: bio.trim() });

export function saveAccent(accent: string): Promise<void> {
  if (accent !== "" && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    setStatus("That isn't a colour like #7aa2f7");
    return Promise.resolve();
  }
  return saveExt(EXT_ACCENT, accent.toLowerCase(), { accent: accent.toLowerCase() });
}

export const saveJoinSound = (url: string) => saveExt(EXT_JOINSOUND, url, { joinSound: url });

// ---- email 3PIDs (SET-16..18) ----------------------------------------------------------------

let pendingEmail: { secret: string; sid: string; address: string } | null = null;

function clientSecret(): string {
  return `tinhat${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

export async function addEmail(address: string): Promise<void> {
  const a = address.trim();
  if (a.indexOf("@") <= 0) return;
  await busy(async () => {
    try {
      const secret = clientSecret();
      const r = await mx<{ sid: string }>("POST", "/account/3pid/email/requestToken", { client_secret: secret, email: a, send_attempt: 1 });
      pendingEmail = { secret, sid: r.sid, address: a };
      set({ emailPending: true, emailStatus: `Check ${a} and click the link, then enter your password below.` });
    } catch (e) {
      set({ emailStatus: `Couldn't send the email: ${errText(e)}` });
    }
  });
}

export async function confirmEmail(password: string): Promise<void> {
  if (!pendingEmail) {
    set({ emailStatus: "Add an address first." });
    return;
  }
  if (!password) {
    set({ emailStatus: "Enter your account password to confirm." });
    return;
  }
  const p = pendingEmail;
  await busy(async () => {
    const body: Record<string, unknown> = { client_secret: p.secret, sid: p.sid };
    try {
      try {
        await mx("POST", "/account/3pid/add", body);
      } catch (e) {
        if (!(e instanceof MxError) || e.status !== 401 || !e.body.session) throw e;
        await mx("POST", "/account/3pid/add", {
          ...body,
          auth: {
            type: "m.login.password",
            identifier: { type: "m.id.user", user: myUserId() },
            password,
            session: e.body.session,
          },
        });
      }
      pendingEmail = null;
      set({ emailPending: false, emailStatus: "Email added." });
      await refreshEmails();
    } catch (e) {
      set({ emailStatus: `Couldn't confirm: ${errText(e)}` });
    }
  });
}

export async function removeEmail(address: string): Promise<void> {
  set({ emailStatus: "Removing…" });
  await busy(async () => {
    try {
      await mx("POST", "/account/3pid/delete", { medium: "email", address });
      set({ emailStatus: "Email removed." });
      await refreshEmails();
    } catch (e) {
      set({ emailStatus: `Couldn't remove: ${errText(e)}` });
    }
  });
}

// ---- sessions: rename / sign out (web additions, see docs/web-exceptions/settings.md) -----------

export async function renameDevice(deviceId: string, name: string): Promise<void> {
  await mx("PUT", `/devices/${enc(deviceId)}`, { display_name: name.trim() });
  await refreshDevices();
}

/** Sign another session out (UIAA with the account password). */
export async function deleteDevice(deviceId: string, password: string): Promise<void> {
  try {
    await mx("DELETE", `/devices/${enc(deviceId)}`, {});
  } catch (e) {
    if (!(e instanceof MxError) || e.status !== 401 || !e.body.flows) throw e;
    await mx("DELETE", `/devices/${enc(deviceId)}`, {
      auth: { type: "m.login.password", identifier: { type: "m.id.user", user: myUserId() }, password, session: e.body.session },
    });
  }
  await refreshDevices();
}

/**
 * Settings → Devices & security → Change password (POST /account/password, UIAA with the current password). Other
 * devices stay signed in (logout_devices false). A wrong current password comes back as an MxError 401/403 from the
 * second request; the passwords are never logged or kept.
 */
export async function changePassword(current: string, next: string): Promise<void> {
  const body = { new_password: next, logout_devices: false };
  try {
    await mx("POST", "/account/password", body);
  } catch (e) {
    if (!(e instanceof MxError) || e.status !== 401 || !e.body.flows) throw e;
    // only a flow that the password alone completes (Tin Hat Server's); SSO or several steps: not from here
    const flows = Array.isArray(e.body.flows) ? (e.body.flows as Array<{ stages?: unknown }>) : [];
    if (!flows.some((f) => Array.isArray(f?.stages) && f.stages.length === 1 && f.stages[0] === "m.login.password"))
      throw new MxError("This server wants another way to confirm it's you: change your password where you signed up.", 0, "TH_UIA_UNSUPPORTED", {});
    try {
      await mx("POST", "/account/password", {
        ...body,
        auth: { type: "m.login.password", identifier: { type: "m.id.user", user: myUserId() }, password: current, session: e.body.session },
      });
    } catch (e2) {
      // the password step itself said no (Synapse: the challenge again, 401 + M_FORBIDDEN); a 403 M_FORBIDDEN is
      // something else ("Password change disabled") and keeps its own words, like every other answer
      if (e2 instanceof MxError && e2.status === 401 && e2.errcode === "M_FORBIDDEN")
        throw new MxError("That isn't your current password.", e2.status, "TH_WRONG_PASSWORD", e2.body);
      throw e2;
    }
  }
}

/** What the Change password dialog says when the server says no. */
export function changePasswordError(e: unknown): { text: string; wrongCurrent: boolean } {
  if (e instanceof MxError && e.errcode === "TH_WRONG_PASSWORD") return { text: "That isn't your current password.", wrongCurrent: true };
  // no answer at all (a network error, or none in time): the desktop's words
  if (!(e instanceof MxError) || e.status === 0) return { text: "Couldn't reach your server. Try again in a moment.", wrongCurrent: false };
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof MxError && /^HTTP \d+$/.test(m)) return { text: `The server didn't take the new password (HTTP ${e.status}).`, wrongCurrent: false };
  return { text: m || "The server didn't take the new password.", wrongCurrent: false };
}

/** Sign every OTHER session out at once (POST /delete_devices, UIAA with the account password). */
export async function deleteOtherDevices(password: string): Promise<number> {
  const me = peekClient()?.getDeviceId() ?? "";
  const ids = useProfile.getState().devices.map((d) => d.id).filter((id) => id && id !== me);
  if (ids.length === 0) return 0;
  try {
    await mx("POST", "/delete_devices", { devices: ids });
  } catch (e) {
    if (!(e instanceof MxError) || e.status !== 401 || !e.body.flows) throw e;
    await mx("POST", "/delete_devices", {
      devices: ids,
      auth: { type: "m.login.password", identifier: { type: "m.id.user", user: myUserId() }, password, session: e.body.session },
    });
  }
  await refreshDevices();
  return ids.length;
}

// ---- profile card for OTHER users (SET-108) --------------------------------------------------

export interface ProfileCard {
  mxid: string;
  bio: string;
  accent: string;
  joinSound: string;
  loading: boolean;
}

const cards = new Map<string, { card: ProfileCard; at: number; p?: Promise<ProfileCard> }>();
const CARD_TTL = 5 * 60 * 1000;

function bumpCard(mxid: string) {
  cards.delete(mxid);
}

/** Bio / accent / join sound of any user (public MSC4133 fields). Cached 5 min. */
export function fetchProfileCard(mxid: string, force = false): Promise<ProfileCard> {
  const c = cards.get(mxid);
  if (!force && c && (c.p || Date.now() - c.at < CARD_TTL)) return c.p ?? Promise.resolve(c.card);
  const p = Promise.all([getExtField(mxid, EXT_BIO), getExtField(mxid, EXT_ACCENT), getExtField(mxid, EXT_JOINSOUND)]).then(([bio, accent, joinSound]) => {
    const card: ProfileCard = { mxid, bio, accent: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "", joinSound, loading: false };
    cards.set(mxid, { card, at: Date.now() });
    return card;
  });
  cards.set(mxid, { card: { mxid, bio: "", accent: "", joinSound: "", loading: true }, at: 0, p });
  return p;
}
