#!/bin/bash
# install.sh — Tin Hat Server on a Linux machine of your own: a spare computer, a virtual machine or a rented server
# (VPS) with Debian 13 or Ubuntu 24.04, on 64-bit Intel/AMD or ARM (arm64: a Raspberry Pi 5, an ARM VPS). It installs the same server the Tin Hat Server image runs,
# from the same signed release, and then the setup page in your browser takes over.
#
#   curl -fsSLO __TINHAT_INSTALL_URL__
#   sudo bash install.sh                  the current release
#   sudo bash install.sh --from DIR       a release you copied over yourself (stable.json, stable.json.minisig, the
#                                         .update.tar.gz and the tinhat-caddy-*.tar.gz from the same release)
#   sudo bash install.sh --behind-proxy   this machine's own web server (nginx, Traefik, Caddy, Nginx Proxy Manager)
#                                         keeps ports 80 and 443: setup answers on port 8080, and your proxy sends your
#                                         domain to it afterwards (setup's "My own domain → My own reverse proxy")
#
# Tin Hat Server wants the machine's ports 80 and 443, TCP 7881 and UDP 7882 to itself, so a machine (or VM) of its
# own is easiest; with --behind-proxy it leaves 80 and 443 to the machine's own web server. What this script changes: packages (Docker if it isn't there yet, Python, restic, minisign, …),
# /opt/tinhat, /var/lib/tinhat, two services (tinhat-manager, tinhat-update), the `tinhat` command, one /etc/hosts line
# and a sysctl file for call buffers. It never changes the machine's name, network settings, SSH or firewall, and it
# leaves an existing Docker's settings alone.
# Remove it again: sudo tinhat uninstall
set -euo pipefail
# Where releases come from, tried in order (release.sh fills these in: the project's GitHub releases, then a mirror).
CHANNELS=${TINHAT_CHANNEL:-"__TINHAT_CHANNELS__"}
PUBKEY="__TINHAT_RELEASE_PUBKEY__"  # the release key's public half (release.sh fills it in when it publishes)
FROM="" FORCE=0 BEHIND=0 GIVEN=""

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nTin Hat Server: %s\n' "$*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=$(readlink -f "$2"); shift ;;
    --channel) GIVEN="$GIVEN $2"; shift ;;  # a channel's stable.json (more than one: tried in order)
    --force) FORCE=1 ;;  # try an untested system anyway
    --behind-proxy) BEHIND=1 ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see: bash install.sh --help)" ;;
  esac
  shift
done
[ -n "$GIVEN" ] && CHANNELS=$GIVEN

# ---- can this machine run it? ------------------------------------------------------------------------------------
[ "$(id -u)" = 0 ] || die "Run it as root: sudo bash install.sh"
[ -d /run/systemd/system ] || die "This machine doesn't run systemd, which Tin Hat Server needs."
grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && die "This is Windows (WSL). Use Tin Hat Server for Windows instead."
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  debian:13 | ubuntu:24.04) ;;
  *) [ "$FORCE" = 1 ] || die "Tin Hat Server is tested on Debian 13 and Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. (--force tries anyway.)" ;;
esac
ARCH=$(dpkg --print-architecture)
case "$ARCH" in amd64 | arm64) ;; *) die "Tin Hat Server runs on 64-bit Intel/AMD (amd64) or ARM (arm64) machines; this one is $ARCH." ;; esac
IMAGES=images LOCK=images.lock
[ "$ARCH" = arm64 ] && IMAGES=images_arm64 LOCK=images.lock.arm64
[ -e /opt/tinhat/VERSION ] && die "Tin Hat Server $(cat /opt/tinhat/VERSION) is already installed here. Updates come from its dashboard; to start over: sudo tinhat uninstall"
mem=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
[ "$mem" -ge 1800 ] || die "It needs at least 2 GB of memory; this machine has ${mem} MB."
mkdir -p /var/lib
free=$(df -Pm /var/lib | awk 'NR == 2 {print $4}')
[ "$free" -ge 10000 ] || die "It needs at least 10 GB free for /var/lib; there are ${free} MB."
busy="" web=""
for p in 80 443; do ss -Hltn "sport = :$p" | grep -q . && web="$web TCP $p"; done
for p in 7881 7880 8008 8070 8080 8090; do ss -Hltn "sport = :$p" | grep -q . && busy="$busy TCP $p"; done
ss -Hlun "sport = :7882" | grep -q . && busy="$busy UDP 7882"
[ -z "$busy" ] || die "These ports are already in use on this machine:$busy. Tin Hat Server needs them, so a machine
(or virtual machine) of its own is easiest. \`sudo ss -ltnup\` shows what uses them."
if [ -n "$web" ] && [ "$BEHIND" = 0 ]; then
  die "Ports 80 and 443 are in use on this machine ($(ss -Hltnp 'sport = :443' | grep -o 'users:(("[^"]*' | cut -d'"' -f2 | head -1)).
If that's your reverse proxy (nginx, Traefik, Caddy, Nginx Proxy Manager), run this again with --behind-proxy: Tin Hat
Server then leaves 80 and 443 to it, and your proxy sends your domain to Tin Hat. Otherwise a machine (or virtual
machine) of its own is easiest."
fi
if ! command -v docker >/dev/null; then
  FRESH_DOCKER=1
elif docker compose version >/dev/null 2>&1; then
  FRESH_DOCKER=0
else
  die "Docker is installed but without its compose plugin. Install it (docker-compose-plugin from Docker's repository, or docker-compose-v2 on Ubuntu), then run this again."
fi
src=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}') \
  || die "This machine has no way out to the internet (no default route), and installing needs it. Check its network settings, then run this again."
# --behind-proxy is for a proxy on THIS machine: Tin Hat then has no HTTPS of its own, and its parts check sign-ins at
# its name, which leads to this machine's address ($src) and so to that proxy. With the proxy on another computer (or
# listening only on another address) calls could never sign in. Only when ss can tell; --force skips it.
if [ "$BEHIND" = 1 ] && [ "$FORCE" = 0 ] && command -v ss >/dev/null; then
  if ! ss -Hltn "sport = :443" | awk -v src="$src" '{n = split($4, p, ":"); a = substr($4, 1, length($4) - length(p[n]) - 1)}
       a == "0.0.0.0" || a == "*" || a == "[::]" || a == src {found = 1} END {exit !found}'; then
    die "--behind-proxy is for a reverse proxy on THIS machine, and nothing answers on port 443 at this machine's
address ($src). If your reverse proxy runs on another computer, run this again without --behind-proxy: at setup choose
My own domain, then My own reverse proxy (it handles HTTPS), and point your proxy at this machine's port 8080. If
you're about to set up the proxy on this machine, add --force."
  fi
fi
HOME_NET=0
case "$src" in 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.6[4-9].* | 100.[7-9]?.* | 100.1[01]?.* | 100.12[0-7].*) HOME_NET=1 ;; esac

# ---- packages ------------------------------------------------------------------------------------------------------
say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
pkgs=(python3 python3-aiohttp ca-certificates curl jq iproute2 minisign restic cifs-utils exfatprogs wireguard-tools)
if [ "$FRESH_DOCKER" = 1 ]; then
  [ "$ID" = debian ] && pkgs+=(docker.io docker-cli docker-compose) || pkgs+=(docker.io docker-compose-v2)
fi
# On a home network, people find a home-network server as <name>.local (mDNS); a rented server doesn't need it.
[ "$HOME_NET" = 1 ] && pkgs+=(avahi-daemon avahi-utils)
apt-get install -y -q --no-install-recommends "${pkgs[@]}"
if [ "$FRESH_DOCKER" = 1 ]; then
  # Docker came with us, so its networks can go where the image keeps them (away from home networks; the call server
  # never offers addresses there). An existing Docker keeps its own settings.
  install -d -m 0755 /etc/docker
  [ -e /etc/docker/daemon.json ] || cat > /etc/docker/daemon.json <<'J'
{
  "bip": "198.18.0.1/24",
  "default-address-pools": [{"base": "198.18.16.0/20", "size": 24}],
  "log-driver": "json-file",
  "log-opts": {"max-size": "10m", "max-file": "3"}
}
J
  systemctl enable docker >/dev/null
  systemctl restart docker
fi
docker compose version >/dev/null || die "Docker's compose plugin doesn't answer."

# ---- the release ---------------------------------------------------------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch() {  # fetch NAME DEST: NAME is relative to the channel (or a full URL: a GitHub release names its own files)
  case "$1" in
    https://*) if [ -n "$FROM" ]; then cp "$FROM/${1##*/}" "$2"; else curl -fsSL "$1" -o "$2"; fi ;;
    *) if [ -n "$FROM" ]; then cp "$FROM/$1" "$2"; else curl -fsSL "${CHANNEL%/*}/$1" -o "$2"; fi ;;
  esac
}
signed() {  # the release's list, from the first channel whose answer carries our signature
  minisign -Vq -P "$PUBKEY" -m "$TMP/stable.json" -x "$TMP/stable.json.minisig" 2>/dev/null
}
say "The release"
case "$PUBKEY" in __*) die "This copy of install.sh has no release key in it; download it again from the release page." ;; esac
ok=0 bad=0
if [ -n "$FROM" ]; then
  CHANNEL=stable.json
  fetch stable.json "$TMP/stable.json" && fetch stable.json.minisig "$TMP/stable.json.minisig" || die "$FROM has no stable.json and stable.json.minisig."
  signed && ok=1 || bad=1
else
  case "$CHANNELS" in __*) CHANNELS=https://updates.tinhat.dev/server/stable.json ;; esac
  for CHANNEL in $CHANNELS; do
    for _ in 1 2; do  # twice: a release that lands between the two downloads looks unsigned once
      fetch "$(basename "$CHANNEL")" "$TMP/stable.json" 2>/dev/null && fetch "$(basename "$CHANNEL").minisig" "$TMP/stable.json.minisig" 2>/dev/null || continue 2
      signed && { ok=1; break 2; }
    done
    bad=1
  done
fi
[ "$ok" = 1 ] || { [ "$bad" = 1 ] && die "The release's signature doesn't check out, so nothing was installed."; die "Couldn't download the release (from: $CHANNELS). Is this machine online?"; }
VER=$(jq -r .version "$TMP/stable.json")
fetch "$(jq -r .bundle.url "$TMP/stable.json")" "$TMP/bundle.tgz"
echo "$(jq -r .bundle.sha256 "$TMP/stable.json")  $TMP/bundle.tgz" | sha256sum -c --quiet - \
  || die "The download is damaged (its checksum doesn't match the signed list)."
mkdir "$TMP/b"
tar -C "$TMP/b" -xzf "$TMP/bundle.tgz"
[ -d "$TMP/b/manager" ] && [ -d "$TMP/b/host" ] && [ "$(cat "$TMP/b/VERSION")" = "$VER" ] \
  || die "That isn't a Tin Hat Server $VER release for Linux machines."
echo "Tin Hat Server $VER (signature and checksum OK)"

say "Container images (the first time takes a few minutes)"
jq -e --arg k "$IMAGES" 'has($k)' "$TMP/stable.json" >/dev/null || die "Tin Hat Server $VER isn't out for $ARCH machines yet."
[ -f "$TMP/b/$LOCK" ] || die "This release has no $ARCH build."
for ref in $(jq -r --arg k "$IMAGES" '.[$k] | keys[]' "$TMP/stable.json"); do
  id=$(jq -r --arg k "$IMAGES" --arg r "$ref" '.[$k][$r].id' "$TMP/stable.json")
  if ! docker image inspect "$id" >/dev/null 2>&1; then
    fetch "$(jq -r --arg k "$IMAGES" --arg r "$ref" '.[$k][$r].url' "$TMP/stable.json")" "$TMP/image.tgz"
    echo "$(jq -r --arg k "$IMAGES" --arg r "$ref" '.[$k][$r].sha256' "$TMP/stable.json")  $TMP/image.tgz" | sha256sum -c --quiet - \
      || die "The download of $ref is damaged."
    docker load -q -i "$TMP/image.tgz" >/dev/null
    rm -f "$TMP/image.tgz"
  fi
done
cp "$TMP/b/$LOCK" "$TMP/lock"
while read -r ref digest _; do
  repo=${ref%:*}
  # only what compose.yaml runs (older releases' locks also listed the base image our Caddy is built from)
  awk -v r="$ref" '$1 == "image:" && $2 == r {f = 1} END {exit !f}' "$TMP/b/compose.yaml" || continue
  case "$repo" in
    tinhat/*) if ! docker image inspect "$digest" >/dev/null 2>&1; then
                # Docker's containerd image store (Docker 29, Ubuntu 24.04) names a loaded image its own way. The
                # tarball was checked against the signed list, so the tag it brought is our image: note its id here.
                local_id=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null) || die "Our own image $ref is missing from the release."
                sed -i "s|^$ref $digest|$ref $local_id|" "$TMP/lock"
                digest=$local_id
              fi
              docker tag "$digest" "$ref" ;;
    *) echo "  $ref"
       docker pull -q "$repo@$digest" >/dev/null && docker tag "$repo@$digest" "$ref" || die "Couldn't download $ref." ;;
  esac
done < "$TMP/b/$LOCK"

# ---- install -------------------------------------------------------------------------------------------------------
say "Installing"
install -d -m 0755 /opt/tinhat /opt/tinhat/web
cp -a "$TMP/b/manager" /opt/tinhat/manager
cp -a "$TMP/b/web/." /opt/tinhat/web/
install -m 0644 "$TMP/b/compose.yaml" "$TMP/b/VERSION" /opt/tinhat/
install -m 0644 "$TMP/lock" /opt/tinhat/images.lock
echo linux > /opt/tinhat/EDITION  # the manager leaves this machine's name, network, SSH and system updates alone
[ "$BEHIND" = 1 ] && echo proxy > /opt/tinhat/PORTS  # never 80/443: they're the machine's own web server's
cp -a "$TMP/b/host/." /
chmod 0755 /usr/local/sbin/tinhat
# Tin Hat's pinned aiohttp: the release's manager/wheels (each checked against the signed release's list), installed
# offline into /opt/tinhat/venv. Debian 13 gets its compiled build; another Python (Ubuntu 24.04's 3.12) the same
# version in pure Python, with the same checks. Without it the manager runs on the system's python3-aiohttp and its
# dashboard says so.
(cd /opt/tinhat/manager && python3 -m tinhat pyenv build) \
  || echo "  (the manager will run on this system's own aiohttp for now; its dashboard says why)"
install -d -m 0700 /var/lib/tinhat
sysctl -q -p /etc/sysctl.d/90-tinhat-host.conf || true
systemctl daemon-reload
systemctl enable --now tinhat-manager >/dev/null
for _ in $(seq 1 90); do
  [ -s /var/lib/tinhat/setup-code ] && curl -fs -o /dev/null http://127.0.0.1:8090/admin/setup/status && break
  sleep 2
done
[ -s /var/lib/tinhat/setup-code ] || die "The manager didn't start; see: sudo journalctl -u tinhat-manager"

# ---- what next -----------------------------------------------------------------------------------------------------
# The machine's home-network addresses: not Docker's, not a VPN or tunnel's (WireGuard, Tailscale, …)
addrs=$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|wg|tun|tap|tailscale|zt)/ {split($4, a, "/"); print a[1]}' \
  | grep -v '^198\.18\.' | head -3)
echo
echo "Tin Hat Server $VER is installed. Set it up in a browser:"
for a in $addrs; do [ "$BEHIND" = 1 ] && echo "    http://$a:8080/" || echo "    http://$a/"; done
echo
echo "    Setup code: $(cat /var/lib/tinhat/setup-code)"
echo
if [ "$HOME_NET" = 1 ]; then
  echo "Open it from a computer or phone on the same network. \`sudo tinhat setup-code\` shows the code again."
else
  echo "This machine has its own public address, so the setup page is open to the internet until setup is done: only"
  echo "the code above unlocks it (ten wrong tries lock it for ten minutes). Choose \"Friends anywhere\" or \"My own"
  echo "domain\" at setup. If the provider has a firewall in front of the machine, let in TCP 80, 443 and 7881 and UDP 7882."
fi
if [ "$BEHIND" = 1 ]; then
  echo "At setup choose \"My own domain\", then \"My own reverse proxy\": the last page shows the settings to paste into your"
  echo "proxy (it sends your domain to port 8080 here). Your router still sends TCP 7881 and UDP 7882 straight to this machine."
fi
echo "Everything else happens in the browser. \`sudo tinhat\` shows the status; \`sudo tinhat uninstall\` removes it."
