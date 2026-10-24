# Red team: M14 owner and members plan

Plan: `docs/plans/2026-10-24-m14-multi-user.md` (main at eec7a44b). Spec: `docs/specs/2026-10-24-m14-multi-user-design.md`. I read the code at that commit. Paths are relative to the repo root; `D/` = `apps/daemon/src`, `C/` = `packages/contracts/src`, `W/` = `apps/web/src`.

## 1. Summary

- **Counts:** Critical 2, Important 10, Minor 15.
- **Top 5:**
  1. **M14-RT-01** (Critical). A member can clone, link and push the owner's private repositories. The shared App's JWT reaches every installation, and nothing checks the member's own GitHub access.
  2. **M14-RT-02** (Critical). The member's daily budget counts automatic runs only. Interactive chat in a member's box spends the owner's API keys with no limit.
  3. **M14-RT-03** (Important). Disable is not deny-by-default. Only `fire.ts:107` is checked, so resume effects, queued tasks, reminders and worker restarts can start a disabled member's boxes again.
  4. **M14-RT-04** (Important). `users.invite` returns the raw invitation token but is not `secretResult`. The dispatcher then stores it in plaintext in `receipts`, and so in backups.
  5. **M14-RT-07** (Important). The host gate is a list of call sites, not deny-by-default as spec §3 asks. Files and the raw route still run a host `realpath` on any path a member sends.
- **Verdict: ready after fixes.** No re-plan is needed. The fixes add one small task (GitHub reach, RT-01), change A4 (the member's spend line), A5 (disable chokepoints) and S1 and A3 (a dispatcher path gate), and split A4 and A5.

## 2. Findings

### Critical

**M14-RT-01 · new task (lane A), J1. A member gets write tokens for the owner's repositories.**
- **What the code does.** `GithubTokens.installationFor(repo)` (`D/modules/github/tokens.ts:54-58`) calls `GET /repos/{repo}/installation` with the App JWT. `mint()` then mints an installation token with that same JWT.
  - `createFromGithub` in clone mode and `linkGithub` (`D/modules/github/projects.ts:150,177`) only check `appReaches(core, repository)`. The project owner's user token plays no part.
  - `deliver.sendToken` (`D/modules/github/deliver.ts:103-105`) mints `{contents: write, pull_requests: write}` for `row.repository` at every box start and every 45 minutes.
- **Scenario.**
  1. The owner installed the public App on `owner/secret`.
  2. A member calls `projects.createFromGithub {repository: "owner/secret", mode: "clone"}`.
  3. `appReaches` passes, the member's box clones the repository, and the member can push and open pull requests with the App's token.
- **Why the plan misses it.** This breaks the anti-goals "a member reaching the owner's files" and "spending the owner's GitHub identity". J1's `a member's box uses the member's GitHub tokens` cannot catch it: box tokens are never user tokens.
- **Fix.**
  - In `createFromGithub` (clone) and `linkGithub`, call `GET /repos/{repo}` with `userTokens.get(caller.userId)`. Require a 200 with `permissions.push === true`; anything else answers `not_found`. A user-to-server token reaches only what both the user and the installation reach.
  - Repeat the same check, cached per owner and repository for 10 minutes, in `deliver()` before `sendToken`, using `row.ownerId`. A member who loses access then loses the token at the next renewal.
  - Fork mode is already safe: it forks with the member's own token.
  - J1 test `a member cannot clone or link a repository only the owner's installation reaches`, on the fake GitHub: no project row, no mint call.
  - Owner question OQ3: collaborators.

**M14-RT-02 · A4, A5, spec §5. The member's budget does not count interactive spend.**
- **What the code does.**
  - `RunsPort.spentToday` (`D/modules/runs/service.ts:157`) uses `store.spentSince`, which is filtered by `AUTOMATIC = "(task_id IS NOT NULL OR origin = 'resume')"` (`D/modules/runs/store.ts:167,249`). `tracker.liveSpent` adds only automatic runs.
  - Every gate, including the relay's `blocked: "budget"` for project boxes (`D/compose-agents-vm-late.ts:270`), compares that figure with `dailyBudgetUsd`.
- **Scenario.** The owner caps a member at 5 USD a day. The member chats all day in a box session on an API-key model shared by default (Q2). Each prompt is a run with `origin: user` and no `task_id`, so nothing is counted and the relay never blocks. The Users screen's "Today {spent} of {budget}" shows automation only, or a different figure if A5's new `spentSince` counts everything.
- **Fix** (owner question OQ1).
  - Add a member line separate from the member's own automation budget. It counts every run of the member billed `api` or `unknown` (subscription runs through their own Claude token cost the owner nothing), finished and live, in the owner's time zone.
  - Enforce it where every member request passes: the relay policy. `policyOfProject` and `policyOf` answer `blocked: "budget"` when the member line ≥ `users.budget_usd`.
  - Push a policy refresh on `onRunEnd` for project boxes too. Today only agents are refreshed (`compose-agents-vm-late.ts:329`); project boxes wait for the 60 s tick.
  - `UserView.spentTodayUsd` shows the same figure.
  - Test: `an interactive box session of a member is refused budget once the cap is spent`.

### Important

**M14-RT-03 · A5. Disable is not deny-by-default.**
- **What the plan does.** It checks `disabled(ownerId)` at `automation/fire.ts:107` only.
- **What still starts work for a disabled member:**
  - auto-resume `run.resume` effects (`D/modules/runs/resume.ts:198` reads `settings.paused`, not "disabled");
  - queued and thread tasks, agent reminders and delegations (`runner.ts`, `runner-thread.ts:201`, `runner-agent.ts:113` look at the agent's pause only);
  - feed polls, which keep fetching (`feed-poll.ts:142`);
  - a live session restarting its worker, which starts the box;
  - a box start already queued when `BoxControl.stop` runs.
- **Scenario.** The owner disables a member. Their box stops. Ten minutes later the quota reset fires a `run.resume` and the box boots again.
- **Fix.** Three chokepoints, no per-path list:
  1. `SettingsService.automation(id).paused` is true for a disabled user. This is the same seam as the budget clamp, and it covers fire, resume, feed and limits.
  2. The VM launch gate (`status.require()` and `BoxControl.start`) refuses a disabled owner's box or agent with `account_disabled`.
  3. `policyOf` and `policyOfProject` answer `blocked: "paused"` for a disabled owner.
- **Test.** Extend Review Focus 2's test with a resume effect, a queued task and a reminder that fire after the disable.

**M14-RT-04 · S1, A2. The invitation token is kept in plaintext in `receipts`.**
- **What the code does.** `users.invite` is a non-idempotent mutation. The dispatcher stores its result unless the method has `secretResult: true` (`D/kernel/ws/dispatcher.ts:110-113`). The result's `url` carries the raw token.
- **Effect.** "Only `sha256Hex(token)` is stored" becomes false. Anyone with the database file or a plain backup (sensitive, but it leaves `secrets/` out) can accept the invitation for as long as it lives.
- **Fix.** Declare `users.invite` with `secretResult: true`, as `auth.tokens.create` does. A2's test `stores only the token's hash` also scans `receipts`.

**M14-RT-05 · S1, A2. `users.invite` has no step-up.**
- **The rule it breaks.** R83 (`docs/agents/auth.md`, passkeys): "a stolen session alone cannot add a permanent credential".
- **Scenario.** With the owner's stolen cookie alone (no password), an attacker invites themselves. They get a permanent member account with boxes on the owner's API-key providers, and it survives the cookie's revocation.
- **Fix.** `users.invite` (and `users.setDisabled {disabled:false}` on someone else's account) calls `requireStepUp` and declares `step_up_required`. B2 runs it through `use-settings-step-up.ts`.

**M14-RT-06 · A4. The budget clamp has holes.**
- **(a) A stored `null`.** `null` means "no budget" (`C/automation.ts:311`).
  - The plan's `min(stored, cap)` in JS: `Math.min(null, 5)` is `0`, which blocks everything.
  - `settings.set`'s check "above the cap": `null > 5` is false, so the write is accepted.
  - Fix: a `null` stored value or write means the cap.
- **(b) The time zone.** `spentToday(ownerId, timezone)` takes the member's own, writable `automation.timezone` (`D/modules/automation/gates.ts:31-32`). By switching to a zone whose midnight just passed, the member restarts their day whenever they like.
  - Fix: the member line (RT-02) and the clamp's day use the owner's time zone.
- **(c) The UI.** `settings.get` returns the raw stored value, so Settings › Automation shows 50 while 5 applies.
  - Fix: return or show the effective value, or add a "capped at {cap}" line.

**M14-RT-07 · A3, spec §3. The host gate is a list of call sites and touches the host first.**
- **Not deny-by-default.** A3 adds `assertBoxOnly` to 8 named sites. A new method that takes a path is not gated unless its author remembers to call it, while the spec says "a new path-taking method is gated without a per-method list".
- **Host file system touched.** Spec §3 names Files and Changes, but A3 leaves them out ("closed by construction"). `files.list/read/write`, `GET/PUT /files/raw` and the files `upload` run `judgePath`, which calls `landing()`, a host `realpath`, before the roots check (`D/kernel/fs/boundary.ts:162-167`; `D/modules/files/service.ts` host branches).
- **Scenario.** A member sends `files.read {path:"/home/ubuntu/.pi/agent/auth.json"}`. The host stats and resolves the owner's file, then answers `not_found`. Nothing is read, but the spec's "before any host file system call" is broken and an existence and timing oracle opens.
- **Fix.**
  - In S1, give one shared branded schema to every client path field (`FilePath`, `Cwd`, the three local `AbsolutePath`s in `shell.ts`, `skills-methods.ts` and `trust-methods.ts`, and `projectRoot`).
  - In the dispatcher, after the params parse and for a member, walk the branded fields and run `assertBoxOnly`. Do the same in `httpCaller`'s path routes.
  - Keep A3's per-site calls as defence in depth.
  - J1 lists the methods whose schema holds a branded field and requires `forbidden` for a member's host path on each.

**M14-RT-08 · A4, B1. Members cannot use the Claude bridge, so the per-user token is useless to them.**
- **(a) The provider filter drops the bridge.** "With no row ... any other provider is not [shared]" applies to `claude-bridge`, which has no stored auth. A4 then drops it from `sessions.models`, the VM worker's own list, which does include the bridge's models. The member never sees the bridge in a box session.
  - Fix: exempt `CLAUDE_BRIDGE_PROVIDER` from sharing. It is gated by the box owner's token (`policy.claude`).
- **(b) The agent form's packages fail.** The bridge reaches an agent through its package picks. `W/features/agents/AgentPackages.tsx` calls `plugins.list` (`pi:admin`), so a member gets `forbidden` and the picker shows "failed".
  - Fix: an `agents.packages` method (`agents:read`) returning the id and masked source of the user-scope packages, the shape the component already uses, and B1 switches to it.
- **Test.** `a member's box session lists the bridge when the member's token is set`.

**M14-RT-09 · S1. `Caller.role` has no consumer and invites a bypass.**
- **What the plan does.** S1 makes `Caller.role: Role` required, but no task reads it: A3 uses `isMember(ownerId)`, and the web gets the role from `/auth/status`.
- **Why it is risky.** The production background Callers must compile with a role: `automationCaller` (`D/modules/sessions/automation-port.ts:83`), `ownerCaller` (`D/compose-agents-vm-late.ts:136`) and the lanes `callerFor` (`D/modules/lanes/archive.ts:68`). They have no auth access, so `role: "owner"` is the easy literal. A later check on `caller.role === "member"` would then let a member's trigger task through as the owner.
- **Fix.** Drop `Caller.role` and keep one source of truth, `auth.roleOf(userId)` and `isMember`. If it stays, builders take it from `roleOf`, and a unit test greps non-test code for `role: "owner"`.

**M14-RT-10 · A4. The Claude token per box in the relay.**
- **(a) A separate token message.** The plan adds `claude_token {box, token}` and a map keyed by `boxKey` beside `box_policy`, so there are two messages to replay in order after a restart. Nothing clears the map on the last `relay_revoke` (`relay-link.ts` revoke sends an empty policy only). A later launch with the same key (agent ids reused after a trash collision, RT-19) gets `claude: true` and the old owner's token.
  - Fix: carry `claudeToken: string | null` inside `box_policy` instead of `claude: boolean` and drop the `claude_token` message. The policy is already per box, computed with its owner (`policyOf` / `policyOfProject`), replayed by `replay()`, and cleared by the revoke's empty policy. `ClaudeTokens.onChange` becomes `relay.refreshAll()`.
- **(b) `agents.vmStatus` reports the global token.** It returns `deps.claudeToken.status()` (`D/modules/agent-vm/status.ts:118`), and `status.ts`, `compose-agents-vm-status.ts`, `compose-agents-vm-rpc.ts:61` and `compose-agents-vm.ts:82,210,224,357` are not in A4's file list. A member sees "set" when only the owner's token is set.
  - Fix: `view(ownerId)` returns `tokens.status(ownerId)`, and the files are listed.

**M14-RT-11 · J1. The method-table test is not exhaustive and leaves out HTTP routes.**
- **What the plan does.** The table only classifies. Owner-row probes run once per family, so a new `member-own` method is classified and never probed. The HTTP routes are not in `METHODS`: `/files/raw` (GET, PUT), `/upload`, `/agent-files`, `/api/sessions/:id/export/:token`, `/hooks/:id`, `/github/*`, `/fonts/*`.
- **Fix: a cheap, exhaustive design.**
  - `METHOD_CLASS` is typed `Record<keyof typeof methods, Class>`, so a missing method fails typecheck, not just a test.
  - `member-forbidden`: one call each with `{}`. The permission check runs before the params parse (`dispatcher.ts:171`).
  - `member-own`: each method is in exactly one of `PROBES` (a params factory taking the owner's ids) or `NO_FOREIGN_INPUT`. The test fails when it is in neither.
  - Canary check: seed the owner's rows with a unique string (session title, project name, file text, trigger, agent and inbox text). The test checks that no response and no stream frame the member receives during the run holds that string or an owner id.
  - `shared-read`: an explicit list (`fonts.list`, `push.config`, `agents.vmStatus`, `sessions.commands`, `subagents.profiles`, `sessions.availableModels`, `github.status`), each with its exact result keys.
  - The same classification for the Hono routes (`app.routes`).
  - Cost: one harness boot and about 260 calls.

**M14-RT-12 · A5. Delete loses records and leaves data behind.**
- **(a) Records.** "Every `owner_id` row is deleted" includes `runs` (the cost of the owner's API keys: FinOps) and `audit` (the only trail if a member is deleted for misuse). See OQ2.
  - Fix: keep both; they hold no content.
- **(b) What the scan misses.** The `sqlite_master` scan for `owner_id` misses:
  - `receipts` (`user_id`, member RPC results);
  - the search index, a separate database (`D/modules/search/index-db.ts`, `rows.owner_id`);
  - `push_deliveries` (keyed by `sub_id`);
  - attachments and exports on disk.
  - Fix: scan `owner_id` and `user_id`, drop the member's index rows, and delete their deliveries.
- **(c) Order.** `github.removed()` releases signing keys with a `void` promise (`D/modules/github/projects.ts`, `removed`), which races `VaultStore.dropOwner`. The user token is gone before the GitHub key `DELETE`, so keys stay on the member's GitHub account.
  - Fix: await key release before dropping the vault.
- **(d) Crash safety.** Delete must start with the disable path (RT-03), so a crash mid-delete leaves a disabled account, never an enabled half-deleted one.

### Minor

- **M14-RT-13 · S1. Error codes.**
  - `users.setProviderShared` declares `invalid`, which is not an `ErrorCode` (`C/errors.ts`); use `bad_request`.
  - A2's 409 `username_taken` is declared nowhere and has no B3 sentence. Put every new code in S1.
- **M14-RT-14 · S1, A4. `sessions.availableModels {cwd}`.** A cwd runs the host Pi helper there (`D/modules/models/service.ts:96-99,206-211`). For a member that is a box path reaching the host, against ADR 0083. A repository's `.pi/` is not loaded in a box anyway.
  - Fix: drop `cwd`.
- **M14-RT-15 · A2, B3. Invitations.**
  - Accepting while signed in replaces the current cookie but leaves that session's row alive: log it out, or show "signed in as X" first.
  - Passkey `login/verify` and the invite accept must also refuse a disabled account with `account_disabled`, not mint a dead session.
  - The plan says "the setup throttle" under Invitations but "an invite throttle" under A2. Use a table of its own, so invite failures from a shared address never delay the owner's password sign-in.
  - Count 409s, or a token holder can loop scrypt.
  - Clear the hash after reading it (`history.replaceState`).
  - The link `/invite#token=` replaces the spec's `/auth/invite/<token>`; record the ruling.
- **M14-RT-16 · A4. Provider sharing.**
  - The default is derived on every read, so a provider moving from OAuth to an API key becomes shared silently. Write the default row the first time a provider is seen.
  - Define "api_key" by the relay's own rule (`R/credentials.ts:122`, `checkAuth().type === "api_key"`), so `models.json` literal and `$VAR` keys count.
  - `setProviderShared` must call `relay.refreshAll()`.
  - The plan does not say where `modelsOf` gets the auth kind (a cached `models.overview`, cleared on `models.onChanged`).
- **M14-RT-17 · S1. Fonts.** `fonts.add/remove` (`settings:operate`) write `$PAP_HOME/fonts/<slug>`, shared by every user (`D/modules/fonts/store.ts`). A member can remove the owner's font.
  - Fix: `system:admin`, and hide the controls for members.
- **M14-RT-18 · A4. Legacy token migration.**
  - With no owner yet, leave the file alone.
  - If a crash leaves both the vault entry and the file, the vault wins and the file goes.
  - If the vault is unreadable (`vault_key_lost`), keep the file, log it, and boot.
  - The read-only database mode only reads the owner id; the vault is files.
- **M14-RT-19 · agents, A5. Agent ids across users.**
  - Ids are `slug-XXXX` (2 random bytes, `D/modules/agents/service.ts:119-124`) and `store.exists` reads `agents` only, not `agent_trash`.
  - A member who creates and deletes agents can land on an id the owner trashed less than 7 days ago. Their `agents.purgeTrash` then runs `vm.purge(agentId)` on the owner's trashed disk, or their delete hits the `agent_trash` primary key.
  - Fix: `exists` checks both tables, and 3 or 4 random bytes.
- **M14-RT-20 · B1, B2. Hidden in the web or refused by the daemon (mismatches).**
  - The token dialog offers `pi:*` and `system:*` to a member; creating one answers `forbidden`. Filter the choices by role.
  - Settings › Automation shows the uncapped budget (RT-06c).
  - A member's Settings › GitHub has no "Install on GitHub" link (`htmlUrl` + `/installations/new`), so `github.repositories` lists nothing.
  - Fonts are not hidden and not refused (RT-17).
- **M14-RT-21 · A3. Gate details.**
  - Make the gate's match the routing decision (`assertBoxOnly` returns `{projectId, root}` and the caller uses it). Otherwise a box removed between the gate and `newBoxCwdOf ?? resolveSessionCwd` falls through to a host `realpath`, and only `service-launch`'s gate catches it.
  - Make `deps.isMember` required in A3, not optional until J1. An optional dependency leaves the gate open if the wiring is forgotten.
- **M14-RT-22 · A4. Where `provider_sharing` lives.** "If models has no migrations folder, put it in the auth module": it has none. The auth module would then own a table that `models/sharing.ts` queries. Put it in the new users module, or add `models/migrations` (one `MIGRATION_SOURCES` line in `daemon.ts`, which is at 396 lines, plus J1's line).
- **M14-RT-23 · B3.** `isSpaRoute` already serves `/invite`, since every path without an extension is an SPA route (`D/kernel/http/static.ts:38-40`). Drop the `kernel/http/app.ts` edit: it was a daemon file in the web lane.
- **M14-RT-24 · S1, A5. GitHub HTTP routes and `forget`.**
  - `/github/app/new` and `/github/app/authorize` still check `settings:admin` (`D/modules/github/http.ts:42,50`). Align them with the moves: `system:admin` and `settings:operate`.
  - `github.forget` clears only the caller's user tokens. Members then show "connected" for a dead App; clear every user's.
- **M14-RT-25 · A1, B1. Build breaks.**
  - `DEFAULT 'member'` makes every user inserted raw by a test bed a member: `auth/testing/{token,device,passkey}-bed.ts`, `owner.test.ts`, `tokens.test.ts`, `service.test.ts`. List them in A1.
  - `SETTINGS_SECTION_RENDERERS` is an exhaustive `Record`, so B1's new `"users"` section needs a stub renderer before B2.
- **M14-RT-26 · S1. `ops.events.list` and `subscribe.ops`.** They are already per owner (`D/modules/health/buffer.ts`, `index.ts:59`), so `system:admin` only removes members' view of their own failures. Use `system:read` and keep Health visible, or keep the plan and accept the loss.
- **M14-RT-27 · ADR 0085. A known limit to write down.**
  - A box terminal is guest root (`agents-vm.md`, Terminal). A member can read their worker's relay key and call `llm.internal` directly, or under-report cost.
  - The budget, RT-02 included, rests on the cost the VM reports (`agents-vm.md` known limits). Against a member it is a guard against mistakes, not a hard cap. See OQ5.

## 3. Method permission audit

Members hold everything except `system:admin`, `pi:*` and `users:*`. The rows below are the methods and routes left to a member that touch state or data shared by the whole install, or that the plan's set breaks.

| Method / route | Today | Plan | What is shared across users | Recommended |
|---|---|---|---|---|
| `fonts.add`, `fonts.remove` | settings:operate | unchanged | `$PAP_HOME/fonts/*` for all users; a download from Google Fonts | **system:admin** (RT-17) |
| `fonts.list`, `GET /fonts/*` | settings:read / public | unchanged | read only | keep |
| `github.startCreate`, `github.forget` | settings:admin | system:admin | the App | ✓, plus `GET /github/app/new` → system:admin (RT-24) |
| `github.authorizeUrl`, `github.disconnect` | settings:admin | settings:operate | per user | ✓, plus `GET /github/app/authorize` → settings:operate |
| `github.status` | settings:read | unchanged | App public data, a global `permissionMissing` flag | keep |
| `projects.createFromGithub` (clone), `projects.linkGithub` | sessions:operate | unchanged | **the App JWT reaches every installation** | keep the permission; add the user-token access check (RT-01) |
| `agents.vm.setClaudeToken`, `clearClaudeToken` | pi:admin | settings:operate | per user after A4 | ✓ |
| `agents.vmStatus` | agents:read | unchanged | pap-vmd version, host ceilings, **the global Claude token status** | keep; caller's own token status (RT-10b) |
| `ops.events.list`, `subscribe.ops` | pi:admin | system:admin | none (already per owner) | system:read (RT-26) |
| `plugins.list` | pi:admin | member denied | the shared Pi packages; the agent form needs it | new `agents.packages` (agents:read) (RT-08b) |
| `models.available`, `models.overview`, `models.pricing` | pi:read | member denied | the shared models | `sessions.availableModels` without `cwd` (RT-14) |
| `sessions.models` | sessions:read | filters unshared providers | the VM worker's list | ✓, with `claude-bridge` exempt (RT-08a) |
| `settings.set` (`automation`) | settings:operate | clamp | per user, but `timezone` moves the budget day, and `null` | clamp `null`; the member's day in the owner's zone (RT-06) |
| `sessions.commands`, `subagents.profiles` | sessions:read | unchanged | read the shared profile (spec: shared) | keep |
| `projects.rebuild`, `projects.setBox`, `agents.create`/`update` | sessions:admin / agents:admin | unchanged | build cache, global memory cap ("first come", spec) | keep |
| `push.config` | settings:read | unchanged | VAPID public key | keep |
| `policy.setSettings` | policy:admin | unchanged | per user | keep |
| `auth.tokens.create` | auth:admin | capped at the creator's permissions | per user | ✓, plus web filter (RT-20) |
| `lanes.*` (24) | lanes:* | gated at create and `runScript` | host only in M14 | optional: add `lanes:*` to `memberDenied` until B3 (cheap belt) |
| `terminal.*` | terminal:* | host create gated | box terminal = guest root | keep (RT-27) |
| `users.invite` | none | users:admin | creates an account | **users:admin + step-up + `secretResult`** (RT-04, RT-05) |

**Is `memberDenied` enough?** Yes at the permission level once `fonts.add/remove` move. The remaining exposures are data scoping, not permissions: the GitHub App reach (RT-01), the vmStatus token status (RT-10b) and the `sessions.availableModels` cwd (RT-14).

## 4. Coverage gaps (spec items with no task or no test)

| Spec item | What is missing |
|---|---|
| §3 "Deny by default: a new path-taking method is gated without a per-method list" | No task builds it, and no test lists the methods that take a path (RT-07). |
| §3 "Files, Changes" in the gate | Not in A3's list (RT-07). |
| §4 "Disable ... boxes and agent VMs stop, triggers pause" | Tested for fire only. Resume, queued tasks, reminders and box restarts are not tested (RT-03). |
| §5 "Budget ... the relay and the runs gate refuse a member over it" | Holds for automation only; no interactive test (RT-02). |
| §5 Claude token per user | No test that a member can use the bridge, in a box session or an agent (RT-08). |
| §5 GitHub per user | No test that a member cannot reach the owner's repositories (RT-01). No member "install" step in B1. |
| §5 "Image layers and the build cache are shared; a member's project.yaml builds only their project layer" | No test. |
| §6 "Install-level actions (users, App, VM) write the owner's audit" | Only `user_invited` and `member_created` are named. Disable, enable, delete, `setBudget`, `setProviderShared` and `revokeInvite` have none. |
| §7 "The Pi session scanner keeps adopting CLI sessions to the owner" | No test that an adopted row never lands on a member after `ownerId()` moves to `WHERE role = 'owner'`. |
| §9 "one test per RPC family, driven from the method table so a new method cannot skip it" | Only the classification is driven from the table; the probes are not (RT-11). |
| Review Focus 1 "file path" | No HTTP route table (RT-11). |

## 5. Sizing, lanes and the model table

- **A4 is three features across three packages:** daemon, contracts (`relay-ipc.ts`) and pi-host (relay). It touches about 18 files, and its file list misses about 4 that the Claude token touches (RT-10b). Split it:
  - **A4a.** Claude token per user, with the token in `box_policy`, the migration and vmStatus.
  - **A4b.** Provider sharing: the table, the filters and the bridge exemption.
  - **A4c.** The budget cap and the member's spend line (RT-02, RT-06).
- **A5 touches about 20 files in 10 modules.** Split it:
  - **A5a.** The users module: list, budget, providers, invite and revoke RPCs, plus disable with the three chokepoints (RT-03).
  - **A5b.** The delete cascade: an internal `removeAll` per module, the order, and the records kept (RT-12).
  - Several of A5's owners are near the cap (`agents/service.ts` 392, `automation/index.ts` 385, `secrets/vault-store.ts` 382). Name the new files (`agents/owner-cascade.ts`, `secrets/vault-drop.ts`) so no implementer grows them.
- **New A6 (lane A, small).** The GitHub access check (RT-01), after A1.
- **Lanes.**
  - Lane B no longer touches daemon files once RT-23 drops the `app.ts` edit.
  - Lane A edits `contracts/relay-ipc.ts` in A4a, which lane B never reads, so it cannot conflict.
  - Keep every new error code in S1 (RT-13), so B3's catalogue does not chase lane A.
  - J1's "merge A then B" is fine.
- **Model table.** Sonnet implementers and Sonnet task reviews suit S1, A2, A4b, A5a, B1 to B3 and J2.
  - A1 (roles and authentication), A3 (the gate, including the dispatcher walk) and A6 (GitHub reach) are the security core. One Opus final review over 13 or more tasks is thin for them.
  - Recommendation: an Opus task review for A1 and A3 together and for A6. The owner's escalation rule applies, so this is OQ4; without approval, keep Sonnet and make these three the final review's first focus.

## 6. Owner questions

The plan carries none open (spec Q1 and Q2 are answered). Keep: none. Drop: none. Add:

| # | Question | Default (plan as written) | Recommendation | Changes |
|---|---|---|---|---|
| OQ1 | What does a member's daily budget cover? | Automatic runs only (as the owner's own today) | **Every run of the member billed `api` or `unknown`, interactive included, in the owner's time zone; the relay blocks once it is spent.** Subscription runs on their own Claude token are not counted. | A4c, relay policy, Users screen (RT-02) |
| OQ2 | When a member is deleted, keep their `runs` (costs) and `audit` rows? | Deleted with every `owner_id` row | **Keep both** (no content: cost records and the misuse trail); delete everything else | A5b (RT-12) |
| OQ3 | May a member link a repository they reach as a GitHub collaborator, the owner's included? | n/a (today any installation's repository is reachable, RT-01) | **Yes when their own token has push** (GitHub decides). The stricter option, the installation must be on the member's own account, blocks shared repositories. | A6 |
| OQ4 | Opus task reviews for A1+A3 and A6? | No: one Opus final review | **Yes for those two reviews only** (security core) | Model table |
| OQ5 | A member is root in their box and can bypass the budget (relay key, reported cost). Accept for trusted people? | Not addressed | **Accept and document in ADR 0085**; relay-side token metering is a later lot | ADR 0085 (RT-27) |
| OQ6 | Q2 said OAuth (subscription) providers can be shared explicitly. In M14 the relay never serves an OAuth provider to a box, so the switch cannot work. | Shown disabled with the subscription copy | **Confirm "shown disabled"**: members use their own Claude token | B2 copy only |
