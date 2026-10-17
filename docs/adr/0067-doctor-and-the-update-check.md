# ADR 0067: `pap doctor` and the daily update check

Status: accepted (M6b, tasks 9 to 11, 16)
Date: 2026-10-17
Spec: D21. ADR 0056 (journal), ADR 0065 (sandbox in the container). Rulings: M6bR22, M6bR24 to M6bR28, M6bR44, M6bR50, owner b9 and b10, M6b-RT-09, RT-12, RT-13, RT-17, RT-23, M6b-C11. Guides: `docs/agents/doctor.md`, `docs/agents/update.md`.

## Decision: doctor is read-only

`pap doctor` creates and changes nothing under `$PAP_HOME`: no `mkdir`, no `writeFile`, no lock, no `-wal` or `-shm`. A home that does not exist is reported, not created. `state.db` is opened without writing: a plain read-only open while the daemon runs (a read-only connection never creates a WAL), the SQLite `immutable` URI when it does not, and not opened at all when a `-wal` is waiting (that is an `info`: it is applied at the next start). The only thing it makes is the `bwrap` probe's temporary folder in `os.tmpdir()`, removed afterwards (M6b-RT-23). The only children are `systemctl --user` (read verbs), `loginctl show-user` and `journalctl --user`, each with a timeout and an output cap. A test lists the home before and after a run and fails on any difference, with a WAL-mode database. The one limit: a check that does not answer in 10 s becomes a `warn`, but a synchronous `statfs` on a hung mount cannot be cancelled by that timer.

## Decision: severities

`ok`, `info`, `warn`, `fail`, `skip`. `info` is advisory and counts as ok: a healthy default install (no backup made yet, no build tools, a shell `PAP_HOME` that differs from the unit's) exits 0 with `info` lines only (M6b-RT-13). Exit 0 for ok, info and skip only; 1 for at least one `fail`; 2 for warnings only; 64 for usage. A check that throws is a `fail` ("the check could not run") and does not stop the others. `fail` is kept for what is wrong now (a database from a newer or damaged, an interrupted update, a missing user manager, a Node below 24.14); `warn` for what will hurt later; push readiness is never `fail` (push is a feature, not the product). A `schema` read error other than a newer or damaged database (for example `EACCES`) is reported as damaged with the restore fix: the distinction is not worth a fifth state. Every `fix` is a command or a doc anchor.

## Decision: one resolver for unit and home (M6bR50, owner b9)

Doctor, `update`, `backup` and `restore` use `resolveTarget`: the unit from `--unit`, `PAP_UNIT`, else `pap.service`; the home from the installed unit's `PAP_HOME` when a unit exists. Backup and restore refuse when an explicit shell `PAP_HOME` disagrees with the unit, because they write; doctor only looks, so it follows the unit and says so as an `info`. The `--unit` flag pattern is wider (`^[a-z0-9@._-]{1,64}\.service$`) than the systemd wrapper's (`^[a-z][a-z0-9-]{0,40}\.service$`): a name that passes the first and not the second is refused with a fixed sentence at the first systemd call, before anything is changed.

## Decision: the update check's one daily request and its privacy cost (M6bR22, M6bR44)

When enabled the daemon asks for exactly one URL (the channel's feed) once, 10 minutes after boot, then every 24 hours. The request carries `user-agent: pap/<version>` and what any HTTPS client sends: GitHub sees the machine's IP address, the time, and that it runs pap in that version. Nothing else about the machine, no identifier, no body. It never downloads an archive and never applies anything; the result is `update/last-check.json` (`{ at, channel, current, latest, status }`, only the validated version from the feed) and one `update_available` info line, which `pap doctor` reads as `update_available` without a network call. A failure is `update_check_failed {code}` at debug and never reaches the daemon; `stop()` (wired into the daemon's shutdown) aborts a request in flight. It is off until the v1 flip (`UPDATE_CHECK_DEFAULT = false`, ADR 0066), so the privacy cost is zero before then unless `PAP_UPDATE_CHECK=1` is set. An invalid `PAP_UPDATE_CHANNEL` falls back to `stable` in the daily check (the explicit commands refuse it). `PAP_UPDATE_CHECK=0` disables only this check; `pap update check` and `install` are explicit and always allowed.

## Decision: https and push

M6b owns both doctor files for HTTPS and push readiness (`listenFacts` derived exactly like `loadConfig`, and the two checks) and builds them against an injected readiness function; M12 owns the pure `pushReadiness` in `kernel/push-readiness.ts`. The registry lines that join them are added when pap is rebased on M12 (M6bR47, ruling M6b-C12).
