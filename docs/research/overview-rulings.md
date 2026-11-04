# Overview rulings

Plan rulings R1 to R13 (binding at dispatch), from the SDD workspace. Execution rulings are in `overview-sdd-ledger.md` (lines starting `Ruling:`).


- **R1 · The daemon computes, the web renders.**
  - The daemon computes the state words, the order, FULL, `fits`, the member percentage and the activity cap. The web sorts nothing and decides nothing.
  - Why: one place to test the rules, and the scoping lives next to the data.
  - Cost if wrong: a rule change needs a daemon change.
- **R2 · Ticks are coalesced on the daemon, not debounced in the browser.**
  - The module sends `{kind:"changed"}` to every user who has the stream open, at most one per second per user.
  - It ticks every subscriber on every change: the band is shared, and a tick carries no data.
  - The client reads once per tick (single flight, with the stale-read guard of `use-agent-status.ts`).
  - Ceiling: a busy host sends each viewer one read a second. If that ever shows in profiles, add per-user change routing.
- **R3 · Memory figures.** The `capacity` error's `memory` detail already never reaches the wire (`dispatcher.ts:108` forwards `workers` only), so nothing is stripped. The snapshot carries the figures in the viewer's form:
  - the owner gets `usedMb` and `maxMb`;
  - a member gets a percentage;
  - each box gets `needMb` (its own `memoryMb` plus `VM_OVERHEAD_MB`) and `fits`.
- **R4 · The ask block.**
  - **Inbox item:** the box's newest unresolved to-handle Inbox item (`agent_approve`, `task_needs_input`, `secret_request`), sent as `InboxItem`. The card shows the overview catalog's category word and `item.detail ?? item.triggerName`. ANSWER reveals the item in the Inbox.
  - **Session dialog:** a session with `needsInput` and no Inbox item (an interactive session's dialog) shows "Waiting in this session" with the session's name. ANSWER opens that session's tab.
  - Why: InboxItem has no title, and an interactive dialog has no Inbox item.
- **R5 · Cost, one measure per question.**
  - **The owner's cards:** every run of the box today (`runs.cost_usd`, API-equivalent included), the way usage panels count.
  - **The owner's total:** the owner's own runs today, plus each member's budget-line figure (`memberSpentToday`, API-billed runs).
    - Why: a member's own subscription costs the installation nothing; the shared keys do.
  - **"of which members":** the sum of those member figures.
  - **A member's cards and cell:** API-billed runs only, the same measure as their budget line, so the cards add up to the cell.
- **R6 · Stop.**
  - **`projects.stopBox`:** box-control's `stop`, through the projects `lifecycle` helper. It is queued with starts and restarts.
  - **`agents.stopBox`:** it waits for an in-flight `createAgentStart` call for that agent, then calls the agents link's `stop`.
  - **STOP on a starting card:** `launches.stop {id}` while the launch is `stoppable`; otherwise the button is disabled.
  - **Permissions:** the same as the matching start (`sessions:operate`, `agents:admin`).
- **R7 · The phase chip** shows `runtime.phase(box)`. An isolated task shows as an activity line and adds its memory (`reservedMb` counts every entry of the box).
- **R8 · Phone "+".** The top bar's "+" keeps `session.new` on every section. The Overview has its own "+" menu (New agent / New project) in its header, phone and desktop alike.
  - Why: the other phone sections keep their current behaviour.
- **R9 · Rail icon.**
  - `IconButton` gains `selected?: boolean`: `aria-current="page"` plus the agent border and the `--surface-2` fill, the `AgentButton` look.
  - A new `IconOverview` (lucide `LayoutDashboard`).
  - Why: primitives own their look.
- **R10 · Meter.** `Meter` gains `kind: "neutral"` (the `--text-muted` fill) for the workers. Memory uses `kind: "tokens"` (the agent fill), and the member cost uses `kind: "cost"`. The gallery at `/dev/ui` shows the new kind.
- **R11 · "Open on: Overview".** It applies only to the app's first load at `/`: once, from `use-shell-effects.ts`, when the account setting says `overview` and the workspace holds no open item. Clicking the logo still goes Home.
- **R12 · Health line.** The owner's snapshot carries `failures`, the count in the health buffer (in memory, since the daemon started). It is null for a member, because Health is `pi:admin`.
- **R13 · No new e2e journey.** Component tests, int tests and `pnpm smoke` at the join cover the lot.

# Review Focus (plan)

1. **No member content in the owner's snapshot.**
   - Setup: a member owns a project named `secret-project`, with a session named `salary-review`, a task titled `quarterly-numbers` and a pending `agent_approve` item.
   - Expected: `JSON.stringify(ownerSnapshot)` contains none of these strings, and no member id other than in `members[].userId`. (T5 int)
2. **A member's snapshot.** It holds no other user's id, name or box. Its `capacity` has no `usedMb`/`maxMb`, and its `sharedPercent` is a multiple of 5. (T5 int)
3. **The band agrees with the refusal.**
   - Setup: cap 4096 MB, with two running entries of `memoryMb` 1024 each, so `usedMb` is 3072.
   - Expected: a box of `memoryMb` 512 has `needMb` 1024 and `fits` true (3072 + 1024 = 4096, and equality fits). A box of 513 has `fits` false. `runtime.start` of each spec gives the same answer.
   - (T2 unit, T5 unit)
4. **Stop during a start.** START then STOP at once on the same project: the stop runs after the start, the box ends stopped, and there is no orphan entry. For an agent: stop waits for the in-flight start. (T3)
5. **A tick storm.** 100 source changes within 900 ms give at most one tick per subscribed user in that second, plus one trailing tick. No tick goes out after the last subscriber left. A source listener that throws does not stop the others. (T5 unit)
