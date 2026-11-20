"""G9 (launch-gate 2026-11-19 14:06): the games role, connecting to Synapse's database, can read NOTHING there. The
manager's check (play.SCAN_SQL, run by `tinhat play scan` and after every games-database preparation) against a real
Postgres loaded with Synapse's real schema (fixtures/synapse-schema-1.145-th4.sql, dumped from a lab box): clean with
the defaults every server has (PUBLIC may CONNECT and use the public schema; Synapse's trigger functions are invoker
functions), and each planted grant is found (the controls that show the check can fail): a table, one column, a
sequence, PUBLIC on a table, CREATE on the schema, pg_read_all_data, a SECURITY DEFINER function, BYPASSRLS.

Needs a throwaway Postgres 17: PLAY_TEST_PGHOST / PLAY_TEST_PGPORT / PLAY_TEST_PGUSER (a superuser) and a client:
PLAY_TEST_PSQL (the psql binary) or, where no psql is installed, PLAY_TEST_PG_MODULE (the `pg` package's entry point;
fixtures/pgrun.mjs then stands in for psql, with psql's own `:'name'` quoting). Skipped without them."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))

from tinhat import play  # noqa: E402

PSQL = os.environ.get("PLAY_TEST_PSQL")
PG_MODULE = os.environ.get("PLAY_TEST_PG_MODULE")
PGRUN = Path(__file__).resolve().parent / "fixtures" / "pgrun.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "synapse-schema-1.145-th4.sql"
DB = f"g9_synapse_{os.getpid()}"
ROLE = f"g9_play_{os.getpid()}"
ADMIN = os.environ.get("PLAY_TEST_PGUSER", "postgres")


def psql(*args, db="postgres", stdin: str | None = None, check=True) -> str:
    """psql -X -q -v ON_ERROR_STOP=1 -d db ARGS (-At, -v k=v, -c SQL, -f FILE), or pgrun.mjs with the same meaning."""
    env = {**os.environ, "PGHOST": os.environ.get("PLAY_TEST_PGHOST", ""), "PGPORT": os.environ.get("PLAY_TEST_PGPORT", ""),
           "PGUSER": os.environ.get("PLAY_TEST_PGUSER", "")}
    if PSQL:
        cmd = [PSQL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, *args]
    else:
        env["PGDATABASE"] = db
        cmd, rest = ["node", str(PGRUN)], list(args)
        while rest:
            a = rest.pop(0)
            if a == "-v":
                cmd += ["-v", rest.pop(0)]
            elif a == "-c":
                stdin = rest.pop(0)
            elif a == "-f":
                stdin = Path(rest.pop(0)).read_text()
            # -At: pgrun prints that way already
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, env=env, timeout=300)
    if check and r.returncode != 0:
        raise AssertionError(f"psql {args}: {r.stderr[-500:]}")
    return r.stdout


@unittest.skipUnless(PSQL or PG_MODULE, "set PLAY_TEST_PSQL or PLAY_TEST_PG_MODULE (+ PLAY_TEST_PGHOST/PGPORT/PGUSER): a throwaway Postgres 17")
class G9(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        psql("-c", f"DROP DATABASE IF EXISTS {DB}")
        psql("-c", f"DROP ROLE IF EXISTS {ROLE}")
        psql("-c", f"CREATE DATABASE {DB} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0")
        psql("-f", str(FIXTURE), db=DB)
        # the games role exactly as play.ENSURE_SQL makes it
        psql("-c", f"CREATE ROLE {ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION")
        # a foreign data wrapper + server nobody may use (the stock state where dblink/postgres_fdw are installed)
        psql("-c", "CREATE FOREIGN DATA WRAPPER g9fdw; CREATE SERVER g9srv FOREIGN DATA WRAPPER g9fdw", db=DB)
        # the games database itself: named like the role and owned by it, with its own table (play.ENSURE_SQL's shape)
        psql("-c", f"DROP DATABASE IF EXISTS {ROLE}")
        psql("-c", f"CREATE DATABASE {ROLE} OWNER {ROLE} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0")
        psql("-c", f"REVOKE ALL ON DATABASE {ROLE} FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE {ROLE} TO {ROLE}")
        psql("-c", f"SET ROLE {ROLE}; CREATE TABLE play_entries (tx uuid, delta bigint); CREATE SEQUENCE play_seq", db=ROLE)

    @classmethod
    def tearDownClass(cls):
        psql("-c", f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)", check=False)
        psql("-c", f"DROP DATABASE IF EXISTS {ROLE} WITH (FORCE)", check=False)
        psql("-c", f"REVOKE SET ON PARAMETER lo_compat_privileges FROM {ROLE}", check=False)
        psql("-c", f"DROP ROLE IF EXISTS {ROLE}", check=False)

    def scan(self) -> list[str]:
        return [l for l in psql("-At", "-v", f"role={ROLE}", db=DB, stdin=play.SCAN_SQL).splitlines() if l.strip()]

    def test_the_fixture_is_synapse(self):
        n = psql("-At", "-c", "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'", db=DB).strip()
        self.assertGreater(int(n), 150, "Synapse's real schema loaded")

    def test_clean_with_every_servers_defaults(self):
        self.assertEqual(self.scan(), [])

    def test_each_planted_grant_is_found_and_the_scan_is_clean_again_after(self):
        fn = psql("-At", "-c", "SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                               "WHERE n.nspname = 'public' ORDER BY 1 LIMIT 1", db=DB).strip()
        seq = psql("-At", "-c", "SELECT 'public.' || relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                "WHERE n.nspname = 'public' AND relkind = 'S' ORDER BY 1 LIMIT 1", db=DB).strip()
        self.assertTrue(fn and seq)
        plants = [
            ("table", f"GRANT SELECT ON public.users TO {ROLE}", f"REVOKE SELECT ON public.users FROM {ROLE}", "public.users"),
            ("columns", f"GRANT SELECT (name) ON public.users TO {ROLE}", f"REVOKE SELECT (name) ON public.users FROM {ROLE}", "public.users"),
            ("table", "GRANT SELECT ON public.access_tokens TO PUBLIC", "REVOKE SELECT ON public.access_tokens FROM PUBLIC", "public.access_tokens"),
            ("sequence", f"GRANT USAGE ON SEQUENCE {seq} TO {ROLE}", f"REVOKE USAGE ON SEQUENCE {seq} FROM {ROLE}", seq),
            ("schema", f"GRANT CREATE ON SCHEMA public TO {ROLE}", f"REVOKE CREATE ON SCHEMA public FROM {ROLE}", "public"),
            ("membership", f"GRANT pg_read_all_data TO {ROLE}", f"REVOKE pg_read_all_data FROM {ROLE}", "pg_read_all_data"),
            ("function", f"ALTER FUNCTION {fn} SECURITY DEFINER", f"ALTER FUNCTION {fn} SECURITY INVOKER", "public."),
            ("role", f"ALTER ROLE {ROLE} BYPASSRLS", f"ALTER ROLE {ROLE} NOBYPASSRLS", ROLE),
            # astra's round on 371aeb2..eac6887:
            ("catalog function", f"GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) TO {ROLE}",
             f"REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) FROM {ROLE}", "pg_read_binary_file"),
            ("catalog", f"GRANT SELECT ON pg_catalog.pg_statistic TO {ROLE}", f"REVOKE SELECT ON pg_catalog.pg_statistic FROM {ROLE}", "pg_statistic"),
            ("owns", f"ALTER TABLE public.users OWNER TO {ROLE}; REVOKE ALL ON public.users FROM {ROLE}",
             f"ALTER TABLE public.users OWNER TO {ADMIN}", "public.users"),
            ("database", f"GRANT CREATE ON DATABASE {DB} TO {ROLE}", f"REVOKE CREATE ON DATABASE {DB} FROM {ROLE}", DB),
            ("default privileges", f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO {ROLE}",
             f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM {ROLE}", "in public"),
            ("default privileges", "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
             "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC", "every schema"),
            ("table", f"GRANT MAINTAIN ON public.users TO {ROLE}", f"REVOKE MAINTAIN ON public.users FROM {ROLE}", "public.users"),
            ("role", f"ALTER ROLE {ROLE} REPLICATION", f"ALTER ROLE {ROLE} NOREPLICATION", ROLE),
            ("foreign server", f"GRANT USAGE ON FOREIGN SERVER g9srv TO {ROLE}", f"REVOKE USAGE ON FOREIGN SERVER g9srv FROM {ROLE}", "g9srv"),
            ("foreign data wrapper", f"GRANT USAGE ON FOREIGN DATA WRAPPER g9fdw TO {ROLE}",
             f"REVOKE USAGE ON FOREIGN DATA WRAPPER g9fdw FROM {ROLE}", "g9fdw"),
            ("user mapping", f"CREATE USER MAPPING FOR {ROLE} SERVER g9srv", f"DROP USER MAPPING FOR {ROLE} SERVER g9srv", "g9srv"),
            ("user mapping", "CREATE USER MAPPING FOR PUBLIC SERVER g9srv", "DROP USER MAPPING FOR PUBLIC SERVER g9srv", "g9srv"),
            ("setting", f"ALTER DATABASE {DB} SET lo_compat_privileges = on", f"ALTER DATABASE {DB} RESET lo_compat_privileges", DB),
            ("parameter", f"GRANT SET ON PARAMETER lo_compat_privileges TO {ROLE}",
             f"REVOKE SET ON PARAMETER lo_compat_privileges FROM {ROLE}", "lo_compat_privileges"),
            ("large object", f"SELECT lo_create(424242); GRANT SELECT ON LARGE OBJECT 424242 TO {ROLE}", "SELECT lo_unlink(424242)", "424242"),
            # launch-gate 14:42 (games-gates 15:14): every routine it can execute in synapse returns `trigger`; a plain
            # function or procedure (PUBLIC may execute new routines by default) is a finding
            ("function", "CREATE FUNCTION public.g9_plant_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'",
             "DROP FUNCTION public.g9_plant_fn()", "g9_plant_fn"),
            ("function", "CREATE PROCEDURE public.g9_plant_proc() LANGUAGE sql AS 'SELECT 1'",
             "DROP PROCEDURE public.g9_plant_proc()", "g9_plant_proc"),
            # PM 15:26 (games-lab's sweep v2): a trigger-returning SECURITY DEFINER function, and large objects reachable
            # through PUBLIC or by owning them
            ("function", "CREATE FUNCTION public.g9_secdef_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN RETURN NEW; END$$",
             "DROP FUNCTION public.g9_secdef_trg()", "g9_secdef_trg"),
            ("large object", "SELECT lo_create(424243); GRANT SELECT ON LARGE OBJECT 424243 TO PUBLIC", "SELECT lo_unlink(424243)", "424243"),
            ("large object", f"SELECT lo_create(424244); ALTER LARGE OBJECT 424244 OWNER TO {ROLE}", "SELECT lo_unlink(424244)", "424244"),
            # games-gates 16:05: a membership that is SET-only (no INHERIT) still lets the role SET ROLE into a reader
            ("membership", f"CREATE ROLE g9_reader NOLOGIN; GRANT SELECT ON public.users TO g9_reader; GRANT g9_reader TO {ROLE} WITH INHERIT FALSE, SET TRUE",
             f"REVOKE g9_reader FROM {ROLE}; REVOKE SELECT ON public.users FROM g9_reader; DROP ROLE g9_reader", "g9_reader"),
            # astra round 2: a grant to PUBLIC must not hide a sensitive catalog or function
            ("catalog", "GRANT SELECT ON pg_catalog.pg_statistic TO PUBLIC", "REVOKE SELECT ON pg_catalog.pg_statistic FROM PUBLIC", "pg_statistic"),
            ("catalog function", "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) TO PUBLIC",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) FROM PUBLIC", "pg_read_binary_file"),
        ]
        for kind, plant, undo, name in plants:
            with self.subTest(plant=plant):
                psql("-c", plant, db=DB)
                try:
                    found = self.scan()
                    self.assertTrue(any(f.split("|")[0] == kind and name in f.split("|")[1] for f in found),
                                    f"{plant}: the scan found {found}")
                finally:
                    psql("-c", undo, db=DB)
                self.assertEqual(self.scan(), [], f"clean again after: {undo}")

    def scan_in(self, db) -> list[str]:
        return [l for l in psql("-At", "-v", f"role={ROLE}", db=db, stdin=play.SCAN_SQL).splitlines() if l.strip()]

    def test_in_the_games_database_only_the_every_db_parts_apply(self):
        """play.scan runs SCAN_SQL in the games database too: its own tables are not findings there, a usable foreign
        server is (a connection that starts in the games database)."""
        self.assertEqual(self.scan_in(ROLE), [], "the role's own tables and sequence in its own database: clean")
        psql("-c", "CREATE FOREIGN DATA WRAPPER g9fdw2; CREATE SERVER g9srv2 FOREIGN DATA WRAPPER g9fdw2", db=ROLE)
        try:
            psql("-c", f"GRANT USAGE ON FOREIGN SERVER g9srv2 TO {ROLE}", db=ROLE)
            self.assertTrue(any(f.startswith("foreign server|g9srv2") for f in self.scan_in(ROLE)))
        finally:
            psql("-c", "DROP SERVER g9srv2 CASCADE; DROP FOREIGN DATA WRAPPER g9fdw2", db=ROLE)
        self.assertEqual(self.scan_in(ROLE), [])

    def test_an_off_override_is_no_finding(self):
        """astra round 2: turning the unsafe setting OFF must clear the finding (and so the block)."""
        psql("-c", f"ALTER DATABASE {DB} SET lo_compat_privileges = off")
        try:
            self.assertEqual(self.scan(), [])
        finally:
            psql("-c", f"ALTER DATABASE {DB} RESET lo_compat_privileges")

    def test_the_scan_covers_every_database_the_role_may_connect_to(self):
        dbs = [l for l in psql("-At", "-v", f"role={ROLE}", stdin=play.SCAN_DBS_SQL).splitlines() if l.strip()]
        self.assertIn("postgres", dbs, "PUBLIC may connect to postgres: a mapping there is a way in too")
        self.assertIn(ROLE, dbs, "its own database")
        self.assertNotIn(DB, dbs[:0])
        missing = [l for l in psql("-At", "-v", "role=no_such_role_g9", stdin=play.SCAN_DBS_SQL).splitlines() if l.strip()]
        self.assertEqual(missing, [], "a missing role: no error, and nothing but synapse (absent here)")

    def test_a_missing_role_is_a_finding_not_a_pass(self):
        out = psql("-At", "-v", "role=no_such_role_g9", db=DB, stdin=play.SCAN_SQL)
        self.assertIn("missing|no_such_role_g9", out)


if __name__ == "__main__":
    unittest.main()
