# Spec C: architecture

Status: draft for review · Date: 2026-10-10 · Approach A (decision 15) · Illustrated version: [docs/architecture/](../architecture/) (pages 01–09, validated one by one).

Each section ends with its sources in T3 Code (`T3:`), Orca (`Orca:`) or pi-web (`pw:`). Detailed paths are in [feature-matrix.md](../research/feature-matrix.md), [t3code.md](../research/t3code.md) and [orca.md](../research/orca.md).

## 1. Overview

### 1.1 Processes

```
Browser / PWA ──HTTPS + WS /ws──▶ pap serve (Node 24, one process)
                                   ├─ transport: Hono (HTTP) + ws (/ws)
                                   ├─ modules/<domain> × 20
                                   ├─ kernel: db, outbox, scheduler, supervisor, exec, pty, log/trace, config, clock
                                   ├─ child: pi-host × N   (one per active session, Node IPC)
                                   ├─ child: PTY × N       (node-pty)
                                   └─ child: git / gh      (execFile, no shell)
```

### 1.2 Data on disk

- `~/.pi/agent`: owned by Pi and read in place. It holds sessions, `models.json`, `auth.json`, `settings.json`, extensions, skills and mem0.
- `~/.pap` (`$PAP_HOME`): owned by pap. It holds `state.db`, `secrets/`, `agents/`, `attachments/`, `worktrees/`, `logs/` and `backups/`.

### 1.3 Repository

```
apps/daemon/src/{kernel,modules/<domain>/{index,service,store,rpc}.ts,main.ts}
apps/web/src/{runtime,stores,routes,features/<domain>,i18n,sw.ts}
packages/{contracts,pi-host,ui}
docs/{specs,architecture,design,adr,agents,research}
```

### 1.4 Anti-sprawl rules (CI-enforced, §8)

1. One module per domain area: the 20 daemon modules of §1.1 cover D01–D21 (extension UI lives in `sessions`, mobile/PWA is web-only). A module imports only `contracts`, `kernel` and other modules' `index.ts`.
2. 400 lines per file at most. No baseline, no exceptions.
3. An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else.
4. Every RPC method declares a permission in `contracts`. A missing permission is a type error.
5. The web `features/<domain>` folders mirror the daemon modules. Primitives in `packages/ui` own their look: no raw colours, no arbitrary values.
6. No fourth package until a real need appears. Modules are folders, not npm packages.

### 1.5 The `pap` binary

One binary for everything: `serve [--dev] [--host] [--port] [--tls-cert --tls-key]`, `service install|uninstall`, `doctor`, `backup` / `restore`, `update` / `rollback`, `trace summary`, `user add`, `passkey reset`, `audit prune`.

## 2. Session lifecycle and the pi-host protocol

### 2.1 Worker states

A session can be `cold`, `starting`, `idle`, `running` or `releasing`. Transitions:

- `cold → starting → idle`: the worker opens the session file and sends `ready`.
- `idle ⇄ running`: a run starts with `agent_start` and ends with `agent_settled`, confirmed by a `get_state` probe.
- `idle → releasing → cold`: after 30 minutes idle, with no pending dialog, an empty queue and no background work.

Crash handling:

- From any state, a crash sends the session back to `cold`. The run becomes `interrupted` with a classified cause (OOM, signal, exit code, spawn failure) and pending dialogs are cancelled.
- A crashed worker is **never restarted automatically**. The next command restarts it lazily on the same Pi session file.

Pi's JSONL is the transcript. The worker is disposable; the session is not.

### 2.2 Transport

- `child_process.fork(pi-host)` opens a Node IPC channel, which handles message framing natively.
- Stdout and stderr are logs only. pap keeps an 8 KiB tail and never logs them in full, because they can carry secrets.
- A transport adapter interface allows a session to fall back to a real `pi --mode rpc` child over stdio JSONL later.

### 2.3 Records

| Direction | Origin | Records |
|---|---|---|
| daemon → worker | Pi RPC shapes | `prompt{message,images,streamingBehavior}` `abort` `compact` `get_state` `get_entries{since}` `get_tree` `fork` `clone` `set_model` `set_thinking_level` `set_session_name` `export_html` `get_session_stats` `get_commands` `get_available_models` `extension_ui_response` |
| daemon → worker | pap | `init{…}` (first record: session file, policy, env; ADR 0001) `navigate_tree{targetId}` `custom_input{id,data}` `platform_result{id,ok,result\|error}` `policy_update{rules}` `shutdown{graceMs}` |
| worker → daemon | Pi RPC shapes | `response{id}`; events `agent_start` `message_*` `tool_execution_*` `turn_end` `agent_end` `agent_settled` `compaction_*` `auto_retry_*`; `extension_ui_request` (dialogs and decorations) `extension_error` |
| worker → daemon | pap | `ready{sessionFile,piVersion}` `custom_render{id,lines}` `custom_close{id}` `extension_ui_closed{id}` (ADR 0001) `platform_call{id,op,args}` `audit{entry}` `health{rssMb}` |

### 2.4 Run rules

- **End of a run.** `agent_settled` is the only end signal. It is confirmed by `get_state` (not streaming, not compacting, queue empty), with 3 tries 100 ms apart, and new input cancels the probe. If the probe never sees Pi idle, the run stays open until the next `agent_settled`.
- **Origin.** Each run records its origin: `user`, `trigger`, `task` or `extension`. Runs started by an extension are accepted and audited; T3 and Orca kill the session instead (decision 16).
- **Steering.** A prompt sent during a run is delivered as `steer` or `followUp`, per user preference. The queue is capped at 128 messages and 32 MiB.
- **Abort.** pap sends `abort`. If compaction is running, or the run has not settled within 5 s, the process is terminated.
- **Dialogs.** At most 64 dialogs or 8 MiB. Unknown methods are cancelled automatically. A request unanswered for 60 s with no tab open triggers a push.

### 2.5 Containment

When a systemd user manager is available, each worker runs in `systemd-run --user --scope` with `MemoryHigh`, `MemoryMax` and `TasksMax` taken from settings.

Inside the worker:

- it sets `oom_score_adj=800` at boot, so the kernel kills an agent rather than the daemon;
- it runs in its own process group;
- a watchdog exits the worker if its parent daemon dies.

Kill ladder: `shutdown`, then 2 s, then SIGTERM to the process group, then 3 s, then SIGKILL. bash runs in bwrap according to the agent profile.

Environment:

- Interactive sessions get the daemon environment minus `PAP_*` and platform secrets.
- Agent sessions get an allowlist plus the agent's secrets vault.

Capacity: a cap on active workers and a free-memory floor. Above them, requests are refused with an explicit reason; nothing is queued silently.

The Pi SDK version is pinned in `pi-host`. `pap doctor` warns when the installed `pi` CLI differs.

### 2.6 Platform calls

Platform tools run in the daemon, never in the worker. The worker sends `platform_call{op,args}`.

The daemon identifies the caller from the session type it started itself (interactive, agent-thread or isolated-task), never from parameters. It checks that the op is allowed for that caller, runs it and replies with `platform_result`. No MCP bearer is needed, because the IPC channel is private.

The ops are listed in §5.4.

Sources: `T3: provider-pi/src/server/{rpc,adapter}.ts, process/agentScope.ts, mcp/McpToolAccess.ts` · `Orca: pi/rpc-*.ts, provider-process/*` · `pw: lib/extension-ui-queue.ts (custom panels)`.

## 3. Persistence

### 3.1 Owners

1. **Pi** owns its files; pap reads them in place and never copies them.
2. **pap state** lives in `~/.pap/state.db`.
3. **pap files** are `secrets/` (0700 directories, 0600 files, never in the database), agent homes (MEMORY.md under git, prompts, MCP config), attachments, worktrees, logs and backups.

### 3.2 SQLite

- Engine: `node:sqlite` (Node 24 built-in, no native module), WAL, `synchronous=FULL`, `busy_timeout=5000`, `foreign_keys=ON`, `journal_size_limit=32 MiB`.
- **Single writer**: the daemon. Transactions stay short because the API is synchronous. Heavy FTS queries run in a worker thread.
- **Tables are owned per module**, and only that module's `store.ts` writes to them.
- **Migrations** are forward-only SQL files per module (`modules/<m>/migrations/<YYYYMMDDHHmm>_<name>.sql`), applied in timestamp order across modules.
  - Changes between minor versions are additive only.
  - A database newer than the binary opens read-only.
  - `db + wal + shm` are snapshotted before every migration.
- **Teams**: root entities (projects, sessions, agents, triggers, lanes) carry `owner_id` and `workspace_id`; v1 has one owner and one `default` workspace. Everything is standard SQL except FTS5.

Tables:

- `sessions`, `session_events`, `session_search` (FTS5)
- `projects`, `lanes`
- `agents`, `tasks`, `triggers`, `trigger_fires`
- `outbox`, `receipts`, `runs`, `audit`
- `users`, `passkeys`, `auth_sessions`, `api_tokens`
- `settings`, `approval_rules`, `push_subs`, `schema_migrations`

### 3.3 Transcripts

- A session is identified by its absolute Pi file path plus the header uuid.
- A scanner (fs watch on `~/.pi/agent/sessions` plus periodic reconcile) maintains `sessions` and `session_search`. It reads files from a stored byte offset.
- It indexes **only sessions created after the pap install timestamp**, CLI sessions included (decision 24).
- **Cold session**: the daemon reads the transcript read-only through the SDK helpers, without starting a worker.
- **Hot session**: the daemon uses `get_entries{since}`.
- `session_events` stores only what Pi does not: run boundaries, approvals, platform calls and errors. Token deltas are broadcast, never persisted.

### 3.4 Retention and backup

| Data | Retention |
|---|---|
| `runs` | unlimited; also exported to `logs/runs.jsonl` for Loki |
| `session_events` | 30 days after the run ends |
| settled `outbox` rows | 7 days; failed rows are kept until resolved |
| `receipts` | 7 days |
| `audit` | 12 months, then `pap audit prune` by month (an append-only table with SQL triggers rejecting UPDATE and DELETE) |
| trigger fire journal | 500 entries per trigger |
| logs and traces | rotated at 10 MiB × 10 |

`pap backup` takes an online SQLite backup plus an archive of `~/.pap`, optionally without worktrees and attachments. `pap restore` reverses it. Scheduling is left to a documented systemd timer.

Sources: `T3: persistence/Sqlite.ts, EffectOutbox.ts, server-updates.md` · `Orca: journal-database*.ts (additive-only rule)`.

## 4. Client protocol and auth

### 4.1 Contracts

`packages/contracts` declares every method with `defineMethod({name, permission, idempotent, params, result, errors})` using zod schemas.

- The daemon builds an exhaustive `Record<MethodName, Handler>`. A method without a handler or a permission does not compile.
- The web client uses a typed proxy generated from the same catalogue.
- Mutations carry a client `commandId`. The `receipts` table returns the same result for a duplicate and never re-runs side effects. Mutations are never replayed automatically on reconnect.
- Errors carry a stable code and a fixed message, with no user content and no secrets.

### 4.2 The `/ws` socket

| Frame | Shape and rules |
|---|---|
| request / response | `{id, method, params, commandId?}` → `{id, ok, result \| error{code}}`, 1 MiB per message |
| subscriptions | `subscribe.<stream>{…, after?}` → `{sub, seq, event}`; `unsubscribe{sub}`. Unknown events are skipped but the cursor still advances |
| terminal | binary frames with a `streamId + seq` header and raw bytes; acks give flow control |
| hello | `?proto=1` on upgrade → `{protocol, capabilities[], serverVersion}`. Browsers cannot read the status of a failed upgrade, so the SPA first probes `GET /ws` over plain HTTP: on mismatch it answers 426 with `{protocol}` and the SPA shows "new version, reload" |
| keepalive | client ping every 5 s, server ping every 15 s; a peer silent for 15 s is considered dead |

Each handler failure fails only its own request, never the socket.

### 4.3 Streams and resume

v1 streams: `shell` (sidebar summaries), `session`, `lane`, `vcs{cwd}`, `terminal`, `inbox`, `health`.

Resume:

- The client sends `after = {epoch, seq}`. `epoch` changes at every daemon start; a cursor from another epoch always gets a snapshot (ADR 0003).
- The server replays the gap when it is at most 128 events and 1 MiB. Otherwise it sends a bounded snapshot: about the last 75 rows, the current partial message and pending dialogs.
- Older history is paged with `sessions.history{before}`.
- Deltas are coalesced every 50 ms. Large tool output stays off the stream and is fetched with `sessions.toolOutput`.

Client connection supervisor:

- a single retry owner;
- jittered exponential backoff capped at 30 s, reset after a stable connection;
- on foreground or online events, it probes the session before reconnecting;
- it keeps state and cursor in memory for 5 minutes.

### 4.4 Auth

- **First start**: the daemon logs a one-time setup URL with a random token, which creates the owner.
- **Login**:
  - password hashed with `crypto.scrypt`, 12 characters minimum;
  - WebAuthn passkeys with `@simplewebauthn/server` (the default login);
  - throttling per IP and per account.
- **Browser session**: an opaque random id, stored hashed, in a cookie set `HttpOnly`, `Secure`, `SameSite=Strict`. It lasts 30 days, sliding, and can be revoked from "Connected devices".
- **API tokens** `pap_…` are stored hashed, with permissions and an expiry.
- **Webhooks** use a per-trigger secret header, plus optional HMAC-SHA256 (§6). `/metrics` uses its own bearer token.
- **Permissions** are strings `domain:read|operate|admin`. In v1 the owner has all of them and tokens get a subset. The transport stamps the caller identity; it is never read from params.
- **CSRF**: `Origin` is checked on the WS upgrade and on every POST, in addition to SameSite=Strict.
- **`X-Forwarded-*`** headers are honoured only when `trustProxy` is configured.
- **Exposure**:
  - The daemon binds `127.0.0.1:7777` by default. For loopback binds, the setup URL and the published origin use `localhost`, because WebAuthn rejects IP addresses as relying-party IDs; on an IP origin, passkeys are disabled with a clear message instead of failing.
  - Passkeys, the PWA and Web Push need HTTPS outside localhost. Remote access goes through Tailscale serve, a reverse proxy, or `--tls-cert/--tls-key`.

### 4.5 HTTP routes (Hono + `@hono/node-server`; `ws` handles the upgrade)

| Route | Purpose | Access |
|---|---|---|
| `GET /`, `/assets/*`, `/sw.js` | SPA, PWA and service worker | public |
| `/auth/*` | setup, login, logout, devices | throttled |
| `POST /upload`, `GET /files/*` | attachments, downloads, previews (pi-web allowlist kept) | cookie or token + permission |
| `POST /hooks/:triggerId` | webhooks | trigger secret |
| `GET /metrics`, `GET /healthz` | Prometheus, liveness/readiness | bearer / minimal public |

Sources: `T3: contracts/rpc.ts, RpcAuthorization.ts, ThreadStream.ts, client-runtime/connection/supervisor.ts` · `Orca: rpc-method-permission.ts, rpc-caller-identity.ts, terminal-stream-protocol.ts` · `pw: lib/auth-throttle.ts`.

## 5. Policy pipeline and platform tools

### 5.1 The `pap-policy` extension

- It is evaluated **last** in `pi-host`, after user extensions, so it judges the final tool input: placed first, a later extension could rewrite a call it already approved. It still cannot be bypassed, because a single `block` from any handler blocks (ADR 0002).
- The daemon compiles the rules, sends them at worker boot and hot-reloads them with `policy_update`.
- **Any evaluation error blocks** the call (fail closed).
- Every stage writes an audit line: call, redacted arguments, decision and reason. Results are never recorded.

### 5.2 Stages

| # | Stage | Where | Rule |
|---|---|---|---|
| 00 | exposure | daemon | preset, codemode, tool-search, MCP exposure decide which tools exist |
| 01 | command denylist | worker | bash and powershell checked against the agent's regex presets, including nested codemode calls |
| 02 | egress | worker | URLs in arguments (nested calls included) checked against `web_allow_hosts`; MCP read-only for read-only sessions |
| 03 | approval | worker | category × approval mode × taint (§5.3) |
| 04 | guards | worker | run guard (5 identical calls / 150 calls / 60 turns), daily budget per agent |
| 05 | sandbox | OS | bwrap per profile (`sandbox`, `sandbox_network`); systemd scope; isolated tasks limited to the agent home |
| 06 | redaction | worker | exact secret values of 8+ characters become `[SECRET:NAME]` in tool results |
| 07 | fencing | worker | results of external tools (web, third-party MCP, feeds, webhooks) are fenced as untrusted and the session is marked **tainted** for the rest of the run |

### 5.3 Approval decisions

| Category | Examples | Interactive (auto-accept edits) | Unattended (trigger / task) |
|---|---|---|---|
| read | read, grep, find, ls, MCP `readOnlyHint` | allow | allow within permitted paths |
| edit | edit, write in cwd or worktree | allow | allow within permitted paths |
| exec | bash, powershell | ask | policy (denylist + sandbox), else block |
| network | URL tools, `web_fetch` | ask | host allowlist only |
| external write | `git push`, PR creation, non-read-only MCP, sends | ask | ask by push; deny on timeout |
| tainted + exfiltration-capable | any network or external write after untrusted content | ask, even when an "always" rule exists | ask by push, else deny |
| unknown | a tool with no known category | ask | block |

- An approval card offers four answers: **once**, **session** (held in worker memory), **always** (persisted in `approval_rules` per project or agent; visible and revocable in Settings) and **deny** (the reason is returned to the model).
- Policy profiles are chosen by the daemon:
  - `interactive`: approval mode, the project's "always" rules, an optional global denylist.
  - `agent-thread`: the agent profile (sandbox, egress, denylist, vault) and the `agent.*` ops.
  - `isolated-task`: a closed tool allowlist per trigger, paths limited to the agent home, a fenced trigger payload and no sensitive `agent.*` ops.

### 5.4 Platform ops

Each op declares its callers, its permission and an exfiltration flag in `contracts`. An undeclared op does not exist.

| Op | Allowed callers | Exfiltration |
|---|---|---|
| `agent.notify` (push to the user) | agent-thread | no |
| `agent.approve` (yes/no with push) | agent-thread | no |
| `agent.delegate` (task for an opted-in agent; refused when tainted) | agent-thread | yes: taint propagates |
| `agent.remind` (one-shot reminder on its own thread) | agent-thread | no |
| `lane.note` | lane sessions | no |
| `secret.request` (value goes to the vault; only a one-use ref enters the context) | interactive, agent-thread | no |
| `audit.append` | all (internal) | — |

**Known v1 limit.** The host allowlist covers tools that carry a URL. A bash run with network access can reach any host; the real barrier is bwrap without network (`sandbox_network: false`). A per-agent egress proxy is on the roadmap.

Sources: `pw: lib/agents/{command-policy,egress-policy,sandbox,secret-redaction,audit,untrusted-content,permissions,agent-*}.ts, lib/agent-ops/run-guard.ts` · `T3: mcpExtensionSource.ts (tool_call bridge), SecretRequests.ts, providerPolicy.ts (answer set)`.

## 6. Automation and outbox

### 6.1 From a source to a run

- **Sources**:
  - schedule (RRULE + timezone);
  - webhook (raw, Alertmanager, Grafana);
  - feed (RSS / Atom);
  - manual fire and dry-run;
  - `agent.delegate` and `agent.remind`;
  - quota reset.
- **Gates**: global or per-agent pause, daily budget, dedup key, webhook throttle (60/min, 20 queued), precheck.
- **One transaction** writes the fire row, the task and an outbox `task.start` effect. The HTTP 202 is sent only after commit.
- **Runner**:
  - N slots (a setting);
  - one task at a time per agent thread; isolated tasks run in parallel;
  - a free-memory floor;
  - a single `maxRunMs` deadline per run.
- **Task states**: `queued → running → done | failed | cancelled | interrupted`.
  - Terminal states are immutable.
  - Cancelling a task cancels its queued children.

### 6.2 Outbox

- Table `outbox(kind, payload, status, attempts, next_at, lease_until, replay)`.
- **Rule**: a state change and the effect it implies are written in the same transaction.
- One worker in the daemon, with a 30 s lease and 5 attempts with backoff. Failed effects are surfaced in Health.

| Effect | Replay class |
|---|---|
| `task.start`, `run.steer`, `run.abort`, `lane.setup` | process-bound: retired after a crash, never replayed |
| `push.send`, `digest.send`, `feed.poll`, `title.generate`, `checkpoint.capture`, `worktree.cleanup`, `attachment.cleanup`, `memory.decision.write` | replay-safe |
| `run.resume` (quota reset) | replay-safe, with a receipt against duplicates |

### 6.3 Boot

1. Recovery runs first, and nothing else starts until it ends (T3 "parked roots"):
   - `running` tasks become `interrupted`;
   - leased process-bound effects are retired;
   - replay-safe effects are requeued.
2. **Interrupted tasks are not retried by default.** `retryOnInterrupt` is opt-in per trigger; otherwise a Retry button appears on the card.
3. **Missed schedules are skipped by default** and logged as `missed`. `catchUp: once` is opt-in, with a grace window.

### 6.4 Source details

- **Webhook**:
  - the secret header is compared in constant time; optional HMAC-SHA256 over the raw body;
  - 64 KB maximum, read as a stream;
  - Alertmanager and Grafana alerts map to one line per alert, deduplicated on fingerprints;
  - responses are `202 {taskId}`, `409 {reason}` or `429`;
  - unauthenticated attempts are counted, never logged in detail.
- **Precheck**:
  - runs in the agent home under sandbox, 30 s maximum;
  - exit 0 fires, exit 1 skips (with the reason logged), any other code is an error;
  - its output (4 KB maximum) can be injected fenced into the prompt;
  - consecutive identical skips are collapsed in the fire journal.
- **Feed**: https only, redirects checked, 10 s timeout, 1 MiB maximum, at most 10 fenced new entries per task.
- **Quota reset**: a `usage_limit` failure with a reset time marks the run "limited" and schedules `run.resume` at reset. It can be cancelled.
- **Quiet hours**: runs still execute; pushes are batched into the end-of-quiet-hours digest.

Sources: `pw: lib/agent-ops/**` · `T3: EffectOutbox.ts, EffectWorker.ts, ScheduledTaskService.ts, webhookVerification.ts` · `Orca: automations/service.ts, precheck-runner.ts`.

## 7. Frontend

### 7.1 Layers

1. **runtime**: socket, typed RPC proxy, subscriptions with cursors, 5-minute cache. It is the only code that touches the socket.
2. **stores**: one zustand store per stream, fed only by the runtime. Optimistic writes (pin, archive, order) roll back on error. Lint enforces selectors.
3. **features/\<domain>**: screens plus pure view-models tested without a DOM.
4. **packages/ui**:
   - E1 Night and Day tokens (CSS variables + Tailwind 4 `@theme`);
   - owned Radix primitives;
   - AI components: Message, AuthorGroup, Reasoning, ToolCard, ApprovalCard, InputCard, CustomPanel, StatusBar, Composer.

### 7.2 Libraries

| Need | Choice |
|---|---|
| build and framework | Vite + React 19 + React Compiler; no SSR, no Next.js |
| routing | TanStack Router (typed search params, route code-splitting) |
| state | zustand (no TanStack Query: data arrives through streams) |
| primitives | Radix, owned in shadcn style; AI components inspired by AI Elements (licence to check) |
| transcript | @tanstack/react-virtual |
| markdown and code | pi-web pipeline (remark-gfm + Safari workarounds) + shiki loaded on demand |
| composer | tiptap: chips for `@file`, `$skill`, `/command`, `@Agent`; large pastes become attachments |
| editor | CodeMirror 6 |
| diff | decided at the spike: `@pierre/diffs` or CodeMirror merge |
| terminal | xterm.js + WebGL |
| palette | cmdk |

### 7.3 Kept from pi-web

- The Safari / iOS 16.4 floor, pinned by a test.
- Viewport and mobile keyboard handling, bottom sheets, 44 px touch targets.
- Shortcuts: Esc, Ctrl+Alt+N, Alt+↑/↓, Ctrl+Alt+1..9.
- The internal i18n layer, with **en + fr**.
- Local drafts, the completion sound, the minimap, the `/dev/ui` gallery.

### 7.4 New

- A keybindings JSON file with `when` clauses, plus an editor in Settings.
- A hand-written service worker (push, notificationclick, shell cache).
- Orca's feedback-timing rules:
  - nothing under 100 ms;
  - disabled until 1 s;
  - spinner until 3 s;
  - a stage label after that.
- Cancel is never destructive.
- No continuously repainting animation; `motion-reduce` everywhere.
- An initial bundle budget measured in CI. Editor, terminal, diff and shiki load lazily.

Screens, detailed typography, spacing, icons and the wordmark belong to DESIGN.md (spec B).

## 8. Testing and quality gates

### 8.1 Test levels

- **Unit**: Vitest for daemon, pi-host and web. Covers policy tables, RRULE and missed fires, payload mapping, redaction, safe paths, view-models and tolerant decoding.
- **Integration**: a real temporary SQLite, real temporary git repos and a real `pi-host` with the SDK. Uses an injected clock and an explicit outbox drain; no sleeps.
- **The only fake is a scripted Pi provider**, registered through Pi's custom-provider API. It returns scripted text, tool calls and quota errors. Everything else is real; no network, no tokens.
- **E2E**: Playwright against the built daemon on Chromium + WebKit, about 15 journeys:
  - setup and passkey;
  - prompt → approval → result;
  - lane → commit → PR (`gh` stubbed);
  - webhook → run → inbox;
  - reconnect and resume;
  - mobile viewport.
- **Pi compatibility**: a nightly job runs the integration suite against the latest Pi SDK.
- **Security tests**:
  - path traversal on `/files` and on static serving;
  - webhook bad secret, bad HMAC, 64 KB + 1, dedup replay;
  - fail-closed on invalid rules or exceptions;
  - taint followed by an exfiltration attempt;
  - forged `Origin`.
- No coverage percentage target.

### 8.2 Blocking gates

- ESLint `max-lines: 400`.
- `eslint-plugin-boundaries`.
- `knip` for unused files, exports and dependencies.
- Every disable must give a reason.
- `tsc --noEmit` strict.
- Design-system lint: no raw colours, no arbitrary values, no restyling of primitives.
- Budgets: initial bundle, session-open payload, idle worker RAM.
- Supply chain:
  - pnpm with pinned versions;
  - `minimumReleaseAge` of 3 days;
  - a native-build allowlist (node-pty);
  - Renovate.

### 8.3 CI and repository conventions

- **CI pipeline** (GitHub Actions): install → lint + types + knip → unit → integration → build (web, daemon, archives, image) → e2e → budgets. Docs-only PRs skip the matrix; the Pi-compat job runs nightly.
- **Dev isolation**: `pap serve --dev` uses a `PAP_HOME` and a port derived from the worktree path.
- **Repository conventions**:
  - AGENTS.md at most 150 lines;
  - topic notes in `docs/agents/<domain>.md`;
  - an ADR in `docs/adr/` for every deviation from this spec;
  - Conventional Commits, rebase before PR;
  - Prettier for formatting.

## 9. Packaging and release

### 9.1 Channels (one build)

1. **Self-contained archive**:
   - one tar.gz per platform: pinned Node 24, the app, production `node_modules` and a `pap` launcher;
   - `curl | sh` installs into `~/.local/share/pap/versions/<v>` with a `~/.local/bin/pap` symlink;
   - cosign-signed SHA256SUMS.
2. **OCI image**:
   - `node:24-bookworm-slim` plus git, gh, bubblewrap, openssh-client and tini;
   - runs as a non-root `pap` user, amd64 + arm64;
   - cosign signature, SBOM (syft), SLSA provenance;
   - a `compose.yaml` example.
3. **npm**: `npx pi-agentic-platform`, using the host's Node 24, keeping pi-web's node-pty postinstall, with npm provenance.

There is no Node SEA. node-pty is a native module, and Pi loads user extensions from real files that import the Pi package. Revisit at the spike.

### 9.2 Platforms

- Linux x64/arm64 and the container are tier 1. In a container, systemd scopes are replaced by container limits.
- macOS arm64 is tier 2: launchd, no sandbox.
- Windows is supported through WSL2 only.
- **Fail closed**: an agent whose profile requires the sandbox refuses to start where bwrap is unusable, and `pap doctor` reports it.

### 9.3 Update (archive)

1. Download, then verify the signature and the SHA256.
2. Stage the new version in `versions/<v>`.
3. Snapshot the DB, switch the `current` symlink and restart the service.
4. `/healthz` must report ready within 60 s, otherwise pap rolls back automatically (symlink and DB snapshot).

`pap rollback` does the same by hand. The container updates by changing the tag; npm by reinstalling. The in-app "update available" banner is kept.

### 9.4 Release

- Channels `stable` and `next`.
- **release-please**: Conventional Commits produce the changelog and the release PR, and the tag builds all three channels.
- The Pi SDK is pinned per release.
- `pap service install` writes a systemd user unit (with a linger hint) or a launchd plist.
- **Zero telemetry**. The only outbound request from pap itself is the update check, opt-out with `PAP_UPDATE_CHECK=0`. Pi workers run with `PI_TELEMETRY=0`; Pi's model catalog refresh runs only on explicit user action.

## 10. Spikes before the implementation plan

| # | Question | Done when | Fallback |
|---|---|---|---|
| S1 | Can `pi-host` host the SDK in a forked child and support `navigate_tree` and `ctx.ui.custom()` over IPC? | a scripted session prompts, branches, renders a custom panel | per-session fallback to `pi --mode rpc` (loses both features) |
| S2 | Does a scripted custom provider drive full runs (text, tool calls, quota error)? | the integration test runs offline and deterministically | replay recorded Pi events at the transport boundary (T3 style) |
| S3 | Is FTS5 compiled into Node 24's SQLite? | `CREATE VIRTUAL TABLE … USING fts5` succeeds | `better-sqlite3` (native, heavier packaging) |
| S4 | Idle RAM of one `pi-host` worker | measured on Linux x64; this sets the default worker cap | — |
| S5 | Diff renderer: `@pierre/diffs` (licence, size) vs CodeMirror merge | lane review prototype with line comments | the other candidate |
| S6 | AI Elements licence and fit with Radix + Tailwind 4 | licence confirmed, one component ported | build our own from the T3 / pi-web patterns |
| S7 | Project trust: is `~/.pi/agent/trust.json` Pi's file? | read Pi docs / pi-web `lib/project-trust.ts` | pap keeps its own `project_trust` table |
| S8 | bwrap inside the OCI image without extra privileges | sandboxed bash works under default Docker | document the required `--security-opt`; the fail-closed rule applies |
