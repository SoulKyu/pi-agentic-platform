#!/usr/bin/env bash
# Builds the install archive on an older glibc (M6bR33a): a convenience for "build on the oldest host you target".
# The checkout is mounted read-only and copied inside, so your node_modules and dist are never replaced by
# container-built ones; only the archive folder comes out. Needs network inside the container (apt, pnpm) and a
# Node linux-x64 tarball you downloaded and verified yourself (the archive embeds the node that built it).
# A linked worktree is not supported (its .git file points outside the mount): use a normal clone.
# usage: build-archive-podman.sh --node-tarball FILE [--image ubuntu:22.04] [--image-digest sha256:HEX] [--out DIR]
set -euo pipefail
umask 077

die() { printf 'build-archive-podman: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run as your own user (rootless podman)"
command -v podman >/dev/null 2>&1 || die "podman not found"

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
case "$repo" in *[!A-Za-z0-9._+@/-]*) die "the checkout path may hold only letters, digits and . _ + @ / -" ;; esac
[ -d "$repo/.git" ] || die "needs a normal clone (a .git folder, not a linked worktree)"
digest=""
image="docker.io/library/ubuntu:22.04"; out="$repo/.pap-archive"; tarball="${PAP_NODE_TARBALL:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) [ "$#" -ge 2 ] || die "--image needs a value"; image="$2"; shift 2 ;;
    --image-digest) [ "$#" -ge 2 ] || die "--image-digest needs a value"; digest="$2"; shift 2 ;;
    --out) [ "$#" -ge 2 ] || die "--out needs a value"; out="$2"; shift 2 ;;
    --node-tarball) [ "$#" -ge 2 ] || die "--node-tarball needs a value"; tarball="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
case "$image" in ""|*[!A-Za-z0-9./:_@-]*|[!A-Za-z0-9]*) die "--image: unexpected characters" ;; esac
if [ -n "$digest" ]; then
  case "$digest" in sha256:*) ;; *) die "--image-digest must look like sha256:<64 hex>" ;; esac
  [ "${#digest}" -eq 71 ] || die "--image-digest must look like sha256:<64 hex>"
  case "${digest#sha256:}" in *[!0-9a-f]*) die "--image-digest must look like sha256:<64 hex>" ;; esac
  image="${image%%@*}@$digest"
fi
[ -n "$tarball" ] && [ -f "$tarball" ] || die "--node-tarball (or PAP_NODE_TARBALL) must name a node-v24.x-linux-x64.tar.xz file"
case "$tarball$out" in *[!A-Za-z0-9._+@/-]*) die "paths: only letters, digits and . _ + @ / - are allowed" ;; esac
case "$tarball" in /*) ;; *) die "--node-tarball must be absolute" ;; esac
case "$out" in /*) ;; *) die "--out must be absolute" ;; esac
mkdir -p -- "$out"

# shellcheck disable=SC2016
recipe='set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential python3 git ca-certificates xz-utils
mkdir /opt/node && tar -xJf /node.tar.xz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:$PATH
corepack enable
export HOME=/pap-archive-build
mkdir -p "$HOME/src"
tar -C /src --exclude=./node_modules --exclude=./.worktrees --exclude=./.pap-archive --exclude="*/node_modules" --exclude="*/dist" -cf - . | tar -C "$HOME/src" -xf -
git config --global --add safe.directory /pap-archive-build/src
cd /pap-archive-build/src
pnpm install --frozen-lockfile && pnpm build && pnpm build:archive --allow-dirty
cp -R /pap-archive-build/src/.pap-archive/. /out/'

exec podman run --rm --volume "$repo:/src:ro" --volume "$out:/out:rw" --volume "$tarball:/node.tar.xz:ro" \
  -- "$image" bash -c "$recipe"
