#!/bin/sh
set -eu
main=/opt/pap/apps/daemon/dist/main.js
# One warning line when the sandbox cannot run. The daemon still starts; agents that require the sandbox refuse (M11).
exec node --disable-warning=ExperimentalWarning "$main" serve --host 0.0.0.0 --port "${PAP_PORT:-7777}"
