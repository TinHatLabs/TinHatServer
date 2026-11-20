// games-s1 LAB smoke, run INSIDE the lab box's API container (VM 271 only): throwaway @gs1-smoke-a/b/c accounts, a
// space + a room linked both ways, call memberships, OpenID → play sessions THROUGH CADDY, wallets, a Hold'em hand on the
// socket, then everyone leaves. Prints no token or password.
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const SN = process.env.SERVER_NAME;
const HS = process.env.SYNAPSE_INTERNAL || "http://127.0.0.1:8008";
const ADMIN = readFileSync("/conf/synapse-admin.token", "utf8").trim();
const log = (...a) => console.log(...a);
const viaCaddy = (method, path, body, auth) => new Promise((ok, no) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = request({ host: "127.0.0.1", port: 8080, method, path, headers: { Host: SN, "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}), ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } }, (rs) => {
        let t = ""; rs.on("data", (d) => { t += d; }); rs.on("end", () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t.slice(0, 200) }; } ok({ status: rs.statusCode, body: j }); });
    });
    rq.on("error", no); if (data) rq.write(data); rq.end();
});
async function hs(method, path, token, body) {
    const r = await fetch(HS + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} → ${r.status} ${j.errcode || ""}`);
    return j;
}
const users = {};
for (const n of ["a", "b", "c"]) {
    const id = `@gs1-smoke-${n}:${SN}`;
    const pw = randomBytes(18).toString("base64url");
    await hs("PUT", `/_synapse/admin/v2/users/${encodeURIComponent(id)}`, ADMIN, { password: pw, admin: false, displayname: `S1 ${n.toUpperCase()}` });
    // a token for the throwaway account without a password sign-in (no sign-in loop, no rate limit): valid 1 h
    const j = await hs("POST", `/_synapse/admin/v1/users/${encodeURIComponent(id)}/login`, ADMIN, { valid_until_ms: Date.now() + 3600_000 });
    users[n] = { id, token: j.access_token, device: `GS1${n.toUpperCase()}` };
}
log("accounts:", Object.values(users).map((u) => u.id.split(":")[0]).join(" "));
const A = users.a;
const space = (await hs("POST", "/_matrix/client/v3/createRoom", A.token, { name: "games-s1 space", preset: "private_chat", creation_content: { type: "m.space" } })).room_id;
const room = (await hs("POST", "/_matrix/client/v3/createRoom", A.token, { name: "games-s1 table room", preset: "private_chat" })).room_id;
await hs("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(space)}/state/m.space.child/${encodeURIComponent(room)}`, A.token, { via: [SN] });
await hs("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.space.parent/${encodeURIComponent(space)}`, A.token, { via: [SN], canonical: true });
for (const n of ["b", "c"]) for (const r of [space, room]) {
    await hs("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(r)}/invite`, A.token, { user_id: users[n].id });
    await hs("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(r)}/join`, users[n].token, {});
}
// power: let everyone write their own call membership (private_chat already allows state for members? set the event level)
const pl = await hs("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.power_levels`, A.token);
pl.events = { ...(pl.events || {}), "org.matrix.msc3401.call.member": 0 };
await hs("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.power_levels`, A.token, pl);
for (const u of Object.values(users)) {
    const now = Date.now();
    await hs("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(`_${u.id}_${u.device}_m.call`)}`, u.token,
        { application: "m.call", call_id: "", scope: "m.room", device_id: u.device, created_ts: now, expires: 4 * 3600_000, focus_active: { type: "livekit", focus_selection: "oldest_membership" }, foci_preferred: [] });
}
log("space + room linked both ways; 3 joined + in the call");
for (const u of Object.values(users)) {
    const oid = await hs("POST", `/_matrix/client/v3/user/${encodeURIComponent(u.id)}/openid/request_token`, u.token, {});
    const s = await viaCaddy("POST", "/api/play/v1/session", { openid: oid, user_id: u.id, client: { kind: "web" } });
    if (s.status !== 200) throw new Error(`session ${u.id.split(":")[0]}: ${s.status} ${JSON.stringify(s.body)}`);
    u.session = s.body.session; u.auth = `Play ${u.session}`;
}
log("OpenID → play sessions through Caddy: 3 OK");
const sp = await viaCaddy("GET", `/api/play/v1/rooms/${encodeURIComponent(room)}/space`, null, A.auth);
log("GET /rooms/{room}/space:", sp.status, sp.body?.space === space ? "= our space" : JSON.stringify(sp.body), sp.body?.server);
for (const u of Object.values(users)) {
    const w = await viaCaddy("POST", "/api/play/v1/wallet", { space }, u.auth);
    log(`wallet ${u.id.split(":")[0]}: ${w.status} balance ${w.body?.balance}`);
}
const t = await viaCaddy("POST", `/api/play/v1/rooms/${encodeURIComponent(room)}/tables`, { game: "holdem", space, opts: { seats: 8 } }, A.auth);
if (t.status !== 201) throw new Error(`create table: ${t.status} ${JSON.stringify(t.body)}`);
const T = t.body.table;
log("Hold'em table created");
const socks = {};
let opn = 0;
for (const [n, u] of Object.entries(users)) {
    const ws = new WebSocket("ws://127.0.0.1:3001/v1/ws");
    const c = { ws, views: [], acks: new Map(), waiters: [] };
    ws.addEventListener("message", (e) => {
        const f = JSON.parse(e.data);
        if (f.t === "view") c.views.push(f.view);
        if (f.t === "ack") c.acks.set(f.op, f);
        for (const w of [...c.waiters]) if (w.p(f)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.ok(f); }
    });
    await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
    c.wait = (p, ms = 8000) => new Promise((ok, no) => { const w = { p, ok }; c.waiters.push(w); setTimeout(() => no(new Error(`${n}: timeout`)), ms); });
    c.send = (f) => ws.send(JSON.stringify(f));
    c.act = async (a, at) => { const op = `gs1-smoke-${String(++opn).padStart(8, "0")}`; c.send({ t: "act", table: T, op, ...(at ? { at } : {}), a }); return c.wait((f) => f.t === "ack" && f.op === op); };
    c.send({ t: "auth", session: u.session, client: { kind: "web", pad: false } });
    await c.wait((f) => f.t === "hello");
    c.send({ t: "open", table: T });
    await c.wait((f) => f.t === "view");
    socks[n] = c;
}
for (const n of ["a", "b", "c"]) { const r = await socks[n].act({ do: "sit", space }); if (!r.ok) throw new Error(`sit ${n}: ${r.code}`); }
await new Promise((r) => setTimeout(r, 300));
const d = await socks.a.act({ do: "deal" });
log("deal:", d.ok ? "ok" : d.code);
let moves = 0;
for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const v = socks.a.views.at(-1);
    if (!v.hand?.to_act) break;
    const who = Object.entries(users).find(([, u]) => u.id === v.seats.find((s) => s.seat === v.hand.to_act.seat).u)[0];
    const mv = socks[who].views.at(-1);
    const a = mv.you.legal.check ? { do: "check" } : { do: "call" };
    const r = await socks[who].act(a, { hand: mv.hand.n, turn: mv.hand.to_act.turn });
    if (!r.ok) throw new Error(`move: ${r.code}`);
    moves++;
}
await new Promise((r) => setTimeout(r, 500));
const end = socks.a.views.at(-1);
log(`hand played: ${moves} moves, status ${end.status}, result: ${end.result ? `pots ${end.result.pots.map((p) => p.amount).join("+")}, shown ${Object.keys(end.result.shown).length}` : "none"}, stacks ${end.seats.map((s) => s.stack).join("/")} (Σ ${end.seats.reduce((x, s) => x + s.stack, 0)})`);
for (const n of ["a", "b", "c"]) await socks[n].act({ do: "leave" });
await new Promise((r) => setTimeout(r, 600));
for (const u of Object.values(users)) {
    const m = await viaCaddy("GET", `/api/play/v1/me?space=${encodeURIComponent(space)}`, null, u.auth);
    log(`after: ${u.id.split(":")[0]} balance ${m.body?.balance} holdings ${m.body?.holdings} rank ${m.body?.rank}`);
}
for (const c of Object.values(socks)) c.ws.close();
log(`SMOKE OK (table ${T.slice(0, 4)}…, room/space named "games-s1 …")`);
process.exit(0);
