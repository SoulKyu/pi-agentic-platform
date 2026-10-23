# Health screen: the daemon's failure console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live **Health** section in Settings that shows the daemon's typed failure events (`{ts, kind, severity, code, sourceRef, count}`) from an in-memory ring buffer, streamed over `subscribe.ops` and paged by `ops.events.list`, both `pi:admin`.

**Architecture:** A new daemon module `apps/daemon/src/modules/health/` owns a 500-entry circular buffer (collapse rule of the fire journal, newest-first, per-owner reads). Automation, the agents module and the kernel outbox emit through an injected `HealthEvents` port at the exact places they already log failures — no new detection. The web gets a Settings section with kind/severity/text filters (persisted in `localStorage`) fed by a `ops` stream subscription and `ops.events.list` paging.

**Tech Stack:** TypeScript (erasable syntax), Node 24, zod, vitest, React, zustand, `@pap/ui` primitives.

**Spec:** `docs/specs/2026-10-23-health-events.md` (validated 2026-10-23). All open questions resolved: dedicated `subscribe.ops` channel gated `pi:admin`; system-owned outbox failures stay log-only in v1; severity table as written (`missed`=`att`, `outbox_unknown_kinds`=`mut`, agent launch refusals=`att`); EmptyState primary action "Open the tasks board"; only the last-occurrence `ts` is stored. Plan rulings on what the spec left open: page default 50 (spec's proposal); `outbox_unknown_kinds` is a boot anomaly with no owner, so it stays log-only in v1 (the code stays in the closed table for a future owner-facing surface); `task_event_failed` and `task_session_discard_failed` log lines are not in the spec's code table and stay log-only.

## Global Constraints

- 400 lines per file at most, no exceptions. Files already near the cap: `apps/daemon/src/daemon.ts` 395, `packages/contracts/src/methods.ts` 390, `apps/daemon/src/kernel/outbox/worker.ts` 376, `apps/daemon/src/modules/automation/index.ts` 395 (not touched), `apps/daemon/src/modules/automation/runner.ts` 382. Budgets per file are in the table at the end; `daemon.ts` must end at ≤ 397 (only 2 added lines — the health module is created inside `compose-automation.ts`, which already builds the outbox).
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`. Cross-module tests import the other module's `index.ts` too.
- Every RPC method declares a permission in `packages/contracts/src/methods.ts` (here via `health-methods.ts` spread into the catalogue): both methods are `pi:admin`.
- RPC handlers decode, call one service method, map typed errors. Nothing else.
- Erasable TypeScript only: no enum, no namespace, no parameter properties; relative imports keep their `.ts` extension.
- UI uses tokens from `packages/ui/src/tokens.css`: no raw colours, no `[…]` arbitrary values, no restyling of `@pap/ui` primitives. Colour is never the only carrier (the severity chip's word `ERR`/`ATT`/`MUT` carries it).
- Tests never touch `~/.pi/agent` or `~/.pap`; timers go through the kernel `Clock` (the buffer's `ts` comes from `clock.now()`); no sleeps.
- The only ESLint directive accepted is `eslint-disable-next-line <rule> -- <reason>`.
- i18n through the catalog layer, no string concatenation around variables (`t("health.count", { n })`, `plural`).
- Conventional Commits, no AI attribution.
- Gate after every task (never full suites, never the `kata` project): `pnpm exec eslint --max-warnings=0 <changed files>`, `pnpm format:check`, `pnpm typecheck`, `pnpm knip`, `pnpm vitest run --project unit <changed .ts/.tsx test files>`.

## Review Focus

1. A storm of distinct identities cannot grow memory past the cap: the 501st insert drops the oldest row, and the dropped identity's next occurrence starts a fresh row — Task 2, `buffer.test.ts` "the 500 cap drops the oldest and a re-fire inserts a new row".
2. A throwing emission never breaks the move that caused the event (the feed poll still settles `done`/`retry`) — Task 2 `events.test.ts` "a listener that throws is logged and skipped" + Task 3 `health-emission.int.test.ts`.
3. An owner never reads or receives another owner's events, and a token never reaches either method — Task 2 `buffer.test.ts` "another owner's page never sees the event", Task 4 `stream.test.ts` "nothing is published to another owner", Task 1 permission test.
4. An unknown code (a future daemon emission) is skipped and logged, never reaches a client, and a known code with the wrong severity fails the contract — Task 1 `health.test.ts` refine test, Task 2 `buffer.test.ts` "an unknown code is skipped".
5. Turning the last severity filter off would leave nothing shown; it is prevented, and corrupted `localStorage` falls back to the defaults — Task 6 `health-filters.test.ts`.

---

### Task 1: contracts — `HealthEvent`, the code table, `ops` stream, both methods

**Files:**
- Create: `packages/contracts/src/health.ts`, `packages/contracts/src/health-methods.ts`, `packages/contracts/src/health.test.ts`.
- Modify: `packages/contracts/src/streams.ts` (add `"ops"` to `STREAMS`), `packages/contracts/src/methods.ts` (+2: import and `...healthMethods,` spread), `packages/contracts/src/index.ts` (+2: `export * from "./health.ts"; export * from "./health-methods.ts";`).

**Interfaces (Produces):**
- `HealthKind`, `HealthSeverity`, `HealthSource`, `HealthEvent` (zod + type), `OpsStreamEvent`, `HEALTH_TABLE`, `healthSeverityOf(kind, code): HealthSeverity | null`, `HEALTH_LIMITS = { buffer: 500, pageDefault: 50, pageMax: 200 }`.
- Methods `ops.events.list` (params `{ before?: number; limit?: number }` → `{ events: HealthEvent[]; hasMore: boolean }`, `errors: []`) and `subscribe.ops` (params `{ after?: Cursor }` → `{ sub: string }`, `errors: ["capacity"]`), both `permission: "pi:admin", idempotent: true`.

- [ ] **Step 1: failing tests** — `packages/contracts/src/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { methods } from "./methods.ts";
import { HEALTH_TABLE, healthSeverityOf, HealthEvent, OpsStreamEvent } from "./health.ts";

describe("the health contract", () => {
  it("declares both methods pi:admin and idempotent", () => {
    expect(methods["ops.events.list"]).toMatchObject({ permission: "pi:admin", idempotent: true });
    expect(methods["subscribe.ops"]).toMatchObject({ permission: "pi:admin", idempotent: true });
  });
  it("accepts every table code with its severity; feed_status_<n> matches, unknowns do not", () => {
    for (const row of HEALTH_TABLE) expect(healthSeverityOf(row.kind, row.code)).toBe(row.severity);
    expect(healthSeverityOf("feed", "feed_status_503")).toBe("err");
    expect(healthSeverityOf("feed", "feed_status_2x")).toBeNull();
    expect(healthSeverityOf("task", "nope")).toBeNull();
  });
  it("rejects an event whose severity contradicts the table", () => {
    const base = { seq: 1, ts: 0, kind: "sched", code: "missed", sourceRef: null, count: 1 };
    expect(HealthEvent.safeParse({ ...base, severity: "att" }).success).toBe(true);
    expect(HealthEvent.safeParse({ ...base, severity: "err" }).success).toBe(false);
  });
  it("parses a snapshot, an event and a collapse", () => {
    const event = { seq: 1, ts: 0, kind: "feed", severity: "err", code: "not_a_feed",
      sourceRef: { kind: "trigger", id: "t1", name: "k8s blog" }, count: 2 };
    expect(OpsStreamEvent.safeParse({ kind: "snapshot", events: [event], hasMore: false }).success).toBe(true);
    expect(OpsStreamEvent.safeParse({ kind: "event", event }).success).toBe(true);
    expect(OpsStreamEvent.safeParse({ kind: "collapse", seq: 1, ts: 9, count: 3 }).success).toBe(true);
  });
});
```

- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run --project unit packages/contracts/src/health.test.ts`.
- [ ] **Step 3: implement.** `health.ts`:

```ts
import { z } from "zod";

export type HealthKind = "feed" | "sched" | "task" | "outbox" | "agent";
export type HealthSeverity = "err" | "att" | "mut";
export type HealthSource =
  | { readonly kind: "trigger"; readonly id: string; readonly name: string | null }
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string; readonly name: string | null }
  | { readonly kind: "effect"; readonly id: number }
  | null;

/** The closed code table (spec §2.2): severity is a property of the code, never chosen at the emission site. */
export const HEALTH_TABLE = [
  { kind: "feed", code: "feed_address", severity: "err" },
  { kind: "feed", code: "feed_redirects", severity: "err" },
  { kind: "feed", code: "feed_too_large", severity: "err" },
  { kind: "feed", code: "feed_timeout", severity: "err" },
  { kind: "feed", code: "feed_tls", severity: "err" },
  { kind: "feed", code: "feed_network", severity: "err" },
  { kind: "feed", code: "not_a_feed", severity: "err" },
  { kind: "feed", code: "feed_status_<n>", severity: "err" },
  { kind: "sched", code: "scheduler_failed", severity: "err" },
  { kind: "sched", code: "missed", severity: "att" },
  { kind: "sched", code: "precheck_failed", severity: "err" },
  { kind: "task", code: "task_failed", severity: "err" },
  { kind: "task", code: "task_budget", severity: "err" },
  { kind: "task", code: "task_deadline", severity: "err" },
  { kind: "task", code: "task_abort_failed", severity: "err" },
  { kind: "task", code: "task_release_failed", severity: "err" },
  { kind: "task", code: "task_end_failed", severity: "err" },
  { kind: "task", code: "task_orphan_session", severity: "err" },
  { kind: "outbox", code: "outbox_handler_error", severity: "err" },
  { kind: "outbox", code: "outbox_handler_overdue", severity: "att" },
  { kind: "outbox", code: "outbox_unknown_kinds", severity: "mut" },
  { kind: "agent", code: "vm_bundle_stale", severity: "att" },
  { kind: "agent", code: "sandbox_unavailable", severity: "att" },
  { kind: "agent", code: "agent_paused", severity: "att" },
  { kind: "agent", code: "capacity", severity: "att" },
  { kind: "agent", code: "agent_crash_paused", severity: "att" },
] as const satisfies readonly { readonly kind: HealthKind; readonly code: string; readonly severity: HealthSeverity }[];

const FEED_STATUS = /^feed_status_\d{3}$/;

export function healthSeverityOf(kind: HealthKind, code: string): HealthSeverity | null {
  for (const row of HEALTH_TABLE)
    if (row.kind === kind && (row.code === code || (row.code === "feed_status_<n>" && FEED_STATUS.test(code))))
      return row.severity;
  return null;
}

const HealthSourceSchema = z.union([
  z.object({ kind: z.literal("trigger"), id: z.string().min(1).max(128), name: z.string().max(4096).nullable() }).strict(),
  z.object({ kind: z.literal("task"), id: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("agent"), id: z.string().min(1).max(128), name: z.string().max(4096).nullable() }).strict(),
  z.object({ kind: z.literal("effect"), id: z.number().int().min(1) }).strict(),
  z.null(),
]);

export const HealthEvent = z
  .object({
    seq: z.number().int().min(1),
    ts: z.number().int().nonnegative(),
    kind: z.enum(["feed", "sched", "task", "outbox", "agent"]),
    severity: z.enum(["err", "att", "mut"]),
    code: z.string().min(1).max(64),
    sourceRef: HealthSourceSchema,
    count: z.number().int().min(1),
  })
  .strict()
  .refine((event) => healthSeverityOf(event.kind, event.code) === event.severity, "a known code with its table severity");
export type HealthEvent = z.infer<typeof HealthEvent>;

export const OpsStreamEvent = z.union([
  z.object({ kind: z.literal("snapshot"), events: z.array(HealthEvent).max(200), hasMore: z.boolean() }).strict(),
  z.object({ kind: z.literal("event"), event: HealthEvent }).strict(),
  z.object({ kind: z.literal("collapse"), seq: z.number().int().min(1), ts: z.number().int().nonnegative(), count: z.number().int().min(1) }).strict(),
]);
export type OpsStreamEvent = z.infer<typeof OpsStreamEvent>;
export const HEALTH_LIMITS = { buffer: 500, pageDefault: 50, pageMax: 200 } as const;
```

`health-methods.ts` (model: `automation-methods.ts`):

```ts
import { z } from "zod";
import { defineMethod } from "./define.ts";
import { HealthEvent } from "./health.ts";
import { Cursor } from "./frames.ts";

/** Browser sessions only, the models/MCP precedent: a token must not read the daemon's failure surface (spec §4). */
export const healthMethods = {
  "ops.events.list": defineMethod({
    name: "ops.events.list",
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ before: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    result: z.object({ events: z.array(HealthEvent).max(200), hasMore: z.boolean() }).strict(),
    errors: [],
  }),
  "subscribe.ops": defineMethod({
    name: "subscribe.ops",
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
};
```

- [ ] **Step 4: run tests (PASS)**, gate, commit `feat(contracts): health events contract and ops methods`.

### Task 2: the daemon buffer and the emission port

**Files:**
- Create: `apps/daemon/src/modules/health/events.ts`, `buffer.ts`, `index.ts`, `events.test.ts`, `buffer.test.ts`.
- No modification elsewhere; nothing imports the module yet (knip: `index.ts` re-exports only what Task 3/4 consume — if knip complains before Task 3, land Tasks 2+3 as one commit).

**Interfaces (Produces, from `modules/health/index.ts`):**
- `HealthEventInput { ownerId: string; kind: HealthKind; code: string; sourceRef: HealthSource }` (daemon-internal; `ownerId` never leaves the daemon).
- `HealthEvents { on(listener): () => void; emit(input): void }` + `createHealthEvents(logger)` — the `AutomationEvents` shape (`modules/automation/events.ts`): a listener that throws is logged and skipped.
- `createHealthBuffer({ clock, logger })` → `{ record(input); page(ownerId, before?, limit?); snapshot(ownerId); on(listener) }`; `HealthChange = { kind: "event"; ownerId; event: HealthEvent } | { kind: "collapse"; ownerId; seq; ts; count }`.

- [ ] **Step 1: failing tests.** `events.test.ts`:

```ts
import { createHealthEvents } from "./events.ts";

it("a listener that throws is logged and skipped", () => {
  const heard: unknown[] = [];
  const events = createHealthEvents(loggerOf()); // the silent test logger the automation beds use
  events.on(() => { throw new Error("boom"); });
  events.on((input) => void heard.push(input));
  expect(() => events.emit({ ownerId: "u1", kind: "feed", code: "not_a_feed", sourceRef: null })).not.toThrow();
  expect(heard).toHaveLength(1);
});
```

`buffer.test.ts` (drive time with `createFakeClock` from `kernel/clock.ts`, the `feed-fetch.int.test.ts` pattern):

```ts
it("inserts newest first, seq from 1, and collapses the same identity", () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf() });
  const input = { ownerId: "u1", kind: "feed", code: "not_a_feed", sourceRef: { kind: "trigger" as const, id: "t1", name: "k8s blog" } };
  buffer.record(input);
  clock.advance(5_000);
  buffer.record(input);
  const page = buffer.page("u1");
  expect(page.events).toHaveLength(1);
  expect(page.events[0]).toMatchObject({ seq: 1, ts: 6_000, count: 2, severity: "err" });
  buffer.record({ ...input, code: "feed_network" });
  expect(buffer.page("u1").events).toHaveLength(2); // a different identity inserts
});
it("pages by seq with hasMore and cuts to the frame budget", () => { /* insert 3 identities, page limit 2 → hasMore true, before = last seq */ });
it("the 500 cap drops the oldest and a re-fire inserts a new row", () => { /* 501 inserts: seq 1 gone, seq 501 present; re-fire of the dropped identity → a new row with count 1 */ });
it("another owner's page never sees the event", () => { /* record for u1, page("u2") is empty */ });
it("an unknown code is skipped", () => { /* record kind "task", code "nope" → page empty, a warn was logged */ });
it("a fresh instance starts empty at seq 1", () => { /* new buffer: page empty; first insert has seq 1 (the restart rule) */ });
```

- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run --project unit apps/daemon/src/modules/health/`.
- [ ] **Step 3: implement.** `events.ts` copies `modules/automation/events.ts` with the `HealthEventInput` payload (import the types from `@pap/contracts`). `buffer.ts` core:

```ts
interface Row { readonly key: string; readonly seq: number; readonly ownerId: string; ts: number; readonly kind: HealthKind; readonly severity: HealthSeverity; readonly code: string; readonly sourceRef: HealthSource; count: number; }

export function createHealthBuffer(deps: { readonly clock: Clock; readonly logger: Logger }) {
  const rows: Row[] = []; // newest first
  const byKey = new Map<string, Row>();
  let nextSeq = 1;
  const listeners = new Set<(change: HealthChange) => void>();
  const tell = (change: HealthChange) => { for (const l of [...listeners]) l(change); };

  function record(input: HealthEventInput): void {
    const severity = healthSeverityOf(input.kind, input.code);
    if (severity === null) return void deps.logger.warn("health_unknown_code", { kind: input.kind, code: input.code });
    const key = `${input.ownerId}\0${input.kind}\0${input.code}\0${JSON.stringify(input.sourceRef)}`;
    const ts = deps.clock.now();
    const found = byKey.get(key);
    if (found) { // collapse: one row per identity is by construction the newest of that identity
      found.ts = ts; found.count += 1;
      return tell({ kind: "collapse", ownerId: input.ownerId, seq: found.seq, ts, count: found.count });
    }
    const row: Row = { key, seq: nextSeq++, ownerId: input.ownerId, ts, kind: input.kind, severity, code: input.code, sourceRef: input.sourceRef, count: 1 };
    rows.unshift(row);
    byKey.set(key, row);
    if (rows.length > HEALTH_LIMITS.buffer) { const dropped = rows.pop(); if (dropped) byKey.delete(dropped.key); }
    tell({ kind: "event", ownerId: input.ownerId, event: toEvent(row) });
  }

  function page(ownerId: string, before?: number, limit?: number) {
    const want = Math.min(limit ?? HEALTH_LIMITS.pageDefault, HEALTH_LIMITS.pageMax);
    // ponytail: O(500) filter per page, the buffer is bounded by construction
    const matches = rows.filter((row) => row.ownerId === ownerId && (before === undefined || row.seq < before));
    let used = 0; let hasMore = matches.length > want;
    const events: HealthEvent[] = [];
    for (const row of matches) {
      if (events.length >= want) break;
      const event = toEvent(row);
      const size = sizeOf(event) + 1;
      if (used + size > PAGE_BYTES) { hasMore = true; break; } // the frame budget (M2R54)
      used += size; events.push(event);
    }
    return { events, hasMore };
  }
  return { record, page, snapshot: (ownerId: string) => ({ kind: "snapshot" as const, ...page(ownerId) }), on: (l) => { listeners.add(l); return () => void listeners.delete(l); } };
}
```

`toEvent(row)` strips `ownerId`/`key` (the client shape). `index.ts` re-exports `createHealthEvents`, `createHealthBuffer` and the types (Task 4 adds `createHealthModule`).

- [ ] **Step 4: run tests (PASS)**, gate, commit `feat(daemon): in-memory health event buffer`.

### Task 3: emission points wired

**Files (Modify; each gains an optional `health?: Pick<HealthEvents, "emit">` dep so existing tests compile unchanged):**
- `apps/daemon/src/modules/automation/feed-poll.ts` (+10): in `poll`, at the `feed_poll_failed` catch emit `feed_network`; next to both `journal(record, "error", …)` failure calls (fetch `!fetched.ok` and `!parsed.ok`) emit `{ kind: "feed", code: fetched.code ?? parsed.code }` with `sourceRef: { kind: "trigger", id: record.id, name: record.name }`.
- `apps/daemon/src/modules/automation/scheduler.ts` (+12): in `handleDue` after the missed `writeJournal` emit `{ kind: "sched", code: "missed" }`; at each `scheduler_trigger_failed` catch (the `fireNow` precheck `.catch`, `pollFeed`'s and `sweep`'s try/catch) emit `{ kind: "sched", code: "scheduler_failed" }` — all with the trigger sourceRef.
- `apps/daemon/src/modules/automation/precheck-step.ts` (+8): in the `stop` helper, when the verdict is `"error"` and the code is not the agent refusal (`precheck_agent`), emit `{ kind: "sched", code: "precheck_failed" }`.
- `apps/daemon/src/modules/automation/runner.ts` (+14 → ~396): inside `settle`, after `moved`, when `to === "failed"` emit `task_budget` (`reason` `budget`/`run_budget`), `task_deadline` (`deadline`) or `task_failed` (anything else) with `sourceRef: { kind: "task", id: row.id }`; next to the `task_abort_failed` (2 sites), `task_release_failed` and `task_end_step_failed` warns emit `task_abort_failed` / `task_release_failed` / `task_end_failed`. `task_event_failed` and `task_session_discard_failed` stay log-only (not in the table).
- `apps/daemon/src/modules/automation/boot.ts` (+4): at the `task_orphan_session_failed` catch emit `task_orphan_session` for that `ownerId`.
- `apps/daemon/src/modules/agents/threads.ts` (+14): `createThreads` deps gain `health`; at the `agent_paused` quarantine refusal, and in a `catch` around `sessions.createAgentSession` that rethrows after emitting when `error instanceof PapError && agentRefusalCodes.has(error.code)` (`agentRefusals = new Set(HEALTH_TABLE.filter((r) => r.kind === "agent").map((r) => r.code))`), emit `{ kind: "agent", code: error.code, sourceRef: { kind: "agent", id: agentId, name: record.name ?? null } }`.
- `apps/daemon/src/modules/agents/vm-crash.ts` (+6): at the point the 3-crashes pause is applied, emit `{ kind: "agent", code: "agent_crash_paused" }` with the agent sourceRef.
- `apps/daemon/src/kernel/outbox/worker.ts` (+12 → ~388): `InFlight` gains `ownerId: string | null` (set from `row.ownerId` at creation); next to the `outbox_handler_overdue` warn, call the listeners; the `Outbox` interface and return gain `onOverdue(listener: (overdue: { id: number; kind: string; ownerId: string | null }) => void): () => void` (a throwing listener is logged, the `onFailed` precedent).
- Create: `apps/daemon/src/modules/automation/health-emission.int.test.ts`.

**Interfaces (Consumes):** Task 2's `HealthEvents` via `modules/health/index.ts`.

- [ ] **Step 1: failing tests.** One focused test per site, next to the existing suites:
  - `feed-poll.test.ts`: `it("emits a health event when the fetch fails")` — `setup(() => Promise.resolve({ ok: false, code: "not_a_feed", retry: false }), { health })` with `health = { emit: vi.fn() }`, `await poll()`, then `expect(health.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "feed", code: "not_a_feed" }))`.
  - `scheduler.catchup.test.ts`: `it("emits a missed health event")` — drive an overdue occurrence, assert `emit` saw `{ kind: "sched", code: "missed" }`.
  - `runner.test.ts`: `it("emits task_deadline when the deadline stops a run")` and `it("emits task_failed on a provider failure")` — drive `stopRun(row, "deadline")` / `onRunEnd({ status: "failed" })`, assert the emitted code and `sourceRef`.
  - `threads.test.ts`: `it("emits an agent health event when the launch is refused")` — a quarantined agent: `refusalOf(() => threads.open("u1", id))` is still `agent_paused` **and** `emit` saw `{ kind: "agent", code: "agent_paused" }`.
  - `vm-crash.test.ts`: after the third `crash(id)`, `emit` saw `agent_crash_paused`.
  - `worker.failed.test.ts` (outbox): `it("notifies overdue listeners with the row's owner")`.
  - The int assertion (spec §10, one is enough) — `health-emission.int.test.ts`:

```ts
import { createHealthBuffer, createHealthEvents } from "../health/index.ts";
import { setup, state } from "./testing/feed-bed.ts";

it("a feed that does not parse becomes a health event the owner can page (int)", async () => {
  const events = createHealthEvents(state.bed.logger);
  const buffer = createHealthBuffer({ clock: state.bed.clock, logger: state.bed.logger });
  events.on((input) => buffer.record(input));
  const { poll } = setup(() => Promise.resolve({ ok: false, code: "not_a_feed", retry: false }), { health: events });
  const settlement = await poll();
  expect(settlement.outcome).toBe("fail"); // the emission never changed the settlement
  expect(buffer.page(state.bed.owner()).events[0]).toMatchObject({ kind: "feed", code: "not_a_feed", severity: "err", count: 1 });
});
```

- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run --project unit apps/daemon/src/modules/automation/feed-poll.test.ts apps/daemon/src/modules/automation/scheduler.catchup.test.ts apps/daemon/src/modules/automation/runner.test.ts apps/daemon/src/modules/agents/threads.test.ts apps/daemon/src/modules/agents/vm-crash.test.ts apps/daemon/src/kernel/outbox/worker.failed.test.ts` and `pnpm vitest run --project integration apps/daemon/src/modules/automation/health-emission.int.test.ts`.
- [ ] **Step 3: implement** per the file list; emissions are one `deps.health?.emit({...})` line at each named site, never inside a transaction, never replacing the existing log/journal call. `feed-bed.ts` (+3): `Options` gains `health?: Pick<HealthEvents, "emit">`, passed into `make()`'s `createFeedPoller` deps.
- [ ] **Step 4: run tests (PASS)** plus the touched suites' neighbours (`feed-poll.gates.test.ts`, `precheck.test.ts`, `runner.end.test.ts`, `boot` tests), gate, commit `feat(daemon): emit health events at the daemon's failure points`.

### Task 4: the module, the stream, the RPC, the composition

**Files:**
- Create: `apps/daemon/src/modules/health/stream.ts`, `rpc.ts`, `stream.test.ts`, `rpc.test.ts`, `apps/daemon/src/compose-health.ts`.
- Modify: `apps/daemon/src/modules/health/index.ts` (add `createHealthModule`), `apps/daemon/src/compose-automation.ts` (+8 → ~131: build the health module right after `composeOutbox`, return it), `apps/daemon/src/compose-m10.ts` (+2: pass `health` into the engine deps), `apps/daemon/src/daemon.ts` (+2 → 397: `health: m10.health.port,` in the `composeM11` deps and `...m10.health.rpc,` in `handlers`).

**Interfaces:**
- Consumes: Task 1 methods, Task 2 buffer/events, kernel `StreamHub` (`registerSnapshot`/`publish`), `Outbox.onFailed`/`onOverdue`.
- Produces: `createHealthModule({ clock, logger, hub, outbox })` → `{ port: HealthEvents; rpc: HealthRpc; stop(): void }`; `HealthRpc = Pick<HandlerTable, "ops.events.list" | "subscribe.ops">`.

- [ ] **Step 1: failing tests.**
  - `rpc.test.ts` (the `rpc.fire.test.ts` pattern — a fake service, assert decode → one call → result):

```ts
it("ops.events.list calls the service once with the caller's owner", async () => {
  const page = vi.fn(() => ({ events: [], hasMore: false }));
  const handler = healthRpc({ page }).["ops.events.list"];
  const result = await handler({ limit: 10 }, { caller: { userId: "u1", kind: "browser" } } as never);
  expect(page).toHaveBeenCalledWith("u1", { limit: 10 });
  expect(result).toEqual({ events: [], hasMore: false });
});
it("subscribe.ops opens the ops subscription keyed by the caller", async () => {
  const openSubscription = vi.fn(() => "sub-1");
  const handler = healthRpc({ page: vi.fn() }).["subscribe.ops"];
  expect(await handler({}, { caller: { userId: "u1", kind: "browser" }, openSubscription } as never)).toEqual({ sub: "sub-1" });
  expect(openSubscription).toHaveBeenCalledWith("ops", "u1", undefined);
});
```

  - `stream.test.ts`: a fake `hub` recording `registerSnapshot`/`publish`; a real buffer. `it("snapshots on subscribe")` — `hub.registerSnapshot("ops", snap)` then `snap("u1")` returns the newest page with `hasMore`; `it("publishes event and collapse deltas")` — record two inserts and a repeat, assert `{ kind: "event", event }` then `{ kind: "collapse", seq, ts, count }` on key `"u1"`; `it("nothing is published to another owner")` — record for `u2`, nothing on `"u1"`.
  - `index` module test (`buffer`-level, same file as rpc): `it("buffers an owned outbox failure and skips a system one")` — `onFailed({ id: 7, kind: "task.start", ownerId: "u1", lastError: "x", settledAt: 0 })` → page shows `outbox_handler_error` with `sourceRef { kind: "effect", id: 7 }`; `ownerId: null` → page empty (log-only in v1).

- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run --project unit apps/daemon/src/modules/health/`.
- [ ] **Step 3: implement.** `stream.ts`:

```ts
export function createHealthStream(deps: { buffer: HealthBuffer; hub: Pick<StreamHub, "publish" | "registerSnapshot">; logger: Logger }) {
  deps.hub.registerSnapshot("ops", (ownerId) => deps.buffer.snapshot(ownerId));
  const stop = deps.buffer.on((change) => {
    const event: OpsStreamEvent = change.kind === "event"
      ? { kind: "event", event: change.event }
      : { kind: "collapse", seq: change.seq, ts: change.ts, count: change.count };
    try { deps.hub.publish("ops", change.ownerId, event); }
    catch (error) { deps.logger.warn("health_publish_failed", { kind: change.kind, err: error }); }
  });
  return { stop };
}
```

`rpc.ts`:

```ts
export function healthRpc(service: { page(ownerId: string, params: { before?: number; limit?: number }): { events: HealthEvent[]; hasMore: boolean } }): HealthRpc {
  return {
    "ops.events.list": (params, ctx) => service.page(ctx.caller.userId, params),
    "subscribe.ops": (params, ctx) => ({ sub: ctx.openSubscription("ops", ctx.caller.userId, params.after) }),
  };
}
```

`index.ts` gains `createHealthModule`: buffer + `createHealthEvents`, `events.on(buffer.record)`, `createHealthStream`, the two outbox subscriptions (`onFailed` → `outbox_handler_error`, `onOverdue` → `outbox_handler_overdue`, both skipped when `ownerId === null`), and `stop()`. `compose-health.ts` wraps it (`composeHealth({ clock, logger, hub, outbox })`), called from `compose-automation.ts` next to `composeOutbox`; `compose-m10.ts` passes `health: m10.health.port` into `createTaskEngine`; `compose-m11.ts` threads it to `createThreads`/`createCrashPause` (the daemon passes it through the existing deps object).

- [ ] **Step 4: run tests (PASS)** + `pnpm vitest run --project integration apps/daemon/src/compose-automation.test.ts`, gate (knip must be clean), commit `feat(daemon): ops.events.list and the ops health stream`.

### Task 5: the web section — route, store, list, states, i18n

**Files:**
- Create: `apps/web/src/features/health/HealthSection.tsx`, `health.vm.ts`, `HealthSection.test.tsx`, `apps/web/src/stores/health-store.ts`, `health-reducer.ts`, `health-feed.ts`, `apps/web/src/routes/settings/HealthSettings.tsx`, `apps/web/src/i18n/catalog/health.ts`, `apps/web/src/i18n/register-health.ts`, `apps/web/src/i18n/lazy-catalog.health.test.ts`, `apps/web/src/routes/settings/sections.health.test.tsx`.
- Modify: `apps/web/src/features/workspace/model.ts` (+1: `"health",` after `"automation",` in `SETTINGS_SECTIONS`), `apps/web/src/routes/settings/sections.tsx` (+2: import + `health: () => <HealthSettings />`), `apps/web/src/runtime/subscriptions.ts` (+1: `ops: (rpc, _key, after) => rpc.call("subscribe.ops", after ? { after } : {})` in `OPENERS`), `apps/web/src/i18n/index.ts` (+2: the type-only import and `| keyof typeof healthEn` in `MessageKey`), `apps/web/src/i18n/catalog/settings-screen.ts` (+2: `"settings.section.health": "Health"` / `"Santé"`).

**Interfaces:**
- Consumes: `ops.events.list`, the `ops` stream (`OpsStreamEvent`), `@pap/ui` (`Segmented`, `Chip`, `TextField`, `Button`, `EmptyState`), `pathOfItem`.
- Produces: `useHealthStore` (`{ view: HealthView; apply(event): void; append(page): void; reset(): void }`), `HealthView { loaded; events: readonly HealthEvent[]; hasMore }`, `feedOps(subscriptions, onError)`.

- [ ] **Step 1: failing tests.**
  - `health-reducer.test.ts`: snapshot replaces; `event` inserts by `seq` without duplicates; `collapse` bumps `ts`/`count` of its row; garbage is skipped, never fatal.
  - `HealthSection.test.tsx` (the `FireJournal.test.tsx` pattern: `fakeRuntime` bed, `// @vitest-environment happy-dom`): renders rows from a snapshot (ts, `ERR` chip, `FEED` kind label, `not_a_feed` code, the source link's `href` is the trigger editor's path, `×2` when `count > 1`); Load more calls `ops.events.list` with `before` = last `seq` and merges; empty snapshot → the EmptyState sentence "No daemon failures recorded for this daemon run." and the primary action navigates to the tasks board; a subscription error → the three-part failed copy and Retry re-syncs; a `collapse` event updates the row without a refetch.
  - `lazy-catalog.health.test.ts`: same keys and `{slot}`s in EN and FR, exact words for `health.title`, `health.failed`, `health.empty.title`, `health.empty.action`.
  - `sections.health.test.tsx` (the `sections.automation.test.tsx` pattern): `/settings/health` renders the section and opens the `ops` subscription once, `unsubscribe` on unmount.
- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run --project unit apps/web/src/features/health/ apps/web/src/stores/ apps/web/src/routes/settings/ apps/web/src/i18n/`.
- [ ] **Step 3: implement.**
  - `health-reducer.ts` parses with `OpsStreamEvent.safeParse` (the `tasks-reducer.ts` pattern); `health-store.ts` mirrors `tasks-store.ts`; `health-feed.ts` mirrors `tasks-feed.ts` with stream `"ops"`, key `"me"`.
  - `HealthSection.tsx`: `useHealthFeed()` keeps the subscription while mounted (a `useEffect` returning `feedOps(getRuntime().subscriptions, () => setFailed(true))`); states `loading` (`!view.loaded && !failed`, place held, no spinner), `failed` (`role="alert"`, Retry = `getRuntime().subscriptions.resync("ops", "me")` + `setFailed(false)`), `empty` (`EmptyState` with a `Button` navigating to `pathOfItem({ kind: "tasks" })`); the list is a table like `FireJournal`'s: `whenText(entry.ts, now, locale)` (local helper, the `journal.vm.ts` clock formatting), `<Chip tone={severity} label={"ERR" | "ATT" | "MUT"} />`, mono uppercase kind label, mono code, the source name as a `Link` (trigger → `pathOfItem({ kind: "trigger", id })`, task → `{ kind: "tasks" }`, agent → `{ kind: "agent", id }`, effect → no link), `×{n}` only when `count > 1`; Load more button when `hasMore`; a `sr-only` `aria-live="polite"` paragraph that carries the copy of a newly arrived `err` event (DESIGN.md §12). No timer, no polling.
  - `HealthSettings.tsx`: the `AutomationSettings.tsx` lazy wrapper around `HealthSection` (`useRetryableLazy` + `LazyBoundary`), importing `../../i18n/register-health.ts` in the lazy chunk.
  - `catalog/health.ts` (lazy, `healthEn`/`healthFr`): `health.title` "Health" / "Santé"; `health.filter.label` + `health.filter.all|feed|sched|task|outbox|agent` ("All", "Feed", "Schedule", "Tasks", "Outbox", "Agents" — mono uppercase is styling, not copy); `health.severity.err|att|mut` ("ERR"/"ATT"/"MUT" in both locales); `health.search.label` "Search code or source" / "Rechercher un code ou une source"; `health.more` "Load more" / "En charger plus"; `health.retry` "Retry" / "Réessayer"; `health.failed` "The failure list did not load. The daemon keeps running and the events are kept. Retry." / "La liste des échecs n'a pas chargé. Le daemon continue de tourner et les événements sont conservés. Réessayez."; `health.empty.title` "No daemon failures recorded for this daemon run." / "Aucun échec enregistré pour cette exécution du daemon."; `health.empty.action` "Open the tasks board" / "Ouvrir le tableau des tâches"; `health.count` "×{n}" in both; `health.kind.feed|sched|task|outbox|agent`; `health.announce` "New failure: {code}" / "Nouvel échec : {code}"; and `health.code.<code>` for **every** table code — one plain sentence each, EN and FR, the three-part shape where it helps (samples: `health.code.not_a_feed` "The feed did not load: not a feed. The trigger is intact. Check its URL."; `health.code.feed_status` "The feed answered {status}. The trigger is intact. Check the source."; `health.code.task_deadline` "A task was stopped: its deadline passed."; `health.code.agent_crash_paused` "An agent crashed three times in ten minutes; its launches are paused."). Codes stay untranslated identifiers; only the copy is localised.
- [ ] **Step 4: run tests (PASS)**, gate (+ `pnpm budgets` if the settings bundle moved), commit `feat(web): the Health section of Settings`.

### Task 6: filters — kind, severity toggles, search, persistence

**Files:**
- Create: `apps/web/src/features/health/health-filters.ts`, `health-filters.test.ts`.
- Modify: `apps/web/src/features/health/HealthSection.tsx` (+30 → ~230: the toolbar row above the table), `HealthSection.test.tsx` (+ the filter cases).

**Interfaces (Produces):** `HealthFilters { kind: "all" | HealthKind; severities: Record<HealthSeverity, boolean>; search: string }`, `DEFAULT_FILTERS`, `loadFilters()`, `saveFilters(filters)`, `keeps(event, filters)`, `withSeverity(filters, severity, on)`.

- [ ] **Step 1: failing tests.** `health-filters.test.ts`:

```ts
it("keeps by kind, severity and a case-insensitive search on code and source name", () => {
  const event = { seq: 1, ts: 0, kind: "feed", severity: "err", code: "not_a_feed", sourceRef: { kind: "trigger", id: "t1", name: "K8s Blog" }, count: 1 } as const;
  expect(keeps(event, DEFAULT_FILTERS)).toBe(true);
  expect(keeps(event, { ...DEFAULT_FILTERS, kind: "sched" })).toBe(false);
  expect(keeps(event, { ...DEFAULT_FILTERS, severities: { err: false, att: true, mut: true } })).toBe(false);
  expect(keeps(event, { ...DEFAULT_FILTERS, search: "k8s" })).toBe(true);
  expect(keeps(event, { ...DEFAULT_FILTERS, search: "deadline" })).toBe(false);
});
it("the last severity stays on", () => {
  expect(withSeverity({ ...DEFAULT_FILTERS, severities: { err: true, att: false, mut: false } }, "err", false).severities.err).toBe(true);
});
it("falls back to the defaults on corrupted storage", () => {
  localStorage.setItem("pap.health.filters", "{oops");
  expect(loadFilters()).toEqual(DEFAULT_FILTERS);
});
```

  `HealthSection.test.tsx`: the Segmented switches kinds; a severity toggle off dims its rows; typing in the search field filters; reload with a stored `pap.health.filters` restores the filters without an RPC (the key is device-scoped, never sent to the daemon).
- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run --project unit apps/web/src/features/health/`.
- [ ] **Step 3: implement.** `health-filters.ts`:

```ts
export interface HealthFilters { readonly kind: "all" | HealthKind; readonly severities: Readonly<Record<HealthSeverity, boolean>>; readonly search: string; }
export const DEFAULT_FILTERS: HealthFilters = { kind: "all", severities: { err: true, att: true, mut: true }, search: "" };
const KEY = "pap.health.filters";

export function loadFilters(): HealthFilters { /* try JSON.parse(localStorage.getItem(KEY)); validate the three fields, anything off → DEFAULT_FILTERS */ }
export function saveFilters(filters: HealthFilters): void { localStorage.setItem(KEY, JSON.stringify(filters)); }
export function withSeverity(filters: HealthFilters, severity: HealthSeverity, on: boolean): HealthFilters {
  const others = (Object.keys(filters.severities) as HealthSeverity[]).some((s) => s !== severity && filters.severities[s]);
  if (!on && !others) return filters; // at least one severity stays on (spec §5)
  return { ...filters, severities: { ...filters.severities, [severity]: on } };
}
export const keeps = (event: HealthEvent, filters: HealthFilters): boolean =>
  (filters.kind === "all" || event.kind === filters.kind) && filters.severities[event.severity] &&
  (filters.search === "" || event.code.toLowerCase().includes(filters.search.toLowerCase()) ||
   (event.sourceRef?.name ?? "").toLowerCase().includes(filters.search.toLowerCase()));
```

  The toolbar in `HealthSection`: one wrapping row — `Segmented` (ALL/FEED/SCHED/TASK/OUTBOX/AGENT), three `<button aria-pressed>` wrapping `<Chip tone={on ? severity : "mut"} label={t(`health.severity.${severity}`)} />` (Chip is not interactive), a `TextField` for the search; the row list becomes `view.events.filter((event) => keeps(event, filters))`; `saveFilters` on every change, `loadFilters()` in the initial state.
- [ ] **Step 4: run tests (PASS)**, gate, commit `feat(web): health screen filters with local persistence`.

### Task 7: docs

**Files:**
- Create: `docs/agents/health.md` (~55 lines).
- Modify: `AGENTS.md` (topic-notes list gains `health` (the Health screen)), `docs/agents/automation.md` (+3: a "Health" paragraph pointing at `health.md`), `docs/agents/daemon.md` (+2: the buffer is in memory, 500 events, reset by restart).

- [ ] **Step 1: write `docs/agents/health.md`:** what the screen is (a live console of the current daemon run, not a history); the event shape and the closed code table (point at `HEALTH_TABLE` in `packages/contracts/src/health.ts`, do not duplicate the rows); the buffer (500, collapse, restart resets, `seq` per run); the permission (`pi:admin` on both methods, a token never reads it); per-owner routing; what stays out (raw logs stay SSH-only in `trace.jsonl`, system-owned outbox failures and `outbox_unknown_kinds` stay log-only in v1, no notifications, no acknowledge); the emission rule (only where the daemon already logs — a new failure needs its code in the table first).
- [ ] **Step 2: gate** with the doc tests (`scripts/docs-truth.test.ts`, `scripts/parity-doc.test.ts` if they index topic notes) — Health has no pi-web parity row (pap-only surface).
- [ ] **Step 3: commit** `docs(health): the daemon's failure console`.

## File and line budget

| File | Change | Lands at |
|---|---|---|
| `packages/contracts/src/health.ts` | create | ~105 |
| `packages/contracts/src/health-methods.ts` | create | ~30 |
| `packages/contracts/src/health.test.ts` | create | ~55 |
| `packages/contracts/src/streams.ts` / `methods.ts` / `index.ts` | +1 / +2 / +2 | 315 / 392 / 86 |
| `apps/daemon/src/modules/health/events.ts` | create | ~40 |
| `apps/daemon/src/modules/health/buffer.ts` | create | ~115 |
| `apps/daemon/src/modules/health/stream.ts` | create | ~35 |
| `apps/daemon/src/modules/health/rpc.ts` | create | ~30 |
| `apps/daemon/src/modules/health/index.ts` | create | ~75 |
| `apps/daemon/src/modules/health/*.test.ts` (4 files) | create | ≤ 160 each |
| `apps/daemon/src/compose-health.ts` | create | ~25 |
| `apps/daemon/src/kernel/outbox/worker.ts` | +12 | ~388 |
| `apps/daemon/src/modules/automation/{feed-poll,scheduler,precheck-step,runner,boot}.ts` | +10/+12/+8/+14/+4 | runner ~396, others ≤ 270 |
| `apps/daemon/src/modules/agents/{threads,vm-crash}.ts` | +14/+6 | 162 / 49 |
| `apps/daemon/src/modules/automation/testing/feed-bed.ts` | +3 | 108 |
| `apps/daemon/src/{daemon,compose-automation,compose-m10}.ts` | +2/+8/+2 | 397 / 131 / — |
| `apps/web/src/features/health/HealthSection.tsx` | create | ~230 |
| `apps/web/src/features/health/{health.vm,health-filters}.ts` | create | ~90 / ~60 |
| `apps/web/src/stores/{health-store,health-reducer,health-feed}.ts` | create | ~25 / ~45 / ~15 |
| `apps/web/src/routes/settings/HealthSettings.tsx` | create | ~55 |
| `apps/web/src/i18n/catalog/health.ts` | create | ~140 (all codes, EN+FR) |
| `apps/web/src/i18n/{register-health.ts,index.ts}` | create / +2 | ~7 / 257 |
| `apps/web/src/i18n/catalog/settings-screen.ts`, `runtime/subscriptions.ts`, `features/workspace/model.ts`, `routes/settings/sections.tsx` | +2/+1/+1/+2 | 70 / 234 / 139 / 29 |
| web tests (`HealthSection.test.tsx`, `health-filters.test.ts`, `health-reducer.test.ts`, `lazy-catalog.health.test.ts`, `sections.health.test.tsx`) | create | ≤ 220 each |

No file reaches 400 lines; `daemon.ts` and `runner.ts` land at 397 and ~396 — if an edit would cross the cap, move the added lines into the named new files instead.
