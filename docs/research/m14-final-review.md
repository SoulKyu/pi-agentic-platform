# M14 final whole-branch review (J3, Opus)

Branch `feat/m14` at `390d7be6` (worktree `/home/ubuntu/Workspace/soulkyu/pap-m14`), diff `0ca4ea08..390d7be6`. Read: spec, plan (Global Constraints, Review Focus, Owner answers), red team, ledger (R1–R12, every deferred minor), the task reviews (A1+A3, A6 and its two re-reviews, the others for their deferred lists), then the code of the daemon, the contracts and the relay first, then the web where the dispatch named it.

## Verdict

**Needs fixes**: one Important (I1). No Critical. The security core holds end to end: escalation, cross-user reads and writes, the host gate, disable and delete, the per-user secrets, the budget. I1 is a composition defect: one member's ordinary action makes every VM launch on the install fail, the owner's included, and the owner cannot find out why.

## Tests run (heavy-gate flock, `--maxWorkers=3`)

- integration: the seven `m14.*.int.test.ts` journeys (matrix, routes, members, disable, delete, claude, github): 7 files, 31 tests passed.
- integration: `security/automation-crash.int.test.ts` (R11), `users/rpc.int.test.ts`, `auth/invite-http.int.test.ts`, `compose-boxes-budget.int.test.ts`: 4 files, 23 tests passed.
- unit: `daemon.users-delete.test.ts`, `kernel/box-path.test.ts`, `kernel/no-caller-role.test.ts`, `kernel/ws/dispatcher.gate.test.ts`, contracts `client-path.test.ts` and `client-path-params.test.ts`, `modules/users/*`, `auth/roles.test.ts`, `compose-agents-vm-status.disabled.test.ts`, `compose-agents-vm.disabled.test.ts`: 14 files, 69 tests passed.
- unit: `daemon.migrations.test.ts`, `compose-m11.entry.test.ts`, and the five files that test `migrateLegacy`: 7 files, 72 tests passed.

I did not re-run eslint, typecheck, knip or format:check.

## Findings

### Critical

None.

### Important

**I1. Any member's vault value can stop every VM launch on the install** (`apps/daemon/src/compose-agents-vm-secrets.ts:37`, `apps/daemon/src/modules/agent-vm/secret-scan.ts:86-97`, `apps/daemon/src/modules/agent-vm/kata-images.ts:168-211`, `apps/daemon/src/modules/agent-vm/profile-job.ts:35-38`).

How it works:
- The image build's needles come from `vault.everyValue()`: every value of every user and every scope (spec §7, A4a). Every string of 8 characters or more counts (`MIN_SECRET_LENGTH`).
- `scanTree` searches each file name, link target and file content of the shared Pi profile for those needles. A hit throws `ProfileSecretError`.
- The needle set is part of the profile fingerprint's salt (`profile-job.ts:37`). A new vault value therefore forces a new preparation, at the latest 30 s later (`PROFILE_TTL_MS`).
- On a hit, `prepare` clears `prepared` and `lastGood` and throws `config_invalid`. `profileNow` sits on every `images.resolve`, so every later agent or box worker launch fails the same way.

Scenario:
1. A member stores an ordinary agent secret, for example `NODE_ENV=production`, `AWS_REGION=eu-west-1` or a DB user `postgres_app`. A deliberate value such as `extensions` or `package.json` works too.
2. Within 30 s, every launch on the install answers `config_invalid`: the owner's agents and boxes, and every member's. The thread notice says only "a Pi profile file holds a secret; it does not enter the image", and the log names the file (`agent_profile_secret {file}`).
3. The owner searches their own `auth.json` and vault and finds nothing. They cannot see members' vault names (content isolation), so they have no way to tell which user's value caused it.

A4a's review noted that `everyValue()` throws on one unreadable file. So a single damaged scope file of any member also fails every preparation closed.

Before M14 only the owner's own values could do this, and the owner could find them. A5a scaled the caps so that "a second user cannot make the first one's build fail". This path breaks that same intent.

Fix direction:
- Members cannot write `~/.pi/agent`. For the shared profile, a member's value can only produce a false positive, never protect anything.
- Give the profile scan the install's values only: `auth.json`, the App secrets, the live GitHub and box tokens, and the owner's vault.
- Keep every user's values in the relay stderr redactor, where masking all of them is right.
- Keep a member's own values for any per-agent layer that carries that member's files.
- Have an unreadable vault of another user skip that user with a warning, not fail closed for everyone.
- Test: a member's vault value equal to a profile file's text, or to a file's name, does not change the owner's launch.
- If the owner prefers to keep the spec's "every user's vault": at least log the user id (never the value) whose needle hit, and write the limit in ADR 0085.

### Minor (8)

**M1. "Disabled" fails open for an unknown id** (`apps/daemon/src/modules/auth/roles.ts:74`, `apps/daemon/src/compose-agents-vm-late.ts:318-324`, `apps/daemon/src/compose-boxes-budget.ts:57`).
- `isDisabled` answers false for an id with no row, while `isMember` fails closed.
- Scenario: a member's `projects.create` or `agents.create` was already past authentication when the delete started. If it lands after the cascade enumerated the rows, it leaves a box or agent whose owner row is then deleted. `boxDisabled` and `memberLine.disabled` then let its launch through the gate.
- Little follows from it: the provider gate gives an unknown user no models, the vault is gone and no credential drives it. But a VM can run with its host list.
- Fix: treat `roleOf(id) === null` as disabled in `boxDisabled` and in the member line.

**M2. A disabled member's VM that failed to stop keeps two exits** (`apps/daemon/src/compose-agents-vm-late.ts:298-308`, `apps/daemon/src/modules/github/deliver.ts` `sendToken`).
- `stopAll` reports `internal` when a stop fails, and the account stays disabled.
- The relay answers `paused`, but `hostsOf` and `hostsOfProject` still give the proxy the box's hosts.
- `deliver` keeps minting the box's GitHub token every 45 minutes while the box is `running`.
- Only a process already running in the VM can use them, since no LLM and no socket remain.
- Fix: no hosts and no delivery for a disabled owner (`memberLine.disabled`).

**M3. `github_link_refused` goes to the wrong audit** (`apps/daemon/src/modules/github/service.ts:278-281`).
- The row is written to the audit of the user who started the flow. In the R8/R9 attack, that user is the attacker.
- The user whose browser finished the flow, and whose GitHub code was exchanged and dropped, gets no row.
- Fix: record it for both users, or for the finishing user.

**M4. A handler does more than one call** (`apps/daemon/src/modules/users/providers-admin.ts:52-63`). The `users.setProviderShared` handler calls `admin.setShared` and then `audit.append`. Repo rule: a handler decodes, calls one service method and maps errors. Fix: move the audit into `ProvidersAdmin.setShared(caller, …)`.

**M5. Two methods that take a session id are never probed** (`apps/daemon/src/testing/m14-classes.ts:79-80`).
- `sessions.commands` and `subagents.profiles` take a `sessionId` but are classed `SHARED_READ`, so the matrix never calls them with the owner's session id.
- Both handlers do check ownership today: `cwdOf(caller.userId, …)` answers `not_found`, and so does `ask(sessionId, caller)`.
- Fix: move both to `PROBES` with `session`.

**M6. A member's budget push reads the wrong line** (`apps/daemon/src/modules/push/delivery/source-budget.ts:73`).
- The "budget reached" push compares `runs.spentToday` (automatic runs) with the clamped automation budget.
- The relay blocks a member on the member line, which includes interactive runs. So a member whose cap is spent by chatting is refused `budget` and gets no push.
- Fix: for a member, also check the member line against the cap.

**M7. A rollback loses the owner's Claude token** (`apps/daemon/src/modules/agent-vm/claude-tokens.ts:108-130`; `docs/agents/update.md`).
- After the first M14 boot, `secrets/claude-token` is gone, moved into the vault.
- `pap update rollback` to a pre-M14 release restores the database snapshot but not that file, so the owner's bridge stops until they set the token again.
- Fix: one line in `update.md`, or keep the legacy file for one release.

**M8. ADR 0085 does not say what the owner can read on disk** (`docs/adr/0085-owner-and-members.md`, Consequences).
- "The owner sees usage, not content" is a product rule.
- The owner is the host's unix user. They can read members' mirrors and attachments, and the vault, whose key sits beside it.
- Members are told nothing about this. One sentence in the ADR (and in `auth.md`) keeps the docs from claiming more.

### Not a finding: `POST /upload` with a foreign `sessionId`

- The pending entry is keyed `(ownerId = member, sessionId)`. The file lives in `pending/<random id>`, never in the session's folder.
- A claim needs both `entry.ownerId === ownerId` and `entry.sessionId === sessionId`, and the prompt path first checks that the session is the caller's (`prompt-attachments.ts:42`).
- So the owner cannot claim the member's upload, and the member cannot claim into the owner's session. Nothing is copied under `attachments/<ownerSessionId>/`.
- The member spends only their own pending budget, which expires in an hour.
- J1's worry ("stages a file under the owner's session id folder") does not hold: the session folder is written only at a claim.
- An early ownership check would improve the UX only.

## What I checked, by focus

**1. Escalation to owner or install.**
- `memberDenied` covers `system:admin`, `pi:*`, `users:*` and `lanes:*` (`contracts/roles.ts`).
- Cookie sessions get `permissionsOf(role)` from the `findSession` join, read on each request.
- A token gets the intersection of its row, `GRANTABLE` and the user's role. `create` is `forbidden` above the creator's set and needs a step-up. `system:admin`, `users:*` and `secrets:*` are never for tokens.
- Background Callers: `automationCaller` (`sessions:read/operate`), `ownerCaller`, the lanes `callerFor`, the `systemCaller` of `compose-users.ts` and the cascade's `asOwner` all hold nothing a member lacks, and there is no `Caller.role`.
- Step-ups: `users.invite`, `setDisabled(false)` and `delete` call `requireStepUp`. Marks are forgotten in `disableAndRevoke`.
- An invitation creates only a `member` (`insertMember` hardcodes it).
- CLI: `user add --role owner` is refused once an owner exists. `passkey reset <user>` is scoped to that user, and `device.key` goes only for the owner.
- HTTP routes that use `httpCaller`:
  - `/github/app/new` is `system:admin`; `/authorize` and `/authorized/finish` are `settings:operate`.
  - `/files/raw` GET and PUT are gated by path.
  - `/upload` and `/agent-files` carry no host path.
- Every member-reachable `*:admin` method (`policy.*`, `auth.*`, `agents.*`, `automation.*`, `sessions:admin`) acts on the caller's own rows. No install-wide effect is left to a member.

**2. Cross-user reads and writes.**
- The matrix is typed exhaustive (`ALL_CLASSIFIED`), with a canary over every answer and stream frame (31 journey tests green).
- I spot-checked by hand:
  - `agents.vmStatus` uses `vmView(ctx.caller.userId)`;
  - `subagents.profiles` and `sessions.commands` are owner-scoped (see M5);
  - `agents.purgeTrash` checks `inTrash(caller.userId, …)`;
  - `agent.delegate` targets by `ctx.ownerId`;
  - search, inbox, audit, receipts and usage are per owner;
  - the scanner never adopts a mirror, and adopts CLI files only to `ownerId()`.
- Relay: the policy, the models and `claudeToken` are per box, keyed by the box's own relay key. An evicted entry answers `model` (fail closed).
- Agent ids: 8 hex, and `exists` reads `agent_trash` too.
- Attachments: see "Not a finding" above.

**3. The host gate end to end.**
- The dispatcher collects every `ClientPath` during the synchronous `safeParse` and refuses a member's path before the handler, receipts included.
- The static walker covers `path|cwd|root|dir|folder|file`.
- `canonical` plus `byPath` is lexical and per owner, prefix safe (`root` or `root/…`).
- An unknown id is gated, since `isMember` is `roleOf !== "owner"`.
- `routeBoxPath` gives the routing decision to the caller.
- `runsInVm` is true for every gated owner, so no host trust or helper read happens for them.
- `service-launch` refuses a member's host launch, and `ensure` and `add` refuse a member.
- I found no path-bearing route or method left outside the gate.

**4. Disable and delete.**
- Disable: one transaction sets the flag and deletes sessions, tokens and marks. WebSocket frames and the keepalive re-authenticate.
- The automation settings read `paused`, which covers fire, hooks, feeds, resume and the queues.
- The launch gate is checked twice (before and right before the spawn) and fails closed before `bindLate`. The relay answers `paused`. Boxes and agents stop. Remaining gaps: M1, M2.
- Delete follows this order: step-up, disable, stop, keys released and awaited, box projects, automation (cancels tasks), agents, sessions (files, mirrors, attachments, exports), push, search, vault folder, the `owner_id`/`user_id` sweep except `runs` and `audit`, and the `users` row last.
- The journey checks that owner rows, files and the vault survive and that the member's go.
- A crash at any step leaves a disabled account, and the retry is idempotent.

**5. Secrets.**
- `users.invite` is `secretResult`, and only the token's hash is stored. The link is a fragment, and the web strips it with `replaceState` and keeps it in memory only.
- `auth_invite_failed` logs the IP and the code only.
- GitHub tickets: 128-bit, single use, never logged (A6 re-review 2).
- Claude tokens: vault user scope only, sent inside `box_policy` over IPC, never logged by the relay or the daemon (`relay_send_failed {type}`). The stderr redactor masks every user's values.
- The user scope is never revealed to a VM: `secrets/service.ts` reveals agent scopes only.
- Vault drop: after the awaited key release and after the agents' scope drops.

**6. Budget.**
- The member line counts finished and live runs billed `api` or `unknown`, bridge excluded, with the day in the owner's zone (R10 seam `bindBudgetZone`).
- `policyOf` and `policyOfProject` answer `budget` on `memberLine.over`. A run's end refreshes its box, and every box once the member is over.
- Clamp: `null` and values above the cap answer `budget_cap`. `get` returns the effective value and the cap.
- A token cannot write `automation`, and `users.setBudget` is the owner's.
- No host-side model call is left to a member: autoName, compact and subagents run in the VM, host workers are refused, and pi helpers do not call models. A member cannot spend past the cap beyond the known limits (one run plus the 60 s tick; OQ5 forgery).

**7. Web.**
- Each hidden item maps to a daemon refusal:
  - Models, MCP, Skills and Trust: `pi:*`;
  - Users: `users:*`;
  - App creation and fonts: `system:admin`;
  - host projects and terminals: the gate;
  - the token dialog: `forbidden` above the creator's set;
  - the automation budget: `budget_cap`.
- The owner row has no budget and no disable, in the web and in the service. The invite token never reaches storage.

**8. Composition order and restarts.**
- `composeUsers` before the sessions, with models read lazily.
- `users.bind`, then `bindDelete`, then `agentsVm.bindLate`.
- The launch gate fails closed before `bindLate`.
- Migrations: users last; the controller's test names the order. The partial unique index allows one owner, and the oldest user is promoted.
- `migrateLegacy` runs after `composeAuth`. With no owner the file stays; when both exist the vault wins; with the key lost the file is kept.
- R11: no overview read at boot, and the crash test is green.
- Relay restarts replay policies with their tokens.

**9. Repo rules.**
- Every changed file is ≤ 400 lines (`daemon.ts` and `lanes/archive.test.ts` at 400).
- No cross-module deep import.
- No raw `Date.now` or `setTimeout` in added daemon code.
- Handlers follow the rule except M4.

## Known items reconfirmed (not counted)

- A4a: a tokenless box gets `model` instead of `no_claude_token`, and `agents.packages` shares the helper pool. Neither member method is cached, so a member can hold the four helpers.
- A4c: overshoot of up to one run and the 60 s tick; `budget` also blocks the member's own bridge.
- A5b: the 7-day trashes keep member data.
- J1: `daemon.ts` at 400.
- A6 M9: box tokens delivered before a restart are never revoked.

## What I could not verify

- Kata end to end: the relay in the real bundle after `sudo pap vm setup`, real pap-vmd stop, trash and sweep, and the absence of `/boxes` on a production host.
- I1 by a running test: the branch is read-only for me. The finding rests on the code path above (needles from `everyValue`, the fingerprint salt, `prepare` throwing `config_invalid` on every `resolve`).
- Real GitHub: the access check, App installs on a member account, signing keys.
- The web in a browser: no e2e run. I read the code paths only.
- eslint, typecheck, knip and format:check on the head; no full suites.
- The docs (J2) beyond the ADR, `agents-vm.md`, `web.md` (the owner-row claims match `UserRow.tsx`) and `update.md` (M7).

## Re-review of the fix dispatch

# Final re-review (390d7be6..5e71aaaf)
- I1/R13: ADDRESSED. compose-agents-vm-secrets.ts: `vault` = valuesOf(ownerId) (build + fingerprint via kata `secrets: core.ownerSecrets`, compose-agents-vm-kata.ts:93); `redactVault` = every user, per-user try + warning, feeds `partial` (redactionSource, relay at compose-agents-vm-relay.ts:66). Damaged owner vault still throws -> fail closed. Tests: "profile scan uses the install's secrets only (R13)" (4 cases).
- db optional: production passes it. daemon.ts:120-122 `core = { db, ... }` spread into composeAgentsVm; ownerId evaluated lazily per call. Absent only in unit tests. Not an issue.
- M1 ADDRESSED roles.ts isDisabled; roles.test "unknown or deleted id counts as disabled".
- M3 ADDRESSED github/service.ts record(userId,...) ; http.test asserts both ownerIds, no token.
- M5 ADDRESSED m14-classes.ts PROBES sessions.commands / subagents.profiles with `session` params, removed from SHARED_READ.
- docs ADDRESSED ADR 0085 R13 + owner-reads-disk sections; update.md rollback section.
- New Critical/Important: none.
