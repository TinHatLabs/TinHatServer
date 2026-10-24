"""tinhat-manager: `python3 -m tinhat` (systemd: tinhat-manager.service)."""
import asyncio
import logging
import sys

from aiohttp import web

from . import config
from .web import bring_up, build_app, startup_checks


def after_update() -> int:
    """`python3 -m tinhat after-update`: run by the updater with the NEW release's code, after its files are in place
    and before the services restart: pending migrations, then every generated config written again."""
    from . import install, migrations
    done = migrations.run_pending()
    changed = install.refresh_configs()
    print(f"migrations: {', '.join(done) or 'none'}; configs changed: {', '.join(changed) or 'none'}")
    return 0


def main() -> None:
    if sys.argv[1:2] == ["adopt"]:  # `tinhat adopt-synapse DIR OWNER` (adopt.py), with the manager stopped
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
        from . import adopt
        sys.exit(adopt.main(sys.argv[2:]))
    if sys.argv[1:2] == ["after-update"]:
        logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(levelname)s %(name)s: %(message)s")
        sys.exit(after_update())
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    startup_checks()
    app = build_app()

    async def _up(_app):
        asyncio.create_task(bring_up())

    app.on_startup.append(_up)
    web.run_app(app, host=config.LISTEN_HOST, port=config.LISTEN_PORT, print=None, access_log=None)


if __name__ == "__main__":
    main()
