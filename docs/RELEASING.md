# Releasing Tin Hat Server

Servers, install.sh and the download page all get releases from the project's **GitHub releases**, with a small
**mirror** as a fallback (`https://updates.tinhat.dev/server/`). Everything a server acts on is signed with the
release key (minisign, Ed25519), so neither GitHub nor the mirror has to be trusted: an unsigned or altered file is
refused, and the newest *signed* version among the sources wins.

## How servers find a release
- `updates_url` (environment.py) lists the sources in order:
  `https://github.com/TinHatLabs/TinHatServer/releases/latest/download/stable.json https://updates.tinhat.dev/server/stable.json`.
  `latest` is the newest release that isn't a prerelease. GitHub answers with two redirects (to the tag, then to a
  short-lived signed URL on release-assets.githubusercontent.com); servers and install.sh follow them.
- The manifest names our images by URLs pinned to the tag (`…/releases/download/vX.Y.Z/…`) and, since 0.3.2, the
  update bundle by its bare name, relative to wherever the server read the manifest: GitHub (the tag, or
  `releases/latest/download/`) or the mirror. The bundle's name carries its version and the manifest its sha256, so
  a release that lands mid-update can't swap a file under a server. A signature that fails because "latest" moved
  between the two requests is fetched once more.
- The mirror holds `stable.json`, its `.minisig`, `install.sh`, its `.minisig` and the bundle (~14 MB; its static
  host takes files up to 25 MiB, which release.sh checks). Why the bundle: servers before 0.3.2 couldn't read
  GitHub at all (GitHub's release downloads send a ~9.2 KB header, over aiohttp's default 8190), so they update from
  the mirror alone; a newer server reads both and prefers GitHub on a tie. If GitHub ever goes away: `release.sh
  VERSION` without `--github` writes a manifest with relative names for every file, and the mirror carries them all.
- Our images (tinhat/api, tinhat/caddy) come from GitHub only for a server that lacks one (by id). A release that
  doesn't change `api/` or `build/caddy` builds with `REUSE_IMAGES_FROM=out/github/vPREVIOUS` (and the same with
  `ARCH=arm64`): the VM loads that release's exact images (the API tagged with the new version), so servers download
  only the bundle — the only way a 0.3.0/0.3.1 server can take an update on a day GitHub's header is too big for it.
  provision.sh checks each reused image's id (from its file name) and processor; only reuse when `git diff
  vPREVIOUS -- api appliance/rootfs/opt/tinhat/build` is empty. Servers whose Docker names loaded images its own way
  (the containerd store: install.sh on Docker 29+) don't find the ids and still fetch the images from GitHub.
  When only one of them changed, `REUSE_IMAGES=caddy` (or `api`) reuses just that one and builds the other (0.3.3:
  a new API, Caddy as in 0.3.2).
- **A release with a new image stays off the mirror** (0.3.3 onwards, until no 0.3.0/0.3.1 server is left): the
  mirror keeps 0.3.2, the newest release such a server can install, so it steps to 0.3.2 there and reads GitHub from
  then on. A 0.3.2+ server reads both and takes the newer GitHub release; on a day GitHub can't be read it sees only
  0.3.2 there and waits. Don't use `--min-from` for this: a server that read that manifest would stop at "blocked"
  instead of taking 0.3.2 from the mirror.

## One-time setup
1. The repository (github.com/TinHatLabs/TinHatServer), and `gh auth login` on the machine that publishes.
2. The release key, made offline and kept off GitHub:
   `minisign -G -p tinhat-release.pub -s tinhat-release.key` (it asks for a password). Its public half goes into
   `appliance/rootfs/opt/tinhat/manager/tinhat/keys/` (servers trust every `*.pub` there; keep the development key
   out of release images) and onto the trust page. A paper copy of the key file + password in a safe place: a
   lost key means a new image for everyone.
3. `environment.py`'s `updates_url` names the two URLs above (release.sh warns when it doesn't match `--github`).
4. The mirror: a static folder at `https://updates.tinhat.dev/server/`, on a machine of our own.

## Each release
1. `build/bump.sh X.Y.Z` (the version is written in appliance/VERSION and in compose.yaml's tinhat/api images;
   build.sh refuses to start while they disagree). Build: `build/build.sh all` (and `ARCH=arm64 build/build.sh all`;
   with `REUSE_IMAGES_FROM=…` when our images didn't change, see above), the Windows installer
   (`windows/build-windows.sh`). Commit, tag `vX.Y.Z`, push the code and the tag.
2. `TINHAT_RELEASE_KEY=/path/tinhat-release.key build/release.sh X.Y.Z --github TinHatLabs/TinHatServer --prerelease --publish
   --note "What changed, in the owner's words"` (`--security` for a fix servers should install the next night,
   `--min-from V` when an older server must step through V first). The release is a prerelease: no server sees it.
   A key with a password is asked for once, on the terminal, and tried on the key before anything is built or
   uploaded (three tries); every signature then reuses it (it never appears on a command line). Run it where someone
   can type: a terminal, or `tmux new -s tinhat-release '…'` that the key's owner joins with
   `tmux attach -t tinhat-release`.
   `--publish` also refuses a download that carries a whole server (the VM images, the Compose image, the Windows
   installer) unless the record its build wrote next to it (`FILE.keys`: the file's sha256 and the update keys read
   from the image itself, by `build.sh export`/`compose`, `windows/build-rootfs.sh` and `build-windows.sh`) names
   exactly this file and exactly this release key. So: take the development key out of `keys/` **before** building.
   GitHub refuses a release file of 2 GiB or more, so `build.sh export` ships the amd64 disk for Hyper-V and
   VirtualBox/VMware zipped (`…-amd64.vhdx.zip`, `…-amd64.vmdk.zip`: one disk inside, read back against its sha256;
   each zip has its own `.sha256`, `.sealed` and `.keys`), and release.sh refuses any file of 1.8 GiB or more before
   it signs. Each download also goes into the release under its name without the version (`tinhat-server-amd64.qcow2`,
   `tinhat-server-arm64.qcow2`, `tinhat-server-amd64.vhdx.zip`, `tinhat-server-amd64.vmdk.zip`,
   `TinHatServer-Setup.exe`; the same file, listed in `SHA256SUMS` too): the site links
   `…/releases/latest/download/<that name>`, which only works once the release is GitHub's latest (step 4), never
   for a pre-release.
3. Try it: point a test server's `updates_url` at `https://github.com/TinHatLabs/TinHatServer/releases/download/vX.Y.Z/stable.json`,
   update from the dashboard, check the version and a call; or install a fresh one with that release's own
   `install.sh --channel …/vX.Y.Z/stable.json`. Only a server that already trusts this release key can take it as an
   update: boxes installed from the development channel trust only the development key and refuse it (by design);
   they need a fresh install. **Keep `out/github/vX.Y.Z/` exactly as signed** and never run release.sh for a published
   version again (it rebuilds and re-signs a different bundle under the same version). Nothing can be added to a
   published version without signing again: a late installer or image means re-signing `SHA256SUMS` (and checking
   its `.keys` record by hand); ARM updates can't be added at all (they change the signed manifest) — wait for every
   build before signing, or ship the late one with the next version.
4. Go live: `gh release edit vX.Y.Z --repo TinHatLabs/TinHatServer --prerelease=false --latest --notes-file
   out/github/vX.Y.Z.notes-latest.md` (release.sh writes both: the pre-release's notes install that exact version
   with `--channel`, the latest's use plain `install.sh`). The Compose workflow built `:X.Y.Z` once when the release
   was published; `latest` moves only by hand, after that image was tried: `gh workflow run compose-image.yml -f
   tag=vX.Y.Z -f action=promote -f digest=sha256:…` (it refuses unless vX.Y.Z is GitHub's latest release now and the
   version tag still is that digest). Then **copy** `stable.json`, `stable.json.minisig`, `install.sh`, `install.sh.minisig` and
   `tinhat-server-X.Y.Z.update.tar.gz` from `out/github/vX.Y.Z/` to the mirror (the site repo's `public/server/`;
   `release.sh … --mirror DIR` does it, keeping the newest three bundles): the very files GitHub has, never
   regenerated.
   Not before: the mirror's signed manifest counts for servers whatever GitHub's pre-release flag says. Not at all
   for a release with a new image while 0.3.0/0.3.1 servers may be out there (above).
5. The download page (tinhat.dev) follows: its version chips and "What's new" read the release; check the copy too.

## When a release is bad
- **The first release under a key** has no earlier version these servers trust to fall back to: mark it a pre-release
  again (`gh release edit vX.Y.Z --prerelease --latest=false`), take its four files off the mirror and its downloads
  off the site, move Compose's `latest` back (or off), then fix forward with a higher version.
- Servers that installed it and didn't come up healthy went back by themselves (the updater's safety copy).
- Stop the rest: `gh release edit vPREVIOUS --repo TinHatLabs/TinHatServer --latest` and put the previous `stable.json` +
  `.minisig` back on the mirror. Then fix forward with a higher version: servers never install an older one.
