# Always-on boxes (Toujours allumée)

Owner request (2026-11-04): « Rajoute un bouton qui permet à un agent de ne jamais s'éteindre (sa box). Actuellement elle s'éteint au bout d'une heure ». The owner answered 6 questions on `docs/design/questions/2026-11-04-always-on-questions.html` and took every recommendation, with no notes. Raw answers: `2026-11-04-always-on-answers.json`. Decision 149.

## 1. Why, and what happens today

A box stops itself in two steps. Both waits come from `PAP_WORKER_IDLE_MINUTES` (30 by default, the same for everyone):

1. **The worker is released** (`modules/sessions/idle-release.ts`). This is the Pi process of a session, an agent's thread among them.
   - It goes after 30 minutes with nothing pending.
   - If processes the agent started are still running, it waits up to 8 hours instead (`BACKGROUND_RELEASE_MS`).
   - When it goes, it kills every process it started (`packages/pi-host/src/descendants.ts`). Preview services are the exception: they have their own launcher.
2. **The VM stops** (`createIdleStop` in `modules/agent-vm/lifecycle.ts`), 30 minutes after its last worker left.

That is the hour the owner sees. In addition, every pap start stops every VM the backend lists (RT-42). On the owner's preview, that happens after every merge.

The owner wants a box that stays up: an agent that answers without a cold start, and work it left running that is not cut.

## 2. Owner decisions (round 1)

- **Q1 · What stays alive (A): the box and the agent.** For an agent with the setting on:
  - its VM never stops on its own;
  - its thread's worker is never released, neither after 30 minutes quiet nor after 8 hours of background processes;
  - what the agent started keeps running.
  - Cost: one slot of `PAP_MAX_WORKERS`, held for as long as the worker lives.
- **Q2 · pap restart or crash (A): always on.**
  - pap starts the box when pap starts, and again after a crash.
  - The existing crash pause still applies (RT-40: 3 crashes in 10 minutes). RESUME clears it and starts the box.
  - What ran before a pap restart does not come back: the VM starts with no process.
- **Q3 · Where (A): one switch in the box's settings, one chip on its card.**
  - The switch is labelled « Toujours allumée » and sits in the « Machine virtuelle » block (memory, CPUs, disk).
  - The Overview card shows a read-only « Toujours allumée » chip. The card has no toggle.
- **Q4 · Box projects too (A).** The same switch appears in Project settings › Machine virtuelle. That is the same `ResourceFields` block, and the same VM runtime.
- **Q5 · Members (A).** Each user can set it on their own boxes, within the shared memory cap. Who may edit a box's VM settings today may set it.
- **Q6 · STOP (A): a one-off stop, the setting stays.**
  - A stopped always-on box stays stopped until the next message, task, START or pap start.
  - To stop it for good, turn the switch off.

## 3. Behaviour

### 3.1 The setting

- `alwaysOn: boolean`, one per box (an agent or a box project). It is off by default, for existing boxes and new ones.
- **Builder call: it is a sibling of the VM settings, not a field of `AgentResources`.**
  - `AgentResources` is `.strict()` and is also pap-vmd's wire schema (`vmd.ts:40`) and `RuntimeSpec.resources`.
  - The agent save path decides "resources changed" from it (`modules/agents/resources-check.ts`).
  - A toggle must reach neither.
  - It is stored on the agent's record and on the project's box row (`project_boxes`). An additive migration (a column defaulting to false) is fine.
- Turning it on or off never restarts the VM or the worker, and never counts as an edit that asks the worker to go (M11R47). It takes effect at once, on a running box too:
  - **On:** the VM's idle timer is cancelled. The agent's thread worker, live or started later, is exempt from release.
  - **Off:** the normal waits start from that moment, as if the last activity happened then.
- Isolated task VMs never take it: kept task VMs keep `KEPT_IDLE_MS`, and the other task VMs keep today's wait.

### 3.2 Agents and box projects

- **An agent:**
  - its VM never idle-stops;
  - its thread session's worker is never idle-released (Q1).
- **A box project:**
  - its VM never idle-stops;
  - its sessions' workers keep today's release.
  - **Builder call, for the owner to check:** a project can hold many sessions, and keeping each worker would fill `PAP_MAX_WORKERS`. Long-running work in a project can run in the box terminal, whose ptys do not belong to a session's worker.

### 3.3 pap start

1. pap stops every listed VM (RT-42, unchanged).
2. **Builder call:** once the compose has finished (the gateway, relay, proxy and mirrors listen), pap starts every always-on box whose owner is enabled and that is not crash-paused, or quarantined (agents only).
   - This is a system action with no caller. It uses the runtime start that START reaches, with the box's own owner, and applies the same owner, pause and quarantine checks.
   - Starts go one at a time, the owner's boxes first, then by creation time.
3. A start that is refused leaves that box stopped. This covers `capacity`, `sandbox_unavailable` and a pap-vmd that does not answer (no wait).
   - The refusal is logged once (`always_on_start_refused` with box and code). There is no retry loop.
   - The Overview shows the box with its usual state.
4. An agent's worker starts at the first message or task, as today. Booting the VM is the slow part, and it is done.

### 3.4 A crash

- A VM exit that nobody asked for, on an always-on box, starts the box again at once through the same start path.
  - "Nobody asked" means not through `isStopping`: a pap-vmd restart counts.
  - A refused restart is treated as at pap start: logged once (`always_on_start_refused`), the box stays stopped, no retry (builder call).
- **For always-on boxes only**, the crash is recorded even when the VM had no worker, so an always-on box cannot loop.
  - Other boxes keep today's rule: a workerless exit is not counted.
  - The third crash in 10 minutes pauses the box as today.
- A worker that dies while its VM stays up is not restarted on its own. The next message or task starts it again. This keeps today's rule.

### 3.5 What still stops an always-on box

These stop it, and it then stays stopped until the next message, task, START or pap start (Q6):
- STOP (Overview, `agents.stopBox`, `projects.stopBox`);
- a resources edit that needs a VM restart (unchanged).

RESTART ends with the box running, as today.

These stop it, and pap never starts it again:
- disabling its owner (M14). It also stays down at the next pap start: a disabled owner's boxes are skipped;
- deleting the agent or the project;
- the crash pause, until RESUME.

pap never stops an always-on box to make room. A start of another box that does not fit is refused with today's `capacity` message.

### 3.6 Worker slots (builder call, for the owner to check)

- There is no new cap. An always-on agent's worker holds one `PAP_MAX_WORKERS` slot, like any live worker.
- When the slots are full, a new session or task is refused with today's `workers` message. The Overview band shows Pi workers.
- Ceiling: a user with many always-on agents can fill every slot, a member's included. The upgrade path is a per-user cap on always-on workers.

## 4. UI

Copy, verbatim:

| Key | EN | FR |
|---|---|---|
| switch label | Always on | Toujours allumée |
| switch hint | Never stops on its own; pap starts it again when pap starts. Keeps {memory} of shared memory reserved at all times. | Ne s'arrête jamais d'elle-même ; pap la rallume à son démarrage. Garde {memory} de mémoire partagée réservés en permanence. |
| card chip | Always on | Toujours allumée |
| stop dialog line (always-on box only) | It stays always on: pap starts it again when pap next starts. | Elle reste toujours allumée : pap la rallumera à son prochain démarrage. |

- **The switch:** the `@pap/ui` Switch, at the bottom of the « Machine virtuelle » fieldset (`features/boxes/ResourceFields.tsx`), in the agent form and in Project settings.
  - `{memory}` is the box's `memoryMb` plus `VM_OVERHEAD_MB` (512). It uses the Overview's memory format: GB with one decimal, `1.5 GB` / `1,5 Go`. It follows the draft memory value as the user types; while that value is invalid, the hint drops its last sentence.
  - It saves with the rest of the form, through the existing save path.
- **The chip:** a neutral chip (`chip mut`, no dot) with the lucide `Pin` icon, in the card's facts row (layout A of decision 147). It shows on every card of an always-on box, whatever its phase.
  - In the stopped strip, the box's name is followed by the same pin icon, with its label for screen readers.
- **Phone:** the same chip and icon, and the same switch in the settings sheets.
- The rail and the tasks board do not change.

## 5. Contracts

- The agent's input and record, and a box project's VM settings, gain `alwaysOn: boolean` (absent reads as false), beside `resources` and never inside it (section 3.1).
- `OverviewBox` gains `alwaysOn: boolean`.
- No new RPC method: the setting rides the existing agent and project update methods and their permissions, as an optional param.
- Contracts change, so after the merge the VM bundle is stale: `sudo pap vm setup` (owner's OK).

## 6. Tests the builder must write

- `createIdleStop` with the setting on never calls `onIdle`. Turning it off arms the wait from now; turning it on cancels a pending wait.
- An always-on agent's thread worker is not released after `idleMs` quiet, nor after `BACKGROUND_RELEASE_MS` with background processes. Turning the setting off makes it releasable again from that moment.
- An always-on project's session workers are still released after `idleMs`.
- At pap start:
  - after RT-42's stop, always-on boxes start;
  - a disabled owner's, a paused and a quarantined box are skipped;
  - a `capacity` refusal leaves that box stopped, is logged once, and the next box still starts.
- An always-on VM that exits unasked starts again. Three exits in 10 minutes, with or without workers, pause it; RESUME starts it.
  - A refused restart leaves the box stopped and is logged once.
  - A box that is not always on and exits without a worker is still not counted.
- STOP on an always-on box leaves it stopped, and leaves the setting on. The next message starts it.
- Toggling the setting on a running box restarts neither the VM nor the worker.
- The web:
  - the switch saves and reloads;
  - the hint's memory follows the draft;
  - the chip shows on the card and the pin in the stopped strip;
  - the stop dialog line shows only for an always-on box;
  - FR and EN copy as in section 4.
- M14: a member sets it on their own agent and their own project, and cannot on another user's (today's permission and ownership checks).

## 7. Non-goals

- An idle duration per box (the env variable stays global).
- Bringing back processes after a pap restart, or a worker after a worker crash.
- Always-on isolated task VMs.
- Stopping always-on boxes under memory pressure, or a retry loop when the boot start is refused.
- A toggle on the Overview card or in the agent's menu (Q3 B and C, not chosen).

## 8. Docs

- `docs/agents/agents-vm.md`: the lifecycle section gets the setting, the pap-start order, the crash rule and what stops a box.
- `docs/agents/web.md`: the switch and the chip.
- `docs/agents/daemon.md`: the `always_on_start_refused` log line.
- AGENTS.md, in the boxes paragraph: one line that names the setting and points to `agents-vm.md`.
