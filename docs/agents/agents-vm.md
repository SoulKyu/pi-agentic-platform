# Agents in microVMs (sub-project 1)

An agent runs in its own Kata Containers microVM (Cloud Hypervisor) with its own disk, CPU and memory. Pi's worker and a bubblewrap shell run inside it, and no provider credential is ever in the VM. Shipped behind `PAP_AGENTS_RUNTIME=vm`; `host` (bwrap on the host, `agents.md`) stays the default.

Decision: ADR 0078. Spec: `docs/specs/2026-10-19-agents-microvm-runtime-design.md`. Plan and rulings R1 to R38: `docs/plans/2026-10-19-agents-microvm-runtime.md`. Measurements of the real stack: `docs/research/agents-vm-risk-checks.md` (linked, not copied). Install: `install.md` ("Agent VMs"). Checks: `doctor.md` ("Agent VM checks").

Code: `apps/daemon/src/modules/agent-vm/` (gateway, runtime, mirrors, relay link, images, status, trash), `apps/daemon/src/compose-agents-vm*.ts`, `apps/vmd/` (pap-vmd), `packages/pi-host/src/{guest,relay,vm-shell,vm-files}/`, contracts `packages/contracts/src/{agents-vm,agents-vm-methods,agents-net,agents-resources,relay-ipc,vmd}.ts`.

## Settings

| Env | Meaning |
|---|---|
| `PAP_AGENTS_RUNTIME` | `host` (default) or `vm`; anything else stops the boot. In `vm` the boot waits for pap-vmd, `pap0` and pap's firewall table and ends with "run `sudo pap vm setup`" when they never come. |
| `PAP_AGENTS_MEMORY_MAX_MB` | Cap on the memory of all running agent VMs together. Default `max(1024, half of the RAM)`; an integer of at least 1024 or the boot stops. Each VM counts its `memoryMb` plus 512 (`VM_OVERHEAD_MB`). |
| `PAP_TEST_AGENT_RUNTIME` | `process`, tests only: the guest runs as a local process over the same gateway. Needs `PAP_TEST_PROVIDER_SCRIPT`, else the boot stops. Never set it outside tests. |
| `PAP_MIN_FREE_DISK_MB` | As elsewhere (1024). `agents.vmStatus` offers an agent's disk the free space of pap-vmd's state folder less this floor. |

Set `PAP_AGENTS_RUNTIME` in the unit (`pap doctor` reads the unit first, then the shell). Needs KVM: see "Setup" below. A host without KVM keeps the host runtime.

## Existing agents: no migration

pap ships no migration. Agents made in host mode are deleted and created again in VM mode: a VM agent gets a fresh disk at its first start (`disk.create`), and an old agent's recorded thread then fails with "the VM lost this conversation's file; the copy is kept". Delete the agent from its screen, then create it again.

- **Do not switch a VM agent back to host mode.** A VM agent's session file is its mirror (`$PAP_HOME/agents/.mirrors/<id>/`): a host worker would open it and append to it, and the VM's next resend replaces it, so the host-mode turns would survive only in the 7-day kept copy.
- The first VM-mode boot purges the trashed homes (`$PAP_HOME/agents/.trash/<id>-<stamp>` and the `.runs` entries) older than 7 days, including ones from agents deleted in host mode months earlier; host mode never purged them.

## Architecture in one page

- **pap-vmd** (`apps/vmd`, root, systemd system unit) is the only caller of pap's own containerd, Kata and BuildKit. It reads one typed request per connection on `/run/pap-vm/vmd.sock` (owned by pap's uid, 0600, at most 64 KiB, `VmdRequest` in `vmd.ts`). The daemon never sends a path, a command, an environment or Dockerfile text: pap-vmd builds them. `apps/vmd` imports only `@pap/contracts` and Node built-ins.
- **Disks** live in `/var/lib/pap-vm/<pap uid>/agents/<id>/disk.img` (root, 0700); the daemon never reads them and never parses an image a guest wrote. An isolated task gets a blank disk of pap-vmd's own at `tasks/<key>/disk.img`, deleted when the task's VM stops.
- **Guest** (`pap-guest`, `packages/pi-host/src/guest/`): the VM's entrypoint. It parks the gateway token in a file and re-executes itself without it in its environment, seeds `/agent/.pi/agent` from the image's `/opt/pap/pi-agent`, grows the file system online (`EXT4_IOC_RESIZE_FS`) and starts pi-host workers when the daemon asks, handing each the token on fd 3. Layout: `/agent/{home,knowledge,inbox,.pi}`; Pi runs with `PI_CODING_AGENT_DIR=/agent/.pi/agent` and `GIT_CEILING_DIRECTORIES=/agent`. One VM per agent: the thread, its children and thread tasks are workers in it.
- **Gateway** (`gateway.ts`): the daemon listens on `10.213.0.1:7841` and takes length-prefixed JSON frames (4 KiB until the hello is accepted, 4 MiB after; 10 s to say hello, 60 s for a cold boot). Hello checks the agent id, the launch, the token and the protocol. A pap-vmd or guest whose protocol differs is refused.
- **Mirror** (`mirror*.ts`): the daemon keeps a copy of each session file under `$PAP_HOME/agents/.mirrors/<agent id>/` (0700/0600), fed by `session_append` chunks (at most 2 MiB each) and checked line by line (shape, duplicate entry ids, 32 MiB a line, a quota within the agent's disk). Every reader (snapshot, history, the outside-write check) reads the mirror. Opening history never starts a VM. A user entry pap did not send is kept and shown "not sent from pap". A VM rewrite that is not an extension of the mirror keeps the old copy as `replaced/<name>.<stamp>` for 7 days, posts a notice and taints the session (ADR 0074's path).
- **Relay** (`pap-relay`, `packages/pi-host/src/relay/`): a daemon child process, the only holder of provider credentials, listening on `10.213.0.1:7842`. The VM's Pi talks to `http://llm.internal:7842/<provider>/...` and `http://claude.internal:7842/...`. Per request: fixed route table (POST, known paths and queries only), the launch's relay key (bound to the VM's address), the agent's models (the picker's list) and its state (not paused, not over budget); then it forwards over TLS with the credential Pi's auth storage resolves on the host. Every 60 s it reports requests, bytes and refusals per agent (attribution).
- **Network** (`agents-net.ts`, loaded by pap-vmd's unit): a VM reaches the gateway and relay ports on the bridge address and nothing else. The inet table answers those ports to `pap0` only and drops everything forwarded to or from `pap0`; the bridge table drops any frame from a VM port whose MAC, IPv4 or ARP sender is not its own, all IPv6, and VM to VM. `pap0` is `isGateway: false`: pap does not turn on IPv4 forwarding. The guest has no default route (`ENETUNREACH` for any address off the bridge), and the host firewall would drop a route added by guest root anyway.
- **The VM shell** (`packages/pi-host/src/vm-shell/`): pap's `bash` runs in bwrap as guest root with a seccomp filter (no new namespaces, mounts, `ptrace`, `bpf`, `io_uring`, keys; `clone3` answers `ENOSYS`; `socket` only for AF_UNIX, AF_INET, AF_INET6 and AF_NETLINK, `socketpair` only for AF_UNIX, any other family answers `EPERM`, and another architecture or an x32 call kills the process; the shell has no route, so the INET families reach nothing), every capability dropped but seven, the image root read-only, `/agent/.pi` hidden, one overlay-less shell per worker at a time. It is registered for every VM session whatever the host-sandbox switch says, and is judged like a sandboxed shell without network.
- **Pi's file tools** (`vm-files`): `read`, `write`, `edit` and `ls` open every path component without following a link (`O_NOFOLLOW`); a path Pi would rewrite (`~`, `@`, `file:`, a Unicode space) is refused. `grep` and `find` stay Pi's, and their root is judged by the same rule.
- **Images** (`kata-images.ts`, `image-policy.ts`): three layers built by pap-vmd (base from a pinned Node digest, profile, agent), tags `pap-agent-<layer>-<64 hex>`. The Dockerfile is rendered by pap-vmd; only apt names and pap tags are data. The base is rebuilt with `apt-get upgrade` and no cache once per ISO week (checked hourly, retry an hour after a failure); an agent whose image is being rebuilt keeps running on the old one and gets the notice "a new image is being prepared; this agent runs on the old one". A tag whose guest speaks another protocol is refused. After a successful build and on the weekly tick the daemon calls pap-vmd's `image.prune`, keeping the base, the newest profile, each agent's newest image, every image a VM runs on and, until they start again, the recorded images of agents not started since the boot (pap-vmd also skips any image a container uses); a failed prune is logged, never thrown into a launch. `vm.disk` does not count the image store (pap-vmd reports no size for it); `/var/lib/pap-vm` is where to look. The Pi profile is prepared (copy, secret scan, digest) in a worker thread, once per change: it is skipped when the names, sizes and mtimes of the agent folder's top-level files, the package folders and every copied root equal those of the last good preparation (a file modified in the last 2 seconds is not trusted). Measured on a synthetic profile of 23,210 files and 861 MB with 40 needles: about 5 s on the event loop before, 0 ms of loop time now, about 0.3 s when nothing changed.

## What a VM agent cannot do yet

- **No network in the shell.** An agent shell in a VM has no network in sub-project 1 (no `apt`, no `git clone`). Proxy and policy come in sub-project 2.
- **No vault, no one-use values**: the VM's `init` carries none, `secret.request` answers `unavailable`. The agent form says so.
- **No pi-mem0**, no prechecks (a trigger precheck is refused `sandbox_unavailable`), `agents.prompts` answers an empty list.
- **`export_html` is refused `sandbox_unavailable`** (it would write a host path from inside the VM).
- The owner's "always allow" grants made for host calls do not cross into a VM.
- Attachments reach `/agent/inbox/` in chunks, one file at a time. A name is sanitised, not refused (NFKD, marks dropped, other characters `_`, 128 characters keeping the extension), so the VM file can differ from the uploaded name; the prompt shows the VM path. A name that already exists is retried once with a `-<4 hex>` suffix and the whole file is sent again; any other failure is `prompt_rejected`.

## Providers and the Claude token

- The relay serves providers whose Pi `api` is `anthropic-messages`, `openai-completions`, `openai-responses` or `google-generative-ai`, with an API key. The credential comes from Pi's auth storage on the host (`auth.json`, `models.json`), read through `$VAR` and `!command` references like Pi does; answers are kept 60 seconds, so a `!command` key runs once per (provider, model) per 60 seconds and concurrent misses are not merged.
- **OAuth providers are refused** (no request is forwarded). T0b could not test one: the owner's `auth.json` held only an API-key provider, so the relay's header rule for an OAuth login is unverified. `cloudflare-ai-gateway` is unsupported (its key rides in headers behind placeholder base URLs). A model with duplicate top-level `model` keys in its JSON body names no model and is refused.
- **pi-claude-bridge** goes through `claude.internal`. The token is the owner's `claude setup-token`, set in Settings › Agents (`agents.vm.setClaudeToken`, `pi:admin`, step-up) and stored in `$PAP_HOME/secrets/claude-token` (0600 in a 0700 folder, read without following a link, at most 1 KiB). The daemon sends it to the relay child over IPC; the VM never holds it. T0b: `claude` 2.1.289 works through the relay (Bearer upstream, 200). `agents.vmStatus` reports `set` or `missing`, never the value. A bad token file is a fixed word in the log, never its content.
- A launch right after boot waits up to 30 seconds for the relay to report ready on `10.213.0.1:7842`, then is refused `sandbox_unavailable`. The daemon also checks that the sockets on `10.213.0.1:7841` and `:7842` are its own (`/proc/net/tcp` and `tcp6` against the process's fds); a foreign holder refuses the launch (`relay_listener_foreign`).

## Secrets in the profile

Before an image is built, pap scans the Pi profile files it would copy for the owner's known values: every string of 8 characters or more in `auth.json` (through Pi's auth storage), the vault's values, the Claude token and literal provider header values. A hit stops the build with "a Pi profile file holds a secret; it does not enter the image" and names the file, never the value. The same set masks the relay's stderr before it is logged. Limits (same as ADR 0049's redactor):

- values under 8 characters are never needles;
- encoded values (base64, split, reversed) are missed; the scan matches the literal and its JSON-escaped form;
- Pi references (`$VAR`, `!command`) are not needles: they hold no value;
- OAuth metadata in `auth.json` (an email, say) is a needle and can cause a refusal;
- more than 4096 needles, or an unreadable `auth.json`, refuses the build rather than skipping the scan.

Key handling in the profile (`!command` keys, `cloudflare-ai-gateway`, the 8-character minimum, encoded values) is described in "Providers and the Claude token" and in this section.

## Packages and resources

- `AgentInput` gains `resources` (`memoryMb` 512 and up, default 1024; `cpus`, default 1; `diskMb` 1024 to 65 536, default 4096), `systemPackages` (Debian names, 64 at most) and `packages` (the owner's Pi packages picked in the form, 64 at most). Memory and cores are checked against the host at save (`bad_request`, the field is logged as `agent_resources_refused`); the disk only grows.
- Packages are stored as plugin ids. Packages saved earlier as source strings read as input `null` (no data migration; the branch was unreleased): pick them again in the form.
- A 4 GiB agent disk takes about 330 MB on the host after its first boot (sparse file, lazy ext4 init). Cold start is about 6 s; a running VM costs about 200 MB of host memory beside its own. Details: `docs/research/agents-vm-risk-checks.md`.

## Delete, trash, purge

Delete moves the agent's disk to pap-vmd's trash and its mirrors to `$PAP_HOME/agents/.trash/<id>-<stamp>.mirrors`, both kept 7 days. "Purge now" (`agents.purgeTrash`, `agents:admin`) removes the disk and mirrors at once but leaves the trashed home and `.runs` folder for their 7 days (the sweep removes them at boot and daily).

## Setup

`sudo pap vm setup --user <name>` and `sudo pap vm uninstall [--purge]`: `install.md`, "Agent VMs". Needs `/dev/kvm` and x86_64 (the pinned artefacts are amd64). pap-vmd runs from `/opt/pap-vm`, installed from pinned artefacts; `pap update` does not update it, so after an update `pap doctor` says `vm.vmd` fails until you run `sudo pap vm setup` again. `agents.vmStatus` and the Settings › Agents page show the same sentence, and a launch is refused `sandbox_unavailable` while the stack is unusable. The doctor checks are in `doctor.md`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Launch refused `sandbox_unavailable` | `pap doctor --only vm.vmd,vm.stack,vm.network,vm.kvm`; the sentence is the one in Settings › Agents. |
| The daemon will not boot in `vm` mode | pap-vmd or `pap0` is missing: `sudo pap vm setup`, then `journalctl --user -u pap` (`agent_vm_bridge_unavailable`). |
| VMs time out reaching the gateway | `vm.firewall`: ufw or firewalld drops 7841 and 7842 on `pap0`; the fix lists the allow rule. |
| `relay_listener_foreign` | Another process holds `10.213.0.1:7842` (or `:7841`): `ss -ltnp 'sport = :7842'`, stop it. |
| "A new image is being prepared" | A base or profile rebuild runs; the agent keeps its old image. A failed weekly upgrade retries after an hour. |
| Disk pressure | `vm.disk`; trash and kept mirrors count; `pap vm uninstall --purge` removes every disk. |

## Tests

- `pnpm test:unit` and `pnpm test:int` run without KVM: pap-vmd with a fake `exec` and temp folders, and the `process` backend (`PAP_TEST_AGENT_RUNTIME=process` with the scripted provider).
- The Kata path is tested locally only; there is no CI job (it is a backlog item). On a KVM host where `sudo pap vm setup --user <you>` is done and you can use `/dev/kvm`: `CI=1 pnpm vitest run --project kata`. The project runs one file at a time (they share `pap0`, ports 7841/7842 and pap-vmd). Without `CI=1` a missing `/dev/kvm` or `/run/pap-vm/vmd.sock` skips the files with one warning; under `CI=1` it fails the run, so the command above needs the stack.
- A security file names its mutants in the test (a comment per mutant and the case that kills it).
- The forward chain of the host ruleset is proven by `agents-net.test.ts` only. The Kata routed-leg test times out at the input chain on a host with `net.ipv4.ip_forward=0`, so a forward-chain bug on a forwarding host (Docker sets it) would go unseen until an end-to-end test exists (backlog, with the Kata CI job).

## Known limits

- **The boundary is KVM's.** A guest kernel or Cloud Hypervisor escape is the residual. x86_64 only.
- **No network** in the VM shell until sub-project 2.
- **OAuth providers** are refused (R9); the relay's header rule for one is unverified (T0b, above).
- **pap-vmd lags `pap update`** until `sudo pap vm setup` (R6): `vm.vmd` fails and launches are refused meanwhile.
- **`sudo pap vm setup` runs pap's own program as root** (RT-22). Without `--dev-from-tree` setup refuses unless its entry file and folder, its `vm-assets.json` and the running Node are owned by root and not writable by group or others, so a compromise of pap's user cannot plant code that the next routine setup runs as root: run it from a release archive unpacked as root. `--dev-from-tree` copies user-writable code that then runs as root (R19) and is exactly the case where such a compromise becomes root at the next setup; it prints the warning and is for testing only. The pins (`vm-assets.json`, `--assets`) are checked by SHA-256 either way.
- **The existence oracle by a race.** `grep`, `find` and `ls` roots are judged before the walk (R26): the agent's shell can flip `home/a` between a folder and a link to `/` while a read is judged, which reveals whether a path exists, never its content; the ops open component by component with `O_NOFOLLOW`. Inside a VM "the outside" is the VM's own root (pi-host, the agent's other workers). An fd-relative judge is sub-project 3.
- **MCP stdio servers and extension subprocesses** start outside bwrap and the file rule; only `GIT_CEILING_DIRECTORIES=/agent` is set (sub-project 3).
- **Search does not index mirrors**; a VM agent's conversations are not found by search.
- **`export_html`, vault, one-use values, pi-mem0, prechecks** are unavailable for VM agents.
- **`pap backup` holds mirrors, not disks** (disks are in root-owned `/var/lib/pap-vm`; backups are sub-project 4). A backup of `$PAP_HOME` is still sensitive.
- **The worker reports its own taint.** Once a VM is compromised that report is untrusted; decisions at the box's exits must not rely on "not tainted" from a VM (sub-project 3). A reopened VM thread session is tainted (the mirror resync), so its tools ask once.
- **Provider-side tools are an egress and spend path.** The relay forwards request bodies and `anthropic-beta` verbatim, so a tool the provider runs (Anthropic `mcp_servers` and web fetch, OpenAI Responses `web_search` and `mcp`) lets code in the worker reach hosts through the provider and spend on it.
- **The pause and budget gate rests on the cost the VM worker reports.** The relay counts requests for attribution only (a mismatch is logged, not acted on); a compromised worker can under-report its cost.
- **A notice posted "now" is live-only.** A mirror notice that no start follows is shown to whoever watches the session at that moment and are not kept for a later start.
- **A plain restore drops every VM agent's package picks.** The plugin-id key lives in `secrets/plugin-id.key`, which a plain backup excludes (`backup.md`); the ids change and `sourcesOf` drops each pick with a log line (`agent_plugin_pick_gone`) and no notice, so agents start without their packages, the Claude bridge included. Pick them again in the form.
- **The relay-restart window.** The listener check runs at relay ready and after each restart. A local user who binds `10.213.0.1:7841` or `:7842` during a restart window while VMs run receives their provider requests (the firewall filters by interface, not by socket owner). It never gets a credential: VMs hold only a relay key, which is worth nothing off the relay.
- **`vm.listeners` warns briefly at boot** before the relay binds (run doctor again). While another daemon holds `~/.pap`'s lock and only your shell sets `PAP_AGENTS_RUNTIME=vm` (no unit does), it is `info`.
- **Purge leaves the trashed home and `.runs`** for 7 days.
- **The forward chain** has no end-to-end test (above).
