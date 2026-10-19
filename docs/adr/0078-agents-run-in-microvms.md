# ADR 0078: agents run in microVMs

Status: accepted, sub-project 1 · Date: 2026-10-19 · Spec: `docs/specs/2026-10-19-agents-microvm-runtime-design.md` (§3 to §13). Amends the spec (R23, R25). Rulings: R1 to R38 of `docs/plans/2026-10-19-agents-microvm-runtime.md`; decisions 106 to 113.

## Context

The CyberLooker report (spec §2) showed that an agent's shell, bubblewrap and egress proxy on the host share a kernel, a user and a home folder with pap: one escape reaches the platform. ADR 0048's sandbox is a host sandbox, and its limits are known (ADR 0049).

## Decision

- An agent runs in its own Kata Containers microVM (Cloud Hypervisor) with its own block disk, CPU and memory. Spec §3 to §13 and rulings R1 to R38 are the decision; this ADR does not repeat them.
- `pap-vmd` (root, `apps/vmd`) is the only caller of a pap-owned containerd, Kata and BuildKit. It takes one typed request per connection (`VmdRequest`, `packages/contracts/src/vmd.ts`) and builds every path, command line and Dockerfile itself.
- The VM reaches pap only through an authenticated gateway on the bridge (`agents-vm.ts`: hello, `session_append`, `file_put`) and its model providers only through a host relay that checks a per-launch key, the agent's models and its budget (`relay-ipc.ts`). nftables (`agents-net.ts`) lets a VM reach those two ports and nothing else, and drops spoofed frames, IPv6 and VM to VM traffic (R22).
- All contracts of the sub-project are written by T1 and T2 and frozen after T2 (R35). `AgentInput` gains `resources`, `systemPackages` and `packages`; `InitRecord` gains `vm`; the worker-to-daemon records move to `pi-host-records.ts`.
- Two amendments of the spec: the mirror of a session file lives under `$PAP_HOME/agents/.mirrors/<agent id>/` (R23); the VM shell's code lives in `packages/pi-host/src/vm-shell/`, not in contracts (R25).
- The runtime ships behind `PAP_AGENTS_RUNTIME=vm`. ADR 0048's host sandbox is kept for `PAP_AGENTS_RUNTIME=host` until sub-project 3 makes the VM the default.

## Consequences

- Agents in VMs need KVM on the host and a root service (`pap-vmd`, installed by `sudo pap vm setup` from pinned artefacts, R19). A host without KVM keeps the host runtime.
- A migrated agent is refused in host mode (R12). The vault, one-use values, pi-mem0, prechecks and HTML export are not available in a VM until later sub-projects (R11, R16, R17, R37).
- A VM-written transcript is untrusted: the mirror checks it line by line, and a user entry pap did not send is shown as such (R32).
- Cost if wrong: a root service with a wider surface than the host sandbox had. The mitigation is its closed request surface (no path, command or Dockerfile text from the daemon).
