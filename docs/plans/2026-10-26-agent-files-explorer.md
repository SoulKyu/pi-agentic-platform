# An agent's files in the explorer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (lightened, owner-approved). Steps use checkbox (`- [ ]`) syntax.

**Goal:** the agent's Files tab shows the session explorer (`FilesPane`) over the agent's thread VM disk, with imported credentials hidden, a "VM stopped" panel with START, and the current import list below it.

**Architecture:** the agent VM's guest serves the `fs.*` operations over `/agent`, hiding `.pi` and `lost+found`. The daemon names the agent folder `/agents/<agentId>`, swaps that prefix for the guest's root, and routes `files.*` and the raw routes to an agent `BoxOps`, after the box-project routing has been ruled out. `agents.startBox` starts the thread VM with no worker. The web mounts `FilesPane` in the Files tab, and the stopped panel learns the start from the launches stream.

**Tech stack:** TypeScript (erasable syntax), zod contracts, Hono, React 19, vitest.

**Spec:** `docs/specs/2026-10-26-agent-files-explorer-design.md` (decision 136).

## Execution (owner-approved, 2026-10-26)

**Models:**

| Step | Model |
|---|---|
| T1 · guest ops for an agent VM | Sonnet |
| T2 · daemon: `/agents/<id>` routing, hidden credentials, tokens refused | Sonnet |
| T3 · daemon: `agents.startBox` + the end-to-end int test | Sonnet |
| T4 · web: Files tab (explorer, stopped panel, credentials section) | Sonnet |
| Each task review | Sonnet |
| Final whole-branch review | Opus |

**How it runs:**
- One worktree: `/home/ubuntu/Workspace/soulkyu/pap-agent-files`, branch `feat/agent-files`.
- Tasks run in order T1 → T4, one heavy lane at a time.
- Gates: `vitest related` (unit + int) over the changed files, plus lint, `format:check`, `typecheck` and `knip`. No full suites.
- After the merge: rebuild and restart the preview. `sudo pap vm setup` needs the owner's OK, because the agent bundle changes.

## Global Constraints

- **Rules (AGENTS.md):**
  - 400 lines per file at most;
  - a daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`;
  - pi-host imports `@pap/contracts/pi-host` only;
  - every RPC method declares a permission;
  - handlers decode, call one service method, map errors;
  - erasable TS only, and relative imports keep `.ts`;
  - the only ESLint directive is `eslint-disable-next-line <rule> -- <reason>`;
  - UI tokens only, no `[…]` values;
  - DESIGN.md.
- **Tests:**
  - Use the process backend only (`PAP_TEST_AGENT_RUNTIME=process`, `PAP_TEST_VMD_SOCKET`, the existing beds).
  - Never touch the real pap-vmd, `/opt/pap-vm`, `10.213.0.1`, `~/.pap`, `~/.pi/agent` or `~/.claude`. No public host.
  - Timers go through the kernel `Clock`. No sleeps.
- **Memory (20 GB, no swap, VMs running):**
  - One test command at a time, with `--maxWorkers=2`, under `flock /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/heavy-gate.lock`.
  - Shim first: `export PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/bin:$PATH`.
- **Commits:** Conventional Commits, English, no `Co-Authored-By` and no AI attribution line.
- **Copy:**
  - Stopped panel, EN: "VM stopped" / "The agent's VM is stopped. Start it to see its files." / START.
  - Stopped panel, FR: « VM arrêtée » / « La VM de l'agent est arrêtée. Démarrez-la pour voir ses fichiers. » / DÉMARRER.
  - Credentials heading: "Imported credentials" / « Identifiants importés ».
- **Refusals answer `not_found`, saying nothing about why:**
  - a token caller;
  - another user's agent;
  - an unknown id;
  - `.pi` and `lost+found`;
  - an imported credential path.

## Rulings made while planning

- **R1 · `BoxOps` per kind.** `BoxOps` is built per box kind (`createBoxOps(runtime, clock, kind = "project")`) instead of taking a `BoxRef` per call.
  - Why: same effect, and none of the ~15 project callers change.
  - Cost if wrong: one more instance in the composition.
- **R2 · `/agents` is reserved.** Any pap path at or under `/agents` is never routed to the host, for every caller of `files.*` and the raw routes. Either it is the caller's own agent, or it is `not_found`.
  - Why: a non-match must never fall through to a host path.
  - Cost if wrong: a host folder named `/agents` can no longer be browsed from pap.
- **R3 · Phase from the launches stream.** The web reads the agent VM's phase from the launches stream (`useIsLaunching({kind:"agent",id})`) and from the guest's answer (`box_stopped` on the root listing). There is no new daemon phase field.
  - The explorer reads again when a launch of that agent ends.
  - Why: this has parity with projects (Files also notices a stop only at the next call).
  - Cost if wrong: an idle stop while the tab is open shows at the next action, not at once.
- **R4 · No protocol bump.** `AGENT_VM_PROTOCOL` is not bumped.
  - An older guest answers `failed` to an op (`guest.ts`, which `refuse("failed")` when it has no ops).
  - The bundle digest gate already refuses a launch on a stale bundle (`vm_bundle_stale`).
  - Cost if wrong: on a skewed host, the tab shows "listing failed" instead of the stale state.
- **R5 · Hidden credentials.** Imported credential paths are hidden by the daemon, by exact path relative to `home/`.
  - The agent can copy a credential elsewhere. That copy is a file the agent wrote, and it shows like any other (a known limit, documented).

## Review Focus

1. **Non-agent paths.** `/agents/<id>/../x`, `/agents/<id>X`, `/agents`, `/agents/`, `/agents//<id>` and an unknown or foreign id are never agent paths and never host paths. Every method answers `not_found`. (T2)
2. **Imported credential paths.** Each answers `not_found` for read, raw, write and upload: `home/.kube/config`, and the same with a trailing `/` or a `.` segment. The listing of `home/.kube` omits `config`. (T2)
3. **Tokens.** A token caller gets `not_found` for every `files.*` method on `/agents/...`, and the raw route answers 404. (T2)
4. **Members.** A member gets their own agent's files, while another user's agent answers `not_found`. The client-path gate lets a member's own `/agents/<id>` path through. (T2)
5. **A stopped VM.** Browsing never starts it: `files.list` on a stopped agent answers `box_stopped`, and `runtime.start` is never called. (T2, T3)

---

### Task 1: The guest serves `fs.*` in an agent VM

**Files:**
- Create: `packages/pi-host/src/guest/ops/agent.ts`, `packages/pi-host/src/guest/ops/agent.test.ts`
- Modify: `packages/pi-host/src/guest/main.ts`

**Interfaces:**
- Produces: `createAgentGuestOps(root: string, now: () => number): GuestOps` (exported from `ops/agent.ts`).

**Steps:**
- [ ] **Test** (`agent.test.ts`, temp folder as root, like `fs.test.ts`/`testing.ts`):
  - `fs.list` of root lists `home`, `inbox` and `knowledge`, and never `.pi` or `lost+found`;
  - `fs.read`/`fs.get`/`fs.write`/`fs.put`/`fs.list` on `<root>/.pi/x`, `<root>/.pi` and `<root>/lost+found/y` answer `{ok:false, code:"not_found"}`;
  - `fs.search` results never start with `.pi/` or `lost+found/`;
  - `git.status`, `knowledge.state`, `project.config` and `github.token` answer `{ok:false, code:"not_found"}`;
  - `fs.write` of `<root>/home/notes.md` then `fs.read` gives the text back.
- [ ] Run `pnpm vitest run --project unit packages/pi-host/src/guest/ops/agent.test.ts` and check that it FAILS.
- [ ] **Implement:**
  - a wrapper over `createGuestOps(root, now)`;
  - allowed ops: `fs.list`, `fs.read`, `fs.write`, `fs.put`, `fs.get`, `fs.search`;
  - hidden first segments: `.pi`, `lost+found`, judged with `segmentsOf(root, path)`;
  - the root listing and the search answer are filtered;
  - an exception reads as `not_found`, as `opErrorOf` does.
- [ ] **Wire `main.ts`:**
  - a box layout keeps `createGuestOps(layout.project, …, githubDeps)`;
  - otherwise use `ops: createAgentGuestOps(layout.root, () => Date.now())`.
  - Isolated task VMs get ops too, but the daemon only reaches the thread VM's link.
- [ ] Test passes, plus `vitest related` on the changed files.
- [ ] Commit: `feat(pi-host): an agent VM's guest serves the file operations over its folder`.

### Task 2: Daemon: `/agents/<id>` routing, hidden credentials, tokens refused

**Files:**
- Create: `apps/daemon/src/kernel/agent-path.ts` (+ `.test.ts`), `apps/daemon/src/modules/files/agent-backend.test.ts` (or beside `box-backend.test.ts`; keep each file ≤ 400 lines).
- Modify:
  - `modules/agent-vm/box-ops.ts` (R1);
  - `kernel/boxes.ts` (doc: `id`, not only a project);
  - `modules/files/box-backend.ts` and `service.ts`, `modules/files/index.ts` (deps);
  - `kernel/ws/client-path-gate.ts`;
  - `compose-boxes-wiring.ts` and `compose-workspace.ts` (wiring);
  - docs `docs/agents/files.md` (a row for an agent root, R2) and `docs/agents/agents-vm.md` ("Files": the explorer, the hidden paths, the known limit of R5).

**Interfaces:**
- **Produces, in `kernel/agent-path.ts`:**
  - `AGENTS_ROOT = "/agents"`;
  - `interface AgentFilesSource { guestRootOf(ownerId: string, agentId: string): string | null; importedOf(agentId: string): readonly string[] }`, where `null` means "not this owner's agent", and `importedOf` gives paths relative to the agent's home;
  - `agentOfPath(path: string): { agentId: string; root: string } | null`: lexical, `canonical(path)`, `/agents/<AgentId>` or below, else null;
  - `underAgents(path: string): boolean` (at or under `/agents`, for R2).
- **Produces, in `box-ops.ts`:** `createBoxOps(runtime, clock, kind: BoxRef["kind"] = "project")`.
- **Produces, in `box-backend.ts`:** `BoxTarget` becomes `{ kind: "project" | "agent"; id: string; root: string; guestRoot: string; hidden: ReadonlySet<string> }`.
  - For a project, `guestRoot === root` and `hidden` is empty.
  - `BoxFilesDeps` gains `agentOps: () => BoxOps | undefined` and `agents: () => AgentFilesSource | undefined`.
  - `BoxFiles` gains `matchAgent(caller, path): BoxTarget | null`. It throws `not_found` for a token, a foreign or unknown id, or a path under `/agents` that `agentOfPath` refuses, and returns null when the path is not under `/agents`.
- **Produces, in `client-path-gate.ts`:** `createClientPathGate({ isMember, boxes, agents? })`. It allows a member's path when `agentOfPath` matches an agent whose `guestRootOf(userId, id) !== null`.
- **Consumes:** T1's guest answers.

**Steps:**
- [ ] **Tests** (unit, with fakes from `kernel/testing/fake-boxes.ts` and a fake `AgentFilesSource`):
  - `agentOfPath`: `/agents/helper-1a2b` and `/agents/helper-1a2b/home/x` match. `/agents`, `/agents/`, `/agents/helper-1a2b/../x`, `/agents/helper-1a2bX`, `/agents//helper-1a2b` and `/agents/Bad_Id` do not.
  - `files.list` of `/agents/<id>/home`:
    - the guest gets `<guestRoot>/home`;
    - an imported `home/.kube/config` is dropped from the `home/.kube` listing;
    - a home dot-entry (`home/.bashrc`) is `protection: "confirm"` on write (scope `home: ["/home"]`, roots `["/"]`, relative to the agent root).
  - `files.read` of an imported path → `not_found` and no guest call. The same for `openRaw`, `write` and `upload`.
  - `files.read` answers `meta.path` in pap form (`/agents/<id>/…`), never the guest root.
  - `files.search` drops imported paths.
  - Every method with a token caller on `/agents/<id>/…` → `not_found`, and no guest call.
  - A foreign agent (`guestRootOf` → null) → `not_found`. Under R2, a path under `/agents` never reaches the host functions.
  - The member gate: the member's own agent path is allowed; another's is refused.
  - Box ops `kind: "agent"`:
    - `call` on a stopped agent → `box_stopped` and no `start`;
    - `touch` and `link` receive `{kind:"agent", id}`.
  - Project routing is unchanged: the existing `box-backend.test.ts` and `host-gate.test.ts` pass untouched, apart from the `BoxTarget` field rename.
- [ ] Run the tests and check they FAIL.
- [ ] **Implement:**
  - `service.ts` checks `matchAgent` first in `list`, `read`, `write`, `search`, `upload` and `openBoxRaw`, then the box match, then the host.
  - The prefix swap is `guestRoot + path.slice(root.length)`.
  - The `protectionFor` candidate is relative to `root`.
- [ ] **Wire:**
  - `compose-boxes-wiring.ts` builds `createBoxOps(vm.runtime, clock, "agent")` and passes `agentOps` and `agents` through `WorkspaceBoxes` to `createWorkspaceModules` → `createFilesModule`, and to the gate.
  - The `AgentFilesSource` is built at composition:
    - `guestRootOf`: owner check through the agents module's `ownerOf` (late getter), and the root from agent-vm's `layoutOf(backend, papHome, {agentId, taskKey: null}).root` (export it from `agent-vm/index.ts` if it is not);
    - `importedOf`: `agentFiles.list(agentId).map((f) => f.path)` (the store `composeAgentsVmRpc` builds; `shared.agentFiles`).
- [ ] Run the tests (pass), then the gate.
- [ ] Commit: `feat(files): an agent's folder is browsable at /agents/<id>, through its VM`.

### Task 3: `agents.startBox`, and the end-to-end path

**Files:**
- Create:
  - `apps/daemon/src/modules/agent-vm/agent-start.ts` (+ `.test.ts`);
  - `apps/daemon/src/agent-files-explorer.int.test.ts` (process backend, beside `boxes.int.test.ts`; reuse `testing/box-bed.ts` / `vm-bed.ts`).
- Modify:
  - `packages/contracts/src/agents-vm-methods.ts` (method) and `methods-idempotent.ts`;
  - `project-box-methods.ts` (export the lifecycle error list, or copy it);
  - `compose-agents-vm-rpc.ts` (handler and `bindStart`), `daemon.ts` (bind it beside `bindStatus`), `compose-agents-vm.ts` (build the starter);
  - `apps/daemon/src/testing/m14-classes.ts` (class for the new method);
  - docs `docs/agents/agents-vm.md` ("Files": START, idle stop) and `docs/agents/knowledge.md` line 25 (drop "no viewer in pap"; the Files tab shows `knowledge/`).

**Interfaces:**
- **Contract:** `"agents.startBox"` takes `{ agentId: AgentId }` and returns `{ ok: true }`.
  - Permission `agents:admin`; `idempotent: false`, like `projects.startBox`.
  - Errors: `not_found`, `capacity`, `sandbox_unavailable`, `disk_low`, `command_failed`, `agent_paused`, `vm_bundle_stale`, `stopped`.
- **Starter:** `createAgentStart(deps): (ownerId: string, agentId: string) => Promise<void>`.
  - Deps:
    - `runtime: Pick<AgentRuntime, "start" | "phase">`;
    - `launches: Pick<LaunchRegistry, "open">`;
    - `gate: BoxStack["gate"]`;
    - `imageTagOf(agentId, input, "thread", observe)`;
    - `agentOf(ownerId, agentId): { input: AgentInput; paused: boolean; quarantined: boolean } | null`;
    - `recheck(ownerId, agentId)`, which is `late.agentOpen`.
- **Behaviour** (mirror `box-control.ts` `bringUp`):
  1. Agent null or unreadable → `not_found`. Quarantined or paused → `agent_paused`.
  2. Phase `running` → return, with no launch opened.
  3. Otherwise:
     - `launches.open({ box, owner, for: "start" })`;
     - `stepAround(launch, "checks", () => gate(box, launch))`;
     - `imageStep(launch, …)`;
     - `recheck`;
     - `runtime.start({ box, kind: "thread", taskKey: null, image, resources: input.resources, launch })`;
     - `launch.end(ok, code)` on every way out.
  4. Two calls for the same agent share one start (an in-flight map).

**Steps:**
- [ ] **Unit tests:**
  - running → no launch and no start;
  - stopped → one launch, the steps in order, `start` called with the thread spec;
  - quarantined, paused or unknown → the code, with no launch;
  - a gate refusal → that code and `launch.end(false, code)`;
  - two concurrent calls → one start;
  - the contract test: permission `agents:admin`, and a token is `forbidden` (dispatcher).
- [ ] **Int test** (process backend, scripted provider; the production wiring path):
  - create an agent and import one file (`PUT /agent-files`, `home/.kube/config`);
  - `files.list /agents/<id>` → `box_stopped`, and no VM started;
  - `agents.startBox` → ok;
  - `files.list /agents/<id>` → `home`, `inbox`, `knowledge`, with no `.pi`;
  - `files.write /agents/<id>/home/notes.md`, then `files.read` gives it back;
  - the imported path is absent from the `home/.kube` listing (once a worker has delivered it, or check only the refusal of a read on it), and its read → `not_found`;
  - a token's `files.list` on the path → `not_found`;
  - a second `agents.startBox` → ok, with no second VM.
- [ ] Run the tests: they FAIL, then pass after the implementation. Then the gate.
- [ ] Commit: `feat(agents): START an agent's VM without a prompt (agents.startBox)`.

### Task 4: Web: the agent's Files tab

**Files:**
- Modify:
  - `apps/web/src/features/agents/AgentScreen.tsx` (Files tab: the explorer, then `AgentFiles`);
  - `routes/shell/agent-pane-entry.tsx` (gives `filesPane`);
  - `features/agents/AgentFiles.tsx` (heading);
  - `features/boxes/BoxStopped.tsx`, `BoxStart.tsx` and `use-box-action.ts` (a `BoxRef`);
  - `stores/box-phase.ts` (agent paths);
  - the i18n catalogs (boxes or agent-files, EN and FR);
  - `docs/agents/web.md` (the agent's Files tab).
- Test: beside each component (`AgentScreen.*.test.tsx`, `box-stopped.test.tsx`, `BoxStart.test.tsx`, a `box-phase` test).

**Interfaces:**
- **`AgentScreenProps`** gains `filesPane?(root: string): ReactNode`. `AgentPaneEntry` passes `(root) => <FilesPaneEntry root={root} />` (features never import each other).
- **`stores/box-phase.ts`:**
  - `agentIdOfPath(path): string | null`, matching `/agents/<id>` lexically like the daemon;
  - `useOnBoxRunning(path, cb)` also fires for an agent path, once each time a launch of `{kind:"agent", id}` ends (`useIsLaunching` goes true → false).
- **`BoxStart`** takes `box: BoxRef` (instead of `projectId`). `useBoxAction(method, box)` calls `agents.startBox {agentId}` for an agent and `projects.*Box {projectId}` for a project.
- **`BoxStopped`** at an agent path:
  - shows the agent copy and `<BoxStart box={{kind:"agent", id}} />`;
  - its phase is `starting` while `useIsLaunching` is true, else `stopped`.

**Steps:**
- [ ] **Tests:**
  - The Files tab renders the explorer rooted at `/agents/<id>` (`files.list` called with that path), and `AgentFiles` below it under « Identifiants importés ».
  - A root listing that answers `box_stopped` shows the dashed panel with the agent copy (EN and FR) and START.
  - START calls `agents.startBox {agentId}` with a command id. A refusal shows `boxFailure`'s sentence.
  - While a launch of the agent is in the launch store, START is disabled and shows the stage.
  - When that launch ends, the explorer lists again with no reload.
  - Projects are unchanged: the existing `BoxStart`/`BoxStopped` tests pass, with the props renamed.
  - The phone layout stacks: the explorer, then the credentials section.
- [ ] Run the tests: they FAIL, then pass after the implementation.
- [ ] **Gate:** lint, typecheck, `vitest related`, `pnpm build` (web changed), `pnpm budgets` (the initial bundle must not grow: `FilesPaneEntry` stays lazy with the agent pane).
- [ ] Commit: `feat(web): the agent's Files tab shows its VM's files`.
