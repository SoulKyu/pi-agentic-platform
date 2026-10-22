# Agents in microVMs, sub-project 3 (the VM as the only agent runtime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agents always run in their microVM; the daemon decides at the box's exits from what it sees; the host-sandbox code for agents is gone; the vault works in the VM; a stale VM bundle is named instead of failing silently.

**Architecture:** two lanes in parallel worktrees. Lane A (deletion spine, then the vault and the web) owns contracts, pi-host's host sandbox, and the daemon's host paths. Lane B (new behaviour) owns the proxy-seen taint, the bundle digest and doctor, and the prompt chips. A join task merges B into A, writes the docs and ADR 0081, runs the final review and the Kata root window.

**Tech Stack:** TypeScript (erasable syntax), Node 24, zod, vitest, React (web), Kata 4.2 + Cloud Hypervisor (unchanged).

**Spec:** `docs/specs/2026-10-22-agents-vm-only-design.md`. Recon maps (file paths, line numbers; read the part your task names): `.superpowers/sdd/agents-vm-only/recon-delete.md`, `.superpowers/sdd/agents-vm-only/recon-new.md`.

## Global Constraints

- AGENTS.md rules (CI-enforced): 400 lines per file at most, tests included; a daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`; every RPC method declares a permission; RPC handlers decode, call one service method, map typed errors; UI uses `packages/ui/src/tokens.css` tokens only; only `eslint-disable-next-line <rule> -- <reason>`; erasable TypeScript only, relative imports keep `.ts`; timers through the kernel `Clock`, no sleeps; tests never touch `~/.pi/agent`, `~/.pap`, `~/.claude`; tests never name a public host or address.
- Files already at the limit: `apps/daemon/src/daemon.ts` (399), `compose-agents-vm.ts` (397), `modules/sessions/live-session.ts` (393), `cli/vm/setup.ts` (360), `modules/agents/service.ts` (391), `contracts/src/agents.ts` (383), `kernel/config.ts` (362). New code goes in new files; an edit to these is net-negative or one line.
- No new dependency. No change to third-party packages, to pi-web, or to `cli/vm/setup.ts`.
- Copy: English and French, DESIGN.md (tokens, listed primitives, mono uppercase button labels, error pattern "what happened, what is intact, what you can do").
- Exact copy (EN): EmptyState and `error.sandbox_unavailable`: "Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`." (+ "See `pap doctor`." in the EmptyState purpose). `error.vm_bundle_stale`: "The code inside this agent's VM is older than pap. Run `sudo pap vm setup`, then open the thread again. Nothing was lost." Precheck note: "Prechecks do not run for agents: clear this field." Boot warning: "PAP_AGENTS_RUNTIME is gone: agents always run in microVMs".
- Exact copy (FR): "Les agents tournent dans des microVM : cette machine a besoin de KVM et de `sudo pap vm setup`." / "Voir `pap doctor`." / "Le code dans la VM de cet agent est plus ancien que pap. Lancez `sudo pap vm setup`, puis rouvrez le fil. Rien n'est perdu." / "Les pré-checks ne tournent pas pour les agents : videz ce champ."
- Gate per task (owner rule 2026-10-21, never the full suites, never the `kata` project): `pnpm exec eslint --ignore-pattern ".superpowers/**" <changed files>`, `pnpm format:check`, `pnpm typecheck`, `pnpm knip`, then `pnpm exec vitest related --run --project unit --project integration $(git diff --name-only BASE -- "*.ts" "*.tsx")`. A test that fails only under load and passes alone is reported as a flake, not fixed in the task. Use the heavy-gate lock: `flock .superpowers/heavy-gate.lock` (lane A) / `.superpowers/heavy-gate-2.lock` (lane B).
- Commits: Conventional Commits, no AI attribution, no `Co-Authored-By`.

## Review Focus

1. A test daemon (or a real host) with no KVM and no pap-vmd boots, serves sessions, lanes and plain triggers, and answers agent calls with `sandbox_unavailable`; no boot throw is left behind (A1 test `boots without a VM stack`).
2. An agent trigger with a stored precheck is refused at fire time with `precheck_agent`, never run without it (A2a test `refuses a stored precheck on an agent trigger`).
3. Many tunnels from one VM taint each of its sessions once (one audit row, one `session_tainted_outside` log each), and a session started later in the same launch starts tainted (B1 tests).
4. The bundle digest is taken once per daemon process: rebuilding the tree while pap runs does not flip the verdict (B2 test `keeps the boot digest`).
5. A vault value delivered live to a running VM worker (the owner adds it mid-thread) reaches the next shell command and is redacted (A4 test `delivers a live vault update`).

---

## Lane A

### Task A1: the switch

**Files:**
- Modify: `apps/daemon/src/kernel/config-agents-vm.ts`, `apps/daemon/src/kernel/config.ts` (net-negative), `apps/daemon/src/compose-agents-vm.ts` (net-negative), `apps/daemon/src/compose-agents-vm-kata.ts`, `apps/daemon/src/compose-m11-vm.ts`, `apps/daemon/src/modules/agent-vm/status.ts`, `apps/daemon/src/modules/agents/service.ts` (one line) or a new `modules/agents/create-gate.ts`, `packages/contracts/src/agents-methods.ts` (`agents.create` errors), `apps/daemon/src/testing/harness.ts`
- Create: `apps/daemon/src/compose-agents-runtime-warn.ts` (the boot warning)
- Test: `apps/daemon/src/kernel/config-agents-vm.test.ts`, `apps/daemon/src/modules/agent-vm/status.test.ts`, new `apps/daemon/src/compose-agents-vm.unavailable.int.test.ts`

**Interfaces:**
- Produces: `AgentsVmConfig.agentsRuntimeSet: boolean` (true when `PAP_AGENTS_RUNTIME` is set, any value); `agentsRuntime` stays as an internal, test-only field defaulting to `"vm"` that only `testing/harness.ts` sets to `"host"` for the host tests A2a/A2b delete (`// ponytail: removed in A2b`). `STACK_REASONS` gains `"kvm_missing"`; `assessStack(client, version, kvm: () => boolean)`. `agents.create` may answer `sandbox_unavailable`.

- [ ] **Step 1: Write the failing tests**
  - `config-agents-vm.test.ts`: `it("reads no runtime from PAP_AGENTS_RUNTIME and flags that it is set")`: `parse({PAP_AGENTS_RUNTIME: "host"})` gives `agentsRuntime: "vm"`, `agentsRuntimeSet: true`; an unknown value no longer throws; unset gives `agentsRuntimeSet: false`.
  - `status.test.ts`: `it("is unusable with kvm_missing when /dev/kvm is absent")`: `assessStack(healthyClient, VERSION, () => false)` → `{usable: false, reason: "kvm_missing"}`.
  - `compose-agents-vm.unavailable.int.test.ts`: `it("boots without a VM stack")`: a TestDaemon with no pap-vmd socket and no `PAP_TEST_AGENT_RUNTIME` boots; `sessions.create` works; `agents.vmStatus` answers `usable: false`; `agents.create` answers `sandbox_unavailable`; the log has one `agents_runtime_ignored` when the env sets `PAP_AGENTS_RUNTIME=vm`.
- [ ] **Step 2: Run them, expect FAIL** (`pnpm exec vitest run <the three files>`).
- [ ] **Step 3: Implement.** `config-agents-vm.ts` stops parsing the value; the compose always composes the VM side; the Kata compose and `compose-m11-vm.ts` fail-closed paths become an unusable status (`require()` throws `sandbox_unavailable`) instead of a boot throw; `assessStack` reads `existsSync("/dev/kvm")` through the injected `kvm`; `agents.create` calls the status's `require()` before writing; the boot warning logs `agents_runtime_ignored` with the exact copy, from the new file, not `daemon.ts`.
- [ ] **Step 4: Run the gate.** Expected: green (host-mode tests still pass through the harness's explicit `"host"`).
- [ ] **Step 5: Commit** `feat(agents-vm): agents always run in microVMs (no PAP_AGENTS_RUNTIME)`

### Task A2a: delete the daemon's host paths (sessions, automation, agents)

**Files (map: recon-delete §1 apps/daemon, §4, §5, §7):**
- Delete: `modules/sessions/egress-link.ts`, the host branches of `agent-gate.ts`, `agent-port.ts`, `agent-surface.ts`, `service-launch.ts` (egress link), `modules/automation/trigger-agent.ts` host precheck (`precheckWrapOf`, `releaseEgress`), `precheck.ts`/`precheck-step.ts` `wrap`/`proxied` options, `modules/agents/resources-check.ts` `checkHostEntries`, `contracts/src/host-entry.ts` `entryNeedsVm` (if no caller is left), host-only tests listed in recon-delete §7 (sessions unit, automation, agents).
- Port to the VM bed (`testing/vm-bed.ts`, process backend): `security/platform-ops.int.test.ts`, `security/platform-ops.autonomy.int.test.ts`, `modules/agents/quarantine.int.test.ts`, `modules/agents/agent-sessions.int.test.ts`, `modules/subagents/subagents.agent.int.test.ts` (keep their assertions; drop only the host-sandbox ones). Delete `security/sandbox.int`, `sandbox.escape.int`, `agent-egress.int`, `agent-taint.shell.int` (host shell), and update `docs/agents/parity.md` row P15-4 proof files so `scripts/parity-doc.test.ts` passes.
- The daemon stops putting `sandbox` in the init record (`initFieldsOf`).

**Interfaces:**
- Consumes: A1's internal `agentsRuntime`.
- Produces: the trigger refusal word `precheck_agent` (added to the closed list next to `sandbox_unavailable` in `trigger-agent.ts` `precheckRefusal`), raised in `precheck-step.ts` for any record with `agentId !== null` and a stored precheck, before any gate call.

- [ ] **Step 1: Write the failing test** `modules/automation/precheck-agent.test.ts`: `it("refuses a stored precheck on an agent trigger")`: firing an agent trigger with `precheck: "true"` records a failed run with reason `precheck_agent`, no session is created, no precheck process is spawned (`spawnCounting` stays 0).
- [ ] **Step 2: Run it, expect FAIL.**
- [ ] **Step 3: Delete and port** per the file list. Keep `hostGrants` / `mayGrantHost` (VM refusal cards use them; recon-delete §3). Keep the `agent-bed.ts` helpers, delete only `bwrapUsable`.
- [ ] **Step 4: Gate.** `vitest related` on the changed files plus the ported int files by name.
- [ ] **Step 5: Commit** `refactor(agents): delete the host-sandbox paths of sessions, triggers and agents`

### Task A2b: delete the host egress, the probes and `PAP_BWRAP`

**Files (map: recon-delete §1 kernel/sandbox, §2, §3, §6, §8 scripts):**
- Delete: `modules/egress/{proxy.ts,forwarder.ts,runtime-dir.ts,python-probe.ts}`, `createEgress`/`bootEgress` and host exports of `modules/egress/index.ts`, `judge.ts` (move the `Decision` and `VmDetail` types to `proxy-core.ts`), `allow.ts`'s host-only exports (keep `normalizeHost`), `kernel/sandbox/` (probe and tests), `compose-m11-probe.ts`, `modules/agents/sandbox.ts` and the `agents.sandboxStatus` / `agents.recheckSandbox` methods (contracts, rpc, `methods-idempotent.ts`), `PAP_BWRAP` (`kernel/config.ts`, `compose-m11-types.ts`, `testing/compose-m11-parts.ts`, `daemon.ts` `sandboxSpawn` seam), doctor `bwrap` and `python3` checks (`cli/doctor/checks-daemon.ts`; re-anchor `registry.ts` on `"update_available"`), the host-only egress tests (recon-delete §3), the `agentsRuntime` field and harness option (A1's ponytail), `agentsRuntime === "vm"` predicates (`agentRunsInVm` and friends become constant or go).
- Modify: `scripts/install.sh`, `scripts/archive-install.sh.tpl`, `scripts/archive-install-bed.ts`, `scripts/container-entrypoint.sh` (drop `doctor --only bwrap`), `scripts/pap-container.sh` and their tests; web: delete `features/agents/{SandboxStatus,SandboxLine}.tsx`, `use-sandbox-status.ts` and their callers' props (recon-delete §4 list), so the web compiles without the removed methods.
- Modify: e2e `scripts/e2e/j07-agents.e2e.ts` + `seed.ts`: seed agents on the process backend (`PAP_TEST_AGENT_RUNTIME=process` with the scripted provider) or drop J07's agent steps; `docs/agents/e2e.md` line.

- [ ] **Step 1: Write the failing test** `modules/egress/egress.index.test.ts` (rewrite): `it("exports only the VM proxy")`: `Object.keys(await import("./index.ts"))` contains `createVmEgress` and not `createEgress`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Delete** per the list; `pnpm knip` must find no orphan.
- [ ] **Step 4: Gate.** Plus `pnpm exec vitest run scripts/` for the touched script tests.
- [ ] **Step 5: Commit** `refactor(agents): delete the host egress proxy, the bwrap probe and PAP_BWRAP`

### Task A3: delete pi-host's and contracts' host sandbox

**Files (map: recon-delete §1 contracts, pi-host):**
- Create: `packages/contracts/src/policy-paths.ts` with `SYSTEM_FOLDERS` (moved, same value); `packages/contracts/src/index.ts` exports it.
- Delete: `packages/contracts/src/sandbox.ts` and its 3 tests; `InitRecord.sandbox` (`platform.ts`); the `egress_open` / grant records (`contracts/src/pi-host.ts`, `pi-host-records.ts`, `egress.ts`) and pi-host's `dispatch.ts` handling; `packages/pi-host/src/{sandbox-tool,sandbox-ops,egress-client}.ts` and their tests, `host.sandbox.int.test.ts`; `policy/session-entry.ts` "sandbox: bwrap" line.
- Modify: `host.ts`, `session-mirror.ts`, `vm-shell/ops.ts` import `SYSTEM_TIMERS` / `ShellTimers` from `./shell-process.ts`; `open-session.ts` drops `sandboxOrder` and keeps the "pap's tool registers first" order through `vmFilesFirst` / the VM shell order; `policy/agent-stage.ts` imports `SYSTEM_FOLDERS` from contracts' new file. Keep `sandbox-env.ts` and `once-secrets.ts` (A4 uses them).

**Interfaces:**
- Produces: `InitRecord` without `sandbox`; `SYSTEM_FOLDERS` from `@pap/contracts`.

- [ ] **Step 1: Write the failing test** in `packages/pi-host/src/open-session.order.test.ts`: `it("registers pap's bash before an extension's bash in a VM session")`: a VM session whose extension also registers `bash` resolves `bash` to pap's VM shell tool.
- [ ] **Step 2: Run, expect FAIL** (if it already passes, keep it as the guard and note it in the report).
- [ ] **Step 3: Delete and repoint.**
- [ ] **Step 4: Gate.**
- [ ] **Step 5: Commit** `refactor(pi-host): delete the host sandbox tool, ops and egress client`

### Task A4: the vault in the VM

**Files:**
- Modify: `apps/daemon/src/modules/sessions/agent-port.ts` (`runsInVm` no longer refuses vault, one-use values or `secret.request`), `vm-rules.ts` (`VM_REFUSALS.vault` goes), the VM init path (`vm-init.ts` / `vm-launch.ts`) carries `vault` and `once` like the host init did; `packages/pi-host/src/host.ts` and `sandbox-env.ts`: the shell environment is built for the VM shell (rename `createSandboxEnvironment` to `createShellEnvironment(base: NodeJS.ProcessEnv, vault: Readonly<Record<string, string>>)`, no `SandboxSpec`), wrapped by `withOnceSecrets`, and handed to `vm-shell/ops.ts`'s spawn env (after `proxy-env.ts`'s entries); live `VaultUpdateRecord`s update it.
- Test: new `apps/daemon/src/security/vault-vm.int.test.ts` (port the meaningful cases of `vault-leaks.int.test.ts` onto the VM bed, then delete the old file), `packages/pi-host/src/vm-shell/ops.vault.test.ts`.

**Interfaces:**
- Consumes: A3's `InitRecord` (no `sandbox`).
- Produces: `createShellEnvironment(base, vault): ShellEnvironment` in `packages/pi-host/src/sandbox-env.ts` (file renamed `shell-env.ts`).

- [ ] **Step 1: Write the failing tests**
  - `ops.vault.test.ts`: `it("gives the VM shell the vault's values and a one-use value once")`: with `vault: {API_TOKEN: "v-12345678"}` the spawn env has `API_TOKEN`; with `once: [{name: "NPM_TOKEN", value: "o-12345678"}]` the first command naming `$NPM_TOKEN` gets it, the second does not, and `secret_used` is sent once.
  - `vault-vm.int.test.ts`: `it("redacts a vault value a VM shell prints")` (the transcript and the tool result hold `[redacted]`, never the value); `it("delivers a live vault update")` (owner adds a value mid-thread; the next command sees it); `it("lets a VM session ask for a secret")` (`secret.request` shows the card; answering stores the value and the next command sees it).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(agents-vm): the vault and one-use values reach the VM shell`

### Task A5: the web

**Files:** `apps/web/src/features/agents/{AgentForm.tsx,agent-form.vm.ts,AgentScreen.tsx,DeleteAgentDialog.tsx,use-agent-lifecycle.ts}`, `features/memory/MemorySettings.tsx`, `routes/shell/{AgentRail.tsx,AgentsSection.tsx}`, `routes/settings/AgentsSettings.tsx`, `features/automation/ExecutionSection.tsx`, i18n catalogs (`agent-settings.ts`, `shell.ts`, `automation-agents.ts`, `agent-vm.ts`), `packages/contracts/src/agents-vm-methods.ts` (`VmStatusView.runtime` removed), daemon `modules/agent-vm/status.ts` view.

- [ ] **Step 1: Write the failing tests**
  - `AgentsSection.test.tsx`: `it("shows the microVM EmptyState when the VM stack is unusable")`: `vmStatus.usable === false` renders the exact EN copy and no "New agent" action.
  - `AgentForm.test.tsx`: `it("has no sandbox switch")` (no `agent-sandbox` fieldset); the hosts hint no longer contains "VM mode:".
  - `ExecutionSection.test.tsx`: `it("hides the precheck field for an agent unless one is stored")`: agent target + empty precheck → no field; agent target + stored precheck → field with the exact note.
  - `shell` catalog test: `error.sandbox_unavailable` equals the exact copy (EN and FR).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Every `runtime === "vm"` branch becomes the VM branch; `useVmStatus()` null means "not read yet", not host mode. Delete the `vmOnly` copy and the `sandbox` keys left unused.
- [ ] **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(web): agents are microVM agents (no sandbox switch, EmptyState without KVM)`

---

## Lane B

### Task B1: taint the daemon sees

**Files:**
- Create: `packages/contracts/src/egress-clean.ts` `cleansContent(kind: "connect" | "http", port: number, host: string, trusted: readonly string[]): boolean` (true only for `connect`, port 443 and `trusted.includes(host)`); `apps/daemon/src/modules/agent-vm/launch-taint.ts` `createLaunchTaint(): LaunchTaint`.
- Modify: `packages/pi-host/src/policy/egress-taint.ts` (`commandTaints` uses `cleansContent`), `apps/daemon/src/modules/egress/vm-judge.ts` (`VmScope.trustedSources: readonly string[]`), `vm-listener.ts` (`VmEgressDeps.onTaint?(launch: {agentId: string; launchId: string}): void`, called after an allowed decision when `!cleansContent(...)`; a refused one never calls it), `apps/daemon/src/compose-agents-vm-proxy.ts` (`trustedOf` beside `hostsOf`, `bindTaint`), `compose-agents-vm-late.ts` (`trustedOf(agentId)` reads `input.trustedSources`; binds the taint to `late.sessions.mirror.taint`), `modules/agent-vm/runtime.ts` (`spawn` returns `launchId`; `onLaunchEnd` ends the launch's set), `modules/sessions/vm-launch.ts` (joins `row.id` to the launch; a marked launch taints it at once), `modules/agent-vm/index.ts` exports.

**Interfaces:**
- Produces: `interface LaunchTaint { mark(launchId: string): readonly string[]; join(launchId: string, sessionId: string): boolean; ended(launchId: string): void }`: `mark` returns the sessions to taint now (empty after the first call for that launch), `join` returns true when the launch is already marked (the caller taints the session), `ended` forgets the launch.

- [ ] **Step 1: Write the failing tests**
  - `egress-clean.test.ts`: `cleansContent("connect", 443, "docs.example.com", ["docs.example.com"])` true; `("connect", 8443, …)`, `("http", 80, …)`, an untrusted host, an IP literal: false.
  - `launch-taint.test.ts`: `mark` twice → sessions once, then `[]`; `join` after `mark` → true; `ended` → a new `join` is false.
  - `vm-listener.taint.int.test.ts` (loopback seams): a tunnel to an untrusted listed host calls `onTaint` once per tunnel; a trusted source over 443 does not; a refused host does not.
  - `vm-launch.taint.int.test.ts` (VM bed): a thread and its child live in one launch; an untrusted tunnel taints both (`policy` rows tainted, one `session_tainted_outside` log each); a thread task started after that starts tainted; a worker `taint` record with a later clear epoch does not clear it; `PlatformKind.tainted` is true for each (a `whenTainted: "ask"` op asks).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(agents-vm): the daemon taints a VM's sessions from what its proxy saw`

### Task B2: bundle digest, the silent exit, doctor

**Files:**
- Create: `apps/daemon/src/modules/agent-vm/bundle-skew.ts` `createBundleSkew(deps: {treeBundle: string | null; installedDigest(): Promise<string>; treeDigest(dir: string): Promise<string>; logger}): BundleSkew` with `check(agentId: string): Promise<"ok" | "stale" | "unchecked">` (tree digest taken once, at first call, cached for the process); `apps/daemon/src/cli/doctor/checks-vm-skew.ts` (`vm.bundle`, `agents.hostMade`, `vm.runtimeVar`).
- Modify: `kata-images.ts` (expose the installed digest it already takes), the VM start path (`compose-agents-vm-status.ts` or `runtime.ts` start, before `disk`/`vm.start`) throws `PapError("vm_bundle_stale")` on `"stale"`; `packages/contracts/src/errors.ts` (`vm_bundle_stale` in `AGENT_GATE_ERRORS`); web catalog `shell.ts` `error.vm_bundle_stale` (exact copy); `modules/agent-vm/vm-worker.ts` (on wire close, wait `EXIT_TAIL_GRACE_MS = 2000` on the `Clock` for the guest's `exited` frame, then finish with its tail; finish at once when the guest link is gone); `packages/pi-host/src/host.ts` (the policy-rules refusal names its failing paths, never values); `cli/doctor/checks-vm.ts` (drop `asVm` / `NOT_VM` gating and the `vm.listeners` host-mode text); `cli/doctor/registry.ts`.
- The tree bundle path: `packages/pi-host/dist-agent` resolved from the daemon's own location (the builder checks the archive layout; missing → `"unchecked"`, one info log `vm_bundle_unchecked`).

- [ ] **Step 1: Write the failing tests**
  - `bundle-skew.test.ts`: equal digests → `"ok"`; different → `"stale"` and one `vm_bundle_stale` log per agent; no tree bundle → `"unchecked"`; `it("keeps the boot digest")`: the tree digest function is called once across two checks even when its result would change.
  - `vm-worker.exit.test.ts`: wire closes, the guest's `exited` frame arrives 100 ms later (fake `Clock`) → the exit carries the tail; no frame within 2000 ms → exit with an empty tail.
  - `checks-vm-skew.test.ts`: `vm.bundle` ok / warn ("run `sudo pap vm setup`") / info; `agents.hostMade` lists an agent with `thread_session_id` set and no `agents/.mirrors/<id>/`; `vm.runtimeVar` warns when the unit or shell sets `PAP_AGENTS_RUNTIME`; the `vm.*` checks run with the variable unset.
  - `vm-start.stale.int.test.ts` (VM bed): a stale bundle starts no VM and the session open fails with `vm_bundle_stale`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(agents-vm): name a stale VM bundle and keep the worker's last words`

### Task B3: prompt chips from imported files

**Files:** `apps/daemon/src/modules/agent-vm/agent-files.ts` (`readOne`), `modules/agent-vm/index.ts`, `modules/agents/prompts.ts` (host `fs` code and `agentRunsInVm` go), `compose-m11-vm.ts` / the compose that builds `PromptsDeps`.

**Interfaces:**
- Produces: `AgentFiles.readOne(agentId: string, path: string): Promise<Buffer | null>` (O_NOFOLLOW, regular file, at most `AGENT_FILE_LIMITS.maxBytes`, null when absent); `PromptsDeps { store: Pick<AgentStore, "get">; files: Pick<AgentFiles, "list" | "readOne"> }`.

- [ ] **Step 1: Write the failing tests** in `prompts.test.ts` (rewrite): `list` returns the sorted names of imported `prompts/<name>.md` files whose name matches `AgentPromptName`, at most `AGENT_PROMPT_LIMITS.names`, and ignores `prompts/sub/x.md` and `notes.md`; `read` returns the text; a file over `AGENT_PROMPT_LIMITS.bytes` → `payload_too_large`; invalid UTF-8 → `bad_request`; absent → `not_found`; another owner's agent → `not_found`. `agent-files.test.ts`: `readOne` refuses a link (null) and reads a regular file.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(agents-vm): prompt chips from the agent's imported prompts`

---

## Join

### Task J1: merge, docs, review, Kata

- [ ] **Step 1:** rebase lane B on lane A; resolve conflicts (expected: `vm-judge.ts` imports, `compose-m11-vm.ts`, `status.ts`, `shell.ts` catalog); gate on the union of changed files.
- [ ] **Step 2: Docs** (map: recon-delete §8): `docs/agents/agents-vm.md` (title "sub-projects 1 to 3", the switch, the vault, taint, bundle, known limits: MCP and extension children inside the VM, the existence oracle), `docs/agents/agents.md` (host sandbox sections go), `install.md` (bubblewrap and `PAP_BWRAP` go; Agent VMs is the agents prerequisite), `doctor.md` (new rows, `bwrap`/`python3` gone), `daemon.md`, `policy.md`, `automation.md` (prechecks: not for agents), `sessions.md`, `web.md`, `README.md`, `AGENTS.md` (bubblewrap line, `PAP_AGENTS_RUNTIME`, the vault line, "sub-projects 1 to 3"); ADR 0081 `docs/adr/0081-agents-run-only-in-microvms.md` + index; ADR 0048 status "superseded for agents by 0081"; ADR 0049 note (vault values reach the VM); decisions log entry; roadmap ("sub-project 3 done").
- [ ] **Step 3: Final review** (Opus, whole branch, once), one fix wave, scoped re-review.
- [ ] **Step 4: Kata root window** (owner OK first): back up `state.db`, stop the preview, `sudo pap vm setup --home ~/.pap-kata --dev-from-tree` from the branch, `CI=1 pnpm exec vitest run --project kata` with no `PAP_AGENTS_RUNTIME`, then merge, build main, `sudo pap vm setup --home ~/.pap --dev-from-tree`, `rm -rf ~/.pap-kata`, remove the preview drop-in `agents-vm.conf`, start the preview, `pap doctor`.
