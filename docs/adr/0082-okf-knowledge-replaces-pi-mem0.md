# ADR 0082: OKF knowledge replaces pi-mem0

Status: accepted, sub-project 5 · Date: 2026-10-23 · Spec: `docs/specs/2026-10-23-okf-knowledge-design.md` · Supersedes ADR 0052 (memory through pi-mem0's file contract) · Decision 123. Topic note: `docs/agents/knowledge.md`.

## Context

ADR 0052 gave pap a window on pi-mem0, a Pi extension with its own store: a Memory screen at three scopes, a review queue with Inbox items, a trust entry that told pi-mem0 which sessions it may learn from, and a worker release driven by taint. It was a large surface (a daemon module, a permission domain, a push class, an agent-form section) for a store pap neither owned nor could read in a VM: pi-mem0 stays out of the agents' VM images. The owner wanted memory that is plain, readable and the same everywhere, with nothing to run.

## Decision

- **Memory is an OKF bundle**: markdown files with frontmatter in a `knowledge/` folder (Open Knowledge Format v0.2), read and updated by the model with its file tools. pap adds no store, no extra model call and no process.
- **A project owns the knowledge of its sessions.** A project has OKF when `knowledge/index.md` is a regular file whose first 512 bytes hold `okf_version: "0.<n>"` (no link followed). The `index.md` pap writes starts with a `---` frontmatter block holding `okf_version: "0.2"` (OKF SPEC §4, §8, §12). A lane session sees its worktree's folder. ENABLE OKF on the project page creates `index.md` and `log.md`, never overwrites an owner's `index.md` and refuses a link or a file in the way. Methods `projects.knowledge` (`files:read`) and `projects.enableKnowledge` (`files:operate`, idempotent, audited).
- **An agent owns `/agent/knowledge` in its VM**, seeded by the guest at every start when absent. `MEMORY.md` is no longer seeded or mentioned in the agent prompt. A task VM has none.
- **The prompt section is fixed guidance.** The daemon puts `knowledge: {path}` in the init record and pi-host appends the section once at worker start, for plain sessions and agents alike. A running worker picks it up at its next start; the chip says so.
- **pi-mem0 leaves pap.** Deleted: the daemon `memory` module, `memory-trust`, pi-host's `memory-entry`, the `memory.*` methods and permission domain, the `memory_review` Inbox kind (rows deleted by migration), the push class `review`, `AgentInput.memory`, the quarantine `memory` step and the Memory screens. Stored profiles, tokens and push preferences that hold the old keys still parse; the keys are dropped and never written back. Old memories are not converted. pap's sessions never load pi-mem0: pi-host filters it out of the extensions it gives Pi (`isPiMem0`, shared with the VM image exclusion) and reports it once per worker. pi-web, `~/.pi/agent` and pi-mem0 itself are untouched, so pi-web may still load it.

## Consequences

- **Trust is guidance, not enforcement.** pap does not police what the model writes. A concept written in a tainted session should carry `status: draft` and no `verified` field; a model can skip that, and a poisoned concept can then be read as truth by a later session. The mitigation is the OKF trust tier and the owner verifying concepts by editing frontmatter. Reading the folder does not taint and its text is not fenced: it is the project's own files, in git. Cost if wrong: a memory-poisoning path that pi-mem0's review queue partly covered.
- **Less to maintain and to test.** About 6 800 lines go; one note, one prompt section, two methods and a chip replace them.
- **No agent knowledge viewer.** The daemon never reads a VM disk; the owner asks the agent or reads the disk. A viewer can come later.
- **VM bundle change.** The guest seed lives in the agent bundle: `sudo pap vm setup` after the update, or the code-skew check of ADR 0081 stops the VM start and says so.
- **Known edges.** A first session in a folder that is not yet a project gets no section until a project exists. A chip not mounted when OKF was enabled elsewhere than through its own link shows plain `OKF`. A lane session's NO OKF chip hands its session to the project page, which then enables the lane's worktree.
- Hindsight (a server-based memory) was compared and set aside; a trial entry is on the roadmap.
