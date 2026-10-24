# Running Tin Hat Server behind your own reverse proxy

Most people never need this: the image, `install.sh` and the Windows installer all get their own certificate and
answer on 80/443 themselves. This page is for people who already run a reverse proxy (nginx, Caddy, Traefik, Nginx
Proxy Manager, a NAS's built-in one) that owns ports 80 and 443 and the certificates, and want Tin Hat behind it.

## How it works
- At setup choose **My own domain → My own reverse proxy** and type the domain people will use (`chat.example.com`).
- Tin Hat Server then answers **plain HTTP on port 8080**, and only to home-network addresses (private ranges and the
  machine's own addresses); everyone else gets 403 there. Your proxy terminates TLS and sends the whole domain to
  `http://<the server's address>:8080`.
- **Calls don't go through the proxy.** Forward TCP **7881** and UDP **7882** from your router straight to the
  server (setup opens them by UPnP if your router allows, and the dashboard's Network card checks them from outside).
- The setup's last page and the dashboard (Network → "Your reverse proxy") show the exact settings for nginx, Caddy,
  Traefik and Nginx Proxy Manager, with your domain, the server's address and the right body size filled in.

## Each edition
| Edition | Behind a proxy |
|---|---|
| **The image** (a VM or a spare computer) | the proxy runs on another machine on your network: choose the mode at setup |
| **install.sh** on a Linux machine | proxy on another machine: as above (**without** `--behind-proxy`). Proxy on the **same** machine (80/443 already taken): `sudo bash install.sh --behind-proxy` — setup then answers on 8080 from the start and never tries to bind 80/443. The flag is only for that case: with it Tin Hat has no HTTPS of its own and its parts check sign-ins through your proxy, so with the proxy elsewhere calls couldn't sign in (install.sh refuses the flag when nothing on the machine answers 443; `--force` if the proxy is coming next) |
| **Windows** | the proxy on another machine; the installer allows 8080 through Windows' Hyper-V firewall on Private networks (0.2.21+) |
| **Docker Compose** | proxy on this machine or in a container on it: `TINHAT_BEHIND_PROXY=1` in its `.env` (the Compose edition's notes). Proxy on another machine: leave it out and choose the mode at setup |

## What the proxy must do
- Send **everything** for the domain (not a sub-path: Tin Hat needs its own host name) to port 8080, with the
  original `Host` header.
- WebSockets (the call sign-in uses one): `Upgrade` / `Connection` headers passed through.
- `X-Forwarded-For` and `X-Forwarded-Proto` set; Tin Hat takes the caller's address from them (sign-in limits, the
  guest room's knock limits).
- Bodies up to the largest file people may send plus 5 MB (Features → "Biggest file people can send"), and at least
  12 MB (shared logs).
- A read timeout of a few minutes (chat keeps requests open while it waits for messages); no response buffering.
- Its own certificate for the domain (Let's Encrypt through the proxy is the usual way).

## A server name that is your bare domain
If your Matrix name is `example.com` (accounts like `@you:example.com`) but you'd rather serve Tin Hat from
`chat.example.com`, the proxy can send just `example.com/.well-known/matrix/*` and `example.com/_matrix/*` to Tin Hat
as well. Set the server up with the name `example.com` in that case (the name is permanent; changing it later is
"Move to your own domain").

## Known limits
- Port 8080 trusts every home-network address as a possible proxy, so a device on your own network could claim to
  be someone else for rate limits (not for anything more). A setting for your proxy's exact address is planned.
- "Move to your own domain" isn't offered for a server that shares its machine with the proxy (`--behind-proxy`) yet.
