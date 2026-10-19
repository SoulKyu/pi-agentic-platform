# pap agents in microVMs, sub-project 1: the agent runtime - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-19):** rulings R1 to R9 and the model table approved by the owner (decision 112). Opus red-team in progress (`.superpowers/redteam-agents-vm-1.md`), plan fix to follow before execution. 22 tasks (T0 to T21).

**Goal:** an agent runs in its own Kata Containers microVM (Cloud Hypervisor) with its own block disk, CPU and memory, reaches pap only through an authenticated gateway and its model providers only through a host relay that injects the credentials, so nothing inside the VM needs a question and a compromised agent is deleted without touching the rest of the platform. Shipped behind `PAP_AGENTS_RUNTIME=vm`; the host-bwrap agents stay the default until sub-project 3.

**Architecture:**
- **Root stays narrow.** `pap-vmd` (new app `apps/vmd`, root, systemd system unit) is the only caller of a pap-owned containerd instance, Kata and BuildKit. It takes typed JSON requests on a unix socket (group `pap`, 0660), validates every field with schemas from `@pap/contracts`, builds every command line itself and renders every Dockerfile itself. The daemon never sends a path outside pap-vmd's own state folder, a command or Dockerfile text.
- **Same protocol, new transport.** The worker protocol (`DaemonToWorker`, `WorkerRecord`) is unchanged. A length-prefixed JSON frame codec (bounded before the body is read) carries it over TCP from the VM to the daemon's gateway on the VM bridge. pi-host gets a socket `Ipc`; the daemon gets a `WorkerHandle` over a gateway connection, both built on the record core extracted from today's `spawnWorker`.
- **A guest supervisor.** The VM's entrypoint is `pap-guest` (in pi-host): it dials the gateway as `guest`, spawns and signals pi-host workers on the daemon's command, and reports their exits. Each worker dials the gateway as `worker` with its slot id. One VM per agent; thread, children and thread tasks are workers in it.
- **The daemon keeps a mirror of each session file** under `$PAP_HOME/agents/<id>/sessions/`, fed by `session_append` byte chunks and validated line by line; every existing reader (snapshot, history, search, outside-write checks) reads the mirror through `piPath`. Opening history never starts a VM.
- **Providers through a relay.** A daemon child process (`pap-relay`, in pi-host, the only holder of provider credentials) listens on the bridge; `http://llm.internal/<provider>/…` and `http://claude.internal/…` are matched against a fixed route table, then forwarded over TLS with the credential Pi's auth storage resolves on the host (or the owner's `claude setup-token`).
- **An `AgentRuntime` port** with a `kata` backend (pap-vmd) and a `process` backend (tests only: the guest runs as a local process over the same gateway, its `/agent` a temp folder), so every task except the Kata ones is built and tested on this KVM-less host.

**Tech Stack:** Node 24.14 (`NODE_USE_ENV_PROXY` not needed: the VM has no route but the bridge), TypeScript (erasable syntax), zod 4.6.5, Pi SDK 1.1.0, vitest. Guest image: Debian trixie slim (bubblewrap 0.11 with `--overlay`), Node at the host's version. Host stack installed by `pap vm setup`: Kata Containers static release (Cloud Hypervisor, guest kernel and rootfs), nerdctl-full (containerd, nerdctl, BuildKit, CNI plugins), nftables. **No new npm dependency.**

**Spec:** `docs/specs/2026-10-19-agents-microvm-runtime-design.md`. Binding context: decisions 106 to 111 (`docs/research/decisions-log.md`), the approved pages `docs/architecture/agents-vm/01` to `05`, ADRs 0047, 0048, 0049, 0050, 0053, 0055 to 0057 (pinned archives), 0074, 0075; topic notes `docs/agents/agents.md`, `sessions.md`, `models.md`, `daemon.md`, `doctor.md`, `install.md`.

## Plan rulings (additions to the spec, owner to confirm with the plan)

- **R1, chunked transcript.** Pi stores images inline, so a session line can exceed the spec's 1 MiB. `session_append` carries raw bytes (base64, at most 2 MiB a chunk) with their file offset; the daemon validates each completed line, at most 32 MiB (`MAX_SESSION_LINE_BYTES`). Cost if wrong: an agent that reads one image breaks its own transcript.
- **R2, who is root in the VM.** Spec §5 put pi-host under an unprivileged guest user and the shell in a user namespace. `apt` cannot install into a root-owned image from a user namespace (unmapped owners), and an unprivileged worker cannot start a root shell. So: the guest supervisor and the workers run as guest root; the shell runs as guest root in bwrap with new mount, pid, ipc, uts, cgroup and net namespaces, every capability dropped except `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_FSETID`, `CAP_SETUID`, `CAP_SETGID`, `CAP_KILL`, a seccomp filter, no `/dev/vsock`, an overlay over the image root, and `/agent/.pi` hidden. Without `CAP_SYS_ADMIN`, `CAP_SYS_CHROOT`, `CAP_MKNOD`, `CAP_SYS_PTRACE` and `CAP_SYS_MODULE` it cannot leave its namespaces, see the worker or reach the channel. Cost if wrong: either `apt` never works in the shell or the shell reaches the gateway token.
- **R3, where disks live.** Spec §8 put `disk.img` under `$PAP_HOME`, which pap's user owns: a root service writing there can be pointed elsewhere by a swapped link. Disks, their trash and (sub-project 4) their backups live in pap-vmd's root-owned state folder `/var/lib/pap-vm/<pap uid>/agents/<id>/` (0700). The daemon never reads them. Cost if wrong: root writes through a link the daemon's user planted.
- **R4, a guest supervisor** (`pap-guest`, above): the spec's "one VM, several workers" needs something inside the VM that starts workers. Cost if wrong: one VM per worker, against decision 109.
- **R5, pap's own container stack.** A host may already run Docker's containerd. pap-vmd uses its own containerd (`/run/pap-vm/containerd.sock`, root `/var/lib/pap-vm/containerd`) and BuildKit (`/run/pap-vm/buildkit.sock`), namespace `pap`, never the system ones. Cost if wrong: `pap vm setup` breaks the owner's Docker.
- **R6, root-owned code.** pap-vmd runs from `/opt/pap-vm/` (its bundle and a copy of the Node binary, root-owned 0755), never from pap's user-writable install. `pap update` therefore leaves pap-vmd at the old version: `pap doctor` and the agents screen say "run `sudo pap vm setup`", and the gateway refuses a guest whose protocol differs. Cost if wrong: pap's user edits code that root runs.
- **R7, no Dockerfile from the daemon.** The daemon sends `image.build` as data (layer, base digest, package names, a context folder of files); pap-vmd renders the Dockerfile. Only the agent layer has a `RUN` (`apt-get install` of validated names). Cost if wrong: a compromised daemon runs build steps of its choice as root's BuildKit.
- **R8, secrets never on a command line.** The gateway token reaches the VM through an env file pap-vmd writes 0600 in its state folder and deletes after `nerdctl run` returns; `/proc/<pid>/cmdline` is readable by every user. Cost if wrong: any local user reads a live token.
- **R9, providers in v1.** The relay serves providers whose Pi `api` is `anthropic-messages`, `openai-completions`, `openai-responses` or `google-generative-ai` with an API key, plus the bridge. An OAuth provider of `auth.json` is refused with a notice until T0 shows the relay's header handling works for it. Cost if wrong: an agent on an OAuth provider fails silently.

## Global Constraints

- 400 lines per file at most, test files included, no baseline. Sizes today that matter: `packages/contracts/src/pi-host.ts` 394, `apps/daemon/src/compose-m11.ts` 398, `packages/contracts/src/methods.ts` 390, `apps/daemon/src/modules/agents/service.ts` 387, `packages/contracts/src/agents.ts` 360, `apps/daemon/src/kernel/config.ts` 355, `apps/daemon/src/kernel/supervisor/worker.ts` 322, `apps/daemon/src/modules/sessions/agent-gate.ts` 311, `apps/daemon/src/modules/sessions/service-launch.ts` 292, `apps/web/src/features/agents/AgentForm.tsx` 282, `packages/pi-host/src/host.ts` 262. None grows past 395: new code goes into new files composed in by a few lines. `compose-m11.ts` takes no new line: the VM runtime is wired in a new `compose-agents-vm.ts`.
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`. Every RPC method declares a permission. RPC handlers decode, call one service method, map typed errors. `apps/vmd` imports only `@pap/contracts` and Node built-ins.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep `.ts`. Timers go through the kernel `Clock` (pi-host and vmd: an injected clock with the same shape). No sleeps in tests.
- Tests never touch `~/.pi/agent`, `~/.pap` or `~/.claude`, never contact a public host or GitHub, and use the scripted provider (`PAP_TEST_PROVIDER_SCRIPT`). Relay tests use a loopback fake upstream. vmd tests use a fake `exec`.
- Test-only switches (`PAP_TEST_AGENT_RUNTIME=process`) require `PAP_TEST_PROVIDER_SCRIPT` and stop the boot otherwise, like `PAP_TEST_GIT_PROTOCOLS`.
- Kata tests (`*.kata.int.test.ts`) skip locally with one warning when `/dev/kvm` or `pap-vmd` is missing and fail under `CI=1`, like the bwrap tests.
- Secrets (gateway tokens, provider keys, the Claude token) never reach a log, an audit row, a response, a command line or the VM. Logs name agents by id and hosts as the existing `h:<12 hex>` label.
- The only ESLint directive is `eslint-disable-next-line <rule> -- <reason>`. UI uses `packages/ui/src/tokens.css` tokens only; French copy uses vous and carries its accents.
- No literal bidi, zero-width or line-separator characters in source or in this plan (numeric code points only).
- Conventional Commits; rebase on the target branch before a PR; no AI trailer, no Co-Authored-By.

## Review Focus

1. **A session line larger than a frame** (an agent that read a 10 MB screenshot): the mirror assembles it from chunks and the snapshot shows the existing placeholder. Pinned in T9 ("a 12 MiB line arrives in 6 chunks and reads back whole").
2. **A replayed or misdirected hello** (a token after its VM stopped, a second connection for a slot already connected, a worker hello for a slot nobody spawned, a guest hello for another agent's launch): each is refused and logged once. Pinned in T6.
3. **A link the agent planted** (`/agent/home/x -> /agent/.pi/sessions`, `-> /proc/1/environ`): Pi's file tools refuse it by real path, read and write. Pinned in T11.
4. **A crafted relay request** (`/zai/../../etc`, `%2e%2e`, an absolute URL in the request line, `Host: api.z.ai`, a GET, an unknown query): refused before any credential is resolved. Pinned in T12.
5. **pap restarting mid-run**: every VM is stopped at boot, the task is marked interrupted, and a half-written last mirror line is dropped, not kept. Pinned in T7 and T9.

## Lanes and order

- **No KVM needed:** T1 to T12, T14 (image inputs), T17 (migration staging), T18 (doctor, process side), T19, T21. Built and tested here on the process backend.
- **KVM host needed:** T0 (risk checks, controller), then T13, T15, T16, T20 and the Kata halves of T17 and T18. The owner provides the host (nested virtualization on this VM, or another machine).
- Two lanes at most (6-core rule, `flock` on `.superpowers/heavy-gate.lock`): lane A = pi-host side (T4, T5, T9 worker half, T10 worker half, T11, T12); lane B = daemon side (T3, T6, T7, T8, T9 daemon half, T10 daemon half, T14). They join after T12; T13 onward is one lane.

## Proposed model table (owner approves before dispatch)

| Task | Implementer | Reviewer |
|---|---|---|
| T0 risk checks | controller (this session) | owner |
| T1 contracts, T2 frames, T6 gateway, T9 mirror, T11 shell and file rule, T12 relay, T13 pap-vmd, T16 setup and network | Sonnet | **Opus** (security contracts) |
| T3, T4, T5, T7, T8, T10, T14, T15, T17, T18, T19, T20, T21 | Sonnet | Sonnet |
| Plan red-team and plan fix (before dispatch) | Opus | controller |
| Final whole-branch review | Opus | |

No Haiku (decision 73). Opus escalation at fix rounds 4 and 5 only with the owner's explicit OK for this run.

---

### Task T0: Risk checks on a KVM host (controller, before T13)

Runs on the host the owner provides; T1 to T12 do not wait for it. Output: `docs/research/agents-vm-risk-checks.md`, one section per check with the exact commands, versions and results, committed. Every later task that names "T0's record" reads it.

- [ ] **Step 1: Host.** `ls -l /dev/kvm`; `grep -cE 'vmx|svm' /proc/cpuinfo`; kernel version; free RAM and disk.
- [ ] **Step 2: Pin the stack.** Download the latest Kata Containers static release and nerdctl-full release that are at least 14 days old (pap's `minimumReleaseAge` spirit); record version, URL and SHA-256 of each (from the release's own checksum file, verified locally). These values go into T16's `vm-assets.json`.
- [ ] **Step 3: Kata + Cloud Hypervisor with pap's own containerd** (R5): install both archives under a scratch prefix, start containerd on `/run/pap-vm-check/containerd.sock`, run `nerdctl --address … --namespace pap run --rm --runtime io.containerd.kata.v2 debian:trixie-slim uname -a` with the CLH configuration; record the guest kernel version and the cold start time (10 runs, median).
- [ ] **Step 4: Direct-assigned block volume** (spec risk 2): create a 1 GiB sparse ext4 image, attach it the way Kata documents for direct-assigned volumes (`kata-ctl direct-volume add` plus a bind mount on the recorded volume path, or the documented annotation), write a file inside the VM, stop it, start a second VM on the same image, read the file back. Record the exact flags; if it fails, record the working fallback (virtio-blk through the runtime's annotation). Check that the host never mounted it (`findmnt` before and after).
- [ ] **Step 5: Bridge and nftables** (spec §4): create `pap0` (10.213.0.1/24), the CNI conflist of T16, load T16's ruleset, start two VMs; from VM 1: TCP to 10.213.0.1:7841 succeeds (a `nc -l` there), TCP to 10.213.0.1:22 fails, ping to VM 2 fails, `curl https://example.org` fails (no route). Record `nft list ruleset` counters.
- [ ] **Step 6: The shell inside the VM** (R2, spec risk 4): in a trixie VM as root, run bwrap 0.11 with T11's argument list and seccomp file; check `apt-get install -y jq` works in the overlay, `python3 -c 'import socket; socket.socket(40, 1)'` fails with EPERM, `ls /dev/vsock` fails, `ls /agent/.pi` is empty, `cat /proc/1/environ` shows bwrap's init only.
- [ ] **Step 7: GitHub runners** (spec risk 3): a throwaway workflow on a branch (deleted after) prints `ls -l /dev/kvm` and runs Step 3 on `ubuntu-24.04`; record the result. Fallback if no KVM: the owner chooses a self-hosted runner or a nightly job.
- [ ] **Step 8: The Claude token** (spec risk 6): the owner runs `claude setup-token` once and hands the token over the existing vault path; Step 3's VM runs the bridge's `claude -p` through a relay on the bridge with that token. Record success (never the token).
- [ ] **Step 9: OAuth providers** (R9): for each OAuth provider in the owner's `auth.json` (type only, never the value), record whether Pi's request through the relay works with the header rule of T12. A provider that fails stays refused.
- [ ] **Step 10: Commit** `docs/research/agents-vm-risk-checks.md` (`docs(agents-vm): risk checks on a KVM host`). Remove every scratch install, network, rule and image.

### Task T1: Contracts for the VM runtime, and ADR 0078

**Files:**
- Create: `packages/contracts/src/agents-resources.ts`, `packages/contracts/src/agents-vm.ts`, `packages/contracts/src/agents-vm.test.ts`, `packages/contracts/src/vmd.ts`, `packages/contracts/src/vmd.test.ts`, `docs/adr/0078-agents-run-in-microvms.md`
- Modify: `packages/contracts/src/agents.ts` (three fields, at most +6 lines), `packages/contracts/src/pi-host.ts` (unions, at most +1 line; if it would pass 395, first move `WorkerRecord` and `parseWorkerRecord` to a new `pi-host-records.ts` re-exported from `pi-host.ts`), `packages/contracts/src/index.ts` (exports)

**Interfaces:**
- Produces: everything named in the code below; `InitRecord` gains an optional `vm: VmInit` field (in `pi-host-init.ts` or beside `InitRecord`, whichever keeps `pi-host.ts` under 395).

- [ ] **Step 1: Write the failing tests** (`agents-vm.test.ts`, `vmd.test.ts`), key assertions:
  - `AgentInput.parse({ name: "A" })` gives `resources` `{ memoryMb: 1024, cpus: 1, diskMb: 4096 }`, `systemPackages` `[]`, `packages` `null`; an old stored profile without these fields still parses (backward compatible).
  - `SystemPackage` accepts `jq`, `python3`, `g++`, `libc6-dev`; refuses `Jq`, `-x`, `a b`, `a;b`, `$(x)`, a 64-character name; `SystemPackages` refuses duplicates and a 65th entry.
  - `AgentResources` refuses `memoryMb: 511`, `diskMb: 65537`, `cpus: 0`, non-integers, unknown keys.
  - `Hello` accepts a guest hello and a worker hello built from valid parts; refuses a token of 63 or 65 hex characters, upper-case hex, an image tag not matching `IMAGE_TAG`, `protocol: 2`, an unknown key, a worker hello without `slot` or `session`.
  - `SessionAppend` refuses non-base64 `data`, data longer than `SESSION_CHUNK_B64`, a negative offset.
  - `FilePut` refuses names `.x`, `../x`, `a/b`, a name holding code point 0 (build it with `String.fromCharCode(0)`), a 129-character name.
  - `VmdRequest` (vmd.test.ts): every operation parses with valid fields; `agentId` must match the agent id rule; `vm.start` refuses `memoryMb` outside `AgentResources`' bounds, an image tag outside `IMAGE_TAG`, `env` keys other than the four listed, an `addHosts` entry other than `llm.internal` / `claude.internal`; `image.build` refuses an apt name outside `SystemPackage`, a `contextDir` that is not under `$PAP_HOME/vm/build/` spelled absolute; unknown `op` and unknown keys are refused.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/contracts/src/agents-vm.test.ts packages/contracts/src/vmd.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Write the contracts** (security contract, full code). `agents-resources.ts`:

```ts
import { z } from "zod";
import { visibleLine } from "./text.ts"; // the refinement agents.ts uses; import it from wherever agents.ts does

/** Decision 109. Host-dependent ceilings (the memory cap, the host's cores) are checked by the agents service at save. */
export const AgentResources = z
  .object({
    memoryMb: z.number().int().min(512).max(1_048_576).default(1024),
    cpus: z.number().int().min(1).max(256).default(1),
    diskMb: z.number().int().min(1024).max(65_536).default(4096),
  })
  .strict();
export type AgentResources = z.output<typeof AgentResources>;
export const DEFAULT_AGENT_RESOURCES: AgentResources = Object.freeze({ memoryMb: 1024, cpus: 1, diskMb: 4096 });

export const AGENT_VM_LIMITS = Object.freeze({ systemPackages: 64, packages: 64 });

/** A Debian package name (Debian policy 5.6.1), at most 63 characters: it reaches `apt-get install` (R7). */
export const SystemPackage = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,62}$/);
export const SystemPackages = z
  .array(SystemPackage)
  .max(AGENT_VM_LIMITS.systemPackages)
  .refine((names) => new Set(names).size === names.length, "each package once");

/** Package sources exactly as `settings.json` spells them; null: every package of the Pi profile (decision 108, Q4). */
export const PackagePicks = z
  .array(z.string().min(1).max(512).refine(visibleLine, "visible text on one line"))
  .max(AGENT_VM_LIMITS.packages)
  .refine((picks) => new Set(picks).size === picks.length, "each package once")
  .nullable();
```

  `agents.ts` adds to `AgentInput` (after `trustedSources`):

```ts
    resources: AgentResources.default(DEFAULT_AGENT_RESOURCES),
    systemPackages: SystemPackages.default([]),
    packages: PackagePicks.default(null),
```

  `agents-vm.ts`:

```ts
import { z } from "zod";
import { AgentId } from "./agents.ts";
import { AbsolutePath } from "./paths.ts"; // the schema InitRecord uses for paths; import it from where pi-host.ts does

/** Spec §4, decision 107. Fixed in v1; `pap vm setup` writes the same values. */
export const AGENT_NET = Object.freeze({
  network: "pap-agents",
  bridge: "pap0",
  subnet: "10.213.0.0/24",
  host: "10.213.0.1",
  gatewayPort: 7841,
  relayPort: 7842,
});
export const AGENT_VM_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** R1: raw bytes per `session_append`; base64 makes it 4/3 larger and still under a frame. */
export const SESSION_CHUNK_BYTES = 2 * 1024 * 1024;
export const SESSION_CHUNK_B64 = Math.ceil(SESSION_CHUNK_BYTES / 3) * 4;
export const MAX_SESSION_LINE_BYTES = 32 * 1024 * 1024;
export const GATEWAY_PING_MS = 15_000;
export const GATEWAY_PING_MISSES = 3;
export const HELLO_TIMEOUT_MS = 10_000;
export const IMAGE_TAG = /^pap-agent-(base|profile|agent)-[0-9a-f]{64}$/;

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
export const LaunchId = hex(16);
export const SlotId = hex(16);
export const GatewayToken = hex(32);
const Base64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Where things are inside the VM (`/agent/...` under Kata, a temp folder under the process backend). */
export const VmLayout = z
  .object({
    root: AbsolutePath,
    home: AbsolutePath,
    knowledge: AbsolutePath,
    inbox: AbsolutePath,
    pi: AbsolutePath,
    sessions: AbsolutePath,
    piAgentDir: AbsolutePath,
    skills: AbsolutePath,
    shellOverlay: AbsolutePath,
  })
  .strict();
export type VmLayout = z.infer<typeof VmLayout>;

/** The `vm` field of `init` for a worker in a VM. */
export const VmInit = z.object({ layout: VmLayout, bwrap: AbsolutePath }).strict();
export type VmInit = z.infer<typeof VmInit>;

const helloBase = {
  type: z.literal("hello"),
  agentId: AgentId,
  launchId: LaunchId,
  token: GatewayToken,
  protocol: z.literal(AGENT_VM_PROTOCOL),
  imageTag: z.string().regex(IMAGE_TAG),
};
export const GuestHello = z.object({ ...helloBase, role: z.literal("guest") }).strict();
export const WorkerHello = z
  .object({
    ...helloBase,
    role: z.literal("worker"),
    slot: SlotId,
    session: z
      .object({
        lastEntryId: z.string().min(1).max(128).nullable(),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();
export const Hello = z.discriminatedUnion("role", [GuestHello, WorkerHello]);
export type Hello = z.infer<typeof Hello>;

/** Transport-level liveness, handled by both socket ends and never handed to the protocol layer. */
export const TransportPing = z.object({ type: z.literal("ping") }).strict();
export const TransportPong = z.object({ type: z.literal("pong") }).strict();

/** Daemon to guest. */
export const GuestCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spawn"), slot: SlotId, sessionFile: AbsolutePath.nullable() }).strict(),
  z.object({ type: z.literal("signal"), slot: SlotId, signal: z.enum(["SIGTERM", "SIGKILL"]) }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);
export type GuestCommand = z.infer<typeof GuestCommand>;
/** Guest to daemon. */
export const GuestReport = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spawned"), slot: SlotId }).strict(),
  z
    .object({
      type: z.literal("exited"),
      slot: SlotId,
      code: z.number().int().nullable(),
      signal: z.string().max(16).nullable(),
      tail: z.string().max(8192),
    })
    .strict(),
]);
export type GuestReport = z.infer<typeof GuestReport>;

/** Worker to daemon (R1): the bytes Pi wrote from `offset`; `replace` starts the mirror over at offset 0. */
export const SessionAppend = z
  .object({
    type: z.literal("session_append"),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(SESSION_CHUNK_B64).regex(Base64),
    replace: z.boolean(),
  })
  .strict();
export type SessionAppend = z.infer<typeof SessionAppend>;
/** Daemon to worker: send the whole file again (spec §11, the VM's file is the truth). */
export const SessionResync = z.object({ type: z.literal("session_resync") }).strict();
/** Daemon to worker: one attachment into the inbox. `bytes` bounded by the attachment upload limit (base64). */
export const FilePut = z
  .object({
    type: z.literal("file_put"),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    data: z.string().regex(Base64),
  })
  .strict();
export const FilePutResult = z
  .object({
    type: z.literal("file_put_result"),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    ok: z.boolean(),
    code: z.enum(["exists", "too_large", "write_failed"]).optional(),
  })
  .strict();
```

  Add `SessionResync` and `FilePut` to the `DaemonToWorker` union and `SessionAppend` and `FilePutResult` to the worker records (`WorkerRecord`, `parseWorkerRecord`). Bound `FilePut.data` length by `Math.ceil(<the attachment upload limit constant>/3)*4`; find that constant where the attachments upload path declares it (`rg -n "attachment" packages/contracts/src`) and import it, never a second number.

  `vmd.ts` (the whole request surface of pap-vmd, R3, R7, R8):

```ts
import { z } from "zod";
import { AgentId } from "./agents.ts";
import { AgentResources, SystemPackage } from "./agents-resources.ts";
import { GatewayToken, IMAGE_TAG, LaunchId } from "./agents-vm.ts";

const Tag = z.string().regex(IMAGE_TAG);
const Kind = z.enum(["thread", "isolated"]);
/** A VM name pap-vmd derives itself: `pap-<agent id>` or `pap-<agent id>-<task uuid without dashes>`. */
const TaskKey = z.string().regex(/^[0-9a-f]{32}$/);

export const VmdRequest = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("vm.start"),
      agentId: AgentId,
      kind: Kind,
      taskKey: TaskKey.nullable(),
      image: Tag,
      resources: AgentResources,
      launchId: LaunchId,
      token: GatewayToken,
    })
    .strict(),
  z.object({ op: z.literal("vm.stop"), agentId: AgentId, taskKey: TaskKey.nullable() }).strict(),
  z.object({ op: z.literal("vm.pause"), agentId: AgentId }).strict(),
  z.object({ op: z.literal("vm.resume"), agentId: AgentId }).strict(),
  z.object({ op: z.literal("vm.status"), agentId: AgentId, taskKey: TaskKey.nullable() }).strict(),
  z.object({ op: z.literal("vm.list") }).strict(),
  z.object({ op: z.literal("disk.create"), agentId: AgentId, diskMb: AgentResources.shape.diskMb }).strict(),
  z.object({ op: z.literal("disk.grow"), agentId: AgentId, diskMb: AgentResources.shape.diskMb }).strict(),
  z.object({ op: z.literal("disk.delete"), agentId: AgentId, purge: z.boolean() }).strict(),
  z.object({ op: z.literal("disk.populate"), agentId: AgentId, staging: z.literal("migration") }).strict(),
  z
    .object({
      op: z.literal("image.build"),
      layer: z.enum(["base", "profile", "agent"]),
      tag: Tag,
      from: z.union([Tag, z.string().regex(/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/)]),
      aptPackages: z.array(SystemPackage).max(64),
      upgrade: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("image.list") }).strict(),
  z.object({ op: z.literal("image.prune"), keep: z.array(Tag).max(256) }).strict(),
  z.object({ op: z.literal("version") }).strict(),
]);
export type VmdRequest = z.infer<typeof VmdRequest>;

export const VmState = z.enum(["absent", "starting", "running", "paused", "stopped"]);
export const VmdResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["bad_request", "not_found", "conflict", "capacity", "unavailable", "failed"]),
    })
    .strict(),
]);
```

  Notes fixed by this contract: the build context and the migration staging are folders pap-vmd computes itself from fixed names (`$PAP_HOME/vm/build/<layer>/`, `$PAP_HOME/vm/staging/<agentId>/`, the `PAP_HOME` it reads from its own config file written by `pap vm setup`), never a path from the request. `vm.start` carries the token for pap-vmd's env file (R8); it is never logged.
- [ ] **Step 4: ADR 0078** (`docs/adr/0078-agents-run-in-microvms.md`): context (the CyberLooker report, spec §2), decision (spec §3 to §13 and rulings R1 to R9 by reference), consequences (KVM required for agents; root service; ADR 0048's host sandbox kept for `PAP_AGENTS_RUNTIME=host` until sub-project 3), status "accepted, sub-project 1".
- [ ] **Step 5: Run** the two test files and `pnpm --filter @pap/contracts build && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(contracts): agent VM resources, gateway records and the pap-vmd request surface`.

### Task T2: The socket frame codec

**Files:**
- Create: `packages/contracts/src/socket-frames.ts`, `packages/contracts/src/socket-frames.test.ts`

**Interfaces:**
- Produces: `encodeFrame(value: unknown): Buffer` (throws `RangeError` over `MAX_FRAME_BYTES`), `createFrameDecoder(options: { maxBytes: number; onFrame(value: unknown): void; onError(error: "too_large" | "bad_json"): void }): { push(chunk: Buffer): void }`.

- [ ] **Step 1: Failing tests**, key assertions: a frame split across 1-byte chunks decodes once; three frames in one chunk decode in order; a header announcing `maxBytes + 1` calls `onError("too_large")` before any body byte arrives (push only the 4 header bytes) and nothing is delivered afterwards, even valid frames; invalid JSON calls `onError("bad_json")` once and stops; a 4 MiB frame decodes with at most two buffer copies (assert through a spy on `Buffer.concat` call count, at most 2); `encodeFrame` of a value whose JSON is `MAX_FRAME_BYTES + 1` bytes throws.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/contracts/src/socket-frames.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (full code):

```ts
import { MAX_FRAME_BYTES } from "./agents-vm.ts";

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new RangeError("frame too large");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export type FrameError = "too_large" | "bad_json";
export interface FrameDecoder {
  push(chunk: Buffer): void;
}

/**
 * Length-prefixed JSON frames. A declared length over `maxBytes` fails on the header, before any body byte is kept (the
 * receive-side bound Node's IPC never had, R101). After a failure nothing more is delivered; the caller closes the socket.
 */
export function createFrameDecoder(options: {
  readonly maxBytes: number;
  onFrame(value: unknown): void;
  onError(error: FrameError): void;
}): FrameDecoder {
  let parts: Buffer[] = [];
  let size = 0;
  let need = -1;
  let failed = false;
  const fail = (error: FrameError): void => {
    failed = true;
    parts = [];
    size = 0;
    options.onError(error);
  };
  const take = (count: number): Buffer => {
    const all = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, size);
    const rest = all.subarray(count);
    parts = rest.length > 0 ? [rest] : [];
    size = rest.length;
    return all.subarray(0, count);
  };
  return {
    push(chunk) {
      if (failed) return;
      parts.push(chunk);
      size += chunk.length;
      while (!failed) {
        if (need < 0) {
          if (size < 4) return;
          need = take(4).readUInt32BE(0);
          if (need > options.maxBytes) return fail("too_large");
        }
        if (size < need) return;
        const body = take(need);
        need = -1;
        let value: unknown;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch {
          return fail("bad_json");
        }
        options.onFrame(value);
      }
    },
  };
}
```

- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): bounded length-prefixed JSON frames`.

### Task T3: Extract the worker record core from `spawnWorker`

**Files:**
- Create: `apps/daemon/src/kernel/supervisor/worker-core.ts`, `apps/daemon/src/kernel/supervisor/worker-core.test.ts`
- Modify: `apps/daemon/src/kernel/supervisor/worker.ts` (uses the core; ends shorter than 322 lines)

**Interfaces:**
- Produces:

```ts
export interface WorkerCore {
  /** Feed one raw record from any transport. */
  receive(raw: unknown): void;
  request(command: CommandInput, timeoutMs: number | undefined, send: (record: DaemonToWorker) => boolean): Promise<ResponseRecord>;
  onRecord(listener: (record: WorkerRecord) => void): () => void;
  /** Fail every pending request with `worker_failed` (the channel is gone). */
  failPending(): void;
  stats(): WorkerStats;
}
export function createWorkerCore(deps: { clock: Clock; logger: Logger; label: Record<string, unknown> }): WorkerCore;
```

  The core holds what `spawnWorker` does today between `child.on("message")` and the `request` method: `parseWorkerRecord`, the dropped and unknown counters with `worthLogging`, response matching, `boundedRecord`, listener isolation. Log keys stay byte-identical (`worker_record_dropped`, `worker_response_unknown`, `worker_listener_failed`) with `label` spread in place of `{ pid }`.

- [ ] **Step 1: Tests** for the core alone (move the matching cases out of `worker.test.ts` if they exist there): a response resolves its request; an unknown response counts; a listener that throws does not stop the next; a record that does not parse counts and logs on powers of two; `failPending` rejects with `worker_failed`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the core and make `spawnWorker` use it; no behaviour change.
- [ ] **Step 4: Run** `pnpm vitest run --project unit apps/daemon/src/kernel/supervisor` and `pnpm vitest run --project integration apps/daemon/src/kernel/supervisor`. Expected: PASS, the existing worker tests unchanged.
- [ ] **Step 5: Commit** `refactor(daemon): a transport-free worker record core`.

### Task T4: pi-host over a socket

**Files:**
- Create: `packages/pi-host/src/socket-ipc.ts`, `packages/pi-host/src/socket-ipc.test.ts`, `packages/pi-host/src/transport.ts`, `packages/pi-host/src/transport.test.ts`
- Modify: `packages/pi-host/src/main.ts` (choose the transport: at most +6 lines)

**Interfaces:**
- Consumes: T1 `WorkerHello`, `TransportPing/Pong`, `GATEWAY_PING_MS`; T2 codec.
- Produces: `createSocketIpc(socket: net.Socket, hello: WorkerHello): Ipc` (the `Ipc` of `ipc.ts`, same `MAX_RECORD_BYTES` refusal and `response` fallback as `createIpc`); `transportFromEnv(env: NodeJS.ProcessEnv): Promise<Ipc>` in `transport.ts`: with `PAP_WORKER_TRANSPORT=socket` it reads `PAP_GATEWAY` (`host:port`), `PAP_GATEWAY_TOKEN`, `PAP_LAUNCH_ID`, `PAP_AGENT_ID`, `PAP_WORKER_SLOT`, `PAP_IMAGE_TAG`, **deletes all six from `process.env` before returning** (spec §5), connects, sends the hello with `session` from `sessionFacts(path)` (last entry id and size of the file the guest named, `{ lastEntryId: null, size: 0 }` when absent); otherwise it returns `createIpc(process)`.

- [ ] **Step 1: Tests**, key assertions: after `transportFromEnv`, none of the six names is in `process.env`; the first frame on the socket is the hello; a `ping` from the daemon gets a `pong` and never reaches `onMessage`; a frame over `MAX_FRAME_BYTES` from the daemon closes the socket and fires `onDisconnect` once; `send` of a record over `MAX_RECORD_BYTES` returns false and sends the same small `response` failure `createIpc` sends; a malformed record reaches `onMalformed`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts`: `runHost(await transportFromEnv(process.env))`; keep `close-inherited-fds.ts` first; the parent watchdog stays for the IPC transport only (a socket worker's parent is the guest; the guest kills its workers when it dies).
- [ ] **Step 4: Run** the tests and `pnpm vitest run --project unit packages/pi-host/src/ipc.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pi-host): a socket transport for workers in a VM`.

### Task T5: The guest supervisor (`pap-guest`)

**Files:**
- Create: `packages/pi-host/src/guest/main.ts`, `packages/pi-host/src/guest/guest.ts`, `packages/pi-host/src/guest/guest.test.ts`
- Modify: `packages/pi-host/package.json` (export `"./guest"`: `development` `./src/guest/main.ts`, `default` `./dist/guest/main.js`)

**Interfaces:**
- Consumes: T1 `GuestHello`, `GuestCommand`, `GuestReport`; T2 codec.
- Produces: `runGuest(deps: { env: NodeJS.ProcessEnv; connect(address: string): net.Socket; fork(slot: string, env: NodeJS.ProcessEnv, sessionFile: string | null): ChildProcess; clock }): Promise<void>`.
  - Reads and deletes the same six variables as T4 (minus the slot), dials the gateway, sends the guest hello.
  - On `spawn {slot, sessionFile}`: forks the pi-host entry with `PAP_WORKER_TRANSPORT=socket`, the gateway variables, `PAP_WORKER_SLOT=slot` and `PAP_SESSION_FILE` (for the hello's `session` facts), cwd `layout.home`; replies `spawned`. A slot already live is ignored and logged.
  - On `signal`: signals that worker's process group. On `shutdown`: SIGTERM all, then SIGKILL after `WORKER_SHUTDOWN_GRACE_MS` (same value as the daemon's ladder), then exits 0.
  - Keeps an 8 KiB tail of each worker's stdout and stderr and sends `exited {slot, code, signal, tail}`.
  - If the gateway connection closes, it kills every worker and exits 1 (Kata then stops the VM; the daemon sees the guest gone).

- [ ] **Step 1: Tests** (fake `fork` and socket), key assertions: hello first; `spawn` forks once with the slot in the child's env and **no** `PAP_GATEWAY_TOKEN` left in the guest's own `process.env`; `exited` carries the tail; a second `spawn` of a live slot forks nothing; `shutdown` signals every worker then exits; a closed gateway kills workers and exits 1; an unknown command frame is dropped and logged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pi-host): pap-guest, the supervisor inside an agent VM`.

### Task T6: The daemon's gateway, launch tokens and the VM worker handle

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/` with `index.ts`, `tokens.ts`, `tokens.test.ts`, `gateway.ts`, `gateway.test.ts`, `vm-worker.ts`, `vm-worker.test.ts`, `guest-link.ts`
- Test: `apps/daemon/src/modules/agent-vm/gateway.int.test.ts`

**Interfaces:**
- Consumes: T1, T2, T3 `createWorkerCore`.
- Produces:

```ts
export interface LaunchTokens {
  issue(agentId: string): { launchId: string; token: string };
  check(agentId: string, launchId: string, token: string): boolean;
  revoke(launchId: string): void;
}
export interface Gateway {
  /** Listens on `host:port` (the bridge address under Kata, 127.0.0.1:0 under the process backend). */
  listen(host: string, port: number): Promise<{ port: number }>;
  /** Resolves when the guest of this launch has said hello, rejects `timeout` after HELLO_TIMEOUT_MS. */
  awaitGuest(launchId: string): Promise<GuestLink>;
  close(): Promise<void>;
}
/** What a worker's handle needs to keep its session mirror (T9 implements it). */
export interface WorkerSpawnInput {
  readonly sessionFile: string | null;
  /** The mirror's facts: a worker hello that differs gets `session_resync`. */
  facts(): { size: number; lastEntryId: string | null };
  /** One `session_append`; "refused" closes this worker's connection. */
  onSessionAppend(append: SessionAppend): "ok" | "resync" | "refused";
}
export interface GuestLink {
  /** Asks the guest to start a worker; the handle is live once the worker's hello arrives. */
  spawnWorker(input: WorkerSpawnInput): WorkerHandle;
  shutdown(): void;
  readonly closed: Promise<void>;
}
export function createLaunchTokens(): LaunchTokens;
export function createGateway(deps: { tokens: LaunchTokens; clock: Clock; logger: Logger; imageOf(agentId: string): string | null }): Gateway;
```

  `vm-worker.ts` implements `WorkerHandle` (the supervisor's interface) over the worker's socket and the guest link: `send` and `request` through T3's core with `encodeFrame`; `stop()` sends `shutdown` to the worker, then `signal SIGTERM` and `SIGKILL` to the guest on the existing kill-ladder timings; `exited` resolves from the guest's `exited` report or the socket's close (whichever first; `cause` `"signal"` or `"exit"` as `classifyExit` gives); `outputTail()` returns the guest's tail; `pid` is `undefined`.

- [ ] **Step 1: Token tests** (full code below is the contract), key assertions: `check` is true once for an issued pair, false for another agent id, a revoked launch, a token with one changed character, a token of another length; the comparison uses `timingSafeEqual` (spy).

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";

export function createLaunchTokens(): LaunchTokens {
  const live = new Map<string, { agentId: string; token: Buffer }>();
  return {
    issue(agentId) {
      const launchId = randomBytes(16).toString("hex");
      const token = randomBytes(32);
      live.set(launchId, { agentId, token });
      return { launchId, token: token.toString("hex") };
    },
    check(agentId, launchId, token) {
      const entry = live.get(launchId);
      if (!entry || entry.agentId !== agentId) return false;
      const given = Buffer.from(token, "hex");
      return given.length === entry.token.length && timingSafeEqual(given, entry.token);
    },
    revoke(launchId) {
      live.delete(launchId);
    },
  };
}
```

- [ ] **Step 2: Gateway tests** (unit, fake sockets), key assertions (Review Focus 2):
  - the first frame must be a `Hello` that parses; anything else, or nothing within `HELLO_TIMEOUT_MS` (steppable clock), closes and logs `agent_gateway_refused {agentId|null, reason}` with `reason` one of `bad_hello`, `timeout`, `token`, `protocol`, `image`, `slot`, `duplicate`;
  - a valid token for agent A presented with agent B's id is `token`;
  - a revoked launch is `token`;
  - a guest hello for a launch that already has a guest is `duplicate`;
  - a worker hello whose slot was not asked by `spawnWorker` is `slot`; the same slot twice is `duplicate`;
  - `imageTag` different from `imageOf(agentId)` is `image`;
  - no token, no record content and no host appears in any log line (assert the logger's records);
  - pings every `GATEWAY_PING_MS`; three without a pong close the connection and the handle's `exited` resolves.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** `tokens.ts`, `gateway.ts`, `guest-link.ts`, `vm-worker.ts`.
- [ ] **Step 5: Integration test** (`gateway.int.test.ts`): a real `runGuest` (T5) in-process against a real gateway on 127.0.0.1:0, spawning the real pi-host worker entry over the socket (`PAP_TEST_PROVIDER_SCRIPT`), `request({ command: "get_state" })` answers; `stop()` resolves `exited`.
- [ ] **Step 6: Run** unit and int. Expected: PASS.
- [ ] **Step 7: Commit** `feat(daemon): the agent gateway, launch tokens and VM worker handles`.

### Task T7: The `AgentRuntime` port, the process backend and VM lifecycle

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/runtime.ts`, `runtime.test.ts`, `process-backend.ts`, `process-backend.int.test.ts`, `lifecycle.ts`, `lifecycle.test.ts`, `apps/daemon/src/kernel/config-agents-vm.ts`, `config-agents-vm.test.ts`
- Modify: `apps/daemon/src/kernel/config.ts` (compose the new config part: at most +4 lines)

**Interfaces:**
- Produces:

```ts
export type VmPhase = "stopped" | "starting" | "running" | "paused" | "stopping";
export interface VmSpec {
  readonly agentId: string;
  readonly kind: "thread" | "isolated";
  readonly taskKey: string | null;
  readonly image: string;
  readonly resources: AgentResources;
}
export interface AgentRuntimeBackend {
  start(spec: VmSpec, launch: { launchId: string; token: string }): Promise<{ layout: VmLayout }>;
  stop(agentId: string, taskKey: string | null): Promise<void>;
  list(): Promise<Array<{ agentId: string; taskKey: string | null }>>;
}
export interface AgentRuntime {
  /** Starts the agent's VM if needed (one per agent; an isolated task gets its own) and a worker in it. */
  spawn(spec: VmSpec, worker: WorkerSpawnInput): Promise<{ handle: WorkerHandle; layout: VmLayout }>;
  phase(agentId: string): VmPhase;
  stop(agentId: string): Promise<void>;
  /** Boot (spec §8, decision 109 Q4): stop every VM the backend lists. */
  stopAll(): Promise<void>;
}
export function createAgentRuntime(deps: { backend: AgentRuntimeBackend; gateway: Gateway; tokens: LaunchTokens; clock: Clock; logger: Logger; memoryCapMb: number; onCrashPause(agentId: string): void; notifyCapacity(running: string[]): void }): AgentRuntime;
```

  Config (`config-agents-vm.ts`): `PAP_AGENTS_RUNTIME` = `host` (default) | `vm`; `PAP_AGENTS_MEMORY_MAX_MB` (default `floor(totalmem/2)` in MiB, at least 1024; lower stops the boot); `PAP_TEST_AGENT_RUNTIME` = `process` (needs `PAP_TEST_PROVIDER_SCRIPT`, else `ConfigError`).

- [ ] **Step 1: Tests** (`runtime.test.ts`, `lifecycle.test.ts`, fake backend and gateway), key assertions:
  - two `spawn`s for the same agent start one VM and two workers; an isolated spawn starts a second VM keyed by its task;
  - a start whose `resources.memoryMb` plus the running VMs' total exceeds `memoryCapMb` throws `PapError("capacity")` and calls `notifyCapacity` with the running agent ids;
  - the VM stops `PAP_WORKER_IDLE_MINUTES` after its last worker exits (steppable clock), never while a worker lives;
  - a VM that exits with workers alive is a crash: the workers' handles resolve `exited`; 3 crashes within 10 minutes call `onCrashPause` (and the fourth spawn throws `agent_paused`);
  - the token is revoked when the VM stops, crashes or fails to start;
  - `stopAll` stops every listed VM, including ones this daemon never started (Review Focus 5).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `runtime.ts`, `lifecycle.ts`, the config part.
- [ ] **Step 4: Process backend** (`process-backend.ts`): `start` makes a temp root under `$PAP_HOME/tmp/agent-vm/<agent>/` with the layout folders, runs `runGuest` as a child process (`fork` of the guest entry) with the gateway variables, cwd the layout's home; `stop` signals it; `list` returns what it started. Refused unless `PAP_TEST_AGENT_RUNTIME=process`.
- [ ] **Step 5: Integration test** (`process-backend.int.test.ts`): spawn, prompt through the scripted provider, idle stop, crash (kill the guest) then restart on the next spawn.
- [ ] **Step 6: Run.** Expected: PASS.
- [ ] **Step 7: Commit** `feat(daemon): the agent runtime port, its lifecycle and the test process backend`.

### Task T8: Agent sessions launch through the runtime

**Files:**
- Create: `apps/daemon/src/modules/sessions/vm-launch.ts`, `vm-launch.test.ts`, `apps/daemon/src/compose-agents-vm.ts`, `compose-agents-vm.test.ts`, `apps/daemon/src/modules/sessions/vm-launch.int.test.ts`
- Modify: `apps/daemon/src/modules/sessions/service-launch.ts` (one branch at the `deps.spawn` call: at most +6 lines), `apps/daemon/src/modules/sessions/agent-gate.ts` (the VM mode skips the host probe and host sandbox spec: at most +4 lines), `apps/daemon/src/modules/sessions/service-types.ts` (an optional `vmSpawn` dep: +3 lines), `apps/daemon/src/daemon.ts` (call the compose: +3 lines)

**Interfaces:**
- Consumes: T7 `AgentRuntime`, T1 `VmInit`.
- Produces: `vmInitOf(init: InitRecord, layout: VmLayout, bwrap: string): InitRecord` (pure): `cwd` = `layout.home` (a task: `layout.home` of its own VM), `agentDir` = `layout.piAgentDir`, `papHome` = `layout.pi + "/pap"`, `sessionFile` = `layout.sessions + "/" + basename(row.piPath)` when the row has a file, `vm` = `{ layout, bwrap }`, no `sandbox` (the VM's own shell sandbox replaces it, T11), `vault` and `once` unchanged (sub-project 2 decides their future; with no shell network in sub-project 1 they reach no one). `mirrorPathOf(papHome: string, agentId: string, piFileName: string): string` = `$PAP_HOME/agents/<id>/sessions/<name>`.
  - Before writing `vmInitOf`, list every pi-host use of `init.papHome`, `init.agentDir` and `init.cwd` (`rg -n "papHome|agentDir" packages/pi-host/src -g '!*.test.ts'`) and record each in the task report with what the VM value means for it.
- In VM mode a new agent session row gets `piPath = mirrorPathOf(...)` once its Pi file name is known (the same point a draft binds today, `onDraftReady`).

- [ ] **Step 1: Tests**, key assertions: `vmInitOf` never keeps a host path (assert no field starts with the test `PAP_HOME` or `agentDir`); in `PAP_AGENTS_RUNTIME=host` the launch path is byte-for-byte today's (existing tests stay green); in `vm` an agent thread, child and task spawn through the runtime, a plain session still forks; `agentGate` in `vm` mode never calls the bwrap probe.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `vm-launch.ts` and wire `compose-agents-vm.ts` (gateway, tokens, runtime with the process backend under the test switch; the Kata backend arrives in T15).
- [ ] **Step 4: Integration test** (`vm-launch.int.test.ts`, process backend, scripted provider): open CyberLooker-like agent's thread, prompt, read the answer through the session stream, stop; a second open reuses the VM.
- [ ] **Step 5: Run** the touched unit suites and the int test. Expected: PASS.
- [ ] **Step 6: Commit** `feat(daemon): agent sessions launch in their VM under PAP_AGENTS_RUNTIME=vm`.

### Task T9: The transcript mirror (both halves)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/mirror.ts`, `mirror.test.ts`, `mirror-facts.ts`, `mirror-facts.test.ts`, `packages/pi-host/src/session-mirror.ts`, `packages/pi-host/src/session-mirror.test.ts`, `apps/daemon/src/modules/agent-vm/mirror.int.test.ts`
- Modify: `packages/pi-host/src/entry-tracker.ts` (call the mirror after each walk: at most +4 lines), `apps/daemon/src/modules/agent-vm/vm-worker.ts` (route `session_append` to the input's `onSessionAppend`, send `session_resync` when the hello's facts differ from `facts()` or it answers `resync`)

**Interfaces:**
- Consumes: T1 `SessionAppend`, `SessionResync`, `MAX_SESSION_LINE_BYTES`, `SESSION_CHUNK_BYTES`; T6 gateway; T8 `mirrorPathOf`.
- Produces: `openMirror(path: string, logger): Mirror` where `Mirror` provides T6's `facts()` and `onSessionAppend()` (the `WorkerSpawnInput` T8 passes to the runtime); `readMirrorFacts(path: string): { size: number; lastEntryId: string | null }`; worker side `createSessionMirror(deps: { file(): string | null; send(record: SessionAppend): boolean; read(path, offset, length): Buffer })` with `flush()` and `resync()`.

- [ ] **Step 1: Daemon tests** (`mirror.test.ts`), key assertions:
  - chunks applied at the expected offset append complete lines only; a partial last line stays in memory and is never written;
  - a 12 MiB line sent in 6 chunks reads back whole (Review Focus 1); a 33 MiB line is refused `line_too_large` and nothing of it is written;
  - an offset other than the mirror's next byte answers `resync` and writes nothing;
  - `replace: true` at offset 0 truncates and starts over; `replace: true` at another offset is refused `offset`;
  - the first line must be a JSON object with `type: "session"`; any later line must be a JSON object with a string `type` (at most 64) and a string `id` (1 to 128); otherwise `not_entry` / `no_header` / `not_json`, and the mirror refuses everything until a `replace`;
  - the file is created 0600 with `O_NOFOLLOW` in a 0700 folder; a link at the file or folder refuses;
  - after a disconnect with a partial line pending, the file ends with a newline and `readMirrorFacts` gives the last complete entry (Review Focus 5).
- [ ] **Step 2: Implement** `mirror.ts` (security contract, full code of the line check):

```ts
export type MirrorRefusal = "offset" | "line_too_large" | "not_json" | "not_entry" | "no_header";

/** Spec §11, R1: a completed mirror line is a Pi entry, or the mirror stops. Returns the entry id (null for the header). */
export function checkMirrorLine(line: Buffer, first: boolean): { ok: true; id: string | null } | { ok: false; reason: MirrorRefusal } {
  if (line.length > MAX_SESSION_LINE_BYTES) return { ok: false, reason: "line_too_large" };
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "not_entry" };
  const { type, id } = value as { type?: unknown; id?: unknown };
  if (typeof type !== "string" || type.length === 0 || type.length > 64) return { ok: false, reason: "not_entry" };
  if (first) return type === "session" ? { ok: true, id: null } : { ok: false, reason: "no_header" };
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return { ok: false, reason: "not_entry" };
  return { ok: true, id };
}
```

  The pending partial line is bounded by `MAX_SESSION_LINE_BYTES`: once it is longer and still has no newline, the chunk is refused `line_too_large` at once (no waiting for the newline). A refusal logs `agent_mirror_refused {agentId, reason}` and the gateway closes that worker's connection.
- [ ] **Step 3: Worker tests** (`session-mirror.test.ts`), key assertions: after a walk the bytes from the last sent offset are sent in chunks of at most `SESSION_CHUNK_BYTES`, base64; nothing is sent while the file has not grown; `resync()` resends from 0 with `replace: true` on the first chunk only; a file that shrank (Pi rewrote it) triggers the same resync; reading never follows a link (`O_NOFOLLOW`).
- [ ] **Step 4: Implement** `session-mirror.ts`, call it from `entry-tracker.ts` after each walk and once after `ready`.
- [ ] **Step 5: Integration** (`mirror.int.test.ts`, process backend): a run's entries appear in the mirror; `sessions.history` reads them with the VM stopped; deleting the VM's file between runs and restarting makes the next hello mismatch, the worker resends, and the mirror equals the new file.
- [ ] **Step 6: Run** all the above. Expected: PASS.
- [ ] **Step 7: Commit** `feat(agent-vm): the session mirror, fed by the worker and checked line by line`.

### Task T10: Attachments into the agent's inbox

**Files:**
- Create: `packages/pi-host/src/inbox-put.ts`, `inbox-put.test.ts`, `apps/daemon/src/modules/sessions/vm-attachments.ts`, `vm-attachments.test.ts`
- Modify: the prompt path that claims attachments for a session (find it with `rg -n "claim" apps/daemon/src/modules/sessions -g '!*.test.ts'`; at most +6 lines), `packages/pi-host/src/dispatch.ts` (handle `file_put`: at most +3 lines)

**Interfaces:**
- Produces: daemon `putAttachments(handle: WorkerHandle, files: Array<{ name: string; bytes: Buffer }>): Promise<string[]>` (VM paths, in order); worker `writeInboxFile(inbox: string, name: string, bytes: Buffer): "ok" | "exists" | "too_large" | "write_failed"`.
- For a VM agent, the prompt refers to `layout.inbox/<name>` instead of the host attachment path; images keep going through the existing prompt-image path with the VM path.

- [ ] **Step 1: Tests**, key assertions: the worker writes with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0644, only directly under the inbox; an existing name answers `exists` and the daemon retries once with a `-<4 hex>` suffix; a name the schema refuses never reaches the worker; a file over the attachment limit is refused by the daemon before sending.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): attachments copied into the agent's inbox`.

### Task T11: The shell sandbox inside the VM and the VM file rule

**Files:**
- Create: `packages/contracts/src/sandbox-vm.ts`, `sandbox-vm.test.ts`, `packages/contracts/src/seccomp.ts`, `seccomp.test.ts`, `packages/pi-host/src/policy/vm-paths.ts`, `vm-paths.test.ts`
- Modify: `packages/pi-host/src/sandbox-ops.ts` (a VM branch: spawn with the VM argv and the filter on fd 3; at most +12 lines; split the file first if it would pass 395), the stage that applies the agent path rule today (`rg -n "readsInside" packages/pi-host/src/policy`; the VM rule replaces it when `init.vm` is present; at most +6 lines)

**Interfaces:**
- Produces: `bwrapVmArgv(spec: { bwrap: string; layout: VmLayout }, command: string, seccompFd: number): string[]`; `shellSeccompProgram(): Insn[]`, `encodeSeccomp(program): Buffer`; `judgeVmPath(raw, cwd, roots, write, real?)`, `vmFileRoots(layout): VmFileRoots`.

- [ ] **Step 1: Tests**, key assertions:
  - `bwrapVmArgv`: contains `--unshare-net`, `--unshare-pid`, `--cap-drop ALL` and exactly the seven `--cap-add` of R2; never `--unshare-user`, `--bind / /`, `--dev-bind`, `/dev/vsock`, `layout.pi` or `layout.root` as a bind source; binds exactly home, knowledge, inbox; `--seccomp` names the given fd; the command is the last argument after `--`.
  - seccomp, with a 30-line BPF interpreter in the test (`run(program, { arch, nr, arg0 })`): x86_64 `socket(40, …)` gives EPERM; `socket(2, …)` and `socket(1, …)` allow; each denied syscall gives EPERM; `read` (0) allows; arch `0xc00000b7` (aarch64) kills; `nr = 0x40000000 + 41` (x32) kills; every jump stays inside the program; the encoded buffer is `8 × length` bytes.
  - `judgeVmPath` (Review Focus 3): read and write allowed under home, knowledge, inbox; read allowed under skills, write refused there; `/agent/.pi/x`, `/proc/1/environ`, `/sys`, `/dev/vsock`, `/etc/passwd` refused; a link `home/x -> /agent/.pi/sessions` refused for read and write; a link `home/y -> home/z` allowed; a new file under home whose parent exists is allowed; a `..` path that resolves outside is refused.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (security contract, full code). `sandbox-vm.ts`:

```ts
import type { VmLayout } from "./agents-vm.ts";

/** R2: what the agent's shell keeps. No CAP_SYS_ADMIN, CAP_SYS_CHROOT, CAP_MKNOD, CAP_SYS_PTRACE or CAP_SYS_MODULE. */
export const VM_SHELL_CAPS = [
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_FSETID",
  "CAP_SETUID",
  "CAP_SETGID",
  "CAP_KILL",
] as const;

/** The shell of an agent in its VM (spec §5, R2). The overlay keeps `apt install` until the VM stops; `.pi` is never bound. */
export function bwrapVmArgv(spec: { readonly bwrap: string; readonly layout: VmLayout }, command: string, seccompFd: number): string[] {
  const { layout } = spec;
  return [
    spec.bwrap,
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    ...VM_SHELL_CAPS.flatMap((cap) => ["--cap-add", cap]),
    "--overlay-src",
    "/",
    "--overlay",
    `${layout.shellOverlay}/upper`,
    `${layout.shellOverlay}/work`,
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--tmpfs",
    layout.root,
    ...[layout.home, layout.knowledge, layout.inbox].flatMap((dir) => ["--bind", dir, dir]),
    "--seccomp",
    String(seccompFd),
    "--chdir",
    layout.home,
    "--",
    "/bin/sh",
    "-c",
    command,
  ];
}
```

  `seccomp.ts`:

```ts
/** Classic BPF for seccomp (linux/filter.h, linux/seccomp.h). x86_64 only in v1: any other arch is killed. */
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const RET_K = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_EPERM = 0x00050000 | 1;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
const AF_VSOCK = 40;
const SOCKET = 41;
/** Spec §5: x86_64 numbers (arch/x86/entry/syscalls/syscall_64.tbl); io_uring can open sockets past this filter. */
export const DENIED_SYSCALLS = Object.freeze({
  ptrace: 101,
  init_module: 175,
  delete_module: 176,
  kexec_load: 246,
  add_key: 248,
  request_key: 249,
  keyctl: 250,
  perf_event_open: 298,
  finit_module: 313,
  kexec_file_load: 320,
  bpf: 321,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
});
export type Insn = readonly [code: number, jt: number, jf: number, k: number];

export function shellSeccompProgram(): Insn[] {
  const denied = Object.values(DENIED_SYSCALLS);
  const n = denied.length;
  const allow = 9 + n;
  const eperm = 10 + n;
  const program: Insn[] = [
    [LD_W_ABS, 0, 0, 4], // seccomp_data.arch
    [JEQ_K, 1, 0, AUDIT_ARCH_X86_64],
    [RET_K, 0, 0, RET_KILL_PROCESS],
    [LD_W_ABS, 0, 0, 0], // seccomp_data.nr
    [JGE_K, 0, 1, X32_SYSCALL_BIT],
    [RET_K, 0, 0, RET_KILL_PROCESS],
  ];
  denied.forEach((nr, i) => program.push([JEQ_K, eperm - (6 + i) - 1, 0, nr]));
  program.push([JEQ_K, 0, allow - (6 + n) - 1, SOCKET]);
  program.push([LD_W_ABS, 0, 0, 16]); // low 32 bits of seccomp_data.args[0], little-endian
  program.push([JEQ_K, eperm - (8 + n) - 1, allow - (8 + n) - 1, AF_VSOCK]);
  program.push([RET_K, 0, 0, RET_ALLOW]);
  program.push([RET_K, 0, 0, RET_EPERM]);
  return program;
}

export function encodeSeccomp(program: readonly Insn[]): Buffer {
  const out = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    out.writeUInt16LE(code, i * 8);
    out.writeUInt8(jt, i * 8 + 2);
    out.writeUInt8(jf, i * 8 + 3);
    out.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return out;
}
```

  `vm-paths.ts`:

```ts
import { realpathSync } from "node:fs";
import path from "node:path";
import type { VmLayout } from "@pap/contracts";

export interface VmFileRoots {
  readonly writable: readonly string[];
  readonly readOnly: readonly string[];
}
export type VmPathVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const vmFileRoots = (layout: VmLayout): VmFileRoots => ({
  writable: [layout.home, layout.knowledge, layout.inbox],
  readOnly: [layout.skills],
});

const inside = (target: string, root: string): boolean => target === root || target.startsWith(`${root}/`);

/** The real path of `p`, or of its nearest existing parent joined with the rest (a file about to be made). */
export function realpathOrParent(p: string): string | null {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Spec §5: Pi's file tools in a VM agent stay in the agent's folders. The real path decides, so a link the agent made cannot
 * point them at `.pi` (the transcript the owner reads), `/proc`, `/sys` or `/dev`. Roots are given as real paths.
 */
export function judgeVmPath(
  raw: string,
  cwd: string,
  roots: VmFileRoots,
  write: boolean,
  real: (p: string) => string | null = realpathOrParent,
): VmPathVerdict {
  const target = real(path.resolve(cwd, raw));
  if (target === null) return { ok: false, reason: "unreadable path" };
  if (roots.writable.some((root) => inside(target, root))) return { ok: true };
  if (!write && roots.readOnly.some((root) => inside(target, root))) return { ok: true };
  return { ok: false, reason: "outside this agent's folders" };
}
```

  The existing same-message rule (W5-R11: a path tool and an allowed shell call in one assistant message) applies unchanged to VM agents.
- [ ] **Step 4: Wire** `sandbox-ops.ts`: with `init.vm`, spawn `bwrapVmArgv(...)` with `stdio: ["ignore", "pipe", "pipe", "pipe"]`, write `encodeSeccomp(shellSeccompProgram())` to `child.stdio[3]` and end it; create `${layout.shellOverlay}/upper` and `/work` once (0700) at worker start; no egress socket (sub-project 2).
- [ ] **Step 5: Run** the three test files and `pnpm vitest run --project unit packages/pi-host/src/policy packages/pi-host/src/sandbox-ops.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(agent-vm): the VM shell sandbox, its seccomp filter and the VM file rule`.

### Task T12: The provider relay (`pap-relay`) and the owner's Claude token

**Files:**
- Create: `packages/pi-host/src/relay/main.ts`, `relay.ts`, `routes.ts`, `routes.test.ts`, `headers.ts`, `headers.test.ts`, `credentials.ts`, `credentials.test.ts`, `relay.int.test.ts`; `apps/daemon/src/modules/agent-vm/relay-link.ts`, `relay-link.test.ts`; `packages/contracts/src/agents-vm-methods.ts`
- Modify: `packages/pi-host/package.json` (export `"./relay"`), `packages/pi-host/src/helper/ops/models-usage.ts` (move its credential resolution into `relay/credentials.ts` and import it back: the file shrinks), `packages/contracts/src/methods.ts` (register the new method: at most +2 lines), `apps/daemon/src/compose-agents-vm.ts`

**Interfaces:**
- Produces: `routeOf(method, host, url): RelayRoute | null`, `pathAllowed(api, path): boolean`, `upstreamHeaders(api, incoming, credential): Record<string, string>`, `resolveProvider(provider): Promise<{ api: ApiKind; baseUrl: string; credential: { value: string; headers: Record<string, string> } } | null>` (60 s cache, API-key credentials only, R9; `https:` base URLs only, loopback `http:` only when `PAP_TEST_PROVIDER_SCRIPT` is set); method `agents.vm.setClaudeToken { token }` (`agents:admin`, browser only, `sensitiveParams: ["token"]`, password step-up, stored in the vault under the owner scope; the daemon hands it to the relay over IPC, never env).
- The relay is forked by the daemon when `PAP_AGENTS_RUNTIME=vm`, listens on `AGENT_NET.host:relayPort` (Kata) or 127.0.0.1:0 (process backend; the port is passed to the VM layout), receives `{ type: "claude_token", token }` and `{ type: "vm_addresses", map }` (VM IP to agent id, for logs) over IPC.

- [ ] **Step 1: Tests** (Review Focus 4), key assertions:
  - `routeOf("POST", "llm.internal", "/zai/chat/completions")` is `{ kind: "provider", provider: "zai", path: "/chat/completions", query: "" }`; `"claude.internal"` with `/v1/messages?beta=true` is a claude route;
  - refused (null): any method but POST; Host `api.z.ai`, `llm.internal.evil`, missing; `/zai/../../etc/passwd`; `/zai/%2e%2e/x`; `http://api.z.ai/chat/completions` as the request target; `//zai/x`; a backslash; an unknown query (`?redirect=x`); an empty provider; `claude.internal` with `/v1/complete`;
  - `pathAllowed("openai-completions", "/chat/completions")` true, `"/models"` false; an api not in the table false;
  - `upstreamHeaders` forwards only `content-type`, `accept`, `accept-encoding`, `anthropic-version`, `anthropic-beta`, `openai-beta`, `user-agent` and `x-stainless-*`; drops `authorization`, `x-api-key`, `cookie`, `host`, `x-forwarded-for`, `proxy-authorization`; sets the credential per api (`x-api-key` for anthropic, `x-goog-api-key` for google, `authorization: Bearer` otherwise, `authorization: Bearer` for claude);
  - `resolveProvider` refuses an OAuth credential (R9), an `http:` base URL, a provider outside the owner's enabled models;
  - integration (`relay.int.test.ts`, a loopback fake upstream with a self-signed CA trusted only by the test): a VM-side request with a placeholder `x-api-key` reaches the upstream with the real key and without the placeholder; the streamed answer comes back unchanged; a refused request never calls `resolveProvider` (spy); no key, no token and no path appear in the relay's log lines.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (security contract, full code of the route table):

```ts
export type ApiKind = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
export const RELAY_HOSTS = Object.freeze({ llm: "llm.internal", claude: "claude.internal" });

const PATHS: Readonly<Record<ApiKind, readonly RegExp[]>> = {
  "anthropic-messages": [/^\/v1\/messages$/, /^\/v1\/messages\/count_tokens$/],
  "openai-completions": [/^\/chat\/completions$/],
  "openai-responses": [/^\/responses$/],
  "google-generative-ai": [/^\/models\/[A-Za-z0-9._-]{1,128}:(?:streamGenerateContent|generateContent|countTokens)$/],
};
const QUERIES = new Set(["", "?beta=true", "?alt=sse"]);
const SAFE_PATH = /^\/[A-Za-z0-9._~:-]+(?:\/[A-Za-z0-9._~:-]+)*$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type RelayRoute =
  | { readonly kind: "provider"; readonly provider: string; readonly path: string; readonly query: string }
  | { readonly kind: "claude"; readonly path: string; readonly query: string };

/** Spec §9: what a VM may ask, judged on the request line and Host before any credential is looked at. */
export function routeOf(method: string | undefined, host: string | undefined, url: string | undefined): RelayRoute | null {
  if (method !== "POST" || host === undefined || url === undefined) return null;
  const name = host.toLowerCase().replace(/:\d{1,5}$/, "");
  const cut = url.indexOf("?");
  const pathPart = cut < 0 ? url : url.slice(0, cut);
  const query = cut < 0 ? "" : url.slice(cut);
  if (!QUERIES.has(query) || !SAFE_PATH.test(pathPart)) return null;
  const segments = pathPart.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (name === RELAY_HOSTS.claude) {
    return PATHS["anthropic-messages"].some((re) => re.test(pathPart)) ? { kind: "claude", path: pathPart, query } : null;
  }
  if (name !== RELAY_HOSTS.llm) return null;
  const [provider, ...rest] = segments;
  if (provider === undefined || !PROVIDER.test(provider) || rest.length === 0) return null;
  return { kind: "provider", provider, path: `/${rest.join("/")}`, query };
}

export function pathAllowed(api: string, path: string): boolean {
  const patterns = (PATHS as Readonly<Record<string, readonly RegExp[] | undefined>>)[api];
  return patterns !== undefined && patterns.some((re) => re.test(path));
}
```

  The upstream URL is `baseUrl` without its trailing slash, plus `path`, plus `query`; the request has no redirect following, a 32 MiB body cap and a 5-minute idle timeout; the answer is piped back as it streams. The bridge's route forwards to `https://api.anthropic.com` with the owner's token; without a token it answers 503 and the agent form says why (T19).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): the provider relay and the owner's Claude token`.

### Task T13: `pap-vmd` (on the KVM host, after T0)

**Files:**
- Create: `apps/vmd/package.json`, `apps/vmd/tsconfig.json`, `apps/vmd/tsconfig.build.json`, `apps/vmd/src/main.ts`, `server.ts`, `server.test.ts`, `state.ts`, `state.test.ts`, `safe-tree.ts`, `safe-tree.test.ts`, `argv.ts`, `argv.test.ts`, `dockerfile.ts`, `dockerfile.test.ts`, `ops.ts`, `ops.test.ts`, `apps/vmd/src/vmd.kata.int.test.ts`
- Modify: `pnpm-workspace.yaml` (the new app), `knip` config if it needs the entry

**Interfaces:**
- Consumes: T1 `VmdRequest`, `VmdResponse`, `AGENT_NET`; T2 codec; T0's record (runtime name, direct-volume flags, containerd and BuildKit socket paths).
- Produces: a unix socket server at `/run/pap-vm/vmd.sock` answering one `VmdRequest` per connection with one `VmdResponse`; config `/etc/pap-vm/config.json` `{ papUid, papGid, papHome }` written by T16.
- `state.ts`: the state root `/var/lib/pap-vm/<papUid>/` (0700 root), disks `agents/<id>/disk.img`, trash `trash/<id>-<stamp>/`, env files `run/<launchId>.env` (0600, deleted after `nerdctl run` returns), copies `build/<layer>/` and `staging/<id>/` made by `safe-tree.ts`.
- `safe-tree.ts` (security contract, full code): copies a tree owned by the pap user into a root-owned folder without ever following a link, by opening each entry relative to its parent's descriptor (`/proc/self/fd/<dirFd>/<name>` with `O_NOFOLLOW`):

```ts
import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import path from "node:path";

export interface SafeTreeLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}
export type SafeTreeError = "link" | "special" | "owner" | "too_large" | "too_many" | "missing";

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
const at = (dirFd: number, name: string): string => `/proc/self/fd/${dirFd}/${name}`;

/**
 * R3, R7: pap-vmd reads folders pap's user can change while it reads. Every entry is opened relative to its parent's descriptor
 * with O_NOFOLLOW, so a link swapped in at any level is refused instead of followed. Only directories and regular files owned by
 * `uid` are copied; everything else stops the copy.
 */
export function copyTreeSafely(source: string, target: string, uid: number, limits: SafeTreeLimits): SafeTreeError | null {
  let rootFd: number;
  try {
    rootFd = openSync(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "link";
  }
  const totals = { bytes: 0, entries: 0 };
  try {
    return copyDir(rootFd, target, uid, limits, totals);
  } finally {
    closeSync(rootFd);
  }
}

function copyDir(dirFd: number, target: string, uid: number, limits: SafeTreeLimits, totals: { bytes: number; entries: number }): SafeTreeError | null {
  const stat = fstatSync(dirFd);
  if (stat.uid !== uid) return "owner";
  mkdirSync(target, { mode: 0o700 });
  for (const name of readdirSync(`/proc/self/fd/${dirFd}`)) {
    if (++totals.entries > limits.maxEntries) return "too_many";
    let fd: number;
    try {
      // O_NONBLOCK: opening a FIFO must not wait for a writer; it is refused below as `special`.
      fd = openSync(at(dirFd, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ELOOP" ? "link" : "special";
    }
    try {
      const entry = fstatSync(fd);
      if (entry.uid !== uid) return "owner";
      if (entry.isDirectory()) {
        const failed = copyDir(fd, path.join(target, name), uid, limits, totals);
        if (failed) return failed;
      } else if (entry.isFile()) {
        totals.bytes += entry.size;
        if (totals.bytes > limits.maxBytes) return "too_large";
        copyFileSync(`/proc/self/fd/${fd}`, path.join(target, name), constants.COPYFILE_EXCL);
      } else {
        return "special";
      }
    } finally {
      closeSync(fd);
    }
  }
  return null;
}
```

  The test pins that a FIFO answers `special` without blocking.
- Types: `VmStartRequest = Extract<VmdRequest, { op: "vm.start" }>`, `ImageBuildRequest = Extract<VmdRequest, { op: "image.build" }>` (in `apps/vmd/src/ops.ts`).
- `argv.ts` (security contract): every command is built from validated fields and fixed paths, never a shell string; `execFile` with `shell: false`. The `nerdctl run` builder:

```ts
const NERDCTL = "/opt/pap-vm/bin/nerdctl";
const BASE = ["--address", "/run/pap-vm/containerd.sock", "--namespace", "pap"];

export const vmName = (agentId: string, taskKey: string | null): string =>
  taskKey === null ? `pap-${agentId}` : `pap-${agentId}-${taskKey}`;

/** `volume`: the direct-assigned volume path or flags T0 recorded; `envFile`: R8. */
export function runArgv(request: VmStartRequest, envFile: string, volume: readonly string[], runtime: string): string[] {
  return [
    NERDCTL,
    ...BASE,
    "run",
    "--detach",
    "--name",
    vmName(request.agentId, request.taskKey),
    "--runtime",
    runtime,
    "--network",
    AGENT_NET.network,
    "--cpus",
    String(request.resources.cpus),
    "--memory",
    `${request.resources.memoryMb}m`,
    "--add-host",
    `llm.internal:${AGENT_NET.host}`,
    "--add-host",
    `claude.internal:${AGENT_NET.host}`,
    "--env-file",
    envFile,
    "--read-only",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/tmp",
    ...volume,
    request.image,
  ];
}
```

  The env file holds exactly `PAP_GATEWAY`, `PAP_GATEWAY_TOKEN`, `PAP_LAUNCH_ID`, `PAP_AGENT_ID`, `PAP_IMAGE_TAG`, one per line, from schema-checked values (no newline can enter).
- `dockerfile.ts` (R7, full code):

```ts
const BASE_PACKAGES = ["bubblewrap", "git", "curl", "jq", "python3", "ripgrep", "fd-find", "ca-certificates"] as const;
const apt = (names: readonly string[], upgrade: boolean): string =>
  `RUN apt-get update && ${upgrade ? "apt-get -y upgrade && " : ""}apt-get install -y --no-install-recommends ${names.join(" ")} && rm -rf /var/lib/apt/lists/*`;

/** Rendered by pap-vmd from a checked `image.build`: the daemon never sends Dockerfile text. */
export function renderDockerfile(request: ImageBuildRequest): string {
  const lines = [`FROM ${request.from}`, "ENV DEBIAN_FRONTEND=noninteractive"];
  if (request.layer === "base") {
    lines.push(apt(BASE_PACKAGES, request.upgrade));
    lines.push("COPY pap/ /opt/pap/");
    lines.push("ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    lines.push('ENTRYPOINT ["/usr/local/bin/node", "/opt/pap/pi-host/dist/guest/main.js"]');
  } else if (request.layer === "profile") {
    lines.push("COPY pi-agent/ /opt/pap/pi-agent/");
  } else if (request.aptPackages.length > 0) {
    lines.push(apt(request.aptPackages, false));
  }
  lines.push(`LABEL org.pap.layer=${request.layer}`);
  return `${lines.join("\n")}\n`;
}
```

  The base `from` is the official Node image for the host's Node version on trixie, pinned by digest in `vm-assets.json` (T16), which T1's `from` regex already names.
- [ ] **Step 1: Tests** (fake `exec`, a temp state root), key assertions: every op's argv equals a fixed expected array; no argv element contains the token; the env file is 0600 and gone after `vm.start` resolves or fails; `disk.create` makes a sparse file of `diskMb` MiB and runs `mkfs.ext4 -q -F` on it; `disk.grow` refuses a smaller size (`bad_request`) and runs `e2fsck -fy` then `resize2fs`; `disk.delete` moves to trash, `purge: true` removes; `copyTreeSafely` refuses a link at the top, a link three levels down, a FIFO, a file of another uid, the 200 001st entry, the byte past the cap; `renderDockerfile` of each layer equals a fixed text; a request that fails the schema answers `bad_request` without running anything; the server answers one request per connection and closes.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Kata test** (`vmd.kata.int.test.ts`, skips without KVM, fails under `CI=1`): through a real pap-vmd started by the test as root (CI only): create a disk, start a VM from a tiny test image, status `running`, stop, delete.
- [ ] **Step 6: Commit** `feat(vmd): pap-vmd, the root service that runs agent VMs`.

### Task T14: Image inputs, the agent bundle and the rebuild policy

**Files:**
- Create: `scripts/build-agent-bundle.ts`, `scripts/build-agent-bundle.test.ts`, `apps/daemon/src/modules/agent-vm/image-inputs.ts`, `image-inputs.test.ts`, `profile-allowlist.ts`, `profile-allowlist.test.ts`, `adapters.ts`, `adapters.test.ts`, `image-policy.ts`, `image-policy.test.ts`
- Modify: root `package.json` (`build` runs the bundle step after `pnpm -r run build`), `scripts/build-archive.ts` and `scripts/build-npm.ts` (ship `packages/pi-host/dist-agent/`), `.gitignore`

**Interfaces:**
- Produces: `dist-agent/` = pi-host's `dist` plus a flat production `node_modules` (`pnpm --filter @pap/pi-host deploy --prod --config.node-linker=hoisted`), with no symbolic link anywhere (T13's copy refuses links); `prepareProfileContext(agentDir: string, out: string): { tag: string; skipped: string[] }`; `prepareBaseContext(bundle: string, out: string, nodeDigest: string, week: number): { tag }`; `agentLayerTag(profileTag, systemPackages): string`; `imagePolicy` deciding `use | build-then-use | refuse` per spec §6.
- The profile allowlist (security contract): `settings.json` is read with pap's existing bounded JSON reader and rewritten with only `compaction`, `defaultThinkingLevel`, `modelThinkingLevels`, `enabledModels`, `defaultProvider`, `defaultModel`, `packages` (and `skills` entries that point inside copied folders); each npm package is copied from `<agentDir>/npm/node_modules/<name>` at the version `settings.json` pins, each git package from `<agentDir>/git/...`, each local path package from its resolved folder; `<agentDir>/skills` is copied; providers get `baseUrl: "http://llm.internal/<provider>"` and `apiKey: "pap-placeholder"` in a generated `models.json`. Adapters: pi-claude-bridge's config sets `ANTHROPIC_BASE_URL=http://claude.internal` and `ANTHROPIC_AUTH_TOKEN=pap-placeholder`; pi-web-access gets a config with placeholder keys; pi-mcp-adapter keeps stdio servers whose command is a binary inside a copied package and drops the others (reported in `skipped`).

- [ ] **Step 1: Tests**, key assertions: the bundle has no link (walk with `lstat`) and holds `dist/guest/main.js`; a scratch agent dir containing `auth.json`, `sessions/`, `mem0/`, `pi-web-session-index.json`, a `.credentials.json`, an `.env` and an unknown `foo.json` produces a context where none of them exists (scan the output: no file named like them, and no file content containing a marker string planted in each); the same inputs give the same tag twice; changing one package version changes the profile tag and not the base tag; `imagePolicy` answers `build-then-use` (old tag kept running) when the profile changed, `refuse` when the running image's protocol differs from `AGENT_VM_PROTOCOL`, and schedules a base rebuild once per ISO week (steppable clock).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): image inputs by allowlist, the agent bundle and the rebuild policy`.

### Task T15: The Kata backend (KVM host)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/vmd-client.ts`, `vmd-client.test.ts`, `kata-backend.ts`, `kata-backend.test.ts`, `kata-backend.kata.int.test.ts`
- Modify: `apps/daemon/src/compose-agents-vm.ts` (Kata backend outside tests), `apps/daemon/src/modules/agents/` delete and quarantine steps (find them with `rg -n "QUARANTINE_STEPS|agent_delete_incomplete" apps/daemon/src/modules/agents`; each step +1 line in new step files)

**Interfaces:**
- Consumes: T7 `AgentRuntimeBackend`, T13 requests, T14 tags.
- Produces: `createKataBackend(deps: { client: VmdClient; images: ImagePolicy; logger }): AgentRuntimeBackend`; Kata layout `{ root: "/agent", home: "/agent/home", knowledge: "/agent/knowledge", inbox: "/agent/inbox", pi: "/agent/.pi", sessions: "/agent/.pi/sessions", piAgentDir: "/opt/pap/pi-agent", skills: "/opt/pap/pi-agent/skills", shellOverlay: "/run/pap-shell" }`.
- Agent delete adds a step `vm` (stop, `disk.delete` to trash); quarantine adds `vm` (stop, revoke, keep the disk); an isolated task's VM gets a blank disk (`disk.create` under its task key) deleted at its end.

- [ ] **Step 1: Tests** (fake client), key assertions: a first start creates the disk, builds missing images, then starts; a stop revokes the token; delete leaves the disk in trash and the agent row gone; quarantine keeps the disk; an isolated task's disk is deleted after its VM stops, even when the task failed.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Kata test**: a full agent thread on the real stack with the scripted provider: open, prompt, answer, idle stop, reopen reads history without starting the VM (the VM stays `stopped` while `sessions.history` answers).
- [ ] **Step 6: Commit** `feat(agent-vm): the Kata backend through pap-vmd`.

### Task T16: `pap vm setup | uninstall`, the network and the pinned stack (KVM host)

**Files:**
- Create: `apps/daemon/src/cli/vm/setup.ts`, `setup.test.ts`, `uninstall.ts`, `uninstall.test.ts`, `assets.ts`, `vm-assets.json`, `assets.test.ts`, `network.ts`, `network.test.ts`, `units.ts`, `units.test.ts`
- Modify: `apps/daemon/src/cli/run-cli.ts` (two commands), `docs/agents/install.md`

**Interfaces:**
- Produces: `pap vm setup` (root only, else exit 1 with "run with sudo"): downloads the two archives and the Node image digest named in `vm-assets.json` (values from T0's record), checks SHA-256, installs under `/opt/pap-vm/`, copies pap-vmd's bundle and the Node binary there (R6, root-owned 0755), writes `/etc/pap-vm/config.json`, the units `pap-vm-containerd.service`, `pap-vm-buildkit.service`, `pap-vmd.service` (R5: their own sockets under `/run/pap-vm/`), the CNI conflist, the `pap` group (adds the invoking `SUDO_USER`), the bridge (`pap0`, `10.213.0.1/24`, made by `pap-vmd.service`'s `ExecStartPre`) and the ruleset; idempotent; `pap vm uninstall` reverts all of it and leaves `/var/lib/pap-vm` unless `--purge`.
- `network.ts` (security contract, full code):

```ts
import { AGENT_NET } from "@pap/contracts";

/** Spec §4, decision 107 Q4: a VM reaches the gateway and the relay on the bridge address, nothing else; VM to VM is dropped. */
export function agentNetRuleset(net = AGENT_NET): string {
  return `${[
    "table inet pap_agents",
    "delete table inet pap_agents",
    "table inet pap_agents {",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    `    iifname "${net.bridge}" ip daddr ${net.host} tcp dport { ${net.gatewayPort}, ${net.relayPort} } accept`,
    `    iifname "${net.bridge}" counter drop`,
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    iifname "${net.bridge}" counter drop`,
    `    oifname "${net.bridge}" counter drop`,
    "  }",
    "}",
    "table bridge pap_agents",
    "delete table bridge pap_agents",
    "table bridge pap_agents {",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    meta ibrname "${net.bridge}" counter drop`,
    "  }",
    "}",
  ].join("\n")}\n`;
}

export function cniConflist(net = AGENT_NET): string {
  return JSON.stringify(
    {
      cniVersion: "1.0.0",
      name: net.network,
      plugins: [
        {
          type: "bridge",
          bridge: net.bridge,
          isGateway: true,
          ipMasq: false,
          hairpinMode: false,
          ipam: { type: "host-local", ranges: [[{ subnet: net.subnet, gateway: net.host }]], routes: [] },
        },
      ],
    },
    null,
    2,
  );
}
```

- [ ] **Step 1: Tests** (fake fs, exec and downloader; no network), key assertions: a SHA-256 mismatch stops before anything is installed; a second run changes nothing (every write compares first); the unit files' `ExecStart` point under `/opt/pap-vm/` only; `pap-vmd.service` runs as root with `ProtectHome=read-only`, `PrivateTmp=yes`, `NoNewPrivileges=yes`; the socket folder is `root:pap 0750` and the socket 0660; the ruleset text equals the fixed expectation; the conflist has `routes: []` and `ipMasq: false`; `vm-assets.json` entries match `{ version, url: https://github.com/..., sha256: 64 hex }`; uninstall removes exactly what setup wrote.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: On the KVM host**, run `sudo pap vm setup` twice, then T0 Step 5's reachability checks with the installed stack; `sudo pap vm uninstall` leaves no unit, rule, bridge or socket.
- [ ] **Step 6: Commit** `feat(cli): pap vm setup and uninstall, with pap's own container stack and agent network`.

### Task T17: Migration of existing agents

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/migration.ts`, `migration.test.ts`, `migration.kata.int.test.ts`

**Interfaces:**
- Produces: `stageMigration(papHome, agentId, threadPiPath | null): { staging: string }` writing `$PAP_HOME/vm/staging/<agentId>/home/...` (a copy of the old home) and `.pi/sessions/<file>`; then `disk.populate` (pap-vmd copies the staging with `copyTreeSafely` and runs `mkfs.ext4 -q -F -d <copy> disk.img`; the disk is never mounted); seeds the mirror from the same session file; moves the old home to `$PAP_HOME/agents/.trash/<id>-<stamp>` (7-day purge, T15's trash sweep).
- Runs once, at the first VM start of an agent that has a host home and no disk.

- [ ] **Step 1: Tests**, key assertions: staging contains the home's files and the thread file and nothing from other agents; a link inside the old home is not followed (it is skipped and listed in the report, since `copyTreeSafely` would refuse the whole copy); the mirror equals the thread file; a second start does not migrate again; a failed populate leaves the old home in place and the agent startable again (no half state).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Kata test**: a host-mode agent with a home and a thread migrates; inside the VM `/agent/home` has its files and the thread continues with its history.
- [ ] **Step 6: Commit** `feat(agent-vm): migrate an agent's home and thread into its first disk`.

### Task T18: `pap doctor` and the agents' VM status

**Files:**
- Create: `apps/daemon/src/cli/doctor/checks-vm.ts`, `checks-vm.test.ts`, `apps/daemon/src/modules/agent-vm/status.ts`, `status.test.ts`
- Modify: `apps/daemon/src/cli/doctor/registry.ts` (+1 line), `packages/contracts/src/agents-vm-methods.ts` (`agents.vmStatus`, `agents:read`)

**Interfaces:**
- Produces: checks `vm.kvm`, `vm.vmd`, `vm.stack`, `vm.network`, `vm.images`, `vm.disk` (each `CheckResult` with a `fix` command: `sudo pap vm setup`, the nested virtualization line of `install.md`, …); `agents.vmStatus` → `{ runtime: "host" | "vm", usable: boolean, reason: string | null, vmdVersion: string | null, agents: Array<{ id, phase }> }` (the same sentence `pap doctor` prints); in `vm` mode an unusable stack refuses agent launches with `sandbox_unavailable` and the sentence.
- Checks run only when `PAP_AGENTS_RUNTIME=vm` (else `skip`).

- [ ] **Step 1: Tests**, key assertions: each check's ok, warn and fail texts are fixed strings; a pap-vmd whose `version` differs from pap's fails with `sudo pap vm setup` (R6); disk room adds agent disks' sizes and backups to `PAP_MIN_FREE_DISK_MB`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(doctor): checks for the agent VM stack`.

### Task T19: Web: the agent form, the VM status and the Claude token

**Files:**
- Create: `apps/web/src/features/agents/AgentResources.tsx`, `AgentResources.test.tsx`, `AgentPackages.tsx`, `AgentPackages.test.tsx`, `VmStatus.tsx`, `VmStatus.test.tsx`, `apps/web/src/features/settings/ClaudeToken.tsx`, `ClaudeToken.test.tsx`, catalog entries (`en`, `fr`)
- Modify: `apps/web/src/features/agents/AgentForm.tsx` (compose the two new sections: at most +8 lines), the Settings › Agents page (one line)

**Interfaces:**
- Consumes: T1 fields, T12 `agents.vm.setClaudeToken`, T18 `agents.vmStatus`.
- The form shows memory (MiB), CPUs, disk (MiB, never below the saved value: the field explains "le disque ne peut qu'être agrandi"), system packages (chips, validated with `SystemPackage` as typed), Pi packages (ticks; "Tous" by default). `VmStatus` replaces `SandboxStatus` when `runtime` is `vm` and shows the doctor sentence when unusable. The Claude token field holds no value after save (write-only, like the provider form's keys).

- [ ] **Step 1: Tests**, key assertions: a disk value below the saved one cannot be submitted; an invalid package name shows the field error and is not sent; the token field is empty after save and its value never reaches a store or the DOM after submit; the French catalog spells "mémoire", "processeurs", "paquets système", "agrandi" with accents.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** (tokens only, no arbitrary values; compare with the CHOSEN agent form board `docs/design/explorations/09-agent-space-inbox.html` and say so in the commit body). **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): agent resources, packages, VM status and the Claude token`.

### Task T20: Kata tests in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (a `kata` job after `build`), `vitest` workspace config (a `kata` project matching `*.kata.int.test.ts`; the `integration` project excludes them)
- Create: `scripts/ci/kata-setup.sh`

**Interfaces:**
- The job runs on the runner T0 Step 7 validated: checks `/dev/kvm`, runs `sudo node apps/daemon/dist/main.js vm setup` from the built tree, then `CI=1 pnpm vitest run --project kata`; uploads `journalctl -u 'pap-vm*'` on failure. Without KVM the job fails (never skips under `CI=1`).

- [ ] **Step 1:** add the project and the job; **Step 2:** push the branch and read the run; **Step 3:** fix until green; **Step 4: Commit** `ci: run the Kata tests on a KVM runner`.

### Task T21: Docs and the rulings archive

**Files:**
- Create: `docs/agents/agents-vm.md` (the topic note: runtime, gateway, guest, mirror, relay, pap-vmd, setup, doctor, test seams, known limits)
- Modify: `AGENTS.md` (an "Agents in microVMs" section: `PAP_AGENTS_RUNTIME`, `PAP_AGENTS_MEMORY_MAX_MB`, `PAP_TEST_AGENT_RUNTIME`, `pap vm setup|uninstall`, the KVM requirement), `docs/agents/agents.md` (pointer), `docs/agents/install.md`, `docs/agents/doctor.md`, `docs/adr/0078-agents-run-in-microvms.md` (final), `docs/research/decisions-log.md` (the merge decision)
- Create at merge: `docs/research/agents-vm-1-rulings.md` (R1 to R9 plus execution rulings), `agents-vm-1-sdd-ledger.md`, `agents-vm-1-final-review.md`

- [ ] **Step 1:** write the notes; known limits must include: the VM boundary is a KVM boundary (a guest kernel or Cloud Hypervisor escape is the residual), x86_64 only, the shell has no network until sub-project 2, OAuth providers refused (R9), pap-vmd lags `pap update` until `sudo pap vm setup`. **Step 2:** `pnpm format:check`. **Step 3: Commit** `docs(agents-vm): the runtime topic note, install and doctor`.

## Self-review against the spec

| Spec | Task |
|---|---|
| §4 pap-vmd, AgentRuntime, gateway, network | T13, T7, T6, T16 |
| §5 inside the VM | T11 (R2), T4, T5 |
| §6 image | T14, T13 (`renderDockerfile`), T16 (pins) |
| §7 config fields | T1, T19, T18 (host ceilings at save: T7's config + the agents service check, in T8) |
| §8 disk and lifecycle | T7, T15, T13 (R3), T17 |
| §9 provider path | T12 (R9) |
| §10 channel | T2, T4, T6 |
| §11 mirror | T9 (R1) |
| §12 install and doctor | T16, T18 |
| §13 migration and rollout | T17, T7 config, T8 |
| §15 testing | every task; T20 for CI |
| §17 risks | T0 |

The host-dependent ceilings of §7 (memory under `PAP_AGENTS_MEMORY_MAX_MB`, CPUs under the host's cores) are checked by the agents service when a profile is saved: T8 adds that check (`bad_request` naming the field) beside the launch wiring, with a test for each bound.

## Ledgers

- **Owner answers:** decisions 106 to 111, every recommendation. Plan rulings R1 to R9: pending the owner's review of this plan.
- **Deferred to later sub-projects:** the shell's network, vault values bound to hosts, grants, refusal alerts (2); taint and approvals at the box's exits, the default switch, deleting the host-bwrap agent code (3); backups and restore, S3 (4); OKF memory and mem0 removal (5); Kubernetes; adopting live VMs at boot; TLS on the channel.
