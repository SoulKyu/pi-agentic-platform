# pap M2: sessions core and extension UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full Pi session experience on the worker model: steer / follow-up with a bounded queue, in-session branching (`navigate_tree`), fork / clone, compaction, HTML export, naming, history paging, tool output on demand, 50 ms delta coalescing, drafts and a minimap; every extension UI surface (select / input / editor / confirm dialogs, approvals answered once / session / always / deny, status bar with `command:` buttons, widgets, `ctx.ui.custom()` panels, ANSI colours mapped to role tokens); workers released after 30 idle minutes and contained in systemd user scopes; and a daemon that survives any worker or extension failure.

**Architecture:** Protocol v2 extends the daemon ⇄ pi-host records (Pi RPC shapes plus pap records) and the `session` stream: dedicated event kinds replace the raw decorations M1 forwarded, and the snapshot carries transcript rows with Pi entry ids, the partial reply, the queue, decorations, open panels and recent notices. The daemon reads transcripts from Pi's files along the active branch (the leaf of a hot session comes from its worker) through bounded walks and a byte-bounded, incremental cache, coalesces deltas every 50 ms, clips tool output on the wire and serves the full output on demand. Workers start inside `systemd-run --user --scope` when a lingering user manager answers, each in a unit of a slice that belongs to this `PAP_HOME`. A new `policy` daemon module persists "always" approvals per project (the git root of the session's folder) and pushes them to workers with `policy_update`. The daemon writes Pi files only to create a fork or a clone (ADR 0009). The web app's `features/sessions` renders all of it with feature components built on the M1 tokens and `@pap/ui` primitives.

**Tech Stack:** as M1 (Node 24, pnpm catalog, TypeScript 6.0.3 strict and erasable-only, zod 4.6.5, Hono, `ws`, `node:sqlite`, Pi SDK 1.1.0, React 19 + Vite + React Compiler, TanStack Router, zustand, Tailwind 4, Vitest + happy-dom). Added: `@earendil-works/pi-tui` 1.1.0 through the existing catalog (pi-host only: the keybindings manager custom panels need, as in S1 and pi-web). Runtime, optional: `systemd-run`, `systemctl --user` and `loginctl`. No new web dependency.

**Spec:** `docs/specs/2026-10-10-C-architecture.md` §2 (lifecycle, records, run rules, containment), §3.3, §4.3, §5.3 (approval answers), §7; `docs/specs/2026-10-10-A-product-scope.md` §5.1 (D01, D18); `docs/plans/roadmap.md` (M2); `DESIGN.md` §9 (ApprovalCard, InputRequestCard, CustomPanel, StatusBar and Widgets, Composer, ToolCard); `docs/spikes/s1.md` (custom panels over IPC), `docs/spikes/s4.md` (worker RAM); `docs/research/m0-m1-rulings.md`; behaviour reference pi-web (read only, `/home/ubuntu/Workspace/soulkyu/pi-web`), design references T3 Code and Orca (read only, `/home/ubuntu/Workspace/soulkyu/_refs/{t3code,orca}`). Binding inputs of this revision: the red-team review `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/redteam-m2.md` (M2-RT-01…42, O-1…O-6, applied task by task and cited by id), the owner decisions `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/owner-decisions-2026-10-11.md` (summarised in "Owner decisions (2026-10-11)"), the cross-plan agreements `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m2-m3-cross-plan-agreements.md` (in "Merge order and conflict notes") and the rulings ledger `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/rulings-m2.md` (M2R1…, the same lines as each task's "Rulings (pre-dispatch)").

## Backlog rulings absorbed

| Ruling | What M2 does | Task |
|---|---|---|
| R45 (revisit) | Measures a long scripted session's worker RSS (the worker alone, not its scope) and re-decides `WORKER_BUDGET_MB`; adds the idle-worker RSS and session-open payload budgets as tests | 23 |
| R46 (amended by the owner, R2-1) | One scope per worker with `MemoryMax = max(2 GiB, 50 % of RAM)`, `TasksMax 4096`, `OOMPolicy=continue` and no `MemoryHigh`: the scope holds the worker **and every command it runs**, so R46's 512/768 (measured on the worker alone) would kill ordinary builds. R46's numbers come back once the per-command sandbox (M5) separates worker and tools | 5, 6 |
| R90 (part, pulled forward from M5) | Policy-origin marker on approval requests (a dedicated `approval_request` record, never `ctx.ui`), closed dialog → `FAIL_CLOSED_REASON` with audit reason `dialog closed`, a cancelled approval answered `cancelled` (never "Denied by the user") | 13a, 13b |
| R92 | The scope tests FAIL in CI when no user manager answers (owner M2-Q8); CI starts one | 5, 6 |
| R100 | The systemd scope is the cover for a SIGKILLed or OOM-killed worker: the daemon kills and stops the scope after every exit, which kills Pi's detached bash trees; the slice is per `PAP_HOME`, swept at boot and SIGKILLed (bounded) when a stop is given up | 5, 6 |
| R106 | `session_shutdown` to extensions on shutdown; a dialog whose request was dropped for size is cancelled in the worker; a failed response for an unserialisable response; the "worker leads its own group" guard checked under a scope; the descendant walk re-scans until stable (SIGSTOP variant not taken, see Task 4) | 4, 5 |
| R111 (M2 part) | Partial reply in the snapshot and 50 ms coalescing (9a); `toolcall_end` arguments clipped and `text_end` / `thinking_end` content dropped on the wire (9b) | 9a, 9b |
| R112 | Partial + coalescing (9a), queue cap 128 / 32 MiB (12), `starting` published on reopen (8), run origin for extension-started runs (8), `isPiSessionFile` with realpath (8), dialog limits read from the `Dialog` schema (8), hot-session reads (10a, ADR 0007 instead of `get_entries{since}`) | 8, 9a, 10a, 12 |
| R113 | An abort that arrives while a prompt is in flight aborts at that prompt's `agent_start`; `confirm` guarded by run identity | 8 |
| R118 (daemon layer) | The test harness and the int bed fail a test whose workers logged a swallowed `pap-network-guard: blocked` | 6, 10b |
| R124 ("exactly-once retry same intent is M2") | The composer's "Send again" after an outcome-unknown failure reuses the same `commandId`; the pending send survives a reload (`pap.pending.<sessionId>`) | 24 |
| Roadmap "recent notices in the snapshot" | The snapshot carries the last 20 notices, start-up notices included, under the decoration byte budget | 16 |
| Spec C §2.1 idle release | `idle → releasing → cold` after 30 idle minutes; "background work" includes live descendant processes, released anyway after 8 h (owner R2-2) | 20 |

R125 is parked, not absorbed: see "Explicitly deferred".

## Explicitly deferred

- **Markdown and code highlighting** in messages: owned by M3 (a new M3 task: lazy-loaded markdown in `Message` and code highlighting with shiki's JavaScript regex engine, CSP R74 unchanged, owner R3-1). M2 renders plain text with native `<details>`.
- **Tool-specific renderers** (edit diff, codemode calls, MCP): M6 (`DiffView`, R50). `Reasoning`, `AuthorGroup` and `ToolCard` are M3's AI components; M3's post-merge task P3 replaces M2's `ToolRow` with `ToolCard` and M2's `ApprovalDialog` with `ApprovalCard`.
- **Transcript virtualization** (`@tanstack/react-virtual`, spec C §7.2): M4 or M13 (owner M2-Q9). M2 adds no web dependency and renders the loaded rows like pi-web.
- **R125**, parked in both plans: subscription stream keying `${stream}:${key}` waits for the first second subscription stream (M4 sessions list or M10 inbox); hidden-tab reconnect throttling is M12 ("connection-supervisor polish"). M2 adds no second stream.
- **Per-command sandbox** (bwrap, M5): once worker and tools run apart, the worker's scope goes back to R46's 512 / 768 MB (owner R2-1).
- tiptap composer and chips, images in prompts, `get_commands` slash menu (M7, M8); model, reasoning and context meter (`get_session_stats`) (M7); "show the system prompt" (R107, M7); summarizing an abandoned branch on navigation (needs a UI decision; M7).
- Settings › Approvals (list and revoke "always" rules), taint and pattern rules ("always allow `npm test …`") (M5; owner M2-Q1: exact match only). M2 ships the RPC methods and a minimal list in the session header (owner M2-Q2).
- Keybindings (Esc to stop, Ctrl+Alt+N…): M3 binds the actions M2 exports (`stopSession`, send with the preferred / other streaming behaviour); M2 adds no global key handler. M2's `CustomPanel` carries `data-terminal-input` and stops the propagation of the keys it consumes (cross-plan agreement 7).
- A resize protocol for custom panels (fixed 92 columns, as S1 and pi-web).
- Browser journeys: no Playwright anywhere for now (owner C1); M2's journeys are scripted-provider integration tests and happy-dom component tests.
- Completion sound, push for an unanswered dialog (M12).

## Global Constraints

Copied from the specs and binding rulings (source in brackets). Every task implicitly includes them.

- Node 24: "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3] Engines `>=24.14 <25` [R44].
- File size: "400 lines per file at most. No baseline, no exceptions." [C §1.4.2, R61, R62, R64b, R64c] Tests included: the split files are named in each task (M2-RT-19). The only accepted directive is `eslint-disable-next-line <rule> -- <reason>`.
- Module boundary: "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1] Production daemon code never imports a `testing/` file [R84]. Web: `features/<x>` imports only its own domain, `stores`, `runtime`, `i18n`, `@pap/ui` and contracts (eslint boundaries).
- RPC handlers: "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- Permissions: "Every RPC method declares a permission in `contracts`." [C §1.4.4] Convention [R65b]: `idempotent: true` = naturally safe to repeat, no `commandId`; `idempotent: false` = mutation, `commandId` required, receipts apply. One reasoned exception: `sessions.panelInput` (owner R2-10, noted in `methods.ts`).
- Packages: "No fourth package until a real need appears." [C §1.4.6]
- UI look: "Primitives in `packages/ui` own their look: no raw colours, no arbitrary values." [C §1.4.5] No `[…]` arbitrary values, no restyling of `@pap/ui` primitives, token classes only [AGENTS.md]. ANSI colours in extension text map to role tokens and render as React spans with token classes, never as HTML (owner C2; DESIGN.md §9.2 rule added in Task 27).
- Errors: "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1] Worker text is untrusted for size and content: clipped before logging, never forwarded raw [R66]. Bidi and control characters (`\p{Cf}`, `\p{Cc}` but `\t`) are stripped from extension text before it is shown (M2-RT-42).
- Frames: 1 MiB per message [C §4.2], measured in JSON bytes, never in characters; replay ≤ 128 events / 1 MiB else a bounded snapshot (about 75 rows, the partial message and pending dialogs, approvals first) [C §4.3]; "Deltas are coalesced every 50 ms. Large tool output stays off the stream and is fetched with `sessions.toolOutput`." [C §4.3]
- Run rules: "`agent_settled` is the only end signal", origin `user | trigger | task | extension`, steering "capped at 128 messages and 32 MiB", abort terminates after 5 s or during compaction, "At most 64 dialogs or 8 MiB. Unknown methods are cancelled automatically." [C §2.4]
- Lifecycle: "`idle → releasing → cold`: after 30 minutes idle, with no pending dialog, an empty queue and no background work." "A crashed worker is never restarted automatically." [C §2.1] Background work includes processes the agent started; a worker is released anyway after 8 hours with only those left (owner R2-2).
- Containment: "each worker runs in `systemd-run --user --scope` with `MemoryHigh`, `MemoryMax` and `TasksMax` taken from settings"; kill ladder shutdown → 2 s → SIGTERM group → 3 s → SIGKILL [C §2.5]. M2 values (owner R2-1, superseding R46's 512/768 until M5): `MemoryMax = max(2 GiB, 50 % of RAM)`, `TasksMax 4096`, `OOMPolicy=continue`, no `MemoryHigh`; `oom` is reported only for a worker that died of SIGKILL while its scope's `oom_kill` counter rose. Scopes need a lingering user manager; without linger they are off, with a boot warning (owner R2-3). Units live in a slice of their own per `PAP_HOME`.
- Approvals: "An approval card offers four answers: once, session (held in worker memory), always (persisted in `approval_rules` per project or agent; visible and revocable in Settings) and deny (the reason is returned to the model)." [C §5.3] "Project" = the git root of the session's folder, the folder itself outside git (owner R2-5). An "always" grant is never a session grant: revoking it bites the live worker (M2-RT-01). Default mode auto-accept edits [A §5.3]. "Any evaluation error blocks the call (fail closed)." [C §5.1]
- Extension compatibility: "Extensions written for the Pi CLI behave the same here. Display gaps are fixed in the client, never by inventing pap-only extension APIs." [A §3] The pi TUI is the reference.
- Pi files: "Pi owns its files; pap reads them in place and never copies them." [C §3.1] One recorded deviation: the daemon writes the *new* file of a fork or a clone through Pi's own `SessionManager`, never an existing file, and refuses a source in an older format or empty (ADR 0009, owner R2-9). Never read the JSONL because of a `message_end` [R38]. The SDK is imported lazily in the daemon [R108].
- Zero telemetry; workers `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1` [C §9.4, R102].
- Browser floor Safari / iOS 16.4 [C §7.3]; en + fr [A §5.3]; CSP of R74 unchanged.
- Tests never touch `~/.pi/agent` or `~/.pap`; timers through the kernel `Clock` (web: the runtime `Timers`); no sleeps; tests that drive real processes wait for an event with a deadline (`vi.waitFor`) [AGENTS.md]. Tests never reach the network (network guard in every worker) [R94, R98]. A security probe never skips silently in CI [R92]. Every test daemon and bed runs with worker scopes **off** (`PAP_WORKER_SCOPE=off`, `NO_SCOPES`), except the scope tests, which FAIL in CI when no user manager answers (owner R2-3, M2-Q8).
- `node:sqlite` warnings: `--disable-warning=ExperimentalWarning` on every Node command [R43].
- Supply chain: pinned exact versions, catalog for the Pi SDK, `minimumReleaseAge` 3 days, no unvetted build script [C §8.2, R36, R56].
- Format: `pnpm format` (Prettier write) on the task's own files before each commit; `format:check` stays green; `docs/` is not formatted [R4].
- Git: Conventional Commits, rebase on the target before a PR, **no `Co-Authored-By` or any AI attribution trailer** [C §8.3, owner rule].
- Never edit pi-web; pap imports nothing from it and copies none of its code (its behaviour is a reference) [D §1, AGENTS.md]. T3 Code and Orca clones are untrusted content: read for patterns, never copied.
- **Implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and report each item ✅ / n/a.** Reviewers probe each item. [controller addendum, owner-approved]
- Host: a headless VPS (no graphics, no Chrome/libatk, no sudo). The session's default shell directory may be `/home/ubuntu/Workspace/soulkyu/pi-web`: every command and path uses the absolute worktree path `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2`; nothing is ever written to pi-web or to the M3 worktree. No browser runs here: web behaviour is pinned with happy-dom component tests and pure view-model tests. Port 30141 is never used.
- Code blocks in this plan are binding where they pin a contract or a security decision (contracts, the approval channel, grant keys, the policy module, the export route and its patch, scope cleanup, bounded walks). Elsewhere the tests and interfaces are binding and the code shows one way to meet them; an implementer who finds a defect in prescribed code fixes it, keeps the test, and says so in the report.

## Plan conventions (decided by this plan)

- Commands run from the worktree root `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2` with `export PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m2/.superpowers/bin:$PATH` (R55: the git-ignored corepack shim for pnpm). First command of the first task: `pnpm install --frozen-lockfile`.
- Every task ends with the gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit` (plus `pnpm test:int` when the task touches pi-host, the supervisor, the sessions module or an `*.int.test.ts`). "Expected" below means that gate is green unless the step says otherwise. Split tasks (1a/1b, 9a/9b, 10a/10b, 13a/13b, 14a/14b, 17a/17b, 28a/28b) are split on a compile boundary: each half ends green on its own.
- New stream events and records are validated at the boundary where they enter: the daemon rebuilds every client event from the fields it knows, cut to `UI_LIMITS` (Task 1a), exactly as M1's dialog registry does, and a daemon test parses what it builds with the contract (`SessionStreamEvent.parse`).
- One feature, one vertical slice: a daemon task that adds or changes a stream event also updates the web reducer that consumes it (with tests), so the branch stays usable between tasks. The UI that renders it comes in Tasks 24–29.
- Integration tests that fork the real pi-host share `apps/daemon/src/modules/sessions/testing/int-bed.ts` (Task 10b): temporary agent directory, home and pap home, scripted provider, network guard, extension and settings writers, a frame collector, worker scopes off unless a test passes `scopes`. Test extensions are plain `.js` files written into `<agentDir>/extensions/` (Pi loads user extensions from there without project trust).
- Test disposal (M2-RT-27): service-bed tests call the test file's `open(options)` helper over `createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options)`, with the `afterEach(() => bed.dispose())` already in `service.test.ts`; no test disposes inline, and a new test file copies that `open` / `afterEach` pair (the snippets below use `open`). Int beds dispose in `finally`; temporary directories are removed in `finally` or `afterEach`; every timer a test arms is gone when it ends (`clock.pending()` 0 where it is asserted).
- 400-line splits named in advance (M2-RT-19): `packages/pi-host/src/host.commands.int.test.ts` (Tasks 2, 3), `host.approvals.int.test.ts` (13b), `host.panels.int.test.ts` (15), `policy/extension.grants.test.ts` (14b); `apps/daemon/src/modules/sessions/live-session.run.test.ts` (run cases from Task 8 on), `live-session.ui.test.ts` (dialog, approval and decoration cases from Task 13a on), `service.grants.test.ts` (14b), `testing/pi-file-writers.ts` (Pi file writers out of `service-bed.ts`, Task 11), `testing/fake-policy.ts` (14b), `live-commands.ts` (17a); `apps/web/src/features/sessions/SessionScreen.dialogs.test.tsx` (13a, 26). Existing files only get edits of their own lines.
- File names below are exact. Where a task says "move", the code moves unchanged and its tests keep passing unchanged.
- Migrations: `apps/daemon/src/modules/<m>/migrations/<YYYYMMDDHHmm>_<name>.sql`, additive only. M2 merges before M3 (owner T3): if that order ever flips, the branch merging second re-stamps its migrations after the newest stamp on `main` during its rebase (cross-plan agreement 1).
- Every task carries a **Rulings (pre-dispatch)** list: the decision for each risk, taken before dispatch from the red-team's §6 proposals as amended by the owner decisions of 2026-10-11. Each line is `M2R<n> [tasks] decision — why — cost if wrong`, the same line as in the ledger `.superpowers/rulings-m2.md`. Nothing stays open unless only implementation can discover it, and the line says so.
- Shared test helpers: never `process.kill(x ?? 0)`; the beds expose `killWorker(…)` helpers that assert `pid > 1` first (Tasks 5, 10b). Fire-and-forget promises always end in a `.catch` that logs a stable code (never a bare `() => undefined`).
- Pipelining with M3: one implementer per worktree, reviews of one milestone overlapping implementation of the other. No M2 task needs an M3 merge to start; M2 merges first (owner T3) and M3 rebases once. Every M2 i18n key goes inside the delimited `// ── sessions (M2) ──` block (no exception, agreement 4). Task 30 follows the shared bundle rule (agreement 10).
- Model escalation: a task whose review needs a 4th or 5th fix round may move that round's reviewer to Opus (owner T1); any other model change goes to the owner first.

## Review Focus

The input classes or failure modes most likely to bite a person, that no feature test naturally exercises; each line names the test that pins it.

1. **Reconnect in the middle of a reply.** A tab that loses its socket mid-stream gets a snapshot while the daemon still holds coalesced deltas not yet sent. Expected: the rebuilt reply equals Pi's text, no doubled or missing characters. Pinned by Task 9a "puts only published deltas in the snapshot's partial reply" and "rebuilds the reply exactly from a snapshot taken between two flushes and the frames after it".
2. **"Always" for a call that differs by one character, and its revocation.** Expected: a different command (one space, one hidden character, other arguments) asks again; the same command never asks again in that project, in any new worker, until it is revoked, and a revoke bites the worker that took the answer. Pinned by Task 13b "grant keys are the same for the same exact call and differ for any other", Task 14b "lets a call through on a project's always rule, matching the exact call only", "never keeps an always answer past a policy update that dropped it" and "remembers an always answer for the project across workers, and a revoke bites the live worker".
3. **A worker killed with a panel, an approval and queued steers open** (OOM, SIGKILL). Expected: cards, panels, statuses and the queue clear, the status says why, the daemon and other sessions keep working, nothing the worker started survives. Pinned by Task 22 "a worker killed with a card, a panel and queued steers open: everything clears, the daemon and the other sessions carry on" and Task 5 "stops the scope after the worker dies, so what it started in a group of its own dies too (R100)".
4. **Opening an exported transcript.** It is HTML written from model output. Expected: it downloads; it never runs as a page of the pap origin. Pinned by Task 18 "answers as an attachment with a sandbox CSP and nosniff, once, then deletes the file".
5. **A prompt that arrives while the idle timer releases the worker.** Expected: the prompt starts a fresh worker on the same Pi file; it is never sent to the stopping worker nor lost. Pinned by Task 20 "a prompt during releasing waits for the exit and reopens on the same file (Review Focus 5)".
6. **A Pi file with a cycle** (an entry that is its own parent, A→B→A: the agent, an extension or the Pi CLI can write one). Expected: the snapshot, a history page and the fork points return a finite answer; the daemon's event loop never spins. Pinned by Task 10a "returns a finite page and fork points for a self-cycle and a 2-cycle".
7. **A reconnect while an extension floods decorations and an approval waits.** Expected: the snapshot keeps the approval, stays under 1 MB, and says decorations were cut. Pinned by Task 1b "keeps a pending approval and stays under the frame budget with ANSI-heavy widgets".

---

## File structure

```
packages/contracts/src/
  policy.ts                 NEW (1a) TOOL_CATEGORIES, ApprovalAnswer, GrantKey, AlwaysRule, PolicyRules, AuditEntry (moved from pi-host.ts)
  streams.ts                1a additive schemas (UI_LIMITS, TranscriptRow, PartialMessage, StatusEntry, Widget, Panel, Notice, QueueView,
                            HistoryMeta, Activity, EntryRef, defaults, Dialog + approval, DialogResponse + answer);
                            1b breaking (snapshot v2, SessionStreamEvent v2, SessionStatus + releasing); 11 ForkChoice / ForkPoint;
                            17b SessionSummary.name
  pi-host.ts                1a new records (ready leaf and name, approval_request, custom_*, approval_response); 20 health.descendants
  methods.ts · errors.ts · permissions.ts · frames.ts (PROTOCOL_VERSION 2 in 1b)
packages/pi-host/src/
  dispatch.ts               NEW (2)   command switch (moved out of host.ts); exhaustive from Task 15
  session-commands.ts       NEW (2)   clear_queue, compact, navigate_tree, set_session_name, export_html
  auto-name.ts · title.ts   NEW (3)   auto_name: transcript → title through the session's model
  shutdown.ts               NEW (4)   session_shutdown then dispose, bounded by the grace
  approvals.ts              NEW (13b) approval_request / approval_response channel
  policy/grant-key.ts       NEW (13b) sha256 of tool, payload kind and exact payload
  ansi-theme.ts             NEW (15)  the theme extensions get: basic ANSI SGR colours (owner C2), not the plain theme
  custom-panels.ts          NEW (15)  ctx.ui.custom() over custom_render / custom_input / custom_close (S1)
  widget-components.ts      NEW (15)  setWidget component factories rendered as lines; renders coalesced every 50 ms
  host.ts · ipc.ts · ui-bridge.ts · wire-events.ts · descendants.ts · open-session.ts · policy/extension.ts   changed
  dispatch.test.ts (2) · host.commands.int.test.ts (2, 3) · host.approvals.int.test.ts (13b) · host.panels.int.test.ts (15)
  policy/extension.grants.test.ts (14b)                                                         NEW test files (400-line splits)
apps/daemon/src/
  kernel/supervisor/scope.ts      NEW (5)  linger and user-manager probe, per-PAP_HOME slice, wrap, OOM baseline, reap, boot sweep, slice kill
  kernel/supervisor/worker-io.ts  NEW (5)  moved helpers of worker.ts (tail, bounded records, timeouts)
  kernel/which.ts                 NEW (5)  whichOnPath, execFileText
  kernel/supervisor/{worker,exit}.ts · kernel/config.ts · kernel/home.ts · daemon.ts · main.ts · testing/harness.ts   changed
  modules/sessions/
    live-session.ts               core of one worker's session (split in Task 7)
    live-run.ts · live-ui.ts · worker-text.ts · service-reads.ts            NEW (7)
    coalescer.ts · partial.ts     NEW (9a)
    wire-clip.ts                  NEW (9b)
    branch.ts · entries-cache.ts  NEW (10a) bounded branch walks; byte-bounded, incremental parse cache
    queue-guard.ts                NEW (12)
    decorations.ts · panels.ts · notices.ts · keyed-throttle.ts             NEW (16)
    live-commands.ts · service-commands.ts                                  NEW (17a) commands in flight, busy rule, activity
    names.ts                      NEW (17b) nameOf(): the one clip of a session name
    exports.ts · export-http.ts · export-patch.ts                           NEW (18)
    pi-writer.ts · forks.ts       NEW (19)
    idle-release.ts               NEW (20)
    service.ts · rpc.ts · index.ts · snapshot.ts · transcript.ts · dialogs.ts · store.ts   changed
    testing/int-bed.ts (10b) · testing/extensions.ts (21) · testing/pi-file-writers.ts (11) · testing/fake-policy.ts (14b)   NEW beds
    live-session.run.test.ts (8) · live-session.ui.test.ts (13a) · service.grants.test.ts (14b)                             NEW test files
    migrations/202610110000_session_name.sql                                NEW (17b)
  modules/policy/                 NEW module (14a): index.ts, service.ts, store.ts, rpc.ts, project-scope.ts,
                                  migrations/202610110100_policy.sql
apps/web/src/
  runtime/rpc.ts                  call(method, params, { commandId }), newCommandId() (24)
  stores/session-reducer.ts · row-view.ts (1b) · partial-view.ts · reduce-pi.ts (9b) · reduce-ui.ts (16) · history.ts (11)
  stores/drafts.ts                NEW (24) drafts and pending sends in localStorage, cleared on sign-out
  features/auth/auth-api.ts       logout() clears drafts and pending sends (24, owner R2-4)
  features/sessions/
    SessionScreen.tsx (layout only) · Transcript.tsx · MessageRow.tsx · ToolRow.tsx · Composer.tsx · QueueStrip.tsx
    dialogs/{ApprovalDialog,SelectDialog,TextDialog,ConfirmDialog,DialogList}.tsx
    StatusBar.tsx · Widgets.tsx · CustomPanel.tsx · AnsiText.tsx · SessionActions.tsx · BranchSwitcher.tsx · AlwaysRules.tsx · Minimap.tsx
    transcript.vm.ts · composer.vm.ts · status-cells.ts · ansi.ts · terminal-keys.ts · minimap.vm.ts · branches.vm.ts
  i18n/en.ts · fr.ts              every M2 key inside the delimited `sessions (M2)` block, no exception
.github/workflows/ci.yml · pi-compat.yml   a systemd user manager for the runner before the integration tests (6, owner M2-Q8)
DESIGN.md                         §9.2 "ANSI colours in extension text" rule (27, owner C2)
docs/adr/0006-session-export-download-route.md · 0007-hot-session-reads-from-the-pi-file.md
         0008-pap-records-added-in-m2.md · 0009-daemon-side-fork-and-clone.md
docs/agents/sessions.md · daemon.md   updated (30)
```

## Protocol v2 at a glance

| Direction | New or changed | Purpose |
|---|---|---|
| daemon → worker | `clear_queue{id}` `compact{id,customInstructions?}` `navigate_tree{id,targetId}` `set_session_name{id,name}` `export_html{id,outputPath}` `auto_name{id}` | session commands (Pi RPC shapes; `auto_name` is pap) |
| daemon → worker | `custom_input{id,data}` `custom_cancel{id}` `approval_response{id,answer,cancelled?}` | panels, approvals (`cancelled: true` = closed unanswered, never "denied by the user") |
| worker → daemon | `ready{…, leafId, sessionName}` (both default to null) · `health{rssMb, descendants}` (Task 20) | leaf and name at start; live processes the agent started |
| worker → daemon | `custom_render{id,lines}` `custom_close{id}` `approval_request{id,category,title,message,answers,tool,key}` | panels, approvals |
| worker → daemon (Pi events, slimmed by `toWireEvent`) | `entry_appended{entry: slim}` `queue_update{steering,followUp,count,bytes}` | entry ids and leaf, queue |
| stream | `snapshot` v2 (approvals first, decorations under their own byte budget, `decorationsTruncated`), `row`, `entry`, `queue`, `status_bar`, `widget`, `title`, `editor_text`, `panel`, `panel_closed`, `name`, `activity`; `notice.source` (`extension` for extension text, owner R2-8) | see Tasks 1a, 1b |
| methods | `sessions.history` `sessions.toolOutput` `sessions.branches` `sessions.clearQueue` `sessions.panelInput` `sessions.navigate` `sessions.compact` `sessions.rename` `sessions.autoName` `sessions.exportHtml` `sessions.fork` `sessions.clone` `policy.listRules` `policy.revokeRule` | Tasks 11–19, 14a |
| HTTP | `GET /api/sessions/:sessionId/export/:token` | Task 18, ADR 0006 |

---

## Pre-execution conflict scan

Tasks run one at a time, in order. Pairs below share files or interfaces; the later task rebases on the earlier one's result and must not undo it. The files shared with M3 are listed in "Merge order and conflict notes".

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1a → 1b → 2–4, 13a, 13b, 15 | `packages/contracts/src/{pi-host,streams}.ts`, `packages/pi-host/src/host.ts` | 1a adds every record and additive schema; 1b changes the snapshot and the stream union. Later tasks only handle them. Task 2 moves the switch to `dispatch.ts`; Tasks 3, 13b, 15 add `case`s there; Task 15 makes it exhaustive. |
| 1b → 9a–19 | `packages/contracts/src/streams.ts`, `apps/web/src/stores/*` | 1b splits the reducer; later tasks fill `reduce-pi.ts` (9b) / `reduce-ui.ts` (16). |
| 2 → 14b | `dispatch.ts` `policy_update` | Task 2 makes a malformed update drop the always rules (fail closed, M2-RT-17); Task 14b clears the provisional always grants on every valid update. |
| 4 → 13b, 15 | `Ipc.send(): boolean`, `createUiBridge(send)` | Task 4 changes `send` to return whether the record left; 13b and 15 rely on it. |
| 4 → 20 | `descendants.ts`, the `health` record | Task 20 counts live descendants with Task 4's walk. |
| 5 → 6 → 20, 22 | `spawnWorker(options.scope)`, `WorkerScopes`, `Config` worker fields | Task 5 adds the scope option; Task 6 wires config, boot and CI; Task 20 uses `workerIdleMs`. |
| 7 → 8–20 | `modules/sessions/live-session.ts`, `live-run.ts`, `live-ui.ts`, `service.ts`, `service-reads.ts` | Task 7 splits without behaviour change; every later sessions task edits the split files, never re-merges them. |
| 9a → 9b → 10a, 11 | `coalescer.ts`, `partial.ts`, `wire-clip.ts` (`clipMessage`) | Task 10a applies Task 9b's clipping to rows read from files. |
| 10a → 10b → 11, 17a, 19 | `TranscriptReader.page/forks/toolCall`, `LiveSession.leafId()` | One reader; leaf tracking lives in `live-session.ts`. |
| 12 → 24 | `QueueView`, `sessions.clearQueue` | Composer restores cleared texts. |
| 13a → 13b → 14b, 21, 26 | `approval_request`, `Dialog.method "approval"`, `DialogResponse.answer`, `DialogRegistry.offerApproval`, `grantKey` | 13a lands the daemon side first, so the pi-host switch of 13b finds it; Task 14b adds grants on top; Task 26 renders four answers. |
| 14a → 14b → 28b | `PolicyPort`, `projectScopeOf`, `policy.listRules` | The module stands alone in 14a; sessions use it from 14b. |
| 15 → 16 → 21, 27 | `custom_*` records, `panels.ts`, `decorations.ts`, the ANSI theme → `ansi.ts` | — |
| 17a → 17b → 19, 28a | `live-commands.ts`, `sessions` column `name`, `SessionSummary.name`, `store.setName`, `nameOf` | Clone names its copy. |
| 6, 14a, 18 | `apps/daemon/src/daemon.ts` composition | Each adds its own lines (scopes and sweep, policy module, export route). |
| 1a, 1b, 17a, 24–29 | `apps/web/src/i18n/en.ts`, `fr.ts` | Keys appended inside the `sessions (M2)` block in task order. |
| 24 → 25 | `features/sessions/SessionScreen.tsx` | Task 24 makes it a layout of `Transcript` + `Composer`; later UI tasks add children only. |

## Model table

Owner cost rules: Haiku for mechanical transcription, Sonnet by default, Opus reviewer only where a wrong change is a security hole or a race, Opus for the final whole-branch review. This table is the owner's (X2, 2026-10-11); any change goes to the owner first.

| # | Task | Implementer | Reviewer | Why Opus (reviewer) |
|---|---|---|---|---|
| 1a | Protocol v2 contracts (additive) | Sonnet | Sonnet | |
| 1b | Protocol v2 snapshot, consumers, reducer split | Sonnet | Sonnet | |
| 2 | pi-host session commands | Sonnet | Sonnet | |
| 3 | pi-host auto-name | Sonnet | Sonnet | |
| 4 | pi-host lifecycle parity (R106) | Sonnet | Sonnet | |
| 5 | Supervisor: systemd scopes | Sonnet | **Opus** | containment: per-home slice, linger, OOM attribution, reap and sweep; a mistake leaks processes or kills another daemon's unit |
| 6 | Config, boot probe, R118 harness check, CI user manager | Sonnet | Sonnet | |
| 7 | Sessions module split (no behaviour change) | Sonnet | Sonnet | (was Haiku: not mechanical, M2-RT-40) |
| 8 | Run semantics backlog (R112, R113) | Sonnet | **Opus** | run-tracker races (abort before `agent_start`, stale probes across runs) |
| 9a | Coalescing and the partial reply | Sonnet | **Opus** | ordering between buffered deltas, the snapshot's partial and stream seq |
| 9b | Wire clipping, web partial and tools view | Sonnet | Sonnet | |
| 10a | Branch reader and entries cache (bounded), ADR 0007 | Sonnet | Sonnet | the plan carries M2-RT-03/15's bounded walks and cache (red-team condition for Sonnet) |
| 10b | Leaf tracking, entry and row events, int bed | Sonnet | Sonnet | |
| 11 | Reads: history, tool output, branches | Sonnet | Sonnet | |
| 12 | Steering queue and its cap | Sonnet | Sonnet | |
| 13a | Approval channel, daemon side | Sonnet | **Opus** | security: answer mapping, an answer the card did not offer, a cancelled approval |
| 13b | Approval channel, pi-host side | Sonnet | **Opus** | security: the policy's question must come only from the policy, closed = fail closed, grant keys |
| 14a | `policy` module | Sonnet | Sonnet | |
| 14b | Session and always grants wired | Sonnet | **Opus** | security: persisted allow rules, exact matching, revocation reaching live workers |
| 15 | pi-host custom panels, widget factories, ANSI theme | Sonnet | Sonnet | |
| 16 | Daemon decorations, panels, notices | Sonnet | Sonnet | |
| 17a | navigate, compact, activity, busy rule | Sonnet | **Opus** | busy-rule races, leaf after a slow hook, outcome unknown, compaction aborting a pending prompt |
| 17b | rename, auto-name, names | Sonnet | Sonnet | |
| 18 | HTML export download and patch | Sonnet | **Opus** | serves model-authored HTML from the daemon origin: XSS, token, path |
| 19 | Fork and clone | Sonnet | Sonnet | |
| 20 | Idle release | Sonnet | **Opus** | release racing prompts, double stops, status ordering |
| 21 | D18 end-to-end integration | Sonnet | Sonnet | |
| 22 | Crash containment integration | Sonnet | Sonnet | |
| 23 | R45 revisit and budgets | Sonnet | Sonnet | |
| 24 | Web composer | Sonnet | Sonnet | probes: Stop ordering, `editorText` remount, exactly-once resend (M2-RT §4) |
| 25 | Web transcript | Sonnet | Sonnet | |
| 26 | Web dialogs | Sonnet | Sonnet | |
| 27 | Web extension UI | Sonnet | Sonnet | |
| 28a | Web session actions, fork and edit from a message | Sonnet | Sonnet | |
| 28b | Web branch switcher, always rules | Sonnet | Sonnet | |
| 29 | Web minimap | Sonnet | Haiku | |
| 30 | Docs, ADR check, final gates | Sonnet | Sonnet | |
| — | Whole-branch review | — | **Opus** | owner rule |

Totals: 37 tasks; implementers 37 Sonnet; reviewers 27 Sonnet + 9 Opus (Tasks 5, 8, 9a, 13a, 13b, 14b, 17a, 18, 20) + 1 Haiku (Task 29); one Opus whole-branch review. Fix rounds 4–5 of any task may use an Opus reviewer (owner T1).

## ETA

Observed in M1: about 1–1.5 h per task including review and fix rounds, longer for security tasks. 37 right-sized tasks × 1.25 h ≈ 46 h; plus about 0.5 h for each of the 9 Opus-reviewed tasks (4.5 h); plus about 3 h for the whole-branch review and its fix round; plus about 3 h of slow real-worker integration fix rounds (scopes, idle release, crash containment), which the red-team counted (≈ 56.5 h). On top, what the owner decisions added after the red-team's count: the ANSI theme and colour mapping (≈ 1 h), the export patch with its test against Pi's real output (≈ 1.5 h), the CI user manager and linger probe (≈ 0.5 h), live descendants and the 8 h cap (≈ 0.5 h): ≈ 3.5 h. **≈ 60 h of agent time (range 55–65 h)**, run sequentially. Tasks 24–29 (web) can start once Tasks 1a–20 are merged into the branch.

---
## Tasks

### Task 1a: Protocol v2 contracts — the additive half (records, schemas, errors, permissions)

Every later task consumes these shapes. This half only adds: new records, new schemas, new errors, the `policy` permission domain. Nothing a consumer already uses changes shape except `PolicyRules` (a defaulted field) and `ready` (two defaulted fields), so the gate stays green without touching the snapshot. Task 1b makes the breaking change (snapshot v2, stream union v2, `PROTOCOL_VERSION` 2).

**Rulings (pre-dispatch):**
- **M2R1** [1a, 1b] Task 1 is split on a compile boundary rather than as "contracts / consumers": 1a adds what no consumer breaks on; 1b changes the snapshot, the stream union and `PROTOCOL_VERSION` together with every consumer — a contracts-only half would leave the daemon and the web app uncompilable at its gate — cost if wrong: one red gate between two tasks.
- **M2R2** [1a] `PolicyRules.alwaysAllow` defaults to `[]`; every `PolicyRules` literal (`service.ts` `INTERACTIVE_POLICY`, pi-host `testing/policy-bed.ts` `interactiveRules`) gains `alwaysAllow: []` — a fail-closed default that only literals notice — cost if wrong: none.
- **M2R3** [1a] `UI_LIMITS` as written (owner M2-Q15): statuses 32 × 512, widgets 8 × 50 lines × 512, panels 4 × 200 lines × 512, notices 20 × 2000, queue previews 128 × 2000; they count characters, and bytes are bounded separately by the snapshot's decoration budget (Task 1b, M2-RT-05) — characters are not bytes (an ESC is 6 JSON bytes) — cost if wrong: an approval pushed out of a reconnect snapshot.
- **M2R4** [1a, 10b, 17b] `ready.leafId` and `ready.sessionName` default to `null` and stay unbounded in the record (the worker's view); the daemon clips: a leaf id over 128 characters is treated as unknown (Task 10b), a name goes through `nameOf` (Task 17b) — refusing an over-long name in the record would make the session unopenable (M2-RT-06) — cost if wrong: a session that never reopens.
- **M2R5** [1a] The `answers` of `Dialog` and of `approval_request` must be distinct (`ApprovalAnswers` refine, M2-RT-21) — duplicate React keys otherwise — cost if wrong: a card that renders one answer twice.
- **M2R6** [1a, 13a, 13b] `approval_response` carries an optional `cancelled: true`: an approval the daemon could not show (limits, malformed) is answered `cancelled`, which pap-policy maps to `FAIL_CLOSED_REASON` with audit reason `dialog closed`, never "Denied by the user." (M2-RT-22) — the model must not be told a person refused a card nobody saw — cost if wrong: a model that changes course believing a human said no.
- **M2R7** [1a, 1b, 17a, 24–29] Every M2 i18n key — the new `error.*` messages and `session.status.releasing` included — goes inside the delimited `sessions (M2)` block (cross-plan agreement 4, M2-RT-O-1): lookups are by key, position is irrelevant — M3's rebase then has one block to look at — cost if wrong: merge conflicts in M3's i18n hotspots.

**Files:**
- Create: `packages/contracts/src/policy.ts`, `packages/contracts/src/streams.test.ts`
- Modify: `packages/contracts/src/{streams,pi-host,errors,permissions,index}.ts`, `packages/contracts/src/pi-host.test.ts`
- Modify: `packages/pi-host/src/host.ts` (the two `ready` fields), `packages/pi-host/src/testing/policy-bed.ts` (`interactiveRules.alwaysAllow`)
- Modify: `apps/daemon/src/modules/sessions/service.ts` (`INTERACTIVE_POLICY.alwaysAllow`), `service.test.ts` (the `init` expectation gains `alwaysAllow: []`), the `ready` fixtures typed as `WorkerRecord` (`apps/daemon/src/kernel/testing/fake-worker.test.ts`, `apps/daemon/src/modules/sessions/testing/{live-bed,service-bed}.ts`, `apps/daemon/src/modules/sessions/index.test.ts`: `leafId: null, sessionName: null`; the JavaScript fixture of `kernel/testing/rogue-bed.ts` needs nothing, the fields default), any test that lists `ALL_PERMISSIONS` (it gains `policy:read|operate|admin`)
- Modify: `apps/web/src/i18n/{en,fr}.ts` (the delimited block and the three new error messages)

**Interfaces:**
- Consumes: M1 contracts.
- Produces (all exported from `@pap/contracts`):
  - `policy.ts`: `TOOL_CATEGORIES`, `ToolCategory`, `ApprovalAnswer` (`"once"|"session"|"always"|"deny"`), `ApprovalAnswers` (2 to 4, distinct), `GrantKey`, `AlwaysRule {tool,key}`, `MAX_ALWAYS_RULES = 1000`, `PolicyRules {profile, approvalMode, alwaysAllow}` (`alwaysAllow` defaults to `[]`), `AuditEntry` (moved).
  - `streams.ts` (additive only; the snapshot and the event union change in 1b): `UI_LIMITS`, `Dialog` (+`approval`, `category?`, `answers?`), `DialogResponse` (+`{answer}`), `TranscriptRow {entryId: string|null, message: unknown}`, `PartialBlock`, `PartialMessage {blocks}`, `StatusEntry`, `Widget`, `Panel`, `Notice {level, text, source?}`, `QueueView`, `HistoryMeta`, `Activity`, `EntryRef`, `EMPTY_QUEUE`, `IDLE_ACTIVITY`, `NO_HISTORY`.
  - `pi-host.ts`: commands `clear_queue`, `compact`, `navigate_tree`, `set_session_name`, `export_html`, `auto_name`; records `custom_input`, `custom_cancel`, `approval_response{id, answer, cancelled?}` (daemon → worker); `ready{leafId, sessionName}` (both default `null`), `custom_render`, `custom_close`, `approval_request` (worker → daemon); `CommandInput` covers every command.
  - `errors.ts`: `queue_full`, `session_busy`, `session_empty`. `permissions.ts`: domain `policy`.

- [ ] **Step 1: Install and write the failing contract tests**

Run: `pnpm install --frozen-lockfile`

`packages/contracts/src/streams.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Dialog, DialogResponse, EMPTY_QUEUE, NO_HISTORY, Notice, Panel, StatusEntry, UI_LIMITS } from "./index.ts";

const approval = { id: "a1", method: "approval", title: "Run a command?", message: "1 line\nbash: ls", category: "exec" };

describe("session stream v2 schemas (additive)", () => {
  it("opens an approval with distinct answers only", () => {
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "session", "always", "once"] }).success).toBe(true);
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "deny"] }).success).toBe(false);
    expect(Dialog.safeParse({ ...approval, answers: ["deny"] }).success).toBe(false);
  });

  it("answers an approval with one of four answers", () => {
    expect(DialogResponse.safeParse({ answer: "always" }).success).toBe(true);
    expect(DialogResponse.safeParse({ answer: "forever" }).success).toBe(false);
  });

  it("bounds what extensions put on screen", () => {
    expect(StatusEntry.safeParse({ key: "k", text: "x".repeat(UI_LIMITS.statusText + 1) }).success).toBe(false);
    const lines = Array.from({ length: UI_LIMITS.panelLines + 1 }, () => "x");
    expect(Panel.safeParse({ id: "p", lines }).success).toBe(false);
    expect(Notice.safeParse({ level: "info", text: "hi", source: "extension" }).success).toBe(true);
    expect(Notice.safeParse({ level: "info", text: "hi", source: "someone" }).success).toBe(false);
  });

  it("starts the defaults empty", () => {
    expect(EMPTY_QUEUE).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
    expect(NO_HISTORY).toEqual({ hasMore: false, oldestEntryId: null, turnsBefore: 0 });
  });
});
```

Append to `packages/contracts/src/pi-host.test.ts` (and add `PolicyRules` to the file's existing import from `./index.ts`):

```ts
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
    expect(parseWorkerRecord({ ...approval, answers: ["once", "once"] })).toBeNull();
    expect(parseWorkerRecord({ type: "custom_render", id: "p1" })).toBeNull();
  });

  it("defaults the leaf and name of ready to null", () => {
    const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "abc", piVersion: "1.1.0" };
    expect(parseWorkerRecord(ready)).toEqual({ ...ready, leafId: null, sessionName: null });
    expect(parseWorkerRecord({ ...ready, leafId: "e9", sessionName: "Fix login" })).toEqual({ ...ready, leafId: "e9", sessionName: "Fix login" });
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
    { type: "approval_response", id: "a1", answer: "deny", cancelled: true },
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

Also add `"custom_render", "custom_close", "approval_request"` to `PAP_RECORD_TYPES` in the existing routing test, and the first test's `ready` expectation becomes `{ ...ready, leafId: null, sessionName: null }`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts`
Expected: FAIL (`UI_LIMITS`, `PolicyRules.alwaysAllow`, the new records are missing).

- [ ] **Step 3: Write `policy.ts`, the additive schemas and the records**

`packages/contracts/src/policy.ts` (`TOOL_CATEGORIES` and `AuditEntry` move here from `pi-host.ts` unchanged, so `streams.ts` and `pi-host.ts` can both import them without importing each other):

```ts
import { z } from "zod";

export const TOOL_CATEGORIES = ["read", "edit", "exec", "network", "external-write", "unknown"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** The four answers of an approval card (spec C §5.3). */
export const ApprovalAnswer = z.enum(["once", "session", "always", "deny"]);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;
/** The answers a card offers, in card order: two to four, each at most once (M2-RT-21). */
export const ApprovalAnswers = z
  .array(ApprovalAnswer)
  .min(2)
  .max(4)
  .refine((answers) => new Set(answers).size === answers.length, "each answer at most once");

/** sha256 (lowercase hex) of a tool name, the payload's kind and the call's exact payload, computed by pap-policy (Task 13b). */
export const GrantKey = z.string().regex(/^[0-9a-f]{64}$/);
export const AlwaysRule = z.object({ tool: z.string().min(1).max(256), key: GrantKey });
export type AlwaysRule = z.infer<typeof AlwaysRule>;
export const MAX_ALWAYS_RULES = 1000;

export const PolicyRules = z.object({
  profile: z.literal("interactive"),
  approvalMode: z.enum(["auto-accept-edits"]),
  /** "Always" answers of this project (Task 14b). Absent in M1 rules, so it defaults to none. */
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

`packages/contracts/src/streams.ts`: `SessionStatus`, `PiEvent`, the M1 `SessionStreamEvent` and `SessionSummary` stay as they are in this task; the file gains, after the `STREAMS` lines:

```ts
import { ApprovalAnswer, ApprovalAnswers, TOOL_CATEGORIES } from "./policy.ts";

/**
 * The most the daemon passes on from a worker for each extension UI surface (R66). The daemon rebuilds every client
 * event from the fields it knows, cut to these, so an extension that loops or lies cannot grow a frame or a snapshot.
 * They count characters; the snapshot also bounds decorations in bytes (Task 1b).
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
```

and `Dialog` / `DialogResponse` become:

```ts
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
  answers: ApprovalAnswers.optional(),
});
export type Dialog = z.infer<typeof Dialog>;

export const DialogResponse = z.union([
  z.object({ confirmed: z.boolean() }),
  z.object({ value: z.string().max(1_000_000) }),
  z.object({ cancelled: z.literal(true) }),
  z.object({ answer: ApprovalAnswer }),
]);
export type DialogResponse = z.infer<typeof DialogResponse>;
```

and, before `SessionStreamEvent`, the additive schemas:

```ts
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
  /** `extension`: the text is an extension's own (`ctx.ui.notify`), labelled so in the UI (owner R2-8). Absent: pap's text. */
  source: z.enum(["pap", "extension"]).optional(),
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
```

`packages/contracts/src/pi-host.ts`: delete `PolicyRules`, `TOOL_CATEGORIES`, `ToolCategory` and `AuditEntry` (now in `policy.ts`), import `ApprovalAnswer`, `ApprovalAnswers`, `AuditEntry`, `GrantKey`, `TOOL_CATEGORIES` from `./policy.ts`, keep `InitRecord`, `UiResponseRecord`, `ResponseRecord`, `UiRequestRecord`, `parseWorkerRecord`, `PAP_TYPES` (derived, R67) and `GetStateData` as they are, and add:

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
/**
 * `cancelled`: the daemon could not show the question (limits, malformed). pap-policy treats it as a closed
 * question (fail closed, audit "dialog closed"), never as the user's refusal (M2-RT-22).
 */
const ApprovalResponseRecord = z.object({
  type: z.literal("approval_response"),
  id: Id,
  answer: ApprovalAnswer,
  cancelled: z.literal(true).optional(),
});

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
  /**
   * Pi's current leaf: where the next entry goes and what the transcript of a hot session shows (Task 10b). Not
   * bounded here: the daemon treats one over 128 characters as unknown (M2-RT-06).
   */
  leafId: z.string().nullable().default(null),
  /** The session's name in Pi; the daemon clips it with `nameOf` (Task 17b). */
  sessionName: z.string().nullable().default(null),
});
export const CustomRenderRecord = z.object({ type: z.literal("custom_render"), id: Id, lines: z.array(z.string()) });
const CustomCloseRecord = z.object({ type: z.literal("custom_close"), id: Id });
/**
 * The policy's own question (Task 13b). The extension API cannot send it (`ctx.ui` has no approval method); code
 * inside the worker process could, which is R101's residual (ADR 0008).
 */
export const ApprovalRequestRecord = z.object({
  type: z.literal("approval_request"),
  id: Id,
  category: z.enum(TOOL_CATEGORIES),
  title: z.string().max(4096),
  message: z.string().max(65_536),
  answers: ApprovalAnswers,
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

with messages `queue_full: "Too many messages are waiting in this session. Wait for the agent, or clear the queue."`, `session_busy: "The session is working. Wait for it to finish, or stop it first."`, `session_empty: "This session has no messages to work with yet."` (compaction, naming, fork and clone all use it). `permissions.ts`: `DOMAINS = ["system", "auth", "sessions", "policy"] as const`.

- [ ] **Step 4: Keep every consumer compiling**

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

(read `sessionName` from the SDK's `AgentSession` `.d.ts`; if it is only on `sessionManager`, use that getter). `testing/policy-bed.ts`: `interactiveRules` gains `alwaysAllow: []`. `service.ts`: `INTERACTIVE_POLICY` gains `alwaysAllow: []`; `service.test.ts`'s `init` expectation follows. The typed `ready` fixtures listed in Files gain `leafId: null, sessionName: null`. If a consumer switches exhaustively on `Dialog.method`, it gets a `default` that keeps M1's "unsupported" line for `approval` until Task 13a.

`apps/web/src/i18n/en.ts`, at the end of the object, the delimited block every later task fills:

```ts
  // ── sessions (M2): every key of M2, in task order; lookups are by key, position is irrelevant ──
  "error.queue_full": "Too many messages are waiting in this session. Wait for the agent, or clear the queue.",
  "error.session_busy": "The session is working. Wait for it to finish, or stop it first.",
  "error.session_empty": "This session has no messages to work with yet.",
  "sessions.queue.title": "Waiting",
  // ── end sessions (M2) ──
```

`fr.ts` mirrors it inside the same markers: `"error.queue_full": "Trop de messages attendent dans cette session. Attendez l'agent, ou videz la file."`, `"error.session_busy": "La session travaille. Attendez qu'elle finisse, ou arrêtez-la d'abord."`, `"error.session_empty": "Cette session n'a encore aucun message à traiter."`, `"sessions.queue.title": "En attente"`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit && pnpm test:int packages/pi-host/src/host.int.test.ts`
Expected: PASS (the i18n test checks that every error code has an en and fr message and that fr differs from en).

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip`

```bash
git add packages/contracts packages/pi-host/src apps/daemon/src apps/web/src/i18n
git commit -m "feat(contracts): protocol v2 records, schemas and errors"
```

---

### Task 1b: Protocol v2 snapshot — the breaking half (snapshot v2, stream union, reducer split)

The snapshot changes shape (`messages` → `rows` with entry ids, plus new sections), so `PROTOCOL_VERSION` goes to 2: an M1 tab gets "new version, reload" from the `?proto=` gate instead of a snapshot it cannot parse.

**Rulings (pre-dispatch):**
- **M2R8** [1b] `PROTOCOL_VERSION` → 2: every open M1 tab shows "new version, reload" (intended) — the snapshot shape changes and the gate already exists — cost if wrong: one reload per open tab.
- **M2R9** [1b, 16] Snapshot fill order: the fixed sections, then approval dialogs, then the other dialogs (emitted in their original order), then decorations — statuses, the newest notices, widgets oldest first — under their own `DECORATION_BYTES = 256 KiB` measured in JSON bytes with `decorationsTruncated: true` when anything was left out, then panels, the partial reply, the rows (M2-RT-05) — an approval must survive a reconnect whatever extensions draw — cost if wrong: a run waiting on a card the user cannot see.
- **M2R10** [1b] The daemon proves what it builds: a test parses `fitSnapshot` of adversarial inputs with `SessionStreamEvent`; `status.cause` is bounded (256); a client snapshot that fails to parse sets `unreadable` and the screen says "This session could not be shown." instead of staying blank (M2-RT-06) — failures must be visible — cost if wrong: a blank session with no error.
- **M2R11** [1b, 17a] Default request timeouts: none for `prompt`, `compact` and `navigate_tree` (written reason: each can wait on the model or on an extension hook that asks the user — `session_before_tree` hooks may await dialogs, M2-RT-08 — like `prompt`, R99); 120 s for `auto_name` and `export_html`; 30 s otherwise — a navigate that timed out could still move Pi's leaf later and leave the daemon's view stale — cost if wrong: a navigation whose hook never answers stays pending until its dialog is answered or the worker stops.
- **M2R12** [1b] ADR 0008 says only what holds: the extension API cannot raise a policy card, in-process code can (R101 residual); an older worker answers a new command `malformed record`, never silence; the pi-host dispatch is exhaustive from Task 15 (M2-RT-23) — no overclaim in docs — cost if wrong: a reader trusts a guarantee that does not exist.

**Files:**
- Modify: `packages/contracts/src/{streams,frames}.ts`, `packages/contracts/src/streams.test.ts`
- Modify: `apps/daemon/src/kernel/supervisor/worker.ts` (`requestTimeoutMs`), `apps/daemon/src/kernel/supervisor/worker.test.ts`, `scripts/smoke-dist.ts` (its own `const PROTOCOL = 1` becomes `2`: the smoke drives the built daemon without importing the contracts)
- Modify: `apps/daemon/src/modules/sessions/{snapshot,service}.ts`, `snapshot.test.ts`, `service.snapshot.test.ts`, `sessions.int.test.ts`, `apps/daemon/src/kernel/ws/{ws-server.test,ws-server.int.test}.ts` (`?proto=${PROTOCOL_VERSION}`)
- Create: `apps/web/src/stores/row-view.ts`; Modify: `apps/web/src/stores/session-reducer.ts`, `session-reducer.test.ts`, `apps/web/src/features/sessions/SessionScreen.tsx` (the unreadable line), `SessionScreen.test.tsx` (its `snapshot()` helper sends v2 rows; one case for the unreadable line), `apps/web/src/i18n/{en,fr}.ts`
- Create: `docs/adr/0008-pap-records-added-in-m2.md` (spec C §2.3 lists the records; the ones M2 adds are a deviation, recorded like ADR 0001)

**Interfaces:**
- Consumes: Task 1a schemas.
- Produces:
  - `streams.ts`: `SessionStatus` (+`releasing`), `SessionStreamEvent` v2 (kinds `snapshot`, `status{cause ≤ 256}`, `pi`, `dialog_open`, `dialog_closed`, `notice{level, text, source?}`, `row`, `entry`, `queue`, `status_bar`, `widget`, `title`, `editor_text`, `panel`, `panel_closed`, `name`, `activity`), `SnapshotEvent` (with `decorationsTruncated`). `frames.ts`: `PROTOCOL_VERSION = 2`.
  - Daemon: `requestTimeoutMs(command)` = none for `prompt`, `compact` and `navigate_tree`, 120 s for `auto_name` and `export_html`, 30 s otherwise. `fitSnapshot(input: SnapshotInput): SnapshotEvent` with the v2 sections, `DECORATION_BYTES`, `PARTIAL_BYTES`, `fitRow`.
  - Web: `MessageView` gains `entryId: string | null`; `toMessageView(raw, entryId)` lives in `stores/row-view.ts`; `SessionView.unreadable: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/src/streams.test.ts` (and add `IDLE_ACTIVITY, SessionStreamEvent` to its import from `./index.ts`):

```ts
const snapshot = {
  kind: "snapshot",
  status: "releasing",
  rows: [{ entryId: "e1", message: { role: "user", content: "hi" } }, { entryId: null, message: {} }],
  dialogs: [{ ...approval, answers: ["deny", "session", "always", "once"] }],
  partial: { blocks: [{ type: "text", text: "Hel" }, { type: "toolCall", text: "{\"pa", id: "c1", name: "read" }] },
  queue: { steering: ["go left"], followUp: [], count: 1, bytes: 7 },
  statuses: [{ key: "command:/mode build", text: "Build" }],
  widgets: [{ key: "todo", lines: ["- a"], placement: "belowEditor" }],
  title: "pi - repo",
  panels: [{ id: "p1", lines: ["> alpha", "  beta"] }],
  notices: [{ level: "warning", text: "An extension failed during session_start." }, { level: "info", text: "saved", source: "extension" }],
  decorationsTruncated: false,
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
    expect(SessionStreamEvent.safeParse({ ...snapshot, title: "t".repeat(UI_LIMITS.title + 1) }).success).toBe(false);
    expect(SessionStreamEvent.safeParse({ kind: "status", status: "cold", cause: "c".repeat(257) }).success).toBe(false);
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
    { kind: "notice", level: "info", text: "hi", source: "extension" },
  ])("round-trips a $kind event", (event) => {
    expect(SessionStreamEvent.parse(event)).toEqual(event);
  });
});
```

In `worker.test.ts`:

```ts
it("gives each command its own default timeout", () => {
  expect(requestTimeoutMs({ type: "prompt", message: "x" })).toBeUndefined();
  expect(requestTimeoutMs({ type: "compact" })).toBeUndefined();
  expect(requestTimeoutMs({ type: "navigate_tree", targetId: "e1" })).toBeUndefined();
  expect(requestTimeoutMs({ type: "auto_name" })).toBe(120_000);
  expect(requestTimeoutMs({ type: "export_html", outputPath: "/p/x.html" })).toBe(120_000);
  expect(requestTimeoutMs({ type: "set_session_name", name: "n" })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
});
```

New cases in `snapshot.test.ts`:

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
  expect(snapshot.decorationsTruncated).toBe(false);
});

it("leaves out a partial reply over PARTIAL_BYTES", () => {
  const partial = { blocks: [{ type: "text" as const, text: "y".repeat(PARTIAL_BYTES) }] };
  expect(fitSnapshot({ status: "running", rows: [], dialogs: [], partial }).partial).toBeNull();
});

it("keeps a pending approval and stays under the frame budget with ANSI-heavy widgets (M2-RT-05)", () => {
  // 51 × "\u001b[31mx\u001b[0m" = 510 characters, 1 020 JSON bytes: an ESC weighs 6 bytes once encoded.
  const line = "\u001b[31mx\u001b[0m".repeat(51);
  const widgets = Array.from({ length: UI_LIMITS.widgets }, (_, i) => ({
    key: `w${i}`,
    lines: Array.from({ length: UI_LIMITS.widgetLines }, () => line),
    placement: "aboveEditor" as const,
  }));
  const editor = { id: "e1", method: "editor" as const, title: "Edit", prefill: "p".repeat(999_500) };
  const approval = { id: "a1", method: "approval" as const, title: "Run a command?", message: "1 line\nbash: ls", category: "exec" as const, answers: ["deny", "once"] as Array<"deny" | "once"> };
  const snapshot = fitSnapshot({ status: "running", rows: [], dialogs: [editor, approval], widgets });
  expect(snapshot.dialogs.map((dialog) => dialog.id)).toEqual(["a1"]);
  // Each widget is 51 195 JSON bytes: five fit in DECORATION_BYTES, the newest three are left out.
  expect(snapshot.widgets.map((widget) => widget.key)).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  expect(snapshot.decorationsTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(SNAPSHOT_BYTES);
});

it("builds snapshots the contract parses, whatever the inputs hold (M2-RT-06)", () => {
  const snapshot = fitSnapshot({
    status: "idle",
    rows: [{ entryId: "e1", message: { role: "user", content: "\u0000‮".repeat(400_000) } }],
    dialogs: [],
    statuses: Array.from({ length: UI_LIMITS.statuses }, (_, i) => ({ key: `k${i}`, text: "名".repeat(UI_LIMITS.statusText) })),
    notices: Array.from({ length: UI_LIMITS.notices }, () => ({ level: "info" as const, text: "é".repeat(UI_LIMITS.noticeText) })),
    title: "t".repeat(UI_LIMITS.title),
    name: "n".repeat(UI_LIMITS.name),
    leafId: "e".repeat(128),
  });
  expect(SessionStreamEvent.safeParse(snapshot).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(SNAPSHOT_BYTES);
});
```

In `session-reducer.test.ts`:

```ts
it("says a snapshot it cannot read is unreadable instead of staying blank (M2-RT-06)", () => {
  const view = reduceSession(EMPTY_VIEW, { kind: "snapshot", status: "idle", rows: "not rows" });
  expect(view).toMatchObject({ loaded: true, unreadable: true });
  expect(reduceSession(view, { kind: "status", status: 7 })).toBe(view);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts apps/daemon/src/modules/sessions/snapshot.test.ts apps/daemon/src/kernel/supervisor/worker.test.ts apps/web/src/stores`
Expected: FAIL.

- [ ] **Step 3: The v2 stream union**

`packages/contracts/src/streams.ts`: `SessionStatus` gains `releasing`, and the M1 `SessionStreamEvent` is replaced by:

```ts
export const SessionStatus = z.enum(["cold", "starting", "idle", "running", "releasing"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

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
  /** Statuses, notices or widgets were left out to keep the snapshot under its budget (Task 1b). */
  decorationsTruncated: z.boolean(),
  history: HistoryMeta,
  activity: Activity,
  leafId: z.string().max(128).nullable(),
  name: z.string().max(UI_LIMITS.name).nullable(),
});

export const SessionStreamEvent = z.discriminatedUnion("kind", [
  Snapshot,
  z.object({ kind: z.literal("status"), status: SessionStatus, cause: z.string().max(256).optional() }),
  z.object({ kind: z.literal("pi"), event: PiEvent }),
  z.object({ kind: z.literal("dialog_open"), dialog: Dialog }),
  z.object({ kind: z.literal("dialog_closed"), id: z.string() }),
  z.object({ kind: z.literal("notice"), level: Notice.shape.level, text: Notice.shape.text, source: Notice.shape.source }),
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
```

`frames.ts`: `PROTOCOL_VERSION = 2`.

- [ ] **Step 4: Keep pi-host, the daemon and the web app on v2**

`apps/daemon/src/kernel/supervisor/worker.ts`:

```ts
/**
 * How long a command may wait for its answer unless the caller says otherwise. `prompt`, `compact` and `navigate_tree`
 * have none: an extension command answers only when it ends (R38(1)), a compaction waits for the model's summary, and
 * a navigation waits for `session_before_tree` hooks that may ask the user (M2-RT-08); the wait ends with the worker.
 * Naming and export call the model or write a file: two minutes.
 */
const COMMAND_TIMEOUTS: Partial<Record<CommandInput["type"], number | undefined>> = {
  prompt: undefined,
  compact: undefined,
  navigate_tree: undefined,
  auto_name: 120_000,
  export_html: 120_000,
};
export const requestTimeoutMs = (command: CommandInput): number | undefined =>
  command.type in COMMAND_TIMEOUTS ? COMMAND_TIMEOUTS[command.type] : DEFAULT_REQUEST_TIMEOUT_MS;
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
/** Statuses, notices and widgets together, in JSON bytes: extension text cannot crowd out what a run waits on. */
export const DECORATION_BYTES = 256 * 1024;

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
 * The snapshot a subscriber gets when it cannot resume from a cursor, under `budget` JSON bytes (M2-RT-05). The fixed
 * sections (status, queue, title, history, activity, leaf, name) are always in. Then the open dialogs, approvals
 * first (the policy holds a tool call on them), kept in their own order; then decorations under `DECORATION_BYTES`
 * (statuses, the newest notices, widgets oldest first; `decorationsTruncated` says when one was left out); then open
 * panels, the partial reply if it fits whole, and the rows, newest first and contiguous, each over `ROW_BYTES` as a
 * placeholder (R109).
 */
export function fitSnapshot(input: SnapshotInput, budget = SNAPSHOT_BYTES): SnapshotEvent {
  const snapshot: SnapshotEvent = {
    kind: "snapshot",
    status: input.status,
    rows: [],
    dialogs: [],
    partial: null,
    queue: input.queue ?? EMPTY_QUEUE,
    statuses: [],
    widgets: [],
    title: input.title ?? null,
    panels: [],
    notices: [],
    decorationsTruncated: false,
    history: input.history ?? NO_HISTORY,
    activity: input.activity ?? IDLE_ACTIVITY,
    leafId: input.leafId ?? null,
    name: input.name ?? null,
  };
  let used = sizeOf(snapshot);
  const kept = new Set<Dialog>();
  const approvalsFirst = [
    ...input.dialogs.filter((dialog) => dialog.method === "approval"),
    ...input.dialogs.filter((dialog) => dialog.method !== "approval"),
  ];
  for (const dialog of approvalsFirst) {
    const size = sizeOf(dialog) + 1;
    if (used + size > budget) continue;
    used += size;
    kept.add(dialog);
  }
  snapshot.dialogs = input.dialogs.filter((dialog) => kept.has(dialog));
  let decorations = 0;
  const decorate = <T>(items: readonly T[]): T[] => {
    const taken: T[] = [];
    for (const item of items) {
      const size = sizeOf(item) + 1;
      if (decorations + size > DECORATION_BYTES || used + size > budget) {
        snapshot.decorationsTruncated = true;
        break;
      }
      decorations += size;
      used += size;
      taken.push(item);
    }
    return taken;
  };
  snapshot.statuses = decorate(input.statuses ?? []);
  snapshot.notices = decorate((input.notices ?? []).toReversed()).toReversed();
  snapshot.widgets = decorate(input.widgets ?? []);
  for (const panel of input.panels ?? []) {
    const size = sizeOf(panel) + 1;
    if (used + size > budget) continue;
    used += size;
    snapshot.panels.push(panel);
  }
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

`sizeOf` measures `Buffer.byteLength(JSON.stringify(value))` (it does in M1; keep it that way: JSON bytes, never characters).

`service.ts`: `snapshot()` passes `rows: [...fromFile, ...(run?.messages ?? [])].map((message) => ({ entryId: null, message }))` (entry ids arrive in Task 10b). Every test that reads `snapshot.messages` reads `snapshot.rows.map((row) => row.message)` instead; `sessions.int.test.ts`'s `snapshotRows` reads `rows`.

`apps/web/src/stores/row-view.ts`: move `ToolCallView`, `MessageView`, `summarize`, `clip`, `refOf`, `toMessageView`, `sameContent`, `withUniqueKey` out of `session-reducer.ts` unchanged, except that `MessageView` gains `readonly entryId: string | null` and `toMessageView(raw: unknown, entryId: string | null = null)` sets it. `session-reducer.ts` keeps `SessionView`, `EMPTY_VIEW`, `withNotice`, `reducePi`, `reduceSession`; `SessionView` gains `unreadable: boolean` (`EMPTY_VIEW` false; every snapshot resets it); the snapshot branch builds `messages` from `event.rows.reduce(... withUniqueKey(list, toMessageView(row.message, row.entryId)) ...)`; `withNotice(view, level, text, source?)` keeps the source; its `switch` gains `default: return view;` (the kinds later tasks handle); and a parse failure is no longer silent:

```ts
export function reduceSession(view: SessionView, raw: unknown): SessionView {
  const parsed = SessionStreamEvent.safeParse(raw);
  if (!parsed.success) {
    // A snapshot the client cannot read would leave the view blank for ever: say so (M2-RT-06). Other events are dropped.
    return (raw as { kind?: unknown } | null)?.kind === "snapshot" ? { ...view, loaded: true, unreadable: true } : view;
  }
  // … the M1 switch, v2 snapshot branch …
}
```

`SessionScreen.tsx` shows `t("sessions.unreadable")` in a `role="alert"` line when `view.unreadable`; `SessionScreen.test.tsx`'s `snapshot()` helper sends `rows: messages.map((message) => ({ entryId: null, message }))` with the v2 defaults, and one new case emits `{ kind: "snapshot", rows: 5 }` and finds the alert. `ws-server.test.ts` and `ws-server.int.test.ts` build their URLs with `?proto=${PROTOCOL_VERSION}`; `scripts/smoke-dist.ts` sets `PROTOCOL = 2`.

i18n, inside the `sessions (M2)` block: `"session.status.releasing": "Releasing"`, `"sessions.unreadable": "This session could not be shown. Reload the page; if it stays, the session file may be damaged."`; fr `"Libération"`, `"Cette session ne peut pas être affichée. Rechargez la page ; si cela persiste, le fichier de session est peut-être abîmé."`.

`docs/adr/0008-pap-records-added-in-m2.md`:

```markdown
# ADR 0008 — pap records added to the daemon ⇄ pi-host protocol in M2

Status: accepted · Date: 2026-10-11 · Spec: C §2.3 (records), as extended by ADR 0001

## Context
Spec C §2.3 lists the records of the protocol. M2 needs a few it does not list: the policy's own approval question
(spec C §5.3 wants four answers, and an extension's `ctx.ui.confirm` must not be able to look like the policy), a
way to cancel a custom panel the daemon will not show, naming through the session's model, the leaf and name of a
session at start, and the processes a worker's agent left running.

## Decision
- daemon → worker: `auto_name{id}`, `custom_cancel{id}`, `approval_response{id, answer: once|session|always|deny,
  cancelled?}` (alongside the Pi RPC shapes `clear_queue`, `compact`, `navigate_tree`, `set_session_name`,
  `export_html` and the spec's `custom_input`). `cancelled: true` means the daemon could not show the question:
  the policy fails closed and audits `dialog closed`, it never tells the model a person refused.
- worker → daemon: `approval_request{id, category, title, message, answers, tool, key}` (sent by pap-policy through
  the worker's approvals channel), `ready{…, leafId, sessionName}` (both default to null) and, from Task 20,
  `health{rssMb, descendants}`. `extension_ui_closed{id}` also closes an approval the worker withdrew.
- `toWireEvent` slims two Pi events: `entry_appended` keeps the entry's identity (and a summary's text), and
  `queue_update` carries previews plus the full count and byte size.
- `PROTOCOL_VERSION` (the client protocol) goes to 2 with the snapshot's new shape.

## Consequences
- `PAP_TYPES` is derived from `PapRecord` (R67): the new worker records can never be forwarded as Pi events.
- No extension can raise a policy card **through the extension API**: `ctx.ui` has no approval method and only
  pap-policy holds the approvals object. Code running inside the worker process can still call
  `process.send({ type: "approval_request", … })` and read the answer: that is R101's residual (in-process code is
  as trusted as the worker); the per-command sandbox (M5) is where it narrows.
- A worker older than the daemon refuses the new commands with `malformed record` (its `DaemonToWorker` schema does
  not know them): an answer, never silence. The dispatch switch of this version is exhaustive over `DaemonToWorker`
  from Task 15, so its `default` branch is a compile-time guard, not a runtime path.
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions packages/pi-host/src/host.int.test.ts`
Expected: PASS (the reducer tests read `entryId: null` from a v2 snapshot).

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip`

```bash
git add packages/contracts apps/daemon/src apps/web/src scripts/smoke-dist.ts docs/adr/0008-pap-records-added-in-m2.md
git commit -m "feat(contracts): protocol v2 snapshot and stream events, approvals first in snapshots"
```

---

### Task 2: pi-host session commands — queue, compaction, branching, naming, export, slim wire events

**Rulings (pre-dispatch):**
- **M2R13** [2] If `session.compact()` refuses the two-exchange session even with `keepRecentTokens: 1`, the test adds exchanges until it compacts and names the number in a comment; the assertion does not change — only implementation can see Pi's threshold; test-only — cost if wrong: none.
- **M2R14** [2, 17a] Pi throws on `navigateTree` while streaming; the daemon refuses earlier with `session_busy`, and its busy rule also counts prompts and commands in flight (Task 17a, M2-RT-08) — Pi's `compact()` aborts the current operation and the R113 window still shows `idle` — cost if wrong: a user's prompt aborted by a compaction.
- **M2R15** [2] `clear_queue` hands back at most `MAX_CLEARED_BYTES = 900 000` bytes of **JSON-encoded** text (`Buffer.byteLength(JSON.stringify(text)) + 1` per text) and says `truncated` (M2-RT-28) — quotes, backslashes and newlines grow up to 6× once encoded — cost if wrong: a response, and its receipt, over the 1 MiB frame.
- **M2R16** [2, 14b] A malformed `policy_update` keeps `profile` and `approvalMode` but sets `alwaysAllow: []` and reports it; "the previous rules stay in force" is gone (M2-RT-17) — after a revoke the previous rules still hold the revoked rule: fail closed — cost if wrong: extra cards until the next valid update.
- **M2R17** [2, 15] Until Task 15 writes the last cases, dispatch's `default` answers `unsupported command` to a record that has an id; Task 15 turns it into a compile-time exhaustiveness guard (M2-RT-23) — `ipc.onMessage` already refuses unknown types, so the branch is reachable only between tasks — cost if wrong: none.

**Files:**
- Create: `packages/pi-host/src/dispatch.ts`, `dispatch.test.ts`, `packages/pi-host/src/session-commands.ts`, `packages/pi-host/src/session-commands.test.ts`, `packages/pi-host/src/host.commands.int.test.ts` (`host.int.test.ts` is at 309 lines: M2's host cases go to new files, M2-RT-19)
- Modify: `packages/pi-host/src/host.ts` (uses `createDispatch`), `packages/pi-host/src/wire-events.ts`, `packages/pi-host/src/wire-events.test.ts`

**Interfaces:**
- Consumes: Task 1a records.
- Produces:
  - `createDispatch(deps: { session: AgentSession; ipc: Ipc; ui: UiBridge; rules(): PolicyRules; setRules(rules: PolicyRules): void }): (record: Command) => void` where `Command = Exclude<DaemonToWorker, { type: "init" | "shutdown" }>`. A malformed `policy_update` sets `{ ...rules(), alwaysAllow: [] }` and sends one `extension_error`.
  - Responses: `clear_queue` → `{steering: string[], followUp: string[], truncated: boolean}` (at most `MAX_CLEARED_BYTES = 900_000` JSON bytes of text); `compact` → `{tokensBefore: number, estimatedTokensAfter: number | null}`; `navigate_tree` → `{cancelled: boolean, leafId: string | null, editorText?: string}`; `set_session_name` → no data; `export_html` → `{path: string}`.
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
    // 450 000 newlines are 450 000 UTF-8 bytes but 900 002 once JSON-encoded (M2-RT-28).
    expect(fitTexts(["\n".repeat(450_000)], ["c"])).toEqual({ steering: [], followUp: ["c"], truncated: true });
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

/**
 * Pi's queue may hold up to 32 MiB; a response stays below the 1 MiB frame once JSON-encoded (quotes, backslashes and
 * newlines grow when escaped: M2-RT-28), and what does not fit is said.
 */
export const MAX_CLEARED_BYTES = 900_000;

export function fitTexts(steering: readonly string[], followUp: readonly string[], max = MAX_CLEARED_BYTES) {
  let left = max;
  let truncated = false;
  const take = (texts: readonly string[]) =>
    texts.filter((text) => {
      const size = Buffer.byteLength(JSON.stringify(text)) + 1;
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

`packages/pi-host/src/dispatch.ts` (the `switch` moved out of `host.ts`, with the new cases and a `default` that answers `unsupported command` until Task 15, M2R17):

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
  rules(): PolicyRules;
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
        if (update.success) {
          deps.setRules(update.data);
          return;
        }
        // Fail closed (M2-RT-17): after a revoke, "the previous rules" would still hold the revoked always rule.
        deps.setRules({ ...deps.rules(), alwaysAllow: [] });
        send({
          type: "extension_error",
          extensionPath: POLICY_EXTENSION_PATH,
          event: "policy_update",
          error: "invalid policy rules: always rules are suspended until the next valid update",
        });
        return;
      }
      // Reachable only until Task 15 writes the last cases; then this becomes `const unhandled: never = record`.
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

`host.ts` replaces its inline `dispatch = (record) => { switch … }` with `dispatch = createDispatch({ session: opened, ipc, ui, rules: () => rules, setRules: (next) => { rules = next; } })` and imports nothing it no longer uses.

`packages/pi-host/src/dispatch.test.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PolicyRules } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import type { UiBridge } from "./ui-bridge.ts";

const withAlways: PolicyRules = {
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [{ tool: "bash", key: "d".repeat(64) }],
};

describe("dispatch", () => {
  it("drops the always rules when a policy update is malformed, and says so (M2-RT-17)", () => {
    const sent: Array<Record<string, unknown>> = [];
    let rules = withAlways;
    const dispatch = createDispatch({
      session: {} as AgentSession,
      ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      rules: () => rules,
      setRules: (next) => {
        rules = next;
      },
    });
    dispatch({ type: "policy_update", rules: { profile: "interactive", approvalMode: "yolo" } });
    expect(rules).toEqual({ ...withAlways, alwaysAllow: [] });
    expect(sent).toEqual([expect.objectContaining({ type: "extension_error", event: "policy_update" })]);
    dispatch({ type: "policy_update", rules: withAlways });
    expect(rules).toEqual(withAlways);
  });
});
```

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

Create `packages/pi-host/src/host.commands.int.test.ts` with the bed set-up of `host.int.test.ts` (`let bed: ReturnType<typeof createHostBed>; beforeEach(() => { bed = createHostBed(); }); afterEach(() => bed.dispose());`, helpers from `testing/host-bed.ts`, `join` and `readFileSync` from Node):

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

(Task 13b replaces `isConfirm` with the approval record; this test then waits for `approval_request` and answers `approval_response{answer:"deny"}`.) If Pi refuses to compact the two-exchange session even with `keepRecentTokens: 1`, add exchanges until `compact` succeeds and note the number in the test comment; do not change the assertion.

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

**Rulings (pre-dispatch):**
- **M2R18** [3] `ModelRuntime.completeSimple(model, context, options)` exists in SDK 1.1.0 (verified by the red-team); the option names (`maxTokens`, `signal`, `reasoning`) are read from `ModelsSimpleStreamOptions` and adapted if they differ — mechanical — cost if wrong: none.
- **M2R19** [3] The title prompt is pap's own wording; nothing is copied from pi-web — owner rule — cost if wrong: none.
- **M2R20** [3] `auto_name` runs through dispatch's `background("auto_name", …)`, never a bare `void` (M2-RT-31) — every fire-and-forget promise ends in a logged `.catch` — cost if wrong: an unhandled rejection that kills the worker.

**Files:**
- Create: `packages/pi-host/src/title.ts`, `title.test.ts`, `packages/pi-host/src/auto-name.ts`
- Modify: `packages/pi-host/src/dispatch.ts`, `packages/pi-host/src/host.commands.int.test.ts`

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

Check `ModelsSimpleStreamOptions` and `Context` in `dist/core/model-runtime.d.ts` and `@earendil-works/pi-ai`'s `.d.ts`: if the option names differ (`maxTokens`, `signal`, `reasoning`), use the SDK's names; if `session.messages` holds the system message first, `buildTitleTranscript` already ignores it (role filter). `dispatch.ts` gains `case "auto_name": background("auto_name", handleAutoName(session, record, send)); return;` (M2-RT-31: never a bare `void`).

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit packages/pi-host`
Expected: PASS.

- [ ] **Step 5: Write the integration test**

Append to `host.commands.int.test.ts`:

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

**Rulings (pre-dispatch):**
- **M2R21** [4] No cast is needed: `ExtensionRunner.emit` accepts `SessionShutdownEvent` (verified in SDK 1.1.0; `emitSessionShutdownEvent` is in `runner.d.ts` but not exported from the root); should a later SDK narrow it, the documented cast is pre-approved — verified — cost if wrong: none.
- **M2R22** [4, 5] R106's SIGSTOP-then-scan variant is declined: the bounded re-scan (3 sweeps) catches a process forked during a sweep and the per-`PAP_HOME` scope (Task 5, swept at boot, killed when a stop is given up) kills what outruns it (M2-RT-13); with scopes off (no linger, M2R30) the re-scan is the only cover — accepted residual — cost if wrong: a fork bomb's survivors on a host without scopes.
- **M2R23** [4] The `closeSession` unit test uses fake timers that ignore unknown handles and fire due timers only after a macrotask flush (`await new Promise(setImmediate)`), and the test flushes before it advances; exactly one log line is expected (M2-RT-07) — the first fake deleted the wrong timer and the test could never pass — cost if wrong: a hanging test.

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
  // One macrotask turn: every promise hop queued so far (an abort settling, the next step arming its timer) runs.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    flush,
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    // A handle it does not hold (fired already, or cleared twice) is ignored: never `splice(-1, 1)` (M2-RT-07).
    clearTimer: (handle: unknown) => {
      const at = timers.indexOf(handle as never);
      if (at !== -1) timers.splice(at, 1);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await flush();
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = target;
      await flush();
    },
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
    // The abort settles and the session_shutdown step arms its timer before any time passes.
    await timers.flush();
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

### Task 5: Supervisor — workers in systemd user scopes (R46 as amended, R100, R106)

Reference: T3 Code `packages/shared/src/AgentScope.ts` and `apps/server/src/process/agentScope.ts` (a transient `systemd-run --user --scope` per agent, `Result=oom-kill` read after exit, failed scopes cleared). pap differs: the limits cover the worker **and every command it runs** (so they are sized for builds, owner R2-1), the daemon kills the scope's cgroup after every exit because Pi's detached bash trees survive a SIGKILLed worker (R100), units live in a slice that belongs to one `PAP_HOME` (so a daemon sweeps only its own leftovers), and scopes are used only when the user manager lingers (owner R2-3). Measured while planning on this host (systemd 259, `Linger=yes`): `child_process.spawn("systemd-run", ["--user", "--scope", …, "--", node, entry], { stdio: [..., "ipc"], detached: true })` keeps the Node IPC channel working, the worker keeps the spawned pid (systemd-run execs in place) and leads its own process group, so the M1 guards hold.

**Rulings (pre-dispatch):**
- **M2R24** [5, 6] Scope properties (owner R2-1, M2-Q4): `MemoryMax = max(2048, ⌊50 % of RAM⌋)` MB, no `MemoryHigh`, `TasksMax=4096`, `OOMPolicy=continue` where systemd accepts it on scopes (older: left out), `TimeoutStopSec=5`; no `MemorySwapMax` in production — a scope holds the worker and every command it runs, and R46's 512/768 (worker alone) would throttle then kill an ordinary `pnpm build` (M2-RT-02); R46's numbers return with the per-command sandbox (M5) — cost if wrong: builds killed (too low) or a runaway taking half the RAM (too high).
- **M2R25** [5] `oom` is reported only when the worker itself died of SIGKILL and its unit's `memory.events oom_kill` rose above the baseline read at the worker's first record (or systemd says `Result=oom-kill`) (owner R2-1) — a child the kernel killed earlier left the worker running and must not label a later exit — cost if wrong: a child OOM followed by an unrelated `kill -9` of the worker reads as "out of memory" (accepted ambiguity).
- **M2R26** [5, 22] A child process OOM-killed inside the scope leaves the worker running (`OOMPolicy=continue`); Task 5 and Task 22 each pin it with a child hog — owner R2-1 — cost if wrong: a session lost to a test suite that ran out of memory.
- **M2R27** [5, 22] Tests pass `memorySwapMaxMb: 0` in their limits (M2-RT-41): with swap and no `MemorySwapMax` a hog swaps instead of reaching `MemoryMax` (this host has no swap, dev machines do) — host-independent tests — cost if wrong: a flaky OOM test.
- **M2R28** [5] The slice and the units are named per `PAP_HOME`: `app-pap-<h>.slice` and `pap-<h>-worker-<8 hex>.scope`, `h` = the first 8 hex digits of sha256 of the home's real path (M2-RT-13); one daemon per home (R119) — so boot can sweep the slice without touching another daemon's workers (the owner's daemon, a dev worktree, a test) — cost if wrong: a dev daemon killing the owner's workers.
- **M2R29** [5, 6] At boot the daemon runs `systemctl --user stop <slice>` then `reset-failed 'pap-<h>-worker-*'` (bounded, logged); when a stop is given up (`giveUp()`), it runs `systemctl --user kill --signal=SIGKILL <slice>` synchronously with a 2 s timeout (M2-RT-13) — leftovers of a crashed daemon die at the next boot and a forced exit leaves none — cost if wrong: Pi's detached trees outliving a daemon crash until the next boot.
- **M2R30** [5] Linger off (`loginctl show-user <uid> --property=Linger --value` is not `yes`, or `loginctl` is missing) → scopes disabled with one boot warning `worker_scopes {enabled: false, reason: "linger off: …"}` naming `loginctl enable-linger` (owner R2-3, M2-RT-13) — without linger, logind stops the user manager and every scope at logout: `pap serve` started over SSH would lose its workers — cost if wrong: scopes off where they would have worked (the warning says how to enable them).
- **M2R31** [5, 6, 22] The scope integration tests run where a lingering user manager answers, are skipped with a printed reason elsewhere, and FAIL when `CI` is set (owner M2-Q8, consistent with R92); Task 6 starts a user manager in CI — containment is not a security probe, but the owner wants CI to see scope regressions — cost if wrong: CI blind to scope regressions.
- **M2R32** [5] A worker's exit report waits at most `REAP_TIMEOUT_MS = 3000` for the reap, then reports with the exit's own cause and logs `worker_scope_reap_slow` — keeps the R104 order (the cgroup is empty when the session hears of the exit) — cost if wrong: an exit reported up to 3 s late.

**Files:**
- Create: `apps/daemon/src/kernel/supervisor/scope.ts`, `scope.test.ts`, `scope.int.test.ts`, `apps/daemon/src/kernel/supervisor/worker-io.ts`, `apps/daemon/src/kernel/which.ts`, `which.test.ts`
- Modify: `apps/daemon/src/kernel/supervisor/worker.ts` (launch through a scope; helpers moved to `worker-io.ts` and re-exported), `exit.ts`, `exit.test.ts`, `apps/daemon/src/kernel/testing/rogue-bed.ts` (modes `hog` and `child-hog`, `scope` option)

**Interfaces:**
- Consumes: M1 supervisor.
- Produces:
  - `ScopeLimits { memoryMaxMb; tasksMax; memorySwapMaxMb? }`, `ScopeLaunch { command; args; env }`, `WorkerScope { unit; launch; started(): Promise<void>; reap(exit: { signal }): Promise<{ oomKilled: boolean }> }`, `WorkerScopes { enabled; slice: string | null; next(): WorkerScope | null; sweep(): Promise<void>; killAllNow(): void }`, `NO_SCOPES`, `sliceNames(home): { slice; unitPrefix }`, `defaultMemoryMaxMb(totalMemMb) = max(2048, ⌊totalMemMb / 2⌋)`.
  - `probeScopes(mode: "auto" | "off", limits, deps: { home; uid; exec: Exec; execSync; env; which(cmd): string | null; clock; logger; readCgroupFile? }): Promise<WorkerScopes>`; logs `worker_scopes {enabled, slice?, oomPolicy?, reason?}` once (warn when linger is off or systemd-run fails, info otherwise).
  - `execFileText: Exec` (no shell, timeout), `execFileCode(file, args, timeoutMs): number | null` (synchronous, for the forced-exit path) and `whichOnPath(command, env): string | null` in `kernel/which.ts`.
  - `spawnWorker(options & { scope?: WorkerScope })`: launches `launch.command launch.args… <node> <execArgv…> <entry>` instead of `fork`, calls `scope.started()` at the worker's first record, and reports `exit.cause = "oom"` when `reap` says so.
  - `ExitCause` gains `"oom"`; `describeExit({cause: "oom"})` = `"Agent process ran out of memory and was stopped."`.

- [ ] **Step 1: Write the failing unit tests**

`apps/daemon/src/kernel/supervisor/scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createLogger, silentLogger } from "../logger.ts";
import { defaultMemoryMaxMb, type Exec, NO_SCOPES, probeScopes, sliceNames } from "./scope.ts";

const LIMITS = { memoryMaxMb: 2048, tasksMax: 4096 };
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };
const HOME = "/nonexistent/pap-home";
const { slice: SLICE, unitPrefix: PREFIX } = sliceNames(HOME);

type Answer = { code: number | null; stdout?: string };
function fakeExec(answers: (file: string, args: readonly string[]) => Answer) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const answer = answers(file, args);
    return { code: answer.code, stdout: answer.stdout ?? "" };
  };
  return { exec, calls };
}
// A lingering user manager where systemd-run works.
const healthy = (file: string, args: readonly string[]): Answer =>
  file.endsWith("loginctl")
    ? { code: 0, stdout: "yes\n" }
    : args[1] === "show"
      ? { code: 0, stdout: "ActiveState=active\nResult=success\nControlGroup=/u/x.scope\n" }
      : { code: 0 };
const which = (command: string) => `/usr/bin/${command}`;
const deps = (exec: Exec, extra: Record<string, unknown> = {}) => ({
  home: HOME,
  uid: 1000,
  exec,
  execSync: () => 0,
  env: ENV,
  which,
  clock: createFakeClock(),
  logger: silentLogger,
  ...extra,
});

describe("probeScopes", () => {
  it("is off when asked, without a user manager, when linger is off, or when systemd-run fails", async () => {
    const { exec } = fakeExec(healthy);
    expect(await probeScopes("off", LIMITS, deps(exec))).toBe(NO_SCOPES);
    expect((await probeScopes("auto", LIMITS, deps(exec, { env: {} }))).enabled).toBe(false);
    expect((await probeScopes("auto", LIMITS, deps(exec, { which: () => null }))).enabled).toBe(false);
    const noLinger = fakeExec((file, args) => (file.endsWith("loginctl") ? { code: 0, stdout: "no\n" } : healthy(file, args)));
    expect((await probeScopes("auto", LIMITS, deps(noLinger.exec))).enabled).toBe(false);
    expect(noLinger.calls.some((call) => call[0]?.endsWith("systemd-run"))).toBe(false);
    const failing = fakeExec((file, args) => (file.endsWith("systemd-run") ? { code: 1 } : healthy(file, args)));
    expect((await probeScopes("auto", LIMITS, deps(failing.exec))).enabled).toBe(false);
  });

  it("warns once at boot when linger is off (owner R2-3)", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const clock = createFakeClock();
    const logger = createLogger({ level: "debug", clock, write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
    const { exec } = fakeExec((file, args) => (file.endsWith("loginctl") ? { code: 0, stdout: "no\n" } : healthy(file, args)));
    await probeScopes("auto", LIMITS, deps(exec, { clock, logger }));
    expect(lines).toEqual([
      expect.objectContaining({ level: "warn", msg: "worker_scopes", enabled: false, reason: expect.stringContaining("loginctl enable-linger") }),
    ]);
  });

  it("wraps a worker in a unit of this home's slice, with MemoryMax, TasksMax and OOMPolicy=continue, never MemoryHigh", async () => {
    const { exec } = fakeExec(healthy);
    const scopes = await probeScopes("auto", LIMITS, deps(exec));
    const next = scopes.next();
    expect(scopes.slice).toBe(SLICE);
    expect(next?.unit).toMatch(new RegExp(`^${PREFIX}[0-9a-f]{8}\\.scope$`));
    expect(next?.launch).toEqual({
      command: "/usr/bin/systemd-run",
      args: [
        "--user", "--scope", "--quiet", `--unit=${next?.unit}`, `--slice=${SLICE}`,
        "--property=MemoryMax=2048M", "--property=TasksMax=4096", "--property=TimeoutStopSec=5", "--property=OOMPolicy=continue", "--",
      ],
      env: ENV,
    });
  });

  it("passes MemorySwapMax only when the limits ask for it (tests, M2-RT-41), and OOMPolicy only where systemd knows it", async () => {
    const { exec } = fakeExec(healthy);
    const withSwap = await probeScopes("auto", { ...LIMITS, memorySwapMaxMb: 0 }, deps(exec));
    expect(withSwap.next()?.launch.args).toContain("--property=MemorySwapMax=0M");
    const older = fakeExec((file, args) => (args.includes("--property=OOMPolicy=continue") ? { code: 1 } : healthy(file, args)));
    expect((await probeScopes("auto", LIMITS, deps(older.exec))).next()?.launch.args).not.toContain("--property=OOMPolicy=continue");
  });

  it("names the slice per PAP_HOME and sizes MemoryMax from the host's memory", () => {
    expect(sliceNames("/a/.pap").slice).toMatch(/^app-pap-[0-9a-f]{8}\.slice$/);
    expect(sliceNames("/a/.pap").unitPrefix).toMatch(/^pap-[0-9a-f]{8}-worker-$/);
    expect(sliceNames("/a/.pap").slice).not.toBe(sliceNames("/b/.pap").slice);
    expect(sliceNames("/a/.pap")).toEqual(sliceNames("/a/.pap"));
    expect([defaultMemoryMaxMb(1024), defaultMemoryMaxMb(4096), defaultMemoryMaxMb(16_384)]).toEqual([2048, 2048, 8192]);
  });

  it("reaps: kills what is left, stops and clears the unit", async () => {
    const { exec, calls } = fakeExec(healthy);
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
    calls.length = 0;
    expect(await scope?.reap({ signal: null })).toEqual({ oomKilled: false });
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["--user", "show"],
      ["--user", "kill"],
      ["--user", "stop"],
      ["--user", "reset-failed"],
    ]);
    expect(calls[1]).toContain("--signal=SIGKILL");
  });

  it.each([
    [{ signal: "SIGKILL" as const }, 1, true],
    [{ signal: "SIGKILL" as const }, 0, false],
    [{ signal: null }, 1, false],
  ])("says oom for an exit %j only when the worker was SIGKILLed and oom_kill rose (+%i) during its life", async (exit, rise, expected) => {
    let kills = 2;
    const { exec } = fakeExec(healthy);
    const scope = (await probeScopes("auto", LIMITS, deps(exec, { readCgroupFile: () => `oom 0\noom_kill ${kills}\n` }))).next();
    await scope?.started();
    kills += rise;
    expect(await scope?.reap(exit)).toEqual({ oomKilled: expected });
  });

  it("never throws when systemctl fails", async () => {
    const exec: Exec = async (file, args) => {
      if (file.endsWith("loginctl")) return { code: 0, stdout: "yes" };
      if (args.includes("true")) return { code: 0, stdout: "" };
      throw new Error(`${file} gone`);
    };
    const scope = (await probeScopes("auto", LIMITS, deps(exec))).next();
    await expect(scope?.started()).resolves.toBeUndefined();
    expect(await scope?.reap({ signal: "SIGKILL" })).toEqual({ oomKilled: false });
  });

  it("sweeps its own slice at boot and kills it at once on a forced exit", async () => {
    const { exec, calls } = fakeExec(healthy);
    const killed: string[][] = [];
    const execSync = (file: string, args: readonly string[]) => {
      killed.push([file, ...args]);
      return 0;
    };
    const scopes = await probeScopes("auto", LIMITS, deps(exec, { execSync }));
    calls.length = 0;
    await scopes.sweep();
    expect(calls).toEqual([
      ["/usr/bin/systemctl", "--user", "stop", SLICE],
      ["/usr/bin/systemctl", "--user", "reset-failed", `${PREFIX}*`],
    ]);
    scopes.killAllNow();
    expect(killed).toEqual([["/usr/bin/systemctl", "--user", "kill", "--signal=SIGKILL", SLICE]]);
  });
});
```

`exit.test.ts`: `expect(describeExit({ code: null, signal: "SIGKILL", cause: "oom" })).toBe("Agent process ran out of memory and was stopped.")`.

`which.test.ts`: `whichOnPath("sh", { PATH: "/nope:/bin:/usr/bin" })` ends with `/sh`; `whichOnPath("pap-no-such-command", { PATH: "/bin" })` is `null`; a non-executable file named like the command is skipped (create one in a temp dir with mode 0644, removed in `finally`); `execFileCode("true", [], 2000)` is 0 and `execFileCode("/nonexistent", [], 2000)` is `null`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `scope.ts`, `which.ts`, the launch and the cause**

`apps/daemon/src/kernel/supervisor/scope.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import type { WorkerExit } from "./exit.ts";

export interface ScopeLimits {
  readonly memoryMaxMb: number;
  readonly tasksMax: number;
  /** Tests only (M2-RT-41): 0 keeps a test's hog from swapping instead of reaching MemoryMax. */
  readonly memorySwapMaxMb?: number;
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
/** One worker's unit: the argv that goes before `node`, and what to do once the worker ran. */
export interface WorkerScope {
  readonly unit: string;
  readonly launch: ScopeLaunch;
  /** At the worker's first record (it runs inside its unit by then): reads the unit's `oom_kill` baseline. Never throws. */
  started(): Promise<void>;
  /**
   * After the worker exited: whether its own death was the memory limit (a SIGKILL while the unit's `oom_kill` rose
   * since `started`, owner R2-1), then the unit's cgroup is SIGKILLed (what Pi started in a group of its own survives
   * the worker otherwise, R100), stopped and its failed state cleared. Never throws.
   */
  reap(exit: Pick<WorkerExit, "signal">): Promise<{ oomKilled: boolean }>;
}
export interface WorkerScopes {
  readonly enabled: boolean;
  /** The slice of this daemon's units: one per PAP_HOME. */
  readonly slice: string | null;
  next(): WorkerScope | null;
  /** At boot: stops what an earlier daemon of this home left in the slice. Never throws. */
  sweep(): Promise<void>;
  /** When a stop is given up: SIGKILLs the whole slice, synchronously, bounded. Never throws. */
  killAllNow(): void;
}

export const NO_SCOPES: WorkerScopes = {
  enabled: false,
  slice: null,
  next: () => null,
  sweep: async () => {},
  killAllNow: () => {},
};
const PROBE_TIMEOUT_MS = 5000;
const SYSTEMCTL_TIMEOUT_MS = 5000;
const KILL_NOW_TIMEOUT_MS = 2000;
/** A scope being stopped by systemd can take a moment to record its result. */
const STOPPING_POLLS = 20;
const STOPPING_POLL_MS = 100;

/** The memory a worker's scope may use (owner R2-1): half the host, at least 2 GiB. */
export const defaultMemoryMaxMb = (totalMemMb: number): number => Math.max(2048, Math.floor(totalMemMb / 2));

/** `app-pap-<h>.slice` and `pap-<h>-worker-…`: `h` names one PAP_HOME, so a daemon only ever sweeps its own units. */
export function sliceNames(home: string): { slice: string; unitPrefix: string } {
  let real = home;
  try {
    real = realpathSync(home);
  } catch {
    // A home that does not exist yet (tests) is named by its path.
  }
  const h = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return { slice: `app-pap-${h}.slice`, unitPrefix: `pap-${h}-worker-` };
}

export interface ProbeDeps {
  readonly home: string;
  readonly uid: number;
  readonly exec: Exec;
  execSync(file: string, args: readonly string[], timeoutMs: number): number | null;
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

// An unreadable counter reads as 0: the worst case is an OOM reported as a plain SIGKILL.
const readCgroup = (group: string, file: string): string => {
  try {
    return readFileSync(join("/sys/fs/cgroup", group, file), "utf8");
  } catch {
    return "";
  }
};

/** Probes once, at boot: a lingering user manager that answers gets one scope per worker; anything else runs workers as in M1. */
export async function probeScopes(mode: "auto" | "off", limits: ScopeLimits, deps: ProbeDeps): Promise<WorkerScopes> {
  const off = (reason: string, level: "info" | "warn"): WorkerScopes => {
    deps.logger[level]("worker_scopes", { enabled: false, reason });
    return NO_SCOPES;
  };
  if (mode === "off") return off("PAP_WORKER_SCOPE=off", "info");
  const runtimeDir = deps.env.XDG_RUNTIME_DIR;
  const systemdRun = deps.which("systemd-run");
  const systemctl = deps.which("systemctl");
  const loginctl = deps.which("loginctl");
  if (!runtimeDir || !systemdRun || !systemctl || !loginctl) return off("no systemd user manager", "info");
  const run = (file: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> =>
    deps.exec(file, args, timeoutMs).catch(() => ({ code: null, stdout: "" }));
  // Without linger, logind stops the user manager, and every scope with it, when the last login session ends (R2-3).
  const linger = await run(loginctl, ["show-user", String(deps.uid), "--property=Linger", "--value"], PROBE_TIMEOUT_MS);
  if (linger.code !== 0 || linger.stdout.trim() !== "yes") {
    return off("linger off: scoped workers would stop at logout; `loginctl enable-linger` enables them", "warn");
  }
  const probe = async (extra: readonly string[]) =>
    (await run(systemdRun, ["--user", "--scope", "--quiet", "--collect", ...extra, "--", "true"], PROBE_TIMEOUT_MS)).code === 0;
  // OOMPolicy on scopes needs systemd 253; an older user manager still gets plain scopes.
  const oomPolicy = await probe(["--property=OOMPolicy=continue"]);
  if (!oomPolicy && !(await probe([]))) return off("systemd-run --user --scope failed", "warn");
  const { slice, unitPrefix } = sliceNames(deps.home);
  deps.logger.info("worker_scopes", { enabled: true, slice, oomPolicy, ...limits });
  const properties = [
    `--property=MemoryMax=${limits.memoryMaxMb}M`,
    `--property=TasksMax=${limits.tasksMax}`,
    ...(limits.memorySwapMaxMb === undefined ? [] : [`--property=MemorySwapMax=${limits.memorySwapMaxMb}M`]),
    // A stop never waits systemd's default 90 s for a process that ignores SIGTERM.
    "--property=TimeoutStopSec=5",
    // A child the kernel kills for memory does not take the worker with it (owner R2-1).
    ...(oomPolicy ? ["--property=OOMPolicy=continue"] : []),
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
  const unitState = async (unit: string) => {
    const shown = await systemctlRun(["show", unit, "--property=ActiveState,Result,ControlGroup"]);
    if (shown.code !== 0) return { oomKills: 0, result: null, active: null };
    const state = parseKeyValues(shown.stdout);
    const group = state.get("ControlGroup") ?? "";
    return {
      oomKills: group ? counterOf(cgroupFile(group, "memory.events"), "oom_kill") : 0,
      result: state.get("Result") ?? null,
      active: state.get("ActiveState") ?? null,
    };
  };
  return {
    enabled: true,
    slice,
    next() {
      const unit = `${unitPrefix}${randomBytes(4).toString("hex")}.scope`;
      let baseline = 0;
      return {
        unit,
        launch: {
          command: systemdRun,
          args: ["--user", "--scope", "--quiet", `--unit=${unit}`, `--slice=${slice}`, ...properties, "--"],
          // systemd-run reaches the user manager through it; the worker inherits it, as any child of the user would.
          env: { XDG_RUNTIME_DIR: runtimeDir },
        },
        async started() {
          baseline = (await unitState(unit)).oomKills;
        },
        async reap(exit) {
          let oomKilled = false;
          for (let poll = 0; poll < STOPPING_POLLS; poll++) {
            const state = await unitState(unit);
            // Only the worker's own death counts: a child killed earlier left the worker running (owner R2-1).
            if (exit.signal === "SIGKILL" && (state.result === "oom-kill" || state.oomKills > baseline)) oomKilled = true;
            if (state.active !== "deactivating") break;
            await deps.clock.sleep(STOPPING_POLL_MS);
          }
          await systemctlRun(["kill", "--signal=SIGKILL", unit]);
          await systemctlRun(["stop", unit]);
          await systemctlRun(["reset-failed", unit]);
          return { oomKilled };
        },
      };
    },
    async sweep() {
      // One daemon per home (R119): whatever is in this slice was left by an earlier daemon of this home.
      const stopped = await run(systemctl, ["--user", "stop", slice], SYSTEMCTL_TIMEOUT_MS);
      const cleared = await run(systemctl, ["--user", "reset-failed", `${unitPrefix}*`], SYSTEMCTL_TIMEOUT_MS);
      deps.logger.info("worker_scopes_swept", { slice, stop: stopped.code, resetFailed: cleared.code });
    },
    killAllNow() {
      const code = deps.execSync(systemctl, ["--user", "kill", "--signal=SIGKILL", slice], KILL_NOW_TIMEOUT_MS);
      if (code !== 0) deps.logger.warn("worker_scopes_kill_failed", { slice, code });
    },
  };
}
```

`apps/daemon/src/kernel/which.ts`:

```ts
import { execFile, spawnSync } from "node:child_process";
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
      // Not here, or not executable: the next PATH entry is tried; a miss everywhere returns null.
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

/** Runs a program without a shell and waits, at most `timeoutMs`: the exit code, or null when it could not run in time. */
export function execFileCode(file: string, args: readonly string[], timeoutMs: number): number | null {
  const result = spawnSync(file, [...args], { timeout: timeoutMs, stdio: "ignore" });
  return result.error ? null : result.status;
}
```

`apps/daemon/src/kernel/supervisor/worker-io.ts`: move `OUTPUT_TAIL_BYTES`, `DEFAULT_REQUEST_TIMEOUT_MS`, `MAX_SHUTDOWN_GRACE_MS`, `MAX_WORKER_STRING`, `COMMAND_TIMEOUTS`, `requestTimeoutMs`, `clipWorkerString`, `boundedOutbound`, `boundedRecord`, `createTail` and `failedHandle` out of `worker.ts` unchanged; `worker.ts` re-exports every exported name (`export { … } from "./worker-io.ts"`), so no import elsewhere changes.

`worker.ts`: `SpawnWorkerOptions` gains

```ts
  /** Launch through a systemd scope (Task 5) instead of a plain fork; the scope is reaped once the worker has exited. */
  readonly scope?: WorkerScope;
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

the first record the worker sends reads the unit's OOM baseline (the worker runs inside its unit by then):

```ts
  let scopeStarted = false;
  // first lines of the `message` handler, once `alive` is checked:
    if (options.scope && !scopeStarted) {
      scopeStarted = true;
      options.scope.started().catch((error: unknown) => logger.warn("worker_scope_baseline_failed", { err: error }));
    }
```

and the exit report waits for the reap (bounded), so the cause is right and the cgroup is empty when the session hears of the exit:

```ts
/** The longest an exit report waits for the scope to be read and stopped. */
export const REAP_TIMEOUT_MS = 3000;

  let reported = false;
  const report = (exit: WorkerExit): void => {
    if (reported) return;
    reported = true;
    const scope = options.scope;
    if (!scope) return finish(exit);
    let done = false;
    const settle = (oomKilled: boolean) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      finish(oomKilled ? { ...exit, cause: "oom" } : exit);
    };
    const timer = clock.setTimeout(() => {
      logger.warn("worker_scope_reap_slow", { unit: scope.unit });
      settle(false);
    }, REAP_TIMEOUT_MS);
    scope.reap(exit).then(
      ({ oomKilled }) => settle(oomKilled),
      (error: unknown) => {
        logger.warn("worker_scope_reap_failed", { unit: scope.unit, err: error });
        settle(false);
      },
    );
  };
```

with the two `finish(exit)` calls of the `exit` / `close` path replaced by `report(exit)`. `exit.ts`: `ExitCause` adds `"oom"`; `describeExit` case `"oom"` returns `"Agent process ran out of memory and was stopped."`.

`rogue-bed.ts`: the `ROGUE` script gains, after `send(ready)`:

```js
if (mode === "hog") {
  const kept = [];
  const timer = setInterval(() => { if (kept.length >= 64) { clearInterval(timer); process.exit(3); } kept.push(Buffer.alloc(16 * 1024 * 1024, 1)); }, 10);
}
if (mode === "child-hog") {
  const hog = spawn(process.execPath, ["-e", "const k=[];setInterval(()=>{if(k.length>=64)process.exit(3);k.push(Buffer.alloc(16*1024*1024,1))},10)"], { stdio: "ignore" });
  hog.on("exit", (code, signal) => send({ type: "extension_error", extensionPath: "rogue", event: "child_exit", error: String(signal ?? code) }));
}
```

(the 1 GiB stop makes a missing limit fail the test with exit code 3 instead of eating the host's memory), and `rogue(mode, options)` accepts `options.scope` and passes it to `spawnWorker`, adding `XDG_RUNTIME_DIR` from `process.env` to the worker env when a scope is given.

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit apps/daemon/src/kernel`
Expected: PASS (the M1 worker tests are unchanged: without `scope` nothing changes).

- [ ] **Step 5: Write the integration test (runs where a lingering user manager answers; fails in CI without one)**

`apps/daemon/src/kernel/supervisor/scope.int.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { alive, createRogueBed, realPid, type RogueBed, waitForReady } from "../testing/rogue-bed.ts";
import { execFileCode, execFileText, whichOnPath } from "../which.ts";
import { probeScopes, type ScopeLimits, type WorkerScopes } from "./scope.ts";

const available = (() => {
  try {
    const linger = execFileSync("loginctl", ["show-user", String(process.getuid?.() ?? -1), "--property=Linger", "--value"], { encoding: "utf8", timeout: 5000 }).trim();
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore", timeout: 5000 });
    return linger === "yes";
  } catch {
    return false;
  }
})();
// Containment, not a security probe: skipped locally with a reason, but CI starts a user manager and must run it (owner M2-Q8, R92).
if (!available && process.env.CI) throw new Error("scope.int.test: CI must provide a lingering systemd user manager (see ci.yml)");
if (!available) console.warn("scope.int.test: skipped: no lingering systemd user manager answers on this machine");

// A slice of the test's own (a temporary PAP_HOME): never the owner's daemon slice.
let home: string;
const scopesWith = (limits: ScopeLimits): Promise<WorkerScopes> =>
  probeScopes("auto", { ...limits, memorySwapMaxMb: 0 }, {
    home,
    uid: process.getuid?.() ?? -1,
    exec: execFileText,
    execSync: execFileCode,
    env: process.env,
    which: (command) => whichOnPath(command, process.env),
    clock: createSystemClock(),
    logger: silentLogger,
  });
const pgrpOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[2]);
const scopeOf = (scopes: WorkerScopes) => {
  const next = scopes.next();
  if (!next) throw new Error("no scope");
  return next;
};

let bed: RogueBed;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-scope-home-"));
  bed = createRogueBed();
});
afterEach(async () => {
  try {
    await bed.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe.skipIf(!available)("workers in systemd user scopes", () => {
  it("runs a worker in a unit of its home's slice with MemoryMax, leading its own process group (R106)", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 });
    const scope = scopeOf(scopes);
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    const pid = realPid(handle.pid);
    expect(pgrpOf(pid)).toBe(pid);
    expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(`${scopes.slice}/${scope.unit}`);
    const max = execFileSync("systemctl", ["--user", "show", scope.unit, "--property=MemoryMax", "--value"], { encoding: "utf8" }).trim();
    expect(max).toBe(String(2048 * 1024 * 1024));
    await handle.stop();
  });

  it("stops the scope after the worker dies, so what it started in a group of its own dies too (R100)", async () => {
    const scope = scopeOf(await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 }));
    const handle = bed.rogue("setsid-child", { scope });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    process.kill(realPid(handle.pid), "SIGKILL");
    expect((await handle.exited).cause).toBe("killed");
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 5000 });
  });

  it("says out of memory when the scope's limit kills the worker itself", async () => {
    const handle = bed.rogue("hog", { scope: scopeOf(await scopesWith({ memoryMaxMb: 128, tasksMax: 64 })) });
    expect((await handle.exited).cause).toBe("oom");
  });

  it("keeps the worker when the limit kills a child it started (OOMPolicy=continue, owner R2-1)", async () => {
    const handle = bed.rogue("child-hog", { scope: scopeOf(await scopesWith({ memoryMaxMb: 256, tasksMax: 64 })) });
    const records = bed.collect(handle);
    await vi.waitFor(() => expect(records.some((r) => r.type === "extension_error" && r.event === "child_exit" && r.error === "SIGKILL")).toBe(true), { timeout: 20_000 });
    expect(alive(realPid(handle.pid))).toBe(true);
    // The rogue worker ignores `shutdown`: the ladder's SIGTERM ends it, and its exit is that signal, not memory.
    expect((await handle.stop()).cause).toBe("signal");
  });

  it("sweeps what an earlier daemon of the same home left in its slice", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 });
    const handle = bed.rogue("setsid-child", { scope: scopeOf(scopes) });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    await (await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 })).sweep();
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 5000 });
    await handle.exited;
  });
});
```

(`bed.collect(handle)` records `extension_error` records as the rogue bed already does for every pap record; if it filters them, extend it to keep them.)

- [ ] **Step 6: Run and commit**

Run: `pnpm test:int apps/daemon/src/kernel/supervisor`
Expected: PASS on this host (five scope tests run); elsewhere they are reported as skipped with the warning line, and with `CI` set and no user manager the file fails.

```bash
git add apps/daemon/src/kernel
git commit -m "feat(daemon): run workers in per-home systemd user scopes and reap them after exit"
```

---

### Task 6: Config, boot probe and sweep, the daemon-layer network-guard check (R118), a user manager in CI

**Rulings (pre-dispatch):**
- **M2R33** [6] Environment names `PAP_WORKER_IDLE_MINUTES` (default 30, `0` = never), `PAP_WORKER_SCOPE` (`auto` | `off`), `PAP_WORKER_MEMORY_MAX_MB` (default `max(2048, ½ RAM)`, ≥ 256), `PAP_WORKER_TASKS_MAX` (default 4096, ≥ 64); no `PAP_WORKER_MEMORY_HIGH_MB`, since scopes set no `MemoryHigh` (owner R2-1) — the existing `PAP_*` style — cost if wrong: rename churn.
- **M2R34** [6, 10b] Every test daemon and bed runs with scopes off: the harness defaults `workerScope: "off"`, `modules/sessions/index.test.ts` and `sessions.int.test.ts` pass `scopes: NO_SCOPES`, the int bed (10b) does too unless a test passes `scopes`, `main.int.test.ts` sets `PAP_WORKER_SCOPE=off`, and the smoke runs without `XDG_RUNTIME_DIR` so its probe finds no user manager (M2-RT-20, owner R2-3) — tests never create units in the owner's user manager — cost if wrong: stray test units next to the owner's workers.
- **M2R35** [6] The R118 check reads the last 8 KiB of each worker's output (`OUTPUT_TAIL_BYTES`, R102) and says so in a comment: a refusal followed by more than 8 KiB of other output is not seen — bounded tail by design — cost if wrong: a swallowed block missed after noisy output.
- **M2R36** [6] CI's `integration` job and the nightly `pi-compat` job start a lingering user manager before `pnpm test:int` (`sudo loginctl enable-linger`, `sudo systemctl start user@<uid>.service`, `XDG_RUNTIME_DIR` exported through `$GITHUB_ENV`), pinned by one new `scripts/ci-config.test.ts` case; the M1 guards stay as they are (owner M2-Q8, agreement 11) — GitHub's Ubuntu runners allow passwordless sudo — cost if wrong: CI fails at the scope tests, which is the intended signal.
- **M2R37** [5, 6] Boot order: `probeScopes` then `scopes.sweep()` before the sessions module can start a worker; `main.ts`'s `killWorkers` (the given-up stop) also runs `daemon.killScopes()` (bounded, synchronous) — leftovers die before new workers start, and a forced exit leaves none — cost if wrong: Pi's detached trees outliving a daemon crash.

**Files:**
- Modify: `apps/daemon/src/kernel/config.ts`, `config.test.ts`, `apps/daemon/src/daemon.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/main.int.test.ts` (`PAP_WORKER_SCOPE=off` in its env), `apps/daemon/src/modules/sessions/{index,service,live-session}.ts`, `apps/daemon/src/modules/sessions/index.test.ts` and `sessions.int.test.ts` (both call `createSessionsModule`: `scopes: NO_SCOPES`), `apps/daemon/src/testing/harness.ts`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/pi-compat.yml`, `scripts/ci-config.test.ts`
- Create: `apps/daemon/src/testing/harness.int.test.ts`

**Interfaces:**
- Consumes: Task 5 `probeScopes`, `defaultMemoryMaxMb`, `execFileText`, `execFileCode`, `whichOnPath`.
- Produces:
  - `Config.workerIdleMs: number` (`PAP_WORKER_IDLE_MINUTES`, default 30, `0` = never release), `Config.workerScope: "auto" | "off"` (`PAP_WORKER_SCOPE`, default `auto`), `Config.workerLimits: ScopeLimits` (`PAP_WORKER_MEMORY_MAX_MB` default `defaultMemoryMaxMb(totalMemMb)`, ≥ 256; `PAP_WORKER_TASKS_MAX` default 4096, ≥ 64; each a `ConfigError` with a fixed message otherwise).
  - `SessionsModuleDeps.scopes: WorkerScopes` (required) and `SessionsModuleDeps.onWorkerExit?(sessionId: string, info: { exit: WorkerExit; outputTail: string }): void`; `DaemonDeps.onWorkerExit?` passed through; `DaemonHandle.killScopes(): void`.
  - `startTestDaemon(script, { extensions?: Record<string, string> })` writes each `<name>.js` into the agent directory's `extensions/`; its `stop()` throws `a worker tried to reach the network:\n<lines>` when an exited worker's output tail has a line starting `pap-network-guard: blocked`. The harness runs with `workerScope: "off"` unless a test sets it.

- [ ] **Step 1: Write the failing tests**

In `config.test.ts` (`base` has `totalMemMb: 16_384`):

```ts
describe("worker settings", () => {
  it("defaults to 30 idle minutes, automatic scopes, half the RAM (at least 2 GiB) and 4096 tasks", () => {
    const config = loadConfig(base);
    expect(config.workerIdleMs).toBe(30 * 60_000);
    expect(config.workerScope).toBe("auto");
    expect(config.workerLimits).toEqual({ memoryMaxMb: 8192, tasksMax: 4096 });
    expect(loadConfig({ ...base, totalMemMb: 2048 }).workerLimits.memoryMaxMb).toBe(2048);
  });

  it("reads them from the environment", () => {
    const config = loadConfig({ ...base, env: { PAP_WORKER_IDLE_MINUTES: "0", PAP_WORKER_SCOPE: "off", PAP_WORKER_MEMORY_MAX_MB: "1024", PAP_WORKER_TASKS_MAX: "512" } });
    expect(config.workerIdleMs).toBe(0);
    expect(config.workerScope).toBe("off");
    expect(config.workerLimits).toEqual({ memoryMaxMb: 1024, tasksMax: 512 });
  });

  it.each([
    [{ PAP_WORKER_SCOPE: "maybe" }, "PAP_WORKER_SCOPE must be auto or off"],
    [{ PAP_WORKER_MEMORY_MAX_MB: "128" }, "PAP_WORKER_MEMORY_MAX_MB must be an integer ≥ 256"],
    [{ PAP_WORKER_TASKS_MAX: "8" }, "PAP_WORKER_TASKS_MAX must be an integer ≥ 64"],
    [{ PAP_WORKER_IDLE_MINUTES: "-1" }, "PAP_WORKER_IDLE_MINUTES must be an integer ≥ 0"],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig({ ...base, env })).toThrow(message);
  });
});
```

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

(The sneaky extension's bare `.catch(() => {})` is the behaviour under test: a refusal swallowed by extension code.)

`scripts/ci-config.test.ts` gains:

```ts
it("starts a lingering systemd user manager before the integration tests (owner M2-Q8)", () => {
  const jobs = [workflow("ci").jobs["integration"], Object.values(workflow("pi-compat").jobs)[0]];
  for (const job of jobs) {
    const steps = job?.steps ?? [];
    const linger = steps.findIndex((step) => step.run?.includes("loginctl enable-linger"));
    const tests = steps.findIndex((step) => step.run?.includes("pnpm test:int"));
    expect(linger).toBeGreaterThanOrEqual(0);
    expect(linger).toBeLessThan(tests);
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/config.test.ts scripts/ci-config.test.ts && pnpm test:int apps/daemon/src/testing/harness.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`config.ts`: add the three fields to `Config`, parse them in `loadConfig` with the file's existing `parseCount` (and a `parseScope` that accepts exactly `auto` or `off`):

```ts
    workerIdleMs:
      (input.env.PAP_WORKER_IDLE_MINUTES ? parseCount(input.env.PAP_WORKER_IDLE_MINUTES, "PAP_WORKER_IDLE_MINUTES", 0) : 30) * 60_000,
    workerScope: parseScope(input.env.PAP_WORKER_SCOPE),
    workerLimits: {
      memoryMaxMb: input.env.PAP_WORKER_MEMORY_MAX_MB
        ? parseCount(input.env.PAP_WORKER_MEMORY_MAX_MB, "PAP_WORKER_MEMORY_MAX_MB", 256)
        : defaultMemoryMaxMb(input.totalMemMb),
      tasksMax: input.env.PAP_WORKER_TASKS_MAX ? parseCount(input.env.PAP_WORKER_TASKS_MAX, "PAP_WORKER_TASKS_MAX", 64) : 4096,
    },
```

(`defaultMemoryMaxMb` is imported from `./supervisor/scope.ts`.)

`daemon.ts`, before `createSessionsModule`:

```ts
    const scopes = await probeScopes(config.workerScope, config.workerLimits, {
      home: config.home,
      uid: process.getuid?.() ?? -1,
      exec: execFileText,
      execSync: execFileCode,
      env: deps.env ?? process.env,
      which: (command) => whichOnPath(command, deps.env ?? process.env),
      clock,
      logger,
    });
    // What an earlier daemon of this home left behind dies before any new worker starts (M2-RT-13).
    await scopes.sweep();
```

then `createSessionsModule({ …, scopes, onWorkerExit: deps.onWorkerExit })`, and the handle gains `killScopes: () => scopes.killAllNow()`. `main.ts`: `killWorkers: () => { const killed = killAllWorkerGroups(); daemon.killScopes(); return killed; }`. `sessions/index.ts` spawns with the scope:

```ts
    spawn: (cwd) => {
      const scope = deps.scopes.next();
      return spawnWorker({
        entry: config.piHostEntry,
        execArgv: config.piHostExecArgv,
        cwd,
        env,
        clock: deps.clock,
        logger: logger.child({ component: "worker", ...(scope ? { unit: scope.unit } : {}) }),
        ...(scope ? { scope } : {}),
      });
    },
```

`service.ts` passes `onWorkerExit` into each `LiveSession` as `onExit(exit)` already flows: in `live-session.ts`'s exit handler, after `deps.onExit(exit)`, call `deps.onWorkerExit?.({ exit, outputTail: handle.outputTail() })`; `service.ts` binds the session id: `onWorkerExit: (info) => deps.onWorkerExit?.(row.id, info)`. The tests' service bed passes nothing. `index.test.ts` and `sessions.int.test.ts` pass `scopes: NO_SCOPES`.

`harness.ts`: `TestDaemonOptions.extensions?: Record<string, string>` writes `<agentDir>/extensions/<name>.js` before `createDaemon`; the config gets `workerScope: "off", workerIdleMs: 30 * 60_000, workerLimits: { memoryMaxMb: 2048, tasksMax: 4096 }` (overridable through `options.config`); `deps.onWorkerExit` collects `{ sessionId, outputTail }`; `stop()`:

```ts
    async stop() {
      try {
        await daemon.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      // A connection the guard refused may have been swallowed by the code that tried it: the worker's log still says
      // so (R94, R118). Only the last 8 KiB of each worker's output are kept (R102): a refusal followed by more than
      // that of other output is not seen.
      const blocked = exits.flatMap((exit) => exit.outputTail.split("\n")).filter((line) => line.startsWith("pap-network-guard: blocked"));
      if (blocked.length > 0) throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
    },
```

`main.int.test.ts`'s `run()` env gains `PAP_WORKER_SCOPE: "off"`.

`.github/workflows/ci.yml`, `integration` job, before `- run: pnpm test:int` (and the same step in `pi-compat.yml` before its integration tests):

```yaml
      # Worker scopes need a lingering systemd user manager; the scope tests fail in CI without one (owner M2-Q8, R92).
      - run: |
          sudo loginctl enable-linger "$(id -un)"
          sudo systemctl start "user@$(id -u).service"
          echo "XDG_RUNTIME_DIR=/run/user/$(id -u)" >> "$GITHUB_ENV"
```

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/daemon scripts && pnpm test:int apps/daemon`
Expected: PASS.

```bash
git add apps/daemon/src .github/workflows scripts/ci-config.test.ts
git commit -m "feat(daemon): worker idle, scope and limit settings, boot sweep; fail tests on swallowed network refusals"
```

---

### Task 7: Sessions module split — no behaviour change

`live-session.ts` (315 lines) and `service.ts` (296) take most of M2's additions; this task moves code so they have room. Nothing changes in behaviour: every existing test passes unchanged.

**Rulings (pre-dispatch):**
- **M2R38** [7] A pure move, implemented by Sonnet (owner X2, M2-RT-40): the shared mutable `status`, `tracker`, `view`, dialogs and `limiter` become factory deps and R111b's generation logic must survive intact; a defect found while moving is reported, not fixed in this task — not mechanical — cost if wrong: a subtle run-tracker regression under the Opus-reviewed Task 8.
- **M2R39** [7, 11, 13a, 17a] One name per thing (M2-RT-38): `service-reads` exposes `ensureReader(): Promise<TranscriptReader>` (memoized; `prepare` and later reads use it) and `snapshot(sessionId)`; `live-ui.answer` keeps M1's `void` here and returns `{ answer; grant } | null` from Task 13a — later tasks call these names — cost if wrong: improvised names and a fix round.

**Files:**
- Create: `apps/daemon/src/modules/sessions/live-ui.ts`, `live-run.ts`, `worker-text.ts`, `service-reads.ts`
- Modify: `apps/daemon/src/modules/sessions/live-session.ts`, `service.ts`

**Interfaces:**
- Consumes: M1 sessions module, Task 6 `onWorkerExit`.
- Produces (internal to the module; later tasks edit these files):
  - `worker-text.ts`: `LOG_CHARS = 2000`, `clip(text)`, `SAFE_EVENT_NAME`, `outputTailOf(handle)` (the "…" + last 1999 characters rule).
  - `live-ui.ts`: `createLiveUi(deps: { handle; logger; limiter: RateLimiter; publish(event): void; publishPi(event: PiEvent): void }): LiveUi` with `onUiRequest(record)`, `onUiClosed(id)`, `onExtensionError(record)`, `answer(dialogId, response): void` (M1's signature; Task 13a returns the approval's grant), `dialogs(): Dialog[]`, `clear(): Dialog[]`; moves `CANCEL_NOTICES`, the dialog registry ownership and the bodies of M1's `onUiRequest`, `onExtensionError`, `answer` and the `extension_ui_closed` case.
  - `live-run.ts`: `createLiveRun(deps: { handle; clock; logger; setStatus(next: SessionStatus): void; record(kind, data): void; onActivity(): void; piFile(): string | undefined; getState(): Promise<GetStateData> }): LiveRun` with `tracker: RunTracker`, `onPiEvent(event)` (the tracker sees every event; the run view takes a `message_end` only when it is not Pi's system message, as M1 does), `prompt(text, behavior?)`, `abort()`, `runView()`, `onExit(): boolean` (returns whether a run was open, resets tracker and view); moves `ABORT_SETTLE_MS`, `closeStaleRun`, the tracker callbacks, the bodies of M1's `prompt` and `abort`.
  - `service-reads.ts`: `createSessionReads(deps: { store; agentDir; loadTranscript; live: ReadonlyMap<string, LiveSession>; statusOf(id): SessionStatus; owned(id, caller): SessionRow }): { prepare(sessionId, caller): Promise<void>; snapshot(sessionId): SessionStreamEvent; ensureReader(): Promise<TranscriptReader> }` (`ensureReader` is the memoized load `prepare` awaits; Tasks 11 and 17a call it); moves `transcript`, `loadingTranscript`, `prepareSubscription` and `snapshot` out of `service.ts`.
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

**Rulings (pre-dispatch):**
- **M2R40** [8] An abort with a prompt in flight sends one abort at once (a no-op if Pi is idle) and one at that prompt's `agent_start` (R113); the memory is dropped once every in-flight prompt answered without starting a run — the second abort is idempotent — cost if wrong: one extra no-op abort.
- **M2R41** [8] Every `.catch(() => undefined)` M1 left in the moved run code logs `worker_request_failed {command, code}` at debug instead — no silent catch (M1 lessons) — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/modules/sessions/live-session.run.test.ts` (`live-session.test.ts` is at 241 lines and Tasks 8–20 add about 200: run cases go here, M2-RT-19; it opens with the same `const setup = createLiveBed(startLiveSession)` line)
- Modify: `apps/daemon/src/modules/sessions/{run-tracker,live-run,service,pi-files,dialogs}.ts` and their tests (`run-tracker.test.ts`, `service.test.ts`, `pi-files.test.ts`, `dialogs.test.ts`)

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

`live-session.run.test.ts` (uses `createLiveBed`, whose fake worker holds a prompt with `holdPrompt`):

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
  open();
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
  await bed.clock.advance(0);
  const frames = await bed.subscribe(sessionId);
  void bed.service.prompt({ sessionId, text: "again" }, OWNER);
  await bed.clock.advance(0);
  expect(frames.map((frame) => (frame.event as { kind: string; status?: string })).filter((e) => e.kind === "status").map((e) => e.status)).toEqual(["starting", "idle"]);
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
### Task 9a: Live stream — 50 ms delta coalescing and the partial reply in the snapshot

References: T3 Code `packages/provider-pi/src/server/adapter.ts` (`STREAM_FLUSH_MS = 50`, deltas accumulated per content item); Orca `rpc-messages.ts` (deltas coalesced per content index); pi-web `docs/agents/sessions.md` "Tool execution events" (tool updates coalesced latest-wins and discarded before their end).

**Rulings (pre-dispatch):**
- **M2R42** [9a] Coalescer and partial-reply bounds as written: a flush every 50 ms, at once past 256 KiB of pending text or 256 distinct pending items; a reply past `MAX_PARTIAL_CHARS = 256 KiB` leaves the snapshot until the next assistant message (the client then gets it whole from `message_end`); each cap has a test that crosses it — spec C §4.3, bounded resources — cost if wrong: a reconnecting client sees a very long reply only at its end.
- **M2R43** [9a] The snapshot's partial reply is built only from events already published, never from pending deltas, and every event the live session publishes flushes the pending deltas first — the exactly-once rebuild of Review Focus 1 — cost if wrong: doubled or missing characters after a reconnect.

**Files:**
- Create: `apps/daemon/src/modules/sessions/coalescer.ts`, `coalescer.test.ts`, `partial.ts`, `partial.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{live-session,live-run,service-reads}.ts`, `live-session.run.test.ts`, `service.snapshot.test.ts`, `sessions.int.test.ts` (one streaming case)

**Interfaces:**
- Consumes: Task 1a `PartialMessage`, Task 1b snapshot, Task 7 split.
- Produces:
  - `createCoalescer({ clock, emit, flushMs? }): { push(event: PiEvent): void; flush(): void; dispose(): void }`, `DELTA_FLUSH_MS = 50`, `MAX_PENDING_ITEMS = 256`.
  - `createPartialReply(): { apply(event): void; current(): PartialMessage | null; reset(): void }`, `MAX_PARTIAL_CHARS` — fed with published events only.
  - `LiveSession.partial(): PartialMessage | null`. Every event the live session publishes sends the pending deltas first.

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

In `live-session.run.test.ts` (fake clock via `createLiveBed`):

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
  open();
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
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement the coalescer and the partial reply**

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
        run.onPiEvent(event);
        if (!isSystemMessage(event)) coalescer.push(event);
        deps.onActivity();
        return;
      }
```

(Task 9b puts `clipPiEvent` in this path.) The exit handler starts with `coalescer.flush(); partial.reset();` and the returned object gains `partial: () => partial.current()`; `service-reads.ts` passes `partial: session?.partial() ?? null` to `fitSnapshot`.

- [ ] **Step 5: Write the integration test**

Add this case to `apps/daemon/src/modules/sessions/sessions.int.test.ts`, which already has `moduleWith(script)`, `ctx`, `events()` and `promptAndSettle(id, text)` (the shared int bed arrives in Task 10b, which may move it there), and drop `sessions.stream.int.test.ts` from this task's file list:

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

- [ ] **Step 6: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions
git commit -m "feat(sessions): coalesce deltas every 50 ms, partial reply in snapshots"
```

---

### Task 9b: Tool output clipped on the wire; the web client's partial reply and tool view

References: pi-web `docs/agents/sessions.md` "Tool execution events" (`tool_execution_end` never carries the result); R111 ("strip or drop + notice").

**Rulings (pre-dispatch):**
- **M2R44** [9b] Wire previews: tool output 8 000 characters, progress tail 2 000, arguments 8 000 per string (depth 8, 1 000 items per array or object), details 8 KiB; a `message_update` `toolcall_end` carries its arguments clipped the same way, and `text_end` / `thinking_end` lose their `content` (the client has the deltas) (M2-RT-30, R111) — bounds the wire; the full output stays one `sessions.toolOutput` away — cost if wrong: bandwidth on very large calls.
- **M2R45** [9b] The progress of a call made inside another tool (`parentToolCallId`, codemode) is not sent at all — pi-web parity; codemode would flood the stream — cost if wrong: less live detail for nested calls.
- **M2R46** [9b, 25] `reduce-pi.ts` is created here (M2-RT-38): `reducePi` and the tool cases leave `session-reducer.ts`; the web `tools` map keeps at most 200 entries (the oldest finished first), keyed by tool-call id, latest wins; a provider that reuses ids is handled where rows are paired (Task 25, M2-RT-11) — keeps the reducer under 400 lines — cost if wrong: a stale status on a reused id until Task 25.

**Files:**
- Create: `apps/daemon/src/modules/sessions/wire-clip.ts`, `wire-clip.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{live-session,live-run}.ts`, `live-session.run.test.ts`
- Create: `apps/web/src/stores/partial-view.ts`, `apps/web/src/stores/reduce-pi.ts`; Modify: `apps/web/src/stores/{session-reducer,row-view}.ts`, `session-reducer.test.ts`, `apps/web/src/features/sessions/transcript.vm.ts`, `transcript.vm.test.ts`

**Interfaces:**
- Consumes: Task 9a coalescer and partial reply.
- Produces:
  - `clipPiEvent(event): PiEvent | null` (null = not sent: a nested tool's progress), `clipMessage(message)`, `clipArguments(value)`, constants `TOOL_PREVIEW_CHARS = 8000`, `UPDATE_PREVIEW_CHARS = 2000`, `ARG_PREVIEW_CHARS = 8000`, `MAX_ITEMS = 1000`. A clipped tool result carries `papTruncated: { chars: <full text length> }`; a clipped tool call carries `papTruncated: true`; an image becomes `{ type: "image", mimeType, omitted: true, bytes }`.
  - Web: `SessionView.partial: PartialMessage | null` (replaces `partialText`), `SessionView.tools: Record<toolCallId, { name; status: "running" | "done" | "failed"; preview }>`, `MessageView.truncatedChars: number | null`; `reducePi` in `stores/reduce-pi.ts`.

- [ ] **Step 1: Write the failing unit tests**

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

  it("drops the text of a finished block and clips a finished tool call's arguments (M2-RT-30, R111)", () => {
    const end = clipPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(900_000) } });
    expect(end).toEqual({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
    const call = clipPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "c1", name: "write", arguments: { content: "z".repeat(900_000) } } },
    }) as { assistantMessageEvent: { toolCall: { arguments: { content: string }; papTruncated?: boolean } } };
    expect(call.assistantMessageEvent.toolCall.arguments.content).toHaveLength(ARG_PREVIEW_CHARS);
    expect(call.assistantMessageEvent.toolCall.papTruncated).toBe(true);
  });
});
```

In `live-session.run.test.ts`: a `message_end` whose tool result holds 30 000 characters is published with `papTruncated: { chars: 30000 }` and the run view holds the same clipped row; a nested tool's `tool_execution_update` is not published. In `session-reducer.test.ts`: the cases of Step 4 below (partial, tools, the 201st tool view, `cold`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions apps/web/src/stores`
Expected: FAIL.

- [ ] **Step 3: Implement the wire clipping and put it in the live path**

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

/**
 * A `message_update` as it goes on the wire: the end of a text or thinking block drops its `content` (the client has
 * every delta), a finished tool call keeps its arguments clipped like a message's (M2-RT-30, R111).
 */
function clipUpdate(event: PiEvent): PiEvent {
  const update = event.assistantMessageEvent;
  if (!isObject(update)) return event;
  if (update.type === "text_end" || update.type === "thinking_end") {
    const { content: _content, ...rest } = update;
    return { ...event, assistantMessageEvent: rest };
  }
  if (update.type === "toolcall_end" && isObject(update.toolCall)) {
    const { value, cut } = clipArguments(update.toolCall.arguments);
    if (!cut) return event;
    return { ...event, assistantMessageEvent: { ...update, toolCall: { ...update.toolCall, arguments: value, papTruncated: true } } };
  }
  return event;
}

/** What a client is sent for a Pi event. Null: not sent at all (the progress of a call made inside another tool). */
export function clipPiEvent(event: PiEvent): PiEvent | null {
  switch (event.type) {
    case "message_update":
      return clipUpdate(event);
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

`live-session.ts`'s `pi_event` case clips before the run view and the coalescer see the event:

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

`live-run.ts`'s `onPiEvent` pushes `event.message` of a `message_end` into the run view: it now receives the clipped message, so the run view and the stream hold the same rows.

- [ ] **Step 4: Update the web reducer**

`apps/web/src/stores/partial-view.ts` mirrors the daemon's rules for the client (`applyPartial(partial: PartialMessage | null, event): PartialMessage | null` with the same `STARTS`/`DELTAS`, 64-block bound, assistant `message_start` → `{ blocks: [] }`, assistant `message_end`, `agent_end`, `agent_settled` → `null`), as a pure function returning a new value. `apps/web/src/stores/reduce-pi.ts` takes `reducePi` out of `session-reducer.ts` (M2-RT-38). `SessionView` replaces `partialText` with `partial: PartialMessage | null` and adds `tools`; the snapshot sets `partial: event.partial` and `tools: {}`; `reducePi` runs `applyPartial` on every event, and:

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

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): clip tool output on the wire; partial reply and tool view in the web client"
```

---

### Task 10a: Transcript reader v2 — bounded branch walks, a byte-bounded incremental cache, ADR 0007

The M1 snapshot showed Pi's model context (`buildSessionContext`): after a compaction the older messages disappeared. pi-web shows the whole active branch (`sliceActiveBranch` in `lib/session-reader.ts`), compactions as a summary card, and keeps entry ids for branching and paging. M2 does the same. The leaf of a hot session is the worker's (navigation moves it without writing anything, S1); the daemon reads Pi's file with that leaf instead of asking the worker for entries (`get_entries` returns every entry in one record, unbounded): ADR 0007. This half builds the reader; Task 10b tracks the leaf and binds entry ids live.

**Rulings (pre-dispatch):**
- **M2R47** [10a] ADR 0007 deviates from spec C §3.3 (`get_entries{since}`): every session, hot or cold, is read from Pi's file, with the worker's leaf for a hot one (owner M2-Q13 accepted the ADR) — `get_entries` sends every entry in one record, unbounded over IPC — cost if wrong: none beyond the recorded deviation.
- **M2R48** [10a] Every walk over `parentId` (the page, the turns above it, the fork points' path) keeps a visited set and stops after `entries.list.length` steps, and the newest descendant of every entry is computed once, in one reverse pass over the list, when the entries are indexed (M2-RT-03) — Pi files are writable by the agent, extensions and the Pi CLI; one self-parented entry must not spin the daemon's only event loop — cost if wrong: every session and socket of the daemon frozen.
- **M2R49** [10a] Parse budget: a file over `MAX_PARSE_BYTES = 32 MiB` is read from its last 32 MiB (one `session_file_issue {issue: "tail_only"}` per parse), and the cache keeps parsed files up to `MAX_CACHE_BYTES = 64 MiB` of source in total, least recently used out first (M2-RT-15, red-team ruling 10) — daemon memory (R108 aims at about 42 MB idle) — cost if wrong: the oldest history of a huge session not shown (too low) or hundreds of MB of RSS (too high).
- **M2R50** [10a] Pi appends while a worker holds a file: when the size grew, the inode and the header line are unchanged and the header is the current format (`CURRENT_SESSION_VERSION`), only the bytes after the last complete line are parsed and appended (no migration call: migrating lines without their header would treat them as format 1); a shrink, a new inode, a changed header, an older format or crossing the parse budget parses the file again (M2-RT-15) — a hot session's file changes on every entry, and a full parse of 30–60 MB stalls the loop — cost if wrong: a missed entry, which the full-parse triggers cover.
- **M2R51** [10a] An entry whose `id` or `parentId` is longer than 128 characters is left out of the index (`session_file_issue {issue: "long_id"}` once per parse, M2-RT-06); a line that is not JSON is skipped as Pi's own reader does (`bad_lines`, once per parse); an entry Pi's converter throws on shows as nothing and logs `transcript_entry_unreadable {type}` at most once every 10 s (M2-RT-33) — the client contract caps ids at 128, and nothing is dropped silently — cost if wrong: a branch cut at a long-id entry.

**Files:**
- Create: `apps/daemon/src/modules/sessions/branch.ts`, `branch.test.ts`, `entries-cache.ts`, `entries-cache.test.ts`, `docs/adr/0007-hot-session-reads-from-the-pi-file.md`
- Modify: `apps/daemon/src/modules/sessions/{transcript,service-reads,index}.ts`, `transcript.test.ts`, `service.snapshot.test.ts`

**Interfaces:**
- Consumes: Task 1a `TranscriptRow`, `HistoryMeta`; Task 9b `clipMessage`.
- Produces:
  - `branch.ts`: `EntryLike`, `Convert` (never throws), `IndexedEntries { list; byId; children; order; newest }`, `indexEntries(list)`, `displayMessages(entry, convert)`, `readBranchPage(entries, convert, { leafId?, before?, limit }): BranchPage { rows; hasMore; oldestEntryId; turnsBefore; leafId }`, `forkPoints(entries, convert, leafId?, maxPoints = 100, maxChoices = 16): ForkPoint[]`, `findToolCall(entries, toolCallId): { result: unknown | null; args: unknown | null }`, `MIN_RAW_WINDOW = 200`.
  - `entries-cache.ts`: `createEntriesCache(sdk: { CURRENT_SESSION_VERSION; migrateSessionEntries }, { maxBytes?, maxCacheBytes?, onIssue? }): { read(path, upToBytes?): IndexedEntries }`, `MAX_PARSE_BYTES`, `MAX_CACHE_BYTES`; issues `"tail_only" | "read_failed" | "long_id" | "bad_lines"`.
  - `TranscriptReader` v2: `page(file, { leafId?, before?, limit?, upToBytes? }): BranchPage`, `forks(file, leafId?)`, `toolCall(file, toolCallId)`, `lastEntryId(file)`; rows are clipped with `clipMessage`. `loadTranscriptReader(options?: { logger?: Logger; clock?: Clock })` (the sessions module passes its own; tests may pass none).
  - Snapshot: rows read with `page` (no leaf yet: the file's last entry), `history` from the page.

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

  it("returns a finite page and fork points for a self-cycle and a 2-cycle (M2-RT-03)", () => {
    const selfCycle = indexEntries([msg("u0", "u0", "user", "loop")]);
    expect(ids(readBranchPage(selfCycle, convert, { limit: 75 }).rows)).toEqual(["u0"]);
    expect(forkPoints(selfCycle, convert)).toEqual([]);
    const twoCycle = indexEntries([msg("a", "b", "user", "one"), msg("b", "a", "assistant", "two"), msg("c", "a", "user", "three")]);
    expect(ids(readBranchPage(twoCycle, convert, { leafId: "b", limit: 75 }).rows)).toEqual(["a", "b"]);
    expect(ids(readBranchPage(twoCycle, convert, { before: "a", limit: 75 }).rows)).toEqual(["a", "b"]);
    expect(forkPoints(twoCycle, convert, "b").map((point) => point.parentId)).toEqual(["a"]);
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-entries-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const header = (id = "s") => JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: "/w" });
const entry = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId, timestamp: "t", message: { role: "user", content: id, timestamp: 1 } });
// Counts full parses: the cache migrates a file only when it parses it whole.
const counting = () => {
  const sdk = { CURRENT_SESSION_VERSION: 3, parses: 0, migrateSessionEntries: () => void sdk.parses++ };
  return sdk;
};
const ids = (cache: ReturnType<typeof createEntriesCache>, file: string, upTo?: number) => cache.read(file, upTo).list.map((e) => e.id);

describe("entries cache", () => {
  it("leaves out a line Pi has not finished writing, and reads only up to a size", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n{"type":"mess`);
    const cache = createEntriesCache(counting());
    expect(ids(cache, file)).toEqual(["e1", "e2"]);
    expect(ids(cache, file, Buffer.byteLength(`${header()}\n${entry("e1", null)}\n`))).toEqual(["e1"]);
  });

  it("parses only the lines appended to a growing file of the current format", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`);
    const sdk = counting();
    const cache = createEntriesCache(sdk);
    expect(ids(cache, file)).toEqual(["e1"]);
    appendFileSync(file, `${entry("e2", "e1")}\n${entry("e3", "e2")}\n`);
    expect(ids(cache, file)).toEqual(["e1", "e2", "e3"]);
    expect(sdk.parses).toBe(1);
    expect(ids(cache, file, Buffer.byteLength(`${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`))).toEqual(["e1", "e2"]);
  });

  it("parses the whole file again when it shrank, its header changed, or it is an older format", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`);
    const sdk = counting();
    const cache = createEntriesCache(sdk);
    ids(cache, file);
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`);
    expect(ids(cache, file)).toEqual(["e1"]);
    writeFileSync(file, `${header("other-session")}\n${entry("x1", null)}\n${entry("x2", "x1")}\n`);
    expect(ids(cache, file)).toEqual(["x1", "x2"]);
    const old = join(dir, "old.jsonl");
    writeFileSync(old, `${JSON.stringify({ type: "session", version: 2, id: "o", timestamp: "t", cwd: "/w" })}\n${entry("o1", null)}\n`);
    ids(cache, old);
    appendFileSync(old, `${entry("o2", "o1")}\n`);
    expect(ids(cache, old)).toEqual(["o1", "o2"]);
    expect(sdk.parses).toBe(5);
  });

  it("gives nothing for a missing file and skips lines that are not JSON, once said", () => {
    const issues: string[] = [];
    const cache = createEntriesCache(counting(), { onIssue: (issue) => void issues.push(issue) });
    expect(cache.read(join(dir, "missing.jsonl")).list).toEqual([]);
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\nnot json\n${entry("e1", null)}\nalso not json\n`);
    expect(ids(cache, file)).toEqual(["e1"]);
    expect(issues).toEqual(["bad_lines"]);
  });

  it("leaves out an entry whose id is longer than 128 characters, and says so (M2-RT-06)", () => {
    const issues: string[] = [];
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("x".repeat(129), "e1")}\n`);
    expect(ids(createEntriesCache(counting(), { onIssue: (issue) => void issues.push(issue) }), file)).toEqual(["e1"]);
    expect(issues).toEqual(["long_id"]);
  });

  it("reads only the tail of a file over maxBytes, and says so", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n${entry("e3", "e2")}\n`);
    const issues: Array<[string, number]> = [];
    const cache = createEntriesCache(counting(), { maxBytes: Buffer.byteLength(`${entry("e3", "e2")}\n`) + 5, onIssue: (issue, size) => void issues.push([issue, size]) });
    expect(ids(cache, file)).toEqual(["e3"]);
    expect(issues).toEqual([["tail_only", statSync(file).size]]);
  });

  it("keeps parsed files under its byte budget, least recently used out first (M2-RT-15)", () => {
    const files = ["a", "b", "c"].map((name) => {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, `${header()}\n${entry(name, null)}\n`);
      return file;
    });
    const each = statSync(files[0] ?? "").size;
    const sdk = counting();
    const cache = createEntriesCache(sdk, { maxCacheBytes: Math.floor(each * 2.5) });
    for (const file of [...files, files[0] ?? ""]) cache.read(file);
    // a, b, c parsed; c pushes a out (three files are over 2.5 files' bytes); a is parsed again.
    expect(sdk.parses).toBe(4);
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
/** Pi's entry → messages conversion. Never throws: the reader's converter logs and returns [] for an entry Pi refuses. */
export type Convert = (entry: EntryLike) => unknown[];
export interface IndexedEntries {
  readonly list: readonly EntryLike[];
  readonly byId: ReadonlyMap<string, EntryLike>;
  readonly children: ReadonlyMap<string | null, readonly EntryLike[]>;
  /** Append order: the newest entry under a fork is the one with the highest number. */
  readonly order: ReadonlyMap<string, number>;
  /** Each entry's newest descendant (itself when it has none), computed once in one reverse pass (M2-RT-03). */
  readonly newest: ReadonlyMap<string, EntryLike>;
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
  // Children are appended after their parent, so walking the list backwards sees a whole subtree before its root.
  // One pass, one step per entry: a cycle in a damaged file cannot make it loop.
  const newest = new Map<string, EntryLike>();
  for (let index = list.length - 1; index >= 0; index--) {
    const entry = list[index] as EntryLike;
    const candidate = newest.get(entry.id) ?? entry;
    newest.set(entry.id, candidate);
    const parent = entry.parentId;
    if (parent === null || parent === entry.id) continue;
    const current = newest.get(parent);
    if (!current || (order.get(candidate.id) ?? -1) > (order.get(current.id) ?? -1)) newest.set(parent, candidate);
  }
  return { list, byId, children, order, newest };
}

/** Up the parent chain from `start`, each entry once and at most one step per entry of the file (M2-RT-03). */
function* ancestry(entries: IndexedEntries, start: EntryLike | undefined): Generator<EntryLike> {
  const seen = new Set<string>();
  for (let entry = start; entry && !seen.has(entry.id) && seen.size < entries.list.length; ) {
    seen.add(entry.id);
    yield entry;
    entry = entry.parentId ? entries.byId.get(entry.parentId) : undefined;
  }
}

const roleOf = (message: unknown): unknown => (message as { role?: unknown } | null)?.role;

/** What a client shows of one entry: never Pi's system prompt, never a custom message hidden from display. */
export function displayMessages(entry: EntryLike, convert: Convert): unknown[] {
  if (entry.type === "message" && roleOf(entry.message) === "system") return [];
  if (entry.type === "custom_message" && entry.display === false) return [];
  return convert(entry).filter((message) => roleOf(message) !== "system");
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
  const start = options.before === undefined ? leaf : cursor?.parentId ? entries.byId.get(cursor.parentId) : undefined;
  const chain: EntryLike[] = [];
  const rawCap = Math.max(MIN_RAW_WINDOW, options.limit * 6);
  let visible = 0;
  let hasMore = false;
  let turnsBefore = 0;
  // One bounded walk: the page first, then what is above it (counted, never kept).
  for (const entry of ancestry(entries, start)) {
    if (visible < options.limit && chain.length < rawCap) {
      chain.push(entry);
      visible += displayMessages(entry, convert).length;
      continue;
    }
    const shown = displayMessages(entry, convert);
    if (shown.length > 0) hasMore = true;
    turnsBefore += shown.filter(isAnchor).length;
  }
  const rows = chain.toReversed().flatMap((entry) => displayMessages(entry, convert).map((message) => ({ entryId: entry.id, message })));
  return { rows, hasMore, oldestEntryId: chain.at(-1)?.id ?? null, turnsBefore, leafId: leaf?.id ?? null };
}

function previewOf(entry: EntryLike, convert: Convert): string {
  const message = displayMessages(entry, convert)[0] as { content?: unknown; summary?: unknown } | undefined;
  const content = message?.content ?? message?.summary;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (block as { text?: unknown }).text).filter((part) => typeof part === "string").join(" ") : "";
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

/** Where the active branch forks, and for each choice the leaf a switch to it goes to: its newest entry. */
export function forkPoints(entries: IndexedEntries, convert: Convert, leafId?: string | null, maxPoints = 100, maxChoices = 16): ForkPoint[] {
  const path = [...ancestry(entries, leafOf(entries, leafId))];
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
        target: (entries.newest.get(kid.id) ?? kid).id,
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
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type EntryLike, type IndexedEntries, indexEntries } from "./branch.ts";

/** A file over this is read from its last `MAX_PARSE_BYTES` only: the oldest history of a huge session is not shown. */
export const MAX_PARSE_BYTES = 32 * 1024 * 1024;
/** Source bytes kept parsed across every file (M2-RT-15); the least recently read file goes first. */
export const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ID_CHARS = 128;
const HEADER_BYTES = 64 * 1024;

export type EntriesIssue = "tail_only" | "read_failed" | "long_id" | "bad_lines";
export interface EntriesSdk {
  readonly CURRENT_SESSION_VERSION: number;
  migrateSessionEntries(entries: never[]): void;
}
export interface EntriesCache {
  read(path: string, upToBytes?: number): IndexedEntries;
}

interface Parsed {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** The offset where the parsed bytes start: 0, or the first whole line of a large file's tail. */
  readonly base: number;
  /** The offset just past the last complete line read: an append is parsed from here. */
  readonly parsedUpTo: number;
  /** The header line as read: a file rewritten in place (same inode, `openSync(file, "w")`) changes it. */
  readonly header: string | null;
  /** Whether the header's format is current: only then is an appended line parsed without its header. */
  readonly current: boolean;
  readonly entries: readonly EntryLike[];
  /** The offset just past each entry's line, in the same order. */
  readonly ends: readonly number[];
  index: IndexedEntries | null;
}

const EMPTY = indexEntries([]);

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, start));
  } finally {
    closeSync(fd);
  }
}

/** Complete lines only: the bytes after the last newline are a line Pi is still writing (R38). */
function parseLines(buffer: Buffer, base: number) {
  const records: Array<Record<string, unknown>> = [];
  const ends: number[] = [];
  let bad = 0;
  let start = 0;
  for (let at = buffer.indexOf(0x0a); at !== -1; at = buffer.indexOf(0x0a, start)) {
    const line = buffer.toString("utf8", start, at).trim();
    start = at + 1;
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
        records.push(value as Record<string, unknown>);
        ends.push(base + start);
      } else bad++;
    } catch {
      // Skipped as Pi's own reader does; counted and reported once per parse by the caller.
      bad++;
    }
  }
  return { records, ends, consumed: base + start, bad };
}

export function createEntriesCache(
  sdk: EntriesSdk,
  options: { maxBytes?: number; maxCacheBytes?: number; onIssue?(issue: EntriesIssue, size: number): void } = {},
): EntriesCache {
  const maxBytes = options.maxBytes ?? MAX_PARSE_BYTES;
  const maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
  const files = new Map<string, Parsed>();
  const say = (issue: EntriesIssue, size: number) => options.onIssue?.(issue, size);

  const keep = (records: ReadonlyArray<Record<string, unknown>>, ends: readonly number[], size: number) => {
    const entries: EntryLike[] = [];
    const entryEnds: number[] = [];
    let longIds = 0;
    records.forEach((record, index) => {
      if (record.type === "session" || typeof record.id !== "string") return;
      const parent = record.parentId;
      if (record.id.length > MAX_ID_CHARS || (typeof parent === "string" && parent.length > MAX_ID_CHARS)) {
        longIds++;
        return;
      }
      entries.push(record as unknown as EntryLike);
      entryEnds.push(ends[index] ?? 0);
    });
    if (longIds > 0) say("long_id", size);
    return { entries, ends: entryEnds };
  };

  const headerOf = (path: string, size: number): { line: string; record: Record<string, unknown> | null } | null => {
    const head = readRange(path, 0, Math.min(size, HEADER_BYTES));
    const end = head.indexOf(0x0a);
    if (end === -1) return null;
    const line = head.toString("utf8", 0, end);
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      return { line, record: record?.type === "session" ? record : null };
    } catch {
      return { line, record: null };
    }
  };

  const full = (path: string, stat: { ino: number; size: number; mtimeMs: number }): Parsed => {
    const header = headerOf(path, stat.size);
    let base = 0;
    let buffer: Buffer;
    if (stat.size > maxBytes) {
      const tail = readRange(path, stat.size - maxBytes, maxBytes);
      const first = tail.indexOf(0x0a);
      base = stat.size - maxBytes + first + 1;
      buffer = tail.subarray(first + 1);
      say("tail_only", stat.size);
    } else buffer = readRange(path, 0, stat.size);
    const parsed = parseLines(buffer, base);
    if (parsed.bad > 0) say("bad_lines", stat.size);
    // The header goes with a tail so the migration sees the file's format; it is a no-op for a current file.
    const records = base > 0 && header?.record ? [header.record, ...parsed.records] : parsed.records;
    sdk.migrateSessionEntries(records as never[]);
    const kept = keep(records, base > 0 && header?.record ? [0, ...parsed.ends] : parsed.ends, stat.size);
    const version = header?.record?.version;
    return {
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      base,
      parsedUpTo: parsed.consumed,
      header: header?.line ?? null,
      current: typeof version === "number" && version >= sdk.CURRENT_SESSION_VERSION,
      entries: kept.entries,
      ends: kept.ends,
      index: null,
    };
  };

  const appendable = (path: string, cached: Parsed, stat: { ino: number; size: number }): boolean => {
    if (!cached.current || cached.header === null || stat.ino !== cached.ino || stat.size <= cached.size) return false;
    if (stat.size - cached.base > maxBytes) return false;
    return headerOf(path, stat.size)?.line === cached.header;
  };

  const append = (path: string, cached: Parsed, stat: { size: number; mtimeMs: number }): Parsed => {
    const fresh = parseLines(readRange(path, cached.parsedUpTo, stat.size - cached.parsedUpTo), cached.parsedUpTo);
    if (fresh.bad > 0) say("bad_lines", stat.size);
    // The header is current (checked): appended lines need no migration, and migrating them alone would be wrong.
    const kept = keep(fresh.records, fresh.ends, stat.size);
    return {
      ...cached,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      parsedUpTo: fresh.consumed,
      entries: cached.entries.concat(kept.entries),
      ends: cached.ends.concat(kept.ends),
      index: null,
    };
  };

  const remember = (path: string, parsed: Parsed): void => {
    files.delete(path);
    files.set(path, parsed);
    const weight = (entry: Parsed) => entry.parsedUpTo - entry.base;
    let total = 0;
    for (const entry of files.values()) total += weight(entry);
    for (const [key, entry] of files) {
      if (total <= maxCacheBytes || key === path) break;
      files.delete(key);
      total -= weight(entry);
    }
  };

  const load = (path: string): Parsed | null => {
    let stat: { ino: number; size: number; mtimeMs: number };
    try {
      stat = statSync(path);
    } catch {
      // A draft has no file yet (S1): nothing to read, nothing to report.
      files.delete(path);
      return null;
    }
    const cached = files.get(path);
    if (cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      remember(path, cached);
      return cached;
    }
    try {
      const parsed = cached && appendable(path, cached, stat) ? append(path, cached, stat) : full(path, stat);
      remember(path, parsed);
      return parsed;
    } catch {
      say("read_failed", stat.size);
      files.delete(path);
      return null;
    }
  };

  return {
    read(path, upToBytes) {
      const parsed = load(path);
      if (!parsed) return EMPTY;
      if (upToBytes === undefined) return (parsed.index ??= indexEntries(parsed.entries));
      return indexEntries(parsed.entries.filter((_entry, index) => (parsed.ends[index] ?? Infinity) <= upToBytes));
    },
  };
}
```

`transcript.ts` keeps `loadTranscriptReader()` (lazy, R108) and builds the v2 reader:

```ts
type Sdk = Pick<typeof import("@earendil-works/pi-coding-agent"), "migrateSessionEntries" | "sessionEntryToContextMessages" | "CURRENT_SESSION_VERSION">;

export interface TranscriptReader {
  page(filePath: string, options?: { leafId?: string | null; before?: string; limit?: number; upToBytes?: number }): BranchPage;
  forks(filePath: string, leafId?: string | null): ForkPoint[];
  toolCall(filePath: string, toolCallId: string): { result: unknown | null; args: unknown | null };
  lastEntryId(filePath: string): string | null;
}

const UNREADABLE_EVERY_MS = 10_000;

function createTranscriptReader(sdk: Sdk, logger: Logger, clock: Clock): TranscriptReader {
  // No path in the log lines: the size and the kind of issue are enough to act on.
  const cache = createEntriesCache(sdk as never, { onIssue: (issue, size) => logger.warn("session_file_issue", { issue, size }) });
  const limiter = createRateLimiter(clock, UNREADABLE_EVERY_MS);
  // An entry Pi's helper refuses shows as nothing, never as a blank transcript, and is said (M2-RT-33).
  const convert: Convert = (entry) => {
    try {
      return sdk.sessionEntryToContextMessages(entry as never);
    } catch {
      const said = limiter.check("transcript_entry_unreadable");
      if (said.allowed) logger.warn("transcript_entry_unreadable", { type: String(entry.type).slice(0, 64), suppressed: said.suppressed });
      return [];
    }
  };
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

`loadTranscriptReader(options: { logger?: Logger; clock?: Clock } = {})` uses `options.logger ?? silentLogger` and `options.clock ?? createSystemClock()`, memoized as before (the first call's logger is the reader's); `sessions/index.ts` passes `loadTranscript: () => loadTranscriptReader({ logger, clock: deps.clock })`. `transcript.test.ts` moves to `reader.page(file).rows.map((row) => row.message.role)`; a missing file gives an empty page with no log line, an unreadable one an empty page and one `session_file_issue {issue: "read_failed"}` line (test with a captured logger and a 0o000 file); `transcript.lazy.test.ts` is unchanged (still proves the SDK is imported lazily).

`service-reads.ts` `snapshot()` reads its rows through the new reader (the leaf comes in Task 10b, so a page follows the file's last entry):

```ts
    const page = file ? reader.page(file, { upToBytes: run?.baselineBytes, limit: SNAPSHOT_ROWS }) : EMPTY_PAGE;
    const rows = [...page.rows, ...(run?.messages ?? []).map((message) => ({ entryId: null, message }))];
    return fitSnapshot({ status: statusOf(sessionId), rows, dialogs: session?.dialogs() ?? [], partial: session?.partial() ?? null, history: page });
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
The daemon reads hot and cold sessions from Pi's file through the SDK's own helpers. Parsed entries are cached per
file, up to 64 MiB of source across files (least recently read out first); a file Pi appended to is parsed from its
last complete line only, and a file over 32 MiB is read from its tail. Every walk over parent links is bounded by the
number of entries and keeps a visited set, so a damaged file (a cycle) gives a finite answer. For a hot session the
daemon walks the branch from the worker's leaf, which it tracks from `ready.leafId`, every `entry_appended` and every
`navigate_tree` answer; during a run it reads the file only up to its size when the run began, from the leaf at that
moment, and appends the run's own rows (R38).

## Consequences
- No transcript ever travels over IPC; history pages and tool output on demand read the file too.
- A navigation nobody continued is lost when the worker goes away (release, crash): Pi's leaf lives in memory. pi-web
  behaves the same (owner M2-Q11). The composer keeps the text "Edit from here" put in it (Task 24).
- The daemon parses synchronously: a full parse costs one pass over at most 32 MiB, an append only the new lines.
- The oldest history of a session file over 32 MiB is not shown (logged as `tail_only`).
```

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions docs/adr/0007-hot-session-reads-from-the-pi-file.md
git commit -m "feat(sessions): transcript rows along the active branch, bounded walks and an incremental parse cache"
```

---

### Task 10b: Leaf tracking, `row` and `entry` events, the shared integration bed

**Rulings (pre-dispatch):**
- **M2R52** [10b, 17a] The leaf comes from `ready.leafId`, every `entry_appended` and (Task 17a) every `navigate_tree` answer; a leaf id over 128 characters counts as unknown and the page follows the file's last entry (M2R4) — Pi keeps the leaf in memory only — cost if wrong: a stale branch shown until the next entry.
- **M2R53** [10b, 20, 22] The int bed runs workers with `NO_SCOPES` unless a test passes `scopes`, collects each worker's exit (cause and output tail) for Tasks 20 and 22, and fails `dispose()` on a swallowed network refusal (R118); it passes `workerIdleMs` only from Task 20, when the config type has the field (an object literal with an unknown field does not compile) — tests default scopes off (owner R2-3) — cost if wrong: test units in the owner's user manager.

**Files:**
- Create: `apps/daemon/src/modules/sessions/testing/int-bed.ts`, `sessions.transcript.int.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{live-session,live-run,run-view,service-reads,snapshot}.ts`, `run-view.test.ts`, `live-session.run.test.ts`, `service.snapshot.test.ts`
- Modify: `apps/web/src/stores/{session-reducer,row-view}.ts`, `session-reducer.test.ts`, `apps/web/src/features/sessions/transcript.vm.ts`

**Interfaces:**
- Consumes: Task 1a `EntryRef`, `HistoryMeta`; Task 2 slim `entry_appended`; Task 10a reader.
- Produces:
  - `LiveSession.leafId(): string | null` (from `ready`, each appended entry, and — Task 17a — navigation); `RunViewState` gains `leafAtStart: string | null` and holds `rows: TranscriptRow[]` (entry ids bound as `entry_appended` arrives).
  - Stream: `{kind: "entry", entry}` for every appended entry (never forwarded as a raw Pi event); `{kind: "row", row}` for a compaction or branch summary.
  - Snapshot: rows with entry ids, `history` (trimmed with `withTrimmedHistory`), `leafId`.
  - `int-bed.ts`: `createIntBed(script, options?)` (see Step 3) used by every later integration test of the module; `bed.exits` lists `{ sessionId, exit, outputTail }`.
  - Web: `MessageView.entryId` bound from `entry` events; roles `compactionSummary`, `branchSummary`, `custom` (hidden when `display === false`); `SessionView.history: HistoryMeta`, `SessionView.leafId`.

- [ ] **Step 1: Write the failing tests**

In `live-session.run.test.ts`: an `entry_appended` after a `message_end` publishes `{kind: "entry"}` with the id and moves `leafId()`; a compaction entry publishes `{kind: "row"}` with the summary; no raw `entry_appended` reaches `published`; a `ready` whose `leafId` is 129 characters leaves `leafId()` null. In `run-view.test.ts`: `bind` gives the id to the newest unbound matching row only. In `service.snapshot.test.ts`: during a run, the snapshot reads the file up to the run's baseline from `leafAtStart`, then the run's rows with the ids bound so far; a trimmed snapshot points `history.oldestEntryId` at its oldest kept row.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Track the leaf and bind entry ids in the live session**

`run-view.ts`: `RunViewState { baselineBytes; leafAtStart: string | null; rows: TranscriptRow[] }`; `begin(baselineBytes, leafAtStart)`; `push(message)` stores `{ entryId: null, message }` (bounded as before); new `bind(entry: EntryRef): void` gives `entry.id` to the newest unbound row whose message matches (`toolCallId` equal for a tool result, else same `role` and `timestamp === entry.messageTimestamp`); new `add(row: TranscriptRow)` for summary rows.

`live-session.ts`:

```ts
  let leafId: string | null = null;
  // in the ready handler: an id the client contract cannot carry counts as unknown (M2R4, M2-RT-06).
  //   leafId = record.leafId !== null && record.leafId.length <= 128 ? record.leafId : null;

  function onEntry(raw: unknown): void {
    const entry = slimEntryRef(raw); // validates with EntryRef (ids ≤ 128), null when malformed or too long
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


- [ ] **Step 4: Write the shared integration bed and the integration test**

`apps/daemon/src/modules/sessions/testing/int-bed.ts` (a helper may import the module only through `../index.ts`):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PERMISSIONS, type EventFrame, type HandlerContext, type SessionStreamEvent } from "@pap/contracts";
import type { WorkerExit } from "../../../kernel/supervisor/exit.ts";
import { vi } from "vitest";
import { createSystemClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { NO_SCOPES, type WorkerScopes } from "../../../kernel/supervisor/scope.ts";
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
  /** Real scopes for the tests that need them (Task 22); every other test runs workers unscoped (owner R2-3). */
  readonly scopes?: WorkerScopes;
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
  const exits: Array<{ sessionId: string; exit: WorkerExit; outputTail: string }> = [];
  const sessions: SessionsModule = createSessionsModule({
    db,
    clock,
    logger: silentLogger,
    hub,
    config: { home: papHome, piAgentDir: agentDir, piHostEntry: join(REPO, "packages/pi-host/src/main.ts"), piHostExecArgv: EXEC_ARGV, testProviderScript: join(root, "script.json"), maxWorkers: options.maxWorkers ?? 4, minFreeMemMb: 0 },
    workerUmask: 0o022,
    env: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
    scopes: options.scopes ?? NO_SCOPES,
    onWorkerExit: (sessionId, info) => void exits.push({ sessionId, ...info }),
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
    exits,
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
      const blocked = exits.flatMap((exit) => exit.outputTail.split("\n")).filter((line) => line.startsWith("pap-network-guard: blocked"));
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

(Task 20 adds `workerIdleMs` to the module's `Pick<Config, …>` and then to this bed, with an option of the same name: an object literal with a field its type lacks would not compile before that.)

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

- [ ] **Step 5: Bind entry ids in the web reducer**

`row-view.ts`: roles `compactionSummary` (text = `summary`, plus `tokensBefore`), `branchSummary` (text = `summary`), `custom` (text from `content`); `toMessageView` returns `null` for a custom message with `display === false`. `session-reducer.ts`: the snapshot keeps `history`, `leafId`; `case "entry"` binds `event.entry.id` to the newest message without an `entryId` that matches (same `toolCallId` for a tool result, else same role and `timestamp === entry.messageTimestamp`) and sets `leafId`; `case "row"` appends the row unless a message with that `entryId` is already there. Tests in `session-reducer.test.ts` pin both. `transcript.vm.ts` maps the summary roles to the `tool` author with their text (Task 25 gives them cards).

- [ ] **Step 6: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): leaf tracking, entry and row events, shared integration bed"
```

---

### Task 11: Reads — history paging, tool output on demand, fork points

References: spec C §4.3 ("Older history is paged with `sessions.history{before}`", "fetched with `sessions.toolOutput`"); T3 Code `ThreadStream.ts` (bounded pages, tool bodies off the wire); pi-web `ChatWindow` (older history paged with `before`, the minimap's `turnsBefore`) and `BranchNavigator`.

**Rulings (pre-dispatch):**
- **M2R54** [11] Budgets: a history page ≤ 900 000 JSON bytes (oldest rows of the page left out first, cursor moved accordingly), tool output text ≤ 800 000 bytes once JSON-encoded, arguments ≤ 64 KiB; `clipJsonText` searches only up to `min(text.length, max)` characters (M2-RT-29) — under the 1 MiB frame, measured in JSON bytes everywhere — cost if wrong: a frame overrun, or 26 synchronous 64 MB stringifies for one large result.
- **M2R55** [11, 25, 28b] A page the client asked for is applied only to the view it was asked for: every snapshot increments `SessionView.generation`, and `prependHistory` drops a page when the generation or `history.oldestEntryId` it was asked with changed meanwhile (M2-RT-12); Task 28b guards `sessions.branches` refreshes the same way — stale responses are dropped — cost if wrong: rows of an abandoned branch prepended above the new one.
- **M2R56** [11] The Pi file writers of the tests move out of `testing/service-bed.ts` (276 lines) into `testing/pi-file-writers.ts`: `sessionFileText` and the new `writeToolSession`, `writeForkedSession` (M2-RT-19) — the 400-line rule — cost if wrong: a red lint mid-task.

**Files:**
- Modify: `packages/contracts/src/{streams,methods}.ts`, `methods.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{service-reads,rpc,service}.ts`, `snapshot.ts` (`fitPage`), `rpc.test.ts`, `testing/service-bed.ts` (re-exports `sessionFileText` from the new file so its importers do not change)
- Create: `apps/daemon/src/modules/sessions/service.reads.test.ts`, `sessions.reads.int.test.ts`, `testing/pi-file-writers.ts`
- Modify: `apps/web/src/stores/{session-store,session-reducer}.ts`, `session-reducer.test.ts`; Create: `apps/web/src/stores/history.ts`, `history.test.ts`

**Interfaces:**
- Consumes: Task 10a `TranscriptReader.page/forks/toolCall`, Task 10b `withTrimmedHistory`, Task 7 `ensureReader()`.
- Produces:
  - Contracts: `ForkChoice`, `ForkPoint` schemas (mirroring `branch.ts`); methods
    - `sessions.history { sessionId, before: string(1..128), limit?: 1..100 (default 50) } → { rows: TranscriptRow[]; hasMore; oldestEntryId: string|null; turnsBefore }`, `sessions:read`, idempotent, errors `not_found`;
    - `sessions.toolOutput { sessionId, toolCallId: string(1..256) } → { text: string; truncated: boolean; isError: boolean; args: string | null }`, `sessions:read`, idempotent, errors `not_found`;
    - `sessions.branches { sessionId } → { leafId: string|null; points: ForkPoint[] }`, `sessions:read`, idempotent, errors `not_found`.
  - Bounds: a history page ≤ 900 000 bytes (oldest rows of the page left out first, cursor moved accordingly); tool output text ≤ 800 000 bytes once JSON-encoded, args ≤ 64 KiB.
  - Web: `SessionView.generation: number` (every snapshot increments it); `useSessionStore.getState().prependHistory(sessionId, page, asked)`; `prependHistory(view, page, asked: { generation: number; oldestEntryId: string | null }): SessionView` (rows deduplicated by entry id, `history` replaced; the view unchanged when `asked` is stale).

- [ ] **Step 1: Write the failing tests**

`service.reads.test.ts` (service bed; writes real Pi files with `sessionFileText`):

```ts
it("pages older rows from a cursor, newest last, and says when the start is reached", async () => {
  open();
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
});

it("gives a tool's whole output and its arguments, bounded, and not_found for an unknown call", async () => {
  // A file with one read call whose result is 1 MB of text.
  open();
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  writeToolSession(bed.files[0] ?? "", "c1", "x".repeat(1_000_000));
  bed.emit(0, { type: "agent_settled", aborted: false });
  const output = await bed.service.toolOutput({ sessionId, toolCallId: "c1" }, OWNER);
  expect(output.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(output.text))).toBeLessThanOrEqual(800_000);
  expect(output.args).toBe(JSON.stringify({ path: "big.txt" }));
  await expect(bed.service.toolOutput({ sessionId, toolCallId: "nope" }, OWNER)).rejects.toThrow(PapError);
});

it("lists the fork points of the active branch", async () => {
  open();
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  writeForkedSession(bed.files[0] ?? ""); // a0 has two user children u1 (older) and u2 (on the leaf's path)
  bed.emit(0, { type: "agent_settled", aborted: false });
  const { points } = await bed.service.branches(sessionId, OWNER);
  expect(points).toHaveLength(1);
  expect(points[0]?.choices.map((choice) => [choice.entryId, choice.onPath])).toEqual([["u1", false], ["u2", true]]);
});
```

(`writeToolSession(file, toolCallId, output)` and `writeForkedSession(file)` go into `testing/pi-file-writers.ts` with `sessionFileText`, each writing a format-3 file with the entries the test names.)

`apps/web/src/stores/history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prependHistory } from "./history.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const row = (entryId: string, content: string) => ({ entryId, message: { role: "user", content, timestamp: Number(entryId.slice(1)) } });

const snapshotOf = (rows: ReturnType<typeof row>[], oldestEntryId: string) => ({ kind: "snapshot", status: "idle", rows, dialogs: [], partial: null, queue: { steering: [], followUp: [], count: 0, bytes: 0 }, statuses: [], widgets: [], title: null, panels: [], notices: [], decorationsTruncated: false, history: { hasMore: true, oldestEntryId, turnsBefore: 2 }, activity: { compacting: false, retry: null }, leafId: "e4", name: null });
const older = { rows: [row("e1", "a"), row("e2", "b"), row("e3", "c")], hasMore: false, oldestEntryId: "e1", turnsBefore: 0 };

describe("prependHistory", () => {
  it("puts an older page before the rows, once, and moves the cursor", () => {
    const view = reduceSession(EMPTY_VIEW, snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const next = prependHistory(view, older, { generation: view.generation, oldestEntryId: "e3" });
    expect(next.messages.map((message) => message.entryId)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(next.history).toEqual({ hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
  });

  it("drops a page asked for a view that a snapshot replaced meanwhile (M2-RT-12)", () => {
    const first = reduceSession(EMPTY_VIEW, snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const asked = { generation: first.generation, oldestEntryId: "e3" };
    // "Edit from here" or the branch switcher: a new snapshot of another branch arrives before the page.
    const replaced = reduceSession(first, snapshotOf([row("e3", "c"), row("e9", "other branch")], "e3"));
    expect(prependHistory(replaced, older, asked)).toBe(replaced);
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

/**
 * The longest prefix of `text` whose JSON encoding fits in `max` bytes (escapes can make a character six bytes). A
 * character is at least one byte, so no prefix longer than `max` characters can fit: the search starts there, and a
 * 64 MB tool result costs a few stringifies of at most `max` characters (M2-RT-29).
 */
export function clipJsonText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max && Buffer.byteLength(JSON.stringify(text)) <= max) return { text, truncated: false };
  let low = 0;
  let high = Math.min(text.length, max);
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

/**
 * An older page goes before what the view has; a row already there (same entry id) is not added twice. A page asked
 * for another view (a snapshot replaced it meanwhile, or another page moved the cursor) is dropped (M2-RT-12).
 */
export function prependHistory(
  view: SessionView,
  page: HistoryMeta & { rows: readonly TranscriptRow[] },
  asked: { readonly generation: number; readonly oldestEntryId: string | null },
): SessionView {
  if (asked.generation !== view.generation || asked.oldestEntryId !== view.history.oldestEntryId) return view;
  const known = new Set(view.messages.flatMap((message) => (message.entryId ? [message.entryId] : [])));
  const older = page.rows.filter((row) => row.entryId === null || !known.has(row.entryId));
  const messages = [...older, ...view.messages.map((message) => message)].reduce<SessionView["messages"][number][]>((list, item) => {
    const message = "message" in item ? toMessageView(item.message, item.entryId) : item;
    return message ? [...list, withUniqueKey(list, message)] : list;
  }, []);
  return { ...view, messages, history: { hasMore: page.hasMore, oldestEntryId: page.oldestEntryId, turnsBefore: page.turnsBefore } };
}
```

and `session-store.ts` gains `prependHistory(sessionId, page, asked)` applying it. `session-reducer.ts`: `SessionView.generation` (0 in `EMPTY_VIEW`) becomes `view.generation + 1` in the snapshot branch; a reducer test pins the increment.

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

**Rulings (pre-dispatch):**
- **M2R57** [12] The cap counts prompts in flight plus Pi's own queue, so a burst can be refused slightly early, never late — a cap that is never late — cost if wrong: a rare spurious `queue_full`.
- **M2R58** [12, 24] The composer always sends the user's streaming preference; Pi ignores it when idle (pinned by the last integration case) — one send path — cost if wrong: none.
- **M2R59** [12, 20] `sessions.clearQueue` lists `timeout` among its errors (outcome unknown, R105, M2-RT-08); a cold session answers empty lists without a worker, and so does a releasing one from Task 20 (M2-RT-39) — a closing worker drops requests — cost if wrong: Stop showing an error while a worker is released.

**Files:**
- Create: `apps/daemon/src/modules/sessions/queue-guard.ts`, `queue-guard.test.ts`, `sessions.queue.int.test.ts`
- Modify: `packages/contracts/src/methods.ts` (`sessions.prompt` errors + `queue_full`; `sessions.clearQueue`), `apps/daemon/src/modules/sessions/{live-session,live-run,service,service-reads,rpc}.ts`, `live-session.run.test.ts`
- Modify: `apps/web/src/stores/session-reducer.ts`, `session-reducer.test.ts`

**Interfaces:**
- Consumes: Task 2 `clear_queue` and slim `queue_update`, Task 8 `promptsInFlight`.
- Produces:
  - `createQueueGuard(): QueueGuard { admit(text): () => void /* throws PapError("queue_full") */; onQueueUpdate(update: { steering: string[]; followUp: string[]; count: number; bytes: number }): QueueView; view(): QueueView; reset(): void }`, `MAX_QUEUED_MESSAGES = 128`, `MAX_QUEUED_BYTES = 32 * 1024 * 1024`.
  - Stream: `{kind: "queue", queue}` from every `queue_update` (the raw event is not forwarded); snapshot `queue`.
  - `LiveSession.clearQueue(): Promise<{ steering: string[]; followUp: string[]; truncated: boolean }>`; method `sessions.clearQueue { sessionId } → same`, `sessions:operate`, mutation, errors `not_found`, `worker_failed`, `timeout`. A cold session answers empty lists.
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

In `live-session.run.test.ts`:

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

(The last case pins what the composer relies on in Task 24: it always sends the user's streaming preference. Task 13b changes the first two cases to answer the approval with `{ answer: "once" }`.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores
git commit -m "feat(sessions): steering queue events, the 128 / 32 MiB cap and clearQueue"
```

---

### Task 13a: Approval channel, daemon side — the policy's own question reaches the client (R90 part, pulled forward)

Until now the policy asked through `ctx.ui.confirm`, so any extension's confirm looked like an approval card and the policy's question looked like any extension's. M2 gives the policy a channel of its own (`approval_request` / `approval_response`, defined in Task 1a and recorded in ADR 0008): the extension API cannot raise a policy card (in-process code could, R101's residual), and the card can carry the policy's answers. This half lands the daemon and web side first, tested with fake workers, so that Task 13b can switch pi-host over without a red gate in between (an `approval_request` the daemon did not handle would hang every approval). It carries "once" and "deny"; Task 14b adds "session" and "always".

**Rulings (pre-dispatch):**
- **M2R60** [13a, 13b] R90's policy-origin channel and "closed → `FAIL_CLOSED_REASON`" are pulled forward from M5 (owner M2-Q14) — four answers need the policy's own record — cost if wrong: none (accepted).
- **M2R61** [13a] Response mapping for an approval: `{answer}` must be one the dialog offers, else `bad_request` with the dialog left open (the check runs before anything is taken); `{confirmed: true}` → once, `{confirmed: false}` and `{cancelled: true}` → deny; `{value}` → `bad_request`; `{answer}` on any other dialog → `bad_request` — M1 clients and the smoke keep working while 13b lands — cost if wrong: none.
- **M2R62** [13a] An approval is never cut (R86): one over the dialog limits is cancelled and answered `{ answer: "deny", cancelled: true }`, which the policy treats as a closed question (fail closed, audit `dialog closed`, M2R6, M2-RT-22), with the rate-limited notice — the model must not hear "denied by the user" — cost if wrong: a model told a person refused.
- **M2R63** [13a, 26] Until Task 26 an approval renders with M1's `ApprovalCard` (Allow once → `{answer: "once"}`, Deny → `{answer: "deny"}`) and an extension `confirm` keeps `{confirmed}` — the branch stays usable between tasks — cost if wrong: none.

**Files:**
- Modify: `apps/daemon/src/modules/sessions/{dialogs,live-ui}.ts`, `dialogs.test.ts`, `packages/contracts/src/methods.ts` (`respondDialog` errors + `bad_request`)
- Create: `apps/daemon/src/modules/sessions/live-session.ui.test.ts` (the dialog and approval cases of the live session from here on, M2-RT-19; it opens with `const setup = createLiveBed(startLiveSession)`)
- Modify: `apps/web/src/features/sessions/SessionScreen.tsx`; Create: `apps/web/src/features/sessions/SessionScreen.dialogs.test.tsx` (`SessionScreen.test.tsx` is at 368 lines; the new file copies its `getRuntime` / router mocks and `show` / `emit` helpers)

**Interfaces:**
- Consumes: Task 1a records, Task 7 `live-ui.ts`.
- Produces:
  - `DialogRegistry.offerApproval(record: ApprovalRequestRecord): DialogVerdict` (`Dialog.method = "approval"`, `category`, `answers`); the registry keeps `{tool, key, label}` beside it: `peek(id): Dialog | null` (looks without taking), `takeEntry(id): { dialog; grant: Grant | null } | null`, `Grant = { tool; key; label }`, `label` = the message cut to 4096 characters.
  - `LiveSession.answer(id, response): { answer: ApprovalAnswer; grant: Grant } | null` — the approval answer, for Task 14b (M2R39).
  - Web: an approval dialog renders `ApprovalCard` (Allow once → `{answer: "once"}`, Deny → `{answer: "deny"}`).

- [ ] **Step 1: Write the failing tests**

In `dialogs.test.ts`:

```ts
const approval = (id: string, fields: Record<string, unknown> = {}) => ({ type: "approval_request" as const, id, category: "exec" as const, title: "Run a command?", message: "1 line\nbash: ls", answers: ["deny", "once"] as ("deny" | "once")[], tool: "bash", key: "c".repeat(64), ...fields });

it("opens an approval as its own kind of dialog and keeps the grant beside it", () => {
  const dialogs = createDialogRegistry();
  expect(dialogs.offerApproval(approval("a1"))).toEqual({ kind: "opened", dialog: { id: "a1", method: "approval", title: "Run a command?", message: "1 line\nbash: ls", category: "exec", answers: ["deny", "once"] } });
  expect(dialogs.peek("a1")?.method).toBe("approval");
  expect(dialogs.takeEntry("a1")?.grant).toEqual({ tool: "bash", key: "c".repeat(64), label: "1 line\nbash: ls" });
  expect(dialogs.peek("a1")).toBeNull();
});

it("never cuts an approval's message: one over the limit is cancelled", () => {
  expect(createDialogRegistry().offerApproval(approval("a1", { message: "x".repeat(65_537) })).kind).toBe("cancel");
});
```

`live-session.ui.test.ts`:

```ts
const ask = (id: string, key: string, message = "bash: ls") => ({ type: "approval_request" as const, id, category: "exec" as const, title: "Run?", message, answers: ["deny", "once"] as Array<"deny" | "once">, tool: "bash", key });

it("answers an approval with the policy's record, mapping the M1 answers", async () => {
  const { live, worker, clock } = setup();
  worker.emit(ask("a1", "c".repeat(64)));
  worker.emit(ask("a2", "d".repeat(64), "bash: pwd"));
  await clock.advance(0);
  live.answer("a1", { confirmed: true });
  expect(() => live.answer("a2", { answer: "always" })).toThrow(new PapError("bad_request"));
  live.answer("a2", { answer: "deny" });
  expect(worker.sent.filter((record) => record.type === "approval_response")).toEqual([
    { type: "approval_response", id: "a1", answer: "once" },
    { type: "approval_response", id: "a2", answer: "deny" },
  ]);
});

it("answers an approval it cannot show as cancelled, never as the user's refusal (M2-RT-22)", async () => {
  const { worker, clock, published } = setup();
  // 64 open dialogs is the registry's limit (spec C §2.4): the 65th question, an approval, cannot be shown.
  for (let i = 0; i < 64; i++) worker.emit({ ...confirm, id: `d${i}` });
  worker.emit(ask("a1", "c".repeat(64)));
  await clock.advance(0);
  expect(worker.sent.filter((record) => record.type === "approval_response")).toEqual([{ type: "approval_response", id: "a1", answer: "deny", cancelled: true }]);
  expect(published.filter((event) => event.kind === "dialog_open" && event.dialog.id === "a1")).toEqual([]);
});

it("refuses an approval answer for an extension's confirm", async () => {
  const { live, worker, clock } = setup();
  worker.emit(confirm);
  await clock.advance(0);
  expect(() => live.answer(confirm.id, { answer: "once" })).toThrow(new PapError("bad_request"));
  expect(live.dialogs()).toHaveLength(1);
});
```

(`live.answer("a2", { answer: "always" })` throws before taking the dialog, so the second, valid answer still finds it.)

`SessionScreen.dialogs.test.tsx`: an `approval` dialog with `answers: ["deny", "once"]` renders an `ApprovalCard`; "Allow once" calls `sessions.respondDialog` with `{ answer: "once" }` and "Deny" with `{ answer: "deny" }`; an extension `confirm` still answers `{ confirmed: true }`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement the daemon and web side**

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

`live-ui.ts`: the `approval_request` record goes to `offerApproval`; a cancel verdict sends `{ type: "approval_response", id, answer: "deny", cancelled: true }` (the policy fails closed, M2R62) and the rate-limited notice; `answer(dialogId, response)`:

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

`methods.ts`: `sessions.respondDialog` errors gain `bad_request`. `SessionScreen.tsx`: `dialog.method === "approval"` renders `ApprovalCard` with `onAnswer={(approved) => answer(dialog.id, { answer: approved ? "once" : "deny" })}`; `confirm` keeps `{ confirmed }`.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS (no worker sends `approval_request` yet: the integration tests still see M1's confirm path).

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src/features/sessions
git commit -m "feat(sessions): approval dialogs of their own, answered once or denied"
```

---

### Task 13b: Approval channel, pi-host side — pap-policy asks on its own record

**Rulings (pre-dispatch):**
- **M2R64** [13b] `{confirmed}` stays accepted for approvals (13a), so this task switches the integration tests and the smoke to `{ answer: "once" }` with no red step in between — the mapping of 13a makes the switch atomic per test — cost if wrong: none.
- **M2R65** [13b, 14b] Grant key = sha256 of `JSON.stringify([tool, kind, payload])`, `kind` ∈ {`cmd` (the exact command of a built-in shell call), `json` (canonical JSON of the input, keys sorted, `undefined` left out)} (M2-RT-24): the JSON array separates the three parts by construction, so a bash command string can never equal another tool's JSON payload, and a tool name holding a separator cannot forge one — domain separation by encoding, not by a separator a name could contain — cost if wrong: one grant covering two different calls.
- **M2R66** [13b] A question that comes back closed (Stop, shutdown, a request that could not leave) or `cancelled` by the daemon blocks with `FAIL_CLOSED_REASON` and audits `dialog closed`; an answer the card did not offer is a refusal; approved calls audit `answer: <answer>` (plus the review's reason for an edit) — fail closed, and the audit says what was chosen — cost if wrong: none.
- **M2R67** [13b] The policy tests use the existing `createPolicyBed().harness(options)` (`asked`, `audits`, `run`), whose `confirm` option becomes `ask` and which also records `asks` (the full requests); the new approval-channel cases go to a new `policy/extension.grants.test.ts` because `extension.test.ts` is at 387 lines (M2-RT-19); existing tests of M1's confirm path change with it (the Stop case now expects `FAIL_CLOSED_REASON` and `dialog closed`) — tests written against the real bed — cost if wrong: a fix round.

**Files:**
- Create: `packages/pi-host/src/approvals.ts`, `approvals.test.ts`, `packages/pi-host/src/policy/grant-key.ts`, `grant-key.test.ts`, `packages/pi-host/src/policy/extension.grants.test.ts`, `packages/pi-host/src/host.approvals.int.test.ts`
- Modify: `packages/pi-host/src/policy/extension.ts`, `extension.test.ts` and `extension-edits.test.ts` (the `confirm` option becomes `ask`; approved audits carry their reason), `packages/pi-host/src/{open-session,host,dispatch}.ts`, `testing/policy-bed.ts`, `testing/host-bed.ts` (`isApproval`), `host.probes.int.test.ts`, `host.commands.int.test.ts` (the parked-queue case)
- Modify: `scripts/smoke-dist.ts` (`{ answer: "once" }`), `apps/daemon/src/modules/sessions/{sessions.queue.int.test,sessions.int.test}.ts` (approvals answered `{ answer: "once" }`)

**Interfaces:**
- Consumes: Task 1a records, Task 4 `send(): boolean`, Task 13a daemon side.
- Produces:
  - `createApprovals(send, { newId }): Approvals { ask(request: ApprovalAsk, signal?): Promise<{ answer: ApprovalAnswer; closed: boolean }>; resolve(record: { id; answer; cancelled? }): void; cancelAll(): void; pendingCount(): number }` with `ApprovalAsk { category; title; message; tool; key; answers }`.
  - `grantPayload(input, exec): GrantPayload` (`{ kind: "cmd", payload: command }` for a built-in shell call, else `{ kind: "json", payload: canonical JSON }`); `grantKey(tool, payload: GrantPayload): string` (sha256 hex of `JSON.stringify([tool, kind, payload])`).
  - `PolicyConfig.ask` replaces `ctx.ui.confirm`; `answersFor(category, review)` (this task: `["deny", "once"]`); a closed or cancelled question blocks with `FAIL_CLOSED_REASON` and audit reason `dialog closed`.

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

  it("closes at once a question the daemon would refuse, and never sends it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const approvals = createApprovals((record) => { sent.push(record); return true; }, { newId: () => "a1" });
    expect(await approvals.ask({ ...request, title: "t".repeat(4097), answers: ["deny", "once"] })).toEqual({ answer: "deny", closed: true });
    expect(sent).toEqual([]);
    expect(approvals.pendingCount()).toBe(0);
  });

  it("treats a question the daemon answered cancelled as closed, never as a refusal (M2-RT-22)", async () => {
    const approvals = createApprovals(() => true, { newId: () => "a1" });
    const answer = approvals.ask({ ...request, answers: ["deny", "once"] });
    approvals.resolve({ id: "a1", answer: "deny", cancelled: true });
    expect(await answer).toEqual({ answer: "deny", closed: true });
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
    expect(grantKey("bash", grantPayload({ command: "ls -la\u200b" }, true))).not.toBe(ls);
    expect(grantKey("other", grantPayload({ command: "ls -la" }, true))).not.toBe(ls);
  });

  it("ignore the order of object keys for other tools", () => {
    expect(grantKey("fetch", grantPayload({ url: "https://a", method: "GET" }, false))).toBe(grantKey("fetch", grantPayload({ method: "GET", url: "https://a" }, false)));
  });

  it("never let a command string stand for a JSON payload, nor a tool name swallow a separator (M2-RT-24)", () => {
    const asCommand = grantKey("t", { kind: "cmd", payload: '{"a":1}' });
    expect(grantKey("t", grantPayload({ a: 1 }, false))).not.toBe(asCommand);
    expect(grantKey("t\u0000cmd", { kind: "json", payload: "x" })).not.toBe(grantKey("t", { kind: "cmd", payload: "x" }));
  });
});
```

`policy/extension.grants.test.ts` (the bed's harness now takes `answers`, a scripted list of outcomes, default once):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyBed } from "../testing/policy-bed.ts";
import { DENIED_REASON, FAIL_CLOSED_REASON } from "./extension.ts";

let bed: Awaited<ReturnType<typeof createPolicyBed>>;
beforeEach(async () => {
  bed = await createPolicyBed();
});
afterEach(async () => {
  await bed.dispose();
});

describe("pap-policy approval channel", () => {
  it("asks the policy's own question and runs on once", async () => {
    const h = bed.harness();
    expect(await h.run("bash", { command: "ls" })).toBeUndefined();
    expect(h.asks).toEqual([expect.objectContaining({ category: "exec", tool: "bash", answers: ["deny", "once"], key: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(h.audits.at(-1)).toMatchObject({ decision: "approved", reason: "answer: once" });
  });

  it("blocks with the deny reason on deny, and fails closed when the question is closed or cancelled (M2-RT-22)", async () => {
    expect(await bed.harness({ answers: [{ answer: "deny", closed: false }] }).run("bash", { command: "ls" })).toEqual({ block: true, reason: DENIED_REASON });
    const closed = bed.harness({ answers: [{ answer: "deny", closed: true }] });
    expect(await closed.run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(closed.audits.at(-1)).toMatchObject({ decision: "denied", reason: "dialog closed" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host`
Expected: FAIL.

- [ ] **Step 3: Implement the pi-host side**

`packages/pi-host/src/approvals.ts`:

```ts
import { randomUUID } from "node:crypto";
import { type ApprovalAnswer, ApprovalRequestRecord, type ToolCategory } from "@pap/contracts";

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
  /** `cancelled`: the daemon could not show the question; it closes like Stop, never as the user's refusal (M2-RT-22). */
  resolve(record: { id: string; answer: ApprovalAnswer; cancelled?: true | undefined }): void;
  cancelAll(): void;
  pendingCount(): number;
}

const CLOSED: ApprovalOutcome = { answer: "deny", closed: true };

/**
 * The policy's questions. Only pap-policy holds this object: the extension API can only reach `ctx.ui`. Code running
 * inside the worker could still send the record itself (R101's residual, ADR 0008).
 */
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
        const record = { type: "approval_request" as const, id, ...request, answers: [...request.answers] };
        // A question the daemon's schema would refuse is dropped there, and the call would wait for ever: closed now.
        if (!ApprovalRequestRecord.safeParse(record).success || !send(record)) pending.get(id)?.settle(CLOSED);
      });
    },
    resolve(record) {
      const entry = pending.get(record.id);
      if (!entry) return;
      if (record.cancelled) entry.settle(CLOSED);
      else entry.settle({ answer: entry.offered.includes(record.answer) ? record.answer : "deny", closed: false });
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

/** What a grant covers: the exact command of a built-in shell call (`cmd`), else the exact input, keys sorted (`json`). */
export interface GrantPayload {
  readonly kind: "cmd" | "json";
  readonly payload: string;
}

export function grantPayload(input: unknown, exec: boolean): GrantPayload {
  const command = (input as { command?: unknown } | null)?.command;
  return exec && typeof command === "string" ? { kind: "cmd", payload: command } : { kind: "json", payload: canonical(input ?? {}) };
}

/**
 * sha256 of the tool name, the payload's kind and the exact payload: the only thing a "session" or "always" grant
 * matches. The three parts are encoded as one JSON array, so none can run into another (M2-RT-24).
 */
export function grantKey(tool: string, payload: GrantPayload): string {
  return createHash("sha256").update(JSON.stringify([tool, payload.kind, payload.payload])).digest("hex");
}
```

`policy/extension.ts`: `PolicyContext` loses `ui`; `PolicyConfig` gains `ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>`; and:

```ts
/** The answers a card offers, in DESIGN.md order (Deny / Session / Always / Allow once). Task 14b widens this. */
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
    record("approved", review ? `answer: ${outcome.answer}; ${review.why}` : `answer: ${outcome.answer}`);
    return undefined;
```

`testing/policy-bed.ts`: the harness drops the fake `ui.confirm` and passes `ask` in the deps: `HarnessOptions.confirm` becomes `ask?: (request: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalOutcome>` and gains `answers?: ApprovalOutcome[]` (taken in order, then once); `asked` keeps recording `${title}|${message}` (so the existing assertions stay), and `asks` records the requests. In `extension.test.ts` and `extension-edits.test.ts`, `confirm: async () => false` becomes `ask: async () => ({ answer: "deny", closed: false })`; approved audits gain `reason: "answer: once"` (an edit outside the directory: `"answer: once; outside the session directory"`); the Stop case expects `FAIL_CLOSED_REASON` and audit reason `dialog closed` (a closed question is no longer the user's refusal); "closes the real bridge dialog" drives `createApprovals` and expects `{ type: "extension_ui_closed", id }`; the factory harness passes `ask` in the config instead of `ctx.ui`.

`open-session.ts`: `OpenSessionDeps` gains `readonly approvals: Approvals`, passed as `ask: (request, signal) => deps.approvals.ask(request, signal)` to `createPapPolicyExtension`. `host.ts` creates `const approvals = createApprovals((record) => ipc.send(record))`, calls `approvals.cancelAll()` next to `ui.cancelAll()` in `shutdown`, and passes it to `openSession` and `createDispatch`; `dispatch.ts` gains `case "approval_response": deps.approvals.resolve(record); return;`. `testing/host-bed.ts` gets `isApproval = (record) => record.type === "approval_request"`; the host integration tests that waited for a confirm wait for an approval and answer `{ type: "approval_response", id, answer: "once" | "deny" }`.

- [ ] **Step 4: Write the integration test and switch the callers**

`packages/pi-host/src/host.approvals.int.test.ts` (the bed set-up of `host.int.test.ts`):

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

it("blocks the call when the daemon answers that it could not show the card", async () => {
  await bed.start(bashScript("echo never"));
  const host = bed.host();
  host.send({ type: "prompt", id: "p1", message: "go" });
  const ask = await host.waitFor(isApproval);
  host.send({ type: "approval_response", id: ask.id, answer: "deny", cancelled: true });
  const end = await host.waitFor((r) => r.type === "tool_execution_end");
  expect(end.isError).toBe(true);
  expect(JSON.stringify(end)).not.toContain("never\n");
});
```

`scripts/smoke-dist.ts` answers `{ answer: "once" }`; `sessions.queue.int.test.ts` and `sessions.int.test.ts` answer approvals with `{ answer: "once" }`; `host.commands.int.test.ts`'s parked-queue case waits for `approval_request` and answers `approval_response{answer:"deny"}`.

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke`
Expected: PASS (the smoke approves through the new channel).

```bash
git add packages/pi-host/src apps/daemon/src/modules/sessions scripts/smoke-dist.ts
git commit -m "feat(policy): approvals on a channel of their own, closed questions fail closed"
```

---

### Task 14a: The `policy` module — "always" rules per project (spec C §3.2, §5.3)

"Always" grants are rows of a new `policy` daemon module's `approval_rules` table (spec C §3.2 lists the table), scoped per project — the git root of the session's folder, the folder itself outside git (owner R2-5). This half builds the module on its own (store, service, RPC methods, composition); Task 14b wires it to the sessions and to pap-policy. Settings › Approvals (revocation UI) is M5; M2 ships `policy.listRules` / `policy.revokeRule` and the minimal list of Task 28b. Taint ("ask even when an always rule exists") is M5.

**Rulings (pre-dispatch):**
- **M2R68** [14a, 14b] An "always" rule's scope is the project: the git root of the session's real cwd — the nearest folder, the cwd included, holding `.git` (a folder, or the file of a worktree or submodule), at most 64 levels up — else the real cwd (owner R2-5); one function, `projectScopeOf(cwd)`, exported by the policy module — a session in `repo/sub` sees the rules approved in `repo` — cost if wrong: a rule shared by unrelated folders of one repository (accepted: same project).
- **M2R69** [14a] At 1000 rules for one owner and project a new "always" answer is kept for the session only, with a notice; `addAlways` checks "exists" before "full" (M2-RT-24) — a bounded table, and re-answering Always on a rule that exists is not "full" — cost if wrong: a spurious "full" notice.
- **M2R70** [14a, 28b] `policy.listRules { cwd? }` lists the caller's rules of that cwd's project, newest first, 1000 at most (each `{ id, scope, tool, label, createdAt }`); `policy.revokeRule { ruleId }` removes one of the caller's (mutation with `commandId`, `not_found` otherwise) — revocation exists before M5's Settings (owner M2-Q2) — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/modules/policy/{index,store,service,rpc,project-scope}.ts`, `migrations/202610110100_policy.sql`, `store.test.ts`, `service.test.ts`, `rpc.test.ts`, `project-scope.test.ts`
- Modify: `packages/contracts/src/methods.ts`, `methods.test.ts`, `apps/daemon/src/daemon.ts` (migration source, module before sessions, handler table)

**Interfaces:**
- Consumes: Task 1a `AlwaysRule`, `MAX_ALWAYS_RULES`, the `policy` permission domain.
- Produces:
  - `createPolicyModule({ db, clock, logger, newId }): PolicyModule { rpc: Pick<HandlerTable, "policy.listRules" | "policy.revokeRule">; port: PolicyPort }`, `POLICY_MIGRATIONS`, `projectScopeOf(cwd): string`.
  - `PolicyPort { scopeOf(cwd): string; rulesFor(ownerId, scope): AlwaysRule[]; addAlways(input: { ownerId; scope; tool; key; label }): "added" | "exists" | "full"; onChange(listener: (ownerId: string, scope: string) => void): () => void }`.
  - Methods: `policy.listRules { cwd?: string(1..4096) } → { rules: Array<{ id; scope; tool; label; createdAt }> }` (`policy:read`, idempotent); `policy.revokeRule { ruleId: string(1..128) } → { ok: true }` (`policy:admin`, mutation, errors `not_found`).

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/modules/policy/service.test.ts` (real database through `migrate` with `KERNEL_MIGRATIONS` and `POLICY_MIGRATIONS` in a temp dir removed in `afterEach`, fake clock):

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
  // Full, but an existing rule is still "exists", never "full" (M2-RT-24).
  expect(service.addAlways(rule)).toBe("exists");
  expect(service.addAlways({ ...rule, key: "f".repeat(64) })).toBe("full");
});

it("revokes only its owner's rule and tells the listeners which project changed", () => {
  const { service } = setup();
  const changes: string[] = [];
  service.onChange((owner, scope) => void changes.push(`${owner}:${scope}`));
  service.addAlways({ ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" });
  const [listed] = service.list("u1");
  expect(listed).toMatchObject({ scope: "/w", tool: "bash", label: "l" });
  expect(() => service.revoke("u2", listed?.id ?? "")).toThrow(new PapError("not_found"));
  service.revoke("u1", listed?.id ?? "");
  expect(service.rulesFor("u1", "/w")).toEqual([]);
  expect(changes).toEqual(["u1:/w", "u1:/w"]);
});

it("keeps telling the other listeners when one throws", () => {
  const { service } = setup();
  const heard: string[] = [];
  service.onChange(() => {
    throw new Error("worker gone");
  });
  service.onChange((owner) => void heard.push(owner));
  service.addAlways({ ownerId: "u1", scope: "/w", tool: "bash", key: KEY, label: "l" });
  expect(heard).toEqual(["u1"]);
});
```

`project-scope.test.ts`:

```ts
it("is the git root of a folder inside a repository, the folder itself outside git (owner R2-5)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pap-scope-")));
  try {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "sub", "deep"), { recursive: true });
    mkdirSync(join(root, "worktree"), { recursive: true });
    writeFileSync(join(root, "worktree", ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(root, "plain"));
    symlinkSync(join(root, "repo", "sub"), join(root, "link"));
    expect(projectScopeOf(join(root, "repo", "sub", "deep"))).toBe(join(root, "repo"));
    expect(projectScopeOf(join(root, "repo"))).toBe(join(root, "repo"));
    expect(projectScopeOf(join(root, "worktree"))).toBe(join(root, "worktree"));
    expect(projectScopeOf(join(root, "link"))).toBe(join(root, "repo"));
    expect(projectScopeOf(join(root, "plain"))).toBe(join(root, "plain"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

`store.test.ts`: the unique key refuses a second identical rule; `exists` sees it; `forScope` orders by creation; `remove` of another owner's id removes nothing. `rpc.test.ts`: `policy.listRules` passes the caller's user id; `policy.revokeRule` maps `not_found`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/policy`
Expected: FAIL.

- [ ] **Step 3: Implement the `policy` module**

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
    exists: (ownerId: string, scope: string, tool: string, grantKey: string): boolean =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM approval_rules WHERE owner_id = $ownerId AND scope_kind = 'project' AND scope = $scope AND tool = $tool AND grant_key = $grantKey", { ownerId, scope, tool, grantKey })?.n === 1,
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
import { projectScopeOf } from "./project-scope.ts";
import type { PolicyStore, RuleRow } from "./store.ts";

export interface PolicyPort {
  /** The project a session's cwd belongs to: its git root, or the cwd outside git (owner R2-5). */
  scopeOf(cwd: string): string;
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
    scopeOf: projectScopeOf,
    addAlways(input: { ownerId: string; scope: string; tool: string; key: string; label: string }) {
      // Checks and insert run with no await between them: SQLite calls are synchronous here. "Exists" comes before
      // "full": answering Always again on a rule that is there is not a new rule (M2-RT-24).
      if (deps.store.exists(input.ownerId, input.scope, input.tool, input.key)) return "exists" as const;
      if (deps.store.count(input.ownerId, input.scope) >= MAX_ALWAYS_RULES) {
        deps.logger.warn("approval_rules_full", { max: MAX_ALWAYS_RULES });
        return "full" as const;
      }
      const row: RuleRow = { id: deps.newId(), ownerId: input.ownerId, scope: input.scope, tool: input.tool, grantKey: input.key, label: input.label.slice(0, 4096), createdAt: deps.clock.now() };
      if (!deps.store.insert(row)) return "exists" as const;
      changed(input.ownerId, input.scope);
      return "added" as const;
    },
    /** The caller's rules, newest first: all of them, or those of the project `cwd` belongs to. */
    list: (ownerId: string, cwd?: string) =>
      (cwd === undefined ? deps.store.forOwner(ownerId, MAX_ALWAYS_RULES) : deps.store.forScope(ownerId, projectScopeOf(cwd), MAX_ALWAYS_RULES).toReversed()).map((row) => ({
        id: row.id,
        scope: row.scope,
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

`rpc.ts` maps `policy.listRules` (`service.list(ctx.caller.userId, cwd)`) and `policy.revokeRule` one line each; `index.ts` exports `POLICY_MIGRATIONS`, `projectScopeOf` and `createPolicyModule` returning `{ rpc, port: { scopeOf, rulesFor, addAlways, onChange } }`. `daemon.ts` adds `POLICY_MIGRATIONS` to the migration sources, builds the module before sessions and merges `policy.rpc` into the handler table (Task 14b passes `policy: policy.port` to `createSessionsModule`).

`project-scope.ts`:

```ts
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_LEVELS = 64;

/**
 * The project an "always" rule belongs to (owner R2-5): the git root of `cwd` — the nearest folder, `cwd` included,
 * that holds `.git` (a folder, or a worktree's or submodule's file) — else `cwd` itself. Real paths, so a link and its
 * target are one project; a folder that cannot be resolved is its own project, never a wider one.
 */
export function projectScopeOf(cwd: string): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return cwd;
  }
  let dir = real;
  for (let level = 0; level < MAX_LEVELS; level++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return real;
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/daemon.int.test.ts`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/policy apps/daemon/src/daemon.ts
git commit -m "feat(policy): approval rules per project, listed and revoked"
```

---

### Task 14b: Session and always grants wired — pap-policy remembers, the daemon persists and pushes

"Session" grants live in the worker's policy (spec C: "held in worker memory"); "always" grants are the policy module's rules, compiled into `PolicyRules.alwaysAllow` at worker start and pushed with `policy_update` when they change. A grant matches one exact call: the tool name and the sha256 of its exact payload (Task 13b's `grantKey`). An "always" answer is never a session grant: between the answer and the daemon's push it is held as *provisional*, and every policy update ends it, so a revoke bites the worker that took the answer (M2-RT-01).

**Rulings (pre-dispatch):**
- **M2R71** [14b] Answers per question (owner M2-Q3): all four for exec, network and external-write (and any classified call that asks); no "always" for a tool pap cannot classify; only once / deny for an edit outside the project or to a protected path (`.git`, `.pi`, …) — grants only where the call is classified — cost if wrong: over-asking.
- **M2R72** [14b] Exact match only (owner M2-Q1): the tool name plus the sha256 of the exact payload; patterns wait for M5 — patterns need M5's Settings UI and a matching design — cost if wrong: prompt fatigue.
- **M2R73** [14b] An "always" answer is never written into the session grants (M2-RT-01): pi-host holds it in a provisional set tagged with the rules version, and any `policy_update` (valid, or malformed per M2R16) bumps the version and ends it; from then on only `rules().alwaysAllow` allows the call — revocation must bite live workers — cost if wrong: a revoked rule that keeps allowing until the worker exits.
- **M2R74** [14b] Session grants and provisional always grants are each capped at `MAX_SESSION_GRANTS = 1000` per worker, oldest dropped, with a test crossing the cap — bounded — cost if wrong: an old grant asked again.
- **M2R75** [14b] A rule added or revoked reaches every live and starting worker of that owner and project (a starting worker queues it before `ready`, ADR 0001); the session's row and project scope sit beside its `LiveSession` in a `WeakMap`, so nothing needs cleaning at exit (M2-RT-25) — no unbounded side map — cost if wrong: none.

**Files:**
- Modify: `packages/pi-host/src/policy/extension.ts`, `extension.grants.test.ts`, `packages/pi-host/src/testing/policy-bed.ts` (`rules`, `rulesVersion`), `packages/pi-host/src/{host,open-session}.ts` (the rules version)
- Modify: `apps/daemon/src/modules/sessions/{index,service,live-session}.ts`, `testing/{service-bed,int-bed}.ts`, `sessions.int.test.ts`, `index.test.ts` and every other `createSessionsModule` call (the `policy` port is required from this task on), `apps/daemon/src/daemon.ts` (`policy: policy.port`)
- Create: `apps/daemon/src/modules/sessions/service.grants.test.ts`, `testing/fake-policy.ts` (M2-RT-19: `service-bed.ts` and `service.test.ts` stay under 400), `sessions.grants.int.test.ts`

**Interfaces:**
- Consumes: Task 13b `answersFor`, `grantKey`; Task 13a `LiveSession.answer() → { answer, grant } | null`; Task 14a `PolicyPort`.
- Produces:
  - pi-host: `answersFor(category, review)` as in M2R71; `createPolicyGrants(rulesVersion, max?)` with `hasSession`, `rememberSession`, `hasProvisionalAlways`, `rememberAlways`; the policy skips the question when a session grant, `rules().alwaysAllow` or a current provisional always grant holds the key, for a call without `review`, auditing `allow` with reason `session rule` / `always rule`; `MAX_SESSION_GRANTS = 1000`; `PolicyConfig.rulesVersion()` (host bumps it on every `policy_update`).
  - Sessions: `SessionsModuleDeps.policy: PolicyPort`; every `init.policy` carries `alwaysAllow: policy.rulesFor(row.ownerId, policy.scopeOf(row.cwd))`; an "always" answer calls `addAlways` with the dialog's grant; `LiveSession.send(record): boolean`.

- [ ] **Step 1: Write the failing tests**

pi-host `extension.grants.test.ts` (the harness takes `rules` and `rulesVersion` too; `interactiveRules`, `grantKey`, `grantPayload`, `MAX_SESSION_GRANTS` imported):

```ts
it("asks once, then lets the identical call through for the rest of the worker's life on a session answer", async () => {
  const h = bed.harness({ answers: [{ answer: "session", closed: false }] });
  expect(await h.run("bash", { command: "npm test" })).toBeUndefined();
  expect(await h.run("bash", { command: "npm test" })).toBeUndefined();
  expect(h.asks).toHaveLength(1);
  expect(h.audits.at(-1)).toMatchObject({ decision: "allow", reason: "session rule" });
  await h.run("bash", { command: "npm test " });
  expect(h.asks).toHaveLength(2);
});

it("lets a call through on a project's always rule, matching the exact call only", async () => {
  const key = grantKey("bash", grantPayload({ command: "npm test" }, true));
  const h = bed.harness({ rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "bash", key }] }), answers: [{ answer: "deny", closed: false }] });
  expect(await h.run("bash", { command: "npm test" })).toBeUndefined();
  expect(h.audits.at(-1)).toMatchObject({ decision: "allow", reason: "always rule" });
  expect(await h.run("bash", { command: "npm  test" })).toEqual({ block: true, reason: DENIED_REASON });
  expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "session", "always", "once"]]);
});

it("never keeps an always answer past a policy update that dropped it (M2-RT-01)", async () => {
  let version = 0;
  const h = bed.harness({ answers: [{ answer: "always", closed: false }, { answer: "deny", closed: false }], rulesVersion: () => version });
  expect(await h.run("bash", { command: "rm -rf build" })).toBeUndefined();
  // Before the daemon's push: the provisional grant covers the same call.
  expect(await h.run("bash", { command: "rm -rf build" })).toBeUndefined();
  expect(h.asks).toHaveLength(1);
  // The daemon's push without the rule (it was revoked): the answer is gone, the call asks again.
  version++;
  expect(await h.run("bash", { command: "rm -rf build" })).toEqual({ block: true, reason: DENIED_REASON });
  expect(h.asks).toHaveLength(2);
});

it("never lets a grant cover a write outside the project or to a protected path", async () => {
  const input = { path: join(bed.cwd, ".git", "hooks", "pre-commit"), content: "x" };
  const key = grantKey("write", grantPayload(input, false));
  const h = bed.harness({ rules: () => ({ ...interactiveRules, alwaysAllow: [{ tool: "write", key }] }), answers: [{ answer: "once", closed: false }, { answer: "once", closed: false }] });
  await h.run("write", input);
  await h.run("write", input);
  expect(h.asks.map((ask) => ask.answers)).toEqual([["deny", "once"], ["deny", "once"]]);
});

it("offers no always answer for a tool it cannot classify", async () => {
  const h = bed.harness({ answers: [{ answer: "deny", closed: false }], isBuiltinTool: () => false });
  await h.run("mystery_tool", { x: 1 });
  expect(h.asks[0]?.answers).toEqual(["deny", "session", "once"]);
});

it("keeps at most MAX_SESSION_GRANTS session grants, dropping the oldest", async () => {
  const h = bed.harness({ answers: Array.from({ length: MAX_SESSION_GRANTS + 2 }, () => ({ answer: "session" as const, closed: false })) });
  for (let i = 0; i <= MAX_SESSION_GRANTS; i++) await h.run("bash", { command: `echo ${i}` });
  await h.run("bash", { command: "echo 0" });
  expect(h.asks).toHaveLength(MAX_SESSION_GRANTS + 2);
});
```

`apps/daemon/src/modules/sessions/service.grants.test.ts` (its own `open` / `afterEach` pair over `createServiceBed`, `fakePolicyPort` from `testing/fake-policy.ts`):

```ts
it("persists an always answer and pushes the project's rules to its other live workers only", async () => {
  const policy = fakePolicyPort();
  open({ policy });
  const first = await bed.service.create(bed.work, OWNER);
  await bed.service.create(bed.work, OWNER);
  await bed.service.create(bed.otherWork, OWNER);
  bed.spawned[0]?.emit({ type: "approval_request", id: "a1", category: "exec", title: "Run?", message: "bash: npm test", answers: ["deny", "session", "always", "once"], tool: "bash", key: KEY });
  await bed.clock.advance(0);
  bed.service.respondDialog({ sessionId: first.sessionId, dialogId: "a1", response: { answer: "always" } }, OWNER);
  expect(policy.added).toEqual([{ ownerId: OWNER.userId, scope: realpathSync(bed.work), tool: "bash", key: KEY, label: "bash: npm test" }]);
  const updates = (index: number) => bed.spawned[index]?.sent.filter((record) => record.type === "policy_update") ?? [];
  expect(updates(1)).toEqual([{ type: "policy_update", rules: { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [{ tool: "bash", key: KEY }] } }]);
  expect(updates(2)).toEqual([]);
});

it("starts a worker with its project's always rules", async () => {
  open({ policy: fakePolicyPort([{ tool: "bash", key: KEY }]) });
  await bed.service.create(bed.work, OWNER);
  expect(bed.spawned[0]?.sent.find((record) => record.type === "init")).toMatchObject({ policy: { alwaysAllow: [{ tool: "bash", key: KEY }] } });
});

it("says so when the project's always rules are full, and keeps the answer for the session", async () => {
  const policy = fakePolicyPort([], { full: true });
  open({ policy });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const frames = await bed.subscribe(sessionId);
  bed.spawned[0]?.emit({ type: "approval_request", id: "a1", category: "exec", title: "Run?", message: "bash: x", answers: ["deny", "session", "always", "once"], tool: "bash", key: KEY });
  await bed.clock.advance(0);
  bed.service.respondDialog({ sessionId, dialogId: "a1", response: { answer: "always" } }, OWNER);
  expect(frames.map((frame) => frame.event)).toContainEqual(expect.objectContaining({ kind: "notice", level: "warning" }));
});
```

(`fakePolicyPort(initial?, { full? })` records `addAlways` calls in `added`, answers `"full"` when asked to, returns `initial` from `rulesFor` (plus what was added), uses the identity for `scopeOf`, and calls its `onChange` listeners on add; the bed gains `otherWork`, a second temp folder, and the `policy` option, defaulting to an empty fake.)

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

export interface PolicyGrants {
  hasSession(key: string): boolean;
  rememberSession(key: string): void;
  /** An "always" answer the daemon has not pushed back yet: it lasts until the next policy update (M2-RT-01). */
  hasProvisionalAlways(key: string): boolean;
  rememberAlways(key: string): void;
}

/** One per worker; insertion-ordered sets, so the oldest grant is the first dropped at the cap. */
export function createPolicyGrants(rulesVersion: () => number, max = MAX_SESSION_GRANTS): PolicyGrants {
  const session = new Set<string>();
  const provisional = new Map<string, number>();
  return {
    hasSession: (key) => session.has(key),
    rememberSession(key) {
      session.delete(key);
      session.add(key);
      if (session.size > max) session.delete(session.values().next().value as string);
    },
    hasProvisionalAlways: (key) => provisional.get(key) === rulesVersion(),
    rememberAlways(key) {
      provisional.delete(key);
      provisional.set(key, rulesVersion());
      if (provisional.size > max) provisional.delete(provisional.keys().next().value as string);
    },
  };
}

// evaluateToolCall, after the `reviewable` check and before asking (Task 13b's `key`, computed once, moves up here):
    if (!review) {
      const always = rules.alwaysAllow.some((rule) => rule.tool === event.toolName && rule.key === key) || deps.grants.hasProvisionalAlways(key);
      const grantedBy = deps.grants.hasSession(key) ? "session rule" : always ? "always rule" : null;
      if (grantedBy) {
        record("allow", grantedBy);
        return undefined;
      }
    }
    // … ask (Task 13b) …
    if (outcome.answer === "session") deps.grants.rememberSession(key);
    // Never a session grant: a revoke must bite this worker too (M2-RT-01).
    if (outcome.answer === "always") deps.grants.rememberAlways(key);
```

`PolicyConfig` gains `rulesVersion(): number`; `createPapPolicyExtension` builds `grants: createPolicyGrants(config.rulesVersion)` into the deps of its worker (`PolicyDeps.grants`). `host.ts`: `let rulesVersion = 0;` and the dispatch's `setRules` becomes `(next) => { rules = next; rulesVersion++; }` (a malformed update goes through `setRules` too, M2R16); `openSession` passes `rulesVersion: () => rulesVersion`. `testing/policy-bed.ts`: the harness options gain `rules` (already there) and `rulesVersion` (default `() => 0`); each harness builds its own `createPolicyGrants`. Every path still ends in the M1 `catch` that fails closed.

- [ ] **Step 4: Wire the sessions**

`sessions/service.ts`:

```ts
  // The row and project each LiveSession was launched for. A WeakMap: nothing to clean when a session goes (M2-RT-25).
  const launched = new WeakMap<LiveSession, { row: SessionRow; scope: string }>();
  const policyFor = (row: SessionRow, scope: string): PolicyRules => ({
    profile: "interactive",
    approvalMode: "auto-accept-edits",
    alwaysAllow: deps.policy.rulesFor(row.ownerId, scope),
  });
  // A rule added or revoked reaches every worker of that owner and project, including one still starting.
  deps.policy.onChange((ownerId, scope) => {
    for (const session of [...live.values(), ...starting]) {
      const at = launched.get(session);
      if (at && at.row.ownerId === ownerId && at.scope === scope) session.send({ type: "policy_update", rules: policyFor(at.row, scope) });
    }
  });
```

`launch()` computes `const scope = deps.policy.scopeOf(row.cwd)`, uses `policy: policyFor(row, scope)` in `init` and calls `launched.set(session, { row, scope })` right after `startLiveSession`. `respondDialog()`:

```ts
    respondDialog(input, caller) {
      const row = owned(input.sessionId, caller);
      const session = live.get(input.sessionId);
      if (!session) throw new PapError("not_found");
      const approved = session.answer(input.dialogId, input.response);
      if (approved?.answer !== "always") return;
      const scope = launched.get(session)?.scope ?? deps.policy.scopeOf(row.cwd);
      const added = deps.policy.addAlways({ ownerId: row.ownerId, scope, ...approved.grant });
      if (added === "full") {
        deps.hub.publish("session", row.id, { kind: "notice", level: "warning", text: "This project already has 1000 always-allowed calls: this one is allowed for the session only." });
      }
    },
```

(With `full` nothing is pushed: the worker's provisional grant lasts until the project's next rule change, which is what the notice calls "for the session only".) `LiveSession` gains `send(record: DaemonToWorker): boolean` (the handle's). `daemon.ts` passes `policy: policy.port` to `createSessionsModule`; `testing/int-bed.ts` migrates `POLICY_MIGRATIONS` too, builds the policy module on the same database and exposes `bed.policyRpc` (its `rpc`); the other `createSessionsModule` callers pass a fake port.

- [ ] **Step 5: Write the integration test**

`sessions.grants.int.test.ts` (int bed; each worker starts its script from the first step, so a session's worker runs `call, "1"`, then `call, "2"`, then `call, "3"`, and the second session's worker runs `call, "1"`):

```ts
it("remembers an always answer for the project across workers, and a revoke bites the live worker (M2-RT-01)", async () => {
  const call = { toolCalls: [{ name: "bash", args: { command: "echo granted" }, id: "c" }] };
  const bed = await createIntBed({ steps: [call, { text: "1" }, call, { text: "2" }, call, { text: "3" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    const cards = () => sub.events().filter((event) => event.kind === "dialog_open");
    void bed.rpc["sessions.prompt"]({ sessionId, text: "first" }, bed.ctx);
    const ask = await sub.waitFor((event) => event.kind === "dialog_open");
    if (ask.kind !== "dialog_open") throw new Error("no card");
    expect(ask.dialog).toMatchObject({ method: "approval", category: "exec", answers: ["deny", "session", "always", "once"] });
    await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: ask.dialog.id, response: { answer: "always" } }, bed.ctx);
    await promptAndSettle(bed, sub, sessionId, "second");
    expect(cards()).toHaveLength(1);
    // Another session of the same project, in a worker of its own, starts with the rule: its run asks nothing.
    const other = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
    const otherSub = await bed.subscribe(other);
    await promptAndSettle(bed, otherSub, other, "elsewhere");
    expect(otherSub.events().filter((event) => event.kind === "dialog_open")).toEqual([]);
    // Revoked while the worker that took the answer lives: its next identical call asks again.
    const { rules } = await bed.policyRpc["policy.listRules"]({ cwd: bed.work }, bed.ctx);
    expect(rules).toEqual([expect.objectContaining({ tool: "bash", scope: realpathSync(bed.work), label: expect.stringContaining("echo granted") })]);
    await bed.policyRpc["policy.revokeRule"]({ ruleId: rules[0]?.id ?? "" }, bed.ctx);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "third" }, bed.ctx);
    await vi.waitFor(() => expect(cards()).toHaveLength(2), { timeout: 20_000 });
  } finally {
    await bed.dispose();
  }
});
```

- [ ] **Step 6: Run and commit**

Run: `pnpm test:unit && pnpm test:int`
Expected: PASS.

```bash
git add packages/pi-host/src apps/daemon/src
git commit -m "feat(policy): session and always approvals, per-project rules pushed to workers"
```

---

### Task 15: pi-host custom panels, widget factories and the ANSI theme (S1)

References: S1 (`spikes/s1/host.ts`: `ctx.ui.custom()` over `custom_render` / `custom_input` / `custom_close`, the stray render after `done()`), pi-web `lib/rpc-manager.ts` (headless TUI of 92 × 40, widget factories rendered as lines on `requestRender`, components disposed on replacement), `lib/custom-ui-terminal.ts`.

**Rulings (pre-dispatch):**
- **M2R76** [15] `@earendil-works/pi-tui` 1.1.0 joins the catalog and pi-host (already a transitive pin, exact version; `KeybindingsManager` and `TUI_KEYBINDINGS` exist in 1.1.0); the lockfile is regenerated with `pnpm install`, never hand-merged — the keybindings manager custom panels need — cost if wrong: a lockfile conflict with M3, resolved by reinstalling.
- **M2R77** [15] Panels render at a fixed 92 × 40 (S1, pi-web); no resize protocol in M2 — no resize protocol between browser and worker in M2 — cost if wrong: wrapping on narrow phones.
- **M2R78** [15] Between this task and Task 16 the daemon ignores panel records, so an extension calling `ctx.ui.custom()` waits until Task 16 lands; the branch is not released in between — sequential tasks — cost if wrong: none.
- **M2R79** [15, 27] Extensions get a real ANSI theme (owner C2): `ansi-theme.ts`'s `AnsiTheme` subclasses the SDK `Theme` and renders tokens with the 8 basic SGR colours and bright black (30–37, 90), bold, dim, italic and underline only — never 256-colour or truecolor codes, never backgrounds or inverse, which the client ignores; it replaces `plain-theme.ts` — the SDK's own `Theme` emits only `38;5` / `38;2` codes — cost if wrong: extensions that colour through `theme.fg(...)` show plain text.
- **M2R80** [15] Component re-renders are coalesced at the source: a widget's or panel's `requestRender()` schedules one render 50 ms later (latest state wins, timer cleared on close); a key sent to a panel still re-renders at once (M2-RT-18) — a 60 Hz spinner must not flood the stream — cost if wrong: a 50 ms lag on extension-driven redraws.
- **M2R81** [15] `custom_input` / `custom_cancel` are the last dispatch cases: the `default` branch becomes the compile-time guard `const unhandled: never = record` (M2R17, M2-RT-23) — a missing case then fails the build instead of a request at runtime — cost if wrong: none.

**Files:**
- Create: `packages/pi-host/src/custom-panels.ts`, `custom-panels.test.ts`, `packages/pi-host/src/widget-components.ts`, `widget-components.test.ts`, `packages/pi-host/src/ansi-theme.ts`, `ansi-theme.test.ts`, `packages/pi-host/src/host.panels.int.test.ts`
- Delete: `packages/pi-host/src/plain-theme.ts` (its only user, the UI bridge, takes the ANSI theme; knip would flag it)
- Modify: `packages/pi-host/src/{ui-bridge,host,dispatch}.ts`, `ui-bridge.test.ts`, `packages/pi-host/package.json`, `pnpm-workspace.yaml` (catalog line), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1a `custom_*` records, `UI_LIMITS`; Task 4 `send(): boolean`.
- Produces:
  - `ANSI_THEME: Theme` (`ansi-theme.ts`): the `ctx.ui.theme` extensions get and the theme panels and widgets render with.
  - `createCustomPanels(send: (record: PanelOutbound) => boolean, deps: { newId(): string; theme: Theme; onError(event: string, error: unknown): void; timers?: RenderTimers }): CustomPanels { open<T>(factory): Promise<T>; input(id, data): void; cancel(id): void; cancelAll(): void; count(): number }`, `PANEL_COLUMNS = 92`, `PANEL_ROWS = 40`, `RENDER_EVERY_MS = 50`, `RenderTimers { setTimer(fn, ms): unknown; clearTimer(handle): void }` (real timers, `unref`ed, by default).
  - Rules: the first render goes out when the factory's component exists; each `custom_input` (≤ `UI_LIMITS.panelInput` characters) goes to `handleInput` then re-renders at once; `requestRender()` re-renders at most once per `RENDER_EVERY_MS` (latest state); `done(value)` disposes the component, sends `custom_close` once and never renders again; a factory that resolves after the panel was cancelled has its component disposed at once; a throwing `render`, `handleInput` or factory closes the panel (resolving `undefined`) and reports through `onError` (→ an `extension_error` record); a render that cannot be sent closes the panel; lines are cut to `UI_LIMITS.panelLines` × `UI_LIMITS.panelLineChars` here, at the source.
  - `createWidgetComponents(send, deps)`: `set(key, factory, placement)` renders the factory's component at 92 columns as a `setWidget` record, re-renders on its `requestRender`, disposes the previous component of that key; `clear(key)`; `clearAll()`; lines cut to `UI_LIMITS.widgetLines` × `UI_LIMITS.widgetLineChars`. String-array widgets keep their M1 path (cut the same way).
  - `ui-bridge`: `custom: (factory) => panels.open(factory)`; `setWidget` routes functions to the widget components; `cancelAll()` also cancels panels and clears widget components. `dispatch`: `custom_input` → `panels.input`, `custom_cancel` → `panels.cancel`.

- [ ] **Step 1: Write the failing tests**

`custom-panels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ANSI_THEME } from "./ansi-theme.ts";
import { createCustomPanels, PANEL_COLUMNS } from "./custom-panels.ts";

function setup(sendOk = true) {
  const sent: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  let ids = 0;
  const panels = createCustomPanels((record) => { sent.push(record); return sendOk; }, { newId: () => `p${++ids}`, theme: ANSI_THEME, onError: (event) => void errors.push(event) });
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

  it("coalesces requestRender into one render per 50 ms, and leaves no timer after done (M2-RT-18)", async () => {
    const due: Array<() => void> = [];
    const timers = {
      setTimer: (fn: () => void) => {
        due.push(fn);
        return fn;
      },
      clearTimer: (handle: unknown) => {
        const at = due.indexOf(handle as never);
        if (at !== -1) due.splice(at, 1);
      },
    };
    const sent: Array<Record<string, unknown>> = [];
    let ticks = 0;
    let requestRender = () => {};
    let finish: (value: string) => void = () => {};
    const panels = createCustomPanels((record) => { sent.push(record); return true; }, { newId: () => "p1", theme: ANSI_THEME, onError: () => {}, timers });
    const result = panels.open<string>(((tui: { requestRender(): void }, _theme: unknown, _keys: unknown, done: (value: string) => void) => {
      requestRender = () => tui.requestRender();
      finish = done;
      return { render: () => [`ticks: ${ticks}`], invalidate: () => {} };
    }) as never);
    await flush();
    for (ticks = 1; ticks <= 60; ticks++) requestRender();
    expect(sent).toHaveLength(1);
    expect(due).toHaveLength(1);
    for (const fire of due.splice(0)) fire();
    expect(sent.at(-1)).toEqual({ type: "custom_render", id: "p1", lines: ["ticks: 61"] });
    requestRender();
    finish("done");
    expect(await result).toBe("done");
    expect(due).toEqual([]);
  });
});
```

`widget-components.test.ts`: a factory widget sends `{ type: "extension_ui_request", method: "setWidget", widgetKey: "todo", widgetLines: ["- a"], widgetPlacement: "belowEditor" }` (with an id) at set; 60 `requestRender()` calls send the new lines once, when the 50 ms timer fires (fake `timers` as in the panel test); setting the key again disposes the first component and clears its timer; `clear("todo")` disposes and sends `widgetLines: undefined`; a factory that throws reports through `onError` and sends nothing.

`ansi-theme.test.ts`:

```ts
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ANSI_THEME } from "./ansi-theme.ts";

const TOKENS: ThemeColor[] = ["accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdCode", "toolDiffAdded", "toolDiffRemoved", "syntaxKeyword", "syntaxString", "bashMode"];

describe("the ANSI theme extensions get (owner C2)", () => {
  it("renders tokens with the basic SGR colours, dim and the default colour", () => {
    expect(ANSI_THEME.fg("error", "x")).toBe("\u001b[31mx\u001b[39m");
    expect(ANSI_THEME.fg("success", "x")).toBe("\u001b[32mx\u001b[39m");
    expect(ANSI_THEME.fg("accent", "x")).toBe("\u001b[34mx\u001b[39m");
    expect(ANSI_THEME.fg("muted", "x")).toBe("\u001b[2mx\u001b[22m");
    expect(ANSI_THEME.fg("text", "x")).toBe("x");
    expect(ANSI_THEME.bold("x")).toBe("\u001b[1mx\u001b[22m");
  });

  it("never emits 256-colour, truecolor, background or inverse codes", () => {
    const rendered = [...TOKENS.map((token) => ANSI_THEME.fg(token, "x")), ANSI_THEME.bg("selectedBg", "x"), ANSI_THEME.inverse("x"), ANSI_THEME.style("x", { fg: "error", bold: true })].join("");
    expect(rendered).not.toMatch(/\u001b\[(?:38|48);|\u001b\[(?:4\d|10\d|7)m/);
  });
});
```

In `ui-bridge.test.ts`: `custom()` no longer resolves `undefined` at once (it opens a panel: a `custom_render` is sent); `cancelAll()` closes it with `custom_close`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host`
Expected: FAIL.

- [ ] **Step 3: Install pi-tui and implement**

Add `"@earendil-works/pi-tui": 1.1.0` to the `catalog:` of `pnpm-workspace.yaml`, then run `pnpm --filter @pap/pi-host add "@earendil-works/pi-tui@catalog:"` (already in the lockfile as a dependency of the SDK; no new build script, R36).

`custom-panels.ts` (the S1 bridge, hardened as the tests require): each panel registers in a `Map<id, { input(data); cancel() }>` **before** the factory runs, so a cancel during an async factory is seen; the factory is called through `Promise.resolve().then(() => factory(tui, theme, keybindings, done))` so a synchronous throw is caught like an async one; `tui = { terminal: { columns: PANEL_COLUMNS, rows: PANEL_ROWS, kittyProtocolActive: false }, requestRender: render }`; `keybindings = new KeybindingsManager(TUI_KEYBINDINGS)` from `@earendil-works/pi-tui` (the SDK's own manager is exported as a type only, S1); `render()` does nothing once closed or before the component exists, catches a throwing `render` (→ `onError("custom_render")`, `done(undefined)`), clips, and closes the panel when `send` returns false; `done()` is idempotent, deletes the entry, disposes the component inside `try` (→ `onError("custom_dispose")`), sends `custom_close`, resolves. `widget-components.ts` follows the same rules with `setWidget` records and no input.

A `requestRender()` sets one timer of `RENDER_EVERY_MS` if none is set (latest state wins when it fires); `done()`, `cancel` and `cancelAll` clear it; real timers are `unref`ed so a pending render never keeps the worker alive.

`packages/pi-host/src/ansi-theme.ts` (replaces `plain-theme.ts`, which goes):

```ts
import { Theme, type ThemeBg, type ThemeColor, type ThemeStyle } from "@earendil-works/pi-coding-agent";

/**
 * The SGR foreground code of each theme token, among the 8 basic colours (30–37) and bright black (90) only: the web
 * client maps exactly these to role tokens (DESIGN.md §9.2, owner C2) and ignores 256-colour and truecolor codes. A
 * token not listed keeps the default colour; a muted token is rendered dim (SGR 2).
 */
const FG: Partial<Record<ThemeColor, number>> = {
  error: 31, toolDiffRemoved: 31,
  success: 32, toolDiffAdded: 32, syntaxString: 32,
  warning: 33, syntaxNumber: 33,
  accent: 34, borderAccent: 34, mdHeading: 34, mdLink: 34, toolTitle: 34, syntaxKeyword: 34,
  customMessageLabel: 35, bashMode: 35,
  mdCode: 36, mdLinkUrl: 36, syntaxFunction: 36, syntaxType: 36,
  border: 90, scrollbarTrack: 90, dim: 90,
};
const DIM: ReadonlySet<ThemeColor> = new Set<ThemeColor>([
  "muted", "borderMuted", "thinkingText", "mdQuote", "mdQuoteBorder", "mdHr", "toolDiffContext", "syntaxComment",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
]);
const opening = (color: ThemeColor): string => {
  const code = FG[color];
  return code !== undefined ? `\u001b[${code}m` : DIM.has(color) ? "\u001b[2m" : "";
};
const closing = (color: ThemeColor): string => (FG[color] !== undefined ? "\u001b[39m" : DIM.has(color) ? "\u001b[22m" : "");

class AnsiTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "256color",
    );
  }

  override fg(color: ThemeColor, text: string): string {
    return `${opening(color)}${text}${closing(color)}`;
  }
  override bg(_color: ThemeBg, text: string): string {
    return text;
  }
  override style(text: string, options: ThemeStyle): string {
    let out = typeof options.fg === "string" ? this.fg(options.fg, text) : text;
    if (options.bold) out = this.bold(out);
    if (options.dim) out = `\u001b[2m${out}\u001b[22m`;
    if (options.italic) out = this.italic(out);
    if (options.underline) out = this.underline(out);
    return out;
  }
  override bold(text: string): string {
    return `\u001b[1m${text}\u001b[22m`;
  }
  override italic(text: string): string {
    return `\u001b[3m${text}\u001b[23m`;
  }
  override underline(text: string): string {
    return `\u001b[4m${text}\u001b[24m`;
  }
  override inverse(text: string): string {
    return text;
  }
  override strikethrough(text: string): string {
    return text;
  }
  override getFgAnsi(color: ThemeColor): string {
    return opening(color);
  }
  override getBgAnsi(): string {
    return "";
  }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => this.fg("dim", text);
  }
  override getBashModeBorderColor(): (text: string) => string {
    return (text) => this.fg("bashMode", text);
  }
}

/** What `ctx.ui.theme` is in pap, and what panels and widgets render with. */
export const ANSI_THEME: Theme = new AnsiTheme();
```

`ui-bridge.ts`: `createUiBridge(send, options)` builds both (`theme: ANSI_THEME`, `onError` → an `extension_error` record through `toExtensionErrorRecord` with `extensionPath: "pi-host:ui"`), `context.theme` is `ANSI_THEME`, `context.custom = (factory) => panels.open(factory)`, `setWidget` routes a function to `widgets.set`, an array or `undefined` to `widgets.clear(key)` then the M1 record (cut), and `UiBridge` gains `panelInput(id, data)` and `panelCancel(id)`; `cancelAll()` calls `panels.cancelAll()` and `widgets.clearAll()` after the dialogs. `dispatch.ts` adds the two cases and replaces its `default` with `default: { const unhandled: never = record; return void unhandled; }` (M2R81).

- [ ] **Step 4: Write the integration test**

In the new `host.panels.int.test.ts` (the bed set-up of `host.int.test.ts`), with an extension file `picker.js` in the agent directory whose `/pick` command opens the panel of the unit test and then calls `ctx.ui.notify(`picked:${choice}`, "info")`:

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

**Rulings (pre-dispatch):**
- **M2R82** [16] A panel past the 4-open limit is cancelled (`custom_cancel`, the extension gets `undefined`) with a rate-limited notice — bounded — cost if wrong: an extension that opens a fifth panel gets `undefined`.
- **M2R83** [16] Status, widget, title and panel events go through one keyed throttle: the first change of a key publishes at once, later ones within 50 ms fold into one publish of the latest value; keys are bounded (decorations refuse new keys past `UI_LIMITS` before the throttle sees them; the throttle itself holds at most 64 pending keys) (M2-RT-18) — a 60 Hz status must not flood every subscriber and evict the replay ring — cost if wrong: a status shown up to 50 ms late.
- **M2R84** [16] Notices from extensions (`notify`, extension errors) are limited to 10 per 10 s per session; past that they are counted, and one "N more notices from extensions were not shown." ends the window (M2-RT-18) — a flood must not evict the replay ring — cost if wrong: a chatty extension's notice not shown.
- **M2R85** [16, 27] The notice ring keeps the last 20 notices of every source (pap and extensions), start-up notices included; an extension's own text carries `source: "extension"` and the UI labels it so (owner R2-8) — start-up notices reach a cursor-less subscriber, and extension text must not pass for pap's — cost if wrong: a notice that looks like pap's own.
- **M2R86** [16] `sessions.panelInput` is `idempotent: true`: keystrokes are never retried by the client, and a receipt per keystroke would mean an fsync per key — the one reasoned exception to R65b, written in `methods.ts` and accepted by the owner (R2-10) — cost if wrong: none (the client never resends a keystroke).

**Files:**
- Create: `apps/daemon/src/modules/sessions/decorations.ts`, `decorations.test.ts`, `panels.ts`, `panels.test.ts`, `notices.ts`, `notices.test.ts`, `keyed-throttle.ts`, `keyed-throttle.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{dialogs,live-ui,live-session,service,service-reads,rpc}.ts`, `live-session.ui.test.ts`, `service.pre-ready.test.ts`, `packages/contracts/src/methods.ts`
- Modify: `apps/web/src/stores/session-reducer.ts`; Create: `apps/web/src/stores/reduce-ui.ts`, `reduce-ui.test.ts`

**Interfaces:**
- Consumes: Task 1b stream kinds, Task 1a `UI_LIMITS`; Task 15 panel records.
- Produces:
  - `createDecorations(): { apply(request: UiRequestRecord): SessionStreamEvent | null; statuses(): StatusEntry[]; widgets(): Widget[]; title(): string | null; clear(): void }` — `setStatus` (key 1..`statusKey` characters, text cut; `undefined` / non-string clears; a new key past `statuses` is dropped), `setWidget` (array of strings cut to the limits, `undefined` clears, placement `belowEditor` or else `aboveEditor`, a new key past `widgets` dropped), `setTitle` (cut), `set_editor_text` (→ `editor_text`, not stored), `notify` (→ `notice` with `notifyType` `warning` / `error` else `info`, text cut, `source: "extension"`). Anything malformed → `null` (counted, logged once every 10 s).
  - `createKeyedThrottle({ clock, publish, windowMs = 50, maxKeys = 64 }): { push(key, event): void; flush(key?): void; drop(key): void; clear(): void }` — the first event of a key goes out at once; later ones within the window replace each other and go out when it ends; past `maxKeys` pending keys an event goes out at once.
  - `createPanels({ clock, publish, cancel(id), say(notice), throttle }): { render(id, lines): void; close(id): void; has(id): boolean; list(): Panel[]; clear(): string[] }` with the limit above; renders go through the throttle (key `panel:<id>`), `close` flushes its key first.
  - `createNoticeRing(max = UI_LIMITS.notices)`: `add(notice)`, `list()`; `createNoticeLimiter({ clock, publish, max = 10, windowMs = 10_000 }): { add(notice): void; stop(): void }` for extension-sourced notices.
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

`notices.test.ts`: the ring keeps the newest 20, texts cut to 2000 characters; the limiter (fake clock) publishes 10 extension notices, counts the next 5, publishes exactly `{ kind: "notice", level: "warning", text: "5 more notices from extensions were not shown." }` (pap's own text: no `source`) when the 10 s window ends, publishes the 16th of the next window again, and `stop()` leaves `clock.pending()` at 0.

`keyed-throttle.test.ts` (fake clock): 60 pushes of `status:git` in 40 ms publish the first at once and the 60th at 50 ms, nothing else; two keys do not fold into each other; with 64 keys pending a 65th publishes at once; `clear()` leaves `clock.pending()` at 0.

In `service.pre-ready.test.ts`:

```ts
it("hands start-up notices to a subscriber that has no cursor (roadmap: recent notices in the snapshot)", async () => {
  open({
    start: () => ({ kind: "ready", before: [{ type: "extension_error", extensionPath: "/x.js", event: "session_start", error: "boom" }] }),
  });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const snapshot = await bed.snapshot(sessionId);
  expect(snapshot.notices).toEqual([{ level: "error", text: "An extension failed during session_start." }]);
});
```

In `live-session.ui.test.ts`: a `setStatus` request publishes `status_bar` and no `pi` event; 100 `setStatus` requests of one key within 10 ms publish two `status_bar` events (the first, then the latest at 50 ms); a `notify` publishes `{ kind: "notice", level, text, source: "extension" }`; the worker's exit clears `statuses()` and the open panels and leaves no throttle timer; `panelInput` on an unknown panel throws `not_found`, on an open one sends `{ type: "custom_input", id, data }`.

`reduce-ui.test.ts`: status bar set and clear; widget replace; `editor_text` increments `seq`; panel then `panel_closed`; a `cold` status clears all four.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions apps/web/src/stores`
Expected: FAIL.

- [ ] **Step 3: Implement**

`dialogs.ts`'s `DECORATION_METHODS` verdict stays `decoration`; `live-ui.ts` hands those requests to `decorations.apply()` and publishes the result (or counts a malformed one): `status_bar`, `widget` and `title` events through the keyed throttle (keys `status:<key>`, `widget:<key>`, `title`), a `notice` through the notice limiter, `editor_text` at once; `onExtensionError`'s notice also goes through the limiter. The exit handler calls `throttle.clear()` and `limiter.stop()`. `custom_render` / `custom_close` records go to `panels.render` / `panels.close`; `panels.cancel` sends `{ type: "custom_cancel", id }`. `live-session.ts` wraps its `publish`: `if (event.kind === "notice") notices.add({ level: event.level, text: event.text })` before publishing; its exit handler calls `decorations.clear()` and, for each id from `panels.clear()`, publishes `panel_closed`. `service-reads.ts` passes the five sections to `fitSnapshot`. `service.ts` / `rpc.ts` add `panelInput` (owned → live session → `panelInput`, `not_found` when the session is not live). `methods.ts` declares `sessions.panelInput` with `idempotent: true` and the comment `// Reasoned exception to R65b (owner R2-10): keystrokes are never retried, and a receipt per key would cost an fsync per key.` Web: `reduce-ui.ts` holds the five cases and the `cold` rule; `session-reducer.ts` delegates to it and initialises the fields from the snapshot; a notice keeps its `source`.

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores
git commit -m "feat(sessions): status bar, widgets, panels and recent notices, bounded and in snapshots"
```

---
### Task 17a: Session commands — navigate and compact, the busy rule, activity

References: pi-web `docs/agents/sessions.md` "In-session branching waits for the run" (`navigateTree` refused while streaming or compacting), "Compaction SSE events", "Auto-retry banner".

**Rulings (pre-dispatch):**
- **M2R87** [17a] New error code `command_failed` ("The session could not complete this command.") for a worker that refused a command for a reason the daemon must not repeat (R66); the worker's text is logged clipped (`command_refused {command, error}`), never returned — fixed messages — cost if wrong: none.
- **M2R88** [17a] Busy rule for `navigate` and `compact`: the session is busy while a run is open, while it compacts, while a prompt is in flight (the R113 window before `agent_start`, when the status still says `idle`) and while another navigate or compact is in flight; checked before and again after `ensureLive` resolved, with no `await` between the last check and the send (M2-RT-08) — Pi's `compact()` aborts the current operation — cost if wrong: a user's prompt aborted by a compaction.
- **M2R89** [17a, 24] A prompt while the session compacts, or while a compact command is in flight, is refused with `session_busy` and never sent (Pi would throw "Cannot submit a prompt while compaction is in progress" and the user would read `prompt_rejected`); `sessions.prompt` lists `session_busy`, and the composer disables Send while `activity.compacting` (M2-RT-34) — the right message — cost if wrong: none.
- **M2R90** [17a] `navigate_tree` has no daemon timeout (M2R11), so `sessions.navigate` cannot answer `timeout`; when Pi answers, the daemon moves its leaf and publishes a fresh `snapshot` of the new branch (clients replace their view) — at most one snapshot per navigation — cost if wrong: the replay ring evicted by a snapshot (bounded: one per navigation).
- **M2R91** [17a, 17b, 18, 19] Session commands go through `live-commands.ts` (`command()`, `inFlight()`, `structuralInFlight()`, `activity()`), so `live-session.ts` stays under 400 lines (M2-RT-19) — the 400-line rule, named in advance — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/modules/sessions/live-commands.ts`, `service-commands.ts`, `service.commands.test.ts`, `sessions.commands.int.test.ts`
- Modify: `packages/contracts/src/{errors,methods}.ts` (+ tests), `apps/daemon/src/modules/sessions/{service,live-session,live-run,rpc,service-reads}.ts`, `live-session.run.test.ts`, `testing/service-bed.ts` (option `replies`: per-command answers of the fake worker, `"held"` answered later through `bed.answerHeld(index, command, reply)`)
- Modify: `apps/web/src/stores/{session-reducer,reduce-ui}.ts`, tests, `apps/web/src/i18n/{en,fr}.ts` (`error.command_failed`, inside the `sessions (M2)` block)

**Interfaces:**
- Consumes: Task 2 commands, Task 10b `LiveSession.leafId()`, Task 11 reads (`ensureReader`, `snapshot`).
- Produces:
  - Methods (both `sessions:operate`, mutations): `sessions.navigate { sessionId, targetId: string(1..128) } → { cancelled: boolean; editorText?: string }` (errors `not_found`, `session_busy`, `capacity`, `worker_failed`, `command_failed`); `sessions.compact { sessionId, customInstructions?: string(..4096) } → { tokensBefore: number; estimatedTokensAfter: number | null }` (same errors + `session_empty`). `sessions.prompt` errors gain `session_busy`.
  - `live-commands.ts`: `createLiveCommands({ handle, logger }): { command(input: CommandInput): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>; inFlight(): number; structuralInFlight(): number; compactInFlight(): number; activity(): Activity; onPiEvent(event): SessionStreamEvent | null; reset(): void }` — `command` counts the request in flight from the synchronous send to its answer; `structuralInFlight` counts `navigate_tree` and `compact`, `compactInFlight` only `compact`; `onPiEvent` turns `compaction_start` / `compaction_end` / `auto_retry_start {attempt, maxAttempts}` / `auto_retry_end` / `agent_start` into `{kind: "activity"}` events.
  - `LiveSession.busy(): boolean` (the busy rule), `LiveSession.command(...)`, `LiveSession.commandsInFlight(): number` (read by Task 20), `LiveSession.navigated(leafId)`, `LiveSession.activity()`.
  - Worker failures map: compact `"Nothing to compact"` (any case) → `session_empty`; any other refusal → `command_failed`. One function, `refusalOf(command, error): ErrorCode`, with a test per row.

- [ ] **Step 1: Write the failing tests**

`service.commands.test.ts` (its own `open` / `afterEach` pair; the fake worker answers commands from the `replies` table):

```ts
it("refuses to navigate or compact while the session runs", async () => {
  open();
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.emit(0, { type: "agent_start" });
  await expect(bed.service.navigate({ sessionId, targetId: "a0" }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  expect(bed.spawned[0]?.requests.map((request) => request.type)).toEqual([]);
});

it("is busy while a prompt waits for its agent_start and while a compaction is in flight (M2-RT-08, M2-RT-34)", async () => {
  open({ replies: { prompt: "held", compact: "held" } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  void bed.service.prompt({ sessionId, text: "go" }, OWNER);
  await bed.clock.advance(0);
  // Pi has the prompt, no agent_start yet: the status still says idle, the session is busy all the same.
  await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  await expect(bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  bed.answerHeld(0, "prompt", { data: { disposition: "handled" } });
  await bed.clock.advance(0);
  void bed.service.compact({ sessionId }, OWNER);
  await bed.clock.advance(0);
  await expect(bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  await expect(bed.service.prompt({ sessionId, text: "now" }, OWNER)).rejects.toThrow(new PapError("session_busy"));
  expect(bed.spawned[0]?.requests.map((request) => request.type)).toEqual(["prompt", "compact"]);
});

it("moves the leaf on navigate and publishes a fresh snapshot of the new branch", async () => {
  open({ replies: { navigate_tree: { data: { cancelled: false, leafId: "a0", editorText: "q1" } } } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.writePiFile(0, [["q0", "r0"], ["q1", "r1"]]);
  const frames = await bed.subscribe(sessionId);
  expect(await bed.service.navigate({ sessionId, targetId: "u1" }, OWNER)).toEqual({ cancelled: false, editorText: "q1" });
  const snapshot = frames.at(-1)?.event as SnapshotEvent;
  expect(snapshot.kind).toBe("snapshot");
  expect(snapshot.leafId).toBe("a0");
  expect(snapshot.rows.map((row) => row.entryId)).toEqual(["u0", "a0"]);
});

it.each([
  ["Nothing to compact (session too small)", "session_empty"],
  ["No API key found for x.", "command_failed"],
])("maps a refused compaction (%s) to %s", async (error, code) => {
  open({ replies: { compact: { success: false, error } } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError(code as never));
});
```

In `live-session.run.test.ts`: `compaction_start` then `compaction_end` publish `activity` events `{compacting: true, retry: null}` then `{compacting: false, retry: null}`; `auto_retry_start {attempt: 2, maxAttempts: 3}` then `agent_start` publish `retry: {attempt: 2, maxAttempts: 3}` then `retry: null`; a prompt while compacting throws `session_busy` and sends nothing.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`service-commands.ts` exports `createSessionCommands(deps: { owned; ensureLive; live: ReadonlyMap<string, LiveSession>; reads; store; hub: Pick<StreamHub, "publish">; logger })` with `navigate` and `compact` (Task 17b adds `rename` and `autoName`, Task 18 `exportHtml`):

```ts
    async navigate({ sessionId, targetId }, caller) {
      const row = deps.owned(sessionId, caller);
      if (deps.live.get(sessionId)?.busy()) throw new PapError("session_busy");
      const session = await deps.ensureLive(row);
      // Again, with no await before the send: a prompt or a compaction may have started meanwhile (M2-RT-08).
      if (session.busy()) throw new PapError("session_busy");
      const reply = await session.command({ type: "navigate_tree", targetId });
      if (!reply.ok) throw new PapError(refused("navigate_tree", reply.error));
      const data = reply.data as { cancelled?: unknown; leafId?: unknown; editorText?: unknown };
      session.navigated(typeof data.leafId === "string" ? data.leafId : null);
      await deps.reads.ensureReader();
      deps.hub.publish("session", row.id, deps.reads.snapshot(row.id));
      return { cancelled: data.cancelled === true, ...(typeof data.editorText === "string" ? { editorText: data.editorText } : {}) };
    },
```

`compact` follows the same busy checks and maps `{ tokensBefore, estimatedTokensAfter }`; `refused(command, error)` logs `command_refused {command, error: clip(error)}` and returns `refusalOf(command, error)`. `live-session.ts` builds `createLiveCommands`, routes Pi events through its `onPiEvent` (activity events are published, the raw `compaction_*` / `auto_retry_*` events still reach the run tracker), and exposes `busy()`:

```ts
    busy: () => run.tracker.running || commands.activity().compacting || run.promptsInFlight() > 0 || commands.structuralInFlight() > 0,
```

`live-run.ts`'s `prompt()` throws `PapError("session_busy")` before anything is counted or sent when `commands.activity().compacting || commands.compactInFlight() > 0` (M2R89). `navigated(leafId)` sets the session's leaf (an id over 128 characters counts as unknown, M2R52). `rpc.ts` maps both methods one line each; `errors.ts` adds `command_failed` ("The session could not complete this command."), and i18n gets `error.command_failed` inside the `sessions (M2)` block (en as `errors.ts`; fr `"La session n'a pas pu exécuter cette commande."`). Web: `reduce-ui.ts` handles `activity`.

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
```

(`tokensBefore` comes from Pi's own estimate, so the test checks it is a positive number rather than a value Pi may change.)

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): navigate and compact with a busy rule; activity in snapshots"
```

---

### Task 17b: Session commands — rename, auto-name, session names

References: pi-web `app/api/sessions/[id]/auto-name/route.ts` (naming on demand, a button, not automatic).

**Rulings (pre-dispatch):**
- **M2R92** [17b] One clip for every session name, `nameOf(raw)` in `names.ts`: control and bidi characters stripped (`\p{Cc}`, `\p{Cf}`), whitespace runs collapsed, trimmed, cut to 256 code points (never half a surrogate pair), empty → null; used for `ready.sessionName`, `session_info_changed`, the rename input and the store (M2-RT-06) — the database CHECK, the contract and the list must agree — cost if wrong: a session that cannot reopen, or `sessions.list` failing for every session.
- **M2R93** [17b] Rename and auto-name of a cold session start its worker (single-writer rule: only a worker writes an existing Pi file) — only a worker writes an existing Pi file (single-writer rule) — cost if wrong: capacity used by a rename.
- **M2R94** [17b] Names are cached in `sessions.name` (an index of Pi's `session_info`, refreshed from `ready` and `session_info_changed`); `sessions.rename` lists `timeout` (outcome unknown, R105, M2-RT-08), and a `timeout` on `autoName` is outcome unknown too — Pi's file stays the source of truth; the column only serves listings — cost if wrong: a listed name behind Pi's until the worker next starts.

**Files:**
- Create: `apps/daemon/src/modules/sessions/names.ts`, `names.test.ts`, `migrations/202610110000_session_name.sql`
- Modify: `packages/contracts/src/{methods,streams}.ts` (+ tests), `apps/daemon/src/modules/sessions/{store,service,service-commands,live-session,rpc}.ts`, `store.test.ts`, `service.commands.test.ts`, `live-session.run.test.ts`, `sessions.commands.int.test.ts`
- Modify: `apps/web/src/stores/reduce-ui.ts`, test, `apps/web/src/features/sessions/SessionListScreen.tsx` (shows the name when there is one), `SessionListScreen.test.tsx`

**Interfaces:**
- Consumes: Task 3 `auto_name`, Task 17a `live-commands.ts`.
- Produces:
  - Methods (`sessions:operate`, mutations): `sessions.rename { sessionId, name: string(1..256), trimmed non-empty } → { ok: true }` (`not_found`, `bad_request`, `capacity`, `worker_failed`, `command_failed`, `timeout`); `sessions.autoName { sessionId } → { name: string }` (`not_found`, `session_empty`, `timeout`, `capacity`, `worker_failed`, `command_failed`).
  - `nameOf(raw: unknown): string | null`; `SessionSummary.name: string | null` (`.max(256)`); `SessionRow.name`; `store.setName(id, name)`; the snapshot's `name`.
  - `session_info_changed {name}` from the worker → `nameOf` → `store.setName` + `{kind: "name"}` (never forwarded as a raw Pi event). Auto-name refusal `"nothing to name"` → `session_empty`.

- [ ] **Step 1: Write the failing tests**

`names.test.ts`:

```ts
it.each([
  ["  Fix   the\tlogin  ", "Fix the login"],
  ["‮evil\u0007 name", "evil name"],
  ["", null],
  [" \n ", null],
  [42, null],
  ["😀".repeat(300), "😀".repeat(256)],
])("clips %j to %j", (raw, expected) => {
  expect(nameOf(raw)).toBe(expected);
});
```

In `service.commands.test.ts`:

```ts
it("maps a refused auto-name to session_empty", async () => {
  open({ replies: { auto_name: { success: false, error: "nothing to name" } } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  await expect(bed.service.autoName(sessionId, OWNER)).rejects.toThrow(new PapError("session_empty"));
});

it("stores a clipped name from rename, from Pi's session_info_changed and from ready, and lists it", async () => {
  open({ replies: { set_session_name: { data: undefined } } });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  await bed.service.rename({ sessionId, name: "  Fix login  " }, OWNER);
  expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "set_session_name", name: "Fix login" });
  bed.emit(0, { type: "session_info_changed", name: `Fix the login bug ${"x".repeat(400)}` });
  expect(bed.service.list(OWNER)[0]?.name).toHaveLength(256);
  expect(SessionSummary.array().parse(bed.service.list(OWNER))).toHaveLength(1);
});
```

In `live-session.run.test.ts`: `session_info_changed` publishes `{kind: "name", name}` (clipped) and no `pi` event; a `ready` with a 300-character `sessionName` calls `onName` with 256.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`migrations/202610110000_session_name.sql`:

```sql
-- The name Pi keeps in the session file (`session_info`), cached for listings; refreshed from the worker.
ALTER TABLE sessions ADD COLUMN name TEXT CHECK (name IS NULL OR length(name) <= 256);
```

`names.ts`:

```ts
import { UI_LIMITS } from "@pap/contracts";

/**
 * The one clip of a session name (M2-RT-06): Pi's name comes from the Pi CLI, an extension or the model, so it may be
 * long or hold control or bidi characters. The database, the contract and the list all accept what this returns.
 */
export function nameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return [...flat].slice(0, UI_LIMITS.name).join("");
}
```

`service-commands.ts` gains `rename` (input through `nameOf`; `bad_request` when it is null; then busy-free: a name can change while a run goes on) and `autoName` (the answer's title through `nameOf`); `store.ts` gains `name` in `COLUMNS` and `setName`; `service.ts` delegates both and sets the name from `ready.sessionName` (through `nameOf`) when it differs; `live-session.ts` handles `session_info_changed` through `nameOf` and an `onName(name)` callback the service binds to `store.setName` + publish; `rpc.ts` maps the methods one line each. `SessionSummary` gains `name: z.string().max(UI_LIMITS.name).nullable()`; `refusalOf` maps auto-name's `"nothing to name"` to `session_empty`.

Web: `reduce-ui.ts` handles `name`; `SessionListScreen` shows `session.name ?? session.cwd` as the link text and the cwd below it when there is a name.

- [ ] **Step 4: Write the integration test**

Append to `sessions.commands.int.test.ts`:

```ts
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

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): rename and auto-name; names clipped, cached and listed"
```

---

### Task 18: HTML export — a download that never runs on the pap origin

The export is HTML Pi writes from model output: on the pap origin it would run inline script with the user's cookie. So it is only ever served as an attachment, under a sandbox CSP, `nosniff`, through a single-use token bound to the session and its owner. Spec C §4.5 lists the HTTP routes and has no export route: ADR 0006. Pi's export template walks the session tree with three recursive helpers that overflow the browser's stack on very deep linear sessions; like pi-web, pap patches the exported file to make them iterative — with its own code, all three or none (owner M2-Q7).

**Rulings (pre-dispatch):**
- **M2R95** [18] ADR 0006: the route `GET /api/sessions/:sessionId/export/:token` answers an attachment with `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, behind the session cookie and a single-use token bound to the session and its owner (owner M2-Q13) — model-authored HTML must never run as a page of the pap origin — cost if wrong: XSS on the pap origin if a header regresses (each is pinned by a test).
- **M2R96** [18] Tokens live in memory: a daemon restart invalidates them (the user exports again); at most 16 pending, 10 minutes each; pending files are deleted at stop and at boot — simplicity, bounded — cost if wrong: a re-export after a restart.
- **M2R97** [18] When the export request times out, the pending entry is kept until its TTL deletes the path (the worker may still write the file after the daemon gave up); a refusal or a lost worker discards it at once (M2-RT-26) — no orphan transcript copy in `exports/` — cost if wrong: a copy left until its 10 minutes end.
- **M2R98** [18] Exporting a cold session starts its worker (Pi writes the export) — only a worker writes the export (single-writer rule) — cost if wrong: capacity used.
- **M2R99** [18] The exported HTML is patched in pap's own code (owner M2-Q7): the recursive `sortChildren`, `mapNodes` and `markActive` of Pi 1.1.0's `template.js` become loops; each anchor must match exactly once or nothing is patched, the file is served as Pi wrote it and `export_patch_skipped {anchor}` is logged; tests run the anchors against Pi 1.1.0's own template and the real export of the int test, and compare the loops with the originals on a branched tree and a 100 000-deep chain (pi-web's route was read for the behaviour, none of its code is copied) — deep sessions must open — cost if wrong: an export that does not open past a few thousand entries (served unpatched, logged).
- **M2R100** [18, 28a] Before the download starts, the client shows one line saying the file holds everything the agent saw, secrets included (owner R2-6, Task 28a) — the export holds secrets from tool output — cost if wrong: none.
- **M2R101** [18] The export tests dispose their beds in `afterEach` (temp directory, TTL timers), never at the end of the test body (M2-RT-27) — the M1 lessons: temp dirs and timers released on every path — cost if wrong: leaked temp directories when a test fails.

**Files:**
- Create: `apps/daemon/src/modules/sessions/exports.ts`, `exports.test.ts`, `export-http.ts`, `export-http.test.ts`, `export-patch.ts`, `export-patch.test.ts`, `sessions.export.int.test.ts` (on the full daemon harness), `docs/adr/0006-session-export-download-route.md`
- Modify: `apps/daemon/src/kernel/http/app.ts` (route-owned CSP), `app.test.ts`, `apps/daemon/src/kernel/home.ts` (`exports/` 0700), `home.test.ts`, `apps/daemon/src/daemon.ts`, `apps/daemon/src/modules/sessions/{index,service-commands,rpc}.ts`, `service.commands.test.ts`, `packages/contracts/src/methods.ts`

**Interfaces:**
- Consumes: Task 2 `export_html`, Task 17a commands.
- Produces:
  - `createExports({ dir, clock, logger, newToken? }): { prepare(sessionId, ownerId): { token; path }; take(token, sessionId, ownerId): string | null; discard(token): void; purgeAll(): void; stop(): void }`, `EXPORT_TTL_MS = 600_000`, `MAX_PENDING_EXPORTS = 16` (`prepare` past it → `PapError("capacity")`); `newToken` default `randomBytes(32).toString("base64url")`; `take` deletes the entry and clears its timer before returning (single use, no await in between); expired entries delete their file.
  - Method `sessions.exportHtml { sessionId } → { url: string }` (`sessions:operate`, mutation, errors `not_found`, `capacity`, `timeout`, `worker_failed`, `command_failed`); `url = /api/sessions/<sessionId>/export/<token>`.
  - `mountExportRoute(app, { exports, authenticate(cookieHeader): { userId } | null, logger })`.
  - `HttpAppOptions` unchanged in shape; `app.ts` honours a route-owned CSP: a route that sets `c.set("ownCsp", value)` gets exactly that `Content-Security-Policy`.
  - `prepareHome` creates `$PAP_HOME/exports` (0700) and the daemon empties it at boot (`purgeAll`).
  - `patchExportHtml(html): { html: string; skipped: string | null }` and `patchExportFile(path, logger): Promise<void>` (never throws; writes through `<path>.patching` and a rename), `EXPORT_PATCHES` (name, anchor, replacement).

- [ ] **Step 1: Write the failing tests**

`export-http.test.ts` (a Hono app built with `createHttpApp` and the route; `exports` real, in a temp dir, fake clock; every bed is disposed in `afterEach`, M2-RT-27):

```ts
const beds: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.dispose();
});

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
  const bed = { dir, clock, exports, app, ready, dispose: () => { exports.stop(); rmSync(dir, { recursive: true, force: true }); } };
  beds.push(bed);
  return bed;
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
});

it("keeps every other route on the app's own CSP", async () => {
  const t = setup();
  expect((await t.app.request("/healthz")).headers.get("content-security-policy")).toContain("default-src 'self'");
});
```

`exports.test.ts`: `prepare` past `MAX_PENDING_EXPORTS` throws `capacity`; `take` with a wrong owner returns `null` **and leaves the entry usable for its owner**; `discard` removes the file; `purgeAll` empties the directory; `stop` deletes pending files and leaves no timer (`clock.pending()` 0); tokens are 43 base64url characters.

In `service.commands.test.ts`: with `replies: { export_html: "held" }`, `exportHtml` rejects with `timeout` after 120 s, the file the worker writes afterwards is still deleted when the 10-minute TTL ends (the `exports/` directory is empty, M2-RT-26), and a refused export leaves nothing behind at once.

`export-patch.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { EXPORT_PATCHES, patchExportFile, patchExportHtml } from "./export-patch.ts";

// Pi 1.1.0's own template: the export inlines it verbatim into the HTML it writes.
const TEMPLATE = readFileSync(join(getPackageDir(), "dist", "core", "export-html", "template.js"), "utf8");
const html = `<html><body><script>${TEMPLATE}</script></body></html>`;

type Node = { entry: { id: string; timestamp: string }; children: Node[] };
const node = (id: string, at: number): Node => ({ entry: { id, timestamp: new Date(at).toISOString() }, children: [] });
const chain = (depth: number): Node => {
  const root = node("0", 0);
  let at = root;
  for (let i = 1; i < depth; i++) {
    const next = node(String(i), i);
    at.children.push(next);
    at = next;
  }
  return root;
};
const branched = (): Node[] => {
  const root = node("r", 0);
  const late = node("b", 20);
  const early = node("a", 10);
  late.children.push(node("b1", 30));
  root.children.push(late, early);
  return [root, node("r2", 5)];
};
const pieceOf = (name: string, source: string): string => source.match((EXPORT_PATCHES.find((patch) => patch.name === name) as { anchor: RegExp }).anchor)?.[0] ?? "";
// Each helper wrapped so it can run on its own: the original from Pi's template, or pap's replacement.
const runners = (sort: string, map: string, mark: string) => ({
  sort: runInNewContext(`(roots) => { ${sort} roots.forEach(sortChildren); return roots; }`) as (roots: Node[]) => Node[],
  map: runInNewContext(`(tree) => { const treeNodeMap = new Map(); ${map} return [...treeNodeMap.keys()].sort(); }`) as (tree: Node[]) => string[],
  mark: runInNewContext(`(roots, activePathIds) => { const containsActive = new Map(); ${mark} roots.forEach(markActive); return [...containsActive].map(([n, has]) => n.entry.id + ":" + has).sort(); }`) as (roots: Node[], active: Set<string>) => string[],
});

describe("export patch (owner M2-Q7)", () => {
  it("finds each helper of Pi 1.1.0's template exactly once and replaces all three", () => {
    for (const patch of EXPORT_PATCHES) expect(TEMPLATE.match(patch.anchor), patch.name).toHaveLength(1);
    const { html: patched, skipped } = patchExportHtml(html);
    expect(skipped).toBeNull();
    expect(patched).not.toContain("node.children.forEach(sortChildren)");
    expect(patched).not.toContain("node.children.forEach(mapNodes)");
    expect(patched).not.toContain("if (markActive(child)) has = true;");
  });

  it("serves the file as written when an anchor is missing, and patches nothing", () => {
    const changed = html.replace("node.children.forEach(mapNodes);", "node.children.forEach((child) => mapNodes(child));");
    expect(patchExportHtml(changed)).toEqual({ html: changed, skipped: "mapNodes" });
  });

  it("gives the originals' answers on a branched tree, and survives a chain the originals cannot", () => {
    const original = runners(pieceOf("sortChildren", TEMPLATE), pieceOf("mapNodes", TEMPLATE), pieceOf("markActive", TEMPLATE));
    const ours = runners(EXPORT_PATCHES[0]?.replacement ?? "", EXPORT_PATCHES[1]?.replacement ?? "", EXPORT_PATCHES[2]?.replacement ?? "");
    const ids = (roots: Node[]): string[] => roots.flatMap((root) => [root.entry.id, ...ids(root.children)]);
    expect(ids(ours.sort(branched()))).toEqual(ids(original.sort(branched())));
    expect(ours.map(branched())).toEqual(original.map(branched()));
    expect(ours.mark(branched(), new Set(["b1"]))).toEqual(original.mark(branched(), new Set(["b1"])));
    expect(() => original.sort([chain(100_000)])).toThrow(RangeError);
    expect(() => ours.sort([chain(100_000)])).not.toThrow();
    expect(ours.map([chain(100_000)])).toHaveLength(100_000);
    expect(ours.mark([chain(100_000)], new Set(["99999"]))).toHaveLength(100_000);
  });

  it("never throws for a file it cannot read: the export is served as it is", async () => {
    await expect(patchExportFile("/nonexistent/pap-export.html", silentLogger)).resolves.toBeUndefined();
  });
});
```

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

(Declare `ownCsp` in Hono's `ContextVariableMap` instead of the cast if the project's Hono typing allows it.)

`export-patch.ts` (pap's own replacements; the anchors are Pi 1.1.0's text, matched with any whitespace):

```ts
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Logger } from "../../kernel/logger.ts";

interface ExportPatch {
  readonly name: string;
  readonly anchor: RegExp;
  readonly replacement: string;
}

/** The recursive helpers of Pi's export template (they overflow the stack on deep sessions) and their loops. */
export const EXPORT_PATCHES: readonly ExportPatch[] = [
  {
    name: "sortChildren",
    anchor: /function sortChildren\(node\) \{\s*node\.children\.sort\(\(a, b\) =>\s*new Date\(a\.entry\.timestamp\)\.getTime\(\) - new Date\(b\.entry\.timestamp\)\.getTime\(\)\s*\);\s*node\.children\.forEach\(sortChildren\);\s*\}/g,
    replacement: `function sortChildren(root) {
          const pending = [root];
          while (pending.length > 0) {
            const next = pending.pop();
            next.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
            for (const child of next.children) pending.push(child);
          }
        }`,
  },
  {
    name: "mapNodes",
    anchor: /function mapNodes\(node\) \{\s*treeNodeMap\.set\(node\.entry\.id, node\);\s*node\.children\.forEach\(mapNodes\);\s*\}\s*tree\.forEach\(mapNodes\);/g,
    replacement: `const pending = [...tree];
          while (pending.length > 0) {
            const next = pending.pop();
            treeNodeMap.set(next.entry.id, next);
            for (const child of next.children) pending.push(child);
          }`,
  },
  {
    name: "markActive",
    anchor: /function markActive\(node\) \{\s*let has = activePathIds\.has\(node\.entry\.id\);\s*for \(const child of node\.children\) \{\s*if \(markActive\(child\)\) has = true;\s*\}\s*containsActive\.set\(node, has\);\s*return has;\s*\}/g,
    replacement: `function markActive(root) {
          const order = [];
          const pending = [root];
          while (pending.length > 0) {
            const next = pending.pop();
            order.push(next);
            for (const child of next.children) pending.push(child);
          }
          for (let index = order.length - 1; index >= 0; index--) {
            const next = order[index];
            let has = activePathIds.has(next.entry.id);
            for (const child of next.children) if (containsActive.get(child)) has = true;
            containsActive.set(next, has);
          }
          return containsActive.get(root) === true;
        }`,
  },
];

/** All three helpers or none: a template that changed is served as Pi wrote it. */
export function patchExportHtml(html: string): { html: string; skipped: string | null } {
  let out = html;
  for (const patch of EXPORT_PATCHES) {
    if ((out.match(patch.anchor)?.length ?? 0) !== 1) return { html, skipped: patch.name };
    out = out.replace(patch.anchor, () => patch.replacement);
  }
  return { html: out, skipped: null };
}

/** Patches an exported file in place (a temporary file and a rename). Never throws: a failure serves it unpatched. */
export async function patchExportFile(path: string, logger: Logger): Promise<void> {
  const temp = `${path}.patching`;
  try {
    const { html, skipped } = patchExportHtml(await readFile(path, "utf8"));
    if (skipped) {
      logger.warn("export_patch_skipped", { anchor: skipped });
      return;
    }
    await writeFile(temp, html, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    logger.warn("export_patch_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
  } finally {
    await rm(temp, { force: true });
  }
}
```

`service-commands.ts` `exportHtml(sessionId, caller)`: owned → `await ensureLive(row)` → `exports.prepare(row.id, caller.userId)` → `session.command({ type: "export_html", outputPath: path })` → `await patchExportFile(path, logger)` → `{ url }`. A refusal (`ok: false`, mapped to `command_failed`) or a lost worker (`worker_failed`) calls `exports.discard(token)` (the file may half exist); a `timeout` keeps the entry, whose TTL deletes the path even if the worker writes it later (M2-RT-26). `daemon.ts`: builds `createExports({ dir: join(config.home, "exports"), clock, logger })`, calls `purgeAll()` at boot, mounts the route next to `auth.mount` with `authenticate: auth.authenticateCookieHeader` (it returns the caller or null; adapt to its real return shape), pushes `exports.stop()` on the closers list. `home.ts` adds `exports` to the 0700 directories.

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

Before serving, the daemon makes the template's three recursive tree helpers iterative (all three or none, pap's own
code), so a session thousands of entries deep opens in a browser; a template that changed is served as written.

## Consequences
- A browser saves the file; opened from disk it runs as a local file, outside the pap origin.
- A token is useless without the owner's cookie, and a cross-site request carries no cookie (SameSite=Strict).
- A restart loses pending exports: the user exports again.
- The file holds everything the agent saw, secrets in tool output included; the UI says so before the download.
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
    // Pi 1.1.0's real export, patched (owner M2-Q7): no recursive helper left.
    expect(reply.body).not.toContain("node.children.forEach(sortChildren)");
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

**Rulings (pre-dispatch):**
- **M2R102** [19] ADR 0009: the daemon writes the *new* Pi file of a fork or a clone through Pi's own `SessionManager` (lazily loaded, R108), never an existing file (owner R2-9, M2-RT-16) — the spec C §3.1 deviation is recorded — cost if wrong: none beyond the recorded deviation.
- **M2R103** [19] Before `SessionManager.open()` touches a source, the daemon reads its first line and refuses with `ForkRefusal("unreadable")` a file that is empty, unreadable, not a Pi header or older than `CURRENT_SESSION_VERSION` (owner R2-9, M2-RT-16) — `open()` rewrites (truncates) such a file in place, racing a worker that appends to it — cost if wrong: entries of a hot session lost.
- **M2R104** [19] Clone mid-run copies the branch as written on disk (owner M2-Q10; pi-web's sidebar Fork) — pi-web's sidebar parity; refusing would block cloning a busy session — cost if wrong: the clone misses the turn in flight.
- **M2R105** [19] A fork at the first user message creates a draft session (no file yet; Pi writes it with the first message) — Pi writes a file only once a message exists (S1) — cost if wrong: none.
- **M2R106** [19] Pi's `session_before_fork` hooks do not run (no extension runtime in the daemon), as in pi-web; ADR 0009 says so — no extension runtime runs in the daemon — cost if wrong: an extension surprised by a fork it did not see.

**Files:**
- Create: `apps/daemon/src/modules/sessions/pi-writer.ts`, `pi-writer.test.ts`, `forks.ts`, `forks.test.ts`, `sessions.forks.int.test.ts`, `docs/adr/0009-daemon-side-fork-and-clone.md`
- Modify: `packages/contracts/src/methods.ts`, `apps/daemon/src/modules/sessions/{index,service,rpc,store}.ts`

**Interfaces:**
- Consumes: Task 10b `LiveSession.leafId()`, Task 17b `name`, `nameOf`.
- Produces:
  - `loadPiWriter(): Promise<PiWriter>` (memoized `import()`, R108); `PiWriter { fork(sourceFile, entryId): { file: string | null; piSessionId: string | null; text: string }; clone(sourceFile, leafId: string | null, name: string | null): { file: string; piSessionId: string } }`; `ForkRefusal` errors `"not_a_user_message" | "empty" | "unreadable"`.
  - `cloneName(sourceTitle: string | null): string | null` — the title on one line, an earlier " · xxxx" suffix dropped, cut to 40 code points (ellipsis, never half a surrogate pair), then " · " + 4 random lowercase hex digits; `null` when the source has no title.
  - Methods: `sessions.fork { sessionId, entryId: string(1..128) } → { sessionId: string; text: string }`; `sessions.clone { sessionId } → { sessionId: string }`; both `sessions:operate`, mutations, errors `not_found`, `bad_request` (fork of a non-user entry), `session_empty`.
  - New rows: own pap id, `piPath`/`piSessionId` of the new file (checked with `isPiSessionFile`, else the file is deleted and `internal` is logged and thrown), the source's cwd, `name` (clone) — inserted cold; no worker starts.

- [ ] **Step 1: Write the failing tests**

`pi-writer.test.ts` (real SDK; temp `PI_CODING_AGENT_DIR`-like folder removed in `afterEach`; files written with `sessionFileText` from `testing/pi-file-writers.ts`):

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

it("refuses a source in an older format or empty, and leaves its bytes as they were (M2-RT-16)", async () => {
  const writer = await loadPiWriter();
  const old = join(dir, "old.jsonl");
  const text = sessionFileText("pi-old", [["q0", "r0"]]).replace('"version":3', '"version":2');
  writeFileSync(old, text);
  expect(() => writer.clone(old, null, null)).toThrow(expect.objectContaining({ refusal: "unreadable" }));
  expect(() => writer.fork(old, "u0")).toThrow(expect.objectContaining({ refusal: "unreadable" }));
  expect(readFileSync(old, "utf8")).toBe(text);
  const empty = join(dir, "empty.jsonl");
  writeFileSync(empty, "");
  expect(() => writer.clone(empty, null, null)).toThrow(expect.objectContaining({ refusal: "unreadable" }));
  expect(readFileSync(empty, "utf8")).toBe("");
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
import { closeSync, openSync, readSync, statSync } from "node:fs";
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

type Sdk = { SessionManager: typeof PiSessionManager; CURRENT_SESSION_VERSION: number };

const HEAD_BYTES = 64 * 1024;

/**
 * `SessionManager.open()` rewrites, in place, a file that is empty or older than the current format (`_rewriteFile`
 * truncates it): never let it near such a source, which a worker may be appending to (M2-RT-16, ADR 0009).
 */
function checkSource(file: string, current: number): void {
  let head: Buffer;
  try {
    if (statSync(file).size === 0) throw new ForkRefusal("unreadable");
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      head = buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof ForkRefusal) throw error;
    throw new ForkRefusal("unreadable");
  }
  const end = head.indexOf(0x0a);
  let version: unknown;
  try {
    const header = JSON.parse(head.toString("utf8", 0, end === -1 ? head.length : end)) as { type?: unknown; version?: unknown };
    version = header.type === "session" ? header.version : undefined;
  } catch {
    version = undefined;
  }
  if (typeof version !== "number" || version < current) throw new ForkRefusal("unreadable");
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block) => ((block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [])).join("\n") : "";

// Pi writes a file only once a user or assistant message exists (S1): a branch without one is not worth a file.
const hasMessage = (manager: PiSessionManager, leafId: string): boolean =>
  manager.getBranch(leafId).some((entry) => entry.type === "message" && ["user", "assistant"].includes((entry.message as { role?: string }).role ?? ""));

function createPiWriter(sdk: Sdk): PiWriter {
  // A fresh manager per call: createBranchedSession() repoints the instance it runs on (pi-web's note).
  const open = (file: string): PiSessionManager => {
    checkSource(file, sdk.CURRENT_SESSION_VERSION);
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

If `createBranchedSession` turns out not to write the file before a later append (the test reads it at once), call the SDK's flush the way pi-web's `persistSessionFile()` documents, and keep the test (only implementation can tell; the test is binding). `forks.ts`'s `cloneName` cuts through `nameOf` (Task 17b) before the suffix. `forks.ts`: `cloneName` and `createForks(deps: { store; newId; clock; agentDir; loadWriter; live; logger })` with `fork(row, entryId)` and `clone(row, session)`: the source file is `row.piPath` (a draft has none → `session_empty`), the clone's leaf is `session?.leafId()` (the writer falls back to the file's last entry when that entry is not on disk yet, which is how a clone mid-run copies the finished prefix); the result file must pass `isPiSessionFile(agentDir, file)` (else `rmSync(file, { force: true })`, log `fork_file_refused`, `PapError("internal")`); `ForkRefusal` maps to `bad_request` / `session_empty` / `internal`. The new row is inserted with `store.insert({ id, piPath, piSessionId, cwd: row.cwd, ownerId: row.ownerId, name, createdAt: now, updatedAt: now })`.

`docs/adr/0009-daemon-side-fork-and-clone.md`:

```markdown
# ADR 0009 — forks and clones are written by the daemon, as new files only

Status: accepted · Date: 2026-10-11 · Spec: C §3.1 ("Pi owns its files; pap reads them in place and never copies
them"), §2.3 (`fork` / `clone` listed as worker records)

## Context
A fork (a new session from before a user message) and a clone (a copy of the active branch) must work while the
source session runs, and for a cold session without starting its worker. Pi's `SessionManager` opens a file and
writes a branched copy (`createBranchedSession`) without an agent runtime; pi-web does the same.

## Decision
The daemon loads the SDK lazily (R108) and, per request, opens the source with a fresh `SessionManager` and calls
`createBranchedSession(...)`, which writes a **new** file under the agent directory; the source is never written.
Before `open()`, the daemon reads the source's first line and refuses (`unreadable`) a file that is empty, unreadable
or older than `CURRENT_SESSION_VERSION`: `open()` rewrites such a file in place, which would race a worker appending
to it. The new file must pass `isPiSessionFile`, else it is deleted. The new session row is inserted cold.

## Consequences
- Fork and clone work mid-run; a clone copies the branch as written on disk (the turn in flight is not in it).
- Pi's `session_before_fork` hooks do not run (no extension runtime in the daemon), as in pi-web.
- A session in an older file format is forked or cloned only after its own worker opened (and migrated) it once.
- This is the one place pap writes a Pi file, and it only ever creates one.
```

- [ ] **Step 4: Write the integration test**

`sessions.forks.int.test.ts` (int bed): after two exchanges, `sessions.fork({ entryId: <second user entry> })` returns `text: "q1"`; prompting the new session with the scripted model starts its worker on the forked file and its snapshot rows are `user q0, assistant r0, user <new prompt>, assistant …`; the source's snapshot is unchanged. `sessions.clone` of the source lists a cold session whose snapshot has the source's four rows.

- [ ] **Step 5: Run and commit**

Run: `pnpm test:unit && pnpm test:int apps/daemon/src/modules/sessions`
Expected: PASS.

```bash
git add packages/contracts apps/daemon/src/modules/sessions docs/adr/0009-daemon-side-fork-and-clone.md
git commit -m "feat(sessions): fork before a message and clone a branch into new sessions"
```

---

### Task 20: Idle release after 30 minutes (spec C §2.1)

**Rulings (pre-dispatch):**
- **M2R107** [20] "Background work" (spec C §2.1) = a run open, a dialog or panel open, Pi's queue not empty, a prompt or command in flight, a compaction, or **processes the agent started that still run**: pi-host counts, in every `health` record, its live descendants outside its own process group (Pi's bash tool starts each command in a group of its own; helpers the worker runs in its group, such as MCP servers, do not count) (M2-RT-14); a worker with only such processes left is released anyway 8 h after its last activity (owner R2-2) — a dev server survives a long test session in the browser, not a week — cost if wrong: a dev server stopped after 8 h, or RAM held for 8 h.
- **M2R108** [20] What re-arms the idle timer: client commands (prompt, abort, respondDialog, panelInput, clearQueue, the session commands) and Pi run or dialog records (`pi_event`, a dialog `extension_ui_request`, `approval_request`, `custom_render`); never `health`, `audit`, decorations or `extension_error` (M2-RT-04) — pi-host's 30 s `health` would otherwise keep every worker for ever, and so would a clock in the status bar — cost if wrong: workers never released and `capacity` refusals early.
- **M2R109** [20] What an extension does on its own timers is invisible and does not keep the worker — not observable — cost if wrong: a rare surprise.
- **M2R110** [20] A navigation nobody continued is lost at release (ADR 0007; owner M2-Q11) — the leaf lives in Pi's memory — cost if wrong: a lost "Edit from here" position.
- **M2R111** [20] A requested stop (release, daemon stop) shows `cold` with no cause, except `oom`, which keeps its cause — not an error — cost if wrong: none.
- **M2R112** [12, 20] While a session is releasing, `clearQueue` answers empty lists and `abort` answers ok without asking the closing worker (a quiet session has an empty queue and no run) (M2-RT-39) — a closing pi-host drops requests, so Stop would wait for the exit and show `worker_failed` — cost if wrong: Stop showing an error during a release.

**Files:**
- Create: `apps/daemon/src/modules/sessions/idle-release.ts`, `idle-release.test.ts`, `sessions.release.int.test.ts`
- Modify: `packages/contracts/src/pi-host.ts` (`health.descendants`, default 0), `pi-host.test.ts`, `packages/pi-host/src/{host,descendants}.ts`, `descendants.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{live-session,live-run,service,index}.ts`, `live-session.run.test.ts`, `service.test.ts`, `testing/{live-bed,service-bed,int-bed}.ts` (options `idleMs`, `holdShutdown`; the int bed gains `workerIdleMs`); `live-run.ts` exposes `promptsInFlight()`

**Interfaces:**
- Consumes: Task 4 `session_shutdown` on shutdown and the descendant walk, Task 6 `Config.workerIdleMs`, Tasks 12/16/17a queue, panels, `commandsInFlight`.
- Produces:
  - pi-host: `countAgentProcesses(env?): number` (live descendants outside the worker's group; 0 off Linux; never throws); `health { rssMb, descendants }` every 30 s.
  - `createIdleRelease({ clock, idleMs, backgroundMs?, state(): "busy" | "background" | "quiet", release(): void }): { touch(): void; stop(): void }`, `BACKGROUND_RELEASE_MS = 8 h` — `idleMs <= 0` disables it; `touch()` records the activity and (re)arms the timer; at expiry a quiet session is released, a `background` one too once `backgroundMs` passed since the last touch, a busy one is re-armed.
  - `LiveSession`: touches per M2R108; `state()` per M2R107; `release()` publishes `{status: "releasing"}`, then stops the worker (the shutdown record; pi-host emits `session_shutdown`), and the exit publishes `{status: "cold"}` with no `cause` (also for `stop()` from `shutdownAll`); `exited(): Promise<void>`.
  - Service: `ensureLive()` on a session that is `releasing` waits for its exit, then launches a new worker on the same Pi file; a prompt never reaches a worker that is stopping; `clearQueue` / `abort` per M2R112.
  - `SessionsModuleDeps.config.workerIdleMs`.

- [ ] **Step 1: Write the failing tests**

`idle-release.test.ts`:

```ts
it("releases a quiet session after idleMs, and re-arms on activity or when busy", async () => {
  const clock = createFakeClock();
  let quiet = true;
  const released: number[] = [];
  const idle = createIdleRelease({ clock, idleMs: 1000, state: () => (quiet ? "quiet" : "busy"), release: () => void released.push(clock.now()) });
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
  const idle = createIdleRelease({ clock, idleMs: 0, state: () => "quiet", release: () => { throw new Error("released"); } });
  idle.touch();
  expect(clock.pending()).toBe(0);
});

it("keeps a worker whose agent left processes running, and releases it anyway 8 h after its last activity (owner R2-2)", async () => {
  const clock = createFakeClock();
  const released: number[] = [];
  const idle = createIdleRelease({ clock, idleMs: 30 * 60_000, state: () => "background", release: () => void released.push(clock.now()) });
  idle.touch();
  await clock.advance(BACKGROUND_RELEASE_MS - 1);
  expect(released).toEqual([]);
  await clock.advance(1);
  expect(released).toEqual([BACKGROUND_RELEASE_MS]);
});
```

`live-session.run.test.ts` (live bed with `idleMs`):

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

it("releases after 30 idle minutes although the worker reports its health every 30 s (M2-RT-04)", async () => {
  const { clock, worker } = setup({ idleMs: 30 * 60_000 });
  for (let at = 0; at < 30 * 60_000; at += 30_000) {
    worker.emit({ type: "health", rssMb: 80, descendants: 0 });
    await clock.advance(30_000);
  }
  expect(worker.sent.at(-1)).toMatchObject({ type: "shutdown" });
});

it("keeps a worker whose agent left a process running (M2-RT-14)", async () => {
  const { clock, worker } = setup({ idleMs: 1000 });
  worker.emit({ type: "health", rssMb: 80, descendants: 1 });
  await clock.advance(5000);
  expect(worker.stopped()).toBe(false);
});
```

`service.test.ts`:

```ts
it("a prompt during releasing waits for the exit and reopens on the same file (Review Focus 5)", async () => {
  open({ idleMs: 1000, holdShutdown: true });
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
});
```

And:

```ts
it("answers Stop at once while a worker is released (M2-RT-39)", async () => {
  open({ idleMs: 1000, holdShutdown: true });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  await bed.clock.advance(1000);
  expect(bed.service.list(OWNER)[0]?.status).toBe("releasing");
  expect(await bed.service.clearQueue(sessionId, OWNER)).toEqual({ steering: [], followUp: [], truncated: false });
  await bed.service.abort(sessionId, OWNER);
  expect(bed.spawned[0]?.requests.map((request) => request.type)).toEqual([]);
});
```

`descendants.test.ts`:

```ts
it("counts the processes the agent started, not the worker's own helpers (M2-RT-14)", () => {
  const table = [
    { pid: 10, ppid: 1, pgrp: 10 },
    { pid: 11, ppid: 10, pgrp: 10 },
    { pid: 12, ppid: 10, pgrp: 12 },
    { pid: 13, ppid: 12, pgrp: 12 },
  ];
  expect(countAgentProcesses({ platform: "linux", pid: 10, readTable: () => table })).toBe(2);
  expect(countAgentProcesses({ platform: "darwin", pid: 10, readTable: () => table })).toBe(0);
});
```

(The beds gain `idleMs` and, for the service bed, `holdShutdown`: the fake worker records the shutdown but exits only when the test crashes it, as a real worker in its grace would. `pi-host.test.ts`: a `health` record without `descendants` parses with 0.)

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

/** A worker whose only work left is processes its agent started is released anyway after this (owner R2-2). */
export const BACKGROUND_RELEASE_MS = 8 * 60 * 60_000;

/** `busy`: something a user waits on; `background`: only processes the agent left running; `quiet`: nothing. */
export type IdleState = "busy" | "background" | "quiet";

/** spec C §2.1: a worker idle for `idleMs` with nothing pending is released; its session goes cold, not away. */
export function createIdleRelease(deps: {
  clock: Clock;
  idleMs: number;
  backgroundMs?: number;
  state(): IdleState;
  release(): void;
}): IdleRelease {
  let timer: TimerHandle | null = null;
  let stopped = false;
  let lastActivity = deps.clock.now();
  const arm = (): void => {
    if (stopped || deps.idleMs <= 0) return;
    if (timer) deps.clock.clearTimeout(timer);
    timer = deps.clock.setTimeout(() => {
      timer = null;
      const state = deps.state();
      const waited = deps.clock.now() - lastActivity;
      if (state === "quiet" || (state === "background" && waited >= (deps.backgroundMs ?? BACKGROUND_RELEASE_MS))) deps.release();
      else arm();
    }, deps.idleMs);
  };
  return {
    touch() {
      lastActivity = deps.clock.now();
      arm();
    },
    stop() {
      stopped = true;
      if (timer) deps.clock.clearTimeout(timer);
      timer = null;
    },
  };
}
```

`live-session.ts`: `let requestedStop = false;`, `let agentProcesses = 0;` (from each `health` record); `idle = createIdleRelease({ clock, idleMs, state, release })`; `idle.touch()` at `ready`, at the start of every command method, and in `onRecord` only for `pi_event`, a dialog `extension_ui_request` (not a decoration), `approval_request` and `custom_render` (M2R108); `release()` sets `requestedStop = true`, publishes `releasing`, `idle.stop()`, and `handle.stop().catch((error: unknown) => logger.warn("worker_stop_failed", { err: error }))` (it always resolves); `stop()` sets `requestedStop` too; the exit handler calls `idle.stop()` and publishes `setStatus("cold", requestedStop && exit.cause !== "oom" ? undefined : describeExit(exit))`. `state()`:

```ts
  const state = (): IdleState => {
    const busy = status !== "idle" || run.tracker.running || ui.dialogs().length > 0 || panels.list().length > 0 || queue.view().count > 0 || run.promptsInFlight() > 0 || commands.inFlight() > 0 || commands.activity().compacting;
    return busy ? "busy" : agentProcesses > 0 ? "background" : "quiet";
  };
```

pi-host: `descendants.ts` gains `countAgentProcesses(env)` — on Linux, the descendants of the worker whose process group is not the worker's own (`descendantsOf(table, pid).filter((entry) => entry.pgrp !== pid).length`), 0 elsewhere or when the worker does not lead its group; a failed read writes one stderr line and returns 0. `host.ts`'s health becomes `ipc.send({ type: "health", rssMb: …, descendants: countAgentProcesses() })`. `HealthRecord` gains `descendants: z.number().int().nonnegative().default(0)`.

`service.ts` `clearQueue` / `abort` (M2R112):

```ts
    async clearQueue(sessionId, caller) {
      owned(sessionId, caller);
      const session = live.get(sessionId);
      // A worker being released has an empty queue and drops requests: nothing to ask it (M2-RT-39).
      if (!session || session.status() === "releasing") return { steering: [], followUp: [], truncated: false };
      return session.clearQueue();
    },
    async abort(sessionId, caller) {
      owned(sessionId, caller);
      const session = live.get(sessionId);
      if (!session || session.status() === "releasing") return;
      await session.abort();
    },
```

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

`testing/int-bed.ts` gains the option `workerIdleMs` (default 30 minutes) and passes it in `config` now that the module's `Pick<Config, …>` has it. `sessions.release.int.test.ts` (int bed with `workerIdleMs: 1500` and the shutdown-probe extension of Task 4; pi-host's first `health` comes at `ready`, the next after 30 s, so this run sees how `health` is ignored by the timer):

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
git add packages/contracts packages/pi-host/src apps/daemon/src/modules/sessions
git commit -m "feat(sessions): release idle workers after 30 minutes, keeping those whose agent left processes running"
```

---
### Task 21: D18 end to end — every extension UI surface against the real pi-host

The exit criterion "pi-web D18 behaviours reproduced with scripted-provider integration tests". Each case drives a fixture extension (plain `.js` in the temp agent directory) through the sessions module and the real worker, and checks what a client would receive.

**Rulings (pre-dispatch):**
- **M2R113** [21] No new decision: a defect one case shows in Tasks 13a–17b is fixed in this task with a regression test, and the report names the task it belongs to; extension notices are asserted with `source: "extension"` (owner R2-8) — only implementation can find such a defect — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/modules/sessions/testing/extensions.ts` (fixture sources: `ASK_ALL`, `STATUS_BAR`, `WIDGETS`, `PICKER`, `EDITOR_TEXT`, `shutdownProbe(path)`; Task 15's pi-host copy of `PICKER` imports nothing from here — each package keeps its own fixtures), `apps/daemon/src/modules/sessions/sessions.d18.int.test.ts`

**Interfaces:**
- Consumes: Tasks 13a–17b and 20; `createIntBed`.
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
      await sub.waitFor((e) => e.kind === "notice" && e.text === "answers:b|typed|edited|true" && e.source === "extension");
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

**Rulings (pre-dispatch):**
- **M2R114** [22] The OOM cases run where a lingering user manager answers, are skipped with a printed reason elsewhere and fail in CI without one (M2R31); they pass `memorySwapMaxMb: 0` (M2R27) and cover the worker's own OOM (`cold`, "ran out of memory") and a command's (the session stays and settles `idle`) (owner R2-1, M2-RT-02) — containment must be pinned where it can run, both ways an OOM happens — cost if wrong: CI blind to containment.
- **M2R115** [22] The hang case asserts the worker's exit is `clean` and the stop takes under 2 000 ms: `closeSession` gives up on the hook at the 1 500 ms grace and exits 0, while the ladder's SIGTERM would only come at 2 000 ms (M2-RT-32) — the former 8 s bound passed even with a broken deadline — cost if wrong: a test that cannot fail.

**Files:**
- Create: `apps/daemon/src/modules/sessions/sessions.crash.int.test.ts`, `testing/real-scopes.ts` (`scopesAvailable`, `realScopes(limits)`: Task 5's probe on a home path of the test's own, `/nonexistent/pap-int-scopes-<pid>`, so its slice is never the owner's); extend `testing/extensions.ts` with `THROWER`, `KILLER`, `FLOOD`, `HANGER`, `HOG`

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

  it("stops a worker whose extension never finishes session_shutdown, cleanly, within its grace (M2-RT-32)", async () => {
    const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions: { hanger: HANGER } });
    try {
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const started = performance.now();
      await bed.sessions.shutdownAll();
      // closeSession gives up on the hook at the 1.5 s grace and exits 0; the ladder's SIGTERM would come at 2 s.
      expect(performance.now() - started).toBeLessThan(2000);
      expect(bed.exits.map((exit) => [exit.sessionId, exit.exit.cause])).toEqual([[sessionId, "clean"]]);
    } finally {
      await bed.dispose();
    }
  });

  it.skipIf(!scopesAvailable)("keeps the session when the scope's limit kills a command the agent ran (owner R2-1)", async () => {
    const scopes = await realScopes({ memoryMaxMb: 256, tasksMax: 512, memorySwapMaxMb: 0 });
    const hog = `node -e "const k=[];setInterval(()=>{if(k.length>=64)process.exit(3);k.push(Buffer.alloc(16*1024*1024,1))},10)"`;
    const bed = await createIntBed({ steps: [{ toolCalls: [{ name: "bash", args: { command: hog }, id: "c1" }] }, { text: "the command was killed" }] }, { scopes });
    try {
      const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
      const sub = await bed.subscribe(sessionId);
      void bed.rpc["sessions.prompt"]({ sessionId, text: "run it" }, bed.ctx);
      const card = await sub.waitFor((e) => e.kind === "dialog_open");
      if (card.kind !== "dialog_open") throw new Error("no card");
      await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: card.dialog.id, response: { answer: "once" } }, bed.ctx);
      await sub.waitFor((e) => e.kind === "status" && e.status === "idle", 30_000);
      expect(sub.events().some((e) => e.kind === "status" && e.status === "cold")).toBe(false);
    } finally {
      await bed.dispose();
    }
  });

  it.skipIf(!scopesAvailable)("says out of memory when the worker's scope limit kills it", async () => {
    const scopes = await realScopes({ memoryMaxMb: 256, tasksMax: 512, memorySwapMaxMb: 0 });
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

(`scopesAvailable` and `realScopes(limits)` come from `testing/real-scopes.ts`, which runs the same probe as Task 5's test and throws when `CI` is set and no lingering user manager answers. The "hang" case uses wall time (`performance.now()`) because the ladder runs on the system clock in the int bed; the bound comes from the grace and ladder constants. `.catch(() => undefined)` here is test code waiting on prompts that die with their worker, which the assertions that follow cover.)

- [ ] **Step 3: Run and commit**

Run: `pnpm test:int apps/daemon/src/modules/sessions/sessions.crash.int.test.ts`
Expected: PASS (both OOM cases run on this host).

```bash
git add apps/daemon/src/modules/sessions
git commit -m "test(sessions): extensions and workers that crash, flood or hang never take the daemon down"
```

---

### Task 23: R45 revisit and the two unmeasured budgets (idle worker RSS, session-open payload)

R45: "The 1.5× headroom is unvalidated against long real sessions — revisit in M2." `scripts/check-budgets.ts` prints "session open payload: not measured in M1" and "idle worker RSS: not measured in M1" (spec C §8.2 lists both budgets).

**Rulings (pre-dispatch):**
- **M2R116** [23] `WORKER_BUDGET_MB` is about the worker process alone (its `/proc` RSS and PSS), never the scope's `MemoryMax`, which also covers the agent's commands (owner R2-1); if the long session's p95 RSS exceeds 236, the budget becomes `ceil(p95 × 1.25)` and `defaultMaxWorkers` is recomputed, and the controller confirms the number with the owner before it lands (it lowers the default worker cap) — R45 — cost if wrong: a wrong default worker cap.
- **M2R117** [23] The measurement runs on this host, by hand, not in CI: 300 turns take minutes — too slow for CI — cost if wrong: no regression guard for long sessions.

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

**Rulings (pre-dispatch):**
- **M2R118** [24] Drafts are kept per session in `localStorage` (`pap.draft.<sessionId>`, ≤ 200 000 characters) and survive a reload; drafts **and pending sends** are cleared on sign-out (`logout()` removes every `pap.draft.*` and `pap.pending.*` key) (owner R2-4) — privacy on shared devices — cost if wrong: a draft lost at sign-out.
- **M2R119** [24] A send whose outcome is unknown (`timeout`, `connection_lost`) is kept under `pap.pending.<sessionId>` (text, params, `commandId`), so "Send again" with the same `commandId` survives a reload; success or "Edit" removes it (M2-RT-35, R124) — exactly-once retry of the same intent — cost if wrong: a message lost on reload.
- **M2R120** [24] The streaming preference is per device, default `steer` (pi-web; owner M2-Q6) — a device's habit, like pi-web — cost if wrong: mild.
- **M2R121** [24, 28a] An extension's `set_editor_text` and "Edit from here" replace the composer's text (TUI parity, owner M2-Q12); the composer keeps the `editorText.seq` it saw at mount and applies only greater ones, so coming back to the screen never replays an old text over the restored draft (M2-RT-10) — TUI parity, and a remount must not overwrite what the user typed since — cost if wrong: a draft overwritten.
- **M2R122** [24] Stop issues `sessions.clearQueue` and `sessions.abort` back to back without awaiting the first (they reach the worker in that order: the daemon sends `clear_queue` at once and `abort` asks `get_state` first), then `Promise.allSettled`: what was cleared goes back into the draft and only the abort's failure is shown (M2-RT-09) — a failing `clearQueue` must never keep the run going — cost if wrong: a runaway run after Stop.
- **M2R123** [24] A send keeps the text as typed: blank text is refused and only trailing whitespace is trimmed (a pasted block keeps its first line's indentation) (M2-RT-36) — indentation is content — cost if wrong: none.
- **M2R124** [24, 27] Keyboard bindings beyond `TextField`'s submit shortcut are M3's; M2 exports `stopSession` and the send actions; the composer's wrapper (`data-composer`) moves Tab to an open custom panel when one is waiting (owner R2-7, Task 27); Send is disabled while the session compacts (M2R89) — ownership: keybindings are M3's — cost if wrong: none.

**Files:**
- Create: `apps/web/src/features/sessions/{Composer,QueueStrip}.tsx`, `composer.vm.ts`, `composer.vm.test.ts`, `Composer.test.tsx`, `apps/web/src/stores/drafts.ts`, `drafts.test.ts` (in `stores`, so the sign-out path of `features/auth` can clear them: a feature imports only its own domain)
- Modify: `apps/web/src/runtime/rpc.ts`, `rpc.test.ts`, `apps/web/src/testing/runtime-bed.ts` (records `options`, has `newCommandId`), `apps/web/src/features/sessions/SessionScreen.tsx` (layout: header, transcript, dialogs, composer), `SessionScreen.test.tsx`, `apps/web/src/features/auth/auth-api.ts` (`logout()` clears drafts and pending sends), `auth-api.test.ts`, `apps/web/src/i18n/{en,fr}.ts` (`sessions.composer.*`, `sessions.queue.*`, inside the `sessions (M2)` block)

**Interfaces:**
- Consumes: Task 12 `QueueView` and `sessions.clearQueue`; Task 16 `SessionView.editorText`; Task 17a `navigate` editor text (reaches the composer through Task 28a).
- Produces:
  - `RpcClient.call(method, params, options?: { commandId?: string })` and `RpcClient.newCommandId(): string`: a mutation sends `options.commandId` when given, a fresh one otherwise; reads ignore it.
  - `stores/drafts.ts`: `MAX_DRAFT_CHARS = 200_000`, `loadDraft(storage, sessionId)`, `saveDraft(storage, sessionId, text)` (empty → removed; storage errors such as quota are logged once with `console.warn` and otherwise ignored, the composer keeps working), `mergeRestored(submitted, current)`, `loadPending(storage, sessionId): PendingSend | null` (malformed → null and removed), `savePending(storage, sessionId, pending | null)`, `clearSessionDrafts(storage)` (every `pap.draft.*` and `pap.pending.*` key), `PendingSend { params; commandId }`.
  - `composer.vm.ts`: `Behavior = "steer" | "followUp"`, `loadBehavior(storage)` / `saveBehavior(storage, behavior)`, `planSend(text, behavior): { text: string; streamingBehavior: Behavior } | null` (blank → null; trailing whitespace trimmed only), `restoreCleared(cleared, current): string`.
  - `<Composer sessionId view onTabToPanel? />`: idle → Send; running → Steer, Follow up (the preferred one primary) and Stop; compacting → Send disabled; a send whose outcome is unknown (`timeout`, `connection_lost`) keeps the message out of the draft, stores it as pending and shows "Send again" (same `commandId` and params) and "Edit" (text back in the draft, pending forgotten); any other failure restores the text into the draft with the error; Stop per M2R122; an `editorText.seq` greater than the one seen at mount replaces the text. `<QueueStrip queue onClear />`.
  - Exported actions for M3's keybindings: `stopSession(runtime, sessionId): Promise<{ steering: string[]; followUp: string[] }>` in `composer.vm.ts`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/stores/drafts.test.ts`:

```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionDrafts, loadDraft, loadPending, MAX_DRAFT_CHARS, mergeRestored, saveDraft, savePending } from "./drafts.ts";

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

  it("keeps a pending send, refuses a malformed one, and forgets everything at sign-out (owner R2-4)", () => {
    const pending = { params: { sessionId: "s1", text: "deploy", streamingBehavior: "steer" as const }, commandId: "c-1" };
    savePending(localStorage, "s1", pending);
    expect(loadPending(localStorage, "s1")).toEqual(pending);
    localStorage.setItem("pap.pending.s2", "{not json");
    expect(loadPending(localStorage, "s2")).toBeNull();
    expect(localStorage.getItem("pap.pending.s2")).toBeNull();
    saveDraft(localStorage, "s1", "draft");
    localStorage.setItem("pap.sessions.streaming", "followUp");
    clearSessionDrafts(localStorage);
    expect([localStorage.getItem("pap.draft.s1"), localStorage.getItem("pap.pending.s1"), localStorage.getItem("pap.sessions.streaming")]).toEqual([null, null, "followUp"]);
  });
});
```

`composer.vm.test.ts`:

```ts
it("plans a send with the preferred behaviour, as typed, nothing for blank text (M2-RT-36)", () => {
  expect(planSend("  go  ", "followUp")).toEqual({ text: "  go", streamingBehavior: "followUp" });
  expect(planSend("    const x = 1;\n", "steer")).toEqual({ text: "    const x = 1;", streamingBehavior: "steer" });
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

it("keeps the restored draft when the screen comes back with an editor text it already applied (M2-RT-10)", async () => {
  await show({ status: "idle" });
  await emit({ kind: "editor_text", text: "from the extension" });
  await remount(); // unmounts and mounts SessionScreen again, without a new snapshot: the store still holds editorText
  localStorage.setItem("pap.draft.sess-1", "my new draft");
  const page = await remount();
  expect(field(page, "Message").value).toBe("my new draft");
});

it("still aborts when clearing the queue fails, and shows only the abort's failure (M2-RT-09)", async () => {
  bed.handlers["sessions.clearQueue"] = () => { throw new RpcError("timeout"); };
  const page = await show({ status: "running" });
  await click(button(page, "Stop"));
  await settle();
  expect(bed.calls.map((call) => call.method).filter((m) => m !== "subscribe.session")).toEqual(["sessions.clearQueue", "sessions.abort"]);
  expect(alerts(page)).toEqual([]);
  bed.handlers["sessions.abort"] = () => { throw new RpcError("worker_failed"); };
  await click(button(page, "Stop"));
  await settle();
  expect(alerts(page)).toContain("The session process failed.");
});

it("keeps an outcome-unknown send across a reload, and Send again reuses its command id (M2-RT-35)", async () => {
  localStorage.setItem("pap.pending.sess-1", JSON.stringify({ params: { sessionId: "sess-1", text: "deploy", streamingBehavior: "steer" }, commandId: "c-kept" }));
  bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
  const page = await show({ status: "idle" });
  expect(text(page)).toContain("The message may have been sent.");
  await click(button(page, "Send again"));
  await settle();
  expect(bed.called("sessions.prompt")[0]?.options).toEqual({ commandId: "c-kept" });
  expect(localStorage.getItem("pap.pending.sess-1")).toBeNull();
});

it("disables Send while the session compacts (M2-RT-34)", async () => {
  const page = await show({ status: "idle", activity: { compacting: true, retry: null } });
  expect(button(page, "Send").disabled).toBe(true);
});
```

(`show(viewPatch)` emits a snapshot built from `viewPatch` and renders `<SessionScreen sessionId="sess-1" />`; `remount()` unmounts the page and mounts the screen again on the same store; `bed.called` returns entries with `options` once `runtime-bed.ts` records them. `auth-api.test.ts` gains one case: `logout()` leaves no `pap.draft.*` or `pap.pending.*` key, whether the POST succeeded or failed.)

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

/** A send whose outcome is unknown (R105): kept until it is sent again with the same command id, or edited. */
export interface PendingSend {
  readonly params: { readonly sessionId: string; readonly text: string; readonly streamingBehavior: "steer" | "followUp" };
  readonly commandId: string;
}
const pendingKeyOf = (sessionId: string) => `pap.pending.${sessionId}`;

export function loadPending(storage: Storage | null, sessionId: string): PendingSend | null {
  const read = (): PendingSend | null => {
    const raw = storage?.getItem(pendingKeyOf(sessionId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingSend> | null;
    const params = value?.params;
    if (typeof value?.commandId === "string" && params?.sessionId === sessionId && typeof params.text === "string" && (params.streamingBehavior === "steer" || params.streamingBehavior === "followUp")) {
      return { params: { sessionId, text: params.text.slice(0, MAX_DRAFT_CHARS), streamingBehavior: params.streamingBehavior }, commandId: value.commandId.slice(0, 128) };
    }
    throw new Error("malformed pending message");
  };
  try {
    return read();
  } catch (error) {
    console.warn("pap: a pending message could not be read and was dropped", error);
    savePending(storage, sessionId, null);
    return null;
  }
}

export function savePending(storage: Storage | null, sessionId: string, pending: PendingSend | null): void {
  try {
    if (pending === null) storage?.removeItem(pendingKeyOf(sessionId));
    else storage?.setItem(pendingKeyOf(sessionId), JSON.stringify(pending));
  } catch (error) {
    if (!warned) console.warn("pap: drafts cannot be saved in this browser", error);
    warned = true;
  }
}

/** Sign-out (owner R2-4): no draft or pending message stays on a shared device. The streaming preference stays. */
export function clearSessionDrafts(storage: Storage | null): void {
  try {
    const keys = Array.from({ length: storage?.length ?? 0 }, (_, index) => storage?.key(index) ?? "");
    for (const key of keys) if (key.startsWith("pap.draft.") || key.startsWith("pap.pending.")) storage?.removeItem(key);
  } catch (error) {
    console.warn("pap: drafts could not be cleared", error);
  }
}
```

`features/auth/auth-api.ts`'s `logout()` calls `clearSessionDrafts(localStorage)` in a `finally`, after the POST, whatever it answered.

`composer.vm.ts`:

```ts
import type { Runtime } from "../../runtime/index.ts";
import { mergeRestored } from "../../stores/drafts.ts";

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

/**
 * Pi ignores the streaming behaviour when it is idle (pinned in Task 12), so it is always sent. The text goes as typed:
 * only trailing whitespace is trimmed, so a pasted block keeps its first line's indentation (M2-RT-36).
 */
export function planSend(text: string, behavior: Behavior): { text: string; streamingBehavior: Behavior } | null {
  const typed = text.trimEnd();
  return typed.trim() ? { text: typed, streamingBehavior: behavior } : null;
}

export function restoreCleared(cleared: { steering: readonly string[]; followUp: readonly string[] }, current: string): string {
  return mergeRestored([...cleared.steering, ...cleared.followUp].join("\n\n"), current);
}

/**
 * Stop as the pi TUI's Esc: what waits in the queue comes back to the composer, and the run stops. Both calls leave
 * at once and reach the worker in order (the daemon sends `clear_queue` at once; `abort` asks `get_state` first): a
 * `clearQueue` that fails or times out must never keep the run going (M2-RT-09). Only the abort's failure is thrown.
 */
export async function stopSession(runtime: Runtime, sessionId: string): Promise<{ steering: string[]; followUp: string[] }> {
  const [cleared, aborted] = await Promise.allSettled([
    runtime.rpc.call("sessions.clearQueue", { sessionId }),
    runtime.rpc.call("sessions.abort", { sessionId }),
  ]);
  if (aborted.status === "rejected") throw aborted.reason;
  return cleared.status === "fulfilled" ? cleared.value : { steering: [], followUp: [] };
}
```

`Composer.tsx`: state `text` (initialised from `loadDraft(localStorage, sessionId)`), `behavior` (from `loadBehavior`), `pending: PendingSend | null` (initialised from `loadPending`, kept in step with `savePending`), `error: string | null`, and `seenSeq` (initialised once, with a lazy `useState`, from `view.editorText?.seq ?? 0`); every text change goes through `setText` + `saveDraft`. `send(behaviorOverride?)`: `planSend` → `commandId = runtime.rpc.newCommandId()` → clear text and draft → `runtime.rpc.call("sessions.prompt", params, { commandId })`; on failure, `outcomeUnknown(failure)` (from `failure.ts`) sets and saves `pending`, otherwise the text is merged back with `mergeRestored` and `error = failureText(failure)`. "Send again" calls with `pending.params` and `pending.commandId`, clearing `pending` (state and storage) on success; "Edit" puts the text back and clears it too. Stop calls `stopSession` and merges with `restoreCleared`; its failure shows the error and restores nothing more. An effect on `view.editorText?.seq` sets the text only when the seq is greater than `seenSeq`, then records it (M2-RT-10). Send is disabled while `view.activity.compacting`. The composer sits in a `<div data-composer>` whose `onKeyDown` calls `onTabToPanel?.()` for a plain Tab and prevents the default when it returns true (Task 27 wires it). The buttons are `@pap/ui` `Button`s; the field is `TextField` with `onSubmitShortcut={() => send()}`; the "When working" choice is two `Button`s with `aria-pressed`. `QueueStrip.tsx` renders the counts and previews (steering in `text-human-text`, follow-ups in `text-muted`) and a Clear button that calls `clearQueue` and hands the texts to the composer through a prop. `SessionScreen.tsx` becomes a layout: header, the M1 transcript list (until Task 25), the dialogs (until Task 26), then `<Composer>`.

i18n (`sessions.*` block): `composer.send` "Send", `composer.steer` "Steer", `composer.followUp` "Follow up", `composer.stop` "Stop", `composer.whenWorking` "While the agent works", `composer.mayHaveBeenSent` "The message may have been sent.", `composer.sendAgain` "Send again", `composer.edit` "Edit", `queue.title` "Waiting · {count}", `queue.clear` "Clear", `queue.steer` "Steer", `queue.followUp` "Follow-up"; fr: "Envoyer", "Orienter", "À la suite", "Arrêter", "Pendant que l'agent travaille", "Le message a peut-être été envoyé.", "Renvoyer", "Modifier", "En attente · {count}", "Vider", "Orientation", "À la suite". (Task 1a's placeholder `sessions.queue.title` becomes this key.)

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

**Rulings (pre-dispatch):**
- **M2R125** [25] Plain text only; thinking and summaries use native `<details>`; no virtualization (owner M2-Q9: M4 or M13); markdown and code highlighting are M3's new task (owner R3-1), tool-specific renderers M6's `DiffView`; the transcript renders the loaded rows only (75 + the pages the user asked for) — no new dependency, no overlap with M3 — cost if wrong: long sessions heavy in the DOM.
- **M2R126** [25] Tool items are keyed `${assistant row's entry id ?? its message key}:${toolCallId}#${occurrence within that message}`; a result pairs with the nearest preceding unmatched call of the same id; the live `view.tools` status applies only to the newest unmatched call of an id (M2-RT-11) — providers reuse ids (`call_0` every turn), so ids are not unique in Pi's data — cost if wrong: merged rows and results paired with the wrong call.
- **M2R127** [25] "Load older" captures `view.generation` and `view.history.oldestEntryId` when it asks, and the store drops a page asked for another view (M2R55, M2-RT-12); one request at a time — stale responses are dropped, one request at a time keeps the cursor simple — cost if wrong: rows of an abandoned branch above the new one.

**Files:**
- Create: `apps/web/src/features/sessions/{Transcript,MessageRow,ToolRow}.tsx`, `Transcript.test.tsx`, `ToolRow.test.tsx`
- Modify: `apps/web/src/features/sessions/transcript.vm.ts`, `transcript.vm.test.ts`, `use-stick-to-bottom.ts`, `SessionScreen.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Tasks 9a–11 and 17a view fields (`messages`, `partial`, `tools`, `history`, `activity`), `sessions.history`, `sessions.toolOutput`, `prependHistory`.
- Produces:
  - `transcriptItems(view): TranscriptItem[]` with kinds `message` (`author`, `text`, `thinking`, `entryId`), `tool` (`toolCallId`, `name`, `summary`, `status: "running" | "done" | "failed" | "waiting"`, `preview`, `truncatedChars`, `argsTruncated`), `summary` (`compaction` with `tokensBefore`, or `branch`), `failure`, `partial` (text and thinking blocks), each with a `key` unique by construction (a message's entry id or its M1 ref with counter; a tool's `${owner}:${toolCallId}#${occurrence}`, M2R126).
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
  expect(transcriptItems(view).map((item) => [item.kind, item.key])).toEqual([["message", "a1"], ["tool", "a1:c1#0"], ["tool", "a2:c2#0"]]);
  expect(transcriptItems(view)[1]).toMatchObject({ name: "read", summary: '{"path":"a.txt"}', status: "done", truncatedChars: 30000 });
  expect(transcriptItems(view)[2]).toMatchObject({ status: "running", preview: "building…" });
});

it("keeps two calls that reuse one id apart, each with its own result and status (M2-RT-11)", () => {
  const view = viewWith({
    messages: [
      message({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "echo one" } }] }, "a1"),
      message({ role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "one" }] }, "t1"),
      message({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "echo two" } }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "echo three" } }] }, "a2"),
      message({ role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "two" }], isError: true }, "t2"),
    ],
    tools: { c: { name: "bash", status: "running", preview: "three…" } },
  });
  const tools = transcriptItems(view).filter((item) => item.kind === "tool");
  expect(tools.map((item) => [item.key, item.summary, item.status, item.preview])).toEqual([
    ["a1:c#0", "echo one", "done", "one"],
    ["a2:c#0", "echo two", "failed", "two"],
    ["a2:c#1", "echo three", "running", "three…"],
  ]);
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

it("drops a page that lands after the view moved to another branch (M2-RT-12)", async () => {
  let answer: (page: unknown) => void = () => {};
  bed.handlers["sessions.history"] = () => new Promise((resolve) => { answer = resolve; });
  const page = await show({ rows: [row("e5", "newest")], history: { hasMore: true, oldestEntryId: "e5", turnsBefore: 2 } });
  await click(button(page, "Load older messages"));
  // "Edit from here" or the branch switcher: a snapshot of another branch arrives first.
  await emit(snapshotOf({ rows: [row("e9", "other branch")], history: { hasMore: true, oldestEntryId: "e9", turnsBefore: 2 } }));
  answer({ rows: [row("e1", "older question")], hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
  await settle();
  expect(text(page)).toContain("other branch");
  expect(text(page)).not.toContain("older question");
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

`transcript.vm.ts` builds the items from `view.messages` in order: a `user`/`assistant` message gives a `message` item (assistant `thinking` from its thinking blocks) followed by one `tool` item per tool call (`key` = `${message.entryId ?? message.key}:${call id}#${how many calls with that id came before it in the same message}`; `summary` = the `command` argument for a shell call, else the arguments' JSON cut to 200 characters); a `toolResult` message gives no item of its own: it fills the nearest preceding call of the same id that has no result yet (`preview` from its text, `truncatedChars`, `failed` when `isError`, else `done`); a call left without a result takes `view.tools[id]`'s live status only when it is the newest such call of that id, else `waiting` (M2-RT-11); `compactionSummary` / `branchSummary` give `summary` items; an assistant error gives the M1 `failure` item; `view.partial` gives the last `partial` item. Message keys keep M1's entry-id or ref-plus-counter rule.

`Transcript.tsx` renders items through `MessageRow` (the `@pap/ui` `Message`, with a `<details>` "Thinking" block above the text when there is thinking) and `ToolRow` (a bordered block: the tool name in `font-mono text-label uppercase text-agent`, the summary, a status label, the preview in a `<pre>` capped by `max-h-64 overflow-auto`), and summaries as `<details>` with the summary text ("Conversation compacted · from {tokens} tokens"). The "Load older messages" handler keeps a `loading` flag (no second call while one is in flight), captures `{ generation: view.generation, oldestEntryId: view.history.oldestEntryId }` before it asks and hands it to `prependHistory` (a stale page is dropped, M2R127), records `scrollHeight` before `prependHistory`, and restores `scrollTop += newHeight - oldHeight` in a layout effect after the rows land. `use-stick-to-bottom.ts` gains a `preserveOnPrepend()` used by that handler.

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

**Rulings (pre-dispatch):**
- **M2R128** [26] Feature components on M1 tokens; M3's post-merge task P3 replaces `ApprovalDialog` with its `ApprovalCard` (`answers?: readonly ApprovalAnswer[]`, `labels`, `onChoose(answer)`, answer names `deny | once | session | always` as in M2's contracts; a type-level test pins `ApprovalAnswer` of `@pap/ui` ≡ the contracts'), and P2 promotes the select / input / editor shells (cross-plan agreement 6) — cross-plan agreement: one approval component in the end — cost if wrong: promotion work later.
- **M2R129** [26] Button styles: Allow once `primary`; Deny, Session, Always `secondary` (DESIGN §9.1: a refusal is never `danger`) — DESIGN.md button rules — cost if wrong: none.
- **M2R130** [26] The header is sentence case in the DOM ("Approval · exec", translated) and shown uppercase by the `uppercase` class, like M1's `ApprovalCard` (R121: selectors never depend on CSS text-transform; agreement 6) — P3 then needs no test rewrite — cost if wrong: none.
- **M2R131** [26] A dialog with a `timeout` shows "Closes on its own after N s" as static text (Pi resolves it) — Pi owns the timer — cost if wrong: a stale countdown.
- **M2R132** [26] Every fr label differs from its en one (the i18n test): `dialog.answer.session` is "Pour la session" (M2-RT-37) — the existing i18n test refuses fr equal to en — cost if wrong: a red i18n test.

**Files:**
- Create: `apps/web/src/features/sessions/dialogs/{ApprovalDialog,SelectDialog,TextDialog,ConfirmDialog,DialogList}.tsx`, `dialogs/DialogList.test.tsx`, `dialogs/ApprovalDialog.test.tsx`
- Modify: `apps/web/src/features/sessions/{SessionScreen,approval-detail}.tsx|ts`, `SessionScreen.dialogs.test.tsx` (the 13a cases follow the new components), `SessionScreen.test.tsx` (only its existing confirm cases: Yes / No instead of Allow once / Deny), `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Tasks 13a/14b `Dialog` (`approval` with `category`, `answers`), `DialogResponse.answer`.
- Produces: `<DialogList sessionId dialogs />` rendering every open dialog oldest first, each answered once (`once` from `@pap/ui`, built in the click handler like `ApprovalCard`'s), a refused answer re-arming that card (attempt counter in its key, R127); `ApprovalDialog` shows `Approval · <category>` (sentence case in the DOM, `uppercase` class), the question, the header line of the message outside the scrolling body, and only the answers the dialog offers, in DESIGN order; `SelectDialog` (one button per option, then Cancel → `{cancelled: true}`), `TextDialog` (`input` single-line with placeholder, `editor` multi-line prefilled; Submit → `{value}`, Cancel → `{cancelled: true}`), `ConfirmDialog` (Yes / No → `{confirmed}`) for an extension's confirm.

- [ ] **Step 1: Write the failing tests**

`ApprovalDialog.test.tsx`:

```ts
it("offers exactly the dialog's answers in DESIGN order and sends the one clicked, once", async () => {
  const page = await show([{ id: "a1", method: "approval", category: "exec", title: "Run a command?", message: "1 line\nbash: npm test", answers: ["deny", "session", "always", "once"] }]);
  expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Deny", "Session", "Always", "Allow once"]);
  // Sentence case in the DOM, uppercase by CSS (R121, cross-plan agreement 6).
  expect(text(page)).toContain("Approval · exec");
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

i18n (inside the `sessions (M2)` block, keys `sessions.*`): `dialog.approval` "Approval · {category}", `dialog.answer.deny` "Deny", `dialog.answer.session` "Session", `dialog.answer.always` "Always", `dialog.answer.once` "Allow once", `dialog.submit` "Submit", `dialog.cancel` "Cancel", `dialog.yes` "Yes", `dialog.no` "No", `dialog.timeout` "Closes on its own after {seconds} s", `dialog.category.read|edit|exec|network|external-write|unknown` ("read", "edit", "exec", "network", "external write", "unknown"); fr: "Approbation · {category}", "Refuser", "Pour la session" (M2-RT-37: fr must differ from en), "Toujours", "Autoriser une fois", "Valider", "Annuler", "Oui", "Non", "Se ferme seul après {seconds} s", "lecture", "modification", "exécution", "réseau", "écriture externe", "inconnu". The header is the translated label as written (sentence case) with the `uppercase` class: tests and selectors read the DOM text, never the rendered case (R121, M2R130).

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): approval cards with four answers and extension input dialogs"
```

---

### Task 27: Web extension UI — status bar with `command:` buttons, widgets, custom panels, ANSI colours, title

References: pi-web `components/ExtensionStatusBar.tsx` (`command:/name args` keys become buttons sending the slash command, disabled while busy, only `/` commands, empty statuses get no cell, sorted by key), `ExtensionWidgets.tsx`, `ChatWindow`'s `ExtensionCustomPanel` (oldest panel shown with a count of the waiting ones, a textarea that turns keys into terminal input, IME composition, collapse) and `lib/terminal-input.ts` (the key table); DESIGN.md §9 CustomPanel ("lines in mono; takes keyboard focus; re-rendered whole on each update"), StatusBar and Widgets.

**Rulings (pre-dispatch):**
- **M2R133** [27] ANSI colours in extension text map to role tokens (owner C2): black → `--text-dim`, red → `--err`, green → `--ok`, yellow → `--you`, blue → `--agent`, magenta → `--attn`, cyan → `--agent`, white → `--text`, the bright variants the same; bold = weight 600, dim = `--text-muted`, italic and underline kept; backgrounds, inverse, 256-colour and truecolor codes ignored (the text stays). With M1's token classes until M3's post-merge task P1 renames them: `text-muted` stands for `--text-dim` (M1 has no dim token) and for dim, `text-error`, `text-ok`, `text-human`, `text-agent`, `text-attention`, `text-fg`. The text is parsed into React spans with token classes, never HTML; a step adds the rule to DESIGN.md §9.2 — the owner's mapping and DESIGN's role colours; HTML would open injection — cost if wrong: an extension's red that reads as a pap error (accepted: that is the mapping).
- **M2R134** [27] Parsing is bounded: one pass over each line, at most `MAX_SPANS = 256` spans per line (what follows is one plain span), SGR parameters read from the sequence only; before parsing, bidi and control characters other than `\t` and ESC are removed (`\p{Cf}`, `\p{Cc}`), and escape sequences other than SGR (cursor moves, OSC links, pi-tui's cursor marker) are dropped (M2-RT-42) — cap-crossing test — cost if wrong: a spoofed status (a right-to-left override) or a slow render.
- **M2R135** [27] A `command:` status button shows the command it runs next to the extension's label (mono, muted), and its accessible name includes it; no native `title` (M3's `pap/no-native-title`) (M2-RT-42) — the label is extension text, the command comes from the key — cost if wrong: a button reading "Show help" that runs `/deploy`.
- **M2R136** [27] An open panel takes focus unless the composer has it; then the panel shows "Press Tab to reach the panel", and Tab from the composer moves focus into it (owner R2-7) — keystrokes typed in the composer never land in a picker — cost if wrong: an Enter typed in the composer selecting in a panel.
- **M2R137** [27] The panel carries `data-terminal-input` and calls `stopPropagation()` on every key it consumes (Escape, Tab, arrows, Enter…), so M3's dispatcher (context key `panelFocus`) never turns Escape in a panel into Stop (cross-plan agreement 7, M2-RT-O-3) — Escape must stay terminal input inside a panel — cost if wrong: Escape in a panel stops the run.
- **M2R138** [16, 27] Extension notices and the status bar carry a visible "from an extension" label (fr "d'une extension"); pap's own notices carry none (owner R2-8) — extension text must not look like pap's — cost if wrong: a notice that passes for pap's own.
- **M2R139** [27] The title is shown in the session header, not in `document.title` (the shell's, M3) — the document title belongs to M3's shell — cost if wrong: none.

**Files:**
- Create: `apps/web/src/features/sessions/{StatusBar,Widgets,CustomPanel,AnsiText}.tsx`, `status-cells.ts`, `status-cells.test.ts`, `ansi.ts`, `ansi.test.ts`, `terminal-keys.ts`, `terminal-keys.test.ts`, `CustomPanel.test.tsx`, `StatusBar.test.tsx`
- Modify: `apps/web/src/features/sessions/{SessionScreen,Composer}.tsx` (panel focus and Tab, notice labels), `apps/web/src/i18n/{en,fr}.ts`, `DESIGN.md` (§9.2, one rule)

**Interfaces:**
- Consumes: Task 16 `statuses`, `widgets`, `title`, `panels`, notices with `source`, `sessions.panelInput`; Task 24 `data-composer` and `onTabToPanel`.
- Produces:
  - `ansi.ts`: `AnsiTone = "dim" | "error" | "ok" | "you" | "agent" | "attention" | "text"`, `AnsiSpan { text; tone: AnsiTone | null; bold; faint; italic; underline }`, `parseAnsi(text): AnsiSpan[]`, `plainText(text): string` (the spans' text joined), `MAX_SPANS = 256`. `<AnsiText text />` renders the spans with token classes.
  - `statusCells(statuses): Array<{ kind: "text"; key; text } | { kind: "command"; key; command; label }>` — sorted by key; text cells keep their ANSI (rendered with `AnsiText`), with tabs and runs of spaces collapsed and lines trimmed; a key `command:/…` with a command longer than one character becomes a button (label = its plain text, else the command); a non-`/` command stays text; an empty plain text gives no cell.
  - `terminalKeyData(event): string | null` — arrows, Home/End, Insert/Delete, PageUp/PageDown, Escape, Backspace, Enter (`\r`, Shift → `\n`), Tab / Shift+Tab, Ctrl+letter control codes, Alt+key and Alt+arrows as escape sequences; null for Meta and for Ctrl+V (paste goes through the input event).
  - `<StatusBar statuses busy onCommand />` (buttons disabled while `busy`, the "from an extension" label), `<Widgets widgets placement />`, `<CustomPanel sessionId panels />` (the oldest open panel, "N more waiting", a collapse toggle, a small labelled textarea under `data-terminal-input` that sends each key or pasted text with `sessions.panelInput`; focus per M2R136; a failed send shows the error) and `focusPanel(): boolean` for the composer's Tab.

- [ ] **Step 1: Write the failing tests**

`ansi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_SPANS, parseAnsi, plainText } from "./ansi.ts";

const plain = { tone: null, bold: false, faint: false, italic: false, underline: false };

describe("ANSI colours in extension text (owner C2)", () => {
  it.each([
    [30, "dim"], [31, "error"], [32, "ok"], [33, "you"], [34, "agent"], [35, "attention"], [36, "agent"], [37, "text"],
    [90, "dim"], [91, "error"], [92, "ok"], [93, "you"], [94, "agent"], [95, "attention"], [96, "agent"], [97, "text"],
  ])("maps SGR %i to the %s tone", (code, tone) => {
    expect(parseAnsi(`\u001b[${code}mx\u001b[39my`)).toEqual([{ ...plain, text: "x", tone }, { ...plain, text: "y" }]);
  });

  it("keeps bold, dim, italic and underline, and resets them", () => {
    expect(parseAnsi("\u001b[1;3ma\u001b[22;2mb\u001b[0;4mc")).toEqual([
      { ...plain, text: "a", bold: true, italic: true },
      { ...plain, text: "b", faint: true, italic: true },
      { ...plain, text: "c", underline: true },
    ]);
  });

  it("ignores backgrounds, inverse, 256-colour and truecolor, and keeps the text", () => {
    expect(parseAnsi("\u001b[31mred\u001b[38;5;196m still red\u001b[48;2;1;2;3m\u001b[7m\u001b[44m!")).toEqual([
      { ...plain, text: "red", tone: "error" },
      { ...plain, text: " still red", tone: "error" },
      { ...plain, text: "!", tone: "error" },
    ]);
  });

  it("drops other escapes, bidi and control characters, keeps tabs (M2-RT-42)", () => {
    expect(plainText("\u001b]8;;https://x\u0007link\u001b]8;;\u0007 \u001b_pi:c\u0007\u001b[2K→ ✓‮\u0007\tend")).toBe("link → ✓\tend");
  });

  it("caps the spans of one line; what follows is one plain span with all its text", () => {
    const line = Array.from({ length: 300 }, (_, i) => `\u001b[3${i % 8}m${i % 10}`).join("");
    const spans = parseAnsi(line);
    expect(spans).toHaveLength(MAX_SPANS);
    expect(spans.at(-1)).toMatchObject({ tone: null, bold: false });
    expect(spans.map((span) => span.text).join("")).toBe(plainText(line));
    expect(plainText(line)).toHaveLength(300);
  });
});
```

`status-cells.test.ts`:

```ts
it("turns command keys into buttons, keeps text statuses with their colours, drops empty ones, in key order", () => {
  expect(statusCells([
    { key: "z-git", text: "main\t\tdirty" },
    { key: "y-ci", text: "\u001b[31mfailing\u001b[0m" },
    { key: "command:/mode build", text: "\u001b[32mBuild\u001b[0m" },
    { key: "command:x", text: "not a slash command" },
    { key: "empty", text: "\u001b[0m  " },
    { key: "command:/", text: "too short" },
  ])).toEqual([
    { kind: "command", key: "command:/mode build", command: "/mode build", label: "Build" },
    { kind: "text", key: "command:/", text: "too short" },
    { kind: "text", key: "command:x", text: "not a slash command" },
    { kind: "text", key: "y-ci", text: "\u001b[31mfailing\u001b[0m" },
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
  [{ key: "Escape" }, "\u001b"],
  [{ key: "v", ctrlKey: true }, null],
  [{ key: "a", metaKey: true }, null],
  [{ key: "a" }, null],
])("maps %j to %j", (event, expected) => {
  expect(terminalKeyData({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...event })).toBe(expected);
});
```

(Plain characters come through the textarea's `input` event, not `keydown`, so IME composition works.)

`StatusBar.test.tsx`: a command cell is a button whose text holds both "Build" and "/mode build" and that calls `onCommand("/mode build")`; while `busy` it is disabled; a text status renders as text with its red span carrying `text-error`; the bar shows "from an extension".

`CustomPanel.test.tsx` (the `getRuntime` mock of `SessionScreen.test.tsx`):

```ts
it("shows the oldest panel, counts the others, and sends keys and pasted text", async () => {
  const page = await show([{ id: "p1", lines: ["\u001b[7m> alpha\u001b[0m", "  beta"] }, { id: "p2", lines: ["other"] }]);
  expect(text(page)).toContain("> alpha");
  expect(text(page)).toContain("1 more waiting");
  const input = page.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;
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

it("keeps the keys it consumes to itself, Escape included (cross-plan agreement 7)", async () => {
  const page = await show([{ id: "p1", lines: ["> alpha"] }]);
  const heard: string[] = [];
  document.addEventListener("keydown", (event) => void heard.push(event.key));
  const input = page.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;
  await press(input, { key: "Escape" });
  await press(input, { key: "ArrowUp" });
  expect(heard).toEqual([]);
  expect(bed.called("sessions.panelInput").map((call) => (call.params as { data: string }).data)).toEqual(["\u001b", "\u001b[A"]);
});

it("leaves the focus in the composer and says how to reach the panel; Tab gets there (owner R2-7)", async () => {
  const page = await showScreen({ status: "running" });
  const composer = field(page, "Message");
  composer.focus();
  await emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
  expect(document.activeElement).toBe(composer);
  expect(text(page)).toContain("Press Tab to reach the panel");
  await press(composer, { key: "Tab" });
  expect(document.activeElement).toBe(page.querySelector("[data-terminal-input] textarea"));
});
```

(`show(panels)` renders `<CustomPanel>` alone; `showScreen(patch)` renders the whole `SessionScreen` from a snapshot, as `Composer.test.tsx` does.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ansi.ts`:

```ts
export type AnsiTone = "dim" | "error" | "ok" | "you" | "agent" | "attention" | "text";
export interface AnsiSpan {
  readonly text: string;
  readonly tone: AnsiTone | null;
  readonly bold: boolean;
  readonly faint: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}
type Style = Omit<AnsiSpan, "text">;

/** At most this many spans per line; what follows is one plain span (bounded render, M2-RT-42). */
export const MAX_SPANS = 256;
const PLAIN: Style = { tone: null, bold: false, faint: false, italic: false, underline: false };
/** SGR 30–37 and 90–97, in order: black, red, green, yellow, blue, magenta, cyan, white (owner C2, DESIGN.md §9.2). */
const TONES: readonly AnsiTone[] = ["dim", "error", "ok", "you", "agent", "attention", "agent", "text"];
// Bidi controls and control characters go first, except tab, ESC and BEL (they start or end the sequences parsed
// below); a BEL left in the text after parsing is removed with the sequences.
const UNSAFE = /[\p{Cf}\u0000-\u0006\u0008\u000a-\u001a\u001c-\u001f\u007f-\u009f]/gu;
const BEL = /\u0007/g;
// CSI (any final byte; only `m` is applied), OSC (ended by BEL or ST), pi-tui's cursor marker, other two-byte escapes.
const ESCAPES = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|_pi:c\u0007|[@-Z\\-_])/g;

function applySgr(style: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(";").map((part) => Number(part) || 0);
  let next = style;
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at] ?? 0;
    if (code === 0) next = PLAIN;
    else if (code === 1) next = { ...next, bold: true };
    else if (code === 2) next = { ...next, faint: true };
    else if (code === 3) next = { ...next, italic: true };
    else if (code === 4) next = { ...next, underline: true };
    else if (code === 22) next = { ...next, bold: false, faint: false };
    else if (code === 23) next = { ...next, italic: false };
    else if (code === 24) next = { ...next, underline: false };
    else if (code >= 30 && code <= 37) next = { ...next, tone: TONES[code - 30] ?? null };
    else if (code >= 90 && code <= 97) next = { ...next, tone: TONES[code - 90] ?? null };
    else if (code === 39) next = { ...next, tone: null };
    // 256-colour and truecolor carry their own arguments: skipped, the colour ignored (owner C2).
    else if (code === 38 || code === 48) at += codes[at + 1] === 5 ? 2 : codes[at + 1] === 2 ? 4 : 0;
    // Backgrounds (40–47, 100–107), inverse (7, 27) and the rest: ignored.
  }
  return next;
}

export function parseAnsi(raw: string): AnsiSpan[] {
  const text = raw.replace(UNSAFE, "");
  const spans: AnsiSpan[] = [];
  let style = PLAIN;
  let last = 0;
  let capped = false;
  for (const match of text.matchAll(ESCAPES)) {
    const chunk = text.slice(last, match.index).replace(BEL, "");
    if (chunk) {
      if (spans.length === MAX_SPANS - 1) {
        capped = true;
        break;
      }
      spans.push({ text: chunk, ...style });
    }
    last = match.index + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
  }
  const rest = text.slice(last).replace(ESCAPES, "").replace(BEL, "");
  if (rest) spans.push({ text: rest, ...(capped ? PLAIN : style) });
  return spans;
}

export const plainText = (raw: string): string => parseAnsi(raw).map((span) => span.text).join("");
```

`AnsiText.tsx` renders `parseAnsi(text)` as `<span>`s (keys: the span's index in this line, a list rebuilt whole on each render) with classes from one table — `dim: "text-muted"` (M1 has no `--text-dim` class; P1 changes it), `error: "text-error"`, `ok: "text-ok"`, `you: "text-human"`, `agent: "text-agent"`, `attention: "text-attention"`, `text: "text-fg"` — plus `font-semibold` for bold, `text-muted` for faint, `italic`, `underline`. Never `dangerouslySetInnerHTML`. `terminal-keys.ts` holds the key table of the interface line (own code, the semantics of pi-web's `lib/terminal-input.ts`). `status-cells.ts` implements the rules above (`plainText` for labels and emptiness). `StatusBar.tsx` sends a command with `sessions.prompt({ sessionId, text: command })` through the composer's send path (so its failure shows like any prompt's), is `busy` while the status is `running`, `starting` or `releasing`, starts with a small "from an extension" label, and renders a command button as the label followed by the command in `font-mono text-muted`. `Widgets.tsx` renders each widget as `AnsiText` lines (`font-mono text-ui whitespace-pre`) above or below the composer per `placement`. `CustomPanel.tsx`: a wrapper `<div data-terminal-input>` around the panel lines (`AnsiText`) and a small labelled textarea ("Panel input"); on open or expand it focuses the textarea unless `document.activeElement?.closest("[data-composer]")`, and then shows "Press Tab to reach the panel"; it ignores keys during composition, sends `terminalKeyData(event)` on `keydown` and, when it sends, calls both `preventDefault()` and `stopPropagation()`; it sends the textarea's value on `input` (then clears it); a failed `panelInput` shows `failureText`; `focusPanel()` focuses the textarea and returns whether a panel was there. `SessionScreen.tsx` puts widgets above / below the composer, the status bar under it, the panel over the transcript, passes `onTabToPanel={focusPanel}` to the composer, shows the title in the header, and shows an extension notice with the "from an extension" label before its text.

DESIGN.md §9.2, after the AI components table, a short rule (the only DESIGN.md change of M2; M3 amends §3 and §7.4, different sections):

```markdown
**ANSI colours in extension text.** Statuses, widgets and custom panels may carry ANSI SGR codes. The 8 colours and
their bright variants map to role tokens: black → `--text-dim`, red → `--err`, green → `--ok`, yellow → `--you`,
blue → `--agent`, magenta → `--attn`, cyan → `--agent`, white → `--text`. Bold is weight 600, dim is
`--text-muted`, italic and underline are kept. Backgrounds, inverse, 256-colour and truecolor codes are ignored and
their text is kept. Extension text is parsed into styled spans, never inserted as HTML, and loses bidi and control
characters first.
```

i18n (inside the `sessions (M2)` block): `panel.waiting` "{count} more waiting", `panel.input` "Panel input", `panel.collapse` "Hide the panel", `panel.expand` "Show the panel", `panel.reach` "Press Tab to reach the panel", `status.label` "Extension status", `source.extension` "from an extension"; fr: "{count} de plus en attente", "Saisie du panneau", "Masquer le panneau", "Afficher le panneau", "Appuyez sur Tab pour atteindre le panneau", "État des extensions", "d'une extension".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src DESIGN.md
git commit -m "feat(web): extension status bar, widgets and custom panels with ANSI colours on role tokens"
```

---

### Task 28a: Web session actions — rename, auto-name, compact, export, clone, fork and edit from a message

References: pi-web (Fork "New session" on a user message hands its text to the new composer; "Edit from here" puts the message in the composer and the next prompt branches; auto-name button), DESIGN.md (actions as buttons, Cancel never destructive).

**Rulings (pre-dispatch):**
- **M2R140** [28a] Compact asks no confirmation (pi-web; Stop stops it) — pi-web parity; Stop stops a compaction — cost if wrong: tokens spent on a misclick.
- **M2R141** [28a] Export first shows one line, "The file holds everything the agent saw, secrets included.", with Download and Cancel; Download calls `sessions.exportHtml` and follows the returned URL with an `<a download>` click (no SPA route) (owner R2-6) — no SPA route for a download — cost if wrong: none.
- **M2R142** [28a] Fork stores the returned text as the new session's draft (`saveDraft`) and navigates to the existing `/s/$sessionId` route; M2 adds no route — the existing route is enough — cost if wrong: none.

**Files:**
- Create: `apps/web/src/features/sessions/SessionActions.tsx`, `SessionActions.test.tsx`
- Modify: `apps/web/src/features/sessions/{MessageRow,SessionScreen,Composer}.tsx`, `Transcript.test.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Tasks 17a, 17b, 18, 19 methods; Task 24 drafts (`saveDraft` for the forked session's text) and editor-text path.
- Produces:
  - `<SessionActions sessionId view />`: Rename (inline field, Enter saves, Escape cancels; `sessions.rename`), Auto-name (`sessions.autoName`, disabled while one runs; "Naming…" after 1 s as per spec C §7.4 feedback timing), Compact (`sessions.compact`, disabled while running or compacting), Export (the warning line, then `sessions.exportHtml` and an `<a download>` click on the URL), Duplicate (`sessions.clone` then navigates to `/s/$sessionId`).
  - On a user `MessageRow` with an `entryId`: "Fork from here" (`sessions.fork` → `saveDraft(localStorage, newId, text)` → navigate) and "Edit from here" (`sessions.navigate` → the returned `editorText` replaces the composer's text), both disabled while running.

- [ ] **Step 1: Write the failing tests**

`SessionActions.test.tsx`: rename sends `{ sessionId, name: "New name" }` on Enter and nothing on Escape; Duplicate calls `sessions.clone` then navigates to `/s/<new id>` (router mocked); Export shows "The file holds everything the agent saw, secrets included." and calls nothing until Download, then calls `sessions.exportHtml` and clicks a link whose `href` is the returned URL; Cancel calls nothing; Compact is disabled while the status is `running`; a failed auto-name shows the error text.

`MessageRow` tests (in `Transcript.test.tsx`): "Fork from here" calls `sessions.fork({ sessionId, entryId: "u1" })`, stores the returned text as the new session's draft (`localStorage["pap.draft.<new id>"]`) and navigates; "Edit from here" calls `sessions.navigate({ sessionId, targetId: "u1" })` and the composer then holds the returned text; both are disabled while running.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

As the interface lines say; the navigation uses TanStack Router's `useNavigate` as `SessionListScreen` does (`navigate({ to: "/s/$sessionId", params: { sessionId } })`). Every action button keeps its own `busy` state, disabled from the click until the answer (spec C §7.4: nothing under 100 ms, a label after 1 s), and failures go through `failureText`. The composer receives "Edit from here" text through the same path as `editor_text` (a callback prop from `SessionScreen`).

i18n (inside the `sessions (M2)` block): `actions.rename` "Rename", `actions.save` "Save", `actions.autoName` "Name it", `actions.naming` "Naming…", `actions.compact` "Compact", `actions.export` "Export", `actions.exportWarning` "The file holds everything the agent saw, secrets included.", `actions.download` "Download", `actions.duplicate` "Duplicate", `row.fork` "Fork from here", `row.edit` "Edit from here"; fr: "Renommer", "Enregistrer", "Nommer", "Nommage…", "Compacter", "Exporter", "Le fichier contient tout ce que l'agent a vu, secrets compris.", "Télécharger", "Dupliquer", "Bifurquer ici", "Modifier à partir d'ici".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): session actions, export warning, fork and edit from a message"
```

---

### Task 28b: Web branch switcher and always rules

References: pi-web `BranchNavigator` (switches siblings, read-only while busy).

**Rulings (pre-dispatch):**
- **M2R143** [28b] The always-rules list lives in a disclosure of the session header, listing the rules of the session's project (its git root) with Revoke (owner M2-Q2, R2-5), until M5's Settings › Approvals — revocation must exist before M5 — cost if wrong: hard to find.
- **M2R144** [28b] Branch choices refresh (`sessions.branches`) after every snapshot and every settled run; a refresh that lands after the view changed (its `generation` or `leafId` moved since it was asked) is dropped (M2R55, M2-RT-12); the switcher is disabled while running — stale responses are dropped — cost if wrong: a switcher pointing into an abandoned branch.
- **M2R145** [28b] fr `branch.position` is "{index} sur {total}", so fr differs from en (M2-RT-37) — the existing i18n test refuses fr equal to en — cost if wrong: a red i18n test.

**Files:**
- Create: `apps/web/src/features/sessions/{BranchSwitcher,AlwaysRules}.tsx`, `branches.vm.ts`, `branches.vm.test.ts`, `BranchSwitcher.test.tsx`, `AlwaysRules.test.tsx`
- Modify: `apps/web/src/features/sessions/{MessageRow,SessionScreen}.tsx`, `apps/web/src/i18n/{en,fr}.ts`

**Interfaces:**
- Consumes: Task 11 `sessions.branches`, Task 14a `policy.listRules` / `policy.revokeRule`.
- Produces:
  - `branchChoicesFor(points, entryId): { index; total; previous?: string; next?: string } | null` and `<BranchSwitcher>`: on a user row that is one of a fork point's choices, "‹ 2/3 ›" buttons navigate to the neighbour choice's `target`.
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

`BranchSwitcher.test.tsx`: "Next branch" on the row `u2` calls `sessions.navigate({ targetId: "a3" })`; a `sessions.branches` answer that lands after a new snapshot (generation moved) leaves the switcher as it was (M2-RT-12).

`AlwaysRules.test.tsx`: lists two rules; Revoke on the first calls `policy.revokeRule({ ruleId })` and reloads the list (one left).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

As the interface lines say. The branch refresh captures `{ generation: view.generation, leafId: view.leafId }` when it asks and ignores an answer whose capture no longer matches the view. i18n (inside the `sessions (M2)` block): `branch.previous` "Previous branch", `branch.next` "Next branch", `branch.position` "{index}/{total}", `rules.title` "Always allowed in this project", `rules.revoke` "Revoke", `rules.empty` "Nothing is always allowed here."; fr: "Branche précédente", "Branche suivante", "{index} sur {total}" (M2-RT-37), "Toujours autorisé dans ce projet", "Révoquer", "Rien n'est toujours autorisé ici.".

- [ ] **Step 4: Run and commit**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src
git commit -m "feat(web): branch switcher and always rules of the project"
```

---

### Task 29: Web minimap

References: pi-web `components/ChatMinimap.tsx` (one node per turn, a preview of the turn on hover or focus, click scrolls to it, numbering from the branch's first turn with `turnsBefore`, a stub for turns not loaded that pages them in), C §7.3 ("the minimap" kept from pi-web).

**Rulings (pre-dispatch):**
- **M2R146** [29] Visual design not drawn in DESIGN.md: a narrow rail of numbered buttons on token colours, `hidden md:flex` beside the transcript — a mobile decision inside `features/sessions` that M3's shell must not hide a second time (listed in M3's follow-ups, M2-RT-O-5); no markdown in previews — cost if wrong: visual rework in M3.

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

**Rulings (pre-dispatch):**
- **M2R147** [30] Bundle rule shared with M3 (cross-plan agreement 10, owner R3-5): target ≤ 200 KB gz initial. If the build crossed the current `initialBundleGzipKb` (180), first split the session screen's heavy parts (`CustomPanel`, `Minimap`, dialogs) behind `lazy()` inside `features/sessions` (never `vite.config`, M3's, M2-RT-O-6); if it still crosses, raise `budgets.json` to a provisional value with a commit note, never editing the test; above 200 KB gz the controller asks the owner; M3's post-merge P6 re-measures — FinOps — cost if wrong: late split work.
- **M2R148** [30] M2's implementation rulings go to `docs/research/m2-rulings.md`, kept by the controller during execution and committed here; this plan's ledger (M2R1…) is its first part — one ledger per milestone, like m0-m1-rulings.md — cost if wrong: none.

**Files:**
- Modify: `docs/agents/sessions.md` (protocol v2, transcript rows and ADR 0007 with the bounded walks and the incremental cache, coalescing and partial, wire clipping and tool output, queue cap, approvals channel and grants (provisional always, project scope), decorations / panels / notices and their throttles, ANSI colours, commands and the busy rule, export with its patch and ADR 0006, fork / clone and ADR 0009, idle release with background processes, scopes, traps), `docs/agents/daemon.md` (worker settings and scopes: per-home slice, linger, boot sweep, OOM attribution; `exports/`; the policy module; the R118 harness check; the CI user manager), `AGENTS.md` (≤ 150 lines: the new `PAP_WORKER_*` settings and `loginctl enable-linger` for scopes, `pnpm` commands unchanged), `docs/research/m0-m1-rulings.md` (append nothing; M2 rulings go to `docs/research/m2-rulings.md`, kept by the controller during execution and committed here), `budgets.json` only per M2R147

**Interfaces:** none.

- [ ] **Step 1: Update the topic notes** to describe what the code does (no overclaiming), with the traps found during execution.

- [ ] **Step 2: Run every gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke`
Expected: all PASS. This is the M2 exit criterion (see "Exit criteria").

- [ ] **Step 3: Commit**

```bash
git add docs AGENTS.md budgets.json
git commit -m "docs: sessions, daemon and agent notes for M2"
```

---
## Exit criteria (roadmap M2)

All testable on this headless host, without a browser:

1. **Gates:** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke` green (Task 30), in CI too (with its systemd user manager, Task 6).
2. **pi-web D01 behaviours reproduced with scripted-provider integration tests** (real pi-host, scripted model, network guard):

   | D01 behaviour | Integration test |
   |---|---|
   | Steer and follow-up, delivery order, 128-message cap, Stop = clear queue + abort | `sessions.queue.int.test.ts` (Task 12) |
   | `navigate_tree` ("Edit from here") and the next prompt branching; fork points | `sessions.commands.int.test.ts` (Task 17a), `host.commands.int.test.ts` (Task 2) |
   | Fork before a message, clone a branch (old-format sources refused) | `sessions.forks.int.test.ts`, `pi-writer.test.ts` (Task 19) |
   | Compaction, summary row live and after a restart | `sessions.commands.int.test.ts` (Task 17a) |
   | HTML export as a single-use attachment, patched for deep sessions | `sessions.export.int.test.ts`, `export-patch.test.ts` (Task 18) |
   | Auto-name and rename | `sessions.commands.int.test.ts` (Task 17b), `host.commands.int.test.ts` (Task 3) |
   | History paging, tool output on demand | `service.reads.test.ts`, `sessions.reads.int.test.ts` (Task 11) |
   | 50 ms delta coalescing, exact text | `sessions.int.test.ts` streaming case (Task 9a) |
   | Rows with entry ids, live and from the file | `sessions.transcript.int.test.ts` (Task 10b) |
   | Drafts (kept across reloads, cleared on sign-out), pending sends, minimap | component tests (Tasks 24, 29) |

3. **pi-web D18 behaviours:** select / input / editor / confirm, status bar with `command:` buttons, widgets of lines and components, custom panels (open, keys, close, in the snapshot), editor text — `sessions.d18.int.test.ts` (Task 21); approvals on their own channel with once / session / always / deny, revocation biting a live worker — `host.approvals.int.test.ts` (Task 13b), `sessions.grants.int.test.ts` (Task 14b); ANSI colours mapped to role tokens — `ansi.test.ts`, `ansi-theme.test.ts` (Tasks 27, 15) and the DESIGN.md §9.2 rule.
4. **A crashing extension or worker never takes the daemon down:** `sessions.crash.int.test.ts` (Task 22, a command killed for memory included), M1's `worker.rogue.int.test.ts`, `scope.int.test.ts` (Task 5).
5. **Worker idle release after 30 minutes:** `idle-release.test.ts`, `live-session.run.test.ts` (health records ignored, agent processes kept, 8 h cap), `sessions.release.int.test.ts` (Task 20). **systemd scopes** with `MemoryMax` (half the RAM, at least 2 GiB), `TasksMax 4096`, `OOMPolicy=continue` (owner R2-1), per-`PAP_HOME` slice, linger probe, boot sweep: `scope.test.ts`, `scope.int.test.ts` (Task 5), wired at boot and run in CI (Task 6).
6. **Budgets** idle worker RSS and session-open payload measured (Task 23); R45 decided in `docs/spikes/s4-m2-long-session.md`.

## Coverage map (roadmap, backlog, spec, owner decisions → tasks)

| Requirement | Task |
|---|---|
| Protocol v2 records, stream events, snapshot sections | 1a, 1b |
| Steer / follow-up, 128 / 32 MiB queue cap (spec C §2.4, R112) | 2, 12, 24 |
| `navigate_tree` | 2, 10b, 17a, 28a |
| Fork / clone (ADR 0009, owner R2-9) | 19, 28a |
| Compaction | 2, 17a, 25 |
| HTML export, its patch and the secrets warning (owner M2-Q7, R2-6) | 2, 18, 28a |
| Auto-name | 3, 17b, 28a |
| History paging | 10a, 10b, 11, 25 |
| Tool output on demand | 9b, 11, 25 |
| 50 ms delta coalescing, partial reply in the snapshot (R111, R112) | 9a, 9b |
| Recent notices in the snapshot (roadmap line) | 16 |
| Drafts, cleared on sign-out (owner R2-4) | 24 |
| Minimap | 29 |
| All extension dialogs incl. select / input / editor | 13a, 26 |
| Session / always approval answers (spec C §5.3, R90 part), always per git root (owner R2-5) | 13a, 13b, 14a, 14b, 26, 28b |
| Status bar with `command:` buttons, widgets, "extension" label (owner R2-8) | 15, 16, 27 |
| `ctx.ui.custom()` panels over `custom_render` / `custom_input` (S1), focus rule (owner R2-7) | 15, 16, 27 |
| ANSI colours mapped to role tokens, DESIGN.md rule (owner C2) | 15, 27 |
| Worker idle release after 30 min, background processes, 8 h cap (spec C §2.1, owner R2-2) | 20 |
| systemd scopes (R46 as amended by owner R2-1, R100), linger (owner R2-3), CI (owner M2-Q8) | 5, 6 |
| `session_shutdown` parity and the rest of R106 | 4, 5 |
| R113 abort before `agent_start`; run identity in `confirm` | 8 |
| R112 `starting` on reopen, run origin, realpath, dialog limits | 8 |
| R118 daemon-layer network-guard check | 6, 10b |
| R124 exactly-once "Send again", kept across reloads | 24 |
| R45 revisit, budgets | 23 |
| Crash containment (spec A success criterion 1) | 22 |
| Hot-session reads (spec C §3.3 deviation) | 10a (ADR 0007) |
| Export route (spec C §4.5 deviation) | 18 (ADR 0006) |
| Records added to spec C §2.3 | 1a, 1b (ADR 0008) |
| Red-team findings M2-RT-01…42, O-1…O-6 | cited in the task that applies each |

## Owner decisions (2026-10-11)

Source: `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/owner-decisions-2026-10-11.md` (page 1 and page 2); logged as decisions 39 onward in `docs/research/decisions-log.md`.

| Question | Decision | Where |
|---|---|---|
| M2-Q1 "Always" matching | Exact call only (tool + exact payload); patterns with M5 | 14b (M2R72) |
| M2-Q2 Revoke before M5 | A list in the session header | 28b (M2R143) |
| M2-Q3 Answers per question | As written: four for exec / network / external-write; no Always for unknown tools; once / deny for protected or outside writes | 14b (M2R71) |
| M2-Q4 `TasksMax` | 4096 | 5, 6 (M2R24) |
| M2-Q5 ANSI colours | Mapped to role tokens in M2 (C2: the mapping, a real ANSI theme in pi-host, a DESIGN.md rule) | 15, 27 (M2R79, M2R133) |
| M2-Q6 Sending while the agent works | Steer by default | 24 (M2R120) |
| M2-Q7 Exported HTML | Patched like pi-web, in pap's own code, all three helpers or none, served unpatched and logged otherwise | 18 (M2R99) |
| M2-Q8 Scope tests in CI | CI starts a lingering user manager; the scope tests fail in CI without one | 5, 6 (M2R31, M2R36) |
| M2-Q9 Virtualization | Deferred to M4 or M13 | Explicitly deferred |
| M2-Q10 Clone mid-run | Copies what is on disk | 19 (M2R104) |
| M2-Q11 A navigation nobody continued | Lost at release, accepted | 20 (M2R110) |
| M2-Q12 Extension text in the composer | Replaces the draft | 24 (M2R121) |
| M2-Q13 ADRs | 0006, 0007, 0008 accepted, and 0009 (fork / clone) | 18, 10a, 1b, 19 |
| M2-Q14 R90 items pulled forward | Accepted | 13a, 13b (M2R60) |
| M2-Q15 `UI_LIMITS` | As written | 1a (M2R3) |
| R2-1 Scope memory | `MemoryMax = max(2 GiB, 50 % RAM)`, no `MemoryHigh`, `OOMPolicy=continue`; `oom` only for the worker's own SIGKILL while `oom_kill` rose; R46's 512/768 back with M5's per-command sandbox | 5, 6, 22 (M2R24–M2R27) |
| R2-2 Idle release vs background processes | The worker stays while processes its agent started live; released anyway after 8 h | 20 (M2R107) |
| R2-3 Linger off | Scopes disabled with a boot warning; per-home slice, boot sweep, slice kill on a forced exit; tests run with scopes off | 5, 6 (M2R28–M2R30, M2R34) |
| R2-4 Drafts | Cleared on sign-out; pending sends kept across reloads (and cleared at sign-out too) | 24 (M2R118, M2R119) |
| R2-5 Always scope | The git root of the project (the cwd outside git) | 14a (M2R68) |
| R2-6 Export | A one-line secrets warning before the download | 28a (M2R141) |
| R2-7 Panel focus | The panel takes focus unless the composer has it; then "Press Tab to reach the panel" | 27 (M2R136) |
| R2-8 Extension notices | An "extension" source label | 16, 27 (M2R85, M2R138) |
| R2-9 Fork / clone | ADR 0009: the daemon writes new files only; old-format and empty sources refused | 19 (M2R102, M2R103) |
| R2-10 `panelInput` | The idempotent exception, noted in `methods.ts` and the rulings | 16 (M2R86) |
| C2 ANSI mapping | black → `--text-dim`, red → `--err`, green → `--ok`, yellow → `--you`, blue → `--agent`, magenta → `--attn`, cyan → `--agent`, white → `--text`; bold 600, dim `--text-muted`, italic / underline kept; backgrounds, inverse, 256-colour, truecolor ignored | 15, 27 |
| X2 Model table | T7 Sonnet; Opus reviewers on 5, 8, 9a, 13a, 13b, 14b, 17a, 18, 20; final review Opus | Model table |
| T1 / T3 | Opus may review fix rounds 4–5; merge order M2 then M3 | Plan conventions, merge notes |

## Merge order and conflict notes (with M3)

These notes follow the controller's cross-plan agreements (`.superpowers/m2-m3-cross-plan-agreements.md`); M3's plan says the same.

- **1. Order:** M2 merges first (owner T3); M3 rebases once on the `main` that holds M2 and runs its post-merge tasks before its PR. The branch that merges second re-stamps its migrations after the newest stamp on `main` during its rebase (never applied on `main`, so a rename is safe; M3-RT-10). M2's stamps: `sessions/migrations/202610110000_session_name.sql`, `policy/migrations/202610110100_policy.sql`.
- **2. ADR numbers:** M2 0006 (export route), 0007 (hot-session reads), 0008 (protocol records), 0009 (daemon-side fork / clone, new files only); M3 0010 (collapsible primitive), 0011 (`/dev/ui` not shipped), 0012 (R120 contrast amendment).
- **3. R125:** parked in both plans (stream keying `${stream}:${key}` until a second subscription stream lands in M4 or M10; hidden-tab throttling in M12). M2 adds no second stream.
- **4. i18n:** every M2 key, `error.queue_full`, `error.session_busy`, `error.session_empty`, `error.command_failed` and `session.status.releasing` included, sits inside the delimited `// ── sessions (M2) ──` block; no exception (lookup is by key). M2 adds no key whose fr equals its en (fr "Pour la session" for `dialog.answer.session`, "{index} sur {total}" for `branch.position`); M3 keeps its `IDENTICAL_IN_FR` handling in its post-merge list.
- **5. `@pap/ui` must-keep API until P1:** `Button`, `TextField`, `Message`, `ApprovalCard` (M1 props), `cn`, `FOCUS_RING`, `once`, and the M1 token utility classes M2 uses: `bg`, `panel`, `line`, `fg`, `muted`, `agent`, `human`, `human-fill`, `human-tint`, `human-line`, `human-text`, `on-fill`, `attention`, `attention-tint`, `attention-line`, `ok`, `error`, `text-label`, `text-ui`, `text-chat`, `font-mono`, `tracking-label`, `rounded-sm`, `rounded-md`. M3's Task 5 updates the lines of `apps/web/src/features/sessions/SessionScreen.test.tsx` that assert `bg-panel` / `border-error`: at the rebase, take M2's version of that file and re-apply the class names.
- **6. ApprovalCard convergence:** M3's `ApprovalCard` takes `answers?: readonly ApprovalAnswer[]`, `labels: Record<ApprovalAnswer, string>` and `onChoose(answer)`; the M1 props stay as a thin adapter. Answer names are `deny | once | session | always`, as in M2's contracts. Headers are sentence case in the DOM and uppercase by CSS (R121): M2's `ApprovalDialog` does the same (Task 26), so P3 replaces it with `ApprovalCard` without rewriting tests; a type-level test pins `ApprovalAnswer` of `@pap/ui` ≡ the contracts'.
- **7. Escape and keys in panels (owner R3-6):** M2's `CustomPanel` carries `data-terminal-input` and calls `stopPropagation()` on the keys it consumes (Task 27); M3's dispatcher has the context keys `panelFocus` (focus inside `[data-terminal-input]`) and `overlayOpen`; every default chord has `!panelFocus`, `escape` also `!overlayOpen`; Escape stops the run only when neither holds.
- **8. Files both plans list:**

  | File | M2 | M3 | Resolution at M3's rebase |
  |---|---|---|---|
  | `packages/contracts/src/{methods,methods.test,permissions,index}.ts` | `sessions.*` and `policy.*` methods; domain `policy`; `export * from "./policy.ts"` | `settingsMethods`, domain `settings`, `./settings.ts` | union; M3's lines first, M2's entries after |
  | `apps/daemon/src/daemon.ts` | scopes probe and sweep, `killScopes`, policy module, export route | settings module | keep both; re-run the daemon int tests |
  | `apps/daemon/src/modules/*/migrations` | the two stamps above | `settings/migrations/202610111000_settings.sql` | rule 1 (re-stamp after `main`'s newest if needed) |
  | `apps/web/src/i18n/{en,fr,i18n.test}.ts` | the `sessions (M2)` block | imports and spreads of its catalogues; `IDENTICAL_IN_FR` | keep both; the block moves unchanged into M3's sessions catalogue if M3 split them |
  | `apps/web/src/features/sessions/SessionScreen.test.tsx` | `snapshot()` helper v2; confirm cases Yes / No | class-name assertions (Task 5) | rule 5: M2's file, M3's class names |
  | `budgets.json`, `scripts/check-budgets.ts` (+ test) | the two budget lines name `sessions.budgets.int.test.ts` (Task 23); provisional bundle value only per rule 10 | re-set from real numbers (P6) | M3 re-measures |
  | `apps/web/src/build-output.int.test.ts` | untouched unless Task 30's `lazy()` split renames chunks | CSP / gallery / font checks | keep both |
  | `apps/web/src/styles.css` | never | rewritten | M3's |
  | `DESIGN.md` | §9.2 "ANSI colours in extension text" (Task 27) | §3 tokens and §7.4 focus (R120, ADR 0012) | different sections: keep both |
  | `docs/research/decisions-log.md` | decisions 39+ for every owner decision of 2026-10-11, both milestones | none | M2's |
  | `AGENTS.md` | `PAP_WORKER_*`, linger | commands, topic note | union, ≤ 150 lines |
  | `eslint.config.js`, `knip.json` | none planned | new elements and rules | M3's |
  | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | the `@earendil-works/pi-tui` catalog line and pi-host dependency | web dependencies | resolve `package.json` by hand, then `pnpm install` regenerates the lockfile; never hand-merge it |
  | `.github/workflows/{ci,pi-compat}.yml`, `scripts/ci-config.test.ts` | the user-manager step and its guard case (Task 6) | none (e2e dropped) | M2's |
  | `apps/web/src/features/auth/auth-api.ts` | `logout()` clears drafts and pending sends (Task 24) | maybe sign-out in the shell | keep M2's call in `logout()` |

- **9. Markdown and code highlighting (owner R3-1):** M3's new task (lazy markdown in `Message`, shiki with its JavaScript regex engine, CSP R74 unchanged); tool-specific renderers (edit diff, codemode, MCP) are M6's (`DiffView`, R50). M2 renders plain text with native `<details>`.
- **10. Bundle (owner R3-5):** target ≤ 200 KB gz initial; a mid-milestone task that crosses the current budget raises `budgets.json` to a provisional value with a commit note (never the test); above 200 KB gz the controller asks the owner. M2's lazy splits stay inside `features/sessions`; M2 never touches `apps/web/vite.config.ts` (M2-RT-O-6).
- **11. e2e dropped (owner C1):** no Playwright in either plan for now; the M1 guards of `scripts/ci-config.test.ts` stay as they are (M2 only adds its user-manager case); M2-RT-O-4 (a journey on protocol v2) is moot; P6 is a bundle re-measure only.
- **12. decisions-log:** only M2's plan fix appends to `docs/research/decisions-log.md`.
- **13. Coordination-contract exception (owner R3-8):** M3's `settings` module, its contracts file and the `settings` permission domain inside M2-owned areas are accepted: small, Opus-reviewed, one-line conflicts as in rule 8.
- **14. Post-merge order (M3):** P7 → P3 → P2 → P1 → P4 → P5 → P6, with: identical fr keys, re-stamped migrations, `budgets.json`, the panel / overlay context keys, polite live regions, the "send with the other streaming behaviour" binding, `ApprovalDialog` → `ApprovalCard`. `ToolRow` is replaced by `ToolCard` in P3; `QueueStrip` and `Minimap` stay feature components; P1 moves `AnsiText`'s black from `text-muted` to `text-dim`; P2 promotes the select / input / editor shells, `StatusBar`, `Widgets` and `CustomPanel`. M3 also checks the Minimap's `hidden md:flex` against its shell's responsive rules (M2-RT-O-5).
- **Routes:** M2 keeps `SessionScreen({ sessionId })` and `SessionListScreen`, uses the existing `/s/$sessionId` route for forks and clones and adds no route; if M3 renames the route path, Task 28a's `navigate({ to: "/s/$sessionId" })` calls follow.
- **Never touched by M2:** `packages/ui/**`, `apps/web/src/styles.css`, `apps/web/index.html`, `apps/web/src/routes/**`, `apps/web/vite.config.ts`, theming, keybindings, Cmd+K, `/dev/ui`.

## Self-review

- Spec coverage: every roadmap M2 item, every M2-tagged ruling and every owner decision of 2026-10-11 maps to a task (coverage map, "Owner decisions"); deviations have ADRs (0006, 0007, 0008, 0009); deferrals are listed in the header, R125 parked as in M3's plan.
- Red-team review: every finding M2-RT-01…42 and O-1…O-6 is applied in the task named by its id, or recorded as moot (O-4, by owner C1); each task's risks are ruled (M2R1…M2R148, same lines in `.superpowers/rulings-m2.md`); what only implementation can tell is said in the ruling (M2R13, the SDK flush note of Task 19, the defects Task 21 may find).
- Types and names used across tasks: `TranscriptRow`, `EntryRef`, `QueueView`, `PartialMessage`, `Dialog.method "approval"`, `DialogResponse.answer`, `ApprovalAnswers`, `Grant`, `GrantPayload`, `PolicyPort` (`scopeOf`), `PolicyGrants`, `WorkerScope` / `WorkerScopes`, `createIntBed` / `IntBed` / `Subscription`, `LiveSession.leafId()` / `partial()` / `panelInput()` / `command()` / `busy()` / `answer()` / `send()` / `exited()`, `ensureReader()`, `requestTimeoutMs`, `fitSnapshot` / `fitRow` / `fitPage` / `withTrimmedHistory`, `nameOf`, `parseAnsi` are each defined once (task named in its Interfaces block) and used with the same signature afterwards.
- Every split task ends green on its own gate (1a before 1b, 13a before 13b, 14a before 14b…), and the 400-line splits are named before anyone needs them.
- No placeholder steps: where a task leaves an SDK detail to check (option names of `completeSimple`, `CompactionResult` fields, `createBranchedSession` flushing, the `sessionName` getter), it says what to read and keeps the test as the binding part.
