"""Tin Hat: GHSA-8q93-326v-3m7g failing-first check, inside Synapse's own harness (one homeserver, SQLite).

A waiter on a contended lock retries on a timer as well as on release notifications. Stock 1.145 doubles that timer
without a ceiling (5 s, 10 s, ... 2560 s after an hour), so a waiter that misses the notification sits idle for up to
the whole interval after the lock is free. The fix caps the interval at 60 s (+-10 % jitter). Here the lock is held
at the store level (its release sends no notification, the missed-notification case), for an hour, then released;
the waiter must hold the lock within 70 s."""
import os

import synapse
from twisted.internet import defer

from synapse.storage.databases.main.lock import _RENEWAL_INTERVAL

from tests import unittest


class WorkerLockRetryCap(unittest.HomeserverTestCase):
    def test_waiter_notices_a_silent_release_within_the_cap(self) -> None:
        self.assertTrue(synapse.__file__.startswith(os.environ["TINHAT_SYNPATCH_DIR"] + "/"), synapse.__file__)
        store = self.hs.get_datastores().main
        handler = self.hs.get_worker_locks_handler()
        holder = self.get_success(store.try_acquire_lock("tinhat_cap", "k"))
        assert holder is not None
        waiter = handler.acquire_lock("tinhat_cap", "k")
        d = defer.ensureDeferred(waiter.__aenter__())
        self.assertNoResult(d)
        step = _RENEWAL_INTERVAL.as_secs()  # the holder's renewal keeps running, as in a real server
        end = self.reactor.seconds() + 3600
        while self.reactor.seconds() < end:
            self.reactor.advance(step)
        self.assertNoResult(d)  # still contended after an hour
        self.get_success(holder.release())  # a store-level release: no notification reaches the waiter
        waited = 0
        while not d.called and waited < 4 * 3600:
            self.reactor.advance(1)
            waited += 1
        print("WAITED_AFTER_RELEASE", waited)
        self.assertTrue(d.called, "the waiter never took the free lock")
        self.assertLessEqual(waited, 70)
        self.get_success(waiter.__aexit__(None, None, None))
