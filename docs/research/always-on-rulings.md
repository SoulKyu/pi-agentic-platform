# Always-on boxes rulings

Plan rulings R1 to R10 (binding at dispatch). Pre-flight (P1, P2) and execution rulings (I1 to I3, the final minors, the docs fix) are the `Ruling:` lines of `always-on-sdd-ledger.md`.


- **R1 · Storage.**
  - **Agents:** `AgentInput` gains `alwaysOn: z.boolean().default(false)`. The profile is JSON, so a stored profile without the field reads false and needs no migration.
  - **Projects:** a migration `modules/projects/migrations/202611041200_project_box_always_on.sql` adds `always_on INTEGER NOT NULL DEFAULT 0` to `project_boxes`.
  - Neither touches `AgentResources`, which is pap-vmd's wire schema.
  - Cost if wrong: a migration that has already shipped cannot be renamed.
- **R2 · Predicates are read live, and only switching off needs a call.**
  - The runtime asks `holds(box)` when an idle timer fires. Sessions ask `keep(ownerId, sessionId)` each time the idle check runs; a kept session counts as busy.
  - Switching on therefore needs no call.
  - Switching off calls `runtime.refreshIdle(box)` (the VM wait starts now when it has no worker) and `sessions.touchIdle(ownerId, threadSessionId)` (the worker's wait starts now).
  - Ceiling: `holds` and `keep` scan the owner's agents on every call. They are called rarely (on a timer firing, an exit or an idle check). Upgrade path: a set kept up to date by `onChange`.
- **R3 · Boot order.** The owner's boxes go first, then each member's in `auth.users` order. Within one user: agents in `agents.list` order, then projects in `ownerBoxes` order.
  - This replaces the spec's "then by creation time": the stores' own order.
  - Cost if wrong: which box loses when memory is short.
- **R4 · What the keeper skips before starting**, rather than letting the start refuse and log:
  - a disabled owner (`auth.isDisabled`);
  - an agent that is `paused`, has `quarantinedAt` set, or has an unreadable profile;
  - a project with `deleting` set.
  - A project's crash pause is in memory and forgotten at a restart (today's rule), so a crash-paused project starts at the next boot.
- **R5 · Exit restart.**
  - The runtime calls `exited(box)` only for the box's thread VM entry (`kind: "thread"`). The exit must be unasked (not `isStopping`), `holds(box)` must be true, and after the crash record the box must not be paused or closed.
  - It calls once, after `tearDown`.
  - The keeper restarts the box through the same start function as the boot.
- **R6 · RESUME of an always-on agent starts its box.** The keeper tracks each agent's `paused` through `agents.onChange`. A true → false change, with `alwaysOn` on, starts the box. (A project's resume is already a restart.)
- **R7 · An edit of `alwaysOn` alone does not ask the worker to go.** `applyToThread` skips `releaseIdle` when the inputs differ only in `alwaysOn`, through a helper in a new file. Every other edit keeps M11R47.
- **R8 · Turning the switch on does not start a stopped box.** It starts at the next message, task, START or pap start.
- **R9 · Web memory.**
  - `formatGb` moves from `features/overview/overview.vm.ts` to `apps/web/src/lib/format-gb.ts`. The overview imports it from there.
  - `VM_OVERHEAD_MB` (512) moves to `packages/contracts/src/agents-resources.ts`, and `kernel/config-agents-vm.ts` re-exports it: one source.
- **R10 · No e2e journey.** Unit tests, one int file (T4) and `pnpm smoke` at the join.

## Review Focus

1. **No restart loop.**
   - Setup: an always-on VM with no worker exits unasked, right after each start.
   - Expected: the second and third exits are counted, the third pauses the box, and no fourth start is asked. (T2 unit, T4 unit)
2. **STOP is not a crash.**
   - STOP on a running always-on box gives no `exited` call and no crash record. The box stays stopped and the setting stays on.
   - Disabling a member stops their always-on boxes. They are not restarted, and they are skipped at the next boot.
   - (T2, T4)
3. **Switching off a running always-on agent with a live, quiet worker.**
   - No release at once.
   - The worker is released `idleMs` after the switch, not before.
   - The VM stops `idleMs` after the worker left.
   - (T3, T4)
4. **Edits still apply.**
   - An edit of the model on an always-on agent still calls `releaseIdle`. An explicit `releaseIdle` stops a kept worker that is quiet: `keep` affects only the idle timer.
   - An edit of `alwaysOn` alone calls neither `releaseIdle` nor a VM restart.
   - (T1, T3)
5. **A refused boot start does not block the others.**
   - Setup: box 1 is refused `capacity`.
   - Expected: one `always_on_start_refused` line; box 2 still starts; nothing retries. (T4)

