#!/usr/bin/env python3
"""Fetch ONE myinstants.com URL into <out> and print a one-line JSON status.

Why a python helper inside a Node service: since ~2026-09-04 myinstants' Cloudflare rules
answer 403 "Sorry, you have been blocked" to Node's (and curl's) TLS fingerprint
whatever the User-Agent, while Python's urllib/OpenSSL stack passes (measured
2026-09-07: fetch/https.request with 5 cipher configs = 403; urllib = 200 in 0.05-0.2 s).
Usage: mi-fetch.py <url> <outfile> [max_bytes]
    ->  {"status":200,"content_type":"audio/mpeg","bytes":N}
        {"status":413,"error":"too big"}   the answer is bigger than max_bytes (nothing is kept: never truncated)
        {"status":3xx,"error":"redirect"}  a redirect off https myinstants (followed only within it, at most 3)
Security review 2026-10-26: redirects used to be followed anywhere (the API runs on the host network, so a redirect to
127.0.0.1 would have been fetched), and a clip was cut at 25 MB instead of refused.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

url, out = sys.argv[1], sys.argv[2]
MAX = int(sys.argv[3]) if len(sys.argv) > 3 else 5 * 1024 * 1024
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")


def allowed(target: str) -> bool:
    try:
        p = urllib.parse.urlsplit(target)
        port = p.port
    except ValueError:
        return False
    host = (p.hostname or "").lower()
    return (p.scheme == "https" and port is None and not p.username and not p.password
            and (host == "myinstants.com" or host.endswith(".myinstants.com")))


class StayOnMyinstants(urllib.request.HTTPRedirectHandler):
    max_redirections = 3

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise urllib.error.HTTPError(newurl, code, "redirect", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main() -> None:
    if not allowed(url):
        print(json.dumps({"status": 0, "error": "not a myinstants https URL"}))
        return
    opener = urllib.request.build_opener(StayOnMyinstants)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"})
    try:
        with opener.open(req, timeout=20) as r:
            declared = r.headers.get("content-length") or ""
            if declared.isdigit() and int(declared) > MAX:
                print(json.dumps({"status": 413, "error": "too big", "bytes": 0}))
                return
            data = r.read(MAX + 1)
            if len(data) > MAX:
                print(json.dumps({"status": 413, "error": "too big", "bytes": 0}))
                return
            with open(out, "wb") as f:
                f.write(data)
            print(json.dumps({"status": r.status,
                              "content_type": r.headers.get("content-type", ""),
                              "bytes": len(data)}))
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            print(json.dumps({"status": e.code, "error": "redirect", "bytes": 0}))
        else:
            print(json.dumps({"status": e.code, "content_type": "", "bytes": 0}))
    except Exception as e:  # DNS/TLS/timeouts
        print(json.dumps({"status": 0, "error": str(e)}))


main()
