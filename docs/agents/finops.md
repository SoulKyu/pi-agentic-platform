# FinOps: runs, cost, budgets, limits, observability

Code: `apps/daemon/src/modules/runs/` (registry, observer, resume, usage stream, metrics), `modules/automation/limits.ts` (budget aborts), `kernel/observability/` (tracer, stall, Prometheus, OTLP), `compose-runs.ts`, `compose-trace.ts`, `compose-usage.ts`. Decisions: ADR 0043 (runs and cost), 0044 (observability), 0045 (limits and auto-resume). Triggers and tasks: `automation.md`.

## Runs and cost

- One row per Pi run in `runs` (ids, origin, status, tokens, `cost_usd`, turns, tool calls, `error_class`, `limit_reset_at`); never content. Origins: `user`, `extension`, `resume` (automatic continuation) and, for a task's runs, the task's origin (the fire's source, or `retry`). `expectOrigin(sessionId, {origin, taskId})` tags the next run start (5 minutes, consumed).
- Cost is Pi's `usage.cost.total`, the list price of the tokens, compaction included. `billing` is `api` (provider cost), `subscription` (labelled **API-equivalent** everywhere in the UI, never money spent) or `unknown`; it comes from `modelRuntime.isUsingSubscription(provider)` in the worker's loadout (`packages/pi-host/src/loadout.ts`).
- Each ended run appends one line to `$PAP_HOME/logs/runs.jsonl` (`v: 1`; `provider` and `model` through `labelValue`). Boot turns `running` rows into `interrupted`, and does nothing in read-only mode.
- `RunsPort.sessionCost(sessionId)` (synchronous; finished runs plus the live cost of the open one) is what M9's compare column reads, with `RunsPort.sessionBilling(sessionId)` for its API-equivalent label (a trigger cannot target a lane folder: agreement 16).
- `usage.summary {range: today|7d|30d}` (`usage:read`): totals, by origin, by model (top 50, the rest `other`); days are counted in the automation time zone. Shown in Settings › Automation › Spending.

## What is not counted

The daily budget and every cost figure are a lower bound: pap counts runs, not every model call.

- `auto_name` (the session-title call) is a side call outside runs: **not counted** in the daily budget.
- M9's `lanes.suggestCommit` (the paid ✦ Suggest commit message) is a side call outside runs: **not counted** in the daily budget. Neither are branch summaries (the owner's `navigate`, outside a run).
- Codemode classifier calls cannot happen (`models: false`). The OAuth refresh and provider usage checks are not model calls.
- Agreement C1 (controller): `auto_name` and `suggest_commit` side calls stay uncounted, and this file says so.

## Budgets

- Settings (`automation` document, browser-written only): `dailyBudgetUsd` (default 5; `null` no budget; 0 refuses every automatic run), `slots`, `paused`, `timezone`, `quietHours`, `autoResume`. A token cannot write it (`forbidden`).
- `spentToday(owner, timeZone)` = every run with a `task_id` plus every `resume` run today, finished runs (counted by the day they **ended**, so a run that crosses local midnight counts in full the day it ends and never lowers that day's total; a run is only looked for within 48 h of its start so `runs_owner_started` serves the query) plus the **live cost of runs in progress**. A trigger's own `dailyBudgetUsd` is checked against the cost today of its tasks' runs, live included.
- Gated (refused with `budget`, `budget_reached` for an RPC): schedule, webhook and feed fires, a token's manual fire or retry, a queued gated task when it starts, and across the run by `limits.ts`, which fails every running gated task of the owner `budget` once the total reaches the budget (and aborts automatic `resume` runs of interactive sessions). The owner's browser fire and retry are counted but not gated.
- **Click-resumes are not automation spend.** "Resume now" in the owner's browser runs under origin `user`: it is not counted as a `resume` run, the budget never aborts it, and `runningGated` skips a task whose current run has that origin, for the owner's budget and for the trigger's own. The next automatic step is gated again. A token's `usage.resumeNow` is not a click: it runs under origin `resume` (the continuation is tagged like a scheduled one), so it is counted and the budget can abort it, besides being refused with `budget_reached` / `automation_paused` up front. A continuation that starts no run (`handled`) or fails to send clears its expected origin, so the owner's next run is never taken for automation.
- **A trigger's own budget applies to its task's automatic resumes.** The `run.resume` handler checks it through `taskOf(owner, session)`, which answers only while the task is `limited` or `running` (it also resolves the task of a run that has none, so the chain never loses its trigger). Once the task has ended, its session is an ordinary one: a later quota resume there is the owner's, not the old trigger's, and is neither skipped nor charged by that trigger's budget. A resume skipped for the budget fails the task `budget` (`onResumeSkipped`); one skipped for an archived session cancels it.
- Per-run caps: `maxRunUsd` (webhook and feed default $1, explicit `null` no cap) fails the task `run_budget` and aborts; `maxRunMs` fails it `deadline`. Both restart on a task resume.
- Proofs: `security/automation-rulings.int.test.ts` (the click-resume exemption on both budget lines, with prices written on runs), `automation-tokens.int.test.ts` (token fires and `usage.resumeNow` counted and gated), `runner.limits*.test.ts`.

## Limits and auto-resume

- A run whose last stop reason is `error` with a provider limit text is `limited` (`runs/limits.ts`). With `autoResume` on, a reset time and a mode other than `full-access` (one exception, below), a `run.resume` effect is due at the reset plus 0 to 60 s of jitter. Rules, checks and marks: ADR 0045. The `usage` stream carries `limits[]`, `todayUsd`, `budgetUsd`, `autoResume`; the session header's limit chip offers "Resume now" and "Cancel auto-resume" for a session, and a task card offers "Resume now" and "Cancel task".
- Provider usage (quotas shown on the owner's click) is the models module's `models.usage`, see `models.md`; it is not part of the budget.

## Performance budgets (`budgets.json`, M13)

Final values, one number per key; a change is a deliberate edit of `budgets.json` and `scripts/budgets-keys.test.ts`. `pnpm budgets` first checks that every key is named, as a whole word, in each of its enforcers (`ENFORCERS` in `scripts/check-budgets.ts`), then prints each budget with its enforcers. The CI job `budgets` runs `pnpm budgets` then `pnpm test:budget`.

| Key | Value | Measure on 2026-10-18 | Enforcers |
|---|---|---|---|
| `initialBundleGzipKb` | 250 | 232.9 KB gzip | `scripts/check-budgets.ts`, `apps/web/src/build-output.int.test.ts` |
| `serviceWorkerGzipKb` | 5 | 3.8 KB gzip | `scripts/check-budgets.ts`, `apps/web/src/build-output.pwa.int.test.ts` |
| `sessionOpenPayloadKb` | 24 | 9.46 KB (ten exchanges) | `sessions.budgets.int.test.ts`, `daemon.int.test.ts` |
| `idleWorkerRssMb` | 200 | 180 MB | `sessions.budgets.int.test.ts`, `daemon.int.test.ts` |
| `searchP95Ms` | 200 | p50 7.6 ms, p95 106.0 ms (10 000 sessions); kept until a CI baseline exists | `search.budget.int.test.ts` |
| `scannerLatencyMs` | 2500 | 1 009 ms; large margin for slower CI hosts | `scanner.exit.int.test.ts` |

Re-measure:

- `pnpm build && pnpm budgets`: the two bundle figures.
- `pnpm test:int --silent=false` (or the two files `sessions.budgets.int.test.ts`, `daemon.int.test.ts`): the lines `session open payload: <n> bytes` and `idle worker RSS: <n> MB`.
- `pnpm test:budget`: search p95 and scanner latency (builds the 10 000-session corpus, about 65 s; the step takes about 2.5 minutes).

## Members: budget line and shared providers (M14, ADR 0085)

Code: `apps/daemon/src/modules/runs/member-spend.ts`, `apps/daemon/src/compose-boxes-budget.ts`, `apps/daemon/src/modules/users/{provider-sharing,provider-gate,auth-kinds}.ts`. The owner has no cap.

- **The cap.** the `budget_usd` column (REAL, USD per day, 0 to 1000, default 5), set by the owner in Settings › Users (`users.setBudget`, `users:admin`).
- **Two lines.** The **automation budget** (`SettingsService.automation(id).dailyBudgetUsd`) is clamped to the cap: for a member a stored or written `null` means the cap, otherwise `min(stored, cap)`. `settings.set` above the cap, or `null`, is refused `budget_cap`; `settings.get` returns the effective value and `dailyBudgetCapUsd` (null for the owner), which Settings › Automation shows as "Capped at {cap} USD by the owner." The **member line** is the member's whole API spend.
- **What the member line counts.** Every run of the member billed `api` or `unknown`, interactive sessions included, finished and live. Subscription runs through their own Claude token cost the owner nothing and are not counted; `claude-bridge` runs are excluded by provider (one shared constant, `CLAUDE_BRIDGE_PROVIDER`, for live and finished runs). The day is the owner's time zone, never the member's writable the `timezone` setting (R10): only the budget day uses it, at one seam (`RunsService.bindBudgetZone`); quiet hours and triggers keep the member's own zone.
- **Enforcement.** The relay policy answers `blocked: "budget"` once the line is at or above the cap, for agents and project boxes, and a refresh is pushed on `onRunEnd`. The overshoot is at most one tick (60 s) of spend. The block also stops the member's own bridge use.
- **`UserView.spentTodayUsd`** is the member line; the row shows "Today {spent} of {budget} · 7 days {spent7}", in `err` only when the spend reached the budget.
- **Disabled.** A disabled user's automation settings read `paused: true`, which covers fire, resume, queued and thread tasks, reminders, feed polls and limits through the existing pause checks (no per-path list). Their runs and audit rows stay.
- **Delete keeps cost.** `runs` and `audit` survive a user's delete (OQ2): costs and the misuse trail, no content.
- **Known limit (OQ5).** The line rests on the cost and provider label the VM reports. A member is root in their box and can under-report or relabel, so it guards against mistakes and is not a hard cap. A member's agents' own per-agent limits still use the caller's zone (`runs/agent-spend.ts`). Live spend is not bounded by the day.
- **Shared providers.** Table `provider_sharing(provider, shared)`. The default row is written the first time a provider is seen, at every overview build and on `onChanged`, never at boot (R11: a boot read starts a Pi helper and breaks the crash-restart guarantee). An API-key provider (by the relay's own rule, `models.json` literal and `$VAR` keys included) is shared by default; any other is not. OAuth (subscription) providers are never served to boxes, and Settings › Users shows their switch disabled with "Subscription login: never served to boxes. Members use their own Claude token." `claude-bridge` is exempt. A member's box policy, `sessions.models` and `sessions.availableModels` drop unshared providers; `users.setProviderShared` (audited `provider_sharing_set`) calls `relay.refreshAll()`. The auth kind is read from a cached `models.overview` (60 s, cleared on `onChanged`), so an out-of-band switch from OAuth to a key with no read in between can share by default until the owner unshares it.

## Agents: spend, budget and the resume exception (M11a)

- Every run of an agent session carries `runs.agent_id` (the thread, an isolated task, a delegation, a reminder; migration `202610151130_run_agents.sql`, copied from the session row by the observer, which saves progress before its live hook so the budget reads the row). A child's runs also carry `parent_session_id` (M11b). `runs/agent-spend.ts` sums them; there is no second counter. The status panel's today, 7 and 30 days are `agents.status`, from `runs` (API-equivalent on a subscription).
- **The agent's own daily budget** (owner m14): `AgentInput.budget {usdPerDay, tokensPerDay}`, both null by default (none; M10's owner-wide budget still applies to its automatic runs). `0` refuses every gated run. It is read from the profile at each gate, so a change applies at once with no worker restart and no password (money, not reach).
- **Gated:** an agent's schedule, webhook and feed fires, a delegation to it, a reminder firing, a thread task starting and an isolated task starting, each refused with `budget` when either total is reached; across the run, `limits.ts` fails the agent's running gated tasks `budget`. **Counted, never gated:** the owner's own messages in the thread, a browser fire, and a task the owner queued (`agents.queueTask`).
- **A paused agent** spends nothing on tasks: its fires journal `paused`, its queued tasks wait.
- **Resume exception (a5, decision 90, ADR 0045 and 0047).** An agent thread in `full-access` still auto-resumes after a quota reset when it runs in its microVM (every agent does), in the registry now and in the worker's start-time profile (`resume.ts`, `heldForFullAccess`). The mode used is the effective one (`modeOf`): the stricter of the agent's and the session's. The continuation is sent sandbox-only; a warm worker or a cold start without the sandbox refuses it and the resume is skipped as `full_access`. A full-access session of any other kind is still held (M10R104).

## Subagents: the roll-up (M11b, ADR 0053)

- **A child is never auto-resumed** (M11R139): a `limited` run of a `child` session plans no `run.resume`, and one planned earlier is skipped (`resumeSkipped` reason `child`), because its parent's call ended at the run end. The owner's own "Resume now" on the child's tab still works.

- A child's runs are `origin: "subagent"`. `subagents/service.ts` registers the origin with `RunsPort.expectOrigin(childId, {origin: "subagent", taskId})` before the child's first prompt, where `taskId` is the parent's open task from `openTaskOf` (null when the parent's run is not a task's). The table is bounded: when it is full the call fails `unavailable` and the row `origin_table_full`. A prompt that failed or a stop clears the entry.
- Every child run stores `parent_session_id` (the parent) and, for a child of an agent thread, `agent_id` (copied from the session row). So there is no second counter: `agentSpentToday` and the agent's budget see a child of its thread, and M10's `spentToday` and the trigger's budget see a child of a task's run through the task id. A child of a plain or lane session that is not a task's has no budget line of its own (the owner's own work, as the thread's messages are).
- `RunsPort.sessionCost(parent)` and `sessionBilling(parent)` add the runs whose `parent_session_id` is the parent, finished and open (a live child counts in `liveCost`; a parent with only open child runs reads billing `unknown`). M9's compare column uses it. `ChildView.costUsd` is the child's own `sessionCost`, refreshed at the child's status changes and ending, not at every reply.
- `maxRunUsd`: `limits.ts` finds a run's task with `bySession.get(session) ?? runs.openTaskOf(session)` and compares `spentByTask(owner, task, since)` (finished runs of the task since it (re)started plus its open ones, children included) with the cap. A child alone reaching the cap fails the parent task `run_budget` and aborts the parent run, which stops its other children (`sessions.md`). A resumed task restarts `since`.
- At admission only the agent's own line is asked (`subagents/budget.ts`, `budget` when today's spend, children included, reached its `usdPerDay` or `tokensPerDay`); M10's owner-wide budget is not.
- The hourly cap (30 per owner) counts every start, a failed one too.

## Metrics, trace, stall, OTLP

- `/metrics`: off unless `PAP_METRICS_TOKEN` (32 to 256 characters); own bearer; families from the `runs` table (cached 15 s), automation (`pap_tasks`, `pap_trigger_fires_total{source,verdict}` in-process (one count per journal event, a collapsed refusal row included; `fire-counts.ts`), `pap_outbox_effects`, `pap_automation_paused`, `pap_budget_spent_usd_today`, `pap_budget_usd`) and the kernel (`pap_workers_*`, `pap_event_loop_*`, `pap_otlp_dropped_spans_total`, process gauges). `provider` and `model` labels: `labelValue` plus the 100 most expensive models (`topLabels`).
- Trace: `$PAP_HOME/logs/trace.jsonl` (0600, rotated at 10 MiB, nine rotated files kept), closed span names and attributes. `pap trace summary [--since 15m|2h|1d]` works while pap runs (count, rate, p50/p90/p99/max, failures per span name; exit 64 on a bad flag).
- Stall monitor: a sample every 30 s on the Clock; over 2 s of delay while active is an `event_loop_stall` warning, a span and two counters.
- OTLP JSON export: opt-in with `PAP_OTLP_ENDPOINT` (settings in `daemon.md`). Spans every 10 s, a metrics snapshot every 60 s, 10 s timeout, no redirect, no retry before the next interval, `otlp_export_failed` logged (rate-limited). It is the only telemetry-shaped outbound request pap starts.
- Settings › Automation › Observability shows whether `/metrics` and OTLP are on (host only) and the trace hint; nothing there is writable.
