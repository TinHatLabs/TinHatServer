"""dbcheck (0.3.16): a backup's database is restored into a throwaway one first (no network, not as a superuser),
checked, dumped again by us, and only that dump reaches the live database.

The archives here are written by the test (a pg_dump custom-format writer below, format 1.16 = PostgreSQL 17): a
Synapse-shaped one with Synapse's own functions and triggers (synapse_pg_functions.json), and crafted ones. Docker is
scripted: the commands' shapes are what is checked (who restores, with what, where). The real thing runs in the lab.
    python3 -m unittest discover -s appliance/tests
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
os.environ.setdefault("TINHAT_STATE", tempfile.mkdtemp())
sys.path.insert(0, str(_OPT / "manager"))

from tinhat import dbcheck  # noqa: E402

# (other test modules replace tinhat's modules in sys.modules: take the class the module under test raises)
UnsafeBackup = dbcheck.UnsafeBackup

REF = dbcheck.reference()


# ---- a pg_dump custom-format writer (just the header and the list of entries) ------------------------------------------

def _int(v: int) -> bytes:
    return bytes([1 if v < 0 else 0]) + abs(v).to_bytes(4, "little")


def _str(s) -> bytes:
    if s is None:
        return _int(-1)
    b = s.encode()
    return _int(len(b)) + b


def archive(entries: list[dict], version=(1, 16, 0)) -> bytes:
    out = bytearray(b"PGDMP" + bytes([*version, 4, 8, 1]))
    out += b"\x00" if version >= (1, 15, 0) else _int(0)
    for v in (0, 0, 0, 1, 0, 126, 0):
        out += _int(v)
    out += _str("synapse") + _str("17.11") + _str("17.11") + _int(len(entries))
    for i, e in enumerate(entries, 1):
        out += _int(e.get("id", i)) + _int(1 if e["desc"] == "TABLE DATA" else 0) + _str("0") + _str("0")
        out += _str(e.get("tag", "x")) + _str(e["desc"]) + _int(1) + _str(e.get("defn", "")) + _str("")
        out += _str(e.get("copy")) + _str(e.get("ns", "public")) + _str("")
        if version >= (1, 14, 0):
            out += _str("heap")
        if version >= (1, 16, 0):
            out += _int(114)
        out += _str("synapse") + _str("false")
        for d in e.get("deps", []):
            out += _str(str(d))
        out += _str(None) + b"\x01" + (0).to_bytes(8, "little")
    return bytes(out)


def synapse_like() -> list[dict]:
    """The kinds and shapes of a Synapse 1.14x database's dump (made up rows, real schema text forms)."""
    e = [{"desc": "ENCODING", "tag": "ENCODING", "defn": "SET client_encoding = 'UTF8';\n", "ns": ""},
         {"desc": "STDSTRINGS", "tag": "STDSTRINGS", "defn": "SET standard_conforming_strings = 'on';\n", "ns": ""},
         {"desc": "SEARCHPATH", "tag": "SEARCHPATH", "defn": "SELECT pg_catalog.set_config('search_path', '', false);\n", "ns": ""},
         {"desc": "DATABASE", "tag": "synapse", "defn": "CREATE DATABASE synapse WITH TEMPLATE = template0;\n", "ns": ""}]
    for sig, body in REF["functions"].items():
        e.append({"desc": "FUNCTION", "tag": sig, "defn": body})
    e += [
        {"desc": "TABLE", "tag": "users", "defn": "CREATE TABLE public.users (\n    name text,\n    admin smallint DEFAULT 0 NOT NULL,\n"
                                                  "    deactivated smallint DEFAULT 0 NOT NULL,\n    locked boolean DEFAULT false NOT NULL\n);\n"},
        {"desc": "TABLE", "tag": "schema_version", "defn": "CREATE TABLE public.schema_version (\n    lock character(1) DEFAULT 'X'::bpchar NOT NULL,\n"
                                                           "    version integer NOT NULL,\n"
                                                           "    CONSTRAINT schema_version_lock_check CHECK ((lock = 'X'::bpchar))\n);\n"},
        {"desc": "TABLE", "tag": "event_push_actions_staging",
         "defn": "CREATE TABLE public.event_push_actions_staging (\n    event_id text NOT NULL,\n"
                 "    inserted_ts bigint DEFAULT (EXTRACT(epoch FROM now()) * (1000)::numeric),\n    thread_id text,\n"
                 "    CONSTRAINT event_push_actions_staging_thread_id CHECK ((thread_id IS NOT NULL))\n);\n"},
        {"desc": "TABLE", "tag": "event_auth_chain_links",
         "defn": "CREATE TABLE public.event_auth_chain_links (\n    origin_chain_id bigint NOT NULL\n);\n"
                 "ALTER TABLE ONLY public.event_auth_chain_links ALTER COLUMN origin_chain_id SET (n_distinct=-0.5);\n"},
        {"desc": "TABLE", "tag": "instance_map", "defn": "CREATE TABLE public.instance_map (\n    instance_id integer NOT NULL,\n    instance_name text NOT NULL\n);\n"},
        {"desc": "SEQUENCE", "tag": "instance_map_instance_id_seq",
         "defn": "CREATE SEQUENCE public.instance_map_instance_id_seq\n    AS integer\n    START WITH 1\n    INCREMENT BY 1\n    NO MINVALUE\n    NO MAXVALUE\n    CACHE 1;\n"},
        {"desc": "SEQUENCE", "tag": "x_seq",
         "defn": "ALTER TABLE public.sliding_sync_connections ALTER COLUMN connection_key ADD GENERATED ALWAYS AS IDENTITY (\n"
                 "    SEQUENCE NAME public.sliding_sync_connections_connection_key_seq\n    START WITH 1\n    CACHE 1\n);\n"},
        {"desc": "SEQUENCE OWNED BY", "tag": "instance_map_instance_id_seq",
         "defn": "ALTER SEQUENCE public.instance_map_instance_id_seq OWNED BY public.instance_map.instance_id;\n"},
        {"desc": "DEFAULT", "tag": "instance_map instance_id",
         "defn": "ALTER TABLE ONLY public.instance_map ALTER COLUMN instance_id SET DEFAULT nextval('public.instance_map_instance_id_seq'::regclass);\n"},
        {"desc": "TABLE DATA", "tag": "users", "copy": "COPY public.users (name, admin, deactivated, locked) FROM stdin;\n"},
        {"desc": "TABLE DATA", "tag": "receipts", "copy": 'COPY public.receipts ("limit", room_id) FROM stdin;\n'},
        {"desc": "SEQUENCE SET", "tag": "instance_map_instance_id_seq",
         "defn": "SELECT pg_catalog.setval('public.instance_map_instance_id_seq', 1, false);\n"},
        {"desc": "CONSTRAINT", "tag": "users users_name_key", "defn": "ALTER TABLE ONLY public.users\n    ADD CONSTRAINT users_name_key UNIQUE (name);\n"},
        {"desc": "INDEX", "tag": "current_state_events_member_index",
         "defn": "CREATE INDEX current_state_events_member_index ON public.current_state_events USING btree (state_key) "
                 "WHERE (type = 'm.room.member'::text);\n"},
        {"desc": "INDEX", "tag": "event_search_fts_idx", "defn": "CREATE INDEX event_search_fts_idx ON public.event_search USING gin (vector);\n"},
        {"desc": "FK CONSTRAINT", "tag": "event_edges event_edges_event_id_fkey",
         "defn": "ALTER TABLE ONLY public.event_edges\n    ADD CONSTRAINT event_edges_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(event_id);\n"},
        {"desc": "COMMENT", "tag": "COLUMN destinations.retry_interval",
         "defn": "COMMENT ON COLUMN public.destinations.retry_interval IS 'in ms (it''s the back-off)';\n"},
        {"desc": "ACL", "tag": "SCHEMA public", "defn": "REVOKE USAGE ON SCHEMA public FROM PUBLIC;\n"},
    ]
    for i, defn in enumerate(REF["trigger_defs"]):
        e.append({"desc": "TRIGGER", "tag": f"t{i}", "defn": defn})
    return e


class Box(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, entries, name="db.dump", **kw) -> Path:
        p = self.tmp / name
        p.write_bytes(archive(entries, **kw))
        return p

    def refused(self, entries, ours=False, what=""):
        with self.assertRaisesRegex(UnsafeBackup, what or "wasn't restored") as cm:
            dbcheck.check(dbcheck.read_toc(self.write(entries)), ours=ours)
        return str(cm.exception)


class Reference(unittest.TestCase):
    def test_synapse_functions_and_triggers(self):
        self.assertEqual(sorted(REF["functions"]), ["check_event_stream_ordering()", "check_partial_state_events()",
                                                     "delete_read_write_lock_parent()", "upsert_read_write_lock_parent()"])
        for body in REF["functions"].values():
            self.assertTrue(body.startswith("CREATE FUNCTION public.") and "LANGUAGE plpgsql" in body)
            for bad in ("COPY", "PROGRAM", "lo_", "pg_read", "EXECUTE", "dblink", "SECURITY DEFINER"):
                self.assertNotIn(bad, body.upper() if bad.isupper() else body)
        for fn in REF["triggers"].values():
            self.assertIn(f"{fn}()", REF["functions"])
        self.assertEqual(len(REF["trigger_defs"]), 6)
        for d in REF["trigger_defs"]:
            self.assertRegex(d, r"^CREATE TRIGGER \w+ (BEFORE|AFTER) [A-Z ]+ ON public\.\w+ FOR EACH ROW EXECUTE FUNCTION "
                                r"public\.\w+\(\);\n$")


class ReadToc(Box):
    def test_round_trip_every_supported_format(self):
        for ver in ((1, 12, 0), (1, 13, 0), (1, 14, 0), (1, 15, 0), (1, 16, 0)):
            with self.subTest(ver):
                got = dbcheck.read_toc(self.write(synapse_like(), version=ver))
                self.assertEqual([(e.desc, e.tag) for e in got], [(e["desc"], e["tag"]) for e in synapse_like()])
                self.assertEqual(got[0].id, 1)

    def test_not_a_dump(self):
        p = self.tmp / "x"
        p.write_bytes(b"SQLite format 3\0" + b"\0" * 100)
        self.assertRaisesRegex(UnsafeBackup, "isn't a PostgreSQL dump", dbcheck.read_toc, p)

    def test_unknown_format_version(self):
        self.assertRaisesRegex(UnsafeBackup, "format", dbcheck.read_toc, self.write(synapse_like(), version=(1, 17, 0)))

    def test_cut_short(self):
        p = self.tmp / "cut"
        p.write_bytes(archive(synapse_like())[:300])
        self.assertRaisesRegex(UnsafeBackup, "cut short", dbcheck.read_toc, p)

    def test_entry_ids_and_total_text(self):
        self.assertRaises(UnsafeBackup, dbcheck.read_toc, self.write([{"id": 0, "desc": "TABLE", "tag": "t"}]))
        self.assertRaises(UnsafeBackup, dbcheck.read_toc, self.write([{"id": dbcheck.MAX_ID + 1, "desc": "TABLE", "tag": "t"}]))
        with mock.patch.object(dbcheck, "MAX_TOC_BYTES", 2000):
            self.assertRaises(UnsafeBackup, dbcheck.read_toc, self.write(synapse_like()))

    def test_absurd_sizes(self):
        raw = bytearray(archive([{"desc": "TABLE", "tag": "t", "defn": "x"}]))
        i = raw.index(b"synapse") + len("synapse") + 2 * (5 + 5)  # past dbname + two version strings
        raw[i:i + 5] = _int(10**9)  # the entry count
        p = self.tmp / "many"
        p.write_bytes(bytes(raw))
        self.assertRaises(UnsafeBackup, dbcheck.read_toc, p)


class Check(Box):
    def test_a_synapse_shaped_dump_passes_both_layers(self):
        entries = dbcheck.read_toc(self.write(synapse_like()))
        ids = dbcheck.check(entries)
        self.assertEqual(ids, dbcheck.check(entries, ours=True))
        skipped = {e.id for e in entries if e.desc in ("DATABASE", "ACL")}
        self.assertEqual(set(ids), {e.id for e in entries} - skipped)
        self.assertEqual(dbcheck.list_file([3, 7]), "3;\n7;\n")

    def test_each_kind_a_synapse_database_never_has(self):
        for kind in ("EXTENSION", "RULE", "VIEW", "MATERIALIZED VIEW", "EVENT TRIGGER", "LARGE OBJECT", "BLOB", "BLOBS",
                     "AGGREGATE", "PROCEDURE", "OPERATOR", "CAST", "TYPE", "DOMAIN", "POLICY", "PUBLICATION",
                     "SUBSCRIPTION", "DEFAULT ACL", "FOREIGN TABLE", "SERVER", "USER MAPPING", "TABLE ATTACH",
                     "STATISTICS", "COLLATION", "CONVERSION", "TRANSFORM", "ROW SECURITY"):
            with self.subTest(kind):
                self.refused(synapse_like() + [{"desc": kind, "tag": "x", "defn": "SELECT 1;\n"}], what="a kind of entry")

    def test_a_function_that_isnt_synapses(self):
        self.refused(synapse_like() + [{"desc": "FUNCTION", "tag": "evil()",
                                        "defn": "CREATE FUNCTION public.evil() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\n"}],
                     what="a function")

    def test_synapses_function_name_with_another_body(self):
        e = synapse_like()
        fn = next(x for x in e if x["desc"] == "FUNCTION")
        fn["defn"] = fn["defn"].replace("RETURN NEW;", "PERFORM lo_export(1, '/tmp/x'); RETURN NEW;", 1)
        self.refused(e, what="a function")
        fn["defn"] = fn["defn"].replace("PERFORM lo_export(1, '/tmp/x'); ", "") + " "  # one byte off
        self.refused(e, what="a function")

    def test_triggers(self):
        good = REF["trigger_defs"][0]
        self.refused(synapse_like() + [{"desc": "TRIGGER", "tag": "t x",  # a Synapse trigger on another table
                                        "defn": good.replace(good.split(" ON public.")[1].split(" ")[0], "users", 1)}],
                     what="a trigger")
        older = [dict(x, defn=x["defn"].replace(" EXECUTE FUNCTION ", " EXECUTE PROCEDURE ")) if x["desc"] == "TRIGGER" else x
                 for x in synapse_like()]
        dbcheck.check(dbcheck.read_toc(self.write(older)))  # an older pg_dump's spelling of the same triggers
        bad = ["CREATE TRIGGER check_event_stream_ordering BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.evil();\n",
               "CREATE TRIGGER evil BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.check_event_stream_ordering();\n",
               "CREATE TRIGGER check_event_stream_ordering BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.check_event_stream_ordering(); SELECT 1;\n",
               "CREATE TRIGGER check_event_stream_ordering BEFORE INSERT ON other.t FOR EACH ROW EXECUTE FUNCTION public.check_event_stream_ordering();\n"]
        for defn in bad:
            with self.subTest(defn[:60]):
                self.refused(synapse_like() + [{"desc": "TRIGGER", "tag": "t x", "defn": defn}], what="a trigger")

    def test_copy_from_program_in_a_data_entry(self):
        for copy in ("COPY public.users (name) FROM PROGRAM 'id > /tmp/x';\n",
                     "COPY public.users (name) FROM stdin; COPY x TO PROGRAM 'id';\n",
                     "COPY public.users (name) FROM '/etc/passwd';\n",
                     "COPY other.users (name) FROM stdin;\n"):
            with self.subTest(copy[:40]):
                self.refused(synapse_like() + [{"desc": "TABLE DATA", "tag": "users", "copy": copy}], what="a data entry")

    def test_a_copy_statement_on_another_kind(self):
        self.refused(synapse_like() + [{"desc": "TABLE", "tag": "t", "defn": "CREATE TABLE public.t (a text);\n",
                                        "copy": "COPY public.t (a) FROM stdin;\n"}], what="a data entry")

    def test_other_schemas_and_comments(self):
        self.refused(synapse_like() + [{"desc": "TABLE", "tag": "t", "ns": "evil", "defn": "CREATE TABLE evil.t (a text);\n"}],
                     what="a schema")
        self.refused(synapse_like() + [{"desc": "SCHEMA", "tag": "evil", "ns": "", "defn": "CREATE SCHEMA evil;\n"}],
                     what="a schema")
        self.refused(synapse_like() + [{"desc": "COMMENT", "tag": "FUNCTION evil()", "defn": "COMMENT ON FUNCTION …;\n"}],
                     what="a comment")

    def test_expressions_in_our_own_dump(self):
        """Layer 3: a default, check, generated column or index that calls anything but Synapse's few functions."""
        cases = [
            ("DEFAULT", "ALTER TABLE ONLY public.users ALTER COLUMN name SET DEFAULT lo_export(1, '/var/lib/postgresql/data/x');\n"),
            ("TABLE", "CREATE TABLE public.t (\n    a text DEFAULT pg_read_file('/etc/passwd'::text)\n);\n"),
            ("TABLE", "CREATE TABLE public.t (\n    a text,\n    CONSTRAINT c CHECK ((pg_catalog.lo_import('/etc/shadow') > 0))\n);\n"),
            ("TABLE", "CREATE TABLE public.t (\n    a text GENERATED ALWAYS AS (public.evil(a)) STORED\n);\n"),
            ("TABLE", "CREATE TABLE public.t (\n    a text DEFAULT \"lo_export\"(1, 'x')\n);\n"),
            ("INDEX", "CREATE INDEX i ON public.t USING btree (lower(a));\n"),
            ("CONSTRAINT", "ALTER TABLE public.t\n    ADD CONSTRAINT c CHECK (pg_terminate_backend(1)) NOT VALID;\n"),
            ("TABLE", "CREATE TABLE public.t (\n    a text DEFAULT pg_catalog.set_config('x', 'y', false)\n);\n"),
        ]
        for desc, defn in cases:
            with self.subTest(defn[:50]):
                e = synapse_like() + [{"desc": desc, "tag": "t", "defn": defn}]
                dbcheck.check(dbcheck.read_toc(self.write(e)))  # layer 1 lets text through (not its job) …
                self.refused(e, ours=True, what="a call to")      # … layer 3, on our own dump, doesn't

    def test_quote_characters_inside_the_other_kind_hide_nothing(self):
        """Review round 2: a name like "a'" opened a fake string in a regex strip and hid the call after it."""
        hidden = ['CREATE TABLE public.t (\n    "a\'" text,\n    "z\'" text DEFAULT lo_export(lo_from_bytea(0, \'x\'), \'/tmp/y\')\n);\n',
                  "ALTER TABLE ONLY public.t ALTER COLUMN \"x'\" SET DEFAULT pg_read_file('/etc/hostname'::text);\n",
                  "CREATE TABLE public.t (\n    a text CONSTRAINT \"c'\" CHECK (CASE WHEN CURRENT_USER = 'synapse' "
                  "THEN (lo_export(1, '/x') > 0) ELSE true END) CONSTRAINT \"d'\" CHECK (true)\n);\n",
                  "CREATE TABLE public.t (a text DEFAULT 'say \"hi' || lo_export(1, 'x')::text);\n"]
        for defn in hidden:
            with self.subTest(defn[:50]):
                self.assertTrue(dbcheck.calls(defn) & {"lo_export", "pg_read_file"}, dbcheck.calls(defn))
                self.refused(synapse_like() + [{"desc": "TABLE", "tag": "t", "defn": defn}], ours=True, what="a call to")
        self.assertEqual(dbcheck.calls(r"DEFAULT E'it\'s lo_export(1)'"), set())  # E'…' with \' inside: one literal
        self.assertEqual(dbcheck.calls(r"DEFAULT E'a\\' || now()"), {"now"})  # E'a\\' ends there; then a call
        self.assertEqual(dbcheck.calls("DEFAULT $q$ lo_export(1) $q$"), set())
        self.assertEqual(dbcheck.calls("DEFAULT $$ ' $$ || lower(a)"), {"lower"})
        self.assertEqual(dbcheck.calls("/* lo_export( /* nested */ */ now() -- lo_import(\n"), {"now"})
        for broken in ("DEFAULT 'open", 'DEFAULT "open', r"DEFAULT E'open\'", "DEFAULT $a$ open", "/* open"):
            with self.subTest(broken):
                self.assertRaisesRegex(UnsafeBackup, "doesn't parse", dbcheck.calls, broken)

    def test_literals_and_quoted_names_dont_hide_or_fake_a_call(self):
        self.assertEqual(dbcheck.calls("DEFAULT 'lo_export(1)'::text"), set())
        self.assertEqual(dbcheck.calls('DEFAULT "lo_export"(1)'), {"q"})
        self.assertEqual(dbcheck.calls("REFERENCES public.events(event_id)"), set())
        self.assertEqual(dbcheck.calls("DEFAULT public.pg_evil(1)"), {"pg_evil"})
        self.assertEqual(dbcheck.calls("DEFAULT public.evil(1)"), {"evil"})  # only after TABLE/ONLY/REFERENCES is it a table
        self.assertEqual(dbcheck.calls("CREATE TABLE public.t (\n a text\n);"), set())


class Isolated(Box):
    """The throwaway database: the commands' shapes (scripted Docker)."""

    def test_the_throwaway_container_keeps_no_log(self):  # review 0.3.16: RAISE LOG floods can't fill Docker's disk
        res, calls, _ = self.run_isolated()
        runs = [c["cmd"] for c in calls if c["cmd"][:2] == ["docker", "run"]]
        self.assertTrue(runs)
        for cmd in runs:
            self.assertIn("--log-driver", cmd)
            self.assertEqual(cmd[cmd.index("--log-driver") + 1], "none")

    def run_isolated(self, fail_at: str | None = None, users_other: str = "0", clean_entries=None, synapse_version=None):
        dump = self.write(synapse_like())
        calls = []
        clean_raw = archive(clean_entries or synapse_like())

        async def sh(*cmd, timeout=600, stdin=None):
            calls.append({"cmd": list(cmd), "stdin": stdin})
            joined = " ".join(cmd)
            if fail_at and fail_at in joined:
                return 1, "failed on purpose"
            if "schema_compat_version" in joined:
                return 0, self.compat_out
            if "schema_version" in joined:
                return 0, self.schema_out
            if stdin and b"FROM users WHERE right(" in stdin:
                return 0, users_other + "\n"
            if "SELECT (SELECT count(*) FROM users" in joined:
                return 0, "3|5|42\n"
            return 0, ""

        captured = {}

        def run_capped(cmd, env, target, claim, timeout):
            calls.append({"cmd": list(cmd), "stdin": None, "capped": True})
            if "pg_dump" in cmd:
                captured.update(dump_cmd=cmd, dump_target=target)
                if fail_at == "pg_dump":
                    return subprocess.CompletedProcess(cmd, 1, "", "pg_dump: error")
                (target / "checked.dump").write_bytes(clean_raw)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            captured.update(cmd=cmd, target=target, claim=claim)
            rc = 1 if fail_at == "pg_restore" else 0
            return subprocess.CompletedProcess(cmd, rc, "", "pg_restore: error" if rc else "")
        with mock.patch.object(dbcheck, "_sh", side_effect=sh), mock.patch("tinhat.restorecap.run_capped", side_effect=run_capped):
            try:
                res = asyncio.run(dbcheck.isolated(dump, self.tmp / "work", "crew.tinhat.test", "postgres:17-alpine@sha256:x",
                                                   synapse_version))
            except UnsafeBackup as e:
                res = e
        return res, calls, captured

    schema_out = "1|88\n"
    compat_out = "83\n"

    def test_no_question_before_our_own_dump_passed(self):
        """Review round 3: a SELECT could call something the backup defined (a view, a function): the questions come
        only after our dump of the throwaway database passed the rules."""
        res, calls, _ = self.run_isolated()
        names = [" ".join(c["cmd"]) for c in calls]
        dump_at = next(i for i, n in enumerate(names) if "pg_dump" in n)
        first_q = next(i for i, c in enumerate(calls) if "schema_version" in " ".join(c["cmd"])
                       or (c["stdin"] and b"FROM users" in c["stdin"]))
        self.assertLess(dump_at, first_q)
        q = next(c["cmd"] for c in calls if "schema_version" in " ".join(c["cmd"]))
        self.assertIn("PGOPTIONS=-c client_min_messages=error", q)
        evil = synapse_like() + [{"desc": "VIEW", "tag": "schema_version", "defn": "CREATE VIEW public.schema_version AS …;\n"}]
        res, calls, _ = self.run_isolated(clean_entries=evil)
        self.assertIsInstance(res, UnsafeBackup)
        self.assertFalse(any("schema_version" in " ".join(c["cmd"]) for c in calls))  # never asked

    def test_a_backup_from_a_newer_synapse(self):
        self.compat_out = "93\n"
        res, _, _ = self.run_isolated(synapse_version=92)
        self.assertIsInstance(res, UnsafeBackup)
        self.assertIn("newer chat server", str(res))
        self.compat_out = "83\n"
        res, _, _ = self.run_isolated(synapse_version=92)
        self.assertNotIsInstance(res, UnsafeBackup)
        res, calls, _ = self.run_isolated(synapse_version=None)  # unknown: Synapse's own check at its first start
        self.assertFalse(any("schema_compat_version" in " ".join(c["cmd"]) for c in calls))

    def test_output_is_bounded(self):
        rc, out = asyncio.run(dbcheck._sh(sys.executable, "-c", "import sys\nwhile True: sys.stdout.write('NOTICE ' * 1000)"))
        self.assertEqual(rc, 1)
        self.assertIn("output cut", out)
        self.assertLess(len(out), 8192)

    def test_shapes(self):
        res, calls, cap = self.run_isolated()
        self.assertEqual(res.counts, {"people": 3, "rooms": 5, "messages": 42})
        self.assertEqual(res.schema_version, 88)
        self.assertTrue(res.dump.exists())
        run = next(c["cmd"] for c in calls if c["cmd"][:2] == ["docker", "run"])
        self.assertEqual(run[run.index("--network") + 1], "none")
        self.assertIn(f"{self.tmp / 'db.dump'}:/backup/db.dump:ro", run)
        self.assertFalse(any(a.startswith(("/var/run/docker", "/var/lib/tinhat")) for a in run if ":" in a and a != run[-1]))
        role = next(c for c in calls if c["stdin"] and b"CREATE ROLE restorer" in c["stdin"])
        self.assertIn(b"NOSUPERUSER", role["stdin"])
        self.assertIn(b":'pw'", role["stdin"])  # the password is a psql variable, never SQL text
        # the restore CONNECTS as the non-superuser (no --role: RESET ROLE would climb back)
        r = cap["cmd"]
        self.assertEqual(r[r.index("-U") + 1], "restorer")
        self.assertNotIn("--role", " ".join(r))
        for flag in ("--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"):
            self.assertIn(flag, r)
        self.assertEqual(r[r.index("-L") + 1], "/backup/restore.list")
        self.assertEqual(cap["target"], self.tmp / "work" / "pgcheck")
        dump_cmd = cap["dump_cmd"]
        self.assertEqual(dump_cmd[dump_cmd.index("-U") + 1], "restorer")
        self.assertEqual(dump_cmd[dump_cmd.index("-f") + 1], "/var/lib/postgresql/data/checked.dump")  # inside the cap
        self.assertEqual(cap["dump_target"], self.tmp / "work" / "pgcheck")
        self.assertEqual(run[run.index("--memory") + 1], dbcheck.CONTAINER_MEMORY)
        self.assertEqual(run[run.index("--memory-swap") + 1], dbcheck.CONTAINER_MEMORY)
        self.assertEqual(calls[-1]["cmd"][:3], ["docker", "rm", "-f"])  # the throwaway goes
        self.assertFalse((self.tmp / "work" / "pgcheck").exists())
        sn = next(c for c in calls if c["stdin"] and b"right(" in c["stdin"])
        self.assertIn("sn=crew.tinhat.test", sn["cmd"])  # the server name as a psql variable
        self.assertIn(b":'sn'", sn["stdin"])

    def test_restore_list_leaves_out_skipped_entries(self):
        written = {}
        real = Path.write_text

        def spy(self_, text, *a, **k):
            if self_.name == "restore.list":
                written["list"] = text
            return real(self_, text, *a, **k)
        with mock.patch.object(Path, "write_text", spy):
            self.run_isolated()
        ids = [int(x.rstrip(";")) for x in written["list"].split()]
        kinds = {i + 1: e["desc"] for i, e in enumerate(synapse_like())}
        self.assertNotIn("DATABASE", {kinds[i] for i in ids})
        self.assertNotIn("ACL", {kinds[i] for i in ids})

    def test_crafted_list_never_starts_a_container(self):
        dump = self.write(synapse_like() + [{"desc": "EXTENSION", "tag": "dblink", "defn": "CREATE EXTENSION dblink;\n"}])
        with mock.patch.object(dbcheck, "_sh") as sh:
            with self.assertRaises(UnsafeBackup):
                asyncio.run(dbcheck.isolated(dump, self.tmp / "work", "crew.tinhat.test", "img"))
        sh.assert_not_called()

    def test_failures_refuse_and_clean_up(self):
        for fail_at, what in (("pg_restore", "couldn't be restored on its own"),
                              ("schema_version", "schema version"),
                              ("pg_dump", "Couldn't copy")):
            with self.subTest(fail_at):
                res, calls, _ = self.run_isolated(fail_at=fail_at)
                self.assertIsInstance(res, UnsafeBackup)
                self.assertIn(what, str(res))
                self.assertEqual(calls[-1]["cmd"][:3], ["docker", "rm", "-f"])
                self.assertFalse((self.tmp / "work" / "checked.dump").exists())

    def test_schema_version_must_be_one_plausible_row(self):
        for out in ("2|88\n", "1|5000\n", "1|3\n", "0|\n", "garbage\n"):
            with self.subTest(out):
                self.schema_out = out
                res, calls, _ = self.run_isolated()
                self.assertIsInstance(res, UnsafeBackup)
                self.assertIn("schema version", str(res))

    def test_a_command_that_times_out_is_killed(self):
        async def go():
            with self.assertRaises(asyncio.TimeoutError):
                await dbcheck._sh(sys.executable, "-c", "import time, os; open(%r, 'w').write(str(os.getpid())); time.sleep(60)"
                                  % str(self.tmp / "pid"), timeout=1)
        asyncio.run(go())
        pid = int((self.tmp / "pid").read_text())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_accounts_of_another_server(self):
        res, calls, _ = self.run_isolated(users_other="2")
        self.assertIsInstance(res, UnsafeBackup)
        self.assertIn("another server", str(res))

    def test_our_dump_is_checked_with_the_expression_rule(self):
        evil = synapse_like() + [{"desc": "DEFAULT", "tag": "u", "defn": "ALTER TABLE ONLY public.users ALTER COLUMN name SET DEFAULT lo_export(1, 'x');\n"}]
        res, calls, _ = self.run_isolated(clean_entries=evil)
        self.assertIsInstance(res, UnsafeBackup)
        self.assertIn("a call to lo_export", str(res))
        self.assertFalse((self.tmp / "work" / "checked.dump").exists())


class Callers(unittest.TestCase):
    """The setup's restore and Test restore both go through it (source checks: install.py needs aiohttp)."""

    def test_sources(self):
        pkg = _OPT / "manager" / "tinhat"
        install = (pkg / "install.py").read_text()
        backup = (pkg / "backup.py").read_text()
        self.assertIn("checked = await dbcheck.isolated(root / \"db.dump\"", install)
        self.assertIn("shutil.move(str(checked.dump), str(work / \"db.dump\"))", install)
        self.assertNotIn('shutil.move(str(root / "db.dump")', install)
        # the live restore of that dump: one transaction, stops at the first error (no half database)
        self.assertIn('"synapse", "-d", "synapse", "--no-owner", "--single-transaction",\n'
                      '                                                        "--exit-on-error", stdin=f', install)
        self.assertIn("checked = await dbcheck.isolated(dump, work / \"dbcheck\"", backup)
        self.assertNotIn('"pg_restore", "-U", "synapse", "-d", "synapse", "--no-owner",\n                            "/backup/db.dump"', backup)


if __name__ == "__main__":
    unittest.main()
