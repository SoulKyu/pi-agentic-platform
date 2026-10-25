# Launch progress and waiting states

Owner request (2026-10-25): « À chaque fois qu'on a des choses qui chargent dans pap, c'est toujours compliqué de comprendre combien de temps ça prend et surtout de savoir si c'est en cours ou si c'est bloqué par quelque chose. » Examples given: a box launch, a session, an agent, Settings loading, an agent going from waking to running.

Answers: the form `docs/research/launch-progress-decisions.html` (decision 134): every recommendation (L1–L6, C1, C2), two lots, run in parallel. The recon behind it: `.superpowers/recon-loading.md`.

## 1. Why

pap knows every step of a launch and sends one word ("starting"):
- **The daemon knows the steps.** A box launch runs checks, then the image (up to three layers), the disk, the VM start, the guest's hello, and finally the worker.
- **The web sees almost nothing.**
  - It gets only `project.box.phase` (`stopped | starting | running`).
  - A new session never publishes `starting`.
  - The box phase stays `stopped` while a session's launch builds the image.
  - A task shows "Queued" through the whole start, even while pap silently retries for a slot.
  - The fifth Pi read is refused at once, with copy about worker slots.

Measured: a cold box start is 6 s median (12 s the first time ever). A first image build takes minutes.

## 2. Goals

- At every long wait, the person sees which step runs, how long each step took, and whether that is usual.
- A stuck step is said to be stuck before pap gives up, with what the person can do.
- A wait on a resource names the resource, the queue and the action that frees it.
- One place lists everything that is starting, building or waiting.
- Short loads show nothing under 100 ms, then one line that says what is read and, past 10 s, why it is slow.

**Non-goals:**
- percentages or remaining-time estimates (L1 (c) and L2 (c) refused);
- skeleton screens (refused by the design audit);
- automatic relaunches;
- intra-step progress for steps under a few seconds (disk, VM start).

## 3. Lot 1: long launches (L1–L6, C2)

### 3.1 The launch record (daemon)

A launch is one start of a box: a project box, an agent VM, or a background image build. Everything that waits on that box points at it: the project's START, a session on the box, an agent thread, a trigger task.

The daemon keeps one in-memory record per live launch:
- `id`;
- `box`: `{ kind: "project" | "agent", id }`;
- `owner`: the user the box belongs to;
- `startedAt`;
- `for`: what asked for it, such as a session id, a task id or `start`;
- `steps`, in a fixed order:
  1. `checks`: the gate, including the relay wait;
  2. `image`: resolve, and build when needed;
  3. `disk`;
  4. `vm`: `vm.start`;
  5. `guest`: the hello;
  6. `worker`: only when a session or task waits for a Pi worker.

Each step has:
- `state`: `pending | running | done | skipped | failed`;
- `startedAt`, `endedAt`;
- `usualMs`, the median of this box's last 20 runs of the step, shown once there are 3 samples;
- `deadlineAt`, the step's existing hard limit:

  | Step | Limit |
  |---|---|
  | `checks` | 30 s relay wait |
  | `image` | 30 min |
  | `disk` | 10 min |
  | `vm` | 60 s |
  | `guest` | 60 s |
  | `worker` | 30 s |

- `detail`, an optional last sign of life `{ line, at }`.

An image already built is `skipped`, shown as "already built". A failed step carries the error code the RPC already returns.

### 3.2 Events (amended after the interface recon, 2026-10-25)

**A new stream, `launches`, carries the records.** The shell stream's replay ring (128 events, shared with sessions and projects) would be flooded by one event a second, so launches get a stream of their own, keyed per owner like the shell stream; its snapshot lists the live launches and the helper counts. The payload is the whole record, at most once a second per launch, and again at each state change. A last event marks the end, with `{ id, done: true, ok, code? }`. Each user receives only the launches of boxes they own (M14 scoping).

**The box phase follows the launch.** A box is `starting` from the first step of any launch, including one a session or task started. That fixes the box shown `stopped` during a session's image build.

**Where a launch shows is decided by its box, not by a session id.** `sessions.create`, `agents.openThread` and a task's session creation return only once the launch ends, so a new session has no screen while it starts: the project home's Launch form, the agent's thread screen and the task card find their launch by box (`project:<id>` or `agent:<id>`). A reopened cold session already publishes `starting`; its screen joins the launch by its project's box.

**Step durations go to SQLite.** A small table `launch_steps(box_key, step, ms, at)` keeps the last 20 rows per box and step. A skipped image does not count.

### 3.3 The last sign of life for an image build (L3)

pap-vmd answers each call once, at the end.

- **New pap-vmd op.** A new read-only op, `image.progress { tag }`, returns the last line BuildKit printed for that image tag and its time. A launch builds up to three tags in a row (base, profile, agent), and joined builds share one tail. The profile preparation before the builds runs in pap's own worker thread and has no line.
  - pap-vmd keeps a rolling tail of the build's output.
  - It keeps the last 200 lines in memory while the build runs (for Show the log) and drops them when the build ends; it stores no file. Today `exec` buffers a child's output until it exits, so pap-vmd gains a streaming variant for builds.
  - The op is new protocol, so `sudo pap vm setup` must run after the update.
- **Polling.** The daemon polls the op every 2 s while an image step runs and puts the line in `detail`.
- **Redaction.** The line passes through the existing log redactor before it reaches the web.

Other steps have no sign of life of their own. Their elapsed time and limit stand in for it.

### 3.4 "Slower than usual" and stuck (L3)

**The web derives these states**; the daemon sends only facts.

- **Slower than usual.** Shown when a step's elapsed time passes twice `usualMs`. The copy is "Slower than usual. It gives up at {limit}." It is neutral text, not a failure.
- **The ask.** A pink "you must answer" block, worded with the step and the limit, for example "No news from the guest for 45 s. pap gives up at 60 s.", with the actions **Show the log** and **Stop**. It appears:
  - when a step reaches 75 % of its limit;
  - for an image build, when the last line is older than 120 s.
- **The actions.**
  - **Show the log** opens the build's last 200 lines, or the guest's boot lines, through a new read RPC.
  - **Stop** cancels the launch, using the existing stop path.
- **No automatic relaunch** ever.

### 3.5 What a wait is waiting for (L4)

A launch or a task that waits on a resource carries `waiting`:
- `reason`, one of:
  - `session_slots` (`PAP_MAX_WORKERS`);
  - `box_memory` (`PAP_AGENTS_MEMORY_MAX_MB`);
  - `image_build` (queued behind another build, with the other box's name when its owner is the same user);
  - `pi_reads` (the helper pool);
  - `budget`;
  - `paused` (crashes);
  - `relay`;
- `used` / `max` where they apply;
- `position` in a queue;
- `nextTryAt`, from an outbox defer.

The web words each reason with the action that frees it:
- "Waiting for a session slot · 4/4 in use · Next try in 8 s · See the sessions";
- "Box memory full · 6.0 / 6.0 GB · Stop a box to start this one".

**Trigger tasks.**
- `TaskView` gains `waiting`. The outbox stores no reason with a defer, so the runner keeps the reason with the deferral it already records in memory, and announces the task again when its waiting changes.
- A task whose box is building an image waits for the build (reason `image_build`). It no longer runs into the 90 s `task.start` deadline and silent retries.

### 3.6 Pi reads queue (L5)

The helper pool queues instead of refusing:
- The queue is FIFO and bounded at 16 waiting calls; the 17th is refused `capacity`.
- A call waits in the queue for at most 30 s before its own deadline starts, then it is refused.
- The refusal has its own code, `pi_busy`, whose copy names Pi reads, not worker slots.
- Interactive helper calls (provider sign-in flows, calls that prompt) never queue: they keep today's immediate refusal.

The `launches` stream also carries a `helpers` event, to every owner with a subscriber, `{ active, max, waiting }`, throttled to 1 per second and sent only while it changes. It is install-wide counts with no ids, safe for members.

### 3.7 Where it shows (L1, L6, C2)

- **The step panel** (L1 (a)), in the main area of what waits:
  - **Session screen:** while the session is `starting` with a launch, the panel sits where the first reply will appear.
  - **Agent thread:** where "Opening the thread…" is today.
  - **Project home:** in the box line.
  - **Project settings:** in the box section.
  - It lists the steps with their state and time ("0.4 s", "3 s · usually 2 s", "already built"), then the sign of life, slower-than-usual and the ask (§3.4).
  - When the launch ends, the panel goes away. A failure leaves its InlineError.
- **The compact strip** (L1 (a)), on one line: "VM start · 4/6 · 3 s" plus a 5-segment bar of the box steps.
  - It appears on task cards, the agent rail's waking state, the PhaseChip line, and the session's status chip.
- **The live counter** (L2 (a)): the active step's elapsed time updates once a second, with tabular numerals. This is the one repaint DESIGN §7.2 now admits besides the running tool bar (ADR 0087). Under reduced motion the ring does not spin, but the number still counts.
- **The activity indicator** (L6 (a)):
  - "N in progress", in the rail, and in the phone's top bar (the bottom nav is a fixed four-section grid).
  - It opens a list of every live launch, background image build, clone, lane setup and waiting task. Each row shows its step or waiting reason and its time, and links to its screen.
  - It is hidden when the list is empty.
- **Buttons** (C2 (a)): START, Restart, Rebuild, Launch and Send take their stage label from the launch's running step, for example "Building the image…" or "Starting the VM…", instead of the elapsed-time stages. Launch and Send gain the spinner. Button gains a prop for a stage label shown from the start of the wait (today `stageLabel` appears only after 3 s).

## 4. Lot 2: short loads (C1)

**A `LoadingLine` primitive in `@pap/ui`:**
- before 100 ms: nothing;
- after 100 ms: a spinner and what is read ("Reading the MCP servers…");
- after 3 s: its elapsed time;
- after 10 s: the cause when known. For a Pi read it gives the helper counts, for example "Pi is reading 3 things at once" or "2 reads waiting". For a box operation it says "the box answers slowly".

**One line instead of two.** A Settings section's chunk fallback and its data line become one `LoadingLine` with the section's label.

**Where it replaces today's lines:**
- Settings: MCP, skills, models, availability, GitHub, notifications, health, automation;
- Files and Changes: root folder, file, diff;
- lists: model list, search, sessions sidebar, repository picker;
- the agent's Files, Safety, Status and Packages reads;
- the boot "Loading…".

Every line keeps its live region (polite) and its `…`.

## 5. Constraints

- **Ownership.** Lot 1 owns the daemon, `apps/vmd`, contracts, and the web's boxes, sessions, agents, automation, home and shell rail. Lot 2 owns `LoadingLine` in `packages/ui` and the web's settings, files, changes, lists and auth boot. They share only the contracts, written first, before the lanes split: the `launch` and `helpers` shell events and `TaskView.waiting`.
- **Tests and design rules.**
  - No real pap-vmd in tests (`PAP_TEST_VMD_SOCKET`).
  - Timers go through the kernel `Clock` in the daemon, and through fake timers in web tests.
  - DESIGN.md applies: red means failed, pink means you must answer, neutral means waiting; 44 px coarse targets; EN and FR copy.
  - ADR 0087 records the §7.2 exception and the stuck ask.
- **Bundle and privacy.**
  - The initial bundle stays at or under 249 KB. The step panel and the list are lazy where they can be; the strip and the indicator are small.
  - Privacy: a build line passes the redactor. A launch reaches only its box owner. Helper counts carry no ids.
- **After the merge:** `sudo pap vm setup`, because pap-vmd gains an op. The owner is asked first.

## 6. Left to the plan

- The exact copy (EN/FR) of each step, waiting reason and ask.
- The log RPC's name and permission.
- How Stop maps onto each launch kind.
- Where the activity indicator sits in the rail.
- The strip's segment count when no worker step applies.
