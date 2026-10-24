"""DNS backend: Cloudflare's v4 API (production), or the lab's mock of it (same API, different base URL and CA).

Every record is DNS-only (never proxied): calls can't go through Cloudflare's proxy, and the proxy would decrypt the
traffic. The service holds the only token; boxes never see it (a Cloudflare token can edit the whole zone).
"""
import ssl

import aiohttp


class DNSError(Exception):
    pass


class Cloudflare:
    def __init__(self, api_base: str, token: str, zone: str, ttl: int = 60, ca_file: str | None = None):
        self.base = api_base.rstrip("/")
        self.token = token
        self.zone = zone
        self.ttl = ttl
        self.zone_id = None
        self.ssl = ssl.create_default_context()
        if ca_file:
            self.ssl.load_verify_locations(ca_file)
        self.session: aiohttp.ClientSession | None = None

    async def start(self):
        self.session = aiohttp.ClientSession(headers={"Authorization": f"Bearer {self.token}"},
                                             timeout=aiohttp.ClientTimeout(total=20))
        zones = await self._req("GET", "/zones", params={"name": self.zone})
        if not zones:
            raise DNSError(f"zone {self.zone} not found (or the token can't see it)")
        self.zone_id = zones[0]["id"]

    async def close(self):
        if self.session:
            await self.session.close()

    async def _req(self, method: str, path: str, **kw):
        async with self.session.request(method, self.base + path, ssl=self.ssl, **kw) as r:
            try:
                body = await r.json(content_type=None)
            except Exception:
                raise DNSError(f"{method} {path}: HTTP {r.status}, not JSON")
        if not body.get("success"):
            msgs = "; ".join(f'{e.get("code")}: {e.get("message")}' for e in body.get("errors") or [])
            raise DNSError(f"{method} {path}: {msgs or r.status}")
        return body.get("result")

    def fqdn(self, label: str | None) -> str:
        return self.zone if not label else f"{label}.{self.zone}"

    async def records(self, name: str | None = None, rtype: str | None = None) -> list[dict]:
        params = {"per_page": "100"}
        if name:
            params["name"] = name
        if rtype:
            params["type"] = rtype
        out, page = [], 1
        while True:
            params["page"] = str(page)
            res = await self._req("GET", f"/zones/{self.zone_id}/dns_records", params=params)
            out += res
            if len(res) < 100:
                return out
            page += 1

    async def set_rrset(self, name: str, rtype: str, values: list, **extra):
        """Make the records of (name, type) exactly `values` (content strings, or CAA data dicts)."""
        have = await self.records(name, rtype)

        def key(v):
            return repr(v) if isinstance(v, dict) else str(v)

        def rkey(r):
            return repr(r.get("data")) if rtype == "CAA" else r.get("content")

        want = {key(v): v for v in values}
        keep = set()
        for r in have:
            k = rkey(r)
            if k in want and k not in keep:
                keep.add(k)
            else:
                await self._req("DELETE", f"/zones/{self.zone_id}/dns_records/{r['id']}")
        for k, v in want.items():
            if k in keep:
                continue
            body = {"type": rtype, "name": name, "ttl": extra.get("ttl", self.ttl), "proxied": False,
                    "comment": extra.get("comment", "tinhat-names")}
            if rtype == "CAA":
                body["data"] = v
            else:
                body["content"] = v
            if rtype == "MX":
                body["priority"] = extra.get("priority", 0)
            await self._req("POST", f"/zones/{self.zone_id}/dns_records", json=body)

    async def delete_all(self, name: str):
        for r in await self.records(name):
            await self._req("DELETE", f"/zones/{self.zone_id}/dns_records/{r['id']}")

    async def baseline(self, apex_ip: str | None, mail: str | None = None):
        """The zone's protective records (see docs/REMOTE-ACCESS.md, "Stopping abuse"). With mail="cloudflare" the
        zone's own MX and SPF belong to Cloudflare Email Routing (abuse@ reaches the team); nothing sends as the zone,
        so DMARC still rejects anything claiming to."""
        z = self.zone
        if not mail:
            await self.set_rrset(z, "MX", ["."], priority=0, ttl=3600, comment="null MX: no mail for any name")
            await self.set_rrset(z, "TXT", ['"v=spf1 -all"'], ttl=3600, comment="no mail")
        await self.set_rrset(f"_dmarc.{z}", "TXT", ['"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"'], ttl=3600,
                             comment="no mail, also for every name under the zone")
        await self.set_rrset(z, "CAA", [{"flags": 0, "tag": "issue", "value": "letsencrypt.org; validationmethods=dns-01"},
                                        {"flags": 0, "tag": "issuewild", "value": ";"}], ttl=3600,
                             comment="certificates only from Let's Encrypt, only via DNS-01 (our API), no wildcards")
        if apex_ip:
            await self.set_rrset(z, "A", [apex_ip], ttl=300, comment="go-to-your-server page")
