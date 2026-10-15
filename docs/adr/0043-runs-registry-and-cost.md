# ADR 0043: the runs registry and cost

Status: accepted (M10, Task 24)
Date: 2026-10-15
Spec: C §3.4, A §3. Rulings: M10R83 to M10R90, M10R141, M10R156, M10R162, controller C1.

## Context

FinOps needs one figure per run that survives restarts, feeds the daily budget, the compare column of M9 and `/metrics`, and can be shipped as a file to a log store without leaking content.

## Decision

- `modules/runs/` owns the `runs` table and a `RunObserver` the sessions module calls (one raw-event line in `live-session.ts`, two `record` lines in `service-launch.ts`; a throw is logged as `runs_observer_failed` and never reaches the session). No prompt, payload, path, tool argument or provider text is stored: ids, counts and money only.
- Cost is Pi's `usage.cost.total`: the list price of the tokens. For an API key it is the provider's cost; for a subscription it is the API-equivalent, and the UI labels it so. Compaction usage (`compaction_end`) is added, because Pi counts it in the session's totals.
- `billing` (`api`, `subscription`, `unknown`) comes from the worker's loadout: `modelRuntime.isUsingSubscription(provider)`. The plan text said `isUsingOAuth`; that call marks OAuth API-key providers such as OpenRouter as subscriptions, and the first review fixed it.
- Each ended run writes one line to `logs/runs.jsonl` (`v: 1`) with `provider` and `model` through `labelValue` (plain `[A-Za-z0-9._:/@+-]{1,64}`, free of secret formats and of path shapes: a leading `/`, `~` or `.`, or any `..`, becomes `other`).
- `RunsPort`: `onRunStart`, `onRunEnd`, `expectOrigin`, `markEnding` (the runner's aborts say why: `deadline`, `run_budget`, `budget`), `onLiveCost`, `spentToday`, `spentTodayOf`, `sessionCost` (synchronous, finished runs plus the live cost of the open one, for M9's compare), `onResumeSkipped`, `summary`.
- The budget counts runs in progress: `spentToday` is finished runs plus the live cost of open ones, so a run cannot overshoot the day unseen. Every run with a `task_id` and every `resume` run counts, a browser's manual fire included (counted, not gated).
- Limit state lives on the owner-keyed `usage` stream, not on the session snapshot (`snapshot.ts` and `streams.ts` have no room, and the limit is FinOps state).
- Boot turns `running` rows into `interrupted` (with their JSONL lines) before the sessions module exists; nothing in read-only mode.

## Consequences

- The figure is a lower bound of the session's real cost. Not counted, and named in `docs/agents/finops.md`: `auto_name` (a side call outside runs), M9's `lanes.suggestCommit` (a paid side call outside runs, controller C1) and branch summaries (made by the owner's `navigate` outside a run). Codemode classifier calls cannot happen (`models: false`).
- A subscription shows "API-equivalent", never money spent.
- A crash keeps the cost of messages already ended (the row is updated per message), loses the open message.
- Retention of the table is unlimited (a row is small).
