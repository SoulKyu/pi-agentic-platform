# Sub-project 5 (OKF knowledge replaces pi-mem0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pap drops its pi-mem0 integration and gives projects and agents an OKF `knowledge/` bundle the model keeps itself, with a session chip and an ENABLE OKF action.

**Architecture:** lane A deletes pi-mem0 (one task). Lane B, in parallel, builds OKF: the daemon side (detection, enable, the init field, the prompt section), then the agent's bundle, then the web. A join task merges, writes the docs and ADR 0082, runs one Opus final review and the root window (the VM bundle changes).

**Tech Stack:** TypeScript (erasable syntax), Node 24, zod, vitest, React, the existing guest file seeding.

**Spec:** `docs/specs/2026-10-23-okf-knowledge-design.md`. Recon map (paths, line numbers): `.superpowers/sdd/okf-knowledge/recon.md`.

## Global Constraints

- AGENTS.md rules (CI-enforced): 400 lines per file at most, tests included; a daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`; every RPC method declares a permission and an idempotent entry; handlers decode, call one service method, map typed errors; UI uses tokens only, primitives are not restyled; only `eslint-disable-next-line <rule> -- <reason>`; erasable TS, relative imports with `.ts`; timers through the kernel `Clock`; tests never touch `~/.pi/agent`, `~/.pap`, `~/.claude`, never a public host, never the real pap-vmd (`/run/pap-vm/vmd.sock`), `/opt/pap-vm` or `10.213.0.1` (a live pap with live agent VMs runs on this host; use the existing guards: `PAP_TEST_VMD_SOCKET`, the VM bed's process backend).
- Files at the limit: `daemon.ts` 393, `contracts/methods.ts` 392, `sessions/service.ts` 391, `contracts/agents.ts` 382, `sessions/service-launch.ts` 328: new wiring in new `compose-*.ts` or helper files; edits there are net-negative or one line.
- No new dependency; never edit pi-mem0 itself, pi-web, or third-party packages.
- DESIGN.md: chip tones `ok` (present) and `mut` (absent; not red, not dashed); colour never the only carrier; mono uppercase labels; EN and FR; errors say what happened, what is intact, what to do.
- Exact copy (EN / FR): chip words `OKF` / `OKF`, `NO OKF` / `SANS OKF`; chip link label "Enable OKF for this project" / "Activer OKF pour ce projet"; pending label "OKF enabled; it applies from this session's next start" / "OKF activé ; il s'applique au prochain démarrage de cette session"; project row absent "Agents in this project keep their knowledge as markdown files in `knowledge/`." / "Les agents de ce projet gardent leurs connaissances en fichiers markdown dans `knowledge/`.", present "OKF knowledge in `knowledge/` · {count} concepts" / "Connaissances OKF dans `knowledge/` · {count} concepts"; button `ENABLE OKF` / `ACTIVER OKF`.
- OKF files pap creates: `knowledge/index.md` that starts with a `---` frontmatter block holding `okf_version: "0.2"` (OKF SPEC §4, §8, §12), then a short human header (builder's wording); `knowledge/log.md` with `## YYYY-MM-DD` (UTC) then `- OKF enabled`. Detection accepts `okf_version: "0.<n>"` in the first 512 bytes of a regular `index.md` (no link followed).
- Gate per task (owner rule, never full suites, never the `kata` project): `pnpm exec eslint --max-warnings=0 <changed files>`, `pnpm format:check`, `pnpm typecheck`, `pnpm knip`, `flock /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/heavy-gate.lock pnpm exec vitest related --run --project unit --project integration --maxWorkers=3 <changed .ts/.tsx>`, plus the named int files and `scripts/docs-truth.test.ts`, `scripts/parity-doc.test.ts`, `scripts/adr-index.test.ts` when docs change. Both lanes share that one lock.
- Commits: Conventional Commits, no AI attribution.

## Review Focus

1. A project whose `knowledge` is a link, a file, or whose `index.md` is a link reads as absent, and ENABLE OKF refuses it without writing anything (B1 tests).
2. ENABLE OKF on a project where `knowledge/` already holds an owner's `index.md` never overwrites it (B1 test `never overwrites`).
3. A lane session sees its worktree's `knowledge/`, not the main checkout's (B1 test).
4. Removing the `memory` permission domain does not break stored tokens that hold `memory:*` permissions (A1 test `parses a stored token with a memory permission`).
5. The agent's writes under `/agent/knowledge` follow the same approval matrix as its home, no extra ask (B2 test).

---

## Lane A

### Task A1: delete pi-mem0

**Files (map: recon.md §A1, §A3, §A4):** delete `apps/daemon/src/modules/memory/`, `modules/sessions/memory-trust.ts` (its taint → worker release/renew machinery exists only for pi-mem0 and goes too: `service.ts`, `service-prompt.ts`, `service-launch.ts` lose it), `packages/pi-host/src/memory-entry.ts` and its calls in `host.ts`/`open-session.ts`, contracts `memory.ts`, `memory-methods.ts`, `InitMemory`, `InitRecord.memory`, the `memory_review` Inbox kind, the push class `review`, the permission domain `memory`, the `"memory"` quarantine step, `AgentMemoryPolicy` and `AgentInput.memory` (a stored profile with `memory` still parses, the field ignored), web `features/memory/`, `features/agents/RecentMemory.tsx`, `MemoryFields.tsx`, the Memory settings section and palette entry, Inbox memory rows, the agent form memory fields, `scripts/e2e/j09-memory.e2e.ts` and the e2e seed's mem0 helpers, all pi-mem0-only tests. Create `apps/daemon/src/modules/inbox/migrations/<stamp>_drop_memory_review.sql` (`DELETE FROM inbox_items WHERE kind = 'memory_review';`, stamp after the newest migration). Docs this task must keep green: `docs/agents/memory.md` → a 10-line `docs/agents/knowledge.md` stub (lane B and J1 fill it), `parity.md` D14 rows → one row `dropped (owner 2026-10-23, decision 123)` whose proof cell names `docs/agents/knowledge.md`, P12-14 without `RecentMemory`, a decisions-log entry 123 ("sub-project 5: pi-mem0 removed, OKF knowledge"), AGENTS.md lines naming memory.md / pi-mem0. Keep `image-inputs.ts`'s pi-mem0 package exclusion (it keeps pi-mem0 out of VM images).

**Interfaces:**
- Produces: no `memory*` export left in `@pap/contracts`; `InitRecord` without `memory`; `PUSH_CLASSES` without `review`; `DOMAINS` without `memory`; `QUARANTINE_STEPS` without `"memory"`.

- [ ] **Step 1: Write the failing tests**
  - `packages/contracts/src/agents.test.ts`: `it("parses a stored profile with the old memory policy and drops it")`: `AgentInput.parse({name: "Atlas", memory: {capture: "off"}})` has no `memory` key.
  - `packages/contracts/src/auth.test.ts` (or the token store test): `it("parses a stored token with a memory permission")`: a stored token row listing `memory:admin` and `sessions:read` loads with `sessions:read` only, no throw.
  - `packages/contracts/src/push.test.ts`: stored prefs with `review: true` still parse (key dropped).
  - `apps/daemon/src/modules/inbox/migrations` test (or the migration runner test): after the migration, a `memory_review` row is gone and other kinds remain.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Delete and edit** per the map; `pnpm knip` must report no orphan.
- [ ] **Step 4: Gate** (incl. the three doc tests).
- [ ] **Step 5: Commit** `refactor(memory): remove pap's pi-mem0 integration`

---

## Lane B

### Task B1: OKF in projects (daemon, contracts, prompt)

**Files (map: recon.md §B5, §B6, §B7):**
- Create: `apps/daemon/src/modules/files/knowledge.ts` (or `kernel/fs/knowledge.ts`): `knowledgeOf(root: string): {enabled: boolean; concepts: number}` (sync: O_NOFOLLOW open of `knowledge/index.md`, regular file, first 512 bytes; `concepts` = `.md` files under `knowledge/` except `index.md` and `log.md`, links not followed, capped at 10 000) and `enableKnowledge(root: string, now: Date): void` (non-recursive mkdir of `knowledge`; an existing entry must be a real directory, else `PapError("conflict")`; then exclusive creation of `index.md` and `log.md`; an existing file is left untouched and is not an error when it already carries `okf_version`, else `conflict`).
- Create: `apps/daemon/src/compose-knowledge.ts`: `knowledgeRootOf(row): string | null` (lane session → its worktree via `lanes.paths.laneOf(row.cwd)`; else the project root via `projects.list(owner, [row.projectId])`; no project → null), handed to sessions as a dep.
- Modify: contracts `pi-host-init.ts` (`InitKnowledge = z.object({path: AbsolutePath}).strict()`), `pi-host.ts` (`knowledge: InitKnowledge.optional()`), `shell.ts` (`projects.knowledge {projectId: Id, sessionId?: Id}` → `{enabled: boolean, concepts: number}`, permission `files:read`; `projects.enableKnowledge {projectId: Id, sessionId?: Id}` → `{enabled: true}`, permission `files:operate`, idempotent true), `methods-idempotent.ts`; `modules/projects/rpc.ts` + service (audit `kind: "policy", reason: "knowledge_enabled", detail: {projectId}`); `sessions/service-launch.ts` `compose()` puts `knowledge: {path}` when `knowledgeOf(knowledgeRootOf(row)).enabled`; `packages/pi-host/src/open-session.ts` appends `knowledgePrompt(path)` (new `packages/pi-host/src/knowledge-prompt.ts`) when `init.knowledge` is set, for any session.
- `sessionId` resolves the lane's worktree for a lane session (the root that session sees); without it the project root.

**Interfaces:**
- Produces: `knowledgeOf`, `enableKnowledge`, `knowledgePrompt(path: string): string`, `InitRecord.knowledge`, RPC `projects.knowledge` / `projects.enableKnowledge`.

- [ ] **Step 1: Write the failing tests**
  - `knowledge.test.ts`: present; absent; `knowledge` a link → absent; `index.md` a link → absent; `index.md` a directory → absent; `okf_version: "0.3"` → present; concepts count skips `index.md`, `log.md`, links. `enableKnowledge`: creates both files with the exact first line and log lines; `knowledge` link or file → `conflict`, nothing written; `it("never overwrites")`: an owner's `index.md` with `okf_version` stays byte-identical.
  - `compose-knowledge.test.ts`: a lane session's root is its worktree; a plain session's is the project root; no project → null.
  - `service-launch` / init test: a session in a project with OKF gets `init.knowledge.path` = `<root>/knowledge`; without OKF no `knowledge` key.
  - `knowledge-prompt.test.ts` + `open-session` test: the section names the path, `index.md`, `log.md`, one file per concept with OKF frontmatter, never secrets, `status: draft` after external content, draft/unverified are hints; absent `init.knowledge` → no section.
  - RPC int test: `projects.enableKnowledge` then `projects.knowledge` → `{enabled: true, concepts: 0}`; a token without `files:operate` → `forbidden`; one audit row.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(knowledge): OKF knowledge in projects (detection, enable, prompt)`

### Task B2: an agent's OKF bundle

**Files (map: recon.md §B6, §B9):** `packages/pi-host/src/guest/seed.ts` `seedAgentFolder` also creates `knowledge/index.md` and `knowledge/log.md` when absent (openat O_NOFOLLOW + O_EXCL, never overwrites, every VM start); `apps/daemon/src/modules/agent-vm/vm-init.ts` sets `knowledge: {path: layout.knowledge}` for a thread VM only (not a task VM, not a child: children share the thread's VM and get it too *(ruling: children are workers of the thread's VM)*); `packages/pi-host/src/agent-prompt.ts` replaces "keep durable notes in MEMORY.md there" with a pointer to the knowledge section; `apps/daemon/src/modules/agents/homes.ts` stops seeding `MEMORY.md` (an existing one stays); their tests.

**Interfaces:**
- Consumes: B1's `knowledgePrompt(path)`, `InitRecord.knowledge`.

- [ ] **Step 1: Write the failing tests**
  - `guest/seed.test.ts`: a fresh layout gets both files; existing files untouched; `knowledge/index.md` a link → left alone, nothing followed.
  - `vm-init.test.ts`: thread → `knowledge.path === layout.knowledge`; task VM → no `knowledge`.
  - `agent-prompt.test.ts`: no `MEMORY.md`; names the knowledge folder.
  - `policy/vm-stage` (or `stage-approval.vm`) test: an edit under `layout.knowledge` gets the same verdict as the same edit under `layout.home` in every approval mode, tainted or not.
  - `homes.test.ts`: a new home has no `MEMORY.md`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(agents-vm): each agent keeps its knowledge in an OKF bundle`

### Task B3: the web

**Files (map: recon.md §B8):** new `apps/web/src/features/knowledge/{KnowledgeChip.tsx,KnowledgeRow.tsx,knowledge-store.ts}` and a catalog `i18n/catalog/knowledge.ts` (+ registration and the key union in `i18n/index.ts`); `features/sessions/SessionScreen.tsx` renders `KnowledgeChip` beside `LimitChip` (project sessions only); `features/home/HomeBody.tsx` renders `KnowledgeRow` (never in first-paint `ProjectHome.tsx`, bundle budget).

- `KnowledgeChip`: reads `projects.knowledge {projectId, sessionId}`; `Chip tone="ok" label="OKF"` when enabled; else a link-styled `button` wrapping `Chip tone="mut" label="NO OKF"` (Chip is not interactive) that opens the project's home tab; after an enable in this browser, until the session's next worker start, its accessible label is the pending label. A small store keyed by project id (a version counter) lets `KnowledgeRow` bump it so open chips refetch.
- `KnowledgeRow`: absent → the purpose sentence and `Button variant="primary"` `ENABLE OKF` (`useAction`, `commandId`); present → the present line with tabular count; failure → the error pattern.

- [ ] **Step 1: Write the failing tests** `KnowledgeChip.test.tsx` (tone ok/mut, words, the link opens the project home, pending label after an enable), `KnowledgeRow.test.tsx` (absent shows the button; enable calls the RPC once, bumps the store, shows the present line with the count; a refusal shows the error copy), catalog test for the exact EN/FR copy.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate** (+ `pnpm budgets` if the shell bundle changed).
- [ ] **Step 5: Commit** `feat(web): OKF chip on sessions and ENABLE OKF on the project page`

---

## Join

### Task J1: merge, docs, review, root window

- [ ] **Step 1:** merge lane A into lane B (expected conflicts: `service-launch.ts`, `open-session.ts`, `contracts/pi-host.ts`, `host.ts`, `agent-prompt` tests, i18n index); gate on the union.
- [ ] **Step 2: Docs:** `docs/agents/knowledge.md` (what OKF is here, detection, ENABLE OKF, the prompt section, agents' bundle, trust and its limit), `AGENTS.md` (topic list: `memory` → `knowledge`; microVM bullets without pi-mem0), `agents.md`, `agents-vm.md` ("No pi-mem0" goes), `web.md`, `notifications.md` (no `review` class), `README.md`; ADR 0082 `docs/adr/0082-okf-knowledge-replaces-pi-mem0.md` (supersedes 0052) + index; decision 123 completed; roadmap: sub-project 5 done, the programme is closed.
- [ ] **Step 3: Final review** (Opus, whole branch, once), one fix wave, one scoped re-review.
- [ ] **Step 4: Root window** (owner OK): back up `state.db`, stop the preview, merge (squash) to main, build, `sudo pap vm setup --home ~/.pap --dev-from-tree` (the bundle changed), start, `pap doctor`, push. Kata: run `CI=1 pnpm exec vitest run --project kata` from the branch with `~/.pap-kata` first only if the review asks for it *(ruling: no Kata test covers knowledge; B2's guest seed runs on the process backend)*.
