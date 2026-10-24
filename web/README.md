# Tin Hat Web

The web app of [Tin Hat](https://tinhat.dev/): the same chat, voice and video app as the desktop, in a browser (phones
get their own layout). Every Tin Hat Server serves it to browsers at its own address, and each Tin Hat Server release
carries this source, built. `SOURCE` names the commit of the Tin Hat Web repository this folder was copied from; the
folder is refreshed from there for each release, so changes are made there rather than here.

Built with Vite, React and TypeScript, [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk) (with its Rust
crypto) and [livekit-client](https://github.com/livekit/client-sdk-js).

## Build it
You need Node.js 22.22 or newer (releases are built with 22.23) and pnpm 10 (built with 10.34).

```
cd web
pnpm install --frozen-lockfile
pnpm build
```

The app lands in `dist/`: static files only, with relative paths and hash routing, so they can be served from any
address. There is one build, the one every Tin Hat Server ships: the homeserver is the page's own origin, the Tin Hat
API is `/api` on that origin, and the features the server offers come from its `/.well-known/matrix/client` (the
`dev.tinhat.server` key; a feature is hidden only when the server says `false`).

`pnpm install` also applies `patches/livekit-client@2.22.3.patch` (listed under `patchedDependencies` in
`pnpm-workspace.yaml`): livekit-client's end-to-end encryption worker learns to decrypt the AV1 video frames that the
Tin Hat desktop app encrypts whole, so desktop screen shares in AV1 play in the browser.

A Tin Hat Server serves `dist/` without the source maps, with the guest call page (`api/guest/` in this repository) at
`/call/` and a `version.json` next to it (`build/build.sh` in this repository).

## Check it
- `pnpm typecheck`
- `bash tools/selfhost-bundle-check.sh`: builds the bundle into `tmp/selfhost-dist`; with the maintainers' deny list
  (`tools/selfhost-deny.sh`, not part of this copy) it fails on anything that list names, with no exceptions; without
  it, it only checks that the bundle exists.

The colour variables in `index.html` and `src/ui/tokens.css` (between the `GENERATED` markers) are written from
`src/theme/tokens.json` and the built-in themes by
`node --no-warnings --import ./tools/modular/register.mjs tools/modular/gen-theme-vars.mjs` (`--check` only compares).

The web app's unit tests and their shared test vectors aren't part of this copy yet.

## Licence
Licence: AGPL-3.0-or-later, as the rest of this repository (see ../LICENSE). Third-party code and data bundled into the
app, with their notices: `THIRD-PARTY.md`. The npm packages keep their own licences (`pnpm licenses list`).
