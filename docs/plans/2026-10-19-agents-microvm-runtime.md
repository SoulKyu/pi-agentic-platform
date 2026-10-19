# pap agents in microVMs, sub-project 1: the agent runtime - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-19):** fixed from the Opus red-team and the owner's answers (decision 113); ready for SDD execution once the owner gives the go (decision 114: model table final, Opus escalation at fix rounds 4 and 5 approved). T0a done (record `docs/research/agents-vm-risk-checks.md`, applied to R2, R5, R27 and T16b by the controller). 32 tasks (T0a, T0b, T1 to T21 with T8, T9, T10, T11, T13, T14, T16 and T20 split, and the join task J1). Rulings R1 to R9 approved (decision 112) and corrected from the red-team's §8; R10 to R22 are the owner's answers (decision 113); R23 to R38 are the fix's own rulings. Red-team: `.superpowers/redteam-agents-vm-1.md` (5 Critical, 23 Important, 20 Minor; every Critical and Important fixed; 18 Minors fixed, RT-37 fixed in part and RT-31 deferred, see "Deferred minors").

**Goal:** an agent runs in its own Kata Containers microVM (Cloud Hypervisor) with its own block disk, CPU and memory. It reaches pap only through an authenticated gateway, and its model providers only through a host relay that checks a per-launch key, the agent's own models and its budget before it injects the credentials. Nothing inside the VM needs a question, and a compromised agent is deleted without touching the rest of the platform: no credential in the VM, no way to another VM. Shipped behind `PAP_AGENTS_RUNTIME=vm`; the host-bwrap agents stay the default until sub-project 3.

**Architecture:**
- **Root stays narrow.** `pap-vmd` (new app `apps/vmd`, root, systemd system unit, code installed from pinned release artefacts, R19) is the only caller of a pap-owned containerd, Kata and BuildKit. It takes one typed JSON request per connection on a unix socket owned by pap's uid (0600, R36), validates every field with schemas from `@pap/contracts`, builds every command line itself and renders every Dockerfile itself. The daemon never sends a path, a command or Dockerfile text.
- **Same protocol, new transport.** The worker protocol (`DaemonToWorker`, `WorkerRecord`) gains a few VM records. A length-prefixed JSON frame codec (bounded before the body is read; 4 KiB until the hello is accepted) carries it over TCP from the VM to the daemon's gateway on the bridge. pi-host gets a socket `Ipc`; the daemon gets a `WorkerHandle` over a gateway connection, both built on the record core extracted from today's `spawnWorker`.
- **A guest supervisor.** The VM's entrypoint is `pap-guest` (in pi-host). It scrubs the gateway token from its own environment (R24), dials the gateway as `guest`, seeds Pi's writable agent folder on the disk (R28), and spawns and signals pi-host workers on the daemon's command, handing each the token on a pipe. Each worker dials the gateway as `worker` with its slot id. One VM per agent; thread, children and thread tasks are workers in it.
- **The daemon keeps a mirror of each session file** under `$PAP_HOME/agents/.mirrors/<id>/` (R23), fed by `session_append` chunks and checked line by line (shape, duplicate ids, size, quota). Every existing reader (snapshot, history, outside-write checks) reads the mirror through `piPath`; a user entry pap did not send shows as such (R32). A replacement by the VM keeps the old copy 7 days (R14). Opening history never starts a VM.
- **The VM's file tools and shell.** Pi's `read`, `write`, `edit` and `ls` run pap's operations, which open every path component without following a link (R26); `grep`, `find` and `ls` roots are judged by the VM file rule. pap's `bash` runs in bwrap as guest root with a seccomp filter that refuses new namespaces, mounts and foreign socket families (R18), for every VM session whatever the host-sandbox switch says (R15).
- **Providers through a relay.** A daemon child process (`pap-relay`, in pi-host, the only holder of provider credentials) listens on the bridge address only. `http://llm.internal:7842/<provider>/...` and `http://claude.internal:7842/...` are matched against a fixed route table, then the relay checks the launch's relay key (bound to the VM's address), the agent's allowed models and its budget (R13), and forwards over TLS with the credential Pi's auth storage resolves on the host (or the owner's `claude setup-token`).
- **The agent network.** nftables (installed by `pap vm setup`, loaded by pap-vmd's unit) accepts from a VM only the gateway and relay ports on the bridge address, answers those ports to nobody but the bridge, drops VM to VM, and on the bridge itself drops any frame whose port, MAC and IPv4 (ARP included) are not that VM's own, plus all IPv6 (R22).
- **An `AgentRuntime` port** with a `kata` backend (pap-vmd) and a `process` backend (tests only: the guest runs as a local process over the same gateway, its `/agent` a temp folder, its image agent folder read-only), so every task except the KVM tail is built and tested on a host without KVM.

**Tech Stack:** Node 24.14 (`process.execve` for the guest's token scrub), TypeScript (erasable syntax), zod 4.6.5, Pi SDK 1.1.0, vitest. Guest image: the official Node image pinned by digest (Debian), bubblewrap 0.11. Host stack installed by `pap vm setup`: Kata Containers static release (Cloud Hypervisor, guest kernel and rootfs), nerdctl-full (containerd, nerdctl, BuildKit, CNI plugins), nftables. **No new npm dependency.**

**Spec:** `docs/specs/2026-10-19-agents-microvm-runtime-design.md`. Binding context: decisions 106 to 113 (`docs/research/decisions-log.md`), the approved pages `docs/architecture/agents-vm/01` to `05`, the answered page `docs/design/questions/2026-10-19-agents-vm-1-redteam.html`, ADRs 0020, 0047, 0048, 0049, 0050, 0053, 0055 to 0057 (pinned archives), 0068, 0074, 0075; topic notes `docs/agents/agents.md`, `sessions.md`, `models.md`, `daemon.md`, `doctor.md`, `install.md`, `finops.md`.

## Plan rulings

### R1 to R9 (approved, decision 112; corrected from the red-team's §8)

- **R1, chunked transcript.** Pi stores images inline, so a session line can exceed the spec's 1 MiB. `session_append` carries raw bytes (base64, at most 2 MiB a chunk) with their file name and offset; the daemon checks each completed line, at most 32 MiB (`MAX_SESSION_LINE_BYTES`). The same reasoning makes `file_put` chunked (R33). A line over 1 MiB is parsed off the event loop, the mirror has a quota, and an entry id already in the mirror is refused (spec §11): R32. Cost if wrong: an agent that reads one image breaks its own transcript, or stalls the daemon.
- **R2, who is root in the VM.** The guest supervisor and the workers run as guest root: the container's root with the capabilities bwrap needs to build the shell's namespaces (T0a recorded: `--cap-add SYS_ADMIN --cap-add NET_ADMIN --cap-drop NET_RAW` on top of the default set, which already holds `CAP_SETPCAP`; without `SYS_ADMIN` bwrap cannot create its namespaces, without `NET_ADMIN` it cannot set up the shell's loopback, and without `NET_RAW` a VM cannot forge ARP even before the bridge guard; Kata's CLH config has `disable_guest_seccomp = true`, so the container's seccomp profile is not applied in the guest; never `--privileged`, which can pass host devices to a Kata VM). The shell runs as guest root in bwrap with new mount, pid, ipc, uts, cgroup and net namespaces, every capability dropped except `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_FSETID`, `CAP_SETUID`, `CAP_SETGID`, `CAP_KILL`, the seccomp filter of R18 (without it, `unshare(CLONE_NEWUSER)` gave the shell `CAP_NET_ADMIN` over a namespace of its own, RT-23), no `/dev/vsock`, the image root read-only (R27: T0a showed virtio-fs refuses bwrap's overlay) and `/agent/.pi` hidden. pap's shell is registered for every VM session (R15). Sub-project 1 gains nothing from the seven capabilities (apt has no network until sub-project 2, R18); they stay because the owner's page says the agent is root in its box. Cost if wrong: the shell reaches the worker, `.pi` or the channel.
- **R3, where disks live.** Disks, their trash and (sub-project 4) their backups live in pap-vmd's root-owned state folder `/var/lib/pap-vm/<pap uid>/agents/<id>/` (0700); the daemon never reads them. An isolated task's disk is pap-vmd's own (R30). The host never parses an image the guest wrote (R31). The mirror is not in the agent's host home (R23). Cost if wrong: root writes through a link the daemon's user planted, or parses a hostile ext4 image.
- **R4, a guest supervisor** (`pap-guest`). It seeds `/agent/.pi/agent` from the image (R28), starts workers with `PI_CODING_AGENT_DIR=/agent/.pi/agent` and `GIT_CEILING_DIRECTORIES=/agent` (RT-06, RT-37), cwd `/agent/home`, and the gateway token on fd 3, never in an environment (R24). Cost if wrong: one VM per worker, against decision 109.
- **R5, pap's own container stack.** (T0a: Kata 4.2's runtime-rs accepts `KATA_CONF_FILE` for shipped files only, so pap's CLH config is the admin override `/etc/kata-containers/runtime-rs/configuration.toml`, the one host-global file pap writes; see T16b.) pap-vmd uses its own containerd (`/run/pap-vm/containerd.sock`, root `/var/lib/pap-vm/containerd`, state `/run/pap-vm/containerd`), BuildKit (`/run/pap-vm/buildkit.sock`, `--containerd-worker-addr` on pap's containerd, namespace `pap`), nerdctl with `--data-root /var/lib/pap-vm/nerdctl --cni-path /opt/pap-vm/libexec/cni --cni-netconfpath /etc/pap-vm/cni`, and Kata reading `/etc/pap-vm/kata/configuration-clh.toml` (how the shim is pointed there without touching `/etc/kata-containers`: T0a). The CNI bridge has `isGateway: false` (no host-wide IPv4 forwarding, RT-21). `pap doctor` says when `ufw` or `firewalld` would drop the two ports. Cost if wrong: `pap vm setup` breaks the owner's Docker, or the host starts routing.
- **R6, root-owned code.** pap-vmd runs from `/opt/pap-vm/` (its bundle and a Node binary, root-owned 0755) installed from release artefacts pinned by SHA-256 in `vm-assets.json`, never from pap's user-writable tree (R19, owner Q10). `pap update` leaves pap-vmd at the old version: `pap doctor` and the agents screen say "run `sudo pap vm setup`", and the gateway refuses a guest whose protocol differs. Cost if wrong: pap's user edits code that root runs.
- **R7, no Dockerfile from the daemon.** The daemon sends `image.build` as data; pap-vmd renders the Dockerfile and writes it outside the build context. Only `FROM` (a pinned Node digest or a pap tag, both regex-checked) and apt names (regex) are data; only the base and agent layers have a `RUN`. Base builds run with `--no-cache`, so the weekly `apt-get upgrade` really runs (RT-19). Cost if wrong: a compromised daemon runs build steps of its choice as root's BuildKit.
- **R8, secrets never on a command line.** The gateway token reaches the VM through an env file pap-vmd writes 0600 in its state folder and deletes after `nerdctl run` returns. It also lives in containerd's root-only metadata until `nerdctl rm --force` at stop, and the guest scrubs it from its own environment at start (R24). Cost if wrong: any local user reads a live token.
- **R9, providers in v1.** The relay serves providers whose Pi `api` is `anthropic-messages`, `openai-completions`, `openai-responses` or `google-generative-ai` with an API key, plus the bridge. It authenticates every request by the launch's relay key, checks the agent's models and budget (R13) and is reached on port 7842 (R34). An OAuth provider of `auth.json` is refused with a notice until T0b shows the relay's header handling works for it. Cost if wrong: an agent on an OAuth provider fails silently, or anyone on the host spends the owner's keys.

### R10 to R22: the owner's answers (decision 113)

- **R10 (owner Q1): the KVM host is this VPS.** The owner enables nested virtualization on the Hyper-V host (`Set-VMProcessor -ExposeVirtualizationExtensions $true`, VM stopped). Every task before T20a runs without KVM; T20a starts when `/dev/kvm` exists here. Trying CyberLooker in a VM at the end of sub-project 1 happens on this VPS.
- **R11 (owner Q2, RT-11): no vault or one-use value in the VM** in sub-project 1. A VM session's `init` carries no `vault`, no `once`; no `vault_update` is sent to it; `secret.request` answers `unavailable` for a VM agent with the sentence "Le coffre des agents en VM arrive avec le sous-projet 2." The agent form says the same. (T8b, T19)
- **R12 (owner Q3, RT-09): a migrated agent is refused in host mode.** Migration stores a per-agent `runtime = "vm"` marker; with `PAP_AGENTS_RUNTIME=host` its launch is refused `sandbox_unavailable`, logged `agent_vm_only`, and its thread gets the notice "Cet agent a été migré vers une VM ; lancez pap avec PAP_AGENTS_RUNTIME=vm." (T17)
- **R13 (owner Q4, RT-03, RT-17): what the relay checks.** Every request presents the launch's relay key (64 hex, in the header its SDK uses), looked up by digest and compared in constant time, from the bridge address pap-vmd gave that VM; then the provider and model must be in the agent's allowed list (the models its picker offers, ADR 0068; the model is read from the path for Google, else from the JSON body's `model`); then the agent must be neither paused nor over budget (the daemon pushes that state). The relay counts requests, bytes and refusals per agent and reports them every 60 s: attribution (RT-17). (T12, J1)
- **R14 (owner Q5, RT-26): a transcript replacement is reversible.** A `replace` that is not a byte-prefix extension of the mirror keeps the old mirror as `replaced/<name>.<stamp>` for 7 days, posts the notice "La VM a réécrit cette conversation ; l'ancienne copie est gardée 7 jours." and taints the session the way ADR 0074's outside-write detection does. (T9b)
- **R15 (owner Q6, RT-02): the VM shell is judged as an edit of its own folder.** A VM session's rules carry `sandbox: { required: true, network: false }` whatever the profile's host-sandbox switch says, so pap's shell is the only shell (stage 02 blocks any other `bash`) and is judged like today's sandboxed shell without network (M11R30, ADR 0047 m2): no question in `auto-accept-edits` and `full-access`. (T8b, T11b, T19)
- **R16 (owner Q7, RT-08): prechecks and prompt chips.** A trigger precheck of a VM agent is refused `sandbox_unavailable` with "Les pré-checks d'un agent en VM arrivent avec le sous-projet 3."; `agents.prompts` answers an empty list for a VM agent. Both move into the VM in sub-project 3. (T8b)
- **R17 (owner Q8, RT-32): pi-mem0 stays out of VM images** until sub-project 5; a VM session gets no `init.memory`; Settings › Memory says so. (T14a, T8b, T19)
- **R18 (owner Q9, RT-23, RT-25): R2's root shell, with the stronger seccomp.** The filter refuses (EPERM) `clone`/`unshare` with any `CLONE_NEW*` flag, `setns`, `mount`, `umount2`, `pivot_root`, the new mount API, `userfaultfd`, `process_vm_readv/writev`, `pidfd_getfd`, `kcmp`, handle opens, `syslog`, `acct`, `quotactl`, `swapon/off`, modules, keys, `ptrace`, `perf_event_open`, `bpf`, `io_uring`; answers `clone3` with ENOSYS; allows `socket` and `socketpair` only for the families the shell needs. The apt check moves to sub-project 2. (T11a)
- **R19 (owner Q10, RT-22): `sudo pap vm setup` installs pap-vmd and Node from pinned release artefacts** (SHA-256 in `vm-assets.json`), never from pap's user-writable tree. A checkout or a dev build has no such artefact: `--dev-from-tree` (tests, CI, the owner's try at the end of sub-project 1) copies the built bundle and the running Node and prints the residual ("code your user can change will run as root"). (T16b)
- **R20 (owner Q11): the model table below.** Opus reviewers for T1, T2, T6, T8 (T8a and T8b), T9b (T9a moved to Sonnet, decision 114), T11a, T11b, T12 (with its daemon half in J1), T13a, T14a, T15, T16a, T17; Sonnet for the rest.
- **R21 (owner Q12, RT-48): T0 is split.** T0a runs now on a GitHub runner through a throwaway workflow on a branch (deleted with its runs after); T0b runs locally without KVM after T12.
- **R22 (owner Q13, RT-04): anti-spoofing on the bridge**, amending decision 110 Q3. pap-vmd gives each VM its address and MAC (`--ip`, `--mac-address`), adds `{port . mac . ip}` to the `ports` set at `vm.start` from the CNI result and removes it at stop, and pins a permanent neighbour entry. The bridge table drops a frame from a VM port whose MAC, IPv4 or ARP sender is not that port's own, and all IPv6; `disable_ipv6` is set on `pap0`. The channel stays plain TCP. Run in the fix's scratch (a rootless privileged podman network namespace, two veth "VMs"): with the old ruleset a gratuitous ARP from VM a re-pointed the host's entry for VM b and a local process reached the relay; with this one both are dropped. (T1, T16a, T0a)

### R23 to R38: rulings of this fix

- **R23, where mirrors live (RT-08).** `$PAP_HOME/agents/.mirrors/<agent id>/<file>` (folders 0700, files 0600, daemon only), never the agent's host home, which its host-mode shell can write. Still outside `~/.pi`, so pi-web never lists it; amends spec §11 and decision 110 Q2's path.
- **R24, the gateway token is in no environment (RT-12).** `delete process.env.X` leaves the initial environment block in `/proc/<pid>/environ`. The guest's entry parks the token in a 0600 file on the container's tmpfs and re-executes itself without it (`process.execve`, run in the fix's scratch: `/proc/self/environ` holds no trace); workers get it on fd 3, read once and closed.
- **R25, the VM shell's code lives in pi-host (RT-02, seam).** `bwrapVmArgv` and the seccomp program are in `packages/pi-host/src/vm-shell/`, not contracts: only the worker uses them (prechecks are refused for VM agents, R16). The VM shell tool depends on neither `SandboxSpec` nor `bwrapArgv`, which sub-project 3 deletes. Amends spec §14's "in contracts".
- **R26, Pi's file tools in a VM (RT-01).** `read`, `write`, `edit` and `ls` are Pi's own tool definitions with pap's operations, registered by pap's `pap-vm-files` extension, which open every component relative to its parent's descriptor with O_NOFOLLOW (a link planted before or during a call is refused, never followed). The VM file rule judges each call first: a path Pi would rewrite (`~`, `@`, `file:`, a Unicode space) is refused, a read names an existing path, a write never lands on a link. `grep` and `find` stay Pi's (their walks follow no link, pinned by `pi-search.symlinks.int.test.ts`); their root is judged. Residual, recorded in the topic note: a link swapped onto a `grep`/`find`/`ls` root between the check and the walk can read (never write) `.pi` or `/proc`; with R24 neither holds a credential the agent does not already have.
- **R27, one overlay per worker (RT-24).** The shell's overlay upper is `/run/pap-shell/<slot>/`; one worker runs one shell at a time (its calls are queued). What a shell installs is seen by that worker's later shells only. If T0a shows bwrap cannot overlay `/` as guest root, the shell binds the image root read-only in sub-project 1 (`rootView: "read-only"`). **T0a recorded it:** bwrap's overlay always passes `userxattr`, which the virtio-fs root of a Kata container refuses (`Invalid argument`), with or without a user namespace; sub-project 1 ships `rootView: "read-only"` and keeps the overlay branch for a later root that supports it (sub-project 2 decides, with apt).
- **R28, Pi's writable folder and new sessions (RT-07).** The image keeps Pi's profile at `/opt/pap/pi-agent` (read-only); the guest seeds `/agent/.pi/agent` from it at each start (image-owned files replaced, Pi's own state kept) and Pi runs with that agent folder. A new VM session is created in `/agent/.pi/sessions`; each `session_append` names its file, and the daemon opens the mirror of that name at the first append. A reopen names the VM file by the mirror's name.
- **R29, capacity (RT-20).** The cap counts each VM as `memoryMb + VM_OVERHEAD_MB` (T0a measures it; 512 until then). pap's Kata configuration sets `default_memory = 256`, `default_vcpus = 1` and static sandbox resource management. VM workers still count against `PAP_MAX_WORKERS` (daemon-side connections, mirrors, events), not against the host free-memory floor (their memory is the VM's, counted by the cap).
- **R30, an isolated task's disk is pap-vmd's (RT-05).** `vm.start {kind: "isolated", taskKey}` makes a blank disk at `agents/<id>/tasks/<taskKey>/disk.img` and `vm.stop` of that task deletes it; the daemon never names it except `disk.delete` of a task disk a crash left. `disk.delete` of the agent's disk is refused (`conflict`) while any VM of that agent runs.
- **R31, the host never parses a guest-written image (RT-14).** `disk.grow` only extends the sparse file (refused while a VM of the agent runs); the guest grows its file system online at its next boot (`resize2fs` on its own device). `disk.create` runs `mkfs.ext4` on a new file and `disk.populate` on a file pap-vmd made from a staging copy: neither reads what a guest wrote.
- **R32, the mirror does not trust the VM (RT-26, RT-27).** A line up to 1 MiB is parsed on the event loop, a longer one in the mirror's parse thread (one at a time, the connection paused meanwhile); an agent's mirrors stay under its `diskMb` and pap's free-disk floor; an id already present is refused. The VM worker handle records the hash of every prompt, steer and follow-up it sends (a `/` prompt allows one expanded entry); a user entry matching none is kept but shown "pas envoyé depuis pap".
- **R33, `file_put` is chunked (RT-15):** `{id, name, offset, data ≤ 2 MiB, last}`; the worker writes an `O_EXCL | O_NOFOLLOW` temporary name in the inbox and renames it at `last`.
- **R34, two ports, one interface (RT-03, RT-16).** The gateway and the relay listen on `10.213.0.1` (Kata) or `127.0.0.1` (process backend); nftables answers 7841 and 7842 on that address to `pap0` only. Every URL the image holds names port 7842.
- **R35, contracts are frozen during the lanes.** T1 and T2 write every contract file both lanes need; no lane edits `packages/contracts` afterwards. A lane that needs a contract change stops; the controller lands it on `main` and both lanes rebase.
- **R36, pap-vmd's socket belongs to pap's uid (RT-33).** `/run/pap-vm/vmd.sock` is owned by the uid `/etc/pap-vm/config.json` names, mode 0600; no `pap` group (a lingering user manager would not see a new group until it restarts). `pap vm setup` takes `--user <name>` explicitly.
- **R37, what a VM session cannot do in sub-project 1.** `export_html` answers `unavailable` with "L'export HTML d'un agent en VM arrive plus tard." (it would write a host path from inside the VM, RT-06); search does not index mirrors (deferred minor RT-31, a known limit in the topic note).
- **R38, a VM launch counts as sandboxed (RT-10).** An unattended full-access continuation (owner a5, M11R214) needs a sandboxed worker; a VM worker is one. `service-launch.ts`'s check and `automation-port.ts`'s `sandboxed()` accept `agentLaunch.vm`.

## Global Constraints

- 400 lines per file at most, test files included, no baseline. Every file this plan prescribes stays under 400; every file it modifies stays under 395. Sizes on `main` today that matter (with this plan's additions): `packages/contracts/src/pi-host.ts` 394 (T1 moves the worker records to `pi-host-records.ts` first), `apps/daemon/src/compose-m11.ts` 398 (no new line: the VM runtime is wired in `compose-agents-vm.ts`), `packages/contracts/src/methods.ts` 390 (+2), `apps/daemon/src/daemon.ts` 388 (+3), `apps/daemon/src/modules/agents/service.ts` 387 (+1), `packages/contracts/src/agents.ts` 360 (+4), `apps/daemon/src/kernel/config.ts` 355 (+4), `apps/daemon/src/modules/sessions/automation-port.ts` 355 (+2), `apps/daemon/src/kernel/supervisor/worker.ts` 322 (shrinks), `apps/daemon/src/modules/sessions/agent-gate.ts` 311 (+9), `packages/contracts/src/streams.ts` 308 (+1), `packages/pi-host/src/policy/read-target.ts` 299 (+0), `apps/daemon/src/modules/sessions/service-launch.ts` 292 (+6), `packages/pi-host/src/policy/pipeline.ts` 288 (+3), `apps/web/src/features/agents/AgentForm.tsx` 282 (+8), `packages/pi-host/src/open-session.ts` 270 (+14), `scripts/build-npm.ts` 380 (+3), `apps/daemon/src/modules/sessions/agent-surface.ts` 312 (+2), `packages/pi-host/src/host.ts` 262, `packages/pi-host/src/policy/stage-approval.ts` 250 (+6). New code goes into new files composed in by a few lines.
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`. Every RPC method declares a permission. RPC handlers decode, call one service method, map typed errors. `apps/vmd` imports only `@pap/contracts` and Node built-ins.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep `.ts`. Timers go through the kernel `Clock` (pi-host and vmd: an injected clock with the same shape). No sleeps in tests.
- Tests never touch `~/.pi/agent`, `~/.pap` or `~/.claude`, never contact a public host or GitHub, and use the scripted provider (`PAP_TEST_PROVIDER_SCRIPT`). Relay tests use a loopback fake upstream. vmd tests use a fake `exec`. The Kata CI job fetches the pinned archives and the base image digest once per run (RT-44); no test contacts the network.
- Test-only switches (`PAP_TEST_AGENT_RUNTIME=process`) require `PAP_TEST_PROVIDER_SCRIPT` and stop the boot otherwise, like `PAP_TEST_GIT_PROTOCOLS`.
- Kata tests (`*.kata.int.test.ts`) skip locally with one warning when `/dev/kvm` or `pap-vmd` is missing and fail under `CI=1`, like the bwrap tests.
- Secrets (gateway tokens, relay keys, provider keys, the Claude token) never reach a log, an audit row, a response, a command line or an environment the agent can read. Logs name agents by id and hosts as the existing `h:<12 hex>` label.
- Security files name their mutants in the test file, a comment per mutant and the case that kills it (RT-43): tokens (agent id check), frames (bound before body), mirror (line check, duplicate ids), safe tree (bounded read, O_NOFOLLOW), ruleset (the `iifname !=` line, the ARP lookup, the IPv6 drop), relay (`routeOf` segment check, `Map` lookup), seccomp (arch, x32, families, namespace mask, a denied number), VM file rule (rewrites, O_NOFOLLOW per component).
- The only ESLint directive is `eslint-disable-next-line <rule> -- <reason>`. UI uses `packages/ui/src/tokens.css` tokens only; French copy uses vous and carries its accents.
- No literal bidi, zero-width or line-separator characters in source or in this plan (numeric code points only, `String.fromCharCode(n)` in tests).
- Conventional Commits; rebase on the target branch before a PR; no AI trailer, no Co-Authored-By.

## Review Focus

1. **A path Pi rewrites, or a link the agent planted** (`write "@/agent/.pi/sessions/s.jsonl"`, `read "~/../proc/self/environ"`, a dangling `home/x -> /agent/.pi/sessions/new.jsonl`, a folder swapped for a link between the check and the open): refused, read and write. Pinned in T11b (run in scratch, three mutants killed).
2. **A VM speaking for someone else**: a hello with another agent's id, a replayed token, a second guest; a relay request without the launch's key, with another VM's key, or from outside `pap0`; a gratuitous ARP claiming another VM's address. Pinned in T6, T12, T1 (ruleset) and T20b.
3. **A forged or rewritten transcript**: a user entry pap never sent shows as such; a replacement keeps the old copy, notices and taints; a duplicate id is refused; a 12 MiB line is parsed off the event loop. Pinned in T9b.
4. **An isolated task's disk**: it is never the agent's disk, and its end never deletes the agent's disk. Pinned in T1 (schema), T13b (argv) and T15.
5. **pap restarting mid-run**: every VM is stopped at boot before any spawn, the task is marked interrupted, a half-written last mirror line is dropped and the next hello resumes from the mirror's end. Pinned in T7 and T9b.

## Lanes, order and ETA

```
Phase 0  now, beside this fix        T0a (controller, GitHub runner)
Phase 1  one lane, contracts         T1 -> T2
Phase 2  two lanes                   A (pi-host, image inputs): T4 -> T5 -> T9a -> T10a -> T11a -> T11b -> T12 -> T14a -> T14b
                                     B (daemon, pap-vmd; unit tests only): T3 -> T6 -> T7 -> T8b -> T8a -> T9b -> T10b -> T13a -> T13b -> T16a -> T16b
                                     T0b (controller, local) once T12 is on lane A
Phase 3  join                        J1 -> { T15 -> T17 -> T18 }  ||  { T19 }
Phase 4  KVM tail, /dev/kvm here     T20a -> T20b
Phase 5                              T21 -> final review
```

- **Why this cut (red-team §3):** every contract both lanes read is written before they start (R35); lane A owns `packages/pi-host` and the image-input files; lane B owns the daemon, `apps/vmd` and the CLI. Every integration test that needs both sides (the real guest over the real gateway) waits for J1. T14a and T14b add files under `apps/daemon/src/modules/agent-vm/` but never touch its `index.ts` (T15 exports what it uses).
- **Files both lanes touch: none.** The only shared-risk files are `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the knip config, which only T13a changes; `packages/contracts/**` is frozen (R35); `apps/daemon/src/modules/agent-vm/index.ts` and `compose-agents-vm.ts` are lane B's until the join. Two lanes at most (6-core rule, `flock` on `.superpowers/heavy-gate.lock`).
- **T0a record (`docs/research/agents-vm-risk-checks.md`, applied by the controller on 2026-10-19):** pins Kata 4.2.0 (`kata-static` and `kata-tools-static`) and nerdctl-full 2.4.1 with their SHA-256, base `node:24.14.1-trixie-slim@sha256:9707cd4542f400df5078df04f9652a272429112f15202d22b5b8bdd148df494f`; `placement.runtime` = `["--runtime", "io.containerd.kata-clh.v2", "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "--cap-drop", "NET_RAW"]`; `placement.disk` = `["-v", "<volume path>:/agent"]` after `kata-ctl direct-volume add <volume path> '{"volume-type":"directvol","device":"<disk.img>","fstype":"ext4","metadata":{},"options":[]}'` (positional; `blk` and `block` are refused by runtime-rs; no loop device, no host mount; `kata-ctl direct-volume remove <volume path>` at stop), the volume path under `/run/pap-vm/vol/<vm name>`; `rootView` = `"read-only"`; a bridge port is the new `master pap0` link, name before `@`; KVM on standard GitHub runners. Still open for T20a: `VM_OVERHEAD_MB`, the online grow, link handling by `mkfs.ext4 -d` and BuildKit, `static_sandbox_resource_mgmt` under runtime-rs (T0a saw `--memory 1024m` give a 1 GiB guest with the shipped defaults), the cold start on the owner's host (6.3 s median on the nested runner; `GUEST_BOOT_TIMEOUT_MS` 60 s covers it).
- **What T0a gates:** pins (T16b `vm-assets.json`, T14b's base digest); containerd, nerdctl, BuildKit and Kata flags (T13b argv, T16b units and configs); the guest flags for bwrap (T13b `placement.runtime`); the disk flags and the online grow (T13b, T5); how a VM's bridge port is named (T16a); `VM_OVERHEAD_MB` (T7); `rootView` (T11a, T8a); link handling by `mkfs.ext4 -d` and BuildKit (T13a); KVM on GitHub runners (T20b). A task that needs a value T0a has not recorded yet uses the placeholder named in its step and the controller replaces it when the record lands.
- **What T0b gates:** OAuth providers admitted by the relay (a one-line table change with a test in J1 if one passes); the bridge's `model` field (T12's Claude route check, J1); the Claude-token copy (T19).

| Phase | Tasks | Estimate (SDD wall time) |
|---|---|---|
| 0 | T0a | hours, beside the fix and phase 1 |
| 1 | T1, T2 | 0.75 day |
| 2 | lanes A (~29 h) and B (~34 h) | 4 days |
| 3 | J1, then T15, T17, T18 beside T19 | 2 days |
| 4 | T20a, T20b | 1.5 days, from the day `/dev/kvm` exists here |
| 5 | T21, final review | 0.75 day |

**Critical path (honest, RT-48):** T1 → T2 → lane B → J1 → T15 → T17 → T18 → *(the owner enables nested virtualization)* → T20a → T20b → T21 → final review: about 9 working days of SDD wall time, plus the KVM lead time, which only the owner controls. The red-team estimated about 6 days before this fix; the fix adds about 3 (the policy and init integration of RT-01, RT-02 and RT-06, the relay key and gate, anti-spoofing, the safe tree, the token scrub, transcript provenance). If T11b's review drags, lane B may take T14a and T14b once T16b is done (they touch no lane A file).

## Model table (R20, owner Q11; amends decision 112; final per decision 114)

| Task | Implementer | Reviewer |
|---|---|---|
| T0a, T0b | controller | owner |
| T1, T2, T6, T8a, T8b, T9b, T11a, T11b, T12, J1, T13a, T14a, T15, T16a, T17 | Sonnet | **Opus** |
| T3, T4, T5, T7, T9a, T10a, T10b, T13b, T14b, T16b, T18, T19, T20a, T20b, T21 | Sonnet | Sonnet |
| Plan red-team and plan fix | Opus | controller |
| Final whole-branch review | Opus | |

T8 and T9 were split by this fix (T8 for RT-06's size, T9 by lane); each half keeps T8's or T9's Opus reviewer, and J1 carries T12's daemon half (the relay link), so it keeps T12's. Decision 114: T9a (the worker half; the daemon checks every line again in T9b) moved to Sonnet, so 15 Opus reviews. No Haiku (decision 73). Opus escalation at fix rounds 4 and 5 is approved for this run (decision 114): only for a task still blocked after three Sonnet fix rounds, and each one is reported to the owner.

## Seams for sub-projects 2 to 5 (red-team §4)

- **Sub-project 2 (proxy v2):** `VmShellSpec.egressSocket` (T11a) is the per-command proxy socket bind, null in sub-project 1; `AGENT_NET` gains a proxy port, which `agentNetRuleset` adds to the set of ports it answers on the bridge (one line, T1); no vault value is ever in the VM (R11), so values bound to hosts are injected host-side without undoing anything; the relay key (R13) is the identity the proxy reuses; R2's capabilities matter only once apt has a network.
- **Sub-project 3 (policy, default switch):** VM rules carry the fixed `sandbox: {required: true, network: false}` (R15), relaxed in one place (`vm-rules.ts`, T8b); the VM shell tool uses neither `SandboxSpec` nor `bwrapArgv` (R25); taint is reported by the worker and becomes untrusted once a VM is compromised, so decisions at the box's exits (platform ops, `whenTainted`) must not rely on "not tainted" from a VM; prechecks and prompt chips move into the VM (R16); the host-mode refusal of migrated agents (R12) becomes the default; MCP stdio servers and extension subprocesses still run outside bwrap and the file rule (RT-37 residual).
- **Sub-project 4 (backups):** disks live in root-owned `/var/lib/pap-vm` (R3), so backups are pap-vmd ops: `vm.pause` and `vm.resume` stay in the contract with no caller (T1), `disk.snapshot` (`cp --reflink=auto --sparse=always`) and a read stream come later; `pap backup` of `$PAP_HOME` holds mirrors, not disks (topic note); a restore makes the VM's file older, so the resync replaces the mirror, and R14's kept copy makes that reversible.
- **Sub-project 5 (OKF memory):** `layout.knowledge` exists and is bound read-write into the shell; pi-mem0 stays out of VM images (R17); a VM session has no `init.memory`.

---

### Task T0a: Risk checks on a GitHub KVM runner (controller, now)

Runs now, beside the plan fix (R21, owner Q12), through a throwaway workflow on a branch of the public repository (`throwaway/agents-vm-t0a`, `ubuntu-24.04`); the branch and its runs are deleted after. Output: `docs/research/agents-vm-risk-checks.md`, one section per step with the exact commands, versions and results, committed on `main`. Every later task that names "T0a's record" reads it; each step says what it gates.

- [ ] **Step 1: Runner facts.** `ls -l /dev/kvm`; `grep -cE 'vmx|svm' /proc/cpuinfo`; kernel; free RAM and disk. *Gates T20b's CI job (fallback if no KVM: the job runs on this VPS as a self-hosted runner, owner decision).*
- [ ] **Step 2: Pin the stack.** The latest Kata Containers static release and nerdctl-full release at least 14 days old; the official Node linux-x64 tarball of the host's Node version (from its `SHASUMS256.txt`); the official Node image (Debian) of that version by digest. Record version, URL and SHA-256 of each, verified locally. *Gates T16b `vm-assets.json` and T14b's base digest.*
- [ ] **Step 3: Kata + Cloud Hypervisor on pap's own stack** (R5, RT-34, RT-20): containerd with its own config (root, state, socket under scratch paths), nerdctl with `--data-root`, `--cni-path`, `--cni-netconfpath`, BuildKit with `--containerd-worker-addr` building a two-line image into namespace `pap` with `--no-cache`. Record how the Kata shim is pointed at a configuration of pap's own without touching `/etc/kata-containers` (containerd runtime options `ConfigPath`, or the shim's `KATA_CONF_FILE` in the containerd unit's environment). Start a VM with `--memory 1024m` under Kata's default configuration and under `default_memory = 256`, `default_vcpus = 1`, `static_sandbox_resource_mgmt = true`: record the host RSS of the VMM and virtiofsd per VM (median of 5) as `VM_OVERHEAD_MB`, and the cold start (median of 10, risk 7). Record the `nerdctl run` flags under which bwrap 0.11, as the container's root, can create its namespaces (expected `--cap-add SYS_ADMIN --cap-add NET_ADMIN --cap-add SETPCAP --security-opt seccomp=unconfined --security-opt apparmor=unconfined`; never `--privileged`). *Gates T13b argv and `placement.runtime`, T16b units and Kata config, T7's `VM_OVERHEAD_MB`.*
- [ ] **Step 4: The block disk** (spec risk 2, RT-13, RT-14): create a 1 GiB sparse ext4 image with `mkfs.ext4 -d` from a tree holding a relative link, an absolute link and a setuid file; attach it the way Kata documents direct-assigned volumes (`kata-ctl direct-volume add` plus the volume path, or the documented annotation); in the VM check the links are links and the setuid bit is what the tree had; write a file, stop, start a second VM on the same image, read it back. Grow it with `truncate -s +512M` while stopped, start, run `resize2fs $(findmnt -no SOURCE /agent)` as the container's root online: record whether it works and what it needs. Record whether a loop device backs the disk on the host (`losetup -a` while running) and, if so, whether udev probes it (`udevadm monitor` during start). `findmnt` before and after: the host never mounts it. Fallback if direct assignment fails: virtio-blk through the runtime's annotation (record the flags). *Gates T13b's disk flags, T5's online grow, T16b's udev rule (only if a loop device is probed), T13a's link handling.*
- [ ] **Step 5: Bridge, nftables, anti-spoofing** (spec §4, R22, RT-03, RT-21): `pap0` with `10.213.0.1/24` and `disable_ipv6`, the CNI conflist of T1 (`isGateway: false`), the ruleset of T1; start two VMs with `--ip` and `--mac-address`; record how pap-vmd names each VM's bridge port (the peer ifindex of the container network namespace's `eth0`, or the CNI result nerdctl stores: give the command) *(gates T16a)*; add both set elements and permanent neighbour entries. From VM 1: TCP to `10.213.0.1:7841` succeeds (a `nc -l` there), `:22` and VM 2 are dropped, `curl https://example.org` fails; `arping -U -I eth0 -s <VM 2's address> 10.213.0.1` leaves the host's neighbour entry for VM 2 unchanged and VM 2's open gateway connection intact; an IPv6 frame is dropped. From `docker run --rm curlimages/curl` and from the runner's own shell, `10.213.0.1:7842` is dropped (RT-03). `sysctl net.ipv4.ip_forward` is the same before and after (RT-21). Reloading the ruleset empties `ports` (seen in the fix's scratch run): check pap-vmd's re-add restores both VMs. Record `nft list ruleset` counters.
- [ ] **Step 6: The shell inside the VM** (R2, R18, R27): as the container's root, run bwrap with T11a's argv and seccomp file: does `--overlay-src /` work (record; else `rootView: "read-only"`) *(gates T11a, T8a)*; two concurrent shells with two slot uppers; `python3 -c 'import socket; socket.socket(40, 1)'` and `unshare -U true` fail with EPERM; `ls /dev/vsock` fails; `ls /agent/.pi` is empty; `cat /proc/1/environ` shows bwrap's init only. No apt check (R18: sub-project 2).
- [ ] **Step 7: Clean up.** Delete the branch, its workflow and its runs; commit the record (`docs(agents-vm): risk checks on a GitHub KVM runner`).

### Task T0b: Claude token and OAuth providers through the relay (controller, local, no KVM)

Runs once T12 is on lane A's branch (R21). Output appended to T0a's record.

- [ ] **Step 1: The Claude token** (spec risk 6): the owner runs `claude setup-token` once and pastes the token into a 0600 file the controller names under `/tmp/claude-1000/` (never in the repository, never in a log). The controller starts lane A's relay on `127.0.0.1` with a scripted IPC peer that hands it that token and a relay grant for `127.0.0.1`, then runs the bridge's bundled `claude -p "say ok"` with an empty HOME and `ANTHROPIC_BASE_URL=http://claude.internal:<port>`, inside `bwrap --unshare-user --dev-bind / / --ro-bind <scratch hosts file> /etc/hosts` so `claude.internal` resolves to `127.0.0.1`. Record success (never the token) and the `model` field the bridge sends. *Gates J1's Claude-route model check and T19's copy.*
- [ ] **Step 2: OAuth providers** (R9): for each OAuth provider in the owner's `auth.json` (its type only, never a value), drive one Pi request through the relay the same way and record whether the header rule works. A provider that fails stays refused. *Gates the relay's provider table (J1).*
- [ ] **Step 3:** delete the scratch files; commit the record (`docs(agents-vm): the Claude token and OAuth providers through the relay`).

### Task T1: Every contract of the sub-project, and ADR 0078

Widened by the red-team's §3: after T1 and T2 no lane edits `packages/contracts` (R35).

**Files:**
- Create: `packages/contracts/src/agents-resources.ts`, `agents-vm.ts`, `agents-net.ts`, `vmd.ts`, `relay-ipc.ts`, `agents-vm-methods.ts`, `pi-host-records.ts`, tests `agents-vm.test.ts`, `agents-net.test.ts`, `vmd.test.ts`, `relay-ipc.test.ts`, `agents-vm-methods.test.ts`; `docs/adr/0078-agents-run-in-microvms.md`
- Modify: `packages/contracts/src/agents.ts` (three fields, +4), `pi-host.ts` (first move the worker records out, then `vm` on `InitRecord` and the union entries), `agents-safety.ts` (`QUARANTINE_STEPS` gains `"vm"`, +1, RT-41), `streams.ts` (`TranscriptRow.unverified`, +1, R32), `methods.ts` (+2: import and spread `agentsVmMethods`), `index.ts` (exports)

**Interfaces:**
- Produces everything in the code below, plus:
  - `pi-host-records.ts`: the worker-to-daemon records moved from `pi-host.ts` as they are (`ReadyRecord` to `parseWorkerRecord`, `GetStateData`), with `SessionAppend` and `FilePutResult` added to `PapRecord` (a type left out of `PapRecord` would be forwarded as a Pi event). `pi-host.ts` re-exports it (`export * from "./pi-host-records.ts"`). No import cycle: the new file imports nothing from `pi-host.ts` (move or duplicate the small `Id` schema).
  - `pi-host.ts`: `InitRecord` gains `vm: VmInit.optional()`; `DaemonToWorker` gains `SessionResync` and `FilePut`. It ends under 395.
  - `TranscriptRow` gains `unverified: z.literal(true).optional()`: a user entry pap did not send (R32).
  - `agents-vm-methods.ts` (`agentsVmMethods`): `agents.vm.setClaudeToken { token: string 1..512 }` (`pi:admin`, browser only like `models.setApiKey`, `sensitiveParams: ["token"]`, password step-up, errors `step_up_required`, `unavailable`); `agents.vm.clearClaudeToken {}` (same permission and step-up); `agents.vmStatus {}` (`agents:read`) answering `{ runtime: "host" | "vm", usable: boolean, reason: string | null, vmdVersion: string | null, claudeToken: "set" | "missing", agents: Array<{ id: AgentId, phase: "stopped" | "starting" | "running" | "paused" | "stopping", migrated: boolean }> (≤ 32) }`; `agents.purgeTrash { agentId: AgentId }` (`agents:admin`, step-up, RT-40: "Purge now").

- [ ] **Step 1: Write the failing tests** (`agents-vm.test.ts`, `agents-net.test.ts`, `vmd.test.ts`, `relay-ipc.test.ts`, `agents-vm-methods.test.ts`), key assertions (the schema and ruleset cases below were run in the fix's scratch against zod 4.6.5, all but `AgentInput` and the methods):
  - `AgentInput.parse({ name: "A" })` gives `resources` `{ memoryMb: 1024, cpus: 1, diskMb: 4096 }`, `systemPackages` `[]`, `packages` `null`; an old stored profile without these fields still parses.
  - `SystemPackage` accepts `jq`, `python3`, `g++`, `libc6-dev`; refuses `Jq`, `-x`, `a b`, `a;b`, `$(x)`, a 64-character name; `SystemPackages` refuses duplicates and a 65th entry; `PackagePicks` refuses a pick holding code point 0x202E (`String.fromCharCode(0x202e)`) and a duplicate.
  - `AgentResources` refuses `memoryMb: 511`, `diskMb: 65537`, `cpus: 0`, `cpus: 1.5`, unknown keys.
  - `Hello` accepts a guest and a worker hello; refuses a token of 63 or 65 hex characters, upper-case hex, an image tag outside `IMAGE_TAG`, `protocol: 2`, an unknown key, a worker hello without `slot`, a `session.file` of `../s.jsonl`.
  - `SessionAppend` refuses non-base64 `data`, data longer than `SESSION_CHUNK_B64`, a negative offset, a `file` not ending `.jsonl` or holding `/`.
  - `FilePut` refuses names `.x`, `../x`, `a/b`, a name holding code point 0, a 129-character name, data longer than `FILE_CHUNK_B64`.
  - `GuestCommand` `spawn` refuses a relative `sessionFile`; `VmInit` refuses a relative layout path.
  - `VmdRequest`: every operation parses with valid fields; `vm.start` refuses `isolated` without a task key and `thread` with one, `memoryMb` outside `AgentResources`' bounds, an image outside `IMAGE_TAG`, an `env` key, an upper-case token; `disk.create`, `disk.grow` and `disk.populate` refuse any task key and a missing one; `disk.delete` needs `taskKey` (null or a key); `image.build` refuses an apt name outside `SystemPackage` and a `from` that is not a pinned Node digest or a pap tag; an unknown `op` (`run`) and unknown keys are refused.
  - `agentNetRuleset()` equals the fixed text below; `portElement` refuses a port name with `;`, the bridge's own address, `.255`, an address outside `10.213.0.0/24`, a malformed MAC; `cniConflist()` has `isGateway: false`, `ipMasq: false`, `routes: []`. Mutants named in the file: drop the `iifname !=` line, drop the ARP lookup, drop the IPv6 drop (each changes the text the test pins).
  - `RelayCommand` refuses a grant whose address is outside `10.213.0.0/24` and is not `127.0.0.1`, an upper-case key, a provider name with an upper-case letter, an empty Claude token; `RelayReport` parses a usage report.
  - The four methods declare the permissions above; `setClaudeToken` and `clearClaudeToken` require the step-up and are refused to a token caller.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/contracts/src/agents-vm.test.ts packages/contracts/src/agents-net.test.ts packages/contracts/src/vmd.test.ts packages/contracts/src/relay-ipc.test.ts packages/contracts/src/agents-vm-methods.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Write the contracts** (security contract, full code). `agents-resources.ts`:

```ts
import { z } from "zod";

/** Decision 109. Host-dependent ceilings (the memory cap, the host's cores) are checked by the agents service at save (RT-30). */
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
const unique = (items: readonly string[]): boolean => new Set(items).size === items.length;
// The rule of agents.ts' LINE_HIDDEN, kept here: agents.ts imports this file.
const LINE_HIDDEN = /\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/u;

/** A Debian package name (Debian policy 5.6.1), at most 63 characters: it reaches `apt-get install` (R7). */
export const SystemPackage = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,62}$/);
export const SystemPackages = z
  .array(SystemPackage)
  .max(AGENT_VM_LIMITS.systemPackages)
  .refine(unique, "each package once");

/** Package sources exactly as `settings.json` spells them; null: every package of the Pi profile (decision 108 Q4). */
export const PackagePicks = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine((text) => !LINE_HIDDEN.test(text), "visible text on one line"),
  )
  .max(AGENT_VM_LIMITS.packages)
  .refine(unique, "each package once")
  .nullable();
```

  `agents.ts` adds to `AgentInput` (after `trustedSources`), importing the three schemas and `DEFAULT_AGENT_RESOURCES`:

```ts
    resources: AgentResources.default(DEFAULT_AGENT_RESOURCES),
    systemPackages: SystemPackages.default([]),
    packages: PackagePicks.default(null),
```

  `agents-vm.ts`:

```ts
import { z } from "zod";
import { PackagePicks } from "./agents-resources.ts";
import { AgentId } from "./platform.ts";

/** Spec §4, decision 107. Fixed in v1; `pap vm setup` writes the same values. Sub-project 2 adds a proxy port (seam). */
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
/** RT-27: what a connection may send before its hello is accepted, and the gateway's other bounds. */
export const HELLO_MAX_BYTES = 4096;
export const HELLO_TIMEOUT_MS = 10_000;
/** RT-35: how long a started VM's guest has to say hello (a cold Kata start), apart from each connection's hello timeout. */
export const GUEST_BOOT_TIMEOUT_MS = 60_000;
export const GATEWAY_LIMITS = Object.freeze({
  pendingTotal: 16,
  pendingPerSource: 4,
  windowMs: 10_000,
  windowBytes: 64 * 1024 * 1024,
  writeBacklogBytes: 16 * 1024 * 1024,
});
/** R1: raw bytes per `session_append`; base64 makes it 4/3 larger and still under a frame. */
export const SESSION_CHUNK_BYTES = 2 * 1024 * 1024;
export const SESSION_CHUNK_B64 = Math.ceil(SESSION_CHUNK_BYTES / 3) * 4;
export const MAX_SESSION_LINE_BYTES = 32 * 1024 * 1024;
/** R33 (RT-15): `file_put` is chunked like the transcript. */
export const FILE_CHUNK_BYTES = 2 * 1024 * 1024;
export const FILE_CHUNK_B64 = Math.ceil(FILE_CHUNK_BYTES / 3) * 4;
export const GATEWAY_PING_MS = 15_000;
export const GATEWAY_PING_MISSES = 3;
export const IMAGE_TAG = /^pap-agent-(base|profile|agent)-[0-9a-f]{64}$/;

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
export const LaunchId = hex(16);
export const SlotId = hex(16);
export const GatewayToken = hex(32);
/** RT-03, R13: the launch's key for the relay, presented by the worker as its provider credential. Never logged. */
export const RelayKey = hex(32);
const Base64 = /^[A-Za-z0-9+/]*={0,2}$/;
// The rule of pi-host.ts' AbsolutePath, kept here so this file imports nothing of pi-host.ts.
const AbsolutePath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "must be an absolute path");
/** A Pi session file's name in the VM's sessions folder: the mirror keeps the same name (R23, R28). */
export const SessionFileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.jsonl$/);

/** Where things are inside the VM (`/agent/...` under Kata, a temp folder under the process backend). */
export const VmLayout = z
  .object({
    root: AbsolutePath,
    home: AbsolutePath,
    knowledge: AbsolutePath,
    inbox: AbsolutePath,
    pi: AbsolutePath,
    sessions: AbsolutePath,
    /** R28 (RT-07): Pi's writable agent folder on the disk, seeded by the guest from `imageAgentDir` at each start. */
    piAgentDir: AbsolutePath,
    imageAgentDir: AbsolutePath,
    shellOverlay: AbsolutePath,
  })
  .strict();
export type VmLayout = z.infer<typeof VmLayout>;

/** The `vm` field of `init` for a worker in a VM. `init` is never logged: it carries the relay key. */
export const VmInit = z
  .object({
    layout: VmLayout,
    bwrap: AbsolutePath,
    relayKey: RelayKey,
    /** This worker's slot: its shell's own overlay (R27). */
    slot: SlotId,
    /** R27: what T0a showed bwrap can do with the image root as guest root. */
    rootView: z.enum(["overlay", "read-only"]),
  })
  .strict();
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
    /** The file the guest named at spawn, as the VM has it now (spec §11). */
    session: z
      .object({
        file: SessionFileName.nullable(),
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

/** Daemon to guest. `packages`: the agent's picks, written into the worker's Pi settings before the spawn (RT-29). */
export const GuestCommand = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("spawn"), slot: SlotId, sessionFile: AbsolutePath.nullable(), packages: PackagePicks })
    .strict(),
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

/** Worker to daemon (R1): the bytes Pi wrote to `file` from `offset`; `replace` starts that mirror over at offset 0. */
export const SessionAppend = z
  .object({
    type: z.literal("session_append"),
    file: SessionFileName,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(SESSION_CHUNK_B64).regex(Base64),
    replace: z.boolean(),
  })
  .strict();
export type SessionAppend = z.infer<typeof SessionAppend>;
/**
 * Daemon to worker (spec §11, RT-39): send the file again from `fromOffset` when the entry ending there is `lastEntryId`
 * (the mirror is a prefix of the file), else from 0 with `replace`. `fromOffset: 0` always resends the whole file.
 */
export const SessionResync = z
  .object({
    type: z.literal("session_resync"),
    fromOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    lastEntryId: z.string().min(1).max(128).nullable(),
  })
  .strict();
const FileId = z.string().regex(/^[0-9a-f]{32}$/);
/** Daemon to worker: one chunk of an attachment for the inbox (R33); chunks of one `id` come in order, `last` ends it. */
export const FilePut = z
  .object({
    type: z.literal("file_put"),
    id: FileId,
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z.string().max(FILE_CHUNK_B64).regex(Base64),
    last: z.boolean(),
  })
  .strict();
export const FilePutResult = z
  .object({
    type: z.literal("file_put_result"),
    id: FileId,
    ok: z.boolean(),
    code: z.enum(["exists", "too_large", "order", "write_failed"]).optional(),
  })
  .strict();
```

  `agents-net.ts` (R22, RT-03, RT-04, RT-21; loaded and attacked in the fix's scratch, see R22):

```ts
import { AGENT_NET } from "./agents-vm.ts";

export type AgentNet = typeof AGENT_NET;

/** One VM's bridge port, MAC and address, which pap-vmd adds to `ports` at `vm.start` (from the CNI result) and removes at stop. */
export interface VmPort {
  readonly port: string;
  readonly mac: string;
  readonly ip: string;
}
const PORT_NAME = /^[A-Za-z0-9_.-]{1,15}$/;
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const IPV4 = /^10\.213\.0\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/;

/**
 * Spec §4, decision 107 Q4, owner Q13 (R22), RT-03, RT-04, RT-21. The inet table: a VM reaches the gateway and the relay on
 * the bridge address and nothing else; those two ports answer nobody but the bridge (not `lo`, not Docker, not a LAN host
 * that routes to 10.213.0.1); nothing is forwarded to or from the bridge. The bridge table: a frame entering `pap0` from a
 * VM port must carry that port's own MAC and IPv4 address (ARP included); IPv6 is dropped; VM to VM is dropped. Loading it
 * empties `ports`: pap-vmd re-adds the elements of the VMs that run (T16a).
 */
export function agentNetRuleset(net: AgentNet = AGENT_NET): string {
  const ports = `{ ${net.gatewayPort}, ${net.relayPort} }`;
  return `${[
    "table inet pap_agents",
    "delete table inet pap_agents",
    "table inet pap_agents {",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    `    ip daddr ${net.host} tcp dport ${ports} iifname != "${net.bridge}" counter drop`,
    `    iifname "${net.bridge}" ip saddr ${net.subnet} ip daddr ${net.host} tcp dport ${ports} accept`,
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
    "  set ports {",
    "    type ifname . ether_addr . ipv4_addr",
    "  }",
    "  chain prerouting {",
    "    type filter hook prerouting priority -300; policy accept;",
    `    meta ibrname != "${net.bridge}" accept`,
    "    ether type ip6 counter drop",
    "    ether type arp iifname . ether saddr . arp saddr ip @ports iifname . arp saddr ether . arp saddr ip @ports accept",
    "    ether type ip iifname . ether saddr . ip saddr @ports accept",
    "    counter drop",
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    meta ibrname "${net.bridge}" counter drop`,
    "  }",
    "}",
  ].join("\n")}\n`;
}

/** The set element of one VM (added at start, deleted at stop), from checked values only. */
export function portElement(vm: VmPort): string {
  if (!PORT_NAME.test(vm.port) || !MAC.test(vm.mac) || !IPV4.test(vm.ip)) throw new RangeError("vm port");
  return `{ "${vm.port}" . ${vm.mac} . ${vm.ip} }`;
}

export function cniConflist(net: AgentNet = AGENT_NET): string {
  return JSON.stringify(
    {
      cniVersion: "1.0.0",
      name: net.network,
      plugins: [
        {
          type: "bridge",
          bridge: net.bridge,
          // RT-21: a gateway bridge turns on host-wide IPv4 forwarding; the address is set by pap-vmd.service's ExecStartPre.
          isGateway: false,
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

  `vmd.ts` (the whole request surface of pap-vmd, R3, R7, R8, R30):

```ts
import { z } from "zod";
import { AgentResources, SystemPackage } from "./agents-resources.ts";
import { GatewayToken, IMAGE_TAG, LaunchId } from "./agents-vm.ts";
import { AgentId } from "./platform.ts";

/** RT-33: one request per connection, at most this large; pap-vmd reads no more. */
export const VMD_MAX_FRAME_BYTES = 64 * 1024;
const Tag = z.string().regex(IMAGE_TAG);
const NodeImage = z.string().regex(/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/);
const Kind = z.enum(["thread", "isolated"]);
/** An isolated task's key (a task uuid without dashes). Its VM is `pap-<agent id>-<key>`, its disk pap-vmd's own (R30). */
export const TaskKey = z.string().regex(/^[0-9a-f]{32}$/);
const agent = { agentId: AgentId };
/** Every disk op names its disk (R30, RT-05): the agent's (`taskKey: null`); only `disk.delete` may name a task's. */
const agentDisk = { agentId: AgentId, taskKey: z.null() };

/**
 * The whole request surface of pap-vmd (R3, R7, R8, R30). No path, command, Dockerfile text or environment comes from the
 * daemon: pap-vmd derives every path from these fields and its own config. `kind: "isolated"` gets a blank disk pap-vmd
 * creates at `vm.start` and deletes at its `vm.stop`; `isolated` and `taskKey` go together. `disk.create`, `disk.grow` and
 * `disk.populate` take the agent's disk only; `disk.delete` with a task key removes a task disk a crash left behind.
 */
export const VmdRequest = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("vm.start"),
      ...agent,
      kind: Kind,
      taskKey: TaskKey.nullable(),
      image: Tag,
      resources: AgentResources,
      launchId: LaunchId,
      token: GatewayToken,
    })
    .strict()
    .refine((request) => (request.kind === "isolated") === (request.taskKey !== null), "isolated iff taskKey"),
  z.object({ op: z.literal("vm.stop"), ...agent, taskKey: TaskKey.nullable() }).strict(),
  // Sub-project 4's seam (page 03): no caller in sub-project 1.
  z.object({ op: z.literal("vm.pause"), ...agent }).strict(),
  z.object({ op: z.literal("vm.resume"), ...agent }).strict(),
  z.object({ op: z.literal("vm.status"), ...agent, taskKey: TaskKey.nullable() }).strict(),
  z.object({ op: z.literal("vm.list") }).strict(),
  z.object({ op: z.literal("disk.create"), ...agentDisk, diskMb: AgentResources.shape.diskMb }).strict(),
  z.object({ op: z.literal("disk.grow"), ...agentDisk, diskMb: AgentResources.shape.diskMb }).strict(),
  z.object({ op: z.literal("disk.delete"), ...agent, taskKey: TaskKey.nullable(), purge: z.boolean() }).strict(),
  z.object({ op: z.literal("disk.populate"), ...agentDisk, staging: z.literal("migration") }).strict(),
  /** RT-40: `agentId` null purges every trash entry older than 7 days; an id purges that agent's entries now ("Purge now"). */
  z.object({ op: z.literal("trash.purge"), agentId: AgentId.nullable() }).strict(),
  z
    .object({
      op: z.literal("image.build"),
      layer: z.enum(["base", "profile", "agent"]),
      tag: Tag,
      from: z.union([Tag, NodeImage]),
      aptPackages: z.array(SystemPackage).max(64),
      upgrade: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("image.list") }).strict(),
  z.object({ op: z.literal("image.prune"), keep: z.array(Tag).max(256) }).strict(),
  z.object({ op: z.literal("version") }).strict(),
  /** RT-40: the facts `pap doctor` cannot read as pap's user (ruleset, bridge, root disk room). */
  z.object({ op: z.literal("vmd.health") }).strict(),
]);
export type VmdRequest = z.infer<typeof VmdRequest>;

export const VmState = z.enum(["absent", "starting", "running", "paused", "stopped"]);
/** `vm.start`'s result: the bridge address pap-vmd gave the VM (the relay binds the launch's key to it, R13). */
export const VmStartResult = z.object({ address: z.string().regex(/^10\.213\.0\.\d{1,3}$/) }).strict();
export const VmdHealth = z
  .object({
    version: z.string().max(64),
    ruleset: z.boolean(),
    bridge: z.boolean(),
    stateFreeMb: z.number().int().min(0),
  })
  .strict();
export const VmdResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["bad_request", "not_found", "conflict", "capacity", "disk_low", "unavailable", "failed"]),
    })
    .strict(),
]);
```

  `relay-ipc.ts` (R13: the daemon and its relay child; both sides parse every message):

```ts
import { z } from "zod";
import { LaunchId, RelayKey } from "./agents-vm.ts";
import { AgentId } from "./platform.ts";

const Provider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const ModelIdText = z.string().min(1).max(256);
/** R13: what the daemon tells its relay child over IPC. Never logged (grants and the Claude token are secrets). */
export const RelayCommand = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("relay_grant"),
      launchId: LaunchId,
      agentId: AgentId,
      key: RelayKey,
      address: z.string().regex(/^(?:10\.213\.0\.\d{1,3}|127\.0\.0\.1)$/),
    })
    .strict(),
  z.object({ type: z.literal("relay_revoke"), launchId: LaunchId }).strict(),
  z
    .object({
      type: z.literal("agent_policy"),
      agentId: AgentId,
      /** The models the agent's picker offers (ADR 0068), at most 512 pairs; the bridge's models make `claude` true. */
      models: z.array(z.object({ provider: Provider, id: ModelIdText }).strict()).max(512),
      claude: z.boolean(),
      blocked: z.enum(["paused", "budget"]).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("claude_token"), token: z.string().min(1).max(512).nullable() }).strict(),
]);
export type RelayCommand = z.infer<typeof RelayCommand>;
/** What the relay child reports: its port once listening, and counts per agent every 60 s (attribution, RT-17). */
export const RelayReport = z.discriminatedUnion("type", [
  z.object({ type: z.literal("relay_ready"), port: z.number().int().min(1).max(65_535) }).strict(),
  z
    .object({
      type: z.literal("relay_usage"),
      agents: z
        .array(
          z
            .object({
              agentId: AgentId,
              requests: z.number().int().min(0),
              refused: z.number().int().min(0),
              bytesIn: z.number().int().min(0),
              bytesOut: z.number().int().min(0),
            })
            .strict(),
        )
        .max(64),
    })
    .strict(),
]);
```

  Fixed by this contract: the build contexts and the migration staging are folders pap-vmd computes itself from fixed names (`$PAP_HOME/vm/build/<layer>/`, `$PAP_HOME/vm/staging/<agentId>/`, the `PAP_HOME` of its own config file), never a path from a request. `vm.start` carries the token for pap-vmd's env file (R8); it is never logged.
- [ ] **Step 4: ADR 0078** (`docs/adr/0078-agents-run-in-microvms.md`): context (the CyberLooker report, spec §2), decision (spec §3 to §13 and rulings R1 to R38 by reference), consequences (KVM required for agents; a root service; ADR 0048's host sandbox kept for `PAP_AGENTS_RUNTIME=host` until sub-project 3; R23's mirror path and R25's code location amend the spec), status "accepted, sub-project 1".
- [ ] **Step 5: Run** the five test files, `pnpm vitest run --project unit packages/contracts` and `pnpm --filter @pap/contracts build && pnpm typecheck`. Expected: PASS, the existing contract tests unchanged.
- [ ] **Step 6: Commit** `feat(contracts): agent VM resources, records, network, relay and the pap-vmd surface`.

### Task T2: The socket frame codec

**Files:**
- Create: `packages/contracts/src/socket-frames.ts`, `packages/contracts/src/socket-frames.test.ts`
- Modify: `packages/contracts/src/index.ts` (one export)

**Interfaces:**
- Produces: `encodeFrame(value: unknown): Buffer` (throws `RangeError` over `MAX_FRAME_BYTES`), `createFrameDecoder(options: { maxBytes(): number; onFrame(value: unknown): void; onError(error: "too_large" | "bad_json"): void }): { push(chunk: Buffer): void }`. `maxBytes` is read at each header (RT-27: the gateway holds a connection to `HELLO_MAX_BYTES` until its hello is accepted).

- [ ] **Step 1: Failing tests**, key assertions (all run in the fix's scratch): a frame split across 1-byte chunks decodes once; three frames in one chunk decode in order; a header announcing `maxBytes() + 1` calls `onError("too_large")` on the 4 header bytes alone and nothing is delivered afterwards, even valid frames; a bound of 4096 refuses a 5000-byte hello and, raised to `MAX_FRAME_BYTES` after the first frame, accepts a 100 KB second frame; invalid JSON and a zero-length frame call `onError("bad_json")` once and stop; a 4 MiB frame in 64 KiB chunks decodes with at most two `Buffer.concat` calls (spy); `encodeFrame` of a value whose JSON is `MAX_FRAME_BYTES + 1` bytes throws. Mutant named in the file: a decoder that checks the bound after buffering the body.
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
 * Length-prefixed JSON frames. A declared length over `maxBytes()` fails on the header, before any body byte is kept (the
 * receive-side bound Node's IPC never had, R101). `maxBytes` is read at each header, so the gateway can hold a connection to
 * HELLO_MAX_BYTES until its hello is accepted (RT-27). After a failure nothing more is delivered; the caller closes the socket.
 */
export function createFrameDecoder(options: {
  maxBytes(): number;
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
          if (need > options.maxBytes()) return fail("too_large");
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

### Task T3: Extract the worker record core from `spawnWorker` (lane B)

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

### Task T4: pi-host over a socket (lane A)

**Files:**
- Create: `packages/pi-host/src/socket-ipc.ts`, `socket-ipc.test.ts`, `transport.ts`, `transport.test.ts`, `transport.int.test.ts`
- Modify: `packages/pi-host/src/main.ts` (choose the transport: at most +6 lines)

**Interfaces:**
- Consumes: T1 `WorkerHello`, `TransportPing/Pong`, `GATEWAY_PING_MS`, `GatewayToken`; T2 codec.
- Produces: `createSocketIpc(socket: net.Socket, hello: WorkerHello): Ipc` (the `Ipc` of `ipc.ts`, same `MAX_RECORD_BYTES` refusal and `response` fallback as `createIpc`; a `RangeError` from `encodeFrame` is caught and `send` returns false); `TOKEN_FD = 3`; `transportFromEnv(env: NodeJS.ProcessEnv, readToken = () => readFileSync(TOKEN_FD, "utf8")): Promise<Ipc>` in `transport.ts`: with `PAP_WORKER_TRANSPORT=socket` it reads the token once from fd 3 (written by the guest, then closed; checked against `GatewayToken`, else it exits 70), reads `PAP_GATEWAY` (`host:port`), `PAP_LAUNCH_ID`, `PAP_AGENT_ID`, `PAP_WORKER_SLOT`, `PAP_IMAGE_TAG`, `PAP_SESSION_FILE`, deletes them from `process.env`, connects, and sends the hello with `session` from `sessionFacts(path)` (file name, last entry id and size of the file the guest named; `{ file: null, lastEntryId: null, size: 0 }` when absent); otherwise it returns `createIpc(process)`. The token is never in this process's environment (R24).

- [ ] **Step 1: Tests**, key assertions: the token comes from `readToken`, never from `env`, and a malformed one stops the worker; after `transportFromEnv`, none of the six names is in `process.env`; the first frame on the socket is the hello; a `ping` from the daemon gets a `pong` and never reaches `onMessage`; a frame over `MAX_FRAME_BYTES` from the daemon closes the socket and fires `onDisconnect` once; `send` of a record over `MAX_RECORD_BYTES` returns false and sends the same small `response` failure `createIpc` sends. `transport.int.test.ts`: a real child started like the guest starts it (token on fd 3, the other variables in its environment) reads its own `/proc/self/environ` and finds no token and no `PAP_GATEWAY_TOKEN`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts`: `runHost(await transportFromEnv(process.env))`; keep `close-inherited-fds.ts` first (it closes pty descriptors only; fd 3 is a pipe); the parent watchdog stays for the IPC transport only (a socket worker's parent is the guest, which kills its workers when it dies).
- [ ] **Step 4: Run** the tests and `pnpm vitest run --project unit packages/pi-host/src/ipc.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pi-host): a socket transport for workers in a VM`.

### Task T5: The guest supervisor (`pap-guest`) (lane A)

**Files:**
- Create: `packages/pi-host/src/guest/main.ts`, `guest.ts`, `guest.test.ts`, `scrub.ts`, `scrub.test.ts`, `seed.ts`, `seed.test.ts`, `grow.ts`, `grow.test.ts`
- Modify: `packages/pi-host/package.json` (export `"./guest"`: `development` `./src/guest/main.ts`, `default` `./dist/guest/main.js`)

**Interfaces:**
- Consumes: T1 `GuestHello`, `GuestCommand`, `GuestReport`, `VmLayout`, `GUEST_BOOT_TIMEOUT_MS`; T2 codec; T4 `TOKEN_FD`.
- Produces:
  - `scrub.ts` (R24, run in the fix's scratch): the entry's first act. With `PAP_GATEWAY_TOKEN` in the environment, it writes the token to `<run>/pap/launch` (folder 0700, file `O_CREAT | O_EXCL | O_NOFOLLOW`, 0600; `<run>` is `/run` under Kata, the process backend's temp `run/`) and re-executes itself without it (`process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], envWithoutToken)`); the new image reads the file once, unlinks it and keeps the token in memory. `/proc/self/environ` of the guest then holds no token.
  - `runGuest(deps: { env; token: string; layout: VmLayout; connect(address: string): net.Socket; spawn(slot: string, env: NodeJS.ProcessEnv): ChildProcess; clock; seed(): void; pick(packages: PackagePicks): void; grow(): Promise<void> }): Promise<void>`:
    - At start: `grow()` (RT-14, R31: when the block device under `layout.root` is larger than its file system, `execFile("resize2fs", [device])` with a fixed argv; the device from `findmnt -no SOURCE <root>`; a failure is logged and the guest goes on); `seed()` (`seed.ts`, R28: copies every file of `layout.imageAgentDir` over `layout.piAgentDir`, each written `O_NOFOLLOW` into a folder it opened itself, so image-owned files are replaced and Pi's own state is kept); then it dials the gateway, retrying every second until `GUEST_BOOT_TIMEOUT_MS` (the bridge port's set element may lag the boot: frames are dropped until it exists), and sends the guest hello.
    - On `spawn {slot, sessionFile, packages}`: `pick(packages)` (RT-29: rewrites `settings.json`'s `packages` in `layout.piAgentDir` to the agent's picks when they are not null, from the image's list), then spawns the pi-host entry with `stdio: ["ignore", "pipe", "pipe", "pipe"]`, writes the token to fd 3 and ends it, env = the guest's (already scrubbed) plus `PAP_WORKER_TRANSPORT=socket`, the gateway variables, `PAP_WORKER_SLOT`, `PAP_SESSION_FILE`, `PI_CODING_AGENT_DIR=layout.piAgentDir`, `GIT_CEILING_DIRECTORIES=layout.root` (RT-37), cwd `layout.home`; replies `spawned`. A slot already live is ignored and logged; a slot spawned before is never spawned again (RT-35).
    - On `signal`: signals that worker's process group. On `shutdown`: SIGTERM all, SIGKILL after `WORKER_SHUTDOWN_GRACE_MS` (the daemon's ladder value), then exits 0.
    - Keeps an 8 KiB tail of each worker's stdout and stderr and sends `exited {slot, code, signal, tail}`.
    - If the gateway connection closes, it kills every worker and exits 1: Kata then stops the VM. That is how a daemon shutdown or crash stops every VM (RT-47; spec §8 "arrêt de pap").

- [ ] **Step 1: Tests** (fake `spawn` and socket, steppable clock), key assertions: `scrub` writes the 0600 file and calls `execve` with an environment that has no `PAP_GATEWAY_TOKEN` (fake `execve`); a second scrub with the file already there refuses (`O_EXCL`); hello first; a refused dial is retried until `GUEST_BOOT_TIMEOUT_MS`, then the guest exits 1; `spawn` writes the token to the child's fd 3, never to its env; the child's env has `PI_CODING_AGENT_DIR` and `GIT_CEILING_DIRECTORIES`; `seed` replaces an image file the worker changed and keeps a file only the worker made, and refuses a link in place of the agent folder; `pick` writes the picks into `settings.json` and leaves every package for `null`; `grow` runs `resize2fs` with the device only when the device is larger; `exited` carries the tail; a second `spawn` of a live slot spawns nothing; `shutdown` signals every worker then exits; a closed gateway kills the workers and exits 1; an unknown command frame is dropped and logged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pi-host): pap-guest, the supervisor inside an agent VM`.

### Task T6: The daemon's gateway, launch tokens and the VM worker handle (lane B, unit tests; the integration test runs in J1)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/` with `index.ts`, `tokens.ts`, `tokens.test.ts`, `gateway.ts`, `gateway.test.ts`, `gateway-limits.ts`, `gateway-limits.test.ts`, `vm-worker.ts`, `vm-worker.test.ts`, `guest-link.ts`

**Interfaces:**
- Consumes: T1, T2, T3 `createWorkerCore`.
- Produces:

```ts
export interface Gateway {
  /** Listens on `host:port` (the bridge address under Kata, 127.0.0.1:0 under the process backend). */
  listen(host: string, port: number): Promise<{ port: number }>;
  /** Resolves when the guest of this launch has said hello; rejects `timeout` after GUEST_BOOT_TIMEOUT_MS (RT-35). */
  awaitGuest(launchId: string): Promise<GuestLink>;
  close(): Promise<void>;
}
/** What a worker's handle needs to keep its session mirror (T9b implements it). */
export interface WorkerSpawnInput {
  /** The VM file the guest names at spawn (a reopen), or null (a new session). */
  readonly sessionFile: string | null;
  /** The mirror of `file`, opened at the hello (a reopen) or at the first `session_append` (a new session, R28). */
  mirrorFor(file: string): MirrorPort | "refused";
  /** Every prompt, steer and follow-up text sent to this worker (R32). */
  sent(text: string): void;
}
export interface MirrorPort {
  facts(): { size: number; lastEntryId: string | null };
  onSessionAppend(append: SessionAppend): "ok" | { resync: SessionResync } | "refused";
}
export interface GuestLink {
  /** Asks the guest to start a worker; resolves once the worker's hello arrived (`init` is sent after, never dropped). */
  spawnWorker(input: WorkerSpawnInput, packages: PackagePicks): Promise<WorkerHandle>;
  shutdown(): void;
  readonly closed: Promise<void>;
}
export function createGateway(deps: { tokens: LaunchTokens; clock: Clock; logger: Logger; imageOf(launchId: string): string | null }): Gateway;
```

  `vm-worker.ts` implements `WorkerHandle` over the worker's socket and the guest link: `send` and `request` through T3's core with `encodeFrame` (a `RangeError` is caught: `send` returns false, RT-15); `prompt`/`steer`/`follow_up` texts go to `input.sent` before they are sent; `stop()` sends `shutdown` to the worker, then `signal SIGTERM` and `SIGKILL` to the guest on the existing kill-ladder timings; `exited` resolves from the guest's `exited` report or the socket's close (whichever first; `cause` `"signal"` or `"exit"` as `classifyExit` gives); `outputTail()` returns the guest's tail; `pid` is `undefined`; `piFile()` is the mirror's path once open. A socket whose `writableLength` passes `GATEWAY_LIMITS.writeBacklogBytes` is closed and the worker is dead (a VM that never reads).

  `gateway-limits.ts` (RT-27): before its hello a connection may send at most `HELLO_MAX_BYTES` (the decoder's `maxBytes()` answers that until the hello is accepted, then `MAX_FRAME_BYTES`); at most `GATEWAY_LIMITS.pendingTotal` connections wait for a hello, `pendingPerSource` from one address (more are closed at accept); each connection may read `windowBytes` per `windowMs` (steppable clock), past that the socket is paused until the window turns. A slot connects once in its lifetime, even after it closed (RT-35).

- [ ] **Step 1: Token tests** (`tokens.ts` is the contract, full code below; run in the fix's scratch), key assertions: `check` is true for an issued pair as long as it is not revoked (the guest and every worker of the launch present the same token); false for another agent id, a revoked launch, a token with one changed character, a token of another length or non-hex; `issue` gives a relay key distinct from the token, 64 hex; the comparison uses `timingSafeEqual` (spy). Mutant named in the file: drop the agent-id check.

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface LaunchTokens {
  /** One launch: its id, the gateway token (the guest and every worker of the VM present it) and the relay key (R13). */
  issue(agentId: string): { launchId: string; token: string; relayKey: string };
  check(agentId: string, launchId: string, token: string): boolean;
  revoke(launchId: string): void;
}

export function createLaunchTokens(): LaunchTokens {
  const live = new Map<string, { agentId: string; token: Buffer }>();
  return {
    issue(agentId) {
      const launchId = randomBytes(16).toString("hex");
      const token = randomBytes(32);
      live.set(launchId, { agentId, token });
      return { launchId, token: token.toString("hex"), relayKey: randomBytes(32).toString("hex") };
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

- [ ] **Step 2: Gateway tests** (unit, fake sockets, steppable clock), key assertions (Review Focus 2):
  - the first frame must be a `Hello` that parses; anything else, a first frame over 4 KiB, or nothing within `HELLO_TIMEOUT_MS`, closes and logs `agent_gateway_refused {agentId|null, reason}` with `reason` one of `bad_hello`, `too_large`, `timeout`, `token`, `protocol`, `image`, `slot`, `duplicate`, `busy`;
  - a valid token for agent A presented with agent B's id is `token`; a revoked launch is `token`;
  - a guest hello for a launch that already has a guest is `duplicate`;
  - a worker hello whose slot was not asked by `spawnWorker` is `slot`; the same slot twice, or again after it closed, is `duplicate`;
  - `imageTag` different from `imageOf(launchId)` is `image` (two VMs of one agent, thread and isolated task, may run different images);
  - the 17th waiting connection, or the 5th from one address, is closed (`busy`); a connection past its byte window is paused, then resumes when the clock moves past the window;
  - `spawnWorker` resolves only after the worker's hello; `awaitGuest` rejects `timeout` after `GUEST_BOOT_TIMEOUT_MS`, separately from the 10 s per-connection hello;
  - no token, no record content and no host appears in any log line (assert the logger's records);
  - pings every `GATEWAY_PING_MS` (steppable clock); three without a pong close the connection and the handle's `exited` resolves;
  - a socket whose backlog passes `writeBacklogBytes` is closed and its handle exits.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** `tokens.ts`, `gateway.ts`, `gateway-limits.ts`, `guest-link.ts`, `vm-worker.ts`.
- [ ] **Step 5: Run** the unit tests. Expected: PASS. (`gateway.int.test.ts`, with the real guest of T5, is written and run in J1.)
- [ ] **Step 6: Commit** `feat(daemon): the agent gateway, launch tokens and VM worker handles`.

### Task T7: The `AgentRuntime` port, the process backend and VM lifecycle (lane B, unit tests; the process-backend integration test runs in J1)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/runtime.ts`, `runtime.test.ts`, `layouts.ts`, `layouts.test.ts`, `process-backend.ts`, `lifecycle.ts`, `lifecycle.test.ts`, `apps/daemon/src/kernel/config-agents-vm.ts`, `config-agents-vm.test.ts`
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
export interface LaunchGrant {
  readonly launchId: string;
  readonly agentId: string;
  readonly relayKey: string;
  /** The VM's bridge address from `vm.start` (127.0.0.1 under the process backend). */
  readonly address: string;
}
export interface AgentRuntimeBackend {
  start(spec: VmSpec, launch: { launchId: string; token: string }): Promise<{ address: string }>;
  stop(agentId: string, taskKey: string | null): Promise<void>;
  list(): Promise<Array<{ agentId: string; taskKey: string | null }>>;
}
export interface AgentRuntime {
  /** Starts the agent's VM if needed (one per agent; an isolated task gets its own) and a worker in it. Waits for boot's stopAll. */
  spawn(spec: VmSpec, worker: WorkerSpawnInput, packages: PackagePicks): Promise<{ handle: WorkerHandle; layout: VmLayout; relayKey: string; slot: string }>;
  phase(agentId: string): VmPhase;
  stop(agentId: string): Promise<void>;
  /** Boot (spec §8, decision 109 Q4): stop every VM the backend lists, before any spawn runs (RT-42). */
  stopAll(): Promise<void>;
}
export function createAgentRuntime(deps: {
  backend: AgentRuntimeBackend;
  gateway: Gateway;
  tokens: LaunchTokens;
  clock: Clock;
  logger: Logger;
  memoryCapMb: number;
  /** R13: the relay learns a launch at its start and forgets it at its stop (J1 wires the relay link). */
  onLaunch(grant: LaunchGrant): void;
  onLaunchEnd(launchId: string): void;
  /** 3 crashes in 10 minutes (RT-40): the agent's existing pause with the reason `crashed` and an Inbox item. */
  onCrashPause(agentId: string): void;
  notifyCapacity(running: string[]): void;
}): AgentRuntime;
/** Where things are in a VM of this backend: Kata's fixed `/agent/...`, or the process backend's temp root (pure, R28). */
export function layoutOf(backend: "kata" | "process", papHome: string, spec: Pick<VmSpec, "agentId" | "taskKey">): VmLayout;
```

  Config (`config-agents-vm.ts`): `PAP_AGENTS_RUNTIME` = `host` (default) | `vm`; `PAP_AGENTS_MEMORY_MAX_MB` (default `floor(totalmem/2)` in MiB, at least 1024; lower stops the boot); `PAP_TEST_AGENT_RUNTIME` = `process` (needs `PAP_TEST_PROVIDER_SCRIPT`, else `ConfigError`); `VM_OVERHEAD_MB` (a constant, 512 until T0a's record gives the measured value, R29).

- [ ] **Step 1: Tests** (`runtime.test.ts`, `lifecycle.test.ts`, `layouts.test.ts`, fake backend and gateway, steppable clock), key assertions:
  - two `spawn`s for the same agent start one VM and two workers; an isolated spawn starts a second VM keyed by its task;
  - a start whose `memoryMb + VM_OVERHEAD_MB` plus the running VMs' total exceeds `memoryCapMb` throws `PapError("capacity")` and calls `notifyCapacity` with the running agent ids (R29);
  - a `spawn` issued during boot waits for `stopAll` to finish (RT-42);
  - `onLaunch` gets the grant with the address `start` returned, before the guest link is awaited; `onLaunchEnd` and the token revoke run when the VM stops, crashes or fails to start;
  - the VM stops `PAP_WORKER_IDLE_MINUTES` after its last worker exits, never while a worker lives;
  - a VM that exits with workers alive is a crash: the workers' handles resolve `exited`; 3 crashes within 10 minutes call `onCrashPause`, and the fourth spawn throws `agent_paused` (the pause is the agent's existing one, persisted; Resume clears it);
  - `stopAll` stops every listed VM, including ones this daemon never started (Review Focus 5);
  - `layoutOf("kata", …)` is `{ root: "/agent", home: "/agent/home", knowledge: "/agent/knowledge", inbox: "/agent/inbox", pi: "/agent/.pi", sessions: "/agent/.pi/sessions", piAgentDir: "/agent/.pi/agent", imageAgentDir: "/opt/pap/pi-agent", shellOverlay: "/run/pap-shell" }` for a thread and an isolated task alike (each VM has its own `/agent`); the process layout is under `$PAP_HOME/tmp/agent-vm/<agent id>[-<task key>]/`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `runtime.ts`, `lifecycle.ts`, `layouts.ts`, the config part.
- [ ] **Step 4: Process backend** (`process-backend.ts`): `start` makes the layout folders under the temp root, copies a test image agent folder into `imageAgentDir` and makes it read-only (0555 folders, 0444 files), so a write Pi would make into it fails here as on Kata's read-only root (RT-07); runs the guest entry as a child process with the gateway variables and `PAP_GATEWAY_TOKEN` in its environment (the guest scrubs it, R24), cwd the layout's home; answers `{ address: "127.0.0.1" }`; `stop` signals it; `list` returns what it started. Refused unless `PAP_TEST_AGENT_RUNTIME=process`. Its integration test (spawn, prompt, idle stop, crash then restart, the daemon's gateway closing ends the guest, RT-47) is written and run in J1.
- [ ] **Step 5: Run** the unit tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(daemon): the agent runtime port, its lifecycle and the test process backend`.

### Task T8a: Agent sessions launch through the runtime (lane B, unit tests; the integration test runs in J1)

Split from T8 by this fix (RT-06's size); the rules and `init` a VM session gets are T8b's, done first in the lane.

**Files:**
- Create: `apps/daemon/src/modules/sessions/vm-launch.ts`, `vm-launch.test.ts`, `apps/daemon/src/modules/sessions/vm-gate.ts`, `vm-gate.test.ts`, `apps/daemon/src/compose-agents-vm.ts`, `compose-agents-vm.test.ts`
- Modify: `apps/daemon/src/modules/sessions/service-launch.ts` (the VM branch at the `deps.spawn` call and R38's check: at most +6 lines), `apps/daemon/src/modules/sessions/agent-gate.ts` (VM mode calls `vmGate`: at most +4 lines), `apps/daemon/src/modules/sessions/worker-room.ts` (R29: a VM launch skips the free-memory floor, +1), `apps/daemon/src/modules/sessions/service-types.ts` (an optional `vmLaunch` dep: +3 lines), `apps/daemon/src/modules/sessions/automation-port.ts` (R38: `sandboxed()` counts a VM session, +1), `apps/daemon/src/daemon.ts` (call the compose: +3 lines)

**Interfaces:**
- Consumes: T7 `AgentRuntime`, `layoutOf`; T8b `vmInitOf`, `mirrorPathOf`; T9b's `WorkerSpawnInput` factory (until T9b lands, a stub that refuses appends, replaced in T9b).
- Produces:
  - `vmGate(row, deps): Promise<AgentLaunch>` (in VM mode, in place of the host gate's probe, host home, sandbox spec, vault, one-use values and egress): the agent profile (not found, quarantined and paused refuse as today), the role, and `vm: true`; it creates `$PAP_HOME/agents/.mirrors/<id>/` 0700 when missing and refuses a link there (`invalid_cwd`). It never opens the agent's host home (RT-08: after migration it is empty).
  - `createVmLaunch(deps): { spawn(row, launch: AgentLaunch, init: InitRecord): Promise<WorkerHandle> }`: the `VmSpec` from the profile (`resources`) and the row (thread, child and thread task: kind `thread`, the agent's VM; an isolated task: kind `isolated`, `taskKey` = its task id without dashes); `runtime.spawn(spec, mirrors.inputFor(row), input.packages)`; then `handle.send(vmInitOf(init, { layout, bwrap: VM_BWRAP, relayKey, slot, rootView: VM_ROOT_VIEW }, mirrorFileOf(row)))`. `VM_BWRAP` is `/usr/bin/bwrap` (the image's), `VM_ROOT_VIEW` T0a's value (`overlay` until recorded).
  - `compose-agents-vm.ts`: in `vm` mode, the tokens, the gateway (listening at boot, before the daemon accepts any connection, so no local user can take 7841 first, RT-35), the runtime with the process backend under the test switch (the Kata backend arrives in T15), and the boot `stopAll`. In `host` mode it composes nothing.
  - `service-launch.ts`: an agent session in `vm` mode starts through `vmLaunch.spawn` instead of `deps.spawn`; R38: `ctx.sandboxedOnly.has(row.id) && agentLaunch?.sandbox === undefined && agentLaunch?.vm !== true` throws `sandbox_unavailable`. `PAP_MAX_WORKERS` still counts VM workers (R29).
- Before writing `vm-launch.ts`, list every pi-host use of `init.papHome`, `init.agentDir`, `init.cwd` and host paths in records (`rg -n "papHome|agentDir" packages/pi-host/src -g '!*.test.ts'`) and record in the task report, for each, what the VM value means and which task (T8b, T9a, T10a, T11b) handles it.

- [ ] **Step 1: Tests**, key assertions: in `PAP_AGENTS_RUNTIME=host` the launch path is byte-for-byte today's (existing tests stay green, `vmLaunch` absent); in `vm` an agent thread, a child and a thread task spawn through the runtime with kind `thread`, an isolated task with kind `isolated` and its key, and a plain session still forks; `vmGate` never calls the bwrap probe and never touches the host home (fake fs records every path); a full-access continuation (`sandboxedOnly`) of a VM thread starts (RT-10, R38) while the same of a host agent without a sandbox still throws `sandbox_unavailable`; `automation-port`'s `sandboxed()` is true for a live VM session; a VM launch passes `checkCapacity` with the free-memory floor unmet but fails at `PAP_MAX_WORKERS`; the gateway listens before the compose returns.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `vm-gate.ts`, `vm-launch.ts`, the compose and the wiring.
- [ ] **Step 4: Run** the touched unit suites (`pnpm vitest run --project unit apps/daemon/src/modules/sessions apps/daemon/src/compose-agents-vm.test.ts`). Expected: PASS. (`vm-launch.int.test.ts` is written and run in J1.)
- [ ] **Step 5: Commit** `feat(daemon): agent sessions launch in their VM under PAP_AGENTS_RUNTIME=vm`.

### Task T8b: What a VM session gets: rules, `init` and the refusals (lane B, before T8a)

New task from RT-06 (red-team §1: "a real policy and init integration ... may become its own task"); the pi-host half is T11b.

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/vm-init.ts`, `vm-init.test.ts`, `mirror-paths.ts`, `mirror-paths.test.ts`, `apps/daemon/src/modules/sessions/vm-rules.ts`, `vm-rules.test.ts`, `apps/daemon/src/modules/agents/resources-check.ts`, `resources-check.test.ts`
- Modify: `apps/daemon/src/modules/sessions/agent-rules.ts` (VM parts when the row runs in a VM: +4), `apps/daemon/src/modules/sessions/agent-surface.ts` (R11: no `secret.request` op and no `vault_update` for a VM session, +2), `apps/daemon/src/modules/sessions/agent-gate.ts` (R16: `agentPrecheckSandbox` refuses a VM agent, +2), `apps/daemon/src/modules/agents/prompts.ts` (R16: no chips for a VM agent, +2), `apps/daemon/src/modules/sessions/service-commands.ts` (R37: `export_html` of a VM session answers `unavailable`, +3), `apps/daemon/src/modules/agents/service.ts` (RT-30: the resources check at save, +1)

**Interfaces:**
- Produces:
  - `vmInitOf(init: InitRecord, vm: VmInit, mirrorFile: string | null): InitRecord` (pure): `cwd` = `vm.layout.home`; `agentDir` = `vm.layout.piAgentDir`; `papHome` = `vm.layout.pi + "/pap"` (a folder no VM has: every pi-host rule keyed on pap's home matches nothing, and T11b replaces the ones a VM needs); `sessionFile` = `vm.layout.sessions + "/" + mirrorFile` when the row has a mirror, else absent (Pi creates the file in `layout.sessions`, R28); `vm` = `vm`; **no** `sandbox` (the VM shell replaces it, T11b), **no** `vault`, `once` (R11) or `memory` (R17). `platform.ops` drops `secret.request` (R11). `init` is never logged: it carries the relay key.
  - `mirrorPathOf(papHome: string, agentId: string, file: string): string` = `<papHome>/agents/.mirrors/<agentId>/<file>` after checking `file` with `SessionFileName` (R23); `mirrorFileOf(row)`: the basename of `row.piPath` when it is under the agent's mirror folder, else null.
  - `vmRuleParts(parts: AgentRuleParts, layout: VmLayout, isTask: boolean): AgentRuleParts` (R15): `agentHome` = `layout.home`; `agentScratch` = `layout.home` for an isolated task (its own VM's home), else null; `sandbox` = `{ required: true, network: false }` whatever the profile says. `agentRules` applies it when `deps.vmLayoutOf(row)` gives a layout (the runtime's `layoutOf`, pure, so it holds before the VM starts and at every later compose).
  - `checkAgentResources(input: AgentResources, was: AgentResources | null, host: { memoryCapMb: number; cores: number }): void`: throws `PapError("bad_request", { field })` when `memoryMb + VM_OVERHEAD_MB` passes the cap, `cpus` passes the host's cores, or `diskMb` is smaller than the saved value (spec §7). Not a widening edit (no password).
- Every refusal names its sentence (French in the catalogs, English in logs): R11 "Le coffre des agents en VM arrive avec le sous-projet 2.", R16 "Les pré-checks d'un agent en VM arrivent avec le sous-projet 3.", R37 "L'export HTML d'un agent en VM arrive plus tard."

- [ ] **Step 1: Tests**, key assertions:
  - `vmInitOf` keeps no host path (no field starts with the test `PAP_HOME` or Pi agent folder), has no `vault`, `once`, `memory` or `sandbox`, carries `vm`, and names `sessionFile` in `layout.sessions` only when the row has a mirror; `secret.request` is not among `platform.ops`;
  - `vmRuleParts` gives `sandbox: { required: true, network: false }` for a profile whose sandbox is off, and for one with network on (R15); the home is `layout.home`; an isolated task's scratch is its layout's home;
  - `agentRules` of a VM row composes the VM parts at the first compose and after a policy update;
  - `mirrorPathOf` refuses `../x.jsonl`, `a/b.jsonl`, `x.json`;
  - a VM agent's precheck is refused `sandbox_unavailable` with the sentence; `agents.prompts` of a VM agent is `[]`; `export_html` of a VM session is `unavailable`; no `vault_update` reaches a VM session's handle when the vault changes;
  - `checkAgentResources` refuses each bound (one test each) and accepts a smaller memory or CPU count.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched unit suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): the rules and init record of a VM session`.

### Task T9a: The transcript mirror, worker half (lane A)

T9 is split by lane (red-team §3); T9b keeps T9's Opus reviewer, T9a has a Sonnet reviewer (decision 114).

**Files:**
- Create: `packages/pi-host/src/session-mirror.ts`, `session-mirror.test.ts`
- Modify: `packages/pi-host/src/entry-tracker.ts` (call the mirror after each walk: at most +4 lines), `packages/pi-host/src/dispatch.ts` (flush after every command response and on `session_resync`: +3), `packages/pi-host/src/shutdown.ts` (a final flush before exit: +2), `packages/pi-host/src/open-session.ts` (R28: a new VM session is created in `init.vm.layout.sessions`: +2)

**Interfaces:**
- Consumes: T1 `SessionAppend`, `SessionResync`, `SESSION_CHUNK_BYTES`.
- Produces: `createSessionMirror(deps: { file(): string | null; send(record: SessionAppend): boolean; open(path: string): number /* O_RDONLY | O_NOFOLLOW */; clock }): { flush(): void; resync(request: SessionResync): void; close(): void }`.
  - `flush()`: when the file has grown past the last byte sent, sends the new bytes in chunks of at most `SESSION_CHUNK_BYTES` (base64, `file` = the file's name); when it shrank or its inode changed (Pi rewrote it), resends from 0 with `replace: true` on the first chunk only (RT-39). A `send` that returns false keeps the rest for the next flush.
  - Flush points (RT-38): after each entry-tracker walk, after every command response (a rename, a model change, an extension's `appendEntry` and the memory-trust entry are all appends without a walk), a 2 s timer while bytes are left unsent, and before exit.
  - `resync({fromOffset, lastEntryId})`: when `fromOffset > 0` and the line ending exactly at `fromOffset` is an entry whose id is `lastEntryId`, sends from `fromOffset` without `replace` (the mirror is a prefix: RT-39); otherwise resends from 0 with `replace`.

- [ ] **Step 1: Tests** (`session-mirror.test.ts`, a temp file, steppable clock), key assertions: after a walk the bytes from the last sent offset are sent in chunks of at most `SESSION_CHUNK_BYTES`, base64, each naming the file; nothing is sent while the file has not grown; an append with no walk (a rename) is sent at the next command response, and anything left is sent by the 2 s timer and before exit; `resync` with a matching last entry resumes from its offset, with a mismatched id or `fromOffset: 0` resends everything with `replace` on the first chunk only; a file that shrank or was replaced (new inode) triggers the full resend; the file is opened with `O_NOFOLLOW` (a link in its place: nothing sent, an error logged); a new VM session's file appears under `layout.sessions`.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/pi-host/src/session-mirror.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `session-mirror.ts`; call it from `entry-tracker.ts` after each walk and once after `ready`, from `dispatch.ts` and `shutdown.ts`; in `open-session.ts`, `SessionManager.create(cwd, init.vm.layout.sessions)` for a VM session without a file.
- [ ] **Step 4: Run** the test and `pnpm vitest run --project unit packages/pi-host/src/entry-tracker.test.ts packages/pi-host/src/dispatch.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pi-host): the worker sends its session file to the daemon's mirror`.

### Task T9b: The transcript mirror, daemon half (lane B, unit tests; the integration test runs in J1)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/mirror-line.ts`, `mirror-line.test.ts`, `mirror.ts`, `mirror.test.ts`, `mirror-parse.ts`, `mirror-parse.test.ts`, `mirror-facts.ts`, `mirror-facts.test.ts`, `mirror-keep.ts`, `mirror-keep.test.ts`, `mirror-inputs.ts`
- Modify: `apps/daemon/src/modules/agent-vm/vm-worker.ts` (route `session_append` to the mirror of its file, answer `session_resync`, compare the hello's facts), `apps/daemon/src/modules/sessions/service-sync.ts` (a VM row's Pi file is its mirror: +2), `apps/daemon/src/modules/sessions/service-reads.ts` (`fileOf` accepts the mirror; transcript rows of unverified user entries get `unverified: true`: +3), `apps/daemon/src/modules/sessions/automation-port.ts` (RT-45: a deleted task session's mirror is removed too, +1), `apps/daemon/src/compose-agents-vm.ts` (the mirror inputs)

**Interfaces:**
- Consumes: T1 `SessionAppend`, `SessionResync`, `MAX_SESSION_LINE_BYTES`, `TranscriptRow.unverified`; T6 `WorkerSpawnInput`, `MirrorPort`; T8b `mirrorPathOf`.
- Produces: `createMirrorInputs(deps): { inputFor(row: SessionRow): WorkerSpawnInput }`; `openMirror(path, deps): MirrorPort & { close(): void }`; `readMirrorFacts(path): { size: number; lastEntryId: string | null }` (a partial last line, from a crash, is cut at open: Review Focus 5); `unverifiedIds(path): ReadonlySet<string>`.
  - **Appends.** A worker's first `session_append` (or its hello, for a reopen) names its file; an append naming another file is refused `file`. A chunk at the mirror's next byte appends complete lines only; the partial last line stays in memory, bounded by `MAX_SESSION_LINE_BYTES` (past it with no newline: refused `line_too_large` at once); any other offset answers `{ resync: { fromOffset: <mirror size>, lastEntryId: <its last id> } }` and writes nothing. A hello whose facts differ from the mirror's answers the same resync (RT-39: when the mirror is a prefix of the VM's file, only the tail travels).
  - **Line check** (R32): a completed line up to `INLINE_PARSE_BYTES` (1 MiB) is checked on the event loop by `checkMirrorLine`; a longer one goes to `mirror-parse.ts` (one `node:worker_threads` worker for the daemon, one line at a time, the connection paused meanwhile), which runs the same `entryFacts`. An id already in the mirror is refused `duplicate_id` (ids at open come from each line's first 512 bytes, where Pi writes `type` and `id`; a line whose id is not there is parsed).
  - **Quota** (R32, RT-27): an agent's mirrors (kept copies included) stay under its `diskMb`, and an append is refused while `$PAP_HOME`'s free space is under `PAP_MIN_FREE_DISK_MB` (statfs at most every 5 s): `quota`, with the notice "Les conversations de cet agent ont atteint la taille de son disque."
  - **Replacement** (R14): `replace: true` at offset 0 moves the current mirror to `replaced/<name>.<stamp>` and starts the new file. When the new file reaches the old size byte for byte (an extension), the kept copy is deleted; at the first differing byte, or if the connection ends shorter, it is kept 7 days (`mirror-keep.ts` sweeps it), the thread gets R14's notice and the session is tainted the way ADR 0074's outside-write detection does (`onOutsideToolResults`, `rg -n onOutsideToolResults apps/daemon/src/modules/sessions`). `replace: true` at another offset is refused `offset`.
  - **Provenance** (R32): `inputFor(row).sent(text)` feeds `createProvenance`; a `message` entry whose `message.role` is `user` and whose text hash matches neither a sent text nor a `/` expansion is kept, and its id is appended to `<name>.unverified` (0600); `service-reads` marks those rows `unverified: true`.
  - Every refusal logs `agent_mirror_refused {agentId, reason}` and the gateway closes that worker's connection. In read-only database mode the mirror still appends (it is a file) but posts no notice and taints nothing that needs a write; the notice waits (RT-42).
  - Files 0600 with `O_NOFOLLOW`, folders 0700 (`vmGate` made `.mirrors/<id>/`); a link at the file or folder refuses.

- [ ] **Step 1: Line-check tests** (`mirror-line.test.ts`; all run in the fix's scratch), key assertions: a header line is accepted first and refused later; a first line that is not `type: "session"` is `no_header`; `{nope` is `not_json`; `[1]`, a missing `id`, a 65-character `type`, a 129-character `id` are `not_entry`; a user message (string content, or text blocks around an image) gives the hash of its text joined by new lines; an assistant message gives no hash; a line over 1 MiB throws `RangeError` (it must go to the parse thread); a 32 MiB + 1 line is `line_too_large`; provenance: a sent text verifies once, a `/` prompt allows one entry whatever its text, an unsent text does not verify, and only the last 256 sent texts are kept. Mutants named in the file: accept a non-object, skip the header check, drop the duplicate check (in `mirror.test.ts`).
- [ ] **Step 2: Mirror tests** (`mirror.test.ts`, `mirror-parse.test.ts`, `mirror-facts.test.ts`, `mirror-keep.test.ts`, temp folders, steppable clock), key assertions:
  - chunks at the expected offset append complete lines only; a 12 MiB line sent in 6 chunks reads back whole and was parsed in the parse thread (Review Focus 1); a 33 MiB line is refused and nothing of it is written;
  - an offset other than the next byte answers the resync with the mirror's size and last id and writes nothing; a hello with matching facts answers nothing;
  - a duplicate id is refused `duplicate_id`, also against ids already in the file at open;
  - an append past the agent's `diskMb` (a test cap of 1 MiB) or under the free-disk floor (fake statfs) is refused `quota` with the notice;
  - a `replace` that extends the mirror keeps nothing; one that differs keeps `replaced/<name>.<stamp>`, posts the notice once and taints the session (spies); the copy is gone after 7 days (steppable clock);
  - an unverified user entry is listed by `unverifiedIds` and its history row carries `unverified: true`; a prompt pap sent does not;
  - after a disconnect with a partial line pending, the file ends with a newline and `readMirrorFacts` gives the last complete entry; a partial last line found at open is cut;
  - the file is created 0600 with `O_NOFOLLOW` in a 0700 folder; a link at the file or folder refuses;
  - `fileOf` and `bindPiFile` accept a VM row's mirror and still refuse anything else outside Pi's sessions folder; deleting a task session removes its mirror (RT-45).
- [ ] **Step 3: Run** the five test files. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** (security contract, full code of the line check; run in the fix's scratch):

```ts
import { createHash } from "node:crypto";
import { MAX_SESSION_LINE_BYTES } from "@pap/contracts";

/** RT-27: a line up to this size is parsed on the event loop; a longer one in the mirror's parse thread, one at a time. */
export const INLINE_PARSE_BYTES = 1024 * 1024;
export type MirrorRefusal =
  | "offset"
  | "line_too_large"
  | "not_json"
  | "not_entry"
  | "no_header"
  | "duplicate_id"
  | "file"
  | "quota";

/** What the mirror keeps of a checked line: its id (null for the header) and, for a user message, the hash of its text. */
export interface EntryFacts {
  readonly id: string | null;
  readonly userText: string | null;
}
type Checked = { readonly ok: true; readonly facts: EntryFacts } | { readonly ok: false; readonly reason: MirrorRefusal };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const promptHash = sha256;

/** The text of a Pi user message (a string, or its text blocks joined by a new line), as pap hashes what it sends. */
export function userTextOf(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Spec §11, R1, R32: a completed line is a Pi entry, or the mirror stops. `value` is the parsed line (inline or in the thread). */
export function entryFacts(value: unknown, first: boolean): Checked {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "not_entry" };
  const { type, id, message } = value as { type?: unknown; id?: unknown; message?: unknown };
  if (typeof type !== "string" || type.length === 0 || type.length > 64) return { ok: false, reason: "not_entry" };
  if (first) return type === "session" ? { ok: true, facts: { id: null, userText: null } } : { ok: false, reason: "no_header" };
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return { ok: false, reason: "not_entry" };
  const text = type === "message" ? userTextOf(message) : null;
  return { ok: true, facts: { id, userText: text === null ? null : sha256(text) } };
}

/** The inline path: a line up to INLINE_PARSE_BYTES. Longer lines go to the parse thread, which runs the same `entryFacts`. */
export function checkMirrorLine(line: Buffer, first: boolean): Checked {
  if (line.length > MAX_SESSION_LINE_BYTES) return { ok: false, reason: "line_too_large" };
  if (line.length > INLINE_PARSE_BYTES) throw new RangeError("parse this line in the mirror's parse thread");
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  return entryFacts(value, first);
}

/**
 * RT-26: whether a user entry is one pap sent. The VM worker handle records the hash of every prompt, steer and follow-up it
 * sends (at most 256 kept); a prompt starting with `/` (a template or skill Pi expands) allows one user entry whatever its
 * text. A user entry matching neither renders as "not sent from pap" (an extension's message, or a forged one).
 */
export function createProvenance(limit = 256) {
  const sent: string[] = [];
  let expansions = 0;
  return {
    sent(text: string): void {
      if (text.startsWith("/")) expansions = Math.min(expansions + 1, limit);
      else {
        sent.push(sha256(text));
        if (sent.length > limit) sent.shift();
      }
    },
    /** True: pap sent it. Consumes the match. */
    verify(userText: string): boolean {
      const at = sent.indexOf(userText);
      if (at >= 0) {
        sent.splice(at, 1);
        return true;
      }
      if (expansions > 0) {
        expansions--;
        return true;
      }
      return false;
    },
  };
}
```

  Then `mirror.ts`, `mirror-parse.ts`, `mirror-facts.ts`, `mirror-keep.ts`, `mirror-inputs.ts` and the wiring as the interfaces above say.
- [ ] **Step 5: Run** the five test files and `pnpm vitest run --project unit apps/daemon/src/modules/sessions`. Expected: PASS. (`mirror.int.test.ts` is written and run in J1.)
- [ ] **Step 6: Commit** `feat(agent-vm): the session mirror, checked line by line, with kept replacements and provenance`.

### Task T10a: Attachments into the agent's inbox, worker half (lane A)

**Files:**
- Create: `packages/pi-host/src/inbox-put.ts`, `inbox-put.test.ts`
- Modify: `packages/pi-host/src/dispatch.ts` (handle `file_put`: at most +3 lines), `packages/pi-host/src/prompt-images.ts` (RT-06: in a VM, prompt images come from `layout.inbox`: +6)

**Interfaces:**
- Consumes: T1 `FilePut`, `FilePutResult`, `FILE_LIMITS.uploadBytes`.
- Produces: `createInbox(inbox: string): { put(chunk: FilePut): FilePutResult | null }` (null until `last`): the first chunk (offset 0) opens `<inbox>/.<id>.part` with `O_CREAT | O_EXCL | O_NOFOLLOW`, 0644; each chunk must start at the bytes written so far (else `order`); past `FILE_LIMITS.uploadBytes` the part is removed and `too_large`; at `last` the part is renamed to `name` unless `name` exists (`exists`, the part removed). In a VM session, a prompt image path is accepted when its real path's folder is the real `layout.inbox`, it is a regular file and has one link; the host attachment folder is used otherwise, as today.

- [ ] **Step 1: Tests**, key assertions: a 5 MiB file in three chunks lands whole under its name, directly in the inbox; a chunk out of order answers `order` and removes the part; the byte past the limit answers `too_large`; an existing name answers `exists` and the part is gone; a link planted at `.<id>.part` or at `name` is never followed (the open or the rename refuses); a VM prompt image under the inbox is read, one outside it or with two links is refused.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pi-host): attachments written into the agent's inbox`.

### Task T10b: Attachments into the agent's inbox, daemon half (lane B, unit tests; the integration test runs in J1)

**Files:**
- Create: `apps/daemon/src/modules/sessions/vm-attachments.ts`, `vm-attachments.test.ts`
- Modify: the prompt path that claims attachments for a session (`rg -n "claim" apps/daemon/src/modules/sessions -g '!*.test.ts'`; at most +6 lines)

**Interfaces:**
- Produces: `putAttachments(handle: WorkerHandle, files: Array<{ name: string; bytes: Buffer }>): Promise<string[]>` (VM paths, in order): each file in chunks of `FILE_CHUNK_BYTES`; a `send` that returns false (a `RangeError` caught in T6) fails the prompt with `prompt_failed`, never a crash. For a VM agent the prompt refers to `layout.inbox/<name>`, and images go through the existing prompt-image path with that VM path.

- [ ] **Step 1: Tests**, key assertions: a 25 MiB attachment (the upload limit) travels in 13 chunks and no frame passes `MAX_FRAME_BYTES`; `exists` makes the daemon retry once with a `-<4 hex>` suffix before the extension; a name the schema refuses never reaches the worker; a file over the attachment limit is refused by the daemon before sending.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): attachments sent to the agent's inbox in chunks`.

### Task T11a: The VM shell: bwrap argument list, seccomp filter and its process (lane A)

**Files:**
- Create: `packages/pi-host/src/vm-shell/argv.ts`, `argv.test.ts`, `seccomp.ts`, `seccomp.test.ts`, `ops.ts`, `ops.test.ts`, `packages/pi-host/src/shell-process.ts`
- Modify: `packages/pi-host/src/sandbox-ops.ts` (move the transport-neutral pieces, `ShellOperations`, `ShellTimers`, `SYSTEM_TIMERS`, `toolCall`, the timeout check and the process-group kill, into `shell-process.ts` and re-export them: the file shrinks)

**Interfaces:**
- Consumes: T1 `VmLayout`, `VmInit`.
- Produces: `bwrapVmArgv(spec: VmShellSpec, command: string, seccompFd: number): string[]`; `shellSeccompProgram(): Insn[]`, `encodeSeccomp(program): Buffer`; `vmShell(spec: VmShellSpec, deps: { spawn?; timers?; redact? }): ShellOperations` (`ops.ts`; the spec from `init.vm`: its layout, bwrap, slot and root view): each command spawns `bwrapVmArgv(...)` with `stdio: ["ignore", "pipe", "pipe", "pipe"]`, writes `encodeSeccomp(shellSeccompProgram())` to fd 3 and ends it (bwrap reads and closes it); the environment is a fixed allowlist (`PATH`, `HOME=/agent/home`, `LANG`, `TERM`), never the worker's (which holds the relay key, R13); the slot's overlay folders `upper` and `work` are created 0700 at first use; one command at a time per worker, later calls queued (R27); timeouts, Stop and shutdown kill the process group as `sandbox-ops.ts` does. No egress socket (sub-project 2: `egressSocket` stays null). `ops.ts` imports `shell-process.ts`, never `sandbox-ops.ts`, `SandboxSpec` or `bwrapArgv` (R25).
- T0a gates `rootView` (`overlay` until recorded).

- [ ] **Step 1: Tests**, key assertions (the argv and the filter were run in the fix's scratch; the filter was also loaded for real through `bwrap --seccomp 3` on this host):
  - `bwrapVmArgv`: contains `--unshare-net`, `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--unshare-cgroup`, `--cap-drop ALL` and exactly the seven `--cap-add` of R2; never `--unshare-user`, `--dev-bind`, `/dev/vsock`, `.pi` or `layout.root` as a bind source; binds exactly home, knowledge, inbox; the overlay upper is `<shellOverlay>/<slot>/upper` (`rootView: "overlay"`) or the root is `--ro-bind / /` (`"read-only"`); `--seccomp` names the given fd; the command is the last argument after `--`; a slot that is not 32 hex characters and a non-null `egressSocket` throw.
  - seccomp, with a 30-line BPF interpreter in the test (`run(program, { arch, nr, arg0 })`, JEQ, JGE, JSET, LD, RET): x86_64 `read`, `execve`, `socket` for families 1, 2, 10, 16, `socketpair(1)`, `clone` with fork's and a thread's flags, `unshare(CLONE_FILES)` allow; `socket` 40 (also with the upper 32 bits set), 17, 38, 44 and `socketpair(40)` give EPERM; `clone` or `unshare` with any of the eight `CLONE_NEW*` bits gives EPERM; `clone3` gives ENOSYS; every number of `DENIED_SYSCALLS` gives EPERM; arch aarch64 and i386 kill; `nr = 0x40000000 + 41` (x32) kills; every jump stays inside the program; the encoded buffer is `8 × length` bytes. Mutants named in the file, each killed in scratch: drop the arch check, drop the x32 check, allow every socket family, change a denied number, drop the namespace mask, allow `clone3`.
  - `ops.ts` (fake spawn): the filter reaches fd 3 and fd 3 is ended; the environment is the allowlist only; a second command waits until the first exits; the timeout kills the group.
- [ ] **Step 2: Run** `pnpm vitest run --project unit packages/pi-host/src/vm-shell`. Expected: FAIL.
- [ ] **Step 3: Implement** (security contract, full code). `argv.ts`:

```ts
import type { VmLayout } from "@pap/contracts";

/** R2, R18: what the agent's shell keeps as guest root. No CAP_SYS_ADMIN, CAP_SYS_CHROOT, CAP_MKNOD, CAP_SYS_PTRACE, CAP_SYS_MODULE, CAP_NET_*. */
export const VM_SHELL_CAPS = [
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_FSETID",
  "CAP_SETUID",
  "CAP_SETGID",
  "CAP_KILL",
] as const;

export interface VmShellSpec {
  readonly bwrap: string;
  readonly layout: VmLayout;
  /** The worker's slot: its own overlay upper (R27), so two workers' shells never share one. */
  readonly slot: string;
  /** T0a: `overlay` when bwrap can overlay `/` as guest root, else `read-only` (the image root bound read-only in SP1). */
  readonly rootView: "overlay" | "read-only";
  /** Sub-project 2's seam: a per-command proxy socket bound into the shell. Always null in sub-project 1 (no network). */
  readonly egressSocket: string | null;
}
const SLOT = /^[0-9a-f]{32}$/;

/** The shell of an agent in its VM (spec §5, R2). `.pi`, the worker, the guest and `/dev/vsock` are never in its view. */
export function bwrapVmArgv(spec: VmShellSpec, command: string, seccompFd: number): string[] {
  const { layout } = spec;
  if (!SLOT.test(spec.slot) || spec.egressSocket !== null) throw new RangeError("vm shell spec");
  const overlay = `${layout.shellOverlay}/${spec.slot}`;
  const root =
    spec.rootView === "overlay"
      ? ["--overlay-src", "/", "--overlay", `${overlay}/upper`, `${overlay}/work`, "/"]
      : ["--ro-bind", "/", "/"];
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
    ...root,
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

  `seccomp.ts` (63 instructions, 504 bytes):

```ts
/** Classic BPF for seccomp (linux/filter.h, linux/seccomp.h). x86_64 only in v1: any other arch is killed (R2, R18). */
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
/** seccomp_data: nr at 0, arch at 4, the low 32 bits of args[0] at 16 (little-endian). */
const NR = 0;
const ARCH = 4;
const ARG0_LOW = 16;
/** CLONE_NEWTIME, CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET. */
export const CLONE_NEW_MASK = 0x00000080 | 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;
/** AF_UNIX, AF_INET, AF_INET6, AF_NETLINK: the families a shell without network still uses. Every other family: EPERM. */
export const SOCKET_FAMILIES = Object.freeze([1, 2, 10, 16]);
const AF_UNIX = 1;
/** x86_64 numbers (arch/x86/entry/syscalls/syscall_64.tbl). Spec §5 plus RT-23: modules, keys, tracing, io_uring, new namespaces, mounts, cross-process memory. */
export const DENIED_SYSCALLS = Object.freeze({
  ptrace: 101,
  syslog: 103,
  pivot_root: 155,
  acct: 163,
  mount: 165,
  umount2: 166,
  swapon: 167,
  swapoff: 168,
  init_module: 175,
  delete_module: 176,
  quotactl: 179,
  kexec_load: 246,
  add_key: 248,
  request_key: 249,
  keyctl: 250,
  perf_event_open: 298,
  name_to_handle_at: 303,
  open_by_handle_at: 304,
  setns: 308,
  process_vm_readv: 310,
  process_vm_writev: 311,
  kcmp: 312,
  finit_module: 313,
  kexec_file_load: 320,
  bpf: 321,
  userfaultfd: 323,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsconfig: 431,
  fsmount: 432,
  fspick: 433,
  pidfd_getfd: 438,
  mount_setattr: 442,
  quotactl_fd: 443,
});
/** Judged on their first argument: a family, or namespace flags. clone3 hides its flags in memory: ENOSYS (libc falls back to clone). */
export const ARG_SYSCALLS = Object.freeze({ socket: 41, socketpair: 53, clone: 56, unshare: 272, clone3: 435 });

export type Insn = readonly [code: number, jt: number, jf: number, k: number];
type Label = "allow" | "eperm" | "enosys" | "socket" | "socketpair" | "flags" | "kill" | null;
type Draft = { code: number; k: number; jt: Label; jf: Label; at?: string };

const jeq = (k: number, jt: Label, jf: Label = null): Draft => ({ code: JEQ_K, k, jt, jf });
const ld = (offset: number): Draft => ({ code: LD_W_ABS, k: offset, jt: null, jf: null });
const ret = (k: number, at?: string): Draft => ({ code: RET_K, k, jt: null, jf: null, ...(at ? { at } : {}) });

/** Labels resolve to forward offsets; a jump that would leave the program or pass 255 throws (never a silent wrap). */
function assemble(drafts: readonly Draft[]): Insn[] {
  const where = new Map<string, number>();
  drafts.forEach((draft, i) => {
    if (draft.at !== undefined) where.set(draft.at, i);
  });
  const offset = (from: number, label: Label): number => {
    if (label === null) return 0;
    const to = where.get(label);
    if (to === undefined || to <= from || to - from - 1 > 255) throw new RangeError(`bad jump to ${label}`);
    return to - from - 1;
  };
  return drafts.map((d, i) => [d.code, offset(i, d.jt), offset(i, d.jf), d.k >>> 0] as const);
}

export function shellSeccompProgram(): Insn[] {
  const drafts: Draft[] = [
    ld(ARCH),
    jeq(AUDIT_ARCH_X86_64, null, "kill"),
    ld(NR),
    { code: JGE_K, k: X32_SYSCALL_BIT, jt: "kill", jf: null },
    ...Object.values(DENIED_SYSCALLS).map((nr) => jeq(nr, "eperm")),
    jeq(ARG_SYSCALLS.clone3, "enosys"),
    jeq(ARG_SYSCALLS.socket, "socket"),
    jeq(ARG_SYSCALLS.socketpair, "socketpair"),
    jeq(ARG_SYSCALLS.clone, "flags"),
    jeq(ARG_SYSCALLS.unshare, "flags"),
    ret(RET_ALLOW),
    { ...ld(ARG0_LOW), at: "socket" },
    ...SOCKET_FAMILIES.map((family) => jeq(family, "allow")),
    ret(RET_ERRNO | EPERM),
    { ...ld(ARG0_LOW), at: "socketpair" },
    jeq(AF_UNIX, "allow"),
    ret(RET_ERRNO | EPERM),
    { ...ld(ARG0_LOW), at: "flags" },
    { code: JSET_K, k: CLONE_NEW_MASK, jt: "eperm", jf: "allow" },
    ret(RET_ALLOW, "allow"),
    ret(RET_ERRNO | EPERM, "eperm"),
    ret(RET_ERRNO | ENOSYS, "enosys"),
    ret(RET_KILL_PROCESS, "kill"),
  ];
  return assemble(drafts);
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

- [ ] **Step 4: Run** the three test files and `pnpm vitest run --project unit packages/pi-host/src/sandbox-ops.test.ts packages/pi-host/src/sandbox-ops.egress.test.ts`. Expected: PASS, the host sandbox's tests unchanged.
- [ ] **Step 5: Commit** `feat(pi-host): the VM shell, its seccomp filter and its process`.

### Task T11b: The VM file rule, the VM policy stages and the tool registration (lane A)

Fixes RT-01, RT-02 and the pi-host half of RT-06. The daemon half (rules, `init`) is T8b.

**Files:**
- Create: `packages/pi-host/src/policy/vm-paths.ts`, `vm-paths.test.ts`, `packages/pi-host/src/policy/vm-stage.ts`, `vm-stage.test.ts`, `packages/pi-host/src/vm-files/ops.ts`, `ops.test.ts`, `packages/pi-host/src/vm-files/extension.ts`, `packages/pi-host/src/vm-shell/tool.ts`, `packages/pi-host/src/host.vm.int.test.ts`
- Modify: `packages/pi-host/src/open-session.ts` (VM registration and facts: +10), `packages/pi-host/src/policy/tool-kind.ts` (`VM_FILES_SOURCE`: +8), `packages/pi-host/src/policy/extension.ts` (`config.vm` into the tool facts and the deps: +3), `packages/pi-host/src/policy/pipeline.ts` (`PipelineDeps.vm`; no runs or homes fence in a VM: +3), `packages/pi-host/src/policy/agent-stage.ts` (VM branches of `hasOwnFolder`, `readsOutsideThread`, `insideReach`: +3), `packages/pi-host/src/policy/stage-approval.ts` (the VM file stage first; `reviewOf` empty in a VM: +6), `packages/pi-host/src/policy/read-target.ts` (export `UNICODE_SPACE` and `REWRITTEN`: +0)

**Interfaces:**
- Consumes: T1 `VmInit`; T11a `vmShell`, `bwrapVmArgv`.
- Produces:
  - `judgeVmPath(raw, cwd, roots, write): Promise<VmPathVerdict>`, `vmFileFolders(layout)`, `realVmRoots(layout): Promise<VmFileRoots>` (`vm-paths.ts`); `createVmFileOps(roots)` (`vm-files/ops.ts`): Pi's `ReadOperations`, `WriteOperations`, `EditOperations`, `LsOperations`.
  - `createVmFileTools(roots, cwd): NamedInlineExtension` (`vm-files/extension.ts`, name `pap-vm-files`, source `VM_FILES_SOURCE = "<inline:pap-vm-files>"`): registers Pi's own `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createLsToolDefinition` with these operations, under Pi's names (an extension's tool takes a built-in's name: Pi's `docs/containerization.md`, the Gondolin extension overrides the same tools). `vmFilesFirst` orders it first among extensions, like `sandboxFirst`. Pi's `grep` and `find` stay Pi's built-ins. If `host.vm.int.test.ts` shows Pi keeps its own `read`, `write`, `edit` or `ls` over the extension's, stop and report BLOCKED: never fall back to the judge alone (decision 113: the VM file rule "opens without following links").
  - `createVmShellTool(vm: VmInit, deps): NamedInlineExtension` (`vm-shell/tool.ts`): Pi's `createBashToolDefinition(vm.layout.home, { operations: vmShell(...), exposeSessionEnvironment: false })` registered by an extension named `pap-sandbox`, so its source is `SANDBOX_SOURCE` and stage 02 knows it as pap's sandboxed shell (RT-02).
  - `tool-kind.ts`: a `read`, `write`, `edit` or `ls` registered from `VM_FILES_SOURCE`, in a worker whose policy config has `vm`, is classified exactly like Pi's built-in of that name (`builtin: true`); from any other worker it is unknown (fail closed).
  - `vm-stage.ts`: `vmFileRefusal(call, ctx, vm): Promise<ApprovalPlan | null>`: for a built-in `read`, `grep`, `find`, `ls`, `edit` or `write`, `judgeVmPath` of the path the call names (`grep`, `find`, `ls` default to the cwd), as a write for `edit`/`write`; a refusal blocks with `reason` the verdict's and `modelReason` "pap-policy blocked this call: <reason>.", in every mode and with no question (spec §5). `vmOwnFolder(rules, vm)`: the folder the rules name (`agentOwnOf`) is `vm.layout.home`.
  - `PipelineDeps.vm?: { layout: VmLayout; roots: VmFileRoots }`, built once at worker start from `init.vm` (`realVmRoots`; a root that is a link stops the worker).
  - Stage changes when `deps.vm` is set (each with a test): `approvalStage` runs `vmFileRefusal` first, before the isolated-task branch; `hasOwnFolder` is `vmOwnFolder`; `readsOutsideThread` is false (the VM stage judged); `insideReach` is `vmOwnFolder` for pap's shell and true for a built-in read or edit (judged already); `reviewOf` returns no review (no host protected root exists in the VM; the VM rule decided); `pipeline.ts`'s runs and homes fence (`readsRunsFolder`, `readsAgentHome`) is skipped (no host agent folder exists in the VM); `checkEditTarget` and `checkReadTarget` are never called.
  - `open-session.ts` with `init.vm`: the policy config gets `sandbox: { network: false }` and `vm`; the extensions are `createVmShellTool(...)` and `createVmFileTools(...)` whatever `init.sandbox` says (there is none: T8b), so Pi's own `bash` never runs in a VM (stage 02 blocks it: R15's `required: true`); `agentFactsOf` names `init.vm.layout.home` as the agent's home (RT-06).
- Ruling R26's residual (a race on a `grep`/`find`/`ls` root) goes in the topic note (T21).

- [ ] **Step 1: Tests** (Review Focus 1; every case below was run in the fix's scratch against these files), key assertions:
  - `judgeVmPath` refuses `@<root>/agent/.pi/sessions/s.jsonl` and `~/../agent/.pi/sessions/s.jsonl` (write), `~/../proc/self/environ` and `file://<root>/agent/.pi/sessions/s.jsonl` (read), a name holding U+00A0 (`String.fromCharCode(0xa0)`) as `rewritten path`; a dangling `home/x -> .pi/sessions/new.jsonl` as `link` for read and write; a link `home/y -> home/z.txt` as `link` (Pi's tools never follow one; the shell can); `dl/sessions/s.jsonl` through `home/dl -> .pi`, `../.pi/sessions/s.jsonl` and `/proc/self/environ` as outside; a missing path for read as `missing`; a write under the read-only roots as outside; a write to a folder as `not a file`; allows a new file under home whose parents do not exist yet, an existing file, a read under the skills root, a folder for `ls`.
  - `createVmFileOps`: a file judged plain then swapped for a link to the transcript before `writeFile` is refused and the transcript is unchanged; a folder swapped for a link to `.pi` before `readFile` is refused; `mkdir` through a link creates nothing in `.pi`; a FIFO is refused for read and write without blocking; a path outside every root, a `..` spelling, a write under the read-only roots and `ls` through a link are refused; `mkdir` then `writeFile` of a new nested file works and reads back; a hard link inside home reads; `detectImageMimeType` of a PNG is `image/png`; a read over `VM_READ_MAX_BYTES` is refused. Mutants named in the files, each killed in scratch: no O_NOFOLLOW on the leaf, the whole path opened at once instead of component by component, the judge without the rewrite refusal.
  - `realVmRoots` refuses a writable root that is a link and drops a missing read-only one.
  - `vm-stage.test.ts`: with `deps.vm`, a `write` of `@/agent/.pi/x` is blocked in `full-access` with no question; a `read` under home in `supervised` goes on to the matrix; `hasOwnFolder` is true for rules naming `layout.home` and false for any host path; `readsAgentHome` is never called (spy); `checkEditTarget` is never called (spy).
  - `host.vm.int.test.ts` (a worker over the IPC transport with `init.vm`, a temp layout and an injected spawn that records the shell's argv instead of running bwrap): for a profile whose host sandbox is off and one whose sandbox has network, Pi's own `bash` is blocked and pap's `bash` runs `bwrapVmArgv` with no network (RT-02); in `auto-accept-edits` and `full-access` a shell call runs with no question and in `supervised` it asks (R15, owner Q6); the session's `read`, `write`, `edit` and `ls` have source `VM_FILES_SOURCE` and classify as built-ins; `read "@/…/.pi/sessions/…"` is blocked; the system prompt names `/…/home` (the layout's) as the agent's home.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (security contract, full code). `policy/vm-paths.ts`:

```ts
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { kernelResolve, tooLong } from "./kernel-path.ts";
import { REWRITTEN, UNICODE_SPACE } from "./read-target.ts";
import { asPiResolves } from "./target-path.ts";

/** Real paths, checked once at worker start (`realVmRoots`): a root that is a link or not a folder stops the worker. */
export interface VmFileRoots {
  readonly writable: readonly string[];
  readonly readOnly: readonly string[];
}
export type VmPathVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: VmPathRefusal };
export type VmPathRefusal = "unreadable path" | "rewritten path" | "missing" | "link" | "not a file" | "outside this agent's folders";

export const inside = (target: string, root: string): boolean => target === root || target.startsWith(`${root}/`);
const refuse = (reason: VmPathRefusal): VmPathVerdict => ({ ok: false, reason });
const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};
async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
/** The real path of the nearest existing ancestor joined with the rest: where a new file would land. */
async function realOrNearest(p: string): Promise<string> {
  const rest: string[] = [];
  let current = p;
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The folders a VM agent's file tools reach (spec §5): its own three, and Pi's skill and package folders read-only (R26). */
export const vmFileFolders = (layout: { home: string; knowledge: string; inbox: string; piAgentDir: string }) => ({
  writable: [layout.home, layout.knowledge, layout.inbox],
  readOnly: ["skills", "npm", "git", "local"].map((name) => `${layout.piAgentDir}/${name}`),
});

/** The same as real folders, once at worker start; a writable root that is a link or not a folder stops the worker. */
export async function realVmRoots(layout: Parameters<typeof vmFileFolders>[0]): Promise<VmFileRoots> {
  const folders = vmFileFolders(layout);
  const real = async (dir: string, required: boolean): Promise<string | null> => {
    const info = await lstat(dir).catch((error: unknown) => (!required && isMissing(error) ? null : Promise.reject(error)));
    if (info === null) return null;
    if (!info.isDirectory() || (await realpath(dir)) !== path.resolve(dir)) throw new Error("vm files: a root is not a real folder");
    return path.resolve(dir);
  };
  const writable = await Promise.all(folders.writable.map((dir) => real(dir, true)));
  const readOnly = await Promise.all(folders.readOnly.map((dir) => real(dir, false)));
  return { writable: writable as string[], readOnly: readOnly.filter((dir): dir is string => dir !== null) };
}

/**
 * Spec §5, RT-01: a path Pi's file tools name in a VM agent stays in the agent's folders. Judged before the call; the tools'
 * operations (`vm-file-ops.ts`) enforce it again at open time, one component at a time, so a link planted between the two
 * is refused, not followed. A path Pi would rewrite (`~`, `@`, `file:`, a Unicode space) is refused: Pi would open another
 * path than the one judged. A read names an existing path; a write never lands on a link, dangling or not.
 */
export async function judgeVmPath(raw: unknown, cwd: string, roots: VmFileRoots, write: boolean): Promise<VmPathVerdict> {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0") || tooLong(raw)) return refuse("unreadable path");
  if (REWRITTEN.test(raw) || UNICODE_SPACE.test(raw)) return refuse("rewritten path");
  const allowed = write ? roots.writable : [...roots.writable, ...roots.readOnly];
  const within = (p: string) => allowed.some((root) => inside(p, root));
  for (const spelling of new Set([asPiResolves(raw), raw])) {
    const lexical = path.resolve(cwd, spelling);
    if (!within(lexical)) return refuse("outside this agent's folders");
    const leaf = await lstatOrNull(lexical);
    if (leaf?.isSymbolicLink()) return refuse("link");
    if (!write && leaf === null) return refuse("missing");
    if (write && leaf !== null && !leaf.isFile()) return refuse("not a file");
    if (!within(await realOrNearest(lexical))) return refuse("outside this agent's folders");
    if (!within(await kernelResolve(cwd, spelling))) return refuse("outside this agent's folders");
  }
  return { ok: true };
}
```

  `vm-files/ops.ts`:

```ts
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { inside, type VmFileRoots } from "../policy/vm-paths.ts";

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
/** Pi's read loads a whole file; past this the model is told to use the shell (`head`, `tail`). */
export const VM_READ_MAX_BYTES = 64 * 1024 * 1024;
const at = (dirFd: number, name: string): string => `/proc/self/fd/${dirFd}/${name}`;

export class VmFileRefused extends Error {
  constructor() {
    super("pap: outside this agent's folders, or a link (Pi's file tools never follow links in a VM; the shell can)");
  }
}

/** The root `absolute` lies under and the components below it; null outside every root or for a spelling with `.`, `..` or `//`. */
function split(absolute: string, roots: readonly string[]): { root: string; parts: string[] } | null {
  if (!path.isAbsolute(absolute) || absolute.includes("\0")) return null;
  const root = roots.find((each) => inside(absolute, each));
  if (root === undefined) return null;
  const parts = absolute === root ? [] : absolute.slice(root.length + 1).split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? null : { root, parts };
}

function openNoFollow(where: string, flags: number): number {
  try {
    // O_NONBLOCK: a FIFO the shell planted opens at once and is refused below by its type, never waited on.
    return openSync(where, flags | O_NOFOLLOW | O_NONBLOCK, 0o644);
  } catch {
    throw new VmFileRefused();
  }
}

/**
 * RT-01: what `absolute` names under one of `roots`, opened one component at a time relative to the folder before it
 * (`/proc/self/fd/<fd>/<name>`), each with O_NOFOLLOW: a link anywhere, planted before or during the call, is refused.
 * `create` makes missing folders (0755) on the way. Roots are trusted real folders (`realVmRoots`).
 */
function openPath(absolute: string, roots: readonly string[], leafFlags: number, create = false): number {
  const where = split(absolute, roots);
  if (where === null) throw new VmFileRefused();
  let fd = openNoFollow(where.root, O_RDONLY | O_DIRECTORY);
  where.parts.forEach((name, i) => {
    const last = i === where.parts.length - 1;
    try {
      if (create) {
        try {
          mkdirSync(at(fd, name), { mode: 0o755 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new VmFileRefused();
        }
      }
      const next = openNoFollow(at(fd, name), last ? leafFlags : O_RDONLY | O_DIRECTORY);
      closeSync(fd);
      fd = next;
    } catch (error) {
      closeSync(fd);
      throw error instanceof VmFileRefused ? error : new VmFileRefused();
    }
  });
  return fd;
}

function withFd<T>(fd: number, use: (fd: number) => T): T {
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}
const regular = (fd: number): number => {
  if (!fstatSync(fd).isFile()) throw new VmFileRefused();
  return fd;
};

function readAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) return Buffer.concat(chunks, total);
    total += n;
    if (total > VM_READ_MAX_BYTES) throw new VmFileRefused();
    chunks.push(chunk.subarray(0, n));
  }
}

const IMAGE_MAGIC: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
];
function imageType(fd: number): string | null {
  const head = Buffer.alloc(12);
  const n = readSync(fd, head, 0, 12, 0);
  const found = IMAGE_MAGIC.find(([, magic]) => n >= magic.length && magic.every((byte, i) => head[i] === byte));
  if (found) return found[0];
  const webp = n === 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
  return webp ? "image/webp" : null;
}

/** Pi's `ReadOperations`, `WriteOperations`, `EditOperations` and `LsOperations` for a VM agent (spec §5, RT-01). */
export function createVmFileOps(roots: VmFileRoots) {
  const readable = [...roots.writable, ...roots.readOnly];
  const readFile = async (absolute: string): Promise<Buffer> =>
    withFd(regular(openPath(absolute, readable, O_RDONLY)), readAll);
  const writeFile = async (absolute: string, content: string): Promise<void> =>
    withFd(regular(openPath(absolute, roots.writable, O_WRONLY | O_CREAT | O_TRUNC)), (fd) => {
      const bytes = Buffer.from(content, "utf8");
      for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done, bytes.length - done);
    });
  const accessIn = (list: readonly string[]) => async (absolute: string): Promise<void> =>
    withFd(regular(openPath(absolute, list, O_RDONLY)), () => undefined);
  return {
    read: {
      readFile,
      access: accessIn(readable),
      detectImageMimeType: async (absolute: string) => withFd(regular(openPath(absolute, readable, O_RDONLY)), imageType),
    },
    write: {
      writeFile,
      mkdir: async (dir: string): Promise<void> => {
        closeSync(openPath(dir, roots.writable, O_RDONLY | O_DIRECTORY, true));
      },
    },
    edit: { readFile, writeFile, access: accessIn(roots.writable) },
    ls: {
      exists: (absolute: string): boolean => {
        try {
          closeSync(openPath(absolute, readable, O_RDONLY));
          return true;
        } catch {
          return false;
        }
      },
      stat: (absolute: string) => {
        const directory = withFd(openPath(absolute, readable, O_RDONLY), (fd) => fstatSync(fd).isDirectory());
        return { isDirectory: () => directory };
      },
      readdir: (absolute: string): string[] =>
        withFd(openPath(absolute, readable, O_RDONLY | O_DIRECTORY), (fd) => readdirSync(`/proc/self/fd/${fd}`)),
    },
  };
}
```

  Then `vm-stage.ts`, the extension, the shell tool and the stage branches as the interfaces above say. The existing same-message rule (W5-R11: a path tool and an allowed shell call in one assistant message) applies unchanged to VM agents.
- [ ] **Step 4: Run** the new test files and `pnpm vitest run --project unit packages/pi-host/src/policy`, `pnpm vitest run --project integration packages/pi-host/src/host.vm.int.test.ts packages/pi-host/src/host.sandbox.int.test.ts packages/pi-host/src/pi-search.symlinks.int.test.ts`. Expected: PASS, the host-mode tests unchanged.
- [ ] **Step 5: Commit** `feat(agent-vm): the VM file rule, no-follow file tools and pap's shell in every VM session`.

### Task T12: The provider relay (`pap-relay`), core (lane A; its daemon half is in J1)

**Files:**
- Create: `packages/pi-host/src/relay/main.ts`, `server.ts`, `server.test.ts`, `routes.ts`, `routes.test.ts`, `keys.ts`, `keys.test.ts`, `headers.ts`, `headers.test.ts`, `credentials.ts`, `credentials.test.ts`, `policy.ts`, `policy.test.ts`, `usage.ts`, `usage.test.ts`, `relay.int.test.ts`; `packages/pi-host/src/relay-key.ts`, `relay-key.test.ts`
- Modify: `packages/pi-host/package.json` (export `"./relay"`), `packages/pi-host/src/helper/ops/models-usage.ts` (its credential resolution moves into `relay/credentials.ts` and is imported back: the file shrinks), `packages/pi-host/src/open-session.ts` (`applyRelayKey` in a VM session: +2)

**Interfaces:**
- Consumes: T1 `RelayCommand`, `RelayReport`, `AGENT_NET`.
- Produces:
  - `routeOf(method, host, url): RelayRoute | null`, `pathAllowed(api, path): boolean`, `modelOf(api, path, body): string | null` (`routes.ts`, full code below); `presentedKey(headers)`, `createRelayKeys()` (`keys.ts`, full code below); `upstreamHeaders(api, incoming, credential): Record<string, string>`; `resolveProvider(provider): Promise<{ api: ApiKind; baseUrl: string; credential: { value: string; headers: Record<string, string> } } | null>` (60 s cache, API-key credentials only, R9; `https:` base URLs only, loopback `http:` only when `PAP_TEST_PROVIDER_SCRIPT` is set; the provider's literal `headers` from `models.json` are added here, host-side, RT-18); `createRelayPolicy()` (per agent: allowed `(provider, model)` pairs, `claude`, `blocked`); `createUsage(clock)` (requests, refusals, bytes per agent, reported every 60 s as `relay_usage`).
  - The relay server, in order, for each request: `routeOf` (else 403 `route`); at most 8 requests at once per source address (else 429); `presentedKey` and `keys.agentOf(key, remoteAddress)` (else 403 `key`); the whole body read, at most 32 MiB (else 413), with `Transfer-Encoding` and `Content-Length` both present refused (400); `modelOf` and the agent's policy: the provider and model allowed, or for `claude.internal` the agent allowed the bridge and a model matching `^claude-[a-z0-9.-]{1,64}$` until T0b records the bridge's exact ids (else 403 `model`); `blocked` (else 403 `paused` or `budget`); only then `resolveProvider` (or the owner's Claude token: none answers 503) and the upstream request: `baseUrl` without its trailing slash plus `path` plus `query`, no redirect following, a 5-minute idle timeout, the answer piped back as it streams. Every refusal logs `agent_relay_refused {agentId | null, reason}`; no key, token, path or host appears in a log line.
  - `main.ts`: forked by the daemon (J1); listens on `AGENT_NET.host:relayPort` (Kata) or `127.0.0.1:0` (process backend) and reports `relay_ready {port}`; takes `RelayCommand`s over IPC (each parsed; one that does not parse is dropped and logged by type only).
  - Worker side, `relay-key.ts`: `applyRelayKey(modelRuntime, key, providers)`: in a VM session, `setRuntimeApiKey(provider, key)` for every provider of the session's models (the image's `models.json` holds placeholders only), and `process.env.ANTHROPIC_AUTH_TOKEN = key` before the bridge starts its `claude` (the bridge's adapter config names no token, T14a). Called by `open-session.ts` after the services exist and before extensions bind.

- [ ] **Step 1: Tests** (Review Focus 2 and 4; `routes.ts` and `keys.ts` were run in the fix's scratch), key assertions:
  - `routeOf("POST", "llm.internal:7842", "/zai/chat/completions")` is `{ kind: "provider", provider: "zai", path: "/chat/completions", query: "" }`; `"claude.internal:7842"` with `/v1/messages?beta=true` is a claude route; a Google stream path with `/v1beta` and `?alt=sse` is a provider route;
  - refused (null), 22 request lines: any method but POST (`post` too); Host `api.z.ai`, `llm.internal.evil`, `evil.llm.internal`, missing, `llm.internal:7842:1`, `llm.internal@evil`; `/zai/../../etc/passwd`; `/zai/%2e%2e/x`; `http://api.z.ai/chat/completions` as the request target; `//zai/x`; a backslash; an unknown query; a fragment; `/zai` alone; `/Zai/x`; `/zai/.../x`; `/zai/./x`; `claude.internal` with `/v1/complete` or `/v1/messages/../models`; a CR LF in the target;
  - `pathAllowed` is false for `__proto__`, `constructor`, `toString`, `hasOwnProperty` and an unknown api (RT-36: it threw `TypeError` before), true and false as the table says for each api, Google with and without `/v1beta`;
  - `modelOf` reads the body's `model`, refuses a non-object, a non-string, a 257-character model and bad JSON, and reads Google's model from the path;
  - `keys.agentOf`: a launch's key from its own address gives its agent; from another VM's address, after `remove`, with one changed character, upper case, or the placeholder: null; a 16-byte key is refused at `add`; `presentedKey` takes `x-api-key`, `x-goog-api-key` or `authorization: Bearer`, and refuses two different keys, a joined duplicate, `Basic`, a double space;
  - `upstreamHeaders` forwards only `content-type`, `accept`, `accept-encoding`, `anthropic-version`, `anthropic-beta`, `openai-beta`, `user-agent` and `x-stainless-*`; drops `authorization`, `x-api-key`, `x-goog-api-key`, `cookie`, `host`, `x-forwarded-for`, `proxy-authorization`; sets the credential per api (`x-api-key` for Anthropic, `x-goog-api-key` for Google, `authorization: Bearer` otherwise and for claude) and the provider's literal headers;
  - `resolveProvider` refuses an OAuth credential (R9), an `http:` base URL, a provider outside the owner's enabled models;
  - the server (`server.test.ts`, loopback, fake upstream): a request without a key, with another agent's key, for a model outside the agent's list, for a paused agent or one over budget is refused 403 with its reason and `resolveProvider` is never called (spy); the ninth concurrent request from one address gets 429; a 32 MiB + 1 body gets 413; a raw request with both `Transfer-Encoding: chunked` and `Content-Length`, and one with two `Host` headers, are refused; a relay with no Claude token answers 503 on `claude.internal`;
  - `usage.test.ts`: counts per agent, reported every 60 s (steppable clock), reset after each report;
  - `relay-key.test.ts`: every provider gets the key as its runtime key; `ANTHROPIC_AUTH_TOKEN` is set; nothing is written to a file;
  - integration (`relay.int.test.ts`, a loopback fake upstream with a self-signed CA trusted only by the test): the request each Pi client sends for each of the four apis (recorded by driving `pi-ai`'s stream with `baseUrl` `http://llm.internal:7842/<provider>` and a capturing `globalThis.fetch` stub; a client that bypasses `fetch` is recorded as such and replayed with its exact Host) passes `routeOf` and `pathAllowed`; a VM-side request presenting the relay key reaches the upstream with the real key and without the relay key; the streamed answer comes back unchanged. Mutants named in the files: drop the segment check, accept any method, an object instead of the `Map`, drop the address check in `agentOf`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (security contract, full code). `routes.ts`:

```ts
export type ApiKind = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
export const RELAY_HOSTS = Object.freeze({ llm: "llm.internal", claude: "claude.internal" });

/** A Map, never an object: `__proto__` or `constructor` as an api name finds nothing (RT-36). */
const PATHS: ReadonlyMap<string, readonly RegExp[]> = new Map<ApiKind, readonly RegExp[]>([
  ["anthropic-messages", [/^\/v1\/messages$/, /^\/v1\/messages\/count_tokens$/]],
  ["openai-completions", [/^\/chat\/completions$/]],
  ["openai-responses", [/^\/responses$/]],
  // Google's SDK may keep its version segment in the path (RT-36); T12's int test pins what Pi's client sends.
  [
    "google-generative-ai",
    [/^(?:\/v1beta|\/v1)?\/models\/[A-Za-z0-9._-]{1,128}:(?:streamGenerateContent|generateContent|countTokens)$/],
  ],
]);
const GOOGLE_MODEL = /\/models\/([A-Za-z0-9._-]{1,128}):/;
const QUERIES: ReadonlySet<string> = new Set(["", "?beta=true", "?alt=sse"]);
const SAFE_PATH = /^\/[A-Za-z0-9._~:-]+(?:\/[A-Za-z0-9._~:-]+)*$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The Host a VM sends: one of the two names, with the relay's port or none. */
const HOST = /^([a-z.]{1,32})(?::(\d{1,5}))?$/;

export type RelayRoute =
  | { readonly kind: "provider"; readonly provider: string; readonly path: string; readonly query: string }
  | { readonly kind: "claude"; readonly path: string; readonly query: string };

/** Spec §9: what a VM may ask, judged on the request line and Host before any key or credential is looked at. */
export function routeOf(method: string | undefined, host: string | undefined, url: string | undefined): RelayRoute | null {
  if (method !== "POST" || host === undefined || url === undefined) return null;
  const named = HOST.exec(host.toLowerCase());
  if (named === null) return null;
  const name = named[1];
  const cut = url.indexOf("?");
  const pathPart = cut < 0 ? url : url.slice(0, cut);
  const query = cut < 0 ? "" : url.slice(cut);
  if (!QUERIES.has(query) || !SAFE_PATH.test(pathPart)) return null;
  const segments = pathPart.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === ".." || /^\.+$/.test(segment))) return null;
  if (name === RELAY_HOSTS.claude) return pathAllowed("anthropic-messages", pathPart) ? { kind: "claude", path: pathPart, query } : null;
  if (name !== RELAY_HOSTS.llm) return null;
  const [provider, ...rest] = segments;
  if (provider === undefined || !PROVIDER.test(provider) || rest.length === 0) return null;
  return { kind: "provider", provider, path: `/${rest.join("/")}`, query };
}

export function pathAllowed(api: string, path: string): boolean {
  return PATHS.get(api)?.some((re) => re.test(path)) ?? false;
}

/** RT-17: the model a request names: in the path for Google, else the body's `model` (a string of at most 256 characters). */
export function modelOf(api: string, path: string, body: Buffer): string | null {
  if (api === "google-generative-ai") return GOOGLE_MODEL.exec(path)?.[1] ?? null;
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" && model.length > 0 && model.length <= 256 ? model : null;
}
```

  `keys.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";

/** What the daemon hands the relay at a VM's start (RT-03): the launch's relay key, its agent and the VM's bridge address. */
export interface RelayGrant {
  readonly launchId: string;
  readonly agentId: string;
  /** 32 random bytes; the worker presents them as 64 hex characters in the provider's own credential header. */
  readonly key: Buffer;
  readonly address: string;
}
const KEY = /^[0-9a-f]{64}$/;
const digest = (hex: string): string => createHash("sha256").update(hex, "utf8").digest("hex");

/**
 * The credential a request presents, from whichever header its SDK uses: `x-api-key` (Anthropic), `x-goog-api-key` (Google),
 * `authorization: Bearer` (OpenAI, the bridge's `claude`). Two that differ, or one that is not a relay key: none.
 */
export function presentedKey(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const found = new Set<string>();
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = headers[name];
    if (Array.isArray(value)) return null;
    if (value !== undefined) found.add(value);
  }
  const auth = headers.authorization;
  if (Array.isArray(auth)) return null;
  if (auth !== undefined) {
    const bearer = /^Bearer ([^\s]+)$/.exec(auth);
    if (bearer === null) return null;
    found.add(bearer[1] as string);
  }
  if (found.size !== 1) return null;
  const [key] = found;
  return key !== undefined && KEY.test(key) ? key : null;
}

/** The live relay keys (RT-03, owner Q4): looked up by digest, compared in constant time, bound to the VM's address. */
export function createRelayKeys() {
  const byDigest = new Map<string, RelayGrant>();
  const digestOf = new Map<string, string>();
  return {
    add(grant: RelayGrant): void {
      if (grant.key.length !== 32) throw new RangeError("relay key");
      const hex = grant.key.toString("hex");
      byDigest.set(digest(hex), grant);
      digestOf.set(grant.launchId, digest(hex));
    },
    remove(launchId: string): void {
      const found = digestOf.get(launchId);
      if (found !== undefined) byDigest.delete(found);
      digestOf.delete(launchId);
    },
    /** The agent a request speaks for, or null: unknown or revoked key, or a key presented from another address. */
    agentOf(key: string | null, address: string | undefined): string | null {
      if (key === null || address === undefined || !KEY.test(key)) return null;
      const grant = byDigest.get(digest(key));
      if (grant === undefined) return null;
      const same = timingSafeEqual(Buffer.from(key, "hex"), grant.key);
      return same && grant.address === address ? grant.agentId : null;
    },
  };
}
```

- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): the provider relay, its launch keys and its per-agent checks`.

### Task J1: The join: integration tests of both lanes and the relay link

Starts when both lanes are merged on the feature branch (rebased in lane order, A then B). Reviewed by Opus: it carries T12's daemon half.

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/gateway.int.test.ts`, `process-backend.int.test.ts`, `mirror.int.test.ts`, `apps/daemon/src/modules/sessions/vm-launch.int.test.ts`, `vm-attachments.int.test.ts`, `apps/daemon/src/modules/agent-vm/relay-link.ts`, `relay-link.test.ts`, `relay-link.int.test.ts`, `claude-token.ts`, `claude-token.test.ts`, `apps/daemon/src/modules/agent-vm/rpc.ts`
- Modify: `apps/daemon/src/compose-agents-vm.ts` (the relay link and the two Claude-token methods), `apps/daemon/src/modules/agent-vm/index.ts`

**Interfaces:**
- `createRelayLink(deps)`: forks `pap-relay` when `PAP_AGENTS_RUNTIME=vm` with an environment of `PI_CODING_AGENT_DIR` and the allowlisted variables only (it reads the owner's credentials through Pi's auth storage, as the models helper does); restarts it with backoff (1 s doubling to 30 s) and replays every live grant, policy and the token after a restart (RT-36); sends `relay_grant` from T7's `onLaunch` and `relay_revoke` from `onLaunchEnd`; sends `agent_policy` at each grant and whenever the agent's models change (the `models.available` cache is cleared, ADR 0068), its pause changes or its budget is reached or reset (`rg -n budget_reached apps/daemon/src/modules/runs`); logs each `relay_usage` and, when an agent's relay requests in a window exceed the runs its workers reported by more than 10, logs `agent_relay_mismatch {agentId}` (attribution, RT-17).
- `claude-token.ts`: `agents.vm.setClaudeToken` stores the token in `$PAP_HOME/secrets/claude-token` (0600 in 0700, `O_NOFOLLOW`, written whole then renamed) and pushes it to the relay; `clearClaudeToken` removes it and pushes `null`; `agents.vmStatus` reports `set` or `missing`, never the value (RT-46). A plain backup excludes it with the rest of `secrets/` (ADR 0063).
- `rpc.ts`: the handlers of the four T1 methods (decode, one service call, typed errors).

- [ ] **Step 1: Integration tests**, each written now from its task's interfaces (RED first: run before the wiring each needs):
  - `gateway.int.test.ts` (T6): a real guest (T5) in-process against a real gateway on 127.0.0.1:0 spawns the real pi-host worker over the socket (`PAP_TEST_PROVIDER_SCRIPT`); `request({ command: "get_state" })` answers; `stop()` resolves `exited`; the worker's `/proc/<pid>/environ` holds no gateway token (R24).
  - `process-backend.int.test.ts` (T7): spawn, prompt through the scripted provider, idle stop, crash (kill the guest) then restart on the next spawn; closing the daemon's gateway ends the guest and its workers (RT-47).
  - `vm-launch.int.test.ts` (T8a, T8b, T11b): open a CyberLooker-like agent's thread (Full Access, Tools: Full, a host sandbox profile with network), prompt, read the answer through the session stream, stop; a second open reuses the VM; a shell call is allowed with no question (R15: its audit row; the process backend cannot run R2's root shell, which T20b runs); a full-access continuation after a quota stop resumes (RT-10); `export_html` answers `unavailable`.
  - `mirror.int.test.ts` (T9): a run's entries appear in the mirror; `sessions.history` reads them with the VM stopped; a restart whose mirror lost its last line resumes from the mirror's end without `replace` (RT-39); deleting the VM's file between runs makes the next hello mismatch, the worker resends, the old mirror is kept under `replaced/` and the session is tainted (R14); a user message an inline test extension adds (`sendUserMessage`) is marked `unverified`, the owner's prompt is not (R32).
  - `vm-attachments.int.test.ts` (T10): a 5 MiB attachment arrives whole in the inbox and the prompt names its VM path.
  - `relay-link.int.test.ts`: the real relay child on loopback: a grant then a policy let the launch's key through for its own model and refuse another model; a revoke refuses the key; a killed relay is restarted and the grant still works; a request from a key granted to another address is refused.
- [ ] **Step 2: Unit tests** for `relay-link.ts` (fake child: replay after restart, policy pushes on each trigger, no secret in a log line) and `claude-token.ts` (0600, `O_NOFOLLOW`, a link refused, `vmStatus` never carries the value).
- [ ] **Step 3: Run** them. Expected: FAIL.
- [ ] **Step 4: Implement** the link, the token store, the handlers and the compose; fix what the integration tests found (each fix in the task that owns the file, as a commit of this task).
- [ ] **Step 5: Run** `pnpm vitest run --project unit apps/daemon/src/modules/agent-vm apps/daemon/src/modules/sessions packages/pi-host/src` and `pnpm vitest run --project integration apps/daemon/src/modules/agent-vm apps/daemon/src/modules/sessions/vm-launch.int.test.ts apps/daemon/src/modules/sessions/vm-attachments.int.test.ts packages/pi-host/src`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(agent-vm): the relay link, the Claude token, and both lanes tested together`.

### Task T13a: `pap-vmd` core: package, server, state and the safe copy (lane B)

**Files:**
- Create: `apps/vmd/package.json`, `apps/vmd/tsconfig.json`, `apps/vmd/tsconfig.build.json`, `apps/vmd/src/main.ts`, `server.ts`, `server.test.ts`, `state.ts`, `state.test.ts`, `locks.ts`, `locks.test.ts`, `safe-tree.ts`, `safe-tree.test.ts`
- Modify: `pnpm-workspace.yaml` (the new app), the knip config if it needs the entry (the only files of the plan both lanes could meet; nobody else changes them, see Lanes)

**Interfaces:**
- Consumes: T1 `VmdRequest`, `VmdResponse`, `VMD_MAX_FRAME_BYTES`; T2 codec.
- Produces:
  - `server.ts`: a unix socket at `/run/pap-vm/vmd.sock`, owned by `papUid` from `/etc/pap-vm/config.json`, mode 0600 (R36); one request per connection, at most `VMD_MAX_FRAME_BYTES`, answered with one `VmdResponse`, then closed. A request that fails the schema answers `bad_request` without running anything. Every call is logged as `vmd_call {op, agentId, taskKey, result, ms}`; `token` is never logged (RT-33). The ops are injected (T13b).
  - `state.ts`: the state root `/var/lib/pap-vm/<papUid>/` (0700 root): disks `agents/<id>/disk.img`, task disks `agents/<id>/tasks/<taskKey>/disk.img`, trash `trash/<id>-<stamp>/`, env files `run/<launchId>.env`, copies `build/<layer>/` and `staging/<id>/`, Dockerfiles `dockerfiles/<layer>/Dockerfile` (outside every context, RT-33). At start it sweeps `run/*.env` and every task disk whose VM is not running (RT-33, R30), and purges trash older than 7 days, then once a day (RT-40).
  - `locks.ts` (RT-33, RT-42): one operation at a time per agent (`vm.*` and `disk.*` of one agent queue); a second `image.build` of a tag already building, or a second `disk.populate` of an agent already populating, joins the running one; `disk.*` and `image.build` answer `disk_low` when the state folder's file system has less free space than the operation needs plus `PAP_MIN_FREE_DISK_MB`.
  - `safe-tree.ts` (security contract, full code below; run in the fix's scratch).
- [ ] **Step 1: Tests** (a temp state root, a fake clock), key assertions: a request over 64 KiB is refused before it is parsed; an unknown op and an unknown key are `bad_request` and run nothing (spy on the ops); the socket file is 0600 and owned by `papUid` (fake chown); the log line of a `vm.start` has no token (assert the logger's records); two `disk.grow` of one agent run one after the other; two builds of one tag run once; an op is `disk_low` under the floor (fake statfs); the start sweep removes `run/*.env` and an orphan task disk, and the daily purge removes trash older than 7 days only.
  - `copyTreeSafely`: links recreated as links (a relative `node_modules/.bin` link and an absolute link three levels down), never followed; a setuid file copied 0755; a hard link to an outside file of the same owner copied as content (documented); a leftover target replaced; a link at the root `link`; a missing source `missing`; a FIFO `special` without blocking, the partial target removed; another uid `owner`; the 12th entry over a cap of 11 `too_many`; the 1001st byte over a cap of 1000 `too_large`; a file a concurrent writer keeps growing never copies past the cap (RT-13: `copyFileSync` copied 5,010 bytes against 1,000 in the red-team's run). Mutants named in the file, each killed in scratch: the unbounded copy, `stat` in place of `lstat`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `safe-tree.ts`:

```ts
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, rmSync, symlinkSync, writeSync } from "node:fs";
import path from "node:path";

export interface SafeTreeLimits {
  /** Bytes copied in all, counted while reading: a file that grows during the copy stops it (RT-13). */
  readonly maxBytes: number;
  readonly maxEntries: number;
}
export type SafeTreeError = "link" | "special" | "owner" | "too_large" | "too_many" | "missing" | "changed";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
const at = (dirFd: number, name: string): string => `/proc/self/fd/${dirFd}/${name}`;
const MAX_LINK_TEXT = 4096;
const CHUNK = 64 * 1024;

class Stop extends Error {
  readonly reason: SafeTreeError;
  constructor(reason: SafeTreeError) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * R3, R7, RT-13: pap-vmd copies a tree pap's user owns (and can change while it is read) into a folder of its own. Every
 * entry is looked at and opened relative to its parent's descriptor (`/proc/self/fd/<fd>/<name>`) with O_NOFOLLOW, so a link
 * swapped in at any level is never followed. Links are recreated as links (their text, never their target: `mkfs.ext4 -d`
 * and BuildKit keep them as links, T0a); folders and regular files owned by `uid` are copied with modes masked to 0755/0644
 * (no setuid, setgid or sticky bit); anything else stops the copy. Bytes are counted as they are read. The source's own path
 * above its last component is followed: harmless, since every entry must still belong to `uid`. A leftover target from an
 * interrupted copy is removed first. On any refusal the partial target is removed.
 */
export function copyTreeSafely(source: string, target: string, uid: number, limits: SafeTreeLimits): SafeTreeError | null {
  let rootFd: number;
  try {
    rootFd = openSync(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "link";
  }
  rmSync(target, { recursive: true, force: true });
  const totals = { bytes: 0, entries: 0 };
  try {
    copyDir(rootFd, target, uid, limits, totals);
    return null;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (error instanceof Stop) return error.reason;
    throw error;
  } finally {
    closeSync(rootFd);
  }
}

/** An entry that vanished or changed kind between two looks at it stops the copy as `changed`, never as a crash. */
function settled<T>(look: () => T): T {
  try {
    return look();
  } catch {
    throw new Stop("changed");
  }
}

function openEntry(where: string, flags: number): number {
  try {
    return openSync(where, flags | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    // The entry was a file or folder a moment ago: a link or something else swapped in since.
    throw new Stop((error as NodeJS.ErrnoException).code === "ELOOP" ? "changed" : "special");
  }
}

function copyDir(dirFd: number, target: string, uid: number, limits: SafeTreeLimits, totals: { bytes: number; entries: number }): void {
  const stat = fstatSync(dirFd);
  if (!stat.isDirectory()) throw new Stop("changed");
  if (stat.uid !== uid) throw new Stop("owner");
  mkdirSync(target, { mode: 0o755 });
  for (const name of readdirSync(`/proc/self/fd/${dirFd}`)) {
    if (++totals.entries > limits.maxEntries) throw new Stop("too_many");
    const entry = settled(() => lstatSync(at(dirFd, name)));
    if (entry.uid !== uid) throw new Stop("owner");
    const into = path.join(target, name);
    if (entry.isSymbolicLink()) {
      const text = settled(() => readlinkSync(at(dirFd, name)));
      if (text.length === 0 || text.length > MAX_LINK_TEXT || text.includes("\0")) throw new Stop("special");
      symlinkSync(text, into);
    } else if (entry.isDirectory()) {
      const fd = openEntry(at(dirFd, name), O_RDONLY | O_DIRECTORY);
      try {
        copyDir(fd, into, uid, limits, totals);
      } finally {
        closeSync(fd);
      }
    } else if (entry.isFile()) {
      const fd = openEntry(at(dirFd, name), O_RDONLY);
      try {
        copyFile(fd, into, uid, limits, totals);
      } finally {
        closeSync(fd);
      }
    } else {
      throw new Stop("special");
    }
  }
}

function copyFile(fd: number, into: string, uid: number, limits: SafeTreeLimits, totals: { bytes: number }): void {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Stop("changed");
  if (stat.uid !== uid) throw new Stop("owner");
  const out = openSync(into, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const room = limits.maxBytes - totals.bytes;
      // One byte past the budget is enough to know the file does not fit.
      const n = readSync(fd, chunk, 0, Math.min(CHUNK, room + 1), null);
      if (n === 0) return;
      if (n > room) throw new Stop("too_large");
      totals.bytes += n;
      for (let done = 0; done < n; ) done += writeSync(out, chunk, done, n - done);
    }
  } finally {
    closeSync(out);
  }
}
```

- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(vmd): pap-vmd's server, state and safe copy`.

### Task T13b: `pap-vmd` operations: command lines, Dockerfiles and the ops (lane B)

**Files:**
- Create: `apps/vmd/src/ops.ts` (the request types and the dispatch of each op to its file), `ops.test.ts`, `argv.ts`, `argv.test.ts`, `dockerfile.ts`, `dockerfile.test.ts`, `ops-vm.ts`, `ops-vm.test.ts`, `ops-disk.ts`, `ops-disk.test.ts`, `ops-image.ts`, `ops-image.test.ts`

**Interfaces:**
- Consumes: T1, T13a; T0a's record (Kata runtime flags, the guest flags bwrap needs, the disk flags, the online grow); T16a's `net` port (injected: a fake until T16a).
- Produces (types: `VmStartRequest = Extract<VmdRequest, { op: "vm.start" }>`, `ImageBuildRequest = Extract<VmdRequest, { op: "image.build" }>`):
  - `argv.ts` (security contract, full code below): every command is built from checked fields and fixed paths and run with `execFile`, `shell: false`. `placement.runtime` holds T0a's runtime name, Kata config option and guest flags; `placement.disk` the disk flags.
  - `vm.start`: allocates the VM's address and MAC (`02:70:61:00:00:<n>`, from pap-vmd's own table, R22); writes the env file (`PAP_GATEWAY`, `PAP_GATEWAY_TOKEN`, `PAP_LAUNCH_ID`, `PAP_AGENT_ID`, `PAP_IMAGE_TAG`, one per line, from checked values: no newline can enter) 0600 and removes it whatever `nerdctl run` does (R8); runs `rmArgv` first (a leftover container of that name, RT-33); for `isolated`, creates the task disk (R30) and never names the agent's; runs `runArgv`; then `net.attach` (T16a: set element and neighbour); answers `{ address }`. On any failure after the run: `rmArgv`, `net.detach`, the task disk removed.
  - `vm.stop`: `rmArgv` (containerd forgets the token, R8), `net.detach`, and for a task its disk deleted (R30). `vm.pause` and `vm.resume` (`nerdctl pause`/`unpause`, no caller in sub-project 1), `vm.status`, `vm.list` (pap's namespace only).
  - `disk.create` (a sparse file of `diskMb` MiB, then `mkfs.ext4 -q -F` on it: a new file, never one a guest wrote), `disk.grow` (R31: `truncate` larger only, `bad_request` when smaller, `conflict` while a VM of the agent runs), `disk.delete` (to trash, or removed with `purge`; the agent's disk is `conflict` while any VM of the agent runs; a task key removes that task disk if its VM is not running), `disk.populate` (`copyTreeSafely` of the staging into `staging/<id>/` with `maxBytes` = `diskMb` MiB, then `mkfs.ext4 -q -F -d <copy>` on a new `disk.img`; never mounted), `trash.purge`.
  - `image.build`: `copyTreeSafely` of `$PAP_HOME/vm/build/<layer>/` into `build/<layer>/`, `renderDockerfile` into `dockerfiles/<layer>/`, `buildArgv` (base: `--no-cache`, RT-19); `image.list`, `image.prune` (keeps the given tags and the running images); `version`; `vmd.health` (`nft list table bridge pap_agents` succeeds, `pap0` is up, the state folder's free MiB).
- [ ] **Step 1: Tests** (fake `exec`, fake `net`, a temp state root), key assertions: every op's argv equals a fixed expected array; no argv element contains the token; an isolated start never names `agents/<id>/disk.img` and creates and later deletes its own task disk, even when the start fails; the env file is 0600 and gone after `vm.start` resolves or fails; `rm --force` runs before every `run` and at every stop; `disk.create` makes a sparse file and runs `mkfs.ext4 -q -F` on it; `disk.grow` runs no `e2fsck` or `resize2fs` (R31), refuses a smaller size (`bad_request`) and a running VM (`conflict`); `disk.delete` of the agent's disk while its task VM runs is `conflict`; `disk.populate` copies with the safe tree and runs `mkfs.ext4 -d`; a base build has `--no-cache` and the others do not; `renderDockerfile` of each layer equals a fixed text (base: the packages with `e2fsprogs`, the `fd` link, the environment line, the entrypoint); the Dockerfile is never inside the context folder.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (security contract, full code). `argv.ts` (run in the fix's scratch):

```ts
import { AGENT_NET } from "@pap/contracts";
import type { ImageBuildRequest, VmStartRequest } from "./ops.ts";

const BIN = "/opt/pap-vm/bin";
/** R5, RT-34: pap's own containerd, nerdctl state, CNI plugins and network list; never the system ones. */
const NERDCTL = [
  `${BIN}/nerdctl`,
  "--address",
  "/run/pap-vm/containerd.sock",
  "--namespace",
  "pap",
  "--data-root",
  "/var/lib/pap-vm/nerdctl",
  "--cni-path",
  "/opt/pap-vm/libexec/cni",
  "--cni-netconfpath",
  "/etc/pap-vm/cni",
] as const;

export const vmName = (agentId: string, taskKey: string | null): string =>
  taskKey === null ? `pap-${agentId}` : `pap-${agentId}-${taskKey}`;
/** A local image name that never resolves to a registry (`--pull never` as well). */
export const imageRef = (tag: string): string => `pap.local/${tag}:1`;

/** What pap-vmd chose for this start: the address and MAC it allocated (R22), the disk flags T0a recorded, the env file (R8). */
export interface VmPlacement {
  readonly ip: string;
  readonly mac: string;
  readonly disk: readonly string[];
  readonly envFile: string;
  /** T0a: the runtime name, Kata's config path option and the guest capabilities bwrap needs as guest root (R2). */
  readonly runtime: readonly string[];
}

export function rmArgv(name: string): string[] {
  return [...NERDCTL, "rm", "--force", name];
}

export function runArgv(request: VmStartRequest, placement: VmPlacement): string[] {
  return [
    ...NERDCTL,
    "run",
    "--detach",
    "--pull",
    "never",
    "--name",
    vmName(request.agentId, request.taskKey),
    ...placement.runtime,
    "--network",
    AGENT_NET.network,
    "--ip",
    placement.ip,
    "--mac-address",
    placement.mac,
    "--cpus",
    String(request.resources.cpus),
    "--memory",
    `${request.resources.memoryMb}m`,
    "--add-host",
    `llm.internal:${AGENT_NET.host}`,
    "--add-host",
    `claude.internal:${AGENT_NET.host}`,
    "--env-file",
    placement.envFile,
    "--read-only",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/tmp",
    ...placement.disk,
    imageRef(request.image),
  ];
}

/** R7, RT-19, RT-33: the Dockerfile lives outside the context; a base build never reuses a cached `apt-get upgrade`. */
export function buildArgv(request: ImageBuildRequest, contextDir: string, dockerfileDir: string): string[] {
  return [
    `${BIN}/buildctl`,
    "--addr",
    "unix:///run/pap-vm/buildkit.sock",
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${contextDir}`,
    "--local",
    `dockerfile=${dockerfileDir}`,
    "--output",
    `type=image,name=${imageRef(request.tag)},unpack=true`,
    ...(request.layer === "base" ? ["--no-cache"] : []),
  ];
}
```

  `dockerfile.ts` (R7; the base's `ENV` line carries R4's worker environment and `PI_OFFLINE=1`; `e2fsprogs` lets the guest grow its disk, R31):

```ts
import type { ImageBuildRequest } from "./ops.ts";
import { imageRef } from "./argv.ts";

const NODE_DIGEST = /^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/;

/** R7, RT-14 (e2fsprogs: the guest grows its own disk), RT-06/RT-37 (worker environment). */
const BASE_PACKAGES = ["bubblewrap", "git", "curl", "jq", "python3", "ripgrep", "fd-find", "ca-certificates", "e2fsprogs"] as const;
const apt = (names: readonly string[], upgrade: boolean): string =>
  `RUN apt-get update && ${upgrade ? "apt-get -y upgrade && " : ""}apt-get install -y --no-install-recommends ${names.join(" ")} && rm -rf /var/lib/apt/lists/*`;

/** Rendered by pap-vmd from a checked `image.build`: the daemon never sends Dockerfile text. `from` is a digest or a pap tag. */
export function renderDockerfile(request: ImageBuildRequest): string {
  const from = NODE_DIGEST.test(request.from) ? request.from : imageRef(request.from);
  const lines = [`FROM ${from}`, "ENV DEBIAN_FRONTEND=noninteractive"];
  if (request.layer === "base") {
    lines.push(apt(BASE_PACKAGES, request.upgrade));
    // Debian names fd `fdfind`; Pi looks for `fd` and, offline, never downloads one.
    lines.push("RUN ln -s /usr/bin/fdfind /usr/local/bin/fd");
    lines.push("COPY pap/ /opt/pap/");
    lines.push("ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 PI_OFFLINE=1 PI_CODING_AGENT_DIR=/agent/.pi/agent GIT_CEILING_DIRECTORIES=/agent");
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

- [ ] **Step 4: Run.** Expected: PASS. (`vmd.kata.int.test.ts` is written and run in T20a.)
- [ ] **Step 5: Commit** `feat(vmd): pap-vmd's operations, command lines and Dockerfiles`.

### Task T14a: Image inputs by allowlist and the package adapters (lane A)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/profile-allowlist.ts`, `profile-allowlist.test.ts`, `adapters.ts`, `adapters.test.ts`, `secret-scan.ts`, `secret-scan.test.ts`, `image-inputs.ts`, `image-inputs.test.ts` (none touches `agent-vm/index.ts`; T15 exports what it uses)

**Interfaces:**
- Produces: `prepareProfileContext(agentDir: string, out: string, secrets: KnownSecrets): { tag: string; skipped: string[] }` (writes `$PAP_HOME/vm/build/profile/pi-agent/`); `agentLayerTag(profileTag, systemPackages): string`; `KnownSecrets` = the owner's values pap knows (every key of `auth.json` through Pi's auth storage, the vault's values, the Claude token, the literal values of provider `headers`).
- The profile allowlist (security contract):
  - `settings.json` is read with pap's existing bounded JSON reader and rewritten with only `compaction`, `defaultThinkingLevel`, `modelThinkingLevels`, `enabledModels`, `defaultProvider`, `defaultModel`, `packages` (and `skills` entries that point inside copied folders).
  - Each npm package from `<agentDir>/npm/node_modules/<name>` at the version `settings.json` pins, each git package from `<agentDir>/git/...`, each local path package into `local/<name>/`; `<agentDir>/skills`. pi-mem0 is never copied (R17, reported in `skipped`).
  - Inside every copied folder (RT-18): no `.git/`; no name matching `.env*`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `id_*`, `auth.json`, `*credentials*`, `*.sqlite`, `*.db`; a link is copied as a link only when its target, resolved, stays inside the package (others skipped and reported); no special file.
  - A generated `models.json`: each provider gets `baseUrl: "http://llm.internal:7842/<provider>"` (RT-16), `apiKey: "pap-placeholder"`, and **no** `headers` (the relay adds them host-side, RT-18).
  - `secret-scan.ts`: before the tag is computed, every copied file is scanned for every `KnownSecrets` value (exact bytes, values of 8 characters or more, the redactor's rule); a hit refuses the build with the file's name (never the value) and the notice "Un fichier du profil Pi contient un secret ; il n'entre pas dans l'image."
  - Adapters: pi-claude-bridge's config sets `ANTHROPIC_BASE_URL=http://claude.internal:7842` and names no token (the worker sets `ANTHROPIC_AUTH_TOKEN` to its relay key, T12); pi-web-access gets a config with placeholder keys; pi-mcp-adapter keeps stdio servers whose command is a binary inside a copied package and drops the others (reported in `skipped`). An unknown package enters without its config.
- [ ] **Step 1: Tests**, key assertions (RT-18): a scratch agent dir containing `auth.json`, `sessions/`, `mem0/`, `pi-web-session-index.json`, a `.credentials.json`, an `.env`, an unknown `foo.json`, and **inside a package** a `.git/config` with `https://user:token@host`, an `.npmrc` with `_authToken`, a `key.pem` and a link to a folder outside the package, produces a context where none of them exists (scan the output: no file named like them, no file content containing the marker planted in each); a provider with a literal `api-key` header gives a `models.json` without `headers`; a package file holding the vault's value refuses the build and names the file; every generated URL names port 7842; pi-mem0 is skipped; the same inputs give the same tag twice; changing one package version changes the profile tag.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): image inputs by allowlist, with secrets kept out`.

### Task T14b: The agent bundle and the rebuild policy (lane A)

**Files:**
- Create: `scripts/build-agent-bundle.ts`, `scripts/build-agent-bundle.test.ts`, `apps/daemon/src/modules/agent-vm/image-policy.ts`, `image-policy.test.ts`, `base-context.ts`, `base-context.test.ts`
- Modify: root `package.json` (`build` runs the bundle step after `pnpm -r run build`), `scripts/build-archive.ts` and `scripts/build-npm.ts` (ship `packages/pi-host/dist-agent/`; `build-npm.ts` is 380 lines: at most +3 there, else move its file list to a new module first), `.gitignore`

**Interfaces:**
- Produces: `dist-agent/` = pi-host's `dist` plus a flat production `node_modules` (`pnpm --filter @pap/pi-host deploy --prod --config.node-linker=hoisted`); links inside it are allowed only when they stay inside (T13a copies them as links); `prepareBaseContext(bundle: string, out: string, nodeDigest: string): { tag }` (the digest from `vm-assets.json`, T16b); `imagePolicy` deciding `use | build-then-use | refuse` per spec §6.
- `imagePolicy`: `build-then-use` keeps the agent on its old image while the new one builds and posts the thread notice "Une nouvelle image est en préparation ; cet agent tourne sur l'ancienne." (spec §6); `refuse` when the running image's protocol differs from `AGENT_VM_PROTOCOL`; a base rebuild once per ISO week (the base's `image.build` carries `upgrade: true` and pap-vmd builds it with `--no-cache`, R7).
- [ ] **Step 1: Tests**, key assertions: the bundle holds `dist/guest/main.js` and `dist/relay/main.js` and every link in it resolves inside it; the base tag changes with the bundle and the digest only; `imagePolicy` answers `build-then-use` with the notice once when the profile changed, `refuse` on a protocol change, and schedules one base rebuild per ISO week (steppable clock).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** the tests and `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-vm): the agent bundle and the image rebuild policy`.

### Task T15: The Kata backend through pap-vmd (join, against a fake pap-vmd)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/vmd-client.ts`, `vmd-client.test.ts`, `kata-backend.ts`, `kata-backend.test.ts`, `trash.ts`, `trash.test.ts`, `apps/daemon/src/modules/agents/vm-steps.ts`, `vm-steps.test.ts`
- Modify: `apps/daemon/src/compose-agents-vm.ts` (the Kata backend outside tests, the image policy of T14b), `apps/daemon/src/modules/agent-vm/index.ts` (exports, T14's included), the agent delete and quarantine sequences (`rg -n "QUARANTINE_STEPS|agent_delete_incomplete" apps/daemon/src/modules/agents`; one line each, the step bodies in `vm-steps.ts`)

**Interfaces:**
- Consumes: T7 `AgentRuntimeBackend`, T13 requests, T14a and T14b (inputs, tags, policy).
- Produces:
  - `createVmdClient(socketPath)`: one connection per request, frames bounded by `VMD_MAX_FRAME_BYTES` both ways, a 10-minute deadline for `image.build` and `disk.populate`, 60 s otherwise.
  - `createKataBackend(deps: { client: VmdClient; images: ImagePolicy; logger }): AgentRuntimeBackend`: a first start of an agent creates its disk (`disk.create {taskKey: null}`) when it has none and is not migrating (T17 does), grows it when the profile's `diskMb` grew (`disk.grow`, refused `conflict` while a VM runs: the grow waits for the next start with a notice), builds the images the policy asks for, then `vm.start`; an isolated task starts with `kind: "isolated"` and its key and never calls a `disk.*` op (R30). The layout is `layoutOf("kata", …)`.
  - Agent delete gains the step `vm` (stop every VM of the agent, `disk.delete {taskKey: null, purge: false}` to pap-vmd's trash, the mirrors folder moved to `$PAP_HOME/agents/.trash/<id>-<stamp>/`, 7 days); quarantine gains `vm` **right after the pause and before the other steps** (stop, revoke the launch, relay revoke, keep the disk; RT-41).
  - `trash.ts`: the daemon's half of "Purge now" (`agents.purgeTrash {agentId}`: pap-vmd's `trash.purge` and the mirrors' trash) and a daily sweep of `$PAP_HOME/agents/.trash` older than 7 days (RT-40).
  - Crash pause (RT-40): `onCrashPause` sets the agent's existing pause (persisted, reason `crashed`), posts an Inbox item through the agents events ("<agent> s'est arrêté trois fois en dix minutes ; il est en pause.") and Resume clears it as today.
- [ ] **Step 1: Tests** (fake client recording every request), key assertions: a first start creates the disk, builds missing images, then starts; a stop revokes the token and the relay grant; an isolated task's start and stop name only `vm.*` with its task key, never a `disk.*` op, even when the task fails (Review Focus 4); a grow while a VM runs answers `conflict` and the start goes on with a notice; delete leaves the disk in pap-vmd's trash, the mirrors in the daemon's trash and the agent row gone; quarantine runs `vm` second and keeps the disk; "Purge now" calls `trash.purge` with the agent's id; three crashes pause the agent persistently and post one Inbox item; the client refuses an answer over 64 KiB.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. (`kata-backend.kata.int.test.ts` is written and run in T20a.)
- [ ] **Step 5: Commit** `feat(agent-vm): the Kata backend through pap-vmd`.

### Task T16a: The agent network in pap-vmd (lane B)

**Files:**
- Create: `apps/vmd/src/net.ts`, `net.test.ts`, `scripts/ci/netns-spoof.sh`, `scripts/ci/netns-spoof.py`

**Interfaces:**
- Consumes: T1 `agentNetRuleset`, `portElement`, `VmPort`; T0a's record (how a VM's bridge port is named).
- Produces: `createNet(deps: { exec; state; clock }): { allocate(): { ip: string; mac: string }; attach(name: string, address: { ip: string; mac: string }): Promise<void>; detach(name: string): Promise<void>; restore(): Promise<void> }`:
  - `allocate`: the lowest free address from `10.213.0.2` to `.254` and its MAC `02:70:61:00:00:<last octet in hex>`, persisted in the state folder (`run/addresses.json`) until `detach`.
  - `attach`: finds the VM's bridge port the way T0a recorded (retried for up to 5 s: the port appears after `nerdctl run` returns), then `nft add element bridge pap_agents ports <portElement(...)>` and `ip neigh replace <ip> lladdr <mac> dev pap0 nud permanent`, each with `execFile` and fixed arguments. Until the element exists, the bridge drops the VM's frames (fail closed; the guest retries its dial, T5). A port that never appears fails the start (T13b stops the VM).
  - `detach`: `nft delete element …` and `ip neigh del …`; missing ones are not errors.
  - `restore`: at pap-vmd's start, after the unit loaded the ruleset (which empties `ports`), re-adds the element and neighbour of every VM `vm.list` shows running.
- `scripts/ci/netns-spoof.sh`: the fix's scratch check as a script (system `ip`, `nft`, `python3`): a bridge `pap0`, two network namespaces with veth "VMs", the ruleset, both elements; it asserts the gateway and relay ports are reachable from VM a, port 2222 and VM b are not, the relay port is not reachable from the namespace's own `lo`, and after VM a sends gratuitous ARP replies claiming VM b's address and SYNs from VM b's address the host's neighbour entry for VM b keeps VM b's MAC and the drop counter moved; it exits non-zero on any failure. It must be run as root in a throwaway network namespace: in CI `sudo unshare --net sh scripts/ci/netns-spoof.sh` (T20b); locally the controller runs it in a rootless privileged podman container (`podman run --rm --network none --privileged -v /usr:/hostusr:ro -v <checkout>:/work:ro <an image with python3> sh /work/scripts/ci/netns-spoof.sh`, the host's `ip` and `nft` through its loader as in the fix's scratch). With the ruleset of the original plan the same script fails (the ARP poisoning and the local relay connection succeed): keep that as a comment in the script.
- [ ] **Step 1: Tests** (fake exec, temp state), key assertions: `allocate` never gives `.1`, `.255` or an address in use, and survives a pap-vmd restart; `attach` runs exactly the expected `nft` and `ip` argv (never a shell string) and retries the port lookup with the clock; a port that never appears rejects; `detach` of an unknown VM is quiet; `restore` re-adds every running VM's element after a load; a port name from the lookup that `portElement` refuses fails the start.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** the tests, then the controller runs `netns-spoof.sh` in the podman container. Expected: PASS.
- [ ] **Step 5: Commit** `feat(vmd): per-VM anti-spoofing on the agent bridge`.

### Task T16b: `pap vm setup | uninstall`, the pinned stack and the units (lane B)

**Files:**
- Create: `apps/daemon/src/cli/vm/setup.ts`, `setup.test.ts`, `uninstall.ts`, `uninstall.test.ts`, `assets.ts`, `assets.test.ts`, `vm-assets.json`, `units.ts`, `units.test.ts`, `configs.ts`, `configs.test.ts`
- Modify: `apps/daemon/src/cli/run-cli.ts` (two commands: +2), `scripts/release-assets.ts` (build `pap-vmd-<version>.tar.gz`, the pap-vmd bundle, and write its SHA-256 into the release's `vm-assets.json`), `docs/agents/install.md`

**Interfaces:**
- Produces: `pap vm setup --user <name> [--dev-from-tree]` (root only, else exit 1 with "run with sudo"; `--user` required, R36):
  - Downloads the archives named in `vm-assets.json` (Kata static, nerdctl-full, the Node tarball, the pap-vmd bundle of this pap version) and checks each SHA-256 before anything is installed; installs under `/opt/pap-vm/` (root-owned 0755): pap-vmd and Node come only from these artefacts (R19, RT-22). `--dev-from-tree` copies the built `apps/vmd/dist` and the running Node instead and prints "Code your user can change will run as root (testing only)."
  - Writes `/etc/pap-vm/config.json` `{ papUid, papGid, papHome }` of `--user`; `containerd.toml` (root, state, socket under `/run/pap-vm/`); `buildkitd.toml` (containerd worker on pap's socket, namespace `pap`, no OCI worker); `/etc/kata-containers/runtime-rs/configuration.toml` (T0a: the only non-shipped config runtime-rs reads) from the archive's `runtime-rs/configuration-clh-runtime-rs.toml` with `default_memory = 256`, `default_vcpus = 1`, `static_sandbox_resource_mgmt = true` (R29), each key checked to exist in the shipped file before it is set (else setup stops naming the key), the file's first line `# written by pap vm setup`, and setup refusing to overwrite a file or link at that path that does not start with it (another Kata user owns the host's default); the shim wrapper `/opt/pap-vm/bin/containerd-shim-kata-clh-v2` execs `/opt/kata/runtime-rs/bin/containerd-shim-kata-v2`, runtime name `io.containerd.kata-clh.v2`, and pap's containerd unit puts `/opt/pap-vm/bin` first on its `PATH`; the CNI conflist of T1 in `/etc/pap-vm/cni/`; the ruleset of T1 in `/etc/pap-vm/agents.nft`.
  - Units `pap-vm-containerd.service`, `pap-vm-buildkit.service`, `pap-vmd.service` (root; `ExecStartPre`: create `pap0` if missing, address `10.213.0.1/24`, `sysctl -w net.ipv6.conf.pap0.disable_ipv6=1`, `nft -f /etc/pap-vm/agents.nft`; `ProtectHome=read-only`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, `ProtectSystem=strict` with `ReadWritePaths=/var/lib/pap-vm /run/pap-vm`), with `ExecStart` under `/opt/pap-vm/` only. A udev rule that keeps udev from probing pap's disks only if T0a saw a probed loop device.
  - Prints, when `ufw` or `firewalld` is active, the rule to allow 7841 and 7842 on `pap0` (RT-34); idempotent (every write compares first); never touches `/etc/cni/net.d`, another owner's `/etc/kata-containers` file or the system containerd (R5); `pap vm uninstall` removes the Kata config only when it still starts with pap's line.
  - `pap vm uninstall [--purge]` reverts exactly what setup wrote and leaves `/var/lib/pap-vm` unless `--purge`.
  - `vm-assets.json` entries: `{ name, version, url: "https://…", sha256: 64 hex }`, values from T0a's record (placeholders until it lands); the base image digest for T14b; the pap-vmd entry filled by `release-assets.ts`.
- [ ] **Step 1: Tests** (fake fs, exec and downloader; no network), key assertions: a SHA-256 mismatch stops before anything is installed; without `--dev-from-tree` no file of the running tree is copied (fake fs records every source); `--dev-from-tree` prints the residual; a second run changes nothing; the units' `ExecStart` point under `/opt/pap-vm/` only and `pap-vmd.service` carries the hardening above and the `disable_ipv6` line; `config.json` names the uid of `--user`; the Kata config has the three values; setup refuses without `--user`; `release-assets` writes the bundle's hash into `vm-assets.json`; uninstall removes exactly what setup wrote.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. (The real `sudo pap vm setup` runs in T20a.)
- [ ] **Step 5: Commit** `feat(cli): pap vm setup and uninstall, from pinned artefacts`.

### Task T17: Migration of existing agents, and the host-mode refusal (join)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/migration.ts`, `migration.test.ts`, the agents store migration `apps/daemon/src/modules/agents/migrations/<timestamp>_agent_runtime.sql` (a `runtime` column, default `host`; the naming of `202610151110_agents.sql`)
- Modify: `apps/daemon/src/modules/agents/store.ts` (read and set `runtime`: +4), `apps/daemon/src/modules/sessions/agent-gate.ts` (R12: +3)

**Interfaces:**
- Produces: `stageMigration(papHome, agentId, threadPiPath | null, diskMb): { staging: string; skipped: string[] }` writing `$PAP_HOME/vm/staging/<agentId>/home/...` (a copy of the old home: links copied as links only when their target stays inside the home, others skipped and listed; at most `diskMb` MiB; no special file) and `.pi/sessions/<file>`; then `disk.populate` (pap-vmd copies the staging with `copyTreeSafely` and runs `mkfs.ext4 -q -F -d`; the disk is never mounted); the mirror seeded from the same session file (`.mirrors/<id>/<file>`); the old home's contents moved to `$PAP_HOME/agents/.trash/<id>-<stamp>/` (7 days, T15's sweep) and `agents/<id>/` left empty, 0700 (RT-08: a host-mode reader finds nothing); the agent's `runtime` set to `vm` last (R12).
- Runs once, at the first VM start of an agent whose `runtime` is `host` and that has a host home. Never in read-only database mode (RT-42): the start is refused `sandbox_unavailable` with "La migration de cet agent attend que la base soit de nouveau modifiable."
- R12: with `PAP_AGENTS_RUNTIME=host`, `agentGate` refuses an agent whose `runtime` is `vm` (`sandbox_unavailable`, log `agent_vm_only`, the thread notice).
- [ ] **Step 1: Tests**, key assertions: staging contains the home's files and the thread file and nothing from other agents; a link inside the home that leaves it is skipped and listed, one inside it is kept as a link; a home over `diskMb` refuses before `disk.populate`; the mirror equals the thread file; the old home's contents are in the trash and `agents/<id>/` is empty; `runtime` is `vm` only after everything else succeeded; a second start does not migrate again; a failed populate leaves the old home in place, `runtime` `host` and the agent startable (no half state); read-only mode refuses with the sentence; host mode refuses a migrated agent with `agent_vm_only` and the notice, and still starts an unmigrated one.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. (`migration.kata.int.test.ts` is written and run in T20a.)
- [ ] **Step 5: Commit** `feat(agent-vm): migrate an agent's home and thread into its first disk`.

### Task T18: `pap doctor` and the agents' VM status (join)

**Files:**
- Create: `apps/daemon/src/cli/doctor/checks-vm.ts`, `checks-vm.test.ts`, `apps/daemon/src/modules/agent-vm/status.ts`, `status.test.ts`
- Modify: `apps/daemon/src/cli/doctor/registry.ts` (+1), `apps/daemon/src/compose-agents-vm.ts` (the status)

**Interfaces:**
- Produces: checks `vm.kvm` (`/dev/kvm` usable; its fix names the nested-virtualization line of `install.md`, R10), `vm.vmd` (`version` equals pap's, else "run `sudo pap vm setup`", R6), `vm.stack`, `vm.network` (both from `vmd.health`: the root-only facts, RT-40), `vm.images`, `vm.disk` (agent disks, kept mirrors and `PAP_MIN_FREE_DISK_MB`, the state folder's free space from `vmd.health`), `vm.firewall` (warn when `ufw` or `firewalld` is active); each `CheckResult` has a `fix`. `agents.vmStatus` → T1's view (the same sentence `pap doctor` prints). In `vm` mode an unusable stack refuses agent launches `sandbox_unavailable` with the sentence. Checks run only when `PAP_AGENTS_RUNTIME=vm` (else `skip`).
- [ ] **Step 1: Tests**, key assertions: each check's ok, warn and fail texts are fixed strings; a pap-vmd whose `version` differs fails with `sudo pap vm setup`; an unreachable pap-vmd fails `vm.vmd` and greys out every agent; disk room adds agent disks and kept mirrors to `PAP_MIN_FREE_DISK_MB`; `vmStatus` never carries the Claude token, only `set` or `missing`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(doctor): checks for the agent VM stack`.

### Task T19: Web: the agent form, the VM status and the Claude token (join)

**Files:**
- Create: `apps/web/src/features/agents/AgentResources.tsx`, `AgentResources.test.tsx`, `AgentPackages.tsx`, `AgentPackages.test.tsx`, `VmStatus.tsx`, `VmStatus.test.tsx`, `apps/web/src/features/settings/ClaudeToken.tsx`, `ClaudeToken.test.tsx`, catalog entries (`en`, `fr`)
- Modify: `apps/web/src/features/agents/AgentForm.tsx` (compose the two new sections: at most +8 lines), the Settings › Agents page (one line), the agents rail (greyed entries: +2), the transcript row (the `unverified` mark: +3), Settings › Memory (one line)

**Interfaces:**
- Consumes: T1 fields and methods (`agents.vm.setClaudeToken`, `clearClaudeToken`, `agents.vmStatus`, `agents.purgeTrash`), `TranscriptRow.unverified`.
- The form shows memory (MiB), CPUs, disk (MiB, never below the saved value: "le disque ne peut qu'être agrandi"), system packages (chips, validated with `SystemPackage` as typed), Pi packages (ticks; "Tous" by default). In `vm` mode the host-sandbox switch says "Ne s'applique pas aux agents en VM : leur shell est toujours isolé, sans réseau." (R15) and the vault says R11's sentence. `VmStatus` replaces `SandboxStatus` when `runtime` is `vm` and shows the doctor sentence when unusable; the agents rail greys every agent out with that sentence (spec §12, RT-46). The Claude token field (Settings › Agents) is write-only like the provider form's keys: "Enregistré" or "Manquant", Replace and Remove (RT-46). A deleted agent's line offers "Purger maintenant" (RT-40). A transcript row with `unverified` shows "pas envoyé depuis pap" next to the author (R32). Settings › Memory says "pi-mem0 ne fonctionne pas dans les agents en VM (sous-projet 5)." (R17).
- Boards: the agent form follows the CHOSEN board `docs/design/explorations/09-agent-space-inbox.html`; no board exists for `VmStatus`, the Claude token or the `unverified` mark: they reuse `SandboxStatus`' layout, the provider form's key field and the transcript's existing author line. Say so in the commit body.
- [ ] **Step 1: Tests**, key assertions: a disk value below the saved one cannot be submitted; an invalid package name shows the field error and is not sent; the token field is empty after save and its value never reaches a store or the DOM after submit; Remove calls `clearClaudeToken`; greyed rail entries carry the sentence; an `unverified` row shows the mark and a normal row does not; the French catalog spells "mémoire", "processeurs", "paquets système", "agrandi", "envoyé" with their accents.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** (tokens only, no arbitrary values). **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): agent resources, packages, VM status and the Claude token`.

### Task T20a: The real stack on this VPS (KVM tail)

Starts when `/dev/kvm` exists on this VPS (R10, owner Q1: the owner enables nested virtualization on the Hyper-V host). Kata tests skip locally with one warning without `/dev/kvm` or `pap-vmd` and fail under `CI=1`.

**Files:**
- Create: `apps/vmd/src/vmd.kata.int.test.ts`, `apps/daemon/src/modules/agent-vm/kata-backend.kata.int.test.ts`, `migration.kata.int.test.ts`, `apps/daemon/src/testing/kata-bed.ts`
- Modify: `docs/research/agents-vm-risk-checks.md` (this host's section)

- [ ] **Step 1: This host** (controller): `ls -l /dev/kvm`, `grep -cE 'vmx|svm' /proc/cpuinfo`, kernel, free RAM and disk; T0a Steps 3 and 4 again with the pinned stack (nested virtualization may differ from the runner): cold start, `VM_OVERHEAD_MB`, the disk flags, the online grow. Append to the record; a value that differs from T0a's replaces it where the code uses it (T7's constant, T13b's flags), as a commit of this task.
- [ ] **Step 2: Install** (controller): `sudo pap vm setup --user ubuntu --dev-from-tree` twice (the second changes nothing), then T0a Step 5's reachability and spoofing checks against the installed stack; `sudo pap vm uninstall` leaves no unit, rule, bridge or socket; install again.
- [ ] **Step 3: Kata tests** (against the installed pap-vmd; the test bed starts a daemon on a temp `PAP_HOME` and never the preview):
  - `vmd.kata.int.test.ts`: create a disk, start a VM from a tiny test image, status `running`, stop, delete; an isolated start gets a blank disk, the agent's disk is untouched (a marker file written in the agent's VM is still there after the task), the task disk is gone after its stop; a grow while running is `conflict`, after the stop the guest's next boot grows the file system.
  - `kata-backend.kata.int.test.ts`: a full agent thread on the real stack with the scripted provider: open, prompt, answer, idle stop; reopening history does not start the VM (`stopped` while `sessions.history` answers); the guest's and the worker's `/proc/<pid>/environ` hold no token (R24).
  - `migration.kata.int.test.ts`: a host-mode agent with a home and a thread migrates; inside the VM `/agent/home` has its files and the thread continues with its history; host mode then refuses it (R12).
- [ ] **Step 4: Run** `CI=1 pnpm vitest run --project kata` here. Expected: PASS.
- [ ] **Step 5: Commit** `test(agent-vm): the real Kata stack on a KVM host`.

### Task T20b: Isolation tests in a VM and the Kata CI job (KVM tail)

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/network.kata.int.test.ts`, `shell.kata.int.test.ts`, `scripts/ci/kata-setup.sh`
- Modify: `.github/workflows/ci.yml` (a `kata` job after `build`), the vitest workspace config (a `kata` project matching `*.kata.int.test.ts`; the `integration` project excludes them)

**Interfaces:**
- `network.kata.int.test.ts` (RT-28): from a VM, `nc` to the bridge's `:22`, to the other VM, and to a LAN or Docker address fail; the gateway and relay ports answer; a gratuitous ARP and a spoofed source from inside one VM (a raw socket in the guest, as guest root outside bwrap) leave the host's neighbour entry and the other VM's channel intact; the relay refuses a caller outside the VMs (the test's own process to `10.213.0.1:7842`).
- `shell.kata.int.test.ts` (RT-28): pap's `bash` in a VM: `python3 -c 'import socket; socket.socket(40, 1)'` and `unshare -U true` fail with EPERM; `ls /agent/.pi` is empty; `/proc` shows only the sandbox's processes; `ip link` shows only `lo`; two concurrent shells of two workers each see their own overlay (R27).
- The `kata` job runs on the runner T0a validated (`ubuntu-24.04` with KVM): checks `/dev/kvm`; `scripts/ci/kata-setup.sh` runs `sudo node apps/daemon/dist/main.js vm setup --user runner --dev-from-tree` and pre-pulls the pinned base image once (the only network use of the job: the pinned archives and that digest, RT-44); runs `sudo unshare --net sh scripts/ci/netns-spoof.sh` (T16a); then `CI=1 pnpm vitest run --project kata`; uploads `journalctl -u 'pap-vm*'` on failure. Without KVM the job fails (never skips under `CI=1`).
- [ ] **Step 1:** write the two test files and the setup script; run them here (`CI=1 pnpm vitest run --project kata`). **Step 2:** add the project and the job; push the branch and read the run. **Step 3:** fix until green. **Step 4: Commit** `ci: run the Kata and isolation tests on a KVM runner`.

### Task T21: Docs and the rulings archive

**Files:**
- Create: `docs/agents/agents-vm.md` (the topic note: runtime, gateway, guest, mirror, relay, pap-vmd, network, setup, doctor, test seams, known limits)
- Modify: `AGENTS.md` (an "Agents in microVMs" section: `PAP_AGENTS_RUNTIME`, `PAP_AGENTS_MEMORY_MAX_MB`, `PAP_TEST_AGENT_RUNTIME`, `pap vm setup --user|uninstall`, the KVM requirement, R12's refusal), `docs/agents/agents.md` (pointer), `docs/agents/install.md`, `docs/agents/doctor.md`, `docs/adr/0078-agents-run-in-microvms.md` (final), `docs/research/decisions-log.md` (the merge decision)
- Create at merge: `docs/research/agents-vm-1-rulings.md` (R1 to R38 plus execution rulings), `agents-vm-1-sdd-ledger.md`, `agents-vm-1-final-review.md`

- [ ] **Step 1:** write the notes. Known limits must include: the VM boundary is a KVM boundary (a guest kernel or Cloud Hypervisor escape is the residual); x86_64 only; the shell has no network until sub-project 2; OAuth providers refused unless T0b admitted them (R9); pap-vmd lags `pap update` until `sudo pap vm setup` (R6); `--dev-from-tree` runs user-writable code as root (R19); R26's `grep`/`find`/`ls` root race; MCP stdio servers and extension subprocesses run outside bwrap and the file rule (RT-37, sub-project 3); search does not index mirrors (RT-31); `export_html` is unavailable for VM agents (R37); `pap backup` holds mirrors, not disks (sub-project 4); the worker reports its own taint, untrusted once a VM is compromised (sub-project 3). **Step 2:** `pnpm format:check`. **Step 3: Commit** `docs(agents-vm): the runtime topic note, install and doctor`.

## Self-review against the spec

| Spec | Task |
|---|---|
| §4 pap-vmd, AgentRuntime, gateway, network | T13a, T13b, T7, T6, T1 (ruleset), T16a, T16b |
| §5 inside the VM: users, shell, file rule, token, no network | T11a (R2, R18), T11b (R15, R26), T5 and T4 (R24) |
| §6 image: layers, allowlist, adapters, rebuild, weekly base, per-agent packages | T14a, T14b, T13b (R7), T16b (pins), T5 (packages, RT-29) |
| §7 config fields and host ceilings | T1, T8b (RT-30), T19 |
| §8 disk, lifecycle, cap, crash pause, isolated task, boot, delete, quarantine | T7 (R29), T13b (R30, R31), T15 (RT-40, RT-41), T17 |
| §9 provider path | T12, J1 (R13, R34) |
| §10 channel | T2, T4, T5, T6 (RT-27, RT-35) |
| §11 mirror | T9a, T9b (R1, R14, R23, R32) |
| §12 install and doctor | T16b (R19), T18, T19 |
| §13 migration and rollout | T17 (R12), T7 config, T8a |
| §14 code changes | every task; R25 moves the VM shell's argv to pi-host |
| §15 testing | every task; J1 (process backend), T20a and T20b (Kata, isolation, CI) |
| §17 risks | T0a, T0b, T20a |
| Decisions 106 to 113 | R1 to R38; decision 113's answers are R10 to R22 |

## Deferred minors

- **AVM1-RT-31:** search does not index mirrors in sub-project 1 (the scanner takes one root; a second scanner instance needs its own tests): a known limit in the topic note, for a follow-up.
- **AVM1-RT-37 (its remaining half):** MCP stdio servers and extension subprocesses still start with the worker's cwd outside bwrap and the file rule; this plan only sets `GIT_CEILING_DIRECTORIES=/agent` (R4). A neutral cwd and their confinement belong to sub-project 3's policy at the box's exits.

## Ledgers

- **Owner answers:** decisions 106 to 113, every recommendation. Plan rulings R1 to R9 approved (decision 112) and corrected here from the red-team's §8; R10 to R22 are decision 113; R23 to R38 are this fix's, for the owner to see with the plan.
- **Red-team findings:** `.superpowers/redteam-agents-vm-1.md`; the fix report `.superpowers/planfix-report-agents-vm-1.md` maps each finding to its task.
- **Deferred to later sub-projects:** the shell's network, vault values bound to hosts, grants, refusal alerts (2); taint and approvals at the box's exits, prechecks and prompt chips in the VM, MCP and extension subprocess confinement, the default switch, deleting the host-bwrap agent code (3); backups and restore, `disk.snapshot`, S3 (4); OKF memory and mem0 removal (5); Kubernetes; adopting live VMs at boot; TLS on the channel.
