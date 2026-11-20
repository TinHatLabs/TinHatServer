// The Rig's reproducible randomness (GAMES-V1-SPEC §5.0 "Randomness", §5.1.14; vectors/play/rig-rng.json is the only
// source of truth). Pure: every value is derived from a 32-byte round seed that the caller supplies (the server makes
// it with the CSPRNG, shows its SHA-256 at setup and the seed itself at the reveal). No I/O, no clock, no Math.random.
import { createHash, createHmac } from "node:crypto";

export const SYMBOLS = Object.freeze(["hat", "saucer", "dish", "eye", "moon", "lizard"]);

function seedBytes(seed) {
    const b = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed), "hex");
    if (b.length !== 32) throw new Error("rig-rng: the seed is 32 bytes");
    return b;
}

// draw(label, n): for c = 0, 1, …: u = first byte of HMAC-SHA256(seed, label + ":" + c); accept u < 256 - 256 % n
// (rejection sampling, so every value is equally likely) and return u % n. `counter` = the c that was accepted.
export function drawWithCounter(seed, label, n) {
    if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error("rig-rng: n is 1..256");
    const key = seedBytes(seed);
    const limit = 256 - (256 % n);
    for (let c = 0; ; c++) {
        const u = createHmac("sha256", key).update(`${label}:${c}`, "utf8").digest()[0];
        if (u < limit) return { value: u % n, counter: c };
    }
}

export const draw = (seed, label, n) => drawWithCounter(seed, label, n).value;

// Fisher-Yates from the top: for i = len-1 down to 1, j = draw(label + ":" + i, i + 1), swap.
export function shuffle(seed, label, items) {
    const xs = [...items];
    for (let i = xs.length - 1; i >= 1; i--) {
        const j = draw(seed, `${label}:${i}`, i + 1);
        [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
}

export const commitOf = (seed) => createHash("sha256").update(seedBytes(seed)).digest("hex");

// Honest reel k (1..3) of spin s.
export const honestReels = (seed, spin) => [1, 2, 3].map((k) => SYMBOLS[draw(seed, `reel:${spin}:${k}`, 6)]);

// The j-th re-roll of spin s (j from 0, in the order the cards use them): an index 0..4 into the five symbols other
// than the one being replaced, in ring order. Returns a source the spin resolver pulls from.
export function rerollSource(seed, spin) {
    let j = 0;
    return { next: () => draw(seed, `reroll:${spin}:${j++}`, 5), used: () => j };
}
