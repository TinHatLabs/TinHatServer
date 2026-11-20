"""The mini games' server side in the manager (GAMES-V1-SPEC §1, §2.7; docs/PLAY.md): the switches and the two
admin-tweakable numbers, the API's PLAY_* environment, the well-known flags, the games database (`tinhat_play`, its own
role; G9: it can read nothing of Synapse's, checked by `scan`) and the console (`tinhat play …`).

Every default lives in PLAY_DEFAULTS, so a different product decision (e.g. The Rig shown in the phone apps) is one line.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets as _secrets

from . import state

log = logging.getLogger("tinhat.play")

#: the decided defaults: games OFF until the owner turns them on (spec §79; launch-gate 13:57, the 0.3.20 release); day
#: max 8 and start 10, admin-tweakable; The Rig hidden in the phone apps (one value here).
PLAY_DEFAULTS = {"enabled": False, "rig_phone_apps": False, "day_max": 8, "start": 10}
#: §2.7 bounds (the API keeps its own default for anything outside them: rules.mjs TWEAKABLE)
BOUNDS = {"day_max": (1, 24), "start": (0, 50)}
#: How the API reaches the games database. "loopback-tcp": Postgres published on the box's loopback only, the API
#: connects over TCP as `tinhat_play` with its password (the image's `host all all all scram-sha-256` line). The spec's
#: shared unix socket would hand the API the synapse superuser (the image trusts every local socket connection).
PLAY_DB_ACCESS = "loopback-tcp"
#: The loopback port Postgres is published on for the API (compose.yaml `${TINHAT_PLAY_DB_PORT:-5433}`): 5433, unless
#: something else on this machine already listens there (the Linux and Docker Compose editions run on the owner's own
#: machine, which may run a Postgres of its own: a taken port would stop the database container, and with it the
#: server). Chosen ONCE (db_port), kept in the state, written to compose.env and the API's env from that one value.
PLAY_DB_PORT = 5433
PLAY_DB_PORTS_SPARE = range(54330, 54350)
ROLE = "tinhat_play"
DATABASE = "tinhat_play"
_PW = re.compile(r"[A-Za-z0-9_-]{16,256}")


def settings(st: dict | None = None) -> dict:
    """The owner's game settings over the defaults: {enabled, rig_phone_apps, day_max, start}."""
    st = st if st is not None else state.load_state()
    p = st.get("play") if isinstance(st.get("play"), dict) else {}
    out = dict(PLAY_DEFAULTS)
    for k in ("enabled", "rig_phone_apps"):
        if isinstance(p.get(k), bool):
            out[k] = p[k]
    for k, (lo, hi) in BOUNDS.items():
        v = p.get(k)
        if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi:
            out[k] = v
    return out


def check(name: str, value) -> tuple[object | None, str]:
    """A value for one setting, or (None, why) — the console and the dashboard refuse anything out of bounds."""
    if name in ("enabled", "rig_phone_apps"):
        if isinstance(value, bool):
            return value, ""
        if str(value).strip().lower() in ("on", "true", "yes", "1"):
            return True, ""
        if str(value).strip().lower() in ("off", "false", "no", "0"):
            return False, ""
        return None, f"{name} is on or off"
    if name in BOUNDS:
        lo, hi = BOUNDS[name]
        s = str(value).strip()
        if not re.fullmatch(r"\d{1,3}", s) or not lo <= int(s) <= hi:
            return None, f"{name} is a whole number from {lo} to {hi}"
        return int(s), ""
    return None, f"{name} isn't a game setting (day_max, start, enabled, rig_phone_apps)"


def save(changes: dict, who: str = "console") -> dict:
    """Store checked settings; one log line per change (who, old, new). Never retroactive: nothing in the journal changes."""
    st = state.load_state()
    cur = dict(st.get("play") if isinstance(st.get("play"), dict) else {})
    before = settings(st)
    for k, v in changes.items():
        if v is None:
            cur.pop(k, None)
        else:
            cur[k] = v
    st2 = state.save_state(play=cur)
    after = settings(st2)
    for k in PLAY_DEFAULTS:
        if before[k] != after[k]:
            log.info("games setting %s: %s -> %s (by %s)", k, before[k], after[k], who)
    return after


def _bindable(port: int) -> bool:
    """Docker could publish 127.0.0.1:port now: nothing has it bound (listening or not)."""
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _published_by_us() -> int | None:
    """The loopback port our own database container publishes now (a box that ran a games build before), or None.
    One docker call, bounded: this runs inside the updater's after-update."""
    import subprocess
    try:
        r = subprocess.run(["docker", "port", "tinhat-postgres-1", "5432/tcp"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    for w in r.stdout.split() if r.returncode == 0 else []:
        host, _, port = w.rpartition(":")
        if host == "127.0.0.1" and port.isdigit():
            return int(port)
    return None


def _valid_port(p) -> bool:
    return isinstance(p, int) and not isinstance(p, bool) and (p == PLAY_DB_PORT or p in PLAY_DB_PORTS_SPARE or 40000 <= p <= 49151)


def db_port(st: dict | None = None) -> int:
    """The games database's loopback port, chosen ONCE and kept: 5433 when Docker could publish it (or it is already
    ours), else the first free spare (54330-54349, then 20 random ones in 40000-49151). Decided under a lock from the
    stored state (never a caller's snapshot), so compose.env and the API's env always name the same port. When nothing
    is free it returns 0 and stores nothing: Docker then picks a port for the database container itself (Synapse keeps
    working), the API gets no games database (games unavailable, logged) and the next run tries again. Never a port
    known to be taken: that would stop the database container and the whole server."""
    import fcntl
    import random
    from . import config
    del st  # (the stored state is the authority; a caller's snapshot may predate the choice)
    import time
    try:
        fh = open(config.STATE_DIR / ".play-port.lock", "a+")
    except OSError as e:
        log.error("games database: no port lock (%s); the games stay unavailable for now", e)
        return 0
    with fh:
        for _ in range(100):  # at most ~10 s: a stuck holder must never stall an update's after-update
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.1)
        else:
            cur = state.load_state().get("play_db_port")
            log.warning("games database: the port lock is held elsewhere; using the stored choice (%s)", cur)
            return cur if _valid_port(cur) else 0
        cur = state.load_state().get("play_db_port")
        ours = _published_by_us()
        # the stored choice stays while it is still ours or still free; something else took it since (the owner's own
        # Postgres on their machine, started after ours): choose again, or the next start couldn't publish it
        if _valid_port(cur) and (cur == ours or _bindable(cur)):
            return cur
        if _valid_port(cur):
            log.warning("games database: 127.0.0.1:%s is taken by something else now; choosing another port", cur)
        for cand in (PLAY_DB_PORT, *PLAY_DB_PORTS_SPARE, *random.sample(range(40000, 49152), 20)):
            if cand == ours or _bindable(cand):
                state.save_state(play_db_port=cand)
                if cand != PLAY_DB_PORT:
                    log.info("games database: 127.0.0.1:%s is taken on this machine, using %s", PLAY_DB_PORT, cand)
                return cand
    log.error("games database: no free loopback port; the games stay unavailable (the next start tries again)")
    return 0


# ---- G9 block: a finding takes the games off until a later check is clean -------------------------------------------

#: the reason while no clean G9 pass is recorded on THIS server yet (a fresh box before the manager's first pass, a box
#: restored from a backup): fail closed, the advertisement never says on before the check has passed here
NOT_YET = "the safety check (G9) hasn't passed on this server yet: the games database is still being prepared"


def blocked(st: dict | None = None) -> str:
    """Why the games are blocked: a stored G9 finding, or NOT_YET while no clean pass is recorded; "" = not blocked."""
    st = st if st is not None else state.load_state()
    v = st.get("play_g9_block")
    if isinstance(v, str) and v:
        return v
    ok = st.get("play_g9_ok")
    return "" if isinstance(ok, int) and not isinstance(ok, bool) and ok > 0 else NOT_YET


def block_note(st: dict | None = None) -> str:
    """One line for the console when a G9 block stands: why, since when, and what lifts it ("" when not blocked)."""
    import time as _t
    st = st if st is not None else state.load_state()
    why = blocked(st)
    if not why:
        return ""
    if why == NOT_YET:
        return ("The games are OFF until the safety check (G9) has passed on this server: the games database is still "
                "being prepared. The manager checks every minute; `tinhat play db` checks now.")
    at = st.get("play_g9_block_at")
    since = _t.strftime("%Y-%m-%d %H:%M", _t.localtime(at)) if isinstance(at, int) else "an earlier check"
    return (f"The games are OFF: blocked by G9 since {since} ({why[:200]}). The manager checks again every minute and "
            "lifts the block once the check is clean; `tinhat play db` checks again now.")


def effective(st: dict | None = None) -> bool:
    """The games are on: the owner's switch, a clean G9 pass recorded on this server, and no G9 finding since."""
    st = st if st is not None else state.load_state()
    return bool(settings(st)["enabled"]) and not blocked(st)


def features(st: dict | None = None) -> dict:
    """The well-known's flags (§1 "Switches"): the apps show games only on an explicit play: true."""
    p = settings(st)
    return {"play": effective(st), "play_rig_phone_apps": bool(p["rig_phone_apps"])}


def password(s: dict | None = None) -> str:
    """The games role's password: generated once and kept in the secrets (like the database's own)."""
    for src in ((s,) if s is not None else ()) + (None,):
        cur = (src if src is not None else state.load_secrets()).get("play_db_password")
        if isinstance(cur, str) and _PW.fullmatch(cur):
            return cur
    pw = _secrets.token_urlsafe(24)
    state.save_secrets(play_db_password=pw)
    return pw


def env_lines(st: dict | None = None, s: dict | None = None) -> dict:
    """The API's PLAY_* environment (apiconf.env_text)."""
    from . import apiconf
    st = st if st is not None else state.load_state()
    p = settings(st)
    tz = (st.get("updates") or {}).get("tz")
    try:
        port = db_port()
    except Exception:  # noqa: BLE001 — never fails a config write: no games database for now
        log.exception("games database: choosing the port")
        port = 0
    lines = {
        "PLAY_ENABLED": "1" if effective(st) else "0",
        "PLAY_RIG_PHONE_APPS": "1" if p["rig_phone_apps"] else "0",
        "PLAY_DAY_MAX": str(p["day_max"]),
        "PLAY_START": str(p["start"]),
        "PLAY_DB_HOST": "127.0.0.1",
        "PLAY_DB_PORT": str(port),
        "PLAY_DB_NAME": DATABASE,
        "PLAY_DB_USER": ROLE,
        "PLAY_DB_PASSWORD_FILE": "/conf/play-db.secret",
    }
    if not port:  # no free loopback port: no games database for the API (db_port); the games stay off, Synapse runs
        for k in ("PLAY_DB_HOST", "PLAY_DB_PORT", "PLAY_DB_NAME", "PLAY_DB_USER", "PLAY_DB_PASSWORD_FILE"):
            lines.pop(k)
    if isinstance(tz, str) and re.fullmatch(r"[A-Za-z0-9_+/-]{1,63}", tz):
        lines["PLAY_TZ"] = tz
    rec = apiconf.recorder(st)
    if rec and re.fullmatch(r"@[^\s:]+:[^\s]+", rec):
        lines["RECORDER_USER"] = rec  # the Memories recorder never gets a wallet (§2.2)
    return lines


#: The role and the database, idempotent; the password arrives as a psql variable (never pasted into SQL). A games
#: restore interrupted between its two renames (playdb.load) left the old database as tinhat_play_prev: it comes back.
ENSURE_SQL = """\
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \\gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', 'tinhat_play_prev', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') AND EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tinhat_play_prev') \\gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C'' TEMPLATE template0', :'db', :'role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \\gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'role') \\gexec
"""
#: (No REVOKE CONNECT on synapse FROM PUBLIC: dropped from the 0.3.20 release by launch-gate 14:06. The role may CONNECT
#: to synapse like any role, and SCAN_SQL proves it can read nothing there: G9.)

#: G9 (launch-gate 14:06): every way the games role could read or change data in Synapse's database, run IN a database
#: as its owner with :'role' = the games role (play.scan runs it in `synapse`, and the parts marked [every db] also in
#: the games database itself, where the role owns its own tables by design). One row per finding:
#: kind|object|privileges. No row = clean. It reports, in every user schema: tables / views / materialized and foreign
#: tables (any table privilege incl. MAINTAIN, and column privileges), sequences, every routine it may execute that
#: doesn't return `trigger` (functions AND procedures, any prokind: launch-gate 14:42) or is SECURITY DEFINER, CREATE on
#: a schema; in the system catalogs: any
#: relation it may read and any function it may execute that PUBLIC may NOT (pg_statistic, pg_read_binary_file …: a
#: catalog every role reads by design is not a finding); anything it OWNS (relations, schemas, functions, types, the
#: database) and CREATE on the database; default privileges that would hand it (or PUBLIC) future tables or sequences;
#: [every db] foreign servers / wrappers it may use and user mappings for it or PUBLIC (dblink, postgres_fdw);
#: [every db] large objects it owns or may read, and lo_compat_privileges on (the setting, or a role/database override);
#: [every db] a parameter it was granted SET / ALTER SYSTEM on; any role membership (pg_read_all_data,
#: pg_read_server_files …); the role being a superuser, bypassing row security or allowed replication.
#: The databases G9 scans: synapse, and every other one the games role may connect to (CASE: a missing role must not error).
SCAN_DBS_SQL = """\
SELECT datname FROM pg_database
WHERE datallowconn AND (datname = 'synapse' OR CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
                                                    THEN has_database_privilege(:'role', datname, 'CONNECT') ELSE false END)
ORDER BY datname = 'synapse' DESC, datname;
"""
SCAN_SQL = """\
WITH r AS (SELECT oid, rolname, rolsuper, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = :'role'),
ns AS (SELECT oid, nspname FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname !~ '^pg_(toast|temp_|toast_temp_)'),
sys AS (SELECT oid, nspname FROM pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')),
-- PUBLIC's own rights (NULL ACL = the default: PUBLIC may read a relation only when the ACL says so; it may execute
-- a function by default)
pub_rel AS (SELECT c.oid FROM pg_class c
            WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0 AND a.privilege_type = 'SELECT')),
pub_fn AS (SELECT p.oid FROM pg_proc p
           WHERE p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
SELECT 'role' AS kind, r.rolname::text AS object, 'superuser' AS privileges FROM r WHERE r.rolsuper
UNION ALL SELECT 'role', r.rolname, 'bypassrls' FROM r WHERE r.rolbypassrls
UNION ALL SELECT 'role', r.rolname, 'replication' FROM r WHERE r.rolreplication
UNION ALL SELECT 'membership', g.rolname, 'member' FROM r JOIN pg_auth_members m ON m.member = r.oid JOIN pg_roles g ON g.oid = m.roleid
UNION ALL SELECT 'table', format('%I.%I', ns.nspname, c.relname),
       array_to_string(ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
                             WHERE has_table_privilege((SELECT oid FROM r), c.oid, p)), ',')
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f')
    AND has_table_privilege((SELECT oid FROM r), c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    AND current_database() <> :'role'
UNION ALL SELECT 'columns', format('%I.%I', ns.nspname, c.relname), 'column privileges'
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f') AND current_database() <> :'role'
    AND NOT has_table_privilege((SELECT oid FROM r), c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    AND has_any_column_privilege((SELECT oid FROM r), c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
UNION ALL SELECT 'sequence', format('%I.%I', ns.nspname, c.relname),
       array_to_string(ARRAY(SELECT p FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p
                             WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege((SELECT oid FROM r), c.oid, p) END), ',')
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  -- (CASE: the planner may test the privilege before relkind, and has_sequence_privilege errors on anything else)
  WHERE c.relkind = 'S' AND current_database() <> :'role'
    AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege((SELECT oid FROM r), c.oid, 'USAGE,SELECT,UPDATE') ELSE false END
-- launch-gate 14:42, exact: every routine it can EXECUTE (functions AND procedures, any prokind) returns `trigger`
-- (a trigger function can't be called directly); a SECURITY DEFINER one is a finding even then
UNION ALL SELECT 'function', format('%I.%s', ns.nspname, p.oid::regprocedure::text),
       'EXECUTE (' || CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window function' ELSE 'function' END
       || CASE WHEN p.prosecdef THEN ', security definer' ELSE '' END || ')'
  FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
  WHERE current_database() <> :'role' AND has_function_privilege((SELECT oid FROM r), p.oid, 'EXECUTE')
    AND (p.prosecdef OR p.prorettype IS DISTINCT FROM 'trigger'::regtype)
UNION ALL SELECT 'schema', format('%I', ns.nspname), 'CREATE'
  FROM ns WHERE current_database() <> :'role' AND has_schema_privilege((SELECT oid FROM r), ns.oid, 'CREATE')
UNION ALL SELECT 'catalog', format('%I.%I', sys.nspname, c.relname), 'SELECT (PUBLIC may not, or a sensitive catalog)'
  FROM pg_class c JOIN sys ON sys.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m') AND has_table_privilege((SELECT oid FROM r), c.oid, 'SELECT')
    AND (c.oid NOT IN (SELECT oid FROM pub_rel)
         OR (sys.nspname = 'pg_catalog' AND c.relname IN ('pg_statistic', 'pg_statistic_ext_data', 'pg_authid',
             'pg_user_mapping', 'pg_largeobject', 'pg_subscription', 'pg_shadow')))
UNION ALL SELECT 'catalog function', p.oid::regprocedure::text, 'EXECUTE (PUBLIC may not, or a file/large-object function)'
  FROM pg_proc p JOIN sys ON sys.oid = p.pronamespace
  WHERE has_function_privilege((SELECT oid FROM r), p.oid, 'EXECUTE')
    AND (p.oid NOT IN (SELECT oid FROM pub_fn)
         OR (sys.nspname = 'pg_catalog' AND p.proname IN ('pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
             'lo_import', 'lo_export', 'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_tmpdir', 'pg_ls_archive_statusdir',
             'pg_ls_logicalsnapdir', 'pg_ls_logicalmapdir', 'pg_ls_replslotdir', 'pg_file_write', 'pg_logdir_ls')))
UNION ALL SELECT 'owns', format('%s %I.%I', CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END, n.nspname, c.relname), 'owner'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relowner = (SELECT oid FROM r) AND current_database() <> :'role'
UNION ALL SELECT 'owns', format('schema %I', n.nspname), 'owner' FROM pg_namespace n
  WHERE n.nspowner = (SELECT oid FROM r) AND current_database() <> :'role'
UNION ALL SELECT 'owns', format('function %s', p.oid::regprocedure::text), 'owner' FROM pg_proc p
  WHERE p.proowner = (SELECT oid FROM r) AND current_database() <> :'role'
UNION ALL SELECT 'owns', format('type %s', t.oid::regtype::text), 'owner' FROM pg_type t
  WHERE t.typowner = (SELECT oid FROM r) AND current_database() <> :'role'
UNION ALL SELECT 'database', d.datname, 'owner' FROM pg_database d
  WHERE d.datname = current_database() AND d.datdba = (SELECT oid FROM r) AND current_database() <> :'role'
UNION ALL SELECT 'database', current_database(), 'CREATE'
  WHERE current_database() <> :'role' AND has_database_privilege((SELECT oid FROM r), current_database(), 'CREATE')
UNION ALL SELECT 'default privileges', format('%s in %s for %s', d.defaclobjtype, coalesce(n.nspname, 'every schema'), pg_get_userbyid(d.defaclrole)),
       a.privilege_type || ' to ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE :'role' END
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
  WHERE current_database() <> :'role' AND (a.grantee = (SELECT oid FROM r) OR (a.grantee = 0 AND d.defaclobjtype IN ('r','S','n','L')))
UNION ALL SELECT 'foreign server', s.srvname, 'USAGE' FROM pg_foreign_server s
  WHERE has_server_privilege((SELECT oid FROM r), s.oid, 'USAGE')
UNION ALL SELECT 'foreign data wrapper', w.fdwname, 'USAGE' FROM pg_foreign_data_wrapper w
  WHERE has_foreign_data_wrapper_privilege((SELECT oid FROM r), w.oid, 'USAGE')
UNION ALL SELECT 'user mapping', s.srvname, CASE WHEN u.umuser = 0 THEN 'for PUBLIC' ELSE 'for the role' END
  FROM pg_user_mapping u JOIN pg_foreign_server s ON s.oid = u.umserver WHERE u.umuser IN (0, (SELECT oid FROM r))
UNION ALL SELECT 'large object', m.oid::text, 'owner or SELECT/UPDATE'
  FROM pg_largeobject_metadata m
  WHERE m.lomowner = (SELECT oid FROM r)
     OR EXISTS (SELECT 1 FROM aclexplode(m.lomacl) a WHERE a.grantee IN (0, (SELECT oid FROM r)) AND a.privilege_type IN ('SELECT','UPDATE'))
UNION ALL SELECT 'setting', 'lo_compat_privileges', 'on (this session)' WHERE current_setting('lo_compat_privileges') = 'on'
UNION ALL SELECT 'setting', 'lo_compat_privileges', 'on in ' || f.sourcefile
  FROM pg_file_settings f WHERE f.name = 'lo_compat_privileges' AND f.applied AND lower(f.setting) IN ('on','true','yes','1')
UNION ALL SELECT 'setting', coalesce(pg_get_userbyid(s.setrole), 'every role') || ' in ' || coalesce((SELECT datname FROM pg_database WHERE oid = s.setdatabase), 'every database'), cfg
  FROM pg_db_role_setting s, unnest(s.setconfig) cfg
  WHERE lower(cfg) IN ('lo_compat_privileges=on', 'lo_compat_privileges=true', 'lo_compat_privileges=yes', 'lo_compat_privileges=1')
    AND s.setrole IN (0, (SELECT oid FROM r))
UNION ALL SELECT 'parameter', pa.parname, a.privilege_type FROM pg_parameter_acl pa, aclexplode(pa.paracl) a
  WHERE a.grantee IN (0, (SELECT oid FROM r))
UNION ALL SELECT 'missing', :'role', 'no such role' WHERE NOT EXISTS (SELECT 1 FROM r)
ORDER BY 1, 2;
"""
_ensured = False
_ensured_at = 0.0
RECHECK_S = 3600  # G9 again every hour while the manager runs (a grant planted later is found within the hour)


async def ensure_db(force: bool = False, apply: bool = True) -> tuple[bool, str]:
    """Create/repair the games role and database, then G9 (the manager: once a minute until it works, `tinhat play db`,
    every update's after-update with apply=False). A G9 finding BLOCKS the games (state play_g9_block: the well-known and
    the API's env say off) until a later check is clean; with apply, the changed configs are written and the API is
    recreated once nobody is in a call. (ok, message)."""
    global _ensured, _ensured_at
    import time
    if apply:
        try:
            await apply_pending()
        except Exception as e:  # noqa: BLE001 — a failed restart must never stop the check that can lift a block
            log.warning("games: applying a waiting change failed: %r", e)
    if _ensured and not force and time.monotonic() - _ensured_at < RECHECK_S:
        return True, "already checked"
    _ensured = False
    from . import compose
    pw = password()
    if not _PW.fullmatch(pw):  # (password() only hands out these; the quoting below relies on it)
        return False, "the games role's password has an unexpected form"
    # the password goes in on stdin (`\set`), never on a command line (a process list shows those)
    rc, out = await compose.run("exec", "-T", "postgres", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
                                "-v", f"role={ROLE}", "-v", f"db={DATABASE}", "-U", "synapse", "-d", "postgres",
                                timeout=60, stdin=(f"\\set pw '{pw}'\n" + ENSURE_SQL).encode())
    if rc != 0:
        return False, f"couldn't prepare the games database: {(out or '')[-300:]}"
    found = await scan()
    # fail closed: a check that couldn't run blocks the games like a finding (lifted by the next clean check)
    why = ("G9 couldn't be checked" if found is None else ("G9: " + "; ".join(found[:5]))[:500] if found else "")
    if why != blocked():  # (a first clean pass, too: NOT_YET → "")
        state.save_state(play_g9_block=why or None, play_g9_block_at=(int(time.time()) if why else None),
                         play_g9_ok=(None if why else int(time.time())))
        mark_restart_pending()
        if why:
            log.error("games BLOCKED by G9: %s", "; ".join(found[:20]) if found else why)
        else:
            log.info("G9 clean again: the games are no longer blocked")
        if apply:
            try:
                await apply_pending()
            except Exception as e:  # noqa: BLE001
                log.warning("games: applying the G9 change failed: %r", e)
    if found is None:
        return False, "the games database is ready, but G9 couldn't be checked: the games stay off until it can be"
    if found:
        return False, "G9 FAILED (the games are off until it is clean): the games role can read or change: " + "; ".join(found[:20])
    _ensured, _ensured_at = True, time.monotonic()
    return True, "the games database is ready (G9: the games role can read nothing of Synapse's)"


async def scan() -> list[str] | None:
    """G9: SCAN_SQL in Synapse's database, and in the games database (where only its [every db] parts apply: foreign
    servers and mappings, large objects, settings, parameter grants, memberships). [] = nothing, None = couldn't ask."""
    from . import compose
    # every database the role could connect to (synapse, its own, postgres, template1 …): a foreign server or mapping
    # in any of them is a way into Synapse's data
    rc, out = await compose.run("exec", "-T", "postgres", "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", f"role={ROLE}",
                                "-U", "synapse", "-d", "postgres", timeout=30, stdin=SCAN_DBS_SQL.encode())
    if rc != 0:
        log.warning("G9 scan: the database list: %s", (out or "")[-300:])
        return None
    dbs = [d.strip() for d in (out or "").splitlines() if re.fullmatch(r"[A-Za-z0-9_]{1,63}", d.strip())] or ["synapse"]
    out_all = []
    for db in dbs[:20]:
        rc, out = await compose.run("exec", "-T", "postgres", "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
                                    "-v", f"role={ROLE}", "-U", "synapse", "-d", db, timeout=60, stdin=SCAN_SQL.encode())
        if rc != 0:
            log.warning("G9 scan in %s: %s", db, (out or "")[-300:])
            return None
        out_all += [(l.strip() if db == "synapse" else f"{l.strip()} (in {db})") for l in (out or "").splitlines() if l.strip()]
    return out_all


def mark_restart_pending() -> None:
    """The API must be recreated to pick up a changed games env (the switch during a call, a G9 block or its end)."""
    state.save_state(play_api_restart=True)


async def apply_pending() -> bool:
    """Write the configs and recreate the API if a games change is waiting and nobody is in a call. True when done or
    nothing waited."""
    if not state.load_state().get("play_api_restart"):
        return True
    if await call_live():
        return False
    from . import apiconf, compose, install
    apiconf.write()
    await install.refresh_configs_locked()
    if await call_live():  # a call started while the configs were written: wait for it
        return False
    rc, out = await compose.run("up", "-d", "--no-build", "--pull", "never", "--force-recreate", "api", timeout=180)
    if rc != 0:
        log.warning("games: the API didn't restart: %s", (out or "")[-300:])
        return False
    state.save_state(play_api_restart=None)
    log.info("games: the API restarted with the changed games settings")
    return True


async def call_live() -> bool:
    """True when someone is in a call, or LiveKit can't say (the switch restarts the API, which hands out call tokens)."""
    from . import lkadmin
    return await lkadmin.call_in_progress() is not False


IN_CALL = ("People are in a call right now (or the call server didn't answer). Changing the games settings restarts the "
           "Tin Hat API, which hands out call tokens, so it waits: try again when the call has ended.")


def cli(args: list[str]) -> int:
    """`tinhat play config [NAME=VALUE … | --reset NAME …]` | `tinhat play db` (prepare the database again) |
    `tinhat play audit` (the ledger's invariants, read-only)."""
    if args[:1] == ["lab-grant"]:  # LAB ONLY: the API refuses it unless its environment marks a lab box (TINHAT_LAB set to "1")
        from . import compose
        if len(args) != 4:
            print("usage: tinhat play lab-grant !space:server @user:server N   (lab boxes only)")
            return 2
        rc, out = asyncio.run(compose.run("exec", "-T", "api", "node", "play/lab-grant-cli.mjs", *args[1:], timeout=60))
        print((out or "").strip())
        return 0 if rc == 0 else 1
    if args[:1] == ["scan"]:  # G9, read-only
        found = asyncio.run(scan())
        if found is None:
            print("couldn't run the check (is the database up?)")
            return 1
        print("G9: the games role can read nothing of Synapse's" if not found else "G9 FAILED:\n" + "\n".join(found))
        if note := block_note():  # (games-gates 15:48: a clean scan doesn't lift a block by itself: say so)
            print(("Clean now, but: " if not found else "") + note)
        return 0 if not found else 1
    if args[:1] == ["audit"]:
        from . import compose
        rc, out = asyncio.run(compose.run("exec", "-T", "api", "node", "play/audit-cli.mjs", timeout=120))
        print((out or "").strip())
        return 0 if rc == 0 else 1
    if not args or args[0] not in ("config", "db"):
        print("usage: tinhat play config [day_max=N start=N enabled=on|off rig_phone_apps=on|off | --reset NAME …]\n"
              "       tinhat play db     (prepare the games database again, then the G9 check)\n"
              "       tinhat play scan   (G9: what the games role could read in Synapse's database; read-only)\n"
              "       tinhat play audit  (check the chip ledger's invariants)")
        return 2
    if args[0] == "db":
        ok, msg = asyncio.run(ensure_db(force=True))
        print(msg)
        return 0 if ok else 1
    rest = args[1:]
    cur = settings()
    if not rest:
        st = state.load_state()
        set_ = st.get("play") if isinstance(st.get("play"), dict) else {}
        for k in PLAY_DEFAULTS:
            v = cur[k]
            shown = ("on" if v else "off") if isinstance(v, bool) else v
            print(f"{k}={shown}" + ("" if k in set_ else " (default)"))
        return 0
    changes: dict = {}
    if rest[0] == "--reset":
        for name in rest[1:]:
            if name not in PLAY_DEFAULTS:
                print(f"{name} isn't a game setting (day_max, start, enabled, rig_phone_apps)")
                return 2
            changes[name] = None
    else:
        for a in rest:
            name, eq, value = a.partition("=")
            if not eq:
                print(f"{a}: use NAME=VALUE")
                return 2
            v, why = check(name, value)
            if v is None:
                print(f"{a}: {why}")
                return 2
            changes[name] = v
    if asyncio.run(call_live()):  # nothing saved: the change and the API restart wait for the call to end
        print(IN_CALL)
        return 3
    after = save(changes, "console")
    from . import apiconf, compose, install
    apiconf.write()
    asyncio.run(install.refresh_configs_locked())  # the well-known's flags (under the web server's settings lock)
    if asyncio.run(call_live()):  # a call started meanwhile: the manager restarts the API once it has ended
        mark_restart_pending()
        print("Saved. A call started meanwhile, so the API restarts (and the change takes effect) when it has ended.")
        return 0
    rc, out = asyncio.run(compose.run("up", "-d", "--no-build", "--pull", "never", "--force-recreate", "api", timeout=180))
    if rc != 0:
        print(f"Saved, but the API didn't restart:\n{(out or '')[-600:]}")
        return 1
    print(" ".join(f"{k}={('on' if v else 'off') if isinstance(v, bool) else v}" for k, v in after.items()))
    if after.get("enabled") and (note := block_note()):  # saved, but not in effect: never a silent "on" (games-gates 15:48)
        print("Saved, but " + note[0].lower() + note[1:])
        return 4
    return 0
