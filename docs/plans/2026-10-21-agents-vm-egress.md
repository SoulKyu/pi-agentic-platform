# Agents in microVMs, sub-project 2 (network and agent files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VM agent reaches the hosts of its list through pap's egress proxy, a refused host becomes a card with a one-click add, and the owner imports files (credentials) into the agent's home from a Files tab.

**Architecture:** pap's M11 egress proxy gains a TCP listener on `10.213.0.1:7843` that identifies the agent by its VM address and judges host and port against `allowHosts` with a VM address policy. The guest exports the proxy to workers and, when `sandbox.network` is on, to the bwrap shell. Agent files are kept 0600 under `$PAP_HOME/secrets/agent-files/` and written into `/agent/home` by the worker at every VM start and live.

**Tech Stack:** TypeScript (erasable syntax only), Node 24, zod, vitest, React (apps/web), nftables ruleset from contracts.

**Spec:** `docs/specs/2026-10-21-agents-vm-egress-design.md` (decision 119). Code map: sub-project 1 docs `docs/agents/agents-vm.md`.

## Global Constraints

- No new dependency. Reuse `apps/daemon/src/modules/egress/` (judge, relay-http, report) instead of a second proxy implementation; no duplicated logic block.
- 400 lines per file at most; a daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`; RPC handlers decode, call one service method, map typed errors; every RPC method declares a permission in `packages/contracts/src/methods.ts`.
- Tests never touch `~/.pi/agent` or `~/.pap`, never name a public host or address; timers through the kernel `Clock`; no sleeps. Only `modules/egress/testing/` reaches `127.0.0.1` on the daemon side.
- Values: proxy port `7843`; no-port entry = ports 80 and 443; file max `1_048_576` bytes; max `32` files per agent; file mode `0600`, folders `0700`; dedupe window 1 hour per agent and `host:port`; usage report every 60 s.
- Always refused addresses: loopback, link-local (incl. `169.254.169.254`), multicast, unspecified, `AGENT_NET.subnet`, every address of the host. Private ranges allowed only for an exact entry or an IP entry: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`. Everything else `blockedStrict` refuses stays refused.
- UI follows `DESIGN.md`: tokens only, primitives with `variant`/`size`, mono uppercase button labels, EN and FR strings through the i18n layer, errors say what happened / what is intact / what to do. A file's content is never displayed.
- Host mode is unchanged, except that it refuses `allowHosts` entries with a port or an IP ("needs VM mode").
- Conventional Commits, no AI attribution trailers.

## Review Focus

1. A kubeconfig that names the API server by IP and port (`https://192.168.1.40:6443`): the entry `192.168.1.40:6443` lets CONNECT through, `192.168.1.40` alone does not open 6443 (A2 test `ip entry with port`).
2. A listed name that resolves to the host itself or to `pap0` (DNS rebinding toward pap's own UI on the LAN): refused `blocked_address` even for an exact entry (A2 tests `host address` and `pap0 subnet`).
3. Refusal storm (a tool retrying a refused host 200 times in a minute): one card, one Inbox item, one push, count 200 (A4 test `dedupe`).
4. A file path whose parent in the VM home is a symlink the agent planted (`.kube -> /etc`): the write fails and nothing lands outside `/agent/home` (B2 test `symlinked parent`).
5. Owner removes a credential while the agent's VM is stopped: the file is gone from the VM home after the next start (B2 test `removal while stopped`).

---

## Part A — network (merge and preview on its own)

### Task A1: Host entries and the proxy port in contracts

**Files:**
- Modify: `packages/contracts/src/policy.ts` (beside `HostPattern`, L89)
- Modify: `packages/contracts/src/agents.ts` (`allowHosts` L90, `covers` ~L135, `widensReach` L146)
- Modify: `packages/contracts/src/agents-vm.ts` (`AGENT_NET`, L6-14), `packages/contracts/src/agents-net.ts` (ports in `agentNetRuleset`, L31-32), `scripts/ci/netns-spoof.nft` (L6-7)
- Modify: the agents service input check in `apps/daemon/src/modules/agents/` (where create/update validate beyond zod) and the form hint strings (`agentForm.hosts.hint`, EN and FR)
- Test: `packages/contracts/src/policy.test.ts`, `packages/contracts/src/agents.test.ts`, the agents-net test, `apps/daemon/src/cli/vm/setup.test.ts` (existing equality must still pass), the agents service test

**Interfaces:**
- Produces: `AgentHostEntry` (zod string), `parseHostEntry(entry: string): HostEntry`, `entryAllows(entry: HostEntry, host: string, port: number): boolean`, `type HostEntry = { host: string; ip: boolean; wildcard: boolean; ports: readonly number[] }` (ports `[80, 443]` when the entry has none), `AGENT_NET.proxyPort = 7843`.

- [ ] **Step 1: failing tests.** `AgentHostEntry` accepts `k8s.lan:6443`, `192.168.1.40`, `192.168.1.40:6443`, `[fd00::1]:6443`, `*.example.com`, `api.example.com`; refuses `k8s.lan:0`, `k8s.lan:65536`, `:443`, `*.192.168.1.40`, `fd00::1:6443` (IPv6 with a port needs brackets). `parseHostEntry("k8s.lan").ports` equals `[80, 443]`. `widensReach`: `["a.example.com"]` → `["a.example.com:6443"]` widens; `["a.example.com:6443"]` → `["a.example.com"]` widens; `["*.example.com"]` → `["a.example.com"]` does not. `agentNetRuleset()` contains `7843`. Agents service: in host mode an entry with a port or an IP is refused with the field error on `allowHosts` and a message containing "VM mode"; in VM mode it is stored.
- [ ] **Step 2:** run `pnpm vitest run packages/contracts/src/policy.test.ts packages/contracts/src/agents.test.ts` → FAIL.
- [ ] **Step 3:** implement. `AgentInput.allowHosts` switches to `AgentHostEntry`; the owner's list (Settings › Approvals), trusted sources and grants keep `HostPattern`. `covers` uses `parseHostEntry` (an entry covers another when its host covers the host and its ports include the other's). Host mode's `allow.ts` keeps matching names only.
- [ ] **Step 4:** run the tests above plus `pnpm vitest run apps/daemon/src/cli/vm/setup.test.ts apps/vmd/src/net.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(agents-vm): host entries with ports and IPs, proxy port 7843`.

### Task A2: The VM egress listener (security-critical)

**Files:**
- Create: `apps/daemon/src/modules/egress/vm-judge.ts`, `apps/daemon/src/modules/egress/vm-listener.ts`, `apps/daemon/src/modules/agent-vm/launch-addresses.ts`
- Modify: `apps/daemon/src/modules/egress/proxy.ts` (extract the CONNECT / plain-HTTP handling that `vm-listener.ts` reuses), `apps/daemon/src/modules/egress/index.ts` (export), `apps/daemon/src/modules/agent-vm/runtime.ts` (feed `launch-addresses` next to `deps.onLaunch` ~L196 and next to the relay revoke), the composition (`compose-agents-vm.ts`: listen on `AGENT_NET.host:proxyPort`, or `127.0.0.1:0` in the loopback mode the relay uses), `apps/daemon/src/modules/agent-vm/listener-owner.ts` (`PROXY_ENDPOINT` beside L144-145) and the doctor `vm.listeners` check
- Test: `vm-judge.test.ts`, `vm-listener.int.test.ts` (loopback listeners through `modules/egress/testing/`)

**Interfaces:**
- Consumes: `parseHostEntry`, `entryAllows`, `AGENT_NET.proxyPort` (A1); `blockedStrict` (`kernel/net/address-strict.ts:54`).
- Produces:
  - `type VmScope = { agentId: string; launchId: string; source: "thread" | { task: string }; hosts: readonly string[] }`
  - `type VmRefusal = { agentId: string; launchId: string; source: VmScope["source"]; host: string; port: number; reason: "not_listed" | "private_wildcard" | "blocked_address"; address: string | null }`
  - `vmAddressRefused(ip: string, exact: boolean, hostAddresses: readonly string[]): "blocked_address" | "private_wildcard" | null`
  - `createVmEgress(deps: { clock; logger; resolve; connect; addressRefused: typeof vmAddressRefused; hostAddresses(): readonly string[]; scopeOf(address: string): VmScope | null; onRefusal(r: VmRefusal): void }): { listen(host: string, port: number): Promise<number>; close(): Promise<void> }`
  - `createLaunchAddresses(): { add(address: string, scope: Omit<VmScope, "hosts">): void; remove(launchId: string): void; scopeOf(address: string): Omit<VmScope, "hosts"> | null }` (the composition adds the agent's current `allowHosts`, or the owner's list when `null`, at each lookup so an add takes effect at the next request)

- [ ] **Step 1: failing tests (`vm-judge.test.ts`).** With a stub resolver:
  - `api.example.com` listed → CONNECT 443 ok, 8080 `not_listed`;
  - `k8s.lan:6443` → 6443 ok, 443 `not_listed`;
  - `ip entry with port`: `192.168.1.40:6443` → CONNECT `192.168.1.40:6443` ok without DNS, `192.168.1.40` alone does not allow 6443;
  - `*.lan` resolving to `192.168.1.5` → `private_wildcard`; exact `nas.lan` → same address ok;
  - an exact entry resolving to `127.0.0.1`, `::ffff:127.0.0.1` or `169.254.169.254` → `blocked_address`;
  - `pap0 subnet`: an exact entry resolving to `10.213.0.1` → `blocked_address`;
  - `host address`: `hostAddresses` `["192.168.1.182"]` and an exact entry resolving there → `blocked_address`;
  - `100.64.0.1` → `blocked_address` (not in the private list).
- [ ] **Step 2: failing tests (`vm-listener.int.test.ts`).**
  - An allowed CONNECT tunnels bytes both ways to a loopback listener, and `connect` receives only the checked IP (DNS pinning).
  - A refused one gets `403` with a one-line body naming the host, port and reason; `onRefusal` is called once; nothing reaches the target listener.
  - An address `scopeOf` does not know gets `403` without `onRefusal`.
  - A plain-HTTP GET is forwarded.
  - Usage per agent (requests, refused, bytes up and down) is logged every 60 s with the steppable clock, hosts labelled by the W5-R54 rule.
- [ ] **Step 3:** run `pnpm vitest run apps/daemon/src/modules/egress/vm-judge.test.ts` and `pnpm vitest run --project int apps/daemon/src/modules/egress/vm-listener.int.test.ts` → FAIL.
- [ ] **Step 4:** implement. The production `hostAddresses` reads `os.networkInterfaces()` at each decision. Only the composition passes `vmAddressRefused`; tests pass a seam from `modules/egress/testing/`.
- [ ] **Step 5:** run the tests, plus `pnpm vitest related` on the touched files → PASS.
- [ ] **Step 6:** commit `feat(agents-vm): egress proxy listener for VMs`.

### Task A3: Proxy in the guest, network for the shell, no network card in the VM

**Files:**
- Modify: `packages/pi-host/src/guest/guest.ts` (`startWorker` env, L171-176), `packages/pi-host/src/guest/main.ts` (read `PAP_GUEST_PROXY`), and the daemon's VM spec that sets the guest env (beside `PAP_GUEST_LAYOUT`): `PAP_GUEST_PROXY=http://10.213.0.1:7843` (loopback URL in process mode)
- Modify: `packages/pi-host/src/vm-shell/argv.ts` (`VmShellSpec.egressSocket` L33 → `network: boolean`; `--unshare-net` L53), `packages/pi-host/src/vm-shell/ops.ts` (`vmShell` env, L27), `packages/pi-host/src/vm-shell/tool.ts` (L24: `network` from `rules.sandbox?.network === true`)
- Modify: `packages/pi-host/src/policy/agent-stage.ts` (`judgedAs` L47-52)
- Test: `guest.test.ts`, `vm-shell/argv.test.ts` (replace the refusal pinned at L160), `vm-shell/ops.test.ts`, `policy/agent-stage.test.ts`

**Interfaces:**
- Consumes: `AGENT_NET` (A1).
- Produces: `VmShellSpec.network: boolean`; the worker env keys `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `NODE_USE_ENV_PROXY=1`.

- [ ] **Step 1: failing tests.**
  - Worker env: it holds the proxy URL, and `NO_PROXY` includes `llm.internal`, `claude.internal`, `10.213.0.1`, `localhost` and `127.0.0.1`. Without `PAP_GUEST_PROXY` none of these keys exist.
  - Argv: `network: false` keeps `--unshare-net`; `network: true` drops it and keeps every other namespace and seccomp flag.
  - `vmShell` env: it adds the proxy keys only when `network` is on; it still holds no `PAP_*` key.
  - `agent-stage`: with `deps.vm` set, a tainted session and `sandbox.network: true`, `bash` is judged like an edit of the agent's own folder (no ask in `auto-accept-edits`). Without `deps.vm`, the same call keeps today's judgement.
- [ ] **Step 2:** run `pnpm vitest run packages/pi-host/src/vm-shell packages/pi-host/src/guest packages/pi-host/src/policy/agent-stage.test.ts` → FAIL.
- [ ] **Step 3:** implement as listed. Remove the "Always null in sub-project 1" comment.
- [ ] **Step 4:** run the same command → PASS.
- [ ] **Step 5:** commit `feat(agents-vm): proxy env in the guest and network for the VM shell`.

### Task A4: Refused host card, Inbox, push and the add dialog

**Files:**
- Modify: `packages/contracts/src/agents.ts` (`AgentEventView` union L318, `AgentEventKind`, `AGENT_EVENT_DATA`: kind `egress_refused`), the inbox kind list (`agent_egress`) and `apps/daemon/src/modules/push/delivery/source-inbox.ts` (`agent_egress: "notify"`)
- Create: `apps/daemon/src/modules/agent-vm/egress-refusals.ts`
- Modify: `apps/daemon/src/modules/agents/events.ts` (add `update(ownerId, eventId, data)` validated by `AGENT_EVENT_DATA`, if no such writer exists), and the composition (wire `onRefusal` from A2)
- Create: `apps/web/src/features/agents/EgressRefusalDialog.tsx`; Modify: `apps/web/src/features/agents/EventCard.tsx` and an i18n catalog under `apps/web/src/i18n/catalog/` (EN and FR)
- Test: `egress-refusals.test.ts`, `EgressRefusalDialog.test.tsx`, `EventCard.test.tsx`

**Interfaces:**
- Consumes: `VmRefusal` (A2), `AgentHostEntry` (A1), `needsStepUp` (`apps/web/src/features/agents/agent-form.vm.ts:192`), `useOwnerHosts`, `upsertAgentItem` (`modules/inbox/agent-items.ts:60`).
- Produces:
  - event data `{ host: string; port: number; reason: VmRefusal["reason"]; address: string | null; source: "thread" | string; count: number; firstAt: number; lastAt: number }`;
  - `createRefusalSink(deps): (r: VmRefusal) => void`;
  - `entryFor(host: string, port: number): string`, where port 80 or 443 gives the bare host and IPv6 gets `[ip]:port`.

- [ ] **Step 1: failing tests.**
  - `dedupe`: 200 refusals of the same agent and `host:port` within 10 minutes give 1 card, 1 Inbox item and a final card count of 200. A refusal 61 minutes after the first gives a new card. A second host gives its own card.
  - Card: `not_listed` and `private_wildcard` show "Add…"; `blocked_address` shows no button and says the address is always refused.
  - Dialog:
    - with a `private` address it shows the address and the "comes from the agent" warning;
    - ADD on an agent whose `allowHosts` is `null` calls `agents.update` with `[...ownerHosts, "prometheus.lan:9090"]` through the step-up path;
    - on an agent with its own list it appends `entryFor(host, port)`;
    - CLOSE writes nothing.
- [ ] **Step 2:** run `pnpm vitest run apps/daemon/src/modules/agent-vm/egress-refusals.test.ts apps/web/src/features/agents/EgressRefusalDialog.test.tsx apps/web/src/features/agents/EventCard.test.tsx` → FAIL.
- [ ] **Step 3:** implement. The dedupe state is in memory and keyed `agentId|host:port`; a daemon restart may notify once more. Copy, EN: "@{name} could not reach {host}:{port}: it is not in its host list. Nothing left the VM." Dialog per spec §6 and DESIGN.md (Dialog, `CLOSE` secondary, `ADD TO LIST` primary).
- [ ] **Step 4:** run the same command → PASS.
- [ ] **Step 5:** commit `feat(agents-vm): refused host card with a one-click add`.

### Task A5: Kata check, docs and ADR for Part A

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/egress.kata.int.test.ts`, `docs/adr/0079-agents-vm-egress-and-files.md`
- Modify: `docs/agents/agents-vm.md` ("What a VM agent cannot do yet", new "Network"), `docs/agents/agents.md` (VM pointer, L7), `AGENTS.md` ("Agents in microVMs": the shell has network through the proxy)

- [ ] **Step 1:** write the Kata test (no public host). From the shell of a VM agent with `sandbox.network: true` and `allowHosts: ["listed.invalid", "127.0.0.1:7841"]`:
  - `curl` to an unlisted host gets `403` with `not_listed`;
  - `listed.invalid` passes the list and fails on DNS with a non-403 error;
  - `127.0.0.1:7841` gets `403 blocked_address`;
  - `env` in the shell shows no `PAP_*` key;
  - the shell cannot read the parked gateway token.
- [ ] **Step 2:** run `CI=1 pnpm vitest run --project kata apps/daemon/src/modules/agent-vm/egress.kata.int.test.ts` on this KVM host after `sudo pap vm setup` with the new ruleset (owner OK for the root step) → PASS.
- [ ] **Step 3:** docs and ADR 0079 (amends decision 106: own credentials in the VM, no injection, simple proxy). Commit `docs(agents-vm): VM network, ADR 0079`.

**Part A gate:** `pnpm lint && pnpm typecheck && pnpm knip && pnpm test:unit`, the clean-env `test:int`, the kata project; then the Opus review of Part A, the merge on the owner's OK, the preview rebuild and `sudo pap vm setup` again.

---

## Part B — agent files

### Task B1: File store, methods and the import route

**Files:**
- Create: `packages/contracts/src/agents-files.ts`, `apps/daemon/src/modules/agent-vm/agent-files.ts`, `apps/daemon/src/modules/agent-vm/agent-files-http.ts`
- Modify: `packages/contracts/src/agents-vm-methods.ts` (methods), `packages/contracts/src/methods.ts`, `apps/daemon/src/modules/agent-vm/rpc.ts`, `packages/contracts/src/agents-safety.ts` (`QUARANTINE_STEPS` gains `files`, whose report lists the paths), `apps/daemon/src/modules/agents/vm-steps.ts` (delete: the agent's files go with its trash)
- Optional refactor: move the 0700-folder and 0600 no-follow write from `claude-token.ts` (~L135-165) into a shared kernel helper, if B1 needs the same code
- Test: `agents-files.test.ts` (contracts), `agent-files.test.ts`, `agent-files-http.int.test.ts`, the quarantine test, `cli/backup` manifest test

**Interfaces:**
- Produces:
  - `AGENT_FILE_LIMITS = { maxBytes: 1_048_576, maxFiles: 32 }`;
  - `AgentFilePath` (zod): relative to `/agent/home`, 1 to 8 segments, each `/^[A-Za-z0-9._-]{1,128}$/` and neither `.` nor `..`, no leading `/`, no empty segment, at most 512 characters;
  - `AgentFileView = { path: string; size: number; importedAt: number }`;
  - RPC `agents.files.list {agentId} → {files: AgentFileView[]}` and `agents.files.remove {agentId, path}`, both `agents:admin`, never a token;
  - HTTP `PUT /agent-files?agentId=…&path=…`, raw body of at most `maxBytes`, the same auth and CSRF as `POST /upload` (`modules/files/attachments-http.ts:32`), browser only;
  - store `createAgentFiles(deps): { list(agentId); put(agentId, path, bytes); remove(agentId, path); read(agentId): Promise<{path: string; bytes: Buffer}[]>; pendingRemovals(agentId): string[]; delivered(agentId, removed: string[]): void; onChange(listener: (agentId: string) => void) }`, under `$PAP_HOME/secrets/agent-files/<agentId>/`.
- [ ] **Step 1: failing tests.**
  - The path schema accepts `.kube/config` and `.config/gmail/token.json`. It refuses `../x`, `/etc/passwd`, `a//b`, `.`, `a/./b` and 9 segments.
  - The store:
    - refuses a 33rd file and a file of `1_048_577` bytes, with typed errors;
    - a put on an existing path replaces it and the count stays the same;
    - a remove adds the path to `pendingRemovals`;
    - files are `0600` in a `0700` folder;
    - a symlink planted as the agent's folder is refused.
  - Backup: a plain backup's manifest excludes `secrets/agent-files`.
  - Quarantine: the `files` step reports the paths.
- [ ] **Step 2:** run the tests above → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat(agents-vm): agent file store and import route`.

### Task B2: Delivery into the VM home (security-critical)

**Files:**
- Modify: `packages/contracts/src/agents-vm.ts` (records beside `FilePut` L177-189)
- Create: `packages/pi-host/src/home-files.ts`; Modify: `packages/pi-host/src/dispatch.ts` (L59-60, L202)
- Create: `apps/daemon/src/modules/agent-vm/deliver-files.ts`; Modify: `apps/daemon/src/modules/agent-vm/runtime.ts` (after `link.spawnWorker` ~L240, for thread and task VMs alike) and the composition (live apply on `onChange` when the agent's thread VM has a live worker)
- Test: `home-files.test.ts`, `deliver-files.test.ts`, `agent-files-delivery.int.test.ts` (process backend)

**Interfaces:**
- Consumes: `createAgentFiles` (B1); the chunk size `FILE_CHUNK_BYTES` and the wait-for-result pattern of `putAttachments` (`modules/sessions/vm-attachments.ts`).
- Produces:
  - records `HomePut = { type: "home_put"; id: string; path: string; offset: number; data: string; last: boolean }`, `HomeRemove = { type: "home_remove"; id: string; path: string }` and `HomeResult = { type: "home_result"; id: string; ok: boolean; code?: "too_large" | "order" | "write_failed" }`;
  - `createHomeFiles(homeDir: string): { put(chunk: HomePut): Promise<HomeResult>; remove(r: HomeRemove): Promise<HomeResult> }`;
  - `deliverAgentFiles(handle, files, removals): Promise<void>`.
- [ ] **Step 1: failing tests.**
  - The worker:
    - `put` creates the parent folders (0700) and the file at 0600;
    - a second `put` on the same path replaces it (temp file, then rename);
    - `symlinked parent`: with `.kube` a symlink to an outside folder, `put` returns `write_failed` and nothing is written there;
    - `remove` of a missing path is `ok`.
  - Delivery (process backend):
    - an imported file is present in the agent's home after a start;
    - a task VM gets it too;
    - removal while running deletes it at once;
    - `removal while stopped` deletes it after the next start, and `pendingRemovals` is then empty.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement with `./nofollow.ts` (`openAt`, `linkAt`, `unlinkAt`): each parent is opened with `O_NOFOLLOW | O_DIRECTORY`.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat(agents-vm): deliver agent files into the VM home`.

### Task B3: Files tab

**Files:**
- Create: `apps/web/src/features/agents/AgentFiles.tsx`, `apps/web/src/i18n/catalog/agent-files.ts` (EN and FR, registered like the other catalogs)
- Modify: `apps/web/src/features/agents/AgentScreen.tsx` (tab union L137: `"thread" | "files" | "settings"`; the tab is shown only in VM mode, read from the existing VM status hook)
- Test: `AgentFiles.test.tsx`, `AgentScreen.test.tsx`

- [ ] **Step 1: failing tests.**
  - Rows show the path in mono, the size in tabular figures and the date.
  - IMPORT sends `PUT /agent-files` with the typed path.
  - A file over 1 MiB is refused before upload, with a message.
  - REPLACE re-imports to the same path.
  - REMOVE (danger) asks for confirmation, then calls `agents.files.remove`.
  - No file shows an EmptyState with one primary action.
  - Host mode shows no Files tab.
- [ ] **Step 2:** run `pnpm vitest run apps/web/src/features/agents/AgentFiles.test.tsx apps/web/src/features/agents/AgentScreen.test.tsx` → FAIL.
- [ ] **Step 3:** implement per spec §7 and DESIGN.md.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat(web): agent Files tab`.

### Task B4: Kata check and docs for Part B

- [ ] **Step 1:** extend `egress.kata.int.test.ts`: import `.kube/config`, restart the VM, then check from the shell that the file exists with mode `0600`; remove it and restart, then check it is gone.
- [ ] **Step 2:** run the kata project → PASS.
- [ ] **Step 3:** update `docs/agents/agents-vm.md` (new "Files" section; quarantine and backup notes) and `docs/agents/backup.md`. Commit `docs(agents-vm): agent files`.

**Part B gate:** the same as Part A's, then the Opus review, the merge on the owner's OK and the preview rebuild.
