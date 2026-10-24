# M14: several users

Date 2026-10-24. Status: approved (owner, 2026-10-24, decision 128: the M14 form `docs/research/m14-decisions.html`, every controller's call kept, Q1 public, Q2 API-key providers, "go"). Owner directions: decision 126 (every recommendation of `docs/research/boxes-b2-m14-decisions.html` accepted). Builds on the boxes programme (lots B1, B2: `docs/specs/2026-10-23-boxes-b1-design.md`, `docs/specs/2026-10-24-boxes-b2-design.md`). ADR to write: 0085, "Owner and members". Calls the controller made without the owner are marked *(controller's call)*.

## 1. Goal

pap gets more than one user. The owner invites people they trust; each member has their own projects, sessions, agents, triggers, budget, Claude token and GitHub account; the owner keeps the installation's settings. Projects are not shared in M14.

Facts from the code recon:

- Every row already carries `owner_id` and every read filters on it (24 tables, the shell, search and Inbox streams); `workspace_id` is never read.
- No code path creates a second user (`insertFirstUser` is `WHERE NOT EXISTS`); the "owner" is the oldest user; there is no role column.
- Every cookie session gets every permission (`OWNER_PERMISSIONS`): a second user would administer everything.
- Global to the install: Pi's agent folder (provider keys, models, MCP, trust, skills, extensions), the Claude token file, the `gh` login and the host's `~/.ssh`, one pap-vmd, the VM memory cap, the VAPID key.
- Host projects, host terminals, host lanes and lane scripts run as the daemon's unix user on the host: whoever runs them reaches the owner's files.
- The vault already keeps one encrypted document per user (`{kind: "user"}`), unused so far.

## 2. Decisions (owner)

- The other users are trusted people with their own projects, agents and triggers.
- Two roles: **owner** (administers the installation: models and providers, the Pi configuration, policy defaults, the VM stack, users, the GitHub App) and **member** (their own projects, sessions, agents, triggers, settings).
- Accounts come from an **invitation** in Settings › Users: a one-use link, then a password and a passkey. `pap user add` stays.
- **Providers and models are shared**: members use the providers and models the owner enables, with a **daily budget per member** the owner sets.
- **A Claude token per user** (each their own subscription).
- **GitHub per user**: each user authorizes the same pap GitHub App on their own GitHub account; their projects use their tokens and their signing keys.
- **No project sharing** in M14.
- **The owner sees members' usage and costs, not their content.**
- **One global VM memory cap**, first come.

Non-goals: project sharing, teams and workspaces, OIDC, per-user Pi configuration or provider keys, per-user VM quotas, a member promoted to owner, several owners.

Anti-goals: a member reaching the owner's files, sessions, agents, secrets or host shell; a member raising their own budget; a member's action spending the owner's Claude subscription or GitHub identity.

## 3. Roles and permissions

- `users` gains `role` (`owner` | `member`). The migration makes the oldest user the owner; there is exactly one owner *(controller's call)*.
- A cookie session gets the permissions of its role. The owner keeps every permission. A member gets every permission except `system:admin`, `pi:admin` and a new `users` domain *(controller's call)*.
- `system:admin` becomes the permission of install-level actions: creating and deleting the GitHub App, the VM settings, the Claude token of another user (none), the push key, update checks, doctor-like reads *(controller's call: the plan lists each method moved to it)*.
- A member's API tokens can hold at most the member's own permissions.
- **Members get no `pi:*` permission** *(controller's call: `pi:read` exposes the shared MCP, trust and models configuration)*. A member's model picker reads the models the owner shares through a sessions-scoped method that returns names and capabilities only.
- **One central gate for host access** *(controller's call)*: for a member caller, any path or cwd that is not at or under one of their box project roots is refused (`forbidden`) before any host file system call. It covers `sessions.create`, `terminal.create`, `projects.add` and the implicit project creation, Files, Changes, lanes, triggers and attachments. Deny by default: a new path-taking method is gated without a per-method list.
- **Host-only features are the owner's** *(controller's call, security: they run as the host's unix user)*: host projects (`projects.add {path}`), host terminals, host lanes and their scripts, host triggers (a trigger on a host folder), the Files and Changes of a host project, MCP/Skills/trust of the shared Pi configuration. A member's projects are box projects (and their Scratch); a member's triggers target their box projects or their agents. Lot B4 removes the host features anyway.

## 4. Users

- **Invite.** Settings › Users (owner only) › Invite: an optional name hint, a link valid 24 hours, used once. The link opens `/auth/invite/<token>` (outside the SPA's session, like setup): username, password (12+ characters, as setup), then a passkey offer. The invitation stores only a hash of its token.
- **CLI.** `pap user add <username> [--password-stdin] [--role member]`: with no user it creates the owner (today's behaviour); once an owner exists it creates a member *(controller's call)*.
- **List.** Settings › Users lists each user: name, role, created, last seen, today's spend against their budget, boxes running.
- **Disable.** The owner can disable a member: their sessions and tokens are revoked, their boxes and agent VMs stop, their triggers pause; their data stays. **Enable** reverses it. **Delete** (step-up) removes the member and everything they own (boxes and disks to the trash, as a project delete; agents to the agent trash; sessions, triggers, vault, tokens, push subscriptions) *(controller's call)*.
- The owner cannot be disabled or deleted.

## 5. What each user owns, what is shared

| Shared (owner manages) | Per user |
|---|---|
| Providers, models, the enabled models list | Projects (box), Scratch, sessions, agents, triggers, Inbox, settings |
| The Pi configuration (MCP, skills, extensions, trust) | Daily budget (set by the owner for members) |
| The GitHub App | GitHub authorization, installations, signing keys |
| The VM stack and the memory cap | Claude token |
| The push key (VAPID) | Push subscriptions |
| Policy defaults the owner sets for the install *(controller's call: none in M14; each user keeps their own approval settings)* | Approval settings, host lists of their projects |

- **Shared providers** (owner, Q2): the owner chooses which providers members may use, one setting per provider in Settings › Users. Providers with an API key are shared by default; providers signed in by a subscription login (OAuth) stay the owner's unless the owner shares one explicitly. A member's request to an unshared provider is refused by the relay.
- **The Pi configuration in members' boxes.** The box images' Pi profile is the install's, as today (extensions, skills, MCP configuration, settings), filtered by the existing secret scan, which refuses a profile file holding a known secret *(controller's call: "shared, owner manages")*. Image layers and the build cache are shared; a member's `project.yaml` packages build only their project layer.
- **Budget.** The owner sets a member's daily budget (USD) in Settings › Users; the relay and the runs gate refuse a member over it (`budget`), as for the owner's own budget today. A member's own budget setting can only lower it.
- **Claude token.** The token file becomes per user: the vault's user scope holds `claude.token`; the relay uses the token of the box's or agent's owner. The existing file migrates to the owner at the first start, then is removed *(controller's call)*. A user without a token gets no Claude bridge: the relay refuses (`claude_token_missing`), never using another user's token *(controller's call)*.
- **GitHub.** B2's user token moves from the owner's vault to each user's vault (it is already in the user scope); `github.status` is per user; the App stays per install (owner creates it, `system:admin`); a member authorizes it from their Settings › GitHub (`github.authorizeUrl`) and installs it on their account; a project uses its owner's tokens and key. The App is public (owner, Q1: `APP_PUBLIC` is true on main since 2026-10-24), so each member installs the same App on their own account; GitHub lists the App (its name and client id, never its key) and installing it still needs each GitHub user's own consent.
- **CLI recovery.** `pap passkey reset [<username>]` (default: the owner) and `pap user add` take a username *(controller's call)*.

## 6. What the owner sees

- Settings › Users: per member, usage and costs (today, 7 days), budget, last seen, boxes running.
- Nothing of a member's sessions, projects, files, agents' threads or Inbox: every read stays filtered by `owner_id`.
- The audit stays per user; install-level actions (users, App, VM) write the owner's audit.

## 7. Background paths that assume one owner

- The Pi session scanner keeps adopting CLI sessions to the owner (host feature, owner only).
- Push's boot budget check covers every user.
- The image build's secret scan covers every user's vault and tokens (it already reads all vault values).

## 8. UI

DESIGN.md applies.

- Settings › Users (owner): the list, Invite (copyable link, its expiry), per member Budget, Disable or Enable, Delete (danger, step-up).
- The invitation page: the setup page's look, with the inviter shown as text.
- A member's UI hides the owner's features: Models and providers editing, the Pi configuration (MCP, Skills, trust), Users, the GitHub App creation, host projects (the New project dialog offers Empty and GitHub only), host terminals.
- The account menu shows the role (`OWNER` / `MEMBER` chip, mono uppercase).

## 9. Tests

- Two users in the integration harness (`u1` owner, `u2` member): a member never reads or changes the owner's rows (one test per RPC family, driven from the method table so a new method cannot skip it), never gets a host feature, cannot call a `system:admin`, `pi:admin` or `users:*` method, cannot raise their budget; disabling stops their boxes and revokes their sessions; deleting removes their rows; an invitation is single-use and expires.
- The relay uses each owner's Claude token; a box of a member uses the member's GitHub tokens.

## 9b. Docs

ADR 0085; `auth.md` (roles, invitations, `pap user add`), `web.md`, `agents-vm.md` (per-user Claude token, GitHub), `finops.md` (per-member budgets), AGENTS.md; the decisions log and the roadmap.

## 10. Left to the plan

The exact list of methods moved to `system:admin` and `pi:admin` checks per method, the migrations, the invitation token format, where the role check sits in each host-only path, the Users screen layout, and how the work splits into lanes. M14 starts after lot B2 merges (it moves B2's user token and touches the same GitHub module).
