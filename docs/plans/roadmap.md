# pap roadmap after M1

M0 (spikes S1–S8) and M1 (walking skeleton) are planned in [2026-10-10-m0-m1-spikes-skeleton.md](2026-10-10-m0-m1-spikes-skeleton.md). Each milestone below gets its own detailed plan before work starts. Order follows dependencies; milestones on separate lines of the graph can run in parallel. v1 = M2 to M13. Order after M5 (decision 75): two milestones in flight at a time, M8 + M7, then M9 + M10, then M11 + M6, then M12, then M13; M8 opens the critical path M8 → M9 → M11 → M12 → M13. Specs: [A](../specs/2026-10-10-A-product-scope.md), [C](../specs/2026-10-10-C-architecture.md), [D](../specs/2026-10-10-D-clean-start.md); decisions 1–30 in [decisions-log](../research/decisions-log.md).

## Status (2026-10-15)

| Milestone | State | Merge | Decision |
|---|---|---|---|
| M0 + M1 | done | — | 38 |
| M2, M3 | done | b718f9c, a2b214f | 51 |
| M4, M5 | done | ee8f41f, 011ac22 | 70 |
| M8 | done | df12aed | 77 |
| M7 | done | 53f63c4 | 79 |
| M9 | done | 0b5fd75 | 82 |
| M10 | done | 30dff83 | 83 |
| M11 + M6 | next wave (decision 75); M6 is KISS: two install methods (decision 87) | — | — |
| M12 + M6b, then M13; M14 (GitHub) after M11 | to come | — | — |

Off-milestone work merged: design polish 1 and 2 (94e1071, 3d3035a; decision 80), the M9 + M10 follow-ups (2b4ed46, 04d4871 and two flaky-test fixes) and the project home (b7f5820; decisions 85 and 86: every action visible without a shortcut, `projects.add`, Settings › Appearance › Home; owner bundle limit 226 KB for that feature).

Open before M6b (or M6, if an OCI method is chosen): R52b, the rootless podman trade-off (`--security-opt systempaths=unconfined`, spike S8). GitHub integration is M14 (decisions 84, 87). Owner action: rotate the ngrok authtoken.

## M2 — Sessions core and extension UI
- Goal: the full Pi session experience on the worker model.
- Domains: D01 (steer / follow-up with the 128-message / 32 MiB queue cap, `navigate_tree`, fork / clone, compaction, HTML export, auto-name, history paging, tool output on demand, 50 ms delta coalescing, recent notices in the snapshot so that start-up notices (the events a new session's worker raised before `ready`) reach a cursor-less subscriber, drafts, minimap), D18 (all dialogs incl. session/always answers, status bar with `command:` buttons, widgets, `ctx.ui.custom()` panels over `custom_render` / `custom_input` as proven by S1). Worker idle release after 30 min; systemd scopes (`MemoryHigh` / `MemoryMax` / `TasksMax`).
- Depends on: M1, S1.
- Exit: pi-web D01 and D18 behaviours reproduced with scripted-provider integration tests; a crashing extension or worker never takes the daemon down.

## M3 — Design system and app shell
- Goal: DESIGN.md (spec B) as code, replacing the M1 placeholder tokens.
- Domains: D20 (E1 Night / Day tokens, owned Radix primitives, AI components per S6, appearance settings per decisions 27–28, keybindings JSON with `when` + editor, Cmd+K shell, `/dev/ui`, Orca feedback-timing rules), D19 ergonomics (viewport and mobile keyboard, bottom sheets, 44 px targets, mobile bottom nav), app shell of decision 25, logo of decision 26, en + fr everywhere.
- Depends on: M1, DESIGN.md, S6. Can run in parallel with M2.
- Exit: design-system lint is clean on every screen; the shell works on desktop and phone viewports in Chromium and WebKit; the bundle budget is re-set from real numbers.

## M4 — Sidebar, projects and search
- Domains: D02 (project groups and order, pins, archive + undo as SQLite rows with optimistic writes), the session scanner (fs watch + periodic reconcile, byte offsets, cutoff = install timestamp, CLI sessions included — spec D), FTS5 search behind Cmd+K (S3), Sessions+ settle / snooze.
- Depends on: M2, M3, S3.
- Exit: a session created by the `pi` CLI after install appears within seconds; search over 10 000 sessions answers within its budget.

## M5 — Policy pipeline and access control
- Domains: D15 core (pap-policy stages 00–07: command denylist, egress + MCP read-only, the full approval matrix with once / session / always / deny and `approval_rules`, run guard, secret redaction, untrusted fencing + dynamic taint — Security+), D08 approval modes per session, append-only `audit` table + `pap audit prune`, `pap_…` API tokens, connected devices, `pap user add` / `passkey reset`, `policy_update` hot reload.
- Depends on: M2.
- Exit: the C §8.1 security tests pass (fail-closed on bad rules or exceptions, taint then exfiltration asks, forged `Origin`, path traversal); every stage writes an audit line.

## M6 — Install (KISS)
- Goal (owner, decision 87): an ultra-simple first install with **two install methods only**, chosen on the M11 + M6 question page; each sets up the user service and prints the setup URL.
- Domains: D21, install part only. Everything else in D21 moves to M6b.
- Depends on: M5 (no networked install before the policy pipeline), S8.
- Exit: spec A success criterion 3 on both methods (one-step install, localhost bind, setup URL, passkey).

## M6b — Update, backup and release (rest of D21, still v1)
- Domains: OCI image with bubblewrap (S8, R52b), npm channel, `pap doctor`, `pap backup` / `restore`, update with health-checked auto-rollback, release-please, stable / next channels, `PAP_UPDATE_CHECK=0`. Release signing (cosign), SBOM and SLSA provenance stay after v1 (decision 75).
- Depends on: M6. Runs before M13.
- Exit: a failed update rolls back on its own; backup / restore round-trips the state.

## M7 — Models, tools and Pi extensions
- Domains: D07 (selector, reasoning levels, `enabledModels` minimal edits, `models.json` editor, OAuth / API keys, pricing, quotas, side-effect-free discovery), D08 presets (none / read-only / default / full, Chat only, codemode, tool-search), D09 (MCP client and Settings › MCP: masking, exposure, undo, Test, OAuth sign-in, paste importer, project trust UI on S7's store), D10 (skills and plugins management, `get_commands`, `$skill` chips).
- Depends on: M3, M5, S7.
- Exit: the pi-web D07–D10 parity checklist is green.

## M8 — Files, git and terminal
- Domains: D04 (explorer, viewer, uploads, drops, `@` mentions, allowlist boundary, per-session attachment claims), D05 (`vcs{cwd}` status stream, diffs), D06 (node-pty in the native-build allowlist, xterm + WebGL, binary frames with acks, server scrollback, multi-client attach), in-app file editing with CodeMirror 6.
- Depends on: M3, M5.
- Exit: `/files` traversal tests pass; a terminal survives a browser reconnect within one daemon lifetime.

## M9 — Worktrees and lanes
- Domains: D03 + D22 (lanes Lots A+B: project.yaml, derived status, commit / push / PR, checkpoints, turn diff, restore / undo, review with the S5 renderer, locked two-phase worktree creation, script trust by content hash; decision 30 screens), Lanes+ (fan-out compare up to 4 lanes, forges beyond GitHub, issue → lane).
- Depends on: M8, S5.
- Exit: the lane → commit → PR e2e journey (`gh` stubbed) passes on Chromium and WebKit.

## M10 — Outbox, automation and FinOps
- Domains: D13 (SQLite outbox with replay classes, recovery-first boot, runner slots, triggers: RRULE + timezone, webhook secret + optional HMAC, Alertmanager / Grafana mapping, feeds, manual fire and dry-run, quiet hours, precheck — Security+), D16 (`runs` registry + `logs/runs.jsonl` for Loki, API-equivalent cost, daily budgets, Prometheus `/metrics`, optional OTLP, event-loop stall monitor, `pap trace summary`), Sessions+ auto-resume on quota reset.
- Depends on: M5.
- Exit: the webhook → run → inbox journey passes; webhook security tests (bad secret, bad HMAC, 64 KB + 1, dedup replay) pass; a daemon crash mid-task leaves an interrupted task and no replayed process-bound effect.

## M11 — Long-term agents, subagents and memory
- Domains: D12 (registry, trusted thread, unread, rail, inbox, quarantine, permissions sheet; decision 29 screens), platform ops (`agent.notify` / `approve` / `delegate` / `remind`, `lane.note`) as `platform_call`, Security+ `secret.request` with one-use refs and the per-agent vault, agent-thread and isolated-task policy profiles with bwrap, D11 (Pi subagents, durable child threads, stop propagation, child approvals in the parent), D14 (pi-mem0 scopes, approval queue, forget, promote / correct).
- Depends on: M7, M9, M10.
- Exit: no caller can run an op its session type does not allow; a sandbox-required agent refuses to start without bwrap (fail closed).

## M12 — Notifications and PWA
- Domains: D17 (self-hosted Web Push / VAPID, needs-input push after 60 s with no tab open, budget push, quiet-hours digest, Orca delivery rules), D19 (installable PWA, hand-written service worker, connection-supervisor polish).
- Depends on: M3, M10, M11.
- Exit: reconnect-and-resume and mobile-viewport journeys pass; push arrives over HTTPS on iOS 16.4+.

## M13 — v1 hardening and cutover
- Scope: the ~15 e2e journeys of C §8.1, nightly Pi-compat green, final budgets (bundle, session-open payload, idle worker RAM), `docs/agents/*` notes and a ≤ 150-line AGENTS.md, ADR review, spec D cutover (warning when a session file changes outside its worker), pi-web freeze.
- Depends on: M2–M12, M6b.
- Exit: spec A success criteria 1–4 verified; v1.0.0 tagged on the stable channel; the GitHub repository becomes public (owner, decision 87).

## M14 — GitHub integration (owner, 2026-10-15; M14 by decision 87)
- **Asked:**
  - clone (pull) a remote GitHub repository into a new pap project to work on it;
  - fork a remote GitHub repository and work on the fork;
  - more GitHub integrations that help improve code. Candidates to rank later:
    - PR review comments pulled into the lane review;
    - CI check logs on a failed check;
    - issue lists per project;
    - releases.
- **Per-user GitHub token.** Each user configures a GitHub token that pap uses for these actions instead of the `gh` CLI's own login, because pap will become multi-user. Today one daemon-wide `gh` login is shared by every user.
- **Constraints to settle in its plan:**
  - It reverses part of ADR 0036 (forges through their CLIs, gh's own login, no token in pap). It needs a new ADR, covering:
    - token storage per user, encrypted at rest, building on M11's `secret.request` and secrets work;
    - fine-grained token scopes;
    - the token is never passed to lane scripts or the agent (the unattended environment stays token-free);
    - redaction in logs and the audit;
    - revocation;
    - whether a GitHub App fits better than personal tokens once users are many.
  - The remote clone and fork paths reuse M9's push profile and target rules, the host binding and the repository-config scans.
- **Depends on:** M9 (forge port), M11 (secrets). It pairs with the after-v1 multi-user work (teams and OIDC).

## Coverage

| Domain / addition | Milestone |
|---|---|
| D01 Sessions & chat | M1 (skeleton), M2 |
| D02 Sidebar & projects | M4 |
| D03 Worktrees & lanes, D22 Lanes backport | M9 |
| D04 Files, D05 Git, D06 Terminal | M8 |
| D07 Models, D09 MCP, D10 Skills & plugins | M7 |
| D08 Tools & presets | M5 (approval modes), M7 (presets) |
| D11 Subagents, D12 Long-term agents, D14 Memory | M11 |
| D13 Agent ops, D16 FinOps & observability | M10 |
| D15 Security | M1 (minimal policy), M5, M11 (agent profiles) |
| D17 Notifications | M12 |
| D18 Extension UI | M1 (dialogs), M2 |
| D19 Mobile / PWA | M3 (ergonomics), M12 |
| D20 Settings & design system | M3 |
| D21 Install & update | M6 (install), M6b (update, backup, release) |
| Lanes+ (fan-out, forges, issue → lane) | M9 |
| Sessions+ (settle/snooze, FTS5, quota auto-resume) | M4, M10 |
| Security+ (`secret.request`, precheck, dynamic taint) | M11, M10, M5 |
| File editing (CodeMirror 6) | M8 |

After v1: release signing, SBOM and SLSA provenance (decision 75); spec A §7 (teams and OIDC, per-agent egress proxy, full self-update trial, nightly / Homebrew / apt, agent-managed schedules).
