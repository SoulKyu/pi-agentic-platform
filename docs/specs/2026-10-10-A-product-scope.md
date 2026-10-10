# Spec A: product and scope

Status: draft for review · Date: 2026-10-10 · Sources: [decisions log](../research/decisions-log.md), [feature matrix](../research/feature-matrix.md), [pi-web inventory](../research/pi-web-inventory.md).

## 1. What it is

pi-agentic-platform (`pap`) is a self-hosted agentic platform built on the Pi coding agent. It replaces the author's pi-web fork with a new codebase, a new brand and a new architecture. It keeps every pi-web feature and adds the best patterns found in T3 Code and Orca.

One always-on daemon runs on a personal machine or VPS. The web UI (installable PWA) reaches it from a desktop browser or a phone. Pi is the only agent harness and is integrated deeply.

## 2. Audience and goals

- **v1: personal**, single owner, built to public-product standard so that other people can install and run it (decision 1).
- **Teams come early on the roadmap.** Root entities carry `owner_id` and `workspace_id` from day one. Permissions are sets of `domain:read|operate|admin` strings, so roles are a later addition, not a rewrite.

### Problems this must fix (decision 2)

- **Codebase sprawl.** pi-web is ~146k lines of TypeScript with a flat `lib/` of 150+ files.
- **Reliability and isolation.** pi-web runs every Pi session in-process, so one crashing session or extension can take the server down.

### Success criteria

1. A crashing Pi session, extension or tool cannot kill the daemon or another session.
2. Every feature lives in one bounded module behind a typed contract. CI rejects any file over 400 lines and any import that crosses module boundaries.
3. A stranger installs it in one step (archive, container or npm) and gets a working, secure instance: localhost bind, one-time setup URL, passkey.
4. Every feature marked KEEP / ADOPT / ADAPT in the feature matrix works in v1, plus the v1 additions of §5.2.

## 3. Principles

- **Pi only, deep integration** (decision 5). No multi-harness adapter layer. Extensions written for the Pi CLI behave the same here. Display gaps are fixed in the client, never by inventing pap-only extension APIs (inherited pi-web rule).
- **Security by default.**
  - Localhost bind; approval mode "auto-accept edits"; fail-closed policies.
  - Untrusted content is fenced and sessions are marked tainted.
  - A sandbox-required agent refuses to start without a sandbox.
  - Zero telemetry.
- **FinOps first.**
  - Per-run token and cost registry, with an API-equivalent cost for subscription providers.
  - Daily budgets per agent.
  - One process per active session, released after 30 minutes idle.
- **Borrow patterns, never modules.** T3 Code (~930k lines) and Orca (~2.27M lines) are references for mechanisms, not code to copy.
- **Boring tech.** TypeScript on Node 24, SQLite, React; no Effect, no SSR.

## 4. Surfaces

- `pap serve`: one daemon process, plus one `pi-host` worker per active session.
- Web SPA + PWA (desktop and phone), with self-hosted Web Push.
- The `pap` CLI: serve, service install, doctor, backup/restore, update/rollback, trace summary, user and passkey management.
- No desktop shell and no native mobile app (decision 3).

## 5. Feature scope v1

### 5.1 Carried over from pi-web

All 22 inventory domains. "Verdict" summarises the feature matrix; follow the link for the rationale.

| # | Domain | Verdict | v1 content (short) |
|---|---|---|---|
| D01 | Sessions & chat | ADAPT | Streaming, steer/follow-up, in-session branch tree (`navigate_tree`), fork/clone, compaction, HTML export, auto-name, minimap, drafts; `agent_settled` run semantics; cursor resume |
| D02 | Sidebar & projects | ADAPT | Project groups and order, pins, archive + undo; Cmd+K palette over FTS5 search |
| D03 | Worktrees & lanes | KEEP + ADOPT | Lanes Lots A+B (project.yaml, derived status, commit/push/PR, checkpoints, turn diff, restore/undo, review); locked two-phase worktree creation; script trust by content hash |
| D04 | Files | KEEP + ADOPT | Explorer, viewer, uploads, drops, `@` mentions, allowlist boundary; per-session attachment claims |
| D05 | Git | ADAPT | Status pushed as a stream, diffs, review via lanes |
| D06 | Terminal | ADAPT | xterm, server scrollback, multi-client attach, binary frames |
| D07 | Models & providers | KEEP + ADOPT | Full pi-web set (enabledModels, models.json editor, OAuth/API keys, pricing, quotas); discovery with no side effects |
| D08 | Tools & presets | ADAPT | Presets (none / read-only / default / full, Chat only, codemode, tool-search) + approval modes |
| D09 | MCP | KEEP + ADOPT | Full pi-web MCP client and settings; pap tools are platform calls (no MCP bearer needed) |
| D10 | Skills & plugins | KEEP + ADOPT | Management UI; `get_commands` discovery; `$skill` chips |
| D11 | Subagents | ADAPT | Pi subagents + durable child threads, stop propagation, child approvals in the parent |
| D12 | Long-term agents | KEEP | Registry, trusted thread, unread, rail, inbox, notify/approve/delegate/remind, quarantine, permissions sheet |
| D13 | Agent ops | ADAPT | All pi-web triggers and guards on an SQLite outbox; RRULE + timezone; HMAC option |
| D14 | Memory | KEEP | pi-mem0 scopes, approval queue, forget, promote/correct |
| D15 | Security | KEEP + ADOPT | All pi-web agent policies in the `pap-policy` pipeline; per-method permissions; systemd scopes; one-use secret refs |
| D16 | FinOps & observability | KEEP + ADOPT | `runs` registry + JSONL export for Loki, Prometheus `/metrics`, optional OTLP, event-loop stall monitor, `pap trace summary` |
| D17 | Notifications | KEEP + ADOPT | Self-hosted Web Push, needs-input push, budget push, digest; Orca delivery rules (suppress when focused, mute, burst cooldown) |
| D18 | Extension UI | KEEP | Dialogs, status bar, widgets, `ctx.ui.custom()` panels (possible because Pi runs in our own SDK worker) |
| D19 | Mobile / PWA | KEEP + ADOPT | Safari/iOS 16.4 floor, mobile ergonomics; T3 connection-supervisor rules |
| D20 | Settings & design system | ADAPT | New brand (Night Control, decision 11) → DESIGN.md (spec B) |
| D21 | Install & update | ADOPT | Archive / OCI / npm, service install, update with auto-rollback |
| D22 | Lanes backport | KEEP | Same as D03 |

### 5.2 Additions from the references (decision 12)

- **Lanes+**: fan-out compare of one prompt across N lanes; forges beyond GitHub (GitLab, Gitea…); issue tracker → lane (GitHub Issues, Linear).
- **Sessions+**: settle and snooze; FTS5 search over Pi sessions; auto-resume when a provider quota resets.
- **Security+**: `secret.request` with one-use refs; precheck gate on triggers; dynamic taint rule (spec C §5).
- **File editing** in-app (CodeMirror 6).

### 5.3 Defaults

| Setting | Default |
|---|---|
| Approval mode | auto-accept edits: read and edit run without asking; exec, network and external writes ask (decision 14) |
| Listen address | `127.0.0.1:7777`; `--host 0.0.0.0` must be explicit |
| UI languages | English, French (zh-CN / zh-TW from upstream dropped) |
| Theme | E1 Night (dark) and E1 Day · Papier (light) |
| Telemetry | none; the update check can be disabled with `PAP_UPDATE_CHECK=0` |

## 6. Non-goals (v1)

These are out of scope unless a later decision brings them back (decision 13):

- Native mobile app; desktop shell; embedded browser or preview.
- SSH remote runtimes or multi-environment clients; vendor cloud relay.
- PTYs surviving a daemon restart; an Orca-style plugin host.
- Multi-harness support (Claude Code, Codex…).
- Native Windows build: Windows is supported through WSL2, and pi-web's PowerShell switch is dropped.
- Built-in ACME TLS. Use Tailscale serve, a reverse proxy, or `--tls-cert/--tls-key`.
- Importing pi-web state. Clean start (decision 24, spec D).

## 7. Roadmap after v1 (ordered by expected value)

1. **Teams.** OIDC, roles as permission sets, per-user isolation of agents and secrets, Helm chart; evaluate Postgres.
2. **Per-agent egress proxy.** Network-level host allowlist for bash, closing the v1 limit of spec C §5.
3. **Full self-update trial.** T3-style launcher with parked roots; v1 only checks health and rolls back.
4. Public nightly channel; Homebrew and apt packages.
5. Agents managing their own schedules (T3 `schedule_task` equivalent).

## 8. Related specs

- **Spec B, DESIGN.md**: brand, tokens, screens. In progress through visual rounds; the direction is decided (decision 11).
- **[Spec C, architecture](2026-10-10-C-architecture.md)**.
- **[Spec D, clean start](2026-10-10-D-clean-start.md)**.
