#!/bin/bash
# selfhost-bundle-check.sh — the web bundle's leak gate (docs/SELFHOST.md §6).
# Builds the bundle every Tin Hat Server serves (`vite build`: the web app has one build) into tmp/selfhost-dist and
# fails if anything the deny list names is left in it. The patterns come from a deny file the maintainers keep next to
# this script (tools/selfhost-deny.sh, or $TH_BUNDLE_DENY): it is not part of the published copy. It sets DENY_RE_I
# (an extended regular expression matched without regard to case) and/or DENY_RE (matched as written). There is no
# allow-list: every match fails, whatever it sits in. Without a deny file the script only checks that the bundle exists.
# Usage (from the host): tw -w <worktree> bash tools/selfhost-bundle-check.sh [--no-build]
#   --no-build  check the bundle already in tmp/selfhost-dist (e.g. after Tin Hat Server's build.sh web); fails when
#               there is none.
cd "$(dirname "$0")/.." || exit 1
DIST=tmp/selfhost-dist
if [ "$1" != "--no-build" ]; then
  mkdir -p tmp
  pnpm exec vite build --outDir "$DIST" --emptyOutDir >tmp/selfhost-build.log 2>&1 || { tail -30 tmp/selfhost-build.log; echo "build failed"; exit 1; }
fi
if [ ! -f "$DIST/index.html" ] || [ -z "$(find "$DIST" -name '*.js' -print -quit 2>/dev/null)" ]; then
  echo "no bundle in $DIST (index.html + *.js) — build it first, or run without --no-build"
  exit 1
fi
DENY_RE_I=""; DENY_RE=""
DENY_FILE=${TH_BUNDLE_DENY:-tools/selfhost-deny.sh}
if [ ! -e "$DENY_FILE" ] && [ ! -L "$DENY_FILE" ]; then
  echo "bundle present; no deny list ($DENY_FILE) — nothing else checked"
  exit 0
fi
# a deny file that is there but can't be read, doesn't source, or sets nothing is a broken check, never a pass
# shellcheck disable=SC1090
{ [ -f "$DENY_FILE" ] && [ -r "$DENY_FILE" ] && . "$DENY_FILE"; } || { echo "deny list $DENY_FILE couldn't be read — not checked"; exit 1; }
if [ -z "$DENY_RE_I" ] && [ -z "$DENY_RE" ]; then
  echo "deny list $DENY_FILE sets neither DENY_RE_I nor DENY_RE — not checked"
  exit 1
fi
# What a Tin Hat Server serves (source maps stay behind: build.sh drops them).
INCL=(--include='*.js' --include='*.mjs' --include='*.html' --include='*.css' --include='*.webmanifest' --include='*.json'
  --include='*.svg' --include='*.txt' --include='*.theme' --include='*.qml')
# -a: a stray NUL byte must not turn a file into "binary file matches" (no -o output = a false pass); up to 30
# characters around each match so the report says where it sits.
hits=""; n=0
for mode in i s; do
  re=$DENY_RE_I; flags=-rnoaiE
  [ $mode = s ] && { re=$DENY_RE; flags=-rnoaE; }
  [ -n "$re" ] || continue
  # grep's status decides (0 = a match, even one -o prints nothing for); the output only reports
  out=$(LC_ALL=C grep $flags "($re)" "$DIST" "${INCL[@]}"); st=$?
  [ "$st" -le 1 ] || { echo "grep failed (exit $st) — not checked"; exit 1; }
  [ "$st" -eq 0 ] || continue
  c=$(printf '%s' "$out" | grep -c .)
  n=$((n + (c > 0 ? c : 1)))
  hits+="$(LC_ALL=C grep $flags ".{0,30}(${re}).{0,30}" "$DIST" "${INCL[@]}")"$'\n'
done
files=$(find "$DIST" -type f | wc -l)
if [ "$n" -gt 0 ]; then
  echo "bundle ($files files): $n forbidden match(es); where (file:line:context):"
  printf '%s' "$hits" | head -60
  [ "$(printf '%s' "$hits" | grep -c .)" -gt 60 ] && echo "… more"
  exit 1
fi
echo "OK — bundle ($files files): nothing the deny list names"
