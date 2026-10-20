# pap doctor

`pap doctor [--json] [--only id[,id...]] [--unit <name>] [--home <abs dir>]` reads the machine and the install and says what is wrong, with the command that fixes it. It works while pap runs and never needs it stopped.

Decisions: ADR 0067; rulings M6bR24 to M6bR28 in `docs/research/m6b-rulings.md`. The daily update check is in `update.md`. Inside the container image the entrypoint runs `pap doctor --only bwrap` at start (ADR 0065).

## Read-only

- It creates and changes nothing (the only exception is the `bwrap` probe's temporary folder, below): no `mkdir`, no `writeFile`, no lock taken, no `-wal` or `-shm` next to `state.db`. A home that does not exist is reported, not created.
- The child programs are `systemctl --user` (`show`, `cat`, `is-*`, `show-environment`), `loginctl show-user` and `journalctl --user`, each with a timeout and an output cap, started with an argument list; and, for `bwrap`, the sandbox probe starts bubblewrap itself (5 s limit, below).
- A check that throws is a `fail` ("the check could not run", fix "report this") and the others still run. A check that does not answer in 10 s is a `warn` ("timed out"); the timer reports it, it does not cancel a synchronous `statfs` on a hung mount, so `disk` on a hung mount can hold the command until the mount answers.
- No message carries a child's raw error text, and the output carries no control character.

## Which unit, which home

- Unit: `--unit`, else `PAP_UNIT`, else `pap.service`.
- Home: `--home`, else the installed unit's `PAP_HOME`, else a `PAP_HOME` of this shell, else `~/.pap`. The first lines of the text output say which (`home: <path> (from the unit)`). A `PAP_HOME` in this shell that differs from the unit's is an `info`: pap commands follow the unit's home.
- Backup and restore use another order (an explicit `PAP_HOME` of the shell first) and refuse when it disagrees with the unit; doctor only looks, so it follows the unit.

## Output and exit codes

- Text: one line per check, `[status] id detail`, then `  fix: ...` under a result that has one (not under `ok` or `skip`). `--json` prints one object `{ "exit": n, "results": [{ "id", "title", "status", "detail", "fix"? }] }`.
- Statuses: `ok`, `info` (advisory, counts as ok), `warn`, `fail`, `skip` (does not apply here).
- Exit: 0 only `ok`, `info` and `skip`; 1 at least one `fail`; 2 warnings and no `fail`; 64 usage (an unknown `--only` id lists the known ones). A healthy default install exits 0.

## System checks

Inside a container (`/run/.containerenv` or `/.dockerenv` exists) `user_manager`, `linger` and `journal` are `skip`.

| id | what it looks at | `fail` | `warn` | `info` |
|---|---|---|---|---|
| `node` | the Node version | below 24.14 | Node 25 and above (pap is tested on Node 24) | |
| `toolchain` | `gcc g++ make python3` on the absolute entries of `PATH` | | | missing ones: only needed for method 1 and `npm install` |
| `user_manager` | `systemctl --user show-environment` | the user manager does not answer | | |
| `linger` | `loginctl show-user <uid>` | | linger off: pap stops at logout | |
| `journal` | `/var/log/journal` or `Storage=persistent` in `journald.conf` / `journald.conf.d/*.conf`; with the unit active, any journal line since its start | | volatile storage; the unit is active and the journal holds no line (`pap service install` and `pap update apply` cannot verify a start, exit 3); the journal of the unit cannot be read (its own message, `journalctl --user -u <unit> -n 5`) | |
| `disk` | free space of the disk holding the home against `PAP_MIN_FREE_DISK_MB` (the unit's value when a unit exists; default 1024; 0 = `skip`) | below the floor | below three times the floor, or unreadable | |
| `home` | owner, mode of the folder (0700) and of `state.db` (0600), by `stat` only | not a folder, or not owned by the user | more open than 0700 / 0600 ("tightened at the next start") | does not exist yet; `PAP_HOME` of the shell differs from the unit's |

The `journal` check never prints a journal line (the first start writes a one-time setup URL there).

## Daemon checks

They read the home, never write it. The order of the whole list is the order of the output: the seven system checks, then `schema`, `update_pending`, `backup`, `bwrap`, `python3`, `update_available` (`https` and `push` sit between `backup` and `bwrap`, built from `pushReadiness` in `kernel/push-readiness.ts`).

| id | what it looks at | `fail` | `warn` | `info` |
|---|---|---|---|---|
| `schema` | `state.db` against this release's migrations (a read error such as `EACCES` is reported as damaged), opened without writing: a plain read-only open while the daemon runs, the `immutable` URI otherwise, not opened at all when a `-wal` is waiting. No `-wal` or `-shm` is ever created | written by a newer pap (opens read-only: update pap, or `pap restore <backup>`); damaged (`pap restore <backup>`) | | a write-ahead log from a crash is waiting (applied at the next start). Pending migrations are `ok`: a snapshot is taken first |
| `update_pending` | `update/pending.json` by `lstat` (existence, size, mtime; the content is not read) | the file exists: an update is running or was interrupted (`pap update recover`); or it is not a regular file or is above 64 KiB (damaged: the path; the fix lists it and the unit status, delete it only after both look right) | the folder cannot be inspected | |
| `backup` | `update/last-backup.json` as `pap backup` writes it (strict: `createdAt`, `file`, `encrypted`, `secrets` = `included` or `excluded`; a value with a character outside a plain charset reads as unreadable and is never shown) and the size of the `pap-backup-*` files in `$PAP_HOME/backups/`. Backups written with `--out` are not counted | | older than 30 days (compared in milliseconds); the record is unreadable | none made with `pap backup`; more than 2 GiB of backups (`pap backup --keep N`); the `backups/` folder cannot be read |
| `https` | `listenFacts` (below) through the push readiness function | | plain HTTP, or an origin that does not match | `http://localhost` works on this machine only |
| `push` | the same readiness, plus `secrets/push/vapid.json` by `lstat`: absent is ok (created at the first start); a regular file of mode 0600 in a folder of mode 0700, both owned by the user, is ok | | push is off (`keys_unreadable`, or the readiness above); never `fail` | localhost only |
| `bwrap` | the real sandbox probe (never a PATH scan) with `PAP_BWRAP` of the unit | | missing; not root-owned; the probe is refused (in a container: `--security-opt systempaths=unconfined`, `scripts/pap-container.sh run`; on Ubuntu `kernel.apparmor_restrict_unprivileged_userns`); no answer in 5 s | |
| `python3` | a root-owned `python3` in `/usr/bin`, `/usr/local/bin` or `/bin` (`trustedBinary`; it is not run) | | none: networked agents need it | |
| `update_available` | `update/last-check.json`, written by the daily check (on by default; `PAP_UPDATE_CHECK=0` turns it off) or with `PAP_UPDATE_CHECK=1`; no network call | | | |

`update_available` is `skip` when no check has run or the record is unreadable, `ok` otherwise ("<latest> is available on <channel>: pap update install" or "up to date").

## Agent VM checks

They apply only when the unit (else the shell) sets `PAP_AGENTS_RUNTIME=vm`; otherwise each is `skip` ("the agents run on the host"). They run last. The root-only facts (the ruleset, pap0, the state folder's free space) come from pap-vmd's `vmd.health`, because doctor runs as pap's user. When pap-vmd does not answer, `vm.vmd` fails and the checks that need it are `skip` ("pap-vmd does not answer"). The sentences of `vm.vmd`, `vm.stack` and `vm.network` are the ones `agents.vmStatus` returns, and a launch is refused `sandbox_unavailable` while one of them fails.

| id | what it looks at | `fail` | `warn` | `info` |
|---|---|---|---|---|
| `vm.kvm` | `/dev/kvm` exists | missing: enable nested virtualization on the host (`install.md`, Agent VMs) | | |
| `vm.vmd` | pap-vmd answers and its version equals pap's (R6) | no answer, or another version: `sudo pap vm setup` | | |
| `vm.stack` | pap-vmd has loaded pap's nftables table | not loaded: `sudo pap vm setup` | | |
| `vm.network` | the bridge `pap0` is up | down: `sudo pap vm setup` | | |
| `vm.images` | `image.list` holds a `pap-agent-base-` image | | the list could not be read | none built yet: the first agent start builds it |
| `vm.disk` | the state folder's free space against the agents' disks (4096 MB for a profile that names none) plus the kept mirrors (`agents/.mirrors/*/replaced`) plus `PAP_MIN_FREE_DISK_MB` | | less free space than that sum (disks are sparse: it is the worst case) | |
| `vm.listeners` | who holds the sockets on 10.213.0.1:7841 and :7842 (`/proc/net/tcp` and `tcp6`, then the fd tables of the user's processes): the relay's holder must be a child of the gateway's | held by a process that is not pap's (the daemon refuses launches too: `relay_listener_foreign`) | only the gateway listens, or pap runs and nothing listens | pap is not running |
| `vm.firewall` | `ufw` (`/etc/ufw/ufw.conf`) or `firewalld` (its pid file) is active | | active: it can drop ports 7841 and 7842 on `pap0` (the fix lists the allow rule) | |

`vm.listeners` is `info` (not a warning) while another daemon holds the home's lock and only your shell sets `PAP_AGENTS_RUNTIME=vm` (no unit says so: the preview server running beside a shell that forces vm mode, for one). With a unit that sets it, nothing on the sockets while pap runs is a warning, and it shows for a moment at boot before the relay binds: run doctor again. Topic note: `agents-vm.md`.

The `bwrap` probe starts bubblewrap, and makes and removes one temporary folder in `os.tmpdir()`; it is the only thing doctor creates, and nothing under the home.

`https` and `push` read where pap says it is reached from the unit (`listenFacts`): `PAP_PUBLIC_ORIGIN` of the unit's environment (the shell's only when no unit is installed), else `scheme://host:port` with `localhost` for a loopback or wildcard `--host`, the unit's port (7777 by default), `https` with `--tls-cert`, and `--insecure-http`. The fix names `docs/agents/notifications.md#https` and the routes in order: the ngrok origin, `tailscale serve`, a reverse proxy through `PAP_PUBLIC_ORIGIN`, then `--tls-cert`; each is printed once (`push` points at the anchor). When the unit is installed but pap cannot parse it (a hand-written `ExecStart`, for example with a relative main path), both lines are `info`: "cannot read the listen flags of <unit>", with the flags to check by hand; they never claim localhost.

## Adding a check

A check is `{ id, title, run(ctx) }` returning `{ status, detail, fix? }`, built from a probes factory of its own file (`makeSystemChecks`, `makeDaemonChecks`, `makeHttpsCheck`, `makePushCheck`: `DoctorContext` is frozen, so anything a test must replace goes in the probes) and listed in `apps/daemon/src/cli/doctor/registry.ts`, one line each. A row in the table above is required: `registry.test.ts` fails without it. It reads through the `DoctorContext` and writes nothing. Every `fix` is a command or a doc anchor, never prose alone.
