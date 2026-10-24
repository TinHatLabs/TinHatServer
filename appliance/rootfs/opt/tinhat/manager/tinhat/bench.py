"""Quick measurements of the box itself, a few seconds in total.

cpu():  how fast one processor core, and all of them, compress chat-like data with zlib. Compressing and parsing
        messages is the kind of work a chat server does, and unlike hashing or encryption it isn't sped up by
        special CPU instructions, so old and new machines compare fairly.
disk(): how fast the disk writes 128 MB, and how long a database-style commit (write 4 KB + fsync) takes. Every
        message the server stores waits on a commit; SD cards and USB sticks are slow here, SSDs fast.
The browser measures the network side itself (web.py's /admin/setup/speed/* endpoints).
"""
import os
import random
import statistics
import time
import zlib
from concurrent.futures import ThreadPoolExecutor

_sample: bytes | None = None
_WORDS = ("hey anyone up for a game tonight i can host after dinner the new map looks great did you see the patch notes "
          "lol that was close next round we push mid bring snacks call in five minutes my mic is fixed now sounds good "
          "screen share the build order who has the key photo from the trip happy birthday see you saturday").split()
_NAMES = ("alex", "sam", "dana", "jamie", "morgan", "riley", "casey", "jordan")


def _data() -> bytes:
    """1 MiB of chat-shaped JSON: compressible like real traffic, never the same twice in a row."""
    global _sample
    if _sample is None:
        rnd = random.Random(7)
        parts, size = [], 0
        while size < 1 << 20:
            body = " ".join(rnd.choice(_WORDS) for _ in range(rnd.randint(3, 16)))
            line = ('{"type":"m.room.message","sender":"@%s:home.local","content":{"body":"%s"},"origin_server_ts":%d}\n'
                    % (rnd.choice(_NAMES), body, rnd.randint(10 ** 12, 2 * 10 ** 12)))
            parts.append(line)
            size += len(line)
        _sample = "".join(parts).encode()
    return _sample


def _compress_rate(seconds: float) -> float:
    data = _data()
    done = 0
    t0 = time.perf_counter()
    while True:
        zlib.compress(data, 6)  # releases the GIL, so threads really run on all cores
        done += len(data)
        elapsed = time.perf_counter() - t0
        if elapsed >= seconds:
            return done / elapsed / 1e6


def cpu(seconds: float = 1.0) -> dict:
    single = _compress_rate(seconds)
    n = os.cpu_count() or 1
    with ThreadPoolExecutor(n) as ex:
        multi = sum(ex.map(lambda _: _compress_rate(seconds), range(n)))
    return {"single": round(single, 1), "multi": round(multi, 1), "cores": n}


def disk(path: str, mb: int = 128) -> dict:
    p = os.path.join(path, f".tinhat-disk-test-{os.getpid()}")
    chunk = os.urandom(4 << 20)
    small = os.urandom(4096)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        t0 = time.perf_counter()
        for _ in range(mb // 4):
            os.write(fd, chunk)
        os.fsync(fd)
        write = mb / (time.perf_counter() - t0)
        lat = []
        for _ in range(40):
            t = time.perf_counter()
            os.write(fd, small)
            os.fsync(fd)
            lat.append((time.perf_counter() - t) * 1000)
    finally:
        os.close(fd)
        os.unlink(p)
    return {"write": round(write, 1), "commit_ms": round(statistics.median(lat), 2)}


def run(path: str) -> dict:
    t0 = time.perf_counter()
    out = {"cpu": cpu(), "disk": disk(path)}
    out["seconds"] = round(time.perf_counter() - t0, 1)
    return out
