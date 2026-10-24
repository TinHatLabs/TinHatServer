# tinhat/api — the server-side part of Tin Hat's extras on every Tin Hat Server: one Node service (tinhat-api/: the
# soundboard + myinstants, GIFs, YouTube search, guest links, Memories files, call moderation, Reach presence, web push
# and its gateway for Synapse, game servers) and the games catalogue (games/). Built by provision.sh into the appliance
# image and shipped in releases (install.sh / the updater load it); never pulled from a registry. python3: mi-fetch.py
# (myinstants answers Python's TLS stack, not Node's); ffmpeg: Memories thumbnails. Everything the services talk to
# comes from their environment (written by the manager into /var/lib/tinhat/api): nothing is built in.
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/tinhat-api
COPY tinhat-api/package.json tinhat-api/package-lock.json ./tinhat-api/
RUN cd tinhat-api && npm ci --omit=dev --no-audit --no-fund
COPY games/package.json games/package-lock.json ./games/
RUN cd games && npm ci --omit=dev --no-audit --no-fund
COPY tinhat-api/*.mjs tinhat-api/mi-fetch.py ./tinhat-api/
COPY games/server.mjs games/seed.json ./games/
ENV NODE_ENV=production
WORKDIR /opt/tinhat-api/tinhat-api
CMD ["node", "server.mjs"]
