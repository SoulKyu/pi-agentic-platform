# Orca (stablyai/orca) — codebase map for pi-agentic-platform

Scope: read-only study of the shallow clone at `/home/ubuntu/Workspace/soulkyu/_refs/orca` (1 commit, `git rev-parse --is-shallow-repository` = true). All paths below are relative to that root. Line numbers refer to that checkout. "(inferred)" marks anything not directly stated in code or docs.

---

## 1. Identity

| Item | Value | Evidence |
|---|---|---|
| Purpose | "Next-gen IDE for parallel agentic development": Electron desktop app that runs many coding-agent CLIs (Claude Code, Codex, OpenCode, Pi, +30 others) in terminals, one git worktree each, with a mobile companion, headless server, SSH remote worktrees, embedded browser, CLI and scripted automations | `package.json:4`, `README.md:24-27`, `README.md:150-205` |
| License | MIT, "Copyright (c) 2026 Lovecast Inc." | `LICENSE:1-3` |
| Version | 1.4.214 | `package.json:3` |
| Last commit | 2026-10-10 02:09:10 -0700, `0ba67e1` "fix(mobile): agents for workspaces another runtime owns show why (#27196)" (history not available, shallow) | `git log -1` |
| Org | stablyai / Lovecast; private sibling repo `stablyai/orca-cloud` holds API + auth services | `cloud/README.md` ("What is not here") |
| Language | TypeScript (strict, `typescript ^7.0.2` + `oxlint-tsgolint`), TSX; Swift (macOS native helpers), Rust (Windows CLI launcher), PowerShell/Python (computer-use Win/Linux) | `package.json:330`, `native/*` |
| Runtime | Node 24 (`engines.node`), Electron 43.7.5; bundled Node for headless `orcad`; relay bundle targets Node >=18 for SSH hosts | `package.json:359`, `src/packages/process-host/package.json` |
| Frameworks | React 19.2, Tailwind 4 (`@tailwindcss/vite`), shadcn/Radix, zustand 5, Monaco 0.55, TipTap 3, xterm.js 6 beta (+WebGL, patched), cmdk, lucide, sonner, react-i18next | `package.json` |
| Backend libs | `node-pty`, `node:sqlite` (builtin, wrapped), `ws`, `zod ~4.6`, `tweetnacl`, `ssh2`, `electron-updater`, `posthog-node`, `@linear/sdk`, `@anthropic-ai/claude-agent-sdk` (Claude structured chat), `agent-browser` (CDP bridge), `sherpa-onnx` (local dictation) | `package.json:151-179` |
| Build | `electron-vite` 5 on `rolldown-vite@7.3.1`, `electron-builder` 26, `tsc` for CLI, esbuild for relay/orcad bundles | `package.json`, `electron.vite.config.ts`, `config/electron-builder.config.cjs` |
| Package manager | pnpm 12.8.1 workspace (`src/packages/*`, `native/windows-registry`); `mobile/` and `cloud/` are separate workspaces with own lockfiles | `pnpm-workspace.yaml`, `package.json:361` |
| Mobile | Expo 55 / React Native 0.83 / expo-router | `mobile/package.json` |

### LOC (wc -l over `*.ts|tsx|mjs|cjs`; test = `*.test.*|*.spec.*|__tests__|*-test-harness*`; approximate)

| Area | Non-test LOC | Test LOC | Role |
|---|---:|---:|---|
| `src/main` | 841K | 1,399K | Electron main + headless runtime (12.2K files, 5.6K test files) |
| `src/renderer` | 909K | 1,035K | React UI (11.7K files, 4.7K test files) |
| `src/shared` | 194K | 160K | Contracts, zod schemas, pure logic, used by all processes |
| `src/relay` | 32K | 57K | Daemon deployed to SSH hosts |
| `src/cli` | 22.5K | 34.7K | `orca` CLI |
| `src/preload` | 11.6K | 2.2K | contextBridge API (~144 files in `src/preload/api`) |
| `src/packages/process-host` | 2.1K | 1.5K | Cross-platform spawn/kill/Windows argv library |
| `mobile/src`+`mobile/app` | 195K | 174K | Expo app |
| `cloud/` | 59.5K | 85K | Relay director/cell + push gateway + ops + Terraform |
| `native/` | ~7.4K | - | Swift/Rust/PS/Python helpers |
| `tests/` (e2e) | 59K | 150K | 508 Playwright specs + tools/benches |
| `config/` | 90K | 60K | 833 build/CI/lint scripts |

Totals: ~2.27M non-test LOC in app code vs ~2.95M test LOC (about 13.5K unit test files). Other Orca-related facts: 680 `defineMethod/defineStreamingMethod` RPC methods (`src/main/runtime/rpc/methods/`), 772 `ipcMain.handle(` call sites in 166 non-test files, 85 files under `.github/workflows`.

---

## 2. Repo layout

```
orca/
  src/
    main/        Electron main process AND the headless runtime (same code, AppEnvironment shim)
      runtime/     OrcaRuntimeService: authority for worktrees, terminals, tabs, agent sessions (1,687 non-test files)
        rpc/         RpcDispatcher, transports (unix socket, ws, cloud relay), E2EE, caller scopes
        rpc/methods/ 680 typed RPC methods (zod params + permission class)
        orchestration/ Runs/Tasks/Dispatches/mailbox (multi-agent coordination, SQLite)
        agent-state-rules/ JSON screen/title rules per agent (pi.json, claude.json...)
      native-chat/ "Chat UI": structured-session host, journal (SQLite), timeline, wire (386 files)
      pi/, claude/, codex/, opencode/, acp/ ... per-agent adapters (pi: 36 non-test files)
      jsonl-rpc/   generic JSON-lines RPC peer over child stdio (used by Pi)
      provider-process/ supervised child processes (SIGTERM/SIGKILL ladder)
      daemon/      out-of-process PTY daemon (node-pty) that outlives the app (270 files)
      orcad/       headless server entry ("orca serve"), no Electron
      ssh/         ssh2 client, relay deploy, reconnect, known_hosts (370 files)
      git/, github/, gitlab/, linear/, jira/, bitbucket/, gitea/, azure-devops/
      persistence/ profile-state (SQLite documents) + legacy JSON store
      automations/ scheduler + runs
      agent-hooks/ loopback hook server + managed hook installers for ~20 CLIs
      browser/     embedded Chromium + agent-browser CDP bridge
      plugins/     capability-gated plugin host (forked worker + sandboxed panels)
      skills/, ai-vault/ (session history scan + FTS5 search), usage/, rate-limits/, telemetry/, observability/
    preload/     contextBridge API surface (PreloadApi), one *-bridge.ts per domain
    renderer/    React app: src/store (zustand slices), src/components, src/web (browser build), src/runtime
    shared/      ~2.6K files: types, zod schemas, wire contracts, pure logic (src/shared/rpc-contract/*-params.ts)
    relay/       standalone daemon uploaded to SSH hosts (pty, fs, git, watchers) + "--connect" bridge
    cli/         `orca` / `orca-ide` CLI -> RuntimeClient -> runtime RPC
    packages/process-host/  @orca/process-host (only real workspace package; Node >=18, no deps)
  mobile/        Expo app (own workspace); consumes ../src/shared via Metro watchFolders (mobile/metro.config.js:5-11)
  cloud/         relay director/cell, push gateway, ops console, Terraform (own workspace; 25 inert deploy workflows)
  native/        computer-use (macOS Swift, Win PS1, Linux py), keyboard-layout, notification-status, windows-cli-launcher
  skills/, skill-stubs/, skill-guides/   agent-facing skills ("orca-cli", "orchestration", "computer-use", ...)
  resources/     icons, notification sounds, onboarding, bundled plugins, native-chat-visuals
  docs/          STYLEGUIDE.md, audits, docs/site (Next.js docs site, 56 MDX pages)
  config/        electron-builder, oxlint plugins, baselines (ratchets), 833 scripts
  tests/         Playwright e2e (508 specs) + tools/benchmarks
  Casks/         Homebrew cask (orca.rb, orca@rc.rb)
```

### Processes at runtime

| Process | Entry | Responsibility |
|---|---|---|
| Electron main | `src/main/index.ts` (inferred from `electron.vite.config.ts`) | App lifecycle, window, IPC, runtime service host |
| Renderer(s) | `src/renderer/index.html`, `popout.html` | UI; also `web-index.html` built by `vite.web.config.ts` for browser clients |
| PTY daemon | `src/main/daemon/daemon-entry.ts` | Owns node-pty sessions, survives app restart; Unix socket + token file; own cgroup scope on systemd (`daemon-cgroup-scope.ts:1-20`) |
| orcad (headless) | `src/main/orcad/orcad-entry.ts` | `orca serve`: runtime server without a window, plus idle-exit, instance lock, health |
| SSH relay | `src/relay/relay.ts` | Remote-host daemon with PTY/fs/git/watch handlers; `--connect` bridge reattaches after SSH flap |
| Agent children | per provider | Pi `--mode rpc`, Claude stream-json, etc., under `provider-process` supervisor |
| Plugin worker | `src/main/plugins/plugin-host-entry.ts` | `fork()`ed worker per plugin with capability grants |
| Workers/threads | profile-state writer, backup worker, hang watchdog, WSL transcript FS process, AI-vault search service | Isolate blocking IO from main thread |
| Cloud relay | `cloud/apps/relay` | Splices outbound WebSockets of phone and desktop (director + cells) |

### Dependency direction and shared contracts
- `shared` is the root: imported by main, renderer, preload, cli, relay and mobile (mobile via Metro path alias, no package). `main` never imports `renderer` and vice versa; they meet at `PreloadApi` types (`src/preload/api-types.ts`) and `src/shared/rpc-contract`.
- `@orca/process-host` is the only compiled workspace package (`pnpm build:packages` precedes every dev/test/typecheck: `package.json` scripts). Direct `child_process` use is banned in favor of it (`AGENTS.md` "Windows child processes"; `config/process-host-direct-import-baseline.txt` ratchet; `check:process-host-imports`).
- Contract style: zod schemas in `src/shared/rpc-contract/*-params.ts` (106 files) bound to method names by `defineMethod` (`src/main/runtime/rpc/core.ts:142`). `config/scripts/generate-rpc-params-catalog.mjs` bundles the live registry and emits `rpc-params-catalog.generated.ts`; `pnpm lint` runs it with `--check` so catalog and dispatcher cannot drift (`package.json` `verify:rpc-params-catalog`, script header comment "hand-listing 600 methods").
- Wire evolution: `RuntimeCapability` strings in `src/shared/protocol-version.ts` (28.6K) are negotiated per authenticated socket; unknown opcodes must be capability-gated (`AGENTS.md` "Remote Wire Compatibility").
- Generated TS from external protocol: `verify:acp-protocol` (`config/scripts/acp/generate-protocol.mjs`).

---

## 3. Client <-> backend protocol

### 3.1 Surfaces
| Surface | Transport | Used by | Evidence |
|---|---|---|---|
| Electron IPC | `ipcMain.handle` / `ipcRenderer.invoke` through ~144 preload bridge files | Desktop renderer | `src/preload/index.ts`, `src/preload/api/*-bridge.ts`, 772 handler sites |
| Runtime RPC, Unix socket / named pipe | newline-delimited JSON, 1 MiB max, 30 s idle, 32 conns, `{"_keepalive":true}` every 10 s while a call is pending, chmod 0600 | `orca` CLI (owner scope) | `src/main/runtime/rpc/unix-socket-transport.ts:9-12` |
| Runtime RPC, WebSocket (wss with TLS or ws) | JSON text + binary frames; 1 MiB msg, 128 WS / 256 TCP conns, 10 s pre-auth timeout, 15 s ping sweep | Phone, paired desktop, browser web client, `--host runtime:` CLI | `rpc/ws-transport.ts:13-26` |
| Cloud relay WebSocket | Both peers dial out to a "cell"; relay splices frames; invite/resume credentials; 4401/4404/4408/4409/4429/4503 close codes with typed recovery | Phone when LAN unreachable | `rpc/relay-transport.ts`, `src/shared/mobile-relay-close-codes.ts`, `cloud/packages/relay-contract` |
| SSH relay protocol | binary length-prefixed frames (Regular/Handshake/KeepAlive), version handshake, exit codes 42/43 for version/credential mismatch | Desktop <-> remote host daemon | `src/relay/protocol.ts:30-45`, `src/relay/relay-handshake.ts:17-23` |
| PTY daemon protocol | NDJSON over Unix socket (inferred from `daemon-client-ndjson-readers.ts`), hello handshake, protocol version, token file | Main <-> daemon | `src/main/daemon/daemon-hello-protocol.ts`, `daemon-client-hello-handshake.ts` |
| Agent child stdio | JSON-lines RPC (Pi) or stream-json (Claude) | Main <-> agent CLI | section 4 |
| Loopback hook HTTP | `POST http://127.0.0.1:<port>/hook/<kind>` + `X-Orca-Agent-Hook-Token` | Agent-side extensions/hook scripts -> main | `src/main/pi/agent-status-extension-source.ts:248,271-275` |

### 3.2 RPC envelope, validation, correlation
- Request `{id, authToken, method, params?, orchestration* fields}`; response `{id, ok:true,result,streaming?,_meta:{runtimeId}}` or `{id, ok:false, error:{code,message,data?}, _meta}` (`rpc/core.ts:24-56`, client-side zod union incl. `_keepalive` at `src/shared/runtime-rpc-envelope.ts:1-60`).
- Every method is `defineMethod({ name, permission, params: ZodType|null, handler })` or `defineStreamingMethod(... emit)`; `permission` is mandatory so "a new method cannot ship without deciding which callers may reach it" (`rpc-method-permission.ts:1-8`). Dispatcher parses params, admits the request, resolves caller identity, runs handler, maps errors (`rpc/dispatcher.ts:50-120`, `rpc-request-admission-prologue.ts`, `dispatcher-error-response.ts`).
- Correlation: client-chosen string `id`; per-connection `connectionId`, `requestId`, `clientId`, `pairedDeviceId` carried in `RpcContext` (`core.ts:~65-170`) so handlers clean up per socket (subscriptions are keyed by connection, not device token).
- Mutation idempotency: `clientOperationId` with embedded timestamp rejected when future-dated beyond a skew (so an ID cannot look new after tombstone GC) `rpc/methods/agent-session.ts:50-55`; durable operation ledger + receipts (`src/main/runtime/rpc/orchestration-mutation-*.ts`, `agent_session_operations` table in `journal-database-schema.ts`).
- Streaming: `defineStreamingMethod`; shared-control multiplexes many logical subscriptions on one socket (`src/shared/remote-runtime-shared-control-protocol.ts`); abort via per-connection `AbortSignal`.
- Terminal bytes bypass JSON: binary frames with 16-byte header (kind 0x74, version 1, opcode, streamId u32, seq u64) and 18 opcodes incl. Snapshot*, Resize, ClaimViewport, Ack (flow control), SetOutputPaused, InputAck(applied|delivery-unknown|resend); opcode numbers are frozen for old clients (`src/shared/terminal-stream-protocol.ts:1-37`).
- Payload limits everywhere: JSON structure limits (256K tokens, depth 32; `terminal-stream-protocol.ts:5-9`), outbound memory budget per socket (`mobile-e2ee-outbound-memory-budget.ts`), bundle chunking.
- Compatibility: `RUNTIME_PROTOCOL_VERSION = 3`, `MIN_COMPATIBLE_RUNTIME_{CLIENT,SERVER}_VERSION = 2` (`src/shared/protocol-version.ts:88-90`) plus dotted capability strings (`'project-host-setup.v1'`, `'browser.screencast.v1'`, `'jira.user-fields.v1'`, ...) negotiated per socket; pure verdict function `evaluateRuntimeCompat` returns `ok | blocked(client-too-old|server-too-old)` and is duplicated for Expo (`src/shared/protocol-compat.ts:1-40`). ~793 recorded golden RPC payloads in `mobile/rpc-foundation/goldens`, `pnpm rpc:diff`/`rpc:record`; CI job `cross-version-wire` (`.github/workflows/pr.yml:947`).

### 3.3 Reconnect and liveness
- Server: WS heartbeat 15 s ping/pong, ~60 s to reap half-open phone sockets (`ws-transport.ts:23-26`); `ws-fallback-port-store.ts` keeps a stable fallback port so earlier pairings do not strand.
- Phone: `connection-health.ts`, `connection-revival-triggers.ts`, generation-scoped request owner, full-jitter recovery table by close code (`mobile-relay-close-codes.ts:19-45`).
- SSH: `SshReconnectLadder` with two counters (flap vs failed handshake), delays capped so the remote relay's grace window cannot expire (`src/main/ssh/ssh-reconnect-ladder.ts:1-60`); 60 s "stable connection" resets backoff; relay stays alive in grace so PTYs survive.
- Terminal: daemon-backed PTYs persist across app restarts; renderer re-attaches with snapshot+seq; scrollback survives restarts (`README.md` Terminal Splits).

### 3.4 Mobile companion <-> desktop
1. Desktop creates a device entry (`DeviceRegistry.addDevice`, per-device token, scope `mobile|runtime`, optional grants) and shows QR/link `orca://pair?code=<base64url JSON>` (`src/shared/pairing.ts:15-31`). Offer v2 holds `{endpoint, deviceToken, publicKeyB64 (host X25519), pairedDeviceId?, scope?, relay?, hostDescriptor?}` (`mobile-relay-pairing-offer.ts:8-14,55-85`); relay invites expire <= 10 min with 30 s clock-skew leeway (`:12,17`).
2. Phone connects (LAN `ws(s)://host:6768` or relay cell), sends E2EE hello; v2 handshake = client+desktop 32-byte nonces, X25519 `nacl.box.before`, HKDF-SHA256 (labels `orca-mobile-e2ee/v2/salt|session`) -> two directional keys + session id over a transcript hash; counters per direction (`mobile-e2ee-v2-key-schedule.ts`, `mobile-e2ee-v2-desktop-session.ts`). Fallback v1 `nacl.box` (`e2ee-channel.ts`). Handshake timeout 10 s, 5 consecutive decrypt failures close the socket (`e2ee-channel.ts:25-26`).
3. Inside the encrypted channel the phone authenticates with its device token; `resolveAuthenticatedDevice` checks the registry; unauthenticated failures feed `UnpairedDeviceAuthThrottle` (3 failures / 60 s triggers a callback) (`rpc/unpaired-device-auth-throttle.ts`).
4. Phone then calls RPC; allowed methods are an explicit allowlist (`runtime-rpc-mobile-method-allowlist.ts`, `rpc-caller-scope.ts:22-45`). Chat/terminal/diff views are ordinary RPC streams. Push: desktop calls a cloud push gateway (APNs/FCM) with host-proof auth; phone only holds native push token (`cloud/docs/push-gateway.md`, `src/shared/mobile-push-contract.ts`).
5. Host also serves its version-matched mobile web bundle to the phone over RPC in 48 KiB chunks or gzip 384 KiB ranges (`rpc/methods/mobile-web-bundle.ts:1-12`); the RN app is a native shell (`mobile/src/mobile-web-shell/`, `bridge-host*.ts`) that renders the host's own web UI. (Mixed native screens still exist: `mobile/app/*.tsx`, `mobile/src/session/Mobile*`.)

### 3.5 Browser web client
`vite.web.config.ts` builds `src/renderer/web-index.html` to `out/web`; `WebSocketTransport` can serve it via `createStaticWebClientHandler` (allowlisted paths only, GET/HEAD only; `static-web-client-handler.ts:6-9,29-55`). `orca serve` prints a browser URL with the pairing code embedded; the page decodes `orca://pair` payloads from `?pairing|pair|code|token` or the hash and clears them from the address bar (`src/renderer/src/web/web-pairing.ts:50-110`). The web client re-implements the preload API on top of RPC (`src/renderer/src/web/preload-api/`, `web-preload-api-*.test.ts`) with browser-side tweetnacl (`web-e2ee.ts`).

---

## 4. Agent process management

### 4.1 Two integration modes
1. **Terminal mode (default for every CLI):** PTY via `node-pty` hosted in the PTY daemon; Orca injects env (`ORCA_PANE_KEY`, `ORCA_TAB_ID`, `ORCA_WORKTREE_ID`, `ORCA_AGENT_LAUNCH_TOKEN`, hook endpoint) and installs per-agent hooks/plugins; status comes from hooks, never from scraping (`src/shared/agent-status-types.ts:1-3` "never inferred from terminal titles").
2. **Structured ("Chat UI"/native chat) mode:** Orca owns a child over stdio and renders its own chat UI from a normalized timeline. Registered providers: Pi over `pi --mode rpc` (`src/main/pi/`), Codex, Claude (Agent SDK / stream-json), plus ACP-protocol agents (opencode, omp, grok launch specs in `src/main/acp/acp-launch-specs.ts:98-170`). Registry: `STRUCTURED_AGENT_RUNTIME_REGISTRATIONS` at `src/main/runtime/structured-agent-runtime-registrations.ts:284`; every agent declares a capability record (`src/shared/agent-session-capabilities.ts`) that clients branch on instead of agent names. Docs still call this "Chat UI ... experimental" (`docs/site/content/docs/agents/native-chat.mdx`).

### 4.2 Pi integration (all of it)
**(a) Structured chat over RPC** — `src/main/pi/rpc-*.ts` (≈2.6K non-test lines; whole `src/main/pi/` = 36 non-test files, 4.8K lines) on top of `src/main/jsonl-rpc/` (707 lines):
- Launch (`rpc-launch.ts:40-119`): `pi --mode rpc [extra args] [--session <file> | --fork <file>]`; refuses `--mode/--print/-p/--no-session/--session/-r/--resume/-c/--continue/--fork` in user args; `--provider` requires `--model`; throws unless `fullAccess` (`:41-43`, default true: `rpc-launch-resolution.ts:171`). Env: caller identity keys deleted, `PI_CODING_AGENT_DIR` set to the "account home" (`rpc-launch-resolution.ts:137`); `envToDelete` strips `ORCA_PANE_KEY`, launch token, hook keys so the child is not mistaken for a terminal pane.
- Version gate: stable Pi >= 0.84.0 (0.x) or >= 1.0.0 because `agent_settled` (after retries and detached compaction) first appears in 0.84.0; older Pi falls back to the terminal (`rpc-launch-resolution.ts:39-48`); probed again at every launch. CI pins `@earendil-works/pi-coding-agent@0.84.2` (`.github/workflows/pi-provider-runtime.yml`).
- Session continuity: Orca keeps only a pointer (`providerHandleChain`, transport `jsonl-rpc`, `nativeId` = absolute Pi session file). On resume it reads the `session` header line (first 64 KiB) of the `.jsonl`; same cwd -> `--session file`, different cwd (worktree moved) -> `--fork file`; missing file -> marks `unsaved`/`restore-failed` (`rpc-launch-resolution.ts:72-159`). After start it requires the returned file equals the requested one (`:187-199`).
- Commands used: `get_state` (Zod `piRpcStateSchema`: model, thinkingLevel, sessionFile, isStreaming, isCompacting, pendingMessageCount), `get_available_models`, `set_model {provider,modelId}`, `set_thinking_level {level}`, `get_commands` (skill vs command by `source`), `get_session_stats` (context usage), `compact`, `abort` (2 s timeout) (`rpc-options.ts`, `rpc-session.ts:150-192`, `rpc-session-adapter.ts:162-175`, `rpc-compaction.ts`). Thinking levels `off..max`; `xhigh`/`max` only if the model's `thinkingLevelMap` lists them (`rpc-options.ts:35-39,60-73`). Model catalog also probed with `pi --list-models` (`rpc-model-catalog-probe.ts:55-57`).
- Prompting (`rpc-turns.ts:61`, `rpc-prompt-delivery.ts`): `prompt` frames carry `streamingBehavior: 'steer'` while a turn is active else `'followUp'` (Pi capability `steering: 'inject'`, `rpc-agent-definition.ts:5-13`). Prompt acknowledgements can be idless and FIFO, may wait indefinitely behind extension dialogs; queue caps 128 pending / 32 MiB; a `No API key found for` reply is retried up to 8 times at 250 ms before surfacing "not signed in".
- Turn state machine (`rpc-turns.ts:105-197`): `agent_start` (rejects unsolicited runs), `message_*`, `tool_execution_*`, `turn_end` (refresh stats), `agent_settled` -> idle probe, `compaction_*`/`auto_compaction_*` (blocks idle), `auto_retry_*`. Idle = `!isStreaming && !isCompacting && pendingMessageCount===0` re-verified by `get_state` with 3 attempts 100 ms apart, invalidated by a revision counter when new input or compaction races it (`rpc-protocol.ts:24-26`, `rpc-idle-check.ts:16-48`).
- Extension UI: `extension_ui_request` with `confirm|select|input|editor` -> journal `request.open` rows (`approval` yes/no; `question` with options/free text); decoration methods (`notify,setStatus,setWidget,setTitle,setEditorText`) ignored; unknown dialogs auto-cancelled; answers produce `extension_ui_response {id, confirmed|value|cancelled}`; caps 64 dialogs / 8 MiB; all cancelled on idle/stop/exit (`rpc-dialog-callbacks.ts`, `rpc-extension-dialogs.ts`). Gated by client capability `PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY` (`rpc/methods/structured-agent-session-policy.ts:35-60`).
- Messages -> timeline: `text_delta|thinking_delta` coalesced per content index, tool events keyed by `toolCallId`, 128 open messages / 1 MiB tool bytes caps (`rpc-messages.ts`); usage events become `context.usage` (`rpc-context-usage.ts`).
- Capabilities declared: rewind false, compact true, threadGoal false, contextUsage true, imagePrompts true, steering inject, approvalEnforcement provider (`rpc-agent-definition.ts`).
- If Pi lists zero models, session is flagged `notSignedIn` (a sign-in needs a new Pi process) (`rpc-session-adapter.ts:241-249`).
- CI proof against the real package: `pi-provider-runtime.yml` (Pi 0.84.2, extension-provided model generation before/after, 3 OSes) and `pi-owner-runtime.yml` (Pi 0.83.0 loader, "real owner exit and hook delivery" via `tests/tools/pi-owner-runtime-smoke.mjs`); relay-side owner env tests in `src/relay/pty-handler-pi-owner-env.test.ts`.

**Pi RPC wire surface actually exercised by Orca** (useful as a checklist against the Pi SDK / `--mode rpc` contract; all frames are one JSON object per line, `type` discriminated):

| Direction | Frame | Notes (file) |
|---|---|---|
| Orca -> Pi | `{type:'get_state', id}` | reply `data`: `model{id,provider,name,contextWindow,reasoning,input}`, `thinkingLevel`, `sessionFile` (required, absolute), `sessionId`, `isStreaming`, `isCompacting`, `pendingMessageCount` (`rpc-protocol.ts:3-26`); request ids are `orca-<n>`, replies must echo `command` (`jsonl-rpc/peer.ts:158,269-290`) |
| Orca -> Pi | `get_available_models`, `set_model {provider, modelId}`, `set_thinking_level {level}`, `get_commands`, `get_session_stats`, `compact`, `abort` | `rpc-options.ts`, `rpc-compaction.ts`, `rpc-session-adapter.ts:173`; `compact` runs with `timeoutMs:null`; an error string `Nothing to compact (session too small)` is downgraded to a warning row |
| Orca -> Pi | `{type:'prompt', message, images:[{type:'image',data(base64),mimeType}], streamingBehavior?}` | images: local paths only, magic-byte sniff must match the extension, <= 5 MiB each, <= 20, <= 20 MiB total, whole frame < 8 MiB (`rpc-prompt.ts:13-20,127-174`) |
| Pi -> Orca | `{type:'response', command:'prompt', success, error?, data:{disposition:'started'/'queued'/'handled', agentInvoked?}}` | idless; consumed FIFO; `handled`/`agentInvoked:false` means a slash command ran without an agent turn (`rpc-protocol.ts:73-84`, `rpc-prompt-delivery.ts:138-141`) |
| Pi -> Orca | `agent_start`, `message_start/update/end` (`assistantMessageEvent{type:text_delta/thinking_delta, delta, contentIndex, partial}`), `tool_execution_start/update/end {toolCallId, toolName, args, partialResult, result, isError}`, `turn_end`, `agent_end`, `agent_settled` | usage on message events feeds context estimate; `stopReason:'error'` + `errorMessage` marks failure (`rpc-turns.ts:116-160`) |
| Pi -> Orca | `compaction_start/end`, `auto_compaction_start/end {result.estimatedTokensAfter, willRetry}`, `auto_retry_start/end {success, finalError}` | retry/compaction suppress idle until `get_state` agrees (`rpc-turns.ts:163-195`) |
| Pi -> Orca | `extension_ui_request {id, method: confirm/select/input/editor/notify/setStatus/setWidget/setTitle/setEditorText, title, message, options<=64, placeholder, prefill}` | reply `{type:'extension_ui_response', id, confirmed/value/cancelled:true}` (`rpc-protocol.ts:86-109`, `rpc-dialog-callbacks.ts`) |

**Edge handling worth knowing:** `agent_start` without an Orca-initiated dispatch is a fatal protocol error (`rpc-turns.ts:117-119`); any invalid message/tool event throws (`rpc-messages.ts`) and fails the whole session by design ("A dialect failure is fatal: continuing would discard session or tool lifecycle evidence", `jsonl-rpc/peer.ts:43`); on exit Orca emits `session.ended` (interrupted), waits up to 2 s for the timeline lane to drain, then publishes the lifecycle event with cause `requested-close|unexpected-exit` (`rpc-session.ts:254-293`).

**(b) Terminal-mode Pi** — Pi launch config `src/shared/tui-agent-config.ts:136-143` (`promptInjectionMode: argv`, draft via env `ORCA_PI_PREFILL` consumed by a bundled `orca-prefill.ts` extension, Windows CSI-u shift-enter). Resume argv `pi --session <transcriptPath>` (`src/shared/agent-resume-argv.ts:37-38`). Orca writes three self-contained extension files into `<PI_CODING_AGENT_DIR>/extensions/` (default `~/.pi/agent/extensions`) with an `@orca-managed-pi-extension` marker; user-owned files with the same name are never overwritten (`src/main/pi/titlebar-extension-service.ts:38,141-205`):
  - `orca-agent-status.ts` — `pi.on(...)` handlers (session_start, before_agent_start, agent_start, tool_call, tool_execution_*, message_end, agent_end, model_select, `ui_prompt_start/end`) POST to the loopback hook with `{paneKey, launchToken, tabId, worktreeId, env, version, payload}`; token + port re-read from an endpoint file (stat/mtime cached) because env is frozen at PTY spawn; latest-only coalescing slot, 1000 ms timeout, never throws into Pi's critical path; session metadata sent only once the session file exists; WSL curl fallback (`agent-status-extension-source.ts`, `agent-status-post-queue-source.ts`, `agent-status-handler-source.ts`).
  - `orca-titlebar-spinner.ts` — braille spinner and needs-input marker (`!`) in the terminal title.
  - `orca-prefill.ts` — pre-fills the editor via `ctx.ui.setEditorText` on startup from env.
- State mapping (`src/shared/agent-hook-listener/providers/pi-family-events.ts:62-85`): `before_agent_start|agent_start|tool_call|tool_execution_*|message_end` -> `working`; `agent_end` -> `done`; ask-user tool call -> `blocked`; `ui_prompt_start` (while a turn runs) -> `waiting`, `ui_prompt_end` -> `done` if idle else `working`. States: `working|blocked|waiting|done` (`agent-status-types.ts:47`).
- Fallback screen rules: `src/main/runtime/agent-state-rules/pi.json` (title `^π - ` means idle, weak, needs quiet) with hooks "authoritative".
- Same Pi family also covers OMP (oh-my-pi) and "prime-agent" (`src/shared/pi-agent-kind.ts`), with subagent roster snapshots (`agent-status-subagent-roster-source.ts`).

**(c) Other Pi touchpoints:** one-shot generation (commit message, PR text, conversation name) runs `pi --print --no-session --no-tools --no-skills --no-context-files --mode text [--model] [--thinking]` with prompt on stdin (`src/shared/commit-message-agent-specs-primary.ts:218-241`); session history scan reads `~/.pi/agent/sessions` through `piParser` into the AI Vault with FTS5 search (`src/main/ai-vault/remote-session-scanner-source-parsers.ts:25-70`); hibernation lists Pi as resumable (`docs/site/content/docs/agents/hibernation.mdx`).

### 4.3 Supervision, isolation, restart, kill
- `spawnManagedProviderProcess` wraps every structured child (`src/main/provider-process/managed-provider-process.ts`): on POSIX it runs the child under a tiny Node supervisor script (`provider-process-supervisor.ts:22-170`): detached process group, owner death detected by `process.ppid !== ownerPid` poll every 100 ms, stdin-end grace 1 s -> SIGTERM group -> 3 s -> SIGKILL -> reap wait 1.5 s (constants `:3-19`); spawn failures reported via a marked stderr line + exit 127; stderr tail 8 KiB always drained; output drain 1 s after exit.
- Close verdict vocabulary: `root: exited|unverifiable|…` and tree verdict; "loss of contact is never evidence of process death" (`AGENTS.md` "SSH Use Case"); unproven exits make acquisition fail as `ExitUnproven` and the adapter retains the failed connection so a retry cannot start a second child (`rpc-session-adapter.ts:108-127`).
- `JsonlRpcAgentConnection` keeps transport closure separate from process exit evidence; EOF waits 250 ms for the exit code carrying import/startup errors; stdout drain 1 s because descendants can inherit stdout (`jsonl-rpc/agent-connection.ts:50-75,111-125`).
- Fencing: every structured session has a monotonically increasing `fence` and a per-acquire `generation` UUID; adapter methods throw "not live under this fence" for stale callers (`rpc-session-adapter.ts:294-300`); late settlements are routed via `followUps.onDispatchSettledLate`.
- Restart/recovery: lease renewer, restart reconciliation, dead-generation settlement, interrupted-continuation, recovery capsule (`src/main/native-chat/agent-session-wire/structured-agent-session-*.ts`, `src/main/runtime/agent-session-recovery-capsule*.ts`).
- PTY side: daemon adoption/handover, endpoint-ownership protocol (link-then-rename, never unlink a name you did not create; `src/main/daemon/AGENTS.md`), respawn throttle, recovery budget, native-pty-exception handling, systemd scope escape, macOS login-session death watch.
- Idle reclaim: "Agent hibernation" (off by default) kills done+idle resumable agent terminals after a window (default 30 min, 1 min-24 h) with strict eligibility (no keystroke, no mobile driver, no unsettled orchestration dispatch, no live subagents) and relaunches with resume flags (`docs/site/content/docs/agents/hibernation.mdx`).
- Workspace trust pre-seeded per agent (cursor, copilot, codex, claude files) so TUI "trust this folder?" menus do not swallow injected prompts; writes are bounded (20 s on the shared Codex config lane, 1.5 s elsewhere) and fail closed: past the deadline the launch proceeds untrusted and the agent asks itself (`src/main/agent-trust-presets.ts`, `agent-workspace-trust.ts`, `agent-trust-write-deadline.ts:15-21`).

### 4.4 State detection summary
| Source | Used for | Files |
|---|---|---|
| Agent hooks / extensions -> loopback server | authoritative working/blocked/waiting/done, tool, prompt, model, subagents | `src/main/agent-hooks/server/*`, `src/shared/agent-hook-listener/*` |
| Structured RPC events | turn open/close, outcome success/failure/cancellation, dialogs, context usage | `src/main/pi/rpc-turns.ts` |
| Screen/title rules (JSON, live-updatable bundle) | fallback readiness/blocked/idle; "quiet" gating | `src/main/runtime/agent-state-rules/*.json`, `agent-state-rules-engine.ts` |
| Process presence | foreground agent detection, adopted PTYs | `src/main/runtime/agent-detection-*`, `src/shared/terminal-title-agent-type.ts` |
| Interrupt fallback | synthesize a final `done` when an agent misses its cancel hook | `agent-status-types.ts:1-3`, `server-cancel-verdict-latch.ts` |
The execution host owns one status store (hook server); sidebar, `worktree ps`, mobile, dashboard subscribe (`AGENTS.md` "Agent Status"). Rules that read what an agent paints on a terminal "must be written against a captured transcript, not a remembered screen" (`AGENTS.md` "Agent Terminal Screens", `config/scripts/capture-agent-pty-transcript.mjs`).

### 4.5 Differences to keep in mind when comparing with pi-web's in-process model (partly inferred)
- Orca runs one `pi --mode rpc` child per chat (inferred cost: one Node process + one extension load per chat) in exchange for crash containment, per-chat env (`PI_CODING_AGENT_DIR` as "account home"), a launch-time version probe and kill ladder. pi-web (per its `AGENTS.md`) creates `AgentSession` in-process, so a hung tool or leaked handle shares the daemon's fate.
- Orca keeps no Pi transcript of its own for terminal Pi and reads Pi's `.jsonl` lazily; for structured Pi chats it writes its own journal rows from RPC events and keeps only the session-file pointer for resume. No branch/tree navigation is surfaced (Pi `rewind: false`).
- `extension_ui_request` handling matches pi-web's principle (confirm/select/input/editor answered through the same response frame) but Orca silently drops `notify/setStatus/setWidget/setTitle/setEditorText` in the chat view and keeps them only in terminal mode; a dialog shape it does not know is auto-cancelled (`rpc-dialog-callbacks.ts:22-35`). Older clients are shielded with a capability flag instead of a UI downgrade.
- Pi's `agent_settled` (>= 0.84.0) is the pivot of Orca's idle logic; code before it (e.g. 0.73.x) is explicitly unsupported for chat and falls back to the terminal, so Orca never has to guess idleness from `agent_end` alone (`rpc-launch-resolution.ts:39-41`).

---

## 5. Persistence

| Store | Engine / format | Where | Notes |
|---|---|---|---|
| Profile state (projects, worktree meta, settings, UI, automations, SSH targets...) | `node:sqlite` DB with `profile_state_documents(domain, payload JSON, domain_version, revision, updated_at, content_hash)` + `profile_state_meta` + `automation_runs` tables, schema v3 | `src/main/persistence/profile-state/profile-state-database-schema.ts:8-37` | Dedicated writer worker thread (`profile-state-writer-*`), backup worker with rotation, quarantine + recovery command + startup recovery dialog, legacy `orca-data.json` import (`legacy-json/`, `loading-store/user-data-path.ts:1-30`) |
| Chat journal | one SQLite file `agent-session-journal.db`, WAL, `synchronous=FULL`, busy 5 s, size limit 32 MiB, `PRAGMA user_version` = 4 | `src/main/native-chat/agent-session-journal/journal-database*.ts` | `journal_rows(session_id, epoch, seq, ts, row_json)` append-only; `agent_session_records/operations/retired_claim_keys/tabs`, queued messages, command receipts, attachment claims. A newer schema opens read-only; changes are additive only; version read before any pragma/DDL |
| Orchestration | SQLite (`runtime/orchestration/db/*`) | runs, tasks, dispatches, messages, gates, mutation receipts, federation | 0600 file perms (`database-file-permissions.ts`) |
| Session search | SQLite FTS5 (bm25, identifier splitting, snippets `[[ ]]`) | `src/main/ai-vault-search/session-search-*.ts` | Out-of-process service, parse cache persisted |
| Terminal | daemon checkpoints + headless xterm snapshots | `src/main/daemon/daemon-pty-checkpoint-*.ts`, `cold-restore-*.ts` | Scrollback restore after restart |
| Device registry, E2EE keypair | JSON, hardened perms (`writeSecureJsonFile`) | `<userData>/…` via `runtime/device-registry.ts`, `e2ee-keypair.ts` | Refuses to regenerate keypair if unreadable ("would invalidate every paired device") |
| Secrets | Electron `safeStorage` (OS keychain) sealed blobs | `src/main/host/electron-secret-store.ts`, `credentials/encrypted-api-key-file-store.ts` | Reports protection gaps (Linux `basic_text`) |
| Agent transcripts | **not copied**: each agent keeps its own (`~/.pi/agent/sessions/*.jsonl`, `~/.claude/...`); Orca stores a pointer + decodes lazily (`native-chat/transcript-*`, per-agent line decoders) or its own journal for structured chats | | Incremental tail reader, watch engine, WSL/SSH FS gates |
| Logs / diagnostics | NDJSON rotating sinks, crash breadcrumbs, minidump handling | `src/main/observability/*`, `crash-reporting/*`, `daemon/daemon-file-log.ts` | |
| Data dir | Electron `userData` (Linux `~/.config/Orca`, inferred from the app name); headless: `$ORCA_USER_DATA` or `$XDG_DATA_HOME/Orca` or `~/.orca` | `orcad/orcad-app-paths.ts:21-30` | |
Migration style: version fields + additive schema; orcad migration manifest + digest (`persistence/migrating-orcad-catalog/`); "normalize-loaded-*" adapters on read.

---

## 6. Error handling and reliability

- Typed failure facts instead of strings: `agentSessionFailureFact(kind, {detail})` + `agentSessionFailureWords(fact, {agentName, surface})` (e.g. `notSignedIn`, `providerRejected`, `queueFull`, `attachmentUnreadable`) (`src/shared/agent-session-failure*.ts`, used in `pi/rpc-prompt-delivery.ts:27-32`).
- Dispatch outcomes are a 4-way union `admitted | accepted | rejected | unknown`; "unknown" is never retried blindly (`rpc-prompt-delivery.ts:76-80`).
- Bounded everything: line sizes (8 MiB), write queues (32 MiB), pending requests (128), per-call timeout 30 s (`jsonl-rpc/peer-limits.ts:14-17`), tool stream caps, dialog caps, WS caps, stdout tails, regex-safety for rule JSON (`agent-state-rule-pattern-safety.ts`).
- Retry/backoff: SSH ladder; relay recovery table with full jitter; idle probe 3x/100 ms; Pi `notSignedIn` prompt retry 8x/250 ms; GitHub `gh` rate-limit breaker (`src/main/git/gh-rate-limit-breaker.ts`, `github/rate-limit.ts`); PR refresh queue with pacing and validation backoff (`github/pr-refresh-*.ts`); automation per-record isolation.
- Watchdogs: main-thread hang watchdog in a worker with a marker consumed on next start (`src/main/hang-watchdog/`), renderer recovery circuit breaker, process-gone classification, low-commit OOM gate, GPU fallback (`crash-reporting/`).
- Logging: scoped structured logger (`StructuredAgentSessionLogger`, scope + sessionId), rotating NDJSON sink, tracer spans (`observability/tracer.ts`), diagnostic bundle upload only on explicit user action; secret redactor with 5 rule families run at sink-write, bundle-collection and server-ingest (`observability/redactor.ts:1-45`).
- Telemetry: PostHog only in official CI builds (compile-time substitution of `null` otherwise), anonymous random ID, consent resolver honors `DO_NOT_TRACK`, `ORCA_TELEMETRY_DISABLED`, CI vars; burst cap before consent check (`telemetry/client.ts:1-40`, `electron.vite.config.ts` comment, `docs/site/content/docs/telemetry.mdx`). Error-tracking lane is import-isolated from product telemetry (`observability/index.ts:1-30`).
- Metrics/health: `orcad-health.ts`, `orcad-observability.ts`, daemon health/heartbeat; no Prometheus endpoint found (inferred absent).
- Reliability governance: `config/reliability-gates.jsonc` (gates with invariant, oracle, commands, covered platforms/providers, maturity `experimental|soak|blocking`, promotion needs >=100 soak runs and 14 days with 0 unexplained flakes) checked by `check:reliability-gates`; ratchets for max-lines, ts-nocheck (170 baseline lines), runtime-electron imports, process-host imports.

### Consolidated limits and timers seen in the code (for sizing pi-agentic-platform defaults)
| Where | Limit | Source |
|---|---|---|
| JSON-lines RPC to agent | line 8 MiB, write queue 32 MiB, pending 128, request timeout 30 s | `jsonl-rpc/peer-limits.ts:14-17` |
| Pi prompt queue | 128 pending, 32 MiB held, retry `notSignedIn` 8 x 250 ms | `pi/rpc-prompt-delivery.ts:56,102` |
| Pi dialogs | 64 pending, 8 MiB | `pi/rpc-dialog-callbacks.ts:38-44` |
| Pi message/tool streams | 128 open messages, 128 open tools, 1 MiB tool bytes | `pi/rpc-messages.ts` |
| Pi `abort` | 2 s timeout; idle probe 3 tries x 100 ms; exit drain 2 s | `rpc-session-adapter.ts:173`, `rpc-idle-check.ts`, `rpc-session.ts:271` |
| Supervisor ladder | stdin-end 1 s, SIGTERM 3 s, reap 1.5 s, output drain 1 s (max stop 5.5 s) | `provider-process-supervisor.ts:3-19` |
| Unix-socket RPC | 1 MiB msg, 32 conns, 30 s idle, 10 s keepalive | `unix-socket-transport.ts:9-12` |
| WebSocket RPC | 1 MiB msg, 128 conns, 256 raw TCP, 10 s pre-auth, 15 s ping | `ws-transport.ts:13-26` |
| E2EE | 10 s handshake, 5 consecutive decrypt failures | `e2ee-channel.ts:25-26` |
| Terminal JSON frames | 8 MiB, 256K structural tokens, depth 32 | `shared/terminal-stream-protocol.ts:5-9` |
| Hook post from Pi extension | 1000 ms timeout, latest-only slot | `agent-status-extension-source.ts:143` |
| Device registry lastSeen | coalesced 250 ms (a secure-file rewrite costs 2 PowerShell spawns on Windows) | `device-registry.ts:~80` |
| SQLite journal | busy 5 s, WAL <= 32 MiB, `synchronous=FULL` | `journal-database.ts` |
| Automation tick | 60 s | `automations/service.ts` |
| Workspace trust writes | 20 s (shared Codex lane) / 1.5 s | `agent-trust-write-deadline.ts` |
| Hibernation | default idle 30 min (1 min-24 h) | `docs/.../hibernation.mdx` |
| Plugin worker | invoke/ready timeouts, 64 pending events, 2 s shutdown grace, 5 min event timeout | `plugins/plugin-host-process.ts:17-22` |

---

## 7. Security

- **Local CLI**: Unix socket / named pipe chmod 0600, owner scope; `authToken` field on requests (`rpc/core.ts:44-56`, `unix-socket-transport.ts`).
- **Paired devices**: per-device revocable tokens in a 0600 JSON registry (`device-registry.ts:1-5,21-44`), `scope: mobile|runtime`, `grants` (only `desktop-control` is grantable, decided at pairing time: `rpc-method-permission.ts:24-27`), `pairingReach` ("This computer only" vs network), push registration persisted. `orca serve` flags: `--pairing-address`, `--mobile-pairing`, `--no-pairing`, `--grant-desktop-control` (`src/cli/specs/serve.ts`). Default advertised address is loopback; wildcard binds are never advertised (`pairing-endpoint.ts:21-27`).
- **Caller scopes** deny-by-default: `owner | mobile (explicit method allowlist) | runtime-paired (standard set workspace/settings-write/accounts-admin/skills-admin/host-admin; others need grants) | ssh-bridge (only `workspace` + bound selectors unless target opted in)` (`rpc-caller-scope.ts:22-80`). Seven permission classes: `workspace, desktop-control, accounts-admin, settings-write, skills-admin, pairing-admin, host-admin`. Caller identity is stamped by the transport, never read from params (`rpc-caller-identity.ts:1-12`).
- **Host identity pinning**: the host public key proven by the handshake is the trust root; `hostDescriptor` (installationId, machineBinding) separates reinstall from clone and refuses downgrades (`shared/runtime-host-pairing-identity.ts`). Failure kinds `host-identity-mismatch`, `access-link-invalid`, `protocol-incompatible` (`remote-pairing-verification.ts:6-13`).
- **Transport**: E2EE inside WS regardless of TLS ("auth is per-device tokens, independent of transport encryption", `ws-transport.ts:1`); relay never sees plaintext (E2EE end-to-end through splice). Static web client path allowlist.
- **Hook server**: loopback only, token header, launch-token fence per pane, `isValidPaneKey`, input redaction before posting (`agent-status-input-redaction-source.ts`); "credential references never leave the agent host" comment in handler source.
- **Hook/script trust**: repo `orca.yaml` setup/archive/issue/VM-recipe scripts require approval keyed by content hash (`PersistedTrustedOrcaHooks`, `src/shared/orca-yaml-hook-types.ts:75-90`; `renderer/src/lib/ensure-hooks-confirmed.ts`); `setupRunPolicy: ask|run-by-default|skip-by-default`; runner scripts written to files (not typed into PTYs).
- **Agent permissions**: delegated to each provider. A global "Agent Permissions" mode `yolo | manual | mixed` is translated per CLI into that CLI's own bypass flag/env (`--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--yolo`, kiro `--trust-all-tools`, ... 31 flag entries + 1 env entry in `src/shared/tui-agent-permissions.ts:6-45`); ACP agents get `--always-approve` only when bypass is on (`acp/acp-launch-specs.ts:62-103`); Claude structured launches reserve `permission-mode`, `allowedTools`, `disallowedTools`, `system-prompt*` so user extra args cannot override them (`claude/claude-structured-launch-args.ts:10-27`); Pi structured chat refuses non-full-access (`rpc-launch.ts:41`). No Orca-side sandbox, egress policy or command denylist for agents: a grep of `src/main` and `src/shared` for egress/denylist/blocklist/allowedTools/sandbox returns only reserved-flag lists, plugin-panel sandboxing, Codex trust comments and tests.
- **Plugins**: manifest `capabilities` (workspace:read, terminal:send, notifications:show, storage, events:subscribe...), forked worker with scrubbed env (`plugin-worker-env.ts`), sandboxed panel iframes, append-only `audit.log` of host-API mutations with `actor plugin:<key>`; docs state worker code with raw Node access bypasses audit (`plugins/plugin-audit-log.ts:1-12`). Example hostile panel in `examples/plugins/hostile-panel`.
- **SSH**: `ssh2` with agent/identity-file/FIDO key discovery, OpenSSH config + `ssh -G` resolution, hand-rolled known_hosts verified against OpenSSH 10.2 (revoked-wins, CA, hashed hosts) (`ssh-auth-resolution.ts`, `ssh-known-hosts.ts:1-40`); relay endpoint credential in handshake (exit 43 on mismatch); remote CLI over SSH bridge is `workspace`-only unless `remoteCliControl` opted in.
- **Secrets**: OS keychain via `safeStorage`; telemetry redactor; stdio env scrubbing for children (`resolveProviderChildEnv`: inherit, overlay, strip so delete wins); secure-file helpers with ACL hardening on Windows.
- **Supply chain**: pnpm `minimumReleaseAge: 4320` (3 days), pinned versions, `allowBuilds` allowlist, Windows signing via SignPath, dependabot.

---

## 8. Worktrees and git

- **Creation** (two-phase, background): `prepareWorktreeCreateCheckout` runs `git worktree add --lock` under ref-maintenance pause, verifies lock ownership, finalizes or discards on failure; base ref refresh overlaps checkout; UI shows progress row with cancel/retry (`src/main/git/worktree-create-preparation.ts`, `worktree-preparation-lock.ts`, `worktree-add.ts`, `docs/site/content/docs/model/worktrees.mdx`). Start-from can be base ref, local branch, SHA or remote branch; GitHub/Linear/Jira/GitLab links; smart name field with issue/PR URL parsing (`renderer/src/components/new-workspace/`).
- **Setup scripts**: `orca.yaml` (`scripts.setup`, `scripts.archive`, `issueCommand`, `defaultTabs`, `environmentRecipes`, `worktree.sharedDirectories`) + local/shared command source policy; Orca generates a runner script file per worktree (`.cmd` on Windows unless shebang) (`src/main/worktree-runner-script.ts`, `src/shared/setup-runner-command.ts`); `setupAgentStartupPolicy: start-immediately|wait-for-setup`; repo's own `orca.yaml` runs `node config/scripts/run-internal-dev-setup.mjs; pnpm install`.
- **Dependency duplication handling**: (1) per-repo "Worktree Shared Paths" (APFS clone-copy or symlink), (2) `worktree.sharedDirectories` symlinks for gitignored dirs like `node_modules` (`git/worktree-shared-directories.ts`, 30 s TTL cache, 512 entries cap), (3) `.worktreeinclude` literal gitignored files to copy (`git/worktree-include-file.ts`, 256 KiB / 1000 entries / no globs); status code tolerates the symlinks on delete.
- **Fan-out of one prompt to N agents**: README claims it, but docs describe a manual recipe (create N worktrees, launch an agent in each, paste prompt) (`docs/site/content/docs/recipes/parallel-agents.mdx`); the new-workspace composer takes a single agent (`NewWorkspaceComposerAgentSection.tsx`). Programmatic fan-out is the experimental Orchestration layer (`orca orchestration run-create/task-create/worker-start --worktree new-child --agent X`, `worker_done` with taskId+dispatchId, decision gates, DAGs; `docs/site/content/docs/cli/orchestration.mdx`, `src/main/runtime/orchestration/*`).
- **Diff/compare**: Monaco diff viewer, combined-diff review, branch/commit compare vs start-from ref (`git/source-control/branch-compare.ts`, `commit-compare.ts`, `renderer/src/components/editor/DiffViewer.tsx`, `editor/combined-diff/*`); no cross-worktree "compare N agent outputs side by side" feature found (inferred absent).
- **Review loop**: line comments on diffs batched and sent to an agent (`DiffNotesSendMenu.tsx`, `docs/.../annotate-ai-diff.mdx`); "Fix with AI" for hook failures; Resolve with AI for conflicts; attribution view.
- **Commit/push/PR**: stage, commit (AI message via action recipes), push with explicit force-with-lease action, pull/sync, create PR/MR (GitHub incl. stacked PRs and enterprise, GitLab, Bitbucket, Gitea, Azure DevOps), checks panel, merge state; `gh` CLI based with rate-limit breaker; Git 2.25 baseline with `GitCapabilityCache` per host (`AGENTS.md` "Git Binary Compatibility"; `src/main/github/*` 145 files, `git/git-capability-state.ts`).
- **Tasks**: GitHub issues/PRs/projects, GitLab, Linear (SDK, multi-workspace, MCP-style list), Jira, plus workspace comment/status "checkpoints" set by agents via CLI (`docs/.../worktree-checkpoints.mdx`).
- **SSH remote worktrees**: git runs on the remote via the relay daemon; same UI; browser/terminal parity; host-qualified worktree meta (`persistence/host-qualified-worktree-meta.ts`); WSL support with distro-aware git routing (`git/wsl-*`).
- **Lifecycle extras**: sleep/hibernate, archive, delete with preserved-branch review, workspace cleanup candidates, sparse-checkout presets, folder (non-git) workspaces.

---

## 9. UI architecture

- **Framework/state**: React 19 + one zustand store assembled from 46 slices (`src/renderer/src/store/index.ts:1-120`: repos, worktrees, terminals, tabs, ui, settings, github, linear, agent-status, browser, ssh...). Custom oxlint plugin `app-store-performance/{require-selector,no-identity-selector,no-fresh-selector-result}` forbids unselected store reads (`.oxlintrc.json:13-16,31-33`); dev-only churn probes and listener census (`store-identity-churn-probe.ts`, `store-listener-census.ts`). No router library; navigation is store state (inferred); URL/hash only in web client pairing.
- **Layouts**: worktree sidebar (grouped by project, status pips, sleep/archive), tab groups with arbitrary splits, terminal panes (xterm.js 6, WebGL, ligatures, image addon, search), Monaco editor tabs, markdown/rich editor (TipTap), PDF/image/ipynb viewers, embedded browser tabs, dashboard + kanban popout, Activity page, floating terminal, right sidebar (source control, checks, files, ports).
- **Design system** (`docs/STYLEGUIDE.md`, lint-enforced; canonical tokens in `src/renderer/src/assets/main.css`, 3.4K lines): monochrome neutral "recede and frame" identity; shadcn token pairs (`background/foreground`, `card`, `popover`, `primary #171717/#fafafa`, `secondary/muted #f5f5f5`, `border #e5e5e5`, dark `#0a0a0a` bg, `card #171717`, `editor-surface #1e1e1e`, `border rgb(255 255 255/.07)`); color reserved for state: `--agent-question` orange-600 (agent asking), workspace status tones (`done #c7a594`, `review #16a34a`, `progress #d4a300`), git decoration tokens, git-graph lanes, `ai-action-accent` violet; radius `--radius .625rem`; 3 elevation levels (hairline, `shadow-xs`, `shadow-floating 0 10px 24px/.18`); Geist variable font (100-900), mono stack `SF Mono…`, body letter-spacing 0.01em, 11/12/13/14 px scale; lucide icons only; `ShortcutKeyCombo` chips; `can-hover` variant for touch; chat surface derives tokens via mix percentages (`--chat-*-mix`, max width 46rem) and may use a different scheme than the app (`[data-native-chat-scheme]`).
- **Theming**: light/dark class on root, `theme-transition-disabled` during swaps (no staggered fades), per-surface terminal/chat color schemes, terminal theme import from Warp/Ghostty (inferred from `src/main/warp-themes`, `src/main/ghostty`).
- **Rules worth copying** (`STYLEGUIDE.md` UX rules): feedback by duration (0-100 ms none, 100 ms-1 s disabled, 1-3 s spinner, >3 s stage labels), defer remote spinners ~200 ms but disable immediately, Cancel is never `destructive`, "UI copy must not overclaim", reduced-motion per element.
- **Patterns**: command palette `WorktreeJumpPalette` (cmdk; Cmd-J) + `QuickOpen`; configurable keybinding service with conflict detection, double-tap and keyboard-layout awareness (`src/main/keybindings`, `src/shared/keybinding*`); notifications = native banners + tray attention + 9 bundled sounds + custom sound/volume, suppress-when-focused, per-source mute, burst cooldown (`notifications/notification-delivery-service.ts`, `shared/notification-settings-types.ts`); agent attention model + unread marking; contextual tours and feature wall; embedded browser with "Design Mode" (click element -> HTML/CSS + cropped screenshot to prompt) and markup overlay (`browser-pane/annotate/`); computer-use (desktop control) skill and native helpers.
- **Native Chat UI (structured sessions)**: composer with slash commands/skills, model + effort pills, queued messages with edit/pause, ask/permission cards, tool runs, subagent groups, background tasks, visuals (inline HTML/mermaid frames), history paging (`AGENT_SESSION_HISTORY_DEFAULT_LIMIT=40`, max 200; `shared/agent-session-wire.ts:81-84`).
- **Mobile UX**: host list with multi-host picker, workspace list across hosts, session tab strip with long-press actions, chat or terminal per tab (device default + override), terminal accessory row and "Live" input mode, dictation (on-device sherpa-onnx or host), quick commands synced with desktop, source control (stage/commit), file browser/markdown reader, push notifications with reply schema, android foreground push (`docs/site/content/docs/mobile.mdx`, `mobile/src/notifications/*`, `mobile/src/session/*`). Theme in `mobile/src/theme/mobile-theme`.
- **i18n**: react-i18next, runtime-required English JSON, locale catalogs `en, es, fr, ja, ko, zh` (`src/renderer/src/i18n/locales/`), gettext PO as canonical translation source with extraction + coverage checks in `pnpm lint` (`config/i18n-translation-source.md`).

---

## 10. Testing and quality

- **Unit/integration**: Vitest 5 (`config/vitest.config.ts`), happy-dom for renderer, `pool: forks`; `pnpm test` runs Vitest on Bun (version pinned in `config/.bun-version`) with Node workers for SQLite/pty/socket/V8 contracts, `pnpm test:node` runs all on Node (`.github/CONTRIBUTING.md` Local Setup); setup files guard against writes to real agent homes (`config/scripts/vitest-real-agent-home-write-guard.ts`). ~13.5K unit test files (main 5.6K, renderer 4.7K, shared 1.1K, mobile 0.96K, cloud 0.28K, relay 0.25K).
- **E2E**: Playwright driving real Electron through CDP, headless/background by policy (never steals focus: `ORCA_BACKGROUND_LAUNCH=1`, `src/main/window/foreground-activation-policy.ts`, `tests/AGENTS.md`), 508 specs + golden suites (`test:e2e:*` scripts): session restore, terminal rendering/perf budgets, SSH via Docker (hostile hosts, Windows hosts), WSL, packaged-browser, multi-client navigation, win update/crash survival.
- **Contract/recorded tests**: RPC golden recordings (793 files), cross-version wire job, `pi-provider-runtime.yml` and `pi-owner-runtime.yml` against a real pinned Pi, real-CLI test for Claude structured code (`AGENTS.md` Verifying Changes), transcript captures scrubbed of identifiers (`capture-agent-pty-transcript.mjs`).
- **Performance**: benches for idle CPU, startup, spinner rendering, daemon cold start, zustand selector fan-out (`check:zustand-selector-fanout`), terminal scale reports with budget check scripts, `performance-contracts.yml`.
- **Lint/format**: oxlint (+ type-aware, react-doctor, anti-slop plugin, dead-class, design-system, quadratic-buffer-concat, sort-comparator rules), oxfmt, husky pre-commit `lint-staged`, knip, `check:code-quality:changed` diff-scoped gates; ratchet baselines (`config/*-baseline.txt`).
- **CI** (`.github/workflows`, 85 files): `pr.yml` computes changed-path scopes (docs-only PRs skip matrix), reuses identical successful checks on ready-for-review, sharded unit tests with timing-balanced sequencer, git-compat matrix, xterm patch sync, shell contracts, packaging (mac/win/linux), node-next compat, release cuts (`release-cut.yml`), hourly/daily/adhoc mac+win dev channels, mobile iOS/Android release, 25 `cloud-*` workflows gated off by `vars.ORCA_CLOUD_OPERATIONS_ENABLED`. PR template demands ELI5, before/after, linked issue, visual proof (`.github/pull_request_template.md`).

---

## 11. Build, release, install

- **Artifacts**: macOS dmg (arm64, x64; hardened runtime + notarization), Windows NSIS (SignPath-signed), Linux AppImage (glibc floor 2.31 verified: `verify-linux-glibc-floor.cjs`), Homebrew cask `stablyai/orca/orca` + `orca@rc`, AUR `stably-orca-bin`, iOS App Store/TestFlight, Android APK (GitHub release `mobile-android-v*`) (`README.md:210-232`, `Casks/`).
- **Packaging details**: `extraResources` for relay bundle, orcad template + node_modules, bundled ripgrep (every OS, WSL, SSH), plugins, skills freshness metadata, native-chat visuals; packaged-runtime node_modules closure copied outside asar; Windows daemon-host relocation to `%LOCALAPPDATA%` so updates survive (`config/electron-builder.config.cjs`, `AGENTS.md` Cross-Platform).
- **Channels**: stable, RC, hourly/daily/adhoc dev builds each in own GitHub repo to avoid evicting stable entries from the atom feed (`electron-builder.config.cjs:~65-80`).
- **Auto-update**: `electron-updater` with release feed parsing, rollout flags, install execution, package-recovery for Linux, remote-server update capability (`src/main/updater/*`, `src/shared/remote-server-update.ts`); semver regression guard in `release-cut.yml:4-11`.
- **Headless install**: `orca-ide serve` (Linux CLI name avoids GNOME Orca screen reader clash, `skills/orchestration/SKILL.md`), orcad built as a Node bundle (`build:orcad*`), systemd-friendly (cgroup escape for PTY daemon), instance lock, idle-exit, health.
- **Config/data dirs**: Electron `userData`; `$ORCA_USER_DATA` override; per-agent homes untouched except managed extension/hook files with ownership markers; repo-level `orca.yaml` and `.worktreeinclude`; global CLI skills via `orca skills install`.
- **SSH remote install**: relay JS bundle + pinned Node runtime uploaded under install lock with GC of old runtimes (`ssh-relay-deploy.ts`, `ssh-relay-pinned-node-install.ts`).

---

## 12. Feature map against pi-web domains

Legend: present / partial / absent. Paths are Orca paths.

1. **Sessions and chat streaming, branching/fork, compaction, export — partial.** Structured chat streams `text_delta/thinking_delta/tool_execution_*` from Pi RPC into a SQLite append-only journal with history paging and subscribe/catch-up (`src/main/pi/rpc-messages.ts`, `native-chat/agent-session-journal/*`, `agent-session-wire/*`). Compaction via `compact` + auto-compaction events (`pi/rpc-compaction.ts`). Fork only as `--fork <file>` when a resumed session's cwd differs (`rpc-launch-resolution.ts:154-158`); no in-session branch tree, rewind false for Pi; export is only HTML->PDF for markdown (`preload/api/export-bridge.ts`).
2. **Session sidebar / projects / pins / archive / search / auto-naming — partial (worktree-centric).** Sidebar groups worktrees by project group, pins tabs, sleeps/archives workspaces; session history via "AI Vault" scans every agent's native session files incl. Pi with FTS5 search and resume (`src/main/ai-vault*`, `ai-vault-search/*`); chat auto-name via a generation lane after first prompt (`native-chat/structured-chat-naming.ts`); branch auto-rename after first work (`agent-hooks/first-work-branch-rename.ts`).
3. **Worktrees and parallel lanes (setup scripts, commit/push/PR) — present (core strength).** See section 8: `orca.yaml`, locked two-phase `git worktree add`, shared dirs, `.worktreeinclude`, commit/push/PR/stacked PR (`src/main/git/*`, `github/*`).
4. **File explorer / viewer / uploads / @-mentions — present.** File tree, Monaco, markdown/PDF/image viewers, autosave, drag files into agent prompt, SSH-aware fs provider, attachments upload for chat, `@` mentions in mobile chat composer (`renderer/.../editor/*`, `agent-session-attachments/*`, `src/relay/fs-handler*.ts`).
5. **Git status/diff — present.** Porcelain v1 status with upstream cache, diffs vs base/branch/commit, conflict resolution, submodules, discard (`src/main/git/source-control/*`, `src/relay/git-handler*.ts` for remote).
6. **Terminal — present (best-in-class).** xterm WebGL, splits, daemon-owned PTYs surviving restart, headless snapshot for mobile, flow control opcodes, IME work, perf budgets (`src/main/daemon/*`, `renderer/src/components/Terminal*.tsx`, `shared/terminal-stream-protocol.ts`).
7. **Models / providers / auth / reasoning levels / pricing — partial.** Pi models come from `get_available_models`/`--list-models`, thinking levels from `thinkingLevelMap`, `set_model`/`set_thinking_level` live (`pi/rpc-options.ts`); multi-account hot-swap for Claude/Codex/Grok/Cursor/Antigravity and usage/rate-limit tracking for Claude/Codex/OpenCode/Muse (`*-accounts`, `rate-limits/*`, `usage/*`, `*-usage/`); no usage scanner or pricing for Pi (scanners exist only for Claude/Codex/OpenCode/Muse); API-equivalent cost only for Claude/Codex automation runs (`shared/automations-types.ts:24-52`).
8. **Tool presets / permission modes — partial.** No tool presets or tool allowlists of its own. One global permission mode `yolo | manual | mixed` mapped to each CLI's bypass flag (`src/shared/tui-agent-permissions.ts`), ACP `--always-approve` (`acp/acp-launch-specs.ts:62`), Pi forced full access, workspace-trust pre-seed (`agent-trust-presets.ts`); approval cards rendered for providers that ask, with `approvalEnforcement: 'provider' | 'orca'` declared per agent (`shared/agent-session-capabilities.ts`, `agent-session-approval-subject.ts`).
9. **MCP — absent.** No MCP client/host; Linear access is SDK-based (`src/main/linear/mcp-issue-list.ts` only mimics list shape). Agents use the `orca` CLI instead.
10. **Skills / plugins — present.** Skill discovery, install/update/share bundles, freshness checks, cloud grants, SSH relay install, WSL (`src/main/skills/*`, `skills/*`, `skill-stubs/*`); capability-gated plugin system with panels/commands/events (`src/main/plugins/*`, `examples/plugins/hello-orca`).
11. **Subagents — partial.** Observes subagent rosters per agent (Pi/OMP extension snapshots) and shows child rows (`agent-status-subagent-roster-source.ts`, `AgentChildRowContent.tsx`); Orchestration spawns supervised workers (experimental, `runtime/orchestration/*`).
12. **Long-term persistent agents / inbox / notifications — absent / partial.** No named persistent agent profile with memory or inbox; closest: resumable sessions, hibernation, agent attention feed, dashboard/kanban, workspace comment+status checkpoints (`agent-hooks/server/*`, `renderer/.../dashboard*`, `docs/.../worktree-checkpoints.mdx`).
13. **Automation: task queue, scheduled triggers, webhooks — partial.** Scheduled automations only: RRULE/cron presets, timezone, precheck command, missed-run grace, new-worktree-per-run or existing workspace, SSH owner fencing, run history with usage attribution (`src/main/automations/*`, `docs/.../cli/automations.mdx`); webhooks absent (grep: no webhook ingestion); external schedulers (Hermes cron) mirrored via `external-manager*.ts`.
14. **Memory — absent.** `src/main/memory/` is process-memory telemetry (`collector.ts`), not agent memory; `docs/.../agents/hooks-memory.mdx` only says Orca leaves each agent's `CLAUDE.md`/`AGENTS.md` alone and shows them in the file explorer.
15. **Security policies (sandbox, egress, command denylist, secrets, audit) — partial.** Strong control-plane security (caller scopes, hook-content trust, E2EE, secret store, redactor, plugin audit log, env scrubbing) but nothing that constrains what an agent can do; no sandbox/egress/denylist.
16. **Cost/usage tracking, metrics, health — partial.** Token/cost scanners for Claude/Codex/OpenCode/Muse with rollups, rate-limit windows and account switching (`src/main/usage/*`, `claude-usage`, `codex-usage`); local diagnostics, hang watchdog, orcad health; no Prometheus/OTel export (inferred).
17. **Push notifications / sounds — present.** Desktop banners + tray + sounds + custom audio; mobile push via APNs/FCM gateway with quotas, dismiss reconciliation; per-source mutes (`notifications/*`, `cloud/apps/push`, `mobile/src/notifications/*`).
18. **Extension UI requests (dialogs from agent) — present for Pi.** `extension_ui_request confirm/select/input/editor` mapped to approval/question cards; answered with `extension_ui_response`; decoration calls dropped; capability-gated for older clients (`pi/rpc-extension-dialogs.ts`, `rpc-dialog-callbacks.ts`). Terminal mode instead tracks `ui_prompt_start/end` depth to flag `waiting`.
19. **Mobile / PWA — present (native app, not PWA).** Expo iOS/Android app + browser web client served by the host + relay; no service worker or web manifest found under `src/renderer` (inferred: not an installable PWA) (`mobile/`, `vite.web.config.ts`, `src/renderer/src/web/*`).
20. **Settings UI — present.** Large settings panels per area (repository hooks, agents, notifications, SSH, shortcuts, experimental, privacy), searchable settings entries, per-repo overrides (`renderer/src/components/settings/*`).
21. **App update / install — present.** Auto-update with channels, remote-server update RPC, Linux package recovery, CLI install helper (`src/main/updater/*`, `preload/api/cli-install-api.ts`).

### Orca features that fit none of the domains
- Embedded Chromium browser with CDP automation, profiles, cookie import, Design Mode and screencast to phone (`src/main/browser/*`, 41K LOC).
- Computer Use (OS-level desktop control) for agents on macOS/Windows/Linux (`src/main/computer`, `native/computer-use-*`, skill `computer-use`).
- SSH remote runtime (relay daemon, pinned Node, port forwarding, WSL, VS Code Remote hand-off) (`src/main/ssh`, `src/relay`).
- Android emulator/iOS simulator control and mirroring (`src/main/emulator`, skills `orca-emulator*`).
- Ephemeral per-workspace VM recipes (`orca.yaml environmentRecipes`, `ephemeral-vm-*`).
- GitHub/GitLab/Bitbucket/Gitea/Azure DevOps/Linear/Jira task and review integrations (~35K LOC).
- Agent-facing `orca` CLI (worktree, terminal read/send/wait, browser, orchestration) and bundled version-matched skills (`src/cli`, `skills/`).
- Dictation (speech-to-text on device), notebook (ipynb) runner, workspace ports panel, workspace space/disk cleanup, activity page, "pets" (`preload/api/pet-bridge`), star nag.
- Cross-agent account manager (Claude/Codex/Grok/Cursor/Antigravity accounts, hot swap) (`src/main/*-accounts`).

---

## 13. Borrow / avoid

### Top 10 to borrow
1. **Pi RPC adapter pattern** — `src/main/pi/rpc-*.ts` + `src/main/jsonl-rpc/{peer,agent-connection,peer-limits}.ts`. Concrete: version floor probe at each launch, `agent_settled` + `get_state` idle probe with revision invalidation, `streamingBehavior` steer/followUp, idless prompt-ack FIFO, 4-way dispatch outcome, dialog mapping with caps, session-file pointer + `--session/--fork` by cwd. Why: a complete, field-tested reference of what `pi --mode rpc` offers; useful if pi-web ever wants process isolation or per-lane child processes instead of in-process `AgentSession`.
2. **Supervised child-process ladder** — `src/main/provider-process/*`, `src/packages/process-host/src/process-tree-termination.ts`. Why: no orphaned agent trees after daemon crash (ppid watchdog, process-group TERM->KILL, spawn-failure marker, 8 KiB stderr tail, exit-proof vocabulary `exited|unverifiable`).
3. **Pi status extension -> loopback hook with fenced identity** — `src/main/pi/agent-status-*.ts`, `shared/agent-hook-listener/providers/pi-family-events.ts`. Why: authoritative working/blocked/waiting/done without scraping; patterns: latest-only coalesced post, 1 s timeout, endpoint file re-read, managed-file marker that refuses to overwrite user files, launch-token + pane-key fence.
4. **Mandatory per-method permission class + deny-by-default caller scopes + generated params catalog** — `rpc/core.ts`, `rpc-method-permission.ts`, `rpc-caller-scope.ts`, `generate-rpc-params-catalog.mjs`. Why: security-by-default for every new route; drift between schema registry and docs/clients is a CI failure.
5. **Device pairing with per-device revocable tokens, grants and host-key pinning** — `runtime/device-registry.ts`, `shared/mobile-relay-pairing-offer.ts`, `shared/runtime-host-pairing-identity.ts`, `unpaired-device-auth-throttle.ts`. Why: fits a self-hosted daemon reachable over Tailscale/reverse proxy; E2EE v2 key schedule (`mobile-e2ee-v2-key-schedule.ts`) is optional if TLS is terminated properly.
6. **Host serves its own web client; one renderer, two shells** — `static-web-client-handler.ts`, `vite.web.config.ts`, `src/renderer/src/web/preload-api`, `rpc/methods/mobile-web-bundle.ts`. Why: UI always version-matched to the daemon; the PWA/web build re-implements the preload API over RPC so desktop and browser share components.
7. **Append-only SQLite journal + idempotency ledger + fences** — `native-chat/agent-session-journal/journal-database*.ts`, `shared/agent-session-operation-ledger.ts`, `rpc/methods/agent-session.ts:50-55`. Why: reconnect-safe transcripts and exactly-once mutations; `user_version` read first, newer schema opens read-only, additive-only schema rule.
8. **Worktree creation as locked two-phase transaction + dependency sharing** — `git/worktree-create-preparation.ts`, `worktree-preparation-lock.ts`, `worktree-shared-directories.ts`, `worktree-include-file.ts`, `orca.yaml` hook trust by content hash. Why: parallel lanes without half-made worktrees or duplicated `node_modules`; setup scripts run from a generated file with an explicit trust prompt.
9. **Scheduler semantics** — `automations/service.ts`, `precheck-runner.ts`, `dispatch-refusal.ts`, `shared/automations-types.ts`. Why: RRULE + timezone, precheck gate with bounded output, missed-run grace, repeat-skip dedupe so a refusing */5 job cannot flood history, dispatch-generation counter to cancel in-flight work, only final statuses evictable.
10. **Agent-facing CLI + stub skills with binary-served guides + CI ratchets** — `skills/*/SKILL.md` (discovery stub), `orca skills get <name>`, `src/cli/*`; ratchets (`config/max-lines-baseline.txt`, `ts-nocheck-baseline.txt`, `reliability-gates.jsonc`, custom oxlint plugins). Why: skills cannot drift from the running binary; quality gates are measurable and only tighten.

Honorable mentions: JSON screen-rule bundles with live update (`agent-state-rules/*`), secret redactor with 3 enforcement points (`observability/redactor.ts`), hibernation eligibility rules, STYLEGUIDE UX timing rules, SSH reconnect ladder bounded by remote grace, wire-compat discipline (capability negotiation, frozen opcodes, goldens).

### Top 5 weaknesses / avoid
1. **Scale and sprawl.** ~2.27M non-test LOC, 680 RPC methods plus 772 IPC handler sites (two parallel API surfaces that the web build must re-implement: `src/renderer/src/web/preload-api`), 1,687 non-test files in `src/main/runtime`, single files up to 377 KB (`cloud/apps/relay/src/assignment-store.ts`), 146 KB (`src/relay/pty-handler.ts`), 138 KB (`src/main/ssh/ssh-relay-session.ts`). `AGENTS.md` forbids `max-lines` disables, yet 39 non-test sources mention `max-lines` and `ssh-relay-deploy.ts:1` carries `eslint-disable max-lines`; 170 files on the `@ts-nocheck` baseline. Test code outweighs product code (~2.95M vs ~2.27M LOC), a maintenance cost a small team cannot copy.
2. **No policy layer over what the agent does.** Pi chat hard-requires full access (`rpc-launch.ts:41-43`, default `true` in `rpc-launch-resolution.ts:171`); other providers just get a bypass flag from a `yolo|manual|mixed` switch (`tui-agent-permissions.ts`); no egress allowlist, command denylist, sandbox or per-agent secret vault in `src/main` or `src/shared`. The pairing QR embeds the bearer `deviceToken` (`pairing.ts:15-31`), so the link itself is a credential. Security is about who may drive Orca, not what agents may do.
3. **Desktop-first architecture retrofitted into a server.** `orcad` re-hosts Electron-shaped code behind an `AppEnvironment` shim (`orcad-app-paths.ts`, `check:runtime-electron-ratchet`, `config/runtime-electron-baseline.txt`), needs native modules per OS (node-pty, sherpa-onnx, parcel watcher) and a long packaging verification suite; daemon survival depends on systemd scope tricks (`daemon-cgroup-scope.ts`). For a Linux-only daemon this is avoidable weight.
4. **Cloud relay is a large operational liability.** `cloud/` is 59K LOC of director/cell/fence-broker/ops plus 25 deploy workflows that are inert unless the owner sets `vars.ORCA_CLOUD_OPERATIONS_ENABLED`; auth/API services live in a private repo (`cloud/README.md`). The relay design (assignment epochs, regional rehoming, Terraform fencing) is far beyond what a self-hosted platform on Tailscale needs.
5. **Pi coverage is deep but narrow, and docs/marketing lag the code.** Pi structured chat: no rewind (`rpc-agent-definition.ts`), requires Pi >= 0.84.0, usage/cost tracking only for Claude/Codex (`automations-types.ts:24`), no MCP, no agent memory (the `memory` module is RAM telemetry), no webhook triggers, no persistent named agents. Docs for Chat UI list only Claude/Codex/Grok/OMP transcript decoding (`docs/site/content/docs/agents/native-chat.mdx:8`) and the README's "fan one prompt across five agents" is a manual recipe (`recipes/parallel-agents.mdx`) or the experimental orchestration CLI.

---

## Appendix: where to read first (by topic)

| Topic | Start here |
|---|---|
| Pi chat over RPC | `src/main/pi/rpc-session-adapter.ts`, `rpc-turns.ts`, `rpc-launch-resolution.ts`, `rpc-prompt-delivery.ts`, `rpc-dialog-callbacks.ts`, `rpc-protocol.ts` |
| Generic stdio JSON-lines peer | `src/main/jsonl-rpc/peer.ts`, `agent-connection.ts`, `timeline-lane.ts` |
| Child supervision / kill ladder | `src/main/provider-process/provider-process-supervisor.ts`, `managed-provider-process.ts`, `provider-process-close.ts`; library `src/packages/process-host/src/process-tree-termination.ts` |
| Pi in a terminal | `src/main/pi/agent-status-extension-source.ts`, `agent-status-handler-source.ts`, `titlebar-extension-service.ts`; `src/shared/agent-hook-listener/providers/pi-family-events.ts`; `src/main/runtime/agent-state-rules/pi.json` |
| Hook server and status store | `src/main/agent-hooks/server.ts`, `server/*`; `src/shared/agent-status-types.ts` |
| RPC core / permissions | `src/main/runtime/rpc/core.ts`, `dispatcher.ts`, `rpc-method-permission.ts`, `rpc-caller-scope.ts`, `rpc-caller-identity.ts`, `methods/index.ts` |
| Pairing / E2EE | `src/shared/pairing.ts`, `mobile-relay-pairing-offer.ts`, `src/main/runtime/device-registry.ts`, `rpc/e2ee-channel.ts`, `rpc/mobile-e2ee-v2-*.ts`, `rpc/mobile-socket-wiring.ts` |
| Headless server | `src/main/orcad/orcad-entry.ts`, `orcad-lifecycle.ts`, `src/cli/specs/serve.ts`, `src/main/server/serve-pairing-*.ts` |
| Web client | `vite.web.config.ts`, `src/renderer/src/web/*`, `rpc/static-web-client-handler.ts`, `rpc/methods/mobile-web-bundle.ts` |
| Terminal daemon | `src/main/daemon/daemon-entry.ts`, `daemon-endpoint-ownership.ts`, `AGENTS.md` in that dir |
| Chat journal | `src/main/native-chat/agent-session-journal/journal-database-schema.ts`, `journal-store.ts`, `agent-session-wire/structured-agent-session-host.ts` |
| Profile state | `src/main/persistence/profile-state/profile-state-database-schema.ts`, `profile-state-sqlite-authority.ts` |
| Worktrees | `src/main/git/worktree-*.ts`, `src/main/worktree-runner-script.ts`, `src/shared/orca-yaml-hook-types.ts`, `docs/site/content/docs/model/worktrees.mdx`, `orca-yaml.mdx` |
| Automations | `src/main/automations/service.ts`, `precheck-runner.ts`, `src/shared/automations-types.ts`, `docs/site/content/docs/cli/automations.mdx` |
| Orchestration | `src/main/runtime/orchestration/*`, `docs/site/content/docs/cli/orchestration.mdx`, `skills/orchestration/SKILL.md` |
| Plugins | `src/main/plugins/*`, `examples/plugins/hello-orca/orca-plugin.json` |
| SSH remote | `src/main/ssh/ssh-relay-deploy.ts`, `ssh-relay-session.ts`, `ssh-reconnect-ladder.ts`, `src/relay/relay.ts`, `protocol.ts` |
| Design system | `docs/STYLEGUIDE.md`, `src/renderer/src/assets/main.css`, `src/renderer/src/components/ui/*` |
| Quality gates | `config/reliability-gates.jsonc`, `config/*-baseline.txt`, `.oxlintrc.json`, `.github/workflows/pr.yml`, `AGENTS.md` |
