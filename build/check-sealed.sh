#!/bin/bash
# check-sealed.sh ROOT — is the Tin Hat Server root filesystem mounted at ROOT (read-only) in its sealed state: nothing
# left of the build machine and nothing every image would share? Lists each leftover; exit 0 = none, 1 = some,
# 2 = ROOT isn't a Tin Hat Server root filesystem. seal.sh removes all of these: this checks that it did.
# Run by build.sh export (the sealed disk) and windows/build-rootfs.sh (the image the WSL rootfs is made from).
# Fails closed: a check that can't run counts as a leftover. Links in the image are never followed: a link where a
# checked file or folder (or one of its parents) should be is a leftover too (an absolute one would point into the host).
set -u
R=${1:?usage: check-sealed.sh ROOT}
[ -d "$R" ] && [ ! -L "$R" ] || { echo "check-sealed: $R is not a folder" >&2; exit 2; }
bad=0
left() { echo "check-sealed: $*" >&2; bad=1; }

# REL is in the image, as anything (a dangling link too).
there() { [ -e "$R/$1" ] || [ -L "$R/$1" ]; }
# REL's parents are real folders of the image (or absent), never links (so "$R/REL" can't lead out of it), never
# other files. Else: a leftover.
parents_real() {
  local rel=$1 p=""
  while [ "${rel%%/*}" != "$rel" ]; do
    p+=${rel%%/*}; rel=${rel#*/}
    [ -L "$R/$p" ] && { left "/$p is a link"; return 1; }
    [ -e "$R/$p" ] && [ ! -d "$R/$p" ] && { left "/$p isn't a folder"; return 1; }
    p+=/
  done
  return 0
}
# REL is a real folder of the image (0), absent (1), or a leftover: a link or another kind of file there (2).
real_dir() {
  parents_real "$1" || return 2
  if [ -L "$R/$1" ]; then left "/$1 is a link"; return 2; fi
  [ -e "$R/$1" ] || return 1
  [ -d "$R/$1" ] && return 0
  left "/$1 isn't a folder"; return 2
}
# Everything under folder REL matching find's tests (after REL), listed as leftovers; a find that fails is one too.
none_under() {
  local rel=$1 out; shift
  real_dir "$rel"; case $? in 1) return 0 ;; 2) return ;; esac
  out=$(find "$R/$rel" -mindepth 1 "$@" -printf "/$rel/%P\n" 2>/dev/null) || { left "can't read all of /$rel (find failed)"; return; }
  [ -z "$out" ] || while IFS= read -r f; do left "$f is still there"; done <<<"$out"
}
absent() { parents_real "$1" && { there "$1" && left "/$1 is still there"; }; return 0; }

[ -f "$R/opt/tinhat/VERSION" ] && [ ! -L "$R/opt" ] && [ ! -L "$R/opt/tinhat" ] && [ ! -L "$R/opt/tinhat/VERSION" ] \
  || { echo "check-sealed: $R is not a Tin Hat Server root filesystem" >&2; exit 2; }

# The build account (build.sh: cloud-init's user tinhatbuild) and what cloud-init set up.
for f in home/tinhatbuild etc/sudoers.d/90-cloud-init-users etc/cloud var/lib/cloud \
         etc/passwd- etc/group- etc/shadow- etc/gshadow- etc/subuid- etc/subgid-; do
  absent "$f"
done
for f in etc/passwd etc/group etc/shadow etc/gshadow etc/subuid etc/subgid; do
  parents_real "$f" || continue
  if [ -L "$R/$f" ]; then left "/$f is a link"; continue; fi
  if ! there "$f"; then case $f in etc/passwd|etc/group|etc/shadow) left "/$f is missing" ;; esac; continue; fi
  [ -f "$R/$f" ] || { left "/$f isn't a plain file"; continue; }
  grep -q '^tinhatbuild:' "$R/$f"; case $? in 0) left "/$f still names the build account" ;; 1) ;; *) left "can't read /$f" ;; esac
done
# Keys: root's (cloud-init put the build key there), any user's (a server has no users before its setup: nothing at
# all under /home, links included), the SSH host keys (each server makes its own).
absent root/.ssh
none_under home
none_under etc/ssh -maxdepth 1 -name 'ssh_host_*'
# Shared secrets and identities: the random seed, systemd's credential key, the machine id (D-Bus's is a link to it).
absent var/lib/systemd/random-seed
absent var/lib/systemd/credential.secret
if parents_real etc/machine-id; then
  if [ -L "$R/etc/machine-id" ] || [ ! -f "$R/etc/machine-id" ]; then left "/etc/machine-id isn't a plain file"
  elif [ -s "$R/etc/machine-id" ]; then left "/etc/machine-id isn't empty (every image would share it)"; fi
fi
if parents_real var/lib/dbus/machine-id && there var/lib/dbus/machine-id; then
  [ -L "$R/var/lib/dbus/machine-id" ] && [ "$(readlink "$R/var/lib/dbus/machine-id")" = /etc/machine-id ] \
    || left "/var/lib/dbus/machine-id isn't a link to /etc/machine-id (every image would share it)"
fi
# The build's journal (the build network's addresses) and its setup state (passwords made during the build): their
# folders stay, empty. Docker: no containers (their config holds the setup's environment) and no volumes.
none_under var/log/journal
none_under var/lib/tinhat
none_under var/lib/docker/containers
none_under var/lib/docker/volumes -maxdepth 1 ! \( -name metadata.db -type f \) ! \( -name backingFsBlockDev -type b \)
# What the build pushed in, seal.sh itself, and what the build left in the temporary folders (dot files too).
for f in root/payload root/seal.sh root/seal.log root/.bash_history; do absent "$f"; done
none_under tmp
none_under var/tmp
# The name every server starts with.
if parents_real etc/hostname; then
  if [ -L "$R/etc/hostname" ] || [ ! -f "$R/etc/hostname" ] || ! h=$(cat "$R/etc/hostname") || [ "$h" != tinhat ]; then
    left "/etc/hostname isn't tinhat"
  fi
fi
exit $bad
