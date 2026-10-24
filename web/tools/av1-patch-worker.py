#!/usr/bin/env python3
"""av1-patch-worker.py DIR — apply the Tin Hat AV1-E2EE RECEIVE patch to a livekit-client 2.22.3 package
directory (the `pnpm patch` edit dir). Anchor-based and idempotent; the committed result lives in
patches/livekit-client@2.22.3.patch (this script is how it was produced — rerun it on a livekit bump, then
`pnpm patch-commit`). Only the ESM worker bundle is patched (Vite resolves `livekit-client/e2ee-worker` to it).

What it adds to dist/livekit-client.e2ee.worker.mjs (see src/features/calls/AV1.md):
  * tinhatAv1CiphertextOffset() — JS twin of Av1WrapperCiphertextOffset() in the natives' patched libwebrtc
    (vendor/webrtc-sys/libwebrtc-patches/av1-e2ee-wrapper-obu.patch, stamp tinhat-av1-e2ee-v2)
  * FrameCryptor.decryptFrame(): AV1 video frames take the Tin Hat path — strip the synthetic OBU prefix,
    AES-GCM decrypt (0 unencrypted bytes, EMPTY AAD, IV + [ivLength, keyIndex] trailer at the end), hand the
    byte-identical encoder output to the decoder. Auth failure -> CryptorError(InvalidKey) -> frame DROPPED.
  * per-cryptor counters posted to the page as {kind:"tinhat-av1", data:{...}} (ignored by livekit-client)
  * a probe message {kind:"tinhat-av1-probe"} -> {kind:"tinhat-av1-probe", data:{stamp, selfTest}} that runs a
    real encrypt -> depacketizer-form -> decrypt round trip plus a tamper check inside the worker.
"""
import sys, pathlib

d = pathlib.Path(sys.argv[1])
f = d / "dist/livekit-client.e2ee.worker.mjs"
s = f.read_text()
if "tinhat-av1-e2ee-v2" in s:
    print("already patched")
    sys.exit(0)

HELPERS = r'''
// ---- PATCH (Tin Hat Web) AV1 E2EE receive: tinhat-av1-e2ee-v2 --------------------------------------------
// Tin Hat natives (patched libwebrtc, av1-e2ee-wrapper-obu.patch) encrypt the WHOLE AV1 frame
// (0 unencrypted bytes, empty AAD) and wrap ciphertext||IV||[ivLength,keyIndex] in ONE synthetic OBU_FRAME
// header 0x30 (no size field); keyframes lead with an EMPTY sequence-header OBU 0x0a 0x00. A stock AV1
// depacketizer re-emits every OBU header with obu_has_size_field=1 + LEB128, so a receiver sees
// [0x0a 0x00] 0x32 <leb128> ciphertext... . The IV and trailer are located from the END of the buffer.
const TINHAT_AV1_STAMP = 'tinhat-av1-e2ee-v2';
function tinhatAv1CiphertextOffset(data) {
  let off = 0;
  for (let n = 0; n < 4; n++) {
    if (off + 1 >= data.length) return 0;
    const h = data[off];
    if (h & 0x80) return 0; // obu_forbidden_bit
    const type = (h >> 3) & 0xf;
    let pos = off + 1;
    if (h & 0x04) pos += 1; // obu_extension_flag
    let size = 0;
    const hasSize = (h & 0x02) !== 0;
    if (hasSize) {
      let leb = 0;
      for (;;) {
        if (pos >= data.length || leb >= 8) return 0;
        const b = data[pos++];
        size += (b & 0x7f) * Math.pow(2, 7 * leb);
        leb++;
        if (!(b & 0x80)) break;
      }
    }
    if (type === 6) return pos < data.length ? pos : 0; // the FRAME wrapper: ciphertext follows
    if (type === 1) { // the synthetic (empty) keyframe sequence header: skip it
      if (!hasSize || pos + size >= data.length) return 0;
      off = pos + size;
      continue;
    }
    return 0; // nothing a Tin Hat sender emits
  }
  return 0;
}
/** Tin Hat AV1 wire frame -> encoder output. Resolves null for a frame that is not in the wrapper form;
 *  REJECTS (WebCrypto OperationError) when GCM authentication fails. */
async function tinhatAv1Decrypt(data, key) {
  const off = tinhatAv1CiphertextOffset(data);
  if (off === 0) return null;
  const ivLength = data[data.length - 2];
  // IV + 2-byte trailer + 16-byte GCM tag must fit after the wrapper
  if (ivLength === 0 || data.length < off + ivLength + 2 + 16) return null;
  const iv = data.slice(data.length - 2 - ivLength, data.length - 2);
  const ct = data.subarray(off, data.length - 2 - ivLength);
  return crypto.subtle.decrypt({ name: ENCRYPTION_ALGORITHM, iv, additionalData: new Uint8Array(0) }, key, ct);
}
/** Worker self-test: native-format encrypt -> depacketizer form -> tinhatAv1Decrypt must give the bytes back,
 *  and a one-bit tamper must fail GCM. */
async function tinhatAv1SelfTest() {
  try {
    const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(16)), ENCRYPTION_ALGORITHM, false, ['encrypt', 'decrypt']);
    const plain = new Uint8Array(300);
    plain.set([0x12, 0x00, 0x0a, 0x0b, 0x00, 0x00, 0x00, 0x24, 0xc6, 0xab, 0xdf, 0x3e, 0xfe, 0x24, 0x04]);
    for (let i = 15; i < plain.length; i++) plain[i] = (i * 37) & 0xff;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ENCRYPTION_ALGORITHM, iv, additionalData: new Uint8Array(0) }, key, plain));
    const body = ct.length + iv.length + 2; // what the depacketizer puts in the wrapper's LEB128 size
    const leb = [];
    let v = body;
    do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; leb.push(b); } while (v);
    const wire = new Uint8Array(3 + leb.length + body);
    wire.set([0x0a, 0x00, 0x32].concat(leb));
    let o = 3 + leb.length;
    wire.set(ct, o); o += ct.length;
    wire.set(iv, o); o += iv.length;
    wire.set([12, 7], o);
    const out = new Uint8Array(await tinhatAv1Decrypt(wire, key));
    if (out.length !== plain.length || out.some((b, i) => b !== plain[i])) return false;
    const bad = wire.slice();
    bad[8] ^= 1;
    try { await tinhatAv1Decrypt(bad, key); return false; } catch (e) { /* expected: GCM refused the tampered frame */ }
    return true;
  } catch (e) {
    return false;
  }
}
// ---- end PATCH ---------------------------------------------------------------------------------------------
'''

def once(anchor, repl):
    global s
    n = s.count(anchor)
    if n != 1:
        sys.exit(f"anchor found {n}x: {anchor[:70]!r}")
    s = s.replace(anchor, repl)

# 1. helpers before the FrameCryptor class
once("class FrameCryptor extends BaseFrameCryptor {", HELPERS + "class FrameCryptor extends BaseFrameCryptor {")

# 2. counters in the constructor
once("    this.errorLimiter = new ErrorRateLimiter();",
     "    this.errorLimiter = new ErrorRateLimiter();\n"
     "    // PATCH (Tin Hat Web) AV1 receive counters, posted to the page as {kind:'tinhat-av1'}\n"
     "    this.tinhatAv1 = { ok: 0, authFail: 0, malformed: 0, lastPost: 0 };")

# 3. the AV1 branch in decryptFrame (before the codec switch that throws "av1 is not yet supported")
once("        let frameInfo = _this.getUnencryptedBytes(encodedFrame);\n        // Construct frame trailer.",
     "        // PATCH (Tin Hat Web): AV1 in the Tin Hat wrapper form -> decrypt the whole frame (see tinhatAv1Decrypt)\n"
     "        if (isVideoFrame(encodedFrame) && (_this.getVideoCodec(encodedFrame) ?? _this.videoCodec) === 'av1') {\n"
     "          return yield _this.tinhatDecryptAv1(encodedFrame, (_a = ratchetOpts.encryptionKey) !== null && _a !== void 0 ? _a : keySet.encryptionKey);\n"
     "        }\n"
     "        let frameInfo = _this.getUnencryptedBytes(encodedFrame);\n        // Construct frame trailer.")

# 4. the method itself + the stats poster, before getVideoCodec
once("  getVideoCodec(frame) {",
     "  // PATCH (Tin Hat Web) AV1 E2EE receive. Returns the frame with the decoder-ready bytes, or undefined\n"
     "  // (frame dropped) when it is not in the wrapper form; GCM auth failure throws InvalidKey (dropped too).\n"
     "  tinhatDecryptAv1(encodedFrame, key) {\n"
     "    return __awaiter(this, void 0, void 0, function* () {\n"
     "      let plain;\n"
     "      try {\n"
     "        plain = yield tinhatAv1Decrypt(new Uint8Array(encodedFrame.data), key);\n"
     "      } catch (error) {\n"
     "        this.tinhatAv1.authFail++;\n"
     "        this.tinhatAv1Post();\n"
     "        throw new CryptorError(\"AV1 decryption failed: \".concat(getErrorDescription(error, 'decryption')), CryptorErrorReason.InvalidKey, this.participantIdentity);\n"
     "      }\n"
     "      if (!plain) {\n"
     "        this.tinhatAv1.malformed++;\n"
     "        this.tinhatAv1Post();\n"
     "        return undefined;\n"
     "      }\n"
     "      this.tinhatAv1.ok++;\n"
     "      this.tinhatAv1Post();\n"
     "      encodedFrame.data = plain;\n"
     "      return encodedFrame;\n"
     "    });\n"
     "  }\n"
     "  tinhatAv1Post() {\n"
     "    const now = Date.now();\n"
     "    const c = this.tinhatAv1;\n"
     "    // every failure up to the page at once for the first few, then at most once per second\n"
     "    if (now - c.lastPost < 1000 && (c.ok > 0 || c.authFail + c.malformed > 5)) return;\n"
     "    c.lastPost = now;\n"
     "    postMessage({ kind: 'tinhat-av1', data: { participantIdentity: this.participantIdentity, trackId: this.trackId, ok: c.ok, authFail: c.authFail, malformed: c.malformed } });\n"
     "  }\n"
     "  getVideoCodec(frame) {")

# 5. probe message
once("      case 'setLogLevel':\n        workerLogger.setLevel(data.level);\n        break;",
     "      case 'setLogLevel':\n        workerLogger.setLevel(data.level);\n        break;\n"
     "      case 'tinhat-av1-probe':\n"
     "        // PATCH (Tin Hat Web): capability probe for the page's dev.tinhat.client marker\n"
     "        postMessage({ kind: 'tinhat-av1-probe', data: { stamp: TINHAT_AV1_STAMP, selfTest: yield tinhatAv1SelfTest() } });\n"
     "        break;")

f.write_text(s)
print("patched", f)
