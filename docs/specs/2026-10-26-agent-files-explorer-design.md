# An agent's files in the explorer

Owner request (2026-10-26): « Ça serait cool d'avoir comme pour les sessions, la même vue sur les fichiers des agents ? »

Answers: the form `docs/design/questions/2026-10-26-agent-files.html` (decision 136): every recommendation, no notes.

## 1. Why

An agent works in its own microVM, on its own disk. Today you see none of it:
- **A box project's sessions have the explorer.** It has a tree, open files in tabs, editing and upload. The box's guest serves it (`fs.*` guest operations). When the box is stopped, a "Box stopped" panel with START replaces it.
- **An agent's Files tab is something else.** It lists the credentials you imported (`.kube/config`, tokens), never their content. pap writes them into the VM's home at each start (`docs/agents/agents-vm.md`, "Files").
- **The work stays out of sight.** A digest a cron agent writes, its notes, the attachments it received and its OKF knowledge are visible only by asking the agent. `knowledge.md` says "no viewer in pap: the daemon never reads a VM disk".
- **The guest has no operations for an agent.** An agent VM's guest starts no guest operations: `createGuestOps` runs only when `layout.project` is set (`packages/pi-host/src/guest/main.ts`).

## 2. Goals

- The agent's Files tab shows the same explorer as a box project's session (`FilesPane`: tree, viewer tabs, editor, upload), over the agent's VM disk.
- The tree shows the whole agent folder (`/agent`): `home/`, `inbox/` and `knowledge/`. `.pi/` is never shown (Q1 B).
- You can open, edit, save and upload, under the same rules as a box project (Q2 A).
- Imported credentials never appear in the tree and their content is never shown. The current import list stays as its own section under the explorer (Q3 A).
- A stopped VM shows a "VM stopped" panel with START, and browsing never starts the VM (Q4 A).

**Non-goals:**
- files of isolated tasks: their scratch folder goes with the task, and their result goes to the Inbox;
- a Changes or git view for agents;
- opening a path cited in the thread straight in the explorer;
- reading a stopped VM's disk from the host (a root mount that bypasses the VM, refused).

**Anti-goals** (failures even if it works):
- a secret on screen;
- a VM started just because you opened a tab;
- a host path reachable through an agent root;
- one user reaching another user's agent.

## 3. What the person sees

The agent screen's tabs stay **Thread · Files · Settings**. The Files tab holds, top to bottom:

1. **The explorer**: the same `FilesPane` a box session uses, rooted at the agent's folder.
   - The tree's top level is `home`, `inbox` and `knowledge`.
   - The viewer tabs, editor, save, upload and the unsaved-edits guard behave as in a project.
2. **Imported credentials**: today's `AgentFiles` table and import form, unchanged in behaviour.
   - Columns: path, size, import date. Actions: Import, Replace, Remove.
   - Its heading becomes "Imported credentials" / « Identifiants importés » (my call; today's title is "Files in the agent's home").

When the VM is not running, the explorer is replaced by the stopped panel. The credentials section stays usable, because it works on the host copy.
- It is an EmptyState with a dashed frame, one sentence and one primary action (DESIGN.md §9.1).
- Copy (my call, mirrors `boxes.stopped.*`):
  - EN: title "VM stopped", purpose "The agent's VM is stopped. Start it to see its files.", action START.
  - FR: « VM arrêtée », « La VM de l'agent est arrêtée. Démarrez-la pour voir ses fichiers. », DÉMARRER.
- While the VM starts, START shows the launch's real step, as the project START does (ADR 0087).
- When the VM turns running, the explorer appears and reads again without a reload.
- A refused start shows its code's sentence: `capacity`, `vm_bundle_stale`, `agent_paused`, `sandbox_unavailable`, `disk_low`.

On a phone, the explorer stacks as `FilesPane` already does. The credentials section follows it.

## 4. Rules

### 4.1 What is reachable

- **Scope.** The agent folder of the agent's **thread VM** disk: the same disk its thread, children and thread tasks use.
- **Top-level folders.** `home`, `inbox` and `knowledge` are listed.
- **Never listed or reachable** (`not_found`): `.pi` (transcripts, Pi's config) and `lost+found`. The guest checks this, so a direct path to them is refused too.
- **The home's dot-entries.** `home/.claude`, `home/.kube`, `home/.ssh` and the like follow the existing home-folder rule of `files.md`. They are protected entries: confirm on save, `not_found` for a token.
- **Imported credential paths.** These are the paths in `$PAP_HOME/secrets/agent-files/<agentId>/`, relative to `home/`.
  - The daemon drops them from every listing.
  - It refuses read, raw download, write and upload of them with `not_found`, saying nothing about why.
  - A folder that holds only imported files may still show, empty.
- **No links followed.** Containment and links are judged in the guest, as for a project (`nofollow.ts`).
- **Who.** Only the agent's own user, under the agents tab's permission (`agents.files.*`).
  - Another user's agent answers `not_found`.
  - A member reaches their own agents only. The host gate of M14 still refuses every host path.
- **Tokens.** An agent path is browser-only, like `agents.files.*` (my call). A token gets `not_found` for any path under `/agents/`.

### 4.2 Addressing

- **pap path.** pap names the agent folder with a root that is unique per agent and never a host path: `/agents/<agentId>` (my call).
- **Prefix swap.** The guest still sees its own `/agent`. The daemon swaps the prefix both ways, in request paths and in any path a result carries.
  - The match is lexical, like `boxOfPath`. `/agents/<id>/../x`, `/agents/<id>X` and an unknown id are not agent paths.
  - A path that is not lexically clean is never routed to the host.
- **Routing.** `files.*` and the raw routes route an agent path to the agent's guest, beside the box project routing (`modules/files/box-backend.ts`). `BoxOps` serves agents too: today it hard-codes `kind: "project"` (the plan builds one instance per kind, ruling R1).

### 4.3 Starting and stopping

- **Browsing never starts the VM.**
  - A VM that is not running answers `box_stopped` at once.
  - Files subscriptions use `BoxOps.poll`, which never resets the idle wait.
  - A list, read or save uses `BoxOps.call`, which does reset it.
- **START.** A new method starts the agent's thread VM with no worker and no prompt, like `projects.startBox` does for a box (`AgentRuntime.start`).
  - It uses the same spec as a thread launch: image, network, hosts, memory.
  - It has the same refusals as a thread launch, and runs the launch registry's steps.
  - It is idempotent on a running VM.
  - Name and permission (my call): `agents.startBox {agentId}`, `agents:admin`, like `agents.files.*`.
  - It starts no worker, so imported files are written later, when the first worker starts, as today.
- **Idle stop.** As a box: `PAP_WORKER_IDLE_MINUTES` with no worker and no guest operation.
- **Phase on screen.** The web learns the thread VM's phase (`stopped | starting | running`) and its changes. It needs this to switch panels and to read again on `running`, as `useOnBoxRunning` does for a project.
  - Today no agent view carries the phase; `ProjectSummary.box.phase` is the project equivalent.
  - The transport is the builder's choice.

### 4.4 The guest

- **Operations.** The agent VM's guest serves the `fs.*` operations over its layout root:
  - `fs.list`, `fs.read`, `fs.write`, `fs.put`, `fs.get`;
  - `fs.search`, if the explorer uses it.
- **Hidden names.** `.pi` and `lost+found` are hidden, as `.git` is never written in a project.
- **Not for agents.** `git.*`, `github.*`, `knowledge.*` and `project.config` are refused (`not_found` or the existing unknown-op answer).
- **Limits and judgement.** Path judging, limits (`BOX_OP_LIMITS`, `FILE_LIMITS`) and error mapping are the project's.
- **Version skew.** This changes the agent bundle.
  - An older guest must not break the tab: it shows the existing "VM's code is older than pap" state (`vm_bundle_stale`) or the stopped panel, never a raw error.
  - Bump `AGENT_VM_PROTOCOL` if the daemon needs it to tell the two apart.

## 5. Constraints

- **Rules.** AGENTS.md rules hold: 400 lines per file, module imports, a permission for every RPC method, erasable TypeScript, the only ESLint directive form, UI tokens only, DESIGN.md.
- **Tests.**
  - The process backend only (`PAP_TEST_AGENT_RUNTIME=process`, `PAP_TEST_VMD_SOCKET`, `testing/box-bed.ts` / `vm-bed.ts`).
  - Never the real pap-vmd, `/opt/pap-vm`, `10.213.0.1`, `~/.pap`, `~/.pi/agent` or `~/.claude`.
  - A Kata test is optional and local only.
- **Host.** This host has 20 GB and no swap. Run one heavy test lane at a time, with `--maxWorkers=2`, under `.superpowers/heavy-gate.lock`.
- **Docs.**
  - `docs/agents/agents-vm.md`: the Files section and the guest operations.
  - `files.md`: a row for an agent root.
  - `knowledge.md`: drop "no viewer in pap".
  - `web.md`: the agent's Files tab.
  - `AGENTS.md`: one line, if a rule changes.
- **After the update:** `sudo pap vm setup` (the agent bundle changes). Root, so the owner's OK is needed.

## 6. Left to the builder

- Where the prefix swap lives: a box-target field in `box-backend.ts`, or a small agent adapter beside it.
- How the web gets the agent VM phase: a field on the agent's view, a read on open plus the launches stream, or another way that updates without reload.
- How the agent tab mounts `FilesPane`: its shell entry with the step-up, as `files-pane-entry.tsx` does, given that features never import each other.
- How `fs.search` behaves in a folder with no git, or whether the explorer needs it at all.
- Task split and order.
