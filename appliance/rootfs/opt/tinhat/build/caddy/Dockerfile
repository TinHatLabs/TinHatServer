# Caddy 2.10.2 + DNS modules, built once into the appliance image by provision.sh (the box never builds or pulls at
# runtime). acmedns: from-anywhere mode (DNS-01 through the Tin Hat names service). cloudflare, porkbun, desec,
# duckdns: "my own domain" mode (DNS-01 through the owner's DNS provider, which also keeps the address current).
FROM caddy:2.10.2-builder AS build
RUN xcaddy build v2.10.2 \
    --with github.com/caddy-dns/acmedns@v0.7.0 \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --with github.com/caddy-dns/porkbun@v0.3.1 \
    --with github.com/caddy-dns/desec@v1.1.0 \
    --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2.10.2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
