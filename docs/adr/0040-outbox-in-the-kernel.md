# ADR 0040: the outbox in the kernel, replay classes and recovery first

Status: accepted (M10, Task 24)
Date: 2026-10-15
Spec: C §1.1, §6.2, §6.3. Rulings: M10R8 to M10R15, M10R148 to M10R150.

## Context

Spec C §6.2 asks for a SQLite outbox: an effect is written in the same transaction as the state change that implies it, one worker runs it, and a crash neither loses it nor runs a process-bound effect twice. Several modules enqueue (automation, runs, the housekeeping) and each needs its own transaction.

## Decision

- The table and the worker live in the kernel (`kernel/outbox/`), not behind a module's `index.ts`: `enqueueEffect(db, effect, now)` opens no transaction and is called with the caller's own `Db` inside the caller's transaction. A duplicate `dedupKey` writes nothing and answers null (the receipt of C §6.2). The worker is told after the commit (`outbox.poke()`).
- Kinds are one const table (`REPLAY`) with a deadline per kind (`DEADLINE_MS`) and a zod payload per kind (`EFFECT_PAYLOADS`), each `satisfies` an exhaustive record. M10's kinds: `task.start` (process-bound), `run.resume`, `feed.poll`, `attachment.cleanup` (replay-safe).
- Worker: at most two effects in flight and never two of one kind. The handler gets an `AbortSignal` that fires at its kind's deadline and at `stop()`. A row is settled only with its handler's own result, once the handler's promise has settled (no zombie); a handler that has not returned 15 s after the abort is logged (`outbox_handler_overdue`) and its row stays leased. Results: `done`, `defer(until)` (never an attempt, at least 1 s), `retry(code)` (attempt + 1, backoff 5 s doubling to 10 min, the fifth attempt fails), `fail(code)`.
- Two durable marks: the cancel mark (`cancelEffect` retires a pending row and flags a leased one; the handler reads `cancelRequested()` before its point of no return) and the sent mark (`markSent()` right before the step that must not run twice; from then on a crash retires the row and a `retry` or `defer` fails it with `defer_after_send`).
- Recovery runs first, inside `composeOutbox()`, before any module is built: leased process-bound rows, and leased replay-safe rows past their sent mark, are `retired`; other leased replay-safe rows return to `pending`, each counting an attempt (an effect that crashes the daemon cannot run at every boot: at the limit of 5 attempts the row is `failed` with `crash` and not run again; the recovery reports it as `failed` and logs it in `outbox_recovered`). A kind this binary has no handler for stays pending and is counted once at boot (`outbox_unknown_kinds`).
- Rows have owners (`owner_id`, NULL for a system effect such as `attachment.cleanup`): `failures(ownerId)` and `dismiss(ownerId, id)` see the owner's rows and the system's, never another owner's.
- `task.start` is admitted round-robin by trigger (oldest last start first, across eligible owners), so one noisy trigger cannot starve the others; a capacity refusal is a deferral (30 s), which is not an attempt.
- Failed rows stay until their owner dismisses them, then 7 days; done and retired rows go 7 days after they settle.
- In read-only mode (a database written by a newer pap) there is no recovery, no worker and no housekeeping. Every M10 timer callback runs through `guardTimer`.

## Consequences

- Deviation from C §6.2: `run.abort` is not an effect. Cancel commits the task move and the resume cancel in one transaction, then aborts directly through the port; a crash between the two leaves no worker, because the boot kills every worker. An effect would wait behind other handlers while the run keeps spending.
- Deviation: M9's lane effects (`lane.setup`, `checkpoint.capture`, `worktree.cleanup`) stay in M9's own rows until an M11 follow-up (agreement 15). Their kinds are not in `REPLAY`; a row of such a kind in this outbox would stay pending.
- Two handlers at most means a slow `feed.poll` and a `task.start` can overlap, never two `task.start`.
- A handler that ignores its signal blocks its kind until it returns; the overdue log line is the only symptom.
- Tests that need a kind without a handler cannot use a M10 kind any more (`attachment.cleanup` is registered by `compose-runs.ts`); they seed M9's `lane.setup` as a raw row.
