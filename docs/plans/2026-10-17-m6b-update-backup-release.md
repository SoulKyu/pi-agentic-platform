# pap M6b: update, backup and release (rest of D21) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-17, plan fix):** corrected from the Sonnet red-team report (`.superpowers/redteam-m6b.md`: 1 Critical, 11 Important, 14 Minor) and the owner's answers (page `m12m6b-q1`, every answer the recommendation; section "Owner answers"). **18 tasks** (the planner's 16, with T5 split into T5a and T5b and T7 into T7a and T7b), a 2-task parallel base (T1 and T2), **three lanes** (1: backup, restore, doctor; 2: update; 3: packaging), one join. No migration, no contract change, no web change (initial bundle delta 0 KB), no new dependency in `apps/daemon` (zod 4.6.5 and `node:*` only). Every security block below that is marked "run in scratch" was executed on this host (Node 24.14.1, GNU tar 1.35, `node:sqlite`) before it was written into the plan. The first draft's runs found three defects (a parameter property that erasable-syntax Node refuses, a stream cancel that turned "too large" into "network", a restore that skipped creating its `pre-restore` folder). The red-team found the Critical one (M6b-RT-01: the pax `size` record made GNU tar read a hidden symlink that the reader listed as plain content). The corrected reader, `collect`, the doctor's database open, the operation lock and the health probe were re-run in scratch after the fix, with GNU tar building the archives: the hostile-archive results are in "Scratch results after the fix" below, and every one of them is also a task test.

**Goal:** finish decision 87's D21 for v1. An owner can (1) back up and restore pap's state, with the vault key and every other secret treated explicitly (M6R44); (2) update an archive install in place and have a failed update roll itself back, database included; (3) run `pap doctor` and be told what is missing and how to fix it; (4) run pap from a rootless-podman OCI image whose sandbox fails closed; (5) find an npm package, a release pipeline, two channels (stable, next) and a `curl | sh` bootstrap ready for the day the repository turns public.

**Architecture:**
- **Everything operational is TypeScript in `apps/daemon/src/cli/`**, one more `Command` per verb in `COMMANDS` (the M6 shape): `backup`, `restore`, `doctor`, `update check|install|apply|rollback|recover`. The bash scripts stay thin: they verify and extract (the M6 archive installer) or download and verify (`get-pap.sh`), and hand over to the TypeScript.
- **An update is a transaction owned by the NEW release's own CLI** (`pap update apply`, called by the pinned archive installer when a release is already installed): stop the old daemon, take a `VACUUM INTO` snapshot of `state.db` while nothing writes, switch `current`, restart, then require three things (the daemon's own `listening` journal line, `/healthz`, and a settle window with an unchanged restart counter). Any failure runs one `rollback()`: stop, restore the snapshot **if a migration ran**, switch `current` back, reset the start limit, restart, wait for `listening`. A `pending.json` journal written before every step lets `pap update recover` finish a rollback after a crash.
- **The database migrates forward only** (`kernel/db/migrate.ts` already snapshots to `backups/pre-migrate-*.db` and opens a newer database read-only). Rollback therefore needs the snapshot, never a down-migration; a downgrade is refused before anything is touched.
- **Backups are one `tar --format=pax` + gzip file**, optionally wrapped in an authenticated-encryption container (scrypt + AES-256-GCM, `node:crypto` only). Restore never trusts the archive, in three layers: a hand-written header reader (`listMembers`: checksums verified, only `path` and the times accepted in a pax header, only plain files and folders, safe relative names), the `tar` flags, and an `lstat` walk of the extracted stage that refuses anything that is not a regular file or a folder BEFORE any chmod or placement (M6bR6).
- **Distribution is four channels over one set of release assets** (archive, pinned installer, feed): the archive installer (M6), `curl | sh` via `get-pap.sh`, an npm package built from the same staged tree, and an OCI image built from the same staged tree. The GitHub repository is private until v1: every channel says what runs now from a local command and what waits for the public repo (table below).

**Tech Stack:** Node 24 (erasable TypeScript, `node:util parseArgs`, `node:crypto`, `node:sqlite`, `node:child_process execFile`), zod 4.6.5 (already in `apps/daemon`), bash, GNU tar, systemd user manager, rootless podman (manual steps only), release-please (config only; its CLI is used by CI at v1).

**Spec:**
- `docs/plans/roadmap.md` (M6b); `docs/research/decisions-log.md` decisions 8 (install channels), 75, 87, 88 (M6 accepted, real-host check moved here).
- `docs/specs/2026-10-10-A-product-scope.md` D21 ("Archive / OCI / npm, service install, update with auto-rollback") and success criterion 3.
- `docs/specs/2026-10-10-C-architecture.md` §3.2 (one daemon per `$PAP_HOME`, instance lock), §3.4 (database newer than the binary), §8 (security by default), §9.2 (sandbox fail-closed rule, `pap doctor` reports it).
- `docs/spikes/s8.md` and `docs/research/m0-m1-rulings.md` R47, R49, R52, R52b (rootless podman, `--security-opt systempaths=unconfined`, non-root, `--cap-drop ALL`, `no-new-privileges`).
- `docs/research/m6-rulings.md` (M6R1 to M6R44, W5-R2, W5-R10), `docs/research/m6-final-review.md` (I1: the start limit blocks a restart; I2: a volatile journal), ADRs 0004, 0049, 0055 to 0057, `docs/agents/install.md`.
- References read for ideas, not copied: T3 Code's packaging and Orca's update channel (`/home/ubuntu/Workspace/soulkyu/_refs/{t3code,orca}`, read-only). What this plan takes from them: a feed file per channel read over HTTPS (Orca's `latest`/`next` split) and rollback by keeping the previous release directory (the shape M6 already has). Neither signs anything either; signing stays after v1.
- `.superpowers/redteam-m6b.md` (the Sonnet red-team: finding ids M6b-RT-01 to RT-26 are cited where they are fixed), `.superpowers/owner-decisions-2026-10-17-m12m6b.md` (owner answers c1 to c5, b1 to b10, n1 to n10), `.superpowers/m12-m6b-cross-plan-agreements.md` (binding where it differs from the red-team's proposals).

**Carried items and rulings absorbed:**
- **M6R44** (backups and `secrets/vault/key`): T3, T4, T5a, T5b and owner answer b1.
- **M6R31** (`curl | sh` and OCI moved here): T12, T15.
- **M6R34** (podman wrapper): T12 (`scripts/build-archive-podman.sh`).
- **W5-R2 and W5-R18** (journal checks, volatile journal): doctor check `journal` (T10); an unreadable journal still requires a passing `/healthz` and settle window, and only then ends as `unverified` (exit 3); it never skips the rollback (T6, M6bR12, M6b-RT-05).
- **M6 final review I1** (start limit blocks a restart): every restart in this plan is preceded by `reset-failed` (T6, T7a, T8), pinned by a call-order test.
- **The M6 real-host check** (`.superpowers/sdd/2026-10-15-m6-install/real-host-check.md`): Appendix A. Never run by an implementer; owner b8 gave the OK, to be used after the Opus final review.
- **R52b and S8** (OCI): T12 and owner b7.
- **Decision 87**: all of D21's remainder except signing, SBOM and provenance.

**Not planned here ("After v1", decision 75):** release signing (cosign), SBOM, SLSA provenance, npm `--provenance`; a UI banner for "update available" (M13 or later: needs contracts and Settings, shared with M12); unit-file refresh on update (a release that needs a new unit directive says so in its notes); an OCI registry push and Docker support (rootful Docker was not measured, R52b); `--read-only` container root (not in S8's measured set); non-x86-64 archives; macOS; an updater for method 1 (checkout) and for npm and OCI installs (each prints its own command).

## Scratch results after the fix (this host, Node 24.14.1, GNU tar 1.35, 2026-10-17)

The red-team's Critical finding and three Important ones were re-run with the corrected code from this plan, in a scratch folder under `/tmp/claude-1000/` (deleted afterwards), against archives built by GNU tar. These results are the task tests' expectations.

| Case (M6b-RT) | First draft | Corrected code |
|---|---|---|
| RT-01 hidden symlink: GNU tar `--pax-option='size:=0'` over a member whose real content is a symlink header plus a file header (tar then extracts `agents/evil -> /...`, status 2) | `listMembers` lists 1 plain file | refused: "extended header record this reader does not accept" |
| RT-01 hidden hard link (same construction, link target `/etc/hostname`) | listed | refused, same sentence |
| RT-01 `linkpath`, `uid`, `GNU.sparse.*` (a sparse file archived with `-S`), `size`, `hdrcharset` pax records | listed | each refused |
| RT-01 flipped header byte (bad checksum) | listed | refused: "unreadable tar header" |
| RT-01 member below a file; a name listed twice; archive cut at a block boundary with no zero blocks; zero blocks then data | below-file listed; cut-short listed | each refused |
| RT-01 walk layer: real `tar -x` of the smuggle archive, then `assertPlainTree` | n/a | refused: "holds a link or a special file" (the symlink did land in the stage) |
| Good archive (long pax names of 180 characters, an executable script, empty folders) | listed | 8 members, the same names as `tar -t`; after the owner-only pass `run.sh` is 0700, `f.txt` 0600, folders 0700 |
| Symlink, hard link, FIFO, `../x`, absolute name, newline name, junk, truncated gzip, member cap | refused | refused (unchanged) |
| Mutation: remove the unknown-record refusal | n/a | the pax cases, `smuggle-sym` and `smuggle-hl` are listed again (so the tests fail) |
| RT-04 `collect`: a file name that is not UTF-8 sorting early, a file deleted between `readdir` and `lstat`, a symlink, an `EACCES`, a missing top | the bad name aborted the walk and returned half the folder with `skippedNames: 0` | the bad name and the symlink are counted, the vanished file is counted in `changed`, `EACCES` throws, a missing top is empty and silent |
| RT-06 doctor database open, a WAL-mode `state.db` closed cleanly | home `[state.db]` became `[state.db, state.db-shm, state.db-wal]` | `file:...?mode=ro&immutable=1` reads the ids and the home stays `[state.db]` |
| RT-11 `update/op.lock` | n/a | a second holder is refused with the pid; release removes the file; a dead pid and a recycled pid (other start time) are replaced |
| RT-02 health probe against local servers | `http://127.0.0.1` against an HTTPS unit failed | HTTP ok; HTTPS with a certificate for another name ok (verification off, own address only); wrong scheme, `{"status":"no"}` and a closed port are false |

Not re-run in scratch (no defect was reported there): the snapshot and restore primitives, the crypto container, the fetcher, the placement undo and the update scenarios 1 to 8; their tests are unchanged except where this plan says otherwise.

## What works now, and what waits for the public repository

The repository is private until v1 and GitHub Actions minutes are not used (owner policy: GitHub CI is ignored, the local clean-env gates are the gate).

| Piece | Works now from a local command | Waits for the public repo / v1 |
|---|---|---|
| Backup, restore, doctor | all of it | nothing |
| `pap update install --from <dir>` (a built installer and archive in a folder) | yes: runs the pinned installer, which updates with rollback | nothing |
| `pap update install` (download from the feed) and `pap update check` | the code and its tests (fake fetch) | the feed URL answers only when Releases are public |
| Archive, installer, feed files | `pnpm release:assets` builds all of them into `.pap-release/<tag>/` | uploading them to a GitHub Release (`gh release create`, printed, never run) |
| release-please | config files and `pnpm release:check` | the release PR needs GitHub: the workflow is `workflow_dispatch` only until v1 |
| `curl` piped to `sh` (`scripts/get-pap.sh`) | tested against a fake `curl`; the script itself runs by hand once a release exists | the one-liner needs a public raw URL and a published release |
| npm package | `pnpm build:npm` builds the folder and `npm pack` makes the tarball | `npm publish` (owner's account, after v1; name `@soulkyu/pi-agentic-platform`, owner b4) |
| OCI image | `scripts/pap-container.sh build` and `run` on this host (manual) | pushing to a registry |
| `next` channel | `release:assets --channel next` | the rolling `next` pre-release and its workflow job |

## Global Constraints

Binding ones from M6, M10 and M11, restated:
- 400 lines per file at most, test files included, no baseline. CLI code lives under `apps/daemon/src/cli/` and may import `kernel/`, `../daemon.ts` (for `MIGRATION_SOURCES`, as `open-home.ts` does) and `../shutdown.ts`. A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`: M6b adds no module.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts` extension. The only ESLint directive is `eslint-disable-next-line <rule> -- <reason>`.
- Tests never touch `~/.pi/agent` or `~/.pap`, the real user manager, the network or a registry. Every install, update, backup or doctor test runs in a temporary `HOME` with fake `systemctl`, `loginctl`, `journalctl` (and `podman`, `curl`, `npm`, `tar` only where stated) first on `PATH`. No sleeps: waits go through the CLI `Clock` (`io.clock.sleep`) or an injected `sleep`. Network is a fake `fetch`.
- Every child process is started with an argument list (`execFile`), never a shell, with a fixed binary name, a timeout and an output cap. No secret on a command line or in the environment of a child: passphrases come from standard input only.
- Logs and CLI messages never carry raw child stderr or a raw remote response body (MC57): a failure is a fixed sentence, an exit code and a hint.
- A message never overstates safety: every confirmation string is checked against the code (the encrypted-backup sentence says what the passphrase protects; the feed sentence says the feed host is trusted, not that the release is signed).
- Literal characters: no literal bidi, zero-width or line-separator characters in source, scripts or this plan (T16 runs the Cf / Zl / Zp scan).
- Conventional Commits, rebase on `main` before the PR, no AI attribution trailer, no `Co-Authored-By`.

M6b additions:
- **No migration, no contract, no web code.** M6b adds no RPC method, no stream, no permission, no Settings screen, no i18n key and no error code. It does not edit `kernel/config.ts` (M12 owns it: `PAP_PUSH_SUBJECT`, `PAP_PUSH_EXTRA_HOSTS`; `piAgentDirFrom` lives in the new `kernel/pi-dir.ts`, M6b-RT-14), `daemon.ts`, `compose*.ts`, `budgets.json` or `build-output.int.test.ts`.
- **Everything runs without the daemon.** Backup, doctor and `update check` work while pap runs; restore, `update apply|rollback|recover` need the unit stopped or stop it themselves. Restore takes the instance lock (`acquireInstanceLock`) and refuses when the daemon holds it.
- **The home is private.** New folders are 0700 and new files 0600; everything a restore places is owner-only (T5b, `mode & 0o700` so agent scripts keep their executable bit, never wider), whatever the archive says. A backup file is 0600 and is created with `wx` (never over an existing file).
- **Forward-only database.** No code path writes a down-migration or opens a database from a newer pap read-write. A snapshot is restored only after `PRAGMA integrity_check` is `ok` and its migration ids are a subset of the running release's.
- **One daemon per home** (R70), and one operation at a time, also during an update (M6bR51): `update apply|rollback|recover` and `pap restore` take `update/op.lock` for the whole operation (so two of them cannot interleave), and after the stop they take `acquireInstanceLock(home)` and hold it through the snapshot, the database restore and the switch, releasing it just before `reset-failed` and the restart. A daemon started by hand, or a running restore, makes them refuse before they change anything.
- **Release ids and file names** go through the M6 patterns (`[A-Za-z0-9._-]{1,64}`, `pap-install-<id>.sh`, `pap-<id>-linux-x64.tar.gz`) before they reach a path, a URL or a shell.
- **Outbound requests** (only the feed, the installer and the archive): `https:` only, host in `{github.com, objects.githubusercontent.com, release-assets.githubusercontent.com}`, a `github.com` URL only under the project's own path `/SoulKyu/pi-agentic-platform/releases/` (one constant, M6bR57), no credentials, no port, at most 3 redirects each re-checked, a deadline, a byte cap enforced while reading, `user-agent: pap/<version>`, nothing about the machine sent, no body logged.
- **Exit codes** of the new commands: 0 success; 1 refusal before anything changed; 64 usage; `update apply`: 3 installed but unverified (the journal is unreadable AND the health probe, the settle window and the unit state all passed), 4 failed and rolled back, 5 failed and the rollback is incomplete (`pap update recover`); `doctor`: 1 at least one failure, 2 warnings only (`info` counts as ok, so a healthy default install exits 0, M6b-RT-13).

## Review Focus

The spec says "a failed update rolls back by itself and backup / restore round-trips". These are the inputs most likely to bite the person and that no happy-path test shows; each has a named test.
1. **An update cut in half** (power loss, `kill -9` of `pap update apply`, the shell closed) between the snapshot and the switch, or after the switch: `pending.json` exists, `current` and the database may disagree. Expected: `pap doctor` fails with the exact command, `pap update recover` finishes the rollback and clears the file; a damaged `pending.json` is reported, never ignored. (T6, T8, T11)
2. **Disk full during an update or a backup**: the snapshot needs about twice `state.db`. Expected: refused before the unit is stopped (update) or before a byte is written outside a temp file (backup), with the numbers in the message; a failed backup leaves no partial file. (T3, T6)
3. **Offline, captive portal or hostile feed**: the update check runs from the daemon once a day. Expected: no log noise above `debug`, no crash, no retry storm; a feed with an extra key, a foreign host, a redirect to `http:`, a name that does not match the release id or a body above its cap is refused by code. (T2, T9)
4. **Restore over a running or populated home, and a wrong passphrase**: Expected: the lock refuses while the daemon runs; existing data needs `--replace` and is kept under `backups/pre-restore-*`; a wrong passphrase or a flipped byte leaves nothing on disk and says both causes. (T4, T5b)
5. **An agent folder that is not a clean tree** (symlinks, file names with a newline or control characters, millions of files, 40 GB): Expected: the backup skips what a restore would refuse, says how many it skipped and the first few clipped names, refuses a payload above 2 GiB without `--allow-large`, and the restore refuses a hostile archive that contains what the backup never writes. (T3, T5a)
6. **A hostile backup that two parsers read differently** (a pax `size` record, a bad checksum, a member below a file, a link smuggled inside another member's content): Expected: refused by the reader, and if the reader were ever wrong the walk of the extracted stage refuses before any chmod or placement; each layer has its own test and its own mutation. (T5a, T5b)
7. **An update that kills itself or races another operation** (`pap update apply` typed in pap's own web terminal; `pap restore` while an update runs; a daemon started by hand): Expected: refused with the way out before anything is stopped; `update/op.lock` and the instance lock prove it. (T1, T6, T7a)
8. **A healthy update on a non-default unit** (`--host <lan ip>`, `--tls-cert`, a unit named `pap-preview.service`): Expected: the probe talks to the unit's own scheme and address, the unit name and home are resolved, nothing is rolled back for a good start. (T1, T7a)

## Plan rulings (M6bR1 to M6bR57)

Shorthand: "Cost" is the cost if the ruling is wrong.

**Backup and restore**
- **M6bR1** A backup is one file: `pap-backup-<UTC yyyymmddThhmmssZ>.tar.gz`, or the same name with `.enc` appended when encrypted. Why: one file moves with `scp`; a folder tree has no single integrity or mode story. Cost: a very large home takes minutes to compress (said by the size gate).
- **M6bR2** (M6R44, owner b1 and c5; M6b-RT-08, RT-10) The `secrets/` folder (the vault key and scope files, `ref-salt`, `device.key`, `triggers/*.key`, M12's `secrets/push/vapid.json`, and anything added later) is **excluded by default** and the summary says so. `--secrets include` is accepted only together with `--encrypt` and restores everything under `secrets/` at 0600. A plain backup carries no file from `secrets/`, but it is **not** a clean file: the Pi `sessions/` transcripts (default-included, M6bR3), agent folders (memory, prompts) and `state.db` (audit rows, push subscriptions) can hold a value someone pasted or a tool printed. The summary and the docs say exactly this: "The secrets folder is not included. Transcripts and agent files may still contain secrets: treat this file as sensitive, and use --encrypt before copying it off this machine." Why: a plain backup is a file the owner copies to other machines, and the vault key next to the vault makes the vault readable (ADR 0049). Cost: a restore on a new machine loses agent secrets, webhook keys, the known-device key and the push key (the owner re-enters or rotates them; the restore summary lists exactly that, and says "Notifications: each device re-enables when it next opens pap.", M6bR48).
- **M6bR3** (owner b3) What a backup contains: `state.db` (a `VACUUM INTO` snapshot taken from a read-only connection, so it works with the daemon running), `attachments/`, `agents/`, `exports/`, `secrets/` (rule above), and Pi's `sessions/` folder from `PI_CODING_AGENT_DIR` (included by default; transcripts may contain secrets, so the summary warns and `--skip pi` leaves them out). Never: `search.db*` (a cache the daemon rebuilds), `worktrees/`, `lanes/`, `tmp/`, `logs/`, `backups/`, `update/`, `pap.lock`, Pi's `auth.json`, `models.json` and extensions (Pi's own files and credentials). The summary prints both lists. Cost: unpushed lane work is not in the backup (said).
- **M6bR4** `state.db` carries its own integrity: the manifest holds its SHA-256 and the migration ids it contains; restore re-reads both from the extracted database and refuses when they disagree. The other files carry no per-file hash: a plain backup detects corruption (gzip CRC, database check), not tampering; **encryption is what detects tampering** (GCM). The docs say exactly this. Cost: a swapped agent file in a plain backup restores silently.
- **M6bR5** The encrypted container is `PAPB1` + scrypt cost (log2 N 17, r 8, p 1) + salt + IV + AES-256-GCM ciphertext + tag, with the header as additional data. The passphrase is 12 characters or more (no composition rules), read from standard input (`readSecret`: TTY prompt twice for backups, one line from a pipe with `--passphrase-stdin`); never an argument or an environment variable. Decryption bounds the cost field (log2 N 14 to 18) before deriving a key. Cost: a forgotten passphrase is unrecoverable (said at creation).
- **M6bR6** (M6b-RT-01, RT-21) Restore never trusts the archive, in three layers, and none of them is enough alone. (1) `listMembers`, a hand-written header reader run BEFORE extracting: every header checksum verified; in a pax extended header only `path`, `mtime`, `atime` and `ctime` are accepted and a repeated key is refused (a `size`, `linkpath`, `uid`, `GNU.*` or `hdrcharset` record makes GNU tar read a different length or target than the ustar header says, which is how a hidden symlink member got past the first draft); only regular files and folders; names relative with no `..`, no empty or `.` part, no control, format or line-separator character and no U+FFFD; a name listed once and never below a file; the archive ends with its two zero blocks; at most 1 000 000 members and 64 GiB declared. (2) `tar -xzf` from one private copy with `--no-same-owner --no-same-permissions --no-overwrite-dir`; a non-zero `tar` exit refuses. (3) An `lstat` walk of the extracted stage BEFORE anything reads, chmods or places a file: anything that is not a regular file or a folder, or a file with another hard link, refuses the restore. Then the owner-only pass: `mode & 0o700` (plus owner read and write; a blanket 0600 would strip the executable bit of agent scripts and git hooks). Why: the reader and GNU tar are two parsers, and a differential between them is the whole attack, so the walk checks what tar actually wrote. Cost: an archive a future pap writes with symlinks is refused by this reader (the format number gates it).
- **M6bR7** Restore refuses, in this order: another update or restore holds `update/op.lock`; the daemon holds the instance lock; existing `state.db` without `--replace`; an archive that is not a pap backup; a `format` it does not know; free space below the declared bytes plus the archive size plus 64 MB; a database or manifest that names a migration id this release does not know ("written by a newer pap"); a damaged database; a manifest and database that disagree. With `--replace` the old database is kept as a snapshot `backups/pre-restore-<stamp>.db` and each replaced folder under `backups/pre-restore-<stamp>/`. A failure while placing moves the folders back. Cost: `backups/` grows and nothing prunes `pre-restore-*`; the restore summary prints the folder. A power cut between the folder renames and the `state.db` rename leaves a mixed home whose old data is under `backups/pre-restore-<stamp>*` (docs say so; a restore marker is deferred).
- **M6bR8** Restoring Pi sessions writes into the shared Pi folder: files are added only when missing, never overwritten (`COPYFILE_EXCL`), never outside `<PI_CODING_AGENT_DIR>/sessions`, and the count of added and skipped files is printed. Cost: a session file that exists in both places keeps the local one.
- **M6bR9** `pap backup` writes `update/last-backup.json` (time, file name, encrypted, secrets) for `pap doctor`'s age check. Default output folder `$PAP_HOME/backups/` (0700); `--out <dir>` overrides; `--keep N` (1 to 100) removes the older `pap-backup-*` files of that folder after a successful run (never the new one, never any other name). The summary says "copy this file off this machine". Cost: a backup that stays on the same disk is not a backup (said); the doctor `backup` check names the folder size and `--keep` when it passes 2 GiB (M6b-RT-20).

**Update and rollback**
- **M6bR10** (settled by ruling, KISS) `pap update` updates archive installs only: the layout `~/.local/share/pap/{releases/<id>,current}` is the only one with a previous release to go back to. A checkout, an npm install and a container each print their own command and exit 1. Cost: method 1 has no rollback (documented since M6).
- **M6bR11** The installer calls `pap update apply --release <id>` of the NEW release when a different release is already `current` AND the installer was given no flags. With flags it keeps the M6 reinstall path (re-render unit, `service install`). A new release whose CLI has no `update apply` (older than M6b) is refused in the no-flags case with a sentence naming the flags path (M6b-RT-19): it has no rollback and no downgrade check. Why: a plain rerun is then a safe update that never changes the port or home of the unit; flags are an explicit reinstall. Cost: a new unit directive needs a flagged reinstall (release notes say so).
- **M6bR12** "Failed" means any of: the new daemon has no `listening` journal line within the deadline (default 120 s, `--deadline-s` 30 to 600; the wait ends early when the unit reaches `ActiveState=failed`, M6b-RT-18); `/healthz` of the unit's own address (its scheme and `--host`, M6bR11c) does not answer 200 `{"status":"ok"}`; during the settle window (default 10 s, `--settle-s` 0 to 60) `ActiveState` is not `active`, `NRestarts` moved, or `/healthz` fails again; or any step throws (including a migration error, which makes the daemon exit before `listening`). A journal that is unreadable is **not** by itself a failure and **not** a free pass either (M6b-RT-05): `/healthz`, the settle window and the unit state are still required, and only when they pass is the outcome "unverified" (exit 3, nothing rolled back, the exact M6 rule that there is no `listening` line to confirm). An unreadable journal with an unhealthy daemon rolls back.
- **M6bR13** Order, fixed: preflight (refusals) -> `update/op.lock` -> write `pending` -> stop the unit -> take the instance lock -> `VACUUM INTO backups/pre-update-<id>-<stamp>.db` -> switch `current` -> release the instance lock -> `reset-failed` -> restart -> wait. Why: the snapshot is taken with the daemon stopped and nothing else able to start one, so it is exactly the state the old release left, and no write is lost between snapshot and stop. Cost: downtime of the whole update (the stop, the migration, the start).
- **M6bR14** (owner b6) Rollback restores the snapshot **only if a migration ran** (the database now holds a migration id the snapshot lacks, or no longer passes `integrity_check`). If no migration ran the database is left as the new release wrote it (the old release reads the same schema). Writes made by a migrated new release before the failure (at most deadline + settle) are lost; the rollback message says so. Cost: up to about two minutes of writes after a migrated update that then fails.
- **M6bR15** Every restart is preceded by `reset-failed` (M6 final review I1): the start limit counts manual starts, and the rollback restart is the sixth start of a fast-crashing release. A call-order test pins it in apply, rollback and recover.
- **M6bR16** A downgrade is refused before anything is touched: when the database holds a migration id the NEW release does not know. The message names `pap restore` and `pap update rollback`. Also refused: no `current`, `current` equal to the target, an incomplete target, an unreadable database, too little disk (`2 x state.db + 64 MB`).
- **M6bR17** `pending.json` (0600 in `$PAP_HOME/update/`, 0700) is written atomically with `fsync` before each step and removed only when an update or rollback finished. `pap update recover` runs the same `rollback()` from it; a damaged file is reported with its path and refused. `pap doctor` fails while it exists. Cost: a crash between `rename` and the next write leaves the previous step name (rollback does not depend on the step).
- **M6bR18** Manual `pap update rollback` goes to the newest other complete release (or `--to <id>`) and applies the same rule as M6bR14 using the newest `pre-update-<current>-*.db`: when the current database holds migrations the snapshot lacks it refuses unless `--restore-database` (loses writes since the snapshot, printed with its time) or `--keep-database` (the older release will open it read-only). Cost: a manual rollback needs one decision from the owner.
- **M6bR19** Releases other than the new and the previous are pruned by the installer after success (M6R26, unchanged). A rolled-back new release directory stays until the next successful update prunes it (forensics). Snapshots `pre-update-*.db` older than the newest three are removed after a successful update.
- **M6bR20** `pap update install` is a dry run until `--yes`: it prints versions, the interruption list from install.md (M6R33) and the rollback sentence. With `--yes` it downloads into `~/.local/share/pap/downloads/dl.XXXXXX` (0700), verifies the installer's SHA-256 against the feed, writes the archive, runs `bash <installer>` with a filtered environment and removes the folder. The archive's own hash is checked by the installer (ADR 0057). `--from <dir>` skips the network: the folder must hold exactly one `pap-install-<id>.sh` and its archive.
- **M6bR21** The feed is `pap-feed-<channel>.json` (strict zod, format 1). Channels: `stable` (`releases/latest/download/pap-feed-stable.json`) and `next` (`releases/download/next/pap-feed-next.json`, a rolling pre-release). Channel choice: `--channel` or `PAP_UPDATE_CHANNEL`, default `stable`. The same data is also published as `pap-feed-<channel>.env` for `get-pap.sh`, which has no JSON parser and never `source`s a file (T15).
- **M6bR22** (owner b10; M6b-RT-17) The background check runs once 10 minutes after boot and every 24 hours, only when the version is not `0.0.0`, not under `--dev`, and enabled. **Enabled means `PAP_UPDATE_CHECK=1` until the v1 flip; `0` is always off; unset follows one constant, `UPDATE_CHECK_DEFAULT`, which is `false` now and becomes `true` in the commit that makes the repository public** (the repository is private before v1, so every answer would be a 404). It logs `update_available {current, latest, channel}` at info, writes `update/last-check.json`, and logs failures at debug as `update_check_failed {code}`. It never downloads an archive and never applies anything. Cost once on: one HTTPS request a day to github.com (reveals the machine's IP to GitHub, nothing else; `=0` turns it off).
- **M6bR23** Version order is semver without a library: numeric core, a release beats a pre-release of the same core, pre-release identifiers compared numerically when numeric. `next` versions look like `1.3.0-next.12`. Cost: none; a table test pins it.

**Doctor**
- **M6bR24** `pap doctor` is read-only: it creates and changes nothing under `$PAP_HOME` and leaves nothing behind (the `bwrap` probe makes and removes a temp folder in `os.tmpdir()`, M6b-RT-23; a test lists the home before and after, with a WAL-mode `state.db` closed cleanly), calls only `show`, `cat`, `is-*` and `show-environment` on `systemctl`, and never starts the daemon. The `schema` check opens the database without writing: with the lock held, a plain read-only connection (the daemon's own `-shm` exists); with no lock and no `-wal`, the URI form `file:...?mode=ro&immutable=1` (a plain read-only open creates `state.db-wal` and `state.db-shm`, reproduced, M6b-RT-06); with no lock and a leftover `-wal`, it does not open the database at all (`unread`: the log is applied at the next start). Each check has a stable `id`, a `status` (`ok`, `info`, `warn`, `fail`, `skip`; `info` is advisory and counts as ok), a one-line `detail` and, unless ok or info, a `fix` command or hint. Exit: 0, 1 (any `fail`), 2 (warnings only). `--json` prints the same as one object; `--only id,id` runs a subset; `--unit <name>` / `PAP_UNIT` (M6bR50).
- **M6bR25** Checks (T10, T11): `node`, `toolchain`, `user_manager`, `linger`, `journal`, `disk`, `home`, `schema`, `update_pending`, `backup`, `https`, `push`, `bwrap`, `python3`, `update_available`. Outside a systemd host (a container) the systemd checks are `skip`, not `fail`. A healthy default install exits 0: `toolchain` missing and "no backup yet" are `info`, loopback `http` is `info` (M6b-RT-13).
- **M6bR26** `bwrap` runs the real sandbox probe (`probeSandbox`, M11R19: the full profile, a canary, a nonce), never a PATH scan (S8). On a refusal inside a container the hint names `--security-opt systempaths=unconfined` first. `python3` uses `trustedBinary` (root-owned, as M11's egress proxy requires).
- **M6bR27** (cross-plan agreement 2 and 3, M6b-RT-09) M6b owns both doctor files for push and HTTPS: `cli/doctor/listen-facts.ts` (a pure `listenFacts(unit, env)` returning `{ publicOrigin, tls, insecureHttp }`, derived exactly like `loadConfig`: `PAP_PUBLIC_ORIGIN` of the unit environment (the shell's only when no unit exists), else `scheme://host:port` with `localhost` for a loopback or wildcard `--host`; `--tls-cert`/`--tls-key` give `https`; `--insecure-http`) and `cli/doctor/checks-push.ts` (the `https` and `push` checks, built from an injected `readiness` function so they are tested before M12 is on the branch). The real function is M12's pure `pushReadiness(facts)` in `apps/daemon/src/kernel/push-readiness.ts`; the two registry lines are added when M6b rebases on M12 (owner c1, M6bR47). One status table, M12's: `ready` -> ok; `localhost_only` -> info (http://localhost works on this machine only); `insecure_http` -> warn; `origin_mismatch` -> warn; `keys_unreadable` -> warn. Push is never `fail`. For `secrets/push/vapid.json` the `push` check uses `lstat` only: absent -> ok ("created at the first start"); a regular file of mode 0600 in a folder of mode 0700 -> ok; anything else -> warn "push is off (keys_unreadable)" with the fix "chmod 600 ..., or delete the file to start over (each device re-enables)". The `https` hint names `docs/agents/notifications.md#https` (M12 task 21) and the routes inline, in M12's order: the ngrok origin (decision 75), Tailscale serve, a reverse proxy through `PAP_PUBLIC_ORIGIN`, then `--tls-cert`.
- **M6bR28** (M6b-RT-12) Doctor resolves the unit and the home the same way as update, backup and restore (M6bR50): the unit from `--unit`/`PAP_UNIT`/`pap.service`, the home from the installed unit (`--home` / `Environment=PAP_HOME`) when a unit exists, else from the environment, else `~/.pap`; it says which. Why: a shell with `PAP_HOME` unset must not look at the wrong home.

**OCI image, npm, release**
- **M6bR29** (owner b7, R52b) The image is for **rootless podman only**. The wrapper runs it with exactly the measured set: non-root user (uid 10001), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--security-opt systempaths=unconfined`, published to `127.0.0.1` only, and `--userns=keep-id:uid=10001,gid=10001` so that a bind-mounted `--project` is writable by the container user (without it uid 10001 maps to a sub-uid and the host user's folder is `root:root 755` inside, reproduced, M6b-RT-07). `systempaths=unconfined` unmasks `/proc` and `/sys` paths for the whole container; for a non-root user without capabilities S8 measured read access to a few host files and no write access. Rootful Docker, `--privileged` and `--cap-add SYS_ADMIN` are refused by the wrapper and never documented as supported.
- **M6bR30** The sandbox fails closed inside the image three ways: the M11 launch probe makes agents that require the sandbox refuse (`sandbox_unavailable`) when bwrap cannot run; the entrypoint logs one warning line from `pap doctor --only bwrap` at start; `pap doctor` inside the container prints the flag hint. The daemon itself still serves (a container without the flag is a usable pap without agents), and the summary of `pap-container.sh run` says so.
- **M6bR31** The image is built from the same staged production tree as the archive (`scripts/stage-app.ts` calls the existing `stageTree`), on `node:24-bookworm-slim` pinned by digest at build time (`podman image inspect` after a pull; the digest and the build commit are written to image labels). The final stage has no compiler, no pnpm and no `.npmrc`; the build stage's layers never reach the final image. Why: no secret can enter a layer that is not copied. Cost: apt packages float (the image is not byte-reproducible; said).
- **M6bR32** Volumes: one named volume `pap-data` at `/home/pap` (holds `~/.pap` and `~/.pi`). `PAP_WORKER_SCOPE=off` in the image (no user manager inside). The container binds `0.0.0.0:7777`; the wrapper publishes it on `127.0.0.1` only, which keeps ADR 0004's loopback cookie rule (browser sees `localhost`). Remote use is `ssh -L` or an HTTPS front, as for the unit.
- **M6bR33** (owner b4) npm: one package built from the staged tree: compiled daemon, web `dist`, `@pap/contracts` and `@pap/pi-host` as `bundleDependencies`, every other dependency exact (`catalog:` and `workspace:` resolved by the builder). Name **`@soulkyu/pi-agentic-platform`** (DESIGN.md's name, scoped); the `bin` is still `pap`. node-pty compiles on install (toolchain needed; `--ignore-scripts` breaks it, said). `npm-shrinkwrap.json` is generated by the owner's publish step (it needs the registry). No `--provenance` (after v1).
- **M6bR34** Version source of truth: the root `package.json` `version` (new field), mirrored into `apps/daemon/package.json` by release-please `extra-files`, and `.release-please-manifest.json`; a unit test fails when the three differ. Tags are `v<version>`. `Release-As: 1.0.0` in a commit footer makes the first v1 release.
- **M6bR35** `get-pap.sh` fetches the channel's `.env` feed, validates every line against a fixed shape (never `source`d), downloads the installer, checks its SHA-256 against the feed, downloads the archive and runs the installer, which checks the archive against its pinned hash. All three come from one host: this detects corruption and a swapped asset, **not** a compromised GitHub account or release. The one-liner pins the script to a tag. Signing after v1 closes the gap.
- **M6bR36** No workflow file runs automatically while the repository is private: `.github/workflows/release.yml` is `workflow_dispatch` only; the flip to `push: main` and the release-please job is one reviewed change at v1 (ADR 0066).

**Lanes and process**
- **M6bR37** (owner c3, M6b-RT lane cut) T1 and T2 run in parallel as the base (T2 imports only zod and `fetch`); then **three lanes**: lane 1 (T3, T4, T5a, T5b, then T10, T11: backup, restore, doctor), lane 2 (T6, T7a, T7b, T8, T9: update), lane 3 (T12, T13, T14, T15: packaging); one join (T16) at the end. Why: the three lanes touch disjoint files and share only whole-line registrations (below); lane 2's update code and lane 1's restore code share nothing but the T1 base. Cost: three worktrees and three `flock` slots at the peak (cap concurrency at four agents across M12, M6b and the models batch if cost matters; the first to defer is lane 3).
- **M6bR38** (owner c2) The model table follows the owner's rules: Sonnet implementers, never Haiku; Opus reviewers only on the security contracts listed (T2, T4, T5a, T6, T7b, T12) and the final review; Sonnet reviewers for T9 and T15 (the fetcher's Opus review in T2 covers the network code they use). **Opus escalation at fix rounds 4 and 5 is pre-approved for this wave (owner c2)**; the controller still names the task and the open findings in the ledger before round 4, and no other upgrade is allowed.
- **M6bR39** ADR numbers 0063 to 0067 are M6b's: 0063 backup and restore (format, secrets rule, restore reader and its three layers), 0064 update transaction and rollback (locks, workers, the self-kill guard), 0065 the OCI image and its fail-closed flags, 0066 release channels, feed and `curl | sh` trust, 0067 doctor and the update check. The decisions log is appended only by M12's plan fix (decision 93, which records the M12 and M6b owner answers and both plans); M6b adds no decision row.
- **M6bR40** Tests that need bubblewrap or podman are not part of the unit or int gates: the doctor `bwrap` check is tested with an injected probe; the image is built by hand (Appendix A).
- **M6bR41** Fake systemd is extended, not replaced (T1): new answers `active-state`, `restart-count`, `cat-unit`; the existing `is-active` trap stays.
- **M6bR42** `pap update apply` reads the unit with `parseUnit` (T1) for `port`, `host`, `tls` and `home`; the CLI's own environment is ignored for those. Why: the installer runs in a shell where `PAP_HOME` is usually unset while the unit has `--home`. Cost: a hand-edited unit that `parseUnit` cannot read refuses the update with a fixed sentence.
- **M6bR43** `update apply` uses the readiness the install uses (the `listening` journal line, `waitForListening`, now with a `reads` parameter) plus `/healthz`; `/healthz` alone is not readiness because another pap (the owner's preview on 7777) can answer it while the new daemon failed to bind.
- **M6bR44** `PAP_UPDATE_CHECK=0` disables only the background check; `pap update check` and `install` are explicit and always allowed.
- **M6bR45** Everything new that holds state is reset by uninstall as follows: `pap service uninstall` is unchanged (it never touches `$PAP_HOME`); the app folder's `downloads/` and `releases/` are removed by the documented `rm -rf ~/.local/share/pap` (install.md).
- **M6bR46** Docs (no file is shared between lanes): `docs/agents/backup.md` (new, lane 1: T3, T4, T5b), `docs/agents/doctor.md` (new, lane 1: T10, T11; the registry test reads its check table), `docs/agents/update.md` (new, lane 2: T6 to T9), additions to `docs/agents/install.md` (lane 3 only: T12 to T15). AGENTS.md gets one short group (T16, at most 6 lines, within 150 lines in total).

**Red-team and owner rulings (M6bR47 to M6bR57)**
- **M6bR47** (owner c1; cross-plan agreement 1) **M12 merges first, M6b rebases on it.** M6b has no migration, so nothing is re-stamped. The rebase is T16 step 1: the `https` and `push` doctor checks get their two registry lines and the real `pushReadiness` import, and the T11 tests are re-run. If the order ever flips, M12 re-stamps `202610172000_push.sql` only if a later stamp has landed.
- **M6bR48** (owner c5, b1; cross-plan agreement 4; M6b-RT-08) `secrets/push/` follows M6bR2: excluded from plain backups, restored at 0600 with `--secrets include --encrypt`. After a plain restore M12 mints a new VAPID pair at the next start and purges the old subscription rows (M12R4). The restore summary carries one static line whenever `secrets/push/vapid.json` was not restored: "Notifications: each device re-enables when it next opens pap." (and `docs/agents/backup.md` says the same). No code dependency between the plans.
- **M6bR49** (owner b2) A plain backup is allowed. Friction is exactly one line of warning in the summary (M6bR2's sentence) and in `--help`; `--encrypt` is recommended, never forced, and nothing prompts for it.
- **M6bR50** (owner b9; M6b-RT-12) `pap doctor`, `pap update ...`, `pap backup` and `pap restore` accept `--unit <name>` and `PAP_UNIT` (validated `^[a-z0-9@._-]{1,64}\.service$`, default `pap.service`). One function, `resolveTarget` (T1), returns `{ unit, home, homeSource }`; the flag wins over the variable. For `backup` and `restore` the home is `--home`, else an explicit `PAP_HOME`, else the installed unit's home, else `~/.pap`; both print `home: <path> (from the flag / the environment / the unit / the default)`, and both refuse when an installed unit's home differs from the resolved one and `--home` was not given (the owner's preview is `pap-preview.service` with its own `--home`; a shell with `PAP_HOME` unset must not back up or restore into `~/.pap` while the service runs elsewhere). The journal reads of `createSystemd` take the unit too (T1).
- **M6bR51** (M6b-RT-11) Mutual exclusion: `update/op.lock` (one file, `<pid> <process start time>`, created with `wx`, a stale or recycled pid replaced) is held for the whole of `update apply`, `update rollback`, `update recover` and `pap restore`; `update install` does not hold it (it runs the installer, which calls `update apply`). The instance lock is held by apply and rollback from after the `stop` to just before `reset-failed`. Both are in T1 (`ops/op-lock.ts`) so lane 1 and lane 2 share one implementation.
- **M6bR52** (M6b-RT-03) `pap update apply|rollback|recover` refuse to run from inside the unit they stop: when `/proc/self/cgroup` names the unit, or an ancestor process is the pid in `pap.lock` (a shell opened in pap's own web terminal, including one in a worker scope), they print "run this from an SSH or console shell: stopping pap would end this terminal" and exit 1 before touching anything (`pending.json` is not written). A pure function with injected inputs (T6, `update/guard.ts`).
- **M6bR53** (M6b-RT-24) Workers: `systemctl stop` relies on the daemon's graceful stop; after `TimeoutStopSec` the unit's `KillMode=control-group` sends SIGKILL, but worker scopes (`systemd-run --user --scope`, linger on) are separate cgroups and can outlive the daemon with old code. ADR 0064 says so; Appendix A checks `systemctl --user list-units 'run-*.scope'` is empty after the stop and records what the old pap leaves.
- **M6bR54** (owner b8) The controller may run Appendix A on this host after the Opus final review, with ports 7791 to 7793 and homes under `~/.pap-m6b-try*`, and the preview (7777, `~/.pap`) untouched. An implementer never does. Recorded in the ledger as the owner's OK.
- **M6bR55** (M6b-RT-20) Backup edge cases: GNU tar exit 1 ("file changed as we read it") on a live `agents/` is accepted with a summary line ("some files changed while the archive was written: each is complete or absent, take the backup again for a stable copy") and exit 0; any other non-zero exit is a failure. A plain archive is checked by `listMembers` on the finished `.part` before the rename (a file swapped for a symlink between `collect` and `tar` makes an archive the restore would refuse; better to find out at backup time). An encrypted backup is not re-read at creation (the plaintext is never written to disk); the restore re-validates everything.
- **M6bR56** (M6b-RT-19) Downgrade to a pre-M6b release with no flags is refused by the installer (M6bR11); with flags the M6 path runs as before, with no rollback and no database check; install.md says so.
- **M6bR57** (M6b-RT-15) One constant, `FEED_REPO = "SoulKyu/pi-agentic-platform"` (T2), gives `FEED_PATH_PREFIX = /SoulKyu/pi-agentic-platform/releases/`. `FeedSchema` accepts a `github.com` URL only under that prefix, and `fetchLimited` re-checks the prefix on every hop that stays on `github.com` (a redirect from the project's release URL to another repository's release is refused). `get-pap.sh` refuses `..` in feed URLs and in `PAP_GET_REPO`.


## Pre-execution conflict scan

Files by task (only the shared ones). Base = T1, T2. Lane 1 = T3, T4, T5a, T5b, T10, T11. Lane 2 = T6, T7a, T7b, T8, T9. Lane 3 = T12, T13, T14, T15. Join = T16.

| File | Tasks | Resolution |
|---|---|---|
| `apps/daemon/src/cli/run-cli.ts` | lane 1: T3 (`backup`), T5b (`restore`), T10 (`doctor`); lane 2: T7a, T8, T9 (`update ...`) | each task adds one import line and its `COMMANDS` lines; whole-line additions; the join keeps both blocks |
| `apps/daemon/src/cli/usage.ts` | same tasks | one `USAGE` line each; the closing "needs the daemon stopped" sentence is edited once, in T5b (restore is the first new command that needs it), and T10 adds `doctor` to the "works while pap runs" exception |
| `package.json` scripts | lane 3 only: T12 (`build:image`), T13 (`build:npm`), T14 (`release:assets`, `release:check`) | whole lines; lanes 1 and 2 add no script; M12 adds none (owner n8) |
| `knip.json` | lane 1: T3 (`tar`); lane 2: T7b (`bash`); lane 3: T12 (`podman`), T13 (`npm`); M12: the `sw/sw.ts` entry | whole entries in `apps/daemon.ignoreBinaries`; a rebase conflict keeps every entry; regenerate nothing |
| `.gitignore` | lane 3: T13 (`/.pap-npm/`), T14 (`/.pap-release/`) | whole lines |
| `apps/daemon/src/kernel/config.ts` | none (M12 owns it) | `piAgentDirFrom` is in the new `kernel/pi-dir.ts` (T1) |
| `apps/daemon/src/main.ts` | lane 2: T9 (one call to `startUpdateCheck` after `startup.ready`) | M12 does not edit `main.ts`; if it does, whole line |
| `apps/daemon/src/cli/service/{systemd,common,unit}.ts`, `cli/testing/fake-systemd.ts` | base T1 (unit parameter, three reads, fake answers); lane 2 T7a (`reads` parameter, `waitWithLoopHeld` move) | T1 lands before the lanes start |
| `scripts/archive-install.sh.tpl` | lane 2: T7b only | its new cases are in a new `archive-install-update.test.ts` (the old file is 336 lines, M6b-RT-14) |
| `docs/agents/*.md` | lane 1: `backup.md` (T3, T4, T5b) and `doctor.md` (T10, T11); lane 2: `update.md` (T6 to T9); lane 3: `install.md` (T12 to T15) | no file is written by two lanes |
| `AGENTS.md`, `README.md`, `docs/agents/daemon.md`, ADRs 0063 to 0067, `docs/research/m6b-rulings.md` | T16 only | |
| `apps/daemon/src/cli/ops/*` | T1 only (`snapshot`, `schema-status`, `paths`, `op-lock`, `target`) | frozen signatures in T1's "Produces" |
| `apps/daemon/src/cli/update/*` | T2 (`feed.ts`, `fetch.ts`); lane 2: T6 (`releases.ts`, `pending.ts`, `apply.ts`, `guard.ts`), T7a (`wiring.ts`, `apply-command.ts`, `probe-health.ts`), T8 (`rollback-command.ts`, `recover-command.ts`, `manual-rollback.ts`), T9 (`version.ts`, `check.ts`, `install-command.ts`) | frozen signatures in each task's "Produces" |
| `apps/daemon/src/cli/backup/*` | lane 1: T3 (`member-path.ts`, `manifest.ts`, `collect.ts`, `create.ts`), T4 (`crypto.ts`), T5a (`tar-list.ts`, `verify-stage.ts`, `place.ts`), T5b (`restore.ts`) | `safeMemberPath` is created in T3 (`member-path.ts`) and imported by T5a: `collect` must not depend on a later task's file |
| `apps/daemon/src/cli/doctor/*` | lane 1: T10 (`types.ts`, `run.ts`, `render.ts`, `checks-system.ts`), T11 (`checks-daemon.ts`, `listen-facts.ts`, `checks-push.ts`, `registry.ts`) | T11 adds registrations to T10's registry as whole lines |
| doctor `https` / `push` readiness | T11 (M6b) and M12 | interface in M6bR27 and cross-plan agreement 2 and 3 |

M12 and M6b shared files (additive, whole lines; M12 merges first, owner c1): `apps/daemon/src/cli/run-cli.ts` and `usage.ts` (M12 adds no CLI command), `package.json` scripts (M12 adds none), `knip.json`, `AGENTS.md` (at most 6 lines each, 150 in total), `docs/agents/daemon.md` (different sections), `docs/agents/install.md` and `run-cli.ts`/`usage.ts` (M6b only). M6b touches **none** of: `packages/contracts/*`, `daemon.ts`, `compose*.ts`, `kernel/config.ts`, Settings, i18n catalogs, `budgets.json`, `build-output.int.test.ts`, `eslint.config.js`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (no dependency is added), migrations. ADR numbers: M12 0058 to 0062, M6b 0063 to 0067, models batch 0068 to 0070. Decisions log: M12's plan fix appends 93 (the M12 and M6b owner answers and both plans).

## The lane graph

```
        T1 ops base (snapshot, schema, paths, op-lock, target, Systemd+, parseUnit, fake)     T2 feed schema + safe fetch
        └──────────────────────────────── both land first, in parallel (about 1.5 h) ────────────────────────────────┘
                 │                                      │                                          │
   LANE 1 (state: backup, restore, doctor)    LANE 2 (update)                          LANE 3 (packaging)
   T3 backup create                           T6 update core (releases, pending,       T12 OCI image + podman wrappers
     └> T4 encryption                           apply, rollback, guard)                  └> T13 npm package
          └> T5a untrusted-archive reader         └> T7a `update apply` command            └> T14 release config, feed, assets
               + stage walk + placement              (wiring, probe, locks)                    └> T15 get-pap.sh
               └> T5b restore flow + command         └> T7b installer template
                    └> T10 doctor core                  └> T8 rollback + recover
                         └> T11 doctor daemon checks       └> T9 check, install, daily check
                 │                                      │                                          │
                 └──────────────────────────────────────┴──────────────────────┬───────────────────┘
                                                                               v
                                    T16 JOIN: rebase on M12, wire https/push, docs, ADRs, rulings, the whole gate
```

- **Base (T1 and T2, in parallel):** about 1.5 h (T1 is 1.5 h, T2 is 1.25 h). T2 is in the base because lane 2 (T9) and lane 3 (T14) consume its feed schema. T1 carries everything two lanes share: the snapshot primitives, the schema read, `parseUnit`, the operation locks and the unit and home resolution.
- **Lane 1, backup then restore then doctor:** 7.75 h. T3 1.25, T4 1.25, T5a 1.25, T5b 1.25, T10 1.25, T11 1.5. The long pole.
- **Lane 2, update:** 6.75 h. T6 1.75, T7a 1.5, T7b 1.0, T8 1.25, T9 1.25. T7b needs T7a (the installer calls `update apply`); T8 needs T7a (`makeApplyDeps`).
- **Lane 3, packaging:** 5.75 h. T12 1.75, T13 1.5, T14 1.5, T15 1.0 (T15 reuses T14's fixture). T12's entrypoint calls `pap doctor --only bwrap`, faked in its tests and exercised at the join. Lane 3 finishes about 2 h before lane 1; moving T10 and T11 there would only move the pole (lane 3 would be 8.5 h), so the cut stays.
- **Files the lanes share** (all whole-line, see the scan): `run-cli.ts` and `usage.ts` (lanes 1 and 2), `knip.json` (all three), and the base files of T1 that lanes 1 and 2 import. No source file and no doc file is written by two lanes.
- **One join, T16:** the lanes meet only there. It rebases on M12, wires `https` and `push`, and checks what no lane can alone: `pnpm release:assets` (lane 3) produces a feed that `FeedSchema` (T2) accepts and `get-pap.sh` (lane 3) parses; `pap doctor` (lane 1) fails on a `pending.json` written by `update apply` (lane 2) and passes after `update recover`; the whole gate on the merged tree. About 1.5 h plus the full gate.
- **Critical path:** base (1.5) + lane 1 (7.75) + T16 (1.5) = **10.75 h** of work; the red-team's estimate for its cut was about 9.5 h before the T5 and T7 splits and the fixes in this plan. Honest wall clock: **12 to 15 h**, because the two heavy-gate slots are shared with M12's three chains and the models batch and the full gate runs once, at T16. Total agent time about 24.5 h. M12's own critical path (16 to 18 h) still dominates the combined finish.
- **Gate tiers (owner-approved):** unit + lint + typecheck + knip in every task; `test:int` only in T3 (backup spawns the CLI), T5b (restore round trip), T7a (`update apply` spawns the CLI against fake systemd), T10 (doctor spawns the CLI) and at the join; `pnpm build`, `pnpm smoke`, `pnpm smoke:install` and `pnpm budgets` at the join and in T7b (installer template) and T9 (a `main.ts` edit). Two heavy-gate slots are shared by every lane of M12, M6b and the models batch; a join never holds both slots at once.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `apps/daemon/src/cli/ops/snapshot.ts`, `.test.ts` | T1 | `snapshotDatabase`, `schemaIds`, `restoreDatabaseFile` (full code below) |
| `apps/daemon/src/cli/ops/schema-status.ts`, `.test.ts` | T1 | `schemaStatus` (with the no-write doctor mode), `knownMigrationIds` |
| `apps/daemon/src/cli/ops/paths.ts`, `.test.ts` | T1 | `installRoot`, `opsDir`, `writeJsonAtomic`, `readJsonBounded`, `readLockPid` |
| `apps/daemon/src/cli/ops/op-lock.ts`, `.test.ts` | T1 | `acquireOpLock`, `OpLockBusy`, `processStart` (full code below) |
| `apps/daemon/src/cli/ops/target.ts`, `.test.ts` | T1 | `resolveTarget` (unit name and home resolution, M6bR50) |
| `apps/daemon/src/cli/service/unit-read.ts`, `.test.ts` | T1 | `parseUnit` (inverse of `renderUnit`, drop-in aware, returns `host`, `tls`, `insecureHttp`) |
| `apps/daemon/src/cli/service/systemd.ts`, `common.ts` | T1 | `activeState`, `restartCount`, `cat`; the unit name threaded through the journal reads and `unitFilePath` |
| `apps/daemon/src/kernel/pi-dir.ts`, `.test.ts` | T1 | `piAgentDirFrom` (a new file; `kernel/config.ts` is not edited) |
| `apps/daemon/src/cli/update/feed.ts`, `fetch.ts`, tests | T2 | `FeedSchema`, `FEED_REPO`, `FEED_PATH_PREFIX`, `FEED_HOSTS`, `isReleaseUrl`, `fetchLimited` |
| `apps/daemon/src/cli/backup/member-path.ts`, `manifest.ts`, `collect.ts`, `create.ts`, tests | T3 | `safeMemberPath`, manifest schema, the walk and its skips, the tar argument list, `createBackup` |
| `apps/daemon/src/cli/backup.ts`, `docs/agents/backup.md` | T3 | `backup` command; the backup guide (T4 and T5b append) |
| `apps/daemon/src/cli/backup/crypto.ts`, `.test.ts` | T4 | the `PAPB1` container |
| `apps/daemon/src/cli/backup/tar-list.ts`, `verify-stage.ts`, `place.ts`, tests | T5a | the untrusted-archive reader, the stage walk and owner-only pass, placement with undo |
| `apps/daemon/src/cli/backup/restore.ts`, tests; `apps/daemon/src/cli/restore.ts` | T5b | the restore flow, the refusals, the command |
| `apps/daemon/src/cli/update/releases.ts`, `pending.ts`, `apply.ts`, `guard.ts`, tests; `docs/agents/update.md` | T6 | release directory helpers, the journal, the transaction and `rollback()`, the self-kill guard |
| `apps/daemon/src/cli/update/wiring.ts`, `apply-command.ts`, `probe-health.ts`, tests | T7a | production dependencies, `pap update apply`, the health probe |
| `scripts/archive-install.sh.tpl`, `scripts/archive-install-update.test.ts` | T7b | the installer's update path and its tests |
| `apps/daemon/src/cli/update/manual-rollback.ts`, `rollback-command.ts`, `recover-command.ts` | T8 | `pap update rollback`, `pap update recover` |
| `apps/daemon/src/cli/update/version.ts`, `check.ts`, `install-command.ts`; `apps/daemon/src/update-check.ts` | T9 | version order, `pap update check|install`, the daily background check |
| `apps/daemon/src/cli/doctor/{types,run,render,checks-system}.ts`; `apps/daemon/src/cli/doctor.ts`; `docs/agents/doctor.md` | T10 | framework and the system checks |
| `apps/daemon/src/cli/doctor/{checks-daemon,listen-facts,checks-push,registry}.ts` | T11 | daemon, home, update, HTTPS, push, sandbox checks |
| `Containerfile`, `.containerignore`, `scripts/container-entrypoint.sh`, `scripts/pap-container.sh`, `scripts/stage-app.ts`, `scripts/build-archive-podman.sh` | T12 | the image and the podman wrappers |
| `scripts/build-npm.ts` and test | T13 | the npm package folder |
| `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release.yml`, `scripts/release-feed.ts`, `scripts/release-assets.ts`, `scripts/release-check.ts` and tests | T14 | version source, feed generator, local assets |
| `scripts/get-pap.sh` and test | T15 | the curl-piped-to-sh bootstrap |
| `docs/agents/install.md` (T12 to T15 append), ADRs 0063 to 0067, `docs/research/m6b-rulings.md`, `AGENTS.md`, `README.md`, `docs/agents/daemon.md` | T16 (install.md: lane 3) | docs |

Sizes: no file is planned above 300 lines; the planned splits are the ones in the table (`create.ts` / `crypto.ts`, `tar-list.ts` / `verify-stage.ts` / `place.ts` / `restore.ts`, `apply.ts` / `wiring.ts`, `checks-system.ts` / `checks-daemon.ts`). Test files are split by concern (`*.test.ts`, `*.refusals.test.ts`, `*.hostile.test.ts`, `*.int.test.ts`) when one passes 300 lines.

---

## Tasks

### Task 1: Operations base (snapshot, schema status, paths, locks, target resolution, systemd reads, `parseUnit`) [base]

**Files:**
- Create: `apps/daemon/src/cli/ops/snapshot.ts`, `snapshot.test.ts`, `schema-status.ts`, `schema-status.test.ts`, `paths.ts`, `paths.test.ts`, `op-lock.ts`, `op-lock.test.ts`, `target.ts`, `target.test.ts`
- Create: `apps/daemon/src/cli/service/unit-read.ts`, `unit-read.test.ts`; `apps/daemon/src/kernel/pi-dir.ts`, `pi-dir.test.ts`
- Modify: `apps/daemon/src/cli/service/systemd.ts` (three methods, and the unit name threaded through the journal reads), `service/common.ts` (`unitFilePath` takes the unit), new `systemd.m6b.test.ts`; `apps/daemon/src/cli/testing/fake-systemd.ts` (three answers). **`kernel/config.ts` is not edited** (cross-plan agreement 7, M6b-RT-14).

**Interfaces:**
- Consumes: `renderUnit`, `unitFilePath`, `createSystemd`, `homeFrom`, `discoverMigrations`, `MIGRATION_SOURCES`.
- Produces (frozen; all three lanes import exactly these):
  - `snapshotDatabase(dbPath: string, outPath: string): void` and `schemaIds(dbPath: string): string[] | null` and `restoreDatabaseFile(snapshotPath: string, home: string, knownIds: ReadonlySet<string>): void`; `class SnapshotError`.
  - `schemaStatus(dbPath: string, known: ReadonlySet<string>, options?: { noWrite?: { lockHeld: boolean } }): { state: "absent" | "damaged" | "current" | "pending" | "newer" | "unread"; ids: string[] }` (`current`: ids equal known; `pending`: ids a strict subset; `newer`: an id not in known; `unread`: only with `noWrite`, a leftover `-wal` with no lock holder, not opened); `knownMigrationIds(): ReadonlySet<string>` (from `discoverMigrations(MIGRATION_SOURCES)`). With `noWrite` the function opens the database as in "The no-write open" below and creates nothing next to it (M6b-RT-06); without it, a plain read-only connection.
  - `installRoot(io: Pick<CliIo, "homedir">): string` (= `<homedir>/.local/share/pap`); `opsDir(home: string): string` (= `<home>/update`); `writeJsonAtomic(path: string, value: unknown): void` (parent `0700`, file `0600`, `fsync`, rename); `readJsonBounded<T>(path: string, schema: z.ZodType<T>, maxBytes: number): T | "damaged" | null` (null = absent); `readLockPid(home: string): number | null` (the pid in `pap.lock`, read in the format `acquireInstanceLock` writes; read that function first; null when absent or unreadable).
  - `acquireOpLock(home: string, pid?: number, startOf?: (pid: number) => string | null): () => void`, `class OpLockBusy`, `processStart(pid)` (full code below, M6bR51).
  - `resolveTarget(args: { unit?: string; home?: string }, env: NodeJS.ProcessEnv, homedir: string, unitText: string | null): { unit: string; home: string; homeSource: "flag" | "environment" | "unit" | "default"; unitHome: string | null; parsed: ParsedUnit | null }` and `UNIT_NAME = /^[a-z0-9@._-]{1,64}\.service$/` (M6bR50: `--unit` over `PAP_UNIT` over `pap.service`, validated, a bad name is a usage error; the caller reads `unitText` with `Systemd.cat` or the unit file). `mismatch(target): string | null` returns the refusal sentence when an installed unit's home differs from the resolved home and the flag was not given (used by backup and restore).
  - `parseUnit(text: string): ParsedUnit | null` with `ParsedUnit = { node: string; main: string; port: number | null; host: string | null; home: string | null; env: Record<string, string>; tls: boolean; insecureHttp: boolean }` takes the LAST non-empty `ExecStart=` (a drop-in's empty `ExecStart=` resets), `Environment=` lines merged in order; `tls` is true when the argv has `--tls-cert`; `host` is the `--host` value; null when the shape is not ours.
  - `createSystemd(env, options: { timeoutMs?: number; unit?: string })`: `options.unit` (default `pap.service`) replaces the hard-coded `UNIT` in the journal reads (`journal`, `journalAny`); `Systemd.activeState(unit): Promise<string | null>`, `Systemd.restartCount(unit): Promise<number | null>`, `Systemd.cat(unit): Promise<string>` (the effective unit text, drop-ins included, capped at 64 KiB). `unitFilePath(env, unit = UNIT)`.
  - `piAgentDirFrom(env: NodeJS.ProcessEnv, homedir: string): string` in `kernel/pi-dir.ts` (same `~` expansion and absolute-path rule as `homeFrom`; a relative path throws `ConfigError`).
  - `fakeSystemd` answers: `active-state`, `restart-count`, `cat-unit` (files in `<dir>/answers/`).

**Rulings (pre-dispatch):**
- **M6bR13/M6bR14 basis**: `snapshotDatabase` and `restoreDatabaseFile` are the only code in M6b that copies or replaces a database. Why: one place to review. Cost if wrong: a corrupt restore (hence Opus on T4's and T5a's review of the shared use, and the mutation checks here).
- **M6bR41**: fake systemd is extended, not replaced.
- **M6bR50, M6bR51**: unit and home resolution and the operation lock live here because lane 1 (backup, restore, doctor) and lane 2 (update) both need them and neither may import the other's files.
- `schemaStatus` reads read-only and never creates the file (a missing database is `absent`).

**Security contract (run in scratch: a read-only connection can `VACUUM INTO` while a writer holds the WAL; an existing target is refused; the snapshot mode must be set explicitly because the default umask gives 0644):**

```ts
import { chmodSync, copyFileSync, closeSync, fsyncSync, openSync, renameSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SnapshotError extends Error {
  override name = "SnapshotError";
}

/** `VACUUM INTO` from a read-only connection: one consistent file whatever the WAL holds, with the daemon running or not. */
export function snapshotDatabase(dbPath: string, outPath: string): void {
  if (existsSync(outPath)) throw new SnapshotError("the snapshot file exists");
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  const temp = `${outPath}.tmp`;
  rmSync(temp, { force: true });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("VACUUM INTO ?").run(temp);
    db.close();
    db = undefined;
    chmodSync(temp, 0o600);
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, outPath);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // the original error is the one to report
    }
    rmSync(temp, { force: true });
    throw new SnapshotError(`snapshot failed: ${(error as { code?: string }).code ?? "error"}`);
  }
}

/** The migration ids a database holds, or null when it cannot be read or is damaged. */
export function schemaIds(dbPath: string): string[] | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== "ok") return null;
    const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[];
    return rows.map((row) => row.id);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing left to do
    }
  }
}

/**
 * Puts a snapshot in place of `state.db`. Preconditions the caller holds: the daemon is stopped (instance lock or a
 * stopped unit). The snapshot is verified first; the stale -wal and -shm of the database being replaced are removed BEFORE
 * the rename, because a leftover WAL replayed onto a different database corrupts it; the new file is flushed, then renamed.
 */
export function restoreDatabaseFile(snapshotPath: string, home: string, knownIds: ReadonlySet<string>): void {
  const ids = schemaIds(snapshotPath);
  if (ids === null) throw new SnapshotError("the snapshot is damaged: nothing was restored");
  if (ids.some((id) => !knownIds.has(id)))
    throw new SnapshotError("the snapshot was written by a newer pap: nothing was restored");
  const target = join(home, "state.db");
  const temp = `${target}.restore-${process.pid}`;
  rmSync(temp, { force: true });
  copyFileSync(snapshotPath, temp, 1 /* COPYFILE_EXCL */);
  try {
    chmodSync(temp, 0o600);
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new SnapshotError(`restore failed: ${(error as { code?: string }).code ?? "error"}`);
  }
  const dir = openSync(home, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
```

The no-write open of the database (the doctor's `schema` check, M6b-RT-06; run in scratch: a plain read-only open of a clean WAL-mode `state.db` created `state.db-shm` and `state.db-wal`, the URI form below created nothing):

```ts
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * Opens `state.db` so that nothing is created next to it. Lock held (the daemon runs, so its -shm and -wal exist): a plain
 * read-only connection. No lock and no -wal: the immutable URI (SQLite then neither looks for nor creates a -wal or -shm).
 * No lock and a leftover -wal: null, the log is applied at the next start and a read-only open would have to create a -shm.
 */
export function openNoWrite(dbPath: string, lockHeld: boolean): DatabaseSync | null {
  if (lockHeld) return new DatabaseSync(dbPath, { readOnly: true });
  if (existsSync(`${dbPath}-wal`)) return null;
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro&immutable=1`, { readOnly: true });
}
```

`schemaStatus` with `noWrite` calls `openNoWrite`, returns `unread` for `null`, and otherwise runs the same `integrity_check` and `schema_migrations` read as `schemaIds`.

The operation lock (M6bR51, M6b-RT-11; run in scratch: a second holder is refused with the pid, release removes the file, a dead pid and a recycled pid are replaced):

```ts
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export class OpLockBusy extends Error {
  override name = "OpLockBusy";
}

/** Field 22 of /proc/<pid>/stat (start time in ticks): with the pid it names one process, so a recycled pid is not mistaken for the holder. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * One update, rollback, recover or restore at a time per home: `update/op.lock` holds `<pid> <start time>`, created with `wx`.
 * A file whose process is gone (or whose pid now belongs to another process) is stale and replaced. Returns the release function.
 */
export function acquireOpLock(home: string, pid = process.pid, startOf: (pid: number) => string | null = processStart): () => void {
  const dir = join(home, "update");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "op.lock");
  const mine = `${pid} ${startOf(pid) ?? ""}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const [holder, started = ""] = readFileSync(path, "utf8").trim().split(" ");
    const owner = Number(holder);
    if (Number.isInteger(owner) && owner > 0 && startOf(owner) !== null && startOf(owner) === started)
      throw new OpLockBusy(`another pap update, rollback, recover or restore is running (pid ${owner})`);
    rmSync(path, { force: true });
  }
  throw new OpLockBusy("another pap update, rollback, recover or restore is starting");
}
```

`systemctl` argument lists added to `createSystemd` (fixed, validated by `unitName`):

```ts
activeState: async (unit) => {
  const { code, stdout } = await run(env, "systemctl", ["--user", "show", "-p", "ActiveState", "--value", unitName(unit)], timeout);
  return code === 0 && /^[a-z-]{1,32}$/.test(stdout.trim()) ? stdout.trim() : null;
},
restartCount: async (unit) => {
  const { code, stdout } = await run(env, "systemctl", ["--user", "show", "-p", "NRestarts", "--value", unitName(unit)], timeout);
  return code === 0 && /^\d{1,6}$/.test(stdout.trim()) ? Number(stdout.trim()) : null;
},
cat: async (unit) => (await must("systemctl", ["--user", "cat", unitName(unit)], "cat")).slice(0, 65_536),
```

- [ ] **Step 1: Write the failing tests** (RED first; name them as listed).
  - `snapshot.test.ts`: (a) a database in WAL mode with an open writer and an uncheckpointed row: the snapshot has the row, mode `0600`, `integrity_check` ok; (b) an existing `outPath` is refused and left untouched; (c) a missing source throws `SnapshotError` and leaves no `.tmp`; (d) `schemaIds` returns the sorted ids, `null` for a file that is not a database and for a database whose `integrity_check` fails (a page flipped in a copy); (e) `restoreDatabaseFile` with an id not in `knownIds` throws and `state.db` is unchanged; with a damaged snapshot throws and `state.db` is unchanged; success removes a planted `state.db-wal` and `state.db-shm` BEFORE the rename (assert by a snapshot whose rows differ from the planted WAL, and that the restored rows are the snapshot's), leaves mode `0600`, and no `.restore-*` file.
  - `schema-status.test.ts`: absent, damaged (garbage file), current, pending (known has one more id), newer (db has an unknown id), and that the file is not created for `absent`. **`noWrite` (M6b-RT-06):** a WAL-mode `state.db` closed cleanly: with `lockHeld: false` the status is `current` and the folder listing is identical before and after (no `-wal`, no `-shm`); with a planted `state.db-wal` and `lockHeld: false` the state is `unread` and nothing is opened; with `lockHeld: true` and a live writer connection the ids are read and nothing new appears.
  - `paths.test.ts`: `writeJsonAtomic` creates the parent `0700` and the file `0600`, no `.tmp` left on a thrown `JSON.stringify` (circular value); `readJsonBounded` returns null (absent), `"damaged"` (not JSON, wrong shape, larger than the cap) and the value; `readLockPid` over a lock file written by the real `acquireInstanceLock`.
  - `op-lock.test.ts`: a second `acquireOpLock` on the same home throws `OpLockBusy` naming the pid; release removes the file and a third acquire works; a stale file whose pid is not alive is replaced; a file whose pid is alive but whose start time differs (recycled pid) is replaced; a release function called twice, or after another holder replaced the file, never removes the other holder's file; the file is `0600` in a `0700` folder.
  - `target.test.ts` (M6bR50): `--unit` over `PAP_UNIT` over `pap.service`; `bad name`, `../x.service`, a name above 64 characters and `a b.service` are usage errors; the home order flag, environment, unit, default (`homeSource` says which); `mismatch()` is a sentence when the unit's home is `/x` and the environment says `/y` without `--home`, null with `--home`, null with no unit, null when they are equal.
  - `unit-read.test.ts`: round trip over `renderUnit` for no flags, `port`, `home`, both; a drop-in text (`ExecStart=` empty line then a new one with `--tls-cert /x --tls-key /y --host 192.0.2.1`) gives `tls: true`, `host: "192.0.2.1"` and the later argv; `--insecure-http` gives `insecureHttp: true`; a unit with no `ExecStart` or a shell metacharacter in a path returns null; `Environment=PAP_HOME=...` read into `env` and `home`.
  - `systemd.m6b.test.ts`: the three methods against `fakeSystemd` answers, including `null` for garbage output and the exact argv in the `calls` file; with `unit: "pap-preview.service"` the journal reads select that unit and not `pap.service`.
  - `pi-dir.test.ts`: `piAgentDirFrom` default, `~/` expansion, relative path throws `ConfigError`.
- [ ] **Step 2: Run to verify RED** — `pnpm vitest run --project unit apps/daemon/src/cli/ops apps/daemon/src/cli/service/unit-read.test.ts apps/daemon/src/cli/service/systemd.m6b.test.ts apps/daemon/src/kernel/pi-dir.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** as above (the snapshot, no-write open and lock code are the contract; the rest follows the interfaces).
- [ ] **Step 4: GREEN** — same command — Expected: all pass.
- [ ] **Step 5: Mutation checks (real, restore after each):** (a) delete the `chmodSync(temp, 0o600)` line: test (a) mode fails; (b) swap the order of the two `rmSync(...-wal/-shm)` lines and the `renameSync` in `restoreDatabaseFile`: test (e) WAL case fails; (c) drop the `ids.some(...)` check: the newer-id case fails; (d) drop `readOnly: true` in `snapshotDatabase`: it still passes (record why: the read-only connection is a safety property, asserted by opening the source file read-only in the test `source is never written`, mode and mtime unchanged); (e) drop `&immutable=1` in `openNoWrite`: the unchanged-listing test fails; (f) make `acquireOpLock` skip the start-time comparison: the recycled-pid test fails; (g) drop `wx`: the second-holder test fails.
- [ ] **Step 6: Gates** — `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit` — Expected: green.
- [ ] **Step 7: Commit** — `git commit -m "feat(ops): database snapshot and restore primitives, operation lock, unit and home resolution, schema status, unit reader and systemd reads"`

---

### Task 2: Feed schema and the bounded fetcher [base]

**Files:**
- Create: `apps/daemon/src/cli/update/feed.ts`, `feed.test.ts`, `fetch.ts`, `fetch.test.ts`

**Interfaces:**
- Consumes: zod, global `fetch` (injected in tests).
- Produces (frozen; T9 and T14 import these):
  - `CHANNELS`, `type Channel`, `FEED_REPO`, `FEED_PATH_PREFIX`, `FEED_HOSTS: ReadonlySet<string>`, `isReleaseUrl(url)`, `FeedSchema`, `type Feed` — fields `format: 1`, `channel`, `version`, `releaseId`, `publishedAt`, `minNode`, `notes`, `installer {name,url,size,sha256}`, `archive {name,url,size}`.
  - `fetchLimited(url, { maxBytes, timeoutMs, userAgent, fetch?, signal? }): Promise<Uint8Array>`; `class FetchRefused { code: "scheme" | "host" | "redirects" | "status" | "too_large" | "timeout" | "network" }`; `type FetchLike`.

**Rulings (pre-dispatch):**
- **M6bR21, M6bR22 basis**: one allowlist of hosts for the feed and the assets, checked on every hop, and a byte cap enforced while reading. Why: this is the only outbound code M6b adds and it runs in the daemon (the background check) as well as the CLI. Cost if wrong: an open redirect or an unbounded read from the daemon process.
- The feed carries URLs, but they are only ever used after `FeedSchema` accepted them AND `fetchLimited` re-checks the host and the project path. Two checks on purpose. **M6bR57 (M6b-RT-15):** `FEED_HOSTS` alone is host-wide: a redirect from the project's release URL to `github.com/<other owner>/...` would pass, so `github.com` URLs must also start with `FEED_PATH_PREFIX`, one constant derived from `FEED_REPO`.
- A test passes its own `AbortSignal` (no real timer, no sleep).

**Security contracts (run in scratch against a stub `fetch`: plain, redirect to the CDN, redirect to a foreign host, to `http:`, a loop, 500 bytes with a cap of 100, 404, `http:` start, a port, user info, a foreign host; the schema with an extra key, a foreign host and a name that does not match the release id):**

```ts
import { z } from "zod";

export const CHANNELS = ["stable", "next"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The only project the feed may name; every `github.com` URL must be under its releases (one constant, M6bR57). */
export const FEED_REPO = "SoulKyu/pi-agentic-platform";
export const FEED_PATH_PREFIX = `/${FEED_REPO}/releases/`;

/** The only hosts a release asset may come from or be redirected to (GitHub Releases and its asset CDN). */
export const FEED_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** A project release URL: https, `github.com`, no credentials or port, under the project's own releases path. */
export function isReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname.startsWith(FEED_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const asset = (name: RegExp) =>
  z.strictObject({
    name: z.string().regex(name),
    url: z.string().max(512).url(),
    size: z.number().int().positive().max(1_073_741_824),
  });

/** `pap-feed-<channel>.json`: what `pap update` trusts after it has fetched it over HTTPS from a host in FEED_HOSTS. */
export const FeedSchema = z
  .strictObject({
    format: z.literal(1),
    channel: z.enum(CHANNELS),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/).max(64),
    releaseId: z.string().regex(ID),
    publishedAt: z.string().datetime(),
    minNode: z.string().regex(/^\d+\.\d+$/),
    notes: z.string().max(512).url(),
    installer: asset(/^pap-install-[A-Za-z0-9._-]{1,64}\.sh$/).extend({ sha256: z.string().regex(HEX64) }),
    archive: asset(/^pap-[A-Za-z0-9._-]{1,64}-linux-x64\.tar\.gz$/),
  })
  .superRefine((feed, ctx) => {
    if (feed.installer.name !== `pap-install-${feed.releaseId}.sh`)
      ctx.addIssue({ code: "custom", message: "installer name does not match the release id" });
    if (feed.archive.name !== `pap-${feed.releaseId}-linux-x64.tar.gz`)
      ctx.addIssue({ code: "custom", message: "archive name does not match the release id" });
    for (const url of [feed.installer.url, feed.archive.url, feed.notes]) {
      if (!isReleaseUrl(url)) ctx.addIssue({ code: "custom", message: "asset URL is not an https release URL of this project" });
    }
  });
export type Feed = z.infer<typeof FeedSchema>;
```

```ts
import { FEED_HOSTS, FEED_PATH_PREFIX } from "./feed.ts";

export class FetchRefused extends Error {
  override name = "FetchRefused";
  readonly code: "scheme" | "host" | "redirects" | "status" | "too_large" | "timeout" | "network";
  constructor(code: FetchRefused["code"]) {
    super(`download refused (${code})`);
    this.code = code;
  }
}

export type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const MAX_REDIRECTS = 3;

/**
 * GET with a deadline, an https-and-host check on EVERY hop (redirects are followed by hand), no cookies or credentials,
 * and a byte cap enforced while reading (a lying Content-Length changes nothing). The body is returned as bytes; it is never
 * logged and a failure carries a code only, never the remote text.
 */
export async function fetchLimited(
  start: string,
  options: { maxBytes: number; timeoutMs: number; userAgent: string; fetch?: FetchLike; signal?: AbortSignal },
): Promise<Uint8Array> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs); // a test passes its own, no real timer
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchRefused("scheme");
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") throw new FetchRefused("scheme");
    if (!FEED_HOSTS.has(parsed.hostname)) throw new FetchRefused("host");
    // The start is always a project release URL; a redirect that stays on github.com must stay under the project's releases.
    if ((hop === 0 && parsed.hostname !== "github.com") || (parsed.hostname === "github.com" && !parsed.pathname.startsWith(FEED_PATH_PREFIX)))
      throw new FetchRefused("host");
    let response: Response;
    try {
      response = await doFetch(parsed.href, { redirect: "manual", signal, headers: { "user-agent": options.userAgent } });
    } catch (error) {
      throw new FetchRefused((error as Error).name === "TimeoutError" || signal.aborted ? "timeout" : "network");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null || hop === MAX_REDIRECTS) throw new FetchRefused("redirects");
      url = new URL(location, parsed).href;
      continue;
    }
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw new FetchRefused("status");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > options.maxBytes) throw new FetchRefused("too_large"); // leaving the loop cancels the stream
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof FetchRefused) throw error;
      throw new FetchRefused(signal.aborted ? "timeout" : "network");
    }
    return Buffer.concat(chunks);
  }
  throw new FetchRefused("redirects");
}
```

- [ ] **Step 1: Tests (RED).** `feed.test.ts`: the good feed parses; each of these is refused: extra key, `format: 2`, version `1.0`, release id with `/`, installer name not `pap-install-<releaseId>.sh`, archive name not `pap-<releaseId>-linux-x64.tar.gz`, a `url` on `evil.example`, on `http:`, with a port, with user info, on `objects.githubusercontent.com` (a CDN is a redirect target, never a feed URL), under `/other-owner/pi-agentic-platform/releases/`, under `/SoulKyu/pi-agentic-platform-evil/releases/` (the prefix ends with a slash), `sha256` of 63 characters, `size` 0 or above 1 GiB, `notes` not a URL. `fetch.test.ts`: the eleven cases above with exact `code` values; plus: **a redirect from the project's release URL to `https://github.com/other-owner/x/releases/download/v1/a` is refused with `host`** (M6b-RT-15; reproduced as passing in the first draft), a redirect to the asset CDN with any path is accepted, a start URL on the CDN host is refused; the cap is enforced on a body streamed in 10 small chunks whose sum exceeds it (a lying `Content-Length` of 5 changes nothing); an aborted signal gives `timeout`; a fetch that throws gives `network` and the thrown message is NOT in `FetchRefused.message`; the request carries `redirect: "manual"`, the user agent and no `cookie`/`authorization` header (assert on the stub's init).
- [ ] **Step 2: RED** — `pnpm vitest run --project unit apps/daemon/src/cli/update` — Expected: FAIL.
- [ ] **Step 3: Implement** (the code above).
- [ ] **Step 4: GREEN** — same — Expected: pass.
- [ ] **Step 5: Mutation checks:** (a) remove the host check inside the loop (check only the first hop): "redirect evil" fails; (b) remove `parsed.port !== ""`: the port case fails; (c) replace the in-loop cap with a check of `Content-Length`: the chunked case fails; (d) remove `redirect: "manual"`: the init assertion fails; (e) drop the `FEED_PATH_PREFIX` check in the loop: the other-repository redirect case fails; (f) drop `isReleaseUrl` from `FeedSchema` (host check only): the other-owner path case fails.
- [ ] **Step 6: Gates** — `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit`.
- [ ] **Step 7: Commit** — `git commit -m "feat(update): release feed schema and a bounded https fetcher pinned to GitHub release hosts"`

---

## Lane 1 (backup, restore) and lane 2 (update)

### Task 3: `pap backup` (plain) [lane 1]

**Files:**
- Create: `apps/daemon/src/cli/backup/member-path.ts`, `member-path.test.ts`, `manifest.ts`, `collect.ts`, `create.ts`, `manifest.test.ts`, `collect.test.ts`, `create.test.ts`, `apps/daemon/src/cli/backup.ts`, `backup.int.test.ts`, `docs/agents/backup.md` (first section)
- Modify: `apps/daemon/src/cli/run-cli.ts`, `usage.ts` (one line each), `knip.json` (`tar`)

**Interfaces:**
- Consumes: T1 (`snapshotDatabase`, `schemaIds`, `writeJsonAtomic`, `installRoot`, `resolveTarget`/`mismatch`), `piAgentDirFrom` (`kernel/pi-dir.ts`), `homeFrom`, `listMembers` is NOT imported (it is T5a, later in this lane; the plain self-check is wired in T5a's last step, see M6bR55). `prepareHome` is NOT called (a backup creates nothing in the home except `backups/` and `update/` through `mkdirSync` with 0700).
- Produces:
  - `safeMemberPath(name): string`, `class UnsafeArchiveError` (`member-path.ts`, full code below; T5a imports them, so `collect` never depends on a later task's file).
  - `ManifestSchema`, `type Manifest`, `secretsAllowed(options)` (below).
  - `collect(root, top, limit?, fs?): Collected` (below).
  - `createBackup(deps: BackupDeps): Promise<BackupResult>` where `BackupDeps = { home, piDir, outDir, now: Date, papVersion, secrets: "exclude" | "include", skip: ReadonlySet<"attachments" | "agents" | "exports" | "pi">, allowLarge: boolean, keep?: number, selfCheck?: (file: string) => Promise<void> /* wired in T5a */, encrypt?: (plain: Readable, outPath: string) => Promise<void> /* T4 */ }` and `BackupResult = { path, bytes, encrypted, tops, skipped: {links, names, changed}, examples: string[], secretsIncluded: boolean, tarChanged: boolean, pruned: number }`.
  - `tarCreateArgs(stage, home, homeList, piDir, piList): string[]` (below).
  - Command `backup`: `pap backup [--out <abs dir>] [--skip <attachments|agents|exports|pi>]... [--allow-large] [--keep N] [--unit <name>] [--home <abs dir>]`. (T4 adds `--secrets`, `--encrypt`, `--passphrase-stdin`.) The home is resolved by `resolveTarget` and printed with its source; it is refused when an installed unit's home differs from it and `--home` was not given (M6bR50).

**Rulings (pre-dispatch):** M6bR1, M6bR2, M6bR3, M6bR4, M6bR9, M6bR49, M6bR50, M6bR55. Plus:
- **M6bR3a** The payload gate: total regular-file bytes over all collected tops above **2 GiB** refuses unless `--allow-large`, printing each top's size. A single file above 8 GiB - 1 (what a ustar size field holds; the restore reader refuses a pax `size`) is refused even with `--allow-large`, naming the file. Why: a surprise 40 GB archive filling the disk; the owner can `--skip` a top. Cost: one extra flag on a big home.
- **M6bR3b** The disk gate: free space at `outDir` below `payload bytes / 2 + state.db bytes + 64 MB` refuses before anything is written (gzip makes the payload smaller, the estimate is conservative). Free space unknown passes (as `diskFloor`).
- **M6bR3c** The archive is created to `<name>.part` with `wx` and mode `0600`, renamed on success, removed on any failure; a name that exists is refused. Plain archives pass the `selfCheck` (T5a's `listMembers` on the finished `.part`) before the rename.
- **M6bR3d (M6b-RT-04)** `collect` counts what it leaves out, never stops quietly: a name the restore reader would refuse (including a name that is not UTF-8) is checked BEFORE the `lstat` and counted in `skippedNames`; a symlink or special file in `skippedLinks`; an entry that vanishes between the listing and the `lstat` (a live daemon deletes files) in `changed`; any other error (`EACCES`) is thrown and the backup fails. Only a missing TOP is silent.
- A backup needs no instance lock and does not stop the daemon: `state.db` is a consistent snapshot; the other files are copied as they are (each is replaced atomically by its writer; said in the docs). GNU tar exit 1 ("file changed as we read it") is accepted with the M6bR55 summary line.

**Security contracts (run in scratch: the walk skips a symlink and a name with a newline and counts them, a non-UTF-8 name and a vanished file are counted and the rest of the folder is still collected; a manifest parses; `secrets` is allowed only for encrypted include; the tar argument list with two `-C` roots and a `--transform` for the Pi folder produced exactly the member names `manifest.json`, `state.db`, `agents/...`, `pi-agent/sessions/...`):**

```ts
export class UnsafeArchiveError extends Error {
  override name = "UnsafeArchiveError";
}

const MAX_PATH = 1024;

/**
 * A member name that stays inside the folder it is extracted to: relative, no `..`, no empty or `.` part, no NUL, no control,
 * format or line-separator character, and no U+FFFD (what Node shows for bytes that are not UTF-8: tar would write the raw bytes).
 */
export function safeMemberPath(name: string): string {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path === "" ||
    path.length > MAX_PATH ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFFFD]/u.test(path)
  )
    throw new UnsafeArchiveError("the archive holds a path that is not safe");
  return path;
}
```

```ts
import { z } from "zod";

/** `schema_migrations` ids look like `kernel/202610100000_init.sql` or `<module>/<stamp>_<name>.sql`. */
const MIGRATION_ID = /^[a-z0-9_-]{1,40}\/\d{12}_[a-z0-9_]{1,80}\.sql$/;

/** The first member of every backup. Strict: an unknown key means a newer format and is refused, never ignored. */
export const ManifestSchema = z.strictObject({
  format: z.literal(1),
  papVersion: z.string().max(64),
  createdAt: z.string().datetime(),
  /** Migration ids `state.db` held when the snapshot was taken. */
  schema: z.array(z.string().regex(MIGRATION_ID)).max(5000),
  stateDb: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }),
  /** `included` only in an encrypted backup. */
  secrets: z.enum(["excluded", "included"]),
  /** Top-level names present besides `manifest.json` and `state.db`. */
  tops: z.array(z.enum(["attachments", "agents", "exports", "secrets", "pi-agent"])).max(5),
  skipped: z.strictObject({ links: z.number().int().nonnegative(), names: z.number().int().nonnegative(), changed: z.number().int().nonnegative() }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** `secrets/` goes in only when the backup is encrypted AND the owner asked; one function so no caller can forget the rule. */
export function secretsAllowed(options: { secrets: "exclude" | "include"; encrypt: boolean }): boolean {
  return options.secrets === "include" && options.encrypt;
}
```

```ts
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { safeMemberPath } from "./member-path.ts";

export interface Collected {
  /** Relative to the root they were collected from, folders first as the walk meets them. */
  readonly entries: string[];
  readonly bytes: number;
  readonly skippedLinks: number;
  readonly skippedNames: number;
  /** Entries that disappeared (or could not be listed) between the directory listing and the lstat: a live daemon deletes files. */
  readonly changed: number;
  /** The first few skipped paths, clipped, for the summary. */
  readonly examples: string[];
}

export interface WalkFs {
  lstat(path: string): Pick<Stats, "isDirectory" | "isFile" | "size">;
  readdir(path: string): string[];
}

const realFs: WalkFs = { lstat: lstatSync, readdir: (path) => readdirSync(path) };
/** A pax `size` record is refused by the restore reader, so a file above the ustar limit (8 GiB - 1) could never be restored. */
const MAX_FILE = 8 * 1024 ** 3 - 1;
const gone = (error: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * Walks `root/<top>` with lstat: folders and regular files only. A symbolic link, socket, FIFO or device is skipped and
 * counted (the restore reader refuses them); so is a name the restore reader would refuse, which is checked BEFORE the lstat
 * (Node shows a name that is not UTF-8 as U+FFFD, and the lstat of that rebuilt path fails). Only a missing TOP is silent;
 * an entry that vanishes mid-walk is counted in `changed`, never a reason to stop and report success. Never follows a link,
 * never reads a file. `limit` stops a runaway tree.
 */
export function collect(root: string, top: string, limit = 1_000_000, fs: WalkFs = realFs): Collected {
  const entries: string[] = [];
  const examples: string[] = [];
  let bytes = 0;
  let skippedLinks = 0;
  let skippedNames = 0;
  let changed = 0;
  const note = (path: string): void => {
    if (examples.length < 5) examples.push(path.length > 80 ? `${path.slice(0, 77)}...` : path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?"));
  };
  const visit = (relative: string, isTop: boolean): void => {
    try {
      safeMemberPath(relative);
    } catch {
      skippedNames++;
      note(relative);
      return;
    }
    let stat: ReturnType<WalkFs["lstat"]>;
    try {
      stat = fs.lstat(join(root, relative));
    } catch (error) {
      if (!gone(error)) throw error;
      if (!isTop) {
        changed++;
        note(relative);
      }
      return;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      skippedLinks++;
      note(relative);
      return;
    }
    if (stat.isFile() && stat.size > MAX_FILE) throw new Error(`a file above 8 GiB cannot be backed up: ${relative}`);
    if (entries.length >= limit) throw new Error("too many files");
    entries.push(relative);
    if (stat.isFile()) {
      bytes += stat.size;
      return;
    }
    let names: string[];
    try {
      names = fs.readdir(join(root, relative)).sort();
    } catch (error) {
      if (!gone(error)) throw error;
      changed++;
      note(relative);
      return;
    }
    for (const name of names) visit(`${relative}/${name}`, false);
  };
  visit(top, true);
  return { entries, bytes, skippedLinks, skippedNames, changed, examples };
}
```

```ts
/** GNU tar, no shell. Two lists (`\0`-separated, relative to their root), the Pi folder renamed on the way in. */
export const tarCreateArgs = (stage: string, home: string, homeList: string, piDir: string, piList: string): string[] => [
  "--format=pax", "--owner=0", "--group=0", "--numeric-owner", "--no-recursion", "--create", "--gzip", "--file", "-",
  "-C", stage, "manifest.json", "state.db",
  "-C", home, "--null", "--files-from", homeList,
  "-C", piDir, "--transform", "s,^sessions,pi-agent/sessions,", "--null", "--files-from", piList,
];
```

- [ ] **Step 1: Tests (RED).**
  - `member-path.test.ts`: relative, nested, a trailing slash accepted; `..`, `a/../b`, `./a`, `a//b`, an absolute name, a NUL, a newline, a bidi override (U+202E), a line separator (U+2028), U+FFFD, 1025 characters refused with the one fixed message.
  - `manifest.test.ts`: strict (an extra key, `format: 2`, a bad migration id, `secrets: "included"` with a `tops` list that lacks `secrets` are refused — the last by a `superRefine` the implementer adds: `secrets: "included"` requires `tops` to contain `"secrets"` and vice versa); `skipped` carries `links`, `names` and `changed`; `secretsAllowed` truth table (only include+encrypt).
  - `collect.test.ts`: the scratch cases (symlink, newline name, nested folder with a space, a missing top returns empty without throwing and without counting), the `limit` throws `too many files`, a directory symlink is never followed (a link to `/etc` is skipped and `/etc` is not listed). **M6b-RT-04:** a file name that is not valid UTF-8 (create it with a `Buffer` path) sorting early is counted in `skippedNames` and the later siblings are STILL collected (RED on the first draft: they were dropped with `skippedNames: 0`); a file that vanishes between `readdir` and `lstat` (inject `WalkFs`) is counted in `changed` with its path in `examples` and the rest is collected; a folder that vanishes between listing and `readdir` is counted in `changed`; an `EACCES` from `lstat` throws; a file whose size is above 8 GiB - 1 (inject a fake `lstat`) throws naming the file.
  - `create.test.ts` (temp home and temp Pi folder, fake clock): the archive's member list (read with `tar -tzf`) is exactly `manifest.json`, `state.db`, then the home tops, then `pi-agent/sessions/...`; `secrets/` is NOT in the list with `secrets: "exclude"` even when it exists and holds `vault/key` and `push/vapid.json`; `auth.json` of the Pi folder is never listed; the manifest's `stateDb.sha256` equals the sha256 of the extracted `state.db`; `schema` equals `schemaIds`; the archive mode is `0600`; the output folder is `0700`; a second run with the same fake timestamp is refused (`wx`); a payload above the gate refuses with the per-top sizes and creates no file in `outDir`; a disk estimate above free space (injected `freeMb`) refuses before the snapshot; a thrown tar (fake `tar` first on `PATH` exiting 2 with `SECRET-STDERR`) leaves no `.part`, no stage folder, and the message does not contain `SECRET-STDERR`; **a fake `tar` exiting 1 is accepted** and the result has `tarChanged: true`; `last-backup.json` is written (0600) only on success; an injected `selfCheck` that throws removes the `.part` and the message says the archive failed its own check; `--keep 2` with four older `pap-backup-*` files and one file named `notes.txt` removes the two oldest `pap-backup-*` only, never the new file and never `notes.txt`.
  - The summary text (a fixed string, asserted whole): it contains "The secrets folder is not included. Transcripts and agent files may still contain secrets: treat this file as sensitive, and use --encrypt before copying it off this machine.", the home line with its source, both lists, `copy this file off this machine`, the skipped counts with examples, and (with `tarChanged`) the M6bR55 sentence. With `skipped.links > 0` it adds that symbolic links, including those inside git working trees under `agents/`, are not in the backup.
  - `backup.int.test.ts` (spawns `main.ts backup` in a temp `HOME` with a real `state.db` made by `migrate`): exit 0, the summary names the secrets sentence and the copy-off sentence, the file exists, running while a second process holds the instance lock still succeeds; with an installed unit text whose `--home` differs from the environment's `PAP_HOME` and no `--home`, exit 1 with both paths named and no file written.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** The summary is fixed text: path, size, home and its source, what is in, what is not (the M6bR3 lists), `secrets: not included (use --secrets include with --encrypt)`, the sensitivity sentence above, `copy this file off this machine`, and the count and first examples of skipped links, names and changed entries.
- [ ] **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/backup apps/daemon/src/cli/backup.test.ts && pnpm vitest run --project integration apps/daemon/src/cli/backup.int.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) make `secretsAllowed` return true for include without encrypt: the truth-table and the "no secrets in a plain backup" create test fail; (b) remove the `lstat` (use `statSync`): the link case follows `/etc`; (c) drop `chmod`/mode `0o600` on `.part`: the mode test fails; (d) drop the `.part` cleanup: the failed-tar test fails; (e) wrap the whole walk in the first draft's `try { visit(top) } catch ENOENT`: the non-UTF-8 and vanished-file tests fail; (f) move the `safeMemberPath` check after the `lstat`: the non-UTF-8 test fails; (g) let `--keep` match any file name: the `notes.txt` test fails.
- [ ] **Step 6: Gates** — lint, format, typecheck, knip, unit, then the one int file; Expected: green.
- [ ] **Step 7: Commit** — `git commit -m "feat(backup): pap backup writes one consistent archive of state.db, folders and Pi sessions, secrets excluded"`

---

### Task 4: Encrypted backups and the secrets rule [lane 1]

**Files:**
- Create: `apps/daemon/src/cli/backup/crypto.ts`, `crypto.test.ts`
- Modify: `apps/daemon/src/cli/backup.ts` (flags `--secrets`, `--encrypt`, `--passphrase-stdin`), `create.ts` (pass the `encrypt` function), tests

**Interfaces:**
- Consumes: T3 (`createBackup`, `secretsAllowed`), `readSecret` (`cli/read-secret.ts`).
- Produces: `encryptStream(plain: Readable, outPath: string, passphrase: string): Promise<void>`, `decryptFile(inPath: string, outPath: string, passphrase: string): Promise<void>`, `MIN_PASSPHRASE = 12`, `class BackupCryptoError` (T5b uses `decryptFile`). Backup flags: `--secrets exclude|include` (default `exclude`), `--encrypt`, `--passphrase-stdin`.

**Rulings (pre-dispatch):** M6bR2, M6bR5. Plus:
- **M6bR5a** `--secrets include` without `--encrypt` is a usage error (exit 64) whose message says why; `--encrypt` alone encrypts and still excludes secrets. Why: the choice is the owner's (owner b1) and a plain file never carries the vault key.
- **M6bR5b** Passphrase input: on a TTY, prompted twice (must match); with `--passphrase-stdin`, the first line of standard input. Never read from an argument or the environment. The prompt text says: "This passphrase protects the backup file; pap cannot recover it."
- **M6bR5c** Encrypted output name `pap-backup-<stamp>.tar.gz.enc`; the container is created with `wx` and `0600` and removed on any failure.
- **M6bR5d** An encrypted backup is written straight from the tar stream and never exists in plain on disk, so it is not re-read at creation (M6bR55); `pap restore` re-validates everything. With `--passphrase-stdin` the passphrase is the first line of standard input only.

**Security contract (run in scratch: 3 MB round trip, mode 0600, wrong passphrase, one flipped byte, an out-of-range cost field, a short passphrase; nothing is left on disk on any failure):**

```ts
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/** `PAPB1\n`, the scrypt cost (log2 N, r, p), the salt and the IV; the whole header is the GCM additional data. */
const MAGIC = Buffer.from("PAPB1\n", "latin1");
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + 3 + SALT + IV;
const LOG2_N = 17;
const R = 8;
const P = 1;
/** A header names its own cost before anything authenticates it: bound it, or a forged file costs minutes of CPU and gigabytes. */
const MAX_LOG2_N = 18;
const MIN_LOG2_N = 14;
export const MIN_PASSPHRASE = 12;

export class BackupCryptoError extends Error {
  override name = "BackupCryptoError";
}

const derive = (passphrase: string, salt: Buffer, log2n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(
      Buffer.from(passphrase.normalize("NFKC"), "utf8"),
      salt,
      32,
      { N: 2 ** log2n, r, p, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(new BackupCryptoError("key derivation failed")) : resolve(key)),
    ),
  );

/** Encrypts `plain` into `outPath` (mode 0600, `wx`: never over an existing file). The tag is the last 16 bytes. */
export async function encryptStream(plain: Readable, outPath: string, passphrase: string): Promise<void> {
  if ([...passphrase].length < MIN_PASSPHRASE)
    throw new BackupCryptoError(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const header = Buffer.concat([MAGIC, Buffer.from([LOG2_N, R, P]), salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", await derive(passphrase, salt, LOG2_N, R, P), iv, {
    authTagLength: TAG,
  });
  cipher.setAAD(header);
  const out = createWriteStream(outPath, { flags: "wx", mode: 0o600 });
  out.write(header);
  try {
    await pipeline(plain, cipher, out, { end: false });
    out.write(cipher.getAuthTag());
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (error) {
    out.destroy();
    rmSync(outPath, { force: true });
    throw error;
  }
}

/** Decrypts `inPath` into `outPath` (0600, `wx`). Nothing from a file that fails authentication stays on disk. */
export async function decryptFile(inPath: string, outPath: string, passphrase: string): Promise<void> {
  const fd = openSync(inPath, "r");
  let header: Buffer;
  let tag: Buffer;
  let size: number;
  try {
    size = fstatSync(fd).size;
    if (size < HEADER + TAG) throw new BackupCryptoError("not a pap encrypted backup");
    header = Buffer.alloc(HEADER);
    readSync(fd, header, 0, HEADER, 0);
    tag = Buffer.alloc(TAG);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupCryptoError("not a pap encrypted backup");
  const [log2n = 0, r = 0, p = 0] = header.subarray(MAGIC.length, MAGIC.length + 3);
  if (log2n < MIN_LOG2_N || log2n > MAX_LOG2_N || r !== R || p !== P)
    throw new BackupCryptoError("not a pap encrypted backup");
  const salt = header.subarray(MAGIC.length + 3, MAGIC.length + 3 + SALT);
  const iv = header.subarray(MAGIC.length + 3 + SALT);
  const decipher = createDecipheriv("aes-256-gcm", await derive(passphrase, salt, log2n, r, p), iv, {
    authTagLength: TAG,
  });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(inPath, { start: HEADER, end: size - TAG - 1 }),
      decipher,
      createWriteStream(outPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    rmSync(outPath, { force: true });
    // GCM reports a wrong passphrase and a changed file the same way, by design: the message says both.
    if (error instanceof BackupCryptoError) throw error;
    throw new BackupCryptoError("wrong passphrase, or the backup was changed or damaged");
  }
}
```

- [ ] **Step 1: Tests (RED).** `crypto.test.ts` (use a low-cost path only if the code exposes one: it does not; scrypt N=2^17 takes about 0.4 s, six tests are fine): round trip equals the input byte for byte; mode `0600`; wrong passphrase and a flipped ciphertext byte BOTH give the same message and leave no output file; a flipped header byte (in the salt, in the cost field) fails the same way (the header is additional data); a truncated file (cut inside the tag) fails; a file shorter than header + tag says "not a pap encrypted backup"; cost field outside 14..18 is refused BEFORE a key is derived (assert by a spy on `crypto.scrypt` not being called); passphrase under 12 characters refused on encrypt; an existing output path is refused (`wx`); NFKC: the same text composed and decomposed derives the same key.
  `backup` command tests: `--secrets include` alone exits 64; `--encrypt --secrets include --passphrase-stdin` with stdin `correct horse battery` produces a `.enc` file whose decrypted tar contains `secrets/vault/key`; the plain output of `--encrypt` without include does not; the `.enc` file does not contain the plain bytes of the key (grep the raw bytes); the passphrase is not in `process.argv`, in the environment of the spawned `tar`, or in the output.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/backup`.
- [ ] **Step 5: Mutation checks:** (a) remove `cipher.setAAD(header)`: the flipped-salt case fails; (b) drop the cost bound: the spy test fails; (c) replace `flags: "wx"` with `"w"`: the existing-path test fails; (d) skip `rmSync(outPath)` in the decrypt catch: the leftover-file assertions fail.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(backup): encrypted backups (scrypt + AES-256-GCM) and the secrets-only-when-encrypted rule"`

---

### Task 5a: The untrusted-archive reader, the stage walk and placement [lane 1]

**Files:**
- Create: `apps/daemon/src/cli/backup/tar-list.ts`, `verify-stage.ts`, `place.ts`, `tar-list.test.ts`, `tar-list.hostile.test.ts`, `verify-stage.test.ts`, `place.test.ts`
- Modify: `apps/daemon/src/cli/backup.ts` (wire the plain `selfCheck` of T3 to `listMembers`), `docs/agents/backup.md`

**Interfaces:**
- Consumes: T1 (`snapshotDatabase`), T3 (`safeMemberPath`, `UnsafeArchiveError`).
- Produces (frozen; T5b imports these): `listMembers(file, limits): Promise<Member[]>`, `type Member`, `type ListLimits`, `assertPlainTree(root, limit?): number`, `ownerOnly(root): void`, `placeRestored(home, extracted, stamp, tops)`, `HOME_TOPS`, `class PlaceError`.

**Rulings (pre-dispatch):** M6bR6 (the three layers), M6bR7. Plus:
- **M6bR6c** The reader accepts exactly what `tar --format=pax --owner=0 --group=0 --numeric-owner` writes for a backup and nothing else. Measured on this host with GNU tar 1.35: a regular file or folder gets a pax header with `path` (only when the name is long) and the three times `mtime`, `atime`, `ctime`; no other record appears. So the allowlist is exactly those four keys; anything else is not "ignored", it is a refusal. Why: the first draft ignored unknown records, and a `size` record is how a hidden symlink member got past the reader.
- **M6bR6d** `assertPlainTree` and `ownerOnly` are separate on purpose and run in this order, with nothing reading an extracted file in between. `ownerOnly` keeps the owner bits (`mode & 0o700`), makes files at least 0600 and folders 0700; it never follows a link (the walk has already proved there is none).

**Security contracts (run in scratch against real GNU tar archives: plain, long pax names, a symlink, a hard link, `..`, an absolute name, a FIFO, a newline name, `--pax-option` records `size`, `linkpath`, `uid`, `hdrcharset`, a sparse file with `-S`, and the hidden-symlink and hidden-hard-link members built with `--pax-option='size:=0'`; results in "Scratch results after the fix"):**

```ts
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { safeMemberPath, UnsafeArchiveError } from "./member-path.ts";

export { safeMemberPath, UnsafeArchiveError };

export interface Member {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
}

export interface ListLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

const BLOCK = 512;
const MAX_PAX = 64 * 1024;
const bad = (): UnsafeArchiveError => new UnsafeArchiveError("unreadable tar header");

const field = (block: Buffer, from: number, length: number): string => {
  const raw = block.subarray(from, from + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
};

const octal = (block: Buffer, from: number, length: number): number => {
  const text = field(block, from, length).trim();
  if (!/^[0-7]{1,12}$/.test(text)) throw bad();
  return Number.parseInt(text, 8);
};

/** The header checksum (offset 148, eight bytes) is the sum of the block with that field read as spaces; tar accepts the signed sum too. */
function checksumOk(block: Buffer): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  const stored = octal(block, 148, 8);
  return stored === unsigned || stored === signed;
}

/** What GNU tar writes with `--format=pax` for the files a backup holds: the name and the three times. Nothing else is accepted. */
const PAX_TIME = new Set(["mtime", "atime", "ctime"]);

/**
 * The records of a pax extended header (`<len> <key>=<value>\n`). Returns the `path`, if any. Every key other than `path`,
 * `mtime`, `atime` and `ctime` refuses the archive: `size` would make GNU tar read a different length than the ustar header
 * says (a member's content would be parsed as headers), and `linkpath`, `GNU.*`, `hdrcharset`, `uid`... change what tar
 * extracts. A repeated key refuses too.
 */
function paxPath(body: Buffer): string | null {
  let at = 0;
  let found: string | null = null;
  const seen = new Set<string>();
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) throw bad();
    const length = Number.parseInt(body.subarray(at, space).toString("latin1"), 10);
    if (!Number.isInteger(length) || length < 4 || at + length > body.length || body[at + length - 1] !== 0x0a) throw bad();
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq < 1) throw bad();
    const key = record.slice(0, eq);
    if (seen.has(key)) throw new UnsafeArchiveError("the archive repeats an extended header record");
    seen.add(key);
    if (key === "path") found = record.slice(eq + 1);
    else if (!PAX_TIME.has(key)) throw new UnsafeArchiveError("the archive uses an extended header record this reader does not accept");
    at += length;
  }
  return found;
}

/**
 * Reads the member headers of a gzip tar written with `--format=pax` WITHOUT extracting anything. Layer 1 of three (the
 * others: the `tar` flags and the post-extract walk): only regular files and folders are accepted, every header checksum
 * must match, only `path` and the times are accepted in an extended header, a name is listed once and never below a file,
 * and the archive must end with its two zero blocks. Bounded in entries and in declared bytes.
 */
export async function listMembers(file: string, limits: ListLimits): Promise<Member[]> {
  const members: Member[] = [];
  const kinds = new Map<string, "file" | "dir">();
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let skip = 0;
  let collect: { size: number; chunks: Buffer[] } | null = null;
  let nextPath: string | null = null;
  let havePax = false;
  let zeroBlocks = 0;

  const header = (block: Buffer): void => {
    if (block.every((byte) => byte === 0)) {
      zeroBlocks++;
      return;
    }
    if (zeroBlocks > 0) throw new UnsafeArchiveError("data after the end of the archive");
    if (block.subarray(257, 262).toString("latin1") !== "ustar" || !checksumOk(block)) throw bad();
    const type = String.fromCharCode(block[156] ?? 0);
    const size = octal(block, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      if (size > MAX_PAX || havePax) throw bad();
      havePax = true;
      collect = { size, chunks: [] };
      skip = padded;
      return;
    }
    const prefix = field(block, 345, 155);
    const name = nextPath ?? (prefix === "" ? field(block, 0, 100) : `${prefix}/${field(block, 0, 100)}`);
    nextPath = null;
    havePax = false;
    if (type !== "0" && type !== "\0" && type !== "5")
      throw new UnsafeArchiveError("the archive holds a link, a device or another special member");
    const kind = type === "5" ? "dir" : "file";
    if (kind === "dir" && size !== 0) throw bad();
    const path = safeMemberPath(name);
    if (kinds.has(path)) throw new UnsafeArchiveError("the archive lists a name twice");
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (kinds.get(parts.slice(0, i).join("/")) === "file") throw new UnsafeArchiveError("the archive puts a member below a file");
    kinds.set(path, kind);
    members.push({ path, kind, size });
    bytes += size;
    if (members.length > limits.maxEntries || bytes > limits.maxBytes)
      throw new UnsafeArchiveError("the archive is larger than a backup can be");
    skip = padded;
  };

  const feed = (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (skip > 0) {
        const take = Math.min(skip, pending.length);
        if (collect !== null) collect.chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        skip -= take;
        if (skip > 0) return;
        if (collect !== null) {
          nextPath = paxPath(Buffer.concat(collect.chunks).subarray(0, collect.size));
          collect = null;
        }
        continue;
      }
      if (pending.length < BLOCK) return;
      header(Buffer.from(pending.subarray(0, BLOCK)));
      pending = pending.subarray(BLOCK);
    }
  };

  const gunzip = createGunzip();
  const source = createReadStream(file);
  await new Promise<void>((resolve, reject) => {
    source.on("error", reject);
    gunzip.on("error", () => reject(new UnsafeArchiveError("the archive is not a readable gzip tar")));
    gunzip.on("data", (chunk: Buffer) => {
      try {
        feed(chunk);
      } catch (error) {
        source.destroy();
        gunzip.destroy();
        reject(error);
      }
    });
    gunzip.on("end", resolve);
    source.pipe(gunzip);
  });
  if (skip > 0 || havePax || zeroBlocks < 2 || (pending.length > 0 && !pending.every((byte) => byte === 0)))
    throw new UnsafeArchiveError("the archive is cut short");
  return members;
}
```

The stage walk and the owner-only pass (layer 3; run in scratch against a real `tar -x` of the smuggle archive, where tar exits 2 but the symlink has already landed in the stage):

```ts
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UnsafeArchiveError } from "./member-path.ts";

/**
 * Layer 3: after `tar -x` and BEFORE any chmod or placement, every entry of the stage is lstat'ed. Anything that is not a
 * regular file or a folder (a symbolic link, a device, a FIFO), and any file with another hard link, refuses the restore.
 */
export function assertPlainTree(root: string, limit = 1_000_001): number {
  let count = 0;
  const visit = (path: string): void => {
    if (++count > limit) throw new UnsafeArchiveError("the extracted tree is larger than a backup can be");
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!stat.isFile() || stat.nlink > 1) {
      throw new UnsafeArchiveError("the extracted tree holds a link or a special file");
    }
  };
  visit(root);
  return count;
}

/** Owner-only, whatever the archive said: keeps the owner bits (`mode & 0o700`, so scripts stay executable), never grants more. Run after `assertPlainTree`. */
export function ownerOnly(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, (stat.mode & 0o700) | 0o700);
      for (const name of readdirSync(path)) visit(join(path, name));
    } else {
      chmodSync(path, (stat.mode & 0o700) | 0o600);
    }
  };
  visit(root);
}
```

Placement with undo (run in scratch: success with replaced folders, database snapshot, `search.db` removed; an unexpected top fails with the old folders moved back; the first draft skipped creating `pre-restore-<stamp>/` after the database snapshot and failed with ENOENT, which the test below pins):

```ts
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { snapshotDatabase } from "../ops/snapshot.ts";

/** What a restore may put into `$PAP_HOME`, in this order. `secrets` only when the manifest says it holds them. */
export const HOME_TOPS = ["attachments", "agents", "exports", "secrets"] as const;

export class PlaceError extends Error {
  override name = "PlaceError";
}

/**
 * Moves the verified tree in `extracted` into `home`. Everything it replaces is kept under `backups/pre-restore-<stamp>`
 * (the old database as a VACUUM INTO snapshot, folders by rename); a failure puts every folder it moved back, newest first.
 * Same file system by construction (`extracted` sits inside `home`), so every rename is atomic.
 */
export function placeRestored(
  home: string,
  extracted: string,
  stamp: string,
  tops: readonly string[],
): { keptDatabase: string | null; keptFolders: string | null } {
  const undo: Array<() => void> = [];
  const keep = join(home, "backups", `pre-restore-${stamp}`);
  let keptFolders = false;
  let keptDatabase: string | null = null;
  const aside = (name: string): string => {
    if (!keptFolders) {
      mkdirSync(keep, { recursive: true, mode: 0o700 });
      keptFolders = true;
    }
    return join(keep, name);
  };
  try {
    const db = join(home, "state.db");
    if (existsSync(db)) {
      keptDatabase = join(home, "backups", `pre-restore-${stamp}.db`);
      snapshotDatabase(db, keptDatabase);
    }
    for (const name of tops) {
      if (!(HOME_TOPS as readonly string[]).includes(name)) throw new PlaceError("unexpected folder in the backup");
      const from = join(extracted, name);
      if (!existsSync(from)) continue;
      const to = join(home, name);
      if (existsSync(to)) {
        const moved = aside(name);
        renameSync(to, moved);
        undo.push(() => renameSync(moved, to));
      }
      renameSync(from, to);
      undo.push(() => renameSync(to, from));
    }
    // The database last: it is the one replacement that cannot be undone by a rename (the old file is only a snapshot).
    for (const suffix of ["-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
    renameSync(join(extracted, "state.db"), db);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(home, `search.db${suffix}`), { force: true }); // a cache, rebuilt at boot
  } catch (error) {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {
        // the remaining steps still run; the pre-restore folder holds whatever could not be moved back
      }
    }
    throw error instanceof PlaceError ? error : new PlaceError(`restore failed while placing files (${(error as { code?: string }).code ?? "error"}); your previous data is under backups/`);
  }
  return { keptDatabase, keptFolders: keptFolders ? keep : null };
}
```

`restore.ts` validates `tops` against `HOME_TOPS` and the manifest BEFORE calling `placeRestored` (so a refusal never moves a folder).

- [ ] **Step 1: Tests (RED).**
  - `tar-list.test.ts` (real GNU `tar --format=pax --owner=0 --group=0 --numeric-owner` creates the archives in a temp dir): a good archive with a 180-character pax path, an executable script and empty folders lists the same names as `tar -t`; the symlink, hard link, FIFO, `../x`, absolute name and newline-name cases with the exact messages; a gzip stream cut in half says "not a readable gzip tar"; junk says the same; two zero blocks then data is refused; a pax header above 64 KiB is refused; `maxEntries` and `maxBytes` caps.
  - `tar-list.hostile.test.ts` (**M6b-RT-01**, each built with GNU tar; each is RED on the first draft's reader): (1) **the hidden symlink**: a member `agents/x` whose real content is a symlink header (`agents/evil -> /some/dir`) followed by a file header (`agents/evil/pwn`), archived with `--pax-option='size:=0'`: `listMembers` refuses with the unknown-record sentence, AND a control assertion in the same test that real `tar -x` of that archive does create the symlink (so the test fails loudly if GNU tar ever stops honouring the pax size and the case stops being a differential); (2) the hidden hard link variant (a type-1 header with link target `/etc/hostname` and a recomputed checksum); (3) one test per refused record: `size`, `linkpath`, `uid`, `hdrcharset`, a `GNU.sparse.*` record from a sparse file archived with `-S`; (4) a flipped byte in a header (bad checksum), a header without the `ustar` magic; (5) a pax header repeating `path`; two extended headers in a row; (6) a member below a file; a name listed twice; (7) an archive cut at a block boundary with no zero blocks ("cut short"); (8) a single file whose size field is base-256 (high bit set) is refused as unreadable. Each of (1) to (8) names the layer it tests; (1) and (2) are also run through `verify-stage` below.
  - `verify-stage.test.ts`: **the walk is tested without the reader**: extract the hidden-symlink archive with real `tar -x --no-same-owner --no-same-permissions --no-overwrite-dir` into a temp stage (ignore tar's exit status 2), then `assertPlainTree` throws "holds a link or a special file" and `ownerOnly` was never called; a stage with a FIFO, a socket, a file with `nlink` 2 and a symlinked folder is refused; a clean stage returns the entry count; `ownerOnly` under `umask 077` leaves `run.sh` at 0700, a data file at 0600, folders at 0700 (M6b-RT-21: not a blanket 0600), and a file extracted as 0444 becomes 0400|0200 = 0600.
  - `place.test.ts`: the three scratch cases, plus: a `rename` that fails for the second folder (inject a failing `renameSync` through a temp folder made read-only) moves the first folder back and leaves `state.db` untouched.
- [ ] **Step 2: RED.** **Step 3: Implement** (the three code blocks are the contract). **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/backup`.
- [ ] **Step 5: Mutation checks (real, restore after each):** (a) in `paxPath`, accept unknown records again: the hidden-symlink, hidden-hard-link and every per-record test fail; (b) make `assertPlainTree` return without checking: the `verify-stage` hidden-symlink test fails, and with (a) also applied the T5b hidden-symlink restore test fails (each layer is tested alone and both together); (c) skip `checksumOk`: the flipped-byte case fails; (d) allow type `2` (symlink) in `listMembers`: the symlink refusal fails; (e) drop the `..` part test in `safeMemberPath`: the dotdot case fails; (f) change `ownerOnly` to `chmodSync(path, 0o600)`: the executable-bit test fails; (g) drop the `kinds` ancestor check: the below-a-file case fails; (h) remove the undo loop in `placeRestored`: the failing-rename test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(restore): untrusted-archive reader with checksum and pax allowlist, stage walk and placement with undo"`

---

### Task 5b: `pap restore` [lane 1]

**Files:**
- Create: `apps/daemon/src/cli/backup/restore.ts`, `restore.test.ts`, `restore.refusals.test.ts`, `restore.int.test.ts`; `apps/daemon/src/cli/restore.ts`
- Modify: `run-cli.ts`, `usage.ts`, `docs/agents/backup.md`

**Interfaces:**
- Consumes: T1 (`snapshotDatabase`, `schemaIds`, `knownMigrationIds`, `acquireOpLock`, `resolveTarget`/`mismatch`), T3 (`ManifestSchema`), T4 (`decryptFile`, magic detection), T5a (`listMembers`, `assertPlainTree`, `ownerOnly`, `placeRestored`, `HOME_TOPS`), `acquireInstanceLock`, `prepareHome`, `piAgentDirFrom`, `readSecret`.
- Produces: `restoreBackup(deps)`; command `pap restore <file> [--replace] [--passphrase-stdin] [--home <abs dir>] [--unit <name>]`.

**Rulings (pre-dispatch):** M6bR6, M6bR7, M6bR8, M6bR48, M6bR50, M6bR51. Plus:
- **M6bR6a** Order of the restore (each step refuses with a fixed sentence before the next): the home is resolved by `resolveTarget` and `mismatch` refuses a unit whose home differs (no `--home`) → `update/op.lock` taken (`acquireOpLock`) → home prepared (`prepareHome`) and **instance lock taken** (`acquireInstanceLock`; its error text is shown as is) → existing `state.db` without `--replace` → stage folder `home/.restore-XXXXXX` (0700, same file system) → private copy of the input (an encrypted one is decrypted to the stage; the input must be a regular file, not a symlink) → `listMembers` → top-level allowlist (`manifest.json`, `state.db`, `attachments`, `agents`, `exports`, `secrets`, `pi-agent`; `state.db` and `manifest.json` each exactly once) → **disk gate** (free space at the home below the declared member bytes plus the private copy's size plus 64 MB refuses, with the numbers, M6b-RT-22) → full `tar -xzf` (a non-zero exit refuses) → **`assertPlainTree(stage)`, before anything reads an extracted file** → parse `manifest.json` → `secrets` present only when the manifest says `included` → verify `state.db` (sha256, `schemaIds` not null, ids ⊆ `knownMigrationIds()`, ids equal `manifest.schema`) → `ownerOnly(stage)` → `placeRestored` → Pi sessions add-missing → stage and locks released in `finally` → summary. (The first draft extracted `manifest.json` alone first; one full extraction followed by the walk is simpler and the stage is private and removed on every path.)
- **M6bR6b** The stage is removed on every path, including a failed placement (the undo has already run).
- **M6bR8a** Pi sessions: the target is `realpath(piDir)/sessions`; each file is created with `COPYFILE_EXCL`; a destination whose existing parent is not a directory is skipped and counted; nothing is written outside that folder (the relative names passed `safeMemberPath`).
- **M6bR7a** The summary says: the home and its source, the folders kept under `backups/pre-restore-<stamp>*` (and that the old data is there if the process is cut short), whether secrets were restored, which secrets are therefore missing when they were not (vault key and values, webhook keys, known-device key: "re-enter agent secrets, rotate webhook secrets"), **the line "Notifications: each device re-enables when it next opens pap." whenever `secrets/push/vapid.json` was not restored (M6b-RT-08, M6bR48)**, how many Pi session files were added and skipped, and `start pap: systemctl --user start <unit>`.

`restore.ts` validates `tops` against `HOME_TOPS` and the manifest BEFORE calling `placeRestored` (so a refusal never moves a folder).

- [ ] **Step 1: Tests (RED).**
  - `restore.refusals.test.ts` (one test per row of M6bR7, each asserting the home is byte-identical afterwards): another operation holds `update/op.lock` (a fake pid); the daemon holds the lock (a second `acquireInstanceLock` in the test); `state.db` present without `--replace`; a file that is not a backup; `format: 2`; a manifest with an unknown key; a database with an id the build does not know ("newer pap"); a damaged database; manifest and database ids disagree; `secrets/` in the archive while the manifest says `excluded`; a member `agents/../x`; a symlink member; **the hidden-symlink archive (M6b-RT-01, built with GNU tar and `--pax-option='size:=0'`) is refused by the reader and, with the reader stubbed to accept it, is refused by the walk, and the home is byte-identical in both runs and no `evil` link exists anywhere under the home**; free space below the gate (injected `freeMb`) refuses before any extraction; wrong passphrase on an encrypted backup (message from T4, nothing written); an input that is a symlink; an unit home that differs from `PAP_HOME` without `--home` (`mismatch`).
  - `restore.test.ts`: round trip of a plain backup into an empty home restores `state.db` (rows equal), `agents/a/f.txt` with mode `0600`, an executable `agents/a/run.sh` with mode `0700` (RT-21), folders `0700`; `search.db` is absent afterwards; with `--replace` the old database is under `backups/pre-restore-*.db` with the old rows and the old `agents/` under `backups/pre-restore-*/agents`; Pi sessions are added and an existing file with different content is NOT overwritten (counted as skipped); the restored `state.db` mode is `0600`; the summary lists the missing secrets for a plain backup AND contains "Notifications: each device re-enables when it next opens pap." (a plain restore), and does NOT contain it for an encrypted-with-secrets restore whose archive holds `secrets/push/vapid.json`, which is restored at 0600; the summary prints `home:` with its source; the stage folder is gone and `update/op.lock` is released.
  - `restore.int.test.ts` (spawns the CLI; temp `HOME`; the round trip the roadmap names): create a home with a real migrated `state.db` and an agent file, `pap backup --encrypt --secrets include --passphrase-stdin`, delete the home, `pap restore --passphrase-stdin`, then open the restored database with the real `migrate` (no pending, no error) and compare rows; also with a second process holding the lock the restore exits 1 with "pap is already running".
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — unit, then the one int file.
- [ ] **Step 5: Mutation checks:** (a) move `placeRestored` before the id check: "newer pap" leaves the home changed and fails; (b) take the lock after the stage is made: the lock test fails (home changed); (c) skip `assertPlainTree` in `restoreBackup`: the reader-stubbed hidden-symlink test fails; (d) call `ownerOnly` before `assertPlainTree`: the same test fails (a chmod followed the link target in the scratch fixture); (e) drop `COPYFILE_EXCL`: the Pi overwrite test fails; (f) drop the `update/op.lock` call: the op-lock refusal test fails; (g) drop the disk gate: the free-space test fails; (h) drop the notifications line: the summary test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(restore): pap restore reads the archive before extracting, walks what tar wrote, refuses newer schemas and keeps what it replaces"`

---

### Task 6: The update core (releases, journal, locks, transaction, rollback) [lane 2]

**Files:**
- Create: `apps/daemon/src/cli/update/releases.ts`, `pending.ts`, `apply.ts`, `guard.ts`, `releases.test.ts`, `pending.test.ts`, `apply.test.ts`, `apply.rollback.test.ts`, `guard.test.ts`, `docs/agents/update.md` (first section)

**Interfaces:**
- Consumes: T1 (`snapshotDatabase`, `schemaIds`, `restoreDatabaseFile`, `readLockPid`; `writeJsonAtomic` is NOT used here: `pending.ts` writes with its own `fsync` so the step is durable before the next one), `Readiness` (`service/readiness.ts`).
- Produces (frozen; T7a, T8 import these):
  - `RELEASE_ID`, `checkedId`, `releaseDir(app, id)`, `readCurrent(app): string | null`, `releaseIsComplete(app, id)`, `switchCurrent(app, id)`, `otherReleases(app, skip): string[]` (newest first by `BUILD_INFO.json` `builtAt`).
  - `PendingSchema`, `type Pending`, `pendingPath(home)`, `writePending`, `readPending(home): Pending | "damaged" | null`, `clearPending`.
  - `type ApplyDeps` (adds `holdHome(): () => void`, M6bR51), `type ApplyOutcome`, `class ApplyRefused`, `preflight(deps, to)`, `rollback(deps, pending, reason)`, `applyRelease(deps, to)`.
  - `runsInsideDaemon(input)`, `ancestorPids(readStat, start?)` (`guard.ts`, M6bR52).

**Rulings (pre-dispatch):** M6bR12 to M6bR17, M6bR43, M6bR51, M6bR52, M6bR53. Plus:
- **M6bR13a** `rollback()` re-checks that the old release is back by waiting for `listening` again; if it never listens the outcome is `rollback_failed` with step `old_release_not_listening` and `pending.json` stays (so `doctor` and `recover` see it).
- **M6bR14a** The migration test is "the database holds an id the snapshot's id list lacks, or does not pass `integrity_check`": computed from `pending.schemaBefore` (written before the stop), not from the snapshot file, so a missing snapshot cannot hide a migration.
- **M6bR12a (M6b-RT-05)** An unreadable journal does not end the update early: `/healthz`, the settle window and the unit state are still required. Only when they all pass is the outcome `unverified` (and `pending.json` is cleared); when any fails the update rolls back. The first draft returned `unverified` before any of them, so a crash-looping release on a volatile-journal host stayed installed.
- **M6bR18d (M6b-RT-18c)** `rollback()` never throws and `applyRelease` never calls it from inside its own `try`: every failure becomes the string `failure` and `rollback` is called once, after the `try`. A rollback that fails (even writing its own journal) is `rollback_failed`, never a second rollback.
- **M6bR51** (M6b-RT-11) The caller holds `update/op.lock` for the whole command (T7a, T8); `applyRelease` and `rollback` take the instance lock through `deps.holdHome()` after the `stop` and release it just before `reset-failed`. A busy lock is a failure like any other: the rollback then also fails on the lock (`rollback_failed`, step `lock`) and `pending.json` stays, so `pap update recover` finishes it from another shell once the other process is gone.

**Security contracts (run in scratch against fake dependencies; scenarios 1 to 11 below are the tests):**
```ts
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Same class as the archive builder (M6R8): the id goes into a path, so nothing else is accepted. */
export const RELEASE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const releaseDir = (app: string, id: string): string => join(app, "releases", checkedId(id));

export function checkedId(id: string): string {
  if (!RELEASE_ID.test(id) || id === "." || id === "..") throw new Error("invalid release id");
  return id;
}

/** The release `current` names, or null when there is none or the link is not the `releases/<id>` shape we write. */
export function readCurrent(app: string): string | null {
  try {
    const target = readlinkSync(join(app, "current"));
    const match = /^releases\/([A-Za-z0-9._-]{1,64})$/.exec(target);
    return match?.[1] !== undefined && match[1] !== "." && match[1] !== ".." ? match[1] : null;
  } catch {
    return null;
  }
}

/** A release the service can run: its Node binary and the daemon entry exist as regular files. */
export function releaseIsComplete(app: string, id: string): boolean {
  const dir = releaseDir(app, id);
  return [join(dir, "node", "bin", "node"), join(dir, "app", "apps", "daemon", "dist", "main.js")].every((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Points `current` at `releases/<id>` in one step: a new relative symlink, then rename(2) over the old one (atomic on
 * POSIX, like `mv -T` in the installer). Refuses an incomplete release, so `current` never names something that cannot run.
 */
export function switchCurrent(app: string, id: string): void {
  if (!releaseIsComplete(app, id)) throw new Error(`release ${id} is incomplete`);
  const temp = join(app, `current.new.${process.pid}`);
  rmSync(temp, { force: true });
  symlinkSync(`releases/${id}`, temp);
  try {
    renameSync(temp, join(app, "current"));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The complete releases other than `skip`, newest first by `BUILD_INFO.json` `builtAt` (an unreadable file sorts last). */
export function otherReleases(app: string, skip: string | null): string[] {
  const root = join(app, "releases");
  if (!existsSync(root)) return [];
  const built = (id: string): number => {
    try {
      const info = JSON.parse(readFileSync(join(releaseDir(app, id), "BUILD_INFO.json"), "utf8")) as { builtAt?: unknown };
      return typeof info.builtAt === "string" ? Date.parse(info.builtAt) || 0 : 0;
    } catch {
      return 0;
    }
  };
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && RELEASE_ID.test(entry.name))
    .map((entry) => entry.name)
    .filter((id) => id !== skip && releaseIsComplete(app, id) && !lstatSync(releaseDir(app, id)).isSymbolicLink())
    .sort((a, b) => built(b) - built(a) || (a < b ? 1 : -1));
}
```

```ts
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ID = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/** What an update has done so far, written BEFORE each step, so a killed `pap update` can be finished by `pap update recover`. */
export const PendingSchema = z.strictObject({
  format: z.literal(1),
  from: ID,
  to: ID,
  step: z.enum(["stopping", "switched", "started", "rolling_back"]),
  /** Basename inside `$PAP_HOME/backups`, or null while no snapshot exists yet. */
  snapshot: z.string().regex(/^pre-update-[A-Za-z0-9._-]{1,120}\.db$/).nullable(),
  /** Migration ids the database held when the old daemon stopped (what a rollback compares against). */
  schemaBefore: z.array(z.string().max(200)).max(5000).nullable(),
  startedAt: z.string().datetime(),
});
export type Pending = z.infer<typeof PendingSchema>;

const dirOf = (home: string): string => join(home, "update");
export const pendingPath = (home: string): string => join(dirOf(home), "pending.json");

export function writePending(home: string, pending: Pending): void {
  PendingSchema.parse(pending);
  mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  const temp = `${pendingPath(home)}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(pending)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, pendingPath(home));
}

/** null: none. A file that does not parse is reported as `"damaged"`, never ignored (doctor and recover both show it). */
export function readPending(home: string): Pending | "damaged" | null {
  let text: string;
  try {
    text = readFileSync(pendingPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "damaged";
  }
  if (text.length > 64 * 1024) return "damaged";
  try {
    const parsed = PendingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "damaged";
  } catch {
    return "damaged";
  }
}

export const clearPending = (home: string): void => rmSync(pendingPath(home), { force: true });
```

```ts
import { statSync } from "node:fs";
import { join } from "node:path";
import { clearPending, writePending, type Pending } from "./pending.ts";
import { readCurrent, releaseIsComplete, switchCurrent } from "./releases.ts";
import { restoreDatabaseFile, schemaIds, snapshotDatabase } from "../ops/snapshot.ts";
import type { Readiness } from "../service/readiness.ts";

export interface ApplyDeps {
  readonly app: string;
  readonly home: string;
  /** Migration ids the NEW release knows (the running CLI is the new release). */
  readonly knownIds: ReadonlySet<string>;
  readonly systemd: {
    stop(unit: string): Promise<void>;
    restart(unit: string): Promise<void>;
    resetFailed(unit: string): Promise<void>;
    activeState(unit: string): Promise<string | null>;
    restartCount(unit: string): Promise<number | null>;
  };
  /** The journal's `listening` line of the start made at `since`, waiting at most `deadlineMs`; ends early when the unit has failed. */
  listening(since: Date, deadlineMs: number): Promise<Readiness>;
  healthz(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  freeMb(path: string): number | null;
  /** The instance lock of the home (`acquireInstanceLock`); throws when another process holds it. Returns the release function. */
  holdHome(): () => void;
  readonly deadlineMs: number;
  readonly settleMs: number;
  readonly unit: string;
}

export type ApplyOutcome =
  | { kind: "updated" }
  | { kind: "unverified" }
  | { kind: "rolled_back"; reason: string; restoredDatabase: boolean }
  | { kind: "rollback_failed"; reason: string; step: string };

export class ApplyRefused extends Error {
  override name = "ApplyRefused";
}

const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

/** Refuses before anything is touched; every message names the way out. */
export function preflight(deps: ApplyDeps, to: string): { from: string; dbPath: string; ids: string[] | null } {
  const from = readCurrent(deps.app);
  if (from === null) throw new ApplyRefused("no installed release to update from: run the installer instead");
  if (from === to) throw new ApplyRefused(`release ${to} is already the current one`);
  if (!releaseIsComplete(deps.app, to)) throw new ApplyRefused(`release ${to} is incomplete: nothing was changed`);
  const dbPath = join(deps.home, "state.db");
  let size = 0;
  try {
    size = statSync(dbPath).size;
  } catch {
    // no database yet: nothing to snapshot or migrate
    return { from, dbPath, ids: null };
  }
  const ids = schemaIds(dbPath);
  if (ids === null) throw new ApplyRefused("the database cannot be read or is damaged: restore a backup first (pap restore)");
  if (ids.some((id) => !deps.knownIds.has(id)))
    throw new ApplyRefused("the database was written by a newer pap than release " + to + ": a downgrade is refused (pap restore, or pap update rollback)");
  const free = deps.freeMb(deps.home);
  const neededMb = Math.ceil((size * 2) / 1_048_576) + 64;
  if (free !== null && free < neededMb) throw new ApplyRefused(`not enough disk space for the snapshot (${neededMb} MB needed, ${free} MB free)`);
  return { from, dbPath, ids };
}

/** Everything a rollback needs is in `pending`, so `pap update recover` runs the same code after a crash. Never throws. */
export async function rollback(deps: ApplyDeps, pending: Pending, reason: string): Promise<ApplyOutcome> {
  try {
    return await rollbackSteps(deps, pending, reason);
  } catch {
    return { kind: "rollback_failed", reason, step: "error" };
  }
}

async function rollbackSteps(deps: ApplyDeps, pending: Pending, reason: string): Promise<ApplyOutcome> {
  writePending(deps.home, { ...pending, step: "rolling_back" });
  try {
    await deps.systemd.stop(deps.unit);
  } catch {
    return { kind: "rollback_failed", reason, step: "stop" };
  }
  let release: () => void;
  try {
    release = deps.holdHome();
  } catch {
    return { kind: "rollback_failed", reason, step: "lock" };
  }
  let restoredDatabase = false;
  try {
    try {
      const before = pending.schemaBefore === null ? null : new Set(pending.schemaBefore);
      if (pending.snapshot !== null && before !== null) {
        const now = schemaIds(join(deps.home, "state.db"));
        if (now === null || now.some((id) => !before.has(id))) {
          restoreDatabaseFile(join(deps.home, "backups", pending.snapshot), deps.home, before);
          restoredDatabase = true;
        }
      }
    } catch {
      return { kind: "rollback_failed", reason, step: "database" };
    }
    try {
      switchCurrent(deps.app, pending.from);
    } catch {
      return { kind: "rollback_failed", reason, step: "switch" };
    }
  } finally {
    release(); // before the restart: the daemon takes the same lock
  }
  try {
    await deps.systemd.resetFailed(deps.unit); // the start limit counts manual starts too
    await deps.systemd.restart(deps.unit);
  } catch {
    return { kind: "rollback_failed", reason, step: "restart" };
  }
  const back = await deps.listening(deps.now(), deps.deadlineMs);
  if (back.kind === "never") return { kind: "rollback_failed", reason, step: "old_release_not_listening" };
  clearPending(deps.home);
  return { kind: "rolled_back", reason, restoredDatabase };
}

export async function applyRelease(deps: ApplyDeps, to: string): Promise<ApplyOutcome> {
  const { from, dbPath, ids } = preflight(deps, to);
  const startedAt = deps.now();
  let pending: Pending = {
    format: 1, from, to, step: "stopping", snapshot: null, schemaBefore: ids, startedAt: startedAt.toISOString(),
  };
  writePending(deps.home, pending);
  let failure: string | null = null;
  let unverified = false;
  try {
    await deps.systemd.stop(deps.unit);
    const release = deps.holdHome(); // after the stop: a daemon started by hand, or a restore, is refused here
    try {
      if (ids !== null) {
        const name = `pre-update-${to}-${stamp(startedAt)}.db`;
        snapshotDatabase(dbPath, join(deps.home, "backups", name));
        pending = { ...pending, snapshot: name };
      }
      switchCurrent(deps.app, to);
      pending = { ...pending, step: "switched" };
      writePending(deps.home, pending);
    } finally {
      release(); // before the restart
    }
    await deps.systemd.resetFailed(deps.unit);
    const since = deps.now();
    await deps.systemd.restart(deps.unit);
    pending = { ...pending, step: "started" };
    writePending(deps.home, pending);
    const ready = await deps.listening(since, deps.deadlineMs);
    if (ready.kind === "never") failure = "the new release did not start listening";
    else if (!(await deps.healthz())) failure = "the health probe failed"; // also when the journal is unreadable (M6bR12a)
    else {
      const restarts = await deps.systemd.restartCount(deps.unit);
      await deps.sleep(deps.settleMs);
      const state = await deps.systemd.activeState(deps.unit);
      const after = await deps.systemd.restartCount(deps.unit);
      if (state !== "active" || after !== restarts || !(await deps.healthz()))
        failure = "the new release stopped or restarted during the settle window";
      else unverified = ready.kind === "unreadable"; // installed, every other check passed, the journal cannot confirm (M6 exit 3)
    }
  } catch (error) {
    failure = error instanceof ApplyRefused ? error.message : "the update step failed";
  }
  if (failure !== null) return await rollback(deps, pending, failure); // once, outside the try (M6bR18d)
  clearPending(deps.home);
  return unverified ? { kind: "unverified" } : { kind: "updated" };
}
```

The self-kill guard (M6bR52, M6b-RT-03; pure, the inputs are injected):

```ts
/** True when this process is inside the unit it is about to stop: its cgroup names the unit, or an ancestor is the daemon (a shell in pap's own web terminal). */
export function runsInsideDaemon(input: {
  readonly cgroupText: string;
  readonly unit: string;
  readonly ancestorPids: readonly number[];
  readonly daemonPid: number | null;
}): boolean {
  const inUnit = input.cgroupText.split("\n").some((line) => line.split("/").includes(input.unit));
  return inUnit || (input.daemonPid !== null && input.ancestorPids.includes(input.daemonPid));
}

/** The parent chain of `start` from /proc, at most 64 hops: field 4 of /proc/<pid>/stat. `readStat` is injected in tests. */
export function ancestorPids(readStat: (pid: number) => string | null, start = process.pid): number[] {
  const chain: number[] = [];
  let pid = start;
  for (let hops = 0; hops < 64 && pid > 1; hops++) {
    const stat = readStat(pid);
    const parent = stat === null ? NaN : Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isInteger(parent) || parent <= 0) break;
    chain.push(parent);
    pid = parent;
  }
  return chain;
}
```

Scratch results (these are the test expectations): (1) success with a migration: `updated`, `current` is the new release, the database keeps the new rows, `pending` is gone, call order `stop, reset-failed, restart`; (2) the new release never listens after a migration ran: `rolled_back`, `restoredDatabase: true`, old rows back, `current` old, calls end `stop, reset-failed, restart`; (3) the daemon dies during the settle window without a migration: `rolled_back`, `restoredDatabase: false`; (4) the restart counter moved: `rolled_back`; (5) the old release does not listen after the rollback: `rollback_failed` / `old_release_not_listening` and `pending` kept with `step: "rolling_back"`; (6) **unreadable journal with a healthy daemon**: `unverified`, `current` stays on the new release, `pending` cleared; (7) a database with an unknown id: `ApplyRefused`, nothing touched (zero systemd calls); (8) the first `stop` throws: `rolled_back` (reason "the update step failed") with `current` unchanged; (9) **unreadable journal, unhealthy daemon, a migration ran** (M6b-RT-05, RED on the first draft, which returned `unverified` and left `current` on the new release): `rolled_back`, `restoredDatabase: true`, `current` old; and unreadable journal with `/healthz` ok but `ActiveState` `failed` in the settle window: `rolled_back`; (10) `holdHome` throws after the stop (a restore or a hand-started daemon holds the lock): the rollback also fails on the lock, outcome `rollback_failed` / `lock`, `pending` kept, `current` unchanged, no snapshot written; and a `holdHome` that is released exactly once on every path (success, switch failure, rollback), always before the next `reset-failed`; (11) **`writePending` throws inside the rollback** (read-only folder) or `rollback` is reached after `listening` itself threw: the outcome is `rollback_failed` / `error` and the rollback ran once (assert the `stop` call count is 2, not 3: no re-entry, M6b-RT-18c).

- [ ] **Step 1: Tests (RED).** `releases.test.ts`: `readCurrent` accepts only `releases/<id>` (rejects `/etc`, `../x`, `releases/..`, an absolute target, a regular file); `switchCurrent` refuses an incomplete release and leaves `current` unchanged; the switch is atomic (a second process reading `current` in a loop during 200 switches never sees a missing link: use `readlinkSync` in the same process between the two syscalls is not possible; assert instead that no `current.new.*` file remains and that `rename` is used, by spying `fs.renameSync`); `otherReleases` orders by `builtAt`, skips `.stage.*`, a symlinked release folder and an incomplete one. `pending.test.ts`: round trip, mode `0600`, folder `0700`, strict (extra key, bad snapshot name, `to` with `/` → `"damaged"`), a 100 KB file is `"damaged"`, absent is null, `clearPending` is idempotent. `apply.test.ts` and `apply.rollback.test.ts`: the eleven scenarios with exact outcomes and `calls`; plus: `preflight` refuses `from === to`, an incomplete target, disk below `2 x size + 64` (injected `freeMb`) with the numbers in the message, and **a snapshot taken after the stop** (assert call order: `stop` recorded before the snapshot file appears, using a `stop` fake that asserts the file does not exist yet); `pending.step` values in order `stopping`, `switched`, `started` (read the file at each fake call); every `restart` is directly preceded by `reset-failed` in all scenarios (the M6 I1 pin); a rollback that finds `pending.snapshot === null` never touches the database. `guard.test.ts`: a cgroup text `0::/user.slice/user-1000.slice/user@1000.service/app.slice/pap.service` with unit `pap.service` is inside; the same text with `pap-preview.service` is not; a shell in a worker scope (`.../app.slice/run-r1234.scope`) is inside only through `ancestorPids` containing the daemon pid from `readLockPid`; `ancestorPids` follows an injected `/proc` table, stops at pid 1, stops at 64 hops on a loop, and treats an unreadable stat as the end.
- [ ] **Step 2: RED.** **Step 3: Implement** (the code above is the contract).
- [ ] **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/update`.
- [ ] **Step 5: Mutation checks (real):** (a) in `rollback()` skip `restoreDatabaseFile`: scenario 2 fails on the rows; (b) restore unconditionally: scenario 3 asserts `restoredDatabase: false` and fails; (c) remove `resetFailed` from `rollback`: the call-order pin fails; (d) take the snapshot before `stop`: the "after the stop" test fails; (e) drop the `ids.some(...)` downgrade check: scenario 7 fails; (f) write `pending` after the switch instead of before: the step-order test fails; (g) return `unverified` as soon as `ready.kind === "unreadable"` (the first draft): scenario 9 fails; (h) call `rollback` from inside the `try`: scenario 11's `stop` count fails; (i) skip `holdHome`: scenario 10 fails; (j) make `runsInsideDaemon` ignore `ancestorPids`: the worker-scope guard test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(update): update transaction with a durable journal, instance lock, snapshot and automatic rollback"`

---

### Task 7a: `pap update apply` (wiring, health probe, locks) [lane 2]

**Files:**
- Create: `apps/daemon/src/cli/update/wiring.ts`, `apply-command.ts`, `probe-health.ts`, `apply-command.test.ts`, `probe-health.test.ts`, `wiring.test.ts`, `apply.int.test.ts`
- Modify: `apps/daemon/src/cli/service/readiness.ts` (optional `reads` parameter), `service/install.ts` and `service/common.ts` (move `waitWithLoopHeld` to `common.ts`, export), `run-cli.ts`, `usage.ts`, `docs/agents/update.md`

**Interfaces:**
- Consumes: T6 (`applyRelease`, `ApplyDeps`, `runsInsideDaemon`, `ancestorPids`), T1 (`parseUnit`, `knownMigrationIds`, `installRoot`, `resolveTarget`, `acquireOpLock`, `OpLockBusy`, `readLockPid`, `Systemd` additions), `waitForListening`, `acquireInstanceLock`, `unitFilePath`, `freeMb`.
- Produces: command `pap update apply --release <id> [--app-root <abs>] [--deadline-s 30..600] [--settle-s 0..60] [--unit <name>]` and `pap update apply --help` (prints one usage line and exits 0: the installer uses it as a capability probe, so a release without the command is detected); `makeApplyDeps(io, target, options): Promise<ApplyDeps>` (wiring, used by T8); `probeHealth(target, timeoutMs?)`, `probeHost(host)`; exit codes 0, 1, 3, 4, 5 (Global Constraints); `waitForListening(deps, unit, since, port, reads?)`.

**Rulings (pre-dispatch):** M6bR11, M6bR12, M6bR42, M6bR43, M6bR50, M6bR51, M6bR52. Plus:
- **M6bR11a** The `apply` command prints, on success: `updated: <from> -> <to>`, `database snapshot: backups/pre-update-...db (kept; the three newest are kept)`, `running turns were interrupted`; on exit 4: the reason, "the previous release (<from>) is back and running", and whether the database was restored ("writes made since <time> were discarded: the restored database is the one the old release left"); on exit 5: the exact manual commands (`pap update recover`, then `systemctl --user status <unit>`).
- **M6bR11b** `--app-root` is for tests only in spirit but is a normal safe-path flag (checked by `safePath`).
- **M6bR11c (M6b-RT-02)** The health probe asks the daemon the unit starts, where it listens: `<scheme>://<host>:<port>/healthz` with `scheme` `https` when `parseUnit(...).tls` and `host` the unit's `--host` (a wildcard becomes loopback) else `127.0.0.1`; status 200 and exactly `{"status":"ok"}`, at most 1 KiB, 3 s. The certificate is **not verified** for this probe only, because it talks to the machine's own address and a certificate for the public name would otherwise fail every good update on the HTTPS setups M12 recommends. The port is `parseUnit(...).port ?? 7777`. Code below (run in scratch against local HTTP and HTTPS servers).
- **M6bR11e (M6b-RT-18b)** The wiring's `listening` is the readiness wait in chunks of 20 reads (about 10 s): after each chunk that found no `listening` line it reads `Systemd.activeState`; `failed` ends the wait at once as `never` (a release that hit the start limit does not make the owner wait the full 120 s); `url` and `owner` end it as success; at the deadline it returns the last chunk's answer (`unreadable` stays `unreadable`).
- **M6bR52** (M6b-RT-03) Before anything is stopped, `apply` reads `/proc/self/cgroup`, the parent chain and `readLockPid(home)` and refuses with "run this from an SSH or console shell: stopping pap would end this terminal" (exit 1, `pending.json` not written) when `runsInsideDaemon` is true. The same guard runs in T8's `rollback` and `recover`.
- **M6bR51** `apply` takes `acquireOpLock(home)` first (a busy lock exits 1 with its message) and `deps.holdHome = () => acquireInstanceLock(home)` (T6).
- **M6bR50** The unit and home come from `resolveTarget` and the installed unit text (`Systemd.cat`, else the unit file), never from the CLI's own environment for home and port.

The health probe (run in scratch: HTTP unit, HTTPS unit with a certificate for another name, wrong scheme, `{"status":"no"}` and a closed port):

```ts
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HealthTarget {
  readonly host: string | null;
  readonly port: number;
  readonly tls: boolean;
}

/** The address the unit's own daemon answers on: `--host` when given (a wildcard means loopback), else 127.0.0.1. */
export function probeHost(host: string | null): string {
  if (host === null || host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host.replace(/^\[|\]$/g, "");
}

export function probeHealth(target: HealthTarget, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const options = { host: probeHost(target.host), port: target.port, path: "/healthz", method: "GET", timeout: timeoutMs };
    const done = (ok: boolean): void => resolve(ok);
    const req = target.tls
      ? httpsRequest({ ...options, rejectUnauthorized: false }, (res) => answer(res))
      : httpRequest(options, (res) => answer(res));
    function answer(res: IncomingMessage): void {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024) {
          res.destroy();
          done(false);
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: unknown };
          done(res.statusCode === 200 && body.status === "ok");
        } catch {
          done(false);
        }
      });
      res.on("error", () => done(false));
    }
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
    req.end();
  });
}
```

- [ ] **Step 1: Tests (RED).**
  - `probe-health.test.ts` (local `node:http` and `node:https` servers on port 0 with a generated certificate for another name; no sleeps): HTTP ok; HTTPS with a certificate for `public.example` ok; an HTTP probe of an HTTPS server is false; `{"status":"no"}` is false; a 2 KiB body is false; a closed port is false within the timeout; `probeHost("0.0.0.0") === "127.0.0.1"`, `"::"` becomes `::1`, `"192.0.2.1"` stays; a unit with `--host 192.0.2.1` makes the wiring pass that host (assert on the wiring's `healthz` target, not on the network).
  - `wiring.test.ts`: `listening` ends with `never` after the first chunk when the fake `activeState` answers `failed` (the fake clock advanced less than the deadline); keeps waiting while it answers `activating`; returns `url`/`owner` at once; returns `unreadable` at the deadline when every chunk said so.
  - `apply-command.test.ts` (fake `ApplyDeps` through an injectable factory): `--help` exits 0 with one line and touches nothing; refuses without `--release`, with a bad id (`../x`), with no unit file ("run the installer with flags"), with a unit `parseUnit` cannot read; maps outcomes to exit codes 0/3/4/5 and to the exact sentences; `--deadline-s 5` and `--settle-s 61` are usage errors; the port, host, tls and home passed to wiring come from the unit text, not from the environment (set `PAP_HOME=/elsewhere` in `io.env` and assert it is ignored); `--unit pap-preview.service` reads that unit; **the guard**: an injected cgroup text naming the unit, and separately an ancestor pid equal to the lock pid, each exit 1 with the "SSH or console shell" sentence and zero systemd calls and no `pending.json`; a busy `update/op.lock` exits 1 with its message and zero systemd calls.
  - `apply.int.test.ts` (spawns `main.ts update apply` in a temp `HOME` with fake systemd, fake release folders `r1` (current) and `r2`, a real migrated `state.db`, a fake `healthz` server on a free loopback port started by the test): success path exit 0 and `current -> releases/r2`; failure path (fake journal never shows `listening`, `--deadline-s 30` with the CLI `Clock` advanced by the fake sleep) exit 4, `current -> releases/r1`, the fake `systemctl` call log is `stop`, `reset-failed`, `restart`, `stop`, `reset-failed`, `restart`, and the database is the pre-update one when the test inserted a migration row during the fake `restart`; **a unit text with `--tls-cert` and a test HTTPS server answers: success; a unit text with `--host 127.0.0.2` and a server bound to that address only answers: success** (RED on the first draft's fixed `127.0.0.1` probe).
- [ ] **Step 2: RED.** **Step 3: Implement** (wiring builds `Systemd`, `listening` per M6bR11e via `waitForListening(..., reads = 20)`, `healthz` via `probeHealth`, `sleep` via `io.clock.sleep` under `waitWithLoopHeld`, `freeMb`, `holdHome`).
- [ ] **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/update && pnpm vitest run --project integration apps/daemon/src/cli/update/apply.int.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) read the home from `io.env` instead of the unit: the env-ignored test fails; (b) make exit 4 return 0: the exit-code test fails; (c) probe `http://127.0.0.1` always: the TLS and `--host` int cases fail; (d) drop the guard call: the guard tests fail; (e) drop `acquireOpLock`: the busy-lock test fails; (f) turn `rejectUnauthorized` on: the certificate-for-another-name test fails; (g) remove the `failed` check from the chunked wait: the fail-fast test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(update): pap update apply with a probe of the unit's own address, operation locks and a guard against its own terminal"`

---

### Task 7b: The installer's update path [lane 2]

**Files:**
- Modify: `scripts/archive-install.sh.tpl`, `knip.json` (`bash`), `docs/agents/update.md`
- Create: `scripts/archive-install-update.test.ts` (the new cases; the existing `scripts/archive-install.test.ts` is 336 lines and is edited only if an existing assertion changes, M6b-RT-14)

**Interfaces:**
- Consumes: T7a (`pap update apply` and its `--help` probe, exit codes 0, 1, 3, 4, 5).
- Produces: the installer behaviour of M6bR11 and M6bR56.

**Rulings (pre-dispatch):** M6bR11, M6bR56. Plus:
- **M6bR11d** In the installer, the update path runs only when `$#` is 0 and a different `current` exists; it passes no flags to `update apply`. Exit codes 4 and 5 of `update apply` become the installer's exit codes 4 and 5, with one sentence each; 3 stays 3 (unverified).
- **M6bR56 (M6b-RT-19)** With no flags and a different `current`, a new release whose CLI has no `update apply` (`--help` fails: a release older than M6b) is **refused** with a sentence naming the flags path, before `current` is switched. The first draft fell back to the M6 path silently: no downgrade refusal, no database restore, and the older daemon opens a newer database read-only while the install reports success.

**Installer template (security contract: it is the pinned-hash installer; ADR 0057's order stays: refusals, private copy, hash, listing, extraction, completeness, release moved into place, and only then the switch). Replace everything from `if [ -L "$app/current" ]` to the end of the `service install` block, and the header comment on exit codes:**

```bash
if [ -L "$app/current" ]; then previous="$(basename -- "$(readlink -- "$app/current")")"; fi

new_node="$rel/node/bin/node"
new_main="$rel/app/apps/daemon/dist/main.js"
status=0
unverified=0
if [ -n "$previous" ] && [ "$previous" != "$RELEASE_ID" ] && [ "$#" -eq 0 ]; then
  # An update of an installed pap, with no flags: the unit stays as it is. The NEW release's own CLI stops the service,
  # snapshots the database, switches `current`, restarts, probes and rolls everything back on failure (M6bR11, ADR 0064).
  if ! "$new_node" --disable-warning=ExperimentalWarning "$new_main" update apply --help >/dev/null 2>&1; then
    die "release $RELEASE_ID has no 'pap update apply' (it is older than the update feature): it cannot replace a running install with an automatic rollback. To reinstall it anyway, run this installer with explicit flags (for example --port 7777); there is then no rollback"
  fi
  "$new_node" --disable-warning=ExperimentalWarning "$new_main" update apply --release "$RELEASE_ID" || status=$?
  case "$status" in
    0) ;;
    3) unverified=1 ;;
    4) printf 'pap-install: the update failed; the previous release (%s) was restored and is running (details above)\n' "$previous" >&2; exit 4 ;;
    5) printf 'pap-install: the update failed and the rollback is INCOMPLETE: run: pap update recover (then: systemctl --user status pap)\n' >&2; exit 5 ;;
    *) die "pap update apply failed (exit code $status)" ;;
  esac
else
  # First install, a re-install of the same release, or an explicit re-install with flags (M6 behaviour, unchanged).
  ln -sfn -- "releases/$RELEASE_ID" "$app/current.new"
  mv -T -- "$app/current.new" "$app/current"
  switched=1
  node="$app/current/node/bin/node"
  main="$app/current/app/apps/daemon/dist/main.js"
  "$node" --disable-warning=ExperimentalWarning "$main" service install --node "$node" --main "$main" "$@" || status=$?
  if [ "$status" -eq 3 ]; then unverified=1; elif [ "$status" -ne 0 ]; then die "pap service install failed (exit code $status)"; fi
fi
```

The prune loop, the `unverified` summary and the exit lines that follow stay as they are. `switched=1` is set only in the `else` branch, so the cleanup trap never undoes an update that `update apply` already rolled back itself. Header comment: `Exit status: 0 success; 1 every other failure; 3 installed but unverified; 4 update failed and rolled back; 5 update failed, rollback incomplete.`

- [ ] **Step 1: Tests (RED)** in `archive-install-update.test.ts` (the existing harness with a fake `pap`): (a) no flags and a different `current`: the installer calls `update apply --release <id>` of the new release, never `service install`, `current` is NOT switched by the script (assert the symlink is whatever the fake `update apply` set); (b) flags given: the M6 path runs unchanged; (c) first install: M6 path; (d) fake `update apply` exits 4: installer exits 4 with the sentence and `current` untouched by the trap; exit 5 → 5; exit 3 → installer exit 3 and the "NOT verified" summary; exit 2 → `die`; (e) the pruning loop still keeps only the new and the previous release after a success; (f) **a new release whose CLI lacks `update apply` (`--help` fails), no flags, a different `current`: exit 1 with the "explicit flags" sentence, `current` unchanged, no `service install` call** (M6b-RT-19; with flags the same release installs through the M6 path); (g) the text test "no `eval`, `curl`, `wget`, no `sudo` outside the bubblewrap line" still passes (kept in the old file; re-run it).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit scripts/archive-install.test.ts scripts/archive-install-update.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) set `switched=1` before the `if`: case (d) fails (the trap puts `current` back after the CLI already did); (b) drop the `"$#" -eq 0` condition: case (b) fails; (c) delete the `--help` probe refusal: case (f) fails; (d) make exit 4 exit 0: case (d) fails.
- [ ] **Step 6: Gates** — plus `pnpm build && pnpm smoke:install` (the template and `service install` share files) — Expected: green.
- [ ] **Step 7: Commit** — `git commit -m "feat(update): the archive installer updates a running install through pap update apply and refuses a release that cannot roll back"`

---

### Task 8: `pap update rollback` and `pap update recover` [lane 2]

**Files:**
- Create: `apps/daemon/src/cli/update/manual-rollback.ts`, `rollback-command.ts`, `recover-command.ts`, tests
- Modify: `run-cli.ts`, `usage.ts`, `docs/agents/update.md`

**Interfaces:**
- Consumes: T6 (`rollback`, `readPending`, `otherReleases`, `readCurrent`, `releaseIsComplete`, `runsInsideDaemon`, `ancestorPids`), T7a (`makeApplyDeps`), T1 (`schemaIds`, `resolveTarget`, `acquireOpLock`).
- Produces: commands `pap update rollback [--to <id>] [--restore-database | --keep-database] [--unit <name>]` and `pap update recover [--keep-database] [--unit <name>]`; `planManualRollback(args): { target: string; pending: Pending; needsDecision: boolean; lostSince: string | null }`.

**Rulings (pre-dispatch):** M6bR17, M6bR18, M6bR51, M6bR52. Plus:
- **M6bR18a** `recover` with no `pending.json` says "nothing to recover" and exits 0; with a damaged one it prints the path and exits 1 ("inspect it, delete it only after `systemctl --user status <unit>` and `pap doctor` look right"). With a valid one it runs `rollback(deps, pending, "recovering an interrupted update")` and maps the outcome like `apply` (0 for rolled back, 5 for incomplete). **`recover --keep-database` (M6b-RT-18a)** runs the same rollback with `snapshot: null`: it is the way out when the snapshot file is missing or damaged (the first draft's `rollback` then returned `rollback_failed` / `database` with the unit stopped and no command to get out); the older release opens the migrated database read-only until the owner updates again, and the command says so.
- **M6bR18b** Manual rollback is refused while `pending.json` exists (run `recover` first), when no other complete release exists, and when `--to` names `current` or an incomplete release. The synthetic `Pending` it builds is `{ from: target, to: current, step: "rolling_back", snapshot: newest pre-update-<current>-*.db or null, schemaBefore: ids of that snapshot or null }`, so it uses the same `rollback()` and the same migration rule.
- **M6bR18c** When the current database holds a migration the snapshot lacks and neither `--restore-database` nor `--keep-database` is given, the command exits 1 and prints both options with their cost (the snapshot's age and "writes since then are discarded" / "the older release opens the database read-only until you update again"). With `--keep-database` the synthetic pending has `snapshot: null`.
- **M6bR51, M6bR52** Both commands take `acquireOpLock` first and run the self-kill guard before touching anything (a shell in pap's own terminal is refused with the "SSH or console shell" sentence).

- [ ] **Step 1: Tests (RED).** `manual-rollback.test.ts`: target choice (newest other, `--to`); each refusal; `needsDecision` true exactly when the database has an id the newest matching snapshot lacks; no snapshot and a migrated database → `needsDecision` false but a warning flag `unknownSchema` (the command prints "no snapshot: the older release may open the database read-only"). `recover` tests with a fake `ApplyDeps`: absent, damaged, valid-with-snapshot-and-migration (database restored), valid-but-step-`stopping` (nothing to restore, old release restarted), **a valid file whose snapshot file is missing: plain `recover` exits 5 with `database` and the way out printed, `recover --keep-database` exits 0 and never touches the database**, rollback failure → exit 5 and `pending.json` kept. Both commands: `reset-failed` precedes `restart` (the I1 pin); the guard refuses inside the unit (injected cgroup text) with zero systemd calls; a busy `update/op.lock` refuses. Int-style test through `runCli` with fake systemd for `recover` end to end.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/update`.
- [ ] **Step 5: Mutation checks:** (a) drop the "pending exists" refusal in manual rollback: its test fails; (b) make `--keep-database` still pass a snapshot: the read-only-warning test fails (database rows changed); (c) clear `pending.json` before the rollback finishes: the failure test (`pending.json` kept) fails; (d) make `recover --keep-database` restore anyway: the missing-snapshot test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(update): manual rollback and recovery of an interrupted update"`

---

### Task 9: `pap update check|install` and the daily check [lane 2]

**Files:**
- Create: `apps/daemon/src/cli/update/version.ts`, `check.ts`, `install-command.ts`, `check-command.ts`, `version.test.ts`, `check.test.ts`, `install-command.test.ts`; `apps/daemon/src/update-check.ts`, `update-check.test.ts`
- Modify: `apps/daemon/src/main.ts` (one call), `run-cli.ts`, `usage.ts`, `docs/agents/update.md`

**Interfaces:**
- Consumes: T2 (`FeedSchema`, `fetchLimited`, `Channel`), T1 (`installRoot`, `writeJsonAtomic`), `VERSION` (`kernel/version.ts`), the kernel `Clock`.
- Produces: `compareVersions(a, b): -1 | 0 | 1`; `checkForUpdate({ channel, current, fetch?, signal? }): Promise<{ status: "newer" | "current" | "older"; feed: Feed }>`; `pap update check [--channel stable|next]` (exit 0 whatever the answer; 1 when the feed cannot be read, with the code word); `pap update install [--channel c] [--from <abs dir>] [--yes]`; `startUpdateCheck({ clock, logger, env, home, version, dev }): { stop(): void }` called from `main.ts`.

**Rulings (pre-dispatch):** M6bR10, M6bR20, M6bR21, M6bR22, M6bR23, M6bR44. Plus:
- **M6bR20a** `install` refuses: not an archive install (`readCurrent(installRoot)` null → prints the right command for the kind: `git pull && scripts/install.sh --bin-dir ...` for a checkout, `npm install -g @soulkyu/pi-agentic-platform@latest` for npm, `podman pull` / `scripts/pap-container.sh build` for a container, detected from `process.argv[1]` path and `/run/.containerenv`); a feed whose `version` is not newer (`pap is up to date`); `minNode` above the running Node; a download whose length differs from the feed's `size`; an installer whose SHA-256 differs from the feed's. It never runs a downloaded file whose hash was not verified.
- **M6bR20b** The child is `bash <installer>` via `execFile` with `env` limited to `PATH`, `HOME`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `LANG`, a 30-minute timeout, `stdio: "inherit"`; its exit code is the command's. The download folder is removed in `finally`.
- **M6bR22a** The background check never throws into the daemon: every path is inside one `try`; a timer per run; `stop()` clears it; a skipped run (dev, `0.0.0`, `PAP_UPDATE_CHECK=0`) schedules nothing. The first run is 10 minutes after boot (kernel `Clock.setTimeout`, unref'd), then every 24 hours, so a daemon that restarts often does not call GitHub more than once per boot.
- **M6bR22b** `last-check.json` holds `{ at, channel, current, latest, status }` (0600) and nothing the feed said except the version string (validated).
- **M6bR22c** (owner b10, M6b-RT-17) `update-check.ts` exports one constant, `UPDATE_CHECK_DEFAULT = false`. The check is enabled when `PAP_UPDATE_CHECK=1`, or when the variable is unset and the constant is `true`; `PAP_UPDATE_CHECK=0` is always off. The commit that makes the repository public flips the constant (ADR 0066 lists it with the workflow flip).

- [ ] **Step 1: Tests (RED).** `version.test.ts`: a table of 20 pairs (`1.0.0` vs `1.0.0-next.3`: release wins; `1.2.0-next.10` > `1.2.0-next.9` numerically; `1.10.0` > `1.9.0`; equal; `0.0.0` is older than everything). `check.test.ts`: `newer/current/older` with a fake fetch; a feed for the wrong `channel` is refused; the URL asked is exactly the stable or next URL; a refused fetch maps to the exit-1 sentence containing only the code word. `install-command.test.ts` (fake fetch serving the feed, the installer and the archive; fake `bash` first on `PATH` that records its argv and cwd): dry run without `--yes` writes nothing and prints the interruption list; with `--yes` the installer is verified, written `0700` in a `0700` folder under the app root, run, its exit code is returned (0, 3, 4, 5 pass through), and the folder is removed; a flipped byte in the installer → refused, `bash` never called; wrong archive size → refused; a feed asking a host outside the allowlist → refused at `FeedSchema`; `--from <dir>` with two installers or none → refused, and with one it runs without any fetch call; not an archive install → the per-kind hint, exit 1. `update-check.test.ts` (fake clock): nothing scheduled for `dev`, `0.0.0`, `PAP_UPDATE_CHECK=0`, and with the variable unset while `UPDATE_CHECK_DEFAULT` is `false` (inject the constant: unset schedules when it is `true`, `=1` always schedules); the first run fires at +10 min and the next at +24 h; a failing fetch logs `update_check_failed` at debug with a code and never throws; `update_available` at info only when newer; `last-check.json` written; `stop()` clears the timer; 100 failures do not grow memory or schedule extra timers (a counter of pending timers is 1).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/update apps/daemon/src/update-check.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) skip the installer SHA-256 comparison: the flipped-byte test fails (`bash` was called); (b) remove the `size` equality check: the wrong-size test fails; (c) schedule the first run immediately: the +10 min test fails; (d) let the fetch error escape: the never-throws test fails; (e) flip `UPDATE_CHECK_DEFAULT` to `true`: the unset-is-off test fails.
- [ ] **Step 6: Gates** — plus `pnpm build && pnpm smoke` (a `main.ts` edit). **Step 7: Commit** — `git commit -m "feat(update): update check and install from the release feed, and a daily check that only logs"`


## Lane 1 (doctor) and lane 3 (packaging)

### Task 10: `pap doctor`, the framework and the system checks [lane 1]

**Files:**
- Create: `apps/daemon/src/cli/doctor/types.ts`, `run.ts`, `render.ts`, `checks-system.ts`, `run.test.ts`, `render.test.ts`, `checks-system.test.ts`, `apps/daemon/src/cli/doctor.ts`, `doctor.int.test.ts`, `docs/agents/doctor.md`
- Modify: `run-cli.ts`, `usage.ts`

**Interfaces:**
- Consumes: T1 (`parseUnit`, `Systemd`, `installRoot`, `resolveTarget`, `readLockPid`), `whichOnPath` (`kernel/which.ts`), `diskFloor`/`freeMb` (`kernel/disk.ts`), `unitFilePath`, `homeFrom`.
- Produces (frozen; T11 and M12 register against these):
  - `type CheckResult = { status: "ok" | "info" | "warn" | "fail" | "skip"; detail: string; fix?: string }` (`info` is advisory and counts as ok); `interface Check { readonly id: string; readonly title: string; run(ctx: DoctorContext): Promise<CheckResult> }`; `interface DoctorContext { io: CliIo; env: NodeJS.ProcessEnv; homedir: string; home: string; homeSource: "flag" | "unit" | "environment" | "default"; unitName: string; unit: ParsedUnit | null; lockHeld: boolean; systemd: Systemd; inContainer: boolean; clock: Clock }`.
  - `runDoctor(checks: readonly Check[], ctx, only?: readonly string[]): Promise<DoctorReport>` with `DoctorReport = { results: Array<{ id; title } & CheckResult>; exit: 0 | 1 | 2 }`; `renderText(report): string`; `renderJson(report): string`.
  - `CHECKS_SYSTEM: readonly Check[]` (`node`, `toolchain`, `user_manager`, `linger`, `journal`, `disk`, `home`).
  - Command `pap doctor [--json] [--only id[,id...]] [--unit <name>] [--home <abs dir>]`; exit 0 / 1 / 2 / 64 (`info` and `skip` exit 0).

**Rulings (pre-dispatch):** M6bR24, M6bR25, M6bR28. Plus:
- **M6bR24a** A check that throws becomes `{ status: "fail", detail: "the check could not run", fix: "report this" }` and never stops the others; a check that exceeds 10 s (`ctx.clock`, via an injected deadline) becomes `warn` "timed out". Every child process has the `run()` limits of `systemd.ts`.
- **M6bR24b** Severity: `node` below 24.14 or 25 and above is `fail`; `toolchain` (`gcc g++ make python3` on an absolute-entry `PATH`) is `info` ("only needed for method 1 and `npm install`"; a healthy default install must exit 0, M6b-RT-13); `user_manager` is `fail` (not in a container), `linger` is `warn`, `journal` is `warn`, `disk` is `fail` below `PAP_MIN_FREE_DISK_MB` (default 1024; 0 = off, `skip`) and `warn` below three times that, `home` is `warn` for a folder or database more open than 0700 or 0600 ("tightened at the next start") and `fail` when the folder is not owned by the user; a `PAP_HOME` set in this shell that differs from the unit's home is `info` ("pap commands follow the unit's home"). Each `fix` is a command or a doc anchor, never prose alone.
- **M6bR24c** `journal`: `warn` when `/var/log/journal` does not exist and no `Storage=persistent` line is found in `/etc/systemd/journald.conf` or `journald.conf.d/*.conf` (fix: `sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`, M6 prerequisite); when the unit is active and `journalctl --user -u pap.service -n 1 -q -o cat` returns nothing: `warn` "the journal holds no line for pap.service: `pap service install` and `pap update apply` cannot verify a start (exit 3)" (W5-R18). The check never reads the setup URL line (it would print a one-time token).
- **M6bR24d** Read-only: no `mkdir`, no `writeFile`; `home` uses `lstat`/`stat` only; the home is not created. A test lists the temp home before and after.
- Container: `inContainer` is true when `/run/.containerenv` or `/.dockerenv` exists; `user_manager`, `linger` and `journal` are then `skip` ("not applicable in a container").

- [ ] **Step 1: Tests (RED).** `run.test.ts`: ordering of results is the registry's; `--only` filters and an unknown id is a usage error (64) listing the known ids; exit is 1 with any `fail`, 2 with only `warn`, 0 with `ok`/`info`/`skip`; a throwing check does not stop the others and is a `fail`; a slow check (injected never-resolving promise + the fake clock advanced past 10 s) is `warn`. `render.test.ts`: text has one line per check `[ok] id detail` (`[info]` for advisory results) and a `  fix: ...` line for non-ok; `--json` is valid JSON with the same fields and no ANSI. `checks-system.test.ts` (fake systemd, temp `HOME`, `PATH` with fake tools): each check's ok and non-ok result; `node` with a fake version through an injected `process.versions`; `toolchain` lists missing tools by name; `journal` volatile (no `/var/log/journal`, injected path) and the empty-journal case; `disk` with an injected `statfs`; `home` with a 0755 folder (warn) and a folder owned by another uid (injected `stat`) (fail); container skip. `doctor.int.test.ts` (spawns the CLI in a temp `HOME` with the fakes): exit codes, `--json` parses, and **the temp home is unchanged** (recursive listing and mtimes equal before and after) and the fake systemd `calls` file holds only `show`, `cat`, `is-*`, `show-environment` and `loginctl show-user`.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — unit, then the one int file.
- [ ] **Step 5: Mutation checks:** (a) make `home` call `mkdirSync`: the unchanged-home test fails; (b) make a check's exception propagate: the throwing-check test fails; (c) map `warn` to exit 1: the exit-code test fails; (d) count `info` as `warn`: the healthy-install exit test (exit 0 with `toolchain` missing) fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(doctor): pap doctor with read-only system checks, fix hints and exit codes"`

---

### Task 11: Doctor, the daemon checks (schema, update, backup, HTTPS, push, sandbox) [lane 1]

**Files:**
- Create: `apps/daemon/src/cli/doctor/checks-daemon.ts`, `listen-facts.ts`, `checks-push.ts`, `registry.ts`, `checks-daemon.test.ts`, `listen-facts.test.ts`, `checks-push.test.ts`, `registry.test.ts`
- Modify: `apps/daemon/src/cli/doctor.ts` (use the registry), `docs/agents/doctor.md`

**Interfaces:**
- Consumes: T10 (`Check`, `DoctorContext`), T1 (`schemaStatus` with `noWrite`, `knownMigrationIds`, `readJsonBounded`, `readLockPid`, `ParsedUnit`), `PendingSchema` is NOT imported (lane 2): the check reads `update/pending.json` for **existence and mtime only** and reports the path; `probeSandbox`, `trustedBinary`, `BWRAP_CANDIDATES` (`kernel/sandbox/probe.ts`), lock inspection by `readLockPid` and `process.kill(pid, 0)`.
- Produces: `CHECKS_DAEMON: readonly Check[]` (`schema`, `update_pending`, `backup`, `bwrap`, `python3`, `update_available`); `listenFacts(unit: ParsedUnit | null, env: NodeJS.ProcessEnv): { publicOrigin: string; tls: boolean; insecureHttp: boolean }` (pure); `makeHttpsCheck(readiness)` and `makePushCheck(readiness)` where `readiness: (facts) => { status: "ready" | "localhost_only" | "insecure_http" | "origin_mismatch" | "keys_unreadable"; hint?: string }` is injected; `registry.ts` exports `ALL_CHECKS = [...CHECKS_SYSTEM, ...CHECKS_DAEMON]` as one array of whole lines.
- **Rebase on M12 (owner c1, M6bR47).** M12's pure `pushReadiness(facts)` lives in `apps/daemon/src/kernel/push-readiness.ts` (cross-plan agreement 2). The two registry lines (`makeHttpsCheck(pushReadiness)`, `makePushCheck(pushReadiness)`) and the import are added when M6b is rebased on the branch that contains it: in this task if `kernel/push-readiness.ts` is already on the base branch, else as T16 step 1. Until then `ALL_CHECKS` has no `https` and no `push`, and `registry.test.ts` knows the two ids are pending (a named constant, removed by the rebase commit).

**Rulings (pre-dispatch):** M6bR25 to M6bR28, M6bR47, M6bR48. Plus:
- `schema`: calls `schemaStatus(db, known, { noWrite: { lockHeld } })` with `lockHeld` from `readLockPid` and `process.kill(pid, 0)`. `newer` is `fail` ("this database was written by a newer pap and opens read-only; update pap, or `pap restore`"); `pending` is `ok` ("n migration(s) will run at the next start; a snapshot is taken first"); `damaged` is `fail` (fix: `pap restore <backup>`); `absent` is `ok` ("no data yet"); `unread` is `info` ("a write-ahead log from a crash is waiting; it is applied at the next start"). The check creates nothing next to the database (M6b-RT-06).
- `update_pending`: a `pending.json` is `fail` with fix `pap update recover`; if its size is above 64 KiB or it is not a regular file, `fail` "damaged" with the path.
- `backup`: reads `update/last-backup.json` (bounded, strict `{ at, file, encrypted, secrets }`); none → **`info`** "no backup made with `pap backup`" (fix: `pap backup`; a permanent `warn` on a healthy install would make the exit code useless, M6b-RT-13); older than 30 days → `warn` with the age; `ok` otherwise, saying whether it was encrypted and whether secrets are in it. It also sums the sizes of the `pap-backup-*` files in `backups/` (readdir and stat only) and, above 2 GiB, adds `info` with the `--keep N` hint (M6b-RT-20).
- `https` (id `https`): from `readiness(listenFacts(ctx.unit, ctx.env))`: `ready` → ok; `localhost_only` → `info` "http://localhost works on this machine only: push notifications and the installable app need HTTPS"; `insecure_http` and `origin_mismatch` → `warn`. The `fix` names `docs/agents/notifications.md#https` and the routes inline, in M12's order: the ngrok origin (decision 75), Tailscale serve, a reverse proxy through `PAP_PUBLIC_ORIGIN`, then `--tls-cert`. Never `fail`.
- `push` (id `push`): the same readiness status mapped by the same table, plus the key file: `secrets/push/vapid.json` by `lstat` only: absent → ok ("created at the first start"); a regular file of mode 0600 in a folder of mode 0700 → ok; anything else (a symlink, wider mode, not a file) → `warn` "push is off (keys_unreadable)" with fix "chmod 600 ..., or delete the file to start over (each device re-enables)". Never `fail`.
- `bwrap` and `python3` run the real probe and `trustedBinary` with the kernel `Clock`'s timers; `bwrap` `warn` on `missing` ("sudo apt install bubblewrap"), `unsafe_path`, `refused` (in a container: "start the container with `--security-opt systempaths=unconfined` (scripts/pap-container.sh run); on Ubuntu also check `kernel.apparmor_restrict_unprivileged_userns`"), `timeout`. `python3` `warn` when not root-owned: "networked agents need it".
- `update_available`: reads `update/last-check.json`; `ok` with "<latest> is available on <channel>: pap update install" or "up to date"; a missing file is `skip`.
- `listenFacts` derives like `loadConfig` (`kernel/config.ts`): `PAP_PUBLIC_ORIGIN` of the unit's environment (the shell's only when there is no unit), else `scheme://host:port` with `localhost` for a loopback or wildcard `--host`, the unit's `--host`, port `7777` by default; `tls` from `--tls-cert`; `insecureHttp` from `--insecure-http`.

- [ ] **Step 1: Tests (RED).** One test per branch of the rules above with injected probes and a temp home: `schema` over a real tiny migrated database (absent, current, pending, newer, garbage, and `unread` with a planted `-wal`); **the doctor leaves no trace (M6b-RT-06, moved here from T10): a WAL-mode `state.db` closed cleanly, then the whole check list run, then a recursive listing and mtimes of the home equal before and after (RED if the `schema` check opens the database without `immutable`)**; `update_pending` with a valid file, a 100 KB file and a directory in its place; `backup` with no file (info), a 31-day-old file (fake clock), a recent encrypted one, and 3 GiB of fake `pap-backup-*` sizes (the `--keep` hint); `bwrap` with injected probe results for each reason and the container hint text; `python3` with an injected `trustedBinary`; `update_available`. `listen-facts.test.ts`: the table of `loadConfig` derivations (default; `--host 192.0.2.1`; `--tls-cert`; `PAP_PUBLIC_ORIGIN=https://pap.example` in the unit environment; the same only in the shell with no unit; a drop-in `--insecure-http`), each compared with the real `loadConfig` output for the same argv and env (the test calls `loadConfig` with a temp certificate pair). `checks-push.test.ts` (injected `readiness`): the status table for both ids; the key file rows with a real temp folder (absent, 0600/0700, 0644, 0750 folder, a symlink, a directory); the check never creates the folder. `registry.test.ts`: ids are unique, `ALL_CHECKS` order is stable, and every id appears in `docs/agents/doctor.md`'s check table (a doc test: the test reads the table and fails when a check has no row; the two pending ids are exempt until the rebase).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit apps/daemon/src/cli/doctor`; the T10 int test is re-run (`pnpm vitest run --project integration apps/daemon/src/cli/doctor.int.test.ts`) because `doctor.ts` changed.
- [ ] **Step 5: Mutation checks:** (a) make `https` return `fail` for the plain case: its test fails; (b) make `update_pending` look only at JSON validity: the 100 KB case fails; (c) swap the probe for a PATH scan in `bwrap`: the refused-probe case (a binary that exists but fails) reports ok and fails; (d) open the database without `noWrite` in `schema`: the unchanged-home test fails; (e) make `backup` `warn` when there is none: the healthy-install exit test (T10 int) fails; (f) follow symlinks (`stat`) in the key-file check: the symlink row fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(doctor): schema, interrupted update, backup age, HTTPS, push, sandbox and python checks"`

---

### Task 12: The OCI image and the podman wrappers [lane 3]

**Files:**
- Create: `Containerfile`, `.containerignore`, `scripts/container-entrypoint.sh`, `scripts/pap-container.sh`, `scripts/build-archive-podman.sh`, `scripts/stage-app.ts`, `scripts/stage-app.test.ts`, `scripts/container.test.ts`
- Modify: `package.json` (`"build:image"`), `knip.json` (`podman`), `.gitignore`, `docs/agents/install.md` ("Container" and "Build the archive on an older host")

**Interfaces:**
- Consumes: `stageTree`, `missingDist`, `assertNoStagePath`, `Runner` (`scripts/build-archive-stage.ts`), T11 (`pap doctor --only bwrap` inside the image).
- Produces: image `localhost/pap:dev` (`PAP_IMAGE` overrides); `scripts/pap-container.sh build|run|url|stop`; `scripts/build-archive-podman.sh [--image ubuntu:22.04]` (M6R34); `node scripts/stage-app.ts --out <dir>`.

**Rulings (pre-dispatch):** M6bR29 to M6bR32. Plus:
- **M6bR29a** Docs say, in these words: "The image runs only under rootless podman. The sandbox for agents needs `--security-opt systempaths=unconfined`, which unmasks `/proc` and `/sys` paths for the whole container. S8 measured, for a non-root user without capabilities, read access to `/proc/interrupts`, `/proc/keys`, `/proc/latency_stats` and listings of `/proc/acpi`, `/proc/scsi`, `/sys/firmware`, and no write access; as container root `/sys/fs/cgroup` becomes writable, so the image runs as uid 10001 with every capability dropped. Rootful Docker was not measured and is not supported."
- **M6bR31a** `stage-app.ts` is the archive's staging recipe without the archive: it refuses missing `dist` folders and credentials in the staged manifests, runs `stageTree`, then `assertNoStagePath`. It exists so the image and the archive hold the same tree.
- **M6bR33a (podman archive wrapper, M6R34)** `build-archive-podman.sh` runs `pnpm install --frozen-lockfile && pnpm build && pnpm build:archive --allow-dirty` inside `ubuntu:22.04` with the checkout bind-mounted read-write at `/src`, the output folder `.pap-archive/` the only result copied out. It is a convenience for "build on the oldest glibc you target"; it needs network inside the container and is a manual step.

**Security contracts (the Containerfile, the entrypoint, `.containerignore` and the wrapper were written and the wrapper was run against a fake `podman` in scratch: `run` produced exactly the argument list below, `--port 80`, a relative `--project`, rootful and `PAP_CONTAINER_RUNTIME=docker` were refused, `url` extracted only a matching loopback setup URL; the Containerfile was not built here):**

```dockerfile
# syntax=docker/dockerfile:1
# Build:  scripts/pap-container.sh build   (pins the base by digest and labels the image)
ARG BASE_IMAGE=docker.io/library/node:24-bookworm-slim

FROM ${BASE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && node --disable-warning=ExperimentalWarning scripts/stage-app.ts --out /stage

# Nothing from the build stage is copied except /stage: no compiler, no pnpm, no .npmrc, no source.
FROM ${BASE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap tini python3 git openssh-client ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /bin/bash pap
COPY --from=build --chown=root:root /stage /opt/pap
COPY --chown=root:root --chmod=0755 scripts/container-entrypoint.sh /opt/pap/entrypoint.sh
USER 10001:10001
ENV HOME=/home/pap PAP_WORKER_SCOPE=off PAP_PORT=7777 NODE_ENV=production
WORKDIR /home/pap
EXPOSE 7777
VOLUME ["/home/pap"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PAP_PORT||7777)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/pap/entrypoint.sh"]
```

```sh
#!/bin/sh
set -eu
main=/opt/pap/apps/daemon/dist/main.js
# One warning line when the sandbox cannot run. The daemon still starts; agents that require the sandbox refuse (M11).
if ! node --disable-warning=ExperimentalWarning "$main" doctor --only bwrap >/dev/null 2>&1; then
  echo '{"level":"warn","msg":"container_sandbox_unavailable","hint":"run the image with scripts/pap-container.sh run (needs --security-opt systempaths=unconfined)"}' >&2
fi
exec node --disable-warning=ExperimentalWarning "$main" serve --host 0.0.0.0 --port "${PAP_PORT:-7777}"
```

```
.git
.worktrees
.superpowers
.pap-archive
.pap-npm
.pap-release
**/node_modules
**/dist
**/.env
**/.env.*
**/*.pem
**/*.key
```

```bash
#!/usr/bin/env bash
# Builds and runs the pap image with rootless podman, with exactly the option set that spike S8 measured (R52b).
# usage: pap-container.sh build | run [--port N] [--name NAME] [--project DIR]... | url [--name NAME] | stop [--name NAME]
set -euo pipefail
umask 077

die() { printf 'pap-container: %s\n' "$*" >&2; exit 1; }

IMAGE="${PAP_IMAGE:-localhost/pap:dev}"
VOLUME="pap-data"
[ "$(id -u)" -ne 0 ] || die "rootful podman is not supported (the S8 measurements are rootless): run as your own user"
[ -z "${PAP_CONTAINER_RUNTIME:-}" ] || [ "$PAP_CONTAINER_RUNTIME" = podman ] || die "only podman is supported; Docker was not measured (R52b)"
command -v podman >/dev/null 2>&1 || die "podman not found"
[ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" = true ] || die "podman is not rootless here: not supported"

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
verb="${1:-}"; [ -n "$verb" ] || die "usage: build | run | url | stop"; shift

port=7777; name=pap; projects=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) [ "$#" -ge 2 ] || die "--port needs a value"; port="$2"; shift 2 ;;
    --name) [ "$#" -ge 2 ] || die "--name needs a value"; name="$2"; shift 2 ;;
    --project) [ "$#" -ge 2 ] || die "--project needs a value"; projects+=("$2"); shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
case "$port" in ""|*[!0-9]*) die "--port must be a number from 1024 to 65535" ;; esac
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || die "--port must be a number from 1024 to 65535"
case "$name" in ""|*[!a-z0-9_.-]*|[!a-z0-9]*) die "--name must be lower-case letters, digits, . _ -" ;; esac
[ "${#name}" -le 40 ] || die "--name is too long"

case "$verb" in
  build)
    [ -f "$repo/Containerfile" ] || die "no Containerfile in $repo"
    base="${PAP_BASE_IMAGE:-docker.io/library/node:24-bookworm-slim}"
    podman pull --quiet -- "$base" >/dev/null
    digest="$(podman image inspect --format '{{.Digest}}' -- "$base")"
    case "$digest" in sha256:[0-9a-f][0-9a-f]*) ;; *) die "cannot read the digest of $base" ;; esac
    [ "${#digest}" -eq 71 ] || die "cannot read the digest of $base"
    commit="$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
    exec podman build --file "$repo/Containerfile" --tag "$IMAGE" \
      --build-arg "BASE_IMAGE=${base%%@*}@$digest" --label "org.opencontainers.image.revision=$commit" \
      --label "org.opencontainers.image.base.digest=$digest" -- "$repo"
    ;;
  run)
    mounts=()
    for dir in "${projects[@]}"; do
      case "$dir" in /*) ;; *) die "--project needs an absolute folder" ;; esac
      [ -d "$dir" ] || die "--project: not a folder"
      case "$dir" in *[!A-Za-z0-9._+@/-]*) die "--project: only letters, digits and . _ + @ / - are allowed" ;; esac
      mounts+=(--volume "$dir:/work/$(basename -- "$dir"):rw")
    done
    podman run --detach --name "$name" --replace \
      --user 10001:10001 --userns=keep-id:uid=10001,gid=10001 --cap-drop ALL \
      --security-opt no-new-privileges --security-opt systempaths=unconfined \
      --publish "127.0.0.1:$port:$port" --env "PAP_PORT=$port" \
      --volume "$VOLUME:/home/pap" "${mounts[@]}" -- "$IMAGE" >/dev/null
    printf 'pap-container: started %s on http://localhost:%s (this machine only). Setup URL: %s url --name %s\n' "$name" "$port" "$0" "$name"
    printf 'pap-container: agents that require the sandbox need the options above; check: podman exec %s node /opt/pap/apps/daemon/dist/main.js doctor --only bwrap\n' "$name"
    ;;
  url)
    line="$(podman logs --tail 300 -- "$name" 2>&1 | sed -n 's/.*"url":"\(http:\/\/localhost:[0-9]*\/setup#token=[A-Za-z0-9._~-]*\)".*/\1/p' | tail -n 1)"
    case "$line" in http://localhost:*/setup#token=*) printf '%s\n' "$line" ;; *) printf 'no setup URL: an owner already exists, or pap is not listening yet (podman logs %s)\n' "$name" ;; esac
    ;;
  stop) exec podman stop --time 40 -- "$name" ;;
  *) die "usage: build | run | url | stop" ;;
esac
```

- [ ] **Step 1: Tests (RED).** `container.test.ts` (text and fake `podman`, no build): the Containerfile final stage has `USER 10001:10001` (numeric), no `ARG` or `ENV` whose name matches `/(TOKEN|SECRET|PASSWORD|KEY)/i`, copies only `/stage` from the build stage, installs `bubblewrap`, `tini` and `python3` but not `g++`, `make`, `pnpm` or `corepack` (it may install `git`: agents need it), and does not `COPY . .`; `.containerignore` lists `.git`, `.worktrees`, `.superpowers`, `**/.env*`, `**/*.pem`; `HEALTHCHECK` and an exec-form `ENTRYPOINT` through `tini` exist; the wrapper with a fake `podman` first on `PATH`: `run` calls podman with exactly `run --detach --name pap --replace --user 10001:10001 --userns=keep-id:uid=10001,gid=10001 --cap-drop ALL --security-opt no-new-privileges --security-opt systempaths=unconfined --publish 127.0.0.1:7777:7777 --env PAP_PORT=7777 --volume pap-data:/home/pap -- localhost/pap:dev` (no `--privileged`, no `--cap-add`, no `0.0.0.0`), `--port 7792` changes only the two port occurrences and the env, a `--project` adds one `--volume <abs>:/work/<name>:rw`; refused: root (no test hook is added for it; the test greps the script for the `id -u` guard instead), `PAP_CONTAINER_RUNTIME=docker`, rootless false (fake `podman info` answers false), `--port 80`, `--port 70000`, `--name 'a b'`, `--project relative`, `--project` with a space or `$`; `url` returns only a match of `http://localhost:<digits>/setup#token=<chars>` and otherwise the "no setup URL" sentence; `build` passes `BASE_IMAGE=<ref>@sha256:<64 hex>` from the fake digest and refuses a digest of the wrong length. `stage-app.test.ts` (fake runner, as `build-archive.test.ts`): refuses missing dist, a staged `.npmrc` with `_authToken`, and a staged file naming the stage path; success leaves no `.bin` shims.
- [ ] **Step 2: RED.** **Step 3: Implement** the text files above verbatim (fix the test list wording as needed; the contract is the code).
- [ ] **Step 4: GREEN** — `pnpm vitest run --project unit scripts/container.test.ts scripts/stage-app.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) add `--privileged` to the wrapper: the exact-argv test fails; (b) change `127.0.0.1:` to `0.0.0.0:`: fails; (c) drop `--cap-drop ALL`: fails; (d) change `USER 10001:10001` to `USER root`: the Containerfile test fails; (e) drop `--userns=keep-id:...` from the wrapper: the exact-argv test fails (M6b-RT-07).
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(image): OCI image for rootless podman with the S8 option set, and the podman wrappers"`
- [ ] **Step 8 (controller, manual, not a unit test):** `scripts/pap-container.sh build` then `run --port 7792`, `url`, `podman exec pap node /opt/pap/apps/daemon/dist/main.js doctor --only bwrap`, and the same `run` command line without `systempaths=unconfined` to see `sandbox_unavailable` (Appendix A, step 9), then the keep-id write check on a `--project` mount, the setup and sign-in through the published port, `podman history --no-trunc` and a `find / -name '.npmrc'` inside the image (no credential, M6b-RT-26). Record the image size and the build time.

---

### Task 13: The npm package [lane 3]

**Files:**
- Create: `scripts/build-npm.ts`, `scripts/build-npm.test.ts`
- Modify: `package.json` (`"build:npm"`), `knip.json` (`npm`), `.gitignore` (`/.pap-npm/`), `docs/agents/install.md` ("npm")

**Interfaces:**
- Consumes: `apps/daemon/package.json`, `packages/{contracts,pi-host}/package.json`, `pnpm-workspace.yaml` (`catalog:`), the built `dist` folders.
- Produces: `node scripts/build-npm.ts [--out <dir>] [--name @soulkyu/pi-agentic-platform]` writes `<out>/package/` ready for `npm pack`; exports `resolveManifest(...)` for the test.

**Rulings (pre-dispatch):** M6bR33. Plus:
- The package contains: `package.json` (`name`, `version` = daemon version, `type: module`, `bin: { pap: "./apps/daemon/dist/main.js" }`, `engines: { node: ">=24.14 <25" }`, `license`, `repository`, `dependencies` = the union of the daemon's, contracts' and pi-host's external dependencies with `catalog:` replaced by the catalog's exact version and `workspace:*` entries removed, `bundleDependencies: ["@pap/contracts", "@pap/pi-host"]`), `apps/daemon/dist`, `apps/web/dist`, and `node_modules/@pap/{contracts,pi-host}/{package.json,dist}`. `main.js` resolves the web folder as `../../web/dist`, so the layout is `apps/daemon/dist` + `apps/web/dist` inside the package.
- Never in the package: any `.npmrc`, `*.test.js`, `*.map` of tests, `src/`, the build host's paths (the same `assertNoStagePath` scan on the output), a `scripts` entry (no `postinstall` of ours; node-pty's own install script compiles it).
- `bin/main.js` must keep its `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning` line and be mode `0755` in the tarball.
- The first step of the task is a measurement, recorded in the commit message: the size of `npm pack` output and whether `npm install --offline` of the tarball into a temp prefix works with a populated npm cache. If the tarball is above 150 MB or the bundled-dependency layout is rejected by `npm pack`, the implementer stops and reports; the plan's fallback is to publish the archive only and drop the npm channel from v1 (owner b4 named the package; dropping the channel needs a new owner decision).

- [ ] **Step 1: Measure** — `pnpm build && node scripts/build-npm.ts --out /tmp/pap-npm && (cd /tmp/pap-npm/package && npm pack --dry-run --json | head -c 2000)` (the real path comes from the scratchpad) — Expected: a file list with `apps/daemon/dist/main.js`, `apps/web/dist/index.html`, `node_modules/@pap/contracts/dist/...`; note the size.
- [ ] **Step 2: Tests (RED).** `build-npm.test.ts` (temp copies of the manifests, no network): no `catalog:`/`workspace:` string anywhere in the output manifest; every dependency version is exact (`/^\d+\.\d+\.\d+(-[\w.]+)?$/`); `bundleDependencies` is exactly the two; the union contains `zod 4.6.5` once; a version conflict between two manifests for the same package is an error naming the package; `bin`, `engines`, no `scripts`; the output refuses a staged `.npmrc` with `_authToken`; a test-file glob (`**/*.test.js`) in the copied dist is removed or refused; the shebang line is intact and the file mode is 0755.
- [ ] **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit scripts/build-npm.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) leave one `catalog:` entry unresolved: the exact-version test fails; (b) copy `.npmrc`: the credential test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(npm): build the npm package folder from the staged tree with bundled workspace packages"`

---

### Task 14: Release configuration, the feed generator and the local assets [lane 3]

**Files:**
- Create: `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release.yml`, `scripts/release-feed.ts`, `scripts/release-feed.test.ts`, `scripts/release-assets.ts`, `scripts/release-check.ts`, `scripts/release-check.test.ts`
- Modify: `package.json` (add `"version": "0.0.0"` to the root; scripts `"release:assets"`, `"release:check"`), `.gitignore` (`/.pap-release/`), `docs/agents/install.md` ("Releases and channels")

**Interfaces:**
- Consumes: T2 (`FeedSchema`, `FEED_HOSTS`, `FEED_REPO`), `scripts/build-archive.ts` (its CLI, unchanged), `.pap-archive/` output.
- Produces:
  - `node scripts/release-feed.ts --dir <archive dir> --channel stable|next --tag v1.2.3 --repo SoulKyu/pi-agentic-platform --out <dir> [--node-min 24.14]` writes `pap-feed-<channel>.json` and `pap-feed-<channel>.env`, validating the JSON with `FeedSchema` before writing and refusing on any mismatch.
  - `pnpm release:assets [--channel stable|next] [--tag vX.Y.Z]` runs `build:archive`, then the generator, and puts archive, installer, `.sha256`, the two feed files in `.pap-release/<tag>/`; it prints the `gh release create` / `gh release upload --clobber` commands and does **not** run them.
  - `pnpm release:check` verifies the version triple, the tag format, the config shape and that `.github/workflows/release.yml` has no `push`/`schedule` trigger (until the v1 flip).

**Rulings (pre-dispatch):** M6bR21, M6bR34, M6bR36. Plus:
- **Feed file shapes (frozen; T15's parser and T9's schema depend on them).** JSON: exactly `FeedSchema`. Env (`pap-feed-<channel>.env`), one `KEY=value` per line, no quotes, no spaces, in this order, final newline: `VERSION`, `RELEASE_ID`, `INSTALLER_NAME`, `INSTALLER_URL`, `INSTALLER_SHA256`, `ARCHIVE_NAME`, `ARCHIVE_URL`. URLs: `https://github.com/<repo>/releases/download/<tag>/<name>`.
- **Channel mapping.** `stable`: tag `vX.Y.Z` (release-please); the stable feed is attached to every stable release, and GitHub's `releases/latest/download/` alias serves the newest. `next`: a rolling pre-release with the fixed tag `next`, assets replaced (`--clobber`) on each merge to `main`; its `version` is `<core>-next.<run number>`; `releaseId` stays the archive id.
- **release-please config (full; a test pins it):**

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": false,
  "include-component-in-tag": false,
  "packages": {
    ".": {
      "package-name": "pap",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [{ "type": "json", "path": "apps/daemon/package.json", "jsonpath": "$.version" }]
    }
  }
}
```

  and `.release-please-manifest.json` is `{ ".": "0.0.0" }`.
- **The workflow** has `on: workflow_dispatch` only, `permissions: contents: read` at the top and `contents: write` on the one job that creates a release, `persist-credentials: false`, and every `uses:` pinned by full commit SHA with a version comment, as `ci.yml` does. Step 1 of the task resolves the pins with a measurement, not from memory: `gh api repos/googleapis/release-please-action/git/ref/tags/<newest tag older than 3 days>` (the workspace `minimumReleaseAge` is 4320 minutes) and the same for `actions/checkout`; record the tag and SHA in the commit message. The job does: checkout, `./.github/actions/setup`, `pnpm release:check`, release-please-action (config and manifest paths), and on a created release `pnpm release:assets` and `gh release upload`. The `next` job runs on `workflow_dispatch` with `channel: next` until v1. ADR 0066 states the v1 flip: add `push: branches: [main]`, nothing else.
- `release-assets.ts` never calls the network. `--tag` defaults to `v<root version>`; `next` uses `next`.

- [ ] **Step 1: Resolve the pins** (the two `gh api` calls above; stop and report if `gh` is unauthenticated: public repositories answer without a token).
- [ ] **Step 2: Tests (RED).** `release-check.test.ts`: the three versions are equal (root, `apps/daemon/package.json`, manifest) and a copy where one differs fails with the file named; `v` + version is the tag; the config equals the JSON above key for key; the workflow has no `push`, `pull_request`, `schedule`, `workflow_run` trigger and every `uses:` is a 40-hex SHA; the workflow has no `secrets.` reference except `GITHUB_TOKEN`. `release-feed.test.ts` (fixture archive folder with a 3-byte archive and a tiny installer): the JSON passes `FeedSchema` and `releaseId` matches the file names; the env file has exactly seven lines in order and passes the same line-shape rules as `get-pap.sh` (T15 shares the fixture through `scripts/fixtures/feed-stable.env`, created here); an installer or archive name that does not match the release id is refused; `--repo` with a space or `..` is refused, and the default repo equals T2's `FEED_REPO`; the installer's `sha256` equals the file's; sizes equal the files'; `next` version has the `-next.` suffix; output files are written `wx` (an existing file is refused unless `--force`).
- [ ] **Step 3: Implement.** **Step 4: GREEN** — `pnpm vitest run --project unit scripts/release-feed.test.ts scripts/release-check.test.ts && pnpm release:check`.
- [ ] **Step 5: Mutation checks:** (a) change one version in a temp copy: the version test fails; (b) add `push:` to the workflow text in a temp copy: the trigger test fails; (c) let the generator skip `FeedSchema.parse`: the name-mismatch test fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "chore(release): release-please configuration, feed generator and local release assets"`

---

### Task 15: `get-pap.sh` (`curl | sh`) [lane 3]

**Files:**
- Create: `scripts/get-pap.sh`, `scripts/get-pap.test.ts`, `scripts/fixtures/` (the feed fixture from T14)
- Modify: `docs/agents/install.md` ("One-line install, when the repository is public")

**Interfaces:**
- Consumes: the env feed shape of T14 (frozen above), the pinned installer of M6.
- Produces: `sh get-pap.sh [stable|next] [-- <installer flags>]`; the documented one-liner `curl -fsSL https://raw.githubusercontent.com/SoulKyu/pi-agentic-platform/<tag>/scripts/get-pap.sh | sh -s -- stable`.

**Rulings (pre-dispatch):** M6bR35. Plus:
- The script runs under POSIX `sh` (so `curl | sh` works) and re-execs nothing. The installer is run with `bash` (the M6 installer is bash).
- `PAP_GET_REPO` overrides `owner/name` for forks and mirrors; it is validated as `owner/name` and only URLs under `https://github.com/<repo>/releases/download/` are accepted from the feed.
- The docs say, in these words: "`curl | sh` runs a script you have not read. Read it first (it is 70 lines) or download it, read it, then run it. The script and the files it fetches all come from github.com: that catches a damaged or half-replaced download, not a compromised GitHub account or release. Pin the script to a tag, as in the example. Release signing comes after v1." It also gives the two-step form and says it needs a public repository and a published release.

**Security contract (run in scratch against a fake `curl` mapping URLs to fixture files: happy path with forwarded flags, a wrong installer hash, a foreign archive host, an unknown channel, the `next` URL, and a feed with an extra line; all refused except the first, and the installer never ran in the refused cases):**

```sh
#!/bin/sh
# Fetches the pap installer and archive of one channel from GitHub Releases and runs the installer.
# The installer pins the archive's SHA-256; this script pins the installer's, taken from the channel's feed file.
# All three come from the same release host: that detects corruption and a swapped asset, not a compromised release (docs/agents/install.md).
# The whole body is one function called on the last line: a download cut at a line boundary runs nothing.
# usage: get-pap.sh [stable|next] [-- <pap-install flags, for example --port 7791>]
set -eu
umask 077

REPO="${PAP_GET_REPO:-SoulKyu/pi-agentic-platform}"
BASE="https://github.com/$REPO/releases"
die() { printf 'get-pap: %s\n' "$*" >&2; exit 1; }

fetch() { # url, output file, byte cap: https only, no redirect to anything else, bounded size and time
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --max-redirs 3 --connect-timeout 15 --max-time 900 --max-filesize "$3" --output "$2" -- "$1" \
    || die "download failed: $1"
}

main() {
  [ "$(id -u)" -ne 0 ] || die "do not run as root: pap is a user service"
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "the pap archive is for linux-x64"
  for tool in curl sha256sum bash mktemp; do command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"; done
  case "$REPO" in ""|*[!A-Za-z0-9._/-]*|*..*|/*|*/|*//*|*/*/*) die "PAP_GET_REPO is not owner/name" ;; */*) ;; *) die "PAP_GET_REPO is not owner/name" ;; esac

  channel="stable"
  if [ "$#" -gt 0 ] && [ "$1" != "--" ]; then channel="$1"; shift; fi
  [ "${1:-}" != "--" ] || shift
  case "$channel" in
    stable) feed_url="$BASE/latest/download/pap-feed-stable.env" ;;
    next) feed_url="$BASE/download/next/pap-feed-next.env" ;;
    *) die "the channel is stable or next" ;;
  esac

  work="$(mktemp -d "${TMPDIR:-/tmp}/get-pap.XXXXXX")"
  trap 'rm -rf -- "$work"' EXIT HUP INT TERM

  fetch "$feed_url" "$work/feed.env" 8192
  # The feed is data, never sourced: every line must match one of seven fixed shapes.
  VERSION="" RELEASE_ID="" INSTALLER_NAME="" INSTALLER_URL="" INSTALLER_SHA256="" ARCHIVE_NAME="" ARCHIVE_URL=""
  while IFS='=' read -r key value; do
    case "$key" in
      VERSION) case "$value" in ""|*[!0-9A-Za-z.+-]*) die "bad feed: VERSION" ;; esac; VERSION="$value" ;;
      RELEASE_ID) case "$value" in ""|*[!0-9A-Za-z._-]*) die "bad feed: RELEASE_ID" ;; esac; RELEASE_ID="$value" ;;
      INSTALLER_NAME) case "$value" in pap-install-*.sh) ;; *) die "bad feed: INSTALLER_NAME" ;; esac
        case "$value" in *[!0-9A-Za-z._-]*|*..*) die "bad feed: INSTALLER_NAME" ;; esac; INSTALLER_NAME="$value" ;;
      ARCHIVE_NAME) case "$value" in pap-*-linux-x64.tar.gz) ;; *) die "bad feed: ARCHIVE_NAME" ;; esac
        case "$value" in *[!0-9A-Za-z._-]*|*..*) die "bad feed: ARCHIVE_NAME" ;; esac; ARCHIVE_NAME="$value" ;;
      INSTALLER_URL) case "$value" in https://github.com/"$REPO"/releases/download/*) ;; *) die "bad feed: INSTALLER_URL" ;; esac
        case "$value" in *[!0-9A-Za-z._/:+-]*|*..*) die "bad feed: INSTALLER_URL" ;; esac; INSTALLER_URL="$value" ;;
      ARCHIVE_URL) case "$value" in https://github.com/"$REPO"/releases/download/*) ;; *) die "bad feed: ARCHIVE_URL" ;; esac
        case "$value" in *[!0-9A-Za-z._/:+-]*|*..*) die "bad feed: ARCHIVE_URL" ;; esac; ARCHIVE_URL="$value" ;;
      INSTALLER_SHA256) case "$value" in *[!0-9a-f]*) die "bad feed: INSTALLER_SHA256" ;; esac
        [ "${#value}" -eq 64 ] || die "bad feed: INSTALLER_SHA256"; INSTALLER_SHA256="$value" ;;
      *) die "bad feed: unknown line" ;;
    esac
  done < "$work/feed.env"
  [ -n "$VERSION" ] && [ -n "$RELEASE_ID" ] && [ -n "$INSTALLER_NAME" ] && [ -n "$INSTALLER_URL" ] \
    && [ -n "$INSTALLER_SHA256" ] && [ -n "$ARCHIVE_NAME" ] && [ -n "$ARCHIVE_URL" ] || die "bad feed: a line is missing"
  [ "$INSTALLER_NAME" = "pap-install-$RELEASE_ID.sh" ] && [ "$ARCHIVE_NAME" = "pap-$RELEASE_ID-linux-x64.tar.gz" ] \
    || die "bad feed: the file names do not match the release id"

  fetch "$INSTALLER_URL" "$work/$INSTALLER_NAME" 262144
  actual="$(sha256sum -- "$work/$INSTALLER_NAME" | cut -d' ' -f1)"
  [ "$actual" = "$INSTALLER_SHA256" ] || die "the installer does not match the feed's checksum: nothing was run"
  fetch "$ARCHIVE_URL" "$work/$ARCHIVE_NAME" 1073741824
  printf 'get-pap: pap %s (%s), channel %s\n' "$VERSION" "$RELEASE_ID" "$channel"
  status=0
  bash "$work/$INSTALLER_NAME" "$@" </dev/null || status=$?
  exit "$status"
}

main "$@"
```

- [ ] **Step 1: Tests (RED).** `get-pap.test.ts` (temp dir, fake `curl` on `PATH` that maps the last argument to `scripts/fixtures/` files, records every URL in a log, and fails any URL not in its table; fake installer that writes its argv to a file): the six scratch cases with exact stderr sentences; `sh -n`; the script text contains no `eval`, no `source`, no `. ` include, no `sudo`, no `wget`, no `| sh`/`|sh` inside the script; every `curl` call carries `--proto '=https'`, `--max-filesize` and `--max-time`; the feed's `INSTALLER_URL` for a different repo (`https://github.com/other/x/releases/download/...`) is refused; `PAP_GET_REPO='a/b c'` and `'a/b/c'` are refused; a feed line `INSTALLER_NAME=pap-install-../x.sh`, a feed URL containing `..` and `PAP_GET_REPO='a/../b'` are refused; **the script cut after each of its lines never runs the installer** (truncate the file after every line and run it: the body is one function called on the last line, so a prefix defines functions and exits or fails to parse, M6b-RT-16); the installer is started with standard input from `/dev/null` (the fake installer reads stdin and proves it got EOF); running as root is refused (skipped unless uid 0, as M6's tests); the temp work folder is removed on success and on every refusal (the fake `mktemp` folder is listed before and after); the exit code of the installer is the script's exit code (0, 1, 3, 4, 5).
- [ ] **Step 2: RED.** **Step 3: Implement** (the script above).
- [ ] **Step 4: GREEN** — `pnpm vitest run --project unit scripts/get-pap.test.ts`.
- [ ] **Step 5: Mutation checks:** (a) remove the SHA comparison: the hash test fails and the installer ran; (b) widen the URL case to `https://*`: the foreign-host test fails; (c) delete the `--proto '=https'` from `fetch`: the flag test fails; (d) `source` the feed: the injected-line test executes it (assert a marker file is NOT created); (e) remove the `</dev/null`: the stdin test fails; (f) call the body at top level (no `main`): the truncation test runs the fake installer and fails.
- [ ] **Step 6: Gates.** **Step 7: Commit** — `git commit -m "feat(install): get-pap.sh, a verified one-line bootstrap for the release channels"`

---

## Join

### Task 16: Rebase on M12, docs, ADRs, rulings and the whole gate [join]

**Files:**
- Create: `docs/adr/0063-backup-and-restore.md`, `0064-update-transaction-and-rollback.md`, `0065-the-oci-image.md`, `0066-release-channels-feed-and-curl-sh.md`, `0067-doctor-and-the-update-check.md`, `docs/research/m6b-rulings.md`
- Modify: `apps/daemon/src/cli/doctor/registry.ts` (the two M12 lines, if T11 could not add them), `AGENTS.md` (one group, at most 6 lines, recount within 150 lines), `README.md` (an "Install, update, backup" section: five lines), `docs/agents/daemon.md` (one line under the CLI paragraph), `docs/agents/install.md` (reconcile T12 to T15 sections; "Deferred to M6b" becomes "After v1"; the layout table gains `downloads/` and `update/`), `docs/agents/backup.md`, `docs/agents/update.md`, `docs/agents/doctor.md` (final passes); `docs/plans/roadmap.md` is not edited by this plan (the controller updates the M6b row after the merge)

**Content (short, practical; every command copied from a passing test or a by-hand run):**
- `backup.md`: what a backup holds and does not hold (both lists), the secrets rule in three lines and the sensitivity sentence, encrypted vs plain and what each detects, restore step by step with the refusals table, `--unit`/`--home` resolution, the push-notifications sentence ("each device re-enables when it next opens pap"), where the old data is after a restore (`backups/pre-restore-<stamp>*`), `--keep`.
- `update.md`: the update transaction in one diagram, the locks, the exit codes, "what an update interrupts" (copied from install.md), `pap update recover` and `--keep-database`, manual rollback and its one decision, why not from pap's own terminal, workers and `KillMode` (M6bR53), the daily check and `PAP_UPDATE_CHECK` (off until the v1 flip, `=1` enables) / `PAP_UPDATE_CHANNEL`, a downgrade to a pre-M6b release (flags path, no rollback), troubleshooting rows (start limit reached, journal unreadable, disk full, `pending.json` present, damaged `pending.json`, restore says newer pap).
- `doctor.md`: the check table (the registry test reads it), the status meanings (`info` counts as ok), exit codes, `--unit`.
- `install.md`: Container, npm, releases and channels with the "works now / waits" table, `get-pap.sh` with the trust sentence, building the archive in `ubuntu:22.04`.
- ADRs: 0063 (format, the secrets rule and owner b1's answer, the untrusted reader and its three layers with the pax lesson, what a plain backup detects, the restore summary's notification line), 0064 (the order of the transaction, why the snapshot is taken after the stop, the locks, why the migration rule, exit codes, what rollback loses, why the new release's CLI orchestrates and the outer net, the self-kill guard, workers that can outlive a stop), 0065 (the S8 option set and `keep-id`, what `systempaths=unconfined` costs, rootless only, fail-closed in three places), 0066 (hosts allowlist and the project path, the feed, channels, `curl | sh` trust, what signing will add, the v1 flip including `UPDATE_CHECK_DEFAULT`), 0067 (doctor read-only and the immutable open, severities and `info`, the update check's one daily request and its privacy cost).
- `m6b-rulings.md`: M6bR1 to M6bR57 with why and cost, as in `m6-rulings.md`, plus the owner answers c1 to c5, b1 to b10 (n1 to n10 are M12's) after the question page.

- [ ] **Step 1: Rebase on M12 (owner c1).** `git fetch` is not needed (local): `git rebase main` once M12's branch has merged; resolve `run-cli.ts`, `usage.ts`, `knip.json`, `package.json`, `AGENTS.md` by keeping both sides' whole lines. Then add the `https` and `push` registrations to `registry.ts` (`makeHttpsCheck(pushReadiness)`, `makePushCheck(pushReadiness)`, imported from `kernel/push-readiness.ts`), remove the pending-ids constant from `registry.test.ts`, add the two rows to `docs/agents/doctor.md`, and re-run T11's tests: the status table for both checks must agree with `pushReadiness` for every status M12 defines (the registry test calls the real function over the five facts shapes). If M12 has not merged, this task waits (M6bR47); it never re-implements `pushReadiness`.
- [ ] **Step 2: Write the docs.**
- [ ] **Step 3: Cross-lane checks (the reason the join exists):**
  - `pnpm release:assets --tag v0.0.0-test` on a built tree, then `node scripts/release-feed.ts` output fed through `FeedSchema.parse` (a one-off `node -e` using the daemon's `feed.ts`) — Expected: passes; and the `.env` file passes `scripts/get-pap.sh`'s line rules (run the script's parser against it with the fake `curl` of T15's test, which T16 re-runs on the real generated file).
  - A scripted scenario: `update apply` fails in the int test fixture → `pap doctor` (the real CLI, temp home) prints `[fail] update_pending ... fix: pap update recover` and exits 1 → `pap update recover` clears it → `pap doctor` exits 0 (a healthy default install, `info` lines only, M6b-RT-13) or 2.
  - `pap backup` then `pap restore` on the home the smoke test created (`pnpm smoke:install` leaves none; use a fresh temp home with the built `dist`), then `pap doctor --only schema` on it and a listing of the home: no `-wal`, no `-shm` left by the doctor.
  - Image entrypoint: the container entrypoint's `pap doctor --only bwrap` runs against the built `dist` (the registry now has the real check).
- [ ] **Step 4: Literal-character scan** over every file the milestone touched: `rg -nP '[\p{Cf}\p{Zl}\p{Zp}\x{00A0}]' apps/daemon/src/cli scripts Containerfile docs/agents docs/adr/006[3-7]* docs/research/m6b-rulings.md docs/plans/2026-10-17-m6b-update-backup-release.md README.md` — Expected: no match.
- [ ] **Step 5: Whole gates** — `pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke && pnpm smoke:install && pnpm budgets && pnpm release:check` — Expected: all green; `pnpm budgets` unchanged (no web change); `pnpm-lock.yaml` unchanged (no dependency). The join takes one heavy-gate slot at a time.
- [ ] **Step 6: Commit** — `git commit -m "docs(release): backup, update, doctor and release guides, ADRs 0063 to 0067 and the M6b rulings"`

---

## Model table

Implementers are Sonnet, never Haiku. Reviewers are Sonnet unless the line says Opus with its reason. The final review is Opus. **Opus escalation at fix rounds 4 and 5 is pre-approved for this wave (owner c2)**; the controller names the task and the open findings in the ledger before round 4, and no other upgrade is allowed.

| Task | Lane | Implementer | Reviewer | Why |
|---|---|---|---|---|
| T1 operations base | base | Sonnet | Sonnet | small primitives with strong tests; the snapshot, no-write open and lock code are given in full |
| T2 feed schema and fetcher | base | Sonnet | **Opus** | the only outbound code: redirects, host allowlist and project path, byte caps, runs inside the daemon |
| T3 `pap backup` | 1 | Sonnet | Sonnet | the secrets rule is one pure function with a truth-table test; modes have tests; `collect` has the M6b-RT-04 cases |
| T4 encryption | 1 | Sonnet | **Opus** | hand-assembled crypto container (AAD, cost bounds, failure cleanup) |
| T5a archive reader, stage walk, placement | 1 | Sonnet | **Opus** | the untrusted-archive reader and its three layers (M6b-RT-01, Critical): checklist = pax allowlist, checksum, differential against GNU tar, the walk before any chmod, placement undo |
| T5b restore flow | 1 | Sonnet | Sonnet | lock order, refusals and summary, covered by one test per refusal row |
| T6 update core | 2 | Sonnet | **Opus** | swap, snapshot, rollback, the journal and the locks: data loss if wrong; checklist = M6b-RT-03 guard, RT-05 unreadable journal, RT-11 locks, RT-18 no re-entry |
| T7a `update apply` command | 2 | Sonnet | Sonnet | wiring and the health probe, fully specified; the T6 Opus review covers the transaction it calls |
| T7b installer template | 2 | Sonnet | **Opus** | edits the pinned-hash installer and its trap; exit-code contract; the refusal of a release that cannot roll back |
| T8 rollback and recover | 2 | Sonnet | Sonnet | reuses T6's `rollback()`; decision logic with tests |
| T9 check, install, daily check | 2 | Sonnet | Sonnet | hash compare, a timer and parsing; T2's Opus review covers the fetcher it uses (owner c3) |
| T10 doctor core | 1 | Sonnet | Sonnet | read-only framework |
| T11 doctor daemon checks | 1 | Sonnet | Sonnet | branches over injected probes |
| T12 OCI image and wrappers | 3 | Sonnet | **Opus** | container flags and what the image contains (R52b) |
| T13 npm package | 3 | Sonnet | Sonnet | builder over manifests; credentials scan reused |
| T14 release config and generator | 3 | Sonnet | Sonnet | config and a generator validated by T2's schema |
| T15 `get-pap.sh` | 3 | Sonnet | Sonnet | a 75-line sh script whose trust root is the same host; T2's Opus review covers the real network code (owner c3) |
| T16 rebase, docs and join | join | Sonnet | Sonnet | |
| Final | | | **Opus** | whole-branch review |
| Red-team of this plan | | | Sonnet | done (`redteam-m6b.md`) |

Opus review lines: 6 of 18 tasks (T2, T4, T5a, T6, T7b, T12) plus the final review, the ones that touch the network, crypto, an untrusted archive, a database restore, a pinned installer or container flags. The red-team's cut: T9 and T15 drop to Sonnet (their trust roots are T2's reviewed fetcher and the same release host). Never Haiku.

## ETA

Observed: about 1 to 1.5 h per task with reviews (M6: 7 tasks in about 7 h wall clock; M11: 37 tasks in about two days with three chains).

| Segment | Tasks | Estimate |
|---|---|---|
| Base (parallel) | T1 (1.5 h), T2 (1.25 h) | **1.5 h** |
| Lane 1: backup, restore, doctor | T3 1.25, T4 1.25, T5a 1.25, T5b 1.25, T10 1.25, T11 1.5 | **7.75 h** |
| Lane 2: update | T6 1.75, T7a 1.5, T7b 1.0, T8 1.25, T9 1.25 | **6.75 h** |
| Lane 3: packaging | T12 1.75, T13 1.5, T14 1.5, T15 1.0 | **5.75 h** |
| Join | T16 plus the whole gate (30 to 45 min) | **1.5 h** |

**Critical path: base, lane 1, join: 1.5 + 7.75 + 1.5 = 10.75 h of work. Honest wall clock: 12 to 15 h** (two heavy-gate slots shared with M12's three chains and the models batch; the full gate is 30 to 45 minutes and runs once here), i.e. about **one and a half working days**. Agent time about 24.5 h (the red-team's cut gave about 9.5 h of work before the T5 and T7 splits and the fixes in this plan; the planner's own two-chain cut was 13.25 h). Lane 1 ends 1 to 2 h after lanes 2 and 3, which idle; M12's own critical path (16 to 18 h) still dominates the combined finish, so M6b merges second anyway (owner c1). The riskiest minutes: T13 step 1 (the bundled-dependency layout may not survive `npm pack`; the stop rule is in the task), T14 step 1 (action pins need a network lookup), T7b's installer edit (the M6 harness is strict), the rebase on M12 (T16 step 1), and the real-host run (Appendix A), which is the controller's and has the owner's OK (b8).

## Exit criteria (roadmap M6b: a failed update rolls back on its own; backup / restore round-trips the state)

No browser is needed (decision 42). What replaces each one now, and what the owner checks by hand:

| Criterion | Proven now by | The owner checks by hand |
|---|---|---|
| A failed update rolls back on its own | T6 scenarios 2 to 5 and 9 (fake dependencies), T7a `apply.int.test.ts` (the real CLI, fake systemd, a real migrated database: exit 4, `current` back, database restored), T7b installer cases | Appendix A step 6: a deliberately broken archive on the try instance (port 7791): exit 4, old release serving |
| A successful update keeps data | T6 scenario 1, T7a int test | Appendix A step 5: sessions still listed after `./pap-install-<id>.sh` with no flags |
| An interrupted update can be finished | T6 scenario 5, T8 recover tests, T16 doctor + recover scenario | `kill -9` the `pap update apply` process during the settle window on the try instance, then `pap update recover` |
| Backup / restore round-trips | T5b `restore.int.test.ts` (real CLI, temp `HOME`, real migrated database, encrypted, with secrets) | Appendix A step 7: back up the try home, restore it to a new `--home`, sign in |
| Restore refuses a newer schema, a running daemon and a hostile archive | T5a hostile-archive tests (GNU tar, the pax `size` smuggle), T5b refusals tests | none (no way to craft a newer pap by hand) |
| The vault key is handled explicitly (M6R44) | T3 secrets truth table and the "no secrets in a plain backup" test, T4 encrypted include test | read the backup summary; `tar -tzf` a plain backup and see no `secrets/` |
| `pap doctor` | T10, T11 and their int test | run `pap doctor` on the preview host and on the try instance; compare with what you know |
| OCI image, sandbox fails closed | T12 text and argv tests | Appendix A step 9 (podman is installed on this host, R49) |
| npm channel | T13 | `npm pack` and an install into a temp prefix (network) |
| release-please, channels | T14 | none until the repository is public |
| curl piped to sh | T15 against a fake `curl` | none until the repository is public |

## Coverage map

| Source | Task |
|---|---|
| Decision 87: the rest of D21 | T3 to T15 |
| OCI image with bubblewrap, R52b, S8 | T12 (M6bR29 to M6bR32), owner b7 |
| npm channel | T13, owner b4 |
| `pap doctor` (Node, toolchain, linger, journal, bwrap, python3, disk, HTTPS and push readiness) | T10, T11 |
| Backup and restore (`VACUUM INTO`, modes, newer-schema refusal, lock, temp-HOME round trip) | T1, T3, T4, T5a, T5b |
| Update with automatic rollback (running daemon, workers, unit, what "failed" means, swap and restore code, integrity checks) | T6, T7a, T7b, T8; ADR 0064 |
| release-please | T14 |
| Stable and next channels, `PAP_UPDATE_CHECK=0` | T9, T14 |
| M6R44 | T3, T4, T5a, T5b, owner b1 |
| M6R31 (curl piped to sh, OCI) | T12, T15 |
| M6R34 (podman wrapper) | T12 |
| W5-R2, W5-R18 (journal checks) | T10 (`journal`), T6 (unverified) |
| M6 real-host check | Appendix A |
| Reuse of M6's pinned SHA-256 pattern (ADR 0057) | T7b (the installer), T9 (the installer hash from the feed), T15 |
| Sign-out resets every client store (MC34) | n/a: no client store, no web code |
| Signing, SBOM, SLSA | After v1 (header) |
| Hot spots named for M12 | conflict scan, M6bR27 |

## Owner answers (2026-10-17)

Page `m12m6b-q1` (artifact https://claude.ai/artifact/2qChJZQ9CUtqoZBBYdyDzT), answered 2026-10-17T07:08Z. **Every answer is the page's recommendation, with no notes.** Raw answers: `.superpowers/owner-answers-2026-10-17-m12m6b.json`. Each is applied as a ruling.

- **c1 (m12first):** M12 merges first, M6b rebases on it. Applied as M6bR47 and T16 step 1.
- **c2 (yes):** Opus escalation at fix rounds 4 and 5 is pre-approved for this wave. Applied in M6bR38 and the model table.
- **c3 (lanes3):** M6b in three lanes, T5 and T7 split, T9 and T15 Sonnet-reviewed. Applied as M6bR37, the lane graph and the model table.
- **c4 (move):** M12's task 16 to chain A and task 19 to chain B. M12 only; no effect here.
- **c5 (excluded):** the VAPID key is excluded from plain backups like `secrets/`; devices re-enable on open. Applied as M6bR2 and M6bR48.
- **b1 (excluded):** `secrets/` only with `--secrets include --encrypt`; the copy says transcripts can hold secrets (M6b-RT-10). Applied as M6bR2.
- **b2 (warn):** plain backups are allowed with a one-line warning. Applied as M6bR49 and the T3 summary text.
- **b3 (include):** Pi `sessions/` are included, never `auth.json`. Applied as M6bR3.
- **b4 (scoped_full):** npm name `@soulkyu/pi-agentic-platform`. Applied as M6bR33 and T13.
- **b5 (github):** GitHub Releases plus the feed, no signature before v1. Already M6bR21 and M6bR35; ADR 0066.
- **b6 (restore):** a rollback restores the snapshot when a migration ran. Already M6bR14, kept.
- **b7 (unconfined):** the container ships the measured option set with `systempaths=unconfined` (R52b). Already M6bR29, kept, with `keep-id` added.
- **b8 (yes):** the controller may run the real-host checks on this host after the Opus final review (ports 7791 to 7793, `~/.pap-m6b-try*`, the preview untouched). Applied as M6bR54 and Appendix A.
- **b9 (unit):** `--unit` and `PAP_UNIT`, default `pap.service`. Applied as M6bR50.
- **b10 (v1):** the daily update check stays off until v1. Applied as M6bR22 (`UPDATE_CHECK_DEFAULT`).
- **n1 to n10:** M12's questions (push host list, lock-screen text, crypto, default classes, presence, quiet hours, device cap, icons, rate limits, budget push); no effect on M6b except that neither plan adds a dependency (n3, n8).
- **Settled by ruling, no question asked:** the red-team's Q6 (archive installs only, M6bR10) and Q10 (`next` is a rolling pre-release, M6bR21).

## Merge order and conflict notes (with M12)

- **M12 merges first, then M6b rebases (owner c1, M6bR47).** M12 owns the contracts, `daemon.ts`/`compose*.ts`, `kernel/config.ts`, the Settings navigation, the i18n catalogs, `budgets.json` and a migration, all of which M6b leaves alone. M6b's own shared lines are whole-line additions (`run-cli.ts`, `usage.ts`, `package.json` scripts, `knip.json`, `.gitignore`, `AGENTS.md`, `daemon.md`) that rebase over M12 in minutes. M6b has no migration, so nothing is re-stamped either way.
- **Doctor interface:** M12 owns the pure `pushReadiness(facts)` in `kernel/push-readiness.ts` and the anchor `docs/agents/notifications.md#https` (its task 21); M6b owns `listenFacts`, both doctor files for `https` and `push`, and the registry (M6bR27). Lane 1 builds them against an injected readiness function; T16 step 1 wires the real one.
- The owner's preview (`pap-preview.service`, 192.168.1.182:7777, `~/.pap`) is untouched by every test and by Appendix A (try instances use their own ports and homes). M6b changes nothing the preview unit depends on; after the merge the preview is rebuilt and restarted as usual, and `pap doctor --unit pap-preview.service` is the first thing to run on it (M6bR50).
- ADR numbers: 0063 to 0067 are M6b's (M12 0058 to 0062, the models batch 0068 to 0070). The decisions log is appended by M12's plan fix (decision 93 records the M12 and M6b owner answers and both plans).
- Heavy gate: two slots shared by every lane of M12, M6b and the models batch; M6b's lanes hold a slot only while gating; a join never holds both slots; `test:int` runs only in T3, T5b, T7a, T10 and at the join.

## Appendix A: real-host check (controller-run, after the Opus final review, owner b8)

The M6 checklist (`.superpowers/sdd/2026-10-15-m6-install/real-host-check.md`, sections 0 to 4) runs first, unchanged; its results replace the "Real-host check: pending" lines in `docs/agents/install.md`, ADR 0056 and W5-R2. Then, with the same pre-checks (no `pap.service`, ports 7791 to 7793 free, the preview active):
5. **Update, success.** Build archive A (`pnpm build:archive`), install it with `--port 7791 --home ~/.pap-m6b-try --bin-dir ~/.pap-m6b-try/bin`; make a session, then build archive B (a one-line change, `--allow-dirty`) and run `./pap-install-B.sh` with no flags. Expect exit 0, `current` -> B, `systemctl --user show pap -p NRestarts` = 0, the session listed, `backups/pre-update-*.db` present. **Workers (M6bR53):** with linger on, `systemctl --user list-units 'run-*.scope'` is empty after the stop; record what an older pap leaves behind if it is not.
6. **Update, failure.** Build archive C whose `dist/main.js` exits 1 on start. Run its installer with no flags. Expect exit 4 well before the 120 s deadline (the unit reaches `failed`, M6bR11e), `current` -> B, the service serving B, the journal naming the rollback, `pending.json` absent, and (if C adds a migration file) the pre-update database restored. Then run `pap update apply` from a shell opened in the try instance's own web terminal: it must refuse with the "SSH or console shell" sentence and change nothing (M6bR52).
7. **Backup and restore.** `pap backup --encrypt --secrets include --passphrase-stdin`; stop the service; `pap restore --home ~/.pap-m6b-try2 --passphrase-stdin`; start a second instance on 7792 over that home; sign in; compare sessions. Also `pap backup --home ~/.pap-m6b-try` with `PAP_HOME` unset in the shell: it must print `home: ... (from the flag)` (the `--home` flag wins over the unit) and not touch `~/.pap`; `home: ... (from the unit)` appears when neither `--home` nor `PAP_HOME` is given.
8. **Doctor.** `pap doctor` on the try instance, and `pap doctor --unit pap-preview.service` on the preview host; record every non-ok result and whether it is right (a healthy default install exits 0 with `info` lines only); list the home before and after.
9. **Container.** `scripts/pap-container.sh build`, `run --port 7793 --project <a scratch folder>`, `url`; complete setup and sign in through the published port; write a file into the mounted project from inside the container (`podman exec pap touch /work/<name>/new`) and see it owned by the host user (M6b-RT-07, `keep-id`); verify the `pap-data` volume initialised with that mapping; `podman exec pap node /opt/pap/apps/daemon/dist/main.js doctor --only bwrap` -> ok; run the same image without `--security-opt systempaths=unconfined` -> `sandbox_unavailable` for an agent that requires it; `podman history --no-trunc localhost/pap:dev` and `podman run --rm --entrypoint sh localhost/pap:dev -c "find / -name '.npmrc' -not -path '/proc/*' 2>/dev/null"` show no credential and no `.npmrc` (M6b-RT-26); record the image size and build time; `stop`.
10. **npm.** `pnpm build:npm`, `npm pack`, install the tarball `@soulkyu/pi-agentic-platform` into a temp prefix (network), `pap --help`.
11. **Cleanup** as the M6 checklist section 4, plus `podman rm -f pap; podman volume rm pap-data; rm -r ~/.pap-m6b-try*`.
The outputs are recorded in `.superpowers/sdd/2026-10-17-m6b/real-host-check.md` by the controller. If a step fails the plan's fallbacks apply: drop `NoNewPrivileges` only (W5-R2), or a note in the ADR for the unit.

## Deferred minors

Everything not listed here is fixed in the task named in the findings table of the plan-fix report (`.superpowers/planfix-report-m6b.md`).
- **M6b-RT-20 (b), encrypted backups:** an encrypted backup is not re-read at creation (the plaintext is never written to disk to be re-read); the restore re-validates everything. Plain backups are self-checked (M6bR55).
- **M6b-RT-22, restore marker:** no marker file for a restore cut by a power loss between the folder renames and the `state.db` rename; the docs say the old data is under `backups/pre-restore-<stamp>*` (M6bR7). A marker plus an automatic undo is a follow-up if the owner wants it.
- **M6b-RT-25, loopback `PAP_PUBLIC_ORIGIN` on another port:** the install summary can claim "an owner exists" when the daemon logged a setup URL for a different loopback port; cosmetic (it affects one sentence of `pap service install`, not an update decision). Deferred to the next change that touches `readJournal`. The second M6 carry (a warning when `PAP_HOME` is set without `--home` at install) is already in the code (`cli/service/install.ts`, M6); M6b adds the doctor `home` info line for the same mismatch.
- **Pruning `backups/pre-restore-*` and `pre-update-*` folders** other than the three newest update snapshots: left to the owner (documented), since each holds data a restore replaced.
- **A signed feed, SBOM, provenance:** after v1 (decision 75).

## Self-review

- **Spec coverage:** every line of the brief's M6b section maps to a task in the coverage map; the carried items (M6R44, M6R31, M6R34, W5-R2, W5-R18, the real-host check) are named; "After v1" lists signing, SBOM and provenance. Every red-team finding has a task (plan-fix report).
- **Placeholder scan:** no TBD or "handle edge cases"; the places that depend on a measurement (T13 step 1: package size and layout; T14 step 1: action SHAs; T12 step 8 and Appendix A: the image build) say what to do on each outcome. One deliberate non-claim: the Containerfile was not built here (no network in the plan session); its tests are text and argv tests, and Appendix A step 9 builds it.
- **Type consistency:** `Readiness` is the existing union from `service/readiness.ts`; `Pending`, `ApplyDeps`, `ApplyOutcome` are defined once in T6 and consumed by T7a and T8; `Feed`, `FEED_REPO` and `FetchRefused` once in T2; `Check`, `CheckResult`, `DoctorContext` once in T10; `snapshotDatabase`, `schemaIds`, `restoreDatabaseFile`, `acquireOpLock`, `resolveTarget` once in T1 (T5a's `placeRestored`, T5b, T6's `rollback` and T7a import them); `safeMemberPath` once in T3 (T5a imports it, so no task depends on a later file of its own lane); `listMembers` only in T5a; the env feed shape in T14 and T15; `piAgentDirFrom` in T1 (`kernel/pi-dir.ts`) and T3/T5b; `installRoot` in T1 and T7a/T9. `pap update apply --help` is a capability probe (the command defines `help` so the probe exits 0).
- **Sizes:** no file is planned above 300 lines; `apply.ts` is about 190 lines, `tar-list.ts` about 190, `crypto.ts` 98.
- **Honest unknowns:** whether npm accepts the bundled layout (T13 step 1); the exact `release-please` and action pins (T14 step 1); the real journal behaviour of the unit's `NRestarts` on systemd 259 (Appendix A, step 5 records it; the settle check degrades to the `ActiveState` and `/healthz` checks if `NRestarts` is unavailable: `restartCount` returns null and the comparison `null !== null` is false, so a host without the property still gets two of three checks); the exact file format of `pap.lock` that `readLockPid` reads (T1 reads `acquireInstanceLock` first); whether M12's `pushReadiness` will return the fifth status `keys_unreadable` itself (T11 maps it when present and reports the key-file state on its own either way).
