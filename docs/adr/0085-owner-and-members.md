# ADR 0085: Owner and members

Status: accepted · Date: 2026-10-24 · Spec: `docs/specs/2026-10-24-m14-multi-user-design.md`. Decisions: 128, 129, 130 (`docs/research/decisions-log.md`). Rulings: R1 to R13 of the M14 ledger. Builds on 0083 and 0084. Amends 0084 ("A GitHub App has one owner today").

## Context

Until M14 pap had one user. The schema already carried `owner_id` on every root row, but no code created a second user, every cookie session held every permission, and several things are global to the install: Pi's agent folder, the Claude token file, the GitHub App, one pap-vmd, the VM memory cap. The owner wants to invite people they trust, each with their own projects, sessions, agents, triggers, budget, Claude token and GitHub account, without letting them administer the install or reach the host.

## Decision

- **Two roles, one owner.** `users.role` is `owner` or `member`; a partial unique index allows one owner. The migration makes the oldest user (`ORDER BY created_at, id LIMIT 1`) the owner. The owner holds every permission. A member lacks `system:admin`, `pi:*`, `users:*` and `lanes:*`. A token gets the intersection of its row, `TOKEN_PERMISSIONS` and its user's role; `system:admin` and `users:*` are never for tokens.
- **No `Caller.role`.** The role lives behind the auth port only: `auth.roleOf(userId)` and `auth.isMember(userId)`. Background callers (`automationCaller`, `ownerCaller`, lanes `callerFor`) are untouched. `isMember` is `roleOf !== "owner"`, so the gate **fails closed**: an unknown or deleted id is gated like a member. A unit test greps non-test daemon code for `caller.role` and finds none.
- **Members have no lanes in M14.** Lanes in boxes are lot B3. `lanes.create` and `lanes.runScript` refuse any member, and `lanes:*` is in the member deny list. The gate's lane call sites are defence in depth.
- **A deny-by-default host gate.** A member reaches no host path. Every client path field uses one schema, `ClientPath` (`packages/contracts/src/client-path.ts`). It records each parsed value into a collector; the dispatcher (`apps/daemon/src/kernel/ws/dispatcher.ts`), for a member only, runs `assertBoxOnly` (`apps/daemon/src/kernel/box-path.ts`) on every collected path before the handler, so a new path-taking method is gated by using the schema. The raw HTTP routes do the same. `assertBoxOnly` returns the `{projectId, root}` it matched and the caller routes with it. A contracts test fails a raw `z.string()` path field.
- **Invitations.** Settings › Users creates a token of 32 random bytes (base64url). Only `sha256Hex(token)` is stored. It is single use and lasts 24 hours; at most 50 can be pending. `users.invite` is `secretResult` with a step-up, so the raw token never reaches `receipts`. The link is `<origin>/invite#token=<token>`, which **replaces the spec's `/auth/invite/<token>`**: a URL fragment never reaches a server log or a Referer. Accepting uses the setup rules, creates a member and starts a password session; a live session cookie is revoked first. Failures count on a throttle of their own (`invite_throttle`), never the setup throttle.
- **Disable, then delete.** Disable sets `disabled_at` and revokes credentials for good (R5): sessions and tokens are deleted, and Enable (step-up) restores sign-in only. It is deny-by-default through three chokepoints with no per-path list: the member's automation settings read `paused`; the VM launch gate refuses their boxes and agents `account_disabled` (fail closed before `bindLate`, re-checked right before spawn); the relay policy answers `blocked: "paused"`. Delete starts with disable, asks the step-up, stops everything, trashes box projects and agents, cancels tasks, releases the GitHub signing keys, drops the vault, then deletes the rows and the `users` row. It keeps `runs` and `audit` (OQ2). The owner can be neither disabled nor deleted.
- **A Claude token per user.** It sits in the vault's user scope as `CLAUDE_TOKEN` and travels inside `box_policy` as `claudeToken`, computed for the box's owner. The legacy `secrets/claude-token` file moves to the owner's vault at first start. A box whose owner has no token gets `null` and the relay's `no_claude_token` refusal; another user's token is never used.
- **GitHub per user.** The App is public (Q1); each user authorizes it on their own account. Linking or cloning a repository needs push through the member's own token (OQ3). Every installation-token mint goes through one chokepoint, `mintFor`, which runs a cached access check (10 minutes, stale for at most 60, a 401 counts as lost access). The sign-in finishes with a one-time ticket bound to the starting user's session (R8, R9), so a member cannot bind the owner's GitHub token to their own account (RT-01, found in review).
- **Budgets.** `users.budget_usd` (USD per day, 0 to 1000, default 5). Two lines: the automation budget is clamped to the cap, and the **member line** counts every run billed `api` or `unknown`, interactive included and the bridge excluded, for the budget day in the owner's zone (R10). The relay blocks `budget` once the line reaches the cap. `settings.set` above the cap or `null` is `budget_cap`.
- **Shared providers.** `provider_sharing` has one row per provider, written at first sight and on change (R11: never at boot, because a boot read starts a Pi helper). API-key providers are shared by default; OAuth providers are never served; `claude-bridge` is exempt and goes through each user's own token.

## Known limit: the budget is a guard against mistakes (OQ5, owner, decision 129)

A box terminal is guest root. A member can read their worker's relay key and call `llm.internal` directly, or under-report cost. The VM-reported cost and the provider label on a run are forgeable by a member, so the budget, the member line included, is a guard against mistakes and not a hard cap against a member. Relay-side token metering is a later lot. What the daemon does enforce from its own side: the exits (hosts, the models and providers a box may call, the token), not the VM's report.

## R13: the profile scan uses install secrets only (deviation from spec §7)

Spec §7 had the image build scan the shared Pi profile for the values of every user's vault. Final review found that this lets one member's ordinary value (`NODE_ENV=production`, a word that appears in a profile file's name or text) fail every VM launch on the install, the owner's included, with a cause the owner cannot find. Members cannot write `~/.pi/agent`, so their values in that scan can only be false positives. The scan (and the profile fingerprint's salt) now takes `auth.json`, the GitHub App secrets, the live GitHub and box tokens and the owner's vault (nothing if no owner exists). The relay's stderr redactor still masks every user's values. A damaged vault of another user is skipped with a fixed-word warning (`owner_secrets_user_vault_skipped`); the owner's damaged vault still fails the build closed. Cost if wrong: a member's secret pasted into the owner's profile by the owner would not be caught.

## Known limit: the owner can read members' data on disk

"The owner sees usage, not content" is a product rule, not a technical barrier. The owner is the host's unix user: they can read members' session mirrors, attachments and box disks under `$PAP_HOME`, and the vault, whose key sits beside it. Docs and copy never claim more.

## Consequences

- Run `sudo pap vm setup` after the update: the relay in the bundle changed (`box_policy` carries the token).
- The cost of a disabled-then-enabled member: they sign in again and create new tokens; nothing else is restored.
- Deleted members' data waits in the 7-day trash (box disks, agent homes) until the sweep.
- One shared Pi profile: members use the providers and models the owner enables, and cannot change them.
- Cost if wrong: a role added later (admin, viewer) is one value in `permissionsOf`; a multi-owner install is out of scope.
