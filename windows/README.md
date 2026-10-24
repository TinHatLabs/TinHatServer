# Tin Hat Server for Windows

The Tin Hat Server appliance, running quietly in the background on someone's own Windows PC through **WSL 2**, with a
normal installer (`TinHatServer-Setup-<ver>.exe`) and a tray icon. Built and tested on a Windows 11 machine on
2026-10-18 (Windows 11 25H2 build 26200, WSL 3.0.3, appliance 0.2.7). The user-facing guide is the "Tin Hat Server for
Windows" page of the Tin Hat site.

## What's here

| Path | What |
|---|---|
| `build-rootfs.sh` | sealed image (`out/tinhat-server-<ver>-amd64.qcow2`) → `out/windows/tinhat-server-<ver>-wsl.tar.gz`, a rootfs `wsl --import` takes. Read-only towards the image |
| `rootfs-overlay/` | the only files added to the image for WSL (WSL config, unit drop-ins, the first-start step, the `hold`/`ctl` helpers). Listed in `rootfs-overlay/usr/local/lib/tinhat-wsl/README` |
| `tray/` | `TinHatServer.exe` (Rust + `windows-sys`, ~500 KB): tray icon, background keep-alive (`--serve`), command-line modes |
| `installer/TinHatServer.iss` | Inno Setup 6.6+ script: pages, checks, restart-and-resume, uninstall |
| `installer/setup-helper.ps1` | the installer's work, one action per call (checks, WSL install, import, `.wslconfig` merge, firewall, task, uninstall) |
| `build-windows.sh` + `build.ps1` | Linux side + Windows side of building the installer on a Windows build machine |
| `tools/make-icons.py` | the `.ico` files, drawn from the Tin Hat app icon's polygons (no image libraries needed) |

Build outputs go to `out/windows/` (outside `windows/`, so multi-GB files never end up in git).

## Build

On the Linux build host:

```
windows/build-rootfs.sh                      # newest out/tinhat-server-*-amd64.qcow2 → out/windows/…-wsl.tar.gz (~1 min)
                                             # start the Windows build machine: `ssh buildwin` must answer
windows/build-windows.sh                     # newest rootfs → out/windows/TinHatServer-Setup-<ver>.exe (+ .sha256), ~1.5 min
ssh buildwin shutdown /s /t 0                # done: shut the build machine down again
```

- `build-rootfs.sh IMAGE` picks a specific image. It checks the image's `.sha256`, converts it to a sparse raw copy in
  `out/windows/.work-*`, attaches it read-only (`losetup -r`), mounts the root partition read-only with `noload` (and
  refuses an unclean filesystem), tars it with numeric owners and xattrs (no `/proc /sys /dev /run /boot`, no kernel
  modules, no VM fstab or resolv.conf), appends `rootfs-overlay/` and refuses any overlay file that would shadow an
  image file unless it is listed in `REPLACED` (only `etc/fstab`). Then it unmounts, detaches and deletes the copy.
- `build-windows.sh VERSION` stages the sources (version stamped into `Cargo.toml`/`Cargo.lock`, UTF-8 BOMs added for
  Inno and PowerShell 5.1, icons drawn) to the build machine's `C:\th-build\stage-<ver>`, runs `build.ps1` there
  (`cargo build --release --locked`, then `ISCC`) and copies the installer back.
- The build machine needs: Rust (MSVC), VS 2022 Build Tools, Inno Setup 6.6 or newer (user scope),
  Windows SDK (rc.exe, signtool.exe). Nothing else.

### Code signing (optional, off by default)

Nothing is signed unless asked: `SIGN=1 SIGN_ARGS='<signtool certificate options>' windows/build-windows.sh`.
`build.ps1 -Sign` then signs `TinHatServer.exe`, the installer and its uninstaller (Inno `SignTool=`/
`SignedUninstaller=yes`) with SHA-256 and a timestamp (`-TimestampUrl`, default DigiCert's), and verifies the result.

What it would need (the project doesn't sign today: Windows says "Unknown publisher", and SmartScreen asks once,
More info → Run anyway):
- **Microsoft Trusted Signing** (≈ $10/month, "Basic"): an Azure subscription, a Trusted Signing account and certificate
  profile, identity validation of a person or a business, and on the build machine the Trusted Signing client
  (`Azure.CodeSigning.Dlib.dll`) plus a `metadata.json` naming the account. Then
  `SIGN_ARGS='/dlib C:\path\Azure.CodeSigning.Dlib.dll /dmdf C:\path\metadata.json'`, signed in with an Azure identity
  that may use the profile.
- **Or a classic OV/EV certificate** (since 2023 the key lives on a hardware token or a cloud HSM): plug in / configure
  the token on the build machine and use `SIGN_ARGS='/sha1 <thumbprint>'` (or the vendor's CSP options).
- What it changes: UAC says "Tin Hat" instead of "Unknown publisher"; SmartScreen's "Windows protected your PC" stops
  once the certificate has a download history (immediately for EV and, per Microsoft, for Trusted Signing over time).
  Unsigned, users see SmartScreen once per download (More info → Run anyway) and "Unknown publisher" at each UAC prompt.

## How it works

### The server: a WSL distribution called `TinHatServer`
The same Debian 13 appliance (Docker Compose stack + manager), imported per Windows user into
`%LOCALAPPDATA%\Tin Hat Server\server\ext4.vhdx`. `/etc/wsl.conf` turns systemd on, runs as root, keeps WSL from
renaming the server or rewriting `/etc/hosts`, and switches off Windows interop and drive mounts (the server can't run
Windows programs or read the PC's files). VM-only units (grow-root, the guest agent, systemd-networkd, the consoles
that showed the setup-code banner, GRUB's boot record) are kept off from the first start by drop-ins and masked by
`tinhat-wsl-boot.service`, which also holds kernel/boot-loader packages and sets the server's hostname at every start.
First start: ~15 s to `running`, no failed units.

### Networking
- `.wslconfig` (merged, see below): `networkingMode=mirrored` gives the server the PC's own LAN address (avahi
  announces `<name>.local` on the LAN; calls get the right ICE address), `hostAddressLoopback=true` lets the PC reach
  its own server at that address (needed for calls from the PC itself), `memory=3GB` caps the WSL VM.
- The **Hyper-V firewall** (not Windows Defender Firewall) filters traffic to WSL and blocks inbound by default. The
  installer adds `TinHatServer-TCP-80/443/7881` + `TinHatServer-UDP-7882`, **Private profile only**. Port 80 is needed
  in home mode: every new device downloads the server's certificate from `http://<name>.local`. mDNS is allowed by
  WSL's own default rules.
- A Private-only rule does nothing on a network Windows calls **Public** (Windows 11's default for new networks): the
  installer's checks page offers "This is my home network: set "…" to Private" (ticked by default).
- From Windows itself, use `http://127.0.0.1/`: `localhost` resolves to `::1` first and IPv6 loopback isn't forwarded.
- Windows doesn't hear mDNS answers from its own server, so after setup the tray adds `127.0.0.1 <name> # Tin Hat
  Server` to the hosts file (one UAC prompt) and offers to trust the server's certificate (Windows' own warning).

### Keeping it running
- WSL stops a distribution ~15 s after its last `wsl.exe` client exits (and the VM 60 s later). `TinHatServer.exe
  --serve` keeps one `wsl.exe -d TinHatServer -u root --exec /usr/local/lib/tinhat-wsl/hold` alive, restarted with a
  back-off if it ends.
- `--serve` is started by the scheduled task `\Tin Hat Server\Keep the server running` (the owner's account, **S4U**:
  no stored password, runs before anyone signs in; triggers: at startup and at the owner's sign-in; restarts on
  failure). Because WSL's session is created from session 0, it survives sign-out (WSL only tears down sessions created
  from an interactive logon when that logon ends).
- One keep-alive per user (a `Global\` mutex with an explicit DACL for the user's SID, so the tray in the desktop
  session sees the one in session 0).
- It reads `HKCU\Software\Tin Hat Server` every 2 s: `Paused` (stop cleanly: `ctl stop` stops the manager and Docker,
  then `wsl --terminate`), `KeepAwake` (`SetThreadExecutionState(ES_SYSTEM_REQUIRED)` while running: the PC doesn't
  sleep, the screen may), `StartWithWindows` (0 = after a restart the server stays paused until Start).
- Windows shutting down: the hold runs in a kill-on-close job object (a leftover `wsl.exe` in session 0 held up the
  restart); the tray (when someone is signed in) gives the server 4 s to stop its database cleanly. With nobody signed
  in, it's like a power cut and Postgres recovers on the next start (seen in the logs: "automatic recovery", 0.01 s).
- Every 10 minutes it writes the real free space of the PC's drive into the server (`/run/tinhat-wsl/host-disk.json`):
  inside WSL the server only sees its 1 TB virtual disk.

### The tray icon
`TinHatServer.exe` (no arguments) at sign-in from `HKCU\…\Run`. Menu: status line, **Open dashboard** (or **Open setup
page** + **Show setup code** before setup), **Show recovery code**, **Pause server / Start server**, **Keep this PC
awake while the server runs** (off), **Start with Windows** (on), **Set up this PC to open your server…** (until done),
**Close this icon (the server keeps running)**. Left click = open. State comes from `http://127.0.0.1/admin/setup/status`
(never starts a paused server); the setup and recovery codes from `/usr/local/lib/tinhat-wsl/ctl`, which reads
`/var/lib/tinhat/setup-code` and `/run/tinhat/recovery-code`. A recovery code that appears (someone pressed "Forgot your
password?") pops up by itself, once per code. Icons: hat (running), grey hat with pause badge, hat with amber dot (not
set up / not answering).

### The installer
It looks like the Tin Hat app's installer (Inno's dark style, the same picture with "SERVER" under "Tin Hat",
`installer/assets/`) and opens on the same kind of choice, three command-link buttons:
- **Install Tin Hat Server** (**Update** / **Reinstall** when one is installed): the steps below.
- **Repair Tin Hat Server** (only when one is installed): the same steps as an update — the Windows part laid down
  again, `.wslconfig`, the firewall rules, the network profile, the task, the Run key — then the server is stopped
  completely (`--stop` + `wsl --terminate TinHatServer`, the helper's `restart-distro`) and started again, and setup
  waits until it answers. For a server that won't start, is stuck, or that other devices can't reach. Its data stays.
- **Uninstall Tin Hat Server** (only when one is installed): a page that says what goes and has **Keep my server's
  data** (ticked). Setup first checks whose server it is (it refuses when Windows elevated it as another account, or
  when the startup task belongs to another account), then does the server's part itself, as the signed-in person
  (`user-uninstall`: stop it, keep its disk or delete it, unregister it). Only when that worked does the installed
  uninstaller remove the rest (`unins000.exe /VERYSILENT /USERPARTDONE=1 /REMOVEDATA=0|1`), so a failure leaves a
  complete installation for Repair or another try. Afterwards setup checks the distribution is gone and, when asked,
  the data kept. Nothing is installed by that run (`Uninstallable` / `CreateUninstallRegKey` are off).
Unattended: `/VERYSILENT` installs (or updates); `/VERYSILENT /MODE=repair`; `/VERYSILENT /MODE=uninstall` (keeps the
data unless `/REMOVEDATA=1`; a later install brings a kept server back unless `/USEKEPT=0`). `/MODE=repair|uninstall` on a PC without Tin Hat Server is an error (exit code 1), never
an install. Exit codes besides Inno's own: **11** installed or repaired, but the server didn't start; **12** uninstalled,
but the check afterwards found the server still there or its data not kept. A restart for WSL keeps the mode and the
quiet switches (`/SILENT`, `/VERYSILENT`, `/SUPPRESSMSGBOXES`, `/NORESTART`, `/CHANGEWSLNETWORK=1`, `/NETWORKPRIVATE=1`).

**Keeping the data never overwrites or loses a server.** `user-uninstall` finds the disk where WSL has it registered
(`HKCU\…\Lxss`, not an assumed path) and unregisters only after the disk is safely in `kept\` (moved, or exported
while other distributions run). A server kept at an earlier uninstall moves into `kept\earlier-<date>\` instead of
being replaced; "don't keep" deletes this server only and leaves those. Uninstalling from Settings → Apps does the
same steps; if the server's part fails there, the uninstaller stops before Inno removes anything (an exception at
`usUninstall`) and Tin Hat Server stays installed. The uninstaller refuses to run as an account other than the
server's owner.

`PrivilegesRequired=admin` (one UAC prompt), but everything that belongs to the person runs as the signed-in user
(`ExecAsOriginalUser`): the import, `.wslconfig`, the Run key, starting the server. Setup refuses if Windows elevated
it as a different account (over-the-shoulder password), since the server would land in that other profile.
1. **Checking your PC**: Windows 11 22H2+ (also enforced before any page), virtualization (firmware flag or a running
   hypervisor), memory, disk (≥10 GB hard, 20 GB advised), WSL present, ports 80/443/7881/7882 free (names the program
   holding one; Try again), Windows-reserved port ranges, the network profile, an existing server, a server kept at
   uninstall, one server per PC (refuses if another Windows account runs one).
2. **Windows' Linux settings** (only if the person already has a `.wslconfig` or other distributions): exactly which
   three lines change and what that means for their other distributions; replacing a different `networkingMode`
   needs a tick.
3. Ready → if WSL is missing: Virtual Machine Platform (DISM) + Microsoft's WSL MSI from GitHub (pinned 3.0.3,
   SHA-256 checked; the inbox `wsl --install` stub refuses to run non-interactively), ~50 s, then **one restart**: a
   RunOnce entry starts the same setup file with `/RESUME=1` after sign-in; it skips the pages and carries on with the
   saved choices (UAC asks again). Setup removes the file's download mark before the restart so Windows shouldn't warn
   about it a second time; that last part isn't proven yet (the tested resume still showed "Open File - Security Warning").
4. Import (~55 s on the test machine), merge `.wslconfig` (backup `.wslconfig.before-tinhat-server`, lines marked "added by Tin
   Hat Server", `wsl --shutdown` only if something changed), firewall rules, optional Private network, the task, the Run
   key, start + wait until the setup page (and, if set up, the chat server) answers.
5. Finish: the setup code on the page and "Open the setup page now" (opens `http://127.0.0.1/`); the tray starts.
- **Update**: running a newer installer over an existing install replaces the Windows part and keeps the server as it
  is (the server itself updates through the dashboard's updater).
- **Uninstall** (Settings → Apps): Windows' "Remove Tin Hat Server?" then "Keep your server's data?". Yes moves the
  disk to `%LOCALAPPDATA%\Tin Hat Server\kept\ext4.vhdx` (stops WSL first if nothing else runs, else `wsl --export
  --vhd`); a reinstall offers "Bring back the server you kept" (`wsl --import-in-place`). No deletes it. Either way the
  task, firewall rules, Run key, settings, hosts line and the `.wslconfig` lines are removed (the file itself if setup
  created it); WSL stays installed. Silent: `/VERYSILENT` keeps data, `/REMOVEDATA=1` deletes it.

### Where things are
| What | Where |
|---|---|
| Program | `C:\Program Files\Tin Hat Server\` (`TinHatServer.exe`, `setup-helper.ps1`, uninstaller) |
| Server disk, logs, kept data | `%LOCALAPPDATA%\Tin Hat Server\server\ext4.vhdx`, `logs\` (`serve.log`, `tray.log`, `cli.log`, `setup-helper.log`, `uninstall.log`), `kept\` |
| Settings | `HKCU\Software\Tin Hat Server` (`Paused`, `KeepAwake`, `StartWithWindows`, `WslConfigAdded`, `SetUp`) |
| Autostart | task `\Tin Hat Server\Keep the server running`; `HKCU\…\Run` value "Tin Hat Server" (tray) |
| Network | Hyper-V firewall rules `TinHatServer-*`; hosts line `# Tin Hat Server`; `%USERPROFILE%\.wslconfig` lines |
| Command line | `TinHatServer.exe` with `--status`, `--start`, `--pause`, `--stop`, `--setup-code`, `--recovery-code`, `--wait-ready [s]`, `--open-setup`, `--hosts-set NAME`, `--hosts-clear`, `--version` (no option: the tray; `--serve`: the keep-alive) |

## Known limits
- Windows 11 22H2+ on x64 only (the appliance has no arm64 build yet). Windows 10 is refused before any page.
- Installing WSL needs the internet (≈370 MB from Microsoft) and one restart. UAC asks at the start, again after the
  restart, and once more when the tray sets up this PC (hosts file). Unsigned: SmartScreen once, "Unknown publisher".
- One server per PC (it needs the PC's ports 80/443/7881/7882).
- `.wslconfig` is shared by all of the person's WSL distributions: the 3 GB cap and mirrored networking apply to their
  other distributions too (Docker Desktop and some VPNs behave differently in mirrored mode). The installer says so and
  asks before replacing another network mode; their own memory size wins.
- Other devices can reach the server only on networks Windows treats as Private. At a café nothing gets in (by design).
- While the PC sleeps or is off, the group can't chat or call (Keep awake helps while it's on).
- A clean database stop at Windows shutdown needs someone signed in (the tray); otherwise Postgres does crash recovery.
- The server's virtual disk grows in `%LOCALAPPDATA%` and doesn't shrink by itself (WSL's sparse-VHD option is still
  experimental; not enabled).
- The server's root certificate stays in the user's trusted roots after uninstall (harmless once the server's key is
  gone; removing it would need another Windows prompt).
- The tray offers to set up the PC only when it watches setup finish; otherwise it's in the menu ("Set up this PC…").
- WSL takes the clock from Windows: a PC with a wrong clock breaks call sign-in (seen on a test machine whose clock was 6 h
  behind; real PCs sync their time).
- Not tested here: game anti-cheat next to the WSL hypervisor; refusing an over-the-shoulder elevation (standard user
  + another admin's password); "Friends anywhere" (UPnP from inside mirrored mode and
  the names service), the relay and federation under WSL; the dashboard's updater under WSL; a laptop on Wi-Fi.

## Tested (2026-10-18)
Fresh machine (no WSL) → installer through SmartScreen and UAC → WSL switched on → restart → setup resumed by itself →
server running → setup page at `http://127.0.0.1/` → setup in Edge (home network, `winpc.local`) → tray's PC setup
(hosts + certificate) → `https://winpc.local/admin/` → recovery code shown by the tray → Pause/Start from the tray →
sign-out (server stays up) → uninstall from Settings → Apps. Also, from another device on the network (a Linux
machine): TCP 80/443, mDNS `<name>.local`, the certificate download, sign-in, an invite and a friend's account, and a real
WebRTC call (LiveKit selected `udp4 <the PC's address>:7882` ↔ the other device). Restart with nobody signed in: server
back in ~1:45. Keep-data uninstall + reinstall brought back the same accounts. Screenshots:
`out/windows/screenshots/`.
