# t3code (pingdotgg/t3code) - research notes for pi-agentic-platform

Scope: what to borrow / avoid for a self-hosted daemon + web/PWA that drives the Pi coding agent.

Conventions:
- REPO = `/home/ubuntu/Workspace/soulkyu/_refs/t3code`; every path below is relative to REPO.
- Short paths: `orchestration-v2/`, `auth/`, `mcp/`, `scheduledTasks/`, `scheduling/`, `secrets/`, `vcs/`, `persistence/`, `provider/`, `process/`, `observability/`, `checkpointing/`, `project/`, `usage/`, `terminal/`, `ws.ts`, `config.ts` are under `apps/server/src/`; bare `rpc.ts`, `adapter.ts`, `mcpInjection.ts`, `mcpExtensionSource.ts`, `status.ts`, `commands.ts` in the Pi sections are under `packages/provider-pi/src/server/`; bare `orchestrationV2.ts`, `auth.ts`, `baseSchemas.ts`, `providerPolicy.ts`, `git.ts`, `environment.ts`, `scheduledTask.ts`, `t3ProjectFile.ts` and `contracts/...` are under `packages/contracts/src/`; bare `docs/...` is at the repo root.
- `file:NN` = line number in the shallow clone (commit c77a7b7).
- "(inferred)" = my reading, not stated in code or docs.
- Read-only study: nothing in the clone was installed, built or executed.
- LOC = `wc -l` of ts/tsx/js/mjs/kt/swift/rs/css files; tests = files named `*.test.*`.

## 1. Identity

### 1.1 What it is
- "Minimal GUI for coding agents": a Node WebSocket server wraps provider CLIs/SDKs and serves web, Electron desktop and React Native mobile clients (`AGENTS.md:1-8`, `README.md:1-8`).
- Providers: Codex, Claude Code, Cursor, Grok Build, OpenCode, Antigravity, Pi, Muse, plus any ACP-registry agent (`packages/provider-*`).
- Positioned as a "bring-your-own-subscription" alternative to Claude Desktop, Codex app, Cursor Glass, Conductor (`AGENTS.md:1-6`).
- Maintainers: "very early, expect bugs", "mostly not accepting contributions" (`README.md:88-92`).
- Per AGENTS.md most contributions are expected to come from T3 Code itself, often controlled remotely (`AGENTS.md:41`).

### 1.2 License, version, freshness
- License: MIT, "Copyright (c) 2026 T3 Tools Inc." (`LICENSE`).
- Version 0.0.45 (`apps/server/package.json`).
- Last commit: 2026-10-10 03:34:14 -0500, `fix(web): align compact button touch targets (#17748)`.
- The clone is shallow: 1 commit, 27,779 tracked files, so no history or velocity data (`git log`).
- Cloud pieces (T3 Connect relay: Clerk identity + Cloudflare Worker/Durable Objects) are in-repo under `infra/relay` but operated by the vendor (`docs/internals/t3-connect.md:1-30`).

### 1.3 Stack
- Language: TypeScript 7.0.2 (native compiler; `@effect/tsgo` patched in `prepare`), Kotlin/Swift (13.4k LOC mobile native modules), Rust (4.2k LOC `native/resource-monitor`), C (`native/libghostty-vt`).
- Runtime: Node ^24.13.1 for dev (`package.json` engines); server engines `^22.16 || ^23.11 || >=24.10`; shipped as a Node single-executable (SEA, built with Node 26.8.2) (`docs/operations/release.md:38-45`).
- Core framework: Effect 4.0.2 ("effect-smol", vendored read-only in `.repos/effect-smol`) for services, layers, RPC, SQL, HTTP, schema (`pnpm-workspace.yaml` catalog).
- Web: React 19.2 + React Compiler, TanStack Router, Tailwind 4.3, Base UI, zustand + `@effect/atom-react`, tiptap, `@legendapp/list`, `@pierre/diffs`, `@pierre/trees` (`apps/web/package.json`).
- Desktop: Electron 44 + electron-builder + electron-updater. Mobile: Expo 58 / React Native 0.88-rc / uniwind. Marketing: Astro 7.
- Build/tooling: Vite+ 1.0.0 (`vp` = Vite/rolldown + oxlint + oxfmt + vitest in one CLI), pnpm 11.10.0 workspaces, knip, playwright-core (server-side preview browser).
- Storage: SQLite through `node:sqlite` (`packages/shared/src/nodeSqliteClient`), WAL mode.

### 1.4 Approximate LOC (src / tests)

| Unit | src | tests | note |
|---|---|---|---|
| apps/server | 213,303 | 243,394 | `orchestration-v2/` alone 59.6k src |
| apps/web | 254,847 | 120,280 | `ChatView.tsx` is 12,137 lines |
| apps/mobile | 133,633 | 45,355 | incl. 13.4k Kotlin/Swift |
| apps/desktop | 43,346 | 41,698 | Electron main/preload/ipc |
| apps/marketing | 1,811 | 140 | Astro site |
| infra/relay | 15,507 | 16,001 | T3 Connect relay |
| packages/client-runtime | 38,297 | 45,187 | web + mobile shared state/connection |
| packages/contracts | 27,075 | 7,865 | wire schemas only |
| packages/shared | 22,854 | 17,984 | runtime utils |
| packages/effect-codex-app-server | 61,252 | 1,391 | mostly `_generated` (inferred from dir name) |
| packages/effect-acp | 24,687 | 3,475 | ACP client |
| packages/provider-* (9 pkgs) | 59,981 | 31,850 | acp, acp-registry, core, cursor, grok, muse, opencode, pi (5,623), testing |
| packages/source-control-* (8 pkgs) | 27,643 | 23,047 | github, gitlab, bitbucket, forgejo, gitcafe, azure-devops, core, testing |
| packages/ssh + tailscale | 3,054 | 1,878 | |

- Total about 930k src + 600k test lines; 1,681 test files; test code is about 64% of src volume.

## 2. Repo layout

### 2.1 Tree
```
apps/server      Node daemon (CLI `t3`): WS RPC, HTTP, orchestration-v2, MCP server, git, terminal, scheduler
apps/web         React SPA (served by the daemon, also hosted at app.t3.codes)
apps/desktop     Electron shell: bundles + supervises the server child, SSH/WSL backends, auto-update
apps/mobile      Expo/RN app: connects to any environment; push, Live Activities, native terminal/markdown/diff
apps/marketing   Astro landing page + install scripts
infra/relay      T3 Connect relay (Cloudflare Worker + Durable Objects; webhook inbox; push fan-out)
packages/contracts          Effect Schema for everything on the wire (RPC group, events, auth scopes, settings)
packages/shared             runtime utils, subpath exports, no barrel (AgentScope, DrainableWorker, DPoP, themePalettes)
packages/client-runtime     connection supervisor, RPC session, state atoms (web + mobile)
packages/provider-core      ProviderAdapterV2 interface, ProviderHost port, MCP session config, probes, maintenance
packages/provider-{pi,opencode,cursor,grok,muse,acp,acp-registry}   one package per driver (Pi = reference)
packages/effect-{acp,codex-app-server}   protocol clients (ACP; Codex app-server JSON-RPC)
packages/source-control-*   GitHub/GitLab/Forgejo-Gitea/Bitbucket/Azure DevOps/GitCafe drivers
packages/{ssh,tailscale}    remote launch and tailnet helpers
native/*         C/Rust helpers (terminal VT core, process resource sampler, KDE/Hyprland capture)
oxlint-plugin-t3code        custom lint rules that encode architecture invariants
.repos/          vendored read-only references (effect-smol, alchemy-effect)
```

### 2.2 Dependency direction
- `contracts` <- `shared` <- `provider-core` <- `provider-*` <- `apps/server`.
- `contracts` + `shared` <- `client-runtime` <- `apps/web` and `apps/mobile`.
- Provider packages may import only `provider-core/server/*`, contracts and shared; they reach the server through the `ProviderHost` port, never `apps/server` (`docs/internals/adding-a-provider.md:116-118`).
- `apps/server` devDepends on `@t3tools/web` (it bundles the SPA) (`apps/server/package.json`).
- `AGENTS.md:141-148` and `docs/internals/overview.md:8-20` state the same ownership rule: provider processes, terminals, git and files belong to the server; shared connection/domain state belongs to `client-runtime`.

### 2.3 How shared contracts are defined and consumed
- `packages/contracts/src/rpc.ts` (2,027 lines) declares 188 RPCs with `Rpc.make(name, {payload, success, error, stream?})` and groups them as `WsRpcGroup`, then `.middleware(RpcScopeAuthorization)` (`contracts/rpc.ts:1833-1838,2027`).
- Server implements the group in `apps/server/src/ws.ts` (3,241 lines); clients use `RpcClient.make(WsRpcGroup)` (`packages/client-runtime/src/rpc/protocol.ts:1-6`).
- Domain events/commands live in `orchestrationV2.ts` (3,663 lines); auth scopes in `auth.ts`; settings in `settings.ts`.
- Contracts have "no heavy runtime logic" (`AGENTS.md:145`); the contracts package exports `src/*.ts` directly (no build step) (`packages/contracts/package.json`).
- Transport rule: a handler decodes, calls ONE service method, maps typed errors; users, agents (MCP), scheduled tasks and the CLI all reach the same service method (`docs/internals/effect-services.md:9-30`).
- Convention enforcement: AI review checks in `.macroscope/check-run-agents/` plus lint (section 6).
- AGENTS.md "Hit every surface" checklist: entry points, clients (web/desktop/mobile), providers, agents/MCP, contracts, reverse states (every way in needs a way out), connection modes, docs (`AGENTS.md:65-74`).

## 3. Client <-> server protocol

### 3.1 Transport and schema
- One WebSocket at `GET /ws` carrying Effect RPC with JSON serialization (`RpcSerialization.layerJson` at `apps/server/src/ws.ts:3191` and `packages/client-runtime/src/rpc/session.ts:212`).
- HTTP API (`packages/contracts/src/environmentHttp.ts`) for auth/pairing, bounded thread snapshots and history pages, attachment/asset upload, webhooks and `/mcp`.
- No SSE. Electron IPC only carries shell features (`packages/contracts/src/ipc.ts`), never domain data.
- Both ends validate with Effect Schema; every RPC has typed payload/success/error; server-push is `stream: true` RPCs.
- 188 RPCs. Prefix families in `WS_METHODS` (`contracts/rpc.ts:366-578`): server 37, pullRequests 30, subscribe* 13, provider 12, projects 11, preview 10, scheduledTasks 9, vcs 8, terminal 8, device 8, mcpApps 4, plus orchestration (`orchestrationV2.ts:3146-3160`).
- Chat mutations go through ONE RPC, `orchestration.dispatchCommand`, carrying a command union (`thread.create|fork|archive|pin|settle|snooze|stop|...`, `run.interrupt`, `runtime-request.respond`, `queued-run.edit|reorder|cancel`, `checkpoint.rollback`, `provider.switch`, `queue.resume`).
- Streams: `subscribeShell` (sidebar summaries), `subscribeThread` (transcript), `subscribeVcsStatus`, `subscribeTerminalEvents`, `subscribeServerConfig`, `subscribeAuthAccess`, `subscribeResourceTelemetry`, `subscribeWorktreeSetup`, `subscribePreviewEvents`.

### 3.2 Versioning (three layers)
1. Hard protocol gate: `orchestrationProtocol=2` query param on the WS upgrade; mismatch returns HTTP 426 `{code:"orchestration_protocol_incompatible"}` (`ws.ts:3144-3153`, `packages/contracts/src/environment.ts:13-15`).
2. Capability negotiation through the environment descriptor, never client version (`docs/internals/overview.md:21-38`; e.g. `threadPullRequests` vs legacy `threadPullRequestLinking`).
   - Opt-in booleans in subscribe payloads so old clients are never sent unknown shapes: `environmentThemes`, `usageLimitSources`, `acceptBoundedSnapshot`, `acceptCompactTurnItems` (`contracts/rpc.ts:1706-1729`, `orchestrationV2.ts:3245-3262`).
3. Forward-compatible decoding:
   - `ForwardCompatibleArray` turns undecodable elements into holes then filters them (`baseSchemas.ts:128-170`).
   - `ForwardCompatibleUnion` yields an `UnknownUnionMember` (`baseSchemas.ts:178-185`).
   - Unknown thread events decode to `{kind:"unknown-event", sequence}` and still advance the resume cursor; a KNOWN event type that fails to decode still fails (`orchestrationV2.ts:3320-3360`).
   - Auth responses keep legacy `scopes` and add exact `permissions`; unknown response permissions are ignored, grant inputs stay strict (`auth.ts:143-150`, `docs/internals/environment-auth.md:64-76`).

### 3.3 Request correlation and idempotency
- Wire-level request ids are handled by Effect RPC (not hand-rolled).
- Mutations carry a client-generated `CommandId`. The server stores `orchestration_v2_command_receipts`; a duplicate id returns the same receipt and re-runs no side effects (`docs/orchestration-v2/README.md:108`, `persistence/Migrations/055_OrchestrationV2.ts`).
- `dispatchCommand` returns `{sequence}`, the last committed event sequence, which is the client's recovery cursor (`orchestrationV2.ts:3219-3222`).
- Message delivery is decided server-side inside the per-thread dispatch lock: `start_run | steer_active | restart_active | queue_after_active` (`orchestration-v2/CommandPolicy.ts:30-60`).
- Entity-id design (app ids primary, provider ids are refs): `docs/orchestration-v2/entity-ids-and-correlation.md`.
- Relay deliveries carry `x-t3-relay-delivery-id` so a webhook delivered twice runs once (`docs/internals/t3-connect.md:25-30`).

### 3.4 Socket auth and failure isolation
- Browser: cookie. Bearer/DPoP clients: short-lived `wsTicket` query param minted over authenticated HTTP (TTL 5 min; `auth/SessionStore.ts:433`, `auth/EnvironmentAuth.ts:586`).
- Session revocation races the socket and closes it (`sessions.awaitInvalidation`, `ws.ts` end of the `/ws` route).
- Defect isolation: `disableFatalDefects: true` so a handler defect fails only its own request instead of a socket-level Defect frame that would end every pending request (`ws.ts:3122-3126`).
- Keepalive: client pings every 5 s, drops after 15 s without any frame; socket open timeout 15 s (`packages/client-runtime/src/rpc/protocol.ts`, `rpc/session.ts`).

### 3.5 Reconnect and replay
Sources: `docs/internals/connection-runtime.md`, `docs/internals/remote.md`, `apps/server/src/orchestration-v2/ThreadStream.ts`.
- One retry owner (`packages/client-runtime/src/connection/supervisor.ts`):
  - jittered exponential backoff capped at 5 min, reset only after a connection stays up;
  - offline/auth failures wait for a wakeup instead of burning attempts;
  - foreground/offline reports PROBE the live session and reconnect only on failed probe (offline reports are often wrong);
  - a long mobile suspension replaces the session immediately.
- Multi-route environments: ordered route list, first working route wins, earlier routes are preflighted while on a later one (including authorization), failed routes cool down; LAN/tailnet routes are learned from server-reported addresses (`remote.md:31-57`).
- Transport health is separate from data freshness: session `ready` waits for initial server config; shell/thread streams carry their own sync state.
- Resume protocol:
  - `subscribeThread` / `subscribeShell` accept `afterSequence`; without it the server sends a snapshot first.
  - Server replays the gap only if it is <= 128 events AND <= 1 MiB projected JSON AND <= 1 MiB raw persisted payload; otherwise it sends a fresh bounded snapshot. A cursor above the high-water mark is treated as stale (`ThreadStream.ts:14-24,106-124`).
  - Overlapping events are deduped by sequence on the client.
- Cold open is bounded: about 75 recent timeline rows / about 1 MiB; older history by paged HTTP; the wire projection drops raw command output, dynamic-tool result bodies and inline file-change bodies while persisted events stay complete (`docs/internals/performance-regressions.md:13-33`).
- Client keeps thread state + replay cursor for 5 idle minutes; mutations are never auto-replayed on reconnect (the operation owns idempotency) (`connection-runtime.md:62-87`).

## 4. Agent process management

### 4.1 General model
- Each driver implements `ProviderAdapterV2` (`packages/provider-core/src/server/ProviderAdapter.ts`) and declares a capability record (`OrchestrationV2ProviderCapabilities`): sessions, threads, turns, streaming, tools, approvals, planning, subagents, context, checkpointing, identity strength.
- Orchestration reads capabilities, never the driver kind (`docs/internals/providers.md:1-10`, `adding-a-provider.md:19-37`).
- Driver kind vs instance: a driver (e.g. `pi`) can have many instances (accounts/configs). Work routes by instance so mutable session/catalog state is never shared (`providers.md:8-10`).

| Provider | Protocol / integration | Where |
|---|---|---|
| Pi | `pi --mode rpc`, JSONL over stdio | `packages/provider-pi/src/server/rpc.ts` |
| Codex | JSON-RPC over stdio (app-server) | `packages/effect-codex-app-server`, `orchestration-v2/Adapters/CodexAdapterV2.ts` |
| Claude Code | `@anthropic-ai/claude-agent-sdk` in-process | `orchestration-v2/Adapters/ClaudeAdapterV2.ts` |
| Cursor | `@cursor/sdk` | `packages/provider-cursor` |
| OpenCode | HTTP server + `@opencode-ai/sdk` (1.x: one server per thread; 2.x: one per instance) | `packages/provider-opencode` |
| Grok, Antigravity, ACP registry | ACP over stdio | `packages/effect-acp`, `provider-acp`, `provider-acp-registry` |
| Muse | `@muse-code/sdk` | `packages/provider-muse` |

### 4.2 Supervision, residency, restart
- `ProviderSessionManager` owns live sessions: open, idle release (default 30 min; release deferred for pending background work, capped at 4 h), explicit shutdown, release on runtime failure (`ProviderSessionManager.ts:54-55,72-79`).
- It deliberately does NOT resurrect persisted sessions. After process loss, provider-bound work is terminalized and a later user command (or replay-safe durable operation) opens a session lazily.
- Startup recovery (`ProviderRuntimeRecoveryService.ts`): terminalizes runs bound to lost processes, retires non-replayable outbox effects, requeues replay-safe ones (`EffectOutbox.ts:121-146`).
- Restart continuation of interrupted runs is an opt-in preference, off by default; it requires matching durable run/thread/session/native-resume identity and rechecks archive state, newer user work and user-requested stops (`docs/internals/server-updates.md:59-80`).
- Provider-initiated work (background commands, subagents, goals) can finish after the turn settled: adapters offer a "wake" via `ProviderContinuationRequests` and report `hasPendingBackgroundWork` so idle release does not lose the result (`adding-a-provider.md:87-91`).
- Stop propagates: stopping a thread also stops its delegated subagent tasks (`delegated-tasks.stop` effect) (`docs/user/thread-sidebar.md:219-220`).

### 4.3 Crash containment (can one agent crash the server? No, by design)
- Per-session Effect `Scope` + fibers. A process exit becomes a failure of THAT session's event queue (`ProviderAdapterEventStreamError`) and the provider session is marked `error`/`stopped`; other sessions and the server are unaffected (`provider-pi/src/server/adapter.ts:2120-2146`).
- Resource containment on Linux: every agent/terminal launch goes through `AgentScope`:
  - `oom_score_adj=800` (an unprivileged process may raise but not lower its score) (`packages/shared/src/AgentScope.ts:66-72`);
  - under a systemd user manager, a transient scope `systemd-run --user --scope --slice=app-t3code-agents.slice --unit=...` with `MemoryHigh`/`MemoryMax` from total RAM (agents leave about 6 GB / 4 GB free before throttle / kill; small hosts get at least 50% / 75%) (`apps/server/src/process/agentScope.ts:35-45,121-160`);
  - the point is that the kernel or systemd-oomd kills ONE agent, not the server and every other agent;
  - per-thread `oomKilled(threadId)` lets the UI explain a death (UI surfacing inferred).
- Process-group kills guard against pid reuse: liveness probe (`signal 0`) before each escalation and refusal of pid <= 1 (`provider-core/src/server/processGroup.ts`, `provider-pi/.../rpc.ts:200-214`).
- Electron: native modules run in forked children with deadlines so a crash cannot take the app down (`docs/internals/overview.md:118-123`).
- Dev rule worth copying: never kill by name pattern because the agent's own argv contains the worktree path; kill only PIDs captured at spawn (`AGENTS.md:61`).

### 4.4 How t3code drives Pi (directly relevant)
Files: `packages/provider-pi/src/server/{rpc.ts,adapter.ts,mcpInjection.ts,mcpExtensionSource.ts,status.ts,commands.ts,textGeneration.ts,thinkingCapabilities.ts}`; user doc `docs/user/providers-pi.md`.

Spawn and environment
- Command: `pi --mode rpc [--no-session] <user launchArgs> --extension <cache>/pi-t3-mcp-extension.ts` (`mcpInjection.ts:250-316`).
- `extendEnv:false`; `detached` process group on POSIX; `taskkill /T /F` on Windows because there are no process groups (`rpc.ts:216-284`).
- No `--no-*` flags: the user's extensions, skills, prompt templates, AGENTS.md/SYSTEM.md, settings.json, models.json and auth all load exactly as in the TUI (`adapter.ts:1-25`).
- Launch args are tokenized and validated; `--mode/--session/--session-id/--fork/--print/--continue/--resume/--no-session/--export` are rejected, positional prompts rejected, `--provider` requires `--model` (`mcpInjection.ts:1-129`).
- Minimum Pi version 0.80.5 (needs `get_entries` and `agent_settled`) (`status.ts:72-78`). Pi is updated only through the owning installer, with `pi update --self` as the fallback (`driver.ts:51-56`, `providers.md:81-101`).

Transport (`rpc.ts`)
- LF-delimited JSONL split manually (never `readline`: it also splits on U+2028/U+2029 and would corrupt frames); trailing `\r` stripped (`rpc.ts:1-18,130-157`).
- 8 MiB per-record cap with drop-until-newline (`rpc.ts:128`); non-JSON stdout lines dropped with a debug log so a chatty extension cannot kill the session.
- stderr is never logged beyond its length (it can carry credentials or prompt text) (`rpc.ts:405-417`).
- Requests get ids `t3-<n>`; default timeout 30 s (adapter uses 15 s requests, 60 s session lifecycle, 2 s probes; `adapter.ts:109-112`).
- Every request is raced against transport death so callers never wait out a timeout for a process that is gone (`rpc.ts:445-474`).
- The finalizer that kills the process group is registered BEFORE any other setup, so an interrupt between spawn and setup cannot leak a detached `pi` (`rpc.ts:280-283`).
- Kill = SIGTERM, 1 s grace, SIGKILL, with an exit check before each signal (`rpc.ts:207-214`).

RPC vocabulary
- Commands used: `prompt` (with `streamingBehavior:"steer"` to steer mid-run), `abort`, `compact`, `get_state`, `get_messages`, `get_entries`, `get_session_stats` (context meter), `get_available_models`, `get_commands`, `set_model {provider,modelId}`, `set_thinking_level` (off/minimal/low/medium/high/xhigh/max), `set_session_name`, `new_session`, `switch_session {sessionPath}`, `fork {entryId}`, `extension_ui_response`.
- Events handled: `agent_start`, `message_start|update|end`, `tool_execution_start|update|end`, `compaction_start|end`, `auto_retry_start|end`, `extension_ui_request`, `extension_error`, `agent_settled`.
- Model slug `provider/model`; the sentinel `default` never calls `set_model` so Pi's own settings.json default wins (`adapter.ts:95-100`, `rpc.ts:74-83`).

Turn lifecycle and identity
- `agent_settled` is the ONLY terminal signal. `agent_end` merely closes one low-level run (compaction retries, auto-retries or queued continuations may follow). After settle the adapter probes `get_state` up to 3 times to confirm idle before terminalizing (`adapter.ts:13-18,114-115`).
- Stream deltas are flushed every 50 ms (`adapter.ts:109`).
- Thread identity: Pi session FILE PATH from `get_state.sessionFile` becomes the `nativeThreadRef`; a thread started in T3 resumes in the Pi TUI and vice versa (`adapter.ts:6-12,2194-2236`).
- Resume = `switch_session`, new = `new_session`, fork/rollback = `fork {entryId}` at the user entry. Same-instance forks run Pi's CLI in the destination dir because RPC session switching keeps the source cwd (`providers.md:32-37`, `adapter.ts:2910,3037`).
- Interrupt = `abort`. If compaction is running, settle is pending or a restart is requested, the whole process is terminated instead (abort does not cancel manual compaction), after capturing tree refs under an event permit (`adapter.ts:2690-2730`).
- Guard: if Pi starts agent work outside an active T3 turn, the session is stopped "to prevent invisible tool execution" (`adapter.ts:113-115,1696`).
- Capabilities declared for Pi: model switch in session yes, runtime-mode switch in session NO (restart instead), rollback yes, fork-from-turn yes, steering yes, queued messages yes, structured questions yes, subagents via T3 MCP only, pending requests survive restart NO (`adapter.ts:119-215`).

Permissions and extension UI
- Permission mode is enforced inside Pi by an injected extension (section 7.3); mode is fixed per process through `T3_PI_RUNTIME_MODE`.
- `extension_ui_request`: `confirm` -> `approval_request`; `select|input|editor` -> `user_input_request`; `notify` -> completed activity item; `setStatus/widget/title/editor-text` ignored (no T3 surface). Answers go back as `extension_ui_response` (`adapter.ts:19-25,1216-1330`).

MCP bridge (T3 tools inside Pi)
- The injected TS extension is a string constant materialized into a cache dir. It imports only from the user's own `@earendil-works/pi-coding-agent` and `typebox` (`mcpExtensionSource.ts:1-12`).
- It opens an HTTP MCP client to the daemon's `/mcp` with a per-session bearer (`T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`; inherited values are deleted from the env first) and registers `mcp__t3-code__*` tools (deferred/hidden exposure on Pi >= 0.99).
- It appends orchestration instructions via `before_agent_start` (the real system-prompt channel, so a leading `/` in the first user message is not broken) and expands `$skill` chips with Pi's own frontmatter loader in the `input` hook (`mcpExtensionSource.ts:217-246,398-402`).
- It also caps `max_tokens` at 32,768 for OpenRouter to dodge an upstream context-budget bug (`mcpExtensionSource.ts:252-266`).

Discovery without side effects
- Health = `pi --version` (4 s timeout). Models, commands and skills = a short-lived `pi --mode rpc --no-session` + `get_available_models` + `get_commands` (15 s) (`status.ts`).
- Rule: setup must not happen as a health-check side effect (`providers.md:52-58`).
- One-shot helpers (titles, commit messages, PR text, branch names): ephemeral `--no-session --no-extensions --no-tools`, 180 s timeout (`textGeneration.ts`, `mcpInjection.ts:250-316`).

Subagents
- T3's own `delegate_task` MCP tool creates durable child threads. Pi's example `subagent` extension is only observed; its children run `--no-session` and cannot be resumed (`providers-pi.md:52-55`).

## 5. Persistence

### 5.1 Engine and write path
- Single SQLite file `<home>/userdata/statev2.sqlite`; home = `~/.t3` (`T3CODE_HOME` / `--home-dir`; worktree dev uses `<worktree>/.t3`) (`apps/server/src/config.ts:139-168`).
- Pragmas: `busy_timeout=5000`, `foreign_keys=ON`, `journal_mode=WAL`, `journal_size_limit=32 MiB` (CLI and server may write from separate processes) (`persistence/Sqlite.ts:13-25`).
- Event sourcing with persisted projections:
  - `orchestration_v2_events(sequence AUTOINCREMENT, event_id, command_id, thread_id, run_id, node_id, provider, raw_event_id, event_type, occurred_at, payload_json)`;
  - `orchestration_v2_command_receipts`;
  - `orchestration_v2_projection_{threads,runs,run_attempts,nodes,...}` with `payload_json` columns (`persistence/Migrations/055_OrchestrationV2.ts`).
- Core graph: AppThread -> Run -> ExecutionNode tree (tool / approval / subagent) -> ProviderThread. Only run completion completes a user-visible turn (`docs/orchestration-v2/README.md:31-44,62-81`).
- Write path (`docs/internals/overview.md:53-71`): client command -> `Orchestrator` (pure decisions, serialized per thread, no I/O, 11.3k lines) -> `EventSink` commits events + projections + command receipt + outbox effects in ONE transaction -> subscribers notified after commit -> `EffectWorker` runs side effects (start turn, interrupt, checkpoint, rollback, title generation, cleanup) and feeds results back as commands.
- A command ack means the intent committed, not that the provider or checkpoint finished.

### 5.2 Outbox
- Rows leased (`lease_owner`, `lease_expires_at`); default lease 30 s, 5 attempts, durable retry delay (`EffectWorker.ts:533-551`).
- Effect types are classified (`EffectOutbox.ts:121-146`):
  - REPLAY_SAFE after process loss: `provider-runtime.continue`, `provider-session.detach`, `provider-thread.rollback`, `checkpoint.capture`, `terminal.cleanup`, `preview.cleanup`, `attachment.cleanup`, `thread-title.generate`, `delegated-tasks.stop`;
  - PROCESS_BOUND (retired, not replayed): `provider-turn.start|interrupt|steer|restart`, `runtime-request.respond`.
- Settled rows pruned after 7 days; failed rows are kept (storage cleanup keeps a deleted thread's worktree while any effect failed) (`EffectOutbox.ts:130-146`).
- Non-retryable interrupt races ("is not active", teardown in progress) are recognized to avoid pointless retries (`EffectWorker.ts:41-55`).

### 5.3 Migrations and compatibility
- Forward-only numbered TS files `persistence/Migrations/001..059_*.ts`, some with tests for data rewrites.
- V2 base is migration 055, which reconciles a privately developed preview schema (`055_OrchestrationV2.ts:1-40`, `persistence/reconcileV2PreviewMigration.ts`).
- V1 events survive only as input to a legacy importer (`orchestration-v2/legacy/`, `docs/internals/legacy-orchestration-migration.md`).
- Persisted events must stay decodable on replay: a downgrade can fail environment startup on one unknown event (`overview.md:69-71`, `providers.md:140-143`).
- Self-update rollback = file snapshot of main DB + WAL + SHM, not down-migrations (`docs/internals/server-updates.md:33-43`).
- Projections can be verified or rebuilt by replaying event pages inside a fixed-sequence transaction; recovery candidates are selected from projection state rather than loading all threads (`performance-regressions.md:52-70`).

### 5.4 Where transcripts and state live

| What | Where |
|---|---|
| Normalized transcript (messages, turn items, runs, nodes) | SQLite events + projections (`statev2.sqlite`) |
| Pi native session JSONL | Pi's own dir (default `~/.pi/agent/sessions`), referenced by path |
| Other CLIs' native sessions | read by `project/AgentSessionScanner.ts` (import) and `usage/usageTranscriptReader.ts` (usage) |
| Raw provider frames (debug) | `logs/provider/events.log`, rotating: 10 MiB x 10 files, 512 MiB total, 14 days, record <= 64 KiB (`provider/EventNdjsonLogger.ts:28-38`) |
| Attachments | `<state>/attachments` (claimed per thread by `AttachmentClaims.ts`) |
| Terminal scrollback | `<state>/logs/terminals`, 5,000 lines / 8 MiB per terminal |
| Traces | `<state>/logs/server.trace.ndjson` (rotated) |
| Secrets | `<state>/secrets` (0700 dir, 0600 files) |
| Settings / keybindings / themes | `<state>/{settings.json,keybindings.json,themes/}` |
| Identity | `<state>/{environment-id,anonymous-id,server-runtime.json}` |
| Worktrees | `<home>/worktrees` (configurable) |
| Checkpoints | hidden refs inside each repo (`refs/t3/orchestration-v2/checkpoints/...`) |
| Project-less thread folders | `<home>/scratch/<date>-<slug>-<id>` |

- Search is `LIKE` over `json_extract(payload_json,'$.text')`, not FTS (`orchestration-v2/ThreadSearch.ts:106`).
- Storage hygiene: opt-in cleanup of worktrees (inactive N days / merged / no commits, protecting local changes), browser captures and rotated logs; runs at startup, on change and hourly (`docs/user/project-settings.md:133-165`, `apps/server/src/storageCleanup.ts`).

## 6. Error handling and reliability

### 6.1 Effect usage (counts in `apps/server/src`, non-test)
- 350 `Schema.TaggedError` classes, 227 files using `Effect.fn`, 229 `Layer.effect|succeed|scoped`, 98 `Effect.timeout*`, 84 `acquireRelease|addFinalizer|acquireUseRelease`, 34 `Schedule.*`.

### 6.2 Conventions (`docs/internals/effect-services.md`)
- Service module order: errors/schemas -> `Context.Service` tag with the interface inline -> `make` -> `layer`. Dependencies come from the environment (`yield* FileSystem.FileSystem`), never as parameters.
- Namespace imports only (`import * as Effect from "effect/Effect"`).
- No `ManagedRuntime` / `runPromise` inside domain services; only at app/framework boundaries.
- Failures are `Schema.TaggedError` with bounded structured attributes and a FIXED `message`:
  - the underlying failure stays in `cause`, never copied into message or log annotations;
  - no raw payloads, command output, signed URLs or credentials in attributes.
- Translate to transport errors only in the transport; map each failure where its context is known; use `Effect.catchTags`, not `catchIf`.
- Tests exercise behavior through the service with test layers only for external dependencies.
- Example of the discipline: `ThreadSearchError` "carries no query text: search input is user content" (`ThreadSearch.ts:15-26`).

### 6.3 Typed domain errors
- User-facing mapping in `orchestration-v2/UserFacingErrors.ts`.
- Provider failures are classified, e.g. `usage_limit` with reset time vs generic failure; a Limited thread can auto-resume at reset or snooze until reset (`docs/user/thread-sidebar.md:192-215`, `provider-core/src/server/failure.ts`).

### 6.4 Resource scopes, retries, timeouts
- Processes, streams and sockets are tied to `Scope`; readers/writers are `Effect.forkIn(scope)`; `Deferred` races for transport-down; `Semaphore` permits order event handling against kills (`adapter.ts:491,1679`).
- Outbox retry uses a durable delay; client supervisor uses jittered backoff.
- Analytics batches retry with backoff then drop (`telemetry/AnalyticsService.ts`); relay awareness publications retry the latest state <= 5 times with exponential delay and reset on a new relevant event (`performance-regressions.md:93-100`).
- Tests use `TestClock`, `DrainableWorker` and persisted-event awaits instead of sleeps.
- Startup gating: long-running roots are "parked" (`forkParked`, `serverActivation.ts`) until recovery completes so schedulers cannot start runs that recovery would cancel.
- Self-update trial must reach `prepared` (migrations done, HTTP bound, roots parked) before the launcher commits (`server-updates.md:16-31`).

### 6.5 Logging and telemetry (`docs/operations/observability.md`)
- Logs: pretty stdout, no file by default; with an OTLP logs endpoint they are exported with trace/span ids.
- Traces: every completed span to `logs/server.trace.ndjson` (rotated) and optionally OTLP. `t3 trace summary --since 30m` prints counts and latency percentiles from the file even while the server is stalled or stopped.
- Metrics (`observability/Metrics.ts`): rpc requests/duration, outbox claims/queue wait, provider sessions/turns, git commands, terminals, webhook deliveries by outcome; in-process unless OTLP is set.
- `rpc.aggregate` span label comes from a typed exhaustive map, so a new RPC without a label is a type error (`observability/RpcInstrumentation.ts:12-60`).
- Event-loop stall monitor: samples every 30 s, records a `server.eventLoop.stall` span when the loop stalled > 2 s, with CPU/page-fault guidance (`observability/EventLoopMonitor.ts`); heap snapshot tooling; Rust host/process resource sampler surfaced in Settings > Diagnostics.
- Product telemetry: anonymous PostHog events, ON by default, opt-out with `T3CODE_TELEMETRY_ENABLED=false` (`docs/user/telemetry.md`).

### 6.6 Lint-enforced invariants (`oxlint-plugin-t3code/rules`)
- Server: `no-rpc-permission-bypass`, `no-raw-mcp-registration`, `no-global-process-runtime`, `prefer-catch-tags`, `namespace-node-imports`; also present (rule bodies not inspected): `no-inline-schema-compile`, `no-unscoped-has`.
- Tests: `no-manual-effect-runtime-in-tests`, `no-test-in-loop`.
- Hygiene: `require-suppression-reason` (every disable directive must say why).
- UI: `no-native-title-tooltip`, `no-raw-resize-observer`, `no-outset-state-indicators`, `no-hermes-unsupported-apis`, plus `@shadcn/lint` (`no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-unknown-classes`) (`vite.config.ts:112-400`).

## 7. Security

### 7.1 Auth and remote access
- The environment (daemon) is its own authority: it issues sessions and enforces scopes. Cloud identity/relay credentials are a separate trust boundary: "a relay token is never an environment login" (`docs/internals/environment-auth.md:1-6`).
- Credentials: browser cookie sessions, bearer access tokens, DPoP-bound tokens (an invalid proof must fail, never fall back to bearer) (`auth/dpop.ts`, `environment-auth.md:21-24`). Session TTL 30 days; WS ticket 5 min (`auth/SessionStore.ts:432-433`).
- Pairing: `t3 pair` or Settings create one-time pairing links (QR).
  - Pairing delegates a scope set; exchange can narrow but never widen.
  - Creating another link requires `access:write` AND every delegated scope.
  - The read model never exposes recoverable secrets; only the creation response returns the raw credential (`environment-auth.md:7-20`, `auth/PairingGrantStore.ts`).
  - Hosted pairing URLs keep the secret in the URL FRAGMENT so it never reaches the hosted origin (`docs/internals/remote.md:58-69`).
- Reusable dev credential: `T3CODE_DEV_AUTH_TOKEN` (hashed, per-environment, dev only) (`environment-auth.md:84-101`).

Scopes (`packages/contracts/src/auth.ts:82-117`):

| Scope | Gates |
|---|---|
| `orchestration:read` / `orchestration:operate` | read threads / send, launch, stop |
| `settings:write`, `providers:manage`, `environment:maintain` | config, provider install/auth, updates |
| `terminal:read` / `terminal:operate` | attach vs write to PTYs |
| `filesystem:read` / `filesystem:write` | project files incl. absolute paths |
| `source-control:write`, `preview:operate`, `diagnostics:read` | git/PR writes, preview browser, diagnostics |
| `access:read` / `access:write`, `relay:read` / `relay:write` | connections, pairing, T3 Connect |

- Authorization is compile-time exhaustive: `RPC_REQUIRED_SCOPES` is keyed by every RPC tag, so adding an RPC without choosing a scope is a type error (`apps/server/src/auth/RpcAuthorization.ts:36-43`).
- `RpcScopeAuthorization` middleware runs before every handler (`contracts/rpc.ts:1833`). A successful handshake grants no extra authority (`overview.md:17-19`).
- Client side: `createEnvironmentRpcCommand` + `CLIENT_GUARDED_RPC_SCOPES` drive UI availability; lint `no-rpc-permission-bypass` forbids raw clients outside `rpc/` (`AGENTS.md:153`).
- Remote access models (all terminate at the same server auth): direct LAN pairing; Tailscale (HTTPS via `tailscale serve`, managed by `t3 pair --tailscale`); SSH (desktop launches/forwards; cleanup stops only servers the launcher owns); T3 Connect tunnel (DPoP-bound bootstrap minted by the environment; relay proxies nothing after bootstrap except webhooks); hosted web app as a pure client (`remote.md`, `t3-connect.md:32-62`).
- Endpoint advertisement is only a hint: the client verifies identity through the public descriptor before sending credentials, and never silently falls back to loopback (`remote.md:26-30`).
- Outside agents (Claude Code, Codex, ChatGPT) connect to `/mcp` via OAuth authorization-code + PKCE:
  - public clients, stateless registration, loopback or HTTPS redirect URIs;
  - approval consumes a pairing code or an admin session;
  - the user grants read-only or a runtime-mode CEILING, not a scope list;
  - subject `mcp-client` is accepted ONLY on `/mcp` and rejected on every other HTTP/WS path (`environment-auth.md:26-50`, `auth/McpOAuth.ts`).
- Relay trust is explicit: the relay holds mint-signing authority; DPoP protects an honest exchange but not a compromised relay key; tunnels expose only a validated loopback origin; health and mint requests must not follow redirects (`t3-connect.md:32-62`).

### 7.2 Secrets
- Server secret store: files in `<state>/secrets` (dir 0700, files 0600, temp + rename) (`auth/ServerSecretStore.ts:162-237`); desktop uses Electron safeStorage / Linux secret storage; `@napi-rs/keyring` dependency.
- `request_secret` MCP tool: the agent asks the user for a secret; the answer goes straight to the secret store under a one-use `SecretRef` (HMAC from a server salt + thread + item, 24 h TTL); only the ref enters the transcript and model context (`secrets/SecretRequests.ts:1-45`).
- Env hygiene: Pi runs with `extendEnv:false`; `T3_MCP_*` stripped from the inherited env; providers drop ambient credentials an instance did not configure (Antigravity forces file credential storage and removes Google creds) (`providers.md:39-45`).
- Webhook tokens/secrets live in the DB row, are never returned by read models (`hasSecret` only), and credential-looking headers/query params are redacted in logs and `{{request}}` renders (`scheduledTasks/webhookTemplate.ts:28-50`).

### 7.3 Approval and permission flows
- Four runtime modes: `approval-required` (Supervised), `auto-accept-edits`, `auto` (provider's own reviewer), `full-access`; interaction mode `default|plan` (`contracts/providerPolicy.ts`). THE DEFAULT IS FULL ACCESS (`docs/user/permission-modes.md:6-9`).
- Rule: a provider offers only modes it enforces natively (`supportedRuntimeModes`). An unsupported stored mode runs as Supervised. T3 does NOT imitate a missing mode by auto-answering approvals, "T3's check is weaker than the agent's own enforcement" (`adding-a-provider.md:28-33`, `RuntimePolicy.ts:70-93`).
- Approval path:
  1. provider event -> `runtime_request` + execution node recorded in the event log;
  2. UI card replaces the composer (`ComposerPendingApprovalPanel`);
  3. `runtime-request.respond` command (validated, idempotent receipt);
  4. PROCESS_BOUND outbox effect;
  5. `adapter.respondToRuntimeRequest` -> native reply;
  6. decisions `accept | acceptForSession | acceptAlways | decline | cancel`, with provider option ids passed through unchanged (`providerPolicy.ts:50-63`, `adapter.ts:2733-2780`).
- Approvals raised inside subagents surface in the parent thread (`docs/user/thread-sidebar.md:219-222`).
- Pi enforcement (`mcpExtensionSource.ts:269-296`): extension `pi.on("tool_call")`.
  - `full-access` -> return (allow).
  - Read-only set {read, grep, find, ls} (and builtin `tool_search`) -> allow.
  - `auto-accept-edits` -> also allow {edit, write}.
  - Otherwise `ctx.ui.confirm("Allow <tool>?", first 4000 chars of input)`; decline returns `{block:true, reason}`.
  - Immutable per process. Docs: "not an operating-system sandbox" (`providers-pi.md:48-51`).
- MCP tool access (`mcp/McpToolAccess.ts:50-90`):
  - every T3 MCP tool handler must be built by a `Declaration` stating who may call it (thread caller vs outside client, read vs operate);
  - undeclared tools do not compile; Effect's `McpServer` registration is lint-banned outside `McpHttpServer`;
  - "parameters choose the target; the caller sets the limits": a thread caller's runtime/interaction modes, an outside client's approved ceiling; nothing a caller starts may run with broader modes; thread callers change things only while their own run is live (`mcp/threadAccess.ts`).
- Per-session MCP credentials are scoped to {environment, parent thread, provider instance, provider session}, have max lifetime + idle expiry, and are revoked on session release (`docs/orchestration-v2/orchestrator-mcp-server.md:35-60`).

### 7.4 Isolation and what is missing
- No OS-level sandbox for agents. Relies on provider-native sandboxes (Codex sandbox policy, Cursor sandbox flag, ACP agents "under their own sandbox") (`docs/user/cursor.md:61`, `providers-acp.md:104`). `AgentScope` is memory/OOM containment only.
- Projects are organizational boundaries, not filesystem sandboxes: `filesystem:read` can read anything the server account can, absolute paths included (`environment-auth.md:103-109`).
- Signed asset URLs are bearer credentials bound to file identity (device/inode) but not to the minting session; `filesystem:read` is checked at mint time, not at serve time (`environment-auth.md:111-121`).
- HTML visual replies run in a sandboxed iframe; the image proxy has SSRF blocklists for local / NAT64 / 6to4 ranges (`htmlRender/publicProxy.ts:9-75`).
- NOT found (grep for egress/denylist/audit in `apps/server/src`, `provider-core`, `contracts`): per-agent egress allowlist, command denylist, tool-call audit journal, untrusted-content fencing. Webhook bodies are templated verbatim into prompts (`scheduledTasks/webhookTemplate.ts`).

## 8. Worktrees and git

### 8.1 Workspace strategies and creation
- Strategy on launch/schedule: `root` (project checkout), `existing_worktree {worktreePath}`, `worktree {baseRef, branch?, startFromOrigin?}` (`orchestrationV2.ts:520-536`).
- Creation: `git worktree add [-b <new>] <path> <ref>` under `<home>/worktrees` (configurable), submodule init handled, base ref configured (`vcs/GitVcsDriverCore.ts:3400-3540`). Removal/prune tolerates "is not a working tree" (`:540,3796-3850`).
- Branch names: temporary first, then renamed by text generation using a static prefix (`t3/`), a semantic prefix (`feat/`, `fix/`) or custom instructions (`docs/user/project-settings.md:41-52`).
- Checked-in `t3.json` at the repo root: `$schema`, up to 50 scripts with `name`, `command`, `icon`, `runOnWorktreeCreate`, `async` (default true: agent starts while the script runs; false holds the agent), `runOnSettle`, `previewUrl` (`packages/contracts/src/t3ProjectFile.ts:25-90`; the repo's own `t3.json`).
- Scripts run in a server terminal with a completion sentinel and exit code (`project/ProjectSetupScriptRunner.ts`); progress streams via `subscribeWorktreeSetup`.

### 8.2 Parallel runs
- Shift-click several models in the model picker: one thread + worktree per model; Cmd/Ctrl+Enter starts a thread in the background and opens another draft (`docs/user/thread-sidebar.md:34-44`).
- Per-thread run queue: `queue_after_active`, `promote-to-steer`, reorder/edit/cancel; follow-up behavior Queue vs Steer per client (`composer.md:52-75`, `orchestration-v2/QueuedRunOrder.ts`).
- Settlement: threads settle after 3 days of inactivity or when their PR merges; `runOnSettle` scripts clean build output (`thread-sidebar.md:127-168`).

### 8.3 Checkpoints, diff, revert
- After every turn the server snapshots the working tree as a commit under a hidden ref `refs/t3/orchestration-v2/checkpoints/...`: temporary `GIT_INDEX_FILE`, `read-tree HEAD`, `write-tree`, `commit-tree`, `update-ref`. No commits land on the user's branch (`orchestration-v2/CheckpointService.ts:26`, `vcs/GitVcsDriver.ts:811-1080`).
- Checkpoints are scoped: root vs nested subagent scopes; nested ones do not advance the parent run count (`docs/orchestration-v2/README.md:36`).
- Turn diff = diff between checkpoint refs. `listAuthoredPaths` excludes files merely brought in by pull/merge/rebase during the turn while keeping files the turn edited, committed or conflict-fixed (`checkpointing/CheckpointStore.ts:100-115`, `docs/user/source-control.md:5-12`).
- Other diffs: full-thread diff, branch comparison (`reviewGetDiffPreview`), PR diff with persisted per-file "viewed" state (`persistence/PullRequestFilesViewed.ts`). Diff comments can be attached to the next prompt (`apps/web/src/reviewCommentContext.ts`).
- Revert: `checkpoint.rollback` coordinates workspace restore AND provider conversation rollback. A provider that cannot roll back its conversation must reject BEFORE any file change (`overview.md:82-86`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts`). Pi supports rollback and fork-from-turn.

### 8.4 Commit / push / PR
- `GitStackedAction` = `commit | push | create_pr | commit_push | commit_push_pr` with progress events (`contracts/git.ts:18-25`, `git/GitManager.ts` 106 KB).
- AI-generated commit message, PR title/body and branch name via provider text generation (Pi: ephemeral, tools off).
- PR drivers for GitHub (API token, `GH_TOKEN` or `gh`), GitLab, Forgejo/Gitea, Bitbucket, Azure DevOps, GitCafe (`packages/source-control-*`, `docs/user/source-control.md:14-40`).
- PR linking per thread (`thread.pull-request.link|watch`), PR watch reactors, merge detection even for agent-run `gh pr merge` (`PullRequestSyncReactor.ts`), auto-settle on merge (`ThreadSettlementService.ts`).
- In-app PR page: list, checks, review comments, submit review, reviewers, labels (`WsPullRequests*` RPCs).
- VCS abstraction: `VcsDriver` interface with an optional `checkpoints` capability and a registry (`vcs/VcsDriver.ts`, `VcsDriverRegistry.ts`); only Git is implemented (inferred).

## 9. UI architecture

### 9.1 Framework, routing, state
- React 19 SPA (`apps/web`), Vite+ build, React Compiler. Renders entirely client-side; the same bundle is served by the daemon, by app.t3.codes (Vercel) and by Electron through a `t3code://` scheme.
- TanStack Router file routes: `_chat.$environmentId.$threadId`, `_chat.draft.$draftId`, `_chat.pull-requests`, `projects.$projectKey`, `pair`, `connect`, `usage`, `welcome`, `settings.{general,providers,source-control,connections,integrations,projects,storage,scheduled-tasks,keybindings,appearance,diagnostics,archived,...}` (`apps/web/src/routes/`).
- Server state: `@t3tools/client-runtime` atoms (Effect Atom) per environment; shell stream = sidebar summaries, thread stream = transcript, snapshots + cursors cached.
- Local UI state: zustand stores (`composerDraftStore.ts` 4.6k lines, `rightPanelStore.ts`, `terminalUiStateStore.ts`, `uiStateStore.ts`) + localStorage.
- Multi-environment is first class: a project and its threads belong to ONE environment; clients group by repository identity.

### 9.2 Chat transcript and tool-call rendering
- `MessagesTimeline.tsx` (5.8k lines) on `@legendapp/list` virtualization with scroll anchoring, in-thread find bar with highlights, minimap, day/system dividers, quote/copy toolbar, assistant citations.
- Tool calls are summarized and grouped by `packages/client-runtime/src/work-log/{presentation,commandLabel,itemDetail,toolPresentation}.ts`:
  - shell wrappers shortened via the `unbash` parser (`commandLabel.ts` is 44 KB);
  - expandable to full command + output; V2 lifecycle rows and an item inspector (`V2ItemInspector.tsx`).
- Other transcript elements: subagent bar, proposed-plan card, MCP App frames, sandboxed HTML visual replies, mermaid diagrams, secret-request cards (`SecretRequestCard.tsx`).

### 9.3 Composer
- tiptap rich-markdown editor with file / skill / slash / terminal / PR context chips; `@` mentions, `$` skills, `/` commands.
- Prompt history (Alt+Up), prompt stash, queued messages above the composer (edit / reorder / send-as-steer).
- Pending approval / user-input panels replace the composer; banner stack built from slot components (`ComposerBanner.tsx`).
- Context-window meter, usage-limit banners; large paste (>= 32 KiB) becomes an attachment; 120k character cap (`docs/user/composer.md`).

### 9.4 Diff, files, terminal
- Diff viewer: `@pierre/diffs` (`StyledDiffCodeView`, worker pool, folding, find across files, comment annotations, file tree with status).
- File tree: `@pierre/trees`. File preview/editor in right-panel tabs (`FilePreviewPanel.tsx` 55 KB; markdown / HTML / PDF / CSV / media; saves via `fileSaveCoordinator`).
- Terminal: server-owned node-pty sessions rendered by `libghostty-vt` compiled to WASM (one WASM instance per tab); drawer + per-thread terminals. Replay strips terminal query/response traffic so scrollback replay does not provoke junk at the prompt (`docs/internals/terminal-runtime.md`).

### 9.5 Command palette, keybindings, sidebar
- Command palette (Cmd/Ctrl+K): commands, projects, threads across environments, message search (>= 2 chars), `>` for actions only, `Cmd+1..9` to pick. Live VCS/PR badges are leased to visible rows only (`CommandPalette*.tsx`, `performance-regressions.md:86-91`).
- Keybindings: JSON array `{key, command, when}` at `~/.t3/userdata/keybindings.json`, `when` clauses (e.g. `terminalFocus`), later rules win, defaults merged on startup, editor in Settings (`docs/user/keybindings.md`). Undo toasts (5 s) for pin/settle/snooze/archive; `mod+z`.
- Sidebar (`Sidebar.tsx` 5.6k lines): project groups across environments, pinned section with drag reorder (`@dnd-kit`), active / "Working" fold (beta) / settled / snoozed / archived; status indicators (working, needs approval, needs answer, unread, limited, PR state); drop files onto a row to attach; hover cards.

### 9.6 Styling and design system
- Tailwind v4 with semantic tokens in `apps/web/src/index.css` (2,369 lines): `--color-background|foreground|card|popover|primary|secondary|muted|accent|border|input|ring|destructive|success|warning|error|info|update|diff-addition|diff-deletion|code|sidebar|message*`, each backed by theme runtime variables and "appearance contrast" boost variables (`index.css:215-270`).
- Typography: system stacks only (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono `ui-monospace, "SF Mono", Menlo, Consolas...`); user-selectable fonts (`FontFamilyPicker`); prompt font `max(var, 16px)` on touch to stop iOS zoom (`index.css:131,167-169`).
- Palette (neutral zinc, `packages/shared/src/themePalettes.ts:137-241`):
  - dark: canvas `#0a0a0a`, surface `#111111`, border `#191919`, text `#f5f5f5`, muted `#818181`, accent `#346bf1`, error `#fb414a`, warning `#fe9a00`;
  - light: canvas `#fcfcfc`, surface `#ffffff`, border `#e4e4e7`, text `#27272a`, accent `#1b4ed8`.
- Themes: built-ins (t3-chat, grove, ocean, ember, iris), user themes (editor, VS Code theme import, JSON export), environment themes published from `~/.t3/userdata/themes/*.json` via `t3 theme set` (`docs/user/appearance.md`). Mobile has its own themes (uniwind generated CSS).
- Primitives in `components/ui` (Base UI + cva, 56 files: button, dialog, sheet, menu, select, combobox, command, toast 31 KB, sidebar, tooltip...).
  - Rule: primitives own their look; pick `variant`/`size`, never restyle with `className`; `shadcn/no-restyle`, `no-raw-colors`, `no-arbitrary-values` fail lint (`AGENTS.md:155`, `docs/internals/web-ui.md`, `vite.config.ts:260-290`).
  - Composer banners are the reference "slot" composition (`ComposerBanner.tsx`).
- Performance culture: "no continuously repainting animations"; panel animations default to 0 ms (slider up to 400 ms), honors reduced motion (`AGENTS.md:158`, `appearance.md:32-37`).

### 9.7 Mobile and responsive
- Web is responsive: right panel becomes `RightPanelSheet`, bottom-sheet menus, safe-area insets, View Transitions API for the hero -> docked composer morph on phones (`index.css:19-70`).
- PWA manifest only (`display: standalone`, 2 icons). No service worker, no Web Push: grep of `apps/web` for serviceWorker / pushManager / VAPID found nothing.
- The real mobile story is a separate Expo/RN app: offline draft + message queue, native markdown / terminal / diff / composer modules, share sheet, Live Activities / Android Live Updates, voice input (`docs/user/composer.md`, `mobile-notifications.md`, `apps/mobile/modules/*`).

## 10. Testing and quality

### 10.1 Frameworks and shape
- vitest through `vp test` with `@effect/vitest`; jsdom + react-test-renderer for web unit tests; playwright-core for server browser integration; Robolectric + ktlint/detekt for Android native; `cargo test` for Rust.
- 1,681 test files, about 600k test LOC.
- Philosophy (`docs/orchestration-v2/testing-strategy.md`): few high-value integration tests; doubles only at true boundaries (provider transport, `TestClock`, `Random`, temp fs/db).
  - Real orchestrator + real adapter + real event store + real projections + real checkpoint policy, driven by REPLAYED provider transcripts.
  - Not allowed: mocked orchestrator / adapter / normalizer / projection reducer / checkpoint service.
- Recorder scripts capture real provider sessions: `apps/server/scripts/record-{pi-rpc,codex-app-server,claude-agent-sdk,cursor-agent-sdk,grok-acp,muse-msp}-replay-fixture.ts`.
- Shared scenarios: `simple`, `multi_turn`, `queued_turn`, `turn_interrupt`, `message_steering`, `provider_thread_resume`, `tool_call_*` (`adding-a-provider.md:51-69`).
- No sleeps: `DrainableWorker`, `OrchestrationEffectWorkerV2.drain`, awaiting a persisted event or `Deferred` (`AGENTS.md:100-102`, `packages/shared/src/DrainableWorker.ts`).
- Performance regression tests with payload budgets (`vp run test:perf:v2-wire`): cold-open rows/bytes, resume replay caps, wire omission of tool output.

### 10.2 Lint, format, static checks
- oxlint + custom plugin (section 6.6), oxfmt, knip (unused files / deps / exports fail CI), `@effect/tsgo` diagnostics.
- Every lint/type disable directive needs a reason (`require-suppression-reason`).
- Pre-commit runs only the formatter (`vite.config.ts:79-83`).

### 10.3 CI (`.github/workflows/ci.yml`, 18 workflows in total)
- Jobs: lint (+ knip), typecheck, build (desktop pipeline + preload bundle verification), test (parallel packages), test_web, test_server (sharded matrix + Chromium), thread-transfer budget report, rust, mobile native change detection + macOS static analysis, release_smoke, and an aggregate `Check` gate.
- Other workflows: release, release-desktop, desktop-macos-preview(-publish), mobile-eas-preview/production, mobile-fingerprint-check, mobile-showcase-screenshots, deploy-relay, publish-aur, web-preview, windows-tests, pr-size, pr-vouch, issue-labels, cursor-hygiene-webhook.
- AI review "check-run agents" (Macroscope) for Effect-service conventions and UI consistency (`.macroscope/check-run-agents/*.md`); CodeRabbit config (`.coderabbit.config.ts`).
- Dev-agent skills in repo: `.agents/skills/{test-t3-app,test-t3-mobile,contribution-triage}` (`.claude/skills -> .agents/skills`).

## 11. Build, release, install

### 11.1 Packaging forms
1. `t3` CLI as a Node SEA archive per platform (macOS arm64, Linux x64/arm64, Windows x64/arm64; no macOS x64), with `SHA256SUMS`, signed/notarized when secrets exist, smoke-run on build hardware (`scripts/build-cli-archive.ts`, `release.md:38-45`).
2. npm `t3` launcher + `@t3code/t3-<platform>-<arch>` optionalDependencies, OIDC trusted publishing, dist-tags latest/nightly/preview.
3. Electron desktop (DMG, AppImage + .deb, NSIS) bundling the server.
4. Hosted web app on Vercel (latest/nightly channels).
5. Expo mobile through EAS (OTA JS updates + native builds, fingerprint check).
6. AUR `t3code-bin` / `-nightly-bin`, winget, scoop, Homebrew cask (`README.md:30-80`, `packaging/`).

### 11.2 Install and service
- `curl -fsSL https://t3.codes/install.sh | sh` (installs `~/.local/bin/t3`), `irm .../install.ps1 | iex`, or `npx t3@latest`.
- `t3 service install|status|restart|uninstall` = systemd user service (lingering enabled) or launchd; `t3 update [version] [--channel nightly]`; `t3 uninstall` (`docs/user/background-service.md`). Windows background service unsupported.
- Release channels: nightly (checked every 30 min); stable is promoted FROM a verified nightly commit, not main HEAD; preview train for maintainers only (`release.md:7-30`).

### 11.3 Self-update design (`docs/internals/server-updates.md`)
- A stable launcher owns the runtime chosen by systemd/launchd and is the only writer of durable service state (fsync'd same-dir replace). Server children request updates over IPC.
- Exact-version staged install with preflight (including launcher-protocol compatibility).
- The target boots as a TRIAL: it must finish migrations, bind HTTP and park every long-running root, then report `prepared`; the launcher commits the version durably and only then the child releases its gates.
- A failed or timed-out trial rolls back runtime AND database (snapshot of main + WAL + SHM; a durable restore marker survives crashes).
- Clients correlate the update id with the post-reconnect ready event to distinguish success from rollback.
- Desktop updates use a two-phase handoff (prepare returns a token while connected; commit only after receipt) with backend restart on install failure (`server-updates.md:52-57`).

### 11.4 Config / data directories
- `~/.t3/userdata/{statev2.sqlite,settings.json,keybindings.json,attachments,logs,secrets,themes}`, `~/.t3/worktrees`, `~/.t3/scratch`, `~/.t3/caches`.
- Env: `T3CODE_HOME`, `--home-dir`, `T3CODE_TRACE_FILE`, `T3CODE_TRACE_MAX_FILES`, `T3CODE_TELEMETRY_ENABLED`, `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`.
- Dev isolation: worktree-local `.t3`; ports derived from the worktree path; `vp run migrate-dev-db` copies a read-only sample of real data into the sandbox (`AGENTS.md:89-95`).

## 12. Feature map against pi-web domains

Legend: present / partial / absent. Paths relative to REPO.

1. Sessions and chat streaming, branching/fork, compaction, export - PRESENT (export absent)
   - Streaming via `orchestration.subscribeThread` + cursor replay; Pi deltas coalesced to 50 ms (`ThreadStream.ts`, `provider-pi/.../adapter.ts:109`).
   - Fork = `thread.fork` with lazy resolution: provider-native fork if same provider and supported, else portable context handoff; `thread.merge_back` (`ThreadForkService.ts`, `docs/orchestration-v2/thread-lineage-and-context-transfer.md`).
   - Compaction: Pi `/compact [instructions]` mapped to RPC `compact` (`provider-pi/.../commands.ts:4-28`); `compaction` turn item; handoff budget default 16k tokens (`T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`) (`docs/user/portable-handoffs.md`).
   - Session import from other CLIs (`project/AgentSessionImporter.ts`). No thread export (HTML/markdown) found (inferred from absence).
2. Session sidebar / projects / pins / archive / search / auto-naming - PRESENT
   - Pin + reorder, archive, settle (auto after 3 days or PR merged), snooze, unread (`thread.visit|mark-unread`), working fold, undo toasts, file drop onto rows; projects grouped across environments; project icons (`docs/user/thread-sidebar.md`, `components/Sidebar.tsx`).
   - Search: command palette, SQL LIKE over message JSON (`ThreadSearch.ts:106`).
   - Auto-naming: `thread-title.generate` outbox effect through provider text generation (`ThreadTitleRegenerationService.ts`; Pi ephemeral process).
3. Worktrees and parallel lanes (setup scripts, commit/push/PR) - PRESENT (strongest area)
   - Strategies, `t3.json` scripts (`runOnWorktreeCreate`, `async`, `runOnSettle`), multi-model fan-out, queue/steer, stacked commit/push/PR, cleanup policies (`orchestrationV2.ts:520`, `t3ProjectFile.ts`, `contracts/git.ts:18`, `git/GitManager.ts`).
4. File explorer / viewer / uploads / @-mentions - PRESENT
   - RPCs `projectsListEntries|ReadFile|WriteFile|SearchEntries|SearchContents|Mutate`; `@pierre/trees`; editable preview panel.
   - Attachments: up to 100 files per message (10 MiB per image, 50 MiB per file) via signed upload URLs claimed per thread (`AttachmentClaims.ts`, `docs/user/composer.md:32-50`).
   - Dragging from the tree into the composer creates a mention chip (`apps/web/src/components/files/fileTreeDragMention.ts`); `WorkspaceSearchIndex.ts` indexes files (uses `@ff-labs/fff-node`).
5. Git status / diff - PRESENT
   - `subscribeVcsStatus` broadcaster, turn / thread / branch diffs, PR diff viewer with viewed state, diff review comments feeding the composer (`vcs/VcsStatusBroadcaster.ts`, `checkpointing/CheckpointDiffQuery.ts`, `review/ReviewService.ts`).
6. Terminal - PRESENT
   - node-pty manager, 5,000-line / 8 MiB server scrollback, multi-client attach/observe, restart/clear, per-thread terminals, ghostty-WASM renderer on web and native renderers on mobile (`terminal/Manager.ts`, `terminal/NodePtyAdapter.ts`, `docs/internals/terminal-runtime.md`).
7. Models / providers / auth / reasoning levels / pricing - PRESENT
   - Provider instances (multi-account), catalogs discovered from the CLI (Pi `get_available_models`), per-model thinking levels, custom models, in-app install/update/auth flows (Codex ChatGPT OAuth handoff, Antigravity sign-in), version advisories (`provider/*`).
   - Usage pricing table with custom overrides and model mapping (`usage/usagePricing.ts`, `docs/user/usage.md`).
8. Tool presets / permission modes - PARTIAL
   - Four permission modes + plan mode, per provider capability. NO tool preset / allowlist concept: tools stay provider-native (Pi `--tools` only through user launch args) (`providerPolicy.ts`, `docs/user/permission-modes.md`).
9. MCP - PARTIAL (inverted direction)
   - T3 HOSTS an MCP server at `/mcp` with 79 tool declarations (orchestration `delegate_task`, `t3_thread_*`, `schedule_task`, `request_secret`, worktree, project, queue, pull-request link/watch, `preview_*` browser, `device_*`) and injects it into each provider session; outside agents can OAuth into it (`apps/server/src/mcp/toolkits/*/tools.ts`, `docs/user/outside-agents.md`).
   - No UI to manage the user's own MCP servers for providers; MCP Apps rendering (Codex only) (`docs/user/html-renders.md`).
10. Skills / plugins - PARTIAL
    - Skills discovered per provider and offered in the `$` menu (Pi: `get_commands` source=skill, expansion through Pi's loader); slash-command list; ACP Registry lets users add ACP agents (`provider-pi/.../commands.ts`, `packages/provider-acp-registry`).
    - No plugin / package manager UI for Pi extensions (left to Pi) (inferred).
11. Subagents - PRESENT
    - App-owned cross-provider subagents: `delegate_task` creates a child thread/run that receives only the task prompt (+ optional role); `task_status`, `task_cancel`; native subagents projected as child execution nodes; subagent bar; Stop propagates (`docs/orchestration-v2/orchestrator-mcp-server.md`, `ProviderSubagentBar.tsx`).
12. Long-term persistent agents / inbox / notifications - ABSENT (notifications partial)
    - No named agent identities with home / profile / memory / inbox. Closest: durable threads kept indefinitely, scheduled tasks that target an existing thread (`ScheduledTask.threadId`), settle/unsettle shelf, sidebar attention states.
    - Notifications: desktop notifications + 2 sounds + favicon badge (`apps/web/src/threadNotifications.ts`); mobile push (FCM/APNs) and Live Activities only through the T3 Connect relay (`apps/server/src/relay/AgentAwarenessRelay.ts`, `docs/user/mobile-notifications.md:11`).
13. Automation: task queue, scheduled triggers, webhooks - PRESENT
    - Scheduled tasks: `interval` (min 60 s), `fixed_time` (HH:MM + weekdays, local time), `webhook` (token in URL path, optional HMAC-SHA256 over raw body, `{{body.path}}` templating). Each task carries project, workspace strategy, model, runtime mode, interaction mode (`contracts/scheduledTask.ts`).
    - 5 s scheduler tick; missed schedules are re-aimed, not fired late; webhook limits 1 MiB body, 60/min and 20 queued per task, delivery log of 50; relay can hold requests up to 24 h while offline (`scheduling/Scheduler.ts:60`, `scheduledTasks/ScheduledTaskService.ts:62-68`).
    - Agents manage tasks through MCP (`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `run_scheduled_task_now`). Per-thread FIFO run queue with steer/promote.
14. Memory - ABSENT
    - No memory store; relies on provider-native context files (AGENTS.md, Pi's own). Closest: portable context handoffs and the thread-read MCP tool.
15. Security policies (sandbox, egress, command denylist, secrets, audit) - PARTIAL
    - Has: scoped sessions + DPoP, MCP OAuth with ceilings, `request_secret` + secret store, approval modes, OOM containment, SSRF blocklist on the HTML proxy, signed assets.
    - Lacks: OS sandbox, egress allowlist, command denylist, audit journal, untrusted-content fencing (section 7.4).
16. Cost / usage tracking, metrics, health - PRESENT
    - Usage page reads provider histories (Codex, Claude, Grok, OpenCode, Antigravity, Cursor) for tokens, cache savings, API-equivalent cost per model; subscription limit windows pooled across accounts; context-window meter (`usage/UsageService.ts`).
    - OTLP metrics, `t3 trace summary`, event-loop stall monitor, diagnostics panel, Rust resource telemetry (`observability/*`, `resourceTelemetry/*`).
    - Note: it re-reads provider histories instead of keeping a per-run registry (unlike pi-web's `runs.jsonl`).
17. Push notifications / sounds - PARTIAL
    - Sounds + desktop notifications + favicon badge on web/desktop. Mobile push requires the cloud relay. No Web Push / VAPID / service worker (`apps/web/src/threadNotifications.ts`, `docs/operations/android-notifications.md`).
18. Extension UI requests (dialogs / confirm / select from agent) - PRESENT
    - Pi `extension_ui_request` confirm/select/input/editor become approval / user-input runtime requests rendered in the composer; answers sent as `extension_ui_response`; notify -> work log; status/widget/title ignored (`provider-pi/.../adapter.ts:19-25`, `ComposerPendingUserInputPanel.tsx`).
    - Codex async questions are persisted as `user_input_request` with message-based responses (`providers.md:105-118`).
19. Mobile / PWA - PARTIAL on web, PRESENT natively
    - Web: PWA manifest + responsive layout only. Native iOS/Android apps with offline queue, native modules, push and widgets (`apps/mobile`, `apps/web/public/manifest.webmanifest`).
20. Settings UI - PRESENT
    - Routed pages for general, providers, source control, connections (157 KB component), integrations, projects (per-project overrides, "All environments" bulk edit), storage, scheduled tasks, keybindings, appearance, diagnostics, archived, licenses.
    - Ownership rules: client prefs stay local; environment defaults stay on the owning server; an unavailable target never falls back to another environment (`apps/web/src/routes/settings.*.tsx`, `overview.md:44-52`).
21. App update / install - PRESENT
    - Installer scripts, SEA archives, `t3 update`, service launcher with trial/commit/rollback, in-app "update server" RPC with progress, provider CLI updates through the owning installer, desktop electron-updater, mobile OTA (section 11).

Features that fit none of the 21 domains
- Multi-environment control: one client, many machines (route lists, SSH launch, Tailscale, WSL backends, T3 Connect tunnels, load-balanced new threads) (`packages/ssh`, `packages/tailscale`, `client-runtime/src/connection`).
- Server-side headless Chromium "preview" tabs that agents drive through MCP `preview_*` tools (recordings, local-server discovery), and mobile device-simulator control (`agent-device` CLI) (`mcp/PreviewAutomationBroker.ts`, `mcp/toolkits/device/`).
- "Snap-shot" window/region capture with accessibility metadata, browser-session import, voice input (`docs/user/snap-shot.md`, `browser-import.md`, `voice-input.md`).
- In-app pull-request review product (list, checks, threads, reviewers, labels, stacks) and PR watch / auto-settle (`WsPullRequests*`).
- Provider switching mid-thread with context handoffs; thread transfer / migration between environments (`docs/user/thread-migration.md`, `portable-handoffs.md`).
- Usage-limit recovery: auto-resume at reset, snooze until reset, provider quota windows (`docs/user/thread-sidebar.md:192-215`).
- Visual HTML replies and MCP Apps; JSON theme system; Linux GNOME extension; Rust resource monitor.
- Business surface: PostHog analytics, hosted web app, marketing site, relay.

## 13. Borrow / avoid

### 13.1 Top 10 to borrow (ordered by value to pi-agentic-platform)

1. Pi RPC transport hardening - `packages/provider-pi/src/server/rpc.ts`.
   - LF-only JSONL framing without `readline`, 8 MiB record cap, ids raced against transport death, finalizer-before-setup, SIGTERM -> SIGKILL with exit check against pid reuse, stderr never logged.
   - Why: pi-web already speaks this protocol; these are the failure modes found after real use.
2. Pi turn semantics - `adapter.ts:1-25,1890-1980,2690-2730`, `status.ts:72-78`.
   - `agent_settled` as sole terminal; idle probe after settle; terminate instead of abort when compaction runs; "unsolicited agent activity" kill switch; min-version gate on `get_entries` / `agent_settled`; `pi --version` + ephemeral RPC for health with no session side effects.
   - Why: removes ghost "running" states and invisible tool execution.
3. Permission bridge as an injected Pi extension - `mcpExtensionSource.ts:269-296`, `mcpInjection.ts:250-316`.
   - `tool_call` hook -> `ctx.ui.confirm` -> `{block:true}`; mode fixed in env per process (mode change = restart + resume); read-only tool set; edit/write tier.
   - Why: policy is enforced inside the agent process and reuses the exact `extension_ui_request` path.
   - Adapt: extend the same hook with the denylist / egress / audit pieces t3code lacks.
4. Event log + transactional outbox with replay-safe vs process-bound effect classes - `orchestration-v2/{EventSink,EffectOutbox,EffectWorker}.ts`, `README.md:108-166`.
   - One transaction commits event + projection + command receipt + effects; leases; recovery retires process-bound effects.
   - Why: durable intent for queued tasks, webhook runs and restarts on a single SQLite daemon.
   - Adapt: scale down (one worker, a handful of effect types) instead of copying an 11k-line Orchestrator.
5. Resume / replay protocol - `ThreadStream.ts:14-24,106-124`, `orchestrationV2.ts:3225-3262`, `connection-runtime.md`.
   - Snapshot + `afterSequence`; replay caps (128 events / 1 MiB) else snapshot; bounded cold open (about 75 rows / 1 MiB); wire omission of tool output bodies; 5 s ping / 15 s dead-peer; jittered backoff; cache with cursor.
   - Why: PWAs on flaky mobile links; replaces ad-hoc SSE reconnect logic.
6. Contracts-first exhaustive typing - `packages/contracts`, `RpcAuthorization.ts:36-43`, `baseSchemas.ts:128-185`, `orchestrationV2.ts:3320-3360`.
   - Required scope per RPC enforced by the type system; forward-compatible decoders (unknown events skipped but cursor advanced); capability flags in the descriptor instead of client-version checks.
   - Why: old PWA tabs vs a new daemon is a constant problem.
   - Adapt: zod/valibot equivalents if Effect is not adopted.
7. MCP tool declaration pattern + scoped credentials - `mcp/McpToolAccess.ts:50-90`, `mcp/threadAccess.ts`, `orchestrator-mcp-server.md:35-60`, `auth/McpOAuth.ts`.
   - Every tool must carry an access decision; per-session credentials (env / thread / instance / session) with idle expiry and revoke-on-release; OAuth + PKCE for external agents with a read-only or ceiling grant.
   - Why: pi-agentic-platform wants MCP + security policies. "Parameters pick targets, the credential sets limits."
8. Linux agent containment - `packages/shared/src/AgentScope.ts:66-125`, `apps/server/src/process/agentScope.ts:35-160`.
   - `systemd-run --user --scope --slice` + `MemoryHigh/Max` sized from RAM + `oom_score_adj=800` + per-thread `oomKilled` signal.
   - Why: a self-hosted daemon on a small box must survive runaway Pi / tool processes.
   - Adapt: add `TasksMax`, `CPUQuota`, IO weights; surface the OOM reason in the transcript.
9. Checkpoints in hidden git refs + turn-scoped diffs - `orchestration-v2/CheckpointService.ts:26`, `vcs/GitVcsDriver.ts:811-1080`, `checkpointing/CheckpointStore.ts` (`listAuthoredPaths`), `overview.md:82-86`.
   - Cheap per-turn undo/diff with no commits on the user's branch; revert must be refused before touching files if the agent cannot roll back its conversation.
   - Why: Pi `fork {entryId}` makes conversation rollback possible, so the same coordination applies.
10. Automation hardening details - `scheduledTasks/{ScheduledTaskService.ts:62-68,webhookVerification.ts,webhookRoute.ts,webhookTemplate.ts}`, `scheduling/Scheduler.ts:60`, `secrets/SecretRequests.ts`.
    - Token in path + HMAC-SHA256 over raw bytes with constant-time compare; 1 MiB cap read through a capped stream; 60/min and 20 queued per task; delivery journal of 50; skip (not late-fire) missed schedules; scheduler parked until recovery completes; minimal `{{path}}` template with credential redaction; `request_secret` one-use refs so secrets never enter transcripts.
    - Adapt: fence webhook payloads as untrusted content (t3code does not).

Cheap wins beyond the top 10
- Lint rules that encode architecture invariants (`oxlint-plugin-t3code`) and an AI review check per convention doc (`.macroscope/check-run-agents/`).
- Replay-fixture integration tests with recorders (`apps/server/scripts/record-pi-rpc-replay-fixture.ts`, `testing-strategy.md`) and payload-budget tests (`test:perf:v2-wire`).
- Provider capability flags + the rule "offer only what the agent natively enforces" (`adding-a-provider.md`).
- Self-update trial / commit / DB-snapshot design (`server-updates.md`).
- `t3 trace summary` style local trace summarizer; event-loop stall monitor.
- Checked-in project file with `runOnWorktreeCreate` / `runOnSettle` scripts (`t3.json`).
- "Setup must not happen as a health-check side effect" and "one transport retry owner" as explicit design rules.

### 13.2 Top 5 weaknesses / things to avoid

1. Size and god files for a "minimal" tool.
   - About 930k src LOC. `apps/web/src/components/ChatView.tsx` 12,137 lines, `orchestration-v2/Orchestrator.ts` 11,327, `Adapters/ClaudeAdapterV2.ts` 8,292, `provider-acp adapter.ts` 8,078, `ChatComposer.tsx` 7,735, `ProjectionStore.ts` 6,626, `ConnectionsSettings.tsx` 4,175 (`wc -l`).
   - Contradicts its own "yagni" creed (`AGENTS.md:37`) and makes cherry-picking hard: borrow patterns, not modules.
2. Key capabilities depend on the vendor cloud.
   - Mobile push / Live Activities, stable webhook URLs, offline webhook hold, tunnels and cloud login all need T3 Connect (Clerk + Cloudflare relay): "Background delivery requires T3 Connect" (`docs/user/mobile-notifications.md:11`, `t3-connect.md`).
   - No self-hosted Web Push (no service worker / VAPID found), so a self-hosted PWA must build its own push path.
3. Weak default security posture for autonomous agents.
   - Default permission mode is Full access (`permission-modes.md:6-9`); policy is "not an OS sandbox" (`providers-pi.md:49`); `filesystem:read` reads any file the server user can (`environment-auth.md:103-109`).
   - No egress allowlist, command denylist or audit trail (grep); webhook bodies are interpolated raw into prompts with no untrusted-content fence (`webhookTemplate.ts`); product telemetry is opt-out (`telemetry.md`).
   - Do not copy this trust model for unattended agents.
4. Bleeding-edge, tightly coupled toolchain.
   - Effect 4.0.2 (effect-smol, vendored for agents to read), TypeScript 7.0.2 with a patched language service, Vite+ 1.0.0, Node SEA built with Node 26.8.2, React Native 0.88-rc, patched RN dependencies (`pnpm-workspace.yaml:62-65,310-315`, `release.md:44`).
   - The typed-error / service discipline is excellent but demands Effect fluency; contributor docs tell agents to read vendored library source (`AGENTS.md:142-148`).
5. Migration and compatibility weight, plus functional gaps.
   - A V1 -> V2 orchestration rewrite left a legacy importer, 59 migrations, dual wire fields kept with "no scheduled removal" (`overview.md:32-38`), and clients that must decode every historical event (one unknown event can fail startup on downgrade, `providers.md:140-143`).
   - Gaps: search is SQL `LIKE` over JSON (no FTS, `ThreadSearch.ts:106`); pending approvals/questions do not survive a restart on Pi (`pendingRequestsSurviveRestart:false`); no memory, no long-term agent identity, no thread export.

## Appendix A. Reading order for the next study pass

1. `AGENTS.md`, `docs/internals/overview.md`, `docs/internals/providers.md`, `docs/internals/effect-services.md` (about 400 lines total, the maintainers' own map).
2. Pi path end to end: `packages/provider-pi/src/server/rpc.ts` -> `mcpInjection.ts` -> `mcpExtensionSource.ts` -> `adapter.ts` (3,320 lines; read the header, capabilities, `registerThread`, `interrupt`, `respondToRuntimeRequest`).
3. Durability: `orchestration-v2/EventSink.ts`, `EffectOutbox.ts`, `EffectWorker.ts`, `ProviderRuntimeRecoveryService.ts`, `ThreadStream.ts`.
4. Wire contracts: `packages/contracts/src/rpc.ts` (group + scope middleware), `orchestrationV2.ts` lines 3140-3380 (subscribe inputs, snapshots, unknown-event handling).
5. Automation: `scheduledTasks/ScheduledTaskService.ts`, `webhookRoute.ts`, `webhookVerification.ts`, `scheduling/Scheduler.ts`.
6. Security: `auth/RpcAuthorization.ts`, `auth/McpOAuth.ts`, `mcp/McpToolAccess.ts`, `secrets/SecretRequests.ts`, `process/agentScope.ts`.
7. Ops: `docs/internals/server-updates.md`, `docs/operations/observability.md`, `docs/operations/release.md`.
