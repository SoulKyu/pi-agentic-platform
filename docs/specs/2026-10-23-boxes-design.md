# Boxes: every pap component runs in a microVM (decision 115)

Date 2026-10-23. Status: programme design, brainstormed with the owner on 2026-10-23. Follows the closed "agents in microVMs" programme (ADRs 0078, 0079, 0081, 0082). Each lot (§13) gets its own detailed spec and plan before work starts; this document holds the decisions they share. ADRs to write: with lot B1, 0083 "the host is an orchestrator: every component that runs code runs in a box" (supersedes 0074, 0075 and 0036; amends 0023 and 0034); with lot B2, 0084 "GitHub through a pap GitHub App".

Calls the controller made without the owner are marked *(controller's call)*.

## 1. Goal

Owner: "La machine hôte ne doit être qu'un orchestrateur et une interface avec la VM. Elle ne fait plus rien." Security first: security is an enabler.

Today agents run in microVMs (ADR 0081), but every other component runs code on the host with no sandbox: interactive sessions (the worker and Pi's `bash`, guarded only by approvals), lane sessions and lane scripts, `gh`, Pi package installs, trigger tasks and their prechecks, the terminal, and the Pi configuration helpers (MCP Test starts a server). This programme moves all of it into **boxes**: Kata/Cloud Hypervisor microVMs run by pap-vmd, the agents' stack.

The host keeps pap and the owner's configuration: the daemon (UI, API, auth, database, audit, runs and budgets, push), the gateway, the relay (provider credentials, including `!command` keys, which are the owner's own configuration), the egress proxy, the session mirrors, the encrypted secrets and the Pi configuration as data. It never runs and never reads a box's content: a host `git status` on a repository a VM wrote is code execution (`core.fsmonitor`, hooks, filters), so reads go through the guest too.

## 2. Decisions

From the owner:

- **pi-web is gone for good.** pap no longer coexists with it: ADR 0074's outside-write warning and ADR 0075 go, and pap no longer scans `~/.pi/agent/sessions` or the `pi` CLI's sessions.
- **No import, no migration.** Host projects and host sessions keep working until lot B4, then pap forgets them. Their folders on disk are never deleted *(controller's call: forget, not delete)*.
- **A new project** is created from a name, without a path, from one of two sources: a GitHub repository (clone it, or fork it into the user's account; the user picks), or an empty folder, in which the box runs `git init` at its first start. An empty project can later push to GitHub, or clone inside.
- **One box per project.** Its sessions, lane sessions, trigger tasks, subagent children and terminals are processes in it.
- **GitHub through a GitHub App** that pap creates. The owner asked for "a GitHub admin token, from which pap creates the projects' child tokens"; a PAT cannot mint tokens, an App can (owner: "Github App parfait").
- **Each GitHub project has its own key**: generated in the box (the private key never leaves it); pap adds the public key to GitHub itself.
- **Network**: GitHub automatically, plus the project's host list; the terminal goes through the proxy too. A session that needs a host asks for it; an accepted request adds the host to the project's list.
- **The terminal is the box's terminal.**
- **Tools** come from a per-project image built from Debian packages declared in `project.yaml`.
- **No KVM, no pap.** KVM and `sudo pap vm setup` become install requirements.
- **Disk backups** (sub-project 4) stay on the roadmap, later.
- **M14 is not replaced.** GitHub accounts per user and user-scoped projects are discussed later.

Non-goals: migrating or importing anything from the host; syncing a box with a host folder; disk backups; GitHub accounts per user and per-user projects; a Kubernetes backend (the `AgentRuntime` port stays the seam); taint per session inside one box; PGP keys (SSH signing gives "Verified").

Anti-goals: a project's content read or executed on the host (git, files, scripts, package installs, MCP servers); a long-lived GitHub credential inside a box; a silent image rebuild from a `project.yaml` a session wrote.

## 3. Host and box

| Stays on the host | Runs in the box | Goes |
|---|---|---|
| Daemon, UI, API, auth, database, audit, runs, budgets, push, Inbox | pi-host workers and their tools (Pi's `bash` as pap's VM shell) | Host workers and their systemd scopes |
| Gateway, relay, egress proxy, pap-vmd | git: status, diff, checkpoints, review, commit, push, PR | Host git and the `vcs` poll |
| Session mirrors and search over them | Files: explorer, viewer, editor save, uploads | Host Files paths |
| Secrets: vault, GitHub App key, user token, Claude token | Terminal (node-pty) | Host node-pty |
| Pi configuration as data (models, settings, MCP config) | Lane worktrees and scripts | `gh` on the host and its shared login (ADR 0036) |
| Image builds through pap-vmd's BuildKit | MCP stdio servers, extensions, MCP Test | Session scanner, outside-write warning, pi-web coexistence |
| | OKF detection and ENABLE OKF, `project.yaml` reads | Prechecks; host Pi package installs (they become image builds) |

## 4. The box

- **Identity.** `box = {kind: "agent" | "project", id}` replaces the agent id in pap-vmd's requests, the gateway hello, the launch, the relay's key and attribution, the proxy's host lists and taint, the mirrors and the memory cap. This is the contract migration decision 115 foresaw; agent boxes keep their behaviour.
- **Layout.** The box disk is mounted at `/boxes/<projectId>` and the project is its `project/` folder, whose path is also pap's path for the project (B1 spec §3) *(controller's call)*; lane worktrees on the same disk; the rest of the guest layout follows an agent's (home, inbox, Pi profile). A project box has no `/agent/knowledge`: its knowledge is the project's own `knowledge/` (ADR 0082).
- **Disk.** One block disk per project, like an agent's, under pap-vmd's root-owned folder. Resources per project, edited in the project's settings: memory 2048 MB, 2 CPUs, disk 8 GB by default *(controller's call)*; the disk only grows, online, like an agent's (worktrees, fan-out lanes and dependencies share it). The host never mounts a box disk (pap-vmd attaches it as a direct volume); a project is seeded inside its box (clone or `git init`), never by writing the disk from the host. Project boxes and agent boxes share one memory cap (`PAP_AGENTS_MEMORY_MAX_MB`, which keeps its name).
- **Image.** Three layers like agents': base, Pi profile (the owner's, with the same preparation and secret scan), project (the Debian packages of `project.yaml`). The guest reads `project.yaml` and reports its package list. When the list differs from the one the image was built from, the project page shows the difference and asks the owner to rebuild *(controller's call: a session can edit the file)*. There is no `apt` at run time: the root is read-only.
- **Lifecycle.** A box starts on first use (a session, a terminal, a task, a Files read) and stops after the worker idle time once nothing runs in it. Opening a session's history never starts it. Deleting a project moves its disk to pap-vmd's trash and its mirrors to the host trash for 7 days, like an agent.
- **Trust.** One box is one trust zone. SP3's rule holds: the daemon taints a launch's sessions from what the proxy sees, so a trigger task that reads outside content taints every session of that launch until the box's next start. Taint per session would be an illusion on a shared disk.
- **Policy inside.** Project sessions get the VM rules of agent sessions: Pi's `bash` is pap's VM shell (bwrap, seccomp), the file tools never follow links, and the guards are at the exits (relay, proxy, platform ops, push and PR). The session's approval mode still applies. The terminal is not in bwrap: it is the owner *(controller's call)*.

## 5. Projects

- **Create.** `projects.create {name, source}`, with `source` `empty` or `github {repository, mode: clone | fork}`. No path in the API or the UI. Names are unique per owner; renaming changes the label, never the box.
- **Empty.** At the first start the guest runs `git init` in `/project` (branch `main`) *(controller's call)*.
- **Clone.** The box clones over HTTPS with the project's token (§9).
- **Fork.** The daemon forks into the user's account with the user's authorization (§9), then the box clones the fork: `origin` is the fork, `upstream` the original.
- **Reading a project.** Everything that reads a project's content becomes a guest call over the gateway, bounded and returning data only: Files, `vcs` status and diffs, OKF detection and ENABLE OKF, the project home's facts, project skills and MCP configuration, `project.yaml`.

## 6. Sessions and tasks

- **Every session belongs to a box**, a project's or an agent's. A session that belongs to no project of the owner runs in their **Scratch** project (owner, 2026-10-23): an empty project pap creates for each user at the first such session, with its own box like any other; it can be renamed but not deleted while it holds sessions *(controller's call)*.
- **The worker runs in the box**, started by the guest. Its session file lives on the box disk and the daemon keeps a mirror, as for agents. Search indexes the mirrors (today it does not: B1 adds it).
- **Trigger tasks** target a project instead of a `cwd`. They run in the project box, in `/project`, unattended as today.
- **Prechecks are removed** from triggers. How stored ones are handled is B1's call.
- **Subagents and children** run in their parent's box.
- **Models** go through the relay: API-key providers only (OAuth providers are refused, as for agents) and the owner's budget.

## 7. Terminal

node-pty runs in the box, started by the guest on demand. Its stream crosses the gateway with the terminal's existing binary frames and acks. The daemon keeps the scrollback buffer as data *(controller's call)*. `PAP_MAX_TERMINALS` still applies per owner. The terminal's network is the proxy with the project's list (§8): a host that is not on the list fails for the owner too.

## 8. Network

- **Host list.** Each project has a host list, `host[:port]` and IP entries like an agent's `allowHosts` (at most 256). The egress proxy applies it to the project's box.
- **GitHub.** A GitHub project gets GitHub's hosts on its list automatically (at least `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`; B2 sets the exact list).
- **Requests.** A session asks for a host with the platform op `network_request`. Its card offers Deny or Allow this host; Allow adds the host to the project's list, where the owner sees it and can remove it. A tainted session's card says the session read outside content. An unattended task's request goes to the Inbox.
- **The rest** is the agents' network: the bridge, no default route, VM-to-VM traffic dropped.

## 9. GitHub

- **The App.** One per pap install, created by the owner in one click from pap's settings with GitHub's manifest flow (the browser carries the redirect, so pap needs no public URL). Its private key and secrets are stored in `$PAP_HOME/secrets`. Webhooks are off *(controller's call)*. B0 confirmed that GitHub accepts a plain `http://` LAN address for the redirect and the authorization callback. A manifest takes repository permissions only: after the creation, the owner sets the account permissions ("SSH signing keys", plus "Git SSH keys" and "GPG keys" if wanted) on GitHub's page for the App, then installs it (`docs/research/boxes-b0-spike.md`).
- **Installation and authorization.** The owner installs the App on their account, on all repositories by default so that a new fork or repository is reachable at once; picked repositories work too, and a clone or fork the App cannot reach stops with a message naming the GitHub step to add it *(controller's call: tokens stay limited to one repository either way; only the host holds the App's key)*. The owner also authorizes the App as a user, at installation; the user token lasts 8 hours and the host refreshes it with its refresh token. The user token stays on the host; only the daemon uses it, for account actions: listing repositories, forking, creating a repository, adding and removing signing keys.
- **Project tokens.** At each box launch pap mints an installation token limited to the project's repository (contents and pull requests, write), valid one hour. It reaches the box through the gateway and is renewed before it expires. git and `gh` in the box read it through a credential helper. Nothing long-lived enters the box.
- **Identity.** At its first start the guest generates the project's SSH key; the private key stays on the box disk. pap adds the public key to the user's account as an SSH signing key (the App's "SSH signing keys" account permission) and sets `user.name`, `user.email`, `gpg.format ssh` and commit signing, so commits show "Verified". Deleting the project removes the key from GitHub.
- **Push and PR** happen in the box (`git push` over HTTPS, `gh pr create`); the UI's buttons call the guest. Under taint they ask first (B2 settles the card).

## 10. Lanes

Worktrees live on the box disk. Lane scripts, checkpoints, the turn diff, restore and undo, review, fan-out compare, commit, push and PR all run in the guest. The daemon keeps the lanes' rows and renders what the guest returns. Script trust by content hash stays, hashing the content the guest reports. A fan-out's sessions share the project box's resources.

## 11. Host clean-up (lot B4)

B4 removes everything in the "Goes" column of §3, the host projects and sessions (forgotten, folders left on disk), and the helper operations that run third-party code (MCP Test, Pi package installs: they move into a box or an image build). Helpers that only read or write the Pi configuration stay on the host. The install guide says KVM is required; the OCI image and npm methods need a KVM host with pap-vmd.

## 12. Requirements, costs, limits

- **KVM.** KVM, x86_64 and `sudo pap vm setup` are required. Without them pap boots and says it has no boxes; it has no sessions.
- **FinOps.** On this host (19 GB, 14 CPUs) an idle box costs about 290 MB of host memory beyond the guest's, and a busy one close to its full memory plus several hundred MB (B0). The shared cap (half the RAM by default) holds about three or four 2 GB project boxes beside the agents. Boxes stop when idle; a cold start takes about 6 s.
- **No backup.** A project lives on a root-owned disk, so only what is pushed survives a disk loss; an empty project without a remote has no copy. The project page says so *(controller's call)*.
- **Shared box.** Inside a box everything sees everything: the GitHub token, the SSH key, other sessions' files. The boundary is the box.
- **Tests.** CI has no KVM: int and e2e tests use the process backend, `PAP_TEST_AGENT_RUNTIME=process` extended to boxes. Kata tests stay local. Tests never reach the real pap-vmd (the `PAP_TEST_VMD_SOCKET` guards).

## 13. Lots

| Lot | Content | Exit |
|---|---|---|
| B0 spike (1 day, throwaway) | node-pty in the guest over the gateway; git status and diff timings on the VM disk on a large repository; the App's manifest flow on the LAN | Numbers and go/no-go, written to `docs/research/` |
| B1 | Box identity (agent or project); a project created from a name (empty, `git init`); sessions and trigger tasks in the box; Files, editor and OKF through the guest; search over mirrors; `network_request` adding to the project's list; prechecks removed | A session in a new project runs, edits and searches with nothing of the project on the host |
| B2 | Terminal in the box; the GitHub App (creation, installation, tokens, clone and fork, signing key); push and PR from the box | Clone, edit, signed commit, push and PR from a box, "Verified" on GitHub |
| B3 | Lanes in the box: worktrees, scripts, checkpoints, review, fan-out | The lane → commit → PR journey in a box |
| B4 | Host clean-up (§11); ADR 0083 completed; docs | No code path left that runs or reads a project on the host |

Host projects keep working through B1 to B3. B1 alone is a step, not a place to work: existing work comes back only by a clone, so real work in boxes starts once B2 has landed, and B2 follows B1 at once *(controller's call)*.

## 14. Left to each lot's spec

The guest protocol for files, git and terminal frames; the bounds of each guest call; the exact GitHub hosts and App permissions; how stored prechecks are retired; where the UI offers the Scratch project; the project settings screen; the idle rules of a box; the image rebuild flow and copy; how ENABLE OKF and the project home read through the guest; the doctor checks for project boxes; the process-backend test harness for boxes.

## 15. Docs to update

The roadmap (a "Boxes" programme entry replacing decision 115's follow-up; M14 trimmed to accounts per user), the decisions log, ADRs 0083 and 0084, `AGENTS.md`, `docs/agents/agents-vm.md` (becomes the boxes note), `sessions.md`, `lanes.md`, `files.md`, `terminal.md`, `automation.md`, `install.md`, `doctor.md`.
