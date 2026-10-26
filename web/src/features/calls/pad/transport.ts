// transport.ts — Pad: the wire glue (docs/PAD.md "Transport"). `dev.tinhat.pad.cmd` / `dev.tinhat.pad.state` travel
// Olm-encrypted to-device to EXACTLY ONE device of my own account, sent DIRECTLY: `encryptToDeviceMessages` for that one
// device, then `client.sendToDevice` with that batch. Never `queueToDevice`: the js-sdk keeps queued batches in its
// store and resends them after a resumed sync (ToDeviceMessageQueue), so a tap made in a dead zone would fire minutes
// later. The first message to a device claims its one-time key inside encryptToDeviceMessages (ensureSessionsForUsers):
// the Pad's `open` is that first message, so no tap waits for a claim.
//
// Receiving sits next to the call-key intake (keys.ts onToDevice): ClientEvent.ReceivedToDeviceMessage → only the two
// Pad types → the trust FACTS (trust.ts: decrypted? Olm sender, the bound device, verified both ways) → the handlers,
// which run the pure rules (checkPadMessage / acceptState) on them. What fails rules 1–2 on its face (plaintext,
// anyone else's) is dropped before any queue or lookup, with the rules' reason. Messages are handled strictly one
// after another (a device lookup in flight never lets a later command overtake an earlier one).
//
// Pure of the SDK (structural types only), so the tests drive it with stubs; features/pad wires the real client.
import { PAD_CMD, PAD_STATE, type PadFacts } from "./rules";
import { PadTrust, type OlmInfoIn, type OwnDevice, type PadTrustLookup } from "./trust";

type Obj = Record<string, unknown>;

/** The crypto API calls Pad uses (matrix-js-sdk CryptoApi). */
export interface PadCryptoLike {
  encryptToDeviceMessages(eventType: string, devices: { userId: string; deviceId: string }[], payload: Obj): Promise<{ eventType: string; batch: { userId: string; deviceId: string; payload: Obj }[] }>;
  getUserDeviceInfo(userIds: string[], downloadUncached?: boolean): Promise<Map<string, Map<string, { getIdentityKey?: () => string | undefined; displayName?: string }>>>;
  getDeviceVerificationStatus(userId: string, deviceId: string): Promise<{ crossSigningVerified: boolean } | null>;
  getCrossSigningStatus(): Promise<{ privateKeysCachedLocally: { masterKey: boolean; selfSigningKey: boolean; userSigningKey: boolean } }>;
}

/** The client calls Pad uses (matrix-js-sdk MatrixClient). */
export interface PadClientLike {
  getUserId(): string | null;
  getDeviceId(): string | null;
  getCrypto(): PadCryptoLike | undefined;
  sendToDevice(eventType: string, contentMap: Map<string, Map<string, Obj>>, txnId?: string): Promise<unknown>;
}

/** ClientEvent.ReceivedToDeviceMessage's payload (the fields Pad reads). */
export interface PadToDevice {
  message?: { type?: string; sender?: string; content?: unknown } | null;
  encryptionInfo?: OlmInfoIn | null;
}

export interface PadInbound {
  type: string;
  content: unknown;
  facts: PadFacts;
  /** local ms when it was handed on */
  at: number;
}

export interface PadLog {
  info(s: string): void;
  warn(s: string): void;
  debug?(s: string): void;
}
const NOLOG: PadLog = { info: () => undefined, warn: () => undefined };

/** The trust lookups of the real crypto API (the same calls as keys.ts bindDevice and crypto.ts isDeviceVerified). */
export function cryptoLookup(client: () => PadClientLike | null): PadTrustLookup {
  return {
    ids() {
      const c = client();
      const userId = c?.getUserId() ?? "";
      const deviceId = c?.getDeviceId() ?? "";
      return userId && deviceId ? { userId, deviceId } : null;
    },
    async selfVerified() {
      const s = await client()?.getCrypto()?.getCrossSigningStatus();
      const k = s?.privateKeysCachedLocally;
      return !!(k?.masterKey && k.selfSigningKey && k.userSigningKey);
    },
    async ownDevices(download: boolean) {
      const c = client();
      const me = c?.getUserId();
      const cr = c?.getCrypto();
      if (!c || !me || !cr) return [];
      const devs = (await cr.getUserDeviceInfo([me], download)).get(me);
      const out: OwnDevice[] = [];
      for (const [id, d] of devs ?? []) out.push({ id, curve: (typeof d.getIdentityKey === "function" ? d.getIdentityKey() : "") ?? "", name: typeof d.displayName === "string" ? d.displayName : "" });
      return out;
    },
    async crossSigningTrusted(deviceId: string) {
      const c = client();
      const me = c?.getUserId();
      if (!me) return false;
      const st = await c?.getCrypto()?.getDeviceVerificationStatus(me, deviceId);
      return st?.crossSigningVerified === true;
    },
  };
}

export class PadTransport {
  readonly trust: PadTrust;
  private handlers = new Map<string, Set<(m: PadInbound) => void>>();
  /** one message at a time, in arrival order */
  private inChain: Promise<unknown> = Promise.resolve();
  /** per device: the sends waiting to leave, in the order they were made (a reply never overtakes the push before it) */
  private outQueues = new Map<string, Array<{ type: string; content: Obj; done: (ok: boolean) => void }>>();
  private outBusy = new Set<string>();
  /** messages waiting for their trust facts (bounded: a flood is dropped, never queued without end) */
  private inQueued = 0;
  private lastFloodLog = -Infinity;
  private readonly now: () => number;
  private readonly log: PadLog;
  private readonly client: () => PadClientLike | null;
  /** a message dropped before its facts were looked up (plaintext, anyone else's, a flood): for the log / test hook */
  onDrop: ((type: string, sender: string, reason: string) => void) | null = null;

  /** a send answers its caller false after this long (then it is expired); the queue waits for it at most settleMs */
  private readonly sendTimeoutMs: number;
  private readonly settleMs: number;

  constructor(client: () => PadClientLike | null, opts: { now?: () => number; log?: PadLog; trust?: PadTrust; sendTimeoutMs?: number; settleMs?: number } = {}) {
    this.client = client;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 20_000;
    this.settleMs = opts.settleMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? NOLOG;
    this.trust = opts.trust ?? new PadTrust(cryptoLookup(client), this.now);
  }

  /** Listen for one of the two Pad types (returns the unsubscribe). */
  on(type: typeof PAD_CMD | typeof PAD_STATE, cb: (m: PadInbound) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }

  private dropped(type: string, sender: string, reason: string): void {
    this.log.debug?.(`dropped ${type} from ${sender || "?"}: ${reason}`);
    this.onDrop?.(type, sender, reason);
  }

  /**
   * ClientEvent.ReceivedToDeviceMessage → (Pad types only) facts → handlers, strictly in arrival order. What fails
   * rules 1–2 on its face (plaintext / UTD, an Olm sender or event sender that isn't me) is dropped HERE — no queue,
   * no lookup, no snapshot (Astra 2026-10-25 #4); the rules give the same reasons (not-olm, sender-mismatch,
   * other-user). At most 64 messages wait for their facts; more are dropped (logged ≤ 1 per 10 s).
   */
  receive(p: PadToDevice): Promise<void> {
    const m = p?.message;
    const type = m?.type;
    if (type !== PAD_CMD && type !== PAD_STATE) return Promise.resolve();
    const enc = p.encryptionInfo ?? null;
    const sender = typeof m?.sender === "string" ? m.sender : "";
    const me = this.client()?.getUserId() ?? "";
    if (!enc) {
      this.log.warn(`plaintext ${type} from ${sender || "?"} — only Olm-decrypted Pad messages are trusted`);
      this.dropped(type, sender, "not-olm");
      return Promise.resolve();
    }
    if (!enc.sender || enc.sender !== sender) return (this.dropped(type, sender, "sender-mismatch"), Promise.resolve());
    if (!me || enc.sender !== me) return (this.dropped(type, sender, "other-user"), Promise.resolve());
    if (this.inQueued >= 64) {
      if (this.now() - this.lastFloodLog >= 10_000) {
        this.lastFloodLog = this.now();
        this.log.warn(`more than 64 Pad messages waiting — dropping the rest`);
      }
      this.dropped(type, sender, "flood");
      return Promise.resolve();
    }
    const content = m?.content;
    this.inQueued++;
    const run = async () => {
      try {
        let facts: PadFacts | null = null;
        try {
          // the facts are used only in the trust generation they were found in: checked synchronously here, right
          // before the handlers run (an invalidate in the gap → looked up again; Astra 2026-10-25 pass 2 #2)
          for (let i = 0; i < 3 && !facts; i++) {
            const r = await this.trust.factsAt(enc, sender);
            if (r.gen === this.trust.generation) facts = r.facts;
          }
        } catch (e) {
          this.log.warn(`trust lookup failed: ${(e as Error)?.message ?? e}`);
          return;
        }
        if (!facts) return this.dropped(type, sender, "trust-changing");
        // (no await from here on)
        for (const h of [...(this.handlers.get(type) ?? [])]) {
          try {
            h({ type, content, facts, at: this.now() });
          } catch (e) {
            this.log.warn(`handler: ${(e as Error)?.message ?? e}`);
          }
        }
      } finally {
        this.inQueued--;
      }
    };
    const next = this.inChain.then(run, run);
    this.inChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Olm-encrypt `content` as `type` for exactly ONE device of my own account and send it now (never queued for a
   * resend). Rules 1–4 / 10 are checked INSIDE the device's send queue, right before the encryption, and again after it
   * when the trust changed meanwhile (Astra 2026-10-25 #2): nothing leaves for a device that isn't cross-signing trusted
   * (or while this device isn't verified) at the time it leaves. At most 32 sends wait per device; one that takes
   * longer than 20 s stops holding the queue up. Resolves false when it did not go.
   */
  send(type: typeof PAD_CMD | typeof PAD_STATE, deviceId: string, content: Obj): Promise<boolean> {
    return new Promise((done) => {
      let q = this.outQueues.get(deviceId);
      if (!q) this.outQueues.set(deviceId, (q = []));
      if (q.length >= 32) {
        this.log.warn(`${type} → ${deviceId}: 32 sends already waiting — dropped`);
        return done(false);
      }
      q.push({ type, content, done });
      void this.pump(deviceId);
    });
  }

  private async pump(deviceId: string): Promise<void> {
    if (this.outBusy.has(deviceId)) return;
    this.outBusy.add(deviceId);
    try {
      for (;;) {
        const q = this.outQueues.get(deviceId);
        const item = q?.shift();
        if (!item) {
          this.outQueues.delete(deviceId);
          return;
        }
        // 20 s for the caller; after that the item is EXPIRED (sendNow checks after every await and never starts the
        // request) while the queue still waits for it to settle — at most 60 s — so nothing newer overtakes it
        // (Astra 2026-10-25 pass 2 #1). A request already on the wire can't be taken back: the receiver's seq rules
        // drop a command that lands after a newer one, the controller's rseq rule an older state.
        let expired = false;
        let answered = false;
        const op = this.sendNow(item.type, deviceId, item.content, () => expired);
        const t1 = setTimeout(() => {
          expired = true;
          if (!answered) (answered = true), item.done(false);
        }, this.sendTimeoutMs);
        let t2: ReturnType<typeof setTimeout> | undefined;
        const ok = await Promise.race([op, new Promise<boolean>((r) => (t2 = setTimeout(() => r(false), this.settleMs)))]);
        clearTimeout(t1);
        if (t2 !== undefined) clearTimeout(t2);
        expired = true;
        if (!answered) (answered = true), item.done(ok);
      }
    } finally {
      this.outBusy.delete(deviceId);
    }
  }

  private async sendNow(type: string, deviceId: string, content: Obj, expired: () => boolean = () => false): Promise<boolean> {
    const c = this.client();
    const me = c?.getUserId() ?? "";
    const myDev = c?.getDeviceId() ?? "";
    const cr = c?.getCrypto();
    if (!c || !cr || !me || !deviceId || deviceId === myDev) return false;
    try {
      if (!(await this.trust.mayReceive(deviceId))) {
        this.log.warn(`${type} → ${deviceId}: not a cross-signing-trusted device of mine (or this device isn't verified) — not sent`);
        return false;
      }
      if (expired()) return false;
      const batch = await cr.encryptToDeviceMessages(type, [{ userId: me, deviceId }], content);
      const mine = (batch?.batch ?? []).filter((x) => x.userId === me && x.deviceId === deviceId);
      if (batch?.eventType !== "m.room.encrypted" || mine.length !== 1 || (batch.batch ?? []).length !== 1) {
        this.log.warn(`${type} → ${deviceId}: no Olm session/device (encrypted ${batch?.batch?.length ?? 0}) — not sent`);
        return false;
      }
      // authorized again for the request itself: the answer's trust generation is compared SYNCHRONOUSLY right before
      // the request starts (an invalidate in any gap → asked again; Astra 2026-10-25 pass 2 #2)
      for (let i = 0; i < 3; i++) {
        const a = await this.trust.mayReceiveAt(deviceId);
        if (!a.ok) {
          this.log.warn(`${type} → ${deviceId}: trust changed before it left — not sent`);
          return false;
        }
        if (expired() || this.client() !== c) return false; // (signed out / switched account / too late)
        if (a.gen === this.trust.generation) {
          await c.sendToDevice(batch.eventType, new Map([[me, new Map([[deviceId, mine[0].payload]])]]));
          return true;
        }
      }
      return false;
    } catch (e) {
      this.log.warn(`${type} → ${deviceId}: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }
}
