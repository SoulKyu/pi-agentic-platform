# Final whole-branch review: sub-project 5 (OKF knowledge replaces pi-mem0)

Reviewer: Opus, read-only. Branch `feat/okf-b` (lane A merged in), range `cf8c0c80..c4d854d0`, worktree `.worktrees/sp5-b`.
Inputs: spec `docs/specs/2026-10-23-okf-knowledge-design.md`, plan `docs/plans/2026-10-23-okf-knowledge.md`, `DESIGN.md`, ledger `progress.md`, `review-final.diff`, `review-final-tests.stat`.
Method: `superpowers/7.0.0/skills/requesting-code-review/code-reviewer.md`. I did the review in passes myself and dispatched no subagent. Passes: daemon (sessions, projects, kernel, agents, inbox, push), contracts, pi-host (host, open-session, guest seed, prompt), web, docs. For the runtime question in check 1 I also read the owner's Pi settings (one `grep`) and pi-mem0's `src/index.ts`.

Tests run by path (all green):
- Unit, 13 files, 153 tests: `kernel/fs/knowledge.test.ts`, `compose-knowledge.test.ts`, `service-launch.knowledge.test.ts`, `inbox/migration.memory.test.ts`, `agent-vm/vm-init.test.ts`, `guest/seed.test.ts`, `policy/vm-stage.knowledge.test.ts`, `knowledge-prompt.test.ts`, contracts `agents`, `push` and `auth` tests, `KnowledgeChip.test.tsx`, `KnowledgeRow.test.tsx`.
- Int, 2 files, 6 tests: `daemon.knowledge.int.test.ts`, `open-session.knowledge.int.test.ts`.
- `eslint --max-warnings=0` on the new knowledge files and `guest/seed.ts`: clean.

## Strengths

- **Detection and ENABLE OKF are careful** (`apps/daemon/src/kernel/fs/knowledge.ts`):
  - Opens go through the folder's descriptor (`/proc/self/fd/N/<name>`), with `O_NOFOLLOW` at every last component.
  - `O_NONBLOCK` on the index head, so a FIFO named `index.md` cannot hang the daemon.
  - Files are created `O_CREAT|O_EXCL|O_NOFOLLOW`. A non-recursive `mkdir` with `EEXIST` followed by an `O_DIRECTORY|O_NOFOLLOW` open refuses a link, a dangling link or a file, and writes nothing.
  - The concept walk is bounded (10 000 concepts, 50 000 entries, depth 16).
  - On the launch path the check is cheap (`hasKnowledge`, no walk), never throws, and warns once with the error code only.
- **The worker change is small.** `compose()` adds one spread (`service-launch.ts:157-177`). pi-host appends the section next to the agent and child prompts (`open-session.ts:240-247`).
- **Lane roots are consistent.** `rootOfRow` (launch) and `rootFor` (RPC) agree for plain and lane sessions, because a session's project is always `ensure(scopeOf(cwd))` (`project-link.ts:24-31`). Owner scoping holds in both (`owned()`, `cwdOf(ownerId, …)`, `lane.ownerId` checks).
- **Stored data keeps loading.**
  - `dropKey` preprocesses `AgentInput.memory` and push `review`.
  - Tokens filter through `GRANTABLE` (`auth/tokens.ts:42,143`), so `memory:read`/`memory:operate`, which were grantable, drop silently.
  - The migration `202610231200_drop_memory_review.sql` comes with a real migration test.
  - Persisted workspace tabs for `settings/memory` are dropped by `persist.ts:32`.
- **The removal is complete in code.** `rg` finds no `mem0`, `memory_review`, `memory-trust` or `MEMORY.md` left outside `image-inputs.ts` (kept on purpose) and test fixtures. No non-mem0 behaviour lost its mechanism:
  - The release/renew machinery fed only pi-mem0.
  - Policy reloads, approvals, taint reporting (`createTaint(…, reportTaint)`) and trusted autonomy go through `policyLink`/rules and are untouched.
  - `folderRestart.releaseIdle` is still exported for its other callers.
- **Agents.**
  - `vmInitOf` drops any host-composed `knowledge` and sets the VM's own for threads and children, none for tasks (`vm-init.ts:47-50`).
  - The guest seed can never fail a VM start (`seed.ts` `seedKnowledge`).
  - The approval-parity test compares home and knowledge in 4 modes × tainted/untainted × write/edit.
- **Web.** Chip and row live in lazy chunks (SessionScreen and HomeBody are lazy). Tokens only, `focus-ring`, `pointer-coarse:min-h-11/min-w-11`, EN/FR copy exactly as the plan, the error styling of the house pattern (`text-ui text-attn`, `role="alert"`).
- **Global rules.** Every changed file is ≤ 400 lines (largest: `daemon.ts` 395, `quarantine.test.ts` 397). Module imports go through `index.ts`/`kernel`. Both methods declare permission, idempotent entry and errors. Erasable TS. No test touches `~/.pi/agent`, `~/.pap`, `~/.claude`, a public host, the real pap-vmd, `/opt/pap-vm` or `10.213.0.1`.

## Issues

### Critical (must fix or get an explicit owner ruling before merge)

**C1. pi-mem0 still runs inside every pap host session, and the branch removed the only controls that closed it**

- **Where:** `packages/pi-host/src/open-session.ts:235-238`, `apps/daemon/src/modules/sessions/service-launch.ts:207`; docs `README.md:35`, `docs/agents/knowledge.md:37`, ADR 0082 "pi-mem0 leaves pap".
- **What:**
  - pap workers load every extension of the shared `~/.pi/agent`: `extensionsOverride` reorders `base`, it does not filter it.
  - On this host `~/.pi/agent/settings.json:14` lists `../../Workspace/soulkyu/pi-mem0`.
  - pi-mem0 recalls before each run. Unless `PI_MEM0_CAPTURE=0` or `PI_MEM0_DISABLED=1` is set, it captures after each `agent_end` (`pi-mem0/src/index.ts:38-39,274,321`). The capture is an extraction call to `glm-4.7` on `api.z.ai` that sends up to 8 000 characters of transcript.
  - Before this branch, `memoryTrustOf` closed pi-mem0 for tainted plain and lane sessions, M10 tasks and children (`profile: ""`, `PI_MEM0_CAPTURE=0`). `createMemoryRelease` and `renew` closed a worker that was tainted mid-run.
  - All of that is deleted, and nothing replaces it.
- **What happens after the merge on the live host:**
  - Every pap host session captures into pi-mem0's store, which pi-web shares. That includes sessions that read external content, unattended webhook/feed tasks and subagent children.
  - The store is recalled into later sessions of both apps.
  - pap no longer has a review queue or a forget screen for any of it.
  - Effect: the memory-poisoning path that ADR 0052 was built to close is reopened.
- **Against the spec:**
  - §2 says "pi-mem0 leaves pap entirely".
  - §2 anti-goal: "an extra LLM call … per session".
  - The docs say "pi-mem0 is no longer used by pap", which is not true at runtime.
- **Fix (KISS, no pi-mem0 env contract):**
  - In pi-host's `extensionsOverride`, drop any extension whose package name or resolved path matches `/pi-mem0/i`. This is the same test `image-inputs.ts:38` uses for VM images.
  - Add a unit test with a fake extension named `pi-mem0`, and a doc line: "pap's workers never load pi-mem0; pi-web still may."
  - Alternative: one line `PI_MEM0_DISABLED=1` in every host worker's spawn env. It is smaller, but it depends on pi-mem0's variable name.
- **If the owner prefers to keep pi-mem0 running ungoverned in pap**, ADR 0082 and `knowledge.md` must say so and name the reopened poisoning path. This is also a plan gap: the plan treated memory-trust as "pi-mem0-only machinery", without noting that the extension itself keeps loading.

### Important (should fix before merge)

**I1. ENABLE OKF failures do not follow the error pattern**

- **Where:** `apps/web/src/features/knowledge/KnowledgeRow.tsx:46-58,74-78`; test `KnowledgeRow.test.tsx:53-64`.
- **What:**
  - `useAction` uses the default `failureText`. A refusal with `conflict` shows "This already exists or changed meanwhile." This happens when `knowledge` is a file or a link, or its `index.md` has no `okf_version`, and repositories with an unrelated `knowledge/index.md` are plausible.
  - An unwritable or vanished project folder (`EACCES`/`ENOENT`, which become `internal`, as the ledger's B1 concern notes) shows "Something went wrong."
  - Spec §7 and DESIGN.md §error copy require three parts: what happened, what is intact, what to do. The test only checks that an alert exists.
- **Fix:**
  - Pass a `describe` to `useAction`. For `conflict`, for example: "OKF was not enabled: `knowledge/` is a link or a file, or its `index.md` has no `okf_version`. Nothing was written. Rename it, or add `okf_version: "0.2"` to its index.md, then try again."
  - For any other code, a sentence that names the folder as unwritable.
  - EN and FR, with a test on the exact copy.

**I2. Lane sessions: the NO OKF chip leads to a row that reads and enables the main checkout, not the lane's worktree**

- **Where:** `KnowledgeChip.tsx:38` passes `sessionId`, so it reads the worktree. Its link (`:76-80`) opens the project home, where `KnowledgeRow.tsx:33,52` calls both methods without `sessionId`, so they read and write `project.root`.
- **Effect:**
  - In a lane session, ENABLE OKF writes the main checkout and the lane's chip stays NO OKF.
  - If the main checkout already has OKF (enabled but not committed, or committed after the lane branched), the page shows the present line and no button. That is a dead end.
  - Spec §2 says "the session's chip is then green", and §8 says "the chips of the project's open sessions turn green".
- **Fix (needs a controller ruling on which one):**
  - (a) The chip records `{projectId, sessionId}` in the knowledge store when clicked. The row then reads and enables that lane's worktree and says so ("in this lane's worktree").
  - (b) A lane session's NO OKF chip is not a link, and its label says that the lane's branch has no `knowledge/` and how to get it (merge, or enable in the lane).

**I3. The "applies from the next start" label is lost in the main flow**

- **Where:** `KnowledgeChip.tsx:35-53`; `routes/shell/AppShell.tsx:151-166` renders only the active tab.
- **What:** The chip's own link switches the pane to Home, which unmounts `SessionScreen`. Back on the session, the chip remounts with `lastEnabled = null` and never calls `markPending`. It shows a plain `OKF` while the running worker has no knowledge section.
- **Spec:** §3 requires the label "until that start".
- **Docs:** ADR 0082 and `web.md` record this as a "known edge", but `knowledge.md:11` claims the opposite. Since the chip's own link triggers it, it is the common path, not an edge.
- **Fix:**
  - On a successful enable, `KnowledgeRow` marks pending every shell-store session with that `projectId` whose status is not `cold`.
  - Or, more robust: `projects.knowledge {sessionId}` answers whether the live worker started with the section, since the daemon knows the init it composed.
  - Add a test that unmounts the chip during the enable.

**I4. The `index.md` pap writes is not OKF v0.2-conformant**

- **Where:** `packages/contracts/src/knowledge-bundle.ts:2`. This is a plan issue: the plan's Global Constraints say the first line is `okf_version: "0.2"`.
- **What the OKF spec says:** OKF SPEC.md §12 puts `okf_version: "0.2"` "in a bundle-root `index.md` frontmatter block". §4 says frontmatter is delimited by `---` lines, and §8 allows frontmatter in the bundle-root `index.md` only for that key.
- **What pap does:**
  - pap writes a bare first line, not a frontmatter block. OKF consumers do not see the version, and markdown renders the line as body text.
  - Files are created `O_EXCL` and never rewritten. So every project enabled, and every agent VM started after the root window, keeps the non-conformant file for good.
- **Fix before merge:**
  - `OKF_INDEX_TEXT = "---\nokf_version: \"0.2\"\n---\n\n# Knowledge\n…"`.
  - Detection needs no change: `VERSION_LINE` is multiline and matches line 2.
  - Update the tests that pin "first line", plus `knowledge.md`, ADR 0082 and the plan line.
  - `log.md` (`## YYYY-MM-DD`, newest first) already conforms to §9.

### Minor

1. **Agent prompt.**
   - `packages/pi-host/src/agent-prompt.ts:28` still says "Your shell runs in a sandbox: only your home is writable". The VM shell binds home, knowledge and inbox writable (`vm-shell/argv.ts:34`), and the agent is now told to write knowledge. When `knowledge` is set, say "only your home and your knowledge folder".
   - `:24` says "described in the Knowledge section below", but the section has no "Knowledge" heading (`knowledge-prompt.ts`). Say "described below".
2. **Stale or incomplete docs.**
   - `docs/agents/sessions.md:226` still says children have "memory closed (`memory-trust.ts`)".
   - `docs/agents/parity.md:151` P12-14 claims "MEMORY.md in an agent home" is green, but its proof `homes.test.ts` now asserts there is none.
   - `docs/agents/knowledge.md:9` lists the `conflict` cases without "an `index.md` that is not an OKF index". `shell.ts:170` and the code include it.
3. **Dangling doc comment.** `apps/daemon/src/modules/sessions/service-launch.ts:31` still carries the JSDoc of the deleted `memory` field ("Which workers started untainted…"), stacked above `checkCapacity`'s.
4. **Unneeded walk for the chip.** `projects.knowledge` from the chip (`KnowledgeChip.tsx:38`, `projects/service.ts:200-201`) runs the bounded concept walk synchronously on the daemon loop for every session-screen mount, though the chip reads only `enabled`. Also, `readdirSync` (`knowledge.ts:61`) reads a whole directory before the entry budget applies. Low impact: skip the count when `sessionId` is given.
5. **Plural.** "· 1 concepts": the copy is prescribed, but the catalog's `.other` plural support could carry "1 concept".
6. **Label in name.** The NO OKF button's `aria-label` (`KnowledgeChip.tsx:86`) replaces the visible word (WCAG 2.5.3, label in name). Consider "NO OKF: Enable OKF for this project", or `aria-describedby`.
7. **Leftover "memory" copy.** The agent catalogs still say the agent's "memory": `agent-space.ts:22`, `agents-phone.ts:3`, `settings-agents.ts:13`, `agent-settings.ts:4`, `agent-safety.ts:9`. So does the comment at `features/agents/untrusted-text.ts:1`. Optional rewording to "knowledge".
8. **Seed timing.** The guest re-seeds a deleted `index.md`/`log.md` at every VM start, while spec §4 says the first start. This is documented in `knowledge.md`. A re-created `log.md` carries a fresh "OKF enabled" line. Accept, or seed only when `knowledge/` is empty.
9. **Partial write.** A partial `writeSync` on ENOSPC in `enableKnowledge` can leave a truncated `index.md` that later reads as `conflict`. Negligible.
10. **`daemon.ts` growth.** `daemon.ts` grew by 2 lines (395/400), against the plan's "net-negative or one line". Trivial.

## Triage of the ledger's deferred minors

| Deferred minor | Verdict |
|---|---|
| A1: a pending `push_events` row of class `review` "safe only because decide.ts suppresses it" | **Accept, no fix.** It is safer than stated: `run()` checks `stillWaiting` (`source-inbox.ts:82`) before building any delivery, and the migration deleted the Inbox item, so the event is cancelled `gone`. A held one reads `gone` in the digest (`:88-89`). `PushWire` parsing is never reached. |
| B1: the first session in a folder not yet a project gets no section until the project exists | **Accept** (recorded as a known edge in ADR 0082; the next worker start picks it up). |
| B1 concern: ENOENT on enable → `internal` | **Fold into I1** (the copy must say what happened). |
| B2: the guest seeds task VMs too; prompt withheld | **Accept** (harmless; no prompt, blank disk). |
| B3: two-way lint boundary `sessions` ↔ `knowledge` | **Accept after merge.** Cheap later fix: move `useAction` to `lib/`. |
| B3: pending cleared on cold → started | Logic is correct while mounted; **see I3**. |

## Declined to judge (set aside, one line each)

- What the model writes into `knowledge/`, and how it is enforced: spec non-goal (§2, §5).
- The Hindsight roadmap entry: outside this branch.
- pi-mem0 recall and capture in *untainted* plain and lane sessions before this branch: that was ADR 0052's design. I judged only the regression in C1.
- `docs/agents/policy.md:32` "`MEMORY.md` is a protected path": pre-existing generic protection under `agents/`, still asserted by `read-target.agents.test.ts`. Not introduced here.
- README "Each agent has its own home (`$PAP_HOME/agents/<id>/`)" in VM mode: SP3's documentation state, untouched by this branch.
- Whether a subfolder `index.md` counts as a concept: the concept-count read is the builder's call (spec §9).
- A Kata run: no Kata test covers knowledge, and the guest seed runs on the process backend's tests. I do not ask for one, unless C1's fix touches the VM bundle (it does not).

## Recommendations

- Fix C1 in pi-host by filtering the extension. That makes "pi-mem0 leaves pap entirely" true at runtime and mirrors the VM-image exclusion. Then the docs can keep "pap's workers never load pi-mem0".
- Fix I4 before the root window, since seeded files are never rewritten.
- One fix wave can do C1, I1, I3 and I4. I2 needs a controller ruling (option a or b) first.
- Scoped re-review: the pi-host extension filter and its test, `KnowledgeRow` copy and pending, `knowledge-bundle.ts`, and the docs lines.

## Assessment

**Ready to merge: With fixes**

**Reasoning:** The OKF side is sound and well guarded, and the removal of the integration is complete and backward compatible. But removing the trust controls while pi-mem0 still loads in every pap host worker reopens a memory-poisoning path on the live host (C1). Four Important gaps also remain: error copy, lane-session enable, the pending label in the main flow, and OKF frontmatter conformance.
