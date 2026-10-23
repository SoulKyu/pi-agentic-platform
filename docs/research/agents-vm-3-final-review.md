# Final review: agents in microVMs, sub-project 3 (the VM as the only agent runtime)

Reviewer: Opus, whole branch `3014d498..bb4235ac` (worktree `.worktrees/sp3-a`, lane B merged in). I read the method (`requesting-code-review/code-reviewer.md`), the spec, the plan, the ledger and every task review. I read `review-final.diff` in passes (contracts, daemon composition, agent-vm, sessions, automation, egress, pi-host, web, scripts, docs), then checked the production wiring paths in the worktree.

Tests I ran, by path (`--maxWorkers=2`), all green:
- unit: `compose-agents-vm-socket`, `bundle-skew`, `launch-taint`, `vm-worker.exit`, `checks-vm-skew`, `compose-agents-vm-proxy.taint`, `contracts/egress-clean`: 7 files, 38 tests.
- int: `vm-launch.taint.int`, `compose-agents-vm.unavailable.int`, `vm-start.stale.int`, `vm-listener.taint.int`: 4 files, 9 tests.

I ran no smoke script, no doctor CLI, no e2e and no kata test.

## Strengths

- **The switch fails closed and leaves boot alone.** `composeAgentsVm` now always composes. With no pap-vmd, no bridge, or a held gateway or proxy port, it binds loopback and sets `down`. In that state the relay is `off`, `stopAll` is skipped, and the status reports unusable, so `require()` refuses with `sandbox_unavailable` (`compose-agents-vm.ts:186-192, 285-286`; `compose-agents-vm-kata.ts:awaitBridge/listenGateway`; `compose-agents-vm-socket.ts:startProxy`). `agents.create` is gated by `deps.vm?.require()` (`service.ts:279`). `agentGate` refuses any agent row without a VM layout, and `vmBranchOf` throws `internal` if the row and the launch disagree, so there is no path to a host worker. `PAP_AGENTS_RUNTIME` is only a flag plus a warning.
- **The taint path is right end to end.** `vm-listener.ts:135-141` calls `onTaint` only on an allowed `ips` decision that `cleansContent` rejects, and a refusal never reaches it. `composeVmProxy` keeps a per-launch `LaunchTaint`. `vm-launch.ts` joins each session right after `runtime.spawn`, and that works for children too because `spawn` returns the entry's `launchId`. The sink is `late.sessions.mirror.taint`, which is `outsideToolResultsTaint`, which calls `policy.markTainted` with a null epoch. The SQL `observedEpoch IS NULL OR …` always raises, and only the owner's `policy.clearTaint` lowers taint. `sessionKind` reads `policy.taint.tainted` live, so `PlatformKind.tainted` follows. The audit row and the log are written only when the taint was actually raised (one each per session).
- **The vault in the VM is wired on the real path.** `vmInitOf` keeps `vault` and `once`, and `secret.request` is no longer filtered. `agentGate` gives a thread or a task the vault but never a child. In pi-host, `withOnceSecrets(createShellEnvironment(process.env, vault))` feeds `createVmShellTool` (`open-session.ts:212-217`). The shell environment is `unattendedEnv(keep: [])` plus the vault, then the proxy variables, then the fixed PATH/HOME/LANG/TERM. That excludes the relay key, provider keys and credential-looking names. The stream redactor is wired (`redact: () => deps.secrets.current()`), and `dispatch.ts` now applies a `vault_update` to a VM session. A4 found and fixed that last one.
- **Bundle skew is consistent by construction.** Both sides hash with `treeDigest` and the same salt, and the base tag is the installed digest. `cpSync` (dev setup) and `tar --mode=u+rwX,go+rX` / `chmod u-s,g-s,go-w` (release) keep the exec bits that `treeDigest` hashes. A stale verdict is confirmed with a fresh read, it is logged once per agent, and an install without a tree bundle is `unchecked`. The exit-tail grace runs on the `Clock` and finishes at once when the guest link is gone.
- **Test isolation is much tighter.** `kataSeamsOf` refuses a scripted-provider daemon that names no pap-vmd. Every daemon-spawning test path I found sets `PAP_TEST_VMD_SOCKET`: the harness, `main.int`, the crash bed, e2e and smoke-dist. `smoke-lib.startDaemon` refuses while a live pap-vmd exists. Whole doctor runs go through `DOCTOR_ONLY_NO_VM`. `vm-launch.taint.int` stays on loopback (`127.7.0.n` and local echo servers).
- **The deletions are clean.** I found no live reference to `bwrapArgv`, `SandboxSpec`, `PAP_BWRAP`, the egress client, `sandboxStatus` or `agentRunsInVm`. The VM side is intact: `vm-listener`, `vm-judge`, `proxy-core`, `lookup`, `report`, `refusal`, `relay-http`, `vm-address`, `vm-shell/*`, the gateway and the relay.
- **Global constraints hold.** Every changed file is at most 400 lines; the largest are `agent-safety.ts` (399) and `compose-agents-vm.ts` (398). No method was added (two were removed along with their permissions). `PAP_TEST_VMD_SOCKET` is refused without the scripted provider. The new web code has no raw colours or arbitrary values.
- **The docs (ADR 0081, `agents-vm.md`) are honest.** They state that the worker still taints on every networked shell result, so trusted sources no longer clean a VM shell. They also cover the approval engine running inside the VM, and the fact that MCP and extension children are not confined.

## Issues

### Critical (must fix)

None found.

### Important (should fix before merge)

**I-1. A dev daemon now dials the real pap-vmd by default. Its boot `stopAll` can stop the preview's VMs.**
- Where: `compose-agents-vm-socket.ts:12-15`, `compose-agents-vm.ts:181, 285`.
- What is wrong: `kataSeamsOf` returns the default socket for any daemon without the scripted provider. Before this branch, a daemon without `PAP_AGENTS_RUNTIME=vm` (for example `pnpm --filter @pap/daemon dev`, documented in AGENTS.md, run from a worktree) never touched pap-vmd. Now it awaits the bridge on `/run/pap-vm/vmd.sock`. If 10.213.0.1:7841 is free at that moment, it binds the gateway and runs `stopAll`. The port is free whenever the preview is stopped, including its rebuild-and-restart window after every merge. `stopAll` stops every VM pap-vmd lists, which are the preview home's VMs. The dev daemon also takes 7842/7843, so the preview then boots in `down` mode until someone restarts it.
- Why it matters: this is the A1 Critical (a pap other than the preview reaching pap-vmd and stopping live VMs), now reached through a documented command instead of a test. pap-vmd serves one home (`vmdConfig.papHome`), but the daemon never checks that.
- Fix (choose one):
  - (a) Before any `stopAll` or bind, refuse (go `down`) when the daemon's `config.home` is not the home pap-vmd serves. That means reading `papHome` from the vmd config, or adding it to `vmd.health`; the latter is a vmd change.
  - (b) Cheapest: a `--dev` daemon composes Kata only when the owner opts in (for example `PAP_DEV_VMD=1`), and is otherwise `down`.
  - Either way, add one test.

**I-2. The permissions view still honours the retired `sandbox.required`. For a VM agent it can claim host access and hide its network.**
- Where: `modules/agents/permissions.ts:72, 99, 103, 111-119`; `PermissionsSheet.tsx:96-100`; `agent-safety.ts:27-36, 103-107`; `contracts/agents.ts:159` (`widensReach`).
- What is wrong: the spec (§3) says stored profiles keep the field "present and ignored". Every VM session's rules force `required: true` and take network from `sandbox.network` alone (`vm-rules.ts:22`). The view does not follow that. With `required: false` (any SP1/SP2 VM agent saved with the switch off, or any new agent when the owner's stored `newAgent.sandbox.required` is false), the sheet says:
  - "Sandbox: off. Its shell runs as you, with your files and your network."
  - "Egress: off. pap's proxy is not in the path".

  It also hides the Network line, flags `privateData`, and advises "turn the sandbox on". The form no longer has that switch, and the Settings › Agents UI no longer shows the stored default either.
- Why it matters: the shell actually has proxied network. A security sheet that understates reach breaks the "docs and copy never claim more" rule, and its remedy cannot be applied. `widensReach` also asks for a step-up on create for the same hidden flag.
- Fix: set `effective = "on"` and `networked = input.sandbox.network`. Drop the `off` and `unavailable` sandbox copy, the "turn the sandbox on" advice, and the `sandbox.required ?` guard in the sheet. Drop the `required` term from `widensReach`, or force it in `profileOf`. Update `permissions.test.ts:105-116, 139-148, 212`.

**I-3. The shared proxy core lost its tests while it still runs the VM proxy.**
- Where: deleted `modules/egress/proxy.{bounds,limits,lookup,http,connect}.test.ts`. The code they exercised stays live in `proxy-core.ts`, `lookup.ts` and `relay-http.ts` through `createVmEgress` (`VM_LIMITS` keeps every `EGRESS_LIMITS` field except bytes).
- What is wrong: no test now imports these files. These behaviours of the remaining VM proxy are untested:
  - 431 for a request head over 16 KiB
  - closing a head slower than 10 s
  - closing a tunnel idle for 120 s
  - the time cap
  - the daemon-wide upstream cap
  - the lookup semaphore and its 5 s deadline
  - pipelined requests opening only one upstream
  - trying each DNS answer in order
- Why it matters: these are the DoS and anti-rebinding bounds of a security exit, and they now have no regression net.
- Fix: port the core cases onto `createVmEgress` with the loopback seams already used in `vm-listener.int.test.ts` (head 431, slow head, idle tunnel, upstream cap, lookup deadline, answers in order).

**I-4. `down` mode is sticky, and the status sends the owner in a loop.**
- Where: `compose-agents-vm-status.ts:55-56` (the `down` reason is `STACK_REASONS.unreachable`); `NoVmState`.
- What is wrong: a pap that booted without pap-vmd stays unusable until it restarts. That is by design and documented in the troubleshooting table of `agents-vm.md:162`. The owner does not see that design. They follow the EmptyState, run `sudo pap vm setup` (which restarts the pap-vm units, not pap), and then:
  - the EmptyState is still there;
  - Settings › Agents still says "pap-vmd does not answer: run `sudo pap vm setup`, then start pap-vmd", although pap-vmd now answers;
  - `pap doctor` says `vm.vmd` ok and `vm.listeners` warns with a `journalctl` fix.
- Why it matters: this contradicts the spec's "they come back when the VM stack does", and the copy is false on the main onboarding path. It also covers the A1 minor about a held port.
- Fix: add a `down` reason, for example "pap started before its VM stack was ready: restart pap (`systemctl --user restart pap`)", shown by `agents.vmStatus` and the doctor. Optionally point the `vm.listeners` fix at the restart. The plan pins the EmptyState copy itself, so leave that unless the owner wants it changed.

**I-5. The container still drops a protection for the sandbox that no longer exists.**
- Where: `scripts/pap-container.sh:64` `--security-opt systempaths=unconfined`; `install.md:175` admits it "was needed by the host sandbox for agents, which is gone".
- What is wrong: the option unmasks `/proc` and `/sys` paths for the whole container. Its only reason was bwrap in the container, and both bwrap and the entrypoint probe are gone.
- Why it matters: it is a security relaxation with no purpose left (security by default; A2b already flagged it for the join).
- Fix: remove the option and update `container-wrapper.test.ts` and `install.md:175-177`. Optionally also drop `python3` from the runtime stage; its only runtime user was the egress forwarder, and only `container.test.ts:52-54` pins it.

### Minor (nice to have)

**Bundle skew**
1. `bundle-skew.ts:47`: `own ??= deps.treeDigest(...)` caches a rejected promise forever (B2 minor 3). If the first check runs while `pnpm build` is swapping `dist-agent`, every VM start throws a non-`PapError` (`internal`) until pap restarts. Two lines fix it: clear `own` on rejection, and answer `unchecked` with the info log. I recommend doing this in the fix wave.
2. `bundle-skew.ts:23`: `treeBundleOf` walks up to `/`. A worktree without `dist-agent` (such as `.worktrees/sp3-a` inside the main checkout) finds the main checkout's bundle. Stop at the pap root (the first ancestor with the workspace `package.json`).
3. `bundle-skew.ts:51` (B2 minor 4): while the verdict is stale, every spawn re-hashes `/opt/pap-vm/agent-bundle` synchronously on the event loop. Acceptable for now.
4. The tree digest is taken at the first check, not at boot (spec §6 says "at boot"; the plan says "at first call", so the plan sanctions it). A daemon that boots, sees the tree rebuilt, and only then starts an agent compares against the new build. Taking it in `skewOf` at compose time would close this at no cost.
5. No test proves that a release's archive-staged `dist-agent` digest equals the extracted `pap-agent-bundle` from the same release. It is equal by construction (same folder, same job), but a cheap `release:check` assertion would guard against every archive install being stuck "stale" for good.

**Taint**
6. `launch-taint.ts:25-30`: each session is marked once per launch, as the spec says. If the owner Clears a session's taint, later untrusted tunnels in the same live launch never re-mark it at the daemon; only an honest worker would re-taint. Consider re-arming the mark after a clear (keep the "one audit row" rule by relying on `markTainted`'s "raised" result), or document the residual.
7. `launch-taint.ts`: a `join` that arrives after `ended` (a launch that ended between `spawn` and `joinLaunch`) recreates an entry that is never deleted. This is a small leak. Ignore a join for an unknown launch, or delete in `ended` only after the last session leaves.

**Copy and doctor**
8. `automation-agents.ts:22, 49`: "no usable sandbox on this host" is stale copy for `sandbox_unavailable` (it should speak of microVMs). The fire journal shows `precheck_agent` as the raw word; add catalog copy if that journal view maps words.
9. `vm-rules.ts:7`: `VM_REFUSALS.precheck` is unused and its copy is stale ("arrive with sub-project 3"). knip does not see unused object keys.
10. Doctor: on a machine that never installed the VM stack, `vm.kvm`, `vm.vmd` and the others now report `fail`, so `pap doctor` exits 1 on every install that has no agents. Consider `info` or `warn` when `/opt/pap-vm` does not exist ("agents are not set up").

**Dead code (none of it needs to go before merge)**
11. The dead pi-host egress seam: `policy/egress-taint.ts` (`commandTaints`, `egressVerdict`), `config.egress` in `policy/extension.ts`, `deps.egress` in `policy/results.ts`, and `EgressReport` in contracts. Nothing produces into it, the behaviour is conservative (a missing report taints), and knip is clean. Remove it in a follow-up together with its three test files, so nobody reads it as a cleaning path that still works. `cleansContent` is separate and live.
12. Residue around the retired switch (A4 minor 2): `agent-surface.ts:219-226` `sandboxedThread` reads `sandbox.required` for non-VM rows, which production never has. `requests.ts` keeps a `sandboxed()` check that is now always true. Fold this into I-2 if convenient.

**Smaller items**
13. `compose-agents-vm.unavailable.int.test.ts` only exercises a missing pap-vmd with `kvm: () => true`. The KVM-missing path is unit-tested only (A1 minor 2).
14. `IsolatedProfile.tsx`: a failed `useVmStatus` read stays "checking" forever (A2b minor 4).
15. `README.md:31` and `docs/screenshots/agents-sandbox.png` still describe the deleted sandbox panel.

## Triage of the deferred minors (ledger and task reviews)

| Source | Minor | Triage |
|---|---|---|
| A1 m1 | `down` reason wrong when a port is held | **Fix before merge**, inside I-4 |
| A1 m2 | No missing-KVM int case | May follow (Minor 13) |
| A1 m3 | `down` sticky until restart | Behaviour accepted; the copy is fixed under I-4 |
| A1 m4 | Stale comments | Done (J1 sweep, checked) |
| A1 m5 | Bridge wait of up to 60 s per daemon | May follow; test daemons now hit an ENOENT socket, so the boot is immediate |
| A1 re-review | Held proxy port untested; `stopAll` before the proxy bind; config flag hand-passed; `PAP_TEST_VMD_SOCKET` may name the real path | May follow |
| B1 | Epoch case on a fake policy port | Closed: checked in `session-store.ts:72-78` (a null epoch always raises; no worker path clears) |
| B2 m3 | Rejected tree digest cached forever | **Should fix in the wave** (Minor 1, two lines) |
| B2 m4 | Synchronous re-hash while stale | May follow |
| B2 m5 | Worker `alive` for 2 s after the wire closes | Accept (spec trade-off) |
| B2 m6 | `DOCTOR_ONLY_NO_VM` is an inverse filter | May follow (no other check reaches the machine today) |
| B2 | A VM running old code keeps running until restart | Accept (documented in ADR 0081) |
| B3 | Agent folder not lstat-checked in `readOne`; nested describe; `NO_AGENT_FILES` fallback; allocation | May follow (the folder is daemon-owned, 0700) |
| B3 | `invalid_cwd` on `agents.prompt(s)`; dead `compose-m11-vm` safety port | Done (J1) |
| A2a m1-m6 | Child preset check dropped; service-bed patch; duplicate assertion; `claudeEnvOf` `where.vm`; thin parity proofs; resources-check coverage | May follow; P15-7 and P15-12 proofs are restored (checked) |
| A2b m1, m2 | `prompts`/`agentRunsInVm`; AgentForm comment | Done |
| A2b m3 | Permissions `effective` | **Fix before merge** (I-2) |
| A2b m4 | `IsolatedProfile` "unread" state lost | May follow (Minor 14) |
| A2b m5 | Container `systempaths=unconfined`, bubblewrap, python3 | bubblewrap done; `systempaths` **fix before merge** (I-5); python3 may follow |
| A2b m6 | A warn at every plain test daemon boot | Accept |
| A3 | `InitRecord` strips a stale `sandbox` key | Done (375520d7) |
| A3 | Dead egress seam | May follow (Minor 11); not required before merge |
| A3 | Stale "from `init.sandbox`" comments | Done (checked) |
| A4 m1 | A tainted isolated task gets the vault (no bash) | May follow: least-privilege idea, same as host mode |
| A4 m2 | `sandboxedThread` and `sandboxed()` residue | May follow; fold into I-2 if convenient |
| A4 m3 | `vault.kata` assertion weak, **test not run** | **Run before merge** in the Kata root window; strengthening the assertion may follow |
| A4 m4, m5 | One-use value consumed on a spawn throw; ADR 0049 limits | Accept |
| A5 | Sandbox copy left in `PermissionsSheet` | **Fix before merge** (I-2) |
| A5 | "VM mode only" comments; `files: true` constant; tests not written RED-first | Comments done (checked); the rest may follow or is accepted |
| J1 | Dead pi-host egress seam | May follow (Minor 11) |
| J1 | CI bwrap input kept | Keep (`ops.bwrap.int` needs it) |
| J1 | Docs not verifiable | `web.md:300` advice line goes with I-2; `automation.md` scratch text and the screenshot may follow (Minor 15) |

## Required before merge (besides the fixes above)

- The J1 step 4 Kata root window, owner OK first: `vault.kata.int.test.ts` and the whole `kata` project with no runtime variable set. The vault-to-VM-shell wiring in `host.ts` (`...(initial.vm ? { shellEnvironment } : {})`) is proven only by the kata test plus unit tests; the process backend cannot run the root shell.

## Declined to judge

- Confining MCP stdio servers and extension children inside the VM: an owner non-goal, documented in ADR 0081.
- The fd-relative path judge and the existence oracle: a spec non-goal.
- `export_html`, pi-mem0 and disk backups: sub-projects 4 and 5.
- Trigger prechecks for agents: the owner's decision; the stored-precheck refusal was checked.
- The worker taints every networked VM shell result, so trusted sources do not clean a VM shell: pre-existing SP2 behaviour, documented in `agents-vm.md:68`. The spec only asks for the daemon's own mark.
- The behaviour of the `kata` project, the e2e, and the smoke and doctor CLIs on a real host: not run, per instructions.
- The J07 e2e cut to the "no VM stack" journey: an accepted ruling.
- The bridge wait of up to 60 s when pap-vmd answers without `pap0`: pre-existing SP1 behaviour.

## Assessment

**Ready to merge: With fixes.**

**Reasoning:** The switch, the daemon-side taint, the vault in the VM, the bundle skew and the deletions are correct on the production wiring path, and I found no Critical defect. Five Important items should be fixed first:
- I-1: a dev daemon can stop the preview's VMs through the real pap-vmd.
- I-2: the permissions sheet misstates the network and sandbox of VM agents.
- I-3: the shared proxy core lost its bounds tests.
- I-4: the onboarding status loops after `pap vm setup`.
- I-5: a container security relaxation with no purpose left.

Each is small. The Kata root window must also pass before merge.
