"""Tin Hat Relay places in the names service: seats, capacity, keys, allowances and the monthly reset. Database level;
no network.  python3 -m unittest discover -s names/tests"""
import calendar
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tinhat_names.db import DB  # noqa: E402
from tinhat_names.relays import GB, Full, RelayStore, month_of, next_month_name, web_calls  # noqa: E402


def info(ip="11.91.0.50", cap=50, ports=(20000, 20999), net="100.96.0.0/16"):
    first = net.split("/")[0].rsplit(".", 1)[0] + ".1"
    return {"public_ip": ip, "wg": {"endpoint": f"{ip}:51820", "public_key": "R" * 43 + "="}, "tunnel_net": net,
            "tunnel_ip": first, "ports": list(ports), "capacity": cap}


def ts(y, m, d=15):
    return calendar.timegm((y, m, d, 12, 0, 0))


class Seats(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = DB(str(pathlib.Path(self.tmp.name) / "names.db"))
        self.rs = RelayStore(self.db.c)
        self.rs.add_relay("relay1", "https://relay1.tinhat.dev:8443", "/x.token", "/x.crt", info(cap=3, ports=(20000, 20002)))

    def tearDown(self):
        self.tmp.cleanup()

    def test_each_server_gets_its_own_address_and_port(self):
        a = self.rs.create_place("crew", "A" * 43 + "=", "11.91.0.3")
        b = self.rs.create_place("squad", "B" * 43 + "=", "11.91.0.3")
        self.assertEqual((a["tunnel_ip"], a["port"]), ("100.96.0.2", 20000))  # .1 is the relay itself
        self.assertEqual((b["tunnel_ip"], b["port"]), ("100.96.0.3", 20001))
        self.assertEqual(a["relay_id"], "relay1")

    def test_a_freed_seat_is_reused_and_a_full_relay_says_so(self):
        for n in ("crew", "squad", "oakridge"):
            self.rs.create_place(n, n[0].upper() * 43 + "=", None)
        with self.assertRaises(Full):
            self.rs.create_place("maple", "M" * 43 + "=", None)
        self.rs.remove_place("squad")
        p = self.rs.create_place("maple", "M" * 43 + "=", None)
        self.assertEqual((p["tunnel_ip"], p["port"]), ("100.96.0.3", 20001))

    def test_the_least_busy_relay_is_picked_and_draining_ones_are_skipped(self):
        self.rs.add_relay("relay2", "https://relay2.tinhat.dev:8443", "/y.token", "/y.crt", info("11.91.0.51"))
        self.assertEqual(self.rs.create_place("crew", "A" * 43 + "=", None)["relay_id"], "relay1")
        self.assertEqual(self.rs.create_place("squad", "B" * 43 + "=", None)["relay_id"], "relay2")
        self.rs.set_relay("relay2", status="draining")
        self.assertEqual(self.rs.create_place("oakridge", "C" * 43 + "=", None)["relay_id"], "relay1")

    def test_seats_of_servers_long_away_go_back(self):
        self.db.create("crew", "11.91.0.3", None)
        self.db.create("squad", "11.91.0.3", None)
        self.db.set("crew", last_seen=1000.0)
        self.db.set("squad", last_seen=9000.0)
        for n in ("crew", "squad", "ghost"):  # "ghost": a place whose name no longer exists
            self.rs.create_place(n, n[0].upper() * 43 + "=", None)
        self.assertEqual(sorted(r["name"] for r in self.rs.idle(5000.0)), ["crew", "ghost"])
        self.db.set("squad", status="retired")
        self.assertIn("squad", [r["name"] for r in self.rs.idle(5000.0)])

    def test_what_the_relay_carries_follows_the_state(self):
        self.rs.create_place("crew", "A" * 43 + "=", None)
        self.rs.create_place("squad", "B" * 43 + "=", None)
        self.rs.set_place("squad", status="calls-paused")
        d = {p["name"]: p for p in self.rs.desired("relay1", "tinhat.me")}
        self.assertEqual(d["crew"]["fqdn"], "crew.tinhat.me")
        self.assertEqual((d["crew"]["web"], d["crew"]["calls"]), (True, True))
        self.assertEqual((d["squad"]["web"], d["squad"]["calls"]), (True, False))
        self.assertEqual(web_calls("paused"), (False, False))
        self.assertEqual(web_calls("suspended"), (False, False))


class Allowance(unittest.TestCase):
    Q = 100 * GB

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = DB(str(pathlib.Path(self.tmp.name) / "names.db"))
        self.rs = RelayStore(self.db.c)
        self.rs.add_relay("relay1", "https://r", "/t", "/c", info())
        self.oct = ts(2026, 10)
        self.rs.create_place("crew", "A" * 43 + "=", "11.91.0.3", now=self.oct)

    def tearDown(self):
        self.tmp.cleanup()

    def use(self, total, when=None):
        return self.rs.record_usage("crew", total, self.Q, now=when or self.oct)

    def test_warn_then_calls_pause_then_everything_pauses(self):
        self.assertEqual(self.use(50 * GB), [])
        self.assertEqual(self.use(81 * GB), ["warn"])
        self.assertEqual(self.use(90 * GB), [])  # told once a month
        self.assertEqual(self.use(100 * GB), ["calls-paused"])
        self.assertEqual(self.rs.place("crew")["status"], "calls-paused")
        self.assertEqual(self.use(200 * GB), ["paused"])
        self.assertEqual(self.rs.place("crew")["reason"], "quota")

    def test_relay_starting_over_counts_everything_new(self):
        self.use(30 * GB)
        self.use(5 * GB)  # the relay lost its totals (reinstalled): 5 GB are new
        self.assertEqual(self.rs.place("crew")["bytes_month"], 35 * GB)

    def test_a_new_month_starts_at_zero_and_lifts_the_pause(self):
        self.use(150 * GB)
        self.assertEqual(self.rs.place("crew")["status"], "calls-paused")
        out = self.rs.rollover(now=ts(2026, 11, 1))
        self.assertEqual(out, {"crew": ["back"]})
        p = self.rs.place("crew")
        self.assertEqual((p["status"], p["bytes_month"], p["month"], p["warned"]), ("active", 0, "2026-11", 0))
        # the relay's running total carries on; only what's new counts for November
        self.assertEqual(self.use(151 * GB, ts(2026, 11, 2)), [])
        self.assertEqual(self.rs.place("crew")["bytes_month"], 1 * GB)

    def test_a_suspension_by_the_team_outlasts_the_month(self):
        self.rs.set_place("crew", status="suspended", reason="abuse report")
        self.assertEqual(self.use(250 * GB), [])
        self.rs.rollover(now=ts(2026, 11, 1))
        self.assertEqual(self.rs.place("crew")["status"], "suspended")

    def test_a_bigger_allowance_lifts_the_pause_at_once(self):
        self.use(120 * GB)
        self.rs.set_place("crew", quota_bytes=200 * GB)
        self.assertEqual(self.rs.recheck_quota("crew", self.Q), ["back"])
        self.assertEqual(self.rs.place("crew")["status"], "active")
        self.rs.set_place("crew", quota_bytes=None)  # back to the default: over it again
        self.assertEqual(self.rs.recheck_quota("crew", self.Q), ["calls-paused"])

    def test_turning_the_relay_off_and_on_keeps_the_count_the_allowance_and_a_suspension(self):
        self.use(60 * GB)
        self.rs.set_place("crew", quota_bytes=70 * GB)
        self.rs.remove_place("crew")
        p = self.rs.create_place("crew", "B" * 43 + "=", None, now=self.oct)
        self.assertEqual((p["bytes_month"], p["quota_bytes"], p["status"]), (60 * GB, 70 * GB, "active"))
        self.rs.set_place("crew", status="suspended", reason="abuse report")
        self.rs.remove_place("crew")
        p = self.rs.create_place("crew", "C" * 43 + "=", None, now=self.oct)
        self.assertEqual((p["status"], p["reason"]), ("suspended", "abuse report"))
        # next month: the count starts at zero, the allowance and the suspension stay
        self.rs.remove_place("crew")
        p = self.rs.create_place("crew", "D" * 43 + "=", None, now=ts(2026, 11, 3))
        self.assertEqual((p["bytes_month"], p["quota_bytes"], p["status"]), (0, 70 * GB, "suspended"))

    def test_a_suspension_while_the_relay_is_off_applies_when_it_comes_back(self):
        self.rs.remove_place("crew")
        self.rs.remember_suspension("crew", "abuse report")
        self.assertEqual(self.rs.create_place("crew", "B" * 43 + "=", None, now=self.oct)["status"], "suspended")
        self.rs.remove_place("crew")
        self.rs.remember_suspension("crew", None)
        self.assertEqual(self.rs.create_place("crew", "C" * 43 + "=", None, now=self.oct)["status"], "active")

    def test_month_names(self):
        self.assertEqual(month_of(ts(2026, 12, 31)), "2026-12")
        self.assertEqual(next_month_name(ts(2026, 12, 31)), "1 January")
        self.assertEqual(next_month_name(ts(2026, 10, 18)), "1 November")


if __name__ == "__main__":
    unittest.main()
