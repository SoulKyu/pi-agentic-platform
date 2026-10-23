# Sub-project 5: OKF knowledge replaces pi-mem0

Date 2026-10-23. Status: design, brainstormed with the owner on 2026-10-23. Closes the "agents in microVMs" programme (roadmap; sub-project 4, disk backups, moved to a later entry). Builds on sub-project 3 (`docs/specs/2026-10-22-agents-vm-only-design.md`, ADR 0081). ADR to write with the plan: 0082, pap's memory is OKF knowledge (supersedes ADR 0052, pi-mem0's integration). The owner wants it **simple and KISS**, with the UI following `DESIGN.md`.

Calls the controller made without the owner are marked *(controller's call)*.

## 1. Goal

pap stops integrating pi-mem0 and gives memory a plain, readable form: an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle (spec v0.2), markdown files with YAML frontmatter that the agent itself reads and keeps up to date with its file tools. Knowledge belongs to a **project** (for sessions) or to an **agent** (in its VM). No memory server, no extra LLM call, no database.

## 2. Decisions

From the owner:

- **pi-mem0 leaves pap entirely**: every Memory screen (user, project and agent scopes), the review queue, the `memory_review` Inbox items, the worker's memory-trust entry, the daemon's `memory` module and its contracts and methods. pap no longer reads or writes pi-mem0's folder.
- **Old memories are not converted.** They are lost; that is fine.
- **OKF is per project, not per session.** A session detects whether its project has OKF. Present: a green chip `OKF`. Absent: a chip that links to the project's page, where **ENABLE OKF** sets OKF up in the project; the session's chip is then green.
- **DESIGN.md wins on colour**: the chip for a project without OKF is neutral, not red (red means something broke).
- Hindsight was compared and set aside; a trial "maybe" entry is on the roadmap.

Non-goals: converting mem0 memories; a memory server or vector search; a knowledge editor in pap (files are edited in the project like any file); sharing knowledge between projects or between agents; a user-wide (cross-project) knowledge store; enforcing in code what the agent writes (§5).

Anti-goals: an extra LLM call or a background process per session; an approval card for knowledge writes.

## 3. A project's knowledge

- **Where** *(controller's call)*: `knowledge/` at the root of the project's folder, an OKF bundle. **Detection**: `knowledge/index.md` exists, is a regular file (no link followed) and its first lines carry `okf_version: "0.2"` (any `0.x` is accepted). A lane's worktree is a folder of the project: its own `knowledge/` is the one its sessions see (it lives in git, so lanes diverge and merge like code).
- **ENABLE OKF** (on the project's page *(controller's call: pap has a project home, `features/home/ProjectHome.tsx`, not a separate settings screen)*): creates `knowledge/index.md` (with `okf_version: "0.2"` and a short header explaining the folder to humans) and `knowledge/log.md` (one dated line: "OKF enabled"), without following links, refusing if `knowledge/` exists as anything but a directory, never overwriting a file. It commits nothing: the files appear as changes in the project like any other. Permission: the same as editing project files.
- **The session**: when its project has OKF, pap appends a short, fixed section to the session's system prompt *(controller's call: pap already appends the agent role through `appendSystemPromptOverride` in pi-host; nothing is written into the owner's `AGENTS.md`)*. It tells the model: knowledge lives in `knowledge/`; read `knowledge/index.md` first and follow its links when relevant; record durable facts, decisions, conventions and procedures as one markdown file per concept with OKF frontmatter (`type`, `title`, `description`, `tags`, `generated: {by, at}`, `sources`), keep `index.md` listing them and add a dated line to `log.md`; never store secrets; a concept written after reading external content gets `status: draft` and no `verified`; treat `draft` and unverified concepts as hints, not truth.
- **Which folder** *(controller's call)*: a lane session's root is its worktree; any other project session's root is the project's folder. A session outside any project has no chip and no section.
- **How the worker learns it** *(controller's call)*: the daemon detects at worker start and puts `knowledge: {path} | null` in the init record (a contracts change); pi-host appends the section when it is set, for plain sessions too (today `appendSystemPromptOverride` appends only the agent role).
- **Detection timing**: at worker start, and when the session's chip is read; ENABLE OKF invalidates the chip of that project's open sessions on the client *(controller's call: a client refetch after the mutation, no new push event)*. The chip shows the project's state; a session already running picks up the prompt section at its next worker start (the system prompt is fixed for a running worker), which the chip's accessible label says ("OKF enabled; it applies from this session's next start") until that start *(controller's call: no third chip state)*.
- **Methods** *(controller's call)*: one read (`projects.knowledge {projectId, laneId?}` → `{enabled, concepts}`, permission like reading project files) and one mutation (`projects.enableKnowledge {projectId, laneId?}`, permission like writing project files, audited). Names are the builder's within the existing `projects.*` conventions.

## 4. An agent's knowledge

- Each agent's bundle is `/agent/knowledge/` on its VM disk (the folder already exists in the VM layout of sub-project 1, and it is already a writable root of the VM file tools and a bind of the VM shell, `policy/vm-paths.ts`, `vm-shell/argv.ts`). It is always on: pap creates `index.md` and `log.md` there at the VM's first start if absent, through the existing guest file channel. The agent gets the same prompt section with this path. The builder checks that the agent's writes there never ask for approval (they are its own folder, like its home); if the policy asks today, the fix is part of this sub-project.
- **`MEMORY.md` goes** *(controller's call: the owner asked to replace all memory by OKF)*: `agent-prompt.ts` stops telling agents to keep notes in `MEMORY.md` and points to `/agent/knowledge` instead; its tests and the `security/agent-home` int test follow. An existing `MEMORY.md` in a home stays a plain file.
- No chip on agent threads, and no knowledge viewer for agents in pap *(controller's call, KISS: the daemon never reads a VM disk; the owner asks the agent, and a viewer can come later)*.
- A task VM (blank disk) has no knowledge of its own; it gets no prompt section *(controller's call)*.

## 5. Trust

- The prompt section is guidance, not enforcement: pap does not parse or police what the agent writes in `knowledge/`. The protection against memory poisoning is the OKF trust tier (`verified` by a `human:` actor = reviewed) and `status: draft` for concepts written in a tainted session, which the next sessions treat as hints. The owner verifies a concept by editing its frontmatter (`verified: {by: "human:<name>", at: …}`), like any file.
- Reading `knowledge/` is reading the project's (or agent's own) files: it does not taint. Its contents are not fenced as external content *(controller's call: the folder is the project's, in git, reviewed like code; the residual risk, an earlier tainted session writing a poisoned concept, is what `draft` signals)*.

## 6. Removing pi-mem0

- Delete: the daemon `modules/memory/` (files, views, the review queue and its Inbox items), `modules/sessions/memory-trust.ts` and what it tells workers, pi-host's `memory-entry.ts`, contracts `memory.ts` and `memory-methods.ts` (and their permissions), web `features/memory/` and `features/agents/RecentMemory.tsx`, the memory settings route, the push/Inbox source for `memory_review`, the agent profile's pi-mem0 policy (`AgentInput.memory`, `AgentMemoryPolicy`, `AGENT_LIMITS.memoryHintChars`; stored profiles keep parsing with the field ignored, no data migration), and their tests. The Inbox kind `memory_review` leaves the contracts, push and web; a migration deletes its rows *(controller's call: the web ships with the daemon, so no old client parses them)*.
- pi-mem0 itself (the Pi extension, its folder under `~/.pi/agent`) is untouched: pap never edits it, and pi-web may keep using it.
- Docs: `docs/agents/memory.md` is replaced by a short `docs/agents/knowledge.md`; `AGENTS.md`, `agents.md`, `agents-vm.md` ("No pi-mem0") and the topic-notes list follow.

## 7. UI and copy

DESIGN.md applies: tokens only, listed primitives, mono uppercase labels, English and French, the error pattern.
- **Session chip**: a status `Chip` in the session screen's header (`SessionScreen.tsx`, beside `LimitChip`) *(controller's call)*. OKF present: tone `ok`, word `OKF`. Absent: tone `mut`, word `NO OKF`, as a link to the project's page (keyboard reachable, accessible label "Enable OKF for this project"). Colour is never the only carrier: the word changes too.
- **Project page**: a "Knowledge" row in the project facts. Present: "OKF knowledge in `knowledge/`" and the number of concept files *(controller's call)*. Absent: one sentence of purpose ("Agents in this project keep their knowledge as markdown files in `knowledge/`.") and the primary button **ENABLE OKF**. A failure says what happened, what is intact and what to do.

## 8. Tests

- Detection: present, absent, `index.md` a link (absent), a directory named `index.md` (absent), a `knowledge` file instead of a folder (absent), another `okf_version` 0.x (present), a lane worktree with and without its own `knowledge/`.
- ENABLE OKF: creates both files with the exact content; refuses a `knowledge` link or file; never overwrites; the chips of the project's open sessions turn green.
- Prompt section: present for a project with OKF, absent without; the agent's section names `/agent/knowledge`; a task VM gets none.
- pi-mem0 removal: no route, method, Inbox kind or worker entry left (knip and a contracts test); stored agent profiles with the old memory fields still parse.
- Agent bundle: created at the VM's first start when absent (process backend), left alone when present.

## 9. Left to the builder

The prompt section's exact wording (within §3's content), the concept-count read, the migration's form, where the detection helper lives, and the header copy of `index.md`.

Docs to update: §6's list, ADR 0082, the decisions log and the roadmap ("sub-project 5 done; the programme is closed").
