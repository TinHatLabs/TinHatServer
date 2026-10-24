#!/bin/bash
# bump.sh VERSION — set a new version everywhere it is written: appliance/VERSION and the tinhat/api image the
# installed compose file runs (api + games). build.sh refuses to start, and release.sh to sign, when they disagree.
set -euo pipefail
V=${1:?usage: bump.sh VERSION (like 0.3.0)}
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a version: $V" >&2; exit 1; }
HERE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
echo "$V" > "$HERE/appliance/VERSION"
sed -i -E "s#(image: tinhat/api:)[0-9]+\.[0-9]+\.[0-9]+\$#\1$V#" "$HERE/appliance/rootfs/opt/tinhat/compose.yaml"
n=$(grep -c "image: tinhat/api:$V\$" "$HERE/appliance/rootfs/opt/tinhat/compose.yaml")
[ "$n" = 2 ] || { echo "compose.yaml: expected 2 tinhat/api images at $V, found $n" >&2; exit 1; }
echo "version $V: appliance/VERSION and compose.yaml (api, games)"
