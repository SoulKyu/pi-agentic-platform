# Agents in microVMs, sub-project 1: the agent runtime

Date 2026-10-19. Status: design, every section approved by the owner on the question pages archived in `docs/architecture/agents-vm/01` to `05` (all answers are the recommendation), decisions 106 to 111 in `docs/research/decisions-log.md`. Plan: to be written (`docs/plans/2026-10-19-agents-microvm-runtime.md`). ADR to write with the plan: 0078, agents run in microVMs (a deviation from spec C §5 row 05 and §5.4; ADR 0048's host sandbox stays for the old mode until sub-project 3 deletes it).

## 1. Goal

The owner's words (2026-10-19): an agent "tourne dans un process isolé, propre de A à Z": an isolated shell that cannot reach the machine, isolated network through the egress proxy and the existing host list; it "doit pouvoir aller sur du contenu externe sans qu'on puisse considérer ça unsafe"; "si l'agent se fait péter, on doit pouvoir juste le supprimer sans que ça ait d'impact sur le reste de la plateforme", with no lateral movement. The agent has "son propre lieu de vie" and cannot touch the host's files. pap builds the images with everything Pi needs. Security makes mistakes reversible; it does not stop the agent from acting.

## 2. Why (the report that started it)

CyberLooker asked for approval on almost every call although the owner had set Full Access and Tools: Full on its session. Three causes, confirmed in the audit rows of its thread:

- The agent profile said `auto-accept-edits` and `default`; a session's mode can only narrow an agent's (W5-R23, `apps/daemon/src/modules/sessions/agent-rules.ts:27`), so Full Access on the session bar did nothing and the bar said "saved".
- The first `web_search` tainted the thread; from then on every `bash`, `web_search` and `fetch_content` asked Deny / Allow once in every mode (ADR 0020).
- The autonomy exception needs a host list of the agent's own (`packages/pi-host/src/policy/agent-stage.ts:19`); `allowHosts` was null. Even with one, pi-web-access calls `fetch()` from the unsandboxed worker, so the proxy cannot bound it and lifting the question would open exfiltration.

The fix is structural: put the whole agent (worker, Pi, extensions, MCP servers, shell) inside a boundary, so that inside it nothing needs a question.

## 3. The programme and this spec's scope

One principle: a strong boundary (the VM), full freedom inside, guards only on what leaves the box or cannot be undone. The VM mode **replaces** today's host-bwrap agents. Agents are off by default; without KVM and Kata, no agent.

| # | Sub-project | Depends on |
|---|---|---|
| 0 | Spike: pi-claude-bridge behind a proxy that injects the token (done, decision 106) | |
| 1 | **This spec.** Runtime: Kata + Cloud Hypervisor, pap-built image, block disk per agent, worker channel, transcript mirror, model-provider path, `pap vm setup`, `pap doctor` | |
| 2 | Proxy v2: general egress for the VM (host list, the shell's network, vault values bound to hosts, grants, refusal alerts) | 0, 1 |
| 3 | Agent policy: no taint questions inside the box, approvals at its exits (platform ops), default switch to the VM mode, deletion of the old agent sandbox | 1, 2 |
| 4 | Backups: per-agent toggle, frequency, retention; local snapshots and restore; S3 later (same file) | 1 |
| 5 | Memory: an OKF `knowledge/` folder on the agent disk; pap's mem0 integration removed; mem0 memories converted | 1 |

**Moved into sub-project 1 from 2:** the model-provider path (`llm.internal`, `claude.internal`, §9). Without it no agent can think, and §15's rollout promises the owner can try CyberLooker in a VM at the end of this sub-project.

## 4. Architecture and trust boundaries (decision 107)

```
host
  pap daemon (ordinary user)
    AgentRuntime ── unix socket ──> pap-vmd (root, narrow API) ──> containerd + Kata + Cloud Hypervisor
    agent gateway (VM bridge, per-launch token)
    provider path: llm.internal / claude.internal (injects credentials)
  VM network: a VM reaches the gateway and the provider path only; VM <-> VM blocked
  microVM per agent (guest kernel, CPU / memory / disk from the agent config)
    pi-host + Pi + packages (pap image, read-only)
      shell: bwrap + seccomp, no direct network, no vsock
    /agent  <- ext4 block disk, never mounted on the host
```

- **pap-vmd** is a root systemd system service, the only caller of containerd. Its socket is `0660`, group `pap` (the daemon's user only). Operations: `vm.start`, `vm.stop`, `vm.pause`, `vm.resume`, `vm.status`, `vm.list`, `disk.create`, `disk.grow`, `disk.delete`, `disk.populate` (§13), `image.build`, `image.list`, `image.prune`. Every field is validated against a schema in `@pap/contracts` (agent ids by the existing id rule, sizes by §7's bounds, paths only under `$PAP_HOME/agents/<id>/` resolved without links, image tags by `^pap-agent-(base|profile|agent)-[0-9a-f]{64}$`). Nothing else is reachable: no generic `run`, no mounts, no env passthrough beyond the fields §8 lists. Every call is logged with its caller and result.
- **AgentRuntime** is the daemon's port: `start(spec)`, `stop(id)`, `pause(id)`, `resume(id)`, `status(id)`, `list()`. Backends: `kata` (through pap-vmd) and `process` (tests only: runs pi-host as a local process with the same socket channel; enabled only with `PAP_TEST_AGENT_RUNTIME=process`, which also requires `PAP_TEST_PROVIDER_SCRIPT`, like the other test-only switches). Kubernetes is a later third backend.
- **Gateway**: a listener on the VM bridge address, one connection per worker (thread, children, thread tasks share one VM).
- **Network** (nftables rules installed by `pap vm setup`, owned by pap-vmd): traffic from a VM interface is accepted only to the gateway port and the provider-path port on the bridge address; everything else, VM-to-VM included, is dropped and counted. Sub-project 2 adds the proxy port.

## 5. Inside the VM

- Users: pi-host runs as an unprivileged guest user `pap-worker`; the agent's shell runs as root inside its own bwrap user namespace (root to itself, unprivileged to the guest).
- The shell (pap-sandbox's `bash`, as today) runs in bwrap with `--unshare-all` (user, pid, net, ipc, uts, cgroup), `--cap-drop ALL`, a fresh `/dev` without `vsock` or `vhost-vsock`, a seccomp filter that refuses `socket(AF_VSOCK, …)`, `init_module`, `finit_module`, `kexec_load`, `bpf`, `perf_event_open`, `ptrace` and `keyctl`. It sees the image read-only under a writable overlay kept on the VM's tmpfs for the VM's lifetime (so `apt install` to try a tool works until the VM stops), and `/agent/home`, `/agent/knowledge`, `/agent/inbox` read-write. It never sees `/agent/.pi`, the worker's process or its environment.
- Pi's own file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) run in the worker; one rule replaces today's path rules for a VM agent: inside `/agent/home`, `/agent/knowledge`, `/agent/inbox` and the image's skills folder (read-only); `/agent/.pi`, `/proc`, `/sys` and `/dev` are refused. `.pi` belongs to the worker so the transcript the owner reads cannot be forged by the agent's own tools.
- The gateway token is read from the environment at start and deleted from `process.env` before Pi loads.
- In sub-project 1 the shell has no network at all (`--unshare-net` and no proxy). Sub-project 2 gives it one.

## 6. The image (decision 108)

- Built by pap-vmd with BuildKit from a Dockerfile pap generates; three layers, each tagged by the sha256 of its inputs, so nothing rebuilds when nothing changed:
  - **base**: Debian slim at a digest the pap release pins, `apt upgrade`, Node at the host's version, `bwrap`, `git`, `curl`, `jq`, `python3`, `ripgrep`, `fd`, `ca-certificates`, pi-host's dist and pap's Pi SDK. Rebuilt weekly and at each pap release.
  - **profile** (shared by every agent): the owner's Pi setup by allowlist (below).
  - **agent**: the agent's `systemPackages`; absent when the list is empty.
- Allowlist of the profile layer: the packages listed in `settings.json` (npm from `~/.pi/agent/npm`, git from `~/.pi/agent/git`, local paths copied, each at the version installed), the skills folders, and a sanitized `settings.json` (compaction, thinking levels, enabled models, packages). Providers get `baseUrl = http://llm.internal/<provider>` and a placeholder key. Image environment: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. A file that is not on the list never enters.
- Never: `auth.json`, `~/.claude/.credentials.json`, any provider key, sessions, `mem0/`, pi-web state, extension config files as they are.
- Adapters: pi-claude-bridge gets `ANTHROPIC_BASE_URL=http://claude.internal` and a placeholder token (spike 0); pi-web-access gets a regenerated config with placeholder keys (its searches go through sub-project 2); pi-mcp-adapter gets its stdio servers' binaries in the image and HTTP servers rewritten to internal URLs (sub-project 2). A package pap does not know enters without its config; if it needs a key it fails inside the VM.
- Rebuild: at the next start of any agent when an input changed; the agent starts on the old image meanwhile and its thread gets a notice; an image whose pap protocol version is incompatible is refused and the start waits. Per-agent `packages` (default: all of the profile) are applied at start through the agent's settings, not by a separate image.

## 7. Agent config additions (decision 109)

`AgentInput` (contracts) gains, all parsed at every read like the rest of the profile:

| Field | Default | Bounds | Applied |
|---|---|---|---|
| `resources.memoryMb` | 1024 | 512 to `PAP_AGENTS_MEMORY_MAX_MB` | next VM start |
| `resources.cpus` | 1 | 1 to the host's cores | next VM start |
| `resources.diskMb` | 4096 (sparse) | 1024 to 65536, grow only | next VM start, VM stopped |
| `systemPackages` | `[]` | at most 64 Debian package names (`^[a-z0-9][a-z0-9+.-]{0,62}$`) | agent layer rebuild |
| `packages` | all of the profile | subset of the profile's packages | next start |

Changing them is not a widening edit (no password); a smaller `diskMb` than the current one is `bad_request`.

## 8. Disk and lifecycle (decision 109)

- Disk: `$PAP_HOME/agents/<id>/disk.img`, ext4, sparse, `0600`, created, grown, populated and deleted by pap-vmd only, attached as a Kata direct-assigned block volume at `/agent` (`home/`, `knowledge/`, `.pi/`, `inbox/`). The host never mounts it.
- One VM per agent; a start is triggered by a thread message, a scheduled task, a delegation or a reminder. States: `stopped`, `starting`, `running`, `paused`, `stopping`. Idle stop after `PAP_WORKER_IDLE_MINUTES` with no worker busy.
- Host cap: `PAP_AGENTS_MEMORY_MAX_MB` (default 50 % of RAM). A start that would pass the running VMs' total is refused `capacity`, naming the running agents; a scheduled task retries like the current free-memory floor.
- A VM that exits unexpectedly is a crash like a worker's today; the next message restarts it; 3 crashes in 10 minutes pause the agent with a notification.
- An isolated task (an untrusted trigger) runs in a throwaway VM with the same image and resources and a blank disk, with no access to the agent's disk; the result comes back as a card; VM and disk are destroyed at the end.
- At daemon boot pap stops every agent VM pap-vmd lists; a task that was running is marked interrupted.
- Delete: stop, then the disk, its backups (sub-project 4) and the session mirror move to `$PAP_HOME/agents/.trash/<id>-<stamp>`, purged after 7 days or at once with "Purge now". The vault scope, triggers, tasks and Inbox items go as today.
- Quarantine: stop the VM, keep the disk, revoke the token, then today's steps.

## 9. The model-provider path (moved from sub-project 2)

- A host listener on the bridge address, reachable from VMs only, named in each VM by `--add-host llm.internal:<bridge>` and `claude.internal:<bridge>`.
- `http://llm.internal/<provider>/…` forwards to the provider's real base URL over TLS with the credential Pi's own auth storage on the host resolves for that provider (API key or OAuth, refreshed by Pi's storage). `http://claude.internal/…` forwards to `https://api.anthropic.com` with the long-lived token the owner creates once with `claude setup-token` and stores in pap's vault (host side); without it the bridge's models are unavailable and the agent form says why.
- The path accepts only the providers of the owner's enabled models (pi-task-models and subagents may switch models) and the bridge, and only the paths and methods of a model call; anything else is 403 and logged with the agent id. The worker's placeholder header is replaced, never forwarded. Credentials never appear in a log, a response or the VM.

## 10. The channel (decision 110)

- The worker dials the gateway and sends `hello {agentId, launchId, token, protocolVersion, imageTag, session: {lastEntryId, size}}`. The token is compared in constant time; an unknown, revoked or incompatible hello closes the connection and logs `agent_gateway_refused {agentId, reason}`.
- One token per VM launch, 32 random bytes, given to pap-vmd at `vm.start`, revoked at stop.
- Frames: a 4-byte big-endian length, then JSON; over 4 MiB is refused before the body is read and closes the connection. The `DaemonToWorker` and worker-to-daemon records stay as they are, behind a socket implementation of pi-host's `Ipc` (`packages/pi-host/src/ipc.ts`) and the supervisor's `worker-io`.
- New records: `session_append {lines}` (worker to daemon) and `file_put {name, bytes}` (daemon to worker: an attachment into `/agent/inbox`, bounded by the attachment upload limit pap already enforces).
- Ping every 15 s; 3 missed or a closed socket is a dead worker; no reconnect within a launch.
- Plain on the local bridge (only root on the host can read it, and root can read everything); mTLS when Kubernetes comes.

## 11. The transcript mirror (decision 110)

- The daemon keeps `$PAP_HOME/agents/<id>/sessions/<pi file name>` (outside `~/.pi`, so pi-web never lists it). `session_append` lines are checked one by one (valid JSON object, at most 1 MiB, a Pi entry shape with `type` and `id`, ids not already present) before they are appended; a bad line closes the connection and logs `agent_mirror_refused`.
- Every existing reader (snapshot, `sessions.history`, `toolOutput`, `branches`, search, outside-write checks) reads the mirror through the session row's `piPath`, which points there for a VM agent. Opening history never starts a VM.
- At `hello`, if `lastEntryId` and `size` differ from the mirror's, the worker resends the whole file and the mirror is replaced (the VM's file is the truth: after a backup restore, what the agent sees and what the owner reads stay the same).

## 12. Install and `pap doctor` (decision 111)

- `sudo pap vm setup`: downloads the Kata static archive and the nerdctl-full archive at the versions and SHA-256 the pap release pins, installs them, writes the `pap-vmd` unit, the `pap` group, the bridge and the nftables rules; idempotent. `sudo pap vm uninstall` reverts it.
- `pap doctor` gains: `/dev/kvm` usable; `pap-vmd` active at pap's version; containerd, Kata runtime, Cloud Hypervisor, BuildKit present at the pinned versions; bridge and rules present; base and profile images built and current (warning); disk room for agent disks, backups and `PAP_MIN_FREE_DISK_MB`. A failed check greys agents out in the UI with the same sentence and blocks nothing else.

## 13. Migration and rollout (decision 111)

- At an agent's first VM start, pap-vmd creates its disk with `mkfs.ext4 -d <staging>` where `<staging>` holds the old home under `home/` and the current thread's Pi session file under `.pi/sessions/`; the disk is never mounted. The mirror is seeded from the same file. The old home moves to the 7-day trash.
- The VM mode ships behind `PAP_AGENTS_RUNTIME=vm` (default `host`, today's mode). Sub-project 3 switches the default and deletes the host-bwrap agent code.

## 14. What changes in the existing code

- Contracts: `AgentInput` fields (§7), pap-vmd's request and response schemas, `hello`, `session_append`, `file_put`.
- Daemon: an `agents` runtime module (port, kata and process backends, gateway, token store, mirror writer, provider path); session launch for a VM agent goes through the runtime instead of the supervisor's fork; agent delete, quarantine and boot follow §8; `pap vm setup|uninstall`; doctor checks.
- pi-host: a socket `Ipc`, `session_append` from the entry tracker, `file_put`, the VM file rule (§5), the bwrap argument list for the VM view (in contracts, beside `bwrapArgv`).
- New package or folder for pap-vmd (it runs as root: smallest dependency set, no import of daemon modules).
- Web: the agent form's resources, system packages and package ticks; the agent's VM state and doctor sentence; the bridge's "setup-token missing" line.

## 15. Testing (decision 111)

- Unit and integration tests run on the process backend everywhere: start, hello and token checks (wrong, revoked, replayed after stop), frame bounds, `session_append` validation and mirror replacement, `file_put` bounds, idle stop, crash pause, capacity refusal, isolated-task disk, delete to trash, boot stop, migration staging.
- Real Kata tests run in CI on KVM runners, skip locally with one warning and fail under `CI=1` without KVM: VM start and stop, the block disk, VM-to-VM and host reachability (nothing but gateway and provider path), the shell sandbox inside the VM (no network, no vsock, no `/agent/.pi`), the provider path refusing other hosts.
- pap-vmd has its own schema tests for every operation, including refused paths, tags and sizes.
- Tests never touch `~/.pi/agent`, `~/.pap` or `~/.claude`; the provider path is tested against a loopback fake, never a public host.

## 16. Out of scope

Sub-projects 2 to 5; Kubernetes; adopting live VMs at boot; S3; TLS on the channel; a VM for non-agent sessions; resizing memory of a running VM.

## 17. Risks and first checks (the plan starts with them)

1. **No KVM on the current host** (Hyper-V guest, no `vmx`/`svm`). The owner enables nested virtualization or provides a KVM host before the Kata tasks; the process-backend tasks do not wait for it.
2. **Kata direct-assigned block volume with Cloud Hypervisor** (§8): verify first on a KVM host; fallback is a virtio-blk device through the runtime's annotations.
3. **KVM on GitHub runners** for the Kata CI job: verify; fallback is a self-hosted runner or a nightly job.
4. **apt in the shell** under a bwrap user namespace with an overlay: verify; fallback is `systemPackages` only.
5. **OAuth providers in `auth.json`**: refresh through Pi's auth storage on the host must not race pi-web; verify Pi's locking, else API-key providers only for agents.
6. **`claude setup-token`** (untested, interactive): the owner runs it once; verify the token works through `claude.internal`.
7. **Cold start** (VM + Node + Pi): target under 5 s; measure; Kata's default 2 GiB is overridden by `resources.memoryMb`.
8. **Disk room**: 11 GB free on this host's 39 GB; sparse disks and `keep` matter.
