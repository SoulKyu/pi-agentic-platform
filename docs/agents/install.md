# Install (M6)

Linux with systemd only (method 1 runs on any architecture with Node 24 and the build tools; the method 2 archive is linux-x64 and glibc only). No sudo anywhere, nothing is written outside `$HOME` except where you point it (`XDG_CONFIG_HOME` when set outside `$HOME` moves the unit file; `--home` and `--bin-dir` take any safe absolute path), nothing is piped from the network into a shell unless you choose the one-line install below. pap runs as a **systemd user service** (`pap.service`) bound to `localhost:7777`. Code: `apps/daemon/src/cli/service/`, `scripts/install.sh`, `scripts/build-archive*.ts`, `scripts/archive-install.sh.tpl`. Decisions: ADRs 0055 to 0057 (install) and 0063 to 0067 (backup, update, image, release, doctor), rulings `docs/research/m6-rulings.md` and `m6b-rulings.md`. Other guides: `update.md`, `backup.md`, `doctor.md`.

Real-host check: done on 2026-10-17 by the controller (M6b Appendix A, owner b8), on a try instance (ports 7791 to 7794, `~/.pap-m6b-try*`, the preview untouched): archive install and a flagless rerun of the same release (unit unchanged, restarted), an update (18 s, no unit restart counted, the session kept), a failed update (exit 4, previous release back, the migrated database kept as `pre-rollback-<stamp>.db`), Ctrl-C during the verify window then `pap doctor` and `pap update recover`, an encrypted backup restored into a second home and served, `pap doctor` (read-only on the preview's unit), the container (build 165 s, 619 MB, bubblewrap works with the wrapper's options and is refused without `systempaths=unconfined`), and `npm install -g` of the packed tarball into a temporary prefix (boots, a helper op and a session worker start). It found and fixed: an installer rerun that rewrote the unit, a unit not restored on Ctrl-C, three npm package defects, and wrong copy in rollback and doctor.

## Prerequisites

- A systemd user manager: a full login session, or `XDG_RUNTIME_DIR=/run/user/$(id -u)` over ssh. Both installers check this first.
- A **persistent journal**: `journalctl --user` reads nothing on a volatile one (`Storage=volatile`, or `auto` without `/var/log/journal`, the default on RHEL-family hosts and Raspberry Pi OS). Without it pap cannot confirm its start and the install ends with exit code 3. The fix is yours to make: `sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`.
- Linger (`loginctl show-user $UID --property=Linger`). The installer runs `loginctl enable-linger` itself (15 s cap, no sudo). When polkit refuses it prints `pap: warning: linger is off ... run: loginctl enable-linger <you>` and goes on: pap then stops at logout and worker scopes are unavailable.
- Method 1 only: Node 24.14 or newer 24.x, `pnpm` (or `corepack`), `gcc`, `g++`, `make`, `python3` (node-pty compiles at install), network access to the registry once. Method 2 needs none of these (it carries its own Node), only GNU `tar`, `sha256sum`, `awk`, `sort`, `getconf`, `systemctl`, `cp`, `find`, `readlink` (checked up front) and `cut`, `head`, `mktemp`, `mv`, `ln` (coreutils, not checked up front).
- **bubblewrap** (`/usr/bin/bwrap`, owned by root). Agents that require the sandbox do not start without it. Both installers only warn, they never install it:
  `pap-install: warning: bubblewrap not found: agents that require the sandbox will not start (sudo apt install bubblewrap)`.
  On recent Ubuntu the AppArmor profile for unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns`) can also block bwrap: Settings > Agents is the probe. For a non-standard bwrap path run `systemctl --user edit pap` and add `[Service]` then `Environment=PAP_BWRAP=/path/to/bwrap` (the unit never sets it).
- The unit's `PATH` starts with the directory of the Node binary. When that is under your home it is hidden inside agent sandboxes: agent shells have no `node` unless it is installed system-wide.

## Method 1: from a git checkout

```
git clone <your pap repository> pap && cd pap
scripts/install.sh                     # optional: --port 7791 --home ~/.pap-try --bin-dir ~/.pap-try/bin
```

It checks (before any build): not root, Linux, checkout shape, Node, tools, user manager, bubblewrap; then `pnpm install --frozen-lockfile`, `pnpm build`, and runs `pap service install --node <real node binary> --main <checkout>/apps/daemon/dist/main.js` with your remaining arguments. `node` is resolved with `node -p process.execPath` (a volta or asdf shim is not a binary).

The service **runs from the checkout**: a `git pull`, a rebuild or a delete changes (or breaks) the running code with no integrity check: the daemon itself at its next restart, but newly forked workers and the served web files at once (a rebuild empties `apps/web/dist`). A rebuild that fails during a reinstall therefore leaves the running service without them. Use method 2 for a host that should not depend on a checkout.

## Method 2: offline archive with a pinned checksum

On the build host (the OLDEST glibc you target; the installer refuses an older glibc):

```
pnpm install && pnpm build && pnpm build:archive      # --out <dir>, --allow-dirty
# archive:   <repo>/.pap-archive/pap-<id>-linux-x64.tar.gz
# installer: <repo>/.pap-archive/pap-install-<id>.sh
# sha256:    <64 hex>
```

The id is `<version>-<git sha7>[-dirty]-<UTC yyyymmddHHMM>`. The archive carries the builder's Node binary (24.14+) and its LICENSE, the production dependencies with node-pty compiled, and `BUILD_INFO.json`. Beside the code (`app/`, the image's `/opt/pap`, the npm package root) every artefact ships `LICENSE` (AGPL-3.0-or-later), `THIRD_PARTY_NOTICES.md` and `LICENSES/Apache-2.0.txt`: the bundler strips the Apache header of the two derived `packages/ui` files from the web bundle, so the notices file and the licence text beside `dist` carry Apache-2.0 section 4. A repository without one of them is refused (`LICENCE_FILES` in `scripts/build-archive-stage.ts`). A dirty tree is refused without `--allow-dirty`. Build on the oldest target: run the three commands above inside a container or host with that glibc, Node 24.14+, pnpm, `gcc`, `g++`, `make` and `python3`. `scripts/build-archive-podman.sh` does it in a container (see "Build the archive on an older host").

Copy the `.tar.gz` and the `.sh` to the target (the `.sh` through a channel you trust, see below). The `.tar.gz.sha256` is informational: the installer checks the hash pinned inside the `.sh`, never that file. Then:

```
./pap-install-<id>.sh [--port N --home DIR --bin-dir DIR]
```

Order: refuse root, platform and an unsafe `HOME`; tools, user manager, glibc, bubblewrap; copy the archive once into a private 0700 stage folder and hash, list and extract that copy only; switch `current`; run `pap service install`; prune old releases last. On a failed `service install` the previous release is put back and the service restarted on it.

### What the checksum proves

The installer embeds the SHA-256 of the archive. It proves **the archive matches the checksum pinned in this script**: corruption and tampering in transit, if the script itself came over a trusted channel (copy it from the build host yourself). It proves nothing about a compromised build host, and nothing if the script and the archive travel together over an untrusted channel. Signing and an SBOM come after v1 (ADR 0066).

## Expected output

A first install prints (values are examples):

```
service installed: /home/<you>/.config/systemd/user/pap.service
listening on http://localhost:7777 (this machine only)
setup (one time, open it in your browser): http://localhost:7777/setup#token=<token>
the one-time setup URL also stays in your user journal until it is used
remote host: ssh -L 7777:localhost:7777 <you>@<host>, then open http://localhost:7777
data stays in ~/.pap; uninstall with: pap service uninstall (your data is not deleted)
`pap` command: /home/<you>/.local/bin/pap
/home/<you>/.local/bin is not on your PATH; use the full path above or add it yourself (this installer edits no shell file)
```

The token is a URL fragment (`#token=`), which the browser never sends to the server. When an owner already exists the setup line becomes `an owner already exists: open http://localhost:7777 (see also: pap service url)`. On a reinstall of a running service the last line is `pap was running and has been restarted; running turns were interrupted`.

The command only reports success after the daemon's own `listening` journal line (up to about 20 s). Without it: `pap did not start listening; see: journalctl --user -u pap -n 30`, exit 1, no URL printed. A first install that never listens also disables the unit and prints what is left behind with the exact undo commands (a reinstall keeps the unit and restarts as before). When the journal shows nothing at all for `pap.service` (volatile journal): `installed, but the user journal is not readable ...`, **exit code 3** (distinct from 1), because pap may well be running. The archive installer then keeps the new release, does not roll back, prints `installed but NOT verified` and exits 3 as well (W5-R22), so a script never reads an unverified install as success. Exit 3 means installed and not verified because the journal is unreadable; check with `systemctl --user status pap`.

## Layout

| Path | What |
|---|---|
| `~/.config/systemd/user/pap.service` | the unit (0644, no secret) |
| `~/.local/bin/pap` | launcher (0755), a fixed `sh` script that `exec`s the installed node and main with `"$@"` and sets `PAP_HOME` when `--home` was given |
| `~/.local/share/pap/releases/<id>/` | method 2 only: `node/`, `app/`, `BUILD_INFO.json` (0700 parent) |
| `~/.local/share/pap/current` | method 2 only: symlink to the active release |
| `~/.local/share/pap/downloads/dl.XXXXXX/` | `pap update install --yes` only: the downloaded installer and archive (0700), removed when the command ends; a kill leaves one behind, delete it |
| `~/.pap/update/` | `op.lock`, `pending.json` (an update in flight), `last-backup.json`, `last-check.json` (0700 folder, 0600 files); never touched by install, uninstall or prune |
| `~/.pap/backups/` | `pap-backup-*`, `pre-update-*.db` (the three newest kept), `pre-restore-*` (kept for ever): data the owner may delete, nothing prunes the rest |
| `~/.pap` (or `--home`) | your data: never touched by install, uninstall or prune |

The launcher does not edit `PATH`. If `~/.local/bin` is not on it, use the printed full path or add the directory yourself. A foreign file or symlink at `~/.local/bin/pap` is never overwritten: a warning names it and prints the command to run pap by hand.

## Reinstall and update

Run the installer again (method 2: with the new archive and script). The service is **restarted**, so:

- interrupted: running agent turns; with M11, running agent runs, pending agent and secret requests (expired), "use once" values (dropped) and subagent rows (marked `interrupted`);
- kept: `~/.pap` (sessions, database, secrets) and the previous release (the rollback target; older ones are pruned).

A failed second install leaves the first in `current` and restarts it (method 2).

From M6b, running the installer of a different release **with no flags** over an installed pap is an update with automatic rollback: it calls `pap update apply` of the new release (`update.md`: the transaction, the exit codes, `pap update recover`). With flags it is the M6 reinstall above, with no rollback and no database check. `pap update install` downloads the installer and the archive from the feed and runs it. Back up first if the data matters: `pap backup` (`backup.md`).

Re-running the installer of the release that is already installed, with **no flags** and a unit present, only restarts the unit ("already installed; restarted"): it never rewrites the unit, so a service started with `--port` or `--home` keeps them. A reinstall that fails restores the previous unit file byte-identical, reloads systemd and restarts; the launcher and a symlinked unit are restored too (the launcher with its mode, or removed when there was none; the unit as a symlink to the same target).

Repeat the original `--home`, `--port` and `--bin-dir` flags on every reinstall: nothing remembers them, and without them the service moves to `~/.pap` on 7777 with a fresh setup URL. The unit ignores an exported `PAP_HOME` (the installer warns when it is set without `--home`); only `--home` is written into it.

## Setup URL and the journal

The service prints the one-time setup URL to its journal; `pap service install` and `pap service url` read it from there (`journalctl --user -u pap`), and only its last 200 lines. **The one-time token sits in the persistent user journal until used**, readable by members of `adm` / `systemd-journal` and by the owner's own processes outside an agent sandbox (M11 hides `/var/log` and `/var/tmp` from agent shells). The setup lines are also copied to `/var/log/syslog` (readable by `adm`) when rsyslog forwards the journal. Once the owner exists the token is spent. On a shared host where the journal is persistent and group-readable, do not rely on it. Either read the URL from your own terminal:

1. `systemctl --user stop pap`
2. `~/.local/bin/pap serve` (add `--port N` if you installed with one; the launcher sets `PAP_HOME` when you installed with `--home`)
3. open the URL printed in that terminal (not the journal) and create the owner
4. Ctrl-C, then `systemctl --user start pap`

The unit stays stopped after a manual stop until you start it, and the token is new at each start. Or, where nobody else may see a token, create the owner without any URL: with the service stopped, `pap user add <name> --password-stdin` (`docs/agents/auth.md`). A journal-free URL file under `$PAP_HOME` is not implemented (a later owner decision).

`pap service url` prints the URL of the current start, or says an owner already exists, or `pap is not listening yet; see: journalctl --user -u pap -n 30`. Once the owner exists the URL is spent but is still printed until the next restart of the unit. On a stopped unit it can show the last run's URL.

## Remote access

pap binds loopback only; the unit never carries `--host`. From your laptop: `ssh -L 7777:localhost:7777 <you>@<host>`, then open `http://localhost:7777`. Plain HTTP on loopback is ADR 0004.

## Commands

```
pap service install [--node ABS] [--main ABS] [--port N] [--home ABS] [--bin-dir ABS]
pap service url
pap service uninstall [--bin-dir ABS]    # stops, disables, removes the unit and our launcher; keeps data and releases
```

They take no instance lock and never open `$PAP_HOME`, so they work while pap runs. The other commands: `pap backup`, `pap restore`, `pap update check|install|apply|rollback|recover`, `pap doctor`. Paths must be absolute with letters, digits and `. _ + @ / -` only (a space, quote or `%` would be split or expanded by systemd): the refusal names the flag.

## Troubleshooting

| Symptom | Meaning and fix |
|---|---|
| `no systemd user manager` | ssh without a session: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, or log in fully |
| `warning: linger is off` | polkit refused: run `loginctl enable-linger <you>`; until then pap stops at logout |
| `pap did not start listening; see: journalctl --user -u pap -n 30` | the daemon never bound: port taken (the journal shows `EADDRINUSE`; use `--port`), another pap holds the home, or a crash loop. systemd stops retrying after 5 starts in 120 s. It never means "owner already exists" |
| `an owner already exists` | the daemon listens and has no setup URL: open the address and sign in; lost passkey: `docs/agents/auth.md` (`pap passkey reset`, daemon stopped) |
| `installed, but the user journal is not readable` (exit 3), or `installed but NOT verified` from the archive installer | the journal is volatile, so pap's start could not be checked and pap may be running: `systemctl --user status pap`. Make the journal persistent (`sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`, your call) and run the installer again |
| a rerun within 2 minutes fails with `systemctl restart failed (exit 1)` | systemd's start limit (5 starts in 120 s) counts manual starts. The installer runs `systemctl --user reset-failed pap.service` before every restart; if you restart by hand after a failure run that first |
| no `listening` line though pap runs | `PAP_LOG_LEVEL=warn` (or higher) in the user manager's environment (`environment.d`) hides the `listening` line: unset it for the unit |
| journal unreadable (`pap is not listening yet`, empty output) | you are not in `systemd-journal`/`adm` and the user journal is not yours, or journald is volatile (see the persistent-journal prerequisite): run `journalctl --user -u pap` yourself; otherwise use the stop / `pap serve` / start procedure under "Setup URL and the journal" |
| `glibc X is older than Y` | archive built on a newer host: rebuild on the oldest target |
| `checksum mismatch: nothing was installed` | the archive is not the one this script pins: copy both again; nothing was extracted |
| `the archive holds a path or a link outside pap-<id>/ ...` | refused member (GNU tar is required to read the listing); nothing was extracted into place |
| `HOME holds a character that is not safe in a systemd unit` | method 2 is refused: it needs a plain `HOME`. Method 1 works only with a safe `--bin-dir` (the default `$HOME/.local/bin` is refused too), e.g. `scripts/install.sh --bin-dir /opt/pap-bin` where the checkout and node paths are safe as well |
| `--home must be an absolute path ...` | same rule for every path flag |
| `~/.local/bin/pap is not ours and was left alone` | a foreign file sits there: rename it or call pap with the printed command |
| `systemctl <verb> failed (exit N); see: ...` | raw stderr is never shown, read the journal |
| setup URL not found though pap runs | `pap service url` reads only the last 200 journal lines of the current start; a very chatty start can push the `setup_url` line out: restart the unit or use the stop / `pap serve` / start procedure |

## Notes and known edges

- A mistyped flag to `scripts/install.sh` is refused only after the build (it is forwarded to `pap service install`).
- Empty, `.` or relative entries in `PATH` are not refused; the installers never edit `PATH`.
- Installed release files lose their read-only modes (the folders are owner-only anyway).
- Unit hardening: `NoNewPrivileges`, `RestrictSUIDSGID`, `LockPersonality` only; the rest is deliberately absent so M11's sandbox can create user namespaces (ADR 0056).

## Container, npm, releases: what works now, what waits

The GitHub repository is public (since 2026-10-18); v1.0.0 is published by the release workflow (`docs/agents/release.md`). The workflow `ci.yml` runs on every pull request and every push to `main`, docs-only changes included; `release.yml` runs on a push to `main` and when started by hand (`workflow_dispatch`) since the v1 flip. Some pieces below need a published release to be used end to end.

| Piece | Works now from a local command | Waits for the v1 release |
|---|---|---|
| Backup, restore, doctor | all of it | nothing |
| `pap update install --from <dir>` | yes: runs the pinned installer from a folder, with rollback | nothing |
| `pap update install` (download) and `pap update check` | the code and its tests (fake fetch) | the feed URL answers only once a release is published |
| Archive, installer, feed files | `pnpm release:assets` builds them into `.pap-release/<tag>/` | uploading to a GitHub Release (the `gh` commands are printed, never run; the `stable` job of `release.yml` uploads the assets of a release it creates) |
| release-please | config files and `pnpm release:check` | the workflow runs on a push to `main` and on `workflow_dispatch`; the release PR needs the repository setting "Allow GitHub Actions to create and approve pull requests" (ADR 0066 item 5) |
| `curl` piped to `sh` | tested against a fake `curl` | needs a published release |
| npm package | `pnpm build:npm` and `npm pack` | `npm publish` (owner's account, the last v1 step, after the verified release) |
| OCI image | `scripts/pap-container.sh build` and `run` on a host with rootless podman (manual; built and run on 2026-10-17, see the real-host check above) | pushing to a registry |
| `next` channel | `release:assets --channel next` | the rolling `next` pre-release and its workflow job |

## Container

Image `localhost/pap:dev` (`PAP_IMAGE` overrides), wrappers in `scripts/pap-container.sh`: `build` (pins `node:24-bookworm-slim` by digest, labels the digest and the commit), `run [--port N] [--name NAME] [--project DIR]...`, `url [--name NAME]`, `stop [--name NAME]`. `pnpm build:image` is `build`. The image holds the same staged tree as the archive (`scripts/stage-app.ts`), built in a first stage that never reaches the final image: no compiler, no pnpm, no registry credential (the staged tree keeps the allowlisted `/opt/pap/.npmrc` holding `engine-strict=true` only), no source. The build stage uses dedicated roots (`/pap-image-build`) that no pap source file contains, so the stage-path guard cannot match pap's own compiled code. `build` passes `--format docker` so the HEALTHCHECK is kept (podman's default OCI format drops it). apt packages float, so the image is not byte-reproducible.

The image runs only under rootless podman. The sandbox for agents needs `--security-opt systempaths=unconfined`, which unmasks `/proc` and `/sys` paths for the whole container. S8 measured, for a non-root user without capabilities, read access to `/proc/interrupts`, `/proc/keys`, `/proc/latency_stats` and listings of `/proc/acpi`, `/proc/scsi`, `/sys/firmware`, and no write access; as container root `/sys/fs/cgroup` becomes writable, so the image runs as uid 10001 with every capability dropped. Rootful Docker was not measured and is not supported. The wrapper refuses root, a podman that is not rootless, `PAP_CONTAINER_RUNTIME` other than `podman`, and has no `--privileged` or `--cap-add`.

- Option set (exactly): `--user 10001:10001 --userns=keep-id:uid=10001,gid=10001 --cap-drop ALL --security-opt no-new-privileges --security-opt systempaths=unconfined`, published on `127.0.0.1:<port>` only (ADR 0004's loopback cookie rule: the browser sees `localhost`; remote use is `ssh -L` or an HTTPS front).
- `keep-id` maps your host uid onto 10001, so a `--project DIR` (mounted at `/work/<name>`, read-write) is writable by the container user. Without it the folder shows as `root:root 755` inside. Only absolute folders with letters, digits and `. _ + @ / -` are accepted; the path is canonicalised (`cd -P`), a `.` or `..` part is refused, and so are `/`, your home folder and its parents (under keep-id they would make your whole home writable as you). The mount is read-write, so a git hook written to a project folder by an agent runs on the host the next time you use git there. `run` replaces a container of the same name and, like `stop`, grants it 40 s to stop.
- Data: the named volume `pap-data` at `/home/pap` holds `~/.pap` and `~/.pi`, including `secrets/` (vault key, `secrets/push/`). Back it up as a whole (`podman volume export pap-data`); it holds the vault key.
- SELinux hosts were not measured (S8) and project mounts carry no `:z`; on such a host a mount can be denied.
- Every start logs `plain_http_on_network`: expected, the container binds `0.0.0.0` inside and only the loopback publish is reachable.
- Push notifications need outbound HTTPS and DNS from the container (podman's default network gives both) and that same volume.
- `PAP_WORKER_SCOPE=off` in the image (no user manager inside). The container binds `0.0.0.0:7777` inside; only the published address is reachable from the host.
- Fail closed: without the `systempaths` flag bubblewrap cannot run. The entrypoint logs one `container_sandbox_unavailable` warning, the daemon still serves, and agents that require the sandbox refuse with `sandbox_unavailable`. Check with `podman exec pap node /opt/pap/apps/daemon/dist/main.js doctor --only bwrap`.
- First start: `scripts/pap-container.sh run`, then `scripts/pap-container.sh url` prints the setup URL (only a `http://localhost:<port>/setup#token=...` line is ever printed).

## Build the archive on an older host

`scripts/build-archive-podman.sh --node-tarball <node-v24.x-linux-x64.tar.xz> [--image ubuntu:22.04] [--out DIR]` runs `pnpm install --frozen-lockfile && pnpm build && pnpm build:archive --allow-dirty` inside the image, so the archive's glibc floor is the image's. A manual step with network inside the container (apt, pnpm). Differences from a plain bind mount, on purpose: the checkout is mounted read-only and copied inside (your `node_modules` and `dist` are never replaced by container-built ones), and only the archive folder (`.pap-archive/` by default) is written out. The Node tarball is yours to download and verify: the archive embeds the node that built it. It needs a normal clone (a `.git` folder): a linked worktree is refused before anything runs. The recipe runs with its own `HOME=/pap-archive-build` and copies the checkout under it, for the same stage-path reason as the image. `ubuntu:22.04` is not pinned by default (no digest known offline): pass `--image-digest sha256:<64 hex>` to pin it.

## npm

`pnpm build && pnpm build:npm [--out <dir>] [--name @soulkyu/pi-agentic-platform]` writes `<out>/package/` (default `.pap-npm/package/`); `(cd .pap-npm/package && npm pack)` makes the tarball. Nothing is published from this host: `npm publish` is the owner's last v1 step, after the GitHub release is verified (`docs/agents/release.md` step 7, q15), and the package already carries its `npm-shrinkwrap.json` (see below). No `--provenance` before v1.

- The package holds `apps/daemon/dist`, `apps/web/dist` and `node_modules/@pap/{contracts,pi-host}` (`package.json` and `dist` only; `bundleDependencies`). `bin` is `pap` -> `./apps/daemon/dist/main.js` (shebang kept, mode 0755), `engines.node` is `>=24.14 <25`, no `scripts`. Every other dependency is the exact version the lockfile uses (`catalog:` resolved by the builder). `@pap/contracts` and `@pap/pi-host` are also listed in `dependencies` at their own version: npm bundles a package only when it is listed there (measured), and the bundled copy satisfies it, so no registry request is made for them, but only while those copies are in the tarball: the builder refuses a missing copy or a version that differs from `dependencies`, and a publish must carry an `npm-shrinkwrap.json` that marks both entries `inBundle` (otherwise a missing copy would resolve `@pap/contracts@0.0.0` from the registry by name). The builder also refuses a `.gitignore` or `.npmignore` anywhere in the package (it would change what `npm pack` ships). Licence field: the root `package.json` `license` (`UNLICENSED` when it has none); an `AGPL-3.0-*` id also needs a `LICENSE` file at the repository root, which the builder copies into the package and refuses to build without.
- Before the first publish, the owner confirms or reserves the `@soulkyu` scope on npmjs (the published name), and checks who owns `@pap` there: the shrinkwrap above is what keeps an install from ever asking the registry for `@pap/contracts` or `@pap/pi-host`.
- Never in the package: any `.npmrc`, test files, source maps, `src/`, a credential, the builder's paths. The builder refuses (naming the file, never the value) a `.npmrc`, a `package.json` that looks like it holds a token, and a file that names the output folder or the builder's home. The output folder is built aside and moved into place only when the scans pass.
- Measured on this build (Appendix A, run 2): tarball about 3 MB; `npm pack` accepts the layout. A first `npm install -g` of that tarball showed three builder defects, now fixed and checked by tests: (1) the bundled copies of `@pap/contracts` and `@pap/pi-host` must carry **no** `dependencies` (npm treats every dependency of a bundled package as part of the bundle and installed 117 empty folders); the root `dependencies` lists them all and the builder refuses a missing or different version; (2) `apps/daemon/package.json` ships (the version lookup reads it); (3) every `@earendil-works/*` package of the lockfile is listed in the root `dependencies` at the lockfile's exact version (Pi SDK 1.1.0 declares its siblings as `^1.1.0`, and npm took 1.3.0, which broke it). After these three, the controller measured an install into a temporary prefix, a boot, the helper op and the session worker start. Every other transitive dependency floated to the newest match until the shrinkwrap below.
- **Shrinkwrap (M13, B6).** `npm-shrinkwrap.json` (npm lockfile v3) is written into the package by `pnpm build:npm`, offline, from `pnpm-lock.yaml` (`scripts/npm-shrinkwrap.ts`): the production closure of `apps/daemon`, `packages/contracts` and `packages/pi-host`, so an install gets exactly the versions CI tested. Every entry copies `version` and `integrity` from the lockfile (never recomputed) and gets the registry URL `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz`; a git, tarball or directory resolution makes the builder refuse. Peer suffixes of pnpm snapshots are stripped (one package per version). Hoisting: each root `dependencies` pin sits at the top level at exactly that version (the daemon's own `require("yaml")` resolves its pin even where the repository's dev tree has another), every other name goes to the top at the version most dependents use (ties: the highest), the others nest under their dependent. An entry reachable only through `optionalDependencies` is `optional: true` and platform packages keep `os`, `cpu` and `libc`, so npm skips a non-matching one. `@pap/contracts` and `@pap/pi-host` are `inBundle` with no registry fetch. Not carried: `bin` of dependencies (npm's installer reads `bin` from the lockfile entry, so no dependency `.bin` link is created; pap runs none of them, and the `pap` command comes from the package's own `bin`) and `hasInstallScript`, which pnpm does not record: it is taken from `onlyBuiltDependencies` in `pnpm-workspace.yaml` (today `node-pty` only). The builder re-reads the result against the lockfile (`verifyShrinkwrap`) and throws on any difference; `pnpm release:check` does the same on `.pap-npm/package` when it exists (a package without the file, an entry that differs, a root `dependencies` list that differs from `package.json`, any other field that differs from a shrinkwrap regenerated from the lockfile). The builder refuses a lockfile whose snapshots of one package have different stripped dependencies (diverging peer variants): one npm entry cannot stand for both. Do not edit the file by hand: change the lockfile and rebuild. The controller checks once, with the network (step CB6), in a scratch copy: `npm install --package-lock-only --ignore-scripts`, `npm ci --dry-run --ignore-scripts` and `npm ls --omit=dev`; npm rewrites the file (adds `engines`, `license`, `funding`, `bin`, flags), so the criterion is the same `(path, version, resolved, integrity)` tuples, `npm ci --dry-run` exit 0 and no `invalid`, `missing` or `extraneous` in `npm ls`, not a byte diff.
- `npm install -g` compiles node-pty on the target: gcc, g++, make and python3 are needed, and `--ignore-scripts` breaks it. The npm channel updates with `npm install -g`; `pap update install` prints that command and exits 1.

## Releases and channels

The release steps are local commands plus a workflow that runs on a push to `main` or when you start it (`workflow_dispatch`). A running pap contacts GitHub once a day for the release feed (the daily check, on by default; `PAP_UPDATE_CHECK=0` turns it off); tests never do.

- `pnpm release:assets [--channel stable|next] [--tag vX.Y.Z] [--run-number N]` runs `build:archive` into `.pap-release/<tag>/` (the tree must be clean, the folder empty), then writes `pap-feed-<channel>.json` and `.env` next to the archive, its `.sha256` and the installer. It prints the `gh release create` and `gh release upload --clobber` commands and runs neither. `--tag` defaults to `v<root version>`; `next` always uses the tag `next`, and its version is `<root version>-next.<run number>` (run number 0 when you give none).
- The feed generator (`node scripts/release-feed.ts --dir D --channel C --tag T --out D [--repo R] [--node-min 24.14]`) checks the JSON against the same `FeedSchema` `pap update` uses before it writes anything, takes the installer SHA-256 and both sizes from the files, and refuses an archive whose name does not match the installer's release id, a `--repo` with a space or `..`, and an output file that exists (`--force` overrides). The `.env` file has seven `KEY=value` lines (`VERSION`, `RELEASE_ID`, `INSTALLER_NAME`, `INSTALLER_URL`, `INSTALLER_SHA256`, `ARCHIVE_NAME`, `ARCHIVE_URL`) for `get-pap.sh`, which never `source`s it; `scripts/fixtures/feed-stable.env` is the pinned example.
- Channels: `stable` is a `vX.Y.Z` release made by release-please, with the stable feed attached to every one; `releases/latest/download/` serves the newest. `next` is one rolling pre-release with the fixed tag `next`, assets replaced with `--clobber`. The feed names the hosts it trusts and does not sign anything: it detects corruption and a swapped asset, not a compromised GitHub account (M6bR35).
- Version source: the root `package.json` `version`, mirrored into `apps/daemon/package.json` by release-please (`extra-files`) and held in `.release-please-manifest.json`. `pnpm release:check` fails, naming the file, when the three differ, when `release-please-config.json` differs from the pinned one, or when `.github/workflows/release.yml` has any trigger but `workflow_dispatch` (the shape after the v1 flip, `push: branches: [main]` next to it, is also accepted), an action not pinned by a 40-hex commit, a checkout that keeps credentials, wider top-level permissions than `contents: read`, a secret other than `GITHUB_TOKEN`, a job whose `if` is not exactly the pinned string of its shape (it always starts with `github.ref == 'refs/heads/main' &&`: a dispatch from any other branch runs nothing), or a job that holds `contents: write` without passing `cache: "false"` to the setup action. It also checks the licence: `UNLICENSED` with no `LICENSE` file, or an `AGPL-3.0-only` / `AGPL-3.0-or-later` id with a `LICENSE` file and `LICENSES/Apache-2.0.txt`. The `next` job also needs a `concurrency` group. `release:assets` refuses a stable `--tag` that is not `v<root version>`. `Release-As: 1.0.0` in a commit footer makes the first v1 release.
- The workflow runs on a push to `main` and on `workflow_dispatch` (input `channel`): `stable` runs on both, `next` only on a dispatch. Its `stable` job needs `contents`, `pull-requests` and `issues` write because release-please opens and labels the release pull request; the `next` job needs `contents: write` only. The v1 flip (`scripts/release-flip.ts`, ADR 0066 and 0076) added `push: branches: [main]` to `on:` and let `stable` run on that push. Action pins: `actions/checkout` v7.0.1 and `googleapis/release-please-action` v5.0.0, resolved with `gh api` on 2026-10-17.
- The repository setting "Allow GitHub Actions to create and approve pull requests" is on (release-please opens the release PR, ADR 0066 item 5); align `actions/checkout` between `ci.yml` (v5) and `release.yml` (v7.0.1) when the two are next touched. `release:check` also pins each job's `permissions` to the exact set above and refuses `secrets` in any form but `secrets.GITHUB_TOKEN` and an expression of `github.event`, `github.head_ref` or `inputs` inside a `run:` script. `cancel-in-progress: false` on the `next` group is set in the workflow; the check does not pin it. The `next` job creates the pre-release with `--target $GITHUB_SHA` when it is missing and does not move the `next` tag afterwards: the tag keeps the commit of its first run, and the feed carries the real version.

## One-line install, once a release is published

`curl | sh` runs a script you have not read. Read it first (it is 73 lines) or download it, read it, then run it. The script and the files it fetches all come from github.com: that catches a damaged or half-replaced download, not a compromised GitHub account or release. Pin the script to a tag, as in the example. Release signing comes after v1.

```sh
# one line (replace <tag> with a release tag such as v1.0.0)
curl -fsSL https://raw.githubusercontent.com/SoulKyu/pi-agentic-platform/<tag>/scripts/get-pap.sh | sh -s -- stable
# two steps: download, read, run
curl -fsSL -o get-pap.sh https://raw.githubusercontent.com/SoulKyu/pi-agentic-platform/<tag>/scripts/get-pap.sh
less get-pap.sh && sh get-pap.sh stable -- --port 7791
```

It needs a published release: without one the feed URL answers 404 and the script stops with `download failed`.

- Usage: `sh get-pap.sh [stable|next] [-- <pap-install flags>]`. Flags after `--` go to the installer unchanged; with none, a plain rerun is the safe update of M6bR11. Exit code: the installer's (0, 1, 3, 4, 5), or 1 when the script refuses.
- What it does: downloads the channel's `.env` feed (`releases/latest/download/pap-feed-stable.env`, or `releases/download/next/pap-feed-next.env`), checks each of its seven lines against a fixed shape (the file is data, never `source`d; an extra, missing or malformed line stops it), downloads the installer, compares its SHA-256 with the feed's and only then downloads the archive and runs the installer with `bash` and standard input from `/dev/null`. The installer checks the archive against its own pinned hash (ADR 0057). All downloads are `https` only, redirects stay `https`, with a byte and time cap; the work folder (a `mktemp -d` under `$TMPDIR`) is removed on exit.
- Refuses: root, anything but linux-x64, a missing `curl`, `sha256sum`, `bash` or `mktemp`, an unknown channel, and a feed URL outside `https://github.com/<repo>/releases/download/`. `PAP_GET_REPO=owner/name` points it at a fork or mirror (validated, no `..`).
- The whole body is one function called on the last line, so a download cut at a line boundary runs nothing. Tests: `scripts/get-pap.test.ts` against a fake `curl`: they pin the flags the script passes, not what a real `curl` enforces with them. `--max-filesize` is a no-op when the server sends no `Content-Length`; the installer's SHA-256 check is what makes that safe. The trap on `EXIT HUP INT TERM` removes the work folder; the signal forms do not exit, so the shell goes on. The stable feed comes from `releases/latest/download/`, not from the pinned script tag: the script and the release it installs are not the same version by design.

## Agent VMs: `sudo pap vm setup --user <name>`

Topic note: `agents-vm.md` (ADR 0078). Installs the root-owned stack the agent VMs run on, from pinned release artefacts (SHA-256 in `vm-assets.json`; a mismatch stops before anything is installed). Needs root, `tar` with zstd and xz, and `systemd`. `--user` is the user that runs pap (R36); `--home <abs>` overrides `$PAP_HOME` (default: the `PAP_HOME` of the user's `pap.service` in `<home>/.config/systemd/user/` when it sets one, else `<home>/.pap`); `--assets <file>` reads a release's `vm-assets.json` and may replace only the pap-vmd and agent-bundle entries (the compiled copy holds placeholders for those two, which setup refuses); the file must be a regular file owned by root, not writable by group or others, and not a link, and setup prints every override it accepts (name, version, URL, SHA-256) before installing. Any other differing entry is refused.

- Layout: `/opt/pap-vm/{bin,libexec/cni,node,vmd,agent-bundle}` (pap-vmd: `/opt/pap-vm/vmd/dist/main.js`; nerdctl-full's `bin/*` and `libexec/cni` are installed into `bin/` and `libexec/cni`, next to the `containerd-shim-kata-clh-v2` wrapper), Kata at `/opt/kata` (both refused when they exist without pap's `.pap-vm-setup` marker), configs in `/etc/pap-vm/` (`config.json` `{ papUid, papGid, papHome }`, `containerd.toml`, `buildkitd.toml`, `/etc/pap-vm/agents.nft`, `cni/pap-agents.conflist`), units `pap-vm-containerd`, `pap-vm-buildkit` and `pap-vmd` in `/etc/systemd/system`, state in `/var/lib/pap-vm`.
- The one host-global file: `/etc/kata-containers/runtime-rs/configuration.toml`, whose first line is `# written by pap vm setup`; setup refuses to overwrite a file or link without that line and uninstall removes it only while it still has it. Never touched: `/etc/cni/net.d`, the system containerd, another owner's Kata files.
- A run that changed something restarts the three units and says so: running agent VMs may be stopped. Installed files are made root-owned, without setuid, setgid or group/other write bits. `--dev-from-tree` deploys pap-vmd with the release step's `pnpm deploy` (dependencies included, run as root from the checkout) instead of copying `apps/vmd/dist`.
- Needs `/dev/kvm` (`pap doctor` says `vm.kvm`). On a virtual machine the host must expose nested virtualization to it (Hyper-V: `Set-VMProcessor -VMName <vm> -ExposeVirtualizationExtensions $true`, with the VM stopped).
- A second run changes nothing (every write compares first). When `ufw` or `firewalld` is active setup prints the rule that lets the VMs reach ports 7841 and 7842 on `pap0`.
- **Run setup from code root owns (RT-22).** `sudo pap vm setup` runs pap's own program, its pins (`vm-assets.json`) and the running Node as root. Without `--dev-from-tree` it refuses unless its entry file and folder, `vm-assets.json` and the Node binary are owned by root and not writable by group or others (the rule `--assets` applies to its file), and tells you to run it from a release archive unpacked as root. A pap installed under your own home (method 1 or 2) is user-writable, so unpack the release archive as root somewhere root-owned and run setup from there; the residual of a compromised pap user becoming root at the next setup is closed only that way. Every folder above those files, up to `/`, must be root-owned and not group- or other-writable too (an unpack made as root inside your own folder is refused). `sudo pap vm uninstall` also runs pap's program as root with the same exposure, and the code does not check it: apply the same rule and run it from the same root-owned copy. `--dev-from-tree` skips the check and is exactly that residual.
- `--dev-from-tree` (tests, CI, a try from a checkout) copies the built `apps/vmd/dist`, contracts' `dist`, the checkout's `dist-agent` and the running Node instead of the pap-vmd, Node and bundle artefacts, and prints "Code your user can change will run as root (testing only)."
- x86_64 only (the pinned artefacts are amd64). `pap update` does not update pap-vmd: after an update `pap doctor` fails `vm.vmd` until you run `sudo pap vm setup` again, and agent launches are refused meanwhile. Then set `PAP_AGENTS_RUNTIME=vm` in the unit and restart pap.
- Existing host-mode agents are not migrated: delete them and create them again in VM mode.
- Kata tests, locally only (no CI job): with setup done and `/dev/kvm` usable by your user, `CI=1 pnpm vitest run --project kata`. Without `CI=1` they skip with one warning when `/dev/kvm` or `/run/pap-vm/vmd.sock` is missing.
- `sudo pap vm uninstall [--purge]` reverts exactly what setup wrote and keeps `/var/lib/pap-vm` (the VM disks) unless `--purge`.
- Release: `pnpm release:assets` also builds `pap-vmd-<version>.tar.gz` and `pap-agent-bundle-<version>.tar.gz` (same offline `pnpm deploy` as the agent bundle) and writes both hashes into the release's `vm-assets.json`.

## Uninstall

`pap service uninstall` (also through `~/.local/bin/pap`). Method 2 releases stay under `~/.local/share/pap`: `rm -rf ~/.local/share/pap` when you want them gone. Your data stays in `~/.pap` until you delete it.

## After v1

A signature over the feed and the installer, an SBOM and a provenance attestation (ADR 0066), the v1 flip (workflow `push` trigger, the daily update check on by default, `npm publish`), a stricter unit, a 0600 setup-URL file if the journal proves unusable, pruning of `backups/pre-restore-*`.
