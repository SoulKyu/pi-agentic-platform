# M4 final review (archived 2026-10-13)

Opus whole-branch review of M4 and its re-review after the fix dispatch, copied verbatim from the git-ignored SDD workspace. Ledger: [m4-sdd-ledger.md](m4-sdd-ledger.md).

# M4 final whole-branch review (Opus)

- Branch `feat/m4-projects`, worktree `.worktrees/feat-m4`
- Range `4e85dd0..812e82a`: 69 commits, 313 files, +26 962 / −1 492
- Plan: `docs/plans/2026-10-12-m4-projects-search.md`. Ledger: `progress.md` (36 tasks, all complete).
- Date: 2026-10-12. Read-only review: no tracked file was changed. Probes ran from the scratchpad.

## How this was reviewed

The 36 tasks were already reviewed one by one, so this pass looks across them. It went in four steps:

1. **The daemon chain end to end.** CLI file → scanner → `claim` / `onAdopted` → `search.db` → `shell` publisher → hub.
2. **The browser chain.** Shell store → organise / Undo → tree, switcher and home → ⌘K hits → focus.
3. **Merge readiness.** The cross-plan agreements, plus a `git merge-tree` dry run against `feat/m5-policy`.
4. **Hygiene and docs.**

The probes were scripts in the scratchpad that imported the repo's own modules. One ran FTS5 tokenizer checks. The other timed queries against a 3 000-session corpus built with `testing/corpus.ts`.

### Gates (clean env, `.superpowers/bin` pnpm)

| Gate | Result |
|---|---|
| `pnpm lint` | ✅ |
| `pnpm format:check` | ✅ |
| `pnpm typecheck` | ✅ |
| `pnpm knip` | ✅ |
| `pnpm test:unit` | ✅ 398 files, 4 149 tests |
| `env -i HOME=$HOME PATH=$PATH CI=1 pnpm test:int` | ✅ 57 files, 304 passed. The 1 skip is the 10 000-session case, which runs only under `test:budget`. |
| `pnpm build` | ✅ |
| `pnpm budgets` | ✅ initial 192.7 KB gzip (budget 200). `ProjectTree` 11.2 KB, `CommandPalette` 7.6 KB, `register-sidebar` 2.0 KB, `TreeDrawer` 0.5 KB, all lazy. |
| `pnpm smoke` | ✅ including "a CLI session reached the sidebar; search found the smoke session" |
| `pnpm test:budget` | ✅ Search p95 100.5 ms (best of 3 passes per query; slowest "boq" 264 ms; budget 200). CLI session on the `shell` stream after 1 008 ms (budget 3 000). |

---

## Strengths

- **The adoption path is sound across tasks.**
  - `claim` is synchronous and keeps a strict order: path, Pi id, `isPiSessionFile`, live worker, pending id, then adopt.
  - The insert, the project and `onAdopted` run in one transaction (`scan-port.ts:107-113`). Nested `db.transaction` calls join the outer one (`database.ts:40-41`).
  - When `projects.ensure` publishes inside a transaction that later rolls back, nothing reaches the stream: the publisher re-reads the row in its microtask and finds nothing.
  - A fork writes its file and inserts its row in the same synchronous span, so the scanner cannot adopt it in between (`forks.ts`).
- **Owner isolation holds at every new entry point.** I checked:
  - `subscribe.shell` (key = `ctx.caller.userId`);
  - `listArchived`, `sessions.mark` (`owned`), and the pin rewrite (`AND owner_id`);
  - `projects.update` (`owned(caller.userId)`);
  - `search.query`: the SQL `owner_id` filter, then `summaryFor(sessionId, ownerId)`.
  - No new test builds a `{ userId, permissions }` literal; every new caller goes through `testCaller()`.
- **One rule set for marks.** `applyMark` / `markStateOf` in contracts are used by the daemon and by `organise.ts`.
  - Rollback works by object identity.
  - An unknown outcome (`timeout` / `connection_lost`) frees the sidebar and resyncs; it is never re-sent (R105).
  - A snapshot clears pending changes.
  - Undo waits for another pending change and gives up after a bound.
- **The browser data path is clean.**
  - `sessions-cache.ts` and its re-lists are gone.
  - Tab titles for sessions outside the shell window (archived, older) come from the eager `view-labels` store, which the lazy session store feeds.
  - The switcher, tree and home all read one `useEffectiveProject()`.
- **Search plumbing is careful.**
  - The client has per-query timers, a capacity cap, a spawn rate limit and a bounded `stop()`.
  - Damage is detected by SQLite code and triggers a bounded runtime rebuild, at most 3 an hour, with "stop wins".
  - The `CROSS JOIN` plan is pinned by an `EXPLAIN` test.
  - Snippets carry control markers and are rendered as React text.
  - Every term is quoted, and a 20 008-input fuzz found no FTS syntax leak.
- **The bundle discipline holds.**
  - 192.7 KB initial.
  - The `shared` group (`tags: ["$initial"]`) leaves cmdk, Radix menus, shiki and micromark in their lazy chunks (checked by grepping `dist/assets`).
  - Task 27 moved 93 strings to a lazy catalog.
  - `build-output.int.test.ts` pins the tree and the session strings as lazy.
- **Documentation is honest.** `docs/agents/search.md` says the p95 mix has no very common word or prefix, and that "a hit opens the session, not the older entry". `sessions.md` documents the unchecked store and the claim order.
- **Hygiene is clean.**
  - Literal bidi or zero-width characters appear only in `docs/plans/2026-10-11-m2-sessions-core.md`.
  - No source file is over 400 lines. The only longer tracked files are pre-existing spike JSON.
  - `service.ts` is at exactly 400 lines.
  - The only ESLint directives are in the plugin's own tests.
  - All 69 commits are Conventional Commits with no AI or Co-Authored-By trailer.
  - No `enum`, `namespace` or parameter properties; no debug leftovers.

---

## Issues

### Critical (must fix)

None.

### Important (should fix before merge)

#### I1. The 3-code-point prefix minimum can be bypassed, and the deadline cannot stop the resulting query

**Where**
- `apps/daemon/src/modules/search/match.ts:5` (`TOKEN` includes `\p{M}`) and `:21-27` (the prefix decision counts the code points of the whole token).
- Consequence in `query.ts:81-87`, `search-client.ts:173-181` and `search-thread.ts:234`.
- Docs: `docs/adr/0013-search-index-cache-file.md:28` and `docs/agents/search.md:25`.

**What happens**

FTS5's `unicode61` tokenizer treats a combining mark outside its diacritic table as a separator. The table covers most of U+0300–036F, so most other marks count, for example the Devanagari vowel sign U+093F or U+20D0.

`matchExpression` counts the marks toward the 3-code-point minimum, but FTS5 then splits the quoted term at them. Both `"bिि"*` and `"ििb"*` become the one-letter prefix query `"b"*`.

**Reproduced** (scratchpad probe on the real tokenizer):

- On the repo's corpus, 3 000 sessions, seed 42: `bिि` took **12 959 ms** and `ििb` 13 227 ms, against 84 ms for `boq`.
- No `QueryDeadlineError` was raised. The cost is FTS5 loading the prefix doclists before any row reaches `pap_deadline()`, which is exactly the part the Task 12a ruling called unbounded.
- At 10 000 sessions this scales to tens of seconds per query.

**Why it matters**

- The client gives up after 2 s and abandons the thread, but `terminate()` cannot interrupt SQLite. The core stays busy until the statement ends.
- The next query spawns a new thread, up to 3 a minute, so several cores can be pinned at once.
- The web sends such input: `searchText` counts 3 code points.
- Ordinary Hindi input hits it. For example `किताब` becomes the FTS tokens `क`, `त`, `ब`, so the prefix is one character.
- It breaks the premise of owner decision Q6 ("min prefix 3"), which the p95 budget rests on.
- It gets worse once M5 brings API tokens that hold `sessions:read`.

**Docs overclaim the deadline**
- ADR 0013:28 says "a query past 2 s terminates the thread".
- search.md:25 says "Deadline 2 s".
- Both should say the thread is abandoned and keeps its core until its statement ends.

**Fix**

1. Decide the prefix on what FTS5 will tokenize. Split each token at marks outside U+0300–036F (or simply at every `\p{M}` that does not follow a letter inside the same token). Quote each piece as its own required term. Add the `*` only when the last piece has 3 or more code points and nothing (not even a mark) follows it.
2. Add `match.test.ts` cases run against a real FTS5 table: `bिि`, `ििb`, `abc⃐z`, plus a `fts5vocab` or `EXPLAIN` check that no prefix shorter than 3 reaches FTS5.
3. Correct ADR 0013:28 and search.md:25.
4. Optional, and it needs a `SEARCH_SCHEMA_VERSION` bump (a cheap rebuild): `prefix='3'` on `rows_fts` would make every 3-letter prefix a single index lookup. The slowest budget queries (`boq` 264 ms) and the documented "`the` / `con`" caveat would both go away.

#### I2. The outside-write notice (owner Q13) does not show when a session is reopened within 5 minutes

**Where**
- The flag lives only in the snapshot: `apps/daemon/src/modules/sessions/service-reads.ts:224` and `apps/web/src/stores/session-reducer.ts:125`.
- The reopen path: `apps/daemon/src/modules/sessions/rpc.ts:64-67` passes the client's `after` cursor; `apps/daemon/src/kernel/ws/stream-hub.ts:66-76` (`after.seq === seq` means replay); `apps/web/src/runtime/subscriptions.ts:5` (`CURSOR_CACHE_MS` = 5 min) and `:202`.

**What happens**

1. `PaneHost` mounts only the active tab, so leaving a session unsubscribes it. The client keeps its cursor for 5 minutes.
2. A CLI write to a cold session publishes nothing on the `session` stream. The scan port only publishes `shell` events.
3. Reopening the session within those 5 minutes sends `subscribe.session {after}`. The hub replays the zero events published since, and sends no snapshot.
4. `view.outsideWrite` keeps the value of the old snapshot (`false`), and `SessionScreen.tsx:117` shows nothing.

**Why it matters**

The most common Q13 case is: open a session in pap, switch to the terminal, `pi --resume` it, come back within a few minutes. That is exactly the case that shows no notice.

The same replay also leaves the cached transcript stale: the CLI's new entries are missing, and a ⌘K hit on one of them says "not shown". That replay behaviour predates M4, but M4 makes CLI/pap interleaving a first-class flow.

No test covers a reopen. `SessionScreen.outside.test.tsx` and `service.outside.test.ts` drive snapshots only.

**Fix (smallest)**

1. Make `prepareSubscription` return the cursor to use. It returns `undefined`, which forces a fresh snapshot, when `outsideWriteAt(sessionId)` is newer than the session's last published event. Equivalently: whenever `outsideWrite(sessionId)` is true and the session is not live.
2. The handler stays "decode, call, map": `const { after: from } = await service.prepareSubscription(sessionId, ctx.caller, after); return { sub: ctx.openSubscription("session", sessionId, from) }`.

**Alternative**

Have the scan port publish a small additive `session`-stream event when it records an outside write, which also gives M13 its hook. Neither option bumps `PROTOCOL_VERSION`.

**Test**

A daemon int case:
1. Subscribe to a session, then unsubscribe.
2. `touched()` with a fresh mtime and no worker.
3. Resubscribe with the old `after`.
4. Expect a snapshot with `outsideWrite: true`.

### Minor (nice to have)

1. **A `search.db` that cannot be opened stops the whole daemon.**
   - Where: `apps/daemon/src/modules/search/index.ts:60`, `index-db.ts:281-282`.
   - What: any error that is not damage (EACCES on a copied home, ENOSPC, SQLITE_CANTOPEN) is rethrown out of `createSearchModule`, and `createDaemon` fails. For a cache that is safe to delete, this is harsh.
   - Fix: catch, log `search_index_open_failed {code}`, and return the disabled module, the same shape as read-only mode.

2. **A queued query gets a fresh thread budget, so the "thread keeps itself" design fails behind a slow query.**
   - Where: `search-thread.ts:234`, `search-client.ts:13`, `:184`.
   - What: `Date.now() + message.budgetMs` is computed when the thread dequeues the message, but the client's 2 s timer started at post time. A query queued behind a slow one gets a thread deadline later than its client deadline. The client then times out, rejects everything pending and abandons the thread. This defeats the Task 12a ruling (budget = 2 000 − 250 so a slow query keeps the thread) whenever two or more queries are in flight.
   - Fix: post an absolute `deadlineAt` computed at post time.

3. **Home "Recent" disagrees with the tree and with M4R104.**
   - Where: `apps/web/src/features/sessions/SessionListScreen.tsx:31-39`, `:116`.
   - What: Recent filters only `archivedAt === null`, so a snoozed session, which the tree hides in its Snoozed shelf, still shows on the home. Settled sessions show too. M4R104 asks for each link with its age; the row shows the status instead.
   - Fix: filter out `isSnoozed(session, now)` (and probably `settledAt !== null`), and render `formatAge`.

4. **"New session here" does not refill the folder once the person has typed in it.**
   - Where: `ProjectMenu.tsx:56-61`, `SessionListScreen.tsx:23-24`.
   - What: when the home is already mounted at `/`, the `typed` state survives `choose(project)` + `navigate("/")`, so the field keeps the typed folder.
   - Fix: reset `typed` when the effective project id changes, for example with a `key={projectId}` on the form.

5. **A test helper sits in production source.**
   - Where: `apps/web/src/features/projects/menus-kit.tsx` (imports `vitest`, mounts `Toaster`).
   - What: it is a test helper under a production name in a feature folder. The other helpers live in `apps/web/src/testing/`.
   - Fix: move it to `apps/web/src/testing/` or `features/projects/testing/`.

6. **`service.ts` has no room left for M5's agreed hunks.**
   - Where: `apps/daemon/src/modules/sessions/service.ts` (400/400).
   - What: agreement 5 leaves `policyView` and `publish` from M5 in this file, and `onAdopted` is already threaded. M5's rebase will hit `max-lines` and have to refactor M4 code in the middle of a conflict.
   - Fix: free about 15 lines now. For example, move `filed` + `fork` / `clone` into a small `service-forks.ts` wrapper, or move the `SessionsService` interface into its own file.

7. **Residuals flagged per the ledger (lines 6 and 166).**
   - Where: `marks-store.ts:180-184`, `service-adopt.ts:213-219`, `scan-port.ts:92-93`.
   - **M4R60.** A crashed draft that is prompted again overwrites its `pending_pi_session_id`. Its first file is then adopted under the instance owner.
   - **Task 14.** The scanner binds the old file in the ready window, so the new worker's file is skipped as `duplicate_id`.
   - Neither is load-bearing for single-owner v1. But M5 adds users (`pap user add`), and M4R60 then becomes a cross-user exposure: a non-owner's first message lands in the owner's sidebar and search.
   - Suggested fix before or at the M5 merge: never overwrite a non-null pending id with a different one. Keep superseded ids, for example in a small `session_pending_ids(session_id, pi_session_id)` table that `findByPendingPiId` reads, so an old file binds back to its draft.

8. **The p95 statistic is lenient.**
   - Where: `apps/daemon/src/modules/search/search.budget.int.test.ts:78-96`.
   - What: the number is the p95 of each query's best time over 3 passes. The plan's exit criterion reads "p95 of 50 queries". Single-pass p95 was 99–132 ms, still within budget, and `search.md` states the method.
   - Suggestion: print and assert the single-pass p95 too.

9. **A doc slip.**
   - Where: `docs/agents/web.md:72`.
   - What: it says "the eager `TreeDrawer`", but `TreeDrawer` is a lazy chunk (`TreeDrawer-*.js`, 0.5 KB in `pnpm budgets`). The point it makes (the chord is passed as a prop) stands.

---

## Cross-task checks that passed

### End-to-end flow, CLI → search hit (all ✅)

1. **CLI file.** `scanner-file.step` reads the header, applies the install cutoff, then calls `claim`.
2. **Adoption.** It happens atomically under `ownerId()`, with `onAdopted` called once.
   - Pap's live sessions, drafts with a pending id, and forks never reach the adopt branch.
   - Tests: `scan-port.test.ts:82,127,153,178`.
3. **Index and notifications.** The rows are committed with the claim's owner, and `touched` / `named` / `previewed` follow.
4. **Publishing.** The publisher sends `session` then `project`. The tree tolerates a session whose project is not in the store yet ("Other folders" for one frame).
5. **Search.** ⌘K hits are owner-filtered, and the stale-response guard works (the per-effect `current` flag).
6. **Opening a hit.** `choose` → `useFocusEntry.ask` → navigate → `useFocusMatch` takes the request once rows load, or shows "olderMatch" / "notShown".
   - This works when the session is already open, because the hook subscribes to the focus store.

Measured: CLI → stream in 1 008 ms; the smoke proves the built thread's `.js` entry.

### Organise (pin, snooze, settle, archive, Undo)

- **Daemon.** `sessions.mark` writes synchronously (M4R126), publishes the session and any re-ranked pins, plus `counts` and the project when archive state flips.
- **Shell store.** The optimistic change uses the same `applyMark`.
- **Tree (`tree.vm`).** Snoozed and settled sessions go to shelves; `isSnoozed` is checked against a `now` refreshed every 60 s.
- **ArchivedShelf.** It merges the pages it fetched with archived rows the store holds.
- **Palette.** It excludes archived sessions.
- **Switcher.** It lists projects with `sessions > 0` and follows `project` events.
- **Home.** The one inconsistency is snoozed sessions in Recent (Minor 3).

### Current project

- Effective id = the stored id only if the store knows it.
- It narrows the tree (pins stay visible) and the home, and prefills the folder.

### Outside-write notice

- The live, starting, ended, fork and before-start rules are correct, including mtime vs `workerEnded` ordering under coarse kernel timestamps.
- The one gap is reopening (I2).

### Daemon rules

| Rule | Status |
|---|---|
| Boundaries | lint ✅ |
| Every new method declares a permission (`sessions:read` / `sessions:operate`, no new domain) | ✅ |
| `projects.update` and `sessions.mark` are `idempotent:false`; the dispatcher requires a `commandId` | ✅ |
| Handlers only decode, call, map | ✅ (`sessions.list` only spreads `truncated`) |
| `service.ts` = 400 | ✅ |
| Migration stamps `202610121500` (holds `pending_pi_session_id`, CHECK 1..128, index) and `202610121510` | ✅ |
| `PROJECTS_MIGRATIONS` listed in `daemon.ts`; `MIGRATION_SOURCES` is M5's to export at its rebase (agreement 3) | ✅ |

### Search

- **Cooperative deadline.** Works per matched row; it does not cover the doclist load (I1).
- **Bounded `stop()`.** Client and scanner both bound it, at 2 s and 5 s.
- **No timeout is retried.** Daemon client, web RPC client and organise all comply (R105).
- **Read-only mode.** Disables `search.db`.
- **Version and damage rebuilds.** At open and at runtime, at most 3 an hour.

### Web rules

- Tokens only. The `title` props found are on `@pap/ui` `Banner` / `Dialog`, not native attributes.
- Inline-edit Escape handling stays local (`data-inline-edit` + the `Dialog` guard).
- Stale responses are dropped in transcript search (`current`), `ArchivedShelf` (`inFlight`), subscriptions (generation) and organise (commandId).
- i18n:
  - `error.limit_reached` is in the eager `catalog/shell.ts`.
  - The `search.*`, `sidebar.*` and `session.outsideWrite.*` keys are lazy and read only by lazy chunks.
  - The `session.status.*` keys are eager.

### Cross-plan agreements M4 owes

| Item | Status |
|---|---|
| `limit_reached` code with the agreed text, plus the `errors.test.ts` assertion | ✅ |
| `AuthModule.ownerId()` / `firstUserId()` (oldest user, id tiebreak) | ✅ |
| `testCaller()` in `testing/caller.ts` | ✅ |
| `onAdopted` called once per adoption, never for pap's own sessions | ✅ |
| `...shellMethods` spread | ✅ |
| `PROTOCOL_VERSION` unchanged | ✅ |
| `service-launch.ts` (`launch`, `ensureLive`, `createStoreSync`) | ✅ |
| ADR 0013 only | ✅ |
| Decisions-log rows 54–69 | ✅ |
| `AGENTS.md` at 33 lines | ✅ |

### Rebase and M5

- `merge-base(HEAD, main)` = `main` = `4e85dd0`. No rebase is needed.
- `git merge-tree` against `feat/m5-policy` (49933ff, still in progress) conflicts only in agreement 14's shared files:
  - `testing/caller.ts` (add/add)
  - `errors.ts`, `errors.test.ts`
  - `streams.ts`
  - `sessions/snapshot.ts` and its test
  - `stores/session-reducer.ts`
  - `sessions.int.test.ts`

### Deferred minors and carries (ledger)

None is load-bearing for v1 beyond the residuals in Minor 7. In particular:

- **Task 16b.** `damaged()` without a stopped check is harmless: the module's `rebuild()` returns once `stopped` is set.
- **Task 7b.** The window's `ORDER BY` is not served by an index, which costs a sort of the owner's active rows (about 10 000) per snapshot. That is fine.
- **Task 12a.** A wall-clock jump keeping the spawn window full is an edge case.
- **Task 24.** An idle project staying effective is cosmetic.

---

## Declined to judge

- **Real-browser behaviour** (Safari IME in rename, 44 px targets, drawer and sheet layouts, `datetime-local` on iOS): decision 42 / S6, the owner checks these on the preview.
- **M5's side of the merge** (`MIGRATION_SOURCES` export and int case, deleting its own `limit_reached` copy, wiring `onAdopted` → `markTainted`): those are M5's tasks. I only checked that M4's side is in place and that the conflicts are the expected ones.
- **The warning while a session is already open on screen** when another Pi process writes: by owner decision Q13 this is M13's full warning. I2 covers only the reopen path.
- **The stale transcript after a replayed reopen**: an M2 behaviour (ADR 0007). It is mentioned in I2 as a consequence, not graded on its own.
- **inotify on network mounts, the preview's real index size (M4R128), custom Pi session folders, transcript virtualisation, pre-install sessions**: all explicitly deferred by the plan.
- **Visual quality of the tree, menus and switcher**: there is no browser on this host.

## Recommendations

- `pnpm test:budget` is not part of CI or `test:int` (Task 17 ruling). Run it in the post-merge gate on `main`, and after any change to `match.ts`, `query.ts` or the index schema. The I1 fix should add one regression query of the shape `bिि` to the budget mix.
- After the merge, read `search_index_size` from the preview's boot line (M4R128) before deciding on the 1 M per-file cap.
- When M5 rebases, free the `service.ts` headroom first (Minor 6), then re-home its hunks into `service-launch.ts` as agreement 5 says.

## Assessment

**Ready to merge: With fixes.** Fix I1 and I2; the minors are optional, though 1, 2 and 7 are worth doing before M5 lands.

**Reasoning:**
- The branch is coherent across all 36 tasks. Every gate and budget is green, the adoption, ownership and optimistic paths hold end to end, and M4's side of the cross-plan agreements is complete.
- Two cross-task gaps remain, and both are small, contained fixes:
  - A one-letter FTS5 prefix the tokenizer lets through and the cooperative deadline cannot stop.
  - Cursor-replayed reopens that skip the snapshot-only outside-write flag.

---

# Scoped re-review after the fix dispatch (812e82a..0ad3613, 9 commits)

Inputs: `review-812e82a..0ad3613.diff` and `final-fix-report.md`. Every claim below was checked against the code at `0ad3613`, not taken from the report. The full gate was re-run in a clean env, and the I1 probes were re-run against the fixed `matchExpression`.

## Gates (clean env)

| Gate | Result |
|---|---|
| lint · format:check · typecheck · knip | ✅ |
| `pnpm test:unit` | ✅ 398 files, 4 157 tests |
| `env -i … CI=1 pnpm test:int` | ✅ 58 files, 306 passed, 1 skipped (the budget-only case) |
| `pnpm build` | ✅ |
| `pnpm budgets` | ✅ initial 193.1 KB gzip (budget 200; +0.4 KB from the eager `shell.age.*` keys) |
| `pnpm smoke` | ✅ including the scanner and search step |
| `pnpm test:budget` | ✅ search best-of-3 p95 97.2 ms, single-pass p95 101.9 / 97.2 / 97.8 ms, `bिि` within budget; CLI session on the stream after 1 008 ms |

Hygiene on the 9 new commits:
- Conventional subjects, no AI trailers.
- Literal bidi or zero-width characters only in the M2 plan doc. The new tests write Devanagari and Thai as escapes.
- The largest source files are 400 lines (two test files that were already at 400).

## Verdicts

### I1: the prefix minimum can be bypassed. ADDRESSED

**Code.** `match.ts:12-45` adds `splitsWords`: one lazy in-memory FTS5 table plus `fts5vocab`, asked once per distinct mark and memoised, about which marks the tokenizer splits at. `prefixPoints` then counts the letters and digits of the last FTS5 piece only. The prefix rule is applied at `match.ts:63`.

**Tests.**
- `match.test.ts:76-121`: `bिि`, `ििb`, `abc⃐z`, `किताब`, plus checks against a real FTS5 table.
- `search.budget.int.test.ts:111-114`: `bिि` must answer within the 200 ms budget.

**My probes, run on the real tokenizer, 3 000-session corpus.** "Tokens" means what FTS5 actually indexes.

| Input | Expression | Tokens | Time | Before the fix |
|---|---|---|---|---|
| `bिि` | `"bिि"` (no `*`) | `b` | 0 ms | 12 959 ms |
| `ििb` | no `*` | | 0 ms | 13 227 ms |
| `किताब` (Hindi) | exact phrase, no `*` | `क`,`त`,`ब` | | |
| `नमस्ते` (Hindi) | no `*` | | | |
| `कखग` | `*` kept | one 3-letter token | | |
| `สวัสดี` (Thai) | no `*` | `สว`,`สด` | | |
| `x` + 2 Thai marks | no `*` | | | |
| `cafe` + U+0301 (combining-mark Latin) | `"café"*` (NFKC composes it) | | 8 ms | |
| `x` + 2 × U+0331 | no `*` | | | |
| `👩\u200D💻` (emoji ZWJ) | `null` (no query sent) | | | |
| `👩\u200D💻bo` | `"bo"` (no `*`) | | | |
| `boq` | `"boq"*` | | 99 ms | |

- **Newer-Unicode letters.** I checked whether a letter JS knows but SQLite's tables might not could reopen the bypass. Kawi (U15), Toto, Vithkuqi, Latin Ext-D and Arabic Ext-B (U14) are all token characters in this SQLite: no bypass.
- **Probe cost and lifetime are bounded.**
  - It is one `:memory:` database per process (`match.ts:24-28`), created on first need and never re-created; there is no new db per keystroke.
  - Each distinct mark costs one DELETE, one INSERT and one count, about 15 µs: 2 000 distinct trailing characters took 29 ms in total.
  - The memo is keyed by mark and bounded by Unicode's mark set (about 2 500).
  - 100 000 repeated queries took 134 ms.
  - Peak RSS of the probe process was 119 MB with the corpus open.
  - It runs on the main thread, but only over the last token (≤ 64 units).
- **The abandoned-thread bound is now documented truthfully.**
  - `docs/adr/0013-search-index-cache-file.md:28-33` says the thread is "abandoned, not terminated", keeps its core until the statement ends, and that `pap_deadline()` does not cover the doclist load.
  - It names the real bounds: the tokenizer-based 3-character minimum, 4 in flight, 3 starts a minute.
  - `docs/agents/search.md:25-26` says the same.

### I2: no outside-write notice on a reopen within 5 minutes. ADDRESSED

- **Code.**
  - `service-reads.ts:181-186`: `prepare(sessionId, caller, after)` returns `undefined`, which forces a fresh snapshot, while `outsideWrite(sessionId)` is true, and `after` otherwise.
  - `rpc.ts:65-66` passes the returned cursor to `openSubscription`. The handler stays "decode, call one service method, map".
- **Tests.**
  - `sessions.outside.int.test.ts` runs a real worker: prompt, release to cold, unsubscribe, append a CLI entry, `touched`, then reopen with the old cursor. It expects a snapshot with `outsideWrite: true` and the new row.
  - `rpc.test.ts:157-162` checks both that `after` passes through unchanged and that `undefined` is honoured.
- **It cannot loop.**
  - A fresh snapshot does not trigger a new subscribe. The web subscribes only on mount, reconnect or `resync`, and the session screen resyncs only on `staleDialogs`, which a snapshot does not set.
  - While the flag is true (at most 2 minutes, `OUTSIDE_WRITE_MS`), each reopen costs one snapshot. That is the same path as an expired cursor, including for a live session.
- **Ordinary reopens still replay from the cursor.**
  - With no outside write, `after` is returned as is (pinned by `rpc.test.ts:159`).
  - The hub's `canReplay` path is unchanged.
- **Nit.** `sessions.outside.int.test.ts:31` waits on a fixed 50 ms sleep (`setTimeout`) so that `Date.now()` passes the worker's end time. That goes against the "no sleeps" rule; there is precedent in `worker.rogue.int.test.ts`. Passing `Date.now() + 1` to `touched` would do the same without the sleep.

### Minors 1–9

#### Minor 1: unopenable `search.db` stopped the daemon. ADDRESSED
- `search/index.ts:61-77` catches the error, logs `search_index_open_failed {code}`, and returns a disabled module whose `search.query` throws `internal`.
- Test: `index.test.ts:84-105`. Docs: `search.md:21`.
- Nit: the log takes `errcode` only, so a plain Node fs error would log `code: undefined`.

#### Minor 2: queued queries got a fresh thread budget. ADDRESSED
- `search-client.ts:185` posts an absolute `deadlineAt` computed at ask time, and `search-thread.ts:12,17` uses it as is.
- Both sides use the system wall clock in production.
- A unit test and an int test (a past `deadlineAt` answers `timeout`) cover it.

#### Minor 3: home Recent showed snoozed and settled sessions, and status instead of age. ADDRESSED
- `SessionListScreen.tsx:48-49` filters out settled and snoozed sessions; `:131` shows `formatAge`.
- `now` refreshes every 60 s.
- The age keys moved to the eager `catalog/shell.ts` as `shell.age.*`. The home is eager, so lazy keys would have shown raw.

#### Minor 4: "New session here" did not refill a typed folder. ADDRESSED
- `current-project.ts:33,41` adds `startHere` and a `startedHere` counter. `ProjectMenu.tsx:58` calls it, and `SessionListScreen.tsx:29-31` resets `typed` when the counter changes.
- A plain switcher change still keeps typed text.

#### Minor 5: test helper in production source. ADDRESSED
- Moved to `apps/web/src/testing/menus-kit.tsx`. The old path is gone, and knip passes.

#### Minor 6: `service.ts` had no headroom for M5. ADDRESSED
- `service.ts` is now 256 lines, with the interfaces in `service-types.ts` (150 lines).
- **The move is pure.** At commit `79a3481` the three interfaces are byte-identical to `812e82a`. The only later change is I2's `prepareSubscription` signature (`80f755d`). `service.ts` re-exports `SessionsService` and `SessionsServiceDeps`, so `service-launch.ts`, `rpc.ts` and `shell-rpc.ts` are unchanged.
- **Effect on the M5 rebase.**
  - It helps: agreement 5's `policyView`, `onAdopted` and `publish` implementations now fit in `service.ts` with room to spare.
  - It adds one re-homing rule that agreement 5 does not state: M5's additions to the `SessionsService` interface and to `SessionsServiceDeps` must go to `service-types.ts`. Git will show them as a conflict against lines M4 removed from `service.ts`.
  - **Coordination action (controller):** add one line to agreement 5 and to the plan's merge table, "M5's interface and deps hunks go to `service-types.ts`". Nothing on the M4 side needs a code change.

#### Minor 7: pending ids. ADDRESSED
- **No new stamp.** `session_pending_ids` is created inside the existing `202610121500_session_marks.sql:18-23`, with an FK `ON DELETE CASCADE` (`foreign_keys = ON` in `database.ts:20`), a CHECK of 1..128, and `PRIMARY KEY (pi_session_id, session_id)`.
- **Owner-safe.**
  - `setPendingPiId` (`marks-store.ts:183-203`) writes only for a row with `pi_path IS NULL`, in one transaction, at most 32 ids per draft.
  - The ids come from the worker, never from a client param.
  - `findByPendingPiId` (`marks-store.ts:221-226`) joins `sessions` and returns the draft's own `owner_id`.
- **An old file binds back to its draft.** In `scan-port.test.ts:189-212`, a draft owned by `u2` crashes and is prompted again (ids `pi-first` and `pi-second`, instance owner `u-instance`). The first file claims as `{session: draft, ownerId: "u2"}`, with one row and no `onAdopted`.
- **Task 14 residual.** The old-file-in-the-ready-window case is unchanged and is no wider than before. It no longer lands under the instance owner: the late file is skipped as `duplicate_id`, or binds to the draft.
- **Nits.**
  - The `count(*) … WHERE session_id = $id` cap check has no index on `session_id` (the primary key leads with `pi_session_id`), so it scans the whole table each time a draft becomes ready. The table gains at least one row per pap session ever created. Adding `CREATE INDEX session_pending_ids_session ON session_pending_ids(session_id)` in the same migration would fix it.
  - `pending_pi_session_id` and its partial index are now written but never read. Keep the column, since agreement 2 names it, but the index is dead weight.
- **Operational note.** The edited migration has a new checksum, so an M4 dev home that applied the earlier `202610121500` refuses to boot with "migration file changed after it was applied". Reset those homes. The preview and `main` never applied it, so they are unaffected.

#### Minor 8: lenient p95 statistic. ADDRESSED
- `search.budget.int.test.ts:98,110` computes the worst single-pass p95 and asserts it against 200 ms.
- Measured now: 101.9 / 97.2 / 97.8 ms. `search.md` was updated.

#### Minor 9: doc slip about `TreeDrawer`. ADDRESSED
- `docs/agents/web.md:72` now calls `TreeDrawer` "a lazy chunk of its own, 0.5 KB".

## Still open

No finding is still open. Only optional nits remain:
- the fixed 50 ms sleep in `sessions.outside.int.test.ts:31`;
- the missing `session_id` index on `session_pending_ids`, and the unread partial index;
- `search_index_open_failed` logging only `errcode`.

Plus two non-code actions:
- **Controller:** state the `service-types.ts` re-homing rule in agreement 5 and the merge table.
- **Whoever runs M4 dev homes:** reset them after the edit to `202610121500`.

## Merge readiness

**Ready to merge: Yes.**

- Both Important findings are fixed and pinned by tests that failed first: I1 drops from 13 s to 0 ms on the hostile input with a truthful deadline doc, and I2 now sends a fresh snapshot on reopen after an outside write.
- All nine minors are addressed.
- The move of the service interfaces is pure.
- Every gate is green in a clean env, including `test:budget`.
