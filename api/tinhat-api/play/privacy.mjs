// The privacy check for views (GAMES-V1-SPEC §8.1 "Privacy of views"): given a view sent to `viewer` (null = a
// spectator), list everything in it that viewer must not see. Used on the fixtures and on every frame the server's
// scripted tests capture. Structural (no god state needed): the schema (exact fields, so an extra secret field fails),
// `you` only for its owner, shown cards only at a showdown, the Rig's reveal only in REVEAL, the Audit only for the
// Spinner, Whisper authors never before the reveal. With `god` (the table's full state) it also searches the view for
// every other player's hole cards / dealt or held Rig card where those must not appear.
import { SCHEMA } from "./contract/schema.mjs";
import { validate } from "./jsonschema.mjs";

export function leaks(game, view, viewer, god = null) {
    const out = validate(SCHEMA, { $ref: `#/$defs/${game === "rig" ? "rigView" : "holdemView"}` }, view).map((e) => `schema ${e}`);
    if (game === "holdem") holdem(view, viewer, god, out); else rig(view, viewer, god, out);
    return out;
}

function holdem(v, viewer, god, out) {
    const mine = viewer ? v.seats.find((s) => s.u === viewer) : null;
    if (v.you && (!mine || v.you.seat !== mine.seat)) out.push("you in a view of someone who isn't seated there");
    if (!v.you && mine) out.push("seated viewer without you");
    const showdown = v.hand?.street === "showdown";
    for (const s of v.seats) if (s.shown && !showdown) out.push(`seat ${s.seat} shown before a showdown`);
    if (v.you?.legal && v.hand?.to_act?.seat !== v.you.seat) out.push("legal moves when it isn't your turn");
    if (god?.seats) {
        const text = JSON.stringify(v);
        const shownSeats = new Set(showdown ? (god.hand?.show || []) : []);
        for (const s of god.seats) {
            if (s.u === viewer || shownSeats.has(s.seat)) continue;
            for (const c of s.hole || []) if (text.includes(`"${c}"`) && !(v.hand?.board || []).includes(c) && !(v.result?.board || []).includes(c)) out.push(`seat ${s.seat}'s hole card ${c} visible`);
        }
    }
}

function rig(v, viewer, god, out) {
    const me = viewer ? v.players.find((p) => p.u === viewer && !p.left) : null;
    if (v.you && !me) out.push("you in a view of someone not at the table");
    const r = v.round;
    if (r) {
        if (r.reveal && r.phase !== "reveal") out.push("reveal before the reveal");
        if (r.audit && viewer !== r.spinner) out.push("the Spinner's Audit in someone else's view");
        if ("whispers" in r) out.push("whispers in the round (they go only to the Spinner's you, without authors)");
        for (const b of r.board) if (b.by && b.state !== "busted") out.push(`board ${b.card}: owner on a card that isn't busted`);
        if (v.you && me && r && v.you.role !== (me.role ?? null)) out.push("you.role differs from the public role");
    }
    if (god?.players && r && r.phase !== "reveal") {
        const text = JSON.stringify(v.you || {});
        for (const p of god.players) {
            if (p.u === viewer) continue;
            for (const c of [p.card?.card, ...(p.deal || [])].filter(Boolean)) if (text.includes(`"${c}"`) && !(v.you?.card?.card === c || (v.you?.deal || []).includes(c) || v.you?.peek?.card === c)) out.push(`${p.u}'s card ${c} in your panel`);
        }
    }
}
