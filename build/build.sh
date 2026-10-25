#!/bin/bash
# build.sh — build the Tin Hat Server appliance image on a Proxmox VE host, in a temporary build VM.
#
#   build.sh create        a new build VM from the Debian 13 generic cloud image (static address, internet, temp SSH key)
#   build.sh web           (re)build the Tin Hat Web self-host flavor in WEB_DIR
#   build.sh push          stage the payload (rootfs + web + VERSION + scripts) and copy it into the VM
#   build.sh provision     run provision.sh in the VM (packages, images, units) — re-runnable
#   build.sh update        dev loop: push + copy the rootfs over + restart the manager (no apt, no pulls)
#   build.sh ssh CMD…      run CMD as root in the VM
#   build.sh artifacts     out/release-<VERSION>/: images.lock, our Caddy image, the Tin Hat Web build (release.sh
#                          turns them into an update; run after provision, before seal)
#   build.sh compose [DIR] the Docker Compose edition's image from release.sh's files (DIR: default out/channel)
#   build.sh seal          seal.sh: first-boot state, then the VM powers off; then the host zeroes the disk's free
#                          blocks (needs zerofree on the host: apt install zerofree)
#   build.sh export        out/tinhat-server-<VERSION>-<ARCH>.qcow2 (+ .sha256) from the sealed disk, after checking
#                          it holds nothing of the build (refuses otherwise); amd64 also the same disk zipped as
#                          .vhdx.zip (Hyper-V) and .vmdk.zip (VirtualBox, VMware): GitHub takes no file of 2 GiB+
#   build.sh all           create web push provision artifacts seal export
#
# The host's settings (VM ids, the build VM's address, bridge, storage, where Tin Hat Web is) come from
# build/build.local.conf: copy build/build.conf.example. The VM has that address only while it's being built; the
# sealed image uses DHCP.
# ARCH=arm64 build.sh …   the same for Apple silicon Macs (UTM, Parallels, VMware Fusion) and other ARM machines
#                         (emulated on an x86 host, so everything takes several times longer).
# REUSE_IMAGES_FROM=DIR build.sh …   our own images (tinhat/api, tinhat/caddy) unchanged since the release in DIR (its
#                         out/github/vX.Y.Z/): the VM loads those exact images instead of building new ones (the API
#                         tagged with this version; a tag doesn't change an image's id), so servers on that release
#                         already have every image this one names and download only the bundle (0.3.2: a 0.3.0/0.3.1
#                         server can't fetch an image from GitHub at all). Only when api/ and build/caddy didn't change.
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
web_run() { (cd "$WEB_DIR" && "$@"); }  # runs a command in the Tin Hat Web checkout; build.local.conf may replace it
[ -f "$HERE/build/build.local.conf" ] && . "$HERE/build/build.local.conf"
need() { [ -n "${!1:-}" ] || { echo "set $1 in build/build.local.conf (see build/build.conf.example)" >&2; exit 2; }; }
ARCH=${ARCH:-amd64}
case "$ARCH" in
  amd64) need BUILD_IP_AMD64; VMID=${VMID:-${BUILD_VMID_AMD64:-9190}} NAME=tinhat-build IP=$BUILD_IP_AMD64 ;;
  arm64) need BUILD_IP_ARM64; VMID=${VMID:-${BUILD_VMID_ARM64:-9191}} NAME=tinhat-build-arm64 IP=$BUILD_IP_ARM64 ;;
  *) echo "ARCH must be amd64 or arm64" >&2; exit 2 ;;
esac
need BUILD_GATEWAY
BRIDGE=${BUILD_BRIDGE:-vmbr0} STORAGE=${BUILD_STORAGE:-local-zfs} PREFIX=${BUILD_PREFIX:-24} DNS=${BUILD_DNS:-$BUILD_GATEWAY}
BASE=${BUILD_BASE_DIR:-/var/lib/vz/template/cloud}/debian-13-generic-$ARCH.qcow2
OUT=$HERE/out
KEY=$OUT/buildkey
VERSION=$(cat "$HERE/appliance/VERSION")
WT=${WEB_DIR:-}
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

vm_ssh() { ssh "${SSHO[@]}" "tinhatbuild@$IP" sudo "$@"; }

ensure_ours() {
  if qm status "$VMID" >/dev/null 2>&1; then
    local n
    n=$(qm config "$VMID" | awk '/^name:/{print $2}')
    [ "$n" = "$NAME" ] || { echo "VM $VMID exists and is \"$n\", not $NAME — refusing to touch it" >&2; exit 1; }
    return 0
  fi
  return 1
}

# The version is written in two places (build/bump.sh sets both): stop now, not after a half-hour build.
VER_NOW=$(cat "$HERE/appliance/VERSION")
grep -q "image: tinhat/api:$VER_NOW\$" "$HERE/appliance/rootfs/opt/tinhat/compose.yaml" \
  || { echo "compose.yaml doesn't run tinhat/api:$VER_NOW: run build/bump.sh $VER_NOW" >&2; exit 1; }

cmd_create() {
  mkdir -p "$OUT"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C tinhat-build -f "$KEY"
  if ensure_ours; then
    qm stop "$VMID" --skiplock 1 >/dev/null 2>&1 || true
    qm destroy "$VMID" --purge 1 >/dev/null
  fi
  [ -f "$BASE" ] || { echo "missing $BASE" >&2; exit 1; }
  if [ "$ARCH" = arm64 ]; then  # emulated (no KVM for ARM on an x86 host): UEFI, the virt machine, cloud-init on SCSI
    qm create "$VMID" --name "$NAME" --description "Tin Hat Server arm64 image build VM (build.sh). Safe to destroy." \
      --arch aarch64 --kvm 0 --machine virt --bios ovmf --efidisk0 "$STORAGE:1,efitype=4m,pre-enrolled-keys=0" \
      --cpu max --cores 4 --memory 4096 --scsihw virtio-scsi-pci \
      --net0 "virtio,bridge=$BRIDGE,firewall=0" --serial0 socket --vga serial0 --agent enabled=1 --onboot 0 >/dev/null
    CI=scsi1
  else
    qm create "$VMID" --name "$NAME" --description "Tin Hat Server image build VM (build.sh). Safe to destroy." \
      --ostype l26 --cpu host --cores 4 --memory 4096 --scsihw virtio-scsi-single \
      --net0 "virtio,bridge=$BRIDGE,firewall=0" --serial0 socket --vga std --agent enabled=1 --onboot 0 >/dev/null
    CI=ide2
  fi
  qm set "$VMID" --scsi0 "$STORAGE:0,import-from=$BASE,discard=on,ssd=1" >/dev/null
  qm resize "$VMID" scsi0 32G >/dev/null
  qm set "$VMID" --$CI "$STORAGE:cloudinit" --boot order=scsi0 --ciuser tinhatbuild --sshkeys "$KEY.pub" \
    --ipconfig0 "ip=$IP/$PREFIX,gw=$BUILD_GATEWAY" --nameserver "$DNS" >/dev/null
  qm start "$VMID"
  echo -n "waiting for SSH on $IP "
  for _ in $(seq 1 $([ "$ARCH" = arm64 ] && echo 600 || echo 90)); do
    if vm_ssh true 2>/dev/null; then echo " up"; vm_ssh cloud-init status --wait >/dev/null 2>&1 || true; return 0; fi
    echo -n .; sleep 3
  done
  echo " timed out" >&2; exit 1
}

cmd_web() {
  need WEB_DIR
  web_run bash -c 'mkdir -p tmp && pnpm build --outDir tmp/selfhost-dist --emptyOutDir >tmp/selfhost-build.log 2>&1 && echo "web built: $(git log --oneline -1)" || { tail -20 tmp/selfhost-build.log; exit 1; }'
}

stage() {
  local P=$OUT/payload
  rm -rf "$P"
  mkdir -p "$P/web"
  cp -a "$HERE/appliance/rootfs" "$P/rootfs"
  find "$P/rootfs" -name __pycache__ -prune -exec rm -rf {} +
  cp "$HERE/appliance/VERSION" "$HERE/appliance/provision.sh" "$HERE/appliance/seal.sh" "$P/"
  need WEB_DIR
  [ -f "$WT/tmp/selfhost-dist/index.html" ] || { echo "no web build — run: build.sh web" >&2; exit 1; }
  rsync -a --exclude='*.map' "$WT/tmp/selfhost-dist/" "$P/web/"
  # The Tin Hat API's image is built in the VM from api/ (provision.sh); the guest call page is served with the web app.
  rm -rf "$P/rootfs/opt/tinhat/build/api"
  mkdir -p "$P/rootfs/opt/tinhat/build/api" "$P/web/call"
  cp -a "$HERE/api/Dockerfile" "$HERE/api/tinhat-api" "$HERE/api/games" "$P/rootfs/opt/tinhat/build/api/"
  rm -rf "$P/rootfs/opt/tinhat/build/api/tinhat-api/test" "$P/rootfs/opt/tinhat/build/api/tinhat-api/node_modules" "$P/rootfs/opt/tinhat/build/api/games/node_modules"
  install -m 0644 "$HERE/api/guest/index.html" "$P/web/call/"
  # REUSE_IMAGES_FROM (see the top): this processor's tarball of each of our images from that release, exactly one each
  if [ -n "${REUSE_IMAGES_FROM:-}" ]; then
    mkdir -p "$P/reuse"
    local name f sfx=""
    [ "$ARCH" = arm64 ] && sfx="-arm64"
    for name in api caddy; do
      f=$(find "$REUSE_IMAGES_FROM" -maxdepth 1 -regextype posix-extended -regex ".*/tinhat-$name-[0-9a-f]{12}$sfx\.tar\.gz" -print)
      [ -n "$f" ] && [ "$(printf '%s\n' "$f" | wc -l)" = 1 ] || { echo "REUSE_IMAGES_FROM: not exactly one tinhat-$name-<id>$sfx.tar.gz in $REUSE_IMAGES_FROM" >&2; exit 1; }
      cp "$f" "$P/reuse/tinhat-$name.tar.gz"
      # the id its name carries (release.sh names each tarball by the image's id): provision.sh checks the loaded image
      basename "$f" | sed -E "s/^tinhat-$name-([0-9a-f]{12}).*/\1/" > "$P/reuse/tinhat-$name.id"
      echo "reusing $(basename "$f") as tinhat/$name"
    done
  fi
  local hash
  hash=$(web_run git rev-parse --short=8 HEAD | tr -d '\r')
  local ver
  ver=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$WT/package.json")
  printf '{"version":"%s","hash":"%s","build":"%s","builtAt":"%s","notes":"Tin Hat Web, self-hosted build (Tin Hat Server %s)."}\n' \
    "$ver" "$hash" "$hash" "$(date -u +%FT%TZ)" "$VERSION" > "$P/web/version.json"
  chown -R root:root "$P"
}

cmd_push() {
  stage
  tar -C "$OUT/payload" -czf - . | ssh "${SSHO[@]}" "tinhatbuild@$IP" 'sudo rm -rf /root/payload && sudo mkdir -p /root/payload && sudo tar -C /root/payload -xzf -'
  echo "payload pushed ($(du -sh "$OUT/payload" | cut -f1))"
}

cmd_provision() { vm_ssh bash /root/payload/provision.sh; }

cmd_update() {
  cmd_push
  vm_ssh bash -c "'cp -a /root/payload/rootfs/. / && chmod 0755 /usr/local/sbin/tinhat* && mkdir -p /opt/tinhat/web && find /opt/tinhat/web -mindepth 1 -delete && cp -a /root/payload/web/. /opt/tinhat/web/ && install -m 0644 /root/payload/VERSION /opt/tinhat/VERSION && find /opt/tinhat -name __pycache__ -prune -exec rm -rf {} + ; systemctl daemon-reload && systemctl restart tinhat-manager && sleep 2 && systemctl is-active tinhat-manager'"
}

cmd_artifacts() {
  # What an update to this version needs besides the source tree: the image digests this build pulled, our own
  # Caddy image (it can't be pulled from a registry), and the exact Tin Hat Web build.
  local R=$OUT/release-$VERSION$([ "$ARCH" = arm64 ] && echo -arm64) ref
  rm -rf "$R" && mkdir -p "$R"
  vm_ssh cat /opt/tinhat/images.lock > "$R/images.lock"
  # every image of our own (tinhat/caddy, tinhat/api): tinhat-<name>.tar.gz
  for ref in $(awk '$1 ~ /^tinhat\//{print $1}' "$R/images.lock"); do
    name=${ref#tinhat/}; name=${name%%:*}
    vm_ssh docker save "$ref" | gzip -1 > "$R/tinhat-$name.tar.gz"
  done
  cp -a "$OUT/payload/web" "$R/web"
  echo "release artifacts: $R ($(du -sh "$R" | cut -f1))"
}

# FILE.keys: which update keys a download that carries a whole server trusts (release.sh --publish refuses one that
# trusts anything but the release key, or whose record describes another build). Key lines on stdin.
keys_record() {
  { echo "sha256 $(sha256sum "$1" | cut -d' ' -f1)"; sed -n 's/^\(RW.*\)$/key \1/p'; } > "$1.keys.part"
  mv "$1.keys.part" "$1.keys"
}

# --- the stopped VM's disk, from the host (seal and export) -----------------------------------------------------
need_host_tools() {
  local t
  for t in zerofree e2fsck dumpe2fs tune2fs debugfs losetup lsblk partx blkid blockdev python3; do
    command -v "$t" >/dev/null || { echo "build.sh needs $t on this host$([ $t = zerofree ] && echo ' (apt install zerofree)')" >&2; exit 2; }
  done
}

disk_dev() { pvesm path "$(qm config "$VMID" | awk -F'[ ,]' '/^scsi0:/{print $2}')"; }

# While the host works on the disk the VM is locked: Proxmox won't start it, and another build.sh can't lock it too.
LOCKED="" LOOP="" MNT="" MOUNTED=""
lock_vm() {
  qm set "$VMID" --lock create >/dev/null \
    || { echo "can't lock VM $VMID (another build.sh seal/export on it? if none is running: qm unlock $VMID)" >&2; exit 1; }
  LOCKED=1
  [ "$(qm status "$VMID" | awk '{print $2}')" = stopped ] || { echo "VM $VMID must be stopped" >&2; exit 1; }
}
# Our own lock only, and only once the disk is released: a mount or loop device left behind keeps the VM locked.
unlock_vm() {
  [ -n "$LOCKED" ] || return 0
  if [ -n "$MOUNTED$LOOP" ]; then
    echo "VM $VMID stays locked: ${MOUNTED:+$MNT is still mounted }${LOOP:+$LOOP is still attached }(release it, then qm unlock $VMID)" >&2
    return 1
  fi
  if qm config "$VMID" | grep -qx 'lock: create'; then qm unlock "$VMID" >/dev/null; fi
  LOCKED=""
}
mount_ro() { MNT=$(mktemp -d); mount -o ro,noload "$1" "$MNT"; MOUNTED=1; }
unmount() {
  if [ -n "$MOUNTED" ] && umount "$MNT"; then MOUNTED=""; fi
  if [ -z "$MOUNTED" ] && [ -n "$MNT" ]; then rmdir "$MNT" 2>/dev/null || true; MNT=""; fi
  [ -z "$MOUNTED" ]
}
release_disk() {
  unmount || true
  if [ -z "$MOUNTED" ] && [ -n "$LOOP" ] && losetup -d "$LOOP"; then LOOP=""; udevadm settle || true; fi
  [ -z "$MOUNTED$LOOP" ]
}
trap 'set +e; release_disk; unlock_vm' EXIT

# The locked VM's disk with its partitions as block devices of their own: a loop device over it (a ZFS volume has
# -partN nodes, an LVM volume none; this is the same for both). $2: ro or rw. Refuses a disk in use on this host:
# mounted, or the disk or one of its partitions already behind a loop device.
attach_disk() {
  local real names n used
  [ "$LOCKED" = 1 ] || { echo "VM $VMID isn't locked" >&2; exit 1; }
  real=$(readlink -f "$1")
  names=$(lsblk -nrpo NAME "$real") || { echo "can't list the partitions of $1" >&2; exit 1; }
  used=$(lsblk -nro MOUNTPOINTS "$real") || { echo "can't read the mounts of $1" >&2; exit 1; }
  [ -z "$(tr -d '\n' <<<"$used")" ] || { echo "$1 (or a partition of it) is mounted on this host" >&2; exit 1; }
  for n in $names; do
    used=$(losetup -nO NAME -j "$n") || { echo "can't list the loop devices" >&2; exit 1; }
    [ -z "$used" ] || { echo "$n is already behind a loop device: $(xargs <<<"$used")" >&2; exit 1; }
  done
  LOOP=$(losetup --find --show --partscan $([ "$2" = ro ] && echo --read-only) "$real")
  udevadm settle || true
}

# Every entry of the attached disk's partition table, "DEVICE KIND", each matched by the loop device's partition of the
# same start and size: ext4 (checked through and through), vfat on the EFI system partition, none on the BIOS boot
# partition (GRUB's core image). Anything else, a missing or extra partition, or a probe that fails, stops it:
# it would go out checked only by disk_leaks's pattern search.
disk_parts() {
  local tab nr start size type p sys info t n=0 nodes
  tab=$(partx -g -o NR,START,SECTORS,TYPE "$1") || { echo "can't read the partition table of $1" >&2; exit 1; }
  [ -n "$tab" ] || { echo "no partitions on $1" >&2; exit 1; }
  while read -r nr start size type; do
    p=${LOOP}p$nr sys=/sys/class/block/${LOOP##*/}p$nr
    [ -b "$p" ] && [ "$(cat "$sys/start")" = "$start" ] && [ "$(cat "$sys/size")" = "$size" ] \
      || { echo "partition $nr: $p doesn't match the partition table" >&2; exit 1; }
    info=$(blkid -p -o export "$p") || { echo "partition $nr: blkid can't probe it" >&2; exit 1; }
    t=$(sed -n 's/^TYPE=//p' <<<"$info")
    case "$t:${type,,}" in
      ext4:*) ;;
      vfat:c12a7328-f81f-11d2-ba4b-00a0c93ec93b) ;;
      :21686148-6449-6e6f-744e-656564454649) t=none ;;
      *) echo "partition $nr: ${t:-no filesystem} (partition type $type) isn't something build.sh checks" >&2; exit 1 ;;
    esac
    echo "$p $t"; n=$((n + 1))
  done <<<"$tab"
  nodes=$(find /dev -maxdepth 1 -name "${LOOP##*/}p*" -type b | wc -l)
  [ "$nodes" = "$n" ] || { echo "$LOOP has $nodes partitions, the table $n" >&2; exit 1; }
}

# The superblock of the ext4 filesystem on $1 (dumpe2fs -h, C locale), or stop.
fs_head() { LC_ALL=C dumpe2fs -h "$1" 2>/dev/null || { echo "can't read the filesystem on partition ${1##*p}" >&2; exit 1; }; }
fs_feature() { [[ " $(sed -n 's/^Filesystem features: *//p' <<<"$1") " == *" $2 "* ]]; }

# A filesystem the host may touch or read as sealed: cleanly unmounted (the VM powered itself off, no journal left to
# replay) and consistent (zerofree trusts its free-block bitmap; so does check-free.py).
fs_checked() {
  local h
  h=$(fs_head "$1")
  if ! grep -qx 'Filesystem state: *clean' <<<"$h" || fs_feature "$h" needs_recovery; then
    echo "the filesystem on partition ${1##*p} wasn't cleanly unmounted (did seal.sh power the VM off?)" >&2; exit 1
  fi
  fsck_clean "$1" ""
}
fsck_clean() {
  local out
  out=$(LC_ALL=C e2fsck -fn "$1" 2>&1) || { echo "e2fsck -fn finds errors on partition ${1##*p}$2:" >&2; tail -5 <<<"$out" >&2; exit 1; }
}

# Deleted files keep their contents in free blocks, and a fill from inside the VM can't reach them all (seal.sh):
# with the VM off, the host zeroes what no file reads on each ext4 filesystem of the disk. 0.3.0's image and the
# first builds after it still held cloud-init's /etc/hosts and network config there.
#   1. unwritten extents (allocated, never written: files read zeros there, the disk may hold anything): their blocks
#      are zeroed (listed through the filesystem mounted read-only, written after it is unmounted)
#   2. the journal (old copies of the last metadata written, the build's history) is removed
#   3. zerofree zeroes every free block (only those that hold data are written), the old journal's too
#   4. a new journal, the same size; e2fsck -fn must find nothing.
# A seal interrupted between 2 and 4 leaves no journal: export refuses that disk.
zero_free() {
  local dev p t n=0 h jblocks bs jmb parts list s=$SECONDS
  lock_vm
  dev=$(disk_dev)
  attach_disk "$dev" rw
  parts=$(disk_parts "$(readlink -f "$dev")")
  while read -r p t; do
    [ "$t" = ext4 ] || continue
    fs_checked "$p"
    mount_ro "$p"
    list=$(python3 "$HERE/build/check-free.py" --list-unwritten "$MNT")
    unmount
    [ -z "$list" ] || python3 "$HERE/build/check-free.py" --zero "$p" <<<"$list"
    h=$(fs_head "$p")
    fs_feature "$h" has_journal || { echo "partition ${p##*p}: no journal" >&2; exit 1; }
    ! fs_feature "$h" fast_commit || { echo "partition ${p##*p}: a fast-commit journal isn't something build.sh renews" >&2; exit 1; }
    jblocks=$(sed -nE 's/^Total journal blocks: *([0-9]+)$/\1/p' <<<"$h") bs=$(sed -nE 's/^Block size: *([0-9]+)$/\1/p' <<<"$h")
    [ -n "$jblocks" ] && [ -n "$bs" ] && [ $((jblocks * bs % 1048576)) = 0 ] \
      || { echo "partition ${p##*p}: can't read the journal's size (or it isn't whole MiB)" >&2; exit 1; }
    jmb=$((jblocks * bs / 1048576))
    tune2fs -O ^has_journal "$p" >/dev/null
    zerofree "$p"
    tune2fs -J size="$jmb" "$p" >/dev/null
    h=$(fs_head "$p")
    fs_feature "$h" has_journal && [ "$(sed -nE 's/^Total journal blocks: *([0-9]+)$/\1/p' <<<"$h")" = "$jblocks" ] \
      || { echo "partition ${p##*p}: the new journal isn't the old one's size ($jblocks blocks)" >&2; exit 1; }
    fsck_clean "$p" " after zerofree"
    n=$((n + 1))
  done <<<"$parts"
  release_disk
  blockdev --flushbufs "$(readlink -f "$dev")"
  unlock_vm
  [ "$n" -gt 0 ] || { echo "no ext4 filesystem on $dev" >&2; exit 1; }
  echo "free space zeroed, journal renewed on $n filesystem(s) ($((SECONDS - s)) s)"
}

# What the sealed disk must be before it's converted, read without writing: every partition one build.sh knows;
# every ext4 filesystem cleanly unmounted and consistent, with a journal, nothing in the space no file reads (free
# blocks, unwritten extents, the journal past its first block: check-free.py, a reading independent of zerofree); the
# root filesystem without the build's account, keys, journal, containers, setup state or shared identities
# (check-sealed.sh). Sets KEYS: the update keys the root filesystem trusts, one per line. The caller holds the lock.
sealed_disk() {
  local p t n=0 root="" parts
  KEYS=""
  attach_disk "$1" ro
  parts=$(disk_parts "$(readlink -f "$1")")
  while read -r p t; do
    [ "$t" = ext4 ] || continue
    fs_checked "$p"
    fs_feature "$(fs_head "$p")" has_journal || { echo "partition ${p##*p} has no journal (an interrupted seal?): not exported" >&2; exit 1; }
    n=$((n + 1))
    mount_ro "$p"
    python3 "$HERE/build/check-free.py" "$p" "$MNT" \
      || { echo "partition ${p##*p}: space no file reads still holds data (build.sh seal zeroes it): not exported" >&2; exit 1; }
    if [ -f "$MNT/opt/tinhat/VERSION" ]; then
      [ -z "$root" ] || { echo "two Tin Hat root filesystems on $1: not exported" >&2; exit 1; }
      root=$p
      bash "$HERE/build/check-sealed.sh" "$MNT" || { echo "the root filesystem isn't sealed (see seal.sh): not exported" >&2; exit 1; }
      KEYS=$(cat "$MNT"/opt/tinhat/manager/tinhat/keys/*.pub 2>/dev/null | grep -v '^untrusted comment:' || true)
    fi
    unmount
  done <<<"$parts"
  release_disk
  [ "$n" -gt 0 ] || { echo "no ext4 filesystem on $1: not exported" >&2; exit 1; }
  [ -n "$root" ] || { echo "no Tin Hat root filesystem on $1: not exported" >&2; exit 1; }
}

# FILE.sealed: this exact file was converted from a disk that passed every export check (windows/build-rootfs.sh
# takes only an image with one). A record for the build machine, not a download. $2: what FILE holds, for a zip.
sealed_record() {
  { echo "sha256 $(cut -d' ' -f1 "$1.sha256")"
    echo "checked by build.sh export $(date -u +%FT%TZ): no build VM address, name, MAC or SSH key on the disk;" \
         "free blocks, unwritten extents and the journal zero; the root filesystem sealed"
    [ -z "${2:-}" ] || echo "holds $2"; } > "$1.sealed.part"
  mv "$1.sealed.part" "$1.sealed"
}

# GitHub refuses a release file of 2 GiB or more; release.sh refuses one of MAX_ASSET or more (a margin under that).
MAX_ASSET=1932735283  # 1.8 GiB

# DISK (a conversion of the checked disk) → DISK.zip with its .sha256, .sealed and .keys records; DISK itself goes.
# zip-disk.py reads the zip back whole and compares it with DISK's sha256 before anything is removed.
zip_disk() {
  local f=$1 keys=$2 sum
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  rm -f "$f.zip.part"
  python3 "$HERE/build/zip-disk.py" "$f" "$f.zip.part" "$sum" "$MAX_ASSET" \
    || { echo "couldn't zip $(basename "$f"): not exported" >&2; exit 1; }
  mv "$f.zip.part" "$f.zip"
  (cd "$OUT" && sha256sum "$(basename "$f").zip" > "$(basename "$f").zip.sha256")
  sealed_record "$f.zip" "$(basename "$f") (sha256 $sum)"
  [ -z "$keys" ] || keys_record "$f.zip" <<<"$keys"
  rm -f "$f"
}

cmd_compose() {
  # The Docker Compose edition's image (build/compose/Dockerfile) from a release's own files: the bundle and our
  # images' tarballs as release.sh wrote them (default out/channel; or out/github/vVERSION), built on the build VM
  # (it has Docker and the internet), saved next to the artifacts as tinhat-server-compose[-arm64].tar.gz.
  local SRC=${1:-$OUT/channel} S=$OUT/compose-$VERSION R=$OUT/release-$VERSION$([ "$ARCH" = arm64 ] && echo -arm64)
  local bundle=$SRC/tinhat-server-$VERSION.update.tar.gz
  [ -f "$bundle" ] || { echo "no $bundle (release.sh $VERSION first)" >&2; exit 1; }
  rm -rf "$S" && mkdir -p "$S/release/images"
  tar -C "$S/release" -xzf "$bundle"
  [ "$(cat "$S/release/VERSION")" = "$VERSION" ] || { echo "that bundle isn't $VERSION" >&2; exit 1; }
  # only our images this release's signed manifest names (the folder may hold older ones)
  local key=images; [ "$ARCH" = arm64 ] && key=images_arm64
  for u in $(jq -r --arg k "$key" '.[$k][].url' "$SRC/stable.json"); do cp "$SRC/${u##*/}" "$S/release/images/"; done
  cp "$HERE/build/compose/Dockerfile" "$S/"
  local keys
  keys=$(cat "$S"/release/manager/tinhat/keys/*.pub 2>/dev/null | grep -v '^untrusted comment:' || true)
  ls "$S/release/images"
  tar -C "$S" -cf - . | vm_ssh bash -c "'rm -rf /root/compose-ctx && mkdir /root/compose-ctx && tar -C /root/compose-ctx -xf - && docker build -q -t tinhat/server:$VERSION /root/compose-ctx && rm -rf /root/compose-ctx'"
  mkdir -p "$R"
  local tgz=$R/tinhat-server-compose$([ "$ARCH" = arm64 ] && echo -arm64).tar.gz
  rm -f "$tgz.keys"
  vm_ssh docker save "tinhat/server:$VERSION" | gzip -1 > "$tgz"
  [ -z "$keys" ] || keys_record "$tgz" <<<"$keys"
  rm -rf "$S"
  ls -la "$R"/tinhat-server-compose*.tar.gz
}

cmd_seal() {
  # Through the guest agent (root, outside any login session): seal.sh deletes the build account, which it can't
  # do while an SSH session of that account is running it. seal.sh powers the VM off; the host finishes the disk.
  pvesh create "/nodes/$(hostname)/qemu/$VMID/agent/file-write" --file /root/seal.sh --content "$(base64 -w0 "$HERE/appliance/seal.sh")" --encode 0 >/dev/null
  # The call waits for seal.sh: its exit status comes back once seal.sh has queued the power-off (exit 0), or failed
  # (it fails closed, leaving the VM running). The agent may stop before it answers: the power-off is what counts.
  local res st off="" wait=$([ "$ARCH" = arm64 ] && echo 5400 || echo 1200)
  res=$(qm guest exec "$VMID" --timeout "$wait" -- /bin/bash -c "bash /root/seal.sh > /root/seal.log 2>&1" 2>/dev/null) || res=""
  st=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read().strip() or "{}")
print("" if not d else "running" if not d.get("exited") else d["exitcode"] if "exitcode" in d else "signal")' <<<"$res") \
    || { echo "can't read the guest agent's answer: $res" >&2; exit 1; }
  case $st in
    ""|0|signal) ;;  # answered (or gone) on the way down; a signal: only the power-off below can tell
    running) echo "seal.sh still runs after $wait s" >&2; exit 1 ;;
    *) echo "seal.sh failed (exit $st), the VM is still running; the end of /root/seal.log:" >&2
       qm guest exec "$VMID" -- tail -n 25 /root/seal.log 2>/dev/null \
         | python3 -c 'import json,sys; print(json.load(sys.stdin).get("out-data",""), end="")' >&2 || true
       exit 1 ;;
  esac
  echo -n "waiting for the VM to power off "
  for _ in $(seq 1 $([ "$st" = signal ] && echo 30 || echo 300)); do
    [ "$(qm status "$VMID" | awk '{print $2}')" = stopped ] && { echo " off"; off=1; break; }
    echo -n .; sleep 2
  done
  [ -n "$off" ] || { echo " still running$([ "$st" = signal ] && echo ": seal.sh was killed")" >&2; exit 1; }
  zero_free
}

# Nothing of the build may ride along in an image, not even in its free space (0.3.0's still held cloud-init's network
# config there): the build VM's address, name, MAC (also as an IPv6 interface id) and SSH key must appear nowhere on
# the sealed disk. Reads the whole disk (unwritten parts of a thin volume come back fast).
disk_leaks() {
  local dev=$1 mac eui pat a b c d e f g1 g4 rc=0
  mac=$(qm config "$VMID" | sed -nE 's/^net0:[^=]*=([0-9A-Fa-f:]{17}).*/\1/p' | tr 'A-F' 'a-f')
  pat="(?<![0-9.])\\Q$IP\\E(?![0-9])|tinhat-build|\\Q$(awk '{print $2}' "$KEY.pub")\\E"
  if [ -n "$mac" ]; then
    IFS=: read -r a b c d e f <<<"$mac"
    # The MAC as an IPv6 interface id (EUI-64) however the address is written: leading zeros dropped, and a zero first
    # or last group compressed to :: (the middle two, xxff and fexx, are never zero).
    g1=$((0x$a$b ^ 0x200)) g4=$((0x$e$f))
    if [ "$g1" = 0 ]; then eui='(?:(?<![0-9a-f])0*0:|::)'; else eui=$(printf '(?<![0-9a-f])0*%x:' "$g1"); fi
    eui+=$(printf '0*%x:0*%x:' "0x${c}ff" "0xfe$d")
    if [ "$g4" = 0 ]; then eui+='(?:0*0|:)(?![0-9a-f])'; else eui+=$(printf '0*%x(?![0-9a-f])' "$g4"); fi
    pat="$pat|\\Q$mac\\E|$eui"
  fi
  # -z: NUL ends a record (a zeroed disk has no newlines: one record of gigabytes otherwise); C locale: bytes
  LC_ALL=C grep -a -z -i -q -P "$pat" "$dev" || rc=$?
  case $rc in
    0) echo "the sealed disk still holds the build VM's address, name, MAC or SSH key (see seal.sh): not exported" >&2
       leak_places "$dev" "$pat" >&2
       exit 1 ;;
    1) ;;  # none of them: clean
    *) echo "couldn't check $dev for build leftovers (grep exit $rc): not exported" >&2; exit 1 ;;
  esac
}

# Where the first matches are, to find what left them: byte offset, what matched, the partition and, on an ext4 one,
# the block and whether it is free or which file has it. grep -z miscounts -b offsets (it skips runs of zeros), so the
# disk is read in 64 MiB pieces (plus a little overlap) searched without -z: memory stays bounded, offsets right.
leak_places() {
  local dev=$1 hits="" piece=$((64 << 20)) o=0 size found off m nr start sectors p bs blk ino where
  size=$(blockdev --getsize64 "$dev")
  while [ "$o" -lt "$size" ] && [ "$(grep -c . <<<"$hits")" -lt 5 ]; do
    found=$(dd if="$dev" iflag=skip_bytes,count_bytes skip="$o" count=$((piece + 4096)) bs=4M status=none \
            | LC_ALL=C grep -a -b -o -i -P "$2" || true)
    while IFS=: read -r off m; do  # a match starting in the overlap belongs to the next piece
      [ -n "$off" ] && [ "$off" -lt "$piece" ] && hits+="$((o + off)):$m"$'\n'
    done <<<"$found"
    o=$((o + piece))
  done
  attach_disk "$dev" ro
  while IFS=: read -r off m; do
    [ -n "$off" ] || continue
    where="outside every partition"
    while read -r nr start sectors; do
      [ "$off" -ge $((start * 512)) ] && [ "$off" -lt $(((start + sectors) * 512)) ] || continue
      p=${LOOP}p$nr
      where="partition $nr ($(blkid -p -o value -s TYPE "$p" 2>/dev/null || echo unknown))"
      if [ "$(blkid -p -o value -s TYPE "$p" 2>/dev/null)" = ext4 ]; then
        bs=$(LC_ALL=C dumpe2fs -h "$p" 2>/dev/null | sed -nE 's/^Block size: *([0-9]+)$/\1/p')
        blk=$(((off - start * 512) / bs))
        if debugfs -R "testb $blk" "$p" 2>/dev/null | grep -q 'not in use'; then where+=", free block $blk"
        else
          ino=$(debugfs -R "icheck $blk" "$p" 2>/dev/null | awk 'NR==2{print $2}')
          where+=", block $blk of inode $ino $(debugfs -R "ncheck $ino" "$p" 2>/dev/null | awk 'NR==2{print $2}')"
        fi
      fi
    done < <(partx -g -o NR,START,SECTORS "$dev")
    echo "  byte $off: \"$m\" — $where"
  done <<<"$(head -5 <<<"$hits")"
  release_disk
}

cmd_export() {
  ensure_ours || { echo "no VM $VMID" >&2; exit 1; }
  [ "$(qm status "$VMID" | awk '{print $2}')" = stopped ] || { echo "VM $VMID must be stopped (sealed) first" >&2; exit 1; }
  lock_vm  # until every conversion is done: they all read this disk as it was checked
  local dev img
  dev=$(disk_dev)
  img=$OUT/tinhat-server-$VERSION-$ARCH.qcow2
  mkdir -p "$OUT"
  # Old outputs of this version go first: a conversion that fails then leaves nothing a record could vouch for.
  rm -f "$img" "$img".{keys,sealed} "${img%.qcow2}".{vhdx,vmdk}{,.zip}{,.part,.keys,.sha256,.sealed}
  disk_leaks "$dev"
  sealed_disk "$dev"
  local keys=$KEYS
  [ -n "$keys" ] || echo "WARNING: no update keys on $dev: release.sh --publish will refuse these images" >&2
  qemu-img convert -p -O qcow2 -c -o compression_type=zstd "$dev" "$img.part"
  mv "$img.part" "$img"
  (cd "$OUT" && sha256sum "$(basename "$img")" > "$(basename "$img").sha256")
  sealed_record "$img"
  [ -z "$keys" ] || keys_record "$img" <<<"$keys"
  ls -la "$img"; cat "$img.sha256"
  if [ "$ARCH" = amd64 ]; then  # the same disk for Hyper-V (.vhdx) and for VirtualBox / VMware (.vmdk, attach as a disk)
    local base=${img%.qcow2}
    qemu-img convert -p -O vhdx -o subformat=dynamic "$dev" "$base.vhdx.part"
    mv "$base.vhdx.part" "$base.vhdx"
    qemu-img convert -p -O vmdk -o subformat=monolithicSparse "$dev" "$base.vmdk.part"
    mv "$base.vmdk.part" "$base.vmdk"
    # zipped: too big for a GitHub release as they are (4.1 and 2.8 GiB for 0.3.0)
    zip_disk "$base.vhdx" "$keys"
    zip_disk "$base.vmdk" "$keys"
    ls -la "$base".vhdx.zip "$base".vmdk.zip
  fi
}

case "${1:-}" in create|seal|export|all) need_host_tools ;; esac  # a build that can't be sealed isn't worth starting
case "${1:-}" in
  create) cmd_create ;;
  web) cmd_web ;;
  push) cmd_push ;;
  provision) cmd_provision ;;
  update) cmd_update ;;
  ssh) shift; vm_ssh "$@" ;;
  artifacts) cmd_artifacts ;;
  seal) cmd_seal ;;
  export) cmd_export ;;
  all) cmd_create; cmd_web; cmd_push; cmd_provision; cmd_artifacts; cmd_seal; cmd_export ;;
  compose) shift; cmd_compose "$@" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
