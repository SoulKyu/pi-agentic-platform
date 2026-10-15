# M10 final fix round: scoped re-review (Opus)

**Range:** `db35c37..2fd94ca`, 9 commits (`a43723c` … `2fd94ca`), 28 files, +410/−47.

**Read:** the ledger rulings ("Rulings (ONE final fix dispatch)" and "Merge strategy ruling (R6)"), `final-fix-report.md`, the production diff in full and the new tests.

**Read-only:** nothing in the worktree was changed.

**Runs** (the int suite was left to the controller):
- My two probes from the final review, with their assertions turned to the fixed behaviour: 7/7 pass. They are in the session scratchpad `probe/`, with a new case: tabs and line feeds are kept, CR and C1 are dropped.
- One targeted unit run of the 14 files the round touched or depends on: 189/189 pass.
  - `compose-join2`, `recover`, `scrub`, `manual`, `prompt`, `rpc.tasks`, `triggers.views`;
  - `resume.origin`, `resume*`, `service`;
  - `runner.boot`, `worker`.
- A SQLite benchmark of `spentSince` against the real `runs` migration (`scratchpad/bench/bench.mjs`), for I3 below.

## Item by item

| Item | Status | Evidence |
|---|---|---|
| I1 `taskOf` only while `limited` or `running` | ✅ | `automation/index.ts:256-262`. Probe: `taskOf` is null for a `done` task. The owner's later quota resume is sent, not skipped for the old trigger's budget, and recorded `{origin: "resume", task_id: null}`. The J3 path still resolves the task, because the task is `limited` there (`compose-join2.test.ts` cases). |
| I2 `fence()` strips at the choke point | ✅ | `prompt.ts:12-21`: `[\u0000-\u0008\u000B-\u001F\u007F-\u009F]\|\p{Cf}`, keeping tab and LF. Probe: `{{precheck}}` and a manual or token payload lose their tag characters and RLO; `a\tb\r\nc\u0085d` becomes `a\tb\ncd`. Covers the webhook, alert, feed, precheck, manual and dry-run renders. Retry reuses the stored, already stripped prompt. |
| T17 m5: expected origin cleared when no run starts | ✅ | `resume.ts:110-112`: a `handled` disposition clears it, a throw already did, and `queued` keeps it (its run starts later). `resume.origin.test.ts` cases 1–2. |
| Token `usage.resumeNow` runs under origin `resume` | ✅ | `resume.ts:227-238`: tagged before the cancel; cleared on the sent-conflict path (`:243-246`) and on a send failure (`send` catch); a full expectation table answers `capacity` and sends nothing. The browser click stays `user`. Tests: `resume.origin.test.ts` cases 3–6. |
| T3 m6: `pwh_` added to `scrubKnownSecrets` | ✅ | `audit/scrub.ts:7` and the test; ADR 0022 updated. |
| T3 m7: a token sees no feed query or userinfo | ✅ | `trigger-summaries.ts:13-21` and `triggers.ts:155-158` (token views only). The result still satisfies `FeedUrl` (https, host, path). No other token surface carries the URL: the board summaries have no config, the dry-run does not echo it, and the logs never print the path. |
| T12 M1: finished runs counted by `ended_at` | ✅ semantics, ⚠️ performance (I3) | `runs/store.ts:242`. The definition is right. While open, a run counts in full through the live sum, whatever its start. Once it ends it counts in full on the day it ends (`service.test.ts` crossing case). Today's total never goes down when a run ends. |
| T2 m4: recovery counts an attempt | ✅ (see Minor 1) | `outbox/store.ts:103-120`. The order is right: process-bound or sent → `retired`; replay-safe at the limit → `failed` / `crash`; the rest → `pending` with attempt + 1. It agrees with `settleEffect`, which counts on settlement, so there is no double count. It stays inside the `attempts BETWEEN 0 AND 5` CHECK, because a leased row is at 4 at most. `recover.test.ts` crash-loop case. |
| T5a m15: a token Retry needs an enabled trigger and uses the current policy | ✅ (see Minor 2) | `retry.ts:30,42,47` and `rpc.ts:44-45`. A disabled trigger gets the `disabled` verdict, which falls through to `conflict` (a journal line is written). A deleted trigger already gave `conflict`. `policy: null` means the trigger's current tools, mode and env (`fire.ts:133-138`). `rpc.tasks.test.ts` covers both. The boot retry and the owner's retry are unchanged. |
| Docs | ✅ | `automation.md`, `finops.md`, ADRs 0022/0040/0045 and `m10-rulings.md` (M10R41, M10R106) match the code. |

### The four points the coordinator asked about

- **T12 M1 definition.** The code, the doc (`finops.md`) and the test agree: "counted in full on the day it ends". The one drawback is the cost of the query, I3 below.
- **`recoverOutbox` counts the attempt-limited rows under `retired`.** The rows themselves are right: status `failed`, `last_error = 'crash'`, `settled_at` set, so they show on the owner's failures banner (as the raw code `crash`) and can be dismissed. Only the returned count, and so the `outbox_recovered {retired, requeued}` log line, mixes "retired" with "failed for good". Minor 1.
- **A token Retry on a disabled trigger answers `conflict`.** Confirmed, together with the trigger's current policy. Minor 2 notes that the caps still come from the old task.
- **The `ResumeSessions.prompt` dispositions do not break the synchronous section.** `handle()` is unchanged up to `send()`, and `sending.add` is still the first statement of `send` (`resume.ts:106-107`). In `resumeNow`, the new token tag is a synchronous `expectOrigin` placed before `outbox.cancel`, with no `await` before `send`. The disposition is only read after the `await` of the prompt, where nothing depends on ordering.

## Issues

### Critical

None.

### Important

#### I3. Counting by `ended_at` turned the budget query into a scan of all the owner's runs, and it runs on every assistant message

- **Where:** `runs/store.ts:242`, `owner_id = $ownerId AND status <> 'running' AND ended_at >= $since`. The only usable index is `runs_owner_started (owner_id, started_at)`, and there is no index on `ended_at` (`202610142010_runs.sql`).
- **What:** `EXPLAIN QUERY PLAN` went from `SEARCH … USING INDEX runs_owner_started (owner_id=? AND started_at>?)` to `(owner_id=?)`, a full scan of the owner's runs.
- **Measured** on the real migration (one owner, a year of runs):

  | Runs | `started_at` query | `ended_at` query |
  |---|---|---|
  | 100 000 | 0.03 ms | 26 ms |
  | 300 000 | 0.09 ms | 75 ms |

- **Why it matters:**
  - `limits.ts:105` calls `gates.ownerOver` → `spentToday` → `spentSince` synchronously on every `onLiveCost` event of every session, the owner's interactive ones included, so on each assistant message.
  - When the owner line is not crossed, it also calls `triggerOver` → `spentTodayOf` (the same scan) once per running trigger.
  - `runs` is kept without limit (ADR 0043). One 5-minute schedule alone writes about 105 000 rows a year.
  - The event-loop cost therefore grows without bound on the hot path. It was introduced by this round; the old query used the index.
- **Fix:** one clause keeps the index usable and the new meaning. Add `AND started_at >= $since - 172800000`, a bound no real run reaches: a task runs 4 h at most, and the gates already use a 48 h window. Alternatively, add an `(owner_id, ended_at)` index in a migration. Also add a test that pins the query plan, or a large-table bound.

### Minor

1. **The recovery count calls a failure "retired".** `recoverOutbox` returns `retired + exhausted` (`outbox/store.ts:120`). An SRE who reads `outbox_recovered {retired: 1}` cannot tell that an effect was given up after five crash boots. Return a third field (`failed`), log it, and update ADR 0040's "counts it among `retired`".
2. **A token Retry still takes the old task's caps.** `maxRunMs`, `maxRunUsd` and `retryOnInterrupt` come from the snapshot (`retry.ts:48-50`). If the owner has since set a `maxRunUsd` cap of $1, a token's retry of an older uncapped task (`null`) runs uncapped. The ruling named only tools and mode, but its point ("never widened") covers the caps too. For a token, take them from the trigger's current execution as well.
3. **A `handled` continuation emits no skip.** `send()` clears the expected origin (`resume.ts:110-112`) but does not call `runs.resumeSkipped`. If a task's Cancel had armed `abort-next` against that continuation, the one-shot stays armed for up to 60 s. An owner prompt in that window would be aborted: the J2 I1-a class, now through `handled`. It is narrow, because it needs an extension that handles "Continue where you left off.". Call `runs.resumeSkipped(sessionId, "handled")` with the clear.
4. **The proof claim in `finops.md` is still inexact.** Line 30 credits `automation-tokens.int.test.ts` with "token … `usage.resumeNow` counted", but that file proves only the gate. The "counted" proof is the new unit file `resume.origin.test.ts`. Point the line there.
5. **The token's resume is still checked against the owner line only at the start** (the J3 m3 remainder). The trigger line now stops it at its first cost event (the run carries the task, `resume.ts:232-233`), so the exposure is one assistant message. Acceptable; say so in M10R106.
6. **Spending view and budget disagree on runs that cross midnight.** `usage.summary` totals still filter on `started_at` (`runs/store.ts:270-286`), while the budget uses `ended_at`. Settings › Spending "today" and the board's `todayUsd` (`spentToday`) can therefore differ for such a run. Align them, or note it in `finops.md`.

## Assessment

**Verdict:** Needs fixes.

**Reasoning:** I1, I2 and the seven un-parked items are each addressed, tested with a mutation, and consistent with the rulings. The synchronous section of the resume is intact, and both probes now show the fixed behaviour. One new Important finding comes from the T12 M1 change: the budget query lost its index and is now a full scan of the owner's runs. That scan runs on every assistant message and grows without bound. A one-clause fix restores the index range scan without changing the new definition. The Minors can ride along or wait.
