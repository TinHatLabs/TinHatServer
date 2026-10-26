// trust.ts — Pad: the trust FACTS of one received Pad message (security rules 1–4 of docs/PAD.md), looked up from the
// crypto store and handed to the pure rules (rules.ts checkTrust / checkPadMessage / acceptState), which decide.
//
//   decrypted     the to-device event came in Olm-decrypted (ReceivedToDeviceMessage.encryptionInfo present)
//   olmSender     the user the Olm session authenticates (encryptionInfo.sender)
//   senderDevice  the device record the Olm Curve25519 key is bound to (keys.ts bindDevice: the SDK's senderDevice,
//                 checked against that record's key; else the own device that owns the key)
//   curveMatches  that record's Curve25519 key IS the key the message was encrypted with
//   selfVerified  THIS device holds all three cross-signing private keys (crypto.ts isDeviceVerified)
//   peerTrusted   getDeviceVerificationStatus(me, device).crossSigningVerified — not signedByOwner, not senderVerified
//
// Only messages whose Olm sender AND event sender are my own user id are looked up at all (anyone else fails rule 2
// whatever the store says: no lookup, no key query, no timing oracle). Every answer is cached at most 60 s and the whole
// cache is dropped on any device-list / trust change (the glue calls invalidate()). Pure of the SDK: the lookups are
// injected (transport.ts cryptoLookup = the real crypto API; the tests stub them).
import type { PadFacts } from "./rules";

/** The SDK's OlmEncryptionInfo (the fields Pad reads). */
export interface OlmInfoIn {
  sender: string;
  senderDevice?: string | null;
  senderCurve25519KeyBase64?: string;
}

export interface OwnDevice {
  id: string;
  /** the device record's Curve25519 identity key ("" = none) */
  curve: string;
  /** its display name (Settings → Devices & security), "" = none */
  name: string;
}

export interface PadTrustLookup {
  /** my user id + this device id (null = not signed in) */
  ids(): { userId: string; deviceId: string } | null;
  /** all three cross-signing private keys are cached on this device */
  selfVerified(): Promise<boolean>;
  /** my own devices as the crypto store knows them (download = run a key query first) */
  ownDevices(download: boolean): Promise<OwnDevice[]>;
  /** `getDeviceVerificationStatus(me, deviceId).crossSigningVerified` */
  crossSigningTrusted(deviceId: string): Promise<boolean>;
}

export const TRUST_TTL_MS = 60_000;
/** an unknown sender key triggers at most one key query per this many ms */
export const DOWNLOAD_EVERY_MS = 10_000;

interface Cached<T> {
  at: number;
  v: T;
}

export class PadTrust {
  /** bumped by invalidate(): a lookup that started before it never lands in the cache */
  private epoch = 0;
  private self: Cached<boolean> | null = null;
  private devs: Cached<OwnDevice[]> | null = null;
  private trusted = new Map<string, Cached<boolean>>();
  private lastDownload = -Infinity;

  private readonly lookup: PadTrustLookup;
  private readonly now: () => number;

  constructor(lookup: PadTrustLookup, now: () => number = Date.now) {
    this.lookup = lookup;
    this.now = now;
  }

  /** Bumped by every invalidate(): an answer computed across one is never used to authorize anything. */
  get generation(): number {
    return this.epoch;
  }

  /** A device list or trust changed (CryptoEvent.DevicesUpdated / UserTrustStatusChanged / KeysChanged): forget all. */
  invalidate(): void {
    this.epoch++;
    this.self = null;
    this.devs = null;
    this.trusted.clear();
  }

  private fresh<T>(c: Cached<T> | null | undefined): c is Cached<T> {
    return !!c && this.now() - c.at <= TRUST_TTL_MS && this.now() >= c.at;
  }

  async selfVerified(): Promise<boolean> {
    if (this.fresh(this.self)) return this.self.v;
    const e = this.epoch;
    const at = this.now();
    let v = false;
    try {
      v = (await this.lookup.selfVerified()) === true;
    } catch {
      v = false;
    }
    // (Astra 2026-10-25 #1: an answer that raced an invalidate is neither kept nor believed)
    if (e !== this.epoch) return false;
    this.self = { at, v };
    return v;
  }

  /** My devices (cached ≤ 60 s); `download` asks the crypto store again (at most once per 10 s). For my OWN account
   *  (always tracked) the SDK does not run a key query for this — it refreshes my device list itself from the sync's
   *  device_lists, and the CryptoEvent.DevicesUpdated that follows invalidates this cache; a message from a device not
   *  known yet fails closed (`unbound`), and the controller's resend 3 s later finds it (Astra 2026-10-25 #14). */
  async devices(download = false): Promise<OwnDevice[]> {
    if (!download && this.fresh(this.devs)) return this.devs.v;
    const now = this.now();
    const dl = download && now - this.lastDownload >= DOWNLOAD_EVERY_MS;
    if (download && !dl && this.fresh(this.devs)) return this.devs.v;
    if (dl) this.lastDownload = now;
    const e = this.epoch;
    const at = this.now();
    let v: OwnDevice[] = [];
    try {
      v = (await this.lookup.ownDevices(dl)).filter((d) => !!d && typeof d.id === "string" && d.id !== "");
    } catch {
      v = [];
    }
    if (e === this.epoch) this.devs = { at, v };
    return v;
  }

  async peerTrusted(deviceId: string): Promise<boolean> {
    if (!deviceId) return false;
    const c = this.trusted.get(deviceId);
    if (this.fresh(c)) return c.v;
    const e = this.epoch;
    const at = this.now();
    let v = false;
    try {
      v = (await this.lookup.crossSigningTrusted(deviceId)) === true;
    } catch {
      v = false;
    }
    if (e !== this.epoch) return false;
    this.trusted.set(deviceId, { at, v });
    return v;
  }

  /** The device's name from Settings → Devices & security (falls back to its id). */
  async deviceName(deviceId: string): Promise<string> {
    const d = (await this.devices(false)).find((x) => x.id === deviceId);
    return d?.name || deviceId;
  }

  /** My OTHER devices that are cross-signing trusted (discovery: padTargets' `trusted`). */
  async trustedDevices(): Promise<string[]> {
    const ids = this.lookup.ids();
    if (!ids) return [];
    const out: string[] = [];
    for (const d of await this.devices(false)) {
      if (d.id === ids.deviceId) continue;
      if (await this.peerTrusted(d.id)) out.push(d.id);
    }
    return out;
  }

  /** Rule 10 before anything leaves for `deviceId`: this device verified and that device of mine cross-signing
   *  trusted — both answers from ONE trust generation (an invalidate in between → asked again, then fail closed). */
  async mayReceive(deviceId: string): Promise<boolean> {
    return (await this.mayReceiveAt(deviceId)).ok;
  }

  /** mayReceive + the trust generation it holds for: the caller compares `gen` with `generation` SYNCHRONOUSLY right
   *  before it acts (an invalidate between this answer and the act → ask again). */
  async mayReceiveAt(deviceId: string): Promise<{ ok: boolean; gen: number }> {
    for (let i = 0; i < 3; i++) {
      const ids = this.lookup.ids();
      if (!ids || !deviceId || deviceId === ids.deviceId) return { ok: false, gen: this.epoch };
      const e = this.epoch;
      const ok = (await this.selfVerified()) && (await this.peerTrusted(deviceId));
      if (e === this.epoch) return { ok, gen: e };
    }
    return { ok: false, gen: this.epoch };
  }

  /**
   * The facts of one received to-device message (encryptionInfo as the SDK gives it, null = plaintext). Every fact
   * comes from ONE trust generation: an invalidate() while they were looked up starts over (twice at most), then the
   * trust facts fail closed. The caller acts on them at once (no await in between: transport.ts receive).
   */
  async facts(enc: OlmInfoIn | null | undefined, eventSender: string): Promise<PadFacts> {
    return (await this.factsAt(enc, eventSender)).facts;
  }

  /** facts + the trust generation they hold for (the caller checks `gen === generation` synchronously before acting). */
  async factsAt(enc: OlmInfoIn | null | undefined, eventSender: string): Promise<{ facts: PadFacts; gen: number }> {
    for (let i = 0; i < 3; i++) {
      const e = this.epoch;
      const f = await this.factsOnce(enc, eventSender);
      if (e === this.epoch) return { facts: f, gen: e };
    }
    const f = await this.factsOnce(null, eventSender);
    return { facts: { ...f, decrypted: !!enc, olmSender: enc?.sender ?? "" }, gen: this.epoch };
  }

  private async factsOnce(enc: OlmInfoIn | null | undefined, eventSender: string): Promise<PadFacts> {
    const ids = this.lookup.ids();
    const me = ids?.userId ?? "";
    const myDev = ids?.deviceId ?? "";
    const f: PadFacts = {
      decrypted: !!enc,
      olmSender: enc?.sender ?? "",
      eventSender: eventSender ?? "",
      senderDevice: "",
      curveMatches: false,
      myUserId: me,
      myDeviceId: myDev,
      selfVerified: false,
      peerTrusted: false,
    };
    // rules 1–2 fail whatever the store says: no lookups for plaintext or anyone else's message
    if (!enc || !me || enc.sender !== me || eventSender !== me) return f;
    const curve = typeof enc.senderCurve25519KeyBase64 === "string" ? enc.senderCurve25519KeyBase64 : "";
    if (!curve) return f;
    const claimed = typeof enc.senderDevice === "string" ? enc.senderDevice : "";
    const pick = (list: OwnDevice[]) => (claimed ? list.find((d) => d.id === claimed) : list.find((d) => d.curve === curve));
    let d = pick(await this.devices(false));
    if (!d) d = pick(await this.devices(true));
    if (!d) return f;
    f.senderDevice = d.id;
    f.curveMatches = d.curve !== "" && d.curve === curve;
    f.selfVerified = await this.selfVerified();
    f.peerTrusted = f.curveMatches && d.id !== myDev ? await this.peerTrusted(d.id) : false;
    return f;
  }
}
