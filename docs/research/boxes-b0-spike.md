# Boxes, lot B0: spike results (2026-10-23)

Throwaway spike for `docs/specs/2026-10-23-boxes-design.md` §13. Code stayed in a scratch folder; this note keeps the numbers. Host: 14 CPUs, 20 GB. Caveat: the scratch folder was on tmpfs, so the host baselines and the spike's disk file ran from RAM (virtualisation overhead, not real-SSD numbers).

## 1. A terminal in the guest: GO

- `/dev/pts` works in a Kata guest run with pap's flags (`--read-only`, pap's caps, `--net none`); the root is read-only virtiofs. Base image: Debian 13, guest kernel 6.18, git 2.47, ripgrep, python3; no build tools.
- node-pty 1.0.0 builds in pap's BuildKit with a multi-stage Dockerfile (builder: base + `build-essential python3 make g++`, then `npm install`; final: base + the copied module): 40 s, apt and npm reach the network inside BuildKit. The builder must start from the same base image so the Node ABI matches.
- In the guest (no gateway hop measured): bash spawned in 27 ms; resize to 120x40 read back by `stty size`; Ctrl-C on `sleep 30` back to the prompt in 1.6 ms; 100 one-character write-to-echo round trips p50 0.044 ms, p95 0.12 ms, max 4.3 ms; clean exit.

## 2. git on a VM block disk: GO

pap-vmd's attach (read from `apps/vmd/src/ops-disk.ts`, `argv.ts`): a sparse file, `mkfs.ext4`, `kata-ctl direct-volume add`, then `-v <dir>:/agent`. Cloud Hypervisor opens the file as virtio-blk (`/dev/vdb` in the guest); the host never loop-mounts or parses the file system the guest writes. The spike used a loop device passed with `--device` instead (same guest path, one extra host layer), since `kata-ctl` was outside its allowed commands.

Repository: this one (4,847 files, 112 MB, 587 commits) on an 8 GiB sparse ext4 disk, 2 vCPUs.

| Command (ms) | Host | Guest, first boot | Guest, second boot |
|---|---|---|---|
| `git status`, first run | 59 | 803 | 49 |
| `git status`, warm (median of 5) | 60 | 33 | 47 |
| `git ls-files` | 6 | 26 | 32 |
| `git log --oneline -1000` | 19 | 114 | 91 |
| `rg -F` over the tree | 14 | 52 | 58 |
| `git diff --stat`, 50 files changed | 60 | 38 | 33 |

Warm operations stay under 120 ms; only the first access after a boot is slow (empty guest page cache). Large dependency trees (`node_modules`) were not measured.

## 3. VM cost

- Cold start, `nerdctl run` to the first output line: 6.0 s median (6.06, 6.00, 6.01); the first run ever, 11.7 s (image unpack).
- Host memory of one idle 1 GiB VM: about 290 MB (cloud-hypervisor 205 MB, virtiofsd 53 MB, shim 28 MB). It grows with what the guest touches: the owner's running agent VMs showed about 1.08 GB of cloud-hypervisor RSS plus 640 MB of virtiofsd. A busy box costs close to its memory size plus several hundred MB.

## 4. GitHub App: GO

Tested on the owner's account with a throwaway App and the repository `SoulKyu/cpg`, then cleaned up (branch deleted, PR #28 closed, keys removed, App key and user token shredded; the owner deletes the App on GitHub).

- **Manifest flow over plain `http://192.168.1.182:7790`**: accepted, both the creation redirect and the user authorization callback (`request_oauth_on_install`). No public URL and no device flow needed.
- **The manifest takes repository permissions only.** Account permissions (`git_ssh_keys`, `gpg_keys`) make GitHub reject it ("Default permission records resource is not included in the list"). The owner set "SSH signing keys", "Git SSH keys" and "GPG keys" on the App's settings page before installing. pap's flow therefore has one manual step after creation, unless a later GitHub change allows them in the manifest.
- **Installation token**: minted for one repository with `contents`, `pull_requests` (and `administration` for the test) write, `repository_selection: selected`; `/installation/repositories` lists only that repository; it expires after one hour. Clone and push over HTTPS with `x-access-token` work; `POST /pulls` works.
- **User token** (from the authorization at install): expires after 8 hours and comes with a refresh token, so the host must refresh it.
- **Signing**: an SSH signing key added through the user token (`POST /user/ssh_signing_keys`, 201) signs a pushed commit that GitHub shows `verified: true, reason: valid`. A GPG key added the same way (`POST /user/gpg_keys`, 201) gives the same result. Committer email: the account's noreply address (`<id>+<login>@users.noreply.github.com`).
- A deploy key with the same public key was refused (422): a key already used on the account cannot be a deploy key. Not needed by the design.

## Consequences for the spec

- §9: SSH signing through the App's "SSH signing keys" account permission works as written; PGP works too and stays unplanned. The App's creation needs the owner to set three account permissions on GitHub's page before installing; the user token needs a refresh every 8 hours.
- §12: an idle box costs about 290 MB of host memory beyond the guest's, a busy one close to its full memory plus several hundred MB; the 2048 MB default fits about three or four project boxes beside the agents on this host.
- §4: the host never mounts a box disk (direct volume); seeding a project happens inside the box (clone or `git init`), never by writing the disk from the host.
