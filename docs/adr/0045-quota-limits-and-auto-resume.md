# ADR 0045: quota limits and auto-resume

Status: accepted (M10, Task 24)
Date: 2026-10-15
Spec: C §6.4. Rulings: M10R103 to M10R108, M10R137, M10R160, controller J2 rulings.

## Context

A provider stops a run with a quota or rate-limit error and names a reset time in its text. The owner wants the session to continue by itself after the reset, without a continuation ever racing new input or spending past the budget.

## Decision

- Classification (`runs/limits.ts`, pure): a run whose last `stopReason` is `error` is `limited` when its error text (cut to 2 KiB) matches Pi's non-retryable limit words (`usage limit`, `insufficient_quota`, `quota exceeded` and the list in M10R103) or a final `rate limit`. The reset time is read from the provider's text and stored with the run (`limit_reset_at`).
- With `autoResume` on and a reset time, one `run.resume` effect (replay-safe, receipt `resume:<session>:<run>:<resetAt>`) is written with the run's end, due at the reset plus 0 to 60 s of jitter derived from the session id. Never for a session in `full-access`.
- The handler checks, in this order, with no `await` before the sent mark: not cancelled; the session exists, is the owner's and its latest run is still `limited`; auto-resume re-read (off: the effect is done and the task stays `limited`); automation paused (defer 5 min, so a paused owner's resume waits whatever the budget says); then the skips, each reported through `onResumeSkipped`: archived, `newer_input` (a run started since, or one is sending), `full_access` now, the owner's daily budget (`spentToday`, live included) and the task's trigger budget; then an owner prompt or reopen in flight (defer 30 s, before the sent mark); the free-memory floor and worker reserve as at launch (defer 5 min); a free slot in the origin table (defer). A task whose resume is skipped moves to `failed budget` or `cancelled archived`.
- Marks: the handler calls `markSent()` right before sending "Continue where you left off.". A crash before it requeues the row; after it, the row is retired. The receipt refuses a second send.
- "Resume now" (`usage.resumeNow`) sends inline in every state. The owner's browser click runs under the owner's interactive origin (`user`), so it is not automation spend and the automation budget never aborts it. A token's call runs under origin `resume` (counted, and abortable by the budget) and is also budget-gated (`budget_reached`) and pause-gated (`automation_paused`). A continuation that starts no run (`handled`) clears its expected origin and reports the resume skipped, which also disarms a Cancel's one-shot abort. `usage.cancelResume` retires a pending row or marks a leased one. On a task, Cancel retires the pending resume in the same transaction.
- Cancel wins over a resume that is already sending: the sent mark is read, and `abort-next.ts` arms a one-shot abort of the continuation's first run start (60 s expiry, disarmed when the continuation settles without a run start).
- With auto-resume off a limited task stays `limited` with "Cancel task" and "Resume now".
- The `usage` stream (`limits[]`, `todayUsd`, `budgetUsd`, `autoResume`; events `limit`, `limit_cleared`, `spend`) feeds the session header's limit chip; a cold session reads `settled`, never `limited`.

## Consequences

- A task resumed after a reset gets a fresh per-run cost cap and deadline; the daily budget bounds the total.
- Residuals: a cold reopen races a new owner prompt only for label and budget attribution; M9's `beforePrompt` waiting set is part of `promptPending` since M10 was rebased on M9 (`sessions/automation-port.ts`).
- Two chips can show on a limited session (board card and header), by design.
