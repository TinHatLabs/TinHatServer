// capture.worklet.js — the voice-note recorder's AudioWorklet module (recorder.ts loads it with `?url` and registers
// "tw-voice-capture"). A file of its own, served from this origin, so the app's Content-Security-Policy needs no `blob:`
// script source (same as calls/tap.worklet.js).
//
// Downmixes every render quantum to mono (the mean of the input channels) and posts the samples as Float32Array
// chunks of 2400 (50 ms at 48 kHz), transferred. "flush" posts what is buffered, then { flushed: true }: every sample
// that reached the worklet before the flush has been delivered once that answer arrives (the recorder's drain).
class TwVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2400);
    this.n = 0;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.post();
        this.port.postMessage({ flushed: true });
      } else if (e.data === "stop") {
        this.post();
        this.on = false;
      }
    };
  }
  post() {
    if (this.n === 0) return;
    const out = this.buf.slice(0, this.n);
    this.port.postMessage(out, [out.buffer]);
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return false;
    const inp = inputs[0];
    if (!inp || inp.length === 0) return true;
    const ch = inp.length;
    const len = inp[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += inp[c][i];
      this.buf[this.n++] = ch === 1 ? s : s / ch;
      if (this.n === this.buf.length) this.post();
    }
    return true;
  }
}
registerProcessor("tw-voice-capture", TwVoiceCapture);
