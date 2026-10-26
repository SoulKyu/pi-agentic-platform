# A trigger's isolated task keeps its folder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (lightened, owner-approved). Steps use checkbox (`- [ ]`) syntax.

**Goal:** a trigger's isolated agent task can keep its VM disk between runs: opt-in, one run at a time, every run tainted.

**Architecture:**
- A trigger's `keep` flag travels in the task's policy snapshot.
- The runner gives the task session a `keepKey`, which is the trigger id with no dashes. `vm-launch` puts it on the `VmSpec`.
- Kata sends it to pap-vmd. pap-vmd makes the disk in `kept/<key>/`, reuses it on later runs, and does not delete it when the VM stops.
- The process backend roots the task layout at the key.

**Spec:** `docs/specs/2026-10-26-kept-task-folder-design.md` (decision 137).

## Execution (owner: "Go planifier et lancer B", 2026-10-26)

- **Models:**

  | Step | Model |
  |---|---|
  | K1 · pap-vmd: kept disks | Sonnet |
  | K2 · daemon: flag, snapshot, wait, taint, key to the VM, forget, int test | Sonnet |
  | K3 · web: the editor switch, docs | Sonnet |
  | Each task review | Sonnet |
  | Final whole-branch review | Opus |
- **Worktree:** `/home/ubuntu/Workspace/soulkyu/pap-kept-folder`, branch `feat/kept-task-folder`.
- **Second lane:** this plan runs in parallel with the agent-files plan. Heavy commands are serialized by the shared flock.
- **Merge order:** agent-files first, then this one, rebased on top.

## Global Constraints

- **AGENTS.md rules** (400 lines per file, module imports, erasable TS, the only ESLint directive form, UI tokens, DESIGN.md).
  - `apps/vmd` imports only `@pap/contracts` and Node built-ins.
- **Tests:**
  - Never the real pap-vmd, `/opt/pap-vm`, `/var/lib/pap-vm`, `10.213.0.1`, `~/.pap`, `~/.pi/agent` or `~/.claude`.
  - vmd tests use their fake exec and a temp state root.
  - Daemon tests use the process backend.
  - Timers go through the Clock. No sleeps.
- **Memory:**
  - One test command at a time, with `--maxWorkers=2`, under `flock /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/heavy-gate.lock`.
  - Shim: `export PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/bin:$PATH`.
- **Commits:** Conventional Commits, English, no AI attribution line.
- **The keep key:**
  - `keepKey = triggerId.replaceAll("-", "")`, which must parse as `TaskKey` (`/^[0-9a-f]{32}$/`).
  - `keepKey` goes only with an isolated agent VM (`taskKey !== null`).
- **Copy:**
  - EN: "Keep its folder between runs" / "Each run finds what the previous one left. Every run starts as untrusted."
  - FR: « Garder son dossier entre les runs » / « Chaque run retrouve ce que le précédent a laissé. Chaque run démarre comme non fiable. »

## Rulings made while planning

- **K-R1 · Disk folder.** pap-vmd keeps the disk in `agents/<id>/kept/<keepKey>/`, beside `tasks/`. The daily sweep only reads `tasks/`, so it never touches it.
- **K-R2 · Snapshot.** `keep` is in the task's `TaskPolicySnapshot`, taken at fire time. A later edit of the trigger never changes a queued task (M10R37).
- **K-R3 · Taint.** A kept run is always `tainted: true` at start.
- **K-R4 · No protocol bump.** An old pap-vmd answers `bad_request` to a `keepKey` (its schema is strict). The task fails with that code, and the docs say to run `sudo pap vm setup`.
- **K-R5 · Session row.** `keepKey` lives on the new task session's `task` policy, which is never read back from the store.
  - A reopened task session later starts on a blank disk, as today. This is a documented known limit.

## Review Focus

1. **Two fires of the same kept trigger at once** (a feed with 3 new entries). The runs go one after the other, never two VMs on one disk.
2. **A kept trigger switched off, deleted, or moved to another agent.** Its disk is deleted, and the next run of a re-enabled trigger starts blank.
3. **A schedule trigger with a kept folder.** It starts tainted even though its source is not outside text.
4. **A pap-vmd stop of a kept task VM.** The disk stays, while a plain task's `tasks/<key>/` still goes.
5. **The agent's disk size grows.** The kept disk grows at its next start, and never shrinks.

---

### Task K1: pap-vmd keeps a trigger's disk

**Files:**
- Modify:
  - `packages/contracts/src/vmd.ts`: `vm.start` gets `keepKey: TaskKey.nullable().optional()`, refined to only go with `kind: "isolated"`. `disk.delete` gets `keepKey: TaskKey.optional()`; with it, `taskKey` must be null.
  - `apps/vmd/src/state.ts`: `keptPath(box, keepKey)` → `agents/<id>/kept/<keepKey>/disk.img`.
  - `apps/vmd/src/ops-vm.ts`: start and stop.
  - `apps/vmd/src/ops-disk.ts`: delete.
  - `apps/vmd/src/server.ts`, only if it logs or routes by field.
- Test: beside `ops-vm.test.ts`, `ops-vm-stop.test.ts`, `ops-disk.test.ts`, `state.test.ts`, and the contracts `vmd` test.

**Interfaces:**
- **Produces, request shapes:** `{ op: "vm.start", …, taskKey, keepKey?: string | null }` and `{ op: "disk.delete", box, taskKey: null, keepKey, purge }`.
- **Start with `keepKey`:**
  - a missing disk is made with `makeBlankDisk` at `resources.diskMb`;
  - an existing one smaller than `diskMb` is grown with `ftruncate` up, as `disk.grow` does;
  - `deps.room` is checked only when the disk is made;
  - a disk another live VM holds → `conflict`.
- **Stop with a `keepKey` start:** the kept folder is never removed. The VM must remember that it was kept: record it with the VM (the env file, or the state the stop reads), so a stop that names only `taskKey` knows. Choose one and test it.
- **`disk.delete` with `keepKey`:**
  - removes `kept/<keepKey>/`;
  - a live VM holds it → `conflict`;
  - a missing folder → `not_found`.

**Steps:**
- [ ] **Tests (RED first):**
  - The first kept start makes the disk (mkfs argv seen). A second start after a stop reuses it (no mkfs) and the file is still there.
  - A start with a larger `diskMb` grows the file.
  - Stopping a kept VM leaves `kept/<key>/disk.img`. Stopping a plain task VM still removes `tasks/<key>/`.
  - A kept start while the same key is attached to a live VM → `conflict`.
  - The daily sweep leaves `kept/`.
  - `disk.delete {keepKey}` removes the folder; while the disk is held → `conflict`.
  - Contracts:
    - `keepKey` with `kind: "thread"` is refused;
    - a `keepKey` that is not 32 hex is refused;
    - `disk.delete` with both `taskKey` and `keepKey` is refused.
- [ ] Implement, test passes, then the gate (`vitest related`, lint, typecheck, knip).
- [ ] Commit: `feat(vmd): a trigger's isolated task can keep its disk between runs`.

### Task K2: The daemon carries the key, waits, taints, forgets

**Files:**
- Modify:
  - **contracts:** `packages/contracts/src/automation.ts` (`TriggerAgent` gets `keep: z.boolean().optional()`; the refine refuses `keep: true` with `target: "thread"`).
  - **automation:**
    - `modules/automation/tasks.ts` (`TaskPolicySnapshot` gets `keep: z.boolean().optional()`) and the fire path that takes the snapshot;
    - `modules/automation/runner-agent.ts` (`begin`);
    - the admission or runner wait (builder's choice, spec §4);
    - `modules/automation/triggers.ts` (forget on remove, turned off, agent or target change).
  - **sessions:**
    - `modules/sessions/agent-port.ts` (`createAgentSession`'s `task` takes `keepKey?: string`);
    - the row's `task` policy type;
    - `modules/sessions/vm-launch.ts` (`whoOf` puts `keepKey` on the spec);
    - the isolated task's prompt line in `packages/pi-host/src/agent-prompt.ts`, which needs to know (pass a flag through the init the task gets).
  - **agent-vm:**
    - `modules/agent-vm/runtime.ts` (`VmSpec.keepKey?: string | null`);
    - `kata-backend.ts` (sends `keepKey`);
    - `process-backend.ts` and `layouts.ts` (a kept task's process root is `processRootOf(papHome, {agentId, taskKey: keepKey})`; the runtime's `deps.layout(spec)` must agree);
    - a `forgetKept(agentId, keepKey)` on the agent-vm side, through `vmd-client` (`disk.delete {keepKey}`) under Kata, and a folder removal under the process backend, exposed to automation by its port.
- Create: `apps/daemon/src/modules/automation/kept-folder.int.test.ts` (process backend, scripted provider).
- Docs: `docs/agents/automation.md` (Targets, plus the stale VM-mode line about the "read-only home" and the `.runs/` scratch, rewritten to what a VM run gets) and `docs/agents/agents-vm.md` ("Disks": `kept/`).

**Interfaces:**
- **Consumes:** K1's request shapes.
- **Produces:** `VmSpec.keepKey`; the automation port `forgetKept(ownerId, agentId, triggerId): Promise<void>`, which logs and never throws.

**Steps:**
- [ ] **Unit tests (RED first):**
  - Contracts: `keep` with `target: "thread"` is refused; `keep` with isolated is accepted; an absent `keep` reads as off.
  - `begin` with `keep`:
    - the session gets `keepKey = triggerId without dashes` and `tainted: true`;
    - without `keep`: no key, and taint as today.
  - **Wait:** a second queued task of the same kept trigger is not started while the first is starting or running, and starts after it ends. A task of another trigger is not held.
  - `whoOf` and the spec: `keepKey` only for `agentRole: "task"` rows with the policy key.
  - Kata backend: the `vm.start` request carries `keepKey`; a plain task's has none.
  - **Forget:** `triggers.remove`, an update that turns `keep` off, and an update that changes the agent or the target each call `forgetKept` once, for the old agent and key. A plain update does not.
- [ ] **Int test (process backend):**
  - a schedule trigger, isolated, with `keep: true`;
  - run 1's scripted provider writes `home/state.txt`;
  - run 2 reads it back: the scripted provider asserts it, or the test checks the file in the process root;
  - a second trigger without `keep` does not see it;
  - delete the kept trigger → its process root is gone.
- [ ] Implement, test passes, then the gate (`vitest related` unit and int on the changed files, lint, typecheck, knip).
- [ ] Commit: `feat(automation): a trigger's isolated task can keep its folder between runs`.

### Task K3: Web: the switch in the trigger editor

**Files:**
- Modify: `apps/web/src/features/automation/RunsAsField.tsx` (or the target block beside it), `apps/web/src/features/automation/editor.vm.ts` (draft field, send `keep` only with an isolated agent target), the catalogs (`automation-trigger.ts` or `automation-agents.ts`, EN and FR).
- Test: beside the editor's tests (`RunsAsField`/`editor.vm` tests).

**Steps:**
- [ ] **Tests (RED first):**
  - The switch shows only for an agent with "Isolated task" (for a feed, which forces isolated, it shows).
  - Toggling it sends `execution.agent.keep: true`. Switching to Thread drops it.
  - An existing trigger with `keep` shows it on.
  - EN and FR copy are exact.
- [ ] Implement, test passes, then the gate (lint, typecheck, `vitest related`, `pnpm build`).
- [ ] Commit: `feat(web): the trigger editor's "Keep its folder between runs" switch`.
