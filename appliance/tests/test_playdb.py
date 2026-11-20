"""G1: the games database's vetted restore, layer 1 (playdb.check) on REAL pg_dump archives (fixtures/play/, made by
pg_dump 17.11 from the real migrations in a throwaway container: README.md there): the real one passes; every planted
one is refused for its own reason (an extra function, a missing protection trigger, a view, an extra table, an extra
column, a default that calls pg_read_file); and edits of real entries (a data entry that isn't a plain COPY, a setval
that runs more, another schema, an entry twice) are refused. The reference matches the real dump exactly. Plus the
backup and the restore hooks: the games never fail a server backup or restore."""
import dataclasses
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_OPT = Path(__file__).resolve().parents[1] / "rootfs" / "opt" / "tinhat"
os.environ.setdefault("TINHAT_OPT", str(_OPT))
sys.path.insert(0, str(_OPT / "manager"))

from tinhat import dbcheck, playdb  # noqa: E402
from tinhat.restoresafe import UnsafeBackup  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "play"


def toc(name: str):
    return dbcheck.read_toc(FIX / f"{name}.dump")


class Layer1(unittest.TestCase):
    def test_the_real_games_dump_passes_and_matches_the_reference_exactly(self):
        es = toc("play-v2")
        ids = playdb.check(es)
        self.assertEqual(len(ids), len([e for e in es if e.desc not in playdb.SKIP]))
        ref = playdb.reference()
        self.assertEqual(ref["schema"], 2)
        self.assertEqual(len(ref["copies"]), 12, "the twelve games tables")
        self.assertEqual(sum(k.startswith("TRIGGER|") for k in ref["entries"]), 6, "the journal's six protection triggers")
        self.assertEqual(sum(k.startswith("FUNCTION|") for k in ref["entries"]), 4)

    def test_every_planted_dump_is_refused_for_its_own_reason(self):
        for name, why in (("planted-function", "FUNCTION 'g1_evil()'"), ("planted-missing-trigger", "play_entries_ro"),
                          ("planted-view", "VIEW 'g1_view'"), ("planted-table", "TABLE 'g1_extra'"),
                          ("planted-column", "TABLE 'play_people'"), ("planted-default", "TABLE 'play_wallets'")):
            with self.subTest(name=name):
                with self.assertRaises(UnsafeBackup) as cm:
                    playdb.check(toc(name))
                self.assertIn(why, str(cm.exception))

    def test_edits_of_real_entries_are_refused(self):
        es = toc("play-v2")

        def edited(pred, **change):
            out = [dataclasses.replace(e, **change) if pred(e) else e for e in es]
            self.assertNotEqual(out, es, "the edit hit an entry")
            return out
        cases = {
            "a data entry that isn't a plain COPY": edited(lambda e: e.desc == "TABLE DATA" and e.tag == "play_accounts",
                                                           copy="COPY public.play_accounts (id, sid, kind, wid, balance) FROM PROGRAM 'id';\n"),
            "a setval that runs more": edited(lambda e: e.desc == "SEQUENCE SET",
                                              defn="SELECT pg_catalog.setval('public.play_spaces_sid_seq', 1, true); SELECT pg_sleep(1);\n"),
            "another schema": edited(lambda e: e.desc == "FUNCTION" and e.tag == "play_append_only()", namespace="evil"),
            "a function body changed": edited(lambda e: e.desc == "FUNCTION" and e.tag == "play_append_only()",
                                              defn=next(e.defn for e in es if e.tag == "play_append_only()").replace("RAISE EXCEPTION", "RETURN NEW; --")),
        }
        cases["an entry twice"] = es + [next(e for e in es if e.desc == "TRIGGER")]
        for what, entries in cases.items():
            with self.subTest(what=what):
                with self.assertRaises(UnsafeBackup):
                    playdb.check(entries)

    def test_the_counts_and_audit_answers_are_read_strictly(self):
        self.assertEqual(playdb._ints("0|0|0|0|0\n", 5), (0, 0, 0, 0, 0))
        self.assertIsNone(playdb._ints("0|0\n", 5))
        self.assertIsNone(playdb._ints("ERROR: x\n", 1))


class AstraG1(unittest.TestCase):
    """astra on G1 (04c3b7d): SQL riding on a data entry's text or on a schema entry's data stream, entries in another
    section or tablespace, an id twice, the archive's own order, and untrusted counts in backup.json."""

    def test_sql_riding_along_is_refused(self):
        es = toc("play-v2")

        def edited(pred, **change):
            out = [dataclasses.replace(e, **change) if pred(e) else e for e in es]
            self.assertNotEqual(out, es)
            return out
        first = lambda desc: (lambda e, seen=[]: e.desc == desc and not seen and not seen.append(1))  # noqa: E731
        cases = {
            "a data entry with SQL text": edited(first("TABLE DATA"), defn="SELECT pg_sleep(1);\n"),
            "a schema entry with a data stream": edited(first("TRIGGER"), had_data=True),
            "a data entry without its data": edited(first("TABLE DATA"), had_data=False),
            "a trigger moved to the data section": edited(first("TRIGGER"), section=3),
            "a table in a tablespace": edited(first("TABLE"), tablespace="evil"),
            "an id twice": es + [dataclasses.replace(next(e for e in es if e.desc == "INDEX"))],
            "a skipped kind with a data stream": edited(first("DATABASE"), had_data=True),
        }
        for what, entries in cases.items():
            with self.subTest(what=what):
                with self.assertRaises(UnsafeBackup):
                    playdb.check(entries)

    def test_the_restore_order_is_ours_not_the_archives(self):
        es = toc("play-v2")
        by_id = {e.id: e for e in es}
        ids = playdb.check(list(reversed(es)))  # triggers first, data last: the archive's choice
        kinds = [by_id[i].desc for i in ids]
        self.assertLess(max(j for j, k in enumerate(kinds) if k == "TABLE"), min(j for j, k in enumerate(kinds) if k == "TABLE DATA"))
        self.assertLess(max(j for j, k in enumerate(kinds) if k == "TABLE DATA"), min(j for j, k in enumerate(kinds) if k == "TRIGGER"),
                        "the triggers come after every row (they would fire on each restored row otherwise)")

    def test_untrusted_counts_are_refused_before_anything_runs(self):
        import asyncio
        self.assertIsNone(playdb.valid_counts([]))
        self.assertIsNone(playdb.valid_counts({"wallets": "3"}))
        self.assertIsNone(playdb.valid_counts({k: True for k in playdb.COUNT_NAMES}))
        ok = {k: 1 for k in playdb.COUNT_NAMES}
        self.assertEqual(playdb.valid_counts({**ok, "extra": 9}), ok)

        async def no_docker(*a, **k):
            raise AssertionError("nothing may run for a backup whose record is malformed")
        with mock.patch.object(dbcheck, "_sh", side_effect=no_docker):
            for bad in ([], {"wallets": "x"}, "counts"):
                with self.subTest(bad=bad), self.assertRaises(UnsafeBackup):
                    asyncio.run(playdb.isolated(FIX / "play-v2.dump", Path("/tmp/playdb-test-unused"), "postgres:17-alpine", bad))

    def test_the_restore_hooks_contain_every_error(self):
        i = (_OPT / "manager" / "tinhat" / "install.py").read_text()
        seg = i[i.index('if (root / "play.dump").is_file():'):]
        self.assertIn("except Exception as e:", seg[:1200], "not only UnsafeBackup/OSError: a malformed record too")
        b = (_OPT / "manager" / "tinhat" / "backup.py").read_text()
        seg = b[b.index("pdump = next(work.rglob(\"play.dump\"), None)"):]
        self.assertIn("except Exception as e:", seg[:900])


class Swap(unittest.TestCase):
    """astra G1 r2: the swap is never destructive. A failing second rename (the replacement in use) renames the old
    games database back, and the replacement is dropped only after that."""

    def test_a_failing_rename_puts_the_old_database_back(self):
        import asyncio
        import tempfile
        sqls = []

        async def run(*args, stdin=None, timeout=600):
            text = (stdin or b"").decode(errors="replace")
            sqls.append(text)
            if "pg_roles" in text and "rolsuper" in text:
                return 0, "1\n"
            if "count(*)" in text and "play_accounts a" in text:  # AUDIT
                return 0, "0|0|0|0|0\n"
            if "play_wallets" in text:  # COUNT
                return 0, "3|3|6|30|30\n"
            if f"ALTER DATABASE {playdb.STAGE} RENAME TO tinhat_play" in text:
                return 1, "ERROR:  database is being accessed by other users"
            return 0, ""

        async def prepare():
            return True, "ready"
        with tempfile.TemporaryDirectory() as d:
            dump = Path(d) / "checked.dump"
            dump.write_bytes(b"PGDMP fake")
            with self.assertRaises(RuntimeError) as cm:
                asyncio.run(playdb.load(dump, run=run, prepare=prepare))
        self.assertIn("the old one is back", str(cm.exception))
        joined = "".join(sqls)
        self.assertNotIn("DROP DATABASE IF EXISTS tinhat_play WITH", joined, "the live games database is never dropped")
        i_back = joined.index(f"ALTER DATABASE {playdb.PREV} RENAME TO tinhat_play")
        i_drop_stage = joined.rindex(f"DROP DATABASE IF EXISTS {playdb.STAGE}")
        self.assertLess(i_back, i_drop_stage, "the old one is back BEFORE the replacement is dropped")

    def test_ensure_brings_the_old_database_back_after_a_crash_between_the_renames(self):
        from tinhat import play
        self.assertIn("RENAME TO %I', 'tinhat_play_prev', :'db')", play.ENSURE_SQL)
        self.assertLess(play.ENSURE_SQL.index("tinhat_play_prev"), play.ENSURE_SQL.index("CREATE DATABASE"),
                        "the old one comes back before an empty one could be created in its place")


class Hooks(unittest.TestCase):
    def test_the_backup_and_the_restores_carry_the_games_database(self):
        man = _OPT / "manager" / "tinhat"
        b = (man / "backup.py").read_text()
        self.assertIn('play_meta = await playdb.dump_to(STAGING / "play.dump")', b)
        self.assertIn('meta["play"] = play_meta', b)
        self.assertIn("await playdb.isolated(pdump, work / \"playcheck\"", b, "the test restore checks it the same way")
        i = (man / "install.py").read_text()
        self.assertIn('await playdb.isolated(root / "play.dump"', i)
        self.assertIn("pc = await playdb.load(pdump)", i)
        # never a reason to stop a server restore
        seg = i[i.index("pdump = config.STATE_DIR / \"restore\" / \"play.dump\""):]
        self.assertIn("except Exception as e:", seg[:900])

    def test_a_failing_games_dump_never_fails_the_backup(self):
        import asyncio

        async def no(*a, **k):
            raise OSError("no database")
        import tempfile
        with tempfile.TemporaryDirectory() as d, mock.patch.object(playdb, "exists", side_effect=no):
            target = Path(d) / "play.dump"
            r = asyncio.run(playdb.dump_to(target))
            self.assertFalse(target.exists())
        self.assertEqual(r["ok"], False)


if __name__ == "__main__":
    unittest.main()
