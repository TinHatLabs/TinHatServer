"""Run the box's services (docker compose, project `tinhat`). Images are baked into the appliance image, so
nothing is ever pulled here (`--pull never`): first boot and setup work without internet."""
import asyncio
import json

from . import config

SERVICES = ["caddy", "postgres", "synapse", "livekit", "lk-jwt", "api", "games"]
LABELS = {
    "caddy": "Web server (HTTPS)",
    "postgres": "Database",
    "synapse": "Chat server",
    "livekit": "Calls: sound and video",
    "lk-jwt": "Calls: who may join",
    "api": "Tin Hat extras (soundboard, GIFs, presence, push, …)",
    "games": "Games catalogue",
}


def base() -> list[str]:
    return ["docker", "compose", "--ansi", "never", "-p", "tinhat", "-f", str(config.COMPOSE_FILE), "--env-file", str(config.COMPOSE_ENV)]


async def run(*args: str, timeout: float = 600, stdin: bytes | None = None) -> tuple[int, str]:
    """stdin: bytes fed to the command (psql reads SQL there so it can interpolate a quoted variable)."""
    proc = await asyncio.create_subprocess_exec(*base(), *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                stdin=asyncio.subprocess.PIPE if stdin is not None else None)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"docker compose {' '.join(args)} timed out after {int(timeout)} s"
    return proc.returncode or 0, out.decode(errors="replace")


async def up(*services: str) -> tuple[int, str]:
    return await run("up", "-d", "--no-build", "--pull", "never", "--remove-orphans", *services)


async def restart(service: str) -> tuple[int, str]:
    return await run("restart", service, timeout=180)


async def logs(service: str, lines: int = 40) -> str:
    _, out = await run("logs", "--no-color", "--no-log-prefix", "--tail", str(lines), service, timeout=30)
    return out


async def ps() -> dict[str, dict]:
    """service → {state, health, status} for every service compose knows about (running or not)."""
    rc, out = await run("ps", "--all", "--format", "json", timeout=30)
    if rc != 0:
        return {}
    items = []
    out = out.strip()
    if out.startswith("["):
        try:
            items = json.loads(out)
        except ValueError:
            items = []
    else:
        for line in out.splitlines():
            try:
                items.append(json.loads(line))
            except ValueError:
                continue
    res = {}
    for it in items:
        svc = it.get("Service") or it.get("Name", "")
        res[svc] = {"state": it.get("State", ""), "health": it.get("Health", ""), "status": it.get("Status", "")}
    return res


async def caddy_validate(path_in_container: str) -> tuple[int, str]:
    """Let Caddy itself check a config before it goes live (a broken one must never replace a working one)."""
    return await run("run", "--rm", "--no-deps", "-T", "caddy", "caddy", "validate", "--config", path_in_container,
                     "--adapter", "caddyfile", timeout=120)


async def caddy_reload(force: bool = False) -> tuple[int, str]:
    """force: load the config even when it didn't change, so certificate management starts over at once (after a
    failed certificate, Caddy otherwise waits out its own growing retry delay)."""
    rc, out = await run("exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
                        *(["--force"] if force else []), timeout=60)
    if rc != 0:  # a Caddy that never got a valid config can't reload; a restart reads the file fresh
        rc, out = await restart("caddy")
    return rc, out
