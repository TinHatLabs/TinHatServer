"""Migrations: small, idempotent steps a new release runs once after an update (`python3 -m tinhat after-update`),
before its services restart. Each is `migration_steps/NNN_what.py` with `run() -> str` (what it did, for the log); the ones
already run are listed in /var/lib/tinhat/updates/migrations.json. Most releases need none: generated configs are
written again from state by install.refresh_configs() on every update anyway."""
import importlib.util
import logging
from pathlib import Path

from . import config, state

log = logging.getLogger("tinhat.migrations")

DIR = Path(__file__).with_name("migration_steps")
DONE = config.STATE_DIR / "updates" / "migrations.json"


def run_pending() -> list[str]:
    done = set(state.read_json(DONE, []))
    ran = []
    for f in sorted(DIR.glob("[0-9][0-9][0-9]_*.py")):
        if f.stem in done:
            continue
        spec = importlib.util.spec_from_file_location(f"tinhat.migrations.{f.stem}", f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        what = mod.run()
        log.info("migration %s: %s", f.stem, what)
        done.add(f.stem)
        state.write_json(DONE, sorted(done), 0o644)
        ran.append(f.stem)
    return ran
