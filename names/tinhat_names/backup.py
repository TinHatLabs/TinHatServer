"""Backups of the names service, so tinhat.me names outlive the machine it runs on.

Nightly (deploy/tinhat-names-backup.timer) into an encrypted restic repository OFF this machine (another server over
SFTP, S3 / Backblaze B2, a restic REST server): the database as an online copy (consistent while the service runs),
its settings and keys (the config, the admin and Cloudflare tokens, the proof-of-work key), and an export of the zone
as Cloudflare has it (to rebuild it at another DNS host if the DNS account itself were ever lost). Kept 14 daily,
8 weekly, 12 monthly. `tinhat-names backup --check` restores the newest copy to a scratch folder and opens the
database, the way a real restore would.

A restore (README "Backups and moving"): stop the service, `restic restore latest --target /`, start it. Boxes keep
calling /v1/update every 10 minutes, so names and addresses that changed since the copy catch up by themselves.
"""
import json
import os
import shutil
import sqlite3
import ssl
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

TAG = "tinhat-names"


class BackupError(Exception):
    pass


def _env(cfg: dict) -> dict:
    b = cfg.get("backup") or {}
    if not b.get("repository"):
        raise BackupError("No backup repository is set: add \"backup\": {\"repository\": …} to the config.")
    if not os.path.exists(b["password_file"]):
        raise BackupError(f"The backup password file {b['password_file']} is missing.")
    env = dict(os.environ, RESTIC_REPOSITORY=b["repository"], RESTIC_PASSWORD_FILE=b["password_file"])
    if not env.get("RESTIC_CACHE_DIR") and not env.get("HOME"):  # a service account without a home
        env["RESTIC_CACHE_DIR"] = str(Path(b.get("staging") or "/var/lib/tinhat-names/backup-staging").parent / "restic-cache")
    if b.get("env_file"):  # the storage's own credentials (S3 / B2 keys), KEY=VALUE per line
        for line in Path(b["env_file"]).read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def _restic(cfg: dict, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    try:
        opts = [x for o in (cfg.get("backup") or {}).get("options") or [] for x in ("-o", o)]
        r = subprocess.run(["restic", *opts, *args], env=_env(cfg), capture_output=True, text=True, timeout=3600)
    except FileNotFoundError as e:
        raise BackupError("restic isn't installed (apt install restic).") from e
    if check and r.returncode != 0:
        raise BackupError(f"restic {args[0]}: {(r.stderr or r.stdout).strip()[-400:]}")
    return r


def _zone_export(cfg: dict) -> dict:
    """Every record of the zone, from the DNS provider's API (Cloudflare's v4 API: the real one, or the lab mock)."""
    d = cfg["dns"]
    token = Path(d["token_file"]).read_text().strip()
    ctx = ssl.create_default_context(cafile=d.get("ca_file")) if d.get("ca_file") else ssl.create_default_context()

    def get(path: str) -> dict:
        req = urllib.request.Request(d["api_base"] + path, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return json.load(r)

    zones = get(f"/zones?name={cfg['zone']}").get("result") or []
    if not zones:
        raise BackupError(f"The DNS token can't see the zone {cfg['zone']}.")
    zid, records, page = zones[0]["id"], [], 1
    while True:
        res = get(f"/zones/{zid}/dns_records?per_page=500&page={page}")
        records += [{k: r.get(k) for k in ("type", "name", "content", "ttl", "proxied", "priority", "data", "comment")}
                    for r in res.get("result") or []]
        if page >= int((res.get("result_info") or {}).get("total_pages") or 1):
            break
        page += 1
    return {"zone": cfg["zone"], "exported": int(time.time()), "records": records}


def stage(cfg: dict, cfg_path: str | None) -> dict:
    """Fill the staging folder (a fixed path, so every snapshot has the same layout) with what a restore needs."""
    st = Path((cfg.get("backup") or {}).get("staging") or "/var/lib/tinhat-names/backup-staging")
    shutil.rmtree(st, ignore_errors=True)
    (st / "etc").mkdir(parents=True)
    os.chmod(st, 0o700)
    src = sqlite3.connect(cfg["db"])
    dst = sqlite3.connect(st / "names.db")
    with dst:
        src.backup(dst)  # SQLite's online backup: a consistent copy while the service keeps writing
    names = dst.execute("SELECT status, COUNT(*) FROM names GROUP BY status").fetchall()
    dst.close()
    src.close()
    for f in (cfg_path, cfg["admin_token_file"], cfg["dns"]["token_file"], cfg["secret_key_file"]):
        if f and os.path.exists(f):
            shutil.copy2(f, st / "etc" / Path(f).name)
    try:
        zone = _zone_export(cfg)
        (st / "zone.json").write_text(json.dumps(zone, indent=1))
        zone_n = len(zone["records"])
    except (OSError, ValueError, BackupError) as e:  # the database matters most: back it up even if the API is down
        (st / "zone-error.txt").write_text(f"{e}\n")
        zone_n = None
    meta = {"at": int(time.time()), "names": dict(names), "zone_records": zone_n,
            "files": sorted(p.name for p in (st / "etc").iterdir())}
    (st / "backup.json").write_text(json.dumps(meta, indent=1))
    return {"dir": str(st), **meta}


def _ensure_repo(cfg: dict) -> None:
    if _restic(cfg, "cat", "config", check=False).returncode != 0:
        _restic(cfg, "init")


def backup(cfg: dict, cfg_path: str | None) -> dict:
    meta = stage(cfg, cfg_path)
    try:
        _ensure_repo(cfg)
        r = _restic(cfg, "backup", "--tag", TAG, "--host", "tinhat-names", "--json", meta["dir"])
        snap = next((json.loads(l) for l in r.stdout.splitlines() if '"message_type":"summary"' in l.replace(" ", "")), {})
        keep = (cfg.get("backup") or {}).get("keep") or {}
        _restic(cfg, "forget", "--tag", TAG, "--prune", "--keep-daily", str(keep.get("daily", 14)),
                "--keep-weekly", str(keep.get("weekly", 8)), "--keep-monthly", str(keep.get("monthly", 12)))
    finally:
        shutil.rmtree(meta["dir"], ignore_errors=True)  # it holds tokens: never leave it lying around
    return {**meta, "snapshot": snap.get("snapshot_id"), "added_bytes": snap.get("data_added")}


def check(cfg: dict) -> dict:
    """Prove a restore works: the repository is whole, and the newest copy's database opens and is consistent."""
    _restic(cfg, "check")
    snaps = json.loads(_restic(cfg, "snapshots", "--tag", TAG, "--json").stdout or "[]")
    if not snaps:
        raise BackupError("There's no backup in the repository yet.")
    with tempfile.TemporaryDirectory() as tmp:
        _restic(cfg, "restore", snaps[-1]["id"], "--target", tmp)
        dbs = list(Path(tmp).rglob("names.db"))
        if not dbs:
            raise BackupError("The newest backup has no database in it.")
        db = sqlite3.connect(dbs[0])
        ok = db.execute("PRAGMA integrity_check").fetchone()[0]
        names = db.execute("SELECT COUNT(*) FROM names").fetchone()[0]
        db.close()
        zone = next(Path(tmp).rglob("zone.json"), None)
        zone_n = len(json.loads(zone.read_text())["records"]) if zone else None
    if ok != "ok":
        raise BackupError(f"The newest backup's database isn't consistent ({ok}).")
    return {"snapshot": snaps[-1]["short_id"], "time": snaps[-1]["time"], "names": names, "zone_records": zone_n,
            "snapshots": len(snaps)}


def snapshots(cfg: dict) -> list[dict]:
    return json.loads(_restic(cfg, "snapshots", "--tag", TAG, "--json").stdout or "[]")
