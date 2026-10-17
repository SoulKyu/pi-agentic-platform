# M6b final review (Opus) and real-host check

Whole-branch review of feat/m6b-join (ff6766e1..7289d4ef), its scoped Opus re-review after the fix (7289d4ef..36932268), then the real-host check (plan Appendix A, owner b8) run by the controller on the final tree with its fix rounds: the installer same-release rerun and unit restore (80de3ced, Opus re-review: signals gap, fixed 2c34cd61), copy and npm package fixes (6e7d57d2, 702fdd71; Sonnet re-review: one Important, fixed 58bf00ef, controller check). M6b merged as 2e2613b.

## M6b final review (ff6766e1..7289d4ef): Ready after fixes

I found four Important issues and no Critical one. Each of the four was reproduced in a scratch copy and each is a small, local fix. The full gate passes on 7289d4ef in a fresh copy, M6b merges on top of M12 and models A with no textual conflict, and nothing in the worktree, pi-web, `~/.pap` or the user manager was touched. The scratch copy is deleted.

One note on the range: the branch base is c518144b, so the two-dot `ff6766e1..7289d4ef` diff file also contains main's A0 commit in reverse (11 files, about 1.9k lines). M6b's real range is `c518144b..7289d4ef`, 183 files.

#### Spec Compliance
- ❌ Issues found, details under Important:
  - **M6bR14 / ADR 0064's loss bound is false for `recover`** (I-2).
  - **M6bR51 says a hand-started daemon makes `update apply` refuse before anything changes.** The code writes `pending.json`, stops the unit and exits 5 at the `lock` step instead (`apply.ts:190-192`; test 10 at `apply.rollback.test.ts:160-171` pins this). The outcome can be recovered. Minor.
  - **The T16 disposition "callers hold the instance lock" is wrong for `pap backup`** (I-1).
- ⚠️ Cannot be checked here:
  - the image, npm and workflow runs, and the casing of `FEED_REPO` (needs a public repository);
  - systemd versions without `NRestarts`: `apply.ts:224` then fails the update and rolls back every time, while the plan's "Honest unknowns" say the check degrades. Fail-closed is fine; it should be written in `update.md`.

#### Lessons checklist
| Item | Result | Evidence |
|---|---|---|
| Bounded resources | ✅ | Reader caps for entries, bytes, depth and pax (`tar-list.ts:156-173`); fetch byte cap (`fetch.ts:100-106`); `readJsonBounded`; 64 KiB caps for `pending.json` and `systemctl cat`. Minor: `install-command.ts:111-139` keeps an archive of up to 1 GiB in memory. |
| No silent errors | ✅ | Prune failures are reported (`apply-command.ts:154-157`). The empty `catch` blocks carry comments. |
| Time bounded | ❌ minor | Fetch deadline and the 30-minute installer timeout are there. `tar` in `restore.ts:163-176` and `create.ts:142-151` has no timeout, against the global constraint. |
| Fail closed | ✅ | Rollback over an unknown migration ends `rollback_failed`; an unreadable journal needs `/healthz` and an active unit; unreadable records are `warn`. |
| Untrusted text escaped | ❌ | I-3: `check-command.ts:45` and `collect.ts:44-49`. |
| Auth, Origin, owner | n/a | CLI only, no RPC. |
| Check-then-act | ❌ | `op-lock.ts:67-72`: compare, then remove, is not atomic (I-4, reproduced). |
| Keys unique | ✅ | `.part` names use pid plus random; a same-second `pre-restore` is refused by `snapshotDatabase:27`. |
| RED and mutation checks | ❌ | The ENOENT retry and compare-before-remove in `op-lock.ts:58,68-72` have no failing-first test (`op-lock.test.ts`). |
| Exact assertions, no sleeps, hygiene | ✅ | Clock injected; temp `HOME`; fake systemd. The int run used the clean env with `CI=1`. |
| Repo rules | ✅ | Largest file 387 lines; no AI trailers; literal-character scan 0 hits. |
| Docs don't overclaim | ❌ | ADR 0064 lines 25 and 29, `update.md` line 53, `m6b-rulings.md` line 131. |

#### Strengths
- The untrusted-archive chain holds:
  - checksum read as latin1 and ASCII only;
  - pax allowlist with no repeated keys;
  - implied folders counted before the set grows;
  - `assertPlainTree` then `ownerOnly` with nothing in between;
  - fixed error sentences;
  - the stage lives in `$PAP_HOME/tmp`;
  - top-level names are checked against both the listing and the manifest.
- Restore with `--replace` deletes nothing and undoes newest first.
- The journal names the snapshot before `current` moves; every restart is preceded by `reset-failed`.
- The feed and fetcher check https, the host and the project path on every hop, with a streaming cap. The installer gets an allowlisted environment, `PAP_UNIT` is unset and the home comes from the unit.
- The `pending.json`, `last-backup.json` and `last-check.json` shapes are written and read the same way everywhere.
- Exit codes are consistent: 0, 1, 3, 4, 5 and 64 for update; 0, 1, 2 and 64 for doctor; the installer passes them through.

#### Issues

##### Critical
None.

##### Important

**I-1. `pap backup` can delete a live daemon's `-wal` and `-shm`.**
- **Where:** `snapshot.ts:32-38` with the cleanup at `snapshot.ts:57-61`. `pap backup` is the only caller that does not hold the instance lock (`create.ts:281`).
- **How:** when the home has no sidecar files, the snapshot opens the database with the immutable URI, which creates none. The `finally` block still removes every sidecar that "did not exist before". If a daemon starts during the `VACUUM INTO` (for example a backup timer overlapping `update apply`, or a crash restart), the backup deletes that running daemon's live WAL files.
- **Reproduced:** the daemon committed a row; after a SIGKILL the row was gone. A reader started meanwhile saw `[]`. A later backup would take the immutable path again and silently miss those writes.
- **Fix:** never delete sidecars in the immutable branch. In the read-only branch delete them only when the caller holds the instance lock. If sidecars appear during the snapshot, redo it through the read-only connection, because the immutable read may be torn. Correct `backup.md` line 10 and the `m6b-rulings.md` line 131 disposition.

**I-2. `pap update recover` can throw away days of writes and keeps no copy.**
- **Where:** `apply.ts:124-133` calls `restoreDatabaseFile` (`snapshot.ts:89-119`), which replaces `state.db` without keeping it. `recover-command.ts:53` reaches it from the journal; the doctor fix for `update_pending` is `pap update recover` (`checks-daemon.ts:114-118`).
- **Story:** the SSH connection drops, or the owner presses Ctrl-C, during the roughly 2-minute verify wait. `apply` has no signal handler, so it dies. The migrated new release keeps running. A week later the owner follows the doctor's fix: the snapshot is restored and a week of writes is discarded.
- **Reproduced** with the real `rollback()`: 30 simulated days of rows, outcome `rolled_back`, nothing left in the home. Manual `rollback --restore-database` has the same cost. Also, `restore` ignores a live `pending.json` (`backup/restore.ts:325-357`), so a later `recover` can overwrite a database the owner just restored.
- **Fix:** before `restoreDatabaseFile`, keep the current database as `backups/pre-rollback-<stamp>.db` (instance lock held). If it cannot be kept, end `rollback_failed`/`database`. Optionally, ask for `--restore-database` or `--keep-database` when the journal is older than the deadline plus settle. Make `restore` refuse while `pending.json` exists. Correct the "at most deadline plus settle" sentence in ADR 0064 line 29 and `update.md` line 53.

**I-3. Untrusted text reaches the terminal raw in two places.**
- The feed's `notes` field passes `FeedSchema` with a newline or ESC/BEL in it (verified: `isReleaseUrl` and the schema both accept it), and `check-command.ts:45` prints it raw.
  - Fix: print `new URL(feed.notes).href`, or limit the schema to printable ASCII.
- `collect.ts:44-49` clips names over 80 characters before the control-character replacement, so a long name keeps its escape bytes (verified with ESC and BEL). An agent can create such a file in `agents/`, and `backup.ts:68-72` prints it in the summary.
  - Fix: replace control characters first, then clip.

**I-4. The T16 open Important: what the op.lock loser actually does.**
- **The race is real.** I reproduced it by forcing A's full acquisition between B's compare-read and B's remove: both processes hold the lock, and when the loser releases it, `op.lock` is gone while the winner is still running.
- **What the loser does:**
  - In `apply` it fails at `holdHome` and goes to `rollback()` (`apply.ts:186-192`). It rewrites `pending.json` as `rolling_back` with `snapshot: null`, calls `stop` a second time, and tries the instance lock again.
  - While the winner holds the instance lock, the loser exits 5 ("run pap update recover"), leaves its `pending.json` and does not restart the unit.
  - If the winner has already released the lock (no database, or a tiny one), the loser's rollback runs for real. It stops the winner's new daemon. Then either it switches back and restarts the old release, or it stops at `database` (no snapshot) and leaves the unit stopped. The winner then rolls back with its own snapshot.
  - A `restore` that loses fails at the instance lock before it changes anything.
- **Verdict:** no data loss. The database rule fails closed and everything converges, at worst after `recover`. But "the instance lock is the final exclusion" (ADR 0064 line 25, `update.md` line 25) is an overclaim: it covers the database and switch steps only, not `pending.json`, the unit stop, or the lock file itself.
- **Fix before merge:** correct the wording, and add failing-first tests for the ENOENT retry and compare-before-remove. Optional hardening for later: create the lock with `link()` from a fully written temp file, and take over a stale lock by `rename()` to a unique name, then verify.

##### Minor
- **Restore accepts `secrets/` from a plain archive.** `restore.ts:280` checks only the manifest. `manifest.ts:19` claims "only in an encrypted backup"; refuse it when the input was not encrypted.
- **`--keep N` prunes every `pap-backup-*` file in the folder,** including other homes' backups in a shared `--out` folder (`create.ts:175-188`). Document it.
- **The doctor's `update_pending` fix has no `--unit`** for a non-default unit (`checks-daemon.ts:117`; compare `recoverCommand`).
- **Backup and restore take the Pi folder from the shell environment,** not from the unit's `PI_CODING_AGENT_DIR` (`backup.ts:188`, `restore.ts:92`).
- **`release.yml` restores a cache** (`setup-node` with `cache: pnpm`, through `.github/actions/setup/action.yml`) in jobs that hold `contents: write`. This is a cache-poisoning hardening point for v1.
- **The `FEED_REPO` casing check cannot run in Appendix A** (private repository: 404). Move it to ADR 0066's v1-flip list.
- **The docs' topic and rulings lists in `AGENTS.md`** do not name `backup`, `update`, `doctor` or `m6b-rulings.md` (the M6b section does).

#### Focus answers

**Data safety.**
- **Story A:** an `apply` interrupted by Ctrl-C or SSH, then `recover` much later, loses the writes made since the update (I-2).
- **Story B:** a backup that overlaps a unit start deletes the live WAL (I-1).
- **Story C:** `restore --replace` with a power cut leaves a mixed home, but the old data stays under `backups/pre-restore-*`. Recoverable.
- **Story D:** a kill at each journal step (snapshot, switch, restart, during the rollback): `recover` converges, and T6's 18-run probe matches my trace.
- Encrypted backups and the prune of snapshots and backups are sound, apart from the `--keep` note above.

**Untrusted inputs.**
- Archive: pins (a) to (e) are all met.
- Feed: sound except `notes` (I-3).
- Installer environment and `PAP_UNIT`: correct.
- Manifest `papVersion`: charset-limited.
- Doctor: every record is schema-checked, and output goes through `plain()`.

**Seams.**
- `run-cli` and the usage union: one copy of each line; the single-word dispatch (`backup`, `restore`, `doctor`) is correct.
- Docs are honest about signatures, encryption limits and the never-built image, apart from the I-1, I-2 and I-4 sentences.

**Release and supply chain.**
- `release.yml`: dispatch only, a `refs/heads/main` guard on both jobs, permissions minimal per job, actions pinned by SHA, `persist-credentials: false`.
- `get-pap.sh` checks the installer's hash before running anything.
- npm: the bundled-copy guard is in place.
- OCI image: unique build roots and `--format docker`.
- Owner actions before any publish:
  - choose a licence (the package says `UNLICENSED`);
  - reserve or confirm the `@soulkyu` scope, and check who owns `@pap` on npmjs;
  - generate `npm-shrinkwrap.json` with `inBundle` entries;
  - enable "Allow GitHub Actions to create and approve pull requests";
  - at v1, check the canonical casing of `FEED_REPO`.

**Merge readiness.**
- **Conflicts.** A trial merge-tree of main, then M12-join, models-a-back, models-picker-providers, then M6b: M6b merges cleanly, with only an auto-merged `AGENTS.md` (63 lines, under 150).
  - M12 and models A do not touch `main.ts`, `run-cli.ts`, `usage.ts` or `package.json`, and M6b does not touch `daemon.ts`.
  - `knip.json`: M6b's net change is zero.
  - Decisions log: M6b adds no row. Main already holds 94, M12 brings 93 (the order is M12's to fix at its merge). M6b's acceptance row takes the next free number at its merge.
- **What the rebase and Step 1 must re-check:**
  - add the `makeHttpsCheck(pushReadiness)` and `makePushCheck(pushReadiness)` lines between `backup` and `bwrap`, and remove `PENDING_IDS`;
  - re-run `registry.test` over all of M12's statuses;
  - re-run `listen-facts.test` against M12's `loadConfig` (`config.ts` now uses `parsePush`);
  - check the push key predicate against M12's `vapid.ts` (I checked it: 0600 file, 0700 folder, owned by the user);
  - round-trip backup and restore, and run the update downgrade preflight, with M12's migration added (35 migrations, all match the manifest pattern);
  - after a plain restore over a home that has its own `vapid.json`, confirm subscriptions are purged and devices re-enable;
  - run the full gate once more.
- **Gate at 7289d4ef** (fresh copy, `flock` on `heavy-gate-2`, 7 workers): lint, format, typecheck and knip pass. Unit: 1539 files, 18705 passed, 3 skipped. Int in the clean env with `CI=1`: 225 files, 1317 passed, 2 skipped. Build, budgets (227.4 KB gzip), smoke, smoke:install and release:check pass.
- **Appendix A, for the controller after the fixes and the rebase:**
  - the M6 checklist sections 0 to 4 first;
  - 5: a successful update, plus the worker-scope check;
  - 6: a failed update with exit 4, and the own-terminal refusal;
  - 7: encrypted backup with secrets, restore into `~/.pap-m6b-try2`, a second instance on port 7792, and the home printed as "from the unit";
  - 8: `pap doctor` on the try instance, plus the read-only `doctor --unit pap-preview.service`;
  - 9: build and run the image on port 7793 (keep-id, `bwrap`, no `.npmrc`; needs network);
  - 10: `npm pack` and an install into a temp prefix (needs network);
  - 11: cleanup;
  - suggested extra for step 5: press Ctrl-C during the verify wait, then check what `doctor` and `recover` do, with the I-2 fix in place.

  Ports 7791 to 7793 only, homes under `~/.pap-m6b-try*`, a `pap.service` free at the start, the preview left alone.

**Task quality:** Needs fixes.
**Reasoning:** The design and the three-layer archive reader hold up. Two data-safety paths (I-1, I-2) and two escaping gaps (I-3) are cheap to close, and the ADRs must stop claiming exclusion and loss bounds the code does not give (I-4).

**Merge recommendation: Ready after fixes.** Fix I-1 to I-4 (with tests, and the doc corrections), then rebase and do Step 1 with a full gate, then run Appendix A.

## M6b scoped re-review (fixes 7289d4ef..36932268): Approved, ready to merge after the rebase

All four Important findings are closed. My reproductions now give the right result, and all 11 mutants I applied to the new guards fail a named test. Six non-blocking Minors remain. The worktree is still clean at 36932268, and the scratch copy is deleted.

#### Spec Compliance
- ✅ I-1 to I-4 and the requested Minors are met.
- ⚠️ The optional journal-age question was not done. I accept that: the kept copy (I-2) already prevents the loss.

#### What I checked
| Item | Result | Evidence |
|---|---|---|
| **I-1** | ✅ | **Reproduction re-run:** a daemon commits during `pap backup`'s immutable read, then gets SIGKILL. Its `-wal` and `-shm` stay, the snapshot is redone and holds the daemon's row, and the row survives the SIGKILL. `held: true` is passed only where the instance lock is held: `apply.ts` (snapshot), `place.ts`, `keepCurrentDatabase`. `create.ts` passes none. **Mutants:** removing the `held` guard fails 2 tests; removing the redo fails 1. |
| **I-2** | ✅ | **30-day reproduction:** outcome `rolled_back`, and `backups/pre-rollback-2026-10-17T10-00-00-000Z.db` holds all 30 days of writes. **Copy cannot be made** (`backups/` set to 0500): `rollback_failed` at `database` with "snapshot failed: EACCES"; the live database keeps its 31 rows and both ids, `current` still points at `new`, `pending.json` stays, and the only systemd call is `stop`. `restore` refuses a live `pending.json` (`restore.ts:338-341`). **Mutants:** removing the keep fails 2 tests; removing the restore guard fails 1. |
| **I-3** | ✅ | `check-command.ts:84` prints `new URL(feed.notes).href`. `collect.ts:53-56` replaces control characters before clipping. **Mutants:** reverting either change fails 1 test. |
| **I-4** | ✅ | ADR 0064 (locks section), `update.md:25` and the M6bR51 wording now match the code: the instance lock covers the database and switch steps only, the loser exits 5, and `recover` converges. **Hook tests:** removing the ENOENT retry fails 1 test; removing the compare-before-remove fails 1. |
| Plain-archive secrets | ✅ | Refused (`restore.ts:323-326`). The mutant fails 1 test. |
| tar timeouts | ✅ | 1 h with SIGKILL in `create.ts` and `restore.ts`. A `timeout: 1` mutant fails 2 tests (tar really dies), so this part is now mutation-checked too. |
| Doctor `--unit` | ✅ | `checks-daemon.ts:379-380`. The mutant fails 1 test. |
| Docs | ✅, two leftovers (m1, m2) | `AGENTS.md` lists, ADR 0066 v1-flip items 3 and 4, `backup.md` (sidecars and `--keep`), `update.md` (NRestarts fail-closed, the loss bound). |
| Gates I ran | ✅ | 16 focused unit files: 237 passed. 5 integration files (update, restore, backup, cross-lane) in the clean env with `CI=1`: 21 passed. Lint, format and typecheck clean. Largest file touched: 376 lines (`restore.ts`). No AI trailers. |

#### Minor (non-blocking)
- **m1. The rollback messages hide the kept copy.** `rollback-report.ts:23` and `apply-command.ts:70` still say "writes made since X were discarded" and never name `backups/pre-rollback-<stamp>.db`, so the owner believes the writes are gone. Name the file, and say how to get them back: update again, stop pap, copy the file over `state.db`.
- **m2. Two leftover references** send the `FEED_REPO` casing check to "Appendix A": ADR 0066 line 9 and `m6b-rulings.md` line 123. It is now a v1-flip item.
- **m3. Two doc comments are displaced.** In `op-lock.ts:21-31`, `acquireOpLock`'s comment now sits above `OpLockHooks`. In `apply.ts` around line 100, `rollback()`'s "Never throws" comment sits above `keepCurrentDatabase`'s.
- **m4. The timeout tests only assert `> 0`.** Pinning `3_600_000` and `killSignal: "SIGKILL"` would make them exact.
- **m5. `update.md:25`, hand-started daemon:** `recover` also stops at `lock` while that daemon runs. Say "stop it first".
- **m6. Plan Appendix A step 7:** with `--home`, the summary prints "(from the flag)", not "(from the unit)". See step 7 below.

#### Assessment
**Task quality:** Approved.
**Reasoning:** Each fix is exactly what was asked, has a test that fails without it, and a real-code reproduction confirms the old failure is gone. The remaining items are copy and comment polish.

### Final merge recommendation: Ready
The order to merge:
1. Rebase on main after M12 and models A. Expect `AGENTS.md` to auto-merge and no other textual conflict.
2. Step 1:
   - add `makeHttpsCheck(pushReadiness)` and `makePushCheck(pushReadiness)` between `backup` and `bwrap`;
   - remove `PENDING_IDS`;
   - re-run the `registry`, `checks-push` and `listen-facts` tests against M12's `pushReadiness`, `vapid.ts` and `loadConfig`;
   - re-run the backup/restore round trip and the update preflight with M12's push migration;
   - check a plain restore over a home that has its own `vapid.json`: subscriptions purged, devices re-enable.
3. Full gate.
4. Appendix A, below.
5. Merge. Take M6b's decisions-log number at merge time, after M12's and A's rows (M12's merge fixes the existing 94-before-93 order).

m1 to m6 can go in with the rebase fix-up commit or later.

### Appendix A, exact list for the controller
Preconditions:
- owner b8;
- run it after the rebase and its gate;
- no `pap.service` installed at the start;
- ports 7791 to 7793 free;
- `pap-preview.service` active and untouched (port 7777, `~/.pap`);
- homes only under `~/.pap-m6b-try*`;
- network only for steps 9 and 10.

0–4. **M6 checklist.** Run sections 0 to 4 of `.superpowers/sdd/2026-10-15-m6-install/real-host-check.md`, unchanged. Their results replace the "Real-host check: pending" lines in `install.md`, ADR 0056 and W5-R2.

5. **Update, success.**
   - Build archive A and install it with `--port 7791 --home ~/.pap-m6b-try --bin-dir ~/.pap-m6b-try/bin`. Make a session.
   - Build archive B (a one-line change, `--allow-dirty`) and run `./pap-install-B.sh` with no flags.
   - Expect: exit 0, `current` points at B, `NRestarts` = 0, the session still listed, `backups/pre-update-*.db` present.
   - With linger on, `systemctl --user list-units 'run-*.scope'` is empty after the stop. Record anything an older pap leaves.

6. **Update, failure.**
   - Build archive C whose `dist/main.js` exits 1 at start; add a migration file. Run its installer with no flags.
   - Expect: exit 4 well before 120 s, `current` points at B, B serving, the journal naming the rollback, no `pending.json`, the pre-update database restored, and `backups/pre-rollback-*.db` holding the migrated copy.
   - Then run `pap update apply` from a shell in the try instance's own web terminal: refused with "SSH or console shell", nothing changed.

6b. **Cut update (new).**
   - Run B to C again (C without the crash, with the migration), and press Ctrl-C during the verify wait.
   - Expect `pap doctor` to show `[fail] update_pending` with `fix: pap update recover`, and `pap restore <any backup>` to be refused with "run `pap update recover` first".
   - `pap update recover` then exits 0, B is current, and `backups/pre-rollback-*.db` is present.

7. **Backup and restore.**
   - `pap backup --encrypt --secrets include --passphrase-stdin`, then stop the service.
   - `pap restore <file> --home ~/.pap-m6b-try2 --passphrase-stdin`. Start a second instance on 7792 over that home, sign in and compare sessions.
   - In a shell with `PAP_HOME` unset, `pap backup` without `--home` prints `home: ~/.pap-m6b-try (from the unit)` and does not touch `~/.pap`. With `--home` it prints "(from the flag)".

8. **Doctor.**
   - `pap doctor` on the try instance: a healthy default install exits 0 with `info` lines only. Record every non-ok line.
   - `pap doctor --unit pap-preview.service` (read-only) on the preview.
   - List the home before and after each run: no difference.

9. **Container** (network).
   - `scripts/pap-container.sh build`, then `run --port 7793 --project <scratch folder>`, then `url`. Complete setup and sign in through the published port.
   - `podman exec pap touch /work/<name>/new`: the file is owned by the host user. Check the `pap-data` volume's mapping.
   - `podman exec pap node /opt/pap/apps/daemon/dist/main.js doctor --only bwrap` gives ok. Without `--security-opt systempaths=unconfined`, an agent that requires the sandbox gets `sandbox_unavailable`.
   - `podman history --no-trunc localhost/pap:dev` and the `.npmrc` `find` show no credential.
   - Record the image size and build time, then `stop`.

10. **npm** (network). `pnpm build:npm`, `npm pack`, install the tarball into a temp prefix, `pap --help`.

11. **Cleanup.** M6 section 4, then `podman rm -f pap; podman volume rm pap-data; rm -r ~/.pap-m6b-try*`. Confirm the preview is still active.

Not in Appendix A: the `FEED_REPO` casing check. It cannot run while the repository is private and is item 3 of ADR 0066's v1 flip.

## Real-host check (Appendix A)

### M6b Appendix A results (controller, owner b8), 2026-10-17T19:05:30Z, tree a4209c54
#### 0 pre-checks: clean (no pap.service, no ~/.local/share/pap, no try homes, ports 7791-7793 free, linger yes, preview active)
#### 1 method 1 (install.sh, 7791)
- install rc=0, summary listening on http://localhost:7791
- show: ActiveState=active NoNewPrivileges=yes KillMode=mixed 
- listen: 127.0.0.1:7791 
- service url: same URL (token redacted)
- "scopes off" lines: 0
- bwrap under NoNewPrivileges scope rc=1
- modes home/state.db: 700 600 
- note: the checklist`s `systemd-run --user --scope -p NoNewPrivileges=yes` is refused by systemd 259 ("Unknown assignment" for a scope); the real proof is the daemon`s own boot log under the NNP unit (below)
- boot log under the NoNewPrivileges unit: worker_scopes enabled=true (slice app-pap-*.slice, oomPolicy true), sandbox_probe usable=true, egress_status usable=true
- uninstall rc=0? see; is-enabled after: not-found; data kept: attachments backups bin exports logs search.db secrets state.db tmp 
#### 2 taken port 7792
- run 1: rc=1, "pap did not start listening", undo commands printed, unit disabled + inactive
- run 2 at once: rc=1, same sentence (never "restart failed"), unit disabled
- undo commands run; listener (pid) killed; port free
#### 3 method 2, archive A (0.0.0-a4209c5-202610171908, 94 MB, built in 17 s)
- install --port 7791 --home ~/.pap-m6b-try: rc=0; current -> releases/0.0.0-a4209c5-202610171908; NoNewPrivileges=yes, KillMode=mixed, active; 127.0.0.1:7791 only (no pnpm .bin shim needed, W5-R10)
- setup + login over HTTP, sessions.create in a git project: ok
- rerun of the same installer without flags: rc=1 (see log), releases/ keeps the id
- **DEFECT (Appendix A, step 3 rerun):** running the SAME installer again with NO flags (`./pap-install-<A>.sh`, release = installed) took the M6 path and ran `pap service install` with defaults: the unit was rewritten to `serve` with no --port/--home (port 7777, home ~/.pap). The new unit failed ("pap is already running on /home/ubuntu/.pap"), the installer printed "service install failed (exit code 1)" and "the previous release is back in place and the service was restarted on it" — but the trap restored only `current`, not the unit file, so the restarted service looped on ~/.pap (Restart=always) until the controller stopped and disabled it. The preview's instance lock refused every attempt; ~/.pap untouched (no file newer than the incident, state.db mtime 18:34 UTC). Fix before merge (ruling M6b-C13), then re-run Appendix A from step 3.
- cleanup after run 1: pap.service removed + daemon-reload, ~/.local/share/pap and try homes removed; preview active

### Run 2 (tree 2c34cd61, after M6b-C13 fix + signal traps)
#### 3 archive A2 (0.0.0-2c34cd6-202610171931)
- install with flags: rc=0; flagless same-release rerun: rc=0, "pap-install: release 0.0.0-2c34cd6-202610171931 is already installed; restarted pap.service (the unit was not changed: pass the original flags to change it)", unit byte-identical=yes, service active on 127.0.0.1:7791
#### 6 failing update C
- first C (crash injected in main.js for every command): refused before any change by the RT-19 probe ('has no pap update apply'), rc=1, current unchanged — fail-closed; C rebuilt with the crash limited to serve
- C rebuilt (crash only under `serve` after 4 s, plus a probe migration aa_probe): flagless installer rc=4 in 19 s, "the new release stopped or restarted during the settle window"; previous release B back and running on 7791; state.db has no aa_probe; backups/pre-rollback-2026-10-17T19-37-55-312Z.db holds aa_probe (the migrated copy); pre-migrate and pre-update snapshots present; update/ empty (no pending.json)
- **COPY DEFECT:** the rollback message prints the literal `backups/pre-rollback-<stamp>.db` instead of the real file name (the m1 fix used a placeholder) → fix before merge
- own-terminal refusal (`pap update apply` from the try instance's web terminal): not run on the host (the web terminal speaks binary frames; no CLI driver); covered by T7a's guard tests (cgroup + ancestor pids)
#### 6b cut update (B → D with a probe migration, SIGINT to the installer's process group 2 s after the switch)
- installer rc=1: "pap update apply failed (exit code 130); if it was interrupted, run: pap doctor"; current left on D, update/pending.json + a stale op.lock left, service active
- `pap doctor`: `[fail] update_pending … pending.json, written …` with `fix: pap update recover`
- `pap restore` while the daemon runs: refused by the instance lock ("pap is already running … stop it first") — the pending.json-specific refusal was not exercised on the host (recover ran next); it is mutation-tested in restore's tests
- `pap update recover`: "recovered: B is current again", database restored from its snapshot, backups/pre-rollback-*.db kept (D's migrated copy), aa_probe absent from state.db, service active, update/ empty
- same **COPY DEFECT** in recover: literal `pre-rollback-<stamp>.db`
- minor: doctor's https/push fix lines repeat the whole HTTPS hint plus the doc anchor twice (noisy output); "running turns were interrupted" is printed even when no turn ran
#### 7 backup and restore
- `pap backup --encrypt --secrets include --passphrase-stdin --out <scratch 0700>`: written 54.8 MB, 0600; summary names included/not-included, scrypt + AES-256-GCM, secrets included; through the launcher the home shows "(from the environment)" (the launcher exports PAP_HOME); run without the launcher with PAP_HOME unset: "home: ~/.pap-m6b-try (from the unit)" ✓
- service stopped; `pap restore <file> --home ~/.pap-m6b-try2 --passphrase-stdin`: state.db restored (35 migrations), attachments/exports/secrets restored, pre-restore kept, "home … (from the flag)"; Pi sessions 0 added / 628 skipped (the try instance shares the real ~/.pi/agent; nothing written there)
- second instance on 7792 over try2 (transient, PAP_WORKER_SCOPE=off): login with the restored owner ✓, sessions.list = the same session as the try instance ✓; stopped by pid
- note: the try unit has no PI_CODING_AGENT_DIR, so the backup holds the owner's real Pi sessions (encrypted): both backup files were deleted right after the test
#### 8 doctor
- try instance: rc=0; all ok (node, toolchain, user_manager, linger, journal, disk, home "(from the unit)" 700, schema 35, update_pending none, backup, bwrap, python3), https/push info (localhost only), update_available skip; the try home's tree (paths + mtimes) is identical before/after
- `pap doctor --unit pap-preview.service` (read-only): rc=0; ~/.pap tree identical before/after (live db/logs excluded)
- **DEFECT (minor, fix before merge):** on the preview doctor says "http://localhost works on this machine only" although the unit runs `serve --host <LAN IP> --insecure-http`: the preview's hand-written ExecStart uses a RELATIVE main path (WorkingDirectory), the unit is not parsed, and listenFacts(null) falls back to localhost. It must say it cannot read the unit's listen flags instead (service install always writes absolute paths, so installed units are fine)
#### 9 OCI image (network, base node:24-bookworm-slim pinned by digest sha256:ec857ea6…)
- `scripts/pap-container.sh build`: rc=0 in 165 s, image 619 MB, labels revision 2c34cd617443 + base digest
- `run --port 7793 --name pap-m6b-try --project ~/.pap-m6b-ctr-proj`: healthz 200 on 127.0.0.1:7793; `url` prints the setup URL; keep-id write from uid 10001 lands as ubuntu 0644 on the host ✓
- `doctor --only bwrap` in the container: `[ok] bwrap bubblewrap works` ✓; same image WITHOUT `systempaths=unconfined`: `[warn] … sandbox probe failed` + fix names the option and apparmor_restrict_unprivileged_userns ✓ (doctor says warn; an agent that requires the sandbox then gets sandbox_unavailable, covered by T12's tests)
- `.npmrc` in the image: /opt/pap/.npmrc holds only `engine-strict`, no `_authToken` anywhere ✓
- cleanup: container stopped/removed, volume `pap-data` removed (created by this run; not checked for prior content first — process slip noted), test folder removed
#### 10 npm package (network: registry reads into a scratch cache/prefix; nothing published)
- `pnpm build:npm --out <scratch>` rc=0; `npm pack` 2.99 MB; `npm install -g --prefix <scratch> <tgz>`: **rc=1** — protobufjs postinstall "Cannot find module scripts/postinstall"
- **D1 (root cause, reproduced twice):** 117 package folders installed EMPTY (protobufjs, @anthropic-ai/sdk, @aws-sdk/*, every @earendil-works/*…). The bundled `node_modules/@pap/{contracts,pi-host}/package.json` keep their `dependencies`; npm then treats every dependency of a bundled package as part of the bundle and never fetches it. Probe: same tarball with `dependencies` deleted from the two bundled package.json → install rc=0 in 16 s, 0 empty folders, node-pty compiled (pty.node)
- **D2:** the installed `pap` crashes at start: `Cannot find module '../../package.json'` from apps/daemon/dist/kernel/version.js — apps/daemon/package.json is not in the package. Probe: copied in → `doctor --only node` ok, `serve --port 7794` healthz 200, setup 200, 35 migrations
- **D3:** `models.config.get` → helper_failed, `sessions.create` → worker_failed: `@earendil-works/pi-codemode/declarations does not provide an export named MCP_…`. Pi SDK 1.1.0 declares its siblings as `^1.1.0`; with no shrinkwrap npm takes pi-codemode/pi-telemetry 1.3.0 (latest), which breaks pi-coding-agent 1.1.0. `overrides` are ignored by a global install (probed). Probe: list every @earendil-works/* of the closure at 1.1.0 in the root `dependencies` → all eight at 1.1.0, helper op ok (revision returned), session worker starts and exits clean at shutdown
- note: every other transitive dependency still floats to the newest match (no minimumReleaseAge on this channel): the publish step's shrinkwrap must pin the lockfile's versions — not solved here
- T13's "npm pack accepts the bundled layout (measured)" measured pack only, never an install
#### 10 rerun on 702fdd71 (after fix round 3)
- build:npm rc=0; npm pack 2.99 MB; `npm install -g --prefix <scratch>` rc=0 in 18 s, 0 empty folders, node-pty compiled
- installed `pap`: `doctor --only node` ok; `serve --port 7794` healthz 200; setup + login; `models.config.get` (helper op) ok with a revision; `sessions.create` ok, the session worker starts and exits clean at shutdown ✓
- scratch prefix, package and npm cache deleted
