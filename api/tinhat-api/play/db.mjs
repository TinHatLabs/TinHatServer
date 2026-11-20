// The games database (GAMES-V1-SPEC §1 "Database", §1.1, §2.5): schema migrations for `tinhat_play`, additive only,
// recorded in play_schema(version). The journal is append-only and double-entry: every transaction's entries sum to
// zero (a deferred constraint trigger), every entry's account belongs to the transaction's space (a trigger: nothing
// can move chips across spaces), the cached balance follows the entries (a trigger), and no row of play_tx /
// play_entries can ever be updated or deleted (triggers). Matrix ids live in exactly one table: play_people.
import pg from "pg";

export const SCHEMA_VERSION = 2;

const V1 = `
CREATE TABLE play_spaces (
  sid        bigserial PRIMARY KEY,
  space_id   text NOT NULL UNIQUE,
  owner      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- the ONLY place a Matrix id meets a wallet id (§2.2)
CREATE TABLE play_people (
  sid     bigint NOT NULL REFERENCES play_spaces(sid),
  user_id text   NOT NULL,
  wid     text   NOT NULL UNIQUE,
  PRIMARY KEY (sid, user_id)
);
CREATE TABLE play_wallets (
  wid              text PRIMARY KEY,
  sid              bigint NOT NULL REFERENCES play_spaces(sid),
  rank             int    NOT NULL DEFAULT 0 CHECK (rank >= 0),
  accrual_s        int    NOT NULL DEFAULT 0 CHECK (accrual_s >= 0),
  credited_through timestamptz,
  day              text,
  earned_today     int    NOT NULL DEFAULT 0 CHECK (earned_today >= 0),
  topup_day        text,
  allow_pranks     boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint NOT NULL DEFAULT 0
);
CREATE TABLE play_accounts (
  id      text PRIMARY KEY,
  sid     bigint NOT NULL REFERENCES play_spaces(sid),
  kind    text   NOT NULL CHECK (kind IN ('w','seat','pot','esc','mint','burn','bank')),
  wid     text,
  balance bigint NOT NULL DEFAULT 0,
  CONSTRAINT play_accounts_nonneg CHECK (kind IN ('mint','burn','bank') OR balance >= 0),
  CONSTRAINT play_accounts_owned CHECK ((kind IN ('mint','burn','bank')) = (wid IS NULL))
);
CREATE INDEX play_accounts_wid ON play_accounts (wid) WHERE wid IS NOT NULL;
CREATE TABLE play_tx (
  tx       uuid PRIMARY KEY,
  sid      bigint NOT NULL REFERENCES play_spaces(sid),
  at       timestamptz NOT NULL DEFAULT now(),
  day      text NOT NULL,
  kind     text NOT NULL,
  idem_key text NOT NULL UNIQUE,
  ref      text
);
CREATE TABLE play_entries (
  tx      uuid   NOT NULL REFERENCES play_tx(tx),
  account text   NOT NULL REFERENCES play_accounts(id),
  delta   bigint NOT NULL CHECK (delta <> 0)
);
CREATE INDEX play_entries_tx ON play_entries (tx);
CREATE INDEX play_entries_account ON play_entries (account);

-- an entry: same space as its transaction, then the cached balance moves (the CHECK refuses a negative wallet)
CREATE FUNCTION play_entry_apply() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE tsid bigint; asid bigint;
BEGIN
  SELECT sid INTO tsid FROM play_tx WHERE tx = NEW.tx;
  SELECT sid INTO asid FROM play_accounts WHERE id = NEW.account;
  IF tsid IS NULL OR asid IS NULL OR tsid <> asid THEN
    RAISE EXCEPTION 'play: entry % mixes spaces (tx sid %, account sid %)', NEW.account, tsid, asid USING ERRCODE = 'check_violation';
  END IF;
  UPDATE play_accounts SET balance = balance + NEW.delta WHERE id = NEW.account;
  RETURN NEW;
END $f$;
CREATE TRIGGER play_entries_apply AFTER INSERT ON play_entries FOR EACH ROW EXECUTE FUNCTION play_entry_apply();

-- every transaction sums to zero, checked at COMMIT (deferred)
CREATE FUNCTION play_tx_balanced() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO s FROM play_entries WHERE tx = NEW.tx;
  IF s <> 0 THEN RAISE EXCEPTION 'play: transaction % sums to % (must be 0)', NEW.tx, s USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER play_entries_balanced AFTER INSERT ON play_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION play_tx_balanced();

-- append-only
CREATE FUNCTION play_append_only() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'play: % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $f$;
CREATE TRIGGER play_tx_ro BEFORE UPDATE OR DELETE ON play_tx FOR EACH ROW EXECUTE FUNCTION play_append_only();
CREATE TRIGGER play_entries_ro BEFORE UPDATE OR DELETE ON play_entries FOR EACH ROW EXECUTE FUNCTION play_append_only();
-- an account's space and owner never change
CREATE FUNCTION play_account_fixed() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.sid <> OLD.sid OR NEW.kind <> OLD.kind OR NEW.wid IS DISTINCT FROM OLD.wid OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'play: an account''s space/kind/owner never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER play_accounts_fixed BEFORE UPDATE ON play_accounts FOR EACH ROW EXECUTE FUNCTION play_account_fixed();
CREATE TRIGGER play_accounts_nodelete BEFORE DELETE ON play_accounts FOR EACH ROW EXECUTE FUNCTION play_append_only();

-- "Coming back after deleting" (§2.2): a salted hash per (space, person), 30 days
CREATE TABLE play_tombstones (
  sid          bigint NOT NULL REFERENCES play_spaces(sid),
  uhash        text   NOT NULL,
  deleted_on   timestamptz NOT NULL DEFAULT now(),
  day          text,
  earned_today int,
  topup_day    text,
  PRIMARY KEY (sid, uhash)
);

CREATE TABLE play_tables (
  id            text PRIMARY KEY,
  game          text NOT NULL CHECK (game IN ('holdem','rig')),
  room          text NOT NULL,
  space_id      text NOT NULL,
  sid           bigint NOT NULL REFERENCES play_spaces(sid),
  owner         text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opts          jsonb NOT NULL DEFAULT '{}',
  state         jsonb,
  version       bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  closed_reason text,
  summary       jsonb
);
CREATE UNIQUE INDEX play_tables_one_open ON play_tables (room, game) WHERE status = 'open';
CREATE TABLE play_seats (
  table_id  text   NOT NULL REFERENCES play_tables(id),
  wid       text   NOT NULL,
  sid       bigint NOT NULL REFERENCES play_spaces(sid),
  active    boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz
);
CREATE UNIQUE INDEX play_seats_one_active ON play_seats (wid) WHERE active;
CREATE TABLE play_games (
  id          text PRIMARY KEY,
  table_id    text   NOT NULL REFERENCES play_tables(id),
  sid         bigint NOT NULL REFERENCES play_spaces(sid),
  kind        text   NOT NULL CHECK (kind IN ('hand','round')),
  n           int    NOT NULL,
  disposition text   NOT NULL DEFAULT 'open' CHECK (disposition IN ('open','settled','voided')),
  version     bigint NOT NULL DEFAULT 0,
  log         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX play_games_one_open ON play_games (table_id) WHERE disposition = 'open';
CREATE TABLE play_ops (
  table_id text NOT NULL,
  wid      text NOT NULL,
  op_id    text NOT NULL,
  answer   jsonb NOT NULL,
  PRIMARY KEY (table_id, wid, op_id)
);
`;

// 2 (additive): one active seat per PERSON across spaces (a salted per-person key, never the Matrix id)
const V2 = `
ALTER TABLE play_seats ADD COLUMN person text;
CREATE UNIQUE INDEX play_seats_one_per_person ON play_seats (person) WHERE active AND person IS NOT NULL;
`;
const MIGRATIONS = [[1, V1], [2, V2]];

export function createPool(env = process.env) {
    // On a Tin Hat Server: Postgres's unix socket shared into the API container (/var/run/postgresql), role tinhat_play,
    // password from /var/lib/tinhat/api/play-db.secret (the manager writes PLAY_DB_PASSWORD_FILE). Lab/tests: PLAY_DB_URL.
    if (env.PLAY_DB_URL) return new pg.Pool({ connectionString: env.PLAY_DB_URL, max: 8 });
    return new pg.Pool({ host: env.PLAY_DB_HOST || "/var/run/postgresql", database: env.PLAY_DB_NAME || "tinhat_play", user: env.PLAY_DB_USER || "tinhat_play", password: env.PLAY_DB_PASSWORD || undefined, max: 8 });
}

/** Bring the schema to SCHEMA_VERSION (additive steps only, each in its own transaction, under an advisory lock). */
export async function migrate(pool) {
    const c = await pool.connect();
    try {
        await c.query("SELECT pg_advisory_lock(hashtext('tinhat_play:migrate'))");
        await c.query("CREATE TABLE IF NOT EXISTS play_schema (version int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())");
        const { rows } = await c.query("SELECT COALESCE(MAX(version), 0) AS v FROM play_schema");
        let have = Number(rows[0].v);
        for (const [v, sql] of MIGRATIONS) {
            if (v <= have) continue;
            await c.query("BEGIN");
            try { await c.query(sql); await c.query("INSERT INTO play_schema (version) VALUES ($1)", [v]); await c.query("COMMIT"); have = v; }
            catch (e) { await c.query("ROLLBACK"); throw e; }
        }
        return have;
    } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext('tinhat_play:migrate'))").catch(() => {});
        c.release();
    }
}

/** Run fn(client) in one transaction; retried on serialization failures / deadlocks / a lost compare-and-set. */
export class Conflict extends Error { constructor(m = "conflict") { super(m); this.code = "conflict"; } }
export async function inTx(pool, fn, { tries = 5 } = {}) {
    for (let i = 0; ; i++) {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            const out = await fn(c);
            await c.query("COMMIT");
            return out;
        } catch (e) {
            await c.query("ROLLBACK").catch(() => {});
            const retry = e instanceof Conflict || e.code === "40001" || e.code === "40P01" || (e.code === "23505" && e.retryable);
            if (!retry || i + 1 >= tries) throw e;
        } finally { c.release(); }
    }
}
