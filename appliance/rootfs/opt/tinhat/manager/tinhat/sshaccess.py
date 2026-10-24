"""Command-line access (SSH), for owners who want it. Off by default (the sealed image masks SSH and has no login).

On: a user `tinhat` with sudo, the owner's public key(s) (a password only if they insist), SSH answering only from the
home network (private and link-local addresses; a firewall table of its own, loaded at boot while SSH is on), root
login off. The dashboard shows the host key fingerprints so the first connection can be checked. Off: SSH stops and is
masked again, the keys are removed and the account locked.
"""
import subprocess
from pathlib import Path

from . import config

USER = "tinhat"
HOME = Path("/home") / USER
SSHD_DROPIN = Path("/etc/ssh/sshd_config.d/50-tinhat.conf")
SUDOERS = Path("/etc/sudoers.d/90-tinhat")
FW_FILE = Path("/etc/tinhat/ssh-firewall.nft")
FW_UNIT = Path("/etc/systemd/system/tinhat-ssh-firewall.service")
KEY_TYPES = ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
             "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com")

FIREWALL = """# Tin Hat Server: SSH only from the home network (written by the dashboard's Command-line access switch).
table inet tinhat_ssh {
  chain input {
    type filter hook input priority -10; policy accept;
    tcp dport 22 ip saddr { 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } accept
    tcp dport 22 ip6 saddr { ::1, fc00::/7, fe80::/10 } accept
    tcp dport 22 drop
  }
}
"""
FW_SERVICE = """[Unit]
Description=Tin Hat Server: allow SSH from the home network only
Before=ssh.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/tinhat/ssh-firewall.nft
ExecStop=/usr/sbin/nft delete table inet tinhat_ssh

[Install]
WantedBy=multi-user.target
"""


class SSHError(Exception):
    pass


def _run(*cmd: str, input: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(list(cmd), input=input, capture_output=True, text=True, timeout=60)
    if check and r.returncode != 0:
        raise SSHError(f"{cmd[0]}: {(r.stderr or r.stdout).strip()[-200:]}")
    return r


def fingerprint(key: str) -> str | None:
    r = subprocess.run(["ssh-keygen", "-l", "-f", "-"], input=key + "\n", capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 else None


def keys() -> list[dict]:
    f = HOME / ".ssh" / "authorized_keys"
    out = []
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                parts = line.split()
                fp = (fingerprint(line) or "").split()
                out.append({"type": parts[0], "comment": " ".join(parts[2:]) if len(parts) > 2 else "",
                            "fingerprint": fp[1] if len(fp) > 1 else ""})
    return out


def host_fingerprints() -> list[str]:
    out = []
    for pub in sorted(Path("/etc/ssh").glob("ssh_host_*_key.pub")):
        fp = _run("ssh-keygen", "-l", "-f", str(pub), check=False).stdout.strip()
        if fp:
            parts = fp.split()
            out.append(f"{parts[1]} ({parts[-1].strip('()')})")
    return out


def enabled() -> bool:
    return _run("systemctl", "is-active", "ssh.service", check=False).stdout.strip() == "active"


def status(addresses: list[str]) -> dict:
    if config.own_machine():  # the owner's own Linux machine: its SSH is theirs, this switch stays out of it
        return {"available": False, "on": False}
    on = enabled()
    return {"available": True, "on": on, "user": USER, "keys": keys() if on else [], "hostKeys": host_fingerprints() if on else [],
            "passwordLogin": on and SSHD_DROPIN.exists() and "PasswordAuthentication yes" in SSHD_DROPIN.read_text(),
            "commands": [f"ssh {USER}@{a}" for a in addresses] if on else []}


def _write_keys(lines: list[str]) -> None:
    d = HOME / ".ssh"
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    f = d / "authorized_keys"
    f.write_text("".join(x.strip() + "\n" for x in lines))
    f.chmod(0o600)
    _run("chown", "-R", f"{USER}:{USER}", str(d))


def check_key(key: str) -> str:
    key = " ".join(key.strip().split())
    if not key.startswith(KEY_TYPES) or len(key) > 16384 or "\n" in key:
        raise SSHError("That doesn't look like an SSH public key. It's one line starting with ssh-ed25519 or ssh-rsa "
                       "(the .pub file, never the private key).")
    if fingerprint(key) is None:
        raise SSHError("That SSH public key isn't valid.")
    return key


def turn_on(key: str | None, password: str | None) -> None:
    if config.own_machine():
        raise SSHError("This server runs on your own Linux machine, so its SSH is yours to set up.")
    if not key and not password:
        raise SSHError("Paste your SSH public key (or set a password).")
    if password is not None and len(password) < 12:
        raise SSHError("Use a password of at least 12 characters for SSH, or better, a key.")
    if password and any(ord(c) < 32 or ord(c) == 127 for c in password):
        # chpasswd reads "user:password" lines: a line break would go on to set another account's password.
        raise SSHError("A password can't contain line breaks or other control characters.")
    lines = [check_key(key)] if key else []
    if _run("id", USER, check=False).returncode != 0:
        _run("useradd", "--create-home", "--shell", "/bin/bash", "--groups", "sudo,docker", USER)
    _run("usermod", "--unlock", "--expiredate", "", USER, check=False)
    if lines:
        existing = [k for k in ((HOME / ".ssh" / "authorized_keys").read_text().splitlines()
                                if (HOME / ".ssh" / "authorized_keys").exists() else []) if k.strip()]
        _write_keys(existing + [x for x in lines if x not in existing])
    if password:
        _run("chpasswd", input=f"{USER}:{password}\n")
    SUDOERS.write_text(f"{USER} ALL=(ALL) NOPASSWD:ALL\n")
    SUDOERS.chmod(0o440)
    SSHD_DROPIN.parent.mkdir(parents=True, exist_ok=True)
    SSHD_DROPIN.write_text("# Written by the Tin Hat Server dashboard (Maintenance -> Command-line access).\n"
                           "PermitRootLogin no\n"
                           f"PasswordAuthentication {'yes' if password else 'no'}\n"
                           "KbdInteractiveAuthentication no\n"
                           f"AllowUsers {USER}\n")
    FW_FILE.parent.mkdir(parents=True, exist_ok=True)
    FW_FILE.write_text(FIREWALL)
    FW_UNIT.write_text(FW_SERVICE)
    _run("ssh-keygen", "-A")  # the sealed image has no host keys
    _run("systemctl", "daemon-reload")
    _run("systemctl", "enable", "--now", "tinhat-ssh-firewall.service")
    _run("systemctl", "unmask", "ssh.service", "ssh.socket", check=False)
    _run("sshd", "-t")
    _run("systemctl", "enable", "--now", "ssh.service")
    _run("systemctl", "restart", "ssh.service")


def add_key(key: str) -> None:
    if not enabled():
        raise SSHError("Turn command-line access on first.")
    key = check_key(key)
    f = HOME / ".ssh" / "authorized_keys"
    existing = [k for k in (f.read_text().splitlines() if f.exists() else []) if k.strip()]
    if key not in existing:
        _write_keys(existing + [key])


def remove_key(fp: str) -> None:
    f = HOME / ".ssh" / "authorized_keys"
    if f.exists():
        _write_keys([k for k in f.read_text().splitlines() if k.strip() and fp not in (fingerprint(k) or "")])


def turn_off() -> None:
    if config.own_machine():
        raise SSHError("This server runs on your own Linux machine, so its SSH is yours to set up.")
    _run("systemctl", "disable", "--now", "ssh.service", "ssh.socket", check=False)
    _run("systemctl", "mask", "ssh.service", "ssh.socket", check=False)
    _run("systemctl", "disable", "--now", "tinhat-ssh-firewall.service", check=False)
    for f in (SSHD_DROPIN, SUDOERS, HOME / ".ssh" / "authorized_keys"):
        f.unlink(missing_ok=True)
    if _run("id", USER, check=False).returncode == 0:
        _run("usermod", "--lock", "--expiredate", "1", USER, check=False)  # locked and expired: no login at all
