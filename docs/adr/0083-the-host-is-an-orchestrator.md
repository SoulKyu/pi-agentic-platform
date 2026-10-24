# ADR 0083: the host is an orchestrator, every component that runs code runs in a box

Status: accepted · Date: 2026-10-23 · Spec: `docs/specs/2026-10-23-boxes-design.md` (programme), `docs/specs/2026-10-23-boxes-b1-design.md` (lot B1). Decisions: 115, 124 (`docs/research/decisions-log.md`). Supersedes: 0074 and 0075 (effective at lot B4), 0036 (effective at lot B2). Amends: 0023, 0034. Builds on 0078, 0079 and 0081.

## Context

Agents run in microVMs (ADR 0081). Everything else still runs code on the host with no sandbox: interactive sessions, lane sessions and scripts, `gh`, Pi package installs, trigger tasks and their prechecks, the terminal and the Pi configuration helpers. The owner's rule (2026-10-23): the host is only an orchestrator and an interface with the VMs; it does nothing else.

## Decision

- **The host keeps pap, not the work.** The daemon (UI, API, auth, database, audit, runs, budgets, push), the gateway, the relay (provider credentials), the egress proxy, the session mirrors, the encrypted secrets and the Pi configuration as data. It never runs and never reads a box's content: a host `git status` on a repository a VM wrote is code execution (`core.fsmonitor`, hooks, filters).
- **Everything that runs code runs in a box.** A box is a Kata microVM run by pap-vmd. An agent has one; since lot B1 a project has one. A box has a `BoxRef` (`agent:<id>` or `project:<uuid>`), a disk, a host list, and one trust zone: taint is per launch.
- **Reads go through the guest too.** Files, Changes and knowledge of a box project are guest operations (`fs.*`, `git.*`, `knowledge.*`, `project.config`). A path under a box project's root never reaches the host file system or host git.
- **pi-web is gone for good.** pap no longer coexists with it and no longer scans `~/.pi/agent/sessions`.
- **Hosts are reached through the proxy.** A box reaches the owner's host list plus its project's list; an accepted `network.request` from a box session adds the host to the project's list.

## What changes in lot B1 (now)

- Project boxes exist: a new project is created from a name and gets a box (`projects.create`), plus a Scratch project per user. Sessions, children and trigger tasks of a box project run in it. Files, Changes and OKF knowledge go through the guest. Search indexes session mirrors, agents' and projects'.
- The guest protocol is 2 (`PAP_BOX` replaces `PAP_AGENT_ID`); `sudo pap vm setup` is needed after the update.
- Prechecks are removed (a stored one is refused with `precheck_removed`); this follows 0081's rule for agents, for every trigger.
- Host projects, host workers, the host session scanner and the outside-write warning keep working unchanged. 0074 and 0075 stay in force for them until lot B4.

## What changes later

- **Lot B2 supersedes ADR 0036.** The terminal moves into the box, `gh` stops running on the host, and GitHub goes through a GitHub App pap creates (ADR 0084). Until then 0036 holds for host projects and a box project has no GitHub.
- **Lot B3** moves lanes into the box. ADR 0034 (lane scripts trusted by the hash of their text, run from the browser only) is amended there: the trust rule stays, the scripts run in the box.
- **Lot B4 supersedes ADRs 0074 and 0075.** Host workers, host git, node-pty, the host session scanner and pi-web coexistence go; pap forgets host projects (their folders stay on disk). ADR 0083 is completed there.

## Amendments

- **ADR 0023 (Pi configuration helper).** The helper stays a short-lived host child for operations that only read or write the Pi configuration (models, settings, MCP file edits). Operations that run third-party code (MCP Test, Pi package installs) move into a box or an image build at lot B4. Nothing changes for them in B1. In B1 a repository's own `.pi/` resources (extensions, skills, MCP configuration) are simply not loaded in a box session.
- **ADR 0034 (lane scripts).** Unchanged in B1: lanes are off for a box project. In lot B3 the hash trust rule and browser-only start stay, and the scripts run in the box, not on the host.

## Consequences

- **No KVM, no pap box.** A host without KVM or without `sudo pap vm setup` cannot create or open a box project; agents already worked that way. Host projects keep working until B4.
- **No backup of a box's disk** (sub-project 4, later): a project's files live only in its box until they are pushed (B2).
- **One memory cap.** `PAP_AGENTS_MEMORY_MAX_MB` keeps its name and now covers every box, agents' and projects'.
- **The log field `agentId` became `box`** on the gateway, relay and VM log lines. Queries and alerts outside pap must follow.
- **Repository `.pi/` resources do not load in a box** until a later trust decision.
- Cost if wrong: the line between configuration-only and third-party-code helper operations moves at B4, with a new amendment.
