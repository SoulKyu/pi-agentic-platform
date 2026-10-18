# Update (archive installs)

Code: `apps/daemon/src/cli/update/`. Decisions: ADR 0064 (the transaction), 0066 (feed, channels), 0067 (the daily check); rulings M6bR10 to M6bR23, M6bR51 to M6bR53 in `docs/research/m6b-rulings.md`. Only archive installs (`~/.local/share/pap/{releases/<id>,current}`) have a previous release to go back to.

## The transaction (`apply.ts`)

```
preflight --refuse--> exit 1, nothing changed
   |
op.lock + pending.json (stopping) -> stop unit -> instance lock -> VACUUM INTO pre-update-<id>.db
   |                                                                  |
   |                                          pending.json names the snapshot, then:
   |                                          switch current -> release instance lock -> reset-failed -> restart
   |                                                                  |
   |                      wait: `listening` line + /healthz + settle window (unit active, NRestarts, /healthz)
   |                              | ok                                | failed or threw
   |                       pending.json removed, exit 0         rollback(): stop -> lock -> restore snapshot
   |                       (exit 3 when the journal was                  ONLY if a migration ran -> switch back
   |                        unreadable but everything else ok)           -> reset-failed -> restart -> wait
   |                                                                     exit 4 (ok) or 5 (pending.json kept)
```

### Locks

`update/op.lock` (`<pid> <process start time>`, created with `wx`) is held for the whole of `update apply|rollback|recover` and `pap restore`: two of them never interleave. After the stop the instance lock (`pap.lock`) is held through the snapshot, the database restore and the switch, so a daemon started by hand cannot write in between (a daemon started by hand before the lock makes `apply` write `pending.json`, stop the unit and exit 5 at the `lock` step: stop the hand-started daemon first, then run `pap update recover`). The instance lock covers the database and switch steps only, not `pending.json`, the unit stop or `op.lock`. A stale or recycled-pid lock is replaced; an empty lock file younger than 5 s is a holder that has not written its line yet and counts as busy. Two processes that judge the same stale file at the same instant: the removal only happens if the file still holds the text they judged, and the create uses `wx`, so only one gets the lock; the other exits 1 with `another pap update, rollback, recover or restore is starting`.

Order, fixed: preflight, write `update/pending.json`, stop the unit, take the instance lock, `VACUUM INTO backups/pre-update-<id>-<stamp>.db`, switch `current`, release the instance lock, `reset-failed`, restart, wait. The caller (`pap update apply|rollback|recover`) holds `update/op.lock` for the whole command.

- Preflight refuses before anything is touched: no `current`, `current` equal to the target, an incomplete target, a database that cannot be read, a database with a migration id the new release does not know (a downgrade), free disk below `2 x state.db + 64 MB`.
- "Failed" is any of: no `listening` journal line within the deadline; `/healthz` not answering; during the settle window the unit not `active`, `NRestarts` moved or `/healthz` failing; any step throwing.
- An unreadable journal is not a failure and not a free pass: `/healthz`, the settle window and the unit state are still required. Only when they all pass is the outcome `unverified` (exit 3, nothing rolled back). Otherwise the update rolls back.
- Every `restart` is directly preceded by `reset-failed` (the start limit counts manual starts).

## What an update interrupts

The service is **restarted**, so: running agent turns are interrupted; with M11, running agent runs, pending agent and secret requests (expired), "use once" values (dropped) and subagent rows (marked `interrupted`) are lost. Kept: `~/.pap` (sessions, database, secrets) and the previous release (the rollback target; older ones are pruned by the installer). The new release gets about 120 s to listen, then a settle window of 10 s; a crash in either ends in a rollback and the discard rule below.

## Workers and `KillMode` (M6bR53)

`systemctl stop` relies on the daemon's graceful stop (workers first). The unit has `KillMode=mixed`: systemd sends SIGTERM to the main process only, and after `TimeoutStopSec` it kills everything left in the unit's cgroup. Worker scopes (`systemd-run --user --scope`, with linger on) are separate cgroups and can outlive a forced stop; the next daemon sweeps them at boot (`scopes.sweep()`). The update does not hunt for them. The real-host check records what an older pap leaves behind (Appendix A, step 5).

## Downgrade to a release from before M6b

The installer run with no flags refuses it (the new release has no `update apply`, exit 1, `current` unmoved). With flags (`--port`, `--home`, `--bin-dir`) it takes the M6 path: it re-renders the unit and restarts. There is **no rollback and no database check** on that path, and a database a newer pap migrated opens read-only in the older one. Take a `pap backup` first.

## Rollback and the journal

`pending.json` (0600, folder 0700) is written with `fsync` (file and folder) at each step: `stopping` and `rolling_back` before the action they name (the stop), `switched` after `current` moved, `started` after the restart. The journal names the snapshot right after it is taken and BEFORE `current` moves, so a kill at any later point still finds it. It is removed only when an update or a rollback finished. A file that does not parse is `damaged`, reported and never ignored. A failed `fsync` of the folder after the journal was renamed into place is reported as a failed write although the file is there; `recover` reads it either way. The `started` write belongs to the `start` stage, so a failure of that write is reported as a failed start and rolled back.

`rollback()` never throws and is called once, after the `try`. It stops the unit, takes the instance lock, restores the snapshot only if a migration ran (the database holds an id `pending.schemaBefore` lacks, or fails `integrity_check`; a migrated database with no snapshot in the journal is `rollback_failed` / `database` with the fixed `code` "the journal names no snapshot: the database cannot be restored automatically", never `rolled_back`), switches `current` back, releases the lock, `reset-failed`, restarts and waits for `listening` again.

- No migration ran: the database stays as the new release wrote it; the old release reads the same schema.
- A migration ran: the writes the new release made since the snapshot are lost. For a failure `apply` judged itself that is at most the deadline plus the settle window; for `pap update recover` or `rollback --restore-database` run long after a cut update (SSH lost, Ctrl-C) it can be days of writes. The database being replaced is therefore kept first as `backups/pre-rollback-<stamp>.db` (the messages print the real, absolute file name) (if that fails the rollback ends `rollback_failed` / `database` and changes nothing), and `pap restore` refuses while `update/pending.json` exists. Check `systemctl --user status <unit>` and the age of `pending.json` before you recover; `--keep-database` keeps the database as it is.
- Outcome `rollback_failed` keeps `pending.json`, with the step that failed: `stop`, `lock`, `database`, `switch`, `restart`, `old_release_not_listening`, `old_release_unverified` (the old release's journal is unreadable and `/healthz` or the unit state does not confirm it), `error`. A `database` failure carries the snapshot primitive's fixed message as `code`. `pap update recover` runs the same `rollback()` from the journal.

## Guards

- Release ids go through `checkedId` (`[A-Za-z0-9._-]{1,64}`, never `.` or `..`) before any path is built; `current` is read only when it is `releases/<id>`.
- `guard.ts`: the command refuses to run from inside the unit it stops (its cgroup names the unit, or an ancestor process is the pid in `pap.lock`, as in pap's own web terminal). Why: `systemctl stop` kills the cgroup of the unit, and a shell in pap's own terminal is in it (or a child of the daemon), so the command would die between the stop and the restart and leave `pending.json` for `recover`. Run these commands from SSH or a console. The guard fails open when it cannot read `/proc/self/cgroup`, the process table or `pap.lock` (it is a safety net, not an authorization).
- `--unit` accepts `^[a-z0-9@._-]{1,64}\.service$`; the systemd wrapper accepts only `^[a-z][a-z0-9-]{0,40}\.service$`. A name between the two passes the flag check and is refused at the first systemd call, before anything changes.
- `systemctl cat` text above 64 KiB is refused (not cut); a unit with `EnvironmentFile=` or an empty `PAP_HOME=` is "not a unit pap wrote" (it may set the home out of sight): pass `--home` where the command has one, or run the installer with flags.

## `pap update apply --release <id>` (`apply-command.ts`, `wiring.ts`, `probe-health.ts`)

Options: `--app-root <abs>` (default `~/.local/share/pap`), `--deadline-s 30..600` (120), `--settle-s 0..60` (10), `--unit <name>` / `PAP_UNIT` (`pap.service`). `--help` prints one usage line and exits 0 (the installer uses it to detect a release without the command).

- The unit decides (M6bR42, M6bR50): `systemctl --user cat <unit>`, else the unit file, read with `parseUnit`. Home, `--port`, `--host` and `--tls-cert` come from that text; `PAP_HOME` and the port in the shell are ignored. A unit without `PAP_HOME` means `~/.pap`. No unit: "run the installer with flags". A unit `parseUnit` cannot read: refused, exit 1.
- Order: flags, unit, the guard, `update/op.lock` (held for the whole command, a busy one is exit 1), then `applyRelease`. The guard refuses (exit 1, nothing written) when the cgroup names the unit or an ancestor is the pid in `pap.lock`: a shell in pap's own web terminal would die with the stop. Run it from SSH or a console.
- Readiness: the `listening` journal line in chunks of 20 reads (about 10 s); after a chunk without it, `ActiveState=failed` ends the wait as `never`. At the deadline the last chunk's answer stands (`unreadable` stays `unreadable`). `/healthz` is asked on the unit's own address: `https` when the unit has `--tls-cert` (certificate not verified, it is the machine's own address), the unit's `--host` (a wildcard is loopback), the unit's port, 200 and exactly `{"status":"ok"}`, 1 KiB, 3 s in total (one timer on the whole request, not an idle timeout).
- Exit codes: 0 updated; 1 refused (nothing changed); 3 installed, start not confirmed (journal unreadable); 4 failed and rolled back (the old release runs; says whether the database was restored and since when writes were discarded); 5 failed and the rollback failed (run `pap update recover`, then `systemctl --user status <unit>`; a `database` failure names the way out: `pap restore`, or the newest `pre-update-*.db` under `<home>/backups/`).

## Snapshots kept (`prune.ts`, M6b-C3)

After a successful `update apply` (exit 0 or 3) the three newest `backups/pre-update-*.db` stay (by modification time) and older ones are removed, so a full `state.db` copy does not pile up with every update. Never removed: the snapshot this run took, the one a live `update/pending.json` names; a damaged `pending.json` removes nothing. Only regular files with that name shape count (a folder, a symlink, `*.tmp`, `pap-backup-*`, `pre-restore-*` are left alone). A failed or rolled-back update removes nothing. The success line names this run's snapshot (from the outcome), not the newest file with the same prefix.

## `pap update rollback` and `pap update recover`

Both run the transaction's own `rollback()`; neither re-implements it. Both: flags, the unit (as `apply`), the guard (a shell in pap's own terminal is refused: "run this from an SSH or console shell"), `update/op.lock` for the whole command, then the journal. `--app-root <abs>` and `--unit <name>` as for `apply`.

`pap update rollback [--to <id>] [--restore-database | --keep-database]` (`manual-rollback.ts`, `rollback-command.ts`):
- Target: `--to <id>` (a complete release other than `current`), else the newest other complete release. Refused (exit 1, nothing changed): `update/pending.json` exists (run `recover`), no `current`, no other complete release, `--to` naming `current` or an incomplete or unknown release.
- It builds the journal `{ from: <target>, to: <current>, step: "rolling_back", snapshot, schemaBefore }` from the newest `pre-update-<current>-<stamp>.db` and runs `rollback()` on it, so the migration rule is the automatic one: the snapshot is restored only if the database holds a migration id the snapshot lacks (or is damaged).
- That case needs a decision: with neither flag the command exits 1 and prints both options with their cost: `--restore-database` (writes since the snapshot's time are discarded) and `--keep-database` (the older release opens the database read-only until you update again). `--keep-database` passes no snapshot and no ids, so the database is never replaced.
- No usable snapshot (none, or a damaged one) and a database: it runs and prints "no snapshot: the older release may open the database read-only". With `--restore-database` it also prints that the database was NOT restored.
- Exit 0 rolled back; 1 refusal; 5 the rollback failed (journal kept: `pap update recover`).

`pap update recover [--keep-database]` (`recover-command.ts`): finishes an update cut in half from `update/pending.json`.
- No journal: "nothing to recover", exit 0. A damaged journal: its path is printed, exit 1, the file is kept ("inspect it, delete it only after `systemctl --user status <unit>` and `pap doctor` look right").
- A valid journal runs `rollback(deps, pending, "recovering an interrupted update")`: 0 rolled back, 5 failed (the journal stays). A migration that ran is undone from the journal's snapshot; a journal cut at `stopping` has nothing to restore and only restarts the old release.
- A journal whose snapshot file is missing, after a migration: plain `recover` exits 5 at the `database` step and prints the way out. `recover --keep-database` runs the same rollback with no snapshot and no ids: it never touches the database, exits 0, and the older release opens a migrated database read-only until you update again.
- Every restart is preceded by `reset-failed` (M6bR15), as in `apply`.

## The archive installer's update path (`scripts/archive-install.sh.tpl`, M6bR11, M6bR56)

ADR 0057's order is unchanged: refusals, private copy, hash, listing, extraction, completeness, release moved into place, and only then the switch.

- A different `current` exists and the installer got **no flags**: the script runs `update apply --help` of the NEW release, then `update apply --release <id>`. It never calls `service install` and never switches `current` (the cleanup trap stays disarmed: `switched=1` is set only on the other branch, so a rollback `update apply` already did is not undone). The unit, its port and its home stay as they are.
- A new release whose CLI has no `update apply` (`--help` fails: older than M6b) is refused, exit 1, before `current` moves, with a sentence naming the flags path (M6b-RT-19). With explicit flags it installs through the M6 path: no rollback and no database check.
- Exit codes: 0; 1 every other failure (including `update apply` codes other than 0, 3, 4, 5); 3 installed but unverified; 4 update failed, previous release restored and running; 5 failed, rollback incomplete (`pap update recover`). Pruning (all but the new and the previous release) and the unverified summary run only after 0 or 3.
- First install, a re-install of the current release with flags, and any run with flags keep the M6 path (re-render the unit, `service install`).
- Same release, no flags, unit installed (M6b-C13): the script only runs `reset-failed` and `restart` and never calls `service install`. On the flags path it keeps the unit file before `service install`; its failure trap puts it back byte-identical (mode kept), runs `daemon-reload`, then restores `current` and restarts. A first install with no unit keeps the undo commands that `service install` prints.
- Mutual exclusion (M6bR51, M6b-C4): `update apply` takes `update/op.lock` itself; the script holds none, so a busy lock makes `update apply` refuse (exit 1). On the flags path over an installed pap the script only reads `update/op.lock` (`<pid> <start time>`, live pid with the same start time) in every candidate home and refuses before it switches: the `--home` value, the installed unit's `PAP_HOME` (`systemctl --user cat pap.service`, drop-ins included), and `~/.pap` when the unit names none. The shell's `PAP_HOME` is not one (the service ignores it). The exclusion is one-way: the installer writes no lock (it never touches the home), so an update or restore started while the flags path runs `service install` is not refused.
- The script unsets `PAP_UNIT`: the installer always works on `pap.service`. `update apply` is called as `--release=<id>`; a failure other than 3, 4, 5 prints its code and "if it was interrupted, run: pap doctor".

## `pap update check`, `pap update install` and the daily check (T9: `check.ts`, `install-command.ts`, `update-check.ts`)

- **Feed** (`check.ts`): `checkForUpdate({ channel, current })` asks exactly one URL (`FEED_URLS`: `releases/latest/download/pap-feed-stable.json`, or `releases/download/next/pap-feed-next.json`) through `fetchLimited` (T2: host and path allowlist, 64 KiB cap, 15 s), parses it with `FeedSchema` and refuses a feed of the other channel. `compareVersions` (`version.ts`) is semver without a library (a release beats its pre-releases; numeric identifiers compare as numbers). Channel: `--channel`, else `PAP_UPDATE_CHANNEL`, else `stable`.
- **`pap update check`**: prints the current and latest versions and the release notes URL (a validated project URL), exit 0 whatever the answer (newer, current, ahead). Exit 1 when the feed cannot be read, with one sentence that carries only a code word (`cannot read the update feed (status)`); never remote text. `PAP_UPDATE_CHECK` does not apply: explicit commands are always allowed.
- **`pap update install [--channel c] [--from <abs dir>] [--yes]`** updates archive installs only. Without `--yes` it is a dry run: versions, what is interrupted, what is kept, the rollback sentence and the trust sentence (the feed comes from github.com, a trusted host; the release is not signed). It writes nothing.
  - Refused, exit 1, nothing changed: no archive install (`current` missing: the command for the kind, from the entry path and `/run/.containerenv`: `git pull && scripts/install.sh --bin-dir <dir>`, `npm install -g @soulkyu/pi-agentic-platform@latest`, `podman pull` / `scripts/pap-container.sh build`); a feed that is not newer ("pap is up to date"); a `minNode` above the running Node; an invalid feed; too little disk for the download (twice the archive plus 64 MB; checked only with `--yes`, before the download); an installer or archive whose length differs from the feed's `size`; an installer whose SHA-256 differs from the feed's. The downloaded installer is never run before its hash matched.
  - With `--yes`: the installer (at most 1 MiB) is fetched first and checked, written 0700 into `downloads/dl.XXXXXX` (0700) under the app root, then the archive (0600) beside it; `bash <installer>` runs there with `PATH`, `HOME`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS` and `LANG` only (so `PAP_UNIT`, the shell's `PAP_HOME`, the SSH agent, `GIT_*` and `LD_*` never pass), stdio inherited, 30 minute timeout. The installer's exit code is the command's (0, 3 unverified, 4 rolled back, 5 rollback incomplete); a kill or timeout is exit 1. The folder is removed in `finally`; a SIGINT or SIGTERM during `--yes` skips it, so a stale `downloads/dl.XXXXXX` can be left: delete it (nothing sweeps it). The archive's own hash is checked by the installer (ADR 0057).
  - `--from <abs dir>`: no network. The folder needs exactly one `pap-install-<id>.sh` and its `pap-<id>-linux-x64.tar.gz`, both regular files; the installer runs in place. The archive-install check still applies.
- **Daily check** (`update-check.ts`, called once from `main.ts` after the daemon is up): a timer on the kernel `Clock`, first run 10 minutes after boot, then every 24 hours, one timer pending at any time. Nothing is scheduled for `--dev`, version `0.0.0` or `PAP_UPDATE_CHECK=0`; with the variable unset the check runs, since `UPDATE_CHECK_DEFAULT` is `true` since the v1 flip (`scripts/release-flip.ts`, ADR 0066 and 0076). It logs `update_available {current, latest, channel}` at info only when newer, writes `update/last-check.json` (`{ at, channel, current, latest, status }`, 0600, nothing from the feed but the validated version), and logs a failure as `update_check_failed {code}` at debug. A failure never reaches the daemon; `stop()` clears the timer and aborts a request in flight (an aborted run logs and writes nothing). It never downloads an archive and never applies anything. Cost once on: one HTTPS request a day to github.com (GitHub sees the IP address, the time and `user-agent: pap/<version>`; ADR 0067). An invalid `PAP_UPDATE_CHANNEL` falls back to `stable` here, silently; the explicit commands refuse it.

## Troubleshooting

Without `NRestarts` (an old systemd) the settle check cannot read the restart counter and fails closed: the update is judged failed and rolls back every time. Use the flags path of the installer on such a host.

| Symptom | Meaning and fix |
|---|---|
| `systemctl restart failed (exit 1)` / start limit reached | systemd allows 5 starts in 120 s and counts manual ones. Every pap restart is preceded by `reset-failed`; if you restart by hand after a failure run `systemctl --user reset-failed <unit>` first |
| journal unreadable, exit 3 | the journal is volatile or not yours, so the start could not be confirmed; `/healthz`, the unit state and the settle window did pass. `systemctl --user status <unit>`, then make the journal persistent (`pap doctor`, check `journal`) |
| `no space` / free disk below `2 x state.db + 64 MB` | the preflight refuses before anything changes. Free space, or delete old `backups/pre-update-*.db` and `backups/pre-restore-*` you no longer need |
| `pending.json` present, `pap doctor` says `update_pending` fails | an update is running or was interrupted: `pap update recover` (add `--keep-database` when the snapshot file is gone and you accept the older release opening the database read-only) |
| `pending.json` damaged | `pap update recover` prints its path and exits 1 and keeps the file. Run `systemctl --user status <unit>` and `pap doctor`; delete the file only when both look right |
| exit 5 after an update | the rollback failed; the journal is kept. `pap update recover`, then `systemctl --user status <unit>`. A `database` failure names the way out: `pap restore`, or the newest `pre-update-*.db` under `<home>/backups/` |
| `pap restore` / `pap doctor` says the database is from a newer pap | the home was migrated by a newer release than this one. Update pap, or restore a backup taken by this release |
| the command refuses: `run this from an SSH or console shell` | you are inside the unit's cgroup (pap's own web terminal). Open a shell outside pap |
| `another pap update, rollback, recover or restore is running (pid N)` | a live operation holds `update/op.lock`. If N is gone and the message persists, the file is stale: it is replaced on the next run |
| the update check never says anything | it is on by default: look for `PAP_UPDATE_CHECK=0` in the unit (`systemctl --user cat pap`); `--dev` and version `0.0.0` never check; a failure is logged at debug only (`update_check_failed`) |

Tests that need a non-root user (`chmod`-based permission cases) skip themselves when run as root and say so; run the suite as your own user.
