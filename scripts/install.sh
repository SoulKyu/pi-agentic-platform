#!/usr/bin/env bash
# Method 1: install pap from this git checkout as a systemd user service. Needs the network once (the registry).
set -euo pipefail

die() { printf 'pap-install: %s\n' "$*" >&2; exit 1; }
warn() { printf 'pap-install: warning: %s\n' "$*" >&2; }

[ "$(id -u)" -ne 0 ] || die "do not run as root: pap is a user service"
[ "$(uname -s)" = Linux ] || die "linux only"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[ -f "$repo/pnpm-workspace.yaml" ] && [ -d "$repo/apps/daemon" ] || die "not a pap checkout: $repo"

command -v node >/dev/null 2>&1 || die "node 24.14 or newer 24.x is required (not found)"
node_version="$(node -p 'process.versions.node')" || die "node failed to run"
[ -n "$node_version" ] || die "node failed to run"
IFS=. read -r major minor _ <<<"$node_version"
{ [ "$major" = 24 ] && [ "${minor:-0}" -ge 14 ]; } || die "node $node_version found; pap needs >=24.14 <25"
node_bin="$(node -p 'process.execPath')" || die "node failed to run"   # the real binary, not a volta / asdf shim
[ -x "$node_bin" ] || die "cannot resolve the node binary"
case "$repo$node_bin" in
  *[!A-Za-z0-9._+@/-]*) die "the checkout path or the node path has a character that the service unit cannot carry (allowed: letters, digits and . _ + @ / -)" ;;
esac
for tool in gcc g++ make python3 systemctl; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool (node-pty is compiled at install: gcc, g++, make, python3)"
done
systemctl --user show-environment >/dev/null 2>&1 \
  || die "no systemd user manager (log in with a full session, or set XDG_RUNTIME_DIR=/run/user/$(id -u))"
bwrap_path="${PAP_BWRAP:-/usr/bin/bwrap}"
{ [ -x "$bwrap_path" ] && [ "$(stat -L -c %u -- "$bwrap_path")" = 0 ]; } \
  || warn "bubblewrap not found: agents that require the sandbox will not start (sudo apt install bubblewrap)"

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  pnpm_cmd=(corepack pnpm)
else
  die "pnpm not found; enable it with: corepack enable"
fi

cd -- "$repo"
"${pnpm_cmd[@]}" install --frozen-lockfile
"${pnpm_cmd[@]}" build
main="$repo/apps/daemon/dist/main.js"
[ -f "$main" ] && [ -f "$repo/apps/web/dist/index.html" ] || die "the build left no apps/daemon/dist/main.js or apps/web/dist"

exec "$node_bin" --disable-warning=ExperimentalWarning "$main" service install --node "$node_bin" --main "$main" "$@"
