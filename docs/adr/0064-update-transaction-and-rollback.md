# ADR 0064: update transaction and rollback

Status: accepted (M6b, tasks 6 to 9, 16)
Date: 2026-10-17
Spec: D21. ADRs 0055, 0056, 0057. Rulings: M6bR10 to M6bR19, M6bR42, M6bR43, M6bR51 to M6bR53, M6bR56, M6b-RT-03, RT-05, RT-11, RT-18, RT-19, RT-24, M6b-C3, C4. Guide: `docs/agents/update.md`.

## Decision: scope

`pap update` works on archive installs only (`releases/<id>` plus `current`): they are the only layout with a previous release to go back to. A checkout, an npm install and a container each print their own command and exit 1.

## Decision: order of the transaction (M6bR13)

preflight (refusals) -> `update/op.lock` -> write `pending.json` -> stop the unit -> take the instance lock -> `VACUUM INTO backups/pre-update-<id>-<stamp>.db` -> switch `current` -> release the instance lock -> `reset-failed` -> restart -> wait for `listening`, `/healthz` and a settle window.

- The snapshot is taken after the stop, with the instance lock held. A snapshot taken while the old daemon runs misses its last writes and can carry a WAL the stop then folds in; after the stop nothing writes, and the lock keeps a hand-started daemon out.
- The journal names the snapshot right after it exists and before `current` moves, so a kill at any later point finds it. `pending.json` is written with `fsync` of file and folder at each step and removed only when an update or rollback ended.
- Every restart is preceded by `reset-failed`: the start limit (5 in 120 s) counts manual starts, and the rollback restart is the sixth start of a fast-crashing release.

## Decision: what "failed" means (M6bR12)

No `listening` journal line within the deadline (the wait ends early when the unit reaches `failed`), `/healthz` not answering on the unit's own address, or during the settle window the unit not active, `NRestarts` moved or `/healthz` failing. An unreadable journal is not a free pass: `/healthz`, the settle window and the unit state are still required, and only then the outcome is `unverified` (exit 3, no rollback).

## Decision: the locks (M6bR51, M6b-C4)

`update/op.lock` (`<pid> <process start time>`, `wx`, a stale or recycled pid replaced) is held for the whole of `update apply|rollback|recover` and `pap restore`. After the stop the instance lock is taken and held through snapshot, database restore and switch. The installer's exclusion is one-way: it only reads `op.lock` on the flags path and writes none, because writing it ends M6's property that the installer never touches the home. Cost: an update started during a flags-path reinstall is not refused. At the join the lock file itself was hardened: an empty file younger than 5 s is a holder mid-write, a read racing a release is retried, and a stale file is removed only if it still has the content that was judged stale. Two processes that judge the same file stale at the same instant can still both hold it (reproduced by the final review); the instance lock is not a backstop for that, because it covers only the database and switch steps, not `pending.json`, the unit stop or the lock file. What the loser does: in `apply` it fails at the instance lock (or, if the winner has already released it, runs its own rollback), rewrites `pending.json` as `rolling_back` with no snapshot, stops the unit again and ends exit 5 ("run pap update recover") without restarting; the winner's own rollback or `recover` converges, and the migration rule fails closed, so no data is lost. A `restore` that loses fails at the instance lock before it changes anything. Hardening left for later: create the lock with `link()` from a fully written temp file and take over a stale lock by `rename()` to a unique name.

## Decision: the migration rule (owner b6, M6bR14)

Rollback restores the snapshot only if a migration ran (the database holds an id the snapshot lacks, or fails `integrity_check`). Otherwise the database stays as the new release wrote it; the old release reads the same schema. Forward-only: no code path writes a down-migration or opens a newer database read-write. A downgrade is refused before anything is touched (M6bR16). What rollback loses: when a migration ran, the writes the new release made since the snapshot. For an update that `apply` itself judged failed that is at most the deadline plus the settle window; for `pap update recover` (or `rollback --restore-database`) run long after an update was cut (SSH lost, Ctrl-C), it can be days. So the database about to be replaced is kept first as `backups/pre-rollback-<stamp>.db` (instance lock held; if it cannot be kept the rollback ends `rollback_failed` at `database`), and `pap restore` refuses while a live `update/pending.json` exists, so a later `recover` cannot overwrite a database the owner just restored. A manual rollback needs one decision when the current database is newer than the snapshot: `--restore-database` (discard writes since the snapshot) or `--keep-database` (the older release opens it read-only until the next update).

## Decision: the new release's CLI orchestrates, with an outer net (M6bR11)

The installer of the new release calls `pap update apply --release <id>` of the new release, only when a different `current` exists and the installer got no flags. The code that decides about a release is the code of that release, and the installer cannot be a second implementation of the transaction. A new release without that command (older than M6b) is refused before `current` moves. The outer net is the installer's own exit-code mapping (0, 3, 4, 5, everything else 1 with "run: pap doctor") and `pap update recover` for a process killed mid-transaction.

## Decision: the self-kill guard (M6bR52, M6b-RT-03)

`update apply|rollback|recover` refuse to run inside the unit they stop: when `/proc/self/cgroup` names the unit, or an ancestor process is the pid in `pap.lock` (a shell in pap's own web terminal). Run them from SSH or a console. The guard fails open when it cannot read `/proc/self/cgroup`, the process table or `pap.lock`: it is a safety net against an own-goal, not an authorization, and the unit's real stop still happens. Cost if wrong: on a host where those reads fail, a shell inside the unit is not refused and dies with the stop; `pending.json` then lets `pap update recover` finish from another shell.

## Decision: workers can outlive a stop (M6bR53)

`systemctl stop` relies on the daemon's graceful stop. After `TimeoutStopSec` the unit's control-group kill ends everything in its cgroup, but worker scopes (`systemd-run --user --scope`, linger on) are separate cgroups. Appendix A of the plan records what an older pap leaves behind; the update does not hunt for them.

## Exit codes

0 updated; 1 refused (nothing changed); 3 installed, start not confirmed; 4 failed and rolled back; 5 failed and the rollback failed (`pap update recover`). Pruning keeps the three newest `pre-update-*.db` (M6b-C3) and never the one a live `pending.json` names.
