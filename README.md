<p align="center">
  <img src="docs/brand/pap-mark.svg" alt="pap" width="96" height="96">
</p>

<h1 align="center">pap</h1>

<p align="center">Self-hosted agentic platform on the Pi SDK.</p>

Status: early development (M2 sessions core merged, M3 design system in progress).

- Docs index: [docs/README.md](docs/README.md)
- Design system: [DESIGN.md](DESIGN.md)
- Commands, rules and worker settings: [AGENTS.md](AGENTS.md)

## Install

Linux with systemd, no sudo (the offline archive is x86-64). Full guide: [docs/agents/install.md](docs/agents/install.md).

Method 1, from a git checkout (needs Node 24.14+, pnpm, gcc, g++, make, python3):

- `git clone <repository> pap && cd pap`
- `scripts/install.sh` (builds, writes `~/.config/systemd/user/pap.service`, starts it)
- open the one-time setup URL it prints (`pap service url` prints it again until the next restart, even after it is used)
- `pap` is `~/.local/bin/pap`; reach a remote host with `ssh -L 7777:localhost:7777 <you>@<host>`

Method 2, offline archive pinned to a checksum:

- on the build host: `pnpm install && pnpm build && pnpm build:archive`
- copy the `.tar.gz` and `pap-install-<id>.sh` to the target (the script over a trusted channel)
- `./pap-install-<id>.sh` (carries its own Node; refuses a checksum mismatch)
- open the setup URL it prints; remove with `pap service uninstall` (data in `~/.pap` stays)

## Install, update, backup

- Update: run the new release's `pap-install-<id>.sh` with no flags, or `pap update install` (rolls back by itself if the new release does not start): [docs/agents/update.md](docs/agents/update.md)
- Backup and restore: `pap backup [--encrypt]`, `pap restore <file>` with pap stopped: [docs/agents/backup.md](docs/agents/backup.md)
- Check the machine and the install: `pap doctor`: [docs/agents/doctor.md](docs/agents/doctor.md)
- Container (rootless podman), npm and releases: [docs/agents/install.md](docs/agents/install.md)
- Everything that needs the public repository (feed, `curl | sh`, `npm publish`) waits for v1.
