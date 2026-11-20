// The play contract, v1 (GAMES-V1-SPEC §4.3, §5.3, §6). build.mjs writes this out as vectors/views/schema.json.
// It describes EXACTLY what a v1 server sends (additionalProperties: false), so the server's own tests catch a field
// that shouldn't be there (a leak). Apps must IGNORE fields they don't know (a later server may add some).
const int = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum: min, maximum: max });
const str = (max = 255) => ({ type: "string", maxLength: max });
const ref = (n) => ({ $ref: `#/$defs/${n}` });
const nullable = (s) => ({ anyOf: [{ type: "null" }, s] });
const arr = (items, min, max) => ({ type: "array", items, ...(min !== undefined ? { minItems: min } : {}), ...(max !== undefined ? { maxItems: max } : {}) });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra });
const map = (keyDef, valueSchema) => ({ type: "object", propertyNames: ref(keyDef), additionalProperties: valueSchema });

export const RIG_CARDS = ["moon-monday", "lizard-lane", "hat-thief", "twos-company", "big-bet-tax", "penny-pincher",
    "cold-streak", "skim", "moon-tax", "shy-hat", "lizard-tax", "underdog", "rebound", "hot-hat", "slow-start", "even-money"];
export const SYMBOLS = ["hat", "saucer", "dish", "eye", "moon", "lizard"];
export const WHISPER_TEMPLATES = { "bet-size": "It's about bet size", "not-moon": "It's not a Moon thing",
    "last-spin": "It's about the last spin", "reel-2": "Watch reel 2", "bluffing": "{person} is bluffing", "trust-nobody": "Trust nobody" };

// code → HTTP status (an ack carries the code only). Order = §6.3.
export const CODES = {
    session: 401, guest: 403, "not-member": 403, "not-in-call": 403, "remote-refused": 403, "rig-hidden": 403,
    "no-space": 403, "wrong-server": 403, "space-changed": 409, unavailable: 503,
    "no-table": 404, "no-wallet": 404, "seated-elsewhere": 409, "table-full": 409, "one-per-room": 409, seated: 409,
    "open-money": 409, rate: 429, off: 503, db: 503,
    stale: 409, "not-your-turn": 409, phase: 409, bad: 400, "bad-action": 409, "bad-amount": 400, "no-chips": 409,
    limit: 409, locked: 409, window: 409, taken: 409, rules: 409, greyed: 409, "host-only": 403,
};

export const HOLDEM_MOVES = ["sit", "leave", "deal", "fold", "check", "call", "raise", "allin", "away", "kick", "close"];
export const RIG_MOVES = ["join", "leave", "start", "keep", "market", "dial", "spin", "call", "audit", "walk", "mute",
    "patch", "nudge", "whisper", "peek", "kick", "close"];
// moves that are table-level (no `at`), §6.3
export const TABLE_MOVES = ["sit", "leave", "deal", "away", "kick", "close", "join", "start"];

const deadline = int(0);
const seatNo = int(1, 8);


// Every move's exact shape (§6.3): the fields it needs, the fields it may carry, and whether it names a turn (`at`).
// Table-level moves carry no `at`; every other move must. Hold'em vs The Rig is told apart by the table id (tH… / tR…).
const AT_HOLDEM = obj({ hand: int(1), turn: int(1) });
const AT_RIG = obj({ round: int(1), spin: int(0, 10), phase: { enum: ["setup", "turn", "spin", "land", "nudge", "payout", "reveal"] } });
const F = {
    seat: seatNo, to: int(1), on: { type: "boolean" }, u: { $ref: "#/$defs/mxid" }, space: { $ref: "#/$defs/room" },
    preset: { enum: ["lite", "full"] }, bankroll: int(3, 10), patch: { type: "boolean" }, card: { $ref: "#/$defs/rigCard" },
    side: { enum: ["up", "not-up"] }, stake: int(1, 2), bet: int(1, 3), spin: int(1, 10), armed: { type: "boolean" },
    reel: int(1, 3), step: { enum: [1, -1] }, template: { $ref: "#/$defs/template" }, person: { $ref: "#/$defs/mxid" },
    text: { type: "string", minLength: 1, maxLength: 60 }, mechanic: { $ref: "#/$defs/mxid" },
};
// [do, required fields, optional fields, names a turn?]
export const MOVE_SHAPES = {
    holdem: [["sit", ["space"], ["seat"], false], ["leave", [], [], false], ["deal", [], [], false], ["fold", [], [], true],
        ["check", [], [], true], ["call", [], [], true], ["raise", ["to"], [], true], ["allin", [], [], true],
        ["away", ["on"], [], false], ["kick", ["u"], [], false], ["close", [], [], false]],
    rig: [["join", ["space"], [], false], ["leave", [], [], false], ["start", [], ["preset", "bankroll", "patch"], false],
        ["keep", ["card"], [], true], ["market", ["side", "stake"], [], true], ["market-pass", [], [], true],
        ["dial", ["bet"], [], true], ["spin", [], ["bet"], true], ["call", ["card"], [], true], ["audit", ["spin"], [], true],
        ["walk", [], [], true], ["mute", ["armed"], [], true], ["patch", [], [], true], ["nudge", ["reel", "step"], [], true],
        ["whisper", ["template"], ["person"], true], ["whisper-text", ["text"], [], true], ["peek", ["mechanic", "card"], [], true],
        ["kick", ["u"], [], false], ["close", [], [], false]],
};
function actVariants(game) {
    return MOVE_SHAPES[game].map(([name, req, opt, atNeeded]) => {
        const doName = name === "market-pass" ? "market" : name === "whisper-text" ? "whisper" : name;
        const props = { do: { const: doName } };
        for (const k of [...req, ...opt]) props[k] = F[k];
        if (name === "market-pass") props.side = { const: "pass" };
        const a = obj(props, ["do", ...req, ...(name === "market-pass" ? ["side"] : [])]);
        const top = { t: { const: "act" }, table: { type: "string", pattern: game === "holdem" ? "^tH[A-Za-z0-9]{14}$" : "^tR[A-Za-z0-9]{14}$" }, op: { $ref: "#/$defs/op" }, a };
        if (atNeeded) top.at = game === "holdem" ? AT_HOLDEM : AT_RIG;
        return obj(top, ["t", "table", "op", "a", ...(atNeeded ? ["at"] : [])]);
    });
}

export const SCHEMA = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "tinhat-play-v1",
    title: "Tin Hat play contract v1 (frames, views, HTTP answers). Apps ignore unknown fields.",
    "x-codes": CODES,
    "x-moves": { holdem: HOLDEM_MOVES, rig: RIG_MOVES, table_level: TABLE_MOVES, shapes: MOVE_SHAPES },
    $defs: {
        mxid: { type: "string", pattern: "^@[^:\\s]+:[^\\s]+$", maxLength: 255 },
        // in HISTORY answers (hands, rounds, summary) a person who deleted their chips is "someone": a placeholder
        // "~1", "~2"… local to that one answer (two deleted people stay two); never in live views
        histPerson: { type: "string", pattern: "^(@[^:\\s]+:[^\\s]+|~[1-9][0-9]?)$", maxLength: 255 },
        room: { type: "string", pattern: "^![^:\\s]+:[^\\s]+$", maxLength: 255 },
        server: { type: "string", pattern: "^[A-Za-z0-9.-]+(:[0-9]{1,5})?$", maxLength: 255 },
        table: { type: "string", pattern: "^t[HR][A-Za-z0-9]{14}$" },
        op: { type: "string", pattern: "^[A-Za-z0-9_-]{16,32}$" },
        seatKey: { type: "string", pattern: "^[1-8]$" },
        day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        code: { enum: Object.keys(CODES) },
        clientKind: { enum: ["desktop", "web", "ios-app", "android-app", "mac-app"] },
        screen: { enum: ["desktop", "web", "pad", "ios-app", "android-app", "mac-app"] },
        card: { type: "string", pattern: "^[2-9TJQKA][cdhs]$" },
        symbol: { enum: SYMBOLS },
        reels: arr({ enum: SYMBOLS }, 3, 3),
        rigCard: { enum: RIG_CARDS },
        template: { enum: Object.keys(WHISPER_TEMPLATES) },
        closed: obj({ reason: { enum: ["host", "idle", "no-call", "restart", "off", "end", "space-changed", "empty"] }, at: int() }),

        // ------------------------------------------------------------------ Hold'em view (§4.3)
        holdemSeat: obj({
            seat: seatNo, u: ref("mxid"), stack: int(), bet: int(),
            state: { enum: ["waiting", "active", "folded", "allin", "away", "out", "leaving"] },
            cards: { enum: [0, 2] }, connected: { type: "boolean" },
            shown: arr(ref("card"), 2, 2),
        }, ["seat", "u", "stack", "bet", "state", "cards", "connected"]),
        holdemPot: obj({ amount: int(1), eligible: arr(seatNo, 1, 8) }),
        holdemHand: obj({
            n: int(1), button: seatNo, sb: seatNo, bb: seatNo,
            street: { enum: ["preflop", "flop", "turn", "river", "showdown"] },
            board: arr(ref("card"), 0, 5),
            pots: arr(ref("holdemPot")),
            total: int(),
            to_act: nullable(obj({ seat: seatNo, turn: int(1), deadline })),
            last: nullable(obj({ seat: seatNo, a: { enum: ["sb", "bb", "fold", "check", "call", "bet", "raise", "allin", "timeout"] }, to: int() }, ["seat", "a"])),
        }),
        holdemResult: obj({
            n: int(1), board: arr(ref("card"), 0, 5),
            pots: arr(obj({ amount: int(1), eligible: arr(seatNo, 1, 8), winners: arr(seatNo, 1, 8), paid: map("seatKey", int(1)) })),
            returned: map("seatKey", int(1)),
            shown: map("seatKey", arr(ref("card"), 2, 2)),
            best: map("seatKey", obj({ category: { enum: ["high-card", "pair", "two-pair", "trips", "straight", "flush", "full-house", "quads", "straight-flush"] }, five: arr(ref("card"), 5, 5) })),
            net: map("mxid", { type: "integer" }),
            voided: { type: "boolean" },
            next_at: nullable(deadline),
        }),
        holdemLegal: obj({
            fold: { type: "boolean" }, check: { type: "boolean" }, call: int(),
            raise: nullable(obj({ min: int(1), max: int(1) })),
        }),
        holdemYou: obj({
            seat: seatNo, state: { enum: ["waiting", "active", "folded", "allin", "away", "out", "leaving"] },
            cards: arr(ref("card"), 0, 2),
            legal: nullable(ref("holdemLegal")),
            screens: arr(ref("screen")), at_cap: { type: "boolean" }, cap: int(100), holdings: int(),
            timeouts: int(0, 2),
            can_deal: { type: "boolean" }, // the host in the lobby: at least two players with chips (the Deal button)
        }, ["seat", "state", "cards", "legal", "screens", "at_cap", "cap", "holdings", "timeouts"]),
        holdemView: obj({
            game: { const: "holdem" }, table: ref("table"), room: ref("room"), space: ref("room"), owner: ref("server"), vseq: int(1), now: int(),
            status: { enum: ["lobby", "hand", "pause", "closed"] }, host: ref("mxid"),
            opts: obj({ sb: { const: 1 }, bb: { const: 2 }, seats: int(2, 8), turn_s: { const: 30 } }),
            seats: arr(ref("holdemSeat"), 0, 8),
            hand: nullable(ref("holdemHand")),
            result: nullable(ref("holdemResult")),
            closed: nullable(ref("closed")),
            spectators: int(),
            you: ref("holdemYou"),
        }, ["game", "table", "room", "space", "owner", "vseq", "now", "status", "host", "opts", "seats", "hand", "result", "closed", "spectators"]),

        // ------------------------------------------------------------------ The Rig view (§5.3)
        rigPlayer: obj({
            u: ref("mxid"), order: int(1, 8),
            role: { enum: [null, "spinner", "mechanic", "sharp", "railbird"] },
            connected: { type: "boolean" }, left: { type: "boolean" }, spun: { type: "boolean" }, skipped: { type: "boolean" },
        }),
        rigBoardCard: obj({
            card: ref("rigCard"), state: { enum: ["open", "dead", "busted", "wrong"] },
            by: ref("mxid"), spin: int(1, 10),
        }, ["card", "state"]),
        rigHistory: obj({
            spin: int(1, 10), bet: int(1, 3), reels: ref("reels"), payout: int(),
            result: { enum: ["win", "push", "loss"] },
            stamps: arr({ enum: ["nudged", "audited", "called-right", "called-wrong", "refilled"] }),
        }),
        rigWhisper: obj({ spin: int(0, 10), template: ref("template"), person: ref("mxid"), text: { type: "string", minLength: 1, maxLength: 60 } }, ["spin"]),
        rigReveal: obj({
            seed: { type: "string", pattern: "^[0-9a-f]{64}$" },
            slots: arr(obj({ slot: int(1, 3), card: ref("rigCard"), owner: ref("histPerson"), from_spin: int(1, 10) })),
            mutes: arr(obj({ spin: int(1, 10), owner: ref("histPerson") })),
            nudges: arr(obj({ spin: int(1, 10), by: ref("histPerson"), reel: int(1, 3), step: { enum: [1, -1] } })),
            calls: arr(obj({ spin: int(1, 10), card: ref("rigCard"), right: { type: "boolean" }, owner: nullable(ref("histPerson")) })),
            peeks: arr(obj({ who: ref("histPerson"), target: ref("histPerson"), card: ref("rigCard"), right: { type: "boolean" }, delta: { type: "integer" } })),
            market: arr(obj({ who: ref("histPerson"), side: { enum: ["up", "not-up"] }, stake: int(1, 2), back: int() })),
            whispers: arr(obj({ who: ref("histPerson"), spin: int(0, 10), template: ref("template"), person: ref("histPerson"), text: { type: "string", minLength: 1, maxLength: 60 } }, ["who", "spin"])),
            spins: arr(obj({
                spin: int(1, 10), bet: int(1, 3), honest: ref("reels"), after_cards: ref("reels"), final: ref("reels"),
                honest_payout: int(), payout: int(),
                touched: arr(ref("rigCard")), bit: arr(ref("rigCard")), rake: map("rigCardKey", int(1)),
            })),
            up: { type: "boolean" },
            net: map("histPerson", { type: "integer" }),
        }),
        rigCardKey: { enum: RIG_CARDS },
        rigRound: obj({
            r: int(1), spinner: ref("mxid"), preset: { enum: ["lite", "full"] },
            phase: { enum: ["setup", "turn", "spin", "land", "nudge", "payout", "reveal"] },
            spin: int(0, 10), spins: { enum: [8, 10] }, deadline: nullable(deadline),
            seed_commit: { type: "string", pattern: "^[0-9a-f]{64}$" },
            bankroll: obj({ start: int(), now: int() }),
            net: { type: "integer" },
            dial: int(1, 3), bet: nullable(int(1, 3)),
            calls_left: int(0, 3), call_used_this_spin: { type: "boolean" }, audit_used: { type: "boolean" },
            walk_from: { enum: [5, 6] }, peek_lock_after: { enum: [3, 4] }, peeks_locked: { type: "boolean" },
            features: obj({ mutes: { type: "boolean" }, nudge: { type: "boolean" }, whisper: { type: "boolean" }, patch: { type: "boolean" } }),
            board: arr(ref("rigBoardCard"), 10, 16),
            dead: arr(ref("rigCard"), 3, 4),
            mechanics: int(0, 3),
            refilled: arr(obj({ spin: int(1, 10) })),
            history: arr(ref("rigHistory"), 0, 10),
            reels: nullable(ref("reels")),
            nudge: nullable(obj({ open: { type: "boolean" }, deadline: nullable(deadline), reel: int(1, 3), step: { enum: [1, -1] } }, ["open", "deadline"])),
            waiting_on: int(0, 8),
            paused: nullable(obj({ budget_ms: int() })),
            audit: obj({ spin: int(1, 10), honest_reels: ref("reels"), honest_payout: int(), touched: int(0, 4) }),
            reveal: ref("rigReveal"),
        }, ["r", "spinner", "preset", "phase", "spin", "spins", "deadline", "seed_commit", "bankroll", "net", "dial", "bet",
            "calls_left", "call_used_this_spin", "audit_used", "walk_from", "peek_lock_after", "peeks_locked", "features", "board", "dead",
            "mechanics", "refilled", "history", "reels", "nudge", "waiting_on", "paused"]),
        rigEnd: obj({ rounds: int(1), leaderboard: arr(obj({ u: ref("histPerson"), net: { type: "integer" } })), pit_boss: nullable(ref("histPerson")) }),
        rigPeek: obj({ placed: { type: "boolean" }, mechanic: ref("mxid"), card: ref("rigCard"), locks_after: { enum: [3, 4] } }, ["placed", "locks_after"]),
        rigMarket: nullable(obj({ side: { enum: ["up", "not-up"] }, stake: int(1, 2) })),
        rigYou: {
            oneOf: [
                obj({ role: { const: null }, screens: arr(ref("screen")), at_cap: { type: "boolean" }, holdings: int() }),
                obj({ role: { const: "spinner" }, whispers: arr(ref("rigWhisper")), screens: arr(ref("screen")), at_cap: { type: "boolean" }, holdings: int(), timeouts: int(0, 2) }),
                obj({
                    role: { const: "mechanic" },
                    deal: arr(ref("rigCard"), 2, 2), kept: { type: "boolean" },
                    card: nullable(obj({ card: ref("rigCard"), bite: int(1, 3) })),
                    busted: { type: "boolean" }, patch: nullable(obj({ card: ref("rigCard"), ok: { type: "boolean" } })),
                    mutes_left: int(0, 2), armed: { type: "boolean" }, rake: int(), call_shares: int(),
                    nudge_left: int(0, 1), whisper_used: { type: "boolean" }, peek: ref("rigPeek"), market: ref("rigMarket"),
                    market_done: { type: "boolean" },
                    screens: arr(ref("screen")), at_cap: { type: "boolean" }, holdings: int(),
                }, ["role", "kept", "card", "busted", "patch", "mutes_left", "armed", "rake", "call_shares", "nudge_left", "whisper_used", "peek", "market", "market_done", "screens", "at_cap", "holdings"]),
                obj({
                    role: { const: "sharp" }, nudge_left: int(0, 1), whisper_used: { type: "boolean" }, peek: ref("rigPeek"),
                    market: ref("rigMarket"), market_done: { type: "boolean" }, screens: arr(ref("screen")), at_cap: { type: "boolean" }, holdings: int(),
                }),
                obj({ role: { const: "railbird" }, nudge_left: int(0, 1), whisper_used: { type: "boolean" }, screens: arr(ref("screen")), at_cap: { type: "boolean" }, holdings: int() }),
            ],
        },
        rigView: obj({
            game: { const: "rig" }, table: ref("table"), room: ref("room"), space: ref("room"), owner: ref("server"), vseq: int(1), now: int(),
            status: { enum: ["lobby", "round", "end", "closed"] }, host: ref("mxid"),
            opts: obj({ preset: { enum: ["lite", "full"] }, bankroll: int(3, 10), patch: { type: "boolean" } }),
            players: arr(ref("rigPlayer"), 0, 8),
            round: nullable(ref("rigRound")),
            end: nullable(ref("rigEnd")),
            closed: nullable(ref("closed")),
            spectators: int(),
            you: ref("rigYou"),
        }, ["game", "table", "room", "space", "owner", "vseq", "now", "status", "host", "opts", "players", "round", "end", "closed", "spectators"]),

        view: { oneOf: [ref("holdemView"), ref("rigView")] },

        // ------------------------------------------------------------------ socket frames (§6.3)
        tableListing: obj({
            table: ref("table"), game: { enum: ["holdem", "rig"] }, status: { enum: ["lobby", "hand", "pause", "round", "end", "closed"] },
            host: ref("mxid"), seated: int(0, 8), seats: int(2, 8), players: arr(ref("mxid"), 0, 8),
            hand: nullable(int(1)), round: nullable(int(1)), space: ref("room"), owner: ref("server"),
        }),
        c_auth: obj({ t: { const: "auth" }, session: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, client: obj({ kind: ref("clientKind"), pad: { type: "boolean" }, v: str(32) }, ["kind"]) }),
        c_sub: obj({ t: { const: "sub" }, room: ref("room") }),
        c_unsub: obj({ t: { const: "unsub" }, room: ref("room") }),
        c_open: obj({ t: { const: "open" }, table: ref("table") }),
        c_close: obj({ t: { const: "close" }, table: ref("table") }),
        c_ping: obj({ t: { const: "ping" } }),
        c_act: { oneOf: [...actVariants("holdem"), ...actVariants("rig")] },
        clientFrame: { oneOf: [ref("c_auth"), ref("c_sub"), ref("c_unsub"), ref("c_open"), ref("c_close"), ref("c_ping"), ref("c_act")] },

        s_hello: obj({ t: { const: "hello" }, v: { const: 1 }, user: ref("mxid"), now: int(), rig_hidden: { type: "boolean" }, wallets: arr(ref("room")) }),
        s_room: obj({ t: { const: "room" }, room: ref("room"), space: ref("room"), owner: ref("server"), tables: arr(ref("tableListing")) }),
        s_view: obj({ t: { const: "view" }, table: ref("table"), vseq: int(1), view: ref("view") }),
        s_live: obj({ t: { const: "live" }, table: ref("table"), vseq: int(1), dial: int(1, 3) }),
        s_ack: obj({ t: { const: "ack" }, op: ref("op"), ok: { type: "boolean" }, code: { anyOf: [{ const: "" }, ref("code")] }, dup: { type: "boolean" } }),
        s_wallet: obj({ t: { const: "wallet" }, space: ref("room"), balance: int(), holdings: int(), rank: int(), cap: int(100), earned_today: int(0, 24) }, ["t", "space", "balance", "holdings", "rank", "cap"]),
        s_rank: obj({ t: { const: "rank" }, space: ref("room"), u: ref("mxid"), rank: int(1) }),
        s_post: obj({ t: { const: "post" }, kind: { enum: ["invite", "result", "summary"] }, game: { enum: ["holdem", "rig"] }, table: ref("table"), room: ref("room"), space: ref("room"), round: nullable(int(1)) }),
        s_pong: obj({ t: { const: "pong" }, now: int() }),
        s_bye: obj({ t: { const: "bye" }, code: { enum: ["replaced", "session", "off", "rate", "bad", "restart"] } }),
        s_error: obj({ t: { const: "error" }, code: ref("code"), table: ref("table"), room: ref("room"), space: ref("room"), server: ref("server") }, ["t", "code"]),
        serverFrame: { oneOf: [ref("s_hello"), ref("s_room"), ref("s_view"), ref("s_live"), ref("s_ack"), ref("s_wallet"), ref("s_rank"), ref("s_post"), ref("s_pong"), ref("s_bye"), ref("s_error")] },

        // ------------------------------------------------------------------ HTTP (§6.1, §6.2)
        httpError: obj({ code: ref("code"), error: str(300), space: ref("room"), server: ref("server") }, ["code"]),
        sessionRequest: obj({
            openid: obj({ access_token: str(512), matrix_server_name: str(255), token_type: { const: "Bearer" }, expires_in: int() }),
            user_id: ref("mxid"),
            client: obj({ kind: ref("clientKind"), v: str(32), pad: { type: "boolean" } }, ["kind"]),
        }),
        sessionAnswer: obj({ v: { const: 1 }, session: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, user: ref("mxid"), expires: int(), wallets: arr(ref("room")), rig_hidden: { type: "boolean" } }),
        walletRequest: obj({ space: ref("room") }),
        spaceAnswer: obj({ space: ref("room"), server: ref("server") }),
        tableRequest: {
            oneOf: [
                obj({ game: { const: "holdem" }, space: ref("room"), opts: obj({ seats: int(2, 8) }, []) }),
                obj({ game: { const: "rig" }, space: ref("room"), opts: obj({ preset: { enum: ["lite", "full"] }, bankroll: int(3, 10), patch: { type: "boolean" } }, []) }),
            ],
        },
        me: obj({
            v: { const: 1 }, space: ref("room"), user: ref("mxid"), balance: int(), holdings: int(), rank: int(), cap: int(100),
            at_table: nullable(obj({ table: ref("table"), game: { enum: ["holdem", "rig"] }, room: ref("room") })),
            earned_today: int(0, 24), day_max: int(1, 24), accrual_s: int(0, 3599), chip_s: int(1), day: ref("day"),
            topup: obj({ available: { type: "boolean" }, next_day: ref("day") }),
        }),
        journal: obj({
            v: { const: 1 }, space: ref("room"),
            entries: arr(obj({ tx: str(64), at: nullable(int()), day: ref("day"), delta: { type: "integer" }, reason: { enum: ["start", "earn", "topup", "prestige", "sit", "cashout", "rig-escrow", "rig-settle", "void", "lab-grant"] }, ref: nullable(str(64)) })),
            next: nullable(str(64)),
        }),
        ranks: obj({ v: { const: 1 }, space: ref("room"), ranks: map("mxid", int(1)) }),
        tables: obj({ space: ref("room"), owner: ref("server"), tables: arr(ref("tableListing")) }),
        tableCreated: obj({ table: ref("table") }),
        hands: obj({
            v: { const: 1 },
            hands: arr(obj({
                n: int(1), at: int(), button: seatNo, board: arr(ref("card"), 0, 5),
                you: obj({ seat: seatNo, cards: arr(ref("card"), 2, 2) }),
                actions: arr(obj({ street: { enum: ["preflop", "flop", "turn", "river"] }, seat: seatNo, a: { enum: ["sb", "bb", "fold", "check", "call", "bet", "raise", "allin", "timeout"] }, to: int() }, ["street", "seat", "a"])),
                shown: map("seatKey", arr(ref("card"), 2, 2)),
                seats: map("seatKey", ref("histPerson")),
                net: map("histPerson", { type: "integer" }), voided: { type: "boolean" },
            })),
            next: nullable(int(1)),
        }),
        round: obj({ v: { const: 1 }, table: ref("table"), r: int(1), spinner: ref("histPerson"), preset: { enum: ["lite", "full"] }, history: arr(ref("rigHistory")), reveal: ref("rigReveal") }),
        summary: obj({
            v: { const: 1 }, table: ref("table"), game: { enum: ["holdem", "rig"] }, room: ref("room"), space: ref("room"), owner: ref("server"), host: ref("histPerson"),
            status: { enum: ["open", "closed"] }, opened: int(), closed: nullable(int()),
            hands: int(), rounds: int(), biggest_pot: int(),
            net: map("histPerson", { type: "integer" }),
            leaderboard: arr(obj({ u: ref("histPerson"), net: { type: "integer" } })), pit_boss: nullable(ref("histPerson")),
        }),
        chatCard: obj({ v: { const: 1 }, kind: { enum: ["invite", "result", "summary"] }, game: { enum: ["holdem", "rig"] }, server: ref("server"), space: ref("room"), table: ref("table"), round: int(1) }, ["v", "kind", "game", "server", "space", "table"]),
    },
};
