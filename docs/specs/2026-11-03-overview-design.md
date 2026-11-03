# The Overview (Vue d'ensemble)

Owner request (2026-11-03), after comparing pap with rerun's board (github.com/rerun-build/rerun): « J'ai l'impression que ce qui est cool c'est : 7 et 8 » then « partons sur 7 ensemble ». Item 7 is one screen that shows every agent, every box and every running task. Item 8 (more machines) is parked.

Answers (decision 147) are four pages in `docs/design/questions/`:
- `2026-11-03-overview-questions.html`: 12 functional questions.
- `2026-11-03-overview-layouts.html`: layout A, a grid of cards.
- `2026-11-03-overview-phone-states.html`: the phone, the edge states and 4 questions.
- `2026-11-03-overview-members.html`: after the spec review, what the owner sees of members, and the owner's cost cell.

The owner took every recommendation of rounds 1 to 3. One note, on round 1 Q2: the icon sits at the very top of the rail, above the agents. In round 4 the owner took the members recommendation (A) and the all-users cost cell (B). Raw answers: `2026-11-03-overview-answers.json`.

## 1. Why

What runs, what waits and what it costs is spread over six surfaces. Each one shows a slice:

| Surface | Shows | Misses |
|---|---|---|
| Rail | one avatar per agent, presence dot, unread | project boxes, VM phase, cost |
| Tasks board | triggers and task cards per project and per agent, cost today | interactive sessions, box phase, memory |
| Project home | StatusLine and the box fact of one project | every other project |
| Agent status panel | budget, cost, tasks, triggers of one agent | every other agent |
| Inbox | what waits for an answer | what runs without asking |
| Health | failures since the daemon started | what is fine |

The host has 20 GB and no disk swap, and it already ran out of memory with box VMs running. Today "can I start one more box?" has no answer on screen: the `capacity` refusal is the first sign.

## 2. Goals, non-goals, anti-goals

**Goals**
- One screen answers four questions for the viewer's own boxes: what runs, what waits for me, what it costs today, and can I start another box.
- One card per box (agent or box project), sorted by urgency, with its phase, what runs in it, a waiting question, today's cost, its reserved memory, its next scheduled run and its live launch step.
- A capacity band: box memory used against the memory cap, Pi workers against `PAP_MAX_WORKERS`, today's spend.
- Act without leaving: open, start, stop a box, stop a task. ANSWER opens the Inbox item.
- The owner also sees who takes the shared memory: one line per member with no content (M14 holds).

**Non-goals**
- History: no "last 24 h" band. Finished work stays in Tasks and failures in Health; the screen links to Health.
- Answering approvals or questions in place: the Inbox and the thread stay the only places that answer.
- Durations that tick. Start times are fixed ("since 14:02"); DESIGN.md §7.2 stays as it is.
- Any action on a member's box from the owner's view.
- Changes to the Tasks board, which keeps managing triggers.
- Several machines (parked, memory note `multi-host-compute-nodes`).
- Host RAM, disk free, CPU per box.

**Anti-goals** (failures even if it works)
- The owner sees a member's content: a box, project, agent, session or task name, a title, a question (M14 §2 and §6: "the owner sees members' usage and costs, not their content").
- A member sees anything of another user, or the GB figures of the shared memory.
- The band says a box fits and the start is refused for `capacity`, or the opposite: both must come from the same computation.
- Opening the screen, or a card, starts a box.
- Polling.
- A second count of waiting items that competes with the Inbox badge.
- A full memory band drawn in red: nothing is broken.

## 3. What the person sees

Mockups: the four pages above. Layout A is the reference. The member lines are in the round 4 page, option A.

### 3.1 Entry

- **Rail**: one icon button at the very top, right under the logo and above the agent avatars, then a separator (the owner's note on Q2). Its label and tooltip read "Overview". It has no badge: the Inbox keeps the only count of what waits. When the Overview tab is active, the icon gets the selected rule (agent colour), like any active rail item.
- **⌘K**: "Open overview" in the Open group.
- **Shortcut**: one default chord, registered like the agent chords and listed in Keyboard shortcuts.
- **Tab**: a singleton item kind `overview` at the path `/overview`, title "Overview". It splits next to a thread like any pane (minimum 320 px).
- **Opening screen**: pap still opens on the Home. Settings › Appearance gets "Open on: Home / Overview" (default Home), stored in the account's Appearance document like the rail position.

### 3.2 The capacity band (owner)

Three cells in one row, each a HUD label, a tabular figure and, where there is a limit, a `Meter`:

| Cell | Figure | Meter |
|---|---|---|
| BOX MEMORY | `8.0 / 10 GB` | agent colour |
| PI WORKERS | `4 / 6` | neutral (`--text-muted`) |
| COST TODAY · ALL | `$1.84`, under it "of which members $0.27" | none: it is a total with no budget (round 4, Q2 B) |

- **Memory**: the memory of every running VM, of all users. Each VM counts its `memoryMb` plus `VM_OVERHEAD_MB`. The cap is the resolved one (`config.agentsMemoryMaxMb`: `PAP_AGENTS_MEMORY_MAX_MB`, or max(1024, half the RAM) when unset).
- **Workers**: the counter that refuses a fork, `used` (live plus starting) against `max`, shared by all users (`sessions` automation port, `workers()`).
- **Cost**: every user's spend today, in the usage zone and with the usage labelling (API-equivalent on a subscription). The owner's daily budget stays in Settings › Automation and on the agent panels; it is not drawn here.
- **Full**: when no VM of the smallest size fits, the memory cell adds the word FULL. The smallest size is the minimum `memoryMb` of the resources schema (512, exported as a constant) plus the overhead. The meter stays in the agent colour, with no red and no pink.
- **Agents unavailable** (no KVM, pap-vmd absent, E3): the memory cell reads "—", and the workers and cost cells stay.

### 3.3 The capacity band (member)

Round 3, Q1:

| Cell | Figure | Meter |
|---|---|---|
| SHARED CAPACITY | the host's box memory in use, all users, the member's own included, as a percentage rounded to 5 % | agent colour |
| YOUR BOXES | the memory their running boxes reserve, in GB | agent colour, against the cap |
| YOUR COST TODAY | their spend against their budget line (`users.setBudget`), or "no budget" | you colour |

A member never sees GB figures of the shared memory, the free memory, the worker count or anything of another user.

### 3.4 Groups and order

**The owner's view:**
- A group "You" holds the owner's own cards.
- Below it, a section "Members" holds one line per member who is not disabled, ordered by name. Columns: name · active boxes · reserved memory · cost today / budget.
- There are no box names, no titles, no states and no actions on these lines. These are the figures Settings › Users already shows, kept live here.
- Members with no running box show 0, in the muted tone.

**The member's view:** their own cards, with no group header.

**Order of the cards**, by urgency (Q5), with the box's name breaking ties:
1. waiting for an answer;
2. failed;
3. running;
4. starting.

A card moves when its state changes.

**Stopped boxes** fold into one dashed strip after the cards: "N stopped", their names, then EXPAND. Expanded, each one is a compact row with its next run and START.

**Nothing active** (E1): when the viewer has no active box, the strip starts expanded, under one muted line: "Nothing is running. Start a box or open an agent to talk to it."

### 3.5 A card

The header holds:
- the identity: the agent avatar and name, or the box glyph and the project name, with a muted kind (Agent · Project · Project on this host);
- the state chip, which carries the urgency word: WAITING (`att`), FAILED (`err`), RUNNING (`run`), STARTING (`run`).

The body, in this order, keeps only the lines that apply:
- **Launch step** while the box starts: the running step's own words and its counter ("Starting the VM… 00:07"), from the `launches` stream (the ADR 0087 counter exception).
- **What runs**: at most three lines, the thread, the running sessions and the running tasks (an isolated task included). Each reads "<kind> · <title> · since <HH:MM>", and a running task adds STOP. Past three lines: "+N more", which opens the box.
- **The waiting question**: a pink block with its category and title, and ANSWER, which opens that item in the Inbox (the drawer; a sheet on a phone).
- **Facts**, one muted row:
  - cost today;
  - reserved memory: the sum over the box's live VMs, its isolated tasks' included; 0 when stopped;
  - the next scheduled run: the nearest `nextFireAt` of the box's enabled triggers, as "18:00 · Evening pulse", "tomorrow 02:00" or "Mon 07:00";
  - the phase chip: the phase of the box's thread VM (STOPPED `mut`, STARTING `run`, RUNNING `ok`, PAUSED `mut`);
  - the box action, START or STOP.

**What the state words mean:**
- **WAITING**: for an agent, the rail's `needs_input`. For a project, a session in it has `needsInput`, or one of its tasks waits for input.
- **FAILED**: for an agent, the rail's `failed`. For a project, a box paused after 3 crashes in 10 minutes (the `box_paused` Inbox item), or its newest task ended `failed` and nothing ran in the box since.
- **RUNNING**: a session, the thread or a task runs.
- **STARTING**: the box's thread VM starts.
- **Stopped**: no VM is up.

**Host projects** (round 3, Q3): a card "Project on this host" appears only while one of its sessions runs. It has no phase and no memory ("no box").

### 3.6 Actions (own boxes only)

- **Open**: the card's name opens the agent tab, the project home or the task. The whole card is not one big button, because it holds its own buttons.
- **START**:
  - `agents.startBox` or `projects.startBox`;
  - disabled when the box does not fit, with the reason visible and named by `aria-describedby`;
  - the owner reads "Not enough memory: 2.5 GB needed, 0.5 GB free. Stop a box to start another." (E4);
  - a member reads "Not enough shared memory: this box needs 2.5 GB. Stop one of your boxes or try again later.";
  - a refusal that still comes back (a race) uses the three-part text of the box fact (DESIGN.md §11).
- **STOP** (a running box):
  - asks for confirmation only when something runs in it;
  - the dialog names what stops and what stays intact: "Stop CyberLooker's box? The task "Weekly scan" will be interrupted. The thread and the box's files are intact; the task can be retried." (E5);
  - Cancel is secondary, and the confirming button is primary, not danger (stopping can be undone).
- **STOP** (a starting box): it cancels the launch through `launches.stop`.
- **STOP** (a task): `automation.tasks.cancel`, with no dialog, like the Tasks board.
- **ANSWER**: opens the Inbox item; it never answers on the card.
- Every control follows the Orca timing rule (§7.3): disabled at once, a spinner after 1 s, the stage words after 3 s.

### 3.7 Phone

The bottom nav's Agents tab shows the Overview instead of the agent list (round 1, Q11):
- the tab keeps its badge (total unread);
- the top bar's "+" offers New agent and New project;
- a stopped agent opens from the stopped strip;
- the band is compact (three narrow cells), with one card per row;
- the owner's member lines stack as two columns;
- ANSWER opens the Inbox item in a bottom sheet;
- targets are 44 px under a coarse pointer.

### 3.8 Empty states

- **E2 · First run** (the viewer has no box at all): an EmptyState reading "Here you will see every agent and every project: what runs, what waits for you, what it costs." Its one primary is New project, with New agent beside it as secondary (round 3, Q4).
- **E3 · Agents unavailable**: the sentence of `NoVmState` ("Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`.") with CHECK AGAIN, then any host-project card.

### 3.9 Copy

- English and French in the i18n catalog.
- The glossary in `docs/agents/web.md` gains **Overview** (French « Vue d'ensemble »).
- Numbers are tabular: `$0.00`, `1.5 GB` (« 1,5 Go »), `HH:MM`.

## 4. Data and daemon

| Need | Today | Change |
|---|---|---|
| Memory used / cap | inside `runtime-start.ts`: the fit check (`fitsCapacity`) and, separately, `used` for the `capacity` error; never exposed | one shared function that returns `used` and `max`, called by the start check, the error and the new read |
| Smallest VM | `memoryMb` minimum 512 in the resources schema | export it as a constant |
| Workers used / max | `automation-port.ts` `workers()` | read by the new read |
| Spend today | the `usage` stream `spend` event, per user | a sum over all users for the owner's cell, plus the members' part |
| Per-box cost today | per agent in `agents.status`; nothing per project | summed from `runs` joined to their session's project or agent, since local midnight in the usage zone; no migration |
| Box phase | `runtime.phase(box)`; the `shell` stream (projects); `agents.vmStatus` (agents) | read into one shape: the thread VM's phase |
| Reserved memory per box | the runtime entries | the sum over the box's live VMs |
| Next run | `TriggerView.nextFireAt` | the minimum over the box's enabled triggers |
| Stop a box | `box-control.stop(projectId)` (queued with starts and restarts) for projects; the agents path that stops listed VMs; neither is reachable by RPC | new `projects.stopBox` and `agents.stopBox`, thin handlers over those |
| Member lines | Settings › Users' per-member usage, budget and running boxes | the same figures in the owner's read |

- **New read `overview.get`**: one bounded snapshot of the capacity band (in the viewer's form, §3.2 or §3.3) and the viewer's own boxes with every field in §3.5. For the owner it adds the member lines (§3.4): figures only, never a name of a box, session, task or agent.
  - It is computed by the daemon and scoped by the auth port's role (`roleOf`).
  - Its permission is declared in `packages/contracts/src/methods.ts`, and members are allowed.
  - A test proves that the owner's snapshot holds no member content.
- **Live**: a new stream `subscribe.overview` sends a payload-less `changed` tick to every viewer a change concerns: the box's user, and the owner when it moves a member line or the band. The client reads `overview.get` again, debounced to 1 s (the agent status panel's pattern). Nothing is polled.
  - The ticks come from what the daemon already emits: `runtime.onPhase`, box-control's start and stop notices, session status, task changes, agent rail state and spend.
  - A source that offers no listener to other modules gets one through its module's `index.ts`. No new event bus.
- **Launch steps**: the client takes them from the `launches` stream it already opens.
- **Stop box**:
  - It stops every VM of the box, its isolated tasks' included.
  - Running work ends the way a box restart ends it today: workers exit, sessions are interrupted, transcripts stay intact, tasks are retryable.
  - Stops queue behind starts and restarts (box-control's order). A stop of a box that is already stopped answers ok.
- **Capacity refusals to a member**: the `capacity` error keeps `used` and `max` for the owner. The error mapping drops them for a member.
- **Bounds**: the snapshot respects the existing caps (32 agents per user, `SHELL_LIMITS.projects`). Activity lines are capped at three per box in the read, plus a count.

## 5. Constraints

- CI rules in `AGENTS.md`:
  - 400 lines per file;
  - a daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`;
  - handlers decode, call one service method and map errors;
  - tokens only (no raw colours);
  - erasable TypeScript;
  - timers through `Clock`, no sleeps.
- **Web**:
  - the Overview pane is a lazy chunk with its `LAZY_MARKERS` row;
  - the rail icon is eager and small;
  - the bundle budgets (`pnpm budgets`) stay green.
- **Tests**:
  - unit tests for the urgency order, the fit and FULL rule, the member percentage and the state words;
  - int tests for `overview.get` scoping (a member never sees another user's box; the owner's member lines hold no content), for stop box and for the member's capacity refusal without figures;
  - process backend only (`PAP_TEST_AGENT_RUNTIME=process`, `PAP_TEST_VMD_SOCKET`): no test reaches the real pap-vmd.
- **Docs**:
  - `docs/agents/web.md` (an Overview section and the glossary);
  - `docs/agents/agents-vm.md` (stop box);
  - `docs/agents/finops.md` (the all-users cost cell);
  - `DESIGN.md` §10 (a screen row pointing at the layouts page).

## 6. Decided by the owner

- **Round 1**:
  - Name: Overview / Vue d'ensemble.
  - Entry: a singleton tab at the top of the rail, and ⌘K.
  - Opening screen: the Home, plus a setting.
  - Unit: one card per box.
  - Order: urgency.
  - Stopped boxes: folded.
  - Card fields: phase, activity, question, cost, memory, next run, launch step.
  - Band: memory, workers, cost.
  - Actions: open, start and stop, stop a task, ANSWER opens the Inbox.
  - Phone: the Agents tab.
  - Time: the present only, with fixed start times.
- **Round 2**: layout A, a grid of cards.
- **Round 3**:
  - The member band (shared percentage, their boxes, their cost).
  - No rail badge.
  - Host projects shown while a session runs.
  - The first-run primary is New project.
- **Round 4**:
  - Members appear to the owner as one content-free line each, with M14 unchanged. This replaces round 1 Q10's "the owner sees all, grouped by person".
  - The owner's cost cell is every user's spend today, with no budget.

## 7. Calls made by the designer (check them)

- The memory meter uses the agent colour and the workers meter neutral. The member's cost meter uses the you colour; the owner's all-users cost has no meter.
- FULL means the smallest possible VM no longer fits; it is a word, not a colour.
- The stopped strip starts expanded when nothing is active.
- The stop-box confirmation is primary, not danger, and appears only when something runs. STOP on a starting box cancels the launch.
- "Open on" lives in the account's Appearance document.
- The member's percentage is rounded to 5 %, their own boxes included, and their refusals carry no figures.
- The phase chip is the thread VM's phase; an isolated task shows as an activity line and adds its memory.
- The FAILED rules for a project (§3.5).
- One stream of ticks plus a snapshot read, rather than a payload stream.
- Disabled members do not appear on the member lines.

## 8. Left to the builder

- The default shortcut chord.
- The exact catalog keys.
- How the debounce is shared with the status panel.
- How the per-box cost query is indexed.
- Whether `overview.get` reuses an existing read permission or gets a new one, as long as members are allowed and the role decides the scope.
