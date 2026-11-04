# Always-on boxes final whole-branch review (J2)

Opus, read-only, range `500e203d..877608c8`. Its three Important findings and six Minor ones were fixed in one wave (`e5691473..c1554dd9`); a scoped Sonnet re-review found 9/9 addressed (`always-on-sdd-ledger.md`).


I read the whole package, the spec, the plan and the ledger, and checked the risky paths in the worktree source. I ran no tests, as you asked.

### Strengths
- **Storage stays out of pap-vmd's wire schema.** The setting sits beside `AgentResources`, so the vmd wire schema and `RuntimeSpec` are untouched. The profile field defaults to false, so old profiles need no migration. The project migration only adds a column (`always_on INTEGER NOT NULL DEFAULT 0`), and old code that inserts rows still works after a rollback.
- **The runtime change is small and exact.** `holds` applies only to thread entries; isolated and kept task VMs never take it. The crash rule becomes `hadWorkers || alwaysOnThread`. `exited` runs only after `tearDown`, and is skipped for a paused or closed box. A throwing hook is caught.
- **Nothing that is asked restarts a box.** STOP, disable, delete, quarantine and shutdown all go through `isStopping` (tearDown sets `stopping` synchronously) or `close`. A disable writes the disabled flag before it stops anything (`users/service.ts:120-124`). So none of these produces an `exited` call or a crash record.
- **Review Focus 1 to 5 hold in the code.** The loop is bounded by RT-40. A refused start is logged once, the next box still starts, and nothing retries. Turning the switch off arms the waits from now. A model edit still calls `releaseIdle`. A boot refusal does not block the other boxes.
- **R6 works.** The resume path writes the store, which fires `notify`, which calls `exited`. `startAgent` then awaits the gate before `runtime.start`, and `pause()` calls `runtime.resume` synchronously before that await completes. So the start passes. It depends on that ordering, but it works.
- **The T3 fix is right.** `keep` is its own idle-release dependency, separate from `held`, so `quietSince` keeps working for ADR 0074.
- **The keeper is safe.** It never throws, logs a failure once, boots one box at a time, and `start()` runs after the server listens, after `bindLate` and after RT-42.
- **The rest is sound.** The int test drives real daemon restarts on the process backend, and its `/proc` kill is limited to the test's own temp root. The FR/EN copy matches spec §4 word for word, with tests on the catalog. The `Switch` primitive is used unchanged. Every code file is at or under 400 lines (`daemon.ts` is exactly 400).

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)

1. **An edit saved while the always-on agent is busy never reaches its worker.**
   - Where: `modules/agents/service.ts:145` (`applyToThread`) with `modules/sessions/restart-folder.ts` (`releaseIdle`).
   - What happens: M11R47 says an edit applies at the worker's next start. `releaseIdle` returns `busy` and leaves the worker alone when a run, dialog, panel or queue is open, and nothing retries later. Until now, the 30-minute idle release then let the edit apply. With `keep`, that release never comes. A role, preset, mode, denylist or trusted-sources change saved during a turn stays unapplied until STOP, a pap restart or a VM crash. The form still shows the new profile.
   - Why it matters: W5-R26 says a running worker keeps the profile it started with, so a tightened policy silently never applies. This is exactly M11R47's "cost if wrong", and one of the risk areas you named.
   - Fix: add a sessions method `releaseWhenQuiet(ownerId, sessionId)` that reuses `createFolderRestart`'s `waiting`/`published` mechanism ("the others when their run is over"). Call it from `applyToThread` instead of `releaseIdle`. An alternative: make `keep` return false for a thread edited since its worker started, cleared when the worker goes cold. Add a test: edit while busy, the run ends, the worker is released.

2. **Resources and package edits on an always-on agent never apply, and the new docs say otherwise.**
   - Where: `docs/agents/agents-vm.md:241` and spec §3.5.
   - What happens: no agent edit restarts the VM. `agents.update` only calls `releaseIdle`, and agents have no restart path (see the comment in `agent-start.ts`). Until now, new memory, CPUs, disk or packages applied after the next idle stop. For an always-on agent that stop never comes; only STOP then START, or a pap restart, applies them. No copy says so.
   - The docs line "STOP and a resources edit that restarts the VM leave it stopped" describes something that does not exist, for agents or for projects. Projects are fine in practice: their settings say "They apply at the next start of the box" and offer RESTART.
   - Fix: at least correct the docs line. Then ask the owner whether the agent form needs a hint, or whether `holds` should drop when the running VM's resources or image differ from the profile, so the VM idles out once it has no worker.

3. **An always-on agent that is paused while its VM has no worker never stops.**
   - Where: `compose-always-on.ts:106-111`.
   - What happens: `createIdleStop` does not re-arm after a held firing. R4 makes `holds` false for a paused agent, but the listener only re-arms on `alwaysOn` going from on to off. Pausing never stops the VM: it only refreshes the relay policy (`compose-agents-vm-late.ts:279`). So a workerless VM of a paused agent keeps `memoryMb + 512` reserved until RESUME, STOP or a pap restart.
   - Why it is common: every always-on agent is workerless right after a pap start.
   - Fix: in the listener, compare `held = alwaysOn && !paused` before and after the change, and call `runtime.refreshIdle(box)` (plus `touchIdle` when there is a thread) when it goes from true to false. Add a unit test.

#### Minor (Nice to Have)
1. **Starts keep going during shutdown.** `modules/agent-vm/always-on.ts:47-53`: `bootStart` keeps starting boxes, and `exited` keeps restarting them, after the daemon has begun to stop. The `always_on` closer runs before `agent_vm`'s `stopAll` (closers close in reverse order), but it only unsubscribes. A start that lands after `stopAll` leaves a VM running until the next boot's RT-42. Fix: a `closed` flag in the keeper, set by the `always_on` closer and checked in the loop and in `exited`.
2. **A project's chip goes stale.** Turning a project's switch on or off does not tick the Overview: `setBox` never calls `deps.changed` (`box-service.ts:226`), and the Overview only listens to `projects.port.onChange` (`compose-overview.ts:158`). A running project's card misses the chip change until another event arrives. Fix: subscribe `projects.port.onAlwaysOnChange(tell)`.
3. **A hint now seems to cover the switch.** `ProjectSettings.tsx:169`: "They apply at the next start of the box." now sits right under a fieldset that ends with the switch, which applies at once. Move the hint, or make the visual separation clear.
4. **One docs phrase contradicts the spec.** `agents-vm.md:240` says "(not a STOP, not a pap-vmd restart that `isStopping` knows)". Spec §3.4 says a pap-vmd restart counts as an unasked exit. Reword.
5. **The int test's kill can throw.** `compose-always-on.int.test.ts:78`: `process.kill(-pid)` throws ESRCH when a matched pid does not lead its own process group, for example a guest child that inherits `PAP_BOX`. Wrap each kill in a try, or kill only group leaders.
6. **`daemon.ts` is at exactly 400 lines.** The next lot that touches it must move code out first.

### Deferred minors triage
- T1, `setBox` reads `record.alwaysOn` before the write: leave.
- T1, the R29/T20a comment on `VM_OVERHEAD_MB` now in contracts: leave.
- T2, a throwing `holds` hook propagates: leave. `keeper.holds` never throws, so this is resolved.
- T2, `runtime.always-on.test.ts:222` combines two cases and `:204` has a redundant spread: leave.
- T3, `session_keep_worker_failed` and its once-only rule are not asserted: leave.
- T4, no test for R6 or the `last`-map logic: **fix before merge.** Spec §6 requires "RESUME starts it" and "a paused and a quarantined box are skipped". Add one `compose-always-on` unit test with fakes covering R6, the R4 skips, and the pause re-arm from Important 3.
- T4, the comment on `last` seeding and `memberId()` declared after use: leave.
- T5, the pin sits beside the chip instead of inside it: leave for the owner's visual check. If they want it inside, `Chip` gains an `icon` prop.
- T5, the hint accepts a negative or fractional memory draft: leave. If a fix round runs anyway, use the one-line `Bounds.shape.memoryMb.safeParse` check, which matches spec §4's "invalid".
- T5, the act() warning from `setLocale` in afterEach: leave.

### Declined to judge
- A model or thinking edit still releases a quiet always-on worker and kills the processes the agent started. Plan R7 and Review Focus 4 chose to keep M11R47 as is.
- After a host reboot, pap may start before pap-vmd, and the always-on boxes stay down with no retry. Spec §3.3 point 3 is an explicit builder call.
- pap-vmd restarts count as crashes, so three `sudo pap vm setup` runs in 10 minutes pause an always-on agent, and an agent's pause is persisted. Spec §3.4 says so.
- Exits spaced more than about 3.3 minutes apart restart without limit. That is RT-40's rule, and the spec keeps it.
- Always-on workers, a member's included, can fill every `PAP_MAX_WORKERS` slot. Spec §3.6 accepts this ceiling.
- Stopping an always-on box that is not busy shows no dialog, so the person never sees the comes-back-at-pap-start line. The spec puts that line in the dialog only.
- A re-enabled member's always-on boxes wait for the next message or pap start. That is consistent with R8, and the spec says nothing on it.
- An old cached web bundle that saves an agent without `alwaysOn` resets it to false through the zod default. Version skew is outside this lot.
- "réservés" in the FR hint is the owner's verbatim copy.
- R3 replaces "creation time" with the stores' order. That ruling was approved.
- Box projects' session workers are not kept. Spec §3.2 is a builder call.
- `docs/agents/web.md` is 490 lines. It was already over 400 before this lot, and it is a docs file.

### Recommendations
- The three Important fixes are small and fit in one Sonnet fix round: a sessions `releaseWhenQuiet` plus one call in `applyToThread`; the `held` comparison in the `compose-always-on` listener; and the docs correction, with an owner question on agent resource edits. Add the `compose-always-on` unit test (R6, R4 skips, pause re-arm) in the same round. Minor 1 and 2 are a few lines each and can ride along.
- The owner should check visually on the preview: the pin beside the chip, and the hint sitting under the switch in Project settings.

### Assessment
**Ready to merge?** With fixes.
**Reasoning:** The design and the loop and stop safety are sound, and every Review Focus item holds. But always-on silently breaks M11R47: edits saved during a busy turn, and agent resource edits, never apply. A paused always-on agent's workerless VM also holds its memory with no end. All three fixes are small and contained.

Key files: `/home/ubuntu/Workspace/soulkyu/pap-always-on/apps/daemon/src/compose-always-on.ts`, `/home/ubuntu/Workspace/soulkyu/pap-always-on/apps/daemon/src/modules/agents/service.ts`, `/home/ubuntu/Workspace/soulkyu/pap-always-on/apps/daemon/src/modules/sessions/restart-folder.ts`, `/home/ubuntu/Workspace/soulkyu/pap-always-on/apps/daemon/src/modules/agent-vm/always-on.ts`, `/home/ubuntu/Workspace/soulkyu/pap-always-on/docs/agents/agents-vm.md`.
