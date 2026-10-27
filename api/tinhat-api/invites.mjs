// invites.mjs — registration invite codes for the server's operators (Tin Hat 10.4).
//
//   GET    /admin/invites          -> { invites: [{code, usesAllowed, pending, completed, expiresAt, active}], server, now }
//   POST   /admin/invites          { uses: 0..1000 (0 = unlimited, default 1), days: 0..3650 (0 = never, default 7) } -> { invite }
//   DELETE /admin/invites/:code    -> { ok: true }
//   Authorization: Bearer <the caller's Matrix access token>   (401 without, 403 for non-operators)
//
// An OPERATOR is a Synapse server admin, or an mxid listed in invite-operators.json next to this file
// (the owner's account is not a Synapse admin, and being able to invite people should not need the whole
// admin API). Codes are Synapse registration tokens — the homeserver runs registration_requires_token —
// minted through the admin API with this process' admin token, which never leaves the process. The code
// format is TH-XXXX-XXXX from an alphabet without look-alikes (no 0/O/1/I) so it survives being read out
// loud on a call. Tin Hat's sign-in screen ("Create an account") turns a code into an account. The server's
// dashboard mints the same format (manager/tinhat/web.py).
import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Za-z0-9._~-]{1,64}$/;   // Synapse's token charset
/** What a log line may say about a code: its first 5 characters ("TH-AB…"). A live code in the logs is a way in for
 *  whoever reads them (security review 2026-10-26). */
export const codeHint = (code) => `${String(code ?? "").slice(0, 5)}…`;
export const INVITE_PREFIX = "TH-";

/** A new invite code: TH-XXXX-XXXX. */
export function mintInviteCode() {
    const pick = n => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    return `${INVITE_PREFIX}${pick(4)}-${pick(4)}`;
}

/**
 * Mount the routes. deps: { requireMatrixUser, synapse, adminToken, operators: Set<mxid>, serverName, log? }.
 */
export function installInvites(app, deps) {
    const { requireMatrixUser, synapse, adminToken, operators, serverName } = deps;
    const log = deps.log || ((...a) => console.log("[invites]", ...a));
    if (!adminToken) {
        console.error("[invites] synapse-admin.token missing -> invite codes DISABLED");
        return;
    }
    // Synapse server admins count as operators too; a minute of cache keeps the list snappy.
    const adminCache = new Map();
    async function isOperator(mxid) {
        if (operators.has(mxid)) return true;
        const c = adminCache.get(mxid);
        if (c && Date.now() - c.at < 60_000) return c.ok;
        let ok = false;
        try {
            const r = await synapse(`/_synapse/admin/v2/users/${encodeURIComponent(mxid)}`, {}, adminToken);
            ok = r.ok && r.body.admin === true;
        } catch { ok = false; }
        adminCache.set(mxid, { ok, at: Date.now() });
        return ok;
    }
    async function requireOperator(req, res, next) {
        if (!(await isOperator(req.matrixUser))) return res.status(403).json({ error: "Only a server admin can manage invite codes" });
        next();
    }
    const shape = t => ({
        code: t.token,
        usesAllowed: t.uses_allowed ?? null,
        pending: t.pending || 0,
        completed: t.completed || 0,
        expiresAt: t.expiry_time ?? null,
        active: (t.expiry_time == null || t.expiry_time > Date.now())
             && (t.uses_allowed == null || (t.completed || 0) + (t.pending || 0) < t.uses_allowed),
    });

    app.get("/admin/invites", requireMatrixUser, requireOperator, async (req, res) => {
        try {
            const r = await synapse("/_synapse/admin/v1/registration_tokens", {}, adminToken);
            if (!r.ok) return res.status(502).json({ error: `Synapse said ${r.status}` });
            const list = (r.body.registration_tokens || []).map(shape)
                .sort((a, b) => (b.active - a.active) || ((b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity)));
            res.json({ invites: list, server: serverName, now: Date.now() });
        } catch (e) { res.status(502).json({ error: `Synapse unreachable: ${e.message}` }); }
    });

    app.post("/admin/invites", requireMatrixUser, requireOperator, async (req, res) => {
        const uses = Number.isInteger(req.body?.uses) ? req.body.uses : 1;
        const days = Number.isInteger(req.body?.days) ? req.body.days : 7;
        if (uses < 0 || uses > 1000 || days < 0 || days > 3650)
            return res.status(400).json({ error: "uses 0..1000 (0 = unlimited), days 0..3650 (0 = never)" });
        const body = {
            token: mintInviteCode(),
            uses_allowed: uses === 0 ? null : uses,
            expiry_time: days === 0 ? null : Date.now() + days * 86_400_000,
        };
        try {
            const r = await synapse("/_synapse/admin/v1/registration_tokens/new", { method: "POST", body: JSON.stringify(body) }, adminToken);
            if (!r.ok) return res.status(502).json({ error: r.body?.error || `Synapse said ${r.status}` });
            log(`${req.matrixUser} minted ${codeHint(r.body.token)} (uses ${body.uses_allowed ?? "unlimited"}, expires ${body.expiry_time ? new Date(body.expiry_time).toISOString() : "never"})`);
            res.json({ invite: shape(r.body) });
        } catch (e) { res.status(502).json({ error: `Synapse unreachable: ${e.message}` }); }
    });

    app.delete("/admin/invites/:code", requireMatrixUser, requireOperator, async (req, res) => {
        const code = String(req.params.code || "");
        if (!CODE_RE.test(code)) return res.status(400).json({ error: "bad code" });
        try {
            const r = await synapse(`/_synapse/admin/v1/registration_tokens/${encodeURIComponent(code)}`, { method: "DELETE" }, adminToken);
            if (r.status === 404) return res.status(404).json({ error: "That code is already gone" });
            if (!r.ok) return res.status(502).json({ error: `Synapse said ${r.status}` });
            log(`${req.matrixUser} revoked ${codeHint(code)}`);
            res.json({ ok: true });
        } catch (e) { res.status(502).json({ error: `Synapse unreachable: ${e.message}` }); }
    });

    log(`ready — ${operators.size} listed operator(s) + Synapse server admins`);
}
