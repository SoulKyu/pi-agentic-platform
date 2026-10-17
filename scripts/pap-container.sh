#!/usr/bin/env bash
# Builds and runs the pap image with rootless podman, with exactly the option set that spike S8 measured (R52b).
# usage: pap-container.sh build | run [--port N] [--name NAME] [--project DIR]... | url [--name NAME] | stop [--name NAME]
set -euo pipefail
umask 077

die() { printf 'pap-container: %s\n' "$*" >&2; exit 1; }

IMAGE="${PAP_IMAGE:-localhost/pap:dev}"
VOLUME="pap-data"
[ "$(id -u)" -ne 0 ] || die "rootful podman is not supported (the S8 measurements are rootless): run as your own user"
[ -z "${PAP_CONTAINER_RUNTIME:-}" ] || [ "$PAP_CONTAINER_RUNTIME" = podman ] || die "only podman is supported; Docker was not measured (R52b)"
command -v podman >/dev/null 2>&1 || die "podman not found"
[ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" = true ] || die "podman is not rootless here: not supported"

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
verb="${1:-}"; [ -n "$verb" ] || die "usage: build | run | url | stop"; shift

port=7777; name=pap; projects=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) [ "$#" -ge 2 ] || die "--port needs a value"; port="$2"; shift 2 ;;
    --name) [ "$#" -ge 2 ] || die "--name needs a value"; name="$2"; shift 2 ;;
    --project) [ "$#" -ge 2 ] || die "--project needs a value"; projects+=("$2"); shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
case "$port" in ""|*[!0-9]*) die "--port must be a number from 1024 to 65535" ;; esac
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || die "--port must be a number from 1024 to 65535"
case "$name" in ""|*[!a-z0-9_.-]*|[!a-z0-9]*) die "--name must be lower-case letters, digits, . _ -" ;; esac
[ "${#name}" -le 40 ] || die "--name is too long"

case "$verb" in
  build)
    [ -f "$repo/Containerfile" ] || die "no Containerfile in $repo"
    base="${PAP_BASE_IMAGE:-docker.io/library/node:24-bookworm-slim}"
    podman pull --quiet -- "$base" >/dev/null
    digest="$(podman image inspect --format '{{.Digest}}' -- "$base")"
    case "$digest" in sha256:[0-9a-f][0-9a-f]*) ;; *) die "cannot read the digest of $base" ;; esac
    [ "${#digest}" -eq 71 ] || die "cannot read the digest of $base"
    case "${digest#sha256:}" in *[!0-9a-f]*) die "cannot read the digest of $base" ;; esac
    commit="$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
    exec podman build --format docker --file "$repo/Containerfile" --tag "$IMAGE" \
      --build-arg "BASE_IMAGE=${base%%@*}@$digest" --label "org.opencontainers.image.revision=$commit" \
      --label "org.opencontainers.image.base.digest=$digest" -- "$repo"
    ;;
  run)
    mounts=()
    for dir in ${projects[@]+"${projects[@]}"}; do
      case "$dir" in /*) ;; *) die "--project needs an absolute folder" ;; esac
      [ -d "$dir" ] || die "--project: not a folder"
      case "$dir" in *[!A-Za-z0-9._+@/-]*) die "--project: only letters, digits and . _ + @ / - are allowed" ;; esac
      case "/$dir/" in */./*|*/../*) die "--project: no . or .. part in the path" ;; esac
      real="$(cd -P -- "$dir" 2>/dev/null && pwd -P)" || die "--project: cannot resolve the folder"
      case "$real" in *[!A-Za-z0-9._+@/-]*) die "--project: only letters, digits and . _ + @ / - are allowed" ;; esac
      [ "$real" != / ] || die "--project: refusing / (keep-id makes the mount writable as you)"
      [ -n "${HOME:-}" ] || die "--project: HOME is not set, so your home folder cannot be ruled out"
      home_real="$(cd -P -- "$HOME" 2>/dev/null && pwd -P)" || home_real=/
      case "$home_real/" in "$real"/*) die "--project: refusing your home folder and its parents (keep-id makes the mount writable as you)" ;; esac
      mounts+=(--volume "$real:/work/$(basename -- "$real"):rw")
    done
    podman run --detach --name "$name" --replace --stop-timeout 40 \
      --user 10001:10001 --userns=keep-id:uid=10001,gid=10001 --cap-drop ALL \
      --security-opt no-new-privileges --security-opt systempaths=unconfined \
      --publish "127.0.0.1:$port:$port" --env "PAP_PORT=$port" \
      --volume "$VOLUME:/home/pap" ${mounts[@]+"${mounts[@]}"} -- "$IMAGE" >/dev/null
    printf 'pap-container: started %s on http://localhost:%s (this machine only). Setup URL: %s url --name %s\n' "$name" "$port" "$0" "$name"
    printf 'pap-container: agents that require the sandbox need the options above; check: podman exec %s node /opt/pap/apps/daemon/dist/main.js doctor --only bwrap\n' "$name"
    ;;
  url)
    podman container exists -- "$name" || die "no container named $name (podman ps -a)"
    line="$(podman logs --tail 300 -- "$name" 2>&1 | sed -n 's/.*"url":"\(http:\/\/localhost:[0-9]*\/setup#token=[A-Za-z0-9._~-]*\)".*/\1/p' | tail -n 1)"
    case "$line" in http://localhost:*/setup#token=*) printf '%s\n' "$line" ;; *) printf 'no setup URL: an owner already exists, or pap is not listening yet (podman logs %s)\n' "$name" ;; esac
    ;;
  stop) exec podman stop --time 40 -- "$name" ;;
  *) die "usage: build | run | url | stop" ;;
esac
