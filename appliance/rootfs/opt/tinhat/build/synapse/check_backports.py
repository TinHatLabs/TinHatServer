"""Run by provision.sh inside the built (or reused) Synapse image (python - < this file): exits 1 unless the image
carries every fix of build/synapse/backports/ (GHSA-6wjm, -27p5, -qcjr, -r66v, -95fh, -fp53, -8q93, our size limit
on the actions of built-in push rules and our rate limit on push rule writes) and
the pinned Pillow / msgpack. The patched files must hash to the series' results (the same table as backports/FILES;
test_synapse_backports.py keeps the two equal), and each one's default .pyc must be a checked-hash cache of exactly
that source: this Python's magic number, the source's hash, and code equal to the source compiled here (a header
alone proves nothing about the code behind it). A few fixes are also checked by behaviour: a remote 401 / M_UNKNOWN_TOKEN is no longer relayed as such, the push rule limits exist with
upstream's defaults, the WorkerLock retry interval has its ceiling."""
import ast
import hashlib
import importlib.metadata
import importlib.util
import marshal
import sys
from pathlib import Path

PATCHED = {
    "api/errors.py": "d55bdec66cf816bb4bdca92a865e491f86f67a36c94a72a9e711c5f845657bbc",
    "config/_base.pyi": "c376b8f2d4ceecb532a529f13b1403ec883a4d9c5d48dce98c7e78babdb1072c",
    "config/_util.py": "da8f079374b1acf25a0d7d8fc844282fab88659d61c337c984bca1380e3a6319",
    "config/homeserver.py": "76909ef35415322df47e9bfdc2f785c081ee63a6294368cce7cf2563de24bcd3",
    "config/push_rules.py": "20f83715f58802517e41f87e0e1aa5b1d8d403d63516b53bfbf010e92346985a",
    "federation/federation_server.py": "6d9cb4e02d75fd3c44bc4aa9079b0179104b5bd25896a715a1b95630349c5a4c",
    "handlers/federation.py": "6e01123f44196d9582ca2470f65f40010b470d08e44336292d6dcbf86db21f1d",
    "handlers/worker_lock.py": "e1384fc2f85f1104ab5b8d99a23866826e21410bd3195f8ab578401138ac77ea",
    "http/site.py": "0a2d751f79a2efcc64aec30b5b892eb5917dcb6f16f16864be8acb932e171e2f",
    "replication/http/_base.py": "9ed4f374252b22bfdf8adaafdb94453f95daacd545c33c869e34a43367038a26",
    "rest/client/push_rule.py": "5d0c543ffe3342985f17463c3c1e75c18391cdf4d051184e57ab85bda65131c6",
    "storage/databases/main/event_federation.py": "091fc74081f2119c4dfa0d5468136287a8a647ecf4f7a4d5fddc680837c2fb01",
    "storage/databases/main/push_rule.py": "17e4b96123d6fabdbf664123acfa135525743724aa4415b1eacc6948901ef5f1",
}
PINS = {"pillow": "13.0.0", "msgpack": "1.2.4"}


def cache_problem(f: Path, data: bytes) -> str:
    pyc = Path(importlib.util.cache_from_source(str(f)))
    b = pyc.read_bytes() if pyc.is_file() else b""
    if len(b) <= 16 or b[:4] != importlib.util.MAGIC_NUMBER:
        return "no .pyc for this Python"
    if int.from_bytes(b[4:8], "little") != 0b11 or b[8:16] != importlib.util.source_hash(data):
        return "its .pyc isn't a checked-hash one of this source"
    try:
        cached = marshal.loads(b[16:])
    except (EOFError, ValueError, TypeError):
        return "its .pyc doesn't load"
    if cached != compile(data, str(f), "exec", dont_inherit=True):
        return "its .pyc holds other code than its source"
    return ""


def built_in_rules_limited(src: str) -> bool:
    """set_push_rule_actions' branch for built-in rules: first the size, then a refusal when it is over the limit."""
    for fn in ast.walk(ast.parse(src)):
        if not (isinstance(fn, ast.FunctionDef) and fn.name == "set_push_rule_actions_txn"):
            continue
        for node in fn.body:
            if isinstance(node, ast.If) and isinstance(node.test, ast.Name) and node.test.id == "is_default_rule":
                b = node.body
                return (len(b) >= 3 and isinstance(b[0], ast.Assign) and isinstance(b[0].value, ast.Call)
                        and getattr(b[0].value.func, "id", "") == "_push_rule_size_for_limits"
                        and isinstance(b[1], ast.If) and isinstance(b[1].test, ast.Compare)
                        and isinstance(b[1].test.ops[0], ast.Gt) and isinstance(b[1].body[0], ast.Raise))
    return False


def asks_the_limiter(stmt: ast.stmt) -> bool:
    call = stmt.value.value if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Await) else None
    want = "self._write_ratelimiter.ratelimit(requester)"
    return isinstance(call, ast.Call) and ast.dump(call) == ast.dump(ast.parse(want, mode="eval").body)


def writes_rate_limited(src: str) -> bool:
    """PushRuleRestServlet's on_PUT and on_DELETE: the statement before the linearizer asks the rate limiter."""
    for cls in ast.walk(ast.parse(src)):
        if isinstance(cls, ast.ClassDef) and cls.name == "PushRuleRestServlet":
            handlers = {f.name: f for f in cls.body if isinstance(f, ast.AsyncFunctionDef)}
            for name in ("on_PUT", "on_DELETE"):
                body = handlers[name].body if name in handlers else []
                at = next((i for i, n in enumerate(body) if isinstance(n, ast.AsyncWith)), 0)
                if at == 0 or "_push_rule_linearizer" not in ast.dump(body[at].items[0]) or not asks_the_limiter(body[at - 1]):
                    return False
            return True
    return False


def main() -> int:
    import synapse

    problems = []
    if synapse.__version__ != "1.145.0":
        problems.append(f"synapse {synapse.__version__}, not 1.145.0")
    root = Path(importlib.util.find_spec("synapse").submodule_search_locations[0])
    for rel, want in PATCHED.items():
        f = root / rel
        data = f.read_bytes() if f.is_file() else b""
        if hashlib.sha256(data).hexdigest() != want:
            problems.append(f"{rel}: not the backported file")
            continue
        if rel.endswith(".py"):
            problem = cache_problem(f, data)
            if problem:
                problems.append(f"{rel}: {problem}")
    rules = root / "storage/databases/main/push_rule.py"
    if not built_in_rules_limited(rules.read_text() if rules.is_file() else ""):
        problems.append("built-in push rules without the size limit")
    servlet = root / "rest/client/push_rule.py"
    if not writes_rate_limited(servlet.read_text() if servlet.is_file() else ""):
        problems.append("push rule writes without the rate limit")
    for name, ver in PINS.items():
        dists = [d for d in importlib.metadata.distributions() if (d.metadata["Name"] or "").lower() == name]
        if [d.version for d in dists] != [ver]:
            problems.append(f"{name}: {[d.version for d in dists]}, want exactly [{ver!r}]")
    import msgpack
    import PIL

    if PIL.__version__ != PINS["pillow"] or ".".join(map(str, msgpack.version)) != PINS["msgpack"]:
        problems.append(f"loaded pillow {PIL.__version__} / msgpack {msgpack.version}")
    if not problems:
        from synapse.api.errors import Codes, HttpResponseException
        from synapse.config.push_rules import PushRulesConfig  # noqa: F401  (GHSA-fp53's config section)
        from synapse.handlers import worker_lock
        from synapse.rest.client.push_rule import _PUSH_RULE_WRITE_LIMIT as w

        e = HttpResponseException(401, "Unauthorized", b'{"errcode": "M_UNKNOWN_TOKEN", "error": "x"}')
        err = e.to_synapse_error()
        if err.code != 400 or err.errcode != Codes.UNKNOWN:
            problems.append(f"a remote 401 still reaches clients as {err.code} {err.errcode}")
        if (w.per_second, w.burst_count) != (0.2, 100):
            problems.append(f"push rule write limit {w.per_second}/s burst {w.burst_count}")
        if worker_lock.WORKER_LOCK_MAX_RETRY_INTERVAL.as_secs() != 60:
            problems.append("WorkerLock retry interval without its 60 s ceiling")
    if problems:
        print("synapse image without the backports: " + "; ".join(problems), file=sys.stderr)
        return 1
    print(f"synapse image: {len(PATCHED)} backported files, pillow {PINS['pillow']}, msgpack {PINS['msgpack']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
