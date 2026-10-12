# pap M4: sidebar, projects and search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status 2026-10-12: planner draft, before the red-team.** Written from `.superpowers/m4-m5-planning-brief.md` in parallel with M5's plan (`.worktrees/feat-m5`, `docs/plans/2026-10-12-m5-policy-access.md`). Every open product or design decision is listed under "Open questions for the owner" with a default and a recommendation; the task rulings assume the defaults. The chain after this draft is the M2/M3 one (decision 52): Opus red-team → owner question page → Opus plan fix → subagent-driven execution → Opus final review.

**Goal:** The ⌘B sidebar becomes a project tree with pins, archive (with Undo), settle and snooze, written as SQLite rows with optimistic writes in the browser; a scanner makes every Pi session created after the pap install appear in pap within seconds, the `pi` CLI's included; ⌘K searches every indexed transcript through FTS5; and the M2/M3 carries listed below are closed.

**Architecture:** Three daemon parts. (1) A new `projects` module owns the `projects` table: a project is the git root of a session's folder (the folder itself outside git), exactly the scope the policy already gives "always" rules (`policy.port.scopeOf`, M2R68), with a display name and a user order. (2) The `sessions` module gains the per-session marks (project, pin rank, archived, settled, snoozed, preview) as additive columns of its own `sessions` table, the `sessions.mark` mutation, and a second subscription stream, `shell` (spec C §4.3 "sidebar summaries"), keyed by the caller and fed by a coalescing publisher; a timer settles idle sessions and wakes snoozed ones on the kernel `Clock`. (3) A new `search` module owns a separate cache database, `$PAP_HOME/search.db` (ADR 0013: an FTS5 index with external content plus one byte-offset cursor per Pi file), the scanner (`fs.watch` on `<agentDir>/sessions` and its folders, a 60 s reconcile, the install-timestamp cutoff), and `search.query`, whose FTS5 queries run in a worker thread (spec C §3.2). New Pi files are adopted through a sessions port that guarantees one pap session per Pi file. In the browser, one eager zustand store fed by the `shell` stream replaces the three places that call `sessions.list`; the tree, its menus, the snooze dialog and the transcript search live in lazy chunks, so the initial bundle stays under 200 KB gzip.

**Tech Stack:** Node 24 (`node:sqlite` with FTS5 per S3, `node:worker_threads`, `fs.watch`), Hono/ws daemon, zod 4 contracts, React 19 + React Compiler, zustand, TanStack Router, cmdk (lazy), Vitest 5 + happy-dom. No new dependency.

**Spec:** `docs/plans/roadmap.md` (M4), `docs/specs/2026-10-10-C-architecture.md` §3 (persistence, scanner, FTS5), §4.3 (streams, the `shell` stream), §7.1 (optimistic writes), `docs/specs/2026-10-10-D-clean-start.md` §1 rule 3 (cutoff = install timestamp, CLI sessions included), `DESIGN.md` §8 (top bar project switcher, ⌘B tree drawer), §9.1 (Toast with Undo, 5 s), §10 screen 12 (⌘K with FTS5 transcript hits), §11 (copy), `docs/spikes/s3.md`, decisions 12, 17, 24, 25, 32, 48, 52 in `docs/research/decisions-log.md`. References read for this plan (read-only clones under `/home/ubuntu/Workspace/soulkyu/_refs/`, untrusted): T3 Code (`T3:`) `docs/user/thread-sidebar.md` (pin, settle, snooze, Undo toasts), `apps/web/src/components/CommandPalette*.tsx` (message search after two characters), `ThreadSearch.ts` (search errors carry no query text); Orca (`Orca:`) `src/main/ai-vault-search/session-search-schema.ts` (the index is a rebuildable cache over the transcripts, cursor per file with inode and offset), `session-search-query-planner.ts` (every term quoted), `session-search-service.ts` (FTS out of the main process).

## Backlog rulings and carries absorbed

| Item | What this plan does | Task |
|---|---|---|
| Carry: two sources of the session list (`routes/shell/sessions-cache.ts`, `SessionListScreen` + `SessionRules`) | One eager store fed by the `shell` stream; `sessions-cache.ts` deleted; the home screen and the session header read the store or the snapshot | 3, 19, 20, 24 |
| R125 (stream keying `${stream}:${key}`, second subscription stream) | The web runtime keys subscriptions by stream and key and maps each stream to its subscribe method; `resync(stream, key)` | 18 |
| Carry M2 28b / E60: cwd in the snapshot | `snapshot.cwd`; `SessionRules` takes it from the view | 3 |
| Carry: unnamed sessions show the id in the tree, the folder in tabs | One `sessionLabel` (name → first-message preview → folder) in `lib/`, used by tabs, tree, palette, top bar and home | 21 |
| M2 final M4 / deferred #33: large dialogs empty the rows, "Load older" then skips them | A row floor (1/16 of the snapshot budget), a 256 KiB cap for non-approval dialogs, and the newest bound row always kept (as a placeholder if needed) | 2 |
| M2 final M5: `hiddenDialogs` goes stale on the web | Decrement on an unknown-id `dialog_closed`; a visible dialog closing while some are hidden asks a fresh snapshot (`resync`) | 26 |
| M2 final M6 / deferred #24: duplicated helpers; `dialogs.ts` cut splits a pair | `kernel/text.ts` (`cutUnits`, `LONE_SURROGATE`, `MAX_ID_CHARS`, `cleanLabel`), `kernel/numbers.ts` (`isCount`), `sizeOf` from `kernel/json-bytes.ts` everywhere in `modules/sessions` | 1 |
| Deferred #20: same-millisecond, same-role entries bind swapped ids | `bindEntry` binds the oldest unbound message | 26 |
| Deferred #18 / M2-Q9: memoise `indexEntries` / `lastEntryId` | Bounded (`upToBytes`) reads memoise their index per parsed file; `lastEntryId` already reads the memoised full index (pinned by a test) | 4 |
| Deferred #31: a stale widget handle's async rejection clears its replacement | A disposed widget component never emits | 4 |
| P3 deferred: markdown re-parses the whole text on every streaming delta | The streaming reply renders as markdown blocks; only the last, growing block re-parses | 26 |
| P3 deferred: the streaming-partial row remounts once when Pi writes the entry | The partial row takes the key its final message will have | 26 |
| P3 leftovers: `last-screen.ts` keeps one detached subtree; no `session.sendOther` test with an overlay or dialog open | `WeakRef`; the two tests | 26 |
| M3 final triage #63 (OpenTab truncated title unreadable) and #184 (active tab not scrolled into view) | Full title as accessible name and tooltip; the active tab scrolled into view | 21 |
| M3R90 (top-bar project switcher), M3R96 (tree by cwd until projects), M3R98 (200 rows, "use ⌘K"), M3R100 (FTS5 hits in ⌘K) | Switcher (24), project tree (22), per-project caps with "search with ⌘K" (22), transcript hits (25) | 22, 24, 25 |
| Decision 48 / M2-Q9: transcript virtualisation "M4 or M13" | Not in M4 by default (owner question Q8); the daemon-side memoisation it called for is done | 4, Q8 |

## What this plan explicitly defers

- **Transcript virtualisation** (decision 48): M13 unless the owner moves it here (Q8). The transcript stays bounded (75 rows plus the pages asked for).
- **Drag-and-drop reordering** of pins and projects: Move up / Move down menu items and keys in M4 (Q3).
- **`mod+z` for the last Undo** (T3): later; the Undo button of the toast is the only path in M4.
- **Bulk actions** (select several rows, T3) and **project hide/delete**: later.
- **Custom Pi session directories** (`sessionDir` setting, `PI_CODING_AGENT_SESSION_DIR`, `--session-dir`): not scanned in M4; only `<agentDir>/sessions` is (the same rule `isPiSessionFile` applies since M1). Written in `docs/agents/search.md`.
- **Spec D's warning when a session file changes outside its worker**: M13 (roadmap).
- **Jumping to a search hit older than the loaded rows**: the session opens at its end with a polite notice; a hit in the loaded rows is scrolled into view (Task 25).
- **Search over tool output and thinking**: user and assistant text only (Q5).
- **Auto-settle settings UI**: a fixed 3-day rule in M4 (Q2).
- **Deferred #14** (runs folded when `agent_start` lands during Stop's probe; run journal accuracy only, the UI is unaffected): to M10, whose `runs` registry is the first consumer of the journal.
- **Not M4's, per the brief:** `parseCount` hardening (M6), fork/clone count cap (M10), long-session RSS (M13); M5's carries (ordered dispatch, `approval_rules` management, passkeys, throttle).
- **`pap backup` without `search.db`**: M6 (the index is a cache; ADR 0013 says so).

## Global Constraints

Copied from the specs and the binding rulings (source in brackets). Every task implicitly includes them.

- Node 24: "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3] · `engines.node` `>=24.14 <25` [R44]
- File size: "400 lines per file at most. No baseline, no exceptions." [C §1.4.2] — ESLint `max-lines`, `scripts/source-guards.ts` [R64c]
- Module boundary: "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1]
- RPC handlers: "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- Permissions: "Every RPC method declares a permission in `contracts`. A missing permission is a type error." [C §1.4.4] — M4 adds **no** permission domain: its methods use `sessions:read` / `sessions:operate` (M4R1).
- Tables: "Tables are owned per module, and only that module's `store.ts` writes to them." [C §3.2] — M4: `projects` (projects module), the new `sessions` columns (sessions module), `search.db` (search module, its own file, ADR 0013).
- Migrations: forward-only, additive, `<YYYYMMDDHHmm>_<name>.sql`; `migrate.ts` refuses one that sorts before an applied one [decision 34, M3R51]. M4 stamps `202610121500_session_marks.sql` and `202610121510_projects.sql`; the branch that merges second re-stamps after `main`'s newest [brief].
- Errors: "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1] — a search error carries no query text (T3 `ThreadSearch.ts`).
- Mutations carry a `commandId` (`idempotent: false`); reads are `idempotent: true` [R65b]; a mutation that ends in `timeout` or `connection_lost` is never re-sent by itself [R105].
- Frames: 1 MiB per message; a page or list is fitted in JSON bytes under `PAGE_BYTES` (900 000) [M2R54].
- Untrusted text (Pi files on disk, transcript snippets, extension text, names) is clipped before logging, never forwarded raw in an error, rendered as React text only, never as HTML [checklist, R66].
- Optimistic writes "(pin, archive, order) roll back on error" [C §7.1].
- UI: tokens from `packages/ui/src/tokens.css` only; no raw colours, no arbitrary values, no restyling of `@pap/ui` primitives; class lists only in `className`, `cn(...)` or `*_CLASSES|VARIANTS|SIZES|TONES|STYLE|RING` constants [AGENTS.md, M3 conventions].
- Copy: every string through the i18n layer, en + fr, no concatenation around variables, never overclaim, no exclamation marks [DESIGN §11]. A French string equal to the English one goes into `IDENTICAL_IN_FR` with a reason.
- Touch: 44 × 44 px under `pointer: coarse` [DESIGN §5]; feedback timing (nothing under 100 ms, disabled to 1 s, spinner to 3 s, stage label after) [DESIGN §7.3]; Toast with Undo for reversible actions, 5 s [DESIGN §9.1]; Cancel is never `danger`.
- Browser floor Safari / iOS 16.4: no RegExp `v` flag, no CSS nesting, no `light-dark()`; `WeakRef` and `Intl.RelativeTimeFormat` are allowed [C §7.3].
- CSP R74 unchanged: no inline script, no eval, no WebAssembly. Snippet highlighting uses control-character markers turned into `<mark>` elements, never HTML.
- Zero telemetry; nothing leaves the machine [C §9.4].
- Tests never touch `~/.pi/agent` or `~/.pap` (temp dirs, removed in `finally`/`afterEach`), never call a provider, never reach the network (network guard); timers go through the kernel `Clock` (daemon) or are injected / `vi.useFakeTimers()` (web); no sleeps (`vi.waitFor` with an explicit timeout for real file-system events) [AGENTS.md, checklist]. The scanner's tests use temporary agent directories only.
- Bundle (owner R3-5, decision 51): initial JavaScript and CSS ≤ 200 KB gzip (`budgets.json` `initialBundleGzipKb` is 200; 194.7 measured at `main` 4e85dd0). Anything not visible at first paint is lazy. Every task that changes eager web code records the measured initial size before and after in its report and commit body (`bundle: <before> → <after> KB gzip`). Task 27 (the lever) moves M2's session-screen strings to a lazy catalog; if a task's measurement crosses 197 KB before it, the controller runs Task 27 next; above 200 KB the controller stops and asks the owner [brief, M2R147].
- Performance budgets (new in `budgets.json`, owner Q6): `searchP95Ms` (search over 10 000 sessions) and `scannerLatencyMs` (a CLI session on the `shell` stream), both measured headless by integration tests; a measurement above its budget stops the controller, who asks the owner.
- Supply chain: no new dependency in M4. If one becomes necessary: `pnpm add -E`, `minimumReleaseAge` waited for, never bypassed [R56, R36].
- Lint discipline: the only directive accepted is `eslint-disable-next-line <rule> -- <reason>` [R64b].
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts` / `.tsx` extension.
- Git: Conventional Commits; commit messages contain no `Co-Authored-By` or AI attribution trailer (owner rule); rebase before PR [C §8.3].
- Never edit pi-web; pap imports nothing from it [D §1]. Never use ports 30141 or 7777. Never write outside `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m4` (absolute paths; the shell's default directory may be another repository); never touch the M5 worktree [brief].
- Lessons checklist: implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and list each item ✅ / n/a (one line why) in their report; reviewers probe each item [controller, owner-approved].
- No browser on this host (decision 42): every check is a unit or integration test (happy-dom, Vite builds, real SQLite, real `fs.watch`, real worker threads). The owner checks real browsers by hand on the preview (decision 52, S6).

## Plan conventions

- Working directory for every command: `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m4`.
- pnpm comes from the worktree's corepack shim: prefix commands with `PATH="/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m4/.superpowers/bin:$PATH"` (git-ignored). Commands below write `pnpm` for short.
- After a rebase or a contracts change, run `pnpm build` before `pnpm typecheck` (stale `packages/contracts/dist`, M3 rebase trap).
- Every task ends with: `pnpm format` on its own files, then `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit` green; plus `pnpm test:int` when the task touches the daemon, pi-host or the web build; plus `pnpm build && pnpm smoke` when it touches the wire, records or the daemon's composition (M2 E25); plus `pnpm build && pnpm budgets` when it touches eager web code. Then the commit shown.
- knip runs in every task: an `index.ts` re-exports only names something imports through it at that task (M3-RT-13).
- Daemon tests: the kernel `createFakeClock`, a temporary SQLite home through `migrate`, `silentLogger`; web tests: `// @vitest-environment happy-dom`, `apps/web/src/testing/{dom.ts,runtime-bed.ts,shell-bed.tsx}`.
- Where a task gives test cases as bullets instead of code (UI screens), each bullet is one `it(...)` with exactly the inputs, selectors and expected values it states; the implementer writes them as code and sees them fail first. Code is given in full for contracts, migrations, stores, pure cores (mark rules, tree view-model, snapshot fitting, query building, header and line reading, scanner decisions, optimistic reducer), and every security-relevant path.
- **Rulings (pre-dispatch)** under each task are decided (format `M4R<n>: decision — why — cost if wrong`); an implementer does not reopen them. "Discovered during implementation" items are the only open ones: the implementer reports, the controller rules.
- Library or SDK APIs are verified against the pinned `.d.ts` under `node_modules/@earendil-works` (the only `node_modules` content an implementer may read) before use.
- Fix rounds: a task still failing review after three fix rounds may go to an Opus implementer for rounds 4–5 (owner T1).

## Review Focus

Inputs and conditions the specs imply, that no feature test naturally exercises, and that are most likely to bite a person using pap. Each line names the tests that pin it.

1. **A Pi file on disk that is hostile or half-written**: written while the scanner reads it, rewritten in place, truncated, swapped for a symlink or a FIFO, huge, with a malformed or missing header line, or a header dated before the install. Expected: the event loop never blocks, a half line is never indexed, nothing is indexed twice, a pre-install session never appears, a rewrite re-indexes, the daemon never follows a link. Pinned by Task 13 `session-file.test.ts` (torn last line, long header, bad header) and Task 15 `scanner-file.test.ts` (FIFO, symlink, rewrite in place, truncation, excluded, waiting, caps).
2. **The same Pi session claimed twice**: pap's own new session whose file appears before the worker's bind, a draft whose worker died before the bind, a copied file with the same header id, a fork the daemon writes. Expected: exactly one pap session per Pi file and per Pi session id. Pinned by Task 14 `scan-port.test.ts`.
3. **Search input and transcript text as markup or query syntax**: quotes, `NEAR`, `*`, `^`, column filters, parentheses, control characters, right-to-left overrides, the snippet markers themselves inside a transcript. Expected: never an FTS error, never a query that means something else, never HTML; the markers can only come from SQLite. Pinned by Task 11 `match.test.ts` and `index-store.test.ts` (control characters stripped before indexing) and Task 25 `snippet.test.ts`.
4. **Optimistic writes against the stream**: an archive whose answer comes after a newer event for the same session, a failure after the stream already moved, a connection lost in the middle, two quick actions on one session. Expected: a rollback never overwrites a newer state; a lost connection ends in the server's snapshot; Undo restores what the person saw. Pinned by Task 19 `shell-reducer.test.ts` and Task 23 `organise.test.ts`.
5. **Scale: 10 000 sessions, hundreds of projects, 50 pins**: Expected: every frame under 1 MiB, the browser store bounded, the tree rendering bounded, search within its budget. Pinned by Task 8 `shell.test.ts` (10 000 rows fit), Task 19 (store eviction), Task 22 `tree.vm.test.ts` (caps), Task 17 `search.budget.int.test.ts`.

## Coordination with M5 (parallel worktree)

Ownership follows the brief's contract. M4 owns the new `projects` and `search` modules, the sessions-list (`shell`) stream and the marks of the `sessions` module, the web shell (`apps/web/src/routes/shell/**`), the new `features/projects/**`, the palette's search, `stores/shell-*`. M5 owns `packages/pi-host/src/policy/**`, the `policy`, `auth` and new `audit` modules, its CLI subcommands, `policy_update` hot reload, and its own web screens (approval modes per session, always-rule management, devices, tokens, passkeys — a lazy Settings section). What M4 touches outside its own areas, and why (repeated in "Merge order and conflict notes"):

| Shared file | M4 change | Size |
|---|---|---|
| `packages/contracts/src/methods.ts` | `import { shellMethods } from "./shell.ts";` + `...shellMethods,` after `...settingsMethods,` | 2 lines |
| `packages/contracts/src/methods.test.ts` | `"projects.update"`, `"sessions.mark"` in the sorted mutation list | 2 lines |
| `packages/contracts/src/index.ts` | `export * from "./marks.ts";` and `export * from "./shell.ts";` | 2 lines |
| `packages/contracts/src/errors.ts` (+ test) | `"limit_reached"` code and message | 2 lines |
| `packages/contracts/src/streams.ts` | `STREAMS` gains `"shell"`; the session snapshot gains `cwd` | 2 lines |
| `packages/contracts/src/permissions.ts` | none (M4R1) | — |
| `apps/daemon/src/daemon.ts` | projects and search modules, `PROJECTS_MIGRATIONS`, `installedAt`, `auth.ownerId`, `search.start()`, a closer | ~12 lines |
| `apps/daemon/src/modules/auth/{index,store}.ts` | `ownerId()` (oldest user) for the scanner's adoption | 2 small additive hunks in M5's module (M4R61) |
| `apps/daemon/src/modules/sessions/**` | marks, shell stream, scan port, carries | M4's area; M5 may add approval-mode code to `service.ts`/`rpc.ts`/`index.ts`: M4 moves `launch` to `service-launch.ts` (Task 7) and puts its handlers in new files to keep shared hunks small |
| migrations | `sessions/…/202610121500_session_marks.sql`, `projects/…/202610121510_projects.sql` | second merger re-stamps |
| `apps/web/src/i18n/index.ts` | `MessageKey` gains `keyof typeof sidebarEn` and `keyof typeof sessionScreenEn` (type-only imports) | 4 lines |
| `apps/web/src/i18n/catalog-keys.test.ts`, `lazy-catalog.test.tsx` | the `sidebar` catalog in the disjointness lists; a lazy-only guard for it | a few lines each |
| `apps/web/src/i18n/{en,fr}.ts` | Task 27 (the lever) removes M2's `sessions (M2)` block from both (moved to a lazy catalog); M4's own eager keys go to `catalog/shell.ts`, the error message too | one block removed |
| `apps/web/src/features/sessions/{AlwaysRules.tsx,AlwaysRules.test.tsx,SessionScreen.tsx}` | `SessionRules` takes `cwd` from the view (Task 3); the screen resyncs when hidden dialogs exist (Task 26) and registers its lazy catalog (Task 27) | small hunks; M5 rebuilds always-rule management |
| `budgets.json`, `scripts/check-budgets.ts` (+ test), `apps/web/src/build-output.int.test.ts` | `searchP95Ms`, `scannerLatencyMs`; lazy markers of the tree and the palette search | additive lines |
| `scripts/smoke-dist.ts` | split into `scripts/smoke-lib.ts` (pure move, the file is at 399 lines) + one import and one call of `scripts/smoke-search.ts` | see Task 28 |
| `knip.json` | `apps/daemon` entry `src/modules/search/search-thread.ts` | 1 line |
| `AGENTS.md`, `docs/agents/{daemon,sessions,web}.md` | topic note `docs/agents/search.md`; module lines | additive |
| `docs/research/decisions-log.md` | only M4's plan fix appends, for both milestones' owner decisions | — |
| `eslint.config.js`, `package.json`, `pnpm-lock.yaml`, `DESIGN.md` | none | — |

ADR numbers: M4 from 0013 (this plan uses 0013 only); M5 from 0020.

## Pre-execution conflict scan

Tasks run one at a time (subagent-driven). These pairs share files or interfaces; keep the order and re-read the earlier task's result before starting the later one.

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1 → 2, 4, 6, 11, 13, 14 | `kernel/text.ts` (`cutUnits`, `cleanLabel`, `LONE_SURROGATE`, `MAX_ID_CHARS`), `kernel/numbers.ts` (`isCount`) | later tasks import these, never re-define them |
| 2 → 3 | `modules/sessions/snapshot.ts` (`fitSnapshot`, `SnapshotInput`) | Task 3 adds `cwd` to the input Task 2 reshaped |
| 3, 5 | `packages/contracts/src/streams.ts` | Task 3 adds `cwd` to the snapshot, Task 5 adds `"shell"` to `STREAMS`; different lines |
| 5 → 6–10, 12, 14, 19, 22–25 | `packages/contracts/src/{shell.ts,marks.ts}` (`ShellSession`, `ProjectSummary`, `ShellStreamEvent`, `MarkChange`, `MarkState`, `applyMark`, `markStateOf`, `SHELL_LIMITS`, `shellMethods`) | the schemas and `applyMark` are the single source for daemon and web |
| 6, 8, 9, 12 | `packages/contracts/src/shell.ts` `shellMethods`, `methods.test.ts` | each task adds the one method it implements, with its handler (M4R18) |
| 6 → 7, 8, 14 | `modules/projects/index.ts` (`ProjectsPort`, `ProjectView`, `PROJECTS_MIGRATIONS`) | sessions consumes the port; projects imports nothing of sessions |
| 7 → 8, 9, 10, 14 | `modules/sessions/{marks-store.ts,service-launch.ts,project-link.ts}`, `SessionsServiceDeps.{projects,marks}` | one store for the new columns; `service.ts` stays under 400 lines |
| 8 → 9, 10, 14 | `modules/sessions/{shell-publisher.ts,service-shell.ts,shell-rpc.ts}` (`changed`, `projectChanged`, `countsChanged`) | every summary change goes through the publisher |
| 8 → 19 | the `shell` stream's snapshot and events | the browser store parses exactly these |
| 10 → 14 | `organiser.activity` | the scan port calls it for CLI activity |
| 11 → 12, 15, 17 | `modules/search/{index-db.ts,index-store.ts,match.ts}` | the thread reads what the store writes |
| 12 → 14, 17, 25 | `search.query` / `SearchHit`, `search-client.ts`, `SessionsScanPort.summary` | Task 14 extends the port Task 12 created |
| 13 → 15 | `modules/search/{session-file.ts,extract.ts}` | Task 15 calls them, never re-reads files itself |
| 14 → 15, 16, 17 | `SessionsScanPort` (`claim`, `touched`, `named`, `previewed`, `summary`), `AuthModule.ownerId` | the scanner talks to sessions only through the port |
| 15 → 16 | `scanner-file.ts` (`processFile`, `FileContext`, `FileOutcome`) | the engine calls it per queued path |
| 18 → 19, 20, 26 | `apps/web/src/runtime/subscriptions.ts` (`subscribe`, `resync`), `testing/runtime-bed.ts` (`emitTo`) | later web tests use `emitTo`, never a hard-coded sub id |
| 19 → 20–26 | `stores/{shell-reducer.ts,shell-store.ts,shell-feed.ts}`, `testing/shell-snapshot.ts` | one store; screens select from it |
| 21 → 22, 24, 25 | `apps/web/src/lib/session-label.ts` (`sessionLabel`, `basename`) | one label function |
| 22 → 23, 24, 25 | `features/projects/{tree.vm.ts,ProjectTree.tsx,SessionRow.tsx,ProjectHeading.tsx}`, `i18n/catalog/sidebar.ts`, `i18n/register-sidebar.ts` | menus attach to the rows Task 22 renders; one lazy catalog |
| 23 → 24 | `features/projects/ProjectMenu.tsx` ("New session here") | Task 24 wires it to the current project |
| 20, 21, 22, 24, 25, 26 | `apps/web/src/routes/shell/{AppShell,TopBar,TabBar,MobileShell,PaletteHost,TreeDrawer}.tsx`, `features/sessions/{SessionListScreen,SessionScreen,Transcript}.tsx` | one shell task at a time |
| 22, 25, 27, 28 | `apps/web/src/build-output.int.test.ts`, `i18n/{index.ts,catalog-keys.test.ts,lazy-catalog.test.tsx}` | append cases and list entries; never loosen an existing expectation |
| 17, 28 | `budgets.json`, `scripts/check-budgets.ts` (+ test) | Task 17 adds the two keys, Task 28 re-measures |
| 12, 28 | `knip.json`, `scripts/smoke-dist.ts` | Task 12 adds the knip entry; Task 28 splits the smoke file |

## File Structure

```
packages/contracts/src/
  marks.ts                MarkState, MarkChange, Marks, NO_MARKS, MAX_PINS, SNOOZE_MIN_MS/MAX_MS, applyMark, markStateOf, isSnoozed
  shell.ts                SHELL_LIMITS, ProjectSummary, ShellSession, ShellStreamEvent, ProjectChange, SearchHit,
                          SNIPPET_OPEN/CLOSE, shellMethods (subscribe.shell, sessions.listArchived, sessions.mark,
                          projects.update, search.query)
  streams.ts              STREAMS += "shell"; session snapshot gains `cwd`
  errors.ts               + limit_reached
apps/daemon/src/kernel/
  text.ts                 LONE_SURROGATE, MAX_ID_CHARS, cutUnits, cleanLabel
  numbers.ts              isCount
apps/daemon/src/modules/projects/        (new module, D02)
  index.ts store.ts service.ts rpc.ts migrations/202610121510_projects.sql
apps/daemon/src/modules/sessions/
  service-launch.ts       launch + ensureLive moved out of service.ts (no behaviour change)
  marks-store.ts          the new columns: marks, project, preview, lookups by Pi path and Pi id
  shell.ts                summaryOf, fitShellSnapshot, fitSummaries
  shell-publisher.ts      coalesced `session` / `project` / `counts` events on `shell:<ownerId>`
  shell-rpc.ts            subscribe.shell, sessions.listArchived, sessions.mark
  service-shell.ts        project assignment and backfill, shell snapshot, archived page, marks
  organiser.ts            3-day auto-settle sweep, snooze wake timer, activity
  scan-port.ts            SessionsScanPort: claim, touched, named, previewed, summary
  migrations/202610121500_session_marks.sql
apps/daemon/src/modules/search/          (new module: scanner + FTS5, ADR 0013)
  index.ts                createSearchModule (start, stop, rpc)
  index-db.ts             open / rebuild search.db (schema version, corruption)
  index-store.ts          file cursors, rows + external-content FTS5
  match.ts                matchExpression (every term quoted)
  query.ts                runQuery (used inside the worker thread; node built-ins only)
  search-thread.ts        worker-thread entry
  search-client.ts        lazy worker, ids, deadlines, crash and idle handling; threadEntry()
  service.ts rpc.ts       search.query
  session-file.ts         header line, complete lines from a byte offset (O_NOFOLLOW | O_NONBLOCK)
  extract.ts              index rows, names, preview from Pi entries
  scanner-file.ts         processFile: one Pi file, cursor, cutoff, rewrite, caps
  scanner.ts watch.ts     watchers, debounce, reconcile, queue, lifecycle
docs/adr/0013-search-index-cache-file.md, docs/agents/search.md
apps/web/src/runtime/subscriptions.ts    keyed `${stream}:${key}`, per-stream opener, resync
apps/web/src/stores/
  shell-reducer.ts shell-store.ts shell-feed.ts current-project.ts
apps/web/src/lib/session-label.ts         sessionLabel, basename (moved from routes/shell)
apps/web/src/features/projects/           (new feature, mirrors the projects module)
  tree.vm.ts ProjectTree.tsx SessionRow.tsx ProjectHeading.tsx ArchivedShelf.tsx organise.ts snooze.ts
  SnoozeDialog.tsx register-sidebar-catalog.ts
apps/web/src/features/commands/palette/   transcript-search.ts, snippet.ts, TranscriptHits.tsx
apps/web/src/routes/shell/                ProjectSwitcher.tsx (+ edits of AppShell, TopBar, TabBar, MobileShell,
                                          PaletteHost, TreeDrawer, use-shell-effects; sessions-cache.ts deleted)
apps/web/src/i18n/catalog/sidebar.ts      lazy (tree, menus, snooze, archive shelf, search group)
scripts/smoke-lib.ts, scripts/smoke-search.ts
```

---

# Phase 1 — Carries in the daemon, the contracts and pi-host

### Task 1: Shared text helpers — `kernel/text.ts` and `kernel/numbers.ts` (carry M2 final M6, deferred #24)

The M2 final review found `sizeOf` three times, `isCount` twice with different meanings, `MAX_ID_CHARS = 128` three times, `LONE_SURROGATE` twice, and a surrogate-safe cut hand-written in several places while `dialogs.ts`'s `cut`, `decorations.ts`'s `cut` and three cuts of `wire-clip.ts` can split a pair. One kernel file holds them, with M6's shared `cutUnits` in mind. The policy module (M5's) keeps its own copy in `policy/service.ts` `cleanLabel`; M5 may switch to the kernel helper.

**Files:**
- Create: `apps/daemon/src/kernel/text.ts`, `apps/daemon/src/kernel/text.test.ts`, `apps/daemon/src/kernel/numbers.ts`, `apps/daemon/src/kernel/numbers.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{names.ts,export-http.ts,entries-cache.ts,live-session.ts,snapshot.ts,service-reads.ts,dialogs.ts,decorations.ts,wire-clip.ts,service-commands.ts,live-commands.ts}`
- Test: `apps/daemon/src/modules/sessions/{dialogs.test.ts,decorations.test.ts,wire-clip.test.ts}` (one case each)

**Interfaces:**
- Consumes: `kernel/json-bytes.ts` `sizeOf`.
- Produces: `LONE_SURROGATE: RegExp` (global, for `replace` only), `MAX_ID_CHARS = 128`, `cutUnits(text: string, max: number, marker?: string): string`, `cleanLabel(raw: unknown, maxCodePoints: number): string | null` (`kernel/text.ts`); `isCount(value: unknown): value is number` (`kernel/numbers.ts`). `snapshot.ts` no longer exports `MAX_ID_CHARS`.

**Rulings (pre-dispatch):**
- M4R3: One `isCount`, the strict one (a non-negative safe integer). A compaction answer whose `tokensBefore` is fractional now reads as unreadable (`compact_answer_unreadable`, 0) — Pi reports integers; the contract still accepts any non-negative number on the wire — cost if wrong: one log line for a hypothetical fractional count.
- M4R4: `cutUnits(text, max, marker)` counts UTF-16 units with the marker included and never ends on a high surrogate; callers pass `max ≥ marker.length` (constants) — the units the contracts count (`z.string().max`) — cost if wrong: none.
- M4R5: `sizeOf` from `kernel/json-bytes.ts` replaces the copies in `dialogs.ts` and `wire-clip.ts`; `undefined` now weighs 4 bytes (`"null"`) in `wire-clip`, where it is only called on defined `details` — no behaviour change for real inputs — cost if wrong: none.
- M4R6: `nameOf` becomes `cleanLabel(raw, UI_LIMITS.name)`; `names.test.ts` stays as it is and must stay green — the projects module reuses the same clean for project names (Task 6) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/kernel/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cleanLabel, cutUnits, LONE_SURROGATE, MAX_ID_CHARS } from "./text.ts";

// With the u flag, \p{Surrogate} matches only a half without its other half.
const hasLoneHalf = (text: string): boolean => /\p{Surrogate}/u.test(text);

describe("cutUnits", () => {
  it("leaves a text that fits as it is", () => {
    expect(cutUnits("abc", 3)).toBe("abc");
    expect(cutUnits("abc", 3, "…")).toBe("abc");
  });

  it("cuts to `max` UTF-16 units, the marker included", () => {
    expect(cutUnits("abcdef", 4)).toBe("abcd");
    expect(cutUnits("abcdef", 4, "…")).toBe("abc…");
    expect(cutUnits("abcdef", 1, "…")).toBe("…");
  });

  it("never ends on the first half of a surrogate pair", () => {
    const text = "ab😀cd"; // a, b, \ud83d, \ude00, c, d
    expect(cutUnits(text, 3)).toBe("ab");
    expect(cutUnits(text, 4)).toBe("ab😀");
    expect(cutUnits(text, 4, "…")).toBe("ab…");
    for (let max = 0; max <= 20; max++) expect(hasLoneHalf(cutUnits("😀".repeat(10), max))).toBe(false);
  });
});

describe("LONE_SURROGATE", () => {
  it("finds halves without their other half, never a whole pair", () => {
    expect("a\ud800b".replace(LONE_SURROGATE, "�")).toBe("a�b");
    expect("a\udc00b".replace(LONE_SURROGATE, "�")).toBe("a�b");
    expect("a😀b".replace(LONE_SURROGATE, "�")).toBe("a😀b");
  });
});

describe("cleanLabel", () => {
  it("removes control and bidi characters, joins whitespace, cuts by code points, trims", () => {
    expect(cleanLabel("a‮b  c\nd😀😀", 5)).toBe("ab c");
    expect(cleanLabel("  x\u0000y\t", 10)).toBe("xy");
    expect(cleanLabel("😀😀😀", 2)).toBe("😀😀");
  });

  it("is null for what holds nothing to show", () => {
    expect(cleanLabel(42, 10)).toBeNull();
    expect(cleanLabel("", 10)).toBeNull();
    expect(cleanLabel("​‮ \n", 10)).toBeNull();
  });

  it("keeps the joiner of an emoji sequence", () => {
    expect(cleanLabel("👩‍💻 dev", 10)).toBe("👩‍💻 dev");
  });
});

it("MAX_ID_CHARS is the contracts' id bound", () => {
  expect(MAX_ID_CHARS).toBe(128);
});
```

`apps/daemon/src/kernel/numbers.test.ts`:

```ts
import { expect, it } from "vitest";
import { isCount } from "./numbers.ts";

it("accepts non-negative safe integers only", () => {
  expect([0, 3, Number.MAX_SAFE_INTEGER].map(isCount)).toEqual([true, true, true]);
  expect([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "3", null].map(isCount)).toEqual([
    false, false, false, false, false, false, false,
  ]);
});
```

Add one case to each existing test file, in its own style:
- `dialogs.test.ts`: "cuts a long title without splitting a surrogate pair": `createDialogRegistry().offer(request("d1", { title: \`${"a".repeat(4094)}😀b\` }))` is `opened` and its `dialog.title` is exactly `"a".repeat(4094) + "…"` (the contract's title bound is 4096 units).
- `decorations.test.ts`: "cuts a status without splitting a surrogate pair": `createDecorations().apply({ type: "extension_ui_request", id: "x", method: "setStatus", statusKey: "k", statusText: \`${"a".repeat(511)}😀\` })` returns `{ kind: "status_bar", key: "k", text: "a".repeat(511) }`.
- `wire-clip.test.ts`: "cuts an argument string without splitting a surrogate pair": `clipArguments(\`${"a".repeat(7999)}😀\`)` is `{ value: "a".repeat(7999), cut: true }`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/text.test.ts apps/daemon/src/kernel/numbers.test.ts apps/daemon/src/modules/sessions/dialogs.test.ts apps/daemon/src/modules/sessions/decorations.test.ts apps/daemon/src/modules/sessions/wire-clip.test.ts`
Expected: FAIL — the kernel files do not exist; the three cuts end with a lone `\ud83d`.

- [ ] **Step 3: Implement**

`apps/daemon/src/kernel/text.ts`:

```ts
/** A half of a surrogate pair without its other half: what a careless cut or broken input leaves. Global: `replace` only. */
export const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The longest id the contracts carry (entries, leaves, sessions, projects): an id is a key, refused when longer, never cut. */
export const MAX_ID_CHARS = 128;

/**
 * At most `max` UTF-16 units (what `z.string().max` counts), `marker` included when the text was cut, never ending on the
 * first half of a surrogate pair. `max` is at least the marker's length.
 */
export function cutUnits(text: string, max: number, marker = ""): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - marker.length);
  const last = text.charCodeAt(keep - 1);
  const end = keep > 0 && last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
  return `${text.slice(0, end)}${marker}`;
}

// Format characters (Cf) go, bidi controls and the BOM among them, except the zero width joiner: without it an emoji
// sequence falls apart. Variation selectors are not Cf and stay.
const FORMAT_EXCEPT_ZWJ = /(?!‍)\p{Cf}/gu;
// NEL and the line and paragraph separators are line breaks like any other; `\s` covers the separators.
const LINE_OR_SPACE = /[\s\u0085]+/gu;
const INVISIBLE_ONLY = /^(?:‍|︎|️| )*$/u;

/**
 * One line of display text from untrusted input (a session name, a project name, a message preview): whitespace of any
 * kind becomes one space, other control and format characters go (the emoji joiner stays), cut to `maxCodePoints` code
 * points (never half a pair), trimmed. Null when nothing visible is left.
 */
export function cleanLabel(raw: unknown, maxCodePoints: number): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw
    .replace(LONE_SURROGATE, "�")
    .replace(FORMAT_EXCEPT_ZWJ, "")
    .replace(LINE_OR_SPACE, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  if (INVISIBLE_ONLY.test(flat)) return null;
  return [...flat].slice(0, maxCodePoints).join("").trimEnd();
}
```

`apps/daemon/src/kernel/numbers.ts`:

```ts
/** A count read from untrusted JSON (a worker's answer, a Pi file): a non-negative safe integer and nothing else. */
export const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
```

Then, with no other change of behaviour:
- `names.ts`: keep the doc comment; body becomes `export const nameOf = (raw: unknown): string | null => cleanLabel(raw, UI_LIMITS.name);` (imports `cleanLabel` from `../../kernel/text.ts`).
- `export-http.ts`: import `LONE_SURROGATE` from the kernel; delete the local copy.
- `entries-cache.ts`, `live-session.ts`, `snapshot.ts`: import `MAX_ID_CHARS` from the kernel; delete the local constants (`snapshot.ts` stops exporting it); `service-reads.ts` imports it from the kernel.
- `dialogs.ts`: import `sizeOf` from `../../kernel/json-bytes.ts` and `cutUnits` from the kernel; `cut` becomes `const cut = (text: string, max: number): string => cutUnits(text, max, "…");`; `labelOf` becomes `cutUnits(message, MAX_LABEL_CHARS)`.
- `decorations.ts`: `const cut = (text: string, max: number): string => cutUnits(text, max);`.
- `wire-clip.ts`: import `sizeOf`; the three slices become `cutUnits(content, budget)`, `cutUnits(block.text, left)`, `cutUnits(value, ARG_PREVIEW_CHARS)`.
- `service-reads.ts` `clipJsonText`: the last two lines become `return { text: cutUnits(text, low), truncated: true };`.
- `service-commands.ts`, `live-commands.ts`: import `isCount` from `../../kernel/numbers.ts`; delete the local copies.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS. `rg -n "const (sizeOf|isCount|LONE_SURROGATE|MAX_ID_CHARS)" apps/daemon/src/modules/sessions` prints nothing. Mutation check: put the old `text.slice(0, max - 1)` back in `dialogs.ts` → the new dialogs case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/kernel apps/daemon/src/modules/sessions
git commit -m "refactor(daemon): one kernel home for text cuts, ids and counts; cuts never split a surrogate pair"
```

---

### Task 2: Snapshot fitting — a row floor, a cap for extension dialogs, a history cursor that never skips (carry M2 final M4, deferred #33)

`fitSnapshot` gives dialogs the first claim on the 1 MB budget. An extension's dialogs (a `prefill` alone may be about 1 MB) can leave no room for rows; `withTrimmedHistory` then falls back to the page's oldest entry and "Load older" asks for rows above rows the client never got. Approvals keep their absolute priority (M2R9).

**Files:**
- Modify: `apps/daemon/src/modules/sessions/snapshot.ts`
- Test: `apps/daemon/src/modules/sessions/snapshot.limits.test.ts` (112 lines; append), `snapshot.test.ts` unchanged and green

**Interfaces:**
- Produces: `ROW_FLOOR_SHARE = 16`, `OTHER_DIALOG_BYTES = 256 * 1024` (exported from `snapshot.ts`); `fitSnapshot` keeps its signature.

**Rulings (pre-dispatch):**
- M4R7: Rows always keep `floor(budget / 16)` bytes (62 500 of the 1 MB snapshot): everything but approvals (other dialogs, decorations, panels, the partial reply) is fitted under `budget − floor`; approvals and rows under `budget` — M2R9 keeps approvals first; 76 row placeholders weigh at most about 43 KB (a placeholder of the largest kind is 569 bytes) — cost if wrong: a little less room for decorations in a pathological snapshot.
- M4R8: Non-approval dialogs share at most 256 KiB in a snapshot; the ones left out count in `hiddenDialogs` — the M2 final review's number — cost if wrong: a large extension dialog seen only live, not after a reconnect (it says "N more waiting").
- M4R9: Rows stay contiguous from the newest. Until the newest row that has an entry id is in, a row that does not fit goes in as its placeholder (`omitted: true`, entry id kept); after it, the first row that does not fit ends the rows as before. So a snapshot with any bound row offered keeps one, and `history.oldestEntryId` always names a row the client has — the cursor M2R55's pages start from — cost if wrong: none (placeholders of a run's own rows say "too large to show" until the run settles).

- [ ] **Step 1: Write the failing tests**

Append to `snapshot.limits.test.ts`:

```ts
import { OTHER_DIALOG_BYTES, ROW_FLOOR_SHARE } from "./snapshot.ts";

describe("rows are never crowded out by an extension's dialogs (M2 final M4)", () => {
  const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const bound = (n: number) => ({ entryId: `e${n}`, message: { role: "user", content: `m${n}` } });
  const unbound = (n: number, bytes: number) => ({
    entryId: null,
    message: { role: "assistant", timestamp: n, content: [{ type: "text", text: "r".repeat(bytes) }] },
  });
  const extension = (id: string, bytes: number): Dialog => ({
    id,
    method: "editor",
    title: id,
    prefill: "p".repeat(bytes),
  });
  const approval = (id: string, bytes: number): Dialog => ({
    id,
    method: "approval",
    title: id,
    message: "a".repeat(bytes),
    category: "exec",
    answers: ["deny", "once"],
  });

  it("caps the dialogs other than approvals, and counts the rest as hidden", () => {
    const dialogs = [extension("x1", 100_000), extension("x2", 100_000), extension("x3", 100_000)];
    const snapshot = fitSnapshot({ status: "running", rows: [bound(1)], dialogs });
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["x1", "x2"]);
    expect(snapshot.hiddenDialogs).toBe(1);
    expect(OTHER_DIALOG_BYTES).toBe(256 * 1024);
  });

  it("still gives approvals the first claim, whatever the extension dialogs", () => {
    const dialogs = [extension("x1", 200_000), approval("a1", 30_000), extension("x2", 100_000)];
    const snapshot = fitSnapshot({ status: "running", rows: [bound(1)], dialogs });
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["x1", "a1"]);
    expect(snapshot.hiddenDialogs).toBe(1);
    expect(snapshot.rows).toEqual([bound(1)]);
  });

  it("keeps the newest bound row when a run's rows and a dialog fill the budget, and the cursor points at it", () => {
    // 100 000 bytes: the floor is 6 250; the dialog fits under budget - floor; three run rows of 20 000 fit, the fourth
    // does not and goes in as a placeholder, then the page's bound rows.
    const rows = [bound(1), bound(2), bound(3), unbound(4, 20_000), unbound(5, 20_000), unbound(6, 20_000), unbound(7, 20_000)];
    const snapshot = fitSnapshot({ status: "running", rows, dialogs: [extension("x1", 30_000)] }, 100_000);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(100_000);
    expect(snapshot.rows.at(-1)).toEqual(rows.at(-1));
    expect(snapshot.rows.some((row) => row.entryId === "e3")).toBe(true);
    const placeholder = snapshot.rows.find((row) => (row.message as { omitted?: boolean }).omitted === true);
    expect(placeholder?.entryId).toBeNull();
    const trimmed = withTrimmedHistory(snapshot, rows, { hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
    expect(snapshot.rows.find((row) => row.entryId !== null)?.entryId).toBe(trimmed.history.oldestEntryId);
  });

  it("reserves the row floor from what the other dialogs may take", () => {
    expect(ROW_FLOOR_SHARE).toBe(16);
    const dialogs = [extension("x1", 60_000)];
    // Budget 64 000: the floor is 4 000, so a 60 000-byte dialog (plus the fixed sections) no longer fits.
    const snapshot = fitSnapshot({ status: "running", rows: [bound(1)], dialogs }, 64_000);
    expect(snapshot.dialogs).toEqual([]);
    expect(snapshot.hiddenDialogs).toBe(1);
    expect(snapshot.rows).toEqual([bound(1)]);
  });

  it("a placeholder of the largest kind stays under 600 bytes, so the floor holds 76 of them", () => {
    const worst = {
      entryId: "i".repeat(128),
      message: { role: "r".repeat(64), toolCallId: "c".repeat(256), timestamp: 8.64e15, omitted: true, bytes: 1e15 },
    };
    expect(sizeOf(worst) * 76).toBeLessThan(1_000_000 / ROW_FLOOR_SHARE);
  });
});
```

(`fitSnapshot`, `withTrimmedHistory` and `Dialog` are already imported by the file; add only the new names.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/snapshot.limits.test.ts`
Expected: FAIL — `OTHER_DIALOG_BYTES` / `ROW_FLOOR_SHARE` are not exported; the run case keeps only three unbound rows and its cursor falls back to `e1`.

- [ ] **Step 3: Implement**

In `snapshot.ts`, add the constants next to `PANEL_BYTES`:

```ts
/** The share of the budget the rows always keep, whatever the dialogs and decorations take (M2 final M4). */
export const ROW_FLOOR_SHARE = 16;
/** Dialogs other than approvals, together: an extension's large dialogs cannot crowd out the transcript (M2 final M4). */
export const OTHER_DIALOG_BYTES = 256 * 1024;
```

In `fitSnapshot`, right after `let used = sizeOf(snapshot);`:

```ts
  // Everything but approvals and rows stays under `room`: the rows keep their floor (M4R7).
  const room = budget - Math.floor(budget / ROW_FLOOR_SHARE);
```

The dialog loop becomes:

```ts
  let otherDialogs = 0;
  for (const dialog of approvalsFirst) {
    const size = sizeOf(dialog) + 1;
    if (dialog.method === "approval") {
      if (used + size > budget) continue;
    } else if (used + size > room || otherDialogs + size > OTHER_DIALOG_BYTES) continue;
    used += size;
    if (dialog.method !== "approval") otherDialogs += size;
    kept.add(dialog);
  }
```

In `decorate`, the panel loop and the partial check, replace `budget` with `room` (`used + size > room`, `used + size <= room`).

The rows loop becomes:

```ts
  const offered = input.rows.slice(-SNAPSHOT_ROWS).toReversed();
  // Rows newer than the newest bound one, and that row itself, go in as placeholders when they do not fit, so the
  // client always has a row its next page can start above (M4R9). Past it, the first row that does not fit ends them.
  const reach = offered.findIndex((row) => row.entryId !== null);
  const newestFirst: TranscriptRow[] = [];
  for (const [index, candidate] of offered.entries()) {
    const { row, size } = fitRow(candidate);
    if (used + size + 1 <= budget) {
      used += size + 1;
      newestFirst.push(row);
      continue;
    }
    if (index > reach) break;
    const stand = { entryId: candidate.entryId, message: placeholderRow(candidate.message, sizeOf(candidate)) };
    const standSize = sizeOf(stand) + 1;
    if (used + standSize > budget) break;
    used += standSize;
    newestFirst.push(stand);
  }
  snapshot.rows = newestFirst.toReversed();
```

Update the doc comment of `fitSnapshot` to describe the floor, the 256 KiB cap and the placeholder rule; `withTrimmedHistory` is unchanged (its `find` now always meets the kept bound row; say so in its comment).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon/src/modules/sessions && pnpm lint && pnpm typecheck`
Expected: PASS, `snapshot.test.ts` unchanged and green. Mutation checks: drop `if (index > reach) break;`'s placeholder branch (break at once) → the run case fails; give non-approval dialogs `budget` instead of `room` → the floor case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions/snapshot.ts apps/daemon/src/modules/sessions/snapshot.limits.test.ts
git commit -m "fix(sessions): extension dialogs can no longer crowd out the snapshot's rows, and the history cursor never skips"
```

---

### Task 3: The session's folder in the snapshot (carry M2 Task 28b / E60)

`SessionRules` (the always-rules disclosure in the session header) finds the session's folder with a `sessions.list` call. The snapshot carries it instead, so the session screen needs no list at all.

**Files:**
- Modify: `packages/contracts/src/streams.ts` (the snapshot's `cwd`), `packages/contracts/src/streams.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{snapshot.ts,service-reads.ts}`, `snapshot.test.ts` (the full-object case gains `cwd: ""`), `service.snapshot.test.ts` (one case)
- Modify: `apps/web/src/stores/session-reducer.ts` (+ `session-reducer.test.ts` or the reducer's existing test file), `apps/web/src/testing/session-snapshot.ts`, `apps/web/src/features/sessions/{AlwaysRules.tsx,AlwaysRules.test.tsx,SessionScreen.tsx}`

**Interfaces:**
- Produces: `SnapshotEvent.cwd: string` (`""` from an older daemon); `SnapshotInput.cwd?: string`; `SessionView.cwd: string`; `SessionRules({ sessionId, cwd }: { sessionId: string; cwd: string })`.

**Rulings (pre-dispatch):**
- M4R10: `cwd` is `z.string().max(4096).default("")` in the snapshot: additive, no `PROTOCOL_VERSION` bump — an open tab of an older build ignores the field; the web and the daemon ship together — cost if wrong: none.
- M4R11: While `view.cwd` is `""` (no snapshot yet), the disclosure says "Loading…"; the "This session no longer exists" state of `SessionRules` goes (a session the snapshot could not find is the screen's own `not_found` error) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`streams.test.ts`, one case: `SessionStreamEvent.parse(<the file's existing snapshot fixture without cwd>)` has `cwd: ""`; with `cwd: "/w/api"` it keeps `"/w/api"`; with `cwd: "x".repeat(4097)` `safeParse` fails.

`service.snapshot.test.ts`, one case in its style: the snapshot of a session created in `/w/api` (the bed's cwd) has `cwd` equal to that session row's `cwd`.

Web reducer test (the file that tests `reduceSession`): a snapshot event with `cwd: "/w/api"` gives `view.cwd === "/w/api"`; `EMPTY_VIEW.cwd === ""`.

`AlwaysRules.test.tsx`: replace the `sessions.list` cases with:
- `SessionRules` with `cwd="/w/api"`, opened, calls `policy.listRules` with `{ cwd: "/w/api" }` and never calls `sessions.list`;
- with `cwd=""`, opened, shows `Loading…` (the `rules.loading` text) and calls nothing.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts apps/daemon/src/modules/sessions apps/web/src/stores apps/web/src/features/sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

`streams.ts`, in the `Snapshot` object after `name`:

```ts
  /** The session's working directory (M4): the session screen needs no list to find it. `""` from an older daemon. */
  cwd: z.string().max(4096).default(""),
```

`snapshot.ts`: `SnapshotInput` gains `readonly cwd?: string;` and the initial `snapshot` object gains `cwd: input.cwd ?? "",`. `service-reads.ts` `snapshot()` passes `cwd: row.cwd` to `fitSnapshot`. `snapshot.test.ts`'s full-object expectation gains `cwd: ""`.

Web: `SessionView` gains `/** The session's folder, from the snapshot ("" until one arrives). */ readonly cwd: string;`, `EMPTY_VIEW.cwd = ""`, the `snapshot` case sets `cwd: event.cwd`. `testing/session-snapshot.ts` gains `cwd: "/w"`.

`AlwaysRules.tsx`: `SessionRules({ sessionId, cwd }: { sessionId: string; cwd: string })` keeps the disclosure; its body renders `<AlwaysRules cwd={cwd} />` when open and `cwd !== ""`, else the loading line; the `sessions.list` effect, `notFound`, `error` and their state go (`sessionId` stays for the `key` the screen sets). `SessionScreen.tsx` passes `cwd={view.cwd}`. The `rules.notFound` key stays in the catalog only if something else uses it; otherwise delete it from `en.ts` / `fr.ts` (knip-like check: `rg -n "rules.notFound" apps/web/src`).

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm test:unit && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS. `rg -n "sessions.list" apps/web/src/features/sessions/AlwaysRules.tsx` prints nothing.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/contracts apps/daemon/src/modules/sessions apps/web/src
git commit -m "feat(sessions): the snapshot carries the session's folder; the rules disclosure reads it instead of listing sessions"
```

---

### Task 4: Worker-side carries — a memoised index for bounded reads, and a stale widget that cannot clear its replacement (deferred #18, #31)

Two small fixes found in M2's reviews, in two files that nothing else in M4 touches.

**Files:**
- Modify: `apps/daemon/src/modules/sessions/entries-cache.ts`, test `entries-cache.test.ts` (384 lines: put the new cases in a new `entries-cache.memo.test.ts`)
- Modify: `packages/pi-host/src/widget-components.ts`, test `packages/pi-host/src/widget-components.test.ts`

**Interfaces:**
- Produces: `EntriesCache.read(path, upToBytes?)` returns the same `IndexedEntries` object for repeated reads of an unchanged file with the same `upToBytes`.

**Rulings (pre-dispatch):**
- M4R12: One memo slot per parsed file for a bounded read (`upToBytes`): a run's snapshot reads the same bound for its whole length (the baseline bytes of the run), so one slot covers it; a new parse or an append drops it — bounded by construction — cost if wrong: an index rebuilt per snapshot for a second concurrent bound (none exists today).
- M4R13: A widget component that was disposed (replaced, released, cleared) never emits again: a late async rejection only logs (`deps.onError`) — the key now shows a newer widget's lines, or a caller's own — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`entries-cache.memo.test.ts` (use the file writers of `testing/pi-file-writers.ts` and a temp dir removed in `afterEach`; build the cache with the same fake SDK the existing `entries-cache.test.ts` uses — copy its `sdk` constant):

```ts
it("hands out the same index for repeated bounded reads of an unchanged file", () => {
  const path = write(dir, "s.jsonl", sessionFileText("p1", [["hi", "hello"], ["again", "yes"]]));
  const cache = createEntriesCache(sdk);
  const bound = statSync(path).size - 10;
  const first = cache.read(path, bound);
  expect(cache.read(path, bound)).toBe(first);
  expect(cache.read(path, bound - 1)).not.toBe(first);
  expect(cache.read(path)).toBe(cache.read(path)); // the full read was memoised already (lastEntryId uses it)
});

it("drops the memo when the file grows", () => {
  const path = write(dir, "s.jsonl", sessionFileText("p1", [["hi", "hello"]]));
  const cache = createEntriesCache(sdk);
  const bound = statSync(path).size;
  const first = cache.read(path, bound);
  appendFileSync(path, `${JSON.stringify({ type: "message", id: "u9", parentId: "a0", timestamp: "2026-10-10T00:00:09.000Z", message: { role: "user", content: "more", timestamp: 9 } })}\n`);
  expect(cache.read(path, bound)).not.toBe(first);
  expect(cache.read(path, bound).list.map((e) => e.id)).toEqual(first.list.map((e) => e.id));
});
```

`widget-components.test.ts`, in its style (its existing fake `deps` and `send` spy):

```ts
it("a replaced widget whose async render rejects late does not clear its replacement (deferred #31)", async () => {
  const { sent, errors, widgets } = setup();
  let reject: (error: Error) => void = () => {};
  const sync = (lines: string[]) => () => ({ render: () => lines, invalidate: () => {} });
  // A render that returns a promise: nothing is drawn, the handle keeps the `visible` it inherited from "A".
  const pending = () => ({
    render: () =>
      new Promise<string[]>((_resolve, no) => {
        reject = no;
      }),
    invalidate: () => {},
  });
  widgets.set("k", sync(["A"]) as never);
  widgets.set("k", pending as never);
  widgets.set("k", sync(["C"]) as never);
  sent.length = 0;
  reject(new Error("late"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toEqual([]);
  expect(errors).toEqual(["setWidget"]);
});
```

(Before the fix the late rejection of the middle component, whose handle inherited `visible: true` from "A", sends `widgetLines: undefined` for `k` and wipes "C".)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/entries-cache.memo.test.ts packages/pi-host/src/widget-components.test.ts`
Expected: FAIL — a new index per bounded read; the late rejection sends a clear for `k`.

- [ ] **Step 3: Implement**

`entries-cache.ts`: `Parsed` gains `bounded: { readonly upTo: number; readonly index: IndexedEntries } | null;` (`null` in `full` and `append`). `read` becomes:

```ts
    read(path, upToBytes) {
      const parsed = load(path);
      if (!parsed) return EMPTY;
      if (upToBytes === undefined) return (parsed.index ??= indexEntries(parsed.entries));
      // One slot: a run reads the same bound for its whole length (M4R12).
      if (parsed.bounded?.upTo !== upToBytes) {
        parsed.bounded = {
          upTo: upToBytes,
          index: indexEntries(parsed.entries.filter((_entry, i) => (parsed.ends[i] ?? Infinity) <= upToBytes)),
        };
      }
      return parsed.bounded.index;
    },
```

(`bounded` is mutable like `index`; declare it without `readonly`.)

`widget-components.ts`, in `set`, `fail` becomes:

```ts
    const fail = (error: unknown): void => {
      deps.onError("setWidget", error);
      // Disposed already (replaced, released, cleared, or failed before): what the key shows now is not this
      // component's, so it must not clear it (deferred #31).
      if (closed) return;
      if (live.get(key) === handle) live.delete(key);
      handle.dispose();
      if (handle.visible) emit(key, undefined, undefined);
      handle.visible = false;
    };
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon packages/pi-host && pnpm test:int packages/pi-host && pnpm lint && pnpm typecheck`
Expected: PASS. Mutation check: remove `if (closed) return;` → the widget case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions/entries-cache.ts apps/daemon/src/modules/sessions/entries-cache.memo.test.ts packages/pi-host/src
git commit -m "fix(sessions,pi-host): memoise bounded transcript indexes; a disposed widget never clears its replacement"
```

---

# Phase 2 — Projects, marks and the `shell` stream (daemon)

### Task 5: Contracts — the mark rules, the shell schemas, `limit_reached`, the `shell` stream name

**Files:**
- Create: `packages/contracts/src/marks.ts`, `marks.test.ts`, `shell.ts`, `shell.test.ts`
- Modify: `packages/contracts/src/{index.ts,methods.ts,streams.ts,errors.ts,errors.test.ts}`
- Modify: `apps/web/src/i18n/catalog/shell.ts` (`error.limit_reached`, en and fr)

**Interfaces:**
- Produces (`marks.ts`): `MAX_PINS = 50`, `SNOOZE_MIN_MS = 60_000`, `SNOOZE_MAX_MS = 366 * 86_400_000`, `MarkState` (schema + type), `MarkChange` (schema + type, kinds `pin{before}`, `unpin`, `archive`, `unarchive`, `settle`, `unsettle`, `snooze{until}`, `wake`, `restore{state}`), `interface Marks { pinRank; archivedAt; settledAt; settledAuto; unsettledAt; snoozedUntil }`, `NO_MARKS`, `type MarkOutcome`, `applyMark(id, current, change, pins, now): MarkOutcome`, `markStateOf(id, marks, pins, now): MarkState`, `isSnoozed(marks, now): boolean`.
- Produces (`shell.ts`): `SHELL_LIMITS`, `ProjectSummary`, `ShellSession`, `ShellStreamEvent`, `ProjectChange`, `shellMethods` (empty here; Tasks 6, 8, 9, 12 add one method each with its handler).
- Produces: `STREAMS = ["session", "shell"]`; error code `limit_reached`.

**Rulings (pre-dispatch):**
- M4R1: M4 adds no permission domain: `subscribe.shell`, `sessions.listArchived`, `search.query` are `sessions:read`; `sessions.mark`, `projects.update` are `sessions:operate` — they read and organise sessions; a token that may read sessions may search the same data; `permissions.ts` stays out of the M4 ⇄ M5 conflict set — cost if wrong: one line per method to move to a `projects` domain later.
- M4R2: `PROTOCOL_VERSION` stays 2: everything M4 changes on the wire is additive (a second stream, new methods, an optional `cwd` in the snapshot, an optional `truncated` in `sessions.list`), and the web app ships with the daemon, so an open tab of the previous build keeps working until it reloads — a bump would force a reload for nothing — cost if wrong: an old tab that misses the sidebar's new data until it reloads.
- M4R14: The mark rules exist once, as `applyMark` in contracts: the daemon writes with it, the browser shows the change with it before the answer — two copies would drift and the optimistic view would lie — cost if wrong: none (a pure function, no dependency).
- M4R15: Rules (T3 `thread-sidebar.md`, adapted): `pin` pins or moves (before an id, else last), brings an archived or settled session back into view and keeps its snooze; at most 50 pins (`limit_reached`); `archive` and `settle` unpin and clear the snooze, and keep their first time; `unsettle` records its time (Task 10's 3-day rule counts from it); `snooze` needs a time from 1 minute to 366 days ahead and a session that is not archived, and clears `settled`; `restore` puts back a captured state (Undo), dropping a snooze whose time has passed — cost if wrong: a rule change in one function.
- M4R16: `limit_reached` is a new error code, "This list is full. Remove an entry first." — `capacity` speaks of the server, `conflict` of a concurrent change — cost if wrong: one more line in M5's merge of `errors.ts`.
- M4R17: Every time in the shell schemas is an integer number of milliseconds in `Date`'s range (`0..8.64e15`), and every id 1..128 characters — client-sent times and ids are untrusted — cost if wrong: none.
- M4R18: `shellMethods` starts empty; each later task adds the method it implements together with its handler, so the daemon's exhaustive handler table compiles after every task — cost if wrong: none.
- M4R19: The browser's error text for `limit_reached` lives in the eager `catalog/shell.ts`, not in `en.ts` / `fr.ts` — keeps M4 out of the M5 conflict on the literal catalogs — cost if wrong: none (`errorKey` looks keys up in the merged eager catalog).

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/marks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyMark,
  isSnoozed,
  MAX_PINS,
  markStateOf,
  type MarkOutcome,
  type Marks,
  NO_MARKS,
  SNOOZE_MAX_MS,
  SNOOZE_MIN_MS,
} from "./marks.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ok = (outcome: MarkOutcome) => {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome;
};
const fifty = Array.from({ length: MAX_PINS }, (_, i) => `p${i}`);

describe("applyMark (M4R15)", () => {
  it("pins last, before another pin, and moves a pinned session", () => {
    expect(applyMark("s", NO_MARKS, { kind: "pin", before: null }, ["a", "b"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, pinRank: 3 },
      pins: ["a", "b", "s"],
    });
    expect(ok(applyMark("s", NO_MARKS, { kind: "pin", before: "b" }, ["a", "b"], NOW)).pins).toEqual(["a", "s", "b"]);
    expect(applyMark("b", { ...NO_MARKS, pinRank: 2 }, { kind: "pin", before: "a" }, ["a", "b"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, pinRank: 1 },
      pins: ["b", "a"],
    });
    expect(ok(applyMark("s", NO_MARKS, { kind: "pin", before: "gone" }, ["a"], NOW)).pins).toEqual(["a", "s"]);
  });

  it("refuses a 51st pin and still moves one of the 50", () => {
    expect(applyMark("s", NO_MARKS, { kind: "pin", before: null }, fifty, NOW)).toEqual({ ok: false, code: "limit_reached" });
    expect(ok(applyMark("p3", { ...NO_MARKS, pinRank: 4 }, { kind: "pin", before: "p0" }, fifty, NOW)).marks.pinRank).toBe(1);
  });

  it("pinning brings an archived or settled session back into view and keeps its snooze", () => {
    const marks: Marks = { ...NO_MARKS, archivedAt: 1, settledAt: 2, settledAuto: true, snoozedUntil: NOW + HOUR };
    expect(ok(applyMark("s", marks, { kind: "pin", before: null }, [], NOW)).marks).toEqual({
      ...marks,
      pinRank: 1,
      archivedAt: null,
      settledAt: null,
      settledAuto: false,
    });
  });

  it("unpins; archive and settle unpin too and clear the snooze", () => {
    const pinned: Marks = { ...NO_MARKS, pinRank: 1, snoozedUntil: NOW + HOUR };
    expect(applyMark("s", pinned, { kind: "unpin" }, ["s", "b"], NOW)).toEqual({
      ok: true,
      marks: { ...pinned, pinRank: null },
      pins: ["b"],
    });
    expect(applyMark("s", pinned, { kind: "archive" }, ["s"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, archivedAt: NOW },
      pins: [],
    });
    expect(applyMark("s", pinned, { kind: "settle" }, ["s"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, settledAt: NOW },
      pins: [],
    });
    expect(ok(applyMark("s", NO_MARKS, { kind: "unpin" }, ["b"], NOW)).pins).toBeNull();
  });

  it("keeps the first archive and settle times; a manual settle replaces an automatic one", () => {
    expect(ok(applyMark("s", { ...NO_MARKS, archivedAt: 5 }, { kind: "archive" }, [], NOW)).marks.archivedAt).toBe(5);
    expect(ok(applyMark("s", { ...NO_MARKS, settledAt: 6, settledAuto: true }, { kind: "settle" }, [], NOW)).marks).toEqual({
      ...NO_MARKS,
      settledAt: 6,
    });
  });

  it("unarchives; unsettle records its time for the 3-day rule", () => {
    expect(ok(applyMark("s", { ...NO_MARKS, archivedAt: 5 }, { kind: "unarchive" }, [], NOW)).marks).toEqual(NO_MARKS);
    expect(ok(applyMark("s", { ...NO_MARKS, settledAt: 6, settledAuto: true }, { kind: "unsettle" }, [], NOW)).marks).toEqual({
      ...NO_MARKS,
      unsettledAt: NOW,
    });
  });

  it("snoozes from one minute to 366 days ahead, never an archived session, and wakes", () => {
    const refused = { ok: false, code: "bad_request" };
    expect(applyMark("s", NO_MARKS, { kind: "snooze", until: NOW + SNOOZE_MIN_MS - 1 }, [], NOW)).toEqual(refused);
    expect(applyMark("s", NO_MARKS, { kind: "snooze", until: NOW + SNOOZE_MAX_MS + 1 }, [], NOW)).toEqual(refused);
    expect(applyMark("s", { ...NO_MARKS, archivedAt: 1 }, { kind: "snooze", until: NOW + HOUR }, [], NOW)).toEqual(refused);
    expect(ok(applyMark("s", { ...NO_MARKS, settledAt: 1 }, { kind: "snooze", until: NOW + SNOOZE_MAX_MS }, [], NOW)).marks).toEqual({
      ...NO_MARKS,
      snoozedUntil: NOW + SNOOZE_MAX_MS,
    });
    expect(ok(applyMark("s", { ...NO_MARKS, snoozedUntil: NOW + 1 }, { kind: "wake" }, [], NOW)).marks).toEqual(NO_MARKS);
  });

  it("restores what Undo captured: the place among the pins, archive, settle and snooze", () => {
    const before: Marks = { ...NO_MARKS, pinRank: 2, snoozedUntil: NOW + HOUR };
    const pins = ["a", "s", "b"];
    const state = markStateOf("s", before, pins, NOW);
    expect(state).toEqual({ pinned: true, pinBefore: "b", archived: false, settled: false, snoozedUntil: NOW + HOUR });
    const archived = ok(applyMark("s", before, { kind: "archive" }, pins, NOW));
    expect(applyMark("s", archived.marks, { kind: "restore", state }, archived.pins ?? pins, NOW + 1000)).toEqual({
      ok: true,
      marks: before,
      pins,
    });
  });

  it("restore drops a snooze whose time has passed and refuses a pin past the limit", () => {
    const state = { pinned: false, pinBefore: null, archived: false, settled: false, snoozedUntil: NOW - 1 };
    expect(ok(applyMark("s", NO_MARKS, { kind: "restore", state }, [], NOW)).marks.snoozedUntil).toBeNull();
    expect(applyMark("s", NO_MARKS, { kind: "restore", state: { ...state, pinned: true } }, fifty, NOW)).toEqual({
      ok: false,
      code: "limit_reached",
    });
  });

  it("isSnoozed compares with now", () => {
    expect([null, NOW, NOW + 1].map((snoozedUntil) => isSnoozed({ snoozedUntil }, NOW))).toEqual([false, false, true]);
  });
});
```

`packages/contracts/src/shell.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MarkChange } from "./marks.ts";
import { ProjectChange, ProjectSummary, SHELL_LIMITS, ShellSession, ShellStreamEvent } from "./shell.ts";

const session = {
  id: "s1",
  cwd: "/w/api",
  name: null,
  preview: "fix the tests",
  status: "idle",
  needsInput: false,
  projectId: "p1",
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 2,
} as const;
const project = { id: "p1", root: "/w/api", name: "api", position: 1.5, sessions: 3 } as const;

describe("shell schemas (M4)", () => {
  it("parses a snapshot and every live event", () => {
    const events = [
      { kind: "snapshot", projects: [project], sessions: [session], more: 7, archived: 2 },
      { kind: "session", session },
      { kind: "project", project },
      { kind: "counts", archived: 3 },
    ];
    for (const event of events) expect(ShellStreamEvent.parse(event)).toEqual(event);
    expect(ShellStreamEvent.safeParse({ kind: "nope" }).success).toBe(false);
  });

  it("bounds pins, times, previews and names (M4R17)", () => {
    const bad = [
      { pinRank: 0 },
      { pinRank: SHELL_LIMITS.pins + 1 },
      { archivedAt: -1 },
      { snoozedUntil: 8.64e15 + 1 },
      { settledAt: 1.5 },
      { preview: "x".repeat(SHELL_LIMITS.preview * 2 + 1) },
      { id: "" },
      { projectId: "p".repeat(129) },
    ];
    for (const patch of bad) expect(ShellSession.safeParse({ ...session, ...patch }).success, JSON.stringify(patch)).toBe(false);
    expect(ProjectSummary.safeParse({ ...project, sessions: -1 }).success).toBe(false);
    expect(ProjectSummary.safeParse({ ...project, root: "" }).success).toBe(false);
  });

  it("refuses a snapshot past its session bound", () => {
    const sessions = Array.from({ length: SHELL_LIMITS.sessions + SHELL_LIMITS.pins + 1 }, (_, i) => ({ ...session, id: `s${i}` }));
    expect(ShellStreamEvent.safeParse({ kind: "snapshot", projects: [], sessions, more: 0, archived: 0 }).success).toBe(false);
  });

  it("decodes every mark change and refuses an unknown one", () => {
    const changes = [
      { kind: "pin", before: null },
      { kind: "pin", before: "s2" },
      { kind: "unpin" },
      { kind: "archive" },
      { kind: "unarchive" },
      { kind: "settle" },
      { kind: "unsettle" },
      { kind: "snooze", until: 1_800_000_000_000 },
      { kind: "wake" },
      { kind: "restore", state: { pinned: true, pinBefore: null, archived: false, settled: false, snoozedUntil: null } },
    ];
    for (const change of changes) expect(MarkChange.parse(change)).toEqual(change);
    expect(MarkChange.safeParse({ kind: "delete" }).success).toBe(false);
    expect(MarkChange.safeParse({ kind: "snooze", until: "tomorrow" }).success).toBe(false);
  });

  it("bounds a project rename and a move", () => {
    expect(ProjectChange.safeParse({ kind: "rename", name: "" }).success).toBe(false);
    expect(ProjectChange.safeParse({ kind: "rename", name: "x".repeat(SHELL_LIMITS.projectName * 2 + 1) }).success).toBe(false);
    expect(ProjectChange.parse({ kind: "move", before: null })).toEqual({ kind: "move", before: null });
  });
});
```

`errors.test.ts`: add `expect(ERROR_MESSAGES.limit_reached).toBe("This list is full. Remove an entry first.");`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts`
Expected: FAIL — the files do not exist; `limit_reached` is unknown.

- [ ] **Step 3: Implement**

`packages/contracts/src/marks.ts`:

```ts
import { z } from "zod";

/** Pinned sessions per owner (M4R15). */
export const MAX_PINS = 50;
/** A snooze ends at least a minute and at most 366 days from now. */
export const SNOOZE_MIN_MS = 60_000;
export const SNOOZE_MAX_MS = 366 * 86_400_000;

const Id = z.string().min(1).max(128);
const Millis = z.number().int().min(0).max(8.64e15);

/** How a session stood before a change, so Undo can put it back, its place among the pins included (T3). */
export const MarkState = z.object({
  pinned: z.boolean(),
  /** The pinned session it stood before; null when it was the last pin or not pinned. */
  pinBefore: Id.nullable(),
  archived: z.boolean(),
  settled: z.boolean(),
  snoozedUntil: Millis.nullable(),
});
export type MarkState = z.infer<typeof MarkState>;

export const MarkChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pin"), before: Id.nullable() }),
  z.object({ kind: z.literal("unpin") }),
  z.object({ kind: z.literal("archive") }),
  z.object({ kind: z.literal("unarchive") }),
  z.object({ kind: z.literal("settle") }),
  z.object({ kind: z.literal("unsettle") }),
  z.object({ kind: z.literal("snooze"), until: Millis }),
  z.object({ kind: z.literal("wake") }),
  z.object({ kind: z.literal("restore"), state: MarkState }),
]);
export type MarkChange = z.infer<typeof MarkChange>;

/** How the sidebar files a session, as the sessions table keeps it. */
export interface Marks {
  readonly pinRank: number | null;
  readonly archivedAt: number | null;
  readonly settledAt: number | null;
  /** Settled by the 3-day rule rather than by the person. */
  readonly settledAuto: boolean;
  /** When the person last un-settled it; the 3-day rule counts from here too. */
  readonly unsettledAt: number | null;
  readonly snoozedUntil: number | null;
}

export const NO_MARKS: Marks = {
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: null,
};

export type MarkOutcome =
  | {
      readonly ok: true;
      readonly marks: Marks;
      /** The owner's pins after the change, first first; null when their order did not change. */
      readonly pins: readonly string[] | null;
    }
  | { readonly ok: false; readonly code: "bad_request" | "limit_reached" };

const without = (pins: readonly string[], id: string): string[] => pins.filter((pin) => pin !== id);

/** `id` among the pins, before `before`; last when `before` is null, unknown or `id` itself. */
function pinnedBefore(pins: readonly string[], id: string, before: string | null): string[] {
  const rest = without(pins, id);
  const at = before === null || before === id ? -1 : rest.indexOf(before);
  return at === -1 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

const rankIn = (pins: readonly string[], id: string): number | null => {
  const at = pins.indexOf(id);
  return at === -1 ? null : at + 1;
};

const samePins = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((pin, i) => pin === b[i]);

/**
 * The marks of session `id` after `change` (M4R14, M4R15): the one rule set, used by the daemon to write and by the
 * browser to show the change before the answer. `pins` are the owner's pinned sessions, first first.
 */
export function applyMark(
  id: string,
  current: Marks,
  change: MarkChange,
  pins: readonly string[],
  now: number,
): MarkOutcome {
  const unpinned = (marks: Marks): MarkOutcome => {
    const next = without(pins, id);
    return { ok: true, marks: { ...marks, pinRank: null }, pins: next.length === pins.length ? null : next };
  };
  const full = (pinned: boolean) => pinned && !pins.includes(id) && pins.length >= MAX_PINS;
  switch (change.kind) {
    case "pin": {
      if (full(true)) return { ok: false, code: "limit_reached" };
      const next = pinnedBefore(pins, id, change.before);
      // A pinned session is one the person keeps in view: no longer archived or settled.
      const marks = { ...current, pinRank: rankIn(next, id), archivedAt: null, settledAt: null, settledAuto: false };
      return { ok: true, marks, pins: next };
    }
    case "unpin":
      return unpinned(current);
    case "archive":
      return unpinned({ ...current, archivedAt: current.archivedAt ?? now, snoozedUntil: null });
    case "unarchive":
      return { ok: true, marks: { ...current, archivedAt: null }, pins: null };
    case "settle":
      return unpinned({ ...current, settledAt: current.settledAt ?? now, settledAuto: false, snoozedUntil: null });
    case "unsettle":
      return { ok: true, marks: { ...current, settledAt: null, settledAuto: false, unsettledAt: now }, pins: null };
    case "snooze": {
      const early = change.until < now + SNOOZE_MIN_MS;
      const late = change.until > now + SNOOZE_MAX_MS;
      if (current.archivedAt !== null || early || late) return { ok: false, code: "bad_request" };
      const marks = { ...current, snoozedUntil: change.until, settledAt: null, settledAuto: false };
      return { ok: true, marks, pins: null };
    }
    case "wake":
      return { ok: true, marks: { ...current, snoozedUntil: null }, pins: null };
    case "restore": {
      const { state } = change;
      if (full(state.pinned)) return { ok: false, code: "limit_reached" };
      const after = state.pinned ? pinnedBefore(pins, id, state.pinBefore) : without(pins, id);
      const marks: Marks = {
        pinRank: rankIn(after, id),
        archivedAt: state.archived ? (current.archivedAt ?? now) : null,
        settledAt: state.settled ? (current.settledAt ?? now) : null,
        settledAuto: state.settled ? current.settledAuto : false,
        unsettledAt: current.unsettledAt,
        snoozedUntil: state.snoozedUntil !== null && state.snoozedUntil > now ? state.snoozedUntil : null,
      };
      return { ok: true, marks, pins: samePins(after, pins) ? null : after };
    }
  }
}

/** What Undo sends back to restore session `id` as it stands now. */
export function markStateOf(id: string, marks: Marks, pins: readonly string[], now: number): MarkState {
  const at = pins.indexOf(id);
  return {
    pinned: at !== -1,
    pinBefore: at === -1 ? null : (pins[at + 1] ?? null),
    archived: marks.archivedAt !== null,
    settled: marks.settledAt !== null,
    snoozedUntil: isSnoozed(marks, now) ? marks.snoozedUntil : null,
  };
}

/** A snooze ends when its time comes; the browser does not wait for the daemon's timer to show that. */
export const isSnoozed = (marks: Pick<Marks, "snoozedUntil">, now: number): boolean =>
  marks.snoozedUntil !== null && marks.snoozedUntil > now;
```

`packages/contracts/src/shell.ts`:

```ts
import { z } from "zod";
import { MAX_PINS } from "./marks.ts";
import { SessionName, SessionStatus } from "./streams.ts";

/** The bounds of the sidebar's data (M4): what one snapshot, page or search answer may carry. */
export const SHELL_LIMITS = {
  /** Sessions in a `shell` snapshot and in the browser's store, besides the pinned ones. */
  sessions: 500,
  pins: MAX_PINS,
  projects: 500,
  /** Code points of a project's display name. */
  projectName: 128,
  /** Code points of a session's preview: the start of its first user message. */
  preview: 120,
  archivedPage: 100,
  searchQuery: 256,
  searchHits: 20,
  /** UTF-16 units of a search snippet, its markers included. */
  snippet: 400,
} as const;

const Id = z.string().min(1).max(128);
/** Milliseconds since 1970, within what `Date` holds (M4R17). */
const Millis = z.number().int().min(0).max(8.64e15);

export const ProjectSummary = z.object({
  id: Id,
  /** The git root of its sessions' folder, or that folder outside git (`policy.scopeOf`, M2R68). */
  root: z.string().min(1).max(4096),
  name: z.string().min(1).max(SHELL_LIMITS.projectName * 2),
  /** The person's order: lower first (fractional, so a move rewrites one row). */
  position: z.number().finite(),
  /** Its sessions that are not archived. */
  sessions: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ShellSession = z.object({
  id: Id,
  cwd: z.string().max(4096),
  name: SessionName.nullable(),
  /** The start of the first user message (cleaned like a name); null until there is one. */
  preview: z.string().max(SHELL_LIMITS.preview * 2).nullable(),
  status: SessionStatus,
  /** An approval or an extension dialog waits for an answer. */
  needsInput: z.boolean(),
  projectId: Id.nullable(),
  /** 1 for the first pinned session; null when not pinned. */
  pinRank: z.number().int().min(1).max(SHELL_LIMITS.pins).nullable(),
  archivedAt: Millis.nullable(),
  settledAt: Millis.nullable(),
  snoozedUntil: Millis.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ShellSession = z.infer<typeof ShellSession>;

export const ShellStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    /** The projects its sessions belong to. */
    projects: z.array(ProjectSummary).max(SHELL_LIMITS.sessions + SHELL_LIMITS.pins),
    /** Pinned first by rank, then the newest that are not archived. */
    sessions: z.array(ShellSession).max(SHELL_LIMITS.sessions + SHELL_LIMITS.pins),
    /** Sessions not archived that it left out (older than the window, or over the byte budget). */
    more: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("session"), session: ShellSession }),
  z.object({ kind: z.literal("project"), project: ProjectSummary }),
  z.object({ kind: z.literal("counts"), archived: z.number().int().nonnegative() }),
]);
export type ShellStreamEvent = z.infer<typeof ShellStreamEvent>;

export const ProjectChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rename"), name: z.string().min(1).max(SHELL_LIMITS.projectName * 2) }),
  z.object({ kind: z.literal("move"), before: Id.nullable() }),
]);
export type ProjectChange = z.infer<typeof ProjectChange>;

/** The methods of the sidebar and search, each added by the task that implements it (M4R18). */
export const shellMethods = {} as const;
```

`methods.ts`: `import { shellMethods } from "./shell.ts";` and `...shellMethods,` right after `...settingsMethods,`. `index.ts`: `export * from "./marks.ts";` and `export * from "./shell.ts";` (alphabetical with the others). `streams.ts`: `export const STREAMS = ["session", "shell"] as const;`. `errors.ts`: `"limit_reached"` after `"command_failed"` in `ERROR_CODES` and `limit_reached: "This list is full. Remove an entry first."` in `ERROR_MESSAGES`.

`apps/web/src/i18n/catalog/shell.ts`: `"error.limit_reached": "This list is full. Remove an entry first."` in `shellEn`, `"error.limit_reached": "Cette liste est pleine. Retirez-en un élément d'abord."` in `shellFr`.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm test:unit && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS (the web's i18n tests see the new key in both languages; nothing else changed).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/contracts apps/web/src/i18n/catalog/shell.ts
git commit -m "feat(contracts): mark rules, shell stream schemas and the limit_reached error for the sidebar"
```

---

### Task 6: The `projects` module (D02) — projects as git roots, a name, an order, and `projects.update`

A project is the git root of a session's folder, or the folder itself outside git: the same scope `policy.scopeOf` gives "always" rules (M2R68), so a project's rules and its sessions line up. A project row is made the first time a session needs it, at the top of the list; the person renames and reorders projects.

**Files:**
- Create: `apps/daemon/src/modules/projects/{index.ts,store.ts,service.ts,rpc.ts}`, `migrations/202610121510_projects.sql`
- Create: `apps/daemon/src/modules/projects/{service.test.ts,rpc.test.ts}`, `apps/daemon/src/modules/projects/testing/bed.ts`
- Create: `apps/daemon/src/daemon.projects.int.test.ts`
- Modify: `packages/contracts/src/shell.ts` (`projects.update` in `shellMethods`), `packages/contracts/src/methods.test.ts` (mutation list), `apps/daemon/src/daemon.ts`

**Interfaces:**
- Consumes: Task 1 `cleanLabel`; Task 5 `ProjectChange`, `SHELL_LIMITS`.
- Produces: `PROJECTS_MIGRATIONS`, `createProjectsModule({ db, clock, logger, newId }): { rpc: ProjectsRpc; port: ProjectsPort }`, `interface ProjectsPort { ensure(ownerId, root): ProjectView | null; list(ownerId, ids: readonly string[]): ProjectView[]; onChange(listener: (ownerId: string, project: ProjectView) => void): () => void }`, `interface ProjectView { id; root; name; position }`, `MAX_PROJECTS = 2000`. Contract: `projects.update { projectId, change } → { ok: true }`.

**Rulings (pre-dispatch):**
- M4R20: Projects are made on demand from a session's folder, never by hand in M4; `projects.update` renames and moves — pi-web's groups by folder or repository, D02 — cost if wrong: a "new project" action later.
- M4R21: A new project goes above all others (`min(position) − 1`); positions are fractional: a move writes the moved project only (`(previous + next) / 2`, or last + 1), and the order is renumbered 1..n only when a gap falls under 1e-6 — every write publishes what changed on the `shell` stream; renumbering on every move would publish every project — cost if wrong: none.
- M4R22: At most 2000 projects per owner; past that `ensure` answers null (the session has no project and the tree shows it under "Other"), logged `projects_full` at most once a minute — a script walking thousands of folders must not grow the table without end — cost if wrong: sessions of folder 2001+ grouped under "Other".
- M4R23: A project name is `cleanLabel(name, 128)`; empty after cleaning is `bad_request`; the default name is the folder's base name (`/` for the root) — the same clean as session names (M2R92) — cost if wrong: none.
- M4R24: `projects.update` answers `{ ok: true }`: the new state comes over the `shell` stream like every other change, and the browser shows it before the answer (optimistic) — one source of truth — cost if wrong: none.
- M4R25: Another owner's project is `not_found`, the same as an unknown id — existence does not leak (as `policy.revokeRule`) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/modules/projects/testing/bed.ts`: a copy of the policy bed's shape (`createPolicyBed` in `modules/policy/testing/bed.ts`) with `sources: [KERNEL_MIGRATIONS, PROJECTS_MIGRATIONS]` and ids `p1`, `p2`… (`newId`), exporting `createProjectsBed()` with `{ db, clock, logger, lines, newId, dispose }`.

`apps/daemon/src/modules/projects/service.test.ts`:

```ts
import { ALL_PERMISSIONS, type Caller, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectsService, MAX_PROJECTS } from "./service.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

const caller = (userId: string): Caller => ({ userId, permissions: new Set(ALL_PERMISSIONS) });
let bed: ReturnType<typeof createProjectsBed>;
let service: ReturnType<typeof createProjectsService>;
let changes: Array<[string, unknown]>;

beforeEach(() => {
  bed = createProjectsBed();
  service = createProjectsService({ store: createProjectsStore(bed.db), clock: bed.clock, logger: bed.logger, newId: bed.newId });
  changes = [];
  service.onChange((ownerId, project) => changes.push([ownerId, project]));
});
afterEach(() => bed.dispose());

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
  return undefined;
};

describe("projects", () => {
  it("makes a project once per owner and root, named after its folder, each new one on top", () => {
    expect(service.ensure("u1", "/w/api")).toEqual({ id: "p1", root: "/w/api", name: "api", position: -1 });
    expect(service.ensure("u1", "/w/web")).toEqual({ id: "p2", root: "/w/web", name: "web", position: -2 });
    expect(service.ensure("u1", "/w/api")?.id).toBe("p1");
    expect(service.ensure("u2", "/w/api")?.id).toBe("p3");
    expect(changes.map(([owner, project]) => [owner, (project as { id: string }).id])).toEqual([
      ["u1", "p1"],
      ["u1", "p2"],
      ["u2", "p3"],
    ]);
    expect(service.ensure("u1", "/")?.name).toBe("/");
  });

  it("answers null for a root it cannot use", () => {
    for (const root of ["relative/dir", "", "/a\u0000b", "/a\nb", `/${"a".repeat(4096)}`])
      expect(service.ensure("u1", root), JSON.stringify(root)).toBeNull();
  });

  it("answers null past MAX_PROJECTS, and says so once a minute", () => {
    const store = createProjectsStore(bed.db);
    for (let i = 0; i < MAX_PROJECTS; i++)
      store.insert({ id: `x${i}`, ownerId: "u1", root: `/r/${i}`, name: `r${i}`, position: i, createdAt: 0 });
    expect(service.ensure("u1", "/w/new")).toBeNull();
    expect(service.ensure("u1", "/w/new2")).toBeNull();
    expect(bed.lines.filter((line) => line.msg === "projects_full")).toHaveLength(1);
  });

  it("renames with a clean name, refuses an empty one and another owner's project", () => {
    service.ensure("u1", "/w/api");
    changes = [];
    service.update(caller("u1"), "p1", { kind: "rename", name: "  The\u202E   API\n" });
    expect(service.list("u1", ["p1"])).toEqual([{ id: "p1", root: "/w/api", name: "The API", position: -1 }]);
    expect(changes).toHaveLength(1);
    expect(codeOf(() => service.update(caller("u1"), "p1", { kind: "rename", name: "\u200B" }))).toBe("bad_request");
    expect(codeOf(() => service.update(caller("u2"), "p1", { kind: "rename", name: "x" }))).toBe("not_found");
    expect(codeOf(() => service.update(caller("u1"), "nope", { kind: "move", before: null }))).toBe("not_found");
  });

  it("moves one project and publishes that one only", () => {
    for (const root of ["/w/a", "/w/b", "/w/c"]) service.ensure("u1", root); // a -1, b -2, c -3: order c, b, a
    changes = [];
    service.update(caller("u1"), "p1", { kind: "move", before: "p3" }); // a above c
    expect(service.list("u1", ["p1", "p2", "p3"]).map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
    expect(changes.map(([, project]) => (project as { id: string }).id)).toEqual(["p1"]);
    service.update(caller("u1"), "p3", { kind: "move", before: null }); // c last
    expect(service.list("u1", ["p1", "p2", "p3"]).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("renumbers when two positions get too close, and then publishes every project", () => {
    const store = createProjectsStore(bed.db);
    store.insert({ id: "a", ownerId: "u1", root: "/a", name: "a", position: 1, createdAt: 0 });
    store.insert({ id: "b", ownerId: "u1", root: "/b", name: "b", position: 1 + 5e-7, createdAt: 0 });
    store.insert({ id: "c", ownerId: "u1", root: "/c", name: "c", position: 2, createdAt: 0 });
    service.update(caller("u1"), "c", { kind: "move", before: "b" });
    expect(service.list("u1", ["a", "b", "c"])).toEqual([
      { id: "a", root: "/a", name: "a", position: 1 },
      { id: "c", root: "/c", name: "c", position: 2 },
      { id: "b", root: "/b", name: "b", position: 3 },
    ]);
    expect(changes).toHaveLength(3);
  });

  it("a listener that throws does not stop the others, and a removed one hears nothing", () => {
    const after = vi.fn();
    service.onChange(() => {
      throw new Error("boom");
    });
    const off = service.onChange(after);
    service.ensure("u1", "/w/x");
    off();
    service.ensure("u1", "/w/y");
    expect(after).toHaveBeenCalledOnce();
    expect(bed.lines.some((line) => line.msg === "projects_listener_failed")).toBe(true);
  });
});
```

`rpc.test.ts`: `projectsRpc(service)["projects.update"]({ projectId: "p1", change: { kind: "move", before: null } }, ctx)` resolves `{ ok: true }` and calls `service.update` with `ctx.caller`, `"p1"` and the change (a `vi.fn` service).

`apps/daemon/src/daemon.projects.int.test.ts` (in the style of `daemon.settings.int.test.ts`): over `/ws`, `projects.update` on `"nope"` answers `not_found`; `{ kind: "rename", name: "" }` answers `bad_request`.

`methods.test.ts`: the sorted mutation list gains `"projects.update"`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/projects packages/contracts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

`migrations/202610121510_projects.sql`:

```sql
-- D02 (M4): a project is the git root of its sessions' folder, or that folder outside git (the scope of "always" rules).
-- Made the first time a session needs it; the person names and orders them. Positions are fractional: a move writes one row.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  root TEXT NOT NULL CHECK (length(root) BETWEEN 1 AND 4096),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  position REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, root)
) STRICT;

CREATE INDEX projects_owner ON projects(owner_id, position);
```

`store.ts`:

```ts
import type { Db } from "../../kernel/db/database.ts";

export interface ProjectRow {
  readonly id: string;
  readonly ownerId: string;
  readonly root: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

export interface ProjectsStore {
  byRoot(ownerId: string, root: string): ProjectRow | undefined;
  get(ownerId: string, id: string): ProjectRow | undefined;
  /** In the person's order. */
  list(ownerId: string): ProjectRow[];
  byIds(ownerId: string, ids: readonly string[]): ProjectRow[];
  count(ownerId: string): number;
  /** The lowest position, null without projects. */
  firstPosition(ownerId: string): number | null;
  insert(row: ProjectRow): void;
  rename(ownerId: string, id: string, name: string): void;
  setPosition(ownerId: string, id: string, position: number): void;
  /** Positions 1..n in this order, in one transaction. */
  renumber(ownerId: string, orderedIds: readonly string[]): void;
}

const COLUMNS = "id, owner_id AS ownerId, root, name, position, created_at AS createdAt";

export function createProjectsStore(db: Db): ProjectsStore {
  const setPosition = (ownerId: string, id: string, position: number) => {
    db.run("UPDATE projects SET position = $position WHERE owner_id = $ownerId AND id = $id", { ownerId, id, position });
  };
  return {
    byRoot: (ownerId, root) =>
      db.get<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId AND root = $root`, { ownerId, root }),
    get: (ownerId, id) =>
      db.get<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId AND id = $id`, { ownerId, id }),
    list: (ownerId) =>
      db.all<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId ORDER BY position, id`, { ownerId }),
    byIds: (ownerId, ids) =>
      ids.length === 0
        ? []
        : db.all<ProjectRow>(
            `SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId AND id IN (SELECT value FROM json_each($ids)) ORDER BY position, id`,
            { ownerId, ids: JSON.stringify(ids) },
          ),
    count: (ownerId) => db.get<{ n: number }>("SELECT count(*) AS n FROM projects WHERE owner_id = $ownerId", { ownerId })?.n ?? 0,
    firstPosition: (ownerId) =>
      db.get<{ p: number | null }>("SELECT min(position) AS p FROM projects WHERE owner_id = $ownerId", { ownerId })?.p ?? null,
    insert: (row) => {
      db.run(
        "INSERT INTO projects (id, owner_id, root, name, position, created_at) VALUES ($id, $ownerId, $root, $name, $position, $createdAt)",
        { ...row },
      );
    },
    rename: (ownerId, id, name) => {
      db.run("UPDATE projects SET name = $name WHERE owner_id = $ownerId AND id = $id", { ownerId, id, name });
    },
    setPosition,
    renumber: (ownerId, orderedIds) =>
      db.transaction(() => orderedIds.forEach((id, index) => setPosition(ownerId, id, index + 1))),
  };
}
```

`service.ts`:

```ts
import { basename, isAbsolute } from "node:path";
import { type Caller, PapError, type ProjectChange, SHELL_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { cleanLabel } from "../../kernel/text.ts";
import type { ProjectRow, ProjectsStore } from "./store.ts";

/** Projects per owner (M4R22). */
export const MAX_PROJECTS = 2000;
const MAX_ROOT = 4096;
/** Two neighbours closer than this are renumbered 1..n (M4R21). */
const MIN_GAP = 1e-6;

export interface ProjectView {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly position: number;
}

const viewOf = (row: ProjectRow): ProjectView => ({ id: row.id, root: row.root, name: row.name, position: row.position });
// C0 controls, NUL included: a root is a real path, and a path with a control character is not one pap makes a project of.
const hasControl = (text: string): boolean => [...text].some((char) => (char.codePointAt(0) ?? 0x20) < 0x20);
const defaultName = (root: string): string =>
  cleanLabel(basename(root), SHELL_LIMITS.projectName) ?? cleanLabel(root, SHELL_LIMITS.projectName) ?? "/";

export function createProjectsService(deps: {
  readonly store: ProjectsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  newId(): string;
}) {
  const listeners = new Set<(ownerId: string, project: ProjectView) => void>();
  const limiter = createRateLimiter(deps.clock, 60_000);
  // A listener that fails (the shell publisher, say) must not stop the others nor fail the change that called it.
  const changed = (ownerId: string, project: ProjectView) => {
    for (const listener of [...listeners]) {
      try {
        listener(ownerId, project);
      } catch (error) {
        deps.logger.warn("projects_listener_failed", { err: error });
      }
    }
  };
  const owned = (ownerId: string, id: string): ProjectRow => {
    const row = deps.store.get(ownerId, id);
    if (!row) throw new PapError("not_found");
    return row;
  };

  /** The fractional position that puts a project before `before` (last when null or unknown), or null when too tight. */
  function placeBefore(ownerId: string, id: string, before: string | null): number | null {
    const order = deps.store.list(ownerId).filter((row) => row.id !== id);
    const at = before === null ? -1 : order.findIndex((row) => row.id === before);
    if (at === -1) return (order.at(-1)?.position ?? 0) + 1;
    const next = order[at] as ProjectRow;
    const previous = order[at - 1];
    if (!previous) return next.position - 1;
    const position = (previous.position + next.position) / 2;
    return next.position - previous.position < MIN_GAP ? null : position;
  }

  return {
    /** The owner's project for `root`, made on first use at the top; null for a root it cannot use or a full table. */
    ensure(ownerId: string, root: string): ProjectView | null {
      if (!isAbsolute(root) || root.length > MAX_ROOT || hasControl(root)) return null;
      const found = deps.store.byRoot(ownerId, root);
      if (found) return viewOf(found);
      if (deps.store.count(ownerId) >= MAX_PROJECTS) {
        const said = limiter.check("projects_full");
        if (said.allowed) deps.logger.warn("projects_full", { max: MAX_PROJECTS, suppressed: said.suppressed });
        return null;
      }
      const row: ProjectRow = {
        id: deps.newId(),
        ownerId,
        root,
        name: defaultName(root),
        position: (deps.store.firstPosition(ownerId) ?? 0) - 1,
        createdAt: deps.clock.now(),
      };
      deps.store.insert(row);
      const view = viewOf(row);
      changed(ownerId, view);
      return view;
    },
    list: (ownerId: string, ids: readonly string[]): ProjectView[] => deps.store.byIds(ownerId, ids).map(viewOf),
    update(caller: Caller, projectId: string, change: ProjectChange): void {
      const row = owned(caller.userId, projectId);
      if (change.kind === "rename") {
        const name = cleanLabel(change.name, SHELL_LIMITS.projectName);
        if (name === null) throw new PapError("bad_request");
        deps.store.rename(caller.userId, row.id, name);
        changed(caller.userId, viewOf(owned(caller.userId, row.id)));
        return;
      }
      const position = placeBefore(caller.userId, row.id, change.before);
      if (position !== null) {
        deps.store.setPosition(caller.userId, row.id, position);
        changed(caller.userId, viewOf(owned(caller.userId, row.id)));
        return;
      }
      // Too tight to split: renumber the order with the project in its new place, and publish every position.
      const order = deps.store.list(caller.userId).map((project) => project.id).filter((id) => id !== row.id);
      const at = change.before === null ? -1 : order.indexOf(change.before);
      order.splice(at === -1 ? order.length : at, 0, row.id);
      deps.store.renumber(caller.userId, order);
      for (const project of deps.store.list(caller.userId)) changed(caller.userId, viewOf(project));
    },
    onChange(listener: (ownerId: string, project: ProjectView) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type ProjectsService = ReturnType<typeof createProjectsService>;
```

`rpc.ts`:

```ts
import type { HandlerTable } from "@pap/contracts";
import type { ProjectsService } from "./service.ts";

export type ProjectsRpc = Pick<HandlerTable, "projects.update">;

export function projectsRpc(service: ProjectsService): ProjectsRpc {
  return {
    "projects.update": async ({ projectId, change }, ctx) => {
      service.update(ctx.caller, projectId, change);
      return { ok: true as const };
    },
  };
}
```

`index.ts`:

```ts
import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { projectsRpc, type ProjectsRpc } from "./rpc.ts";
import { createProjectsService, type ProjectView } from "./service.ts";
import { createProjectsStore } from "./store.ts";

export const PROJECTS_MIGRATIONS: MigrationSource = {
  module: "projects",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

/** What the sessions module asks of projects: one per session folder's scope, their views, and their changes. */
export interface ProjectsPort {
  ensure(ownerId: string, root: string): ProjectView | null;
  list(ownerId: string, ids: readonly string[]): ProjectView[];
  onChange(listener: (ownerId: string, project: ProjectView) => void): () => void;
}

export interface ProjectsModule {
  readonly rpc: ProjectsRpc;
  readonly port: ProjectsPort;
}

export function createProjectsModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  newId(): string;
}): ProjectsModule {
  const service = createProjectsService({
    store: createProjectsStore(deps.db),
    clock: deps.clock,
    logger: deps.logger.child({ module: "projects" }),
    newId: deps.newId,
  });
  return { rpc: projectsRpc(service), port: { ensure: service.ensure, list: service.list, onChange: service.onChange } };
}
```

(`ProjectView` is re-exported from `index.ts` in Task 7, when the sessions module first imports it.)

`shell.ts` (contracts), inside `shellMethods`:

```ts
  "projects.update": defineMethod({
    name: "projects.update",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ projectId: Id, change: ProjectChange }),
    // The new state comes over the `shell` stream (M4R24).
    result: z.object({ ok: z.literal(true) }),
    // Another owner's project is `not_found` too (M4R25); `bad_request`: a name that is empty once cleaned.
    errors: ["not_found", "bad_request"],
  }),
```

(`defineMethod` from `./define.ts`; move the `ProjectChange` declaration above `shellMethods`.)

`daemon.ts`: import `createProjectsModule, PROJECTS_MIGRATIONS` from `./modules/projects/index.ts`; `PROJECTS_MIGRATIONS` joins `sources` after `POLICY_MIGRATIONS`; `const projects = createProjectsModule({ db, clock, logger, newId });` right after the policy module; `...projects.rpc` in `handlers`. (`projects.port` is passed to sessions in Task 7.)

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm test:unit apps/daemon packages/contracts && pnpm test:int apps/daemon/src/daemon.projects.int.test.ts && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS. Mutation check: drop the `MIN_GAP` branch → the renumber case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/projects apps/daemon/src/daemon.ts apps/daemon/src/daemon.projects.int.test.ts packages/contracts
git commit -m "feat(projects): projects as git roots with a name and an order, made on demand, and projects.update"
```

---

### Task 7: Marks on the sessions table, and the project of every session

The new columns of the `sessions` table (sessions module, additive migration), one store for them, the project of each new, forked and existing session, and a pure move of `launch` out of `service.ts` (376 lines; the M2 ledger's carry: "first move launch/bindPiFile into service-launch.ts").

**Files:**
- Create: `apps/daemon/src/modules/sessions/migrations/202610121500_session_marks.sql`
- Create: `apps/daemon/src/modules/sessions/{service-launch.ts,marks-store.ts,project-link.ts}`, tests `marks-store.test.ts`, `project-link.test.ts`
- Create: `apps/daemon/src/modules/sessions/testing/fake-projects.ts`
- Modify: `apps/daemon/src/modules/sessions/{service.ts,store.ts,index.ts}`, `testing/service-bed.ts` (a `projects` option), `service.test.ts` and `service.forks.test.ts` (one case each)
- Modify: `apps/daemon/src/modules/projects/index.ts` (re-export `ProjectView`), `apps/daemon/src/daemon.ts` (`projects: projects.port` for sessions)

**Interfaces:**
- Consumes: Task 5 `Marks`; Task 6 `ProjectsPort`, `ProjectView`; `PolicyPort.scopeOf`.
- Produces:
  - `createLaunch(ctx: LaunchContext): { launch(row: SessionRow, isNew: boolean, projectId?: string | null): Promise<LiveSession>; ensureLive(row: SessionRow): Promise<LiveSession> }` with `interface LaunchContext { deps: SessionsServiceDeps; live: Map<string, LiveSession>; reopening: Map<string, Promise<LiveSession>>; starting: Set<LiveSession>; grants: ReturnType<typeof createGrantLink>; checkCapacity(): void; onPublished?(sessionId: string, event: SessionStreamEvent): void }` (`onPublished` is used from Task 8).
  - `SessionsStore.insert(row: SessionRow, projectId?: string | null): void`.
  - `interface ShellRow { id; ownerId; cwd; name; preview; projectId; createdAt; updatedAt; marks: Marks }`; `createMarksStore(db): MarksStore` with `row(id)`, `window(ownerId, limit)`, `countActive(ownerId)`, `countArchived(ownerId)`, `activeByProject(ownerId): Map<string, number>`, `countByProject(ownerId, projectId)`, `archivedPage(ownerId, before, limit)`, `pins(ownerId)`, `write(id, marks, pins: { ownerId; order } | null)`, `setProject(id, projectId)`, `setPreview(id, preview): boolean`, `withoutProject(afterId, limit)`, `findByPiPath(path)`, `findByPiSessionId(piSessionId)`, `dueSnoozes(now, limit)`, `nextSnooze()`, `settleCandidates(cutoff, limit)`.
  - `createProjectLink({ store, projects, scopeOf, logger }): { assign(sessionId, ownerId, cwd): string | null; backfill(): number }`.
  - `SessionsServiceDeps.projects: ProjectsPort`; `SessionsModuleDeps.projects: ProjectsPort`.

**Rulings (pre-dispatch):**
- M4R26: The marks are columns of `sessions` (sessions module), not a table of the projects module — they are per-session state like `name`, and the shell snapshot reads them with the session in one indexed query; the projects table holds only projects — cost if wrong: a later split is an additive migration.
- M4R27: The move of `launch` and `ensureLive` into `service-launch.ts` is a pure move in its own commit step: every existing test passes unchanged before anything else is added — the M2 ledger carry; reviewers see a move, then additions — cost if wrong: none.
- M4R28: A session's project is computed once, when its row is stored (`policy.scopeOf(cwd)` → `projects.ensure`): created, forked and cloned sessions in this task, adopted ones in Task 14; rows stored before M4 are filled at module start in pages of 500 by id, one `scopeOf` per owner and folder — `scopeOf` costs up to 64 `stat` calls and must not run per snapshot — cost if wrong: a session whose folder became a git repository later stays in its old project (a rename of the folder or a later "move to project" fixes it; not in M4).
- M4R29: A session whose project could not be made (a full table, an unusable folder) keeps `project_id` NULL and the backfill pages past it by id, so it never loops — cost if wrong: none.
- M4R30: Indexes: `pi_session_id` (adoption looks sessions up by Pi id), `(owner_id, archived_at, updated_at DESC)` (the snapshot window), `(owner_id, project_id)` (project counts), and `snoozed_until` where not null (the wake timer) — the queries of Tasks 8–14 at 10 000 sessions — cost if wrong: slower writes (four small indexes).

- [ ] **Step 1: Move `launch` (pure move)**

Create `service-launch.ts` and move into `createLaunch(ctx)` the body of `launch` and `ensureLive` (`service.ts` lines 157–254 at `main` 4e85dd0) and the `createStoreSync` call they use; `service.ts` keeps `checkCapacity`, `owned`, `openWorker`, `statusOf`, and builds `const { launch, ensureLive } = createLaunch({ deps, live, reopening, starting, grants, checkCapacity })`. No other change.

Run: `pnpm test:unit apps/daemon/src/modules/sessions && pnpm test:int apps/daemon/src/modules/sessions && pnpm typecheck`
Expected: PASS with no test edited. `wc -l apps/daemon/src/modules/sessions/service.ts` well under 300.

- [ ] **Step 2: Write the failing tests**

`marks-store.test.ts` — a real database from `migrate` with `KERNEL_MIGRATIONS` and `SESSIONS_MIGRATIONS` in a temp dir (`afterEach` removes it), rows written with `createSessionsStore(db).insert`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_MARKS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createMarksStore, type MarksStore } from "./marks-store.ts";
import { createSessionsStore } from "./store.ts";

let dir: string;
let db: Db;
let marks: MarksStore;
const add = (id: string, updatedAt: number, extra: { ownerId?: string; piPath?: string; piId?: string; projectId?: string } = {}) =>
  createSessionsStore(db).insert(
    {
      id,
      piPath: extra.piPath ?? null,
      piSessionId: extra.piId ?? null,
      cwd: `/w/${id}`,
      ownerId: extra.ownerId ?? "u1",
      name: null,
      createdAt: 1,
      updatedAt,
    },
    extra.projectId ?? null,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-marks-"));
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
  marks = createMarksStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("marks store", () => {
  it("reads a row with no marks as NO_MARKS", () => {
    add("a", 10, { projectId: "p1" });
    expect(marks.row("a")).toEqual({
      id: "a", ownerId: "u1", cwd: "/w/a", name: null, preview: null, projectId: "p1", createdAt: 1, updatedAt: 10, marks: NO_MARKS,
    });
    expect(marks.row("nope")).toBeUndefined();
  });

  it("windows the owner's sessions: pinned by rank, then newest, archived left out", () => {
    for (const [id, at] of [["a", 10], ["b", 20], ["c", 30], ["d", 40]] as const) add(id, at);
    add("other", 99, { ownerId: "u2" });
    marks.write("a", { ...NO_MARKS, pinRank: 2 }, { ownerId: "u1", order: ["b", "a"] });
    marks.write("d", { ...NO_MARKS, archivedAt: 5 }, null);
    expect(marks.window("u1", 10).map((row) => row.id)).toEqual(["b", "a", "c"]);
    expect(marks.window("u1", 2).map((row) => row.id)).toEqual(["b", "a"]);
    expect(marks.pins("u1")).toEqual(["b", "a"]);
    expect([marks.countActive("u1"), marks.countArchived("u1")]).toEqual([3, 1]);
  });

  it("renumbers the pins it is given and unpins the owner's others", () => {
    for (const id of ["a", "b", "c"]) add(id, 1);
    marks.write("a", { ...NO_MARKS, pinRank: 1 }, { ownerId: "u1", order: ["a", "b", "c"] });
    marks.write("b", { ...NO_MARKS }, { ownerId: "u1", order: ["c", "a"] });
    expect(marks.pins("u1")).toEqual(["c", "a"]);
    expect(marks.row("b")?.marks.pinRank).toBeNull();
  });

  it("pages archived sessions newest first from a cursor", () => {
    for (const [id, at] of [["a", 3], ["b", 1], ["c", 2]] as const) {
      add(id, 1);
      marks.write(id, { ...NO_MARKS, archivedAt: at }, null);
    }
    expect(marks.archivedPage("u1", null, 2).map((row) => row.id)).toEqual(["a", "c"]);
    expect(marks.archivedPage("u1", { archivedAt: 2, id: "c" }, 2).map((row) => row.id)).toEqual(["b"]);
  });

  it("counts active sessions per project", () => {
    add("a", 1, { projectId: "p1" });
    add("b", 1, { projectId: "p1" });
    add("c", 1, { projectId: "p2" });
    add("d", 1);
    marks.write("b", { ...NO_MARKS, archivedAt: 1 }, null);
    expect([...marks.activeByProject("u1")].sort()).toEqual([["p1", 1], ["p2", 1]]);
    expect(marks.countByProject("u1", "p1")).toBe(1);
  });

  it("sets a preview once, and the project", () => {
    add("a", 1);
    expect(marks.setPreview("a", "first")).toBe(true);
    expect(marks.setPreview("a", "second")).toBe(false);
    marks.setProject("a", "p9");
    expect(marks.row("a")).toMatchObject({ preview: "first", projectId: "p9" });
  });

  it("finds a session by Pi file and by Pi id", () => {
    add("a", 1, { piPath: "/agent/sessions/x/f.jsonl", piId: "pi-1" });
    expect(marks.findByPiPath("/agent/sessions/x/f.jsonl")).toEqual({ id: "a", ownerId: "u1" });
    expect(marks.findByPiSessionId("pi-1")).toEqual({ id: "a", ownerId: "u1", piPath: "/agent/sessions/x/f.jsonl" });
    expect(marks.findByPiPath("/nope")).toBeUndefined();
  });

  it("lists sessions without a project page by page", () => {
    for (const id of ["a", "b", "c"]) add(id, 1);
    add("d", 1, { projectId: "p1" });
    expect(marks.withoutProject("", 2).map((row) => row.id)).toEqual(["a", "b"]);
    expect(marks.withoutProject("b", 2)).toEqual([{ id: "c", ownerId: "u1", cwd: "/w/c" }]);
  });

  it("finds due snoozes and the next one", () => {
    for (const id of ["a", "b", "c"]) add(id, 1);
    marks.write("a", { ...NO_MARKS, snoozedUntil: 100 }, null);
    marks.write("b", { ...NO_MARKS, snoozedUntil: 50 }, null);
    expect(marks.nextSnooze()).toBe(50);
    expect(marks.dueSnoozes(60, 10)).toEqual(["b"]);
  });

  it("offers for the 3-day rule only idle sessions that are not pinned, snoozed, settled, archived or freshly unsettled", () => {
    for (const id of ["idle", "pinned", "snoozed", "settled", "archived", "unsettled", "fresh"]) add(id, id === "fresh" ? 500 : 10);
    marks.write("pinned", { ...NO_MARKS, pinRank: 1 }, { ownerId: "u1", order: ["pinned"] });
    marks.write("snoozed", { ...NO_MARKS, snoozedUntil: 9_999 }, null);
    marks.write("settled", { ...NO_MARKS, settledAt: 5 }, null);
    marks.write("archived", { ...NO_MARKS, archivedAt: 5 }, null);
    marks.write("unsettled", { ...NO_MARKS, unsettledAt: 400 }, null);
    expect(marks.settleCandidates(100, 10)).toEqual(["idle"]);
  });
});
```

`project-link.test.ts` (a `fakeProjectsPort()` from `testing/fake-projects.ts` that answers `{ id: \`p:${root}\`, root, name: basename(root), position: 0 }` and records `ensure` calls; refuses roots listed in its `refuse` option with null):
- `assign("s1", "u1", "/w/api/sub")` with `scopeOf = (cwd) => cwd.replace(/\/sub$/, "")` stores and returns `"p:/w/api"`;
- `backfill()` over 3 rows of u1 in `/w/a`, 1 in `/w/b` and 1 of u2 in `/w/a` calls `ensure` 3 times (one per owner and folder) and leaves no row without a project;
- with `/w/bad` refused, a row in `/w/bad` keeps `projectId: null` and `backfill()` ends (returns the count, a second call returns 0 new assignments and does not loop: assert it returns within one page, `marks.withoutProject("", 10)` lists only that row).

`service.test.ts`, one case: a session created in `/w/api` (bed with the fake projects port and `policy.scopeOf` of the fake policy) has `marksStore.row(id)?.projectId === "p:/w/api"`. `service.forks.test.ts`, one case: a fork and a clone get the source's project.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL — no migration, no store.

- [ ] **Step 4: Implement**

`migrations/202610121500_session_marks.sql`:

```sql
-- M4: how the sidebar files a session (D02, Sessions+), its project, and the start of its first message for its label.
ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE sessions ADD COLUMN preview TEXT CHECK (preview IS NULL OR length(preview) <= 120);
ALTER TABLE sessions ADD COLUMN pin_rank INTEGER CHECK (pin_rank IS NULL OR pin_rank BETWEEN 1 AND 50);
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_auto INTEGER NOT NULL DEFAULT 0 CHECK (settled_auto IN (0, 1));
ALTER TABLE sessions ADD COLUMN unsettled_at INTEGER;
ALTER TABLE sessions ADD COLUMN snoozed_until INTEGER;

CREATE INDEX sessions_pi_session_id ON sessions(pi_session_id) WHERE pi_session_id IS NOT NULL;
CREATE INDEX sessions_owner_active ON sessions(owner_id, archived_at, updated_at DESC);
CREATE INDEX sessions_owner_project ON sessions(owner_id, project_id);
CREATE INDEX sessions_snoozed ON sessions(snoozed_until) WHERE snoozed_until IS NOT NULL;
```

`store.ts`: `insert(row, projectId = null)` writes `project_id` too (the SQL gains the column and `$projectId`); its doc says the project comes from `project-link.ts`.

`marks-store.ts`:

```ts
import type { Marks } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

/** A session as the sidebar sees it: identity, label sources, project and marks. */
export interface ShellRow {
  readonly id: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly preview: string | null;
  readonly projectId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly marks: Marks;
}

interface RawRow {
  id: string;
  ownerId: string;
  cwd: string;
  name: string | null;
  preview: string | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  pinRank: number | null;
  archivedAt: number | null;
  settledAt: number | null;
  settledAuto: number;
  unsettledAt: number | null;
  snoozedUntil: number | null;
}

const COLUMNS =
  "id, owner_id AS ownerId, cwd, name, preview, project_id AS projectId, created_at AS createdAt, updated_at AS updatedAt, " +
  "pin_rank AS pinRank, archived_at AS archivedAt, settled_at AS settledAt, settled_auto AS settledAuto, " +
  "unsettled_at AS unsettledAt, snoozed_until AS snoozedUntil";

const rowOf = (raw: RawRow): ShellRow => ({
  id: raw.id,
  ownerId: raw.ownerId,
  cwd: raw.cwd,
  name: raw.name,
  preview: raw.preview,
  projectId: raw.projectId,
  createdAt: raw.createdAt,
  updatedAt: raw.updatedAt,
  marks: {
    pinRank: raw.pinRank,
    archivedAt: raw.archivedAt,
    settledAt: raw.settledAt,
    settledAuto: raw.settledAuto === 1,
    unsettledAt: raw.unsettledAt,
    snoozedUntil: raw.snoozedUntil,
  },
});

export interface MarksStore {
  row(id: string): ShellRow | undefined;
  /** Not archived: pinned first by rank, then the newest; at most `limit`. */
  window(ownerId: string, limit: number): ShellRow[];
  countActive(ownerId: string): number;
  countArchived(ownerId: string): number;
  /** Sessions not archived, by project (the snapshot's counts, one query). */
  activeByProject(ownerId: string): Map<string, number>;
  countByProject(ownerId: string, projectId: string): number;
  /** Archived, newest archive first, strictly after the cursor. */
  archivedPage(ownerId: string, before: { archivedAt: number; id: string } | null, limit: number): ShellRow[];
  /** The owner's pinned sessions by rank. */
  pins(ownerId: string): string[];
  /** One session's marks and, when given, the owner's pin order (ranks 1..n, others unpinned), in one transaction. */
  write(id: string, marks: Marks, pins: { ownerId: string; order: readonly string[] } | null): void;
  setProject(id: string, projectId: string | null): void;
  /** Only when the session has none yet; true when it was written. */
  setPreview(id: string, preview: string): boolean;
  /** Sessions with no project, by id after `afterId`. */
  withoutProject(afterId: string, limit: number): Array<{ id: string; ownerId: string; cwd: string }>;
  findByPiPath(path: string): { id: string; ownerId: string } | undefined;
  findByPiSessionId(piSessionId: string): { id: string; ownerId: string; piPath: string | null } | undefined;
  dueSnoozes(now: number, limit: number): string[];
  nextSnooze(): number | null;
  /** Idle since before `cutoff`, and not pinned, snoozed, settled, archived or unsettled since `cutoff`. */
  settleCandidates(cutoff: number, limit: number): string[];
}

export function createMarksStore(db: Db): MarksStore {
  const ids = (sql: string, params: Record<string, string | number | null>) =>
    db.all<{ id: string }>(sql, params).map((row) => row.id);
  return {
    row: (id) => {
      const raw = db.get<RawRow>(`SELECT ${COLUMNS} FROM sessions WHERE id = $id`, { id });
      return raw ? rowOf(raw) : undefined;
    },
    window: (ownerId, limit) =>
      db
        .all<RawRow>(
          `SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId AND archived_at IS NULL ` +
            "ORDER BY pin_rank IS NULL, pin_rank, updated_at DESC, id LIMIT $limit",
          { ownerId, limit },
        )
        .map(rowOf),
    countActive: (ownerId) =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE owner_id = $ownerId AND archived_at IS NULL", { ownerId })?.n ?? 0,
    countArchived: (ownerId) =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE owner_id = $ownerId AND archived_at IS NOT NULL", { ownerId })?.n ?? 0,
    activeByProject: (ownerId) =>
      new Map(
        db
          .all<{ projectId: string; n: number }>(
            "SELECT project_id AS projectId, count(*) AS n FROM sessions WHERE owner_id = $ownerId AND archived_at IS NULL AND project_id IS NOT NULL GROUP BY project_id",
            { ownerId },
          )
          .map((row) => [row.projectId, row.n]),
      ),
    countByProject: (ownerId, projectId) =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM sessions WHERE owner_id = $ownerId AND project_id = $projectId AND archived_at IS NULL",
        { ownerId, projectId },
      )?.n ?? 0,
    archivedPage: (ownerId, before, limit) =>
      db
        .all<RawRow>(
          `SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId AND archived_at IS NOT NULL ` +
            "AND ($at IS NULL OR archived_at < $at OR (archived_at = $at AND id < $id)) ORDER BY archived_at DESC, id DESC LIMIT $limit",
          { ownerId, at: before?.archivedAt ?? null, id: before?.id ?? "", limit },
        )
        .map(rowOf),
    pins: (ownerId) =>
      ids("SELECT id FROM sessions WHERE owner_id = $ownerId AND pin_rank IS NOT NULL ORDER BY pin_rank, id", { ownerId }),
    write: (id, marks, pins) =>
      db.transaction(() => {
        db.run(
          "UPDATE sessions SET pin_rank = $pinRank, archived_at = $archivedAt, settled_at = $settledAt, settled_auto = $settledAuto, " +
            "unsettled_at = $unsettledAt, snoozed_until = $snoozedUntil WHERE id = $id",
          { id, ...marks, settledAuto: marks.settledAuto ? 1 : 0 },
        );
        if (!pins) return;
        db.run(
          "UPDATE sessions SET pin_rank = NULL WHERE owner_id = $ownerId AND pin_rank IS NOT NULL AND id NOT IN (SELECT value FROM json_each($order))",
          { ownerId: pins.ownerId, order: JSON.stringify(pins.order) },
        );
        pins.order.forEach((pinned, index) =>
          db.run("UPDATE sessions SET pin_rank = $rank WHERE id = $id AND owner_id = $ownerId", {
            id: pinned,
            ownerId: pins.ownerId,
            rank: index + 1,
          }),
        );
      }),
    setProject: (id, projectId) => {
      db.run("UPDATE sessions SET project_id = $projectId WHERE id = $id", { id, projectId });
    },
    setPreview: (id, preview) =>
      db.run("UPDATE sessions SET preview = $preview WHERE id = $id AND preview IS NULL", { id, preview }).changes > 0,
    withoutProject: (afterId, limit) =>
      db.all<{ id: string; ownerId: string; cwd: string }>(
        "SELECT id, owner_id AS ownerId, cwd FROM sessions WHERE project_id IS NULL AND id > $afterId ORDER BY id LIMIT $limit",
        { afterId, limit },
      ),
    findByPiPath: (path) =>
      db.get<{ id: string; ownerId: string }>("SELECT id, owner_id AS ownerId FROM sessions WHERE pi_path = $path", { path }),
    findByPiSessionId: (piSessionId) =>
      db.get<{ id: string; ownerId: string; piPath: string | null }>(
        "SELECT id, owner_id AS ownerId, pi_path AS piPath FROM sessions WHERE pi_session_id = $piSessionId",
        { piSessionId },
      ),
    dueSnoozes: (now, limit) =>
      ids("SELECT id FROM sessions WHERE snoozed_until IS NOT NULL AND snoozed_until <= $now ORDER BY snoozed_until LIMIT $limit", {
        now,
        limit,
      }),
    nextSnooze: () =>
      db.get<{ at: number | null }>("SELECT min(snoozed_until) AS at FROM sessions WHERE snoozed_until IS NOT NULL")?.at ?? null,
    settleCandidates: (cutoff, limit) =>
      ids(
        "SELECT id FROM sessions WHERE archived_at IS NULL AND settled_at IS NULL AND pin_rank IS NULL AND snoozed_until IS NULL " +
          "AND updated_at < $cutoff AND (unsettled_at IS NULL OR unsettled_at < $cutoff) ORDER BY updated_at LIMIT $limit",
        { cutoff, limit },
      ),
  };
}
```

`project-link.ts`:

```ts
import type { Logger } from "../../kernel/logger.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { MarksStore } from "./marks-store.ts";

const PAGE = 500;

/** The project of a session: the git root of its folder, made on demand (M4R28). */
export function createProjectLink(deps: {
  readonly store: MarksStore;
  readonly projects: ProjectsPort;
  scopeOf(cwd: string): string;
  readonly logger: Logger;
}) {
  const projectOf = (ownerId: string, cwd: string): string | null =>
    deps.projects.ensure(ownerId, deps.scopeOf(cwd))?.id ?? null;
  return {
    assign(sessionId: string, ownerId: string, cwd: string): string | null {
      const projectId = projectOf(ownerId, cwd);
      deps.store.setProject(sessionId, projectId);
      return projectId;
    },
    /** Rows stored before M4 (or whose project could not be made), page by page by id: never loops (M4R29). */
    backfill(): number {
      let after = "";
      let seen = 0;
      const known = new Map<string, string | null>();
      for (;;) {
        const rows = deps.store.withoutProject(after, PAGE);
        for (const row of rows) {
          const key = JSON.stringify([row.ownerId, row.cwd]);
          if (!known.has(key)) known.set(key, projectOf(row.ownerId, row.cwd));
          const projectId = known.get(key) ?? null;
          if (projectId !== null) deps.store.setProject(row.id, projectId);
        }
        seen += rows.length;
        if (rows.length < PAGE) break;
        after = rows.at(-1)?.id ?? after;
      }
      if (seen > 0) deps.logger.info("session_projects_backfilled", { sessions: seen });
      return seen;
    },
  };
}
```

`service.ts`: `SessionsServiceDeps` gains `readonly projects: ProjectsPort;` and `readonly marks: MarksStore;` (the module builds both stores from `db`); the service builds `const link = createProjectLink({ store: deps.marks, projects: deps.projects, scopeOf: deps.policy.scopeOf, logger: deps.logger })`. `create` computes the project before the row exists — `const projectId = deps.projects.ensure(caller.userId, deps.policy.scopeOf(cwd))?.id ?? null;` — and passes it to `launch(row, true, projectId)`, which hands it to `deps.store.insert(row, projectId)` once the worker is ready (a start that fails stores nothing, as before; the project row it made stays, empty, harmless). `fork` and `clone` call `link.assign(result.sessionId, row.ownerId, row.cwd)` after the forks helper returns. The module (`index.ts`) builds `createMarksStore(deps.db)`, passes `projects` and `marks` to the service, and calls `link.backfill()` once at creation — expose it as `service.backfillProjects()` and call that from `createSessionsModule` before `registerSnapshot`. `testing/service-bed.ts` gains `projects?: ProjectsPort` (default `fakeProjectsPort()`) and builds the marks store from its db. `projects/index.ts` adds `export type { ProjectView } from "./service.ts";`. `daemon.ts` passes `projects: projects.port` to `createSessionsModule`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit apps/daemon && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS. A dev home created on `main` boots (the migration adds columns to existing rows: covered by the int tests' fresh homes and by `marks-store.test.ts` reading pre-existing rows as `NO_MARKS`).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions apps/daemon/src/modules/projects/index.ts apps/daemon/src/daemon.ts
git commit -m "feat(sessions): marks and projects on the sessions table; every session gets the project of its folder"
```

---

### Task 8: The `shell` stream — sidebar summaries, keyed by the caller, with a coalescing publisher

Spec C §4.3 names a `shell` stream ("sidebar summaries"). Its snapshot holds the projects, the pinned sessions and the newest 500 that are not archived, under the frame budget; live events say what changed, coalesced per macrotask.

**Files:**
- Create: `apps/daemon/src/modules/sessions/{shell.ts,shell-publisher.ts,service-shell.ts,shell-rpc.ts}`, tests `shell.test.ts`, `shell-publisher.test.ts`, `service.shell.test.ts`, `shell-rpc.test.ts`
- Create: `apps/daemon/src/modules/sessions/sessions.shell.int.test.ts`
- Modify: `apps/daemon/src/modules/sessions/{service.ts,service-launch.ts,index.ts,rpc.ts}` (`sessions.list` fitted), `packages/contracts/src/{shell.ts,methods.ts}` (`subscribe.shell`, `sessions.listArchived`; `sessions.list`'s `truncated`)

**Interfaces:**
- Consumes: Task 7 `MarksStore`, `ShellRow`, `LaunchContext.onPublished`; Task 6 `ProjectsPort`.
- Produces:
  - `summaryOf(row: ShellRow, live: { status: SessionStatus; needsInput: boolean }): ShellSession`; `fitShellSnapshot(input: { sessions; projects; active: number; archived: number }, budget?): ShellSnapshot`; `fitSummaries(list: SessionSummary[], budget?): { sessions: SessionSummary[]; truncated: boolean }` (`shell.ts`).
  - `createShellPublisher({ hub, summary, project, archivedCount, logger, schedule? }): ShellPublisher` with `changed(sessionId)`, `projectChanged(ownerId, projectId: string | null)`, `countsChanged(ownerId)`.
  - `SessionsService.shellSnapshot(ownerId): ShellStreamEvent`, `listArchived(caller, { before?, limit? }): { sessions: ShellSession[]; hasMore: boolean }`, `summary(sessionId, ownerId): ShellSession | null`.
  - Contracts: `subscribe.shell { after? } → { sub }`, `sessions.listArchived { before?: { archivedAt, id }, limit? } → { sessions, hasMore }`, `sessions.list` result `{ sessions; truncated?: true }`.

**Rulings (pre-dispatch):**
- M4R31: The stream key is the caller's user id, taken from the transport, never from params (`subscribe.shell` has none): a client can only ever subscribe to its own sidebar (C §4.4, checklist) — cost if wrong: none.
- M4R32: Snapshot = pinned sessions by rank, then the newest not archived, at most 550 rows, cut further to `PAGE_BYTES` in JSON bytes (sessions in order, each with its project the first time it is named); `more` counts the active sessions left out; archived sessions are not in it (`archived` counts them; `sessions.listArchived` pages them) — a 10 000-session owner gets a bounded frame — cost if wrong: an old active session reachable only through ⌘K or its project's "search with ⌘K" line.
- M4R33: Live events: `session` (a summary upsert, after create, status, dialog open/close, name, prompt, fork, clone, mark), `project` (its view with its active count, after a project change or a count change), `counts` (the archived count). The publisher coalesces per macrotask (one event per changed session per turn of the loop) and publishes sessions, then projects, then counts; a failure while flushing is logged (`shell_publish_failed`) and never escapes — bounded event rate, no unhandled rejection — cost if wrong: an event up to one microtask late.
- M4R34: `needsInput` is true while a live session has an open dialog or approval (the session stream's `dialog_open`/`dialog_closed` republish the summary) — an approval waiting in another session is visible from the sidebar (T3 status indicators) — cost if wrong: none.
- M4R35: `sessions.list` keeps its shape for the API and the daemon's tests, newest first, cut to `PAGE_BYTES` with `truncated: true` when anything was left out (10 000 sessions overflowed the 1 MiB frame) — cost if wrong: none (the browser stops calling it in Task 20).
- M4R36: `sessions.listArchived` pages by `(archivedAt, id)` newest first, at most 100 per page and `PAGE_BYTES` per answer — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`shell.test.ts`:

```ts
import { NO_MARKS, type ProjectSummary, type ShellSession, SHELL_LIMITS, ShellStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { fitShellSnapshot, fitSummaries, summaryOf } from "./shell.ts";

const summary = (id: string, projectId: string | null, cwd = `/w/${id}`): ShellSession => ({
  id, cwd, name: null, preview: null, status: "cold", needsInput: false, projectId,
  pinRank: null, archivedAt: null, settledAt: null, snoozedUntil: null, createdAt: 1, updatedAt: 2,
});
const project = (id: string): ProjectSummary => ({ id, root: `/w/${id}`, name: id, position: 1, sessions: 2 });

describe("shell summaries", () => {
  it("maps a row and its live state", () => {
    const row = {
      id: "s1", ownerId: "u1", cwd: "/w/a", name: "n", preview: "p", projectId: "p1", createdAt: 1, updatedAt: 2,
      marks: { ...NO_MARKS, pinRank: 2, snoozedUntil: 9 },
    };
    expect(summaryOf(row, { status: "running", needsInput: true })).toEqual({
      id: "s1", cwd: "/w/a", name: "n", preview: "p", status: "running", needsInput: true, projectId: "p1",
      pinRank: 2, archivedAt: null, settledAt: null, snoozedUntil: 9, createdAt: 1, updatedAt: 2,
    });
  });

  it("keeps the sessions in order with each named project once, and counts what it left out", () => {
    const snapshot = fitShellSnapshot({
      sessions: [summary("a", "p1"), summary("b", "p1"), summary("c", null)],
      projects: [project("p1"), project("p2")],
      active: 5,
      archived: 4,
    });
    expect(snapshot).toEqual({
      kind: "snapshot",
      projects: [project("p1")],
      sessions: [summary("a", "p1"), summary("b", "p1"), summary("c", null)],
      more: 2,
      archived: 4,
    });
  });

  it("stops at the budget and never cuts the order", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => summary(`s${i}`, null, `/w/${"x".repeat(200)}`));
    const snapshot = fitShellSnapshot({ sessions, projects: [], active: 10, archived: 0 }, 1500);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(1500);
    expect(snapshot.sessions.map((s) => s.id)).toEqual(sessions.slice(0, snapshot.sessions.length).map((s) => s.id));
    expect(snapshot.more).toBe(10 - snapshot.sessions.length);
  });

  it("fits the largest window of 10 000 sessions with 4096-character folders in one frame", () => {
    const sessions = Array.from({ length: SHELL_LIMITS.sessions + SHELL_LIMITS.pins }, (_, i) =>
      summary(`s${String(i).padStart(4, "0")}`, `p${i}`, `/${"d".repeat(4095)}`),
    );
    const projects = sessions.map((s) => ({ ...project(s.projectId ?? ""), root: `/${"d".repeat(4095)}` }));
    const snapshot = fitShellSnapshot({ sessions, projects, active: 10_000, archived: 0 });
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(ShellStreamEvent.safeParse(snapshot).success).toBe(true);
    expect(snapshot.more).toBe(10_000 - snapshot.sessions.length);
  });

  it("fits sessions.list under the page and says when it cut", () => {
    const list = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, cwd: `/${"d".repeat(4000)}`, name: null, status: "cold", createdAt: 1, updatedAt: 1 }) as const);
    const fitted = fitSummaries(list);
    expect(sizeOf({ sessions: fitted.sessions })).toBeLessThanOrEqual(PAGE_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(fitSummaries(list.slice(0, 2))).toEqual({ sessions: list.slice(0, 2), truncated: false });
  });
});
```

`shell-publisher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createShellPublisher } from "./shell-publisher.ts";

function setup(summary = (id: string) => ({ ownerId: "u1", session: { id } as never })) {
  const published: Array<[string, string, unknown]> = [];
  const queued: Array<() => void> = [];
  const publisher = createShellPublisher({
    hub: { publish: (stream, key, event) => void published.push([stream, key, event]) },
    summary: vi.fn(summary),
    project: (ownerId, projectId) => ({ id: projectId, root: "/r", name: "r", position: 1, sessions: 3 }),
    archivedCount: () => 4,
    logger: silentLogger,
    schedule: (flush) => void queued.push(flush),
  });
  const flush = () => queued.splice(0).forEach((fn) => fn());
  return { published, publisher, flush };
}

describe("shell publisher (M4R33)", () => {
  it("publishes each changed session once per turn, then projects, then counts, on the owner's channel", () => {
    const { published, publisher, flush } = setup();
    publisher.countsChanged("u1");
    publisher.projectChanged("u1", "p1");
    publisher.changed("s1");
    publisher.changed("s1");
    publisher.changed("s2");
    publisher.projectChanged("u1", null);
    expect(published).toEqual([]);
    flush();
    expect(published).toEqual([
      ["shell", "u1", { kind: "session", session: { id: "s1" } }],
      ["shell", "u1", { kind: "session", session: { id: "s2" } }],
      ["shell", "u1", { kind: "project", project: { id: "p1", root: "/r", name: "r", position: 1, sessions: 3 } }],
      ["shell", "u1", { kind: "counts", archived: 4 }],
    ]);
  });

  it("skips a session that is gone, and survives a throwing source without leaking", () => {
    const { published, publisher, flush } = setup((id) => {
      if (id === "boom") throw new Error("db");
      return id === "gone" ? null : { ownerId: "u1", session: { id } as never };
    });
    publisher.changed("gone");
    flush();
    expect(published).toEqual([]);
    publisher.changed("boom");
    expect(() => flush()).not.toThrow();
    publisher.changed("s3");
    flush();
    expect(published).toEqual([["shell", "u1", { kind: "session", session: { id: "s3" } }]]);
  });
});
```

`service.shell.test.ts` (the service bed with the fake projects port; one test each):
- the snapshot of `OWNER` lists a pinned session first, then the newest, archived ones counted in `archived` only;
- creating a session publishes a `session` event and a `project` event on `shell:u1` (collect with `hub.open` on stream `shell`, key `u1`, and drain microtasks);
- a fake worker's `ready` then an approval request publishes `session` events whose `needsInput` goes `false` → `true`; its answer → `false`;
- a prompt publishes the touched summary;
- `listArchived` pages 3 archived sessions by 2 (`hasMore` true then false), and refuses nothing for an empty owner (`{ sessions: [], hasMore: false }`);
- the `shell` snapshot provider registered by the module answers for any owner key (empty for an owner without sessions), never `not_found`.

`shell-rpc.test.ts`: `"subscribe.shell"` with `{}` and with `{ after }` calls `ctx.openSubscription("shell", ctx.caller.userId, after)` and returns `{ sub }`; `"sessions.listArchived"` passes `ctx.caller` and the params to `service.listArchived`.

`sessions.shell.int.test.ts` (`startTestDaemon`): client A subscribes `subscribe.shell {}` and receives a snapshot with `sessions: []`; client B (same owner, second socket) creates a session in `t.cwd`; A receives a `session` event with that id and a `project` event whose `root` is `t.cwd` (not a git repo) within 10 s (`waitForEvent`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions packages/contracts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Contracts (`shell.ts`, inside `shellMethods`; `Cursor` imported from `./frames.ts`):

```ts
  "subscribe.shell": defineMethod({
    name: "subscribe.shell",
    permission: "sessions:read",
    idempotent: true,
    // No key: the stream is the caller's own (M4R31).
    params: z.object({ after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
  "sessions.listArchived": defineMethod({
    name: "sessions.listArchived",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({
      before: z.object({ archivedAt: Millis, id: Id }).optional(),
      limit: z.number().int().min(1).max(SHELL_LIMITS.archivedPage).optional(),
    }),
    result: z.object({ sessions: z.array(ShellSession).max(SHELL_LIMITS.archivedPage), hasMore: z.boolean() }),
    errors: [],
  }),
```

`methods.ts` `sessions.list` result: `z.object({ sessions: z.array(SessionSummary), truncated: z.literal(true).optional() })` with the comment "cut to the page in JSON bytes, newest kept (M4R35)".

`shell.ts` (sessions module):

```ts
import type { ProjectSummary, SessionStatus, SessionSummary, ShellSession, ShellStreamEvent } from "@pap/contracts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { ShellRow } from "./marks-store.ts";

export type ShellSnapshot = Extract<ShellStreamEvent, { kind: "snapshot" }>;

export function summaryOf(row: ShellRow, live: { readonly status: SessionStatus; readonly needsInput: boolean }): ShellSession {
  return {
    id: row.id,
    cwd: row.cwd,
    name: row.name,
    preview: row.preview,
    status: live.status,
    needsInput: live.needsInput,
    projectId: row.projectId,
    pinRank: row.marks.pinRank,
    archivedAt: row.marks.archivedAt,
    settledAt: row.marks.settledAt,
    snoozedUntil: row.marks.snoozedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The `shell` snapshot under `budget` JSON bytes (M4R32): sessions in the order given until one does not fit, each
 * bringing its project the first time it names one; `more` counts the active sessions left out.
 */
export function fitShellSnapshot(
  input: {
    readonly sessions: readonly ShellSession[];
    readonly projects: readonly ProjectSummary[];
    readonly active: number;
    readonly archived: number;
  },
  budget = PAGE_BYTES,
): ShellSnapshot {
  const snapshot: ShellSnapshot = { kind: "snapshot", projects: [], sessions: [], more: 0, archived: input.archived };
  // Room for the digits `more` will have.
  let used = sizeOf(snapshot) + 16;
  const byId = new Map(input.projects.map((project) => [project.id, project]));
  const named = new Set<string>();
  for (const session of input.sessions) {
    const project =
      session.projectId !== null && !named.has(session.projectId) ? byId.get(session.projectId) : undefined;
    const size = sizeOf(session) + 1 + (project ? sizeOf(project) + 1 : 0);
    if (used + size > budget) break;
    used += size;
    snapshot.sessions.push(session);
    if (project) {
      named.add(project.id);
      snapshot.projects.push(project);
    }
  }
  snapshot.more = Math.max(0, input.active - snapshot.sessions.length);
  return snapshot;
}

/** `sessions.list` under the page (M4R35): the newest kept, `truncated` when one was left out. */
export function fitSummaries(
  list: readonly SessionSummary[],
  budget = PAGE_BYTES,
): { sessions: SessionSummary[]; truncated: boolean } {
  let used = sizeOf({ sessions: [], truncated: true });
  const sessions: SessionSummary[] = [];
  for (const summary of list) {
    const size = sizeOf(summary) + 1;
    if (used + size > budget) return { sessions, truncated: true };
    used += size;
    sessions.push(summary);
  }
  return { sessions, truncated: false };
}
```

`shell-publisher.ts`:

```ts
import type { ProjectSummary, ShellSession } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";

export interface ShellPublisher {
  changed(sessionId: string): void;
  projectChanged(ownerId: string, projectId: string | null): void;
  countsChanged(ownerId: string): void;
}

/** What changed in one turn of the loop goes out once, sessions then projects then counts (M4R33). */
export function createShellPublisher(deps: {
  readonly hub: Pick<StreamHub, "publish">;
  summary(sessionId: string): { readonly ownerId: string; readonly session: ShellSession } | null;
  project(ownerId: string, projectId: string): ProjectSummary | null;
  archivedCount(ownerId: string): number;
  readonly logger: Logger;
  readonly schedule?: (flush: () => void) => void;
}): ShellPublisher {
  const schedule = deps.schedule ?? queueMicrotask;
  const sessions = new Set<string>();
  const projects = new Map<string, { ownerId: string; projectId: string }>();
  const counts = new Set<string>();
  let armed = false;
  const flush = () => {
    armed = false;
    try {
      for (const id of [...sessions]) {
        sessions.delete(id);
        const found = deps.summary(id);
        if (found) deps.hub.publish("shell", found.ownerId, { kind: "session", session: found.session });
      }
      for (const [key, { ownerId, projectId }] of [...projects]) {
        projects.delete(key);
        const project = deps.project(ownerId, projectId);
        if (project) deps.hub.publish("shell", ownerId, { kind: "project", project });
      }
      for (const ownerId of [...counts]) {
        counts.delete(ownerId);
        deps.hub.publish("shell", ownerId, { kind: "counts", archived: deps.archivedCount(ownerId) });
      }
    } catch (error) {
      // A summary that could not be read must not take the turn down; the next change or snapshot says the truth.
      deps.logger.error("shell_publish_failed", { err: error });
      sessions.clear();
      projects.clear();
      counts.clear();
    }
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    schedule(flush);
  };
  return {
    changed(sessionId) {
      sessions.add(sessionId);
      arm();
    },
    projectChanged(ownerId, projectId) {
      if (projectId === null) return;
      projects.set(JSON.stringify([ownerId, projectId]), { ownerId, projectId });
      arm();
    },
    countsChanged(ownerId) {
      counts.add(ownerId);
      arm();
    },
  };
}
```

`service-shell.ts`:

```ts
import { type Caller, type ProjectSummary, SHELL_LIMITS, type ShellSession, type ShellStreamEvent } from "@pap/contracts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { MarksStore } from "./marks-store.ts";
import { fitShellSnapshot, summaryOf } from "./shell.ts";

export function createShellView(deps: {
  readonly store: MarksStore;
  readonly projects: ProjectsPort;
  live(sessionId: string): { status: ShellSession["status"]; needsInput: boolean };
}) {
  const summary = (sessionId: string): { ownerId: string; session: ShellSession } | null => {
    const row = deps.store.row(sessionId);
    return row ? { ownerId: row.ownerId, session: summaryOf(row, deps.live(row.id)) } : null;
  };
  const project = (ownerId: string, projectId: string): ProjectSummary | null => {
    const view = deps.projects.list(ownerId, [projectId])[0];
    return view ? { ...view, sessions: deps.store.countByProject(ownerId, projectId) } : null;
  };
  return {
    summary,
    project,
    snapshot(ownerId: string): ShellStreamEvent {
      const rows = deps.store.window(ownerId, SHELL_LIMITS.sessions + SHELL_LIMITS.pins);
      const counts = deps.store.activeByProject(ownerId);
      const ids = [...new Set(rows.flatMap((row) => (row.projectId === null ? [] : [row.projectId])))];
      const projects = deps.projects.list(ownerId, ids).map((view) => ({ ...view, sessions: counts.get(view.id) ?? 0 }));
      return fitShellSnapshot({
        sessions: rows.map((row) => summaryOf(row, deps.live(row.id))),
        projects,
        active: deps.store.countActive(ownerId),
        archived: deps.store.countArchived(ownerId),
      });
    },
    listArchived(caller: Caller, params: { before?: { archivedAt: number; id: string } | undefined; limit?: number | undefined }) {
      const limit = params.limit ?? SHELL_LIMITS.archivedPage;
      const rows = deps.store.archivedPage(caller.userId, params.before ?? null, limit + 1);
      const sessions: ShellSession[] = [];
      let used = sizeOf({ sessions: [], hasMore: true });
      for (const row of rows.slice(0, limit)) {
        const session = summaryOf(row, deps.live(row.id));
        const size = sizeOf(session) + 1;
        if (used + size > PAGE_BYTES) return { sessions, hasMore: true };
        used += size;
        sessions.push(session);
      }
      return { sessions, hasMore: rows.length > limit };
    },
    /** A summary for search hits: only the owner's own session. */
    summaryFor(sessionId: string, ownerId: string): ShellSession | null {
      const found = summary(sessionId);
      return found && found.ownerId === ownerId ? found.session : null;
    },
  };
}
```

Service wiring (`service.ts`; keep it under 400 lines — `service-shell.ts` holds the logic):
- `const shell = createShellView({ store: deps.marks, projects: deps.projects, live: (id) => ({ status: statusOf(id), needsInput: (live.get(id)?.dialogs().length ?? 0) > 0 }) });`
- `const publisher = createShellPublisher({ hub: deps.hub, summary: shell.summary, project: shell.project, archivedCount: deps.marks.countArchived, logger: deps.logger });`
- `createLaunch({ …, onPublished: (id, event) => { if (SUMMARY_EVENTS.has(event.kind)) publisher.changed(id); } })` with `const SUMMARY_EVENTS = new Set(["status", "dialog_open", "dialog_closed", "name"]);` — in `service-launch.ts`, the `publish` callback calls `ctx.onPublished?.(row.id, event)` after `deps.hub.publish` (only once the row is stored).
- `create`: after `launch` resolves, `publisher.changed(row.id); publisher.projectChanged(caller.userId, projectId);`.
- `prompt`: after `deps.store.touch`, `publisher.changed(row.id)`.
- `fork` / `clone`: after `link.assign`, `publisher.changed(id); publisher.projectChanged(row.ownerId, projectId);`.
- `deps.projects.onChange((ownerId, view) => publisher.projectChanged(ownerId, view.id))` once, in the service factory.
- `list(caller)` returns `fitSummaries(...)`; `rpc.ts`'s `sessions.list` handler returns `{ sessions, ...(truncated ? { truncated: true as const } : {}) }`.
- The service exposes `shellSnapshot: (ownerId) => shell.snapshot(ownerId)`, `listArchived: shell.listArchived`, `summary: shell.summaryFor`.

`shell-rpc.ts`:

```ts
import type { HandlerTable } from "@pap/contracts";
import type { SessionsService } from "./service.ts";

export type ShellRpc = Pick<HandlerTable, "subscribe.shell" | "sessions.listArchived">;

export function shellRpc(service: SessionsService): ShellRpc {
  return {
    // The key is the caller, never a param (M4R31); opening is this handler's only effect (R79).
    "subscribe.shell": async ({ after }, ctx) => ({ sub: ctx.openSubscription("shell", ctx.caller.userId, after) }),
    "sessions.listArchived": async (params, ctx) => service.listArchived(ctx.caller, params),
  };
}
```

`index.ts`: `rpc: { ...sessionsRpc(service), ...shellRpc(service) }` (type `SessionsRpc & ShellRpc`), and `deps.hub.registerSnapshot("shell", (ownerId) => service.shellSnapshot(ownerId));`.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm test:unit apps/daemon packages/contracts && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip && pnpm smoke`
Expected: PASS. Mutation checks: key the subscription with a param → no param exists to compile against (the contract has none); publish without the coalescing set → the publisher test's "once per turn" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions packages/contracts
git commit -m "feat(sessions): the shell stream — sidebar summaries keyed by the caller, a bounded snapshot and coalesced events"
```

---

### Task 9: `sessions.mark` — pin, archive, settle, snooze and Undo, written with the shared rules

**Files:**
- Create: `apps/daemon/src/modules/sessions/{service-marks.ts,service.marks.test.ts}`
- Modify: `apps/daemon/src/modules/sessions/{service.ts,shell-rpc.ts,shell-rpc.test.ts}`, `packages/contracts/src/{shell.ts,methods.test.ts}`
- Create: `apps/daemon/src/modules/sessions/sessions.marks.int.test.ts`

**Interfaces:**
- Consumes: Task 5 `applyMark`, `MarkChange`; Task 7 `MarksStore`; Task 8 `ShellPublisher`.
- Produces: `SessionsService.mark(input: { sessionId: string; change: MarkChange }, caller: Caller): void`; contract `sessions.mark { sessionId, change } → { ok: true }`; `createSessionMarks(deps: { store; clock; owned; publisher; onSnoozeChange(): void })`.

**Rulings (pre-dispatch):**
- M4R37: The write is one transaction (the session's marks and the owner's pin order); then the publisher announces the session, every other pinned session whose rank moved, and — when `archived` flipped — the counts and the session's project — the browser's store gets every rank it shows — cost if wrong: none.
- M4R38: `sessions.mark` answers `{ ok: true }`; the stream carries the state (M4R24); `not_found` for another owner's session; `bad_request` and `limit_reached` from `applyMark` — cost if wrong: none.
- M4R39: Marks never touch the worker: archiving or settling a running session only files it (the run goes on, its tab stays open; the worker idles out as usual) — "closing a tab deletes nothing" and the same for filing — cost if wrong: a running session hidden in the Archived shelf (its tab still shows it running).

- [ ] **Step 1: Write the failing tests**

`service.marks.test.ts` (service bed, fake clock at `T = 1_800_000_000_000`, sessions `a`, `b`, `c` created in that order; events collected from `hub.open("shell", "u1")` after draining microtasks):
- pin `a` then `b` before `a`: `marks.pins("u1")` is `["b", "a"]`; the events of the second call carry `b` with `pinRank: 1` and `a` with `pinRank: 2`;
- a 51st pin answers `limit_reached` (seed 50 pins through `marks.write`), nothing written;
- archive `a` (pinned): its row has `archivedAt: T`, no rank; events: `session` a, `counts` `{ archived: 1 }`, `project` with `sessions` one less;
- snooze `c` at `T + 30 * 60_000`: written; a `snooze` at `T + 1000` answers `bad_request`; `onSnoozeChange` called once (spy);
- restore after archive (Undo) puts `a` back at rank 2 among `["b", "a"]`;
- another owner's session (`{ userId: "u2" }`) answers `not_found`;
- archiving a running session leaves its worker running (fake worker `stopped` false, status still `running`).

`shell-rpc.test.ts`: `"sessions.mark"` calls `service.mark({ sessionId, change }, ctx.caller)` and answers `{ ok: true }`.

`sessions.marks.int.test.ts`: over `/ws`, create a session, subscribe `shell`, `sessions.mark { change: { kind: "pin", before: null } }` → `{ ok: true }` and a `session` event with `pinRank: 1`; a `{ kind: "snooze", until: 1 }` → `bad_request`.

`methods.test.ts`: `"sessions.mark"` joins the sorted mutation list.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions packages/contracts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Contract (`shellMethods`):

```ts
  "sessions.mark": defineMethod({
    name: "sessions.mark",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: Id, change: MarkChange }),
    // The new state comes over the `shell` stream (M4R38).
    result: z.object({ ok: z.literal(true) }),
    // `bad_request`: a snooze out of range or of an archived session; `limit_reached`: 50 pins already.
    errors: ["not_found", "bad_request", "limit_reached"],
  }),
```

`service-marks.ts`:

```ts
import { applyMark, type Caller, type MarkChange, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { MarksStore } from "./marks-store.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow } from "./store.ts";

/** Sessions whose rank differs between the two orders (absent counts as a rank). */
const moved = (before: readonly string[], after: readonly string[] | null): string[] =>
  after === null ? [] : [...new Set([...before, ...after])].filter((id) => before.indexOf(id) !== after.indexOf(id));

export function createSessionMarks(deps: {
  readonly store: MarksStore;
  readonly clock: Clock;
  owned(sessionId: string, caller: Caller): SessionRow;
  readonly publisher: ShellPublisher;
  onSnoozeChange(): void;
}) {
  return {
    mark(input: { readonly sessionId: string; readonly change: MarkChange }, caller: Caller): void {
      const row = deps.owned(input.sessionId, caller);
      const current = deps.store.row(row.id);
      if (!current) throw new PapError("not_found");
      const pins = deps.store.pins(row.ownerId);
      const outcome = applyMark(row.id, current.marks, input.change, pins, deps.clock.now());
      if (!outcome.ok) throw new PapError(outcome.code);
      deps.store.write(row.id, outcome.marks, outcome.pins ? { ownerId: row.ownerId, order: outcome.pins } : null);
      deps.publisher.changed(row.id);
      for (const id of moved(pins, outcome.pins)) deps.publisher.changed(id);
      if ((current.marks.archivedAt === null) !== (outcome.marks.archivedAt === null)) {
        deps.publisher.countsChanged(row.ownerId);
        deps.publisher.projectChanged(row.ownerId, current.projectId);
      }
      if (current.marks.snoozedUntil !== outcome.marks.snoozedUntil) deps.onSnoozeChange();
    },
  };
}
```

`service.ts`: build `createSessionMarks({ store: deps.marks, clock: deps.clock, owned, publisher, onSnoozeChange: () => {} })` (Task 10 passes the organiser's `rearm`) and expose `mark`. `shell-rpc.ts`: add `"sessions.mark"` to `ShellRpc` with `async (params, ctx) => { service.mark(params, ctx.caller); return { ok: true as const }; }`.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm test:unit apps/daemon packages/contracts && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS. Mutation check: drop the `moved(...)` loop → the rank-event case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions packages/contracts
git commit -m "feat(sessions): sessions.mark files a session (pin, archive, settle, snooze, Undo) with the shared rules"
```

---

### Task 10: Settle and snooze over time — the 3-day rule, the wake timer, activity

**Files:**
- Create: `apps/daemon/src/modules/sessions/{organiser.ts,organiser.test.ts}`
- Modify: `apps/daemon/src/modules/sessions/{service.ts,service-launch.ts,index.ts}`, `service.marks.test.ts` (one case)

**Interfaces:**
- Consumes: Task 7 `MarksStore.{settleCandidates,dueSnoozes,nextSnooze,row,write}`; Task 8 `ShellPublisher`; Task 9 `onSnoozeChange`.
- Produces: `AUTO_SETTLE_AFTER_MS = 3 * 86_400_000`, `SWEEP_EVERY_MS = 3_600_000`, `SWEEP_BATCH = 500`; `createOrganiser({ store, clock, logger, publisher, isLive }): Organiser` with `start()`, `stop()`, `rearm()`, `activity(sessionId)`; `SessionsService.activity(sessionId)` (used by the scan port, Task 14).

**Rulings (pre-dispatch):**
- M4R40 (owner Q2 default): A session idle for 3 days (by `updated_at`, and by `unsettled_at` when it was un-settled since) is settled automatically unless it is pinned, snoozed, archived, already settled or has a live worker; a sweep runs at start and every hour, 500 sessions per turn, the next batch on the next turn when one was full — T3's default rule, bounded work per turn — cost if wrong: a session filed under Settled that the person wanted active (one click, or any activity, brings it back).
- M4R41: Activity un-settles and wakes: a prompt sent from pap, a run starting (status `running`), or new entries the scanner reads (Task 14) clear `settled` and `snoozed` — a session you are working in is not filed away — cost if wrong: a snoozed session that a CLI append wakes early.
- M4R42: One wake timer, armed at the earliest `snoozed_until` through the kernel `Clock` (which chains delays past 24.8 days); due snoozes clear 500 per turn; every mark that changes a snooze re-arms it — cost if wrong: none.
- M4R43: `stop()` clears both timers; the module's `shutdownAll()` calls it first — no timer outlives the daemon (checklist) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`organiser.test.ts` (real database as in `marks-store.test.ts`, `createFakeClock(T)`, a publisher spy, `isLive` from a `Set`):

```ts
it("settles sessions idle for 3 days, and none that is pinned, snoozed, archived, live or freshly unsettled", async () => {
  // rows updated at T - 4 days: idle, pinned, snoozed, archived, live; unsettled at T - 1 day; fresh at T - 1 day
  organiser.start();
  await clock.advance(0);
  expect(settled()).toEqual(["idle"]);
  expect(marks.row("idle")?.marks).toMatchObject({ settledAt: T, settledAuto: true });
  expect(changed).toEqual(["idle"]);
});

it("works through more than one batch, a batch per turn", async () => {
  // 501 idle rows
  organiser.start();
  await clock.advance(0);
  expect(settled()).toHaveLength(501);
});

it("sweeps again every hour", async () => {
  organiser.start();
  await clock.advance(0);
  addIdle("late", T - 3 * DAY + 10 * 60_000); // becomes 3 days idle 10 minutes from now
  await clock.advance(SWEEP_EVERY_MS);
  expect(settled()).toContain("late");
});

it("wakes a snooze at its time, the earliest first, and re-arms", async () => {
  write("a", { snoozedUntil: T + 60_000 });
  write("b", { snoozedUntil: T + 120_000 });
  organiser.start();
  await clock.advance(60_000);
  expect(marks.row("a")?.marks.snoozedUntil).toBeNull();
  expect(marks.row("b")?.marks.snoozedUntil).toBe(T + 120_000);
  await clock.advance(60_000);
  expect(marks.row("b")?.marks.snoozedUntil).toBeNull();
  expect(changed).toEqual(["a", "b"]);
});

it("re-arms when a snooze changes", async () => {
  organiser.start();
  write("a", { snoozedUntil: T + 30_000 });
  organiser.rearm();
  await clock.advance(30_000);
  expect(marks.row("a")?.marks.snoozedUntil).toBeNull();
});

it("activity un-settles and wakes, and writes nothing for an active session", () => {
  write("s", { settledAt: T - 5, settledAuto: true, snoozedUntil: null });
  write("z", { snoozedUntil: T + 999_999 });
  addIdle("plain", T); // a row with no marks
  organiser.activity("s");
  organiser.activity("z");
  organiser.activity("plain");
  expect(marks.row("s")?.marks).toMatchObject({ settledAt: null, settledAuto: false });
  expect(marks.row("z")?.marks.snoozedUntil).toBeNull();
  expect(changed).toEqual(["s", "z"]);
});

it("stop leaves no timer", async () => {
  write("a", { snoozedUntil: T + 60_000 });
  organiser.start();
  await clock.advance(0);
  organiser.stop();
  expect(clock.pending()).toBe(0);
});
```

(The implementer writes the small helpers `addIdle`, `write`, `settled` over `marks-store`; `T`, `DAY` as constants.)

`service.marks.test.ts`, one case: a prompt to a settled session clears its `settledAt` (the service calls `organiser.activity` before `publisher.changed`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/organiser.test.ts apps/daemon/src/modules/sessions/service.marks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`organiser.ts`:

```ts
import type { Marks } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { MarksStore } from "./marks-store.ts";
import type { ShellPublisher } from "./shell-publisher.ts";

export const AUTO_SETTLE_AFTER_MS = 3 * 86_400_000;
export const SWEEP_EVERY_MS = 3_600_000;
export const SWEEP_BATCH = 500;

export interface Organiser {
  start(): void;
  stop(): void;
  /** A snooze changed: the wake timer follows the earliest one. */
  rearm(): void;
  /** Someone worked in the session: it is no longer settled or snoozed (M4R41). */
  activity(sessionId: string): void;
}

export function createOrganiser(deps: {
  readonly store: MarksStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publisher: ShellPublisher;
  isLive(sessionId: string): boolean;
}): Organiser {
  let sweepTimer: TimerHandle | null = null;
  let wakeTimer: TimerHandle | null = null;
  let stopped = false;

  const update = (id: string, change: Partial<Marks>) => {
    const row = deps.store.row(id);
    if (!row) return;
    deps.store.write(id, { ...row.marks, ...change }, null);
    deps.publisher.changed(id);
  };

  function sweep(): void {
    sweepTimer = null;
    if (stopped) return;
    const now = deps.clock.now();
    // Live sessions (at most the worker cap) are skipped here, not in SQL.
    const candidates = deps.store.settleCandidates(now - AUTO_SETTLE_AFTER_MS, SWEEP_BATCH);
    let settled = 0;
    for (const id of candidates) {
      if (deps.isLive(id)) continue;
      update(id, { settledAt: now, settledAuto: true });
      settled++;
    }
    if (settled > 0) deps.logger.info("sessions_auto_settled", { count: settled });
    // A full batch: the rest go on the next turn of the loop, not in this one (M4R40).
    sweepTimer = deps.clock.setTimeout(sweep, candidates.length === SWEEP_BATCH ? 0 : SWEEP_EVERY_MS);
  }

  function wake(): void {
    wakeTimer = null;
    if (stopped) return;
    for (const id of deps.store.dueSnoozes(deps.clock.now(), SWEEP_BATCH)) update(id, { snoozedUntil: null });
    rearm();
  }

  function rearm(): void {
    if (wakeTimer) deps.clock.clearTimeout(wakeTimer);
    wakeTimer = null;
    if (stopped) return;
    const next = deps.store.nextSnooze();
    if (next !== null) wakeTimer = deps.clock.setTimeout(wake, Math.max(0, next - deps.clock.now()));
  }

  return {
    start() {
      stopped = false;
      sweep();
      rearm();
    },
    stop() {
      stopped = true;
      if (sweepTimer) deps.clock.clearTimeout(sweepTimer);
      if (wakeTimer) deps.clock.clearTimeout(wakeTimer);
      sweepTimer = null;
      wakeTimer = null;
    },
    rearm,
    activity(sessionId) {
      const row = deps.store.row(sessionId);
      if (!row || (row.marks.settledAt === null && row.marks.snoozedUntil === null)) return;
      const wasSnoozed = row.marks.snoozedUntil !== null;
      update(sessionId, { settledAt: null, settledAuto: false, snoozedUntil: null });
      if (wasSnoozed) rearm();
    },
  };
}
```

(The sweep's first run happens in `start()` synchronously; tests advance by 0 to let the publisher's microtasks run. A batch of exactly 500 with the next turn finding none simply re-arms the hourly timer.)

Wiring: the service builds `const organiser = createOrganiser({ store: deps.marks, clock: deps.clock, logger: deps.logger, publisher, isLive: (id) => live.has(id) })`; `createSessionMarks({ …, onSnoozeChange: organiser.rearm })`; `prompt` calls `organiser.activity(row.id)` before `publisher.changed`; `onPublished` calls `organiser.activity(id)` for a `status` event whose status is `running`; `shutdownAll()` calls `organiser.stop()` first; the service exposes `startOrganiser: organiser.start` and `activity: organiser.activity`; `createSessionsModule` calls `service.startOrganiser()` after the backfill.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS; `daemon.boot.int.test.ts` still shows no timer kept alive after `stop()`. Mutation check: drop `if (deps.isLive(id)) continue;` → the live case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions
git commit -m "feat(sessions): settle idle sessions after 3 days, wake snoozes on time, and un-file a session someone works in"
```

---

# Phase 3 — The scanner and FTS5 search (daemon)

### Task 11: The search index — `search.db` as a rebuildable cache (ADR 0013) and a query builder that quotes everything

Spec C §3.2 lists `session_search` (FTS5) among the tables of `state.db`. This plan keeps the index in its own file, `$PAP_HOME/search.db`, because the index is a cache over Pi's files (Orca `session-search-schema.ts`: "the index is a cache over the transcripts, never a source"): a schema change or a damaged file is a delete and a rescan, never a migration; `state.db` and its pre-migration snapshots stay small; `pap backup` (M6) can leave the index out. That deviation is ADR 0013.

**Files:**
- Create: `apps/daemon/src/modules/search/{index-db.ts,index-store.ts,match.ts}`, tests `index-db.test.ts`, `index-store.test.ts`, `match.test.ts`
- Create: `docs/adr/0013-search-index-cache-file.md`

**Interfaces:**
- Consumes: `kernel/db/database.ts` `openDatabase`, `Db`; Task 1 `cutUnits`.
- Produces:
  - `SEARCH_SCHEMA_VERSION = 1`, `openSearchIndex(path: string, logger: Logger): Db` (`index-db.ts`).
  - `interface FileCursor { path; ino; size; mtimeMs; offset; head; state: "indexed" | "excluded" | "bad" | "waiting"; sessionId: string | null; ownerId: string | null; indexedChars: number }`, `interface IndexRow { entryId; role: "user" | "assistant"; at: number; text: string }`, `MAX_ROW_CHARS = 16_384`, `indexText(raw: string): string`, `createSearchIndexStore(db): SearchIndexStore` with `cursor(path)`, `paths()`, `commit(cursor, rows)`, `forget(path)`, `rowCount()` (`index-store.ts`).
  - `MAX_QUERY_TERMS = 8`, `matchExpression(query: string): string | null` (`match.ts`).

**Rulings (pre-dispatch):**
- M4R44 (owner Q4 default): the index lives in `$PAP_HOME/search.db` (ADR 0013), opened with the kernel's `openDatabase` (WAL, `synchronous=FULL`); a different `meta.schema_version`, or a file SQLite calls corrupt, is deleted (`-wal`, `-shm` too) and rebuilt, logged `search_index_rebuilt` with the reason — a cache must never stop the daemon — cost if wrong: a full rescan after a version bump (bounded by the cutoff).
- M4R45: External-content FTS5 (`content='rows'`): the text is stored once, in `rows`, and `snippet()` works; tokenizer `unicode61 remove_diacritics 2` (S3: `cafe` matches `café`) — cost if wrong: an index about 30 % larger than a contentless one.
- M4R46 (owner Q5 default): indexed text is the person's messages and the agent's text blocks, not thinking, tool calls or tool output; each row is cut to 16 384 UTF-16 units; control characters (C0, the snippet markers `\u0002` / `\u0003` among them) become spaces and format characters (bidi overrides, zero-width) are removed, the emoji joiner kept — a snippet's markers can only come from SQLite, and a snippet cannot reorder the palette's text — cost if wrong: a word seen only in tool output is not found.
- M4R47: `matchExpression` keeps at most 8 tokens of letters, digits and marks (what `unicode61` indexes), each at most 64 units, quotes every one (`"tok"`, a `"` doubled), joins them with `AND`, and makes the last a prefix (`"tok"*`) while it is being typed (no trailing space) and at least 2 code points long; nothing else of the input reaches FTS5 — `NEAR`, `OR`, `*`, `^`, `:` and parentheses are never syntax (Orca `quoteFtsTerm`) — cost if wrong: none.
- M4R48: `commit` writes a chunk's rows and the cursor that follows them in one transaction; `forget` deletes a file's rows from the FTS index with the `'delete'` command and the stored text, then the rows and the cursor, in one transaction — a crash never leaves rows without their cursor or the reverse — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`match.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { matchExpression, MAX_QUERY_TERMS } from "./match.ts";

describe("matchExpression (M4R47)", () => {
  it("quotes every word, all required, the last as a prefix while it is typed", () => {
    expect(matchExpression("kubernetes cafe")).toBe('"kubernetes" AND "cafe"*');
    expect(matchExpression("kubernetes cafe ")).toBe('"kubernetes" AND "cafe"');
    expect(matchExpression("a")).toBe('"a"');
    expect(matchExpression("Déploiement")).toBe('"Déploiement"*');
  });

  it("never lets FTS5 syntax through", () => {
    expect(matchExpression('foo" OR bar NEAR(x, y) col:val ^start *')).toBe(
      '"foo" AND "OR" AND "bar" AND "NEAR" AND "x" AND "y" AND "col" AND "val"',
    );
    expect(matchExpression("(a) AND -b")).toBe('"a" AND "AND" AND "b"*');
  });

  it("is null when nothing searchable is left, and keeps at most MAX_QUERY_TERMS terms", () => {
    for (const blank of ["", "   ", "*:()\"'", "\u0000‮"]) expect(matchExpression(blank)).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(matchExpression(many)?.split(" AND ")).toHaveLength(MAX_QUERY_TERMS);
    expect(matchExpression("x".repeat(200))).toBe(`"${"x".repeat(64)}"*`);
    // A letter outside the BMP is two units: 40 of them are cut to 32, never to half a pair.
    expect(matchExpression("𝔸".repeat(40))).toBe(`"${"𝔸".repeat(32)}"*`);
  });

  it("every expression it builds is valid FTS5, whatever was typed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='unicode61 remove_diacritics 2'); INSERT INTO t VALUES ('hello world');");
    const hostile = ['"', '""', "NEAR(", "a:b", "^x", "x*", "OR", "AND NOT", "{a b}", "a\u0000b", "١٢٣", "🙂 ok", "x'); DROP TABLE t; --"];
    for (const input of hostile) {
      const expression = matchExpression(input);
      if (expression !== null) expect(() => db.prepare("SELECT count(*) FROM t WHERE t MATCH ?").get(expression), input).not.toThrow();
    }
    db.close();
  });
});
```

`index-store.test.ts` (temp dir, `openSearchIndex`, removed in `afterEach`):

```ts
it("commits rows and their cursor together, and finds them through FTS5 with diacritics folded", () => {
  store.commit(cursor("/s/a.jsonl", { sessionId: "s1", ownerId: "u1", offset: 120 }), [
    { entryId: "e1", role: "user", at: 1, text: "Déployer le cluster kubernetes" },
    { entryId: "e2", role: "assistant", at: 2, text: "Le café est prêt" },
  ]);
  expect(store.cursor("/s/a.jsonl")).toMatchObject({ offset: 120, state: "indexed", sessionId: "s1" });
  const hits = db.all<{ entry_id: string }>("SELECT r.entry_id FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid WHERE rows_fts MATCH '\"cafe\"'");
  expect(hits.map((hit) => hit.entry_id)).toEqual(["e2"]);
  expect(store.rowCount()).toBe(2);
});

it("forget removes a file's rows from the index and its cursor", () => {
  store.commit(cursor("/s/a.jsonl"), [{ entryId: "e1", role: "user", at: 1, text: "alpha" }]);
  store.commit(cursor("/s/b.jsonl"), [{ entryId: "e9", role: "user", at: 1, text: "alpha" }]);
  store.forget("/s/a.jsonl");
  expect(store.cursor("/s/a.jsonl")).toBeUndefined();
  expect(db.all("SELECT rowid FROM rows_fts WHERE rows_fts MATCH '\"alpha\"'")).toHaveLength(1);
  expect(store.paths()).toEqual(["/s/b.jsonl"]);
});

it("refuses rows on a cursor that names no session", () => {
  expect(() => store.commit(cursor("/s/a.jsonl", { sessionId: null }), [{ entryId: "e1", role: "user", at: 1, text: "x" }])).toThrow();
  expect(store.cursor("/s/a.jsonl")).toBeUndefined();
});

it("indexText turns controls (the snippet markers included) into spaces, drops format characters, cuts without splitting a pair", () => {
  expect(indexText("a\u0002b\u0003c\u0000d\u001be")).toBe("a b c d e");
  expect(indexText("left‮right​!")).toBe("leftright!");
  expect(indexText("tab\tand\nline")).toBe("tab\tand\nline");
  expect(indexText("👩‍💻")).toBe("👩‍💻");
  const long = `${"a".repeat(MAX_ROW_CHARS - 1)}😀`;
  expect(indexText(long)).toBe("a".repeat(MAX_ROW_CHARS - 1));
});
```

(`cursor(path, patch)` builds a `FileCursor` with `ino: 1, size: 200, mtimeMs: 5, offset: 100, head: "{}", state: "indexed", sessionId: "s1", ownerId: "u1", indexedChars: 0` and the patch.)

`index-db.test.ts`:
- a new file gets the schema and `meta.schema_version = "1"`;
- a file whose `schema_version` is `"0"` is deleted and rebuilt (a row written before is gone), one `search_index_rebuilt` line with `reason: "version"`;
- a file that is not a database (write 4 KiB of `x` to the path first) is rebuilt, one line with `reason: "damaged"`;
- the file's mode is `0600` when the process umask is `077` (set and restore `process.umask` in the test).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/search`
Expected: FAIL — the files do not exist.

- [ ] **Step 3: Implement**

`index-db.ts`:

```ts
import { rmSync } from "node:fs";
import { type Db, openDatabase } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";

/** Bump to drop and rebuild: the index is a cache over Pi's files, never a source (ADR 0013). */
export const SEARCH_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  ino INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  offset INTEGER NOT NULL,
  head TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('indexed', 'excluded', 'bad', 'waiting')),
  session_id TEXT,
  owner_id TEXT,
  indexed_chars INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  at INTEGER NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS rows_path ON rows(path);
CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(
  text, content='rows', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
`;

const UNUSABLE = /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|malformed/i;

const remove = (path: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
};

const closeQuietly = (db: Db, logger: Logger): void => {
  try {
    db.close();
  } catch (error) {
    logger.debug("search_index_close_failed", { err: error });
  }
};

function versionOf(db: Db): number | null {
  const hasMeta = db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  if (!hasMeta) return null;
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : null;
}

function prepare(db: Db): Db {
  db.exec(SCHEMA);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', $value)", {
    value: String(SEARCH_SCHEMA_VERSION),
  });
  return db;
}

/** `$PAP_HOME/search.db`, rebuilt when it is another version or damaged (M4R44). */
export function openSearchIndex(path: string, logger: Logger): Db {
  let db: Db | null = null;
  try {
    db = openDatabase(path);
    const version = versionOf(db);
    if (version === null || version === SEARCH_SCHEMA_VERSION) return prepare(db);
    closeQuietly(db, logger);
    remove(path);
    logger.warn("search_index_rebuilt", { reason: "version", from: version });
    return prepare(openDatabase(path));
  } catch (error) {
    if (!UNUSABLE.test(error instanceof Error ? error.message : String(error))) throw error;
    if (db) closeQuietly(db, logger);
    remove(path);
    logger.warn("search_index_rebuilt", { reason: "damaged" });
    return prepare(openDatabase(path));
  }
}
```

`index-store.ts`:

```ts
import type { Db } from "../../kernel/db/database.ts";
import { cutUnits } from "../../kernel/text.ts";

export const MAX_ROW_CHARS = 16_384;

export interface FileCursor {
  readonly path: string;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** The byte just after the last complete line read. */
  readonly offset: number;
  /** The first 512 characters of the header line: a rewrite in place changes them. */
  readonly head: string;
  readonly state: "indexed" | "excluded" | "bad" | "waiting";
  readonly sessionId: string | null;
  readonly ownerId: string | null;
  readonly indexedChars: number;
}

export interface IndexRow {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly at: number;
  readonly text: string;
}

// Controls (C0 and C1, tab and line feed kept) become spaces; format characters go, the emoji joiner kept (M4R46).
const CONTROLS = /[^\P{Cc}\t\n]/gu;
const FORMAT_EXCEPT_ZWJ = /(?!‍)\p{Cf}/gu;

/** Transcript text as it is indexed and later shown in a snippet. */
export const indexText = (raw: string): string =>
  cutUnits(raw.replace(CONTROLS, " ").replace(FORMAT_EXCEPT_ZWJ, ""), MAX_ROW_CHARS);

interface RawCursor {
  path: string;
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  head: string;
  state: FileCursor["state"];
  sessionId: string | null;
  ownerId: string | null;
  indexedChars: number;
}

export interface SearchIndexStore {
  cursor(path: string): FileCursor | undefined;
  paths(): string[];
  /** A chunk's rows and the cursor after them, in one transaction (M4R48). Rows need a cursor that names a session. */
  commit(cursor: FileCursor, rows: readonly IndexRow[]): void;
  /** A file's rows (out of the FTS index too) and its cursor (M4R48). */
  forget(path: string): void;
  rowCount(): number;
}

export function createSearchIndexStore(db: Db): SearchIndexStore {
  return {
    cursor: (path) =>
      db.get<RawCursor>(
        "SELECT path, ino, size, mtime_ms AS mtimeMs, offset, head, state, session_id AS sessionId, owner_id AS ownerId, indexed_chars AS indexedChars FROM files WHERE path = $path",
        { path },
      ),
    paths: () => db.all<{ path: string }>("SELECT path FROM files ORDER BY path").map((row) => row.path),
    commit: (cursor, rows) =>
      db.transaction(() => {
        if (rows.length > 0 && (cursor.sessionId === null || cursor.ownerId === null))
          throw new Error("index rows need a session and an owner");
        for (const row of rows) {
          const inserted = db.get<{ id: number }>(
            "INSERT INTO rows (path, session_id, owner_id, entry_id, role, at, text) VALUES ($path, $sessionId, $ownerId, $entryId, $role, $at, $text) RETURNING id",
            { path: cursor.path, sessionId: cursor.sessionId, ownerId: cursor.ownerId, ...row },
          );
          db.run("INSERT INTO rows_fts (rowid, text) VALUES ($id, $text)", { id: inserted?.id ?? null, text: row.text });
        }
        db.run(
          "INSERT INTO files (path, ino, size, mtime_ms, offset, head, state, session_id, owner_id, indexed_chars) " +
            "VALUES ($path, $ino, $size, $mtimeMs, $offset, $head, $state, $sessionId, $ownerId, $indexedChars) " +
            "ON CONFLICT (path) DO UPDATE SET ino = excluded.ino, size = excluded.size, mtime_ms = excluded.mtime_ms, " +
            "offset = excluded.offset, head = excluded.head, state = excluded.state, session_id = excluded.session_id, " +
            "owner_id = excluded.owner_id, indexed_chars = excluded.indexed_chars",
          { ...cursor },
        );
      }),
    forget: (path) =>
      db.transaction(() => {
        for (const row of db.all<{ id: number; text: string }>("SELECT id, text FROM rows WHERE path = $path", { path }))
          db.run("INSERT INTO rows_fts (rows_fts, rowid, text) VALUES ('delete', $id, $text)", row);
        db.run("DELETE FROM rows WHERE path = $path", { path });
        db.run("DELETE FROM files WHERE path = $path", { path });
      }),
    rowCount: () => db.get<{ n: number }>("SELECT count(*) AS n FROM rows")?.n ?? 0,
  };
}
```

`match.ts`:

```ts
import { cutUnits } from "../../kernel/text.ts";

/** What `unicode61` indexes as a word: letters, digits and combining marks (M4R47). */
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
export const MAX_QUERY_TERMS = 8;
const MAX_TERM_UNITS = 64;
const MIN_PREFIX_POINTS = 2;

/**
 * The FTS5 MATCH expression for what a person typed (M4R47): every word quoted, all of them required, the last one a
 * prefix while it is being typed. Nothing else of the input reaches FTS5. Null when no word is left.
 */
export function matchExpression(query: string): string | null {
  const tokens = [...query.normalize("NFKC").matchAll(TOKEN)]
    .map((match) => cutUnits(match[0], MAX_TERM_UNITS))
    .slice(0, MAX_QUERY_TERMS);
  if (tokens.length === 0) return null;
  const typing = !/\s$/u.test(query);
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      const last = index === tokens.length - 1;
      return last && typing && [...token].length >= MIN_PREFIX_POINTS ? `${quoted}*` : quoted;
    })
    .join(" AND ");
}
```

`docs/adr/0013-search-index-cache-file.md`:

```markdown
# ADR 0013 — The search index is a cache file of its own, queried in a worker thread

Status: proposed · Date: 2026-10-12 · Spec: C §3.2 (tables: `session_search` (FTS5) in `state.db`; "Heavy FTS queries run in a worker thread") · Owner question: M4-Q4

## Context

M4 indexes every Pi session created after the install (spec D) for ⌘K. The index is derived from Pi's JSONL files, which
pap reads in place and never owns (C §3.1). It can grow to hundreds of megabytes at 10 000 sessions.

## Decision

The FTS5 index and the scanner's byte-offset cursors live in `$PAP_HOME/search.db`, not in `state.db`:

- It is a cache. A schema change bumps `SEARCH_SCHEMA_VERSION`; a version mismatch or a damaged file deletes the file
  and the scanner rebuilds it from the Pi files (bounded by the install cutoff). No migration, no pre-migration snapshot.
- `state.db` stays small, so its pre-migration snapshots and `pap backup` (M6) stay cheap; the backup can leave
  `search.db` out.
- The daemon is still the single writer (the scanner, on the main thread, in short transactions). Queries run in one
  worker thread with its own read-only connection (WAL), as spec C asks; a query past 2 s terminates the thread.

## Consequences

- One more 0600 file in `$PAP_HOME`; it holds transcript text (user and agent messages), like the Pi files it comes from.
- Deleting `search.db` is always safe: the next start rebuilds it.
- The `sessions` table (state.db) stays the list of sessions; `search.db` only says where a word was seen.
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon/src/modules/search && pnpm lint && pnpm typecheck`
Expected: PASS (`pnpm knip` may flag the new files as unused until Task 12 wires them: run it in Task 12; note it in the report).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/search docs/adr/0013-search-index-cache-file.md
git commit -m "feat(search): a rebuildable FTS5 index in search.db and a query builder that quotes every term (ADR 0013)"
```

---

### Task 12: The search worker thread, its client, and `search.query`

**Files:**
- Create: `apps/daemon/src/modules/search/{query.ts,search-thread.ts,search-client.ts,service.ts,rpc.ts,index.ts}`
- Create: tests `query.test.ts`, `search-client.test.ts`, `search-thread.imports.test.ts`, `service.test.ts`, `rpc.test.ts`, `search-client.int.test.ts`
- Create: `apps/daemon/src/modules/sessions/scan-port.ts` (the `summary` part)
- Modify: `apps/daemon/src/modules/sessions/{index.ts,service.ts}`, `apps/daemon/src/daemon.ts`, `knip.json`, `packages/contracts/src/shell.ts` (`SearchHit`, `SNIPPET_OPEN`, `SNIPPET_CLOSE`, `search.query`)

**Interfaces:**
- Consumes: Task 11 `openSearchIndex`, `matchExpression`; Task 8 `SessionsService.summary`.
- Produces:
  - `runQuery(db: DatabaseSync, input: QueryInput): QueryRow[]` with `interface QueryInput { match: string; ownerId: string; limit: number }`, `interface QueryRow { sessionId; entryId; role; at; snippet }`, `RAW_HITS = 200` (`query.ts`).
  - `threadEntry(moduleUrl: string): URL`; `interface ThreadLike`; `type SpawnThread = (dbPath: string) => ThreadLike`; `createSearchClient({ dbPath, clock, logger, spawn? }): SearchClient` with `query(input): Promise<QueryRow[]>`, `stop(): Promise<void>`; `QUERY_TIMEOUT_MS = 2000`, `MAX_IN_FLIGHT = 4`, `IDLE_STOP_MS = 300_000`, `MAX_SPAWNS_PER_MINUTE = 3` (`search-client.ts`).
  - `interface SessionsScanPort { summary(sessionId: string, ownerId: string): ShellSession | null }` (extended in Task 14); `SessionsModule.scanPort`.
  - `createSearchModule({ home, clock, logger, sessions, spawn? }): SearchModule` with `rpc`, `stop()` (the scanner joins in Task 16).
  - Contract: `search.query { q, limit? } → { hits: SearchHit[] }`; `SearchHit { sessionId, entryId, role, at, snippet, session: ShellSession }`.

**Rulings (pre-dispatch):**
- M4R49: One worker thread runs every query, on its own read-only connection; it starts on the first query and stops after 5 idle minutes — spec C §3.2; an idle daemon keeps its RSS (R108) — cost if wrong: the first search after a pause pays about 50 ms to start the thread.
- M4R50: A query has 2 s. Past that the thread is terminated (it may be stuck inside SQLite), the query and those queued behind it answer `timeout`, and the next query starts a new thread; a thread that exits or errors on its own answers `internal` to its pending queries — timeout is not death (checklist) — cost if wrong: none.
- M4R51: At most 4 queries in flight (`capacity` past that); at most 3 thread starts a minute (`internal` past that, logged once) — no crash loop can spin the daemon — cost if wrong: a burst of searches refused for a moment.
- M4R52: The thread entry and `query.ts` import only `node:` built-ins and each other: a worker thread runs plain Node, without the development condition or a build of `@pap/contracts` (CI runs `test:int` before `build`); `search-thread.imports.test.ts` pins it — cost if wrong: none.
- M4R53: `threadEntry` picks `search-thread.ts` next to a `.ts` module (sources, tests) and `search-thread.js` next to a `.js` one (the build); `pnpm smoke` exercises the built one (Task 28) — tsc does not rewrite a URL string — cost if wrong: none.
- M4R54: Hits: the best row per session (bm25), at most 20 sessions out of the best 200 rows; a hit whose session is not the caller's or is gone is dropped; archived sessions are included (`session.archivedAt` says so); a search error carries a code only, never the query (T3 `ThreadSearch.ts`) — cost if wrong: a 21st matching session not offered.
- M4R55: Snippets come from FTS5's `snippet()` with `\u0002` / `\u0003` around matches, at most 16 tokens, cut to 400 units without splitting a pair — markers that indexed text can never hold (M4R46) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`query.test.ts` (an index built with Task 11's store in a temp dir; the query run on a second, read-only `DatabaseSync` of the same file):

```ts
it("answers the best row of each of the caller's sessions, with marked snippets", () => {
  commit("/s/a.jsonl", "s1", "u1", [["e1", "user", "deploy the kubernetes cluster"], ["e2", "assistant", "kubernetes is ready"]]);
  commit("/s/b.jsonl", "s2", "u1", [["e3", "user", "a cafe near the cluster"]]);
  commit("/s/c.jsonl", "s3", "u2", [["e4", "user", "kubernetes for someone else"]]);
  const rows = runQuery(reader, { match: '"kubernetes"', ownerId: "u1", limit: 20 });
  expect(rows.map((row) => row.sessionId)).toEqual(["s1"]);
  expect(rows[0]?.snippet).toContain("\u0002kubernetes\u0003");
  expect(runQuery(reader, { match: '"cluster"', ownerId: "u1", limit: 1 })).toHaveLength(1);
});
```

`search-client.test.ts` (a fake `ThreadLike` that records posted messages and lets the test answer, emit `error`/`exit`; `createFakeClock`):
- the thread starts on the first query only; two queries share it;
- an answer settles its query by id; an answer for an unknown id (late, after a timeout) is ignored;
- 4 queries in flight: the 5th rejects `capacity` without posting;
- a query unanswered for 2 000 ms rejects `timeout`, the thread is terminated, a second pending query rejects `timeout` too, and the next query spawns a new thread;
- the thread exiting rejects pending queries with `internal`; the next query spawns again;
- after 3 spawns within a minute the 4th query rejects `internal` without spawning and logs `search_thread_restarts` once; a minute later it spawns;
- 5 idle minutes after the last answer the thread is terminated; a query in between keeps it;
- `stop()` rejects pending queries with `internal`, terminates the thread, and later queries reject `internal`;
- a `postMessage` that throws rejects that query `internal` and logs `search_thread_post_failed`;
- `threadEntry("file:///m/search-client.ts").pathname` ends in `/m/search-thread.ts`, `.js` gives `.js`.

`search-thread.imports.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the thread entry and its query import only node built-ins and each other (M4R52)", () => {
  for (const file of ["./search-thread.ts", "./query.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const specifier of specifiers) expect(specifier, file).toMatch(/^(node:|\.\/query\.ts$)/);
  }
});
```

`service.test.ts`: with a fake client and a fake sessions port, `query(caller("u1"), { q: "kube" })` passes `{ match: '"kube"*', ownerId: "u1", limit: 20 }`; drops a row whose summary is null; cuts a 500-unit snippet to 400 without a lone surrogate; answers `{ hits: [] }` without calling the client for `q: "*()"`; a client rejection with `PapError("timeout")` rejects the same.

`rpc.test.ts`: `"search.query"` passes `ctx.caller` and the params to `service.query`.

`search-client.int.test.ts` (real worker thread, real index in a temp dir, system clock): a query finds a committed row; a second client on the same file after `stop()` of the first works; after `stop()` the worker has exited (listen for `exit` through a spawn wrapper).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/search && pnpm test:int apps/daemon/src/modules/search`
Expected: FAIL.

- [ ] **Step 3: Implement**

`query.ts`:

```ts
import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface QueryInput {
  readonly match: string;
  readonly ownerId: string;
  readonly limit: number;
}

export interface QueryRow {
  readonly sessionId: string;
  readonly entryId: string;
  readonly role: string;
  readonly at: number;
  readonly snippet: string;
}

/** The best rows looked at; hits are the best row of each session among them (M4R54). */
export const RAW_HITS = 200;

const SQL =
  "SELECT r.session_id AS sessionId, r.entry_id AS entryId, r.role AS role, r.at AS at, " +
  "snippet(rows_fts, 0, char(2), char(3), '…', 16) AS snippet " +
  "FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid " +
  "WHERE rows_fts MATCH $match AND r.owner_id = $owner ORDER BY bm25(rows_fts) LIMIT $raw";

const prepared = new WeakMap<DatabaseSync, StatementSync>();

export function runQuery(db: DatabaseSync, input: QueryInput): QueryRow[] {
  let statement = prepared.get(db);
  if (!statement) {
    statement = db.prepare(SQL);
    prepared.set(db, statement);
  }
  const rows = statement.all({ match: input.match, owner: input.ownerId, raw: RAW_HITS }) as unknown as QueryRow[];
  const seen = new Set<string>();
  const hits: QueryRow[] = [];
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    hits.push(row);
    if (hits.length >= input.limit) break;
  }
  return hits;
}
```

`search-thread.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { runQuery, type QueryInput } from "./query.ts";

// A worker thread of the search module (ADR 0013): one read-only connection, one query at a time.
const port = parentPort;
if (!port) throw new Error("search-thread runs as a worker thread");
const db = new DatabaseSync(String((workerData as { path?: unknown }).path), { readOnly: true });
db.exec("PRAGMA busy_timeout = 1000");

port.on("message", (message: { id: number; input: QueryInput }) => {
  try {
    port.postMessage({ id: message.id, ok: true, rows: runQuery(db, message.input) });
  } catch (error) {
    // A code, never SQLite's text: the main thread logs it and answers `internal`.
    const code = (error as { code?: unknown } | null)?.code;
    port.postMessage({ id: message.id, ok: false, code: typeof code === "string" ? code.slice(0, 64) : "query_failed" });
  }
});
```

`search-client.ts`:

```ts
import { Worker } from "node:worker_threads";
import { PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { QueryInput, QueryRow } from "./query.ts";

export const QUERY_TIMEOUT_MS = 2_000;
export const MAX_IN_FLIGHT = 4;
export const IDLE_STOP_MS = 5 * 60_000;
export const MAX_SPAWNS_PER_MINUTE = 3;

export interface ThreadLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}
export type SpawnThread = (dbPath: string) => ThreadLike;

/** The thread file next to this module: TypeScript in the sources, JavaScript in the build (M4R53). */
export const threadEntry = (moduleUrl: string): URL =>
  new URL(moduleUrl.endsWith(".ts") ? "./search-thread.ts" : "./search-thread.js", moduleUrl);

const spawnSearchThread: SpawnThread = (dbPath) =>
  new Worker(threadEntry(import.meta.url), {
    workerData: { path: dbPath },
    execArgv: ["--disable-warning=ExperimentalWarning"],
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });

export interface SearchClient {
  query(input: QueryInput): Promise<QueryRow[]>;
  stop(): Promise<void>;
}

interface Pending {
  resolve(rows: QueryRow[]): void;
  reject(error: PapError): void;
  readonly timer: TimerHandle;
}

type Answer = { id: number; ok: true; rows: QueryRow[] } | { id: number; ok: false; code: string };
const answerOf = (message: unknown): Answer | null => {
  const value = message as { id?: unknown; ok?: unknown; rows?: unknown; code?: unknown } | null;
  if (typeof value?.id !== "number") return null;
  if (value.ok === true && Array.isArray(value.rows)) return { id: value.id, ok: true, rows: value.rows as QueryRow[] };
  if (value.ok === false) return { id: value.id, ok: false, code: String(value.code).slice(0, 64) };
  return null;
};

export function createSearchClient(deps: {
  readonly dbPath: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly spawn?: SpawnThread;
}): SearchClient {
  const spawn = deps.spawn ?? spawnSearchThread;
  const pending = new Map<number, Pending>();
  const spawns: number[] = [];
  let thread: ThreadLike | null = null;
  let idle: TimerHandle | null = null;
  let nextId = 1;
  let stopped = false;
  let saidRestarts = false;

  const rejectAll = (code: "timeout" | "internal") => {
    for (const entry of pending.values()) {
      deps.clock.clearTimeout(entry.timer);
      entry.reject(new PapError(code));
    }
    pending.clear();
  };
  const drop = () => {
    const current = thread;
    thread = null;
    if (current)
      current.terminate().catch((error: unknown) => deps.logger.debug("search_thread_terminate_failed", { err: error }));
  };
  const armIdle = () => {
    if (idle) deps.clock.clearTimeout(idle);
    idle = null;
    if (!thread || pending.size > 0) return;
    idle = deps.clock.setTimeout(() => {
      idle = null;
      if (pending.size === 0) drop();
    }, IDLE_STOP_MS);
  };
  const ensure = (): ThreadLike => {
    if (thread) return thread;
    const now = deps.clock.now();
    while (spawns.length > 0 && now - (spawns[0] ?? 0) >= 60_000) spawns.shift();
    if (spawns.length >= MAX_SPAWNS_PER_MINUTE) {
      if (!saidRestarts) deps.logger.warn("search_thread_restarts", { max: MAX_SPAWNS_PER_MINUTE });
      saidRestarts = true;
      throw new PapError("internal");
    }
    saidRestarts = false;
    spawns.push(now);
    const created = spawn(deps.dbPath);
    created.unref();
    // Events of a thread that was replaced since are ignored: only the current one settles queries.
    created.on("message", (message) => {
      if (created !== thread) return;
      const answer = answerOf(message);
      const entry = answer ? pending.get(answer.id) : undefined;
      if (!answer || !entry) return;
      pending.delete(answer.id);
      deps.clock.clearTimeout(entry.timer);
      if (answer.ok) entry.resolve(answer.rows);
      else {
        deps.logger.warn("search_query_failed", { code: answer.code });
        entry.reject(new PapError("internal"));
      }
      armIdle();
    });
    const gone = (kind: string, code: string) => {
      if (created !== thread) return;
      thread = null;
      deps.logger.warn("search_thread_failed", { kind, code });
      rejectAll("internal");
    };
    created.on("error", (error) => gone("error", (error as { code?: string }).code ?? error.name));
    created.on("exit", (code) => gone("exit", String(code)));
    thread = created;
    return created;
  };

  return {
    query(input) {
      if (stopped) return Promise.reject(new PapError("internal"));
      if (pending.size >= MAX_IN_FLIGHT) return Promise.reject(new PapError("capacity"));
      let current: ThreadLike;
      try {
        current = ensure();
      } catch (error) {
        return Promise.reject(error instanceof PapError ? error : new PapError("internal"));
      }
      if (idle) deps.clock.clearTimeout(idle);
      idle = null;
      const id = nextId++;
      return new Promise<QueryRow[]>((resolve, reject) => {
        const timer = deps.clock.setTimeout(() => {
          // The thread may be stuck inside this query: it goes, and what waits behind it times out too (M4R50).
          pending.delete(id);
          deps.logger.warn("search_query_timeout", { ms: QUERY_TIMEOUT_MS });
          rejectAll("timeout");
          drop();
          reject(new PapError("timeout"));
        }, QUERY_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          current.postMessage({ id, input });
        } catch (error) {
          pending.delete(id);
          deps.clock.clearTimeout(timer);
          deps.logger.warn("search_thread_post_failed", { err: error });
          reject(new PapError("internal"));
        }
      });
    },
    async stop() {
      stopped = true;
      if (idle) deps.clock.clearTimeout(idle);
      idle = null;
      rejectAll("internal");
      const current = thread;
      thread = null;
      // A thread that already exited rejects `terminate()`; `stop()` must settle all the same.
      if (current)
        await current.terminate().catch((error: unknown) => deps.logger.debug("search_thread_terminate_failed", { err: error }));
    },
  };
}
```

Contract (`shell.ts`):

```ts
/** The markers a snippet carries around a match; indexed text never holds them (M4R46, M4R55). */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

export const SearchHit = z.object({
  sessionId: Id,
  entryId: Id,
  role: z.enum(["user", "assistant"]),
  at: Millis,
  snippet: z.string().max(SHELL_LIMITS.snippet),
  session: ShellSession,
});
export type SearchHit = z.infer<typeof SearchHit>;
```

and in `shellMethods`:

```ts
  "search.query": defineMethod({
    name: "search.query",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({
      q: z.string().min(1).max(SHELL_LIMITS.searchQuery),
      limit: z.number().int().min(1).max(SHELL_LIMITS.searchHits).optional(),
    }),
    result: z.object({ hits: z.array(SearchHit).max(SHELL_LIMITS.searchHits) }),
    // `timeout`: the query ran past 2 s and was stopped; `capacity`: too many searches at once (M4R50, M4R51).
    errors: ["timeout", "capacity"],
  }),
```

`service.ts` (search):

```ts
import { type Caller, type SearchHit, SHELL_LIMITS } from "@pap/contracts";
import { cutUnits } from "../../kernel/text.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { matchExpression } from "./match.ts";
import type { SearchClient } from "./search-client.ts";

export function createSearchService(deps: {
  readonly client: Pick<SearchClient, "query">;
  readonly sessions: Pick<SessionsScanPort, "summary">;
}) {
  return {
    async query(caller: Caller, params: { q: string; limit?: number | undefined }): Promise<{ hits: SearchHit[] }> {
      const match = matchExpression(params.q);
      if (match === null) return { hits: [] };
      const rows = await deps.client.query({
        match,
        ownerId: caller.userId,
        limit: params.limit ?? SHELL_LIMITS.searchHits,
      });
      const hits: SearchHit[] = [];
      for (const row of rows) {
        if (row.role !== "user" && row.role !== "assistant") continue;
        const session = deps.sessions.summary(row.sessionId, caller.userId);
        if (!session) continue;
        hits.push({
          sessionId: row.sessionId,
          entryId: row.entryId,
          role: row.role,
          at: row.at,
          snippet: cutUnits(row.snippet, SHELL_LIMITS.snippet),
          session,
        });
      }
      // 20 hits of at most ~9 KB each: always far under the frame.
      return { hits };
    },
  };
}
export type SearchService = ReturnType<typeof createSearchService>;
```

`rpc.ts`: `export type SearchRpc = Pick<HandlerTable, "search.query">;` with `"search.query": async (params, ctx) => service.query(ctx.caller, params)`.

`index.ts` (search):

```ts
import { join } from "node:path";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { openSearchIndex } from "./index-db.ts";
import { searchRpc, type SearchRpc } from "./rpc.ts";
import { createSearchClient, type SpawnThread } from "./search-client.ts";
import { createSearchService } from "./service.ts";

export interface SearchModule {
  readonly rpc: SearchRpc;
  stop(): Promise<void>;
}

export function createSearchModule(deps: {
  readonly home: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessions: SessionsScanPort;
  readonly spawn?: SpawnThread;
}): SearchModule {
  const logger = deps.logger.child({ module: "search" });
  const dbPath = join(deps.home, "search.db");
  const db = openSearchIndex(dbPath, logger);
  const client = createSearchClient({ dbPath, clock: deps.clock, logger, ...(deps.spawn ? { spawn: deps.spawn } : {}) });
  const service = createSearchService({ client, sessions: deps.sessions });
  return {
    rpc: searchRpc(service),
    async stop() {
      await client.stop();
      db.close();
    },
  };
}
```

`sessions/scan-port.ts`: `export interface SessionsScanPort { summary(sessionId: string, ownerId: string): ShellSession | null }`; the sessions module's `index.ts` exports the type and `SessionsModule.scanPort: SessionsScanPort = { summary: service.summary }`.

`daemon.ts`: `const search = createSearchModule({ home: config.home, clock, logger, sessions: sessions.scanPort });` right after the sessions module, `closers.push({ name: "search", close: () => search.stop() });` right after it (it closes before the database), `...search.rpc` in `handlers`.

`knip.json`: `"apps/daemon"` gains `"entry": ["src/modules/search/search-thread.ts"]`.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm test:unit apps/daemon packages/contracts && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip && pnpm smoke`
Expected: PASS. Mutation checks: drop `if (created !== thread) return;` in the message listener → the "late answer after a timeout" case fails; drop the `MAX_IN_FLIGHT` check → the `capacity` case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/search apps/daemon/src/modules/sessions apps/daemon/src/daemon.ts knip.json packages/contracts
git commit -m "feat(search): search.query over FTS5 in a worker thread, with deadlines, a cap and an idle stop"
```

---

### Task 13: Reading a Pi file from a byte offset — the header, complete lines only, and what to index

**Files:**
- Create: `apps/daemon/src/modules/search/{session-file.ts,extract.ts}`, tests `session-file.test.ts`, `extract.test.ts`

**Interfaces:**
- Consumes: Task 11 `indexText`, `IndexRow`.
- Produces (`session-file.ts`): `HEADER_MAX_BYTES = 65_536`, `HEAD_CHARS = 512`, `READ_STEP_BYTES = 1_048_576`, `MAX_LINE_BYTES = 8_388_608`; `interface PiHeader { id; cwd; createdAt }`; `parseHeader(line: string): PiHeader | null`; `openRegular(path): { fd: number; size: number; ino: number; mtimeMs: number } | { refused: string }`; `readHeaderLine(fd, size): { line: string; end: number } | null`; `readLines(fd, from, size, budget?): { records: Array<Record<string, unknown>>; next: number; bad: number; skipped: number }`.
- Produces (`extract.ts`): `interface Extracted { rows: IndexRow[]; name: string | null | undefined; firstUser: string | null; active: boolean }`; `extract(records): Extracted`.

**Rulings (pre-dispatch):**
- M4R56: A Pi file is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and must be a regular file by `fstat` on that descriptor: a link is never followed, a FIFO never blocks the loop — the files are writable by the agent, extensions and the CLI (M2R48's threat) — cost if wrong: none (Pi writes regular files).
- M4R57: A header is valid when it is JSON with `type: "session"`, an `id` of 1–128 of `[A-Za-z0-9_-]` starting with a letter or digit, an absolute `cwd` of at most 4096 characters without a control character, and a `timestamp` `Date.parse` reads — what `isPiSessionFile` and the `sessions` table accept — cost if wrong: an odd custom `--session-id` not adopted (logged).
- M4R58: `readLines` consumes complete lines only (`next` stops after the last `\n`): a line Pi is still writing waits for the next read (R38). One read takes about `budget` bytes (1 MiB by default) of whole lines; a line longer than 8 MiB is skipped unparsed and counted — a huge tool result must not be held in memory to find no text worth indexing — cost if wrong: an assistant message over 8 MiB not indexed.
- M4R59: Indexed: user messages (a string, or their text blocks) and assistant `text` blocks; the last `session_info` name in the chunk; the first user message as the preview source; `active` when a user or assistant message was read. Entry ids over 128 characters are skipped; a time comes from the entry's ISO `timestamp`, else the message's own millisecond `timestamp`, else 0, clamped to `Date`'s range — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`session-file.test.ts` (temp dir removed in `afterEach`):

```ts
const header = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "session", version: 3, id: "0f9a2c1e-1111-4222-8333-944455556666", timestamp: "2026-10-12T10:00:00.000Z", cwd: "/w/api", ...patch });

describe("parseHeader (M4R57)", () => {
  it("reads a Pi header", () => {
    expect(parseHeader(header())).toEqual({ id: "0f9a2c1e-1111-4222-8333-944455556666", cwd: "/w/api", createdAt: Date.parse("2026-10-12T10:00:00.000Z") });
  });
  it("refuses anything else", () => {
    for (const line of [
      "not json",
      JSON.stringify({ type: "message" }),
      header({ id: "" }),
      header({ id: "-dash" }),
      header({ id: "a".repeat(129) }),
      header({ id: "../x" }),
      header({ cwd: "relative" }),
      header({ cwd: "/a\u0000b" }),
      header({ cwd: `/${"a".repeat(4096)}` }),
      header({ timestamp: "yesterday" }),
      header({ timestamp: 5 }),
    ])
      expect(parseHeader(line), line.slice(0, 60)).toBeNull();
  });
});

describe("reading lines from an offset (M4R58)", () => {
  it("returns complete lines only, and the offset after the last one", () => {
    const path = write("a.jsonl", `${header()}\n{"type":"x","id":"1"}\n{"type":"y","id":"2"}\n{"type":"z","id`);
    const file = open(path);
    const head = readHeaderLine(file.fd, file.size);
    expect(head?.line).toBe(header());
    const read = readLines(file.fd, (head?.end ?? 0) + 1, file.size);
    expect(read.records.map((record) => record.type)).toEqual(["x", "y"]);
    expect(read.next).toBe(Buffer.byteLength(`${header()}\n{"type":"x","id":"1"}\n{"type":"y","id":"2"}\n`));
    closeSync(file.fd);
  });

  it("stops at about the budget, on a line boundary, and goes on from there", () => {
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: "m", id: String(i), pad: "p".repeat(100) }));
    const path = write("b.jsonl", `${lines.join("\n")}\n`);
    const file = open(path);
    const first = readLines(file.fd, 0, file.size, 1000);
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.records.length).toBeLessThan(50);
    const rest = readLines(file.fd, first.next, file.size);
    expect([...first.records, ...rest.records].map((record) => record.id)).toEqual(lines.map((_, i) => String(i)));
    closeSync(file.fd);
  });

  it("skips a line over MAX_LINE_BYTES without parsing it, and counts unparsable lines", () => {
    const big = `{"type":"toolResult","x":"${"x".repeat(MAX_LINE_BYTES)}"}`;
    const path = write("c.jsonl", `{"type":"a","id":"1"}\n${big}\nnot json\n{"type":"b","id":"2"}\n`);
    const file = open(path);
    const read = readLines(file.fd, 0, file.size, MAX_LINE_BYTES * 2);
    expect(read.records.map((record) => record.type)).toEqual(["a", "b"]);
    expect([read.skipped, read.bad]).toEqual([1, 1]);
    closeSync(file.fd);
  });

  it("finds no header line until its newline is written, nor one past 64 KiB", () => {
    const partial = open(write("d.jsonl", header()));
    expect(readHeaderLine(partial.fd, partial.size)).toBeNull();
    closeSync(partial.fd);
    const long = open(write("e.jsonl", `${header({ pad: "x".repeat(HEADER_MAX_BYTES) })}\n`));
    expect(readHeaderLine(long.fd, long.size)).toBeNull();
    closeSync(long.fd);
  });
});

describe("openRegular (M4R56)", () => {
  it("refuses a link, a FIFO and a missing file, and never blocks", () => {
    const target = write("real.jsonl", `${header()}\n`);
    symlinkSync(target, join(dir, "link.jsonl"));
    expect(openRegular(join(dir, "link.jsonl"))).toEqual({ refused: "ELOOP" });
    execFileSync("mkfifo", [join(dir, "pipe.jsonl")]);
    expect(openRegular(join(dir, "pipe.jsonl"))).toEqual({ refused: "not_file" });
    expect(openRegular(join(dir, "gone.jsonl"))).toEqual({ refused: "ENOENT" });
  });
});
```

(`write(name, text)` writes into the temp dir and returns the path; `open(path)` asserts `"fd" in` the result of `openRegular` and returns it.)

`extract.test.ts`:
- with records written by the plan's own fixture builder (`testing/pi-file-writers.ts` `sessionFileText` lines parsed back) and extra entries: rows are the user and assistant texts with entry ids, roles and the ISO times; thinking, tool calls, tool results, the system message and custom messages give no row; `firstUser` is the first user text; `active` is true;
- a `session_info` entry sets `name`; two of them keep the last; none leaves `name` `undefined`;
- an assistant message whose content blocks are `[{ type: "thinking" }, { type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }]` gives the text `"a\nb"`;
- an entry id of 129 characters gives no row;
- a message whose text is only whitespace gives no row and `active` stays true (it is a message);
- **the real Pi format**: write a session with the SDK's own `SessionManager` (`import { SessionManager, getDefaultSessionDir } from "@earendil-works/pi-coding-agent"`: `SessionManager.create(cwd, sessionDir)`, `appendMessage({ role: "user", content: "hello from pi", timestamp: Date.now() })`, an assistant message with a text block (shape from the `.d.ts`), `appendSessionInfo("Named by pi")`); read it with `readHeaderLine` / `readLines` / `parseHeader` / `extract`: one user row "hello from pi", one assistant row, `name: "Named by pi"`, the header's id equal to `getSessionId()`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/search/session-file.test.ts apps/daemon/src/modules/search/extract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`session-file.ts`:

```ts
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

export const HEADER_MAX_BYTES = 64 * 1024;
export const HEAD_CHARS = 512;
export const READ_STEP_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface PiHeader {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL = /\p{Cc}/u;

/** A Pi session header (M4R57), or null. A line that is not JSON is simply not a header: the caller says so in its log. */
export function parseHeader(line: string): PiHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = value as { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown } | null;
  if (typeof record !== "object" || record === null || record.type !== "session") return null;
  const { id, cwd, timestamp } = record;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 4096 || CONTROL.test(cwd)) return null;
  const createdAt = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(createdAt) || createdAt < 0) return null;
  return { id, cwd, createdAt };
}

/** A regular file opened without following a link nor blocking on a FIFO (M4R56), or why not (an errno code). */
export function openRegular(
  path: string,
): { fd: number; size: number; ino: number; mtimeMs: number } | { refused: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { refused: (error as NodeJS.ErrnoException).code ?? "open_failed" };
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) return { fd, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    closeSync(fd);
    return { refused: (error as NodeJS.ErrnoException).code ?? "stat_failed" };
  }
  closeSync(fd);
  return { refused: "not_file" };
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/** The first line, when its newline is within the first 64 KiB; null otherwise (not written yet, or no header). */
export function readHeaderLine(fd: number, size: number): { line: string; end: number } | null {
  const head = readAt(fd, 0, Math.min(size, HEADER_MAX_BYTES));
  const end = head.indexOf(0x0a);
  return end === -1 ? null : { line: head.toString("utf8", 0, end), end };
}

function parseLine(bytes: Buffer): Record<string, unknown> | null {
  const text = bytes.toString("utf8").trim();
  if (text === "") return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Counted as `bad` by the caller and said in one rate-limited log line (as Pi's own reader skips it).
    return null;
  }
}

/**
 * Complete lines from byte `from` (M4R58): about `budget` bytes of whole lines, `next` just after the last newline read.
 * An unfinished last line stays for the next read; a line over MAX_LINE_BYTES is skipped unparsed.
 */
export function readLines(fd: number, from: number, size: number, budget = READ_STEP_BYTES) {
  const records: Array<Record<string, unknown>> = [];
  let bad = 0;
  let skipped = 0;
  let next = from;
  let position = from;
  let carry: Buffer[] = [];
  let carried = 0;
  let skipping = false;
  outer: while (position < size && next - from < budget) {
    const chunk = readAt(fd, position, Math.min(READ_STEP_BYTES, size - position));
    if (chunk.length === 0) break;
    const chunkStart = position;
    position += chunk.length;
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      if (skipping) {
        skipping = false;
        skipped++;
      } else {
        const line = carried > 0 ? Buffer.concat([...carry, chunk.subarray(start, newline)]) : chunk.subarray(start, newline);
        const record = parseLine(line);
        if (record) records.push(record);
        else if (line.toString("utf8").trim() !== "") bad++;
      }
      carry = [];
      carried = 0;
      next = chunkStart + newline + 1;
      start = newline + 1;
      if (next - from >= budget) break outer;
    }
    const rest = chunk.subarray(start);
    if (skipping || rest.length === 0) continue;
    if (carried + rest.length > MAX_LINE_BYTES) {
      skipping = true;
      carry = [];
      carried = 0;
    } else {
      carry.push(rest);
      carried += rest.length;
    }
  }
  return { records, next, bad, skipped };
}
```

(`parseLine`'s catch maps an unreadable line to "not a record"; `readLines` counts it in `bad` and the caller says it in one rate-limited line — the checklist's "mapping, then a log line".)

`extract.ts`:

```ts
import { MAX_ID_CHARS } from "../../kernel/text.ts";
import { indexText, type IndexRow } from "./index-store.ts";

export interface Extracted {
  readonly rows: IndexRow[];
  /** The last `session_info` name read (raw); `undefined` when none was. */
  readonly name: string | null | undefined;
  readonly firstUser: string | null;
  /** A user or assistant message was read: activity for the 3-day rule (M4R41). */
  readonly active: boolean;
}

const MAX_MILLIS = 8.64e15;
const timeOf = (entry: { timestamp?: unknown }, message: { timestamp?: unknown }): number => {
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  const raw = Number.isFinite(parsed) ? parsed : typeof message.timestamp === "number" ? message.timestamp : 0;
  return Math.min(MAX_MILLIS, Math.max(0, Math.trunc(Number.isFinite(raw) ? raw : 0)));
};

function textOf(role: "user" | "assistant", content: unknown): string {
  if (typeof content === "string") return role === "user" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: unknown }).type === "text")
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** What a chunk of Pi entries gives the index and the session (M4R59). */
export function extract(records: ReadonlyArray<Record<string, unknown>>): Extracted {
  const rows: IndexRow[] = [];
  let name: string | null | undefined;
  let firstUser: string | null = null;
  let active = false;
  for (const record of records) {
    if (record.type === "session_info") {
      name = typeof record.name === "string" ? record.name : null;
      continue;
    }
    if (record.type !== "message") continue;
    const message = (record.message ?? {}) as { role?: unknown; content?: unknown; timestamp?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    active = true;
    const raw = textOf(message.role, message.content);
    if (message.role === "user" && firstUser === null && raw.trim() !== "") firstUser = raw;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) continue;
    const text = indexText(raw);
    if (text.trim() === "") continue;
    rows.push({ entryId: id, role: message.role, at: timeOf(record, message), text });
  }
  return { rows, name, firstUser, active };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon/src/modules/search && pnpm lint && pnpm typecheck`
Expected: PASS. Mutation check: open without `O_NOFOLLOW` → the link case fails; consume the unterminated tail → the first lines case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/search
git commit -m "feat(search): read Pi files safely from a byte offset, complete lines only, and extract what to index"
```

---

### Task 14: Adoption — one pap session per Pi file (the sessions scan port and the owner)

The scanner never writes the `sessions` table: it asks the sessions module, through a port, which pap session a Pi file belongs to. The answer is decided synchronously (no `await` between the checks and the insert), against the table, the live workers and the drafts whose worker ended before it bound its file.

**Files:**
- Modify: `apps/daemon/src/modules/sessions/{scan-port.ts,service.ts,service-launch.ts,index.ts}`; create `scan-port.test.ts`
- Modify: `apps/daemon/src/modules/auth/{store.ts,index.ts}` (+ one case in a new `apps/daemon/src/modules/auth/owner.test.ts`), `apps/daemon/src/daemon.ts`

**Interfaces:**
- Consumes: Task 7 `MarksStore.{findByPiPath,findByPiSessionId,setPreview}`, `createProjectLink`; Task 8 `ShellPublisher`, `summary`; Task 10 `activity`; `isPiSessionFile`, `nameOf`, `cleanLabel`.
- Produces:
  - `type Claim = { kind: "session"; sessionId: string; ownerId: string } | { kind: "wait" } | { kind: "skip"; reason: "duplicate_id" | "not_pi_file" }`;
  - `SessionsScanPort` gains `claim(path: string, header: PiHeader): Claim`, `touched(sessionId: string, at: number, active: boolean): void`, `named(sessionId: string, raw: string | null): void`, `previewed(sessionId: string, text: string): void`;
  - `LaunchContext.onDraftExit?(piSessionId: string, sessionId: string): void`;
  - `AuthModule.ownerId(): string | null`; `AuthStore.firstUserId(): string | null`;
  - `SessionsModuleDeps.ownerId(): string | null`.

**Rulings (pre-dispatch):**
- M4R60: Claim order: (1) a session already bound to this path; (2) a session already bound to this Pi id at another path → `skip duplicate_id` (a copied file), logged at most once a minute; (3) not under `<agentDir>/sessions` by real path → `skip not_pi_file`; (4) a live worker that reported this Pi id → bind its row to the file; (5) a draft whose worker ended before binding (a bounded memory of 256 Pi ids) → bind that row; (6) no owner yet → `wait`; (7) else insert a new row (owner = the instance owner, cwd and times from the header, its project via `project-link`), publish its summary and its project — exactly one pap session per Pi file and per Pi session id (Review Focus 2) — cost if wrong: none.
- M4R61: The owner of an adopted session is the instance owner: the oldest user (`ORDER BY created_at, id LIMIT 1`). `ownerId()` is a small additive read in the auth module (M5's): pap's sessions on this machine belong to whoever owns this instance (decision 1: v1 has one owner) — cost if wrong: with several users (M5 `pap user add`), CLI sessions all go to the first; M5 may refine "owner" (merge note).
- M4R62: An adopted session's `createdAt` and first `updatedAt` are the header's time capped at now; `touched` moves `updatedAt` forward only, to the file's mtime capped at now; a clock in the future never sorts a session above today's — cost if wrong: none.
- M4R63: `named` applies `nameOf` and writes only on a change; `previewed` writes the first preview only (`cleanLabel(text, 120)`); both publish the summary when they wrote — cost if wrong: none.
- M4R64: `touched(…, active: true)` calls the organiser's `activity` (un-settle, wake, M4R41) before publishing — a CLI session someone works in comes back to the active list — cost if wrong: a snoozed session woken by a CLI append (Q2 note).

- [ ] **Step 1: Write the failing tests**

`scan-port.test.ts` (service bed; `agentDir` the bed's temp agent dir; files created under `<agentDir>/sessions/--w--/`):
- a new file is adopted once: `claim(path, header)` returns `{ kind: "session" }` with a new id; the row has `piPath === path`, `piSessionId === header.id`, `cwd === header.cwd`, `ownerId === "u1"`, a project; `session` and `project` events go out on `shell:u1`; a second `claim` returns the same id and inserts nothing;
- the file of pap's own live session (fake worker `ready` with `sessionId: "pi-7"`, `sessionFile: <path>`) binds that session (no new row); the service's own `bindPiFile` after it changes nothing;
- the file of a draft whose worker exited before binding (fake worker `ready` with `sessionId: "pi-8"`, then crash before any activity) binds the draft's row;
- a second file with a header id already bound elsewhere → `{ kind: "skip", reason: "duplicate_id" }`, one log line for two attempts within a minute;
- a file outside `<agentDir>/sessions` → `skip not_pi_file`;
- with `ownerId: () => null` → `wait`; once it answers `"u1"` → adopted;
- `touched(id, mtime, false)` moves `updatedAt` forward, never back, caps at now, publishes only when it moved; `touched(id, mtime, true)` on a settled session clears `settledAt`;
- `named(id, "  New‮ name ")` stores `"New name"` and publishes; the same name again publishes nothing; `previewed` writes once;
- `summary(id, "u2")` is null for u1's session.

`auth/owner.test.ts` (the auth module over a temp database, as the auth tests build it): `ownerId()` is null before setup and the owner's id after `insertFirstUser`.

(End to end, through the real scanner and a real worker, the adoption is pinned by Task 17's integration tests.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/scan-port.test.ts apps/daemon/src/modules/auth`
Expected: FAIL.

- [ ] **Step 3: Implement**

`auth/store.ts`: `firstUserId(): string | null` = `db.get<{ id: string }>("SELECT id FROM users ORDER BY created_at, id LIMIT 1")?.id ?? null` (interface and implementation). `auth/index.ts`: `AuthModule.ownerId(): string | null` with the doc "the instance owner: the oldest user (M4R61)", implemented as `() => store.firstUserId()`.

`service-launch.ts`: in the worker's `onExit`, when the row was stored but never bound and the session reported a Pi id, call `ctx.onDraftExit?.(session.piSessionId(), row.id)`.

`scan-port.ts`:

```ts
import { SHELL_LIMITS, type ShellSession } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { cleanLabel } from "../../kernel/text.ts";
import type { MarksStore } from "./marks-store.ts";
import { nameOf } from "./names.ts";
import { isPiSessionFile } from "./pi-files.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow, SessionsStore } from "./store.ts";

export interface PiFileHeader {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

export type Claim =
  | { readonly kind: "session"; readonly sessionId: string; readonly ownerId: string }
  | { readonly kind: "wait" }
  | { readonly kind: "skip"; readonly reason: "duplicate_id" | "not_pi_file" };

/** What the scanner (search module) may ask of sessions: nothing else of the sessions table is reachable. */
export interface SessionsScanPort {
  claim(path: string, header: PiFileHeader): Claim;
  touched(sessionId: string, at: number, active: boolean): void;
  named(sessionId: string, raw: string | null): void;
  previewed(sessionId: string, text: string): void;
  summary(sessionId: string, ownerId: string): ShellSession | null;
}

/** Drafts whose worker ended before it bound its file, by Pi id; the oldest is forgotten past this. */
export const MAX_REMEMBERED_DRAFTS = 256;

export function createScanPort(deps: {
  readonly store: SessionsStore;
  readonly marks: MarksStore;
  readonly agentDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  newId(): string;
  ownerId(): string | null;
  /** The row of a live session whose worker reported this Pi id. */
  livePiSession(piSessionId: string): SessionRow | null;
  assignProject(sessionId: string, ownerId: string, cwd: string): string | null;
  readonly publisher: ShellPublisher;
  activity(sessionId: string): void;
  summary(sessionId: string, ownerId: string): ShellSession | null;
}): SessionsScanPort & { rememberDraft(piSessionId: string, sessionId: string): void } {
  const drafts = new Map<string, string>();
  const limiter = createRateLimiter(deps.clock, 60_000);
  const say = (event: string, fields: Record<string, unknown>) => {
    const said = limiter.check(event);
    if (said.allowed) deps.logger.warn(event, { ...fields, suppressed: said.suppressed });
  };
  const bind = (row: { id: string; ownerId: string }, path: string, piId: string): Claim => {
    deps.store.bindPiFile(row.id, path, piId);
    return { kind: "session", sessionId: row.id, ownerId: row.ownerId };
  };
  return {
    rememberDraft(piSessionId, sessionId) {
      drafts.delete(piSessionId);
      drafts.set(piSessionId, sessionId);
      if (drafts.size > MAX_REMEMBERED_DRAFTS) drafts.delete(drafts.keys().next().value as string);
    },
    // Synchronous on purpose: no await between a check and the insert, so one file never becomes two sessions (M4R60).
    claim(path, header) {
      const byPath = deps.marks.findByPiPath(path);
      if (byPath) return { kind: "session", sessionId: byPath.id, ownerId: byPath.ownerId };
      if (deps.marks.findByPiSessionId(header.id)) {
        say("session_file_duplicate_id", {});
        return { kind: "skip", reason: "duplicate_id" };
      }
      if (!isPiSessionFile(deps.agentDir, path)) return { kind: "skip", reason: "not_pi_file" };
      const live = deps.livePiSession(header.id);
      if (live) return bind(live, path, header.id);
      const draftId = drafts.get(header.id);
      const draft = draftId === undefined ? undefined : deps.store.get(draftId);
      if (draft && draft.piPath === null) {
        drafts.delete(header.id);
        return bind(draft, path, header.id);
      }
      const ownerId = deps.ownerId();
      if (ownerId === null) return { kind: "wait" };
      const at = Math.min(header.createdAt, deps.clock.now());
      const row: SessionRow = {
        id: deps.newId(),
        piPath: path,
        piSessionId: header.id,
        cwd: header.cwd,
        ownerId,
        name: null,
        createdAt: at,
        updatedAt: at,
      };
      deps.store.insert(row, null);
      const projectId = deps.assignProject(row.id, ownerId, row.cwd);
      deps.publisher.changed(row.id);
      deps.publisher.projectChanged(ownerId, projectId);
      deps.logger.info("session_adopted", { sessionId: row.id });
      return { kind: "session", sessionId: row.id, ownerId };
    },
    touched(sessionId, at, active) {
      const row = deps.store.get(sessionId);
      if (!row) return;
      const when = Math.min(Math.trunc(at), deps.clock.now());
      const moved = when > row.updatedAt;
      if (moved) deps.store.touch(sessionId, when);
      if (active) deps.activity(sessionId);
      if (moved) deps.publisher.changed(sessionId);
    },
    named(sessionId, raw) {
      const row = deps.store.get(sessionId);
      const name = nameOf(raw);
      if (!row || row.name === name) return;
      deps.store.setName(sessionId, name);
      deps.publisher.changed(sessionId);
    },
    previewed(sessionId, text) {
      const preview = cleanLabel(text, SHELL_LIMITS.preview);
      if (preview !== null && deps.marks.setPreview(sessionId, preview)) deps.publisher.changed(sessionId);
    },
    summary: deps.summary,
  };
}
```

(`organiser.activity` already publishes when it changed something; `touched` publishes once more only when `updatedAt` moved — the publisher coalesces both into one event.)

Service wiring: `livePiSession: (piId) => { for (const [id, session] of live) if (session.piSessionId() === piId) return deps.store.get(id) ?? null; return null; }`; `createLaunch({ …, onDraftExit: port.rememberDraft })`; the module exposes `scanPort` (the port without `rememberDraft`). `SessionsModuleDeps` gains `ownerId(): string | null`; `daemon.ts` passes `ownerId: () => auth.ownerId()`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS. Mutation checks: drop step (4) (the live worker) → the "pap's own session" case inserts a second row and fails; drop step (2) → the duplicate case adopts and fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/sessions apps/daemon/src/modules/auth apps/daemon/src/daemon.ts
git commit -m "feat(sessions): adopt Pi files as sessions through a scan port — one pap session per Pi file and Pi id"
```

---

### Task 15: The scanner, one file at a time — cursor, cutoff, rewrite, caps

**Files:**
- Create: `apps/daemon/src/modules/search/{scanner-file.ts,scanner-file.test.ts}`, `apps/daemon/src/modules/search/testing/fake-scan-port.ts`

**Interfaces:**
- Consumes: Task 11 `SearchIndexStore`, `FileCursor`; Task 13 `openRegular`, `readHeaderLine`, `readLines`, `parseHeader`, `extract`, `HEAD_CHARS`; Task 14 `SessionsScanPort`, `Claim`.
- Produces: `STEP_BYTES = 4 * 1024 * 1024`, `MAX_INDEXED_CHARS = 4_000_000`; `type FileOutcome = { kind: "gone" } | { kind: "skipped"; reason: string } | { kind: "waiting" } | { kind: "indexed"; sessionId: string; rows: number; more: boolean }`; `interface FileContext { installedAt; store; sessions: Pick<SessionsScanPort, "claim" | "touched" | "named" | "previewed">; logger; say(event: string, fields?: object): void; limits?: { stepBytes?: number; maxIndexedChars?: number } }`; `processFile(path: string, ctx: FileContext): FileOutcome`.

**Rulings (pre-dispatch):**
- M4R65 (spec D rule 3): the cutoff is the header's time against `meta.installed_at` (`ensureInstallTimestamp`, M1): a session created before the install is `excluded` — its cursor remembers the inode, size and mtime, so an unchanged file is not read again — and never claimed; a Pi session created after it is adopted whether pap, the `pi` CLI or another Pi client made it (Q7) — cost if wrong: none.
- M4R66: A file whose inode changed, that shrank below the cursor, or whose header's first 512 characters changed was replaced or rewritten: its rows are forgotten and it is read again from the start — Pi only appends; anything else is a different file — cost if wrong: a re-index of a file rewritten by a tool.
- M4R67: One call reads at most 4 MiB of lines, then answers `more: true` and the engine puts the file back at the end of the queue — a 500 MB session cannot hold the loop for long, other files get their turn — cost if wrong: none.
- M4R68: At most 4 000 000 characters of text are indexed per file; past that, rows stop (`capped` said once) but the cursor, names, previews and activity go on — bounded index per session — cost if wrong: words after the first ~4 MB of a huge session's text not found.
- M4R69: Every refusal is said, rate-limited, with a stable code and never the path's content: `session_file_unreadable {code}`, `session_file_bad_header`, `session_file_lines_skipped {bad, skipped}`, `session_file_capped` — untrusted files must not flood the log — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`scanner-file.test.ts` (temp agent dir with `sessions/--w--/`, a real `search.db` from `openSearchIndex`, `fakeScanPort()` recording `claim` / `touched` / `named` / `previewed` calls and answering `claim` with `{ kind: "session", sessionId: "s1", ownerId: "u1" }` unless told otherwise; `installedAt = Date.parse("2026-10-12T00:00:00Z")`; lines written as JSONL with a small builder `piFile(header, ...entries)`):

1. "indexes a new file after the install": user and assistant rows in the index, the cursor at the end of the file in state `indexed`, `claim` called once with the parsed header, `touched("s1", mtime, true)`, `previewed("s1", <first user text>)`, `named` called with the `session_info` name.
2. "reads only what was appended": append one user entry; the second call indexes one row; `claim` is not called again.
3. "never indexes a torn last line": the file ends with half a line; the cursor stops before it and the row count excludes it; once the line is completed, it is indexed exactly once.
4. "a session created before the install is excluded, never claimed, and not read again while unchanged": state `excluded`; a second call returns `{ kind: "skipped", reason: "excluded" }` and `claim` was never called.
5. "a rewrite in place re-reads the file from the start": write a file, index it, rewrite it (same path, new header id and content, same size or larger); the old rows are gone (`rowCount` equals the new file's rows) and `claim` was called again.
6. "a truncation re-reads it": truncate below the cursor and write fewer entries; same expectations.
7. "a FIFO is refused without blocking": `mkfifo` at a `.jsonl` path → `{ kind: "skipped", reason: "not_file" }`, nothing stored. (When `CI` is set, a missing `mkfifo` fails the test; locally it skips with a printed reason — R92's rule.)
8. "a symlink is never followed": a link to a valid session file → `{ kind: "skipped", reason: "ELOOP" }`.
9. "a bad header is said once": three different bad files → each `skipped bad_header`, one `session_file_bad_header` line within the minute.
10. "a header still being written is left for later": no newline yet → `skipped no_header_yet`, no cursor stored.
11. "waits for an owner": the port answers `wait` → `{ kind: "waiting" }`, cursor state `waiting`; then `session` → indexed.
12. "a duplicate id is skipped and not read again while unchanged": the port answers `skip duplicate_id` → state `bad`.
13. "caps the indexed text but keeps names and activity": `limits.maxIndexedChars: 20` and two 15-character messages → one row; a later `session_info` still calls `named`.
14. "goes on in steps": `limits.stepBytes: 300` on a 2 KB file → `more: true`; repeated calls end with `more: false` and every row indexed once.
15. "a deleted file is forgotten": index, delete, call → `{ kind: "gone" }`, no cursor, no rows.
16. "the snippet markers never reach the index": a user text holding `\u0002` and `\u0003` is stored with spaces in their place.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/search/scanner-file.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`scanner-file.ts`:

```ts
import { closeSync } from "node:fs";
import type { Logger } from "../../kernel/logger.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { extract } from "./extract.ts";
import type { FileCursor, IndexRow, SearchIndexStore } from "./index-store.ts";
import { HEAD_CHARS, openRegular, parseHeader, readHeaderLine, readLines } from "./session-file.ts";

export const STEP_BYTES = 4 * 1024 * 1024;
export const MAX_INDEXED_CHARS = 4_000_000;

export type FileOutcome =
  | { readonly kind: "gone" }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "indexed"; readonly sessionId: string; readonly rows: number; readonly more: boolean };

export interface FileContext {
  readonly installedAt: number;
  readonly store: SearchIndexStore;
  readonly sessions: Pick<SessionsScanPort, "claim" | "touched" | "named" | "previewed">;
  readonly logger: Logger;
  /** One rate-limited warning per event name (M4R69). */
  say(event: string, fields?: Record<string, unknown>): void;
  readonly limits?: { readonly stepBytes?: number; readonly maxIndexedChars?: number };
}

/** Rows that fit the per-file text budget, in order; the rest are dropped (M4R68). */
function withinBudget(rows: readonly IndexRow[], room: number): { kept: IndexRow[]; chars: number; capped: boolean } {
  const kept: IndexRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (chars + row.text.length > room) return { kept, chars, capped: true };
    chars += row.text.length;
    kept.push(row);
  }
  return { kept, chars, capped: false };
}

/** One step of one Pi file (M4R65–M4R69). Synchronous: the engine yields between calls. */
export function processFile(path: string, ctx: FileContext): FileOutcome {
  const opened = openRegular(path);
  if ("refused" in opened) {
    ctx.store.forget(path);
    if (opened.refused === "ENOENT") return { kind: "gone" };
    if (opened.refused !== "ELOOP" && opened.refused !== "not_file")
      ctx.say("session_file_unreadable", { code: opened.refused });
    return { kind: "skipped", reason: opened.refused };
  }
  const { fd } = opened;
  try {
    const stat = { ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs };
    let cursor = ctx.store.cursor(path);
    const unchanged = cursor && cursor.ino === stat.ino && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs;
    if (unchanged && (cursor?.state === "excluded" || cursor?.state === "bad"))
      return { kind: "skipped", reason: cursor.state === "excluded" ? "excluded" : "bad_header" };
    const header = readHeaderLine(fd, stat.size);
    if (!header) return { kind: "skipped", reason: "no_header_yet" };
    const head = header.line.slice(0, HEAD_CHARS);
    if (cursor && (cursor.ino !== stat.ino || stat.size < cursor.offset || cursor.head !== head)) {
      ctx.store.forget(path);
      cursor = undefined;
    }
    const base = { path, ...stat, head };
    const mark = (state: FileCursor["state"], offset: number): void =>
      ctx.store.commit({ ...base, offset, state, sessionId: null, ownerId: null, indexedChars: 0 }, []);
    const parsed = parseHeader(header.line);
    if (!parsed) {
      mark("bad", stat.size);
      ctx.say("session_file_bad_header");
      return { kind: "skipped", reason: "bad_header" };
    }
    if (parsed.createdAt < ctx.installedAt) {
      mark("excluded", stat.size);
      return { kind: "skipped", reason: "excluded" };
    }
    let sessionId = cursor?.state === "indexed" ? cursor.sessionId : null;
    let ownerId = cursor?.state === "indexed" ? cursor.ownerId : null;
    if (sessionId === null || ownerId === null) {
      const claim = ctx.sessions.claim(path, parsed);
      if (claim.kind === "wait") {
        mark("waiting", header.end + 1);
        return { kind: "waiting" };
      }
      if (claim.kind === "skip") {
        mark("bad", stat.size);
        return { kind: "skipped", reason: claim.reason };
      }
      sessionId = claim.sessionId;
      ownerId = claim.ownerId;
    }
    const from = cursor?.state === "indexed" ? cursor.offset : header.end + 1;
    const read = readLines(fd, from, stat.size, ctx.limits?.stepBytes ?? STEP_BYTES);
    const found = extract(read.records);
    const before = cursor?.state === "indexed" ? cursor.indexedChars : 0;
    const room = Math.max(0, (ctx.limits?.maxIndexedChars ?? MAX_INDEXED_CHARS) - before);
    const { kept, chars, capped } = withinBudget(found.rows, room);
    ctx.store.commit({ ...base, offset: read.next, state: "indexed", sessionId, ownerId, indexedChars: before + chars }, kept);
    if (capped) ctx.say("session_file_capped");
    if (read.bad > 0 || read.skipped > 0) ctx.say("session_file_lines_skipped", { bad: read.bad, skipped: read.skipped });
    if (found.name !== undefined) ctx.sessions.named(sessionId, found.name);
    if (found.firstUser !== null) ctx.sessions.previewed(sessionId, found.firstUser);
    if (read.next > from) ctx.sessions.touched(sessionId, stat.mtimeMs, found.active);
    return { kind: "indexed", sessionId, rows: kept.length, more: read.next > from && read.next < stat.size };
  } finally {
    closeSync(fd);
  }
}
```

`testing/fake-scan-port.ts`: records calls; `claim` answers from a queue of `Claim`s or the default `{ kind: "session", sessionId: "s1", ownerId: "u1" }`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon/src/modules/search && pnpm lint && pnpm typecheck`
Expected: PASS. Mutation checks: drop the `head` comparison → case 5 fails; read from 0 instead of `cursor.offset` → case 2 indexes the first rows twice.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/search
git commit -m "feat(search): process one Pi file — install cutoff, byte-offset cursor, rewrite detection and caps"
```

---

### Task 16: The scanner engine — watchers, debounce, reconcile, queue, lifecycle

**Files:**
- Create: `apps/daemon/src/modules/search/{watch.ts,scanner.ts,scanner.test.ts}`, `apps/daemon/src/modules/search/testing/fake-watch.ts`
- Modify: `apps/daemon/src/modules/search/index.ts` (the scanner joins: `start()`; `stop()` stops it first), `apps/daemon/src/daemon.ts` (`installedAt`, `agentDir`, `search.start()` once the server listens)

**Interfaces:**
- Consumes: Task 15 `processFile`, `FileContext`, `FileOutcome`; Task 11 `createSearchIndexStore`; `kernel/rate-limit.ts`.
- Produces:
  - `type WatchFactory = (dir: string, onEvent: (name: string | null) => void, onError: (code: string) => void) => (() => void) | null`; `fsWatch: WatchFactory` (`watch.ts`).
  - `DEBOUNCE_MS = 250`, `RECONCILE_MS = 60_000`, `MAX_WATCHED_DIRS = 512`, `MAX_QUEUE = 20_000`, `MAX_LISTED_FILES = 50_000`, `LIST_YIELD_EVERY = 500`; `createScanner(deps: { root; installedAt; store; sessions; watch; clock; logger; yieldNow?; process? }): Scanner` with `start()`, `stop(): Promise<void>`, `idle(): Promise<void>`, `reconcile(): Promise<void>`.
  - `SearchModule.start()`; `createSearchModule` gains `agentDir`, `installedAt`, `watch?`.

**Rulings (pre-dispatch):**
- M4R70: `fs.watch` (non-recursive) on `<agentDir>/sessions`, on each of its folders (at most 512), and on `<agentDir>` while `sessions/` does not exist yet; every watcher is `persistent: false`; an error closes it and the next reconcile adds it back (said once a minute) — Node's recursive watch on Linux is a userland walk; Pi's layout is two levels — cost if wrong: folders past 512 seen by the reconcile only (60 s).
- M4R71: A file event is debounced 250 ms per path (kernel `Clock`), then queued; a folder event lists the folder; an event without a name schedules a reconcile within a second — Pi writes a few lines per turn — cost if wrong: none (the exit budget is 3 s, Q6).
- M4R72: A reconcile every 60 s lists the root and its folders with `withFileTypes` (links never followed, `.jsonl` regular files only), at most 50 000 files, yielding every 500, and queues a file whose cursor is missing, `waiting`, or whose inode, size or mtime moved; a cursor whose file is no longer listed is queued (it ends `gone`) — catches every missed event; bounded work — cost if wrong: a missed change seen within a minute.
- M4R73: One queue (a `Set`, insertion order, at most 20 000 paths; past that the newcomers are dropped and a reconcile is scheduled, said once), one pump at a time, a yield (`setImmediate`, not a timer) between files; a file answering `more` goes back to the end; a `processFile` that throws is logged with its code and the pump goes on — no file or failure can starve the others or stop the scanner — cost if wrong: none.
- M4R74: `start()` runs after the HTTP server listens; `stop()` closes the watchers, clears every timer and waits for the running step, before the search database closes — boot is not delayed by a first scan, and nothing outlives `stop` — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`testing/fake-watch.ts`: a `WatchFactory` that records watched folders, lets the test `emit(dir, name)` and `fail(dir, code)`, refuses folders listed in `refuse`, and reports which are closed.

`scanner.test.ts` (temp agent dir; `createFakeClock`; a `process` spy that returns `{ kind: "indexed", sessionId: "s", rows: 1, more: false }` unless told otherwise; `yieldNow: () => Promise.resolve()`; the real store over a temp `search.db`):
1. "start lists what exists and processes each file once": two folders with three `.jsonl` files and one `.txt`; after `start()` and `await scanner.idle()`, `process` saw exactly the three paths; both folders and the root are watched.
2. "debounces a burst of events per file": five `emit(folder, "a.jsonl")` within 100 ms → nothing yet; `await clock.advance(250)` and `idle()` → `process` saw `a.jsonl` once.
3. "a new folder is watched and listed": `emit(root, "--new--")` after creating it with a file → the folder is watched and its file processed.
4. "the reconcile finds what an event missed": change a file's size without an event; `await clock.advance(60_000)` → processed; an unchanged file with an `indexed` cursor (commit one through the store) is not.
5. "without `sessions/` it watches the agent folder, then the root once it appears": start with no `sessions/`; the agent folder is watched; create `sessions/` and `emit(agentDir, "sessions")` → the root is watched and listed.
6. "a watcher error closes it and the next reconcile adds it back, said once": `fail(folder, "ENOSPC")` twice → closed, one log line; after `advance(60_000)` the folder is watched again.
7. "past 512 folders it still finds files by reconciling": 513 folders → 512 watched, one `session_watch_limit` line, the 513th folder's file processed by the start reconcile.
8. "a full queue drops newcomers and schedules a reconcile": `MAX_QUEUE` overridden through a test-only option to 2 → the third path is dropped, one `session_queue_full` line, a reconcile within a second.
9. "a file answering `more` goes back to the end of the queue": `process` answers `more: true` once for `a`, then `false`; with `a` and `b` queued, the order seen is `a, b, a`.
10. "a throwing step is logged and the pump goes on": `process` throws for `a` → `b` still processed; one `session_scan_failed` line with `code`.
11. "a cursor whose file is gone is queued and forgotten": a cursor in the store for a path not on disk → after the reconcile, `process` saw it (and, with the real `processFile`, the cursor is gone).
12. "a symlinked folder is not followed": a link inside `sessions/` to another folder → not watched, its files not processed.
13. "stop closes every watcher, clears every timer and waits for the running step": `process` returns a promise-free value but the test makes `yieldNow` hang until released; `stop()` resolves only after release; afterwards `clock.pending()` is 0 and every fake watcher is closed.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/search/scanner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`watch.ts`:

```ts
import { watch } from "node:fs";

/** A folder watcher: null when it could not be set up (the caller relies on the reconcile then). */
export type WatchFactory = (
  dir: string,
  onEvent: (name: string | null) => void,
  onError: (code: string) => void,
) => (() => void) | null;

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? "unknown";

/** `fs.watch` without keeping the process alive (M4R70). */
export const fsWatch: WatchFactory = (dir, onEvent, onError) => {
  try {
    const watcher = watch(dir, { persistent: false }, (_type, name) => onEvent(typeof name === "string" ? name : null));
    watcher.on("error", (error) => {
      watcher.close();
      onError(codeOf(error));
    });
    return () => watcher.close();
  } catch (error) {
    onError(codeOf(error));
    return null;
  }
};
```

`scanner.ts` — the engine; the essential parts:

```ts
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import type { SearchIndexStore } from "./index-store.ts";
import { type FileOutcome, processFile } from "./scanner-file.ts";
import type { WatchFactory } from "./watch.ts";

export const DEBOUNCE_MS = 250;
export const RECONCILE_MS = 60_000;
export const MAX_WATCHED_DIRS = 512;
export const MAX_QUEUE = 20_000;
export const MAX_LISTED_FILES = 50_000;
export const LIST_YIELD_EVERY = 500;

export interface Scanner {
  start(): void;
  stop(): Promise<void>;
  /** Resolves when the queue is empty and no step runs (tests, and `stop`). */
  idle(): Promise<void>;
  reconcile(): Promise<void>;
}

const isSessionFile = (name: string): boolean => name.endsWith(".jsonl");
```

`createScanner(deps)` keeps: `watchers: Map<string, () => void>` (root, folders, and the agent folder while `sessions/` is missing), `debounces: Map<string, TimerHandle>`, `queue: Set<string>`, `pumping: Promise<void> | null`, `reconcileTimer`, `soonTimer`, `stopped`, a rate limiter for its log lines (60 s), and:

- `watchDir(dir, onEvent)`: no-op when watched; refuses past `MAX_WATCHED_DIRS` (`session_watch_limit`, once a minute); calls `deps.watch(dir, onEvent, (code) => { watchers.delete(dir); say("session_watch_failed", { code }); })` and stores the closer when not null.
- `watchRoot()`: when `<root>` exists, `watchDir(root, onRootEvent)` and close the agent-folder watcher; else `watchDir(dirname(root), (name) => { if (name === basename(root) || name === null) { watchRoot(); void reconcile(); } })`.
- `onRootEvent(name)`: `null` → `reconcileSoon()`; else, for a folder (`lstat` says directory and not a link), `watchDir(join(root, name), (file) => onFolderEvent(join(root, name), file))` and `void listFolder(join(root, name))`.
- `onFolderEvent(dir, name)`: `null` → `void listFolder(dir)`; a `.jsonl` name → `debounce(join(dir, name))`.
- `debounce(path)`: replace the path's timer with `clock.setTimeout(() => { debounces.delete(path); enqueue(path); }, DEBOUNCE_MS)`; past `MAX_QUEUE` timers, `reconcileSoon()` instead.
- `enqueue(path)`: `queue.delete(path); queue.add(path)` unless the queue is full (`session_queue_full`, `reconcileSoon()`); then `pump()`.
- `pump()`: one at a time:

```ts
  const pump = (): void => {
    if (pumping || stopped) return;
    pumping = (async () => {
      while (!stopped && queue.size > 0) {
        const path = queue.values().next().value as string;
        queue.delete(path);
        let outcome: FileOutcome | null = null;
        try {
          outcome = (deps.process ?? processFile)(path, ctx);
        } catch (error) {
          say("session_scan_failed", { code: (error as { code?: string }).code ?? "unknown" });
        }
        if (outcome?.kind === "indexed" && outcome.more) queue.add(path);
        await yieldNow();
      }
    })()
      .catch((error: unknown) => deps.logger.error("session_scan_pump_failed", { err: error }))
      .finally(() => {
        pumping = null;
        for (const resolve of waiters.splice(0)) resolve();
      });
  };
```

- `reconcile()`: lists the root (`readdir(root, { withFileTypes: true })`; `ENOENT` → `watchRoot()` and return; another code → `say("session_list_failed", { code })`), keeps folders that are directories (not links), watches each, lists each for `.jsonl` regular files (`withFileTypes`), counting up to `MAX_LISTED_FILES` (`session_list_limit` once) and yielding every `LIST_YIELD_EVERY` entries; for each file, compares `lstat` with the store's cursor and queues it when the cursor is missing, `waiting`, or its inode, size or mtime moved; then queues every `store.paths()` entry that was not listed; then `pump()`.
- `reconcileSoon()`: at most one pending (`soonTimer`, 1 000 ms).
- `start()`: `stopped = false; watchRoot(); void reconcile(); reconcileTimer = every RECONCILE_MS` (re-armed after each run).
- `stop()`: `stopped = true`; clear `reconcileTimer`, `soonTimer` and every debounce; close every watcher; `await pumping`.
- `idle()`: resolves at once when nothing pumps and the queue is empty, else when the pump ends.

`ctx` for `processFile`: `{ installedAt, store, sessions, logger, say }` where `say` uses the scanner's limiter.

(`yieldNow` defaults to `() => new Promise<void>((resolve) => setImmediate(resolve))`: a yield, not a sleep. The file stays under 400 lines; if it does not, `scanner-list.ts` takes `reconcile`'s listing.)

`index.ts` (search): `createSearchModule` gains `agentDir`, `installedAt`, `watch?` and `yieldNow?`; builds `createScanner({ root: join(agentDir, "sessions"), installedAt, store: createSearchIndexStore(db), sessions: deps.sessions, watch: deps.watch ?? fsWatch, clock, logger })`; `start: () => scanner.start()`; `stop` awaits `scanner.stop()` before `client.stop()` and `db.close()`.

`daemon.ts`: `const installedAt = ensureInstallTimestamp(db, clock);` (the call exists; keep its value); `createSearchModule({ home: config.home, agentDir: config.piAgentDir, installedAt, clock, logger, sessions: sessions.scanPort })`; `search.start()` right before `logger.info("listening", …)`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/daemon && pnpm test:int apps/daemon && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm smoke`
Expected: PASS; the existing int tests (their workers write Pi files under temporary agent folders) stay green with the scanner running beside them. Mutation checks: remove the debounce (enqueue at once) → case 2 processes five times; drop the `store.paths()` pass → case 11 fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/search apps/daemon/src/daemon.ts
git commit -m "feat(search): the session scanner — fs watch per folder, debounce, a 60 s reconcile and a fair queue"
```

---

### Task 17: The exit criteria, headless — a CLI session within seconds, search over 10 000 sessions within budget

**Files:**
- Create: `apps/daemon/src/modules/search/scanner.exit.int.test.ts`, `apps/daemon/src/modules/search/search.budget.int.test.ts`, `apps/daemon/src/modules/search/testing/corpus.ts`
- Modify: `budgets.json`, `scripts/check-budgets.ts`, `scripts/check-budgets.test.ts`

**Interfaces:**
- Consumes: Tasks 8–16; the harness `startTestDaemon`; the SDK's `SessionManager`, `getDefaultSessionDir`.
- Produces: `budgets.json` keys `searchP95Ms` and `scannerLatencyMs`; `buildCorpus(store, db, { sessions, rowsPerSession, seed }): { queries: string[] }` (`testing/corpus.ts`).

**Rulings (pre-dispatch):**
- M4R75 (owner Q6 default): `scannerLatencyMs = 3000`: from the moment Pi's own `SessionManager` writes a new session file under the agent folder to the moment the `shell` stream delivers its `session` event, over a real `fs.watch` and the real daemon — "appears within seconds" — cost if wrong: a slower host fails the test (the controller asks the owner, Global Constraints).
- M4R76 (owner Q6 default): `searchP95Ms = 200`: the p95 of 50 `search.query`-shaped round trips through the real worker thread over 10 000 sessions × 20 indexed messages (200 000 rows, a seeded vocabulary of 5 000 words, about 40 words a row), after 5 warm-up queries; the 50 queries are 20 two-word queries of mid-frequency words, 10 rare words, 10 three-letter prefixes and 10 pairs of a very common word and a rare one — a budget measured, not guessed; the printed p95 goes in the commit body and `docs/agents/search.md` — cost if wrong: same as above.
- M4R77: The corpus is written in one transaction (one fsync), in a temp dir, by the real store; generation is deterministic (mulberry32, seed 42) — the test stays reproducible and under about 30 s — cost if wrong: none.

- [ ] **Step 1: Write the tests**

`scanner.exit.int.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultSessionDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../budgets.json", import.meta.url)), "utf8"),
) as { scannerLatencyMs: number };

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [] });
});
afterEach(async () => {
  await t.stop();
});

/** A session written exactly as the `pi` CLI writes it: Pi's own session manager, in the daemon's agent folder. */
function writeCliSession(text: string): string {
  const agentDir = join(t.root, "agent");
  const manager = SessionManager.create(t.cwd, getDefaultSessionDir(t.cwd, agentDir));
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  return manager.getSessionId();
}

it("a session the pi CLI creates after the install is on the shell stream within its budget, and searchable", async () => {
  const client = await t.connect(await t.login());
  expect(await client.call("subscribe.shell", {})).toMatchObject({ ok: true });
  const started = performance.now();
  writeCliSession("hello from the pi cli about kubernetes");
  const event = await client.waitForEvent(
    (frame) => (frame.event as { kind?: string; session?: { cwd?: string } }).kind === "session" &&
      (frame.event as { session: { cwd: string } }).session.cwd === t.cwd,
    budgets.scannerLatencyMs,
  );
  const elapsed = Math.round(performance.now() - started);
  console.log(`scanner: a CLI session reached the shell stream after ${elapsed} ms (budget ${budgets.scannerLatencyMs})`);
  expect(elapsed).toBeLessThanOrEqual(budgets.scannerLatencyMs);
  const sessionId = (event.event as { session: { id: string } }).session.id;
  const answer = await client.call("search.query", { q: "kubernetes pi cli" });
  expect(answer).toMatchObject({ ok: true });
  expect((answer as { result: { hits: Array<{ sessionId: string }> } }).result.hits.map((hit) => hit.sessionId)).toEqual([sessionId]);
});

/** Pi's file format with a header dated `timestamp` (the SDK always stamps "now", so this one is written by hand). */
function writeOldSession(timestamp: string, text: string): void {
  const folder = getDefaultSessionDir(t.cwd, join(t.root, "agent"));
  mkdirSync(folder, { recursive: true });
  const header = { type: "session", version: 3, id: randomUUID(), timestamp, cwd: t.cwd };
  const entry = { type: "message", id: "a1b2c3d4", parentId: null, timestamp, message: { role: "user", content: text, timestamp: Date.parse(timestamp) } };
  writeFileSync(join(folder, `old_${header.id}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
}

it("never shows a session created before the install", async () => {
  const client = await t.connect(await t.login());
  await client.call("subscribe.shell", {});
  // Written first, so the scanner meets it before the new one whose event the test waits for.
  writeOldSession("2020-01-01T00:00:00.000Z", "an old session about kubernetes");
  writeCliSession("a new one");
  await client.waitForEvent((frame) => (frame.event as { kind?: string }).kind === "session", budgets.scannerLatencyMs);
  const sessions = client.events.filter((frame) => (frame.event as { kind?: string }).kind === "session");
  expect(new Set(sessions.map((frame) => (frame.event as { session: { id: string } }).session.id)).size).toBe(1);
  const answer = await client.call("search.query", { q: "old session" });
  expect((answer as { result: { hits: unknown[] } }).result.hits).toEqual([]);
});
```

(Imports for these helpers: `mkdirSync`, `writeFileSync` from `node:fs`, `randomUUID` from `node:crypto`.)

`search.budget.int.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore } from "./index-store.ts";
import { matchExpression } from "./match.ts";
import { createSearchClient, type SearchClient } from "./search-client.ts";
import { buildCorpus } from "./testing/corpus.ts";

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../budgets.json", import.meta.url)), "utf8"),
) as { searchP95Ms: number };

let dir = "";
let client: SearchClient;
let queries: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-search-budget-"));
  const db = openSearchIndex(join(dir, "search.db"), silentLogger);
  queries = buildCorpus(createSearchIndexStore(db), db, { sessions: 10_000, rowsPerSession: 20, seed: 42 }).queries;
  db.close();
  client = createSearchClient({ dbPath: join(dir, "search.db"), clock: createSystemClock(), logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await client.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("answers a search over 10 000 sessions within its p95 budget", async () => {
  const run = (q: string) => client.query({ match: matchExpression(q) ?? '""', ownerId: "u1", limit: 20 });
  for (const q of queries.slice(0, 5)) await run(q);
  const times: number[] = [];
  for (const q of queries) {
    const started = performance.now();
    const rows = await run(q);
    times.push(performance.now() - started);
    expect(rows.length).toBeLessThanOrEqual(20);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  console.log(`search: p95 ${p95.toFixed(1)} ms over ${queries.length} queries, 10000 sessions x 20 rows (budget ${budgets.searchP95Ms})`);
  expect(queries).toHaveLength(50);
  expect(p95).toBeLessThanOrEqual(budgets.searchP95Ms);
});
```

`testing/corpus.ts`: `mulberry32(seed)`; a vocabulary of 5 000 pronounceable words (consonant-vowel syllables from the PRNG), drawn with a Zipf-like weight (rank r with weight 1/r) so that a few words are very common; each row about 40 words; every session in `/p/<n % 200>`; `store.commit` per session inside one `db.transaction`; returns the 50 queries of M4R76 built from the vocabulary's ranks (mid ranks 200–1 000, rare ranks 4 000–5 000, prefixes of mid words, rank-1 word + a rare word).

`budgets.json` gains `"searchP95Ms": 200, "scannerLatencyMs": 3000`. `scripts/check-budgets.ts` prints, beside the two M2 lines, `search p95: measured by apps/daemon/src/modules/search/search.budget.int.test.ts (pnpm test:int)` and `scanner latency: measured by apps/daemon/src/modules/search/scanner.exit.int.test.ts (pnpm test:int)`; its test expects them.

- [ ] **Step 2: Run them**

Run: `pnpm test:int apps/daemon/src/modules/search && pnpm test:unit scripts/check-budgets.test.ts && pnpm budgets`
Expected: PASS, with the two printed measurements. If a measurement is above its budget: stop, report the numbers (and, for search, the slowest queries), and the controller asks the owner — never raise the budget in this task.

- [ ] **Step 3: Commit**

```bash
pnpm format
git add apps/daemon/src/modules/search budgets.json scripts/check-budgets.ts scripts/check-budgets.test.ts
git commit -m "test(search): CLI sessions reach the shell stream within 3 s and search over 10 000 sessions stays within budget"
```

(Commit body: the two measured numbers.)

---

# Phase 4 — The browser: one store, the project tree, actions, search

Bundle accounting for this phase (initial JavaScript and CSS, gzip, estimated; each task measures and records the real number): Task 5's contract schemas reach the initial chunk through the methods catalogue the RPC client imports (≈ +1.1 KB with the methods of Tasks 6–12); Task 18 ≈ +0.1; Task 19 ≈ +0.8; Task 20 ≈ −0.1; Task 21 ≈ +0.2; Task 22 ≈ −1.4 (the tree and its strings leave the initial chunk, `MobileShell` loads them lazily); Task 23 0 (lazy); Task 24 ≈ +1.0; Task 25 0 (lazy); Task 26 ≈ +0.2; Task 27 ≈ −3.0 (the lever). From 194.7: about 196.6 before Task 27, about 193.6 after it.

### Task 18: Web runtime — streams keyed by stream and key, one opener per stream, and `resync` (R125)

**Files:**
- Modify: `apps/web/src/runtime/subscriptions.ts`, `apps/web/src/runtime/subscriptions.test.ts`, `apps/web/src/testing/runtime-bed.ts`

**Interfaces:**
- Consumes: contracts `StreamName` (`"session" | "shell"`), methods `subscribe.session`, `subscribe.shell`.
- Produces: `Subscriptions.subscribe(stream, key, onEvent, onError?)` (unchanged signature; now keyed by `${stream}:${key}`), `Subscriptions.resync(stream: StreamName, key: string): void`; `fakeRuntime()` answers every `subscribe.*` with `{ sub: "s<n>" }` and gains `emitTo(method: "subscribe.session" | "subscribe.shell", event: unknown, nth?: number)`; `emit(event)` delivers to the first `subscribe.session` sub (as before when it was "s1").

**Rulings (pre-dispatch):**
- M4R78: The client keys a subscription by `${stream}:${key}` and opens it with the stream's own method (`session` → `subscribe.session { sessionId, after? }`, `shell` → `subscribe.shell { after? }`, whose key is a local name, `"me"`) — R125, the first second stream — cost if wrong: none.
- M4R79: `resync(stream, key)` drops the cursor, releases the current sub and asks again, so the server sends a fresh snapshot; it does nothing for a key without listeners or while the socket is not open; an answer to the dropped request is released by the generation rule (R11) — Task 26's hidden-dialog fix needs it — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

Add to `subscriptions.test.ts` (its existing fake connection and rpc helpers):
- "a session and the shell with the same key are two subscriptions": `subscribe("session", "me", a)` and `subscribe("shell", "me", b)` call `subscribe.session { sessionId: "me" }` and `subscribe.shell {}`; an event frame for each sub reaches only its listener;
- "the shell stream resumes from its cursor": after an event `{ epoch: "e", seq: 4 }` and a reconnect, the second `subscribe.shell` call carries `{ after: { epoch: "e", seq: 4 } }`;
- "resync asks again without a cursor and frees the old sub": after events up to seq 4, `resync("session", "x")` calls `unsubscribe { sub }` and `subscribe.session { sessionId: "x" }` without `after`; an answer to a request made before the resync is released;
- "resync does nothing without listeners or offline": no call.

Add to the bed's own test (or `runtime-bed` users): `emitTo("subscribe.shell", event)` reaches the shell listener when the shell subscribed first and a session second.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/runtime`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `subscriptions.ts`:

```ts
/** How each stream is asked for (M4R78). The `shell` stream is the caller's own: its key is a local name. */
const OPENERS: {
  readonly [S in StreamName]: (rpc: RpcClient, key: string, after: Cursor | null) => Promise<{ sub: string }>;
} = {
  session: (rpc, key, after) => rpc.call("subscribe.session", { sessionId: key, ...(after ? { after } : {}) }),
  shell: (rpc, _key, after) => rpc.call("subscribe.shell", after ? { after } : {}),
};
```

`Entry` gains `readonly stream: StreamName`; `entries` is keyed by `` `${stream}:${key}` ``; `open(entry)` calls `OPENERS[entry.stream](rpc, entry.key, entry.cursor)` instead of `subscribe.session`; `subscribe` uses the stream it is given; the expiry timer deletes the composite key. Add:

```ts
    resync(stream, key) {
      const entry = entries.get(`${stream}:${key}`);
      if (!entry || entry.listeners.size === 0 || connection.state !== "open") return;
      if (entry.sub !== null) {
        bySub.delete(entry.sub);
        release(entry.sub);
        entry.sub = null;
      }
      entry.cursor = null;
      // A request in flight is answered stale by the generation `open` bumps, and released then (R11).
      open(entry);
    },
```

and the doc comment of `Subscriptions` gains the `resync` line. `testing/runtime-bed.ts`: `subscribe.session` and `subscribe.shell` answer `{ sub: \`s${++subs}\` }` and record `[method, sub]`; `emitTo(method, event, nth = 0)` delivers to the nth recorded sub of that method; `emit(event)` = the first `subscribe.session` sub, else `"s1"`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm build && pnpm budgets`
Expected: PASS; every existing web test unchanged and green. Record `bundle: 194.7 → <n> KB gzip`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/runtime apps/web/src/testing/runtime-bed.ts
git commit -m "feat(web): subscriptions keyed by stream and key, the shell stream's opener, and resync (R125)"
```

---

### Task 19: The shell store — one eager source for sessions and projects, with optimistic changes that roll back

**Files:**
- Create: `apps/web/src/stores/{shell-reducer.ts,shell-reducer.test.ts,shell-store.ts,shell-feed.ts}`, `apps/web/src/testing/shell-snapshot.ts`

**Interfaces:**
- Consumes: Task 5 `ShellStreamEvent`, `ShellSession`, `ProjectSummary`, `SHELL_LIMITS`; Task 18 `subscriptions`.
- Produces:
  - `interface ShellView { loaded; unreadable; sessions: ReadonlyMap<string, ShellSession>; projects: ReadonlyMap<string, ProjectSummary>; more: number; archived: number; pending: ReadonlyMap<string, PendingChange> }`, `interface PendingChange { sessions: ReadonlyArray<{ before: ShellSession; after: ShellSession }>; projects: ReadonlyArray<{ before: ProjectSummary; after: ProjectSummary }> }`, `EMPTY_SHELL`, `MAX_STORE_SESSIONS`, `MAX_STORE_PROJECTS`, `reduceShell(view, raw)`, `optimistic(view, commandId, change: { sessions?: ShellSession[]; projects?: ProjectSummary[] })`, `confirm(view, commandId)`, `rollback(view, commandId)`, `pinnedIds(view): string[]` (`shell-reducer.ts`).
  - `useShellStore` (zustand) with `view`, `apply(event)`, `optimistic(commandId, change)`, `confirm(commandId)`, `rollback(commandId)`, `reset()` (`shell-store.ts`).
  - `feedShell(subscriptions, onError?): () => void` (`shell-feed.ts`).
  - `shellSnapshot(sessions, patch?)`, `shellSession(patch)` test fixtures (`testing/shell-snapshot.ts`).

**Rulings (pre-dispatch):**
- M4R80: The store is bounded: at most 550 sessions (pinned never evicted; archived first, then the oldest by `updatedAt`) and 550 projects (those no held session names go first) — events for old sessions (a CLI append) can arrive forever — cost if wrong: none.
- M4R81: A snapshot replaces everything and drops every pending change: after a reconnect, the server's state is the truth (R105: an outcome unknown is read back, never guessed) — cost if wrong: none.
- M4R82: A rollback puts back a change's `before` only where the store still holds that change's `after` (the same object): a newer server event wins over a failed optimistic write (Review Focus 4) — cost if wrong: none.
- M4R83: One optimistic change at a time in the whole sidebar (`pending.size > 0` makes the next action wait): a second action's `before` would otherwise be the first's unconfirmed `after` — the answer to a local mark takes milliseconds — cost if wrong: an action pressed within those milliseconds of another is ignored with a polite message.
- M4R84: The store is eager and small; screens select from it (`useShellStore((s) => s.view.sessions)`), never copy it — `pap/zustand-selector` lint — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`testing/shell-snapshot.ts`:

```ts
import type { ProjectSummary, ShellSession } from "@pap/contracts";

export const shellSession = (patch: Partial<ShellSession> & { id: string }): ShellSession => ({
  cwd: `/w/${patch.id}`,
  name: null,
  preview: null,
  status: "cold",
  needsInput: false,
  projectId: null,
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

export const shellProject = (patch: Partial<ProjectSummary> & { id: string }): ProjectSummary => ({
  root: `/w/${patch.id}`,
  name: patch.id,
  position: 1,
  sessions: 0,
  ...patch,
});

/** The first event of the `shell` stream. */
export const shellSnapshot = (
  sessions: ShellSession[],
  patch: { projects?: ProjectSummary[]; more?: number; archived?: number } = {},
) => ({ kind: "snapshot", projects: patch.projects ?? [], sessions, more: patch.more ?? 0, archived: patch.archived ?? 0 });
```

`shell-reducer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shellProject, shellSession, shellSnapshot } from "../testing/shell-snapshot.ts";
import { confirm, EMPTY_SHELL, MAX_STORE_SESSIONS, optimistic, pinnedIds, reduceShell, rollback } from "./shell-reducer.ts";

const loaded = (sessions = [shellSession({ id: "a" }), shellSession({ id: "b", pinRank: 1 })]) =>
  reduceShell(EMPTY_SHELL, shellSnapshot(sessions, { projects: [shellProject({ id: "p1" })], more: 3, archived: 2 }));

describe("shell reducer", () => {
  it("a snapshot replaces the view and drops pending changes (M4R81)", () => {
    const pending = optimistic(loaded(), "c1", { sessions: [shellSession({ id: "a", pinRank: 2 })] });
    const view = reduceShell(pending, shellSnapshot([shellSession({ id: "z" })]));
    expect([...view.sessions.keys()]).toEqual(["z"]);
    expect([view.loaded, view.pending.size, view.more, view.archived]).toEqual([true, 0, 0, 0]);
  });

  it("upserts sessions and projects, and takes the archived count", () => {
    let view = loaded();
    view = reduceShell(view, { kind: "session", session: shellSession({ id: "a", name: "renamed" }) });
    view = reduceShell(view, { kind: "project", project: shellProject({ id: "p2" }) });
    view = reduceShell(view, { kind: "counts", archived: 7 });
    expect(view.sessions.get("a")?.name).toBe("renamed");
    expect([...view.projects.keys()]).toEqual(["p1", "p2"]);
    expect(view.archived).toBe(7);
  });

  it("an unreadable snapshot says so; another unreadable event is dropped", () => {
    expect(reduceShell(EMPTY_SHELL, { kind: "snapshot", sessions: "no" })).toMatchObject({ loaded: true, unreadable: true });
    const view = loaded();
    expect(reduceShell(view, { kind: "session", session: { id: 1 } })).toBe(view);
  });

  it("stays bounded: archived go first, then the oldest unpinned; pinned stay (M4R80)", () => {
    let view = loaded([]);
    view = reduceShell(view, { kind: "session", session: shellSession({ id: "pin", pinRank: 1, updatedAt: 0 }) });
    view = reduceShell(view, { kind: "session", session: shellSession({ id: "arch", archivedAt: 1, updatedAt: 999_999 }) });
    for (let i = 0; i < MAX_STORE_SESSIONS; i++)
      view = reduceShell(view, { kind: "session", session: shellSession({ id: `s${i}`, updatedAt: 10 + i }) });
    expect(view.sessions.size).toBe(MAX_STORE_SESSIONS);
    expect(view.sessions.has("pin")).toBe(true);
    expect(view.sessions.has("arch")).toBe(false);
    expect(view.sessions.has("s0")).toBe(false);
    expect(view.sessions.has(`s${MAX_STORE_SESSIONS - 1}`)).toBe(true);
  });

  it("shows an optimistic change, confirms it, or rolls it back (M4R82)", () => {
    const view = loaded();
    const after = shellSession({ id: "a", archivedAt: 5 });
    const shown = optimistic(view, "c1", { sessions: [after] });
    expect(shown.sessions.get("a")).toBe(after);
    expect(confirm(shown, "c1").pending.size).toBe(0);
    expect(confirm(shown, "c1").sessions.get("a")).toBe(after);
    expect(rollback(shown, "c1").sessions.get("a")).toBe(view.sessions.get("a"));
  });

  it("a rollback never overwrites a newer server event", () => {
    const shown = optimistic(loaded(), "c1", { sessions: [shellSession({ id: "a", archivedAt: 5 })] });
    const newer = shellSession({ id: "a", status: "running" });
    const moved = reduceShell(shown, { kind: "session", session: newer });
    expect(rollback(moved, "c1").sessions.get("a")).toBe(newer);
  });

  it("rolls back project changes the same way", () => {
    const view = loaded();
    const renamed = shellProject({ id: "p1", name: "new" });
    const shown = optimistic(view, "c2", { projects: [renamed] });
    expect(shown.projects.get("p1")?.name).toBe("new");
    expect(rollback(shown, "c2").projects.get("p1")?.name).toBe("p1");
  });

  it("pinnedIds lists the pinned sessions by rank", () => {
    const view = loaded([shellSession({ id: "x", pinRank: 2 }), shellSession({ id: "y", pinRank: 1 }), shellSession({ id: "z" })]);
    expect(pinnedIds(view)).toEqual(["y", "x"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/stores/shell-reducer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`shell-reducer.ts`:

```ts
import { type ProjectSummary, SHELL_LIMITS, type ShellSession, ShellStreamEvent } from "@pap/contracts";

export interface PendingChange {
  readonly sessions: ReadonlyArray<{ readonly before: ShellSession; readonly after: ShellSession }>;
  readonly projects: ReadonlyArray<{ readonly before: ProjectSummary; readonly after: ProjectSummary }>;
}

export interface ShellView {
  readonly loaded: boolean;
  readonly unreadable: boolean;
  readonly sessions: ReadonlyMap<string, ShellSession>;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  /** Active sessions the snapshot left out: older than its window. */
  readonly more: number;
  readonly archived: number;
  /** Changes shown before the daemon answered, by commandId (M4R82, M4R83). */
  readonly pending: ReadonlyMap<string, PendingChange>;
}

export const EMPTY_SHELL: ShellView = {
  loaded: false,
  unreadable: false,
  sessions: new Map(),
  projects: new Map(),
  more: 0,
  archived: 0,
  pending: new Map(),
};

export const MAX_STORE_SESSIONS = SHELL_LIMITS.sessions + SHELL_LIMITS.pins;
export const MAX_STORE_PROJECTS = SHELL_LIMITS.projects + SHELL_LIMITS.pins;

/** Archived first, then the oldest that are not pinned (M4R80). */
function boundSessions(sessions: Map<string, ShellSession>): Map<string, ShellSession> {
  if (sessions.size <= MAX_STORE_SESSIONS) return sessions;
  const evictable = [...sessions.values()]
    .filter((session) => session.pinRank === null)
    .sort((a, b) => Number(b.archivedAt !== null) - Number(a.archivedAt !== null) || a.updatedAt - b.updatedAt);
  for (const session of evictable.slice(0, sessions.size - MAX_STORE_SESSIONS)) sessions.delete(session.id);
  return sessions;
}

/** Projects no held session names go first. */
function boundProjects(projects: Map<string, ProjectSummary>, sessions: ReadonlyMap<string, ShellSession>): Map<string, ProjectSummary> {
  if (projects.size <= MAX_STORE_PROJECTS) return projects;
  const named = new Set([...sessions.values()].map((session) => session.projectId));
  for (const id of [...projects.keys()].filter((id) => !named.has(id)).slice(0, projects.size - MAX_STORE_PROJECTS))
    projects.delete(id);
  return projects;
}

export function reduceShell(view: ShellView, raw: unknown): ShellView {
  const parsed = ShellStreamEvent.safeParse(raw);
  if (!parsed.success)
    return (raw as { kind?: unknown } | null)?.kind === "snapshot" ? { ...view, loaded: true, unreadable: true } : view;
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        ...EMPTY_SHELL,
        loaded: true,
        sessions: new Map(event.sessions.map((session) => [session.id, session])),
        projects: new Map(event.projects.map((project) => [project.id, project])),
        more: event.more,
        archived: event.archived,
      };
    case "session": {
      const sessions = boundSessions(new Map(view.sessions).set(event.session.id, event.session));
      return { ...view, sessions };
    }
    case "project":
      return { ...view, projects: boundProjects(new Map(view.projects).set(event.project.id, event.project), view.sessions) };
    case "counts":
      return { ...view, archived: event.archived };
  }
}

export function optimistic(
  view: ShellView,
  commandId: string,
  change: { readonly sessions?: readonly ShellSession[]; readonly projects?: readonly ProjectSummary[] },
): ShellView {
  const sessions = new Map(view.sessions);
  const projects = new Map(view.projects);
  const pending: PendingChange = {
    sessions: (change.sessions ?? []).flatMap((after) => {
      const before = view.sessions.get(after.id);
      if (!before) return [];
      sessions.set(after.id, after);
      return [{ before, after }];
    }),
    projects: (change.projects ?? []).flatMap((after) => {
      const before = view.projects.get(after.id);
      if (!before) return [];
      projects.set(after.id, after);
      return [{ before, after }];
    }),
  };
  return { ...view, sessions, projects, pending: new Map(view.pending).set(commandId, pending) };
}

export function confirm(view: ShellView, commandId: string): ShellView {
  if (!view.pending.has(commandId)) return view;
  const pending = new Map(view.pending);
  pending.delete(commandId);
  return { ...view, pending };
}

export function rollback(view: ShellView, commandId: string): ShellView {
  const change = view.pending.get(commandId);
  if (!change) return view;
  const sessions = new Map(view.sessions);
  for (const { before, after } of change.sessions) if (sessions.get(after.id) === after) sessions.set(before.id, before);
  const projects = new Map(view.projects);
  for (const { before, after } of change.projects) if (projects.get(after.id) === after) projects.set(before.id, before);
  const pending = new Map(view.pending);
  pending.delete(commandId);
  return { ...view, sessions, projects, pending };
}

export const pinnedIds = (view: ShellView): string[] =>
  [...view.sessions.values()]
    .filter((session) => session.pinRank !== null)
    .sort((a, b) => (a.pinRank ?? 0) - (b.pinRank ?? 0))
    .map((session) => session.id);
```

`shell-store.ts`:

```ts
import type { ProjectSummary, ShellSession } from "@pap/contracts";
import { create } from "zustand";
import { confirm, EMPTY_SHELL, optimistic, reduceShell, rollback, type ShellView } from "./shell-reducer.ts";

interface ShellStoreState {
  readonly view: ShellView;
  apply(event: unknown): void;
  optimistic(commandId: string, change: { sessions?: ShellSession[]; projects?: ProjectSummary[] }): void;
  confirm(commandId: string): void;
  rollback(commandId: string): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The sidebar's sessions and projects (the `shell` stream), the one eager source of session lists (M4R84). */
export const useShellStore = create<ShellStoreState>()((set) => ({
  view: EMPTY_SHELL,
  apply: (event) => set((state) => ({ view: reduceShell(state.view, event) })),
  optimistic: (commandId, change) => set((state) => ({ view: optimistic(state.view, commandId, change) })),
  confirm: (commandId) => set((state) => ({ view: confirm(state.view, commandId) })),
  rollback: (commandId) => set((state) => ({ view: rollback(state.view, commandId) })),
  reset: () => set({ view: EMPTY_SHELL }),
}));
```

`shell-feed.ts`:

```ts
import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useShellStore } from "./shell-store.ts";

/** The one listener of the `shell` stream while the shell is mounted. Its key is local: the stream is the caller's. */
export function feedShell(subscriptions: Runtime["subscriptions"], onError?: (code: RpcErrorCode) => void): () => void {
  return subscriptions.subscribe("shell", "me", (event) => useShellStore.getState().apply(event), onError);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/stores && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS (knip: `shell-store.ts` and `shell-feed.ts` are imported from Task 20 — if knip flags them now, record it; Task 20 consumes them. Prefer landing Tasks 19 and 20 back to back.)

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/stores apps/web/src/testing/shell-snapshot.ts
git commit -m "feat(web): the shell store — sessions and projects from the shell stream, bounded, with optimistic changes"
```

---

### Task 20: One source for the session list (carry: `sessions-cache.ts`, `SessionListScreen`, the palette, tabs)

**Files:**
- Modify: `apps/web/src/routes/shell/{AppShell.tsx,TabBar.tsx,MobileShell.tsx,PaletteHost.tsx,TreeDrawer.tsx,SessionTree.tsx,use-shell-effects.ts,item-title.ts}`, `apps/web/src/features/sessions/SessionListScreen.tsx`
- Delete: `apps/web/src/routes/shell/sessions-cache.ts`, `sessions-cache.test.ts`
- Modify tests: `AppShell.test.tsx`, `drawers.test.tsx`, `palette-open.test.tsx`, `MobileShell.test.tsx`, `MobileShell.phone.test.tsx`, `TabBar.test.tsx`, `item-title.test.ts`, `SessionListScreen.test.tsx` (emit a `shell` snapshot with `bed.emitTo("subscribe.shell", shellSnapshot([...]))` instead of answering `sessions.list`)

**Interfaces:**
- Consumes: Task 19 `useShellStore`, `feedShell`; Task 18 `emitTo`.
- Produces: `itemTitle(item, sessions: ReadonlyMap<string, ShellSession>, views: Readonly<Record<string, SessionView>>, t)`; `AppShell` runs `feedShell` while mounted and `reset()`s the store on unmount.

**Rulings (pre-dispatch):**
- M4R85: The shell subscribes to `shell` once while it is mounted; nothing in the browser calls `sessions.list` any more (`rg -n '"sessions.list"' apps/web/src --glob '!**/*.test.*'` prints nothing) — one source (carry) — cost if wrong: none.
- M4R86: A tab of a session the store does not hold (older than the snapshot's window, opened from a search hit) takes its title from that session's own view (its snapshot's `name` and `cwd`) — no extra request — cost if wrong: "Session" until the session screen has loaded.
- M4R87: The shell's "ask again for a missing id" effect goes: the stream keeps the store current, and a session created elsewhere arrives as an event — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

- `AppShell.test.tsx`: "subscribes to the shell stream once while mounted and never lists sessions": after mount and `setState("open")`, `bed.called("subscribe.shell")` has one entry and `bed.called("sessions.list")` none; unmount sends `unsubscribe`; "titles the top bar with the session's name from the stream": emit a snapshot holding `shellSession({ id: "abc", name: "Fix tests" })` → the header shows "Fix tests".
- `TabBar.test.tsx`: the tab of a session the store holds shows its label and the running dot from the stream (`status: "running"`); a tab of a session the store lacks but whose view has `name: "From view"` shows "From view".
- `item-title.test.ts`: the three cases (store, view, neither → "Session").
- `SessionListScreen.test.tsx`: the list comes from the store (a snapshot with two sessions shows both, newest first); creating a session still calls `sessions.create`; no `sessions.list` call.
- `palette-open.test.tsx`, `drawers.test.tsx`, `MobileShell*.test.tsx`: the same scenarios, fed by `emitTo("subscribe.shell", shellSnapshot(...))`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes apps/web/src/features/sessions/SessionListScreen.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `AppShell.tsx`: `useEffect(() => { const stop = feedShell(getRuntime().subscriptions, () => reportClientIssue("shell_feed_failed")); return () => { stop(); useShellStore.getState().reset(); }; }, []);`.
- `use-shell-effects.ts`: drop `useSessionsCache` and the missing-id effect; keep the URL/tab effect, the settings syncs and the dispatcher.
- `item-title.ts`: `itemTitle(item, sessions, views, t)`: a session is `sessionLabel(sessions.get(id) ?? views[id] ?? null) || t("shell.tab.session")` — for a view, label `{ name: view.name, cwd: view.cwd }` (Task 3 put `cwd` in the view); `DesktopShell`, `MobileShell`, `TabBar` pass `useShellStore((s) => s.view.sessions)` and `useSessionStore((s) => s.views)`.
- `TabBar.tsx`: running from `sessions.get(id)?.status === "running"`.
- `PaletteHost.tsx`: sessions from the store (`[...sessions.values()]`); no refresh on open (the stream is live).
- `TreeDrawer.tsx`, `SessionTree.tsx`: read the store (`[...sessions.values()]`, `status` → `view.loaded`); `SessionTree` keeps its look until Task 22 replaces it; its Retry button goes (the stream reconnects by itself) and its error banner shows when `view.unreadable`.
- `SessionListScreen.tsx`: its list is the store's sessions not archived, newest first, at most 50 (the full home is Task 24); the `listings` re-list after an outcome-unknown create goes (the stream shows the session if it was made).
- Delete `sessions-cache.ts` and its test.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS. `rg -n "sessions-cache|useSessionsCache" apps/web/src` prints nothing. Record the bundle.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src
git commit -m "feat(web): the shell stream is the one source of the session list; sessions-cache and its re-lists go"
```

---

### Task 21: One label for a session, readable tab titles, the active tab in view (carry: unnamed sessions; M3 triage #63, #184)

**Files:**
- Create: `apps/web/src/lib/session-label.ts`, `apps/web/src/lib/session-label.test.ts`
- Delete: `apps/web/src/routes/shell/session-label.ts` (+ its test if any)
- Modify: `apps/web/src/routes/shell/{item-title.ts,palette-items.ts,SessionTree.tsx,TabBar.tsx}`, `apps/web/src/features/sessions/SessionListScreen.tsx`, `packages/ui/src/primitives/OpenTab.tsx` (+ test)

**Interfaces:**
- Produces: `basename(cwd: string): string`, `sessionLabel(session: { name: string | null; preview?: string | null; cwd: string } | null): string` (`""` when nothing is known; callers fall back to `shell.tab.session`).

**Rulings (pre-dispatch):**
- M4R88 (owner Q9 default): a session is labelled by its name, else its preview (the start of its first message), else its folder's name — in tabs, the tree, the palette, the top bar and home alike; never its id — the carry, and a tree of one project's sessions all labelled with the folder would be useless — cost if wrong: one function to change.
- M4R89: `OpenTab` shows the full title in a tooltip (the existing lazy `Tooltip`, opened on hover and focus) when its title is longer than the tab shows; its accessible name was already the full title — the M3 triage item — cost if wrong: none.
- M4R90: The tab bar scrolls the active tab into view (`scrollIntoView({ block: "nearest", inline: "nearest" })`) when the active tab changes — the M3 triage item — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`session-label.test.ts`: `sessionLabel({ name: "N", preview: "P", cwd: "/w/api" })` → `"N"`; `{ name: null, preview: "P", cwd: "/w/api" }` → `"P"`; `{ name: null, preview: null, cwd: "/w/api/" }` → `"api"`; `{ name: null, cwd: "/" }` → `""`; `null` → `""`. `basename("/w/api//")` → `"api"`.

`SessionTree` (or `drawers.test.tsx`): an unnamed session with a preview shows the preview, never the id. `OpenTab.test.tsx`: a tab whose title is 120 characters renders a tooltip trigger whose content, after `pointerenter`, is the whole title; a short title renders no tooltip. `TabBar.test.tsx`: switching the active tab calls `scrollIntoView` on the new active tab (stub `Element.prototype.scrollIntoView` with `vi.fn` in the test).

- [ ] **Step 2: Run them to see them fail**, then **Step 3: Implement** — `lib/session-label.ts`:

```ts
/** The last folder of a path ("" for the root). */
export const basename = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? "";

/** What every list shows for a session (M4R88): its name, else its first words, else its folder; "" when none is known. */
export const sessionLabel = (
  session: { readonly name: string | null; readonly preview?: string | null; readonly cwd: string } | null,
): string => session?.name ?? session?.preview ?? basename(session?.cwd ?? "");
```

Update every importer of `routes/shell/session-label.ts`; `SessionTree` rows use `sessionLabel(session) || t("shell.tab.session")`. `OpenTab`: wrap the title text in the package's `Tooltip` when `title.length > 24` (the truncation width of a tab at the default density; the test pins the two sides of it) with `label={title}` (its prop) — no new class, no restyle. `TabBar`: a `useEffect` on `ws.active` that calls `document.getElementById(\`tab-${ws.active}\`)?.scrollIntoView({ block: "nearest", inline: "nearest" })`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web packages/ui && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets`
Expected: PASS; the class-coverage and touch-target probes stay green. Record the bundle.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src packages/ui/src
git commit -m "feat(web): one label for a session everywhere (name, first words, folder); full tab titles and the active tab in view"
```

---

### Task 22: The ⌘B project tree — pinned, projects, shelves, filter, caps — loaded lazily, on phones too

DESIGN §8: the left drawer is the tree "project → lane → session" (lanes arrive with M9). The tree replaces `SessionTree`: Pinned on top, then projects in the person's order with their active sessions, then the Snoozed, Settled and Archived shelves. It is one lazy chunk shared by the ⌘B drawer and the phone's Lists section.

**Files:**
- Create: `apps/web/src/features/projects/{tree.vm.ts,tree.vm.test.ts,age.ts,age.test.ts,ProjectTree.tsx,ProjectTree.test.tsx,SessionRow.tsx,ProjectHeading.tsx,ArchivedShelf.tsx}`
- Create: `apps/web/src/i18n/catalog/sidebar.ts`, `apps/web/src/i18n/register-sidebar.ts`
- Modify: `apps/web/src/routes/shell/{TreeDrawer.tsx,MobileShell.tsx}`, `apps/web/src/i18n/index.ts` (`MessageKey` gains `keyof typeof sidebarEn`), `apps/web/src/i18n/{catalog-keys.test.ts,lazy-catalog.test.tsx}`, `apps/web/src/i18n/catalog/shell.ts` (the `shell.tree.*` keys move to `sidebar.ts`), `apps/web/src/build-output.int.test.ts`
- Delete: `apps/web/src/routes/shell/{SessionTree.tsx,session-groups.ts,session-groups.test.ts}`

**Interfaces:**
- Consumes: Task 19 store; Task 21 `sessionLabel`; contracts `isSnoozed`.
- Produces:
  - `apps/web/src/i18n/register-sidebar.ts` (registers the lazy `sidebar` catalog; imported by every lazy chunk that shows its keys).
  - `ROWS_PER_PROJECT = 20`, `SHELF_ROWS = 50`; `interface TreeGroup { project: ProjectSummary | null; sessions: ShellSession[]; hidden: number; older: number }`; `interface TreeModel { pinned; groups; snoozed; snoozedMore; settled; settledMore; empty }`; `buildTree(input: { sessions: Iterable<ShellSession>; projects: ReadonlyMap<string, ProjectSummary>; filter: string; projectId: string | null; shown: ReadonlyMap<string, number>; now: number }): TreeModel` (`tree.vm.ts`).
  - `formatAge(now: number, then: number, locale: Locale): string` (`age.ts`).
  - `ProjectTree({ onPick(id: string): void })` (default export too, for `lazy`).

**Rulings (pre-dispatch):**
- M4R91: The tree's order: Pinned (by rank, every project, snoozed pins in the Snoozed shelf); then one group per project in the person's order (sessions without a project in a last "Other folders" group), each newest first, 20 rows and "Show 20 more" until the store runs out, then "N older sessions · search with ⌘K" from the project's count; then Snoozed (soonest wake first), Settled (most recently settled first), each at most 50 with "+N"; then "Archived (N)", which lists pages from `sessions.listArchived` when opened — M3R98's "use ⌘K" pattern per project; bounded rows — cost if wrong: one view-model to change.
- M4R92: The filter matches the label, the folder and the project's name, accents and case aside (M3's `normalize`); while it holds text, "older" counts are not shown (they are about the unfiltered list) — cost if wrong: none.
- M4R93 (owner Q1 default): a current project (Task 24) narrows the groups and shelves to it; pinned sessions of every project stay — cost if wrong: one condition.
- M4R94: The tree, its rows and their strings are one lazy chunk (`ProjectTree.tsx` and `catalog/sidebar.ts`, registered at the chunk's evaluation); `MobileShell` loads it through `LazyPanel` for the Lists section — DESIGN: nothing not on the first paint is eager; frees about 1.4 KB — cost if wrong: the Lists section waits a few ms on its first open.
- M4R95: A row shows the label, a status chip when the session works (`working`) or waits for an answer (`needs input`, attention tone), and its age ("now", "5 min", "3 h", "2 d", "4 wk", by `Intl.RelativeTimeFormat`-free fixed units in the catalog); the folder shows under the project heading, not per row — DESIGN §11 numbers, compact rows — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`tree.vm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { buildTree, ROWS_PER_PROJECT, SHELF_ROWS } from "./tree.vm.ts";

const NOW = 1_800_000_000_000;
const projects = new Map([
  ["p1", shellProject({ id: "p1", name: "api", position: 2, sessions: 3 })],
  ["p2", shellProject({ id: "p2", name: "web", position: 1, sessions: 1 })],
]);
const base = { projects, filter: "", projectId: null, shown: new Map<string, number>(), now: NOW };
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((s) => s.id);

describe("the project tree", () => {
  it("puts pinned sessions on top by rank, then projects in order, newest first, and the shelves", () => {
    const model = buildTree({
      ...base,
      sessions: [
        shellSession({ id: "a", projectId: "p1", updatedAt: 3 }),
        shellSession({ id: "b", projectId: "p1", updatedAt: 9 }),
        shellSession({ id: "c", projectId: "p2", updatedAt: 1 }),
        shellSession({ id: "pin2", projectId: "p1", pinRank: 2 }),
        shellSession({ id: "pin1", projectId: "p2", pinRank: 1 }),
        shellSession({ id: "free", projectId: null, updatedAt: 5 }),
        shellSession({ id: "zz", projectId: "p1", snoozedUntil: NOW + 1000 }),
        shellSession({ id: "awake", projectId: "p1", snoozedUntil: NOW - 1, updatedAt: 4 }),
        shellSession({ id: "st", projectId: "p2", settledAt: 7 }),
        shellSession({ id: "ar", projectId: "p1", archivedAt: 8 }),
      ],
    });
    expect(ids(model.pinned)).toEqual(["pin1", "pin2"]);
    expect(model.groups.map((g) => [g.project?.id ?? null, ids(g.sessions)])).toEqual([
      ["p2", ["c"]],
      ["p1", ["b", "awake", "a"]],
      [null, ["free"]],
    ]);
    expect(ids(model.snoozed)).toEqual(["zz"]);
    expect(ids(model.settled)).toEqual(["st"]);
    expect(model.empty).toBe(false);
  });

  it("caps a project at 20 rows, shows more on demand, and counts sessions the browser does not hold", () => {
    const many = Array.from({ length: 30 }, (_, i) => shellSession({ id: `s${i}`, projectId: "p1", updatedAt: i }));
    const big = new Map([["p1", shellProject({ id: "p1", sessions: 45 })]]);
    const model = buildTree({ ...base, projects: big, sessions: many });
    expect([model.groups[0]?.sessions.length, model.groups[0]?.hidden, model.groups[0]?.older]).toEqual([ROWS_PER_PROJECT, 10, 15]);
    const more = buildTree({ ...base, projects: big, sessions: many, shown: new Map([["p1", 40]]) });
    expect([more.groups[0]?.sessions.length, more.groups[0]?.hidden]).toEqual([30, 0]);
  });

  it("filters on label, folder and project name, accents and case aside, and then hides the older counts", () => {
    const sessions = [
      shellSession({ id: "x", projectId: "p1", name: "Déploiement" }),
      shellSession({ id: "y", projectId: "p2", cwd: "/w/web" }),
      shellSession({ id: "z", projectId: "p1", preview: "other" }),
    ];
    expect(ids(buildTree({ ...base, sessions, filter: "deploie" }).groups.flatMap((g) => g.sessions))).toEqual(["x"]);
    expect(ids(buildTree({ ...base, sessions, filter: "WEB" }).groups.flatMap((g) => g.sessions))).toEqual(["y"]);
    expect(buildTree({ ...base, sessions, filter: "api" }).groups.map((g) => g.older)).toEqual([0]);
  });

  it("narrows to the current project but keeps every pinned session (M4R93)", () => {
    const sessions = [
      shellSession({ id: "a", projectId: "p1" }),
      shellSession({ id: "b", projectId: "p2" }),
      shellSession({ id: "pin", projectId: "p2", pinRank: 1 }),
      shellSession({ id: "st", projectId: "p2", settledAt: 1 }),
    ];
    const model = buildTree({ ...base, sessions, projectId: "p1" });
    expect([ids(model.pinned), model.groups.map((g) => g.project?.id), ids(model.settled)]).toEqual([["pin"], ["p1"], []]);
  });

  it("caps the shelves at 50 and counts the rest", () => {
    const settled = Array.from({ length: 60 }, (_, i) => shellSession({ id: `t${i}`, settledAt: i }));
    const model = buildTree({ ...base, sessions: settled });
    expect([model.settled.length, model.settledMore, model.settled[0]?.id]).toEqual([SHELF_ROWS, 10, "t59"]);
  });

  it("is empty when nothing shows", () => {
    expect(buildTree({ ...base, sessions: [shellSession({ id: "ar", archivedAt: 1 })] }).empty).toBe(true);
  });
});
```

`age.test.ts`: `formatAge(NOW, NOW - 30_000, "en")` → `"now"`; `- 5 * 60_000` → `"5 min"`; `- 3 * 3_600_000` → `"3 h"`; `- 2 * 86_400_000` → `"2 d"`; `- 30 * 86_400_000` → `"4 wk"`; `fr` → `"maintenant"`, `"5 min"`, `"3 h"`, `"2 j"`, `"4 sem."`; a time in the future reads `"now"`.

`ProjectTree.test.tsx` (store loaded through `useShellStore.getState().apply(shellSnapshot(...))`, router from the shell bed or a memory router):
- headings "Pinned", the projects' names in order, "Snoozed (1)", "Settled (1)", "Archived (2)";
- a row link points to `/s/<id>`; clicking it calls `onPick` with the id;
- a running session shows the `Working` chip; one with `needsInput` shows `Needs input`;
- "Show 20 more" appears for a project of 25 sessions and reveals them;
- "15 older sessions · search with ⌘K" (with the effective chord) appears when the project's count exceeds what the store holds;
- typing `zzz` in the filter shows "No session matches.";
- opening "Archived (2)" calls `sessions.listArchived {}` and lists the answer; "Load more" sends `{ before: { archivedAt, id } }` of the last row; a failure shows the error text and a Retry button.

`build-output.int.test.ts`: the marker `"data-project-tree"` is absent from every initial asset and present in a lazy one (`keepsLazyOnly`), and so is a sidebar-only string (`"Show 20 more"`).

`lazy-catalog.test.tsx`: a case for the sidebar catalog like the Settings one: the files allowed to name its keys are the `features/projects/*.tsx` files and (from Task 25) the palette's transcript files.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/projects apps/web/src/i18n`
Expected: FAIL.

- [ ] **Step 3: Implement**

`tree.vm.ts`:

```ts
import { isSnoozed, type ProjectSummary, type ShellSession } from "@pap/contracts";
import { sessionLabel } from "../../lib/session-label.ts";

export const ROWS_PER_PROJECT = 20;
export const SHELF_ROWS = 50;

export interface TreeGroup {
  /** null: sessions without a project ("Other folders"). */
  readonly project: ProjectSummary | null;
  readonly sessions: readonly ShellSession[];
  /** Rows the browser holds but the cap hides ("Show 20 more"). */
  readonly hidden: number;
  /** The project's active sessions the browser does not hold ("search with ⌘K"); 0 while filtering. */
  readonly older: number;
}

export interface TreeModel {
  readonly pinned: readonly ShellSession[];
  readonly groups: readonly TreeGroup[];
  readonly snoozed: readonly ShellSession[];
  readonly snoozedMore: number;
  readonly settled: readonly ShellSession[];
  readonly settledMore: number;
  readonly empty: boolean;
}

export interface TreeInput {
  readonly sessions: Iterable<ShellSession>;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  readonly filter: string;
  /** The current project (Task 24): only it and the pinned sessions show; null shows every project. */
  readonly projectId: string | null;
  /** Rows shown per project id ("" for the group without a project). */
  readonly shown: ReadonlyMap<string, number>;
  readonly now: number;
}

const normalize = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const newest = (a: ShellSession, b: ShellSession): number => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);

export function buildTree(input: TreeInput): TreeModel {
  const needle = normalize(input.filter.trim());
  const matches = (session: ShellSession): boolean => {
    if (needle === "") return true;
    const project = session.projectId === null ? "" : (input.projects.get(session.projectId)?.name ?? "");
    return normalize(`${sessionLabel(session)} ${session.cwd} ${project}`).includes(needle);
  };
  const inScope = (session: ShellSession): boolean => input.projectId === null || session.projectId === input.projectId;
  const pinned: ShellSession[] = [];
  const snoozed: ShellSession[] = [];
  const settled: ShellSession[] = [];
  const active = new Map<string | null, ShellSession[]>();
  const held = new Map<string | null, number>();
  for (const session of input.sessions) {
    if (session.archivedAt !== null) continue;
    held.set(session.projectId, (held.get(session.projectId) ?? 0) + 1);
    if (!matches(session)) continue;
    const asleep = isSnoozed(session, input.now);
    if (session.pinRank !== null && !asleep) {
      pinned.push(session);
      continue;
    }
    if (!inScope(session)) continue;
    if (asleep) snoozed.push(session);
    else if (session.settledAt !== null) settled.push(session);
    else active.set(session.projectId, [...(active.get(session.projectId) ?? []), session]);
  }
  pinned.sort((a, b) => (a.pinRank ?? 0) - (b.pinRank ?? 0));
  snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  settled.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  const groups = [...active].map(([projectId, list]): TreeGroup => {
    const sorted = list.toSorted(newest);
    const cap = input.shown.get(projectId ?? "") ?? ROWS_PER_PROJECT;
    const project = projectId === null ? null : (input.projects.get(projectId) ?? null);
    const older = needle === "" && project ? Math.max(0, project.sessions - (held.get(projectId) ?? 0)) : 0;
    return { project, sessions: sorted.slice(0, cap), hidden: Math.max(0, sorted.length - cap), older };
  });
  groups.sort((a, b) => {
    if (a.project === null || b.project === null) return a.project === null ? 1 : -1;
    return a.project.position - b.project.position || a.project.name.localeCompare(b.project.name);
  });
  return {
    pinned,
    groups,
    snoozed: snoozed.slice(0, SHELF_ROWS),
    snoozedMore: Math.max(0, snoozed.length - SHELF_ROWS),
    settled: settled.slice(0, SHELF_ROWS),
    settledMore: Math.max(0, settled.length - SHELF_ROWS),
    empty: pinned.length === 0 && groups.length === 0 && snoozed.length === 0 && settled.length === 0,
  };
}
```

`age.ts`: `formatAge(now, then, locale)` with steps `< 60 s` → `sidebar.age.now`, minutes, hours, days (< 14), weeks — through `translate(locale, "sidebar.age.min", { n })` etc. (keys in the lazy catalog).

`ProjectTree.tsx` (default export; imports `../../i18n/register-sidebar.ts` first): reads `useShellStore((s) => s.view)`, `useCurrentProject` is Task 24's (here `projectId: null`), keeps `filter`, `shown` and the shelves' open state in component state, `now` from a `useNow(60_000)` tick (an interval cleared on unmount, so ages refresh each minute). Markup: `<div data-project-tree className="flex flex-col gap-s3 p-s3">` with the filter `TextField`, then sections (`<section aria-labelledby>`, heading `label-hud text-muted`), `SessionRow`s in `<ul>`s, `ProjectHeading` per group (name `text-ui font-semibold`, root `font-mono text-code text-dim break-all`, count), the "Show 20 more" `Button variant="ghost" size="sm"`, the "older" line `text-ui text-muted`, `Collapsible` shelves, `ArchivedShelf`. Loading: before `view.loaded`, the feedback rule (nothing under 100 ms, then a `Spinner`); `view.unreadable` → `Banner tone="capacity"` with `sidebar.unreadable`.

`SessionRow.tsx`: `<li>` with a TanStack `Link to="/s/$sessionId"` (`pointer-coarse:min-h-11`, `FOCUS_RING`), the label (`min-w-0 truncate text-ui`), the chip (`RunStatusChip status="working" label={t("sidebar.working")}` / `status="needs-input" label={t("sidebar.needsInput")}`), the age (`font-mono text-label text-muted tabular-nums`); a slot for the row menu (Task 23).

`ArchivedShelf.tsx`: a `Collapsible` titled with the count; on first open, `getRuntime().rpc.call("sessions.listArchived", {})`; each page appended; "Load more" with the last row's cursor; one request at a time; errors as `t(errorKey(code))` (`errorKey` from `i18n/index.ts`).

`i18n/register-sidebar.ts`: `registerCatalog({ en: sidebarEn, fr: sidebarFr });` — in `i18n/`, because two lazy chunks of two features register it (the tree here, the palette in Task 25) and a feature never imports another.

`catalog/sidebar.ts`: the keys `sidebar.filter` "Filter sessions" / "Filtrer les sessions", `sidebar.pinned` "Pinned" / "Épinglées", `sidebar.otherFolders` "Other folders" / "Autres dossiers", `sidebar.showMore` "Show 20 more" / "En afficher 20 de plus", `sidebar.older` "{count} older sessions · search with {chord}" / "{count} sessions plus anciennes · cherchez avec {chord}", `sidebar.olderNoChord` "{count} older sessions · search with the palette" / "{count} sessions plus anciennes · cherchez avec la palette", `sidebar.snoozed` "Snoozed ({count})" / "En pause ({count})", `sidebar.settled` "Settled ({count})" / "Terminées ({count})", `sidebar.archived` "Archived ({count})" / "Archivées ({count})", `sidebar.shelfMore` "+{count} more" / "+{count} de plus", `sidebar.loadMore` "Load more" / "En charger plus", `sidebar.retry` "Retry" / "Réessayer", `sidebar.empty` "No session yet. Start one from the home tab." / "Aucune session pour l'instant. Commencez-en une depuis l'onglet d'accueil.", `sidebar.noMatch` "No session matches." / "Aucune session ne correspond.", `sidebar.loading` "Loading sessions" / "Chargement des sessions", `sidebar.unreadable` "The session list could not be read. Reload the page." / "La liste des sessions n'a pas pu être lue. Rechargez la page.", `sidebar.working` "Working" / "En cours", `sidebar.needsInput` "Needs input" / "Attend une réponse", `sidebar.age.now` "now" / "maintenant", `sidebar.age.min` "{n} min" / "{n} min" (IDENTICAL_IN_FR: the SI abbreviation), `sidebar.age.h` "{n} h" / "{n} h" (identical, SI), `sidebar.age.d` "{n} d" / "{n} j", `sidebar.age.wk` "{n} wk" / "{n} sem.". The `shell.tree.*` keys move here under `sidebar.*` names; `shell.top.tree` ("Sessions") stays in `shell.ts` (the eager top bar uses it).

`TreeDrawer.tsx`: renders `<ProjectTree onPick={() => onOpenChange(false)} />` (the drawer chunk now holds the tree). `MobileShell.tsx`: the Lists section renders `<LazyPanel text={lazyText} load={loadTree} open={section === "lists"} props={{ onPick: () => setSection("work") }} onFailed={() => setSection("work")} />` with `const loadTree = () => import("../../features/projects/ProjectTree.tsx");`. Delete `SessionTree.tsx`, `session-groups.ts` and its test.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS; class coverage, literal gate and the 44-px class probe green. Record the bundle (expect a drop of about 1.4 KB).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src
git commit -m "feat(projects): the ⌘B project tree — pinned, projects in order, shelves, filter and caps — in a lazy chunk"
```

---

### Task 23: Filing sessions and projects — row and project menus, optimistic, with Undo

**Files:**
- Create: `apps/web/src/features/projects/{organise.ts,organise.test.ts,snooze.ts,snooze.test.ts,SnoozeDialog.tsx,SessionMenu.tsx,ProjectMenu.tsx,menus.test.tsx}`
- Modify: `apps/web/src/features/projects/{SessionRow.tsx,ProjectHeading.tsx}`, `apps/web/src/i18n/catalog/sidebar.ts`

**Interfaces:**
- Consumes: Task 5 `applyMark`, `markStateOf`, `MarkChange`, `MarkState`, `ProjectChange`; Task 19 `useShellStore`, `pinnedIds`; `toast`; `LazyMenu`; `errorKey`.
- Produces:
  - `marksOf(session: ShellSession): Marks`; `organise(input: { session; change: MarkChange; now: number }, deps: { rpc; store }): Promise<{ result: "ok" | "busy" | "refused" | "unknown"; code?: string; undo?: MarkState }>`; `organiseProject(input: { project; change: ProjectChange; order: ProjectSummary[] }, deps): Promise<{ result; code? }>` (`organise.ts`).
  - `snoozeTimes(now: Date): { hour: number; tomorrow: number; nextWeek: number }` (`snooze.ts`).

**Rulings (pre-dispatch):**
- M4R96: Every action is optimistic: the change shows at once through `applyMark` (the daemon's own rules), the mutation goes with a fresh `commandId`, the answer confirms; a refusal rolls back and toasts its error (`t(errorKey(code))`); `offline` (nothing sent) rolls back; `connection_lost` and `timeout` leave the change shown until the reconnect's snapshot says the truth (R105) — C §7.1 — cost if wrong: none.
- M4R97: Undo, in a toast with the 5 s action (DESIGN §9.1), follows Archive, Settle, Snooze and Unpin; it sends `restore` with the state captured before the action (`markStateOf`), as a new action (new `commandId`) — T3 "Undo restores the thread's previous state, including its pinned position" — cost if wrong: none.
- M4R98: Row menu (`LazyMenu`, `IconMore`, label "Session actions"): Pin / Unpin; Move up / Move down (pinned rows); Snooze for 1 hour / until tomorrow (9:00) / until next week (Monday 9:00) / until… (a dialog with a date and time); Wake now (snoozed); Settle / Unsettle; Archive / Unarchive (archived rows). Project menu: Rename (inline field, `data-inline-edit`, Enter saves, Escape cancels), Move up, Move down, New session here (Task 24 wires it) — flat menus (the `Menu` primitive has no submenus) — cost if wrong: menu layout rework.
- M4R99 (owner Q3 default): reordering is Move up / Move down, no drag and drop in M4 — keyboard-accessible, no new dependency, bundle — cost if wrong: drag later (T3 uses @dnd-kit).
- M4R100: Snooze presets use the device's local time: "tomorrow" is 9:00 the next day, "next week" 9:00 the next Monday (a week later when today is Monday); the custom dialog refuses a time under a minute ahead or past 366 days (the daemon checks too, M4R15) — cost if wrong: none.
- M4R101: While a change waits for its answer, every row and project menu is disabled (`pending.size > 0`, M4R83) and a polite live region says "Saving…" after 100 ms (DESIGN §7.3) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`organise.test.ts` (a fake rpc and the real store):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { organise } from "./organise.ts";

const NOW = 1_800_000_000_000;
let ids = 0;
const rpc = (call: (method: string, params: unknown) => Promise<unknown>) =>
  ({ call: vi.fn(call), newCommandId: () => `cmd-${++ids}` }) as never;
const store = () => useShellStore.getState();
const session = (id: string) => store().view.sessions.get(id);

beforeEach(() => {
  store().reset();
  store().apply(shellSnapshot([shellSession({ id: "a" }), shellSession({ id: "p1", pinRank: 1 }), shellSession({ id: "p2", pinRank: 2 })]));
});

describe("organise (M4R96)", () => {
  it("shows the change at once, sends it with a command id, and confirms it", async () => {
    let answer: (value: unknown) => void = () => {};
    const call = rpc(() => new Promise((resolve) => (answer = resolve)));
    const done = organise({ session: session("a")!, change: { kind: "archive" }, now: NOW }, { rpc: call, store: store() });
    expect(session("a")?.archivedAt).toBe(NOW);
    expect(store().view.pending.size).toBe(1);
    answer({ ok: true });
    await expect(done).resolves.toMatchObject({ result: "ok", undo: { archived: false, pinned: false } });
    expect(store().view.pending.size).toBe(0);
    expect((call as { call: ReturnType<typeof vi.fn> }).call).toHaveBeenCalledWith(
      "sessions.mark", { sessionId: "a", change: { kind: "archive" } }, { commandId: "cmd-1" });
  });

  it("moves the other pins' ranks too", async () => {
    await organise({ session: session("p2")!, change: { kind: "pin", before: "p1" }, now: NOW }, { rpc: rpc(async () => ({ ok: true })), store: store() });
    expect([session("p2")?.pinRank, session("p1")?.pinRank]).toEqual([1, 2]);
  });

  it("rolls back a refusal and says why", async () => {
    const result = await organise({ session: session("a")!, change: { kind: "snooze", until: NOW + 3_600_000 }, now: NOW }, {
      rpc: rpc(async () => { throw new RpcError("bad_request"); }),
      store: store(),
    });
    expect(result).toEqual({ result: "refused", code: "bad_request" });
    expect(session("a")?.snoozedUntil).toBeNull();
  });

  it("refuses locally what the rules refuse, without a request", async () => {
    const call = rpc(async () => ({ ok: true }));
    const result = await organise({ session: session("a")!, change: { kind: "snooze", until: NOW + 1 }, now: NOW }, { rpc: call, store: store() });
    expect(result).toEqual({ result: "refused", code: "bad_request" });
    expect((call as { call: ReturnType<typeof vi.fn> }).call).not.toHaveBeenCalled();
  });

  it("keeps the change shown when the outcome is unknown (R105)", async () => {
    const result = await organise({ session: session("a")!, change: { kind: "settle" }, now: NOW }, {
      rpc: rpc(async () => { throw new RpcError("connection_lost"); }),
      store: store(),
    });
    expect(result).toEqual({ result: "unknown", code: "connection_lost" });
    expect(session("a")?.settledAt).toBe(NOW);
  });

  it("rolls back when nothing was sent (offline)", async () => {
    await organise({ session: session("a")!, change: { kind: "settle" }, now: NOW }, { rpc: rpc(async () => { throw new RpcError("offline"); }), store: store() });
    expect(session("a")?.settledAt).toBeNull();
  });

  it("waits for one change at a time (M4R83)", async () => {
    let answer: (value: unknown) => void = () => {};
    const call = rpc(() => new Promise((resolve) => (answer = resolve)));
    const first = organise({ session: session("a")!, change: { kind: "settle" }, now: NOW }, { rpc: call, store: store() });
    await expect(organise({ session: session("p1")!, change: { kind: "unpin" }, now: NOW }, { rpc: call, store: store() })).resolves.toEqual({ result: "busy" });
    answer({ ok: true });
    await first;
  });

  it("Undo restores the place among the pins", async () => {
    const call = rpc(async () => ({ ok: true }));
    const { undo } = await organise({ session: session("p1")!, change: { kind: "archive" }, now: NOW }, { rpc: call, store: store() });
    expect(undo).toEqual({ pinned: true, pinBefore: "p2", archived: false, settled: false, snoozedUntil: null });
    await organise({ session: session("p1")!, change: { kind: "restore", state: undo! }, now: NOW + 1 }, { rpc: call, store: store() });
    expect([session("p1")?.pinRank, session("p2")?.pinRank, session("p1")?.archivedAt]).toEqual([1, 2, null]);
  });
});
```

`snooze.test.ts` (dates built from local components, so the test holds in any time zone):

```ts
it("an hour, tomorrow at 9:00 and next Monday at 9:00, in local time", () => {
  const thursday = new Date(2026, 9, 15, 16, 30); // Thursday 15 October 2026, 16:30
  expect(snoozeTimes(thursday)).toEqual({
    hour: thursday.getTime() + 3_600_000,
    tomorrow: new Date(2026, 9, 16, 9, 0).getTime(),
    nextWeek: new Date(2026, 9, 19, 9, 0).getTime(),
  });
  const monday = new Date(2026, 9, 19, 8, 0);
  expect(snoozeTimes(monday).nextWeek).toBe(new Date(2026, 9, 26, 9, 0).getTime());
});
```

`menus.test.tsx` (the tree mounted with a loaded store, a fake rpc; Radix menus opened from the keyboard as in M3's rail test):
- an active row's menu lists Pin, Snooze for 1 hour, Snooze until tomorrow, Snooze until next week, Snooze until…, Settle, Archive; a pinned row's lists Unpin, Move up (not on the first), Move down (not on the last); a snoozed row's lists Wake now; a settled row's Unsettle;
- choosing Archive moves the row to the Archived count at once and shows a toast "Archived · <label>" with "Undo"; pressing Undo sends `sessions.mark` with `{ kind: "restore", state }`;
- a refusal (`limit_reached` on Pin) shows the error toast "This list is full. Remove an entry first." and the row stays unpinned;
- while an answer is pending, the row menus are disabled and, after 100 ms (fake timers), the live region says "Saving…";
- the project menu's Rename turns the heading into a field holding the name; Enter sends `projects.update { change: { kind: "rename", name } }` and shows the new name at once; Escape restores the heading and sends nothing; an empty name is refused before sending (the field's error);
- Move up on the second project sends `{ kind: "move", before: <first project id> }`; Move down on the first sends `before` = the third project's id (or `null` when it becomes last);
- the "Snooze until…" dialog refuses a time in the past (its error line) and sends the chosen time otherwise.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/projects`
Expected: FAIL.

- [ ] **Step 3: Implement**

`organise.ts`:

```ts
import {
  applyMark,
  type MarkChange,
  markStateOf,
  type Marks,
  type MarkState,
  type ProjectChange,
  type ProjectSummary,
  type ShellSession,
} from "@pap/contracts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { pinnedIds } from "../../stores/shell-reducer.ts";
import type { useShellStore } from "../../stores/shell-store.ts";

type Store = ReturnType<typeof useShellStore.getState>;
type Outcome = { result: "ok" | "busy" | "refused" | "unknown"; code?: string; undo?: MarkState };

export const marksOf = (session: ShellSession): Marks => ({
  pinRank: session.pinRank,
  archivedAt: session.archivedAt,
  settledAt: session.settledAt,
  // Not on the wire: an automatic settle shows like a manual one; the daemon keeps the difference.
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: session.snoozedUntil,
});

const codeOf = (error: unknown): string => (error instanceof RpcError ? error.code : "internal");
const unknownOutcome = (code: string): boolean => code === "connection_lost" || code === "timeout";

/** One filing action, shown before the answer (M4R96), at most one at a time (M4R83). */
export async function organise(
  input: { readonly session: ShellSession; readonly change: MarkChange; readonly now: number },
  deps: { readonly rpc: Runtime["rpc"]; readonly store: Store },
): Promise<Outcome> {
  const view = deps.store.view;
  if (view.pending.size > 0) return { result: "busy" };
  const pins = pinnedIds(view);
  const outcome = applyMark(input.session.id, marksOf(input.session), input.change, pins, input.now);
  if (!outcome.ok) return { result: "refused", code: outcome.code };
  const undo = markStateOf(input.session.id, marksOf(input.session), pins, input.now);
  const after: ShellSession = {
    ...input.session,
    pinRank: outcome.marks.pinRank,
    archivedAt: outcome.marks.archivedAt,
    settledAt: outcome.marks.settledAt,
    snoozedUntil: outcome.marks.snoozedUntil,
  };
  // The other pins whose rank moves with this one (a pin, an unpin, an archive of a pinned session).
  const moved = (outcome.pins ?? []).flatMap((id, index) => {
    const other = view.sessions.get(id);
    return other && id !== input.session.id && other.pinRank !== index + 1 ? [{ ...other, pinRank: index + 1 }] : [];
  });
  const unpinned = outcome.pins
    ? pins.filter((id) => id !== input.session.id && !outcome.pins?.includes(id)).flatMap((id) => {
        const other = view.sessions.get(id);
        return other ? [{ ...other, pinRank: null }] : [];
      })
    : [];
  const commandId = deps.rpc.newCommandId();
  deps.store.optimistic(commandId, { sessions: [after, ...moved, ...unpinned] });
  try {
    await deps.rpc.call("sessions.mark", { sessionId: input.session.id, change: input.change }, { commandId });
    deps.store.confirm(commandId);
    return { result: "ok", undo };
  } catch (error) {
    const code = codeOf(error);
    // Sent but not answered: what happened is read back from the stream's next snapshot, never guessed (R105).
    if (unknownOutcome(code)) return { result: "unknown", code };
    deps.store.rollback(commandId);
    return { result: "refused", code };
  }
}

/** Rename or move a project, shown before the answer like a session's change. */
export async function organiseProject(
  input: { readonly project: ProjectSummary; readonly change: ProjectChange; readonly order: readonly ProjectSummary[] },
  deps: { readonly rpc: Runtime["rpc"]; readonly store: Store },
): Promise<Outcome> {
  if (deps.store.view.pending.size > 0) return { result: "busy" };
  const after: ProjectSummary =
    input.change.kind === "rename"
      ? { ...input.project, name: input.change.name.trim() }
      : { ...input.project, position: positionBefore(input.order, input.project.id, input.change.before) };
  const commandId = deps.rpc.newCommandId();
  deps.store.optimistic(commandId, { projects: [after] });
  try {
    await deps.rpc.call("projects.update", { projectId: input.project.id, change: input.change }, { commandId });
    deps.store.confirm(commandId);
    return { result: "ok" };
  } catch (error) {
    const code = codeOf(error);
    if (unknownOutcome(code)) return { result: "unknown", code };
    deps.store.rollback(commandId);
    return { result: "refused", code };
  }
}

/** The daemon's placement (M4R21) for the shown order: between the neighbours, or last + 1. */
function positionBefore(order: readonly ProjectSummary[], id: string, before: string | null): number {
  const rest = order.filter((project) => project.id !== id);
  const at = before === null ? -1 : rest.findIndex((project) => project.id === before);
  if (at === -1) return (rest.at(-1)?.position ?? 0) + 1;
  const next = rest[at] as ProjectSummary;
  const previous = rest[at - 1];
  return previous ? (previous.position + next.position) / 2 : next.position - 1;
}
```

(The browser's guess at a renumbering is not needed: the daemon publishes every position when it renumbers, and the stream's events replace the guess.)

`snooze.ts`:

```ts
const HOUR = 3_600_000;
const at9 = (day: Date): number => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0, 0).getTime();

/** The menu's snooze times in the device's local time (M4R100). */
export function snoozeTimes(now: Date): { hour: number; tomorrow: number; nextWeek: number } {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // getDay(): 0 Sunday … 6 Saturday. Days until the next Monday, a full week when today is Monday.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday);
  return { hour: now.getTime() + HOUR, tomorrow: at9(tomorrow), nextWeek: at9(monday) };
}
```

`SessionMenu.tsx`: a `LazyMenu` whose trigger is `IconButton icon={IconMore} label={t("sidebar.menu.session")}` (disabled while `pending.size > 0`), with the items of M4R98 built from the row's state; each item calls `organise` with `Date.now()`, then: `ok` with an Undo-able change → `toast({ message: t(<"sidebar.toast.archived" | "settled" | "snoozed" | "unpinned">, { title: sessionLabel(session) || t("shell.tab.session") }), action: { label: t("sidebar.undo"), altText: t("sidebar.undoAlt"), run: () => void organise({ session: <latest from the store>, change: { kind: "restore", state: undo }, now: Date.now() }, deps) } })`; `refused` → `toast({ message: t(errorKey(code)), tone: "error" })` (`errorKey` from `i18n/index.ts`: features never import each other, so not `features/sessions/failure.ts`); `busy` → nothing (the menu was disabled); `unknown` → `toast({ message: t("sidebar.unknown"), tone: "error" })`. "Snooze until…" opens `SnoozeDialog` (from `@pap/ui/overlays` inside this lazy chunk): a native `<input type="datetime-local">` with token classes beside a `TextField`-styled label, min one minute ahead, max 366 days, Snooze / Cancel (`secondary`).

`ProjectMenu.tsx`: `LazyMenu` with Rename, Move up, Move down, New session here (Task 24 passes the action; until then it is absent); Rename swaps the heading for a `TextField` inside `<div data-inline-edit>` (Escape cancels and never stops a run, M3 P3's key rule).

New `sidebar.ts` keys: `sidebar.menu.session` "Session actions" / "Actions de la session", `sidebar.menu.project` "Project actions" / "Actions du projet", `sidebar.action.pin` "Pin" / "Épingler", `sidebar.action.unpin` "Unpin" / "Désépingler", `sidebar.action.moveUp` "Move up" / "Monter", `sidebar.action.moveDown` "Move down" / "Descendre", `sidebar.action.snoozeHour` "Snooze for 1 hour" / "Mettre en pause 1 heure", `sidebar.action.snoozeTomorrow` "Snooze until tomorrow, 9:00" / "Mettre en pause jusqu'à demain, 9 h", `sidebar.action.snoozeWeek` "Snooze until next week, Monday 9:00" / "Mettre en pause jusqu'à lundi prochain, 9 h", `sidebar.action.snoozeCustom` "Snooze until…" / "Mettre en pause jusqu'à…", `sidebar.action.wake` "Wake now" / "Reprendre maintenant", `sidebar.action.settle` "Settle" / "Marquer terminée", `sidebar.action.unsettle` "Unsettle" / "Remettre en cours", `sidebar.action.archive` "Archive" / "Archiver", `sidebar.action.unarchive` "Unarchive" / "Désarchiver", `sidebar.action.rename` "Rename" / "Renommer", `sidebar.action.newHere` "New session here" / "Nouvelle session ici", `sidebar.toast.archived` "Archived · {title}" / "Archivée · {title}", `sidebar.toast.settled` "Settled · {title}" / "Marquée terminée · {title}", `sidebar.toast.snoozed` "Snoozed · {title}" / "En pause · {title}", `sidebar.toast.unpinned` "Unpinned · {title}" / "Désépinglée · {title}", `sidebar.undo` "Undo" / "Annuler", `sidebar.undoAlt` "Undo the last change" / "Annuler la dernière modification", `sidebar.unknown` "pap did not answer. The list shows what it knows once it reconnects." / "pap n'a pas répondu. La liste montrera ce qu'elle sait à la reconnexion.", `sidebar.saving` "Saving…" / "Enregistrement…", `sidebar.snooze.title` "Snooze until" / "Mettre en pause jusqu'à", `sidebar.snooze.when` "Date and time" / "Date et heure", `sidebar.snooze.submit` "Snooze" / "Mettre en pause", `sidebar.snooze.cancel` "Cancel" / "Annuler", `sidebar.snooze.tooSoon` "Pick a time at least a minute from now." / "Choisissez une heure au moins une minute plus tard.", `sidebar.snooze.tooLate` "Pick a time within a year." / "Choisissez une heure dans l'année.", `sidebar.rename.label` "Project name" / "Nom du projet", `sidebar.rename.empty` "A project needs a name." / "Un projet a besoin d'un nom.".

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS; the initial bundle unchanged (all of it lazy).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src
git commit -m "feat(projects): pin, snooze, settle and archive sessions, rename and reorder projects — optimistic, with Undo"
```

---

### Task 24: The project switcher in the top bar, the current project, and the home screen

**Files:**
- Create: `apps/web/src/stores/current-project.ts` (+ test), `apps/web/src/routes/shell/ProjectSwitcher.tsx` (+ test)
- Modify: `apps/web/src/routes/shell/{TopBar.tsx,MobileShell.tsx}`, `apps/web/src/features/sessions/SessionListScreen.tsx` (+ test), `apps/web/src/features/projects/{ProjectTree.tsx,ProjectMenu.tsx}`, `apps/web/src/i18n/catalog/shell.ts`

**Interfaces:**
- Produces: `useCurrentProject` (zustand) with `projectId: string | null`, `choose(projectId: string | null): void`, `storageRefused: boolean`; persisted per device as `pap.project.v1`.

**Rulings (pre-dispatch):**
- M4R102 (owner Q1 default): the current project is per device (like the language, R3-3); it narrows the tree (M4R93) and the home's recent list, and fills the new-session folder with the project's root while the field is untouched; "All projects" clears it; a stored id the store does not know shows "All projects" — DESIGN §8's "project ▾" before lanes exist — cost if wrong: a different meaning for the switcher.
- M4R103: The switcher's button is eager (one label and a chevron); its menu is `LazyMenu` (overlays chunk), listing "All projects" then the projects in order, at most 50, the 51st item opening the ⌘B tree — first paint shows the current project; bounded menu — cost if wrong: none.
- M4R104: Home: the create form, then "Recent" (the 10 newest active sessions of the current project, or of all), each a link labelled by `sessionLabel` with its age, then "All sessions" (opens ⌘B); on a phone, "All sessions" opens the Lists section — the home stays light: it is the first paint at `/` — cost if wrong: none.
- M4R105: `pap.project.v1` holds `{ v: 1, projectId }`; anything else is dropped; storage that throws keeps the choice for this page only and reports `storage_refused` once (M3R84's rule) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

- `current-project.test.ts`: `choose("p1")` stores `{"v":1,"projectId":"p1"}`; a fresh store reads it back; garbage, another version or an id over 128 characters reads as `null`; a throwing `setItem` keeps `p1` in memory and sets `storageRefused`.
- `ProjectSwitcher.test.tsx` (shell bed, a loaded store with projects `api` (position 1) and `web` (position 2)): the button says "All projects"; pressing it lists "All projects", "api", "web"; choosing "web" makes the button say "web" and the tree (opened with ⌘B) shows only `web`'s group and every pinned session; a stored id that is not in the store shows "All projects"; with 60 projects the menu ends with "All 60 projects in the tree" which opens the drawer.
- `SessionListScreen.test.tsx`: with the current project `web`, the folder field starts with `web`'s root and the Recent list holds only its sessions (10 at most, newest first); typing in the field then switching project leaves the typed text; "All sessions" calls `runCommand("drawer.tree.toggle")`.
- `ProjectMenu`: "New session here" chooses the project and navigates to `/`.

- [ ] **Step 2: Run them to see them fail**, then **Step 3: Implement**

`current-project.ts`:

```ts
import { create } from "zustand";

const KEY = "pap.project.v1";
const MAX_ID = 128;

function read(storage: Pick<Storage, "getItem"> | null): string | null {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? "null") as { v?: unknown; projectId?: unknown } | null;
    return value?.v === 1 && typeof value.projectId === "string" && value.projectId.length > 0 && value.projectId.length <= MAX_ID
      ? value.projectId
      : null;
  } catch {
    // A value another version or a person wrote: the default, as every device setting does (M4R105).
    return null;
  }
}

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

interface CurrentProjectState {
  readonly projectId: string | null;
  /** The last choice could not be stored: it holds for this page only. */
  readonly storageRefused: boolean;
  choose(projectId: string | null): void;
}

/** The project the switcher shows, per device (M4R102). */
export const useCurrentProject = create<CurrentProjectState>()((set) => ({
  projectId: read(storage()),
  storageRefused: false,
  choose(projectId) {
    let refused = false;
    try {
      storage()?.setItem(KEY, JSON.stringify({ v: 1, projectId }));
    } catch {
      refused = true;
    }
    set({ projectId, storageRefused: refused });
  },
}));
```

(The switcher reports `storage_refused` through `reportClientIssue` when `storageRefused` turns true — `stores/` may not import `lib/`.)

`ProjectSwitcher.tsx`: `Button variant="ghost" size="sm"` showing the current project's name (`truncate`) and `IconChevronDown`, `aria-label` "Project: {name}"; `LazyMenu` items as M4R103. `TopBar` renders it first, before the tree button (DESIGN §8 order: "project ▾ · ⌘B · … · Inbox · ⌘K"). `MobileShell`'s header gets the same switcher after the mark.

`SessionListScreen.tsx`: `cwd` starts as `""` and, while untouched (`touched` state), shows the current project's root; Recent from the store (`useShellStore`), each row a link with the label and, in muted mono under it, the folder; no age on home (`formatAge` lives in the lazy projects chunk; the tree shows ages).

New `shell.ts` keys: `shell.project.all` "All projects" / "Tous les projets", `shell.project.label` "Project: {name}" / "Projet : {name}", `shell.project.menu` "Choose a project" / "Choisir un projet", `shell.project.more` "All {count} projects in the tree" / "Les {count} projets dans l'arbre", `sessions.recent` "Recent" / "Récentes", `sessions.all` "All sessions" / "Toutes les sessions".

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS. Record the bundle (about +1 KB).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src
git commit -m "feat(projects): the top bar's project switcher, a current project per device, and a lighter home"
```

---

### Task 25: Transcript search in ⌘K (DESIGN screen 12, M3R100)

**Files:**
- Create: `apps/web/src/features/commands/palette/{transcript-search.ts,transcript-search.test.ts,snippet.ts,snippet.test.ts,TranscriptHits.tsx}`, `apps/web/src/stores/focus-entry.ts`
- Modify: `apps/web/src/features/commands/palette/{CommandPalette.tsx,CommandPalette.test.tsx}`, `apps/web/src/features/sessions/Transcript.tsx` (+ test), `apps/web/src/i18n/catalog/sidebar.ts`, `apps/web/src/i18n/lazy-catalog.test.tsx`

**Interfaces:**
- Consumes: Task 12 `search.query`, `SearchHit`, `SNIPPET_OPEN`, `SNIPPET_CLOSE`; Task 21 `sessionLabel`.
- Produces: `snippetParts(snippet: string): Array<{ text: string; hit: boolean }>`; `useTranscriptSearch(query: string): { status: "idle" | "loading" | "done" | "error"; hits: SearchHit[]; code?: string }`; `useFocusEntry` (`{ target: { sessionId; entryId } | null; ask(target); take(sessionId): string | null }`).

**Rulings (pre-dispatch):**
- M4R106: Transcript search runs when the query has at least 2 characters after trimming and does not start with `>` (actions only); 150 ms after the last keystroke; one request at a time per query generation — an older answer is dropped (R123's stale rule) — T3's "message search starts after two characters" — cost if wrong: none.
- M4R107: Hits form their own group, "Transcripts", after Sessions and before Settings, in the daemon's order (bm25), not re-ranked by the palette; each row shows the snippet with its matches marked (`<mark>` with token classes, built from the control-character markers, never HTML) and "label · age"; a `timeout` or `capacity` answer shows one muted line ("Search took too long. Try more precise words." / "Too many searches at once. Try again."), other errors "Search is not available right now." — DESIGN screen 12 — cost if wrong: none.
- M4R108: Choosing a hit opens the session; when the matched entry is among the loaded rows, the transcript scrolls to it and focuses it (`useFocusEntry`); otherwise a polite notice says "The match is in older messages. Use Load older." — no page walking in M4 (deferred) — cost if wrong: none.
- M4R109: The search code and its strings live in the palette's lazy chunk (`sidebar` catalog registered there too); nothing new is eager — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`snippet.test.ts`:

```ts
import { expect, it } from "vitest";
import { snippetParts } from "./snippet.ts";

it("splits a snippet on its markers", () => {
  expect(snippetParts("…the \u0002cafe\u0003 is \u0002open\u0003…")).toEqual([
    { text: "…the ", hit: false },
    { text: "cafe", hit: true },
    { text: " is ", hit: false },
    { text: "open", hit: true },
    { text: "…", hit: false },
  ]);
});

it("treats an unclosed mark as running to the end, a stray close as text, and drops other controls", () => {
  expect(snippetParts("a\u0002b")).toEqual([{ text: "a", hit: false }, { text: "b", hit: true }]);
  expect(snippetParts("a\u0003b")).toEqual([{ text: "ab", hit: false }]);
  expect(snippetParts("x\u0000‮y")).toEqual([{ text: "xy", hit: false }]);
  expect(snippetParts("")).toEqual([]);
});
```

`transcript-search.test.ts` (`vi.useFakeTimers()`, a fake runtime): no call for `"a"` or `"> settings"`; `"kube"` calls `search.query { q: "kube", limit: 20 }` once 150 ms after the last change (three changes within 100 ms → one call); an answer for an older query is dropped when a newer one was asked; `timeout` gives `{ status: "error", code: "timeout" }`.

`CommandPalette.test.tsx`: with the search mocked to answer two hits, typing `kube` shows a group titled "Transcripts" after "Sessions", each row with a `<mark>` around the matched word and "label · age"; the count line includes them; Enter on a hit closes the palette and navigates to `/s/<id>`; `> kube` shows no Transcripts group.

`Transcript.test.tsx`: with `useFocusEntry.getState().ask({ sessionId: "s1", entryId: "e2" })` and a view whose rows hold `e2`, the row of `e2` is scrolled into view (`scrollIntoView` spy) and focused, and the target is taken (a second render does nothing); with a target not in the rows, the polite notice "The match is in older messages. Use Load older." shows.

- [ ] **Step 2: Run them to see them fail**, then **Step 3: Implement**

`snippet.ts`:

```ts
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "@pap/contracts";

// Control and format characters other than the two markers: never shown (lint refuses control characters written in
// a regular expression, so the markers are compared as strings before this test).
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/** A snippet's text and matches (M4R107): the markers come from SQLite only; everything stays text. */
export function snippetParts(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let hit = false;
  let text = "";
  const flush = () => {
    if (text !== "") parts.push({ text, hit });
    text = "";
  };
  for (const char of snippet) {
    if (char === SNIPPET_OPEN) {
      if (!hit) {
        flush();
        hit = true;
      }
    } else if (char === SNIPPET_CLOSE) {
      if (hit) {
        flush();
        hit = false;
      }
    } else if (!INVISIBLE.test(char)) text += char;
  }
  flush();
  return parts;
}
```

`transcript-search.ts`: a hook with `useState`/`useEffect`, a `setTimeout` of 150 ms cleared on every change and on unmount, a generation counter in a ref, `getRuntime().rpc.call("search.query", { q, limit: 20 })`, errors through `RpcError.code`.

`focus-entry.ts` (stores): zustand `{ target, ask, take(sessionId) }` — `take` returns the entry id and clears it when it is for that session.

`TranscriptHits.tsx`: a `Command.Group` with `Command.Item value={\`hit:${hit.sessionId}:${hit.entryId}\`}` rows; `<mark className="rounded-sm bg-agent-tint text-fg">` for hit parts (token classes only), the detail line `font-mono text-code text-muted truncate`. `CommandPalette` renders it after the ranked groups (before Settings, by splitting the ranked groups around it), with the status lines of M4R107, and imports `../../../i18n/register-sidebar.ts` (Task 22) first. `Transcript.tsx` reads `useFocusEntry` once per loaded view and acts as M4R108.

New `sidebar.ts` keys: `search.group` "Transcripts" / "Transcriptions", `search.loading` "Searching transcripts…" / "Recherche dans les transcriptions…", `search.timeout` "Search took too long. Try more precise words." / "La recherche a pris trop de temps. Essayez des mots plus précis.", `search.busy` "Too many searches at once. Try again." / "Trop de recherches à la fois. Réessayez.", `search.failed` "Search is not available right now." / "La recherche n'est pas disponible pour le moment.", `search.detail` "{label} · {age}" / "{label} · {age}", `search.olderMatch` "The match is in older messages. Use Load older." / "Le passage est dans des messages plus anciens. Utilisez « Charger les messages précédents »." (`search.detail` goes into `IDENTICAL_IN_FR`: placeholders only).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS; `build-output.int.test.ts` keeps `cmdk-input` and the sidebar marker out of the initial assets. The initial bundle is unchanged.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src
git commit -m "feat(commands): transcript hits in ⌘K, with marked snippets, and a jump to the matching message"
```

---

### Task 26: Web carries — bind the oldest twin, hidden dialogs, the streaming row, streaming markdown, the last screen, `sendOther`

**Files:**
- Modify: `apps/web/src/stores/{session-reducer.ts,reduce-pi.ts,row-view.ts}` (+ tests), `apps/web/src/features/sessions/{transcript.vm.ts,MessageRow.tsx,SessionScreen.tsx,last-screen.ts}` (+ tests)
- Create: `apps/web/src/features/sessions/{streaming-blocks.ts,streaming-blocks.test.ts}`

**Interfaces:**
- Produces: `SessionView.partialKey: string | null`, `SessionView.staleDialogs: boolean`; `uniqueKeyOf(list: readonly MessageView[], ref: string): string` (`row-view.ts`); `splitBlocks(text: string): string[]` (`streaming-blocks.ts`).

**Rulings (pre-dispatch):**
- M4R110 (deferred #20): an entry binds the **oldest** message without an entry id that has its name (`findIndex`): Pi writes entries in the order of the messages, so the first twin of a millisecond gets the first entry — cost if wrong: none.
- M4R111 (M2 final M5): `dialog_closed` for an id the view lacks lowers `hiddenDialogs` (it was one of them); a shown dialog closing while some are hidden sets `staleDialogs`, and the screen asks a fresh snapshot once (`subscriptions.resync`), which resets it — the hidden ones then reach this client — cost if wrong: one more snapshot per closed dialog in that rare state.
- M4R112 (P3 deferred): the reply being written takes the key its final message will have (`assistant:<message_start timestamp>`, made unique against the list like `withUniqueKey`), so the row is not remounted when Pi writes it — a snapshot's partial (no timestamp) keeps `"partial"` — cost if wrong: one remount after a reconnect mid-reply (as today).
- M4R113 (P3 deferred): while a reply streams, its text renders as blocks split at blank lines outside code fences, each its own memoised `Markdown`; only the last, growing block parses again; the finished message renders whole — the cost near the 100 KB cap — cost if wrong: a list or quote spread over blank lines shows as separate blocks until the message ends.
- M4R114 (P3 leftover): `last-screen.ts` holds a `WeakRef` (Safari 14.1+), so a closed screen's subtree can be collected — cost if wrong: none.
- M4R115 (P3 leftover): `session.sendOther` does nothing while an overlay or a dialog is open (its `when`), pinned by a test like Escape's — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

- Reducer: two user messages with the same timestamp (`timestamp: 5`), then two `entry` events `u1`, `u2` → the first message has `entryId: "u1"`, the second `"u2"`.
- Reducer: a snapshot with `hiddenDialogs: 2` and one shown dialog; `dialog_closed` of an unknown id → `hiddenDialogs: 1`, `staleDialogs: false`; `dialog_closed` of the shown one → `staleDialogs: true`; the next snapshot → `staleDialogs: false`. `SessionScreen.test.tsx`: when the view becomes `staleDialogs`, `subscribe.session` is called again without `after` (one `resync`).
- Reducer: `message_start` of an assistant message with `timestamp: 7` sets `partialKey: "assistant:7"` (`"assistant:7#1"` when a message of that key exists); `message_end` adds the message under that same key and clears it. `transcript.vm`: the partial item's key is `view.partialKey ?? "partial"`. A `Transcript` render test: the `<li>` of the run holding the partial is the same DOM node after `message_end` (`isSameNode`).
- `streaming-blocks.test.ts`:

```ts
import { expect, it } from "vitest";
import { splitBlocks } from "./streaming-blocks.ts";

it("splits at blank lines outside code fences", () => {
  expect(splitBlocks("a\nb\n\nc\n\n\nd")).toEqual(["a\nb", "c", "d"]);
  expect(splitBlocks("x\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\ny")).toEqual(["x", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "y"]);
  expect(splitBlocks("open\n\n```\nnot closed\n\nstill code")).toEqual(["open", "```\nnot closed\n\nstill code"]);
  expect(splitBlocks("")).toEqual([]);
});
```

- `MessageRow.test.tsx`: with `vi.mock("@pap/ui")`'s `Markdown` replaced by a spy component, a partial item `"p1\n\np2\n\np3"` renders three blocks; re-rendering with `"p1\n\np2\n\np3 more"` renders the spy for `"p3 more"` only (the first two not again); a finished message renders one `Markdown` with the whole text.
- `last-screen.test.ts`: after the remembered screen is removed and `globalThis.gc` is not relied on — test the contract instead: `rememberScreen(el)` then `el.remove()` → `targetScreen(null)` is `null`; `rememberScreen(el)` with `el` attached → `el`.
- The `session.sendOther` tests (find them with `rg -n "sendOther" apps/web/src --glob '*.test.*'`): add "does nothing while a menu is open" (a `[role=menu]` in the document) and "while a modal dialog is open" (`[data-pap-modal][data-state=open]`) — no `sessions.prompt` call.

- [ ] **Step 2: Run them to see them fail**, then **Step 3: Implement**

- `session-reducer.ts` `bindEntry`: `messages.findIndex(...)` instead of `findLastIndex`; the doc comment says "the oldest" and why (M4R110). `dialog_closed`:

```ts
    case "dialog_closed": {
      const shown = view.dialogs.some((dialog) => dialog.id === event.id);
      if (!shown) return view.hiddenDialogs > 0 ? { ...view, hiddenDialogs: view.hiddenDialogs - 1 } : view;
      return {
        ...view,
        dialogs: view.dialogs.filter((dialog) => dialog.id !== event.id),
        staleDialogs: view.staleDialogs || view.hiddenDialogs > 0,
      };
    }
```

  `EMPTY_VIEW` gains `staleDialogs: false`, `partialKey: null`; the snapshot case resets both.
- `SessionScreen.tsx`: `useEffect(() => { if (view.staleDialogs) runtime.subscriptions.resync("session", sessionId); }, [view.staleDialogs, runtime, sessionId]);`.
- `row-view.ts`: `export function uniqueKeyOf(list: readonly MessageView[], ref: string): string` (the `keyOne` rule over the list's keys); `withUniqueKey` uses it.
- `reduce-pi.ts`: on `message_start` with an assistant message, `partialKey: uniqueKeyOf(view.messages, \`assistant:${timestamp ?? "none"}\`)`; on `message_end` of an assistant message, `partialKey: null`.
- `transcript.vm.ts`: `PartialItem.key: string`; the partial pushes `key: view.partialKey ?? "partial"`.
- `streaming-blocks.ts`:

```ts
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** A streaming reply's blocks (M4R113): split at blank lines, never inside a code fence (an unclosed one runs to the end). */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) fence = fence === null ? marker.slice(0, 3) : null;
    if (fence === null && line.trim() === "" && !marker) {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}
```

- `MessageRow.tsx`: for `item.kind === "partial"`, `splitBlocks(item.text).map((block, index) => <MarkdownBlock key={index} text={block} />)` with `const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) { return <Markdown text={text} onLoadError={markdownFailed} />; });`.
- `last-screen.ts`:

```ts
/** The session screen the focus was last inside, weakly held so a closed screen can be collected (M4R114). */
let last: WeakRef<Element> | null = null;

export function rememberScreen(screen: Element | null): void {
  last = screen ? new WeakRef(screen) : null;
}

export function targetScreen(active: Element | null): Element | null {
  const holder = active?.closest("[data-session-screen]") ?? null;
  if (holder) return holder;
  const screen = last?.deref() ?? null;
  return screen?.isConnected ? screen : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS. Mutation checks: `findLastIndex` back → the twin case fails; drop the `unknown id` branch → the hidden-count case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A apps/web/src
git commit -m "fix(sessions): bind the oldest twin, keep hidden dialogs reachable, a stable streaming row, block-wise streaming markdown"
```

---

# Phase 5 — Bundle lever, the built daemon, docs, final gates

### Task 27: M2's session-screen strings to a lazy catalog (the bundle lever, owner Q10)

M3's final review named it the biggest remaining lever (about 3 KB gzip): M2's `sessions (M2)` block of `en.ts` / `fr.ts` holds strings only the lazy session screen shows. They move to `catalog/session-screen.ts`, registered by the session chunk, like M3's Settings strings.

**Files:**
- Create: `apps/web/src/i18n/catalog/session-screen.ts`, `apps/web/src/features/sessions/register-session-catalog.ts`
- Modify: `apps/web/src/i18n/{en.ts,fr.ts,index.ts,catalog-keys.test.ts,lazy-catalog.test.tsx}`, `apps/web/src/features/sessions/SessionScreen.tsx` (imports the registration first), `apps/web/src/build-output.int.test.ts`

**Interfaces:**
- Produces: `sessionScreenEn`, `sessionScreenFr`; `MessageKey` gains `keyof typeof sessionScreenEn`.

**Rulings (pre-dispatch):**
- M4R116 (owner Q10 default: run it): a key moves only when every file that names it is in the session screen's chunk (the files `SessionScreen.tsx` imports, directly or not, inside `features/sessions/` — `SessionListScreen.tsx` and `failure.ts` are eager and stay out); every `error.*` key stays eager (`errorKey` looks keys up in the eager catalog only); the list of moved keys is computed with `rg`, written in the commit body, and pinned by `lazy-catalog.test.tsx`'s chunk-file set — mechanical, guarded by the existing test pattern — cost if wrong: a raw key on an eager screen, which the test refuses.
- M4R117: The block's delimiter comments go with it; `fr.ts` and `en.ts` keep their order otherwise — the M5 rebase sees one removed block — cost if wrong: none.

- [ ] **Step 1: List the keys**

Run: `rg -o '"(sessions|session|dialog|rules|branch|status|source|author)\.[A-Za-z0-9_.]+"' apps/web/src --glob '!**/*.test.*' --glob '!apps/web/src/i18n/**' -n`
Group the hits by file. A key goes to the lazy catalog when all its files are inside the session chunk (list that chunk's files from `SessionScreen.tsx`'s imports). Write the two lists (moved, kept) in the task report.

- [ ] **Step 2: Write the failing tests**

- `lazy-catalog.test.tsx`: a case like the Settings one for `sessionScreenEn`: every file naming one of its keys is in the explicit session-chunk set; the set's files exist.
- `catalog-keys.test.ts`: the `sessionScreen` catalog joins both disjointness lists.
- `build-output.int.test.ts`: one moved string (for example `"Load older messages"`) is absent from every initial asset and present in a lazy one.

- [ ] **Step 3: Move**

Cut the moved keys from `en.ts` / `fr.ts` into `catalog/session-screen.ts` (`sessionScreenEn`, `sessionScreenFr`); `register-session-catalog.ts` calls `registerCatalog({ en: sessionScreenEn, fr: sessionScreenFr })`; `SessionScreen.tsx` imports it before anything else; `MessageKey` gains the type-only import.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip && pnpm build && pnpm budgets && pnpm test:int apps/web`
Expected: PASS; record `bundle: <before> → <after> KB gzip` (expected about −3 KB).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src
git commit -m "perf(web): M2's session-screen strings load with the session screen, not at first paint"
```

---

### Task 28: The built daemon end to end (smoke), docs, final budgets and gates

**Files:**
- Create: `scripts/smoke-lib.ts` (pure move), `scripts/smoke-search.ts`, `docs/agents/search.md`
- Modify: `scripts/smoke-dist.ts` (helpers out; one import and one call), `docs/agents/{sessions,daemon,web}.md`, `AGENTS.md`, `budgets.json` (only if the rule moves it), `apps/web/src/build-output.int.test.ts` (nothing new unless a marker is missing)

**Interfaces:**
- Produces: `checkScannerAndSearch(ctx: { agentDir: string; cwd: string; socket: SmokeSocket }): Promise<void>` (`scripts/smoke-search.ts`, `SmokeSocket` being the helpers `smoke-lib.ts` exports for the smoke's own socket).

**Rulings (pre-dispatch):**
- M4R118: `scripts/smoke-dist.ts` (399 lines) first loses its helpers to `scripts/smoke-lib.ts` in a pure move (same output), then gains one import and one call — the M2 ledger's carry; M5 may need the same room (merge notes) — cost if wrong: none.
- M4R119: The smoke's new step proves the build: it writes a Pi session file by hand (a header and one user line, the CLI's format) under the smoke's temporary agent folder, waits up to 10 s for its `session` event on `shell`, then searches the smoke session's own marker (`pap-smoke-ok`, in the agent's reply) and expects a hit for that session — the worker thread's `.js` entry is only reachable in the build (M4R53) — cost if wrong: none.
- M4R120: Topic notes describe what the code does and what is deferred, never more (checklist): `docs/agents/search.md` ≤ 120 lines; `AGENTS.md` gains the `search` topic note and stays under 150 lines — cost if wrong: none.
- M4R121: The final initial-bundle budget follows the M3 rule, `min(ceil(measured × 1.10), 200)`; above 200 the controller asks the owner before any commit — owner R3-5 — cost if wrong: none.

- [ ] **Step 1: Split the smoke (pure move)**

Move the helpers of `scripts/smoke-dist.ts` (from `within` to the last function before the main flow, and the socket helpers) to `scripts/smoke-lib.ts`, exported; `smoke-dist.ts` imports them. Run: `pnpm build && pnpm smoke` — the same lines as before.

- [ ] **Step 2: Add the scanner and search step**

`scripts/smoke-search.ts` exports `checkScannerAndSearch`; `smoke-dist.ts` calls it after the agent's reply has settled and before the SIGTERM step, printing `smoke: a CLI session reached the sidebar; search found the smoke session`. Run: `pnpm build && pnpm smoke` — exit 0 with the new line.

- [ ] **Step 3: Write the topic notes**

`docs/agents/search.md`: the scanner (root and folders watched, the agent folder until `sessions/` exists, debounce 250 ms, reconcile 60 s, links never followed, FIFOs never opened, the cutoff and which sessions it adopts — pap's, the CLI's, pi-web's — one file per step of 4 MiB, the 4 M-character cap per file, the log lines and their rate), `search.db` (ADR 0013: a cache, its tables, rebuilt on a version bump or damage, 0600, holds message text, safe to delete), the worker thread (2 s, 4 in flight, 3 starts a minute, 5 idle minutes), queries (tokens quoted, prefix of the last, best row per session, snippets with control markers), the two budgets with the measured numbers of Task 17, and the deferred items (custom Pi session folders, tool output and thinking not indexed, older-hit jumping, `pap backup` leaving the index out in M6). `sessions.md`: marks and their rules (`applyMark` in contracts), the `shell` stream (key = caller, snapshot bounds, events, the publisher), the 3-day rule and the wake timer, the scan port's claim order. `daemon.md`: the `projects` and `search` modules, `ownerId` (the oldest user), the search module's start after listen and its stop before the database. `web.md`: the shell store and its optimistic rule (one change at a time, rollback by identity, snapshot clears), `features/projects`, the switcher's current project, ⌘K transcript hits, the measured bundle. `AGENTS.md`: the topic-notes line gains `search`.

- [ ] **Step 4: Measure and set the budget**

Run: `pnpm build && pnpm budgets`. Set `initialBundleGzipKb` by M4R121 (it stays 200 unless the measurement says otherwise); record the measured number and the lazy chunks of M4 (`ProjectTree`, palette) in `docs/agents/web.md`.

- [ ] **Step 5: Run every gate (the M4 exit)**

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke && pnpm budgets
```

Expected: all PASS, with the two measurements of Task 17 printed by `pnpm test:int`.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add scripts docs AGENTS.md budgets.json apps/web/src/build-output.int.test.ts
git commit -m "test(smoke): the built daemon adopts a CLI session and searches it; M4 topic notes and final budgets"
```

---

# Model table

The owner's cost rules (decision 52, S3): Haiku only for mechanical transcription, Sonnet by default, an Opus reviewer for security-critical or concurrency-heavy tasks, an Opus final whole-branch review. A task still failing after three fix rounds may go to an Opus implementer for rounds 4–5 (owner T1). Any other upgrade needs the owner's approval first.

| Task | Implementer | Reviewer | Why |
|---|---|---|---|
| 1 Shared text helpers | **Haiku** | Sonnet | fully prescribed refactor, tests given |
| 2 Snapshot fitting | Sonnet | Sonnet | |
| 3 cwd in the snapshot | Sonnet | Sonnet | |
| 4 Worker-side carries | Sonnet | Sonnet | |
| 5 Contracts and mark rules | Sonnet | Sonnet | the rules are pinned by tests |
| 6 Projects module | Sonnet | Sonnet | |
| 7 Marks columns, store, projects of sessions | Sonnet | Sonnet | a pure move first, then additive |
| 8 The `shell` stream | Sonnet | **Opus** | who receives which sessions (the key is the caller), frame bounds at 10 000 sessions, event order and coalescing |
| 9 `sessions.mark` | Sonnet | Sonnet | |
| 10 Settle and snooze over time | Sonnet | Sonnet | fake-clock tests prescribed |
| 11 Search index and query builder | Sonnet | Sonnet | FTS syntax safety pinned against a real FTS5 table |
| 12 Worker thread and `search.query` | Sonnet | **Opus** | thread lifecycle: deadlines vs death, stale answers, crash loops |
| 13 Reading Pi files | Sonnet | Sonnet | code prescribed; its use is reviewed in 15 |
| 14 Adoption (scan port) | Sonnet | **Opus** | session identity and ownership: one session per Pi file against live workers, drafts and copies |
| 15 Scanner, one file | Sonnet | **Opus** | untrusted files on disk (links, FIFOs, rewrites, huge files), cursor consistency |
| 16 Scanner engine | Sonnet | **Opus** | watchers, timers, queue and stop running concurrently |
| 17 Exit criteria | Sonnet | Sonnet | |
| 18 Runtime streams | Sonnet | Sonnet | the generation rules keep their tests |
| 19 Shell store | Sonnet | **Opus** | optimistic writes racing the stream (Review Focus 4) |
| 20 One source for the list | Sonnet | Sonnet | |
| 21 Labels and tabs | Sonnet | Sonnet | |
| 22 Project tree | Sonnet | Sonnet | |
| 23 Menus, optimistic, Undo | Sonnet | Sonnet | the rules come from Tasks 5 and 19 |
| 24 Switcher and home | Sonnet | Sonnet | |
| 25 Search in ⌘K | Sonnet | Sonnet | snippet safety pinned by tests |
| 26 Web carries | Sonnet | Sonnet | |
| 27 Strings lever | **Haiku** | Sonnet | mechanical move guarded by the lazy-catalog test |
| 28 Smoke, docs, gates | Sonnet | Sonnet | |
| Final whole-branch review | — | **Opus** | owner rule |

Summary: 28 tasks — 2 Haiku and 26 Sonnet implementers; reviewers Sonnet except Tasks 8, 12, 14, 15, 16 and 19 (Opus) and the final review (Opus).

# ETA

Observed in M2/M3: about 1–1.5 h per task with review and fix rounds, security tasks longer. Per task here: the small carries (1, 3, 4, 21, 27) about 0.8–1 h; the heavy ones (7, 8, 12, 14, 15, 16, 19, 22, 23) 1.6–1.9 h; the rest 1.1–1.5 h — about 38.5 h of implementation and task review; the six Opus reviews add about 3 h; the final review and its fixes about 4 h. **≈ 45 h of agent time (range 40–52 h).** If M4 merges second (Q11), its rebase on M5 (migrations re-stamped, `auth` and `SessionRules` hunks, smoke split, en/fr block) adds about 2 h. Run beside M5, the calendar time is set by the slower milestone.

# Open questions for the owner

Each has a default (what the plan does if the owner says nothing) and a recommendation.

| # | Question | Default | Recommendation |
|---|---|---|---|
| Q1 | **What does the top bar's project switcher do** before lanes exist? (a) it narrows the ⌘B tree and the home's recent list to the project, fills the new-session folder with its root, pinned sessions stay visible; (b) it only scrolls the tree to the project; (c) no switcher until lanes (M9). | (a) | (a): DESIGN §8 puts it in the top bar; narrowing is what a cockpit's context means, and pins stay global. |
| Q2 | **Auto-settle**: (a) settle sessions idle 3 days (not pinned, snoozed, archived or running), no setting in M4; (b) manual settle only; (c) (a) plus a Settings field for the delay. | (a) | (a): T3's default; activity brings a session back; the setting can come with Settings work later. |
| Q3 | **Reordering pins and projects**: (a) Move up / Move down in the menus (keyboard-accessible, no dependency); (b) drag and drop now (a new dependency or hand-written pointer code, more bundle in the lazy chunk). | (a) | (a) in M4, drag later if the owner misses it on the preview. |
| Q4 | **Where the search index lives** (ADR 0013): (a) a separate cache file `$PAP_HOME/search.db`, rebuilt from Pi's files when its version changes or it is damaged; (b) a `session_search` table in `state.db`, as spec C §3.2 lists. | (a) | (a): no migrations for a cache, a small `state.db` and backups, safe to delete. |
| Q5 | **What search indexes**: (a) the person's messages and the agent's text; (b) also tool output and thinking. | (a) | (a): tool output is large, noisy and the likeliest place for secrets; (b) roughly triples the index. |
| Q6 | **Budgets** (measured headless, `budgets.json`): search p95 ≤ **200 ms** over 10 000 sessions × 20 messages; a CLI session on the sidebar stream ≤ **3 s** after Pi writes it (fs watch), 60 s at worst through the reconcile. | as stated | as stated; the measured numbers go into the question page after Task 17 if they come close. |
| Q7 | **Which Pi sessions appear.** Spec D: every Pi session created after the install, from pap or the `pi` CLI. The preview's real `~/.pap` was installed 2026-10-11: every Pi session since then appears in the sidebar, those pi-web created included (they are Pi files too). (a) keep the spec; (b) count only sessions created after the M4 upgrade on existing installs. | (a) | (a): spec D's rule; pi-web's sessions since the install are real work, and the sidebar can archive what is not wanted. |
| Q8 | **Transcript virtualisation** (decision 48: "M4 or M13"): (a) M13; (b) M4 (one more task; the session screen is a lazy chunk, so no bundle effect; the daemon-side memoisation is done in Task 4 either way). | (a) | (a): the transcript is bounded (75 rows plus the pages asked for); M4 is already large. |
| Q9 | **The label of an unnamed session**: (a) its first message's start (cleaned, 120 characters), else its folder — the same in tabs, tree, palette and top bar; (b) its folder everywhere. | (a) | (a): a project's sessions all share a folder, so (b) makes the tree unreadable. |
| Q10 | **The bundle lever** (Task 27): move M2's session-screen strings to a lazy catalog now (about −3 KB, leaving room for M5 and later milestones; one removed block in `en.ts` / `fr.ts` that M5's rebase meets). (a) run it; (b) skip it unless a measurement crosses 197 KB. | (a) | (a): M4 alone is estimated near 196.6 KB without it; M5 adds eager contract schemas too. |
| Q11 | **Merge order** of M4 and M5. (a) M5 first, M4 second; (b) M4 first; (c) whichever is ready first. | (a) | (a): M5 is the security milestone M6 waits for; M4's rebase surface on M5 is small and known (auth `ownerId`, `SessionRules`, smoke split, migrations re-stamp); M5 rebasing on M4 would meet M4's large `features/sessions` and contracts changes. |
| Q12 | **Owner of adopted sessions** once M5 lets more users exist (`pap user add`): (a) the instance owner, the oldest user; (b) no adoption until one owner is designated. | (a) | (a) for v1 (decision 1: one owner); M5's plan fix may name the "instance owner" explicitly, and M4 then reads that. |

# Exit criteria (roadmap M4, headless)

Checked without a browser, on this host and in CI's existing jobs:
- **A session created by the `pi` CLI after install appears within seconds:** `apps/daemon/src/modules/search/scanner.exit.int.test.ts` — a session written by Pi's own `SessionManager` under the daemon's agent folder reaches a subscriber of the `shell` stream within `budgets.scannerLatencyMs` (3 000 ms; the measured value is printed), is found by `search.query`, and a session dated before the install never appears. `pnpm smoke` repeats it on the built daemon.
- **Search over 10 000 sessions answers within its budget:** `apps/daemon/src/modules/search/search.budget.int.test.ts` — p95 of 50 queries through the real worker thread over 10 000 sessions × 20 rows ≤ `budgets.searchP95Ms` (200 ms; printed).
- D02: projects, order, pins, archive with Undo, settle and snooze are SQLite rows written through `sessions.mark` / `projects.update` with optimistic writes in the browser — `marks.test.ts`, `service.marks.test.ts`, `organiser.test.ts`, `shell-reducer.test.ts`, `organise.test.ts`, `menus.test.tsx`, `sessions.marks.int.test.ts`.
- Frames: the `shell` snapshot of 10 000 sessions stays under `PAGE_BYTES` (`shell.test.ts`); `sessions.list` is fitted.
- The carries, each pinned by its named test (Tasks 1–4, 18, 21, 26).
- `pnpm lint`, `format:check`, `typecheck`, `knip`, `test:unit`, `test:int`, `build`, `smoke`, `budgets` (initial ≤ 200 KB gzip) all green; `scripts/ci-config.test.ts` unchanged.

Not checked in M4 (decision 42; the owner checks by hand on the preview): real browsers (Safari focus and IME in the rename field, touch targets measured, drawer and sheet layouts), the inotify behaviour of other file systems (network mounts).

# Coverage map

| Requirement | Task |
|---|---|
| D02 project groups and order (projects as git roots, names, order) | 6, 7, 8, 22, 23 |
| D02 pins, archive with Undo, as SQLite rows | 5, 7, 9, 23 |
| D02 optimistic writes that roll back (C §7.1) | 19, 23 |
| Session scanner: fs watch + periodic reconcile (spec C §3.3) | 16 |
| Scanner: byte offsets, complete lines, rewrite detection | 11, 13, 15 |
| Scanner: cutoff = install timestamp, CLI sessions included (spec D rule 3) | 15, 14, 17 |
| One pap session per Pi file (identity C §3.3) | 14 |
| FTS5 search behind Cmd+K (S3, DESIGN screen 12) | 11, 12, 25 |
| FTS queries in a worker thread (C §3.2) | 12 |
| Sessions+ settle / snooze (decision 12) | 5, 9, 10, 23 |
| `shell` stream, sidebar summaries (C §4.3) | 8, 18, 19 |
| Exit: CLI session within seconds; search within budget (headless) | 17, 28 |
| Carry: one source of the session list (R125 second stream) | 18, 19, 20 |
| Carry: cwd in the snapshot | 3 |
| Carry: unnamed sessions | 21 |
| Carry: large dialogs empty the rows; "Load older" skips | 2 |
| Carry: `hiddenDialogs` stale | 26 |
| Carry: duplicated helpers (`cutUnits` for M6) | 1 |
| Carry: same-ms twins bind swapped ids | 26 |
| Carry: memoise `indexEntries` / `lastEntryId` | 4 |
| Carry: stale widget handle | 4 |
| Carry: markdown re-parse per delta | 26 |
| Carry: streaming row remount | 26 |
| Carry: `last-screen.ts`, `sendOther` test | 26 |
| M3 triage #63, #184 (tabs) | 21 |
| M3R90 switcher, M3R96 tree by project, M3R98 caps + ⌘K, M3R100 FTS hits | 24, 22, 22, 25 |
| Bundle ≤ 200 KB gzip, measured per task | every web task, 27, 28 |
| T3 and Orca patterns cited | 6 (T3 sidebar), 9/23 (T3 Undo), 11 (Orca cache, quoting), 12 (Orca out-of-main search, T3 error text), 25 (T3 two characters) |
| Deferred items stated | header "What this plan explicitly defers" |

# Execution handoff

Plan saved to `docs/plans/2026-10-12-m4-projects-search.md` on branch `feat/m4-projects` (worktree `.worktrees/feat-m4`). The method is fixed by decision 52 (subagent-driven, beside M5): red-team → owner question page (Q1–Q12, model table, ETA) → plan fix (which appends both milestones' owner decisions to `docs/research/decisions-log.md`) → dispatch in task order 1 → 28 → Opus final review. Rulings M4R1–M4R121 are decided; only items a task marks "discovered during implementation" stay open. The controller keeps the bundle rule (each eager web task records its measurement) and the budget rule (a measurement above `searchP95Ms` or `scannerLatencyMs` stops and asks the owner).

# Merge order and conflict notes

**Proposed order: M5 first, M4 second (Q11).** M4 then rebases once on a `main` holding M5 and resolves the shared hunks below in one commit, re-runs every gate, and opens its PR. If the owner picks the other order, M5 takes the same table from its side.

**Migrations.** M4 adds `apps/daemon/src/modules/sessions/migrations/202610121500_session_marks.sql` and `apps/daemon/src/modules/projects/migrations/202610121510_projects.sql`. The branch merging second re-stamps its migrations after the newest stamp on `main` during its rebase (brief, M3R51): never applied on `main`, so a rename is safe; a dev or preview home that applied a stamp that later moves needs a reset (`database_newer_than_binary` otherwise, M3 merge note). The preview's real `~/.pap` only ever runs `main`'s builds.

| File | M4 | M5 (expected) | Resolution |
|---|---|---|---|
| `packages/contracts/src/methods.ts` | `import { shellMethods }`, `...shellMethods,`; `sessions.list` result gains `truncated?` | its methods (tokens, devices, rules, audit) | union; keep the catalogue's spreads in order |
| `packages/contracts/src/methods.test.ts` | `projects.update`, `sessions.mark` in the sorted mutation list | its mutations | union, sorted |
| `packages/contracts/src/index.ts` | `marks.ts`, `shell.ts` exports | its files | union |
| `packages/contracts/src/errors.ts` (+ test) | `limit_reached` | maybe new codes | union of codes and messages |
| `packages/contracts/src/streams.ts` | `STREAMS` + `"shell"`; snapshot `cwd` | maybe an approval-mode field in the snapshot | union; re-run `streams.test.ts` |
| `packages/contracts/src/permissions.ts` | none | new domains (`audit`?) | M5's |
| `apps/daemon/src/daemon.ts` | projects and search modules, `PROJECTS_MIGRATIONS`, `installedAt`, `ownerId`, `search.start()`, the search closer | audit module, token auth, ordered dispatch wiring | keep both; re-run `pnpm test:int apps/daemon/src/daemon*.int.test.ts` |
| `apps/daemon/src/modules/auth/{index,store}.ts` | `ownerId()` / `firstUserId()` (M4R61) | users, tokens, devices, passkeys | keep M5's structure, re-add the two small functions; if M5 defines an instance owner, `ownerId` reads it |
| `apps/daemon/src/modules/sessions/**` | marks, shell, scan port, `service-launch.ts` move, carries | approval modes per session (`service.ts`, `rpc.ts`, `index.ts`) | M4 moved `launch` out of `service.ts` (Task 7): re-apply M5's hunks in their new home; M4's handlers live in `shell-rpc.ts` |
| `apps/web/src/features/sessions/{AlwaysRules.tsx,AlwaysRules.test.tsx}` | `SessionRules({ sessionId, cwd })`, no `sessions.list` | always-rule management (may replace the disclosure) | if M5 replaced the disclosure, keep M5's and pass it `view.cwd` |
| `apps/web/src/features/sessions/SessionScreen.tsx` | `cwd` to the rules, `staleDialogs` resync, the lazy catalog registration (Task 27) | approval-mode control in the header | union |
| `apps/web/src/i18n/{en,fr}.ts` | Task 27 removes the `sessions (M2)` block | maybe new eager `error.*` keys | take M5's additions, keep the block removed; `catalog-keys.test.ts` proves no key is lost or doubled |
| `apps/web/src/i18n/{index.ts,catalog-keys.test.ts,lazy-catalog.test.tsx}` | `sidebar` and `session-screen` catalogs | its lazy Settings catalog(s) (`settings-screen.ts` is at 382 lines: M5 splits it) | union of `MessageKey` members and of the lists |
| `budgets.json`, `scripts/check-budgets.ts` (+ test) | `searchP95Ms`, `scannerLatencyMs` | maybe its own | union; `initialBundleGzipKb` by the rule on the merged build |
| `apps/web/src/build-output.int.test.ts` | lazy markers for the tree, the sidebar strings, the session strings | lazy markers for its Settings sections | union of cases |
| `scripts/smoke-dist.ts` | split into `smoke-lib.ts` + one call of `smoke-search.ts` | maybe policy or token steps (the file is at 399 lines) | whoever merges second takes the other's split and re-applies its own lines on top |
| `knip.json` | daemon entry `src/modules/search/search-thread.ts` | maybe entries | union |
| `AGENTS.md`, `docs/agents/{daemon,sessions,web}.md` | topic note `search`, module lines | topic notes `audit`, auth changes | union |
| `docs/research/decisions-log.md` | M4's plan fix appends both milestones' owner decisions | none (brief) | M4's |
| ADRs | 0013 | 0020+ | no clash |

**Checks after the rebase:** `pnpm install && pnpm build && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm smoke && pnpm budgets`; then a manual look at `daemon.ts` (one composition, every module once), `SessionRules`, and the merged initial bundle (both milestones' eager schemas together).
