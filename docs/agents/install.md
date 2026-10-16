# Install (M6)

Linux with systemd only (method 1 runs on any architecture with Node 24 and the build tools; the method 2 archive is linux-x64 and glibc only). No sudo anywhere, nothing is written outside `$HOME` except where you point it (`XDG_CONFIG_HOME` when set outside `$HOME` moves the unit file; `--home` and `--bin-dir` take any safe absolute path), nothing is piped from the network into a shell. pap runs as a **systemd user service** (`pap.service`) bound to `localhost:7777`. Code: `apps/daemon/src/cli/service/`, `scripts/install.sh`, `scripts/build-archive*.ts`, `scripts/archive-install.sh.tpl`. Decisions: ADRs 0055 to 0057, rulings `docs/research/m6-rulings.md`.

Real-host check: not run before the merge (owner, 2026-10-16). CI, the smoke of the installed unit and the measurements above cover what is proven; a real `pap.service` under `NoNewPrivileges` with a worker scope, linger and the archive on a real host are checked in M6b.

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

The id is `<version>-<git sha7>[-dirty]-<UTC yyyymmddHHMM>`. The archive carries the builder's Node binary (24.14+) and its LICENSE, the production dependencies with node-pty compiled, and `BUILD_INFO.json`. A dirty tree is refused without `--allow-dirty`. Build on the oldest target: run the three commands above inside a container or host with that glibc, Node 24.14+, pnpm, `gcc`, `g++`, `make` and `python3`. No container wrapper ships (M6b).

Copy the `.tar.gz` and the `.sh` to the target (the `.sh` through a channel you trust, see below). The `.tar.gz.sha256` is informational: the installer checks the hash pinned inside the `.sh`, never that file. Then:

```
./pap-install-<id>.sh [--port N --home DIR --bin-dir DIR]
```

Order: refuse root, platform and an unsafe `HOME`; tools, user manager, glibc, bubblewrap; copy the archive once into a private 0700 stage folder and hash, list and extract that copy only; switch `current`; run `pap service install`; prune old releases last. On a failed `service install` the previous release is put back and the service restarted on it.

### What the checksum proves

The installer embeds the SHA-256 of the archive. It proves **the archive matches the checksum pinned in this script**: corruption and tampering in transit, if the script itself came over a trusted channel (copy it from the build host yourself). It proves nothing about a compromised build host, and nothing if the script and the archive travel together over an untrusted channel. Signing and an SBOM are M6b.

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
| `~/.pap` (or `--home`) | your data: never touched by install, uninstall or prune |

The launcher does not edit `PATH`. If `~/.local/bin` is not on it, use the printed full path or add the directory yourself. A foreign file or symlink at `~/.local/bin/pap` is never overwritten: a warning names it and prints the command to run pap by hand.

## Reinstall and update

Run the installer again (method 2: with the new archive and script). The service is **restarted**, so:

- interrupted: running agent turns; with M11, running agent runs, pending agent and secret requests (expired), "use once" values (dropped) and subagent rows (marked `interrupted`);
- kept: `~/.pap` (sessions, database, secrets) and the previous release (the rollback target; older ones are pruned).

A failed second install leaves the first in `current` and restarts it (method 2).

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

They take no instance lock and never open `$PAP_HOME`, so they work while pap runs. Paths must be absolute with letters, digits and `. _ + @ / -` only (a space, quote or `%` would be split or expanded by systemd): the refusal names the flag.

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

## Uninstall

`pap service uninstall` (also through `~/.local/bin/pap`). Method 2 releases stay under `~/.local/share/pap`: `rm -rf ~/.local/share/pap` when you want them gone. Your data stays in `~/.pap` until you delete it.

## Deferred to M6b

`curl | sh` (needs a public repository, published releases and a signature), OCI image, npm channel, archive signature and SBOM, a podman build wrapper, backups (`secrets/vault/key` handled separately), a stricter unit, a 0600 setup-URL file if the journal proves unusable.
