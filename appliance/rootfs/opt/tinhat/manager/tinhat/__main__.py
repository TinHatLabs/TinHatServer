"""tinhat-manager: `python3 -m tinhat` (systemd: tinhat-manager.service).

Nothing here imports aiohttp before pyenv.choose() has decided what the manager runs on: Tin Hat's pinned aiohttp in
a venv (the manager is started again on the venv's Python), or the operating system's when the venv isn't ready.
"""
import asyncio
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

from . import config


def pyenv_places() -> dict:
    """Where the manager's pinned aiohttp lives: the wheels ride in the release's manager/ (every updater since 0.2
    copies that folder), the venv is this machine's own (TINHAT_VENV: the Docker Compose image builds its own)."""
    manager = Path(__file__).resolve().parent.parent
    return {"venv": Path(os.environ.get("TINHAT_VENV") or config.OPT / "venv"), "wheels": manager / "wheels",
            "state_dir": config.STATE_DIR, "imports": ("tinhat.web",), "path": manager, "release": config.VERSION}


ENSURE_TIMEOUT = 300  # of the 600 s every updater since 0.2 gives `after-update` as a whole


def ensure_pyenv() -> str:
    """The venv for this release, built now if it isn't yet (after-update, before the manager starts again), in a
    process of its own that is killed, with everything it started, after ENSURE_TIMEOUT. Never fails the caller:
    without the venv the manager runs on the system's aiohttp, and its dashboard says so."""
    from . import pyenv
    cmd = [sys.executable, "-m", "tinhat", "pyenv", "ensure", "--budget", str(ENSURE_TIMEOUT - 30)]
    try:
        p = subprocess.Popen(cmd, cwd=str(pyenv_places()["path"]), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, start_new_session=True, preexec_fn=pyenv.die_with_parent)
        try:
            out, _ = p.communicate(timeout=ENSURE_TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
            return f"pinned aiohttp NOT ready (no answer in {ENSURE_TIMEOUT} s); the manager will run on the system's"
    except OSError as e:
        return f"pinned aiohttp NOT ready ({e}); the manager will run on the system's"
    last = (out or "").strip().splitlines()[-1:] or ["no output"]
    return last[0] if p.returncode == 0 else f"pinned aiohttp NOT ready ({last[0]}); the manager will run on the system's"


def after_update() -> int:
    """`python3 -m tinhat after-update`: run by the updater with the NEW release's code, after its files are in place
    and before the services restart: pending migrations, every generated config written again, the pinned aiohttp."""
    from . import install, migrations
    done = migrations.run_pending()
    changed = install.refresh_configs()
    print(f"migrations: {', '.join(done) or 'none'}; configs changed: {', '.join(changed) or 'none'}; {ensure_pyenv()}")
    return 0


def proxy_addresses(args: list[str], st: dict | None = None, apply=None) -> int:
    """`tinhat proxy-addresses [--set ADDR[,ADDR…] | --clear]`: which address(es) count as the owner's reverse proxy
    (Network → Who counts as your proxy). The console is the way back in when a wrong list locked the dashboard out, so
    it checks no peer: --set names the proxy's address(es) (a public one too), --clear lets any home-network address
    count again (it warns when a named address isn't one: that proxy couldn't connect any more)."""
    from . import owndomain, state
    if apply is None:
        from . import web
        apply = web.apply_proxy_addresses
    st = state.load_state() if st is None else st
    if not state.behind_proxy(st):
        print("This server isn't behind your own reverse proxy.")
        return 1
    named = owndomain.proxies(st)
    if args[:1] == ["--set"] and len(args) >= 2:
        new, problem = owndomain.parse_proxies(" ".join(args[1:]))
        if problem is not None or not new:
            print(problem or "Name at least one address (or use --clear).")
            return 2
    elif args[:1] == ["--clear"] and len(args) == 1:
        new = []
        outside = [a for a in named if not owndomain.proxy_covers(list(owndomain.HOME_RANGES), a.split("/")[0])]
        if outside:
            print(f"Note: {', '.join(outside)} isn't a home-network address; a proxy connecting from there will be "
                  f"refused. Name it with --set instead.")
    elif not args:
        print(", ".join(named) if named else "any home-network address (none named)")
        return 0
    else:
        print("usage: tinhat proxy-addresses [--set ADDR[,ADDR...] | --clear]")
        return 2
    ok, why = asyncio.run(apply(new))
    if not ok:
        print(f"The web server didn't take it; nothing changed.\n{why}")
        return 1
    print(f"Your proxy: {', '.join(new)}." if new else "Any home-network address counts as your proxy again.")
    return 0


def api_limits(args: list[str], st: dict | None = None, apply=None) -> int:
    """`tinhat api-limits [NAME=VALUE … | --reset NAME … | --reset-all]`: the owner's own numbers for the Tin Hat API's
    limits (apiconf.LIMITS, docs/API.md "Who may use the extras"), kept in state and written into the API's environment
    (an edit of the env file itself never lasted). Applying recreates the API's containers."""
    from . import apiconf, state
    st = state.load_state() if st is None else st
    cur = apiconf.limits(st)
    if not args:
        print("\n".join(f"{k}={v}" for k, v in sorted(cur.items())) or "none set: every limit is the API's default (docs/API.md)")
        print("names: " + " ".join(sorted(apiconf.LIMITS)))
        return 0
    new = dict(cur)
    if args == ["--reset-all"]:
        new = {}
    elif args[0] == "--reset" and len(args) > 1:
        for name in args[1:]:
            if name not in apiconf.LIMITS:
                print(f"{name} isn't one of the API's limits (tinhat api-limits lists them).")
                return 2
            new.pop(name, None)
    else:
        for a in args:
            name, eq, value = a.partition("=")
            if not eq or name not in apiconf.LIMITS:
                print(f"{a}: use NAME=VALUE with one of the API's limits (tinhat api-limits lists them).")
                return 2
            val = apiconf.limit_value(name, value)
            if val is None:
                print(f"{a}: {apiconf.limit_help(name)}, please.")
                return 2
            new[name] = val
    if apply is None:
        def apply(limits: dict) -> bool:
            from . import compose
            api = dict(state.load_state().get("api") or {})
            if limits:
                api["limits"] = limits
            else:
                api.pop("limits", None)
            st2 = state.save_state(api=api)
            apiconf.write(st2)
            rc, out = asyncio.run(compose.run("up", "-d", "--no-build", "--pull", "never", "--force-recreate", "api",
                                              "games", timeout=180))
            if rc != 0:
                print(f"The extras didn't restart:\n{out[-800:]}")
            return rc == 0
    if not apply(new):
        return 1
    print("\n".join(f"{k}={v}" for k, v in sorted(new.items())) or "Every limit is the API's default again.")
    return 0


def main() -> None:
    if sys.argv[1:2] == ["api-limits"]:
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
        sys.exit(api_limits(sys.argv[2:]))
    if sys.argv[1:2] == ["proxy-addresses"]:
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
        sys.exit(proxy_addresses(sys.argv[2:]))
    if sys.argv[1:2] == ["adopt"]:  # `tinhat adopt-synapse DIR OWNER` (adopt.py), with the manager stopped
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
        from . import adopt
        sys.exit(adopt.main(sys.argv[2:]))
    if sys.argv[1:2] == ["after-update"]:
        logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(levelname)s %(name)s: %(message)s")
        sys.exit(after_update())
    if sys.argv[1:2] == ["pyenv"]:  # `python3 -m tinhat pyenv build|ensure|check|status|off|on` (image, install.sh, CLI)
        from . import pyenv
        sys.exit(pyenv.cli(sys.argv[2:], **pyenv_places(), prog="tinhat pyenv", name="the manager"))
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(levelname)s %(name)s: %(message)s")
    from . import pyenv
    # may start the manager again on the venv's Python; its start counts as good once it answers on its port
    pyenv.choose(**pyenv_places(), argv=["-m", "tinhat", *sys.argv[1:]], name="the manager", grace=None)

    from aiohttp import web

    from .web import bring_up, build_app, startup_checks

    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    startup_checks()
    app = build_app()

    async def _up(_app):
        asyncio.create_task(bring_up())
        asyncio.create_task(_answering())

    async def _answering():
        """Tell pyenv the start was a good one once the manager answers on its port (its crash guard)."""
        for _ in range(300):
            try:
                _r, w = await asyncio.open_connection(config.LISTEN_HOST, config.LISTEN_PORT)
                w.close()
                pyenv.started()
                return
            except OSError:
                await asyncio.sleep(1)

    app.on_startup.append(_up)
    web.run_app(app, host=config.LISTEN_HOST, port=config.LISTEN_PORT, print=None, access_log=None)


if __name__ == "__main__":
    main()
