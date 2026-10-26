# SDD ledger — plan: docs/plans/2026-10-26-kept-task-folder.md

Worktree /home/ubuntu/Workspace/soulkyu/pap-kept-folder, branch feat/kept-task-folder, base 285187e9. Parallel lane with agent-files (shared flock). Merge order: agent-files first.
Pre-dispatch scan: K1 produces vmd request shapes (keepKey) consumed by K2 kata backend; K2 produces TriggerAgent.keep consumed by K3 web. Overlap with agent-files: docs/agents/agents-vm.md (both edit; rebase conflict expected, trivial), modules/agent-vm/index.ts (exports). No conflicts in plan text. Rulings K-R1..K-R5 in the plan.
K1 DONE 7d1b1a6e. Incident: implementer ran vitest on apps/vmd which pulled the kata project (EADDRINUSE on 10.213.0.1:7841); pap-vmd journal shows only vmd.health/image.list in the window, no vm.start/stop: no harm. Rule added to implementer-common (both plans).
Review package: wrote /home/ubuntu/Workspace/soulkyu/pap-kept-folder/.superpowers/sdd/2026-10-26-kept-task-folder/review-285187e9..7d1b1a6e.diff: 1 commit(s), 33765 bytes
K1 review: Approved, 0C/0I/3M (vacuous assertion in ops-kept.test.ts disk.delete; no test after vmd restart; growKeptDisk raw errno; kept disks never reclaimed). Minors parked for the sweep.
Task K1: complete (7d1b1a6e)
K2 dispatched, BASE 7d1b1a6e.
K2 DONE 13075fc0. Rulings by implementer: wait in admission (held while same trigger starting/running/limited, 30s look); kept reaches prompt via VmInit.kept (old bundle refuses init -> vm_bundle_stale); delete during a run leaves disk (conflict logged, goes with agent). automation index.ts and triggers.ts at 400 lines. Review package: wrote /home/ubuntu/Workspace/soulkyu/pap-kept-folder/.superpowers/sdd/2026-10-26-kept-task-folder/review-7d1b1a6e..13075fc0.diff: 1 commit(s), 108197 bytes
K2 review: Needs fixes 0C/2I/4M. Rulings: I1 kept start refused conflict -> putOff 30s, not an attempt, process backend refuses a live keepKey root too (cost if wrong: a stuck held disk defers forever, logged). I2 K-R2 amended: a queued kept task whose trigger is gone/no longer keeps/changed agent or target runs without keepKey; a forget answered conflict retried every 60s on the Clock, max 30 tries, in memory (restart drops them: documented orphan until agent delete). Fix round 1 dispatched (resume).
K2 fix round 1 38231b25. Implementer extra: a kept task VM stops 1 s after its worker leaves (instead of PAP_WORKER_IDLE_MINUTES) — accepted pending re-review (frees RAM, lets the next run attach). Board shows the held-disk wait as "Waiting for a session slot" (parked minor). Scoped re-review: wrote /home/ubuntu/Workspace/soulkyu/pap-kept-folder/.superpowers/sdd/2026-10-26-kept-task-folder/review-13075fc0..38231b25.diff: 1 commit(s), 70300 bytes
K2 re-review Approved (minors: retry timers not cleared at shutdown (unref, safe); 1 s window after worker leaves untested for post-run guest work). Parked.
Task K2: complete (13075fc0, 38231b25)
K3 dispatched, BASE 38231b25.
K3 DONE 225838aa. Review package: wrote /home/ubuntu/Workspace/soulkyu/pap-kept-folder/.superpowers/sdd/2026-10-26-kept-task-folder/review-38231b25..225838aa.diff: 1 commit(s), 22032 bytes
K3 review Approved 0C/0I/2M.
Task K3: complete (225838aa)
Owner (2026-10-26): pre-approved `sudo pap vm setup` after both merges ("Tu auras mon accord donc ne m'attends pas") — this run only.
Final review (Opus) dispatched on 285187e9..225838aa (pre-rebase; rebase onto agent-files conflicts only in compose-agents-vm.ts / -types.ts wiring, checked after).
Final review (Opus): Ready after fixes 0C/2I/9M. Rulings: I1 at every kept task end, forget the disk when the trigger is gone / no longer keeps / keeps another agent or target (same 60 s x30 retry; a pap-vmd failure retried like busy); daemon restart during retries = documented limit. I2 re-derive keepKey at every spawn of a kept task session (relaunch after a limit/idle release) from its task's trigger if it still keeps that agent's folder (isolated target). Minors in the same dispatch: M1 M2 (copy: host-mode lines fixed; switch help says turning it off deletes the folder; no confirm dialog) M3 (kept_disk_busy at info, no hold change) M4 (dedup by trigger+agent) M5 (guardTimer) M6 (rollback line) M7 M8 M9.
Final fix dispatched (Sonnet), BASE 225838aa.
Final fix DONE d9b0c0af (snapshot carries keepTrigger since trigger_id nulls on delete; SessionRow.keptKey unstored; tests after code, mutation-proven). Scoped re-review dispatched.
Rebased (squash) onto 5946e97a, conflicts in compose-agents-vm.ts/-types.ts (both fields kept). Gate: lint, format:check, typecheck, knip, vitest related unit+integration 1996 files / 20233 tests pass. Merged to main as 6e2efb6a.
