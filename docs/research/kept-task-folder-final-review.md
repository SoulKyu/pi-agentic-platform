# Final review: a trigger's isolated task keeps its folder (285187e9..225838aa)

Reviewer: Opus, whole branch, read-only. Worktree `/home/ubuntu/Workspace/soulkyu/pap-kept-folder`, branch `feat/kept-task-folder`.
No test was run: every finding below is traced in the code, and none needed a run to settle.

## Strengths

- **pap-vmd path safety is tight.**
  - `keepKey` is a `TaskKey` in the contract (`vmd.ts:38`, `:67`) and again in `state.keptPath` (`TaskKey.parse`, agent boxes only, `state.ts:130-133`).
  - `disk.delete {keepKey}` needs `taskKey: null` and an agent box, and checks the folder with `lstat`.
  - `removeTaskDir` removes only `kept/<key>/`.
  - `growKeptDisk` opens the file with `O_NOFOLLOW` and checks `isFile`.
  - `mkfs` never runs on an existing kept disk, so R31 holds. Room is asked only when a disk is made.
  - A failed start removes only a disk it made itself (`diskMade`), and there is a test for it.
  - The sweep reads only `tasks/`, and a test proves it.
- **Two VMs never share one disk.**
  - `vm.start` and `disk.delete` both run under `locks.withBox`.
  - `keptHeld` checks three things: the in-memory map, `nerdctl ps`, and then the `/proc` fd scan, which fails closed. After a pap-vmd restart the empty map falls back to the fd scan. Cloud Hypervisor opens the file directly and there is no loop device (research note), so the scan sees it.
  - `vm.stop` cannot remove a kept disk: a kept start never makes `tasks/<taskKey>/`.
- **Strict schemas make version skew fail safe.** An old pap-vmd refuses a `disk.delete` that carries `keepKey` (`.strict()` at base). Without that, the same request would read as "purge the agent's whole folder".
- **The taint has one source.**
  - `keepKeyOfTask` gives both the key and `tainted: true` (`runner-agent.ts:118-120`), and the session gets its taint in the first init.
  - `currentSnapshot` drops the key and the forced taint together, so there is no kept disk without taint.
  - A thread can never carry a key: the contract refine refuses it, and `whoOf`/`keepKeyOf` give one only to task rows.
- **The 1 s idle stop never reaches the thread VM.**
  - It is chosen only when `spec.keepKey` is set (`runtime-start.ts:70`).
  - `runtime.link`, `touch` and `threadWorker` read the thread key only, so the agent-files `BoxOps` cannot reach a task VM.
  - agent-files' `startBox` passes `kind: "thread"` with no key.
- **Production wiring matches the int test.**
  - Kata sends `keepKey` (`kata-backend.ts:100`, tested).
  - pap-vmd's `conflict` becomes `PapError("conflict")` through `papErrorOf`, then the runtime, `vm-launch`, `createAgentSession` and `begin`, and ends in `keptBusy`. The process backend raises the same error, and the int test goes through that path.
  - `layoutOfSpec` and `vmLayoutOf` agree, and both are `/agent` under Kata.
  - `forgetKept` uses the Kata client only under Kata (`client: kata?.client ?? null`).
- **The docs are honest about the limits:** the hold ends before the VM is gone, the retries are in memory, and the forget gives up after 30 tries.

## Issues

### Critical

None.

### Important

**I1. A kept disk can silently outlive its trigger, through ordinary paths, and nothing can find it afterwards** (`automation/kept-folder.ts:41-69`, `agent-vm/kept-forget.ts:36-40`, `triggers.ts:361,370`).

The forget is one call, at the moment of the edit or the delete. These paths leave the disk behind:
- **(a) A run longer than the retry budget.** The owner deletes a kept trigger, or turns keep off, 5 minutes into a run with `maxRunMinutes` 60 (the max is 240). A `limited` wait also counts, since it holds the VM until the worker is released. The forget answers `busy` 30 times in 30 minutes, then logs `kept_forget_gave_up`. The run ends 25 minutes later, and the disk stays.
- **(b) A start already in flight.** Between the runner reading `currentSnapshot` (`runner-start.ts:40`) and pap-vmd taking the box lock for `vm.start` (gate, `vm-launch`, runtime `enter`), the trigger is deleted.
  - The forget finds no holder. It deletes the disk, or gets `not_found`, and answers `done`.
  - Then `vm.start {keepKey}` makes a new blank kept disk.
  - Nothing is logged, and the docs' "a forgotten disk is not made again by a queued task" is only true for queued tasks.
- **(c) pap-vmd unreachable.** For example, during `sudo pap vm setup` after an update. Any error other than `conflict` or `not_found` is logged once and answers `done`, with no retry.
- **(d) A daemon restart inside a retry window.** This one is documented.

What follows from any of these:
- **Nothing can find or remove the disk.** Nothing lists `kept/` (pap-vmd has no op for it, and doctor has no check). The only way to remove the disk is to delete the agent, which also destroys its thread disk.
- **Re-enabling brings the old content back.** In the keep-off case, turning keep on again reuses whatever was left. That contradicts plan Review Focus 2, "the next run of a re-enabled trigger starts blank", and the spec's anti-goal "a kept disk that outlives its trigger".
- **It costs disk space.** The disk is up to `diskMb` (4 GiB by default), sparse, and it grows with use, on a host whose disk was at 94 %.

Fix (small): reconcile at the end of the task. In `createAgentStart.ended` (`runner-agent.ts:273`), take a row whose snapshot had `keep`. If its trigger is gone, or no longer keeps that agent's folder (`keeperOf(current) !== row.agent_id`), call the forgetter.

That covers (a) and (b). It also covers (c) and (d) whenever a run of that trigger ends later, and the boot's `replay` of interrupted tasks calls `ended` too. Also, do not spend retries while a task of that trigger is starting, running or `limited`.

**I2. A kept run that resumes after a usage limit continues on a blank, throwaway disk** (`sessions/vm-launch.ts:114-115`, `sessions/store.ts:22`, K-R5).

`keepKey` rides only on the in-memory row that `createAgentSession` launches. Every later relaunch reads the stored row, which has no `task`, so it gets no key.

This hits the owner's own case: CyberNews on the Claude subscription through claude-bridge, which does hit usage limits.
1. A kept run goes `limited` mid-run.
2. Its session goes quiet, and the worker is released after `PAP_WORKER_IDLE_MINUTES` (only lanes hold a worker: `held` in `service-launch.ts:258`).
3. The kept VM stops 1 s later.
4. Hours later the automatic resume calls `ensureLive(storedRow)`. The VM starts as a plain isolated task on `tasks/<taskKey>/`, a blank disk. The init has no `kept`, so the prompt says "a blank disk that is deleted when the task ends".
5. The resumed run cannot see the files it wrote before the limit, and everything it writes afterwards is deleted at its VM stop.
6. Meanwhile, the trigger's other runs were held for the whole `limited` time (`kept-wait.ts:26`), to protect a disk this run never touches again.
7. The result is a lost delta and duplicate items reported by the next run. The taint still holds, because `session_policy` is persisted.

K-R5 and `automation.md:75` speak of "a reopened task session". That reads as the owner reopening a finished session, not as the automatic resume of a task that is still running.

Fix, either one:
- **Derive the key at relaunch.** When a task session with a running or `limited` automation task relaunches, and the task's snapshot has `keep` and its trigger still keeps that agent's folder, the key is `keptKeyOf(trigger_id)`. It is derivable, so nothing needs storing. This could be a sessions-side lookup through the automation port.
- **Or rule it a known limit**, and name the limited resume in `automation.md`.

### Minor

- **M1. The new VM prompt line says "Your thread reads what you leave there as external content"** (`packages/pi-host/src/agent-prompt.ts:36`). That was true in host mode. In a VM it is false for a plain task (its disk is deleted) and for a kept task (the thread never mounts it). Drop that sentence for the VM branch.
- **M2. The editor contradicts the new switch.** It sits next to two older lines that are still host-mode copy (`i18n/catalog/automation-agents.ts`):
  - the target line "in a fresh session in {name}'s home";
  - the dry-run's "home read-only, writes in a scratch folder".

  Nothing says that turning the switch off, or changing the agent or the target, deletes the folder for good. There is no confirmation, and the action cannot be undone.
- **M3. In a burst, almost every second run makes a launch that is refused.** The hold ends when the task row ends, and the VM goes 1 s later plus its stop. The next start reaches pap-vmd and gets `conflict`. Each such attempt costs:
  - a token, the scratch folder made and dropped, the gate, and the `vm.start` round trip;
  - a cleanup `vm.stop` that takes the start lock for the netns sweep;
  - a failed launch record `conflict` and a `warn` `kept_disk_busy`;
  - about 30 s of delay.

  Either hold while the previous task's VM entry still exists, or log at info.
- **M4. The forgetter dedups by trigger id only** (`kept-folder.ts:67`). The owner moves a trigger A→B (A's forget is busy and retries), B runs, then the owner moves it back to A within 60 s. B's forget is skipped because `pending` has the id, and A's retry stops because the trigger keeps A again. B's disk is orphaned.
- **M5. The retry timer is not guarded** (`kept-folder.ts:49`). `current()` is a DB read inside a raw Clock callback. If it throws after `db.close()` at shutdown, nothing catches it (the daemon has no `uncaughtException` handler). Use `guardTimer` as the other timers do. The timers are also not cleared at stop (parked).
- **M6. Rollback.** After `pap update rollback`, the old daemon's strict `TriggerAgent` reads every kept trigger as `unreadable`, and its strict `TaskPolicySnapshot` fails queued kept tasks with `bad_policy`. Worth one line in `update.md` or `automation.md`.
- **M7. A doc line is slightly off** (`automation.md:71`). It says "an empty `/agent/home`, `knowledge` and `inbox`", but the guest seeds `knowledge/index.md` and `log.md` at every start (`agents-vm.md`).
- **M8. A test assertion is vacuous** (`apps/vmd/src/ops-kept.test.ts`, "removes kept/<keepKey>/"): `expect(existsSync(a) || existsSync(dir)).toBe(existsSync(dir))`. Parked by K1's review.
- **M9. Defence in depth before the rebase** (`runtime-start.ts:70`). `KEPT_IDLE_MS` is chosen on `spec.keepKey` alone. Guard it with `spec.kind === "isolated"` too. Agent-files adds a new caller of `runtime.start`, and a thread spec that ever carried a key would get a 1 s idle stop.

## Notes for the rebase onto agent-files

- **The 1 s stop and the kept disk cannot reach the thread VM** (see Strengths). The textual conflicts are the `forgetKept` field in `compose-agents-vm.ts` and `-types.ts`, and the export line in `agent-vm/index.ts`.
- **One issue belongs to agent-files, not this branch.** Its `createAgentStart` returns early when `runtime.phase(box) === "running"`, but `phase()` falls back to any entry of the box (`runtime.ts:294-297`). While a task VM of the agent runs and the thread VM is stopped, `startBox` does nothing and the explorer answers `box_stopped`.
  - Kept VMs make this window short (1 s).
  - Plain task VMs keep it open for `PAP_WORKER_IDLE_MINUTES` after their worker leaves.
  - Check the thread entry's own phase there.

## Declined to judge

- **Real Kata behaviour.** The `/proc` scan seeing Cloud Hypervisor's fd, and grow plus `resize2fs` on a kept disk. Kata tests were not run, by rule. This relies on `docs/research/agents-vm-risk-checks.md`.
- **Launches UI.** Whether a refused task launch (`conflict`, `for: <session id>`) is visible in the launches UI.
- **Member deletion.** Whether deleting a member removes their agents, and so their kept disks; the owner cascade deletes triggers without a forget.
- **`/proc` scan cost** per kept start on a busy host.
- **Which VM a child of an isolated task runs in.** This predates the branch and is out of scope.

## Verdict

**Ready after fixes.** Fix I1 and I2, or have the owner rule them known limits and say so in the docs. 0 Critical, 2 Important, 9 Minor.
