#!/bin/sh
set -eu
main=/opt/pap/apps/daemon/dist/main.js
# One warning line when the sandbox cannot run. The daemon still starts; agents that require the sandbox refuse (M11).
if ! node --disable-warning=ExperimentalWarning "$main" doctor --only bwrap >/dev/null 2>&1; then
  echo '{"level":"warn","msg":"container_sandbox_unavailable","hint":"run the image with scripts/pap-container.sh run (needs --security-opt systempaths=unconfined)"}' >&2
fi
exec node --disable-warning=ExperimentalWarning "$main" serve --host 0.0.0.0 --port "${PAP_PORT:-7777}"
