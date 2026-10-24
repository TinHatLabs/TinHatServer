"""When the certificate doesn't arrive (setup's own-domain step, a move to an own domain): the details are Caddy's
certificate lines, not every request it couldn't pass on, and the hint names the likely cause instead of always
blaming the API token (install.cert_log / cert_hint).

Runs anywhere: the modules install.py imports are stubbed.
    python3 -m unittest discover -s appliance/tests
"""
import importlib.util
import json
import pathlib
import sys
import types
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "rootfs/opt/tinhat/manager/tinhat"


def load():
    saved = {k: v for k, v in sys.modules.items() if k in ("aiohttp", "aiohttp.abc") or k == "tinhat" or k.startswith("tinhat.")}
    try:
        aio = types.ModuleType("aiohttp")
        abc = types.ModuleType("aiohttp.abc")
        abc.AbstractResolver = object
        aio.abc = abc
        sys.modules.update({"aiohttp": aio, "aiohttp.abc": abc})
        pkg = types.ModuleType("tinhat")
        pkg.__path__ = [str(PKG)]
        sys.modules["tinhat"] = pkg
        for m in ("apiconf", "compose", "config", "console", "environment", "hw", "names", "owndomain", "relay", "state", "templates"):
            sys.modules[f"tinhat.{m}"] = types.ModuleType(f"tinhat.{m}")
        syn = types.ModuleType("tinhat.synapse")
        syn.Synapse = object
        sys.modules["tinhat.synapse"] = syn
        spec = importlib.util.spec_from_file_location("tinhat.install", PKG / "install.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["tinhat.install"] = mod
        spec.loader.exec_module(mod)
        return mod
    finally:
        for k in [k for k in sys.modules if k in ("aiohttp", "aiohttp.abc") or k == "tinhat" or k.startswith("tinhat.")]:
            del sys.modules[k]
        sys.modules.update(saved)


install = load()
line = lambda logger, msg, error=None: json.dumps({"level": "error", "logger": logger, "msg": msg, **({"error": error} if error else {})})  # noqa: E731


class CertLog(unittest.TestCase):
    def test_only_the_certificate_lines(self):
        log = "\n".join([line("http.log.error", "dial tcp 127.0.0.1:8008: connect: connection refused")] * 50 +
                        [line("tls.obtain", "could not get certificate from issuer", "lookup acme-v02.api.letsencrypt.org: no such host"),
                         "not json", line("http.acme_client", "challenge failed")])
        out = install.cert_log(log)
        self.assertEqual(len(out), 2)
        self.assertTrue(out[0].startswith("tls.obtain: could not get certificate") and "no such host" in out[0])


class CertHint(unittest.TestCase):
    def test_the_likely_cause(self):
        ca = ["tls.obtain: could not get certificate (Get https://acme-v02.api.letsencrypt.org/directory: dial tcp: "
              "lookup acme-v02.api.letsencrypt.org: no such host)"]
        self.assertIn("certificate authority", install.cert_hint(ca, "Cloudflare"))
        api = ["tls.obtain: presenting for challenge (dial tcp: lookup api.cloudflare.com: no such host)"]
        self.assertIn("couldn't reach Cloudflare", install.cert_hint(api, "Cloudflare"))
        refused = ["tls.obtain: presenting for challenge (cloudflare: HTTP 403: Authentication error)"]
        self.assertIn("refused the change", install.cert_hint(refused, "Cloudflare"))
        self.assertIn("limiting", install.cert_hint(["tls.obtain: urn:acme:error:rateLimited: too many certificates"], "deSEC"))
        self.assertIn("API token", install.cert_hint([], "Porkbun"))  # nothing to go on: the old advice
        self.assertEqual(install.cert_hint([], None), "")


if __name__ == "__main__":
    unittest.main()
