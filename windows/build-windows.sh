#!/bin/bash
# build-windows.sh — build the Windows installer, TinHatServer-Setup-<ver>.exe, on the Windows build machine.
#
#   windows/build-windows.sh [VERSION]            VERSION defaults to the newest out/windows/tinhat-server-<ver>-wsl.tar.gz
#   SIGN=1 SIGN_ARGS='/sha1 <thumbprint>' windows/build-windows.sh    optional code signing (off by default; README)
#
# Needs: the Windows build machine running and `ssh $VM` working (VM defaults to the SSH alias buildwin; Rust +
# Inno Setup 6 + Windows SDK on it), and the WSL rootfs (windows/build-rootfs.sh makes it). Everything there goes to
# C:\th-build\stage-<ver>; the result lands in
# OUT (default out/windows in this repository) with a .sha256.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/.." && pwd)
OUT=${OUT:-$TOP/out/windows}
VM=${VM:-buildwin}
die() { echo "build-windows: $*" >&2; exit 1; }

VER=${1:-$(ls -1 "$OUT"/tinhat-server-*-wsl.tar.gz 2>/dev/null | sed -nE 's#.*/tinhat-server-(.+)-wsl\.tar\.gz$#\1#p' | sort -V | tail -1)}
[ -n "$VER" ] || die "no rootfs in $OUT: run windows/build-rootfs.sh first"
TAR="$OUT/tinhat-server-$VER-wsl.tar.gz"
[ -f "$TAR" ] || die "missing $TAR (windows/build-rootfs.sh out/tinhat-server-$VER-amd64.qcow2)"
(cd "$OUT" && sha256sum -c --quiet "$(basename "$TAR").sha256") || die "$TAR doesn't match its .sha256"
timeout 15 ssh -o ConnectTimeout=8 "$VM" 'echo ok' >/dev/null 2>&1 || die "can't reach $VM (is the Windows build machine running?)"

STAGE=$(mktemp -d "$OUT/.stage-XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
echo "== staging $VER"
mkdir -p "$STAGE/src"
cp -r "$HERE/tray" "$STAGE/src/tray"
rm -rf "$STAGE/src/tray/target"
sed -i -E "0,/^version = \".*\"/s//version = \"$VER\"/" "$STAGE/src/tray/Cargo.toml"
# Cargo.lock pins the package's own version too (the build runs with --locked)
sed -i -E "/^name = \"tinhat-server-windows\"$/{n;s/^version = \".*\"/version = \"$VER\"/}" "$STAGE/src/tray/Cargo.lock"
mkdir -p "$STAGE/src/installer"
printf '\xef\xbb\xbf' > "$STAGE/src/installer/TinHatServer.iss"      # Inno reads UTF-8 only with a BOM
cat "$HERE/installer/TinHatServer.iss" >> "$STAGE/src/installer/TinHatServer.iss"
printf '\xef\xbb\xbf' > "$STAGE/src/installer/setup-helper.ps1"     # Windows PowerShell 5.1 likewise
cat "$HERE/installer/setup-helper.ps1" >> "$STAGE/src/installer/setup-helper.ps1"
cp -r "$HERE/installer/assets" "$STAGE/src/installer/assets"            # the wizard's pictures (the dark look)
cp "$HERE/build.ps1" "$STAGE/src/build.ps1"
python3 -I "$HERE/tools/make-icons.py" "$STAGE/src/icons" >/dev/null
(cd "$STAGE/src" && tar -cf "$STAGE/src.tar" .)

W="C:\\th-build\\stage-$VER"
echo "== copying to $VM:$W"
ssh "$VM" "if exist $W rmdir /s /q $W" >/dev/null 2>&1 || true
ssh "$VM" "mkdir $W" >/dev/null
scp -q "$STAGE/src.tar" "$VM:C:/th-build/stage-$VER/src.tar"
scp -q "$TAR" "$VM:C:/th-build/stage-$VER/tinhat-server-$VER-wsl.tar.gz"
ssh "$VM" "cd /d $W && tar -xf src.tar && del src.tar"

echo "== building on $VM"
SIGNOPT=""
if [ "${SIGN:-0}" = 1 ]; then
  [ -n "${SIGN_ARGS:-}" ] || die "SIGN=1 needs SIGN_ARGS (see windows/README.md, Code signing)"
  SIGNOPT="-Sign -SignArgs \"$SIGN_ARGS\""
fi
ssh "$VM" "powershell -NoProfile -ExecutionPolicy Bypass -File $W\\build.ps1 -Stage $W -Version $VER $SIGNOPT" | tr -d '\r'

echo "== fetching"
rm -f "$OUT/TinHatServer-Setup-$VER.exe.keys"
scp -q "$VM:C:/th-build/stage-$VER/out/TinHatServer-Setup-$VER.exe" "$OUT/"
(cd "$OUT" && sha256sum "TinHatServer-Setup-$VER.exe" > "TinHatServer-Setup-$VER.exe.sha256" && cat "TinHatServer-Setup-$VER.exe.sha256")
# The update keys the installed server trusts: those of the rootfs inside, when its record describes this very
# tarball (release.sh --publish refuses an installer without one).
if [ -f "$TAR.keys" ] && [ "$(sed -n 's/^sha256 //p' "$TAR.keys")" = "$(sha256sum "$TAR" | cut -d' ' -f1)" ]; then
  { echo "sha256 $(cut -d' ' -f1 "$OUT/TinHatServer-Setup-$VER.exe.sha256")"; grep '^key ' "$TAR.keys"; } > "$OUT/TinHatServer-Setup-$VER.exe.keys"
else
  echo "WARNING: no matching $TAR.keys: release.sh --publish will refuse this installer" >&2
fi
ls -l "$OUT/TinHatServer-Setup-$VER.exe"
