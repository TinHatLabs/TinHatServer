"""A thin async client for the box's own Synapse (http://127.0.0.1:8008 — never exposed: Caddy does not proxy
/_synapse/admin, so the admin API is reachable only from the box itself)."""
import hashlib
import hmac
from urllib.parse import quote

import aiohttp

from . import config


class Synapse:
    def __init__(self, base: str = config.SYNAPSE_URL):
        self.base = base
        self._s: aiohttp.ClientSession | None = None

    async def _session(self) -> aiohttp.ClientSession:
        if self._s is None or self._s.closed:
            self._s = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
        return self._s

    async def close(self) -> None:
        if self._s and not self._s.closed:
            await self._s.close()

    async def req(self, method: str, path: str, token: str | None = None, json=None,
                  client: str | None = None) -> tuple[int, dict]:
        s = await self._session()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        if client:  # whose request this really is: Synapse's per-address limits count that browser, not the manager
            headers["X-Forwarded-For"] = client
        async with s.request(method, self.base + path, json=json, headers=headers) as r:
            try:
                body = await r.json(content_type=None)
            except Exception:  # noqa: BLE001 — a proxy error page, an empty body…
                body = {"error": (await r.text())[:300]}
            return r.status, body if isinstance(body, dict) else {"data": body}

    async def healthy(self) -> bool:
        try:
            s = await self._session()
            async with s.get(self.base + "/health", timeout=aiohttp.ClientTimeout(total=5)) as r:
                return r.status == 200
        except (aiohttp.ClientError, TimeoutError, OSError):
            return False

    # ---- accounts ---------------------------------------------------------------------------------------------

    async def register_with_secret(self, shared_secret: str, username: str, password: str, admin: bool,
                                   displayname: str | None = None) -> tuple[int, dict]:
        """Synapse's shared-secret registration (what register_new_matrix_user does)."""
        st, body = await self.req("GET", "/_synapse/admin/v1/register")
        if st != 200:
            return st, body
        nonce = body["nonce"]
        # HMAC-SHA1 over nonce \0 username \0 password \0 ("admin" | "notadmin")
        mac = hmac.new(shared_secret.encode(), digestmod=hashlib.sha1)
        mac.update(b"\x00".join(p.encode() for p in (nonce, username, password, "admin" if admin else "notadmin")))
        payload = {"nonce": nonce, "username": username, "password": password, "admin": admin, "mac": mac.hexdigest()}
        if displayname:
            payload["displayname"] = displayname
        return await self.req("POST", "/_synapse/admin/v1/register", json=payload)

    async def login(self, user: str, password: str, device_name: str, client: str | None = None) -> tuple[int, dict]:
        return await self.req("POST", "/_matrix/client/v3/login", json={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": user},
            "password": password,
            "initial_device_display_name": device_name,
        }, client=client)

    async def logout(self, token: str) -> None:
        try:
            await self.req("POST", "/_matrix/client/v3/logout", token=token, json={})
        except aiohttp.ClientError:
            pass

    async def whoami(self, token: str) -> str | None:
        try:
            st, body = await self.req("GET", "/_matrix/client/v3/account/whoami", token=token)
        except aiohttp.ClientError:
            return None
        return body.get("user_id") if st == 200 else None

    async def user(self, mxid: str, admin_token: str) -> tuple[int, dict]:
        return await self.req("GET", f"/_synapse/admin/v2/users/{quote(mxid, safe='')}", token=admin_token)

    async def is_admin(self, mxid: str, admin_token: str) -> bool:
        st, body = await self.user(mxid, admin_token)
        return st == 200 and body.get("admin") is True

    async def set_user(self, mxid: str, admin_token: str, **fields) -> tuple[int, dict]:
        return await self.req("PUT", f"/_synapse/admin/v2/users/{quote(mxid, safe='')}", token=admin_token, json=fields)

    async def users(self, admin_token: str) -> list[dict]:
        out, frm = [], "0"
        while frm is not None and len(out) < 5000:
            st, body = await self.req("GET", f"/_synapse/admin/v2/users?from={frm}&limit=200&guests=false", token=admin_token)
            if st != 200:
                break
            out += body.get("users", [])
            frm = body.get("next_token")
        return out

    async def room_count(self, admin_token: str) -> int | None:
        st, body = await self.req("GET", "/_synapse/admin/v1/rooms?limit=1", token=admin_token)
        return body.get("total_rooms") if st == 200 else None

    # ---- invite codes (registration tokens) ----------------------------------------------------------------------

    async def tokens(self, admin_token: str) -> tuple[int, dict]:
        return await self.req("GET", "/_synapse/admin/v1/registration_tokens", token=admin_token)

    async def token_new(self, admin_token: str, body: dict) -> tuple[int, dict]:
        return await self.req("POST", "/_synapse/admin/v1/registration_tokens/new", token=admin_token, json=body)

    async def token_delete(self, admin_token: str, code: str) -> tuple[int, dict]:
        return await self.req("DELETE", f"/_synapse/admin/v1/registration_tokens/{quote(code, safe='')}", token=admin_token)
