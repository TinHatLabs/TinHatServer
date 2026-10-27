# tinhat/server — the Docker Compose edition of Tin Hat Server (docs: compose/README.md). The image is the runtime
# (python3 + Tin Hat's pinned aiohttp, the docker CLI and compose plugin, minisign, restic) plus one whole release in
# /usr/share/tinhat/release (manager/, compose.yaml, VERSION, images.lock[.arm64], web/, host/, and our own images'
# tarballs in images/). Its entry (tinhat.compose_entry) installs or updates that release into /opt/tinhat and then
# runs the manager from there, like every other edition. build.sh compose builds it from a release's files.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-aiohttp docker-cli docker-compose ca-certificates \
       curl jq iproute2 minisign restic cifs-utils exfatprogs avahi-utils procps \
    && rm -rf /var/lib/apt/lists/*
COPY release/ /usr/share/tinhat/release/
# Tin Hat's pinned aiohttp: the release's manager/wheels (build/wheels.lock, each file checked by sha256), installed
# offline into this venv and checked here, compiled parts included. The manager starts on it once its check passes at
# start, else on Debian's python3-aiohttp above, and says so (tinhat/pyenv.py).
ENV TINHAT_VENV=/usr/lib/tinhat/venv
RUN cd /usr/share/tinhat/release/manager && python3 -m tinhat pyenv build --strict
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /usr/share/tinhat/release/manager
LABEL org.opencontainers.image.title="Tin Hat Server" \
      org.opencontainers.image.source="https://github.com/TinHatLabs/TinHatServer" \
      org.opencontainers.image.description="Your own Tin Hat server: chat, calls and the extras for a group of friends"
CMD ["python3", "-m", "tinhat.compose_entry"]
