#!/bin/bash
# seal.sh — the last step inside the build VM: leave the machine exactly as a user first boots it (not set up,
# no keys, no build account, DHCP on any wired card, no cloud-init), then power off.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

systemctl stop tinhat-manager || true
if [ -f /var/lib/tinhat/compose.env ]; then
  docker compose -p tinhat -f /opt/tinhat/compose.yaml --env-file /var/lib/tinhat/compose.env down --remove-orphans --volumes || true
fi
docker container prune -f >/dev/null
docker network prune -f >/dev/null
# Fail closed: a container's config keeps its environment (the setup's passwords) and a volume its data.
left=$(docker ps -aq)
[ -z "$left" ] || { echo "containers still there after the teardown: $(docker ps -a --format '{{.Names}}' | xargs)" >&2; exit 1; }
left=$(docker volume ls -q)
[ -z "$left" ] || { echo "volumes still there after the teardown: $(xargs <<<"$left")" >&2; exit 1; }
[ ! -d /var/lib/tinhat ] || find /var/lib/tinhat -mindepth 1 -delete  # the build's setup state (its passwords), dot files too
rm -f /etc/issue.d/50-tinhat.issue

# Networking: out with cloud-init's static build address, in with systemd-networkd DHCP (rootfs/etc/systemd/network).
apt-get -y -q purge cloud-init >/dev/null || true
rm -rf /etc/cloud /var/lib/cloud /etc/netplan/*cloud-init* /etc/network/interfaces.d/*cloud-init* /run/systemd/network/*netplan*
if dpkg -s netplan.io >/dev/null 2>&1; then apt-get -y -q purge netplan.io >/dev/null || true; fi
if [ -f /etc/network/interfaces ]; then printf 'auto lo\niface lo inet loopback\nsource /etc/network/interfaces.d/*\n' > /etc/network/interfaces; fi
systemctl enable systemd-networkd systemd-resolved

# No remote login until someone asks for it (the dashboard will offer it later); no build account.
systemctl mask ssh.service ssh.socket >/dev/null 2>&1 || true
rm -f /etc/ssh/ssh_host_*
rm -f /etc/sudoers.d/90-cloud-init-users
if id tinhatbuild >/dev/null 2>&1; then
  loginctl terminate-user tinhatbuild >/dev/null 2>&1 || true
  pkill -KILL -u tinhatbuild >/dev/null 2>&1 || true
  sleep 1
  userdel -r tinhatbuild 2>/dev/null || userdel -f tinhatbuild
fi
passwd -l root >/dev/null
# cloud-init also put the build key into root's authorized_keys (with a "log in as tinhatbuild" command): out with it.
rm -rf /root/.ssh

# A fresh identity on first boot.
hostnamectl set-hostname tinhat
sed -i -E 's/^127\.0\.1\.1.*/127.0.1.1\ttinhat/' /etc/hosts
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
# The random seed: stopping the service saves it, so stop first, then delete (every image would share it otherwise).
systemctl stop systemd-random-seed.service
if systemctl is-active -q systemd-random-seed.service; then echo "systemd-random-seed is still running" >&2; exit 1; fi
rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret

# Clean up and hand the free space back (smaller image).
apt-get -y -q autoremove --purge >/dev/null
apt-get clean
# The account files' backup copies: the build account's removal (and the purges, which remove system users) left them.
rm -f /etc/passwd- /etc/group- /etc/shadow- /etc/gshadow- /etc/subuid- /etc/subgid-
rm -rf /var/lib/apt/lists/* /root/payload /root/.bash_history
find /tmp /var/tmp -mindepth 1 -delete  # dot files too
rm -f /root/seal.sh /root/seal.log  # this script and its own log (still open, so the last lines go nowhere)
# The journal: from here to the power-off it goes to /run only (it would log the build network's addresses on the way
# down), and nothing of the build's journal stays on the disk. /var/log/journal itself stays: persistent from first boot.
journalctl --relinquish-var
rm -rf /var/log/journal/*
find /var/log -type f \( -name '*.gz' -o -name '*.1' -o -name '*.old' -o -name '*.journal' -o -name '*.journal~' \) -delete
find /var/log -type f -exec truncate -s 0 {} +
# Deleted files keep their contents in the free blocks (0.3.0's image still held cloud-init's /etc/hosts and network
# config there). build.sh seal zeroes every free block from the host once the VM is off (zerofree on the unmounted
# disk), and export refuses a disk where one still holds data: a fill from in here can't reach them all (ext4 holds
# reserved clusters back from it, and whatever the power-off writes and deletes comes after it). The trim only hands
# most of the free space back to the host's volume first.
sync
fstrim -av || true
echo "sealed — powering off"
systemctl poweroff
