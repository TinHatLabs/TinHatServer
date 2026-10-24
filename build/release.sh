#!/bin/bash
# release.sh VERSION [--github OWNER/REPO [--prerelease] [--publish]] [--mirror DIR] [--min-from V] [--security] [--note TEXT]…
#   — make a built version an update. One release is:
#   tinhat-server-VERSION.update.tar.gz  the bundle: manager + pages, compose file, images.lock(s), Tin Hat Web, host/
#   tinhat-caddy-<id>[-arm64].tar.gz     our own Caddy image (servers fetch it only when they lack it)
#   stable.json + stable.json.minisig    the manifest, signed (minisign, Ed25519)
#   install.sh + install.sh.minisig      Tin Hat Server for a Linux machine of your own (the release key and where
#                                        releases come from filled in), signed too
# Without --github everything lands in out/channel/, named relative to the manifest: a plain web folder (a test
# channel, or a mirror that carries the files itself).
# --github OWNER/REPO: the manifest names its files at https://github.com/OWNER/REPO/releases/download/vVERSION/…
#   (pinned to this release: a newer "latest" can't swap a file under a server mid-update). out/github/vVERSION/ holds
#   the release's assets: the above, plus this version's VM images (qcow2, and the amd64 disk zipped as .vhdx.zip and
#   .vmdk.zip: GitHub takes no file of 2 GiB or more; each with its .sha256) and Windows installer when they were
#   built, each also under a name without the version (tinhat-server-amd64.qcow2, TinHatServer-Setup.exe, …: the site
#   links …/releases/latest/download/<that name>), and SHA256SUMS + SHA256SUMS.minisig over all of them for people
#   who check by hand. Its notes go to
#   out/github/vVERSION.notes.md. --publish creates the GitHub release with gh (the tag vVERSION must be pushed
#   first); --prerelease keeps it out of "latest", so servers don't see it until
#   `gh release edit vVERSION --repo OWNER/REPO --prerelease=false --latest`.
#   The mirror (https://updates.tinhat.dev/server/) then only needs stable.json(.minisig) and install.sh(.minisig):
#   the manifest points at GitHub. If GitHub ever goes away, a release without --github puts the files there too.
# --mirror DIR: copy those four small signed files into DIR (the mirror's folder: public/server/ in the site
#   repository, which deploys to updates.tinhat.dev when pushed).
# Needs the working tree at VERSION and out/release-VERSION/ (build.sh artifacts, from that version's image build).
# Key: $TINHAT_RELEASE_KEY (minisign secret key; build/build.local.conf may set it). See docs/RELEASING.md.
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
VER=${1:?usage: release.sh VERSION [--github OWNER/REPO [--prerelease] [--publish]] [--min-from V] [--security] [--note TEXT]...}
shift
GH="" PRE=0 PUBLISH=0 MIRRORDIR="" MINFROM="" SEC=false NOTES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --github) GH=$2; shift ;;
    --prerelease) PRE=1 ;;
    --publish) PUBLISH=1 ;;
    --mirror) MIRRORDIR=$2; shift ;;
    --min-from) MINFROM=$2; shift ;;
    --security) SEC=true ;;
    --note) NOTES+=("$2"); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(cat "$HERE/appliance/VERSION")" = "$VER" ] || { echo "appliance/VERSION is not $VER" >&2; exit 1; }
grep -q "image: tinhat/api:$VER\$" "$HERE/appliance/rootfs/opt/tinhat/compose.yaml" || { echo "compose.yaml must run tinhat/api:$VER (bump it with appliance/VERSION)" >&2; exit 1; }
R=$HERE/out/release-$VER
[ -f "$R/images.lock" ] || { echo "no $R — run build.sh artifacts during $VER's image build" >&2; exit 1; }
if [ -n "$GH" ]; then
  [[ "$GH" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "--github wants OWNER/REPO" >&2; exit 2; }
  # Servers built from this tree must look there too, or nobody ever sees the release (the lab sets its own channel).
  grep -q "github.com/$GH/releases/latest/download/stable.json" "$HERE/appliance/rootfs/opt/tinhat/manager/tinhat/environment.py" ||
    echo "WARNING: environment.py's updates_url doesn't name github.com/$GH: servers built from this tree won't look there" >&2
else
  [ "$PUBLISH$PRE" = 00 ] || { echo "--publish and --prerelease need --github OWNER/REPO" >&2; exit 2; }
fi
[ -f "$HERE/build/build.local.conf" ] && . "$HERE/build/build.local.conf"
KEY=${TINHAT_RELEASE_KEY:?set TINHAT_RELEASE_KEY to the minisign secret key (or in build/build.local.conf)}
# The downloads people pick by hand that carry a whole server: this version's VM images, the Compose edition's image
# and the Windows installer, when they were built (the GitHub release attaches these).
downloads() {
  local f
  for f in "$HERE"/out/tinhat-server-"$VER"-{amd64,arm64}.qcow2 "$HERE"/out/tinhat-server-"$VER"-amd64.{vhdx,vmdk}.zip \
           "$HERE"/out/release-"$VER"/tinhat-server-compose.tar.gz "$HERE"/out/windows/TinHatServer-Setup-"$VER".exe; do
    [ -f "$f" ] && echo "$f"
  done
  return 0
}
# GitHub refuses a release file of 2 GiB or more (0.3.0 had to hold its .vhdx and .vmdk back): with a margin, before
# anything is signed. build.sh export zips the two disks; an unzipped one from an older build is left out, loudly.
MAX_ASSET=1932735283  # 1.8 GiB, as build.sh
if [ -n "$GH" ]; then
  while read -r f; do
    [ "$(stat -c %s "$f")" -lt "$MAX_ASSET" ] ||
      { echo "$(basename "$f") is $(stat -c %s "$f") bytes: too big for a GitHub release (under $MAX_ASSET); rebuild it" >&2; exit 1; }
  done < <(downloads)
  for f in "$HERE"/out/tinhat-server-"$VER"-amd64.{vhdx,vmdk}; do
    [ ! -f "$f" ] || [ -f "$f.zip" ] || echo "WARNING: $(basename "$f") isn't zipped (build.sh export zips it): the release goes without it" >&2
  done
fi
if [ "$PUBLISH" = 1 ]; then  # the real thing: never the development key, never images that still trust it
  [ "$(sed -n 2p "${KEY%.key}.pub")" != "$(sed -n 2p "$HERE/appliance/rootfs/opt/tinhat/manager/tinhat/keys/tinhat-dev.pub" 2>/dev/null)" ] ||
    { echo "--publish needs the release key (TINHAT_RELEASE_KEY), not the development key" >&2; exit 1; }
  # ...and a key this tree's servers trust (keys/*.pub), or every server would refuse the release
  cat "$HERE"/appliance/rootfs/opt/tinhat/manager/tinhat/keys/*.pub 2>/dev/null | grep -qxF "$(sed -n 2p "${KEY%.key}.pub")" ||
    { echo "--publish: servers built from this tree don't trust $KEY (its .pub isn't in keys/)" >&2; exit 1; }
  [ ! -e "$HERE/appliance/rootfs/opt/tinhat/manager/tinhat/keys/tinhat-dev.pub" ] ||
    { echo "--publish: keys/tinhat-dev.pub is still trusted by this tree's servers; remove it (and rebuild the images)" >&2; exit 1; }
  # Those downloads were built earlier, from what the tree held then: each must trust this release key and nothing
  # else, by the record its build wrote next to it (FILE.keys: its sha256 and the keys read from the image itself).
  WANT=$(sed -n 2p "${KEY%.key}.pub")
  while read -r f; do
    k=$f.keys
    [ -f "$k" ] || { echo "--publish: no $k (the update keys $(basename "$f") trusts): rebuild it" >&2; exit 1; }
    [ "$(sed -n 's/^sha256 //p' "$k")" = "$(sha256sum "$f" | cut -d' ' -f1)" ] ||
      { echo "--publish: $k describes another build of $(basename "$f"): rebuild it" >&2; exit 1; }
    [ "$(sed -n 's/^key //p' "$k")" = "$WANT" ] ||
      { echo "--publish: $(basename "$f") trusts other update keys than this release key: rebuild it" >&2; exit 1; }
  done < <(downloads)
fi
# A key with a password (the real one, docs/RELEASING.md) is asked for once, here, before any work: typed on the
# terminal, tried on the key at once (three tries), then handed to each signature on stdin, never on a command line.
set +a; unset KEYPW; declare +x KEYPW=""  # never exported: it must not reach any other program's environment
T=$(mktemp)
echo probe > "$T"
if ! minisign -S -s "$KEY" -m "$T" -t probe </dev/null >/dev/null 2>&1; then
  if ! { : </dev/tty; } 2>/dev/null; then
    rm -f "$T" "$T.minisig"; echo "$KEY has a password: run release.sh in a terminal, where it can ask for it" >&2; exit 1
  fi
  for i in 1 2 3; do
    IFS= read -rsp "Password for the release key ($KEY): " KEYPW </dev/tty; echo >/dev/tty
    minisign -S -s "$KEY" -m "$T" -t probe <<<"$KEYPW" >/dev/null 2>&1 && break
    KEYPW=""
    [ "$i" = 3 ] && { rm -f "$T" "$T.minisig"; echo "That isn't the key's password; nothing was signed." >&2; exit 1; }
    echo "That isn't the key's password; try again." >&2
  done
fi
# The secret key and its .pub must be a pair (the checks above read the .pub).
minisign -Vq -p "${KEY%.key}.pub" -m "$T" >/dev/null 2>&1 ||
  { rm -f "$T" "$T.minisig"; echo "$KEY and ${KEY%.key}.pub aren't a pair" >&2; exit 1; }
rm -f "$T" "$T.minisig"
sign() {  # sign FILE TRUSTED-COMMENT (minisign's own "Password:" prompt stays quiet: it reads it from here)
  local e
  e=$(minisign -S -s "$KEY" -m "$1" -t "$2" <<<"$KEYPW" 2>&1 >/dev/null) || { echo "$e" >&2; return 1; }
}
MIRROR=${TINHAT_MIRROR:-https://updates.tinhat.dev/server/stable.json}
if [ -n "$GH" ]; then
  C=$HERE/out/github/v$VER BASE="https://github.com/$GH/releases/download/v$VER/"
  CHANNELS="https://github.com/$GH/releases/latest/download/stable.json $MIRROR"
  INSTALL_URL="https://github.com/$GH/releases/latest/download/install.sh"
  rm -rf "$C"
else
  C=$HERE/out/channel BASE=""
  CHANNELS=$MIRROR INSTALL_URL=${MIRROR%/*}/install.sh
fi
mkdir -p "$C"
B=$(mktemp -d)
trap 'rm -rf "$B"' EXIT
mkdir -p "$B/b"
cp -a "$HERE/appliance/rootfs/opt/tinhat/manager" "$B/b/manager"
find "$B/b" -name __pycache__ -prune -exec rm -rf {} +
cp "$HERE/appliance/rootfs/opt/tinhat/compose.yaml" "$R/images.lock" "$B/b/"
echo "$VER" > "$B/b/VERSION"
cp -a "$R/web" "$B/b/web"
# An arm64 build of the same version (ARCH=arm64 build.sh … artifacts): its images.lock rides along in the bundle, and
# its Caddy image goes in the channel next to the amd64 one.
RA=$HERE/out/release-$VER-arm64
[ -f "$RA/images.lock" ] && cp "$RA/images.lock" "$B/b/images.lock.arm64"
# For install.sh on someone's own Linux machine (and the `tinhat` command, which updates refresh): the host-safe part
# of the image's files. Never the image's network, hostname, SSH or Docker settings.
mkdir -p "$B/b/host/etc/systemd/system" "$B/b/host/usr/local/sbin" "$B/b/host/etc/sysctl.d"
cp "$HERE/appliance/rootfs/etc/systemd/system/tinhat-manager.service" \
   "$HERE/appliance/rootfs/etc/systemd/system/tinhat-update.service" "$B/b/host/etc/systemd/system/"
install -m 0755 "$HERE/appliance/rootfs/usr/local/sbin/tinhat" "$B/b/host/usr/local/sbin/tinhat"
printf '# Tin Hat Server: bigger UDP buffers for the call server (LiveKit asks for 5 MB; the default is ~400 KB).\nnet.core.rmem_max = 5000000\nnet.core.wmem_max = 5000000\n' \
  > "$B/b/host/etc/sysctl.d/90-tinhat-host.conf"
BUNDLE=tinhat-server-$VER.update.tar.gz
tar -C "$B/b" --owner=0 --group=0 --numeric-owner -czf "$C/$BUNDLE" .
# Every image of our own (tinhat/caddy, tinhat/api): each one's tarball from the build's artifacts, by its id, and
# per processor. The manifest's `images` (and `images_arm64`) map ref → {id, url, sha256}; servers load what they lack.
OWN_IMAGES=() OWN_IMAGES_ARM=()
for ref in $(awk '$1 ~ /^tinhat\//{print $1}' "$R/images.lock"); do
  name=${ref#tinhat/}; name=${name%%:*}
  id=$(awk -v r="$ref" '$1 == r {print $2; exit}' "$R/images.lock")
  [ -f "$R/tinhat-$name.tar.gz" ] || { echo "no $R/tinhat-$name.tar.gz (build.sh artifacts)" >&2; exit 1; }
  tar=tinhat-$name-${id:7:12}.tar.gz
  cp "$R/tinhat-$name.tar.gz" "$C/$tar"
  OWN_IMAGES+=("$ref|$id|$tar")
done
if [ -f "$RA/images.lock" ]; then
  for ref in $(awk '$1 ~ /^tinhat\//{print $1}' "$RA/images.lock"); do
    name=${ref#tinhat/}; name=${name%%:*}
    id=$(awk -v r="$ref" '$1 == r {print $2; exit}' "$RA/images.lock")
    [ -f "$RA/tinhat-$name.tar.gz" ] || { echo "no $RA/tinhat-$name.tar.gz (ARCH=arm64 build.sh artifacts)" >&2; exit 1; }
    tar=tinhat-$name-${id:7:12}-arm64.tar.gz
    cp "$RA/tinhat-$name.tar.gz" "$C/$tar"
    OWN_IMAGES_ARM+=("$ref|$id|$tar")
  done
fi
python3 - "$C" "$VER" "$BASE" "$BUNDLE" "$MINFROM" "$SEC" "${OWN_IMAGES[*]}" "${OWN_IMAGES_ARM[*]}" "${NOTES[@]}" <<'PY'
import hashlib, json, os, sys, time
c, ver, base, bundle, minfrom, sec, own, own_arm, *notes = sys.argv[1:]
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
def images(spec):
    out = {}
    for item in spec.split():
        ref, cid, tar = item.split("|")
        out[ref] = {"id": cid, "url": base + tar, "sha256": sha(os.path.join(c, tar))}
    return out
m = {"channel": "stable", "version": ver, "published": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
     "bundle": {"url": base + bundle, "sha256": sha(os.path.join(c, bundle)), "size": os.path.getsize(os.path.join(c, bundle))},
     "min_from": minfrom or None, "security": sec == "true", "notes": notes,
     "images": images(own)}
if own_arm:  # servers on arm64 read images_arm64 (and the bundle's images.lock.arm64); older ones never look
    m["images_arm64"] = images(own_arm)
open(os.path.join(c, "stable.json"), "w").write(json.dumps(m, indent=2) + "\n")
print(json.dumps(m, indent=2))
PY
rm -f "$C/stable.json.minisig"
sign "$C/stable.json" "tinhat-server stable $VER"
minisign -V -p "${KEY%.key}.pub" -m "$C/stable.json" >/dev/null || { echo "$C/stable.json doesn't verify" >&2; exit 1; }
echo "signed and verified: $C/stable.json"
cp "$HERE/compose/docker-compose.yml" "$HERE/compose/.env.example" "$C/"  # the Compose edition (compose/README.md)
PUB=$(sed -n 2p "${KEY%.key}.pub")
sed -e "s|__TINHAT_RELEASE_PUBKEY__|$PUB|" -e "s|__TINHAT_CHANNELS__|$CHANNELS|" -e "s|__TINHAT_INSTALL_URL__|$INSTALL_URL|" \
  "$HERE/build/install-linux.sh" > "$C/install.sh"
rm -f "$C/install.sh.minisig"
sign "$C/install.sh" "tinhat-server install.sh for $VER"
minisign -V -p "${KEY%.key}.pub" -m "$C/install.sh" >/dev/null || { echo "$C/install.sh doesn't verify" >&2; exit 1; }
echo "signed and verified: $C/install.sh"

if [ -n "$GH" ]; then
  # The downloads people pick by hand: this version's VM images and the Windows installer, when they were built. Each
  # also goes under its name without "-VERSION" (the same file, also in SHA256SUMS): the site's buttons link
  # https://github.com/OWNER/REPO/releases/latest/download/<that name>, so they never change with a release.
  while read -r f; do
    for g in "$f" "$f.sha256"; do
      [ -f "$g" ] && { ln -f "$g" "$C/" 2>/dev/null || cp "$g" "$C/"; }
    done
    b=$(basename "$f") fixed=$(basename "$f"); fixed=${fixed/-$VER/}
    if [ "$fixed" != "$b" ]; then
      [ ! -e "$C/$fixed" ] || { echo "$fixed: two downloads would have that name" >&2; exit 1; }
      ln -f "$f" "$C/$fixed" 2>/dev/null || cp "$f" "$C/$fixed"
    fi
  done < <(downloads)
  big=$(find "$C" -maxdepth 1 -type f -size +$((MAX_ASSET - 1))c -printf '%f ')
  [ -z "$big" ] || { echo "too big for a GitHub release: $big" >&2; exit 1; }
  # every file of the release, the Compose edition's .env.example included (a plain `ls` or glob skips dot files)
  (cd "$C" && find . -maxdepth 1 -type f ! -name 'SHA256SUMS*' -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum > SHA256SUMS)
  sign "$C/SHA256SUMS" "tinhat-server $VER: checksums of every file in the release"
  minisign -V -p "${KEY%.key}.pub" -m "$C/SHA256SUMS" >/dev/null || { echo "$C/SHA256SUMS doesn't verify" >&2; exit 1; }
  # Two versions of the notes: as a pre-release (nothing is "latest" yet: install this exact version) and for when it
  # becomes the latest release (`gh release edit vX.Y.Z --notes-file …-latest.md` with the promotion, RELEASING.md).
  notes() {  # notes PINNED(1|0)
  local install_line
  if [ "$1" = 1 ]; then
    install_line="- a Linux machine of your own (Debian 13, Ubuntu 24.04): \`curl -fsSLO ${BASE}install.sh\` then \`sudo bash install.sh --channel ${BASE}stable.json\` (this test release; once it is the latest, plain \`sudo bash install.sh\` from the latest release);"
  else
    install_line="- a Linux machine of your own (Debian 13, Ubuntu 24.04): \`curl -fsSLO $INSTALL_URL\` then \`sudo bash install.sh\`;"
  fi
  {
    echo "Tin Hat Server $VER"
    echo
    if [ ${#NOTES[@]} -gt 0 ]; then printf -- '- %s\n' "${NOTES[@]}"; echo; fi
    [ "$SEC" = true ] && { echo "This update fixes a security problem: servers install it the next night."; echo; }
    echo "Servers update themselves from this page (Dashboard → Maintenance → Updates). To set one up:"
    ls "$C"/*.qcow2 >/dev/null 2>&1 &&
      echo "- a spare computer or a virtual machine: the \`.qcow2\` image for your processor (amd64 = Intel/AMD, arm64 = ARM);"
    ls "$C"/*.vhdx.zip >/dev/null 2>&1 &&
      echo "- Hyper-V: \`tinhat-server-$VER-amd64.vhdx.zip\`; unzip it, the disk inside is the \`.vhdx\` (Intel/AMD);"
    ls "$C"/*.vmdk.zip >/dev/null 2>&1 &&
      echo "- VirtualBox or VMware: \`tinhat-server-$VER-amd64.vmdk.zip\`; unzip it and attach the \`.vmdk\` inside as the disk (Intel/AMD);"
    echo "$install_line"
    [ -f "$C/TinHatServer-Setup-$VER.exe" ] &&
      echo "- a Windows PC: \`TinHatServer-Setup-$VER.exe\` (Windows warns about an unknown publisher: More info → Run anyway)."
    echo
    echo "Check a download (a .zip as you downloaded it): \`sha256sum -c SHA256SUMS --ignore-missing\`, and that the list is ours:"
    echo "\`minisign -Vm SHA256SUMS -P $PUB\`"
  }
  }
  N=$HERE/out/github/v$VER.notes.md
  notes "$PRE" > "$N"
  notes 0 > "$HERE/out/github/v$VER.notes-latest.md"
  echo "release files: $C ($(ls -A "$C" | wc -l) files, $(du -sh "$C" | cut -f1)); notes: $N"
  if [ "$PUBLISH" = 1 ]; then
    command -v gh >/dev/null || { echo "gh (GitHub's command line) isn't installed here" >&2; exit 1; }
    if [ "$PRE" = 1 ]; then flags=(--prerelease); else flags=(--latest); fi
    mapfile -t assets < <(find "$C" -maxdepth 1 -type f | LC_ALL=C sort)  # dot files too: .env.example
    [ "${#assets[@]}" -eq "$(find "$C" -mindepth 1 -maxdepth 1 | wc -l)" ] || { echo "$C holds something that isn't a plain file" >&2; exit 1; }
    gh release create "v$VER" --repo "$GH" --verify-tag --title "Tin Hat Server $VER" --notes-file "$N" "${flags[@]}" "${assets[@]}"
    [ "$PRE" = 1 ] && echo "a prerelease: servers see it after: gh release edit v$VER --repo $GH --prerelease=false --latest"
  fi
fi
if [ -n "$MIRRORDIR" ]; then
  [ -d "$MIRRORDIR" ] || { echo "--mirror: no folder $MIRRORDIR" >&2; exit 1; }
  for f in stable.json stable.json.minisig install.sh install.sh.minisig; do cp "$C/$f" "$MIRRORDIR/$f"; done
  echo "mirror files in $MIRRORDIR: commit and push the site repository to put them on updates.tinhat.dev"
fi
