#!/bin/sh
# T16a: the agent bridge's anti-spoofing, end to end in network namespaces (RT-03, RT-04, RT-21, owner Q13 / R22).
#
# Builds the bridge `pap0` (10.213.0.1/24) with two "VMs" (namespaces vma and vmb behind veth pairs), loads the real ruleset
# (scripts/ci/netns-spoof.nft, kept equal to agentNetRuleset() by a unit test), adds both guard elements and neighbour
# entries the way pap-vmd's `attach` does, then runs scripts/ci/netns-spoof.py, which asserts:
#   - before the elements exist the bridge drops a VM's frames (fail closed);
#   - VM a reaches the gateway (7841) and relay (7842) ports, but not port 2222 on the host and not VM b;
#   - the relay port does not answer the host's own loopback path (a local process connecting to 10.213.0.1:7842);
#   - after VM a sends forged ARP replies claiming VM b's address and SYNs from VM b's address, the host's neighbour
#     entry for VM b keeps VM b's MAC and the drop counter moved; VM a and VM b still reach the gateway.
# With the ruleset of the original plan (no bridge-family guard, no `iifname != pap0` drop on the two ports) this script
# FAILS: the ARP poisoning moves the neighbour entry to VM a's MAC and the local relay connection succeeds.
#
# POSIX sh. Needs root, `ip`, `nft` and `python3`, and must run in a throwaway network namespace or container:
#   CI:    sudo unshare --net sh scripts/ci/netns-spoof.sh
#   local: podman run --rm --network none --privileged -v <checkout>:/work:ro <image with python3> \
#            sh /work/scripts/ci/netns-spoof.sh
# `IP` and `NFT` may name the programs (words are split, e.g. IP="/lib64/ld-linux-x86-64.so.2 /hostusr/sbin/ip").
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC2086 # IP and NFT may be a loader followed by a program
ip() { command ${IP:-ip} "$@"; }
# shellcheck disable=SC2086
nft() { command ${NFT:-nft} "$@"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "netns-spoof: must run as root in a throwaway network namespace" >&2
  exit 2
fi
# Refuse to touch a real host: the default namespace of a machine already has a pap0 or other bridges only if pap runs.
if ip link show pap0 >/dev/null 2>&1; then
  echo "netns-spoof: a pap0 already exists here; run in a fresh network namespace" >&2
  exit 2
fi

A_MAC=02:70:61:00:00:02
B_MAC=02:70:61:00:00:03
A_IP=10.213.0.2
B_IP=10.213.0.3

cleanup() {
  status=$?
  trap - EXIT
  ip netns del vma 2>/dev/null || true
  ip netns del vmb 2>/dev/null || true
  ip link del pap0 2>/dev/null || true
  nft delete table inet pap_agents 2>/dev/null || true
  nft delete table bridge pap_agents 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

ip link set lo up
ip link add pap0 type bridge
ip addr add 10.213.0.1/24 dev pap0
ip link set pap0 up

for vm in a b; do
  ip netns add "vm$vm"
  ip link add "veth$vm" type veth peer name eth0 netns "vm$vm"
  ip link set "veth$vm" master pap0 up
  ip -n "vm$vm" link set lo up
done
ip -n vma link set eth0 address "$A_MAC"
ip -n vmb link set eth0 address "$B_MAC"
ip -n vma addr add "$A_IP/24" dev eth0
ip -n vmb addr add "$B_IP/24" dev eth0
ip -n vma link set eth0 up
ip -n vmb link set eth0 up

nft -f "$here/netns-spoof.nft"

# Phase 1 runs now, with an empty `ports` set; the python script adds the elements itself between phases through this hook.
export NETNS_SPOOF_A_MAC="$A_MAC" NETNS_SPOOF_B_MAC="$B_MAC" NETNS_SPOOF_A_IP="$A_IP" NETNS_SPOOF_B_IP="$B_IP"
export NETNS_SPOOF_IP="${IP:-ip}" NETNS_SPOOF_NFT="${NFT:-nft}"
python3 -I "$here/netns-spoof.py" run
