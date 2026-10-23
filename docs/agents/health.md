# Health (the daemon's failure console)

Code: `apps/daemon/src/modules/health/` (the bus, the buffer, the `ops` stream, the RPC), contracts `packages/contracts/src/health.ts` and `health-methods.ts`, the web side in `apps/web/src/features/health/` and the Health section of Settings. Decisions: the health-events spec, `docs/specs/2026-10-23-health-events.md`.

## What it is

- A live console of the failures the daemon already logs, for the current daemon run. It is not a history: the buffer lives in memory and a restart empties it. Events older than the restart stay in `trace.jsonl` over SSH, exactly as before — the screen's empty state after a restart is correct, not a bug.
- The screen sits in Settings, next to the other owner-facing surfaces, and shows one row per event, newest first, with per-code copy from the web i18n catalog.

## Event shape and the code table

- A health event carries `seq`, `ts`, `kind` (`feed` | `sched` | `task` | `outbox` | `agent`), `severity` (`err` | `att` | `mut`), `code`, `sourceRef` and `count`. The severity is a property of the code, never chosen at the emission site.
- The code table is closed: `HEALTH_TABLE` in `packages/contracts/src/health.ts` is the one list of kinds and codes, with each code's severity. Do not duplicate its rows here; the table rejects any code it does not know (`health_unknown_code`, logged, never buffered).
- `sourceRef` points at what failed: a trigger (id and name), a task, an agent, or an outbox effect (row id). Names are data the owner's browser already receives elsewhere; nothing new is exposed.

## The buffer

- In memory only: 500 events per daemon, newest first on read, no database table, no file, never in a backup payload. Past 500 the oldest row is dropped, so a storm cannot grow the footprint.
- Collapse: a new event whose kind, code and sourceRef match the existing row for the same identity bumps that row's `count` and moves its `ts` (the fire-journal shape), and the `ops` stream tells clients a collapse happened. One row per identity is the newest occurrence of that identity.
- Restart resets: the buffer empties and `seq` starts at 1 again, so `seq` is only meaningful within one daemon run.

## Permission and routing

- Both RPC methods, `ops.events.list` (a page, `before` cursor) and `subscribe.ops` (the stream: a snapshot when the screen opens, then one event or collapse at a time), hold `pi:admin` — browser sessions only, the models/MCP precedent. A token never lists or subscribes; the daemon's failure surface is not for it.
- Routing is per owner: every event is buffered under the owner whose trigger, task or agent failed, and both methods see only that owner's rows. A system effect has no owner to page, so outbox failures without one are log-only in v1.

## What stays out

- Raw logs: the screen shows failures, not output; `trace.jsonl` over SSH stays the way to read logs.
- System-owned outbox failures and `outbox_unknown_kinds`: log-only in v1 (no owner to route them to).
- No notifications and no acknowledge: the console is a read surface; pushes belong to the owner's own automation.

## The emission rule

- Only where the daemon already logs a failure: `feed-poll.ts` and `feed-fetch.ts` results, the scheduler's failed tick and missed fires, the precheck's `error`, the runner's task failures, the outbox's handler failures and overdue handlers, and the agents module (`vm_bundle_stale`, `sandbox_unavailable`, `agent_paused`, `capacity`, `agent_crash_paused`). A new failure site needs its code in the table first; without a row there, the emission is refused, so the screen can only show failures the daemon already reports as log lines.
