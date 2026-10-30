<p align="center">
  <img src="docs/brand/pap-mark.svg" alt="pap" width="96" height="96">
</p>

<h1 align="center">pap</h1>

<p align="center">Self-hosted agentic platform on the Pi SDK.</p>

## What pap is

pap runs the Pi coding agent on a machine you own and puts a web app in front of it. You get chat sessions with approvals, long-term agents with their own home, knowledge and limits, parallel work in git worktrees, and triggers that run unattended and report to an Inbox. It is a single Node daemon you reach from a browser, including a phone. pap reaches out only where you point it: your model provider, the hosts you allow an agent, your push service and your git remote.

Status: early development, on the way to v1.

- Docs index: [docs/README.md](docs/README.md)
- Design system: [DESIGN.md](DESIGN.md)
- Commands, rules and worker settings: [AGENTS.md](AGENTS.md)

## Long-term agents

Named agents that keep a thread, a home folder, a daily budget and a microVM of their own. Atlas below is a release watcher: it answers in its thread, hands a risky diff to a subagent, and stops to ask before it acts.

![An agent's space: thread, secret request, an isolated run and the status panel with today's cost against the budget](docs/screenshots/agents-space.png)

![An agent asks for approval; a finished subagent run sits under its parent](docs/screenshots/agents-thread.png)

![An agent with network on: only the hosts you list, behind pap's egress proxy](docs/screenshots/agents-egress.png)

![Settings, Agents: the agent list and the sandbox status, with what the sandbox does and does not cover](docs/screenshots/agents-sandbox.png)

- Each agent has its own home (`$PAP_HOME/agents/<id>/`, a git repository) and one trusted thread. Its name, role, model, tool preset, mode and daily budget are set per agent.
- Every agent runs in its own microVM (Kata Containers, Cloud Hypervisor), its shell in bubblewrap inside it, and it does not start without KVM and `sudo pap vm setup`: on a machine without them pap works and shows the agents screen as unavailable. Network is off by default; when on, it goes through pap's egress proxy, which guarantees hosts, not content.
- It can ask you for an approval or a secret from its thread or the Inbox. A request expires after 25 minutes. Secrets come from a vault and reach commands as environment variables, never as text in the thread.
- The `subagent` tool runs a task in a child session (up to 4 at once, 2 by default, one level deep) held to its parent's tools and mode. Agents can also hand work to other agents that opted in, and set reminders for themselves.
- Knowledge is OKF (Open Knowledge Format): markdown files in a `knowledge/` folder that a project's sessions and each agent read and keep up to date with their file tools. A project turns it on with ENABLE OKF; an agent has its own bundle in its VM. pap's sessions never load pi-mem0 (they filter it out of the extensions they give Pi); pi-web may still load it (`docs/agents/knowledge.md`).
- Budgets, pause and quarantine are the owner's switches.

Details: [docs/agents/agents.md](docs/agents/agents.md), [docs/agents/knowledge.md](docs/agents/knowledge.md), [docs/agents/finops.md](docs/agents/finops.md).

## Lanes and fan-out

A lane is one task in its own git worktree and branch. A fan-out starts two to four lanes with the same prompt and different models, so you can compare the results before keeping one.

![Fan-out compare: three lanes, with diff size, files, duration and cost per column](docs/screenshots/lanes-fanout.png)

![A lane review: the changed files and the diff, with commit and pull request actions](docs/screenshots/lanes-review.png)

- One lane per worktree under `$PAP_HOME/worktrees/<laneId>`, with checkpoints you can restore from.
- Compare shows summary, files, additions, deletions, duration and cost per lane; "Close losers" archives the others once you pick one.
- The review pane marks files as seen, takes comments, suggests a commit message and pushes or opens a pull request through `gh`.
- Lane scripts (setup, test, archive) run only after you approve them.

Details: [docs/agents/lanes.md](docs/agents/lanes.md).

## Automation, Inbox and push

Triggers start tasks on a schedule, from a webhook, from a feed, or by hand. Tasks run in your project or as an agent's isolated run. What needs you lands in the Inbox, and optionally on your phone.

![The Tasks board: one column per project or agent, triggers on top, runs below](docs/screenshots/automation-tasks.png)

![The Inbox drawer: a secret to provide, an agent's reply, a finished run](docs/screenshots/automation-inbox.png)

![Settings, Notifications: classes, mute and quiet hours](docs/screenshots/automation-notifications.png)

![The same Inbox on a phone](docs/screenshots/mobile-inbox.png)

- Webhook and feed triggers run supervised with a per-run cost cap by default; their text is treated as untrusted.
- A daily automation budget, a slots limit and a pause switch are in Settings, Automation. Quiet hours hold notifications, not runs.
- Web Push has classes (approvals, failures, budgets, agent notices, and off by default: finished tasks, replies), a mute timer and a one-line summary after quiet hours. Push needs an HTTPS origin; on plain HTTP the page says so.
- The app installs as a PWA and works at phone width.

Details: [docs/agents/automation.md](docs/agents/automation.md), [docs/agents/notifications.md](docs/agents/notifications.md).

## Sessions and approvals

Plain chat sessions in your projects, with the same approval flow as agents.

![A tool call waits for approval: allow once, for the session, always, or deny](docs/screenshots/sessions-approval.png)

![The model picker lists the models Pi has available and scrolls](docs/screenshots/sessions-models.png)

- A command that is not known safe asks first. You can allow the exact command or a prefix, once, for the session or always.
- Approval mode (read-only, supervised, auto-accept edits, full access) and the tool preset are per session.
- The model picker shows what Pi reports for your configured providers, with search.

Details: [docs/agents/sessions.md](docs/agents/sessions.md), [docs/agents/policy.md](docs/agents/policy.md), [docs/agents/models.md](docs/agents/models.md).

<sub>Screenshots use demo data and a scripted model (shown as faux).</sub>

## Security

pap runs code a model writes, on your machine, near your credentials. Each layer is kept narrow, and the docs say what it does not cover.

**Boxes: every agent and project in its own microVM**

- Each agent, and each project made from a name, runs in its own Kata Containers microVM (Cloud Hypervisor, KVM). The host only orchestrates: no host path reaches a box, and the daemon never reads a box's disk.
- Inside the VM the shell runs in bubblewrap with a seccomp filter (no new namespaces, mounts, `ptrace`, `bpf` or `io_uring`), most capabilities dropped and the image root read-only. Pi's file tools never follow a link.
- A VM reaches three ports on its bridge (gateway, model relay, egress proxy) and nothing else: no default route, no IPv6, no VM-to-VM traffic, address spoofing dropped per VM port.
- One root helper, `pap-vmd`, drives containerd, Kata and BuildKit. It renders the Dockerfiles itself (the daemon sends only apt package names and pap tags); base images start from a pinned Node digest and are rebuilt with `apt-get upgrade` every week.

**No provider key in a VM**

- Model calls go through `pap-relay`, the only holder of provider credentials. Each request is checked against a fixed route table, the launch's key (bound to the VM's address), the agent's models, and its pause and budget state.
- GitHub goes through a private pap GitHub App: a box gets a token for one repository (`contents` and `pull_requests`), renewed every 45 minutes.

**Network: only the hosts you list**

- Network is off by default. When on, everything leaves through pap's egress proxy, which checks `host[:port]` or IP entries against the agent's or project's list: HTTP, HTTPS, and ssh tunnelled over `CONNECT`. No other protocol has a path.
- Always refused, whatever the list says: loopback, link-local (cloud metadata included), CGNAT, multicast, the host's own addresses and the VM bridge. A private range is reachable only through an exact name or an IP entry, never a `*.` wildcard.
- Widening a list asks for your password again. A refused host shows a card with "Add to list"; nothing is retried behind your back.
- The proxy guarantees which hosts and ports an agent reaches, not what it sends there: it reads no content and decrypts no TLS. Scope credentials at the source (read-only tokens, narrow RBAC).

**Untrusted content and taint**

- Web pages, webhook and feed text, MCP tools and unknown extensions mark the session as tainted (the "external content" chip). In a VM the daemon marks the launch from what its proxy let through, never from the VM's own report.
- A tainted session asks Deny / Allow once before any call that could send data out, and each platform operation declares what it does when tainted. Tool results reach the model fenced as untrusted.
- Every tool call goes through an eight-stage policy pipeline (exposure, command denylist, egress, approval, run guard, containment, redaction, fencing and taint), where a block wins over an approval. Tools are classified by their registered source, never by name; reads of pap's database, `secrets/`, backups, Pi's `auth.json` and other sessions' transcripts ask in every mode.

**Secrets**

- The vault stores values with AES-256-GCM. They reach a command as environment variables, never as text in the thread, and pap's own paths never write them to a log, an audit row or a response.
- Limits (ADR 0049): a command can print a value, the redactor misses values under 8 characters and encoded ones, and the vault key sits beside the vault in `$PAP_HOME/secrets/`.

**Accounts and the web app**

- One owner and invited members. Invitations are single-use, last 24 hours and are stored hashed; a member reaches no host path and works only in boxes.
- Passwords are hashed with scrypt; passkeys require user verification. Sign-in throttles are built so that a spray cannot lock the owner out. Session cookies are `SameSite=Strict` and stored hashed, and an open WebSocket re-checks its credential on every frame and every 15 seconds.
- API tokens, passkey removal, a wider host list and edits under Pi's folders need a fresh password step-up (5 minutes). API tokens are hashed, always expire, and never carry a permission that changes what code runs (no auth, terminal, secrets, policy or box-network admin).
- Agent previews are served on a second port. pap's own routes refuse same-site and cross-site requests (`Sec-Fetch-Site`), and pap's cookie and `Authorization` header are dropped before a request reaches the VM. Use HTTPS beyond localhost: `--insecure-http` is for a trusted LAN only.

**Supply chain and operations**

- Dependencies must be 3 days old before pnpm installs them (ADR 0072). The offline archive and the VM artefacts are pinned by SHA-256.
- Children pap starts unattended get an allowlisted environment: never the SSH agent, `GIT_*`, `LD_*`, provider keys or credential-looking names.
- A plain backup leaves `secrets/` out but is still sensitive; `--encrypt` encrypts it. A restore treats the archive as untrusted input.
- Hostile-input and boundary tests (path traversal, token origins, protected files, fail-closed, taint, budgets) live in `apps/daemon/src/security/` and run in CI.

**Known limits**

- MCP stdio servers and extension children are not confined inside the VM (ADR 0081).
- A member is root in their own box: their budget line guards against mistakes, it is not a hard cap.
- Processes running as pap's user on the host can read its files and environment, and a backup of the whole `$PAP_HOME` holds the vault key.
- A proxy tunnel lives at most 30 minutes.

Details: [docs/agents/agents-vm.md](docs/agents/agents-vm.md), [docs/agents/policy.md](docs/agents/policy.md), [docs/agents/auth.md](docs/agents/auth.md), [docs/agents/agents.md](docs/agents/agents.md), [docs/agents/backup.md](docs/agents/backup.md), ADRs [0049](docs/adr/0049-the-vault-and-secret-requests.md), [0079](docs/adr/0079-agents-vm-egress-and-files.md), [0081](docs/adr/0081-agents-run-only-in-microvms.md), [0083](docs/adr/0083-the-host-is-an-orchestrator.md), [0085](docs/adr/0085-owner-and-members.md), [0088](docs/adr/0088-previews-and-the-untrusted-origin.md).

## Install

Linux with systemd, no sudo (the offline archive is x86-64). Full guide: [docs/agents/install.md](docs/agents/install.md).

Method 1, from a git checkout (needs Node 24.14+, pnpm, gcc, g++, make, python3):

- `git clone <repository> pap && cd pap`
- `scripts/install.sh` (builds, writes `~/.config/systemd/user/pap.service`, starts it)
- open the one-time setup URL it prints (`pap service url` prints it again until the next restart, even after it is used)
- `pap` is `~/.local/bin/pap`; reach a remote host with `ssh -L 7777:localhost:7777 <you>@<host>`

Method 2, offline archive pinned to a checksum:

- on the build host: `pnpm install && pnpm build && pnpm build:archive`
- copy the `.tar.gz` and `pap-install-<id>.sh` to the target (the script over a trusted channel)
- `./pap-install-<id>.sh` (carries its own Node; refuses a checksum mismatch)
- open the setup URL it prints; remove with `pap service uninstall` (data in `~/.pap` stays)

## Install, update, backup

- Update: run the new release's `pap-install-<id>.sh` with no flags, or `pap update install` (rolls back by itself if the new release does not start): [docs/agents/update.md](docs/agents/update.md)
- Backup and restore: `pap backup [--encrypt]`, `pap restore <file>` with pap stopped: [docs/agents/backup.md](docs/agents/backup.md)
- Check the machine and the install: `pap doctor`: [docs/agents/doctor.md](docs/agents/doctor.md)
- Container (rootless podman), npm and releases: [docs/agents/install.md](docs/agents/install.md)
- The feed, `curl | sh` and `npm publish` wait for the v1 release.

## Testing and releasing

- Unit and integration tests: `pnpm test:unit`, `pnpm test:int`. Browser tests of the built app: `pnpm test:e2e`, see [docs/agents/e2e.md](docs/agents/e2e.md).
- Parity with pi-web, row by row with its proof: [docs/agents/parity.md](docs/agents/parity.md). Evidence for the v1 exit criteria: [docs/research/m13-exit-criteria.md](docs/research/m13-exit-criteria.md).
- Releasing: [docs/agents/release.md](docs/agents/release.md) is the owner's runbook.
- CI runs on every pull request and on every push to `main`, documentation changes included, so the docs tests always run (`.github/workflows/ci.yml`). After `checks`, `unit` (2 shards), `integration` (4 shards, vitest `--shard`) and `build` run in parallel; `budgets` and `e2e` follow `build`.

## License

pap is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). One file derived from vercel/ai-elements stays under the Apache License 2.0: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
