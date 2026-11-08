# Synapse 1.145.0 (the version every Tin Hat Server runs) plus upstream security fixes backported to it, built once
# into the appliance image by provision.sh like our Caddy (the box never builds or pulls at runtime):
#   - patch_todevice_spoof.py: GHSA-rgv2-84w7-5j9p (1.157.2), to-device messages with a spoofed sender are dropped;
#   - backports/ (apply_backports.py, the list in backports/SERIES): GHSA-6wjm, -27p5, -qcjr, -r66v, -95fh, -fp53
#     (1.157.2) and GHSA-8q93 (1.152.1), upstream's own changes, plus 0006, our size limit on the actions of built-in
#     push rules (upstream's GHSA-fp53 fix leaves them out), and 0007, our per-user rate limit on push rule writes;
#     every file pinned before and after;
#   - requirements-pins.txt: Pillow 13.0.0 and msgpack 1.2.4 (what upstream moved to in 1.163.2 / 1.164.1), by hash.
# Upgrading Synapse to 1.164.1 or later replaces this image with the stock one again (the patches refuse any other code),
# unless upstream still lacks 0006's or 0007's limit: see docs/SYNAPSE-PATCHES.md.
# pinned to the digest every 0.3.x release has run (images.lock: matrixdotorg/synapse:v1.145.0 sha256:9e33e40f6e69ac7dbac331a5fa29f39b7a4f8b7765476c76fe22055014dcccb1)
FROM matrixdotorg/synapse:v1.145.0@sha256:9e33e40f6e69ac7dbac331a5fa29f39b7a4f8b7765476c76fe22055014dcccb1
COPY patch_todevice_spoof.py apply_backports.py requirements-pins.txt /tmp/th-synapse/
COPY backports/ /tmp/th-synapse/backports/
RUN set -eu; \
    export PYTHONDONTWRITEBYTECODE=1; \
    d=$(python -c 'import importlib.util; print(importlib.util.find_spec("synapse").submodule_search_locations[0])'); \
    python /tmp/th-synapse/patch_todevice_spoof.py "$d/handlers/devicemessage.py"; \
    python /tmp/th-synapse/apply_backports.py "$d" /tmp/th-synapse/backports; \
    python -m pip install --no-cache-dir --no-deps --no-compile --only-binary :all: --require-hashes \
        --disable-pip-version-check --root-user-action ignore -r /tmp/th-synapse/requirements-pins.txt; \
    sp=$(dirname "$d"); \
    files=$(sed -n "s|^[0-9a-f-]* [0-9a-f]* \(.*\.py\)\$|$d/\1|p" /tmp/th-synapse/backports/FILES); \
    python -m compileall -q -f --invalidation-mode checked-hash "$d/handlers/devicemessage.py" $files; \
    python -m compileall -q -f --invalidation-mode checked-hash "$sp/PIL" "$sp/msgpack"; \
    rm -r /tmp/th-synapse
