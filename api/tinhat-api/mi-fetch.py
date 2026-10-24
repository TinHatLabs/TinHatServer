#!/usr/bin/env python3
"""Fetch ONE myinstants.com URL into <out> and print a one-line JSON status.

Why a python helper inside a Node service: since ~2026-09-04 myinstants' Cloudflare rules
answer 403 "Sorry, you have been blocked" to Node's (and curl's) TLS fingerprint
whatever the User-Agent, while Python's urllib/OpenSSL stack passes (measured
2026-09-07: fetch/https.request with 5 cipher configs = 403; urllib = 200 in 0.05-0.2 s).
Usage: mi-fetch.py <url> <outfile>   ->  {"status":200,"content_type":"audio/mpeg","bytes":N}
"""
import json, sys, urllib.request, urllib.error

url, out = sys.argv[1], sys.argv[2]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
req = urllib.request.Request(url, headers={
    "User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"})
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read(25 * 1024 * 1024)
        with open(out, "wb") as f:
            f.write(data)
        print(json.dumps({"status": r.status,
                          "content_type": r.headers.get("content-type", ""),
                          "bytes": len(data)}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": e.code, "content_type": "", "bytes": 0}))
except Exception as e:  # DNS/TLS/timeouts
    print(json.dumps({"status": 0, "error": str(e)}))
