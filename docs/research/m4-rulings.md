# M4 implementation rulings

Decisions taken while executing [the M4 plan](../plans/2026-10-12-m4-projects-search.md) (2026-10-12 → 2026-10-13). The plan's pre-dispatch rulings M4R1–M4R143 live in the plan itself; the rulings below were taken during execution, each written as *what — why — cost if wrong*. The full run is in [m4-sdd-ledger.md](m4-sdd-ledger.md); the final review in [m4-final-review.md](m4-final-review.md).

Owner decisions taken during execution:
- 2026-10-12: Opus implementer allowed for fix rounds 4–5 (E1); not needed in M4.
- 2026-10-12: workflow lightening — the controller re-verifies small test/comment-only fixes; `test:int` only for runtime tasks; Task 27 on Sonnet instead of Haiku.
- 2026-10-12 ≈19:45: overnight autonomy; M4 merges first once M5's tasks are done (X1), then M5.

## Rulings

- Ruling: pre-flight relies on the red-team's plan-internal pass instead of a fresh controller read of 8 100 lines — the plan is fresh from an Opus fix with a self-check — if wrong, a conflict surfaces in a task review and costs one fix round.
- Ruling: RT-01 residual accepted as written in M4R60 (a draft that crashed after Pi wrote its file and is prompted again before the scanner's first pass has its first file adopted under the instance owner) — narrow window, single-owner v1 — if wrong, a second user's crashed draft lands in the owner's sidebar; flag it to the final review.
- Ruling: RT-07/08/26/04 applied in the fixer's variants (oldest dialog always admitted; runtime corruption detection, ≤ 3 rebuilds/h; no folder-mtime skip, per-pass comparison cap; scanner off in read-only mode) — each keeps the finding's intent with less breakage — if wrong, one fix round in tasks 2 / 16b / 15–16 / 16b.
- Task 1: Ruling: the brief's acceptance grep is binding; the edit list missed dialogs.test.ts and snapshot.test.ts — fix them (import sizeOf from kernel/json-bytes.ts) — cost if wrong: none, two test imports
- Task 2: Ruling: accept the changed expectation — the brief's l.108 misdescribes the existing case (it has a third 100-byte dialog); M4R8 ("non-approval dialogs together within 256 KiB"), the prescribed loop (oldest counted in otherDialogs) and the new "three 100k keep two" test all count the oldest, so d3 is hidden behind a 600k oldest and waits its turn (RT-07 intent) — cost if wrong: a small extension dialog behind a huge one shows only after the huge one is answered
- Task 8a: Ruling: the cap belongs in the fitter (bounded-resource rule; contract schema rejects > 550) — cost if wrong: none, one guard
- Task 8b: Ruling: accept list()/listFitted() deviation (wire result equivalent) with a doc comment that list is unbounded and internal — cost if wrong: a future handler calls list unfitted (comment + review catch it)
- Task 10: Ruling: stamp unsettledAt on activity and wake — M4R41/M4R64 beat the brief's organiser code — cost if wrong: none
- Task 12a: Ruling: cooperative deadline via a db.function check in RANK's WHERE (aborts the statement; FTS5's first match-list load stays unbounded, noted) + stop() bounded by a Clock deadline with a log — M4R50's "cost if wrong: none" was wrong — cost if wrong: a very slow FTS5 match-list load still holds a core until it ends (bounded by the spawn cap)
- Task 12a: Ruling: RANK uses FROM rows_fts CROSS JOIN rows r (FTS outer loop; measured 20k 24 ms, 1M 1.3 s) with an EXPLAIN QUERY PLAN test; thread budget = QUERY_TIMEOUT_MS − 250 so the thread's own timeout keeps the thread — cost if wrong: none (verified by probe)
- Task 12b: Ruling: keep the shared "timeout" message (one fixed text per code, R66); the ⌘K search UI maps timeout / capacity to its own copy by code — cost if wrong: one i18n line in Task 25
- Task 12b: Ruling: read-only covers search.db — no open/rebuild when readOnly, one log line, search.query answers { hits: [] } — cost if wrong: search unavailable on an older daemon over a newer home (expected)
- Task 13: Ruling: guard non-object blocks (M4R59: Pi files untrusted, nothing throws out) — cost if wrong: none
- Task 14: Ruling: fix now with one transaction (insert + project + onAdopted) and a throwing-hook test, rather than leaving it to the M5 merge — cost if wrong: none
- Task 14: Ruling: claim answers wait (rate-limited session_claim_failed) for failures before the insert — total contract; post-insert failures roll back via the transaction — cost if wrong: a stuck file retried each pass (logged)
- Task 14: Ruling: accept the catch around the transaction — a post-insert failure is rolled back first, so answering wait (rate-limited session_claim_failed) and retrying next pass is safe; the original concern was a committed row, which the transaction removes — cost if wrong: a persistent hook failure shows as one log line a minute instead of a thrown error
- Task 15: Ruling: activity only for incremental reads from a stored, non-reset cursor (M4R41 "new entries") — changes the brief's test 1 — cost if wrong: a CLI append right after a rebuild does not wake its session until the next append
- Task 15: Ruling: forget cursor/rows only on ENOENT/ELOOP/ENOTDIR/not_file (keep on transient EACCES/EMFILE/EIO); ELOOP/not_file/not_pi_file stay silent (prescribed) — cost if wrong: stale rows of a file made unreadable stay searchable until it reappears
- Task 16b: Ruling: keep the 12b read-only behaviour (search.db not opened, search answers no hits, scanner off) over the brief's "populated index still answers" — an older daemon on a newer home is a rollback edge case and opening a newer search.db risks a version-mismatch rebuild — cost if wrong: no search while running an older daemon on a newer home
- Task 17: Ruling: the 10 000-session measurement moves to a dedicated `pnpm test:budget` (run at Task 28, final gates); default test:int keeps a ~300-session plumbing case — saves ~80 s and ~400 MB per later test:int and removes contention risk — cost if wrong: a budget regression is caught at Task 28 instead of per task
- Task 17: Ruling: the "1 M per-file cap not lowered" decision waits for the preview's search_index_size boot line (M4R128), not this synthetic corpus
- Task 20: Ruling: bundle above 197 → Task 27 (strings lever) runs next, before 21 (M4R plan rule / owner Q10); the reviewer explains the +4 KB — cost if wrong: none (order change only)
- Task 20: Ruling: trim 1 — a tiny eager view-labels store fed by the lazy session store (target ≈ 196.4 KB) — before Task 27 — cost if wrong: none
- Task 20: Ruling: accept the eslint web-routes → web-stores allow-list line (web-stores is a leaf; the brief needs routes/shell to read useShellStore) — note for the M5 merge (plan listed eslint.config.js as "none")
- Task 20: Ruling: bundle back under 197 → keep the plan order (Task 21 next, Task 27 in its place) — revises the earlier "27 next" ruling — cost if wrong: none
- Task 22b: Ruling: lazy projects features take the palette chord as a prop (usePaletteChord in routes/shell/shortcut.ts) — boundaries forbid features/projects → features/commands; Task 25 follows the same pattern — cost if wrong: one prop
- Task 23: Ruling: bundle above 197 → Task 27 runs right after Task 23 (before 24) — plan rule — cost if wrong: none
- Task 23: Ruling: fix the bundle with a Rolldown codeSplitting group tagged $initial (node_modules|packages/) in Task 23's fix round, own build(web) commit; Task 27 goes back to plan order (after 26b) once the bundle is under 197 — supersedes "27 right after 23" — why: no new eager module, glue only; one config line recovers 4.1 KB — cost if wrong: one config line to revert, budgets catch any regression
- Task 24: Ruling: bound the @pap/ui Menu content height now (max-h-app overflow-y-auto, existing token, own fix(ui) commit) — outside the task's file list but a one-line primitive fix; the plan bounded the list at 500 without a scroll — cost if wrong: none
- Task 25: Ruling: minimum search length 3 code points (owner Q6 "min prefix 3" and the daemon's prefix minimum beat M4R106's 2) — cost if wrong: one constant
- Ruling: M4 final fix dispatch covers I1 (prefix rule on tokenizer output + docs), I2 (fresh snapshot on subscribe after an outside write) and all 9 minors; minor 7 (M4R60 becomes cross-user once M5 adds users) is fixed now inside M4's own unmerged migration (no new stamp) — cost if wrong: one extra table
- Ruling: fix two residual nits before merge (a 50 ms sleep in the reopen test breaks the no-sleep rule; index on session_pending_ids(session_id)) — logging codes for non-SQLite open errors deferred — cost if wrong: none
