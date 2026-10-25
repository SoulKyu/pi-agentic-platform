# Launch progress and waiting states Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At every wait in pap, show which step runs, how long each step took and whether that is usual, say when a step looks stuck before pap gives up, name what a wait is waiting for, list every launch in one place, and make short loads one honest line.

**Architecture:**
- **S1** writes the shared contracts and the web store, before the lanes split:
  - the `launches` stream;
  - `TaskView.waiting`;
  - `pi_busy`;
  - the `image.progress` vmd op;
  - the launch log RPC.
- **Lane A (lot 1)** owns the daemon, pap-vmd and the web's launch surfaces:
  - a kernel launch registry fed by box-control, vm-launch, the runtime and kata-images;
  - step durations in SQLite;
  - BuildKit's last line through pap-vmd;
  - task waiting reasons;
  - the Pi helper queue;
  - the step panel, strip, ask, activity indicator and button stages.
- **Lane B (lot 2)** owns `LoadingLine` in `@pap/ui` and every short load in the web.
- **J1** joins the lanes, runs the checks, and writes the docs. **J2** is the final review, the merge, `sudo pap vm setup` (asked first) and the preview.

**Tech Stack:** TypeScript (erasable), Node 24, SQLite (node:sqlite), zod contracts, React 19, Tailwind 4 tokens, vitest + happy-dom, pap-vmd (root service, BuildKit, Kata).

**Spec:**
- `docs/specs/2026-10-25-launch-progress-design.md`: the owner's answers (decision 134) and its amendments after the interface recon.
- `.superpowers/recon-loading.md`: every waiting moment today.
- `.superpowers/recon-launch-interfaces.md`: exact signatures, seams and cap warnings.

## Global Constraints

**Repo rules (AGENTS.md, CI-enforced):**
- 400 lines per file at most. These files are at or near the cap, so extract before adding:
  - `automation/runner.ts` 400;
  - `daemon.ts` 400 (never add a line there);
  - `kata-images.ts` 397;
  - `sessions/service.ts` 397;
  - `live-session.ts` 393;
  - `agent-vm/runtime.ts` 392;
  - `compose-agents-vm.ts` 392.
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`. The launch registry is a kernel port (`kernel/launches.ts`), like `kernel/boxes.ts`.
- Every RPC method declares a permission in `packages/contracts/src/methods.ts`, plus its `m14-classes.ts` row.
- Tokens only. Erasable TS. Relative imports keep `.ts`. The only ESLint directive allowed is `eslint-disable-next-line <rule> -- <reason>`.
- Timers go through the kernel `Clock` in the daemon and pap-vmd. Web tests use fake timers. No sleeps.
- Tests never reach the real pap-vmd (`PAP_TEST_VMD_SOCKET`, `testing/box-bed.ts`), `~/.pap` or `~/.pi`. No network.
- Contracts that are `.strict()` gain only optional fields: `AgentSummary`, `ProjectSummary.box`, `TaskView`, `VmStatusView`.

**DESIGN.md (owner rule):**
- **Colour = role.** Red when a step failed. Pink only for the ask, where the person must answer. Neutral for waiting and for "slower than usual".
- **Live regions** are polite. The ask is a `role="status"` block, not an alert: it waits for the person and is not the result of their last action.
- **Targets** are 44 px under a coarse pointer.
- **The live counter** updates once a second on the active step only, with tabular numerals. ADR 0087 records this exception to §7.2. Under reduced motion the ring is static, but the number still counts.

**Exact values:**

| What | Value |
|---|---|
| Steps, in order | `checks`, `image`, `disk`, `vm`, `guest`, `worker` (`worker` only when a session or task waits) |
| Step limits | checks 30 s · image 30 min · disk 10 min · vm 60 s · guest 60 s · worker 30 s |
| "Usual" | median of the box's last 20 runs of the step, shown with ≥ 3 samples; a skipped image is not a sample |
| Slower than usual | elapsed > 2 × usual |
| Ask | at 75 % of the step's limit; for an image step, when the last build line is older than 120 s |
| `launches` events | at most 1 per second per launch, plus each step state change; an end event `{ id, done: true, ok, code? }` |
| `helpers` event | `{ active, max, waiting }`, at most 1 per second, only on change |
| Build tail | pap-vmd keeps the last 200 lines per tag in memory while the build runs; `image.progress { tag }` → `{ building, lines, last: { line, at } \| null }`; each line clipped to 512 characters; the daemon redacts before sending |
| Poll | the daemon polls `image.progress` every 2 s during an image step; a 5 s vmd deadline; any `VmdError` means no sign of life |
| Helper queue | FIFO, 16 waiting at most (the 17th is `pi_busy`); 30 s in the queue at most (then `pi_busy`); the call's own deadline starts when it leaves the queue; calls with `onPrompt` never queue |
| `launch_steps` table | `box_key TEXT, step TEXT, ms INTEGER, at INTEGER`, STRICT, index `(box_key, step, at)`, trimmed to 20 per (box_key, step) in the insert's transaction; migration `agent-vm/202610251200_launch_steps.sql`, registered in `compose-m11.ts` |
| LoadingLine | nothing < 100 ms; spinner + label; elapsed from 3 s; cause from 10 s |
| Bundle | initial ≤ 249 KB gzip; the step panel and the activity list are lazy |

**Exact copy (EN / FR):**

*Steps:*
- `launch.step.checks` "Checks" / « Vérifications »
- `.image` "Project image" / « Image du projet »
- `.imageAgent` "Agent image" / « Image de l'agent »
- `.disk` "Disk" / « Disque »
- `.vm` "VM start" / « Démarrage de la VM »
- `.guest` "Guest ready" / « Invité prêt »
- `.worker` "Session ready" / « Session prête »

*Panel titles:*
- `launch.title.project` "Starting the box" / « Démarrage de la box »
- `.agent` "Starting the agent" / « Démarrage de l'agent »
- `.build` "Building the image" / « Construction de l'image »

*Step times:*
- `launch.time.skipped` "already built" / « déjà construite »
- `launch.time.usual` "{elapsed} · usually {usual}" / « {elapsed} · d'habitude {usual} »

*Slow and stuck:*
- `launch.slow` "Slower than usual. pap gives up at {limit}." / « Plus lent que d'habitude. pap abandonne à {limit}. »
- `launch.sign` "{line} · {ago} ago" / « {line} · il y a {ago} »
- `launch.ask` "No news from {step} for {ago}. pap gives up at {limit}." / « Aucune nouvelle de {step} depuis {ago}. pap abandonne à {limit}. »
- `launch.ask.log` "Show the log" / « Voir le journal »
- `launch.ask.stop` "Stop" / « Arrêter »

*Waiting reasons:*
- `launch.wait.session_slots` "Waiting for a session slot · {used}/{max} in use" / « En attente d'une place de session · {used}/{max} prises »
- `.session_slots.action` "See the sessions" / « Voir les sessions »
- `.box_memory` "Box memory full · {used} / {max}" / « Mémoire des box pleine · {used} / {max} »
- `.box_memory.action` "Stop a box to start this one." / « Arrêtez une box pour démarrer celle-ci. »
- `.image_build` "Waiting for another image build · {position} in line" / « En attente d'une autre construction d'image · {position} dans la file »
- `.pi_reads` "Waiting for Pi · {waiting} reads ahead" / « En attente de Pi · {waiting} lectures avant »
- `.budget` "Daily budget reached" / « Budget du jour atteint »
- `.paused` "Paused after repeated crashes" / « En pause après des plantages répétés »
- `.paused.action` "Restart the box" / « Redémarrer la box »
- `.relay` "Waiting for pap's relay" / « En attente du relais de pap »
- `launch.wait.next` "Next try in {seconds}" / « Prochain essai dans {seconds} »

*Activity indicator:*
- `launch.activity` "{count} in progress" / « {count} en cours »

*Button stages:*
- `launch.stage.checks` "Checking…" / « Vérifications… »
- `.image` "Building the image…" / « Construction de l'image… »
- `.disk` "Preparing the disk…" / « Préparation du disque… »
- `.vm` "Starting the VM…" / « Démarrage de la VM… »
- `.guest` "Waiting for the guest…" / « Attente de l'invité… »
- `.worker` "Starting the session…" / « Démarrage de la session… »

*Pi busy:*
- `error.pi_busy` "Pi is busy: {waiting} reads are waiting. Nothing was read. Try again in a moment." / « Pi est occupé : {waiting} lectures attendent. Rien n'a été lu. Réessayez dans un instant. »

*LoadingLine causes:*
- `loading.cause.pi` "Pi is reading {active} things at once" / « Pi lit {active} choses à la fois »
- `loading.cause.piWaiting` "{waiting} reads waiting" / « {waiting} lectures en attente »
- `loading.cause.box` "The box answers slowly" / « La box répond lentement »

**Gate per task:**
- `pnpm exec eslint --max-warnings=0 <changed>`, `pnpm format:check`, `pnpm --filter @pap/contracts build` then `pnpm typecheck`, `pnpm knip`.
- Under `flock /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/heavy-gate.lock`, run `vitest related --run --project unit --maxWorkers=3 <changed files>`. Check the list is not empty first. Add named int tests where the task says so.
- `pnpm budgets` for web tasks. Never run a full suite, never e2e in a task, never kata.

**Model table:**

| Task | Implementer | Task review |
|---|---|---|
| S1, A1–A9, B1–B4, J1 | Sonnet | Sonnet |
| J2 | n/a | Opus final review of the branch |

No Haiku, and no Opus task review unless the owner adds one.

## Review Focus

1. **A launch never shows a wrong state.**
   - The box reads `starting` from the first step of any launch, a session's included.
   - An ended launch leaves no panel behind; a failed one leaves its InlineError.
   - A reconnect restores live launches from the snapshot.
   - Tests: A2 `a session launch marks its box starting from the checks step`; A2 `the launches snapshot lists live launches after a reconnect`.
2. **Nothing is sent to the wrong user, and no secret leaks.**
   - A member sees only their boxes' launches.
   - A build line passes the redactor.
   - Helper counts carry no ids.
   - Tests: A2 `a member's launches stream holds only their boxes`; A4 `a build line with a vault value reaches the web redacted`.
3. **A stuck step is said before pap gives up, and pap never relaunches by itself.**
   - Tests: A7 `the ask appears at 75 % of the guest limit and offers Show the log and Stop`; A7 `slower than usual appears past twice the median, in neutral text`.
4. **A queued task waits for an image build instead of burning its 90 s deadline and five retries.**
   - Test: A5 `a task on a box that builds its image defers with image_build and is not retried`.
5. **The Pi queue never starves or reorders.**
   - Interactive calls never queue.
   - A queued call's deadline starts when it runs.
   - Tests: A6 `the fifth read waits, runs in order, and its deadline starts when it leaves the queue`; A6 `a sign-in flow is refused pi_busy instead of queued`.

---

## Shared (before the lanes split)

### Task S1: contracts and the web launch store

**Files:**
- `packages/contracts/src/launches.ts`, new:
  - `LaunchStep`, `LaunchStepState`;
  - `LaunchView`: `id`, `box {kind, id}`, `for`, `startedAt`, `steps[]`, `waiting?`;
  - `LaunchEnd`;
  - `HelperStatus`;
  - `LaunchesStreamEvent`: `snapshot {launches, helpers}`, `launch`, `end`, `helpers`;
  - `Waiting`: `reason`, `used?`, `max?`, `position?`, `nextTryAt?`.
- `packages/contracts/src/streams.ts`: add `launches` to `STREAMS`.
- `packages/contracts/src/automation-views.ts`: `TaskView.waiting: Waiting.nullable().optional()`.
- `packages/contracts/src/errors.ts`: add the `pi_busy` code.
- `packages/contracts/src/vmd.ts`: the `image.progress` request and its result schema.
- `packages/contracts/src/methods.ts` and the module methods file: `launches.log { box }` → `{ lines: string[] }`, permission `projects:read`. It is member-own: a box the caller owns.
- `apps/web/src/stores/launch-store.ts` and `launch-feed.ts`, new:
  - a reducer over `LaunchesStreamEvent`;
  - `useLaunchOf(box)`;
  - `useLaunches()`;
  - `useHelperStatus()`.

  The feed subscribes to `subscribe.launches`. The daemon side comes in A2; until then the subscription answers `not_found`, which the feed ignores.
- `apps/web/src/i18n/catalog/launch.ts` and `register-launch.ts`: every `launch.*` and `loading.cause.*` key from Exact copy. `error.pi_busy` goes in `en.ts` and `fr.ts`.

**Interfaces (produces):** the contract names above, and `useLaunchOf`, `useLaunches`, `useHelperStatus`, `formatLaunchTime(ms)`.

- [ ] **Step 1: Failing tests.**
  - `contracts/launches.test.ts`:
    - `a launch view parses with every step state and refuses an unknown step`;
    - `an end event carries ok and an optional code`.
  - `contracts/vmd.test.ts`: `image.progress takes a tag and nothing else`.
  - `web/stores/launch-store.test.ts`:
    - `a snapshot replaces the live launches`;
    - `an end event removes the launch`;
    - `useLaunchOf finds a launch by box`;
    - `helpers events update the counts`.
  - The catalog test: `every launch key has EN and FR`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(contracts): the launches stream, task waiting and pi_busy`. Both lanes start from this commit.

---

## Lane A: lot 1, long launches

### Task A1: make room (no behaviour change)

**Files:** extract so that each file below ends with at least 40 lines of room. Use new sibling files; every existing test must stay green unchanged.
- `automation/runner.ts`: the start path, into `runner-start.ts`.
- `kata-images.ts`: `buildLayers` and `prune`, into `kata-build.ts`.
- `runtime.ts`: `startVm`, into `runtime-start.ts`.
- `sessions/service.ts`: create and prompt, into `service-create.ts`.
- `live-session.ts`: the ready wait, into `live-ready.ts`.
- `compose-agents-vm.ts`: the gate composition, into `compose-agents-vm-gate.ts`.

- [ ] **Step 1:** Run the related tests of each file, and record that they are green.
- [ ] **Step 2:** Move the code.
- [ ] **Step 3:** Run the same tests and the gate.
- [ ] **Step 4: Commit** `refactor(daemon): room for launch steps`.

### Task A2: the launch registry and the `launches` stream

**Files:**
- New `kernel/launches.ts`. It defines the port:
  - `LaunchRegistry.open({ box, owner, for }) → LaunchHandle`;
  - `handle.step(step, state, detail?)`;
  - `handle.wait(waiting | null)`;
  - `handle.end(ok, code?)`;
  - `registry.activeFor(box)`;
  - `registry.live(owner)`;
  - `registry.onChange(listener)`.
- New `modules/agent-vm/launches.ts`. It implements the port:
  - in-memory records, with ids minted here;
  - publishing through the hub, at most 1 event per second per launch plus every state change;
  - the snapshot provider for `launches`;
  - writes to `launch_steps` with the trim;
  - `usualMs` read from the table.
- New `modules/agent-vm/migrations/202610251200_launch_steps.sql`. Export the migration source from `modules/agent-vm/index.ts` and register it in `compose-m11.ts`. Update `daemon.migrations.test.ts` and `compose-m11.entry.test.ts`.
- `subscribe.launches`: the handler and its permission.
- `modules/agent-vm/box-control.ts`: `phaseOf` also returns `starting` when `registry.activeFor(box)` is set. The registry's `onChange` calls `tell(projectId)`.

**Interfaces:**
- Consumes: S1 contracts.
- Produces: the `LaunchRegistry` port, wired in the agents-vm composition, and `registry.handleFor(box)` for later steps.

- [ ] **Step 1: Failing tests.**
  - `launches.test.ts`:
    - `a launch's events are throttled to one a second plus each state change`;
    - `usual is the median of the last 20 runs once there are 3`;
    - `a skipped image is not a sample`;
    - `the table keeps 20 rows per box and step`.
  - `box-control.test.ts`: `a session launch marks its box starting from the checks step`.
  - `launches.int.test.ts` (process backend):
    - `the launches snapshot lists live launches after a reconnect`;
    - `a member's launches stream holds only their boxes`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate**, plus the int test by name.
- [ ] **Step 5: Commit** `feat(daemon): a launch registry and the launches stream`.

### Task A3: steps from every launch path

**Files:**
- `box-control.ts` `bringUp`: open a launch (`for: "start"`). Mark `checks` around `deps.gate`, `image` around `images.tagOf`, then pass the handle to `runtime.start`.
- `sessions/vm-launch.ts`: open a launch (`for: session id`). Mark `image` around `plan.image()`, then pass the handle into `runtime.spawn`. The session layer marks `worker` around `session.ready`.
- The `guardedLaunch` gate: marks `checks`. While it waits for the relay, it sets `waiting: { reason: "relay" }`.
- `runtime-start.ts` and `AgentRuntimeBackend.start(spec, launch, steps?)`: the kata backend marks `disk` around `ensureDisk` (`skipped` when the disk is known and big enough) and `vm` around `vm.start`. The runtime marks `guest` around `awaitGuest`. The process backend marks `vm` and `guest`.
- `kata-images.ts` and `kata-build.ts`:
  - `resolve` takes an optional observer. It reports `image` as `skipped` when the image is built or already running.
  - It sets `waiting: { reason: "image_build", position }` while it waits in `exclusive`.
  - It reports the tag being built, for A4.
- Capacity: `runtime.startVm` capacity refusal and `checkCapacity` keep refusing. The handle records `waiting` only where pap waits: tasks (A5) and the relay.
- `agents.openThread` and the task session path open their launch through the same `vm-launch`.

**Interfaces:** consumes A2's `LaunchHandle`.

- [ ] **Step 1: Failing tests.**
  - `box-control.test.ts`: `a start reports checks, image skipped, disk, vm, guest in order and ends ok`.
  - `vm-launch.test.ts`: `a session launch reports its image build then worker ready`.
  - `kata-images.test.ts`: `resolve reports image_build waiting while another build holds the queue`.
  - `runtime.test.ts`: `a failed guest hello ends the launch with timeout and marks guest failed`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(daemon): every launch reports its steps`.

### Task A4: BuildKit's last line, and the launch log

**Files:**
- `apps/vmd/src/exec.ts`: a streaming option `onLine?(line, stream)`, built on `spawn` plus a line splitter. When the option is absent, behaviour is unchanged. Update `testing/fake-exec.ts`.
- `apps/vmd/src/ops-image.ts`:
  - `runBuild` passes `--progress=plain` and feeds a `Map<tag, Tail>` (200 lines, each clipped to 512 characters) that is dropped in `finally`;
  - `image.progress { tag }` answers from that map;
  - add the case in `ops.ts`.
- `modules/agent-vm/vmd-client.ts`: give `image.progress` a 5 s deadline.
- `kata-build.ts`: while a tag builds, poll `image.progress` every 2 s, redact the line with the existing log redactor, and call `handle.step("image", "running", { line, at })`. Any `VmdError` means no line.
- `launches.log { box }`: returns the running build's tail (redacted), or the last guest boot lines the gateway already logs, as up to 200 lines. It is owner-checked.

- [ ] **Step 1: Failing tests.**
  - `apps/vmd/src/exec.test.ts`: `onLine receives each line as the child prints it`.
  - `ops-image.test.ts`:
    - `image.progress returns the build's last line and drops the tail when the build ends`;
    - `a joined build shares its tail`.
  - `kata-build.test.ts`:
    - `the image step carries the last line, polled every 2 s`;
    - `a bad_request from an old pap-vmd means no line, never a failed launch`.
  - `launches.log.test.ts`:
    - `a build line with a vault value reaches the web redacted`;
    - `a member cannot read another user's box log`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(vmd): BuildKit's last line through image.progress`.

### Task A5: what a task waits for

**Files:**
- `putOff`: change it from `Map<string, number>` to `Map<string, { until; reason; used?; max? }>`. Update every reader: `engine.ts`, `admit.ts`, `runner-agent.ts`, `runner-thread.ts`, `runner-start.ts`, `runner-launch.ts`.
- `handleStart`:
  - defers with `session_slots` when admission says slots are full, with used and max;
  - defers with `paused` or `budget` where it already defers for them.
- `runner-start.ts`: before creating the session, ask the registry whether the task's box has a live launch in its `image` step. If it does, defer 10 s with `image_build` instead of starting. No attempt is spent.
- `task-view.ts`: fill `waiting` from `putOff`. The runner announces the task when its waiting changes.

- [ ] **Step 1: Failing tests.**
  - `runner-start.test.ts`: `a task on a box that builds its image defers with image_build and is not retried`.
  - `runner.test.ts`: `a task deferred for slots carries session_slots with used and max and its next try`.
  - `task-view.test.ts`: `waiting clears when the task starts`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(automation): a queued task says what it waits for`.

### Task A6: the Pi helper queue

**Files:**
- `kernel/helper/pool.ts`:
  - `run` returns at once while there is room.
  - When the pool is full, it returns a deferred handle: `done` settles when the queued call runs and ends; `cancel` removes the call from the queue; `answer` returns false until the call starts.
  - At most 16 calls wait; the 17th throws `pi_busy`.
  - A call that waits 30 s throws `pi_busy`.
  - The call's deadline starts when it leaves the queue.
  - A call with `onPrompt` never queues: it throws `pi_busy` when the pool is full.
  - New option `onChange?({ active, max, waiting })`.
- `compose-pi.ts`: throttles `onChange` to once a second and publishes `helpers` on `launches` to every subscribed owner (the registry tracks owners with a live subscription).
- Callers that mapped `capacity` for helper calls now map `pi_busy`: mcp, skills, trust, models, agent packages, subagent profiles, plugin picks, lane trust inherit.

- [ ] **Step 1: Failing tests.**
  - `pool.test.ts`:
    - `the fifth read waits, runs in order, and its deadline starts when it leaves the queue`;
    - `the seventeenth waiting read is refused pi_busy`;
    - `a read that waits 30 s is refused pi_busy`;
    - `a sign-in flow is refused pi_busy instead of queued`;
    - `cancel removes a queued read`.
  - Update `pool.limits.test.ts` and the capacity assertions of the callers.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(daemon): Pi reads queue instead of failing`.

### Task A7: the step panel, the strip and the ask (web)

**Files:**
- New `apps/web/src/features/launch/`:
  - `StepPanel.tsx` (lazy): title, steps, times, sign of life, slow line, ask;
  - `LaunchStrip.tsx`: one line plus five token-coloured segments over the box steps;
  - `use-elapsed.ts`: a 1 s tick, active step only, stops at the end;
  - `launch-view.ts`: the pure derivations (slow, ask, time strings);
  - `LaunchLogDialog.tsx` (lazy): `launches.log`;
  - `WaitingLine.tsx`: the reason, the freeing action, the next try.
- Placements:
  - `ProjectHome.tsx`: while Launch is busy, the panel for `project:<id>`.
  - `BoxFact.tsx` and the `ProjectSettings.tsx` box section: the strip, and the panel when expanded.
  - `AgentScreenParts.tsx`: the panel in place of "Opening the thread…".
  - `SessionScreen.tsx`: the panel above the composer while a reopened session is `starting` with a launch on its box.
  - `TaskCard.tsx`: the strip and `WaitingLine`.
  - `AgentRail.tsx`: waking reads the live launch store, in place of the one-shot `use-vm-status`.
- Stop maps to:
  - `projects.stopBox` for a project box;
  - `agents.stop` for an agent;
  - the queued task's Cancel for a task.

  If a kind has no stop yet, the ask shows only Show the log.

- [ ] **Step 1: Failing tests.**
  - `launch-view.test.ts`:
    - `slower than usual appears past twice the median, in neutral text`;
    - `the ask appears at 75 % of the guest limit and offers Show the log and Stop`;
    - `an image step asks when its last line is older than 120 s`.
  - `StepPanel.test.tsx`:
    - `done steps show their time, a skipped image says already built, the active step counts once a second`;
    - `a failed step leaves its InlineError when the launch ends`.
  - `ProjectHome.launch.test.tsx`: `pressing Launch on a stopped box shows the steps of its launch`.
  - `TaskCard.waiting.test.tsx`: `a deferred task says it waits for a session slot, 4/4, with its next try`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate**, and `pnpm budgets` (the panel and the dialog are lazy).
- [ ] **Step 5: Commit** `feat(web): launch steps where you wait`.

### Task A8: the activity indicator and the button stages (web)

**Files:**
- `apps/web/src/features/launch/ActivityButton.tsx` and `ActivityList.tsx` (lazy):
  - "{count} in progress", in `Rail.tsx` above the spacer, and in the phone top bar (`MobileShell.tsx`);
  - hidden when nothing runs;
  - the list shows live launches, background image builds, GitHub clones, lane setups and waiting tasks. Each row has its step or reason and its time, and links to its screen.
- `packages/ui/src/primitives/Button.tsx`: a new prop `stage?: string`, shown with the spinner as soon as the button is busy.
- `BoxStart.tsx`, Restart and Rebuild in `ProjectSettings.tsx`, Launch in `ProjectHome.tsx`, Send in `Composer.tsx`: they pass `stage={t("launch.stage.<step>")}` from their box's launch. Launch and Send get `pendingSince`.

- [ ] **Step 1: Failing tests.**
  - `ActivityButton.test.tsx`:
    - `counts live launches and waiting tasks, and hides at zero`;
    - `each row links to its screen`.
  - `Button.test.tsx`: `stage shows with the spinner from the start of the wait`.
  - `BoxStart.test.tsx`: `the button says Building the image… while the image step runs`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate**, plus `pnpm budgets`.
- [ ] **Step 5: Commit** `feat(web): one place for everything in progress; buttons say the real step`.

### Task A9: ADR 0087 and DESIGN.md

**Files:**
- `docs/adr/0087-launch-progress.md`:
  - the §7.2 exception for the 1 s counter;
  - the ask in pink as a wait for the person;
  - the `launches` stream;
  - pap-vmd's new op and `sudo pap vm setup`;
  - the Pi queue.
- `docs/adr/README.md`.
- DESIGN.md:
  - §7.2: the counter;
  - §7.3: the stage from the step;
  - §9.1: `LoadingLine`, the `Button` stage, StepPanel, Strip;
  - §2: the ask.

- [ ] **Step 1:** `adr-index.test.ts` fails, because 0087 is missing from the index. **Step 2:** Write. **Step 3:** `adr-index` and `docs-truth` pass.
- [ ] **Step 4: Commit** `docs: launch progress (ADR 0087)`.

---

## Lane B: lot 2, short loads

### Task B1: `LoadingLine`

**Files:**
- `packages/ui/src/primitives/LoadingLine.tsx`, with props:
  - `label`;
  - `since?: number`, the shared start, so a chunk fallback and the data line count as one wait;
  - `cause?: string`;
  - `deferred?: boolean`, default true; false inside `LazyBoundary`, which already waits 100 ms.
- Behaviour:
  - nothing before 100 ms;
  - spinner and label;
  - elapsed time from 3 s;
  - cause from 10 s;
  - a polite `role="status"`;
  - the label ends with "…".
- Export it from `index.ts`.
- `apps/web/src/lib/loading-cause.ts`: `usePiCause()` from S1's `useHelperStatus()`, and `boxCause`.

- [ ] **Step 1: Failing tests.**
  - `LoadingLine.test.tsx`:
    - `nothing before 100 ms, the label after, elapsed from 3 s, the cause from 10 s`;
    - `a shared since counts from the first wait`.
  - `loading-cause.test.ts`: `Pi reads give "Pi is reading 3 things at once" and "2 reads waiting"`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(ui): LoadingLine`.

### Task B2: Settings and Pi reads

**Files:**
- Every Settings route's chunk fallback and its section's data line become one `LoadingLine` with the section's label and a shared `since`. Each route keeps its failed-chunk Retry branch.
  - MCP: `McpSettings.tsx`, `McpSection.tsx`;
  - skills;
  - models: `ModelsSettings.tsx`, `ModelsSection.tsx`, `ModelsJsonEditor.tsx`, the provider form;
  - availability: Preview, ExtensionProviders;
  - GitHub: routes and `GithubSettings.tsx`, `RepositoryPicker.tsx`, `CheckLog.tsx`;
  - notifications, health, automation, users;
  - approvals and policy: `ApprovalsPanel`, `RulesByProject`, `AuditLog`, `SessionPolicy`, `AlwaysRules`;
  - access: devices, passkeys, tokens.
- Pi reads pass `cause={usePiCause()}`.

- [ ] **Step 1: Failing tests.**
  - `settings-loading.test.tsx`:
    - `Settings › MCP shows one loading line, not two`;
    - `a Pi read past 10 s says Pi is reading N things at once`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate**, plus `pnpm budgets`.
- [ ] **Step 5: Commit** `fix(web): one loading line in Settings`.

### Task B3: files, changes, lists, agent reads and boot

**Files:**
- Files and Changes: Explorer, FileViewer, ChangesPane, FileDiff, EditDiff. Box ops pass `boxCause`.
- Lane screens: ReviewPane, ReviewFileDiff, ScopeBar, CompareScreen, ScriptLogDialog, NewLaneDialog, CommitBar, LaneScreen.
- Lists: ModelList, ModelPickerField, ExtensionControls, CommandPalette, ProjectTree / ArchivedShelf through `Loading.tsx`, RecentWork.
- Agent reads: AgentFiles, AgentSettingsTab, SecretsList, StatusPanel, AgentPackages, AgentScreen, AgentsList, AgentSettingsView, NewAgentDialog, SubagentsSettings.
- Boot and other: RootLayout, LazyFirstRun, LazyInvite, MobileShell, PaneBoundary, Unrouted, PiStep, SetupModels, InviteScreen, Landing, ProjectSettings' loading line, TrustDialog.
- Use the recon's file:line list, `.superpowers/recon-launch-interfaces.md` §11.

- [ ] **Step 1: Failing test.** `loading-lines.test.ts`: `no loading or reading status line in apps/web outside LoadingLine`. It is a source scan for `role="status"` paragraphs whose key ends in `.loading`, `.reading` or `app.loading`, with an allowlist file.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Gate**, plus `pnpm budgets`.
- [ ] **Step 5: Commit** `fix(web): every short load is one LoadingLine`.

### Task B4: lot 2 docs

**Files:**
- `docs/agents/web.md`: `LoadingLine`, its timing, its causes and the guard.

- [ ] **Step 1:** The `docs-truth` test passes. **Step 2: Commit** `docs: LoadingLine`.

---

## Join

### Task J1: merge, checks, docs

- [ ] Merge lane A, then lane B, into `feat/launch-progress`. Run the gate and `pnpm budgets` (≤ 249 KB) on the merged tree.
- [ ] Run the unit project once for `apps/web`, `packages/ui`, `apps/vmd` and the daemon modules touched, under the flock. Then run the A2 and A4 int tests by name.
- [ ] **Docs:**
  - `docs/agents/agents-vm.md`: launches, the step limits, `image.progress`, the log;
  - `sessions.md`: new sessions and the home panel;
  - `automation.md`: task waiting;
  - `daemon.md`: the Pi queue;
  - decision 135, "Launch progress built", with "merge sha: pending".
- [ ] Run the full `pnpm test:e2e` once in the container. Adjust any locator on the old loading lines.
- [ ] **Kata** (local, KVM host, with the owner's OK, after J2's `sudo pap vm setup` on a scratch home only if the owner agrees): one real box start shows every step and a build line. Otherwise this check waits for the preview.
- [ ] Commit `feat(web): launch progress joined, docs`.

### Task J2: final review and merge

- [ ] Opus final review of the branch. First focus: Review Focus 1, 2 and 5. Then one Sonnet fix wave and a scoped re-review.
- [ ] Rebase on main. Squash-merge, `pnpm build`, back up the DB, stop the preview.
- [ ] Ask the owner, then run `sudo pap vm setup --user ubuntu --home ~/.pap --dev-from-tree`. This is needed because pap-vmd gains `image.progress`.
- [ ] Start the preview, run `pap doctor`, and push.
- [ ] The owner starts a stopped box and opens a session on it. Then archive the ledger, add the merge sha to the decisions log, and update memory.

---

## Coverage

| Spec | Task |
|---|---|
| §3.1 launch record, §3.2 stream and box phase | S1, A2, A3 |
| §3.3 last sign of life | A4 |
| §3.4 slower than usual, ask, log, stop | A4 (log), A7 |
| §3.5 waiting (relay, image queue, tasks) | A3, A5, A7 |
| §3.6 Pi queue | A6, S1 (`pi_busy`) |
| §3.7 panel, strip, counter, indicator, buttons | A7, A8 |
| §4 LoadingLine | B1, B2, B3 |
| §5 ADR 0087, privacy, ownership | A9, A2, A4 |
| C1 "one line instead of two" | B2 |

**Not built:**
- percentages and remaining-time estimates;
- skeletons;
- automatic relaunch;
- intra-step progress for disk and VM start;
- a sign of life for the profile preparation, which runs in a worker thread and has no line.
