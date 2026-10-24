#!/bin/bash
# build-rootfs.sh — make the WSL 2 distribution of Tin Hat Server from a sealed appliance image.
#
#   windows/build-rootfs.sh [IMAGE.qcow2]
#
# IMAGE defaults to the newest out/tinhat-server-<ver>-amd64.qcow2. Output (OUT, default out/windows in this repository,
# which .gitignore keeps out of git):
#   tinhat-server-<ver>-wsl.tar.gz (+ .sha256)   a rootfs tarball that `wsl --import` (and `wsl --install --from-file`) take
#
# How: the image is never written to. qcow2 → a sparse raw copy in a work folder → read-only loop device → the root
# partition mounted read-only (noload: no journal replay) → tar with numeric owners and xattrs, leaving out /proc /sys
# /dev /run /boot, the kernel modules, the VM's fstab and resolv.conf → windows/rootfs-overlay/ appended (the WSL
# config and the WSL-only start-up step) → compressed. Then unmount, detach, delete the raw copy.
# Runs as root on a Linux build machine (needs qemu-img, losetup, mount, GNU tar).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/.." && pwd)
OVERLAY="$HERE/rootfs-overlay"
OUT=${OUT:-$TOP/out/windows}
COMPRESS=${COMPRESS:-gz}   # gz (fast to import everywhere) or xz (smaller, slower to import)

# Files of the image that the overlay deliberately replaces (left out of the image part of the tarball).
REPLACED=(etc/fstab)
# Left out of the image part: virtual filesystems and mount points' contents, the VM's kernel and boot files (WSL
# brings its own kernel), and resolv.conf (a link to systemd-resolved's stub; WSL writes its own).
EXCLUDES=(./proc/* ./sys/* ./dev/* ./run/* ./boot/* ./tmp/* ./var/tmp/* ./usr/lib/modules/* ./lost+found/*
          ./etc/resolv.conf)

die() { echo "build-rootfs: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "$(id -u)" = 0 ] || die "run as root (it needs a loop device and a read-only mount)"
for t in qemu-img losetup mount umount blkid dumpe2fs tar sha256sum find; do command -v $t >/dev/null || die "missing $t"; done

IMAGE=${1:-$(ls -1 "$TOP"/out/tinhat-server-*-amd64.qcow2 2>/dev/null | sort -V | tail -1)}
[ -f "$IMAGE" ] || die "no image (give the path of a sealed tinhat-server-<ver>-amd64.qcow2)"
IMAGE=$(readlink -f "$IMAGE")
VER=$(basename "$IMAGE" | sed -nE 's/^tinhat-server-(.+)-amd64\.qcow2$/\1/p')
[ -n "$VER" ] || die "can't read the version from $(basename "$IMAGE")"

step "image $(basename "$IMAGE") (version $VER)"
if [ -f "$IMAGE.sha256" ]; then
  (cd "$(dirname "$IMAGE")" && sha256sum -c --quiet "$(basename "$IMAGE").sha256") || die "the image doesn't match its .sha256"
  echo "checksum ok"
else
  echo "no .sha256 next to the image: not verified"
fi
IMAGE_SHA=$(sha256sum "$IMAGE" | cut -d' ' -f1)
# Only an image build.sh export made after all its checks (the build VM's address, name, MAC and key nowhere on the
# disk, free space zero, the root filesystem sealed): it writes IMAGE.sealed with the image's sha256.
[ -f "$IMAGE.sealed" ] && [ "$(sed -n 's/^sha256 //p' "$IMAGE.sealed")" = "$IMAGE_SHA" ] \
  || die "no seal record for this exact image ($(basename "$IMAGE").sealed, written by build.sh export once its checks pass)"
echo "seal record ok"

mkdir -p "$OUT"
WORK=$(mktemp -d "$OUT/.work-XXXXXX")
LOOP=""
MNT="$WORK/root"
cleanup() {
  set +e
  mountpoint -q "$MNT" 2>/dev/null && umount "$MNT"
  [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

step "raw copy (sparse, in $WORK)"
qemu-img convert -f qcow2 -O raw "$IMAGE" "$WORK/image.raw"
chmod 0400 "$WORK/image.raw"

step "attach read-only"
LOOP=$(losetup --partscan --read-only --find --show "$WORK/image.raw")
udevadm settle 2>/dev/null || sleep 2
echo "$LOOP"
mkdir -p "$MNT"
ROOTPART=""
for p in "$LOOP"p*; do
  [ "$(blkid -o value -s TYPE "$p" 2>/dev/null)" = ext4 ] || continue
  state=$(LC_ALL=C dumpe2fs -h "$p" 2>/dev/null | sed -nE 's/^Filesystem state: *//p')
  mount -o ro,noload "$p" "$MNT"
  if [ -f "$MNT/opt/tinhat/VERSION" ] && [ -f "$MNT/etc/os-release" ]; then
    [ "$state" = clean ] || die "the root filesystem on $p is '$state', not clean (was the image sealed?)"
    ROOTPART=$p
    break
  fi
  umount "$MNT"
done
[ -n "$ROOTPART" ] || die "no Tin Hat root filesystem in the image"
IVER=$(cat "$MNT/opt/tinhat/VERSION")
[ "$IVER" = "$VER" ] || die "the image says version $IVER, its file name $VER"
echo "root filesystem: $ROOTPART (clean, Tin Hat Server $IVER)"
# The tarball carries the image's files, so whatever seal.sh missed would ride along (free blocks don't: tar copies
# files only). The same check build.sh export makes: no build account, keys, journal, setup state or shared identities.
bash "$TOP/build/check-sealed.sh" "$MNT" || die "the image isn't sealed (above): make it with build/build.sh seal + export"
echo "sealed: nothing of the build on it"

step "overlay check"
# Every overlay file must be new to the image, unless it is one of REPLACED. Directories already in the image are
# not added again (their owner and mode stay the image's).
STAGE="$WORK/overlay"
cp -a "$OVERLAY" "$STAGE"
find "$STAGE" -name '.gitkeep' -delete
{
  echo "Tin Hat Server for Windows (WSL 2 edition)"
  echo "version:   $VER"
  echo "image:     $(basename "$IMAGE") sha256 $IMAGE_SHA"
  echo "overlay:   $(cd "$OVERLAY" && find . -type f -o -type l | LC_ALL=C sort | xargs -d '\n' sha256sum 2>/dev/null | sha256sum | cut -c1-16)"
  echo "built:     $(date -u +%FT%TZ) by windows/build-rootfs.sh"
} > "$STAGE/usr/local/lib/tinhat-wsl/BUILD"
LIST="$WORK/overlay.list"
: > "$LIST"
ENTRIES=$(cd "$STAGE" && find . -mindepth 1 | LC_ALL=C sort)  # all of it first: a failed listing stops here
while IFS= read -r rel; do
  rel=${rel#./}
  case $rel in etc|etc/*|usr|usr/*) ;; *) die "overlay entry $rel: the overlay adds only to /etc and /usr" ;; esac
  if [ -d "$STAGE/$rel" ] && [ ! -L "$STAGE/$rel" ]; then
    [ -e "$MNT/$rel" ] && { [ -d "$MNT/$rel" ] || die "overlay directory $rel is a file in the image"; continue; }
  elif [ -e "$MNT/$rel" ] || [ -L "$MNT/$rel" ]; then
    printf '%s\n' "${REPLACED[@]}" | grep -qx "$rel" || die "overlay file $rel already exists in the image (add it to REPLACED if that's intended)"
  fi
  echo "./$rel" >> "$LIST"
done <<<"$ENTRIES"
echo "$(wc -l < "$LIST") overlay entries"

# The update keys this server will trust, read from the image itself (release.sh --publish checks NAME.keys).
KEYS=$(cat "$MNT"/opt/tinhat/manager/tinhat/keys/*.pub 2>/dev/null | grep -v '^untrusted comment:' || true)
[ -n "$KEYS" ] || echo "WARNING: no update keys in the image: release.sh --publish will refuse the installer made from it" >&2

step "tar"
TAR="$WORK/rootfs.tar"
EXARGS=()
for e in "${EXCLUDES[@]}"; do EXARGS+=(--exclude="$e"); done
for r in "${REPLACED[@]}"; do EXARGS+=(--exclude="./$r"); done
tar --create --file "$TAR" --format=pax --numeric-owner --xattrs --xattrs-include='*' --acls --selinux \
  --one-file-system --sparse --sort=name -C "$MNT" "${EXARGS[@]}" .
tar --append --file "$TAR" --format=pax --numeric-owner --owner=0 --group=0 --no-recursion -C "$STAGE" -T "$LIST"
echo "$(du -h --apparent-size "$TAR" | cut -f1) uncompressed"
# Sanity: what WSL and the server need is there, what must not be is not.
tar -tf "$TAR" > "$WORK/names"
for must in ./etc/wsl.conf ./etc/wsl-distribution.conf ./etc/fstab ./usr/local/lib/tinhat-wsl/ctl \
            ./opt/tinhat/compose.yaml ./opt/tinhat/manager/tinhat/web.py ./var/lib/docker/image/overlay2/repositories.json; do
  grep -qx "$must" "$WORK/names" || die "missing in the tarball: $must"
done
[ "$(grep -cx './etc/fstab' "$WORK/names")" = 1 ] || die "two copies of /etc/fstab"
grep -qE '^\./(boot|usr/lib/modules)/.' "$WORK/names" && die "kernel files left in the tarball"
grep -qx './etc/resolv.conf' "$WORK/names" && die "resolv.conf left in the tarball"
# check-sealed.sh's rules over the tarball's names (the image and the overlay together).
rc=0
grep -E '^\./(root/(\.ssh(/|$)|payload(/|$)|seal\.(sh|log)$|\.bash_history$)|home/.|etc/ssh/ssh_host_|etc/(passwd|group|shadow|gshadow|subuid|subgid)-$|etc/cloud(/|$)|etc/sudoers\.d/90-cloud-init-users$|var/lib/cloud(/|$)|var/lib/systemd/(random-seed|credential\.secret)$|var/log/journal/.|var/lib/tinhat/.|var/lib/docker/containers/.|var/lib/docker/volumes/[^/]+/|tmp/.|var/tmp/.)' \
  "$WORK/names" || rc=$?
case $rc in 0) die "build leftovers in the tarball (above)" ;; 1) ;; *) die "couldn't search the tarball's listing (grep exit $rc)" ;; esac
# The build VM's name (build.sh: tinhat-build, tinhat-build-arm64) in what the tarball carries, overlay included.
rc=0; LC_ALL=C grep -a -z -q -i -F tinhat-build "$TAR" || rc=$?
case $rc in 0) die "the tarball holds the build VM's name (tinhat-build)" ;; 1) ;; *) die "couldn't search the tarball (grep exit $rc)" ;; esac

step "compress ($COMPRESS)"
NAME="tinhat-server-$VER-wsl.tar.$COMPRESS"
case "$COMPRESS" in
  gz) gzip -6 -n -c "$TAR" > "$WORK/$NAME" ;;
  xz) xz -T0 -6 -c "$TAR" > "$WORK/$NAME" ;;
  *) die "COMPRESS must be gz or xz" ;;
esac
rm -f "$OUT/$NAME.keys"
mv -f "$WORK/$NAME" "$OUT/$NAME"
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256")
[ -z "$KEYS" ] || { echo "sha256 $(cut -d' ' -f1 "$OUT/$NAME.sha256")"; sed -n 's/^\(RW.*\)$/key \1/p' <<<"$KEYS"; } > "$OUT/$NAME.keys"

step "done"
umount "$MNT"; losetup -d "$LOOP"; LOOP=""
ls -l "$OUT/$NAME"
cat "$OUT/$NAME.sha256"
