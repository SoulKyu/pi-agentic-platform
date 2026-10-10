#!/bin/sh
set -u
mkdir -p /home/pap/agent-home
run() {
  label=$1
  shift
  if out=$("$@" 2>&1); then echo "PASS $label: $out"; else echo "FAIL $label: $out"; fi
}
run minimal bwrap --ro-bind / / --dev /dev --proc /proc -- sh -c 'echo ok'
run unshare-pid bwrap --ro-bind / / --unshare-pid --dev /dev --proc /proc -- sh -c 'echo ok'
run unshare-net bwrap --ro-bind / / --unshare-net --dev /dev --proc /proc -- sh -c 'echo ok'
run pi-web-profile bwrap --ro-bind / / --unshare-pid --proc /proc --dev /dev --unshare-ipc \
  --tmpfs /run --tmpfs /tmp --tmpfs /home/pap \
  --bind /home/pap/agent-home /home/pap/agent-home --unshare-net --die-with-parent \
  -- sh -c 'touch /home/pap/agent-home/w && echo ok'
