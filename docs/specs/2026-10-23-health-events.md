# Health screen: the daemon's failure console

Date 2026-10-23. Status: design, the decisions below were validated with the owner on 2026-10-23. Fits spec C (§3.4 observability) and DESIGN.md (a "health" screen is listed in §10). ADR: none needed — no architectural decision changes; deviations from spec C, if any, get one at plan time. Calls the controller made without the owner are marked *(controller's call)*.

## 1. Problem and goal

Trigger and daemon failures are visible only over SSH (`$PAP_HOME/logs/trace.jsonl`, the `trigger_fires` table). The pwnwatch trigger failed 20 times with `not_a_feed` and nothing surfaced in the UI.

Goal: a live **Health** section in the web UI that shows the daemon's failure events as they happen. Not a log viewer: **typed events only** — no prompts, no session bodies, no payloads, no secrets, no URLs, no host names. Each event is `{ts, kind, severity, code, sourceRef, count}` and nothing else.

## 2. Event contract

Contracts gain `HealthEvent` (in `packages/contracts/src/`, a new `health.ts` beside the method defs):

```ts
type HealthKind = "feed" | "sched" | "task" | "outbox" | "agent";
type HealthSeverity = "err" | "att" | "mut";
type HealthSource =
  | { kind: "trigger"; id: string; name: string | null }
  | { kind: "task"; id: string }
  | { kind: "agent"; id: string; name: string | null }
  | { kind: "effect"; id: number }
  | null;

interface HealthEvent {
  readonly seq: number;        // insertion order, per daemon run, the pagination cursor
  readonly ts: number;         // last occurrence (epoch ms, kernel Clock)
  readonly kind: HealthKind;
  readonly severity: HealthSeverity;
  readonly code: string;       // closed set, §2.2
  readonly sourceRef: HealthSource;
  readonly count: number;      // collapsed repeats since the event's first ts
}
```

- `code` is a closed set validated by zod; an unknown code never reaches a client. The set is the daemon's **existing** error codes — this spec invents none, it maps what the daemon already emits (source of truth: `docs/agents/automation.md`, `docs/agents/daemon.md`, the `FeedFetchCode` union in `apps/daemon/src/modules/automation/feed-fetch.ts`).
- `sourceRef.name` is the stored trigger or agent name (the owner's own label, already shown elsewhere). Names carry hidden-character escaping as everywhere in the UI. No path, no URL, no host ever enters an event.
- One event never grows a free-text field. If a future code needs context, the context goes into the code's i18n copy via closed parameters, not the event.

### 2.1 Kinds

| Kind | Covers |
|---|---|
| `feed` | feed poll and fetch failures (a trigger's feed that does not fetch or parse) |
| `sched` | scheduler failures: a trigger's fire path threw, plus missed fires |
| `task` | task failures: a task ended `failed`, plus the runner's own failure moves |
| `outbox` | outbox effect failures and anomalies |
| `agent` | agent launch refusals and crash pauses |

Routine lifecycle (a task that runs and ends `done`, a feed that polls clean, a worker that starts or stops) is **not** an event. Failures and anomalies only.

### 2.2 Codes and severities

Severity is a property of the code, fixed in the contracts table, not chosen at the emission site:

| Kind | Code | Severity | Existing source |
|---|---|---|---|
| feed | `feed_address` · `feed_redirects` · `feed_too_large` · `feed_timeout` · `feed_tls` · `feed_network` · `not_a_feed` · `feed_status_<n>` | err | `FeedFetchCode`, logged `feed_fetch` / `feed_poll_failed` |
| sched | `scheduler_failed` | err | `scheduler_trigger_failed` log lines |
| sched | `missed` | att | catch-up `missed N` journal lines |
| sched | `precheck_failed` | err | precheck `error` moves (`timeout`, `signal`, `spawn`, exit > 1) |
| task | `task_failed` | err | a task's terminal `failed` state |
| task | `task_budget` · `task_deadline` | err | task aborts tagged `budget` / `run_budget` / `deadline` |
| task | `task_abort_failed` · `task_release_failed` · `task_end_failed` · `task_orphan_session` | err | the runner's `task_*_failed` log lines |
| outbox | `outbox_handler_error` | err | outbox handler failure |
| outbox | `outbox_handler_overdue` | att | outbox overdue |
| outbox | `outbox_unknown_kinds` | mut | unknown kinds recovered at boot |
| agent | `vm_bundle_stale` · `sandbox_unavailable` · `agent_paused` · `capacity` | att | agent launch refusal codes (ADR 0081) |
| agent | `agent_crash_paused` | att | 3 crashes in 10 minutes pause the launches |

`feed_status_<n>` keeps its numeric suffix; the contract accepts the pattern, the copy renders the number as a closed parameter.

*(Controller's call, severity table)*: `err` = the thing failed; `att` = pap degraded or is waiting on the owner (launches refused, fires missed, effect overdue); `mut` = noted anomaly, nothing to act on now.

## 3. The buffer

A new daemon module `apps/daemon/src/modules/health/` (the module-import rule holds: it imports `@pap/contracts`, `kernel/` and other modules' `index.ts`; automation and agents reach it through an injected `HealthEvents` port, the shape of `AutomationEvents` in `modules/automation/events.ts` — a listener that throws is logged and skipped, one subscriber never stops the move that caused the event).

- **Write points.** Emissions sit at the exact places the daemon already logs or journals the failure: the `feed_poll_failed` / `feed_fetch` result in `feed-poll.ts`; the `scheduler_trigger_failed` catches and the missed-fire journal in `scheduler.ts`; the precheck `error` detail in `precheck-step.ts`; the task terminal states and `task_*_failed` lines in `runner.ts` and its end hook; the outbox failure callbacks (`onFailed`-style) the kernel outbox already exposes; the agent launch refusals and the crash pause in the agents module. No new detection, no new try/catch: if it is not already a log line or a journal move, it is not a health event.
- **Shape.** An in-memory circular buffer of the newest **500** events per daemon, newest first on read. No database table, no file, no backup payload. The buffer is written synchronously next to the existing log call — an event is never the reason a code path fails.
- **Collapse.** Same rule as the fire journal (`fire-journal.ts`): a new event whose kind, code, severity and sourceRef equal the **newest** buffer entry of that identity adds 1 to its `count` and moves its `ts`; a different identity inserts a new entry. `ts` is the last occurrence; the first occurrence is lost from the row on purpose — the count carries the story *(controller's call: one timestamp, the FireJournal shape)*.
- **Cap.** Past 500 events the oldest is dropped. A storm cannot grow memory: the buffer's footprint is bounded by construction.
- **Restart.** The buffer resets: a daemon restart empties it and starts a new `seq` from 1. **This is by design and stated in the UI** — the Health screen is a live console of the current run, not a history. Events before a restart stay in `trace.jsonl` over SSH, exactly as today. The screen's empty state after a restart is correct, not a bug.
- **Ownership.** Every event carries the ownerId of the trigger, task, effect or agent it belongs to (routed exactly like the `tasks` stream's failures). An event with no owner (a system effect) is buffered for no one in v1 — the tasks stream already skips those, and this spec keeps the rule *(controller's call; see open questions)*.
- **Read-only mode.** Nothing changes: the buffer is memory, `ops.events.list` reads it, no mutation is involved.

## 4. RPC, stream, permission

Two methods in `packages/contracts/src/methods.ts` (via a new `health-methods.ts`), both **`pi:admin`** — browser sessions only, never a token, the models/MCP precedent: a token must not read the daemon's failure surface.

- **`ops.events.list`** — idempotent, `errors: []`:

```ts
params: { before?: number /* seq */, limit?: number /* 1..200, default 50 */ }
result: { events: HealthEvent[] /* newest first */, hasMore: boolean }
```

  A page is cut to the frame budget (`PAGE_BYTES`) like every list; the caller gets `hasMore` and pages with `before: events[events.length - 1].seq`.

- **`subscribe.ops`** — idempotent, `errors: ["capacity"]`, the shape of `subscribe.tasks`:

```ts
params: { after?: Cursor }
result: { sub: string }
```

  It registers a snapshot on the existing `StreamHub` (kernel `ws/stream-hub.ts`), keyed by owner like `tasks` and `shell`: one snapshot (the newest page, with `hasMore`) when the Health screen opens, then one stream event per buffer change — `{kind: "event", event}` for a new entry, `{kind: "collapse", seq, ts, count}` for a count bump. The client merges by `seq`. **The name `subscribe.ops` is the builder's** within the `subscribe.*` conventions; the channel is the same hub the tasks and Inbox updates ride — no new transport, no second socket.

Handlers follow the house rule: decode, one service method (`HealthBuffer.page` / the stream module), map typed errors. The service is the only writer of the buffer; the RPC and the stream only read.

*(Controller's call on the channel)*: the events ride their own `subscribe.*` method rather than being appended to the `tasks` stream's event union, because `subscribe.tasks` is `automation:read` and the Health surface must be `pi:admin`-gated. Same hub, same client store pattern, one permission difference. If the owner prefers piggybacking on `subscribe.tasks`, that is a one-line change at plan time — flagged below.

## 5. UI

A **Health** section in Settings, wired like the others: `SETTINGS_SECTIONS` gains `"health"` (`apps/web/src/features/workspace/model.ts`), a renderer in the settings screen's section map, an `ItemRef` route, so it opens as a tab and survives reloads with the workspace. Web code lands in `apps/web/src/features/health/`.

- **Toolbar** (one row, wraps):
  - `Segmented` kind filter: **ALL / FEED / SCHED / TASK / OUTBOX / AGENT**, mono uppercase items;
  - severity toggles: `Chip` **ERR / ATT / MUT**, each a toggle (on: its tone and full colour; off: `mut` tone, dimmed) — several may be on, none-off means nothing shown and is prevented *(controller's call: at least one severity stays on)*;
  - a `TextField`, search on `code` and the source name, case-insensitive, client-side (the buffer is small; no server search).
- **Filters persist locally** like the rest of the workspace: a `localStorage` key (`pap.health.filters`), device-scoped, never sent to the daemon — the same pattern as the workspace's own persist file.
- **List**, newest first, one row per collapsed event:
  - `ts` — mono, tabular figures, the same relative formatting as the fire journal (`whenText`);
  - severity `Chip` (tone `err` / `att` / `mut`, word `ERR` / `ATT` / `MUT` — colour is never the only carrier);
  - kind label — mono uppercase (`FEED`, `SCHED`, …);
  - `code` — mono;
  - source — the trigger or agent **name as a link** (trigger → its editor, task → the tasks board's card, agent → its page, effect → no link); the link is the row's one action;
  - `count` — `×N`, mono, tabular, only when N > 1.
- **Load more** below the list when `hasMore`, the fire journal's button pattern.
- **States**: loading (the list's place held, no spinner under 1 s), failed (the copy in §6), empty (the `EmptyState`: dashed frame, one sentence — "No daemon failures recorded for this daemon run." — and one primary action, **OPEN THE TASKS BOARD** *(controller's call: it is the reachable next step; the buffer cannot be refreshed into existence)*).
- **Nothing repaints continuously.** No timer, no polling, no animated indicator. Rows change only when a stream event arrives; the subscription tick is the sole repaint trigger. A new `err` event is announced politely to live regions (DESIGN.md §12).
- The daemon-restart truth is on the screen: the empty state's sentence says "for this daemon run", and the copy never implies history.

## 6. DESIGN.md compliance

Mandatory, checked at review against the file at the repo root:

- tokens from `packages/ui/src/tokens.css` only — no raw colours, no arbitrary values, no `className` restyling of `@pap/ui` primitives;
- colour = role: severity chips use the `err` (red), `att` (pink), `mut` (neutral) tones and nothing else; the kind filter's active item is the Segmented's agent underline, not a colour of its own;
- mono uppercase labels (`FEED`, `ERR`, `×N`), sharp corners, numbers in tabular figures;
- the three-part error pattern: a failed load says what happened, what is intact, what to do — "The failure list did not load. The daemon keeps running and the events are kept. Retry." Never overclaim; no exclamation marks;
- English and French through the i18n layer, no concatenated strings around variables.

## 7. i18n

Namespace `health.`, a new catalog chunk (`apps/web/src/i18n/catalog/…` + a `register-health.ts`, the lazy-catalog pattern) with a key test like the others:

- `settings.section.health` — the nav label;
- `health.title`, `health.filter.all|feed|sched|task|outbox|agent`, `health.severity.err|att|mut`;
- `health.search.label`, `health.more`, `health.failed`, `health.empty.title`, `health.empty.action`;
- `health.kind.feed|sched|task|outbox|agent` (the row labels), `health.count` ("×{n}");
- per-code copy: `health.code.<code>` — one sentence per code in the three-part shape where it helps ("The feed did not load: not a feed. The trigger is intact. Check its URL."), with `health.code.feed_status` taking the number as a parameter.

Codes themselves stay untranslated identifiers; only their copy is localised.

## 8. Security and trust

- The event fields are a closed, typed set. Nothing the redactor must catch can enter: no payload, no prompt, no command, no path, no URL, no host. The feed codes carry the fetch outcome, never the address (the address guard's logs already follow this).
- `pi:admin` both methods: a pap token never lists or subscribes to health events.
- Per-owner routing on the stream: an owner sees only their own triggers, tasks, effects and agents, the `tasks` stream's rule.
- The buffer holds trigger and agent **names** — data the owner's browser already receives on other screens; no new exposure.

## 9. Repo constraints (CI-enforced, restated for the plan)

- 400 lines per file: the module splits `buffer.ts` / `events.ts` (the port) / `stream.ts` / `rpc.ts`; contracts split `health.ts` / `health-methods.ts`.
- Both methods declare their permission; handlers decode, call one service method, map typed errors.
- Erasable syntax only; relative imports keep `.ts`.
- Tests never touch `~/.pi/agent` or `~/.pap`; timers through the kernel `Clock` (the buffer's `ts` comes from it, so tests steer time).
- UI tokens only; the ESLint directive rule and the rest of `AGENTS.md` apply as everywhere.

## 10. Tests

- **Unit (required)**:
  - buffer: insert, newest-first read, pagination by `seq` with `hasMore`, collapse (same identity bumps count and ts; different identity inserts), the 500 cap drops the oldest, restart resets (a fresh instance starts empty at seq 1), per-owner routing (another owner's page never sees the event), an emission that throws never breaks the emitter;
  - contracts: both methods parse with `pi:admin` and the idempotence flags; `HealthEvent` rejects an unknown kind, severity or code; the code table matches the emission sites' unions (one shared constant, both sides import it).
- **RPC**: decode → one service call → typed errors, the existing `rpc.test.ts` pattern.
- **Stream**: snapshot on subscribe, `event` and `collapse` deltas, nothing published to another owner.
- **UI (component tests, the `FireJournal.test.tsx` pattern)**: rendering, the three filters, search, the ×N, the link targets, the empty and failed states, filter persistence in `localStorage`.
- **No e2e for v1** (stated requirement). Existing int suites may assert an emission where they already drive a failure (a feed-bed `not_a_feed`, an outbox hold); one such assertion is enough — new int journeys are not required.

## 11. Not in scope (v1 and stated)

- **Raw log access**: `trace.jsonl` stays SSH-only; the Health screen never proxies, tails or searches logs.
- **JSON feed support**: feeds stay RSS/Atom (ADR 0046); JSON Feed is a separate feature, not a health concern.
- **Notifications**: no push, no Inbox item, no e-mail from a health event. The screen is pull-visited; M12's push routes stay untouched.
- **Historical search**: no persistence beyond the buffer, no database table, no query over past runs. What a restart drops is gone from the UI.
- **Acknowledge / dismiss**: events are not actionable rows; they clear by age and cap only.
- **System-owned failures** (an effect with no owner) stay log-only in v1.

## 12. Left to the plan

The `subscribe.ops` name, the page default (50 proposed), the exact empty-state sentence, whether the agent kind's codes need one more entry after a pass over `docs/agents/agents.md`, the emission wiring order in the composition root, and the lane split.
