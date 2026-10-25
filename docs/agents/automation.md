# Automation (triggers, tasks, the Inbox)

Code: `apps/daemon/src/modules/automation/` (triggers, tasks, fire path, runner, hooks, scheduler, feeds), `modules/inbox/`, the kernel outbox (`kernel/outbox/`), composition in `compose-m10.ts` and `compose-automation.ts`. Decisions: ADR 0040 (outbox), 0041 (automation before agents), 0042 (webhooks), 0046 (feeds and the precheck). Rulings: `docs/research/m10-rulings.md`. Money: `finops.md`. Screens: `web.md`.

## Triggers

- A trigger belongs to an owner and a project folder (`execution.cwd`, real path, never inside `$PAP_HOME` or Pi's agent folder). At most 200 per owner. `TriggerInput` (contracts) is the trust boundary of every write; the store keeps the parsed JSON and parses it again on every read (a row that no longer parses reads as `state: "unreadable"`, never fires, can be deleted).
- Sources: `schedule` (RRULE subset + time zone + catch-up), `webhook` (`secret` or `hmac`, format `raw`, `alertmanager` or `grafana`), `feed`, `manual`.
- `create`, `update` and `rotateSecret` take the password step-up; switches (`setEnabled`) and `delete` do not. `update` is compare-and-set on `revision`. Every change appends an audit row (kind `policy`, decision `info`; ids, source, mode and counts only, never the prompt, command, folder or secret). A token holds `automation:operate` at most (fire, dry-run, cancel, retry); `automation:admin` (create, update, rotate, delete, setEnabled, releaseTools) is outside `TOKEN_PERMISSIONS`, and a token cannot write the `automation` setting (`forbidden`). A token reads a trigger without its precheck and env, and a feed trigger's URL without query or userinfo (a private feed carries its credential there); the owner's browser sees the stored one.
- Webhook secret: `pwh_` + 32 random bytes, shown once, stored in `$PAP_HOME/secrets/triggers/<id>.key` (0600), never in the database. Turning a trigger from `secret` to `hmac` issues a new secret shown once; `hmac` to `secret` keeps the key.
- Prompt template: `{{payload}}` (at most once; `{{precheck}}` is refused on save and renders empty in an old stored template), `{{trigger}}`, `{{firedAt}}`; one pass, inserted text never read again. A payload is always fenced (contracts `fenceText`, fresh 12-hex id) and the run starts tainted. A rendered prompt over 131 072 characters is `prompt_too_large` (the hook answers 413).

## Webhooks (`hooks-http.ts`, `hook-auth.ts`, `hook-slots.ts`)

- `POST /hooks/<id>`: ADR 0042 has the order of checks, the two body pools, the statuses and the residuals. The journal line for refused attempts is one collapsed `unauthorized` row per trigger and 10 minutes with a count.
- Prechecks are gone ("Prechecks removed" below).
- Alert formats map `alerts[]` to one line per alert (50 at most, 512 characters each), dedup identity = group status + sorted fingerprints; `onResolved: skip` drops resolved-only notifications.

## Schedules (`scheduler.ts`, contracts `rrule.ts`)

- RRULE subset: `MINUTELY;INTERVAL=5..1440`, `HOURLY[;INTERVAL=1..24][;BYMINUTE]` (at most 12 minutes), `DAILY;BYHOUR[;BYMINUTE]`, `WEEKLY;BYDAY;BYHOUR[;BYMINUTE]` (`DAILY` or `WEEKLY` without `BYHOUR`, and `WEEKLY` without `BYDAY`, are refused). Wall time in the trigger's zone; a nonexistent time (spring forward) fires after the gap; a repeated time (fall back) fires at both instants for `MINUTELY` and `HOURLY`, once for `DAILY` and `WEEKLY`.
- One guarded timer for the earliest `next_fire_at`; every trigger due at that instant is handled from the one tick. A fire more than 2 minutes late is missed: `catchUp: skip` journals `missed N`, `catchUp: once` fires once when the last miss is within 12 h.
- Quiet hours do not stop runs (only M12's pushes wait).

## Feeds (`feed-poll.ts`, `feed-fetch.ts`, `feed-parse.ts`, `net-guard.ts`)

- Polled every 15 to 1440 minutes (default 360) as a `feed.poll` effect. The first poll after creation (or a URL change) marks every entry seen and fires nothing. Seen keys are kept per trigger (1 000, oldest dropped) and marked only when the entry fired. More than 10 new entries: the 10 newest fire, the rest are marked seen.
- **Not fetched while automation is paused or the owner is over budget.** The poll writes its own journal line and sets no baseline, so the first poll after the pause still treats the entries as new. Also never fetched: a disabled or deleted trigger, a dry-run, a read-only daemon.
- Address guard, redirects, parser limits: ADR 0046. Logs: `feed_fetch {triggerId, status, bytes, durationMs, code}` (never the path or the body), `feed_poll_failed`.

## Prechecks removed (lot B1, ADR 0083)

- A precheck ran a shell command on the host before a fire. The owner does not use them and the host no longer runs such code, so they are removed for every trigger (agents' since ADR 0081, now all). `precheck.ts`, its port, queue and step are deleted; nothing in automation spawns a process.
- **Save.** `TriggerSaveInput` (create and update) refuses `execution.precheck`, `execution.env` and `{{precheck}}` in the prompt. A stored trigger still parses (`TriggerInput`).
- **Fire.** A stored trigger that holds a precheck is refused at every fire, by the scheduler, a manual fire, the feed poll, a webhook fire (`409 {reason: precheck_removed}`) and a task retry (`conflict`), with the journal verdict `error` and the detail `precheck_removed` (`PRECHECK_REMOVED`, `precheck-refusal.ts`; one collapsed row per cause). No task is made. A stored precheck on a webhook trigger is refused too. It is checked before the pause and budget gates, so a paused owner's stored precheck journals `precheck_removed` rather than `paused`. The dry-run answers the same word (outcome `error`, reason `precheck_error`).
- **Form.** The precheck and environment-name fields are gone. A stored trigger that has one shows a disabled field with "Prechecks were removed: clear this field." and a Clear button; saving is blocked until it is cleared. Old journal rows keep their words (`precheck`, `precheck_agent`).
- **Triggers on a box root.** A trigger whose `execution.cwd` is at or under a box project's root (`/boxes/<id>/project`) stores that cwd as given and runs its task session in the project's box, unattended as before (tool allowlist, mode clamp). `resolveFolder(cwd, ownerId)` matches the box with `boxCwdOf`, without `realpath`; `projectPort` of the automation module (`project-port.ts`) cancels a deleted project's queued, running and limited tasks, then removes its triggers and secret files. The box starts for the task if it is stopped; its launch taint applies (`agents-vm.md`).

## Tasks and the runner (`fire.ts`, `runner.ts`, `admit.ts`, `limits.ts`)

- `fire(triggerId, revision, input)` is the only writer of tasks: one synchronous transaction re-reads the trigger by revision (`changed` otherwise), runs the gates, renders the prompt, writes the journal row and, on `fired`, the task (`queued`) and a `task.start` effect. The webhook answers 202 after the commit.
- States: `queued`, `running`, `limited`, `done`, `failed`, `interrupted`, `cancelled`; terminal states are immutable (a trigger forbids moving them). Completion comes from `RunsPort.onRunEnd` matched by session id; a runner abort (`deadline`, `run_budget`, `budget`) is tagged with `markEnding` so it is not read as a person's Stop.
- Admission (`task.start`): one pick across eligible owners, the oldest queued task of the trigger whose last start is oldest; slots are per owner (`slots`, default 2); a capacity refusal (one worker is always kept for the owner) puts the task off 30 s; a task whose gated budget is spent when it starts fails `budget`. The folder is checked again at start.
- Limits of a running task: a deadline (`maxRunMs`), a per-run cost cap (`maxRunUsd`, $1 default for webhook and feed triggers), the daily budget across runs, and the question timeout (10 minutes, then every open approval is denied with actor `system` and the run goes on). A task resume restarts the deadline and gets a fresh run cap.
- Cancel: `queued`/`running`/`limited` become `cancelled` and the pending resume is retired in the same transaction; the run is aborted directly after the commit (no outbox effect). A resume that is already sending is aborted at its first run start (`abort-next.ts`, ADR 0045). Retry makes a new task (`origin: "retry"`) through `fire`: the owner's browser repeats the old task's prompt, taint and policy snapshot and, like a manual fire, runs even when the trigger is disabled (M10R57); a token's retry is refused (`conflict`) on a disabled or deleted trigger and runs under the trigger's CURRENT tools, mode, env and caps (`maxRunUsd`, `maxRunMinutes`, `retryOnInterrupt`), so a list the owner has narrowed is never widened by it; `retryOnInterrupt` retries an interrupted task once at boot.
- Boot (not in read-only mode): `running` tasks become `interrupted`, orphan task sessions are archived with their policy ended, queued tasks without a pending `task.start` get one.
- Housekeeping, hourly and guarded: outbox purge, deletion of done task sessions 30 days old that were never reopened (session row, then the Pi file, only inside Pi's sessions folder), terminal tasks older than 30 days, the journal cut to the newest 500 rows per trigger (never a `fired` row newer than the trigger's dedup window), the Inbox retention, and the day's `attachment.cleanup` effect.

## Profile of a task session

| Trigger setting | Effect |
|---|---|
| `tools` (closed list, 1 to 32 names) | exact-name allowlist at stage 02, pinned in the worker; unknown-category tools and unreadable commands block while the task runs |
| `tools` all in `read grep find ls` | preset `read-only` (MC36 applies) |
| any other name | preset `full`; the approval matrix asks per the mode |
| `mode` `read-only` | blocked: `bash`, `edit`, `write` never run |
| `mode` `supervised` | each call asks in the Inbox; unanswered after 10 minutes it is denied |
| `mode` `auto-accept-edits` | `edit` and `write` inside the folder run unasked; `bash` asks |
| `full-access` | never accepted; refused on the session while the task runs |

- **Mode note (RT-13).** An absent `mode` becomes `supervised` for webhook and feed triggers (outside text) and `auto-accept-edits` for schedule and manual ones, made explicit before the value is stored. The runner does not clamp: an explicit `auto-accept-edits` on a webhook trigger is kept. The editor note under `bash`/`edit`/`write` and the dry-run's `editsUnasked` line ("edits in this folder run unasked") say exactly what runs without a question.
- Taint comes from fenced input (sticky, ADR 0020). `git push` cannot be excluded by a by-name list (ADR 0041).
- "Use my normal tools" (`automation.tasks.releaseTools`, browser, step-up, audited) lifts the list after the task ended and releases the worker, by task id or, when housekeeping removed the task row, by session id.
- Hidden characters (bidi controls, zero-width, other `\p{Cf}`, C0/C1 controls except tab and new line; tag characters U+E0000-E007F are `Cf`) are stripped at ingestion (a webhook's raw payload text, feed entries) and again in `fence()` (`prompt.ts`), the one place every fenced input passes: `{{precheck}}` output and a manual or token fire's payload too. The agent never receives them. In the UI the fence frame shows a visible marker where characters were removed; trigger names show them escaped.

## Agent triggers, tasks and reminders (M11a, ADR 0050)

Project triggers keep everything above (ADR 0041). A trigger that runs as an agent has `execution.agent {agentId, target}` and no `cwd` (exactly one of the two; M10 configs parse unchanged with `agent: null`). The agent must be the owner's (`not_found` otherwise), and its home becomes the trigger's folder. The column `agent_id` and the config must agree, or the row reads `unreadable`.

- **Targets.** `isolated`: a fresh `agent-task` session (role `task`) with the closed tool list, mode the trigger's (never `full-access`), the agent's home read-only, a scratch folder `$PAP_HOME/agents/.runs/<agent>/<task>/` as its cwd, the agent's microVM (a task VM of its own), hosts and budget. The folder is removed with the task's session. `thread`: a prompt into the agent's trusted thread. A webhook or feed trigger can only be `isolated` (the contracts refine refuses `thread`), and a thread-target trigger may not use `{{precheck}}` (W5-R32).
- **Thread tasks** (`runner-thread.ts`): one per agent at a time; admitted only into an idle thread (a cold or missing thread is opened through `agents.openThread`); a busy thread puts the task off 10 s, which is not an attempt. The card is written, then `expectOrigin`, then the prompt, whose first line is fixed: `[pap <kind> · <title>] Sent by pap for the owner, not typed by them.` A delegation's line says it is not from the owner (W5-R39). Origins are `remind` and `delegate` for these tasks. A tainted prompt into the thread fails the task `tainted_prompt` (except a reminder set by the same session). The deadline aborts the run; the thread is never archived and no task policy is ended. The run end settles the task only when the run carries the task's id. Many thread tasks may share one session (`tasks_session` unique only for non-thread tasks, migration `202610151131_thread_tasks.sql`).
- **Payloads and tokens.** A fire of a thread-target trigger with a payload is `bad_request` for any caller, before the precheck or any write. A token's fire of a thread-target trigger is `forbidden`. A token may fire an `isolated` agent trigger (the payload fenced, M10's gates and the agent's budget apply). Webhook and feed payloads, entries and precheck output reach an isolated run inside one fence and the run starts tainted. A token never queues a task for an agent.
- **Precheck: removed** (above). It was already refused for agents (`precheck_agent`); that word is now `precheck_removed` for every target.
- **Pause and quarantine.** A paused agent's queued tasks stay queued and start about 30 s after it resumes; running ones finish. A quarantined agent's queued tasks are cancelled (`quarantined`). Deleting an agent deletes its triggers, cancels its queued tasks and refuses while one runs or starts.
- **Retry** makes a new task with a new, empty scratch folder; an outbox re-run of the same task reuses the folder and starts tainted when it holds files (W5-R30).
- **Result cards.** An isolated run writes a summary card in the thread (`isolated`, the last assistant text, stripped, clipped to 2 000, untrusted) when it ends `done` or `failed`; the thread reads that card and the task's scratch folder as external content (only the task itself reads its own folder unfenced, W5-R9).
- **Delegations and reminders** (`agent-tasks.ts`): `agent.delegate` makes a thread task for an opted-in target, or, tainted and allowed, an isolated tainted task; its result goes back as a card and an Inbox reply. `agent.remind` makes a thread task with `not_before` (the scheduler arms the nearest due time on the Clock, `due-timer.ts`). The reminder stores the setting session (`set_by_session`, migration `202610151153_task_setter.sql`); a tainted one fires only into that session, otherwise it fails closed with a card that says why. A reminder or delegation set inside a delegated run keeps `requested_by`, so depth stays 1.
- **Budget.** `agent-budget.ts`: the agent's own `usdPerDay` and `tokensPerDay`, see `finops.md`.
- Inbox items of agent tasks carry `agent_id`; the board has one column per agent (`web.md`).

## Inbox (`modules/inbox/`)

- M10's rows: one per task and kind (agent kinds are in ADR 0051 and `agents.md`; the stream and filters below hold for both): `task_needs_input` (to handle; resolved by an answer or by the 10-minute timeout, shown "denied (no answer)"; a new question of the same task reopens it), `task_done`, `task_failed`, `task_interrupted`, `task_limited` (info). A cancelled task gets no item. The `inbox` stream carries every unresolved to-handle row plus the newest 100 others, `unread` and `toHandle`; `inbox.markRead` takes ids (200) or `all`.
- Retention: read items that are not an open question go 30 days after their creation (hourly housekeeping); 2 000 per owner (read info rows evicted first, a to-handle row always written, a new info row skipped and logged `inbox_full`).

## Read-only mode and timers

- A database written by a newer pap opens read-only: no recovery, no outbox worker, no scheduler, no housekeeping, no feed poll, no trace or stall file write, no OTLP timer; `/hooks` answers `503 read_only`; mutations answer `read_only`. Every timer callback runs through `guardTimer` (`<name>_failed`, once a minute per name).

## Health

- The daemon's failure console (`modules/health/`, its own note: `health.md`): every failure the fire path already logs also emits a health event — feed results (`feed_fetch`, `feed_poll_failed`), the scheduler's failed tick and missed fires, the precheck's `error`, the runner's task failures.
- The outbox's handler failures and overdue handlers come from the kernel outbox itself (`onFailed` / `onOverdue`); an effect without an owner stays log-only.
- Events land in a 500-row in-memory buffer, collapsed per identity, shown on the Health screen of Settings; see `health.md` for the buffer, the permission and the emission rule.

## Residuals

- The draft Pi file adopted after a crash: a task session's row is inserted once its worker is ready; a crash before the commit can leave a Pi file the scanner adopts as an ordinary owner session (tainted, no list).
- The deleted session's file re-adopted after a crash: deleting a done task session removes the row, then the file; a crash between the two leaves a file the scanner adopts as an outside session.
- An extension tool with no annotations cannot run in a trigger (blocked while unattended), unless the owner declared it a local tool (Settings › Approvals, decision 117): it is then a read, and it runs unattended only when the trigger's tool list names it (the allowlist still blocks any tool it does not name, by name). What declaring it allows: the owner vouches that the tool reads nothing from outside the machine, sends nothing outside and does not modify their files, and its calls then run without asking in every mode, read-only included, even after external content. An agent trigger's isolated task blocks a local tool even when the trigger lists it: a non-built-in read is never inside an isolated task's reach.
- A project trigger that lists `bash` can push to a remote; the question mode (`supervised`) is the only guard. Agent triggers run in the agent's microVM, and so do triggers of a box project; a host project's triggers have no box until lot B4 (ADR 0041).

## Log lines and test seams

- Lines: `outbox_recovered`, `outbox_unknown_kinds`, `outbox_handler_overdue`, `outbox_handler_error`, `automation_boot_recovered`, `hook_unauthorized`, `hook_backoff`, `hook_unknown_flood`, `hook_failed`, `scheduler_trigger_failed`, `task_*_failed` (abort, release, end step, orphan session), `inbox_full`.
- Tests: `PAP_TEST_OUTBOX_HOLD` (daemon.md), the `feed-bed` resolver seam (`modules/automation/testing/feed-bed.ts`: a local HTTPS server, `allowed` set only in tests), `security/testing/steppable-clock.ts`; security suites in `apps/daemon/src/security/automation-*.int.test.ts` and `webhook.int.test.ts`.

## Disabled owners (M14, ADR 0085)

- A disabled user's automation is paused through one seam, not a list of paths: `SettingsService.automation(id).paused` is true for them, and every gate already reads it (fire, resume, queued and thread tasks, reminders, feed polls, limits). Their boxes and agent VMs cannot start (`account_disabled`, `agents-vm.md`) and the relay answers `blocked: "paused"`. The journey test `apps/daemon/src/m14.disable.int.test.ts` drives fire, queued tasks and the launch gate.
- A member's `dailyBudgetUsd` is clamped to their cap (`finops.md`, "Members: budget line and shared providers"). Deleting a member cancels their tasks and deletes triggers and sessions before agents go to the trash, so a busy agent task cannot leave the account stuck disabled.

