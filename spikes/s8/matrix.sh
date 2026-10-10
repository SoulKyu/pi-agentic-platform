#!/bin/sh
# Host-side matrix. R49: podman (rootless) is the runtime on this host; RUNTIME=docker re-measures with docker at M9.
set -eu
cd "$(dirname "$0")"
RUNTIME=${RUNTIME:-podman}
"$RUNTIME" build -t pap-s8 .
for opts in "" "--security-opt seccomp=unconfined" "--security-opt apparmor=unconfined" \
  "--security-opt seccomp=unconfined --security-opt apparmor=unconfined" "--cap-add SYS_ADMIN" \
  "--security-opt systempaths=unconfined"; do
  echo "=== $RUNTIME run $opts"
  # shellcheck disable=SC2086
  "$RUNTIME" run --rm $opts pap-s8 || true
done
