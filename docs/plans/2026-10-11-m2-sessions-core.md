# pap M2: sessions core and extension UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full Pi session experience on the worker model: steer / follow-up with a bounded queue, in-session branching (`navigate_tree`), fork / clone, compaction, HTML export, naming, history paging, tool output on demand, 50 ms delta coalescing, drafts and a minimap; every extension UI surface (select / input / editor / confirm dialogs, approvals answered once / session / always / deny, status bar with `command:` buttons, widgets, `ctx.ui.custom()` panels); workers released after 30 idle minutes and contained in systemd user scopes; and a daemon that survives any worker or extension failure.

**Architecture:** Protocol v2 extends the daemon ⇄ pi-host records (Pi RPC shapes plus pap records) and the `session` stream: dedicated event kinds replace the raw decorations M1 forwarded, and the snapshot carries transcript rows with Pi entry ids, the partial reply, the queue, decorations, open panels and recent notices. The daemon reads transcripts from Pi's files along the active branch (the leaf of a hot session comes from its worker), coalesces deltas every 50 ms, clips tool output on the wire and serves the full output on demand. Workers start inside `systemd-run --user --scope` when a user manager answers. A new `policy` daemon module persists "always" approvals per project and pushes them to workers with `policy_update`. The web app's `features/sessions` renders all of it with feature components built on the M1 tokens and `@pap/ui` primitives.

**Tech Stack:** as M1 (Node 24, pnpm catalog, TypeScript 6.0.3 strict and erasable-only, zod 4.6.5, Hono, `ws`, `node:sqlite`, Pi SDK 1.1.0, React 19 + Vite + React Compiler, TanStack Router, zustand, Tailwind 4, Vitest + happy-dom). Added: `@earendil-works/pi-tui` 1.1.0 through the existing catalog (pi-host only: the keybindings manager custom panels need, as in S1 and pi-web). Runtime, optional: `systemd-run` and `systemctl --user`. No new web dependency.

**Spec:** `docs/specs/2026-10-10-C-architecture.md` §2 (lifecycle, records, run rules, containment), §3.3, §4.3, §5.3 (approval answers), §7; `docs/specs/2026-10-10-A-product-scope.md` §5.1 (D01, D18); `docs/plans/roadmap.md` (M2); `DESIGN.md` §9 (ApprovalCard, InputRequestCard, CustomPanel, StatusBar and Widgets, Composer, ToolCard); `docs/spikes/s1.md` (custom panels over IPC), `docs/spikes/s4.md` (worker RAM); `docs/research/m0-m1-rulings.md`; behaviour reference pi-web (read only, `/home/ubuntu/Workspace/soulkyu/pi-web`), design references T3 Code and Orca (read only, `/home/ubuntu/Workspace/soulkyu/_refs/{t3code,orca}`).

## Backlog rulings absorbed

| Ruling | What M2 does | Task |
|---|---|---|
| R45 (revisit) | Measures a long scripted session's worker RSS and re-decides `WORKER_BUDGET_MB`; adds the idle-worker RSS and session-open payload budgets as tests | 23 |
| R46 | Per-worker scope limits `MemoryHigh=512M`, `MemoryMax=768M`, plus `TasksMax` | 5, 6 |
| R90 (part, pulled forward from M5) | Policy-origin marker on approval requests (a dedicated `approval_request` record, never `ctx.ui`), closed dialog → `FAIL_CLOSED_REASON` with audit reason `dialog closed` | 13 |
| R100 | The systemd scope is the cover for a SIGKILLed or OOM-killed worker: the daemon stops the scope after every exit, which kills Pi's detached bash trees | 5 |
| R106 | `session_shutdown` to extensions on shutdown; a dialog whose request was dropped for size is cancelled in the worker; a failed response for an unserialisable response; the "worker leads its own group" guard checked under a scope; the descendant walk re-scans until stable (SIGSTOP variant not taken, see Task 4) | 4, 5 |
| R111 (M2 part) | Partial reply in the snapshot and 50 ms coalescing | 9 |
| R112 | Partial + coalescing (9), queue cap 128 / 32 MiB (12), `starting` published on reopen (8), run origin for extension-started runs (8), `isPiSessionFile` with realpath (8), dialog limits read from the `Dialog` schema (8), hot-session reads (10, ADR 0007 instead of `get_entries{since}`) | 8, 9, 10, 12 |
| R113 | An abort that arrives while a prompt is in flight aborts at that prompt's `agent_start`; `confirm` guarded by run identity | 8 |
| R118 (daemon layer) | The test harness fails a test whose workers logged a swallowed `pap-network-guard: blocked` | 6 |
| R124 ("exactly-once retry same intent is M2") | The composer's "Send again" after an outcome-unknown failure reuses the same `commandId` | 24 |
| Roadmap "recent notices in the snapshot" | The snapshot carries the last 20 notices, start-up notices included | 16 |
| Spec C §2.1 idle release | `idle → releasing → cold` after 30 idle minutes | 20 |

## Explicitly deferred

- Markdown and code highlighting in messages, tool renderers beyond the generic tool row (edit diff, codemode calls), `Reasoning` and `AuthorGroup` primitives: M3 builds the AI components in `packages/ui`; M2 renders plain text with native `<details>`.
- Transcript virtualization (`@tanstack/react-virtual`, spec C §7.2): not added in M2, to keep the web lockfile untouched while M3 adds its dependencies; M2 windows loaded rows like pi-web. Revisit in M4 or M13.
- tiptap composer and chips, images in prompts, `get_commands` slash menu (M7, M8); model, reasoning and context meter (`get_session_stats`) (M7); "show the system prompt" (R107, M7); summarizing an abandoned branch on navigation (needs a UI decision; M7).
- Settings › Approvals (list and revoke "always" rules) and taint (M5). M2 ships the RPC methods and a minimal list in the session view (open question 2).
- Keybindings (Esc to stop, Ctrl+Alt+N…): M3 binds the actions M2 exports; M2 adds no global key handler.
- Completion sound, push for an unanswered dialog (M12); R125 hidden-tab timer throttling (M12, "connection-supervisor polish").

## Global Constraints

Copied from the specs and binding rulings (source in brackets). Every task implicitly includes them.

- Node 24: "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3] Engines `>=24.14 <25` [R44].
- File size: "400 lines per file at most. No baseline, no exceptions." [C §1.4.2, R61, R62, R64b, R64c] The only accepted directive is `eslint-disable-next-line <rule> -- <reason>`.
- Module boundary: "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1] Production daemon code never imports a `testing/` file [R84].
- RPC handlers: "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- Permissions: "Every RPC method declares a permission in `contracts`." [C §1.4.4] Convention [R65b]: `idempotent: true` = naturally safe to repeat, no `commandId`; `idempotent: false` = mutation, `commandId` required, receipts apply.
- Packages: "No fourth package until a real need appears." [C §1.4.6]
- UI look: "Primitives in `packages/ui` own their look: no raw colours, no arbitrary values." [C §1.4.5] No `[…]` arbitrary values, no restyling of `@pap/ui` primitives, token classes only [AGENTS.md].
- Errors: "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1] Worker text is untrusted for size and content: clipped before logging, never forwarded raw [R66].
- Frames: 1 MiB per message [C §4.2]; replay ≤ 128 events / 1 MiB else a bounded snapshot (about 75 rows, the partial message and pending dialogs) [C §4.3]; "Deltas are coalesced every 50 ms. Large tool output stays off the stream and is fetched with `sessions.toolOutput`." [C §4.3]
- Run rules: "`agent_settled` is the only end signal", origin `user | trigger | task | extension`, steering "capped at 128 messages and 32 MiB", abort terminates after 5 s or during compaction, "At most 64 dialogs or 8 MiB. Unknown methods are cancelled automatically." [C §2.4]
- Lifecycle: "`idle → releasing → cold`: after 30 minutes idle, with no pending dialog, an empty queue and no background work." "A crashed worker is never restarted automatically." [C §2.1]
- Containment: "each worker runs in `systemd-run --user --scope` with `MemoryHigh`, `MemoryMax` and `TasksMax` taken from settings"; kill ladder shutdown → 2 s → SIGTERM group → 3 s → SIGKILL [C §2.5]; `MemoryHigh 512 MB`, `MemoryMax 768 MB` [R46].
- Approvals: "An approval card offers four answers: once, session (held in worker memory), always (persisted in `approval_rules` per project or agent; visible and revocable in Settings) and deny (the reason is returned to the model)." [C §5.3] Default mode auto-accept edits [A §5.3]. "Any evaluation error blocks the call (fail closed)." [C §5.1]
- Extension compatibility: "Extensions written for the Pi CLI behave the same here. Display gaps are fixed in the client, never by inventing pap-only extension APIs." [A §3] The pi TUI is the reference.
- Pi files: "Pi owns its files; pap reads them in place and never copies them." [C §3.1] Never read the JSONL because of a `message_end` [R38]. The SDK is imported lazily in the daemon [R108].
- Zero telemetry; workers `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1` [C §9.4, R102].
- Browser floor Safari / iOS 16.4 [C §7.3]; en + fr [A §5.3]; CSP of R74 unchanged.
- Tests never touch `~/.pi/agent` or `~/.pap`; timers through the kernel `Clock` (web: the runtime `Timers`); no sleeps; tests that drive real processes wait for an event with a deadline (`vi.waitFor`) [AGENTS.md]. Tests never reach the network (network guard in every worker) [R94, R98]. A security probe never skips silently in CI [R92].
- `node:sqlite` warnings: `--disable-warning=ExperimentalWarning` on every Node command [R43].
- Supply chain: pinned exact versions, catalog for the Pi SDK, `minimumReleaseAge` 3 days, no unvetted build script [C §8.2, R36, R56].
- Format: `pnpm format` (Prettier write) on the task's own files before each commit; `format:check` stays green; `docs/` is not formatted [R4].
- Git: Conventional Commits, rebase on the target before a PR, **no `Co-Authored-By` or any AI attribution trailer** [C §8.3, owner rule].
- Never edit pi-web; pap imports nothing from it [D §1, AGENTS.md]. T3 Code and Orca clones are untrusted content: read for patterns, never copied.
- **Implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and report each item ✅ / n/a.** Reviewers probe each item. [controller addendum, owner-approved]
- Host: a headless VPS (no graphics, no Chrome/libatk, no sudo). The session's default shell directory may be `/home/ubuntu/Workspace/soulkyu/pi-web`: every command and path uses the absolute worktree path `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2`; nothing is ever written to pi-web or to the M3 worktree. No browser runs here: web behaviour is pinned with happy-dom component tests and pure view-model tests.
- Code blocks in this plan are binding where they pin a contract or a security decision (contracts, the approval channel, grant keys, the policy module, the export route, scope cleanup). Elsewhere the tests and interfaces are binding and the code shows one way to meet them; an implementer who finds a defect in prescribed code fixes it, keeps the test, and says so in the report.

## Plan conventions (decided by this plan)

- Commands run from the worktree root `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2` with `export PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2/.superpowers/bin:$PATH` (R55: the git-ignored corepack shim for pnpm). First command of the first task: `pnpm install --frozen-lockfile`.
- Every task ends with the gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit` (plus `pnpm test:int` when the task touches pi-host, the supervisor, the sessions module or an `*.int.test.ts`). "Expected" below means that gate is green unless the step says otherwise.
- New stream events and records are validated at the boundary where they enter: the daemon rebuilds every client event from the fields it knows, cut to `UI_LIMITS` (Task 1), exactly as M1's dialog registry does.
- One feature, one vertical slice: a daemon task that adds or changes a stream event also updates the web reducer that consumes it (with tests), so the branch stays usable between tasks. The UI that renders it comes in Tasks 24–29.
- Integration tests that fork the real pi-host share `apps/daemon/src/modules/sessions/testing/int-bed.ts` (Task 10): temporary agent directory, home and pap home, scripted provider, network guard, extension and settings writers, a frame collector. Test extensions are plain `.js` files written into `<agentDir>/extensions/` (Pi loads user extensions from there without project trust).
- File names below are exact. Where a task says "move", the code moves unchanged and its tests keep passing unchanged.
- Migrations: `apps/daemon/src/modules/<m>/migrations/<YYYYMMDDHHmm>_<name>.sql`, additive only.
- Every task carries a **Risks / rulings needed** line: the controller rules on those points before dispatching the task, so no ruling is needed after implementation.
- Shared test helpers: never `process.kill(x ?? 0)`; the beds expose `killWorker(…)` helpers that assert `pid > 1` first (Tasks 5, 10). Fire-and-forget promises always end in a `.catch` that logs a stable code (never a bare `() => undefined`).
- Pipelining with M3: one implementer per worktree, reviews of one milestone overlapping implementation of the other. No M2 task needs an M3 merge to start. Tasks 24–29 add i18n keys and must rebase first if M3 has merged a restructuring of `apps/web/src/i18n/**` by then (keys then go into M3's sessions catalogue, same names). Task 30 re-reads `budgets.json` after any M3 merge (M3 re-sets the bundle budget).

## Review Focus

The five input classes or failure modes most likely to bite a person, that no feature test naturally exercises; each line names the test that pins it.

1. **Reconnect in the middle of a reply.** A tab that loses its socket mid-stream gets a snapshot while the daemon still holds coalesced deltas not yet sent. Expected: the rebuilt reply equals Pi's text, no doubled or missing characters. Pinned by Task 9 "puts only published deltas in the snapshot's partial reply" and "rebuilds the reply exactly from a snapshot taken between two flushes and the frames after it".
2. **"Always" for a call that differs by one character.** Expected: a different command (one space, one hidden character, other arguments) asks again; the same command never asks again in that project, in any new worker. Pinned by Task 13 "grant keys are the same for the same exact call and differ for any other", Task 14 "lets a call through on a project's always rule, matching the exact call only", "starts a worker with its project's always rules" and "remembers an always answer for the project, across workers, until it is revoked".
3. **A worker killed with a panel, an approval and queued steers open** (OOM, SIGKILL). Expected: cards, panels, statuses and the queue clear, the status says why, the daemon and other sessions keep working, nothing the worker started survives. Pinned by Task 22 "a worker killed with a card, a panel and queued steers open: everything clears, the daemon and the other sessions carry on" and Task 5 "stops the scope after the worker dies, so what it started in a group of its own dies too (R100)".
4. **Opening an exported transcript.** It is HTML written from model output. Expected: it downloads; it never runs as a page of the pap origin. Pinned by Task 18 "answers as an attachment with a sandbox CSP and nosniff, once, then deletes the file".
5. **A prompt that arrives while the idle timer releases the worker.** Expected: the prompt starts a fresh worker on the same Pi file; it is never sent to the stopping worker nor lost. Pinned by Task 20 "a prompt during releasing waits for the exit and reopens on the same file (Review Focus 5)".

---

## File structure

```
packages/contracts/src/
  policy.ts                 NEW  TOOL_CATEGORIES, ApprovalAnswer, GrantKey, AlwaysRule, PolicyRules, AuditEntry (moved from pi-host.ts)
  streams.ts                v2   UI_LIMITS, SessionStatus+releasing, Dialog (+approval), DialogResponse (+answer), TranscriptRow,
                                 PartialMessage, StatusEntry, Widget, Panel, Notice, QueueView, HistoryMeta, Activity, EntryRef,
                                 SessionStreamEvent v2, SessionSummary (+name, Task 17)
  pi-host.ts                v2   new daemon→worker and worker→daemon records
  methods.ts · errors.ts · permissions.ts · frames.ts (PROTOCOL_VERSION 2)
packages/pi-host/src/
  dispatch.ts               NEW  command switch (moved out of host.ts)
  session-commands.ts       NEW  clear_queue, compact, navigate_tree, set_session_name, export_html
  auto-name.ts · title.ts   NEW  auto_name: transcript → title through the session's model
  custom-panels.ts          NEW  ctx.ui.custom() over custom_render / custom_input / custom_close (S1)
  widget-components.ts      NEW  setWidget component factories rendered as lines
  approvals.ts              NEW  approval_request / approval_response channel
  policy/grant-key.ts       NEW  sha256 of tool + exact payload
  shutdown.ts               NEW  session_shutdown then dispose, bounded by the grace
  host.ts · ipc.ts · ui-bridge.ts · wire-events.ts · descendants.ts · open-session.ts · policy/extension.ts   changed
apps/daemon/src/
  kernel/supervisor/scope.ts      NEW  systemd scope probe, wrap, reap
  kernel/supervisor/worker-io.ts  NEW  moved helpers of worker.ts (tail, bounded records, timeouts)
  kernel/supervisor/{worker,exit}.ts · kernel/config.ts · kernel/home.ts · daemon.ts   changed
  modules/sessions/
    live-session.ts               core of one worker's session (split in Task 7)
    live-run.ts · live-ui.ts      NEW (Task 7) run tracking, dialogs
    coalescer.ts · partial.ts · wire-clip.ts      NEW (Task 9)
    branch.ts · entries-cache.ts  NEW (Task 10) branch rows, paging, fork points, tool results
    queue-guard.ts                NEW (Task 12)
    decorations.ts · panels.ts · notices.ts       NEW (Task 16)
    idle-release.ts               NEW (Task 20)
    pi-writer.ts · forks.ts       NEW (Task 19)
    exports.ts · export-http.ts   NEW (Task 18)
    service.ts · service-reads.ts · service-commands.ts · rpc.ts · index.ts · snapshot.ts · transcript.ts · dialogs.ts · store.ts
    testing/int-bed.ts · testing/extensions.ts    NEW test beds
    migrations/202610110000_session_name.sql      NEW
  modules/policy/                 NEW module: index.ts, service.ts, store.ts, rpc.ts, migrations/202610110100_policy.sql
apps/web/src/
  runtime/rpc.ts                  call(method, params, { commandId })
  stores/session-reducer.ts · row-view.ts · reduce-pi.ts · reduce-ui.ts · history.ts · session-store.ts
  features/sessions/
    SessionScreen.tsx (layout only) · Transcript.tsx · MessageRow.tsx · ToolRow.tsx · Composer.tsx · QueueStrip.tsx
    dialogs/{ApprovalDialog,SelectDialog,TextDialog,ConfirmDialog,DialogList}.tsx
    StatusBar.tsx · Widgets.tsx · CustomPanel.tsx · SessionActions.tsx · BranchSwitcher.tsx · AlwaysRules.tsx · Minimap.tsx
    transcript.vm.ts · composer.vm.ts · drafts.ts · status-cells.ts · ansi.ts · terminal-keys.ts · minimap.vm.ts · branches.vm.ts
  i18n/en.ts · fr.ts              a delimited `sessions.*` block (+ the exceptions listed in "Merge order and conflict notes")
docs/adr/0006-session-export-download-route.md · 0007-hot-session-reads-from-the-pi-file.md · 0008-pap-records-added-in-m2.md
docs/agents/sessions.md · daemon.md   updated
```

## Protocol v2 at a glance

| Direction | New or changed | Purpose |
|---|---|---|
| daemon → worker | `clear_queue{id}` `compact{id,customInstructions?}` `navigate_tree{id,targetId}` `set_session_name{id,name}` `export_html{id,outputPath}` `auto_name{id}` | session commands (Pi RPC shapes; `auto_name` is pap) |
| daemon → worker | `custom_input{id,data}` `custom_cancel{id}` `approval_response{id,answer}` | panels, approvals |
| worker → daemon | `ready{…, leafId, sessionName}` | leaf and name at start |
| worker → daemon | `custom_render{id,lines}` `custom_close{id}` `approval_request{id,category,title,message,answers,tool,key}` | panels, approvals |
| worker → daemon (Pi events, slimmed by `toWireEvent`) | `entry_appended{entry: slim}` `queue_update{steering,followUp,count,bytes}` | entry ids and leaf, queue |
| stream | `snapshot` v2, `row`, `entry`, `queue`, `status_bar`, `widget`, `title`, `editor_text`, `panel`, `panel_closed`, `name`, `activity` | see Task 1 |
| methods | `sessions.history` `sessions.toolOutput` `sessions.branches` `sessions.clearQueue` `sessions.panelInput` `sessions.navigate` `sessions.compact` `sessions.rename` `sessions.autoName` `sessions.exportHtml` `sessions.fork` `sessions.clone` `policy.listRules` `policy.revokeRule` | Tasks 11–19 |
| HTTP | `GET /api/sessions/:sessionId/export/:token` | Task 18, ADR 0006 |

---

## Pre-execution conflict scan

Tasks run one at a time, in order. Pairs below share files or interfaces; the later task rebases on the earlier one's result and must not undo it.

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1 → 2–4, 13, 15 | `packages/contracts/src/pi-host.ts`, `packages/pi-host/src/host.ts` | Task 1 adds every record; later tasks only handle them. Task 2 moves the switch to `dispatch.ts`; Tasks 3, 13, 15 add `case`s there. |
| 1 → 9–19 | `packages/contracts/src/streams.ts`, `apps/web/src/stores/*` | Task 1 defines every stream event and splits the reducer; later tasks fill `reduce-pi.ts` / `reduce-ui.ts` cases. |
| 4 → 13, 15 | `Ipc.send(): boolean`, `createUiBridge(send)` | Task 4 changes `send` to return whether the record left; 13 and 15 rely on it. |
| 5 → 6 → 20, 22 | `spawnWorker(options.scope)`, `Config` worker fields | Task 5 adds the scope option; Task 6 wires config and boot; Task 20 uses `workerIdleMs`. |
| 7 → 8–20 | `modules/sessions/live-session.ts`, `live-run.ts`, `live-ui.ts`, `service.ts`, `service-reads.ts` | Task 7 splits without behaviour change; every later sessions task edits the split files, never re-merges them. |
| 9 → 10, 11 | `snapshot.ts`, `wire-clip.ts` (`clipToolResult`, `clipAssistantMessage`) | Task 10 applies Task 9's clipping to rows read from files. |
| 10 → 11, 17, 19 | `TranscriptReader.page/branches/toolOutput`, `LiveSession.leafId()` | One reader; leaf tracking lives in `live-session.ts`. |
| 12 → 24 | `QueueView`, `sessions.clearQueue` | Composer restores cleared texts. |
| 13 → 14, 21, 26 | `approval_request`, `Dialog.method "approval"`, `DialogResponse.answer`, `DialogRegistry.offerApproval` | Task 14 adds grants on top; Task 26 renders four answers. |
| 15 → 16 → 21, 27 | `custom_*` records, `panels.ts`, `decorations.ts` | — |
| 17 → 19, 28 | `sessions` table column `name`, `SessionSummary.name`, `store.setName` | Clone names its copy. |
| 6, 14, 18 | `apps/daemon/src/daemon.ts` composition | Each adds its own lines (scopes, policy module, export route). |
| 1, 24–29 | `apps/web/src/i18n/en.ts`, `fr.ts` | Keys appended inside the `sessions.*` block in task order. |
| 24 → 25 | `features/sessions/SessionScreen.tsx` | Task 24 makes it a layout of `Transcript` + `Composer`; later UI tasks add children only. |

## Model table

Owner cost rules: Haiku for mechanical transcription, Sonnet by default, Opus reviewer only where a wrong change is a security hole or a race, Opus for the final whole-branch review.

| # | Task | Implementer | Reviewer | Why Opus (reviewer) |
|---|---|---|---|---|
| 1 | Protocol v2 foundation | Sonnet | Sonnet | |
| 2 | pi-host session commands | Sonnet | Sonnet | |
| 3 | pi-host auto-name | Sonnet | Sonnet | |
| 4 | pi-host lifecycle parity (R106) | Sonnet | Sonnet | |
| 5 | Supervisor: systemd scopes | Sonnet | **Opus** | process containment: cgroup cleanup, kill paths, OOM classification; a mistake leaks processes or kills the wrong unit |
| 6 | Config, boot probe, R118 harness check | Sonnet | Sonnet | |
| 7 | Sessions module split (no behaviour change) | Haiku | Sonnet | |
| 8 | Run semantics backlog (R112, R113) | Sonnet | **Opus** | run-tracker races (abort before `agent_start`, stale probes across runs) |
| 9 | Coalescing, partial reply, wire clipping | Sonnet | **Opus** | ordering between buffered deltas, the snapshot's partial and stream seq |
| 10 | Transcript v2 (rows with entry ids, leaf) | Sonnet | Sonnet | |
| 11 | Reads: history, tool output, branches | Sonnet | Sonnet | |
| 12 | Steering queue and its cap | Sonnet | Sonnet | |
| 13 | Approval channel end to end | Sonnet | **Opus** | security: the policy's question must come only from the policy, closed = fail closed |
| 14 | Session and always grants, `policy` module | Sonnet | **Opus** | security: persisted allow rules, exact matching, fan-out to live workers |
| 15 | pi-host custom panels and widget factories | Sonnet | Sonnet | |
| 16 | Daemon decorations, panels, notices | Sonnet | Sonnet | |
| 17 | navigate, compact, rename, auto-name | Sonnet | Sonnet | |
| 18 | HTML export download | Sonnet | **Opus** | serves model-authored HTML from the daemon origin: XSS, token, path |
| 19 | Fork and clone | Sonnet | Sonnet | |
| 20 | Idle release | Sonnet | **Opus** | release racing prompts, double stops, status ordering |
| 21 | D18 end-to-end integration | Sonnet | Sonnet | |
| 22 | Crash containment integration | Sonnet | Sonnet | |
| 23 | R45 revisit and budgets | Sonnet | Sonnet | |
| 24 | Web composer | Sonnet | Sonnet | |
| 25 | Web transcript | Sonnet | Sonnet | |
| 26 | Web dialogs | Sonnet | Sonnet | |
| 27 | Web extension UI | Sonnet | Sonnet | |
| 28 | Web session actions, branch switcher, always rules | Sonnet | Sonnet | |
| 29 | Web minimap | Sonnet | Haiku | |
| 30 | Docs, ADR check, final gates | Sonnet | Sonnet | |
| — | Whole-branch review | — | **Opus** | owner rule |

Totals: 30 tasks; implementers 29 Sonnet + 1 Haiku; reviewers 22 Sonnet + 7 Opus + 1 Haiku; one Opus final review.

## ETA

Observed in M1: about 1–1.5 h per task including review and fix rounds, longer for security tasks. 30 tasks × 1.25 h ≈ 37.5 h, plus about 0.5 h for each of the 7 Opus-reviewed tasks (3.5 h), plus about 3 h for the whole-branch review and its fix round: **≈ 44 h of agent time (range 38–52 h)**, run sequentially. Tasks 24–29 (web) can start once Tasks 1–20 are merged into the branch.

---
## Tasks

### Task 1: Protocol v2 foundation — contracts, snapshot shape, reducer split

Every later task consumes these shapes. The snapshot changes shape (`messages` → `rows` with entry ids, plus new sections), so `PROTOCOL_VERSION` goes to 2: an M1 tab gets "new version, reload" from the `?proto=` gate instead of a snapshot it cannot parse.

**Risks / rulings needed:** Bumping `PROTOCOL_VERSION` to 2 makes every open M1 tab show "new version, reload" (intended). `PolicyRules.alwaysAllow` defaults to `[]`, so its inferred output type requires the field: every `PolicyRules` literal (service `INTERACTIVE_POLICY`, policy tests) gains `alwaysAllow: []`. The `UI_LIMITS` values (statuses 32 × 512, widgets 8 × 50 lines × 512, panels 4 × 200 lines × 512, notices 20 × 2000) are proposals: confirm or change before dispatch.

**Files:**
- Create: `packages/contracts/src/policy.ts`, `packages/contracts/src/streams.test.ts`
- Modify: `packages/contracts/src/{streams,pi-host,errors,permissions,frames,index}.ts`, `packages/contracts/src/pi-host.test.ts`
- Modify: `packages/pi-host/src/host.ts` (ready fields, default branch), `apps/daemon/src/kernel/supervisor/worker.ts` (`requestTimeoutMs`), `apps/daemon/src/kernel/supervisor/worker.test.ts`, `scripts/smoke-dist.ts` (its own `const PROTOCOL = 1` becomes `2`: the smoke drives the built daemon without importing the contracts)
- Modify: `apps/daemon/src/modules/sessions/{snapshot,service}.ts`, `snapshot.test.ts`, `service.snapshot.test.ts`, `sessions.int.test.ts`, `testing/{service-bed,live-bed}.ts`, `apps/daemon/src/kernel/ws/{ws-server.test,ws-server.int.test}.ts` (`?proto=${PROTOCOL_VERSION}`)
- Create: `apps/web/src/stores/row-view.ts`; Modify: `apps/web/src/stores/session-reducer.ts`, `session-reducer.test.ts`, `apps/web/src/i18n/{en,fr}.ts`
- Create: `docs/adr/0008-pap-records-added-in-m2.md` (spec C §2.3 lists the records; the ones M2 adds are a deviation, recorded like ADR 0001)

**Interfaces:**
- Consumes: M1 contracts.
- Produces (all exported from `@pap/contracts`):
  - `policy.ts`: `TOOL_CATEGORIES`, `ToolCategory`, `ApprovalAnswer` (`"once"|"session"|"always"|"deny"`), `GrantKey`, `AlwaysRule {tool,key}`, `MAX_ALWAYS_RULES = 1000`, `PolicyRules {profile, approvalMode, alwaysAllow}` (`alwaysAllow` defaults to `[]`), `AuditEntry` (moved).
  - `streams.ts`: `UI_LIMITS`, `SessionStatus` (+`releasing`), `Dialog` (+`approval`, `category?`, `answers?`), `DialogResponse` (+`{answer}`), `TranscriptRow {entryId: string|null, message: unknown}`, `PartialBlock`, `PartialMessage {blocks}`, `StatusEntry`, `Widget`, `Panel`, `Notice`, `QueueView`, `HistoryMeta`, `Activity`, `EntryRef`, `EMPTY_QUEUE`, `IDLE_ACTIVITY`, `NO_HISTORY`, `SessionStreamEvent` v2, `SnapshotEvent`.
  - `pi-host.ts`: commands `clear_queue`, `compact`, `navigate_tree`, `set_session_name`, `export_html`, `auto_name`; records `custom_input`, `custom_cancel`, `approval_response` (daemon → worker); `ready{leafId, sessionName}`, `custom_render`, `custom_close`, `approval_request` (worker → daemon); `CommandInput` covers every command.
  - `errors.ts`: `queue_full`, `session_busy`, `session_empty`. `permissions.ts`: domain `policy`. `frames.ts`: `PROTOCOL_VERSION = 2`.
  - Daemon: `requestTimeoutMs(command)` = none for `prompt` and `compact`, 120 s for `auto_name` and `export_html`, 30 s otherwise. `fitSnapshot(input: SnapshotInput): SnapshotEvent` with the v2 sections.
  - Web: `MessageView` gains `entryId: string | null`; `toMessageView(raw, entryId)` lives in `stores/row-view.ts`.

- [ ] **Step 1: Install and write the failing contract tests**

Run: `pnpm install --frozen-lockfile`

`packages/contracts/src/streams.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DialogResponse,
  EMPTY_QUEUE,
  IDLE_ACTIVITY,
  NO_HISTORY,
  SessionStreamEvent,
  UI_LIMITS,
} from "./index.ts";

const snapshot = {
  kind: "snapshot",
  status: "releasing",
  rows: [{ entryId: "e1", message: { role: "user", content: "hi" } }, { entryId: null, message: {} }],
  dialogs: [
    { id: "a1", method: "approval", title: "Run a command?", message: "1 line\nbash: ls", category: "exec", answers: ["deny", "session", "always", "once"] },
  ],
  partial: { blocks: [{ type: "text", text: "Hel" }, { type: "toolCall", text: "{\"pa", id: "c1", name: "read" }] },
  queue: { steering: ["go left"], followUp: [], count: 1, bytes: 7 },
  statuses: [{ key: "command:/mode build", text: "Build" }],
  widgets: [{ key: "todo", lines: ["- a"], placement: "belowEditor" }],
  title: "pi - repo",
  panels: [{ id: "p1", lines: ["> alpha", "  beta"] }],
  notices: [{ level: "warning", text: "An extension failed during session_start." }],
  history: { hasMore: true, oldestEntryId: "e1", turnsBefore: 3 },
  activity: { compacting: false, retry: { attempt: 1, maxAttempts: 3 } },
  leafId: "e9",
  name: "Fix the login bug",
};

describe("session stream v2", () => {
  it("parses a snapshot with every section", () => {
    expect(SessionStreamEvent.parse(snapshot)).toEqual(snapshot);
  });

  it("refuses sections over their limits", () => {
    const statuses = Array.from({ length: UI_LIMITS.statuses + 1 }, (_, i) => ({ key: `k${i}`, text: "x" }));
    expect(SessionStreamEvent.safeParse({ ...snapshot, statuses }).success).toBe(false);
    const lines = Array.from({ length: UI_LIMITS.panelLines + 1 }, () => "x");
    expect(SessionStreamEvent.safeParse({ ...snapshot, panels: [{ id: "p", lines }] }).success).toBe(false);
    expect(SessionStreamEvent.safeParse({ ...snapshot, title: "t".repeat(UI_LIMITS.title + 1) }).success).toBe(false);
  });

  it.each([
    { kind: "row", row: { entryId: "c1", message: { role: "compactionSummary", summary: "s", tokensBefore: 10 } } },
    { kind: "entry", entry: { id: "e2", parentId: "e1", type: "message", role: "assistant", messageTimestamp: 2 } },
    { kind: "queue", queue: EMPTY_QUEUE },
    { kind: "status_bar", key: "git", text: null },
    { kind: "widget", key: "todo", widget: null },
    { kind: "title", title: null },
    { kind: "editor_text", text: "prefill" },
    { kind: "panel", panel: { id: "p1", lines: [] } },
    { kind: "panel_closed", id: "p1" },
    { kind: "name", name: null },
    { kind: "activity", activity: IDLE_ACTIVITY },
    { kind: "notice", level: "info", text: "hi" },
  ])("round-trips a $kind event", (event) => {
    expect(SessionStreamEvent.parse(event)).toEqual(event);
  });

  it("answers an approval with one of four answers", () => {
    expect(DialogResponse.safeParse({ answer: "always" }).success).toBe(true);
    expect(DialogResponse.safeParse({ answer: "forever" }).success).toBe(false);
  });

  it("starts the defaults empty", () => {
    expect(EMPTY_QUEUE).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
    expect(NO_HISTORY).toEqual({ hasMore: false, oldestEntryId: null, turnsBefore: 0 });
  });
});
```

Append to `packages/contracts/src/pi-host.test.ts`:

```ts
import { PolicyRules } from "./index.ts";

const KEY = "a".repeat(64);

describe("protocol v2 records", () => {
  it("parses the new worker records as pap records, never as Pi events", () => {
    const render = { type: "custom_render", id: "p1", lines: ["> a"] };
    const approval = {
      type: "approval_request",
      id: "a1",
      category: "exec",
      title: "Run a command?",
      message: "1 line\nbash: ls",
      answers: ["deny", "once"],
      tool: "bash",
      key: KEY,
    };
    expect(parseWorkerRecord(render)).toEqual(render);
    expect(parseWorkerRecord({ type: "custom_close", id: "p1" })).toEqual({ type: "custom_close", id: "p1" });
    expect(parseWorkerRecord(approval)).toEqual(approval);
    expect(parseWorkerRecord({ ...approval, key: "not-hex" })).toBeNull();
    expect(parseWorkerRecord({ type: "custom_render", id: "p1" })).toBeNull();
  });

  it("requires the leaf and name in ready", () => {
    const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "abc", piVersion: "1.1.0", leafId: null, sessionName: null };
    expect(parseWorkerRecord(ready)).toEqual(ready);
    expect(parseWorkerRecord({ ...ready, leafId: undefined })).toBeNull();
  });

  it.each([
    { type: "clear_queue", id: "r1" },
    { type: "compact", id: "r1", customInstructions: "keep the API notes" },
    { type: "navigate_tree", id: "r1", targetId: "e4" },
    { type: "set_session_name", id: "r1", name: "Fix login" },
    { type: "export_html", id: "r1", outputPath: "/pap/exports/x.html" },
    { type: "auto_name", id: "r1" },
    { type: "custom_input", id: "p1", data: "\r" },
    { type: "custom_cancel", id: "p1" },
    { type: "approval_response", id: "a1", answer: "session" },
  ])("accepts the daemon record $type", (record) => {
    expect(DaemonToWorker.safeParse(record).success).toBe(true);
  });

  it("refuses an export path that is not absolute and an answer outside the four", () => {
    expect(DaemonToWorker.safeParse({ type: "export_html", id: "r1", outputPath: "x.html" }).success).toBe(false);
    expect(DaemonToWorker.safeParse({ type: "approval_response", id: "a1", answer: "yes" }).success).toBe(false);
  });

  it("defaults always rules to none and bounds them", () => {
    const base = { profile: "interactive", approvalMode: "auto-accept-edits" };
    expect(PolicyRules.parse(base).alwaysAllow).toEqual([]);
    expect(PolicyRules.safeParse({ ...base, alwaysAllow: [{ tool: "bash", key: "xyz" }] }).success).toBe(false);
    const many = Array.from({ length: 1001 }, () => ({ tool: "bash", key: KEY }));
    expect(PolicyRules.safeParse({ ...base, alwaysAllow: many }).success).toBe(false);
  });
});
```

Also add `"custom_render", "custom_close", "approval_request"` to `PAP_RECORD_TYPES` in the existing routing test, and add `leafId: null, sessionName: null` to the `ready` fixture of the first test.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts`
Expected: FAIL (`UI_LIMITS`, `PolicyRules.alwaysAllow`, the new records are missing).

- [ ] **Step 3: Write `policy.ts`, the v2 streams and records**

`packages/contracts/src/policy.ts` (`TOOL_CATEGORIES` and `AuditEntry` move here from `pi-host.ts` unchanged, so `streams.ts` and `pi-host.ts` can both import them without importing each other):

```ts
import { z } from "zod";

export const TOOL_CATEGORIES = ["read", "edit", "exec", "network", "external-write", "unknown"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** The four answers of an approval card (spec C §5.3). */
export const ApprovalAnswer = z.enum(["once", "session", "always", "deny"]);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

/** sha256 (lowercase hex) of a tool name and the call's exact payload, computed by pap-policy (Task 13). */
export const GrantKey = z.string().regex(/^[0-9a-f]{64}$/);
export const AlwaysRule = z.object({ tool: z.string().min(1).max(256), key: GrantKey });
export type AlwaysRule = z.infer<typeof AlwaysRule>;
export const MAX_ALWAYS_RULES = 1000;

export const PolicyRules = z.object({
  profile: z.literal("interactive"),
  approvalMode: z.enum(["auto-accept-edits"]),
  /** "Always" answers of this project (Task 14). Absent in M1 rules, so it defaults to none. */
  alwaysAllow: z.array(AlwaysRule).max(MAX_ALWAYS_RULES).default([]),
});
export type PolicyRules = z.infer<typeof PolicyRules>;

export const AuditEntry = z.object({
  toolCallId: z.string().max(256),
  tool: z.string().max(256),
  category: z.enum(TOOL_CATEGORIES),
  decision: z.enum(["allow", "block", "approved", "denied"]),
  reason: z.string().max(1024).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
```

`packages/contracts/src/streams.ts` (whole file):

```ts
import { z } from "zod";
import { ApprovalAnswer, TOOL_CATEGORIES } from "./policy.ts";

export const STREAMS = ["session"] as const;
export type StreamName = (typeof STREAMS)[number];

/**
 * The most the daemon passes on from a worker for each extension UI surface (R66). The daemon rebuilds every client
 * event from the fields it knows, cut to these, so an extension that loops or lies cannot grow a frame or a snapshot.
 */
export const UI_LIMITS = {
  statuses: 32,
  statusKey: 256,
  statusText: 512,
  widgets: 8,
  widgetKey: 256,
  widgetLines: 50,
  widgetLineChars: 512,
  title: 256,
  editorText: 200_000,
  panels: 4,
  panelLines: 200,
  panelLineChars: 512,
  panelInput: 4096,
  notices: 20,
  noticeText: 2000,
  queuePreviewChars: 2000,
  queueEntries: 128,
  name: 256,
} as const;

export const SessionStatus = z.enum(["cold", "starting", "idle", "running", "releasing"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Dialog = z.object({
  id: z.string().min(1).max(128),
  method: z.enum(["select", "confirm", "input", "editor", "approval"]),
  title: z.string().max(4096),
  message: z.string().max(65_536).optional(),
  options: z.array(z.string().max(4096)).max(100).optional(),
  placeholder: z.string().max(4096).optional(),
  prefill: z.string().max(1_000_000).optional(),
  timeout: z.number().int().positive().optional(),
  /** Approval dialogs only (`method: "approval"`): the policy's category and the answers it accepts, in card order. */
  category: z.enum(TOOL_CATEGORIES).optional(),
  answers: z.array(ApprovalAnswer).min(2).max(4).optional(),
});
export type Dialog = z.infer<typeof Dialog>;

export const DialogResponse = z.union([
  z.object({ confirmed: z.boolean() }),
  z.object({ value: z.string().max(1_000_000) }),
  z.object({ cancelled: z.literal(true) }),
  z.object({ answer: ApprovalAnswer }),
]);
export type DialogResponse = z.infer<typeof DialogResponse>;

export const PiEvent = z.looseObject({ type: z.string() });
export type PiEvent = z.infer<typeof PiEvent>;

/** One displayed transcript row: a Pi message (or summary) and the id of the Pi entry it came from, once known. */
export const TranscriptRow = z.object({ entryId: z.string().min(1).max(128).nullable(), message: z.unknown() });
export type TranscriptRow = z.infer<typeof TranscriptRow>;

export const PartialBlock = z.object({
  type: z.enum(["text", "thinking", "toolCall"]),
  text: z.string(),
  id: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
});
export type PartialBlock = z.infer<typeof PartialBlock>;
/** The assistant reply being written, by content index: what a client resuming mid-reply starts from (spec C §4.3). */
export const PartialMessage = z.object({ blocks: z.array(PartialBlock).max(64) });
export type PartialMessage = z.infer<typeof PartialMessage>;

export const StatusEntry = z.object({
  key: z.string().min(1).max(UI_LIMITS.statusKey),
  text: z.string().max(UI_LIMITS.statusText),
});
export type StatusEntry = z.infer<typeof StatusEntry>;
export const Widget = z.object({
  key: z.string().min(1).max(UI_LIMITS.widgetKey),
  lines: z.array(z.string().max(UI_LIMITS.widgetLineChars)).max(UI_LIMITS.widgetLines),
  placement: z.enum(["aboveEditor", "belowEditor"]),
});
export type Widget = z.infer<typeof Widget>;
export const Panel = z.object({
  id: z.string().min(1).max(128),
  lines: z.array(z.string().max(UI_LIMITS.panelLineChars)).max(UI_LIMITS.panelLines),
});
export type Panel = z.infer<typeof Panel>;
export const Notice = z.object({
  level: z.enum(["info", "warning", "error"]),
  text: z.string().max(UI_LIMITS.noticeText),
});
export type Notice = z.infer<typeof Notice>;
/** Previews of what waits in Pi's queue, and how much (Task 12). The texts themselves stay in the worker. */
export const QueueView = z.object({
  steering: z.array(z.string().max(UI_LIMITS.queuePreviewChars)).max(UI_LIMITS.queueEntries),
  followUp: z.array(z.string().max(UI_LIMITS.queuePreviewChars)).max(UI_LIMITS.queueEntries),
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type QueueView = z.infer<typeof QueueView>;
export const HistoryMeta = z.object({
  hasMore: z.boolean(),
  oldestEntryId: z.string().max(128).nullable(),
  turnsBefore: z.number().int().nonnegative(),
});
export type HistoryMeta = z.infer<typeof HistoryMeta>;
export const Activity = z.object({
  compacting: z.boolean(),
  retry: z.object({ attempt: z.number().int().nonnegative(), maxAttempts: z.number().int().nonnegative() }).nullable(),
});
export type Activity = z.infer<typeof Activity>;
/** A Pi entry as the client needs it: its id binds a live message to the entry Pi wrote for it. */
export const EntryRef = z.object({
  id: z.string().min(1).max(128),
  parentId: z.string().max(128).nullable(),
  type: z.string().max(64),
  role: z.string().max(64).optional(),
  toolCallId: z.string().max(256).optional(),
  messageTimestamp: z.number().optional(),
});
export type EntryRef = z.infer<typeof EntryRef>;

export const EMPTY_QUEUE: QueueView = { steering: [], followUp: [], count: 0, bytes: 0 };
export const IDLE_ACTIVITY: Activity = { compacting: false, retry: null };
export const NO_HISTORY: HistoryMeta = { hasMore: false, oldestEntryId: null, turnsBefore: 0 };

const Snapshot = z.object({
  kind: z.literal("snapshot"),
  status: SessionStatus,
  rows: z.array(TranscriptRow),
  dialogs: z.array(Dialog),
  partial: PartialMessage.nullable(),
  queue: QueueView,
  statuses: z.array(StatusEntry).max(UI_LIMITS.statuses),
  widgets: z.array(Widget).max(UI_LIMITS.widgets),
  title: z.string().max(UI_LIMITS.title).nullable(),
  panels: z.array(Panel).max(UI_LIMITS.panels),
  notices: z.array(Notice).max(UI_LIMITS.notices),
  history: HistoryMeta,
  activity: Activity,
  leafId: z.string().max(128).nullable(),
  name: z.string().max(UI_LIMITS.name).nullable(),
});

export const SessionStreamEvent = z.discriminatedUnion("kind", [
  Snapshot,
  z.object({ kind: z.literal("status"), status: SessionStatus, cause: z.string().optional() }),
  z.object({ kind: z.literal("pi"), event: PiEvent }),
  z.object({ kind: z.literal("dialog_open"), dialog: Dialog }),
  z.object({ kind: z.literal("dialog_closed"), id: z.string() }),
  z.object({ kind: z.literal("notice"), level: Notice.shape.level, text: Notice.shape.text }),
  z.object({ kind: z.literal("row"), row: TranscriptRow }),
  z.object({ kind: z.literal("entry"), entry: EntryRef }),
  z.object({ kind: z.literal("queue"), queue: QueueView }),
  z.object({ kind: z.literal("status_bar"), key: StatusEntry.shape.key, text: StatusEntry.shape.text.nullable() }),
  z.object({ kind: z.literal("widget"), key: Widget.shape.key, widget: Widget.nullable() }),
  z.object({ kind: z.literal("title"), title: z.string().max(UI_LIMITS.title).nullable() }),
  z.object({ kind: z.literal("editor_text"), text: z.string().max(UI_LIMITS.editorText) }),
  z.object({ kind: z.literal("panel"), panel: Panel }),
  z.object({ kind: z.literal("panel_closed"), id: z.string().max(128) }),
  z.object({ kind: z.literal("name"), name: z.string().max(UI_LIMITS.name).nullable() }),
  z.object({ kind: z.literal("activity"), activity: Activity }),
]);
export type SessionStreamEvent = z.infer<typeof SessionStreamEvent>;
export type SnapshotEvent = Extract<SessionStreamEvent, { kind: "snapshot" }>;

export const SessionSummary = z.object({
  id: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;
```

`packages/contracts/src/pi-host.ts`: delete `PolicyRules`, `TOOL_CATEGORIES`, `ToolCategory` and `AuditEntry` (now in `policy.ts`), import `ApprovalAnswer`, `AuditEntry`, `GrantKey`, `TOOL_CATEGORIES` from `./policy.ts`, keep `InitRecord`, `UiResponseRecord`, `ResponseRecord`, `UiRequestRecord`, `parseWorkerRecord`, `PAP_TYPES` (derived, R67) and `GetStateData` as they are, and add:

```ts
const Id = z.string().min(1).max(128);
const ClearQueueCommand = z.object({ type: z.literal("clear_queue"), id: z.string() });
const CompactCommand = z.object({
  type: z.literal("compact"),
  id: z.string(),
  customInstructions: z.string().max(4096).optional(),
});
const NavigateTreeCommand = z.object({ type: z.literal("navigate_tree"), id: z.string(), targetId: Id });
const SetSessionNameCommand = z.object({ type: z.literal("set_session_name"), id: z.string(), name: z.string().min(1).max(256) });
/** The daemon picks the path (under `$PAP_HOME/exports`, Task 18): a worker never writes where a client says. */
const ExportHtmlCommand = z.object({ type: z.literal("export_html"), id: z.string(), outputPath: AbsolutePath });
const AutoNameCommand = z.object({ type: z.literal("auto_name"), id: z.string() });
const CustomInputRecord = z.object({ type: z.literal("custom_input"), id: Id, data: z.string().max(4096) });
const CustomCancelRecord = z.object({ type: z.literal("custom_cancel"), id: Id });
const ApprovalResponseRecord = z.object({ type: z.literal("approval_response"), id: Id, answer: ApprovalAnswer });

export const DaemonToWorker = z.discriminatedUnion("type", [
  InitRecord,
  PromptCommand,
  AbortCommand,
  GetStateCommand,
  ClearQueueCommand,
  CompactCommand,
  NavigateTreeCommand,
  SetSessionNameCommand,
  ExportHtmlCommand,
  AutoNameCommand,
  UiResponseRecord,
  CustomInputRecord,
  CustomCancelRecord,
  ApprovalResponseRecord,
  ShutdownRecord,
  PolicyUpdateRecord,
]);
type CommandRecord =
  | z.infer<typeof PromptCommand>
  | z.infer<typeof AbortCommand>
  | z.infer<typeof GetStateCommand>
  | z.infer<typeof ClearQueueCommand>
  | z.infer<typeof CompactCommand>
  | z.infer<typeof NavigateTreeCommand>
  | z.infer<typeof SetSessionNameCommand>
  | z.infer<typeof ExportHtmlCommand>
  | z.infer<typeof AutoNameCommand>;

export const ReadyRecord = z.object({
  type: z.literal("ready"),
  sessionFile: z.string(),
  sessionId: z.string(),
  piVersion: z.string(),
  /** Pi's current leaf: where the next entry goes and what the transcript of a hot session shows (Task 10). */
  leafId: z.string().nullable(),
  sessionName: z.string().nullable(),
});
export const CustomRenderRecord = z.object({ type: z.literal("custom_render"), id: Id, lines: z.array(z.string()) });
const CustomCloseRecord = z.object({ type: z.literal("custom_close"), id: Id });
/** The policy's own question (Task 13). Only pap-policy sends it: an extension's `ctx.ui.confirm` is a plain dialog. */
export const ApprovalRequestRecord = z.object({
  type: z.literal("approval_request"),
  id: Id,
  category: z.enum(TOOL_CATEGORIES),
  title: z.string().max(4096),
  message: z.string().max(65_536),
  answers: z.array(ApprovalAnswer).min(2).max(4),
  tool: z.string().min(1).max(256),
  key: GrantKey,
});
export type ApprovalRequestRecord = z.infer<typeof ApprovalRequestRecord>;
```

and list `CustomRenderRecord`, `CustomCloseRecord` and `ApprovalRequestRecord` in `PapRecord`. `packages/contracts/src/index.ts` exports `./policy.ts` too.

`errors.ts`: insert after `"invalid_cwd"`:

```ts
  "queue_full",
  "session_busy",
  "session_empty",
```

with messages `queue_full: "Too many messages are waiting in this session. Wait for the agent, or clear the queue."`, `session_busy: "The session is working. Wait for it to finish, or stop it first."`, `session_empty: "This session has nothing to copy yet."`. `permissions.ts`: `DOMAINS = ["system", "auth", "sessions", "policy"] as const`. `frames.ts`: `PROTOCOL_VERSION = 2`.

- [ ] **Step 4: Keep pi-host, the daemon and the web app on v2**

`packages/pi-host/src/host.ts`, the `ready` record:

```ts
  ipc.send({
    type: "ready",
    sessionFile: opened.sessionFile ?? "",
    sessionId: opened.sessionId,
    piVersion: VERSION,
    leafId: opened.sessionManager.getLeafId(),
    sessionName: opened.sessionName ?? null,
  });
```

and, as the last branch of the dispatch `switch`, so a command this build does not handle never leaves the daemon waiting for its timeout:

```ts
      default: {
        const unknown = record as { type: string; id?: unknown };
        if (typeof unknown.id === "string") {
          ipc.send({ type: "response", id: unknown.id, command: unknown.type.slice(0, 64), success: false, error: "unsupported command" });
        }
        return;
      }
```

`apps/daemon/src/kernel/supervisor/worker.ts`:

```ts
/**
 * How long a command may wait for its answer unless the caller says otherwise. `prompt` and `compact` have none: an
 * extension command answers only when it ends (R38(1)) and a compaction waits for the model's summary; the wait ends
 * with the worker. Naming and export call the model or write a file: two minutes.
 */
const COMMAND_TIMEOUTS: Partial<Record<CommandInput["type"], number | undefined>> = {
  prompt: undefined,
  compact: undefined,
  auto_name: 120_000,
  export_html: 120_000,
};
export const requestTimeoutMs = (command: CommandInput): number | undefined =>
  command.type in COMMAND_TIMEOUTS ? COMMAND_TIMEOUTS[command.type] : DEFAULT_REQUEST_TIMEOUT_MS;
```

Test in `worker.test.ts`:

```ts
it("gives each command its own default timeout", () => {
  expect(requestTimeoutMs({ type: "prompt", message: "x" })).toBeUndefined();
  expect(requestTimeoutMs({ type: "compact" })).toBeUndefined();
  expect(requestTimeoutMs({ type: "auto_name" })).toBe(120_000);
  expect(requestTimeoutMs({ type: "export_html", outputPath: "/p/x.html" })).toBe(120_000);
  expect(requestTimeoutMs({ type: "navigate_tree", targetId: "e1" })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
});
```

`apps/daemon/src/modules/sessions/snapshot.ts`: keep `SNAPSHOT_ROWS`, `SNAPSHOT_BYTES`, `ROW_BYTES`, `sizeOf`, `placeholderRow`, `boundedRow` (it bounds a message; `run-view.ts` keeps using it), and replace `SnapshotInput` / `fitSnapshot` with:

```ts
import {
  type Activity,
  type Dialog,
  EMPTY_QUEUE,
  type HistoryMeta,
  IDLE_ACTIVITY,
  NO_HISTORY,
  type Notice,
  type Panel,
  type PartialMessage,
  type QueueView,
  type SessionStatus,
  type SnapshotEvent,
  type StatusEntry,
  type TranscriptRow,
  type Widget,
} from "@pap/contracts";

/** The partial reply goes in only up to this size; a client then gets the whole reply from `message_end`. */
export const PARTIAL_BYTES = 256 * 1024;

export interface SnapshotInput {
  readonly status: SessionStatus;
  readonly rows: readonly TranscriptRow[];
  readonly dialogs: readonly Dialog[];
  readonly partial?: PartialMessage | null;
  readonly queue?: QueueView;
  readonly statuses?: readonly StatusEntry[];
  readonly widgets?: readonly Widget[];
  readonly title?: string | null;
  readonly panels?: readonly Panel[];
  readonly notices?: readonly Notice[];
  readonly history?: HistoryMeta;
  readonly activity?: Activity;
  readonly leafId?: string | null;
  readonly name?: string | null;
}

/** A row as it goes into a snapshot: its message bounded like `boundedRow`, its entry id kept. */
export function fitRow(row: TranscriptRow): { row: TranscriptRow; size: number } {
  const size = sizeOf(row);
  if (size <= ROW_BYTES) return { row, size };
  const bounded = { entryId: row.entryId, message: placeholderRow(row.message, size) };
  return { row: bounded, size: sizeOf(bounded) };
}

/**
 * The snapshot a subscriber gets when it cannot resume from a cursor, under `budget` bytes. The small sections
 * (status, queue, decorations, notices, history, activity, leaf, name) are always in: each is bounded by `UI_LIMITS`.
 * Then open dialogs (oldest first: a run may wait for one), open panels, the partial reply if it fits whole, and the
 * rows, newest first and contiguous, each over `ROW_BYTES` as a placeholder (R109).
 */
export function fitSnapshot(input: SnapshotInput, budget = SNAPSHOT_BYTES): SnapshotEvent {
  const snapshot: SnapshotEvent = {
    kind: "snapshot",
    status: input.status,
    rows: [],
    dialogs: [],
    partial: null,
    queue: input.queue ?? EMPTY_QUEUE,
    statuses: [...(input.statuses ?? [])],
    widgets: [...(input.widgets ?? [])],
    title: input.title ?? null,
    panels: [],
    notices: [...(input.notices ?? [])],
    history: input.history ?? NO_HISTORY,
    activity: input.activity ?? IDLE_ACTIVITY,
    leafId: input.leafId ?? null,
    name: input.name ?? null,
  };
  let used = sizeOf(snapshot);
  const fill = <T>(items: readonly T[], into: T[]): void => {
    for (const item of items) {
      const size = sizeOf(item) + 1;
      if (used + size > budget) continue;
      used += size;
      into.push(item);
    }
  };
  fill(input.dialogs, snapshot.dialogs);
  fill(input.panels ?? [], snapshot.panels);
  const partial = input.partial ?? null;
  if (partial) {
    const size = sizeOf(partial);
    if (size <= PARTIAL_BYTES && used + size <= budget) {
      used += size;
      snapshot.partial = partial;
    }
  }
  const newestFirst: TranscriptRow[] = [];
  for (const candidate of input.rows.slice(-SNAPSHOT_ROWS).toReversed()) {
    const { row, size } = fitRow(candidate);
    if (used + size + 1 > budget) break;
    used += size + 1;
    newestFirst.push(row);
  }
  snapshot.rows = newestFirst.toReversed();
  return snapshot;
}
```

`service.ts`: `INTERACTIVE_POLICY` gains `alwaysAllow: []`; `snapshot()` passes `rows: [...fromFile, ...(run?.messages ?? [])].map((message) => ({ entryId: null, message }))` (entry ids arrive in Task 10). `testing/service-bed.ts` and `testing/live-bed.ts`: the `ready` records they emit gain `leafId: null, sessionName: null`. Every test that reads `snapshot.messages` reads `snapshot.rows.map((row) => row.message)` instead; `sessions.int.test.ts`'s `snapshotRows` reads `rows`. New cases in `snapshot.test.ts`:

```ts
it("always carries the small sections, then dialogs, panels and the partial before rows", () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ entryId: `e${i}`, message: { role: "user", content: "x".repeat(300_000) } }));
  const snapshot = fitSnapshot({
    status: "running",
    rows,
    dialogs: [{ id: "d1", method: "confirm", title: "ok?" }],
    panels: [{ id: "p1", lines: ["> a"] }],
    partial: { blocks: [{ type: "text", text: "Hel" }] },
    statuses: [{ key: "git", text: "main" }],
    name: "n",
  });
  expect(snapshot.statuses).toEqual([{ key: "git", text: "main" }]);
  expect(snapshot.panels.map((panel) => panel.id)).toEqual(["p1"]);
  expect(snapshot.partial?.blocks[0]?.text).toBe("Hel");
  expect(snapshot.rows.map((row) => row.entryId)).toEqual(["e0", "e1", "e2"]);
  expect(snapshot.rows.every((row) => (row.message as { omitted?: boolean }).omitted === true)).toBe(true);
});

it("leaves out a partial reply over PARTIAL_BYTES", () => {
  const partial = { blocks: [{ type: "text" as const, text: "y".repeat(PARTIAL_BYTES) }] };
  expect(fitSnapshot({ status: "running", rows: [], dialogs: [], partial }).partial).toBeNull();
});
```

`apps/web/src/stores/row-view.ts`: move `ToolCallView`, `MessageView`, `summarize`, `clip`, `refOf`, `toMessageView`, `sameContent`, `withUniqueKey` out of `session-reducer.ts` unchanged, except that `MessageView` gains `readonly entryId: string | null` and `toMessageView(raw: unknown, entryId: string | null = null)` sets it. `session-reducer.ts` keeps `SessionView`, `EMPTY_VIEW`, `withNotice`, `reducePi`, `reduceSession`; its snapshot branch builds `messages` from `event.rows.reduce(... withUniqueKey(list, toMessageView(row.message, row.entryId)) ...)`, and its `switch` gains `default: return view;` (the kinds later tasks handle). `ws-server.test.ts` and `ws-server.int.test.ts` build their URLs with `?proto=${PROTOCOL_VERSION}`.

`apps/web/src/i18n/en.ts` (add after `"session.status.running"`): `"session.status.releasing": "Releasing"`; after `"error.invalid_cwd"`: the three new error messages (same text as `errors.ts`); and at the end of the object, the delimited block later tasks fill:

```ts
  // ── sessions (M2): keys of the session feature, appended in task order ──
  "sessions.queue.title": "Waiting",
  // ── end sessions (M2) ──
```

`fr.ts` mirrors it: `"session.status.releasing": "Libération"`, `"error.queue_full": "Trop de messages attendent dans cette session. Attendez l'agent, ou videz la file."`, `"error.session_busy": "La session travaille. Attendez qu'elle finisse, ou arrêtez-la d'abord."`, `"error.session_empty": "Cette session n'a encore rien à copier."`, `"sessions.queue.title": "En attente"`.

`docs/adr/0008-pap-records-added-in-m2.md`:

```markdown
# ADR 0008 — pap records added to the daemon ⇄ pi-host protocol in M2

Status: accepted · Date: 2026-10-11 · Spec: C §2.3 (records), as extended by ADR 0001

## Context
Spec C §2.3 lists the records of the protocol. M2 needs a few it does not list: the policy's own approval question
(spec C §5.3 wants four answers, and an extension's `ctx.ui.confirm` must not be able to look like the policy), a
way to cancel a custom panel the daemon will not show, naming through the session's model, and the leaf and name of
a session at start.

## Decision
- daemon → worker: `auto_name{id}`, `custom_cancel{id}`, `approval_response{id, answer: once|session|always|deny}`
  (alongside the Pi RPC shapes `clear_queue`, `compact`, `navigate_tree`, `set_session_name`, `export_html` and the
  spec's `custom_input`).
- worker → daemon: `approval_request{id, category, title, message, answers, tool, key}` (sent only by pap-policy,
  answered `deny` when cancelled), and `ready{…, leafId, sessionName}`. `extension_ui_closed{id}` also closes an
  approval the worker withdrew.
- `toWireEvent` slims two Pi events: `entry_appended` keeps the entry's identity (and a summary's text), and
  `queue_update` carries previews plus the full count and byte size.
- `PROTOCOL_VERSION` (the client protocol) goes to 2 with the snapshot's new shape.

## Consequences
- `PAP_TYPES` is derived from `PapRecord` (R67): the new worker records can never be forwarded as Pi events.
- A worker of this version refuses nothing older daemons send; an older worker answers the new commands with
  `unsupported command` (Task 1's default branch), never silence.
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions packages/pi-host/src/host.int.test.ts`
Expected: PASS (the i18n test checks that every error code has an en and fr message; the reducer tests read `entryId: null` from a v2 snapshot).

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip`

```bash
git add packages/contracts apps/daemon/src packages/pi-host/src/host.ts apps/web/src scripts/smoke-dist.ts docs/adr/0008-pap-records-added-in-m2.md
git commit -m "feat(contracts): protocol v2 records, stream events and snapshot sections"
```

---

### Task 2: pi-host session commands — queue, compaction, branching, naming, export, slim wire events

**Risks / rulings needed:** If `session.compact()` refuses the two-exchange session even with `keepRecentTokens: 1`, the test adds exchanges (no behaviour change). Pi throws on `navigateTree` while streaming; the daemon refuses earlier with `session_busy` (Task 17).

**Files:**
- Create: `packages/pi-host/src/dispatch.ts`, `packages/pi-host/src/session-commands.ts`, `packages/pi-host/src/session-commands.test.ts`
- Modify: `packages/pi-host/src/host.ts` (uses `createDispatch`), `packages/pi-host/src/wire-events.ts`, `packages/pi-host/src/wire-events.test.ts`, `packages/pi-host/src/host.int.test.ts`

**Interfaces:**
- Consumes: Task 1 records.
- Produces:
  - `createDispatch(deps: { session: AgentSession; ipc: Ipc; ui: UiBridge; setRules(rules: PolicyRules): void }): (record: Command) => void` where `Command = Exclude<DaemonToWorker, { type: "init" | "shutdown" }>`.
  - Responses: `clear_queue` → `{steering: string[], followUp: string[], truncated: boolean}` (at most `MAX_CLEARED_BYTES = 900_000` bytes of text); `compact` → `{tokensBefore: number, estimatedTokensAfter: number | null}`; `navigate_tree` → `{cancelled: boolean, leafId: string | null, editorText?: string}`; `set_session_name` → no data; `export_html` → `{path: string}`.
  - Wire events: `entry_appended` → `{type, entry: slimEntry(entry)}`; `queue_update` → `{type, steering: string[], followUp: string[], count, bytes}` (previews ≤ `UI_LIMITS.queuePreviewChars`, ≤ 128 each, `count`/`bytes` over the full texts).

- [ ] **Step 1: Write the failing unit tests**

`packages/pi-host/src/session-commands.test.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  fitTexts,
  handleClearQueue,
  handleCompact,
  handleExportHtml,
  handleNavigateTree,
  handleSetSessionName,
  MAX_CLEARED_BYTES,
} from "./session-commands.ts";

type Sent = Record<string, unknown>;
const recorder = () => {
  const sent: Sent[] = [];
  return { sent, send: (record: Sent) => void sent.push(record) };
};
const fake = (fields: Record<string, unknown>) => fields as unknown as AgentSession;

describe("session commands", () => {
  it("clears the queue and hands back what fits", () => {
    const { sent, send } = recorder();
    handleClearQueue(fake({ clearQueue: () => ({ steering: ["left"], followUp: ["after"] }) }), { id: "r1" }, send);
    expect(sent).toEqual([
      { type: "response", id: "r1", command: "clear_queue", success: true, data: { steering: ["left"], followUp: ["after"], truncated: false } },
    ]);
    const big = "x".repeat(MAX_CLEARED_BYTES);
    expect(fitTexts(["a", big], ["b"])).toEqual({ steering: ["a"], followUp: ["b"], truncated: true });
  });

  it("compacts and reports the sizes, or the failure", async () => {
    const { sent, send } = recorder();
    await handleCompact(fake({ compact: async () => ({ tokensBefore: 900, estimatedTokensAfter: 120 }) }), { id: "r1" }, send);
    await handleCompact(fake({ compact: async () => { throw new Error("Nothing to compact"); } }), { id: "r2" }, send);
    expect(sent).toEqual([
      { type: "response", id: "r1", command: "compact", success: true, data: { tokensBefore: 900, estimatedTokensAfter: 120 } },
      { type: "response", id: "r2", command: "compact", success: false, error: "Nothing to compact" },
    ]);
  });

  it("navigates and reports the new leaf and the text to edit", async () => {
    const { sent, send } = recorder();
    const session = fake({
      navigateTree: async (targetId: string) => ({ cancelled: false, editorText: `edit ${targetId}` }),
      sessionManager: { getLeafId: () => "a1" },
    });
    await handleNavigateTree(session, { id: "r1", targetId: "u2" }, send);
    expect(sent[0]).toEqual({ type: "response", id: "r1", command: "navigate_tree", success: true, data: { cancelled: false, leafId: "a1", editorText: "edit u2" } });
  });

  it("names the session and exports it", async () => {
    const { sent, send } = recorder();
    const names: string[] = [];
    handleSetSessionName(fake({ setSessionName: (name: string) => void names.push(name) }), { id: "r1", name: "Fix login" }, send);
    await handleExportHtml(fake({ exportToHtml: async (path: string) => path }), { id: "r2", outputPath: "/pap/exports/x.html" }, send);
    expect(names).toEqual(["Fix login"]);
    expect(sent.map((record) => record.data ?? null)).toEqual([null, { path: "/pap/exports/x.html" }]);
  });
});
```

Append to `packages/pi-host/src/wire-events.test.ts`:

```ts
describe("slim wire events", () => {
  it("keeps an entry's identity and drops its body", () => {
    const event = {
      type: "entry_appended",
      entry: { type: "message", id: "e2", parentId: "e1", timestamp: "2026-10-11T00:00:00.000Z", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "x".repeat(100_000) }], timestamp: 5 } },
    };
    expect(toWireEvent(event as never)).toEqual({
      type: "entry_appended",
      entry: { id: "e2", parentId: "e1", type: "message", timestamp: "2026-10-11T00:00:00.000Z", role: "toolResult", toolCallId: "c1", messageTimestamp: 5 },
    });
  });

  it("keeps a compaction's summary, clipped", () => {
    const event = { type: "entry_appended", entry: { type: "compaction", id: "c", parentId: "e2", timestamp: "t", summary: "s".repeat(70_000), tokensBefore: 900, firstKeptEntryId: "e1" } };
    const wire = toWireEvent(event as never) as { entry: { summary: string; tokensBefore: number } };
    expect(wire.entry.summary).toHaveLength(65_536);
    expect(wire.entry.tokensBefore).toBe(900);
  });

  it("sends queue previews with the full count and size", () => {
    const wire = toWireEvent({ type: "queue_update", steering: ["é".repeat(3000)], followUp: ["b"] } as never);
    expect(wire).toEqual({ type: "queue_update", steering: ["é".repeat(2000)], followUp: ["b"], count: 2, bytes: 6001 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host`
Expected: FAIL (module `session-commands.ts` not found; `entry_appended` forwarded whole).

- [ ] **Step 3: Write the commands, the dispatch and the slim events**

`packages/pi-host/src/session-commands.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { UI_LIMITS } from "@pap/contracts";
import { messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";

type Send = (record: Outbound) => unknown;

const ok = (send: Send, id: string, command: string, data?: unknown) =>
  send({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
const failed = (send: Send, id: string, command: string, error: unknown) =>
  send({ type: "response", id, command, success: false, error: messageOf(error) });

/** Pi's queue may hold up to 32 MiB; a response stays far below the record cap, and what does not fit is said. */
export const MAX_CLEARED_BYTES = 900_000;

export function fitTexts(steering: readonly string[], followUp: readonly string[], max = MAX_CLEARED_BYTES) {
  let left = max;
  let truncated = false;
  const take = (texts: readonly string[]) =>
    texts.filter((text) => {
      const size = Buffer.byteLength(text);
      if (size > left) {
        truncated = true;
        return false;
      }
      left -= size;
      return true;
    });
  return { steering: take(steering), followUp: take(followUp), truncated };
}

export function handleClearQueue(session: AgentSession, command: { id: string }, send: Send): void {
  try {
    const cleared = session.clearQueue();
    ok(send, command.id, "clear_queue", fitTexts(cleared.steering, cleared.followUp));
  } catch (error) {
    failed(send, command.id, "clear_queue", error);
  }
}

export async function handleCompact(
  session: AgentSession,
  command: { id: string; customInstructions?: string | undefined },
  send: Send,
): Promise<void> {
  try {
    const result = await session.compact(command.customInstructions);
    ok(send, command.id, "compact", {
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter ?? null,
    });
  } catch (error) {
    failed(send, command.id, "compact", error);
  }
}

// No summary of the abandoned branch: that would call the model, and the UI does not offer it yet (deferred).
export async function handleNavigateTree(
  session: AgentSession,
  command: { id: string; targetId: string },
  send: Send,
): Promise<void> {
  try {
    const result = await session.navigateTree(command.targetId, { summarize: false });
    ok(send, command.id, "navigate_tree", {
      cancelled: result.cancelled,
      leafId: session.sessionManager.getLeafId(),
      ...(result.editorText === undefined ? {} : { editorText: result.editorText.slice(0, UI_LIMITS.editorText) }),
    });
  } catch (error) {
    failed(send, command.id, "navigate_tree", error);
  }
}

export function handleSetSessionName(session: AgentSession, command: { id: string; name: string }, send: Send): void {
  try {
    session.setSessionName(command.name);
    ok(send, command.id, "set_session_name");
  } catch (error) {
    failed(send, command.id, "set_session_name", error);
  }
}

export async function handleExportHtml(
  session: AgentSession,
  command: { id: string; outputPath: string },
  send: Send,
): Promise<void> {
  try {
    ok(send, command.id, "export_html", { path: await session.exportToHtml(command.outputPath) });
  } catch (error) {
    failed(send, command.id, "export_html", error);
  }
}
```

If the SDK's `CompactionResult` names a field differently from `docs/rpc-commands.md` (`tokensBefore`, `estimatedTokensAfter`), read it from `dist/core/compaction/*.d.ts` and map it here; the test pins the response shape, not the SDK's.

`packages/pi-host/src/dispatch.ts` (the `switch` moved out of `host.ts`, with the new cases and Task 1's `default`):

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type DaemonToWorker, PolicyRules } from "@pap/contracts";
import { logLineOf } from "./bounded.ts";
import { handleAbort, handleGetState, handlePrompt } from "./commands.ts";
import type { Ipc } from "./ipc.ts";
import { POLICY_EXTENSION_PATH } from "./policy/extension.ts";
import {
  handleClearQueue,
  handleCompact,
  handleExportHtml,
  handleNavigateTree,
  handleSetSessionName,
} from "./session-commands.ts";
import type { UiBridge } from "./ui-bridge.ts";

export type Command = Exclude<DaemonToWorker, { type: "init" | "shutdown" }>;

export interface DispatchDeps {
  readonly session: AgentSession;
  readonly ipc: Ipc;
  readonly ui: UiBridge;
  setRules(rules: PolicyRules): void;
}

/** One record, one handler. Long commands are not awaited: the next record must not wait behind a compaction. */
export function createDispatch(deps: DispatchDeps): (record: Command) => void {
  const { session, ipc, ui } = deps;
  const send = (record: Parameters<Ipc["send"]>[0]) => ipc.send(record);
  // The handlers answer their own failures; this only catches a failure after the answer (a throwing `send`).
  const background = (command: string, work: Promise<void>): void => {
    work.catch((error: unknown) => process.stderr.write(`pi-host: ${command} failed after it answered: ${logLineOf(error)}\n`));
  };
  return (record) => {
    switch (record.type) {
      case "prompt":
        handlePrompt(session, record, send);
        return;
      case "abort":
        background("abort", handleAbort(session, record, send));
        return;
      case "get_state":
        handleGetState(session, record, send);
        return;
      case "clear_queue":
        handleClearQueue(session, record, send);
        return;
      case "compact":
        background("compact", handleCompact(session, record, send));
        return;
      case "navigate_tree":
        background("navigate_tree", handleNavigateTree(session, record, send));
        return;
      case "set_session_name":
        handleSetSessionName(session, record, send);
        return;
      case "export_html":
        background("export_html", handleExportHtml(session, record, send));
        return;
      case "extension_ui_response":
        ui.resolve(record);
        return;
      case "policy_update": {
        const update = PolicyRules.safeParse(record.rules);
        if (update.success) deps.setRules(update.data);
        else
          send({
            type: "extension_error",
            extensionPath: POLICY_EXTENSION_PATH,
            event: "policy_update",
            error: "invalid policy rules: the previous rules stay in force",
          });
        return;
      }
      default: {
        const unknown = record as { type: string; id?: unknown };
        if (typeof unknown.id === "string") {
          send({ type: "response", id: unknown.id, command: unknown.type.slice(0, 64), success: false, error: "unsupported command" });
        }
      }
    }
  };
}
```

`host.ts` replaces its inline `dispatch = (record) => { switch … }` with `dispatch = createDispatch({ session: opened, ipc, ui, setRules: (next) => { rules = next; } })` and imports nothing it no longer uses.

`packages/pi-host/src/wire-events.ts` gains, before the `message_update` branch of `toWireEvent`:

```ts
import { UI_LIMITS } from "@pap/contracts";

const SUMMARY_CHARS = 65_536;

const clipped = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/**
 * What the daemon needs of an appended entry: its place in the tree and what binds it to a message it already saw
 * (`message_end` came first, S1). The body stays here: a tool result can weigh megabytes. Compactions and branch
 * summaries have no message event, so their summary travels (clipped); a custom message travels as its own event.
 */
export function slimEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const base = { id: entry.id, parentId: entry.parentId ?? null, type: entry.type, timestamp: entry.timestamp };
  switch (entry.type) {
    case "message": {
      const message = (entry.message ?? {}) as { role?: unknown; toolCallId?: unknown; timestamp?: unknown };
      return {
        ...base,
        ...(typeof message.role === "string" ? { role: message.role } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        ...(typeof message.timestamp === "number" ? { messageTimestamp: message.timestamp } : {}),
      };
    }
    case "compaction":
      return { ...base, summary: clipped(entry.summary, SUMMARY_CHARS), tokensBefore: entry.tokensBefore };
    case "branch_summary":
      return { ...base, summary: clipped(entry.summary, SUMMARY_CHARS), fromId: entry.fromId };
    default:
      return base;
  }
}

function queueOf(event: { steering?: readonly string[]; followUp?: readonly string[] }) {
  const steering = event.steering ?? [];
  const followUp = event.followUp ?? [];
  const preview = (texts: readonly string[]) =>
    texts.slice(0, UI_LIMITS.queueEntries).map((text) => text.slice(0, UI_LIMITS.queuePreviewChars));
  return {
    type: "queue_update",
    steering: preview(steering),
    followUp: preview(followUp),
    count: steering.length + followUp.length,
    bytes: [...steering, ...followUp].reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
}
```

and in `toWireEvent`:

```ts
  if (event.type === "entry_appended") {
    return { type: "entry_appended", entry: slimEntry((event as { entry: Record<string, unknown> }).entry) };
  }
  if (event.type === "queue_update") return queueOf(event as never);
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit packages/pi-host`
Expected: PASS.

- [ ] **Step 5: Write the integration tests with the scripted provider**

Append to `packages/pi-host/src/host.int.test.ts` (it already has a host bed `bed = createHostBed()` per test and helpers from `testing/host-bed.ts`):

```ts
describe("session commands over IPC", () => {
  it("reports the leaf in ready and moves it with navigate_tree, so the next prompt branches", async () => {
    const ready = await bed.start({ steps: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    expect(ready.leafId).toBeNull();
    const host = bed.host();
    for (const text of ["first", "second"]) {
      await host.request({ type: "prompt", message: text });
      await host.waitFor((r) => r.type === "agent_settled", { from: host.records.length - 1 });
    }
    const entries = () => host.records.flatMap((r) => (r.type === "entry_appended" ? [r.entry as { id: string; parentId: string | null; role?: string }] : []));
    const firstReply = entries().find((entry) => entry.role === "assistant");
    if (!firstReply) throw new Error("no assistant entry");
    const moved = await host.request({ type: "navigate_tree", targetId: firstReply.id });
    expect(moved).toMatchObject({ success: true, data: { cancelled: false, leafId: firstReply.id } });
    const before = entries().length;
    await host.request({ type: "prompt", message: "third" });
    await host.waitFor((r) => r.type === "agent_settled", { from: host.records.length - 1 });
    // The new user message hangs under the first reply: a sibling of "second", in the same file.
    expect(entries().slice(before).find((entry) => entry.role === "user")?.parentId).toBe(firstReply.id);
  });

  it("names, compacts and exports a session", async () => {
    await bed.start(
      { steps: [{ text: "first reply" }, { text: "second reply" }, { text: "a summary of the session" }] },
      { settings: { compaction: { keepRecentTokens: 1 } } },
    );
    const host = bed.host();
    for (const text of ["first", "second"]) {
      await host.request({ type: "prompt", message: text });
      await host.waitFor((r) => r.type === "agent_settled", { from: host.records.length - 1 });
    }
    expect(await host.request({ type: "set_session_name", name: "Fix login" })).toMatchObject({ success: true });
    await host.waitFor((r) => r.type === "session_info_changed" && r.name === "Fix login");
    const compacted = await host.request({ type: "compact" });
    expect(compacted).toMatchObject({ success: true, data: { tokensBefore: expect.any(Number) } });
    await host.waitFor((r) => r.type === "entry_appended" && (r.entry as { type: string }).type === "compaction");
    const out = join(bed.papHome, "export.html");
    expect(await host.request({ type: "export_html", outputPath: out })).toMatchObject({ success: true, data: { path: out } });
    expect(readFileSync(out, "utf8")).toContain("<html");
  });

  it("clears the steering queue of a run parked on an approval", async () => {
    await bed.start(bashScript("echo parked"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isConfirm);
    expect(await host.request({ type: "prompt", message: "go left instead", streamingBehavior: "steer" })).toMatchObject({ data: { disposition: "queued" } });
    await host.waitFor((r) => r.type === "queue_update" && r.count === 1);
    expect(await host.request({ type: "clear_queue" })).toMatchObject({ data: { steering: ["go left instead"], followUp: [], truncated: false } });
    host.send({ type: "extension_ui_response", id: ask.id, cancelled: true });
    await host.waitFor((r) => r.type === "agent_settled");
  });
});
```

(Task 13 replaces `isConfirm` with the approval record; this test then waits for `approval_request` and answers `approval_response{answer:"deny"}`.) If Pi refuses to compact the two-exchange session even with `keepRecentTokens: 1`, add exchanges until `compact` succeeds and note the number in the test comment; do not change the assertion.

- [ ] **Step 6: Run them**

Run: `pnpm test:int packages/pi-host`
Expected: PASS, and the bed's network-guard check (R94) finds no blocked connection.

- [ ] **Step 7: Gate and commit**

```bash
git add packages/pi-host/src
git commit -m "feat(pi-host): queue, compaction, tree navigation, naming and export commands"
```

---

### Task 3: pi-host auto-name — a title from the transcript, through the session's own model

Behaviour reference: pi-web `lib/session-title.ts` (read, not copied): the user's turns and the last reply, tool traffic dropped, a short system prompt, no tools, a fresh request with no cache, the cheapest reasoning level. T3 Code does the same with an ephemeral Pi process (`textGeneration.ts`); pap already has the session's model and credentials in the worker, so it calls `session.modelRuntime.completeSimple`.

**Risks / rulings needed:** The option names of `ModelRuntime.completeSimple` (`maxTokens`, `signal`, `reasoning`) are read from the SDK `.d.ts`; adapting them is not a ruling. The title prompt is pap's own wording, not pi-web's text.

**Files:**
- Create: `packages/pi-host/src/title.ts`, `title.test.ts`, `packages/pi-host/src/auto-name.ts`
- Modify: `packages/pi-host/src/dispatch.ts`, `packages/pi-host/src/host.int.test.ts`

**Interfaces:**
- Consumes: Task 2 dispatch.
- Produces: `buildTitleTranscript(messages: readonly unknown[]): string`, `parseTitle(raw: string): string | null`, `TITLE_SYSTEM_PROMPT`, `TITLE_PROMPT`; `handleAutoName(session, {id}, send)` → response `{title}`, or `success: false` with error `"nothing to name"` (no user text) / `"no model"` / the model's failure. The title is set with `session.setSessionName(title)`, so Pi emits `session_info_changed`.

- [ ] **Step 1: Write the failing tests**

`packages/pi-host/src/title.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTitleTranscript, parseTitle } from "./title.ts";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }] });
const tool = { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "secret output" }] };

describe("title transcript", () => {
  it("keeps every user turn and the replies' text, drops tool traffic", () => {
    const text = buildTitleTranscript([user("Fix the login bug"), assistant("Looking."), tool, user("Also the logout"), assistant("Done both.")]);
    expect(text).toContain("User: Fix the login bug");
    expect(text).toContain("User: Also the logout");
    expect(text).toContain("Assistant: Done both.");
    expect(text).not.toContain("secret output");
    expect(text).not.toContain("ls");
  });

  it("stays within its budget, keeping the opening turns", () => {
    const many = Array.from({ length: 200 }, (_, i) => user(`turn ${i} ${"x".repeat(500)}`));
    const text = buildTitleTranscript(many);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain("turn 0 ");
    expect(text).toContain("turn 199 ");
  });

  it("is empty without user text, and images become a placeholder", () => {
    expect(buildTitleTranscript([assistant("hello")])).toBe("");
    expect(buildTitleTranscript([{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] }])).toContain("[image]");
  });
});

describe("parseTitle", () => {
  it.each([
    ["Fix the login bug", "Fix the login bug"],
    ['"Fix the login bug"', "Fix the login bug"],
    ["Title: **Fix the login bug**\nBecause…", "Fix the login bug"],
    ["   \n  ", null],
  ])("reads %j as %j", (raw, expected) => {
    expect(parseTitle(raw)).toBe(expected);
  });

  it("cuts a long answer to 80 characters on a word", () => {
    const title = parseTitle("word ".repeat(40)) ?? "";
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host/src/title.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `title.ts` and `auto-name.ts`**

`packages/pi-host/src/title.ts`:

```ts
const USER_CHARS = 800;
const REPLY_CHARS = 300;
const LAST_REPLY_CHARS = 600;
const TRANSCRIPT_CHARS = 6000;
/** A session often states its goal early and drifts into chores: the opening turns keep this share of the budget. */
const HEAD_CHARS = Math.round(TRANSCRIPT_CHARS * 0.4);
const MAX_TITLE_CHARS = 80;
const ELISION = "[…]";

export const TITLE_SYSTEM_PROMPT = "You name chat sessions from a transcript. Reply with the title only.";
export const TITLE_PROMPT = [
  "Write a short title for the session above.",
  "- Use the language the user writes in.",
  "- Name the user's goal or the outcome, not the act of chatting.",
  "- 4 to 12 words (8 to 24 characters for Chinese, Japanese or Korean).",
  "- Do not call any tool.",
  "- Reply with the title alone: no quotes, label, markdown or explanation.",
].join("\n");

type Block = { type?: unknown; text?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join(" ");
}

const cut = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}${ELISION}` : flat;
};

/** The lines the model reads: every user turn and the replies' text, tool calls and results left out. */
export function buildTitleTranscript(messages: readonly unknown[]): string {
  const turns = messages.flatMap((raw) => {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textOf(message.content);
    return text.trim() ? [{ role: message.role, text }] : [];
  });
  if (!turns.some((turn) => turn.role === "user")) return "";
  const lastReply = turns.findLastIndex((turn) => turn.role === "assistant");
  const lines = turns.map((turn, index) =>
    turn.role === "user"
      ? `User: ${cut(turn.text, USER_CHARS)}`
      : `Assistant: ${cut(turn.text, index === lastReply ? LAST_REPLY_CHARS : REPLY_CHARS)}`,
  );
  const whole = lines.join("\n");
  if (whole.length <= TRANSCRIPT_CHARS) return whole;
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > HEAD_CHARS) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  for (const line of lines.slice(head.length).toReversed()) {
    if (used + line.length + 1 > TRANSCRIPT_CHARS - ELISION.length - 1) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  return [...head, ELISION, ...tail].join("\n");
}

/** The first line of the model's answer, without quotes, markdown or a "Title:" label, at most 80 characters. */
export function parseTitle(raw: string): string | null {
  const line = raw.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  const bare = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[*_#>`\s]+|[*_`\s]+$/g, "")
    .replace(/^["'«“‘]+|["'»”’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!bare) return null;
  if (bare.length <= MAX_TITLE_CHARS) return bare;
  const room = bare.slice(0, MAX_TITLE_CHARS - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > 20 ? room.slice(0, space) : room).trimEnd()}…`;
}
```

`packages/pi-host/src/auto-name.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import { buildTitleTranscript, parseTitle, TITLE_PROMPT, TITLE_SYSTEM_PROMPT } from "./title.ts";

const TITLE_TIMEOUT_MS = 90_000;
const TITLE_MAX_TOKENS = 256;

type Send = (record: Outbound) => unknown;

/**
 * One request with the session's model and credentials, outside the conversation: a short system prompt, one user
 * turn, no tools, the cheapest reasoning level. The title becomes the session's name through Pi itself.
 */
export async function handleAutoName(session: AgentSession, command: { id: string }, send: Send): Promise<void> {
  const answer = (fields: Record<string, unknown>) => send({ type: "response", id: command.id, command: "auto_name", ...fields });
  const model = session.model;
  if (!model) return void answer({ success: false, error: "no model" });
  const transcript = buildTitleTranscript(session.messages);
  if (!transcript) return void answer({ success: false, error: "nothing to name" });
  const levels = session.getAvailableThinkingLevels();
  const cheapest = levels.find((level) => level !== "off");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const reply = await session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: `${transcript}\n\n${TITLE_PROMPT}` }], timestamp: Date.now() }],
      },
      {
        maxTokens: TITLE_MAX_TOKENS,
        signal: controller.signal,
        ...(levels.includes("off") || !cheapest ? {} : { reasoning: cheapest }),
      },
    );
    const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const title = parseTitle(text);
    if (!title) return void answer({ success: false, error: "the model gave no title" });
    session.setSessionName(title);
    answer({ success: true, data: { title } });
  } catch (error) {
    answer({ success: false, error: controller.signal.aborted ? "title generation timed out" : messageOf(error) });
  } finally {
    clearTimeout(timer);
  }
}
```

Check `ModelsSimpleStreamOptions` and `Context` in `dist/core/model-runtime.d.ts` and `@earendil-works/pi-ai`'s `.d.ts`: if the option names differ (`maxTokens`, `signal`, `reasoning`), use the SDK's names; if `session.messages` holds the system message first, `buildTitleTranscript` already ignores it (role filter). `dispatch.ts` gains `case "auto_name": void handleAutoName(session, record, send); return;`.

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit packages/pi-host`
Expected: PASS.

- [ ] **Step 5: Write the integration test**

Append to `host.int.test.ts`:

```ts
it("names a session from its transcript through the scripted model", async () => {
  await bed.start({ steps: [{ text: "I will look at the login form." }, { text: "Fix the login bug" }] });
  const host = bed.host();
  await host.request({ type: "prompt", message: "the login button does nothing" });
  await host.waitFor((r) => r.type === "agent_settled");
  expect(await host.request({ type: "auto_name" })).toMatchObject({ success: true, data: { title: "Fix the login bug" } });
  await host.waitFor((r) => r.type === "session_info_changed" && r.name === "Fix the login bug");
});

it("refuses to name a session nobody has spoken to", async () => {
  await bed.start({ steps: [{ text: "unused" }] });
  expect(await bed.host().request({ type: "auto_name" })).toMatchObject({ success: false, error: "nothing to name" });
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm test:int packages/pi-host` — Expected: PASS.

```bash
git add packages/pi-host/src
git commit -m "feat(pi-host): auto-name a session from its transcript"
```

---
### Task 4: pi-host lifecycle parity (R106) — `session_shutdown`, dropped dialogs, unserialisable responses, re-scan

**Risks / rulings needed:** If `ExtensionRunner.emit` does not type `session_shutdown`, the documented cast is pre-approved. R106's optional SIGSTOP variant is declined in favour of the bounded re-scan plus the scope: controller confirms.

**Files:**
- Create: `packages/pi-host/src/shutdown.ts`, `shutdown.test.ts`
- Modify: `packages/pi-host/src/host.ts`, `ipc.ts`, `ipc.test.ts`, `ui-bridge.ts`, `ui-bridge.test.ts`, `descendants.ts`, `descendants.test.ts`, `host.lifetime.int.test.ts`

**Interfaces:**
- Consumes: Task 2 `createDispatch`.
- Produces:
  - `closeSession(session, graceMs, timers?): Promise<void>`: aborts the run, then emits `session_shutdown {reason: "quit"}` to extensions, both inside one deadline of `graceMs`; never throws.
  - `Ipc.send(record): boolean` — true when the record was handed to the channel; false when it was dropped (too large, not serialisable) or the channel is closed. For an unserialisable `response` the daemon gets a failed response with the same id (`"response could not be serialised"`).
  - `createUiBridge(send: (record: UiOutbound) => boolean)`: a dialog whose request did not leave resolves at once with its fallback (`undefined`, `false`), so the extension never waits for an answer that cannot come.
  - `killDetachedDescendants()` sweeps up to `MAX_SWEEPS = 3` times, until a sweep finds nothing.

- [ ] **Step 1: Write the failing tests**

`packages/pi-host/src/shutdown.test.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { closeSession } from "./shutdown.ts";

function fakeTimers() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const timer = { at: now + ms, fn }; timers.push(timer); return timer; },
    clearTimer: (handle: unknown) => { timers.splice(timers.indexOf(handle as never), 1); },
    async advance(ms: number) { now += ms; for (const timer of timers.filter((t) => t.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } await Promise.resolve(); },
  };
}

describe("closeSession", () => {
  it("stops the run, then tells the extensions, as the pi CLI does on quit", async () => {
    const order: string[] = [];
    const session = {
      abort: async () => void order.push("abort"),
      extensionRunner: { emit: async (event: { type: string; reason: string }) => void order.push(`${event.type}:${event.reason}`) },
    } as unknown as AgentSession;
    await closeSession(session, 1500, fakeTimers());
    expect(order).toEqual(["abort", "session_shutdown:quit"]);
  });

  it("gives up on extensions that never finish when the grace runs out", async () => {
    const timers = fakeTimers();
    const session = {
      abort: async () => {},
      extensionRunner: { emit: () => new Promise(() => {}) },
    } as unknown as AgentSession;
    let done = false;
    const lines: string[] = [];
    const closing = closeSession(session, 1500, timers, (line) => void lines.push(line)).then(() => { done = true; });
    await timers.advance(1499);
    expect(done).toBe(false);
    await timers.advance(1);
    await closing;
    expect(done).toBe(true);
    expect(lines).toEqual(["pi-host: session_shutdown did not finish within the shutdown grace\n"]);
  });

  it("still emits when the abort throws, and says so in one line", async () => {
    const emitted: string[] = [];
    const lines: string[] = [];
    const session = {
      abort: async () => { throw new Error("stuck\nsecond line"); },
      extensionRunner: { emit: async (event: { type: string }) => void emitted.push(event.type) },
    } as unknown as AgentSession;
    await closeSession(session, 1500, fakeTimers(), (line) => void lines.push(line));
    expect(emitted).toEqual(["session_shutdown"]);
    expect(lines).toEqual(["pi-host: abort failed during shutdown: stuck second line\n"]);
  });
});
```

In `ipc.test.ts` (it drives `createIpc` with a fake process object), add:

```ts
it("answers a response it cannot serialise with a failed response of the same id", () => {
  const { proc, sent } = fakeProcess();
  const ipc = createIpc(proc);
  expect(ipc.send({ type: "response", id: "r7", command: "get_state", success: true, data: { big: 1n } })).toBe(false);
  expect(sent).toEqual([{ type: "response", id: "r7", command: "get_state", success: false, error: "response could not be serialised" }]);
});

it("says whether a record left", () => {
  const { proc } = fakeProcess();
  const ipc = createIpc(proc);
  expect(ipc.send({ type: "health", rssMb: 1 })).toBe(true);
  expect(ipc.send({ type: "health", blob: "x".repeat(MAX_RECORD_BYTES) })).toBe(false);
});
```

In `ui-bridge.test.ts`:

```ts
it("resolves a dialog at once when its request could not be sent", async () => {
  const bridge = createUiBridge(() => false, { newId: () => "d1" });
  expect(await bridge.context.confirm("Run?", "ls")).toBe(false);
  expect(await bridge.context.select("Pick", ["a"])).toBeUndefined();
  expect(bridge.pendingCount()).toBe(0);
});
```

In `descendants.test.ts`:

```ts
it("sweeps again until nothing is left, at most three times", () => {
  const tables = [
    [{ pid: 10, ppid: 1, pgrp: 10 }, { pid: 11, ppid: 10, pgrp: 11 }],
    [{ pid: 10, ppid: 1, pgrp: 10 }, { pid: 12, ppid: 10, pgrp: 12 }],
    [{ pid: 10, ppid: 1, pgrp: 10 }],
  ];
  let reads = 0;
  const killed: number[] = [];
  const count = killDetachedDescendants({
    platform: "linux",
    pid: 10,
    readTable: () => tables[Math.min(reads++, tables.length - 1)] ?? [],
    kill: (target) => void killed.push(target),
  });
  expect(count).toBe(2);
  expect(killed).toEqual([-11, 11, -12, 12]);
  expect(reads).toBe(3);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/pi-host/src/shutdown.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { logLineOf } from "./bounded.ts";

export interface ShutdownTimers {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL: ShutdownTimers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Stops the run, then tells extensions the session is closing, both inside one deadline. The pi CLI emits
 * `session_shutdown` on quit and `dispose()` does not (R106), so an extension holding a connection or a timer would
 * otherwise never hear of it. Whatever is left of the grace after the abort is what the handlers get; the daemon's
 * kill ladder follows 500 ms after the grace the worker was given. Never throws.
 */
export async function closeSession(
  session: AgentSession,
  graceMs: number,
  timers: ShutdownTimers = REAL,
  log: (line: string) => void = (line) => void process.stderr.write(line),
): Promise<void> {
  const deadline = timers.now() + graceMs;
  const within = (step: string, work: () => Promise<unknown>) =>
    new Promise<void>((resolve) => {
      const timer = timers.setTimer(() => {
        log(`pi-host: ${step} did not finish within the shutdown grace\n`);
        resolve();
      }, Math.max(0, deadline - timers.now()));
      const settle = () => {
        timers.clearTimer(timer);
        resolve();
      };
      Promise.resolve()
        .then(work)
        .then(settle, (error: unknown) => {
          log(`pi-host: ${step} failed during shutdown: ${logLineOf(error)}\n`);
          settle();
        });
    });
  await within("abort", () => session.abort());
  await within("session_shutdown", () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
}
```

If the SDK's `ExtensionRunner.emit` typing does not accept `SessionShutdownEvent`, the SDK's own helper is `emitSessionShutdownEvent(runner, event)` in `dist/core/extensions/runner.d.ts`; when it is not exported from the package root, cast the runner to `{ emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> }` with a one-line comment, and keep the integration test below as the proof.

`host.ts` `shutdown(graceMs)`:

```ts
  const shutdown = (graceMs: number) => {
    if (closing) return;
    closing = true;
    ui.cancelAll();
    // Before the abort, for the same reason: aborting kills the shell of a running command and orphans its children.
    killDetachedDescendants();
    const current = session;
    if (!current) exit(null, 0);
    const finish = () => exit(current, 0);
    void closeSession(current, graceMs).then(finish, finish);
  };
```

The disconnect, orphan and signal paths keep calling `exit()` directly: the daemon is gone or killing, there is no one to wait for.

`ipc.ts` `deliver` returns a boolean and handles a serialisation failure:

```ts
  const deliver = (record: Outbound): boolean => {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(record));
    } catch (error) {
      proc.stderr.write(`pi-host: a ${logLineOf(record.type).slice(0, 64)} record could not be serialised: ${logLineOf(error)}\n`);
      // A response is what the daemon waits for: it gets one, failed, under the same id.
      if (record.type === "response" && typeof record.id === "string") {
        deliver({ type: "response", id: record.id, command: logLineOf(record.command).slice(0, 64), success: false, error: "response could not be serialised" });
      }
      return false;
    }
    if (size > MAX_RECORD_BYTES) {
      refuse(record, size, deliver);
      return false;
    }
    try {
      if (!send(record) && !proc.connected) {
        markClosed();
        return false;
      }
      return true;
    } catch (error) {
      proc.stderr.write(`pi-host: ipc send failed: ${logLineOf(error)}\n`);
      return false;
    }
  };
```

with `Ipc.send(record: Outbound): boolean` and `refuse(..., send: (small: Outbound) => boolean)`.

`ui-bridge.ts`: `send: (record: UiOutbound) => boolean`; in `dialog()`, replace the `try { send(...) } catch { … }` with:

```ts
      const sent = (() => {
        try {
          return send({ type: "extension_ui_request", id, ...request, ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
        } catch {
          return false;
        }
      })();
      // Too large for the channel, or the channel is gone: no answer can come, so the extension gets its fallback now
      // instead of waiting for ever (R106).
      if (!sent && release()) resolve(fallback);
```

`descendants.ts`: rename the body of `killDetachedDescendants` (from `const table = readTable()` to the end) to `sweep(...)` returning the number killed, and:

```ts
/** Processes forked while a sweep ran are found by the next one; three sweeps cover a shell and its children. */
export const MAX_SWEEPS = 3;

export function killDetachedDescendants(env: Partial<CleanupEnv> = {}): number {
  const resolved = { ...realEnv(), ...env };
  if (resolved.platform !== "linux") return 0;
  let total = 0;
  for (let round = 0; round < MAX_SWEEPS; round++) {
    const killed = sweep(resolved);
    total += killed;
    if (killed === 0) break;
  }
  return total;
}
```

R106 mentions an optional SIGSTOP-then-scan variant: not taken. The bounded re-scan covers a process forked during a sweep; a fork bomb that outruns three sweeps is the systemd scope's job (Task 5), which kills the whole cgroup.

- [ ] **Step 4: Write the integration test**

In `host.lifetime.int.test.ts`:

```ts
it("tells extensions the session is closing before it exits (R106)", async () => {
  const probe = join(bed.root, "shutdown.txt");
  mkdirSync(join(bed.agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(bed.agentDir, "extensions", "shutdown-probe.js"),
    `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(probe)}, event.reason + "\\n")); }\n`,
  );
  await bed.start({ steps: [{ text: "unused" }] });
  const host = bed.host();
  host.send({ type: "shutdown", graceMs: 1500 });
  expect(await host.exited).toBe(0);
  expect(readFileSync(probe, "utf8")).toBe("quit\n");
});
```

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit packages/pi-host && pnpm test:int packages/pi-host`
Expected: PASS.

```bash
git add packages/pi-host/src
git commit -m "fix(pi-host): session_shutdown on quit, never leave a dropped dialog waiting"
```

---

### Task 5: Supervisor — workers in systemd user scopes (R46, R100, R106)

Reference: T3 Code `packages/shared/src/AgentScope.ts` and `apps/server/src/process/agentScope.ts` (a transient `systemd-run --user --scope` per agent, `OOMPolicy=stop`, `Result=oom-kill` read after exit, failed scopes cleared). pap differs in two ways: limits are per worker (R46), and the daemon kills the scope's cgroup after every exit, because Pi's detached bash trees survive a SIGKILLed worker (R100). Measured while planning on this host (systemd 259): `child_process.spawn("systemd-run", ["--user", "--scope", …, "--", node, entry], { stdio: [..., "ipc"], detached: true })` keeps the Node IPC channel working, the worker keeps the spawned pid (systemd-run execs in place) and leads its own process group, so the M1 guards hold.

**Risks / rulings needed:** `TasksMax` default 4096 is a proposal (open question 4). Runners without a systemd user manager skip `scope.int.test.ts` with a printed reason (open question 8). A worker's exit report waits up to 3 s for the scope reap.

**Files:**
- Create: `apps/daemon/src/kernel/supervisor/scope.ts`, `scope.test.ts`, `scope.int.test.ts`, `apps/daemon/src/kernel/supervisor/worker-io.ts`, `apps/daemon/src/kernel/which.ts`, `which.test.ts`
- Modify: `apps/daemon/src/kernel/supervisor/worker.ts` (launch through a scope; helpers moved to `worker-io.ts` and re-exported), `exit.ts`, `exit.test.ts`, `apps/daemon/src/kernel/testing/rogue-bed.ts` (mode `hog`, `scope` option)

**Interfaces:**
- Consumes: M1 supervisor.
- Produces:
  - `ScopeLimits { memoryHighMb; memoryMaxMb; tasksMax }`, `ScopeLaunch { command; args; env }`, `WorkerScopes { enabled; next(): { unit: string; launch: ScopeLaunch } | null; reap(unit): Promise<{ oomKilled: boolean }> }`, `NO_SCOPES`.
  - `probeScopes(mode: "auto" | "off", limits, deps: { exec: Exec; env; which(cmd): string | null; clock; logger; readCgroupFile? }): Promise<WorkerScopes>`; logs `worker_scopes {enabled, oomPolicy?, reason?}` once.
  - `execFileText: Exec` (no shell, timeout) and `whichOnPath(command, env): string | null` in `kernel/which.ts`.
  - `spawnWorker(options & { scope?: { launch: ScopeLaunch; reap(): Promise<{ oomKilled: boolean }> } })`: launches `launch.command launch.args… <node> <execArgv…> <entry>` instead of `fork`, and reports `exit.cause = "oom"` when `reap` says so.
  - `ExitCause` gains `"oom"`; `describeExit({cause: "oom"})` = `"Agent process ran out of memory and was stopped."`.

- [ ] **Step 1: Write the failing unit tests**

`apps/daemon/src/kernel/supervisor/scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { type Exec, probeScopes, SCOPE_SLICE } from "./scope.ts";

const LIMITS = { memoryHighMb: 512, memoryMaxMb: 768, tasksMax: 4096 };
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };

function fakeExec(answers: (file: string, args: readonly string[]) => { code: number | null; stdout?: string }) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const answer = answers(file, args);
    return { code: answer.code, stdout: answer.stdout ?? "" };
  };
  return { exec, calls };
}
const which = (command: string) => `/usr/bin/${command}`;
const deps = (exec: Exec, extra = {}) => ({ exec, env: ENV, which, clock: createFakeClock(), logger: silentLogger, ...extra });

describe("probeScopes", () => {
  it("is off when asked, without a user manager, or when systemd-run fails", async () => {
    const { exec } = fakeExec(() => ({ code: 0 }));
    expect((await probeScopes("off", LIMITS, deps(exec))).enabled).toBe(false);
    expect((await probeScopes("auto", LIMITS, deps(exec, { env: {} }))).enabled).toBe(false);
    expect((await probeScopes("auto", LIMITS, deps(exec, { which: () => null }))).enabled).toBe(false);
    const failing = fakeExec(() => ({ code: 1 }));
    expect((await probeScopes("auto", LIMITS, deps(failing.exec))).enabled).toBe(false);
  });

  it("wraps a worker in its own unit with the limits, and OOMPolicy when systemd knows it", async () => {
    const { exec } = fakeExec(() => ({ code: 0 }));
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    const next = scopes.next();
    expect(next?.unit).toMatch(/^pap-worker-[0-9a-f]{8}\.scope$/);
    expect(next?.launch).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user", "--scope", "--quiet", `--unit=${next?.unit}`, `--slice=${SCOPE_SLICE}`,
        "--property=MemoryHigh=512M", "--property=MemoryMax=768M", "--property=TasksMax=4096",
        "--property=TimeoutStopSec=5", "--property=OOMPolicy=stop", "--",
      ],
      env: ENV,
    });
  });

  it("leaves OOMPolicy out on an older systemd", async () => {
    const { exec } = fakeExec((_file, args) => ({ code: args.includes("--property=OOMPolicy=stop") ? 1 : 0 }));
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    expect(scopes.next()?.launch.args).not.toContain("--property=OOMPolicy=stop");
  });

  it("reaps: reads the result, kills what is left, stops and clears the unit", async () => {
    const { exec, calls } = fakeExec((_file, args) =>
      args[1] === "show" ? { code: 0, stdout: "LoadState=loaded\nActiveState=failed\nResult=oom-kill\nControlGroup=/u.slice/x.scope\n" } : { code: 0 },
    );
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    calls.length = 0;
    expect(await scopes.reap("pap-worker-1.scope")).toEqual({ oomKilled: true });
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["--user", "show"],
      ["--user", "kill"],
      ["--user", "stop"],
      ["--user", "reset-failed"],
    ]);
    expect(calls[1]).toContain("--signal=SIGKILL");
  });

  it("counts an OOM kill the cgroup recorded even before systemd sets the result", async () => {
    const { exec } = fakeExec((_file, args) =>
      args[1] === "show" ? { code: 0, stdout: "ActiveState=active\nResult=success\nControlGroup=/u/x.scope\n" } : { code: 0 },
    );
    const scopes = await probeScopes("auto", LIMITS, deps(exec, { readCgroupFile: () => "low 0\nhigh 3\nmax 1\noom 1\noom_kill 1\n" }));
    expect(await scopes.reap("u")).toEqual({ oomKilled: true });
  });

  it("never throws when systemctl fails", async () => {
    const exec: Exec = async (file, args) => {
      if (args.includes("true")) return { code: 0, stdout: "" };
      throw new Error(`${file} gone`);
    };
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    expect(await scopes.reap("u")).toEqual({ oomKilled: false });
  });
});
```

`exit.test.ts`: `expect(describeExit({ code: null, signal: "SIGKILL", cause: "oom" })).toBe("Agent process ran out of memory and was stopped.")`.

`which.test.ts`: `whichOnPath("sh", { PATH: "/nope:/bin:/usr/bin" })` ends with `/sh`; `whichOnPath("pap-no-such-command", { PATH: "/bin" })` is `null`; a non-executable file named like the command is skipped (create one in a temp dir with mode 0644).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `scope.ts`, `which.ts`, the launch and the cause**

`apps/daemon/src/kernel/supervisor/scope.ts`:

```ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";

export interface ScopeLimits {
  readonly memoryHighMb: number;
  readonly memoryMaxMb: number;
  readonly tasksMax: number;
}
export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
}
export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;
export interface ScopeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface WorkerScopes {
  readonly enabled: boolean;
  /** A unit of its own for the next worker, and the argv that goes before `node`. */
  next(): { unit: string; launch: ScopeLaunch } | null;
  /**
   * After the worker exited: whether it was killed for memory, then the scope's cgroup is SIGKILLed (what Pi started
   * in a group of its own survives the worker otherwise, R100), stopped and its failed state cleared. Never throws.
   */
  reap(unit: string): Promise<{ oomKilled: boolean }>;
}

export const NO_SCOPES: WorkerScopes = { enabled: false, next: () => null, reap: async () => ({ oomKilled: false }) };
/** Every worker scope sits in one slice: `systemctl --user status app-pap-workers.slice` lists them. */
export const SCOPE_SLICE = "app-pap-workers.slice";
const PROBE_TIMEOUT_MS = 5000;
const SYSTEMCTL_TIMEOUT_MS = 5000;
/** A scope being stopped by systemd can take a moment to record its result. */
const STOPPING_POLLS = 20;
const STOPPING_POLL_MS = 100;

export interface ProbeDeps {
  readonly exec: Exec;
  readonly env: NodeJS.ProcessEnv;
  which(command: string): string | null;
  readonly clock: Clock;
  readonly logger: Logger;
  readCgroupFile?(controlGroup: string, file: string): string;
}

export function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return values;
}

export function counterOf(text: string, key: string): number {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match ? Number(match[1]) : 0;
}

const readCgroup = (group: string, file: string): string => {
  try {
    return readFileSync(join("/sys/fs/cgroup", group, file), "utf8");
  } catch {
    return "";
  }
};

/** Probes once, at boot: a user manager that answers gets one scope per worker; anything else runs workers as in M1. */
export async function probeScopes(mode: "auto" | "off", limits: ScopeLimits, deps: ProbeDeps): Promise<WorkerScopes> {
  const off = (reason: string): WorkerScopes => {
    deps.logger.info("worker_scopes", { enabled: false, reason });
    return NO_SCOPES;
  };
  if (mode === "off") return off("PAP_WORKER_SCOPE=off");
  const runtimeDir = deps.env.XDG_RUNTIME_DIR;
  const systemdRun = deps.which("systemd-run");
  const systemctl = deps.which("systemctl");
  if (!runtimeDir || !systemdRun || !systemctl) return off("no systemd user manager");
  const run = (file: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> =>
    deps.exec(file, args, timeoutMs).catch(() => ({ code: null, stdout: "" }));
  const probe = async (extra: readonly string[]) =>
    (await run(systemdRun, ["--user", "--scope", "--quiet", "--collect", ...extra, "--", "true"], PROBE_TIMEOUT_MS)).code === 0;
  // OOMPolicy on scopes needs systemd 253; an older user manager still gets plain scopes.
  const oomPolicy = await probe(["--property=OOMPolicy=stop"]);
  if (!oomPolicy && !(await probe([]))) return off("systemd-run --user --scope failed");
  deps.logger.info("worker_scopes", { enabled: true, oomPolicy, ...limits });
  const properties = [
    `--property=MemoryHigh=${limits.memoryHighMb}M`,
    `--property=MemoryMax=${limits.memoryMaxMb}M`,
    `--property=TasksMax=${limits.tasksMax}`,
    // A stop never waits systemd's default 90 s for a process that ignores SIGTERM.
    "--property=TimeoutStopSec=5",
    ...(oomPolicy ? ["--property=OOMPolicy=stop"] : []),
  ];
  // A failed step is logged (unit and step only) and the next step still runs: reap never throws.
  const systemctlRun = async (args: readonly string[]): Promise<ExecResult> => {
    const result = await run(systemctl, ["--user", ...args], SYSTEMCTL_TIMEOUT_MS);
    if (result.code !== 0 && args[0] !== "show" && args[0] !== "reset-failed") {
      deps.logger.warn("worker_scope_step_failed", { step: args[0], unit: args.at(-1), code: result.code });
    }
    return result;
  };
  const cgroupFile = deps.readCgroupFile ?? readCgroup;
  return {
    enabled: true,
    next() {
      const unit = `pap-worker-${randomBytes(4).toString("hex")}.scope`;
      return {
        unit,
        launch: {
          command: systemdRun,
          args: ["--user", "--scope", "--quiet", `--unit=${unit}`, `--slice=${SCOPE_SLICE}`, ...properties, "--"],
          // systemd-run reaches the user manager through it; the worker inherits it, as any child of the user would.
          env: { XDG_RUNTIME_DIR: runtimeDir },
        },
      };
    },
    async reap(unit) {
      let oomKilled = false;
      for (let poll = 0; poll < STOPPING_POLLS; poll++) {
        const shown = await systemctlRun(["show", unit, "--property=LoadState,ActiveState,Result,ControlGroup"]);
        if (shown.code !== 0) break;
        const state = parseKeyValues(shown.stdout);
        const group = state.get("ControlGroup") ?? "";
        if (state.get("Result") === "oom-kill" || (group && counterOf(cgroupFile(group, "memory.events"), "oom_kill") > 0)) {
          oomKilled = true;
        }
        if (state.get("ActiveState") !== "deactivating") break;
        await deps.clock.sleep(STOPPING_POLL_MS);
      }
      await systemctlRun(["kill", "--signal=SIGKILL", unit]);
      await systemctlRun(["stop", unit]);
      await systemctlRun(["reset-failed", unit]);
      return { oomKilled };
    },
  };
}
```

`apps/daemon/src/kernel/which.ts`:

```ts
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Exec } from "./supervisor/scope.ts";

/** The first executable file named `command` on PATH, or null. No shell is involved. */
export function whichOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Runs a program without a shell; a timeout or a spawn failure rejects. Output is capped at 64 KiB. */
export const execFileText: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === "string") return reject(error);
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout });
    });
  });
```

`apps/daemon/src/kernel/supervisor/worker-io.ts`: move `OUTPUT_TAIL_BYTES`, `DEFAULT_REQUEST_TIMEOUT_MS`, `MAX_SHUTDOWN_GRACE_MS`, `MAX_WORKER_STRING`, `COMMAND_TIMEOUTS`, `requestTimeoutMs`, `clipWorkerString`, `boundedOutbound`, `boundedRecord`, `createTail` and `failedHandle` out of `worker.ts` unchanged; `worker.ts` re-exports every exported name (`export { … } from "./worker-io.ts"`), so no import elsewhere changes.

`worker.ts`: `SpawnWorkerOptions` gains

```ts
  /** Launch through a systemd scope (Task 5) instead of a plain fork; `reap` runs once the worker has exited. */
  readonly scope?: { readonly launch: ScopeLaunch; reap(): Promise<{ oomKilled: boolean }> };
```

the child is started with:

```ts
    child = options.scope
      ? spawn(options.scope.launch.command, [...options.scope.launch.args, process.execPath, ...options.execArgv, options.entry], {
          cwd: options.cwd,
          env: { ...options.env, ...options.scope.launch.env },
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          serialization: "json",
        })
      : fork(options.entry, [], { cwd: options.cwd, env: options.env, execArgv: [...options.execArgv], detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });
```

and the exit report waits for the reap (bounded), so the cause is right and the cgroup is empty when the session hears of the exit:

```ts
/** The longest an exit report waits for the scope to be read and stopped. */
export const REAP_TIMEOUT_MS = 3000;

  const report = (exit: WorkerExit): void => {
    const scope = options.scope;
    if (!scope) return finish(exit);
    let done = false;
    const once = (oomKilled: boolean) => {
      if (done) return;
      done = true;
      finish(oomKilled ? { ...exit, cause: "oom" } : exit);
    };
    const timer = clock.setTimeout(() => once(false), REAP_TIMEOUT_MS);
    void scope.reap().then(
      ({ oomKilled }) => { clock.clearTimeout(timer); once(oomKilled); },
      () => { clock.clearTimeout(timer); once(false); },
    );
  };
```

with the two `finish(exit)` calls of the `exit`/`close` handlers replaced by `report(exit)`. `exit.ts`: `ExitCause` adds `"oom"`; `describeExit` case `"oom"` returns `"Agent process ran out of memory and was stopped."`.

`rogue-bed.ts`: the `ROGUE` script gains `if (mode === "hog") { const kept = []; const timer = setInterval(() => { if (kept.length >= 64) { clearInterval(timer); process.exit(3); } kept.push(Buffer.alloc(16 * 1024 * 1024, 1)); }, 10); }` (after `send(ready)`; the 1 GiB stop makes a missing scope fail the test with exit code 3 instead of eating the host's memory), and `rogue(mode, options)` accepts `options.scope` and passes it to `spawnWorker`, adding `XDG_RUNTIME_DIR` from `process.env` to the worker env when a scope is given.

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit apps/daemon/src/kernel`
Expected: PASS (the M1 worker tests are unchanged: without `scope` nothing changes).

- [ ] **Step 5: Write the integration test (runs where a user manager answers)**

`apps/daemon/src/kernel/supervisor/scope.int.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { alive, createRogueBed, realPid, type RogueBed, waitForReady } from "../testing/rogue-bed.ts";
import { execFileText, whichOnPath } from "../which.ts";
import { probeScopes, type ScopeLimits, type WorkerScopes } from "./scope.ts";

const available = (() => {
  try {
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();
// Containment, not a security probe (R92): CI runners without a user manager skip it, and say so.
if (!available) console.warn("scope.int.test: skipped: no systemd user manager answers on this machine");

const scopesWith = (limits: ScopeLimits): Promise<WorkerScopes> =>
  probeScopes("auto", limits, {
    exec: execFileText,
    env: process.env,
    which: (command) => whichOnPath(command, process.env),
    clock: createSystemClock(),
    logger: silentLogger,
  });
const pgrpOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[2]);
const scopeOption = (scopes: WorkerScopes) => {
  const next = scopes.next();
  if (!next) throw new Error("no scope");
  return { unit: next.unit, scope: { launch: next.launch, reap: () => scopes.reap(next.unit) } };
};

let bed: RogueBed;
beforeEach(() => {
  bed = createRogueBed();
});
afterEach(() => bed.dispose());

describe.skipIf(!available)("workers in systemd user scopes", () => {
  it("runs a worker in a scope of its own with the R46 limits, leading its own process group (R106)", async () => {
    const { unit, scope } = scopeOption(await scopesWith({ memoryHighMb: 512, memoryMaxMb: 768, tasksMax: 4096 }));
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    const pid = handle.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    expect(pgrpOf(pid)).toBe(pid);
    expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(unit);
    const max = execFileSync("systemctl", ["--user", "show", unit, "--property=MemoryMax", "--value"], { encoding: "utf8" }).trim();
    expect(max).toBe(String(768 * 1024 * 1024));
    await handle.stop();
  });

  it("stops the scope after the worker dies, so what it started in a group of its own dies too (R100)", async () => {
    const { scope } = scopeOption(await scopesWith({ memoryHighMb: 512, memoryMaxMb: 768, tasksMax: 4096 }));
    const handle = bed.rogue("setsid-child", { scope });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    process.kill(realPid(handle.pid), "SIGKILL");
    expect((await handle.exited).cause).toBe("killed");
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 5000 });
  });

  it("says out of memory when the scope's limit kills the worker", async () => {
    const { scope } = scopeOption(await scopesWith({ memoryHighMb: 128, memoryMaxMb: 128, tasksMax: 64 }));
    const handle = bed.rogue("hog", { scope });
    expect((await handle.exited).cause).toBe("oom");
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm test:int apps/daemon/src/kernel/supervisor`
Expected: PASS on this host (three scope tests run); elsewhere they are reported as skipped with the warning line.

```bash
git add apps/daemon/src/kernel
git commit -m "feat(daemon): run workers in systemd user scopes and reap them after exit"
```

---

### Task 6: Config, boot probe and the daemon-layer network-guard check (R118)

**Risks / rulings needed:** Environment names `PAP_WORKER_IDLE_MINUTES`, `PAP_WORKER_SCOPE`, `PAP_WORKER_MEMORY_HIGH_MB`, `PAP_WORKER_MEMORY_MAX_MB`, `PAP_WORKER_TASKS_MAX`: confirm. The R118 check sees only the last 8 KiB of each worker's output.

**Files:**
- Modify: `apps/daemon/src/kernel/config.ts`, `config.test.ts`, `apps/daemon/src/daemon.ts`, `apps/daemon/src/modules/sessions/{index,service,live-session}.ts`, `apps/daemon/src/testing/harness.ts`
- Create: `apps/daemon/src/testing/harness.int.test.ts`

**Interfaces:**
- Consumes: Task 5 `probeScopes`, `execFileText`, `whichOnPath`.
- Produces:
  - `Config.workerIdleMs: number` (`PAP_WORKER_IDLE_MINUTES`, default 30, `0` = never release), `Config.workerScope: "auto" | "off"` (`PAP_WORKER_SCOPE`, default `auto`), `Config.workerLimits: ScopeLimits` (`PAP_WORKER_MEMORY_HIGH_MB` 512, `PAP_WORKER_MEMORY_MAX_MB` 768, `PAP_WORKER_TASKS_MAX` 4096; high ≤ max, max ≥ 256, tasks ≥ 64, each a `ConfigError` with a fixed message otherwise).
  - `SessionsModuleDeps.scopes: WorkerScopes` and `SessionsModuleDeps.onWorkerExit?(sessionId: string, info: { exit: WorkerExit; outputTail: string }): void`; `DaemonDeps.onWorkerExit?` passed through.
  - `startTestDaemon(script, { extensions?: Record<string, string> })` writes each `<name>.js` into the agent directory's `extensions/`; its `stop()` throws `a worker tried to reach the network:\n<lines>` when an exited worker's output tail has a line starting `pap-network-guard: blocked`. The harness runs with `workerScope: "off"` unless a test sets it.

- [ ] **Step 1: Write the failing tests**

In `config.test.ts`:

```ts
describe("worker settings", () => {
  it("defaults to 30 idle minutes, automatic scopes and the R46 limits", () => {
    const config = loadConfig(input({}));
    expect(config.workerIdleMs).toBe(30 * 60_000);
    expect(config.workerScope).toBe("auto");
    expect(config.workerLimits).toEqual({ memoryHighMb: 512, memoryMaxMb: 768, tasksMax: 4096 });
  });

  it("reads them from the environment", () => {
    const config = loadConfig(input({ PAP_WORKER_IDLE_MINUTES: "0", PAP_WORKER_SCOPE: "off", PAP_WORKER_MEMORY_HIGH_MB: "600", PAP_WORKER_MEMORY_MAX_MB: "1024", PAP_WORKER_TASKS_MAX: "512" }));
    expect(config.workerIdleMs).toBe(0);
    expect(config.workerScope).toBe("off");
    expect(config.workerLimits).toEqual({ memoryHighMb: 600, memoryMaxMb: 1024, tasksMax: 512 });
  });

  it.each([
    [{ PAP_WORKER_SCOPE: "maybe" }, "PAP_WORKER_SCOPE must be auto or off"],
    [{ PAP_WORKER_MEMORY_HIGH_MB: "900" }, "PAP_WORKER_MEMORY_HIGH_MB must not exceed PAP_WORKER_MEMORY_MAX_MB"],
    [{ PAP_WORKER_MEMORY_MAX_MB: "128", PAP_WORKER_MEMORY_HIGH_MB: "100" }, "PAP_WORKER_MEMORY_MAX_MB must be an integer ≥ 256"],
    [{ PAP_WORKER_TASKS_MAX: "8" }, "PAP_WORKER_TASKS_MAX must be an integer ≥ 64"],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig(input(env))).toThrow(message);
  });
});
```

(`input(env)` is the helper the file already uses to build a `ConfigInput`.)

`apps/daemon/src/testing/harness.int.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "./harness.ts";

describe("test daemon", () => {
  it("fails a test whose worker tried to reach the network, even when the code swallowed the refusal (R118)", async () => {
    const t = await startTestDaemon(
      { steps: [{ text: "unused" }] },
      { extensions: { sneaky: `export default function (pi) { pi.on("session_start", () => fetch("http://127.0.0.1:9/").catch(() => {})); }` } },
    );
    const client = await t.connect(await t.login());
    await client.call("sessions.create", { cwd: t.cwd }, true);
    await expect(t.stop()).rejects.toThrow("a worker tried to reach the network");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/config.test.ts && pnpm test:int apps/daemon/src/testing/harness.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`config.ts`: add the three fields to `Config`, parse them in `loadConfig` with the file's existing `parseCount` (and a `parseScope` that accepts exactly `auto` or `off`), then:

```ts
  const memoryMaxMb = input.env.PAP_WORKER_MEMORY_MAX_MB ? parseCount(input.env.PAP_WORKER_MEMORY_MAX_MB, "PAP_WORKER_MEMORY_MAX_MB", 256) : 768;
  const memoryHighMb = input.env.PAP_WORKER_MEMORY_HIGH_MB ? parseCount(input.env.PAP_WORKER_MEMORY_HIGH_MB, "PAP_WORKER_MEMORY_HIGH_MB", 1) : Math.min(512, memoryMaxMb);
  if (memoryHighMb > memoryMaxMb) throw new ConfigError("PAP_WORKER_MEMORY_HIGH_MB must not exceed PAP_WORKER_MEMORY_MAX_MB");
```

`workerIdleMs: (input.env.PAP_WORKER_IDLE_MINUTES ? parseCount(input.env.PAP_WORKER_IDLE_MINUTES, "PAP_WORKER_IDLE_MINUTES", 0) : 30) * 60_000`; `tasksMax` default 4096, minimum 64.

`daemon.ts`, before `createSessionsModule`:

```ts
    const scopes = await probeScopes(config.workerScope, config.workerLimits, {
      exec: execFileText,
      env: deps.env ?? process.env,
      which: (command) => whichOnPath(command, deps.env ?? process.env),
      clock,
      logger,
    });
```

and `createSessionsModule({ …, scopes, onWorkerExit: deps.onWorkerExit })`. `sessions/index.ts` spawns with the scope:

```ts
    spawn: (cwd) => {
      const next = deps.scopes.next();
      return spawnWorker({
        entry: config.piHostEntry,
        execArgv: config.piHostExecArgv,
        cwd,
        env,
        clock: deps.clock,
        logger: logger.child({ component: "worker", ...(next ? { unit: next.unit } : {}) }),
        ...(next ? { scope: { launch: next.launch, reap: () => deps.scopes.reap(next.unit) } } : {}),
      });
    },
```

`service.ts` passes `onWorkerExit` into each `LiveSession` as `onExit(exit)` already flows: in `live-session.ts`'s exit handler, after `deps.onExit(exit)`, call `deps.onWorkerExit?.({ exit, outputTail: handle.outputTail() })`; `service.ts` binds the session id: `onWorkerExit: (info) => deps.onWorkerExit?.(row.id, info)`. The tests' service bed passes nothing.

`harness.ts`: `TestDaemonOptions.extensions?: Record<string, string>` writes `<agentDir>/extensions/<name>.js` before `createDaemon`; the config gets `workerScope: "off", workerIdleMs: 30 * 60_000, workerLimits: { memoryHighMb: 512, memoryMaxMb: 768, tasksMax: 4096 }` (overridable through `options.config`); `deps.onWorkerExit` collects `{ sessionId, outputTail }`; `stop()`:

```ts
    async stop() {
      try {
        await daemon.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      // A connection the guard refused may have been swallowed by the code that tried it: the worker's log still says so (R94, R118).
      const blocked = exits.flatMap((exit) => exit.outputTail.split("\n")).filter((line) => line.startsWith("pap-network-guard: blocked"));
      if (blocked.length > 0) throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
    },
```

The check reads the last 8 KiB of each worker's output (`OUTPUT_TAIL_BYTES`): a refusal followed by more than 8 KiB of other output is not seen. Say so in a comment.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/daemon && pnpm test:int apps/daemon`
Expected: PASS.

```bash
git add apps/daemon/src
git commit -m "feat(daemon): worker idle, scope and limit settings; fail tests on swallowed network refusals"
```

---

### Task 7: Sessions module split — no behaviour change

`live-session.ts` (315 lines) and `service.ts` (296) take most of M2's additions; this task moves code so they have room. Nothing changes in behaviour: every existing test passes unchanged.

**Risks / rulings needed:** None: a pure move. A defect found while moving is reported, not fixed in this task.

**Files:**
- Create: `apps/daemon/src/modules/sessions/live-ui.ts`, `live-run.ts`, `worker-text.ts`, `service-reads.ts`
- Modify: `apps/daemon/src/modules/sessions/live-session.ts`, `service.ts`

**Interfaces:**
- Consumes: M1 sessions module, Task 6 `onWorkerExit`.
- Produces (internal to the module; later tasks edit these files):
  - `worker-text.ts`: `LOG_CHARS = 2000`, `clip(text)`, `SAFE_EVENT_NAME`, `outputTailOf(handle)` (the "…" + last 1999 characters rule).
  - `live-ui.ts`: `createLiveUi(deps: { handle; logger; limiter: RateLimiter; publish(event): void; publishPi(event: PiEvent): void }): LiveUi` with `onUiRequest(record)`, `onUiClosed(id)`, `onExtensionError(record)`, `answer(dialogId, response)`, `dialogs(): Dialog[]`, `clear(): Dialog[]`; moves `CANCEL_NOTICES`, the dialog registry ownership and the bodies of M1's `onUiRequest`, `onExtensionError`, `answer` and the `extension_ui_closed` case.
  - `live-run.ts`: `createLiveRun(deps: { handle; clock; logger; setStatus(next: SessionStatus): void; record(kind, data): void; onActivity(): void; piFile(): string | undefined; getState(): Promise<GetStateData> }): LiveRun` with `tracker: RunTracker`, `onPiEvent(event)` (tracker + run view), `prompt(text, behavior?)`, `abort()`, `runView()`, `onExit(): boolean` (returns whether a run was open, resets tracker and view); moves `ABORT_SETTLE_MS`, `closeStaleRun`, the tracker callbacks, the bodies of M1's `prompt` and `abort`.
  - `service-reads.ts`: `createSessionReads(deps: { store; agentDir; loadTranscript; live: ReadonlyMap<string, LiveSession>; statusOf(id): SessionStatus; owned(id, caller): SessionRow }): { prepare(sessionId, caller): Promise<void>; snapshot(sessionId): SessionStreamEvent; reader(): TranscriptReader | null }`; moves `transcript`, `loadingTranscript`, `prepareSubscription` and `snapshot` out of `service.ts`.
  - `live-session.ts` keeps `READY_TIMEOUT_MS`, `MAX_EVENT_BYTES`, `SAY_EVERY_MS`, `LiveSessionDeps`, `LiveSession`, `isSystemMessage`, `publishPi`, `onRecord` (routing to `ui` and `run`), the `ready` promise and the exit handler. `service.ts` keeps capacity, `launch`, `ensureLive`, `owned`, `statusOf`, the commands and `shutdownAll`, and delegates `prepareSubscription` / `snapshot` to `createSessionReads`.

- [ ] **Step 1: Record the baseline**

Run: `pnpm test:unit apps/daemon/src/modules/sessions && wc -l apps/daemon/src/modules/sessions/*.ts`
Expected: PASS; note the line counts.

- [ ] **Step 2: Move the code**

Cut and paste exactly the members listed above; each new file imports what its code uses; the factories receive what the moved code closed over. No renaming, no logic change, no new behaviour. `live-session.ts` builds `const ui = createLiveUi({...})` and `const run = createLiveRun({...})` and its returned object delegates (`dialogs: () => ui.dialogs()`, `prompt: (text, behavior) => run.prompt(text, behavior)`, …). The exit handler becomes:

```ts
  void handle.exited.then((exit) => {
    const wasRunning = run.onExit();
    for (const dialog of ui.clear()) deps.publish({ kind: "dialog_closed", id: dialog.id });
    if (wasRunning) deps.record("run_end", { interrupted: exit.cause });
    deps.record("worker_exit", exit);
    if (exit.cause === "clean") logger.info("worker_exited", { ...exit });
    else logger.warn("worker_exited", { ...exit, output: outputTailOf(handle) });
    setStatus("cold", describeExit(exit));
    deps.onActivity();
    deps.onExit(exit);
    deps.onWorkerExit?.({ exit, outputTail: handle.outputTail() });
  });
```

- [ ] **Step 3: Verify nothing changed**

Run: `pnpm test:unit apps/daemon/src/modules/sessions && pnpm test:int apps/daemon/src/modules/sessions && wc -l apps/daemon/src/modules/sessions/*.ts`
Expected: PASS with the same tests; `live-session.ts` and `service.ts` under 220 lines each.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/modules/sessions
git commit -m "refactor(sessions): split the live session and the service reads into their own files"
```

---

### Task 8: Run semantics backlog (R112, R113)

**Risks / rulings needed:** An abort with a prompt in flight sends one abort at once (a no-op if Pi is idle) and one at that prompt's `agent_start`.

**Files:**
- Modify: `apps/daemon/src/modules/sessions/{run-tracker,live-run,service,pi-files,dialogs}.ts` and their tests (`run-tracker.test.ts`, `live-session.test.ts`, `service.test.ts`, `pi-files.test.ts`, `dialogs.test.ts`)

**Interfaces:**
- Consumes: Task 7 `createLiveRun`.
- Produces:
  - `RunTracker`: a probe started for one run never ends another (`confirm` compares the run generation too).
  - `LiveRun.abort()`: with no run open and a prompt in flight, it remembers the abort and aborts at that prompt's `agent_start` (R113); the memory is dropped when every in-flight prompt has answered without starting a run.
  - `run_start` journal line carries `origin: "user" | "extension"`: `extension` when no input was sent since the last run (spec C §2.4: accepted and audited); an `info` log line `run_started_by_extension` too.
  - The service publishes `{kind: "status", status: "starting"}` when it reopens a cold session.
  - `isPiSessionFile(agentDir, path)` compares real paths (a link under `sessions/` that points outside is refused).
  - `dialogs.ts` reads its text limits from the `Dialog` schema.

- [ ] **Step 1: Write the failing tests**

`run-tracker.test.ts`:

```ts
it("never ends a run with the answer of a probe started for the previous one", async () => {
  const clock = createFakeClock();
  let answer: (state: GetStateData) => void = () => {};
  const log: string[] = [];
  const tracker = createRunTracker({
    clock,
    probe: () => new Promise((resolve) => { answer = resolve; }),
    onRunStart: () => log.push("start"),
    onRunEnd: () => log.push("end"),
  });
  tracker.onEvent({ type: "agent_start" });
  tracker.onEvent({ type: "agent_settled", aborted: false });
  await clock.advance(0);
  // An extension starts the next run before the probe answers: no input, so the revision did not move.
  tracker.onEvent({ type: "agent_start" });
  answer(idle);
  await clock.advance(0);
  expect(log).toEqual(["start"]);
  expect(tracker.running).toBe(true);
});
```

`live-session.test.ts` (uses `createLiveBed`, whose fake worker holds a prompt with `holdPrompt`):

```ts
it("aborts at agent_start when Stop came while the prompt was still in flight (R113)", async () => {
  const { live, worker, clock } = setup({ holdPrompt: true });
  const prompted = live.prompt("go");
  await clock.advance(0);
  const promptId = worker.requests.find((r) => r.type === "prompt")?.id ?? "";
  await live.abort();
  expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(1);
  worker.respond(promptId, { data: { disposition: "started" } });
  await prompted;
  worker.emit(piEvent({ type: "agent_start" }));
  await clock.advance(0);
  expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(2);
});

it("forgets that abort when the prompt started nothing", async () => {
  const { live, worker, clock } = setup({ holdPrompt: true });
  const prompted = live.prompt("/handled-command");
  await clock.advance(0);
  const promptId = worker.requests.find((r) => r.type === "prompt")?.id ?? "";
  await live.abort();
  worker.respond(promptId, { data: { disposition: "handled" } });
  await prompted;
  worker.emit(piEvent({ type: "agent_start" }));
  await clock.advance(0);
  expect(worker.requests.filter((r) => r.type === "abort")).toHaveLength(1);
});

it("records who started a run", async () => {
  const { live, worker, recorded, clock } = setup();
  worker.emit(piEvent({ type: "agent_start" }));
  worker.emit(piEvent({ type: "agent_settled", aborted: false }));
  await clock.advance(0);
  await live.prompt("hi");
  worker.emit(piEvent({ type: "agent_start" }));
  expect(recorded.filter(([kind]) => kind === "run_start").map(([, data]) => data)).toEqual([{ origin: "extension" }, { origin: "user" }]);
});
```

`service.test.ts`:

```ts
it("publishes starting when it reopens a cold session (R112)", async () => {
  const bed = createServiceBed(factories);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
  await bed.clock.advance(0);
  const frames = await bed.subscribe(sessionId);
  void bed.service.prompt({ sessionId, text: "again" }, OWNER);
  await bed.clock.advance(0);
  expect(frames.map((frame) => (frame.event as { kind: string; status?: string })).filter((e) => e.kind === "status").map((e) => e.status)).toEqual(["starting", "idle"]);
  bed.dispose();
});
```

`pi-files.test.ts`:

```ts
it("refuses a session file that is a link to somewhere outside the sessions directory", () => {
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, "");
  const link = join(agentDir, "sessions", "--w--", "evil.jsonl");
  symlinkSync(outside, link);
  expect(isPiSessionFile(agentDir, link)).toBe(false);
});

it("accepts a file under an agent directory reached through a link", () => {
  const linkedAgent = join(root, "agent-link");
  symlinkSync(agentDir, linkedAgent);
  expect(isPiSessionFile(linkedAgent, join(linkedAgent, "sessions", "--w--", "a.jsonl"))).toBe(true);
});
```

`dialogs.test.ts`:

```ts
it("cuts text to the limits the Dialog schema declares", () => {
  const dialogs = createDialogRegistry();
  const verdict = dialogs.offer(request("d", { title: "t".repeat(5000) }));
  expect(verdict.kind === "opened" && verdict.dialog.title.length).toBe(Dialog.shape.title.maxLength);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL (the five new cases).

- [ ] **Step 3: Implement**

`run-tracker.ts`:

```ts
  const confirm = async (rev: number, run: number, aborted: boolean): Promise<void> => {
    const stale = () => rev !== revision || run !== generation || !running;
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) await deps.clock.sleep(PROBE_INTERVAL_MS);
      if (stale()) return;
      const state = await deps.probe().catch(() => null);
      if (stale()) return;
      if (state && isIdle(state)) {
        endRun(aborted);
        return;
      }
    }
  };
```

called as `void confirm(revision, generation, event.aborted === true)`.

`live-run.ts`:

```ts
  let promptsInFlight = 0;
  let abortAtStart = false;
  let inputSinceRun = false;

  // inside the tracker's onRunStart callback, after the M1 lines:
      const origin = inputSinceRun ? "user" : "extension";
      inputSinceRun = false;
      deps.record("run_start", { origin });
      if (origin === "extension") deps.logger.info("run_started_by_extension");
      if (abortAtStart) {
        abortAtStart = false;
        queueMicrotask(() => {
          abortRunning().catch((error: unknown) => deps.logger.warn("abort_at_start_failed", { code: codeOf(error) }));
        });
      }

  // A fire-and-forget request to the worker: its failure is expected when the worker is going away, and is logged.
  const unanswered = (command: string) => (error: unknown) => deps.logger.debug("worker_request_failed", { command, code: codeOf(error) });

  async function abortRunning(): Promise<void> {
    const settled = tracker.waitIdle(ABORT_SETTLE_MS);
    deps.handle.request({ type: "abort" }, ABORT_SETTLE_MS).catch(unanswered("abort"));
    if (!(await settled)) await deps.handle.stop();
  }

  async function prompt(text: string, streamingBehavior?: "steer" | "followUp") {
    tracker.onInput();
    inputSinceRun = true;
    promptsInFlight++;
    let disposition: "started" | "queued" | "handled" | "rejected" = "rejected";
    try {
      const result = await promptOnce(text, streamingBehavior); // M1 body: request, rejected → throw, handled → closeStaleRun
      disposition = result.disposition;
      return result;
    } finally {
      promptsInFlight--;
      if (promptsInFlight === 0 && disposition !== "started") abortAtStart = false;
    }
  }

  async function abort(): Promise<void> {
    if (!tracker.running && promptsInFlight > 0) {
      // Pi has not started this prompt's run yet: an abort now would find it idle and be lost (R113).
      abortAtStart = true;
      deps.handle.request({ type: "abort" }, ABORT_SETTLE_MS).catch(unanswered("abort"));
      return;
    }
    // … the M1 body, its running branch now `await abortRunning()` …
  }
```

`codeOf(error)` is `error instanceof PapError ? error.code : "unknown"` (in `worker-text.ts`). Every `.catch(() => undefined)` M1 left in the moved code (`closeStaleRun`, the idle branch of `abort`) becomes `.catch(unanswered("get_state"))` / `.catch(unanswered("abort"))` in this task.

`service.ts` `launch()`: when `!isNew`, before `deps.spawn`, `deps.hub.publish("session", row.id, { kind: "status", status: "starting" })`.

`pi-files.ts`:

```ts
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The real path of a file, or of its folder and its name while it does not exist yet. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

export function isPiSessionFile(agentDir: string, path: string): boolean {
  if (!isAbsolute(path) || path.includes("\0") || !path.endsWith(".jsonl")) return false;
  const inside = relative(realOf(join(resolve(agentDir), "sessions")), realOf(resolve(path)));
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}
```

`dialogs.ts`:

```ts
import { z } from "zod";

const maxLengthOf = (schema: z.ZodType): number => {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  const max = (inner as z.ZodString).maxLength;
  if (typeof max !== "number") throw new Error("every Dialog text field needs a maximum length");
  return max;
};
// Read from the contract, so a limit changed there is the limit applied here.
const TEXT_LIMITS = {
  title: maxLengthOf(Dialog.shape.title),
  message: maxLengthOf(Dialog.shape.message),
  placeholder: maxLengthOf(Dialog.shape.placeholder),
  prefill: maxLengthOf(Dialog.shape.prefill),
} as const;
const MAX_OPTION_CHARS = maxLengthOf(Dialog.shape.options.unwrap().element);
```

`MAX_OPTIONS` stays 100 with a test that a 100-option select opens and a 101-option one is cancelled `too_large`, so a schema change shows up as a failing test. `zod` is already a dependency of the daemon.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/daemon/src/modules/sessions && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions
git commit -m "fix(sessions): abort before agent_start, run origin, starting on reopen, real session paths"
```

---
### Task 9: Live stream — 50 ms delta coalescing, the partial reply in the snapshot, tool output clipped on the wire

References: T3 Code `packages/provider-pi/src/server/adapter.ts` (`STREAM_FLUSH_MS = 50`, deltas accumulated per content item); Orca `rpc-messages.ts` (deltas coalesced per content index); pi-web `docs/agents/sessions.md` "Tool execution events" (`tool_execution_end` never carries the result, tool updates coalesced latest-wins and discarded before their end).

**Risks / rulings needed:** Preview sizes (tool output 8000 characters, progress tail 2000, arguments 8000, details 8 KiB) are proposals. The progress of calls made inside another tool (codemode) is not sent at all, as in pi-web.

**Files:**
- Create: `apps/daemon/src/modules/sessions/coalescer.ts`, `coalescer.test.ts`, `partial.ts`, `partial.test.ts`, `wire-clip.ts`, `wire-clip.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{live-session,live-run,service-reads}.ts`, `live-session.test.ts`, `service.snapshot.test.ts`
- Create: `apps/web/src/stores/partial-view.ts`; Modify: `apps/web/src/stores/{session-reducer,row-view}.ts`, `session-reducer.test.ts`, `apps/web/src/features/sessions/transcript.vm.ts`, `transcript.vm.test.ts`
- Modify: `apps/daemon/src/modules/sessions/sessions.int.test.ts` (one streaming case)

**Interfaces:**
- Consumes: Task 1 `PartialMessage`, Task 7 split.
- Produces:
  - `createCoalescer({ clock, emit, flushMs? }): { push(event: PiEvent): void; flush(): void; dispose(): void }`, `DELTA_FLUSH_MS = 50`.
  - `createPartialReply(): { apply(event): void; current(): PartialMessage | null; reset(): void }` — fed with published events only.
  - `clipPiEvent(event): PiEvent | null` (null = not sent: a nested tool's progress), `clipMessage(message)`, constants `TOOL_PREVIEW_CHARS = 8000`, `UPDATE_PREVIEW_CHARS = 2000`, `ARG_PREVIEW_CHARS = 8000`. A clipped tool result carries `papTruncated: { chars: <full text length> }`; a clipped tool call carries `papTruncated: true`; an image becomes `{ type: "image", mimeType, omitted: true, bytes }`.
  - `LiveSession.partial(): PartialMessage | null`. Every event the live session publishes sends the pending deltas first.
  - Web: `SessionView.partial: PartialMessage | null` (replaces `partialText`), `SessionView.tools: Record<toolCallId, { name; status: "running" | "done" | "failed"; preview }>`, `MessageView.truncatedChars: number | null`.

- [ ] **Step 1: Write the failing unit tests**

`coalescer.test.ts`:

```ts
import type { PiEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createCoalescer, MAX_PENDING_ITEMS } from "./coalescer.ts";

const delta = (text: string, contentIndex = 0, type = "text_delta"): PiEvent => ({ type: "message_update", assistantMessageEvent: { type, contentIndex, delta: text } });

function setup() {
  const clock = createFakeClock();
  const sent: PiEvent[] = [];
  return { clock, sent, coalescer: createCoalescer({ clock, emit: (event) => void sent.push(event) }) };
}

describe("delta coalescer", () => {
  it("merges the deltas of a block and sends them after 50 ms", async () => {
    const { clock, sent, coalescer } = setup();
    for (const text of ["He", "ll", "o"]) coalescer.push(delta(text));
    expect(sent).toEqual([]);
    await clock.advance(49);
    expect(sent).toEqual([]);
    await clock.advance(1);
    expect(sent).toEqual([delta("Hello")]);
  });

  it("keeps blocks apart and sends pending deltas before any other event", () => {
    const { sent, coalescer } = setup();
    coalescer.push(delta("thin", 0, "thinking_delta"));
    coalescer.push(delta("ans", 1));
    coalescer.push(delta("king", 0, "thinking_delta"));
    coalescer.push({ type: "message_end", message: { role: "assistant" } });
    expect(sent).toEqual([delta("thinking", 0, "thinking_delta"), delta("ans", 1), { type: "message_end", message: { role: "assistant" } }]);
  });

  it("keeps only a tool's latest progress, and drops it when the tool ends", async () => {
    const { clock, sent, coalescer } = setup();
    coalescer.push({ type: "tool_execution_update", toolCallId: "c1", partialResult: "1" });
    coalescer.push({ type: "tool_execution_update", toolCallId: "c1", partialResult: "2" });
    await clock.advance(50);
    expect(sent).toEqual([{ type: "tool_execution_update", toolCallId: "c1", partialResult: "2" }]);
    coalescer.push({ type: "tool_execution_update", toolCallId: "c1", partialResult: "3" });
    coalescer.push({ type: "tool_execution_end", toolCallId: "c1", isError: false });
    expect(sent.at(-1)).toEqual({ type: "tool_execution_end", toolCallId: "c1", isError: false });
    expect(sent).toHaveLength(2);
  });

  it("sends at once past 256 distinct pending tools", () => {
    const { sent, coalescer } = setup();
    for (let i = 0; i <= MAX_PENDING_ITEMS; i++) coalescer.push({ type: "tool_execution_update", toolCallId: `c${i}`, partialResult: "x" });
    expect(sent).toHaveLength(MAX_PENDING_ITEMS + 1);
  });

  it("sends at once past 256 KiB pending, and dispose leaves nothing armed", async () => {
    const { clock, sent, coalescer } = setup();
    coalescer.push(delta("x".repeat(256 * 1024 + 1)));
    expect(sent).toHaveLength(1);
    coalescer.push(delta("y"));
    coalescer.dispose();
    await clock.advance(100);
    expect(sent).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });
});
```

`partial.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPartialReply, MAX_PARTIAL_CHARS } from "./partial.ts";

const update = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });

describe("partial reply", () => {
  it("rebuilds the blocks of the reply being written", () => {
    const partial = createPartialReply();
    expect(partial.current()).toBeNull();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "thinking_start", contentIndex: 0 }));
    partial.apply(update({ type: "thinking_delta", contentIndex: 0, delta: "hmm" }));
    partial.apply(update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" }));
    partial.apply(update({ type: "toolcall_delta", contentIndex: 2, delta: '{"path"' }));
    expect(partial.current()).toEqual({
      blocks: [{ type: "thinking", text: "hmm" }, { type: "text", text: "" }, { type: "toolCall", text: '{"path"', id: "c1", name: "read" }],
    });
  });

  it("ends with the assistant's message_end and ignores other messages", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "user" } });
    expect(partial.current()).toBeNull();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply({ type: "message_end", message: { role: "toolResult" } });
    expect(partial.current()).toEqual({ blocks: [] });
    partial.apply({ type: "message_end", message: { role: "assistant" } });
    expect(partial.current()).toBeNull();
  });

  it("ignores a content index outside 0..63", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "text_delta", contentIndex: 64, delta: "x" }));
    expect(partial.current()).toEqual({ blocks: [] });
  });

  it("drops a reply past MAX_PARTIAL_CHARS until the next one starts", () => {
    const partial = createPartialReply();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "x".repeat(MAX_PARTIAL_CHARS) }));
    expect(partial.current()?.blocks[0]?.text).toHaveLength(MAX_PARTIAL_CHARS);
    partial.apply(update({ type: "text_delta", contentIndex: 0, delta: "y" }));
    expect(partial.current()).toBeNull();
    partial.apply({ type: "message_start", message: { role: "assistant" } });
    expect(partial.current()).toEqual({ blocks: [] });
  });
});
```

`wire-clip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ARG_PREVIEW_CHARS, clipArguments, clipMessage, clipPiEvent, MAX_ITEMS, TOOL_PREVIEW_CHARS, UPDATE_PREVIEW_CHARS } from "./wire-clip.ts";

describe("wire clipping", () => {
  it("cuts a tool result to a preview and says how long it was", () => {
    const message = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "a".repeat(TOOL_PREVIEW_CHARS) }, { type: "text", text: "b".repeat(10) }] };
    expect(clipMessage(message)).toEqual({ ...message, content: [{ type: "text", text: "a".repeat(TOOL_PREVIEW_CHARS) }], papTruncated: { chars: TOOL_PREVIEW_CHARS + 10 } });
  });

  it("replaces images by their size and drops large structured details", () => {
    const message = { role: "toolResult", toolCallId: "c1", content: [{ type: "image", data: "QUJD", mimeType: "image/png" }], details: { diff: "d".repeat(9000) } };
    expect(clipMessage(message)).toEqual({ role: "toolResult", toolCallId: "c1", content: [{ type: "image", mimeType: "image/png", omitted: true, bytes: 3 }], details: undefined, papTruncated: { chars: 0 } });
  });

  it("cuts long tool-call arguments and marks the call", () => {
    const message = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.txt", content: "z".repeat(ARG_PREVIEW_CHARS + 1) } }] };
    const clipped = clipMessage(message) as { content: Array<{ arguments: { content: string }; papTruncated?: boolean }> };
    expect(clipped.content[0]?.arguments.content).toHaveLength(ARG_PREVIEW_CHARS);
    expect(clipped.content[0]?.papTruncated).toBe(true);
    expect(clipMessage({ role: "assistant", content: [{ type: "text", text: "short" }] })).toEqual({ role: "assistant", content: [{ type: "text", text: "short" }] });
  });

  it("cuts arrays and objects wider than MAX_ITEMS", () => {
    const wide = clipArguments({ list: Array.from({ length: MAX_ITEMS + 5 }, (_, i) => i) });
    expect(wide.cut).toBe(true);
    expect((wide.value as { list: number[] }).list).toHaveLength(MAX_ITEMS);
  });

  it("sends a tool's end without its result, the tail of its progress, and nothing of nested progress", () => {
    expect(clipPiEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: true })).toEqual({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true });
    const update = clipPiEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: `${"x".repeat(5000)}END` }] } }) as { partialResult: { content: Array<{ text: string }> } };
    expect(update.partialResult.content[0]?.text).toHaveLength(UPDATE_PREVIEW_CHARS);
    expect(update.partialResult.content[0]?.text.endsWith("END")).toBe(true);
    expect(clipPiEvent({ type: "tool_execution_update", toolCallId: "c1/1", parentToolCallId: "c1", partialResult: {} })).toBeNull();
  });
});
```

In `live-session.test.ts` (fake clock via `createLiveBed`):

```ts
it("puts only published deltas in the snapshot's partial reply", async () => {
  const { live, worker, clock } = setup();
  worker.emit(piEvent({ type: "agent_start" }));
  worker.emit(piEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
  worker.emit(piEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }));
  worker.emit(piEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ab" } }));
  expect(live.partial()).toEqual({ blocks: [{ type: "text", text: "" }] });
  await clock.advance(50);
  expect(live.partial()).toEqual({ blocks: [{ type: "text", text: "ab" }] });
});

it("sends pending deltas before any other event it publishes", async () => {
  const { worker, published, clock } = setup();
  worker.emit(piEvent({ type: "message_start", message: { role: "assistant", content: [] } }));
  worker.emit(piEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before the question" } }));
  worker.emit(confirm);
  await clock.advance(0);
  const kinds = published.map((event) => (event.kind === "pi" ? (event.event.assistantMessageEvent as { delta?: string } | undefined)?.delta ?? event.event.type : event.kind));
  expect(kinds.indexOf("before the question")).toBeLessThan(kinds.indexOf("dialog_open"));
});
```

In `service.snapshot.test.ts`:

```ts
it("rebuilds the reply exactly from a snapshot taken between two flushes and the frames after it", async () => {
  const bed = createServiceBed(factories);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const text = (d: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: d } });
  bed.emit(0, { type: "agent_start" });
  bed.emit(0, { type: "message_start", message: { role: "assistant", content: [] } });
  bed.emit(0, text("a"));
  bed.emit(0, text("b"));
  await bed.clock.advance(50);
  bed.emit(0, text("c"));
  const frames = await bed.subscribe(sessionId);
  bed.emit(0, text("d"));
  await bed.clock.advance(50);
  const snapshot = frames[0]?.event as { partial: { blocks: Array<{ text: string }> } };
  const later = frames.slice(1).map((frame) => ((frame.event as { event?: { assistantMessageEvent?: { delta?: string } } }).event?.assistantMessageEvent?.delta ?? "")).join("");
  expect(snapshot.partial.blocks[0]?.text + later).toBe("abcd");
  bed.dispose();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement the three helpers**

`coalescer.ts`:

```ts
import type { PiEvent } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export const DELTA_FLUSH_MS = 50;
const MERGEABLE = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
/** Text pending past this goes out at once: one window of a fast model never holds megabytes. */
const MAX_PENDING_CHARS = 256 * 1024;
/** Distinct blocks and tools pending past this go out at once: a worker inventing tool ids cannot grow the map. */
export const MAX_PENDING_ITEMS = 256;

interface PendingDelta {
  readonly kind: "delta";
  readonly type: string;
  readonly contentIndex: number;
  delta: string;
  usage: unknown;
}
interface PendingTool {
  readonly kind: "tool";
  readonly event: PiEvent;
}

function deltaOf(event: PiEvent): { type: string; contentIndex: number; delta: string } | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent as { type?: unknown; contentIndex?: unknown; delta?: unknown } | undefined;
  if (!update || typeof update.type !== "string" || !MERGEABLE.has(update.type)) return null;
  if (typeof update.contentIndex !== "number" || typeof update.delta !== "string") return null;
  return { type: update.type, contentIndex: update.contentIndex, delta: update.delta };
}

export interface Coalescer {
  push(event: PiEvent): void;
  flush(): void;
  dispose(): void;
}

/**
 * Text, thinking and tool-call deltas are merged per content block and sent at most every 50 ms (spec C §4.3). A
 * tool's progress keeps only its latest update, and a pending one is dropped when the tool ends (or the tool would
 * read as running again). Any other event first sends what is pending, in arrival order: nothing overtakes text.
 */
export function createCoalescer(deps: { clock: Clock; emit(event: PiEvent): void; flushMs?: number }): Coalescer {
  const pending = new Map<string, PendingDelta | PendingTool>();
  let pendingChars = 0;
  let timer: TimerHandle | null = null;
  const flush = (): void => {
    if (timer) deps.clock.clearTimeout(timer);
    timer = null;
    const items = [...pending.values()];
    pending.clear();
    pendingChars = 0;
    for (const item of items) {
      deps.emit(
        item.kind === "tool"
          ? item.event
          : {
              type: "message_update",
              ...(item.usage === undefined ? {} : { usage: item.usage }),
              assistantMessageEvent: { type: item.type, contentIndex: item.contentIndex, delta: item.delta },
            },
      );
    }
  };
  const arm = (): void => {
    timer ??= deps.clock.setTimeout(flush, deps.flushMs ?? DELTA_FLUSH_MS);
  };
  return {
    push(event) {
      const delta = deltaOf(event);
      if (delta) {
        const key = `${delta.type}:${delta.contentIndex}`;
        const current = pending.get(key);
        if (current?.kind === "delta") {
          current.delta += delta.delta;
          current.usage = event.usage ?? current.usage;
        } else {
          pending.set(key, { kind: "delta", ...delta, usage: event.usage });
        }
        pendingChars += delta.delta.length;
        if (pendingChars > MAX_PENDING_CHARS || pending.size > MAX_PENDING_ITEMS) flush();
        else arm();
        return;
      }
      if (typeof event.toolCallId === "string" && (event.type === "tool_execution_update" || event.type === "tool_execution_end")) {
        pending.delete(`tool:${event.toolCallId}`);
        if (event.type === "tool_execution_update") {
          pending.set(`tool:${event.toolCallId}`, { kind: "tool", event });
          if (pending.size > MAX_PENDING_ITEMS) flush();
          else arm();
          return;
        }
      }
      flush();
      deps.emit(event);
    },
    flush,
    dispose() {
      if (timer) deps.clock.clearTimeout(timer);
      timer = null;
      pending.clear();
      pendingChars = 0;
    },
  };
}
```

`partial.ts`:

```ts
import type { PartialBlock, PartialMessage, PiEvent } from "@pap/contracts";

const STARTS: Readonly<Record<string, PartialBlock["type"]>> = { text_start: "text", thinking_start: "thinking", toolcall_start: "toolCall" };
const DELTAS: Readonly<Record<string, PartialBlock["type"]>> = { text_delta: "text", thinking_delta: "thinking", toolcall_delta: "toolCall" };
const MAX_BLOCKS = 64;
/** A reply longer than this is not kept: the snapshot would leave it out anyway (PARTIAL_BYTES), and `message_end` carries it. */
export const MAX_PARTIAL_CHARS = 256 * 1024;

export interface PartialReply {
  apply(event: PiEvent): void;
  current(): PartialMessage | null;
  reset(): void;
}

/**
 * The assistant reply being written, rebuilt from the events the stream has sent, never from deltas still pending:
 * a snapshot taken now plus the frames after it then give the reply exactly once (Review Focus 1).
 */
export function createPartialReply(): PartialReply {
  let blocks: PartialBlock[] | null = null;
  let chars = 0;
  const blockAt = (index: number, type: PartialBlock["type"]): PartialBlock | null => {
    if (!blocks || index < 0 || index >= MAX_BLOCKS || !Number.isInteger(index)) return null;
    const existing = blocks[index];
    if (existing) return existing;
    for (let i = blocks.length; i < index; i++) blocks[i] = { type: "text", text: "" };
    const created: PartialBlock = { type, text: "" };
    blocks[index] = created;
    return created;
  };
  return {
    apply(event) {
      const role = (event.message as { role?: unknown } | undefined)?.role;
      if (event.type === "message_start" && role === "assistant") {
        blocks = [];
        chars = 0;
      } else if (event.type === "message_end" && role === "assistant") blocks = null;
      else if (event.type === "agent_end" || event.type === "agent_settled") blocks = null;
      else if (event.type === "message_update") {
        const update = (event.assistantMessageEvent ?? {}) as { type?: string; contentIndex?: number; delta?: unknown; id?: unknown; toolName?: unknown };
        const index = update.contentIndex ?? -1;
        const started = update.type ? STARTS[update.type] : undefined;
        if (started) {
          const block = blockAt(index, started);
          if (block && typeof update.id === "string") block.id = update.id.slice(0, 256);
          if (block && typeof update.toolName === "string") block.name = update.toolName.slice(0, 256);
          return;
        }
        const grows = update.type ? DELTAS[update.type] : undefined;
        if (grows && typeof update.delta === "string") {
          chars += update.delta.length;
          // Past the cap the reply is dropped until the next one starts, never kept growing.
          if (chars > MAX_PARTIAL_CHARS) blocks = null;
          const block = blockAt(index, grows);
          if (block) block.text += update.delta;
        }
      }
    },
    current: () => (blocks ? { blocks: blocks.map((block) => ({ ...block })) } : null),
    reset() {
      blocks = null;
    },
  };
}
```

`wire-clip.ts`:

```ts
import type { PiEvent } from "@pap/contracts";

export const TOOL_PREVIEW_CHARS = 8000;
export const UPDATE_PREVIEW_CHARS = 2000;
export const ARG_PREVIEW_CHARS = 8000;
const DETAILS_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
export const MAX_ITEMS = 1000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

function omittedImage(block: Json): Json {
  const data = typeof block.data === "string" ? block.data : "";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { type: "image", mimeType: block.mimeType, omitted: true, bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding) };
}

/** Text blocks cut to `budget` characters in all; images replaced by their size. */
function clipContent(content: unknown, budget: number): { content: unknown; chars: number; cut: boolean } {
  if (typeof content === "string") return { content: content.slice(0, budget), chars: content.length, cut: content.length > budget };
  if (!Array.isArray(content)) return { content, chars: 0, cut: false };
  let left = budget;
  let chars = 0;
  let cut = false;
  const kept: unknown[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "image") {
      kept.push(omittedImage(block));
      cut = true;
    } else if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
      if (left === 0) cut = true;
      else if (block.text.length > left) {
        kept.push({ ...block, text: block.text.slice(0, left) });
        left = 0;
        cut = true;
      } else {
        kept.push(block);
        left -= block.text.length;
      }
    } else kept.push(block);
  }
  return { content: kept, chars, cut };
}

/** Strings over the preview size cut, at any depth up to 8; deeper values are left out. */
export function clipArguments(value: unknown, depth = 0): { value: unknown; cut: boolean } {
  if (typeof value === "string") return value.length > ARG_PREVIEW_CHARS ? { value: value.slice(0, ARG_PREVIEW_CHARS), cut: true } : { value, cut: false };
  if (typeof value !== "object" || value === null) return { value, cut: false };
  if (depth >= MAX_DEPTH) return { value: null, cut: true };
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  // Wide values are cut too: walking a million-item array per event would stall the daemon.
  let cut = entries.length > MAX_ITEMS;
  const walk = (item: unknown) => {
    const result = clipArguments(item, depth + 1);
    cut ||= result.cut;
    return result.value;
  };
  const kept = entries.slice(0, MAX_ITEMS);
  const next = Array.isArray(value) ? kept.map(([, item]) => walk(item)) : Object.fromEntries(kept.map(([key, item]) => [key, walk(item)]));
  return { value: cut ? next : value, cut };
}

export function clipMessage(message: unknown): unknown {
  if (!isObject(message)) return message;
  if (message.role === "toolResult") {
    const { content, chars, cut } = clipContent(message.content, TOOL_PREVIEW_CHARS);
    const bigDetails = message.details !== undefined && sizeOf(message.details) > DETAILS_BYTES;
    if (!cut && !bigDetails) return message;
    return { ...message, content, ...(bigDetails ? { details: undefined } : {}), papTruncated: { chars } };
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    let any = false;
    const content = message.content.map((block: unknown) => {
      if (!isObject(block) || block.type !== "toolCall") return block;
      const { value, cut } = clipArguments(block.arguments);
      if (!cut) return block;
      any = true;
      return { ...block, arguments: value, papTruncated: true };
    });
    return any ? { ...message, content } : message;
  }
  return message;
}

function tail(partialResult: unknown): unknown {
  const content = isObject(partialResult) ? partialResult.content : partialResult;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (isObject(block) && typeof block.text === "string" ? block.text : "")).join("") : "";
  return { content: [{ type: "text", text: text.slice(-UPDATE_PREVIEW_CHARS) }], ...(text.length > UPDATE_PREVIEW_CHARS ? { papTruncated: { chars: text.length } } : {}) };
}

/** What a client is sent for a Pi event. Null: not sent at all (the progress of a call made inside another tool). */
export function clipPiEvent(event: PiEvent): PiEvent | null {
  switch (event.type) {
    case "message_start":
    case "message_end":
      return event.message === undefined ? event : { ...event, message: clipMessage(event.message) };
    case "tool_execution_start": {
      const { value, cut } = clipArguments(event.args);
      return cut ? { ...event, args: value, papTruncated: true } : event;
    }
    case "tool_execution_update":
      if (typeof event.parentToolCallId === "string") return null;
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: tail(event.partialResult) };
    case "tool_execution_end": {
      const { result: _result, ...rest } = event;
      return rest;
    }
    default:
      return event;
  }
}
```

- [ ] **Step 4: Wire them into the live session**

`live-session.ts`:

```ts
  const partial = createPartialReply();
  // Every event this session publishes sends the pending deltas first, so text never arrives after what follows it.
  const publish = (event: SessionStreamEvent): void => {
    coalescer.flush();
    deps.publish(event);
  };
  const coalescer = createCoalescer({
    clock: deps.clock,
    emit: (event) => {
      partial.apply(event);
      publishMeasured(event); // M1's publishPi body: the 1 MB check, then deps.publish({ kind: "pi", event })
    },
  });
```

`setStatus`, `live-ui` and `live-run` receive `publish` (not `deps.publish`). The `pi_event` case:

```ts
      case "pi_event": {
        const event = record.event;
        if (isSystemMessage(event)) {
          run.onPiEvent(event);
        } else {
          const clipped = clipPiEvent(event);
          run.onPiEvent(clipped ?? event);
          if (clipped) coalescer.push(clipped);
        }
        deps.onActivity();
        return;
      }
```

`live-run.ts`'s `onPiEvent` pushes `event.message` of a `message_end` into the run view: it now receives the clipped message, so the run view and the stream hold the same rows. The exit handler starts with `coalescer.flush(); partial.reset();` and the returned object gains `partial: () => partial.current()`; `service-reads.ts` passes `partial: session?.partial() ?? null` to `fitSnapshot`.

- [ ] **Step 5: Update the web reducer**

`apps/web/src/stores/partial-view.ts` mirrors the daemon's rules for the client (`applyPartial(partial: PartialMessage | null, event): PartialMessage | null` with the same `STARTS`/`DELTAS`, 64-block bound, assistant `message_start` → `{ blocks: [] }`, assistant `message_end`, `agent_end`, `agent_settled` → `null`), as a pure function returning a new value. `session-reducer.ts`: `SessionView` replaces `partialText` with `partial: PartialMessage | null` and adds `tools`; the snapshot sets `partial: event.partial` and `tools: {}`; `reducePi` runs `applyPartial` on every event, and:

```ts
    case "tool_execution_start":
      return { ...view, tools: { ...view.tools, [String(event.toolCallId)]: { name: String(event.toolName ?? "tool"), status: "running", preview: "" } } };
    case "tool_execution_update": {
      const id = String(event.toolCallId);
      const current = view.tools[id];
      const text = ((event.partialResult as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text ?? "").join("");
      return current ? { ...view, tools: { ...view.tools, [id]: { ...current, preview: text } } } : view;
    }
    case "tool_execution_end": {
      const id = String(event.toolCallId);
      const current = view.tools[id];
      return current ? { ...view, tools: { ...view.tools, [id]: { ...current, status: event.isError === true ? "failed" : "done" } } } : view;
    }
```

`tools` keeps at most `MAX_TOOL_VIEWS = 200` entries: adding one past it drops the oldest finished one (the oldest of all when none has finished); a reducer test adds 201 and checks the first finished id is gone. Previews are cut to 2000 characters. A `status` event to `cold` sets `partial: null` (M1 did the same for `partialText`) and marks every `running` tool `failed`. `row-view.ts`'s `toMessageView` reads `truncatedChars: typeof message.papTruncated === "object" ? Number(message.papTruncated.chars) : null`. `transcript.vm.ts` builds its partial item from the text blocks of `view.partial` (thinking ignored here; Task 25 shows it).

- [ ] **Step 6: Write the integration test**

Add this case to `apps/daemon/src/modules/sessions/sessions.int.test.ts`, which already has `moduleWith(script)`, `ctx`, `events()` and `promptAndSettle(id, text)` (the shared int bed arrives in Task 10, which may move it there), and drop `sessions.stream.int.test.ts` from this task's file list:

```ts
it("streams a long reply in fewer frames than Pi's deltas, and the text comes out exactly", async () => {
  const reply = "word ".repeat(80);
  // tokenSize 4 (S2): Pi sends this reply as 100 deltas.
  writeFileSync(join(root, "long.json"), JSON.stringify({ steps: [{ text: reply }] }));
  await sessions.shutdownAll();
  sessions = moduleWith(join(root, "long.json"));
  const { sessionId } = await sessions.rpc["sessions.create"]({ cwd: work }, ctx);
  await sessions.rpc["subscribe.session"]({ sessionId }, ctx);
  await promptAndSettle(sessionId, "talk");
  const updates = frames
    .map((frame) => frame.event as { kind: string; event?: { type: string; assistantMessageEvent?: { type?: string; delta?: string } } })
    .filter((event) => event.kind === "pi" && event.event?.type === "message_update" && event.event.assistantMessageEvent?.type === "text_delta")
    .map((event) => event.event?.assistantMessageEvent as { delta: string });
  expect(updates.length).toBeLessThan(100);
  expect(updates.map((update) => update.delta).join("")).toBe(reply);
});
```

- [ ] **Step 7: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): coalesce deltas every 50 ms, partial reply in snapshots, clip tool output on the wire"
```

---

### Task 10: Transcript v2 — rows with Pi entry ids along the active branch, leaf tracking, `row` and `entry` events

The M1 snapshot showed Pi's model context (`buildSessionContext`): after a compaction the older messages disappeared. pi-web shows the whole active branch (`sliceActiveBranch` in `lib/session-reader.ts`), compactions as a summary card, and keeps entry ids for branching and paging. M2 does the same. The leaf of a hot session is the worker's (navigation moves it without writing anything, S1); the daemon reads Pi's file with that leaf instead of asking the worker for entries (`get_entries` returns every entry in one record, unbounded): ADR 0007.

**Risks / rulings needed:** ADR 0007 deviates from spec C §3.3 (`get_entries{since}`): the controller confirms before dispatch. Only the last 64 MiB of a huge session file are parsed (its oldest history is then not shown).

**Files:**
- Create: `apps/daemon/src/modules/sessions/branch.ts`, `branch.test.ts`, `entries-cache.ts`, `entries-cache.test.ts`, `testing/int-bed.ts`, `sessions.transcript.int.test.ts`, `docs/adr/0007-hot-session-reads-from-the-pi-file.md`
- Modify: `apps/daemon/src/modules/sessions/{transcript,live-session,live-run,run-view,service-reads}.ts`, `transcript.test.ts`, `run-view.test.ts`, `live-session.test.ts`, `service.snapshot.test.ts`
- Modify: `apps/web/src/stores/{session-reducer,row-view}.ts`, `session-reducer.test.ts`, `apps/web/src/features/sessions/transcript.vm.ts`

**Interfaces:**
- Consumes: Task 1 `TranscriptRow`, `EntryRef`, `HistoryMeta`; Task 2 slim `entry_appended`; Task 9 `clipMessage`.
- Produces:
  - `branch.ts`: `EntryLike`, `IndexedEntries { list; byId; children; order }`, `indexEntries(list)`, `displayMessages(entry, convert)`, `readBranchPage(entries, convert, { leafId?, before?, limit }): BranchPage { rows; hasMore; oldestEntryId; turnsBefore; leafId }`, `forkPoints(entries, convert, leafId?, maxPoints = 100, maxChoices = 16): ForkPoint[]`, `findToolCall(entries, toolCallId): { result: unknown | null; args: unknown | null }`, `MIN_RAW_WINDOW = 200`.
  - `entries-cache.ts`: `createEntriesCache(sdk, max = 4): { read(path, upToBytes?): IndexedEntries }` (parse once per size and mtime, a trailing line without newline left out).
  - `TranscriptReader` v2: `page(file, { leafId?, before?, limit?, upToBytes? }): BranchPage`, `forks(file, leafId?)`, `toolCall(file, toolCallId)`, `lastEntryId(file)`; rows are clipped with `clipMessage`.
  - `LiveSession.leafId(): string | null` (from `ready`, each appended entry, and — Task 17 — navigation); `RunViewState` gains `leafAtStart: string | null` and holds `rows: TranscriptRow[]` (entry ids bound as `entry_appended` arrives).
  - Stream: `{kind: "entry", entry}` for every appended entry (never forwarded as a raw Pi event); `{kind: "row", row}` for a compaction or branch summary.
  - Snapshot: rows with entry ids, `history`, `leafId`.
  - `int-bed.ts`: `createIntBed(script, options?)` (see Step 5) used by every later integration test of the module.
  - Web: `MessageView.entryId` bound from `entry` events; roles `compactionSummary`, `branchSummary`, `custom` (hidden when `display === false`); `SessionView.history: HistoryMeta`, `SessionView.leafId`.

- [ ] **Step 1: Write the failing tests for the pure parts**

`branch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type EntryLike, findToolCall, forkPoints, indexEntries, readBranchPage } from "./branch.ts";

const msg = (id: string, parentId: string | null, role: string, text: string, extra: Record<string, unknown> = {}): EntryLike => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-10-11T00:00:${id.length}`,
  message: { role, content: text, timestamp: 1, ...extra },
});
// What the SDK's sessionEntryToContextMessages does for the entry types used here.
const convert = (entry: EntryLike): unknown[] =>
  entry.type === "message" ? [entry.message] : entry.type === "compaction" ? [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore }] : [];

const linear = (pairs: number) => {
  const list: EntryLike[] = [msg("sys", null, "system", "prompt")];
  let parent = "sys";
  for (let i = 0; i < pairs; i++) {
    list.push(msg(`u${i}`, parent, "user", `q${i}`), msg(`a${i}`, `u${i}`, "assistant", `r${i}`));
    parent = `a${i}`;
  }
  return indexEntries(list);
};
const ids = (rows: Array<{ entryId: string | null }>) => rows.map((row) => row.entryId);

describe("branch rows", () => {
  it("shows the active branch without the system prompt, newest last, with entry ids", () => {
    const page = readBranchPage(linear(2), convert, { limit: 75 });
    expect(ids(page.rows)).toEqual(["u0", "a0", "u1", "a1"]);
    expect(page).toMatchObject({ hasMore: false, turnsBefore: 0, leafId: "a1" });
  });

  it("pages older rows from just above a cursor and counts the turns above", () => {
    const entries = linear(10);
    const newest = readBranchPage(entries, convert, { limit: 4 });
    expect(ids(newest.rows)).toEqual(["u8", "a8", "u9", "a9"]);
    expect(newest).toMatchObject({ hasMore: true, oldestEntryId: "u8", turnsBefore: 8 });
    const older = readBranchPage(entries, convert, { before: "u8", limit: 4 });
    expect(ids(older.rows)).toEqual(["u6", "a6", "u7", "a7"]);
    expect(older.turnsBefore).toBe(6);
  });

  it("follows the leaf it is given, not the file's last entry", () => {
    const entries = indexEntries([...linear(1).list, msg("u1", "a0", "user", "edited"), msg("a1", "u1", "assistant", "two"), msg("u2", "a0", "user", "other branch")]);
    expect(ids(readBranchPage(entries, convert, { leafId: "a1", limit: 75 }).rows)).toEqual(["u0", "a0", "u1", "a1"]);
    expect(ids(readBranchPage(entries, convert, { limit: 75 }).rows)).toEqual(["u0", "a0", "u2"]);
  });

  it("shows a compaction as a summary row and keeps the history before it", () => {
    const list = [...linear(2).list, { type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "earlier work", tokensBefore: 900 } as EntryLike];
    const page = readBranchPage(indexEntries(list), convert, { limit: 75 });
    expect(ids(page.rows)).toEqual(["u0", "a0", "u1", "a1", "c1"]);
    expect(page.rows.at(-1)?.message).toEqual({ role: "compactionSummary", summary: "earlier work", tokensBefore: 900 });
  });

  it("lists fork points with each choice's newest leaf", () => {
    const list = [...linear(1).list, msg("u1", "a0", "user", "first try"), msg("a1", "u1", "assistant", "x"), msg("u2", "a0", "user", "second try"), msg("a2", "u2", "assistant", "y")];
    expect(forkPoints(indexEntries(list), convert, "a2")).toEqual([
      {
        parentId: "a0",
        choices: [
          { entryId: "u1", preview: "first try", target: "a1", timestamp: expect.any(String), onPath: false },
          { entryId: "u2", preview: "second try", target: "a2", timestamp: expect.any(String), onPath: true },
        ],
      },
    ]);
  });

  it("finds a tool call's arguments and its result", () => {
    const list = [
      msg("u0", null, "user", "go"),
      { type: "message", id: "a0", parentId: "u0", timestamp: "t", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big.txt" } }] } } as EntryLike,
      msg("t0", "a0", "toolResult", "full output", { toolCallId: "c1" }),
    ];
    expect(findToolCall(indexEntries(list), "c1")).toEqual({ args: { path: "big.txt" }, result: expect.objectContaining({ role: "toolResult", content: "full output" }) });
    expect(findToolCall(indexEntries(list), "nope")).toEqual({ args: null, result: null });
  });
});
```

`entries-cache.test.ts`:

```ts
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntriesCache } from "./entries-cache.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pap-entries-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/w" });
const entry = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId, timestamp: "t", message: { role: "user", content: id, timestamp: 1 } });
const sdk = { migrateSessionEntries: () => {} };

describe("entries cache", () => {
  it("leaves out a line Pi has not finished writing, and reads only up to a size", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header}\n${entry("e1", null)}\n${entry("e2", "e1")}\n{"type":"mess`);
    const cache = createEntriesCache(sdk);
    expect(cache.read(file).list.map((e) => e.id)).toEqual(["e1", "e2"]);
    const firstTwoLines = Buffer.byteLength(`${header}\n${entry("e1", null)}\n`);
    expect(cache.read(file, firstTwoLines).list.map((e) => e.id)).toEqual(["e1"]);
  });

  it("parses again when the file grew, and gives nothing for a missing file", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header}\n${entry("e1", null)}\n`);
    const cache = createEntriesCache(sdk);
    expect(cache.read(file).list).toHaveLength(1);
    appendFileSync(file, `${entry("e2", "e1")}\n`);
    expect(cache.read(file).list).toHaveLength(2);
    expect(cache.read(join(dir, "missing.jsonl")).list).toEqual([]);
  });

  it("skips lines that are not JSON", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header}\nnot json\n${entry("e1", null)}\n`);
    expect(createEntriesCache(sdk).read(file).list.map((e) => e.id)).toEqual(["e1"]);
  });

  it("reads only the tail of a file over maxBytes, and says so", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header}\n${entry("e1", null)}\n${entry("e2", "e1")}\n${entry("e3", "e2")}\n`);
    const issues: Array<[string, number]> = [];
    const cache = createEntriesCache(sdk, { maxBytes: Buffer.byteLength(`${entry("e3", "e2")}\n`) + 5, onIssue: (issue, size) => void issues.push([issue, size]) });
    expect(cache.read(file).list.map((e) => e.id)).toEqual(["e3"]);
    expect(issues).toEqual([["tail_only", statSync(file).size]]);
  });

  it("keeps at most `max` files", () => {
    const files = ["a", "b", "c"].map((name) => {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, `${header}\n${entry(name, null)}\n`);
      return file;
    });
    let parses = 0;
    const cache = createEntriesCache({ migrateSessionEntries: () => void parses++ }, { max: 2 });
    for (const file of [...files, files[0] ?? ""]) cache.read(file);
    expect(parses).toBe(4);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/branch.test.ts apps/daemon/src/modules/sessions/entries-cache.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `branch.ts` and `entries-cache.ts`**

`branch.ts`:

```ts
import type { TranscriptRow } from "@pap/contracts";

export interface EntryLike {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly [field: string]: unknown;
}
export type Convert = (entry: EntryLike) => unknown[];
export interface IndexedEntries {
  readonly list: readonly EntryLike[];
  readonly byId: ReadonlyMap<string, EntryLike>;
  readonly children: ReadonlyMap<string | null, readonly EntryLike[]>;
  /** Append order: the newest entry under a fork is the one with the highest number. */
  readonly order: ReadonlyMap<string, number>;
}
export interface BranchPage {
  readonly rows: TranscriptRow[];
  readonly hasMore: boolean;
  readonly oldestEntryId: string | null;
  readonly turnsBefore: number;
  readonly leafId: string | null;
}
export interface ForkChoice {
  readonly entryId: string;
  readonly preview: string;
  readonly target: string;
  readonly timestamp: string | null;
  readonly onPath: boolean;
}
export interface ForkPoint {
  readonly parentId: string | null;
  readonly choices: ForkChoice[];
}

/** A page never walks more raw entries than this (or 6 per row asked for): tool traffic cannot balloon one page. */
export const MIN_RAW_WINDOW = 200;
const PREVIEW_CHARS = 120;

export function indexEntries(list: readonly EntryLike[]): IndexedEntries {
  const byId = new Map<string, EntryLike>();
  const children = new Map<string | null, EntryLike[]>();
  const order = new Map<string, number>();
  list.forEach((entry, index) => {
    byId.set(entry.id, entry);
    order.set(entry.id, index);
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  });
  return { list, byId, children, order };
}

const roleOf = (message: unknown): unknown => (message as { role?: unknown } | null)?.role;

/** What a client shows of one entry: never Pi's system prompt, never a custom message hidden from display. */
export function displayMessages(entry: EntryLike, convert: Convert): unknown[] {
  if (entry.type === "message" && roleOf(entry.message) === "system") return [];
  if (entry.type === "custom_message" && entry.display === false) return [];
  try {
    return convert(entry).filter((message) => roleOf(message) !== "system");
  } catch {
    return [];
  }
}

// The rows a turn starts with: what the minimap numbers (pi-web `isMessageGroupAnchor`).
const isAnchor = (message: unknown): boolean => {
  const role = roleOf(message);
  return role === "user" || role === "compactionSummary" || role === "branchSummary" || role === "custom";
};

const leafOf = (entries: IndexedEntries, leafId: string | null | undefined): EntryLike | undefined =>
  (leafId ? entries.byId.get(leafId) : undefined) ?? entries.list.at(-1);

export function readBranchPage(
  entries: IndexedEntries,
  convert: Convert,
  options: { leafId?: string | null | undefined; before?: string | undefined; limit: number },
): BranchPage {
  const leaf = leafOf(entries, options.leafId);
  const cursor = options.before === undefined ? undefined : entries.byId.get(options.before);
  let current = options.before === undefined ? leaf : cursor?.parentId ? entries.byId.get(cursor.parentId) : undefined;
  const chain: EntryLike[] = [];
  let visible = 0;
  const rawCap = Math.max(MIN_RAW_WINDOW, options.limit * 6);
  while (current && visible < options.limit && chain.length < rawCap) {
    chain.push(current);
    visible += displayMessages(current, convert).length;
    current = current.parentId ? entries.byId.get(current.parentId) : undefined;
  }
  // Iterative walk: a linear session's chain is as long as the session.
  let turnsBefore = 0;
  let hasMore = false;
  for (let above = current; above; above = above.parentId ? entries.byId.get(above.parentId) : undefined) {
    const shown = displayMessages(above, convert);
    if (shown.length > 0) hasMore = true;
    turnsBefore += shown.filter(isAnchor).length;
  }
  const rows = chain.toReversed().flatMap((entry) => displayMessages(entry, convert).map((message) => ({ entryId: entry.id, message })));
  return { rows, hasMore, oldestEntryId: chain.at(-1)?.id ?? null, turnsBefore, leafId: leaf?.id ?? null };
}

function newestUnder(entries: IndexedEntries, root: EntryLike): EntryLike {
  let newest = root;
  for (const stack = [root]; stack.length > 0; ) {
    const entry = stack.pop() as EntryLike;
    if ((entries.order.get(entry.id) ?? -1) > (entries.order.get(newest.id) ?? -1)) newest = entry;
    stack.push(...(entries.children.get(entry.id) ?? []));
  }
  return newest;
}

function previewOf(entry: EntryLike, convert: Convert): string {
  const message = displayMessages(entry, convert)[0] as { content?: unknown; summary?: unknown } | undefined;
  const content = message?.content ?? message?.summary;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (block as { text?: unknown }).text).filter((part) => typeof part === "string").join(" ") : "";
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

/** Where the active branch forks, and for each choice the leaf a switch to it goes to: its newest entry. */
export function forkPoints(entries: IndexedEntries, convert: Convert, leafId?: string | null, maxPoints = 100, maxChoices = 16): ForkPoint[] {
  const path: EntryLike[] = [];
  for (let entry = leafOf(entries, leafId); entry; entry = entry.parentId ? entries.byId.get(entry.parentId) : undefined) path.push(entry);
  const onPath = new Set(path.map((entry) => entry.id));
  const points: ForkPoint[] = [];
  for (const parentId of [null, ...path.toReversed().map((entry) => entry.id)]) {
    const kids = entries.children.get(parentId) ?? [];
    if (kids.length < 2) continue;
    points.push({
      parentId,
      choices: kids.slice(0, maxChoices).map((kid) => ({
        entryId: kid.id,
        preview: previewOf(kid, convert),
        target: newestUnder(entries, kid).id,
        timestamp: typeof kid.timestamp === "string" ? kid.timestamp : null,
        onPath: onPath.has(kid.id),
      })),
    });
    if (points.length >= maxPoints) break;
  }
  return points;
}

/** A tool call's arguments and result, wherever they are in the file (newest first). */
export function findToolCall(entries: IndexedEntries, toolCallId: string): { result: unknown | null; args: unknown | null } {
  let result: unknown | null = null;
  let args: unknown | null = null;
  for (let i = entries.list.length - 1; i >= 0 && (result === null || args === null); i--) {
    const message = (entries.list[i]?.message ?? null) as { role?: unknown; toolCallId?: unknown; content?: unknown } | null;
    if (!message) continue;
    if (result === null && message.role === "toolResult" && message.toolCallId === toolCallId) result = message;
    if (args === null && message.role === "assistant" && Array.isArray(message.content)) {
      const call = message.content.find((block) => (block as { type?: unknown; id?: unknown }).type === "toolCall" && (block as { id?: unknown }).id === toolCallId) as { arguments?: unknown } | undefined;
      if (call) args = call.arguments ?? null;
    }
  }
  return { result, args };
}
```

`entries-cache.ts`:

```ts
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { type EntryLike, type IndexedEntries, indexEntries } from "./branch.ts";

interface Parsed {
  readonly size: number;
  readonly mtimeMs: number;
  readonly entries: readonly EntryLike[];
  /** Byte offset just past each entry's line, in the same order. */
  readonly ends: readonly number[];
}

export interface EntriesCache {
  read(path: string, upToBytes?: number): IndexedEntries;
}

const EMPTY = indexEntries([]);

function parse(buffer: Buffer, sdk: { migrateSessionEntries(entries: never[]): void }): { entries: EntryLike[]; ends: number[] } {
  const all: Array<Record<string, unknown>> = [];
  const lineEnds: number[] = [];
  let start = 0;
  for (let at = buffer.indexOf(0x0a); at !== -1; at = buffer.indexOf(0x0a, start)) {
    const line = buffer.toString("utf8", start, at).trim();
    start = at + 1;
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
        all.push(value as Record<string, unknown>);
        lineEnds.push(start);
      }
    } catch {
      // A line that is not JSON is skipped, as Pi's own reader does.
    }
  }
  sdk.migrateSessionEntries(all as never[]);
  const entries: EntryLike[] = [];
  const ends: number[] = [];
  all.forEach((entry, index) => {
    if (entry.type === "session" || typeof entry.id !== "string") return;
    entries.push(entry as unknown as EntryLike);
    ends.push(lineEnds[index] ?? 0);
  });
  return { entries, ends };
}

/**
 * Reads a Pi file once per size and mtime and keeps the last `max` files: a snapshot, a history page and a tool-output
 * fetch of the same session parse it once. Bytes after the last newline are a line Pi is still writing and are left
 * out (R38). `upToBytes` keeps the entries whose line ends within it: a snapshot taken during a run reads the file as
 * it was when the run began. A file over `maxBytes` is read from its last `maxBytes` only (from the first whole line):
 * the branch walk then stops where the parents are missing, so the oldest history of a huge session is not shown, and
 * `onIssue("tail_only", size)` says so. A file that exists but cannot be read gives `onIssue("read_failed", size)`.
 */
export const MAX_PARSE_BYTES = 64 * 1024 * 1024;

export function createEntriesCache(
  sdk: { migrateSessionEntries(entries: never[]): void },
  options: { max?: number; maxBytes?: number; onIssue?(issue: "tail_only" | "read_failed", size: number): void } = {},
): EntriesCache {
  const max = options.max ?? 4;
  const maxBytes = options.maxBytes ?? MAX_PARSE_BYTES;
  const files = new Map<string, Parsed>();
  const load = (path: string): Parsed | null => {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(path);
    } catch {
      // A draft has no file yet (S1): nothing to read, nothing to report.
      files.delete(path);
      return null;
    }
    const cached = files.get(path);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      files.delete(path);
      files.set(path, cached);
      return cached;
    }
    let buffer: Buffer;
    let base = 0;
    try {
      if (stat.size <= maxBytes) buffer = readFileSync(path);
      else {
        const start = stat.size - maxBytes;
        const fd = openSync(path, "r");
        try {
          buffer = Buffer.alloc(maxBytes);
          readSync(fd, buffer, 0, maxBytes, start);
        } finally {
          closeSync(fd);
        }
        const firstNewline = buffer.indexOf(0x0a);
        base = start + firstNewline + 1;
        buffer = buffer.subarray(firstNewline + 1);
        options.onIssue?.("tail_only", stat.size);
      }
    } catch {
      options.onIssue?.("read_failed", stat.size);
      return null;
    }
    const read = parse(buffer, sdk);
    const parsed: Parsed = { size: stat.size, mtimeMs: stat.mtimeMs, entries: read.entries, ends: read.ends.map((end) => base + end) };
    files.delete(path);
    files.set(path, parsed);
    while (files.size > max) files.delete(files.keys().next().value as string);
    return parsed;
  };
  return {
    read(path, upToBytes) {
      const parsed = load(path);
      if (!parsed) return EMPTY;
      if (upToBytes === undefined) return indexEntries(parsed.entries);
      return indexEntries(parsed.entries.filter((_entry, index) => (parsed.ends[index] ?? Infinity) <= upToBytes));
    },
  };
}
```

`transcript.ts` keeps `loadTranscriptReader()` (lazy, R108) and builds the v2 reader:

```ts
type Sdk = Pick<typeof import("@earendil-works/pi-coding-agent"), "migrateSessionEntries" | "sessionEntryToContextMessages">;

export interface TranscriptReader {
  page(filePath: string, options?: { leafId?: string | null; before?: string; limit?: number; upToBytes?: number }): BranchPage;
  forks(filePath: string, leafId?: string | null): ForkPoint[];
  toolCall(filePath: string, toolCallId: string): { result: unknown | null; args: unknown | null };
  lastEntryId(filePath: string): string | null;
}

function createTranscriptReader(sdk: Sdk, logger: Logger): TranscriptReader {
  // No path in the log line: the size and the kind of issue are enough to act on.
  const cache = createEntriesCache(sdk as never, { onIssue: (issue, size) => logger.warn("session_file_issue", { issue, size }) });
  const convert: Convert = (entry) => sdk.sessionEntryToContextMessages(entry as never);
  return {
    page(filePath, options = {}) {
      const page = readBranchPage(cache.read(filePath, options.upToBytes), convert, { leafId: options.leafId, before: options.before, limit: options.limit ?? SNAPSHOT_ROWS });
      return { ...page, rows: page.rows.map((row) => ({ entryId: row.entryId, message: clipMessage(row.message) })) };
    },
    forks: (filePath, leafId) => forkPoints(cache.read(filePath), convert, leafId),
    toolCall: (filePath, toolCallId) => findToolCall(cache.read(filePath), toolCallId),
    lastEntryId: (filePath) => cache.read(filePath).list.at(-1)?.id ?? null,
  };
}
```

`loadTranscriptReader(logger)` takes the module's logger (the sessions service passes it), memoized as before. `transcript.test.ts` moves to `reader.page(file).rows.map((row) => row.message.role)`; a missing file gives an empty page with no log line, an unreadable one an empty page and one `session_file_issue {issue: "read_failed"}` line (test with a captured logger and a 0o000 file); `transcript.lazy.test.ts` is unchanged (still proves the SDK is imported lazily).

- [ ] **Step 4: Track the leaf and bind entry ids in the live session**

`run-view.ts`: `RunViewState { baselineBytes; leafAtStart: string | null; rows: TranscriptRow[] }`; `begin(baselineBytes, leafAtStart)`; `push(message)` stores `{ entryId: null, message }` (bounded as before); new `bind(entry: EntryRef): void` gives `entry.id` to the newest unbound row whose message matches (`toolCallId` equal for a tool result, else same `role` and `timestamp === entry.messageTimestamp`); new `add(row: TranscriptRow)` for summary rows.

`live-session.ts`:

```ts
  let leafId: string | null = null;      // from ready
  // in the ready handler: leafId = record.leafId;

  function onEntry(raw: unknown): void {
    const entry = slimEntryRef(raw); // validates with EntryRef, null when malformed
    if (!entry) return;
    leafId = entry.id;
    run.bindEntry(entry);
    publish({ kind: "entry", entry });
    const summary = summaryRow(raw); // compaction → { role: "compactionSummary", summary, tokensBefore, timestamp }, branch_summary → { role: "branchSummary", summary, fromId, timestamp }
    if (summary) {
      run.addRow(summary);
      publish({ kind: "row", row: summary });
    }
  }
```

called from the `pi_event` case when `event.type === "entry_appended"` (that event is not pushed to the coalescer: clients get `entry` instead). The summary message shapes match what `sessionEntryToContextMessages` gives for the same entry (check `createCompactionSummaryMessage` / `createBranchSummaryMessage` in `dist/core/messages.d.ts` and use the same field names and timestamp type), so a row read from the file and a row seen live compare equal in the client. `live-run.ts`'s run start passes `leafId` as `leafAtStart`. The returned object gains `leafId: () => leafId`.

`service-reads.ts` `snapshot()`:

```ts
    const run = session?.runView() ?? null;
    const file = …; // as M1
    const page = file ? reader.page(file, { leafId: run ? run.leafAtStart : session?.leafId(), upToBytes: run?.baselineBytes, limit: SNAPSHOT_ROWS }) : EMPTY_PAGE;
    const rows = [...page.rows, ...(run?.rows ?? [])];
    const snapshot = fitSnapshot({ status: statusOf(sessionId), rows, dialogs: session?.dialogs() ?? [], partial: session?.partial() ?? null, history: page, leafId: session?.leafId() ?? page.leafId });
    return withTrimmedHistory(snapshot, rows, page);
```

with, in `snapshot.ts`:

```ts
/**
 * When the snapshot had to leave out older rows (the 75-row cap or the byte budget), the client's next page must start
 * just above the oldest row it got, and the turns above count what was left out.
 */
export function withTrimmedHistory(snapshot: SnapshotEvent, offered: readonly TranscriptRow[], page: HistoryMeta): SnapshotEvent {
  const dropped = offered.length - snapshot.rows.length;
  if (dropped <= 0) return { ...snapshot, history: { hasMore: page.hasMore, oldestEntryId: page.oldestEntryId, turnsBefore: page.turnsBefore } };
  const anchors = offered.slice(0, dropped).filter((row) => ["user", "compactionSummary", "branchSummary", "custom"].includes(String((row.message as { role?: unknown }).role))).length;
  const oldest = snapshot.rows.find((row) => row.entryId !== null)?.entryId ?? page.oldestEntryId;
  return { ...snapshot, history: { hasMore: true, oldestEntryId: oldest, turnsBefore: page.turnsBefore + anchors } };
}
```

Tests in `live-session.test.ts`: an `entry_appended` after a `message_end` publishes `{kind: "entry"}` with the id and moves `leafId()`; a compaction entry publishes `{kind: "row"}` with the summary; no raw `entry_appended` reaches `published`. In `service.snapshot.test.ts`: during a run, the snapshot reads the file up to the run's baseline from `leafAtStart`, then the run's rows with the ids bound so far; a trimmed snapshot points `history.oldestEntryId` at its oldest kept row.

- [ ] **Step 5: Write the shared integration bed and the integration test**

`apps/daemon/src/modules/sessions/testing/int-bed.ts` (a helper may import the module only through `../index.ts`):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PERMISSIONS, type EventFrame, type HandlerContext, type SessionStreamEvent } from "@pap/contracts";
import { vi } from "vitest";
import { createSystemClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { NO_SCOPES } from "../../../kernel/supervisor/scope.ts";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS, type SessionsModule } from "../index.ts";

const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));
const EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning", "--import", join(REPO, "packages/pi-host/src/testing/network-guard.ts")];

export interface IntBedOptions {
  /** `<name>.js` sources written into `<agentDir>/extensions/` (Pi loads them without project trust). */
  readonly extensions?: Readonly<Record<string, string>>;
  /** Written to `<agentDir>/settings.json`. */
  readonly settings?: object;
  readonly maxWorkers?: number;
  readonly workerIdleMs?: number;
}

export interface Subscription {
  events(): SessionStreamEvent[];
  waitFor(predicate: (event: SessionStreamEvent) => boolean, timeoutMs?: number): Promise<SessionStreamEvent>;
}

/** The sessions module with the real pi-host on a scripted model, every path under a temporary root (R94). */
export async function createIntBed(script: object, options: IntBedOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "pap-int-sessions-"));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  const papHome = join(root, "pap");
  for (const dir of [agentDir, work, papHome, join(root, "home"), join(agentDir, "extensions")]) mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(options.extensions ?? {})) writeFileSync(join(agentDir, "extensions", `${name}.js`), source);
  if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
  writeFileSync(join(root, "script.json"), JSON.stringify(script));
  const clock = createSystemClock();
  const db = migrate({ dbPath: join(root, "state.db"), backupsDir: join(root, "backups"), sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS], clock, logger: silentLogger }).db;
  const hub = createStreamHub(undefined, clock);
  const exits: string[] = [];
  const sessions: SessionsModule = createSessionsModule({
    db,
    clock,
    logger: silentLogger,
    hub,
    config: { home: papHome, piAgentDir: agentDir, piHostEntry: join(REPO, "packages/pi-host/src/main.ts"), piHostExecArgv: EXEC_ARGV, testProviderScript: join(root, "script.json"), maxWorkers: options.maxWorkers ?? 4, minFreeMemMb: 0, workerIdleMs: options.workerIdleMs ?? 30 * 60_000 },
    workerUmask: 0o022,
    env: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
    scopes: NO_SCOPES,
    onWorkerExit: (_sessionId, info) => void exits.push(info.outputTail),
  });
  let subs = 0;
  const ctx = (connectionId: string, sink: EventFrame[]): HandlerContext => ({
    caller: { userId: "u1", permissions: new Set(ALL_PERMISSIONS) },
    connectionId,
    openSubscription: (stream, key, after) => {
      const sub = `s${++subs}`;
      hub.open({ connectionId, sub, stream, key, after, send: (frame) => void sink.push(frame) });
      return sub;
    },
    closeSubscription: (sub) => hub.close(connectionId, sub),
  });
  const owner = ctx("bed", []);
  return {
    root,
    agentDir,
    work,
    papHome,
    sessions,
    rpc: sessions.rpc,
    ctx: owner,
    async subscribe(sessionId: string): Promise<Subscription> {
      const frames: EventFrame[] = [];
      await sessions.rpc["subscribe.session"]({ sessionId }, ctx(`c${subs + 1}`, frames));
      const events = () => frames.map((frame) => frame.event as SessionStreamEvent);
      return {
        events,
        async waitFor(predicate, timeoutMs = 20_000) {
          let found: SessionStreamEvent | undefined;
          await vi.waitFor(() => {
            found = events().find(predicate);
            if (!found) throw new Error("not yet");
          }, { timeout: timeoutMs });
          return found as SessionStreamEvent;
        },
      };
    },
    /** SIGKILLs a session's worker; a pid of 0 or 1 would signal our own group or every process, so it is refused. */
    killWorker(sessionId: string): number {
      const pid = sessions.inspect(sessionId)?.pid;
      if (pid === undefined || !Number.isInteger(pid) || pid <= 1) throw new Error(`no worker pid for ${sessionId}`);
      process.kill(pid, "SIGKILL");
      return pid;
    },
    async dispose(): Promise<void> {
      try {
        await sessions.shutdownAll();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
      const blocked = exits.flatMap((tail) => tail.split("\n")).filter((line) => line.startsWith("pap-network-guard: blocked"));
      if (blocked.length > 0) throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
    },
  };
}
export type IntBed = Awaited<ReturnType<typeof createIntBed>>;

/** Prompts and waits for the run to settle (status `idle` after `running`). */
export async function promptAndSettle(bed: IntBed, sub: Subscription, sessionId: string, text: string): Promise<void> {
  const before = sub.events().length;
  await bed.rpc["sessions.prompt"]({ sessionId, text }, bed.ctx);
  await vi.waitFor(() => {
    const statuses = sub.events().slice(before).flatMap((event) => (event.kind === "status" ? [event.status] : []));
    if (statuses.lastIndexOf("idle") <= statuses.indexOf("running")) throw new Error("still running");
  }, { timeout: 20_000 });
}
```

(`config.workerIdleMs` is consumed from Task 20; until then `createSessionsModule` ignores it — its `Pick<Config, …>` gains the field in Task 20, and this bed passes it from the start.)

`sessions.transcript.int.test.ts`:

```ts
it("shows rows with Pi's entry ids, live and after a restart from the file", async () => {
  const bed = await createIntBed({ steps: [{ text: "first reply" }, { text: "second reply" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "one");
    await promptAndSettle(bed, live, sessionId, "two");
    const liveIds = live.events().flatMap((event) => (event.kind === "entry" && event.entry.type === "message" ? [event.entry.id] : []));
    bed.killWorker(sessionId);
    await live.waitFor((event) => event.kind === "status" && event.status === "cold");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(snapshot.rows.map((row) => row.entryId)).toEqual(liveIds.slice(-4));
    expect(snapshot.leafId).toBe(liveIds.at(-1));
  } finally {
    await bed.dispose();
  }
});
```

`docs/adr/0007-hot-session-reads-from-the-pi-file.md`:

```markdown
# ADR 0007 — a hot session's transcript is read from Pi's file with the worker's leaf

Status: accepted · Date: 2026-10-11 · Spec: C §3.3 ("Hot session: the daemon uses `get_entries{since}`")

## Context
`get_entries` answers with every entry of the session in one record. A long session crosses the 4 MiB record cap
(ADR 0001) and is dropped. Pi writes each entry right after its subscribers saw it (S1, R38), so the file is complete
except for what the current run produced, which the daemon already holds from the run's events. What the file does not
know is where the leaf is after a navigation: `navigate_tree` moves it in memory and writes nothing (S1).

## Decision
The daemon reads hot and cold sessions from Pi's file through the SDK's own helpers, with a cache of parsed entries
(per size and mtime, four files). For a hot session it walks the branch from the worker's leaf, which it tracks from
`ready.leafId`, every `entry_appended` and every `navigate_tree` answer; during a run it reads the file only up to its
size when the run began, from the leaf at that moment, and appends the run's own rows (R38).

## Consequences
- No transcript ever travels over IPC; history pages and tool output on demand read the file too.
- A navigation nobody continued is lost when the worker goes away (release, crash): Pi's leaf lives in memory. pi-web
  behaves the same. The composer keeps the text "Edit from here" put in it (Task 24).
- The daemon parses large files synchronously; the cache bounds the cost to one parse per change.
```

- [ ] **Step 6: Bind entry ids in the web reducer**

`row-view.ts`: roles `compactionSummary` (text = `summary`, plus `tokensBefore`), `branchSummary` (text = `summary`), `custom` (text from `content`); `toMessageView` returns `null` for a custom message with `display === false`. `session-reducer.ts`: the snapshot keeps `history`, `leafId`; `case "entry"` binds `event.entry.id` to the newest message without an `entryId` that matches (same `toolCallId` for a tool result, else same role and `timestamp === entry.messageTimestamp`) and sets `leafId`; `case "row"` appends the row unless a message with that `entryId` is already there. Tests in `session-reducer.test.ts` pin both. `transcript.vm.ts` maps the summary roles to the `tool` author with their text (Task 25 gives them cards).

- [ ] **Step 7: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions apps/web/src docs/adr/0007-hot-session-reads-from-the-pi-file.md
git commit -m "feat(sessions): transcript rows with entry ids along the active branch"
```

---
### Task 11: Reads — history paging, tool output on demand, fork points

References: spec C §4.3 ("Older history is paged with `sessions.history{before}`", "fetched with `sessions.toolOutput`"); T3 Code `ThreadStream.ts` (bounded pages, tool bodies off the wire); pi-web `ChatWindow` (older history paged with `before`, the minimap's `turnsBefore`) and `BranchNavigator`.

**Risks / rulings needed:** Budgets (history page 900 000 bytes, tool output 800 000 JSON bytes, arguments 64 KiB) are proposals.

**Files:**
- Modify: `packages/contracts/src/{streams,methods}.ts`, `methods.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{service-reads,rpc,service}.ts`, `snapshot.ts` (`fitPage`), `rpc.test.ts`
- Create: `apps/daemon/src/modules/sessions/service.reads.test.ts`, `sessions.reads.int.test.ts`
- Modify: `apps/web/src/stores/{session-store,session-reducer}.ts`; Create: `apps/web/src/stores/history.ts`, `history.test.ts`

**Interfaces:**
- Consumes: Task 10 `TranscriptReader.page/forks/toolCall`, `withTrimmedHistory`.
- Produces:
  - Contracts: `ForkChoice`, `ForkPoint` schemas (mirroring `branch.ts`); methods
    - `sessions.history { sessionId, before: string(1..128), limit?: 1..100 (default 50) } → { rows: TranscriptRow[]; hasMore; oldestEntryId: string|null; turnsBefore }`, `sessions:read`, idempotent, errors `not_found`;
    - `sessions.toolOutput { sessionId, toolCallId: string(1..256) } → { text: string; truncated: boolean; isError: boolean; args: string | null }`, `sessions:read`, idempotent, errors `not_found`;
    - `sessions.branches { sessionId } → { leafId: string|null; points: ForkPoint[] }`, `sessions:read`, idempotent, errors `not_found`.
  - Bounds: a history page ≤ 900 000 bytes (oldest rows of the page left out first, cursor moved accordingly); tool output text ≤ 800 000 bytes once JSON-encoded, args ≤ 64 KiB.
  - Web: `useSessionStore.getState().prependHistory(sessionId, page)`; `prependHistory(view, page): SessionView` (rows deduplicated by entry id, `history` replaced).

- [ ] **Step 1: Write the failing tests**

`service.reads.test.ts` (service bed; writes real Pi files with `sessionFileText`):

```ts
it("pages older rows from a cursor, newest last, and says when the start is reached", async () => {
  const bed = createServiceBed(factories);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const exchanges = Array.from({ length: 45 }, (_, i) => [`q${i}`, `r${i}`] as const);
  bed.writePiFile(0, exchanges);
  bed.emit(0, { type: "agent_settled", aborted: false });
  const snapshot = await bed.snapshot(sessionId);
  // 90 rows: the snapshot keeps the newest 75, which start at r7 (entry a7).
  expect(snapshot.rows).toHaveLength(75);
  expect(snapshot.history).toEqual({ hasMore: true, oldestEntryId: "a7", turnsBefore: 8 });
  const page = await bed.service.history({ sessionId, before: "a7", limit: 50 }, OWNER);
  const said = (row: TranscriptRow) => {
    const content = (row.message as { content: unknown }).content;
    return typeof content === "string" ? content : (content as Array<{ text: string }>)[0]?.text;
  };
  expect(page.rows.map(said)).toEqual(["q0", "r0", "q1", "r1", "q2", "r2", "q3", "r3", "q4", "r4", "q5", "r5", "q6", "r6", "q7"]);
  // The walk reached the system prompt's entry (shown as nothing): that is the oldest entry it read.
  expect(page).toMatchObject({ hasMore: false, oldestEntryId: "s0", turnsBefore: 0 });
  bed.dispose();
});

it("gives a tool's whole output and its arguments, bounded, and not_found for an unknown call", async () => {
  // A file with one read call whose result is 1 MB of text.
  const bed = createServiceBed(factories);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  writeToolSession(bed.files[0] ?? "", "c1", "x".repeat(1_000_000));
  bed.emit(0, { type: "agent_settled", aborted: false });
  const output = await bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER);
  expect(output.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(output.text))).toBeLessThanOrEqual(800_000);
  expect(output.args).toBe(JSON.stringify({ path: "big.txt" }));
  await expect(bed.service.toolOutput({ sessionId, toolCallId: "nope" }, OWNER)).rejects.toThrow(PapError);
  bed.dispose();
});

it("lists the fork points of the active branch", async () => {
  const bed = createServiceBed(factories);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  writeForkedSession(bed.files[0] ?? ""); // a0 has two user children u1 (older) and u2 (on the leaf's path)
  bed.emit(0, { type: "agent_settled", aborted: false });
  const { points } = await bed.service.branches(sessionId, OWNER);
  expect(points).toHaveLength(1);
  expect(points[0]?.choices.map((choice) => [choice.entryId, choice.onPath])).toEqual([["u1", false], ["u2", true]]);
  bed.dispose();
});
```

(`writeToolSession(file, toolCallId, output)` and `writeForkedSession(file)` go into `testing/service-bed.ts` next to `sessionFileText`, each writing a format-3 file with the entries the test names.)

`apps/web/src/stores/history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prependHistory } from "./history.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const row = (entryId: string, content: string) => ({ entryId, message: { role: "user", content, timestamp: Number(entryId.slice(1)) } });

describe("prependHistory", () => {
  it("puts an older page before the rows, once, and moves the cursor", () => {
    const view = reduceSession(EMPTY_VIEW, { kind: "snapshot", status: "idle", rows: [row("e3", "c"), row("e4", "d")], dialogs: [], partial: null, queue: { steering: [], followUp: [], count: 0, bytes: 0 }, statuses: [], widgets: [], title: null, panels: [], notices: [], history: { hasMore: true, oldestEntryId: "e3", turnsBefore: 2 }, activity: { compacting: false, retry: null }, leafId: "e4", name: null });
    const next = prependHistory(view, { rows: [row("e1", "a"), row("e2", "b"), row("e3", "c")], hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
    expect(next.messages.map((message) => message.entryId)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(next.history).toEqual({ hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions apps/web/src/stores`
Expected: FAIL.

- [ ] **Step 3: Implement**

`streams.ts` adds `ForkChoice = z.object({ entryId: z.string().max(128), preview: z.string().max(120), target: z.string().max(128), timestamp: z.string().max(64).nullable(), onPath: z.boolean() })` and `ForkPoint = z.object({ parentId: z.string().max(128).nullable(), choices: z.array(ForkChoice).max(16) })`. `methods.ts` adds the three methods as listed. `service-reads.ts`:

```ts
const PAGE_BYTES = 900_000;
const OUTPUT_JSON_BYTES = 800_000;
const ARGS_BYTES = 64 * 1024;

/** The longest prefix of `text` whose JSON encoding fits in `max` bytes (escapes can make a character six bytes). */
export function clipJsonText(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(text)) <= max) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= max) low = mid;
    else high = mid - 1;
  }
  // Never end on half of a surrogate pair.
  const end = low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1] ?? "") ? low - 1 : low;
  return { text: text.slice(0, end), truncated: true };
}

const textOfResult = (result: unknown): string => {
  const content = (result as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => ((block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).join("") : "";
};

// in createSessionReads:
    async history({ sessionId, before, limit }, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const file = fileOf(row, deps.live.get(sessionId));
      if (!file) return { rows: [], hasMore: false, oldestEntryId: null, turnsBefore: 0 };
      // The whole file: rows older than the cursor were written before the run that may be going on (R38).
      return fitPage(reader.page(file, { before, limit: limit ?? 50 }), PAGE_BYTES);
    },
    async toolOutput({ sessionId, toolCallId }, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const file = fileOf(row, deps.live.get(sessionId));
      const found = file ? reader.toolCall(file, toolCallId) : { result: null, args: null };
      if (found.result === null) throw new PapError("not_found");
      const { text, truncated } = clipJsonText(textOfResult(found.result), OUTPUT_JSON_BYTES);
      const args = found.args === null ? null : clipJsonText(JSON.stringify(found.args) ?? "", ARGS_BYTES).text;
      return { text, truncated, isError: (found.result as { isError?: unknown }).isError === true, args };
    },
    async branches(sessionId, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const session = deps.live.get(sessionId);
      const file = fileOf(row, session);
      const leafId = session?.leafId() ?? (file ? reader.lastEntryId(file) : null);
      return { leafId, points: file ? reader.forks(file, leafId) : [] };
    },
```

where `ensureReader()` is the memoized load `prepare` already does, `fileOf(row, session)` is the snapshot's "recorded file, else the reported one if it is a Pi session file" rule (moved into a function both use), and `snapshot.ts` gains:

```ts
/** A page under `budget` bytes: its oldest rows go first, and the cursor follows the oldest row kept. */
export function fitPage(page: BranchPage, budget: number): BranchPage {
  const kept: TranscriptRow[] = [];
  let used = 0;
  for (const candidate of page.rows.toReversed()) {
    const { row, size } = fitRow(candidate);
    if (used + size + 1 > budget) break;
    used += size + 1;
    kept.unshift(row);
  }
  if (kept.length === page.rows.length) return page;
  return { ...page, rows: kept, hasMore: true, oldestEntryId: kept[0]?.entryId ?? page.oldestEntryId };
}
```

`service.ts` exposes `history`, `toolOutput`, `branches` (delegating to the reads) and `rpc.ts` maps the three methods one line each. `apps/web/src/stores/history.ts`:

```ts
import type { HistoryMeta, TranscriptRow } from "@pap/contracts";
import { toMessageView, withUniqueKey } from "./row-view.ts";
import type { SessionView } from "./session-reducer.ts";

/** An older page goes before what the view has; a row already there (same entry id) is not added twice. */
export function prependHistory(view: SessionView, page: HistoryMeta & { rows: readonly TranscriptRow[] }): SessionView {
  const known = new Set(view.messages.flatMap((message) => (message.entryId ? [message.entryId] : [])));
  const older = page.rows.filter((row) => row.entryId === null || !known.has(row.entryId));
  const messages = [...older, ...view.messages.map((message) => message)].reduce<SessionView["messages"][number][]>((list, item) => {
    const message = "message" in item ? toMessageView(item.message, item.entryId) : item;
    return message ? [...list, withUniqueKey(list, message)] : list;
  }, []);
  return { ...view, messages, history: { hasMore: page.hasMore, oldestEntryId: page.oldestEntryId, turnsBefore: page.turnsBefore } };
}
```

and `session-store.ts` gains `prependHistory(sessionId, page)` applying it.

- [ ] **Step 4: Write the integration test**

`sessions.reads.int.test.ts` (int bed): the work folder holds `big.txt` (600 lines of 50 characters); the script is `{ steps: [{ toolCalls: [{ name: "read", args: { path: "big.txt" }, id: "c1" }] }, { text: "read it" }] }` (`read` runs without approval). After `promptAndSettle`, the live `message_end` of the tool result carries `papTruncated`, the subscriber's snapshot row too, and `sessions.toolOutput({ sessionId, toolCallId: "c1" })` returns `truncated: false` and the 30 000-character text; `sessions.branches` returns no point for this linear session.

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores
git commit -m "feat(sessions): history pages, tool output on demand and fork points"
```

---

### Task 12: Steering queue — `queue` events, the 128-message / 32 MiB cap, `sessions.clearQueue`

References: spec C §2.4; Orca `rpc-prompt-delivery.ts` (128 pending / 32 MiB, the source of pap's numbers); Pi `docs/rpc-commands.md` ("To implement interactive Esc behavior, send `clear_queue` before `abort`"); pi-web `ChatInput` (queued steering and follow-up shown above the composer).

**Risks / rulings needed:** The cap counts prompts in flight plus Pi's own queue, so a burst can be refused slightly early (never late). The composer always sends the user's streaming preference (pinned by the last integration case).

**Files:**
- Create: `apps/daemon/src/modules/sessions/queue-guard.ts`, `queue-guard.test.ts`, `sessions.queue.int.test.ts`
- Modify: `packages/contracts/src/methods.ts` (`sessions.prompt` errors + `queue_full`; `sessions.clearQueue`), `apps/daemon/src/modules/sessions/{live-session,live-run,service,service-reads,rpc}.ts`, `live-session.test.ts`
- Modify: `apps/web/src/stores/session-reducer.ts`, `session-reducer.test.ts`

**Interfaces:**
- Consumes: Task 2 `clear_queue` and slim `queue_update`, Task 8 `promptsInFlight`.
- Produces:
  - `createQueueGuard(): QueueGuard { admit(text): () => void /* throws PapError("queue_full") */; onQueueUpdate(update: { steering: string[]; followUp: string[]; count: number; bytes: number }): QueueView; view(): QueueView; reset(): void }`, `MAX_QUEUED_MESSAGES = 128`, `MAX_QUEUED_BYTES = 32 * 1024 * 1024`.
  - Stream: `{kind: "queue", queue}` from every `queue_update` (the raw event is not forwarded); snapshot `queue`.
  - `LiveSession.clearQueue(): Promise<{ steering: string[]; followUp: string[]; truncated: boolean }>`; method `sessions.clearQueue { sessionId } → same`, `sessions:operate`, mutation, errors `not_found`, `worker_failed`. A cold session answers empty lists.
  - Web: `SessionView.queue: QueueView` (cleared when the status goes `cold`).

- [ ] **Step 1: Write the failing tests**

`queue-guard.test.ts`:

```ts
import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createQueueGuard, MAX_QUEUED_BYTES, MAX_QUEUED_MESSAGES } from "./queue-guard.ts";

const update = (count: number, bytes: number) => ({ steering: Array.from({ length: Math.min(count, 128) }, () => "s"), followUp: [], count, bytes });

describe("queue guard", () => {
  it("counts what Pi holds plus what is on its way, and refuses the 129th", () => {
    const guard = createQueueGuard();
    guard.onQueueUpdate(update(MAX_QUEUED_MESSAGES - 1, 10));
    const release = guard.admit("one more");
    expect(() => guard.admit("too many")).toThrow(new PapError("queue_full"));
    release();
    expect(() => guard.admit("fits again")).not.toThrow();
  });

  it("refuses what would pass 32 MiB", () => {
    const guard = createQueueGuard();
    guard.onQueueUpdate(update(1, MAX_QUEUED_BYTES - 4));
    expect(() => guard.admit("12345")).toThrow(new PapError("queue_full"));
    expect(() => guard.admit("1234")).not.toThrow();
  });

  it("shows previews and the totals, and empties on reset", () => {
    const guard = createQueueGuard();
    expect(guard.onQueueUpdate({ steering: ["left"], followUp: ["after"], count: 2, bytes: 9 })).toEqual({ steering: ["left"], followUp: ["after"], count: 2, bytes: 9 });
    guard.reset();
    expect(guard.view()).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
  });
});
```

In `live-session.test.ts`:

```ts
it("publishes the queue and refuses a prompt over the cap without sending it", async () => {
  const { live, worker, published, clock } = setup();
  worker.emit(piEvent({ type: "queue_update", steering: ["left"], followUp: [], count: 128, bytes: 4 }));
  await clock.advance(0);
  expect(published.at(-1)).toEqual({ kind: "queue", queue: { steering: ["left"], followUp: [], count: 128, bytes: 4 } });
  await expect(live.prompt("one more", "steer")).rejects.toThrow(new PapError("queue_full"));
  expect(worker.requests.filter((request) => request.type === "prompt")).toEqual([]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`queue-guard.ts`:

```ts
import { EMPTY_QUEUE, PapError, type QueueView, UI_LIMITS } from "@pap/contracts";

export const MAX_QUEUED_MESSAGES = 128;
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export interface QueueGuard {
  /** Counts a prompt on its way to Pi; the returned function uncounts it once Pi has answered. */
  admit(text: string): () => void;
  onQueueUpdate(update: { steering: readonly string[]; followUp: readonly string[]; count: number; bytes: number }): QueueView;
  view(): QueueView;
  reset(): void;
}

/**
 * Pi's steering and follow-up queue, capped at 128 messages and 32 MiB (spec C §2.4). What Pi holds comes from its
 * `queue_update` events; what is on its way is counted until Pi answers the prompt, so a burst of prompts cannot slip
 * past the cap between two updates. Counting a prompt twice for a moment (in flight and already in Pi's next update)
 * errs on the side of refusing.
 */
export function createQueueGuard(): QueueGuard {
  let held = EMPTY_QUEUE;
  let inFlight = 0;
  let inFlightBytes = 0;
  return {
    admit(text) {
      const size = Buffer.byteLength(text);
      if (held.count + inFlight + 1 > MAX_QUEUED_MESSAGES || held.bytes + inFlightBytes + size > MAX_QUEUED_BYTES) {
        throw new PapError("queue_full");
      }
      inFlight++;
      inFlightBytes += size;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight--;
        inFlightBytes -= size;
      };
    },
    onQueueUpdate(update) {
      const preview = (texts: readonly string[]) => texts.slice(0, UI_LIMITS.queueEntries).map((text) => String(text).slice(0, UI_LIMITS.queuePreviewChars));
      held = {
        steering: preview(update.steering),
        followUp: preview(update.followUp),
        count: Math.max(0, Math.trunc(update.count) || 0),
        bytes: Math.max(0, Math.trunc(update.bytes) || 0),
      };
      return held;
    },
    view: () => held,
    reset() {
      held = EMPTY_QUEUE;
      inFlight = 0;
      inFlightBytes = 0;
    },
  };
}
```

`live-run.ts` `prompt()`: `const release = queue.admit(text);` before `tracker.onInput()` and `release()` in the `finally` (the guard is created by the live session and passed in). `live-session.ts`: a `queue_update` Pi event calls `publish({ kind: "queue", queue: queue.onQueueUpdate(event as never) })` and is not pushed to the coalescer; the exit handler calls `queue.reset()`; `clearQueue()` sends `{ type: "clear_queue" }` and returns the response data (`success: false` → `PapError("worker_failed")`); the snapshot gets `queue: session?.queue() ?? EMPTY_QUEUE`. `service.ts` `clearQueue(sessionId, caller)`: owned; `live.get(sessionId)?.clearQueue() ?? { steering: [], followUp: [], truncated: false }`. Web reducer: `case "queue"` stores it; the snapshot sets it; `status` → `cold` empties it.

- [ ] **Step 4: Write the integration test**

`sessions.queue.int.test.ts` (int bed):

```ts
it("delivers a steer before the next model call and a follow-up after the run, in that order", async () => {
  const bed = await createIntBed({ steps: [{ toolCalls: [{ name: "bash", args: { command: "echo parked" }, id: "c1" }] }, { text: "after the steer" }, { text: "after the follow-up" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "go" }, bed.ctx);
    const ask = await sub.waitFor((event) => event.kind === "dialog_open");
    expect(await bed.rpc["sessions.prompt"]({ sessionId, text: "steer now", streamingBehavior: "steer" }, bed.ctx)).toEqual({ disposition: "queued" });
    expect(await bed.rpc["sessions.prompt"]({ sessionId, text: "then this", streamingBehavior: "followUp" }, bed.ctx)).toEqual({ disposition: "queued" });
    await sub.waitFor((event) => event.kind === "queue" && event.queue.count === 2);
    if (ask.kind !== "dialog_open") throw new Error("no dialog");
    await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: ask.dialog.id, response: { confirmed: true } }, bed.ctx);
    await sub.waitFor((event) => event.kind === "queue" && event.queue.count === 0);
    await sub.waitFor((event) => event.kind === "status" && event.status === "idle");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    const said = snapshot.rows.map((row) => row.message as { role: string; content: unknown }).filter((message) => message.role === "user" || message.role === "assistant").map((message) => `${message.role}:${JSON.stringify(message.content).slice(0, 40)}`);
    expect(said.map((line) => line.split(":")[0])).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(said[2]).toContain("steer now");
    expect(said[3]).toContain("after the steer");
    expect(said[4]).toContain("then this");
  } finally {
    await bed.dispose();
  }
});

it("refuses the 129th queued message, and Stop = clear the queue, then abort", async () => {
  const bed = await createIntBed({ steps: [{ toolCalls: [{ name: "bash", args: { command: "echo parked" }, id: "c1" }] }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "go" }, bed.ctx);
    await sub.waitFor((event) => event.kind === "dialog_open");
    for (let i = 0; i < 128; i++) await bed.rpc["sessions.prompt"]({ sessionId, text: `s${i}`, streamingBehavior: "steer" }, bed.ctx);
    await expect(bed.rpc["sessions.prompt"]({ sessionId, text: "s128", streamingBehavior: "steer" }, bed.ctx)).rejects.toMatchObject({ code: "queue_full" });
    const cleared = await bed.rpc["sessions.clearQueue"]({ sessionId }, bed.ctx);
    expect(cleared.steering).toHaveLength(128);
    await bed.rpc["sessions.abort"]({ sessionId }, bed.ctx);
    await sub.waitFor((event) => event.kind === "status" && event.status === "idle");
  } finally {
    await bed.dispose();
  }
});

it("starts a run when a prompt carries a streaming behaviour while Pi is idle", async () => {
  const bed = await createIntBed({ steps: [{ text: "hello" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    expect(await bed.rpc["sessions.prompt"]({ sessionId, text: "hi", streamingBehavior: "steer" }, bed.ctx)).toEqual({ disposition: "started" });
  } finally {
    await bed.dispose();
  }
});
```

(The last case pins what the composer relies on in Task 24: it always sends the user's streaming preference. Task 13 changes the first two cases to answer the approval with `{ answer: "once" }`.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores
git commit -m "feat(sessions): steering queue events, the 128 / 32 MiB cap and clearQueue"
```

---

### Task 13: Approval channel end to end — the policy's own question (R90 part, pulled forward)

Until now the policy asked through `ctx.ui.confirm`, so any extension's confirm looked like an approval card and the policy's question looked like any extension's. M2 gives the policy a channel of its own (`approval_request` / `approval_response`, defined in Task 1 and recorded in ADR 0008): no extension can raise a policy card, and the card can carry the policy's answers. This task carries "once" and "deny"; Task 14 adds "session" and "always".

**Risks / rulings needed:** Pulls R90's "policy-origin marker" and "closed → `FAIL_CLOSED_REASON`" forward from M5: controller confirms. `{confirmed}` stays accepted for approvals (M1 clients, the smoke), mapped to once / deny.

**Files:**
- Create: `packages/pi-host/src/approvals.ts`, `approvals.test.ts`, `packages/pi-host/src/policy/grant-key.ts`, `grant-key.test.ts`
- Modify: `packages/pi-host/src/policy/extension.ts`, `extension.test.ts`, `extension-edits.test.ts`, `packages/pi-host/src/{open-session,host,dispatch}.ts`, `testing/policy-bed.ts`, `testing/host-bed.ts` (`isApproval`), `host.int.test.ts`, `host.probes.int.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{dialogs,live-ui}.ts`, `dialogs.test.ts`, `live-session.test.ts`, `packages/contracts/src/methods.ts` (`respondDialog` errors + `bad_request`), `apps/web/src/features/sessions/SessionScreen.tsx`, `SessionScreen.test.tsx`, `scripts/smoke-dist.ts`, `sessions.queue.int.test.ts`, `sessions.int.test.ts`

**Interfaces:**
- Consumes: Task 1 records, Task 4 `send(): boolean`.
- Produces:
  - `createApprovals(send, { newId }): Approvals { ask(request: ApprovalAsk, signal?): Promise<{ answer: ApprovalAnswer; closed: boolean }>; resolve(record: { id; answer }): void; cancelAll(): void; pendingCount(): number }` with `ApprovalAsk { category; title; message; tool; key; answers }`.
  - `grantKey(tool, payload): string` (sha256 hex of `tool + "\0" + payload`); `grantPayload(input, exec): string` (the command string for a built-in shell call, else canonical JSON with sorted keys).
  - `PolicyConfig.ask` replaces `ctx.ui.confirm`; `answersFor(category, review): ApprovalAnswer[]` (this task: `["deny", "once"]`); a closed question blocks with `FAIL_CLOSED_REASON` and audit reason `dialog closed`.
  - Daemon: `DialogRegistry.offerApproval(record: ApprovalRequestRecord): DialogVerdict` (`Dialog.method = "approval"`, `category`, `answers`; the registry keeps `{tool, key, label}` beside it: `peek(id): Dialog | null` (looks without taking), `takeEntry(id): { dialog; grant: Grant | null } | null`, `Grant = { tool; key; label }`, `label` = the message cut to 4096 characters); `LiveSession.answer(id, response): { answer: ApprovalAnswer; grant: Grant } | null` — the approval answer, for Task 14. Response mapping for an approval: `{answer}` must be one the dialog offers (else `bad_request`), `{confirmed: true}` → `once`, `{confirmed: false}` and `{cancelled: true}` → `deny`, `{value}` → `bad_request`; `{answer}` for any other dialog → `bad_request`. A cancelled approval (limits, malformed) is answered `deny`.
  - Web: an approval dialog renders `ApprovalCard` (Allow once → `{answer: "once"}`, Deny → `{answer: "deny"}`); an extension `confirm` keeps rendering `ApprovalCard` with `{confirmed}` until Task 26.

- [ ] **Step 1: Write the failing tests**

`approvals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createApprovals } from "./approvals.ts";

const KEY = "b".repeat(64);
const request = { category: "exec" as const, title: "Run a command?", message: "1 line\nbash: ls", tool: "bash", key: KEY, answers: ["deny", "once"] as const };

describe("approvals", () => {
  it("asks with its own record and returns the answer", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals((record) => { sent.push(record); return true; }, { newId: () => "a1" });
    const answer = approvals.ask({ ...request, answers: [...request.answers] });
    expect(sent).toEqual([{ type: "approval_request", id: "a1", ...request, answers: ["deny", "once"] }]);
    approvals.resolve({ id: "a1", answer: "once" });
    expect(await answer).toEqual({ answer: "once", closed: false });
  });

  it("treats an answer it did not offer as a refusal", async () => {
    const approvals = createApprovals(() => true, { newId: () => "a1" });
    const answer = approvals.ask({ ...request, answers: ["deny", "once"] });
    approvals.resolve({ id: "a1", answer: "always" });
    expect(await answer).toEqual({ answer: "deny", closed: false });
  });

  it("closes on abort, on cancelAll and when the request cannot be sent, always as a refusal", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals((record) => { sent.push(record); return true; }, { newId: () => `a${sent.length}` });
    const controller = new AbortController();
    const aborted = approvals.ask({ ...request, answers: ["deny", "once"] }, controller.signal);
    controller.abort();
    expect(await aborted).toEqual({ answer: "deny", closed: true });
    expect(sent.at(-1)).toEqual({ type: "extension_ui_closed", id: "a0" });
    const pending = approvals.ask({ ...request, answers: ["deny", "once"] });
    approvals.cancelAll();
    expect(await pending).toEqual({ answer: "deny", closed: true });
    const unsent = createApprovals(() => false, { newId: () => "x" });
    expect(await unsent.ask({ ...request, answers: ["deny", "once"] })).toEqual({ answer: "deny", closed: true });
    expect(approvals.pendingCount() + unsent.pendingCount()).toBe(0);
  });
});
```

`grant-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { grantKey, grantPayload } from "./grant-key.ts";

describe("grant keys", () => {
  it("are the same for the same exact call and differ for any other", () => {
    const ls = grantKey("bash", grantPayload({ command: "ls -la" }, true));
    expect(ls).toMatch(/^[0-9a-f]{64}$/);
    expect(grantKey("bash", grantPayload({ command: "ls -la", timeout: 5 }, true))).toBe(ls);
    expect(grantKey("bash", grantPayload({ command: "ls  -la" }, true))).not.toBe(ls);
    expect(grantKey("bash", grantPayload({ command: "ls -la​" }, true))).not.toBe(ls);
    expect(grantKey("other", grantPayload({ command: "ls -la" }, true))).not.toBe(ls);
  });

  it("ignore the order of object keys for other tools", () => {
    expect(grantKey("fetch", grantPayload({ url: "https://a", method: "GET" }, false))).toBe(grantKey("fetch", grantPayload({ method: "GET", url: "https://a" }, false)));
  });
});
```

In `extension.test.ts`, the policy bed's fake context loses `ui.confirm` and the bed's `ask` records the requests:

```ts
it("asks the policy's own question, never through ctx.ui, and runs on once", async () => {
  const bed = policyBed({ answer: { answer: "once", closed: false } });
  expect(await bed.evaluate("bash", { command: "ls" })).toBeUndefined();
  expect(bed.asked).toEqual([expect.objectContaining({ category: "exec", tool: "bash", answers: ["deny", "once"], key: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
  expect(bed.confirms).toBe(0);
  expect(bed.audit.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
});

it("blocks with the deny reason on deny and fails closed when the question is closed", async () => {
  expect(await policyBed({ answer: { answer: "deny", closed: false } }).evaluate("bash", { command: "ls" })).toEqual({ block: true, reason: DENIED_REASON });
  const closed = policyBed({ answer: { answer: "deny", closed: true } });
  expect(await closed.evaluate("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  expect(closed.audit.at(-1)).toMatchObject({ decision: "denied", reason: "dialog closed" });
});
```

In `dialogs.test.ts`:

```ts
const approval = (id: string, fields: Record<string, unknown> = {}) => ({ type: "approval_request" as const, id, category: "exec" as const, title: "Run a command?", message: "1 line\nbash: ls", answers: ["deny", "once"] as ("deny" | "once")[], tool: "bash", key: "c".repeat(64), ...fields });

it("opens an approval as its own kind of dialog and keeps the grant beside it", () => {
  const dialogs = createDialogRegistry();
  expect(dialogs.offerApproval(approval("a1"))).toEqual({ kind: "opened", dialog: { id: "a1", method: "approval", title: "Run a command?", message: "1 line\nbash: ls", category: "exec", answers: ["deny", "once"] } });
  expect(dialogs.takeEntry("a1")?.grant).toEqual({ tool: "bash", key: "c".repeat(64), label: "1 line\nbash: ls" });
});

it("never cuts an approval's message: one over the limit is cancelled", () => {
  expect(createDialogRegistry().offerApproval(approval("a1", { message: "x".repeat(65_537) })).kind).toBe("cancel");
});
```

In `live-session.test.ts`:

```ts
it("answers an approval with the policy's record, mapping the M1 answers", async () => {
  const { live, worker, clock } = setup();
  worker.emit({ type: "approval_request", id: "a1", category: "exec", title: "Run?", message: "bash: ls", answers: ["deny", "once"], tool: "bash", key: "c".repeat(64) });
  worker.emit({ type: "approval_request", id: "a2", category: "exec", title: "Run?", message: "bash: pwd", answers: ["deny", "once"], tool: "bash", key: "d".repeat(64) });
  await clock.advance(0);
  live.answer("a1", { confirmed: true });
  expect(() => live.answer("a2", { answer: "always" })).toThrow(new PapError("bad_request"));
  live.answer("a2", { answer: "deny" });
  expect(worker.sent.filter((record) => record.type === "approval_response")).toEqual([
    { type: "approval_response", id: "a1", answer: "once" },
    { type: "approval_response", id: "a2", answer: "deny" },
  ]);
});
```

(`live.answer("a2", { answer: "always" })` throws before taking the dialog, so the second, valid answer still finds it.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement the pi-host side**

`packages/pi-host/src/approvals.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ApprovalAnswer, ToolCategory } from "@pap/contracts";

export interface ApprovalAsk {
  readonly category: ToolCategory;
  readonly title: string;
  readonly message: string;
  readonly tool: string;
  readonly key: string;
  readonly answers: readonly ApprovalAnswer[];
}
export interface ApprovalOutcome {
  readonly answer: ApprovalAnswer;
  /** The question went away unanswered: Stop, a shutdown, or a request that could not leave. */
  readonly closed: boolean;
}
export type ApprovalOutbound =
  | ({ type: "approval_request"; id: string } & Omit<ApprovalAsk, "answers"> & { answers: ApprovalAnswer[] })
  | { type: "extension_ui_closed"; id: string };

export interface Approvals {
  ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>;
  resolve(record: { id: string; answer: ApprovalAnswer }): void;
  cancelAll(): void;
  pendingCount(): number;
}

const CLOSED: ApprovalOutcome = { answer: "deny", closed: true };

/** The policy's questions. Nothing but pap-policy holds this object: an extension can only reach `ctx.ui`. */
export function createApprovals(send: (record: ApprovalOutbound) => boolean, options: { newId?: () => string } = {}): Approvals {
  const newId = options.newId ?? randomUUID;
  const pending = new Map<string, { offered: readonly ApprovalAnswer[]; settle(outcome: ApprovalOutcome): void }>();
  return {
    ask(request, signal) {
      if (signal?.aborted) return Promise.resolve(CLOSED);
      const id = newId();
      return new Promise((resolve) => {
        const close = () => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", close);
          send({ type: "extension_ui_closed", id });
          resolve(CLOSED);
        };
        pending.set(id, {
          offered: request.answers,
          settle: (outcome) => {
            if (!pending.delete(id)) return;
            signal?.removeEventListener("abort", close);
            resolve(outcome);
          },
        });
        signal?.addEventListener("abort", close, { once: true });
        if (!send({ type: "approval_request", id, ...request, answers: [...request.answers] })) {
          pending.get(id)?.settle(CLOSED);
        }
      });
    },
    resolve(record) {
      const entry = pending.get(record.id);
      entry?.settle({ answer: entry.offered.includes(record.answer) ? record.answer : "deny", closed: false });
    },
    cancelAll() {
      for (const [id, entry] of [...pending]) {
        send({ type: "extension_ui_closed", id });
        entry.settle(CLOSED);
      }
    },
    pendingCount: () => pending.size,
  };
}
```

`packages/pi-host/src/policy/grant-key.ts`:

```ts
import { createHash } from "node:crypto";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** What a grant covers: the exact command of a built-in shell call, else the exact input (keys sorted). */
export function grantPayload(input: unknown, exec: boolean): string {
  const command = (input as { command?: unknown } | null)?.command;
  return exec && typeof command === "string" ? command : canonical(input ?? {});
}

/** sha256 of a tool name and an exact payload: the only thing a "session" or "always" grant matches. */
export function grantKey(tool: string, payload: string): string {
  return createHash("sha256").update(tool).update("\0").update(payload).digest("hex");
}
```

`policy/extension.ts`: `PolicyContext` loses `ui`; `PolicyConfig` gains `ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>`; and:

```ts
/** The answers a card offers, in DESIGN.md order (Deny / Session / Always / Allow once). Task 14 widens this. */
export function answersFor(_category: ToolCategory, _review: EditReview | undefined): ApprovalAnswer[] {
  return ["deny", "once"];
}

// in evaluateToolCall, replacing the confirm call:
    const exec = category === "exec";
    const key = grantKey(event.toolName, grantPayload(event.input, exec));
    const outcome = await deps.ask(
      { category, title: TITLES[category], message: description.message, tool: event.toolName.slice(0, MAX_AUDIT_FIELD), key, answers: answersFor(category, review) },
      ctx.signal,
    );
    if (outcome.closed) {
      record("denied", "dialog closed");
      return { block: true, reason: FAIL_CLOSED_REASON };
    }
    if (outcome.answer === "deny") {
      record("denied", review?.why);
      return { block: true, reason: DENIED_REASON };
    }
    record("approved", `answer: ${outcome.answer}`);
    return undefined;
```

`open-session.ts`: `OpenSessionDeps` gains `readonly approvals: Approvals`, passed as `ask: (request, signal) => deps.approvals.ask(request, signal)` to `createPapPolicyExtension`. `host.ts` creates `const approvals = createApprovals((record) => ipc.send(record))`, calls `approvals.cancelAll()` next to `ui.cancelAll()` in `shutdown`, and passes it to `openSession` and `createDispatch`; `dispatch.ts` gains `case "approval_response": deps.approvals.resolve(record); return;`. `testing/host-bed.ts` gets `isApproval = (record) => record.type === "approval_request"`; the host integration tests that waited for a confirm wait for an approval and answer `{ type: "approval_response", id, answer: "once" | "deny" }`.

- [ ] **Step 4: Implement the daemon and web side**

`dialogs.ts`:

```ts
export interface Grant {
  readonly tool: string;
  readonly key: string;
  /** What the "always" list shows for the rule: the call as the card showed it, cut to 4096 characters. */
  readonly label: string;
}

  // in createDialogRegistry (the open map now holds { dialog, bytes, grant: Grant | null }):
    offerApproval(record) {
      const parsed = Dialog.safeParse({ id: record.id, method: "approval", title: record.title, message: record.message, category: record.category, answers: record.answers });
      // An approval is never cut: the card must show the whole call (R86). One that does not fit is refused.
      if (!parsed.success || sizeOf(parsed.data) > DIALOG_FRAME_BYTES) return cancel("too_large");
      return place(parsed.data, { tool: record.tool, key: record.key, label: record.message.slice(0, 4096) });
    },
    takeEntry(id) { … returns { dialog, grant } and frees its bytes … },
    take: (id) => registry.takeEntry(id)?.dialog ?? null,
```

where `place(dialog, grant)` is the count/byte limit check `offer()` already does, extracted so both paths share it.

`live-ui.ts`: the `approval_request` record goes to `offerApproval`; a cancel verdict sends `{ type: "approval_response", id, answer: "deny" }` and the rate-limited notice; `answer(dialogId, response)`:

```ts
  function approvalAnswerOf(dialog: Dialog, response: DialogResponse): ApprovalAnswer {
    if ("answer" in response) {
      if (!dialog.answers?.includes(response.answer)) throw new PapError("bad_request");
      return response.answer;
    }
    if ("confirmed" in response) return response.confirmed ? "once" : "deny";
    if ("cancelled" in response) return "deny";
    throw new PapError("bad_request");
  }

  answer(dialogId, response) {
    const open = registry.peek(dialogId); // the dialog without taking it
    if (!open) throw new PapError("not_found");
    if (open.method !== "approval") {
      if ("answer" in response) throw new PapError("bad_request");
      // … M1 path: take, send extension_ui_response, publish dialog_closed …
      return null;
    }
    const answer = approvalAnswerOf(open, response); // throws before anything is taken
    const entry = registry.takeEntry(dialogId);
    const delivered = handle.send({ type: "approval_response", id: dialogId, answer });
    publish({ kind: "dialog_closed", id: dialogId });
    if (!delivered) throw new PapError("worker_failed");
    return entry?.grant ? { answer, grant: entry.grant } : null;
  },
```

`methods.ts`: `sessions.respondDialog` errors gain `bad_request`. `SessionScreen.tsx`: `dialog.method === "approval"` renders `ApprovalCard` with `onAnswer={(approved) => answer(dialog.id, { answer: approved ? "once" : "deny" })}`; `confirm` keeps `{ confirmed }`. `scripts/smoke-dist.ts` answers `{ answer: "once" }`. `sessions.queue.int.test.ts` and `sessions.int.test.ts` answer approvals with `{ answer: "once" }`.

- [ ] **Step 5: Write the integration test**

In `host.int.test.ts`:

```ts
it("asks the policy's question with its own record, and an extension's confirm stays a plain dialog", async () => {
  mkdirSync(join(bed.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(bed.agentDir, "extensions", "asker.js"), `export default function (pi) { pi.registerCommand("ask", { handler: async (_a, ctx) => { await ctx.ui.confirm("Extension question", "yes?"); } }); }\n`);
  await bed.start(bashScript("echo approved"));
  const host = bed.host();
  host.send({ type: "prompt", id: "p1", message: "/ask" });
  const plain = await host.waitFor((r) => r.type === "extension_ui_request");
  expect(plain.method).toBe("confirm");
  host.send({ type: "extension_ui_response", id: plain.id, confirmed: true });
  host.send({ type: "prompt", id: "p2", message: "go" });
  const ask = await host.waitFor(isApproval);
  expect(ask).toMatchObject({ category: "exec", tool: "bash", answers: ["deny", "once"] });
  host.send({ type: "approval_response", id: ask.id, answer: "once" });
  await host.waitFor((r) => r.type === "tool_execution_end" && r.isError === false);
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke`
Expected: PASS (the smoke approves through the new channel).

```bash
git add packages/pi-host/src packages/contracts apps/daemon/src/modules/sessions apps/web/src/features/sessions scripts/smoke-dist.ts
git commit -m "feat(policy): approvals on a channel of their own, closed questions fail closed"
```

---
### Task 14: Session and always grants, the `policy` module (spec C §5.3)

"Session" grants live in the worker's policy (spec C: "held in worker memory"); "always" grants are rows of a new `policy` daemon module's `approval_rules` table (spec C §3.2 lists the table), scoped per project (the session's real cwd), compiled into `PolicyRules.alwaysAllow` at worker start and pushed with `policy_update` when they change. A grant matches one exact call: the tool name and the sha256 of its exact payload (Task 13's `grantKey`). Settings › Approvals (revocation UI) is M5; M2 ships `policy.listRules` / `policy.revokeRule` and the minimal list of Task 28. Taint ("ask even when an always rule exists") is M5.

**Risks / rulings needed:** Which questions offer which answers (open question 3, proposed: all four for exec / network / external-write; no "always" for `unknown` tools; only once / deny for edits outside the project or to protected paths). Exact-match grants only, no prefix or pattern (open question 1). At 1000 rules for one project, a new "always" answer is kept for the session only, with a notice. Session grants are capped at 1000 per worker (oldest dropped).

**Files:**
- Modify: `packages/pi-host/src/policy/extension.ts`, `extension.test.ts`
- Create: `apps/daemon/src/modules/policy/{index,store,service,rpc}.ts`, `migrations/202610110100_policy.sql`, `store.test.ts`, `service.test.ts`, `rpc.test.ts`
- Modify: `packages/contracts/src/methods.ts`, `methods.test.ts`, `apps/daemon/src/daemon.ts`, `apps/daemon/src/modules/sessions/{index,service,live-ui}.ts`, `service.test.ts`, `testing/{service-bed,int-bed}.ts`, `sessions.int.test.ts` and every other `createSessionsModule` call (the `policy` port is a required dependency from this task on)
- Create: `apps/daemon/src/modules/sessions/sessions.grants.int.test.ts`

**Interfaces:**
- Consumes: Task 13 `answersFor`, `grantKey`, `LiveSession.answer() → { answer, grant } | null`.
- Produces:
  - pi-host: `answersFor(category, review)` as in the ruling line; the policy skips the question when its session grants or `rules().alwaysAllow` hold `{tool, key}` for a call without `review`, auditing `allow` with reason `session rule` / `always rule`; `MAX_SESSION_GRANTS = 1000`.
  - `createPolicyModule({ db, clock, logger, newId }): PolicyModule { rpc: Pick<HandlerTable, "policy.listRules" | "policy.revokeRule">; port: PolicyPort }`, `POLICY_MIGRATIONS`.
  - `PolicyPort { rulesFor(ownerId, scope): AlwaysRule[]; addAlways(input: { ownerId; scope; tool; key; label }): "added" | "exists" | "full"; onChange(listener: (ownerId: string, scope: string) => void): () => void }`.
  - Methods: `policy.listRules { cwd?: string(1..4096) } → { rules: Array<{ id; cwd; tool; label; createdAt }> }` (`policy:read`, idempotent, newest first, 1000 at most); `policy.revokeRule { ruleId: string(1..128) } → { ok: true }` (`policy:admin`, mutation, errors `not_found`).
  - Sessions: `SessionsModuleDeps.policy: PolicyPort`; every `init.policy` carries `alwaysAllow: policy.rulesFor(row.ownerId, row.cwd)`; an "always" answer calls `addAlways` with the dialog's grant; `onChange(owner, scope)` sends `policy_update` to every live **and starting** session of that owner and cwd (a starting worker queues it before `ready`, ADR 0001).

- [ ] **Step 1: Write the failing tests**

pi-host `extension.test.ts` (the bed now takes `rules` and a scripted `ask`):

```ts
it("asks once, then lets the identical call through for the rest of the worker's life on a session answer", async () => {
  const bed = policyBed({ answers: [{ answer: "session", closed: false }] });
  expect(await bed.evaluate("bash", { command: "npm test" })).toBeUndefined();
  expect(await bed.evaluate("bash", { command: "npm test" })).toBeUndefined();
  expect(bed.asked).toHaveLength(1);
  expect(bed.audit.at(-1)).toMatchObject({ decision: "allow", reason: "session rule" });
  await bed.evaluate("bash", { command: "npm test " });
  expect(bed.asked).toHaveLength(2);
});

it("lets a call through on a project's always rule, matching the exact call only", async () => {
  const key = grantKey("bash", "npm test");
  const bed = policyBed({ rules: { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [{ tool: "bash", key }] }, answers: [{ answer: "deny", closed: false }] });
  expect(await bed.evaluate("bash", { command: "npm test" })).toBeUndefined();
  expect(bed.audit.at(-1)).toMatchObject({ decision: "allow", reason: "always rule" });
  expect(await bed.evaluate("bash", { command: "npm  test" })).toEqual({ block: true, reason: DENIED_REASON });
  expect(bed.asked.map((ask) => ask.answers)).toEqual([["deny", "session", "always", "once"]]);
});

it("never lets a grant cover a write outside the project or to a protected path", async () => {
  const bed = policyBed({ answers: [{ answer: "once", closed: false }, { answer: "once", closed: false }] });
  const input = { path: join(bed.cwd, ".git", "hooks", "pre-commit"), content: "x" };
  await bed.evaluate("write", input);
  expect(bed.asked[0]?.answers).toEqual(["deny", "once"]);
  bed.grantAlways("write", input); // as if an always rule existed for this exact payload
  await bed.evaluate("write", input);
  expect(bed.asked).toHaveLength(2);
});

it("offers no always answer for a tool it cannot classify", async () => {
  const bed = policyBed({ answers: [{ answer: "deny", closed: false }] });
  await bed.evaluate("mystery_tool", { x: 1 });
  expect(bed.asked[0]?.answers).toEqual(["deny", "session", "once"]);
});

it("keeps at most MAX_SESSION_GRANTS session grants, dropping the oldest", async () => {
  const bed = policyBed({ answers: Array.from({ length: MAX_SESSION_GRANTS + 2 }, () => ({ answer: "session" as const, closed: false })) });
  for (let i = 0; i <= MAX_SESSION_GRANTS; i++) await bed.evaluate("bash", { command: `echo ${i}` });
  await bed.evaluate("bash", { command: "echo 0" });
  expect(bed.asked).toHaveLength(MAX_SESSION_GRANTS + 2);
});
```

`apps/daemon/src/modules/policy/service.test.ts` (real database through `migrate` with `KERNEL_MIGRATIONS` and `POLICY_MIGRATIONS` in a temp dir, fake clock):

```ts
it("adds a rule once per exact call, lists it per owner and project, and refuses past 1000", () => {
  const { service } = setup();
  const rule = { ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "bash: npm test" };
  expect(service.addAlways(rule)).toBe("added");
  expect(service.addAlways(rule)).toBe("exists");
  expect(service.rulesFor("u1", "/w")).toEqual([{ tool: "bash", key: KEY }]);
  expect(service.rulesFor("u2", "/w")).toEqual([]);
  expect(service.rulesFor("u1", "/other")).toEqual([]);
  for (let i = 1; i < MAX_ALWAYS_RULES; i++) service.addAlways({ ...rule, key: i.toString(16).padStart(64, "0") });
  expect(service.addAlways({ ...rule, key: "f".repeat(64) })).toBe("full");
});

it("revokes only its owner's rule and tells the listeners which project changed", () => {
  const { service } = setup();
  const changes: string[] = [];
  service.onChange((owner, scope) => void changes.push(`${owner}:${scope}`));
  service.addAlways({ ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" });
  const [listed] = service.list("u1");
  expect(() => service.revoke("u2", listed?.id ?? "")).toThrow(new PapError("not_found"));
  service.revoke("u1", listed?.id ?? "");
  expect(service.rulesFor("u1", "/w")).toEqual([]);
  expect(changes).toEqual(["u1:/w", "u1:/w"]);
});
```

`sessions/service.test.ts`:

```ts
it("persists an always answer and pushes the project's rules to its other live workers only", async () => {
  const policy = fakePolicyPort();
  const bed = createServiceBed(factories, { policy });
  const first = await bed.service.create(bed.work, OWNER);
  const second = await bed.service.create(bed.work, OWNER);
  const elsewhere = await bed.service.create(bed.otherWork, OWNER);
  bed.spawned[0]?.emit({ type: "approval_request", id: "a1", category: "exec", title: "Run?", message: "bash: npm test", answers: ["deny", "session", "always", "once"], tool: "bash", key: KEY });
  await bed.clock.advance(0);
  bed.service.respondDialog({ sessionId: first.sessionId, dialogId: "a1", response: { answer: "always" } }, OWNER);
  expect(policy.added).toEqual([{ ownerId: OWNER.userId, scope: realpathSync(bed.work), tool: "bash", key: KEY, label: "bash: npm test" }]);
  const updates = (index: number) => bed.spawned[index]?.sent.filter((record) => record.type === "policy_update") ?? [];
  expect(updates(1)).toEqual([{ type: "policy_update", rules: { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [{ tool: "bash", key: KEY }] } }]);
  expect(updates(2)).toEqual([]);
  void second;
  void elsewhere;
  bed.dispose();
});

it("starts a worker with its project's always rules", async () => {
  const policy = fakePolicyPort([{ tool: "bash", key: KEY }]);
  const bed = createServiceBed(factories, { policy });
  await bed.service.create(bed.work, OWNER);
  const init = bed.spawned[0]?.sent.find((record) => record.type === "init");
  expect(init).toMatchObject({ policy: { alwaysAllow: [{ tool: "bash", key: KEY }] } });
  bed.dispose();
});
```

(`fakePolicyPort(initial?)` in `testing/service-bed.ts` records `addAlways` calls in `added`, returns `initial` from `rulesFor` (plus what was added), and calls its `onChange` listeners on add; the bed gains `otherWork`, a second temp folder.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host apps/daemon/src/modules`
Expected: FAIL.

- [ ] **Step 3: Implement the grants in pi-host**

`policy/extension.ts`:

```ts
export const MAX_SESSION_GRANTS = 1000;

/** The answers a card offers, in DESIGN.md order (Deny / Session / Always / Allow once). */
export function answersFor(category: ToolCategory, review: EditReview | undefined): ApprovalAnswer[] {
  // A write outside the project or to a protected path is judged one call at a time: no grant covers the next one.
  if (review) return ["deny", "once"];
  // A tool pap cannot classify may do anything: it is never remembered beyond this worker.
  if (category === "unknown") return ["deny", "session", "once"];
  return ["deny", "session", "always", "once"];
}

// createPapPolicyExtension: one grant set per policy instance (= per worker), insertion-ordered for eviction.
      const sessionGrants = new Set<string>();
      const remember = (key: string) => {
        sessionGrants.delete(key);
        sessionGrants.add(key);
        if (sessionGrants.size > MAX_SESSION_GRANTS) sessionGrants.delete(sessionGrants.values().next().value as string);
      };

// evaluateToolCall, after the `reviewable` check and before asking:
    const key = grantKey(event.toolName, grantPayload(event.input, category === "exec"));
    if (!review) {
      const grantedBy = deps.sessionGrants.has(key)
        ? "session rule"
        : rules.alwaysAllow.some((rule) => rule.tool === event.toolName && rule.key === key)
          ? "always rule"
          : null;
      if (grantedBy) {
        record("allow", grantedBy);
        return undefined;
      }
    }
    // … ask (Task 13) …
    if (outcome.answer === "session" || outcome.answer === "always") deps.remember(key);
```

`PolicyDeps` gains `sessionGrants: ReadonlySet<string>` and `remember(key): void`. Every path still ends in the M1 `catch` that fails closed.

- [ ] **Step 4: Implement the `policy` module**

`apps/daemon/src/modules/policy/migrations/202610110100_policy.sql`:

```sql
-- "Always" answers to approval cards (spec C §5.3): one row per owner, project and exact call. The grant key is the
-- sha256 of the tool name and the call's exact payload (pap-policy computes it); `label` is what the card showed,
-- cut to 4096 characters, for the list a user revokes from.
CREATE TABLE approval_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project')),
  scope TEXT NOT NULL,
  tool TEXT NOT NULL,
  grant_key TEXT NOT NULL CHECK (length(grant_key) = 64),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, scope_kind, scope, tool, grant_key)
) STRICT;

CREATE INDEX approval_rules_scope ON approval_rules(owner_id, scope_kind, scope);
```

`store.ts`:

```ts
import type { Db } from "../../kernel/db/database.ts";

export interface RuleRow {
  readonly id: string;
  readonly ownerId: string;
  readonly scope: string;
  readonly tool: string;
  readonly grantKey: string;
  readonly label: string;
  readonly createdAt: number;
}
const COLUMNS = "id, owner_id AS ownerId, scope, tool, grant_key AS grantKey, label, created_at AS createdAt";

export function createPolicyStore(db: Db) {
  return {
    /** False when the same owner already has this exact rule in this project. */
    insert: (row: RuleRow): boolean =>
      db.run(
        "INSERT OR IGNORE INTO approval_rules (id, owner_id, scope_kind, scope, tool, grant_key, label, created_at) VALUES ($id, $ownerId, 'project', $scope, $tool, $grantKey, $label, $createdAt)",
        { ...row },
      ).changes > 0,
    count: (ownerId: string, scope: string): number =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope", { ownerId, scope })?.n ?? 0,
    forScope: (ownerId: string, scope: string, limit: number): RuleRow[] =>
      db.all<RuleRow>(`SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope ORDER BY created_at, id LIMIT $limit`, { ownerId, scope, limit }),
    forOwner: (ownerId: string, limit: number): RuleRow[] =>
      db.all<RuleRow>(`SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId ORDER BY created_at DESC, id LIMIT $limit`, { ownerId, limit }),
    get: (ownerId: string, id: string): RuleRow | undefined =>
      db.get<RuleRow>(`SELECT ${COLUMNS} FROM approval_rules WHERE owner_id = $ownerId AND id = $id`, { ownerId, id }),
    remove: (ownerId: string, id: string): boolean =>
      db.run("DELETE FROM approval_rules WHERE owner_id = $ownerId AND id = $id", { ownerId, id }).changes > 0,
  };
}
export type PolicyStore = ReturnType<typeof createPolicyStore>;
```

`service.ts`:

```ts
import { type AlwaysRule, MAX_ALWAYS_RULES, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PolicyStore, RuleRow } from "./store.ts";

export interface PolicyPort {
  rulesFor(ownerId: string, scope: string): AlwaysRule[];
  addAlways(input: { ownerId: string; scope: string; tool: string; key: string; label: string }): "added" | "exists" | "full";
  onChange(listener: (ownerId: string, scope: string) => void): () => void;
}

export function createPolicyService(deps: { store: PolicyStore; clock: Clock; logger: Logger; newId(): string }) {
  const listeners = new Set<(ownerId: string, scope: string) => void>();
  // A failing listener (a worker that went away) must not stop the others nor fail the answer that caused the change.
  const changed = (ownerId: string, scope: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(ownerId, scope);
      } catch (error) {
        deps.logger.warn("policy_listener_failed", { err: error });
      }
    }
  };
  return {
    rulesFor: (ownerId: string, scope: string): AlwaysRule[] =>
      deps.store.forScope(ownerId, scope, MAX_ALWAYS_RULES).map((row) => ({ tool: row.tool, key: row.grantKey })),
    addAlways(input: { ownerId: string; scope: string; tool: string; key: string; label: string }) {
      // Check and insert run with no await between them: SQLite calls are synchronous here.
      if (deps.store.count(input.ownerId, input.scope) >= MAX_ALWAYS_RULES) {
        deps.logger.warn("approval_rules_full", { max: MAX_ALWAYS_RULES });
        return "full" as const;
      }
      const row: RuleRow = { id: deps.newId(), ownerId: input.ownerId, scope: input.scope, tool: input.tool, grantKey: input.key, label: input.label.slice(0, 4096), createdAt: deps.clock.now() };
      if (!deps.store.insert(row)) return "exists" as const;
      changed(input.ownerId, input.scope);
      return "added" as const;
    },
    list: (ownerId: string, scope?: string) =>
      (scope === undefined ? deps.store.forOwner(ownerId, MAX_ALWAYS_RULES) : deps.store.forScope(ownerId, scope, MAX_ALWAYS_RULES).toReversed()).map((row) => ({
        id: row.id,
        cwd: row.scope,
        tool: row.tool,
        label: row.label,
        createdAt: row.createdAt,
      })),
    revoke(ownerId: string, ruleId: string): void {
      const row = deps.store.get(ownerId, ruleId);
      if (!row || !deps.store.remove(ownerId, ruleId)) throw new PapError("not_found");
      changed(ownerId, row.scope);
    },
    onChange(listener: (ownerId: string, scope: string) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
```

`rpc.ts` maps `policy.listRules` (`service.list(ctx.caller.userId, cwd)`) and `policy.revokeRule` one line each; `index.ts` exports `POLICY_MIGRATIONS` and `createPolicyModule` returning `{ rpc, port: { rulesFor, addAlways, onChange } }`. `daemon.ts` adds `POLICY_MIGRATIONS` to the migration sources, builds the module before sessions, merges `policy.rpc` into the handler table and passes `policy: policy.port` to `createSessionsModule`.

`sessions/service.ts`:

```ts
  const policyFor = (row: SessionRow): PolicyRules => ({
    profile: "interactive",
    approvalMode: "auto-accept-edits",
    alwaysAllow: deps.policy.rulesFor(row.ownerId, row.cwd),
  });
  // A rule added or revoked reaches every worker of that owner and project, including one still starting.
  deps.policy.onChange((ownerId, scope) => {
    for (const session of [...live.values(), ...starting]) {
      const row = rowOf(session); // the row each LiveSession was launched for (kept beside it in launch())
      if (row.ownerId === ownerId && row.cwd === scope) session.send({ type: "policy_update", rules: policyFor(row) });
    }
  });
```

`launch()` uses `policy: policyFor(row)`. `respondDialog()`:

```ts
    respondDialog(input, caller) {
      const row = owned(input.sessionId, caller);
      const session = live.get(input.sessionId);
      if (!session) throw new PapError("not_found");
      const approved = session.answer(input.dialogId, input.response);
      if (approved?.answer !== "always") return;
      const added = deps.policy.addAlways({ ownerId: row.ownerId, scope: row.cwd, ...approved.grant });
      if (added === "full") {
        deps.hub.publish("session", row.id, { kind: "notice", level: "warning", text: "This project already has 1000 always-allowed calls: this one is allowed for the session only." });
      }
    },
```

`LiveSession` gains `send(record: DaemonToWorker): boolean` (the handle's). `testing/int-bed.ts` migrates `POLICY_MIGRATIONS` too, builds the policy module on the same database and exposes `bed.policyRpc` (its `rpc`).

- [ ] **Step 5: Write the integration test**

`sessions.grants.int.test.ts` (int bed; the script runs `bash: echo granted` in each of three runs: `{ steps: [call, { text: "1" }, call, { text: "2" }, call, { text: "3" }] }` where `call = { toolCalls: [{ name: "bash", args: { command: "echo granted" }, id: "c" }] }`; each worker starts its script from the first step, which this test accounts for by restarting only after full runs):

```ts
it("remembers an always answer for the project, across workers, until it is revoked", async () => {
  const call = { toolCalls: [{ name: "bash", args: { command: "echo granted" }, id: "c" }] };
  const bed = await createIntBed({ steps: [call, { text: "done" }, call, { text: "done again" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "first" }, bed.ctx);
    const ask = await sub.waitFor((event) => event.kind === "dialog_open");
    if (ask.kind !== "dialog_open") throw new Error("no card");
    expect(ask.dialog).toMatchObject({ method: "approval", category: "exec", answers: ["deny", "session", "always", "once"] });
    await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: ask.dialog.id, response: { answer: "always" } }, bed.ctx);
    await sub.waitFor((event) => event.kind === "status" && event.status === "idle");
    // A new worker on the same file starts with the rule: its run asks nothing.
    bed.killWorker(sessionId);
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold");
    const cards = () => sub.events().filter((event) => event.kind === "dialog_open").length;
    await promptAndSettle(bed, sub, sessionId, "second");
    expect(cards()).toBe(1);
    const { rules } = await bed.policyRpc["policy.listRules"]({ cwd: realpathSync(bed.work) }, bed.ctx);
    expect(rules).toEqual([expect.objectContaining({ tool: "bash", label: expect.stringContaining("echo granted") })]);
    await bed.policyRpc["policy.revokeRule"]({ ruleId: rules[0]?.id ?? "" }, bed.ctx);
    bed.killWorker(sessionId);
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold" && sub.events().filter((e) => e.kind === "status" && e.status === "cold").length === 2);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "third" }, bed.ctx);
    await vi.waitFor(() => expect(cards()).toBe(2), { timeout: 20_000 });
  } finally {
    await bed.dispose();
  }
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm test:unit && pnpm test:int`
Expected: PASS.

```bash
git add packages packages/contracts apps/daemon/src
git commit -m "feat(policy): session and always approvals, per-project rules pushed to workers"
```

---

### Task 15: pi-host custom panels and widget factories (S1)

References: S1 (`spikes/s1/host.ts`: `ctx.ui.custom()` over `custom_render` / `custom_input` / `custom_close`, the stray render after `done()`), pi-web `lib/rpc-manager.ts` (headless TUI of 92 × 40, widget factories rendered as lines on `requestRender`, components disposed on replacement), `lib/custom-ui-terminal.ts`.

**Risks / rulings needed:** Adds `@earendil-works/pi-tui` 1.1.0 to the catalog and to pi-host (lockfile change; see merge notes). Panels render at a fixed 92 columns (as S1 and pi-web); a resize protocol is not part of M2. Between this task and Task 16 the daemon ignores panel records, so an extension calling `ctx.ui.custom()` waits until Task 16 lands (the branch is not released in between).

**Files:**
- Create: `packages/pi-host/src/custom-panels.ts`, `custom-panels.test.ts`, `packages/pi-host/src/widget-components.ts`, `widget-components.test.ts`
- Modify: `packages/pi-host/src/{ui-bridge,host,dispatch}.ts`, `ui-bridge.test.ts`, `host.int.test.ts`, `packages/pi-host/package.json`, `pnpm-workspace.yaml` (catalog line), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 `custom_*` records, `UI_LIMITS`; Task 4 `send(): boolean`.
- Produces:
  - `createCustomPanels(send: (record: PanelOutbound) => boolean, deps: { newId(): string; theme: Theme; onError(event: string, error: unknown): void }): CustomPanels { open<T>(factory): Promise<T>; input(id, data): void; cancel(id): void; cancelAll(): void; count(): number }`, `PANEL_COLUMNS = 92`, `PANEL_ROWS = 40`.
  - Rules: the first render goes out when the factory's component exists; each `custom_input` (≤ `UI_LIMITS.panelInput` characters) goes to `handleInput` then re-renders; `requestRender()` re-renders; `done(value)` disposes the component, sends `custom_close` once and never renders again; a factory that resolves after the panel was cancelled has its component disposed at once; a throwing `render`, `handleInput` or factory closes the panel (resolving `undefined`) and reports through `onError` (→ an `extension_error` record); a render that cannot be sent closes the panel; lines are cut to `UI_LIMITS.panelLines` × `UI_LIMITS.panelLineChars` here, at the source.
  - `createWidgetComponents(send, deps)`: `set(key, factory, placement)` renders the factory's component at 92 columns as a `setWidget` record, re-renders on its `requestRender`, disposes the previous component of that key; `clear(key)`; `clearAll()`; lines cut to `UI_LIMITS.widgetLines` × `UI_LIMITS.widgetLineChars`. String-array widgets keep their M1 path (cut the same way).
  - `ui-bridge`: `custom: (factory) => panels.open(factory)`; `setWidget` routes functions to the widget components; `cancelAll()` also cancels panels and clears widget components. `dispatch`: `custom_input` → `panels.input`, `custom_cancel` → `panels.cancel`.

- [ ] **Step 1: Write the failing tests**

`custom-panels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createCustomPanels, PANEL_COLUMNS } from "./custom-panels.ts";
import { PLAIN_THEME } from "./plain-theme.ts";

function setup(sendOk = true) {
  const sent: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  let ids = 0;
  const panels = createCustomPanels((record) => { sent.push(record); return sendOk; }, { newId: () => `p${++ids}`, theme: PLAIN_THEME, onError: (event) => void errors.push(event) });
  return { sent, errors, panels };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const picker = (widths: number[]) => (_tui: unknown, _theme: unknown, _keys: unknown, done: (value: string) => void) => {
  let cursor = 0;
  const items = ["alpha", "beta"];
  return {
    render: (width: number) => { widths.push(width); return items.map((item, i) => `${i === cursor ? ">" : " "} ${item}`); },
    handleInput: (data: string) => { if (data === "\u001b[B") cursor = 1; else if (data === "\r") done(items[cursor] ?? ""); },
    invalidate: () => {},
  };
};

describe("custom panels", () => {
  it("renders, takes keys, closes once and never renders after done", async () => {
    const { sent, panels } = setup();
    const widths: number[] = [];
    const result = panels.open<string>(picker(widths) as never);
    await flush();
    panels.input("p1", "\u001b[B");
    panels.input("p1", "\r");
    expect(await result).toBe("beta");
    expect(sent).toEqual([
      { type: "custom_render", id: "p1", lines: ["> alpha", "  beta"] },
      { type: "custom_render", id: "p1", lines: ["  alpha", "> beta"] },
      { type: "custom_close", id: "p1" },
    ]);
    expect(widths).toEqual([PANEL_COLUMNS, PANEL_COLUMNS]);
    panels.input("p1", "x");
    expect(sent).toHaveLength(3);
    expect(panels.count()).toBe(0);
  });

  it("disposes a component whose factory resolves after the panel was cancelled", async () => {
    const { panels } = setup();
    let disposed = false;
    let finish: (component: unknown) => void = () => {};
    const result = panels.open(() => new Promise((resolve) => { finish = resolve; }) as never);
    panels.cancelAll();
    expect(await result).toBeUndefined();
    finish({ render: () => [], dispose: () => { disposed = true; } });
    await flush();
    expect(disposed).toBe(true);
  });

  it("closes a panel whose render throws or cannot be sent, and reports the throw", async () => {
    const throwing = setup();
    const result = throwing.panels.open((() => ({ render: () => { throw new Error("boom"); } })) as never);
    expect(await result).toBeUndefined();
    expect(throwing.errors).toEqual(["custom_render"]);
    const unsendable = setup(false);
    expect(await unsendable.panels.open((() => ({ render: () => ["x"] })) as never)).toBeUndefined();
  });

  it("cuts lines at the source", async () => {
    const { sent, panels } = setup();
    void panels.open((() => ({ render: () => Array.from({ length: 500 }, () => "y".repeat(2000)) })) as never);
    await flush();
    const lines = (sent[0] as { lines: string[] }).lines;
    expect(lines).toHaveLength(200);
    expect(lines[0]).toHaveLength(512);
  });
});
```

`widget-components.test.ts`: a factory widget sends `{ type: "extension_ui_request", method: "setWidget", widgetKey: "todo", widgetLines: ["- a"], widgetPlacement: "belowEditor" }` (with an id) at set; its `requestRender()` sends the new lines; setting the key again disposes the first component; `clear("todo")` disposes and sends `widgetLines: undefined`; a factory that throws reports through `onError` and sends nothing.

In `ui-bridge.test.ts`: `custom()` no longer resolves `undefined` at once (it opens a panel: a `custom_render` is sent); `cancelAll()` closes it with `custom_close`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host`
Expected: FAIL.

- [ ] **Step 3: Install pi-tui and implement**

Add `"@earendil-works/pi-tui": 1.1.0` to the `catalog:` of `pnpm-workspace.yaml`, then run `pnpm --filter @pap/pi-host add "@earendil-works/pi-tui@catalog:"` (already in the lockfile as a dependency of the SDK; no new build script, R36).

`custom-panels.ts` (the S1 bridge, hardened as the tests require): each panel registers in a `Map<id, { input(data); cancel() }>` **before** the factory runs, so a cancel during an async factory is seen; the factory is called through `Promise.resolve().then(() => factory(tui, theme, keybindings, done))` so a synchronous throw is caught like an async one; `tui = { terminal: { columns: PANEL_COLUMNS, rows: PANEL_ROWS, kittyProtocolActive: false }, requestRender: render }`; `keybindings = new KeybindingsManager(TUI_KEYBINDINGS)` from `@earendil-works/pi-tui` (the SDK's own manager is exported as a type only, S1); `render()` does nothing once closed or before the component exists, catches a throwing `render` (→ `onError("custom_render")`, `done(undefined)`), clips, and closes the panel when `send` returns false; `done()` is idempotent, deletes the entry, disposes the component inside `try` (→ `onError("custom_dispose")`), sends `custom_close`, resolves. `widget-components.ts` follows the same rules with `setWidget` records and no input.

`ui-bridge.ts`: `createUiBridge(send, options)` builds both (`theme: PLAIN_THEME`, `onError` → an `extension_error` record through `toExtensionErrorRecord` with `extensionPath: "pi-host:ui"`), `context.custom = (factory) => panels.open(factory)`, `setWidget` routes a function to `widgets.set`, an array or `undefined` to `widgets.clear(key)` then the M1 record (cut), and `UiBridge` gains `panelInput(id, data)` and `panelCancel(id)`; `cancelAll()` calls `panels.cancelAll()` and `widgets.clearAll()` after the dialogs. `dispatch.ts` adds the two cases.

- [ ] **Step 4: Write the integration test**

In `host.int.test.ts`, with an extension file `picker.js` in the agent directory whose `/pick` command opens the panel of the unit test and then calls `ctx.ui.notify(`picked:${choice}`, "info")`:

```ts
it("drives a custom panel over IPC and gets the prompt's answer only once it closed (R38)", async () => {
  writeExtension(bed.agentDir, "picker", PICKER_SOURCE);
  await bed.start({ steps: [{ text: "unused" }] });
  const host = bed.host();
  host.send({ type: "prompt", id: "p1", message: "/pick" });
  const first = await host.waitFor((r) => r.type === "custom_render");
  host.send({ type: "custom_input", id: first.id, data: "\u001b[B" });
  await host.waitFor((r) => r.type === "custom_render" && (r.lines as string[])[1] === "> beta");
  expect(host.records.some((r) => r.type === "response" && r.id === "p1")).toBe(false);
  host.send({ type: "custom_input", id: first.id, data: "\r" });
  await host.waitFor((r) => r.type === "custom_close" && r.id === first.id);
  await host.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && r.message === "picked:beta");
  expect(await host.waitFor((r) => r.type === "response" && r.id === "p1")).toMatchObject({ data: { disposition: "handled" } });
});
```

(`PICKER_SOURCE` and `writeExtension(agentDir, name, source)` live in `packages/pi-host/src/testing/extensions.ts`; Task 21 reuses the same sources through the daemon's int bed.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit packages/pi-host && pnpm test:int packages/pi-host && pnpm knip`
Expected: PASS.

```bash
git add packages/pi-host pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(pi-host): ctx.ui.custom panels and widget components over IPC"
```

---

### Task 16: Daemon decorations, panels and notices — status bar, widgets, title, editor text, recent notices in the snapshot

References: pi-web `docs/agents/sessions.md` "Extension status bar and command buttons" (statuses restored after a reload, `command:` keys), `lib/extension-widgets.ts`; Orca `rpc-dialog-callbacks.ts` (everything cancelled on stop / exit); roadmap line "recent notices in the snapshot so that start-up notices … reach a cursor-less subscriber".

**Risks / rulings needed:** A panel past the 4-open limit is cancelled (`custom_cancel`, the extension gets `undefined`) with a rate-limited notice. Panel renders are throttled to one publish per panel every 50 ms (latest wins). The notice ring keeps 20 notices of every source (pap and extensions).

**Files:**
- Create: `apps/daemon/src/modules/sessions/decorations.ts`, `decorations.test.ts`, `panels.ts`, `panels.test.ts`, `notices.ts`, `notices.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{dialogs,live-ui,live-session,service,service-reads,rpc}.ts`, `live-session.test.ts`, `service.pre-ready.test.ts`, `packages/contracts/src/methods.ts`
- Modify: `apps/web/src/stores/session-reducer.ts`; Create: `apps/web/src/stores/reduce-ui.ts`, `reduce-ui.test.ts`

**Interfaces:**
- Consumes: Task 1 stream kinds and `UI_LIMITS`; Task 15 panel records.
- Produces:
  - `createDecorations(): { apply(request: UiRequestRecord): SessionStreamEvent | null; statuses(): StatusEntry[]; widgets(): Widget[]; title(): string | null; clear(): void }` — `setStatus` (key 1..`statusKey` characters, text cut; `undefined` / non-string clears; a new key past `statuses` is dropped), `setWidget` (array of strings cut to the limits, `undefined` clears, placement `belowEditor` or else `aboveEditor`, a new key past `widgets` dropped), `setTitle` (cut), `set_editor_text` (→ `editor_text`, not stored), `notify` (→ `notice` with `notifyType` `warning` / `error` else `info`, text cut). Anything malformed → `null` (counted, logged once every 10 s).
  - `createPanels({ clock, publish, cancel(id), say(notice) }): { render(id, lines): void; close(id): void; has(id): boolean; list(): Panel[]; clear(): string[] }` with the limit and throttle above.
  - `createNoticeRing(max = UI_LIMITS.notices)`: `add(notice)`, `list()`.
  - The live session records every `notice` it publishes in the ring (start-up notices included, since they are published by the live session before the pre-ready buffer holds them); the snapshot carries `statuses`, `widgets`, `title`, `panels`, `notices`. Decoration methods are no longer forwarded as `pi` events. On worker exit every decoration and panel is cleared (clients clear theirs on `status: cold`).
  - `LiveSession.panelInput(id, data)`; method `sessions.panelInput { sessionId, panelId: string(1..128), data: string(1..4096) } → { ok: true }` — `sessions:operate`, **`idempotent: true`** (keystrokes: the client never retries them, and a receipt per keystroke would mean an fsync per key; reasoned exception to R65b), errors `not_found`.
  - Web (`reduce-ui.ts`): `SessionView.statuses`, `widgets`, `title`, `panels`, `editorText: { text; seq } | null` (seq increments per event so the composer applies each once); a `cold` status clears statuses, widgets, title and panels.

- [ ] **Step 1: Write the failing tests**

`decorations.test.ts`:

```ts
const req = (method: string, fields: Record<string, unknown> = {}) => ({ type: "extension_ui_request" as const, id: "x", method, ...fields });

describe("decorations", () => {
  it("rebuilds status, widget, title and editor-text events from the fields it knows, cut", () => {
    const d = createDecorations();
    expect(d.apply(req("setStatus", { statusKey: "command:/mode build", statusText: "Build" }))).toEqual({ kind: "status_bar", key: "command:/mode build", text: "Build" });
    expect(d.apply(req("setStatus", { statusKey: "git", statusText: "m".repeat(9000) }))).toEqual({ kind: "status_bar", key: "git", text: "m".repeat(UI_LIMITS.statusText) });
    expect(d.apply(req("setWidget", { widgetKey: "todo", widgetLines: ["- a", 7], widgetPlacement: "belowEditor" }))).toBeNull();
    expect(d.apply(req("setWidget", { widgetKey: "todo", widgetLines: ["- a"], widgetPlacement: "sideways" }))).toEqual({ kind: "widget", key: "todo", widget: { key: "todo", lines: ["- a"], placement: "aboveEditor" } });
    expect(d.apply(req("setTitle", { title: "pi - repo" }))).toEqual({ kind: "title", title: "pi - repo" });
    expect(d.apply(req("set_editor_text", { text: "prefill" }))).toEqual({ kind: "editor_text", text: "prefill" });
    expect(d.apply(req("notify", { message: "saved", notifyType: "loud" }))).toEqual({ kind: "notice", level: "info", text: "saved" });
    expect(d.statuses()).toEqual([{ key: "command:/mode build", text: "Build" }, { key: "git", text: "m".repeat(UI_LIMITS.statusText) }]);
  });

  it("clears a status or widget given no content, and drops new keys past the limits", () => {
    const d = createDecorations();
    for (let i = 0; i < UI_LIMITS.statuses; i++) d.apply(req("setStatus", { statusKey: `k${i}`, statusText: "x" }));
    expect(d.apply(req("setStatus", { statusKey: "one-too-many", statusText: "x" }))).toBeNull();
    expect(d.apply(req("setStatus", { statusKey: "k0" }))).toEqual({ kind: "status_bar", key: "k0", text: null });
    expect(d.statuses()).toHaveLength(UI_LIMITS.statuses - 1);
  });
});
```

`panels.test.ts` (fake clock): two renders of `p1` within 50 ms publish one `panel` event with the latest lines; a fifth open panel is cancelled through `cancel("p5")` and `say` gets one notice (a sixth within 10 s gets none); `close("p1")` publishes a pending render first, then `panel_closed`; lines are cut to the limits; `clear()` returns the open ids and leaves nothing pending (`clock.pending()` is 0).

`notices.test.ts`: the ring keeps the newest 20, texts cut to 2000 characters.

In `service.pre-ready.test.ts`:

```ts
it("hands start-up notices to a subscriber that has no cursor (roadmap: recent notices in the snapshot)", async () => {
  const bed = createServiceBed(factories, {
    start: () => ({ kind: "ready", before: [{ type: "extension_error", extensionPath: "/x.js", event: "session_start", error: "boom" }] }),
  });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const snapshot = await bed.snapshot(sessionId);
  expect(snapshot.notices).toEqual([{ level: "error", text: "An extension failed during session_start." }]);
  bed.dispose();
});
```

In `live-session.test.ts`: a `setStatus` request publishes `status_bar` and no `pi` event; the worker's exit clears `statuses()` and the open panels; `panelInput` on an unknown panel throws `not_found`, on an open one sends `{ type: "custom_input", id, data }`.

`reduce-ui.test.ts`: status bar set and clear; widget replace; `editor_text` increments `seq`; panel then `panel_closed`; a `cold` status clears all four.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions apps/web/src/stores`
Expected: FAIL.

- [ ] **Step 3: Implement**

`dialogs.ts`'s `DECORATION_METHODS` verdict stays `decoration`; `live-ui.ts` hands those requests to `decorations.apply()` and publishes the result (or counts a malformed one). `custom_render` / `custom_close` records go to `panels.render` / `panels.close`; `panels.cancel` sends `{ type: "custom_cancel", id }`. `live-session.ts` wraps its `publish`: `if (event.kind === "notice") notices.add({ level: event.level, text: event.text })` before publishing; its exit handler calls `decorations.clear()` and, for each id from `panels.clear()`, publishes `panel_closed`. `service-reads.ts` passes the five sections to `fitSnapshot`. `service.ts` / `rpc.ts` add `panelInput` (owned → live session → `panelInput`, `not_found` when the session is not live). Web: `reduce-ui.ts` holds the five cases and the `cold` rule; `session-reducer.ts` delegates to it and initialises the fields from the snapshot.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores
git commit -m "feat(sessions): status bar, widgets, panels and recent notices, bounded and in snapshots"
```

---
### Task 17: Session commands — navigate, compact, rename, auto-name; session names; activity

References: pi-web `docs/agents/sessions.md` "In-session branching waits for the run" (`navigateTree` refused while streaming or compacting), "Compaction SSE events", "Auto-retry banner"; `app/api/sessions/[id]/auto-name/route.ts` (naming on demand, a button, not automatic).

**Risks / rulings needed:** New error code `command_failed` ("The session could not complete this command.") for a worker that refused a command for a reason the daemon must not repeat (R66). A navigation publishes a fresh `snapshot` event into the stream (clients replace their view): accepted cost, at most one snapshot per navigation. Rename and auto-name of a cold session start its worker (single-writer rule: only a worker writes an existing Pi file). Names are cached in `sessions.name` (an index of Pi's `session_info`, refreshed from `ready` and `session_info_changed`).

**Files:**
- Create: `apps/daemon/src/modules/sessions/service-commands.ts`, `service.commands.test.ts`, `migrations/202610110000_session_name.sql`, `sessions.commands.int.test.ts`
- Modify: `packages/contracts/src/{errors,methods,streams}.ts` (+ tests), `apps/daemon/src/modules/sessions/{store,service,live-session,live-run,rpc,service-reads}.ts`, `store.test.ts`, `live-session.test.ts`, `testing/service-bed.ts` (option `replies`: per-command answers of the fake worker)
- Modify: `apps/web/src/stores/{session-reducer,reduce-ui}.ts`, tests, `apps/web/src/i18n/{en,fr}.ts` (`error.command_failed`), `apps/web/src/features/sessions/SessionListScreen.tsx` (shows the name when there is one)

**Interfaces:**
- Consumes: Task 2 commands, Task 3 `auto_name`, Task 10 `LiveSession.leafId()`, Task 11 reads.
- Produces:
  - Methods (all `sessions:operate`, mutations): `sessions.navigate { sessionId, targetId: string(1..128) } → { cancelled: boolean; editorText?: string }` (errors `not_found`, `session_busy`, `capacity`, `worker_failed`, `command_failed`); `sessions.compact { sessionId, customInstructions?: string(..4096) } → { tokensBefore: number; estimatedTokensAfter: number | null }` (same errors + `session_empty`); `sessions.rename { sessionId, name: string(1..256), trimmed non-empty } → { ok: true }` (`not_found`, `bad_request`, `capacity`, `worker_failed`, `command_failed`); `sessions.autoName { sessionId } → { name: string }` (`not_found`, `session_empty`, `timeout`, `capacity`, `worker_failed`, `command_failed`).
  - `SessionSummary.name: string | null`; `SessionRow.name`; `store.setName(id, name)`; the snapshot's `name`.
  - `LiveSession.activity(): Activity` and `{kind: "activity"}` events (`compaction_start` → compacting, `compaction_end` → not; `auto_retry_start {attempt, maxAttempts}` → retry; `auto_retry_end`, `agent_start` → `retry: null`); `LiveSession.commandsInFlight(): number` (navigate, compact, rename, auto-name, export in flight; read by Task 20).
  - `session_info_changed {name}` from the worker → `store.setName` + `{kind: "name"}` (never forwarded as a raw Pi event).
  - Busy rule: `navigate` and `compact` answer `session_busy` while the session is `running` or compacting, checked after `ensureLive` resolved and with no `await` before the record is sent.
  - Worker failures map: compact `"Nothing to compact"` (any case) → `session_empty`; auto-name `"nothing to name"` → `session_empty`; any other refusal → `command_failed` (worker text logged, clipped). A `timeout` on `autoName` is "outcome unknown" (R105).

- [ ] **Step 1: Write the failing tests**

`service.commands.test.ts` (service bed, whose fake worker answers commands from a per-test table):

```ts
it("refuses to navigate or compact while the session runs", async () => {
  const bed = createServiceBed(factories);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.emit(0, { type: "agent_start" });
  await expect(bed.service.navigate({ sessionId, targetId: "a0" }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  expect(bed.spawned[0]?.requests.map((request) => request.type)).toEqual([]);
  bed.dispose();
});

it("moves the leaf on navigate and publishes a fresh snapshot of the new branch", async () => {
  const bed = createServiceBed(factories, { replies: { navigate_tree: { data: { cancelled: false, leafId: "a0", editorText: "q1" } } } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.writePiFile(0, [["q0", "r0"], ["q1", "r1"]]);
  const frames = await bed.subscribe(sessionId);
  expect(await bed.service.navigate({ sessionId, targetId: "u1" }, OWNER)).toEqual({ cancelled: false, editorText: "q1" });
  const snapshot = frames.at(-1)?.event as SnapshotEvent;
  expect(snapshot.kind).toBe("snapshot");
  expect(snapshot.leafId).toBe("a0");
  expect(snapshot.rows.map((row) => row.entryId)).toEqual(["u0", "a0"]);
  bed.dispose();
});

it.each([
  ["compact", { success: false, error: "Nothing to compact (session too small)" }, "session_empty"],
  ["compact", { success: false, error: "No API key found for x." }, "command_failed"],
  ["auto_name", { success: false, error: "nothing to name" }, "session_empty"],
])("maps a refused %s to %s", async (command, reply, code) => {
  const bed = createServiceBed(factories, { replies: { [command]: reply } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const call = command === "compact" ? bed.service.compact({ sessionId }, OWNER) : bed.service.autoName(sessionId, OWNER);
  await expect(call).rejects.toThrow(new PapError(code as never));
  bed.dispose();
});

it("stores a name from rename and from Pi's session_info_changed, and lists it", async () => {
  const bed = createServiceBed(factories, { replies: { set_session_name: { data: undefined } } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  await bed.service.rename({ sessionId, name: "  Fix login  " }, OWNER);
  expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "set_session_name", name: "Fix login" });
  bed.emit(0, { type: "session_info_changed", name: "Fix the login bug" });
  expect(bed.service.list(OWNER)[0]?.name).toBe("Fix the login bug");
  bed.dispose();
});
```

In `live-session.test.ts`: `compaction_start` then `compaction_end` publish `activity` events `{compacting: true, retry: null}` then `{compacting: false, retry: null}`; `auto_retry_start {attempt: 2, maxAttempts: 3}` then `agent_start` publish `retry: {attempt: 2, maxAttempts: 3}` then `retry: null`; `session_info_changed` publishes `{kind: "name", name}` and no `pi` event.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`migrations/202610110000_session_name.sql`:

```sql
-- The name Pi keeps in the session file (`session_info`), cached for listings; refreshed from the worker.
ALTER TABLE sessions ADD COLUMN name TEXT CHECK (name IS NULL OR length(name) <= 256);
```

`service-commands.ts` exports `createSessionCommands(deps: { owned; ensureLive; live: ReadonlyMap<string, LiveSession>; reads; store; hub: Pick<StreamHub, "publish">; logger })` with `navigate`, `compact`, `rename`, `autoName`, each: `owned` → (busy check for navigate / compact when the session is live) → `await ensureLive(row)` → busy check again, synchronously → `session.command(...)` (a `LiveSession` method that counts the command in flight, sends the request with `requestTimeoutMs`, and returns the response). On a navigate success: `session.navigated(data.leafId)`, then `await reads.ensureReader()` and `hub.publish("session", row.id, reads.snapshot(row.id))`. The refusal mapping is one function, `refusalOf(command, error: string): ErrorCode`, with a test per row of the table above; the worker's text is logged clipped (`command_refused {command, error}`) and never returned. `store.ts` gains `name` in `COLUMNS` and `setName`; `service.ts` delegates the four commands and sets the name from `ready.sessionName` when it differs; `live-session.ts` handles `session_info_changed` (cut to `UI_LIMITS.name`, `onName(name)` callback the service binds to `store.setName` + publish) and the activity events; `rpc.ts` maps the methods one line each.

Web: `reduce-ui.ts` handles `name` and `activity`; `SessionListScreen` shows `session.name ?? session.cwd` as the link text and the cwd below it when there is a name.

- [ ] **Step 4: Write the integration test**

`sessions.commands.int.test.ts` (int bed):

```ts
it("edits from an earlier message: navigate, then the next prompt makes a sibling branch", async () => {
  const bed = await createIntBed({ steps: [{ text: "r0" }, { text: "r1" }, { text: "r1 again" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "q0");
    await promptAndSettle(bed, sub, sessionId, "q1");
    const userIds = sub.events().flatMap((event) => (event.kind === "entry" && event.entry.role === "user" ? [event.entry.id] : []));
    expect(await bed.rpc["sessions.navigate"]({ sessionId, targetId: userIds[1] ?? "" }, bed.ctx)).toEqual({ cancelled: false, editorText: "q1" });
    const snapshot = await sub.waitFor((event) => event.kind === "snapshot" && sub.events().indexOf(event) > 0);
    if (snapshot.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual(["user", "assistant"]);
    await promptAndSettle(bed, sub, sessionId, "q1 edited");
    const { points } = await bed.rpc["sessions.branches"]({ sessionId }, bed.ctx);
    expect(points).toHaveLength(1);
    expect(points[0]?.choices.map((choice) => [choice.preview, choice.onPath])).toEqual([["q1", false], ["q1 edited", true]]);
  } finally {
    await bed.dispose();
  }
});

it("compacts, shows the summary row live and keeps the history before it after a restart", async () => {
  const bed = await createIntBed({ steps: [{ text: "r0" }, { text: "r1" }, { text: "summary of r0 and r1" }] }, { settings: { compaction: { keepRecentTokens: 1 } } });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "q0");
    await promptAndSettle(bed, sub, sessionId, "q1");
    const result = await bed.rpc["sessions.compact"]({ sessionId }, bed.ctx);
    expect(result.tokensBefore).toBeGreaterThan(0);
    await sub.waitFor((event) => event.kind === "row" && (event.row.message as { role: string }).role === "compactionSummary");
    expect(sub.events().filter((event) => event.kind === "activity").map((event) => (event.kind === "activity" ? event.activity.compacting : null))).toEqual([true, false]);
    bed.killWorker(sessionId);
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant", "compactionSummary"]);
  } finally {
    await bed.dispose();
  }
});

it("renames and auto-names a session, and lists the name", async () => {
  const bed = await createIntBed({ steps: [{ text: "Looking at the form." }, { text: "Fix the login bug" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "the login button does nothing");
    expect(await bed.rpc["sessions.autoName"]({ sessionId }, bed.ctx)).toEqual({ name: "Fix the login bug" });
    await bed.rpc["sessions.rename"]({ sessionId, name: "Login fix" }, bed.ctx);
    await sub.waitFor((event) => event.kind === "name" && event.name === "Login fix");
    expect((await bed.rpc["sessions.list"]({}, bed.ctx)).sessions[0]?.name).toBe("Login fix");
  } finally {
    await bed.dispose();
  }
});
```

(`tokensBefore` comes from Pi's own estimate, so the test checks it is a positive number rather than a value Pi may change.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): navigate, compact, rename and auto-name; names and activity in snapshots"
```

---

### Task 18: HTML export — a download that never runs on the pap origin

The export is HTML Pi writes from model output: on the pap origin it would run inline script with the user's cookie. So it is only ever served as an attachment, under a sandbox CSP, `nosniff`, through a single-use token bound to the session and its owner. Spec C §4.5 lists the HTTP routes and has no export route: ADR 0006. pi-web post-processes the export to make its recursive tree helpers iterative (deep sessions); pap serves Pi's HTML as written (open question 7).

**Risks / rulings needed:** ADR 0006 (new route `GET /api/sessions/:sessionId/export/:token`) — controller confirms. Tokens live in memory: a daemon restart invalidates them (the user exports again). At most 16 exports pending, 10 minutes each. Exporting a cold session starts its worker.

**Files:**
- Create: `apps/daemon/src/modules/sessions/exports.ts`, `exports.test.ts`, `export-http.ts`, `export-http.test.ts`, `sessions.export.int.test.ts` (on the full daemon harness), `docs/adr/0006-session-export-download-route.md`
- Modify: `apps/daemon/src/kernel/http/app.ts` (route-owned CSP), `app.test.ts`, `apps/daemon/src/kernel/home.ts` (`exports/` 0700), `home.test.ts`, `apps/daemon/src/daemon.ts`, `apps/daemon/src/modules/sessions/{index,service-commands,rpc}.ts`, `packages/contracts/src/methods.ts`

**Interfaces:**
- Consumes: Task 2 `export_html`, Task 17 commands.
- Produces:
  - `createExports({ dir, clock, logger, newToken? }): { prepare(sessionId, ownerId): { token; path }; take(token, sessionId, ownerId): string | null; discard(token): void; purgeAll(): void; stop(): void }`, `EXPORT_TTL_MS = 600_000`, `MAX_PENDING_EXPORTS = 16` (`prepare` past it → `PapError("capacity")`); `newToken` default `randomBytes(32).toString("base64url")`; `take` deletes the entry and clears its timer before returning (single use, no await in between); expired entries delete their file.
  - Method `sessions.exportHtml { sessionId } → { url: string }` (`sessions:operate`, mutation, errors `not_found`, `capacity`, `timeout`, `worker_failed`, `command_failed`); `url = /api/sessions/<sessionId>/export/<token>`.
  - `mountExportRoute(app, { exports, authenticate(cookieHeader): { userId } | null, logger })`.
  - `HttpAppOptions` unchanged in shape; `app.ts` honours a route-owned CSP: a route that sets `c.set("ownCsp", value)` gets exactly that `Content-Security-Policy`.
  - `prepareHome` creates `$PAP_HOME/exports` (0700) and the daemon empties it at boot (`purgeAll`).

- [ ] **Step 1: Write the failing tests**

`export-http.test.ts` (a Hono app built with `createHttpApp` and the route; `exports` real, in a temp dir, fake clock):

```ts
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "pap-exports-"));
  const clock = createFakeClock();
  const exports = createExports({ dir, clock, logger: silentLogger });
  const app = createHttpApp({
    allowedOrigins: new Set(["http://localhost:7777"]),
    staticRoot: null,
    logger: silentLogger,
    mount: (hono) => mountExportRoute(hono, { exports, authenticate: (cookie) => (cookie === "pap_session=good" ? { userId: "u1" } : null), logger: silentLogger }),
    wsProbe: (c) => c.text("no"),
  });
  const ready = (sessionId = "s1", ownerId = "u1") => {
    const { token, path } = exports.prepare(sessionId, ownerId);
    writeFileSync(path, "<html><script>alert(1)</script></html>");
    return { token, path, url: `/api/sessions/${sessionId}/export/${token}` };
  };
  return { dir, clock, exports, app, ready, dispose: () => { exports.stop(); rmSync(dir, { recursive: true, force: true }); } };
};

it("answers as an attachment with a sandbox CSP and nosniff, once, then deletes the file", async () => {
  const t = setup();
  const { url, path } = t.ready();
  const reply = await t.app.request(url, { headers: { cookie: "pap_session=good" } });
  expect(reply.status).toBe(200);
  expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(reply.headers.get("content-disposition")).toBe('attachment; filename="pap-session.html"');
  expect(reply.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(await reply.text()).toBe("<html><script>alert(1)</script></html>");
  await vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 2000 });
  expect((await t.app.request(url, { headers: { cookie: "pap_session=good" } })).status).toBe(404);
  t.dispose();
});

it("refuses without a session (401), for another owner or session (404), and after it expired (404)", async () => {
  const t = setup();
  const first = t.ready();
  expect((await t.app.request(first.url)).status).toBe(401);
  const other = t.ready("s1", "u2");
  expect((await t.app.request(other.url, { headers: { cookie: "pap_session=good" } })).status).toBe(404);
  const wrongSession = t.ready("s1");
  expect((await t.app.request(wrongSession.url.replace("/s1/", "/s2/"), { headers: { cookie: "pap_session=good" } })).status).toBe(404);
  const late = t.ready();
  await t.clock.advance(EXPORT_TTL_MS);
  expect(existsSync(late.path)).toBe(false);
  expect((await t.app.request(late.url, { headers: { cookie: "pap_session=good" } })).status).toBe(404);
  t.dispose();
});

it("keeps every other route on the app's own CSP", async () => {
  const t = setup();
  expect((await t.app.request("/healthz")).headers.get("content-security-policy")).toContain("default-src 'self'");
  t.dispose();
});
```

`exports.test.ts`: `prepare` past `MAX_PENDING_EXPORTS` throws `capacity`; `take` with a wrong owner returns `null` **and leaves the entry usable for its owner**; `discard` removes the file; `purgeAll` empties the directory; `stop` deletes pending files and leaves no timer (`clock.pending()` 0); tokens are 43 base64url characters.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src`
Expected: FAIL.

- [ ] **Step 3: Implement**

`export-http.ts`:

```ts
import { createReadStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import type { Logger } from "../../kernel/logger.ts";
import type { Exports } from "./exports.ts";

/** What makes an exported transcript a file to save, never a page of the pap origin (ADR 0006). */
export const EXPORT_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-disposition": 'attachment; filename="pap-session.html"',
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};
export const EXPORT_CSP = "sandbox; default-src 'none'";

export function mountExportRoute(
  app: Hono,
  deps: { exports: Exports; authenticate(cookieHeader: string | undefined): { userId: string } | null; logger: Logger },
): void {
  app.get("/api/sessions/:sessionId/export/:token", (c) => {
    const caller = deps.authenticate(c.req.header("cookie"));
    if (!caller) return c.json({ error: { code: "unauthenticated" } }, 401);
    // Single use: the token is gone before the file is read, whatever happens next.
    const path = deps.exports.take(c.req.param("token"), c.req.param("sessionId"), caller.userId);
    if (!path) return c.json({ error: { code: "not_found" } }, 404);
    const stream = createReadStream(path);
    const remove = () => rmSync(path, { force: true });
    stream.once("close", remove);
    stream.once("error", (error: NodeJS.ErrnoException) => {
      deps.logger.warn("export_read_failed", { code: error.code ?? "unknown" });
      remove();
    });
    c.set("ownCsp", EXPORT_CSP);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: { ...EXPORT_HEADERS, "content-security-policy": EXPORT_CSP } });
  });
}
```

`app.ts`, registered first (so its post-`next` part runs after `secureHeaders` has set the global policy):

```ts
  // A route that answers with a policy of its own (the export download, ADR 0006) keeps it.
  app.use("*", async (c, next) => {
    await next();
    const own = c.get("ownCsp" as never) as string | undefined;
    if (own) c.res.headers.set("content-security-policy", own);
  });
```

(Declare `ownCsp` in Hono's `ContextVariableMap` instead of the cast if the project's Hono typing allows it.) `service-commands.ts` `exportHtml(sessionId, caller)`: owned → `await ensureLive(row)` → `exports.prepare(row.id, caller.userId)` → `session.command({ type: "export_html", outputPath: path })`; a refusal or a thrown error calls `exports.discard(token)` (the file may half exist) and rethrows / maps (`command_failed`); success returns `{ url }`. `daemon.ts`: builds `createExports({ dir: join(config.home, "exports"), clock, logger })`, calls `purgeAll()` at boot, mounts the route next to `auth.mount` with `authenticate: auth.authenticateCookieHeader` (it returns the caller or null; adapt to its real return shape), pushes `exports.stop()` on the closers list. `home.ts` adds `exports` to the 0700 directories.

`docs/adr/0006-session-export-download-route.md`:

```markdown
# ADR 0006 — exported transcripts are served by a download route

Status: accepted · Date: 2026-10-11 · Spec: C §4.5 (HTTP routes)

## Context
Pi's `export_html` writes one self-contained HTML file with inline script, built from the transcript: model output,
tool output, file contents. It can exceed a WebSocket frame (1 MiB). Served from the pap origin as a page, its script
would run with access to the session cookie's origin.

## Decision
`sessions.exportHtml` has the session's worker write the file under `$PAP_HOME/exports/<token>.html` and answers a URL
`GET /api/sessions/:sessionId/export/:token`. The route checks the session cookie (like every route), takes the token
(single use, bound to the session and its owner, 10 minutes, at most 16 pending, in memory only), streams the file with
`Content-Disposition: attachment`, `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options:
nosniff`, `Cache-Control: no-store`, and deletes it when the stream closes. Pending files are deleted at stop and at boot.

## Consequences
- A browser saves the file; opened from disk it runs as a local file, outside the pap origin.
- A token is useless without the owner's cookie, and a cross-site request carries no cookie (SameSite=Strict).
- A restart loses pending exports: the user exports again.
```

- [ ] **Step 4: Write the integration test**

`sessions.export.int.test.ts` (full daemon harness, real worker):

```ts
it("exports a session and serves it once as an attachment to its owner", async () => {
  const t = await startTestDaemon({ steps: [{ text: "exported reply" }] });
  try {
    const cookie = await t.login();
    const client = await t.connect(cookie);
    const { sessionId } = (await client.call("sessions.create", { cwd: t.cwd }, true)) as { sessionId: string };
    await client.call("subscribe.session", { sessionId });
    await client.call("sessions.prompt", { sessionId, text: "export me" }, true);
    await client.waitForEvent((event) => (event as { kind?: string; status?: string }).status === "idle");
    const { url } = (await client.call("sessions.exportHtml", { sessionId }, true)) as { url: string };
    const reply = await httpRequest(`${t.base}${url}`, { headers: { cookie } });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="pap-session.html"');
    expect(reply.body).toContain("exported reply");
    expect((await httpRequest(`${t.base}${url}`, { headers: { cookie } })).status).toBe(404);
  } finally {
    await t.stop();
  }
});
```

(`client.waitForEvent` exists in `testing/ws-client.ts` or is added there with an explicit timeout.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src docs/adr/0006-session-export-download-route.md
git commit -m "feat(sessions): export a transcript as a single-use, sandboxed download"
```

---

### Task 19: Fork and clone — new sessions from a branch, written by Pi's own session manager

Behaviour reference: pi-web `docs/agents/sessions.md` "Fork never touches the running AgentSession": a separate `SessionManager` opened on the source file and `createBranchedSession()` from it, so forking works while the source runs; the chat's fork cuts before a user message and hands its text to the composer; the sidebar's Fork copies the finished prefix of the current branch (allowed mid-run) and names the copy "<source title> · <4 hex>". pap's `clone` takes the sidebar Fork's semantics.

**Risks / rulings needed:** Clone mid-run copies the branch as written on disk (open question 10). The daemon writes the new Pi file itself (lazily loaded SDK, as the transcript reader): an exception to "only a worker writes Pi files" limited to new files nobody else holds (documented in `docs/agents/sessions.md`). A fork at the first user message creates a draft session (no file yet, Pi writes it with the first message). Pi's `session_before_fork` hooks do not run (no runtime is loaded), as in pi-web.

**Files:**
- Create: `apps/daemon/src/modules/sessions/pi-writer.ts`, `pi-writer.test.ts`, `forks.ts`, `forks.test.ts`, `sessions.forks.int.test.ts`
- Modify: `packages/contracts/src/methods.ts`, `apps/daemon/src/modules/sessions/{index,service,rpc,store}.ts`

**Interfaces:**
- Consumes: Task 10 `LiveSession.leafId()`, Task 17 `name`.
- Produces:
  - `loadPiWriter(): Promise<PiWriter>` (memoized `import()`, R108); `PiWriter { fork(sourceFile, entryId): { file: string | null; piSessionId: string | null; text: string }; clone(sourceFile, leafId: string | null, name: string | null): { file: string; piSessionId: string } }`; `ForkRefusal` errors `"not_a_user_message" | "empty" | "unreadable"`.
  - `cloneName(sourceTitle: string | null): string | null` — the title on one line, an earlier " · xxxx" suffix dropped, cut to 40 code points (ellipsis, never half a surrogate pair), then " · " + 4 random lowercase hex digits; `null` when the source has no title.
  - Methods: `sessions.fork { sessionId, entryId: string(1..128) } → { sessionId: string; text: string }`; `sessions.clone { sessionId } → { sessionId: string }`; both `sessions:operate`, mutations, errors `not_found`, `bad_request` (fork of a non-user entry), `session_empty`.
  - New rows: own pap id, `piPath`/`piSessionId` of the new file (checked with `isPiSessionFile`, else the file is deleted and `internal` is logged and thrown), the source's cwd, `name` (clone) — inserted cold; no worker starts.

- [ ] **Step 1: Write the failing tests**

`pi-writer.test.ts` (real SDK; temp `PI_CODING_AGENT_DIR`-like folder; files written with `sessionFileText` from the service bed helpers, imported by path):

```ts
it("forks before a user message: the new file holds the branch above it, the text comes back", async () => {
  const writer = await loadPiWriter();
  const source = writeSession(dir, [["q0", "r0"], ["q1", "r1"]]);
  const forked = writer.fork(source, "u1");
  expect(forked.text).toBe("q1");
  expect(forked.file).not.toBeNull();
  const roles = linesOf(forked.file ?? "").filter((line) => line.type === "message").map((line) => `${line.message.role}:${line.id}`);
  expect(roles).toEqual(["system:s0", "user:u0", "assistant:a0"]);
  expect(readFileSync(source, "utf8")).toBe(sessionFileText("pi-src", [["q0", "r0"], ["q1", "r1"]]));
});

it("forks at the first message as a draft, and refuses an entry that is not a user message", async () => {
  const writer = await loadPiWriter();
  const source = writeSession(dir, [["q0", "r0"]]);
  expect(writer.fork(source, "u0")).toEqual({ file: null, piSessionId: null, text: "q0" });
  expect(() => writer.fork(source, "a0")).toThrow(expect.objectContaining({ refusal: "not_a_user_message" }));
});

it("clones the branch at a leaf and names the copy, leaving the source untouched", async () => {
  const writer = await loadPiWriter();
  const source = writeSession(dir, [["q0", "r0"], ["q1", "r1"]]);
  const before = readFileSync(source, "utf8");
  const cloned = writer.clone(source, "a0", "Fix login · 3f9a");
  const entries = linesOf(cloned.file);
  expect(entries.filter((line) => line.type === "message").map((line) => line.id)).toEqual(["s0", "u0", "a0"]);
  expect(entries.at(-1)).toMatchObject({ type: "session_info", name: "Fix login · 3f9a" });
  expect(readFileSync(source, "utf8")).toBe(before);
  expect(() => writer.clone(writeSession(dir, []), null, null)).toThrow(expect.objectContaining({ refusal: "empty" }));
});
```

`forks.test.ts`:

```ts
it.each([
  [null, null],
  ["Fix login", /^Fix login · [0-9a-f]{4}$/],
  ["Fix login · 3f9a", /^Fix login · [0-9a-f]{4}$/],
  ["line one\nline two", /^line one line two · [0-9a-f]{4}$/],
  ["😀".repeat(50), /^(😀){39}… · [0-9a-f]{4}$/u],
])("names the clone of %j", (title, expected) => {
  const name = cloneName(title);
  if (expected === null) expect(name).toBeNull();
  else expect(name).toMatch(expected);
});
```

and a service-bed test: `sessions.fork` on a session whose file has `[["q0","r0"],["q1","r1"]]` returns a new session id whose row is bound to a new file, cold (`list` status `cold`), same cwd, and `text: "q1"`; `sessions.clone` of a source named "Fix login" lists a session named `Fix login · xxxx`; cloning a draft (no file) is `session_empty`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`pi-writer.ts`:

```ts
import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

export class ForkRefusal extends Error {
  readonly refusal: "not_a_user_message" | "empty" | "unreadable";
  constructor(refusal: ForkRefusal["refusal"]) {
    super(refusal);
    this.name = "ForkRefusal";
    this.refusal = refusal;
  }
}

export interface PiWriter {
  fork(sourceFile: string, entryId: string): { file: string | null; piSessionId: string | null; text: string };
  clone(sourceFile: string, leafId: string | null, name: string | null): { file: string; piSessionId: string };
}

type Sdk = { SessionManager: typeof PiSessionManager };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block) => ((block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [])).join("\n") : "";

// Pi writes a file only once a user or assistant message exists (S1): a branch without one is not worth a file.
const hasMessage = (manager: PiSessionManager, leafId: string): boolean =>
  manager.getBranch(leafId).some((entry) => entry.type === "message" && ["user", "assistant"].includes((entry.message as { role?: string }).role ?? ""));

function createPiWriter(sdk: Sdk): PiWriter {
  // A fresh manager per call: createBranchedSession() repoints the instance it runs on (pi-web's note).
  const open = (file: string): PiSessionManager => {
    try {
      return sdk.SessionManager.open(file);
    } catch {
      throw new ForkRefusal("unreadable");
    }
  };
  return {
    fork(sourceFile, entryId) {
      const manager = open(sourceFile);
      const entry = manager.getEntry(entryId);
      if (!entry || entry.type !== "message" || (entry.message as { role?: string }).role !== "user") throw new ForkRefusal("not_a_user_message");
      const text = textOf((entry.message as { content?: unknown }).content);
      if (!entry.parentId || !hasMessage(manager, entry.parentId)) return { file: null, piSessionId: null, text };
      const file = manager.createBranchedSession(entry.parentId);
      if (!file) throw new ForkRefusal("unreadable");
      return { file, piSessionId: manager.getSessionId(), text };
    },
    clone(sourceFile, leafId, name) {
      const manager = open(sourceFile);
      const leaf = (leafId && manager.getEntry(leafId) ? leafId : null) ?? manager.getLeafId();
      if (!leaf || !hasMessage(manager, leaf)) throw new ForkRefusal("empty");
      const file = manager.createBranchedSession(leaf);
      if (!file) throw new ForkRefusal("unreadable");
      if (name) manager.appendSessionInfo(name);
      return { file, piSessionId: manager.getSessionId() };
    },
  };
}

let loading: Promise<PiWriter> | undefined;
export function loadPiWriter(): Promise<PiWriter> {
  loading ??= import("@earendil-works/pi-coding-agent").then(createPiWriter, (error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
```

If `createBranchedSession` turns out not to write the file before a later append (the test reads it at once), call the SDK's flush the way pi-web's `persistSessionFile()` documents, and keep the test. `forks.ts`: `cloneName` and `createForks(deps: { store; newId; clock; agentDir; loadWriter; live; logger })` with `fork(row, entryId)` and `clone(row, session)`: the source file is `row.piPath` (a draft has none → `session_empty`), the clone's leaf is `session?.leafId()` (the writer falls back to the file's last entry when that entry is not on disk yet, which is how a clone mid-run copies the finished prefix); the result file must pass `isPiSessionFile(agentDir, file)` (else `rmSync(file, { force: true })`, log `fork_file_refused`, `PapError("internal")`); `ForkRefusal` maps to `bad_request` / `session_empty` / `internal`. The new row is inserted with `store.insert({ id, piPath, piSessionId, cwd: row.cwd, ownerId: row.ownerId, name, createdAt: now, updatedAt: now })`.

- [ ] **Step 4: Write the integration test**

`sessions.forks.int.test.ts` (int bed): after two exchanges, `sessions.fork({ entryId: <second user entry> })` returns `text: "q1"`; prompting the new session with the scripted model starts its worker on the forked file and its snapshot rows are `user q0, assistant r0, user <new prompt>, assistant …`; the source's snapshot is unchanged. `sessions.clone` of the source lists a cold session whose snapshot has the source's four rows.

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions
git commit -m "feat(sessions): fork before a message and clone a branch into new sessions"
```

---

### Task 20: Idle release after 30 minutes (spec C §2.1)

**Risks / rulings needed:** "Background work" is defined as: a run open, a dialog or panel open, Pi's queue not empty, a prompt or command in flight, or a compaction. Anything an extension does on its own timers is not visible and does not keep the worker. A navigation nobody continued is lost at release (ADR 0007; open question 11). A requested stop (release, daemon stop) shows `cold` without an error cause.

**Files:**
- Create: `apps/daemon/src/modules/sessions/idle-release.ts`, `idle-release.test.ts`, `sessions.release.int.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{live-session,live-run,service,index}.ts`, `live-session.test.ts`, `service.test.ts`, `testing/{live-bed,service-bed}.ts` (options `idleMs`, `holdShutdown`); `live-run.ts` exposes `promptsInFlight()`

**Interfaces:**
- Consumes: Task 4 `session_shutdown` on shutdown, Task 6 `Config.workerIdleMs`, Tasks 12/16/17 queue, panels, `commandsInFlight`.
- Produces:
  - `createIdleRelease({ clock, idleMs, isQuiet(): boolean, release(): void }): { touch(): void; stop(): void }` — `idleMs <= 0` disables it; the timer is (re)armed by `touch()`; at expiry a quiet session is released, a busy one re-armed.
  - `LiveSession`: touches on every worker record and every command; `quiet()` per the ruling line; `release()` publishes `{status: "releasing"}`, then stops the worker (the shutdown record; pi-host emits `session_shutdown`), and the exit publishes `{status: "cold"}` with no `cause` (also for `stop()` from `shutdownAll`); `exited(): Promise<void>`.
  - Service: `ensureLive()` on a session that is `releasing` waits for its exit, then launches a new worker on the same Pi file; a prompt never reaches a worker that is stopping.
  - `SessionsModuleDeps.config.workerIdleMs`.

- [ ] **Step 1: Write the failing tests**

`idle-release.test.ts`:

```ts
it("releases a quiet session after idleMs, and re-arms on activity or when busy", async () => {
  const clock = createFakeClock();
  let quiet = true;
  const released: number[] = [];
  const idle = createIdleRelease({ clock, idleMs: 1000, isQuiet: () => quiet, release: () => void released.push(clock.now()) });
  idle.touch();
  await clock.advance(600);
  idle.touch();
  await clock.advance(999);
  expect(released).toEqual([]);
  quiet = false;
  await clock.advance(1);
  expect(released).toEqual([]);
  quiet = true;
  await clock.advance(1000);
  expect(released).toHaveLength(1);
  idle.stop();
  expect(clock.pending()).toBe(0);
});

it("does nothing when disabled", async () => {
  const clock = createFakeClock();
  const idle = createIdleRelease({ clock, idleMs: 0, isQuiet: () => true, release: () => { throw new Error("released"); } });
  idle.touch();
  expect(clock.pending()).toBe(0);
});
```

`live-session.test.ts` (live bed with `idleMs: 30 * 60_000`):

```ts
it("releases after 30 idle minutes: releasing, then cold with no error cause", async () => {
  const { published, clock, worker } = setup({ idleMs: 30 * 60_000 });
  await clock.advance(30 * 60_000);
  expect(worker.sent.at(-1)).toMatchObject({ type: "shutdown" });
  expect(published.filter((event) => event.kind === "status")).toEqual([
    { kind: "status", status: "idle" },
    { kind: "status", status: "releasing" },
    { kind: "status", status: "cold" },
  ]);
});

it("never releases with a dialog open", async () => {
  const { clock, worker } = setup({ idleMs: 1000 });
  worker.emit(confirm);
  await clock.advance(5000);
  expect(worker.stopped()).toBe(false);
});
```

`service.test.ts`:

```ts
it("a prompt during releasing waits for the exit and reopens on the same file (Review Focus 5)", async () => {
  const bed = createServiceBed(factories, { idleMs: 1000, holdShutdown: true });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.writePiFile(0);
  await bed.clock.advance(1000);
  expect(bed.service.list(OWNER)[0]?.status).toBe("releasing");
  const prompted = bed.service.prompt({ sessionId, text: "again" }, OWNER);
  await bed.clock.advance(0);
  expect(bed.spawned[0]?.requests.filter((request) => request.type === "prompt")).toEqual([]);
  bed.spawned[0]?.crash({ code: 0, signal: null, cause: "clean" });
  expect(await prompted).toEqual({ disposition: "started" });
  expect(bed.spawned).toHaveLength(2);
  expect(bed.spawned[1]?.sent[0]).toMatchObject({ type: "init", sessionFile: bed.files[0] });
  bed.dispose();
});
```

(The beds gain `idleMs` and, for the service bed, `holdShutdown`: the fake worker records the shutdown but exits only when the test crashes it, as a real worker in its grace would.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`idle-release.ts`:

```ts
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export interface IdleRelease {
  touch(): void;
  stop(): void;
}

/** spec C §2.1: a worker idle for `idleMs` with nothing pending is released; its session goes cold, not away. */
export function createIdleRelease(deps: { clock: Clock; idleMs: number; isQuiet(): boolean; release(): void }): IdleRelease {
  let timer: TimerHandle | null = null;
  let stopped = false;
  const arm = (): void => {
    if (stopped || deps.idleMs <= 0) return;
    if (timer) deps.clock.clearTimeout(timer);
    timer = deps.clock.setTimeout(() => {
      timer = null;
      if (deps.isQuiet()) deps.release();
      else arm();
    }, deps.idleMs);
  };
  return {
    touch: arm,
    stop() {
      stopped = true;
      if (timer) deps.clock.clearTimeout(timer);
      timer = null;
    },
  };
}
```

`live-session.ts`: `let requestedStop = false;`; `idle = createIdleRelease({ clock, idleMs, isQuiet: quiet, release })`; `idle.touch()` at `ready`, in `onRecord` and at the start of every command method; `release()` sets `requestedStop = true`, publishes `releasing`, `idle.stop()`, and `void handle.stop()` (it always resolves; a `.catch` logs `worker_stop_failed` all the same); `stop()` sets `requestedStop` too; the exit handler calls `idle.stop()` and publishes `setStatus("cold", requestedStop && exit.cause !== "oom" ? undefined : describeExit(exit))`. `quiet()` is `status === "idle" && !run.tracker.running && ui.dialogs().length === 0 && panels.list().length === 0 && queue.view().count === 0 && run.promptsInFlight() === 0 && commandsInFlight === 0 && !activity.compacting`.

`service.ts` `ensureLive()`:

```ts
  async function ensureLive(row: SessionRow): Promise<LiveSession> {
    const current = live.get(row.id);
    if (current?.status() === "releasing") await current.exited();
    const still = live.get(row.id);
    if (still && still.status() !== "releasing") return still;
    // … M1 path: reuse a reopening promise, else launch(row, false) …
  }
```

(`onExit` removes the session from `live` before `exited()` resolves, so the second lookup is empty and a fresh worker is launched; two prompts arriving together share the same `reopening` promise as in M1.)

- [ ] **Step 4: Write the integration test**

`sessions.release.int.test.ts` (int bed with `workerIdleMs: 1500` and the shutdown-probe extension of Task 4):

```ts
it("releases an idle worker, tells its extensions, and the next prompt reopens the same file", async () => {
  const probe = join(tmpdir(), `pap-release-${process.pid}-${Date.now()}.txt`);
  const bed = await createIntBed({ steps: [{ text: "first" }, { text: "unused" }] }, { workerIdleMs: 1500, extensions: { probe: shutdownProbe(probe) } });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold", 10_000);
    const statuses = sub.events().flatMap((event) => (event.kind === "status" ? [event] : []));
    expect(statuses.slice(-2)).toEqual([{ kind: "status", status: "releasing" }, { kind: "status", status: "cold" }]);
    expect(readFileSync(probe, "utf8")).toBe("quit\n");
    const file = (await bed.rpc["sessions.list"]({}, bed.ctx)).sessions[0];
    expect(file?.status).toBe("cold");
    await promptAndSettle(bed, sub, sessionId, "again");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant"]);
  } finally {
    rmSync(probe, { force: true });
    await bed.dispose();
  }
});
```

(`shutdownProbe(path)` returns Task 4's extension source; it lives in `testing/extensions.ts` with the other fixture sources. The second worker starts its script from the first step, so its reply is "first" again: the test checks roles, not texts.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions
git commit -m "feat(sessions): release idle workers after 30 minutes"
```

---
### Task 21: D18 end to end — every extension UI surface against the real pi-host

The exit criterion "pi-web D18 behaviours reproduced with scripted-provider integration tests". Each case drives a fixture extension (plain `.js` in the temp agent directory) through the sessions module and the real worker, and checks what a client would receive.

**Risks / rulings needed:** None beyond earlier tasks. If one case shows a defect in Tasks 13–17, the fix goes in this task with a regression test, and the report names the task it belongs to.

**Files:**
- Create: `apps/daemon/src/modules/sessions/testing/extensions.ts` (fixture sources: `ASK_ALL`, `STATUS_BAR`, `WIDGETS`, `PICKER`, `EDITOR_TEXT`, `shutdownProbe(path)`; Task 15's pi-host copy of `PICKER` imports nothing from here — each package keeps its own fixtures), `apps/daemon/src/modules/sessions/sessions.d18.int.test.ts`

**Interfaces:**
- Consumes: Tasks 13–17 and 20; `createIntBed`.
- Produces: no production code.

- [ ] **Step 1: Write the fixture extensions**

`testing/extensions.ts` (each export is the source of one extension file; they use only `pi.registerCommand`, `pi.on` and `ctx.ui`, as a CLI extension would):

```ts
/** `/ask`: a select, an input, an editor and a confirm in a row, then one notice with the four answers. */
export const ASK_ALL = `export default function (pi) {
  pi.registerCommand("ask", { handler: async (_args, ctx) => {
    const picked = await ctx.ui.select("Pick one", ["a", "b"]);
    const typed = await ctx.ui.input("Type", "placeholder");
    const edited = await ctx.ui.editor("Edit", "draft text");
    const sure = await ctx.ui.confirm("Sure?", "really");
    ctx.ui.notify("answers:" + [picked, typed, edited, sure].join("|"), "info");
  } });
}
`;

/** A status with a command button, a plain status, and the command the button runs. */
export const STATUS_BAR = `export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("command:/hello", "Say hello");
    ctx.ui.setStatus("branch", "main");
  });
  pi.registerCommand("hello", { handler: async (_args, ctx) => ctx.ui.notify("hello from the status bar", "info") });
}
`;

/** A widget of lines above the editor, a component widget below it, and /tick to re-render the component. */
export const WIDGETS = `export default function (pi) {
  let ticks = 0;
  let render = () => {};
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("todo", ["- write tests", "- ship"]);
    ctx.ui.setWidget("ticker", (tui) => { render = () => tui.requestRender(); return { render: () => ["ticks: " + ticks], invalidate() {} }; }, { placement: "belowEditor" });
  });
  pi.registerCommand("tick", { handler: async () => { ticks += 1; render(); } });
}
`;

/** /pick: the S1 panel (alpha / beta, arrow down, enter), then a notice with the choice. */
export const PICKER = `export default function (pi) {
  pi.registerCommand("pick", { handler: async (_args, ctx) => {
    const choice = await ctx.ui.custom((_tui, _theme, _keys, done) => {
      const items = ["alpha", "beta"];
      let cursor = 0;
      return {
        render: (width) => items.map((item, i) => ((i === cursor ? "> " : "  ") + item).slice(0, width)),
        handleInput: (data) => { if (data === "\\u001b[B") cursor = 1; else if (data === "\\r") done(items[cursor]); },
        invalidate() {},
      };
    });
    ctx.ui.notify("picked:" + choice, "info");
  } });
}
`;

/** /fill: puts text in the composer, as the pi TUI's setEditorText does. */
export const EDITOR_TEXT = `export default function (pi) {
  pi.registerCommand("fill", { handler: async (_args, ctx) => ctx.ui.setEditorText("text from the extension") });
}
`;

export const shutdownProbe = (path: string) => `import { appendFileSync } from "node:fs";
export default function (pi) { pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(path)}, event.reason + "\\n")); }
`;
```

- [ ] **Step 2: Write the integration tests**

`sessions.d18.int.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createIntBed, type IntBed, type Subscription } from "./testing/int-bed.ts";
import { ASK_ALL, EDITOR_TEXT, PICKER, STATUS_BAR, WIDGETS } from "./testing/extensions.ts";

async function withSession(extensions: Record<string, string>, run: (bed: IntBed, sub: Subscription, sessionId: string) => Promise<void>) {
  const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    await run(bed, await bed.subscribe(sessionId), sessionId);
  } finally {
    await bed.dispose();
  }
}

const dialogOf = async (sub: Subscription, method: string) => {
  const event = await sub.waitFor((e) => e.kind === "dialog_open" && e.dialog.method === method);
  if (event.kind !== "dialog_open") throw new Error("no dialog");
  return event.dialog;
};

describe("extension UI end to end (D18)", () => {
  it("answers a select, an input, an editor and a confirm", async () => {
    await withSession({ ask: ASK_ALL }, async (bed, sub, sessionId) => {
      const prompted = bed.rpc["sessions.prompt"]({ sessionId, text: "/ask" }, bed.ctx);
      const select = await dialogOf(sub, "select");
      expect(select.options).toEqual(["a", "b"]);
      await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: select.id, response: { value: "b" } }, bed.ctx);
      const input = await dialogOf(sub, "input");
      expect(input.placeholder).toBe("placeholder");
      await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: input.id, response: { value: "typed" } }, bed.ctx);
      const editor = await dialogOf(sub, "editor");
      expect(editor.prefill).toBe("draft text");
      await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: editor.id, response: { value: "edited" } }, bed.ctx);
      const confirm = await dialogOf(sub, "confirm");
      await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: confirm.id, response: { confirmed: true } }, bed.ctx);
      await sub.waitFor((e) => e.kind === "notice" && e.text === "answers:b|typed|edited|true");
      expect(await prompted).toEqual({ disposition: "handled" });
    });
  });

  it("shows statuses after a reconnect and runs a status command", async () => {
    await withSession({ status: STATUS_BAR }, async (bed, sub, sessionId) => {
      await sub.waitFor((e) => e.kind === "status_bar" && e.key === "branch");
      const again = await bed.subscribe(sessionId);
      const snapshot = again.events()[0];
      if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
      expect(snapshot.statuses).toEqual([{ key: "command:/hello", text: "Say hello" }, { key: "branch", text: "main" }]);
      // What the status bar's button does in the client (Task 27): send the command as a prompt.
      expect(await bed.rpc["sessions.prompt"]({ sessionId, text: "/hello" }, bed.ctx)).toEqual({ disposition: "handled" });
      await sub.waitFor((e) => e.kind === "notice" && e.text === "hello from the status bar");
    });
  });

  it("shows a widget of lines and re-renders a component widget", async () => {
    await withSession({ widgets: WIDGETS }, async (bed, sub, sessionId) => {
      await sub.waitFor((e) => e.kind === "widget" && e.key === "todo" && e.widget?.lines.join() === "- write tests,- ship");
      await sub.waitFor((e) => e.kind === "widget" && e.key === "ticker" && e.widget?.placement === "belowEditor" && e.widget.lines[0] === "ticks: 0");
      await bed.rpc["sessions.prompt"]({ sessionId, text: "/tick" }, bed.ctx);
      await sub.waitFor((e) => e.kind === "widget" && e.key === "ticker" && e.widget?.lines[0] === "ticks: 1");
    });
  });

  it("drives a custom panel and keeps it in the snapshot while it is open", async () => {
    await withSession({ picker: PICKER }, async (bed, sub, sessionId) => {
      const prompted = bed.rpc["sessions.prompt"]({ sessionId, text: "/pick" }, bed.ctx);
      const opened = await sub.waitFor((e) => e.kind === "panel");
      if (opened.kind !== "panel") throw new Error("no panel");
      expect(opened.panel.lines).toEqual(["> alpha", "  beta"]);
      const again = await bed.subscribe(sessionId);
      const snapshot = again.events()[0];
      expect(snapshot?.kind === "snapshot" && snapshot.panels).toEqual([{ id: opened.panel.id, lines: ["> alpha", "  beta"] }]);
      await bed.rpc["sessions.panelInput"]({ sessionId, panelId: opened.panel.id, data: "\u001b[B" }, bed.ctx);
      await sub.waitFor((e) => e.kind === "panel" && e.panel.lines[1] === "> beta");
      await bed.rpc["sessions.panelInput"]({ sessionId, panelId: opened.panel.id, data: "\r" }, bed.ctx);
      await sub.waitFor((e) => e.kind === "panel_closed" && e.id === opened.panel.id);
      await sub.waitFor((e) => e.kind === "notice" && e.text === "picked:beta");
      expect(await prompted).toEqual({ disposition: "handled" });
    });
  });

  it("puts an extension's text in the composer", async () => {
    await withSession({ fill: EDITOR_TEXT }, async (bed, sub, sessionId) => {
      await bed.rpc["sessions.prompt"]({ sessionId, text: "/fill" }, bed.ctx);
      await sub.waitFor((e) => e.kind === "editor_text" && e.text === "text from the extension");
    });
  });
});
```

- [ ] **Step 3: Run and commit**

Run: `pnpm test:int apps/daemon/src/modules/sessions/sessions.d18.int.test.ts`
Expected: PASS (5 cases).

```bash
git add apps/daemon/src/modules/sessions
git commit -m "test(sessions): extension UI end to end against the real worker"
```

---

### Task 22: Crash containment — no extension or worker failure takes the daemon down

The second half of the M2 exit criterion and spec A success criterion 1, reproduced against the real worker: extensions that throw, kill their worker, flood dialogs or decorations, or hang on shutdown; a worker that exits mid-run; and, where a user manager answers, a worker killed by its memory limit.

**Risks / rulings needed:** The out-of-memory case runs only where `systemd-run --user` answers (skipped with a printed reason elsewhere, open question 8). The "hang on shutdown" case asserts the stop finishes within the kill ladder (2 s grace + 3 s SIGTERM wait + margin): its 8 s deadline is the ladder's, not a guess.

**Files:**
- Create: `apps/daemon/src/modules/sessions/sessions.crash.int.test.ts`; extend `testing/extensions.ts` with `THROWER`, `KILLER`, `FLOOD`, `HANGER`, `HOG`
- Modify: `apps/daemon/src/modules/sessions/testing/int-bed.ts` (option `scopes?: WorkerScopes`)

**Interfaces:**
- Consumes: everything above.
- Produces: no production code (a defect found here is fixed with a regression test in the task that owns the file, and named in the report).

- [ ] **Step 1: Write the fixtures**

```ts
/** Throws in session_start and in every tool_call handler: pap reports, Pi carries on. */
export const THROWER = `export default function (pi) {
  pi.on("session_start", () => { throw new Error("start failed"); });
  pi.on("tool_call", () => { throw new Error("tool_call failed"); });
}
`;
/** /die: kills its own worker with SIGKILL, as an OOM kill or a segfault would. */
export const KILLER = `export default function (pi) {
  pi.registerCommand("die", { handler: async () => { process.kill(process.pid, "SIGKILL"); } });
}
`;
/** /flood: 70 confirms at once and a widget of 10 000 long lines. */
export const FLOOD = `export default function (pi) {
  pi.registerCommand("flood", { handler: async (_args, ctx) => {
    ctx.ui.setWidget("huge", Array.from({ length: 10000 }, () => "w".repeat(5000)));
    await Promise.all(Array.from({ length: 70 }, (_, i) => ctx.ui.confirm("Q" + i, "?")));
  } });
}
`;
/** Never finishes its session_shutdown handler. */
export const HANGER = `export default function (pi) { pi.on("session_shutdown", () => new Promise(() => {})); }
`;
/** /hog: allocates until something stops it; stops itself at 1 GiB so a missing limit fails instead of eating the host. */
export const HOG = `export default function (pi) {
  pi.registerCommand("hog", { handler: async () => {
    const kept = [];
    while (kept.length < 64) { kept.push(Buffer.alloc(16 * 1024 * 1024, 1)); await new Promise((r) => setImmediate(r)); }
    process.exit(3);
  } });
}
`;
```

- [ ] **Step 2: Write the integration tests**

`sessions.crash.int.test.ts`:

```ts
describe("crash containment (spec A success criterion 1)", () => {
  it("reports extension failures as fixed notices and keeps the session working", async () => {
    const bed = await createIntBed({ steps: [{ toolCalls: [{ name: "read", args: { path: "a.txt" }, id: "c1" }] }, { text: "still here" }] }, { extensions: { thrower: THROWER } });
    try {
      writeFileSync(join(bed.work, "a.txt"), "content");
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const sub = await bed.subscribe(sessionId);
      const snapshot = sub.events()[0];
      expect(snapshot?.kind === "snapshot" && snapshot.notices).toEqual([{ level: "error", text: "An extension failed during session_start." }]);
      await promptAndSettle(bed, sub, sessionId, "read it");
      expect(sub.events().some((e) => e.kind === "notice" && e.text === "An extension failed during tool_call.")).toBe(true);
      expect(JSON.stringify(sub.events())).not.toContain("tool_call failed");
    } finally {
      await bed.dispose();
    }
  });

  it("a worker killed with a card, a panel and queued steers open: everything clears, the daemon and the other sessions carry on", async () => {
    const call = { toolCalls: [{ name: "bash", args: { command: "echo parked" }, id: "c1" }] };
    const bed = await createIntBed({ steps: [call, { text: "the other session works" }] }, { extensions: { killer: KILLER, picker: PICKER } });
    try {
      const doomed = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
      const other = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
      const sub = await bed.subscribe(doomed);
      void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "go" }, bed.ctx);
      const card = await sub.waitFor((e) => e.kind === "dialog_open");
      void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "/pick" }, bed.ctx).catch(() => undefined);
      const panel = await sub.waitFor((e) => e.kind === "panel");
      await bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "steer", streamingBehavior: "steer" }, bed.ctx);
      await sub.waitFor((e) => e.kind === "queue" && e.queue.count === 1);
      await expect(bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "/die" }, bed.ctx)).rejects.toMatchObject({ code: "worker_failed" });
      const cold = await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
      expect(cold).toEqual({ kind: "status", status: "cold", cause: "Agent process killed (SIGKILL), possibly out of memory." });
      if (card.kind !== "dialog_open" || panel.kind !== "panel") throw new Error("missing events");
      expect(sub.events()).toEqual(expect.arrayContaining([{ kind: "dialog_closed", id: card.dialog.id }, { kind: "panel_closed", id: panel.panel.id }]));
      const after = await bed.subscribe(doomed);
      const snapshot = after.events()[0];
      if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
      expect([snapshot.dialogs, snapshot.panels, snapshot.queue.count, snapshot.status]).toEqual([[], [], 0, "cold"]);
      // The other session's worker still answers commands (its script would ask an approval first, so a rename proves it).
      const otherSub = await bed.subscribe(other);
      await bed.rpc["sessions.rename"]({ sessionId: other, name: "Still alive" }, bed.ctx);
      await otherSub.waitFor((e) => e.kind === "name" && e.name === "Still alive");
      expect((await bed.rpc["sessions.list"]({}, bed.ctx)).sessions.map((s) => s.status).sort()).toEqual(["cold", "idle"]);
    } finally {
      await bed.dispose();
    }
  });

  it("caps a flood of dialogs and decorations", async () => {
    const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions: { flood: FLOOD } });
    try {
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const sub = await bed.subscribe(sessionId);
      void bed.rpc["sessions.prompt"]({ sessionId, text: "/flood" }, bed.ctx).catch(() => undefined);
      await vi.waitFor(() => expect(sub.events().filter((e) => e.kind === "dialog_open")).toHaveLength(64), { timeout: 20_000 });
      const widget = await sub.waitFor((e) => e.kind === "widget" && e.key === "huge");
      expect(widget.kind === "widget" && [widget.widget?.lines.length, widget.widget?.lines[0]?.length]).toEqual([UI_LIMITS.widgetLines, UI_LIMITS.widgetLineChars]);
      expect(sub.events().filter((e) => e.kind === "notice" && e.text.startsWith("An extension asked a question while too many were waiting"))).toHaveLength(1);
    } finally {
      await bed.dispose();
    }
  });

  it("stops a worker whose extension never finishes session_shutdown within the kill ladder", async () => {
    const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions: { hanger: HANGER } });
    try {
      await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const started = Date.now();
      await bed.sessions.shutdownAll();
      // shutdown grace 1.5 s, SIGTERM at 2 s; the 8 s bound is the whole ladder (2 + 3 + 3 s), not a guess.
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await bed.dispose();
    }
  });

  it.skipIf(!scopesAvailable)("says out of memory when the worker's scope limit kills it", async () => {
    const scopes = await realScopes({ memoryHighMb: 256, memoryMaxMb: 256, tasksMax: 512 });
    const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions: { hog: HOG }, scopes });
    try {
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const sub = await bed.subscribe(sessionId);
      void bed.rpc["sessions.prompt"]({ sessionId, text: "/hog" }, bed.ctx).catch(() => undefined);
      expect(await sub.waitFor((e) => e.kind === "status" && e.status === "cold", 30_000)).toEqual({ kind: "status", status: "cold", cause: "Agent process ran out of memory and was stopped." });
    } finally {
      await bed.dispose();
    }
  });
});
```

(`scopesAvailable` and `realScopes(limits)` come from a small helper beside the int bed that runs the same probe as Task 5's test. The "hang" case uses wall time because the ladder runs on the system clock in the int bed; the bound comes from the ladder constants. `.catch(() => undefined)` here is test code waiting on prompts that die with their worker, which the assertions that follow cover.)

- [ ] **Step 3: Run and commit**

Run: `pnpm test:int apps/daemon/src/modules/sessions/sessions.crash.int.test.ts`
Expected: PASS (the OOM case runs on this host).

```bash
git add apps/daemon/src/modules/sessions
git commit -m "test(sessions): extensions and workers that crash, flood or hang never take the daemon down"
```

---

### Task 23: R45 revisit and the two unmeasured budgets (idle worker RSS, session-open payload)

R45: "The 1.5× headroom is unvalidated against long real sessions — revisit in M2." `scripts/check-budgets.ts` prints "session open payload: not measured in M1" and "idle worker RSS: not measured in M1" (spec C §8.2 lists both budgets).

**Risks / rulings needed:** If the long session's RSS exceeds `WORKER_BUDGET_MB` (236), the plan raises it to `ceil(p95 × 1.25)` and recomputes `defaultMaxWorkers`; the controller confirms the new number with the owner before it lands (it lowers the default worker cap). The measurement runs on this host only (not in CI): 300 turns take a few minutes.

**Files:**
- Create: `scripts/measure-worker-rss.ts`, `docs/spikes/s4-m2-long-session.md`, `apps/daemon/src/modules/sessions/sessions.budgets.int.test.ts`
- Modify: `scripts/check-budgets.ts` (the two lines name the test that measures them), `apps/daemon/src/kernel/config.ts` and `config.test.ts` (only if the budget changes), `budgets.json` (only if the measured idle RSS shows the budget is wrong)

**Interfaces:**
- Consumes: pi-host test beds (`createHostBed`, network guard), the scripted provider, the int bed.
- Produces: a measured decision for R45; budget tests.

- [ ] **Step 1: Write the budget tests**

`sessions.budgets.int.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const budgets = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../budgets.json", import.meta.url)), "utf8")) as { sessionOpenPayloadKb: number; idleWorkerRssMb: number };

it("keeps an idle worker under its RSS budget", async () => {
  const bed = await createIntBed({ steps: [{ text: "unused" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    await vi.waitFor(() => expect(bed.sessions.inspect(sessionId)?.rssMb).not.toBeNull(), { timeout: 10_000 });
    expect(bed.sessions.inspect(sessionId)?.rssMb ?? Infinity).toBeLessThanOrEqual(budgets.idleWorkerRssMb);
  } finally {
    await bed.dispose();
  }
});

it("opens a ten-exchange session in a snapshot under the payload budget", async () => {
  const reply = "a reply of a usual length, ".repeat(8);
  const bed = await createIntBed({ steps: Array.from({ length: 10 }, () => ({ text: reply })) });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    for (let i = 0; i < 10; i++) await promptAndSettle(bed, sub, sessionId, `question ${i}: ${"q".repeat(150)}`);
    const opened = await bed.subscribe(sessionId);
    const bytes = Buffer.byteLength(JSON.stringify(opened.events()[0]));
    expect(bytes).toBeLessThanOrEqual(budgets.sessionOpenPayloadKb * 1024);
  } finally {
    await bed.dispose();
  }
});
```

(These are caps, so `toBeLessThanOrEqual(budget)` is the exact assertion: the budget is the value under test.)

- [ ] **Step 2: Measure a long session**

`scripts/measure-worker-rss.ts` (run by hand, never in CI): starts one worker through `createHostBed` with the network guard; the script has 300 turns, each `[{ toolCalls: [{ name: "read", args: { path: "big.txt" } }] }, { text: <2 KB> }]` over a 40 KB `big.txt`; it prompts 300 times, waiting for `agent_settled` each time with a 60 s deadline per turn; it samples the worker's RSS from `/proc/<pid>/status` (`VmRSS`) and PSS from `/proc/<pid>/smaps_rollup` after every 25 turns, prints JSON `{ turns, rssMb[], pssMb[] }` and exits non-zero if any turn times out. The bed is disposed in `finally`.

Run: `node --disable-warning=ExperimentalWarning --conditions=development scripts/measure-worker-rss.ts --turns 300 > /tmp/pap-rss.json`
Expected: JSON with 12 samples.

Write `docs/spikes/s4-m2-long-session.md` in the S4 note's shape (date, Node and Pi versions, method, table of samples, RSS vs PSS caveat, warm cache) and end it with exactly one of:
- `Decision: KEEP WORKER_BUDGET_MB = 236` (p95 RSS ≤ 236), or
- `Decision: RAISE WORKER_BUDGET_MB to <ceil(p95 × 1.25)>` — then update `WORKER_BUDGET_MB` and the `defaultMaxWorkers` test table in `config.test.ts` in this task.

- [ ] **Step 3: Run and commit**

Run: `pnpm test:int apps/daemon/src/modules/sessions/sessions.budgets.int.test.ts && pnpm budgets`
Expected: PASS; `pnpm budgets` prints the two lines naming `sessions.budgets.int.test.ts`.

```bash
git add scripts docs/spikes/s4-m2-long-session.md apps/daemon/src budgets.json
git commit -m "test(budgets): idle worker RSS and session-open payload; R45 long-session measurement"
```

---
### Task 24: Web composer — drafts, steer / follow-up, the queue strip, Stop, "Send again" with the same command id

References: pi-web `ChatInput` (while streaming: Steer and Follow up buttons, Enter steers, Alt+Enter follows up; queued messages above the composer, steer orange, follow-up dim), `lib/draft-store.ts` (restored text merged as `submitted + "\n\n" + current`); Pi `docs/rpc-commands.md` (Stop = `clear_queue` then `abort`, cleared text back in the editor); T3 Code `composer.md` (queued messages above the composer); R124 (exactly-once retry of the same intent).

**Risks / rulings needed:** Drafts are kept per session in `localStorage` (`pap.draft.<sessionId>`, ≤ 200 000 characters), so they survive a reload (pi-web kept them in memory only). The streaming preference is per device, default `steer` as pi-web. An extension's `set_editor_text` and "Edit from here" replace the composer's text as the pi TUI does (open question 12). Keyboard bindings beyond the submit shortcut of `TextField` are M3's.

**Files:**
- Create: `apps/web/src/features/sessions/{Composer,QueueStrip}.tsx`, `composer.vm.ts`, `composer.vm.test.ts`, `drafts.ts`, `drafts.test.ts`, `Composer.test.tsx`
- Modify: `apps/web/src/runtime/rpc.ts`, `rpc.test.ts`, `apps/web/src/testing/runtime-bed.ts` (records `options`, has `newCommandId`), `apps/web/src/features/sessions/SessionScreen.tsx` (layout: header, transcript, dialogs, composer), `SessionScreen.test.tsx`, `apps/web/src/i18n/{en,fr}.ts` (`sessions.composer.*`, `sessions.queue.*`)

**Interfaces:**
- Consumes: Task 12 `QueueView` and `sessions.clearQueue`; Task 16 `SessionView.editorText`; Task 17 `navigate` editor text (reaches the composer through Task 28).
- Produces:
  - `RpcClient.call(method, params, options?: { commandId?: string })` and `RpcClient.newCommandId(): string`: a mutation sends `options.commandId` when given, a fresh one otherwise; reads ignore it.
  - `drafts.ts`: `MAX_DRAFT_CHARS = 200_000`, `loadDraft(storage, sessionId)`, `saveDraft(storage, sessionId, text)` (empty → removed; storage errors such as quota are logged once with `console.warn` and otherwise ignored, the composer keeps working), `mergeRestored(submitted, current)`.
  - `composer.vm.ts`: `Behavior = "steer" | "followUp"`, `loadBehavior(storage)` / `saveBehavior(storage, behavior)`, `planSend(text, behavior): { text: string; streamingBehavior: Behavior } | null`, `restoreCleared(cleared, current): string`, `PendingSend { params; commandId }`.
  - `<Composer sessionId view />`: idle → Send; running → Steer, Follow up (the preferred one primary) and Stop; a send whose outcome is unknown (`timeout`, `connection_lost`) keeps the message out of the draft and shows "Send again" (same `commandId` and params) and "Edit" (text back in the draft, pending forgotten); any other failure restores the text into the draft with the error; Stop calls `clearQueue` then `abort` and merges the cleared texts into the draft; a new `view.editorText.seq` replaces the text. `<QueueStrip queue onClear />`.
  - Exported actions for M3's keybindings: `stopSession(runtime, sessionId): Promise<string[]>` (returns the restored texts) in `composer.vm.ts`.

- [ ] **Step 1: Write the failing tests**

`drafts.test.ts`:

```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDraft, MAX_DRAFT_CHARS, mergeRestored, saveDraft } from "./drafts.ts";

beforeEach(() => localStorage.clear());

describe("drafts", () => {
  it("keeps one draft per session, removes an empty one and caps its size", () => {
    saveDraft(localStorage, "s1", "hello");
    saveDraft(localStorage, "s2", "other");
    expect(loadDraft(localStorage, "s1")).toBe("hello");
    saveDraft(localStorage, "s1", "");
    expect(localStorage.getItem("pap.draft.s1")).toBeNull();
    saveDraft(localStorage, "s1", "x".repeat(MAX_DRAFT_CHARS + 10));
    expect(loadDraft(localStorage, "s1")).toHaveLength(MAX_DRAFT_CHARS);
  });

  it("keeps working when storage refuses, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const full = { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} } as unknown as Storage;
    saveDraft(full, "s1", "a");
    saveDraft(full, "s1", "b");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("puts restored text before what is being typed", () => {
    expect(mergeRestored("sent", "")).toBe("sent");
    expect(mergeRestored("", "typing")).toBe("typing");
    expect(mergeRestored("sent", "typing")).toBe("sent\n\ntyping");
  });
});
```

`composer.vm.test.ts`:

```ts
it("plans a send with the preferred behaviour, nothing for blank text", () => {
  expect(planSend("  go  ", "followUp")).toEqual({ text: "go", streamingBehavior: "followUp" });
  expect(planSend(" \n ", "steer")).toBeNull();
});
it("defaults to steer and remembers the choice per device", () => {
  expect(loadBehavior(localStorage)).toBe("steer");
  saveBehavior(localStorage, "followUp");
  expect(loadBehavior(localStorage)).toBe("followUp");
  localStorage.setItem("pap.sessions.streaming", "nonsense");
  expect(loadBehavior(localStorage)).toBe("steer");
});
it("restores cleared steering and follow-ups before the current text", () => {
  expect(restoreCleared({ steering: ["left"], followUp: ["then"] }, "now")).toBe("left\n\nthen\n\nnow");
});
```

`Composer.test.tsx` (happy-dom, `fakeRuntime`, the `getRuntime` mock of `SessionScreen.test.tsx`):

```ts
it("restores the draft, sends with the preference and clears the draft once accepted", async () => {
  localStorage.setItem("pap.draft.sess-1", "half a thought");
  const page = await show({ status: "idle" });
  expect(field(page, "Message").value).toBe("half a thought");
  await click(button(page, "Send"));
  await settle();
  expect(bed.called("sessions.prompt")).toEqual([{ method: "sessions.prompt", params: { sessionId: "sess-1", text: "half a thought", streamingBehavior: "steer" }, options: { commandId: expect.any(String) } }]);
  expect(localStorage.getItem("pap.draft.sess-1")).toBeNull();
});

it("offers Send again with the same command id after an unknown outcome, and Edit puts the text back", async () => {
  bed.handlers["sessions.prompt"] = () => { throw new RpcError("connection_lost"); };
  const page = await show({ status: "idle" });
  await typeInto(field(page, "Message"), "deploy");
  await click(button(page, "Send"));
  await settle();
  expect(field(page, "Message").value).toBe("");
  expect(text(page)).toContain("The message may have been sent.");
  bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
  await click(button(page, "Send again"));
  await settle();
  const [first, second] = bed.called("sessions.prompt");
  expect(second?.options?.commandId).toBe(first?.options?.commandId);
  expect(second?.params).toEqual(first?.params);
  expect(hasButton(page, "Send again")).toBe(false);
});

it("puts the text back with the error when the prompt is refused", async () => {
  bed.handlers["sessions.prompt"] = () => { throw new RpcError("queue_full"); };
  const page = await show({ status: "running" });
  await typeInto(field(page, "Message"), "one more");
  await click(button(page, "Steer"));
  await settle();
  expect(field(page, "Message").value).toBe("one more");
  expect(alerts(page)).toContain("Too many messages are waiting in this session. Wait for the agent, or clear the queue.");
});

it("Stop clears the queue, aborts, and puts the cleared texts in the draft", async () => {
  bed.handlers["sessions.clearQueue"] = () => ({ steering: ["left"], followUp: ["then"], truncated: false });
  const page = await show({ status: "running", queue: { steering: ["left"], followUp: ["then"], count: 2, bytes: 8 } });
  expect(text(page)).toContain("Waiting · 2");
  await click(button(page, "Stop"));
  await settle();
  expect(bed.calls.map((call) => call.method).filter((m) => m !== "subscribe.session")).toEqual(["sessions.clearQueue", "sessions.abort"]);
  expect(field(page, "Message").value).toBe("left\n\nthen");
});

it("replaces the text when an extension sets it", async () => {
  const page = await show({ status: "idle" });
  await typeInto(field(page, "Message"), "mine");
  await emit({ kind: "editor_text", text: "from the extension" });
  expect(field(page, "Message").value).toBe("from the extension");
});
```

(`show(viewPatch)` emits a snapshot built from `viewPatch` and renders `<SessionScreen sessionId="sess-1" />`; `bed.called` returns entries with `options` once `runtime-bed.ts` records them.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src`
Expected: FAIL.

- [ ] **Step 3: Implement**

`drafts.ts`:

```ts
export const MAX_DRAFT_CHARS = 200_000;
const keyOf = (sessionId: string) => `pap.draft.${sessionId}`;
let warned = false;

export function loadDraft(storage: Storage | null, sessionId: string): string {
  try {
    return storage?.getItem(keyOf(sessionId))?.slice(0, MAX_DRAFT_CHARS) ?? "";
  } catch {
    return "";
  }
}

/** A draft is a convenience: storage that refuses (quota, private mode) is said once and the composer goes on. */
export function saveDraft(storage: Storage | null, sessionId: string, text: string): void {
  try {
    if (text === "") storage?.removeItem(keyOf(sessionId));
    else storage?.setItem(keyOf(sessionId), text.slice(0, MAX_DRAFT_CHARS));
  } catch (error) {
    if (!warned) console.warn("pap: drafts cannot be saved in this browser", error);
    warned = true;
  }
}

export function mergeRestored(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}
```

`composer.vm.ts`:

```ts
import type { ParamsOf } from "@pap/contracts";
import type { Runtime } from "../../runtime/index.ts";
import { mergeRestored } from "./drafts.ts";

export type Behavior = "steer" | "followUp";
const BEHAVIOR_KEY = "pap.sessions.streaming";

export function loadBehavior(storage: Storage | null): Behavior {
  try {
    return storage?.getItem(BEHAVIOR_KEY) === "followUp" ? "followUp" : "steer";
  } catch {
    return "steer";
  }
}
export function saveBehavior(storage: Storage | null, behavior: Behavior): void {
  try {
    storage?.setItem(BEHAVIOR_KEY, behavior);
  } catch {
    // The choice simply lasts this page; drafts already warned about storage.
  }
}

/** Pi ignores the streaming behaviour when it is idle (pinned in Task 12), so it is always sent. */
export function planSend(text: string, behavior: Behavior): { text: string; streamingBehavior: Behavior } | null {
  const trimmed = text.trim();
  return trimmed ? { text: trimmed, streamingBehavior: behavior } : null;
}

export function restoreCleared(cleared: { steering: readonly string[]; followUp: readonly string[] }, current: string): string {
  return mergeRestored([...cleared.steering, ...cleared.followUp].join("\n\n"), current);
}

export interface PendingSend {
  readonly params: ParamsOf<"sessions.prompt">;
  readonly commandId: string;
}

/** Stop as the pi TUI's Esc: what waits in the queue comes back to the composer, then the run stops. */
export async function stopSession(runtime: Runtime, sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
  const cleared = await runtime.rpc.call("sessions.clearQueue", { sessionId });
  await runtime.rpc.call("sessions.abort", { sessionId });
  return cleared;
}
```

`Composer.tsx`: state `text` (initialised from `loadDraft(localStorage, sessionId)`), `behavior` (from `loadBehavior`), `pending: PendingSend | null`, `error: string | null`; every text change goes through `setText` + `saveDraft`. `send(behaviorOverride?)`: `planSend` → `commandId = runtime.rpc.newCommandId()` → clear text and draft → `runtime.rpc.call("sessions.prompt", params, { commandId })`; on failure, `outcomeUnknown(failure)` (from `failure.ts`) sets `pending`, otherwise the text is merged back with `mergeRestored` and `error = failureText(failure)`. "Send again" calls with `pending.params` and `pending.commandId`, clearing `pending` on success. Stop calls `stopSession` and merges with `restoreCleared`; its failure shows the error and restores nothing more. An effect keyed on `view.editorText?.seq` sets the text. The buttons are `@pap/ui` `Button`s; the field is `TextField` with `onSubmitShortcut={() => send()}`; the "When working" choice is two `Button`s with `aria-pressed`. `QueueStrip.tsx` renders the counts and previews (steering in `text-human-text`, follow-ups in `text-muted`) and a Clear button that calls `clearQueue` and hands the texts to the composer through a prop. `SessionScreen.tsx` becomes a layout: header, the M1 transcript list (until Task 25), the dialogs (until Task 26), then `<Composer>`.

i18n (`sessions.*` block): `composer.send` "Send", `composer.steer` "Steer", `composer.followUp` "Follow up", `composer.stop` "Stop", `composer.whenWorking` "While the agent works", `composer.mayHaveBeenSent` "The message may have been sent.", `composer.sendAgain` "Send again", `composer.edit` "Edit", `queue.title` "Waiting · {count}", `queue.clear` "Clear", `queue.steer` "Steer", `queue.followUp` "Follow-up"; fr: "Envoyer", "Orienter", "À la suite", "Arrêter", "Pendant que l'agent travaille", "Le message a peut-être été envoyé.", "Renvoyer", "Modifier", "En attente · {count}", "Vider", "Orientation", "À la suite". (Task 1's placeholder `sessions.queue.title` becomes this key.)

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): composer with drafts, steer and follow-up, queue strip and exactly-once resend"
```

---

### Task 25: Web transcript — rows, thinking, tool rows with output on demand, summaries, older history

References: DESIGN.md §9 (Message, ToolCard: name in mono uppercase agent colour, argument summary, output body, running state; compaction summary), pi-web `CompactionMessageView` (collapsed by default, "Compacted from N tokens"), `ChatWindow` "Loading older history" (sentinel above the rows, the scroll position kept when a page lands), T3 Code (tool output fetched on demand).

**Risks / rulings needed:** Plain text only (markdown is M3's Message work); thinking and summaries use native `<details>`; no virtualization (deferred). The transcript renders at most the loaded rows (75 + pages the user asked for).

**Files:**
- Create: `apps/web/src/features/sessions/{Transcript,MessageRow,ToolRow}.tsx`, `Transcript.test.tsx`, `ToolRow.test.tsx`
- Modify: `apps/web/src/features/sessions/transcript.vm.ts`, `transcript.vm.test.ts`, `use-stick-to-bottom.ts`, `SessionScreen.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Tasks 9–11 and 17 view fields (`messages`, `partial`, `tools`, `history`, `activity`), `sessions.history`, `sessions.toolOutput`, `prependHistory`.
- Produces:
  - `transcriptItems(view): TranscriptItem[]` with kinds `message` (`author`, `text`, `thinking`, `entryId`), `tool` (`toolCallId`, `name`, `summary`, `status: "running" | "done" | "failed" | "waiting"`, `preview`, `truncatedChars`, `argsTruncated`), `summary` (`compaction` with `tokensBefore`, or `branch`), `failure`, `partial` (text and thinking blocks), each with a unique `key` (entry id, tool call id, or the M1 ref with its counter).
  - `<Transcript sessionId view />`: a "Load older messages" button at the top while `view.history.hasMore` (also triggered by an `IntersectionObserver` sentinel), calling `sessions.history({ before: view.history.oldestEntryId })` and `prependHistory`; the scroll position stays on the same row when older rows land; it sticks to the bottom while the reader is at the bottom. A failed page shows the error text and keeps the button.
  - `<ToolRow item sessionId />`: "Show the whole output (N KB)" when `truncatedChars` is set, calling `sessions.toolOutput` once and showing the text in a scrollable `<pre>`; a `not_found` says "The output is not available yet." with a retry.
  - Activity line: "Compacting…" while compacting, "Retrying (n/max)…" while `retry` is set.

- [ ] **Step 1: Write the failing tests**

`transcript.vm.test.ts`:

```ts
it("pairs each tool call with its result and the tool's live status", () => {
  const view = viewWith({
    messages: [
      message({ role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }] }, "a1"),
      message({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "x".repeat(8000) }], papTruncated: { chars: 30000 } }, "t1"),
      message({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "make" } }] }, "a2"),
    ],
    tools: { c2: { name: "bash", status: "running", preview: "building…" } },
  });
  expect(transcriptItems(view).map((item) => [item.kind, item.key])).toEqual([["message", "a1"], ["tool", "c1"], ["tool", "c2"]]);
  expect(transcriptItems(view)[1]).toMatchObject({ name: "read", summary: '{"path":"a.txt"}', status: "done", truncatedChars: 30000 });
  expect(transcriptItems(view)[2]).toMatchObject({ status: "running", preview: "building…" });
});

it("shows a compaction as a summary item and the partial reply with its thinking", () => {
  const view = viewWith({
    messages: [message({ role: "compactionSummary", summary: "earlier work", tokensBefore: 900 }, "c1")],
    partial: { blocks: [{ type: "thinking", text: "hmm" }, { type: "text", text: "Hel" }] },
  });
  expect(transcriptItems(view)).toEqual([
    { kind: "summary", key: "c1", variant: "compaction", text: "earlier work", tokensBefore: 900, entryId: "c1" },
    { kind: "partial", key: "partial", text: "Hel", thinking: "hmm" },
  ]);
});
```

`Transcript.test.tsx`:

```ts
it("loads older messages above, once per click, and keeps the button while more remain", async () => {
  bed.handlers["sessions.history"] = () => ({ rows: [row("e1", "older question")], hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
  const page = await show({ rows: [row("e5", "newest")], history: { hasMore: true, oldestEntryId: "e5", turnsBefore: 2 } });
  await click(button(page, "Load older messages"));
  await settle();
  expect(bed.called("sessions.history")).toEqual([{ method: "sessions.history", params: { sessionId: "sess-1", before: "e5" }, options: undefined }]);
  expect(text(page).indexOf("older question")).toBeLessThan(text(page).indexOf("newest"));
  expect(hasButton(page, "Load older messages")).toBe(false);
});

it("shows the error of a failed page and keeps the button", async () => {
  bed.handlers["sessions.history"] = () => { throw new RpcError("internal"); };
  const page = await show({ rows: [row("e5", "newest")], history: { hasMore: true, oldestEntryId: "e5", turnsBefore: 2 } });
  await click(button(page, "Load older messages"));
  await settle();
  expect(alerts(page)).toContain("Something went wrong.");
  expect(hasButton(page, "Load older messages")).toBe(true);
});
```

`ToolRow.test.tsx`: a truncated tool shows "Show the whole output (29 KB)"; clicking calls `sessions.toolOutput({ sessionId, toolCallId: "c1" })` once and shows the returned text; a `not_found` shows "The output is not available yet." and a "Try again" button.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`transcript.vm.ts` builds the items from `view.messages` in order: a `user`/`assistant` message gives a `message` item (assistant `thinking` from its thinking blocks) followed by one `tool` item per tool call (`key` = the call id; `summary` = the `command` argument for a shell call, else the arguments' JSON cut to 200 characters; status from `view.tools[id]`, else `done`/`failed` from the paired result's `isError`, else `waiting`); a `toolResult` message gives no item of its own (it fills its call's item: `preview` from its text, `truncatedChars`); `compactionSummary` / `branchSummary` give `summary` items; an assistant error gives the M1 `failure` item; `view.partial` gives the last `partial` item. Keys are unique by construction (entry ids and tool-call ids are unique in Pi's data; rows without an id keep M1's ref-plus-counter key).

`Transcript.tsx` renders items through `MessageRow` (the `@pap/ui` `Message`, with a `<details>` "Thinking" block above the text when there is thinking) and `ToolRow` (a bordered block: the tool name in `font-mono text-label uppercase text-agent`, the summary, a status label, the preview in a `<pre>` capped by `max-h-64 overflow-auto`), and summaries as `<details>` with the summary text ("Conversation compacted · from {tokens} tokens"). The "Load older messages" handler keeps a `loading` flag (no second call while one is in flight), records `scrollHeight` before `prependHistory`, and restores `scrollTop += newHeight - oldHeight` in a layout effect after the rows land. `use-stick-to-bottom.ts` gains a `preserveOnPrepend()` used by that handler.

i18n (`sessions.*`): `transcript.loadOlder` "Load older messages", `transcript.thinking` "Thinking", `transcript.compacted` "Conversation compacted · from {tokens} tokens", `transcript.branchSummary` "Summary of another branch", `transcript.compacting` "Compacting…", `transcript.retrying` "Retrying ({attempt}/{max})…", `tool.running` "Running", `tool.done` "Done", `tool.failed` "Failed", `tool.waiting` "Waiting", `tool.showAll` "Show the whole output ({size} KB)", `tool.notYet` "The output is not available yet.", `tool.retry` "Try again"; fr: "Charger les messages plus anciens", "Réflexion", "Conversation compactée · à partir de {tokens} jetons", "Résumé d'une autre branche", "Compactage…", "Nouvel essai ({attempt}/{max})…", "En cours", "Terminé", "Échec", "En attente", "Afficher toute la sortie ({size} Ko)", "La sortie n'est pas encore disponible.", "Réessayer".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): transcript with tool rows, output on demand, summaries and older history"
```

---

### Task 26: Web dialogs — approvals with four answers, select, input, editor, confirm

References: DESIGN.md §9 ApprovalCard ("header `Approval · <category>` …; answers **Deny / Session / Always / Allow once**"), InputRequestCard ("Pi `select` / `input` / `editor` dialogs rendered in the stream"); R91 (the header line never scrolls away); R127 (a refused answer re-arms the card); T3 Code `ComposerPendingUserInputPanel`, Orca `rpc-extension-dialogs.ts` (approval vs question cards).

**Risks / rulings needed:** These are feature components on M1 tokens; M3 promotes them into `packages/ui` later (listed in its plan). Button styles: Allow once `primary`; Deny, Session, Always `secondary` (DESIGN §9.1: refusal is never `danger`). A dialog with a `timeout` shows "Closes on its own after N s" (static text; Pi resolves it).

**Files:**
- Create: `apps/web/src/features/sessions/dialogs/{ApprovalDialog,SelectDialog,TextDialog,ConfirmDialog,DialogList}.tsx`, `dialogs/DialogList.test.tsx`, `dialogs/ApprovalDialog.test.tsx`
- Modify: `apps/web/src/features/sessions/{SessionScreen,approval-detail}.tsx|ts`, `SessionScreen.test.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Task 13/14 `Dialog` (`approval` with `category`, `answers`), `DialogResponse.answer`.
- Produces: `<DialogList sessionId dialogs />` rendering every open dialog oldest first, each answered once (a guard like `ApprovalCard`'s), a refused answer re-arming that card (attempt counter in its key, R127); `ApprovalDialog` shows `APPROVAL · <CATEGORY>`, the question, the header line of the message outside the scrolling body, and only the answers the dialog offers, in DESIGN order; `SelectDialog` (one button per option, then Cancel → `{cancelled: true}`), `TextDialog` (`input` single-line with placeholder, `editor` multi-line prefilled; Submit → `{value}`, Cancel → `{cancelled: true}`), `ConfirmDialog` (Yes / No → `{confirmed}`) for an extension's confirm.

- [ ] **Step 1: Write the failing tests**

`ApprovalDialog.test.tsx`:

```ts
it("offers exactly the dialog's answers in DESIGN order and sends the one clicked, once", async () => {
  const page = await show([{ id: "a1", method: "approval", category: "exec", title: "Run a command?", message: "1 line\nbash: npm test", answers: ["deny", "session", "always", "once"] }]);
  expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Deny", "Session", "Always", "Allow once"]);
  expect(text(page)).toContain("APPROVAL · EXEC");
  expect(page.querySelector("[data-approval-header]")?.textContent).toBe("1 line");
  await click(button(page, "Always"));
  await click(button(page, "Allow once"));
  await settle();
  expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([{ sessionId: "sess-1", dialogId: "a1", response: { answer: "always" } }]);
});

it("shows only once and deny for a protected write", async () => {
  const page = await show([{ id: "a2", method: "approval", category: "edit", title: "Allow this edit?", message: "1 line\n→ /w/.git/hooks/pre-commit (protected path)\nwrite: …", answers: ["deny", "once"] }]);
  expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Deny", "Allow once"]);
});

it("re-arms a card whose answer was refused", async () => {
  bed.handlers["sessions.respondDialog"] = () => { throw new RpcError("worker_failed"); };
  const page = await show([{ id: "a1", method: "approval", category: "exec", title: "Run?", message: "1 line\nbash: ls", answers: ["deny", "once"] }]);
  await click(button(page, "Allow once"));
  await settle();
  expect(button(page, "Allow once").disabled).toBe(false);
});
```

`DialogList.test.tsx`: a select sends `{ value: "b" }` for option "b" and Cancel sends `{ cancelled: true }`; an input shows its placeholder and sends the typed value; an editor starts with its prefill; an extension confirm sends `{ confirmed: false }` on No; two open dialogs render oldest first; a dialog with `timeout: 5000` shows "Closes on its own after 5 s".

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions/dialogs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Each component keeps its own "answered" state set by a `once()` guard built lazily in the click handler (R121: no ref read during render), and calls `onAnswer(response)` given by `DialogList`, which calls `sessions.respondDialog` and, on failure, shows the error and bumps the dialog's attempt counter (new key, fresh card). `ApprovalDialog` reuses `approvalDetail` / the header split of M1 (first line in `data-approval-header`, the rest in a focusable scrolling `<pre>` with `role="region"`), the attention tint and line classes M1's `ApprovalCard` uses, `role="alertdialog"` with `aria-describedby`. The answer labels come from i18n. `SessionScreen.tsx` renders `<DialogList>` where M1 mapped dialogs.

i18n (`sessions.*`): `dialog.approval` "Approval · {category}", `dialog.answer.deny` "Deny", `dialog.answer.session` "Session", `dialog.answer.always` "Always", `dialog.answer.once` "Allow once", `dialog.submit` "Submit", `dialog.cancel` "Cancel", `dialog.yes` "Yes", `dialog.no` "No", `dialog.timeout` "Closes on its own after {seconds} s", `dialog.category.read|edit|exec|network|external-write|unknown` ("read", "edit", "exec", "network", "external write", "unknown"); fr: "Approbation · {category}", "Refuser", "Session", "Toujours", "Autoriser une fois", "Valider", "Annuler", "Oui", "Non", "Se ferme seul après {seconds} s", "lecture", "modification", "exécution", "réseau", "écriture externe", "inconnu". The header shows the category in uppercase through CSS-free text (`.toUpperCase()` on the translated label), since R121 forbids relying on `text-transform` for selectors.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): approval cards with four answers and extension input dialogs"
```

---

### Task 27: Web extension UI — status bar with `command:` buttons, widgets, custom panels, title

References: pi-web `components/ExtensionStatusBar.tsx` (`command:/name args` keys become buttons sending the slash command, disabled while busy, only `/` commands, empty statuses get no cell, sorted by key), `ExtensionWidgets.tsx`, `ChatWindow`'s `ExtensionCustomPanel` (oldest panel shown with a count of the waiting ones, a textarea that turns keys into terminal input, IME composition, collapse) and `lib/terminal-input.ts` (the key table); DESIGN.md §9 CustomPanel ("lines in mono; takes keyboard focus; re-rendered whole on each update"), StatusBar and Widgets.

**Risks / rulings needed:** ANSI escapes are stripped (no colours) until DESIGN rules colours for extension text (open question 5). The title is shown in the session header, not in `document.title` (the shell's, M3).

**Files:**
- Create: `apps/web/src/features/sessions/{StatusBar,Widgets,CustomPanel}.tsx`, `status-cells.ts`, `status-cells.test.ts`, `ansi.ts`, `ansi.test.ts`, `terminal-keys.ts`, `terminal-keys.test.ts`, `CustomPanel.test.tsx`, `StatusBar.test.tsx`
- Modify: `apps/web/src/features/sessions/SessionScreen.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Task 16 `statuses`, `widgets`, `title`, `panels`, `sessions.panelInput`.
- Produces:
  - `stripAnsi(text)`: removes CSI, OSC, other two-character escapes and pi-tui's cursor marker `\x1b_pi:c\x07`.
  - `statusCells(statuses): Array<{ kind: "text"; key; text } | { kind: "command"; key; command; label }>` — sorted by key, text sanitized (tabs and runs of spaces collapsed, lines trimmed, ANSI stripped), a key `command:/…` with a command longer than one character becomes a button (label = its text, else the command), a non-`/` command stays text, an empty text gives no cell.
  - `terminalKeyData(event): string | null` — arrows, Home/End, Insert/Delete, PageUp/PageDown, Escape, Backspace, Enter (`\r`, Shift → `\n`), Tab / Shift+Tab, Ctrl+letter control codes, Alt+key and Alt+arrows as escape sequences; null for Meta and for Ctrl+V (paste goes through the input event).
  - `<StatusBar statuses busy onCommand />` (buttons disabled while `busy`), `<Widgets widgets placement />`, `<CustomPanel sessionId panels />` (the oldest open panel, "N more waiting", a collapse toggle, a hidden-text textarea that focuses on open and sends each key or pasted text with `sessions.panelInput`; a failed send shows the error).

- [ ] **Step 1: Write the failing tests**

`status-cells.test.ts`:

```ts
it("turns command keys into buttons, keeps text statuses, drops empty ones, in key order", () => {
  expect(statusCells([
    { key: "z-git", text: "main\t\tdirty" },
    { key: "command:/mode build", text: "\u001b[32mBuild\u001b[0m" },
    { key: "command:x", text: "not a slash command" },
    { key: "empty", text: "\u001b[0m  " },
    { key: "command:/", text: "too short" },
  ])).toEqual([
    { kind: "command", key: "command:/mode build", command: "/mode build", label: "Build" },
    { kind: "text", key: "command:/", text: "too short" },
    { kind: "text", key: "command:x", text: "not a slash command" },
    { kind: "text", key: "z-git", text: "main dirty" },
  ]);
});
```

`terminal-keys.test.ts`:

```ts
it.each([
  [{ key: "ArrowDown" }, "\u001b[B"],
  [{ key: "Enter" }, "\r"],
  [{ key: "Enter", shiftKey: true }, "\n"],
  [{ key: "Tab", shiftKey: true }, "\u001b[Z"],
  [{ key: "c", ctrlKey: true }, "\u0003"],
  [{ key: "b", altKey: true }, "\u001bb"],
  [{ key: "ArrowLeft", altKey: true }, "\u001bb"],
  [{ key: "Backspace" }, "\u007f"],
  [{ key: "v", ctrlKey: true }, null],
  [{ key: "a", metaKey: true }, null],
  [{ key: "a" }, null],
])("maps %j to %j", (event, expected) => {
  expect(terminalKeyData({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...event })).toBe(expected);
});
```

(Plain characters come through the textarea's `input` event, not `keydown`, so IME composition works.)

`ansi.test.ts`: strips `\u001b[31mred\u001b[0m` → `red`, an OSC 8 link → its text, the cursor marker, and leaves `→ ✓` untouched.

`StatusBar.test.tsx`: a command cell is a button that calls `onCommand("/mode build")`; while `busy` it is disabled; a text status renders as text.

`CustomPanel.test.tsx`:

```ts
it("shows the oldest panel, counts the others, and sends keys and pasted text", async () => {
  const page = await show([{ id: "p1", lines: ["\u001b[7m> alpha\u001b[0m", "  beta"] }, { id: "p2", lines: ["other"] }]);
  expect(text(page)).toContain("> alpha");
  expect(text(page)).toContain("1 more waiting");
  const input = page.querySelector("textarea") as HTMLTextAreaElement;
  expect(document.activeElement).toBe(input);
  await press(input, { key: "ArrowDown" });
  await typeInto(input, "pasted text");
  await settle();
  expect(bed.called("sessions.panelInput").map((call) => call.params)).toEqual([
    { sessionId: "sess-1", panelId: "p1", data: "\u001b[B" },
    { sessionId: "sess-1", panelId: "p1", data: "pasted text" },
  ]);
  expect(input.value).toBe("");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ansi.ts`:

```ts
// CSI sequences, OSC sequences (ended by BEL or ST), other two-character escapes, and pi-tui's cursor marker.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|_pi:c\u0007|[@-Z\\-_])/g;
export const stripAnsi = (text: string): string => text.replace(ESCAPES, "");
```

`terminal-keys.ts` holds the key table of the interface line (own code, the semantics of pi-web's `lib/terminal-input.ts`). `status-cells.ts` implements the rules above. `StatusBar.tsx` sends a command with `sessions.prompt({ sessionId, text: command })` through the composer's send path (so its failure shows like any prompt's) and is `busy` while the status is `running`, `starting` or `releasing`. `Widgets.tsx` renders each widget as mono lines (`font-mono text-ui whitespace-pre`, ANSI stripped) above or below the composer per `placement`. `CustomPanel.tsx`: the textarea is visually small and labelled ("Panel input"), focuses when the panel opens or is expanded, ignores keys during composition, sends `terminalKeyData(event)` on `keydown` (preventing the default only when it sends) and the textarea's value on `input` (then clears it); a failed `panelInput` shows `failureText`. `SessionScreen.tsx` puts widgets above / below the composer, the status bar under it, the panel over the transcript, and the title in the header.

i18n (`sessions.*`): `panel.waiting` "{count} more waiting", `panel.input` "Panel input", `panel.collapse` "Hide the panel", `panel.expand` "Show the panel", `status.label` "Extension status"; fr: "{count} de plus en attente", "Saisie du panneau", "Masquer le panneau", "Afficher le panneau", "État des extensions".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): extension status bar, widgets and custom panels"
```

---

### Task 28: Web session actions — rename, auto-name, compact, export, clone, fork and edit from a message, branch switcher, always rules

References: pi-web (Fork "New session" on a user message hands its text to the new composer; "Edit from here" puts the message in the composer and the next prompt branches; `BranchNavigator` switches siblings, read-only while busy; auto-name button), DESIGN.md (actions as buttons, Cancel never destructive).

**Risks / rulings needed:** Where the "always" rules list lives before M5's Settings (open question 2, proposed: a disclosure in the session header listing this project's rules with Revoke). Compact asks no confirmation (pi-web asks none; Stop compaction is Stop). Export opens the download through a plain link to the returned URL (no SPA route).

**Files:**
- Create: `apps/web/src/features/sessions/{SessionActions,BranchSwitcher,AlwaysRules}.tsx`, `branches.vm.ts`, `branches.vm.test.ts`, `SessionActions.test.tsx`, `BranchSwitcher.test.tsx`, `AlwaysRules.test.tsx`
- Modify: `apps/web/src/features/sessions/{MessageRow,SessionScreen,Composer}.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Tasks 11, 14, 17–19 methods; Task 24 drafts (`saveDraft` for the forked session's text) and editor-text path.
- Produces:
  - `<SessionActions sessionId view />`: Rename (inline field, Enter saves, Escape cancels; `sessions.rename`), Auto-name (`sessions.autoName`, disabled while one runs; "Naming…" after 1 s as per spec C §7.4 feedback timing), Compact (`sessions.compact`, disabled while running), Export (`sessions.exportHtml` then follows the URL with an `<a download>` click), Duplicate (`sessions.clone` then navigates to `/s/$sessionId`).
  - On a user `MessageRow` with an `entryId`: "Fork from here" (`sessions.fork` → `saveDraft(localStorage, newId, text)` → navigate) and "Edit from here" (`sessions.navigate` → the returned `editorText` replaces the composer's text), both disabled while running.
  - `branchChoicesFor(points, entryId): { index; total; previous?: string; next?: string } | null` and `<BranchSwitcher>`: on a user row that is one of a fork point's choices, "‹ 2/3 ›" buttons navigate to the neighbour choice's `target`; refreshed (`sessions.branches`) after every snapshot or settled run.
  - `<AlwaysRules cwd />`: `policy.listRules({ cwd })`, one line per rule (tool, label, date) with Revoke (`policy.revokeRule`), the list reloaded after a revoke; an error shows inline.

- [ ] **Step 1: Write the failing tests**

`branches.vm.test.ts`:

```ts
const points = [{ parentId: "a0", choices: [
  { entryId: "u1", preview: "first try", target: "a1", timestamp: null, onPath: false },
  { entryId: "u2", preview: "second try", target: "a2", timestamp: null, onPath: true },
  { entryId: "u3", preview: "third try", target: "a3", timestamp: null, onPath: false },
] }];

it("places a row among its siblings and names the neighbours' targets", () => {
  expect(branchChoicesFor(points, "u2")).toEqual({ index: 2, total: 3, previous: "a1", next: "a3" });
  expect(branchChoicesFor(points, "u1")).toEqual({ index: 1, total: 3, next: "a2" });
  expect(branchChoicesFor(points, "u9")).toBeNull();
});
```

`SessionActions.test.tsx`: rename sends `{ sessionId, name: "New name" }` on Enter and nothing on Escape; Duplicate calls `sessions.clone` then navigates to `/s/<new id>` (router mocked); Export calls `sessions.exportHtml` and clicks a link whose `href` is the returned URL; Compact is disabled while the status is `running`; a failed auto-name shows the error text.

`MessageRow` tests (in `Transcript.test.tsx`): "Fork from here" calls `sessions.fork({ sessionId, entryId: "u1" })`, stores the returned text as the new session's draft (`localStorage["pap.draft.<new id>"]`) and navigates; "Edit from here" calls `sessions.navigate({ sessionId, targetId: "u1" })` and the composer then holds the returned text; both are disabled while running.

`BranchSwitcher.test.tsx`: "Next branch" on the row `u2` calls `sessions.navigate({ targetId: "a3" })`.

`AlwaysRules.test.tsx`: lists two rules; Revoke on the first calls `policy.revokeRule({ ruleId })` and reloads the list (one left).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

As the interface lines say; the navigation uses TanStack Router's `useNavigate` as `SessionListScreen` does (`navigate({ to: "/s/$sessionId", params: { sessionId } })`). Every action button keeps its own `busy` state, disabled from the click until the answer (spec C §7.4: nothing under 100 ms, a label after 1 s), and failures go through `failureText`. The composer receives "Edit from here" text through the same path as `editor_text` (a callback prop from `SessionScreen`).

i18n (`sessions.*`): `actions.rename` "Rename", `actions.save` "Save", `actions.autoName` "Name it", `actions.naming` "Naming…", `actions.compact` "Compact", `actions.export` "Export", `actions.duplicate` "Duplicate", `row.fork` "Fork from here", `row.edit` "Edit from here", `branch.previous` "Previous branch", `branch.next` "Next branch", `branch.position` "{index}/{total}", `rules.title` "Always allowed in this project", `rules.revoke` "Revoke", `rules.empty` "Nothing is always allowed here."; fr: "Renommer", "Enregistrer", "Nommer", "Nommage…", "Compacter", "Exporter", "Dupliquer", "Bifurquer ici", "Modifier à partir d'ici", "Branche précédente", "Branche suivante", "{index}/{total}", "Toujours autorisé dans ce projet", "Révoquer", "Rien n'est toujours autorisé ici.".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): session actions, fork and edit from a message, branch switcher, always rules"
```

---

### Task 29: Web minimap

References: pi-web `components/ChatMinimap.tsx` (one node per turn, a preview of the turn on hover or focus, click scrolls to it, numbering from the branch's first turn with `turnsBefore`, a stub for turns not loaded that pages them in), C §7.3 ("the minimap" kept from pi-web).

**Risks / rulings needed:** Visual design is not drawn in DESIGN.md: a narrow rail of numbered buttons on token colours, hidden below the `md` breakpoint (mobile layout is M3's). No markdown in previews.

**Files:**
- Create: `apps/web/src/features/sessions/{Minimap.tsx,minimap.vm.ts}`, `minimap.vm.test.ts`, `Minimap.test.tsx`
- Modify: `apps/web/src/features/sessions/{Transcript,SessionScreen}.tsx` (row elements get `id="row-<key>"`), `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Task 25 items and keys, Task 11 `history.turnsBefore` and `hasMore`.
- Produces: `minimapTurns(items, turnsBefore): Array<{ number; key; preview; tools }>` (a turn starts at each user message or summary; `number = turnsBefore + index + 1`; `preview` = the first 200 characters of its text on one line; `tools` = tool items until the next turn); `<Minimap items view onLoadOlder />`: one button per turn labelled by its number (its accessible name "Turn {n}: {preview}"), `aria-current` on the turn in view (an `IntersectionObserver` over the row elements), click scrolls `row-<key>` into view; a "{count} earlier turns" button while `hasMore`, calling `onLoadOlder`.

- [ ] **Step 1: Write the failing tests**

`minimap.vm.test.ts`:

```ts
it("numbers turns from the branch's start and counts their tools", () => {
  const items = [
    { kind: "message", key: "u5", author: "you", text: "Fix the login\nplease", thinking: "", entryId: "u5" },
    { kind: "message", key: "a5", author: "agent", text: "Looking", thinking: "", entryId: "a5" },
    { kind: "tool", key: "c1" },
    { kind: "tool", key: "c2" },
    { kind: "summary", key: "s1", variant: "compaction", text: "earlier work", tokensBefore: 10, entryId: "s1" },
  ] as const;
  expect(minimapTurns(items as never, 4)).toEqual([
    { number: 5, key: "u5", preview: "Fix the login please", tools: 2 },
    { number: 6, key: "s1", preview: "earlier work", tools: 0 },
  ]);
});
```

`Minimap.test.tsx`: renders "Turn 5: Fix the login please"; clicking it calls `scrollIntoView` on `#row-u5` (stubbed on the element); with `hasMore` and `turnsBefore: 4` a "4 earlier turns" button calls `onLoadOlder`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

As the interface says; the observer is created in an effect, disconnected on unmount and on items change; the rail is `hidden md:flex flex-col` beside the transcript with `overflow-y-auto`. i18n (`sessions.*`): `minimap.label` "Turns", `minimap.turn` "Turn {number}: {preview}", `minimap.earlier` "{count} earlier turns"; fr: "Tours", "Tour {number} : {preview}", "{count} tours plus anciens".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): transcript minimap"
```

---

### Task 30: Docs, ADR check and the final gates

**Risks / rulings needed:** If the bundle grew past `initialBundleGzipKb` (180), split the session screen's heavy parts (`CustomPanel`, `Minimap`, dialogs) behind `lazy()` before considering a budget change; a budget change goes to the owner (M3 re-sets it from real numbers).

**Files:**
- Modify: `docs/agents/sessions.md` (protocol v2, transcript rows and ADR 0007, coalescing and partial, wire clipping and tool output, queue cap, approvals channel and grants, decorations / panels / notices, commands, export and ADR 0006, fork / clone and the daemon-written files exception, idle release, scopes, traps), `docs/agents/daemon.md` (worker settings and scopes, `exports/`, the policy module, the R118 harness check), `AGENTS.md` (≤ 150 lines: the new `PAP_WORKER_*` settings, `pnpm` commands unchanged), `docs/research/m0-m1-rulings.md` (append nothing; M2 rulings go to `docs/research/m2-rulings.md`, kept by the controller during execution and committed here)

**Interfaces:** none.

- [ ] **Step 1: Update the topic notes** to describe what the code does (no overclaiming), with the traps found during execution.

- [ ] **Step 2: Run every gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke`
Expected: all PASS. This is the M2 exit criterion (see "Exit criteria").

- [ ] **Step 3: Commit**

```bash
git add docs AGENTS.md
git commit -m "docs: sessions, daemon and agent notes for M2"
```

---
## Exit criteria (roadmap M2)

All testable on this headless host, without a browser:

1. **Gates:** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke` green (Task 30).
2. **pi-web D01 behaviours reproduced with scripted-provider integration tests** (real pi-host, scripted model, network guard):

   | D01 behaviour | Integration test |
   |---|---|
   | Steer and follow-up, delivery order, 128-message cap, Stop = clear queue + abort | `sessions.queue.int.test.ts` (Task 12) |
   | `navigate_tree` ("Edit from here") and the next prompt branching; fork points | `sessions.commands.int.test.ts` (Task 17), `host.int.test.ts` (Task 2) |
   | Fork before a message, clone a branch | `sessions.forks.int.test.ts` (Task 19) |
   | Compaction, summary row live and after a restart | `sessions.commands.int.test.ts` (Task 17) |
   | HTML export as a single-use attachment | `sessions.export.int.test.ts` (Task 18) |
   | Auto-name and rename | `sessions.commands.int.test.ts` (Task 17), `host.int.test.ts` (Task 3) |
   | History paging, tool output on demand | `service.reads.test.ts`, `sessions.reads.int.test.ts` (Task 11) |
   | 50 ms delta coalescing, exact text | `sessions.int.test.ts` streaming case (Task 9) |
   | Rows with entry ids, live and from the file | `sessions.transcript.int.test.ts` (Task 10) |
   | Drafts, minimap | component tests (Tasks 24, 29) |

3. **pi-web D18 behaviours:** select / input / editor / confirm, status bar with `command:` buttons, widgets of lines and components, custom panels (open, keys, close, in the snapshot), editor text — `sessions.d18.int.test.ts` (Task 21); approvals on their own channel with once / session / always / deny — `host.int.test.ts` (Task 13), `sessions.grants.int.test.ts` (Task 14).
4. **A crashing extension or worker never takes the daemon down:** `sessions.crash.int.test.ts` (Task 22), M1's `worker.rogue.int.test.ts`, `scope.int.test.ts` (Task 5).
5. **Worker idle release after 30 minutes:** `idle-release.test.ts`, `sessions.release.int.test.ts` (Task 20). **systemd scopes** with `MemoryHigh` / `MemoryMax` / `TasksMax`: `scope.test.ts`, `scope.int.test.ts` (Task 5), wired at boot (Task 6).
6. **Budgets** idle worker RSS and session-open payload measured (Task 23); R45 decided in `docs/spikes/s4-m2-long-session.md`.

## Coverage map (roadmap, backlog, spec → tasks)

| Requirement | Task |
|---|---|
| Protocol v2 records, stream events, snapshot sections | 1 |
| Steer / follow-up, 128 / 32 MiB queue cap (spec C §2.4, R112) | 2, 12, 24 |
| `navigate_tree` | 2, 10, 17, 28 |
| Fork / clone | 19, 28 |
| Compaction | 2, 17, 25 |
| HTML export | 2, 18, 28 |
| Auto-name | 3, 17, 28 |
| History paging | 10, 11, 25 |
| Tool output on demand | 9, 11, 25 |
| 50 ms delta coalescing, partial reply in the snapshot (R111, R112) | 9 |
| Recent notices in the snapshot (roadmap line) | 16 |
| Drafts | 24 |
| Minimap | 29 |
| All extension dialogs incl. select / input / editor | 13, 26 |
| Session / always approval answers (spec C §5.3, R90 part) | 13, 14, 26, 28 |
| Status bar with `command:` buttons, widgets | 15, 16, 27 |
| `ctx.ui.custom()` panels over `custom_render` / `custom_input` (S1) | 15, 16, 27 |
| Worker idle release after 30 min (spec C §2.1) | 20 |
| systemd scopes `MemoryHigh 512` / `MemoryMax 768` / `TasksMax` (R46, R100) | 5, 6 |
| `session_shutdown` parity and the rest of R106 | 4, 5 |
| R113 abort before `agent_start`; run identity in `confirm` | 8 |
| R112 `starting` on reopen, run origin, realpath, dialog limits | 8 |
| R118 daemon-layer network-guard check | 6 |
| R124 exactly-once "Send again" | 24 |
| R45 revisit, budgets | 23 |
| Crash containment (spec A success criterion 1) | 22 |
| Hot-session reads (spec C §3.3 deviation) | 10 (ADR 0007) |
| Export route (spec C §4.5 deviation) | 18 (ADR 0006) |

## Open questions for the owner

Product or design decisions the specs, DESIGN.md and the decisions log do not settle. Each has the plan's default; the controller rules before the task named.

1. **"Always" matching** (Task 14): exact call only (tool + exact payload, keys sorted), no prefix or pattern rules (Claude Code's "always allow `npm test …`"). Patterns would come with M5's Settings. Default: exact only.
2. **Where to revoke "always" rules before M5** (Task 28): a disclosure in the session header listing this project's rules with Revoke. Alternatives: nowhere in the UI until M5 (RPC only), or a minimal Settings page (M3's shell). Default: session header.
3. **Which answers each question offers** (Task 14): all four for exec / network / external-write; no "Always" for tools pap cannot classify; only "Allow once" / "Deny" for writes outside the project or to protected paths (`.git`, `.pi`, …). Default as written.
4. **`TasksMax` default** (Tasks 5, 6): not in R46. Default 4096 per worker (a fork-bomb guard that leaves room for parallel builds), configurable with `PAP_WORKER_TASKS_MAX`.
5. **ANSI colours in panels, widgets and statuses** (Task 27): stripped in M2 (pi-host gives extensions a plain theme anyway). Mapping the 16 ANSI colours to DESIGN tokens needs a DESIGN rule (M3).
6. **Steer as the default while the agent works** (Task 24): pi-web's default; per device, switchable. Default: steer.
7. **Exported HTML as Pi writes it** (Task 18): pi-web patches Pi's export so very deep linear sessions do not overflow the browser's stack; pap serves it unpatched. Default: unpatched (patching Pi's generated script is fragile).
8. **CI and systemd scopes** (Tasks 5, 22): GitHub runners usually have no user systemd manager, so the scope tests skip there with a printed reason (they run on this host). Alternative: enable a user manager in CI (`loginctl enable-linger` needs sudo on the runner). Default: skip in CI.
9. **Transcript virtualization deferred** (spec C §7.2 names `@tanstack/react-virtual`): M2 adds no web dependency (lockfile overlap with M3) and renders loaded rows like pi-web. Default: defer to M4/M13.
10. **Clone in the middle of a run** (Task 19): copies the branch as written on disk (pi-web's sidebar Fork) rather than refusing (pi-web's chat clone). Default: copy.
11. **A navigation nobody continued** is forgotten when the worker is released or crashes (Pi keeps the leaf in memory; pi-web behaves the same). Alternative: keep a worker alive while its leaf is not the file's last entry. Default: accept.
12. **Text an extension or "Edit from here" puts in the composer** replaces what the user typed (the pi TUI's `setEditorText`), or is merged above it. Default: replace (TUI parity).
13. **Three spec deviations:** ADR 0006 (export download route, spec C §4.5), ADR 0007 (hot sessions read from Pi's file, spec C §3.3) and ADR 0008 (records added to spec C §2.3). Default: accept all three.
14. **R90 items pulled forward from M5** (policy-origin approval channel; closed question = fail closed), needed for session / always answers. Default: accept.
15. **`UI_LIMITS` values** (Task 1): statuses 32 × 512 characters, widgets 8 × 50 lines × 512, panels 4 × 200 lines × 512, notices 20 × 2000, queue previews 128 × 2000. Default as written.

## Merge order and conflict notes (with M3)

- **Order:** whichever branch passes its whole-branch review first merges first; the other rebases (`git rebase main`) and re-runs every gate. If both are ready together, merge **M2 first**: it changes the protocol and the contracts, and M3's shell then mounts the new `SessionScreen` without touching its insides.
- **No M2 task waits for an M3 merge.** Tasks 24–29 rebase first if M3 has merged an i18n restructuring; Task 30 re-reads `budgets.json` after any M3 merge.
- **Files both branches touch, and how the second resolves them:**
  - `apps/web/src/i18n/en.ts`, `fr.ts`: M2 adds keys only inside its `// ── sessions (M2) ──` block, **plus four exceptions** that cannot live there because their names are fixed by existing lookups: `error.queue_full`, `error.session_busy`, `error.session_empty`, `error.command_failed` (every `ErrorCode` needs an `error.<code>` message) and `session.status.releasing` (the status label lookup). Resolution: keep both sides' keys; if M3 split the catalogue per feature, move M2's block into the sessions catalogue unchanged.
  - `apps/web/src/routes/router.tsx`, `RootLayout.tsx` (M3-owned): import `SessionScreen` and `SessionListScreen` from `features/sessions`. M2 keeps both export names and props (`SessionScreen({ sessionId })`), uses the existing `/s/$sessionId` route for forks and clones, and adds no route. Nothing to resolve unless M3 renames the route path, in which case M2's `navigate({ to: "/s/$sessionId" })` calls (Task 28) follow M3's name.
  - `pnpm-lock.yaml`, `pnpm-workspace.yaml`: M2 adds one catalog line (`@earendil-works/pi-tui: 1.1.0`) and the dependency in `packages/pi-host/package.json`; M3 adds web dependencies. Resolution: keep both catalog lines and package entries, run `pnpm install`, commit the regenerated lockfile.
  - `packages/contracts/src/permissions.ts` (`DOMAINS`), `methods.ts`, `apps/daemon/src/daemon.ts`: M2 adds the `policy` domain and module. If M3 stores per-account appearance settings on the server (DESIGN decision 28), it adds its own domain and methods: keep both (a union of domains, both method groups, both module lines in the composition root). M3 should put its methods in a new contracts file merged into the catalogue with one line, to keep the conflict to one line.
  - `@pap/ui` public API and token classes: M2 uses `Button`, `TextField`, `Message`, `ApprovalCard` (extension confirms), `cn`, `FOCUS_RING`, and the M1 token classes (`bg`, `panel`, `line`, `fg`, `muted`, `agent`, `human`, `human-fill`, `human-tint`, `human-line`, `human-text`, `on-fill`, `attention`, `attention-tint`, `attention-line`, `ok`, `error`, `text-label`, `text-ui`, `text-chat`, `font-mono`, `tracking-label`, `rounded-sm`, `rounded-md`). M3 keeps them working or migrates M2's feature files after both merge (listed in M3's plan).
  - `AGENTS.md`: both add lines; keep both and the 150-line limit.
- **Follow-ups for M3 after both merge** (to list in M3's plan): promote M2's feature components (`ApprovalDialog`, `SelectDialog`, `TextDialog`, `ConfirmDialog`, `StatusBar`, `Widgets`, `CustomPanel`, `ToolRow`, `QueueStrip`, `Minimap`) into `packages/ui`; bind keys to M2's actions (`stopSession` for Esc; send with the preferred / other streaming behaviour); markdown in `Message`; the bundle budget from real numbers.
- **Never touched by M2:** `packages/ui/**`, `apps/web/src/styles.css`, `apps/web/index.html`, `apps/web/src/routes/**`, theming, keybindings, Cmd+K, `/dev/ui`, the Playwright journey.

## Self-review

- Spec coverage: every roadmap M2 item and every M2-tagged ruling maps to a task (coverage map); deviations have ADRs (0006, 0007, 0008); deferrals are listed in the header.
- Types and names used across tasks: `TranscriptRow`, `EntryRef`, `QueueView`, `PartialMessage`, `Dialog.method "approval"`, `DialogResponse.answer`, `Grant`, `PolicyPort`, `WorkerScopes`, `createIntBed` / `IntBed` / `Subscription`, `LiveSession.leafId()` / `partial()` / `panelInput()` / `command()` / `answer()` / `send()` / `exited()`, `requestTimeoutMs`, `fitSnapshot` / `fitRow` / `fitPage` / `withTrimmedHistory` are each defined once (task named in its Interfaces block) and used with the same signature afterwards.
- No placeholder steps: where a task leaves an SDK detail to check (option names of `completeSimple`, `CompactionResult` fields, `createBranchedSession` flushing), it says what to read and keeps the test as the binding part.
