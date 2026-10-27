# Tin Hat Server

Your own server for [Tin Hat](https://tinhat.dev/): private chat, voice and video for a group of friends, on a
computer you own. You set it up in a browser in about 20 minutes, then look after it from a dashboard: invites,
updates, backups, moving to another computer.

**Use Tin Hat for anything, including streaming, communities and businesses. If you run a modified version for other
people, share your changes** ([AGPL-3.0-or-later](LICENSE)).

**Download:** the [latest release](https://github.com/TinHatLabs/TinHatServer/releases/latest) has every file below;
step-by-step guides for each are on [tinhat.dev/server](https://tinhat.dev/server/). The apps (Windows, Linux, Flatpak,
web) are at [tinhat.dev](https://tinhat.dev/).

## Ways to run it
| On | You get |
|---|---|
| **A spare computer or a virtual machine** | a disk image, `tinhat-server-<version>-amd64.qcow2` (or `-arm64`): Proxmox, UTM, virt-manager; `-amd64.vmdk.zip` for VirtualBox and VMware, `-amd64.vhdx.zip` for Hyper-V (unzip it, then attach the disk inside) |
| **A Linux machine of your own** | `install.sh`, for Debian 13 or Ubuntu 24.04 on Intel/AMD or ARM; it leaves the machine's name, network, SSH and firewall alone |
| **A machine that already runs Docker** (a NAS, a homelab server) | `docker-compose.yml` (`compose/README.md`) |
| **A Windows 11 PC** | `TinHatServer-Setup-<version>.exe`: the server runs in the background (WSL 2), with a tray icon |

Each one sets up the same way: open the address it shows, type its setup code, answer a few questions. Who can join:
- **Your home network:** `yourname.local`, nothing to set up on the internet side.
- **Friends anywhere:** a free `yourname.tinhat.me` name with a Let's Encrypt certificate; the server opens three ports on
  your router (UPnP, or it tells you which). Needs internet that accepts incoming connections, which most 5G home
  internet and Starlink plans don't.
- **Your own domain:** certificates through your DNS provider (Cloudflare, Porkbun, deSEC, DuckDNS), or behind your
  own reverse proxy.

## What's inside
- Synapse (Matrix), PostgreSQL, LiveKit (calls) and Caddy (HTTPS) in Docker, each pinned by digest
  (`appliance/rootfs/opt/tinhat/compose.yaml`).
- The Tin Hat API (`api/`): the soundboard, GIFs, YouTube search, guest links, Memories, call moderation, presence,
  push notifications, the game-servers widget and the games catalogue, on every server with the owner's own keys
  (the dashboard's "Extras and keys" card). Nothing in it points at anyone else's machine; `docs/API.md`.
- The manager (Python, aiohttp): setup, the dashboard, updates, backups (`appliance/rootfs/opt/tinhat/manager/`).
  It runs on a pinned aiohttp that every release carries as hash-checked wheels (`build/wheels.lock`), installed
  offline into a venv on each server; the operating system's aiohttp is only the fallback (`docs/RELEASING.md`).
- Tin Hat Web (`web/`), the app your server serves to browsers: its full source, built into every release
  (`web/README.md` says how to build it yourself).

## Updates and trust
- Releases are published here, each signed with Tin Hat's release key (minisign, Ed25519), which never goes to GitHub.
  Servers check the signature and every file's checksum before installing anything, make a safety copy first, and go
  back to it by themselves if the new version doesn't start properly. A mirror (`updates.tinhat.dev`) keeps servers
  updating if GitHub doesn't answer; with both answering, they take the newest signed release.
- Calls, direct messages and rooms are end-to-end encrypted between people's devices: your server can't read them, and
  neither can we. There is no back door. Three kinds of room aren't, on purpose, so people who join later can read what
  was said before: public channels inside a space (the apps say so when you make one), the server's #general (everyone
  new joins it) and the guest room. They stay on your own server. Spaces hold no messages.
- The names service (`names/`) gives out tinhat.me names and helps with their certificates. It never sees accounts or
  messages.

## This repository
| Path | What |
|---|---|
| `appliance/` | the server: everything on its disk (`rootfs/`), `provision.sh` (installs it into a fresh Debian 13), `seal.sh`, tests |
| `build/` | building the image (`build.sh`, on a Proxmox VE host: copy `build.conf.example`), releases (`release.sh`), the Linux installer (`install-linux.sh`) |
| `api/` | the Tin Hat API that runs on every server (`docs/API.md`), the games catalogue and the guest room's door page |
| `names/` | the tinhat.me names service |
| `relay/` | a relay for homes behind carrier NAT: built and tested, not run publicly |
| `compose/` | Tin Hat Server with Docker Compose (`compose/README.md`) |
| `windows/` | Tin Hat Server for Windows: the WSL 2 distribution, the tray app (Rust), the installer (Inno Setup) |
| `web/` | Tin Hat Web, the browser app every server serves (Vite, React, TypeScript; `web/README.md`) |
| `docs/` | the Tin Hat API (`API.md`), guest links (`GUESTS.md`), your own reverse proxy (`REVERSE-PROXY.md`), releases (`RELEASING.md`) |

Tests: `python3 -m unittest discover -s appliance/tests`, and in `names/` and `relay/`:
`python3 -m unittest discover -s tests`.

## How it's made
Tin Hat is AI-built. The code is written with Claude (Anthropic's AI) and reviewed adversarially by a second AI model
(the "Astra" in the source comments), directed and tested by its maintainer. The apps and the server side have been in
daily use by one group of friends for about two years; the packaging that lets anyone run their own server is new
(October 2026). Every change goes through automated tests and adversarial reviews, and all of the source is here to
read. It has not had a professional security audit.

## Security
Found a security problem? Please don't open a public issue: report it privately through this repository's Security tab
(Report a vulnerability), or email security@tinhat.me.

## Licence
Tin Hat Server is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
later version ([LICENSE](LICENSE)). It runs other projects' software in its containers (Synapse, LiveKit, Caddy,
PostgreSQL and more), each under its own licence.
