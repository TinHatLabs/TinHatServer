// play/holdem-cards.mjs — the deck and the dealer's shuffle (GAMES-V1-SPEC §4.1 "Trusted dealer").
// Cards are two characters: rank (23456789TJQKA) + suit (cdhs), e.g. "As", "Td". Pure: no I/O. The shuffle is
// Fisher–Yates over the system CSPRNG (crypto.randomInt) unless a test hands in its own `randomInt`.
import { randomInt as cryptoRandomInt } from "node:crypto";

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";

/** "As" → { r: 14, s: "s" }; throws on anything that isn't a card. */
export function parseCard(c) {
    if (typeof c !== "string" || c.length !== 2) throw new TypeError(`not a card: ${String(c)}`);
    const r = RANKS.indexOf(c[0]);
    if (r < 0 || !SUITS.includes(c[1])) throw new TypeError(`not a card: ${c}`);
    return { r: r + 2, s: c[1] };
}

/** A fresh 52-card deck in a fixed order. */
export function freshDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push(r + s);
    return d;
}

/**
 * Fisher–Yates, in place, last position first: for i = n−1 … 1, swap i with j ∈ [0, i] drawn uniformly.
 * `randomInt(min, max)` returns an integer in [min, max) (node:crypto's signature); the default is the CSPRNG.
 */
export function shuffle(deck, randomInt = cryptoRandomInt) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = randomInt(0, i + 1);
        if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError("randomInt out of range");
        const t = deck[i];
        deck[i] = deck[j];
        deck[j] = t;
    }
    return deck;
}

/** A freshly shuffled deck. */
export function shuffledDeck(randomInt = cryptoRandomInt) {
    return shuffle(freshDeck(), randomInt);
}
