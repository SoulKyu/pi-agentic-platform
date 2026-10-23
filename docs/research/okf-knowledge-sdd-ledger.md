# SDD ledger — plan: docs/plans/2026-10-23-okf-knowledge.md

Spec: docs/specs/2026-10-23-okf-knowledge-design.md. Base main cf8c0c80. Lanes: A .worktrees/sp5-a (feat/okf-a), B .worktrees/sp5-b (feat/okf-b). Controller: session PID 2374939 only (checked pgrep). Sonnet implementers + reviews, one Opus final review, related tests only, shared heavy-gate.lock, --maxWorkers=3.

## Preflight scan
| Pair / task | Shared file or interface | Finding |
|---|---|---|
| A1 ↔ B1 | `sessions/service-launch.ts` compose() (A1 drops trust/memory; B1 adds knowledge) | join conflict expected, J1 resolves |
| A1 ↔ B1 | contracts `pi-host.ts`/`pi-host-init.ts` (A1 drops InitMemory; B1 adds InitKnowledge) | join conflict expected, small |
| A1 ↔ B1/B2 | pi-host `open-session.ts`, `host.ts` (A1 drops memory-entry; B1 appends knowledge section) | join conflict expected |
| A1 ↔ B2 | `agents/homes.ts` MEMORY.md seeding (B2) vs A1 docs/tests mentioning MEMORY.md | Ruling: A1 does not touch MEMORY.md seeding or agent-prompt; B2 owns them — avoids a double edit — cost if wrong: one conflict |
| A1 ↔ B3 | web i18n index key union, SessionScreen/StatusPanel | join conflict expected, small |
| A1 docs ↔ J1 | knowledge.md stub (A1) filled later (J1) | consistent |
| B1 → B2 | `knowledgePrompt(path)`, `InitRecord.knowledge` | consistent, sequential in lane B |
| B1 → B3 | RPC `projects.knowledge`/`projects.enableKnowledge` | consistent, sequential in lane B |
| A1 | tests vs code | agrees |
| B1 | enableKnowledge "exists with okf_version → not an error" vs "never overwrites" | agrees (idempotent, no write) |
| B2 | children of a thread get the section (ruling in plan) | agrees |
| B3 | Chip not interactive → button wrapper (plan says so) | agrees |

## Progress
- A1: dispatched (Sonnet, BASE cf8c0c80, lane A)
- B1: dispatched (Sonnet, BASE cf8c0c80, lane B)
- B1: DONE_WITH_CONCERNS 043af93c (sync helpers kernel/fs/knowledge.ts; ProjectsPort.knowledgeRootOf; daemon.ts 393→395; ENOENT on enable → internal) — review dispatched
- A1: DONE_WITH_CONCERNS 4929359d (148 files, -6783; drop-key.ts accept-and-drop for AgentInput.memory + push review; tokens drop memory:* already; memory-subscriptions.ts kept: generic push store) — review dispatched
- B1: review 1: spec ✅ (one deviation: folder outside any project gets a root); I1 knowledgeOf rethrows EACCES/EMFILE → compose can fail a launch; I2 full sync walk twice per launch → hasKnowledge for compose, bounded walk for the RPC. Fix round 1 sent (+ spec deviation).
- A1: review 1: spec ✅, quality approved. Minor (deferred): a pending push_events row of class `review` is safe only because decide.ts:30 suppresses it before copyFor.
- Task A1: complete (commits cf8c0c80..4929359d, review clean). Lane A done.
- B1: fix round 1/5 c0c865ba (hasKnowledge cheap + never throws; bounded walk 50k entries; no root outside projects) — controller-verified (diff read; 7 files/62 tests pass per report). Minor (deferred): the first session in a folder not yet a project gets no section until the project exists.
- Task B1: complete (commits cf8c0c80..c0c865ba, review clean after 1 round)
- B2: dispatched (Sonnet, BASE c0c865ba, lane B)
- B2: DONE_WITH_CONCERNS da552c22 (constants moved to contracts knowledge-bundle.ts; guest seeds task VMs too, prompt withheld; vitest related printed no summary → explicit path run 59 files/657 tests) — review dispatched
- B2: review 1: spec ✅; Important: guest seed swallows only EEXIST/ELOOP → ENOSPC/EACCES/EIO on knowledge files fail the VM start. Fix round 1 sent.
- B2: fix round 1/5 1158880c (knowledge seed errors logged once and skipped; EACCES test) — controller-verified (prettier, 2 test files pass).
- Task B2: complete (commits c0c865ba..1158880c, review clean after 1 round)
- B3: dispatched (Sonnet, BASE 1158880c, lane B)
- B3: DONE_WITH_CONCERNS f2caf85e (eslint boundary rules added; pending cleared on cold→started; backticks render literally in the row text; bundle 240.5/250 KB) — review dispatched
- B3: review 1: spec ✅; I1 chip link lacks focus-ring; I2 lacks 44 px coarse-pointer target. Minors: literal backticks (folded into the fix as polish), sessions↔knowledge two-way lint boundary (deferred). Fix round 1 sent.
- B3: fix round 1/5 dc22b5e2 (focus-ring + coarse 44 px; {folder} inline code EN/FR; budgets 240.5/250) — controller-verified (diff stat, report evidence).
- Task B3: complete (commits 1158880c..dc22b5e2, review clean after 1 round). Lane B done.
- J1 steps 1-2: dispatched (Sonnet, lane B worktree: merge feat/okf-a into feat/okf-b, gate, docs, ADR 0082, decision 123, roadmap).
- J1 steps 1-2 DONE 83571bdd (merge) + c4d854d0 (docs, ADR 0082, decision 123, roadmap); gate 1787 files/19136 tests green. Opus final review dispatched (package excludes test bodies).
- J1 step 3: Opus final review: With fixes. C1 pi-mem0 still loads in every pap host worker (~/.pi/agent settings) and the branch removed its only guards (PI_MEM0_CAPTURE=0, taint release) → captures from tainted runs again into the store shared with pi-web; I1 ENABLE failure shows generic copy, not the error pattern; I2 lane chip reads the worktree but the row enables the main checkout (dead end); I3 pending label lost when the chip link unmounts SessionScreen; I4 index.md not OKF v0.2 (okf_version must be in a --- frontmatter block; plan defect).
- Ruling C1: pap sessions never load pi-mem0 (filter /pi-mem0/i out of the extensions pap loads, like VM images already exclude it) — the owner asked to remove pi-mem0 totally; pi-web keeps using it — cost if wrong: the owner's pap sessions lose pi-mem0 recall they had (owner accepted losing memories).
- Ruling I2: option (a) — the chip records {projectId, sessionId}; the project row then reads and enables that lane's worktree and says so — keeps the owner's flow (chip → project page → ENABLE → chip green) — cost if wrong: one more line of copy.
- One fix wave dispatched (Sonnet, BASE c4d854d0): C1, I1, I2(a), I3, I4 + triage rows "fix before merge".
- Final fix wave DONE 54f05be8 (C1 pi-mem0 filtered from pap sessions; I1 error pattern; I2 lane via recorded session + cwd-outside-root heuristic; I3 pending in store; I4 frontmatter). Scoped re-review dispatched.
- Final re-review: C1, I1, I2, I3, I4 ADDRESSED; no new C/I. Parked minors: /pi-mem0/i also drops an unrelated extension whose path contains "pi-mem0"; a renamed fork or a re-registration of mem0 tools is not covered; pending label only on the clicked session and not cleared if the worker restarts while the chip is unmounted; stale chip origin if navigation fails.
- Remaining: root window (owner OK): merge, build, vm setup (bundle changed), preview, doctor, push.
