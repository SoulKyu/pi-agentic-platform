# M4 SDD ledger (archived 2026-10-13)

Controller ledger of the M4 subagent-driven run, copied verbatim from the git-ignored SDD workspace before its worktree was removed. Rulings: [m4-rulings.md](m4-rulings.md); final review: [m4-final-review.md](m4-final-review.md).

# SDD ledger — plan: docs/plans/2026-10-12-m4-projects-search.md
Worktree /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m4 (feat/m4-projects). Plan @ 2edce8f (red-team M4 applied: 1 C / 15 I / 28 m; owner decisions 2026-10-12 X1, X2, M4-Q1–Q15, E1; 17 cross-plan agreements, #4 amended M5R129). Specs: docs/specs/2026-10-10-C-architecture.md, 2026-10-10-D-clean-start.md — binding.
Models (owner X2): Haiku implementers 1, 27; Sonnet the other 34; Opus reviewers 8b, 12a, 14, 15, 16b, 19; Sonnet reviewers others; Opus final. E1: Opus implementer allowed at fix rounds 4–5 (log each use). Dispatch order 1 → 27, then 29, then 28.
Pre-flight scan: the plan's "Pre-execution conflict scan" (l.150–188) is the pair table, re-checked by the Opus red-team (§2 plan-internal, §3 overlap) and fixed in 2edce8f; per-task self-consistency was the red-team's item 4 and the fixer's self-check (prescribed pure code run in Node 24.14.1). Controller adds no row. Rulings: 143 in rulings.md (M4R1–M4R143).
Ruling: pre-flight relies on the red-team's plan-internal pass instead of a fresh controller read of 8 100 lines — the plan is fresh from an Opus fix with a self-check — if wrong, a conflict surfaces in a task review and costs one fix round.
Ruling: RT-01 residual accepted as written in M4R60 (a draft that crashed after Pi wrote its file and is prompted again before the scanner's first pass has its first file adopted under the instance owner) — narrow window, single-owner v1 — if wrong, a second user's crashed draft lands in the owner's sidebar; flag it to the final review.
Ruling: RT-07/08/26/04 applied in the fixer's variants (oldest dialog always admitted; runtime corruption detection, ≤ 3 rebuilds/h; no folder-mtime skip, per-pass comparison cap; scanner off in read-only mode) — each keeps the finding's intent with less breakage — if wrong, one fix round in tasks 2 / 16b / 15–16 / 16b.
Parallel: M5 runs in .worktrees/feat-m5 (one implementer per worktree). Merge order M4 first (X1).
M4 Task 1: dispatched implementer (haiku, agent a9e5ab0622538701f), BASE 2edce8f
M4 Task 1: implementer DONE_WITH_CONCERNS (fd7f4c5) — literal invisible chars converted to escapes; pre-existing literal RLO in export-http.test.ts (main) left; 2 test files keep a local sizeOf; MAX_ID_CHARS now from kernel/text.ts
Controller: pre-existing literal U+202E in apps/daemon/src/modules/sessions/export-http.test.ts (from M2, on main) — CARRY to Task 28 (gates): replace with an escape; the final review checks no literal bidi/zero-width remains repo-wide
M4 Task 1: review (Sonnet) Needs fixes — 1 I (plan-mandated: 2 test-local sizeOf copies fail the brief's Step 4 grep)
Task 1: Ruling: the brief's acceptance grep is binding; the edit list missed dialogs.test.ts and snapshot.test.ts — fix them (import sizeOf from kernel/json-bytes.ts) — cost if wrong: none, two test imports
Task 1: minor (folded into round 1): U+FFFD literal → escape in text.ts/text.test.ts; test pinning M4R3 (fractional tokensBefore → compact_answer_unreadable)
Task 1: minor (deferred): import order in service-commands.ts:2 and live-session.ts (cosmetic, lint passes)
Task 1: fix round 1 dispatched (resumed haiku implementer), FIX_BASE fd7f4c5
M4 Task 1: fix round 1 implementer DONE (7cd42ab) — sizeOf imported, � escapes, M4R3 test (service.commands.test.ts exactly 400 lines); re-review dispatched (sonnet)
Task 1: fix round 1/5 (3 addressed, 0 open; commits fd7f4c5..7cd42ab)
Task 1: complete (commits 2edce8f..7cd42ab, review clean after 1 fix round)
Task 1: NOTE for later tasks: MAX_ID_CHARS lives in kernel/text.ts (no longer exported by snapshot.ts)
M4 Task 2: dispatched implementer (sonnet, agent a8d37ccef2acf05cd), BASE 7cd42ab
M4 Task 2: implementer DONE_WITH_CONCERNS (8c04bcb) — existing "counts the dialogs that did not fit" case (d1 600k, d2 600k, d3 100 B) changed to expect ["d1"], hidden 2
Task 2: Ruling: accept the changed expectation — the brief's l.108 misdescribes the existing case (it has a third 100-byte dialog); M4R8 ("non-approval dialogs together within 256 KiB"), the prescribed loop (oldest counted in otherDialogs) and the new "three 100k keep two" test all count the oldest, so d3 is hidden behind a 600k oldest and waits its turn (RT-07 intent) — cost if wrong: a small extension dialog behind a huge one shows only after the huge one is answered
M4 Task 2: review (Sonnet) approved — spec ✅, 0 C / 0 I
Task 2: minor (deferred): budget→room switch for decorations/panels/partial has no test or mutation check
Task 2: minor (deferred): placeholderRow cuts role with slice(0,64) (can split a pair; plain() then falls back to "unknown") instead of the kernel cutUnits
Task 2: complete (commits 7cd42ab..8c04bcb, review clean)
M4 Task 3: dispatched implementer (sonnet), BASE 8c04bcb
M4 Task 3: implementer DONE (57bcb6d) — mutation checks reasoned not run; session-reducer.snapshot.test.ts existed (appended); SessionRules keeps unused sessionId per brief; bundle 194.7 → 194.7
M4 Task 3: review (Sonnet) approved — spec ✅, 0 C / 0 I
Task 3: minor (deferred): mutation checks reasoned, not run; SessionRules' unused sessionId prop (key only) deserves a comment
Task 3: complete (commits 8c04bcb..57bcb6d, review clean)
M4 Task 4: dispatched implementer (sonnet), BASE 57bcb6d
M4 Task 4: implementer DONE (1a93754) — local write() helper in memo test; pi-file-writers under modules/sessions/testing
M4 Task 4: review (Sonnet) approved — spec ✅, 0 C / 0 I
Task 4: minor (deferred): bounded-index slot not counted in remember()'s 64 MiB weight (consistent with the uncounted index); no test for a bound returning after replacement
Task 4: complete (commits 57bcb6d..1a93754, review clean)
M4 Task 5: dispatched implementer (sonnet), BASE 1a93754 (agreements 4/9/10 restated in dispatch)
M4 Task 5: implementer DONE (45b2651) — bundle 194.7 → 195.1; test:int not run (contracts + web catalog)
M4 Task 5: review (Sonnet) approved — spec ✅, 0 C / 0 I; trailers checked by controller (0)
Task 5: minor (deferred): snooze lower bound accepted case missing (< vs <= survives); restore archived/settled + pins:null, snooze clears settledAuto, pin before=self untested; Id/Millis defined twice (marks.ts, shell.ts, plan-mandated)
Task 5: CARRY to Task 8b: STREAMS now includes "shell" — check a subscribe to "shell" before its provider is registered settles cleanly (stream-hub providers Map)
Task 5: complete (commits 1a93754..45b2651, review clean)
M4 Task 6: dispatched implementer (sonnet), BASE 45b2651
M4 Task 6: implementer DONE (83c4b8a) — bundle 195.1 → 195.1; 1 mutation check (MIN_GAP)
M4 Task 6: review (Sonnet) Needs fixes — 1 I: no owner-isolation test on ProjectsPort.list (mutation survives)
Task 6: minor (folded into round 1): move before=self / unknown id pinned; projects_full re-log after 60 s
Task 6: minor (deferred): int test's empty rename hits zod min(1), not cleanLabel-after-clean over the wire
Task 6: CARRY to 7c: projects.ensure writes on demand — in read-only db mode (newer pap) it throws; 7c's caller must not let that break session creation/reads; projects.update surfaces a raw SQLite error in read-only mode (map it); ensure stores root verbatim — pass the policy.scopeOf result (normalised)
Task 6: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 83c4b8a
Task 6: fix round 1/5 (3 addressed, 0 open; commits 83c4b8a..c8854e5)
Task 6: complete (commits 45b2651..c8854e5, review clean after 1 fix round)
M4 Task 7a: dispatched implementer (sonnet), BASE c8854e5
M4 Task 7a: implementer DONE (029a764) — pure move, service.ts 376 → 269, service-launch.ts 130; brief line numbers off (moved real block 149–254 with comments)
M4 Task 7a: review (Sonnet) approved — faithful move; trailers checked by controller (0)
Task 7a: complete (commits c8854e5..029a764, review clean)
M4 Task 7b: dispatched implementer (sonnet), BASE 029a764
M4 Task 7b: implementer DONE (26da493) — brief test bug fixed (129-char pending id checked on a fresh unbound row); session_name migration test expects the new migration too; withoutProject / findByPendingPiId owner-agnostic per brief
Task 7b: CARRY to 7c, 8b, 14: store's withoutProject and findByPendingPiId do not filter by owner — callers must carry/verify the owner (adoption keeps the draft's owner)
M4 Task 7b: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 7b: minor (deferred): no read-only store test; no 51-pin rollback test; no cross-owner test for write's pin scoping; no migration test with pre-existing rows; window's ORDER BY not served by sessions_owner_active (keep LIMIT; split if profiling shows it)
Task 7b: CARRY to 28 (docs): docs/agents/sessions.md — new columns, pending_pi_session_id semantics, store not owner-checked
Task 7b: complete (commits 029a764..26da493, review clean)
M4 Task 7c: dispatched implementer (sonnet), BASE 26da493; carries from 6 and 7b in dispatch
M4 Task 7c: implementer DONE (d921c46) — files outside brief for carried items (projects read-only mapping, sessions rpc/int tests, int-bed); assign/copy catch setProject failure (log session_project_failed) instead of throwing; service.ts 306; projects.update read-only test written after code (mutation-covered)
M4 Task 7c: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 7c: minor (deferred): assign/copy catch and index.ts boot backfill catch untested; onDraftReady logs session_pending_id_not_stored on every reopen in read-only mode (skip when readOnly); import order nits
Task 7c: complete (commits 26da493..d921c46, review clean)
M4 Task 8a: dispatched implementer (sonnet), BASE d921c46
Owner (2026-10-12, workflow lightening): (1) a fix round whose diff is test-only or comment-only and < ~50 lines is re-verified by the controller (runs the named covering test, checks the reported mutation) instead of a re-review agent — logic fixes keep a scoped re-review; (2) implementers run test:int only when the task touches the runtime; effort levels unchanged (owner declined).
Owner (2026-10-12): Task 27 implementer → Sonnet (was Haiku; Haiku T1 cost ≈320k tokens vs ≈75k for a comparable Sonnet task)
M4 Task 8a: implementer DONE_WITH_CONCERNS (4e5d1b3) — extra test for the projects' budget share (mutation survived the brief's tests); brief test typecheck defect fixed (setup returns Found | null); knip not run (2 files unused until 8b); fitShellSnapshot does not cap sessions at 550 (relies on 8b)
M4 Task 8a: review (Sonnet) Needs fixes — 1 I (plan-mandated): fitShellSnapshot does not cap sessions at 550
Task 8a: Ruling: the cap belongs in the fitter (bounded-resource rule; contract schema rejects > 550) — cost if wrong: none, one guard
Task 8a: minor (folded into round 1): misleading "10 000 sessions" test title; budget test derives expectations from output
Task 8a: minor (deferred): publisher comment says "one turn of the loop" (microtask); projectChanged(owner, null) silent return uncommented
Task 8a: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 4e5d1b3
M4 Task 8a: fix round 1 implementer DONE (d36c607) — 550 cap + schema-parse test, minors; NOTE implementer ran git checkout -- . to undo a mutation (reverted its own fix, reapplied)
Task 8a: fix round 1/5 (2 addressed, 0 open; commits 4e5d1b3..d36c607)
Task 8a: complete (commits d921c46..d36c607, review clean after 1 fix round)
M4 Task 8b: dispatched implementer (sonnet), BASE d36c607; carries from 5 (subscribe before provider) and 7b (owner filter) in dispatch
M4 Task 8b: implementer DONE_WITH_CONCERNS (12f7e3c) — list() kept as array, new listFitted(caller) for sessions.list; create publishes 2 project events; 'provider answers for any owner key' test in index.test.ts; subscribe before provider throws cleanly (stream-hub test); service.ts 356; bundle 195.1 → 195.2
M4 Task 8b: review (Opus) Needs fixes — 0 C / 1 I (plan-mandated wiring): reopened sessions stay "starting" on the shell stream (flush runs before live.set; nothing publishes when reopening clears) — probe reproduced on navigate / compact / failed prompt. Owner isolation confirmed sound (key bound by the handler from ctx.caller; contract has no key).
Task 8b: Ruling: accept list()/listFitted() deviation (wire result equivalent) with a doc comment that list is unbounded and internal — cost if wrong: a future handler calls list unfitted (comment + review catch it)
Task 8b: minor (folded into round 1): projects.onChange wiring test; exact create event sequence; onPublished doc comment; test comment
Task 8b: minor (deferred): fork/clone publishing and the truncated:true mapping untested; needsInput initial false not observed; int test not shown RED
Task 8b: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 12f7e3c
M4 Task 8b: fix round 1 implementer DONE (66e59ab) — onReopened hook after reopening.delete; name event via onPublished (untested); onChange wiring test; exact create sequence
Task 8b: fix round 1/5 (2 addressed, 0 open; commits 12f7e3c..66e59ab)
Task 8b: minor (deferred): name-event routing through onPublished has no dedicated test
Task 8b: complete (commits d36c607..66e59ab, review clean after 1 fix round)
M4 Task 9: dispatched implementer (sonnet), BASE 66e59ab
M4 Task 9: implementer DONE_WITH_CONCERNS (a01a490) — rank-event test fixed after a surviving mutation; read_only mapping around store.write (beyond brief, tested); onSnoozeChange no-op until 10; rpc.test.ts keeps a literal caller (pre-existing); bundle 195.2 → 195.3
M4 Task 9: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 9: minor (deferred): read_only catch duplicates dispatcher mapping (kept, consistent with projects.update); filler assertion service.marks.test.ts:220; rank test via fromEntries hides duplicates; snooze wiring in service.ts untested until 10; no hostile cross-owner pin.before / restore.pinBefore test
Task 9: complete (commits 66e59ab..a01a490, review clean)
M4 Task 10: dispatched implementer (sonnet), BASE a01a490
M4 Task 10: implementer DONE_WITH_CONCERNS (b96e310) — sweep re-arms at 0 ms only if the full batch settled something (prescribed code would loop on 500 live candidates; tested); activity clears settled/snooze but does not set unsettledAt (brief's code) → a run-only un-settle may re-settle at next sweep; service.ts 394/400
M4 Task 10: review (Sonnet) Needs fixes — 1 I (plan-mandated): activity / snooze wake do not stamp unsettledAt → a session resumed without a prompt is re-settled by the next hourly sweep
Task 10: Ruling: stamp unsettledAt on activity and wake — M4R41/M4R64 beat the brief's organiser code — cost if wrong: none
Task 10: spin fix (re-arm at 0 ms only when the full batch settled something) approved by the reviewer
Task 10: minor (folded into round 1): idempotent start(); sessions_activity_failed test; import order; service.ts kept ≤ 396
Task 10: minor (deferred): double publish on run start (coalesced, harmless)
Task 10: CARRY to 14: the scanner's activity must refresh updated_at or rely on the unsettledAt stamp; service.ts headroom is ~6 lines — Task 14 moves code out first if needed
Task 10: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE b96e310
M4 Task 10: fix round 1 implementer DONE (7a79750) — unsettledAt on activity/wake, idempotent start, activity_failed test
Task 10: fix round 1/5 (2 I/minors addressed, 0 open; commits b96e310..7a79750)
Task 10: complete (commits a01a490..7a79750, review clean after 1 fix round)
M4 Task 11: dispatched implementer (sonnet), BASE 7a79750
M4 Task 11: implementer DONE (f16a690) — brief test defect fixed (9-word input ending on a word); session/owner guard in commit redundant with NOT NULL; ADR 0013 names later pieces
M4 Task 11: review (Sonnet) approved — 0 C / 0 I; injection fuzz by reviewer (20 008 inputs) found no throw / no syntax leak
Task 11: CARRY to 12b: commit() does not run indexText on row.text — the caller sanitises (or commit does) with a test; in commit, spread ...row before sessionId/ownerId so extra keys cannot override them
Task 11: minor (deferred): ADR 0013 names later pieces (true after 12a–16b); redundant owner guard; openSearchIndex rethrow path does not close db / double close is logged; rows keep old owner if files.owner_id changes (12a)
Task 11: follow-up (resumed implementer, test-only, controller-verified): literal U+0301 in match.test.ts → escape
Task 11: follow-up 945c106 verified by controller (no literal marks left; match.test.ts green)
Task 11: complete (commits 7a79750..945c106, review clean)
M4 Task 12a: dispatched implementer (sonnet), BASE 945c106
M4 Task 12a: implementer DONE_WITH_CONCERNS (b4b11a6) — prescribed client fixes (idle timer cleared on death/drop, armIdle after failed postMessage, throwing spawn logged without using a slot); local createLogger in tests; int test covers the .ts entry only (built .js in Task 28 smoke); knip deferred to 12b
M4 Task 12a: review (Opus) Needs fixes — 0 C / 1 I (plan-mandated): worker.terminate() does not interrupt a running SQLite statement (probe: exit 32 s after terminate) → timed-out queries keep a core; stop() unbounded
Task 12a: Ruling: cooperative deadline via a db.function check in RANK's WHERE (aborts the statement; FTS5's first match-list load stays unbounded, noted) + stop() bounded by a Clock deadline with a log — M4R50's "cost if wrong: none" was wrong — cost if wrong: a very slow FTS5 match-list load still holds a core until it ends (bounded by the spawn cap)
Task 12a: minor (folded into round 1): SNIPPETS owner filter; ranking order test; throwing-spawn test + rate limit; failed-post armIdle test; null-guarded error listener; comments
Task 12a: minor (deferred): global MAX_IN_FLIGHT (per M4R51); wall-clock jump keeps spawn window full; test:int run on search folder only
Task 12a: CARRY to 12b: PapError("timeout") fixed text may name the session process — check the wording for search
Task 12a: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE b4b11a6
M4 Task 12a: fix round 1 implementer DONE_WITH_CONCERNS (2576881) — pap_deadline abort (tested with injected past deadline only), bounded stop(), snippets owner filter (redundant), ranking test strengthened
M4 Task 12a: fix round 1 re-review dispatched (resumed Opus reviewer, with a real long-statement probe)
Task 12a: fix round 1/5 (I1 + minors addressed — cooperative deadline confirmed on real long statements by the Opus probe; commits b4b11a6..2576881)
Task 12a: Opus re-review found a plan-mandated Important in M4R54's RANK SQL: owner-index-first join → quadratic cost (common term, 20k rows 9.3 s; budget 200 ms impossible)
Task 12a: Ruling: RANK uses FROM rows_fts CROSS JOIN rows r (FTS outer loop; measured 20k 24 ms, 1M 1.3 s) with an EXPLAIN QUERY PLAN test; thread budget = QUERY_TIMEOUT_MS − 250 so the thread's own timeout keeps the thread — cost if wrong: none (verified by probe)
Task 12a: minor (deferred): !entry branch untested; wall-clock jump in the spawn window; GROUP BY/ORDER BY after the CTE not covered by the deadline (bounded)
Task 12a: fix round 2 dispatched (resumed sonnet implementer), FIX_BASE 2576881
M4 Task 12a: fix round 2 implementer DONE (403423d) — CROSS JOIN + EXPLAIN plan test (mutation fails), THREAD_BUDGET_MS = 1750; full test:unit green
Task 12a: fix round 2/5 (2 addressed, 0 open; commits 2576881..403423d)
Task 12a: minor (deferred): stale "thread may be stuck" comment search-client.ts:190
Task 12a: CARRY to 12b: knip must be green (RANK exported for the plan test); PapError("timeout") wording for search; commit() call site sanitises with indexText (from 11)
Task 12a: complete (commits 945c106..403423d, Opus review clean after 2 fix rounds)
M4 Task 12b: dispatched implementer (sonnet), BASE 403423d; carries from 11 and 12a in dispatch
M4 Task 12b: implementer DONE_WITH_CONCERNS (c74ae82) — timeout wording left (fixed per code, R66); commit() sanitises with indexText and names params (no spread); bundle 195.3 → 195.4; smoke ok
Task 12b: Ruling: keep the shared "timeout" message (one fixed text per code, R66); the ⌘K search UI maps timeout / capacity to its own copy by code — cost if wrong: one i18n line in Task 25
Task 12b: CARRY to 25: ⌘K search maps timeout and capacity by code to search-specific copy (en + fr)
M4 Task 12b: review (Sonnet) Needs fixes — 1 I: search module opens / may rebuild search.db at boot ignoring read-only mode
Task 12b: Ruling: read-only covers search.db — no open/rebuild when readOnly, one log line, search.query answers { hits: [] } — cost if wrong: search unavailable on an older daemon over a newer home (expected)
Task 12b: minor (folded into round 1): indexBytes inside the try + count-failure test; stop() closes db in finally; owner-drop / null-match / >limit mutation checks; size comment
Task 12b: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE c74ae82
M4 Task 12b: fix round 1 implementer DONE_WITH_CONCERNS (c6688b9) — read-only disables search.db (log + empty hits), size read contained, stop() finally, hit cap at limit; owner-drop guard redundant with safeParse (mutation survives); daemon.ts readOnly pass-through untested (no newer-home harness)
Task 12b: fix round 1/5 (I + minors addressed; owner-drop mutation equivalent to safeParse; commits c74ae82..c6688b9)
Task 12b: minor (deferred): no int test for the daemon.ts readOnly pass-through (needs a newer-home harness); stop()'s finally untested
Task 12b: CARRY to 15/16b: the scanner's index writes need their own read-only gate (scanner off in read-only mode per plan fix)
Task 12b: complete (commits 403423d..c6688b9, review clean after 1 fix round)
M4 Task 13: dispatched implementer (sonnet), BASE c6688b9
M4 Task 13: implementer DONE (98cdfd6) — readLines' two bounds redundant (each alone survives, both removed fails cap test); HEAD_CHARS test for knip; extract.test imports sessions' test fixture builder
M4 Task 13: review (Sonnet) Needs fixes — 1 I (plan-mandated): extract throws on a null content block (untrusted Pi file)
Task 13: Ruling: guard non-object blocks (M4R59: Pi files untrusted, nothing throws out) — cost if wrong: none
Task 13: minor (folded into round 1): readLines clamp pinned with a non-aligned budget; multi-byte boundary / empty / header-only tests; duplicate import; readAt doc comment
Task 13: minor (deferred): HEAD_CHARS tautology test (remove when Task 15 consumes it); bad-line double decode; zero-length Buffer.alloc
Task 13: CARRY to 15: wrap readHeaderLine/readLines/extract per file (I/O errors such as EIO/EISDIR propagate); reset the cursor when from > size (truncated/rewritten); clip firstUser/name to HEAD_CHARS; O_NOFOLLOW covers only the last path component (symlinked parent dirs followed)
Task 13: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 98cdfd6
M4 Task 13: fix round 1 implementer DONE (65f191a) — null-block guard + tests; readLines clamp / multibyte / empty tests
Task 13: fix round 1/5 (6 addressed, 0 open; commits 98cdfd6..65f191a)
Task 13: complete (commits c6688b9..65f191a, review clean after 1 fix round)
M4 Task 14: dispatched implementer (sonnet), BASE 65f191a; agreements 6/8 + RT-01 + service.ts headroom in dispatch
M4 Task 14: implementer DONE (9811c21) — service.ts exactly 400 (onDraftReady → service-adopt.ts, summaries → service-reads.ts); step 4 redundant when pending id stored (test amended so the mutation fails); claim can throw on a unique path conflict (scanner must wrap)
M4 Task 14: review (Opus) Needs fixes — 0 C / 1 I (plan-mandated): onAdopted not atomic with the insert (a throwing hook leaves an adopted row never announced/tainted). Identity, ownership across restart, copies and double claims confirmed correct.
Task 14: Ruling: fix now with one transaction (insert + project + onAdopted) and a throwing-hook test, rather than leaving it to the M5 merge — cost if wrong: none
Task 14: Ruling: claim answers wait (rate-limited session_claim_failed) for failures before the insert — total contract; post-insert failures roll back via the transaction — cost if wrong: a stuck file retried each pass (logged)
Task 14: residual (ledger, beside M4R60): a crashed draft re-prompted while the scanner binds its old file in the ready window → the new worker's file is skipped as duplicate_id (turns orphaned from pap's view, no cross-user leak); possible fix: launch re-reads a draft row after ready
Task 14: CARRY to 15/17: the worker-reported Pi path spelling must equal the scanner's walked path (else pap's own files are skipped as duplicate_id) — pin with a real worker; Task 15 wraps every port call (touched, named, previewed) under RT-04
Task 14: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 9811c21
M4 Task 14: fix round 1 implementer DONE (f1cbf7a) — atomic adoption (SessionsStore.transaction), claim wait on pre-insert failure, touched guard pinned, oldest-user order pinned; smoke ok
M4 Task 14: fix round 1 re-review dispatched (sonnet)
Task 14: fix round 1/5 (Important addressed; minors addressed except the catch also covers the rolled-back transaction; commits 9811c21..f1cbf7a)
Task 14: Ruling: accept the catch around the transaction — a post-insert failure is rolled back first, so answering wait (rate-limited session_claim_failed) and retrying next pass is safe; the original concern was a committed row, which the transaction removes — cost if wrong: a persistent hook failure shows as one log line a minute instead of a thrown error
Task 14: complete (commits 65f191a..f1cbf7a, Opus review + 1 fix round)
M4 Task 15: dispatched implementer (sonnet), BASE f1cbf7a; carries from 12b, 13, 14 in dispatch
M4 Task 15: implementer DONE_WITH_CONCERNS (4c37160) — path used as given (normalisation → 16a); no own read-only check (module returns early); symlinked parent → claim skip not_pi_file → bad; failed named/previewed/touched logged not retried; prescribed-code defects fixed (RT-04 containment, per-call wraps, HEAD_CHARS clip, unchanged-file shortcut, fd leak)
M4 Task 15: review dispatched (Opus)
M4 Task 15: review (Opus) Needs fixes — 0 C / 2 I (plan-mandated): head slice splits a surrogate pair → false rewrite every change; re-read content counted as activity (un-settles/wakes on search.db rebuild, forget, rewrite, first boot)
Task 15: Ruling: activity only for incremental reads from a stored, non-reset cursor (M4R41 "new entries") — changes the brief's test 1 — cost if wrong: a CLI append right after a rebuild does not wake its session until the next append
Task 15: Ruling: forget cursor/rows only on ENOENT/ELOOP/ENOTDIR/not_file (keep on transient EACCES/EMFILE/EIO); ELOOP/not_file/not_pi_file stay silent (prescribed) — cost if wrong: stale rows of a file made unreadable stay searchable until it reappears
Task 15: minor (folded into round 1): cap stops rows + said once; ≥64 KiB headerless file → bad; inode + excluded guards pinned; exact count; doc comment
Task 15: minor (deferred): no explicit rows-per-pass cap (bytes only; 16a latency budget measures it); port calls after commit not retried (preview may come from a later chunk; documented)
Task 15: CARRY to 16a: one canonical path spelling shared with the worker-reported pi_path + an int test that a pap-launched session is indexed under that session; the engine is built after search/index.ts's read-only return; ctx.say must not throw
Task 15: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 4c37160
M4 Task 15: fix round 1 implementer DONE (992b6d0) — cutUnits head, activity only on incremental reads, forget on definitive refusals only, cap/headerless/inode/excluded guards; 8 mutation checks; guard tests in scanner-file-guards.test.ts + testing/scanner-bed.ts
M4 Task 15: fix round 1 re-review dispatched (resumed Opus reviewer)
Task 15: fix round 1/5 (I1, M3–M7, M10 resolved; I2 open for multi-step reads; commits 4c37160..992b6d0)
Task 15: CARRY to 17/28 docs: lowering the per-file cap keeps indexed rows; raising it resumes after a gap
Task 15: fix round 2 dispatched (resumed sonnet implementer), FIX_BASE 992b6d0
M4 Task 15: fix round 2 implementer DONE (24d7327) — active only when stat.size > known.size; indexedChars = max+1 once a row is dropped
Task 15: fix round 2/5 (2 addressed, 0 open; commits 992b6d0..24d7327)
Task 15: complete (commits f1cbf7a..24d7327, Opus-reviewed, 2 fix rounds)
M4 Task 16a: dispatched implementer (sonnet), BASE 24d7327; carries from 14/15 (path spelling, read-only, say never throws) in dispatch
M4 Task 16a: implementer DONE_WITH_CONCERNS (a4ea313) — engine not wired (16b); brief cases 7/8 adapted (pump starts synchronously); say/callbacks contained, codes sanitised; path = configured agent-dir spelling (resolve only, no realpath); int test: symlinked agent dir session indexed under its own session; spellAgentDir option in int-bed
Task 16a: CARRY to 16b: build the engine after search/index.ts's read-only return; pass root = join(config.piAgentDir, "sessions"), never a realpath
M4 Task 16a: review dispatched (sonnet)
M4 Task 16a: review (Sonnet) Needs fixes — 1 I: watcher on a deleted/recreated folder never evicted (stale, counts toward 512, recreated folder unwatched)
Task 16a: minor (folded into round 1): file changing during processing test; resolve at debounce/enqueue; guarded pump catch + restart; sentinel wait in watch.test; root re-check; tell logs
Task 16a: CARRY to 16b: requestReconcile must coalesce (engine calls it on every event past the debounce cap and every nameless event); reconcile re-adds watchers after an error
Task 16a: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE a4ea313
M4 Task 16a: fix round 1 implementer DONE (d928208) — evict vanished watchers (incl. root, fallback to parent), unwatch(dir), gap re-check, resolve paths, guarded pump + restart, re-queue-during-processing test, sentinel watch test; folder tests in scanner-engine-folders.test.ts
Task 16a: fix round 1/5 (I + 6 minors addressed; commits a4ea313..d928208)
Task 16a: minor (deferred): root events naming an existing folder (IN_ATTRIB) re-create its watcher (churn, events in the gap → reconcile); isFolder false on EACCES may evict a live watcher; root + parent gone → reconcile only; tell catch untested
Task 16a: complete (commits 24d7327..d928208, review clean after 1 fix round)
M4 Task 16b: dispatched implementer (sonnet), BASE d928208; carries from 15/16a in dispatch
M4 Task 16b: implementer DONE_WITH_CONCERNS (2a7cb2d) — read-only kept as 12b (no search.db, empty hits) vs brief's "populated index answers"; case 9 wording (round robin wraps); generation guard untested (mutation survives); case 10 spy cannot fail; extras: unwatch on vanished folders, stop() ≤ 5 s + session_scanner_stop_slow, say/onDamaged wrapped
Task 16b: Ruling: keep the 12b read-only behaviour (search.db not opened, search answers no hits, scanner off) over the brief's "populated index still answers" — an older daemon on a newer home is a rollback edge case and opening a newer search.db risks a version-mismatch rebuild — cost if wrong: no search while running an older daemon on a newer home
M4 Task 16b: review dispatched (Opus)
M4 Task 16b: review (Opus) Needs fixes — 0 C / 2 I (tests that cannot fail: lost re-arm; 5 s stop bound + stopped() checks). Code correct under all probed interleavings (stop during pass/rebuild/pump, query during rebuild, damage during rebuild, 4th rebuild → search_index_unusable).
Task 16b: minor (folded into round 1): gone pass when sessions/ is gone; closed flag (no restart after stop / during rebuild); rebuildNow checks stopped; generation guard; non-ENOENT listing failure kept present; wrapped rebuild logger; readOnly required; case 9 third pass, hour pruning, rebuild-failed tests
Task 16b: minor (deferred): codeOf defined three times; compare keeps whole cursors (512-char head) per pass; round robin drifts when the list changes
Task 16b: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 2a7cb2d
M4 Task 16b: fix round 1 implementer DONE (1498a5c) — re-arm and stop-bound tests that fail, stopped() returns pinned, closed flag, rebuildNow stops, gone pass w/o sessions/, unlistable folders kept, guard removed, minors
M4 Task 16b: fix round 1 re-review dispatched (sonnet)
Task 16b: fix round 1/5 (2 I + 7 minors addressed; commits 2a7cb2d..1498a5c)
Task 16b: minor (deferred): runReconcile's catch calls damaged() without a stopped check (a late step after the 5 s bound could trigger a spurious rebuild); stopped() checks at scanner-reconcile :56, :65, :81 untested; !rebuilding guard redundant with closed
Task 16b: complete (commits d928208..1498a5c, Opus review + 1 fix round)
M4 Task 17: dispatched implementer (sonnet), BASE 1498a5c
M4 Task 17: implementer DONE_WITH_CONCERNS (0e67150) — CLI visible 1009 ms (≤3000); search p95 99–132 ms (≤200), p50 ~8 ms; 10k sessions / 1.19 M rows / 404 MB index (2.73 B/char) → 1 M cap not needed; 3-letter prefixes 270–440 ms alone; test:int +80 s and ~400 MB temp disk
M4 Task 17: review dispatched (sonnet)
M4 Task 17: review (Sonnet) approved — budgets met (CLI 1009 ms; p95 99–132 ms); p95 rests on the 3rd-slowest prefix query (1.5–2× margin)
Task 17: Ruling: the 10 000-session measurement moves to a dedicated `pnpm test:budget` (run at Task 28, final gates); default test:int keeps a ~300-session plumbing case — saves ~80 s and ~400 MB per later test:int and removes contention risk — cost if wrong: a budget regression is caught at Task 28 instead of per task
Task 17: Ruling: the "1 M per-file cap not lowered" decision waits for the preview's search_index_size boot line (M4R128), not this synthetic corpus
Task 17: follow-up round 1 dispatched (resumed sonnet implementer), FIX_BASE 0e67150
Task 17: follow-up round 1 (0f5c562) verified by controller (test/script/docs only: diff stat, test:budget script present; implementer gates green; test:budget p95 97.1 ms, CLI 1008 ms; test:int now ~50 s)
Task 17: CARRY to 28 / final gates: run `pnpm test:budget` (10 000-session search p95 + CLI latency)
Task 17: complete (commits 1498a5c..0f5c562, review clean + 1 follow-up round)
M4 Task 18: dispatched implementer (sonnet), BASE 0f5c562
M4 Task 18: implementer DONE (7bf7603) — bundle 195.4 → 195.5; testing.ts subscriptionBed answers subscribe.*; extra resync test; runtime-bed test
M4 Task 18: review dispatched (sonnet)
M4 Task 18: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 18: minor (deferred): no test that one stream's expiry leaves the other stream's same key alone; fakeRuntime.emit "s1" fallback (prefer emitTo); docs/agents/web.md resync line (→ 28)
Task 18: complete (commits 0f5c562..7bf7603, review clean)
M4 Task 19: dispatched implementer (sonnet), BASE 7bf7603 (store + organise; Opus reviewer)
M4 Task 19: implementer DONE_WITH_CONCERNS (f3b059c) — bundle 195.5 → 195.5 (store not imported yet; re-measure at 20); toBe identity → stored object; prescribed-code fixes (whenIdle TDZ, unreachable unpinned block removed, optional timers in OrganiseDeps)
Task 19: CARRY to 20: re-measure the bundle once the store is wired (eager)
M4 Task 19: review dispatched (Opus)
M4 Task 19: review (Opus) approved — 0 C / 0 I; interleavings probed (ok / refusal / offline / unknown vs events, snapshot mid-flight, Undo behind pending, reset during wait); applyMark shared with the daemon confirmed
Task 19: follow-up (resumed implementer): store's session as base for optimistic writes; discriminating empty-first test; local Timers type; no-deadline comment; non-RpcError and busy-sent-nothing tests
Task 19: CARRY to 23: whitespace-only rename refused locally (trim) before sending; Undo of an evicted archived session (store full, 550) answers not_found — consider sending restore without the optimistic display
Task 19: follow-up 9a6427f verified by controller (one-line base change + comment + local type + tests; diff read)
Task 19: complete (commits 7bf7603..9a6427f, Opus review clean + follow-up)
M4 Task 20: dispatched implementer (sonnet), BASE 9a6427f
M4 Task 20: implementer DONE_WITH_CONCERNS (3a814b5) — bundle 195.5 → 199.5 KB gzip (+4.0 vs +1.9 planned; above the 197 trigger, 0.5 under the 200 cap); eslint web-routes allow list gains web-stores; use-view-labels.ts instead of whole session views; tests seed the store directly; Retry also resyncs on an unreadable snapshot; SessionTree still shows archived sessions (brief)
Task 20: Ruling: bundle above 197 → Task 27 (strings lever) runs next, before 21 (M4R plan rule / owner Q10); the reviewer explains the +4 KB — cost if wrong: none (order change only)
M4 Task 20: review dispatched (sonnet, with bundle analysis)
M4 Task 20: review (Sonnet, with per-module bundle attribution) Needs fixes — I1: use-view-labels.ts imports useSessionStore → the session reducer chain (~3.1 KB gzip) went eager (zod schemas were NOT the cause); I2: SessionListScreen says "No session yet." while the stream is loading/failed
Task 20: Ruling: trim 1 — a tiny eager view-labels store fed by the lazy session store (target ≈ 196.4 KB) — before Task 27 — cost if wrong: none
Task 20: Ruling: accept the eslint web-routes → web-stores allow-list line (web-stores is a leaf; the brief needs routes/shell to read useShellStore) — note for the M5 merge (plan listed eslint.config.js as "none")
Task 20: CARRY to 22b/24: SessionTree and PaletteHost still include archived sessions (palette's 50 slots); TabBar running-dot test seeds the store directly
Task 20: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 3a814b5
M4 Task 20: fix round 1 implementer DONE (ec66c0b) — view-labels-store (eager, tiny), bundle 199.5 → 196.7; SessionListScreen loading / failed / empty states; labels never removed (session store has no unload)
M4 Task 20: fix round 1 re-review dispatched (resumed sonnet reviewer)
Task 20: fix round 1/5 (I1, I2, M3 addressed; bundle 196.7 KB gzip, session reducer chain out of the initial set — confirmed per module; commits 3a814b5..ec66c0b)
Task 20: Ruling: bundle back under 197 → keep the plan order (Task 21 next, Task 27 in its place) — revises the earlier "27 next" ruling — cost if wrong: none
Task 20: CARRY to 21: AppShell cleanup also resets the view-labels store on sign-out (useViewLabels.setState({ labels: {} }))
Task 20: complete (commits 9a6427f..ec66c0b, review clean after 1 fix round)
M4 Task 21: dispatched implementer (sonnet), BASE ec66c0b; labels-store sign-out reset carried
M4 Task 21: implementer DONE (6613f8c) — bundle 196.7 → 196.9; home uses sessionLabel too (link text folder name); tree filter matches name+cwd not preview; Tooltip pointerenter test note
M4 Task 21: review dispatched (sonnet)
M4 Task 21: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 21: follow-up (resumed implementer): tree filter matches preview; vacuous Tooltip pointerenter test fixed; scrollIntoView stub restored
Task 21: minor (deferred): tab button remounts when its title crosses 24 chars (focus edge case); home hides the path line when name === cwd
Task 21: follow-up bd1119b verified by controller (generic groupSessions + preview in the haystack, test fixes; routes/shell + Tooltip tests 153/153 green)
Task 21: complete (commits ec66c0b..bd1119b, review clean + follow-up)
M4 Task 22a: dispatched implementer (sonnet), BASE bd1119b
M4 Task 22a: implementer DONE (e543a47) — brief defect fixed (unknown projectId made a 2nd null group → duplicate key); id tiebreaks; pinned uncapped per brief; nothing eager imports tree.vm
M4 Task 22a: review dispatched (sonnet)
M4 Task 22a: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 22a: minor (deferred): shown not clamped (22b store may Math.max); localeCompare depends on runtime locale (id tiebreak keeps it total)
Task 22a: complete (commits bd1119b..e543a47, review clean)
M4 Task 22b: dispatched implementer (sonnet), BASE e543a47; carries (archived out of tree/palette slots, clamp shown) in dispatch
M4 Task 22b: implementer DONE_WITH_CONCERNS (ec857c1) — bundle 196.9 → 194.3 (tree lazy, 6.2 KB chunk); chord prop via usePaletteChord (boundaries); 3 shell.tree keys stay eager for SessionListScreen; lazy-catalog test allows all features/projects; shelf titles are trigger buttons; archived shelf cap slice untested (pages of 100 land on 500); archived out of palette slots + clampShown done
M4 Task 22b: review dispatched (sonnet)
M4 Task 22b: review (Sonnet) approved — 0 C / 0 I; tree lazy (194.3 KB initial); trailers checked (0)
Task 22b: Ruling: lazy projects features take the palette chord as a prop (usePaletteChord in routes/shell/shortcut.ts) — boundaries forbid features/projects → features/commands; Task 25 follows the same pattern — cost if wrong: one prop
Task 22b: follow-up (resumed implementer): archived cap-slice test, inFlight / asked guard tests, labelled shelf sections + keyboard toggle test, narrower lazy-catalog allowlist, filtered-archive note
Task 22b: CARRY to 23: Archive action — the open Archived shelf does not gain newly archived rows (title count may exceed rows); a page of only duplicates leaves the cursor unchanged
Task 22b: follow-up 8817e92 verified by controller (tests + section labels + note string + narrower allowlist; implementer gates green, bundle unchanged 194.3, 3 real mutation checks)
Task 22b: complete (commits e543a47..8817e92, review clean + follow-up)
M4 Task 23: dispatched implementer (sonnet), BASE 8817e92; carries from 19/22b in dispatch
M4 Task 23: implementer DONE_WITH_CONCERNS (b80cab4) — bundle 194.3 → 197.1 (> 197; implementer attributes it to Rolldown hoisting IconButton/Toast/marks shared with the lazy tree into eager chunks); menus tests split; menu-focus.ts; drawers selector narrowed; partial RED; New session here → 24; focus/phone sheet/datetime-local checked in happy-dom only
Task 23: Ruling: bundle above 197 → Task 27 runs right after Task 23 (before 24) — plan rule — cost if wrong: none
M4 Task 23: review dispatched (sonnet, with bundle analysis)
M4 Task 23: review (Sonnet) Needs fixes — I1 Escape in rename field inside the drawer likely closes the Radix dialog; I2 bundle +2.8 KB = Rolldown chunk-split glue, same 246 eager modules (head 197.5 → 193.4 with a $initial codeSplitting group, measured); minors
Task 23: Ruling: fix the bundle with a Rolldown codeSplitting group tagged $initial (node_modules|packages/) in Task 23's fix round, own build(web) commit; Task 27 goes back to plan order (after 26b) once the bundle is under 197 — supersedes "27 right after 23" — why: no new eager module, glue only; one config line recovers 4.1 KB — cost if wrong: one config line to revert, budgets catch any regression
minor (deferred): a project whose sessions are all pinned/snoozed/settled has no heading, so it cannot be renamed; Move down is relative to visible order (Task 20 design) — note in Task 26 docs
Task 23: fix round 1 dispatched (resumed implementer): Escape guard + real TreeDrawer test, codeSplitting group, SavingStatus, snooze min/max, aria-labelledby while renaming, untested branches — FIX_BASE b80cab4
M4 Task 23: fix round 1 implementer DONE (c6a3757, 4ef18ed) — Escape guard in Dialog + real TreeDrawer test (RED seen), codeSplitting group (bundle 194.3 → 193.4), minors + menu tests; concern: Unarchive on a shelf row the store does not hold shows no optimistic change
M4 Task 23: fix round 1 re-review dispatched (sonnet)
Task 23: fix round 1/5 (I1 Escape guard + real-drawer test, I2 codeSplitting group 194.3 → 193.4, minors; commits b80cab4..4ef18ed)
Task 23: CARRY to 24: snooze min/max test compares two Date.now() reads (minute-boundary flake) → fake timers; SavingStatus `empty:hidden` on a live region may drop the first announcement → sr-only toggle; drawer-closing test loop would not catch a swallowed Escape
Task 23: complete (commits 8817e92..4ef18ed, review + 1 fix round)
M4 Task 24: dispatched implementer (sonnet), BASE 4ef18ed; carries from 23 (snooze test flake, SavingStatus live region) in dispatch
M4 Task 24: implementer DONE_WITH_CONCERNS (0321444) — bundle 193.4 → 194.7; Menu primitive has no max height (hundreds of projects overflow); storage refusal only a console report (brief); mobile.lists.open command outside COMMANDS; cold lazy chunk deadlock inside act → test warms chunks
M4 Task 24: review dispatched (sonnet)
M4 Task 24: review (Sonnet) approved — 0 C / 1 I (plan-mandated: Menu primitive unbounded height, items unreachable past ~25–30 projects); cold-chunk deadlock = act artefact; storage_refused console report = brief's M3R84 rule
Task 24: Ruling: bound the @pap/ui Menu content height now (max-h-app overflow-y-auto, existing token, own fix(ui) commit) — outside the task's file list but a one-line primitive fix; the plan bounded the list at 500 without a scroll — cost if wrong: none
minor (deferred): with a project selected and an empty Recent, home hides "All sessions" (the top bar tree button remains); an idle project can stay effective (moot if the snapshot only carries active projects)
Task 24: follow-up (resumed implementer): Menu height bound + test, two comments — controller verifies (class + comments, < 50 lines)
Task 24: follow-up d7c5e0f + b2d026d verified by controller (Menu max-h-app overflow-y-auto + test run green, two comments; bundle unchanged 194.7)
Task 24: complete (commits 4ef18ed..b2d026d, review approved + follow-up)
M4 Task 25: dispatched implementer (sonnet), BASE b2d026d; carry from 12b (search timeout/capacity copy) in dispatch
M4 Task 25: implementer DONE_WITH_CONCERNS (9157ca5) — bundle 194.7 → 194.8; min search length 3 code points; formatAge moved to i18n/age.ts (boundaries); extra test files; no notice when a hit's entry cannot be loaded
Task 25: Ruling: minimum search length 3 code points (owner Q6 "min prefix 3" and the daemon's prefix minimum beat M4R106's 2) — cost if wrong: one constant
M4 Task 25: review dispatched (sonnet)
M4 Task 25: review (Sonnet) Needs fixes — I1 (plan-mandated) snippetParts drops \n/\t so multi-line hits glue words; minors: M4R108 notice missing when nothing can load, notice never clears, hit flicker between keystrokes, plain-object error-key lookup
Task 25: fix round 1 dispatched (resumed implementer) — FIX_BASE 9157ca5
M4 Task 25: fix round 1 implementer DONE (0694a6d) — word breaks kept, ZWJ kept, notShown notice, notice clears (useFocusMatch rewritten, request kept until shown), hits kept while loading, Object.hasOwn; concern: unsatisfied focus request lingers until replaced
M4 Task 25: fix round 1 re-review dispatched (resumed Sonnet reviewer)
Task 25: fix round 1/5 re-review: I1, M1, M2, M4, M5 addressed; new: sticky notShown request resurrects on revisit (Important), stale hits activatable while loading (Minor)
minor (deferred): an itemKey whose element is grouped/collapsed away is a silent no-op (no retry, no notice)
Task 25: fix round 2 dispatched (resumed implementer): take the request in the notShown branch, disable hits while loading — FIX_BASE 0694a6d
M4 Task 25: fix round 2 implementer DONE (6fbdef2) — notShown request taken at once (local notice), stale hits disabled while loading; 2 real mutations
Task 25: fix round 2/5 re-review: Q3, Q4 addressed — Approved; follow-up: re-enable test (Enter works once the answer lands) — controller verifies
minor (deferred): the local notShown notice has no clear within one mount (cosmetic)
Task 25: follow-up f60a304 (the re-enable test failed first: cmdk kept its selection off re-enabled hits → palette controls cmdk's value, falls back to the first choosable row) — verified by controller: full test:unit 4100 green, build + budgets 194.8 KB
Task 25: complete (commits b2d026d..f60a304, review + 2 fix rounds + follow-up)
M4 Task 26a: dispatched implementer (sonnet), BASE f60a304
M4 Task 26a: implementer DONE (2cba260) — bundle unchanged 194.8; session-reducer.entries.test.ts updated to the oldest-twin binding
M4 Task 26a: review dispatched (sonnet)
M4 Task 26a: review (Sonnet) approved — 0 C / 0 I; follow-up (test-only, controller verifies): hiddenDialogs never below 0, three twins, render-level no-remount, staleDialogs/partialKey mutations
minor (deferred): partialKey not cleared on an aborted reply (harmless, vm reads it only while a partial exists); same-ref append between message_start and message_end would remount once
Task 26a: follow-up 84928d3 verified by controller (test-only; new tests run green; 4 mutations reported caught)
Task 26a: complete (commits f60a304..84928d3, review approved + test follow-up)
M4 Task 26b: dispatched implementer (sonnet), BASE 84928d3
M4 Task 26b: implementer DONE_WITH_CONCERNS (1b61aea) — bundle unchanged 194.8; sendOther defect found (textarea Ctrl+Enter fired on Ctrl+Shift+Enter) fixed with onKeyDownCapture in Composer.tsx (outside list); nested fences (≥ 4-space indent) split until the message ends; last-screen contract test had no RED
M4 Task 26b: review dispatched (sonnet)
M4 Task 26b: review (Sonnet) approved — 0 C / 0 I; Composer onKeyDownCapture judged correct (dispatcher declines → TextField sent the draft); follow-up: CRLF fences, deterministic linearity test, inline-code fence comment — controller verifies
minor (deferred): block margins vs whole-document margins at message_end may jump once; nested fences ≥ 4 spaces split while streaming (M4R113 cost)
Task 26b: follow-up 697642f verified by controller (CRLF split + test, exact-count linearity on hostile shapes, comment; tests green)
Task 26b: complete (commits 84928d3..697642f, review approved + follow-up)
M4 Task 27: dispatched implementer (sonnet, owner lever 3), BASE 697642f
M4 Task 27: implementer DONE (95421ee) — 93 keys moved to the lazy session catalog, bundle 194.8 → 192.7; 4 error.* + session.status.releasing stay eager; catalog-keys literal floor 100 → 50
M4 Task 27: review dispatched (sonnet)
M4 Task 27: review (Sonnet) approved — 0 C / 0 I; no eager reader of a moved key; M5 en.ts hunk does not overlap
minor (deferred): catalog-keys literal floor (> 50 vs 71, en only) could be ~65 and cover fr; lazy-catalog prefix regex omits status./source./row./branch./navigation.; a few chunk-only strings still eager (possible later saving)
Task 27: complete (commits 697642f..95421ee, review clean; bundle 192.7 KB)
M4 Task 29: dispatched implementer (sonnet), BASE 95421ee
M4 Task 29: implementer DONE_WITH_CONCERNS (e0a1a8f) — outside-writes.ts, scan-port.outside.test.ts, service.ts at 400 (one blank line removed); service-level worker-end wiring untested; mutation-revert incident in scan-port.ts fixed and gates re-run
M4 Task 29: review dispatched (sonnet, incl. residue check)
M4 Task 29: review (Sonnet) Needs fixes — I1 a pap-made fork/clone raises the notice (forks.adopt writes with no ended-at / live worker); I2 service wiring (launchHooks, isLive) untested — crash seam exists; I3 starting window (worker spawned before live.set) unguarded; minors; scan-port.ts residue check clean
Task 29: CARRY to 28 (docs): docs/agents/sessions.md — the outside-write notice (2 min window, what counts as pap's own write)
Task 29: fix round 1 dispatched (resumed implementer) — FIX_BASE e0a1a8f
M4 Task 29: fix round 1 implementer DONE (5f5af73) — forks onMade records ended-at, onStarting/onStarted make isLive cover start-up, service.outside.test.ts (crash seam), 5 real mutations
Task 29: fix round 1/5 re-review: I1, I2, I3, minors addressed — Approved (starting set keyed by id: overlapping launches can only clear early, never leak)
Task 29: complete (commits 95421ee..5f5af73, review + 1 fix round)
M4 Task 28: dispatched implementer (sonnet), BASE 5f5af73; carries (U+202E + repo-wide scan, test:budget, sessions/search/web docs, outside-write notice, tree limits) in dispatch
M4 Task 28: implementer DONE_WITH_CONCERNS (c269e41, 812e82a) — 8 test files' literal bidi/zero-width → escapes (left: M2 plan doc, a woff2 font); test:budget p95 98.8 ms / p50 7.5 ms, CLI 1008 ms; bundle 192.7 (budget 200); search.md corrected (cap 4 000 000, schema v1); smoke step mutation-checked
M4 Task 28: review dispatched (sonnet)
M4 Task 28: review (Sonnet) approved — 0 C / 0 I; escapes keep every code point; smoke-lib pure move; docs spot-checked against code
minor (deferred): web.md "Move down" sentence wording; smoke search hit matched by cwd (M4R119)
Task 28: complete (commits 5f5af73..812e82a, review clean)
M4 final review dispatched (Opus, whole branch 4e85dd0..812e82a, full gate)
M4 final review (Opus): ready to merge with fixes — 0 C / 2 I / 9 m; gates green (unit 4149, int 304+1 skip, bundle 192.7, smoke, test:budget p95 100.5 ms, CLI 1008 ms); dry merge with feat/m5-policy conflicts only in the 8 agreed shared files
Ruling: M4 final fix dispatch covers I1 (prefix rule on tokenizer output + docs), I2 (fresh snapshot on subscribe after an outside write) and all 9 minors; minor 7 (M4R60 becomes cross-user once M5 adds users) is fixed now inside M4's own unmerged migration (no new stamp) — cost if wrong: one extra table
M4 final fix dispatched (fresh Sonnet implementer), BASE 812e82a
M4 final fix: DONE (28dbf61..0ad3613, 9 commits) — I1 prefix rule on FTS5 tokens via an in-memory tokenizer probe (deadline still cannot stop a prefix expansion: documented), I2 fresh snapshot on reopen after outside write, minors 1–9 (service.ts 400 → 256 via service-types.ts; sidebar.age.* → eager shell.age.*, bundle 193.1); gates green
M4 final fix: scoped re-review dispatched (resumed Opus final reviewer, full gate)
M4 final re-review (Opus): ready to merge — I1, I2, minors 1–9 addressed; gates green at 0ad3613 (unit 4157, int 306+1 skip, bundle 193.1, smoke, test:budget p95 97.2 best-of-3 / 101.9 single-pass, CLI 1008 ms)
Ruling: fix two residual nits before merge (a 50 ms sleep in the reopen test breaks the no-sleep rule; index on session_pending_ids(session_id)) — logging codes for non-SQLite open errors deferred — cost if wrong: none
Controller: agreement 5 amended in .superpowers/m4-m5-cross-plan-agreements.md (service-types.ts holds the service interfaces; M5's interface additions go there)
minor (deferred): search_index_open_failed logs only SQLite codes; dev homes that applied the earlier 202610121500 must be reset (main/preview never applied it)
M4: merge waits for M5's tasks (owner, 2026-10-12 ≈19:45)
M4 residual nits 7f043f5 + d236ce9 verified by controller (sleep → computed mtime; index on session_pending_ids(session_id), unread pending_pi_session_id index dropped); M4 head d236ce9 READY TO MERGE (waits for M5)
