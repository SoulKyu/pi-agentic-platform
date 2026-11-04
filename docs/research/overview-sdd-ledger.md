# Overview SDD ledger

Archived from the SDD workspace at the merge (decision 148). Rulings: `overview-rulings.md`; final review: `overview-final-review.md`.


Spec: docs/specs/2026-11-03-overview-design.md (decision 147)
Worktree: /home/ubuntu/Workspace/soulkyu/pap-overview, branch feat/overview, from main ca8587e3.
Owner approvals (2026-11-03): model table as in the plan; Opus escalation at fix rounds 4–5 OK for this run; reply « étape fini » per step.

## Pre-flight conflict scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T5 | `OverviewSnapshot`, `OwnerCapacity.failures`, `OverviewMemberLine` (6 fields), `vmUsable` | agrees |
| T1 → T6/T7 | `OverviewActivity.stoppable`, `OverviewBox.busy/needMb/fits`, `OverviewAsk` | agrees |
| T1 → T8 | `openOn` in `AccountAppearanceFields` + web `DEFAULT_ACCOUNT` (T1), form + landing (T8) | agrees |
| T2 → T5 | `memory()`, `reservedMb(box)`, `phase`; `fitsCapacity` vs T5 `fitsMb` | same formula `used + need <= max`; agrees |
| T1/T3 → T7 | `projects.stopBox`, `agents.stopBox` contracts (T1), handlers (T3), web overloads (T7) | agrees |
| T4 → T5 | `todayByBox` (with `totalUsd`), `liveRuns`, `pendingToHandle`, `onStatus`, `onRailChange`, `onTriggerChanged` | agrees (R5 owner total = own `totalUsd` + members' `memberSpentToday`) |
| T6 → T8 | `OverviewPane`, `OverviewCallbacks`, `register-overview.ts`, the `overview` stream opener, the E1 strings for `LAZY_MARKERS` | agrees |
| T7 → T8 | `overviewActions` → `OVERVIEW_CALLBACKS.actions` | agrees |
| T6 / T8 (packages/ui) | T6 `Meter` kind neutral; T8 `IconButton.selected`, `IconOverview` | different files; both touch the /dev/ui gallery: T8 rebases on T6, sequential, fine |
| T1 self | creates overview.ts/overview-methods.ts, modifies the listed files; tests match the interfaces | agrees |
| T2 self | `memoryInUseMb`, `fitsCapacity` rewrite, `memory()`, `reservedMb` vs tests | agrees |
| T3 self | int test asserts `agents.vmStatus` reports `stopped` | see P3 |
| T4 self | interfaces vs tests | agrees |
| T5 self | rules tests vs `fitsMb`/`isFull` (fixed in self-review: 3072/3073), member percent rounding | agrees |
| T6 self | band test text `8.0 / 10 GB` vs "GB with one decimal"; `80 %` | see P1, P2 |
| T7 self | owner copy `2.5 GB needed, 0.5 GB free` | agrees with P2 |
| T8 self | tests vs files | agrees |

Ruling P1: percentages render through the catalog as `{value}%` in EN and `{value} %` in FR (plain space; the test checks the rendered text) — French typography, no Intl percent formatting — cost if wrong: one catalog string.
Ruling P2: GB = MB / 1024, always one decimal (EN `8.0 / 10.0 GB`, FR `8,0 / 10,0 Go`, locale decimal separator); the T6 test expects `8.0 / 10.0 GB`, not `10 GB` — why: one formatting rule everywhere, no special case — cost if wrong: a test string and a formatter.
Ruling P3: in T3's int test, "the agent VM is stopped" is asserted through the runtime's phase (`stopped`) or the daemon's VM status read that the process backend actually serves, whichever exists on the process backend; the implementer picks the one the backend implements and says which — cost if wrong: a weaker assertion on one line.

## Progress
Task 1: dispatched (implementer sonnet a5baf96f, BASE ca8587e3)
Task 1: implementer DONE_WITH_CONCERNS fc5528fb — typecheck red at daemon.ts:283 (HandlerTable lacks the 4 new methods)
Ruling: T1 adds temporary handlers for projects.stopBox, agents.stopBox, overview.get, subscribe.overview in one file apps/daemon/src/overview-pending-handlers.ts (each throws PapError("internal")), spread into daemon.ts's handler table; T3 replaces the two stop handlers and T5 the two overview ones, and the last of them deletes the file — why: every task gate stays green (typecheck) without building T3/T5 early — cost if wrong: one throwaway file on the branch, never on main.
Task 1: implementer DONE fc5528fb..3ffd192a (gate green); review dispatched (sonnet a706e04c)
Task 1: review Approved (sonnet). ⚠️ resolved by controller: typecheck re-run green at 3ffd192a; the dispatcher checks permissions before any handler, the stubs throw internal.
Task 1: minor (deferred): agents-resources.ts — the "Decision 109 … RT-30" comment now sits above MIN_VM_MEMORY_MB, not AgentResources
Task 1: minor (deferred): methods.ts and methods.test.ts are exactly at the 400-line cap (blank lines removed)
Task 1: minor (deferred): daemon.ts:1 — the overview-pending-handlers import is out of import order (temporary file)
Task 1: minor (deferred): no crossing tests for OVERVIEW_LIMITS boxes (600) / members (64); no mutation checks reported
Task 1: minor (deferred): Usd = z.number().min(0) without .finite()
Task 1: complete (commits ca8587e3..3ffd192a, review clean)
Task 2: dispatched (implementer sonnet a634114f, BASE 3ffd192a)
Task 2: implementer DONE_WITH_CONCERNS 84143295 — knip red on the new VmPhase/VmPhaseChange exports (unused until T5)
Ruling: the VmPhase/VmPhaseChange exports from agent-vm/index.ts move to Task 5, the task that imports them — why: knip must stay green per task; no behaviour depends on the export — cost if wrong: T5 adds two export lines.
Task 2: implementer DONE 84143295..f88a1f0c
Task 2: review Approved (sonnet). ⚠️ knip: implementer's fix report shows knip exit 0 at f88a1f0c (exports dropped per ruling).
Task 2: minor (deferred): runtime.test.ts — the memory() test mixes the running and starting cases in one it; no stopping-entry case
Task 2: complete (commits 3ffd192a..f88a1f0c, review clean)
Task 3: dispatched (implementer sonnet a44dd654, BASE f88a1f0c)
Task 3: implementer DONE_WITH_CONCERNS 8202bab8 — m14.matrix.int "member-own without a foreign input" red: overview.get/subscribe.overview → internal (T1's temporary handlers)
Ruling: until Task 5 lands, task gates accept exactly that one m14.matrix failure (member-own overview.get and subscribe.overview → internal, caused by the temporary handlers); Task 5's gate must show it green; any other failure is real — why: the stubs exist only to keep typecheck green, and making them answer for real would build T5 early — cost if wrong: a red int test on the branch between T1 and T5, never on main.
Task 3: note: tests written after the implementation; RED reproduced by sabotaging both handlers (3 int tests failed); mutation checks real (inflight wait, agent owner, project owner).
Task 3: review dispatched (sonnet a6da3830)
Task 3: review Approved (sonnet). ⚠️ resolved: the stop methods' permissions live in their defineMethod (project-box-methods.ts, agents-vm-methods.ts; checked in T1's review); retryable tasks / isolated VMs are runtime.stop's inherited behaviour (deferred minor below).
Task 3: minor (deferred): no mutation check of box-control's inOrder for stop; no int test of agents.stopBox during an in-flight agents.startBox (unit only)
Task 3: minor (deferred): agent-stop.test.ts uses two Promise.resolve() yields (microtask-depth brittle); agent-stop.ts:395 swallow has no log (brief-mandated)
Task 3: minor (deferred): docs claims (isolated tasks stopped, tasks retryable) not asserted by a test
Task 3: complete (commits f88a1f0c..8202bab8, review clean)
Task 4: dispatched (implementer sonnet aa05dc24, BASE 8202bab8)
Task 4: implementer DONE_WITH_CONCERNS 6be0384b
Ruling: box spend with apiOnly also excludes provider claude-bridge, exactly like spentApiSince/memberSpent — why: R5 wants a member's cards to add up to their budget-line cell, and the budget line exempts claude-bridge (finops.md) — cost if wrong: one SQL predicate.
Ruling: a run with agent_id counts for its agent only, never for a project; totalUsd counts every run — why: agent sessions have no project; no double count — cost if wrong: per-card figures.
Task 4: note for T5: onRailChange lives on the agents stream object built in compose-m11.ts (no AgentsModule object); onStatus is on SessionsModule (ShellStatusFeed); createBoxSpend is exported from runs/index.ts with an @public tag (remove the tag once T5 uses it).
Task 4: review dispatched (sonnet a6b64e86)
Task 4: review Approved (sonnet). ⚠️ full runs: implementer's report (unit related 3372 pass; integration related 666 pass + the accepted m14.matrix failure).
Task 4: minor (deferred): box-spend 48 h started_at lower bound not crossed by a test (same idiom as agentSpentToday)
Task 4: minor (deferred): automation/index.ts exactly at 400 lines (next change must extract first)
Task 4: complete (commits 8202bab8..6be0384b, review clean)
Task 5: dispatched (implementer sonnet a7de147e, BASE 6be0384b)
Task 5: implementer DONE_WITH_CONCERNS 19d49800 (int related 690 pass, overview.int 5/5, m14.matrix 9/9 green)
Ruling: createOverviewSnapshot takes (viewerId, vmUsable) — the VM stack check is async (VmStatus.usable, 5 s cache) — cost if wrong: a signature.
Ruling: a box whose VM is up with nothing running shows as RUNNING (an active card, not in the stopped strip); its phase chip says Running — why: it reserves memory and can be stopped, so it belongs with the active cards; the contract has no idle state — cost if wrong: one state word on idle boxes.
Ruling: a box_paused item makes a project FAILED only while its VM is down (the item is never resolved) — cost if wrong: a stale FAILED after a restart is avoided; none.
Ruling: the owner's total includes a disabled member's spend today while member lines exclude disabled members — why: the total is what the installation spent — cost if wrong: "of which members" can exceed the sum of the lines.
Task 5: minor (deferred): budget change / new member emit no tick (refresh at the next tick); shellRows has no direct unit test (int-covered); HealthModule.count test written after the code (mutation-checked)
Task 5: controller killed 3 orphan wait loops left by the implementer (until-grep/pgrep -f loops)
Task 5: review (opus) Needs fixes — 0 Critical, 1 Important: an agent's thread never reaches its card (shellRows excludes agent threads; unit fakes hide it) — partly plan-mandated (the brief named the shell rows)
Ruling: the agent card's thread comes from an owner-checked read of the agent's thread session (or liveRuns.has(threadSessionId) + the rail's needs_input with the thread id), not from shellRows — why: spec §3.5/§3.6 need the thread line, its ask and busy — cost if wrong: one more sessions read.
Ruling: promote review Minor 1 (token scope) to the fix round: member lines need the caller to hold users:read and the failures count pi:admin; otherwise members: [] and failures: null — why: a sessions:read token must not read what users.list and Health gate (security by default) — cost if wrong: an owner token sees less on the Overview.
Task 5: minor (deferred): VmStatus.usable() has no in-flight dedupe (N viewers → N vmd.health after TTL; daemon.md:186 overclaims)
Task 5: minor (deferred): per-read cost — every overview.get parses all owners' enabled triggers (owner-scoped store read exists, automation/store.ts:61) and rescans auth.users() + one memberSpent per member
Task 5: minor (deferred): no cap-crossing tests for OVERVIEW_LIMITS.members/.boxes (members > 64 dropped silently)
Task 5: minor (deferred): FAILED "nothing ran since" uses a session's updatedAt (marks/renames bump it) — run start times would be exact
Task 5: minor (deferred): int tick test cannot tell the createProject tick from the startBox tick
Task 5: minor (deferred): no tick on health records / user, budget, disable changes
Task 5: minor (deferred): snapshot-bed.ts outside testing/; project ask recomputes own.find(needsInput); card apiEquivalent is owner-wide; daemon.ts 399 lines
Task 5: fix round 1 implementer DONE_WITH_CONCERNS f9d0267b (thread via SessionsModule.threadOf; members need users:read, failures need pi:admin)
Ruling: capacity.cost.membersUsd / totalUsd stay visible to any owner credential (a sessions:read token included) — why: an aggregate with no names or per-member figures, on the owner's own credential; the per-member lines are gated — cost if wrong: an owner token reads the installation's total spend today.
Task 5: note: the thread-dialog session ask is unit-only (no cheap way to raise a dialog on an agent thread on the process backend); the running thread is int-covered.
Task 5: fix round 1/5 (2 addressed, 0 open — agent thread on its card; permission-gated member lines/failures; commits 19d49800..f9d0267b)
Ruling: an agent thread row usually has name null, so the thread title can be empty: Task 6 renders an activity with an empty title as "<kind> · since <time>" (no empty middle segment) — why: the card is already named after the agent — cost if wrong: one formatter branch.
Task 5: minor (deferred): OverviewThreadFacts.starting / threadOf().starting unused by the card
Task 5: minor (deferred): docs/agents/daemon.md:183-184 does not mention the users:read / pi:admin gate nor threadOf (fix in T8's docs or the minor sweep)
Task 5: minor (deferred): sessionActivity's kind parameter now only ever "session"; the stream int test can match an earlier frame (pre-existing weakness)
Task 5: complete (commits 6be0384b..f9d0267b, review clean after round 1)
Task 6: dispatched (implementer sonnet a5275576, BASE f9d0267b)
Task 6: implementer DONE_WITH_CONCERNS dccc0e2c (initial bundle 256.2 KB gzip / 300)
Ruling: the launch step on a STARTING card is a LaunchLine reading the launch store (features/overview may not import features/launch); no steps panel on the card — why: lint boundary; the spec asks for the step words only — cost if wrong: the card lacks the 5-segment strip.
Ruling: the agent avatar comes through OverviewCallbacks.renderAvatar (Task 8 passes AgentAvatar from the route layer); without it the card shows the glyph — cost if wrong: none.
Join note: before merge, take headless screenshots of /overview (podman Playwright, the built app on the scripted provider) in Night and on a phone width, and compare with layout A (docs/design/questions/2026-11-03-overview-layouts.html) — owner workflow "check visuals against the chosen board option".
Task 6: review dispatched (sonnet a3779fe2)
Task 6: controller killed 1 orphan wait loop (while pgrep -f) left by the implementer
Task 6: review Approved (sonnet), but the controller confirms a spec gap the reviewer described without flagging: FULL renders as an `att` (pink) Chip (CapacityBand.tsx:270) — spec §3.2 "a word… no red and no pink", DESIGN §2 pink = waits for you.
Ruling: treat as spec ❌ → fix round 1: FULL is a neutral HUD word (label-hud, --text, no role colour, no dot), as mockup E4 drew it — cost if wrong: one class.
Ruling: fold review Minor 1 into the same round (cheap, user-visible): LaunchLine's fallback must not show project copy for an agent box — use the agent title key (launch.title.agent if it exists, else render nothing) — cost if wrong: one string.
Task 6: minor (deferred): no tests for the phone single-column branch, the stale banner, the member budget Meter, the chip words in the DOM; band.test.tsx:522 stray await and a misnamed test; E2 reuses overview.title; use-overview.ts:1578 sync throw uncaught (same as use-agent-status); truncated activity titles have no full-text path
Task 6: fix round 1/5 (2 addressed, 0 open — FULL neutral word; agent launch copy; commits dccc0e2c..2436e6a5)
Task 6: complete (commits f9d0267b..2436e6a5, review clean after round 1)
Task 7: dispatched (implementer sonnet a559e3e2, BASE 2436e6a5)
Task 7: implementer DONE e373b314
Task 7: review Approved (sonnet). ⚠️ resolved: StoppedStrip already renders actions (reviewer grep); wiring into OVERVIEW_CALLBACKS is T8.
Task 7: minor (deferred): refused task cancel / launch stop show the generic errorKey text, not three-part §11 copy
Task 7: minor (deferred): StopBoxDialog Cancel/Escape live while pending; empty padded body div; Error-wrapped string contract; no test for STOP while pending or an agent's starting box via launches.stop
Task 7: complete (commits 2436e6a5..e373b314, review clean)
Task 8: dispatched (implementer sonnet a1b18daa, BASE e373b314)
Task 8: implementer DONE_WITH_CONCERNS 65d3dfa4 (initial bundle 257.3 KB gzip; build-output 74 pass)
Ruling: the phone's AgentsSection.tsx and its test are deleted — the Overview replaces its list, empty and no-VM states (spec §3.7) — cost if wrong: restore one file from git.
Ruling: card actions are attached inside the lazy overview-pane-entry.tsx (not OVERVIEW_CALLBACKS) so @pap/ui/overlays stays out of the initial graph — cost if wrong: none.
Task 8: minor (deferred): unused catalog keys agentsPhone.emptyTitle/emptyPurpose and overview.openOn* (lazy-catalog.overview.test.ts still asserts the latter)
Task 8: note: RED rebuilt afterwards by reverting the implementation (12 tests failed)
Task 8: review Approved (sonnet) with 1 Important (docs/agents/web.md:283 still documents the deleted AgentsSection) — docs-only
Task 8: minor (deferred): gallery lacks an IconButton selected example (brief asked); "Open on" reads the device-cached account only (fresh device never redirects on first load — by design); Rail active state derived from the URL
Ruling: fold Task 8's Important (web.md:283) into ONE pre-final minor sweep (owner-approved lightening: one minor sweep before the final review) together with the minors worth fixing; the rest stay parked for the final review's triage — cost if wrong: one more dispatch.
Task 8: complete (commits e373b314..65d3dfa4; Important folded into the sweep)
Sweep: dispatched (implementer sonnet aed545ca, BASE 65d3dfa4, brief sweep-brief.md, 8 items)
Sweep: DONE 93bda11f..adc5633a (8 items; unit related 19,525 pass; int daemon 685 pass; lint/typecheck/knip/build/budgets clean)
Ruling: the sweep gets no separate scoped re-review; the final whole-branch Opus review reads the sweep commits with the rest — why: eight small minor fixes, the final review covers the same diff — cost if wrong: a sweep defect is caught one step later.
Join J1: full gate running in background (bgjzjd3n3, log scratchpad/join-gate.log); final review dispatched (opus a74b0b12)
Final review (opus): With fixes — 0 Critical, 5 Important (E3 wrong refusal text; ticking ages instead of fixed since times; stopped strip lacks next run; actions follow the state word not the phase — FAILED/WAITING down box gets no START, paused box gets a no-op STOP; agent thread line/ask open a bare session tab), many Minor; deferred minors: none block, per-box apiEquivalent taken into the fix wave.
Ruling: one final fix wave: the 5 Important + per-box apiEquivalent + doc/comment fixes (daemon.md:183/186, overview-methods.ts:6) + cheap user-visible minors (next-run "Next 18:00 · name" wording with 24 h HH:MM, plurals, phone band three narrow cells, phone member lines two columns and muted zeros, dead keys overview.open/start) — why: each is local and visible to a person; the rest stay parked — cost if wrong: one fix dispatch.
Ruling (declined-to-judge items): R2 tick-everyone timing side channel accepted as the plan ruling (follow-up: per-user routing); YOUR BOXES without a meter (a meter would reveal the cap to a member, M14) — log in the decisions-log follow-up; LaunchLine without the counter stays (T6 ruling).
Join J1: gate stopped at the unit step (lint, format, build, typecheck, knip, budgets PASS at adc5633a) to let the final fix wave edit the worktree; full gate reruns after the wave
Final fix wave: dispatched (implementer sonnet ab2545f3, BASE adc5633a, brief final-fix-brief.md, 11 items)
Final fix wave: DONE a9a39ae8..edc4e5d8 (11 items; related unit 16001 pass; related int 615 pass; lint/typecheck/knip/build/budgets clean)
Final fix wave: re-review dispatched (sonnet a3ae471e); full join gate rerunning in background (bxpm24t68) at edc4e5d8
Ruling: no headless screenshots at the join — the e2e daemon has no VM stack (docs/agents/e2e.md, J07), so /overview would only show E3; the visual check against layout A is offered to the owner as a branch preview on the real preview (no migration in the branch) before the merge — cost if wrong: the layout is first seen by the owner, not by a screenshot.
Final fix wave: re-review (sonnet) — 11/11 ADDRESSED, no new breakage
Final: minor (parked): FR "Prochaine demain 02:00" reads awkwardly; a card open across midnight with no tick keeps a stale "tomorrow"
Join J1 (edc4e5d8): lint, format, build, typecheck, knip, budgets, smoke PASS; unit 7 failed / 25538 passed; int 1 failed / 1602 passed.
Ruling: push/transport endpoint.test.ts (2) and vapid.test.ts (1) fail on main too (checked in the main checkout) — pre-existing, outside this lot; reported to the owner as a follow-up — cost if wrong: none for this merge.
Join J1: branch failures to fix (6): build-output.int "phone Agents list … (M11R109)" (AgentsSection deleted); no-caller-role.test (role: "owner" literal in daemon code); sources.scan.test (use-overview name collides with the models rule); inline-error.test (stale banner InlineError tone=attn); docs-truth.test (a doc names something that does not exist).
Join J1: fix dispatched for the 6 branch failures (implementer sonnet aff74d58, BASE edc4e5d8)
Join J1: fix DONE 1f75c4fd (5 failures fixed; hook renamed use-boxes-snapshot; OWNER_CAPACITY_ROLE; stale banner error tone; docs; obsolete phone marker row removed). Full gate rerun started (join-gate-2).
Join J1 (1f75c4fd): lint, format, build, typecheck, knip, budgets, int (1602), smoke PASS; unit 25542 passed, 3 failed = the pre-existing push tests that fail on main too.
