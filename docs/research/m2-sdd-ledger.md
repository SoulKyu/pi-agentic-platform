# M2 SDD ledger (archived 2026-10-12)

Controller ledger of the M2 subagent-driven run, copied verbatim from the git-ignored SDD workspace before its worktree was removed. Rulings: [m2-rulings.md](m2-rulings.md). Final review findings are summarised in the ledger lines `M2 final: ...`.

# SDD ledger — plan: docs/plans/2026-10-11-m2-sessions-core.md
Spec: docs/specs/2026-10-10-C-architecture.md (+ A, DESIGN.md). Worktree: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2 (branch feat/m2-sessions). Start base: 1b3aa3e (plan d9b5a71 + docs archive).
Models (owner-approved X2, 2026-10-11): implementers Sonnet (all, T7 included); reviewers Sonnet except Opus for T5, T8, T9a, T13a, T13b, T14b, T17a, T18, T20; T29 reviewer Haiku; scoped re-reviews of small fix diffs Sonnet; final whole-branch review Opus. Fix rounds 4–5: Opus implementer pre-approved by the owner for M2 (T1).
Pipelining: one implementer in this worktree at a time; M3 runs in feat-m3 in parallel.
Env: node 24.14.x; pnpm via .superpowers/bin shim; deps installed (frozen lockfile); systemd --user with Linger=yes; no browser.
Preflight: Opus red-team (.superpowers/redteam-m2.md, 3 Critical / 17 Important / 22 Minor / 6 overlap) applied by an Opus plan fix (d9b5a71); conflict scan table in the plan ("Pre-execution conflict scan"); 148 rulings M2R1–M2R148 in rulings.md and inline per task ("Rulings (pre-dispatch)"). Owner decisions: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/owner-decisions-2026-10-11.md. Cross-plan: .superpowers/m2-m3-cross-plan-agreements.md.
Ruling: idle release counts as background work only processes outside the worker's own process group (MCP servers the worker starts don't pin it) — plan-fix interpretation of R2-2, accepted — cost if wrong: a worker with only in-group children is released while it works (low).
Ruling: sign-out clears pending sends along with drafts (R2-4) — accepted — cost if wrong: an unconfirmed send is forgotten on sign-out (low).
Ruling: navigate_tree has no daemon timeout (session_before_tree hooks may ask the user, like prompt R99); rename and clearQueue list `timeout` — accepted — cost if wrong: a hung navigate holds the busy rule until worker exit (low).
Ruling: ANSI black/dim map to `text-muted` until M3 P1 adds a `text-dim` utility (M1 has none) — accepted — cost if wrong: dim text slightly brighter until P1 (none).
Ruling: status-bar `command:` buttons show their command as visible text, not a native title (M3 no-native-title lint) — accepted — cost if wrong: denser status bar (low).
Task order: 1a, 1b, 2, 3, 4, 5, 6, 7, 8, 9a, 9b, 10a, 10b, 11, 12, 13a, 13b, 14a, 14b, 15, 16, 17a, 17b, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28a, 28b, 29, 30.
Task 1a: dispatched implementer (sonnet), BASE 1b3aa3e, agent a4b1c6b06fe3e3c02; brief task-1a-brief.md; report task-1a-report.md
Task 1a: implementer DONE (6c48941) — also edited pi-host testing/host-bed.ts + policy/decide.test.ts for alwaysAllow: [] literals
Task 1a: minor (deferred): Dialog method "approval" does not enforce answers/category presence (streams.ts) → enforce in daemon at Task 13a (or superRefine)
Task 1a: minor (deferred): UI_LIMITS widgets/notices/queue caps and custom_render.lines lack cap-crossing tests → add with daemon clipping (Tasks 12, 15, 16)
Task 1a: minor (deferred): streams.ts mid-file import; index.ts export order
Task 1a: complete (commits 1b3aa3e..6c48941, review clean)
Task 1b: dispatched implementer (sonnet), BASE 6c48941, agent a74c9a0c535517a7d
Task 1b: implementer DONE_WITH_CONCERNS (1fa2528) — no pre-implementation RED (mutation checks instead); edited 8 out-of-list tests with protocol-1/v1 shapes; changed prescribed budgets (dialog 1100→1500, notices 3000→5000, oversize bytes ROW_BYTES+39)
Task 1b: review dispatched (sonnet), agent ad8043201c8e4e7f1
Task 1b: minor (deferred): fitSnapshot clamps decoration bytes but not counts (statuses/widgets/notices/panels vs UI_LIMITS) → CARRY to Task 16 dispatch: clamp counts in fitSnapshot or in the daemon decorations store, with a test above the limits
Task 1b: minor (deferred): notices test name overclaims DECORATION_BYTES; fitRow bytes includes wrapper (+39 needs a comment); no pre-implementation RED run (disclosed, mutation checks cover the guards)
Task 1b: complete (commits 6c48941..1fa2528, review clean)
Task 2: dispatched implementer (sonnet), BASE 1fa2528, agent aaf273c0e2a02465a
Task 2: implementer DONE_WITH_CONCERNS (b439ae0) — Pi 1.1.0 emits no entry_appended for message/compaction entries (only cache warmer, virtual-model state, extension appends); fresh-session ready.leafId is a string; compaction script needs a 4th step; host.int policy_update test updated for M2R16
Ruling: entry ids and the leaf of a hot session come from pi-host itself: after append-capable events (message_end, compaction_end, turn_end, agent_end, navigate_tree response, extension appends) pi-host checks SessionManager.getLeafId() on the next macrotask and, when it moved, sends the new branch entries (getBranch from the leaf back to the last sent id) as slim `entry_appended` records, bounded per flush (over the bound → one `leaf` resync record and the daemon re-reads after agent_settled). Never read the JSONL right after message_end (R38(3)). CARRY to Tasks 9a, 10a, 10b dispatches (10b owns the pi-host synthesis) — why: Task 2 found Pi does not emit them; SDK has getLeafId/getLeafEntry/getBranch — cost if wrong: Task 10b rework (medium)
Task 2: minor (deferred): no test crosses UI_LIMITS.queueEntries slice (wire-events.ts:762); compact int test doesn't assert estimatedTokensAfter / compaction entry; policy_update int test passes without clearing (bed has no always rules — unit test proves it); dispatch default/background/throwing commands untested; editorText slice may split a surrogate pair
Task 2: CARRY to Task 17a (and any daemon task forwarding command failures): worker `error` text is clipped SDK text — the daemon maps every failed session command to `command_failed` with a fixed message, never forwards `error` (R66)
Task 2: complete (commits 1fa2528..b439ae0, review clean)
Task 3: dispatched implementer (sonnet), BASE b439ae0, agent af479dad025b2806b
Task 3: implementer DONE_WITH_CONCERNS (89304e8) — test assertion /ls|bash/ instead of not.toContain('ls'); timer.unref() added; no-model/timeout/model-failure paths untested (brief); docs not updated; 1 non-reproducible int failure (rerun green)
Task 3: review → Needs fixes (2 Important): LLM title not stripped of control/bidi/format chars + surrogate-safe cut; no-model/timeout/failure/empty-title guards untested (no mutation check)
Ruling: the failure-path tests are added despite the brief's "no test" — the lessons checklist (every guard has a test that fails when it is removed) is binding over the brief — cost if wrong: ~20 lines of tests (none)
Ruling: worker error text stays `messageOf(error)` (clipped) for consistency with Task 2's commands; the daemon maps every failed command to `command_failed` (carried to Task 17a/17b) — cost if wrong: none (daemon is the boundary)
Task 3: minor (deferred): docs/agents pi-host note on auto-name (→ Task 30 docs)
Task 3: fix round 1/5 dispatched (resumed implementer af479dad025b2806b), FIX_BASE 89304e8
Task 3: fix round 1/5 (2 addressed, 0 open — title sanitised by code point; failure paths tested incl. stopReason error; commits 89304e8..235bc3d)
Task 3: complete (commits b439ae0..235bc3d, review clean after 1 fix round)
Task 4: dispatched implementer (sonnet), BASE 235bc3d, agent a605829d5549b95a7
Task 4: implementer DONE (4f8d24f) — ipc test uses onSend capture (fakeProcess has no `sent`); descendants run() helper + ipc serialize test adjusted; open-session.int.test.ts + policy/extension.test.ts one-line signature fixes
Controller: `.vitest/` (json reporter output, from the rtk test wrapper) added to the repo's local .git/info/exclude — never committed
Task 4: minor (deferred): `ipc send failed` catch (ipc.ts:107) lost its test; zombie re-listing can over-count sweeps (bounded); descendants run() helper intent; session_shutdown with 0 ms when abort eats the grace (doc one line); host.ts:269 long comment
Task 4: complete (commits 235bc3d..4f8d24f, review clean)
Task 5: dispatched implementer (sonnet), BASE 4f8d24f, agent a973a24f12e696e15 (reviewer will be Opus)
Task 5: implementer DONE_WITH_CONCERNS (bd25c82) — oom read from the slice's memory.events (scope gone at reap with OOMPolicy=continue) → sibling contamination possible; prescribed tests fixed (fake-clock stop, XDG_RUNTIME_DIR under env -i, own-slice sweep); stop() reaps unkillable scoped workers; NOT wired into daemon (config, boot sweep, killAllNow on giveUp → Task 6); reap-timeout mutant caught only by a hang; cleaned its own leftover slices
Task 5: review dispatched (OPUS), agent a82010dfd38b9a52f
Task 5: Opus review → Needs fixes (2 Important): I1 OOM read from the home slice (sibling widening + async baseline race) deviates from M2R25; I2 reap logs false worker_scope_step_failed on normal exits (scope already collected) and hides real `show` failures. Minors: reap-timeout test without own deadline; 32-bit unit-name collision; probe doesn't validate the real launch (no --slice/properties, run-*.scope in app.slice, OOMPolicy probe failure only info); execFileText timeout = code 1; whichOnPath accepts relative PATH entries (R130 class); stale comments; unkillable path two answers; deactivating loop / R100 kill step / killAllNow recursion untested; missing-loginctl info instead of M2R30 warning
Ruling: OOM detection uses a per-worker child slice `app-pap-<h>-<rand>.slice` (under the home slice, so sweep/killAllNow still cover it); its memory.events starts at 0 = "read at spawn", read at reap = owner semantics of M2R25 restored, no async baseline, then stop the child slice — why: removes sibling contamination and the race — cost if wrong: one extra transient unit per worker (measure)
Ruling: reap skips kill/stop/reset-failed when `show` says LoadState=not-found (collected scope has no processes) and logs `show` failures — cost if wrong: none
Task 5: fix round 1/5 dispatched (resumed sonnet a973a24f12e696e15), FIX_BASE bd25c82; Task 5: minor (deferred): M10 vague skip reason in scope.int.test available check
Task 5: fix round 1 re-review dispatched (OPUS), agent af48f5386e1771722, range bd25c82..93468b1
Task 5: fix round 1/5 (11 addressed, 0 open — per-worker child slice for OOM, LoadState skip + show_failed log, bounded tests, counter in names, real-launch probe, timeout distinct, absolute PATH only, one answer on unkillable path, deactivating/R100/killAllNow tests, loginctl warning; commits bd25c82..93468b1)
Task 5: CARRY to Task 6 dispatch (small, same files): systemctlRun logs a failed `show` twice (show_failed + step_failed with the --property arg as `unit`) → exclude "show" again; give `await stopped(handle)` in scope.int.test.ts (~124, 159, 216) and the `execFileSync(list-units)` call their own deadlines; "leaves no unit nor slice" should assert empty output
Task 5: minor (deferred): scope.test.ts:172 checks --unit= not slice distinctness; no behaviour test for M7 unscoped vs scoped unkillable; scope.ts:38 doc slice-name form; worker.scope.int.test.ts bare awaits (34, 43, 83); execFileText external signal → code 1; plan text still prescribes started() (stale, harmless)
Task 5: complete (commits 4f8d24f..93468b1, Opus review clean after 1 fix round)
Task 6: dispatched implementer (sonnet), BASE 93468b1, agent a9a44d9602933d6b6; carried: show double-log, scope.int deadlines, empty list-units assertion
Task 6: implementer DONE_WITH_CONCERNS (0c3c80d) — brief harness test fixed (timeout arg, port 9 rejected by undici → 65001 + negative test); killScopes in main.ts untested; workerIdleMs parsed but unused until Task 20
Task 6: review → Needs fixes (2 Important): killScopes in main.ts forced-exit path untested (M2R37); boot order probe → sweep → sessions module untested
Task 6: minor (deferred): parseCount accepts "1e3"/"0x100" and has no upper bound (existing); workerIdleMs unused until Task 20; harness import order; R118 check assumes one stop per daemon
Task 6: fix round 1/5 dispatched (resumed sonnet a9a44d9602933d6b6), FIX_BASE 0c3c80d
Task 6: fix round 1/5 (4 addressed, 0 open — forceKill helper tested incl. failure isolation; boot order test; unscoped boot on no manager; idle bound 35791; commits 0c3c80d..3a75b2a)
Task 6: minor (deferred): main.ts → forceKill wiring itself untested (typecheck only); fail-closed sweep path unreachable in production (sweep never rejects); order test relies on test_provider_enabled log level
Task 6: complete (commits 93468b1..3a75b2a, review clean after 1 fix round)
Task 7: dispatched implementer (sonnet), BASE 3a75b2a, agent aec4bc468b2081328
Task 7: implementer DONE_WITH_CONCERNS (ebf7359) — isSystemMessage moved to live-run.ts (avoid circular import); service.ts 281 lines (brief target 220; < 400); tests unchanged 184/184; R111b generation mutation caught
Task 7: CARRY to every later task that adds to modules/sessions/service.ts (now 281 lines): if the addition would pass ~350 lines, first move launch/bindPiFile into service-launch.ts (no behaviour change) in the same task
Task 7: minor (deferred): import order in service-reads.ts / live-session.ts (cosmetic)
Task 7: complete (commits 3a75b2a..ebf7359, review clean)
Task 8: dispatched implementer (sonnet), BASE ebf7359, agent ad2c2d7374d757c45 (reviewer will be Opus)
Task 8: implementer DONE_WITH_CONCERNS (a64675d) — remembered abort unbounded if Pi answers started without agent_start (could abort a later run); run-tracker probe .catch(() => null) still silent (no logger); 3 existing tests adapted (origin extension; R111b test opens a run first); service.ts 283
Task 8: review dispatched (OPUS), agent adaaaab3fef72a545
Task 8: Opus review → Needs fixes (3 Important, plan-mandated): remembered abort not tied to its prompts (last answer decides; no bound after `started` → later unrelated run aborted); origin wrong after input that started nothing (handled/rejected/queued); probe failures silent (run-tracker catch, abort get_state)
Ruling: R113 bookkeeping = promptsInFlight + startedAwaitingRun; memory dropped when promptsInFlight === 0 && !startedAwaitingRun; a `started` answer while armed starts a kernel-Clock ABORT_SETTLE_MS (5 s) deadline → on expiry drop the memory + log abort_at_start_expired (info); cleared on onRunStart/onExit; origin = user iff promptsInFlight > 0 || startedAwaitingRun else extension — why: bounds the memory to its prompts, matches spec C §2.4 5 s abort contract — cost if wrong: an early Stop is lost after 5 s and must be pressed again (low)
Ruling: probe failures logged at the live-run call sites (unanswered("get_state")), the tracker stays logger-free — cost if wrong: none
Task 8: CARRY to Task 30 docs: sessions.md "Runs" — R113, origin, starting on reopen, Stop path
Task 8: minor (deferred): runs folded together when agent_start arrives during the previous run's probe (no run_end N / run_start N+1) — consider in Task 10b/17a or final review
Task 8: fix round 1/5 dispatched (resumed sonnet ad2c2d7374d757c45), FIX_BASE a64675d
Ruling: startedAwaitingRun is set on every `started` answer (not only while an abort is remembered) so a run starting after the answer is labelled user; the 5 s deadline clears it — implementer deviation accepted — cost if wrong: an extension run starting within 5 s of a started prompt is labelled user (low)
Task 8: fix round 1 re-review dispatched (OPUS), agent a16f6917dea91cd0d, range a64675d..3c9b7c7
Task 8: fix round 1/5 (3 Important + 3 minors addressed; commits a64675d..3c9b7c7; Opus re-review clean)
Task 8: minor (deferred): live-run.ts:198 promptsInFlight read after await getState (narrow race; capture before await); pi-files realOf accepts a dangling mid-path link pointing outside (pre-existing); abort-path get_state log level unasserted; dialogs test pins only title cap; 5 s bound vs extension hooks delaying agent_start (accepted trade-off)
Task 8: complete (commits ebf7359..3c9b7c7, Opus review clean after 1 fix round)
Task 9a: dispatched implementer (sonnet), BASE 3c9b7c7, agent a56247f01317fd08a (reviewer will be Opus)
Task 9a: implementer DONE_WITH_CONCERNS (01210d7) — int test asserts < 25 deltas (timing-dependent, scripted provider sends 25); redundant flush/dispose on exit kept; partial updated only when the frame was published (deviation); int test written after implementation
Task 9a: CARRY to Task 9b (same files): (1) partial gate: `if (publishMeasured(event) || event.type !== "message_update") partial.apply(event)` so lifecycle events always reach the partial (test: start, 1.1 MB toolcall_delta, 1.1 MB message_end → partial() null); (2) coalescer flushes BEFORE appending when pendingChars + delta.length > MAX_PENDING_CHARS; (3) deterministic int assertion: clock wrapper turning the DELTA_FLUSH_MS timer into 60 s so only text_end flushes → exact single text_delta; (4) docs/agents/sessions.md:37 wording (no field is lost by merging)
Task 9a: minor (deferred): tool_execution_update bytes not counted in pending; timer-path flush outside worker listener try/catch (unreachable); redundant exit flush/dispose; web reducer ignores snapshot.partial until 9b
Task 9a: complete (commits 3c9b7c7..01210d7, Opus review clean)
Task 9b: dispatched implementer (sonnet), BASE 01210d7, agent aa0cdac6326d8b89d; carried 9a items 1–4
Power cut 16:3x: Task 9b implementer resumed (aa0cdac6326d8b89d) with its uncommitted work intact
Task 9b: implementer DONE (66af446) — wire-clip.ts rewritten after the power cut (empty); daemon.int test reads toolResult message_end (tool_execution_end no longer carries the result); oversize tests switched to text_delta / toolcall_end / huge assistant message; new live-session.wire.test.ts (run test hit 400)
Ruling: web `tools` map keyed by call id (latest wins) stays in 9b as the brief prescribes (M2R46); M2-RT-11 occurrence keys + nearest-unmatched pairing land in Task 25 — CARRY to Task 25 dispatch — cost if wrong: duplicated call ids merge tool statuses until Task 25 (low, transitional)
Task 9b: review dispatched (sonnet), agent ace0c7991d17b16fc
Task 9b: review → Needs fixes (2 Important): turn_end.message carries unclipped tool-call arguments (R111 bypass); docs/agents/sessions.md still has two stale statements (text_end/toolcall_end whole; tool result in tool_execution_end)
Task 9b: minor (deferred): 256 KiB web partial cap and clipArguments depth-8 untested; UTF-16 slice may leave a lone surrogate; duplicate @pap/contracts imports in session-reducer.ts
Task 9b: fix round 1/5 dispatched (resumed sonnet aa0cdac6326d8b89d), FIX_BASE 66af446
Task 9b: fix round 1/5 (4 addressed — turn_end clipped, docs corrected, tools Map with insertion-order eviction, coalescer test renamed; commits 66af446..97d7fa1)
Task 9b: complete (commits 01210d7..97d7fa1, review clean after 1 fix round)
Task 10a: dispatched implementer (sonnet), BASE 97d7fa1, agent ab14149b1f6b2c8d6
Task 10a: implementer DONE_WITH_CONCERNS (80db977) — fixed prescribed code (readRange short reads, FIFO refused, session_file_issue rate-limited, history 3 fields); R111 upToBytes test replaced by cache-reread test; cache hit by size+mtime+inode (same-size rewrite in one mtime tick missed); >64 KiB header disables append path; RED only for branch/entries-cache tests
Task 10a: review → Needs fixes (2 Important): files > 32 MiB fully re-parsed on nearly every append (append window has ~no slack; test pins it) → repeated event-loop stalls; ADR 0007 describes leaf tracking not in this commit
Ruling: the tail window slides — allow append up to maxBytes + slack and advance `base` by dropping head entries/ends when the window overflows, never a full re-parse per append; header > 64 KiB and old formats get a test and the same bounded behaviour — cost if wrong: very old history hidden beyond the window (accepted, M2R50)
Task 10a: minor (deferred): per-read indexEntries / lastEntryId full index / convert re-runs (memoize later); newest stale when child precedes parent (finite); equivalent mutant kept
Task 10a: fix round 1/5 dispatched (resumed sonnet ab14149b1f6b2c8d6), FIX_BASE 80db977
Task 10a: fix round 1 re-review dispatched (sonnet), agent aad0a9bc65854459b, range 80db977..36c7044
Task 10a: fix round 1/5 (2 Important + minors addressed — sliding tail window, long-header incremental, older format bounded once, ADR 0007 corrected, rate-limit/timestamp/version/rewrite-guard fixes; commits 80db977..36c7044)
Task 10a: minor (deferred): a > maxBytes file with no header newline re-reads on every change (malformed only); same-size middle-only rewrite in one mtime tick still missed (documented)
Task 10a: complete (commits 97d7fa1..36c7044, review clean after 1 fix round)
Task 10b: dispatched implementer (sonnet), BASE 36c7044, agent a8613e49c6fa31d50; carried: pi-host entry_appended synthesis ruling
Task 10b: implementer DONE_WITH_CONCERNS (eb1b4c6) — pi-host entry synthesis per ruling + LeafRecord in contracts; >128-entry flush → resync logged only (re-read after agent_settled needs a reader call that doesn't exist); custom_message rows unbound until next snapshot; system prompt entry withheld (R107); fixed pre-existing host.commands int flake (from taken before request); history passes 3 fields only
Task 10b: review dispatched (sonnet), agent a898f5e1cbab6d325
Task 10b: review → Approved with 1 Important (enters the loop): resync is log-only (>128 entries in one flush → run rows keep no entry ids; fork/navigate unavailable on them)
Ruling: pi-host sends the walk in batches of 128, rescheduling the flush between batches, up to a hard cap of 4096 entries; only past that emits `resync:true` (log-only stays the documented fallback) — why: no reader call needed, bounded per-flush work — cost if wrong: >4096 entries in one burst still lose ids (practically unreachable)
Task 10b: CARRY to Task 17a: web leafId is only moved by `entry` events — navigate answers / leaf records must update it; publish the branch_summary entry/row produced by navigate_tree with summarisation
Task 10b: minor (deferred): same-millisecond same-role messages in one batch get swapped ids (plan-mandated bind order); malformed/over-128 entry leaves the leaf stale (unreachable); LeafRecord.leafId unbounded in the contract (daemon bounds it); guard refusal can scroll out of outputTail; withTrimmedHistory oldestEntryId edge (≥75 unbound rows); int tests written after code
Task 10b: fix round 1/5 dispatched (resumed sonnet a8613e49c6fa31d50), FIX_BASE eb1b4c6
Task 10b: fix round 1/5 (2 addressed — 128-batches up to a 4096 walk, int-bed cleanup; commits eb1b4c6..1c06cc2) — re-review found a NEW Important: appends during a multi-batch send dropped until a later event (no re-walk) → fix round 2/5 dispatched (resumed a8613e49c6fa31d50), FIX_BASE 1c06cc2
Task 10b: fix round 2/5 (1 Important + 1 minor addressed — dirty flag re-walk after the last batch, batch sizes pinned; commit f0de2db)
Task 10b: complete (commits 36c7044..f0de2db, review clean after 2 fix rounds)
Task 11: dispatched implementer (sonnet), BASE f0de2db, agent a982aba7e847261e5
Task 11: implementer DONE (commits 80555eb, 9bb7ce2; unit 1625, int 225 pass)
Task 11: Ruling: toolOutput searches the session's active branch only (red-team), abandoned-branch toolCallId → not_found; brief's whole-file search superseded
Task 11: task review dispatched (sonnet), diff f0de2db..9bb7ce2, agent a454501895725c204
Task 11: review APPROVED with 1 Important (sessions.branches has no JSON-byte budget, worst case ~1.7 MB) + 7 minor
Task 11: Ruling: fork choices/points with ids > 128 (contract bound) are skipped and counted as truncated (keys cannot be clipped)
Task 11: fix round 1/5 dispatched (resume implementer): Important 1 + minors 1, 2, 5a (generation bump on failed snapshot), 6; FIX_BASE 9bb7ce2
Task 11: minor (deferred to final): multi-row entry cursor skip (unreachable), toolOutput args cut without flag, web view-messages cap (virtualisation M4/M13), params not .strict() (consistent with all methods)
Task 11: fix round 1/5 (Important + minors 1, 2, 5a, 6 addressed — fitPoints JSON-byte budget + truncated flag, lossless paging round-trip, generation bump on unreadable snapshot; commit 144556b)
Task 11: complete (commits 80555eb..144556b, review clean after 1 fix round)
Task 12: dispatched implementer (sonnet), BASE 144556b, agent a8edd71ad69ce258d; carried: clearQueue/queue events fitted in JSON bytes (+truncated), service.ts split at ~350
Task 12: implementer DONE (commit a83fca7; unit 1659, int 228 pass) — tests split into live-session.queue / session-reducer.queue / service.queue test files (400-line guard); PAGE_BYTES moved to snapshot.ts (shared frame budget); clear_queue unreadable answer → truncated:true
Task 12: task review dispatched (sonnet), diff 144556b..a83fca7
Task 12: review agent dispatched
Task 12: review NEEDS FIXES — 2 Important (I1 queue previews take full PAGE_BYTES and can starve the reconnect snapshot of a pending dialog; I2 inFlightBytes release untested) + 5 minor
Task 12: Ruling: queue previews (events, snapshot queue, QueueView) get their own QUEUE_PREVIEW_BYTES = 64 KiB JSON budget; clearQueue keeps PAGE_BYTES (texts go back to the composer); previews are a contiguous prefix (UI shows "N more" from count)
Task 12: Ruling: unreadable clear_queue reply stays success {[], [], truncated:true} (Pi already cleared) + one log line with a stable code
Task 12: fix round 1/5 dispatched (resume implementer): I1, I2, M1, M2, M3, M4 (prefix), M5; FIX_BASE a83fca7
Task 12: CARRY to Task 24: steering may use the whole preview budget leaving followUp empty — split or show both; QueueView has no truncated flag, derive "N more" from count
Task 12: fix round 1 implementer DONE (commit 37d6a79; unit 1666, int 228); M2 done as reset epoch (late release after reset is a no-op) instead of clamp; scoped re-review dispatched
Task 12: fix round 1/5 (2 Important + 5 minor addressed — QUEUE_PREVIEW_BYTES 64 KiB, byte release pinned, contiguous prefix, clear_queue_unreadable log, reset epoch, timeout pinned; commit 37d6a79)
Task 12: minor (deferred to final): no test that a post-reset prompt releases its own slot; late queue_update-after-exit test relies on FakeWorker dropping records (live-session has no own guard)
Task 12: complete (commits a83fca7..37d6a79, review clean after 1 fix round)
Task 13a: dispatched implementer (sonnet), BASE 37d6a79, agent aeed63df546df2cef; carried: Task 1a approval answers/category enforcement (fail closed), service/live-session split rule; reviewer Opus
Task 13a: implementer DONE_WITH_CONCERNS (commit 428afdb; unit 1686, int 228) — client {cancelled:true} sent as {answer:deny, cancelled:true} (deviates from M2R61); duplicate-id approval replaces the open dialog (existing registry rule)
Task 13a: Ruling: M2R61 stands literally — a client {cancelled:true} is the person dismissing a card they saw → plain deny (the user's answer); {answer:"deny", cancelled:true} is reserved for daemon-side closes (limits/cut M2R62, worker exit, release, timeout). My carry wording "cut or closed" meant daemon-side closes. Fix in round 1 (one line + test)
Task 13a: task review dispatched (OPUS per X2), diff 37d6a79..428afdb
Task 13a: Opus review NEEDS FIXES — 1 Important (malformed approval_request dropped by parseWorkerRecord → never answered, worker hangs; daemon deny/cancelled branch unreachable; tests bypass the schema via the fake worker) + 8 minor (same-id replacement unsafe: text swap + unanswered waiter; shared notice key; mapped-answer checks; surrogate cut; tests; docs)
Task 13a: Ruling: approval_request with a valid id but a bad body → daemon-internal approval_request_invalid record → answered {deny, cancelled:true} + notice + log; tests go through the real parser (fake-worker emitRaw)
Task 13a: Ruling: dialog id collisions — approval over open approval: withdraw old ({deny,cancelled}) then open new; cross-kind collision: cancel the newcomer, keep the open one; extension over extension unchanged; no waiter ever unanswered
Task 13a: Ruling: approval cancellation notices get their own rate-limit key; mapped answers ({confirmed}) must be in the offered list else bad_request
Task 13a: fix round 1/5 dispatched (resume implementer): client cancel → plain deny (M2R61), Important 1, collisions, notice key, mapped answers, surrogate cut, tests, docs; FIX_BASE 428afdb
Task 13a: CARRY to Task 16: fitSnapshot can drop an approval with no marker — add a hidden-dialogs count/marker so the client knows something is pending
Task 13a: minor (deferred to final): take-before-send loses the approval when the send is refused (plan-mandated; worker gone)
Task 13a: fix round 1 implementer DONE (commit b6d69e9; unit 1716, int 228); approval_request_invalid via parser, FakeWorker.emitRaw, collision rules, local surrogate-safe labelOf; Opus re-review dispatched (precedent: T5/T8 Opus re-reviews; 49 KB security diff)
Task 13a: fix round 1/5 (Important 1 + 6 minors + R1–R5 addressed; commit b6d69e9; Opus re-review: 5 mutations fail as expected; approval_request_invalid not forgeable, ids bounded)
Task 13a: Opus re-review N1 (minor, security path): malformed approval under an open approval's id answered but card kept → dead card answered twice, grant for a blocked call. Ruling: withdraw (as R3) — shared withdraw helper, dialog_closed before refuseApproval
Task 13a: fix round 2/5 dispatched (resume implementer): N1 + nits (dismiss deny when not offered pinned, dialog_cancelled log asserted, pi-host.ts:71 comment); FIX_BASE b6d69e9
Task 13a: minor (deferred to final): `cut` (dialogs.ts:59, extension dialogs) can split a surrogate pair (pre-existing)
Task 13a: fix round 2 implementer DONE (commit 85a4207; unit 1720, int 228); scoped re-review dispatched (sonnet, small diff)
Task 13a: fix round 2/5 (N1 + 3 nits addressed — shared withdrawOpenApproval, P2 pinned, dismiss-deny pinned, log asserted; commit 85a4207)
Task 13a: complete (commits 428afdb..85a4207, review clean after 2 fix rounds)
Task 13b: dispatched implementer (sonnet), BASE 85a4207, agent ade5c3b5bfb73959c; carried: validate before send (fail closed), pending cap, abort-listener cleanup, bounded canonical JSON for grant key; reviewer Opus
Task 13b: implementer DONE_WITH_CONCERNS (commit 1099df1; unit 1744, int 233, smoke ok) — smoke-dist.ts was already broken since Task 9b (wire-clip strips tool_execution_end result) → now checks isError + the tool-result message_end (file at 400 lines); pending cap 64 = daemon MAX_DIALOGS; answersFor eslint-disable for unused params until 14b; malformed approval_response with an id closes that approval (fails closed)
Task 13b: Ruling: `pnpm smoke` (after `pnpm build`) joins the implementer gate for any task touching the wire, records or pi-host (the smoke silently broke at 9b) — add to later briefs
Task 13b: task review dispatched (OPUS per X2), diff 85a4207..1099df1
Task 13b: Opus review NEEDS FIXES — 1 Important (M2R65 not pinned: separator-forge asserts can't fail — NUL-join mutation survives; built-in-vs-extension `bash` kind untested — name-only mutation survives) + 8 minor; all fail-closed paths verified, cap 64 vs MAX_DIALOGS safe, answersFor disable needed
Task 13b: fix round 1/5 dispatched (resume implementer): I1a/b, m1–m7; FIX_BASE 1099df1
Task 13b: minor (deferred to final): m8 worker pending cap (65 at once) blocks without telling the user — practically unreachable
Task 13b: fix round 1 implementer DONE (commit 202d799; unit 1748, int 233, smoke ok); scoped re-review dispatched (sonnet, 19 KB mostly tests)
Task 13b: fix round 1/5 (I1a/b + m1–m7 addressed — collision pairs + known-answer sha256, built-in vs extension bash kind, guards pinned, scalars charged, smoke strict, dead code; commit 202d799)
Task 13b: minor (deferred to final): scalar `spend` charges untested (array/key charges already bound each element)
Task 13b: complete (commits 1099df1..202d799, review clean after 1 fix round)
Task 14a: Ruling: policy.listRules (1000 rules × 4096-char labels ≈ 4 MB) is fitted in JSON bytes under PAGE_BYTES, oldest dropped first, + truncated flag (contract field)
Task 14a: dispatched implementer (sonnet), BASE 202d799; carried: listRules frame fit, projectScopeOf realpath/64-level/loop/missing-cwd fail-closed, owner check without existence leak, onChange listener isolation, smoke in gate
Task 14a: implementer DONE (commit c6d00ce; unit 1773, int 234 ×2, build + smoke ok, smoke calls policy.listRules) — INSERT OR IGNORE → ON CONFLICT DO NOTHING (CHECK failures no longer read as "exists"); projectScopeOf not re-exported (knip) until 14b; sizeOf/PAGE_BYTES moved to kernel/json-bytes.ts; NUL in a label is cut by node:sqlite
Task 14a: Ruling: rule labels are untrusted display text — NUL (and other C0 controls except \t \n) replaced before storing (U+FFFD) so the revoke list can never show a truncated/misleading label for a key that covers the full command — fix in round 1
Task 14a: CARRY: scripts/smoke-dist.ts is at 400 lines — the next task touching it splits helpers into scripts/smoke-lib.ts first
Task 14a: CARRY to merge: migration 202610110100_policy.sql re-stamped by whichever branch merges second (agreement 1)
Task 14a: task review dispatched (sonnet), diff 202d799..c6d00ce
Task 14a: review NEEDS FIXES — 2 Important (tool/scope not bounded on store → one bad row breaks listRules for the owner via result-schema parse; list without cwd hides rules with truncated:false, inconsistent tie-break) + minors; NUL cut on read also affects tool (rule never matches, fails closed) and scope display
Task 14a: Ruling: addAlways validates tool/scope (bounds, no NUL/C0) → typed throw = bug signal, callers fail closed (session-only grant); label sanitised (C0 except \t\n → U+FFFD) + clipped; listRules skips rows failing the result schema (counted in truncated, logged once)
Task 14a: Ruling: no-cwd list sets truncated on overflow, same order created_at DESC, id DESC; addAlways count+insert in one transaction; projectScopeOf exported by 14b (knip)
Task 14a: fix round 1/5 dispatched (resume implementer); FIX_BASE c6d00ce
Task 14a: minor (deferred to final): scope tests assume no .git above /tmp; skipIf(uid 0) silent skip
Task 14a: fix round 1 implementer DONE (commit e2855d7; unit 1791, int 234, smoke ok); addAlways throws bad_request on bad tool/scope/key; scoped re-review dispatched
Task 14a: CARRY to Task 14b: addAlways may throw (bad_request = bug signal) → fail closed (session-only grant, notice/log); export projectScopeOf from policy/index.ts when consumed
Task 14a: fix round 1/5 (2 Important + minors addressed — boundary validation, read-side skip + truncated, no-cwd truncated + order, one transaction, index removed, docs; commit e2855d7)
Task 14a: minor (deferred to final): no kernel test that a throwing db.transaction rolls back and the next one runs; local dev DBs that applied the old policy migration must be recreated (checksum)
Task 14a: complete (commits c6d00ce..e2855d7, review clean after 1 fix round)
Task 14b: Ruling: addAlways throw or "full" → the answered call proceeds (consent), grant becomes session-only (no rule to revoke), log/notice; pushes over record bounds fail closed (nothing allowing pushed, worker asks again), never truncated into allowing
Task 14b: dispatched implementer (sonnet), BASE e2855d7; carried: 14a throw/full handling, export projectScopeOf, end-to-end revoke-bites test, push bounds, smoke-lib split if smoke touched; reviewer Opus
Task 14b: implementer DONE_WITH_CONCERNS (commit f6b0039; unit 1814, int 236, smoke ok) — "session-only" after full/throw lasts until the worker's next policy_update (no worker command for a true session grant); policy_update not sendable → stop the worker + log policy_update_not_sent; MAX_POLICY_BYTES 2 MiB (< pi-host 4 MiB record), over → no rules + log
Task 14b: task review dispatched (OPUS per X2), diff e2855d7..f6b0039
Task 14b: Opus review NEEDS FIXES — 1 Important (plan-mandated: provisional always grant stamped with the version read AFTER await ask → add+revoke updates landing in between don't end it; reproduced 2/5 with real workers: revoked rule still allowed) + 6 minor; concerns (a) session-only after full/throw OK, (b) stopping an untellable worker kept, (c) size guard fine
Task 14b: Ruling: stamp at ask time; coalesce policy_update per worker (starting: one pending, newest replaces — avoids >128 records before ready exit 70; live: one send per macrotask, latest rules); daemon validates pushed rules against PolicyRules (skip + log); notice says "until this project's rules change"
Task 14b: fix round 1/5 dispatched (resume implementer); FIX_BASE f6b0039
Task 14b: minor (deferred to final): tool name > 256 yields an always rule that never matches (fails closed)
Task 14b: fix round 1 implementer DONE (commit 0c14260; unit 1822, int 237 ×2, smoke ok); concerns: daemon notice text bilingual in one string (no locale path); revoke reaches live worker one microtask later
Task 14b: Opus re-review dispatched (fix round 1, 49 KB security diff); pending controller ruling: bilingual 'EN / FR' notice strings vs English-only daemon notices
Task 14b: fix round 1/5 (Important + minors 1–4, 6 addressed; Opus re-review: race 0/72 real-worker rounds vs 5/22 before; coalescing verified safe; validation only narrows; commit 0c14260)
Task 14b: Ruling: daemon notices English-only for now (web renders text verbatim; every other daemon notice is English) — drop the " / French" halves; CARRY to final/post-M2: coded daemon notices translated by the web
Task 14b: fix round 2/5 dispatched (resume implementer): English-only notices, docs "nothing else ends it" corrected, test for the flush cold guard; FIX_BASE 0c14260
Task 14b: minor (deferred to final): ws delivers several frames per read synchronously — a prompt in the same read as a revoke can reach the worker just before the update (pre-existing dispatcher ordering, not a regression)
Task 14b: fix round 2/5 (English-only notices, docs corrected, cold-guard test; commit 4bd2af1; 31-line diff verified by the controller — no separate re-review)
Task 14b: complete (commits f6b0039..4bd2af1, review clean after 2 fix rounds)
Task 15: Ruling: extension-rendered panel/widget text is untrusted — non-SGR escapes (cursor, OSC/DCS, hyperlinks, BEL) stripped at pi-host, bounded by UI_LIMITS, hostile-input tests; pi-tui 1.1.0 exact, minimumReleaseAge never bypassed (refusal → BLOCKED)
Task 15: dispatched implementer (sonnet), BASE 4bd2af1
Task 15: implementer DONE (commit f9fb34e; unit 1861, int 240, smoke ok) — non-SGR escapes stripped in pi-host ui-lines.ts; local 256 KiB per-record byte cap (UI_LIMITS has no byte field); panel cancelled before first render still sends custom_close
Task 15: CARRY to Task 16: daemon sends custom_cancel on Stop; daemon ignores custom_close / custom_* for unknown ids
Task 15: CARRY to the web panel/widget renderer task: render text only as React spans, honour only SGR 30–37/90 + bold/dim/italic/underline, reset style per line; decide on Bidi control characters (strip or neutralise U+202A–202E, U+2066–2069)
Task 15: task review dispatched (sonnet), diff 4bd2af1..f9fb34e
Task 15: review NEEDS FIXES — 1 Important (async handleInput/render/dispose rejection → unhandled rejection kills the worker) + minors; sanitiser fuzzed: no escape survives except SGR, no ReDoS
Task 15: Ruling: SGR narrowed at pi-host to the allowed subset (0,1,2,3,4,22,23,24,30–37,39,90), empty sequences removed; keybindings extras stubbed safely; dropped panel input logged once per panel; no global unhandledRejection handler (a misbehaving extension's own stray rejections may still end its worker — fail-safe)
Task 15: fix round 1/5 dispatched (resume implementer); FIX_BASE f9fb34e
Task 15: fix round 1 implementer DONE (commit 7d5892a; unit 1912, int 240, smoke ok); deps.log defaults to stderr; scoped re-review dispatched
Task 15: fix round 1/5 (Important + 5 minors addressed — watchRejection on handleInput/render/dispose, SGR allow-list at source, PanelKeybindings, single clears, dropped-input logs; commit 7d5892a)
Task 15: minor (deferred to final): stale widget handle's async render rejection can clear the replacement's lines (skip emit when live.get(key) !== handle); 38;5;<allowed n> SGR case unpinned; "clears the widget" test title vs asserting nothing sent; async-resolving render TypeError untested
Task 15: complete (commits f9fb34e..7d5892a, review clean after 1 fix round)
Task 16: dispatched implementer (sonnet), BASE 7d5892a; carried: count clamps (1b), hiddenDialogs marker (13a), custom_cancel on Stop/exit + ignore unknown panel ids (15), throttle on kernel Clock, panelInput owner check
Task 16: implementer DONE_WITH_CONCERNS (commit 093295b; unit 1971, int 240, smoke ok; 35 mutations killed) — live-types.ts split; hiddenDialogs .default(0); source added in live-ui (decorations.apply returns without it); task review dispatched (sonnet)
Task 16: review NEEDS FIXES — 1 Important (throttle sustained rate untested: removing the window re-open doubles 60 Hz publishes, no test fails) + minors (late custom_render reopens a closed panel; no worst-case fitSnapshot test; limiter "N more" lost on exit; dead extension_ui_request case)
Task 16: Ruling: extension errors keep pap's fixed sentence without source (pap's text about an extension; only extension-written text is tagged); closed panel ids remembered (bounded 64) and late records ignored
Task 16: fix round 1/5 dispatched (resume implementer); FIX_BASE 093295b
Task 16: minor (deferred to final): panelInput not_found when the worker is backed up; >64 throttle keys go out unthrottled (plan-mandated)
M3-final CARRY to M2 web Tasks 24–29 + Task 30 (from the M3 final review's bundle analysis): after the M3 merge the SessionScreen pane becomes lazy (M3 applies LazyPane now), so M2's web UI inside features/sessions reachable only via SessionScreen lands in the lazy chunk; keep stores/reducers lean (they stay eager), no Radix overlays imported outside features/sessions, nothing heavy in the session list/home path; M2's own branch trigger (M2R147, 180) unchanged
Task 16: fix round 1 implementer DONE (commit e5b30c8; unit 1978, int 240, smoke ok; 7 mutations killed); PANEL_BYTES 256 KiB own budget; scoped re-review dispatched
Task 16: fix round 1/5 (Important + minors addressed — 60 Hz rate pinned twice, closed-id set 64, PANEL_BYTES + worst-case snapshot tests, limiter flush on stop, dead case removed; commit e5b30c8)
Task 16: minor (deferred to final): large dialogs fill the snapshot first and can crowd out decorations/panels/rows (bounded by SNAPSHOT_BYTES; pre-existing design); renders after a cap-cancel are re-cancelled each time (not remembered)
Task 16: complete (commits 093295b..e5b30c8, review clean after 1 fix round)
Task 17a: dispatched implementer (sonnet), BASE e5b30c8; carried: command_failed mapping (T2), web leafId moved by navigate + branch_summary publish (T10b), busy-rule race pins; reviewer Opus
Task 17a: implementer DONE_WITH_CONCERNS (commit eab6088; unit 2028, int 242, smoke ok; 24/26 mutants killed, 2 equivalent) — busy() stricter (prompt also refused while a navigate is in flight); navigate uses summarize:false so no branch_summary in M2; snapshot carries activity; post-navigate snapshot failure → success + warn + notice; editorText cut to 800 000 JSON bytes
Task 17a: Ruling: the stricter busy rule is accepted (a prompt during a navigate would land on the wrong branch); M2R89 reads as a floor
Task 17a: task review dispatched (OPUS per X2), diff e5b30c8..eab6088
Task 17a: Opus review NEEDS FIXES — 1 Important (a navigate that never answers locks the session forever: Stop sends a plain abort, idle release waits for commandsInFlight 0; reproduced) + 6 minor (snapshot try/catch + editorText slice untested; compaction_end.errorMessage leaks Pi text on the stream; windows invisible to the daemon; unreadable navigate answer leaves a stale branch; nits)
Task 17a: Ruling: Stop stops the worker while a structural command is in flight (as during compaction); the daemon never forwards Pi error text on the stream (fixed flag + clipped log); pi-host refuses compact/navigate while Pi is streaming if the SDK exposes the flag, else the windows are documented; unreadable navigate answer → best-effort snapshot refresh / reload notice
Task 17a: fix round 1/5 dispatched (resume implementer); FIX_BASE eab6088
Task 17a: fix round 1 implementer DONE (commit 8d19450; unit 2040, int 242, smoke ok; 10 mutations killed) — Stop frees hung structural commands; failed:true replaces Pi error text on compaction_end/auto_retry_end, errorMessage dropped on auto_retry_start/summarization_retry_scheduled; pi-host refuses compact/navigate while !isIdle (WORKER_BUSY → session_busy)
Task 17a: Ruling: the failure flag stays on the stream event only (no stale "last compaction failed" on Activity)
Task 17a: Opus re-review dispatched (fix round 1)
Task 17a: fix round 1/5 (I1 + m1–m6 addressed; Opus re-review: no code defects, 9 mutations caught; corrected I1: real Pi reports compacting during navigate, so the lock was fake-worker-only — fix kept for the stale-flag case; commit 8d19450)
Task 17a: Ruling: R66 excludes the assistant message's own errorMessage (model/provider failure the user must see, clipped 500 in the transcript)
Task 17a: fix round 2/5 dispatched (resume implementer): real-worker WORKER_BUSY int test (extension /kick + held agent_start hook recipe), sessions.md:64 narrowed (extension-run before_agent_start window), R66 note; FIX_BASE 8d19450
Task 17a: CARRY to Task 24: show Stop while a session is compacting or navigating (session_busy says "stop it first"; web shows Stop only while running)
Task 17a: CARRY to Task 20 (ruling at dispatch): a worker exit between a navigate and the next prompt (Stop, idle release, crash) loses the navigated branch — Pi keeps the leaf in memory only (M2R52); proposed: store navigatedLeafId on the session row at a successful navigate, clear it when the next entry lands, and on worker start send navigate_tree(target, summarize:false) before admitting prompts
Task 17a: minor (deferred to final): Stop during a navigate that would have answered reports success then loses it on exit (API-only path today); extension-started runs pass both busy checks during before_agent_start hooks (narrow)
Task 17a: fix round 2/5 (real-worker WORKER_BUSY int test — guard removal times out; docs narrowed; R66 note; commit 1fea310; test+docs only, verified by the controller)
Task 17a: complete (commits eab6088..1fea310, review clean after 2 fix rounds)
Task 17b: Ruling: migration stamp 202610110200_session_name.sql (the brief's 202610110000 sorts before the applied policy 0100 → migrate.ts refuses → every dev PAP_HOME breaks); every later M2 migration stays below M3's 202610111000_settings.sql (so M3 never needs a re-stamp)
Task 17b: dispatched implementer (sonnet), BASE 1fea310; carried: nameOf hostile-name list test, R66 command_failed, owner check, cold start single-writer, rename-while-running decision documented
Task 17b: implementer DONE (commit db12a40; unit 2080, int 244 ×2, smoke, budgets 140.8) — SessionName counts code points (contract-wide); nameOf removes C0/bidi (whitespace collapses); rename/autoName outside the busy rule (append only); concurrent autoName share one call; task review dispatched (sonnet)
Task 17b: review APPROVED with 1 Important (appendSessionInfo advances the leaf but no leafMayHaveMoved → daemon leafId lags until the next message_end) + 4 minor
Task 17b: Ruling: nameOf keeps U+200D and U+FE0E/FE0F (emoji sequences), removes other Cf incl. bidi and BOM, treats NEL/U+2028/U+2029 as whitespace
Task 17b: fix round 1/5 dispatched (resume implementer): leafMayHaveMoved after setSessionName (both paths), ready-name announce, autoName timeout + shared-reject tests, nameOf edge chars; FIX_BASE db12a40
Task 17b: CARRY to Task 24: session header shows the name; rename and auto-name controls
Task 17b: fix round 1 implementer DONE (commit 44473c4; unit 2094, int 245, smoke ok); scoped re-review dispatched
Task 17b: fix round 1/5 (Important + 3 minors addressed — leafMayHaveMoved after set_session_name/auto_name with real-worker test, ready-name announce, timeout/dedupe tests, nameOf edge chars; commit 44473c4)
Task 17b: minor (deferred to final): ZWJ kept → lookalike names possible (cosmetic, bidi still stripped); ready announce may duplicate a pre-ready name event; raw U+200B in grant-key.test.ts (outside diff)
Task 17b: complete (commits db12a40..44473c4, review clean after 1 fix round)
Task 18: dispatched implementer (sonnet), BASE 44473c4; carried: hostile-name safe Content-Disposition, ownCsp scoped to the route only, URL inputs validated before lookup, uniform 404s, bounded patch input fail-closed, timers on Clock, smoke-lib split if touched; reviewer Opus
Task 18: implementer DONE_WITH_CONCERNS (commits c599204, 06758b8; unit 2148, int 246, smoke ok) — RED not seen on 3 small tests (mutations instead); take returns {path,title}; route unlinks the file once open; ownCsp only on 2xx; M2R100 web line left to 28a; task review dispatched (OPUS per X2)
Task 18: Opus review NEEDS FIXES — 1 Important (HEAD runs the GET handler in Hono → consumes the single-use token, leaves an unread stream; dead link) + 8 minor; never executes on the pap origin on every probed path (200/401/404/range/conditional/compression/concurrent/abort), 50 000 hostile filenames safe
Task 18: Ruling: GET only (HEAD → 404 before take); purge only pap-named regular files via lstat; export file chmod 0600; token redacted from HTTP error logs; reuse kernel randomToken; client abort logged as export_aborted
Task 18: fix round 1/5 dispatched (resume implementer); FIX_BASE 06758b8
Task 18: minor (deferred to final): patch at the 64 MiB bound blocks ~270 ms / ~0.5 GB transient (documented)
Task 18: fix round 1 implementer DONE (commit b6922b9; unit 2154, int 246, smoke ok); scoped re-review dispatched (sonnet)
Task 18: fix round 1/5 (Important + 6 minors addressed — GET only before auth/take, export_aborted, pap-named lstat purge, chmod 0600 first, token redacted in http logs, kernel randomToken; commit b6922b9)
Task 18: minor (deferred to final): stale doc comment above OWN_FILE in exports.ts; POST test doesn't exercise the guard (falls to notFound)
Task 18: complete (commits c599204..b6922b9, review clean after 1 fix round)
Task 19: Ruling: SessionManager must never be able to rewrite a live source — check what open() does with a torn last line (clone mid-run); if any rewrite is possible, open a temp copy truncated to the last complete line (lineage fixed or documented); source bytes unchanged test incl. torn line; fork text clipped in JSON bytes; source size cap or documented cost
Task 19: dispatched implementer (sonnet), BASE b6922b9
Task 19: implementer DONE_WITH_CONCERNS (commit b784d06; unit 2186, int 247, smoke ok) — live source never opened: private copy (complete lines) under $PAP_HOME/fork-tmp, purged at boot; lineage fixed via a cast on Pi's private sessionFile (pinned by a test); source > 32 MiB → session_empty + fork_source_too_large; task review dispatched (sonnet)
Task 19: review NEEDS FIXES — 3 Important (non-regular source (FIFO) hangs the daemon in openSync; fork-tmp boot purge is a bare recursive rmSync, untested; "equivalent mutation" wrong: a valid entry without trailing newline is observable) + minors; blocking measured 0.17–0.8 s at the 32 MiB cap
Task 19: Ruling: O_NONBLOCK + fstat isFile; purge like Task 18 (pap-named regular files, lstat); post-branch lineage check (parentSession ≠ source → delete + internal, fork_lineage_mismatch); source > 32 MiB answers capacity (added to fork/clone errors)
Task 19: fix round 1/5 dispatched (resume implementer); FIX_BASE b784d06
Task 19: minor (deferred to final): no count cap on fork/clone
Task 19: fix round 1 implementer DONE (commit 89ce35e; unit 2195, int 247, smoke ok); copies now <uuid>.jsonl; scoped re-review dispatched
Task 19: fix round 1/5 (3 Important + lineage guard + capacity + minors addressed; commit 89ce35e)
Task 19: minor (deferred to final): isFile check not pinned on its own (FIFO refused anyway via empty copy); no symlink-to-FIFO test in the repo
Task 19: complete (commits b784d06..89ce35e, review clean after 1 fix round)
Task 20: Ruling: the Task 17a carry (restore a navigated leaf after a worker exit) is DROPPED — owner M2-Q11 accepted "unfollowed navigation lost" (M2R110); documented instead
Task 20: dispatched implementer (sonnet), BASE 89ce35e; carried: bounded /proc walk, M2R108 touch list, every command during releasing defined + tested, grant pushes to a releasing worker must not error, 8 h boundary; reviewer Opus
Task 20: implementer DONE_WITH_CONCERNS (commit 2f9369d; unit 2266, int 253 ×2, smoke ok; 46/48 mutants killed, 2 double-layer guards) — live-idle.ts, service-sync.ts (service.ts 380), fast-health.ts; promptPending used instead of promptsInFlight; promptAndSettle race fixed; crash while releasing → cold no cause; /proc walk 1.9 ms/183 procs; task review dispatched (OPUS per X2)
Task 20: Opus review NEEDS FIXES — 1 Important (plan-mandated M2R107 defect: a process backgrounded by the bash tool is reparented to pid 1 once the shell exits → not a descendant → health.descendants 0 → with scopes on a dev server is killed at 30 min; reproduced with the real Pi bash tool) + 6 minor
Task 20: Ruling (amends M2R107): count this worker's agent processes wherever reparented — scoped: PIDs in the worker's cgroup (cgroup.procs) minus the worker's own process group; unscoped: a per-worker env marker (PAP_WORKER_TOKEN) found in /proc/<pid>/environ minus the worker's group; bounded, never throws; real-worker int test with a backgrounded sleep
Task 20: Ruling: the live session's stopping flag is the single source of "closing" (service no longer reads status()); ensureLive re-check restored; redundant service-level abort/clearQueue guards removed; new test file names accepted (M2-RT-19)
Task 20: fix round 1/5 dispatched (resume implementer); FIX_BASE 2f9369d
Task 20: fix round 1 implementer DONE (commit 9adc7ba; unit 2287, int 256 ×2, smoke ok; 21 mutations killed); cgroup + PAP_WORKER_TOKEN detection; stopping() flag; Opus re-review dispatched
Task 20: fix round 1/5 (Important + minors 2–6 addressed; Opus re-review: both paths verified with the real bash tool + real scope, 8 h boundary exact, stopping() single truth; commit 9adc7ba)
Task 20: Opus re-review new Important: scope accepted by name only → a worker inside another pap worker's scope counts its processes (6 int tests fail when run from a scoped agent); Ruling: PAP_WORKER_UNIT in the scope env, read + deleted at boot, leaf must match else marker path; count tests host-independent; onExit in finally (crash + throwing handler); environ budget in bytes; drop systemctl from knip
Task 20: fix round 2/5 dispatched (resume implementer); FIX_BASE 9adc7ba
Task 20: minor (deferred to final): service-commands busy() pre-check gives session_busy (not wait) for navigate/compact on a closing worker during an extension run; tool daemons (tmux, gradle, watchman) carry the token and keep background up to 8 h (by design)
Task 20: fix round 2 implementer DONE (commit 68e70de; unit 2291, int 257 ×2, smoke ok; 7 mutations killed); scoped re-review dispatched (sonnet)
Task 20: fix round 2/5 (Important + minors addressed — PAP_WORKER_UNIT leaf check, host-independent count tests, onExit in finally, knip, byte budget, panelInput test; commit 68e70de)
Task 20: minor (deferred to final): when the exit handler throws, later cleanup statements (hub decorations/dialog close, run_end/worker_exit, cold status, onActivity) are skipped — closed session's view only
Task 20: complete (commits 2f9369d..68e70de, review clean after 2 fix rounds)
Task 21: dispatched implementer (sonnet), BASE 68e70de
Task 21: implementer DONE (commit d464b8a; int 262 ×2, smoke ok); no production defect found; snapshotWhen helper replaces live waits for session_start statuses; task review dispatched (sonnet)
Task 21: Ruling: tests-only 10 KB diff → controller review instead of a reviewer agent: snapshotWhen = bounded vi.waitFor (20 s) re-subscribing per poll (subscriptions die with the bed in afterEach) — acceptable; source:"extension" mutation kills 3 cases; no production defect surfaced
Task 21: minor (deferred to final): snapshotWhen opens a new subscription per poll (bounded by the bed's lifetime)
Task 21: complete (commit d464b8a, controller-reviewed)
Task 22: Ruling: the HOG fixture runs only inside a real scope with a hard MemoryMax (swap 0) and caps itself at 2× the limit; never unscoped (skip with reason locally, fail in CI); scopes/processes cleaned in afterEach + no pap-* test scope left; dispatched implementer (sonnet), BASE d464b8a
Task 22: implementer DONE_WITH_CONCERNS (commit d4ceb7a; int 269 ×2, both OOM cases ran (lingering user manager), no pap-* unit left; no production defect)
Task 22: Ruling: a throwing extension tool_call handler becomes an error result for that call (Pi behaviour, fails closed, text reaches the transcript as in the TUI) — accepted, pinned
Task 22: controller review (tests-only, 339 lines): hog bounded at 2× MemoryMax in 16 MiB steps, OOM suite gated by describe.skipIf(!scopesAvailable), test slices under /nonexistent/pap-int-scopes-<pid>, releaseScopes lists leftovers; verified no app-pap-*/pap-* units remain
Task 22: minor (deferred to final): daemon-side widget clip only pinned by decorations.test (worker clips first in the flood test)
Task 22: complete (commit d4ceb7a, controller-reviewed)
Task 23: dispatched implementer (sonnet), BASE d4ceb7a; owner gate: p95 RSS > 236 → BLOCKED with numbers before any budget/cap change (M2R116)
Task 23: implementer BLOCKED on the M2R116 owner gate (commit bdbc916 measures only; no budget change): 300-turn scripted session, compaction OFF: RSS p50 316 / p95 = max 665.5 (run 2: 656.7), PSS 615; ceil(p95 × 1.25) = 832 → default cap 16 → 12 on this host (2/2/4/9 on 2/4/8/16 GB); idle RSS 171–181 vs budget 189; payload 9142 B vs 64 KB
Task 23: controller note: ~12 MB of transcript → ~650 MB RSS, with RSS jumping in steps (321 → 409 → 656 between turns 200 and 250) — looks like V8 heap growth or a retention, not proven proportional; compaction off is not the normal setting
Task 23: owner question asked (raise to 832 now / investigate first / keep 236); M2 continues with Task 24 meanwhile (config/budgets are independent)
Task 24: Ruling: rename / auto-name controls move to the session-actions task (28a/28b); Task 24 shows the header name only
Task 24: dispatched implementer (sonnet), BASE bdbc916; carried: queue "N more" from count (T12), Stop reachable in every session_busy state (T17a), header name (T17b), stores lean (bundle), defensive storage parsing
Task 17b: CARRY to Task 28a/28b: rename and auto-name controls (moved from Task 24)
Task 23: OWNER (2026-10-12): "Enquêter d'abord" — Sonnet investigation dispatched in a private copy (/tmp/claude-1000/rss-probe): heap vs RSS with forced GC, heap snapshot retainers (pap vs Pi), compaction-ON re-measure with scripted summaries, budget + mitigation proposal → .superpowers/m2-t23-rss-investigation.md; then the owner is asked again with real numbers
Task 24: implementer DONE_WITH_CONCERNS (commit 970d8c5; unit 2338, int 271, smoke, budgets 144.1/180; 20 mutations) — preference = last used Steer/Follow up; navigation-in-flight not visible to the view (Stop after session_busy) → 28a; Send disabled while a pending send exists; clearQueue truncated not surfaced; pending stored only after an unknown outcome
Task 24: Ruling: preference-by-last-use accepted; Send disabled while pending accepted; pending becomes write-ahead (stored before the send, cleared on a definite outcome) so a reload mid-flight keeps "Send again" with the same commandId (daemon dedups); Stop restoring a truncated clearQueue shows a short notice that some queued text could not be restored
Task 24: task review dispatched (sonnet), diff bdbc916..970d8c5
Task 24: review APPROVED (0 Critical/Important, 5 minor; resending guard mutation survives)
Task 24: fix round 1/5 dispatched (resume implementer): write-ahead pending, truncated-clearQueue notice, sign-out generation guard on storage writes, unmounted-instance guard, input capped at MAX_DRAFT_CHARS, resending-guard test, Ctrl+Enter feedback; FIX_BASE 970d8c5
Task 24: fix round 1 implementer DONE (commit 945b66e; unit 2348, int 271, smoke, budgets 144.6/180); scoped re-review dispatched
Task 24: fix round 1/5 (7 items addressed; re-review approved; commit 945b66e) — new minor: concurrent sends share one write-ahead slot (a steer during the first send's flight overwrites/erases it)
Task 24: Ruling: serialize sends (Send/Steer/Follow up/Ctrl+Enter blocked while a send RPC is in flight, with live-region feedback); fix round 2/5 dispatched; FIX_BASE 945b66e
Task 24: minor (deferred to final): stale "may have been sent" banner after a remount when the send failed definitely (duplicate text possible, no loss); conditional live region may not announce on some screen readers; silent truncation at the draft cap
Task 24: fix round 2/5 (sends serialized while in flight + blockedSending note; savePending re-called on unknown outcome; commit cc1a1aa; controller-verified small diff)
Task 24: complete (commits 970d8c5..cc1a1aa, review clean after 2 fix rounds)
Task 25: dispatched implementer (sonnet), BASE cc1a1aa; carried: M2-RT-11 occurrence keys + nearest-unmatched pairing (from 9b), plain-text rendering, one-at-a-time load older, scroll logic via injected measurements
Task 23: investigation result — 650 MB = V8 old-space growth before rare major GCs (live heap 58–69 MB after forced GC); pap retains nothing that grows (entry-tracker bounded); compaction ON: RSS p50 ≈ 284, p95 ≈ 310; --max-semi-space-size=16 → ≈ 225 MB
Task 23: OWNER DECISION (2026-10-12): worker flag --max-semi-space-size=16 + WORKER_BUDGET_MB 285 (default caps 3/7/14/16 on 2/4/8/16 GB, 16 here); resumed implementer to apply, re-measure, update spike note + decisions-log
Task 25: implementer DONE_WITH_CONCERNS (commit 745a8bb; unit 2392, int 271, smoke, budgets 147.7/180) — not_found wording kept (item can't know its branch); row key remounts once when Pi writes the entry; toolOutput takes only the call id (daemon picks with repeated ids — unchecked); mounted guards dropped (React 19)
Task 25: INCIDENT — stray staged probe/* files appeared in feat-m2's index: the RSS investigator's cp -a copy kept the worktree .git file, so git in the copy hit the real index; the T25 implementer unstaged/removed them; verified clean (status empty, HEAD 745a8bb, no stash). Rule added: scratch copies rm .git first
Task 25: task review dispatched (sonnet), diff cc1a1aa..745a8bb
Task 25: review APPROVED with 1 Important (plan-mandated, Task 11 contract): sessions.toolOutput takes only toolCallId; findToolCall walks newest-first → with reused call_0 an older row's "Show the whole output" returns the newest call's result, args and result may come from different turns + 6 minor
Task 25: Ruling: sessions.toolOutput gains an optional resultEntryId (bounded id); the daemon reads that result entry on the active branch and takes args from the nearest preceding assistant call with the same id; ToolItem carries resultEntryId; a test with the same id in two turns; without resultEntryId the old newest-first lookup remains (live rows)
Task 25: fix round 1 QUEUED until the Task 23 implementer finishes (one implementer per worktree)
Task 23: owner-decision change DONE (commit 8f4158b; unit 2397, int 272, smoke, budgets): --max-semi-space-size=16 always appended by workerExecArgv (+ int bed, fork-host), WORKER_BUDGET_MB 285 (caps 3/7/14/16), idleWorkerRssMb 189 → 191, scripted provider `summary` answers compaction; with flag RSS p95 230.8 / 223.9 (compaction on), without 308; flag no effect with compaction off; decisions-log row 50; spike note rewritten
Task 23: review dispatched (sonnet) over bdbc916 (d4ceb7a..bdbc916) + 8f4158b (745a8bb..8f4158b)
Task 25: fix round 1/5 dispatched (resume implementer): toolOutput resultEntryId (contract + daemon + web), exact/missing tests, unhandled rejection in then chains, omitted-result 'Waiting', scroll anchor release; FIX_BASE 8f4158b
Task 23: review APPROVED (0 Critical/Important, 8 minor)
Task 23: minor (deferred to final): startTestDaemon (harness.ts:84) lacks the flag and fork-host.ts literal not tied to WORKER_SEMI_SPACE_FLAG; 285 is a 300-turn figure — flag-only RSS grows ≈ 0.18 MB/turn, crosses 285 near turn 600 (report to owner at the end); scripted-provider summary branch lacks a mutation check; measure script counts failed compaction_end and doesn't fail on zero compactions; check-budgets hard-codes the test path; idle budget 10.4 % headroom on one host
Task 23: complete (commits bdbc916, 8f4158b; review clean)
Task 26: brief extracted; QUEUED until the Task 25 fix round finishes (one implementer per worktree)
Task 25: fix round 1 implementer DONE (commit e681fd0; unit 2408, int 272, smoke, budgets 147.4); placeholder row keeps toolCallId (daemon snapshot.ts); scoped re-review dispatched
Task 26: dispatched implementer (sonnet), BASE e681fd0 (T25 re-review reads diff files concurrently); carried: untrusted text clipped, approval vs extension visually distinct (R101), answered-once + re-arm + unknown-outcome retry with same commandId, hiddenDialogs line, Escape left to M3
Task 25: fix round 1/5 (Important + 5 minors addressed — resultEntryId contract/daemon/web, exact tests, async load try/catch, omitted result done + tooLarge, anchor release; commit e681fd0)
Task 25: minor (deferred to final): Transcript load catch doesn't release() the scroll anchor after a malformed page throws in prependHistory
Task 25: complete (commits 745a8bb..e681fd0, review clean after 1 fix round)
Task 26: implementer DONE_WITH_CONCERNS (commit ed43928; unit 2441, int 272, smoke, budgets 150.5/180) — unknown answer outcome keeps the card shut with "Send again" (same commandId), replacing M1's re-arm on connection_lost; approval bodies clipped at 200 lines / 4000 chars until "Show more"; TextField gains optional placeholder (packages/ui)
Task 26: Ruling: unknown-outcome "Send again" with the same commandId accepted (R124 exactly-once beats M1's re-arm)
Task 26: CARRY to merge: packages/ui TextField placeholder prop added on M2 — M3 restyled TextField; re-apply at the rebase if M3's TextField doesn't already forward placeholder
Task 26: task review dispatched (sonnet), diff e681fd0..ed43928
Task 27: dispatched implementer (sonnet), BASE ed43928 (T26 review runs read-only meanwhile; any T26 fix round waits for T27); carried: T15 web renderer rules (spans, SGR subset, per-line reset, bidi), panel paste bound, IME
Task 26: review APPROVED (0 Critical/Important, 8 minor); policy vs extension cards structurally distinct (alertdialog + tint vs group), R105 resend correct
Task 26: fix round 1 QUEUED until the Task 27 implementer finishes: expanded title/header/question max-h + scroll; no-answers fallback to deny; split Ctrl/Meta+Enter test; "Extension" label on extension cards (R101 residual, R2-8 style, fr/en); TextField placeholder test in packages/ui; error alert tied to its card and cleared on close; timeout line on approvals too
Task 26: minor (deferred to final): no UI test with 100 options or double "Send again" (safe by reading)
Task 27: implementer DONE_WITH_CONCERNS (commit d063bd2; unit 2513, int 272, smoke, budgets 153.9/180) — buttons sorted before text cells; malformed/private SGR ignored (not reset); Tab hint whenever the composer has focus with a panel open; paste chunked ≤ 4096 (surrogate-safe), > 64 KiB refused (panel.tooLong); focus falls to body when a focused panel closes
Task 27: task review dispatched (sonnet), diff ed43928..d063bd2; T26 fix round 1 dispatched (resume) — T27 fixes queue behind it
Task 26: fix round 1/5 dispatched (resume implementer) on top of d063bd2: max-h on expanded question/header/title, no-answers → Deny fallback, split Ctrl/Meta test, Extension label (R101 residual), TextField placeholder test, error alert per card, timeout line on approvals; FIX_BASE d063bd2
Task 27: review APPROVED with 1 Important (focus falls to body when a focused panel closes — the normal exit on Enter/Escape) + 11 minor; parser linear on 2M-char hostile inputs
Task 27: Ruling: focus returns to [data-composer] when a focused panel closes; keyboard-trap escape hatch (WCAG 2.1.2): Ctrl+] moves focus from the panel to the composer (never sent), with a visible hint; lone ESC stripped; CSI with intermediates is not SGR; paste cap counts units not chunks; in-flight guard on status buttons; IME (isComposing / keyCode 229) Enter not sent; panelInput state per CustomPanel instance (M3 panes may mount two sessions)
Task 27: fix round 1 QUEUED until the Task 26 fix round finishes
Task 26: fix round 1 implementer DONE (commit 9aac81e; unit 2522, int 272, budgets 154.1); scoped re-review dispatched; T27 fix round dispatched
Task 27: fix round 1/5 dispatched (resume implementer) on top of 9aac81e: focus return to composer, Ctrl+] escape hatch + hint, lone ESC, unit-based paste cap, CSI intermediates, status in-flight guard, IME Enter, per-instance panelInput; FIX_BASE 9aac81e
Task 26: fix round 1/5 re-review: items 2–7 ADDRESSED; item 1 partly — expanded question/header/title are focusable scroll areas without role/accessible name/FOCUS_RING (siblings have role=region + aria-labelledby)
Task 26: fix round 2 QUEUED after the Task 27 fix round: role="region" + accessible name (aria-labelledby or i18n label) + FOCUS_RING on the three expanded scroll areas, with a test
Task 27: fix round 1 implementer DONE (commit c9d1a54; unit 2531, int 272, budgets 154.3); scoped re-review dispatched; T26 round 2 dispatched (resume)
Task 27: fix round 1/5 (Important + 7 minors addressed — focus return, Ctrl+] exit + hint, lone ESC, unit paste cap, CSI intermediates, command guard, IME, per-screen panel input; commit c9d1a54)
Task 27: minor (deferred to final): Safari compositionend-before-Enter ordering (needs a real Safari check → browser e2e); heldFocus stays true when focus leaves to non-focusable space (harmless); no failure-path test for the command guard reset
Task 27: complete (commits d063bd2..c9d1a54, review clean after 1 fix round)
Task 26: fix round 2/5 (expanded scroll areas get role=region + aria-label/labelledby + FOCUS_RING; dialog.question/dialog.summary keys; commit 830b258; controller-verified small diff)
Task 26: complete (commits ed43928..830b258, review clean after 2 fix rounds)
Task 28a: dispatched implementer (sonnet), BASE 830b258; carried: rename/auto-name (17b), navigate/compact in-flight visibility + Stop reachable (24/17a), R105 messages, Edit-from-here vs seq/pending, rename Escape stopPropagation (M3 dispatcher), export anchor without HEAD/prefetch
Task 28a: implementer DONE_WITH_CONCERNS (commit 03df5c1; unit 2558, int 272, smoke, budgets) — row tests in MessageRow.actions.test.tsx; useNavigate added to 9 router mocks; injected.n guard unpinned; Edit from here leaves an unknown-outcome pending send untouched (documented + tested)
Task 28a: controller check: M3's dispatcher listens on window in the CAPTURE phase (dispatcher.ts:41) and its escape rule has no !editableFocus — stopPropagation in the rename field cannot stop it; Ruling: the rename field carries data-inline-edit now; CARRY to the M3 post-merge list (P7/P1): a context key inlineEditFocus ([data-inline-edit]) and "!inlineEditFocus" in the escape rule, with a test
Task 28a: task review dispatched (sonnet), diff 830b258..03df5c1
Task 28b: dispatched implementer (sonnet), BASE 03df5c1 (T28a review read-only meanwhile; any T28a fix waits); carried: coalesced branch refresh, revoke R105, truncated rules line, consistent in-flight/Stop with 28a
Task 28a: review NEEDS FIXES — 1 Important (Enter on the rename row's Cancel/Save buttons saves the rename: wrapper onKeyDown handles Enter for every descendant + preventDefault) + 9 minor; data-inline-edit absent
Task 28a: Ruling: export anchor appended to body, clicked, removed (detached-anchor clicks are unreliable on iOS Safari 16.4) + same-origin "/api/sessions/" check before the click; per-action error lines
Task 28a: fix round 1 QUEUED until the Task 28b implementer finishes: Enter only from the input, data-inline-edit on the rename field, anchor attach/click/remove + URL check, tests for the double-send ref guard / saveDraft failure / injected.n guard, restore URL.createObjectURL in tests, focus return after a rename save, per-action errors
Task 28b: implementer DONE_WITH_CONCERNS (commit 6c9cb1b; unit 2582, int 272, smoke, budgets 158.9/180) — no cwd in the view: SessionRules calls sessions.list once on first open to find the cwd; runtime-bed defaults for sessions.branches / policy.listRules; mutations run IN PLACE with backup/restore (rule breach; tree verified clean)
Task 28b: Ruling: sessions.list lookup accepted for M2; CARRY to final/M4: put cwd in the snapshot instead
Task 28b: task review dispatched (sonnet); Task 28a fix round 1 dispatched (resume) on top of 6c9cb1b
Task 28b: review NEEDS FIXES — 1 Important (SessionRules blank panel when the session is not in sessions.list, no loading text, no error; untested incl. a failing list) + 5 minor; stale-response logic sound, no refresh loop
Task 28b: fix round 1 QUEUED until the Task 28a fix round finishes: not-found error + loading text + tests (not found, list failure); stale branches error dropped when the view moved; useBranches only when rowActions; timeout test asserts the exact text; navigate cancelled:true shown (both 28a Edit and 28b switcher) — coordinate with 28a's fix
Task 28a: fix round 1 implementer DONE (commit 20f500b; unit 2593, int 272, budgets 159/180); data-inline-edit sits on the wrapper div (TextField takes no attributes) → M3 dispatcher must use closest("[data-inline-edit]"); scoped re-review dispatched; T28b fix round dispatched (resume)
Task 28a: fix round 1/5 (Important + 6 items addressed; commit 20f500b) — re-review follow-up: export URL check must compare the resolved pathname (../../x, %2e%2e, backslash pass today) → folded into the Task 28b fix round (addendum item 6)
Task 28a: complete (commits 03df5c1..20f500b + the URL-check follow-up in Task 28b's fix commit)
Task 28b: fix round 1/5 (Important + 4 minors + addendum: rules panel loading/not-found/error states, stale branch errors dropped, useBranches only with rowActions, exact timeout text, cancelled-navigation notice for switcher + Edit, resolved-path export check with leading "/" and no backslash; commit d65e0ac; controller-verified 128-line diff)
Task 28b: complete (commits 6c9cb1b..d65e0ac, review clean after 1 fix round)
Task 29: dispatched implementer (sonnet), BASE d65e0ac; carried: getElementById with per-screen id prefix, single load path, text-only previews, observer cleanup, reduced motion; reviewer Haiku (X2)
Task 29: implementer DONE (commit c537a37; unit 2616, int 272, smoke, budgets 160.3/180); rail rendered inside Transcript (owns the loader); no sighted hover preview (title forbidden, popover clipped) → M3 visual rework; task review dispatched (haiku per X2)
Task 30: controller generated docs/research/m2-rulings.md (M2R1–148 + 60 execution rulings E1–E60 + owner decision) for M2R148; dispatched implementer (sonnet), BASE c537a37 (T29 haiku review read-only meanwhile)
Task 29: review APPROVED (haiku; minors only: untested branches, aria-current comment overstates, no RED record for Transcript.minimap.test.tsx, browser-only layout/observer unverifiable)
Task 29: minor (deferred to final): see task-29-review.md
Task 29: complete (commit c537a37, review clean)
Task 30: implementer DONE_WITH_CONCERNS (commit 14a8878; unit 2616 ×2, int 272 ×2 after one flaky run (sessions.crash.oom "keeps the session when the scope's limit kills a command" timed out at 31 s right after build+smoke), build, budgets 160.3/180, smoke; 6/6 exit criteria met; AGENTS.md 33 lines; ADR 0009 line added)
Task 30: CARRY to the M2 final review: the OOM int flake (timeout bound vs host memory pressure); verify ADR 0009's error codes (the >32 MiB source answers capacity since T19 fix round 1)
Task 30: complete (commit 14a8878; docs reviewed by the final whole-branch review)
M2 final: whole-branch review dispatched (OPUS per X2)
M2 final: Opus whole-branch review — approve after I1; 0 Critical, 3 Important (I1 OOM flake root cause: hog inherits pi-host oom_score_adj 800 → worker sometimes chosen; I2 four semantic merge conflicts outside both tables; I3 Escape in extension dialogs / approval cards would stop the run after the merge), 10 Minor; gate green except one pre-existing main.int SIGTERM-window flake; trial merge with M3: int 291/291, smoke ok, bundle 191.0/200 (session chunk 5.2 → 23.6 KB lazy); deferred minors: 1 fix, 5 resolved, 14 carry, 29 accept
M2 final: Ruling: fix now I1, I3 (data-inline-edit on ExtensionCard + ApprovalDialog roots), M1 (announce after watchSignals), M2/M10 docs, M3 (LiveSession.notice for grants/reload notices), M7 (waiting read before the probe), M8 (PAP_WORKER_MEMORY_MAX_MB floor 1024); carry M4/M5/M6 → M4, M9 → M3 P4, I2 → M3 rebase checklist
M2 final: fix batch dispatched (fresh sonnet implementer)
M2 final: fix batch DONE (7 commits 14a8878..559637b; unit 2623 ×2, int 273 ×2, budgets 160.3, smoke; OOM 5/5 + main.int 5/5); scoped re-review dispatched (sonnet)
M2 final: re-review — all 7 items ADDRESSED, no regressions; 2 doc nits fixed by the controller (efcf821)
M2: COMPLETE and merge-ready at efcf821 (main = merge-base f765f2a, so the rebase is a no-op); owner asked for merge approval
M2: MERGED into main with --no-ff (owner approved 2026-10-12) — b718f9c
