# Overview final whole-branch review (J2)

Opus, read-only, range `ca8587e3..adc5633a`. Its five Important findings were fixed in one wave (`a9a39ae8..edc4e5d8`) and a scoped Sonnet re-review found 11/11 addressed (`overview-sdd-ledger.md`).


I read the 548 KB package in passes: the commit list and stat first, then the contracts, then the daemon module and its wiring (overview/, compose-overview, daemon.ts, compose-agents-vm*, sessions, automation, inbox, runs, health, agent-vm), then the web (the pane, the hook, the actions, the shell, the phone, Open on), then the docs and the ledger. I read the source at head in /home/ubuntu/Workspace/soulkyu/pap-overview, not only the diff. I checked the reference mockup docs/design/questions/2026-11-03-overview-layouts.html where the spec left room. I ran no test suites and changed nothing.

### Strengths
- **M14 holds end to end.**
  - Every read that returns content takes the viewer id from `ctx.caller.userId`, never from a param: `shellRows`, `threadOf` (checks `row.ownerId`), `activeTasks` (`store.board(ownerId)`), `pendingToHandle`, `unresolvedRefs`, `listEnabledOf` (SQL `owner_id = $ownerId`), `todayByBox`, `liveRuns`, `agents.list`, `projects.all`.
  - Member lines are built from six fields only, and `OverviewSnapshot` (strict) is parsed before the snapshot leaves.
  - Member lines need `users:read` and the failure count needs `pi:admin`.
  - Ticks carry no data.
  - The int test (`overview.int.test.ts`) covers the named secrets, the ids, the member id appearing only once, a token's scope, and the member's percentage rounded to 5.
- **One memory computation.**
  - `memoryInUseMb` runs over `[...entries.values()]` in the start check, in the error's `used` and in `memory()`.
  - `fitsMb` is the same formula as `fitsCapacity`.
  - `runtime-start.ts:59` is the only `capacity` refusal on the VM start path, and the `memory` detail never reaches the wire (`dispatcher.ts:108`).
- **Stop semantics are right.**
  - `projects.stopBox` goes through box-control's `inOrder`.
  - `agents.stopBox` waits for `inflight` and then calls the link's `stop`.
  - A deliberate stop never counts as a crash (`onClosed` returns early on `stopping`).
  - STOP on a starting box goes to `launches.stop`.
- **Production wiring is real.**
  - The listeners come from production objects (`publisher.onStatus`, `stream.onRailChange`, `createTriggerChanges`), and the int tick test runs on the real composition.
  - Closers are registered.
  - The pane is lazy (`overview-pane-entry.tsx`, a `LAZY_MARKERS` row). Only `OverviewRoute` and the icon are eager, and `OverviewRoute` pulls only stores.
- **Repo rules.** Every code file is at 400 lines or under, module boundaries hold, no feature imports another, there are no arbitrary or raw colour values, and the EN/FR catalogs are type-locked. DESIGN roles are right: WAITING is `att`, FAILED is `err`, FULL is a neutral word, the confirm button is primary.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
1. **E3 shows a wrong refusal reason on every stopped box.**
   - Where: `apps/daemon/src/modules/overview/snapshot.ts:156` and `apps/web/src/routes/shell/overview-actions.tsx:22`.
   - What: when `vmUsable` is false, `memory` is null, so `fit()` returns false for every agent and box project. The pane still lists them in the stopped strip. `NoMemory` then falls back to the member copy, so the owner reads "Not enough shared memory: this box needs 2.5 GB. Stop one of your boxes or try again later." on every row.
   - Why it matters: spec §3.8 says E3 is followed only by host-project cards. The text points the person at memory when the fix is KVM or pap-vmd. The transient case is realistic: pap-vmd down after an update.
   - Fix: when `memory === null` (owner) or `sharedPercent === null` (member), render no START and no reason (E3 already explains), or drop agent and box cards from the pane under E3. Add a test.
2. **Activity lines tick ("since 5 min") instead of a fixed start time.**
   - Where: `apps/web/src/features/overview/overview.vm.ts:55` (`formatAge`) and `OverviewPane.tsx:37` (a minute interval re-renders it).
   - Why it matters: the owner chose fixed start times in round 1 ("Time: the present only, with fixed start times"). Spec §2's non-goal is "Durations that tick. Start times are fixed ('since 14:02')", and §3.5 asks for `since <HH:MM>`. The mockup reads « depuis 14:02 ».
   - Fix: format `since` as the time of day (the `Intl` time already used in `nextRunText`). Update the vm and pane tests.
3. **The stopped strip leaves out the next run.**
   - Where: `apps/web/src/features/overview/StoppedStrip.tsx:42-60`.
   - Why it matters: spec §3.4 says each expanded row shows "its next run and START". The snapshot already carries `nextRun` for stopped boxes and the daemon tests it, but the web drops it. That is the one fact that matters for a stopped agent with a scheduled pulse.
   - Fix: render `nextRunText` in the row (pass `now` down).
4. **Box actions follow the state word instead of the VM phase.**
   - Where: `apps/web/src/routes/shell/overview-actions.tsx:117-119`.
   - What: START is offered only when `state === "stopped"`, so a FAILED or WAITING card whose box is down gets no action. Layout A draws exactly that card (homelab, « Échec », phase « Arrêtée », « Démarrer »). A crash-paused box (`phase === "paused"`, FAILED via `box_paused`) gets STOP, which is a no-op: `runtime.stop` has no entries and the box stays `paused`, because only `restart` calls `resume`.
   - Fix:
     - show START whenever `phase === "stopped"`;
     - for `paused`, offer the project's restart (`projects.restartBox`, which resumes), or no button, never STOP.
5. **An agent's thread line and its session ask open a bare session tab.**
   - Where: `apps/web/src/features/overview/BoxCard.tsx:50` and `:68`.
   - What: both call `openSession(threadId)`. Everywhere else the app opens an agent's thread through the agent tab (`InboxDrawer.tsx:42-48`: `{ kind: "agent" }`).
   - Why it matters: the bare `SessionPane` has no `agentId`, so there is no status panel and no box strip, and the same thread can end up in two tabs.
   - Fix: on an agent card, route `kind === "thread"` activities and `ask.source === "session"` to `on.openAgent(box.ref.id)`.

#### Minor (Nice to Have)
- `snapshot.ts:159`: a card's `apiEquivalent` uses the owner-wide `spend.subscription`, so an API-billed box can be labelled "API-equivalent included". `box-spend.ts:56` already has `group.subscription` per group, so keeping it per box is a few lines.
- `packages/contracts/src/overview-methods.ts:6`: the comment says "an owner sees every box's state". That is wrong (the owner sees their own boxes plus content-free lines), and it is the kind of comment that misleads on M14.
- `docs/agents/daemon.md:183` still names `triggers.listEnabled` (now `listEnabledOf`). `:186` says `agents.vmStatus` shares the 5 s cache, but `view()` always calls `fresh()`.
- `BoxCard.tsx:137`:
  - the next run renders "name · time"; spec and mockup show « Prochaine 18:00 · Pulse du soir »;
  - `hour: "numeric"` gives "6:00 PM" in `en`, where §3.9 asks for HH:MM.
- A FAILED card says nothing about what failed. The mockup shows « Nightly backup check · échouée à 13:10 »; the spec is silent.
- Phone (§3.7): `min-w-pane` band cells stack on a phone instead of three narrow cells; member lines use `grid-cols-3`, not two columns; a 0 on a member line is not muted.
- A member line's `activeBoxes` counts `running` only, while `reservedMb` includes `starting` (`snapshot.ts:322`).
- Dead catalog keys `overview.open` and `overview.start` (only `lazy-catalog.overview.test.ts` uses them).
- R2 ticks every viewer on every change, including the owner's private `onLiveCost` and session events. A member can see when the owner is active (timing only, no content). Most sources already carry `ownerId`, so per-user routing is a cheap follow-up.
- STOP on an "idle" running box asks nothing even when a box terminal or a preview service runs: `busy` ignores terminals.
- `StopBoxDialog`'s list names only the three capped activities and leaves out `more`.
- Spec §5 asks for an int test of the member's capacity refusal without figures. None exists; the behaviour already exists in the dispatcher.
- `OverviewRoute.openTask` usually lands on the Tasks board, because the tasks store is loaded only while the board is open. Carrying the task's `sessionId` in the activity would fix it.
- `use-overview.ts` reads twice on mount: the first read, then the snapshot tick frame. A stream failure only reports and leaves the pane silently stale (`failed` stays false).
- `LaunchLine` shows the step words but not the counter. Spec §3.5 says "and its counter"; the T6 ruling said "step words only".
- Plurals: "1 recent failures", « 1 arrêtées ».

### Deferred minors triage
None of them blocks the merge. One is worth taking into the fix round.
- T1 decision-109 comment: fixed (adc5633a).
- T1 methods.ts / methods.test.ts at 400 lines: can wait (the next edit must extract first).
- T1 daemon.ts import order (temporary file): moot, the file is deleted.
- T1 no `OVERVIEW_LIMITS` crossing tests: fixed (48cd1625).
- T1 `Usd` without `.finite()`: can wait.
- T2 `memory()` test mixes running and starting, no stopping case: can wait (cheap to add with the fix round).
- T3 no mutation check of `inOrder` for stop, no int test of stop during an agent start: can wait.
- T3 microtask yields in agent-stop.test, swallowed error without a log: can wait.
- T3 docs claims not asserted: can wait.
- T4 box-spend 48 h bound not crossed: can wait.
- T4 automation/index.ts at 400 lines: resolved (382).
- T5 no tick on a budget change or a new member, no shellRows unit test, health count test written after the code: can wait.
- T5 `usable()` without dedupe: fixed (e716d619). The doc still overclaims (Minor above).
- T5 per-read cost: the triggers read is fixed (3c5d294c); the `auth.users()` rescan per member can wait.
- T5 no cap-crossing tests: fixed.
- T5 FAILED rule uses a session's `updatedAt`: can wait.
- T5 the int tick test cannot tell ticks apart: can wait.
- T5 no tick on health records, user, budget or disable changes: can wait.
- T5 card `apiEquivalent` owner-wide: take it into the fix round (trivial, a cost label people read). The rest of that line (snapshot-bed placement, the ask recompute, daemon.ts at 399) can wait.
- T5 `OverviewThreadFacts.starting` unused: can wait.
- T5 daemon.md gate and threadOf: fixed; only the `listEnabled` name is stale (Minor).
- T5 `sessionActivity` kind parameter, stream test matching an earlier frame: can wait.
- T6 missing tests, stray await, E2 reusing the title, sync throw, truncated titles: can wait.
- T7 generic error text on a refused task cancel or launch stop: can wait.
- T7 Cancel/Escape live while pending: fixed (3f60aa3a). The empty padded div, the Error-string contract and the missing tests can wait.
- T8 unused catalog keys: the agentsPhone and openOn keys are fixed; `overview.open` and `overview.start` remain (can wait).
- T8 gallery example: fixed. Open on reading the device-cached account (by design) and the rail state read from the URL can wait.

### Declined to judge
- R2 ticking every subscriber, where spec §4 says only the viewers a change concerns: an owner-approved plan ruling. I only raise the timing side channel above.
- R8: the Overview has its own "+", and the phone top bar keeps `session.new`. A plan ruling.
- YOUR BOXES has no meter against the cap (§3.3). A meter next to a GB figure would reveal the cap, which conflicts with the M14 rule in the same section, so the implementation's choice is defensible. Worth a line in the decisions log.
- Visual placement: the phase chip in the header rather than the facts row, and button casing. Left to the planned join screenshots against layout A.
- `InlineError tone="attn"` on the stale banner: a DESIGN grey area, since the gallery uses that tone.
- Controller rulings: the owner's total includes disabled members, an idle box that is up reads RUNNING, `box_paused` means FAILED only while the box is down, owner tokens see `capacity.cost`, `threadOf` instead of `shellRows`.
- Cost per read under R2's ceiling (one `overview.get` a second per viewer while anything streams): an accepted plan trade-off.
- R7: an agent's phase comes from an isolated task VM when it has no thread VM.
- R11: Open on is device-cached and applies to the first load only.
- Edge cases outside the spec: a running host session outside the shell window, browser zone versus owner zone for "tomorrow", and whether opening an agent tab starts a VM (existing behaviour).

### Recommendations
- One fix round for Important 1–5 plus the per-box `apiEquivalent`. Each is local to `overview-actions.tsx`, `BoxCard.tsx`, `StoppedStrip.tsx`, `overview.vm.ts` or `snapshot.ts` and their tests, so `vitest related` is enough.
- Fold the `daemon.md:183/186` and `overview-methods.ts:6` text fixes into the same round.
- The join screenshots (podman Playwright, Night and phone width) should check the stopped-strip next run, the fixed `since` times and the FAILED card against layout A.

### Assessment
**Ready to merge?** With fixes.
**Reasoning:** M14 scoping, the single memory computation, stop ordering and the production wiring are sound and tested. Five web-side gaps would still mislead a person or block an action they expect: the wrong E3 refusal text, ticking ages instead of fixed times, the missing next run on stopped rows, no START on a down FAILED box and a no-op STOP on a paused one, and agent threads opening outside the agent tab. All are small and should be fixed in one round before merging.
