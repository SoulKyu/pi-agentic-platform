# M10 rebase onto M9: scoped review (Opus)

Scope: what the rebase changed. That covers the conflict resolutions (range-diff `f6c05d6` → `4af2b53`), the integration fix-up `4af2b53..bc753ac`, and the M9↔M10 seams. HEAD is `bc753ac` and main is `9a27c7b`.

Method:
- I read the brief, the report, R1–R5 (`final-review.md`), `progress.md:216` with M9's hand-offs, and the whole review diff.
- Outside the diff I checked only named risks:
  - every `diskFloor` / `guardSnapshot` call site;
  - the dispatcher's order of checks;
  - `restart-folder.ts` `releaseIdle`;
  - `lane-hooks.ts`, `service.ts`, `service-launch.ts` and `live-session.ts` against main;
  - the M10 fence files against `f6c05d6`;
  - `RunsPort.sessionCost`;
  - `triggers.ts` `folderOf`;
  - agreements 6–26 in the M9 plan;
  - the gate logs and the R2 boot log in the integrator's scratchpad;
  - the built initial chunks in `apps/web/dist`.
- A line scan of the 60 files both milestones touched found no M9 or M10 line lost. Every line missing at HEAD on either side was replaced by its union line (`palette-items.ts`, `itemTitle` callers, `STREAMS`, `TOKEN_PERMISSIONS`, the child-env and fence tests).
- I ran no tests. The status file says build=0, unit=0, int=0, smoke=0, budgets=0.

## Checklist verdicts

### 1. Disk floor (R1, M14, N7)
- **Wired through `compose-lanes.ts`: Done.**
  - `compose-lanes.ts:95-96` builds `createPathDiskGuard({ floorMb: config.minFreeDiskMb })`.
  - The same function goes to:
    - worktrees (`:135`);
    - the lanes service (`:161`): create, checkpoints, restore and compare, through `checkpointBase`, `service.ts:175,221,287`;
    - review (`:174`);
    - suggest (`:184`).
  - `daemon.ts:192` passes `...core`, which carries `config`. `localDiskFloor` is gone.
- **Refuses below the floor: Done.**
  - `kernel/disk.ts:44-63` throws `PapError("disk_low")`. `createDiskGuard` (`:67-75`) keeps the throw: `void guard(path)` evaluates it.
  - These pass a `PapError` through: `guardSnapshot` (`disk-floor.ts:11-21`), `create.ts:298-302` and `restore.ts:141-145`.
  - These catch on purpose, as M9 designed:
    - the worktree step (`worktrees/service.ts:139-144`): the lane fails with `disk`;
    - the captures (`checkpoints.ts:116-120`): the `disk_low` notice;
    - copy (`copy-link.ts:164-168`): the entry is skipped with `disk`.
  - `freeMb` (`disk.ts:15-27`) walks up to the nearest parent that exists, as `localDiskFloor` did.
  - `lanes/disk-low.int.test.ts` shows `lanes.create` answering `disk_low` end to end.
- **`disk_low` declared on every lanes method that can throw it: Not done.**
  - Declared on create, review, checkpointStatus, suggestCommit and restore (`lanes-methods.ts:159, 107, 123, 193, 250`).
  - **Missing on `lanes.compare` (`:131`)**: see I1.
- **`PAP_MIN_FREE_DISK_MB=0` also turns off the lanes floor: acceptable.**
  - One switch matches M10R101 ("`0` turns it off") and the R1 note.
  - The default of 1024 MB equals M9's old fixed 1 GiB.
  - `daemon.md:90` and `lanes.md:29` say so; `AGENTS.md:20` and `config.ts:55` do not (M3).

### 2. Idle release (R5, M3)
- **`releaseIdle` replaces M10's release: Done.**
  - Port type: `automation-port.ts:55-56` (synchronous). `:275-278` runs `ownedRow` first (a stranger gets `not_found`), then `service().releaseIdle`.
  - The Pick gained the method (`:201`).
  - M9's rule is `restart-folder.ts:45-62`:
    - a session being reopened answers `busy`;
    - a stopping one answers `cold`;
    - quiet means idle, not busy, not waiting, and no dialog, panel or queue.
- **Each call site handles `busy` and `cold` correctly: Done.** There are only two call sites (grep):
  - `runner.ts:88-101`: `busy` retries three times on the Clock; `released` and `cold` stop; a synchronous throw is caught and logged as `task_release_failed`.
  - `release-tools.ts:55-56`: `busy` answers `session_busy`; anything else goes on to `clearTaskPolicy`.
  - One semantic change: `released` now answers before the stop finishes (M10 used to await it). That is harmless at both sites. The worker is stopping, and the next prompt reopens it from the stored policy. The tests that needed the stop to finish gained `clock.advance(0)`.
- **`promptPending` includes M9's waiting set: Done.**
  - `automation-port.ts:262-270` adds `deps.laneHooks?.waiting(sessionId)`. This is the same slot that `service.ts:262` and `service-launch.ts:107` use.
  - Test: `service.lane-capture.test.ts:68`.
- **M9's must-keeps: Done.**
  - `service-launch.ts:107` (`held`) is unchanged and feeds `live-session.ts:155`.
  - `service.ts:262-264` (`beforePrompt`, `await waiting`, `session.prompt`) is unchanged.
  - `lane-hooks.ts` and `lane-port.ts` are identical to main.
  - `live-session.ts` is 396 lines, M10's `observe` being the one extra line.

### 3. Tokens: Done
- `lanes-token.int.test.ts:67`: `WALKED = ["lanes:admin", "automation:admin"]`.
- Six samples (`:87-92`) match the six `automation:admin` methods in `automation-methods.ts`: create, update, delete, setEnabled, rotateSecret and `tasks.releaseTools`.
- Exact set equality: `:108`.
- The automation samples are placeholder params. That is not vacuous:
  - `dispatcher.ts:171-173` checks the permission before decoding the params, so the answer is `forbidden`.
  - A regression that granted the permission would answer `bad_request` and still fail the test.
  - (The comment "Valid params for every walked method" no longer holds for them; a nit.)
- R3: `automation-tokens.int.test.ts:115` asserts `lanes.length > 0`. Nine `lanes:admin` methods exist, so the assert is not vacuous.
- No token reaches an `automation:admin` method:
  - `auth.ts:13-21` excludes both permissions. `4af2b53` had a comma bug there, fixed in `bc753ac` (M5).
  - The auth test derives the list.
  - The dispatcher refuses.

### 4. Hidden characters (R4): Done, see M1
- **M9 strips at ingestion:** `cleanIssueText` (`github-json.ts:74-77`) runs in `issueViewOf` (`:98-107`) and again in `issue-prompt.ts:25` for an issue a token supplied.
- **M10's I2 fence still applies:**
  - `automation/prompt.ts:13-21` strips format characters and C0/C1 for a payload (`:48`, `:62`, which covers manual and token fires) and for `{{precheck}}` (`:52`).
  - `prompt.ts`, `payload.ts`, `feed-parse.ts`, `precheck.ts` and `MessageRow.tsx` are unchanged since `f6c05d6`.
- **One `fence` and one `child-env`:**
  - One `fenceText` (`contracts/fence.ts:4`); pi-host re-exports it (`fence.ts:15`).
  - One `unattendedEnv` (`contracts/child-env.ts:89`), re-exported by `kernel/child-env.ts`, which `precheck.ts:2` imports.
  - `f6c05d6` and HEAD differ in comments only.
  - M9's tests cover every case M10's dropped tests covered: prototype, keep rules, fallback PATH, never-passed names.

### 5. Migrations: Done
- `202610142000`–`2040` (outbox, runs, automation, inbox, tool_allowlist) sort after `202610141000` and `1010`. `MIGRATION_SOURCES` is at `daemon.ts:75-85`.
- `daemon.migrations.test.ts` takes an M9 home (`sourcesBeforeM10`, `old-kernel.ts:13-26`) to M10. It applies exactly the five migrations, keeps M9's row, and a further run is a no-op.
- **The R2 boot was real.** The scratchpad `m10-rb-r2-boot.log` shows:
  - `pre_migration_snapshot` written into the scratch home, not `~/.pap`;
  - the five M10 migrations applied;
  - `listening` on 38917;
  - SIGTERM.

  The scratch home is deleted. The `/healthz` answer itself is not in the log (see Declined).

### 6. Palette: Done, not a regression
- `rank.ts:15`; `CommandPalette.tsx:23,140,149`. The order is open, Lanes, Sessions, Tasks and triggers, the hits, Settings, then Actions.
- Decision 32 and agreement 21 (M9 plan, item 18) say: "Lanes → Sessions → M10's groups → hits → Actions".
- The default highlighted row moving from "Open settings" to the first open tab or session follows directly from that ruling. Enter on an empty palette now opens a session instead of Settings. `>` still lists Actions alone.

### 7. Integrator rulings
- **Cost column: the wiring is correct; the presentation is not done.**
  - `compose-lanes.ts:162` feeds `compare.ts:88`. `RunsPort.sessionCost` (`runs/service.ts:154-158`) is null when the session had no run, else finished runs plus the live run.
  - The `fanout.int` lanes did run (summary "hi", duration set) on a provider that prices nothing. So 0 is the honest figure, "measured, zero", and null stays for a lane without a run.
  - The display side of agreement 14 is not done: see I2.
- **"No `withLaneRoots` needed": the outcome is right, the reason given is not.**
  - What actually holds is agreement 16 ("Automation never targets a lane"). `triggers.ts:175-180` refuses any folder under `$PAP_HOME`, so a lane worktree answers `invalid_cwd`.
  - No M10 check reads project roots, so `withLaneRoots` would change nothing. See M8.

### 8. Size and bundle
- **Line counts: Done.**
  - `daemon.ts`: 350 (limit 355).
  - `sessions/service.ts`: 339. `lanes/create.ts`: 391. `lanes/service.ts`: 389. `live-session.ts`: 396.
  - `build-output.int.test.ts`: 373 (limit 390), with all M9 and M10 lazy markers.
  - `AGENTS.md`: 44 lines.
- **Bundle: Done, nothing new eager.**
  - 223.4 KB equals 214.1 + 216.7 − 207.5 (the base both plans quote) within 0.1 KB. The two milestones simply add up.
  - Probing the initial chunks: the Inbox, compare, lane-screen and trigger-editor strings are absent.
  - The rrule code (`BYHOUR`, `getUTCDay`) is in `shared-*`.
- **`nextOccurrence` placement: Not done (parked again).** See M4.

### Other brief items
- `lanes.bind({ sessions, pi, policy, hub })` is at `daemon.ts:231`.
- The stop order matches agreement 24 (C3), `daemon.ts:335-340`: `m10Late.stop()` (inbox, automation, outbox), then lanes, pi, sessions in parallel, then `wk.shutdown()`.
- Unions are complete in `AppShell` (both feeds, all resets), `MobileShell`, `itemTitle(…, lanes, triggers)`, the router, subscriptions and `runtime-bed`.

## Issues

### Critical
None.

### Important

**I1. `lanes.compare` can now answer `disk_low` but does not declare it. A stale test hides this, and the UI shows a generic failure.**
- **Where:**
  - `modules/lanes/compare.ts:43` (`guardSnapshot` on each active lane);
  - `:58-59` (anything other than a `GitError` is rethrown, so the whole call fails);
  - `packages/contracts/src/lanes-methods.ts:131` (`errors: ["not_found", "capacity", "timeout"]`);
  - `compare.test.ts:163-170` still injects `PapError("capacity")`, so it passes whatever the real guard throws;
  - `web features/lanes/use-compare.ts:8-14`: `COMPARE_ERRORS` has no `disk_low`;
  - the docs that list the five methods (`lanes.md:29`, `daemon.md:90,113`).
- **Scenario:**
  1. The disk holding `$PAP_HOME` drops under the 1 GiB default.
  2. The owner opens a fan-out's Compare tab, or the Close losers dialog.
  3. The daemon answers `disk_low`, which the method does not declare.
  4. The pane says "The request failed. Try again." (`lane-compare.ts:62`), never that the disk is full.
- **History:** before the rebase, the same path answered the declared `capacity`. The brief asked to "declare `disk_low` on every lanes method that can now throw it, including the read paths". `guardSnapshot`'s own doc comment names compare.
- **Fix:**
  - add `"disk_low"` to `lanes.compare`'s `errors`;
  - make `compare.test.ts` throw `disk_low`;
  - give `COMPARE_ERRORS` a `disk_low` entry, or fall back to `errorKey(code)` as the other lane panes do;
  - add compare to the lists in `lanes.md:29` and `daemon.md:90,113`.

**I2. Agreement 14 is half-wired. The compare column shows "cost comes with M10" after M10, and a subscription's cost has no "API-equivalent" label.**
- **Where:**
  - `web features/lanes/CompareColumn.tsx:61-63` and `i18n/catalog/lane-compare.ts:23,86`;
  - the test pins the stale copy: `CompareScreen.test.tsx:98`;
  - the contract `lanes-review.ts:75-84` has no `billing`, and its comment still says "null until wired".
- **What was agreed:**
  - Agreement 14 (M9 plan, item 12): the second merger adds the `compose-lanes.ts` line *and* "the 'API-equivalent' label from `billing` in the compare column".
  - `m9-rulings.md:678`: "after M10's rebase, a subscription's figure says 'API-equivalent'".
  - `finops.md:8`: subscription cost is "labelled **API-equivalent** everywhere in the UI, never money spent".
- **Scenario 1:**
  1. A token creates a lane while the project's setup waits for approval. The lane has no session (`primarySessionId` is null).
  2. Or a lane's session failed to start.
  3. Its compare column then says "cost comes with M10" / "le coût arrive avec M10" for good, in the product that ships M10.
- **Scenario 2:**
  1. An owner on a Claude subscription (OAuth) runs a three-model fan-out.
  2. Each column shows "Cost $1.84".
  3. That reads as money spent, which is the FinOps misreading the label exists to prevent.
- **Fix:**
  - Copy: replace the pending note with "no run yet", or drop it. Update `CompareScreen.test.tsx:98`.
  - Contract: add `billing: "api" | "subscription" | "unknown" | null` to `CompareColumn`. The runs store keeps `billing` per run (`runs/store.ts:21`, M10R86). Have `sessionCost`, or a sibling, return the billing of the primary session's runs.
  - UI: render `settingsAutomation.billing.subscription` ("API-equivalent") beside the figure, as `SpendingPanel.tsx:109-123` does.
  - Fix the contract comment.

### Minor

**M1. The R4 parity test says more than it checks, and the two strip sets still differ.**
- **Where:** `issue-prompt.test.ts:43` is titled "one set at both entry points", but it only checks that M9's set includes M10's.
- **How they differ:**
  - `cleanIssueText` (`github-json.ts:74-77`) also drops the variation selectors U+E0100–E01EF and U+2028/2029.
  - The automation fence (`automation/prompt.ts:13`), `payload.ts:30` and `feed-parse.ts:33` do not.
- **Scenario:** a webhook, feed or precheck payload carrying bytes hidden in variation selectors reaches the agent. The same text in a GitHub issue is stripped.
- **Why only Minor:** tag characters, the main vector, are covered, and M10's Task 22 review accepted its set.
- **Fix:** one shared hidden-character set exported from contracts and used at all four places, with an exact parity test.

**M2. `disk-low.int.test.ts` claims more than it asserts.**
- **Where:** `disk-low.int.test.ts:38-53`. The title says "and writes no lane", but the test asserts only the answer.
- The end-to-end path is proven for `lanes.create` only. The read paths rely on unit tests that inject `disk_low` themselves. That is fine, since it is one shared guard, but the claim should match.
- **Fix:** assert that no `lanes` row exists, or that the `lane` stream is empty, after the refusal.

**M3. `AGENTS.md:20` and `config.ts:55` still describe `PAP_MIN_FREE_DISK_MB` as covering forks and task sessions only.**
- **Scenario:** an operator sets `0` to unblock a fork and unknowingly removes the lanes floor too.
- **Fix:** add "and the lane paths" to both.

**M4. `nextOccurrence` (rrule) is still in the initial `shared-*` chunk.**
- It costs about 2 KB gzip (T21 m3). The brief listed it, and it was parked again with "bundle fine".
- 223.4 KB is under the 250 KB line, and the rebase added nothing eager.
- **Fix:** an owner decision: keep it parked, explicitly, or move the editor's import so rrule stays in the lazy trigger chunk.

**M5. `4af2b53` alone does not compile.**
- **Where:** `contracts/auth.ts`. The filter ended `permission !== "lanes:admin",` followed by `permission !== "automation:admin",`. The comma ends the arrow's body, and the second argument names a `permission` that is not bound.
- `bc753ac` fixes it (`auth.ts:19`).
- **Fix:** process only. Fold `bc753ac` into the squash at merge, as planned. Never fast-forward both commits; a broken commit on main hurts bisect.

**M6. A home that ran the M10 branch alone now refuses to boot.**
- **Example:** the dev `PAP_HOME` of the `feat-m10` worktree, which `pnpm --filter @pap/daemon dev` derives from the worktree path.
- **Error:** "migration worktrees/202610141000_worktrees.sql sorts before an applied migration" (`migrate.ts:117-118`).
- The preview is unaffected (R2).
- **Fix:** none in code. Tell the owner to delete or recreate such dev homes.

**M7. The flaky shell tests are unnamed.**
- The report says "several shell web tests are timing-sensitive under parallel load (lazy chunks); they failed once".
- The owner's rule is to fix flakes, so these should be named and made deterministic (wait on the lazy panel, as `MobileShell.test.tsx` now does).

**M8. The `withLaneRoots` ruling line cites the wrong reason.**
- The rule that holds is agreement 16: `folderOf` (`triggers.ts:175-180`) refuses every folder under `$PAP_HOME`, lane worktrees included. "`scopeOf` aliases lanes" is not the reason.
- **Fix:** correct the ruling line in the report and the ledger. Optionally add one line in `lanes.md`: "a trigger cannot target a lane folder (`invalid_cwd`, agreement 16)".

## Declined to judge
- **Suite results.** The gate is reported green on `bc753ac`, and the scratchpad status file shows all five steps at 0. I did not re-run.
- **The R2 `/healthz` answer.** The saved log proves migration, listen and clean SIGTERM; the HTTP answer is the integrator's claim only.
- **Restore wait against the resume deadline.** A resume waiting on an uncapped restore can outlive `run.resume`'s 60 s deadline (`outbox/store.ts:34`). Agreement 26 covers only the 15 s capture cap. This was agreed before the rebase and is not touched by it.
- **Restore, capture and archive internals, and M10's runner and resume logic.** These are covered by each milestone's own final review. I checked only their seams.
- **Whether the shell web tests named in M7 are really flaky.** No log of the failing run exists.

## Verdict
**Ready to merge: With fixes** (I1, I2). Both are small and local to the compare seam:
- one contract line, one test and one UI map entry;
- one copy string and a `billing` field with its label.

Everything else the rebase had to keep holds:
- the disk floor refuses below the floor on every lane path;
- `releaseIdle` and M9's must-keeps;
- the token walk;
- one fence and one child environment;
- migrations and the R2 boot;
- the palette order;
- the unions.
