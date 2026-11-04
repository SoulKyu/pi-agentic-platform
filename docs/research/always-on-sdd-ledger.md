# Always-on boxes SDD ledger

Archived from the SDD workspace at the merge (decision 150). Rulings: `always-on-rulings.md`; final review: `always-on-final-review.md`.


Spec: docs/specs/2026-11-04-always-on-design.md (decision 149)
Worktree: /home/ubuntu/Workspace/soulkyu/pap-always-on, branch feat/always-on, from main 500e203d.
Models (owner-approved 2026-11-04 « Go »): Sonnet implementers and task reviews, Opus final review; Opus fix-round escalation only with the owner's OK.

## Pre-flight scan

| Pair / task | Produces vs consumes | Found |
|---|---|---|
| T1 → T2 | T1 moves VM_OVERHEAD_MB to contracts, kernel re-exports; T2's lifecycle.ts imports it from kernel | consistent (re-export) |
| T1 → T4 | AgentInput.alwaysOn, ProjectBoxRow.alwaysOn, ProjectsPort.onAlwaysOnChange | consistent |
| T2 → T4 | AlwaysOnHooks, bindAlwaysOn, refreshIdle | consistent |
| T3 → T4 | bindKeepWorker, touchIdle | consistent |
| T1 → T5 | ProjectBoxView.alwaysOn, setBox alwaysOn, OverviewBox.alwaysOn, VM_OVERHEAD_MB from @pap/contracts | consistent |
| T1 ↔ T5 (web fixtures) | T1 must keep web typecheck green after OverviewBox/ProjectBoxView gain a required field | T1 touches box-fixtures.ts and any web test literal the typecheck flags |
| T4 ↔ T5 (docs) | T4: agents-vm.md, daemon.md, AGENTS.md; T5: web.md | no overlap |
| T1 self | the agents-service test case has no file in the Test list | P1 |
| T2 self | KEPT task VM keeps KEPT_IDLE_MS vs isolated entries pass no holds | consistent |
| T3 self | kept = busy beats background (8 h) | consistent |
| T4 self | int test needs a VM kill seam and a member; daemon.ts +1 net | allowed by the plan (test-only seam) |
| T5 self | hint {memory} = "1.5 GB" but overview formatGb returns the number only (the unit comes from `overview.size`) | P2 |

- Ruling: P1 — the agents.update case goes in the existing `modules/agents/service.test.ts` (or a new `service.always-on.test.ts` if that file is near 400) — plan lists no file — cost if wrong: none.
- Ruling: P2 — T5 builds {memory} as formatGb(memoryMb + VM_OVERHEAD_MB, locale) plus a new unit key `agentVm.size` ("{value} GB" / « {value} Go »), matching the Overview's `overview.size` — features cannot import each other's catalogs — cost if wrong: one duplicated two-word key.

## Execution
Task 1: dispatched (implementer sonnet af61f0bd, BASE 500e203d, brief task-1-brief.md)
Task 1: implementer DONE_WITH_CONCERNS 1d31d1ad (impl before tests, RED by stash; related over 53 files timed out, ran 32 unit files + web related)
Task 1: review dispatched (sonnet ab7f87ad, package review-500e203d..1d31d1ad.diff)
Task 1: review (sonnet) — Spec ✅, Approved, 0 C/I. ⚠️ formatGb move = T5 (plan T5 Files), resolved; int files not run (fixture literal only, typecheck covers) — the join runs test:int.
Task 1: minor (deferred): setBox "changed" decision reads record.alwaysOn before the write (fine while synchronous)
Task 1: minor (deferred): VM_OVERHEAD_MB comment ("R29 … until T20a") now sits in contracts where R29 means nothing
Task 1: complete (commits 500e203d..1d31d1ad, review clean)
Task 2: dispatched (implementer sonnet a67f3f9c, BASE 1d31d1ad, brief task-2-brief.md)
Task 2: implementer DONE c3342c37 (agent-vm unit 978 pass; eslint on agent-vm only, full lint over tool timeout)
Ruling: the `AlwaysOnHooks` export from modules/agent-vm/index.ts moves to T4, its first consumer — knip refuses an unused export — cost if wrong: none (T4 must add it).
Task 2: review dispatched (sonnet a173549c, package review-1d31d1ad..c3342c37.diff)
Task 2: review (sonnet) — Spec ✅, Approved, 0 C/I. ⚠️ index export deferred to T4 (ruling above); runtime-bed untouched (tests use runtime-fixtures.ts) — fine; full lint at the join.
Task 2: minor (deferred → carried to T4): a throwing `holds` hook propagates (onClosed before tearDown; idle timer callback) — T4's holds must never throw (try/catch → false)
Task 2: minor (deferred): runtime.always-on.test.ts:222 combines two refreshIdle cases, second half weak; :204 redundant spread
Task 2: complete (commits 1d31d1ad..c3342c37, review clean)
Task 3: dispatched (implementer sonnet a4593a87, BASE c3342c37, brief task-3-brief.md)
Task 3: implementer DONE ba640c5e (sessions unit 1731 + int 71 pass; full lint clean)
Task 3: review dispatched (sonnet a6c9b75d, package review-c3342c37..ba640c5e.diff)
Task 3: review (sonnet) — Spec ✅, Needs fixes: 1 Important (held=keep makes a kept session permanently busy → quietSince null → scan-port outside-write detection (ADR 0074) off for kept live sessions); minor: a throwing keep throws inside the timer. Fix round 1 dispatched to the implementer (FIX_BASE ba640c5e).
Task 3: fix round 1 DONE 882f0bba (keep via idle-release's own keep dep; held back to waiting; throw → false + warn); re-review dispatched (sonnet afe3cada)
Task 3: fix round 1/5 (2 addressed, 0 open — keep hid quietSince; throwing keep; commits ba640c5e..882f0bba)
Task 3: minor (deferred): the session_keep_worker_failed log line and its once-only rule are not asserted by a test
Task 3: complete (commits c3342c37..882f0bba, review clean after 1 fix round)
Task 4: dispatched (implementer sonnet a75f8bf3, BASE 882f0bba, brief task-4-brief.md; carried: AlwaysOnHooks export, holds/keep never throw)
Task 4: implementer DONE 8c649f61, 129de045 (7 unit + 4 int pass; daemon.ts 400 lines after inlining wsProbe/dispatch; int kills the guest via /proc environ + SIGKILL of its group, no source seam)
Task 4: review dispatched (sonnet a07c7ba7, package review-882f0bba..129de045.diff; named risks: /proc kill scope, daemon.ts inlining order, resume via exited)
Task 4: review (sonnet) — Spec ✅, Approved, 0 C/I; named risks clear (kill scan scoped to mkdtemp root + test ids; inlining order kept; resume once). ⚠️ daemon.ts = 400 lines (controller wc -l); start() runs after startServer resolved (server listening) — resolved.
Task 4: minor (deferred): no test for R6 (resume starts once) nor the `last`-map edge logic in compose-always-on.ts
Task 4: minor (deferred): compose-always-on.ts `last` seeded only at compose time (correct, needs a comment); int test memberId() declared after its use
Task 4: complete (commits 882f0bba..129de045, review clean)
Task 5: dispatched (implementer sonnet a97b241a, BASE 129de045, brief task-5-brief.md)
Task 5: implementer DONE 877608c8 (web 5579 pass; build+budgets 257.6/300 KB; pin beside Chip (no icon slot); setBox sends alwaysOn on every save)
Task 5: review dispatched (sonnet a08be421, package review-129de045..877608c8.diff; named risks: pin beside Chip, setBox alwaysOn every save, formatGb locale string)
Task 5: review (sonnet) — Spec ✅, Approved, 0 C/I; named risks clear (setBox every save: audit already unconditional, listener only on change; formatGb FR 1,5). ⚠️ no visual check — left to the final review / owner.
Task 5: minor (deferred): pin sits beside the Chip (no icon slot) — spec says chip with the pin; fix = Chip gains an optional icon prop
Task 5: minor (deferred): hint accepts a negative/fractional memory draft (Number.isFinite) — cosmetic, save refuses it
Task 5: minor (deferred): act() warning from setLocale in afterEach of the new tests (existing pattern)
Task 5: complete (commits 129de045..877608c8, review clean)
Join J1: full gate running in background (b67ntzlx0, log scratchpad/join-gate-ao.log, main unchanged so no rebase); final review dispatched (opus adab1a1d, package review-500e203d..877608c8.diff)
Join J1: gate stopped at the unit step (lint, format, build, typecheck, knip, budgets PASS at 877608c8) to let the final fix wave edit the worktree; full gate reruns after the wave
Final review (opus): With fixes — 0 Critical, 3 Important (I1 an edit saved while a kept worker is busy never reaches it: releaseIdle returns busy and the idle release never comes; I2 agent resources/package edits never apply to an always-on VM and agents-vm.md:241 describes a restart that does not exist; I3 pausing an always-on agent with a workerless VM never re-arms the idle stop), 6 Minor; deferred-minor triage: T4 R6/R4/pause-rearm unit test = fix before merge, rest leave.
Ruling: I1 — sessions gain `releaseWhenQuiet(ownerId, sessionId)` reusing createFolderRestart's waiting/"when their run is over" mechanism, called by applyToThread instead of releaseIdle — M11R47 must keep holding for kept workers — cost if wrong: a profile edit restarts a kept worker at its next quiet moment (kills processes the agent started, as any edit already did when quiet).
Ruling: I2 — no automatic VM restart: correct agents-vm.md (no resources edit restarts a VM; projects: RESTART; agents: STOP then START) and add one agent-form hint shown only when Always on is on: EN "Memory, CPU, disk and package changes apply at the box's next start: stop it, then start it from the Overview." / FR « Les changements de mémoire, de CPU, de disque et de paquets s'appliquent au prochain démarrage de la box : arrêtez-la puis redémarrez-la depuis la Vue d'ensemble. » — smallest honest fix, an auto-restart would kill running work — cost if wrong: one copy string the owner may reword, or a restart feature later.
Ruling: I3 — the compose-always-on listener compares held = alwaysOn && !paused before/after; true→false calls refreshIdle (+ touchIdle with a thread) — a paused agent's workerless VM must free its memory — cost if wrong: none.
Ruling: final minors taken in the wave: M1 keeper `closed` flag set by its closer (no start after shutdown begins), M2 overview listens to onAlwaysOnChange, M3 Project settings hint placement, M4 agents-vm.md pap-vmd phrase per spec §3.4, M5 int-test kill wrapped per pid, deferred T4 unit test (R6 resume once, R4 skips, pause re-arm), deferred T5 hint uses the memoryMb schema (safeParse) — each local and cheap — cost if wrong: one fix dispatch. Left: M6 (daemon.ts at 400, noted), pin beside chip (owner's visual check), the other deferred minors.
Final fix wave: dispatched (implementer sonnet abfc3687, BASE 877608c8, brief final-fix-brief.md)
Final fix wave: DONE e5691473, 54fb91d9, c1554dd9 (daemon related unit 3594, web 434, always-on int 4/4; added the stale project_box_always_on entry to daemon.migrations.test.ts; M2 untested, no compose-overview test file)
Final fix wave: re-review dispatched (sonnet a3966ea3); full join gate rerunning in background (brh71wtad) at c1554dd9
Final fix wave: re-review (sonnet) — 9/9 ADDRESSED (I1 I2 I3 M1 M2 M3 M4 M5 T5-hint), migration-test entry justified, no new C/I.
Final: minor (parked): releaseWhenQuiet tests assert the worker going cold, not the new profile at the next start
Final: minor (parked): a session idle but with an open dialog/panel/queue is released at its next idle event (inherited from restartFolder)
Final: minor (parked): compose-always-on.test.ts bed observes startOne through two microtask ticks (fragile if startOne gains awaits)
Join J1 (c1554dd9): lint, format, build, typecheck, knip, budgets, int (305 files), smoke PASS; unit 25610 passed, 4 failed = the 3 pre-existing push tests (fail on main too) + scripts/docs-truth.test.ts (agents-vm.md:238-239 `agents.onChange`, `projects.onAlwaysOnChange`, `auth.users`; web.md:489 `overview.size` read as RPC methods that do not exist)
Ruling: one tiny docs fix dispatch (sonnet) for the docs-truth names, checked by the controller with the docs-truth test + format:check (owner-approved tiny-fix controller check) — no scoped re-review — cost if wrong: a docs wording.
Join J1 docs fix: 9e41ac97 (docs-truth 10/10, format OK; controller check). Gate green except the 3 pre-existing push unit tests.
