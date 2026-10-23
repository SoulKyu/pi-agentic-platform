# Boxes, lot B1: projects and their sessions in a box

Date 2026-10-23. Status: lot design. Programme: `docs/specs/2026-10-23-boxes-design.md` (decision 124); B0 results: `docs/research/boxes-b0-spike.md`. ADR to write with this lot: 0083, "the host is an orchestrator: every component that runs code runs in a box". Calls the controller made without the owner are marked *(controller's call)*.

## 1. Scope

In B1:

- box identity: agent boxes and project boxes;
- empty projects created from a name, and the Scratch project;
- running in the box: the sessions of a box project, their children and the project's trigger tasks;
- through the guest: Files (explorer, viewer, editor save, uploads, downloads, `@` mentions), Changes (`vcs` status and diffs) and OKF knowledge;
- the project image, built from `.pi/project.yaml`'s packages;
- the project's host list and network requests;
- search over session mirrors, for agents too;
- prechecks removed;
- deleting a project, and the project's settings.

Later:

- the terminal and GitHub (B2);
- lanes (B3: the Lane and Fan-out modes are off for a box project);
- the host clean-up (B4: host projects, the session scanner and pi-web coexistence stay as they are until then);
- backups.

`export_html` is refused for a box session, as it is for agents (`sandbox_unavailable`).

Facts from the code recon, which the plan must handle:

- The VM stack is keyed by `AgentId` everywhere: pap-vmd's requests, its `nerdctl ps` parsing (which skips names that are not agent-shaped), the hello, tokens, relay, proxy, mirrors and crash log.
- `GuestCommand` has only `spawn`, `signal` and `shutdown`: no call reads a file in a VM.
- `vmInitOf` refuses a session that is not an agent's (`internal`).
- `compose-agents-vm.ts`, `triggers.ts` and `methods.ts` sit at or near the 400-line cap.

## 2. Box identity

- **`BoxRef`.** The contracts gain `BoxRef = {kind: "agent", id: AgentId} | {kind: "project", id: ProjectId}` (a project id is a UUID). It replaces `agentId` in:
  - pap-vmd's requests and `vm.list`;
  - the guest and worker hellos;
  - launch tokens and launch scopes;
  - the relay's grant, policy and usage;
  - the proxy's scope and refusals;
  - the crash log, the bundle-skew check, the idle stop and the runtime's entries.

  Agent RPCs, agent UI and agent behaviour do not change.
- **pap-vmd** keeps agent disks and names as they are (`agents/<id>/disk.img`, `pap-<agentId>`). Project boxes get `projects/<id>/disk.img` and names that never collide with an agent's. pap-vmd parses both forms, so its boot `stopAll`, net restore, task sweep and trash see project VMs too.
- **The guest protocol version goes up.** The pap-vmd and bundle changes need `sudo pap vm setup`.
- **One memory cap.** `PAP_AGENTS_MEMORY_MAX_MB` keeps its name and covers every box, agents' and projects' *(controller's call: no rename churn; the docs say so)*.

## 3. A project box

- **Layout.**
  - The box disk is mounted at `/boxes/<projectId>` and holds:
    - `project/`, the repository and the sessions' working directory;
    - `home/`, the `HOME` of the box's processes (dotfiles, git configuration);
    - `inbox/`, for attachments;
    - `.pi/sessions` and `.pi/agent`, Pi's folders.
  - **The guest path is pap's path** *(controller's call)*: a box project's `root` in pap is `/boxes/<projectId>/project`. A path in a transcript, in Files, in Changes or in a trigger is the same string in the VM and in pap.
  - The daemon routes any path under a box project's root to that box, and never to the host file system, whether or not the path exists on the host.
  - The process backend (tests only) uses the same names under `$PAP_HOME/tmp/boxes/<projectId>`. That host path is the project's stored root for that backend.
- **Creation.** `projects.create {name}` inserts a project of kind `box`:
  - its root comes from the layout;
  - default resources: 2048 MB of memory, 2 CPUs, 8192 MB of disk;
  - no VM starts at creation.

  At the first start the guest seeds the layout and runs `git init -b main` in `project/` when there is no `.git` there.
- **Image.**
  - The project layer is the agent layer's mechanism on top of the shared base and Pi profile, with the Debian packages of `.pi/project.yaml`.
  - `packages` is a new field of the lanes parser: at most 64 names, each following the `SystemPackage` rule.
  - At each start the guest reads `.pi/project.yaml` and reports the list.
  - When the list differs from the one the image was built from, the project page shows both lists and a **Rebuild** button (`projects.rebuild`, owner only). A rebuild never starts by itself.
  - The rebuild happens behind running sessions. The new image applies at the box's next start, or at once with Restart box, and a notice says so *(controller's call: the agents' rule)*.
- **Resources.** Edited in the project's settings, with the same host checks as agents. The disk only grows.
- **Lifecycle.**
  - **Starting:** a box starts on a session launch, on a trigger task, or when the owner clicks **Start**. Files, Changes and the knowledge row show that button while the box is stopped *(controller's call: browsing never starts a VM by itself)*.
    - While a box starts, those panels say so.
    - A refused start shows its code with the error pattern: `capacity`, `vm_bundle_stale`, `agent_paused` or `sandbox_unavailable`.
    - No box is stopped to make room for another.
  - **Stopping:** after `PAP_WORKER_IDLE_MINUTES` with no worker running and no guest operation.
  - The `vcs` poll and Files subscriptions ask a running box only; they never start a box or keep one alive *(controller's call)*.
  - Opening a session's history never starts a box.
  - **Restart box** in the settings stops the box and starts it again as a new launch. That clears the launch taint and applies a rebuilt image.
  - After 3 crashes in 10 minutes, the box's launches pause and the Inbox says so, as for agents.
  - **Upgrade window.** Between a daemon upgrade and `sudo pap vm setup`, launches are refused (`vm_bundle_stale`, failing `vm.vmd`), as for agents today. The preview's merge procedure runs the setup at once.
- **Delete.** `projects.delete {projectId}`, a box project only, with the same confirmation as deleting an agent:
  - it stops the box;
  - it moves the disk to pap-vmd's trash and the mirrors to the host trash, for 7 days, with "Purge now";
  - it removes the project's sessions, their search rows and the project's triggers from pap; the confirmation counts them *(controller's call)*;
  - it stops the box's running workers and tasks first; a running task ends cancelled, with a journal entry.

  The trash allows recovery by hand only, as for agents. The Scratch project cannot be deleted while it holds sessions.
- **Scratch.** A box project named "Scratch", created for a user when they first pick it. One per user. It can be renamed.

## 4. Sessions in the box

- **Creating.** `sessions.create {cwd}` with a cwd at or under a box project's root makes a box session. It is resolved without touching the host file system. The row keeps that cwd and the project id, and has no agent id.
- **Launching.** A launch gate (the project exists, is the owner's, is of kind `box` and is not being deleted), then the VM launch path agents use: runtime spawn, mirror, relay key, worker slot.
- **Mirror.** Session files are mirrored under `$PAP_HOME/boxes/.mirrors/<projectId>/` (the agents' shape, so search watches it the same way) *(controller's call)*, with the mirror's checks and a quota of the project's disk size.
- **Policy: a new profile `project`** *(controller's call)*:
  - pap's VM shell and VM file tools;
  - writable roots: `project/`, `home/` and `inbox/`;
  - own folder: `project/`;
  - `sandbox {required: true, network: true}` (the proxy decides what is reached);
  - no "always" grants carried in;
  - the session's approval mode applies as it does to an agent's VM session. The shell is judged as an edit of the own folder: it is not asked in auto-accept-edits, asked in supervised, and blocked in read-only.

  pi-host refuses a profile it does not know, so the profile and the bundle ship together.
- **Prompt.** No agent prompt. The OKF section is added when the project has knowledge: the worker checks `project/knowledge/index.md` itself at start, and the host never reads it *(controller's call)*. Pi's context files (`AGENTS.md`) load as they do for plain sessions today.
- **Models and money.** The relay serves a box session the owner's models, the picker's list, as for a host session today. pi-claude-bridge works when the Claude token is set. The owner's budgets block the relay as they block runs. Cost goes to the session and its runs, as today *(controller's call)*.
- **Project Pi resources.** A repository's own Pi resources (`.pi/` extensions, skills, MCP configuration, settings) do not load in a box session in B1. The worker's Pi folder is the image's, which holds no project trust, so loading fails closed. This is a documented limit *(controller's call: extensions in the worker hold the relay key; trust inside a box is a later decision)*. Context files (`AGENTS.md`) load.
- **Taint** is per launch (SP3's rule, and programme §4: one box, one trust zone). When one session of a launch is tainted, every session of that launch is tainted, including trigger tasks and the sessions that start later in it. Only a new launch starts clean (an idle stop, then a start, or Restart box).
- **Children** run in their parent's box. **Attachments** go to `inbox/`, through the agents' mechanism.

## 5. Trigger tasks

- **Where they run.** A trigger whose `execution.cwd` is at or under a box project's root runs its task session in that box, unattended as today (tool allowlist, mode clamp). Its project is found from that root, without the host's `realpath`.
- **Prechecks are removed.**
  - The form loses the precheck and environment-name fields.
  - A stored trigger still parses. One that holds a precheck is refused at fire and at dry-run with the journal word `precheck_removed`, which generalizes `precheck_agent`.
  - Saving a trigger with a precheck, or a template with `{{precheck}}`, is refused.
  - The precheck runner (`precheck.ts`, its port, its queue, the run parts of its step) is deleted.

## 6. Guest operations

- **The channel.** The guest link gains a request and its answer: `op {id, name, args}` from the daemon, and `op_result {id, ok, value | code}` from the guest.
  - At most 8 in flight per box, with a 30 s timeout.
  - Frames stay within 4 MiB.
  - Results respect the existing limits (`FILE_LIMITS`, `VCS_LIMITS`).
- **The operations:**
  - `fs.list`;
  - `fs.read`, in chunks;
  - `fs.write`: atomic, with an etag check;
  - `fs.put`: upload chunks, with `conflict` skip or replace;
  - `fs.get`: download chunks;
  - `fs.search`: for `@` mentions, with git's file list and ripgrep;
  - `git.status`: porcelain v2, numstat and line counts;
  - `git.blob`: one side of a diff;
  - `knowledge.state` and `knowledge.enable`;
  - `project.config`: the packages of `.pi/project.yaml`.
- **Path rules.**
  - Every path is judged in the guest, under the project root, without following links (the VM file tools' rule).
  - The Files root is `project/`. `home/`, `inbox/` and `.pi/` are not shown.
  - The protected-path rules of the host Files module apply the same way.
- **git in the guest** runs with the daemon's neutralised command line: no fsmonitor, hooks, filters or external diff. It moves to a package both sides import *(controller's call)*.
- **Daemon side.** The files, `vcs` and projects (knowledge) modules get a box backend, chosen by the project's kind. Host projects keep the host backend until B4. RPC names, permissions, limits and error codes stay the same.

## 7. Network

- **The host list.** Each project has its own host list: `host[:port]` and IP entries, at most 256, each following the agents' entry rule. It starts empty and is edited in the project's settings. The box reaches the owner's list (Settings, policy hosts) plus the project's list *(controller's call: a union, so adding a host never copies or replaces the owner's list)*.
- **The proxy** finds the box by the source address and reads that project's list on every connection.
- **`network.request`.**
  - Its callers gain sessions in a project box. A host session cannot call it.
  - "Allow this host" adds the host to the project's list. The addition is stored and audited, and the owner sees it in the settings and can remove it.
  - A tainted session's card says the session read outside content.
  - An unattended task's request becomes the existing unattended question (Inbox; no answer by the timeout means deny).
  - The limit of 10 requests per hour per session stays.

## 8. Search

The scanner also watches the mirror folders, the agents' and the projects'. There it indexes only the files of sessions pap already has, and never adopts a file. A mirror append is never an outside write. The agents' limit "search does not index mirrors" goes.

## 9. UI

DESIGN.md applies (tokens, listed primitives, English and French, the error pattern).

- **Add project:** one name field. The folder field goes; the dialog creates a box project. Existing host projects stay listed and usable.
- **Scratch:** the home's project picker offers Scratch.
- **Project page:**
  - the knowledge row, Files and Changes work through the guest;
  - Terminal, Lane and Fan-out are off for a box project, each with a one-line reason;
  - a box fact: stopped, starting or running, plus memory, CPUs and disk.
- **Project settings** (new, reached from the project page):
  - resources;
  - the host list;
  - the packages notice with Rebuild;
  - Restart box;
  - Delete project.

## 10. Tests

- **Backends.**
  - The process backend runs project boxes: the real guest and worker, with the scripted provider.
  - The fake pap-vmd covers box requests.
  - The kata suite gains one project-box journey (local only).
  - Tests never reach the real pap-vmd.
- **Journeys:**
  - create a project, then a session in it edits a file; Files shows the file, Changes shows the diff, and search finds the message;
  - a trigger task runs in the box;
  - a precheck is refused;
  - a network request adds a host to the list;
  - deleting a project moves it to the trash;
  - Scratch.
- **The host never reads a box project** *(controller's call)*: a test drives Files, Changes and knowledge on a process-backend project and fails if the daemon's file system and git helpers ever receive a path under that project's root.

## 11. Docs

- ADR 0083.
- The VM note covers boxes.
- The topic notes for projects, files, sessions, search and automation.
- The `AGENTS.md` lines.
- The decisions log and the roadmap.
- Programme spec §4 says `/boxes/<projectId>/project` and the cap's name.

## 12. Left to the plan

Frame and op names, the projects table migration, pap-vmd's naming of project entries, the process-backend details, the settings screen's layout, and how the work splits into lanes.
