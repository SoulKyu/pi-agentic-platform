# pap M8: files, git and terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-13):** fixed after the Opus red-team (`.superpowers/redteam-m8.md`: 12 Important, 29 Minor, all applied or ruled), the M7 ⇄ M8 cross-plan agreements 1–24 with their owner amendments (`.superpowers/m7-m8-cross-plan-agreements.md`) and the owner's answers of 2026-10-13 (`.superpowers/owner-decisions-2026-10-13-m7m8.md`, rulings M8R88–M8R100). Ready for subagent-driven execution, then the Opus final review. **25 tasks** (Task 3 → 3a/3b, Task 6 → 6a/6b, Task 10 → 10a/10b), rulings M8R1–M8R120, all decided before dispatch except where a line says only implementation can tell. The security code blocks changed by the fix (boundary, deny set, checked open and write, kill ladder, image header check, prompt FIFO, disposition) were run in a scratch copy on Node 24.14.1, git 2.53.0, dash, bash and zsh before they were written here.

**Goal:** From any session, the owner browses the session's project in an explorer, views and edits files (CodeMirror 6, lazy), sees git status pushed as a stream and per-file diffs (the Review surface), drops or attaches files and images to a prompt, types `@` to mention a file, and opens terminals (node-pty, xterm + WebGL, lazy) that live in the daemon, replay their scrollback, accept several browsers at once and survive a browser reconnect, all behind one path boundary that applies M5's pap-home and protected-path rules to every file route, keeps Pi's configuration to Settings (M7, agreement 6) and never lets an API token make a change that runs code later (agreement 5).

**Architecture:** Three new daemon modules mirror spec C §1.1: `files` (listing, reading, searching, writing, the raw file route, uploads and per-session attachment claims), `vcs` (git status per repository root as the `vcs` stream, per-file diffs with M9-ready sides) and `terminal` (PTY registry, scrollback ring, multi-client attach, ack-based flow control, the `terminal` list stream). Shared security code lives in the kernel: `kernel/fs/` (the path boundary with its owner, confirm, step-up and token rules; a deny set of pap's and Pi's private inodes; an open and a write re-judged on the descriptor), `kernel/git/` (the one way to run git: fixed flags, scrubbed environment, a discovery ceiling, bounded output and concurrency) and `kernel/pty/` (node-pty spawn arguments, shell environment, scope wrapping, a kill ladder that reaches the shell's whole session). Terminal bytes travel as binary WebSocket frames (16-byte header, Orca's layout) through a per-connection binary channel in `kernel/ws`, committed after the RPC answer like subscriptions; the codec lives in `@pap/contracts` so the daemon and the web share one implementation. The web adds three lazy panes (`files`, `changes`, `terminal`), a Chat / Review / Term switch on phones, split buttons on desktop, two lazy `@pap/ui` subpaths (`./code`: CodeMirror editor and the S5 DiffView; `./terminal`: the xterm surface) and composer additions (mentions, attachments) mounted by one line each. Images reach Pi as `prompt.images`, read, size-checked from their header and resized by the worker from pap's attachment folder, in arrival order (a per-worker prompt queue).

**Tech Stack:** as M5 (Node 24, pnpm, TypeScript 6.0.3 strict and erasable-only, zod 4.6.5, Hono, `ws`, `node:sqlite`, Pi SDK 1.1.0, React 19 + Vite + React Compiler, TanStack Router, zustand, Tailwind 4, Vitest + happy-dom). New dependencies, every version older than `minimumReleaseAge` (3 days, cutoff 2026-10-10), exact pins, all MIT:

| Package | Version | Published | Where | Why |
|---|---|---|---|---|
| `node-pty` | 1.1.0 | 2025-12-22 | `apps/daemon` | PTYs (spec C §1.1); no Linux prebuild, so it builds with node-gyp: joins `onlyBuiltDependencies` |
| `@xterm/xterm` | 6.0.0 | 2025-12-22 | `packages/ui` | terminal renderer (spec C §7.2); 88 KB gzip, lazy |
| `@xterm/addon-webgl` | 0.19.0 | 2025-12-22 | `packages/ui` | WebGL renderer (roadmap D06); 36 KB gzip, lazy, falls back to the DOM renderer |
| `@xterm/addon-fit` | 0.11.0 | 2025-12-22 | `packages/ui` | fit to the pane; 1 KB |
| `@codemirror/state` / `view` / `commands` / `search` / `language` | 6.7.6 / 6.43.14 / 6.11.1 / 6.7.2 / 6.13.1 | 2026-09-22 … 2026-10-07 | `packages/ui` | editor (spec A §5.2, C §7.2) |
| `@codemirror/merge` | 6.12.2 | 2026-06-09 | `packages/ui` | DiffView (S5 decision, R50) |
| `@lezer/highlight` | 1.2.5 | 2026-09-28 | `packages/ui` | token-based highlight style |
| `@codemirror/lang-javascript` / `lang-json` / `lang-markdown` / `lang-python` / `lang-css` / `lang-html` / `lang-yaml` | 6.2.5 / 6.0.2 / 6.5.2 / 6.2.1 / 6.3.1 / 6.4.12 / 6.1.3 | 2022-10 … 2026-08 | `packages/ui` | languages, each its own lazy chunk |
| `@codemirror/legacy-modes` | 6.5.5 | 2026-10-07 | `packages/ui` | shell, TOML, Dockerfile, Go, Rust as stream modes, each lazy |

**Spec:** `docs/specs/2026-10-10-C-architecture.md` §1.1 (PTY children, git via execFile), §1.2 (`attachments/`), §1.4, §4.1, §4.2 (binary frames with acks), §4.3 (`vcs{cwd}`, `terminal` streams), §4.5 (`POST /upload`, `GET /files/*`), §7.1–7.4 (lazy editor, terminal, diff), §8.1 (path traversal on `/files`), §8.2 (native-build allowlist); `docs/specs/2026-10-10-A-product-scope.md` §5.1 (D04, D05, D06), §5.2 (file editing), §6 (no PTY survives a daemon restart); `docs/plans/roadmap.md` (M8); `DESIGN.md` §2 (colour = role), §7.2 (nothing repaints continuously), §7.3, §8 (panes, phone switch), §9.1, §9.2 (DiffView, ANSI mapping), §10 ("files, terminal" follow the components), §11, §12; `docs/spikes/s5.md` (CodeMirror merge); `docs/agents/{daemon,policy,auth,sessions,web}.md`; ADRs 0002, 0003, 0004, 0006, 0021, 0022. References read for behaviour, never copied: pi-web `lib/{file-access,path-security,terminal-manager,git-changes}.ts`, `app/api/files/[...path]/route.ts`, `docs/agents/files-and-access.md` (read only); T3 Code `docs/internals/terminal-runtime.md` (server scrollback, replay protections), `apps/server/src/orchestration-v2/AttachmentClaims.ts` (claims copy, never move), `apps/server/src/vcs/VcsStatusBroadcaster.ts` (status pushed after turns, not on every file event), `apps/web/src/components/files/fileTreeDragMention.ts` (tree → composer drag); Orca `src/shared/terminal-stream-protocol.ts` (16-byte header, ack opcode) (`/home/ubuntu/Workspace/soulkyu/_refs/{t3code,orca}`, untrusted, read only).

## Carried items and backlog rulings absorbed

| Item | What M8 does | Task |
|---|---|---|
| M3R102: the Chat / Review / Term switch is absent until M8/M9 | Phones get the segmented switch (Chat = the session, Review = the changes pane of its project, Term = its terminal); desktop gets split buttons in the session header | 15, 19, 20 |
| Brief: `/files` boundaries (M5 protected paths and pap-home rules on every file route) | One boundary (`kernel/fs/boundary.ts`) behind every route that takes a path: RPC, raw route, upload, attachment claim, terminal cwd, vcs root and blob sides. `$PAP_HOME` refused whole; Pi's `auth.json`, `models.json`, `mcp.json`, `trust.json`, `settings.json` and `sessions/` refused (Settings is their editor, agreement 6); M5's protected names and home's dot-entries (when a project is the home folder) need a confirmation to be written, Pi's folders a confirmation and a step-up; tokens never write any of them (agreement 5). The open re-judges the descriptor and refuses pap's and Pi's private inodes (hard links, swapped folders) | 3a, 3b, 5, 6a, 6b, 7, 10b, 13 |
| Brief: node-pty in the native-build allowlist, `minimumReleaseAge` kept | `onlyBuiltDependencies: [node-pty]`; versions above all ≥ 3 days old; no bypass | 10a |
| C §2.5 "the daemon environment minus `PAP_*` and platform secrets" | The shared rule of `kernel/supervisor/env.ts` names the platform secrets: `PAP_*`, `NODE_OPTIONS` and the service manager's variables (`NOTIFY_SOCKET`, `LISTEN_*`, `CREDENTIALS_DIRECTORY`, …); workers, M7's helpers and PTYs use it (agreement 14) | 10b |
| R78 (reserved prefixes `/files`, `/upload` answer 404 JSON when unmatched) | The new routes live under those prefixes; the 404 rule stays and is tested again | 6a, 7, 13 |
| R50 / S5: DiffView is CodeMirror merge | `@pap/ui/code` ships `DiffView` on `unifiedMergeView`, read-only in M8; M9 adds comments and Seen | 16, 19 |
| M5 exit table: "path traversal on static serving (and `/files` from M8)" | `security/files-traversal.int.test.ts` | 13 |
| R97 (narrow pap-home protection when agent homes and worktrees land) | Not narrowed in M8 (nothing of the owner's lives there yet); the boundary has one `papHomeOpen` list that M9 fills with `worktrees` | 3a |
| M5 final review M5 (token cells no method uses) | M8 adds `files:admin`, `vcs:operate`, `vcs:admin` cells no method uses; M7R124's filter ("only permissions some method declares", agreement 4) hides them when M7 merges; until then they grant nothing (M8R6) | 1 (dependency stated) |
| Decision 75 Q8: flat 300 KB initial ceiling, lazy stays the rule | Editor, terminal, diff and every M8 screen lazy; estimated +4.5 KB initial (§ Bundle) | all web tasks, 22 |

## Explicitly deferred

- **PTYs surviving a daemon restart** (spec A §6 non-goal). A restart ends every terminal; the tab says so.
- **Server-side terminal snapshots** (`@xterm/headless` + serialize): replay is the raw byte ring; full-screen apps redraw on their next output or a resize. Revisit if the owner sees broken screens after a reconnect (M13).
- **Lane review** (Seen, line comments, turn and branch diffs, checkpoints, restore): M9. M8 ships the diff sides M9 needs (`DiffSide` with a `commit` oid) and a read-only DiffView.
- **tiptap composer and chips**: `@` mentions are plain text; no tiptap in this wave, revisit at M11 (owner c2, M8R89; ADR 0030).
- **Bearer tokens on the HTTP file routes** (`GET`/`PUT /files/raw`, `POST /upload`): cookie only, like the export route; tokens reach files over RPC.
- **Attachment retention**: claimed files stay under `$PAP_HOME/attachments/<session>/` until M10's outbox `attachment.cleanup`; the boot line logs the folder's size.
- **Explorer mutations** (new file or folder, rename, delete), **clickable file paths in the transcript**, **reading session-mentioned files outside the project**: deferred (M9's review or M13); **"open in the OS file manager"**: dropped (owner f7, M8R97).
- **CSV/TSV table, PDF, docx, audio and video previews**: download only (owner f4, M8R94).
- **Linked folders that point outside the project** ("Allow browsing"): listed with a lock, not browsable (owner f5, M8R95).
- **Audit rows for terminals and file writes**: daemon log lines only (owner f6, M8R96).
- **Editing Pi's own configuration in the explorer** (`<agentDir>/{auth,models,mcp,trust,settings}.json`): never; Settings is its editor (M7, agreement 6, owner f10).
- **A per-terminal memory limit** (`PAP_TERMINAL_MEMORY_MAX_MB`): not in M8; terminals share the workers' `MemoryMax` and `TasksMax`, said in Q2's answer text and `terminal.md` (RT-38).
- **Browser e2e** (decision 42): M13. Web is pinned with happy-dom tests; the owner checks real browsers on the preview (§ Owner checks).

## Global Constraints

Copied from the specs and binding rulings (source in brackets). Every task implicitly includes them.

- Node 24, engines `>=24.14 <25`; "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3, R44]
- "400 lines per file at most. No baseline, no exceptions." [C §1.4.2] Tests included. The only accepted directive is `eslint-disable-next-line <rule> -- <reason>`; no block or `-line` form, no inline config. Splits are named in each task; `apps/daemon/src/daemon.ts` (318 lines) grows by at most 10 lines on this branch and stays ≤ 400 after both merges (M8R28, agreements 9 and 24), `modules/sessions/live-session.ts` (387) by at most 3 (agreement 13), `kernel/ws/ws-server.int.test.ts` (385) and web `runtime/subscriptions.test.ts` (344) are frozen (new cases in new files: `subscriptions.m8.test.ts`, agreement 11).
- "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1] Production code never imports a `testing/` file. Web `features/<x>` imports only its own domain, `stores`, `runtime`, `lib`, `i18n`, `@pap/ui` and contracts; features never import each other (drag and drop between the explorer and the composer goes through a `DataTransfer` type, never an import, M8R77).
- "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3] An HTTP route does the same: authenticate, decode, call the service, map the error.
- "Every RPC method declares a permission in `contracts`." [C §1.4.4] `idempotent: true` = safe to repeat, no `commandId`; `idempotent: false` = mutation, `commandId` required, receipts apply; a mutation's `timeout` means "outcome unknown" and is never retried [R65b, R105].
- Method catalogue: `packages/contracts/src/methods.ts` only spreads per-domain lists. M8's methods live in `files.ts`, `vcs.ts`, `terminal.ts`: one import and one spread line each, never an inline `defineMethod` (the one inline edit is `sessions.prompt`'s new `attachments` field, Task 8) [M5R111].
- Every daemon test builds callers with `testCaller()` from `apps/daemon/src/testing/caller.ts`, never a `{ userId, permissions }` literal [M5R110].
- "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1] A path, a file name, git's stderr or a shell's output never reaches a client as an error message; they are clipped before logging [R66]. Anything the boundary refuses answers `not_found` (no existence oracle).
- "The transport stamps the caller identity; it is never read from params." [C §4.4] Every path is judged against the caller's own roots; another owner's terminal, attachment or project answers `not_found`.
- "CSRF: `Origin` is checked on the WS upgrade and on every POST" [C §4.4]: the existing `originGuard` covers `PUT /files/raw` and `POST /upload` (unsafe methods); the session cookie is `SameSite=Strict` [ADR 0004].
- Every response carries the CSP of R74; the raw file route adds its own `sandbox` CSP through `ownCsp` (ADR 0006 pattern) and never serves HTML, SVG or XML as a page of the pap origin (M8R33).
- "Untrusted content is fenced": file content, git output, terminal output and file names are untrusted text: rendered as React text or inside CodeMirror / xterm, never as HTML; names are clipped and stripped of bidi and zero-width characters before display (the `INVISIBLE` class of contracts) [R86, R87, DESIGN §11].
- Policy: M5's pipeline is untouched. The owner's own actions (explorer, editor, terminal) are not agent tool calls and are not judged by pap-policy; the boundary applies M5's **lists** to them (pap home, Pi's private files, protected names) with owner-side outcomes (refuse, confirm, or confirm plus step-up; § The boundary at a glance).
- **Tokens never make a standing or code-running change** (agreement 5, owner c3): a `Caller.kind === "token"` never sends `confirmProtected`, never writes a protected name, never writes under `<agentDir>` or a `.pi/` folder, never holds `terminal:*` or `pi:admin`; each refusal answers `forbidden` and is pinned in `security/files-origin.int.test.ts`. A token never reads Pi's folder, a `.pi/mcp.json` or `.mcp.json`, nor home's dot-entries when a project is the home folder (`not_found`, owner f8, f10).
- **Pi's configuration has one writer** (agreement 6, owner c3, f10): M7's Settings reads and writes `<agentDir>/{auth,models,mcp,trust,settings}.json` (masked, step-up); M8's boundary refuses them for every intent (`pi_private`). Other writes under `<agentDir>` and under any `.pi/` folder need the confirmation and a live step-up.
- Frames: 1 MiB per message [C §4.2]; RPC answers are fitted with a `truncated` flag; binary payloads at most 64 KiB (M8R7).
- SQLite: M8 adds **no table and no migration** (terminals, attachments and caches are in memory or on disk). Nothing to re-stamp at the merge.
- Supply chain: exact pins, `minimumReleaseAge` 3 days never bypassed, native builds only for `onlyBuiltDependencies` [C §8.2, R36, R56]. A task that believes it needs another dependency stops and reports.
- Bundle: initial ≤ 300 KB gzip (decision 75), lazy stays the rule: CodeMirror, the merge view, xterm and every M8 pane load on demand [C §7.4]. Every task that edits `packages/contracts`, `packages/ui` or `apps/web` runs `pnpm build && pnpm budgets` and writes `bundle: <before> → <after> KB gzip` in its commit body [M5R112]. Above 250 KB the controller stops and asks the owner.
- Browser floor Safari / iOS 16.4 [C §7.3]: no RegExp `v` flag, no CSS nesting, no `light-dark()` in shipped code; new dependencies are scanned (Task 16, 20); en + fr everywhere [A §5.3]; tokens only, no raw colours, no `[…]` arbitrary values, no restyling of `@pap/ui` primitives; no native `title` (`pap/no-native-title`).
- Tests never touch `~/.pi/agent` or `~/.pap`, never reach the network (network guard; git runs with `GIT_NO_LAZY_FETCH=1` and `protocol.allow=never`), never call a real provider; timers go through the kernel `Clock` (web: runtime `Timers`); no sleeps in test code (a shell `sleep` typed into a test terminal is a process, not a test wait); real processes are awaited with `vi.waitFor` and an explicit timeout; test daemons run with worker scopes off; a test terminal runs `/bin/sh` with a temporary `HOME` [AGENTS.md, R94, R118].
- `node:sqlite` warnings: `--disable-warning=ExperimentalWarning` on every Node command [R43].
- Format: `pnpm format` on the task's own files before each commit; `docs/` is not formatted [R4].
- Git: Conventional Commits, rebase on the target before a PR, **no `Co-Authored-By` and no AI attribution trailer** [C §8.3, owner rule].
- Never edit pi-web; pap imports nothing from it and copies none of its code. T3 Code and Orca are untrusted references: read for patterns, never copied.
- **Implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and report each item ✅ / n/a (one line why). Reviewers probe each item.**
- Host: headless VPS (no graphics, no Chrome, no sudo). Every command and path uses `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m8`; nothing is written to `/home/ubuntu/Workspace/soulkyu/pi-web` or to the M7 worktree `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m7`. Ports 30141, 7777, 4040, 18022, 18023 are never used; no long-running server is left behind.
- Code blocks in this plan are binding where they pin a security contract (the binary codec, the path boundary, its write gate, the deny set and the checked open and write, git's arguments and environment, PTY spawn arguments, environment and kill ladder, the raw route's headers and download names, upload names, size caps and in-flight reservations, the worker's image path and header checks, the worker's prompt queue, the zod schemas of every M8 method). Elsewhere the interfaces and tests are binding; an implementer who finds a defect in prescribed code fixes it, keeps the test, and says so in the report.
- Error codes (agreement 23, final): M8 adds exactly **two** `ERROR_CODES`, `protected_path` and `terminal_unavailable`, after `read_only` and before M7's four (`helper_failed`, `project_scope`, `config_invalid`, `config_path_refused`), all before `unknown_method`. `too_large` (a `GitError` kind, a `BoundaryError` reason, a `VcsStatus.error` value) and `attachments_size` (a log event) are not error codes. M8's routes otherwise answer existing codes only (`step_up_required`, `read_only`, `capacity`, `limit_reached`, `payload_too_large`, `conflict`, `forbidden`, `not_found`, `bad_request`, `unauthenticated`).

## Plan conventions (decided by this plan)

- Commands run from `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m8` with `export PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m8/.superpowers/bin:$PATH`. Task 1's first command is `pnpm install --frozen-lockfile --offline` as a check.
- Every task ends with the gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit`, plus `pnpm test:int` when it touches a daemon module with int tests, the ws server, pi-host, the supervisor or `kernel/pty`, plus `pnpm build && pnpm smoke` when it touches a worker record, the wire, pi-host, the ws upgrade or the terminal, plus `pnpm build && pnpm budgets` (with the `bundle:` line) when it touches `packages/contracts`, `packages/ui` or `apps/web`. "Expected" below means that gate is green.
- "Run them, see them fail" means `pnpm test:unit <the task's new and changed test files>` (plus `pnpm test:int <its *.int.test.ts files>` when it has some) → FAIL on a missing export or a failed assertion, never on a syntax error; after the implementation the same command → PASS, then the task's gate. The report says how each test was seen failing.
- Each task carries **Rulings (pre-dispatch)** lines `M8R<n> [tasks] decision — why — cost if wrong`; the controller copies them to `docs/research/m8-rulings.md` (Task 22).
- **Lighter plan (decision 73):** normal tasks give interfaces, rulings and the tests with their key assertions; full code only for the security contracts listed in the Global Constraints. Tests are written RED first; security guards get a mutation check (remove the guard, a named test fails).
- One feature, one vertical slice: a daemon task that adds a stream also adds its web opener and reducer test; the screens come in Tasks 15–21.
- Fix rounds 4–5 of a task still failing after three rounds may use an Opus implementer (decision 75 Q9), logged in the ledger. Any other model change goes to the owner first.
- Rulings that touch both milestones are in "Merge order and conflict notes"; M8 never edits `docs/research/decisions-log.md` (M7's plan fix records both milestones' owner decisions).

## Review Focus

The input classes or failure modes most likely to bite a person, that no feature test naturally exercises; each names the test that pins it.

1. **A path that leaves the project after the check, or a private file under another name**: `..` that follows a symlink, a symlink the agent planted to `~/.ssh` or `$PAP_HOME`, a **hard link** `proj/notes.txt → ~/.pi/agent/auth.json` or `→ $PAP_HOME/state.db` (same filesystem, allowed to the agent), `%2e%2e`, `%2f` inside a segment, a backslash, NUL, a path of 5 000 bytes, a FIFO or a socket inside the project (a read must not hang), a directory swapped for a symlink into `$PAP_HOME` between the check and the open (a project rooted at `~`), `R/x → /proc/self/cwd`. Expected: `not_found`, never a byte from outside or from a private file, never a hung request. Pinned by Task 3a `boundary.hostile.test.ts`, Task 3b `safe-open.test.ts` ("a hard link to auth.json is denied", "a folder swapped into `$PAP_HOME` inside a home root is refused", "refuses a FIFO without blocking"), Task 13 `files-traversal.int.test.ts`.
2. **A browser that drops for ten minutes while its terminal keeps printing** (laptop lid, phone in a pocket), or **a tab left in the background with a build running**. Expected: the terminal is still there and never stalls because a tab is hidden (owner f2); the reattach shows the missed output from the client's offset, or a reset and the last 4 MiB / 5 000 lines when the gap was evicted; no byte twice, no junk typed at the prompt by replayed terminal queries; input works at once. Pinned by Task 11 `flow.test.ts` ("a stream that never acks stops holding the PTY after 2 s"), Task 12 `terminal.reconnect.int.test.ts` (replay of output produced while nobody was attached, no timing), Task 14 "detaches 5 s after the tab is hidden" and Task 20 "drops what xterm answers while the replay is written".
3. **A command that floods output** (`yes`, `cat` of a 200 MB log) with a slow phone attached beside a desktop. Expected: daemon memory stays bounded by the ring, the desktop keeps up, the phone gets a reset when it catches up, the PTY is paused only while every attached, non-stale client is behind, and never longer than 2 s for a stream that stopped acking. Pinned by Task 11 `flow.test.ts` (step counts and offsets, fake clock) and Task 12 `terminal.multi.int.test.ts`.
4. **A save while the agent changed the same file.** Expected: `conflict`, nothing overwritten silently; the editor offers Reload or Overwrite. Pinned by Task 6a "refuses a write whose base etag is stale" and Task 18 "shows Reload / Overwrite on conflict".
5. **A file that is HTML or SVG opened from the raw route in a new tab.** Expected: no script runs on pap's origin (download with `Content-Disposition: attachment`, or an image under `sandbox` CSP and `nosniff`). Pinned by Task 6a `raw-http.test.ts` and Task 13's sandboxed-SVG row.
6. **Uploads at the edges**: one byte over the cap, a chunked body without length, a client that stops sending, 33 uploads started at once, a name `../x`, `.git/hooks/pre-commit`, `a\u202Eb.txt`, `CON`, 300 bytes. Expected: 413 / 400 / 409 `limit_reached` / 503 `capacity` / `protected_path` before the body is read, the temp file removed, nothing left half-written, nothing beyond the caps on the disk that holds `state.db`. Pinned by Task 6b `upload-http.test.ts` and `upload-http.socket.test.ts`, Task 7 `attachments-http.test.ts`.
7. **Git in a hostile repository**: `.git/config` (written by an agent) with `core.fsmonitor`, `diff.external`, a textconv driver, `core.hooksPath`, an `include.path`, a submodule that sets `core.fsmonitor`; inherited `GIT_DIR` / `GIT_EXTERNAL_DIFF` in the daemon's environment; a root that is no repository inside one that is; a partial clone with missing blobs; paths with newlines and leading dashes. Expected: no configured command runs, no network, no argument injection, the right repository and never the one above the root. Pinned by Task 4 `exec.int.test.ts` (the lazy-fetch case by `exec.test.ts`: `GIT_NO_LAZY_FETCH=1` and `protocol.allow=never` on every call).
8. **Daemon stop or a closed tab with live terminals, and the jobs they started** (`sleep 1000 &` after `trap "" HUP`, which an interactive dash or bash puts in a process group of its own). Expected: every process of the shell's session gone within the 2 s grace plus 5 s, with scopes on or off; `pap serve` exits 0 and never hangs on a PTY. Pinned by Task 10b `spawn.int.test.ts` "kills the shell, its job and its foreground command" (the job's pid recorded by the shell) and Task 12 `daemon.terminal-stop.int.test.ts`.
9. **An image a phone camera made** (12 MB HEIC or a 9 MB PNG) dropped on the composer, or a 30 KB PNG that declares 50 000 \u00D7 50 000 pixels. Expected: HEIC is a file attachment (not an image Pi can read), the PNG is resized by the worker under Pi's limits, the bomb is refused from its header before anything decodes it, the prompt never exceeds the worker's 4 MiB record cap (paths travel, not bytes). Pinned by Task 7 "classifies by magic bytes" and Task 8 `image-size.test.ts`, `host.images.int.test.ts`.
10. **A standing API token used to plant code that runs later** (`.git/hooks/pre-commit`, `.envrc`, `.pi/extensions/x.ts`, `~/.bashrc` in a home project) or to read keys (`.pi/mcp.json`, `~/.ssh/id_ed25519`). Expected: `forbidden` for every protected write and for `confirmProtected` itself, `not_found` for the reads, an ordinary file still written. Pinned by Task 3a `boundary.test.ts` (the write gate) and Task 13 `files-origin.int.test.ts`.
11. **Two image prompts and a Stop sent quickly** while the agent works. Expected: Pi receives them in the order they were sent; a Stop sent while an image is being prepared drops the prompts still waiting (nothing reaches Pi after the Stop). Pinned by Task 8 `prompt-queue.test.ts` and `host.images.int.test.ts`.

---

## File structure

```
packages/contracts/src/
  permissions.ts       1  DOMAINS + files, vcs, terminal
  errors.ts            1  protected_path, terminal_unavailable
  auth.ts              1  TOKEN_PERMISSIONS without terminal:* (owner f1, agreement 4)
  handlers.ts          1  HandlerContext.binary? (BinaryChannel, BinaryStream, BinarySink)
  protected-paths.ts   NEW (1) M5's lists, isProtectedName()
  binary-frames.ts     NEW (2) the codec (full code)
  files.ts             NEW (5) FILE_LIMITS, FileEntry, FileMeta, filesMethods; (6a) files.write; (7) AttachmentView
  vcs.ts               NEW (9) DiffSide, VcsFile, VcsStatus, VcsStreamEvent, vcsMethods
  terminal.ts          NEW (12) TerminalView, TerminalStreamEvent, terminalMethods
  streams.ts           9 STREAMS + vcs · 12 + terminal
  frames.ts            12 CAPABILITIES + terminal
  pi-host.ts           8  PromptCommand.images (paths)
  methods.ts           5, 9, 12 one import + one spread each · 8 sessions.prompt.attachments
packages/pi-host/src/
  commands.ts          8  handlePrompt takes images; queuePrompt (the prompt's preparation and start)
  dispatch.ts          8  DispatchDeps.papHome, the prompt queue, abort drops waiting prompts (agreement 8)
  host.ts              8  one line: papHome into createDispatch
  prompt-images.ts     NEW (8) the image path check (full code)
  image-size.ts        NEW (8) the header size check (full code)
  prompt-queue.ts      NEW (8) prompts reach Pi in arrival order (full code)
  policy/protected-lists.test.ts   NEW (1) contracts' lists agree with the policy (no policy file edited)
apps/daemon/src/
  kernel/fs/           NEW (3a) boundary.ts · (3b) deny-set.ts, safe-open.ts, names.ts (upload names)
  kernel/git/          NEW (4) exec.ts, runner.ts, porcelain.ts, numstat.ts
  kernel/pty/          NEW (10a) load.ts · (10b) spawn.ts, env.ts, kill.ts
  kernel/http/         NEW (6a) caller.ts (cookie caller + permission), content-disposition.ts (shared with the export route) ·
                       server.ts (6b) an explicit requestTimeout
  kernel/ws/           2 binary-streams.ts (NEW), ws-server.ts · 9 stream-hub.ts hasSubscribers()
  kernel/supervisor/   10b scope.ts next({ kind: "terminal" }) · env.ts the platform-secret variables (shared rule)
  kernel/config.ts     5 userHome · 12 PAP_MAX_TERMINALS
  modules/files/       NEW (5) index, service, list, read, search-index, rank, rpc · (6a) write, raw-http ·
                       (6b) upload-http, receive-body, inflight · (7) attachments-store, attachments-http, sniff
  modules/vcs/         NEW (9) index, service, status, diff, poller, rpc
  modules/terminal/    NEW (11) ring, flow, terminal, registry · (12) index, service, rpc
  modules/projects/    3a roots(ownerId)
  modules/sessions/    8  rpc, service-commands, live-run, live-session (+≤3 lines), service-types, index (attachments port);
                       6a export-http.ts imports the shared disposition (its tests unedited)
  compose-workspace.ts NEW (5) builds files, vcs, terminal; daemon.ts calls it (≤ 10 lines added there)
  security/            NEW (13) files-traversal, files-protected, files-origin, terminal-boundary (*.int.test.ts)
  testing/ws-client.ts 2  binary frames · testing/harness.ts 5 userHome
scripts/smoke-terminal.ts  NEW (12) the built daemon opens a terminal and echoes
packages/ui/src/
  code.ts · code/      NEW (16) CodeEditor, DiffView, theme, languages (subpath @pap/ui/code)
  terminal.ts · terminal/  NEW (20) TerminalSurface, terminal-theme (subpath @pap/ui/terminal)
  primitives/TextField.tsx  21 passthrough props (inputRef, onKeyDown, onPaste, onDrop, onDragOver, combobox)
apps/web/src/
  runtime/             14 connection.ts (binary), terminal-channel.ts (NEW), upload.ts (NEW) · 9, 12 subscriptions.ts openers
                       (+ subscriptions.m8.test.ts, agreement 11)
  stores/              14 vcs-store, vcs-reducer, terminal-store, terminal-reducer (NEW) · 21 drafts.ts (attachment ids)
  features/workspace/  15 model.ts (item kinds), item-path.ts
  routes/shell/        15 pane-renderers, item-title, PaneHost, MobileShell, SurfaceBar, SurfaceSwitch (NEW) ·
                       18 files-pane-entry.tsx (NEW, lazy: the files pane with the step-up prompt)
  features/files/      NEW (17) FilesPane, Explorer, ViewerTabs, FileViewer · (18) editor flow
  features/vcs/        NEW (19) ChangesPane, ChangeList, FileDiff
  features/terminal/   NEW (20) TerminalPane, use-terminal
  features/sessions/   21 Composer.tsx (6 mount lines), use-composer.ts, composer/ (mentions, attachments, menu chain)
  features/commands/defaults.ts   15 three commands
  i18n/catalog/        1, 15 shell.ts (eager lines) · files.ts, changes.ts, terminal.ts, session-files.ts (lazy)
  build-output.int.test.ts        16, 20 lazy markers
docs/adr/0030-composer-text-mentions.md · 0031-file-routes-and-attachments.md · 0032-vcs-stream-by-root.md   22
docs/agents/files.md (NEW) · terminal.md (NEW) · daemon.md · web.md · sessions.md · policy.md · AGENTS.md  22
```

## The boundary at a glance (owner-side rules, Tasks 3a and 3b)

A path is an absolute, canonical string (no `.`, `..` or empty segment, no NUL, at most 4 096 bytes). Roots are the caller's project roots (M4: the git root of a session's folder, or that folder), real paths. A path is inside when both its spelling and its real path (symlinks followed) are inside a root. Every rule below is judged on both spellings, then again on where the open descriptor really is (`/proc/self/fd`), and the opened file's `(dev, ino)` must not be one of pap's or Pi's private files (hard links, swapped folders, case-folded spellings).

| Path class | list | read (RPC, raw) | write (save, upload): browser session | write: API token |
|---|---|---|---|---|
| inside a root, ordinary | yes | yes | yes | yes |
| inside a root, protected name (M5's list: `.git`, `.agents`, `.husky`, `.vscode`, `.idea`, `.zed`, `.devcontainer`, `.lefthook`, `.mise` segments; `.envrc`, `.pre-commit-config.yaml`; lefthook and mise configs) | yes | yes | `protected_path` unless `confirmProtected` ("Save anyway?", owner c3) | `forbidden` |
| a dot-entry directly in the home folder (`~/.bashrc`, `~/.ssh/**`, `~/.config/**`) when one of the caller's roots is the home folder or above it (owner f8) | yes; a token sees it as a protected entry | yes; a token gets `not_found` | `protected_path` unless `confirmProtected` | `not_found` |
| under `<agentDir>` (other than the rows below) or under any `.pi/` folder (owner c3, agreement 6) | yes; a token: `<agentDir>` as a protected entry | yes; a token: `not_found` for `<agentDir>`, `.pi/mcp.json` and `.mcp.json` (owner f10) | `protected_path` unless `confirmProtected`, then `step_up_required` unless a live step-up | `forbidden` (`not_found` under `<agentDir>`) |
| `$PAP_HOME` and below (except `papHomeOpen`, empty in M8) | listed as a protected entry, not browsable | `not_found` | `not_found` | `not_found` |
| `<agentDir>/{auth,models,mcp,trust,settings}.json`, `<agentDir>/sessions/**` (Settings is their editor) | listed as protected, not browsable | `not_found` | `not_found` | `not_found` |
| a link whose target is outside every root | entry `link: "outside"`, not browsable (owner f5) | `not_found` | `not_found` | `not_found` |
| not a regular file or folder (FIFO, socket, device) | entry `kind: "other"` | `not_found` (never opened blocking) | `not_found` | `not_found` |
| outside every root | `not_found` | `not_found` | `not_found` | `not_found` |

A token also never sends `confirmProtected` (`forbidden` on any path), never holds `terminal:*` (agreement 4) and never reaches the HTTP file routes (cookie only).

## The terminal wire at a glance (Tasks 2, 11, 12)

| Bytes | Field | Rule |
|---|---|---|
| 0 | magic `0x70` | anything else: dropped |
| 1 | version `1` | anything else: dropped |
| 2 | op | server → client: `1` output, `2` reset, `3` exit; client → server: `16` input, `17` ack; any other, or one sent the wrong way: dropped |
| 3 | flags | must be `0` |
| 4–7 | streamId u32 LE | `1 … 2³²−1`, given by `terminal.attach` to this connection only |
| 8–15 | seq u64 LE (two u32, high first word ≤ `0x1FFFFF`) | output / reset / exit / ack: a byte offset of the terminal's output since it started; input: a counter that only grows |
| 16– | payload | at most 64 KiB; output: raw bytes; exit: JSON `{ "code": n \| null, "signal": s \| null }`; reset, ack: empty |

Flow control: the server sends a stream at most 512 KiB past its last ack; a stream past that, or whose socket buffers more than 1 MiB, is paused and resumes when its ack comes within 256 KiB. A stream paused for more than 2 s is **stale** and stops holding the PTY (a hidden tab whose timers are throttled never stalls a build, owner f2). The PTY itself is paused only while at least one attached stream is not stale and every such stream is paused. A paused or stale stream whose next offset fell out of the ring gets `reset` and the ring when it resumes; otherwise it continues from its offset.

## Pre-execution conflict scan

Tasks run one at a time, in order: 1, 2, 3a, 3b, 4, 5, 6a, 6b, 7, 8, 9, 10a, 10b, 11, 12, 13 … 22. Pairs below share files or interfaces; the later task builds on the earlier one's result and must not undo it. Files shared with M7 are listed in "Merge order and conflict notes" (agreements 1–24).

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1 → all | `permissions.ts`, `errors.ts`, `handlers.ts` (`BinaryChannel`), `protected-paths.ts` | Task 1 adds only; later tasks read them. |
| 2 → 11, 12, 14 | `binary-frames.ts` codec, `HandlerContext.binary`, `BinaryStream.send` / `BinarySink` | Task 2 freezes the layout and the channel API; 11 uses fakes of it, 12 wires it, 14 decodes the same frames in the browser. |
| 3a → 3b | `within`, `judgeName`, `Scope`, `BoundaryConfig` | 3b re-runs 3a's pure name judgement on the descriptor; it never adds a rule of its own to it. |
| 3a → 5, 6a, 6b, 7, 9, 10b, 12 | `judgePath()`, `gateWrite()`, `Scope`, `Protection`, `ProjectsPort.roots()` | Every path from a client goes through `judgePath` with the caller's kind; every write through `gateWrite`; no task reimplements containment, protection or token rules. |
| 3b → 5, 6a, 6b, 7, 9 | `openRegularFile()`, `openFolder()`, `writeAtomic()`, `OpenGuard`, `createDenySet()` | Every open of a client path goes through these with one shared deny set (built in `compose-workspace.ts`, Task 5). |
| 4 → 5, 9 | `GitRunner.run()`, `gitArgs()`, `gitEnv()`, porcelain and numstat parsers | `files` (check-ignore, ls-files) and `vcs` (status, diff, cat-file) both run git through the runner only. |
| 5 → 6a, 6b, 7, 21 | `modules/files/index.ts` `createFilesModule`, `compose-workspace.ts`, `contracts/files.ts` | 5 creates the module and the composition helper; 6a, 6b and 7 add methods, routes and stores to it; 21 calls `files.search`. |
| 6a → 6b, 7 | `kernel/http/caller.ts` (`HttpCaller`), `content-disposition.ts` | 6b and 7 reuse the caller; the disposition is 6a's. |
| 6b → 7 | `receiveBody()`, `createInflight()`, the explicit `requestTimeout` | 7 reuses them for `POST /upload`, with its own pending reservation. |
| 7 → 8 | `AttachmentsPort.claim()` / `release()` | 8 claims at `sessions.prompt`; 7 never knows sessions. |
| 8 (pi-host) | `dispatch.ts`, `commands.ts`, `host.ts` | M8 adds `papHome` and the prompt queue; M7 adds its own `case` lines in `dispatch.ts` (agreement 8). |
| 9 → 14, 19 | `VcsStreamEvent`, `subscribe.vcs`, `vcs.fileDiff`, `DiffSide`, `VcsFile.folder` | 14 reduces the stream, 19 renders it. |
| 10a → 10b | `loadNodePty()`, the installed `node-pty` | 10b spawns through the loaded module only. |
| 10b → 11, 12 | `PtyProcess` (with `start`), `spawnPty()`, `ptyKill()`, `sessionMembers()` | 11 tests against a fake `PtyProcess`; 12 passes the real one. |
| 11 → 12 | `TerminalRegistry`, `Terminal.attach/detach/input/ack/resize/close`, stale streams | 12 adds the RPC, the list stream and wiring only. |
| 12 → 14, 20 | `terminal.attach` result, `terminal.create { requestId }`, `TerminalStreamEvent`, CAPABILITIES `terminal` | 14's channel and 20's pane follow them. |
| 14 → 17, 19, 20, 21 | `runtime/terminal-channel.ts` (visibility detach, input split), `runtime/upload.ts`, `vcs-store`, `terminal-store` | screens use them, never the socket. |
| 15 → 17, 18, 19, 20 | `ItemRef` kinds `files`, `changes`, `terminal`, `PANE_RENDERERS`, `SurfaceBar` | 15 mounts placeholder lazy panes; 17/19/20 replace the placeholder files by name; 18 adds the files pane's lazy entry in `routes/shell/` (step-up). |
| 16 → 17, 18, 19 | `@pap/ui/code` (`CodeEditor`, `DiffView`, `languageFor`) | lazy subpath only, never the eager barrel. |
| 17 → 18 | `features/files/FileViewer.tsx`, `use-open-file.ts` | 18 adds edit mode to the same viewer. |
| 17 → 21 | drag type `application/x-pap-path` | 17 sets it on tree rows; 21 reads it on the composer. |
| 21 (web) | `TextField` props, `composer/menus.ts` (`ComposerMenu`, `composerFieldProps`) | the only key path of the composer field; M7's `useComposerCommands` plugs into it (agreements 7, 22). |
| 1, 3a, 5, 6a, 9, 10b, 12 → 22 | `docs/agents/files.md`, `terminal.md`, `policy.md` | 22 writes them from the final code. |

## Model table

Proposed per decision 75 Q9 and decision 73: Sonnet implementers on every task (never Haiku); an Opus reviewer where a wrong change is a security hole or a race; Opus for the final whole-branch review. Fix rounds 4–5 may use an Opus implementer (pre-approved, logged).

| # | Task | Implementer | Reviewer | Why Opus (reviewer) |
|---|---|---|---|---|
| 1 | Contracts M8 (additive) | Sonnet | Sonnet | |
| 2 | Binary frames on `/ws` | Sonnet | **Opus** | a new decoder on the socket; commit ordering against the RPC answer; detach before commit |
| 3a | The path judge (`boundary.ts`, roots, home, Pi config, tokens, the write gate) | Sonnet | **Opus** | the `/files` security boundary; owner, confirm, step-up and token rules (agreements 5, 6) |
| 3b | The checked open and write (`deny-set.ts`, `safe-open.ts`, `names.ts`) | Sonnet | **Opus** | hard links, folder swaps, case folding (RT-01); TOCTOU on the descriptor |
| 4 | Git, run safely | Sonnet | **Opus** | repository config runs commands; argument injection; discovery ceiling |
| 5 | `files` reads, search, composition | Sonnet | Sonnet | consumes the reviewed boundary; Task 13 sweeps every route |
| 6a | `files.write`, the raw GET route | Sonnet | **Opus** | write gate with tokens and step-up; XSS through served files; download names |
| 6b | `PUT /files/raw`, the body reader, in-flight caps | Sonnet | **Opus** | streaming caps that must refuse before the body; disk next to `state.db` |
| 7 | Attachments store and `POST /upload` | Sonnet | **Opus** | writes into `$PAP_HOME`; reservations that must refuse |
| 8 | Prompts with attachments | Sonnet | **Opus** | the worker's path and header checks (binding code), the prompt queue and the abort race (RT-07), replay and claim interplay |
| 9 | `vcs` module | Sonnet | Sonnet | git contract already reviewed in 4; RT-10, RT-16, RT-17 are written into its rulings |
| 10a | node-pty in the build allowlist, `load.ts`, the smoke import | Sonnet | Sonnet | a dependency and a loader; the build log is the proof |
| 10b | PTY spawn, environment, the session-wide kill ladder, the terminal scope | Sonnet | **Opus** | spawn arguments, environment, process-session kill (RT-05), native process handling |
| 11 | Terminal core (ring, flow, stale streams, attach) | Sonnet | **Opus** | concurrency: offsets, pause/resume, stale streams, multi-client |
| 12 | Terminal RPC, stream, wiring, exit test | Sonnet | **Opus** | the exit criterion proof; stop order; read-only mode |
| 13 | Security suite (C §8.1, M8 half) | Sonnet | **Opus** | the exit criterion proof: a weak test is false assurance |
| 14 | Web runtime: binary, terminal channel, stores | Sonnet | **Opus** | the client half of flow control, reconnect generations, stale answers, visibility detach (RT-06): a defect breaks the exit criterion in real browsers, where no test runs |
| 15 | Panes, items, Chat / Review / Term switch | Sonnet | Sonnet | |
| 16 | `@pap/ui/code` (editor, DiffView) | Sonnet | Sonnet | |
| 17 | Files pane (explorer, viewer) | Sonnet | Sonnet | |
| 18 | Editor flow (save, conflict, protected, step-up) | Sonnet | Sonnet | |
| 19 | Changes pane (Review) | Sonnet | Sonnet | |
| 20 | Terminal pane (`@pap/ui/terminal`) | Sonnet | Sonnet | probes listed (replay suppression, focus, Escape, links, resize loop) |
| 21 | Composer: mentions, drops, attachments | Sonnet | Sonnet | |
| 22 | Docs, ADRs 0030–0032, final gates | Sonnet | Sonnet | |
| — | Whole-branch review | — | **Opus** | owner rule |

Totals: **25 tasks**; implementers 25 Sonnet (never Haiku); reviewers **13 Opus** (2, 3a, 3b, 4, 6a, 6b, 7, 8, 10b, 11, 12, 13, 14) + 12 Sonnet; one Opus whole-branch review. Fix rounds 4–5 of a task still failing after three may use an Opus implementer (decision 75 Q9, logged).

## ETA

| Basis | Figure |
|---|---|
| Agent-time unit of the brief (1–1.5 h per task with review and fixes, security tasks longer) | 12 Sonnet-reviewed × 1.4 h ≈ 17 h; 13 Opus-reviewed × 2.2 h ≈ 29 h; native build and PTY integration rounds ≈ 2 h; whole-branch review and its fix round ≈ 4 h; minus the overlap of the three splits (each half is smaller than the task it came from) ≈ −2 h → **≈ 50 h of agent time (44–60 h)** |
| Wall clock at the observed M4 / M5 pace (M4: 36 tasks in about 9 h; M5: 34 security-heavy tasks in about 16 h) | M8 is closer to M5 (13 Opus reviews, a native dependency, two binary protocols) and heavier on UI: **≈ 18 h wall clock (14–24 h)**, the final review included |

Low end: node-pty builds on the first try and the web tasks pass their first review. High end: node-pty needs a build fix round, the fd check of Task 13 finds a descriptor node-pty passes to the shell, or the reconnect test exposes a flow-control race (Task 11/12 fix rounds 4–5 on Opus). The M7 rebase is not in these figures: M8 merges first (owner c1), so the rebase is M7's (≈ 1–1.5 h on M7's side).

---

## Owner decisions (2026-10-13) — rulings M8R88–M8R100

The owner answered the M7 + M8 question page (`.superpowers/owner-decisions-2026-10-13-m7m8.md`); every answer was the recommendation. Each is a ruling here; the tasks that apply it name it. The controller copies them to `docs/research/m8-rulings.md` (Task 22); M7's plan fix records both milestones' answers as decision 76 (M8 never edits the decisions log).

- **M8R88** [merge] (c1) M8 merges first; M7 rebases, unless M7 passes its Opus final review more than one working day before M8 (agreement 1) — cost if wrong: one rebase on the other side.
- **M8R89** [21, 22] (c2) No tiptap in this wave: `@path` mentions stay plain text, M7's `$skill` is sent as Pi's `/skill:name`; revisit at M11. ADR 0030 is written unconditionally — cost if wrong: chips later.
- **M8R90** [3a, 6a, 6b, 13, 18] (c3, agreements 5 and 6) Changes that run code later: Pi's configuration takes the password step-up and is edited only in Settings, keys masked (M7); other protected files take a "Save anyway?" confirmation; tokens never confirm anything. In M8: `pi_private` for Pi's five files, `step_up` for the rest of `<agentDir>` and every `.pi/` folder, `confirm` for M5's names and home's dot-entries, `forbidden` for tokens (M8R16, M8R101) — cost if wrong: M7's masks and step-up bypassed.
- **M8R91** [1, 12, 13] (f1, Q1) Terminals: browser sessions only, never a token, no extra password (M8R2) — cost if wrong: one filter line.
- **M8R92** [11, 12, 14, 20] (f2, Q2) A terminal lives until closed, its shell exits or pap stops; at most 8 running (`PAP_MAX_TERMINALS`), the 9th refused with a message, 8 exited kept for their output; **a hidden tab never pauses it** (stale streams, M8R57; the client's visibility detach, M8R111). Terminals share the workers' `MemoryMax` and `TasksMax`: said in `terminal.md` (RT-38) — cost if wrong: a reaper with a setting later.
- **M8R93** [7, 8, 21] (f3, Q4) A non-image file dropped on the chat becomes a session attachment in `~/.pap/attachments/<session>/`, its path cited in the message (M8R42) — cost if wrong: one copy target.
- **M8R94** [17] (f4, Q5) The viewer previews text and code, Markdown and images; everything else downloads — cost if wrong: one preview later.
- **M8R95** [5, 17] (f5, Q6) Folders that link outside the project are listed with a lock and not browsable — cost if wrong: none.
- **M8R96** [12, 6a] (f6, Q7) Terminal and save traces go to the daemon log only, no audit rows (no migration in M8) — cost if wrong: a migration later.
- **M8R97** [deferred] (f7, Q8) Clickable paths in the transcript, reading files a session mentions outside the project, and explorer new / rename / delete are deferred (M9's review or M13); "open in the OS file manager" is dropped — cost if wrong: none.
- **M8R98** [3a, 13] (f8, red-team Q10) When a project is the home folder or `/`: dot-files and dot-folders directly in the home are protected (a save asks "Save anyway?", tokens get `not_found` for every intent); the rest is ordinary (M8R16, M8R102) — cost if wrong: dotfiles written without a question.
- **M8R99** [7, 8] (f9, red-team Q11) What the owner attaches does not taint the session: an upload is the owner's content, like pasted text; `sessions.prompt` with attachments raises no taint — cost if wrong: every later network call of that session would ask.
- **M8R100** [3a, 3b, 13] (f10, red-team Q12) Pi's key files are hidden in Pi's own folder (`pi_private`; Settings shows them masked); a project's `.pi/mcp.json` is visible to the owner (writes take the step-up) and never to tokens (M8R102) — cost if wrong: keys shown in the explorer.

---

## Tasks

### Task 1: Contracts M8 — the additive half (domains, two error codes, the token rule, the binary channel types, the protected lists)

Every later task reads these. This task only adds; methods arrive with the task that implements their handler (the handler table is exhaustive).

**Rulings (pre-dispatch):**
- **M8R1** [1, 5–7, 9, 12] Permission domains `files`, `vcs`, `terminal` are appended to `DOMAINS` after `audit`. Methods and routes: `files.list|read|search` and `GET /files/raw` → `files:read`; `files.write` and `PUT /files/raw` → `files:operate`; `POST /upload` → `sessions:operate` (an attachment belongs to a prompt); `subscribe.vcs`, `vcs.refresh`, `vcs.fileDiff` → `vcs:read`; `subscribe.terminal` → `terminal:read`; `terminal.create|attach|detach|resize|close` → `terminal:operate` (attaching gives input) — spec C §4.4 `domain:read|operate|admin`, no admin level is used — cost if wrong: a permission renamed later (one line per method).
- **M8R2** [1, 3a, 6a, 13] *(corrected: RT-03, RT-04, agreement 5, owner f1, c3)* `TOKEN_PERMISSIONS` also excludes every `terminal:` permission: the one filter of agreement 4 excludes `auth:*`, `policy:admin`, `pi:admin` (M7's line) and `terminal:*` (M8's line). A token is a standing credential, so it never makes a standing or code-running change: no terminal, no `confirmProtected` (`forbidden` on any path), no write to a protected name, a home dot-entry, `<agentDir>` or a `.pi/` folder (`forbidden`, or `not_found` where it may not even read), no `pi:admin`. Scripts reach ordinary files and git status through `files:*` / `vcs:*` — cost if wrong: a standing token gets delayed code execution.
- **M8R3** [1, 6a, 10a, 12] Two error codes, M8's final list (agreement 23): `protected_path` ("This file can run commands later, such as a git hook or an editor task. Confirm to save it.") and `terminal_unavailable` ("Terminals are not available on this server: the terminal module did not load."), placed after `read_only` and before `unknown_method` (M7's four go between, agreement 3), en + fr in the eager `i18n/catalog/shell.ts` beside `error.limit_reached` (every code needs an eager message, M5R129). `errors.test.ts` asserts membership and messages, never adjacency, so the two branches merge as a union — cost if wrong: none.
- **M8R4** [1, 2, 12] `HandlerContext.binary` is **optional** (`readonly binary?: BinaryChannel`): the ws server always sets it; a handler that needs it and finds none answers `internal`. About 22 test files build contexts today and M7 adds more: a required field would break both branches at the merge — cost if wrong: none.
- **M8R5** [1, 3a, 6a] M5's lists are copied into `packages/contracts/src/protected-paths.ts` (`PAP_SENSITIVE_NAMES`, `PROTECTED_SEGMENTS`, `PROTECTED_BASENAMES`, `HOOK_CONFIG_NAME`, `isProtectedName(path)`), the daemon uses them; `packages/pi-host/src/policy/**` is **not edited** (M7 owns it in this wave): a new pi-host test proves pi-host's own `checkEditTarget` / `checkReadTarget` treat every contracts entry as protected. One direction only: a name pi-host adds later and contracts lacks is not caught (written in `policy.md`, Task 22; M13 dedupes) — cost if wrong: the owner's editor and the agent disagree on a new protected name until then.
- **M8R6** [1] *(corrected: RT-02, RT-35)* The token form warns for `files:operate` like `sessions:operate` ("This token can write ordinary files in your projects; never hooks, editor tasks or Pi's files.") and for `files:read` ("This token can read the files of your projects, your home folder included when it is a project, apart from its dot-files."): `riskyPermissions` returns the three; the grid gets `access.tokens.domain.files` / `.vcs` labels (lazy `catalog/settings-access.ts`, union with M7 Task 28, agreement 17). The grid shows cells no method uses yet (`files:admin`, `vcs:operate`, `vcs:admin`) until M7R124's "only permissions some method declares" filter merges (agreement 4); granting them grants nothing, so M8 adds no filter of its own (one owner of that line) — cost if wrong: three inert cells for the time between the two merges.

**Files:**
- Modify: `packages/contracts/src/{permissions,errors,errors.test,auth,auth.test,handlers,index}.ts`; `apps/web/src/i18n/catalog/{shell,settings-access}.ts`; `apps/web/src/features/auth/tokens.vm.ts` (+ test)
- Create: `packages/contracts/src/protected-paths.ts`, `protected-paths.test.ts`; `packages/pi-host/src/policy/protected-lists.test.ts`

**Interfaces:**
- Produces (`handlers.ts`):

```ts
/** One attached binary stream of this connection (Task 2). `send` is false while the stream is not committed, closed, or
 * while the socket buffers more than 1 MiB: the caller pauses and tries again later (Task 11). */
export interface BinaryStream {
  readonly streamId: number;
  send(op: "output" | "reset" | "exit", seq: number, payload: Uint8Array): boolean;
  close(): void;
}
export interface BinarySink {
  /** The RPC answer that created the stream reached the client: frames may flow. */
  onOpen(): void;
  onInput(seq: number, payload: Uint8Array): void;
  onAck(seq: number): void;
  /** The stream ended: closed by the sink, the socket, a revocation or a failed request. Called once. */
  onClose(): void;
}
export interface BinaryChannel {
  /** Throws `PapError("capacity")` past 16 streams on this connection. */
  open(sink: BinarySink): BinaryStream;
}
// HandlerContext gains: readonly binary?: BinaryChannel;
```

- Produces (`protected-paths.ts`): the four lists exactly as in pi-host today (`policy/read-target.ts` `PAP_SENSITIVE`, `policy/target-path.ts` `PROTECTED_SEGMENTS`, `PROTECTED_BASENAMES`, `HOOK_CONFIG_NAME` and the `.config/mise`, `mise/config.toml` rules) and `isProtectedName(absolutePath: string): boolean` (segments NFC-normalised and lower-cased, as pi-host's `hasProtectedName`).

- [ ] **Step 1: Write the failing tests**
  - `errors.test.ts`: `ERROR_CODES` contains `protected_path` and `terminal_unavailable`, both before `unknown_method` (membership, never adjacency: agreement 3); `ERROR_MESSAGES` equal the M8R3 texts exactly.
  - `auth.test.ts`: `TOKEN_PERMISSIONS` contains `files:read`, `files:operate`, `vcs:read` and no permission starting with `terminal:`; `TokenPermission.safeParse("terminal:operate").success === false`; `ALL_PERMISSIONS` contains `terminal:operate`.
  - `protected-paths.test.ts`: true for `/p/.git/hooks/pre-commit`, `/p/.GIT/config`, `/p/.vscode/tasks.json`, `/p/.envrc`, `/p/lefthook.yml`, `/p/.lefthook-local.toml`, `/p/.config/mise/config.toml`, `/p/mise.local.toml`, `/p/.pi/settings.json`; false for `/p/.github/workflows/ci.yml`, `/p/.gitignore`, `/p/src/mise.ts`, `/p/docs/lefthook.md`.
  - `packages/pi-host/src/policy/protected-lists.test.ts` (temporary real folders, never `~`): for every `PROTECTED_SEGMENTS` entry `s`, `checkEditTarget(join(cwd, s, "x"), cwd, [])` matches `toMatchObject({ auto: false, review: { why: "protected path" } })` (the review also holds `target`: never an exact `toEqual`, RT-40); the same for every `PROTECTED_BASENAMES` entry; for every `PAP_SENSITIVE_NAMES` entry `n`, `checkReadTarget("read", { path: join(papHome, n) }, { cwd, papHome, agentDir })` has `why: "protected path"`.
  - `tokens.vm.test.ts`: `riskyPermissions(["files:read", "files:operate", "vcs:read"])` is `["files:read", "files:operate"]`; the grid has a `files` and a `vcs` row and no `terminal` row.
- [ ] **Step 2: Run them, see them fail** — `pnpm test:unit packages/contracts packages/pi-host/src/policy/protected-lists.test.ts apps/web/src/features/auth` → FAIL (missing exports and codes).
- [ ] **Step 3: Implement** the additions above; `index.ts` exports `protected-paths.ts`.
- [ ] **Step 4: Gate** (unit, build, budgets; expected bundle +0.2 KB) and commit:

```bash
git add packages/contracts packages/pi-host/src/policy/protected-lists.test.ts apps/web/src
git commit -m "feat(contracts): files, vcs and terminal permissions, two error codes, the protected lists"
```

---

### Task 2: Binary frames on `/ws` — the codec, the per-connection channel, commit after the answer

Spec C §4.2: "binary frames with a `streamId + seq` header and raw bytes; acks give flow control". The layout is Orca's (`src/shared/terminal-stream-protocol.ts`), trimmed to five opcodes. The codec lives in contracts so the browser decodes with the same code.

**Rulings (pre-dispatch):**
- **M8R7** [2, 11, 14] Layout of § "The terminal wire at a glance": 16-byte header (magic `0x70`, version 1, op, flags 0, streamId u32 LE, seq u64 LE as high/low u32 words), payload ≤ 64 KiB. Ops: server → client `output 1`, `reset 2`, `exit 3`; client → server `input 16`, `ack 17`. `reset` and `ack` carry no payload. The high seq word is at most `0x1FFFFF` (seq stays a safe integer) — Orca's header, fewer ops (no snapshot, no viewport claim) — cost if wrong: one version bump, both ends ship together.
- **M8R8** [2] Decoding never throws and never closes the socket: a frame that is malformed, of a wrong-way op, for a stream this connection does not hold, or over 64 KiB is dropped and counted (`ws_binary_dropped`, logged at counts 1, 2, 4, 8…, with the connection id and the reason code only) — a terminal is not worth a JSON client's socket — cost if wrong: a broken client keeps a socket open (bounded by keepalive and the frame cap).
- **M8R9** [2] At most 16 streams per connection (`capacity` past it); stream ids count from 1 per connection and are never reused on it — cost if wrong: none.
- **M8R10** [2, 12] Streams opened by a handler are **committed after its successful answer is sent**, exactly like subscriptions (`prepared` list in `ws-server.ts`): `sink.onOpen()` runs then, and `send` returns false before it; a failed or thrown request releases them (`sink.onClose()`), so no binary frame ever precedes the answer that names its stream. A stream closed while still *prepared* (a `terminal.detach` of the same connection handled before the attach's answer went out, or `closeAll`) is gone: its later `commit()` or `release()` is a no-op and `onOpen` never runs (RT-30) — cost if wrong: none.
- **M8R11** [2] Every inbound binary frame re-authenticates the connection's credential with `slide: false` (one indexed SQLite read): a revoked cookie or token stops typing within one frame, like JSON requests (M5 RT on revocation); a throwing check drops the frame and logs — cost if wrong: ~10 reads a second while someone types.
- **M8R12** [2, 11] `BinaryStream.send` returns false when the socket buffers more than 1 MiB (`STREAM_BUFFER_LIMIT`); it never terminates the socket (the JSON path keeps its 8 MiB slow-consumer rule) — the terminal pauses that stream and retries (M8R57) — cost if wrong: none.
- **M8R13** [2] The revoke path (`revoke()`), the socket's `close` and `WsServer.close()` call `closeAll()`: each open stream's `onClose` runs once — cost if wrong: a PTY keeps an attachment for a dead socket (bounded by M8R60's cap).

**Files:**
- Create: `packages/contracts/src/binary-frames.ts`, `binary-frames.test.ts`, `binary-frames.hostile.test.ts`; `apps/daemon/src/kernel/ws/binary-streams.ts`, `binary-streams.test.ts`, `ws-server.binary.int.test.ts`
- Modify: `apps/daemon/src/kernel/ws/ws-server.ts` (≈ +30 lines: route binary messages, `ctx.binary`, commit/release, `closeAll` on revoke and close), `apps/daemon/src/testing/ws-client.ts` (`sendBinary`, `binaryFrames`, `waitForBinary`), `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: Task 1 `BinaryChannel`, `BinaryStream`, `BinarySink`.
- Produces: the codec below; `createBinaryStreams(deps: { connectionId: string; send(bytes: Uint8Array): void; buffered(): number; logger: Logger }): { open(sink: BinarySink): { stream: BinaryStream; commit(): void; release(): void }; onFrame(data: Uint8Array): void; closeAll(): void }`; `MAX_BINARY_STREAMS = 16`, `STREAM_BUFFER_LIMIT = 1024 * 1024`.

The codec (binding):

```ts
// packages/contracts/src/binary-frames.ts
/** Terminal bytes on /ws (spec C §4.2): a 16-byte header, then raw bytes. Layout after Orca's terminal stream protocol. */
export const FRAME_MAGIC = 0x70;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 16;
export const MAX_FRAME_PAYLOAD = 64 * 1024;
/** Keeps `high * 2^32 + low` a safe integer. */
const MAX_HIGH_WORD = 0x1f_ffff;
const TWO_32 = 0x1_0000_0000;

export const FRAME_OPS = { output: 1, reset: 2, exit: 3, input: 16, ack: 17 } as const;
export type FrameOp = (typeof FRAME_OPS)[keyof typeof FRAME_OPS];
/** What a client may receive, and what the server may receive. */
export const SERVER_OPS: ReadonlySet<number> = new Set([FRAME_OPS.output, FRAME_OPS.reset, FRAME_OPS.exit]);
export const CLIENT_OPS: ReadonlySet<number> = new Set([FRAME_OPS.input, FRAME_OPS.ack]);
const EMPTY_ONLY: ReadonlySet<number> = new Set([FRAME_OPS.reset, FRAME_OPS.ack]);

export interface BinaryFrame {
  readonly op: FrameOp;
  readonly streamId: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 1 || frame.streamId > 0xffff_ffff)
    throw new RangeError("frame streamId out of range");
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) throw new RangeError("frame seq out of range");
  if (frame.payload.byteLength > MAX_FRAME_PAYLOAD) throw new RangeError("frame payload too large");
  if (EMPTY_ONLY.has(frame.op) && frame.payload.byteLength !== 0) throw new RangeError("frame carries no payload");
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, FRAME_VERSION);
  view.setUint8(2, frame.op);
  view.setUint8(3, 0);
  view.setUint32(4, frame.streamId, true);
  view.setUint32(8, Math.floor(frame.seq / TWO_32), true);
  view.setUint32(12, frame.seq % TWO_32, true);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

/** The frame, or null for anything that is not exactly a frame this side may receive. Never throws. */
export function decodeFrame(bytes: Uint8Array, accepted: ReadonlySet<number>): BinaryFrame | null {
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes.byteLength > FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== FRAME_MAGIC || view.getUint8(1) !== FRAME_VERSION || view.getUint8(3) !== 0)
    return null;
  const op = view.getUint8(2);
  if (!accepted.has(op)) return null;
  const streamId = view.getUint32(4, true);
  const high = view.getUint32(8, true);
  if (streamId === 0 || high > MAX_HIGH_WORD) return null;
  // A copy: the socket may reuse its buffer, and a Buffer's own `slice` is a view.
  const payload = new Uint8Array(bytes.subarray(FRAME_HEADER_BYTES));
  if (EMPTY_ONLY.has(op) && payload.byteLength !== 0) return null;
  return { op: op as FrameOp, streamId, seq: high * TWO_32 + view.getUint32(12, true), payload };
}
```

- [ ] **Step 1: Write the failing tests**
  - `binary-frames.test.ts`: round trip of each op with seq `0`, `2**32`, `Number.MAX_SAFE_INTEGER`; `encodeFrame` throws for streamId `0` and `2**32`, seq `-1`, `2**53`, a 64 KiB + 1 payload, a `reset` with a payload; `decodeFrame` returns null for 15 bytes, magic `0x71`, version 2, flags 1, op 4, an output frame given `CLIENT_OPS`, streamId 0, high word `0x200000`, 64 KiB + 1 payload, an `ack` with one payload byte; mutating the source buffer after decoding leaves `payload` unchanged.
  - `binary-frames.hostile.test.ts`: 10 000 buffers from a seeded xorshift (lengths 0–80, half of them with a valid magic and version) — `decodeFrame` never throws, and every non-null result re-encodes to exactly the input bytes.
  - `binary-streams.test.ts` (fake socket): 16 opens succeed, the 17th throws `capacity`; after closing three, the next id is 17; `send` before `commit` returns false and `onOpen` has not run; `commit` runs `onOpen`; `release` runs `onClose` once; an input frame for stream 2 reaches stream 2's `onInput(seq, payload)`; an ack reaches `onAck`; a frame for stream 99 or with op `output` is dropped and counted (logger saw `ws_binary_dropped` at counts 1, 2 and 4 only for four drops); a sink that throws closes only its own stream; `closeAll` runs every `onClose` once; `send` returns false while `buffered()` returns 1 MiB + 1; a prepared stream closed through `stream.close()` before `commit()` → `commit()` runs no `onOpen` and `onClose` ran exactly once (RT-30).
  - `ws-server.binary.int.test.ts` (a test dispatcher whose method opens a stream and sends one output frame from `onOpen`): the JSON answer arrives before the first binary frame; a method that opens a stream then throws → the client gets `internal`, no binary frame, `onClose` ran; a malformed binary frame, then a JSON `system.ping`, is answered (the socket stays); an `authenticate` that turns null on the next binary frame closes the socket with 4401 and runs `onClose`; closing the client runs `onClose`.
- [ ] **Step 2: Run them, see them fail** — `pnpm test:unit packages/contracts/src/binary-frames* apps/daemon/src/kernel/ws/binary-streams.test.ts && pnpm test:int apps/daemon/src/kernel/ws/ws-server.binary.int.test.ts` → FAIL.
- [ ] **Step 3: Implement** `binary-streams.ts`, then in `ws-server.ts`: `ws.on("message", (data, isBinary) => isBinary ? onBinary(toBytes(data)) : void onText(data.toString()))` where `onBinary` re-authenticates (M8R11) then calls `binary.onFrame`; each request's context gets `binary: { open: (sink) => { const p = binary.open(sink); preparedBinary.push(p); return p.stream; } }`; after a successful answer `commit()` each prepared stream, else `release()`; `revoke()` and `ws.on("close")` call `binary.closeAll()`. `toBytes` handles `Buffer`, `ArrayBuffer` and `Buffer[]` (concatenated, total already capped by `maxPayload`).
- [ ] **Step 4: Gate** (unit, int, build, smoke, budgets: the codec is not imported by eager web code yet, +0 KB) and commit:

```bash
git add packages/contracts apps/daemon/src
git commit -m "feat(ws): binary frames with stream ids, committed after the answer that opens them"
```

---

### Task 3a: The path judge — one judgement for every path a client sends: roots, pap's home, Pi's configuration, the home folder, tokens, and the write gate

Spec C §8.1 "path traversal on `/files`". Every M8 route that takes a path (files, raw route, uploads, attachment claims, terminal cwd, vcs root and blob sides) calls `judgePath` with the caller's kind, then opens through Task 3b's `openRegularFile` / `openFolder` or writes through `writeAtomic`, after `gateWrite`. pi-web's lesson (#748, `lib/path-security.ts`): authorise where a path really leads, and refuse `..` outright, because Node's `realpath` collapses `..` before following links and the kernel after. This task is pure judgement (strings and `realpath`); Task 3b holds every open.

**Rulings (pre-dispatch):**
- **M8R14** [3a, all path routes] Paths are absolute and canonical (no empty, `.` or `..` segment, no NUL, ≤ 4 096 bytes); anything else is `malformed` → `not_found` at the route (zod already refuses relative paths and NUL with `bad_request`) — refusing `..` instead of resolving it removes the collapse-order class (pi-web #748) — cost if wrong: none; the web always sends canonical paths.
- **M8R15** [3a] Roots are the caller's project roots as stored (`ProjectsPort.roots(ownerId)`: real paths taken when the project was made, never resolved again, so a root later replaced by a symlink contains nothing). A path is inside when its spelling is inside a root **and** its real path (symlinks followed) is inside a root — cost if wrong: a project folder moved behind a symlink needs its project re-made.
- **M8R16** [3a] *(corrected: RT-02, RT-04, agreement 6, owner c3, f8, f10)* Refused for every intent and every caller, judged on the spelled and the real path: `$PAP_HOME` and below (`pap_home`; except folders in `BoundaryConfig.papHomeOpen`, empty in M8, M9 adds `worktrees`, R97); `<agentDir>/{auth,models,mcp,trust,settings}.json` and `<agentDir>/sessions/**` (`pi_private`: M7's Settings is their only reader and writer, masked and behind a step-up). What a write needs (`Protection`, the stricter of both spellings): `step_up` under `<agentDir>` and under any `.pi` segment (Pi loads code and settings from there); `confirm` for M5's protected names (M8R5) and for a dot-entry directly in the home folder when one of the caller's roots is the home folder or above it (owner f8: `~/.bashrc`, `~/.ssh/**`, `~/.config/**`; `~/proj/a.ts` stays ordinary); `none` otherwise — cost if wrong: M7's masks and step-up bypassed, or dotfiles written without a question.
- **M8R19** [3a] *(corrected: RT-14)* `ProjectsPort.roots(ownerId)` returns every project root of the owner (projects with only archived sessions included) in one indexed query, newest first (`ORDER BY created_at DESC LIMIT 2000`; `MAX_PROJECTS` is 2 000, so nothing is ever cut) — cost if wrong: none.
- **M8R101** [3a, 6a, 6b, 13] *(new: RT-03, agreement 5, owner c3)* `gateWrite({ protection, caller, confirmProtected, now })` is the one write gate: a token → `forbidden` when it sends `confirmProtected` or the path has any protection, else ok; a browser session → `protected_path` without `confirmProtected` on a protected path, then `step_up_required` on a `step_up` path unless `caller.stepUpUntil > now` (M5's 5-minute step-up, the same rule as `auth/step-up.ts`, which the files module cannot import). The password never replaces the confirmation: the ask always shows — cost if wrong: delayed code execution through a token, or a silent save into `.pi/`.
- **M8R102** [3a, 3b, 5, 9, 13] *(new: RT-02, RT-04, owner f8, f10)* A token (`caller: "token"`) never sees (`token_hidden` → `not_found`, listed as a protected entry): anything under `<agentDir>`; a file named `.mcp.json`, or `mcp.json` in a `.pi` folder (MCP server commands and headers); home's dot-entries under the M8R16 condition. The same name judgement (`judgeName`) runs on the descriptor (Task 3b) and on vcs blob sides (Task 9) — cost if wrong: a script token reads `~/.ssh` or MCP headers.
- **M8R118** [3a, 5] `BoundaryConfig.home` holds the daemon's home folder, both spellings, from a new `Config.userHome` (`input.homedir` in `kernel/config.ts`; the test harness passes its temporary `user` folder, the one it gives workers as `HOME`): tests never judge against the real `~` — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/kernel/fs/boundary.ts`, `boundary.test.ts`, `boundary.hostile.test.ts`, `boundary.gate.test.ts`
- Modify: `apps/daemon/src/modules/projects/{index,service,store}.ts` (`roots`), `service.test.ts`

**Interfaces:**
- Consumes: Task 1 `isProtectedName`; M4 projects store.
- Produces: `judgePath(path, scope, intent)`, `judgeName(candidate, scope)`, `protectionOf(candidate, scope)`, `gateWrite(input)`, `entryIsProtected(candidate, scope)`, `within`, `canonical`, `BoundaryConfig`, `Scope`, `CallerKind`, `Protection`, `Judgement`, `PI_CONFIG_FILES`, `ProjectsPort.roots(ownerId): readonly string[]`.

The judge and the write gate (binding; run in scratch against hard links, swapped folders, a home root and tokens before it was written here):

```ts
// apps/daemon/src/kernel/fs/boundary.ts
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isProtectedName } from "@pap/contracts";

export const MAX_PATH_BYTES = 4096;
/** Pi's configuration and credentials: M7's Settings is their only reader and writer (agreement 6, M8R16). */
export const PI_CONFIG_FILES = ["auth.json", "models.json", "mcp.json", "trust.json", "settings.json"] as const;

export interface BoundaryConfig {
  /** `$PAP_HOME` as configured and as it resolves: a link on either side cannot hide it. */
  readonly papHome: readonly string[];
  /** Pi's agent directory, both spellings. */
  readonly agentDir: readonly string[];
  /** The daemon's home folder, both spellings: a root at or above it protects home's dot-entries (M8R16, owner f8). */
  readonly home: readonly string[];
  /** Folders under `$PAP_HOME` the owner may browse: none in M8 (M9 adds `worktrees`, R97). */
  readonly papHomeOpen: readonly string[];
}

export type Intent = "list" | "read" | "write";
export type CallerKind = "session" | "token";
/** What a write needs (M8R16, M8R101): nothing, the "Save anyway?" confirmation, or the confirmation and a live step-up. */
export type Protection = "none" | "confirm" | "step_up";
export type NameRefusal = "pap_home" | "pi_private" | "token_hidden";
export type Refusal = "malformed" | "outside" | "missing" | NameRefusal;

/** Who asks, and where they may look: every judgement and every re-judgement of a descriptor takes it. */
export interface Scope {
  readonly roots: readonly string[];
  readonly config: BoundaryConfig;
  readonly caller: CallerKind;
}

export type Judgement =
  | {
      readonly ok: true;
      /** Where the path really leads; for a new file, its real folder plus its name. */
      readonly real: string;
      /** The root that holds `real`. */
      readonly root: string;
      readonly protection: Protection;
      readonly exists: boolean;
    }
  | { readonly ok: false; readonly why: Refusal };

export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Absolute, no empty, `.` or `..` segment, no NUL, at most 4 096 bytes (M8R14). */
export function canonical(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return false;
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return false;
  if (path === "/") return true;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const segmentsOf = (path: string): string[] =>
  path
    .split(sep)
    .filter(Boolean)
    .map((segment) => segment.normalize("NFC").toLowerCase());

/** `~/.bashrc`, `~/.ssh/id_ed25519`, `~/.config/x`, when one of the caller's roots is home or above it (owner f8). */
function homeDotEntry(candidate: string, scope: Scope): boolean {
  return scope.config.home.some(
    (home) =>
      candidate !== home &&
      within(home, candidate) &&
      relative(home, candidate).startsWith(".") &&
      scope.roots.some((root) => within(root, home)),
  );
}

const inAgentDir = (candidate: string, config: BoundaryConfig): boolean =>
  config.agentDir.some((dir) => within(dir, candidate));

/** The refusals that need no filesystem, for one spelling (M8R16, M8R102): pap's data, Pi's private files, what a token never sees. */
export function judgeName(candidate: string, scope: Scope): NameRefusal | null {
  const { config } = scope;
  const papHome = config.papHome.some(
    (home) =>
      within(home, candidate) && !config.papHomeOpen.some((open) => within(join(home, open), candidate)),
  );
  if (papHome) return "pap_home";
  const piPrivate = config.agentDir.some(
    (dir) =>
      within(join(dir, "sessions"), candidate) || PI_CONFIG_FILES.some((name) => candidate === join(dir, name)),
  );
  if (piPrivate) return "pi_private";
  if (scope.caller !== "token") return null;
  const segments = segmentsOf(candidate);
  const last = segments.at(-1) ?? "";
  const mcpList = last === ".mcp.json" || (last === "mcp.json" && segments.at(-2) === ".pi");
  return mcpList || inAgentDir(candidate, config) || homeDotEntry(candidate, scope) ? "token_hidden" : null;
}

const RANK: Readonly<Record<Protection, number>> = { none: 0, confirm: 1, step_up: 2 };

/** What a write to this spelling needs (M8R16, owner c3): Pi's folders the step-up, M5's names and home's dot-entries a confirmation. */
export function protectionOf(candidate: string, scope: Scope): Protection {
  if (inAgentDir(candidate, scope.config) || segmentsOf(candidate).includes(".pi")) return "step_up";
  return isProtectedName(candidate) || homeDotEntry(candidate, scope) ? "confirm" : "none";
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function landing(path: string, intent: Intent): Promise<{ real: string; exists: boolean } | null> {
  const real = await realOrNull(path);
  if (real !== null) return { real, exists: true };
  if (intent !== "write") return null;
  const folder = await realOrNull(dirname(path));
  return folder === null ? null : { real: join(folder, basename(path)), exists: false };
}

export async function judgePath(path: unknown, scope: Scope, intent: Intent): Promise<Judgement> {
  if (!canonical(path)) return { ok: false, why: "malformed" };
  const target = await landing(path, intent);
  if (target === null) return { ok: false, why: "missing" };
  const { real, exists } = target;
  const root = scope.roots.find((candidate) => within(candidate, real));
  if (root === undefined || !scope.roots.some((candidate) => within(candidate, path)))
    return { ok: false, why: "outside" };
  const refused = judgeName(path, scope) ?? judgeName(real, scope);
  if (refused !== null) return { ok: false, why: refused };
  const spelled = protectionOf(path, scope);
  const landed = protectionOf(real, scope);
  return { ok: true, real, root, protection: RANK[spelled] >= RANK[landed] ? spelled : landed, exists };
}

/** A listing shows an entry the caller may not open as `protected: true`, never browsable (M8R25). */
export function entryIsProtected(candidate: string, scope: Scope): boolean {
  return judgeName(candidate, scope) !== null;
}

export type WriteGate = "ok" | "forbidden" | "protected_path" | "step_up_required";

/** M8R101 (RT-03, agreement 5, owner c3): tokens never write a protected file nor confirm; the owner confirms, and steps up for Pi's folders. */
export function gateWrite(input: {
  readonly protection: Protection;
  readonly caller: { readonly kind: CallerKind; readonly stepUpUntil: number };
  readonly confirmProtected: boolean;
  readonly now: number;
}): WriteGate {
  if (input.caller.kind === "token")
    return input.confirmProtected || input.protection !== "none" ? "forbidden" : "ok";
  if (input.protection === "none") return "ok";
  if (!input.confirmProtected) return "protected_path";
  if (input.protection === "step_up" && input.caller.stepUpUntil <= input.now) return "step_up_required";
  return "ok";
}
```

- [ ] **Step 1: Write the failing tests** (temporary folders: `base/home/` as the home folder, `home/.pap/` as `$PAP_HOME` with `state.db`, `home/.pi/agent/` as Pi's directory with `auth.json`, `models.json`, `settings.json`, `sessions/x/a.jsonl`, `extensions/e.ts`; `home/proj/` with `a.txt`, `.git/hooks/`, `.pi/mcp.json`, `.mcp.json`; `home/.bashrc`, `home/.ssh/id`; `base/outside/secret.txt`; never `~`)
  - `boundary.test.ts`: inside file → ok with `real`, `root`, `exists: true`, `protection: "none"`; a new file in an existing folder with `write` → ok, `exists: false`; the same with `read` → `missing`; `/` alone is canonical; `protection` is `confirm` for `proj/.git/config` and `proj/.envrc`, `step_up` for `proj/.pi/settings.json` and `agent/extensions/e.ts` (agent inside a root), `none` for `proj/src/a.ts`; with roots `[home]`: `home/.bashrc` and `home/.ssh/id` are `confirm`, `home/proj/a.txt` is `none`; with roots `[proj]` only: `home/.bashrc` → `outside`; `$PAP_HOME/state.db` → `pap_home` whether reached as spelled or through a link `proj/h → home/.pap`; with `papHomeOpen: ["worktrees"]`, `.pap/worktrees/x` inside a root is ok and `.pap/state.db` is still refused; `agent/auth.json`, `agent/models.json`, `agent/mcp.json`, `agent/trust.json`, `agent/settings.json` and `agent/sessions/x/a.jsonl` → `pi_private`, also through a link and with `write`; a token (`caller: "token"`) with roots `[home]`: `home/.ssh/id` → `token_hidden`, `agent/extensions/e.ts` → `token_hidden`, `proj/.pi/mcp.json` and `proj/.mcp.json` → `token_hidden`, `proj/a.txt` → ok; the browser session reads `proj/.pi/mcp.json` (ok, `step_up`) and `proj/.mcp.json` (ok, `none`); `entryIsProtected` true for `home/.pap`, `agent/sessions`, and for `home/.ssh` only when the caller is a token.
  - `boundary.hostile.test.ts`: each returns the refusal named — `proj/../outside/secret.txt` (malformed), `proj/./a` (malformed), `proj//a` (malformed), `proj/a/` (malformed), `proj/a\u0000b` (malformed), a 4 097-byte path (malformed), a relative path (malformed), `123` (malformed), `proj/link-out/secret.txt` where `link-out → ../../outside` (outside), `proj/lnk/../x` (malformed: the `..` that would follow `lnk → outside/deep` never resolves), `outside/back → ../home/proj/a.txt` judged as `<tmp>/outside/back` (outside: the spelling is outside), `proj/%2e%2e/outside` (missing: just a strange name), `proj/loop` where `loop → loop` (missing), `proj/cwd → /proc/self/cwd` (outside), `proj/root → /proc/self/root` (outside), a root that was replaced by a link to `/` after the project was made (outside).
  - `boundary.gate.test.ts` (pure): token + `none` → ok; token + `confirmProtected` on an ordinary path → `forbidden`; token + `confirm` or `step_up` → `forbidden` with or without the flag; session + `confirm` without the flag → `protected_path`, with it → ok; session + `step_up` without the flag → `protected_path` even with a live step-up; with the flag and `stepUpUntil === now` → `step_up_required`; with `stepUpUntil === now + 1` → ok.
  - projects `service.test.ts`: `roots("u1")` returns the two roots of u1, newest first, and none of u2's.
- [ ] **Step 2: Run them, see them fail** — `pnpm test:unit apps/daemon/src/kernel/fs apps/daemon/src/modules/projects` → FAIL.
- [ ] **Step 3: Implement** `boundary.ts` as prescribed, and `roots` (store `SELECT root FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 2000`).
- [ ] **Step 4: Mutation checks** — remove the `scope.roots.some(... within(candidate, path))` clause: the spelled-outside-link case fails; remove the `homeDotEntry` term of `protectionOf`: the `home/.bashrc` confirm case fails; return `"ok"` for a token with `confirmProtected`: the gate case fails; drop `models.json` from `PI_CONFIG_FILES`: the `pi_private` case fails. Say which test failed in the report.
- [ ] **Step 5: Gate** (unit) and commit:

```bash
git add apps/daemon/src/kernel/fs apps/daemon/src/modules/projects
git commit -m "feat(kernel): the path judge with Pi config, home dot-entries, token rules and the write gate"
```

---

### Task 3b: The checked open and write — a deny set of private inodes, the descriptor re-judged, an atomic write, upload names

Task 3a judges names; a name can lie. A hard link `proj/notes.txt → ~/.pi/agent/auth.json` (the agent may create one: same filesystem, the owner's file) passes every name rule, and a folder swapped for a link after the judgement moves an open elsewhere (RT-01, verified on the M8 draft). This task opens every client path, re-runs 3a's whole name judgement on where the descriptor really is, and refuses any file whose `(dev, ino)` is one of pap's or Pi's private files.

**Rulings (pre-dispatch):**
- **M8R17** [3b] *(corrected: RT-01)* `openRegularFile(real, guard)` opens with `O_NOFOLLOW | O_NONBLOCK`, refuses anything but a regular file after `fstat`, then on Linux reads `/proc/self/fd/<fd>` and refuses (`moved`) a descriptor that is not inside the judged root **or** that `judgeName` refuses (pap's home, Pi's private files, a token's hidden names), then refuses (`denied`) a descriptor whose `fstat` `(dev, ino)` is in the deny set (M8R103). Where `/proc` is missing (macOS, tier 2) only the final component and the inode are checked (written in `files.md`). A FIFO never blocks the daemon — cost if wrong: `auth.json` and `state.db` served through a hard link or a swap.
- **M8R18** [3b, 6a, 6b, 7] *(corrected: RT-01, RT-13, RT-39)* `writeAtomic` writes a temporary file beside the target (`.pap-<12 hex>.tmp`, `O_CREAT | O_EXCL | O_NOFOLLOW`), checks its descriptor exactly like M8R17 (the same full re-judgement: a temp that landed in `$PAP_HOME` through a swapped folder is refused and removed), sets the mode with `fchmod` (the daemon's umask is 077: an `open` mode alone would give 0600), syncs, refuses (`denied`) a target that already exists and whose inode is in the deny set (a hard link to a private file, or a case-insensitive spelling of `settings.json`: never replaced either), then `rename`s (replace) or `link`s then unlinks (no replace: `EEXIST` → `exists`). On a filesystem without hard links (`EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS` from `link`: vfat, some FUSE or CIFS mounts) it checks with `lstat` then `rename`s. Any failure removes the temporary file. A target that is a link inside the roots is written through: the real file changes, the link stays. `BoundaryError` declares its `reason` field (no parameter property: erasable syntax only). Residuals (in `files.md`): a process swapping a folder between the temporary file's check and the rename can redirect one write (a local process with write access can write there anyway); the `lstat`-then-`rename` window on filesystems without hard links — cost if wrong: a half-written file is impossible by construction; only the residuals.
- **M8R103** [3b, 5, 6a, 9] *(new: RT-01)* The deny set (`createDenySet`, one per daemon, built in `compose-workspace.ts`): single files `<agentDir>/{auth,models,mcp,trust,settings}.json` (both spellings; `stat` follows links, so a dotfiles `models.json` is denied at its target) and `$PAP_HOME/{state.db,state.db-wal,state.db-shm,pap.lock}`; folders walked whole: `<agentDir>/sessions`, `$PAP_HOME/{secrets,backups,exports,fork-tmp}`. The walk reads at most 50 000 entries; it runs at the first check and again whenever a file with two or more links changed (`ctime`) after the last walk started (linking changes the ctime), so a hard link to a session file created a second ago is caught; a linked file still not covered by a walk that started after its change, or any linked file when the walk was cut at 50 000, is refused (fail closed). A file with one link is denied only as a known inode (a case-folded spelling or a bind mount of a private file). It compares ctimes with the clock's `now()`: production passes the system clock, its tests too — cost if wrong: one walk too many on a pnpm `node_modules` (files with old ctimes never trigger one).
- **M8R104** [3b, 5] *(new: RT-15)* `openFolder(real, guard)` opens a folder `O_DIRECTORY | O_NOFOLLOW`, re-judges its descriptor like M8R17 and gives the listing a `/proc/self/fd/<fd>` path to read (`readdir`, `lstat` of each entry through it), so a folder swapped for a link after the judgement lists nothing from outside; without `/proc` it lists by path (residual in `files.md`) — cost if wrong: names (never contents) from outside the root in a listing.

**Files:**
- Create: `apps/daemon/src/kernel/fs/deny-set.ts`, `safe-open.ts`, `names.ts`, `deny-set.test.ts`, `safe-open.test.ts`, `names.test.ts`

**Interfaces:**
- Consumes: Task 3a `within`, `judgeName`, `Scope`; Task 1 `INVISIBLE`; kernel `Clock`.
- Produces: `createDenySet(sources, clock): DenySet`, `DenySources`, `DenyStat`; `openRegularFile(real, guard)`, `openFolder(real, guard)`, `writeAtomic(input, link?)`, `OpenGuard`, `AtomicWrite`, `BoundaryError`, `BoundaryReason`, `isTempName`; `uploadName(raw)`.

The deny set (binding):

```ts
// apps/daemon/src/kernel/fs/deny-set.ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../clock.ts";

/** Entries read per walk, at most; past it the set cannot vouch for a linked file and refuses it (fail closed). */
export const DENY_WALK_MAX = 50_000;

export interface DenySources {
  /** Single files: `<agentDir>/{auth,models,mcp,trust,settings}.json`, `$PAP_HOME/{state.db,state.db-wal,state.db-shm,pap.lock}`. */
  readonly files: readonly string[];
  /** Folders walked whole: `<agentDir>/sessions`, `$PAP_HOME/{secrets,backups,exports,fork-tmp}`. */
  readonly folders: readonly string[];
}

export interface DenyStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly ctimeMs: bigint;
}

export interface DenySet {
  /** M8R103 (RT-01): the file is one of pap's or Pi's private files reached under another name (hard link, swapped folder, case-folded spelling). */
  has(stat: DenyStat): Promise<boolean>;
}

const keyOf = (st: { readonly dev: bigint; readonly ino: bigint }): string => `${st.dev}:${st.ino}`;

export function createDenySet(sources: DenySources, clock: Clock, max: number = DENY_WALK_MAX): DenySet {
  let keys = new Set<string>();
  let capped = false;
  let builtAt: number | null = null;
  let building: Promise<void> | null = null;

  async function build(): Promise<void> {
    const startedAt = clock.now();
    const next = new Set<string>();
    const add = async (path: string): Promise<void> => {
      try {
        next.add(keyOf(await stat(path, { bigint: true })));
      } catch {
        // missing or unreadable: nothing to deny under that name
      }
    };
    for (const file of sources.files) await add(file);
    let seen = 0;
    const stack = [...sources.folders];
    walk: while (stack.length > 0) {
      const folder = stack.pop() as string;
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++seen > max) break walk;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile()) await add(path);
      }
    }
    keys = next;
    capped = seen > max;
    builtAt = startedAt;
  }

  const refresh = (): Promise<void> =>
    (building ??= build().finally(() => {
      building = null;
    }));

  return {
    async has(st) {
      if (builtAt === null) await refresh();
      if (keys.has(keyOf(st))) return true;
      // A hard link leaves nlink >= 2 on both names; a file with one name is private only as a known inode.
      if (st.nlink < 2n) return false;
      // Linking a file changes its ctime: one linked after a walk started may be a new private file. Two tries,
      // because a walk already running may have started before the link; still not covered: refuse (fail closed).
      const changedSinceWalk = (): boolean => Number(st.ctimeMs) >= (builtAt ?? 0);
      for (let tries = 0; tries < 2 && changedSinceWalk(); tries++) {
        await refresh();
        if (keys.has(keyOf(st))) return true;
      }
      return capped || changedSinceWalk();
    },
  };
}
```

The open and the write (binding):

```ts
// apps/daemon/src/kernel/fs/safe-open.ts
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link as linkPath, lstat, open, readlink, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { judgeName, type Scope, within } from "./boundary.ts";
import type { DenySet } from "./deny-set.ts";

export type BoundaryReason = "not_regular" | "moved" | "denied" | "too_large" | "exists";

export class BoundaryError extends Error {
  readonly reason: BoundaryReason;

  constructor(reason: BoundaryReason) {
    super(reason);
    this.name = "BoundaryError";
    this.reason = reason;
  }
}

/** What must still hold once a descriptor exists (M8R17): the judged root, no refused name, no private inode. */
export interface OpenGuard extends Scope {
  readonly root: string;
  readonly deny: DenySet;
}

/** Where an open descriptor really is (Linux /proc); null where /proc is not mounted. */
async function descriptorPath(handle: FileHandle): Promise<string | null> {
  try {
    return await readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    return null;
  }
}

/** The full name judgement again, on where the descriptor landed (a folder swapped for a link meanwhile). */
async function checkPlace(handle: FileHandle, guard: OpenGuard): Promise<string | null> {
  const where = await descriptorPath(handle);
  if (where !== null && (!within(guard.root, where) || judgeName(where, guard) !== null))
    throw new BoundaryError("moved");
  return where;
}

async function checkDescriptor(handle: FileHandle, guard: OpenGuard): Promise<void> {
  await checkPlace(handle, guard);
  if (await guard.deny.has(await handle.stat({ bigint: true }))) throw new BoundaryError("denied");
}

/** A regular file the boundary accepted, opened for reading (M8R17). The caller closes it. */
export async function openRegularFile(real: string, guard: OpenGuard): Promise<FileHandle> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new BoundaryError("not_regular");
    await checkDescriptor(handle, guard);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** A folder the boundary accepted, held open while it is listed (M8R104, RT-15): read it through `path`, then `close`. */
export async function openFolder(
  real: string,
  guard: OpenGuard,
): Promise<{ readonly path: string; close(): Promise<void> }> {
  const handle = await open(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const where = await checkPlace(handle, guard);
    return { path: where === null ? real : `/proc/self/fd/${handle.fd}`, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export interface AtomicWrite {
  readonly real: string;
  readonly guard: OpenGuard;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly maxBytes: number;
  /** The existing file's mode, or `0o666 & ~workerUmask` for a new one (R114). */
  readonly mode: number;
  /** False: an existing target at rename time is `exists`, never replaced. */
  readonly replace: boolean;
}

/** Errors of `link` on a filesystem without hard links (vfat, some FUSE or CIFS mounts). */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

async function placeNew(temp: string, real: string, link: typeof linkPath): Promise<void> {
  try {
    await link(temp, real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") throw new BoundaryError("exists");
    if (!NO_HARD_LINKS.has(code)) throw error;
    // M8R18 (RT-39): check, then rename. A file created between the two is replaced (residual, files.md).
    const taken = await lstat(real).then(
      () => true,
      () => false,
    );
    if (taken) throw new BoundaryError("exists");
    await rename(temp, real);
    return;
  }
  await unlink(temp);
}

/** M8R18. Returns the bytes written; leaves no temporary file behind on any path. `link` is a seam for RT-39's test. */
export async function writeAtomic(input: AtomicWrite, link: typeof linkPath = linkPath): Promise<number> {
  const temp = join(dirname(input.real), `.pap-${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  try {
    await checkDescriptor(handle, input.guard);
    await handle.chmod(input.mode);
    let total = 0;
    for await (const chunk of input.chunks) {
      total += chunk.byteLength;
      if (total > input.maxBytes) throw new BoundaryError("too_large");
      for (let done = 0; done < chunk.byteLength; ) {
        done += (await handle.write(chunk, done, chunk.byteLength - done)).bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    closed = true;
    // A private file under another name (a hard link, a case-insensitive spelling) is never replaced either.
    const target = await lstat(input.real, { bigint: true }).catch(() => null);
    if (target !== null && (await input.guard.deny.has(target))) throw new BoundaryError("denied");
    if (input.replace) await rename(temp, input.real);
    else await placeNew(temp, input.real, link);
    return total;
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export const isTempName = (name: string): boolean => /^\.pap-[0-9a-f]{12}\.tmp$/.test(basename(name));
```

Upload names (binding):

```ts
// apps/daemon/src/kernel/fs/names.ts
import { INVISIBLE } from "@pap/contracts";

/** A file name a client may create: one segment, NFC, visible characters, no surrounding blanks, ≤ 255 bytes. */
export function uploadName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC");
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return null;
  if (name !== name.trim() || INVISIBLE.test(name) || Buffer.byteLength(name) > 255) return null;
  return name;
}
```

- [ ] **Step 1: Write the failing tests** (Task 3a's bed; the deny set built from it with the system clock; every case asserts the secret text never comes back)
  - `deny-set.test.ts`: `has` is true for the inode of `agent/auth.json`, `agent/models.json` (also when `models.json` is a link to `home/dotfiles/models.json`: the target is denied), `.pap/state.db`, `.pap/secrets/k`, a file of `.pap/backups/`, `agent/sessions/x/a.jsonl`; false for `proj/a.txt`; a session file created **after** the first walk and linked at once → true (the ctime rule); an ordinary file linked twice inside `proj` → false; with `DENY_WALK_MAX` reached (a bed of 50 001 entries is too slow: `createDenySet(sources, clock, 10)`, the third parameter defaulting to `DENY_WALK_MAX`) any linked unknown file → true, a one-link unknown file → false; two concurrent `has` calls run one walk.
  - `safe-open.test.ts`: reads a regular file; **a hard link `proj/notes.txt → agent/auth.json` → `BoundaryError("denied")`**; the same for `.pap/state.db`, `.pap/secrets/k`, an old session file and one created a moment ago; an ordinary file with two names inside the root is served; **with roots `[home]`, `home/x/plain.txt` judged, then `x` swapped for a link to `home/.pap` (holding a `plain.txt` the deny set does not list) → `BoundaryError("moved")`** (the name re-judgement alone) and, with `x/state.db`, `moved` too; `writeAtomic` through that swapped folder → `moved`, `.pap/state.db` intact, no `.pap-*.tmp` left in `.pap`; `writeAtomic` with `replace: true` over the hard link `proj/notes.txt` → `denied`, `auth.json` intact, no temp left; a FIFO in the root → `BoundaryError("not_regular")` and the test completes (no hang: `O_NONBLOCK`); a final-component link swapped in after `judgePath` → `ELOOP`; `openRegularFile` of `proj/.pi/mcp.json` with a token's guard → `moved` (the descriptor re-judgement applies a token's names too); `openFolder` lists `home/x` through a `/proc/self/fd/` path (names and `lstat` right); `openFolder` after `x` became a link → an error (`ENOTDIR` from `O_NOFOLLOW`); after a middle folder became a link into `.pap` → `moved`; `writeAtomic` creates `0o644` with `mode: 0o644` while the process umask is 077; `replace: false` over an existing file → `exists`, original intact, no `.pap-*.tmp` left; a `link` seam that throws `EPERM` → the file is written by `rename`, and a second such write over it → `exists`; a chunk stream that passes `maxBytes` → `too_large`, no file, no temp; a stream that throws mid-way → original intact, no temp; writing through a link inside the root changes the target and keeps the link.
  - `names.test.ts`: refused: `""`, `.`, `..`, `a/b`, `a\b`, ` a`, `a `, `a\u202Eb.txt`, `a\u200Bb`, `a\u0007b`, 256 bytes of `é`; accepted: `report.pdf`, `Été 2026.md` (NFC of an NFD input), `CON` (not Windows).
- [ ] **Step 2: Run them, see them fail** — `pnpm test:unit apps/daemon/src/kernel/fs` → FAIL on the missing exports.
- [ ] **Step 3: Implement** the three files as prescribed.
- [ ] **Step 4: Mutation checks** — drop the deny check in `checkDescriptor`: "a hard link to auth.json" fails (it returns the secret); drop `judgeName` from `checkPlace`: "a folder swapped into `$PAP_HOME`" with `plain.txt` fails (it returns the file); drop the ctime refresh: "a session created a moment ago" fails; remove `O_NONBLOCK`: the FIFO test times out (run once with a 5 s `vi.waitFor` to show it, then restore). Say which test failed in the report.
- [ ] **Step 5: Gate** (unit) and commit:

```bash
git add apps/daemon/src/kernel/fs
git commit -m "feat(kernel): an open and an atomic write re-judged on the descriptor, with a deny set of private inodes"
```

---

### Task 4: Git, run safely — fixed flags, a scrubbed environment, bounded output and concurrency

Spec C §1.1: "child: git / gh (execFile, no shell)". The `files` module (ignore marks, the mention index) and the `vcs` module (status, diffs) run git only through this runner. pi-web (`lib/git-changes.ts`) turned off fsmonitor and hooks; pap also turns off what reaches the network or runs a configured program for the commands it uses.

**Rulings (pre-dispatch):**
- **M8R20** [4] Every call is `git --no-optional-locks --literal-pathspecs -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c diff.external= -c protocol.allow=never -c credential.helper= -C <root> <subcommand> …`. Command-line `-c` beats every config file (an `include.path` too). `--no-optional-locks`: polling `git status` never takes `index.lock` from the owner's own git. Diff commands also pass `--no-ext-diff --no-textconv`; blobs are read with `cat-file blob` (no filters, no textconv). Residual (in `files.md`): clean/smudge filter drivers configured in the owner's or the repository's config run as they do for the owner's own `git status` (git-lfs); M5 asks before the agent writes `.git/config` — cost if wrong: one flag.
- **M8R21** [4] *(corrected: RT-16)* The environment is an allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, `XDG_CONFIG_HOME` from the daemon, then `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_PAGER=cat`, `PAGER=cat`, and per call `GIT_CEILING_DIRECTORIES=dirname(root)`: git looks for the repository in the root itself and never above it, so a root without a usable `.git` (M4 keeps a folder on `EACCES` or past 64 levels) is `repo: false` instead of the repository above it, whose `HEAD:<path>` blobs lie outside the root (verified in scratch: a non-repository subfolder of a repository → "not a git repository"; the repository's own root still works). No inherited `GIT_*` (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*`), no `LD_PRELOAD` — cost if wrong: a git that needs another variable (none known).
- **M8R22** [4] At most 4 git processes at once daemon-wide, 64 waiting; the 65th is refused with `PapError("capacity")` (refuse, never evict). Each call has a deadline (10 s default, killed with SIGKILL) and an output cap (`maxBytes`, default 8 MiB); failures are typed `git_missing` (ENOENT), `timeout`, `too_large`, `failed` (exit code not in `okCodes`), logged as `git_failed` with the subcommand and the first 300 characters of stderr only — cost if wrong: a slow repository waits its turn.
- **M8R23** [4, 9] Paths and refs reach git only as: pathspecs after `--` (literal), `<oid>:<repo path>` / `HEAD:<repo path>` / `:<repo path>` arguments built from a validated `RepoPath` (relative, canonical) and a validated oid (40 or 64 lower-case hex). No client string is ever a ref name or an option — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/kernel/git/{exec,runner,porcelain,numstat}.ts`, `exec.test.ts`, `runner.test.ts`, `porcelain.test.ts`, `numstat.test.ts`, `exec.int.test.ts`
- Modify: `knip.json` only if the new files need it (they should not)

**Interfaces:**
- Produces: `gitArgs(root, args)`, `gitEnv(base, root)`, `createGitRunner(deps): GitRunner`, `GitRunner.run(root, args, options?) → Promise<{ stdout: Buffer; code: number }>`, `GitError { kind: "git_missing" | "timeout" | "too_large" | "failed" }`, `parsePorcelainV2(out: Buffer): PorcelainStatus`, `parseNumstat(out: Buffer): Map<string, { additions: number | null; deletions: number | null }>` (binary rows `-\t-` → nulls).

The arguments and environment (binding):

```ts
// apps/daemon/src/kernel/git/exec.ts
/** Config that would run a program or reach the network, switched off on every call (M8R20). */
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "diff.external=",
  "protocol.allow=never",
  "credential.helper=",
] as const;

export function gitArgs(root: string, args: readonly string[]): string[] {
  return [
    "--no-optional-locks",
    "--literal-pathspecs",
    ...SAFE_CONFIG.flatMap((pair) => ["-c", pair]),
    "-C",
    root,
    ...args,
  ];
}

const KEPT = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "XDG_CONFIG_HOME"] as const;

/** M8R21: an allowlist, and a ceiling at the root's parent so discovery never climbs above the root (RT-16). */
export function gitEnv(base: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEPT) if (base[key] !== undefined) env[key] = base[key];
  return {
    ...env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CEILING_DIRECTORIES: dirname(root),
  };
}
```

(`exec.ts` imports `dirname` from `node:path`.) `runner.ts` calls `execFile("git", gitArgs(root, args), { env: gitEnv(deps.env, root), encoding: "buffer", maxBuffer: maxBytes, timeout: timeoutMs, killSignal: "SIGKILL", shell: false, windowsHide: true })` behind the M8R22 semaphore.

- [ ] **Step 1: Write the failing tests**
  - `exec.test.ts`: `gitArgs("/r", ["status"])` equals the exact array above ending in `"-C", "/r", "status"`; `gitEnv({ PATH: "/bin", HOME: "/h", GIT_DIR: "/x", GIT_EXTERNAL_DIFF: "evil", LD_PRELOAD: "/l.so", PAP_X: "1", NODE_OPTIONS: "--x", GIT_CEILING_DIRECTORIES: "/" }, "/srv/p")` equals `{ PATH, HOME, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", PAGER: "cat", GIT_CEILING_DIRECTORIES: "/srv" }` exactly.
  - `runner.test.ts` (injected `exec`): four calls run at once and a fifth waits until one settles; with 4 running and 64 waiting the next call rejects `capacity`; a rejected or timed-out call frees its slot; `ENOENT` → `git_missing`; `killed` with `SIGKILL` → `timeout`; `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` → `too_large`; exit 1 with `okCodes: [0, 1]` resolves; exit 128 rejects `failed` and the log line holds the subcommand and at most 300 characters of stderr.
  - `porcelain.test.ts` (`-z` fixtures): branch headers (`# branch.oid (initial)`, a detached head, `# branch.ab +3 -1`, no upstream); ordinary `1 .M`, `1 A.`, `1 D.`, `1 .T`; renamed `2 R. … R100` with its original path; copied `2 C.`; unmerged `u UU`; untracked `?`; ignored `!` skipped; submodule flag `S.M.`; a path with a space, one with a newline and one starting with `-` come back exact; an unknown record type is skipped and the rest still parsed.
  - `numstat.test.ts` (`-z`): `12\t3\tpath`, binary `-\t-\tpath` → nulls, a rename `5\t1\t\0old\0new\0` keyed by `new`.
  - `exec.int.test.ts` (real git, a temporary repository, `HOME` temporary; each case writes a marker script and asserts the marker file is absent): `core.fsmonitor = <script>` in `.git/config` then `status` — no marker; `diff.external = <script>` then `diff HEAD` — no marker; `.gitattributes` `*.txt diff=evil` with `diff.evil.textconv = <script>` then `diff --no-textconv HEAD` — no marker; an `include.path` to a file setting `core.fsmonitor` — no marker; a submodule whose own `.git/config` sets `core.fsmonitor = <script>`, then `status --ignore-submodules=dirty` in the superproject — no marker (`-c` reaches submodules through `GIT_CONFIG_PARAMETERS`, RT-16); the runner started with `GIT_DIR=<another repo>` in its base environment reports this repository's branch; a root that is a plain folder inside a repository → `rev-parse` fails (`failed`, never the outer repository's top level); `git cat-file blob HEAD:-rf` for a committed file named `-rf` returns its content (no option parsed); a file named `a\nb` round-trips through `status --porcelain=v2 -z`.
- [ ] **Step 2: Run them, see them fail** — `pnpm test:unit apps/daemon/src/kernel/git && pnpm test:int apps/daemon/src/kernel/git` → FAIL.
- [ ] **Step 3: Implement** the four files.
- [ ] **Step 4: Mutation checks** — drop `-c core.fsmonitor=false`: the fsmonitor case fails; drop `diff.external=`: the external-diff case fails; keep `GIT_DIR` in the environment: the `GIT_DIR` case fails; drop `GIT_CEILING_DIRECTORIES`: the plain-folder-inside-a-repository case fails.
- [ ] **Step 5: Gate** (unit, int) and commit:

```bash
git add apps/daemon/src/kernel/git
git commit -m "feat(kernel): run git with fixed safety flags, an allowlisted environment and bounded output"
```

---

### Task 5: The `files` module — listing, reading, the `@` index, and the workspace composition

The read half of D04 (explorer, viewer, `@` mention source). pi-web's behaviour (`app/api/files/[...path]/route.ts`, `lib/file-tree-visibility.ts`, `docs/agents/files-and-access.md`) is the reference: hidden entries are visibility, never access.

**Rulings (pre-dispatch):**
- **M8R24** [5, 17] Listing order: folders first, then the rest, each by `name.toLowerCase()` then code points; `.git` and `.DS_Store` are never listed. In a git work tree, names git ignores (one `check-ignore -z --stdin --no-index` per listing, then `ls-files -z --cached --` over at most 200 of the ignored names: those holding a tracked path stay visible) are left out, or returned with `hidden: "ignored"` when `showIgnored`. Outside git, or when git fails or takes over 5 s, a fixed list (`node_modules dist build out target coverage .next .nuxt .venv venv __pycache__ .cache .turbo .parcel-cache`) gives `hidden: "excluded"` — pi-web's rule — cost if wrong: a few names shown or hidden.
- **M8R25** [5] *(corrected: RT-15, M8R102)* A folder is listed through `openFolder` (M8R104): its entries are `lstat`ed 32 at a time through the held descriptor. A link is resolved and judged: target inside the roots → `link: "inside"` (`linkDir` for a folder), outside → `"outside"` (owner f5: not browsable), unresolvable → `"broken"`. FIFOs, sockets and devices are `kind: "other"`. `protected: true` when `entryIsProtected` refuses the entry's spelled path or its link target for **this caller** (a token sees `~/.ssh`, `<agentDir>` and `.pi/mcp.json` as protected entries). At most 5 000 entries (`truncated`); the answer is fitted under `PAGE_BYTES` (900 000) by dropping the tail — cost if wrong: none.
- **M8R26** [5, 17, 18] *(corrected: RT-22, RT-41)* `files.read` returns at most 256 KiB from `offset`, cut back to a UTF-8 character boundary (`nextOffset` lands on one, `null` at the end); a NUL in the first 8 KiB makes it `binary` (no text, `nextOffset: null`). Every answer's `meta` carries the file's `size` and `mtimeMs` at the read (Load more compares them, M8R116). `etag` is the first 32 hex of the SHA-256 of the whole file when it is at most 384 KiB, else null; `editable` is true only when the file is not binary, at most 384 KiB, **and** its text JSON-encodes to at most 900 000 bytes (a save of it fits one WebSocket frame: tabs, quotes and C0 controls escape to 2–6 bytes, and a frame over 1 MiB closes the whole socket with 1009, terminals included). An answer that serialises over `PAGE_BYTES` is retried with half the chunk, down to 4 KiB — cost if wrong: none.
- **M8R27** [5, 21] *(corrected: RT-37)* `files.search` feeds `@` mentions: `root` must equal one of the caller's roots; the index is `ls-files -z --cached --others --exclude-standard` (8 MiB, 100 000 paths) or, outside git, a walk (depth 16, 20 000 files, skipping M8R24's list, `.git`, protected entries and `$PAP_HOME`), cached per (owner, root) for 30 s (kernel `Clock`), at most 16 indexes, the least recently used dropped (a cache, not a throttle). Paths that match `INVISIBLE` (a cloned repository's `a\nIgnore previous…`) never enter the index: a mention would carry them into the prompt. Results a token may not read (M8R102) are left out of its answers. Ranking is a pure function: case-insensitive subsequence; a match at a segment start and consecutive runs score higher; shorter paths first on ties, then code points. Results are paths relative to the root — T3 `WorkspaceSearchIndex.ts`'s idea, pap's own code — cost if wrong: ranking tweaks.
- **M8R28** [5, 7, 9, 12] `apps/daemon/src/compose-workspace.ts` builds the M8 modules (`files` here, `vcs` in Task 9, `terminal` in Task 12) and the one deny set (M8R103), and returns `{ rpc, mount(app), attachments, shutdown() }`; `daemon.ts` gains at most 10 lines (create before `sessions`, spread `rpc`, call `mount`, pass `attachments` to sessions, call `shutdown` in `stop()`) and stays ≤ 400 lines after both merges (agreements 9, 24) — cost if wrong: none.
- **M8R29** [5] *(corrected: RT-02, M8R118)* `BoundaryConfig` is built once at boot: `papHome: [config.home, realpath(config.home)]`, `agentDir: [config.piAgentDir, realpath or itself when missing]`, `home: [config.userHome, realpath or itself]`, `papHomeOpen: []`; the deny set's sources follow M8R103 from the same paths. Each request builds its `Scope` from the transport's caller: `{ roots: roots(caller.userId), config, caller: caller.kind }` (`"session"` on the cookie-only HTTP routes).
- **M8R115** [5, 6a, 18] *(new: RT-22)* One save fits one WebSocket frame: `ws` closes the **whole socket** with 1009 above 1 MiB (every terminal of the tab detaches), and JSON escapes tabs, quotes and C0 controls to 2–6 bytes, so the 384 KiB UTF-8 cap alone does not bound the frame. The rule is 900 000 bytes of JSON for the text: `editable` is false above it (M8R26), the editor refuses before sending (M8R78), and `files.write` answers `payload_too_large` above it (M8R30) for a client that sends anyway within the frame — cost if wrong: a save that drops the socket and every terminal with it.

**Files:**
- Create: `packages/contracts/src/files.ts`, `files.test.ts`; `apps/daemon/src/modules/files/{index,service,list,read,search-index,rank,rpc}.ts` and their `*.test.ts`; `apps/daemon/src/modules/files/files.int.test.ts`; `apps/daemon/src/compose-workspace.ts`
- Modify: `packages/contracts/src/{methods,methods.test,index}.ts` (one import, one spread); `apps/daemon/src/daemon.ts` (≤ 10 lines in total over Tasks 5, 8, 9, 12); `apps/daemon/src/kernel/config.ts` (`userHome`, + test); `apps/daemon/src/testing/harness.ts` (`userHome: join(root, "user")`, the folder it already gives workers as `HOME`)

**Interfaces:**
- Consumes: Task 3a `judgePath`, `entryIsProtected`, `Scope`, `ProjectsPort.roots`; Task 3b `openRegularFile`, `openFolder`, `createDenySet`; Task 4 `GitRunner`.
- Produces: `createFilesModule(deps: { roots(ownerId: string): readonly string[]; boundary: BoundaryConfig; deny: DenySet; git: GitRunner; clock: Clock; logger: Logger; workerUmask: number; attachmentsDir: string; readOnly: boolean }): FilesModule` with `rpc`, `mount(app: Hono, caller: HttpCaller)` (Tasks 6a, 6b), `attachments: AttachmentsPort` (Task 7); `createWorkspaceModules(deps): WorkspaceModules`; `FILE_LIMITS`, `FilePath`, `FileEntry`, `FileMeta`, `Etag`, `filesMethods`.

The contract (binding: it is the trust boundary of the explorer):

```ts
// packages/contracts/src/files.ts (Task 5 part; Task 6a adds files.write, Task 7 AttachmentView)
import { z } from "zod";
import { defineMethod } from "./define.ts";

export const FILE_LIMITS = {
  pathBytes: 4096,
  nameBytes: 255,
  listEntries: 5000,
  readChunkBytes: 256 * 1024,
  editableBytes: 384 * 1024,
  searchQuery: 128,
  searchResults: 50,
  uploadBytes: 25 * 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  attachmentsPerPrompt: 10,
  pendingPerOwner: 32,
  pendingBytesPerOwner: 200 * 1024 * 1024,
} as const;

/** An absolute path as a client sends it; the daemon's boundary decides the rest (M8R14). */
export const FilePath = z
  .string()
  .min(1)
  .max(FILE_LIMITS.pathBytes)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "an absolute path");
export const Etag = z.string().regex(/^[0-9a-f]{32}$/);

export const FileEntry = z.object({
  name: z.string().min(1).max(FILE_LIMITS.nameBytes * 2),
  kind: z.enum(["file", "dir", "link", "other"]),
  size: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number().nonnegative().nullable(),
  hidden: z.enum(["ignored", "excluded"]).nullable(),
  /** pap's data, Pi's credentials or transcripts: listed, never opened (§ The boundary at a glance). */
  protected: z.boolean(),
  link: z.enum(["inside", "outside", "broken"]).nullable(),
  linkDir: z.boolean(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FileMeta = z.object({
  path: FilePath,
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  etag: Etag.nullable(),
  binary: z.boolean(),
  /** Not binary, at most 384 KiB, and a save of it fits one frame (M8R26): the editor may open it. */
  editable: z.boolean(),
  /** What a save needs from a browser session (M8R16, M8R101): nothing, `confirmProtected`, or that and a step-up. */
  protection: z.enum(["none", "confirm", "step_up"]),
});
export type FileMeta = z.infer<typeof FileMeta>;

const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const filesMethods = {
  "files.list": defineMethod({
    name: "files.list",
    permission: "files:read",
    idempotent: true,
    params: z.object({ path: FilePath, showIgnored: z.boolean().optional() }),
    result: z.object({ entries: z.array(FileEntry).max(FILE_LIMITS.listEntries), truncated: z.boolean() }),
    errors: ["not_found"],
  }),
  "files.read": defineMethod({
    name: "files.read",
    permission: "files:read",
    idempotent: true,
    params: z.object({ path: FilePath, offset: Offset.optional() }),
    result: z.object({
      meta: FileMeta,
      text: z.string().max(FILE_LIMITS.readChunkBytes),
      offset: Offset,
      nextOffset: Offset.nullable(),
    }),
    errors: ["not_found"],
  }),
  "files.search": defineMethod({
    name: "files.search",
    permission: "files:read",
    idempotent: true,
    params: z.object({
      root: FilePath,
      query: z.string().min(1).max(FILE_LIMITS.searchQuery),
      limit: z.number().int().min(1).max(FILE_LIMITS.searchResults).optional(),
    }),
    result: z.object({
      paths: z.array(z.string().min(1).max(FILE_LIMITS.pathBytes)).max(FILE_LIMITS.searchResults),
      truncated: z.boolean(),
    }),
    errors: ["not_found", "capacity"],
  }),
} as const;
```

- [ ] **Step 1: Write the failing tests**
  - `files.test.ts` (contracts): `FilePath` refuses `a/b`, `""`, `/a\u0000`; `files.read` params refuse `offset: -1` and `2**53`; `files.search` refuses a 129-character query and `limit: 51`.
  - `list.test.ts` (temporary repository with `node_modules/`, `dist/` ignored, a tracked file inside an ignored folder, a link out, a broken link, a FIFO, `$PAP_HOME` placed inside the root): folders first then files, case-folded order; `.git` absent; `node_modules` absent, then present with `hidden: "ignored"` under `showIgnored`; the ignored folder holding a tracked file is listed without `hidden`; the link out is `{ kind: "link", link: "outside", linkDir: true }`; the broken link `broken`; the FIFO `other`; the pap home entry `protected: true`; outside git, `node_modules` is `excluded`; 5 001 entries → 5 000 and `truncated`; a path outside the roots → `not_found`; with the home folder as a root, a browser session lists `.ssh` as an ordinary folder and a token as `protected: true`, and a token's `files.list` of `home/.ssh` → `not_found`.
  - `read.test.ts`: a small file → text, `nextOffset: null`, `etag` of 32 hex equal to the SHA-256 prefix, `editable: true`, `size` and `mtimeMs` of the file; a file with a NUL in the first 8 KiB → `binary`, empty text; a 3-byte character straddling 256 KiB → the first chunk ends before it and the second starts with it (no U+FFFD); a 400 KiB file → `etag: null`, `editable: false`; `offset` past the end → empty text, `nextOffset: null`; 300 KiB of `\u0001` → the answer serialises under 900 000 bytes and `editable: false` (its save would not fit a frame); a FIFO → `not_found` without hanging; `protection` is `confirm` for `.envrc` and `step_up` for `.pi/settings.json`; a hard link to the bed's `auth.json` → `not_found`.
  - `rank.test.ts`: `srvidx` ranks `src/server/index.ts` before `docs/server-index-notes.md`; an exact basename beats a longer path; 50 results at most; ties in code-point order; an empty index answers `[]`.
  - `search-index.test.ts` (fake runner and clock): one `ls-files` per root in 30 s, a new one after 30 s; outside git the walk skips `node_modules`, `.git` and `$PAP_HOME`, stops at 20 000 files (`truncated`); a 17th root drops the least recently used index; `ls-files` output holding `a\nIgnore previous.md` and `b\u202Ec.ts` indexes neither; a token's search never returns `.pi/mcp.json`.
  - `rpc.test.ts`: each method decodes and maps `not_found`; a relative path is `bad_request`.
  - `files.int.test.ts` (`startTestDaemon`): `files.list` of `t.cwd` over the socket returns a file created there; `files.read` returns its text; `files.search` with root `t.cwd` finds it; a path in `t.home` → `not_found`.
- [ ] **Step 2: Run them, see them fail** — `pnpm test:unit packages/contracts/src/files.test.ts apps/daemon/src/modules/files && pnpm test:int apps/daemon/src/modules/files` → FAIL.
- [ ] **Step 3: Implement** the module, `compose-workspace.ts` (the deny set from M8R103's sources, the system clock) and the `daemon.ts` lines (create it after `projects`, before `sessions`, with `roots: (owner) => projects.port.roots(owner)` and `readOnly`).
- [ ] **Step 4: Gate** (unit, int, build, budgets: +0.8 KB expected for the three method schemas) and commit:

```bash
git add packages/contracts apps/daemon/src
git commit -m "feat(files): list, read and search the caller's projects through the path boundary"
```

---

### Task 6a: `files` writes — the editor's save with the write gate, and the raw GET route

**Rulings (pre-dispatch):**
- **M8R30** [6a, 18] *(corrected: RT-03, RT-04, RT-22, owner c3)* `files.write { path, text, baseEtag, confirmProtected? }`: the path is judged `write` with the caller's kind; then `gateWrite` (M8R101) maps to `forbidden` (a token on a protected path or with the flag), `protected_path` (no confirmation) or `step_up_required` (a `.pi/` or `<agentDir>` path without a live step-up). `baseEtag: null` creates a file and answers `conflict` when one exists; otherwise the file must exist, be at most 384 KiB and hash to `baseEtag` (read through `openRegularFile`: a hard link to a private file is `not_found`), else `conflict`. More than 384 KiB of UTF-8, or a text whose JSON encoding passes 900 000 bytes, → `payload_too_large`. The mode is the existing file's, or `0o666 & ~workerUmask` for a new one (R114). `writeAtomic` with `replace: true` for an existing file, `replace: false` for a new one (a racing creator → `conflict`). The log line `file_written` says `protection` and the caller kind, never the path (owner f6) — cost if wrong: none.
- **M8R31** [6a, 6b, 7] HTTP file routes are cookie-only: any `Authorization` header → 401 `unauthenticated`, no live cookie → 401, a missing permission → 403 `forbidden`. `kernel/http/caller.ts` wraps `auth.authenticateCookieHeader` (its `Caller` carries `stepUpUntil`) — tokens use RPC (M5: "bearer tokens on HTTP routes: none needs one") — cost if wrong: a script reads files over RPC instead.
- **M8R32** [6a] *(corrected: RT-20, RT-21)* `GET /files/raw?path=<abs>[&download=1]`: judged `read` (`session` scope), opened with `openRegularFile`, streamed with `handle.createReadStream({ start: 0, end: size - 1 })` from the `fstat` size (an empty file sends no stream), so a log that grows meanwhile never overruns the announced `content-length`. Inline only for images by extension (`png jpg jpeg gif webp avif bmp ico svg`), at most 20 MiB, without `download=1`; everything else `application/octet-stream` with `Content-Disposition: attachment`. HTML, XHTML and XML are never served inline. The name rules are shared with the export route through `kernel/http/content-disposition.ts`: `attachmentDisposition(name, { fallback, suffix, leadingDot })`; the export route keeps `contentDispositionOf(title)` as a one-line wrapper (`{ fallback: "pap-session", suffix: ".html", leadingDot: "strip" }`), so its tests pass unedited; a raw file uses `{ fallback: "pap-file", suffix: "", leadingDot: "underscore" }`: `.env` downloads as `_env`, and a name cut to 64 code points keeps its extension — cost if wrong: wrong download names.
- **M8R33** [6a] Every raw response carries `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'` (through `ownCsp`, ADR 0006's mechanism), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`: an SVG or any file opened in a tab of its own never runs script as pap's origin — cost if wrong: XSS on pap's origin.
- **M8R35** [6a] Unmatched paths under `/files` keep R78's 404 JSON; `HEAD /files/raw` answers the headers only.
- **M8R105** [6a, 6b, 7, 12] *(new: RT-09)* Read-only database mode (spec C §3.2): every file write is refused the same way. `files.write` is a mutation, so the dispatcher answers `read_only`; `PUT /files/raw` and `POST /upload` answer 503 `{"error":{"code":"read_only"}}` before reading the body (the files module gets `readOnly` from `daemon.ts`). Reads, listings, the raw GET, vcs and terminals keep working (Task 12 makes `terminal.create` and `terminal.close` safe to run there) — cost if wrong: an inconsistent half-writable mode.

**Files:**
- Create: `apps/daemon/src/modules/files/{write,raw-http}.ts` and tests; `apps/daemon/src/kernel/http/{caller,content-disposition}.ts` and tests
- Modify: `packages/contracts/src/files.ts` (`files.write`), `methods.test.ts` (mutation list gains `files.write`); `apps/daemon/src/modules/files/{service,rpc,index}.ts`; `apps/daemon/src/modules/sessions/export-http.ts` (`contentDispositionOf` becomes the one-line wrapper; its tests unedited); `apps/daemon/src/compose-workspace.ts` (mount)

**Interfaces:**
- Consumes: Task 3a `judgePath`, `gateWrite`; Task 3b `openRegularFile`, `writeAtomic`; Task 5 module.
- Produces: `files.write`; `HttpCaller = (c: Context, permission: Permission) => Caller | Response`, `httpCaller(authenticateCookieHeader)`; `attachmentDisposition(name, options)`, `DispositionOptions`.

The contract addition, the raw route's headers and the download names (binding):

```ts
// packages/contracts/src/files.ts (Task 6a addition, inside filesMethods)
  "files.write": defineMethod({
    name: "files.write",
    permission: "files:operate",
    idempotent: false,
    params: z.object({
      path: FilePath,
      text: z.string().max(FILE_LIMITS.editableBytes),
      baseEtag: Etag.nullable(),
      confirmProtected: z.literal(true).optional(),
    }),
    result: z.object({ meta: FileMeta }),
    errors: ["not_found", "conflict", "protected_path", "step_up_required", "forbidden", "payload_too_large"],
  }),
```

```ts
// apps/daemon/src/modules/files/raw-http.ts (headers and type choice)
const INLINE_IMAGES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};
export const MAX_INLINE_BYTES = 20 * 1024 * 1024;
export const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
export const RAW_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};
const RAW_NAME = { fallback: "pap-file", suffix: "", leadingDot: "underscore" } as const;

export function rawContent(path: string, size: number, download: boolean): { type: string; disposition: string | null } {
  const image = INLINE_IMAGES[extname(path).slice(1).toLowerCase()];
  if (!download && image !== undefined && size <= MAX_INLINE_BYTES) return { type: image, disposition: null };
  return { type: "application/octet-stream", disposition: attachmentDisposition(basename(path), RAW_NAME) };
}
```

```ts
// apps/daemon/src/kernel/http/content-disposition.ts (run in scratch against every case of export-http.test.ts)
import { LONE_SURROGATE } from "../text.ts";

const NAME_CODE_POINTS = 64;
/** An extension kept through the cut: a dot, then 1 to 15 letters or digits (`.tar.gz` keeps `.gz`). */
const EXTENSION = /\.[\p{L}\p{N}]{1,15}$/u;
// Characters a file system or a header has a use for, and format and control characters (bidi marks among them).
const UNSAFE_IN_NAME = /[\\/:*?"<>|]|[\p{Cc}\p{Cf}]/gu;
const ASCII_SAFE = /[A-Za-z0-9 ._-]/;

export interface DispositionOptions {
  /** The name when nothing usable is left (without the suffix). */
  readonly fallback: string;
  /** Appended after the cut: `.html` for an export; `""` for a raw file, whose own extension survives the cut instead. */
  readonly suffix: string;
  /** An export drops leading dots and blanks; a raw file turns one leading dot into `_`, so `.env` stays `_env` (RT-20). */
  readonly leadingDot: "strip" | "underscore";
}

function cut(name: string, keepExtension: boolean): string {
  const points = [...name];
  if (points.length <= NAME_CODE_POINTS) return name;
  const extension = keepExtension ? (EXTENSION.exec(name)?.[0] ?? "") : "";
  const tail = [...extension];
  return points.slice(0, NAME_CODE_POINTS - tail.length).join("").trimEnd() + extension;
}

/**
 * `Content-Disposition` of a download, always an attachment (ADR 0006, M8R32): an ASCII fallback (`filename`: no
 * quote, separator or control character can be in it) and the RFC 5987 form (`filename*`, percent-encoded UTF-8).
 */
export function attachmentDisposition(name: string | null | undefined, options: DispositionOptions): string {
  const stripped = (name ?? "")
    .replace(LONE_SURROGATE, "\ufffd")
    .replace(UNSAFE_IN_NAME, (found) => (/^[\p{Cc}\p{Cf}]$/u.test(found) ? "" : "_"));
  const led = options.leadingDot === "strip" ? stripped.replace(/^[.\s]+/u, "") : stripped.replace(/^\./u, "_");
  const clean = cut(led.trim(), options.suffix === "").trimEnd();
  if (clean === "") return `attachment; filename="${options.fallback}${options.suffix}"`;
  const ascii = [...clean].map((char) => (ASCII_SAFE.test(char) ? char : "_")).join("");
  const asciiName = /[A-Za-z0-9]/.test(ascii) ? ascii : options.fallback;
  const encoded = encodeURIComponent(`${clean}${options.suffix}`).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}${options.suffix}"; filename*=UTF-8''${encoded}`;
}
```

- [ ] **Step 1: Write the failing tests**
  - `write.test.ts`: create with `baseEtag: null` → mode `0o644` when `workerUmask` is `0o022` (the process umask is 077), content exact, `meta.etag` of the new content; `baseEtag: null` on an existing file → `conflict`; a stale etag → `conflict`, file unchanged; `.git/hooks/pre-commit` without confirmation → `protected_path`, not created; with it → created and the log has `file_written` with `protection: "confirm"`; `.pi/extensions/x.ts` with confirmation and `stepUpUntil` in the past → `step_up_required`, not created; with a live step-up → created; a **token** caller: an ordinary file → written; `.git/hooks/x` with or without `confirmProtected` → `forbidden`; `confirmProtected` on an ordinary file → `forbidden`; `.pi/x` → `forbidden`; `<agentDir>/settings.json` (agent inside a root) with confirmation and a step-up → `not_found`; through a link inside the root → target changed, link kept; `$PAP_HOME/x` with confirmation → `not_found`; 384 KiB + 1 byte of UTF-8 in fewer characters (`é` × 196 609) → `payload_too_large`; 200 KiB of `\u0001` (1.2 MB of JSON) → `payload_too_large`; an existing `0o755` script keeps `0o755`; a stale-etag check on a hard link to the bed's `auth.json` → `not_found`.
  - `caller.test.ts`: no cookie → 401; `Authorization: Bearer pap_…` with a valid cookie → 401; a cookie without the permission → 403; a good cookie → the caller, `kind: "session"`, with its `stepUpUntil`.
  - `content-disposition.test.ts`: the raw options give `_env` for `.env`, `a.html` stays `a.html` (an attachment), 80 × `x` + `.tar.gz` keeps `.gz` within 64 code points, `日本.pdf` → `filename="__.pdf"` and the RFC 5987 form, `a\u202Eb.txt` → `ab.txt`, `""` → `pap-file`; `export-http.test.ts` passes unedited.
  - `raw-http.test.ts` (Hono app with a stub caller): `a.png` → 200, `image/png`, headers exactly `RAW_HEADERS` plus `RAW_CSP`, no disposition; `a.svg` → `image/svg+xml` under `RAW_CSP`; `a.html` → `application/octet-stream`, `attachment; filename="a.html"…`; `a.png?download=1` → attachment; a 21 MiB `.png` → attachment; a file that grows by 1 KiB after the open → the body has exactly the announced length; a FIFO → 404 and the test completes; `path=root/../x`, `path=%2e%2e`, a NUL → 404; a hard link to the bed's `state.db` → 404 and no byte of it; `HEAD` → headers, empty body; `/files/other` → 404 `{"error":{"code":"not_found"}}`.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement**; `contentDispositionOf` in `export-http.ts` becomes `(title) => attachmentDisposition(title, { fallback: "pap-session", suffix: ".html", leadingDot: "strip" })`.
- [ ] **Step 4: Mutation checks** — drop `ownCsp` for SVG: the SVG case fails; drop `gateWrite`'s token branch: the token hook case fails; drop the step-up branch: the `.pi/extensions` case fails; serve the raw body to EOF: the growing-file case fails.
- [ ] **Step 5: Gate** (unit, int, build, budgets: +0.2 KB) and commit:

```bash
git add packages/contracts apps/daemon/src
git commit -m "feat(files): save through the write gate, serve raw files sandboxed with safe names"
```

---

### Task 6b: `PUT /files/raw` — explorer uploads with a counted body, in-flight caps and an explicit deadline

**Rulings (pre-dispatch):**
- **M8R34** [6b] *(corrected: RT-08, RT-09, RT-23, owner c3)* `PUT /files/raw?path=<abs target>&conflict=skip|replace[&confirmProtected=1]` writes the request body to that file (pi-web's explorer upload, one file per request instead of a 100 MiB multipart form in memory). In order, each before the body is read: read-only mode → 503 `read_only` (M8R105); more than 4 requests of this owner in flight on this route → 503 `capacity` (M8R106); `Content-Length` missing or not decimal → 400 (a chunked body has none); above 25 MiB → 413; the name fails `uploadName` → 400; the boundary judges `write` (`session` scope) → 404 on any refusal; `gateWrite` → 409 `protected_path` without `confirmProtected=1`, 403 `step_up_required` on a `.pi/` or `<agentDir>` target without a live step-up; an existing file with `skip` → 200 `{ written: false }`; `replace` replaces; success → 200 `{ written: true, meta }`. The body is counted while streamed (longer than announced → 413, nothing kept). A client that stops mid-body leaves no file and no temporary file — cost if wrong: none.
- **M8R106** [6b, 7] *(new: RT-08)* In-flight caps and the deadline: `createInflight(4)` per route, keyed by the authenticated owner (never by anything a client names), refuses the fifth concurrent request of one owner with 503 `capacity` and never queues; the slot is freed on every outcome. `kernel/http/server.ts` passes `requestTimeout: 300_000` explicitly (Node's default, now written down and tested): an upload must finish within 5 minutes, about 700 kbit/s for 25 MiB; `files.md` says so, and the web maps an interrupted upload to "The upload stopped before the end: a slow or dropped connection. Try again on a faster link." (`upload.interrupted`) — cost if wrong: a phone upload through a slow tunnel fails with a clear message instead of hanging.

**Files:**
- Create: `apps/daemon/src/modules/files/{upload-http,receive-body,inflight}.ts`, `upload-http.test.ts`, `upload-http.socket.test.ts`, `receive-body.test.ts`, `inflight.test.ts`
- Modify: `apps/daemon/src/modules/files/index.ts` (mount), `apps/daemon/src/kernel/http/server.ts` (`requestTimeout`, + `server.int.test.ts` case)

**Interfaces:**
- Consumes: Task 3a `judgePath`, `gateWrite`; Task 3b `writeAtomic`, `uploadName`; Task 6a `HttpCaller`.
- Produces: `receiveBody(c, maxBytes): { chunks: AsyncIterable<Uint8Array>; length: number } | Response` and `createInflight(limit)` (both shared with Task 7); `UPLOAD_REQUEST_TIMEOUT_MS = 300_000`.

The body reader and the in-flight cap (binding):

```ts
// apps/daemon/src/modules/files/receive-body.ts
/** The request body as counted chunks (M8R34): a declared length is required and capped; a body longer than it fails. */
export function receiveBody(
  c: Context,
  maxBytes: number,
): { readonly chunks: AsyncIterable<Uint8Array>; readonly length: number } | Response {
  const declared = c.req.header("content-length");
  if (declared === undefined || !/^\d{1,12}$/.test(declared)) return c.json({ error: { code: "bad_request" } }, 400);
  const length = Number(declared);
  if (length > maxBytes) return c.json({ error: { code: "payload_too_large" } }, 413);
  const body = c.req.raw.body;
  return {
    length,
    chunks: (async function* () {
      if (body === null) return;
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > length) throw new BoundaryError("too_large");
        yield chunk;
      }
    })(),
  };
}
```

```ts
// apps/daemon/src/modules/files/inflight.ts
/** M8R106 (RT-08): at most `limit` requests of one owner in flight on one route; the next is refused, never queued. */
export function createInflight(limit: number): { enter(ownerId: string): (() => void) | null } {
  const counts = new Map<string, number>();
  return {
    enter(ownerId) {
      const count = counts.get(ownerId) ?? 0;
      if (count >= limit) return null;
      counts.set(ownerId, count + 1);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const now = (counts.get(ownerId) ?? 1) - 1;
        if (now === 0) counts.delete(ownerId);
        else counts.set(ownerId, now);
      };
    },
  };
}
```

- [ ] **Step 1: Write the failing tests**
  - `inflight.test.ts`: four `enter` succeed, the fifth is null; after one `leave` the next succeeds; calling a `leave` twice frees one slot; another owner is unaffected; the map is empty when all left.
  - `receive-body.test.ts` (synthetic `Request`s: an over-long body cannot travel over HTTP/1.1, where Node stops at `Content-Length`, RT-23): no `Content-Length` → 400; `Content-Length: 26214401` → 413 and the body stream is never pulled; a body 10 bytes longer than its length → the iterator throws `too_large`.
  - `upload-http.test.ts` (Hono app with a stub caller): name `a\u202Eb.txt` → 400; target in `.git/hooks/` → 409 `protected_path`, then with `confirmProtected=1` → 200 and mode `0o644`; a target in `.pi/` with `confirmProtected=1` and no step-up → 403 `step_up_required`, nothing written; `conflict=skip` on an existing file → `{ written: false }`, unchanged; `conflict=replace` → replaced; a target in `$PAP_HOME` → 404; `readOnly: true` → 503 `read_only` and the body never pulled; five concurrent requests of one owner whose bodies stay open → the fifth answers 503 `capacity` before its body is read, the four complete once released; through the full app without `Origin` → 403 (`originGuard`).
  - `upload-http.socket.test.ts` (a real listening server on an ephemeral loopback port, raw `node:net` sockets): a short body then the socket closed → no file and no `.pap-*.tmp`; `Transfer-Encoding: chunked` without a length → 400 and nothing written.
  - `server.int.test.ts` (addition): the started server's `requestTimeout` is 300 000.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Mutation checks** — drop the counted-body check: the "10 bytes longer" case fails; drop the in-flight check: the fifth-request case fails; read the body before `gateWrite`: the `.pi/` case writes a temporary file and fails its "nothing written" assertion.
- [ ] **Step 5: Gate** (unit, int, build, budgets: +0 KB) and commit:

```bash
git add apps/daemon/src
git commit -m "feat(files): stream explorer uploads with counted bodies, in-flight caps and an explicit deadline"
```

---

### Task 7: Attachments — `POST /upload`, the pending store, claims per session

Spec C §1.2 (`attachments/`), §4.5 (`POST /upload`), roadmap "per-session attachment claims" (T3 `AttachmentClaims.ts`: claim by copying, the pending file stays the retry source). The claim itself is used by Task 8.

**Rulings (pre-dispatch):**
- **M8R36** [7, 8] Storage: `$PAP_HOME/attachments/` (0700); pending uploads `pending/<id>` (0600); claimed files `<sessionId>/<id>/<name>` (copies, never moves). Ids: 16 random bytes in base64url (22 characters). The pending index lives in memory; at boot `pending/` is emptied (an index lost with the process is never rebuilt from disk) — cost if wrong: an upload in flight during a restart is attached again.
- **M8R37** [7] *(corrected: RT-08, RT-09, owner f9)* `POST /upload?sessionId=<id>&name=<name>`: `sessions:operate`, cookie only (M8R31). In order, each before the body is read: read-only mode → 503 `read_only` (M8R105); more than 4 uploads of this owner in flight → 503 `capacity` (M8R106); `Content-Length` required (400), at most 25 MiB (413); `name` via `uploadName` (400); `sessionId` must match `^[A-Za-z0-9_-]{1,128}$` (400) and is only recorded: ownership is checked at claim time (no cycle between `files` and `sessions` at boot); then the **reservation**: per owner at most 32 pending uploads and 200 MiB, counting uploads still arriving at their declared length, else 409 `limit_reached` (refuse, never evict); a failed or aborted body cancels its reservation. Answer 201 `AttachmentView`. Pending entries expire after 1 h (a sweep every 5 minutes on the kernel `Clock` deletes them and releases their share). An upload never taints the session (owner f9) — cost if wrong: more than 1 GB on the disk that holds `state.db` from one drop.
- **M8R38** [7] The kind comes from the first 12 bytes only: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a` / `GIF89a`, WebP `RIFF????WEBP`, and at most 10 MiB → `image` with that type; anything else (HEIC, PDF, a `.png` holding text, a 12 MiB PNG) → `file`, `mimeType: null`. The client's `Content-Type` and the name's extension are ignored — cost if wrong: an image the model could see is sent as a path (the agent can still read it).
- **M8R39** [7, 8] `AttachmentsPort.claim(ownerId, sessionId, ids)`: each id must be pending, unexpired, of this owner and recorded for this session, else `not_found`; a duplicate id → `bad_request`. Images come back as `{ id, path, mimeType }` (their pending file); files are copied with `COPYFILE_EXCL` to `<sessionId>/<id>/<name>` (a copy from an earlier claim is reused) and come back as `{ id, path, name, size }`. `release(ownerId, imageIds)` deletes those pending images once Pi accepted the prompt and frees their share of the budget; files stay pending until they expire. The pending write is `writeAtomic` (`replace: false`) with a guard whose only root is `pending/` and whose `BoundaryConfig` is empty: the descriptor must stay in that folder (the client-path rules do not apply to pap's own folder) — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/modules/files/{attachments-store,attachments-http,pending-budget,sniff}.ts` and tests
- Modify: `packages/contracts/src/files.ts` (`AttachmentId`, `ImageMime`, `AttachmentView`), `apps/daemon/src/modules/files/index.ts` (`attachments` port, mount), `apps/daemon/src/compose-workspace.ts`

**Interfaces:**
- Consumes: Task 3b `uploadName`, `writeAtomic` (the pending write, `replace: false`); Task 6a `HttpCaller`; Task 6b `receiveBody`, `createInflight`.
- Produces:

```ts
export interface AttachmentsPort {
  claim(ownerId: string, sessionId: string, ids: readonly string[]): Promise<ClaimedAttachments>;
  release(ownerId: string, imageIds: readonly string[]): void;
}
export interface ClaimedAttachments {
  readonly images: readonly { readonly id: string; readonly path: string; readonly mimeType: ImageMime }[];
  readonly files: readonly { readonly id: string; readonly path: string; readonly name: string; readonly size: number }[];
}
```

The contract, the sniffing and the pending budget (binding; the budget was run in scratch):

```ts
// packages/contracts/src/files.ts (Task 7 addition)
export const AttachmentId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ImageMime = z.enum(IMAGE_MIMES);
export type ImageMime = z.infer<typeof ImageMime>;
export const AttachmentView = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(FILE_LIMITS.nameBytes * 2),
  size: z.number().int().nonnegative().max(FILE_LIMITS.uploadBytes),
  kind: z.enum(["image", "file"]),
  mimeType: ImageMime.nullable(),
});
```

```ts
// apps/daemon/src/modules/files/sniff.ts
const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) =>
  bytes.every((byte, index) => head[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** M8R38: the type an image really has, from its first 12 bytes; null for anything else. */
export function sniffImage(head: Uint8Array, size: number): ImageMime | null {
  if (size > FILE_LIMITS.imageBytes) return null;
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "image/gif";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image/webp";
  return null;
}
```

```ts
// apps/daemon/src/modules/files/pending-budget.ts
export interface PendingBudget {
  /** Before the body is read (M8R37, RT-08): the declared length counts at once; null when a cap would pass. */
  reserve(ownerId: string, bytes: number): { keep(): void; cancel(): void } | null;
  /** A kept upload left `pending/`: released after its prompt, or expired. */
  release(ownerId: string, bytes: number): void;
}

/** What one owner holds in `pending/`, uploads still arriving included; full is refused, never evicted. */
export function createPendingBudget(limits: { readonly count: number; readonly bytes: number }): PendingBudget {
  const usage = new Map<string, { readonly count: number; readonly bytes: number }>();
  const change = (ownerId: string, count: number, bytes: number): void => {
    const now = usage.get(ownerId) ?? { count: 0, bytes: 0 };
    const next = { count: now.count + count, bytes: now.bytes + bytes };
    if (next.count <= 0) usage.delete(ownerId);
    else usage.set(ownerId, next);
  };
  return {
    reserve(ownerId, bytes) {
      const now = usage.get(ownerId) ?? { count: 0, bytes: 0 };
      if (now.count + 1 > limits.count || now.bytes + bytes > limits.bytes) return null;
      change(ownerId, 1, bytes);
      let settled = false;
      return {
        keep() {
          settled = true;
        },
        cancel() {
          if (settled) return;
          settled = true;
          change(ownerId, -1, -bytes);
        },
      };
    },
    release(ownerId, bytes) {
      change(ownerId, -1, -bytes);
    },
  };
}
```

A claimed file's place is `join(attachmentsDir, sessionId, id, name)` where `sessionId` matched `^[A-Za-z0-9_-]{1,128}$`, `id` is an `AttachmentId` the daemon minted and `name` passed `uploadName`: no segment can be `.`, `..` or hold a `/`.

- [ ] **Step 1: Write the failing tests**
  - `sniff.test.ts`: each signature → its type; a `.png` name with JPEG bytes → `image/jpeg` (the name is not an input); HEIC (`....ftypheic`) → null; PNG bytes of 10 MiB + 1 → null.
  - `pending-budget.test.ts`: 32 kept reservations of one owner, the 33rd → null, another owner unaffected; a `release` frees one; a `cancel` frees exactly one, twice is a no-op, after `keep` a no-op; three in-flight reservations of 60 MiB, the fourth of 60 MiB → null (in-flight bytes count), one cancelled → it fits.
  - `attachments-store.test.ts` (temporary home, fake clock): an upload is stored `0o600` in `pending/`, its view has a 22-character id; the 33rd pending upload of one owner → `limit_reached`, the first 32 untouched; 200 MiB pending then one more byte → `limit_reached`; after 1 h and one sweep the file and its entry are gone; a new store at boot empties `pending/`; `claim` by another owner → `not_found`; for another session → `not_found`; after expiry → `not_found`; duplicate ids → `bad_request`; a file claim copies to `<sid>/<id>/<name>` and leaves the pending copy; claiming it again reuses the copy; `release` removes the pending image and nothing else, and frees its share.
  - `attachments-http.test.ts`: no cookie → 401; bearer → 401; without `sessions:operate` → 403; no `sessionId` or `name` → 400; `sessionId=../x` → 400; a name with `\u202E` → 400; no length → 400; 25 MiB + 1 → 413; a PNG → 201 `{ kind: "image", mimeType: "image/png" }`; a PDF → 201 `{ kind: "file", mimeType: null }`; `readOnly: true` → 503 `read_only`, body never pulled; four uploads of one owner in flight declaring 60 MiB each → the fourth answers 409 `limit_reached` before its body is read and nothing of it lands in `pending/`; a fifth concurrent request → 503 `capacity`; an aborted body leaves no file and its reservation is cancelled (the next upload fits); through the full app without `Origin` → 403.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.** The boot log line `attachments_size` gives the folder's total bytes (a bounded walk: 10 000 entries) — retention comes with M10's `attachment.cleanup`.
- [ ] **Step 4: Mutation checks** — reserve after the body instead of before: the "fourth upload of 60 MiB" case fails (its bytes land on disk); drop `cancel` on an aborted body: the "next upload fits" case fails.
- [ ] **Step 5: Gate** (unit, int, build, budgets: +0.2 KB) and commit:

```bash
git add packages/contracts apps/daemon/src
git commit -m "feat(files): pending uploads with reserved budgets and per-session attachment claims"
```

---

### Task 8: Prompts with attachments — images to Pi, files as paths

**Rulings (pre-dispatch):**
- **M8R40** [8, 21] `sessions.prompt` gains `attachments: z.array(AttachmentId).max(10).optional()`; `text` may be empty only when at least one attachment is given (`superRefine`). M2's queue caps still count text bytes only (paths travel, never image bytes) — cost if wrong: none.
- **M8R41** [8] *(corrected: RT-25, RT-26)* The prompt record gains `images?: { path, mimeType }[]` (≤ 10, `mimeType` one of `IMAGE_MIMES`). The worker reads each image itself (`packages/pi-host/src/prompt-images.ts`, code below): its real path must sit directly in `<papHome>/attachments/pending/`, be a regular file of at most 10 MiB opened `O_NOFOLLOW | O_NONBLOCK`, declare at most 50 000 000 pixels in its header (M8R108) and is resized with Pi's own `resizeImage` (the SDK's defaults). A refused or unreadable image fails the whole prompt before Pi sees it (`success: false`, error `pap:image_unreadable`; the daemon answers `prompt_rejected`, its existing code: M8 adds no third code, agreement 23; the composer says why, M8R109) — the 4 MiB record cap of the IPC channel is never approached — cost if wrong: none.
- **M8R42** [8] Files are announced in the message: the daemon appends `\n\nAttached files:\n- <absolute path>` per file (without the leading blank lines when the text is empty). The transcript shows that block as part of the user's message: Pi has no file attachment type, and the agent reads the path with its `read` tool (M5 allows reads outside the session folder; `attachments/` is not in `PAP_SENSITIVE`) — cost if wrong: one string.
- **M8R43** [8] *(corrected: RT-07, agreement 8)* The claim runs in the service after the session's ownership check and before the worker call; `release` runs only when Pi accepted (`started`, `queued`, `handled`). A replay of the same `commandId` returns the stored result without claiming (receipts). `modules/sessions/live-session.ts` grows by at most 3 lines (the images pass through to `live-run.ts`, agreement 13). In pi-host, `DispatchDeps` gains `papHome` (from `init`, one line in `host.ts`), and the `prompt` case goes through the prompt queue (M8R107); `commands.ts` stays M8's only — cost if wrong: none.
- **M8R107** [8] *(new: RT-07)* `dispatch.ts` does not await a prompt (the next record must not wait behind a compaction), so an image prompt's asynchronous preparation (`realpath`, a read of up to 10 MiB, Photon in a worker thread) would let a later text prompt reach `session.prompt` first and swap Pi's queue order. One `PromptQueue` per worker: each prompt waits for the **preparation** of the prompts before it, never for their run; a text prompt with nothing ahead starts synchronously, exactly as before M8. An `abort` record drops every prompt not yet handed to Pi, the one preparing included, and answers each `success: false, error: "pap:aborted"` (the daemon's `prompt_rejected`: the composer keeps the text and attachments), then aborts Pi as today: nothing reaches Pi after a Stop — cost if wrong: messages run in the wrong order; Stop is overtaken.
- **M8R108** [8] *(new: RT-26)* Before `resizeImage`, the worker reads the image's declared size from its header (`image-size.ts`, code below: PNG `IHDR`; JPEG's first start-of-frame marker, after any EXIF or ICC segment; GIF's screen and first frame, the larger; WebP `VP8 `, `VP8L`, `VP8X`) and refuses an unreadable header or more than 50 000 000 pixels: Photon decodes the whole bitmap, and a 30 KB PNG may declare 50 000 × 50 000 (10 GB of RGBA) — cost if wrong: a worker killed by its memory limit.
- **M8R109** [8, 21] *(new: RT-25)* The composer explains an unsent message that carried images: on `prompt_rejected` for a send with at least one image it adds the note "The message was not sent: an image could not be read, or this model cannot take images. Remove it and try again." (`sessions.files.imageRejected`, lazy catalog); the text and the tray stay. Reading M7's loadout to say up front that the model has no image input is left to M7's model bar (it owns the loadout) — cost if wrong: one string.

**Files:**
- Create: `packages/pi-host/src/{prompt-images,image-size,prompt-queue}.ts`, `prompt-images.test.ts`, `image-size.test.ts`, `prompt-queue.test.ts`, `dispatch.prompt.test.ts`, `host.images.int.test.ts`; `apps/daemon/src/modules/sessions/sessions.attachments.int.test.ts`
- Modify: `packages/contracts/src/{methods,pi-host}.ts` (+ tests); `packages/pi-host/src/commands.ts` (`handlePrompt` takes the prepared images; `queuePrompt` builds the queue entry); `packages/pi-host/src/dispatch.ts` (`DispatchDeps.papHome`, one `createPromptQueue`, the `prompt` case calls `queuePrompt`, the `abort` case calls `dropWaiting()` first: three hunks, agreement 8); `packages/pi-host/src/host.ts` (one line: `papHome: first.data.papHome`); `apps/daemon/src/modules/sessions/{rpc,service-commands,service-types,live-run,live-session,index}.ts` (deps gain `attachments: AttachmentsPort`); `apps/daemon/src/daemon.ts` (one argument: `attachments: workspace.attachments`)

**Interfaces:**
- Consumes: Task 7 `AttachmentsPort`, `AttachmentId`, `IMAGE_MIMES`.
- Produces: `PromptCommand.images`; `LiveRun.prompt(text, streamingBehavior, images?)`; `SessionsModuleDeps.attachments`; `createPromptQueue(log): PromptQueue`, `QueuedPrompt`; `queuePrompt(queue, session, record, send, prepare = readPromptImages)`; `readPromptImages(papHome, images): Promise<PromptImage[] | null>` (all or nothing); `imageSize(bytes, mimeType)`, `withinPixelBudget(size)`, `MAX_PROMPT_IMAGE_PIXELS`.

The worker's image checks, the prompt queue and its use (binding; the header parser was run in scratch on real PNG and JPEG files, crafted GIF and WebP headers, a PNG bomb and 28 000 fuzzed buffers; the queue on gated preparations, an abort while preparing and a throwing start):

```ts
// packages/pi-host/src/prompt-images.ts
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { imageSize, withinPixelBudget } from "./image-size.ts";

export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
export interface PromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** An image the daemon claimed for this prompt, read only from pap's pending uploads (M8R41). Null when refused. */
export async function readPromptImage(
  papHome: string,
  image: { readonly path: string; readonly mimeType: string },
): Promise<PromptImage | null> {
  let pending: string;
  let real: string;
  try {
    pending = await realpath(join(papHome, "attachments", "pending"));
    real = await realpath(image.path);
  } catch {
    return null;
  }
  if (dirname(real) !== pending) return null;
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PROMPT_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await handle.readFile());
    // M8R108: the header's size first; Photon decodes the whole bitmap.
    if (!withinPixelBudget(imageSize(bytes, image.mimeType))) return null;
    const resized = await resizeImage(bytes, image.mimeType);
    return resized === null ? null : { type: "image", data: resized.data, mimeType: resized.mimeType };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Every image of one prompt, or null when one is refused: a prompt never goes with part of its images. */
export async function readPromptImages(
  papHome: string,
  images: readonly { readonly path: string; readonly mimeType: string }[],
): Promise<PromptImage[] | null> {
  const read: PromptImage[] = [];
  for (const image of images) {
    const one = await readPromptImage(papHome, image);
    if (one === null) return null;
    read.push(one);
  }
  return read;
}
```

```ts
// packages/pi-host/src/image-size.ts
/** M8R41b (RT-26): what an image declares, read from its header before anything decodes it. Null when unreadable. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** About a 7 000 × 7 000 photo: far above any model's input, far below a decompression bomb. */
export const MAX_PROMPT_IMAGE_PIXELS = 50_000_000;

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((char, index) => b[at + index] === char.charCodeAt(0));

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Start-of-frame markers: C0–CF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpeg(b: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data before any frame header
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (isSof(marker)) return at + 9 <= b.length ? { width: u16be(b, at + 7), height: u16be(b, at + 5) } : null;
    at += 2 + length;
  }
  return null;
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  const flags = b[10]!;
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  // A frame may declare more than the screen: take the first image descriptor's size too.
  while (at < b.length) {
    const block = b[at]!;
    if (block === 0x2c) {
      if (at + 9 > b.length) return null;
      width = Math.max(width, u16le(b, at + 5));
      height = Math.max(height, u16le(b, at + 7));
      return { width, height };
    }
    if (block !== 0x21 || at + 2 > b.length) return null;
    at += 2; // extension introducer and label
    for (;;) {
      if (at >= b.length) return null;
      const size = b[at]!;
      at += 1 + size;
      if (size === 0) break;
    }
  }
  return null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, "VP8X")) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

export function imageSize(bytes: Uint8Array, mimeType: string): ImageSize | null {
  const size =
    mimeType === "image/png"
      ? png(bytes)
      : mimeType === "image/jpeg"
        ? jpeg(bytes)
        : mimeType === "image/gif"
          ? gif(bytes)
          : mimeType === "image/webp"
            ? webp(bytes)
            : null;
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}

export const withinPixelBudget = (size: ImageSize | null): size is ImageSize =>
  size !== null && size.width * size.height <= MAX_PROMPT_IMAGE_PIXELS;
```

```ts
// packages/pi-host/src/prompt-queue.ts
import { logLineOf } from "./bounded.ts";

/** One prompt record on its way to Pi (M8R43b, RT-07). */
export interface QueuedPrompt {
  /** Reads what the prompt carries (its images). Never throws; absent when there is nothing to read. */
  readonly prepare?: () => Promise<void>;
  /** Hands the prompt to Pi: called once, in arrival order, never after `drop`. */
  start(): void;
  /** Called instead of `start` when an abort arrived first: answers `pap:aborted`. */
  drop(): void;
}

export interface PromptQueue {
  push(prompt: QueuedPrompt): void;
  /** An abort: every prompt not yet handed to Pi is dropped, the one preparing included. */
  dropWaiting(): void;
}

/**
 * Prompts reach Pi in arrival order although an image prompt prepares asynchronously: each waits for the
 * preparation of the ones before it, never for their run. A text prompt with nothing ahead starts at once, as before M8.
 */
export function createPromptQueue(log: (line: string) => void): PromptQueue {
  const waiting: QueuedPrompt[] = [];
  let draining = false;

  const guarded = (what: string, step: () => void): void => {
    try {
      step();
    } catch (error) {
      log(`pi-host: prompt ${what} failed: ${logLineOf(error)}\n`);
    }
  };

  async function drain(): Promise<void> {
    draining = true;
    while (waiting.length > 0) {
      const head = waiting[0] as QueuedPrompt;
      if (head.prepare) await head.prepare().catch(() => undefined);
      if (waiting[0] !== head) continue; // dropped by an abort while it prepared
      waiting.shift();
      guarded("start", () => head.start());
    }
    draining = false;
  }

  return {
    push(prompt) {
      if (!draining && waiting.length === 0 && prompt.prepare === undefined) return guarded("start", () => prompt.start());
      waiting.push(prompt);
      if (!draining) void drain();
    },
    dropWaiting() {
      for (const prompt of waiting.splice(0)) guarded("drop", () => prompt.drop());
    },
  };
}
```

```ts
// packages/pi-host/src/commands.ts (addition; handlePrompt gains a fourth parameter, the prepared images,
// and passes `images` to `session.prompt` only when there is one)
export function queuePrompt(
  queue: PromptQueue,
  session: AgentSession,
  papHome: string,
  command: { id: string; message: string; streamingBehavior?: "steer" | "followUp" | undefined; images?: readonly PromptImageRef[] | undefined },
  send: Send,
  read: typeof readPromptImages = readPromptImages,
): void {
  const refuse = (error: string) => send({ type: "response", id: command.id, command: "prompt", success: false, error });
  const wanted = command.images ?? [];
  if (wanted.length === 0) {
    queue.push({ start: () => handlePrompt(session, command, send, []), drop: () => refuse("pap:aborted") });
    return;
  }
  let images: PromptImage[] | null = null;
  queue.push({
    prepare: async () => {
      images = await read(papHome, wanted);
    },
    start: () => (images === null ? refuse("pap:image_unreadable") : handlePrompt(session, command, send, images)),
    drop: () => refuse("pap:aborted"),
  });
}
```

`dispatch.ts`: `const prompts = createPromptQueue((line) => process.stderr.write(line));` beside `background`; `case "prompt": queuePrompt(prompts, session, deps.papHome, record, send); return;`; `case "abort": prompts.dropWaiting();` before the existing `background("abort", …)`. `PromptImageRef` is the contract's `{ path, mimeType }`.

- [ ] **Step 1: Write the failing tests**
  - contracts: `sessions.prompt` params refuse `{ text: "" }`, accept `{ text: "", attachments: [<22 chars>] }`, refuse 11 ids and an id of 21 characters; `PromptCommand.images` refuses a relative path and `image/heic`.
  - `prompt-images.test.ts` (temporary `papHome`): a PNG in `pending/` → `{ type: "image", mimeType: "image/png" }` with base64 data; refused (null): `pending/../secrets/x`, a link in `pending/` to a file outside, a file in `pending/sub/`, a FIFO in `pending/` (no hang), 10 MiB + 1, a missing file, `pending/` itself, a 60-byte PNG whose `IHDR` declares 50 000 × 50 000 (refused before `resizeImage`: a spy on it is never called); `readPromptImages` with one good and one refused image → null.
  - `image-size.test.ts`: a PNG written by the test (`IHDR` 1053 × 745) → that size; a baseline JPEG with an EXIF segment and a progressive JPEG (`SOF2`), both built by the test from fixed bytes → their sizes; fill bytes before a marker are skipped; a JPEG cut before its frame header → null; a GIF whose screen is 1 × 1 and whose first frame declares 60 000 × 60 000 → 60 000 × 60 000; WebP `VP8X` 10 000 × 10 000, `VP8L` 100 × 50, `VP8 ` 320 × 240; `image/heic` → null; `withinPixelBudget` true for 7 000 × 7 000, false for 7 072 × 7 072; 20 000 seeded random buffers of 0–64 bytes, for each type, never throw.
  - `prompt-queue.test.ts`: a text prompt with nothing ahead starts synchronously (before `push` returns); an image prompt whose preparation is gated, then a text prompt → nothing starts until the gate opens, then the image prompt, then the text one; `dropWaiting()` while the first prepares → both dropped (`drop` once each), neither started, and a text prompt pushed after the drop starts once the dropped preparation settles; a `start` that throws is logged once and the next prompt still starts; idle again → a text prompt starts synchronously.
  - `dispatch.prompt.test.ts` (fake session, injected `read` that resolves on demand): `prompt { images }` then `prompt { message: "b" }` → `session.prompt` called with the image message first; `prompt { images }` then `abort` → the prompt is answered `{ success: false, error: "pap:aborted" }`, `session.prompt` is never called, `session.abort` is called; a `read` that returns null → `{ success: false, error: "pap:image_unreadable" }`.
  - `host.images.int.test.ts` (real pi-host, scripted provider): a prompt with one image path → Pi's session file has a user message whose content holds an `image` part of type `image/png`; a refused path → `{ success: false, error: "pap:image_unreadable" }` and no user message in the file; a followUp with a 9 MiB PNG then at once a followUp text → the file's user messages are in that order; an image prompt then at once an `abort` → the prompt answers `pap:aborted` and the file has no user message from it. (If the scripted model refuses images, declare `input: ["text", "image"]` on it in the test bed; the implementer says which.)
  - `sessions.attachments.int.test.ts` (`startTestDaemon`): upload a PNG and a PDF through `POST /upload`; prompt with both ids → Pi's file holds the image part and the text ends with `Attached files:\n- <t.home>/attachments/<sid>/<pdfId>/report.pdf`; that file exists; the pending PNG is gone; the same `commandId` again → the same answer and the claim ran once (log line `attachments_claimed` counted once); another session's id → `not_found`; an id after 1 h (test clock) → `not_found`.
  - `service-commands` unit: a failing claim never reaches the worker; a worker refusal (`prompt_rejected`) keeps the pending images (no `release`); a prompt with attachments raises no taint (owner f9: the session's taint is unchanged).
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Mutation checks** — push every prompt straight to `start` (no queue): the `dispatch.prompt` order case fails; drop `dropWaiting()` from `abort`: the abort case calls `session.prompt`; drop `withinPixelBudget`: the bomb case calls `resizeImage`.
- [ ] **Step 5: Gate** (unit, int, build, smoke, budgets: +0.1 KB) and commit:

```bash
git add packages apps/daemon/src
git commit -m "feat(sessions): send images and files with a prompt"
```

---

### Task 9: The `vcs` module — status as a stream, per-file diffs with M9-ready sides

Roadmap D05: "`vcs{cwd}` status stream, diffs". T3's `VcsStatusBroadcaster.ts` pushes local status after turns and on demand; pap adds a slow poll because it has no file watcher.

**Rulings (pre-dispatch):**
- **M8R44** [9] The stream key is a repository root equal to one of the caller's project roots (judged `list`); a subfolder, another owner's root or any other folder → `not_found`. Spec C writes `vcs{cwd}`; a status is per repository and M4 files every session under its git root (ADR 0032) — cost if wrong: one opener.
- **M8R45** [9] *(corrected: RT-10)* Refresh triggers: a subscription when the cached status is older than 2 s; `vcs.refresh`; a poll every 15 s for roots whose channel has subscribers (`StreamHub.hasSubscribers`, added here); never two runs at once for one root (a trigger during a run asks for exactly one more). A run that ends in `timeout` doubles that root's poll interval, up to 5 minutes, and the next runs skip line counts until one succeeds (then 15 s again). Line counts of untracked files are cached by `(path, size, mtimeMs)` (at most 2 000 entries per root, dropped with the root's cache). A result equal to the last one **compared without `at`** publishes nothing (stable JSON of the status minus `at`) — cost if wrong: a publish and a re-list of every open Files pane every 15 s, or a core burnt on a home root.
- **M8R46** [9] *(corrected: RT-10, verified in scratch)* A run is `status --porcelain=v2 -z --branch --ignore-submodules=dirty` **without `--untracked-files`**: the repository's own configuration decides (`normal` by default, so an untracked folder is one `dir/` entry; `status.showUntrackedFiles=no`, which dotfiles repositories set, lists none). An untracked folder entry becomes `VcsFile { path: "dir", folder: true, kind: "untracked", additions: null, deletions: null }` (the trailing `/` dropped, no diff). Then, unless the branch is unborn, `diff --numstat -z --no-ext-diff --no-textconv HEAD --`; untracked text files of at most 400 KiB count their lines (at most 200 per run, through `openRegularFile`, from the cache when unchanged; the rest null). More than 2 000 files → `truncated`. Failures fill `VcsStatus.error` (`git_missing`, `timeout`, `failed`, `too_large`) and never throw at a subscriber.
- **M8R47** [9, M9] *(corrected: RT-17)* `vcs.fileDiff` sides: `worktree` reads the file through the boundary (`read` + `openRegularFile`), `index` is `cat-file blob :<path>`, `head` `cat-file blob HEAD:<path>`, `commit` `cat-file blob <oid>:<path>`. Every side, blobs included, first passes `judgeName(join(root, path), scope)` (and `oldPath` too): a dotfiles repository that tracks a `$PAP_HOME` or Pi private path, or a token asking for `.pi/mcp.json`, gets `not_found` before git runs. A missing object or file is a null side; a NUL in the first 8 KiB of either side → `binary: true` with both sides null; a side over 400 KiB → `truncated: true` with both null. M8's UI asks `head → worktree` only; M9 turns branches, merge bases and checkpoint refs into oids daemon-side and calls the same method — cost if wrong: M9 adds a side kind.
- **M8R110** [9] *(new: RT-18)* Bounds of a status: `branch` is clipped to 256 and `upstream` to 512 UTF-8-safe characters (a longer branch name never fails the schema); a status event is fitted under `PAGE_BYTES` (900 000) by cutting `files` from the end and setting `truncated` (the hub does not fit events, and 2 000 entries of long paths can pass a 1 MiB frame) — cost if wrong: a lost stream on a repository with long paths.
- **M8R48** [9] Snapshots are synchronous (the hub's contract): the cached status or null; the handler starts a refresh before it opens the subscription, and its result comes as a `status` event.
- **M8R49** [9] At most 32 roots keep a cached status: a new root drops the oldest one without subscribers; a 33rd root while all 32 have subscribers → `capacity` (never evict a watched root).

**Files:**
- Create: `packages/contracts/src/vcs.ts`, `vcs.test.ts`; `apps/daemon/src/modules/vcs/{index,service,status,diff,poller,rpc}.ts` and tests; `apps/daemon/src/modules/vcs/vcs.int.test.ts`
- Modify: `packages/contracts/src/{streams,methods,methods.test,index}.ts` (`STREAMS` gains `"vcs"`, agreement 11); `apps/daemon/src/kernel/ws/stream-hub.ts` (`hasSubscribers(stream, key)`, + test); `apps/daemon/src/compose-workspace.ts`; `apps/web/src/runtime/subscriptions.ts` (`OPENERS.vcs`, the record is exhaustive over `StreamName`); create `apps/web/src/runtime/subscriptions.m8.test.ts` (`subscriptions.test.ts` is at 344 lines and frozen, agreement 11)

**Interfaces:**
- Consumes: Task 3a `judgePath`, `judgeName`; Task 3b `openRegularFile` and the deny set; Task 4 runner and parsers; Task 5 composition.
- Produces: the contract below; `createVcsModule(deps: { roots; boundary; deny; git; hub; clock; logger }): { rpc: VcsRpc }`.

The contract (binding):

```ts
// packages/contracts/src/vcs.ts
import { z } from "zod";
import { defineMethod } from "./define.ts";
import { Cursor } from "./frames.ts";
import { FilePath } from "./files.ts";

export const VCS_LIMITS = { files: 2000, diffSideBytes: 400 * 1024, pollMs: 15_000 } as const;

/** A path inside a repository: relative, canonical (M8R23). */
export const RepoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "a path inside the repository",
  );

export const DiffSide = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktree") }),
  z.object({ kind: z.literal("index") }),
  z.object({ kind: z.literal("head") }),
  z.object({ kind: z.literal("commit"), oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
]);
export type DiffSide = z.infer<typeof DiffSide>;

export const VcsFile = z.object({
  path: RepoPath,
  oldPath: RepoPath.nullable(),
  /** An untracked folder git lists as one entry (`normal` untracked mode, M8R46): no diff, no counts. */
  folder: z.boolean(),
  index: z.string().length(1),
  worktree: z.string().length(1),
  kind: z.enum(["modified", "added", "deleted", "renamed", "copied", "typechange", "untracked", "conflicted"]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});
export type VcsFile = z.infer<typeof VcsFile>;

const Count = z.number().int().nonnegative();
export const VcsStatus = z.object({
  root: FilePath,
  repo: z.boolean(),
  branch: z.string().max(256).nullable(),
  detached: z.boolean(),
  upstream: z.string().max(512).nullable(),
  ahead: Count,
  behind: Count,
  files: z.array(VcsFile).max(VCS_LIMITS.files),
  truncated: z.boolean(),
  additions: Count,
  deletions: Count,
  at: z.number().int().min(0).max(8.64e15),
  error: z.enum(["git_missing", "timeout", "failed", "too_large"]).nullable(),
});
export type VcsStatus = z.infer<typeof VcsStatus>;

export const VcsStreamEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), status: VcsStatus.nullable() }),
  z.object({ kind: z.literal("status"), status: VcsStatus }),
]);
export type VcsStreamEvent = z.infer<typeof VcsStreamEvent>;

const DiffText = z.string().max(VCS_LIMITS.diffSideBytes).nullable();

export const vcsMethods = {
  "subscribe.vcs": defineMethod({
    name: "subscribe.vcs",
    permission: "vcs:read",
    idempotent: true,
    params: z.object({ root: FilePath, after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["not_found", "capacity"],
  }),
  "vcs.refresh": defineMethod({
    name: "vcs.refresh",
    permission: "vcs:read",
    idempotent: true,
    params: z.object({ root: FilePath }),
    result: z.object({ ok: z.literal(true) }),
    errors: ["not_found", "capacity"],
  }),
  "vcs.fileDiff": defineMethod({
    name: "vcs.fileDiff",
    permission: "vcs:read",
    idempotent: true,
    params: z.object({
      root: FilePath,
      path: RepoPath,
      oldPath: RepoPath.optional(),
      from: DiffSide,
      to: DiffSide,
    }),
    result: z.object({ before: DiffText, after: DiffText, binary: z.boolean(), truncated: z.boolean() }),
    errors: ["not_found", "capacity", "timeout"],
  }),
} as const;
```

- [ ] **Step 1: Write the failing tests**
  - `vcs.test.ts` (contracts): `RepoPath` refuses `/a`, `a//b`, `./a`, `a/../b`, `a\u0000`; `DiffSide` refuses `{ kind: "commit", oid: "HEAD" }`, a 39-character oid, upper-case hex; accepts 40 and 64 hex.
  - `status.test.ts` (fixtures through the parsers): each porcelain kind maps to its `VcsFile.kind` (`UU` → `conflicted`, `R.` → `renamed` with `oldPath`, `.T` → `typechange`, `?` → `untracked`); `? u/` → `{ path: "u", folder: true, kind: "untracked" }`; numstat counts land on their files, binary rows give `binary: true` and null counts; an unborn branch runs no numstat; 2 001 entries → 2 000 and `truncated`; 2 000 entries of 600-byte paths → the event fits 900 000 bytes, `truncated: true`; a 300-character branch name → clipped to 256, the schema passes; a `GitError("git_missing")` → `error: "git_missing"`, `repo: false`, the root and an empty list; a folder that is not a repository → `repo: false`; the status arguments never contain `--untracked-files`.
  - `poller.test.ts` (fake clock, fake runner, fake hub): with one subscriber a refresh runs every 15 s; without subscribers none; a trigger during a run produces exactly one more run; an identical result with a new `at` publishes nothing, a changed one publishes one `status` event; a run that times out → the next poll comes 30 s later, then 60 s, capped at 300 s, and those runs read no file for line counts; a success → 15 s again; an untracked file unchanged in size and mtime is read once over three runs; 32 watched roots then a 33rd subscription → `capacity`.
  - `diff.test.ts`: each side kind reads the right source; a missing blob → null side; NUL → `binary` and both null; 400 KiB + 1 → `truncated` and both null; a worktree path that is a link out of the root → `not_found`; a `head` side for a repository path that joins to `$PAP_HOME/state.db` (a dotfiles repository rooted above it) → `not_found` and git never runs; a token asking `head` of `.pi/mcp.json` → `not_found`.
  - `stream-hub.test.ts`: `hasSubscribers` false, true after `open`, false after `close`.
  - `vcs.int.test.ts` (`startTestDaemon`, a real repository in `t.cwd` with `HOME` temporary): commit `a.txt`, then modify it, add `b.txt` untracked, rename `c.txt` to `d.txt` (staged) → `subscribe.vcs { root: t.cwd }` gets a snapshot then a `status` event listing the three with their kinds and counts; `vcs.fileDiff { path: "a.txt", from: head, to: worktree }` returns both texts exactly; `subscribe.vcs` on `t.cwd/sub` → `not_found`; on `t.home` → `not_found`.
  - web `subscriptions.m8.test.ts`: the `vcs` opener calls `subscribe.vcs` with `{ root: key }` and the cursor.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Mutation checks** — compare statuses with `at`: the "new `at` publishes nothing" case fails; skip `judgeName` on blob sides: the `$PAP_HOME` blob case runs git and fails.
- [ ] **Step 5: Gate** (unit, int, build, budgets: +0.8 KB) and commit:

```bash
git add packages/contracts apps/daemon/src apps/web/src/runtime
git commit -m "feat(vcs): git status pushed per repository and per-file diffs"
```

---

### Task 10a: node-pty in the native-build allowlist, the loader, the smoke import

Spec C §8.2 ("a native-build allowlist (node-pty)"). A dependency task: the build log is the proof, the loader keeps the daemon up when the build is missing.

**Rulings (pre-dispatch):**
- **M8R50** [10a] `node-pty` 1.1.0 (2025-12-22, MIT) in `apps/daemon`; `pnpm-workspace.yaml` gets `onlyBuiltDependencies: [node-pty]`. Version 1.1.0 ships no Linux prebuild, so `pnpm install` builds it with node-gyp (gcc 15, make, python3 on this host; Node's headers are already in `~/.cache/node-gyp/24.14.1`). `minimumReleaseAge` is never bypassed. If the build fails, the task stops and reports: no other PTY package without the owner — cost if wrong: one dependency line.
- **M8R51** [10a, 12] node-pty is loaded with `createRequire` at first use and probed once at boot: a failed load logs `terminal_unavailable` (warn) once, `terminal.create` answers `terminal_unavailable`, and the daemon boots anyway — a missing compiler at install must not take files and sessions down. `pnpm smoke` fails when the built daemon's boot log holds `terminal_unavailable` (node-pty must load from `apps/daemon/dist`) — cost if wrong: none.

**Files:**
- Create: `apps/daemon/src/kernel/pty/load.ts`, `load.test.ts`
- Modify: `apps/daemon/package.json` (`"node-pty": "1.1.0"`), `pnpm-workspace.yaml`, `pnpm-lock.yaml` (regenerated by `pnpm install`, never by hand), `apps/daemon/src/daemon.ts` (the boot probe, inside the ≤ 10 lines of M8R28), `scripts/smoke-dist.ts` (the `terminal_unavailable` check), `knip.json` (only if needed)

**Interfaces:**
- Produces: `loadNodePty(log): typeof import("node-pty") | null` (memoised: one load, one log line).

- [ ] **Step 1: Install and prove the native build** — `pnpm install` (expect node-pty built, no `ignoredBuiltDependencies` warning for it) then `node -e "require('node-pty')"` from `apps/daemon` → no error. On failure: stop, report the build log tail.
- [ ] **Step 2: Write the failing tests** — `load.test.ts`: a require that throws → `null` and one log call, the second `loadNodePty` does not retry; a require that works → the module, no log.
- [ ] **Step 3: Run them, see them fail; implement; see them pass.**
- [ ] **Step 4: Gate** (unit, int, build, smoke) and commit:

```bash
git add apps/daemon pnpm-workspace.yaml pnpm-lock.yaml scripts knip.json
git commit -m "build(daemon): node-pty in the native-build allowlist, loaded lazily and probed at boot"
```

---

### Task 10b: The PTY kernel — spawn arguments, the shell's environment, the session-wide kill ladder, the terminal scope

Spec C §1.1 (`child: PTY × N (node-pty)`), §2.5 (the environment, `oom_score_adj`). pi-web's `lib/terminal-manager.ts` is the behaviour reference (login shell, `xterm-256color`, the 2 s SIGKILL fallback); pap adds the scope, a kill that reaches the shell's whole session and a sanitised environment.

**Rulings (pre-dispatch):**
- **M8R52** [10b] The shell is `$SHELL` when it is absolute, has no NUL and resolves to an executable regular file, else `/bin/sh`. Its only argument is `-l`, and only for `sh bash zsh dash ksh mksh fish` (by basename). Nothing from a client reaches the command line — cost if wrong: none.
- **M8R53** [10b] *(corrected: RT-27, agreement 14)* Environment: the base environment minus what `isDaemonOnly` names, the one rule of `kernel/supervisor/env.ts` that workers, M7's helpers and PTYs share: every `PAP_*`, `NODE_OPTIONS`, and the **platform secrets** of spec C §2.5, defined here as the service manager's variables of the daemon's own unit (`NOTIFY_SOCKET`, `LISTEN_FDS`, `LISTEN_PID`, `LISTEN_FDNAMES`, `INVOCATION_ID`, `JOURNAL_STREAM`, `SYSTEMD_EXEC_PID`, `MANAGERPID`, `MAINPID`, `WATCHDOG_PID`, `WATCHDOG_USEC`, `CREDENTIALS_DIRECTORY`, `MEMORY_PRESSURE_WATCH`, `MEMORY_PRESSURE_WRITE`: the preview runs as a systemd user service). Then `TERM=xterm-256color`, `COLORTERM=truecolor`, and `LANG=C.UTF-8` only when no locale variable is set. `cwd` is the judged real folder. Size: cols 2–500, rows 2–200, clamped; a non-integer gives 80 × 24. `encoding: null` (Buffers: offsets count bytes), `handleFlowControl: false` — cost if wrong: a shell that notifies systemd or reads the unit's credentials.
- **M8R54** [10b] With worker scopes on, a PTY runs as `systemd-run --user --scope … -- <shell> -l` in a unit of its own (`scopes.next({ kind: "terminal" })`: `pap-<sha8>-term-<rand>-<n>.scope`, the workers' `MemoryMax`, `TasksMax` and `OOMPolicy`, environment `XDG_RUNTIME_DIR` only, never `PAP_WORKER_UNIT`); without scopes, a plain PTY. After the spawn, `/proc/<pid>/oom_score_adj` is set to 800 (best effort, logged at debug when refused), so the kernel kills a runaway in a terminal before the daemon (spec C §2.5). A terminal thus shares the workers' memory and task limits: a heavy build that is fine over SSH can be OOM-killed in pap (said in `terminal.md` and in the owner's Q2 answer text, RT-38) — cost if wrong: none.
- **M8R55** [10b, 12] *(corrected: RT-05, verified on a real PTY)* Kill ladder (`kill.ts`, code below): SIGHUP to the shell's group `-pid` (pid > 1 asserted) **and to every process of the shell's session** (field 6 of `/proc/<p>/stat` equal to the shell's pid, through a walk of at most 32 768 `/proc` entries): an interactive dash or bash gives each job a process group of its own, and `trap "" HUP` is inherited, so the group signal alone leaves `sleep 1000 &` running and holding the PTY (dash and bash: 2 survivors in scratch; zsh: none). If the shell exited and its session is empty, the ladder ends; otherwise SIGKILL to the group and the session after 2 s on the kernel `Clock`; then it waits for the shell's exit at most 5 s more, logs `pty_kill_timeout` and resolves anyway (node-pty may report the exit only once the last holder of the PTY is gone). The session is ours only while the shell's pid still has the `/proc` start time read at spawn (Linux never reuses a pid while a session or group still names it). With a scope, the terminal then calls the scope's `reap()`, which kills the unit's cgroup. Without a scope, a job that left the session (`setsid`, a double-forked daemon) survives, as when a terminal emulator closes (`terminal.md`) — cost if wrong: jobs survive close and daemon stop.
- **M8R119** [10b, 13] *(new: RT-27)* The shell holds no descriptor of the daemon: every fd of the shell links to `/dev/pts/*` (dash and bash keep a copy of the terminal at 10 or 255); none is a socket, a pipe, `state.db` or a file under the test's home. If node-pty passes one, the task stops and reports (no workaround without the Opus reviewer) — cost if wrong: a shell that reads the database or the worker IPC.
- **M8R120** [10b, 12] *(new)* The PTY's base environment is the one the daemon gives its workers (`createDaemon`'s `env`: `process.env` in production, the harness's isolated one with a temporary `HOME` and no `SHELL` in tests, so a test terminal runs `/bin/sh` and never reads the real `~/.profile`) — cost if wrong: a test that sources the owner's dotfiles.

**Files:**
- Create: `apps/daemon/src/kernel/pty/{env,spawn,kill}.ts`, `env.test.ts`, `spawn.test.ts`, `kill.test.ts`, `spawn.int.test.ts`
- Modify: `apps/daemon/src/kernel/supervisor/env.ts` (`isDaemonOnly` exported, the platform keys) and `env.test.ts`; `apps/daemon/src/kernel/supervisor/scope.ts` (`next(options?: { kind: "worker" | "terminal" })`, default `worker`) and `scope.test.ts`

**Interfaces:**
- Consumes: Task 10a `loadNodePty`.
- Produces: `isDaemonOnly(key)`; `shellEnv(base)`; `shellOf(env)`; `ptySpec(input): PtySpec`; `spawnPty(pty, spec, logger): PtyProcess`; `ptyKill(target, deps)`, `sessionMembers(target, proc)`, `parseProcStat`, `LINUX_PROC`, `ProcReader`, `PtyTarget`; `PtyProcess { pid; start: string | null; exited: Promise<{ code: number | null; signal: string | null }>; onData(listener: (chunk: Buffer) => void): void; write(data: Uint8Array): void; resize(cols, rows): void; pause(): void; resume(): void }` (`start` is read from `/proc/<pid>/stat` right after the spawn, null without `/proc`).

Environment, spawn and kill (binding; the kill ladder was run in scratch on a real PTY with `/bin/sh` (dash), bash and zsh, with and without the session walk):

```ts
// apps/daemon/src/kernel/supervisor/env.ts
/** The service manager's variables of the daemon's own unit: C §2.5's "platform secrets" (M8R53, RT-27). */
const PLATFORM_KEYS: ReadonlySet<string> = new Set([
  "NOTIFY_SOCKET",
  "LISTEN_FDS",
  "LISTEN_PID",
  "LISTEN_FDNAMES",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
  "MANAGERPID",
  "MAINPID",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
  "CREDENTIALS_DIRECTORY",
  "MEMORY_PRESSURE_WATCH",
  "MEMORY_PRESSURE_WRITE",
]);

/** What only the daemon holds: its settings, Node's options and the platform's secrets. Workers, helpers and PTYs share it. */
export const isDaemonOnly = (key: string): boolean =>
  key.startsWith("PAP_") || key === "NODE_OPTIONS" || PLATFORM_KEYS.has(key);

export function workerEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !isDaemonOnly(key)) env[key] = value;
  return { ...env, ...extra, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
}
```

```ts
// apps/daemon/src/kernel/pty/env.ts
import { isDaemonOnly } from "../supervisor/env.ts";

/** The workers' rule: pap's settings and the platform's secrets never reach a shell (M8R53). */
export function shellEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !isDaemonOnly(key)) env[key] = value;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) env.LANG = "C.UTF-8";
  return env;
}
```

```ts
// apps/daemon/src/kernel/pty/spawn.ts
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ScopeLaunch } from "../supervisor/scope.ts";

export const PTY_COLS = { min: 2, max: 500, fallback: 80 } as const;
export const PTY_ROWS = { min: 2, max: 200, fallback: 24 } as const;
const FALLBACK_SHELL = "/bin/sh";
const LOGIN_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);

export function clampSize(value: number, range: { min: number; max: number; fallback: number }): number {
  return Number.isInteger(value) ? Math.min(range.max, Math.max(range.min, value)) : range.fallback;
}

/** M8R52: `$SHELL` when it is a real executable file given as an absolute path, else /bin/sh. */
export function shellOf(env: NodeJS.ProcessEnv): string {
  const candidate = env.SHELL;
  if (candidate !== undefined && candidate.startsWith("/") && !candidate.includes("\0")) {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.X_OK);
      if (statSync(real).isFile()) return candidate;
    } catch {
      // not usable: the fallback below
    }
  }
  return FALLBACK_SHELL;
}

export interface PtySpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: {
    readonly name: "xterm-256color";
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly encoding: null;
    readonly handleFlowControl: false;
  };
}

export function ptySpec(input: {
  readonly shell: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
  readonly scope: ScopeLaunch | null;
}): PtySpec {
  const login = LOGIN_SHELLS.has(basename(input.shell)) ? ["-l"] : [];
  const { scope } = input;
  return {
    file: scope ? scope.command : input.shell,
    args: scope ? [...scope.args, input.shell, ...login] : login,
    options: {
      name: "xterm-256color",
      cols: clampSize(input.cols, PTY_COLS),
      rows: clampSize(input.rows, PTY_ROWS),
      cwd: input.cwd,
      env: { ...input.env, ...(scope?.env ?? {}) },
      encoding: null,
      handleFlowControl: false,
    },
  };
}
```

```ts
// apps/daemon/src/kernel/pty/kill.ts
import { readdir, readFile } from "node:fs/promises";
import type { Clock } from "../clock.ts";

export const PTY_HANGUP_GRACE_MS = 2000;
/** After the SIGKILL: node-pty may report the exit only once the last holder of the terminal is gone (RT-05). */
export const PTY_EXIT_WAIT_MS = 5000;
export const PROC_WALK_MAX = 32_768;

export interface ProcEntry {
  readonly pid: number;
  /** Field 6 of /proc/<pid>/stat. */
  readonly sid: number;
  /** Field 22: clock ticks since boot; the same pid with another start is another process. */
  readonly start: string;
}

/** The fields after the command name, which may hold spaces and parentheses: the last `)` ends it. */
export function parseProcStat(pid: number, text: string): ProcEntry | null {
  const end = text.lastIndexOf(")");
  if (end < 0) return null;
  const fields = text.slice(end + 2).split(" ");
  const sid = Number(fields[3]);
  const start = fields[19];
  return Number.isInteger(sid) && start !== undefined && /^\d+$/.test(start) ? { pid, sid, start } : null;
}

export interface ProcReader {
  entry(pid: number): Promise<ProcEntry | null>;
  /** The pids /proc lists, at most PROC_WALK_MAX. */
  pids(): Promise<readonly number[]>;
}

export const LINUX_PROC: ProcReader = {
  async entry(pid) {
    try {
      return parseProcStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  },
  async pids() {
    try {
      const pids: number[] = [];
      for (const name of await readdir("/proc")) {
        if (/^\d+$/.test(name)) pids.push(Number(name));
        if (pids.length >= PROC_WALK_MAX) break;
      }
      return pids;
    } catch {
      return [];
    }
  },
};

export interface PtyTarget {
  readonly pid: number;
  /** The shell's /proc start, read at spawn (null without /proc). */
  readonly start: string | null;
  readonly exited: Promise<unknown>;
}

/**
 * M8R55 (RT-05): the processes of the shell's session, the shell excluded: an interactive shell gives each job a
 * process group of its own, so the group signal misses them. Null when the pid now names another process: then
 * neither its group nor its session is ours. Linux keeps a session id from being reused while a member lives.
 */
export async function sessionMembers(target: PtyTarget, proc: ProcReader): Promise<number[] | null> {
  const leader = await proc.entry(target.pid);
  if (leader !== null && target.start !== null && leader.start !== target.start) return null;
  const members: number[] = [];
  for (const pid of await proc.pids()) {
    if (pid === target.pid) continue;
    if ((await proc.entry(pid))?.sid === target.pid) members.push(pid);
  }
  return members;
}

type Signal = (target: number, name: NodeJS.Signals) => void;

const sendSignal: Signal = (target, name) => {
  try {
    process.kill(target, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

export interface KillDeps {
  readonly clock: Clock;
  readonly warn: (event: "pty_kill_timeout", fields: { readonly pid: number }) => void;
  readonly proc?: ProcReader;
  readonly signal?: Signal;
}

/** A clock delay that can be cancelled, so nothing stays armed once the ladder is done. */
function delay(clock: Clock, ms: number): { readonly done: Promise<"elapsed">; cancel(): void } {
  let handle: ReturnType<Clock["setTimeout"]> | null = null;
  const done = new Promise<"elapsed">((resolve) => {
    handle = clock.setTimeout(() => resolve("elapsed"), ms);
  });
  return {
    done,
    cancel() {
      if (handle !== null) clock.clearTimeout(handle);
    },
  };
}

/**
 * M8R55: SIGHUP to the shell's group and to every process of its session; SIGKILL to the same after 2 s unless
 * the shell exited and its session is empty; then resolve on the shell's exit, or after 5 s more (logged).
 */
export async function ptyKill(target: PtyTarget, deps: KillDeps): Promise<void> {
  if (!Number.isInteger(target.pid) || target.pid <= 1) throw new Error("refusing to signal pid <= 1");
  const proc = deps.proc ?? LINUX_PROC;
  const signal = deps.signal ?? sendSignal;
  const exited = target.exited.then(() => "exited" as const);
  const hit = async (name: NodeJS.Signals): Promise<number> => {
    const members = await sessionMembers(target, proc);
    if (members === null) return 0;
    signal(-target.pid, name);
    for (const pid of members) signal(pid, name);
    return members.length;
  };
  const grace = delay(deps.clock, PTY_HANGUP_GRACE_MS);
  await hit("SIGHUP");
  if ((await Promise.race([exited, grace.done])) === "exited") {
    const left = await sessionMembers(target, proc);
    if (left === null || left.length === 0) {
      grace.cancel();
      return;
    }
    await grace.done;
  }
  await hit("SIGKILL");
  const wait = delay(deps.clock, PTY_EXIT_WAIT_MS);
  if ((await Promise.race([exited, wait.done])) === "elapsed") deps.warn("pty_kill_timeout", { pid: target.pid });
  else wait.cancel();
}
```

- [ ] **Step 1: Write the failing tests**
  - `supervisor/env.test.ts` (addition): `workerEnv` drops each `PLATFORM_KEYS` entry, `PAP_X` and `NODE_OPTIONS`, keeps `PATH` and `XDG_RUNTIME_DIR`.
  - `env.test.ts`: `shellEnv({ PATH: "/bin", HOME: "/h", PAP_SECRET: "x", NODE_OPTIONS: "--y", NOTIFY_SOCKET: "/run/x", LISTEN_FDS: "3", CREDENTIALS_DIRECTORY: "/run/c", LC_ALL: "fr_FR.UTF-8" })` equals `{ PATH, HOME, LC_ALL, TERM: "xterm-256color", COLORTERM: "truecolor" }` exactly (no `LANG`); without a locale variable `LANG` is `C.UTF-8`; for every key of a sample environment, `shellEnv` keeps it iff `workerEnv` keeps it (the shared rule).
  - `spawn.test.ts`: `shellOf({ SHELL: "bash" })`, a missing file, a folder, a non-executable file and `"/bin/b\u0000"` → `/bin/sh`; a real executable → itself; `ptySpec` for `/bin/bash` → `args: ["-l"]`, for `/usr/bin/python3` → `[]`; with a scope launch → `file` is the scope's command and `args` end with `[shell, "-l"]`, env has the scope's `XDG_RUNTIME_DIR`; sizes: `0 → 2`, `9999 → 500`, `NaN → 80`, `2.5 → 80`, rows `1000 → 200`.
  - `kill.test.ts` (fake clock, fake `ProcReader`, recording signal): SIGHUP to `-1234` and to members 2001 and 2002 at once, never to 3000 (another session); the shell exits at 500 ms with no member left → resolves then, no SIGKILL, `clock.pending() === 0`; the shell exits at 500 ms while 2001 is still listed → SIGKILL to `-1234` and 2001 at 2 000 ms, not before; the shell never exits → SIGKILL at 2 000 ms, then `pty_kill_timeout` at 7 000 ms and the promise resolves; the pid's start time differs from the target's → no signal at all; pid `1` and `0` throw before any signal; `parseProcStat(7, "7 (a) b (c) S 1 7 7 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 …")` → `{ sid: 7, start: "12345" }`; a text without `)` → null.
  - `scope.test.ts`: `next({ kind: "terminal" })` unit matches `/^pap-[0-9a-f]{8}-term-[0-9a-f]{8}-\d+\.scope$/`, its launch env is `{ XDG_RUNTIME_DIR }` only; `next()` is unchanged (worker).
  - `spawn.int.test.ts` (real node-pty, scopes off, env `{ PATH, HOME: <tmp>, SHELL: "/bin/sh", PAP_SECRET_X: "s3cret", NOTIFY_SOCKET: "/run/x" }`): typing `echo pap-$((6*7))\r` → output contains `pap-42`; `stty size` prints `24 80`, after `resize(100, 30)` prints `30 100`; `echo "[$PAP_SECRET_X][$NOTIFY_SOCKET]"` prints `[][]`; `pwd` prints the real cwd; `/proc/<pid>/oom_score_adj` reads `800`; `for f in /proc/$$/fd/*; do readlink "$f"; done` prints only `/dev/pts/…` lines (M8R119); then, for `/bin/sh` and, when it exists, `/bin/bash`: typed `trap "" HUP; echo $$ > shell.pid; sleep 1000 & echo $! > job.pid; sleep 1001\r` → once `job.pid` holds a pid, `sessionMembers` lists it among at least two members; `ptyKill` → the shell, the job and every listed member are gone (`/proc/<pid>` absent or a zombie) within the 2 s grace plus 5 s (`vi.waitFor`).
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Mutation checks** — drop the platform keys from `isDaemonOnly`: the `NOTIFY_SOCKET` case fails; drop the session walk (`proc.pids()` returns `[]`): the `job.pid` case fails (verified in scratch: the job and the foreground `sleep` survive under dash and bash); end the ladder as soon as the shell exits: the "2001 still listed" case fails.
- [ ] **Step 4: Gate** (unit, int) and commit:

```bash
git add apps/daemon/src/kernel
git commit -m "feat(kernel): spawn PTYs in a scope with a clean environment and a ladder that kills the shell's session"
```

---

### Task 11: The terminal core — output ring, multi-client attach, ack-based flow control

T3 `docs/internals/terminal-runtime.md` (server scrollback 5 000 lines / 8 MiB, live output never truncated, eviction without splitting code points) and Orca's ack opcode are the references. Pure module code over a fake PTY and fake binary streams; Task 12 wires it.

**Rulings (pre-dispatch):**
- **M8R56** [11] *(corrected: RT-28)* The output ring keeps at most 4 MiB and 5 000 lines (counted by `\n`), in chunks of at most 64 KiB, evicting whole chunks from the front; `start` and `end` are byte offsets since the terminal started; `safeStart()` is the first offset at or after `start` that does not fall inside a UTF-8 sequence (skips at most 3 continuation bytes) and, once something was evicted, moves past the first `\n` of the first chunk when there is one, so a replay after a reset never begins inside an escape sequence (`[0;32m` on the first line). T3 uses 8 MiB; pap halves it: 8 terminals × 4 MiB bounds the daemon at 32 MiB of scrollback — cost if wrong: one constant.
- **M8R57** [11] *(corrected: RT-06, owner f2)* Flow control per attached stream: send while `sent − acked < 512 KiB`; past that the stream is paused (`window`) and resumes when an ack brings the lag to 256 KiB or less. A `send` refused because the socket buffers over 1 MiB pauses the stream (`buffer`) and retries every 50 ms on the kernel `Clock` until it goes or the stream closes. An ack beyond `sent` or below `acked` is ignored. A stream paused for more than 2 s (kernel `Clock`) is **stale**: it stays attached but no longer holds the PTY (a background tab's throttled timers stop xterm's write callbacks and its acks; Chrome clamps them to one a minute, iOS suspends the page). The PTY is paused only while it has at least one committed, non-stale stream and every such stream is paused; it resumes as soon as one is not, when the last one goes stale, or when none is attached — a slow phone never stalls a desktop, a hidden tab never stalls a build, and an unattended terminal keeps running into its ring. A stale stream that acks again leaves the stale state: it continues from its offset while that is still in the ring, else it gets `reset` and the ring (M8R58) — cost if wrong: a hidden tab blocks the build in `write()`.
- **M8R58** [11, 12] *(corrected: RT-29)* Attach with `after`: when `safeStart() ≤ after ≤ end` the stream continues from `after` (no reset); otherwise its first frame is `reset` at `safeStart()` followed by the ring. A stream whose next offset was evicted while it was paused gets `reset` the same way when it resumes. The exit frame follows the last output byte: node-pty can report `exit` before its last data chunk, so on `exit` the terminal waits until no data came for 100 ms (at most 1 s, kernel `Clock`) before it records the exit and sends the frame. Attaching to an exited terminal sends the ring (from `after` or a reset) then the exit frame. A connection attaches once per terminal: a repeat returns its existing stream id — cost if wrong: the last line of a command lost after the exit frame.
- **M8R59** [11] Input: accepted only from a stream attached to this terminal, while it runs, with a `seq` greater than that stream's last (a repeat or older one is dropped); the payload (≤ 64 KiB, the codec's cap; the web splits longer input, M8R112) is written to the PTY as is. Resize: clamped (M8R53), last call wins, every client's view follows the PTY's size — cost if wrong: none.
- **M8R60** [11, 12] Caps: running terminals per owner `PAP_MAX_TERMINALS` (default 8, 1–64) → the next create is `capacity` (refuse, never kill one); exited terminals kept per owner: 8, the oldest exited one dropped first (its ring is history, nothing runs); attached streams per terminal: 8 → `capacity`; the free-memory floor (`minFreeMemMb`) refuses a create with `capacity` — cost if wrong: one setting.
- **M8R61** [11, 12] Lifetime (owner f2, M8R92): a terminal lives until the person closes it, its shell exits, or the daemon stops; there is no idle reaping. An exited terminal keeps its ring and stays listed (exit code and signal) until closed or dropped by M8R60 — cost if wrong: a reaper with a setting later.

**Files:**
- Create: `apps/daemon/src/modules/terminal/{ring,flow,terminal,registry}.ts`, `ring.test.ts`, `flow.test.ts`, `terminal.test.ts`, `registry.test.ts`, `testing/fake-pty.ts`, `testing/fake-stream.ts`

**Interfaces:**
- Consumes: Task 1 `BinaryStream`, `BinarySink`; Task 10b `PtyProcess`, `ptyKill`; the kernel `Clock` (stale streams, the exit wait).
- Produces:

```ts
/** Field for field the contract's `TerminalView` (Task 12), which does not exist yet when this task runs. */
export interface TerminalState {
  readonly id: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly createdAt: number;
}
export interface AttachInfo {
  readonly streamId: number;
  readonly start: number;
  readonly end: number;
  readonly cols: number;
  readonly rows: number;
  readonly status: "running" | "exited";
}
export interface Terminal {
  readonly id: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly createdAt: number;
  /** The fields of the contract's `TerminalView` (Task 12 decodes it with that schema). */
  view(): TerminalState;
  /** The stream this connection already has here, if any (M8R58). */
  streamOf(connectionId: string): AttachInfo | null;
  /** Returns the sink the binary channel calls; frames start at its `onOpen` (M8R10). */
  attach(connectionId: string, open: (sink: BinarySink) => BinaryStream, after: number | undefined): AttachInfo;
  detach(streamId: number): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}
export interface TerminalRegistry {
  create(input: { ownerId: string; cwd: string; sessionId: string | null; cols: number; rows: number }): Terminal;
  get(ownerId: string, id: string): Terminal | null;
  list(ownerId: string): readonly Terminal[];
  onChange(listener: (ownerId: string, change: { kind: "terminal"; view: TerminalState } | { kind: "closed"; id: string }) => void): () => void;
  closeAll(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests** (no wall clock: every assertion is on offsets, frames and counts)
  - `ring.test.ts`: appending 5 MiB in 100 KiB chunks keeps `end − start ≤ 4 MiB`, `start` advanced by exactly the evicted bytes, chunks ≤ 64 KiB; 5 001 one-line chunks evict to 5 000 lines; `read(from, max)` returns the exact bytes; `safeStart()` skips the continuation bytes of a 4-byte emoji cut by the eviction and nothing more; `read(start − 1)` throws.
  - `flow.test.ts` (fake PTY, fake streams, fake clock): one stream, 600 KiB of output → frames cover offsets 0 to 512 KiB contiguously, then the stream is paused and the PTY paused; an ack at 200 KiB → still paused (lag 312 KiB); an ack at 300 KiB → resumes (lag 212 KiB), the rest arrives, the PTY resumed; **one stream that never acks → after 2 s of fake clock the PTY resumes and output continues into the ring; it acks within the ring → it continues from its offset, no reset; after 6 MiB more it acks → `reset` then the ring**; two streams, the slow one never acks → the fast one receives all output, the PTY is never paused; after 6 MiB the slow one acks → its next frame is `reset` at `safeStart()`, then the ring; a stream whose `send` returns false → paused, nothing lost, a retry after 50 ms (fake clock) sends from the same offset; acks above `sent` and below `acked` change nothing.
  - `ring.test.ts` (addition): after an eviction, a ring whose first chunk holds `\x1b[0;32mgreen\nnext` has `safeStart()` at the `n` of `next`; with no `\n` in the first chunk only the UTF-8 rule applies.
  - `terminal.test.ts`: attach with `after` inside the ring → first frame `output` at `after`; `after` before `safeStart()` or past `end` → first frame `reset`; a repeat attach on the same connection returns the same stream id and opens nothing; frames wait for `onOpen`; input with seq 1, 2, 2, 1, 3 writes three payloads in order; input from a stream of another terminal or after exit is dropped; resize clamps and calls the PTY once per call; PTY exit → remaining output, then `exit` with `{ code, signal }`, status `exited`; **the fake PTY emits `exit` then a last data chunk 50 ms later → the chunk is framed before the exit frame**; attach to an exited terminal → the ring, then `exit`; `close` on a running terminal calls `ptyKill`, then the scope's `reap` when there is one, closes every stream (each `onClose` once) and emits `closed`.
  - `registry.test.ts`: the 9th running create for one owner → `capacity`, the other owner unaffected; a 9th exited terminal drops the oldest exited (emits `closed`); the 9th stream on one terminal → `capacity`; `closeAll` closes every terminal of every owner; the free-memory floor refuses with `capacity`; ids are 22 base64url characters and differ.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Mutation checks** — resume on any ack (ignore the 256 KiB rule): the "still paused" variant fails; pause the PTY when any stream is paused: the two-stream case fails; drop the `reset` on eviction: the 6 MiB case fails; let a stale stream hold the PTY: the "never acks" case fails; send the exit frame at once: the "exit before data" case fails.
- [ ] **Step 4: Gate** (unit) and commit:

```bash
git add apps/daemon/src/modules/terminal
git commit -m "feat(terminal): output ring, multi-client attach and ack-based flow control"
```

---

### Task 12: Terminals over the wire — RPC, the `terminal` list stream, wiring, stop order, the reconnect proof

Roadmap exit: "a terminal survives a browser reconnect within one daemon lifetime". This task proves it headless.

**Rulings (pre-dispatch):**
- **M8R62** [12] Contract below. Terminal ids are 16 random bytes in base64url. `sessionId` is a tag the web uses to find "this session's terminal": bounded, not checked against the sessions table (it grants nothing) — cost if wrong: none.
- **M8R63** [12] `terminal.create`: `cwd` judged `list` (an existing folder inside the caller's roots, not in `$PAP_HOME`, not Pi's private folders), else `not_found`; caps and floor of M8R60 → `capacity`; node-pty missing → `terminal_unavailable` (M8R51). The PTY spawns with `shellOf(env)`, `shellEnv(env)`, the judged real `cwd` and a terminal scope (M8R54).
- **M8R64** [12] *(corrected: RT-09)* `terminal.attach` answers `{ streamId, start, end, cols, rows, status }`; frames start after that answer (M8R10); `after` per M8R58. `terminal.detach` closes the caller's stream; a closing socket detaches all of its streams (M8R13). Every terminal method is `idempotent: true`, so read-only database mode (spec C §3.2, which refuses every mutation before its handler) never leaves a runaway terminal unclosable or the owner without a shell to repair things: `terminal.resize` (last size wins), `terminal.attach` (a repeat returns the same stream), `terminal.close` (closing an unknown or already closed terminal answers ok: a second close is a no-op, and another owner's id says nothing), and `terminal.create`, which carries a client `requestId` (16–64 base64url characters) instead of a `commandId`: the module keeps `requestId → terminalId` per owner, in memory, for as long as that terminal is listed (at most `PAP_MAX_TERMINALS` + 8 entries per owner, so the map is bounded by the terminal cap and refuses with the cap), and a repeat returns the same terminal, never a second shell — cost if wrong: a runaway `yes` that only a restart stops.
- **M8R65** [12] *(corrected: RT-19)* The `terminal` stream is keyed by the owner (the transport's caller, like `shell`): snapshot = the owner's terminals, at most `TERMINAL_LIMITS.listed` = 72 (64, the highest `PAP_MAX_TERMINALS`, plus 8 exited), events on create, resize, exit and close. `PROTOCOL_VERSION` stays 2; `CAPABILITIES` gains `"terminal"` (an M7-era tab never attaches; agreement 11) — cost if wrong: the web loses the list when the setting is raised.
- **M8R66** [12] *(corrected: agreement 9)* `DaemonHandle.stop()`: M7's `helpers.stopAll()` in parallel with `sessions.shutdownAll()`, then `workspace.shutdown()` (every terminal's ladder in parallel: at most the 2 s grace plus 5 s, then the scope reap), then `killAllWorkerGroups()`, then the closers. `killScopes()` already covers terminal scopes (same home slice). `PAP_MAX_TERMINALS` joins `kernel/config.ts` (`parseCount`, 1–64; a union with M7's `PAP_HELPERS_MAX`, agreement 10) and the AGENTS.md worker settings line (Task 22) — cost if wrong: none.

**Files:**
- Create: `packages/contracts/src/terminal.ts`, `terminal.test.ts`; `apps/daemon/src/modules/terminal/{index,service,rpc}.ts` and tests; `apps/daemon/src/modules/terminal/{terminal,terminal.reconnect,terminal.multi}.int.test.ts`, `terminal.readonly.test.ts`; `apps/daemon/src/daemon.terminal-stop.int.test.ts`; `scripts/smoke-terminal.ts`
- Modify: `packages/contracts/src/{streams,frames,methods,methods.test,index}.ts`; `apps/daemon/src/compose-workspace.ts`, `daemon.ts` (the stop line), `kernel/config.ts` (+ test); `apps/web/src/runtime/subscriptions.ts` (`OPENERS.terminal`) + `subscriptions.m8.test.ts`; `scripts/smoke-dist.ts` (calls the terminal step), `scripts/smoke-lib.ts` (binary frames on its ws client)

**Interfaces:**
- Consumes: Tasks 2, 3a, 10a, 10b, 11.
- Produces: the contract below; `createTerminalModule(deps: { roots; boundary; registry deps; hub; clock; logger; env; scopes; limits }): { rpc: TerminalRpc; shutdown(): Promise<void> }`.

The contract (binding):

```ts
// packages/contracts/src/terminal.ts
import { z } from "zod";
import { defineMethod } from "./define.ts";
import { FilePath } from "./files.ts";
import { Cursor } from "./frames.ts";

/** `listed`: 64 running (the highest `PAP_MAX_TERMINALS`) plus 8 exited (M8R65). */
export const TERMINAL_LIMITS = { listed: 72, cols: { min: 2, max: 500 }, rows: { min: 2, max: 200 } } as const;
export const TerminalId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
/** A client's id for one create: a repeat returns the same terminal (M8R64). */
export const TerminalRequestId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const Cols = z.number().int().min(TERMINAL_LIMITS.cols.min).max(TERMINAL_LIMITS.cols.max);
const Rows = z.number().int().min(TERMINAL_LIMITS.rows.min).max(TERMINAL_LIMITS.rows.max);
const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StreamId = z.number().int().min(1).max(0xffff_ffff);

export const TerminalView = z.object({
  id: TerminalId,
  cwd: FilePath,
  sessionId: z.string().min(1).max(128).nullable(),
  cols: Cols,
  rows: Rows,
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  createdAt: z.number().int().min(0).max(8.64e15),
});
export type TerminalView = z.infer<typeof TerminalView>;

export const TerminalStreamEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), terminals: z.array(TerminalView).max(TERMINAL_LIMITS.listed) }),
  z.object({ kind: z.literal("terminal"), terminal: TerminalView }),
  z.object({ kind: z.literal("closed"), id: TerminalId }),
]);
export type TerminalStreamEvent = z.infer<typeof TerminalStreamEvent>;

/** The `exit` frame's payload. */
export const TerminalExit = z.object({ code: z.number().int().nullable(), signal: z.string().max(32).nullable() });

const Ok = z.object({ ok: z.literal(true) });

export const terminalMethods = {
  "subscribe.terminal": defineMethod({
    name: "subscribe.terminal",
    permission: "terminal:read",
    idempotent: true,
    params: z.object({ after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: [],
  }),
  "terminal.create": defineMethod({
    name: "terminal.create",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({
      requestId: TerminalRequestId,
      cwd: FilePath,
      cols: Cols,
      rows: Rows,
      sessionId: z.string().min(1).max(128).optional(),
    }),
    result: z.object({ terminalId: TerminalId }),
    errors: ["not_found", "capacity", "terminal_unavailable"],
  }),
  "terminal.attach": defineMethod({
    name: "terminal.attach",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ terminalId: TerminalId, after: Offset.optional() }),
    result: z.object({
      streamId: StreamId,
      start: Offset,
      end: Offset,
      cols: Cols,
      rows: Rows,
      status: z.enum(["running", "exited"]),
    }),
    errors: ["not_found", "capacity"],
  }),
  "terminal.detach": defineMethod({
    name: "terminal.detach",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ streamId: StreamId }),
    result: Ok,
    errors: [],
  }),
  "terminal.resize": defineMethod({
    name: "terminal.resize",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ terminalId: TerminalId, cols: Cols, rows: Rows }),
    result: Ok,
    errors: ["not_found"],
  }),
  "terminal.close": defineMethod({
    name: "terminal.close",
    permission: "terminal:operate",
    idempotent: true,
    params: z.object({ terminalId: TerminalId }),
    result: Ok,
    errors: [],
  }),
} as const;
```

- [ ] **Step 1: Write the failing tests**
  - `terminal.test.ts` (contracts): `TerminalId` refuses 21 and 23 characters and `/`; `TerminalRequestId` refuses 15 and 65 characters; `cols: 1` and `rows: 201` refused; `after: -1` refused; a snapshot of 72 terminals passes, 73 fails.
  - `service.test.ts` / `rpc.test.ts` (fake registry and PTY): `create` with a `cwd` outside the roots, in `$PAP_HOME` or a file → `not_found`; node-pty missing → `terminal_unavailable`; the same `requestId` twice → the same `terminalId` and one spawn; a new `requestId` → a second terminal; the map entry goes when its terminal is dropped; `attach` to another owner's terminal → `not_found`; a context without `binary` → `internal` (M8R4); `detach` of an unknown stream → ok; `close` twice → ok both times, one `ptyKill`; `close` of another owner's id → ok and nothing closed.
  - `terminal.int.test.ts` (`startTestDaemon`, `SHELL=/bin/sh` in its environment): `subscribe.terminal` snapshot is empty; `terminal.create { requestId, cwd: t.cwd, cols: 80, rows: 24 }` → a `terminal` event; attach → the answer then binary frames; input `echo hi-$((1+1))\r` → an output frame with `hi-2`; resize to 100 × 30 then `stty size` → `30 100`; `exit\r` → an `exit` frame `{ code: 0, signal: null }` and an event with `status: "exited"`; close → `closed` event; a `cwd` of `t.home` → `not_found`.
  - `terminal.reconnect.int.test.ts` (the exit criterion): client A attaches, types `read x; echo got:$x\r`, writes the output it received and acks its last offset `a`; A's socket closes; client B (a new socket, the same cookie) calls `terminal.attach { terminalId, after: a }` → `start ≤ a ≤ end`, `status: "running"`, and B's first output frame has `seq === a` (no reset, no gap); B types `hello\r` → `got:hello` arrives; the terminal id is unchanged in the list. **Second case, output produced while nobody is attached, with no timing (RT-11):** the test makes a FIFO `f` (`mkfifo`) and A types `read _ < f; echo away-1; : > done\r`, records its last offset `a`, closes; the test writes a line to `f`, then waits with `vi.waitFor` until `done` exists; only then B calls `terminal.attach { after: a }`, retrying (detach, attach) inside `vi.waitFor` until the answer's `end > a` (the daemon has read the bytes); assert `end > a`, B's first frame has `seq === a` and holds `away-1`, and `away-1` appears exactly once across B's frames. Third case: B attaches with `after: end + 10` → its first frame is `reset`. Fourth case: a terminal whose shell exited → attach answers `status: "exited"`, then the ring, then the `exit` frame.
  - `terminal.multi.int.test.ts`: two clients attached see `echo both\r`; one closes, the other still receives; a client that never acks while the other acks: `head -c 6000000 /dev/zero | tr '\0' 'x'` → the acking client receives 6 000 000 contiguous bytes of `x`; the silent one received at most 512 KiB + 64 KiB, then acks and gets a `reset` with `seq ≥ 6000000 − 4 MiB`. A single client that stops acking (the hidden tab): the same command completes (the shell prints `done` after it) while that client never acks — the stale rule keeps the PTY running.
  - `daemon.terminal-stop.int.test.ts` (RT-05): two terminals each run `trap "" HUP; echo $$ > shell-<n>.pid; sleep 1000 & echo $! > job-<n>.pid; sleep 1001\r`; once the four pid files hold pids, `t.stop()` resolves within 10 s; none of the four pids (nor the foreground `sleep`s found by `sessionMembers` before the stop) has a live `/proc` entry afterwards.
  - `terminal.readonly.test.ts` (RT-09; the real `kernel/ws` dispatcher with `receipts.readOnly: true`, as in `dispatcher.test.ts`, over the terminal and files RPC handlers with fakes behind them): `terminal.create { requestId }` and `terminal.close` reach their handlers and answer ok; `terminal.attach`, `resize`, `detach` too; `files.write` answers `read_only` before its handler. (The HTTP routes' 503 `read_only` is pinned in Tasks 6b and 7.)
  - `config.test.ts`: `PAP_MAX_TERMINALS` unset → 8; `"0"` → `ConfigError`; `"65"` → `ConfigError`.
  - web `subscriptions.m8.test.ts`: the `terminal` opener calls `subscribe.terminal` with the cursor only.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.** The smoke step (`scripts/smoke-terminal.ts`): create a terminal in the smoke folder, attach over the raw socket, type `echo pap-smoke-$((6*7))\r`, wait for `pap-smoke-42` (10 s), close — it proves node-pty loads from `apps/daemon/dist`.
- [ ] **Step 3: Gate** (unit, int, build, smoke, budgets: +0.6 KB) and commit:

```bash
git add packages/contracts apps/daemon/src apps/web/src/runtime scripts
git commit -m "feat(terminal): terminals over binary frames that survive a browser reconnect"
```

---

### Task 13: The security suite, M8 half (spec C §8.1) — traversal on every file route, protected paths, Origin, tokens

M5's `security/traversal.int.test.ts` covers static serving and the export route; this task covers every route M8 adds, through the whole daemon.

**Rulings (pre-dispatch):**
- **M8R67** [13] One file per concern, every case through a real daemon (`startTestDaemon`); statuses and error codes asserted exactly; every refusal also asserts that no response body contains the fixture's secret text; nothing here runs `curl`, `wget` or a destructive command (M5R104); the token cases of agreement 5 are pinned here (`files-origin.int.test.ts`), each refusal answering `forbidden` — cost if wrong: false assurance.

**Files:**
- Create: `apps/daemon/src/security/{files-traversal,files-protected,files-origin,terminal-boundary}.int.test.ts`
- Modify: `apps/daemon/src/security/testing/fixtures.ts` (`rawPut`, `rawPost`, a fixture builder: `outside/secret.txt` holding `SECRET_TEXT_outside_the_roots`, links, a FIFO, hard links into `<agentDir>` and `t.home`, a session whose folder holds `t.home` so pap's home sits inside a root, a session whose folder is the harness's `userHome` so the home folder is a root, a token minted with `files:read` + `files:operate` + `vcs:read`)

**The matrix** (`files-traversal.int.test.ts`; R = the session's folder, O = a folder beside it):

| Hostile form | `files.list` / `files.read` / `files.write` (RPC) | `GET /files/raw` | `PUT /files/raw` | `files.search` root | `vcs.fileDiff` | `subscribe.vcs` root | `terminal.create` cwd |
|---|---|---|---|---|---|---|---|
| `R/../O/secret.txt` | `not_found` | 404 | 404 | `not_found` | `bad_request` (RepoPath) | `not_found` | `not_found` |
| `R/link-out/secret.txt` (`link-out → ../O`) | `not_found` | 404 | 404 | — | `not_found` | `not_found` | `not_found` |
| `R/lnk/../secret.txt` (`lnk → O/deep`) | `not_found` | 404 | 404 | — | `bad_request` | `not_found` | `not_found` |
| `R/%2e%2e/O/secret.txt` (literal), `%252e%252e` (HTTP) | `not_found` | 404 | 404 | `not_found` | — | `not_found` | `not_found` |
| `R/a\..\..\O\secret.txt` (literal backslashes) | `not_found` | 404 | 404 | — | — | — | — |
| NUL inside, a 5 000-byte path, a relative path | `bad_request` | 404 | 404 | `bad_request` | `bad_request` | `bad_request` | `bad_request` |
| `<t.home>/state.db` (pap's home inside a root) | `not_found` (list of `t.home` too) | 404 | 404 | — | — | — | `not_found` (cwd `t.home`) |
| `<agentDir>/auth.json`, `models.json`, `mcp.json`, `settings.json`, `<agentDir>/sessions/x.jsonl` | `not_found` | 404 | 404 | — | — | — | — |
| `R/notes.txt`, a **hard link** to `<agentDir>/auth.json`; `R/db.bin`, a hard link to `<t.home>/state.db` (RT-01) | `not_found` (read and write; listed as an ordinary name) | 404 | 404 (`conflict=replace`; both private files asserted intact) | — | `not_found` (worktree side) | — | — |
| `R/x → /proc/self/cwd`, `R/r → /proc/self/root` | `not_found` | 404 | 404 | — | `not_found` | `not_found` | `not_found` |
| a FIFO in R | `not_found`, answered (no hang) | 404, answered | — | — | `not_found` | — | — |
| `/tmp`-like folder no project holds | `not_found` | 404 | 404 | `not_found` | `not_found` | `not_found` | `not_found` |
| control: `R/ok.txt` | listed, read | 200 | 200 | found | diff | snapshot | created |

Plus: the listing of the session that holds `t.home` shows the `home` entry `protected: true`; `GET /files/raw?path=R/x.svg` → 200 with `image/svg+xml`, `RAW_CSP` and `nosniff`, and `R/x.html` → an attachment, never `text/html`; R78: `GET /files/nope` and `POST /upload/x` → 404 `{"error":{"code":"not_found"}}`. Every refusal row also asserts that no body holds `SECRET_TEXT_outside_the_roots`, the bed's `auth.json` key or the `state.db` header (`SQLite format 3`).

`files-protected.int.test.ts` (browser session): `files.write` to `R/.git/hooks/pre-commit`, `R/.envrc`, `R/.vscode/tasks.json` → `protected_path` and nothing written; with `confirmProtected: true` → written; `R/.pi/extensions/x.ts` with `confirmProtected: true` and no step-up → `step_up_required`, nothing written; after `POST /auth/confirm` with the owner's password (M5's step-up) → written; `<agentDir>/settings.json`, `models.json` (agent folder inside a root) with confirmation and a step-up → `not_found` (Settings is their editor, owner c3); `<agentDir>/extensions/e.ts` with confirmation and a step-up → written; with the home folder as a root: `<userHome>/.bashrc` → `protected_path`, then written with the confirmation; `<userHome>/proj/a.txt` → written without one (owner f8); the same cases through `PUT /files/raw` (409, then 403 `step_up_required` where it applies, then 200).

`files-origin.int.test.ts`: `PUT /files/raw` and `POST /upload` without `Origin` → 403, with a foreign `Origin` → 403, both logged `origin_refused`; with `Authorization: Bearer <a real token>` and a good Origin but no cookie → 401; a token holding only `sessions:read` → `files.read` over `/ws` answers `forbidden`; a token holding `files:read` → `terminal.create` answers `forbidden`; `auth.tokens.create` with `terminal:operate` → `bad_request` (M8R2). **Tokens never make a code-running change (agreement 5):** a token with `files:operate` → `files.write` of an ordinary `R/a.txt` → written; `R/.git/hooks/x` with `confirmProtected: true` → `forbidden`, without → `forbidden`; `confirmProtected: true` on `R/b.txt` → `forbidden`; `R/.pi/x.json` → `forbidden`; `R/.envrc` → `forbidden`; nothing of these on disk. **Tokens never read keys (owner f8, f10):** a token with `files:read` → `files.read` of `R/.pi/mcp.json` and `R/.mcp.json` → `not_found` (the browser session reads both); with the home folder as a root, `files.read` of `<userHome>/.ssh/id` → `not_found`, `files.list` of `<userHome>` shows `.ssh` with `protected: true`, `files.search` never returns a `.pi/mcp.json` path; `vcs.fileDiff` of `.pi/mcp.json` (`head` side) → `not_found`.

`terminal-boundary.int.test.ts`: a typed `cd /; cat <O>/secret.txt` **does** print it (the terminal is the owner's shell: the boundary judges only where a terminal starts; this case documents that the terminal is not a sandbox, M8R63, and that taint does not apply to the owner's shell); a terminal's environment has no `PAP_*` and no `NOTIFY_SOCKET` / `INVOCATION_ID` variable although the daemon had `PAP_TEST_PROVIDER_SCRIPT` and both systemd variables set; every fd of the shell links to `/dev/pts/*` (M8R119).

- [ ] **Step 1: Write the four files** (they fail where an earlier task left a gap: fix it in the owning module, name it in the report).
- [ ] **Step 2: Mutation checks** — remove the spelled-path clause of `judgePath`: a `link-out` row fails; drop the deny check of `checkDescriptor`: the hard-link row returns the key and fails; let `gateWrite` accept a token's `confirmProtected`: the token hook case fails; remove `entryIsProtected`: the `home` entry row fails. (`ownCsp` is Task 6a's mutation.)
- [ ] **Step 3: Gate** (unit, int) and commit:

```bash
git add apps/daemon/src/security
git commit -m "test(security): path traversal and protected paths on every M8 route"
```

---

### Task 14: Web runtime — binary frames, the terminal channel, uploads, the `vcs` and `terminal` stores

Spec C §7.1: the runtime is the only code that touches the socket; stores are fed by it. The codec and the channel stay out of the initial bundle (only the terminal pane imports them).

**Rulings (pre-dispatch):**
- **M8R68** [14] `connection.ts`: the socket's `binaryType` is `"arraybuffer"`; an `ArrayBuffer` message goes to `onBinary` listeners (never JSON-parsed, only while `open`), a string to the JSON path as today; `sendBinary(bytes)` returns false unless open. No decoding here — cost if wrong: none.
- **M8R69** [14, 20] `runtime/terminal-channel.ts` (`getTerminalChannel()`, built once over the runtime, imported only by the terminal feature): one attachment per terminal per page; attach on open and again after every reconnect, with `after` = the offset up to which the sink finished writing (the first open sends no `after`: reset and ring); an ack every 64 KiB written and whenever the write queue empties; input frames numbered 1, 2, … per stream (a new stream starts again at 1), input longer than 64 KiB split on UTF-8 boundaries (M8R112), a hidden page detached after 5 s (M8R111); `not_found` on an attach → state `gone`; frames of an unknown or replaced stream are dropped; an attach answer for a socket that has since dropped is ignored (generation, R11) — cost if wrong: none.
- **M8R111** [14, 20] *(new: RT-06, owner f2)* The terminal channel detaches a terminal's stream 5 s after the page becomes hidden (`visibilitychange`, timers through the runtime's `Timers`) and reattaches with `after` = its written offset as soon as the page is visible again; a page hidden for less than 5 s keeps its stream. The server's stale rule (M8R57) covers the 5 s and a page whose timers stop before it can detach. The visibility source is injected (`{ hidden(): boolean; onChange(listener): () => void }`, the document's by default) — cost if wrong: a hidden tab that holds the PTY for 2 s of every resume.
- **M8R112** [14] *(new: RT-31)* `TerminalHandle.input(data)` splits data longer than 64 KiB (the codec's payload cap, which the server enforces by dropping the frame) into frames of at most 64 KiB cut on UTF-8 boundaries, numbered in order: a large paste arrives whole — cost if wrong: a pasted text that vanishes.
- **M8R70** [14] `runtime/upload.ts`: `uploadAttachment(sessionId, file, signal)` → `POST /upload`; `uploadFile(path, file, { conflict, confirmProtected?, signal })` → `PUT /files/raw`; answers decoded with the contract (`AttachmentView`, `FileMeta`); statuses map to codes from the body when it has one (`401 unauthenticated`, `403` → `forbidden` or `step_up_required`, `404 not_found`, `409` → `protected_path` / `limit_reached` / `conflict`, `413 payload_too_large`, `503` → `capacity` / `read_only`), a rejected fetch → `offline` when the browser reports itself offline, else `interrupted` (the upload stopped before the end: a client-side outcome shown with the `upload.interrupted` copy, M8R106; never an `ERROR_CODES` entry). Stores: `vcs-store` keyed by root (a snapshot or a `status` event replaces the entry; an event the schema refuses is skipped, the cursor still moves), `terminal-store` (the owner's list), each with a feed module like `shell-feed.ts`.

**Files:**
- Modify: `apps/web/src/runtime/{connection,testing,index}.ts` (+ `connection.binary.test.ts`)
- Create: `apps/web/src/runtime/{terminal-channel,upload}.ts` and tests; `apps/web/src/stores/{vcs-store,vcs-reducer,vcs-feed,terminal-store,terminal-reducer,terminal-feed}.ts` and tests

**Interfaces:**
- Consumes: Tasks 2, 7, 9, 12 contracts.
- Produces: `Connection.sendBinary(bytes: Uint8Array): boolean`, `Connection.onBinary(listener: (data: ArrayBuffer) => void): () => void`;

```ts
export interface TerminalSink {
  attached(info: { start: number; end: number; cols: number; rows: number; status: "running" | "exited" }): void;
  reset(): void;
  /** Resolves once the bytes are on screen (xterm's write callback): the channel acks from there. */
  output(bytes: Uint8Array, end: number): Promise<void>;
  exit(code: number | null, signal: string | null): void;
  state(state: "attaching" | "live" | "offline" | "gone"): void;
}
export interface TerminalHandle {
  input(data: Uint8Array): boolean;
  resize(cols: number, rows: number): void;
  close(): void;
}
export interface TerminalChannel {
  open(terminalId: string, sink: TerminalSink): TerminalHandle;
}
```

`useVcs(root): VcsStatus | null`, `useTerminals(): readonly TerminalView[]`, `uploadAttachment`, `uploadFile`.

- [ ] **Step 1: Write the failing tests** (fake socket, fake timers)
  - `connection.binary.test.ts`: an `ArrayBuffer` message reaches `onBinary` and no JSON listener; a string still reaches `onFrame`; `sendBinary` before `open` → false; the created socket has `binaryType === "arraybuffer"`.
  - `terminal-channel.test.ts`: `open` sends `terminal.attach` without `after`; the answer gives `attached()`; a `reset` frame calls `reset()`; output frames call `output()` in order; after 64 KiB written one ack goes with the written offset; when the queue empties an ack goes; the socket drops → `state("offline")`, reconnect → `terminal.attach { after: <written offset> }`; an attach answer from before the drop is ignored; `not_found` → `state("gone")`; input frames carry seq 1, 2, 3 and restart at 1 on a new stream; `input` while offline → false; a frame for stream 99 is dropped; `close` sends `terminal.detach`; the page hidden for 4 s then visible → no detach; hidden for 5 s → `terminal.detach`, then visible → `terminal.attach { after: <written offset> }`; `input` of 150 KiB of `é` → three frames of at most 64 KiB, each valid UTF-8, seq increasing, concatenating to the input.
  - `upload.test.ts` (fake `fetch`): `POST /upload?sessionId=…&name=<encoded>` with the file as body; 201 → `AttachmentView`; 409 `{"error":{"code":"limit_reached"}}` → `limit_reached`; 413 → `payload_too_large`; a rejected fetch with `navigator.onLine === false` → `offline`; `uploadFile` builds `PUT /files/raw?path=…&conflict=skip` and adds `confirmProtected=1` only when asked; 403 `{"error":{"code":"step_up_required"}}` → `step_up_required`; 503 `capacity` → `capacity`; a rejected fetch while online → `interrupted`.
  - `vcs-reducer.test.ts`, `terminal-reducer.test.ts`: snapshot replaces; events update; an unknown `kind` leaves the state and is counted.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Mutation checks** — ack on every frame instead of the written offset: the "after 64 KiB" case fails; drop the visibility detach: the hidden-5-s case fails; send a long input as one frame: the 150 KiB case fails.
- [ ] **Step 4: Gate** (unit, build, budgets: +0.6 KB initial expected: the connection lines and the terminal store the surface bar reads) and commit:

```bash
git add apps/web/src/runtime apps/web/src/stores
git commit -m "feat(web): binary frames, the terminal channel, uploads and the vcs and terminal stores"
```

---

### Task 15: Panes and the Chat / Review / Term switch

M3R102 left the switch absent until M8. DESIGN §8: panes split on desktop ("chat, terminal, diff…"), one pane at a time with a Chat / Review / Term segmented switch on phones.

**Rulings (pre-dispatch):**
- **M8R71** [15] Item kinds `{ kind: "files"; root: string }`, `{ kind: "changes"; root: string }`, `{ kind: "terminal"; id: string }`; keys `files:<root>`, `changes:<root>`, `terminal:<id>`. URLs: `/explore/<root as base64url of its UTF-8>`, `/changes/<same>`, `/term/<id>` — never under `/files` (a reserved daemon prefix, R78: a reload there would get JSON), and never with `%2F` in a segment (the static handler refuses `//` and encoded forms, so a reload would 404). A decoded root must be canonical and absolute (the web mirror of `canonical`); a stored workspace with an invalid one drops that tab (M3's rule). Each kind renders a lazy pane of its own (`LazyPane`, own chunk, own catalog) — cost if wrong: one URL scheme.
- **M8R72** [15] Desktop: a session tab gets a `SurfaceBar` above its pane, rendered by `routes/shell/PaneHost.tsx` (not inside `SessionScreen.tsx`, which M7 edits): Changes, Terminal, Files — each splits the tab with that item (`splitTab`), or focuses it when it is already the split. Phones (`MobileShell`, under 768 px): a segmented Chat / Review / Term switch at the top of a session tab, showing the tab's main item or its split item, one at a time. The session's project root comes from the shell store (`ShellSession.projectId` → `ProjectSummary.root`), its folder from `ShellSession.cwd`; a session the store does not hold disables the bar — cost if wrong: none.
- **M8R73** [15, 20] "This session's terminal" is the newest running terminal tagged with the session id; with none, Terminal creates one (`terminal.create { requestId, cwd, sessionId, cols: 80, rows: 24 }`, a fresh `requestId` per click, reused when the same click is retried after a dropped answer; the pane fits its size at mount). Three palette commands, no default chords: `session.showChanges`, `session.openTerminal`, `session.showFiles` (specs in `features/commands/defaults.ts`, handlers in `routes/shell/shell-commands.ts`), acting on the active session tab.

**Files:**
- Modify: `apps/web/src/features/workspace/{model,item-path}.ts` (+ tests); `apps/web/src/routes/shell/{pane-renderers,item-title,PaneHost,MobileShell,shell-commands}.tsx` (+ tests); `apps/web/src/features/commands/defaults.ts`; `apps/web/src/i18n/catalog/shell.ts` (the six eager labels of agreement 17: Chat, Review, Term, Changes, Terminal, Files; the three item titles reuse the last three)
- Create: `apps/web/src/routes/shell/{SurfaceBar,SurfaceSwitch}.tsx` (+ tests); placeholders `apps/web/src/features/files/FilesPane.tsx`, `features/vcs/ChangesPane.tsx`, `features/terminal/TerminalPane.tsx` (an `EmptyState`, replaced in Tasks 17, 19, 20); lazy catalogs `apps/web/src/i18n/catalog/{files,changes,terminal}.ts` with their `register-*.ts`

**Interfaces:**
- Consumes: Task 14 stores and `getRuntime().rpc`.
- Produces: the item kinds, `encodeRoot(root): string`, `decodeRoot(segment): string | null`, `SurfaceBar`, `SurfaceSwitch`, the three lazy pane entry files (props `{ root }`, `{ root }`, `{ id }`; Tasks 17/19 add an `onOpenFile` / `onOpenChanges` prop given by `pane-renderers`).

- [ ] **Step 1: Write the failing tests**
  - `item-path.test.ts`: round trip of each kind with roots `/home/u/my proj`, `/srv/été/app.v2`, `/`; every generated path matches `^/(explore|changes)/[A-Za-z0-9_-]+$` or `^/term/[A-Za-z0-9_-]{22}$`; a segment that decodes to `a/b`, `/a/../b`, `/a//b` or invalid base64 → null; `/files/x` is not an item path.
  - `model.test.ts`: keys of the new kinds; `openItem` and `splitTab` accept them.
  - `PaneHost.test.tsx`: a session tab shows the bar, a settings tab does not; Changes splits with `{ kind: "changes", root }` from the shell store; pressing it again focuses the split; a session missing from the store disables the three buttons.
  - `MobileShell.phone.test.tsx`: a session tab shows the switch with Chat selected; Review renders only the changes pane; Term with no tagged terminal calls `terminal.create` once (fake RPC) and shows the terminal pane; Chat returns to the session.
  - `shell-commands.test.ts`: the three commands act on the active session tab and decline elsewhere.
  - `build-output.int.test.ts`: the markers `data-files-pane`, `data-changes-pane`, `data-terminal-pane` are absent from every initial file.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets: +0.8 KB) and commit:

```bash
git add apps/web/src
git commit -m "feat(web): files, changes and terminal panes, the session surface bar and the phone switch"
```

---

### Task 16: `@pap/ui/code` — the CodeMirror editor and the S5 DiffView, lazy

S5 chose CodeMirror merge (`unifiedMergeView`) for M9's review; M8 ships it read-only, beside the editor (spec A §5.2), one engine for viewer, editor and diff.

**Rulings (pre-dispatch):**
- **M8R74** [16–19] `@pap/ui/code` is a subpath of its own (`packages/ui/src/code.ts`, never re-exported by the eager barrel): `CodeEditor` (`value`, `readOnly`, `language`, `onChange`, `onSave` on Mod-s, `labels`), `DiffView` (`before`, `after`, `language`; read-only `unifiedMergeView` with `collapseUnchanged: { margin: 3, minSize: 4 }` and `mergeControls: false`), `languageFor(path)`. Theme: `EditorView.theme` and a `HighlightStyle` whose values are `var(--…)` tokens only, including S5's override rules for the merge view's own colours (`--diff-add`, `--diff-del` for the changed lines): a theme switch needs no re-render. No blinking cursor (`drawSelection({ cursorBlinkRate: 0 })`, DESIGN §7.2). `build-output.int.test.ts` gains the markers `cm-editor` and `cm-mergeView` as absent from every initial file; `/dev/ui` shows both in the three themes — cost if wrong: none.
- **M8R75** [16] Languages, each a lazy chunk (`languageFor(path)` returns a loader or null): `ts tsx js jsx mjs cjs` → `@codemirror/lang-javascript` (`typescript` / `jsx` flags), `json jsonc` → `lang-json`, `md mdx` → `lang-markdown`, `py` → `lang-python`, `css scss less` → `lang-css`, `html htm` → `lang-html`, `yaml yml` → `lang-yaml`; `sh bash zsh`, `toml`, `Dockerfile` (by name), `go`, `rs` → `@codemirror/legacy-modes` stream modes; anything else plain text. A loader that fails falls back to plain text with one `lazy_chunk_failed` report (M3's rule). The implementer scans the built chunks (no `light-dark(`, no nested CSS, no RegExp `v` flag) and writes the result in the commit body — cost if wrong: a language added later in one line.

**Files:**
- Modify: `packages/ui/package.json` (the CodeMirror dependencies of the Tech Stack table, exact versions; `exports["./code"]`), `apps/web/src/build-output.int.test.ts`, the dev gallery (`apps/web/src/gallery/…`, a `code` section)
- Create: `packages/ui/src/code.ts`, `packages/ui/src/code/{CodeEditor,DiffView,theme,languages}.tsx|ts` and tests

**Interfaces:** Produces `CodeEditor`, `DiffView`, `languageFor`; props take strings and labels only (`@pap/ui` knows nothing of contracts).

- [ ] **Step 1: Write the failing tests** (happy-dom)
  - `languages.test.ts`: `languageFor("a.tsx")` loads the JavaScript support with `typescript: true, jsx: true`; `Dockerfile` and `x/Dockerfile.dev` get the Dockerfile mode; `a.unknown` → null; a loader that rejects → plain text and one report.
  - `theme.test.ts`: every value in the theme spec and the highlight style matches `/^var\(--[a-z0-9-]+\)/` (no `#…`, `rgb(`, `hsl(`).
  - `CodeEditor.test.tsx`: mounts `.cm-editor` with the value; `readOnly` refuses a typed change; Mod-s calls `onSave` with the current text; `onChange` fires on an edit.
  - `DiffView.test.tsx`: `before` / `after` with two changed regions produce two chunks (`getChunks`); identical texts produce none and show the "No changes" label.
  - `build-output.int.test.ts`: the two markers are absent from initial files.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets: +0 KB initial; record the lazy `code` chunk size, expected 110–150 KB gzip) and commit. *(RT-34)* `lang-*` and `merge` depend on `@codemirror/{state,view,language}` by caret range: `pnpm why @codemirror/state` must show one version, written in the commit body; if pnpm resolved a second copy under `minimumReleaseAge`, add a `pnpm.overrides` entry pinning the table's version (never a bypass of the release age) and say so:

```bash
git add packages/ui apps/web/src pnpm-lock.yaml
git commit -m "feat(ui): lazy CodeMirror editor and diff view themed by tokens"
```

---

### Task 17: The files pane — explorer and viewer

**Rulings (pre-dispatch):**
- **M8R76** [17] `FilesPane { root }`: an explorer (280 px; on phones a stacked view: the tree, then the open file with Back) and a viewer with tabs for at most 8 open files (the oldest clean one closed first; a dirty one is never closed silently, Task 18). Folders load their children on expand (`files.list`); the expanded set per root lives for the page's life (at most 20 folders, pi-web's LRU); open folders are listed again when the root's vcs status changes (`status.at` moved), on window focus and on Refresh. "Show ignored" is a per-device switch (`pap.files.showIgnored`). Rows show the name as text (`INVISIBLE` characters dropped, clipped to 255), a lock with a tooltip for `protected` and `link: "outside"` entries (not expandable: "Protected: pap's data, Pi's configuration or a file hidden from this access", "Points outside the project", owner f5), `other` entries inert. The viewer: binary → size and Download; image (by extension) → `<img src="/files/raw?path=…">` and Download; markdown → Preview (the existing lazy `Markdown`, no raw HTML, no images loaded) or Source; anything else → `CodeEditor` read-only; Load more while `nextOffset` is set; Download is `<a href="/files/raw?path=…&download=1" download>`. ARIA tree pattern (`role="tree"`, `treeitem`, `aria-expanded`, arrow keys, Home/End) — cost if wrong: none.
- **M8R116** [17, 18] *(new: RT-41)* Load more checks that the file did not change between chunks: each `files.read` answer's `meta.size` and `meta.mtimeMs` must equal the first chunk's, else the viewer drops what it has and reloads from offset 0 with the note "The file changed while loading; reloaded." (at most twice in a row, then it shows the first chunk and the note "This file keeps changing."). Edit needs a consistent whole, so it is offered only when the whole file came from chunks of one version — cost if wrong: an editor opened on a mix of two versions.
- **M8R77** [17, 21] Tree rows are draggable: `dataTransfer` gets `application/x-pap-path` (the absolute path) and `text/plain` (the same); the composer (Task 21) reads it without importing this feature (T3 `fileTreeDragMention.ts`).

**Files:**
- Create: `apps/web/src/features/files/{FilesPane,Explorer,ExplorerRow,ViewerTabs,FileViewer}.tsx`, `{use-folder,use-open-file,files.vm}.ts` and tests (`FilesPane.tsx` replaces the Task 15 placeholder)
- Modify: `apps/web/src/i18n/catalog/files.ts`

**Interfaces:** Consumes `files.list`, `files.read`, `useVcs(root)`, `@pap/ui/code`, `Markdown`; produces `use-open-file.ts` (`{ meta, text, loadMore, reload }`) that Task 18 extends.

- [ ] **Step 1: Write the failing tests**
  - `files.vm.test.ts`: the visible rows of a tree with three expanded folders, in order; expanding a 21st folder forgets the least recently opened; a `protected` or `outside` row is not expandable; a name built with `String.fromCodePoint(0x202e)` shows without it.
  - `Explorer.test.tsx`: expanding calls `files.list` once and lists the children; ArrowRight / ArrowLeft expand and collapse; a vcs `status.at` change lists the open folders again; switching "Show ignored" lists with `showIgnored: true`; a row's drag start sets both data types to the absolute path.
  - `FileViewer.test.tsx`: binary → the Download link `href` equals `/files/raw?path=<encodeURIComponent(path)>&download=1`; an image → `img.src` equals `/files/raw?path=<encoded>`; markdown toggles Preview / Source; Load more appends the next chunk; a second chunk whose `mtimeMs` differs from the first → the viewer reloads from offset 0 and shows the note, and a third change in a row shows "This file keeps changing."; `not_found` → "This file is gone or outside the project".
  - `ViewerTabs.test.tsx`: a 9th file closes the oldest clean tab.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets: +0 KB initial) and commit:

```bash
git add apps/web/src
git commit -m "feat(web): the files pane, with an explorer, viewer tabs and downloads"
```

---

### Task 18: Editing — save, conflicts, protected files

**Rulings (pre-dispatch):**
- **M8R78** [18] Edit is offered only when `meta.editable` and the whole file is loaded; Save is a button or Mod-s in the editor; `files.write` carries the base etag and a `commandId`. `conflict` → a banner "Changed on disk since you opened it" with Reload (an inline confirm first: the edit is dropped) and Overwrite (re-reads the etag, writes again; the banner says the other change is lost). `protected_path` → an inline ask "This file can run commands later (a git hook, an editor task or a shell setting). Save anyway?" (Save / Cancel), resent with `confirmProtected: true` (owner c3); on a `step_up` file the ask says "This is Pi's configuration or code: pap will ask for your password." and a `step_up_required` answer opens M5's password prompt, then resends once with the same `commandId` (`withStepUp`, R124); a cancel leaves the editor dirty. The ask is shown before the first send when `meta.protection` is not `none`, so a protected save never needs a round trip to learn it. `timeout` → the outcome is unknown: re-read; when the page is a secure context and the new etag equals the SHA-256 prefix of the saved text it says Saved, else "The save may not have completed" with Reload (never re-sent, R105). `payload_too_large` → "Too large to save here"; the editor also says so before sending when `new TextEncoder().encode(JSON.stringify(text)).byteLength` passes 900 000 (a frame over 1 MiB would close the socket, terminals included: M8R26, RT-22). Closing a dirty viewer tab asks "Discard your changes?"; the page warns on unload while a tab is dirty. A clean file whose mtime moved reloads on window focus; a dirty one gets the conflict banner instead. Escape in the editor is CodeMirror's (it closes its search panel); the files pane is not a session pane, so `session.stop` never sees it — cost if wrong: none.

- **M8R117** [18] *(new: owner c3)* The files pane takes a `stepUp: { run<T>(attempt: (commandId: string) => Promise<T>, commandId: string): Promise<T>; prompt: ReactNode }` prop: its lazy entry `routes/shell/files-pane-entry.tsx` builds it from `features/auth`'s `useStepUp` and `withStepUp` (features never import each other; routes may), and `pane-renderers` loads that entry lazily, so the password prompt stays out of the initial bundle — cost if wrong: none.

**Files:**
- Modify: `apps/web/src/features/files/{FileViewer.tsx,use-open-file.ts,FilesPane.tsx}`, `apps/web/src/routes/shell/pane-renderers.tsx` (the files kind loads the entry); Create `apps/web/src/features/files/{EditorBar.tsx,use-save.ts}` and tests, `apps/web/src/routes/shell/files-pane-entry.tsx` (+ test); `apps/web/src/i18n/catalog/files.ts`

- [ ] **Step 1: Write the failing tests** — save → `files.write` with the base etag, then clean and the new etag kept; `conflict` → banner; Overwrite → `files.read` then `files.write` with the fresh etag; `protected_path` → the ask, then a resend with `confirmProtected: true` and the same text; a `meta.protection: "confirm"` file shows the ask before any send; a `step_up` file: the ask, then `step_up_required` → the stub `stepUp.run` asks once and the resend carries the same `commandId`, a cancel sends nothing more; a text of 200 KiB of `\u0001` → "Too large to save here" and no `files.write`; `files-pane-entry.test.tsx`: the entry renders the pane with a `stepUp` whose prompt is the auth feature's; `timeout` with a matching hash (stubbed `crypto.subtle`) → Saved, with a different one → the warning and no resend; `payload_too_large` → the message; closing a dirty tab asks; `beforeunload` is armed only while dirty; focus with a moved mtime reloads a clean file and shows the banner on a dirty one.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets) and commit:

```bash
git add apps/web/src
git commit -m "feat(web): edit and save files, with conflict and protected-file questions"
```

---

### Task 19: The changes pane (Review)

**Rulings (pre-dispatch):**
- **M8R79** [19] `ChangesPane { root, onOpenFile }`: a header with the branch (or "detached"), ↑ahead ↓behind, `+adds −dels` in tabular figures, Refresh (`vcs.refresh`), and the states: not a repository (EmptyState "This folder is not a git repository"), `git_missing` ("Git is not installed on the server"), `timeout` ("Git took too long; Refresh to try again"), `truncated` ("Showing the first 2 000 changes"). The list groups Conflicts, Changes, Untracked; a row shows a status chip with a word (Modified, Added, Deleted, Renamed, Copied, Type changed, Untracked, Conflict: never colour alone), the path (old → new for a rename) and its counts. Selecting a row loads `vcs.fileDiff { from: { kind: "head" }, to: { kind: "worktree" } }` into the lazy `DiffView`; binary → "Binary file changed"; truncated → "Too large to show here" with Open in Files (`onOpenFile(absolutePath)`, given by `pane-renderers`: features never import each other). The pane asks `vcs.refresh` on window focus (at most once a second) and when a session of the shell store whose folder is inside the root goes from running to idle (T3 refreshes after turns) — cost if wrong: none.

**Files:**
- Create: `apps/web/src/features/vcs/{ChangesPane,ChangeList,FileDiff}.tsx`, `{changes.vm,use-refresh}.ts` and tests (`ChangesPane.tsx` replaces the placeholder)
- Modify: `apps/web/src/routes/shell/pane-renderers.tsx` (`onOpenFile`), `apps/web/src/i18n/catalog/changes.ts`

- [ ] **Step 1: Write the failing tests** — `changes.vm` groups and orders (conflicts first, then by path), labels each kind with its word, formats `+12 −3`; the pane shows each state's text; selecting a row calls `vcs.fileDiff` with the head → worktree sides and renders `DiffView` with both texts; binary and truncated show their texts; a session going running → idle under the root triggers one `vcs.refresh`; two focus events within a second trigger one.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets) and commit:

```bash
git add apps/web/src
git commit -m "feat(web): the changes pane with per-file diffs"
```

---

### Task 20: The terminal pane — `@pap/ui/terminal` and the feature

**Rulings (pre-dispatch):**
- **M8R80** [20] `@pap/ui/terminal` is a subpath of its own (`packages/ui/src/terminal.ts`): `TerminalSurface` over xterm 6 (`scrollback: 5000`, `cursorBlink: false`, `allowProposedApi: false`, the font of the `--font-mono` token), the fit addon (a `ResizeObserver`; a size reported at most every 100 ms), the WebGL addon inside a `try`, disposed on `onContextLoss` (the DOM renderer takes over). Theme from the computed tokens, read again when `<html data-theme>` changes (`MutationObserver`): background `--bg`, foreground `--text`, cursor `--you-fill`, selection `--surface-2`, the 16 ANSI colours by DESIGN §9.2's mapping (black → `--text-dim`, red → `--err`, green → `--ok`, yellow → `--you`, blue → `--agent`, magenta → `--attn`, cyan → `--agent`, white → `--text`; bright variants the same); 256-colour and truecolor pass through. xterm's CSS ships inside the lazy chunk only. The root carries `data-terminal-input` (M2R137: pap's chords and Escape stay out, `panelFocus`); Ctrl+] leaves the terminal and focuses the pane header. *(RT-33)* Links: xterm's `linkHandler` (OSC 8) and the web-links matcher open only `http:` and `https:` URLs, with `window.open(url, "_blank", "noopener,noreferrer")`; any other scheme does nothing (the CSP is not the only guard against `javascript:`); the clipboard addon (OSC 52) is never loaded. *(RT-32)* The fit observer reacts only to the pane's own size (`ResizeObserver` on the container): a size that arrives from the server because another client resized never triggers a `terminal.resize`, so two clients of different sizes cannot resize each other forever (last writer wins, M8R59) — cost if wrong: one palette table, or two tabs resizing in a loop.
- **M8R81** [20] `TerminalPane { id }`: opens `getTerminalChannel().open(id, sink)`; from `attached()` until the bytes up to the answer's `end` are written, xterm's own replies (`onData`, `onBinary`) are dropped — replayed device queries must not type answers at the prompt (T3's replay protection; pap does the client half only, `terminal.md`); otherwise input goes out as input frames; resizes go to `terminal.resize`. States: `attaching` and `offline` → "Reconnecting… input paused" (stdin disabled; after 3 s a stage label, never a repainting spinner, DESIGN §7.3); `exited` → "Process exited (code n)" with Close and New terminal here; `gone` → "This terminal ended: pap restarted or it was closed" with New terminal here. Close on a running terminal asks inline ("Close the terminal and stop what runs in it?"). Running terminals appear in ⌘K (`palette-items.ts`: "Terminal · <folder name>") — cost if wrong: none.
- **M8R82** [20] The built terminal chunk is scanned (no `light-dark(`, no nested CSS, no RegExp `v` flag; xterm 6.0.0 feature-detects `requestIdleCallback`; `OffscreenCanvas` exists from Safari 16.4) and the result written in the commit body; the owner checks iOS typing by hand.

**Files:**
- Modify: `packages/ui/package.json` (`@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-fit` 0.11.0; `exports["./terminal"]`), `apps/web/src/build-output.int.test.ts` (marker `xterm-helper-textarea` absent from initial files), `apps/web/src/routes/shell/palette-items.ts`, `apps/web/src/i18n/catalog/terminal.ts`
- Create: `packages/ui/src/terminal.ts`, `packages/ui/src/terminal/{TerminalSurface.tsx,terminal-theme.ts}` and tests; `apps/web/src/features/terminal/{TerminalPane.tsx,use-terminal.ts,terminal.vm.ts}` and tests (`TerminalPane.tsx` replaces the placeholder)

- [ ] **Step 1: Write the failing tests** (xterm is mocked in happy-dom; the logic lives in `use-terminal.ts` and `terminal-theme.ts`)
  - `terminal-theme.test.ts`: given a token reader, the theme maps the 16 colours as listed and reads `--bg`, `--text`, `--you-fill`, `--surface-2`.
  - `use-terminal.test.ts` (fake surface, fake channel): replies typed by the surface before the replay reaches `end` are dropped, after it they go out as input; `offline` disables input and shows the reconnect text; `exited` and `gone` show their texts and actions; resizes within 100 ms send one `terminal.resize`; Close on a running terminal asks before `terminal.close`.
  - `TerminalSurface.test.tsx`: the root has `data-terminal-input`; Ctrl+] moves the focus out; a `data-theme` change re-applies the theme once; the link handler opens `https://x.test` with `noopener,noreferrer` and ignores `javascript:alert(1)`, `file:///etc/passwd` and `data:text/html,x`; no clipboard addon is loaded.
  - `use-terminal.test.ts` (addition): a `terminal` stream event carrying another client's size changes nothing and sends no `terminal.resize`; a resize of the pane's own container sends one.
  - `palette-items.test.ts`: a running terminal appears with its folder name; an exited one does not.
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets: +0 KB initial; record the lazy terminal chunk, expected about 125 KB gzip, and `pnpm why @codemirror/state` showing one version, RT-34) and commit:

```bash
git add packages/ui apps/web/src pnpm-lock.yaml
git commit -m "feat(web): the terminal pane on xterm with WebGL, replay protection and reconnect"
```

---

### Task 21: The composer — `@` mentions, drops, pasted and attached files, the one key path

**Rulings (pre-dispatch):**
- **M8R83** [21] `TextField` (`@pap/ui`) gains optional `inputRef`, `onKeyDown` (runs first; a `defaultPrevented` event skips the submit shortcut), `onPaste`, `onDrop`, `onDragOver` and `combobox: { expanded: boolean; controls: string; activeDescendant: string | null }` (sets `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`; its type is exported as `TextFieldCombobox`). These are the composer field's **only** key path (agreement 7): M7's `/` and `$` menu uses the same props, through the chain of M8R113; whichever plan merges first lands them under these names (M8 does, owner c1) — cost if wrong: a rename at the merge.
- **M8R84** [21] Mentions are plain text (owner c2, M8R89; ADR 0030): `@` at the start or after a blank opens a listbox (`role="listbox"`, which the dispatcher already reads as `overlayOpen`: Escape closes it and never stops the run) fed by `files.search { root: the session's project root, query }` (150 ms debounce on runtime `Timers`; answers to an older query dropped). ArrowUp/Down move, Enter or Tab insert, Escape closes. The text inserted is `@<path relative to the session folder>` (POSIX, `../` when above it), `@"<path>"` when it holds a blank, then one space. Dropping an explorer row (`application/x-pap-path`) inserts the same at the caret — cost if wrong: none.
- **M8R85** [21] Attachments: the composer takes dropped files, the field takes pasted files (screenshots), and an Attach button opens a file input with no `accept` and no `capture` (phones offer the camera; pi-web #1101). Each file uploads at once (`uploadAttachment`), at most 10 per message (the 11th: "At most 10 files per message"); folders are skipped with "Folders are not uploaded"; a `capacity` answer (more than 4 uploads in flight, M8R106) is retried by the tray after the running ones settle, never shown as a failure; `interrupted` shows "The upload stopped before the end…" with Retry. The tray shows a chip per file (a thumbnail from a local object URL for images, never a server fetch; name; size; Remove), a static "Uploading…" label, an error chip with Retry; an image the daemon classed as `file` says "Sent as a file". Send is disabled while an upload runs; `sessions.prompt` carries the ids; success clears the tray (object URLs revoked), a failure keeps it. Attachments are not saved in drafts (a reload drops the tray; their pending copies expire on the daemon). `use-composer.ts` takes an `attachments` option, exposes `canSend` (text or a ready attachment, nothing uploading) and allows an empty text when the tray is not empty — cost if wrong: none.
- **M8R86** [21] *(corrected: RT-12, agreements 7 and 22)* Mounting, within M8's budget of 6 lines in `Composer.tsx`: two hook calls (`const mentions = useMentions(…)`, `const attachments = useAttachments(…)`) and four JSX lines: `<AttachmentTray …/>`, the field's `{...composerFieldProps([mentions], attachments)}`, `<MentionMenu …/>`, `<AttachButton …/>`. The existing `c.text.trim() === ""` conditions of the send buttons become `!c.canSend` (edits of existing lines, not mounts). Every part lives in `features/sessions/composer/`; strings in the lazy `catalog/session-files.ts`, registered by `composer/register-files-catalog.ts` which the composer parts import (no `SessionScreen.tsx` edit, agreement 16). No restructure and no tiptap (owner c2).
- **M8R113** [21] *(new: RT-12, agreement 7)* `composer/menus.ts` is the one key path for every composer menu: `interface ComposerMenu { readonly open: boolean; close(): void; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void; readonly combobox: TextFieldCombobox | null }` and `composerFieldProps(menus: readonly ComposerMenu[], attachments: { onPaste; onDrop; onDragOver }): Pick<TextFieldProps, "inputRef" | "onKeyDown" | "onPaste" | "onDrop" | "onDragOver" | "combobox">`. The field's `onKeyDown` gives the event to the first open menu only (in array order) and to nobody when none is open; the one `combobox` is that menu's; when two menus report `open`, every one after the first is `close()`d (one menu at a time: `/skill:x @sr` shows the mention menu only while the caret is in `@sr`). `useMentions` returns `{ open, close, onKeyDown, combobox, menu }` — the same shape as M7's `useComposerCommands({ text, setText, fieldRef }) → { onKeyDown, combobox, open, close, menu }`, which M7 adds to the array (`[mentions, commands]`) in its ≤ 3 lines; `inputRef` comes from `composerFieldProps` and is the `fieldRef` both hooks read the caret from — cost if wrong: Enter taken twice, or two menus open.
- **M8R114** [21] *(new: RT-24)* An unknown outcome keeps its attachments: `stores/drafts.ts` `PendingSend.params` gains `attachments?: string[]` (each re-validated as an `AttachmentId` when read back from storage; a wrong shape drops the entry as today). "Send again" resends the same `commandId` with the same ids; a `not_found` answer (the pending uploads expired, or a daemon restart emptied `pending/`) says "The attached files expired. Attach them again." and puts the text back in the composer — cost if wrong: a resend that silently loses its images.

**Files:**
- Modify: `packages/ui/src/primitives/TextField.tsx` (+ test); `apps/web/src/features/sessions/{Composer.tsx,use-composer.ts}` (+ tests); `apps/web/src/stores/drafts.ts` (+ test)
- Create: `apps/web/src/features/sessions/composer/{MentionMenu,AttachmentTray,AttachButton}.tsx`, `{mention.vm,use-mentions,use-attachments,drop,menus,register-files-catalog}.ts` and tests; `apps/web/src/i18n/catalog/session-files.ts`

- [ ] **Step 1: Write the failing tests**
  - `TextField.test.tsx`: `onKeyDown` with `preventDefault` on Mod+Enter skips `onSubmitShortcut`; `combobox` sets the four ARIA attributes; `inputRef` receives the textarea.
  - `menus.test.ts`: with two fake menus, the first open → only its `onKeyDown` runs and its `combobox` is returned; none open → no menu handler runs and `combobox` is null; both open → the second's `close` is called once and the first keeps the keys; the attachments' `onPaste` / `onDrop` / `onDragOver` pass through unchanged.
  - `mention.vm.test.ts`: `mentionAt("see @sr", 7)` → `{ start: 4, query: "sr" }`; `mentionAt("a@b", 3)` → null; a blank ends the query; `insertMention` replaces the query, adds a space and puts the caret after it; `src/a b.ts` → `@"src/a b.ts" `; a root-relative `lib/x.ts` from folder `<root>/app` → `@../lib/x.ts`.
  - `use-mentions.test.ts` (fake timers, fake RPC): one `files.search` 150 ms after typing stops; an older answer arriving last is dropped; Escape closes and the dispatcher's `readContext` reports `overlayOpen` while open; Enter inserts the active result; the returned object has `open`, `close`, `onKeyDown`, `combobox` and `menu`.
  - `use-attachments.test.ts`: a dropped PNG and PDF upload once each; the 11th file is refused with the note; a folder entry (`webkitGetAsEntry().isDirectory`) is skipped with the note; a pasted image uploads; a failed upload shows Retry; a `capacity` answer is retried after another upload settles and never shows an error chip; `interrupted` shows its text and Retry; `ids()` lists the ready ones in order.
  - `drafts.test.ts` (addition): a pending send with two attachment ids round-trips; one id of 21 characters drops the whole entry.
  - `Composer.test.tsx` (additions): Send is disabled while uploading; a send carries `attachments`; an empty text with one attachment sends; success clears the tray and revokes the URL; failure keeps it; `prompt_rejected` for a send with an image shows the M8R109 note; "Send again" after an unknown outcome carries the same ids, and its `not_found` shows "The attached files expired. Attach them again."; dropping `application/x-pap-path` inserts the mention. (The reviewer checks that `Composer.tsx` gained at most 6 lines.)
- [ ] **Step 2: Run them, see them fail; implement; see them pass.**
- [ ] **Step 3: Gate** (unit, build, budgets: +0.2 KB initial for the `TextField` props and `drafts.ts`) and commit:

```bash
git add packages/ui apps/web/src
git commit -m "feat(web): @ mentions, dropped, pasted and attached files in the composer, one key path for its menus"
```

---

### Task 22: Docs, ADRs 0030–0032, the bundle, the final gates

**Rulings (pre-dispatch):**
- **M8R87** [22] *(corrected: owner c2, the fix's rulings)* ADRs: `0030-composer-text-mentions.md` (written: no tiptap in this wave, owner c2; `@` mentions as plain text, M7's `$skill` as Pi's `/skill:name`, chips revisited at M11; spec C §7.2), `0031-file-routes-and-attachments.md` (`GET` / `PUT /files/raw?path=` instead of `GET /files/*`, cookie-only HTTP, one-file uploads with in-flight reservations, attachments claimed per session, images read and size-checked by the worker from pending uploads, files announced as paths; spec C §4.5), `0032-vcs-stream-by-root.md` (keyed by repository root, a 15 s poll while watched with backoff after timeouts, the repository's untracked setting; spec C §4.3 `vcs{cwd}`). Topic notes: new `docs/agents/files.md` (the boundary table of this plan with the owner, confirm, step-up and token columns; Pi's configuration left to Settings; the home-folder rule; the deny set, its sources, its ctime refresh and fail-closed cap; the lists copied in contracts and the one-direction test; git's flags, the ceiling and residuals: filter drivers, non-Linux descriptor checks, the folder-swap window between check and rename, the `lstat`-then-`rename` window without hard links, a case-folded spelling of a session file created since the last walk; attachments and their budget; the 5-minute upload deadline; limits; CPU of the poll), new `docs/agents/terminal.md` (wire, flow control and stale streams, the hidden-tab detach, lifetime, replay protection (client half), PTY environment and the platform secrets, the shell's descriptors, scope and the session-wide kill ladder; residuals: two attached clients both answer a live query, jobs that leave the session (`setsid`) survive without a scope; terminals share the workers' `MemoryMax` and `TasksMax` (RT-38); the terminal is the owner's shell, not a sandbox, and taint does not apply to it); lines in `daemon.md` (compose-workspace, the stop order of agreement 9, `attachments_size`, `terminal_unavailable`, `requestTimeout`, `userHome`), `web.md` (panes, `@pap/ui/code`, `@pap/ui/terminal`, the drag type, the composer key path and its menus, the bundle after M8), `sessions.md` (prompt attachments, the worker's prompt queue, `pap:aborted`, `pap:image_unreadable`), `policy.md` (the lists' copy), `auth.md` (tokens never write protected names nor confirm, M8R2), `AGENTS.md` (topic list gains `files`, `terminal`; worker settings gain `PAP_MAX_TERMINALS`, beside M7's `PAP_HELPERS_MAX`, agreement 10; one line: "node-pty builds at install: gcc, make, python3"; ≤ 150 lines); `docs/research/m8-rulings.md` from this plan's rulings (M8R1–M8R120) and the execution ledger.

**Files:** the ones listed in M8R87; `budgets.json` untouched (flat 300 KB, decision 75); `docs/research/decisions-log.md` untouched (M7's plan fix records both milestones' owner answers as decision 76).

- [ ] **Step 1: Write the docs and ADRs** from the code as merged on the branch (never from this plan's intent when they differ: the code wins, the difference goes in the rulings file).
- [ ] **Step 2: Final gates** — `pnpm install --frozen-lockfile --offline && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && env -i HOME="$HOME" PATH="$PATH" CI=1 pnpm test:int && pnpm build && pnpm smoke && pnpm budgets` → all green; the initial bundle figure goes in the commit body (stop and ask the owner above 250 KB).
- [ ] **Step 3: Commit**

```bash
git add docs AGENTS.md
git commit -m "docs: files, terminal, daemon, web and sessions notes for M8; ADRs 0030-0032"
```

---

## Bundle estimate

Initial bundle after M5: 195.3 KB gzip; ceiling 300 KB (decision 75); stop and ask above 250 KB.

| Task | Initial delta (KB gzip) | Why | Lazy chunks |
|---|---|---|---|
| 1 | +0.2 | two error strings, domain labels, two token warnings | — |
| 5, 6a, 7, 8 | +1.3 | `files.*` and `sessions.prompt` schemas (the method catalogue is eager) | — |
| 9, 12 | +1.4 | `vcs.*`, `terminal.*` schemas (`requestId`), stream events | — |
| 14 | +0.6 | binary routing in `connection.ts`, the terminal store read by the surface bar | terminal channel + codec + visibility detach ≈ 2.5 KB |
| 15 | +0.8 | item kinds, root encoding, surface bar, phone switch, six labels | three pane chunks |
| 16 | 0 | | `code` ≈ 110–150 KB; each language 5–25 KB |
| 17–19 | 0 | | files ≈ 8–12 KB (with the step-up entry), changes ≈ 5–8 KB |
| 20 | 0 | | terminal ≈ 125 KB (xterm 88, WebGL 36, fit 1) + pane ≈ 5 KB |
| 21 | +0.2 | `TextField` props, `drafts.ts` attachment ids | composer parts and the menu chain in the session chunk ≈ 4.5 KB |
| **Total** | **≈ +4.5 (range 3–6) → ≈ 200 KB** | | |

With M7 (agreement 19: M7 ≈ +4 KB) the merged initial bundle is ≈ 204 KB, well under the 250 KB question threshold. The controller re-measures after each merge (agreement 1).

## Exit criteria (roadmap M8)

All testable on this headless host, without a browser:

1. **Gates:** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && env -i HOME="$HOME" PATH="$PATH" CI=1 pnpm test:int && pnpm build && pnpm smoke && pnpm budgets` green (Task 22); every web and contracts commit records its bundle figure.
2. **"`/files` traversal tests pass"** (spec C §8.1): `apps/daemon/src/security/files-traversal.int.test.ts` (every hostile form × every route that takes a path, hard links and `/proc/self` links included), `files-protected.int.test.ts` (confirm, step-up, Pi's configuration, the home folder), `files-origin.int.test.ts` (Origin, tokens: agreement 5), backed by `kernel/fs/boundary.hostile.test.ts`, `boundary.gate.test.ts`, `deny-set.test.ts` and `safe-open.test.ts` (Tasks 3a, 3b, 13).
3. **"A terminal survives a browser reconnect within one daemon lifetime":** `apps/daemon/src/modules/terminal/terminal.reconnect.int.test.ts` (same terminal after a new socket, the first frame at the old offset, no gap, no reset, no duplicate, input works; output produced while no client was attached arrives once through the replay, proven without timing by a FIFO), with `terminal.multi.int.test.ts` (multi-client attach, scrollback, acks, a client that stops acking never stalls the shell), `daemon.terminal-stop.int.test.ts` (the shells, their jobs and their foreground commands all gone) and the smoke step on the built daemon (Tasks 10b, 11, 12).
4. **Roadmap domains:** D04 — explorer and viewer (5, 17), uploads (6b, 7), drops (21), `@` mentions (5, 21), allowlist boundary (3a, 3b, 13), per-session attachment claims (7, 8); D05 — `vcs` status stream (9, 19), diffs (9, 16, 19); D06 — node-pty in the native-build allowlist (10a), xterm + WebGL (20), binary frames with acks (2, 11, 14), server scrollback (11), multi-client attach (11, 12); file editing with CodeMirror 6 (16, 18); the Chat / Review / Term switch (15).
5. **The owner's checks on the preview** (decision 42: browser e2e is M13), below.

## Owner checks on the preview (real browsers, after the merge)

- **Files:** open Files from a session (desktop split); expand folders; "Show ignored"; a symlink leading out shows a lock; a TypeScript file is highlighted; Markdown Preview / Source; an image; Load more on a large log; download a PDF.
- **Editor:** change and save a file; let the agent edit the same file, then save: the conflict banner; save `.vscode/settings.json`: the "Save anyway?" ask; save a file under the project's `.pi/`: the ask, then the password; `~/.pi/agent/models.json` shows a lock (Settings edits it).
- **Changes:** the list updates after an agent run; diffs read well in Night, Day and High contrast.
- **Terminal:** open it from a session; `ls --color`, `git diff`, `vim`, `htop`; resize the window; reload the page (reattach, nothing typed at the prompt); start `pnpm build` (or `yes | head -c 50000000 | wc -c`), switch to another browser tab for a minute and come back: it finished meanwhile (owner f2); suspend the laptop ten minutes and come back; close a terminal running `sleep 1000 &`: `ps` over SSH shows no `sleep` left; open the same terminal in a second browser; Escape stays in the terminal, Ctrl+] leaves it; Safari / iOS typing with the on-screen keyboard; no glitch with WebGL (or its fallback); the colours of `ls` (blue and cyan both use the agent colour, DESIGN §9.2).
- **Composer:** the `@` menu; drag a file from the explorer; drop an image (the model sees it); drop a PDF (its path line); paste a screenshot; send an image then at once a text: the agent gets them in that order; Attach on the phone offers the camera; a 25 MB file through ngrok on the phone (it either finishes or says it stopped, never hangs).
- **Phone:** the Chat / Review / Term switch; ⌘K lists running terminals.

## Coverage map (roadmap, carries, spec → tasks)

| Requirement | Task |
|---|---|
| D04 explorer (git-ignore aware), viewer tabs, download | 5, 17 |
| D04 uploads (explorer), drops, pasted files, Attach button | 6b, 7, 21 |
| D04 `@` mentions, tree → composer drag | 5, 17, 21 |
| D04 allowlist boundary (C §8.1 traversal; M5 lists; hard links and swaps; tokens) | 1, 3a, 3b, 13 |
| D04 per-session attachment claims | 7, 8 |
| D05 `vcs{cwd}` status stream (keyed by root, ADR 0032) | 4, 9, 14, 19 |
| D05 diffs (S5 CodeMirror merge, M9-ready sides) | 9, 16, 19 |
| D06 node-pty in the native-build allowlist | 10a |
| D06 xterm + WebGL | 20 |
| D06 binary frames with acks (C §4.2) | 2, 11, 14 |
| D06 server scrollback, multi-client attach | 11, 12 |
| D06 terminal survives a browser reconnect (and a hidden tab) | 11, 12, 14, 20 |
| File editing with CodeMirror 6 (A §5.2) | 16, 18 |
| M3R102 Chat / Review / Term switch | 15, 19, 20 |
| Brief: M5 protected paths and pap-home rules on every file route | 1, 3a, 3b, 6a, 6b, 13 |
| Agreements 5 and 6 (tokens, Pi's configuration), owner c3, f8, f10 | 3a, 6a, 13 |
| C §2.5 environment minus `PAP_*` and platform secrets; shell descriptors | 10b, 13 |
| Brief: node-pty, `minimumReleaseAge` kept | 10a, 16, 20 (versions in the Tech Stack table) |
| R78 reserved prefixes | 6a, 13 |
| Spec deviations (ADRs 0030–0032) | 22 |
| Lazy editor, terminal, diff (C §7.4), bundle | 15, 16, 20, 22 |

## Open questions for the owner — all answered (2026-10-13)

The owner answered every question on the M7 + M8 page with the recommendation; nothing is open. The rulings are M8R88–M8R100 (§ Owner decisions).

| # | Question | Answer | Ruling |
|---|---|---|---|
| Q1 (f1) | Who may open a terminal? | Browser sessions only; tokens never hold `terminal:*`; no extra password | M8R91 (M8R2) |
| Q2 (f2) | How long does a terminal live? | Until closed, its shell exits or pap stops; at most 8 running, the 9th refused, 8 exited kept; a hidden tab never pauses it (RT-06); terminals share the workers' memory and task limits (RT-38) | M8R92 (M8R57, M8R111) |
| Q3 + M7 Q3 (c3) | Saving files that run code later | Pi's configuration: password step-up, edited only in Settings, keys masked; other protected files: "Save anyway?"; tokens never confirm | M8R90 (M8R16, M8R101) |
| Q4 (f3) | Non-image files dropped on the chat | `~/.pap/attachments/<session>/`, path cited in the message | M8R93 |
| Q5 (f4) | Previews | Text and code, Markdown, images; the rest downloads | M8R94 |
| Q6 (f5) | Folders that link outside the project | Listed with a lock, not browsable | M8R95 |
| Q7 (f6) | Terminal and save traces | Daemon log only | M8R96 |
| Q8 (f7) | pi-web extras | Defer clickable paths, outside reads, new / rename / delete; drop "open in the OS file manager" | M8R97 |
| Q9 + M7 Q11 (c2) | `@` mentions: text or chips (tiptap)? | Not now: `@path` stays text, `$skill` is Pi's `/skill:name`; revisit at M11 | M8R89 (ADR 0030) |
| red-team Q10 (f8) | Home or `/` as a project | Dot-files and dot-folders directly in the home are protected (confirm on save, tokens refused); the rest is ordinary | M8R98 (M8R16, M8R102) |
| red-team Q11 (f9) | Do attachments taint the session? | No | M8R99 |
| red-team Q12 (f10) | Pi key files in the explorer | Hidden for Pi's own folder (Settings shows them masked); a project's `.pi/mcp.json` visible to the owner, never to tokens | M8R100 (M8R102) |
| (c1) | Merge order | M8 first, M7 rebases (unless M7 passes its final review more than one working day before M8) | M8R88 |

## Merge order and conflict notes (with M7)

**Order (decided, owner c1, agreement 1):** **M8 first**, unless M7 passes its Opus final review more than one working day before M8. The second branch rebases once and resolves the shared files below. The controller re-measures the bundle and re-runs every gate (with `env -i … CI=1 pnpm test:int` and `pnpm smoke`) after each merge. Why M8 first: M8 opens the critical path (M8 → M9 → M11 → M12 → M13); M8 adds **no migration**, so nothing is re-stamped either way; M7's composer and token-grid changes sit on top of M8's mounts and domains.

**The cross-plan agreements (`.superpowers/m7-m8-cross-plan-agreements.md`, binding for both executions; their substance, as they bind M8):**

1. **Merge order:** above (c1).
2. **Migrations:** M8 has none. M7 has `202610131000_pattern_rules.sql` and `202610131010_tool_preset.sql` in existing sources. Whichever merges first, nothing is re-stamped.
3. **Error codes:** M8 adds `protected_path` and `terminal_unavailable`; M7 adds `helper_failed`, `project_scope`, `config_invalid` and `config_path_refused`. No duplicate. Order in `ERROR_CODES`: M8's two after `read_only`, then M7's four, all before `unknown_method`. Both `errors.test.ts` versions assert membership and messages, never adjacency (M8R3). Eager web messages go in `catalog/shell.ts` for both.
4. **Domains and tokens:** `DOMAINS = [… "audit", "files", "vcs", "terminal", "pi"]`. `TOKEN_PERMISSIONS` is one filter that excludes `auth:*`, `policy:admin`, `pi:admin` and `terminal:*` (M8 adds the `terminal:*` term on its own line). M7R124's "only permissions some method declares" grid filter covers M8's unused levels (RT-35, M8R6).
5. **Tokens never make a standing or code-running change:** no `confirmProtected` (RT-03), no write under `<agentDir>` or a project `.pi/` (RT-04), no `pi:admin`, no `terminal:*`. Each refusal answers `forbidden` and is pinned in each plan's origin or token int test (M8: `security/files-origin.int.test.ts`, M8R2, M8R101). Confirmed by the owner (c3).
6. **Pi configuration has one writer:** M7 is the only reader and writer of `<agentDir>/{auth,models,mcp,trust,settings}.json`, through its helper with masking and step-up. M8's boundary classes them as `pi_private` for every intent (M8R16). Other writes under `<agentDir>` and project `.pi/` from the explorer need the step-up and are refused to tokens. Confirmed by c3; f10 confirms the `pi_private` class, and a project's `.pi/mcp.json` is visible to the owner and refused to tokens (M8R100, M8R102).
7. **Composer:** neither plan restructures it; no tiptap in this wave (owner c2, the single tiptap question closed). M8 owns `use-composer.ts`, `sessions.prompt` params and `TextField`'s passthrough props (M8R83: `inputRef`, `onKeyDown`, `onPaste`, `onDrop`, `onDragOver`, `combobox`). M7's `/` and `$` menu is `useComposerCommands({ text, setText, fieldRef })` → `{ onKeyDown, combobox, open, close, menu }`. `Composer.tsx` chains the open menu's handler first, sets one `combobox`, and keeps one menu open at a time: M8's `composer/menus.ts` (`ComposerMenu`, `composerFieldProps`, M8R113) does it, and M7 adds its hook to the array. Mount budget: M7 at most 3 lines, M8 at most 6. Whichever merges first lands the `TextField` props with M8R83's names (M8, c1).
8. **The worker prompt path:** `sessions.prompt` params and `PromptCommand.images` are M8's. `contracts/pi-host.ts`: union (M7 adds approval scopes, loadout, model commands, `set_tools`, `get_commands`). `packages/pi-host/src/dispatch.ts`: union by hunk (M7 adds its cases; M8 adds `papHome` to `DispatchDeps`, the prompt queue and the `abort` line, M8R107). `commands.ts` (`handlePrompt`, `queuePrompt`) is M8's only; `host.ts`: M8's one line, union. The second merger reruns `host.images.int.test.ts` and M7's `host.models.int.test.ts` / `host.presets.int.test.ts`.
9. **`daemon.ts` and the stop order:** each plan adds at most 10 lines; M7 uses a compose helper if it needs more. `stop()` runs `helpers.stopAll()` (M7) in parallel with `sessions.shutdownAll()`, then `workspace.shutdown()` (M8 PTYs), then `killAllWorkerGroups()`, then the closers (M8R66). `killScopes()` covers terminal scopes (same home slice).
10. **`kernel/config.ts`:** `PAP_HELPERS_MAX` (M7) and `PAP_MAX_TERMINALS` plus `userHome` (M8): union. AGENTS.md's worker settings line names both variables and the file stays ≤ 150 lines.
11. **Streams:** `STREAMS` gains `vcs`, `terminal` (M8) and `login` (M7); `CAPABILITIES` gains `terminal`; `PROTOCOL_VERSION` stays 2. `runtime/subscriptions.ts` `OPENERS` is exhaustive and both sides add theirs. `subscriptions.test.ts` is at 344 lines, so new opener tests go in `subscriptions.m7.test.ts` / `subscriptions.m8.test.ts`.
12. **`HandlerContext.binary` is optional** (M8R4). M7's handler tests build contexts unchanged. `kernel/ws/*` is M8's; M7 edits no ws file.
13. **The sessions module:** `live-session.ts` (387 lines) takes M7 ≤ 6 and M8 ≤ 3 lines, ≤ 396 after both; no other task of this wave adds lines there. M7's `service-models.ts` and `loadout-view.ts` and M8's attachment port are separate files. `service-types.ts`: union.
14. **`kernel/supervisor/`:** M8 edits `scope.ts` (`next({ kind })`) and `env.ts` (RT-27's systemd variables in `isDaemonOnly`, shared by workers, helpers and PTYs, M8R53). M7's helper imports `env`, `process-group`, `kill-ladder` and `worker-io` read-only and inherits the rule.
15. **The policy folder:** M8 adds only `packages/pi-host/src/policy/protected-lists.test.ts` and edits nothing in `policy/**`. M7 keeps the semantics of `target-path.ts` and `read-target.ts`, and M8's test catches any drift in the protected lists.
16. **Web shell:** `features/workspace/model.ts`: M8's item kinds and M7's `SETTINGS_SECTIONS`, union. `SessionScreen.tsx`: M7's two lines only (RT-36: M8 never edits it). `routes/shell/*`: M8's only. `stores/session-reducer.ts`: M7's `loadout`; M8 adds nothing there (M8 edits `stores/drafts.ts` only, M8R114).
17. **i18n:** eager: M8's 6 labels and 2 error messages in `catalog/shell.ts`, M7's 4 error messages. Lazy: M8 `files`, `changes`, `terminal`, `session-files`; M7 `session-models`, `settings-models`, `settings-mcp`, `settings-skills`, `trust`, `first-run`. Key prefixes are disjoint. `settings-access.ts` takes M8's domain labels and M7 Task 28's grid copy: union. The disjointness and every-code-has-a-message tests stay green on both branches.
18. **Dependencies:** M8 adds node-pty (`onlyBuiltDependencies: [node-pty]`), xterm and CodeMirror; M7 adds none. The second merger regenerates `pnpm-lock.yaml` with `pnpm install` and checks for a single copy of `@codemirror/state` (RT-34).
19. **Bundle:** M8 ≈ +4.5 KB and M7 ≈ +4 KB, so the merged initial bundle is ≈ 204 KB. The second merger records the figure; above 250 KB the owner is asked.
20. **ADRs and decisions:** M7 uses 0023–0029, M8 0030–0032. Only M7's plan fix appends to `decisions-log.md` (decision 76), for both milestones' owner answers; M8 never edits it.
21. **Editors:** M7's `models.json` editor stays a plain field in this wave; switching it to M8's lazy `@pap/ui/code` is a later task. M8 never edits Pi configuration (agreement 6).
22. **Composer mounts:** M7 adds `<ModelBar/>` and `<ComposerCommands/>` (through `useComposerCommands`, item 7). M8 adds `<AttachmentTray/>`, the field's props line (`{...composerFieldProps([mentions], attachments)}`, the form item 7's chain takes; agreement 22's `{...mentions.fieldProps}`), `<MentionMenu/>` and `<AttachButton/>`. The second merger keeps both sets. M7 Task 27 depends on the shared `TextField` props of item 7; M8 merges first and lands them under M8R83's names.
23. **Error codes, final lists:** M8's final new codes are exactly `protected_path` and `terminal_unavailable` (Global Constraints). The red-teams also read `attachments_size` and `too_large` as M8 codes: `attachments_size` is a log event and `too_large` a `GitError` kind, a `BoundaryError` reason and a `VcsStatus.error` value, none of them an `ERROR_CODES` entry. M7's are `helper_failed`, `project_scope`, `config_invalid` and `config_path_refused`: the sets are disjoint, and each code has messages in `catalog/shell.ts`.
24. **`daemon.ts` line budget (M7-RT-07):** the file stays at 400 lines or fewer after both merges. M7 moves its wiring into a compose helper like M8's `compose-workspace.ts` if its ≤ 10 lines do not fit.

**Shared files (both conflict tables; edits additive, each side its own lines):**

| File | M8's edit | Rule |
|---|---|---|
| `packages/contracts/src/methods.ts` | imports and spreads `filesMethods`, `vcsMethods`, `terminalMethods`; `sessions.prompt` gains `attachments` and the empty-text refine | union, one import and one spread per domain; the prompt params are M8's lines |
| `packages/contracts/src/methods.test.ts` | the sorted mutation list gains `files.write` (every terminal method is idempotent, M8R64) | union, kept sorted |
| `packages/contracts/src/permissions.ts` | `DOMAINS` gains `files`, `vcs`, `terminal` after `audit` | union (agreement 4), the first merged first |
| `packages/contracts/src/errors.ts` (+ test) | `protected_path`, `terminal_unavailable` after `read_only` | union, M7's four after them, all before `unknown_method` (agreement 3); each side's messages unchanged; the eager `catalog/shell.ts` gets each side's lines |
| `packages/contracts/src/streams.ts` | `STREAMS` gains `vcs`, `terminal` | union (agreement 11); `runtime/subscriptions.ts`' `OPENERS` is exhaustive: each side adds its openers, tests in its own `subscriptions.m<n>.test.ts` |
| `packages/contracts/src/frames.ts` | `CAPABILITIES` gains `terminal` | union; neither bumps `PROTOCOL_VERSION` |
| `packages/contracts/src/handlers.ts` | optional `HandlerContext.binary` and three types | M8 only (agreement 12) |
| `packages/contracts/src/auth.ts` | `TOKEN_PERMISSIONS` drops `terminal:*` | one filter, each side its term (agreement 4) |
| `packages/contracts/src/{index,pi-host}.ts` | exports; `PromptCommand.images` | union (agreement 8) |
| `packages/pi-host/src/commands.ts` | `handlePrompt` takes images, `queuePrompt` | M8 only (agreement 8) |
| `packages/pi-host/src/dispatch.ts` | `DispatchDeps.papHome`, the prompt queue, the `abort` line | union by hunk with M7's cases (agreement 8) |
| `packages/pi-host/src/host.ts` | one line: `papHome` into `createDispatch` | union |
| `packages/pi-host/src/policy/**` | none (one new test file) | M7 owns the folder (agreement 15) |
| `apps/daemon/src/daemon.ts` | ≤ 10 lines (workspace, rpc spread, mount, the node-pty probe, stop, `attachments` to sessions, `readOnly` to the workspace) | union; ≤ 400 lines after both (agreements 9, 24); no `MIGRATION_SOURCES` change |
| `apps/daemon/src/kernel/config.ts` (+ test) | `PAP_MAX_TERMINALS`, `userHome` | union (agreement 10) |
| `apps/daemon/src/kernel/supervisor/{env,scope}.ts` | the platform keys in `isDaemonOnly`; `next({ kind })` | M8's edits; M7 imports read-only (agreement 14) |
| `apps/daemon/src/kernel/http/server.ts` | an explicit `requestTimeout` | M8 only |
| `apps/daemon/src/testing/harness.ts` | `userHome` in the config | union if M7 edits it |
| `apps/daemon/src/modules/sessions/*` (prompt path) | attachments; `live-session.ts` ≤ 3 lines | union by hunk (agreement 13); `live-session.ts` ≤ 396 after both |
| `apps/daemon/src/modules/sessions/export-http.ts` | `contentDispositionOf` becomes a one-line wrapper | M8 only |
| `apps/web/src/features/sessions/{Composer.tsx,use-composer.ts}` | two hooks and four JSX lines; `canSend`; the `attachments` option | the hot spot, below (agreements 7, 22) |
| `packages/ui/src/primitives/TextField.tsx` | M8R83 props | M8 lands them (c1); M7 uses the same names |
| `apps/web/src/stores/drafts.ts` | `PendingSend.params.attachments` | M8 only |
| `apps/web/src/features/workspace/{model,item-path}.ts` | three item kinds | union with M7's `SETTINGS_SECTIONS` (agreement 16) |
| `apps/web/src/features/commands/defaults.ts` | three command specs | union |
| `apps/web/src/routes/shell/*` | surfaces, panes, palette terminals, the files pane entry | M8 only (agreement 16) |
| `apps/web/src/i18n/catalog/{shell,settings-access}.ts`, `en.ts`, `fr.ts` | six eager labels, two error messages, token-grid domain labels and warnings; M8's lazy catalogs are new files | union (agreement 17) |
| `apps/web/src/build-output.int.test.ts` | lazy markers | union |
| `packages/ui/package.json`, `apps/daemon/package.json`, `pnpm-workspace.yaml` | CodeMirror, xterm, two subpaths; node-pty; `onlyBuiltDependencies: [node-pty]` | union of lists (agreement 18) |
| `pnpm-lock.yaml` | regenerated | never hand-merged: `pnpm install` after the rebase |
| `AGENTS.md`, `docs/agents/{daemon,web,sessions,policy,auth}.md` | own lines; new `files.md`, `terminal.md` | union; AGENTS.md ≤ 150 lines after both |
| `eslint.config.js`, `knip.json`, root `package.json`, `DESIGN.md`, `budgets.json` | none expected (`pnpm.overrides` only if RT-34 finds two `@codemirror/state`) | union if any |
| ADRs | 0030–0032 | M7 uses 0023–0029 (agreement 20) |
| `docs/research/decisions-log.md` | never | M7's plan fix records both milestones' owner decisions (decision 76) |

**The composer (hot spot):**
- Neither plan restructures the composer, and there is no tiptap in this wave (owner c2). M8's parts live in `features/sessions/composer/` and mount with two hook calls and four JSX lines in `Composer.tsx`; `use-composer.ts` gains an `attachments` option, `canSend` and the empty-text rule.
- The field has one key path: `composerFieldProps(menus, attachments)` (M8R113). M7's `useComposerCommands` returns the `ComposerMenu` shape and joins the array; the open menu handles keys first, one `combobox`, one menu open at a time. M7's mounts (`<ModelBar/>`, `<ComposerCommands/>`) are its own lines (agreement 22).

**Rebase steps if M8 merges second (only if M7 passes its final review more than one working day earlier, ≈ 1–1.5 h):** `git rebase main` once; resolve the shared files by the table; no migration to re-stamp; the composer per agreements 7 and 22 (M7 will then have landed the `TextField` props under M8R83's names); keep the `terminal:*` term beside M7's in the token filter (run `auth.test.ts`, `tokens.vm.test.ts`); `pnpm install` and `pnpm why @codemirror/state`; every gate including `env -i … CI=1 pnpm test:int`, `pnpm smoke` and `pnpm budgets` (record the merged bundle; above 250 KB the owner decides); rerun `host.images.int.test.ts` and M7's `host.models.int.test.ts` / `host.presets.int.test.ts`. If M8 merges first (the decided order), M7 does the mirror on its side.

**For M9 (handoff, not M8's work):** the vcs and diff interfaces are ready: `vcs.fileDiff` takes `DiffSide` with a `commit` oid; M9 resolves branches, merge bases and checkpoint refs to oids daemon-side; `DiffView` lives in `@pap/ui/code` (read-only; M9 adds the comment gutter, deleted-line listener and block widgets of S5's `codemirror-review.ts`); worktrees under `$PAP_HOME/worktrees` need `BoundaryConfig.papHomeOpen = ["worktrees"]` (one line), M5's R97 narrowing on the policy side, and the deny set's `$PAP_HOME` folders left as they are (worktrees are not in its sources).
