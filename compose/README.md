# Tin Hat Server with Docker Compose

For a machine that already runs Docker: a NAS (Unraid, TrueNAS, Synology Container Manager), a homelab server,
Portainer, CasaOS. It's the same server as the image and `install.sh`, set up and looked after the same way (the setup
page, then the dashboard).

## Start
```
mkdir tinhat && cd tinhat
curl -fsSLO https://github.com/TinHatLabs/TinHatServer/releases/latest/download/docker-compose.yml
docker compose up -d
docker logs tinhat-manager
```
The log shows the setup page's address (`http://<this machine>/`) and the 8-digit setup code. Open the address on a
computer or phone on the same network and follow the steps. Later: `docker exec tinhat-manager tinhat setup-code`.

## What it needs
- **Docker Engine (rootful) with the compose plugin on Linux**, 64-bit Intel/AMD (ARM later). Tested on Debian's Docker
  26 + compose 2.26. Not supported: Docker Desktop (Windows/Mac: use Tin Hat Server for Windows or a VM), rootless
  Docker, SELinux in enforcing mode (labels aren't set up). Synology and other NAS systems: should work with the
  paths unchanged; not tested yet.
- This machine's ports **80, 443, TCP 7881 and UDP 7882** — or, if your own reverse proxy on **this** machine (or in
  a container on it: Nginx Proxy Manager, Traefik, Caddy) keeps 80 and 443, set `TINHAT_BEHIND_PROXY=1` in `.env`
  (see `.env.example` and REVERSE-PROXY.md): setup then answers on port 8080. A proxy on another computer doesn't
  need it: leave it out and choose My own domain → My own reverse proxy at setup (Tin Hat's parts check sign-ins at
  your domain, which then has to lead to a proxy on this machine — or, without the setting, to Tin Hat itself).
- Folders `/var/lib/tinhat` (your server: accounts, messages, files, keys) and `/opt/tinhat` (the installed release).
  They are mounted at the same paths inside the container on purpose: Tin Hat starts its parts (chat server, database,
  calls, web server, extras) as containers of their own through the Docker socket, and those mount folders from there.
  **Don't change those two paths** in the compose file (on a NAS, `/var/lib/tinhat` can be a symlink to a share):
  the parts would mount a different, empty folder.
- **What the Docker socket means:** the manager can start any container on this machine, which is as good as root
  on it. That's how it runs and updates its parts; it does nothing else with it. If that's too much trust for a
  machine that runs other important things, give Tin Hat a VM of its own (the VM image).

## Updates
`docker compose pull && docker compose up -d`. The new version installs itself the way it does on every Tin Hat
Server: a safety copy of the database and settings first, then a health check, and if the new version doesn't start
properly it goes back to the old one by itself (and won't try that version again until you say so:
`TINHAT_RETRY_UPDATE=1 docker compose up -d`, once). Messages sent during the minute or two of an update that goes
back may be missing afterwards. The dashboard's Updates card says when a new version is out. To stay
on one version, set `TINHAT_VERSION` in `.env`.

## Different from the image
- **Home-network names** (`yourname.local`) need the host's avahi: uncomment the D-Bus line in the compose file on a
  machine that runs avahi-daemon. Otherwise choose "Friends anywhere" (a free `yourname.tinhat.me`) or your own domain.
- **USB backups** aren't offered (mounting a drive needs a privileged container). Use "Download a backup", or back up
  `/var/lib/tinhat` with your NAS's own tools while the whole server is stopped (both `down` commands under Remove).
- The `tinhat` command lives in the container: `docker exec tinhat-manager tinhat status` (also `setup-code`,
  `recovery-code`, `logs`).

## Moving from install.sh to Compose
On that machine first `sudo systemctl disable --now tinhat-manager tinhat-update` (the old manager must not run
next to the new one), keep `/var/lib/tinhat`, then `docker compose up -d`: it makes a safety copy of the database
and settings, writes the configs for this release and comes up as the same server.

## Remove
In the compose file's folder:
```
docker compose down
docker compose -p tinhat -f /opt/tinhat/compose.yaml --env-file /var/lib/tinhat/compose.env down
```
Your server's data stays in `/var/lib/tinhat` (delete it to remove that too) and the release in `/opt/tinhat`. The
parts' images stay too: `docker images` lists them (postgres, synapse, livekit, lk-jwt-service, tinhat/*).
