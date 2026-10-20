#!/bin/sh
# T20b: installs pap's Kata stack on a GitHub-hosted ubuntu-24.04 runner (KVM) for the `kata` job.
#
# `pap vm setup` runs from this checkout (--dev-from-tree, so run `pnpm build` first). The job's only network use is the pinned
# archives `pap vm setup` fetches (SHA-256 checked) and the pinned base image digest pre-pulled below (RT-44). The Kata tests
# (`*.kata.int.test.ts`) then run against the stack as this user, with papHome `$HOME/.pap-kata` (the home the bed insists on).
# POSIX sh. Needs sudo. Run from anywhere: it finds the checkout from its own path.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tree=$(cd "$here/../.." && pwd)
user=$(id -un)
home="${HOME}/.pap-kata"

if [ ! -c /dev/kvm ]; then
  echo "kata-setup: /dev/kvm is missing: this runner cannot run the agents' VMs" >&2
  exit 1
fi
# T0a: the runner's /dev/kvm is root-owned; the VMs are started by root, but pap's doctor and the bed read it as this user.
sudo chmod 666 /dev/kvm

for program in nft ip; do
  if ! command -v "$program" >/dev/null 2>&1 && [ ! -x "/usr/sbin/$program" ]; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends nftables iproute2
    break
  fi
done

# sudo resets PATH: give it node's absolute path.
node_bin=$(command -v node)
sudo "$node_bin" --disable-warning=ExperimentalWarning "$tree/apps/daemon/dist/main.js" vm setup \
  --user "$user" --home "$home" --dev-from-tree

# Pre-pull the pinned Node base image (by digest) into pap's own containerd namespace, so no test waits on a registry.
image=$(node -e '
  const assets = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const node = assets.baseImages.find((one) => one.name === "node");
  if (!/^sha256:[0-9a-f]{64}$/.test(node.digest)) process.exit(1);
  process.stdout.write("docker.io/library/node@" + node.digest);
' "$tree/apps/daemon/src/cli/vm/vm-assets.json")
sudo /opt/pap-vm/bin/nerdctl --address /run/pap-vm/containerd.sock --namespace pap --data-root /var/lib/pap-vm/nerdctl \
  --cni-path /opt/pap-vm/libexec/cni --cni-netconfpath /etc/pap-vm/cni pull "$image"

systemctl is-active pap-vm-containerd pap-vm-buildkit pap-vmd
