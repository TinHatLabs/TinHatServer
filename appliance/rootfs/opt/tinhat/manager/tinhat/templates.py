"""Config files the manager writes at setup. Every value that matters comes from the wizard or secrets.json;
everything else is pinned to what the Tin Hat apps are tested against (compose.yaml: Synapse 1.145.0, LiveKit 1.13,
lk-jwt-service 0.4.0)."""
import base64
import json
import os
import re
import secrets
import string
from datetime import datetime, timezone

# ---- Synapse ------------------------------------------------------------------------------------------------

HOMESERVER_YAML = """\
# Tin Hat Server — Synapse config, written by the setup wizard on {date}.
# The dashboard owns this file; hand edits may be replaced by a later update.
server_name: "{server_name}"
public_baseurl: "https://{server_name}/"
pid_file: /data/homeserver.pid
report_stats: false
signing_key_path: /data/signing.key
log_config: /data/log.config
media_store_path: /data/media_store
max_upload_size: {upload_mb}M
# New rooms stay on version 10: their ids are random, so the server can move to a new name with its history
# ("Move to your own domain", move.py). Version 12 makes a room's id from its creator, which a move can't rename.
default_room_version: "10"

listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: true
    bind_addresses: ["0.0.0.0"]
    resources:
      # client = the apps; openid = the one federation endpoint calls need (lk-jwt checks who you are);
      # federation only in from-anywhere mode, and then only with the servers in the allowlist below.
      - names: [{listener_names}]
        compress: true

database:
  name: psycopg2
  args:
    user: synapse
    password: "{postgres_password}"
    dbname: synapse
    host: postgres
    cp_min: 5
    cp_max: 10

registration_shared_secret: "{registration_shared_secret}"
macaroon_secret_key: "{macaroon_secret_key}"
form_secret: "{form_secret}"

# Accounts: invite codes only (Synapse registration tokens).
enable_registration: true
registration_requires_token: true
enable_registration_without_verification: false
password_config:
  enabled: true
  policy:
    enabled: true
    minimum_length: 8

# A small private server. It talks only to the Tin Hat servers its owner connected in the dashboard (connection
# codes, both owners agree); an empty list means no other server at all. No public room directory outside it.
federation_domain_whitelist: {federation_whitelist}
trusted_key_servers: []
{extra_ca}suppress_key_server_warning: true
allow_public_rooms_over_federation: false
allow_public_rooms_without_auth: false

# Tin Hat keeps its own presence; Synapse's would only cost CPU.
presence:
  enabled: false

# People on the server can find each other by name.
user_directory:
  enabled: true
  search_all_users: {search_all}

# Guests (the guest room's temporary accounts) stay in the Guests room; only the Tin Hat API registers guest names.
modules:
  - module: tinhat_rules.GuestRules
    config:
      dir: /tinhat-api

# New people land in the server's first room: the manager joins them (newcomers.py), not Synapse's auto_join_rooms,
# which would join the guest room's temporary accounts to #general too.

# The MatrixRTC calls and Tin Hat's features need these (what the apps are tested against).
experimental_features:
  msc3266_enabled: true
  msc4222_enabled: true
  msc4140_enabled: true
  msc4196_enabled: true

# Tin Hat's Media Party writes state every few seconds: Synapse's default 0.2/s starves it.
rc_message:
  per_second: 2
  burst_count: 50
rc_room_creation:
  per_second: 1
  burst_count: 30

# Link previews: the server fetches the page, apps never touch the third-party site. Private ranges are never
# fetched. Chosen in the setup wizard.
url_preview_enabled: {previews}
{push_gateway}url_preview_ip_range_blacklist:
  - "127.0.0.0/8"
  - "10.0.0.0/8"
  - "172.16.0.0/12"
  - "192.168.0.0/16"
  - "100.64.0.0/10"
  - "192.0.0.0/24"
  - "169.254.0.0/16"
  - "192.88.99.0/24"
  - "198.18.0.0/15"
  - "192.0.2.0/24"
  - "198.51.100.0/24"
  - "203.0.113.0/24"
  - "224.0.0.0/4"
  - "::1/128"
  - "fe80::/10"
  - "fc00::/7"
  - "2001:db8::/32"
  - "ff00::/8"
  - "fec0::/10"
url_preview_accept_language:
  - en-US
  - en
"""

LOG_CONFIG = """\
version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse.storage.SQL:
    level: WARNING
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
"""


def homeserver_yaml(server_name: str, s: dict, features: dict | None = None, federation: list[str] | None = None,
                    extra_ca: list[str] | None = None, push_gateway: str = "") -> str:
    """federation=None: home-network mode (no federation listener at all); a list: from-anywhere mode, federating
    only with those servers. extra_ca: the lab's roots (Pebble + lab CA), one file each, for federation."""
    f = features or {}
    # Synapse refuses private addresses for pushers (and federation, identity servers); the Tin Hat API's push
    # gateway listens on the box's own address on the compose network (apiconf.py), the one exception.
    gw = (f"# Web push: the Tin Hat API's gateway on this box (the only private address Synapse may talk to).\n"
          f"ip_range_whitelist:\n  - \"{push_gateway}/32\"\n") if push_gateway else ""
    names = ["client", "openid"] + (["federation"] if federation is not None else [])
    return HOMESERVER_YAML.format(
        upload_mb=int(f.get("uploadMb", 100)),
        search_all="true" if f.get("directory", True) else "false",
        previews="true" if f.get("previews", False) else "false",
        push_gateway=gw,
        date=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        server_name=server_name,
        postgres_password=s["postgres_password"],
        registration_shared_secret=s["registration_shared_secret"],
        macaroon_secret_key=s["macaroon_secret_key"],
        form_secret=s["form_secret"],
        listener_names=", ".join(names),
        federation_whitelist=json.dumps(sorted(set(federation or []))),
        extra_ca=f"federation_custom_ca_list: {json.dumps(extra_ca)}\n" if extra_ca else "",
    )


def signing_key() -> str:
    """Synapse's signing key file: `ed25519 <key id> <unpadded base64 of a 32-byte seed>`."""
    key_id = "a_" + "".join(secrets.choice(string.ascii_letters) for _ in range(4))
    seed = base64.b64encode(os.urandom(32)).decode().rstrip("=")
    return f"ed25519 {key_id} {seed}\n"


# ---- Caddy --------------------------------------------------------------------------------------------------
# Caddy's admin API listens on a socket in its own config folder (root-only on the host), never on 127.0.0.1:2019: on
# someone's own machine any local program could reach a TCP port, and Tin Hat Server for Windows mirrors loopback to
# the whole PC. Only `caddy reload` inside the container (compose.caddy_reload) talks to it.

CADDY_SETUP = """\
# Tin Hat Server — not set up yet: everything on port 80 goes to the setup wizard.
{
	admin unix//config/caddy-admin.sock
	auto_https off
}

:80 {
	header -Server
	reverse_proxy 127.0.0.1:8090
}
"""

# Before setup on a machine where another web server has 80 and 443 (install.sh --behind-proxy): the setup wizard on
# port 8080 instead.
CADDY_SETUP_PROXY_ONLY = """\
# Tin Hat Server — not set up yet: port 8080 goes to the setup wizard (ports 80 and 443 belong to this machine's own
# web server).
{
	admin unix//config/caddy-admin.sock
	auto_https off
}

:8080 {
	header -Server
	reverse_proxy 127.0.0.1:8090
}
"""

# One origin serves the web app, the homeserver, calls and the dashboard (the Tin Hat Web self-host build
# requires that: its homeserver is its own origin). Port 80 stays plain HTTP on purpose in home-network mode:
# it is where a new device downloads the server's certificate before it can trust https.
CADDY_LAN = """\
# Tin Hat Server — home-network mode for {server_name}, written by the setup wizard on {date}.
{{
	admin unix//config/caddy-admin.sock
	auto_https disable_redirects
	skip_install_trust
	pki {{
		ca local {{
			name "Tin Hat server {server_name}"
			root_cn "Tin Hat server {server_name}"
			intermediate_cn "Tin Hat server {server_name} (intermediate)"
		}}
	}}
}}

(tinhat_headers) {{
	header {{
		-Server
		Referrer-Policy no-referrer
		X-Content-Type-Options nosniff
	}}
}}

https://{server_name} {{
	tls internal
	encode zstd gzip
	import tinhat_headers

	handle /.well-known/matrix/* {{
		root * /srv/wk
		header Access-Control-Allow-Origin *
		header Content-Type application/json
		header Cache-Control "no-cache"
		file_server
	}}
	handle /_matrix/* {{
		reverse_proxy 127.0.0.1:8008
	}}
	handle /_synapse/client/* {{
		reverse_proxy 127.0.0.1:8008
	}}
	# Older Element Call versions post the sign-in to the focus URL itself (no /sfu/get after it).
	handle /livekit/jwt {{
		rewrite * /sfu/get
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/jwt/* {{
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/sfu* {{
		reverse_proxy 127.0.0.1:7880
	}}
	@admin path /admin /admin/*
	handle @admin {{
		reverse_proxy 127.0.0.1:8090
	}}
	# The Tin Hat API (/api, as on the Tin Hat hub). Only invite codes live on the box so far.
{api_routes}	handle {{
		root * /srv/web
		@immutable path /assets/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@fresh path / /index.html /sw.js /push-sw.js /version.json /manifest.webmanifest /call/ /call/*
		header @fresh Cache-Control "no-cache"
		try_files {{path}} {{path}}index.html /index.html
		file_server
	}}
}}

:80 {{
	import tinhat_headers
	handle /_matrix/* {{
		redir https://{server_name}{{uri}} 308
	}}
	handle {{
		reverse_proxy 127.0.0.1:8090
	}}
}}
"""


# From-anywhere mode: a real certificate from Let's Encrypt (Pebble in the lab) through DNS-01, which the Tin Hat names
# service answers for this box only (acme-dns protocol; Caddy's stock `acmedns` module). Nothing needs port 80 open
# on the router, and the certificate works before the ports are. HTTP/3 stays off: UDP 443 isn't forwarded.
CADDY_ANYWHERE = """\
# Tin Hat Server — from-anywhere mode for {server_name}, written by the setup wizard on {date}.
{{
	admin unix//config/caddy-admin.sock
	acme_ca {acme_directory}
{acme_ca_root}{relay_servers}	servers {{
		protocols h1 h2
	}}
}}

(tinhat_headers) {{
	header {{
		-Server
		Referrer-Policy no-referrer
		X-Content-Type-Options nosniff
	}}
}}

https://{server_name} {{
	tls {{
{tls_dns}		propagation_timeout 3m
	}}
	encode zstd gzip
	import tinhat_headers
	header Strict-Transport-Security "max-age=31536000"

	handle /.well-known/tinhat/* {{
		reverse_proxy 127.0.0.1:8090
	}}
	# Connections between Tin Hat servers (federation by consent): the request / confirm handshake.
	handle /_tinhat/* {{
		reverse_proxy 127.0.0.1:8090
	}}
	handle /.well-known/matrix/* {{
		root * /srv/wk
		header Access-Control-Allow-Origin *
		header Content-Type application/json
		header Cache-Control "no-cache"
		file_server
	}}
	handle /_matrix/* {{
		reverse_proxy 127.0.0.1:8008
	}}
	handle /_synapse/client/* {{
		reverse_proxy 127.0.0.1:8008
	}}
	# Older Element Call versions post the sign-in to the focus URL itself (no /sfu/get after it).
	handle /livekit/jwt {{
		rewrite * /sfu/get
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/jwt/* {{
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/sfu* {{
		reverse_proxy 127.0.0.1:7880
	}}
	@admin path /admin /admin/*
	handle @admin {{
		reverse_proxy 127.0.0.1:8090
	}}
{api_routes}	handle {{
		root * /srv/web
		@immutable path /assets/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@fresh path / /index.html /sw.js /push-sw.js /version.json /manifest.webmanifest /call/ /call/*
		header @fresh Cache-Control "no-cache"
		try_files {{path}} {{path}}index.html /index.html
		file_server
	}}
}}

# Port 80 sends people to https: someone who types just the server's name into a browser that starts with http://
# (the router sends port 80 here when it can), or the server's address on the home network. The one exception: the
# browser that did the setup, on the home network over http, keeps asking the setup how it's going while the web
# server switches to these settings, and checks from outside from its last page (/admin/setup/*, which needs that
# setup session and closes a few hours after setup). Nothing else on port 80 reaches the manager.
:80 {{
	import tinhat_headers
	@setup {{
		remote_ip private_ranges
		path /admin/setup/*
	}}
	handle @setup {{
		reverse_proxy 127.0.0.1:8090
	}}
	handle {{
		redir https://{server_name}{{uri}} 308
	}}
}}
"""


# Behind the owner's own reverse proxy: their proxy has 443 and the certificate for the domain, and sends everything to
# this box's port {port} over the home network (only home-network addresses may connect there: the box may have a
# public IPv6 address). The box still answers its own name on its loopback addresses with a certificate of its own CA,
# for its own services (lk-jwt checks sign-ins through https://<name>, which resolves to 127.0.1.1 here) and the
# updater's health check. Calls (TCP 7881, UDP 7882) never go through the proxy.
CADDY_PROXY = """\
# Tin Hat Server — behind your own reverse proxy, for {server_name}, written by the setup wizard on {date}.
{{
	admin unix//config/caddy-admin.sock
	auto_https disable_redirects
	skip_install_trust
	servers {{
		protocols h1 h2
		# Your proxy: on the home network, or on this same machine. Strict: the caller is the first address from the
		# right that isn't one of these, so nothing a browser writes into X-Forwarded-For itself counts.
		trusted_proxies static private_ranges{own_ips}
		trusted_proxies_strict
	}}
	pki {{
		ca local {{
			name "Tin Hat server {server_name} (internal)"
			root_cn "Tin Hat server {server_name} (internal)"
			intermediate_cn "Tin Hat server {server_name} (internal, intermediate)"
		}}
	}}
}}

(tinhat_headers) {{
	header {{
		-Server
		Referrer-Policy no-referrer
		X-Content-Type-Options nosniff
	}}
}}

(tinhat_routes) {{
	handle /.well-known/tinhat/* {{
		reverse_proxy 127.0.0.1:8090 {{
			header_up X-Forwarded-For {{client_ip}}
		}}
	}}
	handle /_tinhat/* {{
		reverse_proxy 127.0.0.1:8090 {{
			header_up X-Forwarded-For {{client_ip}}
		}}
	}}
	handle /.well-known/matrix/* {{
		root * /srv/wk
		header Access-Control-Allow-Origin *
		header Content-Type application/json
		header Cache-Control "no-cache"
		file_server
	}}
	# Synapse reads the first address in X-Forwarded-For: give it (and the manager) only the caller, as worked out
	# above, so both count the same address.
	handle /_matrix/* {{
		reverse_proxy 127.0.0.1:8008 {{
			header_up X-Forwarded-For {{client_ip}}
		}}
	}}
	handle /_synapse/client/* {{
		reverse_proxy 127.0.0.1:8008 {{
			header_up X-Forwarded-For {{client_ip}}
		}}
	}}
	# Older Element Call versions post the sign-in to the focus URL itself (no /sfu/get after it).
	handle /livekit/jwt {{
		rewrite * /sfu/get
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/jwt/* {{
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/sfu* {{
		reverse_proxy 127.0.0.1:7880
	}}
	@admin path /admin /admin/*
	handle @admin {{
		reverse_proxy 127.0.0.1:8090 {{
			header_up X-Forwarded-For {{client_ip}}
		}}
	}}
{api_routes}	handle {{
		root * /srv/web
		@immutable path /assets/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@fresh path / /index.html /sw.js /push-sw.js /version.json /manifest.webmanifest /call/ /call/*
		header @fresh Cache-Control "no-cache"
		try_files {{path}} {{path}}index.html /index.html
		file_server
	}}
}}

# Your reverse proxy sends https://{server_name} here.
http://:{port} {{
	encode zstd gzip
	import tinhat_headers
	@home remote_ip private_ranges{own_ips}
	handle @home {{
		# A move to a new address behind your proxy (move.py): its one-off check answers on this port only, from a
		# file the web server serves itself (only while the check runs; never cached).
		handle /_tinhat/move-check {{
			header Cache-Control no-store
			root * /srv/wk/move-check
			rewrite * /{{http.request.host}}
			file_server
		}}
		import tinhat_routes
	}}
	handle {{
		respond "Only your reverse proxy connects here." 403
	}}
}}

{own_sites}"""

# The box's own HTTPS for its own services, and the home network's welcome page; left out when another web server on
# the machine has ports 80 and 443 (then the box reaches its own name through that proxy).
CADDY_PROXY_OWN_SITES = """
# This box's own services reach https://{server_name} here.
https://{server_name} {{
	bind 127.0.0.1 127.0.1.1 127.0.1.2
	tls internal
	import tinhat_headers
	import tinhat_routes
}}

# Port 80 is for the home network: the welcome page.
:80 {{
	import tinhat_headers
	handle /_matrix/* {{
		redir https://{server_name}{{uri}} 308
	}}
	handle {{
		reverse_proxy 127.0.0.1:8090
	}}
}}
"""


def caddy_proxy(server_name: str, port: int, shared: bool = False) -> str:
    """shared: another web server on this machine has ports 80 and 443 (config.proxy_only)."""
    own = "" if shared else CADDY_PROXY_OWN_SITES.format(server_name=server_name)
    # A proxy on this same machine connects from the machine's own addresses: on a rented server that's a public one.
    from . import hw
    own_ips = "".join(f" {a}/32" for a in hw.addresses() if ":" not in a)
    return CADDY_PROXY.format(server_name=server_name, port=port, own_sites=own, own_ips=own_ips, api_routes=CADDY_API,
                              date=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))


# Through the Tin Hat relay (relay.py): HTTPS arrives from the relay's tunnel address with a PROXY v2 header carrying the
# friend's real address. Only that one address may send the header; everyone else (home devices, connecting directly)
# is never asked for one.
CADDY_RELAY_SERVERS = """\tservers :443 {{
\t\tlistener_wrappers {{
\t\t\tproxy_protocol {{
\t\t\t\ttimeout 5s
\t\t\t\tallow {proxy_from}/32
\t\t\t\tfallback_policy skip
\t\t\t}}
\t\t\ttls
\t\t}}
\t\tprotocols h1 h2
\t}}
"""


_ACME_WORD = re.compile(r"[A-Za-z0-9._~+/=-]{1,200}")
_HOSTNAME = re.compile(r"(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}")
_ACME_URL = re.compile(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?")


def acmedns_tls(acme: dict) -> str:
    """The `tls` block's DNS lines for a tinhat.me name: DNS-01 through the Tin Hat names service (acme-dns style).
    The names service's values go into the Caddyfile as bare words: only what they're made of (ids, the name, an
    https URL), nothing that means something to Caddy."""
    if not (_ACME_URL.fullmatch(str(acme.get("server_url", ""))) and
            all(_ACME_WORD.fullmatch(str(acme.get(k, ""))) for k in ("username", "password", "subdomain"))):
        raise ValueError("the names service's certificate settings have characters the Caddyfile can't take")
    return (f"\t\tdns acmedns {{\n\t\t\tusername {acme['username']}\n\t\t\tpassword {acme['password']}\n"
            f"\t\t\tsubdomain {acme['subdomain']}\n\t\t\tserver_url {acme['server_url']}\n\t\t}}\n")


def caddy_anywhere(server_name: str, acme: dict, acme_directory: str, extra_roots: bool,
                   proxy_from: str | None = None) -> str:
    """A tinhat.me name. proxy_from: the relay's tunnel address, when friends come through the Tin Hat relay."""
    return _caddy_public(server_name, acmedns_tls(acme), acme_directory, extra_roots, proxy_from)


# ---- former names (move.py: "Move to your own domain") -----------------------------------------------------------
# A server that moved keeps answering its old name while it lasts: apps that still use it reach the same chat server,
# its .well-known says where the server went (files written by refresh_configs under /srv/wk/former/<name>), browsers
# are sent to the new address, and the dashboard still opens there. Media of the old name (mxc://OLD/…, also inside
# encrypted messages, which nobody but the members' devices can rewrite) is this server's, under every name.
CADDY_FORMER_SITE = """
# Former name {old}: this server moved to {new}.
https://{old} {{
{tls}	encode zstd gzip
	import tinhat_headers
{media}	handle /.well-known/matrix/* {{
		root * /srv/wk/former/{old}
		header Access-Control-Allow-Origin *
		header Content-Type application/json
		header Cache-Control "no-cache"
		file_server
	}}
	handle /_matrix/* {{
		reverse_proxy 127.0.0.1:8008
	}}
	handle /_synapse/client/* {{
		reverse_proxy 127.0.0.1:8008
	}}
	# Older Element Call versions post the sign-in to the focus URL itself (no /sfu/get after it).
	handle /livekit/jwt {{
		rewrite * /sfu/get
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/jwt/* {{
		reverse_proxy 127.0.0.1:8070
	}}
	handle_path /livekit/sfu* {{
		reverse_proxy 127.0.0.1:7880
	}}
	@admin path /admin /admin/*
	handle @admin {{
		reverse_proxy 127.0.0.1:8090
	}}
	handle {{
		redir https://{new}{{uri}} 302
	}}
}}
"""


CADDY_PREFLIGHT_SITE = """
# Moving here (move.py): the new address's certificate comes before anything moves; this site goes with the switch.
https://{name} {{
	tls {{
		issuer acme {{
			dir {acme_directory}
{trusted}{tls_dns}			propagation_timeout 3m
		}}
	}}
	respond "This Tin Hat server is moving here. Try again in a minute." 503
}}
"""


# Moving behind the owner's reverse proxy (move.py): the proxy holds the new address's certificate, so before anything
# moves the server checks that https://NEW leads here. A server that isn't behind a proxy yet gets the proxy's port for
# that check only (home-network addresses, as the real one); the switch writes the real site.
CADDY_PROXY_PREFLIGHT_SITE = """
# Moving behind your reverse proxy (move.py): it should send the new address here; this site goes with the switch.
http://:{port} {{
	@home remote_ip private_ranges{own_ips}
	handle @home {{
		# A move to a new address behind your proxy (move.py): its one-off check answers on this port only, from a
		# file the web server serves itself (only while the check runs; never cached).
		handle /_tinhat/move-check {{
			header Cache-Control no-store
			root * /srv/wk/move-check
			rewrite * /{{http.request.host}}
			file_server
		}}
		handle {{
			respond "This Tin Hat server is moving here. Try again in a minute." 503
		}}
	}}
	handle {{
		respond "Only your reverse proxy connects here." 403
	}}
}}
"""


def caddy_proxy_preflight(port: int, addresses: list[str]) -> str:
    """addresses: this machine's own (hw.addresses()): a proxy on this same machine connects from one of them."""
    own_ips = "".join(f" {a}/32" for a in addresses if ":" not in a and re.fullmatch(r"[0-9.]+", a))
    return CADDY_PROXY_PREFLIGHT_SITE.format(port=int(port), own_ips=own_ips)


def is_hostname(name: str) -> bool:
    return bool(_HOSTNAME.fullmatch(name or ""))


def caddy_preflight(name: str, tls_dns: str, acme_directory: str, extra_roots: bool) -> str:
    """A site for the move's new name that only gets its certificate (DNS-01 through the owner's provider: tls_dns from
    owndomain.caddy_tls) and says "moving here", added to whatever Caddyfile the server runs before the move."""
    if not _HOSTNAME.fullmatch(name) or not re.fullmatch(r"https://[A-Za-z0-9.:/_-]+", acme_directory):
        raise ValueError("not a name or an ACME directory the Caddyfile can take")
    return CADDY_PREFLIGHT_SITE.format(name=name, acme_directory=acme_directory, tls_dns=tls_dns,
                                       trusted="\t\t\ttrusted_roots /etc/tinhat-ca/extra-roots.pem\n" if extra_roots else "")


def former_media(new: str, former: list[str]) -> str:
    """Rewrite rules for a site block: media requests for a former name go to this server's own media."""
    out = ""
    for i, old in enumerate(former):
        if not _HOSTNAME.fullmatch(old):
            continue
        tag = f"former{i}"
        rx = old.replace(".", "\\.")
        out += (f"\t# media of the former name {old} (also inside encrypted messages) is this server's\n"
                f"\t@{tag} path_regexp {tag} ^/_matrix/(client/v1/media|media/v3|media/r0)/(download|thumbnail)/{rx}/(.*)$\n"
                f"\trewrite @{tag} /_matrix/{{re.{tag}.1}}/{{re.{tag}.2}}/{new}/{{re.{tag}.3}}\n")
    return out


def with_former_names(caddyfile: str, new: str, former: list[tuple[str, str | None]]) -> str:
    """The Caddyfile with the former names: [(name, tls)] where tls is "internal" (a .local name, the server's own CA),
    the DNS lines of a `tls` block (a tinhat.me name, an own domain), or None (media only: the old name doesn't come
    here any more, e.g. behind the owner's reverse proxy)."""
    names = [n for n, _ in former if _HOSTNAME.fullmatch(n) and n != new]
    if not names:
        return caddyfile
    media = former_media(new, names)
    out = caddyfile.replace("\timport tinhat_headers\n", "\timport tinhat_headers\n" + media)
    for old, tls in former:
        if old not in names or tls is None:
            continue
        tls_block = "\ttls internal\n" if tls == "internal" else f"\ttls {{\n{tls}\t\tpropagation_timeout 3m\n\t}}\n"
        out += CADDY_FORMER_SITE.format(old=old, new=new, tls=tls_block, media=media)
    return out


def wellknown_former_client(new: str, calls: bool, version: str, features: dict | None = None, recorder: str = "") -> str:
    """The former name's .well-known/matrix/client: the new address (apps that discover through the old name go
    there), and dev.tinhat.moved_to so Tin Hat can say the server moved."""
    doc = json.loads(wellknown_client(new, calls, version, features=features, recorder=recorder))
    doc["dev.tinhat.moved_to"] = new
    return json.dumps(doc, indent=1) + "\n"


def caddy_domain(server_name: str, tls_dns: str, acme_directory: str, extra_roots: bool) -> str:
    """The owner's own domain: DNS-01 through their DNS provider (owndomain.caddy_tls)."""
    return _caddy_public(server_name, tls_dns, acme_directory, extra_roots)


def _caddy_public(server_name: str, tls_dns: str, acme_directory: str, extra_roots: bool,
                  proxy_from: str | None = None) -> str:
    return CADDY_ANYWHERE.format(
        api_routes=CADDY_API,
        relay_servers=CADDY_RELAY_SERVERS.format(proxy_from=proxy_from) if proxy_from else "",
        server_name=server_name, date=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        acme_directory=acme_directory, tls_dns=tls_dns,
        acme_ca_root="\tacme_ca_root /etc/tinhat-ca/extra-roots.pem\n" if extra_roots else "")


def caddy_lan(server_name: str) -> str:
    return CADDY_LAN.format(server_name=server_name, date=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                            api_routes=CADDY_API)


# ---- the Tin Hat API ------------------------------------------------------------------------------------------

# The Tin Hat API on this server (api/ in the repository; apiconf.py): the service on 127.0.0.1:3001 and the games
# catalogue on :3003. Invite codes (/api/admin/*) stay with the manager (its /tinhat-api/admin/*). Caddy sorts these by
# path, longest first. Every route hands over the caller's address as Caddy worked it out (behind the owner's proxy:
# the real client, not the proxy), so the API's per-address limits count people, not the proxy.
CADDY_API = """\
	handle_path /api/admin/* {
		rewrite * /tinhat-api/admin{uri}
		reverse_proxy 127.0.0.1:8090 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/games/* {
		reverse_proxy 127.0.0.1:3003 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/soundboard/* {
		request_body {
			max_size 4MB
		}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/guest/* {
		rewrite * /guest{uri}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/gifs/* {
		rewrite * /gif{uri}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/watch/* {
		rewrite * /youtube{uri}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/logs/* {
		request_body {
			max_size 12MB
		}
		rewrite * /logs{uri}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/speedtest/* {
		request_body {
			max_size 12MB
		}
		rewrite * /speedtest{uri}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/reports/* {
		request_body {
			max_size 1MB
		}
		rewrite * /reports{uri}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
	handle_path /api/* {
		request_body {
			max_size 1MB
		}
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-For {client_ip}
		}
	}
"""


# ---- LiveKit ------------------------------------------------------------------------------------------------

LIVEKIT_YAML = """\
# Tin Hat Server — LiveKit (calls), written by the setup wizard on {date}.
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: {tcp_port}
  # One UDP port for every call (instead of a range): two ports to forward instead of thousands.
  udp_port: {udp_port}
  use_external_ip: {use_external_ip}
  # Docker's own networks live in 198.18.0.0/15 on this box (/etc/docker/daemon.json), plus whatever ranges an
  # existing Docker uses on the owner's own machine: never offer them to callers.
  ips:
    excludes: {excludes}
{turn_servers}{node_ip}turn:
  enabled: false
keys:
  {key}: {secret}
room:
  auto_create: true
  empty_timeout: 300
  max_participants: 100
  enabled_codecs:
    - mime: audio/opus
    - mime: video/vp8
    - mime: video/vp9
    - mime: video/h264
    - mime: video/av1
logging:
  level: info
  sample: false
"""


def livekit_yaml(s: dict, use_external_ip: bool = False, public_ip: str | None = None, tcp_port: int = 7881,
                 udp_port: int = 7882) -> str:
    """public_ip (from anywhere): callers outside the home get the home's public address, and callers at home still
    get the server's own address (advertise_internal_ip, LiveKit 1.13+), so calls work even on routers that can't
    loop traffic back in. Home-network mode leaves both out."""
    node = f"  node_ip: {public_ip}\n  advertise_internal_ip: true\n" if public_ip else ""
    return LIVEKIT_YAML.format(
        turn_servers=_turn_servers(s),
        date=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        key=s["livekit_key"],
        secret=s["livekit_secret"],
        use_external_ip="true" if use_external_ip else "false",
        node_ip=node,
        tcp_port=int(tcp_port),
        udp_port=int(udp_port),
        excludes=json.dumps(["198.18.0.0/15"] + [n for n in _docker_subnets() if n != "198.18.0.0/15"]),
    )


def _turn_servers(s: dict) -> str:
    """The owner's TURN server (state `api.turn`, credential in secrets): LiveKit hands it to callers whose network
    blocks UDP. Empty when none is set."""
    from . import apiconf
    t = apiconf.settings().get("turn")
    cred = s.get("turn_credential") or ""
    if not t or not cred:
        return ""
    return (f"  # The owner's TURN server (dashboard → Features), for callers whose network blocks UDP.\n"
            f"  turn_servers:\n    - host: {t['host']}\n      port: {int(t['port'])}\n      protocol: {t['protocol']}\n"
            f"      username: {json.dumps(str(t['username']))}\n      credential: {json.dumps(cred)}\n")


def _docker_subnets() -> list[str]:
    from . import config, hw
    return hw.docker_subnets() if config.own_machine() else []


# ---- discovery + compose ------------------------------------------------------------------------------------

def wellknown_client(server_name: str, calls: bool = True, version: str = "", moved_from: list[str] | None = None,
                     features: dict | None = None, recorder: str = "") -> str:
    """moved_from: the names this server had before it moved to its own domain (move.py), so the apps can say where
    an account came from (dev.tinhat.moved_from). features: apiconf.features() — what this server offers beyond chat,
    so the apps show exactly what works here (only an explicit false hides a feature); recorder: the Memories
    recorder's account, while Memories is on."""
    feats = dict(features) if features else {"calls": bool(calls)}
    feats["calls"] = bool(calls)
    offer = {"server": version or "dev", "api": f"https://{server_name}/api", "features": feats,
             # no email here: a forgotten password is the owner's to reset (dashboard → People), and the apps say so
             "account": {"password_reset": "owner"}}
    if feats.get("memories") and recorder:
        offer["recorder"] = recorder
    doc = {"m.homeserver": {"base_url": f"https://{server_name}"},
           # Marks a Tin Hat server (the names service's weekly check looks for it); the apps find the Tin Hat API,
           # the features and the recorder here.
           "dev.tinhat.server": offer}
    if calls:  # the apps only offer calls when the server announces a call service
        doc["org.matrix.msc4143.rtc_foci"] = [{"type": "livekit", "livekit_service_url": f"https://{server_name}/livekit/jwt"}]
    if moved_from:
        doc["dev.tinhat.moved_from"] = list(moved_from)
    return json.dumps(doc) + "\n"


def wellknown_server(server_name: str) -> str:
    # lk-jwt-service checks a caller's OpenID token through the federation discovery of the server name.
    return json.dumps({"m.server": f"{server_name}:443"}) + "\n"


def _self_ip() -> str:
    from . import config, hw
    if not config.own_machine():
        return config.SELF_IP_APPLIANCE
    if config.proxy_only():  # the machine's own web server has 443: the name leads to it, at the machine's address
        return (hw.addresses() or [config.SELF_IP_OWN])[0]
    return config.SELF_IP_OWN


def compose_env(server_name: str, s: dict, lan: bool, bundle: bool = False) -> str:
    lines = {
        "TINHAT_SERVER_NAME": server_name,
        "POSTGRES_PASSWORD": s["postgres_password"],
        "LIVEKIT_KEY": s["livekit_key"],
        "LIVEKIT_SECRET": s["livekit_secret"],
        # lk-jwt reaches this box through its own Caddy. Home-network mode: the box's own CA is all it needs.
        # From anywhere: the system's roots (Let's Encrypt), plus the lab's roots in the lab (one combined file).
        "JWT_CA_FILE": "/etc/tinhat-ca/root.crt" if lan else ("/etc/tinhat-ca/bundle.pem" if bundle else ""),
        # Caddy's DNS-01 calls to the names service: system roots, plus the lab's in the lab.
        "CADDY_CA_FILE": "/etc/tinhat-ca/bundle.pem" if bundle else "",
        # Where this machine answers its own name (lk-jwt's extra_hosts; the same address /etc/hosts gives it).
        "TINHAT_SELF_IP": _self_ip(),
    }
    return "".join(f"{k}={v}\n" for k, v in lines.items())
