"""`tinhat adopt-synapse DIR OWNER`: bring a Synapse that ran elsewhere under THIS server's name into this Tin Hat
Server. Its database, media and signing key replace the ones setup made; everyone keeps their account, their
sessions (the tokens live in the database) and their encryption; nothing is renamed. For a server that was set up
with the same server name first (typically "My own domain → my own reverse proxy"), run with the manager stopped (the
`tinhat` command does that). DIR holds:

  synapse.dump     pg_dump -Fc of the old Synapse's database, from the same Synapse version this server runs
  signing.key      the old server's signing key (its identity to other servers)
  media_store/     Synapse's media store (people's files and avatars)
  api/             optional: the Tin Hat API's data to carry over into /var/lib/tinhat/api (uploads/, cache/, games/,
                   vapid.json, push-owners.json, guests.json, guest-accounts.json, gameservers.json, pelican.key,
                   vods.secret)

OWNER: the account (@user:server) made a Synapse admin, so it can sign in to the dashboard (setup's admin account
disappears with setup's database).

Order, so that a failure leaves a working server: checks (the dump reads, the key and media are there, the server
is set up and its name is the dump's); a copy of the current database into DIR/before-adopt.dump; chat and the
extras stop; the database is replaced in one transaction (move.py's restore); the signing key and the media store
are swapped (the old ones kept beside them); every push registration is pointed at this box's push gateway; chat
starts; the box's own system account is made again (the dashboard works through its token); the owner is made an
admin; the API's files are written again and the extras start. If the database was replaced and a later step fails,
the copy goes back and the old key and media return.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import apiconf, compose, config, install, move, state
from .synapse import Synapse

API_ITEMS = ["uploads", "cache", "games", "watch", "vapid.json", "push-owners.json", "guests.json", "guest-accounts.json",
             "gameservers.json", "pelican.key", "invite-operators.json", "vods.secret"]
# Only Tin Hat's own web-push registrations move to this box's gateway (other apps' pushers keep their own gateways);
# the top-level "url" is set structurally.
PUSH_APP_ID = "dev.tinhat.web"  # the Tin Hat API's push gateway (api/tinhat-api/push.mjs PUSH.APP_ID)
PUSH_SQL = ("UPDATE pushers SET data = jsonb_set(data::jsonb, '{{url}}', to_jsonb('{url}'::text))::text "
            f"WHERE kind = 'http' AND app_id = '{PUSH_APP_ID}'")


class AdoptError(Exception):
    def __init__(self, msg: str, details: str = ""):
        super().__init__(msg)
        self.details = details


def say(**kw) -> None:
    print(json.dumps(kw), flush=True)


async def _sql(sql: str, timeout: float = 600) -> tuple[int, str]:
    return await compose.run("exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "synapse", "-d", "synapse",
                             "-tAc", sql, timeout=timeout)


async def _dump_current(to: Path) -> None:
    # Account tokens and password hashes are in there: created root-only and never over an existing file.
    fd = os.open(to, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as f:
        proc = await asyncio.create_subprocess_exec(*compose.base(), "exec", "-T", "postgres", "pg_dump", "-Fc", "-U", "synapse",
                                                    "-d", "synapse", stdout=f, stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(proc.communicate(), 3600)
    if proc.returncode != 0 or to.stat().st_size == 0:
        raise AdoptError("Couldn't make a copy of the current database first.", err.decode(errors="replace")[-600:])


def _checks(d: Path, owner: str) -> tuple[dict, str]:
    st = state.load_state()
    if st.get("phase") != "ready" or not st.get("server_name"):
        raise AdoptError("Set this server up first (the setup page), with the old server's name, then adopt.")
    sn = st["server_name"]
    if not owner.startswith("@") or ":" not in owner or not owner.endswith(":" + sn):
        raise AdoptError(f"OWNER must be an account on this server, like @you:{sn}.")
    for name in ("synapse.dump", "signing.key"):
        if not (d / name).is_file() or (d / name).stat().st_size == 0:
            raise AdoptError(f"{d / name} is missing (see the module's notes for what DIR holds).")
    os.chmod(d, 0o700)  # the safety copies made here hold tokens and password hashes
    if not (d / "media_store").is_dir():
        raise AdoptError(f"{d / 'media_store'} is missing.")
    key = (d / "signing.key").read_text().split()
    if len(key) < 3 or key[0] != "ed25519":
        raise AdoptError("signing.key doesn't look like a Synapse signing key (ed25519 <id> <key>).")
    return st, sn


async def _swap_files(d: Path, syn: Path, undo: list) -> None:
    key, media = syn / "signing.key", syn / "media_store"
    key_bak, media_bak = syn / "signing.key.before-adopt", syn / "media_store.before-adopt"
    if key.exists():
        shutil.copy2(key, key_bak)
    state.write_text(key, (d / "signing.key").read_text(), 0o600)
    undo.append(("key", key_bak, key))
    if media_bak.exists():
        shutil.rmtree(media_bak)
    if media.exists():
        media.rename(media_bak)
    undo.append(("media", media_bak, media))
    r = subprocess.run(["cp", "-a", str(d / "media_store"), str(media)], capture_output=True, text=True, timeout=6 * 3600)
    if r.returncode != 0:
        raise AdoptError("Couldn't copy the media store.", r.stderr[-600:])
    install._chown_tree(syn, config.SYNAPSE_UID)


def _undo_files(undo: list) -> None:
    for kind, bak, live in reversed(undo):
        try:
            if kind == "key" and bak.exists():
                shutil.copy2(bak, live)
            elif kind == "media":
                if live.exists():
                    shutil.rmtree(live)
                if bak.exists():
                    bak.rename(live)
        except OSError as e:
            say(warning=f"undo {kind}: {e}")


def _copy_api(d: Path) -> list[str]:
    src = d / "api"
    if not src.is_dir():
        return []
    apiconf.ensure_dirs()
    done = []
    for item in API_ITEMS:
        p = src / item
        if not p.exists():
            continue
        dst = apiconf.DIR / item
        if p.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(p, dst)
        else:
            shutil.copy2(p, dst)
            dst.chmod(0o600)
        done.append(item)
    return done


async def _wait_chat(synapse: Synapse) -> None:
    for i in range(300):
        if await synapse.healthy():
            return
        if i and i % 10 == 0:
            ps = (await compose.ps()).get("synapse", {})
            if ps.get("state") in ("exited", "dead"):
                raise AdoptError("The chat server stopped after the database was replaced.", move._tail(await compose.logs("synapse")))
        await asyncio.sleep(1)
    raise AdoptError("The chat server didn't come up within 5 minutes.", move._tail(await compose.logs("synapse")))


async def run(d: Path, owner: str) -> int:
    st, sn = _checks(d, owner)
    s = state.load_secrets()
    synapse = Synapse()
    syn = config.SYNAPSE_DIR
    say(phase="checks", server=sn)
    rc, out = await move._pg_restore_list(d / "synapse.dump")
    if rc != 0:
        raise AdoptError("synapse.dump can't be read (is it a pg_dump -Fc of the Synapse database?).", move._tail(out))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    before = d / f"before-adopt-{stamp}.dump"
    say(phase="stopping chat and the extras")
    rc, out = await compose.run("stop", "synapse", "api", "games", timeout=300)
    if rc != 0:
        await compose.up("synapse", "api", "games")
        raise AdoptError("Chat and the extras didn't stop, so nothing was changed.", move._tail(out))
    say(phase="copy of the current database", to=str(before))
    await move._wait_postgres()
    try:
        await _dump_current(before)
    except Exception:
        await compose.up("synapse", "api", "games")
        raise
    secrets_before = config.SECRETS_FILE.read_bytes()
    api_before = d / f"api-before-adopt-{stamp}"
    if apiconf.DIR.exists():
        shutil.copytree(apiconf.DIR, api_before, symlinks=True)
    undo: list = []
    replaced = False
    try:
        say(phase="database")
        try:
            await move._restore_db(d / "synapse.dump")
        except move.MoveError as e:
            raise AdoptError(str(e), getattr(e, "details", "")) from e
        replaced = True
        rc, out = await _sql("SELECT name FROM users WHERE name LIKE '@%' ORDER BY creation_ts LIMIT 20")
        names = [n for n in out.split() if n.startswith("@")] if rc == 0 else []
        if not names or any(not n.endswith(":" + sn) for n in names):
            raise AdoptError(f"The database isn't a {sn} server's (accounts like {names[:2]}): nothing adopted.")
        gw = apiconf.env_text(sn, s, apiconf.docker_gateway()).split("PUSH_GATEWAY_URL=")[1].splitlines()[0]
        if "'" in gw:
            raise AdoptError("The push gateway's address looks wrong.")
        rc, out = await _sql(PUSH_SQL.format(url=gw))
        if rc != 0:
            raise AdoptError("Couldn't point Tin Hat's push registrations at this server.", move._tail(out))
        say(phase="push registrations", pointed_at=gw, result=out.strip()[-40:])
        say(phase="signing key and media")
        await _swap_files(d, syn, undo)
        say(phase="starting chat")
        rc, out = await compose.up("synapse")
        if rc != 0:
            raise AdoptError("The chat server didn't start.", move._tail(out))
        await _wait_chat(synapse)
        say(phase="the box's system account")
        token = None
        st_, body = await synapse.register_with_secret(s["registration_shared_secret"], config.SYSTEM_LOCALPART, s["system_password"],
                                                       True, "Tin Hat Server")
        if st_ == 200:
            token = body.get("access_token")
        elif body.get("errcode") == "M_USER_IN_USE":
            st_, body = await synapse.login(config.SYSTEM_LOCALPART, s["system_password"], "Tin Hat Server (system)")
            token = body.get("access_token") if st_ == 200 else None
        if not token:
            raise AdoptError(f"Couldn't make the server's system account: {body.get('error', st_)}")
        s = state.save_secrets(system_token=token)
        st_, body = await synapse.set_user(owner, token, admin=True)
        if st_ not in (200, 201):
            raise AdoptError(f"Couldn't make {owner} an admin: {body.get('error', st_)} (is that an account here?)")
        say(phase="the extras", api_items=_copy_api(d))
        st = state.load_state()
        apiconf.write(st, s)
        rc, out = await compose.up("api", "games")
        if rc != 0:
            say(warning=f"the extras didn't start: {move._tail(out)}")
        users = [u for u in await synapse.users(token) if not u.get("name", "").startswith(f"@{config.SYSTEM_LOCALPART}:")]
        rooms = await synapse.room_count(token)
        state.save_state(adopted={"at": int(time.time()), "from": str(d), "owner": owner, "users": len(users), "rooms": rooms})
        say(result="adopted", users=len(users), rooms=rooms, owner=owner, copy_of_the_old_database=str(before))
        return 0
    except Exception as e:  # noqa: BLE001 — any failure (disk full, a timeout, a lost connection) goes back the same way
        details = e.details if isinstance(e, AdoptError) else repr(e)
        say(error=str(e) or type(e).__name__, details=details[-800:])
        say(phase="going back to how it was before")
        await compose.run("stop", "synapse", "api", "games", timeout=300)
        _undo_files(undo)
        state.write_text(config.SECRETS_FILE, secrets_before.decode(), 0o600)
        if api_before.exists():
            shutil.rmtree(apiconf.DIR, ignore_errors=True)
            shutil.copytree(api_before, apiconf.DIR, symlinks=True)
        if replaced:
            try:
                await move._restore_db(before)
            except Exception as e2:  # noqa: BLE001
                say(error=f"the copy from before couldn't be put back either: {e2}. It is in {before}.")
        await compose.up("synapse", "api", "games")
        return 1
    finally:
        await synapse.close()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python3 -m tinhat adopt DIR @owner:server", file=sys.stderr)
        return 2
    try:
        return asyncio.run(run(Path(argv[0]).resolve(), argv[1].strip()))
    except AdoptError as e:
        say(error=str(e), details=e.details)
        return 1
