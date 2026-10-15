# ADR 0041: automation runs before agents

Status: accepted (M10, Task 24). A deviation from C §5.3 and §6.1 until M11.
Date: 2026-10-15
Spec: C §5.3, §6.1. Rulings: M10R26 to M10R32, M10R36 to M10R44, M10R130 to M10R139, M10R152 to M10R155.

## Context

C §6.1 describes triggers that start agent runs with an `isolated-task` profile. Agents arrive in M11; the owner wants schedules, webhooks and feeds now (decision 81, owner m10q1). Before agents there is no sandbox (bwrap is M11) and a webhook payload is text from outside.

## Decision

- A trigger belongs to a project folder. Each firing makes a task and an isolated task session in that folder, with the `interactive` profile narrowed by a closed tool list per trigger (`TriggerInput.execution.tools`, 1 to 32 names, Pi's read tools by default).
- Stage 02 of pap-policy checks the list by exact name first, then, while `rules.unattended`, blocks a tool of category `unknown` and every command the reader cannot check (lever B withholds its question). The worker pins the list it started with: a late or wrong `policy_update` can narrow it, never lift it. The preset is `read-only` only when every listed tool is one of `read grep find ls`; any other name makes it `full` and the approval matrix asks per the mode.
- `full-access` is never a trigger mode, and `setSessionMode` refuses `full-access` and `null` on a session whose task runs (`session_busy`); `taskRules` also clamps a stored `full-access` to `supervised` while unattended.
- The default mode is `supervised` for webhook and feed triggers (outside text) and `auto-accept-edits` for schedule and manual ones. There is no runner clamp: an explicit owner choice is kept, and the editor note and the dry-run say exactly what runs unasked (ruling of Task 5a, RT-13).
- Webhook payloads, feed entries and precheck output reach the model only inside one fence (`fenceText`); the run starts tainted.
- A question from a running task waits in the Inbox for 10 minutes; at the timeout every open approval is denied (actor `system`) and the run goes on.
- Automation never takes the last worker (`live + starting + 2 <= maxWorkers`), a finished task's worker is released, and a done task session is archived, then deleted with its Pi file 30 days after the task when never reopened. "Use my normal tools" (browser, password step-up) lifts the list after the end, by task or, once housekeeping removed the task row, by session.
- The Tasks board has one column per project with the project's triggers in a strip on top.

## Consequences

- Board 11's excluded `git push` cannot be expressed by a by-name list. A trigger that lists `bash` can push, subject to the mode's questions, until bwrap and M11's per-command rules. The editor does not offer the line.
- An extension tool without annotations cannot run in a trigger until it declares a category. A busy day of alerts stops at the daily budget ($5 by default). With `PAP_MAX_WORKERS=2`, one automatic run at a time.
- A crash between a draft session's Pi file and its row leaves a file the scanner adopts as an outside session (tainted, no list); the file of a deleted task session can be adopted again after a crash between the row and the file (see `docs/agents/automation.md`).
- M11 adds agent triggers beside project triggers (M10R130); this profile stays the one for project triggers.
