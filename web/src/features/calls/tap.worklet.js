// tap.worklet.js — the level tap's AudioWorklet module (audio.ts loads it with `?url` and registers "tw-tap"). A file of
// its own, served from this origin, so the app's Content-Security-Policy needs no `blob:` script source (it was a blob of
// envclock.ts's TAP_SRC string until the 2026-10-26 security review). envclock.test.ts runs this exact file under Node.
//
// 10 ms RMS frames on the context's sample grid, posted 5 at a time as { f: frames, end: the sample index where the last
// one ends }. A quantum with no input (a track that stopped delivering) drops the partial frame and posts what is
// complete, so a gap stays a gap; the first frame after a start or a gap may be partial (fewer samples, same slot). A
// pause of the render thread (> 200 ms between two quanta: a suspended context, a stall) drops the frames not yet
// posted, so no batch mixes audio from before and after it (the clock starts a new epoch on the far side; AudioClock).
class TwTap extends AudioWorkletProcessor {
  constructor() { super(); this.acc = 0; this.n = 0; this.frames = []; this.end = 0; this.bound = -1; this.last = 0; }
  flush() { if (this.frames.length) { this.port.postMessage({ f: this.frames, end: this.end }); this.frames = []; } }
  process(inputs) {
    const now = Date.now();
    if (this.last && now - this.last > 200) { this.frames = []; this.acc = 0; this.n = 0; this.bound = -1; }
    this.last = now;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) { this.acc = 0; this.n = 0; this.bound = -1; this.flush(); return true; }
    for (let i = 0; i < ch.length; i++) {
      const abs = currentFrame + i;
      if (abs >= this.bound) {
        if (this.bound >= 0 && this.n > 0) {
          this.frames.push(Math.sqrt(this.acc / this.n)); this.end = abs;
          if (this.frames.length >= 5) this.flush();
        }
        this.bound = Math.ceil((Math.floor((abs * 100) / sampleRate) + 1) * sampleRate / 100);
        this.acc = 0; this.n = 0;
      }
      const v = ch[i]; this.acc += v * v; this.n++;
    }
    return true;
  }
}
registerProcessor("tw-tap", TwTap);
