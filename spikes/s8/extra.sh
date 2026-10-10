#!/bin/sh
# Evidence behind docs/spikes/s8.md that matrix.sh does not cover; output committed as extra-results.txt.
# RUNTIME=docker re-measures with docker (podman-only cells print an error and are skipped).
set -eu
cd "$(dirname "$0")"
RUNTIME=${RUNTIME:-podman}
"$RUNTIME" build -t pap-s8 .

echo "##### 0. host and runtime facts"
uname -r
sysctl kernel.apparmor_restrict_unprivileged_userns user.max_user_namespaces || true
grep "^$(id -un):" /etc/subuid || true
"$RUNTIME" --version || true
"$RUNTIME" unshare cat /proc/self/uid_map || true
"$RUNTIME" info 2>/dev/null | grep -E "^ +(ociRuntime|name|rootless|seccompEnabled|seccompProfilePath|apparmorEnabled|version):|^ +(crun|runc) version" || true
"$RUNTIME" image inspect node:24-bookworm-slim --format '{{.RepoDigests}}' || true
"$RUNTIME" run --rm --entrypoint sh pap-s8 -c 'node --version; bwrap --version; ls -l /usr/bin/bwrap' || true

echo "##### D. the two decisive probe.sh cells, repeated twice"
for i in 1 2; do
  for opts in "" "--security-opt systempaths=unconfined"; do
    echo "=== repeat $i: $RUNTIME run $opts"
    # shellcheck disable=SC2086
    "$RUNTIME" run --rm $opts pap-s8 || true
  done
done

echo "##### A. extra option sets (probe.sh)"
for opts in "--security-opt systempaths=unconfined --cap-drop ALL --security-opt no-new-privileges" \
  "--security-opt systempaths=unconfined --security-opt seccomp=unconfined" \
  "--security-opt unmask=/proc/*" "--security-opt unmask=ALL"; do
  echo "=== $RUNTIME run $opts"
  # shellcheck disable=SC2086
  "$RUNTIME" run --rm $opts pap-s8 || true
done

echo "##### B. container-side checks as pap (inside.sh all)"
for opts in "" "--security-opt systempaths=unconfined" "--cap-add SYS_ADMIN"; do
  echo "=== $RUNTIME run $opts"
  # shellcheck disable=SC2086
  "$RUNTIME" run --rm $opts --entrypoint sh pap-s8 -c "$(cat inside.sh)" inside all || true
done

echo "##### C. masked-path exposure as container root (not the image user), inside.sh exposure"
for opts in "" "--security-opt systempaths=unconfined"; do
  echo "=== $RUNTIME run --user 0 $opts"
  # shellcheck disable=SC2086
  "$RUNTIME" run --rm --user 0 $opts --entrypoint sh pap-s8 -c "$(cat inside.sh)" inside exposure || true
done
