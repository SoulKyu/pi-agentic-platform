# SDD ledger — plan: docs/plans/2026-10-22-agents-vm-only.md

Spec: docs/specs/2026-10-22-agents-vm-only-design.md. Base main 3014d498. Lanes: A in .worktrees/sp3-a (feat/agents-vm-only-a), B in .worktrees/sp3-b (feat/agents-vm-only-b). Owner: Sonnet implementers + Sonnet task reviews, one Opus final review, related tests only.

## Preflight scan
| Pair / task | Shared file or interface | Finding |
|---|---|---|
| A1 → A2b | internal `agentsRuntime` (A1 keeps for harness, A2b removes) | consistent, sequential in lane A |
| A1 ↔ B2 | `modules/agent-vm/status.ts` (A1 KVM fact; B2 stale check) | Ruling: B2 puts the stale check in `bundle-skew.ts` and the start path, not in `status.ts` — avoids a join conflict — small rebase if wrong |
| A1 ↔ B3 | `compose-m11-vm.ts` | join conflict expected, J1 resolves |
| A2a → A4 | `sessions/agent-port.ts` | sequential in lane A |
| A2b ↔ B1 | `egress/judge.ts` types → `proxy-core.ts` (A2b); `vm-judge.ts` VmScope (B1) | Ruling: B1 changes only `VmScope` and its users, never the judge-type imports — keeps the rebase trivial — one import fix if wrong |
| A2b ↔ B2 | `cli/doctor/registry.ts` (A2b re-anchor; B2 adds skew checks) | join conflict expected, J1 resolves |
| A3 ↔ B2 | `pi-host/src/host.ts` (A3 imports; B2 policy-rules refusal paths) | join conflict expected, small |
| A3 → A4 | `sandbox-env.ts` kept by A3, renamed by A4 | Ruling: A4's file is `packages/pi-host/src/shell-env.ts` (plan says both names) — cosmetic |
| A5 ↔ B2 | web `i18n/catalog/shell.ts` (A5 rewrites `error.sandbox_unavailable`; B2 adds `error.vm_bundle_stale`) | join conflict expected, small |
| A1 → A5 | `VmStatusView.runtime` (A1 keeps, A5 removes) | consistent |
| B1 → B2 | `modules/agent-vm/runtime.ts` | sequential in lane B |
| A1 | tests vs code | agrees |
| A2a | precheck refusal word `precheck_agent` produced and tested | agrees |
| A2b | deletes A1's ponytail; web Sandbox* removal with the RPCs | agrees |
| A3 | the order test may already pass | Ruling: if it passes before the change it stays as the guard; reported, not a defect |
| A4 | vault/once via init + live updates | agrees |
| A5 | copy exact in Global Constraints | agrees |
| B1 | LaunchTaint interface used by vm-launch + compose | agrees |
| B2 | bundle-skew deps injected; VM bed needs an override seam for the stale int test | agrees (builder adds the seam) |
| B3 | readOne + prompts | agrees |

## Progress
- A1: dispatched (Sonnet, BASE 3014d498, lane A)
- B1: dispatched (Sonnet, BASE 3014d498, lane B)
- B1: review 1 (Sonnet): spec ❌, I1 late-join wiring untested (proxy.join), I2 missing tests (worker clear epoch, PlatformKind/whenTainted ask). Minor 4 promoted — Ruling: the bed test dials 192.168.1.40, a real address on the owner's LAN; tests must stay on loopback — Important — cost if wrong: one test rewrite.
- Ruling: both lanes share heavy-gate.lock and vitest --maxWorkers=3 from 13:30 — two parallel full-suite runs (load avg 26 on 6 cores) made the preview's GithubScraper task VMs miss GUEST_BOOT_TIMEOUT at 13:00 and 13:24 — cost if wrong: slower gates.
- A1: DONE_WITH_CONCERNS 15863a55. Controller finding: test daemons reach the REAL pap-vmd (/run/pap-vm/vmd.sock): 8 vm.list calls 13:19-13:20 in the pap-vmd journal (none earlier today), and the preview's GithubScraper thread VM was stopped at 13:19:13. Tests must never reach the real pap-vmd → Critical for A1 fix round.
- B1: fix round 1/5 done eea4f3b2 (late-join compose test, kind/epoch tests, loopback only) — re-review dispatched
- A1: review 1 (Sonnet): Critical 1 test daemons via main.ts reach the real pap-vmd + bridge ports; boot stopAll stops every listed VM (confirmed 13:19:13 journal); I1 held 7842/7843 still throws at boot; I2 env→warning chain not tested end to end. ⚠️ doctor checks-vm.ts:57 still gated on PAP_AGENTS_RUNTIME → owned by B2 (plan), not a gap of A1. Minors deferred: down reason when a port is held; no missing-KVM int case; stale comments; bridge wait up to 60 s per daemon. Fix round 1 sent.
- B1: re-review 1: 3/3 addressed, no new breakage. Minor (deferred): epoch case runs on fakePolicyPort, not the real policy module.
- Task B1: complete (commits 3014d498..eea4f3b2, review clean after 1 round)
- B2: dispatched (Sonnet, BASE eea4f3b2, lane B)
- A1: fix round 1/5 done 7e796b41 (PAP_TEST_VMD_SOCKET guard + helpers, held proxy port → unusable, env→warning int test) — re-review dispatched
- A1: re-review 1: F2, F3 addressed; F1 NOT addressed: scripts/smoke-install.ts starts the built daemon without the scripted provider → can still reach the real pap-vmd. Minors deferred: held proxy port has no test; stopAll runs before the proxy bind; config→daemon flag hand-passed in the int test.
- A1: Ruling: smoke-install refuses to start when the default pap-vmd socket exists (no production change; CI has none) — keeps tests off the live VMs — cost if wrong: smoke:install cannot run on a host with agent VMs.
- A1: fix round 2 sent.
- B2: DONE_WITH_CONCERNS 84a26050 — review dispatched
- B2: review 1: Critical cross-lane.int.test.ts:135 runs doctor() without --only → reaches the real pap-vmd and /opt/pap-vm now that vm.* checks are ungated; Important agents.hostMade false positive on a never-prompted VM thread (fix: thread row pi_path not null and outside agents/.mirrors). Fix round 1 sent.
- A1: fix round 2/5 d3f0d197 (refuseLiveVmd in smoke-lib startDaemon, pin tests) — 22-line diff, controller-verified (test passes, logic reviewed) instead of a re-review agent (sdd-lightening tiny-fix rule).
- Task A1: complete (commits 3014d498..d3f0d197, review clean after 2 rounds)
- A2a: dispatched (Sonnet, BASE d3f0d197, lane A)
- B2: fix round 1/5 done 61319dd9 (DOCTOR_ONLY_NO_VM for whole doctor runs in tests; hostMade via sessions.pi_path) — re-review dispatched
- B2: fix round 1 controller-verified (34-line diff: hostMade join on sessions.pi_path outside .mirrors; DOCTOR_ONLY_NO_VM) — both findings addressed.
- Task B2: complete (commits eea4f3b2..61319dd9, review clean after 1 round). Minor (deferred): a VM already running old code keeps running after `pap vm setup` until it restarts.
- B3: dispatched (Sonnet, BASE 61319dd9, lane B)
- B3: DONE a26c445a — review dispatched
- B3: review 1: spec ✅; Important: readOne FIFO/oversize guard untested. ⚠️ dead `agentRunsInVm` safety port in compose-m11-vm.ts → Ruling: lane A (A2b) removes it with the other host predicates — it is in A2b's file list — cost if wrong: one dead line found by knip at J1. Minors: `agents.prompt(s)` contracts still list `invalid_cwd` (deferred to J1 sweep). Fix round 1 sent.
- B3: fix round 1 f0a5f9cb test-only (FIFO + oversize readOne, FIFO chip) — controller-verified (tests pass).
- Task B3: complete (commits 61319dd9..f0a5f9cb, review clean after 1 round)
- Lane B done; waits for lane A before J1.
- A2a: DONE_WITH_CONCERNS 13ff75f4 (wider scope: ~15 host-agent tests moved to the VM bed; harness `vm: true`; pi-host raw-channel test support). For A4: vault-leaks.int, secrets/vault.int, secret-request.int deleted (restore from d3f0d197 per the A2a report list); platform-ops expects secret.request `unavailable` → A4 turns it back to ok. Left for A2b: AgentGateDeps.egress, agentRunsInVm predicates, harness agentsRuntime, host egress module; entryNeedsVm stays until A5 (web imports it). Review dispatched.
- A2a: review 1: spec ✅ w/ gaps; I1 agent-launch.sandboxed-only tests deleted while the guard lives (service-launch.ts:110, automation-port.ts:253-269); I2 agent-taint.int RT-12 adopted-in-home + RT-01 scratch-read cases lost. pi-host test support gated to tests (ok). Fix round 1 sent.
- A2a: fix round 1/5 85116d8a (test-only, 226 lines: sandboxed-only cases restored on VM code; agent-home.int RT-12). Controller ran them: 7/7 pass.
- A2a: Ruling: accept the test-only fix without a re-review agent (226 lines > the 50-line tiny-fix rule) — tests only, both findings visibly answered, the final Opus review sees them — cost if wrong: a weak test caught at the final review.
- A2a: Ruling: RT-01 "scratch read is external content" not ported — a task VM has no scratch the thread can read; its result reaches the thread as a fenced card (agent-delegate.int) — cost if wrong: one missing taint case.
- Task A2a: complete (commits d3f0d197..85116d8a, review clean after 1 round)
- A2b: dispatched (Sonnet, BASE 85116d8a, lane A)
- A2b: DONE_WITH_CONCERNS fe921d0e (142 files, -6588). Harness defaults testVmdSocket to <root>/no-vmd.sock. J07 cut down (no thread; built daemon has no process-backend guest seam) — Ruling: accept — e2e keeps form/permissions/quarantine; threads are covered by int + Kata — cost if wrong: browser-level thread regressions surface later. Left for J1: docs (AGENTS.md, agents.md, daemon.md, install.md), CI setup action + Containerfile bubblewrap, RunsAsField.test copy (A5). Review dispatched.
- A2b: review 1: spec ❌ only J07 (agents.create → vm.require → sandbox_unavailable without pap-vmd); else clean.
- A2b: Ruling: J07 becomes the "no VM stack" journey (submit new agent → sandbox_unavailable copy, no agent listed); A5 retargets it to the EmptyState — an e2e daemon without KVM sees exactly this — cost if wrong: no browser e2e of agent threads (int + Kata cover them). Fix round 1 sent.
- A2b: fix round 1/5 988185cb (J07 = no-VM-stack journey, e2e.md line) — controller-verified (diff read; typecheck clean per report).
- Task A2b: complete (commits 85116d8a..988185cb, review clean after 1 round)
- A3: dispatched (Sonnet, BASE 988185cb, lane A)
- A3: interrupted by the controller session restart (16:4x, partial uncommitted work kept); resumed the same agent.
- A3: DONE be6ad2e7 (vmShellFirst moved to vm-shell/tool.ts; egress records gone; host.ts createVaultSink environment undefined = A4 seam; dead pi-host policy egress dep left) — review dispatched
- A3: DONE_WITH_CONCERNS be6ad2e7 (order guard passed before → kept; bash-first moved to vmShellFirst; egress_open/grant records deleted; sandbox-env takes {home}; vault seam: createVaultSink environment undefined). Note for J1: the policy `egress.take` path (pi-host policy/egress-taint.ts) has no producer now, but lane B's B1 rewired commandTaints to cleansContent — decide at the join (knip). Review dispatched.
- A3: review 1: spec ✅, quality approved. Minors (deferred, 5): main one — InitRecord is non-strict, so a stray `sandbox` field is stripped silently (see task-A3-review.md).
- Task A3: complete (commits 988185cb..be6ad2e7, review clean)
- A4: dispatched (Sonnet, BASE be6ad2e7, lane A)
- A3: review 1: spec ✅; Important: InitRecord strips a stale sandbox key instead of refusing (pi-host.ts:13). Minors: dead egress.take path (join), 2 stale comments (in the fix). Fix round 1 sent.
- !! TWO CONTROLLERS (17:06): session PID 4864 (original, still running) and session PID 2374939 (resumed 16:42 via /remote-control) both drive this plan. 2374939 reviewed A3 independently and ran a fix round: 375520d7 "fix(contracts): refuse a stale sandbox key in the init record" (InitRecord refuses `sandbox`; 2 stale comments) — on top of be6ad2e7, only its 4 files; A4's uncommitted work in sp3-a untouched (an accidental sweep commit 67b44501 was undone). 2374939 stops dispatching until the owner picks one session.
- A4: DONE_WITH_CONCERNS 426ef55e (found+fixed: pi-host dispatch.ts dropped every vault_update for VM sessions; vault.kata.int written, not run; shell side proven at unit level) — review dispatched
- A4: review 1: spec ✅, quality approved, 5 Minors (deferred, task-A4-review.md). ⚠️ vault.kata.int not run → J1 root window runs it (owned by J1).
- Task A4: complete (commits be6ad2e7..426ef55e incl. 375520d7 A3 follow-up, review clean)
- A5: dispatched (Sonnet, BASE 426ef55e, lane A)
- A4: agent stopped (TaskStop) after it re-ran tests in lane A while A5 edits the web; its 3 web copy failures are A5's in-progress copy (AgentResources, AgentScreen, NewAgentDialog.defaults) → A5 must leave them green.
- A5: DONE a527571e (EmptyState phone tab; J07 kept on desktop dialog; runtime-bed plugins.list default; entryNeedsVm removed) — review dispatched
- A5: review 1: I1 stale 'vault arrives SP2 / prechecks SP3' copy shown to every agent; I2 unused agentsSandbox.* bubblewrap keys (+ minors: PermissionsSheet sandbox row, 'VM mode only' comments); I3 desktop learns of unavailability only after submit → EmptyState in the New agent dialog. The 3 web tests A4 saw failing pass (40/40). Fix round 1 sent.
- A5: fix round 1/5 5a9a61d7 (stale copy removed, agentsSandbox keys gone, PermissionsSheet microVM copy, NoVmState shared by dialog + phone tab, J07 → EmptyState in dialog) — controller-verified (diff read, 3 touched test files pass).
- Task A5: complete (commits 426ef55e..5a9a61d7, review clean after 1 round)
- Lane A done. Next: J1 (merge lane B into A, docs, ADR 0081, Opus final review, Kata root window with owner OK).
- J1 steps 1-2: dispatched (Sonnet, lane A worktree, merge B into A + gate + docs + minor sweep). Ruling: merge, not rebase — the branch is squashed at the end — cost if wrong: none.
- J1 steps 1-2: DONE a7ab703a (merge), fd46113a (docs, ADR 0081, decision 122), dcbd588b + bb4235ac (minor sweep). Gate: 1815 files / 19596 tests related, 1 own failure fixed. Left: dead pi-host egress seam (~8 files), CI bwrap input kept for vm-shell ops.bwrap.int, docs not verifiable (automation.md scratch, web.md advice line, old screenshot).
- J1 step 3: Opus final review dispatched (package excludes test bodies; test stat separate).
- Owner chose session 2374939; old session 4864 stopped (SIGTERM, ~17:15). Correction: 4864 had already finished A4, A5 and J1 steps 1-2 (lines above, written by 4864); its Opus final review (J1 step 3) died with it. sp3-a clean at bb4235ac. Nothing re-dispatched for A4.
- J1 step 3: Opus final review re-dispatched by 2374939 (package review-final.diff at bb4235ac).
- J1 step 3: Opus final review: With fixes, 0 Critical, 5 Important (I-1 dev daemon reaches real pap-vmd/stopAll; I-2 permissions.ts reads retired sandbox.required; I-3 shared proxy core lost bounds/limits/lookup tests; I-4 down mode sticky + wrong reason after vm setup; I-5 container systempaths=unconfined). Triage 'fix before merge': A1 m1 (in I-4), A2b m3 + A5 PermissionsSheet (in I-2), A2b m5 systempaths (I-5); vault.kata must run in the root window. One fix wave dispatched (Sonnet, BASE bb4235ac).
- Final fix wave DONE 8db6d657..d229c8b4 (I-1..I-5). Pre-existing on branch: scripts/adr-index.test.ts (2) + docs-truth.test.ts (1) fail (stale docs/ADR text from J1) → docs-fix agent dispatched in parallel with the scoped re-review.
- Final re-review: I-1..I-5 ADDRESSED, no new C/I. Residual minors: restart message wording (conditional gate + missing 'rest of pap works', FR untranslated like other stack reasons); trifecta advice dead (privateData always false); stale copy agentSafety.secrets.intro. → controller trivial fixes after the docs agent commits.
- Docs-test fix 5927949c (adr-index 5/5, docs-truth 10/10; ADR 0048 "superseded by 0081").
- Controller trivial fixes <HEAD>: trifecta privateData = vault names (ponytail: imported files not counted); restart reason plain ("the rest of pap works"); agentSafety.secrets.intro copy (EN/FR).
- Ruling: doctor check id `agents.hostMade` → `vm.hostMade` — docs-truth refuses a dotted `agents.*` name that is no RPC method, and registry.test needs the id in doctor.md — cost if wrong: one renamed id (no user ever saw it).
- Final review residuals closed. Remaining before merge: Kata root window (owner OK).
