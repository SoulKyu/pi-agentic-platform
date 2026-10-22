# Agents in microVMs, sub-project 3: the VM as the only agent runtime

Date 2026-10-22. Status: design, brainstormed with the owner on 2026-10-22. Builds on sub-project 1 (spec `docs/specs/2026-10-19-agents-microvm-runtime-design.md`, ADR 0078) and sub-project 2 (spec `docs/specs/2026-10-21-agents-vm-egress-design.md`, ADR 0079), and on `docs/agents/agents-vm.md`. ADR to write with the plan: 0081, agents run only in microVMs (supersedes ADR 0048's host sandbox for agents, ends ADR 0078's opt-in). The owner wants this sub-project **simple and fast**: delete more than it adds, no new dependency, no mechanism "for later".

Calls the controller made without the owner are marked *(controller's call)*.

## 1. Goal

After this sub-project an agent always runs in its microVM. At the box's exits the daemon decides from what it sees itself, never from what the VM says about itself. The host-sandbox code for agents is gone. When the code inside the VMs is older than the daemon, pap says so in plain words instead of failing silently (2026-10-22: a role over the old 8000-character cap made every VM worker exit with an empty output and "The session process failed").

## 2. Decisions

From the owner:

- **The VM is the default and the only agent runtime.** A host without KVM (or without `sudo pap vm setup`) has no agents. Everything else in pap (sessions, lanes, triggers that target no agent, terminals) works as before.
- **No migration**, as `docs/agents/agents-vm.md` already says: an agent made in host mode is deleted and created again.
- **Trigger prechecks are not brought into the VM.** The owner does not use them. A precheck on a trigger that targets an agent stays refused.
- **No confinement of MCP stdio servers and extension subprocesses inside the VM.** Once the exits trust nothing the VM says (§4), what they could read inside the VM (the gateway token file, the Pi profile, which holds no provider key) gives them nothing the agent does not already have; and pap does not control how a third-party extension starts its children, so confining them would mean nesting bwrap around the whole worker. The VM is the boundary. This stays a documented limit.
- KISS, DESIGN.md for the UI.

Non-goals: confinement inside the VM (above); an fd-relative path judge (the existence oracle by a race reveals that a path exists, never its content); the vault and one-use values in a VM (sub-project 2's imported files cover an agent's own credentials); `export_html`; pi-mem0 (sub-project 5); disk backups (sub-project 4); boxes for sessions, lanes and trigger tasks (decision 115, its own spec after this one).

Anti-goals: a new approval card; a root step (`sudo pap vm setup`) needed after a change that does not touch the code that runs in the VM.

## 3. The switch and what is deleted

- **`PAP_AGENTS_RUNTIME` is no longer read.** When it is set, the daemon logs one boot warning, "PAP_AGENTS_RUNTIME is gone: agents always run in microVMs", and starts *(controller's call: the owner's preview has a drop-in that sets it; a stale variable must not stop a boot)*.
- **Agents unavailable.** When KVM is missing or pap-vmd does not answer, the Agents screen shows an EmptyState: "Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`." with a pointer to `pap doctor`; creating or starting an agent is refused with one typed error that the UI maps to that copy. Agent rows are kept untouched; they come back when the VM stack does. A VM that dies, or an agent trigger that fires, while the stack is gone takes the paths a failed VM start already takes today (the thread's failure state, the trigger run's failure and its notification); nothing new *(controller's call)*.
- **Deleted**, each after the builder checks it has no caller outside agents (a piece that does keeps its code):
  - the host sandbox for agents (ADR 0048): `SandboxSpec` and `bwrapArgv` (`packages/contracts/src/sandbox.ts`), pi-host's host sandbox tool and ops (`sandbox-tool.ts`, `sandbox-ops.ts`, `egress-client.ts` if only they use it), the daemon's agent gate paths that build them (`modules/sessions/agent-gate.ts`, `agent-port.ts`, `agent-surface.ts`). Pieces the VM path shares (`SYSTEM_TIMERS` and `ShellTimers` imported by `host.ts` and `session-mirror.ts`, and whatever `open-session.ts` uses for VM sessions) move to a neutral file or stay; those files shrink rather than disappear *(controller's call)*;
  - the bwrap probe and `PAP_BWRAP` (`kernel/sandbox/probe.ts`), the root-owned `python3` check (`modules/egress/python-probe.ts`), and their doctor checks;
  - the host-mode egress listener and its rules (ports 80 and 443, public addresses only), the `agentForm.error.allowHosts.vmOnly` refusal and its daemon check, for new and stored profiles alike. The host matching, DNS pinning and counts stay: the VM proxy uses them;
  - the host-mode precheck path for agent triggers (`modules/automation/trigger-agent.ts`). A precheck already stored on an agent trigger stays refused at fire time, as today, never ignored: ignoring it would wake the agent, and spend tokens, at every tick. The trigger form shows the precheck field for an agent target only when one is stored, with "Prechecks do not run for agents: clear this field." *(controller's call)*;
  - the host-mode branches of `compose-agents-vm*.ts`, `compose-m11-vm.ts`, `kernel/config-agents-vm.ts` and `agents/links.ts`;
  - the int tests that only prove host-mode agents (the ones that skip without bwrap).
- **Kept**: the approval engine in the worker (inside a VM it is the agent's own policy, see §4), `sandbox.network`, the egress module's shared code. The agent form loses the "sandbox required" switch; stored profiles keep parsing with the field present and ignored (no data migration).
- **Tests** that used host-mode agents move to the process backend (`PAP_TEST_AGENT_RUNTIME=process`).
- **Install**: bubblewrap and a root-owned `python3` are no longer host requirements for agents (the builder checks nothing else needs them).

## 4. Taint the daemon sees

- **Today** a VM worker reports its own taint and the daemon records it; platform ops (`whenTainted`), delegation isolation and trusted autonomy read the daemon's record (`modules/platform/dispatch.ts`, `PlatformKind.tainted`). A compromised VM can simply not report.
- **New**: the VM proxy (`modules/egress/vm-listener.ts`) tells the sessions module each time it opens a tunnel or forwards a request for a VM to a host that does not keep content clean. The rule is host mode's: a host keeps content clean only when it is one of the agent's trusted sources reached over `CONNECT` 443. The mark belongs to the **VM launch** *(controller's call: the proxy sees only the VM, and what came in stays in the VM's memory and disk)*: every session that runs in that launch is tainted, the ones live at that moment and the ones that start later in it (for the thread's VM: the thread, its children and its thread tasks; for a task VM: its task). The record is the sessions module's own (the one `PlatformKind.tainted` is read from); the launch's mark is applied to it, and a session started in a marked launch starts tainted. The mark is sticky, as today; a new launch starts clean, which is no weaker than host mode, where a new session reading a file fetched earlier was not tainted either.
- A refused request does not taint: nothing came in.
- The worker's own reports still add taint and can never clear it. The mirror-resync taint stays.
- What this leaves inside the VM, documented: the approval mode, the blocked commands and the tool rules run in the worker, so in a compromised VM they are the agent's own choice. At the exits the daemon enforces the host list (proxy), the models and budget (relay), and the platform ops' callers and taint rule (gateway).

## 5. Prompt chips

For a VM agent, `agents.prompts` and `agents.prompt` read the owner's imported files under `prompts/*.md` (sub-project 2's host copy, same bounds as today: no link followed, 16 KiB, UTF-8). Files the agent writes itself in its VM are not listed *(controller's call: the daemon never reads a VM disk)*.

## 6. Code skew between the daemon and the VMs

- The build writes a **bundle id**: a hash of the built files that run inside the VM (pi-host's `dist` and `@pap/contracts`'s `dist`), so a change to the web app or the daemon alone does not change it *(controller's call)*. `pap vm setup` copies it with the bundle into `/opt/pap-vm/agent-bundle`.
- The guest's hello carries the id. When it differs from the daemon's, when it is missing (a guest older than this sub-project), or when the hello's protocol differs, the daemon starts no worker and shows in the thread: "The code inside this agent's VM is older than pap. Run `sudo pap vm setup`, then open the thread again. Nothing was lost." It logs `vm_bundle_stale` once per launch.
- A worker that refuses its init record writes the reason (the schema path, never a value) to its output before it exits, so `worker_exited` is never silent.

## 7. Doctor

- `vm.bundle`: the installed bundle id equals the daemon's; otherwise "run `sudo pap vm setup`".
- `agents.hostMade`: agents with a recorded thread and no mirror are listed by name, "made in host mode: delete it and create it again".
- `PAP_AGENTS_RUNTIME` set: a warning that it is ignored.

## 8. UI and copy

DESIGN.md applies (tokens, listed primitives, mono uppercase buttons, English and French, the error pattern "what happened, what is intact, what you can do"). Changes: the Agents EmptyState without KVM; the agent form without the "sandbox required" switch, with the hosts hint no longer saying "VM mode:" (every agent is one); the trigger form without the precheck field when the target is an agent.

## 9. Tests

- Unit and integration on the process backend, with the egress test seams (loopback only, no public host or address):
  - a tunnel to an untrusted host taints every live session of that VM; a trusted source over 443 does not; a refused request does not; a worker report cannot clear the mark;
  - platform ops read that mark (`whenTainted`);
  - a bundle id mismatch starts no worker and posts the message; the init refusal is in `worker_exited.output`;
  - no KVM: agents unavailable, the rest of pap boots;
  - prompts from imported files;
  - the doctor checks.
- Kata (local, root window): the existing suite passes with no runtime variable set.

## 10. Left to the builder

The error code, how the proxy reaches the sessions module, the hash method and the id file's place, the order of deletions, and the copy of the boot warning.

Docs to update: `docs/agents/agents-vm.md` (known limits, the switch), `docs/agents/agents.md` (host sandbox sections go), `docs/agents/install.md` and `doctor.md`, `AGENTS.md` (bubblewrap line, `PAP_AGENTS_RUNTIME`), ADR 0081, the decisions log and the roadmap.
