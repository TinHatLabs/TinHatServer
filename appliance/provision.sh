#!/bin/bash
# provision.sh — turn a fresh Debian 13 cloud VM into the Tin Hat Server appliance.
# Runs as root inside the build VM, with internet. Input: /root/payload/{rootfs/, web/, VERSION}.
# Safe to run again (the dev loop re-runs it after changes).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
P=/root/payload
step() { echo; echo "== $*"; }

step "packages"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade
apt-get -y -q -o Dpkg::Options::=--force-confold install --no-install-recommends \
  docker.io docker-cli docker-compose python3 python3-aiohttp avahi-daemon systemd-resolved qemu-guest-agent \
  avahi-utils unattended-upgrades cloud-guest-utils ca-certificates curl jq iproute2 less e2fsprogs minisign \
  restic cifs-utils exfatprogs nftables wireguard-tools
# nftables only for the `nft` command (command-line access's firewall table); its own service stays off: its
# default ruleset starts with `flush ruleset`, which would wipe Docker's rules. wireguard-tools: the Tin Hat relay's
# tunnel (relay.py) uses `wg show` for its health; systemd-networkd does the rest.
docker compose version

step "files"
cp -a "$P/rootfs/." /
chmod 0755 /usr/local/sbin/tinhat /usr/local/sbin/tinhat-growroot /usr/local/sbin/tinhat-avahi-ifaces
# Replace the contents, never the directory: Caddy's bind mount holds on to the directory itself.
install -d -m 0755 /opt/tinhat/web
find /opt/tinhat/web -mindepth 1 -delete
cp -a "$P/web/." /opt/tinhat/web/
install -m 0644 "$P/VERSION" /opt/tinhat/VERSION
install -d -m 0700 /var/lib/tinhat
find /opt/tinhat -name __pycache__ -prune -exec rm -rf {} +

step "the pinned aiohttp (manager/wheels → /opt/tinhat/venv)"
# Debian's python3-aiohttp (above) stays as the fallback (tinhat/pyenv.py). The image's own venv must pass its whole
# check here, compiled parts included, or there is no image.
(cd /opt/tinhat/manager && python3 -m tinhat pyenv build --strict)

step "container images (baked in, so first boot needs no internet)"
# Restart, not just start: apt already started Docker, before rootfs brought /etc/docker/daemon.json (its networks
# move to 198.18.0.0/15, away from home networks, and LiveKit leaves that range out of its call addresses).
systemctl enable docker
systemctl restart docker
# build.sh REUSE_IMAGES_FROM: an earlier release's exact image instead of a new build (same id: servers on that release
# already have it). Prints the loaded reference, or nothing when there's no tarball for NAME.
load_reused() {
  [ -f "$P/reuse/tinhat-$1.tar.gz" ] || return 0
  local ref id arch got
  ref=$(docker load -q -i "$P/reuse/tinhat-$1.tar.gz" | sed -n 's/^Loaded image: //p' | head -1)
  id=$(cat "$P/reuse/tinhat-$1.id") arch=$(dpkg --print-architecture)
  got=$(docker image inspect -f '{{.Id}} {{.Architecture}}' "$ref" 2>/dev/null) || got=""
  # the very image that release shipped, for this processor (its id begins with what the file's name says)
  case "$id" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) echo "reused tinhat-$1: no image id in its name" >&2; exit 1 ;; esac
  case "$got" in
    "sha256:$id"*" $arch") echo "$ref" ;;
    *) echo "reused tinhat-$1: loaded '$ref' = '$got', expected sha256:$id… $arch" >&2; exit 1 ;;
  esac
}
# Our own Caddy (stock + DNS modules) is built here; everything else is pulled at its pinned tag.
CADDY_REF=$(load_reused caddy)
if [ -n "$CADDY_REF" ]; then
  [ "$CADDY_REF" = tinhat/caddy:2.10.2-dns ] || docker tag "$CADDY_REF" tinhat/caddy:2.10.2-dns
  echo "caddy: reused $CADDY_REF ($(docker image inspect -f '{{.Id}}' tinhat/caddy:2.10.2-dns))"
else
  docker build -q -t tinhat/caddy:2.10.2-dns /opt/tinhat/build/caddy
fi
for m in acmedns cloudflare porkbun desec duckdns; do
  docker run --rm tinhat/caddy:2.10.2-dns caddy list-modules | grep -q "^dns.providers.$m\$" || { echo "caddy is missing dns.providers.$m" >&2; exit 1; }
done
docker image rm -f caddy:2.10.2-builder >/dev/null 2>&1 || true
# The Tin Hat API (api/ in the repository: the soundboard, GIFs, presence, push, game servers, the games catalogue).
API_TAG="tinhat/api:$(cat "$P/VERSION")"
API_REF=$(load_reused api)
if [ -n "$API_REF" ]; then
  docker tag "$API_REF" "$API_TAG"
  [ "$API_REF" = "$API_TAG" ] || docker image rm "$API_REF" >/dev/null  # the old tag only: the image stays as $API_TAG
  echo "api: reused $API_REF as $API_TAG ($(docker image inspect -f '{{.Id}}' "$API_TAG"))"
else
  docker build -q -t "$API_TAG" /opt/tinhat/build/api
fi
docker run --rm "$API_TAG" node -e 'import("express").then(() => console.log("api image: express ok"))'
docker run --rm "$API_TAG" python3 -c 'import urllib.request; print("api image: python ok")'
docker run --rm "$API_TAG" ffmpeg -version | head -1
docker image rm -f node:22-bookworm-slim >/dev/null 2>&1 || true  # only the build's base: servers never run it
docker builder prune -af >/dev/null 2>&1 || true
for img in $(awk '$1 == "image:" {print $2}' /opt/tinhat/compose.yaml); do
  case "$img" in tinhat/*) continue ;; esac
  docker pull -q "$img"
done
docker image rm -f caddy:2.10.2 >/dev/null 2>&1 || true  # only the build's base: servers never run it
docker image prune -f >/dev/null
# The lock lists exactly what compose.yaml runs (servers on their own machines download every line of it).
{ for img in $(awk '$1 == "image:" {print $2}' /opt/tinhat/compose.yaml); do
    case "$img" in tinhat/*) continue ;; esac
    echo "$img $(docker image inspect -f '{{index .RepoDigests 0}}' "$img" | cut -d@ -f2)"
  done
  echo "tinhat/caddy:2.10.2-dns $(docker image inspect -f '{{.Id}}' tinhat/caddy:2.10.2-dns) ($(docker run --rm tinhat/caddy:2.10.2-dns caddy version | cut -d' ' -f1), caddy-dns: acmedns v0.7.0 cloudflare v0.2.4 porkbun v0.3.1 desec v1.1.0 duckdns v0.5.0)"
  echo "$API_TAG $(docker image inspect -f '{{.Id}}' "$API_TAG") (the Tin Hat API, node 22)"; } \
  | sort > /opt/tinhat/images.lock
cat /opt/tinhat/images.lock

step "services"
# The console shows the setup code; keep systemd's SSH-over-vsock generator from printing warnings on it.
mkdir -p /etc/systemd/system-generators
ln -sfn /dev/null /etc/systemd/system-generators/systemd-ssh-generator
sysctl -q -p /etc/sysctl.d/90-tinhat.conf || true
systemctl daemon-reload
systemctl enable tinhat-manager tinhat-growroot avahi-daemon qemu-guest-agent unattended-upgrades
systemctl disable --now nftables.service >/dev/null 2>&1 || true  # never: its config flushes Docker's rules
# The agent normally starts at boot (when its virtio port appears); start it now so build.sh can seal through it.
systemctl start qemu-guest-agent || true
hostnamectl set-hostname tinhat
if grep -q '^127\.0\.1\.1' /etc/hosts; then sed -i -E 's/^127\.0\.1\.1.*/127.0.1.1\ttinhat/' /etc/hosts; else sed -i '1a 127.0.1.1\ttinhat' /etc/hosts; fi
systemctl restart avahi-daemon
systemctl restart tinhat-manager
sleep 3
systemctl --no-pager --lines=5 status tinhat-manager | head -12
echo "provisioned: Tin Hat Server $(cat /opt/tinhat/VERSION)"
