# ADR 0035 — Lane effects are kept in their own rows until the outbox exists

Status: accepted · Date: 2026-10-14 · Spec: C §6.2 (effect outbox) · Rulings: M9R17-M9R20, M9R41, M9R116, agreement 15

## Context

Spec C §6.2 lists `lane.setup`, `checkpoint.capture` and `worktree.cleanup` as effects of the outbox: a table where an intent is written before the side effect and replayed after a crash by its class (replay-safe, at-most-once, needs a check). M10 builds the outbox in the same wave as M9. M9 cannot wait for it and cannot depend on a table that does not exist yet.

## Decision

- M9 stores each effect's intent in the row of the thing it changes, with the same replay classes, and recovers them first at boot, before the server listens (skipped on a read-only database):
  - `worktree.cleanup`: the `worktrees` row state (`creating`, `ready`, `removing`). Replay is safe: the undo and the removal are idempotent. Class: replay-safe.
  - `lane.setup`: the lane's `setup_state` plus the script's process group and `<boot id>:<start time>`. A running script found at boot is killed if the tag still matches, then marked `interrupted` and never re-run on its own (the owner clicks "Run setup"). Class: at-most-once.
  - `checkpoint.capture`: a ref is written last, so a crash leaves at most a temporary index file in `$PAP_HOME/tmp/git-index/`. No boot sweep removes it; it is harmless (a residual in `lanes.md`). Class: replay-safe (the next capture replaces it).
  - Archive resumes from the worker release (step 5); the archive script is not re-run.
- The recovery order is fixed: script orphans first (killed, never re-run), then worktrees (`recover`), then lanes. A stuck `git` cannot keep the daemon from listening: worktree recovery, the step that runs `git worktree`, is bounded to 60 s.

## Consequences

- No M9 code reads or writes the outbox. When it lands, the M11 follow-up (agreement 15) moves these three effects into outbox rows and deletes the per-row recovery. Until then the three rows above are the source of truth.
- A new effect type in M10 does not touch M9's tables.
- Replay classes are pinned by tests (`recover.test.ts`, `archive.recover.int.test.ts`); keep them when moving.
