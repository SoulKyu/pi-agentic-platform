# pap M7: models, tools and Pi extensions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-13):** plan fix applied. Inputs: the Opus red-team (`.superpowers/redteam-m7.md`: 0 Critical, 2 Important, 5 Minor), the M7 ⇄ M8 cross-plan agreements 1–24 with the owner amendments, and the owner's answers of 2026-10-13 (rulings M7R131–M7R146; decision 76). The plan goes to subagent-driven execution with no further review of the plan itself. It follows decision 73's lighter format: interfaces, pre-dispatch rulings `M7R<n>` and test lists for normal tasks. Full code is given only for the security contracts:
- the git config check;
- the read-only command allowlist and pattern always-rules;
- the MCP / codemode / tool-search registration;
- the helper's spawn and protocol schemas, and the Pi file boundary;
- the `models.json` masking and write path;
- the MCP masking and project-file boundary;
- the plugin and skill install arguments;
- the trust breadth rule;
- the migrations.

35 tasks. The splits, all security tasks: 1a/1b/1c, 2a/2b, 6a/6b and 12a/12b.

**Goal:** A pap session is driven the way the `pi` TUI and pi-web drive it: the model and reasoning level are picked in the composer, tools come from a preset, MCP servers, codemode and tool search work inside the real worker under M5's policy, and Settings gains Models (providers, keys, OAuth, `enabledModels`, `models.json`), MCP (servers, exposure, Test, import, undo, code mode) and Skills (skills, plugins), with project trust decided from pap. Ordinary read-only shell commands stop asking in the default mode, "always" answers can cover a command prefix or a whole tool, and a first-run stepper ends with a working provider. Exit: the pi-web D07–D10 parity checklist below is green.

**Architecture:** Every read and write of Pi's own configuration (`models.json`, `auth.json`, `settings.json`, `mcp.json`, `trust.json`, `SKILL.md` frontmatter, packages) and every Pi SDK call that can reach the network, run a configured command (`!cmd` keys, MCP servers, npm) or load provider code runs in a **short-lived helper child** (`packages/pi-host/src/helper/`, forked by a new `kernel/helper` pool with the worker environment rules), never in the daemon process (ADR 0023). The daemon gains four modules (`models`, `mcp`, `skills`, `trust`), each a thin service over helper operations whose results it validates with contract schemas, composed with the helper pool in `compose-pi.ts` (M7R151). The session worker grows the commands the TUI has (`get_available_models`, `set_model`, `set_thinking_level`, `set_tools`, `get_commands`), loads Pi's `mcp`, `codemode` and `tool-search` built-ins under their exact names, and reports a `loadout` record (model, reasoning, preset, active tools). pap-policy stays the last `tool_call` handler: stage 03 learns read-only commands and the grant check learns prefix and tool rules through one coverage engine (`command-cover.ts`) built on M5's reader and protected-read check; a git command is covered only when its repository's own config runs nothing (owner m3, `git-config-guard.ts`). The web app adds a model bar and a `/` + `$` command menu to the composer (three mounted lines in all, on M8R83's `TextField` props: agreement 7), a tools chip and a trust banner on the session screen, three lazy Settings sections and the first-run stepper.

**Tech Stack:** as M5 (Node 24, pnpm catalog, TypeScript 6.0.3 strict and erasable-only, zod 4.6.5, Hono, `ws`, `node:sqlite`, Pi SDK 1.1.0, React 19 + Vite + React Compiler, TanStack Router, zustand, Tailwind 4, Vitest + happy-dom). **No new dependency**: MCP Test reuses Pi's own MCP extension in a throwaway session (Task 19), so pap imports nothing beyond the Pi SDK it already uses. No CodeMirror in M7 (M7R72), no tiptap in this wave (owner c2, M7R132).

**Spec:** `docs/plans/roadmap.md` (M7); `docs/specs/2026-10-10-A-product-scope.md` (D07–D10); `docs/specs/2026-10-10-C-architecture.md` §2.3 (records), §5 (policy), §7 (frontend), §8.1, §9.4 (zero telemetry); `DESIGN.md` §2 (trust visual code), §7.3 (feedback timing), §9 (Composer "model and reasoning pill", chips), §10 ("MCP, models, skills follow the components; pi-web panels are the functional reference"), §11; `docs/spikes/s7.md` (trust store); ADR 0001 ("Project trust"), 0002, 0020, 0021, 0022; `docs/agents/{policy,daemon,sessions,auth,web}.md`; `docs/research/{m0-m1,m2,m3,m4,m5}-rulings.md`, `m5-final-review.md`, `m5-sdd-ledger.md`; `.superpowers/m7-m8-planning-brief.md` (carries, coordination contract). Parity references read, never copied: pi-web `docs/agents/{models,tools,mcp-*,settings-ui}.md`, `lib/{tool-presets,provider-usage,codemode-settings}.ts`, `app/api/{skills,plugins,models-config}/**` (`/home/ubuntu/Workspace/soulkyu/pi-web`, read only). Patterns borrowed (cited in each task): T3 Code `packages/provider-pi/src/server/{status,commands,thinkingCapabilities,mcpExtensionSource}.ts` (side-effect-free discovery, `get_commands` skills, `$skill` chips, `default` sentinel), Orca `src/main/pi/rpc-options.ts` (thinking levels from the model, zero models means "not signed in"), `docs/STYLEGUIDE.md` (feedback timing) (`/home/ubuntu/Workspace/soulkyu/_refs/{t3code,orca}`, untrusted, read only).

## Carried items and backlog absorbed

| Item | What M7 does | Task |
|---|---|---|
| Decision 75 Q6: read-only command allowlist for the default mode, first task | `command-cover.ts` + `read-only-commands.ts`: a bash call whose every simple command is read-only (`ls`, `cat`, `rg`, `git status / diff / log`…) runs as a read in supervised and auto-accept-edits; M5's denylist runs first, the run guard after, every path operand passes M5's protected-read check, a tainted session keeps asking for anything that can carry data out | 1b, 1c |
| Owner answer m3 (2026-10-13, replaces M7-RT-04's residual): `git status` / `diff` / `log` and a planted `.git/config` | `git-config.ts` + `git-config-guard.ts`: a git read command runs unasked only when its repository's own config (with `config.worktree` and every include) names no program; submodules, unreadable files and unresolvable includes ask | 1a (called by 1b, wired by 1c) |
| Decision 68 / M5 Q14: pattern always-rules come with M7's presets (D08) | "Always" on a card may cover a command prefix (`pnpm test …`) or a whole non-shell tool, through the same coverage engine; never past taint, review or an unchecked command | 2a, 2b |
| Decision 75 Q5 (M5 final review M8): taint a session when tool results were added outside pap | The scanner tells the sessions module when an outside write appended `toolResult` entries; that, and only that, raises the taint | 3 |
| Decision 74, M5 Task 9 carry, M5R carry: wire MCP, codemode and tool_search | Registered as `{ name: "mcp" \| "codemode" \| "tool-search", factory, builtin: true, replaceable: true }`, codemode with `models: false`, MCP sign-in links shown as a notice | 4 |
| M5 Task 25a carry: MCP exit tests run in-process | Rewritten against a real daemon worker with the MCP fixture in the test agent directory | 5 |
| M5 ledger minor (deferred): a nested codemode result whose classification throws does not record its parent root | Fixed in `results.ts` (the catch path records the parent too) | 4 |
| Decision 75 Q7: mode descriptions, `defaultMode` in `SessionPolicyView`, unused token permissions | The approval mode picker shows all four modes with their descriptions; "Use my default (Auto-accept edits)" names the mode; the token grid offers only permissions some method declares | 28 |
| M3R106: first-run stepper deferred to M7 | Account → passkey (skippable) → Pi (sign in to a provider or paste a key, pick a default model; skippable) | 29 |
| ADR 0001 / S7: trusting a project from pap | `trust.status` / `trust.set` through `ProjectTrustStore` in the helper, breadth refusals, workers of that folder restarted; a trust dialog that lists what trust turns on | 22, 23 |
| R97 (M5/M7): narrow `$PAP_HOME` protection | Already done by M5 for reads (M5R29); writes stay protected until M9/M11 put agent homes and worktrees there — nothing for M7 | — |
| M2R72 / M2-Q1 "patterns with M5", M5 MQ7 "header list revisited in M7" | The session header's always-rule list shows prefix and tool rules with their scope; the list stays (M5R100), "Manage approvals" unchanged | 2b |

## Explicitly deferred

- **Provider usage quotas** (pi-web `lib/provider-usage.ts`, ten provider endpoints): M10 (owner m4, M7R137; FinOps owns usage, budgets and quota auto-resume).
- **Live MCP connection state per session in Settings** (pi-web's transport-wrapping status store): the SDK exports no transport hook; Settings shows file state and the last Test (owner m6, M7R139).
- **MCP OAuth sign-in from a Settings button**: the SDK's `signInMcpServer` is not exported; sign-in runs through Pi's own `/mcp` in a session, which pap's dialogs already render (owner m6, M7R139).
- **Exact system prompts** (pi-web Chat only replacing Pi's base prompt) and the **PowerShell switch** (Windows; pap is Linux and WSL2 only, decision 23): dropped (owner m10, M7R143).
- **tiptap composer** (DESIGN §9.2, spec C §7.2): not in this wave (owner c2, M7R132): `@path` stays text, `$skill` is sent as Pi's `/skill:name` with its chip beside the plain field; revisit at M11.
- **Per-user skills and plugins:** pap v1 has one owner (decision 10), so skills and Pi packages live in the owner's Pi folder ("All my projects") or in a project ("This project"). Per-user skills come with teams after v1 (spec A §7; owner m7 note, M7R140).
- **Unattended profiles, per-command sandbox, daily budgets**: M10 / M11 as in M5.
- **Browser e2e**: M13 (decision 42). The owner checks real browsers on the preview.

## Owner decisions (2026-10-13)

The owner answered the M7 + M8 question page (`.superpowers/owner-decisions-2026-10-13-m7m8.md`). Every answer is the recommendation, and two answers carry a note the controller ruled on. Each answer is a ruling here, cited by the tasks it binds. Decision 76 in `docs/research/decisions-log.md` records them for both milestones. The plan-fix rulings that implement them are M7R147–M7R153.

- M7R131 (c1) [merge notes, 30] Merge order: M8 first, then M7 rebases once (agreement 1). The exception: M7 passes its Opus final review more than one working day before M8. Why: M8 opens the M8 → M9 → M11 path and adds no migration. Cost if wrong: the mirror rebase steps of the merge notes.
- M7R132 (c2) [27] No tiptap in this wave. `@path` stays text (M8), and `$skill` is sent as Pi's own `/skill:name`, with a chip beside the plain field. Revisit at M11. Cost if wrong: chips are a row, not inline tokens.
- M7R133 (c3) [8, 11, 12a, 12b, 17–22, 24–26] Changes that run code later:
  - **Pi's own config** under `<agentDir>` (`auth`, `models`, `mcp`, `trust` and `settings` JSON) is read and written only by M7's helper, and edited only in Settings, with keys masked.
  - **The password step-up** applies to the changes on the Q3 (a) list: sign-in, an API key, a `models.json` save, discover, a global MCP add or undo, an MCP Test, a global skill or plugin install or update, trusting a project. Switches, defaults and removals never ask.
  - **A project's protected files** (its `.pi/` folder, a project skill file) take the "Save anyway?" confirmation instead. The method requires `confirmProtected: true` for a project target; a request without it is refused `bad_request`. The UI asks first, with M8's protected-save copy.
  - **Tokens never confirm.** `pi:admin` is never a token permission, so every such method answers a token `forbidden` (agreements 5 and 6; pinned by Task 6a's token test).
  
  Cost if wrong: one click per project save; one password entry per 5 minutes in the listed flows.
- M7R134 (m1) [1c] Read-only commands run unasked in supervised and auto-accept-edits; read-only mode keeps blocking the shell (M7R11).
- M7R135 (m2) [1c] In a tainted session, read-only commands still run: no listed command reaches the network. Egress keeps asking Deny / Allow once (M7R12).
- M7R136 (m3) [1a, 1b, 1c] `git status`, `diff`, `log` and every other git read command of the table run unasked only when the repository's own config runs nothing. pap reads `.git/config`, `config.worktree` and their `include` / `includeIf` targets. The command asks on any of these:
  - `core.fsmonitor`, `diff.external`, `diff.*.command`, `*.textconv`, `filter.*.{clean,smudge,process}`, `core.pager`, `core.editor`, `core.sshCommand`, `gpg.program` or `credential.helper`;
  - an unreadable file;
  - an include that cannot be resolved.
  
  Full code and an Opus review in Task 1a (details in M7R147–M7R150). This replaces M7-RT-04's "accept the residual". Cost if wrong: the friction named in M7R148 and M7R149.
- M7R137 (m4) Provider usage quotas go to M10 (FinOps); P07-12 stays deferred.
- M7R138 (m5) [12b, 14] models.dev pricing stays, as an **opt-in** (owner note):
  - A Settings › Models switch, "Look up prices on models.dev", off by default. It is stored as the owner's `models` account setting (`modelsDevPricing: false`).
  - Off: no lookup control is rendered, and `models.pricing` answers `forbidden` without any request.
  - On: a lookup on click only, and the copy names models.dev.
  
  Cost if wrong: none.
- M7R139 (m6) [4, 19, 20] MCP OAuth sign-in runs through Pi's `/mcp` in a session. Settings shows the file state and the last Test (M7R96).
- M7R140 (m7) [24, 25, 26] skills.sh installs stay, through a pinned `npx skills@<version>`, with the exact command shown. The owner's note asked "skills must be bound to users / project?", and the ruling is:
  - Every install chooses a scope. "This project" means the project's Pi packages and skills: it needs a trusted project and the protected-file confirmation of M7R133. "All my projects" means the owner's Pi folder (global), with the password step-up of M7R133.
  - The scope picker defaults to the project of the session the owner came from, when it has one; otherwise "All my projects".
  - The same scope rule applies to plugins (Task 25).
  - pap v1 has one owner (decision 10), so skills live in the owner's Pi folder or in a project. Per-user skills come with teams after v1 (spec A §7): deferred.
- M7R141 (m8) [27] One `$skill` per message (M7R119).
- M7R142 (m9) [8, 13] Settings › Models lists built-in and `models.json` providers. A provider an extension registers shows in the session's model menu and signs in with the `pi` CLI (M7R46).
- M7R143 (m10) P08-3 (Chat only's exact system prompt) and P08-5 (the PowerShell switch) are dropped.
- M7R144 (m11) [4] codemode runs with `models: false` (M7R29).
- M7R145 (m12) [29] The first-run Pi step asks for the password again before a sign-in (M7R127). The auth module is unchanged.
- M7R146 (m13) [12a, 17, 30] The `models.json` and `mcp.json` editors follow a dotfiles symlink anywhere inside `$HOME` (M7-RT-06). This is a stated decision, written in `docs/agents/models.md` and `mcp.md` (Task 30). Cost if wrong: none: only a same-user process can plant the link, and that process can already write the target.

## Global Constraints

Copied from the specs and binding rulings (source in brackets). Every task implicitly includes them.

- Node 24, "Boring tech" [A §3], engines `>=24.14 <25` [R44].
- "400 lines per file at most. No baseline, no exceptions." [C §1.4.2] Tests included. Files near the cap today and the room each task may use: `modules/sessions/live-session.ts` 387 (M7 adds at most 6 lines in all, in Task 7 only, and M8 at most 3: ≤ 396 after both, agreement 13; every other task delegates to new files), `apps/daemon/src/daemon.ts` 318 (M7 adds at most 10 lines in all, through `compose-pi.ts`: agreements 9 and 24, M7R151), `apps/web/src/runtime/subscriptions.test.ts` 344 (frozen: M7's opener tests go to `subscriptions.m7.test.ts`, agreement 11), `stores/session-reducer.test.ts` 395 (frozen: new reducer tests go to new files), `policy/extension.test.ts` 400 and `policy/target-path.test.ts` 376 (frozen), `contracts/methods.ts` 289 (one import and one spread line per M7 method list, never an inline `defineMethod`), `contracts/streams.ts` 297 (M7 schemas live in `session-loadout.ts`; `streams.ts` gets one snapshot field and one event line), `modules/sessions/snapshot.ts` 329, `features/sessions/SessionScreen.tsx` 206.
- Module boundary: "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1] Production code never imports a `testing/` file [R84]. Web: `features/<x>` imports only its own domain, `stores`, `runtime`, `i18n`, `lib`, `@pap/ui` and contracts.
- "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- "Every RPC method declares a permission in `contracts`." [C §1.4.4] `idempotent: false` = mutation with `commandId` and receipts; a mutation's `timeout` means "outcome unknown" and is never retried [R65b, R105]. Every new daemon test builds callers with `testCaller()` [M5R110].
- Errors carry a stable code and a fixed message with no user content and no secrets [C §4.1]. Helper, Pi, provider, MCP-server and extension text never reaches a client as an error message; it is clipped before logging [R66] and rendered as React text only.
- Policy: pap-policy is evaluated **last** [ADR 0002]; any evaluation error blocks (fail closed) [C §5.1]; tools are classified by registered source, never by name [M5R24, M5R116]; a tainted session asks Deny / Allow once for every exfiltration-capable or external call, past any grant [M5R27, ADR 0020]; "always" rules belong to the project's git root [decision 44].
- Changes that run code later (owner c3, M7R133; agreements 5, 6):
  - Pi's own config under `<agentDir>` is written only by M7's helper, from Settings, with keys masked. The changes on the Q3 (a) list take the password step-up.
  - A write to a project's protected files (its `.pi/` folder, a project skill) takes the "Save anyway?" confirmation: `confirmProtected: true` is required for a project target.
  - Tokens never confirm and never hold `pi:admin`.
- Secrets (provider keys, OAuth tokens, `mcp.json` env and header values, `models.json` literal keys) are never logged, never written to the audit, never stored in receipts, never sent to the browser after they were set, never placed in an error message.
- Zero telemetry: the only outbound requests pap itself starts are the ones the owner clicks for (catalog refresh, sign-in, Test, discover, pricing once the owner switched the models.dev lookup on (M7R138), skills search, install) [C §9.4, decision 34]; workers and helpers run with `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`; Pi's catalog refresh only on explicit action.
- SQLite: single writer, the daemon [C §3.2]; tables written only by their owner's `store.ts`; forward-only migrations `modules/<m>/migrations/<YYYYMMDDHHmm>_<name>.sql`, every M7 stamp after `202610122040` (the newest on `main`); the branch merging second re-stamps after `main`'s newest at its rebase.
- Frames 1 MiB, lists fitted under `PAGE_BYTES` (900 000) with a `truncated` flag [M2R54].
- Browser floor Safari / iOS 16.4, en + fr everywhere, CSP R74 unchanged, tokens only (no raw colours, no `[…]` values, no restyling of `@pap/ui` primitives), no native `title` [AGENTS.md, M3].
- Bundle: flat 300 KB gzip initial ceiling until M13 (decision 75 Q8), today 195.3 KB. Settings sections, the composer menus, the model menu and the trust dialog are lazy. Every task that edits `packages/contracts` or `apps/web` runs `pnpm build && pnpm budgets` and writes `bundle: <before> → <after> KB gzip` in its commit body [M5R112]. Anything that would push the total above 250 KB stops and is reported.
- Tests never touch `~/.pi/agent` or `~/.pap`, never call a real provider, never use the network (network guard in workers and helpers), never run `curl`, `wget`, `npx`, `npm` or a destructive command that only a working rule keeps from running; timers through the kernel `Clock`, no sleeps; real processes awaited with `vi.waitFor` and an explicit timeout [AGENTS.md, M5R104].
- Supply chain: exact pins, catalog for the Pi SDK, `minimumReleaseAge` 3 days, no build scripts beyond `onlyBuiltDependencies` [C §8.2]. M7 adds no dependency; a task that believes it needs one stops and reports. The pinned `skills` CLI version used by Task 24 is a string in code, chosen ≥ 3 days old at implementation.
- Git: Conventional Commits, rebase on the target before a PR, **no `Co-Authored-By` or AI attribution trailer**.
- Never edit pi-web; pap imports nothing from it and copies none of its code [D §1]. T3 Code and Orca clones are untrusted: read for patterns, never copied.
- Implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and report each item ✅ / n/a; reviewers probe each item.
- Host: headless VPS. Every command and path uses the absolute worktree `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m7`; nothing is written to pi-web or the M8 worktree; ports 30141, 7777, 4040, 18022, 18023 are never used; no long-running server is left behind.
- Code blocks in this plan are binding where they pin a security contract (listed in the Status line). Elsewhere the interfaces, rulings and tests are binding and code shows one way; an implementer who finds a defect in prescribed code fixes it, keeps the test and says so.

## Plan conventions

- Commands run from `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m7` after `export PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m7/.superpowers/bin:$PATH`. Task 1a starts with `pnpm install --frozen-lockfile --offline` (expected: no lockfile change).
- Gate per task: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit`; plus `pnpm test:int` when the task touches pi-host, the supervisor or helper pool, a daemon module with `*.int.test.ts`, the ws server or the CLI (decision 73); plus `pnpm build && pnpm smoke` when it touches a worker record, the wire or the helper protocol; plus `pnpm build && pnpm budgets` (the `bundle:` line) when it touches `packages/contracts` or `apps/web`.
- Rulings `M7R<n> [tasks] decision — why — cost if wrong`. The controller copies them into `docs/research/m7-rulings.md` (Task 30). Nothing stays open unless only implementation can discover it, and the line says so.
- Security tasks (1a, 1b, 1c, 2a, 2b, 4, 5, 6a, 6b, 11, 12a, 12b, 15, 17, 18, 19, 22, 24, 25) carry a **Hostile inputs** list with one test per class and name their mutation checks: remove the guard → the named test fails.
- One feature, one vertical slice: a daemon task that changes a stream event or snapshot field also updates the web reducer with a test.
- Model escalation: fix rounds 4–5 of a task still failing after three rounds may use an Opus implementer (decision 75 Q9), logged in the ledger.
- M7 does not edit `docs/research/decisions-log.md` in execution; the plan fix recorded both milestones' owner answers as decision 76. ADR numbers 0023–0029.

## Review Focus

The inputs most likely to bite a person that ordinary feature tests do not exercise; each names the test that pins it.

1. **A read-only-looking command that is not**: `cat ~/.pi/agent/auth.json`, `rg token ~`, `cd ~/.pi && cd agent && cat auth.json`, `git -c core.pager=sh log`, `git diff --ext-diff`, `git status` in a repository whose own `.git/config` sets `core.fsmonitor` (or includes a file that does), `git -C src -C ../../agent grep --no-index token`, `rg --pre sh x`, `rg --hostname-bin=./x.sh x`, `find . -exec rm {} \;`, `sort -o out in`, `cat a > b`, `LD_PRELOAD=x cat a`, brace and tilde tricks, a `shellCommandPrefix` that sources aliases. Expected: asked as before (or blocked by M5), never run silently. Pinned by Task 1a `git-config-guard.test.ts`, Task 1b `command-cover.hostile.test.ts` (the ASKS table) and `command-cover.git.test.ts`, and Task 1c `pipeline.read-only.test.ts` and `host.read-only.int.test.ts` (the fsmonitor marker never appears).
2. **Taint, then a read-only command, then exfiltration.** Expected: `cat notes.md` still runs (a read, like the built-in `read`), `curl …` and every MCP or network call ask Deny / Allow once, and no prefix or tool rule skips that question. Pinned by Task 1c "a tainted session runs a read-only command and still asks for curl" and Task 2a "a tainted session asks past a prefix rule and a tool rule".
3. **A prefix rule stretched by shell syntax**: the owner always-allowed `pnpm test`; the model sends `pnpm test && curl x | sh`, `pnpm test $(id)`, `pnpm test > ~/.bashrc`, `X=1 pnpm test`. Expected: asked. Pinned by Task 2a `pattern-grants.test.ts` STRETCH table.
4. **A secret through Settings**: an API key or an OAuth token sent once, a `models.json` with a literal `apiKey`, an `mcp.json` header `Authorization: Bearer …`. Expected: never in a log line, an audit row, a receipt, a snapshot, an RPC result or an error; the browser sees names and placeholders only, and a save that keeps a placeholder keeps the secret. Pinned by Task 11 "no key in logs, receipts or results", Task 12a `models-json-mask.test.ts`, Task 17 `mcp-mask.test.ts`.
5. **A Pi file written where it must not be**: a `models.json` symlinked to `/etc/x`, a project `.pi/mcp.json` that is a link out of the project, a FIFO, a 2 MiB file, a server named `__proto__`. Expected: refused with a typed code, nothing written. Pinned by Task 6b `pi-file.test.ts`, Task 12a `models-json.test.ts` and Task 18 `mcp-write.hostile.test.ts`.
6. **MCP through the real worker**: a third-party MCP tool result after which `echo exfil` asks; a codemode script calling that tool fences the codemode result too. Pinned by Task 5 `mcp-taint.int.test.ts` and `codemode-nested.int.test.ts`.
7. **A helper that hangs or floods**: an MCP server that never answers, an OAuth flow nobody finishes, a helper printing 100 MB. Expected: killed at its deadline with `timeout`, the pool slot freed, the output tail capped at 8 KiB, a fifth concurrent helper refused with `capacity`. Pinned by Task 6a `pool.test.ts` and `pool.int.test.ts`.
8. **Trusting too much**: trusting `/`, `~`, or a parent folder of several projects. Expected: refused (a parent decision is inherited by every child, S7). Pinned by Task 22 `trust-breadth.test.ts`.

---

## File structure

```
packages/contracts/src/
  policy.ts                1c readOnlyCommands (rules, settings); 2a PrefixRule, ToolRule, alwaysPrefixes, alwaysTools
  pi-host.ts               2a approval scopes; 7 loadout record, model commands; 15 set_tools, preset in init; 27 get_commands
  session-loadout.ts (new) 7 ThinkingLevel, ModelSummary, SessionLoadout; 15 ToolPreset
  pi-helper.ts (new)       6a helper protocol records; each op's params / result schema (6a, 8, 10–12b, 17–19, 22, 24, 25)
  models-methods.ts (new)  8, 10–12b models.* ; mcp-methods.ts 17–19 ; skills-methods.ts 24, 25 ; trust-methods.ts 22
  settings.ts              12b the `models` account setting (modelsDevPricing)
  permissions.ts           6a domain `pi`;  errors.ts 6a helper_failed, 8 project_scope, 12a config_invalid, config_path_refused
  streams.ts               7 snapshot.loadout + event; 11 stream `login`
packages/pi-host/src/
  policy/git-config.ts, git-config-guard.ts (1a)  read-only-commands.ts, command-cover{,-judge,-git}.ts (1b)
  policy/pattern-grants.ts, prefix-proposal.ts (2a)  stage-approval.ts (1c)  evaluate-once.ts (2a)  egress.ts (15)  results.ts (4)
  builtins.ts (4)  model-commands.ts (7)  loadout.ts (7, 15)  tool-presets.ts (15)  slash-commands.ts (27)
  helper/{main,run,ops}.ts (6a)  helper/pi-file.ts (6b)  helper/mask.ts (17)  helper/ops/*.ts (6a, 8, 10–12b, 17–19, 22, 24, 25)
apps/daemon/src/
  kernel/helper/{pool,helper-io}.ts (6a)
  modules/models/ (8, 10–12b)  modules/mcp/ (17–19)  modules/skills/ (24, 25)  modules/trust/ (22)
  modules/sessions/{service-models,loadout-view}.ts (7, 15), migrations/<stamp>_tool_preset.sql (15)
  modules/search/extract.ts, scanner-file.ts + sessions/scan-port.ts (3)
  modules/policy/migrations/<stamp>_pattern_rules.sql, store.ts (2b)
  compose-pi.ts (new, 6a: the helper pool; 8 models, 17 mcp, 22 trust, 24 skills; returns { rpc, stopAll })
  daemon.ts (6a: ≤ 10 lines in all, M7R151; MIGRATION_SOURCES unchanged: the two new migrations live in existing modules)
  modules/settings/index.ts (12b: a read port for the `models` account setting)
apps/web/src/
  features/sessions/{ModelBar,SessionTools,TrustBanner,CommandMenu,SkillChip}.tsx, use-composer-commands.ts (9, 16, 23, 27)
  features/models/ (13, 14)  features/mcp/ (20, 21)  features/skills/ (26)  features/trust/ (23)
  features/policy/ (2b, 28)  features/auth/SetupStepper.tsx (29)
  routes/settings/sections.tsx + features/workspace/model.ts SETTINGS_SECTIONS (+ models, mcp, skills)
  i18n/catalog/{session-models,settings-models,settings-mcp,settings-skills,trust,first-run}.ts
packages/ui/src/primitives/TextField.tsx (27: M8R83's props, M8R83's names; `main`'s copy wins at the rebase)
docs/adr/0023 … 0028, docs/agents/{models,mcp,skills}.md (new), policy.md, daemon.md, sessions.md, web.md
```

## The pi-web D07–D10 parity checklist (M7's exit criterion)

Built from `docs/research/pi-web-inventory.md` D07–D10 and `feature-matrix.md`, refined with pi-web's `docs/agents/{models,tools,mcp-*,settings-ui}.md`. **Green** = the row's pap behaviour exists and its test passes, or the row is dropped/deferred by a recorded owner decision. Task 30 runs the list and records the verdict per row in `docs/agents/models.md`.

| # | pi-web behaviour | pap | Task | Proof |
|---|---|---|---|---|
| P07-1 | Model selector in the session, grouped by provider in Pi's `/model` order, scoped by `enabledModels` | Model bar in the composer, list from the live worker | 7, 9 | `model-commands.test.ts`, `ModelBar.test.tsx` |
| P07-2 | Reasoning levels gated by the model (`xhigh`/`max` only when supported), mid-run change applies from the next request | Reasoning menu from `getAvailableThinkingLevels()`; enabled while running | 7, 9 | `host.models.int.test.ts` "level applies to the next request" |
| P07-3 | Default model / reasoning (star), refused when the project's `.pi/settings.json` decides | `models.setDefault*`, `project_scope` | 8, 9 | `models-defaults.test.ts` |
| P07-4 | Session picks are session-scoped (never written to `settings.json`) | `set_model` without `persist` | 7 | "a pick never writes settings.json" |
| P07-5 | `enabledModels` switches with minimal edits (globs kept, last-model refusal, project scope read-only, provider switch, prune / clear / resync) | `models.setEnabled` engine in the helper | 10, 13 | `enabled-models.test.ts` table |
| P07-6 | Catalog refresh only on user action, `PI_OFFLINE` honoured | `models.refreshCatalog` | 8 | `models-catalog.test.ts` |
| P07-7 | Providers an extension registers appear in the selector | The selector lists the session worker's runtime | 7 | `host.models.int.test.ts` extension provider case |
| P07-8 | `models.json` editor (JSONC), omitted `api` left unset, renames resync `enabledModels` | Masked JSONC editor, validated save, resync | 12a, 14 | `models-json.test.ts`, `models-json-mask.test.ts` |
| P07-9 | Provider discover (fetch the model list) and Test (one request) | `models.discover`, `models.test` | 12b, 14 | `models-discover.test.ts` |
| P07-10 | models.dev pricing presets | Opt-in (owner m5, M7R138): a Settings › Models switch, off by default; when on, `models.pricing` on click only | 12b, 14 | `models-pricing.test.ts`, `PricingLookup.test.tsx` |
| P07-11 | OAuth / device code / manual code sign-in, API keys, sign-out; raw key never returned; a dual-auth provider listed once | `models.login*` flows over the `login` stream, `models.setApiKey`, `models.logout` | 11, 13 | `models-auth.test.ts`, `login-flow.int.test.ts` |
| P07-12 | Provider usage quotas | Deferred to M10 (owner m4) | — | decision |
| P08-1 | Presets none / read-only / default / full, and "configured" (follow `defaultTools`), pinned per session, changeable mid-session | `ToolPreset`, `sessions.setTools` | 15, 16 | `tool-presets.test.ts`, `host.presets.int.test.ts` |
| P08-2 | Chat only (no tools, no extensions, skills or prompt templates) | Preset `chat` (worker restarted across the boundary) | 15, 16 | "chat preset loads no user extension" |
| P08-3 | Exact system prompt in Chat only | Dropped (owner m10) | — | decision |
| P08-4 | codemode (Automatic / Always on, `codemode.mode` on / only, inline budget), tool-search and mcp as replaceable `builtin:<name>` | Task 4 registration; code mode pane in Settings › MCP | 4, 18, 20 | `host.builtins.int.test.ts`, `codemode-settings.test.ts` |
| P08-5 | PowerShell switch | Dropped: Linux and WSL2 only (decision 23, owner m10) | — | decision |
| P08-6 | Read-only selection blocks MCP tools without `readOnlyHint` (codemode calls too) | Read-only preset applies M5's MCP read-only rule | 15 | `egress.preset.test.ts` |
| P09-1 | MCP servers from global and trusted project `mcp.json` connect in the session | Pi's `mcp` built-in in the worker | 4, 5 | `mcp-taint.int.test.ts` |
| P09-2 | Settings › MCP reads files without running anything | `mcp.overview` reads files only (no spawn, no value resolution) | 17 | "overview spawns nothing" |
| P09-3 | Masking: env / header values never sent, credentials in command, args and URL masked | `mask.ts` | 17 | `mcp-mask.test.ts` |
| P09-4 | Enable / disable, group switch, exposure, turn off in this project (override) | `mcp.setEnabled`, `mcp.setExposure`, `mcp.setInProject` | 18, 20 | `mcp-write.test.ts` |
| P09-5 | Remove + 60 s undo | `mcp.remove` → token, `mcp.undo` | 18, 20 | `mcp-undo.test.ts` |
| P09-6 | Test (bounded connection), masked errors | `mcp.test` in an in-memory Pi session | 19, 20 | `mcp-test.int.test.ts` |
| P09-7 | OAuth sign-in / out | Pi's `/mcp` in a session (dialogs + link notice); Settings points there (owner m6) | 4, 19 | `host.builtins.int.test.ts` "openUrl becomes a notice" |
| P09-8 | Paste importer (JSON / command line / link) and add form | `mcp.parseImport` (parse only) + `mcp.add` | 18, 21 | `mcp-import.test.ts` |
| P09-9 | Project trust dialog listing project MCP servers; trust from Settings | `trust.status` / `trust.set`, `TrustDialog` | 22, 23 | `trust.test.ts`, `TrustDialog.test.tsx` |
| P09-10 | Read-only MCP policy | M5 stage 02 (unchanged) + P08-6 | M5, 15 | existing |
| P09-11 | Bare `/mcp` opens Settings › MCP when Pi's built-in owns it | Composer command handling | 27 | `ComposerCommands.test.tsx` |
| P09-12 | Code mode pane (choice, built-in tools on / only, budget) | `mcp.setCodemode` | 18, 20 | `codemode-settings.test.ts` |
| P10-1 | Loaded skills as the runtime sees them (settings paths, packages, `.agents/skills`) | `skills.list` via `DefaultResourceLoader` | 24, 26 | `skills.test.ts` |
| P10-2 | `disable-model-invocation` switch editing only that frontmatter key | `skills.setInvocation` | 24, 26 | `skill-frontmatter.test.ts` |
| P10-3 | skills.sh search + install | `skills.search`, `skills.install` (pinned CLI, owner m7; a scope per install, "This project" or "All my projects", M7R140) | 24, 26 | `skills-install.test.ts` (fake `npx`, scope rows) |
| P10-4 | Plugins: list, install, remove, update check, enable / disable (global and project) | `plugins.*` via `DefaultPackageManager`, the scope rule of M7R140 | 25, 26 | `plugins.test.ts` |
| P10-5 | Group switches with per-item results | `skills.setInvocation` and `plugins.setEnabled` take lists | 24, 25, 26 | per-item result tests |
| P10-6 | `get_commands` in the composer (extension commands, templates, skills) | `/` menu | 27 | `slash-commands.test.ts` |
| P10-7 | `$skill` chips (T3) | `$` menu → leading `/skill:<name>` chip (owner m8) | 27 | `ComposerCommands.test.tsx` |

## Pre-execution conflict scan

Tasks run one at a time, in order: 1a, 1b, 1c, 2a, 2b, 3, 4, 5, 6a, 6b, 7 … 11, 12a, 12b, 13 … 30. The files shared with M8 are listed in "Merge order and conflict notes".

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1a → 1b | `policy/git-config-guard.ts` `repoConfigRefusal(start, guard)`, `gitGuard(home)`, the `GIT_*` reasons | 1a ships the check standalone. 1b calls it from `judgeGit` for each folder git may run in, with one `GitGuard` per command line. 1b never changes 1a's reading. |
| 1b → 1c → 2a | `policy/command-cover.ts` `coverCommand(command, CoverContext)`, `ShellFacts` (with `gitEnv`) | 1b ships the engine with `prefixes` support unused. 1c wires read-only commands in stage 03 and adds `UNKNOWN_SHELL`. 2a passes prefixes from the grant check. Neither later task changes 1b's matching. |
| 1c → 2a, 15 | `PolicyRules` (`readOnlyCommands`, then `alwaysPrefixes` and `alwaysTools`, then `readOnlyPreset`) | Each adds its own keys with defaults; the strict schema stays strict. |
| 2a → 2b | `ApprovalRequestRecord.alwaysScopes`, `approval_response.scope`, `Dialog.alwaysScopes`, `DialogResponse.scope` | 2a defines them on the worker side and in contracts; 2b stores and shows them. |
| 3 | `search/{extract,scanner-file}.ts`, `sessions/scan-port.ts` | 3 only. It calls `markTainted` through the policy port the sessions module already holds, so `daemon.ts` gets no line. |
| 4 → 5, 15, 19 | `packages/pi-host/src/builtins.ts` `piBuiltins(options)` | 4 creates it. 15 leaves it out for `chat`. 19's Test session builds its own MCP extension with the same factory. |
| 6a → 6b, 8, 10, 11, 12a, 12b, 17, 18, 19, 22, 24, 25 | `kernel/helper/pool.ts` `HelperPool.run`, `contracts/pi-helper.ts` `HelperRun`, the helper `ops/index.ts` op table, `apps/daemon/src/compose-pi.ts` | 6a ships the pool, the protocol, one `ping` op and `compose-pi.ts`. Each later task adds its op to the table, its schemas to `pi-helper.ts` (one entry each) and its module to `compose-pi.ts`. None changes the protocol or `daemon.ts`. |
| 6b → 8, 10, 12a, 17, 18, 22, 24, 25 | `helper/pi-file.ts` `readPiFile`, `writePiFile` | 6b creates the bounded reader and the atomic writer, right after 6a. Later ops reuse them unchanged. |
| 7 → 9, 15, 16, 22 | `session-loadout.ts` `SessionLoadout`, the worker `loadout` record, snapshot `loadout`, event `loadout`, `stores/session-reducer.ts` `SessionView.loadout` | 7 defines the record with `preset: "configured"`; 15 fills `preset` and `tools`. Task 7's ≤ 6 lines are M7's whole budget in `live-session.ts` (agreement 13). |
| 8 → 9, 10, 11, 12a, 12b, 13, 14, 29 | `modules/models/index.ts` `ModelsModule`, the `models.overview` result | 8 creates the module; later tasks add methods and service functions in their own files. |
| 12a → 12b | `modules/models/{service,rpc}.ts`, `helper/jsonc.ts` | 12a adds the editor methods; 12b adds discover, test and pricing, and reads the `models` setting through the settings port. |
| 12b → 14 | `ModelsSettings` (`contracts/settings.ts`, key `models`), `settings.get` / `settings.set` | 12b defines the key and the daemon refusal; 14 renders the switch. |
| 17 → 18, 19, 22 | `helper/mask.ts` `maskMcpEntry`, `helper/ops/mcp-read.ts` `readMcpFiles` | 17 creates them; 18 writes through the same reader; 22 lists project servers with it. |
| 13 → 14, 29 | `features/models/` components (`ProviderList`, `SignInFlow`) | 29 reuses them inside the stepper (lazy). |
| 13 | `apps/web/src/runtime/subscriptions.ts` `OPENERS.login` | 13 adds the opener; its tests go in `subscriptions.m7.test.ts` (agreement 11). |
| 2b, 28 | `features/policy/ApprovalsPanel.tsx`, `RulesByProject.tsx`, `i18n/catalog/settings-approvals.ts` | 2b adds rule kinds; 28 adds the mode list and the read-only switch. |
| 9, 27 | `features/sessions/Composer.tsx` | 9 adds `<ModelBar …/>`. 27 adds the `useComposerCommands` call and `{commands.menu}`, and gives the field `inputRef`, `onKeyDown` and `combobox` (M7R122). M7's whole budget is 3 added lines (agreements 7, 22), and nothing in `use-composer.ts`. |
| 27 | `packages/ui/src/primitives/TextField.tsx` | 27 lands M8R83's six props on this branch, with M8R83's names and semantics. The rebase onto an M8-first `main` keeps `main`'s copy (merge notes). |
| 16, 23 | `features/sessions/SessionScreen.tsx` | One mounted line each (`<SessionTools …/>`, `<TrustBanner …/>`). |
| 13, 20, 26 | `routes/settings/sections.tsx`, `features/workspace/model.ts` `SETTINGS_SECTIONS` | 13 adds `models`, 20 `mcp`, 26 `skills`: one renderer line and one list entry each, each section its own lazy chunk. |
| 7, 15, 2b | `apps/daemon/src/modules/sessions/{snapshot,service-launch,grants}.ts` | Each adds its own lines; `snapshot.ts` stays ≤ 360. |
| 18, 20, 21, 24, 25, 26 | `confirmProtected` on every project-scope Pi method (M7R133) | One rule: a project target requires `confirmProtected: true`. Each task adds it to its own methods' params and its own UI ask. |

## Model table

Decision 75 Q9 sets the models:
- Sonnet implementers on every task, never Haiku (decision 73).
- Sonnet reviewers, or Opus where a wrong change is a security hole or a race.
- Opus for the whole-branch review.

Fix rounds 4–5 may use an Opus implementer, logged.

| # | Task | Implementer | Reviewer | Why Opus |
|---|---|---|---|---|
| 1a | The repository config guard for git (owner m3) | Sonnet | **Opus** | the owner's security contract: a missed config path runs repository code unasked |
| 1b | Read-only command coverage engine and table | Sonnet | **Opus** | a missed shell form runs a command unasked |
| 1c | Read-only commands in stage 03, rules and settings flag, corpus | Sonnet | **Opus** | changes an ask into an allow across modes and taint |
| 2a | Pattern always-rules, worker side | Sonnet | **Opus** | a grant wider than the card said |
| 2b | Pattern rules stored, composed, shown | Sonnet | **Opus** | persistence decides what every later call skips |
| 3 | Taint on outside tool results | Sonnet | **Opus** | a fail-open taint decision: too narrow a condition leaves outside content unfenced and egress unasked (M7-RT-03) |
| 4 | Worker wiring of MCP, codemode, tool-search | Sonnet | **Opus** | classification by source; codemode model calls outside judged calls |
| 5 | Real-worker MCP security tests | Sonnet | **Opus** | exit proof: a weak test is false assurance |
| 6a | Helper pool, protocol, pi-host helper entry, `compose-pi.ts` | Sonnet | **Opus** | process spawning, environment, caps and deadlines |
| 6b | The Pi file boundary (`pi-file.ts`) | Sonnet | **Opus** | the real-path and TOCTOU boundary that every later Pi write goes through (M7-RT-02) |
| 7 | Session model and reasoning | Sonnet | Sonnet | |
| 8 | `models` module: overview, defaults, catalog | Sonnet | Sonnet | |
| 9 | Web: model bar and reasoning menu | Sonnet | Sonnet | |
| 10 | `enabledModels` minimal-edit engine | Sonnet | Sonnet | |
| 11 | Provider sign-in and API keys | Sonnet | **Opus** | credentials in flight and at rest |
| 12a | `models.json` editor backend: masking and save | Sonnet | **Opus** | masking and the write path |
| 12b | Discover, test, pricing (opt-in) | Sonnet | **Opus** | provider keys sent to a base URL; the models.dev opt-in gate |
| 13 | Web: Settings › Models (providers, sign-in, switches) | Sonnet | Sonnet | |
| 14 | Web: `models.json` editor, discover, test, pricing switch | Sonnet | Sonnet | |
| 15 | Tool presets, Chat only, read-only preset rule | Sonnet | **Opus** | stage 00 exposure and a stage 02 rule |
| 16 | Web: preset picker and session tools chip | Sonnet | Sonnet | |
| 17 | MCP overview: reads, masking, project file boundary | Sonnet | **Opus** | secrets to the browser; a repository-controlled file (one of the longest reviews, M7R153) |
| 18 | MCP writes, undo, import, code mode settings | Sonnet | **Opus** | writes Pi files; prototype keys; the undo cap (one of the longest reviews, M7R153) |
| 19 | MCP Test and sign-in guidance | Sonnet | **Opus** | runs a configured command; masked failures |
| 20 | Web: Settings › MCP | Sonnet | Sonnet | |
| 21 | Web: MCP add form and paste importer | Sonnet | Sonnet | |
| 22 | Project trust backend | Sonnet | **Opus** | trust turns on repository code; the breadth rule |
| 23 | Web: trust dialog and banner | Sonnet | Sonnet | |
| 24 | Skills backend, skills.sh search and install | Sonnet | **Opus** | spawn arguments, frontmatter edits, the install scope |
| 25 | Plugins backend | Sonnet | **Opus** | package sources reach npm and git |
| 26 | Web: Settings › Skills (skills and plugins) | Sonnet | Sonnet | |
| 27 | `/` command menu, `$skill` chips, `TextField` props | Sonnet | Sonnet | |
| 28 | M5 UI items, read-only switch | Sonnet | Sonnet | |
| 29 | First-run stepper | Sonnet | Sonnet | |
| 30 | Docs, ADRs, parity run, budgets, final gates | Sonnet | Sonnet | |
| — | Whole-branch review | — | **Opus** | owner rule |

Totals:
- 35 tasks, all with Sonnet implementers.
- 20 Opus reviewers: 1a, 1b, 1c, 2a, 2b, 3, 4, 5, 6a, 6b, 11, 12a, 12b, 15, 17, 18, 19, 22, 24, 25.
- 15 Sonnet reviewers.
- One Opus whole-branch review.

## ETA

| Basis | Figure |
|---|---|
| M5's observed pace (34 tasks, 17 Opus reviews, ≈ 16 h wall clock while M4 ran beside it) | **≈ 20 h wall clock (16–26 h)** for M7's 35 tasks with 20 Opus reviews, plus the final review and its fix round (≈ 2–3 h) |
| Summed agent time at the planning rate of M2–M5 (1–1.5 h per task, 2–2.25 h per Opus-reviewed security task) | ≈ 55 h (48–66 h) |
| Not included | the rebase on M8 (≈ 1.5–2 h: the shared files, the composer chain and `main`'s `TextField`, merge notes), the owner's preview checks |

High end:
- SDK probe rounds: the helper protocol (6a), the codemode script syntax (5), the MCP Test session (19), inline factories under `noExtensions` (15).
- The longest Opus reviews:
  - 1a and 1b, about 930 lines of prescribed code together, already run once at the plan fix;
  - 17 and 18, a security core plus features in one diff, kept whole by M7R153.

Low end: the web tasks (13, 14, 16, 20, 21, 23, 26) pass first review, as most of M5's web tasks did.

## Bundle estimate

Initial bundle after M5: 195.3 KB gzip. The ceiling is 300 KB until M13 (decision 75); stop and ask above 250 KB.

| Task | Initial delta (KB gzip) | Why | Lazy chunks |
|---|---|---|---|
| 1c, 2a, 15, 28 | +0.5 | policy schema keys (`readOnlyCommands`, prefix and tool rules, `readOnlyPreset`, `defaultMode`), approval scopes | — |
| 6a | +0.2 | the `pi` domain, `helper_failed` | — |
| 7, 8, 10, 11, 12a, 12b, 15, 17–19, 22, 24, 25, 27 | +3.0–3.5 | about 35 method schemas (the method catalogue is eager), `loadout`, the `login` stream and its events, the `models` setting | — |
| 9, 16, 23, 27 | 0 | the components live in the session chunk; their menus and dialogs load on open | session chunk +6–9 KB; menus and the trust dialog 2–5 KB each |
| 13, 20, 26 | +0.1 | three section ids | one chunk per section, ≈ 8–15 KB each |
| 27 | +0.1 | M8R83's `TextField` props (`@pap/ui` is eager) | — |
| 29 | ≤ 1 | the stepper shell | the Pi step chunk |
| **Total** | **≈ +4.5 (range 3.5–6) → ≈ 200 KB** | | |

Merged with M8 (≈ +4.4 KB), the total is ≈ 204 KB, under the 250 KB alert (agreement 19).

---

## Tasks

### Task 1a: The repository config guard for git (owner m3, security contract)

Owner answer m3 (M7R136): `git status`, `git diff`, `git log` and the other read-only git commands run unasked only when the repository's own config runs nothing. This task builds the config reader and the check, pure and standalone, so Task 1b's engine can call it for every git segment. Nothing calls it yet. Written and run in a scratch copy at the plan fix: 98 tests pass, and the four mutation checks below fail as named. The reader was compared with `git config -z --file … --list` (git 2.53) on every READS and REFUSES row. It refuses two inputs git accepts, both harmless (a key before any section, `[ "x"]`), and accepts nothing git refuses.

**Files:**
- Create: `packages/pi-host/src/policy/git-config.ts` (the reader and the program keys), `git-config.test.ts`
- Create: `packages/pi-host/src/policy/git-config-guard.ts` (the walk, pointers, includes, bounds), `git-config-guard.test.ts`
- Modify: `knip.json` (`mkfifo` joins the pi-host `ignoreBinaries`, as in the daemon's; Task 6b's FIFO test uses it too)

**Interfaces:**
- Consumes: `kernelResolve` (`kernel-path.ts`, unchanged).
- Produces: `parseGitConfig(text): GitConfigEntry[] | null`, `GitConfigEntry`, `runsProgram(entry)`, `includeOf(entry)`; `repoConfigRefusal(start, guard): Promise<string | null>`, `GitGuard`, `gitGuard(home)`, the reasons `GIT_UNREADABLE` "git config unreadable", `GIT_RUNS_PROGRAM` "git config runs a program", `GIT_INCLUDE` "git config include", `GIT_SUBMODULES` "git submodules", `GIT_TOO_MANY` "too many git config files". Task 1b calls `repoConfigRefusal` from `judgeGit` with one `GitGuard` per command line.

**Rulings (pre-dispatch):**
- M7R136 (owner m3) applies here: what the owner asked for is in "Owner decisions" below.
- M7R147 [1a] What is read. The check starts at the folder git starts in (a real path) and goes up to `/`. It does not stop at the repository git would pick:
  - in every folder, a `.git` folder, or a `.git` file whose `gitdir: <path>` it follows;
  - the `commondir` such a git directory names (a worktree);
  - the folder itself when it holds a `HEAD` (git tries a bare repository when `.git` is missing or invalid).
  
  Each git directory gives `config` and `config.worktree`, and every `include.path` and `includeIf.<any condition>.path` they name: `~/` is the worker's home, a relative path starts at the including file's folder and is walked as the kernel walks it. Limits:
  - an include that is missing, bare, `~user/…` or `%(prefix)/…`, or deeper than git's 10 asks (owner: "an include that cannot be resolved");
  - a config that cannot be read, is not a regular file, is over 64 KiB or does not parse asks (owner: "an unreadable file");
  - at most 32 config files per command line, 64 folder levels;
  - a FIFO or a device is never opened for a blocking read.
  
  Why: git's discovery has corners (an empty `.git` folder is skipped, a bare-shaped folder is a repository, a gitfile points anywhere). Reading more than git reads only ever adds a question, and reading less would let code run unasked. Cost if wrong: a folder with an unrelated `HEAD` file and a `config` or `modules/` beside it asks (rare).
- M7R148 [1a] A repository with submodules asks: a `.gitmodules` in a walked folder, or a `modules/` folder in a git directory. Why: `git status` and `git diff` recurse into submodules, whose configs live under `modules/` or in their own work trees. Cost if wrong: in a repository with submodules, git read commands ask as they did before M7 (named in `policy.md` and the owner checks).
- M7R149 [1a] Program keys are the owner's list, in every spelling git reads (`credential.<url>.helper`, `gpg.<format>.program`), plus three that run a program the same way: `pager.<command>` with a value that is not a boolean, `core.askPass` and `sequence.editor`.
  - Matching is by section and key, whatever the subsection.
  - The key's presence asks whatever its value. `core.fsmonitor = true` asks too: the owner's list names the key.
  
  Why: the owner's rule is "runs nothing", and a value-by-value reading of each key would be a second parser to get wrong. Cost if wrong: a repository with `git lfs install --local` (`filter.lfs.*` in `.git/config`) or a local `core.fsmonitor = true` asks for every git read command. This friction is listed in `policy.md` and the owner checks, and an exact or prefix always-rule removes it for that repository.
- M7R150 [1a, 1b, 1c] Out of scope:
  - The owner's own `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, `/etc/gitconfig` and `GIT_CONFIG_*` variables are not read: they are his.
  - `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR` in the worker's environment makes every git segment ask (`ShellFacts.gitEnv`, Tasks 1b and 1c): git then does not walk up.
  - An exact or prefix always-rule covers a git command without this check, as it skips every read-only judgment (M5 semantics).
  - Residual: a process that rewrites `.git/config` between the check and git's own read. The agent's own write there is a protected M5 write that asks first.
  
  Cost if wrong: none beyond the residual.

- [ ] **Step 1: Write the failing tests**

`git-config.test.ts`: every READS row parses to exactly these `section|subsection|key|value` strings (`<bare>` for a key without `=`), and every REFUSES row is `null`. The rows were checked against `git config -z --file f --list` (git 2.53): git agrees on every READS row, refuses every REFUSES row except `pager = x` and `[ "x"]`, which git accepts and this reader refuses (stricter).

```ts
const READS: ReadonlyArray<readonly [string, string[]]> = [
  ["[core]\n\tpager = less\n", ["core||pager|less"]],
  ["[Core]\n\tPAGER=less", ["core||pager|less"]],
  ['[diff "a b"]\n\ttextconv = x', ["diff|a b|textconv|x"]],
  ["[diff.Foo]\n\tcommand = x", ["diff|foo|command|x"]],
  ["[core] pager = x", ["core||pager|x"]],
  ["[core]pager=x", ["core||pager|x"]],
  ['[core]\n\tpager = "a;b" ; c', ["core||pager|a;b"]],
  ["[core]\n\tpager = a \\\n b", ["core||pager|a  b"]],
  ["[core]\n\tfsmonitor", ["core||fsmonitor|<bare>"]],
  ["\uFEFF[core]\n\tpager=x", ["core||pager|x"]],
  ["[core]\r\n\tpager = x\r\n", ["core||pager|x"]],
  ["# [core]\n; pager = x\n", []],
  ['[s "q\\"u"]\n\tk = v', ['s|q"u|k|v']],
  ["[a]\n\tk = 1 # c\n[b]\n\tk2 = \\t", ["a||k|1", "b||k2|\t"]],
  ["[core]\n\tpager = x\n\t\n[diff]\n\texternal = y", ["core||pager|x", "diff||external|y"]],
];
const REFUSES: readonly string[] = [
  "pager = x", "[core\n]", '[core "x]', '[core "x"\n]', "[]", '[ "x"]', '[core]\n\tpager = "unterminated',
  "[core]\n\tpager = a\\q", "[core]\n\tpager ; x", "[core]\n\t1pager = x", "[core]\n\t_pager = x",
  "[core]\n\tpa ger = x", "[co re]\n\tpager = x", "[core]\n\u0000", "[core]\n\tpager\r= x",
];
```

Also: 4 097 entries → `null`. `runsProgram` is true for `core.fsmonitor` (any value, `true` included), `diff.external`, `diff.x.command`, `diff.x.textconv`, `anything.x.textconv`, `filter.lfs.{clean,smudge,process}`, `core.{pager,editor,sshcommand,askpass}`, `gpg.program`, `gpg.ssh.program`, `credential.helper`, `credential.https://example.com.helper` (empty value too), `sequence.editor`, `pager.log = "sh -c x"` and `core.x.pager`. It is false for `core.bare`, `core.repositoryformatversion`, `diff.renames`, `user.name`, `remote.origin.url`, `pager.log` = `false` / bare / `0` and `filter.lfs.required`. `includeOf` returns the value of `include.path` and `includeif.<cond>.path`, `null` for a bare one, and `undefined` for `core.path`.

`git-config-guard.test.ts` builds repositories by hand: `.git/HEAD`, `objects/`, `refs/` and a `config`, with no git run. The home is a temp folder.
- A clean repository → `null`, from its top and from `src/`.
- **OWNER_KEYS** (one row each, appended to a clean config, checked from `src/`) → `GIT_RUNS_PROGRAM`: `core.fsmonitor`, `diff.external`, `diff "d".command`, `diff "d".textconv`, `filter "lfs".clean`, `.smudge`, `.process`, `core.pager`, `core.editor`, `core.sshCommand`, `gpg.program`, `credential.helper`.
- `config.worktree` with `core.fsmonitor` → `GIT_RUNS_PROGRAM`.
- Unreadable configs:
  - an unparsable config → `GIT_UNREADABLE`;
  - `.git/config` as a FIFO → `GIT_UNREADABLE` without blocking (`vi.waitFor`, 2 s);
  - `.git/config` as a folder → `GIT_UNREADABLE`;
  - 65 KiB → `GIT_UNREADABLE`;
  - mode `000` → `GIT_UNREADABLE` (skipped as root).
- Includes:
  - `include.path = ../extra.cfg` is read from `.git/` (the repository's top), and its `core.pager` → `GIT_RUNS_PROGRAM`;
  - `includeIf "gitdir:/nowhere/"` is still read;
  - `~/inc.cfg` resolves in the home;
  - a clean include → `null`.
- Includes that ask `GIT_INCLUDE`: a missing file, a bare `path`, `~other/x.cfg`, `%(prefix)/x.cfg`, `""`, and an include loop (stopped at depth 10).
- With the file budget lowered to 5, a chain of six includes → `GIT_TOO_MANY`.
- Finding the repository:
  - a worktree (`.git` file → `<main>/.git/worktrees/w`, `commondir` `../..`) reads the main config;
  - a relative `gitdir: ../.git` starts at the `.git` file's folder;
  - a `.git` file without `gitdir: ` → `GIT_UNREADABLE`;
  - `.gitmodules` at the top, or `.git/modules/`, → `GIT_SUBMODULES`;
  - a bare-shaped folder (`HEAD` and `config`) is read;
  - an empty `.git` folder in `src/` does not hide the repository above;
  - a clean inner repository inside a dirty outer one → `GIT_RUNS_PROGRAM`;
  - a `.git` link to a folder is followed.

Mutation checks (the reviewer runs each; the named tests fail; then restores):
- skip includes (`continue` on every entry) → the include rows;
- return at the first `.git` found → "an empty .git folder…" and "every repository up to /…";
- read `config` only → "config.worktree counts";
- open with a plain `O_RDONLY` and no `stat` → the FIFO row times out.

All four were run at the plan fix.

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @pap/pi-host exec vitest run src/policy/git-config` — Expected: FAIL (`Cannot find module './git-config.ts'`).

- [ ] **Step 3: Write the reader**

```ts
// packages/pi-host/src/policy/git-config.ts
/**
 * A reader for git's config files, written to git's own grammar (`config.c`, `git_parse_source`), for one question:
 * does a repository's own config name a program that `git status`, `diff`, `log` or another read-only git command may
 * run (owner decision m3, ADR 0024)? Anything git would refuse, and anything this reader is unsure of, reads as null:
 * the caller then asks.
 */

export interface GitConfigEntry {
  /** The first part of the name, lower case (`diff` in `diff.<driver>.textconv`). */
  readonly section: string;
  /** The middle part as git keeps it (`[a "B"]` gives `B`, `[a.B]` gives `b`), or null. */
  readonly subsection: string | null;
  /** The last part, lower case. */
  readonly key: string;
  /** null for a bare key, which git reads as `true`. */
  readonly value: string | null;
}

export const MAX_GIT_CONFIG_ENTRIES = 4096;
/** git's `isspace` once `\r\n` is a line break: `\n` ends a line, these are blanks. */
const BLANK: ReadonlySet<string> = new Set([" ", "\t", "\r"]);
const ALPHA = /^[A-Za-z]$/;
const KEY_CHAR = /^[A-Za-z0-9-]$/;
const ESCAPES: Readonly<Record<string, string>> = { t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' };

const lineEnd = (text: string, at: number): number => {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
};

/** `[section]`, `[section.sub]` or `[section "sub"]`, from just after the `[`: the name stem, or null. */
function readHeader(text: string, start: number): { readonly stem: string; readonly next: number } | null {
  let at = start;
  let stem = "";
  for (;;) {
    const c = text[at++];
    if (c === undefined || c === "\n") return null;
    if (c === "]") return stem === "" ? null : { stem, next: at };
    if (BLANK.has(c)) break;
    if (!KEY_CHAR.test(c) && c !== ".") return null;
    stem += c.toLowerCase();
  }
  if (stem === "") return null;
  while (BLANK.has(text[at] ?? "")) at++;
  if (text[at++] !== '"') return null;
  let sub = "";
  for (;;) {
    let c = text[at++];
    if (c === undefined || c === "\n") return null;
    if (c === '"') break;
    if (c === "\\") {
      c = text[at++];
      if (c === undefined || c === "\n") return null;
    }
    sub += c;
  }
  if (text[at++] !== "]") return null;
  return { stem: `${stem}.${sub}`, next: at };
}

/** git's `parse_value`, from just after the `=`: quotes, the five escapes, `\` before a line break, comments, trimming. */
function readValue(text: string, start: number): { readonly value: string; readonly next: number } | null {
  let at = start;
  let value = "";
  let quote = false;
  let comment = false;
  let trim = 0;
  for (;;) {
    const c = at < text.length ? (text[at++] as string) : "\n";
    if (c === "\n") {
      if (quote) return null;
      return { value: trim > 0 ? value.slice(0, trim) : value, next: at };
    }
    if (comment) continue;
    if (BLANK.has(c) && !quote) {
      if (trim === 0) trim = value.length;
      if (value.length > 0) value += c;
      continue;
    }
    if (!quote && (c === ";" || c === "#")) {
      comment = true;
      continue;
    }
    trim = 0;
    if (c === "\\") {
      const next = at < text.length ? (text[at++] as string) : "\n";
      if (next === "\n") continue;
      const escaped = ESCAPES[next];
      if (escaped === undefined) return null;
      value += escaped;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}

function entryOf(stem: string, key: string, value: string | null): GitConfigEntry {
  const dot = stem.indexOf(".");
  return dot === -1
    ? { section: stem, subsection: null, key, value }
    : { section: stem.slice(0, dot), subsection: stem.slice(dot + 1), key, value };
}

/** Every entry of a config file in order, or null when git would refuse the file or this reader is unsure. */
export function parseGitConfig(raw: string): GitConfigEntry[] | null {
  const text = (raw.startsWith("\uFEFF") ? raw.slice(1) : raw).replaceAll("\r\n", "\n");
  const entries: GitConfigEntry[] = [];
  let stem: string | null = null;
  let at = 0;
  while (at < text.length) {
    const c = text[at] as string;
    if (c === "\n" || BLANK.has(c)) {
      at++;
      continue;
    }
    if (c === "#" || c === ";") {
      at = lineEnd(text, at);
      continue;
    }
    if (c === "[") {
      const header = readHeader(text, at + 1);
      if (header === null) return null;
      stem = header.stem;
      at = header.next;
      continue;
    }
    // A key before any section, or a line git cannot read: git stops with "bad config line".
    if (!ALPHA.test(c) || stem === null) return null;
    let end = at + 1;
    while (end < text.length && KEY_CHAR.test(text[end] as string)) end++;
    const key = text.slice(at, end).toLowerCase();
    at = end;
    while (text[at] === " " || text[at] === "\t") at++;
    let value: string | null = null;
    if (at < text.length && text[at] !== "\n") {
      if (text[at] !== "=") return null;
      const read = readValue(text, at + 1);
      if (read === null) return null;
      value = read.value;
      at = read.next;
    }
    if (entries.length >= MAX_GIT_CONFIG_ENTRIES) return null;
    entries.push(entryOf(stem, key, value));
  }
  return entries;
}

/**
 * Keys whose value git runs as a program, by section (owner m3: `core.fsmonitor`, `diff.external`, `diff.*.command`,
 * `*.textconv`, `filter.*.{clean,smudge,process}`, `core.pager`, `core.editor`, `core.sshCommand`, `gpg.program`,
 * `credential.helper`), each in every spelling git reads (`credential.<url>.helper`, `gpg.<format>.program`), plus
 * `pager.<command>`, `core.askPass` and `sequence.editor`, which run a program the same way. The subsection is never
 * looked at: `[core "x"] pager` asks too.
 */
const RUNS_PROGRAM: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["core", new Set(["fsmonitor", "pager", "editor", "sshcommand", "askpass"])],
  ["diff", new Set(["external", "command"])],
  ["filter", new Set(["clean", "smudge", "process"])],
  ["gpg", new Set(["program"])],
  ["credential", new Set(["helper"])],
  ["sequence", new Set(["editor"])],
]);
/** `pager.<command>` takes a boolean (pager on or off) or a program. */
const GIT_BOOLEAN = /^(?:|true|false|yes|no|on|off|[+-]?\d+)$/i;

export function runsProgram(entry: GitConfigEntry): boolean {
  if (entry.key === "textconv") return true;
  if (entry.section === "pager") return entry.value !== null && !GIT_BOOLEAN.test(entry.value);
  return RUNS_PROGRAM.get(entry.section)?.has(entry.key) ?? false;
}

/** The value of an `include.path` or `includeIf.<condition>.path` (every condition counts), null when bare, else undefined. */
export function includeOf(entry: GitConfigEntry): string | null | undefined {
  if (entry.key !== "path" || (entry.section !== "include" && entry.section !== "includeif"))
    return undefined;
  return entry.value;
}
```

- [ ] **Step 4: Write the check**

```ts
// packages/pi-host/src/policy/git-config-guard.ts
import { constants } from "node:fs";
import { type FileHandle, lstat, open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { includeOf, parseGitConfig, runsProgram } from "./git-config.ts";
import { kernelResolve } from "./kernel-path.ts";

/**
 * Owner decision m3 (ADR 0024): a read-only git command runs unasked only when the repository's own config runs
 * nothing. From the folder git starts in up to `/`, every folder's `.git` (a folder, or a `gitdir:` file), its
 * `commondir`, and the folder itself when it looks like a bare repository are read: `config`, `config.worktree` and
 * every `include` / `includeIf` target, whatever the condition. Walking past the repository git would pick and reading
 * conditional includes git might skip only ever adds questions. The owner's own `~/.gitconfig` and `/etc/gitconfig`
 * are not read: they are his.
 */

export const MAX_GIT_CONFIG_BYTES = 64 * 1024;
/** Config files read for one command line, includes counted; past it the command asks. */
export const MAX_GIT_CONFIG_FILES = 32;
/** git's own include depth limit. */
const MAX_INCLUDE_DEPTH = 10;
const MAX_LEVELS = 64;
const MAX_POINTER_BYTES = 4096;

export const GIT_UNREADABLE = "git config unreadable";
export const GIT_RUNS_PROGRAM = "git config runs a program";
export const GIT_INCLUDE = "git config include";
export const GIT_SUBMODULES = "git submodules";
export const GIT_TOO_MANY = "too many git config files";

/** The check's state for one command line. */
export interface GitGuard {
  readonly home: string;
  /** Config files left to read. */
  files: number;
  /** Folders already judged, so two git segments in one tree read nothing twice. */
  readonly seen: Set<string>;
}
export const gitGuard = (home: string): GitGuard => ({ home, files: MAX_GIT_CONFIG_FILES, seen: new Set() });

type Why = string | null;
type Read = { readonly text: string } | "missing" | "unreadable";

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** A small regular file, links followed as git follows them; a FIFO or a device is never opened for a blocking read. */
async function readSmall(path: string, max: number): Promise<Read> {
  let handle: FileHandle;
  try {
    if (!(await stat(path)).isFile()) return "unreadable";
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return isMissing(error) ? "missing" : "unreadable";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return "unreadable";
    const bytes = await handle.readFile();
    return bytes.length > max ? "unreadable" : { text: bytes.toString("utf8") };
  } catch {
    return "unreadable";
  } finally {
    await handle.close();
  }
}

/** Whether anything (a dangling link included) is at `path`; an error other than "missing" counts as present. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

/** The folder a `.git` file (`gitdir: <path>`) or a `commondir` file names, as git resolves it from `from`. */
async function pointer(path: string, prefix: string, from: string): Promise<string | null | "missing"> {
  const read = await readSmall(path, MAX_POINTER_BYTES);
  if (read === "missing") return "missing";
  if (read === "unreadable") return null;
  const text = read.text.replace(/[\r\n]+$/, "");
  if (!text.startsWith(prefix)) return null;
  const target = text.slice(prefix.length);
  if (target === "" || /[\0\n]/.test(target)) return null;
  try {
    return await kernelResolve(from, target);
  } catch {
    return null;
  }
}

/** git's `interpolate_path` for an include: `~/` is the home; a relative path starts at the including file's folder. */
async function includeTarget(value: string, from: string, home: string): Promise<string | null> {
  if (value === "" || value.includes("\0")) return null;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  if (value.startsWith("~") || value.startsWith("%(")) return null;
  try {
    return isAbsolute(value) ? value : await kernelResolve(from, value);
  } catch {
    return null;
  }
}

async function configRefusal(path: string, depth: number, guard: GitGuard): Promise<Why> {
  const read = await readSmall(path, MAX_GIT_CONFIG_BYTES);
  // git skips a missing include silently; the owner asked for a question instead (m3).
  if (read === "missing") return depth === 0 ? null : GIT_INCLUDE;
  if (read === "unreadable") return GIT_UNREADABLE;
  if (--guard.files < 0) return GIT_TOO_MANY;
  const entries = parseGitConfig(read.text);
  if (entries === null) return GIT_UNREADABLE;
  for (const entry of entries) {
    if (runsProgram(entry)) return GIT_RUNS_PROGRAM;
    const include = includeOf(entry);
    if (include === undefined) continue;
    const target =
      include === null || depth >= MAX_INCLUDE_DEPTH
        ? null
        : await includeTarget(include, dirname(path), guard.home);
    if (target === null) return GIT_INCLUDE;
    const why = await configRefusal(target, depth + 1, guard);
    if (why !== null) return why;
  }
  return null;
}

/** A git directory: its `config` and `config.worktree`, and those of the common directory a worktree's names. */
async function gitDirRefusal(gitDir: string, guard: GitGuard): Promise<Why> {
  const common = await pointer(join(gitDir, "commondir"), "", gitDir);
  if (common === null) return GIT_UNREADABLE;
  for (const dir of common === "missing" ? [gitDir] : [gitDir, common]) {
    // A submodule's own config lives under `modules/`: its git commands ask (git status recurses into it).
    if (await present(join(dir, "modules"))) return GIT_SUBMODULES;
    for (const name of ["config", "config.worktree"]) {
      const why = await configRefusal(join(dir, name), 0, guard);
      if (why !== null) return why;
    }
  }
  return null;
}

async function folderRefusal(folder: string, guard: GitGuard): Promise<Why> {
  const dotGit = join(folder, ".git");
  let kind: "missing" | "folder" | "file" | "other";
  try {
    const info = await stat(dotGit);
    kind = info.isDirectory() ? "folder" : info.isFile() ? "file" : "other";
  } catch (error) {
    kind = isMissing(error) ? "missing" : "other";
  }
  if (kind === "other") return GIT_UNREADABLE;
  if (kind !== "missing") {
    const gitDir = kind === "folder" ? dotGit : await pointer(dotGit, "gitdir: ", folder);
    if (gitDir === null || gitDir === "missing") return GIT_UNREADABLE;
    const why = await gitDirRefusal(gitDir, guard);
    if (why !== null) return why;
  }
  if (await present(join(folder, ".gitmodules"))) return GIT_SUBMODULES;
  // The folder itself as a bare repository: git tries it when its `.git` is missing or not a repository.
  return (await present(join(folder, "HEAD"))) ? gitDirRefusal(folder, guard) : null;
}

/** Why git started in `start` (a real path) could run a program a repository's config names, or null. */
export async function repoConfigRefusal(start: string, guard: GitGuard): Promise<Why> {
  let folder = start;
  for (let level = 0; level <= MAX_LEVELS; level++) {
    if (!guard.seen.has(folder)) {
      guard.seen.add(folder);
      const why = await folderRefusal(folder, guard);
      if (why !== null) return why;
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return "git folder too deep";
}
```

- [ ] **Step 5: Run the tests and see them pass; run the mutation checks of Step 1** — `pnpm --filter @pap/pi-host exec vitest run src/policy/git-config` → PASS (98 tests at the plan fix); then the per-task gate (no `test:int`: nothing runs it yet).

- [ ] **Step 6: Commit**

```bash
git add packages/pi-host/src/policy/git-config*.ts knip.json
git commit -m "feat(policy): a git config check that finds programs a repository's own config would run"
```

### Task 1b: The read-only command coverage engine (security contract)

Decision 75 Q6. A pure, bounded engine that says whether every simple command of a shell line only reads, lists or prints. It judges with M5's own reader (`shell-words.ts`) and M5's own protected-read check (`checkReadTarget`), and runs Task 1a's config check for every git segment. It also does the prefix matching that Task 2a will feed. Nothing calls it yet.

Run in a scratch copy at the plan fix. Tests: 170 here (RUNS, context, ASKS, git), 268 with Task 1a's, 2 058 for the whole `policy/` folder. The run found two defects in the planner's code, both fixed below:
- `git -C a -C b` was judged as two separate folders, while git composes them: `git -C src -C ../../agent grep --no-index token` read Pi's agent folder unasked. Operands were also judged from the session folder instead of the `-C` folder.
- `rg --hostname-bin=<program>` runs that program (probed with ripgrep 15.1). `tree -R` writes `00Tree.html` files.

**Files:**
- Create: `packages/pi-host/src/policy/read-only-commands.ts` (the table)
- Create: `packages/pi-host/src/policy/command-cover.ts` (the engine), `command-cover-judge.ts` (shared types and path judging), `command-cover-git.ts` (git's words, `-C`, the config check)
- Create: `packages/pi-host/src/policy/command-cover.test.ts` (RUNS table, context refusals, bounds), `command-cover.hostile.test.ts` (ASKS table), `command-cover.git.test.ts`, `cover-bed.ts` (the shared bed, a test helper beside them)

**Interfaces:**
- Consumes: `readCommandsWithDoubt`, `argvOf`, `Segment`, `CommandTooLong`, `CommandTooComplex` (`shell-words.ts`); `checkReadTarget` (`read-target.ts`); `realTarget`, `within` (`target-path.ts`); `kernelResolve` (`kernel-path.ts`); `repoConfigRefusal`, `gitGuard` (Task 1a). None of the M5 ones changes.
- Produces: `coverCommand(command: string, ctx: CoverContext): Promise<Cover>`, `CoverContext`, `ShellFacts` (with `gitEnv`), `Cover`, `READ_ONLY_COMMANDS`, `GIT_READ_ONLY`, `MAX_COVERED_SEGMENTS` (32), `MAX_JUDGED_PATHS` (64). Task 1c calls it with `readOnly: true` and adds `UNKNOWN_SHELL`; Task 2a calls it with `prefixes`.

**Rulings (pre-dispatch):**
- M7R1 [1b, 1c] A segment is covered only when all of these hold:
  - nothing stands before the command word: no assignment, wrapper or keyword (`argvOf` stripped nothing);
  - the command word is bare (no `/`);
  - no word holds `$` or a backquote (the reader turns substitutions into `$(…)` placeholders, so a substitution is never covered);
  - no word has a brace-expansion shape (`{` with `,` or `..`);
  - every redirection is one of: input from a judged file, a here-document or here-string, a descriptor duplication, or output to `/dev/null`.
  
  Why: each of these lets a "read" command write, run another program or read a path the policy did not see. Cost if wrong: an ordinary command with a variable or `{a,b}` asks (the M5 status quo).
- M7R2 [1b] Each of these is judged with `checkReadTarget` as the built-in of the same reach would be (`read` for content, `grep` for recursive content, `find` for recursive names, `ls` for names):
  - every operand;
  - every `=value` of a long option;
  - every possible attached value of a short cluster: each suffix after the first six letters, and the rest of the word from its first `/` or `~`.
  
  A glob operand is judged by its static folder with `grep` (or `find`) reach. `~` and `~/…` expand to the worker's home; `~user`, `~+` and `~-` are not covered. Why: one protected-read rule for built-ins and shell reads (M5R29), and a word whose role the engine cannot know (pattern or path) is judged as a path. Cost if wrong: a rare false ask (`date -Iseconds`, `jq '{a: 1, b: 2}'`).
- M7R3 [1b] *(changed at the plan fix)* Which folders are judged:
  - `rg`, `grep`, `egrep`, `fgrep`, `tree`, `du` and every git subcommand also judge the session folder (a pattern may be the only operand; `tree -L 2` has a number for an operand);
  - `ls` and `find` judge it only when no operand names a path;
  - git judges the folder it runs in instead. `-C a -C b` composes as `cd a; cd b`, and an absolute `-C` starts again (git's rule). git's operands are judged from that folder, both as spelled and as the kernel walks it.
  
  Why: `rg token` from `$HOME` must not search `~/.pi/agent`, and `git -C src -C ../../agent grep --no-index token` must find the agent folder (the defect found at the plan fix). Cost if wrong: these ask when the session runs from `$HOME` or above, as M5's built-in `grep` does.
- M7R4 [1b] `cd <literal>` is covered and adds folders against which later relative paths are judged: every target is resolved against every folder collected so far (at most 8). `cd -`, `cd` with an option, `cd` with an expansion and any `cd` while `CDPATH` is set are not covered. Why: `cd ~/.pi && cd agent && cat auth.json` must find the auth file. Cost if wrong: `cd a && cd b && cd c …` beyond 8 folders asks.
- M7R5 [1b] Nothing is covered when the shell adds code of its own:
  - a non-empty `shellCommandPrefix` or a `shellPath`;
  - `BASH_ENV` or `ENV` set;
  - a `PATH` with an empty or relative entry, or an entry (as spelled or resolved) inside the session folder.
  
  Git segments are not covered either when `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR` is set (M7R150). Why: Pi runs `bash -c` with the prefix first (`docs/shell-aliases.md`, aliases included), and a session-folder PATH entry runs files the agent may write without a question. Cost if wrong: an owner with a prefix or a project-local PATH gets M5's behaviour (every command asks), and the Settings copy says so (Task 28).
- M7R6 [1b] *(changed at the plan fix: `rg --hostname-bin`, `tree -R`)* The table refuses these options, in every abbreviation GNU getopt accepts (three characters or more) and in every short cluster:
  - `sort -o --output --compress-program --files0-from`;
  - `wc` and `du` `--files0-from`;
  - `file -C --compile`;
  - `date -s --set`;
  - `tree -o -R --fromfile`;
  - `rg --pre --hostname-bin`;
  - find's `-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls -files0-from`;
  - git's `--output --ext-diff --textconv` (diff, log, show, stash list), `--textconv --filters` (cat-file), and `-O --open-files-in-pager --textconv` (grep).
  
  Also:
  - `uniq` takes at most one operand;
  - git global options other than `--no-pager`, `-P`, `--no-optional-locks` and `-C <dir>` are refused (`-c`, `--config-env`, `--exec-path`, `--git-dir`, `--work-tree`, `-p`, `--paginate`);
  - `git branch` and `git remote` accept only listing options;
  - `git stash` and `git worktree` accept only `list`.
  
  Why: these are the documented ways each tool writes, runs a program or reads a file list. Cost if wrong: an option missing from the list runs unasked; mitigated by the Opus review, the ASKS table and the probes of the plan fix.
- M7R7 [1b] Not on the list by design:
  - pagers and editors (`less`, `more`, `man`, `vim`);
  - interpreters (`awk`, `sed`, `perl`, `python`, `node`);
  - `xargs`, `env`, `printenv`, `tee`;
  - `git config`, `git tag`, `git reflog`;
  - network clients and package managers.
  
  Why: shell escapes, programs as arguments, or writes. Cost if wrong: they ask, as today.
- M7R8 [1b] A failure inside the engine (an fs error, a bug) answers "not covered" with one bounded stderr line, never a throw. Why: this engine can only turn a question into an allow, so failing toward the question is fail-safe and keeps the call usable. Cost if wrong: a bug that always throws makes every command ask again (visible at once in the corpus test).
- M7R9 [1b] Bounds: 32 segments; 64 path judgments (each base counts, `-C` folders included); 8 cd folders; 64 PATH entries; 32 git config files (M7R147). Beyond any of them: "not covered". Why: bounded work per call on an attacker-chosen command. Cost if wrong: a long pipeline asks.
- M7R10 [1b] *(changed at the plan fix: the `.git/config` vector is now checked, M7R136)* Documented residuals (`docs/agents/policy.md`, Task 30):
  - M7R150's race on `.git/config`, and the owner's own global git config (his choice);
  - an alias or function from an earlier approved command does not persist (Pi starts a fresh `bash -c` per call);
  - `/proc/<pid>/environ`, `ps e` output and other files outside pap's protected list are readable, exactly like the built-in `read`.
  
  Cost if wrong: none beyond what the built-in `read` allows.

- [ ] **Step 1: Write the failing tests**

`cover-bed.ts` (imported by the three test files only) builds the shared bed:
- `base` is a temp folder that is also the home;
- `cwd = base/proj`, a hand-made clean repository: `.git/HEAD`, `.git/objects/`, `.git/refs/`, `.git/config` = `[core] repositoryformatversion = 0, bare = false`, plus `src/a.ts`, `README.md`, `a.txt`, `b.txt`;
- `agentDir = base/agent`, with `auth.json` and `sessions/x.jsonl`;
- `papHome = base/pap`, with `state.db` and `secrets/k`;
- `SAFE_SHELL = { commandPrefix: undefined, shellPath: undefined, startupFile: false, cdPath: false, gitEnv: false, path: "/usr/local/bin:/usr/bin:/bin" }`;
- `ctx(over)`, which builds a `CoverContext` (`readOnly: true`).

```ts
// command-cover.test.ts (runs: every one must be covered)
const RUNS: readonly string[] = [
  "cat README.md", "head -n 20 src/a.ts", "tail -5 README.md", "ls", "ls -la src", "tree -L 2", "wc -l src/*.ts",
  "stat src", "du -sh src", "diff a.txt b.txt", "sort a.txt | uniq -c", "cat README.md | jq .scripts",
  "rg TODO", "rg -n foo 2>/dev/null | head -20", "grep -rn foo src", "find . -name '*.ts' -not -path './node_modules/*'",
  "pwd", "echo hello", "date", "cd src && ls", "(cat a.txt)", "cat a.txt &",
  "git status", "git status --short", "git diff --stat HEAD~3", "git diff -- src/a.ts", "git log --oneline -20",
  "git log -5 --stat", "git show HEAD~1 --stat", "git branch -a", "git blame src/a.ts", "git rev-parse HEAD",
  "git ls-files | wc -l", "git stash list", "git remote -v", "git --no-pager log -3", "git -C src status",
  "cat <<'EOF'\nhello\nEOF", "wc -l < a.txt",
];
it.each(RUNS)("covers %s", async (command) => {
  expect(await coverCommand(command, ctx())).toEqual({ covered: true });
});
```

Context and bounds cases (each `covered: false` with the exact `why`):
- `commandPrefix: "shopt -s expand_aliases"` → "shell command prefix";
- `shellPath: "/bin/bash"` → "custom shell";
- `startupFile: true` → "shell startup file";
- `path: ".:/usr/bin"` and `path: "/usr/bin::/bin"` → "PATH entry not absolute";
- `path: "<cwd>/bin:/usr/bin"` → "PATH entry inside the session folder", and the same through a symlink `base/linkbin → proj/bin`;
- `path: undefined` → "PATH entry not absolute";
- `cdPath: true` with `cd src && ls` → "CDPATH is set";
- 33 segments (`ls;` × 33) → "segment count";
- `cat` with 65 operands → "too many paths";
- a 70 000-character command → "unreadable";
- nine `cd` → "too many folders";
- `readOnly: false` with `ls` → "not allowed".

Prefixes `[["pnpm","test"]]` with `readOnly: false`: `pnpm test -- src/a.test.ts` is covered, `pnpm test && ls` is not ("not allowed"), and neither is `pnpm build`.

```ts
// command-cover.hostile.test.ts (each must NOT be covered; `why` pinned where it names the guard)
const ASKS: ReadonlyArray<readonly [string, string | null]> = [
  ["cat ~/agent/auth.json", "protected path"],
  ["cat -- ~/agent/auth.json", "protected path"],
  ["cat ~/pap/state.db", "protected path"],
  ["ls ~/pap/secrets", "protected path"],
  ["cat ~/agent/sessions/x.jsonl", "protected path"],
  ["cat ~/ag*/auth.json", "searches pap's data directory"],
  ["rg token ~/agent", "searches pap's data directory"],
  ["grep -r token ~", "searches pap's data directory"],
  ["diff -r ~ /tmp", "searches pap's data directory"],
  ["cd ~/agent && cat auth.json", "protected path"],
  ["cd ~ && cd agent && cat auth.json", "protected path"],
  ["git -C ~/agent log", "searches pap's data directory"],
  ["git diff --no-index ~/agent/auth.json /dev/null", "protected path"],
  ["grep -f~/agent/auth.json x", "protected path"],
  ["grep -f<agentDir>/auth.json x", "protected path"], // <agentDir> replaced by the absolute bed path
  ["cat $HOME/agent/auth.json", "expansion"],
  ["cat {~/agent/auth.json,x}", "expansion"],
  ["echo $(id)", "expansion"], ["echo `id`", "expansion"], ['cat "$(printf x)"', "expansion"], ["cat $'x'", "expansion"],
  ["ls ~root", "home folder of another user"], ["cat ~+/x", "home folder of another user"],
  ["LD_PRELOAD=x.so cat a.txt", "wrapper, assignment or keyword"], ["env cat a.txt", "wrapper, assignment or keyword"],
  ["sudo cat a.txt", "wrapper, assignment or keyword"], ["timeout 5 cat a.txt", "wrapper, assignment or keyword"],
  ["command cat a.txt", "wrapper, assignment or keyword"], ["exec cat a.txt", "wrapper, assignment or keyword"],
  ["if true; then cat a.txt; fi", "wrapper, assignment or keyword"], ["./cat a.txt", "wrapper, assignment or keyword"],
  ["/bin/cat a.txt", "wrapper, assignment or keyword"],
  ["cat a.txt > b.txt", "redirection"], ["cat a.txt >> b.txt", "redirection"], ["cat a.txt 2>err.txt", "redirection"],
  ["cat a.txt &>out", "redirection"], ["cat a.txt >&out", "redirection"], ["cat a.txt <> b.txt", "redirection"],
  ["cat a.txt | sh", "not a read-only command"], ["cat a.txt | tee b.txt", "not a read-only command"],
  ["cat a.txt | xargs rm", "wrapper, assignment or keyword"], ["cat a.txt; rm b.txt", "not a read-only command"],
  ["cat <(sh -c id)", "not a read-only command"],
  ["less a.txt", "not a read-only command"], ["man ls", "not a read-only command"], ["vim a.txt", "not a read-only command"],
  ["awk 1 a.txt", "not a read-only command"], ["sed -n 1p a.txt", "not a read-only command"],
  ["python3 -c 1", "not a read-only command"], ["printenv", "not a read-only command"],
  ["rg --pre sh foo", "refused option"], ["rg --pre=sh foo", "refused option"], ["rg --pr sh foo", "refused option"],
  ["find . -exec rm {} ;", "refused option"], ["find . -delete", "refused option"], ["find . -fprint out", "refused option"],
  ["find -files0-from list", "refused option"],
  ["sort -o out a.txt", "refused option"], ["sort --out=x a.txt", "refused option"], ["sort -uo x a.txt", "refused option"],
  ["sort --compress-program=sh a.txt", "refused option"], ["wc --files0-from=list", "refused option"],
  ["du --files0-from=list", "refused option"], ["tree -o out", "refused option"], ["file -C -m x", "refused option"],
  ["date -s 2020-01-01", "refused option"], ["date --set=x", "refused option"],
  ["find -L ~/agent -name x", "searches pap's data directory"],
  ["ls -R ~/pap", "searches pap's data directory"], ["ls -laR ~", "searches pap's data directory"],
  ["ls --recursive ~/agent", "searches pap's data directory"], ["cat < ~/agent/auth.json", "protected path"],
  ["cat 0<~/agent/auth.json", "protected path"], ["diff <(cat ~/agent/auth.json) a.txt", "protected path"],
  ["diff --to-file=~/agent/auth.json a.txt", "protected path"], ["exec 3<~/agent/auth.json", "wrapper, assignment or keyword"],
  ["stat -c %n ~/pap/secrets/*", "protected path"], ["rg --files ~/pap", "searches pap's data directory"],
  ["rg --hostname-bin=./x.sh foo", "refused option"], ["rg --hostname-bin ./x.sh foo", "refused option"],
  ["tree -R -H . src", "refused option"],
  ["uniq a.txt b.txt", "too many operands"],
  ['cat "${a:-\'x\'}"', "unsure reading"],
];
it.each(ASKS)("does not cover %s", async (command, why) => {
  const result = await coverCommand(command.replace("<agentDir>", bed.agentDir), ctx());
  expect(result.covered).toBe(false);
  if (why !== null) expect(result).toEqual({ covered: false, why });
});
it("judges the session folder for rg when the session runs from home", async () => {
  expect(await coverCommand("rg token", ctx({ cwd: bed.base }))).toEqual({
    covered: false, why: "searches pap's data directory",
  });
});
```

`command-cover.git.test.ts`, each `covered: false` with the `why` pinned:
- "git option": `git -c core.pager=sh log`, `git --exec-path=/tmp log`, `git -p log`, `git --paginate log`.
- "refused option": `git log --output=/tmp/x`, `git log --out=x`, `git diff --ext-diff`, `git diff --textconv`, `git show --output=x`, `git stash list --output=x`, `git grep -O vim foo`, `git grep --open-files-in-pager foo`, `git cat-file --filters HEAD:x`.
- "git listing only": `git branch new-feature`, `git branch -D x`, `git branch -m a b`, `git remote add o u`, `git remote show origin`, `git stash`, `git stash pop`, `git worktree add x`.
- "not a read-only git command": `git tag v1`, `git config --list`, `git push`, `git reflog`.
- "searches pap's data directory": `git status` from `cwd: bed.base`, and `git -C src -C ../../agent grep --no-index token` (`-C` composes).
- "protected path": `git -C src diff --no-index ../../agent/auth.json /dev/null` (operands from the `-C` folder).
- "git environment": `gitEnv: true` with `git status`.
- Owner m3, "git config runs a program": a hand-made repository `vendor/dirty` whose `.git/config` sets `core.fsmonitor = ./hook.sh`. Each of these is refused: `cd vendor/dirty && git status`, `git -C vendor/dirty status`, `git -C vendor -C dirty log -1`, `cd vendor/dirty && git diff`, `… git show HEAD`, `… git blame x`, `… git grep foo`, `… git ls-files`, and `git status && git -C vendor/dirty log`. `git status` in the clean bed repository is still covered.

Covered: `git branch --list 'feat*'`, `git -C src log -1`.

Mutation checks (the reviewer runs each; the named test must fail; then restores):
- drop the `$` test in `literal` → "cat $HOME…";
- drop the brace test → "cat {~/agent…";
- let `redirection` accept any output target → "cat a.txt > b.txt";
- delete `--pre` from rg's refusals → "rg --pre sh foo";
- delete `--hostname-bin` → "rg --hostname-bin=./x.sh foo";
- skip `shellRefusal` → the prefix case;
- make `cd` targets resolve against `cwd` only → "cd ~ && cd agent…";
- drop `root: "always"` from rg → "judges the session folder for rg…";
- drop the short-cluster suffixes in `optionValues` → "grep -f~/agent…";
- judge each `-C` folder alone, as the planner's code did → the two `-C` rows;
- skip `repoConfigRefusal` in `judgeGit` → the owner m3 rows.

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @pap/pi-host exec vitest run src/policy/command-cover` — Expected: FAIL (`Cannot find module './command-cover.ts'`).

- [ ] **Step 3: Write the table**

```ts
// packages/pi-host/src/policy/read-only-commands.ts
// packages/pi-host/src/policy/read-only-commands.ts
/**
 * The read-only command allowlist (decision 75 Q6, ADR 0024): shell commands that only read, list or print. A rule says
 * how the command's operands are judged and names every option that makes it write a file, run another program or read
 * a list of files from a file, in each spelling GNU getopt accepts. A command that is not here is not read-only (M7R7).
 */

/** How a path is judged: as the built-in tool of the same reach would be (`checkReadTarget`, M5R29). */
export type Reach = "read" | "grep" | "find" | "ls";

export interface Refusals {
  /** Short option letters refused anywhere in a cluster: `-o`, `-uo`, `-ofile`. */
  readonly short?: string;
  /** Long options refused in every abbreviation of three characters or more, with or without `=value`. */
  readonly long?: readonly string[];
  /** Single-dash words refused exactly (find's actions). */
  readonly exact?: readonly string[];
}

export interface CommandRule {
  /** How each operand is judged; `null`: operands are text, not paths (`echo`, `date`). */
  readonly operands: Reach | null;
  /** The session folder is judged too: always (M7R3), or only when no operand names a path (`ls`, `find`). */
  readonly root?: "always" | "bare";
  readonly refuse?: Refusals;
  /** More operands than this and the command writes (`uniq IN OUT`). */
  readonly maxOperands?: number;
  /** find: operands are the words before the first expression word; the rest is an expression, not paths. */
  readonly expression?: true;
  /** An option that makes a name lister walk a tree (`ls -R`): its operands are then judged like `find`'s. */
  readonly recursive?: { readonly short: string; readonly long: string };
}

const FILES0 = "--files0-from";
const reads = (refuse?: Refusals, more: Partial<CommandRule> = {}): CommandRule => ({
  operands: "read",
  ...(refuse ? { refuse } : {}),
  ...more,
});
const TEXT: CommandRule = { operands: null };
const SEARCH: CommandRule = { operands: "grep", root: "always" };
const FIND_ACTIONS = [
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from",
];
const CONTENT = [
  "cat", "head", "tail", "nl", "stat", "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum", "strings",
  "od", "cmp", "tac", "rev", "cut", "paste", "comm", "join", "fold", "jq",
];
const PRINTS = [
  "tr", "basename", "dirname", "echo", "printf", "true", "false", "pwd", "whoami", "id", "uname", "nproc", "uptime",
  "free", "df", "ps", "which",
];

export const READ_ONLY_COMMANDS: ReadonlyMap<string, CommandRule> = new Map<string, CommandRule>([
  ...CONTENT.map((name): [string, CommandRule] => [name, reads()]),
  ...PRINTS.map((name): [string, CommandRule] => [name, TEXT]),
  ["wc", reads({ long: [FILES0] })],
  ["file", reads({ short: "C", long: ["--compile"] })],
  ["sort", reads({ short: "o", long: ["--output", "--compress-program", FILES0] })],
  ["uniq", reads(undefined, { maxOperands: 1 })],
  ["diff", { operands: "grep" }],
  ["date", { operands: null, refuse: { short: "s", long: ["--set"] } }],
  ["realpath", { operands: "ls" }],
  ["readlink", { operands: "ls" }],
  ["ls", { operands: "ls", root: "bare", recursive: { short: "R", long: "--recursive" } }],
  ["tree", { operands: "find", root: "always", refuse: { short: "oR", long: ["--fromfile"] } }],
  ["du", { operands: "find", root: "always", refuse: { long: [FILES0] } }],
  ["find", { operands: "find", root: "bare", expression: true, refuse: { exact: FIND_ACTIONS } }],
  ["grep", SEARCH],
  ["egrep", SEARCH],
  ["fgrep", SEARCH],
  ["rg", { ...SEARCH, refuse: { long: ["--pre", "--hostname-bin"] } }],
]);

export interface GitRule {
  /** How operands (revisions and paths) are judged; default `read`. */
  readonly operands?: Reach;
  readonly refuse?: Refusals;
  /** Only these options: any other one refuses (their other options write). */
  readonly only?: readonly string[];
  /** Operands are allowed only next to one of these options (`git branch --list <pattern>`); `[]`: never. */
  readonly operandsWith?: readonly string[];
  /** The exact operands this subcommand takes (`git stash list`). */
  readonly exactly?: readonly string[];
}
const DIFFS: Refusals = { long: ["--output", "--ext-diff", "--textconv"] };
const PLAIN_GIT = [
  "status", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "merge-base", "name-rev",
  "count-objects", "check-ignore", "show-ref",
];

/** git subcommands that only read the repository (M7R6). Every one also judges the folder git walks (M7R3). */
export const GIT_READ_ONLY: ReadonlyMap<string, GitRule> = new Map<string, GitRule>([
  ...PLAIN_GIT.map((name): [string, GitRule] => [name, {}]),
  ["diff", { refuse: DIFFS }],
  ["log", { refuse: DIFFS }],
  ["show", { refuse: DIFFS }],
  ["blame", { refuse: { long: ["--textconv"] } }],
  ["grep", { operands: "grep", refuse: { short: "O", long: ["--open-files-in-pager", "--textconv"] } }],
  ["cat-file", { refuse: { long: ["--textconv", "--filters"] } }],
  [
    "branch",
    {
      only: ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "-l", "--list", "--no-color", "--no-column"],
      operandsWith: ["-l", "--list"],
    },
  ],
  ["remote", { only: ["-v", "--verbose"], operandsWith: [] }],
  ["stash", { exactly: ["list"], refuse: DIFFS }],
  ["worktree", { exactly: ["list"] }],
]);

/** The only git options allowed before the subcommand; `-C <dir>` is handled apart (its folder is judged). */
export const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks"]);
```

- [ ] **Step 4: Write the engine**

```ts
// packages/pi-host/src/policy/command-cover-judge.ts
import type { GitGuard } from "./git-config-guard.ts";
import { checkReadTarget } from "./read-target.ts";
import type { CommandRule, Reach, Refusals } from "./read-only-commands.ts";

/** What the shell that runs the command adds to it (M7R5). */
export interface ShellFacts {
  readonly commandPrefix: string | undefined;
  readonly shellPath: string | undefined;
  /** `BASH_ENV` or `ENV` is set: a non-interactive shell runs that file first. */
  readonly startupFile: boolean;
  /** `CDPATH` is set: a relative `cd` may land elsewhere. */
  readonly cdPath: boolean;
  /** `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR` is set: git does not find its repository by walking up (owner m3). */
  readonly gitEnv: boolean;
  readonly path: string | undefined;
}
export interface CoverContext {
  readonly cwd: string;
  readonly home: string;
  readonly papHome: string;
  readonly agentDir: string;
  readonly shell: ShellFacts;
  /** Read-only commands cover segments (decision 75 Q6; the Settings switch). */
  readonly readOnly: boolean;
  /** Command prefixes the owner always allows (Task 2a): a segment whose words start with one is covered. */
  readonly prefixes?: readonly (readonly string[])[];
}
export type Cover = { readonly covered: true } | { readonly covered: false; readonly why: string };

/** The state of one command line's judgment: its folders and what it may still spend (M7R9). */
export interface Judge {
  readonly ctx: CoverContext;
  /** Every folder a relative path may be read from (M7R4). */
  readonly bases: readonly string[];
  readonly budget: { paths: number };
  readonly git: GitGuard;
}

const MAX_CLUSTER_SPLITS = 6;
export const GLOB = /[*?[]/;
const FIND_PREFIX_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P"]);

export const tilde = (word: string, home: string): string | null =>
  !word.startsWith("~")
    ? word
    : word === "~"
      ? home
      : word.startsWith("~/")
        ? `${home}${word.slice(1)}`
        : null;
const staticFolder = (prefix: string): string => {
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "." : prefix.slice(0, slash + 1);
};

/** M7R2: one word as a path, from every folder the command may run in. */
export async function judged(word: string, reach: Reach, judge: Judge): Promise<string | null> {
  const expanded = tilde(word, judge.ctx.home);
  if (expanded === null) return "home folder of another user";
  const glob = expanded.search(GLOB);
  const path = glob === -1 ? expanded : staticFolder(expanded.slice(0, glob));
  const tool = glob === -1 ? reach : reach === "ls" || reach === "find" ? "find" : "grep";
  for (const cwd of judge.bases) {
    if (--judge.budget.paths < 0) return "too many paths";
    const review = await checkReadTarget(
      tool,
      { path },
      {
        cwd,
        papHome: judge.ctx.papHome,
        agentDir: judge.ctx.agentDir,
      },
    );
    if (review) return review.why;
  }
  return null;
}

export function refused(word: string, refuse: Refusals | undefined): boolean {
  if (!refuse) return false;
  if (refuse.exact?.includes(word)) return true;
  if (word.startsWith("--")) {
    const name = word.split("=", 1)[0] as string;
    return name.length >= 3 && (refuse.long ?? []).some((option) => option.startsWith(name));
  }
  return [...(refuse.short ?? "")].some((letter) => word.slice(1).includes(letter));
}

/** The values an option word may carry (M7R2). */
function optionValues(word: string): string[] {
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    return equals === -1 ? [] : [word.slice(equals + 1)];
  }
  const values = new Set<string>();
  for (let at = 2; at < word.length && at <= 1 + MAX_CLUSTER_SPLITS; at++) values.add(word.slice(at));
  for (const mark of ["/", "~"]) {
    const at = word.indexOf(mark);
    if (at > 1) values.add(word.slice(at));
  }
  return [...values];
}

/** One command's words after its name, judged by its rule; `roots` are judged too when the rule says so (M7R3). */
export async function judgeWith(
  rule: CommandRule,
  args: readonly string[],
  judge: Judge,
  roots: readonly string[],
): Promise<string | null> {
  let operands = 0;
  let options = true;
  let expression = false;
  const recursive = rule.recursive && { short: rule.recursive.short, long: [rule.recursive.long] };
  const walks = recursive !== undefined && args.some((word) => refused(word, recursive));
  const reach: Reach | null = walks ? "find" : rule.operands;
  for (const word of args) {
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.length > 1 && word.startsWith("-")) {
      if (refused(word, rule.refuse)) return "refused option";
      for (const value of optionValues(word)) {
        const why = await judged(value, "read", judge);
        if (why !== null) return why;
      }
      // find's `-H`, `-L`, `-P` come before its start paths; any other option word starts the expression.
      if (rule.expression && !FIND_PREFIX_OPTIONS.has(word)) expression = true;
      continue;
    }
    if (rule.expression && (word === "(" || word === "!" || word === ")")) expression = true;
    if (expression || word === "-") continue;
    operands++;
    if (rule.maxOperands !== undefined && operands > rule.maxOperands) return "too many operands";
    if (reach !== null) {
      const why = await judged(word, reach, judge);
      if (why !== null) return why;
    }
  }
  if (rule.root === "always" || (rule.root === "bare" && operands === 0))
    for (const root of roots) {
      const why = await judged(root, reach ?? "read", judge);
      if (why !== null) return why;
    }
  return null;
}
```

```ts
// packages/pi-host/src/policy/command-cover-git.ts
import { isAbsolute, resolve } from "node:path";
import { type Judge, judged, judgeWith, tilde } from "./command-cover-judge.ts";
import { repoConfigRefusal } from "./git-config-guard.ts";
import { kernelResolve } from "./kernel-path.ts";
import { GIT_GLOBAL_FLAGS, GIT_READ_ONLY } from "./read-only-commands.ts";
import { realTarget } from "./target-path.ts";

function split(words: readonly string[]): { options: string[]; operands: string[] } {
  const options: string[] = [];
  const operands: string[] = [];
  let ended = false;
  for (const word of words) {
    if (!ended && word === "--") ended = true;
    else if (!ended && word.length > 1 && word.startsWith("-")) options.push(word);
    else operands.push(word);
  }
  return { options, operands };
}

/** Each folder git may run in for `folder` (a `-C` path) from each base: as spelled, and as the kernel walks it. */
async function gitFolders(folder: string, judge: Judge): Promise<string[]> {
  const folders = new Set<string>();
  for (const base of judge.bases) {
    folders.add(resolve(base, folder));
    folders.add(await kernelResolve(base, folder));
  }
  return [...folders];
}

/** git's own words: global options, the subcommand's rule, the folder it walks, its repository's config, operands. */
export async function judgeGit(args: readonly string[], judge: Judge): Promise<string | null> {
  if (judge.ctx.shell.gitEnv) return "git environment";
  let at = 0;
  // `-C a -C b` is `cd a`, then `cd b`; an absolute one starts again (git's own rule).
  let folder = ".";
  while (at < args.length && (args[at] as string).startsWith("-")) {
    const flag = args[at] as string;
    if (flag === "-C" && at + 1 < args.length) {
      const next = tilde(args[at + 1] as string, judge.ctx.home);
      if (next === null) return "home folder of another user";
      folder = isAbsolute(next) || folder === "." ? next : `${folder}/${next}`;
      at += 2;
      continue;
    }
    if (!GIT_GLOBAL_FLAGS.has(flag)) return "git option";
    at++;
  }
  const sub = args[at];
  const rule = sub === undefined ? undefined : GIT_READ_ONLY.get(sub);
  if (!rule) return "not a read-only git command";
  const rest = args.slice(at + 1);
  const { options, operands } = split(rest);
  if (rule.only && options.some((option) => !rule.only?.includes(option))) return "git listing only";
  if (
    rule.operandsWith &&
    operands.length > 0 &&
    !options.some((option) => rule.operandsWith?.includes(option))
  )
    return "git listing only";
  if (
    rule.exactly &&
    (operands.length !== rule.exactly.length || operands.some((word, i) => word !== rule.exactly?.[i]))
  )
    return "git listing only";
  // M7R3: git walks the work tree it runs in, judged like find's root.
  const walked = await judged(folder, "find", judge);
  if (walked !== null) return walked;
  const folders = await gitFolders(folder, judge);
  // Owner m3: the repository's own config must run nothing.
  for (const start of folders) {
    const why = await repoConfigRefusal(await realTarget(start), judge.git);
    if (why !== null) return why;
  }
  // Operands are relative to the folder git runs in.
  return judgeWith(
    { operands: rule.operands ?? "read", ...(rule.refuse ? { refuse: rule.refuse } : {}) },
    rest,
    { ...judge, bases: folders },
    [],
  );
}
```

```ts
// packages/pi-host/src/policy/command-cover.ts
import { resolve } from "node:path";
import { errorClass } from "../bounded.ts";
import { judgeGit } from "./command-cover-git.ts";
import {
  type Cover,
  type CoverContext,
  GLOB,
  type Judge,
  judged,
  judgeWith,
  tilde,
} from "./command-cover-judge.ts";
import { gitGuard } from "./git-config-guard.ts";
import { READ_ONLY_COMMANDS } from "./read-only-commands.ts";
import {
  argvOf,
  CommandTooComplex,
  CommandTooLong,
  readCommandsWithDoubt,
  type Segment,
} from "./shell-words.ts";
import { realTarget, within } from "./target-path.ts";

export type { Cover, CoverContext, ShellFacts } from "./command-cover-judge.ts";

export const MAX_COVERED_SEGMENTS = 32;
export const MAX_JUDGED_PATHS = 64;
const MAX_FOLDERS = 8;
const MAX_PATH_ENTRIES = 64;
const NOT = (why: string): Cover => ({ covered: false, why });

interface Parsed {
  readonly argv: readonly string[];
  /** Files read through `<`. */
  readonly inputs: readonly string[];
}

/** Whether every simple command of `command` is read-only or starts with an allowed prefix. Never throws (M7R8). */
export async function coverCommand(command: string, ctx: CoverContext): Promise<Cover> {
  try {
    return await cover(command, ctx);
  } catch (error) {
    process.stderr.write(`pi-host: read-only check failed (${errorClass(error)})\n`);
    return NOT("check failed");
  }
}

async function cover(command: string, ctx: CoverContext): Promise<Cover> {
  const shell = await shellRefusal(ctx);
  if (shell !== null) return NOT(shell);
  let segments: Segment[];
  try {
    const reading = readCommandsWithDoubt(command);
    if (reading.unsure) return NOT("unsure reading");
    segments = reading.segments;
  } catch (error) {
    if (error instanceof CommandTooLong || error instanceof CommandTooComplex) return NOT("unreadable");
    throw error;
  }
  if (segments.length === 0 || segments.length > MAX_COVERED_SEGMENTS) return NOT("segment count");
  const parsed: Parsed[] = [];
  for (const segment of segments) {
    const one = parseSegment(segment);
    if (typeof one === "string") return NOT(one);
    parsed.push(one);
  }
  const bases = basesOf(parsed, ctx);
  if (typeof bases === "string") return NOT(bases);
  const judge: Judge = { ctx, bases, budget: { paths: MAX_JUDGED_PATHS }, git: gitGuard(ctx.home) };
  for (const segment of parsed) {
    for (const input of segment.inputs) {
      const why = await judged(input, "read", judge);
      if (why !== null) return NOT(why);
    }
    if (segment.argv[0] === "cd") continue;
    if (ctx.prefixes?.some((prefix) => startsWith(segment.argv, prefix))) continue;
    if (!ctx.readOnly) return NOT("not allowed");
    const why = await judgeSegment(segment.argv, judge);
    if (why !== null) return NOT(why);
  }
  return { covered: true };
}

const startsWith = (argv: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.length <= argv.length && prefix.every((word, at) => argv[at] === word);

/** M7R5. */
async function shellRefusal(ctx: CoverContext): Promise<string | null> {
  const { shell } = ctx;
  if (shell.commandPrefix !== undefined && shell.commandPrefix.trim() !== "") return "shell command prefix";
  if (shell.shellPath !== undefined) return "custom shell";
  if (shell.startupFile) return "shell startup file";
  const entries = (shell.path ?? "").split(":");
  if (entries.length > MAX_PATH_ENTRIES) return "PATH too long";
  const cwd = await realTarget(resolve(ctx.cwd));
  for (const entry of entries) {
    if (!entry.startsWith("/")) return "PATH entry not absolute";
    const spelled = resolve(entry);
    if (within(cwd, spelled) || within(cwd, await realTarget(spelled)))
      return "PATH entry inside the session folder";
  }
  return null;
}

/** M7R1: what stands around the command word, and its redirections. */
function parseSegment(segment: Segment): Parsed | string {
  const plain: string[] = [];
  const inputs: string[] = [];
  for (let at = 0; at < segment.words.length; at++) {
    const word = segment.words[at] as string;
    if (!segment.operators.has(at)) {
      plain.push(word);
      continue;
    }
    const target = segment.words[at + 1];
    at++;
    const verdict = redirection(word, target);
    if (verdict === null) return "redirection";
    if (verdict === "input" && target !== undefined) inputs.push(target);
  }
  const argv = argvOf(segment);
  if (argv.length === 0 || argv.length !== plain.length || argv[0] !== plain[0])
    return "wrapper, assignment or keyword";
  for (const word of [...plain, ...inputs]) if (!literal(word)) return "expansion";
  return { argv, inputs };
}

const literal = (word: string): boolean =>
  !word.includes("$") &&
  !word.includes("`") &&
  !(word.includes("{") && (word.includes(",") || word.includes("..")));

const OUTPUT: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>"]);
function redirection(operator: string, target: string | undefined): "input" | "ok" | null {
  const bare = operator.replace(/^\d+/, "");
  if (bare === "<") return "input";
  if (bare === "<<" || bare === "<<-" || bare === "<<<") return "ok";
  if ((bare === ">&" || bare === "<&") && target !== undefined && /^(?:\d{1,2}|-)$/.test(target)) return "ok";
  if (OUTPUT.has(bare) && target === "/dev/null") return "ok";
  return null;
}

/** M7R4: the session folder, then every `cd` target resolved against every folder collected so far. */
function basesOf(parsed: readonly Parsed[], ctx: CoverContext): string[] | string {
  let bases = [resolve(ctx.cwd)];
  for (const { argv } of parsed) {
    if (argv[0] !== "cd") continue;
    if (ctx.shell.cdPath) return "CDPATH is set";
    const rest = argv.slice(1);
    if (rest.length > 1 || rest.some((word) => word.startsWith("-"))) return "cd option";
    const target = rest.length === 0 ? ctx.home : tilde(rest[0] as string, ctx.home);
    if (target === null || GLOB.test(target)) return "cd target";
    bases = [...new Set([...bases, ...bases.map((base) => resolve(base, target))])];
    if (bases.length > MAX_FOLDERS) return "too many folders";
  }
  return bases;
}

async function judgeSegment(argv: readonly string[], judge: Judge): Promise<string | null> {
  const [name, ...args] = argv as [string, ...string[]];
  if (name === "git") return judgeGit(args, judge);
  const rule = READ_ONLY_COMMANDS.get(name);
  return rule ? judgeWith(rule, args, judge, ["."]) : "not a read-only command";
}
```

At the plan fix, after `prettier --write`, the four files measured 181 (`read-only-commands.ts`), 147 (`command-cover-judge.ts`), 81 (`command-cover-git.ts`) and 164 lines (`command-cover.ts`).

- [ ] **Step 5: Run the tests and see them pass; run the mutation checks of Step 1**

Run: `pnpm --filter @pap/pi-host exec vitest run src/policy/command-cover src/policy/git-config` — Expected: PASS. Every RUNS row is covered, and every ASKS and git row is refused with its pinned reason. Then the per-task gate.

- [ ] **Step 6: Commit**

```bash
git add packages/pi-host/src/policy/read-only-commands.ts packages/pi-host/src/policy/command-cover*.ts packages/pi-host/src/policy/cover-bed.ts
git commit -m "feat(policy): read-only command coverage engine on the stage-01 reader, protected reads and the git config check"
```

### Task 1c: Read-only commands run as reads in stage 03 (security contract)

**Files:**
- Modify: `packages/pi-host/src/policy/stage-approval.ts` (93 lines; +30)
- Modify: `packages/pi-host/src/policy/pipeline.ts` (`PipelineDeps.home`, `PipelineDeps.shell`), `extension.ts` (`PolicyConfig.home?`, `PolicyConfig.shell?`)
- Modify: `packages/pi-host/src/open-session.ts` (keeps its `SettingsManager`, hands `shell` and `home` to the policy)
- Modify: `packages/pi-host/src/testing/pipeline-bed.ts` (`home`, `shell` harness options; the bed's base is its home)
- Modify: `packages/contracts/src/policy.ts` (`readOnlyCommands` in `PolicyRules` and `PolicySettings`), `policy.test.ts`
- Modify: `apps/daemon/src/modules/sessions/policy-link.ts` (compose copies the flag), `apps/daemon/src/modules/policy/session-service.ts` (`RESTRICTIVE_SETTINGS.readOnlyCommands = false`)
- Modify: `packages/pi-host/src/policy/daily-use.corpus.ts` (`readOnly?: true` on six entries), `daily-use.test.ts`
- Create: `packages/pi-host/src/policy/pipeline.read-only.test.ts`, `packages/pi-host/src/host.read-only.int.test.ts`

**Interfaces:**
- Consumes: `coverCommand`, `ShellFacts` (1b); `decide` (M5).
- Produces: `READ_ONLY_COMMAND_MODES`, `READ_ONLY_COMMAND_REASON = "read-only command"`; `PolicyRules.readOnlyCommands: boolean` (default `true`), `PolicySettings.readOnlyCommands: boolean` (default `true`); `PipelineDeps.home: string`, `PipelineDeps.shell(): ShellFacts`; `UNKNOWN_SHELL` (all refusing, exported from `command-cover.ts` here, its first user) used when a config gives no `shell`.

**Rulings (pre-dispatch):**
- M7R11 [1c] Read-only commands apply in `supervised` and `auto-accept-edits` (owner Q1 default, confirmed by the owner: m1, M7R134); `read-only` mode keeps blocking every shell call and `full-access` already allows — why: both modes let built-in reads run, and a shell read is the same read; read-only mode is the "no shell" promise — cost if wrong: one set entry.
- M7R12 [1c] A covered call goes through `decide` as category `read`, not external: so a tainted session runs it (owner Q2 default, confirmed by the owner: m2, M7R135; the built-in `read` rule of MQ1), while every exfiltration-capable call keeps asking Deny / Allow once; the audit row keeps category `exec` with stage 03 `allow` "read-only command" — why: no allowlisted command reaches the network, and reading after untrusted content is already allowed for built-ins — cost if wrong: none (the owner chose "run"; no skipped alternative test is written).
- M7R13 [1c] Only Pi's built-in `bash` (registered source `builtin:bash`, `call.exec`) qualifies; `powershell` and extension shells never do; stage 01 (denylist, lever B) and stage 02 run before, unchanged, and the run guard after — why: Q6 "keep M5's denylist, taint and run guard semantics" — cost if wrong: none.
- M7R14 [1c] `PolicyRules.readOnlyCommands` comes from the owner's settings (`PolicySettings.readOnlyCommands`, default on; Settings switch in Task 28); `RESTRICTIVE_SETTINGS` turns it off; an old stored document without the key reads as on — why: the owner can switch it off, and a damaged document must not widen anything — cost if wrong: none.
- M7R15 [1c] The worker builds `ShellFacts` at each evaluation from its `SettingsManager` (`getShellCommandPrefix()`, `getShellPath()`) and its own environment (`BASH_ENV`, `ENV`, `CDPATH`, `PATH`, and `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` for `gitEnv`, M7R150); a `PolicyConfig` without `shell` uses `UNKNOWN_SHELL` (`commandPrefix: "unknown"`), which covers nothing — why: settings can change under a live worker (a reload), and a caller that forgot the facts must fail toward asking — cost if wrong: none.
- M7R16 [1c] The daily-use corpus (lever D) keeps its 52 commands; `git status`, `git diff --stat HEAD~3`, `git log --oneline -20`, `rg -n "useEffect" src/`, `ls -la ~/.config/app/` and `jq '.dependencies | keys' package.json` are marked `readOnly: true` and must run with no question in auto-accept-edits; the other 46 keep the ordinary grantable question — why: the corpus pins the friction the owner sees — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`pipeline.read-only.test.ts` (pipeline bed, real stages):
- "runs a read-only command without a question in auto-accept-edits and in supervised": `bash {command: "cat README.md"}` → result `undefined`, `h.asks` empty, entry `{ decision: "allow", reason: "read-only command", category: "exec" }`, stage 03 `allow`.
- "blocks it in read-only mode and allows it in full access as before": read-only → `{ block: true }` with `READ_ONLY_REASON`; full-access → allow with reason `exec allowed`.
- "asks when the settings switch is off": rules `readOnlyCommands: false` → one ordinary grantable question (answers deny/session/always/once).
- "a tainted session runs a read-only command and still asks for curl": taint raised; `cat README.md` → allow, no question; `curl https://example.com` → one question, answers `["deny","once"]`, `tainted: true`.
- "the denylist wins": owner pattern `cat *secret*` → `cat secret.txt` blocked at stage 01 with `denied: cat *secret*`.
- "the run guard still trips": six identical `git status` calls → the sixth asks with guard `identical-calls`.
- "a protected path asks the ordinary way": `cat ~/agent/auth.json` → one grantable exec question (not covered, M5 behaviour unchanged).
- "a shell command prefix turns it off": harness `shell: { ...SAFE, commandPrefix: "source ~/.bash_aliases" }` → `cat README.md` asks.
- "a config without shell facts covers nothing": a harness built without `shell` → `cat README.md` asks.
- "only Pi's own bash": a tool `bash` registered by an extension (facts path `/ext/x.ts`) → `cat README.md` asks as `unknown`.
- "a repository whose config runs a program asks for git status" (owner m3): the bed's session folder is made a hand-made repository (`.git/HEAD`, `objects/`, `refs/`, a clean `config`), where `git status` runs unasked. Once its config gains `core.fsmonitor = ./hook.sh`, `git status` gets one ordinary grantable exec question, and the entry reason is not "read-only command". With `shell.gitEnv: true`, `git status` in the clean repository asks too.
- "the rules version moved while the check ran": a `rulesVersion` that moves once during the evaluation → evaluated again, the second verdict wins (M5R12).

`daily-use.test.ts`: the six `readOnly` entries run with no question (`h.asks` empty, stage 03 reason "read-only command"); the existing "asks the ordinary grantable question" case filters them out; the corpus still has 52 commands.

`host.read-only.int.test.ts` (real pi-host worker, scripted provider): the script calls `bash` with `ls` then with `cat <agentDir>/auth.json`; the first runs with no approval request (its result reaches the model), the second sends one `approval_request` (category `exec`); with `shellCommandPrefix` set in the test agent directory's `settings.json`, `ls` sends an approval request. Owner m3 end to end: in a hand-made repository (`.git/HEAD`, `objects/`, `refs/`, `config`; no git run to build it) whose `.git/config` sets `core.fsmonitor` to a script that creates a marker file, `git status` sends one `approval_request`; denied, the marker never appears (git never ran); in the same repository with a clean config, `git status` runs with no request and its output reaches the model.

`policy.test.ts`: `PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" }).readOnlyCommands === true`; `PolicySettings.parse({}).readOnlyCommands === true`; a non-boolean is refused.

Mutation checks: remove `"supervised"` from `READ_ONLY_COMMAND_MODES` → the supervised case fails; pass `external: true` → the taint case asks for `cat`; drop the `call.exec` test → "only Pi's own bash" fails; default `shell` to safe facts → "a config without shell facts" fails.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @pap/pi-host exec vitest run src/policy/pipeline.read-only.test.ts src/policy/daily-use.test.ts` — Expected: FAIL (no `read-only command` reason).

- [ ] **Step 3: Contracts**

```ts
// packages/contracts/src/policy.ts — PolicyRules and PolicySettings each gain one key
    /** Read-only shell commands run as reads in supervised and auto-accept-edits (decision 75 Q6, Task 1c). */
    readOnlyCommands: z.boolean().default(true),
```

- [ ] **Step 4: Stage 03**

```ts
// packages/pi-host/src/policy/stage-approval.ts — additions
import type { ApprovalMode } from "@pap/contracts";
import { coverCommand } from "./command-cover.ts";

/** M7R11: where a covered shell command runs like a built-in read. */
export const READ_ONLY_COMMAND_MODES: ReadonlySet<ApprovalMode> = new Set(["supervised", "auto-accept-edits"]);
export const READ_ONLY_COMMAND_REASON = "read-only command";

/** Decision 75 Q6: Pi's own bash, a mode that allows reads, the owner's switch, and every simple command covered. */
async function readOnlyCommand(call: CallFacts, ctx: PolicyContext, deps: PipelineDeps): Promise<boolean> {
  if (!call.exec || call.event.toolName !== "bash") return false;
  if (!call.rules.readOnlyCommands || !READ_ONLY_COMMAND_MODES.has(call.rules.approvalMode)) return false;
  const command = (call.event.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const cover = await coverCommand(command, {
    cwd: ctx.cwd,
    home: deps.home,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    shell: deps.shell(),
    readOnly: true,
  });
  return cover.covered;
}

// At the top of approvalStage, before reviewOf (only interactive rules; any other profile keeps blocking below):
  if (call.rules.profile === "interactive" && (await readOnlyCommand(call, ctx, deps))) {
    // M7R12: a read, never external — taint asks only for what can carry data out.
    const verdict = decide({ mode: call.rules.approvalMode, category: "read", tainted: call.tainted, external: false });
    if (verdict.decision === "allow") return { outcome: "allow", reason: READ_ONLY_COMMAND_REASON };
  }
```

```ts
// packages/pi-host/src/policy/extension.ts — PolicyConfig gains, and the factory passes to PipelineDeps
  /** The worker's home, for `~` in shell commands (Task 1c). */
  home?: string;
  /** The shell facts read-only commands depend on (M7R15); absent: nothing is covered. */
  shell?: () => ShellFacts;
// …
      home: config.home ?? homedir(),
      shell: config.shell ?? (() => UNKNOWN_SHELL),

// packages/pi-host/src/policy/command-cover.ts — exported beside ShellFacts (its first user is this task)
export const UNKNOWN_SHELL: ShellFacts = {
  commandPrefix: "unknown",
  shellPath: undefined,
  startupFile: false,
  cdPath: false,
  gitEnv: false,
  path: undefined,
};
```

```ts
// packages/pi-host/src/open-session.ts — the SettingsManager is kept and read at each evaluation
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const shell = (): ShellFacts => ({
    commandPrefix: settingsManager.getShellCommandPrefix(),
    shellPath: settingsManager.getShellPath(),
    startupFile: process.env.BASH_ENV !== undefined || process.env.ENV !== undefined,
    cdPath: process.env.CDPATH !== undefined,
    gitEnv: ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].some((name) => process.env[name] !== undefined),
    path: process.env.PATH,
  });
  // createPapPolicyExtension({ …, shell, home: homedir() }); createAgentSessionServices({ …, settingsManager, … })
```

Daemon: `policy-link.ts` `compose` adds `readOnlyCommands: settings.readOnlyCommands`; `RESTRICTIVE_SETTINGS` adds `readOnlyCommands: false`; `policy/settings.test.ts` asserts both.

- [ ] **Step 5: Run the tests; `pnpm test:int` (pi-host and daemon); `pnpm build && pnpm smoke`; `pnpm build && pnpm budgets`**

Expected: PASS; smoke unchanged; bundle +0.1 KB or less (one boolean in two schemas).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(policy): read-only shell commands run as reads in the default mode (decision 75 Q6)"
```

### Task 2a: Pattern always-rules, worker side (security contract)

Decision 68 / M5 Q14: "always" may cover a command prefix for Pi's `bash`, or a whole non-shell tool. The card offers them; the grant check matches them through Task 1b's engine.

**Files:**
- Modify: `packages/contracts/src/policy.ts` (`CommandWord`, `PrefixRule`, `ToolRule`, `AlwaysScopes`, `AlwaysScope`, `PolicyRules.alwaysPrefixes`, `PolicyRules.alwaysTools`), `pi-host.ts` (`ApprovalRequestRecord.alwaysScopes`, approval response `scope`), `streams.ts` (`Dialog.alwaysScopes`, the approval `DialogResponse` gains `scope`), their tests
- Create: `packages/pi-host/src/policy/prefix-proposal.ts`, `pattern-grants.ts`, `prefix-proposal.test.ts`, `pattern-grants.test.ts`
- Modify: `packages/pi-host/src/policy/evaluate-once.ts` (183 lines; the grant check and the answer, ≤ 205), `grants.ts` (provisional prefix and tool grants), `packages/pi-host/src/approvals.ts` (`ApprovalOutcome.scope`)

**Interfaces:**
- Consumes: `coverCommand` (1b), `READ_ONLY_COMMAND_MODES` (1c), `argvOf`, `readCommandsWithDoubt`, `ToolKind`.
- Produces: `proposePrefix(command): readonly string[] | null`; `patternGrant(call, ctx, deps): Promise<"prefix rule" | "tool rule" | null>`; `PolicyGrants.rememberAlwaysPrefix(prefix, askedAt)`, `rememberAlwaysTool(rule, askedAt)`, `provisionalPrefixes()`, `provisionalTools()`; contracts above. Task 2b stores what the answer carries.

**Rulings (pre-dispatch):**
- M7R17 [2a] A prefix rule covers a bash call only when every simple command is covered by Task 1b's engine with `prefixes` (structural rules M7R1, M7R5 and input judging included; operands of a prefixed segment are not judged, nor is its repository's git config: M7R150) and, when read-only commands are on and the mode allows them, read-only segments count too — why: `pnpm test && curl …`, `pnpm test $(id)`, `pnpm test > ~/.bashrc`, `X=1 pnpm test` must ask — cost if wrong: a stretched command runs under the owner's rule.
- M7R18 [2a] The card proposes a prefix only for a single plain segment at depth 0 with no redirection: `[command, sub]`, or `[command, run-word, script]` when the second word is `run`, `exec`, `x` or `dlx` (`npm run build`); the command word matches `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$` and is not a shell, wrapper, `eval`, `exec`, `source`, `.` or `xargs`; the sub word matches `^[a-z][a-z0-9:._-]{0,63}$`. Otherwise only the exact command is offered — why: the owner sees exactly what the rule covers; a one-word prefix (`python3`) is never offered — cost if wrong: a few commands only get exact rules.
- M7R19 [2a] A tool rule is offered for a grantable question about a tool whose registered source is Pi's built-ins or Pi's MCP extension, and whose category is `edit`, `network` or `external-write` (never `exec`, never `unknown`); it matches the same tool name and the same source kind — why: "always allow `mcp__github__create_issue`" is the common case; a shell tool-wide rule would be full access; an extension tool is unknown (M5) — cost if wrong: none.
- M7R20 [2a] Pattern grants are checked only where M5 checks exact ones (`grantable`: an ask from the matrix, not from taint, review, an unchecked command or the guard) — why: Q6 and C §5.3: tainted + exfiltration-capable asks "even when an always rule exists" — cost if wrong: none.
- M7R21 [2a] The answer's `scope` must be one the card offered; an `always` with a scope that was not offered is "answer not offered" (denied, M5 rule) — why: the client never widens a grant — cost if wrong: none.
- M7R22 [2a] Provisional pattern grants live until the next policy update, like exact ones (M2-RT-01), capped at 1 000 each with the oldest dropped (only the owner's own answers fill them: tokens answer deny / once only, M5) — cost if wrong: none.

- [ ] **Step 1: Write the failing tests**

`prefix-proposal.test.ts`: `pnpm test` → `["pnpm","test"]`; `pnpm test -- src/a.test.ts` → `["pnpm","test"]`; `npm run build` → `["npm","run","build"]`; `make test` → `["make","test"]`; `git push origin main` → `["git","push"]`; `ls` → null; `python3 -c 1` → null (`-c`); `bash -c x`, `sudo pnpm test`, `env X=1 pnpm test`, `X=1 pnpm test`, `xargs rm`, `eval x` → null; `pnpm test && ls`, `pnpm test | tee x`, `pnpm test > out`, `pnpm test $(id)` → null; `./run.sh test` → null; `"${a:-'x'}" test` → null.

`pattern-grants.test.ts` (pipeline bed; rules with `alwaysPrefixes: [{ prefix: ["pnpm","test"] }]`, mode auto-accept-edits):
```ts
const RUNS = ["pnpm test", "pnpm test -- --run src/a.test.ts", "pnpm test 2>&1", "git status && pnpm test"];
const STRETCH = [
  "pnpm test && curl https://example.com", "pnpm test; rm -rf dist", "pnpm test $(id)", "pnpm test `id`",
  "pnpm test > ~/.bashrc", "X=1 pnpm test", "env pnpm test", "pnpm testx", "pnpm", "pnpm build",
  "pnpm test | sh", "bash -c 'pnpm test'",
];
```
RUNS → no question, entry reason `prefix rule`; STRETCH → one question each. Tool rules (`alwaysTools: [{ tool: "mcp__fix__write", source: "mcp" }]`): that MCP tool runs with no question (reason `tool rule`); a non-MCP extension tool of the same name asks; `bash` can never get a tool rule (`ToolRule` for `bash` composed by a forged update is ignored: reason not `tool rule`, one question). Taint: "a tainted session asks past a prefix rule and a tool rule" → both ask with answers `["deny","once"]`. Lever B: an unreadable command under a prefix rule asks with `UNCHECKED_REASON`. Card offers: a `pnpm test` question carries `alwaysScopes: { prefix: ["pnpm","test"] }`; an `mcp__fix__write` question carries `{ tool: true }`; an `unknown` tool's question carries none; answering `always` with `scope: "prefix"` records a provisional prefix (a second `pnpm test --watch` runs unasked) and the audit reason is `answer: always (prefix)`; answering `always` with `scope: "tool"` on a bash card → `denied`, reason `answer not offered`; a policy update ends the provisional prefix (asks again).

Mutation checks: drop `ctx.prefixes` from the engine call → RUNS ask; let `patternGrant` run when not `grantable` → the taint case runs; accept a scope not offered → the `tool on a bash card` case approves.

- [ ] **Step 2: Run and see them fail** — `pnpm --filter @pap/pi-host exec vitest run src/policy/prefix-proposal.test.ts src/policy/pattern-grants.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Contracts**

```ts
// packages/contracts/src/policy.ts — additions
/** A word of a command prefix rule: no blank, quote, `$`, backquote, glob, brace or shell operator (Task 2a). */
export const CommandWord = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:+@/=%,-]+$/);
/** "Always" for every bash call whose every simple command starts with these words (M7R17). */
export const PrefixRule = z.object({ prefix: z.array(CommandWord).min(1).max(4) }).strict();
export type PrefixRule = z.infer<typeof PrefixRule>;
/** "Always" for one tool whatever its input, matched with its registered source (M7R19). */
export const ToolRule = z.object({ tool: z.string().min(1).max(256), source: z.enum(["builtin", "mcp"]) }).strict();
export type ToolRule = z.infer<typeof ToolRule>;
/** What a card's "always" may cover besides the exact call. */
export const AlwaysScopes = z
  .object({ prefix: z.array(CommandWord).min(1).max(4).optional(), tool: z.literal(true).optional() })
  .strict();
export const AlwaysScope = z.enum(["exact", "prefix", "tool"]);
export type AlwaysScope = z.infer<typeof AlwaysScope>;
// PolicyRules gains:
    alwaysPrefixes: z.array(PrefixRule).max(MAX_ALWAYS_RULES).default([]),
    alwaysTools: z.array(ToolRule).max(MAX_ALWAYS_RULES).default([]),
```

`ApprovalRequestRecord` gains `alwaysScopes: AlwaysScopes.optional()`; the approval response record gains `scope: AlwaysScope.optional()`; `Dialog` (approval) gains `alwaysScopes`; the approval `DialogResponse` gains `scope`.

- [ ] **Step 4: Proposal and grant check**

```ts
// packages/pi-host/src/policy/prefix-proposal.ts
import { argvOf, readCommandsWithDoubt } from "./shell-words.ts";

const NEVER_FIRST: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish", "ash", "mksh", "tcsh", "csh", "sudo", "doas", "su", "runuser", "env",
  "command", "builtin", "exec", "eval", "source", ".", "xargs", "nohup", "time", "nice", "ionice", "stdbuf", "timeout",
  "busybox", "setsid", "unshare", "watch", "chroot", "flock", "script", "sg",
]);
const FIRST = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SUB = /^[a-z][a-z0-9:._-]{0,63}$/;
const RUNNERS: ReadonlySet<string> = new Set(["run", "exec", "x", "dlx"]);

/** M7R18: the prefix a bash card offers for "always", or null when only the exact command may be remembered. */
export function proposePrefix(command: string): readonly string[] | null {
  let reading: ReturnType<typeof readCommandsWithDoubt>;
  try {
    reading = readCommandsWithDoubt(command);
  } catch {
    return null;
  }
  const segment = reading.segments[0];
  if (reading.unsure || reading.segments.length !== 1 || !segment) return null;
  if (segment.depth !== 0 || segment.operators.size > 0) return null;
  const argv = argvOf(segment);
  if (argv.length < 2 || argv.length !== segment.words.length || argv[0] !== segment.words[0]) return null;
  const [first, second, third] = argv as [string, string, string | undefined];
  if (!FIRST.test(first) || NEVER_FIRST.has(first) || !SUB.test(second)) return null;
  return RUNNERS.has(second) && third !== undefined && SUB.test(third) ? [first, second, third] : [first, second];
}
```

```ts
// packages/pi-host/src/policy/pattern-grants.ts
import type { ToolRule } from "@pap/contracts";
import { coverCommand } from "./command-cover.ts";
import type { CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { READ_ONLY_COMMAND_MODES } from "./stage-approval.ts";

/** M7R19: the source kind a tool rule may name, or null when the tool can never get one. */
export function toolRuleSource(call: CallFacts): ToolRule["source"] | null {
  const { kind } = call;
  if (kind.category !== "edit" && kind.category !== "network" && kind.category !== "external-write") return null;
  return kind.mcp ? "mcp" : kind.builtin ? "builtin" : null;
}

/** M7R17, M7R19. Called only for a grantable question (M7R20). */
export async function patternGrant(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<"prefix rule" | "tool rule" | null> {
  const { rules, event } = call;
  if (!call.exec) {
    const source = toolRuleSource(call);
    if (source === null) return null;
    const named = (rule: ToolRule) => rule.tool === event.toolName && rule.source === source;
    return rules.alwaysTools.some(named) || deps.grants.provisionalTools().some(named) ? "tool rule" : null;
  }
  if (event.toolName !== "bash") return null;
  const prefixes = [...rules.alwaysPrefixes.map((rule) => rule.prefix), ...deps.grants.provisionalPrefixes()];
  const command = (event.input as { command?: unknown } | null)?.command;
  if (prefixes.length === 0 || typeof command !== "string") return null;
  const cover = await coverCommand(command, {
    cwd: ctx.cwd,
    home: deps.home,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    shell: deps.shell(),
    readOnly: rules.readOnlyCommands && READ_ONLY_COMMAND_MODES.has(rules.approvalMode),
    prefixes,
  });
  return cover.covered ? "prefix rule" : null;
}
```

`evaluate-once.ts`: inside `if (grantable)`, after the exact check, `grantedBy ??= await patternGrant(call, ctx, deps)` (the rules-version loop of `pipeline.ts` already re-evaluates when the rules move during the await); the ask carries `alwaysScopes` when `answers` includes `always` (`proposePrefix` for `call.exec` bash, `{ tool: true }` when `toolRuleSource(call) !== null`); on `always`, `scope` decides `rememberAlways`, `rememberAlwaysPrefix(offered.prefix)` or `rememberAlwaysTool({ tool, source })`, and a scope not offered is `answer not offered` (M7R21).

- [ ] **Step 5: Run the tests, the per-task gate, `pnpm test:int` (pi-host), `pnpm build && pnpm smoke && pnpm budgets`** — Expected: PASS; bundle +0.3 KB or less.

- [ ] **Step 6: Commit** — `git commit -m "feat(policy): always-rules for a command prefix or a whole tool, worker side"`

### Task 2b: Pattern rules stored, composed and shown

**Files:**
- Create: `apps/daemon/src/modules/policy/migrations/202610131000_pattern_rules.sql`
- Modify: `apps/daemon/src/modules/policy/{store,service,index}.ts` (`addAlways` takes a kind; `prefixesFor`, `toolsFor`; list view), `apps/daemon/src/modules/sessions/{grants,policy-link,dialogs}.ts` (the answer's scope, the offered scopes kept from the request), `packages/contracts/src/methods.ts` (the inline `RuleView` gains `kind` and `pattern`)
- Modify: `apps/web/src/features/sessions/dialogs/ApprovalCardFor.tsx` (scope choice), `features/sessions/AlwaysRules.tsx`, `features/policy/RulesByProject.tsx` (kind labels), `i18n/catalog/session-policy.ts`, `settings-approvals.ts`
- Tests: `policy/store.patterns.test.ts`, `policy/migrations.patterns.test.ts`, `sessions/service.grants.patterns.test.ts`, `sessions/sessions.patterns.int.test.ts`, `ApprovalCardFor.scope.test.tsx`, `RulesByProject.patterns.test.tsx`

**Interfaces:**
- Consumes: 2a contracts.
- Produces: `PolicyPort.addAlways({ ownerId, scope, tool, kind: "exact" | "prefix" | "tool", key?, prefix?, source?, label })`; compose fills `alwaysPrefixes`, `alwaysTools`; `RuleView.kind`, `RuleView.pattern?: string[]`.

**Rulings (pre-dispatch):**
- M7R23 [2b] One table: `approval_rules` gains `kind` and `pattern` (migration below); the unique key stays `grant_key`, computed for the new kinds as sha256 of `[tool, kind, pattern]` — why: one list, one revoke path, one cap — cost if wrong: none.
- M7R24 [2b] The daemon takes the prefix from the approval request it stored for that dialog, never from the client's answer; the answer only says which offered scope — why: M7R21 server-side — cost if wrong: none.
- M7R25 [2b] The 1 000-rule cap per owner and project counts every kind; when full, a new rule is refused with the M5 notice (the call the person allowed still runs) — cost if wrong: none.
- M7R26 [2b] The card shows the scope as a choice after "Always": "This exact command", "Commands starting with `pnpm test`", "Any input to `<tool>`" (en + fr), keyboard reachable, 44 px targets; lists show `pnpm test …` and "any input" next to the tool — why: the owner must see what an always rule covers (decision 44's spirit) — cost if wrong: copy only.

```sql
-- apps/daemon/src/modules/policy/migrations/202610131000_pattern_rules.sql
-- Pattern "always" rules (M7 Task 2b, ADR 0024): a command prefix for Pi's bash (`pattern` is a JSON array of words), or
-- a whole tool matched with its registered source (`pattern` is {"source":"builtin"|"mcp"}). `grant_key` stays the
-- unique key: for these kinds it is the sha256 of [tool, kind, pattern], computed by the daemon.
ALTER TABLE approval_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'exact' CHECK (kind IN ('exact', 'prefix', 'tool'));
ALTER TABLE approval_rules ADD COLUMN pattern TEXT
  CHECK (pattern IS NULL OR (json_valid(pattern) AND length(pattern) <= 1024));
```

**Tests (key assertions):** the migration applies on a home with M5 rules, which read back `kind: "exact"`; inserting `kind: "glob"` fails the CHECK; `addAlways` of a prefix twice keeps one row; the compose of a session in that project carries `alwaysPrefixes: [{ prefix: ["pnpm","test"] }]` and `alwaysTools`; a row whose `pattern` no longer parses as a `PrefixRule` is skipped with one `policy_rule_unreadable` warn (never reaches the worker); an answer `always` with `scope: "prefix"` on a dialog whose request offered `["pnpm","test"]` stores exactly that prefix even when the client's frame carried other words in unknown fields; a revoke removes a prefix rule and the worker's next update no longer has it; `sessions.patterns.int.test.ts` (real worker): answer always/prefix to a `pnpm test` card, then `pnpm test --watch` runs with no card, then `pnpm build` gets one; web: choosing "Commands starting with `pnpm test`" sends `{ answer: "always", scope: "prefix" }`; the rules list labels a prefix rule `pnpm test …`.

- [ ] Steps: RED tests → migration and store → service and compose → sessions answer path → web → gate with `pnpm test:int`, `pnpm build && pnpm smoke && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(policy): store and show prefix and tool always-rules"`

### Task 3: Taint a session when tool results were added outside pap (decision 75 Q5)

**Files:**
- Modify: `apps/daemon/src/modules/search/extract.ts` (`Extracted.toolResults`), `scanner-file.ts` (passes it to `touched`), `apps/daemon/src/modules/sessions/scan-port.ts` (`touched(sessionId, at, active, toolResults)`, `onOutsideToolResults`), `apps/daemon/src/modules/sessions/index.ts` (builds `onOutsideToolResults` from the policy port it already receives: `markTainted(owner, id)` with no epoch; no `daemon.ts` line, M7R151)
- Tests: `search/extract.test.ts` (+ cases), `sessions/scan-port.outside.test.ts` (+ cases), `apps/daemon/src/daemon.outside-taint.int.test.ts`

**Interfaces:** `SessionsScanPort.touched(sessionId: string, at: number, active: boolean, toolResults: boolean): void`; scan-port deps gain `onOutsideToolResults(sessionId: string): void`.

**Rulings (pre-dispatch):**
- M7R27 [3] Taint only when (a) the chunk was read on from a stored cursor (not a first index: adopted sessions are tainted at adoption, agreement 8), (b) it holds at least one `message` entry with `role: "toolResult"`, and (c) the write is outside pap by M4's own test (`noteOutside`: no live worker, after this daemon's start and after the session's last worker ended) — why: the owner asked "only when new tool-result entries appeared, not on any write" (Q5) — cost if wrong: a CLI continuation with only text stays untainted (by design).
- M7R28 [3] `markTainted` without an epoch (path 2 semantics: no epoch check, a late outside write after a Clear taints again) and an info log `session_tainted_outside { sessionId }` — why: the owner clears again, as for M5's documented late-result residual — cost if wrong: one more Clear.

**Tests (key assertions):** `extract` of `[{type:"message", message:{role:"toolResult", …}}]` gives `toolResults: true`, user/assistant only gives `false`; scan port: an outside chunk with tool results calls `onOutsideToolResults` once; without tool results, never; with a live worker, never; a chunk whose mtime precedes `workerEndedAt`, never; a first index (no stored cursor), never; int: a daemon session whose worker was released, then a Pi-format `toolResult` entry appended to its file (CLI shape, no network), shows `policy.tainted: true` in its next snapshot within the scanner's watch path (fake clock reconcile if the watcher misses it), and a second append of only an assistant text after a Clear leaves it clear.

Mutation checks (Opus reviewer, M7-RT-03: a too-narrow condition fails open):
- taint on any outside write (drop the tool-results test) → "without tool results, never";
- drop the stored-cursor condition → "a first index, never";
- drop the `workerEndedAt` condition → "a chunk whose mtime precedes `workerEndedAt`, never";
- look for `role: "toolResult"` on the entry instead of on its `message` → the int test stays untainted.

- [ ] Steps: RED → extract → scanner-file → scan-port → sessions module wiring → gate with `pnpm test:int`.
- [ ] Commit: `git commit -m "feat(sessions): taint a session when tool results were added outside pap"`

### Task 4: Pi's MCP, codemode and tool-search built-ins in the worker (security contract)

**Files:**
- Create: `packages/pi-host/src/builtins.ts`, `builtins.test.ts`, `host.builtins.int.test.ts`
- Modify: `packages/pi-host/src/open-session.ts` (`extensionFactories: [policy, ...piBuiltins(…), ...extra]`), `packages/pi-host/src/policy/results.ts` (the deferred root fix), `results.fence.test.ts` (+1 case), `packages/pi-host/src/policy/tool-kind.ts` (the wiring comment now says it is wired)
- Modify: `docs/agents/policy.md` "Tool classification" (wired in M7)

**Interfaces:** `piBuiltins(options: { showSignInLink(url: string): void }): InlineExtension[]`; `signInNotice(url: string): string | null` (http(s) only, clipped to 512).

**Rulings (pre-dispatch):**
- M7R29 [4] Registration exactly as M5R24 requires (code below); codemode with `models: false` (no `models.classify` / `generateImages` from scripts; owner m11, M7R144) — why: the policy trusts `builtin:<name>` only for these exact registrations — cost if wrong: MCP tools classify as unknown and external (fails safe but blocks use).
- M7R30 [4] pap follows Pi's exposure model: Pi activates `direct` tools on registration, `codemode` tools are reached through codemode scripts, `deferred` through `tool_search`; nothing is force-activated. The carried "activate with `setActiveToolsByName`" is Task 15's preset application, which keeps every active non-coding tool (MCP, codemode, tool_search, extension tools) — why: forcing activation would bypass the server's own exposure choice — cost if wrong: none.
- M7R31 [4] MCP `openUrl` never opens a browser on the server: an http(s) URL becomes a session notice "MCP sign-in: open <url>" (clipped, rendered as text); another scheme is withheld with a notice saying so — why: the owner is remote (ngrok); the sign-in completes by pasting the redirect URL into Pi's own prompt (`promptForRedirectUrl`), which pap's input dialog renders — cost if wrong: copy only.
- M7R32 [4] The `chat` preset (Task 15) loads none of the three — cost if wrong: none.
- M7R33 [4] Deferred M5 minor: when classifying a result throws, the result counts as external (M5R39) **and** its parent root is recorded, so the codemode call that ran it is fenced too — cost if wrong: none.

```ts
// packages/pi-host/src/builtins.ts
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

const MAX_LINK = 512;

/** M7R31: what the owner is shown instead of a browser opening on the server. */
export function signInNotice(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `MCP sign-in: open ${url.slice(0, MAX_LINK)}`;
}

/**
 * Pi's own MCP, codemode and tool-search extensions under the names and flags the CLI gives them (M5R24, decision 74):
 * their tools then carry `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`, the only sources pap-policy
 * classifies as MCP, codemode and tool search. A bare factory would be `<inline:N>` and classify as unknown.
 */
export function piBuiltins(options: { readonly showSignInLink: (url: string) => void }): InlineExtension[] {
  return [
    {
      name: "mcp",
      factory: createMcpExtension({ openUrl: options.showSignInLink }),
      builtin: true,
      replaceable: true,
    },
    // `models: false`: scripts get no model catalog or classifier, whose calls would send script data to a provider
    // outside any judged tool call (M5R carry).
    { name: "codemode", factory: createCodemodeExtension({ models: false }), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
  ];
}
```

```ts
// packages/pi-host/src/policy/results.ts — isExternal's catch (M7R33)
  } catch {
    // A throw counts as external (M5R39), and so does the call that ran it: its own result gets fenced too.
    if (event.parentToolCallId !== undefined) {
      try {
        deps.roots.add(clipUnits(event.parentToolCallId, MAX_ID));
      } catch {
        // The nested result itself is still fenced; only the parent's fence is lost (logged by the caller's audit).
      }
    }
    return true;
  }
```

**Tests (key assertions):** `builtins.test.ts`: names `["mcp","codemode","tool-search"]`, each `builtin: true`, `replaceable: true`; `signInNotice("https://auth.example.com/x")` is the notice, `javascript:alert(1)` and `file:///etc/passwd` are null, a 2 000-character URL is clipped to 512. `host.builtins.int.test.ts` (openSession in-process, the production factory list, MCP fixture via `writeMcpFixture`): the fixture's tools carry `builtin:mcp`, `codemode` carries `builtin:codemode`, `tool_search` `builtin:tool-search` (the M5R24 probe, now through `openSession`'s own list); a codemode script reading `typeof models` returns `"undefined"`; `get_commands`-equivalent `session.extensionRunner` lists `/mcp`; a project-level extension that registers an `mcp` extension of its own replaces the built-in (the `replaceable` contract) and its tools classify as unknown. `results.fence.test.ts`: a nested result whose `classify` throws is fenced and its `parentToolCallId` is then fenced as a root.

Mutation checks: drop `builtin: true` from `mcp` → the probe sees `<inline:N>`; pass `models: true` → the codemode case sees `object`; remove the catch's root add → the new fence case fails.

- [ ] Steps: RED → `builtins.ts` → `open-session.ts` (the notice through `deps.ui.context.notify`) → `results.ts` → gate with `pnpm test:int` and `pnpm build && pnpm smoke`.
- [ ] Commit: `git commit -m "feat(pi-host): load Pi's MCP, codemode and tool-search built-ins under their exact names"`

### Task 5: MCP security tests against a real daemon worker (exit proof)

**Files:**
- Create: `apps/daemon/src/security/mcp-taint.int.test.ts`, `apps/daemon/src/security/codemode-nested.int.test.ts`
- Modify: `apps/daemon/src/security/taint.int.test.ts` (its in-process MCP case is removed, with a pointer to the new file), `apps/daemon/src/security/testing/fixtures.ts` (MCP fixture files for `agentFiles`), `docs/agents/policy.md` ("exercised in-process" sentence removed)

**Interfaces:** consumes `startTestDaemon(script, { agentFiles, workerEnv })` (M5 Task 25a), `mcpFixtureFiles()` (M5 Task 5b), the scripted provider.

**Rulings (pre-dispatch):**
- M7R34 [5] The fixture server is configured with `exposure: "direct"` for the taint cases (the scripted model calls the tool by name) and `"codemode"` for the nested case; the codemode script uses the namespace syntax of the SDK's `docs/codemode.md` (read by the implementer; the only thing left to discovery) — cost if wrong: one probe round.
- M7R35 [5] Under `CI=1` a fixture that does not connect fails the test (M5R103); locally it fails too (the fixture is a local stdio script, no network) — cost if wrong: none.

**Tests (key assertions):** untainted auto-accept-edits session: the model calls `mcp__fix__lookup` (`readOnlyHint: true`) → runs with no card (MQ1); its output in `sessions.toolOutput` starts with `<untrusted source=`; the snapshot's `policy.tainted` is `true`; the audit holds a `result` row with stage 07 `acted`; the model then calls `bash {command: "echo exfil"}` → one approval dialog with `tainted: true` and answers `["deny","once"]`; deny → the tool result says denied. Read-only + tainted: `mcp__fix__write` → blocked at stage 02 (audit reason names the MCP read-only rule). Nested: the model calls `codemode` with a script that calls `lookup`; the audit holds a call row for `mcp__fix__lookup` with `parentToolCallId` = the codemode call id; the codemode call's own result is fenced; the session is tainted. An always rule for `echo exfil` exists before the taint → still asked after it.

- [ ] Steps: RED (the files fail until Task 4 is in: run them first against a stash of Task 4 to see them fail on classification) → fixtures → tests → `pnpm test:int`.
- [ ] Commit: `git commit -m "test(security): MCP taint and codemode nesting through a real daemon worker"`

### Task 6a: The Pi configuration helper: pool, protocol, pi-host entry and `compose-pi.ts` (security contract)

ADR 0023: every Pi SDK call that reads or writes Pi's configuration, reaches the network or runs a configured command runs in a short-lived helper child. This task builds the pool, the protocol, a `ping` op and `compose-pi.ts`, where every later Pi module is composed. Each later task adds one op. The Pi file boundary is Task 6b, split out by M7-RT-02 so that each trust boundary gets its own Opus review.

**Files:**
- Create: `packages/contracts/src/pi-helper.ts`, `pi-helper.test.ts`
- Modify: `packages/contracts/src/{permissions,errors,auth,index}.ts`, and their tests:
  - the domain `pi`, after `audit`;
  - `helper_failed`, after `read_only` (agreement 3: membership and message are asserted, never adjacency);
  - tokens never hold `pi:admin`.
- Modify: `apps/web/src/i18n/catalog/shell.ts` (`error.helper_failed`, en + fr) and `catalog/settings-access.ts` (the `pi` domain label: union with M8's labels, agreement 17)
- Create: `packages/pi-host/src/helper/{main,run,ops}.ts`, `helper/ops/ping.ts`, `helper/ops/testing.ts` (test-only ops behind `PAP_TEST_PROVIDER=1`), `helper/run.test.ts`
- Create: `apps/daemon/src/kernel/helper/{pool,helper-io}.ts`, `pool.test.ts`, `pool.int.test.ts`
- Create: `apps/daemon/src/compose-pi.ts` (+ `compose-pi.test.ts`)
- Modify: `apps/daemon/src/daemon.ts` (M7's whole budget: at most 10 lines, M7R151), `apps/daemon/src/kernel/config.ts` (+ test: `PAP_HELPERS_MAX`, union with M8's `PAP_MAX_TERMINALS`, agreement 10)
- Create: `apps/daemon/src/security/pi-token.test.ts` (M7R152)
- Modify: `packages/pi-host/package.json` (the helper entry, built like `main.ts`), `knip.json` (the entry)
- Create: `docs/adr/0023-pi-config-helper.md`

**Interfaces:**
- Produces (contracts): `DaemonToHelper`, `HelperToDaemon`, `HELPER_CODES`, `HelperCode`, `helperErrorCode(code): ErrorCode`.
- Produces (daemon): `createHelperPool(options: HelperPoolOptions): HelperPool`, with:
  - `run(op: string, params: unknown, options: HelperRunOptions): HelperHandle`, which throws `PapError("capacity")` at once when the pool is full;
  - `HelperHandle { readonly done: Promise<unknown>; answer(promptId: string, value: string | null): boolean; cancel(): void }`;
  - `active(): number` and `stopAll(): Promise<void>`.
  
  `done` rejects with `PapError` `timeout` (the deadline), `helper_failed` (exit, crash, flood, malformed record) or the mapped op code.
- Produces (daemon): `composePi(deps: { config, env, clock, logger, hub, audit, policy, projects, sessions, settings }): { rpc: HandlerTable; stopAll(): Promise<void> }`. In this task it holds the helper pool only. Tasks 8, 17, 22 and 24 each add their module and its `rpc` spread inside it, never in `daemon.ts`.
- Produces (pi-host):
  - `HelperOp<P, R> { params: z.ZodType<P>; run(params: P, ctx: HelperContext): Promise<R> }`;
  - `HelperContext { agentDir; papHome; home; cwd?: string; signal: AbortSignal; emit(event: unknown): void; prompt(prompt: unknown): Promise<string | null> }`;
  - the `OPS` table.

**Rulings (pre-dispatch):**
- M7R36 [6a] *(changed at the plan fix: the IPC disconnect line)* One helper process per operation, forked with the worker's environment rules (`workerEnv`: no `PAP_*`, no `NODE_OPTIONS`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`), `PI_CODING_AGENT_DIR` = the agent directory, its own process group, the worker's `execArgv` (the network guard in tests), process cwd = `os.tmpdir()`; no systemd scope (short-lived; the kill ladder ends it, and the pool's `trackGroup` puts it under `killAllWorkerGroups()`); the helper exits at once when its IPC channel closes (the daemon died), so no helper outlives the daemon waiting for an answer — why: config code and `!cmd` keys must not run with the daemon's environment or in its process — cost if wrong: about 0.4–0.8 s per Settings action (Orca timing: a spinner after 1 s).
- M7R37 [6a] At most 4 helpers at once (`PAP_HELPERS_MAX`, 1–16); a fifth is refused with `capacity` at once, never queued; per run at most 256 events, 16 prompts and 1 MiB per record, else the helper is killed and the run fails `helper_failed`; stdout and stderr are kept as an 8 KiB tail, logged clipped to 2 KB only on failure — cost if wrong: a busy Settings page sees one refusal and retries.
- M7R38 [6a] Every helper record is parsed with `HelperToDaemon` and each op's result with its own schema by the daemon module that asked (trust boundary: the helper runs user-configured code); `detail` from a failed op is logged clipped, never sent to a client — cost if wrong: none.
- M7R39 [6a] New permission domain `pi` (`pi:read` lists, `pi:admin` changes); `pi:admin` is never a token permission (it can make pap run a configured command or redirect provider traffic, like `policy:admin`); `pi:operate` is declared by no method and so is hidden from the token grid (Task 28) — cost if wrong: none.
- M7R40 [6a] *(changed at the plan fix: agreement 9)* The daemon's `stop()` runs `pi.stopAll()` (the helpers' kill ladders, at most 5 s) in parallel with `sessions.shutdownAll()`. M8's `workspace.shutdown()` comes next, then `killAllWorkerGroups()` and the closers. Cost if wrong: none.
- M7R151 [6a, 8, 17, 22, 24] *(M7-RT-07; agreements 9, 24)* M7's daemon wiring lives in `apps/daemon/src/compose-pi.ts`, mirroring M8's `compose-workspace.ts`. It builds the helper pool and, in later tasks, the `models`, `mcp`, `trust` and `skills` modules with the ports they need (`projects`, `sessions`, `policy`, `audit`, `settings`, `hub`). It returns one `rpc` table and `stopAll()`. `daemon.ts` gains at most 10 lines for all of M7: the import, the `composePi({ … })` call after `settings` is built, the `...pi.rpc` spread, and the stop line `await Promise.all([pi.stopAll(), sessions.shutdownAll()])`. Task 3 adds none (it uses the sessions module's policy port). Why: `daemon.ts` is 318 lines, and the union with M8 must stay ≤ 400. Cost if wrong: a later task that wants a `daemon.ts` line puts it in `compose-pi.ts` instead.
- M7R152 [6a, 30] *(agreement 5)* A token never makes a standing or code-running change through M7. `pi-token.test.ts` builds a caller with every `TOKEN_PERMISSIONS` value and calls each method of the contracts' catalogue whose permission is `pi:admin`, with valid params (`confirmProtected: true` where the method takes it). Each answers `forbidden`, and no helper op runs (a fake pool records nothing). It iterates the catalogue, so every later `pi:admin` method is covered when it lands. Task 30 adds an assertion that the list holds the 25 or more `pi:admin` methods M7 ends with. Cost if wrong: none.

```ts
// packages/contracts/src/pi-helper.ts
import { z } from "zod";

const AbsolutePath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "must be an absolute path");
const PromptId = z.string().min(1).max(64);

/** The first and only run record: one operation per helper process (ADR 0023). */
export const HelperRun = z
  .object({
    type: z.literal("helper_run"),
    op: z.string().min(1).max(64),
    agentDir: AbsolutePath,
    papHome: AbsolutePath,
    /** The project folder the operation is about (trust, project files, project skills). */
    cwd: AbsolutePath.optional(),
    params: z.unknown(),
  })
  .strict();
export const DaemonToHelper = z.discriminatedUnion("type", [
  HelperRun,
  z.object({ type: z.literal("helper_answer"), promptId: PromptId, value: z.string().max(65_536).nullable() }).strict(),
  z.object({ type: z.literal("helper_cancel") }).strict(),
]);
export type DaemonToHelper = z.infer<typeof DaemonToHelper>;

export const HELPER_CODES = [
  "bad_params",
  "unknown_op",
  "not_found",
  "conflict",
  "project_scope",
  "config_invalid",
  "config_path_refused",
  "failed",
] as const;
export type HelperCode = (typeof HELPER_CODES)[number];
// A plain union: two members share `type: "helper_done"` (ok true / false).
export const HelperToDaemon = z.union([
  z.object({ type: z.literal("helper_event"), event: z.unknown() }).strict(),
  z.object({ type: z.literal("helper_prompt"), promptId: PromptId, prompt: z.unknown() }).strict(),
  z.object({ type: z.literal("helper_done"), ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      type: z.literal("helper_done"),
      ok: z.literal(false),
      code: z.enum(HELPER_CODES),
      /** For the daemon's log only, clipped; never sent to a client. */
      detail: z.string().max(256).optional(),
    })
    .strict(),
]);
```

`helperErrorCode`: `bad_params → bad_request`, `unknown_op → internal`, `not_found → not_found`, `conflict → conflict`, `project_scope → project_scope`, `config_invalid → config_invalid`, `config_path_refused → config_path_refused`, `failed → helper_failed` (Tasks 8 and 12a add the three error codes they name).

```ts
// apps/daemon/src/kernel/helper/pool.ts — the spawn (binding)
const child = fork(options.entry, [], {
  cwd: tmpdir(),
  env: workerEnv(options.baseEnv, { PI_CODING_AGENT_DIR: options.agentDir, ...options.extraEnv }),
  execArgv: [...options.execArgv],
  detached: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  serialization: "json",
});
if (child.pid !== undefined && child.pid > 1) trackGroup(child.pid);
```

**Tests (key assertions):** `pi-helper.test.ts`: a run record with a relative `agentDir` or an extra key is refused; `helper_done` ok and failed both parse; a `detail` of 257 characters is refused. `pool.test.ts` (fake child): a fifth `run` throws `capacity` while four are active and the count returns to 3 after one ends; an event past 256 kills the child and rejects `helper_failed`; a record that is not a helper record → `helper_failed`; the deadline (fake clock) → kill ladder → `timeout`; `cancel()` sends `helper_cancel` then kills after the grace; `answer` of an unknown prompt returns false. `pool.int.test.ts` (real fork): `ping` returns `{ piVersion }` matching the SDK's `VERSION`; the helper environment has no `PAP_*` and has `PI_TELEMETRY=0`; `test.hang` with a 500 ms deadline rejects `timeout` and leaves no process in its group; `test.print` (100 MB to stdout) keeps the tail at 8 KiB and completes or is killed by its deadline; `test.prompt` round-trips an answer; `stopAll()` kills a running helper. `run.test.ts`: unknown op → `unknown_op`; bad params → `bad_params`; a throwing op → `failed` with a clipped `detail` that holds no stack. `permissions`/`auth.test.ts`: `TOKEN_PERMISSIONS` excludes `pi:admin`; `methods.test.ts` unchanged.
- `pool.int.test.ts` also checks that the helper exits within 2 s when the pool's side of the IPC channel is closed (the daemon died).
- `compose-pi.test.ts`: `stopAll()` stops a running helper.
- `daemon.stop.test.ts` (or the existing stop test): the stop order is `pi.stopAll` together with `sessions.shutdownAll`, then `killAllWorkerGroups`.
- `pi-token.test.ts` (M7R152): with only `ping`, the list of `pi:admin` methods is empty; the test still asserts that a token cannot be minted with `pi:admin` (`TokenPermission.safeParse("pi:admin")` fails).

Mutation checks:
- queue the fifth run instead of refusing it → the capacity case waits;
- keep `PAP_*` in the helper environment → the environment case;
- drop the IPC-disconnect exit → the disconnect case.

- [ ] Steps: RED → contracts → pi-host helper entry and `ping` → kernel pool → `compose-pi.ts`, the daemon lines and the stop order → token test → ADR 0023 → gate with `pnpm test:int`, `pnpm build && pnpm smoke && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(daemon): a helper process pool for Pi configuration work (ADR 0023)"`

### Task 6b: The Pi file boundary: `pi-file.ts` (security contract)

M7-RT-02 split this from 6a. It holds the real-path, `O_NOFOLLOW` and atomic-rename boundary that Tasks 8, 10, 12a, 17, 18, 22, 24 and 25 write Pi config through, and it gets its own Opus review. It lands right after 6a.

The code below was run once in a scratch copy at the plan fix and passed eight sanity cases:
- a dotfiles link read and written in place (the link stays a link);
- a file link and a folder link out of the roots (`link-outside`, nothing created);
- a dangling link;
- a FIFO (no block);
- 1 MiB + 1;
- `keepMode` and a new file's `0600`;
- an injected `rename` failure (no temporary file left, old content kept).

**Files:**
- Create: `packages/pi-host/src/helper/pi-file.ts`, `helper/pi-file.test.ts` (its FIFO case uses `mkfifo`, already in knip's pi-host `ignoreBinaries` since Task 1a)

**Interfaces:**
- Consumes: `within` (`policy/target-path.ts`, unchanged).
- Produces: `readPiFile(path, roots)`, `writePiFile(path, text, { roots, mode, keepMode })`, `PiFileRefused` (reason `link-outside | link-dangling | not-a-file | too-large`), `MAX_PI_FILE_BYTES`.

**Rulings (pre-dispatch):**
- M7R40b [6b, 8, 10, 12a, 17, 18, 22, 24, 25] Pi's files are read and written only through `pi-file.ts`: a path is first resolved to its real target, which must lie inside one of the given roots (the agent directory and the home for Pi's own files, so a dotfiles link may point anywhere inside `$HOME` (owner m13, M7R146); the project's real path for project files); a dangling link is refused, never read as "no file" (it could aim a write anywhere); a read opens the real path once with `O_NOFOLLOW | O_NONBLOCK` and checks `fstat` (regular file, at most 1 MiB), so a FIFO never blocks; a write goes to an exclusive temporary file beside the real one, then `chmod` and `rename`, so a reader sees the old or the new file and a link stays a link — cost if wrong: residual race between the real-path check and the open by another process of the same user (documented).

```ts
// packages/pi-host/src/helper/pi-file.ts (binding)
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { within } from "../policy/target-path.ts";

export const MAX_PI_FILE_BYTES = 1024 * 1024;
export type PiFileReason = "link-outside" | "link-dangling" | "not-a-file" | "too-large";
export class PiFileRefused extends Error {
  readonly reason: PiFileReason;
  constructor(reason: PiFileReason) {
    super(reason);
    this.reason = reason;
  }
}
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** A path that does not exist yet (a new `.pi/mcp.json`): its nearest existing ancestor's real path, then the rest as spelled. */
async function realOfMissing(path: string): Promise<string> {
  const rest = [basename(path)];
  for (let base = dirname(resolve(path)); ; base = dirname(base)) {
    try {
      return join(await fs.realpath(base), ...[...rest].reverse());
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    if (dirname(base) === base) return resolve(path);
    rest.push(basename(base));
  }
}

/** M7R40b: the real file a Pi config path names, which must lie inside one of `roots` (real paths). */
async function locate(path: string, roots: readonly string[]): Promise<{ real: string; exists: boolean }> {
  const inside = async (real: string): Promise<boolean> => {
    for (const root of roots) if (within(await fs.realpath(root).catch(() => resolve(root)), real)) return true;
    return false;
  };
  let real: string;
  let exists = true;
  try {
    real = await fs.realpath(path);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    if ((await fs.lstat(path).catch(() => null))?.isSymbolicLink()) throw new PiFileRefused("link-dangling");
    real = await realOfMissing(path);
    exists = false;
  }
  if (!(await inside(real))) throw new PiFileRefused("link-outside");
  return { real, exists };
}

/** Reads a Pi config file once: no final link followed, no FIFO waited on, a regular file of at most 1 MiB. */
export async function readPiFile(
  path: string,
  roots: readonly string[],
): Promise<{ text: string | null; real: string; mode: number | null }> {
  const { real, exists } = await locate(path, roots);
  if (!exists) return { text: null, real, mode: null };
  const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PiFileRefused("not-a-file");
    if (info.size > MAX_PI_FILE_BYTES) throw new PiFileRefused("too-large");
    const text = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text) > MAX_PI_FILE_BYTES) throw new PiFileRefused("too-large");
    return { text, real, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/** Replaces a Pi config file atomically: an exclusive private file beside the real one, then chmod and rename. */
export async function writePiFile(
  path: string,
  text: string,
  options: { readonly roots: readonly string[]; readonly mode: number; readonly keepMode: boolean },
): Promise<void> {
  if (Buffer.byteLength(text) > MAX_PI_FILE_BYTES) throw new PiFileRefused("too-large");
  const { real, exists } = await locate(path, options.roots);
  let mode = options.mode;
  if (exists) {
    const info = await fs.lstat(real);
    if (!info.isFile()) throw new PiFileRefused("not-a-file");
    if (options.keepMode) mode = info.mode & 0o777;
  } else await fs.mkdir(dirname(real), { recursive: true, mode: 0o755 });
  const temp = join(dirname(real), `.${basename(real)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(temp, mode);
    await fs.rename(temp, real);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
```

**Tests (key assertions):** `pi-file.test.ts`: a file through a link into the home is read and written there (the link stays a link); a link to a folder outside the roots → `link-outside` for read and write, nothing created; a dangling link → `link-dangling`; a FIFO → `not-a-file` without blocking (bounded by `vi.waitFor` at 2 s); 1 MiB + 1 → `too-large`; a write keeps the old mode with `keepMode`, sets `0600` without it, leaves no temporary file and keeps the old content after a failed rename (injected `rename` failure).

Mutation checks:
- skip the roots check in `locate` → the outside-link case writes;
- open without `O_NONBLOCK` → the FIFO case hangs past its bound;
- write the text into the real file in place (no temporary file, no rename) → the injected-`rename` case (it expects the old content kept).

- [ ] Steps: RED → `pi-file.ts` → the per-task gate (pi-host unit; no `test:int`: nothing runs it in a worker yet).
- [ ] Commit: `git commit -m "feat(pi-host): a bounded reader and atomic writer for Pi's config files"`

### Task 7: Session model and reasoning level (worker commands, loadout record, daemon methods)

**Files:**
- Create: `packages/contracts/src/session-loadout.ts` (+ test), `packages/contracts/src/session-model-methods.ts`
- Modify: `packages/contracts/src/pi-host.ts` (commands `get_available_models`, `set_model`, `set_thinking_level`; record `loadout`), `streams.ts` (snapshot `loadout`, event `loadout`: one line each), `methods.ts` (one import, one spread), `index.ts`
- Create: `packages/pi-host/src/model-commands.ts`, `loadout.ts` (+ tests), `host.models.int.test.ts`
- Modify: `packages/pi-host/src/dispatch.ts` (three cases; a union by hunk with M8's `papHome` and prompt FIFO, agreement 8: `commands.ts` and `sessions.prompt` are M8's and untouched), `host.ts` (loadout after `ready`), `open-session.ts` (the loadout watcher extension), `scripted-provider.ts` (records the thinking level of each request when the script asks for it, tests only)
- Create: `apps/daemon/src/modules/sessions/service-models.ts`, `loadout-view.ts` (+ tests); Modify: `live-session.ts` (≤ 6 lines: the `loadout` case delegates; M7's whole budget in that file, agreement 13), `snapshot.ts`, `rpc.ts`, `index.ts`
- Modify: `apps/web/src/stores/session-reducer.ts` (`SessionView.loadout`), new `stores/session-reducer.loadout.test.ts`

**Interfaces:**
- Produces (contracts): `THINKING_LEVELS`, `ThinkingLevel`, `ModelSummary { provider, id, name, reasoning, contextWindow?, images? }`, `TOOL_PRESETS = ["configured","none","read-only","default","full","chat"]`, `ToolPreset`, `SessionLoadout { model: ModelSummary | null, thinkingLevel, levels: ThinkingLevel[], preset: ToolPreset, tools: string[] (≤ 256), toolsTruncated }`; methods `sessions.models { sessionId } → { models: ModelSummary[] (≤ 500), truncated, current: { provider, id } | null }` (`sessions:read`), `sessions.setModel { sessionId, provider, modelId } → Ok` (`sessions:operate`, mutation, errors `not_found session_busy capacity worker_failed command_failed timeout`), `sessions.setThinking { sessionId, level } → Ok` (same, no `session_busy`).
- Produces (pi-host): `handleGetAvailableModels`, `handleSetModel`, `handleSetThinking`, `loadoutOf(session): SessionLoadout`, `createLoadoutWatcher(send)` (an inline extension that sends `loadout` on `model_select` and `thinking_level_select`).
- Produces (daemon): `LoadoutView` per live session; snapshot `loadout: SessionLoadout | null` (null when cold).

**Rulings (pre-dispatch):**
- M7R41 [7] The list comes from the live worker's own runtime (`session.scopedModels` when `enabledModels` scopes it, else `modelRuntime.getAvailable()`), in Pi's order, never re-sorted; opening the menu on a cold session starts its worker (`ensureLive`, capacity applies) — why: extension providers and the project's trust are what the session really has (P07-7; T3 `status.ts` asks the real Pi too) — cost if wrong: a cold session's menu waits for a worker start.
- M7R42 [7] `set_model` and `set_thinking_level` are session-scoped (`persist` never set): `settings.json` is never written by a pick — pi-web models.md, P07-4 — cost if wrong: none.
- M7R43 [7] A model change while a run is going is refused with `session_busy` (daemon check, then the worker's `isIdle`); a reasoning change is allowed at any time and applies from the next model request (Pi re-reads the level per request; pinned by the int test) — cost if wrong: if a future SDK breaks the mid-run rule, the int test fails and the web disables the menu while running.
- M7R44 [7] The worker sends `loadout` after `ready`, after each of the three commands, and on `model_select` / `thinking_level_select` (an extension may switch models); the daemon parses it with `SessionLoadout` (worker text is untrusted) and drops an invalid one with one rate-limited warn — cost if wrong: none.
- M7R45 [7] Levels come from `session.getAvailableThinkingLevels()` (Orca `rpc-options.ts`: from the model's own map); a model without reasoning shows only `off` — cost if wrong: none.

**Tests (key assertions):** contracts: a `ModelSummary` with a 300-character id is refused; `SessionLoadout` with 8 levels is refused. pi-host unit (fake session): `get_available_models` returns at most 500 with `truncated: true` beyond; `set_model` with an unknown model answers `success: false` and changes nothing; `set_thinking_level "xhigh"` on a model without it clamps to what `getAvailableThinkingLevels` allows and the loadout says so. `host.models.int.test.ts` (scripted provider with two models, one reasoning): `get_available_models` lists both in order; `set_model` then `get_state`-equivalent shows the new model and `settings.json` in the test agent dir is byte-identical; a two-request script where `set_thinking_level high` is sent after the first request started records `high` on the second request (scripted provider capture); an extension in the test agent dir registering a provider shows its model in the list. Daemon: `sessions.setModel` while running → `session_busy`; on a cold session `sessions.models` starts the worker; the snapshot of a live session has `loadout.model.id`; a `loadout` record with `tools` of 300 entries is dropped and warned once. Web reducer: a `loadout` event replaces `view.loadout`; a snapshot with `loadout: null` clears it.

- [ ] Steps: RED → contracts → pi-host commands, record and watcher → daemon service, view, snapshot, rpc → reducer → gate with `pnpm test:int`, `pnpm build && pnpm smoke && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(sessions): model and reasoning level per session, from the worker's own runtime"`

### Task 8: The `models` module: overview, defaults, catalog refresh

**Files:**
- Create: `packages/contracts/src/models-methods.ts` (+ test); Modify: `methods.ts`, `index.ts`, `errors.ts` (`project_scope`, before `unknown_method`; its eager message in `apps/web/src/i18n/catalog/shell.ts`), `pi-helper.ts` (op schemas `models.overview`, `models.setDefault`, `models.setDefaultThinking`, `models.refreshCatalog`)
- Create: `packages/pi-host/src/helper/ops/models-overview.ts`, `models-defaults.ts`, `models-catalog.ts` (+ tests)
- Create: `apps/daemon/src/modules/models/{index,service,rpc}.ts` (+ `service.test.ts`, `rpc.test.ts`); Modify: `apps/daemon/src/compose-pi.ts` (the module and its `rpc`, M7R151; no `daemon.ts` line)

**Interfaces:**
- Produces: `models.overview { cwd? } → ModelsOverview` (`pi:read`): `{ providers: ProviderView[] (≤ 300), defaults: { provider, model, thinkingLevel } (each nullable), enabled: { patterns: string[] | null, scope: "global" | "project", settingsPath, warnings: string[] (≤ 50) }, offline: boolean, truncated }`, `ProviderView { id, name, origin: "builtin" | "models.json", auth: { oauthLabel: string | null, apiKey: boolean, configured: boolean, stored: "oauth" | "api_key" | null }, models: (ModelSummary & { enabled: boolean })[] (≤ 2000), modelsTruncated }`; `models.setDefault { provider, modelId, cwd? }`, `models.setDefaultThinking { level, cwd? }`, `models.refreshCatalog {} → { changed: boolean, offline: boolean }` (all `pi:admin`, mutations, no step-up: owner c3, M7R133).
- Produces (daemon): `ModelsModule { rpc, port }`, `ModelsPort.overview(caller, cwd?)` (Task 29 uses it).

**Rulings (pre-dispatch):**
- M7R46 [8] The overview runs in the helper with `ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false })` and loads no extension (built-in and `models.json` providers only; an extension's provider shows in the session's menu, owner m9, M7R142) — why: side-effect-free discovery (T3 rule "setup never as a health-check side effect") and no user extension code in Settings — cost if wrong: an extension-only provider cannot be signed in from Settings (its CLI `/login` covers it).
- M7R47 [8] A raw key never leaves the helper: `auth` says which kinds exist and whether one is stored or configured from the environment, nothing more; a provider is listed once whatever its auth kinds (one entry per provider id: P07-11's dual-auth rule) — cost if wrong: none.
- M7R48 [8] Defaults are written with Pi's `SettingsManager` (its own lock) to the global `settings.json`, after `flush()`, reading `drainErrors()` (pi-web: a failed write resolves); a model outside the resolved `enabledModels` scope is refused (`bad_request`); when a trusted project's `.pi/settings.json` sets the same key, `project_scope` names that file (the client shows it) — cost if wrong: none.
- M7R49 [8] `models.refreshCatalog` calls `ModelRuntime.refresh({ force: true })` only on this explicit action, with the helper allowed to reach the network; `PI_OFFLINE` in the daemon's environment passes to the helper and answers `{ offline: true }` with no request — C §9.4, decision 34 — cost if wrong: none.
- M7R50 [8] The overview's `cwd` must be a folder the caller has a session or project in (projects port), else `invalid_cwd` — why: the helper reads that folder's `.pi/settings.json`; an arbitrary path from a token holder must not become a probe — cost if wrong: none.

**Tests (key assertions):** helper (temp agent dir, scripted native provider under `PAP_TEST_PROVIDER=1`): the overview lists `models.json` providers with `origin: "models.json"` and their models, marks `enabled` from a glob `enabledModels`, never contains the literal `apiKey` value of `models.json` or `auth.json` (scan the JSON result); `setDefault` writes `defaultProvider` / `defaultModel` and nothing else in `settings.json`; out of scope → `bad_request`; a trusted project with `defaultModel` → `project_scope` and the global file untouched; `refreshCatalog` with `PI_OFFLINE=1` → `{ offline: true }` and the network guard saw nothing. Daemon: results are parsed with the contract (a helper result with an extra provider field is refused → `helper_failed`); `models.overview` with a `cwd` the caller has no session in → `invalid_cwd`; a token with `pi:read` lists, `pi:admin` is not grantable (Task 6a).

- [ ] Steps: RED → contracts → helper ops → module, rpc, wiring → gate with `pnpm test:int`, `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(models): provider overview, default model and catalog refresh through the helper"`

### Task 9: Web: model bar and reasoning menu in the composer

**Files:**
- Create: `apps/web/src/features/sessions/ModelBar.tsx`, `ModelMenu.tsx`, `ThinkingMenu.tsx`, `model-menu.vm.ts`, `register-models-catalog.ts`, `i18n/catalog/session-models.ts` (+ tests `ModelBar.test.tsx`, `model-menu.vm.test.ts`)
- Modify: `apps/web/src/features/sessions/Composer.tsx` (**one line**: `<ModelBar sessionId={sessionId} loadout={view.loadout} running={c.running} />` in the button row; the first of M7's 3 lines, agreement 7), `i18n/lazy-catalog.test.tsx` (the new catalog)

**Interfaces:** consumes `sessions.models`, `sessions.setModel`, `sessions.setThinking` (7), `models.setDefault`, `models.setDefaultThinking` (8), `SessionView.loadout`.

**Rulings (pre-dispatch):**
- M7R51 [9] The pill reads `provider · model` and the level ("thinking: high"), mono uppercase per DESIGN §9.2, in the agent role colour; the menu groups by provider in the list's own order (never re-sorted, pi-web #783), a search field filters by provider, id or name, the current row is marked, a star sets the default (the star marks the defaults from `models.overview`, loaded once when the menu opens) — cost if wrong: copy and layout only.
- M7R52 [9] An empty list says "No model is available. Sign in to a provider in Settings › Models." with a link (Orca: zero models means not signed in); the model menu is disabled while the agent runs with the reason as visible text ("Change the model when the agent is idle"); the reasoning menu stays enabled — cost if wrong: none.
- M7R53 [9] Feedback timing (DESIGN §7.3, Orca STYLEGUIDE): nothing under 100 ms, the row disabled until 1 s, a spinner until 3 s, then "Starting the session…" while a cold worker starts — cost if wrong: none.

**Tests (key assertions):** vm: grouping keeps first-appearance provider order; search `son` keeps `claude-sonnet-*` rows only; `current` marks one row. Component (happy-dom): the pill shows the loadout's model; choosing a row sends `sessions.setModel` with a `commandId`; `session_busy` shows the fixed busy text; the reasoning menu lists only `loadout.levels`; the star sends `models.setDefault` and a `project_scope` refusal shows the file path from the error's params-free copy ("This project's settings decide the default."); every string exists in en and fr; the composer still renders with `loadout: null` (cold session).

- [ ] Steps: RED → vm → components → one line in `Composer.tsx` → gate with `pnpm build && pnpm budgets` (expected: initial unchanged; the session chunk +3–5 KB).
- [ ] Commit: `git commit -m "feat(web): model and reasoning pill in the composer"`

### Task 10: The `enabledModels` minimal-edit engine

**Files:**
- Create: `packages/pi-host/src/helper/ops/enabled-models.ts` (pure planner + op), `enabled-models.test.ts`, `enabled-models.ops.test.ts`
- Modify: `packages/contracts/src/{pi-helper,models-methods}.ts` (`models.setEnabled`), `apps/daemon/src/modules/models/{service,rpc}.ts`

**Interfaces:** `planEnabledEdit(current: readonly string[] | undefined, op: EnabledOp, catalog: CatalogFacts): { patterns: string[] | undefined } | { refused: "last-model" }` with `EnabledOp = { op: "toggle", provider, modelId, enabled } | { op: "provider", provider, enabled } | { op: "prune" } | { op: "clear" } | { op: "resync" }`; method `models.setEnabled { op, cwd? } → { patterns: string[] | null }` (`pi:admin`, mutation; errors `project_scope conflict bad_request helper_failed`).

**Rulings (pre-dispatch):**
- M7R54 [10] Matching is always the SDK's (`resolveModelScopeWithDiagnostics`), never string comparison; minimal edits as pi-web's ADR 0004 describes (read, never copied): an unmatched pattern stays verbatim; only the pattern covering a switched-off model is expanded in place, keeping its `:level`; a fully enabled provider with two or more entries collapses to `provider/*` or `provider/**` only when that glob matches exactly the provider's models, else it is written model by model; a lone exact entry stays; `prune` is the only op that drops unmatched entries; `clear` removes the key — cost if wrong: a rotted list after a catalog rename (prune fixes it).
- M7R55 [10] Switching off the last enabled model is refused (`conflict`, "last-model": an empty scope means every model); a project `enabledModels` makes the switches read-only (`project_scope`) — cost if wrong: none.
- M7R56 [10] `resync` (after a `models.json` save, Task 12a) re-asserts providers that were fully enabled before the save and leaves every other entry alone; renames are not tracked (pap's editor is text, not pi-web's structured form): the owner prunes — deviation from pi-web noted in ADR 0026 — cost if wrong: a renamed model stays off until switched on.

**Tests (key assertions):** a table of at least 20 rows `(patterns, catalog, op) → patterns`, including: `["anthropic/*"]` + switch off `claude-a` with two models → `["anthropic/claude-b"]`; `["anthropic/*:high"]` + off → `["anthropic/claude-b:high"]`; `["foo/*", "unknown-x"]` + toggle → `"unknown-x"` kept; provider on with three exact entries and a glob that matches exactly → `["p/*"]`; nested ids (`openrouter/a/b`) never collapse to `p/*` (minimatch `*` stops at `/`); last model off → `refused`; `prune` drops only unmatched; `clear` → `undefined`. Op: writes only `enabledModels` through `SettingsManager` and leaves every other key of `settings.json` unchanged (byte compare of the rest after a JSON round trip).

- [ ] Steps: RED (table) → planner → op → method → gate.
- [ ] Commit: `git commit -m "feat(models): minimal edits of enabledModels"`

### Task 11: Provider sign-in and API keys (security contract)

**Files:**
- Modify: `packages/contracts/src/{models-methods,pi-helper,streams,audit}.ts` (`LoginEvent`, stream `login`, three audit event names)
- Create: `packages/pi-host/src/helper/ops/auth.ts` (+ `auth.test.ts`); Modify: `packages/pi-host/src/scripted-provider.ts` (test-only `auth.apiKey` and `auth.oauth` that emit an `auth_url` and ask a `manual_code`)
- Create: `apps/daemon/src/modules/models/login-flows.ts`, `login-publisher.ts` (+ tests), `apps/daemon/src/modules/models/login-flow.int.test.ts`; Modify: `models/{service,rpc,index}.ts`; no `kernel/ws/` file (agreement 12: the stream hub is generic over `StreamName`)

**Interfaces:**
- Produces: `models.login { provider, method: "oauth" | "api_key" } → { flowId }`, `models.loginAnswer { flowId, promptId, value } → Ok`, `models.loginCancel { flowId } → Ok`, `subscribe.login { flowId } → { sub }`, `models.setApiKey { provider, key } → Ok`, `models.logout { provider } → Ok` (all `pi:admin`; mutations except the subscription; `models.login` and `models.setApiKey` need a live step-up, owner c3, M7R133); stream `login` with events `LoginEvent` (below) and a `snapshot { events: LoginEvent[] (≤ 64) }`.

**Rulings (pre-dispatch):**
- M7R57 [11] Sign-in runs Pi's own flows in the helper: `ModelRuntime.login(provider, type, interaction, { agentName: "pap" })`, `interaction.notify` → `helper_event`, `interaction.prompt` → `helper_prompt`; the API key path calls the same `login(provider, "api_key", …)` and answers its first `secret` or `text` prompt with the given key (any other prompt cancels) — why: Pi decides what a credential looks like and where it is stored (`auth.json`, its own lock) — cost if wrong: a provider whose key login asks something else cannot be set from Settings (the error says so).
- M7R58 [11] Every event is parsed with `LoginEvent` before it reaches a client: URLs must be `https:` (or `http:` on `localhost`, `127.0.0.1`, `[::1]`), every text is clipped to 2 048 and rendered as React text; a `select` prompt has at most 32 options — why: a provider's or an extension's text is untrusted — cost if wrong: none.
- M7R59 [11] At most 2 flows per owner and 1 per provider (refused with `capacity` / `conflict`, never evicted); a flow ends on `done`, cancel, its 10-minute deadline, or 60 s without a subscriber; flows belong to the caller's user id (another user's flow id is `not_found`) — cost if wrong: none.
- M7R60 [11] A key or an answer value is never logged, audited, stored in a receipt, echoed in a result or placed in an error; audit rows `provider_signed_in { provider, method }`, `provider_key_set { provider }`, `provider_signed_out { provider }` carry no value — cost if wrong: none.
- M7R61 [11] Sign-out calls Pi's `logout(provider)`, which removes whatever credential `auth.json` holds for that provider (one per provider); the Settings copy says so — cost if wrong: an owner with both an OAuth and a key for one provider loses both (Pi keeps one anyway).

```ts
// packages/contracts/src/models-methods.ts — the login stream's events (binding)
const Text = z.string().max(2048);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** M7R58: a link the browser may open: https, or http on a loopback host (a provider's local callback). */
export const LinkUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    } catch {
      return false;
    }
  }, "an https link");
const PromptId = z.string().min(1).max(64);
export const LoginPrompt = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["text", "secret", "manual_code"]), message: Text, placeholder: Text.optional() }).strict(),
  z
    .object({
      type: z.literal("select"),
      message: Text,
      options: z
        .array(z.object({ id: z.string().min(1).max(128), label: Text, description: Text.optional() }).strict())
        .min(1)
        .max(32),
    })
    .strict(),
]);
export const LoginEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth_url"), url: LinkUrl, instructions: Text.optional() }).strict(),
  z
    .object({
      kind: z.literal("device_code"),
      userCode: z.string().min(1).max(64),
      verificationUri: LinkUrl,
      expiresInSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("progress"), message: Text }).strict(),
  z
    .object({
      kind: z.literal("info"),
      message: Text,
      links: z.array(z.object({ url: LinkUrl, label: Text.optional() }).strict()).max(4).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("prompt"), promptId: PromptId, prompt: LoginPrompt }).strict(),
  z.object({ kind: z.literal("done"), ok: z.boolean(), code: z.enum(ERROR_CODES).optional() }).strict(),
]);
export type LoginEvent = z.infer<typeof LoginEvent>;
```

A helper event that fails `LoginEvent` is dropped and counted; the flow ends `helper_failed` after 8 dropped events.

**Tests (key assertions):** helper (scripted test provider): `auth.login oauth` emits `auth_url` then a `manual_code` prompt; answering it writes `auth.json` with an OAuth credential for that provider, mode 0600; cancelling the prompt ends `done { ok: false }` and leaves `auth.json` unchanged; `setApiKey` writes `{ type: "api_key", key }`; `logout` removes it. Contracts: `javascript:alert(1)`, `file:///etc/passwd`, `http://evil.test/x` are refused as `LinkUrl`; `http://127.0.0.1:1455/cb` is accepted. Daemon (`login-flows.test.ts`): a third flow for the owner → `capacity`; a second flow for the same provider → `conflict`; another user's `flowId` → `not_found`; no subscriber for 60 s (fake clock) → the helper is cancelled; a malformed event is dropped and the eighth ends the flow. `login-flow.int.test.ts` (real daemon and helper, scripted provider): a browser-like client creates the flow after a step-up, subscribes, receives `auth_url`, answers, receives `done { ok: true }`; a capture logger, the audit table and the receipts table contain neither the key nor the manual code (search their full text); without a step-up `models.login` → `step_up_required`; a token caller is refused (`forbidden`: `pi:admin` is not grantable).

Mutation checks: allow `http:` for any host in `LinkUrl` → the `http://evil.test` case passes wrongly; log the params in the rpc layer → the capture case fails; evict the oldest flow instead of refusing → the capacity case fails.

- [ ] Steps: RED → contracts → helper op and scripted test auth → flows, publisher, rpc → gate with `pnpm test:int`, `pnpm build && pnpm smoke && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(models): provider sign-in, API keys and sign-out through Pi's own flows"`

### Task 12a: The `models.json` editor backend: masking and save (security contract)

M7-RT-05 split this from the network half (12b), so the masking and the write path get their own Opus review (M7R153).

**Files:**
- Modify: `packages/contracts/src/{models-methods,pi-helper,errors}.ts`: `config_invalid` and `config_path_refused`, before `unknown_method`, with their eager messages in `apps/web/src/i18n/catalog/shell.ts`
- Create: `packages/pi-host/src/helper/jsonc.ts`, `models-json-mask.ts`, `ops/models-json.ts` (+ tests `jsonc.test.ts`, `models-json-mask.test.ts`, `models-json.test.ts`)
- Modify: `apps/daemon/src/modules/models/{service,rpc}.ts`
- Create: `docs/adr/0026-models-json-masked-editor.md`

**Interfaces:**
- `models.config.get {} → { text: string | null, revision: string, path: string }` (`pi:read`).
- `models.config.save { text, baseRevision } → { revision }`, or the refusal `{ code: "config_invalid", issues: string[] (≤ 20 JSON paths) }` (`pi:admin`, mutation, step-up: owner c3, M7R133).
- `maskModelsJson(text): { masked: string; secrets: string[] }` and `unmaskModelsJson(text, secrets): string | { unknown: number }`.

**Rulings (pre-dispatch):**
- M7R62 [12a] The browser never receives a literal secret of `models.json`: every string value of a key named `apiKey`, `key`, `token`, `secret`, `password` (any case) or of any key inside a `headers` object, unless it is a reference (`$NAME`, `${NAME}`) or a command (`!…`), becomes `"<redacted:N>"` (N in document order). Masking is deterministic, so save re-reads the current file, checks its revision (sha256 of the text, `conflict` when it moved), re-masks it and puts the originals back wherever the new text holds `"<redacted:N>"` exactly; a placeholder number the file does not have is `config_invalid` — why: no secret state in the daemon, and an edit around a key keeps it — cost if wrong: a secret under an unusual key name is shown (owner's own file, shown to the owner only).
- M7R63 [12a] The file is always `<agentDir>/models.json`, never a client path; it is read and written through `helper/pi-file.ts` (Task 6b): a link must resolve inside the agent directory or the owner's home (a dotfiles link is fine anywhere in `$HOME`, owner m13, M7R146; `/etc/x` is `config_path_refused`), a dangling link, a non-regular file or more than 1 MiB is refused, the write is atomic (temp beside the real file, then rename) and the file is `0600` (it may hold keys) — cost if wrong: none.
- M7R64 [12a] Validation is Pi's own: comments are stripped as Pi does (`stripJsonComments`, mirrored string-aware in `jsonc.ts`), the shape is checked with a lenient zod schema (known fields typed, unknown fields kept), then the new text is loaded by `ModelRuntime.create({ modelsPath: <temp copy> })` and `getError()` must be empty; issues are reported as JSON paths only (a parser message can quote a secret) — cost if wrong: none.
- M7R65 [12a] After a save, the `resync` of Task 10 runs in the same helper — cost if wrong: none.
- M7R153 [12a, 12b, 17, 18] *(M7-RT-05)*
  - Task 12 splits into 12a (jsonc, masking, editor save through `pi-file.ts`) and 12b (discover, test, pricing and its opt-in): the opt-in grew 12's network half, and keys sent to a base URL deserve a review apart from the masking.
  - Tasks 17 and 18 stay whole: each security core is its own file with its own hostile tests and mutation checks (`mask.ts`, `mcp-file.ts`, `undo.ts`), and the reviewer reads those first.
  - 17 and 18 are flagged in the ETA as the longest reviews.
  
  Cost if wrong: a longer Opus review round on 17 or 18.

```ts
// packages/pi-host/src/helper/models-json-mask.ts (binding)
import { scanJsonc, type JsoncString } from "./jsonc.ts";

const SECRET_KEYS = /^(?:api[-_]?key|key|token|secret|password)$/i;
const REFERENCE = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const PLACEHOLDER = /^<redacted:(\d{1,4})>$/;
export const MAX_SECRETS = 1000;

/** Whether a string value is a literal secret (M7R62): a value under a credential key or inside `headers`, not a reference or a command. */
function secretValue(token: JsoncString): boolean {
  if (token.role !== "value") return false;
  const underHeaders = token.path.includes("headers");
  const key = token.path.at(-1) ?? "";
  if (!underHeaders && !SECRET_KEYS.test(key)) return false;
  return !REFERENCE.test(token.value) && !token.value.startsWith("!");
}

/** M7R62: every literal secret becomes `"<redacted:N>"`, N counting from 0 in document order. */
export function maskModelsJson(text: string): { masked: string; secrets: string[] } {
  const secrets: string[] = [];
  let masked = "";
  let at = 0;
  for (const token of scanJsonc(text)) {
    if (!secretValue(token)) continue;
    if (secrets.length >= MAX_SECRETS) throw new RangeError("too many secrets");
    masked += `${text.slice(at, token.start)}"<redacted:${secrets.length}>"`;
    secrets.push(text.slice(token.start, token.end));
    at = token.end;
  }
  return { masked: masked + text.slice(at), secrets };
}

/** Puts each original literal (raw JSON text, escapes kept) back where the new text holds its exact placeholder. */
export function unmaskModelsJson(text: string, secrets: readonly string[]): string | { unknown: number } {
  let out = "";
  let at = 0;
  for (const token of scanJsonc(text)) {
    const match = PLACEHOLDER.exec(token.value);
    if (token.role !== "value" || match === null) continue;
    const n = Number(match[1]);
    const original = secrets[n];
    if (original === undefined) return { unknown: n };
    out += text.slice(at, token.start) + original;
    at = token.end;
  }
  return out + text.slice(at);
}
```

`scanJsonc(text)` (in `jsonc.ts`, ≤ 150 lines) yields each string literal with `{ start, end, value, role: "key" | "value", path: string[] }` (start and end include the quotes; `value` decoded), skipping `//` and `/* */` comments outside strings, and throws `JsoncError` (no text quoted) on an unterminated string or comment, more than 64 levels or more than 200 000 tokens; `stripJsonComments(text)` replaces comments by spaces.

**Tests (key assertions):** `models-json-mask.test.ts`: `{"providers":{"x":{"apiKey":"sk-123","headers":{"Authorization":"Bearer t"},"baseUrl":"https://h"}}}` masks both secrets and not `baseUrl`; `"apiKey": "$OPENAI_KEY"`, `"${K}"` and `"!op read x"` stay; a comment containing `"apiKey": "x"` is not touched; a key `"API_KEY"` is masked; an escaped secret `"a\"b"` round-trips byte for byte; mask then unmask of an unchanged text is the original; unmask of `<redacted:7>` with 2 secrets → `{ unknown: 7 }`; a placeholder moved to another field is restored there (owner's own edit; step-up applies). `models-json.test.ts` (temp agent dir): get → save unchanged → file byte-identical; save with `baseRevision` of an older text → `conflict`; invalid JSON → `config_invalid` with paths only and the error contains no part of the text; a Pi-rejected shape (`models: "x"`) → `config_invalid`; `models.json` as a link to `<home>/dotfiles/models.json` → written there, mode 0600; as a link to `/tmp/outside/models.json` (outside agent dir and home) → `config_path_refused`, nothing written; a FIFO → refused without blocking (test bounded at 2 s by `vi.waitFor`); 1.5 MiB → refused.

Mutation checks: drop the `headers` rule → the Authorization case leaks; skip the revision check → the conflict case writes; let `writePiFile` follow a link outside the allowed roots → the `/tmp/outside` case writes.

- [ ] Steps: RED → `jsonc.ts` → masking → the `models-json` op → module methods → ADR 0026 → gate with `pnpm test:int`, `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(models): masked models.json editor with a validated, atomic save"`

### Task 12b: Provider discover, test and pricing, with the models.dev opt-in (security contract)

**Files:**
- Modify: `packages/contracts/src/{models-methods,pi-helper}.ts`
- Modify: `packages/contracts/src/settings.ts` (+ test):
  - `SETTING_KEYS` gains `"models"`;
  - `ModelsSettings = z.object({ modelsDevPricing: z.boolean().default(false) })`, every field defaulted (owner R3-4);
  - `SettingWrite` gains the `models` member.
- Create: `packages/pi-host/src/helper/ops/models-discover.ts`, `ops/models-pricing.ts` (+ tests `models-discover.test.ts`, `models-pricing.test.ts`)
- Modify: `apps/daemon/src/modules/models/{service,rpc}.ts`, and the new `pricing-cache.ts`
- Modify: `apps/daemon/src/modules/settings/index.ts` (+ test): a read port `port.models(ownerId): ModelsSettings`, where a missing or damaged row reads as the defaults (M3's rule)
- Modify: `apps/daemon/src/compose-pi.ts` (hands the settings port to the models module)

**Interfaces:**
- `models.discover { provider } → { models: { id, contextWindow?, maxTokens?, reasoning? }[] (≤ 2000) }` (`pi:admin`, step-up: it sends the provider's key to its base URL).
- `models.test { provider, modelId } → { ok: boolean, latencyMs: number, code?: string }` (`pi:admin`).
- `models.pricing { provider?, modelId } → { entries: { provider, id, input?, output?, cacheRead?, cacheWrite?, contextWindow? }[] (≤ 10) }` (`pi:read`). It answers `forbidden` while `modelsDevPricing` is off; the network reaches models.dev only on this call, once switched on.
- `SettingsPort.models(ownerId): ModelsSettings`.

**Rulings (pre-dispatch):**
- M7R66 [12b] Discover sends a `GET <baseUrl>/models` with the provider's resolved key, test sends one completion of at most 16 output tokens; both only on click; errors are reduced to a status class (`http_4xx`, `http_5xx`, `network`, `timeout`), never the provider's body; only `contextWindow`, `maxTokens` and `reasoning: true` are copied from a discovered entry (pi-web #856: other fields mean different things per gateway) — cost if wrong: none.
- M7R67 [12b] *(changed at the plan fix: owner m5, M7R138)* Pricing is opt-in. `models.pricing` first reads the owner's `models` account setting through the settings port. Off (the default, a missing row, or a damaged row): `forbidden` before any helper run or request. On: it fetches `https://models.dev/api.json` (8 MiB cap, 15 s) only on this call, and keeps it in the daemon for 1 hour (one entry, replaced, never grown). Only numeric cost and context fields are returned. Cost if wrong: none.

**Tests (key assertions):**
- Discover/test against a loopback HTTP fixture server started by the test (no outside network): discover copies only the three fields, an HTTP 401 → `http_4xx`. Pricing: the daemon cache serves the second call without a helper; a body over 8 MiB → refused.
- Opt-in (M7R138):
  - with no `models` setting, `models.pricing` → `forbidden`, the fake helper pool ran nothing and the injected fetch saw nothing;
  - after `settings.set { key: "models", value: { modelsDevPricing: true } }` the lookup runs once, and the second call is served from the cache;
  - a damaged `models` row reads as off;
  - `ModelsSettings.parse({})` gives `modelsDevPricing: false`.

Mutation checks:
- skip the opt-in check → the "no setting" case makes a request;
- drop the 8 MiB cap → the over-cap case;
- copy every discovered field → the "only the three fields" case.

- [ ] Steps: RED → contracts and the `models` setting → helper ops → settings port, module methods and cache → gate with `pnpm test:int`, `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(models): provider discovery and test, and models.dev pricing behind an opt-in switch"`

### Task 13: Web: Settings › Models (providers, sign-in, keys, switches, defaults, catalog)

**Files:**
- Create: `apps/web/src/features/models/{ModelsSection,ProviderList,ProviderDetail,SignInFlow,ApiKeyForm,EnabledSwitches}.tsx`, `models.vm.ts`, `use-login-flow.ts`, `i18n/catalog/settings-models.ts` (+ tests)
- Modify: `apps/web/src/routes/settings/sections.tsx` (one renderer line, lazy), `features/workspace/model.ts` (`SETTINGS_SECTIONS` + `models`), `routes/settings/sections.test.tsx`, `i18n/lazy-catalog.test.tsx`
- Modify: `apps/web/src/runtime/subscriptions.ts` (`OPENERS.login`); Create: `apps/web/src/runtime/subscriptions.m7.test.ts` (the 344-line `subscriptions.test.ts` stays frozen, agreement 11)

**Interfaces:** consumes Task 8, 10, 11 methods and the `login` stream; produces `ProviderList`, `SignInFlow` (reused by Task 29). Built-in and `models.json` providers only (owner m9, M7R142).

**Rulings (pre-dispatch):**
- M7R68 [13] Layout follows pi-web's Models panel restyled (DESIGN §10): providers in a list with sign-in state chips (`ok` configured, `mut` not configured), a detail pane with Sign in / Paste a key / Sign out, the provider switch (on only while every model is on: a partial selection reads off with its `n/m` count), per-model switches, the default star, "Refresh catalog"; why a control cannot be used is visible text, never a tooltip (pi-web settings-ui rule) — cost if wrong: layout only.
- M7R69 [13] The sign-in flow renders `auth_url` as a link the owner opens on their own device, `device_code` with a copy button, `manual_code` as a field ("Paste the code or the address your browser ended on"), `secret` as a password field; Cancel is never `danger` — cost if wrong: copy only.
- M7R70 [13] Step-up: a `step_up_required` refusal opens M5's inline password prompt (`StepUp.tsx`) and retries once — cost if wrong: none.
- M7R71 [13] The section is its own lazy chunk inside the Settings chunk (`useRetryableLazy`) — cost if wrong: bundle only.

**Tests (key assertions):** vm: provider switch state from models (all on → on; partial → off with `n/m`); a project scope makes every switch read-only with the settings path in the note. Components: a `login` stream with `auth_url`, then `prompt manual_code`, renders the link and the field, and submitting sends `models.loginAnswer`; `done { ok: false, code: "timeout" }` shows the fixed text; switching the last model off shows the "last model" note from the `conflict` refusal; a raw key typed in `ApiKeyForm` is cleared from component state after the call returns (success or failure); no string is missing in fr; `build-output.int.test.ts` finds the section outside the initial chunk.

- [ ] Steps: RED → vm → components → section wiring → gate with `pnpm build && pnpm budgets` (expected initial +0.1 KB: one section id).
- [ ] Commit: `git commit -m "feat(web): Settings › Models — providers, sign-in, keys and model switches"`

### Task 14: Web: `models.json` editor, discover, test and pricing

**Files:**
- Create: `apps/web/src/features/models/{ModelsJsonEditor,DiscoverPanel,PricingLookup,PricingSwitch}.tsx`, `models-json.vm.ts` (+ tests); Modify: `ProviderDetail.tsx` (opens them), `ModelsSection.tsx` (the switch), `i18n/catalog/settings-models.ts`

**Rulings (pre-dispatch):**
- M7R72 [14] The editor is a monospace `Textarea` (no CodeMirror in M7: M8 brings it lazily; a later task may switch), showing the masked text with a note "Secrets show as <redacted:N>. Leave them as they are to keep them; replace one to change it." — cost if wrong: a plainer editor than pi-web's until a later switch.
- M7R138 (owner m5) applies to the pricing parts:
  - `PricingSwitch` reads and writes the `models` account setting through `settings.get` / `settings.set` (compare-and-set). It is off by default, and its copy reads "Look up prices on models.dev: pap sends nothing to models.dev until you click Look up".
  - While the switch is off, `PricingLookup` is not rendered at all.
  - A `forbidden` from `models.pricing` (switched off in another tab) reloads the setting.
- M7R73 [14] Save shows `config_invalid` issues as their JSON paths; `conflict` offers "Reload" (never overwrites); discover adds selected models to the text as JSON the owner reviews before saving (nothing is saved by discover itself) — cost if wrong: none.

**Tests (key assertions):** vm: inserting discovered models into a provider's `models` array keeps the rest of the text and is valid JSONC; a `conflict` keeps the owner's draft in the field; the pricing lookup fills cost fields into the draft only; with the setting off (or missing) no lookup control is in the document and no `models.pricing` call is made; switching on sends `settings.set` with `modelsDevPricing: true` and shows the control; the copy names models.dev; en + fr.

- [ ] Steps: RED → vm → components → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): models.json editor with discovery, test and pricing"`

### Task 15: Tool presets, Chat only and the read-only preset rule (security contract)

**Files:**
- Modify: `packages/contracts/src/{pi-host,session-model-methods,policy,methods}.ts` (`InitRecord.tools { preset }`, command `set_tools`, `sessions.create.preset?`, `sessions.setTools`, `PolicyRules.readOnlyPreset`)
- Create: `packages/pi-host/src/tool-presets.ts` (+ test), `host.presets.int.test.ts`; Modify: `open-session.ts` (preset at open, no built-ins for `chat`), `dispatch.ts` (`set_tools`), `loadout.ts`, `policy/egress.ts` (the MCP read-only rule also applies under the read-only preset), `policy/egress.preset.test.ts`
- Create: `apps/daemon/src/modules/sessions/migrations/202610131010_tool_preset.sql`; Modify: `sessions/{store,service-launch,service-models,rpc}.ts`, `policy-link.ts` (compose sets `readOnlyPreset`)
- Create: `docs/adr/0028-tool-presets.md`

**Interfaces:** `ToolPreset` (7); `presetToolNames(preset): readonly string[] | null` (`null` for `configured`); `applyPreset(session, preset)`; methods `sessions.create { cwd, preset? }`, `sessions.setTools { sessionId, preset } → Ok` (`sessions:operate`, mutation; errors `not_found session_busy capacity worker_failed command_failed`).

**Rulings (pre-dispatch):**
- M7R74 [15] Presets as pi-web: `none` = no coding tool, `read-only` = read grep find ls, `default` = read bash edit write, `full` = read bash edit write grep find ls, `configured` = Pi's `defaultTools` (no pin), `chat` = no tool and a worker opened with `noExtensions`, `noSkills`, `noPromptTemplates` (pap-policy, an inline factory, still loads: a test pins it; if the SDK drops inline factories under `noExtensions`, Chat only keeps extensions and only drops tools, and the implementer reports it) and none of Task 4's built-ins — cost if wrong: one SDK probe.
- M7R75 [15] A preset replaces only the coding tools: the active set becomes the preset's names plus every active tool that is not a coding tool (MCP, codemode, tool_search, extension tools), as pi-web's `resolveActiveToolNames`; the preset is re-applied after `navigate_tree` and `reload` — the carried "activate MCP tools with `setActiveToolsByName`" — cost if wrong: an extension tool switched off by its extension comes back (pinned by a test that it stays off).
- M7R76 [15] The preset is pap's, stored in `sessions.tool_preset` (migration below), sent in `InitRecord.tools`, never written into Pi's transcript; `NULL` means `configured` — cost if wrong: a session opened by the CLI follows Pi's default tools (correct for the CLI).
- M7R77 [15] Changing between non-chat presets applies in place (`set_tools`, idle only: `session_busy` while running); crossing the `chat` boundary stores the preset and restarts the worker (release, then lazy start), from `service-models.ts`, with no line in `live-session.ts` (agreement 13) — cost if wrong: none.
- M7R78 [15] Under the `read-only` preset, stage 02's MCP read-only rule applies whatever the approval mode (P08-6: MCP tools without `readOnlyHint: true`, codemode calls included, are blocked) through `PolicyRules.readOnlyPreset` — cost if wrong: none.
- M7R79 [15] Stage 00 records the exposure as before (the `session` audit entry with the tool names at `agent_start`) — cost if wrong: none.

```sql
-- apps/daemon/src/modules/sessions/migrations/202610131010_tool_preset.sql
-- A session's tool preset (M7 Task 15, ADR 0028): NULL follows Pi's defaultTools ("configured").
ALTER TABLE sessions ADD COLUMN tool_preset TEXT
  CHECK (tool_preset IS NULL OR tool_preset IN ('none', 'read-only', 'default', 'full', 'chat'));
```

```ts
// packages/pi-host/src/policy/egress.ts — the MCP read-only rule (line 295 today), binding
  const readOnlySession = call.rules.approvalMode === "read-only" || call.rules.readOnlyPreset;
  if (readOnlySession && call.kind.mcp && call.kind.category !== "read")
    return { outcome: "block", reason: MCP_READ_ONLY, modelReason: MCP_READ_ONLY_MODEL_REASON };

// packages/contracts/src/policy.ts — PolicyRules gains
    /** The session's tool preset is read-only (P08-6): MCP tools that may change things are blocked (Task 15). */
    readOnlyPreset: z.boolean().default(false),
```

**Tests (key assertions):** `tool-presets.test.ts`: `presetToolNames("full")` order-insensitive equals the seven names; `applyPreset` keeps `mcp__fix__lookup`, `codemode` and an extension tool active and drops `bash` for `read-only`; an extension tool its extension switched off stays off. `host.presets.int.test.ts`: a worker opened with `tools: { preset: "read-only" }` reports `loadout.tools` without `bash`; `set_tools full` adds it; a `chat` worker loads no test-agent-dir extension (its factory side effect file is absent) and still blocks a call through pap-policy (an inline test tool); `egress.preset.test.ts`: under `readOnlyPreset: true` in auto-accept-edits, `mcp__fix__write` is blocked and `mcp__fix__lookup` (readOnlyHint) is not. Daemon: `sessions.create { preset: "chat" }` stores it; `sessions.setTools` while running → `session_busy`; crossing to `chat` releases the worker and the next prompt starts one with `tools.preset: "chat"`; the migration refuses `tool_preset = 'bogus'`.

Mutation checks: drop `call.rules.readOnlyPreset` → the preset MCP case passes the write; replace the whole active set with the preset → the MCP-kept case fails.

- [ ] Steps: RED → contracts → pi-host presets, open, dispatch, egress → migration, store, launch, compose → ADR 0028 → gate with `pnpm test:int`, `pnpm build && pnpm smoke && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(sessions): tool presets, Chat only and the read-only preset MCP rule"`

### Task 16: Web: preset picker and the session tools chip

**Files:**
- Create: `apps/web/src/features/sessions/{SessionTools,PresetPicker}.tsx`, `presets.vm.ts` (+ tests); Modify: `SessionScreen.tsx` (**one line**: `<SessionTools sessionId={sessionId} loadout={view.loadout} running={…} />` next to `SessionPolicy`), `features/sessions/SessionListScreen.tsx` (the new-session form gains the preset `Select`, default the browser's last explicit choice), `i18n/catalog/session-models.ts`

**Rulings (pre-dispatch):**
- M7R80 [16] The chip reads the preset ("TOOLS · DEFAULT", "CHAT ONLY") and opens a menu of presets with one line each saying what they allow; the new-session form remembers the last explicit choice per browser (`localStorage`, pi-web rule; existing sessions never read it) — cost if wrong: none.
- M7R81 [16] Switching into or out of Chat only asks inline ("The session restarts; the transcript is kept.") — cost if wrong: copy only.

**Tests (key assertions):** the chip shows `loadout.preset`; choosing `full` sends `sessions.setTools`; `chat` asks first; `session_busy` shows the busy text; the new-session form sends `preset` in `sessions.create`; en + fr.

- [ ] Steps: RED → components → one line in `SessionScreen.tsx` → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): tool preset picker and session tools chip"`

### Task 17: MCP overview: file reads, masking and the project file boundary (security contract)

**Files:**
- Create: `packages/contracts/src/mcp-methods.ts` (+ test); Modify: `methods.ts`, `index.ts`, `pi-helper.ts` (`mcp.overview`)
- Create: `packages/pi-host/src/helper/mask.ts`, `helper/mcp-entry.ts` (the entry schema), `helper/ops/mcp-read.ts` (+ tests `mask.test.ts`, `mcp-mask.test.ts`, `mcp-read.test.ts`)
- Create: `apps/daemon/src/modules/mcp/{index,service,rpc}.ts` (+ tests); Modify: `apps/daemon/src/compose-pi.ts` (M7R151)
- Create: `docs/adr/0025-mcp-settings-without-sdk-internals.md`

**Interfaces:** `mcp.overview { cwd? } → { global: McpFileView, project: McpFileView | null, codemode: CodemodeView }` (`pi:read`) with `McpFileView { path, problem: McpFileProblem | null, trusted: boolean | null, servers: McpServerView[] (≤ 200) }`, `McpServerView { name, scope: "global" | "project", kind: "stdio" | "http" | "override" | "invalid", enabled, exposure, target, cwd?, envNames, headerNames, commandFields, variables, oauth: boolean, toolExposureCount, state: "on" | "disabled" | "not-trusted" | "replaced" | "overridden" | "invalid", lastTest: TestView | null, problem: string | null }`; `McpFileProblem = "unparsable" | "invalid-shape" | "too-many-servers" | "too-large" | "not-a-file" | "link-outside" | "link-dangling"`. Produces `maskArgs`, `maskUrl`, `maskCommandLine`, `maskMcpEntry(name, raw, scope)`, `McpEntry` (zod), `readMcpFiles(ctx): { global, project }`.

**Rulings (pre-dispatch):**
- M7R82 [17] The overview reads files only: no spawn, no connection, no value resolution (`${VAR}` and `!cmd` are reported by name, never run) — P09-2, pi-web's rule — cost if wrong: none.
- M7R83 [17] Nothing literal reaches the browser: env and header **values** and `oauth.clientSecret` are never sent (names only); `command`, `args` and `url` are masked word by word (code below); placeholders `${NAME}` and `$NAME` in capitals stay visible; masked text is `•••` — cost if wrong: a credential shape the rules miss is shown to the owner (their own file).
- M7R84 [17] The global file is `<agentDir>/mcp.json`, read through `pi-file.ts` within the agent directory or the home (a dotfiles link anywhere in `$HOME` is followed: owner m13, M7R146); the project file is `<cwd>/.pi/mcp.json`, read within the session folder's real path only (a link out of the project, a dangling link, a FIFO or more than 1 MiB is a `problem`, nothing listed from it); more than 200 servers in a file → `too-many-servers`, nothing listed — cost if wrong: none.
- M7R85 [17] Project servers count as read only while the project's trust decision is `true` (`ProjectTrustStore`, never "requires no trust"); a global server is `replaced` (or `overridden`, for a project entry with only `enabled` / `exposure` / `toolExposure`) only then — pi-web's rule — cost if wrong: none.
- M7R86 [17] Every repository string shown (names, commands, args, cwd, URL, env and header names) goes through the web's existing hidden-character escaping (the M5 approval-text escaping) — cost if wrong: none (render-side, Task 20 tests it).
- M7R87 [17] The entry schema mirrors the SDK's documented `McpServerConfig` (`docs/mcp.md`, `mcp-servers.d.ts`): known fields typed, unknown fields kept (`passthrough`); a server name matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` (so `__proto__`, `constructor` and names Pi would refuse are `invalid`); names that differ only by `-` and `_` share a namespace and the later one is `invalid` ("name-collision"); `auth.provider` in a project file is `invalid` (the SDK refuses it there) — cost if wrong: an entry Pi accepts shows invalid (Test still tells).

```ts
// packages/pi-host/src/helper/mask.ts (binding)
export const MASK = "\u2022\u2022\u2022";
const CREDENTIAL = /(?:api[-_]?key|apikey|token|secret|passw(?:or)?d|pwd|auth|bearer|cookie|session|private[-_]?key|access[-_]?key|signature|credential)/i;
const QUERY_CREDENTIAL = new RegExp(`${CREDENTIAL.source}|^(?:code|sig|key)$`, "i");
const PLACEHOLDER = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*)$/;
const SCHEME_WORD = /^(?:Bearer|Basic|Token)$/i;
const FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FLAG_VALUE = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)=(.*)$/s;
const PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const HEADER = /^([A-Za-z0-9-]+):\s*(.+)$/s;
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A value that looks like a credential: long, URL-safe characters, letters and digits. */
export const tokenLike = (value: string): boolean =>
  value.length >= 24 && /^[A-Za-z0-9_\-.~+/=]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
const keep = (value: string): boolean => PLACEHOLDER.test(value);

/** M7R83: userinfo, credential-named query values, token-like path segments, query values and fragments. */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return tokenLike(raw) ? MASK : raw;
  }
  const userinfo = url.username !== "" || url.password !== "" ? `${MASK}@` : "";
  const path = url.pathname
    .split("/")
    .map((segment) => (tokenLike(decodeURIComponentSafe(segment)) ? MASK : segment))
    .join("/");
  const query = [...url.searchParams]
    .map(([name, value]) =>
      `${encodeURIComponent(name)}=${!keep(value) && (QUERY_CREDENTIAL.test(name) || tokenLike(value)) ? MASK : encodeURIComponent(value)}`,
    )
    .join("&");
  const hash = url.hash === "" ? "" : tokenLike(url.hash.slice(1)) ? `#${MASK}` : url.hash;
  return `${url.protocol}//${userinfo}${url.host}${path}${query === "" ? "" : `?${query}`}${hash}`;
}
const decodeURIComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** M7R83: one argument list, word by word; a credential flag or `Bearer` hides the next word. */
export function maskArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      hideNext = false;
      out.push(keep(arg) ? arg : MASK);
      continue;
    }
    if (URL_START.test(arg)) {
      out.push(maskUrl(arg));
      continue;
    }
    const flag = FLAG_VALUE.exec(arg);
    if (flag && CREDENTIAL.test(flag[1] as string)) {
      out.push(keep(flag[2] as string) ? arg : `${flag[1]}=${MASK}`);
      continue;
    }
    const pair = PAIR.exec(arg);
    if (pair && CREDENTIAL.test(pair[1] as string)) {
      out.push(keep(pair[2] as string) ? arg : `${pair[1]}=${MASK}`);
      continue;
    }
    const header = HEADER.exec(arg);
    if (header && CREDENTIAL.test(header[1] as string)) {
      out.push(`${header[1]}: ${MASK}`);
      continue;
    }
    if ((FLAG.test(arg) && CREDENTIAL.test(arg)) || arg === "-k" || SCHEME_WORD.test(arg)) {
      out.push(arg);
      hideNext = true;
      continue;
    }
    out.push(tokenLike(arg) && !keep(arg) ? MASK : arg);
  }
  return out;
}

/** A whole command line in one string (`command: "npx -y server --token abc"`): masked word by word. */
export const maskCommandLine = (command: string): string => maskArgs(command.split(/\s+/).filter(Boolean)).join(" ");
```

**Tests (key assertions):** `mask.test.ts` table: `--api-key=sk-live-123` → `--api-key=•••`; `--token abc` → `--token •••`; `-k abc` → `-k •••`; `Authorization: Bearer x` (one arg) → `Authorization: •••`; `Bearer`, `xyz` → `Bearer`, `•••`; `API_KEY=x` → `API_KEY=•••`; `--api-key=${OPENAI_KEY}` and `$OPENAI_KEY` kept; `$Passw0rd` (not capitals) masked when token-like or after a credential flag; `https://user:pass@h.example/p?token=abc&page=2` → `https://•••@h.example/p?token=•••&page=2`; a 40-character mixed token in a path segment → `•••`; `postgres://u:p@db/x` userinfo masked; `npx -y @modelcontextprotocol/server-filesystem .` unchanged. `mcp-read.test.ts` (temp agent dir and project): env and header values appear nowhere in the JSON result (search the serialized result for each value); a project file that is a link to `/tmp/outside` → `link-outside` and no servers; a dangling link → `link-dangling`; a FIFO → `not-a-file` without blocking; 201 servers → `too-many-servers`; an untrusted project lists its servers as `not-trusted` and the global one of the same name is not `replaced`; a trusted project's override `{ "x": { "enabled": false } }` marks the global `x` `overridden`; `__proto__` as a name → `invalid` and no prototype pollution (`({}).enabled` is still `undefined` after the read); the overview spawns nothing (a `command` that would create a marker file never runs). Daemon: results parsed with the contract; `cwd` the caller has no session in → `invalid_cwd`.

Mutation checks: drop the `headers` names-only rule (send values) → the env/header search fails; let `PAIR` keep values → `API_KEY=x` leaks; read the project file without the inside check → the link case lists servers.

- [ ] Steps: RED → mask → entry schema → read op → module → ADR 0025 → gate with `pnpm test:int`, `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(mcp): read-only MCP overview with masking and a project file boundary"`

### Task 18: MCP writes, undo, add, and the code mode settings (security contract)

**Files:**
- Modify: `packages/contracts/src/{mcp-methods,pi-helper}.ts`
- Create: `packages/pi-host/src/helper/mcp-file.ts` (parse, edit, serialize), `helper/ops/mcp-write.ts`, `helper/ops/codemode-settings.ts` (+ tests `mcp-write.test.ts`, `mcp-write.hostile.test.ts`, `codemode-settings.test.ts`)
- Create: `apps/daemon/src/modules/mcp/undo.ts` (+ test); Modify: `mcp/{service,rpc}.ts`

**Interfaces:** `mcp.setEnabled { servers: { scope, name }[] (≤ 200), enabled, cwd? } → { results: { scope, name, ok, code? }[] }`; `mcp.setExposure { scope, name, exposure, cwd? }`; `mcp.setInProject { name, enabled, cwd }`; `mcp.remove { scope, name, cwd? } → { token, expiresInMs }`; `mcp.undo { token } → Ok`; `mcp.add { scope, name, entry, cwd? } → Ok` (`entry` validated with `McpEntry`); `mcp.setCodemode { choice?: "automatic" | "always", mode?: "on" | "only", inlineBudget?: number | null } → CodemodeView`. All `pi:admin`, mutations. Owner c3 (M7R133):
- a global `mcp.add` or `mcp.undo` needs a live step-up (they bring back or add a command in Pi's own config);
- every project-scope write needs `confirmProtected: true` in its params: `setEnabled`, `setExposure`, `setInProject`, `remove`, `undo`, and `add` with a project target. Without it, `bad_request`. The browser's "Save anyway?" sends it (Tasks 20, 21).

**Rulings (pre-dispatch):**
- M7R88 [18] Writes are pap's own (the SDK's editors are not exported, ADR 0025): parse with `JSON.parse`, edit the parsed object, serialize with the file's first indentation (default 2) and a trailing newline, keep unknown keys and key order; names are read with `Object.hasOwn` and written with `Object.defineProperty` (a `__proto__` key never reaches `Object.prototype`); `enabled: true` and `exposure: "codemode"` delete their key except in a project override, which keeps them (they replace the global values); an edit that changes nothing leaves the file untouched — cost if wrong: a reformatted file (content equal).
- M7R89 [18] *(changed at the plan fix: owner c3)* Through `pi-file.ts`: the global file is always written `0600` (it may hold literal secrets), the project file keeps its mode (`0644` when new, its `.pi/` folder `0755`); a project write needs a trust decision `true` (`project_untrusted` → `forbidden` with the fixed copy), the file inside the project and `confirmProtected: true` (a protected file, M7R133) — cost if wrong: none.
- M7R90 [18] Undo: a removal returns a random token; the daemon keeps `{ owner, scope, name, raw entry text, index }` for 60 s in memory, at most 100 per owner — when full the removal is **refused** (`limit_reached`), never evicted; the entry text never leaves the daemon; `undo` takes the record once (a second undo is `not_found`), re-checks trust, puts the entry back at its index, and refuses (`conflict`) when the file defines the name again; a restart forgets pending undos (the copy says so) — cost if wrong: none.
- M7R91 [18] `mcp.add` takes an entry the browser parsed (Task 21's importer runs client-side: a pasted secret is not sent back to the browser by pap), validates it with `McpEntry`, refuses an existing name (`conflict`) and refuses `auth.provider` in a project file — cost if wrong: none.
- M7R92 [18] Code mode settings edit only the global `settings.json` keys `defaultTools` (Automatic removes the entries naming `codemode`; Always on appends `+codemode`, valid on plain and modifier-only lists; an emptied modifier-only list is removed, since `defaultTools: []` means no tools), `codemode.mode` (`only` written, `on` removes the key) and `codemode.inlineBudget` (0–1 000 000, `null` removes); written with `pi-file.ts` (the SDK's `SettingsManager` has no setter for these): a concurrent `pi` CLI write in the same instant can be lost (residual, documented) — cost if wrong: one setting re-done.

**Tests (key assertions):** `mcp-write.test.ts`: disable then enable a server returns the file to its exact original bytes; set exposure `codemode` deletes the key; set-in-project appends an override `{ "enabled": false }` to the project file and keeps it on re-enable as `{ "enabled": true }`; a no-op leaves the mtime unchanged; group `setEnabled` with one refused row (an invalid entry) switches the others and reports the refused one; remove + undo restores the entry at its index byte for byte; undo after the name was re-added → `conflict`; `mcp-write.hostile.test.ts`: a server named `__proto__` in the file → editing another server leaves `Object.prototype` clean and the `__proto__` entry intact; a project file that is a link out of the project → `config_path_refused`, nothing written; an untrusted project → `forbidden`; an entry with `command: ""`, `args` with 300 items, or a 70 KiB env value → refused by `McpEntry`; `auth.provider` in a project add → refused; each project-scope write without `confirmProtected` → `bad_request` and the file unchanged, and with it (and no step-up) → written; a global `mcp.add` without a step-up → `step_up_required`. Daemon `undo.test.ts`: the 101st pending removal of an owner is refused and the file unchanged; another owner's token → `not_found`; expiry at 60 s (fake clock). `codemode-settings.test.ts`: `["+codemode"]` round trips Automatic → key removed; `["read","bash"]` + Always → `["read","bash","+codemode"]`; `["-bash"]` + Always → `["-bash","+codemode"]`; `["+codemode"]` + Automatic → key removed (not `[]`); budget `-1` → `bad_request`.

Mutation checks: write names with plain assignment → the `__proto__` test pollutes; evict instead of refusing undo records → the 101st case succeeds; skip the trust check → the untrusted case writes.

- [ ] Steps: RED → `mcp-file.ts` → write op → undo store → code mode op → methods → gate with `pnpm test:int`, `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(mcp): enable, exposure, project override, remove with undo, add, and code mode settings"`

### Task 19: MCP Test, and sign-in guidance (security contract)

**Files:**
- Create: `packages/pi-host/src/helper/ops/mcp-test.ts`, `mcp-test-outcome.ts` (+ tests `mcp-test-outcome.test.ts`, `apps/daemon/src/modules/mcp/mcp-test.int.test.ts`)
- Modify: `packages/contracts/src/{mcp-methods,pi-helper}.ts`, `apps/daemon/src/modules/mcp/{service,rpc}.ts` (last results kept per owner and server, bounded)

**Interfaces:** `mcp.test { scope, name, cwd? } → TestView` (`pi:admin`, step-up, mutation) with `TestView { state: "connected" | "needs-sign-in" | "failed" | "timeout", tools: string[] (≤ 200), toolsTruncated, message: string | null (masked, ≤ 512), at: number }`; `classifyTestOutcome(notices: readonly string[], tools: readonly string[], timedOut: boolean): Omit<TestView, "at">`.

**Rulings (pre-dispatch):**
- M7R93 [19] A Test runs what the file says for that name (the client only names it) inside an in-memory Pi session in the helper: `SessionManager.inMemory(cwd)`, `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, no coding tools, and one inline `mcp` built-in created with `createMcpExtension({ loadConfig: () => ({ servers: [entry], errors: [] }), openUrl: () => {}, startupWaitMs: 0 })`; it waits up to 20 s for that server's `mcp__<namespace>__…` tools or a notice, then closes the session (which stops the server) — why: Pi's own transport, value resolution and stored OAuth tokens, without SDK internals (ADR 0025) — cost if wrong: one SDK probe round.
- M7R94 [19] A project server is tested only while the project is trusted (`forbidden` otherwise): testing runs the repository's command — cost if wrong: none.
- M7R95 [19] Every notice text is masked with `mask.ts` rules (each word through `maskArgs`) and clipped to 512 before it is kept; stderr of the server is never returned — cost if wrong: none.
- M7R96 [19] A notice saying the server needs a sign-in (the SDK's own wording, found by the implementer in `dist/extensions/mcp/` and pinned by a test) gives `needs-sign-in`; the panel then says "Sign in from a session: type /mcp, pick the server, then Sign in; paste the address your browser ends on when asked" (owner m6, M7R139). Sign-in itself is Pi's `/mcp` in a session: its dialogs are pap's input and select cards, and Task 4's notice shows the link — cost if wrong: copy only.
- M7R97 [19] Last results: one per owner, scope and name, at most 400 per owner (a new one for a 401st name is not kept; the result is still returned) — cost if wrong: none.

**Tests (key assertions):** `mcp-test-outcome.test.ts`: tools present → `connected`; the pinned sign-in notice → `needs-sign-in`; another notice → `failed` with its masked text (a token in it is `•••`); nothing by the deadline → `timeout`. `mcp-test.int.test.ts` (real daemon and helper, stdio fixture): a working fixture → `connected` with its tool names; a fixture whose command exits at once → `failed` within the deadline and the helper slot is free afterwards; a fixture that never answers `initialize` → `timeout` (the module's Test deadline is an option of `createMcpModule`, which the int test sets to 1 s) and no process is left; a project server in an untrusted project → `forbidden`; without a step-up → `step_up_required`.

- [ ] Steps: RED → outcome classifier → op → method and last results → gate with `pnpm test:int`.
- [ ] Commit: `git commit -m "feat(mcp): Test a server through Pi's own MCP extension in a throwaway session"`

### Task 20: Web: Settings › MCP (list, detail, switches, exposure, remove and undo, Test, code mode)

**Files:**
- Create: `apps/web/src/features/mcp/{McpSection,ServerList,ServerDetail,CodemodePane,UndoToast}.tsx`, `mcp.vm.ts`, `i18n/catalog/settings-mcp.ts` (+ tests)
- Modify: `routes/settings/sections.tsx` (one line), `features/workspace/model.ts` (+ `mcp`), `sections.test.tsx`, `i18n/lazy-catalog.test.tsx`

**Rulings (pre-dispatch):**
- M7R98 [20] Rows grouped Global / Project with group switches (on only while every row is on; a partial group reads off with `n/m`), each row a state chip (`on`, `disabled`, `not trusted`, `replaced`, `overridden`, `invalid`, and the last Test), the detail pane shows only what the overview sends (masked target, cwd, env and header names, `!command` fields, variables named "sends … to this server" for HTTP), Remove (Toast with Undo for 60 s, DESIGN §9.1), the exposure `Select`, Test, and the sign-in guidance of M7R96; why a control is unavailable is visible text — pi-web panel restyled — cost if wrong: layout only.
- M7R99 [20] Every repository string is rendered through the hidden-character escaping (M7R86); the section is its own lazy chunk — cost if wrong: none.
- M7R133 (owner c3) applies: before any write to a project's `.pi/mcp.json`, the panel asks inline, "This changes <project>/.pi/mcp.json, which can run commands later. Save anyway?" (Save / Cancel, Cancel never `danger`). The copy matches M8's protected-save ask, and Save sends `confirmProtected: true`. A global add or undo opens the step-up prompt (M7R70's pattern).
- M7R100 [20] One write at a time per panel (switches, Remove, Undo, Test, code mode wait while one is on its way); a `timeout` reloads the overview (the write may have landed, R105) — cost if wrong: none.

**Tests (key assertions):** vm: group switch state; row state precedence (`invalid` > `disabled` > `not-trusted` > `replaced` > `overridden` > last Test > `on`). Components: Remove shows the Undo toast and Undo sends `mcp.undo`; a project row's switch asks "Save anyway?" first and sends `confirmProtected: true`, and Cancel sends nothing; a name with `\u202E` renders visibly escaped; the code mode pane disables Always on with the visible reason when the overview says the sandbox or `-builtin:codemode` blocks it; en + fr; the section is not in the initial chunk.

- [ ] Steps: RED → vm → components → section wiring → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): Settings › MCP"`

### Task 21: Web: MCP add form and paste importer

**Files:**
- Create: `apps/web/src/features/mcp/{AddServer,ImportPaste}.tsx`, `import.ts` (pure parser) (+ tests); Modify: `McpSection.tsx`, `i18n/catalog/settings-mcp.ts`

**Rulings (pre-dispatch):**
- M7R101 [21] The importer is a pure parser in the browser (nothing is sent until Add): it accepts `{ "mcpServers": { … } }`, `{ "<name>": { … } }`, a single entry, a command line (`npx -y @scope/server --flag` → stdio entry, name from the package's last segment), and an `https://` URL (http entry, name from the host's first label); it never runs anything; each candidate is shown masked before Add — cost if wrong: none.
- M7R102 [21] The form's save target (Global / This project, with the path) comes first, as pi-web's shared blocks do; Add sends `mcp.add` once per server (a project target after the "Save anyway?" ask, with `confirmProtected: true`; a global one through the step-up prompt, M7R133); a name taken shows the fixed `conflict` copy — cost if wrong: none.

**Tests (key assertions):** `import.test.ts` table: the three JSON shapes, a command line with quoted args, a URL, `claude mcp add x -- npx y` (only the part after `--`), garbage → "Nothing to import"; a 300-server paste is cut to 200 with a note; names normalised to the schema's alphabet (`My Server!` → `My-Server`). Components: the masked preview shows `•••` for an `Authorization` header; Add sends the raw entry once.

- [ ] Steps: RED → parser → components → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): add MCP servers from a form or a pasted config"`

### Task 22: Project trust from pap (security contract)

**Files:**
- Create: `packages/contracts/src/trust-methods.ts` (+ test); Modify: `methods.ts`, `index.ts`, `pi-helper.ts`, `audit.ts` (event names), `session-loadout.ts` (`projectTrust`)
- Create: `packages/pi-host/src/helper/ops/trust.ts`, `trust-breadth.ts` (+ tests `trust-breadth.test.ts`, `trust.test.ts`)
- Create: `apps/daemon/src/modules/trust/{index,service,rpc}.ts` (+ tests); Modify: `apps/daemon/src/compose-pi.ts` (M7R151), `apps/daemon/src/modules/sessions/{index,service,idle-release}.ts` (`restartFolder(owner, folder)`, no line in `live-session.ts`), `packages/pi-host/src/open-session.ts` + `loadout.ts` (`loadout.projectTrust`)
- Create: `docs/adr/0027-project-trust-from-pap.md`

**Interfaces:** `trust.status { cwd } → { requiresTrust, decision: boolean | null, decisionPath: string | null, inherited: boolean, resources: { mcpServers: McpServerView[] (≤ 200), extensions: string[] (≤ 100), skills: string[] (≤ 100), promptTemplates: number, settingsKeys: string[] (≤ 50), systemPrompt: boolean } }` (`pi:read`); `trust.set { cwd, decision: true | false | null } → Ok` (`pi:admin`, mutation; step-up for `true`; errors `forbidden` with a typed reason in a fixed copy key, `invalid_cwd`, `helper_failed`); `SessionsPort.restartFolder(ownerId, folder)`; `SessionLoadout.projectTrust: { required: boolean; trusted: boolean }` (filled by the worker from its resolver at open).

**Rulings (pre-dispatch):**
- M7R103 [22] The decision is Pi's `trust.json`, read and written only through `ProjectTrustStore` in the helper (S7; `get()` can busy-wait and needs a writable agent directory: never on the daemon's request path); the folder is the session folder's real path — cost if wrong: none.
- M7R104 [22] Trusting (`true`) is refused for `/`, the home folder or any of its ancestors, a folder holding Pi's agent directory or pap's home, and a folder that strictly holds another known project (projects port, real paths) — a parent decision is inherited by every child (S7, pi-web's breadth rule); `false` and clearing have no breadth rule (they only narrow) — cost if wrong: an owner who wants to trust a whole workspace folder trusts each project.
- M7R105 [22] A decision change releases the owner's idle workers in that folder or below at once and running ones after their run (the decision applies at the next open: S7, "Restart pi"); the copy says so — cost if wrong: none.
- M7R106 [22] Audit rows `project_trusted`, `project_untrusted`, `project_trust_cleared` with the folder (no other content) — cost if wrong: none.
- M7R107 [22] `trust.status` lists what trusting turns on: project MCP servers masked (Task 17's reader), extension file names, skill names, the number of prompt templates, the top-level keys of `.pi/settings.json` (never values), whether `SYSTEM.md` / `APPEND_SYSTEM.md` exist; HTTP servers name the variables they send ("sends `GITHUB_TOKEN` to this server") — pi-web's trust dialog — cost if wrong: none.
- M7R108 [22] pap still does not read `defaultProjectTrust` or the `project_trust` extension event (ADR 0001 stays): the CLI may trust where pap does not; ADR 0027 records it — cost if wrong: none.

```ts
// packages/pi-host/src/helper/trust-breadth.ts (binding)
import { within } from "../policy/target-path.ts";

export type TrustRefusal = "filesystem-root" | "home-or-above" | "holds-pi-or-pap" | "holds-other-projects";

/** M7R104: why trusting `folder` (a real path) would trust too much, or null. Every path here is real (symlinks resolved). */
export function trustRefusal(
  folder: string,
  facts: { readonly home: string; readonly agentDir: string; readonly papHome: string; readonly projects: readonly string[] },
): TrustRefusal | null {
  if (folder === "/") return "filesystem-root";
  if (within(folder, facts.home)) return "home-or-above";
  if (within(folder, facts.agentDir) || within(folder, facts.papHome)) return "holds-pi-or-pap";
  if (facts.projects.some((project) => project !== folder && within(folder, project))) return "holds-other-projects";
  return null;
}
```

**Tests (key assertions):** `trust-breadth.test.ts`: `/` → `filesystem-root`; home and `/home` → `home-or-above`; a folder holding `~/.pi/agent` → `holds-pi-or-pap`; `~/work` holding `~/work/a` and `~/work/b` → `holds-other-projects`; `~/work/a` itself → null; a symlinked spelling is judged by its real path (the op realpaths first). `trust.test.ts` (temp agent dir, a project with `.pi/mcp.json`, `.pi/extensions/x.ts`, `.agents/skills/s/SKILL.md`): status lists them, masks the MCP entry, names no setting value; `set true` writes `trust.json` through the store (keys sorted, the folder's real path); `set null` removes the key; a corrupt `trust.json` makes status `decision: null` with the store error logged once and `set` fail `helper_failed` (fail closed). Daemon: `trust.set true` without a step-up → `step_up_required`; with one → the audit row, and an idle worker in the folder is released (its next prompt starts a worker whose loadout says `trusted: true`); a running worker is released after its `agent_settled`; a token caller → `forbidden`; `cwd` the caller has no session or project in → `invalid_cwd`.

Mutation checks: drop the ancestor-of-home rule → the `/home` case passes; drop `holds-other-projects` → the workspace case passes; skip the restart → the loadout case still says untrusted.

- [ ] Steps: RED → breadth → op → module, restart, loadout field → ADR 0027 → gate with `pnpm test:int`, `pnpm build && pnpm smoke && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(trust): trust a project from pap through Pi's trust store, with a breadth rule"`

### Task 23: Web: trust dialog and session banner

**Files:**
- Create: `apps/web/src/features/trust/{TrustDialog,TrustBanner}.tsx`, `trust.vm.ts`, `i18n/catalog/trust.ts` (+ tests); Modify: `features/sessions/SessionScreen.tsx` (**one line**: `<TrustBanner sessionId={sessionId} cwd={view.cwd} trust={view.loadout?.projectTrust ?? null} />`), `features/mcp/McpSection.tsx` and `features/skills/` notice (open the dialog)

**Rulings (pre-dispatch):**
- M7R109 [23] The banner shows only when the worker says trust is required and not given ("This project has Pi resources pap does not load until you trust it."), with Review; the dialog loads `trust.status` on open, lists what trusting turns on (M7R107) inside the dashed attention frame of external content (DESIGN §2), names the refusal reason of M7R104 in plain words, and offers Trust / Keep untrusted / Cancel (Cancel never `danger`); trusting says the session restarts — cost if wrong: copy only.

**Tests (key assertions):** the banner hides when `trusted`; the dialog lists a masked server and an extension name, escapes hidden characters; Trust sends `trust.set { decision: true }` after the step-up prompt; a `holds-other-projects` refusal shows its copy; en + fr; the dialog is lazy.

- [ ] Steps: RED → components → one line in `SessionScreen.tsx` → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): project trust dialog and session banner"`

### Task 24: Skills: list, invocation switch, skills.sh search and install (security contract)

**Files:**
- Create: `packages/contracts/src/skills-methods.ts` (+ test); Modify: `methods.ts`, `index.ts`, `pi-helper.ts`
- Create: `packages/pi-host/src/helper/frontmatter.ts`, `helper/skill-source.ts`, `helper/ops/skills.ts` (+ tests `frontmatter.test.ts`, `skill-source.test.ts`, `skills.test.ts`, `skills-install.test.ts`)
- Create: `apps/daemon/src/modules/skills/{index,service,rpc}.ts` (+ tests); Modify: `apps/daemon/src/compose-pi.ts` (M7R151)

**Interfaces:** `skills.list { cwd? } → { skills: SkillView[] (≤ 500), truncated }` with `SkillView { name, description, path, scope: "user" | "project" | "package" | "other", disableModelInvocation }` (`pi:read`); `skills.setInvocation { items: { path, disabled }[] (≤ 100), cwd?, confirmProtected?: true } → { results: { path, ok, code? }[] }` (`pi:admin`; an item that is a project skill needs `confirmProtected: true`, else `bad_request` for that item: M7R133); `skills.search { query } → { results: { name, source, installs: number | null, url: string | null }[] (≤ 20) }` (`pi:read`; network on this call only); `skills.install { source, scope: "global" | "project", cwd?, confirmProtected?: true } → { ok: true }` (`pi:admin`; M7R140). The two scopes:
- `global` needs a live step-up;
- `project` needs `cwd` (a trusted project the caller has) and `confirmProtected: true`, and no step-up. A request that misses one is `bad_request`.

Also produces: `setFrontmatterFlag(text, key, on): string | null`, `skillSource(raw): string | null`, `skillInstallArgs(source, scope): string[]`, `SKILLS_CLI`.

**Rulings (pre-dispatch):**
- M7R110 [24] Skills are listed by Pi's own `DefaultResourceLoader` for the folder (the project's skills only while trusted), with no extension loaded — P10-1 — cost if wrong: skills an extension adds at run time are missing from Settings (they show in the `$` menu, Task 27).
- M7R111 [24] The invocation switch edits only the `disable-model-invocation` line of the frontmatter of a file the loader listed for that folder (the given `path` must equal a listed `filePath`; never an arbitrary path), a `.md` regular file of at most 256 KiB, written atomically with its mode kept; a key spread over several lines is refused (`config_invalid`) rather than rewritten — cost if wrong: none.
- M7R112 [24] skills.sh install (owner m7: keep; the scope rule is M7R140) spawns `npx` without a shell, with a **pinned** `skills` CLI version (chosen ≥ 3 days old at implementation, a constant with a test), the source validated (code below; never starts with `-`), `-y --agent pi`, `-g` for global; project installs need a trusted project and run in its folder; 5-minute deadline, output kept as an 8 KiB tail and never returned; the environment is the helper's (no `PAP_*`) — cost if wrong: if the owner declines, the method and its button go (search stays as a link-out).
- M7R113 [24] Search sends the query to `https://skills.sh/api/search` (15 s, 1 MiB) only on the owner's search; results are untrusted text (clipped, URLs `https:` only) — cost if wrong: none.

```ts
// packages/pi-host/src/helper/skill-source.ts (binding)
const OWNER_REPO =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:@[A-Za-z0-9][A-Za-z0-9._:-]{0,99})?$/;
const GITHUB =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/tree\/[A-Za-z0-9._/-]{1,200})?$/;
/** Pinned at implementation: a `skills` release at least 3 days old (minimumReleaseAge); a test pins the exact string. */
export const SKILLS_CLI = "skills@0.0.0-pin-at-implementation";

/** M7R112: an `owner/repo[@skill]` or a GitHub URL; anything else (an option, a path, a URL elsewhere) is refused. */
export function skillSource(raw: string): string | null {
  const source = raw.trim();
  return OWNER_REPO.test(source) || GITHUB.test(source) ? source : null;
}

/** The exact `npx` arguments: no shell, no other flag a source could add. */
export function skillInstallArgs(source: string, scope: "global" | "project"): string[] {
  return ["--yes", SKILLS_CLI, "add", source, "-y", "--agent", "pi", ...(scope === "global" ? ["-g"] : [])];
}
// spawn (binding): execFile("npx", skillInstallArgs(source, scope), { cwd, env, shell: false, timeout: 300_000,
//   maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }) with cwd = the trusted project folder, or the home folder for global.
```

```ts
// packages/pi-host/src/helper/frontmatter.ts (binding)
/** Sets (`on`) or removes one `key: true` line of a Markdown file's leading YAML frontmatter, every other byte kept. */
export function setFrontmatterFlag(text: string, key: string, on: boolean): string | null {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const head = /^---(\r?\n)/.exec(body);
  if (head === null) return null;
  const eol = head[1] as string;
  const close = body.indexOf(`${eol}---`, head[0].length - eol.length);
  if (close === -1) return null;
  const inner = body.slice(head[0].length, close);
  const lines = inner === "" ? [] : inner.split(eol);
  const named = (line: string): boolean => line.startsWith(`${key}:`) || line.startsWith(`${key} :`);
  // A value continued on indented lines would be cut in half: refuse instead of guessing (M7R111).
  if (lines.some((line, at) => named(line) && /^[ \t]/.test(lines[at + 1] ?? ""))) return null;
  const kept = lines.filter((line) => !named(line));
  if (on) kept.push(`${key}: true`);
  return `${bom}---${eol}${kept.join(eol)}${body.slice(close)}`;
}
```

**Tests (key assertions):** `frontmatter.test.ts`: add and remove round-trip a file byte for byte (LF and CRLF, with a BOM); an existing `disable-model-invocation: false` line is replaced; empty frontmatter gets the line; no frontmatter → null; a folded multi-line value under the key → null; the body is untouched even when it contains `---`. `skill-source.test.ts`: `vercel-labs/agent-skills`, `owner/repo@skill`, `https://github.com/o/r/tree/main/skills/x` accepted; `--registry=evil`, `-g`, `../x`, `https://evil.test/o/r`, `o/r --x`, `o/r;rm`, an empty string refused; `skillInstallArgs` exact arrays. `skills-install.test.ts`: with a fake `npx` first on the helper's `PATH` that writes its argv and cwd to a file, a global install records exactly `["--yes", SKILLS_CLI, "add", "o/r", "-y", "--agent", "pi", "-g"]` and the home cwd; a project install in an untrusted project → `forbidden` and the fake never ran. Scope rows (M7R140):
- a project install in a trusted project with `confirmProtected: true` and no step-up records the same array without `-g` and the project as cwd;
- the same without `confirmProtected` → `bad_request`, and the fake never ran;
- a global install without a step-up → `step_up_required`.

A fake that sleeps past a 1 s test deadline is killed. `skills.test.ts`: the list holds user and trusted-project skills with scope; an untrusted project's skills are absent; `setInvocation` on a path not in the list → `not_found` per item; search parses a recorded skills.sh JSON shape through an injected fetch (no network) and drops a `javascript:` URL.

Mutation checks: remove the `-` refusal (accept any source) → `--registry=evil` passes; spawn with `shell: true` → the argv test sees a shell; let `setInvocation` take any `.md` path → the not-listed case edits.

- [ ] Steps: RED → frontmatter, source → ops → module → gate with `pnpm test:int`, `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(skills): list skills, switch model invocation, search and install from skills.sh"`

### Task 25: Plugins (Pi packages): list, install, remove, update, enable (security contract)

**Files:**
- Create: `packages/pi-host/src/helper/plugin-source.ts`, `helper/ops/plugins.ts` (+ tests); Modify: `packages/contracts/src/{skills-methods,pi-helper}.ts`, `apps/daemon/src/modules/skills/{service,rpc}.ts`

**Interfaces:** `plugins.list { cwd? } → { plugins: { source, scope: "user" | "project", installedPath: string | null, enabled: boolean, filtered: boolean }[] (≤ 200) }` (`pi:read`; `source` masked with `maskUrl`); `plugins.install { source, scope, cwd?, confirmProtected? }`, `plugins.remove { source, scope, cwd?, confirmProtected? }`, `plugins.update { source?, scope?, cwd?, confirmProtected? }`, `plugins.setEnabled { items: { source, scope }[] (≤ 100), enabled, cwd?, confirmProtected? } → { results }` (all `pi:admin`). The scope rule of M7R140:
- a global `install` or `update` needs a step-up;
- every project-scope call needs `confirmProtected: true` and a trusted project, and no step-up.

Also produces: `pluginSource(raw): string | null`.

**Rulings (pre-dispatch):**
- M7R114 [25] Everything goes through Pi's `DefaultPackageManager` and `SettingsManager.setPackages` / `setProjectPackages` in the helper; disabling writes empty `extensions`, `skills`, `prompts` and `themes` arrays on the entry (pi-web); a filtered package is reported and refused by the group switch — cost if wrong: none.
- M7R115 [25] Sources are validated before Pi sees them (code below): `npm:` specs, `git:` host/path[@ref], `https://` git URLs without userinfo, query or fragment, and absolute local paths inside the home folder; a source can never start with `-` — why: Pi hands the source to npm or git — cost if wrong: a relative local path must be written absolute.
- M7R116 [25] Project installs need a trusted project and `confirmProtected: true` (M7R133, M7R140); the helper runs with `PI_TELEMETRY=0` (Pi's install telemetry stays off: a test asserts the network guard saw no request for a local-path install) — cost if wrong: none.
- M7R117 [25] Update check: when the SDK offers no read-only check, "Update" applies `update(source)` and reports what changed; the button says "Update" (never "Check") — the implementer reports which — cost if wrong: copy only.

```ts
// packages/pi-host/src/helper/plugin-source.ts (binding)
import { isAbsolute, resolve } from "node:path";
import { within } from "../policy/target-path.ts";

const NPM = /^npm:(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}(?:@[A-Za-z0-9._+-]{1,64})?$/;
const GIT = /^git:[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._/-]{1,200}(?:@[A-Za-z0-9._/-]{1,128})?$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._/-]{1,200}$/;

/** M7R115: a package source Pi may install, or null. Local paths: absolute, inside `home`, no `..` left after resolving. */
export function pluginSource(raw: string, home: string): string | null {
  const source = raw.trim();
  if (source.startsWith("-")) return null;
  if (NPM.test(source) || GIT.test(source) || HTTPS.test(source)) return source;
  if (!isAbsolute(source) || source.includes("\0")) return null;
  const path = resolve(source);
  return within(home, path) && path === source.replace(/\/+$/, "") ? path : null;
}
```

**Tests (key assertions):** `plugin-source.test.ts`: `npm:@example/pi-tools@1.0.0`, `git:github.com/example/pi-tools@v1`, `https://github.com/example/pi-tools`, `<home>/pkgs/x` accepted; `--registry=x`, `npm:-x`, `https://u:p@h/x`, `https://h/x?y=1`, `./x`, `<home>/../etc`, `/etc/x`, `file:///x` refused. `plugins.test.ts` (temp agent dir, a local package folder under the test home with `package.json` and `skills/`): install as a local path adds it to `settings.json` packages; list shows it enabled; disable writes the four empty arrays and list says `enabled: false`; remove drops it; a project install in an untrusted project → `forbidden`; a project install without `confirmProtected` → `bad_request`; a global install without a step-up → `step_up_required`; the network guard saw nothing.

- [ ] Steps: RED → source → op → methods → gate with `pnpm test:int`.
- [ ] Commit: `git commit -m "feat(skills): Pi package plugins through Pi's package manager"`

### Task 26: Web: Settings › Skills (skills and plugins)

**Files:**
- Create: `apps/web/src/features/skills/{SkillsSection,SkillList,SkillSearch,PluginList,PluginInstall}.tsx`, `skills.vm.ts`, `i18n/catalog/settings-skills.ts` (+ tests); Modify: `routes/settings/sections.tsx` (one line), `features/workspace/model.ts` (+ `skills`), `sections.test.tsx`, `i18n/lazy-catalog.test.tsx`

**Rulings (pre-dispatch):**
- M7R118 [26] *(changed at the plan fix: owner m7 note, M7R140)* Groups by scope, with group switches and per-item results (P10-5).
  - Every install form starts with the scope choice, "This project (<name>)" or "All my projects". It defaults to the project of the session the owner came from (the workspace's last active session, when it has a project), else "All my projects".
  - "This project" asks "Save anyway?" (M7R133) and sends `confirmProtected: true`; "All my projects" goes through the step-up prompt.
  - The form names what runs, for the chosen scope: "pap runs `npx skills@<version> add o/r -y --agent pi -g`" (no `-g` for a project), or "Pi installs the package with npm".
  - The section's note says that skills live in your Pi folder or the project, and that per-user skills come with teams.
  - Switching a project skill's invocation asks "Save anyway?" too.
  - The results of a search are untrusted text, and their links open in a new tab with `rel="noopener noreferrer"`.
  
  Cost if wrong: copy only.

**Tests (key assertions):** vm group switch states; a refused item in a group switch shows under the heading; the install card shows the exact command text from the pinned constant served by the method, with `-g` only for "All my projects"; the scope defaults to the last active session's project and to "All my projects" without one; a project install asks "Save anyway?" and sends `confirmProtected: true`; en + fr; lazy.

- [ ] Steps: RED → components → section wiring → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): Settings › Skills — skills and plugins"`

### Task 27: The `/` command menu, `$skill` chips and the shared `TextField` props

**Files:**
- Modify: `packages/contracts/src/{pi-host,session-model-methods}.ts` (`get_commands`, `sessions.commands`); Create: `packages/pi-host/src/slash-commands.ts` (+ test); Modify: `dispatch.ts` (a union by hunk, agreement 8), daemon `sessions/service-models.ts`, `rpc.ts`
- Modify: `packages/ui/src/primitives/TextField.tsx` (+ `TextField.test.tsx`). It gets M8R83's six optional props, with M8R83's names and semantics:
  - `inputRef`;
  - `onKeyDown`, which runs first: a `defaultPrevented` event skips the submit shortcut;
  - `onPaste`, `onDrop`, `onDragOver`;
  - `combobox: { expanded: boolean; controls: string; activeDescendant: string | null }`, which sets `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant` and `aria-autocomplete="list"`.
  
  M7 executes beside M8, so its branch needs them. The rebase onto an M8-first `main` keeps `main`'s copy (merge notes). If `main` already has them when this task is dispatched, this file is skipped.
- Create: `apps/web/src/features/sessions/use-composer-commands.ts`, `CommandMenu.tsx` (lazy), `SkillChip.tsx`, `composer-commands.vm.ts` (+ tests); Modify: `i18n/catalog/session-models.ts`
- Modify: `apps/web/src/features/sessions/Composer.tsx`:
  - the composer's one textarea ref, `const fieldRef = useRef<HTMLTextAreaElement | null>(null)`, which M8's mentions share after the rebase;
  - `const commands = useComposerCommands({ text: c.text, setText: c.changeText, fieldRef })`;
  - `{commands.menu}` above the field;
  - on the `<TextField>`: `inputRef={fieldRef} onKeyDown={commands.onKeyDown} combobox={commands.combobox}`.
  
  Nothing in `use-composer.ts`.

**Interfaces:**
- `useComposerCommands({ text, setText, fieldRef }) → { onKeyDown(event): void; combobox: { expanded, controls, activeDescendant }; open: boolean; close(): void; menu: ReactNode }` (agreement 7).
- `sessions.commands { sessionId } → { commands: { name, description: string | null, source: "extension" | "prompt" | "skill", builtinMcp: boolean }[] (≤ 500), truncated }` (`sessions:read`; it starts a cold worker, like `sessions.models`).
- `activeTrigger(text, caret): { char: "/" | "$", query, start } | null`.

**Rulings (pre-dispatch):**
- M7R119 [27] `/` at the start of the text opens the menu of extension commands, prompt templates and skills (Pi's `get_commands`; T3 `commands.ts`); `$` at the start of a word opens the menu of skills only (T3's `$` chips); picking a command completes `/<name> `; picking a skill puts `/skill:<name> ` at the start of the text (Pi's own expansion; one skill per message, owner m8, M7R141; no tiptap, owner c2, M7R132) and the chip `$<name>` with × shows above the field while the text starts that way — cost if wrong: if the owner wants several skills, a later task adds an input hook (T3 `mcpExtensionSource.ts`).
- M7R120 [27] Enter on the highlighted `/mcp` row opens Settings › MCP instead of sending when that command's source is Pi's built-in (`builtinMcp`: its `sourceInfo.path` is `builtin:mcp`); otherwise `/mcp` is sent and Pi's own manager runs in the session (P09-11) — cost if wrong: none.
- M7R121 [27] The menu is keyboard first (↑ ↓ Enter Tab Esc; Esc closes the menu, never stops the run while it is open: the dispatcher's open-menu rule, M3), rendered as `role="listbox"` with `role="option"` rows and `aria-selected` like M8's mention menu (the dispatcher reads an open listbox as `overlayOpen`), touch targets 44 px, results capped at 50 rows, untrusted descriptions clipped to 200 and rendered as text — cost if wrong: none.
- M7R122 [27] *(corrected at the plan fix: M7-RT-01; agreements 7, 22)* The menu reads the caret and intercepts keys through M8R83's shared `TextField` props, not "through the composer root":
  - `useComposerCommands` reads `fieldRef.current.selectionStart` for `activeTrigger`.
  - Its `onKeyDown` acts only while the menu is open. It handles ↑ ↓ Enter Tab Esc and calls `preventDefault()`, so the field's submit shortcut never fires on Enter (M8R83). While the menu is closed it does nothing.
  - `use-composer.ts` and `sessions.prompt` are M8's and stay untouched.
  - `Composer.tsx` gets M7's 3 mount lines in all: Task 9's `<ModelBar/>`, the hook call and `{commands.menu}`. Add to these the field's three props and the composer's one textarea ref, which is the shared plumbing of M8R83.
  - One menu at a time. `/` (start of the text), `$` and `@` (start of a word) cannot all hold at one caret position. `Composer.tsx` chains the handlers with the open menu's first and sets the open menu's `combobox`; after the rebase it does so through M8's field-props helper.
  - If M7 merges first, these props and this ref are M7's landing of M8R83, and M8 rebases onto them.
  
  Cost if wrong: a rename at the merge (the names are M8R83's).

**Tests (key assertions):** pi-host: `get_commands` lists a test prompt template, a skill (`skill:<name>`, source `skill`) and the MCP `/mcp` with `builtinMcp: true`, cut at 500. vm: `activeTrigger("/re", 3)` → `/` query `re`; `"see $pd", 7` → `$` query `pd`; `"a$b"` (not a word start) → null. Component: picking skill `pdf` on `"please $pd"` gives `/skill:pdf please ` and shows the chip; × removes the prefix; Esc closes the menu and leaves the text; Enter on built-in `/mcp` opens Settings › MCP and clears the field; a third-party `/mcp` is completed, not intercepted.
- `TextField.test.tsx`, M8R83's own three cases, so both branches carry the same test: `onKeyDown` with `preventDefault` on Mod+Enter skips `onSubmitShortcut`; `combobox` sets the four ARIA attributes; `inputRef` receives the textarea.
- `use-composer-commands.test.tsx`, with the real `TextField`:
  - typing `/re` with the caret at 3 opens the menu, and `combobox.expanded` is true;
  - ArrowDown moves `activeDescendant`;
  - Enter while the menu is open picks the row, and `onSubmitShortcut` and `c.send` are not called;
  - Enter with the menu closed sends;
  - Esc closes the menu, and the dispatcher's `readContext` reports `overlayOpen` while it is open.
- `Composer.test.tsx` additions: the composer still renders and sends with no command list (cold session).

- [ ] Steps: RED → pi-host command and daemon method → `TextField` props (skipped if `main` has them) → vm and hook → components → the `Composer.tsx` lines → gate with `pnpm test:int`, `pnpm build && pnpm budgets` (+0.1 KB initial for the `TextField` props; the menu is lazy).
- [ ] Commit: `git commit -m "feat(sessions): slash command menu and skill chips in the composer"`

### Task 28: M5 UI items and the read-only commands switch

**Files:**
- Modify: `packages/contracts/src/policy.ts` (`SessionPolicyView.defaultMode`; `READ_ONLY_COMMAND_NAMES` for display), `packages/pi-host/src/policy/read-only-commands.test.ts` (new: ties the names to `READ_ONLY_COMMANDS` and `GIT_READ_ONLY`), `apps/daemon/src/modules/policy/session-service.ts` and `sessions/policy-link.ts` (fill `defaultMode`)
- Modify: `apps/web/src/features/policy/ApprovalsPanel.tsx` (mode list with all four descriptions; the read-only commands switch and list), `features/sessions/SessionPolicy.tsx` ("Use my default (<mode>)" always named), `features/auth/tokens.vm.ts` (grid from used permissions), `i18n/catalog/{settings-approvals,session-policy,settings-access}.ts` (+ tests)

**Rulings (pre-dispatch):**
- M7R123 [28] The approval mode picker becomes a radio list of the four modes, each with its one-line description always visible, full access with its limits line (decision 75 Q7); the session bar's default entry always names the default mode from `SessionPolicyView.defaultMode` — cost if wrong: copy and layout only.
- M7R124 [28] The token grid shows only permissions some method declares (computed from the contracts' method catalogue), so `policy:operate`, `sessions:admin`, `settings:admin`, `system:operate/admin`, `audit:operate/admin` and `pi:operate` disappear, and M8's unused levels too (agreement 4: `TOKEN_PERMISSIONS` stays one filter excluding `auth:*`, `policy:admin`, `pi:admin` and `terminal:*`, and the grid reads it); the daemon still accepts every `TOKEN_PERMISSIONS` value (existing tokens keep working) — M5 final review M5 — cost if wrong: none.
- M7R125 [28] The read-only commands switch (default on) lists the commands by name, and says when it cannot act ("pap cannot check commands while Pi runs a shell command prefix, a custom shell or a project folder on PATH: they ask as before") — cost if wrong: copy only.

**Tests (key assertions):** contracts: `SessionPolicyView` with `defaultMode` parses and an old one without it defaults to `auto-accept-edits`; the pi-host test fails when a command is added to the table without its display name; web: all four descriptions are in the document at once; `defaultNamed` renders "Use my default (Supervised)" when the owner's default is supervised and the session follows it; `permissionGrid()` has no `policy:operate` and still has `sessions:operate`; the switch sends `readOnlyCommands: false` in `policy.setSettings`.

- [ ] Steps: RED → contracts and daemon → web → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): approval mode descriptions, named default mode, used token permissions, read-only commands switch"`

### Task 29: First-run stepper (account → passkey → Pi)

**Files:**
- Create: `apps/web/src/features/auth/{SetupStepper,PiStep}.tsx`, `setup-stepper.vm.ts`, `i18n/catalog/first-run.ts` (+ tests); Modify: `features/auth/SetupScreen.tsx` (becomes step 1 inside the stepper), the setup route

**Rulings (pre-dispatch):**
- M7R126 [29] Steps as DESIGN §10 "Mobile + system" draws them: 1 account (today's form), 2 passkey (M5's `AddPasskey`, Skip), 3 Pi: `models.overview` → when a provider is configured, "Ready" with the default model and a change link; otherwise the provider list and sign-in flow of Task 13 (lazy) and a key form, Skip; the stepper never blocks use (every step after 1 is skippable) — M3R106 — cost if wrong: none.
- M7R127 [29] Step 3's sign-in asks for the password once (the step-up), like Settings; no change to the auth module (owner m12, M7R145) — cost if wrong: one extra password entry at first run.
- M7R128 [29] The stepper's state lives in the page only (a reload after step 1 lands on home, signed in; Settings › Models finishes the job) — cost if wrong: none.

**Tests (key assertions):** after setup the stepper shows step 2; Skip goes to step 3; with a configured provider step 3 shows "Ready"; without one it shows the provider list (lazy chunk loaded); finishing navigates home; en + fr; the initial bundle grows by the stepper shell only (≤ 1 KB).

- [ ] Steps: RED → vm → components → gate with `pnpm build && pnpm budgets`.
- [ ] Commit: `git commit -m "feat(web): first-run stepper with a Pi step"`

### Task 30: Docs, ADRs, the parity run, budgets and the final gates

**Files:** `docs/adr/0024-read-only-commands-and-pattern-rules.md` (new; with the git config check of owner m3), ADRs 0023, 0025–0028 checked against the code; `docs/agents/{models,mcp,skills}.md` (new; `models.md` and `mcp.md` state the `$HOME`-wide dotfiles latitude of M7R146, `skills.md` the install scopes and the per-user deferral of M7R140), `policy.md` (read-only commands with the table, the git config check and its friction (M7R148, M7R149), the residuals of M7R10 and M7R150, pattern rules, MCP wired, the read-only preset), `daemon.md` (helper pool, `PAP_HELPERS_MAX`, the four modules), `sessions.md` (loadout, presets, outside tool results), `web.md` (composer mounts, Settings sections), `auth.md` (`pi:admin` never a token permission); `AGENTS.md` (≤ 150 lines: the worker settings line names `PAP_HELPERS_MAX` beside M8's `PAP_MAX_TERMINALS`, agreement 10; the topic notes); `budgets.json` (re-measured); `docs/research/m7-rulings.md` (every ruling of this plan, M7R1–M7R153, with the execution ledger's changes); `apps/daemon/src/security/pi-token.test.ts` (M7R152: at least 25 `pi:admin` methods are listed, each `forbidden` to a token).

**Rulings (pre-dispatch):**
- M7R129 [30] The parity run: for each row of the checklist the proof test exists and passes, or the owner decision is cited; the verdicts go in `docs/agents/models.md` §Parity; a red row stops the milestone — cost if wrong: none.
- M7R130 [30] `budgets.json` is set to `min(ceil(measured × 1.10), 300)` (decision 75 Q8); above 250 KB the controller asks the owner first — cost if wrong: none.

- [ ] Steps: docs and ADRs → parity run → full gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke`.
- [ ] Commit: `git commit -m "docs: M7 notes, ADRs 0024–0028 and the D07–D10 parity verdicts"`

---

## Exit criteria (roadmap M7)

All testable on this headless host, without a browser:

1. **Gates:** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke` green (Task 30); every task's commit body records its bundle figure.
2. **The pi-web D07–D10 parity checklist is green** (Task 30, M7R129): every row's proof test passes, or the row cites the owner decision that dropped or moved it (P07-12: owner m4; P08-3 and P08-5: owner m10; the partial rows of owner m6 and m9).
3. **Decision 75 carries and owner m3:** read-only commands run unasked in the default mode while the ASKS and git tables of Task 1b, the config-check cases of Task 1a and the taint, denylist, guard and fsmonitor-marker cases of Task 1c hold; a session continued outside pap with new tool results is tainted (Task 3); the M5 UI items are in (Task 28).
4. **M5's security suite still passes**, and its MCP cases now run through a real daemon worker (Task 5); `docs/agents/policy.md` no longer says MCP is exercised in-process.
5. **The owner's checks on the preview** (decision 42; e2e is M13):
   - the model pill and reasoning menu in a real session, a model change, a reasoning change during a run;
   - Settings › Models: sign in to a real provider (OAuth or key) from a phone over the ngrok address, then sign out; the switches; the models.dev switch is off on a fresh home and no "Look up" control shows until it is switched on;
   - Settings › MCP: add a real server, Test it, turn it off in a project (the "Save anyway?" ask, no password), remove it and Undo;
   - Settings › Skills: switch a skill's model invocation; the install form's scope defaults to the session's project and shows the exact command for each scope; install nothing unless wanted;
   - a project with `.pi/` resources: the banner, the trust dialog's list, trusting it, the session restarting with project MCP servers;
   - `ls`, `git status`, `rg foo` running without a card; `curl` still asking; `pnpm test` always-allowed as a prefix; in a repository with `git lfs install --local` (or any program key in `.git/config`) `git status` asks: the expected friction of M7R149;
   - the first-run stepper on a fresh `PAP_HOME` (a scratch home, not the preview's).

## Coverage map (roadmap, carries, spec → tasks)

| Requirement | Task |
|---|---|
| D07 selector, reasoning levels | 7, 9 |
| D07 `enabledModels` minimal edits | 10, 13 |
| D07 `models.json` editor | 12a, 14 |
| D07 OAuth / API keys | 11, 13 |
| D07 pricing (opt-in, owner m5) | 12b, 14 |
| D07 quotas | deferred to M10 (owner m4) |
| D07 side-effect-free discovery | 6a, 8 (helper, no network unless clicked) |
| D08 presets none / read-only / default / full, Chat only | 15, 16 |
| D08 codemode, tool-search | 4, 18, 20 |
| D08 pattern always-rules (decision 68, M5 Q14) | 2a, 2b |
| D09 MCP client in sessions | 4, 5 |
| D09 Settings › MCP: masking, exposure, undo, Test, sign-in, paste importer | 17–21 (sign-in: owner m6) |
| D09 project trust UI on S7's store | 22, 23 |
| D10 skills and plugins management (a scope per install, owner m7) | 24–26 |
| D10 `get_commands`, `$skill` chips | 27 |
| Decision 74 / M5 Task 9 carry: MCP, codemode, tool_search wiring, `models: false` | 4 |
| M5 Task 25a carry: real-worker MCP exit tests | 5 |
| M5 deferred minor: nested codemode root | 4 |
| Decision 75 Q5: taint on outside tool results | 3 |
| Decision 75 Q6: read-only command allowlist, first task | 1b, 1c |
| Owner m3: git read commands only when the repository's config runs nothing | 1a (1b, 1c) |
| Owner c3: Pi config step-up, project protected-file confirmation, tokens never confirm | 6a (token test), 8, 11, 12a, 12b, 17–26 |
| Decision 75 Q7: mode descriptions, `defaultMode`, token grid | 28 |
| M3R106: first-run stepper | 29 |
| ADR 0001 "trust from pap's UI in M7" | 22, 23 |
| Spec C §2.3 records `set_model`, `set_thinking_level`, `get_commands`, `get_available_models` | 7, 27 |
| Spec C §5.2 stage 00 exposure as a decision (presets, codemode, tool-search, MCP exposure) | 4, 15 |
| Spec C §9.4 zero telemetry (catalog refresh on action only; models.dev opt-in) | 6a, 8, 12b, 24 |

## Open questions for the owner (all answered on 2026-10-13)

The owner answered every question on 2026-10-13 (`.superpowers/owner-decisions-2026-10-13-m7m8.md`). Each answer is a ruling in "Owner decisions" above; this table stays for the record. The red-team added the last two rows, and they were asked on the same page.

| # | Question | Default | Recommendation and friction left | Answer (2026-10-13) |
|---|---|---|---|---|
| Q1 | In which modes do read-only shell commands run without a card? (a) supervised and auto-accept-edits; (b) auto-accept-edits only; (c) also read-only mode | (a) | (a): supervised already runs built-in reads; read-only mode keeps its "no shell" promise. Friction: in read-only mode `ls` through the shell is still blocked (the built-in `ls` works). | **(a)**: m1, M7R134 |
| Q2 | After external content (tainted session), do read-only commands still run? (a) yes, like built-in reads; (b) they ask Deny / Allow once | (a) | (a): no listed command can reach the network, and every call that can carry data out still asks. Friction with (b): every `cat` after a web fetch asks. | **(a)**: m2, M7R135 |
| Q3 | Which Pi configuration changes ask for your password (step-up, valid 5 minutes)? (a) those that run code, add a credential or change where requests go: sign-in, API key, `models.json` save, discover, MCP add / undo / Test, plugin and skill install or update, trusting a project; (b) every change; (c) none | (a) | (a). Friction: one password entry per 5 minutes in those flows; switches, defaults and removals never ask. | **(a)**, asked once with M8 Q3 as c3: Pi config takes the step-up on this list, and a project's protected files take a "Save anyway?" confirmation: M7R133 |
| Q4 | Provider usage quotas (ten provider endpoints called with your stored credentials): (a) M10 with FinOps; (b) M7 (+1 task) | (a) | (a): M10 owns usage, budgets and the quota auto-resume. | **(a)**: m4, M7R137 |
| Q5 | "Look up pricing" contacts models.dev when you click it: (a) keep; (b) drop | (a) | (a): pap contacts nobody unless you click, and the copy names models.dev. | **(a)**, as an **opt-in**: a switch, off by default: m5, M7R138 |
| Q6 | MCP OAuth sign-in and live connection state: (a) sign in with `/mcp` in a session (Pi's own flow; you paste the address your browser ends on), Settings shows file state and the last Test; (b) build a Settings button on Pi internals the SDK does not export (fragile at every SDK update) | (a) | (a). Friction: a sign-in needs a session open; Settings says how. | **(a)**: m6, M7R139 |
| Q7 | skills.sh install runs `npx skills@<pinned version> add <source> --agent pi` (downloads and runs that CLI): (a) keep, pinned, with the exact command shown and a password step; (b) search only, install by hand | (a) | (a). Friction: none beyond the step-up; risk: you run the `skills` CLI's code at that version. | **(a)**, with a **scope per install** (this project / all my projects); per-user skills after v1: m7, M7R140 |
| Q8 | `$skill` chips: (a) one skill per message, sent as Pi's own `/skill:name`; (b) several skills anywhere in a message (+1 task, a pap input hook) | (a) | (a): Pi-native, no new extension. | **(a)**: m8, M7R141 |
| Q9 | Settings › Models lists built-in and `models.json` providers; a provider an extension adds appears in the session's model menu and signs in with the `pi` CLI: (a) yes; (b) load your global extensions in the helper too (runs extension code to show Settings) | (a) | (a). Friction: an extension-only provider needs `pi` once for sign-in. | **(a)**: m9, M7R142 |
| Q10 | Two pi-web rows are dropped: Chat only's exact system prompt, and the PowerShell switch (pap runs on Linux and WSL2 only): (a) drop; (b) keep | (a) | (a). | **(a)**: m10, M7R143 |
| Q11 | tiptap composer (DESIGN §9.2): (a) not in M7 or M8 (chips sit beside the plain field), revisit with M11's `@Agent`; (b) M8 restructures the composer with tiptap; (c) M7 does | (a) | (a): no restructure while both milestones edit the composer. Friction: chips are a row, not inline tokens. | **(a)**, asked once with M8 Q9 as c2: no tiptap this wave, revisit at M11: M7R132 |
| Q12 | codemode runs with `models: false` (decision 74 carry): scripts cannot call classifier or image models (Pi's Jev, image generation). (a) keep; (b) a setting to allow it (script data then reaches a provider outside any judged call) | (a) | (a). Friction: those two codemode features are off. | **(a)**: m11, M7R144 |
| Q13 | First-run step 3 asks your password again before a sign-in (the step-up of Q3): (a) accept; (b) setup marks its new browser session as confirmed for 5 minutes (a small auth change) | (a) | (a) keeps the auth module untouched in M7; (b) is one line plus a test if you prefer no second prompt. | **(a)**: m12, M7R145 |
| Q14 | Merge order with M8: (a) M8 first, M7 rebases; (b) whichever passes its final review first | (a) | (a): M8 opens the critical path M8 → M9 → M11; M7's 16 Opus reviews make it the longer run. | **(a)**: c1, M7R131 |
| Q15 (M7-RT-04, page m3) | With read-only commands on, `git status` / `git diff` run unasked; a repository's own `.git/config` can name a program they run (`core.fsmonitor`, `diff.external`, a textconv driver). Accept that residual? | accept (documented) | the owner chose a check instead | **Check**: such commands ask unless the repository's config (with `config.worktree` and its includes) names no program: m3, M7R136 (Task 1a) |
| Q16 (M7-RT-06, page m13) | The `models.json` / `mcp.json` editors follow a dotfiles symlink anywhere inside `$HOME` | keep | keep | **Keep** (dotfiles): m13, M7R146 |

## Merge order and conflict notes (with M8)

The cross-plan agreements of 2026-10-13 bind both executions: `.superpowers/m7-m8-cross-plan-agreements.md`, items 1–24, with the owner amendments. The items that concern M7 are written here in substance. M8's plan states its own final names (agreement 23).

1. **Order** (agreement 1; owner c1, M7R131): M8 first, unless M7 passes its Opus final review more than one working day before M8. The second branch rebases once and resolves the shared files below. After each merge, the controller re-measures the bundle and re-runs every gate, with `env -i … CI=1 pnpm test:int` and `pnpm smoke`.
2. **Migrations** (agreement 2): M8 has none. M7 has `policy/migrations/202610131000_pattern_rules.sql` and `sessions/migrations/202610131010_tool_preset.sql`, in sources already listed in `MIGRATION_SOURCES`. With either order, nothing is re-stamped.
3. **Error codes** (agreements 3 and 23):
   - M7's final new codes are exactly `helper_failed`, `project_scope`, `config_invalid` and `config_path_refused`. M8's are `protected_path` and `terminal_unavailable`. The two sets are disjoint.
   - Order in `ERROR_CODES` after both merges: M8's two after `read_only`, then M7's four, all before `unknown_method`. On M7's branch before the rebase, M7's four sit right after `read_only`.
   - M7's `errors.test.ts` asserts membership and messages, never adjacency.
   - Every code has its eager message in `apps/web/src/i18n/catalog/shell.ts`.
   - M7 needs no `protected_path`: a project write without `confirmProtected` is `bad_request` (M7R133).
4. **Domains and tokens** (agreements 4 and 5):
   - After both merges, `DOMAINS = [… "audit", "files", "vcs", "terminal", "pi"]`. M7's branch has `… "audit", "pi"`.
   - `TOKEN_PERMISSIONS` is one filter, excluding `auth:*`, `policy:admin`, `pi:admin` and `terminal:*`.
   - M7R124's grid shows only the permissions some method declares, which also hides M8's unused levels.
   - Tokens never make a standing or code-running change: no `confirmProtected`, no write under `<agentDir>` or a project `.pi/`, no `pi:admin`, no `terminal:*`. M7's refusals answer `forbidden` and are pinned by Task 6a's `pi-token.test.ts` (M7R152).
5. **Pi configuration has one writer** (agreement 6; owner c3 and f10): M7 alone reads and writes `<agentDir>/{auth,models,mcp,trust,settings}.json`, through its helper, masked, with the step-up (M7R133). M8's file boundary classes these files `pi_private` for every intent, and M8 never edits Pi config (agreement 21). A project's `.pi/mcp.json` is visible to the owner in M8's explorer and refused to tokens. M7 edits it from Settings with "Save anyway?".
6. **The composer** (agreements 7 and 22; owner c2):
   - Neither plan restructures the composer, and there is no tiptap this wave.
   - M8 owns `use-composer.ts`, `sessions.prompt` params, and `TextField`'s passthrough props (M8R83: `inputRef`, `onKeyDown`, `onPaste`, `onDrop`, `onDragOver`, `combobox`).
   - M7's `/` and `$` menu is `useComposerCommands({ text, setText, fieldRef })` → `{ onKeyDown, combobox, open, close, menu }`.
   - `Composer.tsx` chains the open menu's handler first, sets one `combobox`, and keeps one menu open at a time.
   - Mount budget: M7 at most 3 lines (`<ModelBar/>`, the hook call, `{commands.menu}`), M8 at most 6.
   - M7 executes beside M8, so Task 27 lands M8R83's props on M7's branch with M8R83's names (M7R122).
   
   **Rebase steps when M8 merged first:**
   - Take `main`'s `TextField.tsx` and `TextField.test.tsx` whole (same names, so M7's copy is simply dropped).
   - Keep one textarea ref (M8's when it has one) and pass it to `useComposerCommands` as `fieldRef`.
   - Feed the hook's result into M8's field-props helper (`composer/menus.ts`, `composerFieldProps`), so the open menu's `onKeyDown` runs first and only the open menu's `combobox` is set.
   - Keep both mount sets.
   - Rerun `use-composer-commands`, `CommandMenu`, M8's `Composer.test.tsx` and `use-mentions` tests.
   
   If M7 merges first, M8 does the mirror: its menus plug into M7's field props, and M7's ref and props stay.
7. **The worker prompt path** (agreement 8):
   - `sessions.prompt` params and `PromptCommand.images` are M8's. M7 never touches them, nor `packages/pi-host/src/commands.ts` (`handlePrompt`).
   - `contracts/pi-host.ts` is a union: M7 adds approval scopes, `loadout`, the model commands, `set_tools` and `get_commands`.
   - `packages/pi-host/src/dispatch.ts` is a union by hunk: M7 adds its cases, M8 adds `papHome` to `DispatchDeps` and the prompt FIFO.
   - The second merger reruns `host.images.int.test.ts`, `host.models.int.test.ts` and `host.presets.int.test.ts`.
8. **`daemon.ts` and the stop order** (agreements 9 and 24; M7R151):
   - M7 adds at most 10 lines to `daemon.ts`, through `compose-pi.ts`.
   - `stop()` runs `pi.stopAll()` (the helpers) in parallel with `sessions.shutdownAll()`, then `workspace.shutdown()` (M8's PTYs), then `killAllWorkerGroups()` (which also covers the helpers' tracked groups), then the closers.
   - `killScopes()` covers M8's terminal scopes (same home slice). Helpers have no scope; they exit when their IPC channel closes (M7R36).
   - `daemon.ts` stays ≤ 400 lines after both merges.
9. **`kernel/config.ts`** (agreement 10): `PAP_HELPERS_MAX` (M7) and `PAP_MAX_TERMINALS` (M8) are a union. AGENTS.md's worker settings line names both, and AGENTS.md stays ≤ 150 lines.
10. **Streams** (agreement 11): `STREAMS` gains `vcs` and `terminal` (M8) and `login` (M7); `CAPABILITIES` gains `terminal`; `PROTOCOL_VERSION` stays 2. `runtime/subscriptions.ts` `OPENERS` is exhaustive, and each side adds its own openers. M7's opener tests go in `subscriptions.m7.test.ts`; the 344-line `subscriptions.test.ts` stays frozen.
11. **ws** (agreement 12): `HandlerContext.binary` is optional (M8R4), and M7's handler tests build contexts unchanged. `kernel/ws/*` is M8's: M7 edits no ws file, since the stream hub is generic over `StreamName`.
12. **The sessions module** (agreement 13): `live-session.ts` (387 lines) takes at most 6 lines from M7 (Task 7 only) and at most 3 from M8, so ≤ 396 after both. M7's `service-models.ts`, `loadout-view.ts` and `restartFolder` live in other files. `service-types.ts` is a union.
13. **`kernel/supervisor/`** (agreement 14): M8 edits `scope.ts` (`next({ kind })`) and `env.ts` (the systemd variables). M7's helper pool imports `env`, `process-group`, `kill-ladder` and `worker-io` read-only, and inherits M8's environment rule.
14. **The policy folder** (agreement 15): M8 adds only `protected-lists.test.ts`. M7 consumes `target-path.ts`, `read-target.ts`, `kernel-path.ts` and the stage-01 reader without changing their semantics, so M8's test catches any drift in the protected lists. M7's new policy files (`git-config*.ts`, `command-cover*.ts`, `pattern-grants.ts`, `prefix-proposal.ts`) are M7's.
15. **Web shell** (agreement 16): in `features/workspace/model.ts`, M8's item kinds and M7's `SETTINGS_SECTIONS` are a union. `SessionScreen.tsx` gets M7's two lines only (M8's surface bar lives in `PaneHost.tsx`). `routes/shell/*` is M8's only. `stores/session-reducer.ts` gets M7's `loadout`; M8 adds nothing there.
16. **i18n** (agreement 17):
    - Eager, in `catalog/shell.ts`: M8's 6 labels and 2 error messages, and M7's 4 error messages.
    - Lazy: M8's `files`, `changes`, `terminal` and `session-files`; M7's `session-models`, `settings-models`, `settings-mcp`, `settings-skills`, `trust` and `first-run`.
    - Key prefixes are disjoint. M7's are `sessionModels.`, `models.`, `mcp.`, `skills.`, `trust.` and `firstRun.`.
    - `settings-access.ts` is a union of M8's domain labels, M7's `pi` label (Task 6a) and Task 28's grid copy.
    - The disjointness and every-code-has-a-message tests stay green on both branches.
17. **Dependencies** (agreement 18): M7 adds none. M8 adds node-pty, xterm and CodeMirror. The second merger regenerates `pnpm-lock.yaml` with `pnpm install` and checks that there is a single copy of `@codemirror/state`.
18. **Bundle** (agreement 19): M7 ≈ +4.5 KB and M8 ≈ +4.4 KB, so the merged initial bundle is ≈ 204 KB. The second merger records the figure; above 250 KB, the owner is asked.
19. **ADRs and decisions** (agreement 20): M7 uses 0023–0029 (0023–0028 are written, 0029 is unused); M8 uses 0030–0032. Only M7's plan fix appended to `decisions-log.md`: decision 76, for both milestones.
20. **Editors** (agreement 21): M7's `models.json` editor stays a plain field this wave. Switching it to M8's lazy `@pap/ui/code` is a later task.
21. **`knip.json`:** M7 adds `mkfifo` to pi-host's `ignoreBinaries` (Task 1a) and the helper entry (Task 6a). Union with any M8 line.

Shared files (both conflict tables):

| File | M7's change | Resolution |
|---|---|---|
| `packages/contracts/src/{methods,methods.test,permissions,errors,errors.test,streams,index,auth,settings}.ts` | lists, the `pi` domain, four error codes, `loadout` / `login`, the `pi:admin` exclusion, `RuleView`, `sessions.create.preset`, the `models` setting key | union (notes 3, 4, 10) |
| `packages/contracts/src/pi-host.ts`, `packages/pi-host/src/dispatch.ts` | worker records and cases | union by hunk (note 7) |
| `packages/ui/src/primitives/TextField.tsx` (+ test) | M8R83's props, same names | `main`'s copy wins at the rebase (note 6) |
| `apps/daemon/src/daemon.ts` | ≤ 10 lines: the `compose-pi.ts` call, the rpc spread, the stop line | union (note 8) |
| `apps/daemon/src/kernel/config.ts` (+ test) | `PAP_HELPERS_MAX` | union (note 9) |
| `apps/daemon/src/modules/sessions/live-session.ts` | ≤ 6 lines (Task 7) | union, ≤ 396 (note 12) |
| `apps/web/src/features/sessions/Composer.tsx` | 3 mount lines, the field's props, one ref | note 6 |
| `apps/web/src/features/sessions/SessionScreen.tsx` | two mounted lines | M7 only (note 15) |
| `apps/web/src/stores/session-reducer.ts` | `loadout` | M7 only (note 15) |
| `apps/web/src/runtime/subscriptions.ts` | `OPENERS.login` | union (note 10) |
| `apps/web/src/features/workspace/model.ts`, `routes/settings/sections.tsx` | three sections | union (note 15) |
| `apps/web/src/i18n/{en,fr}.ts`, `catalog/{shell,settings-access}.ts`, `lazy-catalog.test.tsx`, `catalog-keys.test.ts` | error keys, the `pi` label, grid copy, the catalog list | union (note 16) |
| `budgets.json`, `apps/web/src/build-output.int.test.ts` | lazy markers, budget | the second merger re-measures (note 18) |
| `AGENTS.md`, `docs/agents/*.md` | M7 sections | union (notes 9, 19) |
| `eslint.config.js`, `knip.json` | `mkfifo`, the helper entry in `knip.json` | union (note 21) |
| `package.json` files, `pnpm-lock.yaml` | the helper entry in `packages/pi-host/package.json`; no dependency | regenerate (note 17) |
| `DESIGN.md` | none | — |

## Self-review

- **Spec coverage:** every roadmap M7 domain item, every carry of the brief and every owner answer maps to a task (coverage map, "Owner decisions"). The parity checklist is built from the inventory, the matrix and pi-web's own topic notes. Its dropped and deferred rows cite owner answers (m4, m10).
- **Plan fix:**
  - The red-team's two Important findings: RT-01 (M7R122 corrected; Task 27 lands M8R83's props) and RT-02 (Task 6 split into 6a and 6b).
  - Every Minor:
    - RT-03: Opus on Task 3, with mutation checks;
    - RT-04: superseded by owner m3, Task 1a;
    - RT-05: Task 12 split, and 17 and 18 kept whole with a ruling (M7R153);
    - RT-06: owner m13, M7R146;
    - RT-07: `compose-pi.ts`, M7R151.
  - Agreements 1–24 and the owner amendments: the merge notes and the tasks they name.
- **Security contracts with full code:**
  - the git config reader and check (1a);
  - the read-only coverage engine and table (1b);
  - the stage 03 wiring (1c);
  - the prefix proposal and pattern grant (2a), and the pattern-rules migration (2b);
  - the built-ins registration and the results root fix (4);
  - the helper protocol and spawn (6a), and `pi-file.ts` (6b);
  - the login event schema (11);
  - the `models.json` masking (12a);
  - the tool-preset migration and the egress rule (15);
  - the MCP masking (17);
  - the trust breadth rule (22);
  - the skill source, install arguments and frontmatter edit (24);
  - the plugin source (25).
  
  Normal tasks carry interfaces, rulings and test lists only (decision 73). At the plan fix, 1a, 1b and 6b were run in a scratch copy:
  - 1a and 1b: lint, typecheck, knip and 2 058 policy tests green, with the named mutation checks;
  - 6b: eight sanity cases.
  
  This found and fixed two defects in the planner's 1b code: `git -C` composition with operands from the `-C` folder, and `rg --hostname-bin` / `tree -R`.
- **Placeholders:** only these values are left to implementation, each named as such:
  - the codemode script syntax (M7R34, from the SDK docs);
  - the SDK's sign-in notice wording (M7R96);
  - the pinned `skills` CLI version (M7R112);
  - whether the SDK has a read-only package update check (M7R117);
  - whether inline factories survive `noExtensions` (M7R74, with its fallback);
  - the exact signature of M8's `composerFieldProps` at the rebase (note 6).
- **Names used across tasks are defined once:**
  - 1a: `repoConfigRefusal`, `gitGuard`, `GitGuard`, `parseGitConfig`, `runsProgram`, `includeOf`;
  - 1b and 1c: `coverCommand`, `CoverContext`, `ShellFacts` (with `gitEnv`), `UNKNOWN_SHELL`; 1c: `READ_ONLY_COMMAND_MODES`;
  - 2a: `PrefixRule`, `ToolRule`, `AlwaysScopes`, `AlwaysScope`, `proposePrefix`, `patternGrant`, `toolRuleSource`;
  - 4: `piBuiltins`, `signInNotice`;
  - 6a: `HelperPool`, `HelperRun`, `HELPER_CODES`, `composePi`; 6b: `readPiFile`, `writePiFile`;
  - 7: `SessionLoadout`, `ModelSummary`, `ThinkingLevel`, `ToolPreset`;
  - 8: `ModelsModule`, `ModelsOverview`;
  - 10: `planEnabledEdit`;
  - 11: `LoginEvent`, `LinkUrl`;
  - 12a: `maskModelsJson`, `scanJsonc`; 12b: `ModelsSettings`;
  - 17: `maskArgs`, `maskUrl`, `maskMcpEntry`, `McpEntry`;
  - 22: `trustRefusal`;
  - 24: `skillSource`, `setFrontmatterFlag`;
  - 25: `pluginSource`;
  - 27: `useComposerCommands`.
- **File sizes:**
  - New files are planned under 300 lines. The engine is three files (164, 147 and 81 lines) beside the 181-line table, and the git check is two files (181 and 180).
  - `live-session.ts` grows by at most 6 lines in all, and `daemon.ts` by at most 10.
  - The frozen test files stay frozen.
  - `methods.ts` gets spreads plus two small inline hunks.
- **Review Focus:** each of the eight lines names the test that pins it.
- **Bundle:** ≈ +4.5 KB initial (≈ 200 KB), and ≈ 204 KB merged with M8: far under the 250 KB alert and the 300 KB ceiling.
