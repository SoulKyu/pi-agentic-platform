# pi-web feature inventory (source for the feature matrix)

Source: local fork `/home/ubuntu/Workspace/soulkyu/pi-web`, branch `local` @ 583b8c4 (includes agent-ops, long-term agents, handto, Tron UI) + unmerged `feat/lanes` (21 commits, worktree `pi-web-workspaces`).
Not upstream agegr/pi-web. Paths below are relative to the pi-web repo. Topic notes: `docs/agents/*.md`.

Status legend: `main` = in `local` · `wip` = unmerged branch · `ext` = being built in another assistant (to backport).

## D01 Sessions & chat — `main`
- Browse sessions read-only from `~/.pi/agent/sessions/*.jsonl` (`lib/session-reader.ts`, `app/api/sessions/**`).
- Start/drive in-process `AgentSession` via SDK (`lib/rpc-manager.ts` `startRpcSession`), any command via `POST /api/agent/[id]`.
- SSE event stream + reconnect (`app/api/agent/[id]/events`, `hooks/useAgentSession.ts`).
- Transcript rendering: user/assistant/toolCall/toolResult, codemode cards, system/usage/context-edit entries (`components/MessageView.tsx`, `CodemodeToolView.tsx`).
- Branching: in-session branch navigator, fork from entry, on-disk Fork of current branch (`lib/session-fork.ts`, `BranchNavigator.tsx`).
- Paged context loading (`sessions/[id]/context`), compaction, export to HTML, auto-name (`auto-name/route.ts`), search.
- Steering / follow-up queue, abort (Esc), drafts persisted locally (`lib/draft-store.ts`), completion sound.
- Chat minimap.

## D02 Session sidebar & projects — `main`
- Project groups (by cwd/repo), custom project order (drag), pins section, archive + undo, virtualized tree (`lib/session-tree.ts`, `SessionTree.tsx`).
- Server-side UI state with revision + lock + corrupt backup (`lib/session-ui-state.ts`).
- New-session project/worktree picker (`NewSessionContextBar.tsx`), default dated cwd `~/pi-cwd/YYYYMMDD`, cwd browser/validate.

## D03 Worktrees & lanes — `main` (worktrees) / `ext` (lanes)
- Git worktree list/create/delete, project grouping (`lib/worktree.ts`, `app/api/worktrees`).
- Lanes: being built by a Pi agent in `pi-web-workspaces` on `feat/lanes` (snapshot c321d66, still moving, so re-sync before spec C/D). Spec: `docs/superpowers/specs/2026-10-10-lanes-design.md` on that branch. Already modelled on Orca (`orca.yaml`, worktree lifecycle, AI diff annotation, commit-message prompt), T3 Code (hidden-ref checkpoints, turn diffs, restore) and Hakoniwa (validation → commit → PR → merge gate).
  - Lot A (done on branch): lane = branch + worktree + its sessions (membership by cwd); `.pi/project.yaml` (setup/archive scripts, copy/link gitignored files, branchPrefix, waitForSetup) read only when project trusted; derived status (setup / needs_attention / working / in_review / done / idle); commit / push / PR via `gh`; trailers `Pi-Lane` / `Pi-Session`; archive order (dirty check → archive script → remove worktree); `lane_note` tool; hardened git exec (no shell, hooks off except commit/push).
  - Lot B (planned): per-turn checkpoints `refs/pi/checkpoints/<laneId>/<entryId>`, turn diff vs branch diff, restore + undo bound to conversation navigation, review (seen files, line comments, send batch to composer or new session).
  - Later lots (out of scope there): workflows (Lot C), fan-out compare (Lot D), multi-repo, GitLab, Kanban, permission modes.

## D04 Files — `main`
- File explorer tree with git-ignore visibility, viewer tabs, download/preview/meta/watch (`app/api/files/[...path]`).
- Uploads + chat drag-drop (folders marked), `@`-mention file index.
- File access allowlist = security boundary (`lib/file-access.ts`, `lib/path-security.ts`), linked-directory allow-link, open in OS file manager (loopback).

## D05 Git — `main`
- Changed files + per-file diff for a cwd (`app/api/git/*`).

## D06 Terminal — `main`
- PTY terminal sessions, xterm tabs, SSE stream, resize/kill (`app/api/terminal/**`).

## D07 Models & providers — `main`
- Model / reasoning selector, default model, mid-run reasoning change.
- `enabledModels` scoped switches with minimal-edit engine; remote catalog refresh; deferred providers registered at session_start.
- `models.json` editor (JSONC), provider discover/test, models.dev pricing presets.
- Auth: OAuth/device-code SSE login, API keys, logout.
- Provider usage quotas.

## D08 Tools & presets — `main`
- Presets none / read-only / default / full, Chat-only, exact system prompts (`lib/tool-presets.ts`).
- Built-ins: codemode (auto/always, inline budget), tool-search, mcp; PowerShell switch (Windows).

## D09 MCP — `main`
- Per-session MCP host (register before prompts, status, idle release) (`lib/mcp-host.ts`).
- Settings › MCP: read without running, masking, enable/exposure/in-project, remove + 60 s undo, Test (bounded connection), OAuth sign-in/out, paste importer (JSON / CLI / links), project trust dialog, read-only MCP policy.

## D10 Skills & plugins — `main`
- Loaded skills list, disable-model-invocation, skills.sh search + install (`npx skills add`).
- Package plugins: list/install/update check.

## D11 Subagents — `main`
- Built-in subagent toggle, maxConcurrent, agent profiles editor, run status, completion notifications.

## D12 Long-term agents — `main`
- Agent registry (profile, avatar, home dir, trash), pinned trusted thread (re-snapshot rule), unread marker, rail with badges + shortcuts, inbox, `?agent=` navigation.
- Agent tools: `agent_notify` (push), `agent_approve` (confirm), `agent_delegate` (queue task for opted-in agent), `agent_remind` (one-shot reminder), `@Name task` mention from composer.
- Thread reset, quarantine (pause + cancel + archive + rotate secrets), prompt chips from `<home>/prompts`, MEMORY.md git history, permissions sheet + lethal-trifecta check, usage per agent, pending requests strip, visit digest, conversation view (author groups, day separators).

## D13 Agent ops / automation — `main`
- Task store (JSON files, immutable terminal states, claim lock, recovery), FIFO runner (slots, single deadline), steer/cancel.
- Triggers: scheduled (60 s tick), webhook (secret header, throttle, 64 KB cap, Alertmanager/Grafana payload mapping, dedup), RSS/Atom feeds, dry-run, manual fire, fire journal.
- Run guard (identical calls / 150 tool calls / 60 turns), daily token+cost budget per agent, quiet hours + digest push, pause, free-memory floor, health gauges.

## D14 Memory — `main`
- pi-mem0 scopes (user / project / agent) snapshot, staged-memory approval queue, forget, promote/correct (save requests).

## D15 Security — `main`
- Web password + throttling (`proxy.ts`), project trust, file allowlist.
- Per-agent: bubblewrap sandbox (+ network), egress host allowlist, command denylist (presets), secrets vault (0600, injected env), secret redaction in tool results, audit journal (args redacted), quarantine, untrusted-content fencing, lethal-trifecta assessment.
- MCP stdio env sanitized (never `PI_WEB_PASSWORD`).

## D16 FinOps & observability — `main`
- `runs.jsonl` run registry (tokens, provider cost, API-equivalent cost for subscriptions), rotation, Loki/Grafana guide (`docs/agents/finops.md`).
- Prometheus `/api/metrics` (token-gated), health route (scheduler tick, runners, free MB, extension errors), Plannotator link detection.

## D17 Notifications — `main`
- Web push (VAPID), needs-input push after 60 s unattended, budget-reached push, quiet-hours digest, completion sound.

## D18 Extension UI compatibility — `main`
- Dialog queue (select/confirm/input/editor), custom panels, status bar with `command:` buttons, widgets — pi TUI is the reference; no pi-web-only extension API.

## D19 Mobile / PWA — `main`
- Safari/iOS 16.4 floor, viewport/keyboard handling, bottom sheets, 44 px touch targets.

## D20 Settings UI & design system — `main`
- Settings panels (Models, MCP, Skills, Plugins, Agents, Memory, Tools), stacked dialogs/Escape.
- Tron design system: single dark palette (cyan system / orange user / red error), Chamfer/hex primitives, `/dev/ui` gallery, reduced motion.

## D21 Install & update — `main`
- npm package `@agegr/pi-web` + `bin/pi-web.js`, app-update check against published version, i18n (`docs/i18n.md`).

## D22 Pending backport — `ext`
- Lanes (see D03): the only feature in flight outside `local`. Backport = re-read `feat/lanes` at spec time and treat Lots A+B as in scope.
