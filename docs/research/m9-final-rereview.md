# M9 final fix round: re-review (8bfe984..6f10c96)

Reviewer: Opus, read-only. Scope: the 13 fix commits only. I checked each finding of `final-review.md` against the controller's rulings (`final-fix-daemon-brief.md`, `final-fix-web-brief.md`), then looked for new breakage in the fix diff. Code outside the diff was read only to answer a named doubt (each one is listed below). I ran no tests: the gate is running on this head. The mutation checks and gate figures in the two reports are the implementers' claims and were not re-run. No commit carries an AI attribution line. Every changed file is at 400 lines or fewer (`archive.test.ts` is at exactly 400).

## Finding Verdicts

### Important

**I1: ADDRESSED.**
- `apps/daemon/src/lane-covers.ts:10-22` adds the caller's own lane roots to `covers`. `compose-pi.ts:53-54,106` wires it for trust, skills, MCP and models. `compose-lanes.ts:195` binds it as the first line of `bind`.
- Doubt 1a, the covered set:
  - The roots are `paths.roots(ownerId)` (`modules/lanes/paths.ts:52-58,62`), built from the lane rows of that owner only. They hold `creating`, `active` and `archiving` lanes. Archived and failed lanes are not included (`store.tracked` excludes `failed`).
  - The match is lexical on a `canonical` path (`kernel/fs/boundary.ts:62-70`: no `..`, no NUL, absolute) against those exact roots.
  - Another owner's lane is never covered. Neither is `$PAP_HOME/worktrees` itself, nor a folder there that has no lane row (`lane-covers.test.ts`). One caveat on `archiving` is listed as N5.
- Doubt 1b, binding:
  - `daemon.ts:224-225` calls `lanes.bind` synchronously right after `composePi`, before the handler table and the server exist. There is no window where a request arrives unbound.
  - The default is `() => []`, which fails closed.
  - `paths.roots` is a closure-based arrow (`paths.ts:62`), so passing it unbound is safe. `useLaneRoots` is last-write-wins.
- Doubt 1c, other users of the projects port: none changed. The wrapped port goes only to the four Pi modules. `sessions` still gets `projects.port` (`daemon.ts:195`). The workspace already had `allRoots` (`daemon.ts:181`). Inside trust, `inherit` and `set` still read `roots` (project roots only, for the breadth rule), not `covers`.
- `trust.status` and `trust.set` go through `folderOf` (`trust/service.ts:87-89`). `set` keeps its step-up and `restartFolder`.
- MCP project-scope writes into a lane folder still need `confirmProtected` (`mcp/service.ts:89-92`).
- The int test (`lanes.trust.int.test.ts:1425-1468`) uses the real helper: status, set with step-up, then a reopened worker reports `trusted: true`. The other-owner case is tested at unit level only, because the harness has one owner. That is acceptable.

**I2: ADDRESSED.** `archive.ts:181-188`: the clear now runs after `releaseIn` and before `worktrees.remove`. It is still best effort and logged.
- Doubt 2a, a clear followed by a failed removal. There are two such paths:
  - a dirty refusal at the removal (`:194-197`);
  - a thrown removal, answered `capacity` (`:189-193`).

  Both revert the lane to `active` with no Pi entry. Its next worker runs without the project's resources, and the banner asks again, which works since I1.
  - `port.clear` restarts no worker (`trust/service.ts:131-144`; only `set` calls `restartFolder`), so moving it earlier cannot relaunch a worker in an archiving folder.
  - This fails closed in practice. N3 lists two refinements: the path is deterministic, not only a race, and there is an edge with an explicit `false` entry.
- Doubt 2b, boot resume: `resume` calls the same `finish` with `force: false` (`archive.ts:270-283`), so the order is identical.
  - A crash after the removal leaves nothing to clear: the clear already ran before it.
- The int test (`lanes.trust.int.test.ts:1470-1491`) reads the real `trust.json` and the `project_trust_cleared` row. The changed unit test (`archive.test.ts:737-747`) pins the new order, as the ruling intends.

**I3, ruling (a): ADDRESSED on the daemon, NOT DELIVERED in the running web app (see N1).**
- Doubt 3a: `-d` is the only form left.
  - `worktrees/service.ts:191-199` runs `["branch", "-d", branch]`, and the `force` input is gone from the port type (`:211-212` of the diff).
  - `archive.ts:202` passes no force.
  - `-D` stays in the allowlist (`allowlist-lanes.ts:60`), legitimately: `worktrees/recover.ts:73`, the creation undo, uses it.
- Tests:
  - `worktrees/service.test.ts` pins `["branch -d pap/x", "branch -d pap/x"]`;
  - `service.int.test.ts` shows a forced removal followed by an unmerged branch that is kept, answering `false`;
  - `archive.test.ts:704-717`.
- Doubt 3b, web: the dialog code stays open with `kept` and a Done button (`ArchiveDialog.tsx:57,92,131`). The unit test passes. In the real app, the lane stream removes the lane and unmounts the dialog first. See N1.
- Doubt 3c, honest test edits: yes.
  - The two `ArchiveDialog` tests switched from `branchDeleted: false` to `null`. Both send `deleteBranch: false`, and the daemon answers `null` in that case (`archive.ts:201-203`). Under the new behaviour `false` keeps the dialog open, so the old values were no longer meaningful.
  - Dropping the `force deletes it` assertion from the int test follows the removed behaviour.

**I4: ADDRESSED.** `lane-new.ts:53,126` and `lanes.md:124` now say the following, all checked against the code:
- runs as you, no sandbox until M11;
- keys are readable, `HOME` is kept (`contracts/src/child-env.ts:7`), and the agent socket is reachable by path (`XDG_*` is kept);
- a fan-out test runs once after each lane's first run. This matches `auto-test.ts:26-35`: primary session, browser-made, not from an issue, not tainted.

No other copy repeats the old claim; I searched the web catalog and the docs.

The test pins the new sentence. Two wording nits are in N6.

### Minor

| # | Verdict | Where / note |
|---|---|---|
| M1 | ADDRESSED | `allowlist-lanes.ts` loses `clean`, and `clean -f -d -- .` moves to REFUSED (`allowlist-lanes.test.ts:425-426`). The `lanes.md:56` row is now `reset` only. The lanes-vectors int test drops its `clean` call. |
| M2 | ADDRESSED (per ruling) | `checkpoints.ts:134`: an existing `root` ref is never replaced. Test at `checkpoints.test.ts:904-911`. Trade-off in N9. |
| M3 | ADDRESSED | See doubt 4 below. |
| M4 | ADDRESSED (docs) | `lanes.md:137`: restore runs `reset --quiet -- .` and unstages the lane's index. |
| M5 | ADDRESSED, with a contract nit | `guardSnapshot` (`disk-floor.ts:39-49`) runs before every snapshot: `review.ts:104,110`, `restore.ts:108` (not for a memoised snapshot), `suggest.ts:62`, `compare.ts:41-43`. See doubt 5 and N2. |
| M6 | ADDRESSED | `ScriptTrust.tsx:25-40,60,67,72` shows "N lines · M characters", EN and FR, with the singular. Collapsing whitespace and a diff were out of scope by ruling. |
| M7 | ADDRESSED (docs) | `lanes.md:190` now points to New lane (⌘⇧L). The lane tab has no approval box, which matches the code. |
| M8 | PARTIAL (optional item) | "Created by a token" next to Run setup on the desktop header only (`LaneHeader.tsx:138-139`). The phone menu has no provenance. The foreign-branch hint is not done: `LaneView` has no lineage. Acceptable for an optional item. |
| M9 | ADDRESSED | `PrPanel.tsx:24,142-144` uses `pushModel(lane).target`, the same escaped `host/path` as the commit bar (`commit-bar.vm.ts:62-76`). A null target keeps the plain label. |
| M11 | ADDRESSED | `AppShell.tsx:79` resets `items` (the store's only state, `composer-prefill.ts:7-13`). Test in `AppShell.signout.test.tsx`. |
| M12 | NOT ADDRESSED in the running app | See N1. |
| M13 | ADDRESSED | `archive.ts:213-220` writes `lane_archived_forced` (force only). `close-losers.ts:55-66` writes `lane_losers_closed`. `pr.ts:159-166` writes `lane_pr_created`, with no title or body and nothing for a reused PR. The shape follows `lane_pushed` (`push.ts:79-85`), and the actor comes from `actorOf`. Tests pin the rows, including the int row over /ws. |
| M14 | ADDRESSED, with a hand-off nit | Every seam is `(path: string) => undefined`: `compose-lanes.ts:80`, `lanes/service.ts:63`, `create.ts:62`, `checkpoints.ts:43`, `worktrees/service.ts:34`. `localDiskFloor` returns `undefined`. Three `@ts-expect-error` sites in `compose-lanes.test.ts:145-162`. See doubt 6 and N7. |

### The seven doubts, answered

1. **I1:** see I1. Only the caller's own lane roots are added. The binding is synchronous at boot and fails closed before it. Nothing else changed.
2. **I2:** a clear followed by a failed removal leaves an active lane without its entry. That fails closed (refinements in N3). The resume order is identical.
3. **I3:** `-d` holds under Force, and the test edits are honest. The dialog stays open only in the unit bed (N1).
4. **M3:**
   - What the fix does:
     - `service-launch.ts:104` feeds `held` from `laneHooks.waiting(row.id)`.
     - `live-session.ts:155` counts it as busy.
     - `idle-release.ts:39-48` re-arms on `busy`, so a waiting prompt is never released.
   - The seam stays inside sessions: the `waiting` map lives in `sessions/lane-hooks.ts:74,119-137`, and lanes still only supplies `beforePrompt`. No new import crosses modules.
   - **M10 must keep:**
     - (a) `LiveSessionDeps.held`, wired in `service-launch.ts`;
     - (b) `state()` consulting it;
     - (c) `beforePrompt` doing `waiting.set` synchronously before it returns the promise, and deleting it in `finally`;
     - (d) `service.ts:254-256`: `await waiting` followed directly by `session.prompt`, with no I/O await between them;
     - (e) `lane-port.ts:108-116` `busy()` reading `waiting`.

     `live-session.ts` is at 395 lines, so the rebase has 5 lines of headroom.
5. **M5:**
   - `read_only` is now thrown by `lanes.review`, `lanes.checkpointStatus` and `lanes.suggestCommit`. None of the three declares it: `contracts/src/lanes-methods.ts:107,123,193` list `not_found`, `capacity`, `timeout` (plus `worker_failed`). The dispatcher passes any `PapError` through (`kernel/ws/dispatcher.ts:102`), so it works on the wire, but the contract is now inaccurate (N2).
   - `compare` returning null counts is safe. The contract already allows null, and archived lanes already produce it.
6. **M14:**
   - M10's object-returning `diskFloor(path, floorMb)` (`feat-m10/.../kernel/disk.ts:30-38`) cannot be wired directly: its second required parameter already prevented that. A wrapper `(p) => diskFloor(p, n)`, which compiled silently against `=> void`, now fails, which is the point of M14.
   - M10's own `createDiskGuard` returns `() => void` (`disk.ts:41-46`). It fails against `=> undefined` too, so the hand-off line, as written, will not compile (N7).
7. **I4:** the copy is accurate on every point the review raised: `HOME` kept, keys readable, agent reachable by path, the fan-out auto-test. One nit is in N6.

## New Breakage in the Fix Diff

**N1, Important (low harm): the "Branch kept" notice never survives in the real app. M12 and the web half of I3 are not delivered, and `lanes.md:176` describes a message the owner never sees.**
- The daemon sets the lane `archived` and calls `publishState` (`archive.ts:211-212`) before it returns `{ ok: true, branchDeleted }` (`:221`).
- The lane stream flushes in a microtask (`modules/lanes/stream.ts:38,103`), and the hub sends at once (`kernel/ws/stream-hub.ts:117-120,182-184`). The archived event therefore leaves on the socket before the RPC answer.
- On the client, the reducer deletes an archived lane (`stores/lane-reducer.ts:47-53`). `LaneScreen` then renders the "archived" empty state instead of `LaneBody` (`LaneScreen.tsx:22-27`), and that unmounts `ArchiveDialog`, the only mount (`LaneBody.tsx:237`).
- `setKept(true)` (`ArchiveDialog.tsx:57`) then lands on an unmounted component. Even if the answer came first, the archived event would unmount the notice right after.
- The unit test (`ArchiveDialog.test.tsx:851-861`) passes only because its bed sends no lane-stream event.
- Harm is low: the branch is kept and nothing is lost. But the ruled behaviour ("tell the owner, do not close silently"), its test and the doc are all false in the app.
- **Fix:**
  - Keep the outcome outside `LaneBody`, for example a shell-level notice, or a per-lane "last archive outcome" in the lane ship store that `LaneScreen`'s archived empty state reads.
  - Add a test that emits `{ kind: "lane", lane: { …, state: "archived" } }` before the answer resolves.

**N2, Minor: `read_only` on three read methods is undeclared, and a read-only daemon now produces client failures.**
- Where: `lanes-methods.ts:107,123,193`, `disk-floor.ts:43`.
- The brief said "skip the snapshot" when the daemon is read-only. The code refuses instead.
- Read-only means the database is newer than the binary (`daemon.ts:120-130`), a degraded mode. In that mode:
  - the Review pane's branch scope fails;
  - the checkpoint banner reports `command_failed` at every leaf change or focus (`checkpoint.vm.ts:66-71`);
  - Suggest fails.
- Fix: declare `read_only` on the three methods, or answer them without a snapshot. For example, `checkpointStatus` could return `differs: false`.

**N3, Minor: the I2 trade-off is not only a race.**
- The early dirty check (`archive.ts:116-119`) runs before the archive script. An approved archive script that writes into the worktree (a log, a build output) therefore makes the removal answer `dirty` (`:194-197`) every time, after the clear. Fails closed; the banner asks again.
- Narrow edge: if the lane holds an explicit `false` and an ancestor of `$PAP_HOME/worktrees/<id>` is trusted in Pi's store, removing the `false` widens trust. That is MC47's own reasoning. pap's UI cannot trust such an ancestor (`covers` refuses `$PAP_HOME/worktrees`, `lane-covers.test.ts:561`), so this needs Pi's CLI or a project root that contains `$PAP_HOME`.
- Option: clear before the removal only when the entry is `true`, and clear a `false` after the removal succeeds. Otherwise, document it in `lanes.md`.

**N4, Minor: "the branch goes only when all its commits are merged" is imprecise.**
- Where: `lanes.ts` `deleteBranch.note` and `branchKept`, EN and FR; `lanes.md:176`.
- A lane push sets an upstream (`--set-upstream`, `lanes.md:59,82`). With an upstream, `git branch -d` checks the upstream, not HEAD. A pushed but unmerged branch is therefore deleted locally; its commits stay in `origin/<branch>` and on the remote.
- No data is lost. Say "merged or pushed".

**N5, Minor: `covers` includes `archiving` lanes (`paths.ts:56-58`).**
- A `trust.set` on the lane folder after the archive's clear and before the removal writes a new entry, which then outlives the folder. That is I2's leak, through a race that needs a step-up and a click during the archive.
- Option: leave `archiving` lanes out of the Pi modules' roots, or accept and note it.

**N6, Minor (copy).**
- "pap only leaves your SSH agent and tokens out of its environment" (`lane-new.ts:53,126`, `lanes.md:124`) understates the allowlist. `lanes.md:122` two lines above lists `GIT_*`, `LD_*` and provider families, and tool variables never pass. The error is in the conservative direction, but the doc contradicts itself. Suggested wording: "pap keeps your SSH agent and tokens, among others, out of its environment".
- `lanes.md:175` says "The approval box says so" (about the base's package scripts). The box no longer says it; the hint is the New lane dialog's `laneNew.from.foreign` (`lane-new.ts:30`).

**N7, Minor (hand-off): M10's `createDiskGuard` returns `() => void` (`feat-m10/apps/daemon/src/kernel/disk.ts:46`).**
- `(path: string) => undefined` refuses it, so "wire `createDiskGuard({ path: <PAP_HOME>/worktrees, … })`" will not compile as written. The failure is closed, which is good.
- The hand-off should say: type the guard `() => undefined`, or wrap it as `(path) => { guard(); return undefined; }`.
- Also note that its `disk_low` code passes through `guardSnapshot` (`disk-floor.ts:43-48`) and is not declared on the read methods either.

**N8, Minor (test claim): the title "counts the quiet time from the end of the wait" overclaims (`live-session.idle.test.ts:2372-2380`).**
- `idle-release.ts:39-48` measures quiet time from the last `touch`. When `held` clears without a touch, the next check releases at once.
- No impact in the real flow: the prompt follows the wait in the same microtask chain (`service.ts:254-256`) and touches the worker.

**N9, Minor (ruling trade-off, M2).**
- A second default-model session starts with no leaf, so its first turn's `from` and its "restore to before the first message" point to the lane's `root`, which is session 1's start.
- Its turn-1 review therefore shows session 1's changes, and that restore also rolls back session 1. Undo recovers.
- A per-session root key would be exact. This is acceptable as ruled; consider noting it in `lanes.md`.

## Parking M10: acceptable

- `lanes.prCreate` is `lanes:admin`, so only a browser click by the owner can publish (`lanes-methods.ts:276`).
- The panel says the lane's description is used when the body is empty (`laneCommit.pr.bodyHint`), and the owner can type a body.
- For a browser-made lane, the owner wrote that description.
- The real gap is a token-made lane, whose description the owner may never have read. Closing it properly needs an additive `LaneView.description` field (clipped, then `escapeHidden`), so it belongs with the next contract change (M10 or M11).
- Cheap interim, with no contract change: `LaneView.createdBy` is already on the client. For `createdBy === "token"`, change the hint to say that the description came from a token and is not shown here, or ask for a body before Create.

## Out-of-Scope Observations

- Bundle: initial 214.1 KB against 213.8 KB (+0.3 KB, about 0.14 %), within noise. The likely source is `AppShell.tsx` now importing `composer-prefill.ts`.
- Little headroom is left for M10's rebase:
  - `archive.test.ts` 400 lines;
  - `lanes/create.ts` 391;
  - `lanes/service.ts` 390;
  - `sessions/live-session.ts` 395.
- `project_trust_cleared` from `port.clear` always records `actor: "user"` (`trust/service.ts:139`), even when the archive came from closing losers. This predates the fix.
- `trust.status` and `trust.set` follow links (the helper's `realFolder`), as they already do for project roots (M7R103). A link inside a lane is judged by where it leads, exactly as inside a project. Nothing new.
- Multi-owner: a project root of one owner that contains `$PAP_HOME` would cover another owner's lanes through `projects.covers`. This predates the fix; today there is a single owner.

## Verdict

**Ready to merge: With fixes.**
- I1, I2, I3 (daemon) and I4 hold. The new trust seam is tight, bound before the server listens, and fails closed.
- One item must land first: N1 (Important, low harm). The kept-branch notice that I3 and M12 depend on is unmounted by the lane stream in the real app, and both its test and `lanes.md:176` claim otherwise.
- N2 to N9 are Minor. N2 (declare `read_only`) and N7 (the hand-off line) are cheap to fold into the same round.
