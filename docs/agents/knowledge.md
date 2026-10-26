# Knowledge (OKF)

pap keeps memory as plain files. A knowledge bundle is a `knowledge/` folder of markdown files with YAML frontmatter, in the [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) (v0.2). The model reads and updates it with its ordinary file tools; pap runs no memory server, no extra model call and no background process. Spec: `docs/specs/2026-10-23-okf-knowledge-design.md`; ADR 0082; decision 123.

## A project's bundle

- **Where.** `knowledge/` at the root of the project's folder. A lane session sees its own worktree's `knowledge/` (it lives in git, so lanes diverge and merge like code). A session outside every project has no bundle.
- **Detection** (`apps/daemon/src/kernel/fs/knowledge.ts`, `hasKnowledge` / `knowledgeOf`). A project has OKF when `knowledge/index.md` is a regular file and its first 512 bytes hold a line `okf_version: "0.<n>"` (inside the frontmatter block pap writes). Nothing is followed: `knowledge` as a link or a file, or `index.md` as a link, reads as absent. Detection never throws: an unreadable folder reads as absent and the launch logs `knowledge_unreadable {code}` once (no path).
- **ENABLE OKF.** The button on the project page (Home, `features/knowledge/KnowledgeRow.tsx`) calls `projects.enableKnowledge`. It creates `knowledge/index.md` (a `---` frontmatter block holding `okf_version: "0.2"`, per OKF SPEC §4, §8 and §12, then a short header for humans) and `knowledge/log.md` (`## YYYY-MM-DD` in UTC, then `- OKF enabled`). Files are created with `O_EXCL` and `O_NOFOLLOW` through the open directory, so a swap cannot redirect them. It refuses with `conflict`, writing nothing, when `knowledge` exists as anything but a directory or `index.md` is a link or is not an OKF index (no `okf_version`). The page then says what happened, that nothing was written and what to do (EN and FR). An owner's existing `index.md` that already carries `okf_version` is never overwritten. One audit row per enable (`policy / knowledge_enabled`).
- **Methods.** `projects.knowledge {projectId, sessionId?}` returns `{enabled, concepts}` and needs `files:read`. `projects.enableKnowledge` needs `files:operate` and is idempotent. A token holding only `files:read` is `forbidden` on the second. Concepts are the `.md` files other than `index.md` and `log.md`, links not followed, bounded (10 000 concepts, 50 000 entries visited).
- **Session chip.** `OKF` (tone ok) when present, `NO OKF` (tone muted, a button) when absent; the button records the session, then opens the project page. For a lane session (cwd outside the project root) the page reads and enables the lane's worktree and says "In this lane's worktree"; otherwise it works on the project root. After ENABLE OKF the chip of the session that was clicked, and any mounted chip of that project, say "OKF enabled; it applies from this session's next start", because the system prompt of a running worker is fixed.

## The prompt section

- At worker start `compose()` in `sessions/service-launch.ts` puts `knowledge: {path}` in the init record when the session's root has OKF (`InitKnowledge`, `@pap/contracts`). pi-host (`knowledge-prompt.ts`, `open-session.ts`) appends one fixed section to the system prompt, once: read `<path>/index.md` first and follow its links; record durable facts, decisions, conventions and procedures as one markdown file per concept with OKF frontmatter (type, title, description, tags, generated, sources); keep `index.md` listing every concept and add a dated line to `log.md`; never store secrets; a concept written after reading external content gets `status: draft` and no `verified` field; draft and unverified concepts are hints, not truth.
- Plain sessions, lane sessions, children and agent threads all get it. A task VM (isolated task, scratch folder) gets none.
- Nothing is written into the owner's `AGENTS.md`.

## An agent's bundle

- `/agent/knowledge` on the agent's VM disk. It is always on: the guest (`packages/pi-host/src/guest/seed.ts`) creates `index.md` and `log.md` at every VM start when absent, `O_EXCL` + `O_NOFOLLOW`, never overwriting; a deleted `index.md` comes back at the next start. A failure to seed is told once on the guest's stderr and never stops the VM.
- `vmInitOf` replaces any host `knowledge` with `{path: "/agent/knowledge"}` for the thread and its children, and sets none for a task VM.
- Writes under `/agent/knowledge` follow the approval matrix of the agent's home; they never ask for more (`policy/vm-stage.knowledge.test.ts`).
- `agent-prompt.ts` no longer mentions `MEMORY.md`; new homes are not seeded with one. An existing `MEMORY.md` stays a plain file that pap does not read.
- No chip on agent threads. The agent's Files tab shows `knowledge/` of its VM (browsing goes through the guest while the VM runs; START starts it, `agents-vm.md` "Files"); the daemon never reads a VM disk itself.
- Applying this to an existing install needs `sudo pap vm setup` (the agent bundle changed).

## Trust and its limit

- The section is guidance, not enforcement. pap does not parse or police what the model writes. The protection against a poisoned concept is the OKF trust tier: a concept verified by a `human:` actor is reviewed, `status: draft` marks what a tainted session wrote. The owner verifies a concept by editing its frontmatter like any file.
- Reading `knowledge/` does not taint and its contents are not fenced as external content: the folder is the project's, in git, reviewed like code. The residual risk is an earlier tainted session writing a poisoned concept without marking it. `draft` is what signals it, and a model can skip it.

## What was removed (sub-project 5, decision 123)

- Daemon `modules/memory/`, the `memory.*` methods and the `memory` permission domain, the `memory_review` Inbox kind (a migration deletes its rows), the push class `review`, `AgentInput.memory`, the quarantine `memory` step, Settings › Memory, the agent form's memory fields, the taint-driven worker release that only fed pi-mem0, and pi-host's `memory-entry.ts`.
- Still parsed, ignored and never written back: an agent profile with a `memory` policy, a stored token with `memory:*` permissions, stored push preferences with `review`.
- pap's sessions never load pi-mem0: `packages/pi-host/src/without-mem0.ts` filters it (package or path matching `/pi-mem0/i`, `isPiMem0` in `@pap/contracts`, also used for VM images) out of the extensions pap gives Pi, and reports it once per worker by name only. pi-web, `~/.pi/agent` and the pi-mem0 folder are untouched, so pi-web may still load it and its store. Old memories are not converted. `image-inputs.ts` still keeps the pi-mem0 package out of VM images.
